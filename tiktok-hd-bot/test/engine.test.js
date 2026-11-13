// End-to-end engine tests on synthetic videos generated with ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { processVideo } from '../src/engine/pipeline.js';
import { parseMovie } from '../src/engine/mp4.js';
import { analyze } from '../src/engine/analyze.js';
import { parseSps, appleSps } from '../src/engine/avc.js';

let dir;
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const md5 = (m, samples) => {
  const h = crypto.createHash('md5');
  for (const s of samples) h.update(m.src.read(s.offset, s.size));
  return h.digest('hex');
};
const FAST = { method: 'haze', preset: 'ultrafast', encoderTag: 'Test Tag' };

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdtest-'));
  // iPhone-like: HEVC 10-bit HLG, 60 fps, portrait via display matrix, AAC stereo.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '2',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-tag:v', 'hvc1',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k', path.join(dir, 'hlg_raw.mov'));
  ff('-display_rotation:v:0', '90', '-i', path.join(dir, 'hlg_raw.mov'), '-c', 'copy', path.join(dir, 'hlg.mov'));
  // Android/CapCut-like: H.264 full range 720x1280 30 fps, MP3 audio.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30', '-f', 'lavfi', '-i', 'sine=f=300:r=44100', '-t', '1.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuvj420p', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, 'sdr.mov'));
  // No audio at all.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=25', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'mute.mp4'));
  // Not MP4 at all: WebM VP9 + Opus.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=50', '-f', 'lavfi', '-i', 'sine=f=500:r=48000', '-t', '1',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', path.join(dir, 'clip.webm'));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('iPhone-style HDR source: tone mapped, 30 fps, AAC passthrough + padding + duplicate, matrix kept', async () => {
  const input = path.join(dir, 'hlg.mov');
  const output = path.join(dir, 'hlg_hd.mp4');
  const res = await processVideo(input, output, { ...FAST, mode: 'hd' });
  assert.equal(res.plan.fps, 30);
  assert.equal(res.plan.hdr, 'hlg');
  assert.equal(res.plan.audio, 'passthrough');

  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.profile, 'High');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(v.color_transfer, 'bt709');
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(`${v.width}x${v.height}`, '1920x1080'); // stored size...
  const rot = (v.side_data_list || []).find((d) => d.rotation !== undefined);
  assert.equal(Math.abs(Number(rot?.rotation)), 90); // ...displayed portrait through the copied matrix
  assert.equal(p.format.tags.major_brand, 'qt  ');
  assert.equal(p.format.tags.encoder, 'Test Tag');

  const src = parseMovie(input);
  const out = parseMovie(output);
  try {
    assert.deepEqual(out.topLevel, ['ftyp', 'wide', 'mdat', 'mdat', 'moov']);
    assert.deepEqual(out.tracks.map((t) => t.fourcc), ['mp4a', 'avc1', 'mp4a']);
    assert.deepEqual(out.tracks.map((t) => t.handlerName), ['Core Media Audio', 'Core Media Video', 'Core Media Audio']);
    assert.equal(out.mvhd.timescale, 1000);
    assert.equal(Object.keys(out.appleKeys).length, 0);

    const [a1, vt, a2] = out.tracks;
    const srcAac = src.tracks.find((t) => t.fourcc === 'mp4a');
    const kept = a1.samples.length - 17;
    assert.ok(kept >= srcAac.samples.length - 1, 'audio is only trimmed to the video end');
    assert.equal(md5(out, a1.samples.slice(0, kept)), md5(src, srcAac.samples.slice(0, kept)), 'AAC packets copied bit-exact');
    assert.ok(a1.samples.slice(kept).every((s) => s.size === 6), '17 silent 6-byte frames appended');
    assert.equal(a1.stsdEntries.length, 2);
    assert.deepEqual(a2.samples.map((s) => s.offset), a1.samples.map((s) => s.offset), 'duplicate track shares the same data');
    assert.equal(vt.mdhd.timescale, 600);
    assert.ok(vt.samples.every((s) => s.dur === 20));
    assert.equal(vt.samples.filter((s) => s.sync).length, 2, '1-second closed GOPs');
    assert.ok(vt.hasSdtp);
    assert.ok(vt.tapt);
  } finally {
    src.src.close();
    out.src.close();
  }

  // Apple-style bitstream: Apple SEI on every keyframe, nal_ref_idc 1, SPS/PPS headers 0x27/0x28
  const o2 = parseMovie(output);
  try {
    const v = o2.tracks.find((t) => t.handler === 'vide');
    const nals = (i) => {
      const b = o2.src.read(v.samples[i].offset, v.samples[i].size);
      const out = [];
      for (let p = 0; p + 4 < b.length; p += 4 + b.readUInt32BE(p)) out.push(b.subarray(p + 4, p + 4 + b.readUInt32BE(p)));
      return out;
    };
    const first = nals(0);
    assert.equal(first[0][0], 0x06, 'SEI before the first slice');
    assert.ok(first[0].includes(Buffer.from('47564adc5c4c433f94efc5113cd143a8', 'hex')), 'Apple encoder UUID');
    // byte-identical to the SEI NAL units in the reference files
    assert.equal(first[0].toString('hex'), '06052d47564adc5c4c433f94efc5113cd143a8010000030006030000030003020339d2000b00000300000300001d600c03912b0180');
    const k2 = v.samples.findIndex((x, i) => i > 0 && x.sync);
    assert.equal(nals(k2)[0].toString('hex'), '06051547564adc5c4c433f94efc5113cd143a803000003000380');
    for (let i = 0; i < v.samples.length; i++) for (const n of nals(i)) assert.ok(((n[0] >> 5) & 3) <= 1, 'nal_ref_idc is 0 or 1');
    const entry = v.stsdEntries[0];
    const avcC = entry.subarray(entry.indexOf('avcC') - 4);
    assert.equal(avcC[8 + 8], 0x27, 'SPS header like Apple');
    const a1 = o2.tracks[0];
    const pce = a1.stsdEntries[1].toString('hex');
    assert.ok(pce.includes('118004c040002000'), 'second sample description = PCE stereo config');
  } finally {
    o2.src.close();
  }

  const bytes = fs.readFileSync(output);
  assert.equal(bytes.includes('x264'), false, 'x264 SEI banner removed');
  assert.equal(bytes.includes('Lavf'), false);
  // the whole file decodes without errors
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0', '-f', 'null', '-']);
});

test('clean copy from the same encode: same video bytes, no duplicate AAC, no silent tail, one mdat', async () => {
  const input = path.join(dir, 'hlg.mov');
  const haze = path.join(dir, 'variant_haze.mov');
  const clean = path.join(dir, 'variant_clean.mov');
  const res = await processVideo(input, haze, { ...FAST, mode: 'hd', variants: [{ output: clean, pad: false, dupAudio: false }] });
  assert.deepEqual(res.variants, [clean]);
  const h = parseMovie(haze);
  const c = parseMovie(clean);
  try {
    assert.deepEqual(c.topLevel, ['ftyp', 'wide', 'mdat', 'moov']);
    assert.deepEqual(c.tracks.map((t) => t.fourcc), ['mp4a', 'avc1']);
    assert.equal(c.tracks[0].stsdEntries.length, 1);
    assert.equal(c.tracks[0].samples.length, h.tracks[0].samples.length - 17);
    assert.equal(md5(c, c.tracks[1].samples), md5(h, h.tracks[1].samples), 'identical H.264 samples');
    assert.equal(md5(c, c.tracks[0].samples), md5(h, h.tracks[0].samples.slice(0, -17)), 'identical AAC packets');
  } finally {
    h.src.close();
    c.src.close();
  }
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', clean, '-map', '0', '-f', 'null', '-']);
});

test('mono AAC is padded too: 17 four-byte silent frames, PCE mono config on the last 8', async () => {
  const input = path.join(dir, 'mono.mov');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', input);
  const output = path.join(dir, 'mono_hd.mp4');
  await processVideo(input, output, { ...FAST, mode: 'keep' });
  const m = parseMovie(output);
  try {
    assert.deepEqual(m.topLevel, ['ftyp', 'wide', 'mdat', 'mdat', 'moov']);
    const a = m.tracks[0];
    const tail = a.samples.slice(-17);
    assert.ok(tail.every((x) => x.size === 4));
    assert.equal(m.src.read(tail[0].offset, 4).toString('hex'), '01182007');
    assert.deepEqual(tail.map((x) => x.sdi), [...Array(9).fill(1), ...Array(8).fill(2)]);
    assert.ok(a.stsdEntries[1].toString('hex').includes('118804c040000000'.replace('8804', '8004')), 'PCE mono config');
    assert.equal(a.elng, null, 'no elng invented when the source has none');
  } finally {
    m.src.close();
  }
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0', '-f', 'null', '-']);
});

test('Apple SPS built from x264 4K SPS is byte-identical to the reference files', () => {
  const x264Sps = Buffer.from('67640033acd9403c0043ec05a808080a000003000200000300781e30632c', 'hex');
  assert.equal(appleSps(parseSps(x264Sps), 30).toString('hex'), '27640033ac56500f0010fa6a02020280071a6d00cdfe6002');
});

test('Apple SPS/PPS transplant is lossless: every decoded frame identical to x264 headers', async () => {
  const input = path.join(dir, 'hlg.mov');
  const a = path.join(dir, 'tp_apple.mp4');
  const b = path.join(dir, 'tp_x264.mp4');
  const res = await processVideo(input, a, { ...FAST, preset: 'veryfast', mode: 'hd', variants: [{ output: b, appleHeaders: false }] });
  assert.equal(res.plan.bitstream, 'apple-headers');
  const hashes = (f) => execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', f, '-map', '0:v:0', '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
  const ha = hashes(a);
  assert.equal(ha.length, 60);
  assert.deepEqual(ha, hashes(b));
  const m = parseMovie(a);
  try {
    const e = m.tracks.find((t) => t.handler === 'vide').stsdEntries[0];
    const avcC = e.subarray(e.indexOf('avcC') + 4);
    assert.equal(avcC[8], 0x27, 'Apple-style SPS');
    const spsLen = avcC.readUInt16BE(6);
    assert.equal(avcC.subarray(8 + spsLen + 3, 8 + spsLen + 7).toString('hex'), '28ee3cb0', 'Apple PPS');
  } finally {
    m.src.close();
  }
});

test('tt method: original video copied bit-exact, packaged like the reference (tags, padding, duplicate after udta)', async () => {
  const input = path.join(dir, 'hlg.mov');
  const output = path.join(dir, 'tt.mp4');
  const res = await processVideo(input, output, { method: 'tt', metaArtist: 'A', metaComment: 'C' });
  assert.equal(res.plan.method, 'tt');
  assert.equal(res.plan.video, 'copy');
  const p = probe(output);
  const tags = p.format.tags;
  assert.equal(tags.major_brand, 'isom');
  assert.equal(tags.compatible_brands, 'isomiso2mp41');
  assert.equal(tags.te_is_reencode, '1');
  assert.match(tags.copyright, /^[0-9a-f]{32}$/);
  assert.equal(tags.artist, 'A');
  assert.equal(tags.comment, 'C');
  assert.match(tags.encoder, /^Lavf/);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'hevc');
  assert.equal(v.color_transfer, 'arib-std-b67', 'HDR kept');
  assert.equal(v.tags.handler_name, 'VideoHandler');
  const src = parseMovie(input);
  const out = parseMovie(output);
  try {
    assert.deepEqual(out.topLevel, ['ftyp', 'moov', 'free', 'mdat']);
    assert.deepEqual(out.tracks.map((t) => t.fourcc), ['hvc1', 'mp4a', 'mp4a']);
    const sv = src.tracks.find((t) => t.handler === 'vide');
    assert.equal(md5(out, out.tracks[0].samples), md5(src, sv.samples), 'video samples copied bit-exact');
    const a1 = out.tracks[1];
    assert.equal(a1.stsdEntries.length, 2);
    assert.ok(a1.stsdEntries[1].toString('hex').includes('118004c040002000'));
    assert.deepEqual(a1.samples.slice(-17).map((x) => x.size), Array(17).fill(6));
    assert.deepEqual(out.tracks[2].samples.map((x) => x.offset), a1.samples.map((x) => x.offset));
  } finally {
    src.src.close();
    out.src.close();
  }
  const raw = fs.readFileSync(output);
  assert.ok(raw.indexOf('udta') < raw.lastIndexOf('trak'), 'duplicate track written after udta');
  assert.equal(raw.includes('dvvC'), false);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0', '-f', 'null', '-']);
});

test('tt method re-encodes what cannot be copied (VP9) with x265 and still adds the tags', async () => {
  const output = path.join(dir, 'tt_vp9.mp4');
  const res = await processVideo(path.join(dir, 'clip.webm'), output, { method: 'tt', x265Preset: 'ultrafast' });
  assert.equal(res.plan.video, 'x265');
  const p = probe(output);
  assert.equal(p.streams.find((s) => s.codec_type === 'video').codec_name, 'hevc');
  assert.equal(p.format.tags.te_is_reencode, '1');
  assert.equal(p.streams.filter((s) => s.codec_type === 'audio').length, 2);
});

test('SDR full-range source with MP3: upscaled to 4K, audio transcoded to AAC', async () => {
  const input = path.join(dir, 'sdr.mov');
  const output = path.join(dir, 'sdr_hd.mp4');
  const res = await processVideo(input, output, { ...FAST, mode: 'max' });
  assert.equal(res.plan.audio, 'transcode');
  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '2160x3840');
  assert.equal(v.color_range, 'tv');
  assert.equal(v.level, 51);
  const a = p.streams.filter((s) => s.codec_type === 'audio');
  assert.equal(a.length, 2);
  assert.ok(a.every((s) => s.codec_name === 'aac' && s.sample_rate === '48000'));
});

test('video without audio gets a silent AAC track; 25 fps kept', async () => {
  const output = path.join(dir, 'mute_hd.mp4');
  const res = await processVideo(path.join(dir, 'mute.mp4'), output, { ...FAST, mode: 'keep' });
  assert.equal(res.plan.audio, 'silent');
  assert.equal(res.plan.fps, 25);
  const p = probe(output);
  assert.equal(p.streams.find((s) => s.codec_type === 'video').r_frame_rate, '25/1');
  assert.ok(p.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
});

test('non-MP4 input (WebM VP9/Opus) is handled through ffmpeg', async () => {
  const output = path.join(dir, 'clip_hd.mp4');
  const res = await processVideo(path.join(dir, 'clip.webm'), output, { ...FAST, mode: 'hd' });
  assert.equal(res.plan.audio, 'transcode');
  assert.equal(res.plan.fps, 30); // 50 -> 30 cap
  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '1920x1080');
});

test('analysis flags what TikTok dislikes', async () => {
  const a = await analyze(path.join(dir, 'hlg.mov'));
  a.movie?.src.close();
  assert.equal(a.tiktok.ready, false);
  assert.ok(a.tiktok.issues.some((i) => i.includes('HDR')));
  assert.ok(a.tiktok.issues.some((i) => i.includes('60fps')));
  const b = await analyze(path.join(dir, 'hlg_hd.mp4'));
  b.movie?.src.close();
  assert.equal(b.tiktok.ready, true, b.tiktok.issues.join('; '));
});
