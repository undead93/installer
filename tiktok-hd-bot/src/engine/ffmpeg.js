// ffmpeg / ffprobe process helpers.
import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(cmd, args, { onStdoutLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      if (onStdoutLine) {
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const l of lines) onStdoutLine(l);
      } else {
        stdout += text;
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') reject(new Error(`"${cmd}" tidak dijumpai. Pasang ffmpeg dahulu (lihat README).`));
      else reject(err);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function ffprobe(path) {
  const { code, stdout, stderr } = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  if (code !== 0) throw new Error(`ffprobe gagal membaca fail: ${stderr.trim().split('\n').pop() || code}`);
  return JSON.parse(stdout);
}

let capsCache = null;
export async function detectCaps() {
  if (capsCache) return capsCache;
  const [enc, flt, ver] = await Promise.all([
    run(FFMPEG, ['-hide_banner', '-encoders']),
    run(FFMPEG, ['-hide_banner', '-filters']),
    run(FFMPEG, ['-hide_banner', '-version']),
  ]);
  const has = (text, name) => new RegExp(`\\s${name}\\s`).test(text);
  capsCache = {
    x264: has(enc.stdout, 'libx264'),
    aac: has(enc.stdout, 'aac'),
    zscale: has(flt.stdout, 'zscale'),
    tonemap: has(flt.stdout, 'tonemap'),
    lut3d: has(flt.stdout, 'lut3d'),
    version: (ver.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown',
  };
  return capsCache;
}

/**
 * Run ffmpeg with machine-readable progress. `duration` (seconds) is used to
 * turn out_time into a percentage.
 */
export async function runFfmpeg(args, { duration = 0, onProgress, signal } = {}) {
  const state = {};
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args];
  const { code, stderr } = await run(FFMPEG, full, {
    signal,
    onStdoutLine: (line) => {
      const i = line.indexOf('=');
      if (i < 0) return;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      state[k] = v;
      if (k === 'progress' && onProgress) {
        const t = Number(state.out_time_us || state.out_time_ms || 0) / 1e6;
        const percent = duration > 0 ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0;
        onProgress({ percent, fps: Number(state.fps) || 0, speed: state.speed || '', done: v === 'end' });
      }
    },
  });
  if (code !== 0) {
    const msg = stderr.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`ffmpeg gagal (kod ${code}): ${msg}`);
  }
}
