// Video analysis + a "TikTok HD readiness" check (similar to the checker paid tools offer).
import fs from 'node:fs';
import path from 'node:path';
import { ffprobe } from './ffmpeg.js';
import { parseMovie } from './mp4.js';
import { inspectMp4a } from './aac.js';

const ratio = (s) => {
  if (!s) return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a || 0;
};

function mebxKey(track) {
  const text = track.stsdEntries[0]?.toString('latin1') || '';
  const m = text.match(/com\.apple\.quicktime\.([a-z0-9.-]+)/i);
  return m ? m[1] : 'unknown';
}

export async function analyze(input) {
  const stat = fs.statSync(input);
  const probe = await ffprobe(input);
  let movie = null;
  try {
    movie = parseMovie(input);
  } catch {
    movie = null; // not MP4/MOV (e.g. mkv/webm) — still processable through ffmpeg
  }
  const streams = probe.streams || [];
  const vs = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio' && s.codec_name);
  const duration = Number(probe.format?.duration) || Number(vs?.duration) || 0;

  let video = null;
  if (vs) {
    const side = vs.side_data_list || [];
    const dovi = side.find((d) => /dovi/i.test(d.side_data_type || ''));
    const rot = side.find((d) => d.rotation !== undefined);
    const transfer = vs.color_transfer || '';
    const pix = vs.pix_fmt || '';
    video = {
      codec: vs.codec_name,
      profile: vs.profile,
      width: vs.width,
      height: vs.height,
      fps: ratio(vs.avg_frame_rate) || ratio(vs.r_frame_rate),
      rotation: rot ? Number(rot.rotation) : 0,
      pixFmt: pix,
      bitDepth: /p12/.test(pix) ? 12 : /p10/.test(pix) ? 10 : 8,
      transfer,
      primaries: vs.color_primaries || '',
      matrix: vs.color_space || '',
      range: vs.color_range || '',
      hdr: transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : null,
      dolbyVision: dovi ? { profile: dovi.dv_profile, level: dovi.dv_level, compat: dovi.dv_bl_signal_compatibility_id } : null,
      bitrate: Number(vs.bit_rate) || 0,
      frames: Number(vs.nb_frames) || 0,
    };
    if (video.dolbyVision && !video.hdr) video.hdr = video.dolbyVision.compat === 4 ? 'hlg' : 'pq';
  }

  const tracks = movie?.tracks || [];
  const keys = movie?.appleKeys || {};
  const aacTrack = tracks.find((t) => t.handler === 'soun' && t.fourcc === 'mp4a' && t.stsdEntries[0] && inspectMp4a(t.stsdEntries[0]));
  const aac = aacTrack ? inspectMp4a(aacTrack.stsdEntries[0]) : null;
  const apple = {
    brand: movie?.brand || null,
    make: keys['com.apple.quicktime.make'] || null,
    model: keys['com.apple.quicktime.model'] || null,
    software: keys['com.apple.quicktime.software'] || null,
    creationDate: keys['com.apple.quicktime.creationdate'] || null,
    hasGps: Object.keys(keys).some((k) => k.includes('location')),
    metadataTracks: tracks.filter((t) => t.handler === 'meta' && t.fourcc === 'mebx').map(mebxKey),
    spatialAudio: tracks.some((t) => t.handler === 'soun' && t.fourcc === 'apac'),
    coreMedia: tracks.some((t) => /^Core Media/.test(t.handlerName || '')),
  };

  const audio = audioStreams[0]
    ? {
        codec: audioStreams[0].codec_name,
        sampleRate: Number(audioStreams[0].sample_rate) || 0,
        channels: Number(audioStreams[0].channels) || 0,
        bitrate: Number(audioStreams[0].bit_rate) || 0,
        aacPassthrough: Boolean(aac && [2, 5, 29].includes(aac.asc.aot)),
      }
    : null;

  const encoderTag = probe.format?.tags?.encoder || null;
  const result = {
    file: path.basename(input),
    size: stat.size,
    duration,
    bitrate: Number(probe.format?.bit_rate) || 0,
    video,
    audio,
    apple,
    encoderTag,
    probe,
    movie,
  };
  result.tiktok = tiktokCheck(result);
  return result;
}

/** Heuristics derived from what a file that TikTok accepts as HD looks like. */
export function tiktokCheck(a) {
  const issues = [];
  const v = a.video;
  if (!v) return { ready: false, issues: ['Tiada trek video'] };
  if (v.codec !== 'h264') issues.push(`Codec ${v.codec?.toUpperCase()} — TikTok lebih suka H.264`);
  if (v.hdr) issues.push(`HDR ${v.hdr.toUpperCase()}${v.dolbyVision ? ' + Dolby Vision' : ''} — TikTok akan tukar sendiri, warna pudar/terbakar`);
  if (v.bitDepth > 8) issues.push(`${v.bitDepth}-bit — perlu 8-bit`);
  if (v.fps > 30.5) issues.push(`${Math.round(v.fps)}fps — TikTok mampat semula, guna 30fps`);
  const short = Math.min(v.width, v.height);
  if (short < 1080) issues.push(`Resolusi ${v.width}x${v.height} — bawah 1080p`);
  if (v.bitrate > 14e6) issues.push(`Bitrate ${(v.bitrate / 1e6).toFixed(0)} Mbps — terlalu tinggi, app TikTok akan mampat`);
  if (a.apple.brand !== 'qt  ') issues.push('Bekas bukan QuickTime gaya iPhone');
  const warnings = [];
  if (a.apple.hasGps) warnings.push('Ada lokasi GPS dalam fail (akan dibuang)');
  return { ready: issues.length === 0, issues, warnings };
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const mbps = (n) => `${(n / 1e6).toFixed(1)} Mbps`;

export function formatAnalysis(a) {
  const v = a.video;
  const lines = [];
  lines.push(`📊 *Analisis video*`);
  lines.push(`• Fail: ${a.file} (${mb(a.size)}, ${a.duration.toFixed(1)}s)`);
  if (a.apple.model) lines.push(`• Peranti: ${a.apple.model}${a.apple.software ? ` (iOS ${a.apple.software})` : ''}`);
  if (v) {
    const hdr = v.hdr ? ` HDR-${v.hdr.toUpperCase()}${v.dolbyVision ? ` + Dolby Vision ${v.dolbyVision.profile}.${v.dolbyVision.compat}` : ''}` : ' SDR';
    lines.push(`• Video: ${v.codec?.toUpperCase()} ${v.bitDepth}-bit ${v.width}x${v.height} @${Math.round(v.fps * 100) / 100}fps, ${mbps(v.bitrate)},${hdr}`);
  }
  if (a.audio) lines.push(`• Audio: ${a.audio.codec?.toUpperCase()} ${a.audio.sampleRate / 1000}kHz ${a.audio.channels}ch${a.apple.spatialAudio ? ' + Spatial Audio (APAC)' : ''}`);
  if (a.apple.metadataTracks.length) lines.push(`• Metadata kamera iPhone: ${a.apple.metadataTracks.length} trek (${a.apple.metadataTracks.join(', ')})`);
  if (a.encoderTag) lines.push(`• Tag encoder: ${a.encoderTag}`);
  lines.push('');
  if (a.tiktok.ready) {
    lines.push('✅ *Sedia untuk TikTok HD* — format sudah betul.');
  } else {
    lines.push('❌ *Belum sedia untuk TikTok HD:*');
    for (const i of a.tiktok.issues) lines.push(`   - ${i}`);
  }
  for (const w of a.tiktok.warnings) lines.push(`⚠️ ${w}`);
  return lines.join('\n');
}
