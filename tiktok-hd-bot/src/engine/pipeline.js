// The whole method in one call: analyse -> encode (x264) -> remux iPhone-style -> verify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from './analyze.js';
import { detectCaps, runFfmpeg, ffprobe } from './ffmpeg.js';
import { inspectMp4a } from './aac.js';
import crypto from 'node:crypto';
import { muxOutput } from './mux.js';
import { ttPostProcess } from './ttremux.js';

export const DEFAULTS = {
  method: 'tt', // tt = keep the original video, package it like a TikTok/CapCut export (reference link file)
  //               haze = re-encode to SDR H.264 in an iPhone-style container (the earlier method)
  metaArtist: 'HD Method',
  metaComment: 'normal',
  mode: 'max', // max = 2160p (4K) | hd = 1080p | keep = source resolution (max 2160p)
  fps: 30, // upper limit; never duplicates frames (60 allowed)
  preset: 'medium', // x264 preset: veryfast/faster/fast/medium/slow
  crf: 16, // quality target; with qpmin 21 the floor below decides on easy content, maxrate on hard content
  maxrate: 0, // 0 = auto by resolution (4K ≈ 11 Mbps, same ceiling as the reference file)
  pad: true, // append 17 silent AAC frames in a tail mdat (reference-file quirk)
  dupAudio: true, // duplicate AAC track sharing the same data (reference-file quirk)
  keepAppleTracks: true, // pass through iPhone APAC + mebx camera metadata tracks
  appleBitstream: true, // Apple encoder SEI + nal_ref_idc like VideoToolbox output
  appleHeaders: true, // also transplant Apple's SPS/PPS and rewrite slice headers to match
  encoderTag: 'HD Method',
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
    // Rate control modelled on Apple's encoder in the reference files: a quality floor (slice QP never
    // under 21, as in their I-frames), I/P/B QP steps of about +6/+4, no psy/mbtree "grain keeping",
    // capped at maxrate. Calibrated: 11.0 Mbps on IMG_1880 (reference 11.08), ~4–5 Mbps on IMG_1913 (4.16).
    x264Params:
      `keyint=${fps}:min-keyint=${fps}:scenecut=0:bframes=3:b-adapt=0:b-pyramid=normal:ref=4:weightp=0:open-gop=0:cabac=1:8x8dct=1` +
      ':ipratio=2.0:pbratio=1.6:mbtree=0:psy-rd=0.0,0.0:aq-strength=0.5:qpmin=21' +
      ':weightb=0', // Apple's PPS has no weighted bi-prediction — needed for the SPS/PPS transplant
    audio,
  };
}

async function frameHashes(file, frames) {
  const lines = [];
  await runFfmpeg(['-i', file, '-map', '0:v:0', '-frames:v', String(frames), '-f', 'framemd5', '-'], {
    onLine: (l) => !l.startsWith('#') && lines.push(l.split(',').pop().trim()),
  }).catch(() => lines.push('error'));
  return lines;
}

async function sameFrames(a, b, frames) {
  const [x, y] = await Promise.all([frameHashes(a, frames), frameHashes(b, frames)]);
  return x.length > 0 && x.length === y.length && x.every((h, i) => h === y[i]);
}

/**
 * "tt" method — reproduces the reference file that TikTok accepts without re-compression:
 * the original video stream copied untouched (Apple HEVC HDR + Dolby Vision RPUs stay), remuxed by
 * ffmpeg into a faststart MP4 carrying the TikTok/CapCut editor tags (te_is_reencode=1, copyright
 * hash), then the duplicate AAC track + 17 silent frames added like the reference.
 */
async function processTT(input, output, opts, onProgress, started) {
  const caps = await detectCaps();
  const info = await analyze(input);
  try {
    const v = info.video;
    if (!v) throw new Error('Fail ini tiada trek video.');
    const streams = info.probe.streams || [];
    const vIndex = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic).index;
    const aac = streams.find((s) => s.codec_type === 'audio' && s.codec_name === 'aac');
    const anyAudio = streams.find((s) => s.codec_type === 'audio' && s.codec_name && s.codec_name !== 'unknown');
    const copyVideo = ['hevc', 'h264'].includes(v.codec) && v.fps <= 61 && (!v.bitrate || v.bitrate <= 80e6);
    const fps = copyVideo ? v.fps : pickFps(v.fps, 60);
    fs.mkdirSync(opts.workDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(opts.workDir, 'job-'));
    try {
      const step1 = path.join(work, 'remux.mp4');
      const args = ['-i', input];
      if (!anyAudio) args.push('-f', 'lavfi', '-t', String(Math.max(0.2, info.duration)), '-i', 'anullsrc=r=48000:cl=stereo');
      args.push('-map', `0:${vIndex}`, '-map', aac ? `0:${aac.index}` : anyAudio ? `0:${anyAudio.index}` : '1:a:0');
      if (copyVideo) {
        args.push('-c:v', 'copy');
      } else {
        if (!caps.x265) throw new Error('Video ini perlu encode semula tetapi ffmpeg tiada libx265.');
        const hdr = Boolean(v.hdr);
        const gop = Math.max(1, Math.round(fps / 2)); // half-second GOP like the reference
        const color = hdr
          ? `colorprim=bt2020:transfer=${v.transfer === 'smpte2084' ? 'smpte2084' : 'arib-std-b67'}:colormatrix=bt2020nc`
          : 'colorprim=bt709:transfer=bt709:colormatrix=bt709';
        args.push(
          '-vf', `fps=${fps}`,
          '-c:v', 'libx265', '-preset', opts.x265Preset || 'fast', '-crf', '18', '-tag:v', 'hvc1',
          '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p', ...(hdr ? ['-profile:v', 'main10'] : []),
          '-x265-params', `log-level=error:info=0:keyint=${gop}:min-keyint=${gop}:bframes=3:vbv-maxrate=25000:vbv-bufsize=50000:${color}`,
        );
      }
      args.push(aac ? '-c:a' : '-c:a', aac ? 'copy' : 'aac', ...(aac ? [] : ['-b:a', '256k', '-ar', '48000', '-ac', '2']));
      args.push(
        '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
        '-metadata', `artist=${opts.metaArtist}`,
        '-metadata', `comment=${opts.metaComment}`,
        '-metadata', `copyright=${crypto.randomBytes(16).toString('hex')}`,
        '-metadata', 'te_is_reencode=1',
        '-movflags', '+faststart+use_metadata_tags',
        '-f', 'mp4', step1,
      );
      await runFfmpeg(args, { duration: info.duration, onProgress: (p) => onProgress({ stage: copyVideo ? 'mux' : 'video', ...p }) });
      onProgress({ stage: 'mux', percent: 100 });
      ttPostProcess(step1, output, { pad: opts.pad, dup: opts.dupAudio });
      const check = await ffprobe(output);
      const vOut = (check.streams || []).find((s) => s.codec_type === 'video');
      if (!vOut) throw new Error('Semakan output gagal (tiada video).');
      const audioOut = (check.streams || []).filter((s) => s.codec_type === 'audio');
      return {
        output,
        seconds: (Date.now() - started) / 1000,
        input: {
          file: info.file,
          size: info.size,
          duration: info.duration,
          video: info.video,
          device: info.apple.model,
          appleTracks: 0,
          spatialAudio: false,
          hadGps: info.apple.hasGps,
        },
        plan: { method: 'tt', video: copyVideo ? 'copy' : 'x265', fps: Math.round(fps), hdr: v.hdr, audio: aac ? 'copy' : 'aac' },
        result: {
          size: fs.statSync(output).size,
          width: vOut.width,
          height: vOut.height,
          codec: vOut.codec_name,
          duration: Number(check.format?.duration) || 0,
          bitrate: Number(vOut.bit_rate) || 0,
          tracks: [vOut, ...audioOut].map((s) => ({ id: s.index + 1, fourcc: s.codec_tag_string })),
        },
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    info.movie?.src.close();
  }
}

export async function processVideo(input, output, options = {}, onProgress = () => {}) {
  const opts = { ...DEFAULTS };
  for (const [k, val] of Object.entries(options)) if (val !== undefined && val !== null && val !== '') opts[k] = val;
  const started = Date.now();
  if (opts.method === 'tt') return processTT(input, output, opts, onProgress, started);
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
          appleBitstream: opts.appleBitstream,
          appleHeaders: v.appleHeaders ?? opts.appleHeaders,
        });
      let report = mux(output);
      // Safety net for the header transplant: decoded pictures must be bit-identical to x264's own stream.
      if (report.video.bitstream === 'apple-headers' && !(await sameFrames(videoPath, output, 90))) {
        opts.appleHeaders = false;
        report = mux(output);
        report.video.bitstream += ' (transplant check failed)';
      }
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
        plan: { mode: plan.mode, dst: plan.dst, fps: plan.fps, hdr: plan.hdr, audio: plan.audio.mode, maxrate: plan.maxrate, preset: plan.preset, crf: plan.crf, bitstream: report.video.bitstream },
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
