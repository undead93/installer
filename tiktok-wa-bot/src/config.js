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
    // Kualiti encode semula: 14–20 (lebih kecil = lebih cantik, fail lebih besar)
    crf: Number(process.env.FFMPEG_CRF || 16),
    preset: process.env.FFMPEG_PRESET || 'slow',
  },
}

export function checkConfig() {
  const missing = []
  if (!config.tiktok.clientKey) missing.push('TIKTOK_CLIENT_KEY')
  if (!config.tiktok.clientSecret) missing.push('TIKTOK_CLIENT_SECRET')
  if (!config.tiktok.redirectUri) missing.push('TIKTOK_REDIRECT_URI')
  if (!config.allowedNumbers.length) missing.push('ALLOWED_NUMBERS')
  if (missing.length) {
    console.error(`❌ Sila isi dalam fail .env: ${missing.join(', ')}`)
    process.exit(1)
  }
  if (!['direct', 'draft'].includes(config.tiktok.defaultMode)) {
    console.error('❌ TIKTOK_MODE mesti "direct" atau "draft"')
    process.exit(1)
  }
}
