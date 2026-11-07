// Semak & (kalau perlu) tukar video guna ffprobe/ffmpeg
import { spawn } from 'node:child_process'
import { config } from './config.js'

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-800) || `${cmd} exit ${code}`))))
  })
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0
  const [a, b] = rate.split('/').map(Number)
  return b ? a / b : a
}

/** Pulangkan info video, atau null kalau ffprobe tiada / fail bukan video. */
export async function probe(filePath) {
  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration',
      '-of', 'json',
      filePath,
    ])
    const json = JSON.parse(out)
    const s = json.streams?.[0]
    if (!s) return null
    return {
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      fps: Math.round(parseRate(s.avg_frame_rate) || parseRate(s.r_frame_rate)),
      duration: Number(json.format?.duration || 0),
    }
  } catch {
    return null
  }
}

/** Encode semula ke 60fps H.264 kualiti tinggi. */
export async function convertTo60(input, output) {
  await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', 'fps=60',
    '-c:v', 'libx264',
    '-preset', config.video.preset,
    '-crf', String(config.video.crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ])
  return output
}
