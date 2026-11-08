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
import { convertTo60, probe } from './video.js'

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

const HELP = `🤖 *Bot TikTok*

*Cara post:*
📎 Hantar video sebagai *Document* (bukan Gallery) + tulis caption → bot terus post.

*Arahan:*
• !login – sambung akaun TikTok
• !kod <link> – paste link selepas login
• !status – tengok status bot & akaun
• !mod direct | draft – terus post / hantar ke inbox TikTok
• !privasi public | friends | followers | private
• !logout – putuskan akaun TikTok
• !bantuan – mesej ini`

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
let pairingRequested = false

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.waAuthDir)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false,
    syncFullHistory: false,
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
      log(`✅ WhatsApp bersambung sebagai ${sock.user?.id}`)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        log(`❌ WhatsApp log keluar. Padam folder ${config.waAuthDir} dan jalankan semula untuk link semula.`)
        process.exit(1)
      }
      log(`⚠️ Sambungan terputus (kod ${code ?? '-'}), sambung semula dalam 3 saat...`)
      setTimeout(() => start().catch((e) => log('Gagal sambung semula:', e)), 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg)
      } catch (e) {
        log('Ralat proses mesej:', e)
      }
    }
  })
}

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid
  if (!msg.message || msg.key.fromMe || !jid || isJidGroup(jid) || jid === 'status@broadcast') return

  if (!isAllowed(msg.key)) {
    if (!warnedJids.has(jid)) {
      warnedJids.add(jid)
      log(`🚫 Mesej daripada ${senderNumbers(msg.key).join(' / ')} diabaikan. Kalau ini anda, tambah nombor ini dalam ALLOWED_NUMBERS.`)
    }
    return
  }

  const content = normalizeMessageContent(msg.message)
  if (!content) return
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg })

  const doc = content.documentMessage
  const vid = content.videoMessage
  if (doc || vid) return handleVideo(sock, msg, { doc, vid, reply })

  const text = (content.conversation || content.extendedTextMessage?.text || '').trim()
  if (text.startsWith('!')) return handleCommand(text, reply)
}

// ---------- Arahan ----------
async function handleCommand(text, reply) {
  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.toLowerCase()
  const arg = rest.join(' ').trim()
  const settings = getSettings()

  const needsTikTok = ['!login', '!kod', '!code']
  const missing = missingTikTokConfig()
  if (needsTikTok.includes(cmd) && missing.length) {
    return reply(`❌ Key TikTok belum diisi dalam .env di VPS: ${missing.join(', ')}\nIsi, kemudian jalankan: pm2 restart tiktok-wa-bot`)
  }

  switch (cmd) {
    case '!bantuan':
    case '!help':
    case '!menu':
      return reply(HELP)

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

    case '!status': {
      const token = getTokenInfo()
      const lines = [
        `Mod: *${settings.mode}* ${settings.mode === 'direct' ? '(terus post)' : '(hantar ke inbox TikTok)'}`,
        `Privasi: *${settings.privacy}*`,
        `Auto tukar 60fps: ${config.video.autoConvert60 ? 'ON' : 'OFF'}`,
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
      clearToken()
      return reply('✅ Akaun TikTok diputuskan. Taip !login untuk sambung semula.')

    default:
      return reply('Arahan tak dikenali. Taip !bantuan')
  }
}

// ---------- Video ----------
async function handleVideo(sock, msg, { doc, vid, reply }) {
  const media = doc || vid
  const fileName = doc?.fileName || 'video.mp4'
  const isVideo = vid || doc.mimetype?.startsWith('video/') || VIDEO_EXT.test(fileName)
  if (!isVideo) return reply('❌ Document ni bukan video. Hantar fail .mp4 / .mov / .webm.')

  const size = Number(media.fileLength || 0)
  if (size > MAX_SIZE) return reply('❌ Fail lebih 4GB, TikTok tak terima.')

  const caption = (media.caption || '').trim()
  const settings = getSettings()

  if (missingTikTokConfig().length) return reply('❌ Key TikTok belum diisi dalam .env di VPS. Isi dulu, kemudian !login.')
  const token = getTokenInfo()
  const needScope = settings.mode === 'draft' ? 'video.upload' : 'video.publish'
  if (!token) return reply('❌ Belum login TikTok. Taip !login dulu.')
  if (!token.scope?.includes(needScope)) return reply(`❌ Login TikTok tiada scope ${needScope}. Taip !login semula.`)

  const position = enqueue(() => processVideo(sock, msg, { media, fileName, caption, settings, isDoc: !!doc, reply }))
  if (position > 1) await reply(`⏳ Dalam giliran (#${position}).`)
}

async function processVideo(sock, msg, { media, fileName, caption, settings, isDoc, reply }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ext = path.extname(fileName) || '.mp4'
  const original = path.join(config.downloadDir, `${id}${ext}`)
  const converted = path.join(config.downloadDir, `${id}-60fps.mp4`)
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
      log(`Video ${id}: ${info.width}x${info.height} ${info.fps}fps ${info.codec} ${info.duration.toFixed(1)}s`)
      if (info.fps > 60) {
        if (config.video.autoConvert60) {
          await reply(`🎞️ Video ${info.fps}fps. TikTok maks 60fps, jadi bot tukar ke 60fps kualiti tinggi dulu...`)
          uploadPath = await convertTo60(original, converted)
        } else {
          await reply(`⚠️ Video ${info.fps}fps. TikTok maks 60fps, mungkin ditolak.`)
        }
      }
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
      if (caption) await sock.sendMessage(msg.key.remoteJid, { text: caption })
    } else if (result.status === 'FAILED') {
      await reply(`❌ TikTok gagal proses video: ${result.fail_reason || 'sebab tak diketahui'}`)
    } else {
      await reply(`⌛ TikTok masih proses (status: ${result.status}). Semak dalam app TikTok sekejap lagi.`)
    }
  } catch (e) {
    log(`Ralat video ${id}:`, e.message, e.details ? JSON.stringify(e.details) : '')
    await reply(`❌ ${e instanceof TikTokError ? e.message : `Ralat: ${e.message}`}${hintFor(e)}`)
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
