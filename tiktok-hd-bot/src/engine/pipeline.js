// The whole method in one call: analyse -> encode (x264) -> remux iPhone-style -> verify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from './analyze.js';
import { detectCaps, runFfmpeg, ffprobe } from './ffmpeg.js';
import { inspectMp4a } from './aac.js';
import { muxOutput } from './mux.js';

export const DEFAULTS = {
  mode: 'max', // max = 2160p (4K) | hd = 1080p | keep = source resolution (max 2160p)
  fps: 30, // upper limit; never duplicates frames (60 allowed)
  preset: 'medium', // x264 preset: veryfast/faster/fast/medium/slow
  crf: 17, // quality target, capped by maxrate
  maxrate: 0, // 0 = auto by resolution (4K ≈ 11 Mbps, same ceiling as the reference file)
  pad: true, // append 17 silent AAC frames in a tail mdat (reference-file quirk)
  dupAudio: true, // duplicate AAC track sharing the same data (reference-file quirk)
  keepAppleTracks: true, // pass through iPhone APAC + mebx camera metadata tracks
  encoderTag: 'TikTok HD Bot',
  workDir: path.join(os.tmpdir(), 'tiktok-hd'),
};

const FPS_CHOICES = [60, 50, 30, 25, 24, 20, 15, 12, 10]; // all divide the 600 video timescale
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function pickFps(srcFps, cap) {
  const limit = Math.min(cap || 30, (srcFps || 30) + 0.5);
  return FPS_CHOICES.find((f) => f <= limit) || 10;
}

function targetSize(w, h, mode) {
  const short = Math.min(w, h);
  const want = mode === 'hd' ? 1080 : mode === 'keep' ? Math.min(short, 2160) : 2160;
  let k = want / short;
  let tw = even(w * k);
  let th = even(h * k);
  // Stay inside H.264 level 5.1 (36864 macroblocks per frame, e.g. 4096x2304).
  const mbs = Math.ceil(tw / 16) * Math.ceil(th / 16);
  if (mbs > 36864) {
    k *= Math.sqrt(36864 / mbs) * 0.99;
    tw = even(w * k);
    th = even(h * k);
  }
  return { w: tw, h: th };
}

function videoFilter({ fps, hdr, src, dst, caps }) {
  const f = [`fps=${fps}`];
  const resize = dst.w !== src.w || dst.h !== src.h;
  const down = dst.w * dst.h < src.w * src.h;
  if (hdr) {
    if (!caps.zscale) {
      throw new Error('Video HDR perlukan ffmpeg dengan zimg (penapis zscale). Guna ffmpeg statik dari johnvansickle.com atau pakej ffmpeg Ubuntu/Debian.');
    }
    // Resize where it is cheapest: before tone mapping when shrinking, after when enlarging.
    if (resize && down) f.push(`zscale=w=${dst.w}:h=${dst.h}:f=lanczos`);
    // HLG/PQ -> linear (203 nit reference white) -> BT.709 primaries -> Hable tone curve -> BT.709 SDR.
    // Tuned against the reference HD file: ~36 dB PSNR vs Apple's own conversion.
    f.push('zscale=t=linear:npl=203', 'format=gbrpf32le', 'zscale=p=bt709', `tonemap=hable:desat=2${hdr === 'hlg' ? ':peak=10' : ''}`, 'zscale=t=bt709:m=bt709:r=tv');
    if (resize && !down) f.push(`zscale=w=${dst.w}:h=${dst.h}:f=lanczos`);
  } else {
    const color = 'in_color_matrix=auto:out_color_matrix=bt709:in_range=auto:out_range=tv';
    f.push(resize ? `scale=${dst.w}:${dst.h}:flags=lanczos+accurate_rnd+full_chroma_int:${color}` : `scale=${color}`);
  }
  f.push('format=yuv420p', 'setsar=1');
  return f.join(',');
}

export function makePlan(info, opts, caps) {
  const v = info.video;
  const srcVideo = info.movie?.tracks.find((t) => t.handler === 'vide');
  // MP4/MOV inputs: encode the stored frames and copy the display matrix, exactly like iPhone files.
  const keepMatrix = Boolean(srcVideo);
  let w = v.width;
  let h = v.height;
  if (!keepMatrix && Math.abs(v.rotation) % 180 === 90) [w, h] = [h, w]; // ffmpeg will auto-rotate
  const dst = targetSize(w, h, opts.mode);
  const fps = pickFps(v.fps, opts.fps);
  const px = dst.w * dst.h;
  const maxrate =
    opts.maxrate || (px >= 3840 * 2160 * 0.9 ? 11_000_000 : px >= 2560 * 1440 * 0.9 ? 9_000_000 : px >= 1920 * 1080 * 0.9 ? 8_000_000 : 6_000_000);

  let audio = { mode: 'silent' };
  const aacTracks = (info.movie?.tracks || []).filter((t) => t.handler === 'soun' && t.fourcc === 'mp4a' && t.samples.length);
  const aac = aacTracks.find((t) => t.tkhd.flags & 1) || aacTracks[0];
  const aacInfo = aac && inspectMp4a(aac.stsdEntries[0]);
  if (aacInfo && [2, 5, 29].includes(aacInfo.asc.aot)) audio = { mode: 'passthrough', trackId: aac.id };
  else if (info.audio) audio = { mode: 'transcode' };

  return {
    mode: opts.mode,
    src: { w, h, fps: v.fps, hdr: v.hdr },
    dst,
    fps,
    hdr: v.hdr,
    noAutorotate: keepMatrix,
    matrix: keepMatrix ? srcVideo.tkhd.matrix : null,
    filter: videoFilter({ fps, hdr: v.hdr, src: { w, h }, dst, caps }),
    preset: opts.preset,
    crf: opts.crf,
    maxrate,
    // 1 s closed GOP, 3 B-frames with pyramid, 4 refs, CABAC + 8x8 transform (High profile), no weighted P —
    // the bitstream shape of the reference file, whatever x264 preset is chosen.
    x264Params: `keyint=${fps}:min-keyint=${fps}:scenecut=0:bframes=3:b-adapt=0:b-pyramid=normal:ref=4:weightp=0:open-gop=0:cabac=1:8x8dct=1`,
    audio,
  };
}

export async function processVideo(input, output, options = {}, onProgress = () => {}) {
  const opts = { ...DEFAULTS };
  for (const [k, val] of Object.entries(options)) if (val !== undefined && val !== null && val !== '') opts[k] = val;
  const started = Date.now();
  const caps = await detectCaps();
  if (!caps.x264) throw new Error('ffmpeg anda tiada encoder libx264.');
  const info = await analyze(input);
  try {
    if (!info.video) throw new Error('Fail ini tiada trek video.');
    const plan = makePlan(info, opts, caps);
    fs.mkdirSync(opts.workDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(opts.workDir, 'job-'));
    try {
      const videoPath = path.join(work, 'video.mp4');
      await runFfmpeg(
        [
          ...(plan.noAutorotate ? ['-noautorotate'] : []),
          '-i', input,
          '-map', '0:v:0', '-an', '-sn', '-dn',
          '-map_metadata', '-1', '-map_chapters', '-1',
          '-vf', plan.filter,
          '-c:v', 'libx264', '-preset', plan.preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
          // 1-second VBV buffer keeps even short clips near the ceiling instead of overshooting it.
          '-crf', String(plan.crf), '-maxrate', String(plan.maxrate), '-bufsize', String(plan.maxrate),
          '-x264-params', plan.x264Params,
          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
          '-bsf:v', 'filter_units=remove_types=6', // drop x264's SEI banner
          '-video_track_timescale', '600',
          '-f', 'mp4', videoPath,
        ],
        { duration: info.duration, onProgress: (p) => onProgress({ stage: 'video', ...p }) },
      );

      let audioPath = null;
      if (plan.audio.mode === 'transcode') {
        audioPath = path.join(work, 'audio.m4a');
        await runFfmpeg(['-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-f', 'mp4', audioPath]);
      } else if (plan.audio.mode === 'silent') {
        audioPath = path.join(work, 'silence.m4a');
        await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(Math.max(0.2, info.duration)), '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', audioPath]);
      }

      onProgress({ stage: 'mux', percent: 100 });
      const mux = (out, v = {}) =>
        muxOutput({
          output: out,
          videoPath,
          audioPath,
          original: info.movie,
          plan,
          encoderTag: opts.encoderTag,
          pad: v.pad ?? opts.pad,
          dupAudio: v.dupAudio ?? opts.dupAudio,
          keepAppleTracks: v.keepAppleTracks ?? opts.keepAppleTracks,
        });
      const report = mux(output);
      // Extra containers from the same encode (e.g. a "clean" copy for comparison) — remuxing is cheap.
      const variants = (opts.variants || []).map((v) => {
        mux(v.output, v);
        return v.output;
      });

      const check = await ffprobe(output);
      const vOut = (check.streams || []).find((s) => s.codec_type === 'video');
      if (!vOut || vOut.codec_name !== 'h264') throw new Error('Semakan output gagal (tiada video H.264).');
      return {
        output,
        variants,
        seconds: (Date.now() - started) / 1000,
        input: {
          file: info.file,
          size: info.size,
          duration: info.duration,
          video: info.video,
          device: info.apple.model,
          appleTracks: info.apple.metadataTracks.length,
          spatialAudio: info.apple.spatialAudio,
          hadGps: info.apple.hasGps,
        },
        plan: { mode: plan.mode, dst: plan.dst, fps: plan.fps, hdr: plan.hdr, audio: plan.audio.mode, maxrate: plan.maxrate, preset: plan.preset, crf: plan.crf },
        result: {
          size: fs.statSync(output).size,
          width: report.video.width,
          height: report.video.height,
          frames: report.video.frames,
          duration: report.movieDuration,
          bitrate: Number(vOut.bit_rate) || 0,
          tracks: report.tracks,
        },
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    info.movie?.src.close();
  }
}
