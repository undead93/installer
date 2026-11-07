// Penghantar WhatsApp untuk CCTV Rumah, guna Baileys (WhatsApp Web).
// Dijalankan sendiri oleh cctv_kenal.py, atau secara manual: node server.mjs
//
// API (hanya dari komputer ini, 127.0.0.1):
//   GET  /status    -> { status, nombor, qr }   qr = gambar QR (data URL) semasa perlu diimbas
//   GET  /kumpulan  -> senarai kumpulan WhatsApp { id, nama }
//   POST /hantar    { ke: ["0123456789", "1203...@g.us"], teks, gambar?: base64 JPEG, video?: base64 MP4 }
//   POST /panggil-balik { url }   ke mana mesej WhatsApp masuk dihantar (cctv_kenal.py /api/wa-masuk)
//   POST /uji-masuk { chat, dari, teks }   ujian: proses mesej masuk tiruan
//
// Bot: mesej yang masuk ke nombor ini dihantar ke cctv_kenal.py, yang menentukan sama ada pengirim dibenarkan
// dan apa balasannya (cth "siapa", "log", "gambar").
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
let PY = process.env.WA_PY || null   // URL cctv_kenal.py untuk mesej masuk

const log = (...a) => console.log('[whatsapp]', ...a)

async function mula () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}
  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('CCTV Rumah'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        const ts = Number(m.messageTimestamp || 0)
        if (ts && Date.now() / 1000 - ts > 120) continue          // abaikan mesej lama (semasa offline)
        const isi = m.message.ephemeralMessage?.message || m.message
        const teks = isi.conversation || isi.extendedTextMessage?.text || isi.imageMessage?.caption || ''
        if (!teks.trim()) continue
        const chat = m.key.remoteJid
        // nombor pengirim: WhatsApp kini kadang-kadang guna ID @lid; nombor sebenar dalam medan *Alt / *Pn
        const dari = [m.key.remoteJid, m.key.remoteJidAlt, m.key.participant, m.key.participantAlt,
                      m.key.senderPn, m.key.participantPn, m.participant].filter(Boolean)
        await prosesMasuk({ chat, dari, teks, kumpulan: String(chat).endsWith('@g.us') }, m)
      } catch (e) {
        log('Gagal proses mesej masuk:', e.message)
      }
    }
  })
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

async function prosesMasuk (d, asal) {
  if (!PY) return
  const r = await fetch(PY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
  if (!r.ok) return
  const { balas = [] } = await r.json()
  for (const b of balas) {
    if (KERING) {
      log(`[KERING] balas ke ${d.chat}: ${(b.teks || '').replace(/\n/g, ' | ')}${b.gambar ? ' (+gambar)' : ''}`)
      continue
    }
    const mesej = b.gambar ? { image: Buffer.from(b.gambar, 'base64'), caption: b.teks || '' } : { text: b.teks }
    await sock.sendMessage(d.chat, mesej, asal ? { quoted: asal } : {})
  }
}

function jid (ke) {
  ke = String(ke).trim()
  if (ke.includes('@')) return ke                // contoh kumpulan: 120363012345678901@g.us
  let n = ke.replace(/\D/g, '')
  if (n.startsWith('0')) n = '6' + n             // 0123456789 -> 60123456789 (Malaysia)
  return n + '@s.whatsapp.net'
}

async function hantar ({ ke = [], teks = '', gambar = null, video = null }) {
  const ralat = []
  const img = gambar ? Buffer.from(gambar, 'base64') : null
  const vid = video ? Buffer.from(video, 'base64') : null
  for (const k of ke) {
    try {
      if (KERING) {
        log(`[KERING] ke ${jid(k)}: ${teks.replace(/\n/g, ' | ')}${img ? ` (+gambar ${img.length} bait)` : ''}${vid ? ` (+video ${vid.length} bait)` : ''}`)
        continue
      }
      if (status !== 'bersambung') throw new Error('WhatsApp belum bersambung (imbas QR dahulu)')
      const mesej = vid ? { video: vid, caption: teks, mimetype: 'video/mp4' }
        : img ? { image: img, caption: teks } : { text: teks }
      await sock.sendMessage(jid(k), mesej)
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
    if (req.method === 'POST' && (req.url === '/panggil-balik' || req.url === '/uji-masuk')) {
      const bahagian = []
      for await (const c of req) bahagian.push(c)
      const d = JSON.parse(Buffer.concat(bahagian).toString() || '{}')
      if (req.url === '/panggil-balik') {
        PY = d.url || null
        return json(res, 200, { ok: true })
      }
      await prosesMasuk(d, null)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/hantar') {
      const bahagian = []
      for await (const c of req) bahagian.push(c)
      const ralat = await hantar(JSON.parse(Buffer.concat(bahagian).toString() || '{}'))
      return json(res, ralat.length ? 502 : 200, { ok: !ralat.length, ralat })
    }
    json(res, 404, { ralat: 'tiada' })
  } catch (e) {
    json(res, 500, { ralat: e.message })
  }
}).listen(PORT, '127.0.0.1', () => log(`API di http://127.0.0.1:${PORT}${KERING ? ' (mod ujian KERING)' : ''}`))

if (KERING) status = 'bersambung'
else mula().catch(e => { log('Gagal mula:', e.message); process.exit(1) })
