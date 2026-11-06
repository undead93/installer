// Penghantar WhatsApp untuk CCTV Kenal Orang, guna Baileys (WhatsApp Web).
// Dijalankan sendiri oleh cctv_kenal.py, atau secara manual: node server.mjs
//
// API (hanya dari komputer ini, 127.0.0.1):
//   GET  /status    -> { status, nombor, qr }   qr = gambar QR (data URL) semasa perlu diimbas
//   GET  /kumpulan  -> senarai kumpulan WhatsApp { id, nama }
//   POST /hantar    { ke: ["0123456789", "1203...@g.us"], teks, gambar?: base64 JPEG }
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.WA_PORT || 3001)
const AUTH = fileURLToPath(new URL('./auth/', import.meta.url))
const KERING = process.env.WA_KERING === '1'   // ujian: cetak mesej, tidak hantar

let sock = null
let status = 'memulakan'   // memulakan | imbas_qr | bersambung | terputus
let qr = null
let nombor = null
let cubaan = 0

const log = (...a) => console.log('[whatsapp]', ...a)

async function mula () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}
  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('CCTV Kenal Orang'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      qr = u.qr
      status = 'imbas_qr'
      console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }))
      log('Imbas QR di atas dengan WhatsApp: Tetapan > Peranti Dipautkan > Pautkan Peranti')
      log('(QR juga dipaparkan dalam page web, tab "Orang berdaftar")')
    }
    if (u.connection === 'open') {
      status = 'bersambung'
      qr = null
      cubaan = 0
      nombor = (sock.user?.id || '').split(':')[0].split('@')[0]
      log(`Bersambung sebagai +${nombor}`)
    }
    if (u.connection === 'close') {
      const kod = u.lastDisconnect?.error?.output?.statusCode
      if (kod === DisconnectReason.loggedOut) {
        log('Telah log keluar dari telefon. Sesi dipadam, QR baru akan dipaparkan.')
        fs.rmSync(AUTH, { recursive: true, force: true })
      } else {
        log(`Terputus (kod ${kod ?? '-'}), sambung semula...`)
      }
      status = 'terputus'
      nombor = null
      cubaan++
      setTimeout(mula, Math.min(30000, 1000 * 2 ** Math.min(cubaan, 5)))
    }
  })
}

function jid (ke) {
  ke = String(ke).trim()
  if (ke.includes('@')) return ke                // contoh kumpulan: 120363012345678901@g.us
  let n = ke.replace(/\D/g, '')
  if (n.startsWith('0')) n = '6' + n             // 0123456789 -> 60123456789 (Malaysia)
  return n + '@s.whatsapp.net'
}

async function hantar ({ ke = [], teks = '', gambar = null }) {
  const ralat = []
  const img = gambar ? Buffer.from(gambar, 'base64') : null
  for (const k of ke) {
    try {
      if (KERING) {
        log(`[KERING] ke ${jid(k)}: ${teks.replace(/\n/g, ' | ')}${img ? ` (+gambar ${img.length} bait)` : ''}`)
        continue
      }
      if (status !== 'bersambung') throw new Error('WhatsApp belum bersambung (imbas QR dahulu)')
      await sock.sendMessage(jid(k), img ? { image: img, caption: teks } : { text: teks })
      await new Promise(r => setTimeout(r, 700))  // jarakkan mesej
    } catch (e) {
      ralat.push(`${k}: ${e.message}`)
    }
  }
  return ralat
}

function json (res, kod, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length })
  res.end(b)
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, {
        status: KERING ? 'bersambung' : status,
        nombor: KERING ? 'ujian' : nombor,
        qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 280 }) : null,
      })
    }
    if (req.method === 'GET' && req.url === '/kumpulan') {
      if (status !== 'bersambung') return json(res, 409, { ralat: 'WhatsApp belum bersambung' })
      const g = await sock.groupFetchAllParticipating()
      return json(res, 200, Object.values(g).map(x => ({ id: x.id, nama: x.subject })))
    }
    if (req.method === 'POST' && req.url === '/hantar') {
      let badan = ''
      for await (const c of req) badan += c
      const ralat = await hantar(JSON.parse(badan || '{}'))
      return json(res, ralat.length ? 502 : 200, { ok: !ralat.length, ralat })
    }
    json(res, 404, { ralat: 'tiada' })
  } catch (e) {
    json(res, 500, { ralat: e.message })
  }
}).listen(PORT, '127.0.0.1', () => log(`API di http://127.0.0.1:${PORT}${KERING ? ' (mod ujian KERING)' : ''}`))

if (KERING) status = 'bersambung'
else mula().catch(e => { log('Gagal mula:', e.message); process.exit(1) })
