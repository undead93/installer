import 'dotenv/config'
import path from 'node:path'

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')

export const config = {
  dataDir: DATA_DIR,
  waAuthDir: path.join(DATA_DIR, 'wa-auth'),
  downloadDir: path.join(DATA_DIR, 'downloads'),

  // Nombor yang dibenarkan guna bot (format antarabangsa, tanpa + atau 0 depan), cth: 60123456789
  allowedNumbers: list(process.env.ALLOWED_NUMBERS).map((n) => n.replace(/\D/g, '')),
  // Kalau diisi, bot login guna "pairing code" (tak perlu scan QR). Nombor WhatsApp BOT.
  pairingNumber: (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, ''),
  // true = bot di-link ke nombor ANDA SENDIRI, guna chat "Message yourself" (tak perlu nombor kedua)
  selfChat: (process.env.SELF_CHAT || 'false').toLowerCase() === 'true',
  // Awalan arahan. Tukar kalau bertembung dengan bot lain. Awalan yang berakhir dengan huruf perlu jarak: "tt" → "tt semak"; "#" → "#semak"
  prefix: (process.env.COMMAND_PREFIX || '!').trim() || '!',
  // Kalau diisi, video hanya diproses bila caption bermula dengan perkataan ini (cth "tt"). Perkataan ni dibuang dari caption.
  videoTrigger: (process.env.VIDEO_TRIGGER || '').trim(),

  // web = upload melalui tiktok.com guna browser automatik (tak perlu developer)
  // api = TikTok Content Posting API rasmi (perlu app TikTok for Developers)
  method: (process.env.TIKTOK_METHOD || 'web').toLowerCase(),

  web: {
    headless: (process.env.BROWSER_HEADLESS || 'true').toLowerCase() !== 'false',
    uploadTimeoutMin: Number(process.env.UPLOAD_TIMEOUT_MIN || 15),
    timezone: process.env.TZ_BROWSER || 'Asia/Kuala_Lumpur',
  },

  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri: process.env.TIKTOK_REDIRECT_URI || '',
    // direct = terus post | draft = hantar ke inbox TikTok, anda tekan Post dalam app
    defaultMode: (process.env.TIKTOK_MODE || 'direct').toLowerCase(),
    defaultPrivacy: (process.env.TIKTOK_PRIVACY || 'SELF_ONLY').toUpperCase(),
  },

  video: {
    // Tukar video >60fps ke 60fps guna ffmpeg (TikTok API tak terima lebih 60fps)
    autoConvert60: (process.env.AUTO_CONVERT_60FPS || 'true').toLowerCase() !== 'false',
    // Optimumkan video sebelum upload: H.264 1080p SDR 8-bit (tukar HEVC/HDR/4K iPhone). Fail yang dah elok tak diencode semula.
    optimize: (process.env.OPTIMIZE_VIDEO || 'true').toLowerCase() !== 'false',
    // Siling bitrate bila encode semula (Mbps). Panduan biasa: 8–12
    maxBitrateMbps: Number(process.env.MAX_BITRATE_MBPS || 12),
    // Kualiti encode semula: 14–20 (lebih kecil = lebih cantik, fail lebih besar)
    crf: Number(process.env.FFMPEG_CRF || 17),
    preset: process.env.FFMPEG_PRESET || 'slow',
  },
}

export function missingTikTokConfig() {
  const missing = []
  if (!config.tiktok.clientKey) missing.push('TIKTOK_CLIENT_KEY')
  if (!config.tiktok.clientSecret) missing.push('TIKTOK_CLIENT_SECRET')
  if (!config.tiktok.redirectUri) missing.push('TIKTOK_REDIRECT_URI')
  return missing
}

export function checkConfig() {
  if (!config.selfChat && !config.allowedNumbers.length) {
    console.error('❌ Sila isi ALLOWED_NUMBERS dalam fail .env (atau set SELF_CHAT=true)')
    process.exit(1)
  }
  if (!['web', 'api'].includes(config.method)) {
    console.error('❌ TIKTOK_METHOD mesti "web" atau "api"')
    process.exit(1)
  }
  const missing = config.method === 'api' ? missingTikTokConfig() : []
  if (missing.length) {
    // WhatsApp masih boleh di-link dulu; TikTok boleh disambung kemudian
    console.warn(`⚠️ Belum isi dalam .env: ${missing.join(', ')}. Bot boleh link WhatsApp dulu, tapi TikTok belum boleh digunakan.`)
  }
  if (!['direct', 'draft'].includes(config.tiktok.defaultMode)) {
    console.error('❌ TIKTOK_MODE mesti "direct" atau "draft"')
    process.exit(1)
  }
}
