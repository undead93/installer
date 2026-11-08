// Semak & optimumkan video sebelum upload guna ffprobe/ffmpeg
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

const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67']

/** Pulangkan info video, atau null kalau ffprobe tiada / fail bukan video. */
export async function probe(filePath) {
  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,color_transfer,color_primaries,bit_rate:stream_side_data=rotation:format=duration,bit_rate',
      '-of', 'json',
      filePath,
    ])
    const json = JSON.parse(out)
    const v = json.streams?.find((s) => s.codec_type === 'video')
    if (!v) return null
    const rotation = Math.abs(Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation || 0))
    const rotated = rotation === 90 || rotation === 270
    return {
      codec: v.codec_name,
      // Saiz seperti yang dipaparkan (ambil kira video telefon yang diputar)
      width: rotated ? v.height : v.width,
      height: rotated ? v.width : v.height,
      fps: Math.round(parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate)),
      pixFmt: v.pix_fmt || '',
      hdr: HDR_TRANSFERS.includes(v.color_transfer),
      tenBit: /10|12/.test(v.pix_fmt || ''),
      hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
      bitrateKbps: Math.round(Number(json.format?.bit_rate || v.bit_rate || 0) / 1000),
      duration: Number(json.format?.duration || 0),
    }
  } catch {
    return null
  }
}

export function describe(info) {
  if (!info) return 'tak diketahui'
  const parts = [`${info.width}x${info.height}`, `${info.fps}fps`, info.codec?.toUpperCase()]
  if (info.hdr) parts.push('HDR')
  if (info.bitrateKbps) parts.push(`${(info.bitrateKbps / 1000).toFixed(1)} Mbps`)
  if (!info.hasAudio) parts.push('tiada audio')
  return parts.join(' · ')
}

/**
 * Tentukan apa yang perlu dibuat supaya fail ikut tetapan yang TikTok proses paling elok:
 * 1080p, H.264 8-bit SDR, maks 60fps, ada trek audio.
 */
export function plan(info) {
  const reasons = []
  if (!info) return { reencode: false, addAudio: false, reasons }
  if (info.codec !== 'h264') reasons.push(`codec ${info.codec?.toUpperCase()} → H.264`)
  if (info.hdr) reasons.push('HDR → SDR (warna tak pudar)')
  else if (info.tenBit) reasons.push('10-bit → 8-bit')
  if (info.fps > 60) reasons.push(`${info.fps}fps → 60fps`)
  if (Math.min(info.width, info.height) > 1080) reasons.push(`${info.width}x${info.height} → 1080p`)
  const reencode = config.video.optimize ? reasons.length > 0 : info.fps > 60 && config.video.autoConvert60
  return { reencode, addAudio: !info.hasAudio, reasons: reencode ? reasons : [] }
}

/** Buat fail baru ikut plan. Pulangkan laluan fail output. */
export async function optimize(input, output, info, p) {
  const fps = Math.min(info.fps || 30, 60)
  const args = ['-y', '-i', input]
  if (p.addAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')

  args.push('-map', '0:v:0', '-map', p.addAudio ? '1:a:0' : '0:a:0')

  if (p.reencode) {
    const filters = []
    if (info.hdr) {
      // Tone-map HDR (HLG/PQ dari iPhone) ke SDR BT.709
      filters.push(
        'zscale=t=linear:npl=100',
        'format=gbrpf32le',
        'zscale=p=bt709',
        'tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv',
      )
    }
    // Sisi paling pendek maks 1080 (menegak → 1080x1920, melintang → 1920x1080)
    filters.push(
      "scale=w='if(gt(iw,ih),-2,min(1080,iw))':h='if(gt(iw,ih),min(1080,ih),-2)':flags=lanczos",
      `fps=${fps}`,
      'format=yuv420p',
    )
    args.push(
      '-vf', filters.join(','),
      '-c:v', 'libx264',
      '-preset', config.video.preset,
      '-profile:v', 'high',
      '-crf', String(config.video.crf),
      // VBR dengan siling bitrate (panduan: 8–12 Mbps)
      '-maxrate', `${config.video.maxBitrateMbps}M`,
      '-bufsize', `${config.video.maxBitrateMbps * 2}M`,
      '-g', String(fps * 2),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    )
  } else {
    args.push('-c:v', 'copy')
  }

  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', output)
  await run('ffmpeg', args)
  return output
}
