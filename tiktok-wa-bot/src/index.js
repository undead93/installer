// Bot WhatsApp -> TikTok
// Hantar video sebagai DOCUMENT + caption ke nombor bot, bot terus post ke TikTok.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isJidGroup,
  jidDecode,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { checkConfig, config, missingTikTokConfig } from './config.js'
import { getSettings, updateSettings } from './store.js'
import {
  PRIVACY_LEVELS,
  TikTokError,
  buildAuthUrl,
  clearToken,
  exchangeCode,
  getTokenInfo,
  getUserInfo,
  publishVideo,
  queryCreatorInfo,
  waitForPublish,
} from './tiktok.js'
import { WebUploadError, checkLogin, clearCookies, hasCookies, loginWithQr, saveCookies, uploadVideo } from './tiktok-web.js'
import { describe, optimize, plan, probe } from './video.js'

checkConfig()
fs.mkdirSync(config.downloadDir, { recursive: true })

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' })
const log = (...a) => console.log(new Date().toISOString(), ...a)

const MAX_SIZE = 4 * 1024 * 1024 * 1024 // had TikTok: 4GB
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i

const PRIVACY_ALIASES = {
  public: 'PUBLIC_TO_EVERYONE',
  umum: 'PUBLIC_TO_EVERYONE',
  friends: 'MUTUAL_FOLLOW_FRIENDS',
  kawan: 'MUTUAL_FOLLOW_FRIENDS',
  followers: 'FOLLOWER_OF_CREATOR',
  follower: 'FOLLOWER_OF_CREATOR',
  private: 'SELF_ONLY',
  sendiri: 'SELF_ONLY',
  self: 'SELF_ONLY',
}

const HELP_HEAD = `🤖 *Bot TikTok*

*Cara post:*
📎 Hantar video sebagai *Document* (bukan Gallery) + tulis caption → bot terus post.

*Arahan:*`

const HELP_WEB = `${HELP_HEAD}
• !loginqr – login TikTok guna QR code (disyorkan)
• !sessionid <nilai> – login TikTok guna cookie sessionid
• !cookies <JSON> – login guna JSON dari Cookie-Editor (atau hantar fail .json dengan caption !cookies)
• !semak – semak login TikTok (bot hantar screenshot)
• !status – tengok status bot
• !logout – padam login TikTok dari bot
• !bantuan – mesej ini`

const HELP_API = `${HELP_HEAD}
• !login – sambung akaun TikTok
• !kod <link> – paste link selepas login
• !status – tengok status bot & akaun
• !mod direct | draft – terus post / hantar ke inbox TikTok
• !privasi public | friends | followers | private
• !logout – putuskan akaun TikTok
• !bantuan – mesej ini`

const HELP = config.method === 'web' ? HELP_WEB : HELP_API

// ---------- Awalan arahan & trigger ----------
const P = config.prefix
const needsSpace = (word) => /[a-z0-9]$/i.test(word)

/** Tukar teks pengguna kepada bentuk dalaman "!arahan ...", atau null kalau bukan arahan bot ni. */
function parseCommand(text) {
  if (!text.toLowerCase().startsWith(P.toLowerCase())) return null
  let rest = text.slice(P.length)
  if (needsSpace(P)) {
    if (!/^\s/.test(rest)) return null
    rest = rest.trimStart()
  }
  return rest ? `!${rest}` : null
}

/** Tunjuk arahan dalam mesej balasan ikut awalan yang dipilih. */
function fmt(text) {
  if (P === '!') return text
  return text.replace(/!(?=[a-z])/g, needsSpace(P) ? `${P} ` : P)
}

/** Pulangkan caption tanpa trigger, atau null kalau trigger diperlukan tapi tiada. */
function stripTrigger(caption) {
  const t = config.videoTrigger
  if (!t) return caption
  if (!caption.toLowerCase().startsWith(t.toLowerCase())) return null
  const rest = caption.slice(t.length)
  if (needsSpace(t) && rest && !/^\s/.test(rest)) return null
  return rest.trim()
}

// ID mesej yang dihantar oleh bot sendiri (supaya bot tak proses balasannya sendiri dalam mod SELF_CHAT)
const botSent = new Set()
function rememberSent(id) {
  botSent.add(id)
  if (botSent.size > 500) botSent.delete(botSent.values().next().value)
}

function isSelfChat(sock, jid) {
  const target = jidDecode(jid)?.user
  return [sock.user?.id, sock.user?.lid].filter(Boolean).some((j) => jidDecode(j)?.user === target)
}
const API_ONLY = ['!login', '!kod', '!code', '!mod', '!mode', '!privasi', '!privacy']
const WEB_ONLY = ['!sessionid', '!cookies', '!semak', '!loginqr']

// ---------- Giliran (satu upload pada satu masa) ----------
let queue = Promise.resolve()
let queued = 0
function enqueue(task) {
  queued++
  const position = queued
  queue = queue
    .then(task)
    .catch((e) => log('Ralat dalam giliran:', e))
    .finally(() => queued--)
  return position
}

let qrLoginRunning = false

// ---------- Kebenaran ----------
const warnedJids = new Set()
function senderNumbers(key) {
  return [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participant, key.participantAlt]
    .filter(Boolean)
    .map((j) => jidDecode(j)?.user)
    .filter(Boolean)
}
function isAllowed(key) {
  return senderNumbers(key).some((n) => config.allowedNumbers.includes(n))
}

// ---------- WhatsApp ----------
let loggedOutCount = 0

async function start() {
  let pairingRequested = false // setiap sambungan baru minta kod baru
  const { state, saveCreds } = await useMultiFileAuthState(config.waAuthDir)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Bot tak perlukan profil/privacy/blocklist; elak ralat "Timed Out" dalam 'init queries'
    fireInitQueries: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (config.pairingNumber && !state.creds.registered) {
        if (!pairingRequested) {
          pairingRequested = true
          try {
            const code = await sock.requestPairingCode(config.pairingNumber)
            log(`🔑 PAIRING CODE: ${code}`)
            log('Dalam telefon BOT: WhatsApp → Linked devices → Link a device → Link with phone number instead → masukkan kod di atas.')
          } catch (e) {
            pairingRequested = false
            log('Gagal minta pairing code:', e.message)
          }
        }
      } else {
        log('📱 Scan QR ini guna WhatsApp telefon BOT (Linked devices → Link a device):')
        qrcode.generate(qr, { small: true })
      }
    }
    if (connection === 'open') {
      loggedOutCount = 0
      log(`✅ WhatsApp bersambung sebagai ${sock.user?.id}`)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.connectionReplaced) {
        log('❌ Sesi WhatsApp ni sedang digunakan oleh bot lain (kod 440).')
        log('   Biasanya sebab bot berjalan DUA kali, cth pm2 + npm start serentak. Jalankan "pm2 stop tiktok-wa-bot" atau tutup yang satu lagi.')
        process.exit(1)
      }
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
        loggedOutCount++
        if (loggedOutCount > 3) {
          log('❌ WhatsApp asyik log keluar. Pastikan bot tak berjalan dua kali (pm2 list) dan nombor dalam WA_PAIRING_NUMBER betul, kemudian jalankan semula.')
          process.exit(1)
        }
        log(`⚠️ WhatsApp log keluar (kod ${code}). Sesi lama dipadam, bot akan minta pairing code / QR baru...`)
        fs.rmSync(config.waAuthDir, { recursive: true, force: true })
        setTimeout(() => start().catch((e) => log('Gagal mula semula:', e)), 3000)
        return
      }
      log(`⚠️ Sambungan terputus (kod ${code ?? '-'}), sambung semula dalam 3 saat...`)
      setTimeout(() => start().catch((e) => log('Gagal sambung semula:', e)), 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && !config.selfChat) return
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg, type)
      } catch (e) {
        log('Ralat proses mesej:', e)
      }
    }
  })
}

async function handleMessage(sock, msg, type) {
  const jid = msg.key.remoteJid
  if (!msg.message || !jid || isJidGroup(jid) || jid === 'status@broadcast') return
  if (botSent.has(msg.key.id)) return

  if (config.selfChat) {
    // Hanya proses mesej yang ANDA hantar dalam chat "Message yourself"
    if (!msg.key.fromMe || !isSelfChat(sock, jid)) return
    const ts = Number(msg.messageTimestamp || 0)
    if (ts && Date.now() / 1000 - ts > 120) return // abaikan mesej lama
  } else {
    if (msg.key.fromMe || type !== 'notify') return
    if (!isAllowed(msg.key)) {
      if (!warnedJids.has(jid)) {
        warnedJids.add(jid)
        log(`🚫 Mesej daripada ${senderNumbers(msg.key).join(' / ')} diabaikan. Kalau ini anda, tambah nombor ini dalam ALLOWED_NUMBERS.`)
      }
      return
    }
  }

  const content = normalizeMessageContent(msg.message)
  if (!content) return
  const send = (body, opts = {}) => {
    const messageId = generateMessageIDV2(sock.user?.id)
    rememberSent(messageId)
    return sock.sendMessage(jid, body, { ...opts, messageId })
  }
  const reply = (text) => send({ text: fmt(text) }, { quoted: msg })
  const sendShot = async (file, caption) => {
    if (!file || !fs.existsSync(file)) return
    await send({ image: fs.readFileSync(file), caption })
    fs.rm(file, { force: true }, () => {})
  }

  const doc = content.documentMessage
  const vid = content.videoMessage

  // Fail cookies (.json/.txt) dengan caption !cookies
  if (doc && /^!cookies\b/i.test(parseCommand((doc.caption || '').trim()) || '')) {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
      const n = saveCookies(buf.toString('utf8'))
      return reply(`✅ ${n} cookies disimpan. Taip !semak untuk pastikan login berjaya.`)
    } catch (e) {
      return reply(`❌ ${e.message}`)
    }
  }

  if (doc || vid) return handleVideo(sock, msg, { doc, vid, reply, sendShot, send })

  const text = (content.conversation || content.extendedTextMessage?.text || '').trim()
  const command = parseCommand(text)
  if (command) return handleCommand(command, reply, sendShot)
}

// ---------- Arahan ----------
async function handleCommand(text, reply, sendShot) {
  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.toLowerCase()
  const arg = rest.join(' ').trim()
  const settings = getSettings()

  if (config.method === 'web' && API_ONLY.includes(cmd)) {
    return reply('Arahan ini hanya untuk kaedah API. Bot sekarang guna kaedah *web*: taip !bantuan.')
  }
  if (config.method === 'api' && WEB_ONLY.includes(cmd)) {
    return reply('Arahan ini hanya untuk kaedah web (TIKTOK_METHOD=web). Taip !bantuan.')
  }

  const needsTikTok = ['!login', '!kod', '!code']
  const missing = missingTikTokConfig()
  if (needsTikTok.includes(cmd) && missing.length) {
    return reply(`❌ Key TikTok belum diisi dalam .env di VPS: ${missing.join(', ')}\nIsi, kemudian jalankan: pm2 restart tiktok-wa-bot`)
  }

  switch (cmd) {
    case '!bantuan':
    case '!help':
    case '!menu':
      return reply(HELP + (config.videoTrigger ? `\n\n📝 Caption video mesti bermula dengan: *${config.videoTrigger}*` : ''))

    case '!login': {
      const url = buildAuthUrl(settings.mode)
      await reply(
        `1️⃣ Buka link ini & login TikTok, tekan *Authorize*:\n${url}\n\n` +
          `2️⃣ Lepas tu browser akan pergi ke page redirect (tak apa kalau page tu kosong/error).\n` +
          `3️⃣ *Copy link penuh* dari address bar, kemudian hantar:\n!kod <link tadi>`,
      )
      return
    }

    case '!kod':
    case '!code': {
      if (!arg) return reply('Guna: !kod <link penuh selepas login>')
      try {
        const token = await exchangeCode(arg)
        const user = await getUserInfo().catch(() => null)
        return reply(`✅ TikTok bersambung${user?.display_name ? ` sebagai *${user.display_name}*` : ''}.\nScope: ${token.scope}\n\nSekarang hantar video sebagai Document + caption.`)
      } catch (e) {
        return reply(`❌ ${e.message}`)
      }
    }

    case '!sessionid':
    case '!cookies': {
      if (!arg) {
        return reply(
          cmd === '!sessionid'
            ? 'Guna: !sessionid <nilai cookie sessionid dari tiktok.com>'
            : 'Guna: !cookies <JSON dari Cookie-Editor>  atau hantar fail .json sebagai Document dengan caption !cookies',
        )
      }
      try {
        const n = saveCookies(arg)
        return reply(`✅ ${n} cookies disimpan.\n🔒 Padam mesej anda tadi (Delete for everyone) sebab ia macam password.\nTaip !semak untuk pastikan login berjaya.`)
      } catch (e) {
        return reply(`❌ ${e.message}`)
      }
    }

    case '!loginqr': {
      if (qrLoginRunning) return reply('⏳ QR login sedang berjalan. Scan QR yang bot hantar tadi (atau tunggu ia tamat, kemudian cuba lagi).')
      qrLoginRunning = true
      const position = enqueue(async () => {
        try {
          const res = await loginWithQr({
            onQr: (file) =>
              sendShot(
                file,
                '📱 Scan QR ini guna app TikTok (ada ~3 minit):\n\n' +
                  '*Cara 1 (paling senang):* buka WhatsApp ni di PC (web.whatsapp.com), kemudian scan QR di skrin PC guna app TikTok.\n\n' +
                  '*Cara 2 (telefon sahaja):*\n' +
                  '1. Tekan gambar ni → Save (simpan ke Photos)\n' +
                  '2. App TikTok → tekan 🔍 Search → ikon scan di sebelah kanan kotak search\n' +
                  '3. Tekan *Photos/Album* → pilih gambar QR ni\n' +
                  '4. Tekan *Confirm / Log in*',
              ),
            onStatus: (file, caption) => sendShot(file, caption),
          })
          await reply(`✅ Login TikTok berjaya${res.account ? ` (${res.account})` : ''}! Taip !semak untuk uji, kemudian hantar video.`)
        } catch (e) {
          await reply(`❌ ${e.message}`)
          await sendShot(e.screenshot, 'Screenshot semasa ralat')
        } finally {
          qrLoginRunning = false
        }
      })
      return reply(position > 1 ? `⏳ Dalam giliran (#${position}).` : '⏳ Sedang buka page login TikTok, tunggu QR code...')
    }

    case '!semak': {
      if (!hasCookies()) return reply('❌ Belum login. Taip !loginqr dulu.')
      const position = enqueue(async () => {
        try {
          const res = await checkLogin()
          await reply(res.ok ? `✅ Login TikTok OK (${res.info}), page upload dapat dibuka.` : `⚠️ Page upload dibuka tapi butang upload tak jumpa (${res.info}). Tengok screenshot.`)
          await sendShot(res.screenshot, 'Screenshot page upload TikTok')
        } catch (e) {
          await reply(`❌ ${e.message}`)
          await sendShot(e.screenshot, 'Screenshot semasa ralat')
        }
      })
      return reply(position > 1 ? `⏳ Dalam giliran (#${position}).` : '🔎 Sedang semak login TikTok...')
    }

    case '!status': {
      if (config.method === 'web') {
        return reply(
          [
            'Kaedah: *web* (upload melalui tiktok.com)',
            `TikTok: ${hasCookies() ? '✅ cookies ada (taip !semak untuk uji)' : '❌ belum login (taip !loginqr)'}`,
            `Optimumkan video (H.264 1080p SDR): ${config.video.optimize ? 'ON' : 'OFF'}`,
            `Video dalam giliran: ${queued}`,
          ].join('\n'),
        )
      }
      const token = getTokenInfo()
      const lines = [
        `Mod: *${settings.mode}* ${settings.mode === 'direct' ? '(terus post)' : '(hantar ke inbox TikTok)'}`,
        `Privasi: *${settings.privacy}*`,
        `Optimumkan video (H.264 1080p SDR): ${config.video.optimize ? 'ON' : 'OFF'}`,
      ]
      if (!token) {
        lines.push('TikTok: ❌ belum login (taip !login)')
      } else {
        const user = await getUserInfo().catch(() => null)
        lines.push(`TikTok: ✅ ${user?.display_name || token.open_id}`)
        lines.push(`Scope: ${token.scope}`)
        lines.push(`Login tamat: ${new Date(token.refresh_expires_at).toLocaleDateString('ms-MY')}`)
        if (settings.mode === 'direct') {
          const info = await queryCreatorInfo().catch(() => null)
          if (info) {
            lines.push(`Privasi dibenarkan: ${(info.privacy_level_options || []).join(', ')}`)
            lines.push(`Durasi maks: ${info.max_video_post_duration_sec}s`)
          }
        }
      }
      return reply(lines.join('\n'))
    }

    case '!mod':
    case '!mode': {
      const mode = arg.toLowerCase()
      if (!['direct', 'draft'].includes(mode)) return reply('Guna: !mod direct  atau  !mod draft')
      updateSettings({ mode })
      const need = mode === 'draft' ? 'video.upload' : 'video.publish'
      const token = getTokenInfo()
      const hint = token && !token.scope?.includes(need) ? `\n⚠️ Login sekarang tiada scope ${need}. Taip !login semula.` : ''
      return reply(`✅ Mod ditukar ke *${mode}*.${hint}`)
    }

    case '!privasi':
    case '!privacy': {
      const level = PRIVACY_ALIASES[arg.toLowerCase()] || arg.toUpperCase()
      if (!PRIVACY_LEVELS.includes(level)) return reply('Guna: !privasi public | friends | followers | private')
      updateSettings({ privacy: level })
      return reply(`✅ Privasi ditukar ke *${level}*.`)
    }

    case '!logout':
      if (config.method === 'web') {
        clearCookies()
        return reply('✅ Login TikTok dipadam dari bot. Hantar !sessionid untuk login semula.')
      }
      clearToken()
      return reply('✅ Akaun TikTok diputuskan. Taip !login untuk sambung semula.')

    default:
      return reply('Arahan tak dikenali. Taip !bantuan')
  }
}

// ---------- Video ----------
async function handleVideo(sock, msg, { doc, vid, reply, sendShot, send }) {
  const media = doc || vid
  if (stripTrigger((media.caption || '').trim()) === null) return // tiada trigger: bukan untuk bot ni
  const fileName = doc?.fileName || 'video.mp4'
  const isVideo = vid || doc.mimetype?.startsWith('video/') || VIDEO_EXT.test(fileName)
  if (!isVideo) return reply('❌ Document ni bukan video. Hantar fail .mp4 / .mov / .webm.')

  const size = Number(media.fileLength || 0)
  if (size > MAX_SIZE) return reply('❌ Fail lebih 4GB, TikTok tak terima.')

  const caption = stripTrigger((media.caption || '').trim())
  if (caption === null) return // tiada trigger: bukan untuk bot ni
  const settings = getSettings()

  if (config.method === 'web') {
    if (!hasCookies()) return reply('❌ Belum login TikTok. Taip !loginqr dulu.')
  } else {
    if (missingTikTokConfig().length) return reply('❌ Key TikTok belum diisi dalam .env di VPS. Isi dulu, kemudian !login.')
    const token = getTokenInfo()
    const needScope = settings.mode === 'draft' ? 'video.upload' : 'video.publish'
    if (!token) return reply('❌ Belum login TikTok. Taip !login dulu.')
    if (!token.scope?.includes(needScope)) return reply(`❌ Login TikTok tiada scope ${needScope}. Taip !login semula.`)
  }

  const position = enqueue(() => processVideo(sock, msg, { media, fileName, caption, settings, isDoc: !!doc, reply, sendShot, send }))
  if (position > 1) await reply(`⏳ Dalam giliran (#${position}).`)
}

async function processVideo(sock, msg, { media, fileName, caption, settings, isDoc, reply, sendShot, send }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ext = path.extname(fileName) || '.mp4'
  const original = path.join(config.downloadDir, `${id}${ext}`)
  const converted = path.join(config.downloadDir, `${id}-hd.mp4`)
  const sizeMb = (Number(media.fileLength || 0) / 1024 / 1024).toFixed(1)

  try {
    await reply(
      `📥 Terima video (${sizeMb} MB). Sedang muat turun...` +
        (isDoc ? '' : '\n⚠️ Video ni dihantar biasa (bukan Document), jadi WhatsApp dah compress. Untuk kualiti penuh, hantar sebagai *Document*.'),
    )

    const stream = await downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    await pipeline(stream, fs.createWriteStream(original))

    let uploadPath = original
    const info = await probe(original)
    if (info) {
      log(`Video ${id}: ${describe(info)} ${info.duration.toFixed(1)}s`)
      const p = plan(info)
      if (p.reencode || p.addAudio) {
        const what = [...p.reasons, ...(p.addAudio ? ['tambah trek audio senyap'] : [])]
        await reply(`🎞️ Fail asal: ${describe(info)}\nBot optimumkan dulu:\n• ${what.join('\n• ')}\n(boleh ambil beberapa minit)`)
        uploadPath = await optimize(original, converted, info, p)
        const out = await probe(uploadPath)
        await reply(`✅ Fail siap: ${describe(out)}`)
      } else {
        await reply(`🎞️ Fail: ${describe(info)}\nDah elok, dihantar tanpa diubah.`)
      }
    }

    if (config.method === 'web') {
      await reply('🚀 Bot sedang buka TikTok & upload video (boleh ambil beberapa minit)...')
      const res = await uploadVideo({ filePath: uploadPath, caption, onStage: (s) => log(`Web upload ${id}: ${s}`) })
      if (res.screenshot) fs.rm(res.screenshot, { force: true }, () => {})
      await reply('✅ *Dah post ke TikTok!* Semak dalam app TikTok (kadang-kadang ambil masa beberapa minit untuk keluar).')
      return
    }

    if (settings.mode === 'direct') {
      const creator = await queryCreatorInfo()
      const options = creator.privacy_level_options || []
      if (options.length && !options.includes(settings.privacy)) {
        return reply(`❌ Privasi ${settings.privacy} tak dibenarkan untuk akaun ini.\nPilihan: ${options.join(', ')}\nTukar guna !privasi`)
      }
      if (info?.duration && creator.max_video_post_duration_sec && info.duration > creator.max_video_post_duration_sec) {
        return reply(`❌ Video ${Math.round(info.duration)}s, had akaun anda ${creator.max_video_post_duration_sec}s.`)
      }
    }

    await reply(`🚀 Upload ke TikTok (${settings.mode === 'direct' ? `terus post, ${settings.privacy}` : 'ke inbox/draft'})...`)
    const publishId = await publishVideo({
      filePath: uploadPath,
      caption,
      mode: settings.mode,
      privacy: settings.privacy,
      onProgress: (done, total) => total > 1 && log(`Upload ${id}: ${done}/${total}`),
    })

    await reply('⏳ Upload siap. TikTok sedang proses video...')
    const result = await waitForPublish(publishId)

    if (result.status === 'PUBLISH_COMPLETE') {
      const postId = result.publicaly_available_post_id?.[0]
      await reply(`✅ *Dah post ke TikTok!*${postId ? `\nID video: ${postId}` : ''}${settings.privacy === 'SELF_ONLY' ? '\n(Privasi: Only me)' : ''}`)
    } else if (result.status === 'SEND_TO_USER_INBOX') {
      await reply('✅ Video dah masuk *inbox TikTok*. Buka app TikTok → notifikasi → sambung edit & tekan Post.\nCaption anda (copy di bawah):')
      if (caption) await send({ text: caption })
    } else if (result.status === 'FAILED') {
      await reply(`❌ TikTok gagal proses video: ${result.fail_reason || 'sebab tak diketahui'}`)
    } else {
      await reply(`⌛ TikTok masih proses (status: ${result.status}). Semak dalam app TikTok sekejap lagi.`)
    }
  } catch (e) {
    log(`Ralat video ${id}:`, e.message, e.details ? JSON.stringify(e.details) : '')
    const known = e instanceof TikTokError || e instanceof WebUploadError
    await reply(`❌ ${known ? e.message : `Ralat: ${e.message}`}${hintFor(e)}`)
    if (e instanceof WebUploadError) await sendShot(e.screenshot, 'Screenshot TikTok semasa ralat')
  } finally {
    for (const f of [original, converted]) fs.rm(f, { force: true }, () => {})
  }
}

function hintFor(e) {
  const code = `${e?.details?.error?.code || ''} ${e?.message || ''}`.toLowerCase()
  if (code.includes('unaudited')) {
    return '\n\n💡 App TikTok anda belum lulus audit, jadi hanya boleh post *private*. Guna `!privasi private`, atau `!mod draft` (post sendiri dari inbox), atau mohon audit di TikTok for Developers.'
  }
  if (code.includes('spam_risk') || code.includes('rate_limit')) {
    return '\n\n💡 TikTok hadkan bilangan post. Cuba lagi kemudian.'
  }
  if (code.includes('access_token') || code.includes('scope')) {
    return '\n\n💡 Cuba !login semula.'
  }
  return ''
}

start().catch((e) => {
  log('Gagal mula bot:', e)
  process.exit(1)
})
