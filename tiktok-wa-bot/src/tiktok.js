// Klien ringkas untuk TikTok Login Kit (OAuth v2) + Content Posting API
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { config } from './config.js'
import { readJson, writeJson } from './store.js'

const API = 'https://open.tiktokapis.com'
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TOKEN_FILE = 'tiktok-token.json'

const MB = 1024 * 1024
const SINGLE_UPLOAD_MAX = 64 * MB // fail <= 64MB dihantar sekali gus
const CHUNK_SIZE = 20 * MB // 5MB–64MB dibenarkan; chunk terakhir boleh lebih besar

export const PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]

export class TikTokError extends Error {
  constructor(message, details) {
    super(message)
    this.details = details
  }
}

function scopesFor(mode) {
  return ['user.info.basic', mode === 'draft' ? 'video.upload' : 'video.publish']
}

// ---------- OAuth ----------

let pendingState = null

export function buildAuthUrl(mode) {
  pendingState = crypto.randomBytes(16).toString('hex')
  const params = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    response_type: 'code',
    scope: scopesFor(mode).join(','),
    redirect_uri: config.tiktok.redirectUri,
    state: pendingState,
  })
  return `${AUTH_URL}?${params}`
}

/** Terima URL penuh selepas redirect (atau kod sahaja) dan tukar kepada token. */
export async function exchangeCode(input) {
  let code = input.trim()
  if (/^https?:\/\//i.test(code)) {
    const url = new URL(code)
    if (url.searchParams.get('error')) {
      throw new TikTokError(
        `TikTok tolak login: ${url.searchParams.get('error')} ${url.searchParams.get('error_description') || ''}`.trim(),
      )
    }
    const state = url.searchParams.get('state')
    if (pendingState && state && state !== pendingState) {
      throw new TikTokError('State tak sama. Taip !login sekali lagi dan guna link yang baru.')
    }
    code = url.searchParams.get('code') || ''
  } else {
    code = decodeURIComponent(code)
  }
  if (!code) throw new TikTokError('Tiada "code" dalam link tu.')

  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.tiktok.redirectUri,
  })
  pendingState = null
  return token
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      ...params,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.error || !json.access_token) {
    throw new TikTokError(
      `Gagal dapat token: ${json.error_description || json.error || res.status}`,
      json,
    )
  }
  const now = Date.now()
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    open_id: json.open_id,
    scope: json.scope,
    expires_at: now + json.expires_in * 1000,
    refresh_expires_at: now + json.refresh_expires_in * 1000,
  }
  writeJson(TOKEN_FILE, token)
  return token
}

export function getTokenInfo() {
  return readJson(TOKEN_FILE, null)
}

export function clearToken() {
  writeJson(TOKEN_FILE, null)
}

async function getAccessToken() {
  const token = getTokenInfo()
  if (!token) throw new TikTokError('Belum login TikTok. Taip !login dulu.')
  if (Date.now() < token.expires_at - 5 * 60 * 1000) return token.access_token
  if (Date.now() >= token.refresh_expires_at) {
    throw new TikTokError('Login TikTok dah tamat tempoh. Taip !login sekali lagi.')
  }
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token })
  return fresh.access_token
}

// ---------- API helper ----------

async function api(path, body) {
  const accessToken = await getAccessToken()
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json().catch(() => ({}))
  const err = json.error
  if (!res.ok || (err && err.code && err.code !== 'ok')) {
    throw new TikTokError(
      `TikTok API ralat (${err?.code || res.status}): ${err?.message || 'tiada mesej'}`,
      json,
    )
  }
  return json.data
}

export async function getUserInfo() {
  const accessToken = await getAccessToken()
  const res = await fetch(`${API}/v2/user/info/?fields=open_id,display_name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await res.json().catch(() => ({}))
  return json?.data?.user || null
}

export function queryCreatorInfo() {
  return api('/v2/post/publish/creator_info/query/', {})
}

// ---------- Upload ----------

function planChunks(size) {
  if (size <= SINGLE_UPLOAD_MAX) return { chunkSize: size, count: 1 }
  // Chunk terakhir menyerap baki (maks ~2x CHUNK_SIZE, bawah had 128MB)
  return { chunkSize: CHUNK_SIZE, count: Math.floor(size / CHUNK_SIZE) }
}

function mimeFor(filePath) {
  if (/\.mov$/i.test(filePath)) return 'video/quicktime'
  if (/\.webm$/i.test(filePath)) return 'video/webm'
  return 'video/mp4'
}

async function uploadFile(uploadUrl, filePath, size, plan, onProgress) {
  const fh = await fs.open(filePath, 'r')
  try {
    for (let i = 0; i < plan.count; i++) {
      const start = i * plan.chunkSize
      const end = i === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1
      const length = end - start + 1
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, start)

      let attempt = 0
      for (;;) {
        try {
          const res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': mimeFor(filePath),
              'Content-Length': String(length),
              'Content-Range': `bytes ${start}-${end}/${size}`,
            },
            body: buf,
          })
          if (![200, 201, 206].includes(res.status)) {
            const text = await res.text().catch(() => '')
            throw new TikTokError(`Upload chunk ${i + 1}/${plan.count} gagal (HTTP ${res.status}) ${text}`.trim())
          }
          break
        } catch (e) {
          if (++attempt >= 3) throw e
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      onProgress?.(i + 1, plan.count)
    }
  } finally {
    await fh.close()
  }
}

/**
 * Upload video ke TikTok.
 * mode "direct": terus post dengan caption & privasi.
 * mode "draft":  hantar ke inbox TikTok; anda sambung & tekan Post dalam app.
 */
export async function publishVideo({ filePath, caption, mode, privacy, onProgress }) {
  const { size } = await fs.stat(filePath)
  const plan = planChunks(size)
  const source_info = {
    source: 'FILE_UPLOAD',
    video_size: size,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.count,
  }

  let init
  if (mode === 'draft') {
    init = await api('/v2/post/publish/inbox/video/init/', { source_info })
  } else {
    init = await api('/v2/post/publish/video/init/', {
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info,
    })
  }

  await uploadFile(init.upload_url, filePath, size, plan, onProgress)
  return init.publish_id
}

/** Tunggu sampai TikTok habis proses. Pulangkan status akhir. */
export async function waitForPublish(publishId, { timeoutMs = 15 * 60 * 1000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await api('/v2/post/publish/status/fetch/', { publish_id: publishId })
    if (['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(last?.status)) return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { ...last, status: last?.status || 'TIMEOUT', timedOut: true }
}
