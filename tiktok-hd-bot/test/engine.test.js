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

let dir;
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
const md5 = (m, samples) => {
  const h = crypto.createHash('md5');
  for (const s of samples) h.update(m.src.read(s.offset, s.size));
  return h.digest('hex');
};
const FAST = { preset: 'ultrafast', encoderTag: 'Test Tag' };

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

  const bytes = fs.readFileSync(output);
  assert.equal(bytes.includes('x264'), false, 'x264 SEI banner removed');
  assert.equal(bytes.includes('Lavf'), false);
  // the whole file decodes without errors
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0', '-f', 'null', '-']);
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
