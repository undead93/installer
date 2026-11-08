// Upload ke TikTok melalui laman web (tiktok.com) guna browser automatik (Playwright).
// BUKAN cara rasmi: TikTok boleh tukar design website bila-bila masa dan akaun boleh kena flag.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { config } from './config.js'
import { readJson, writeJson } from './store.js'

const COOKIE_FILE = 'tiktok-cookies.json'
const UPLOAD_URL = process.env.TIKTOK_UPLOAD_URL || 'https://www.tiktok.com/tiktokstudio/upload?from=webapp'
const ORIGIN = new URL(UPLOAD_URL).origin
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export class WebUploadError extends Error {
  constructor(message, screenshot) {
    super(message)
    this.screenshot = screenshot
  }
}

// ---------- Cookies ----------

const SAME_SITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' }

function toPlaywrightCookie(c) {
  const sameSite = SAME_SITE[String(c.sameSite || '').toLowerCase()] || 'Lax'
  const expires = c.expirationDate ?? c.expires
  return {
    name: c.name,
    value: String(c.value),
    domain: c.domain || '.tiktok.com',
    path: c.path || '/',
    expires: typeof expires === 'number' && expires > 0 ? Math.floor(expires) : -1,
    httpOnly: !!c.httpOnly,
    secure: sameSite === 'None' ? true : c.secure !== false,
    sameSite,
  }
}

function sessionCookies(sessionId) {
  // Cookie "sessionid" biasanya cukup untuk login; sid_tt & sessionid_ss biasanya nilai yang sama
  return ['sessionid', 'sessionid_ss', 'sid_tt'].map((name) =>
    toPlaywrightCookie({ name, value: sessionId, domain: '.tiktok.com', httpOnly: true, secure: true, sameSite: 'no_restriction' }),
  )
}

/**
 * Terima: JSON dari extension Cookie-Editor (array), atau {cookies:[...]}, atau nilai sessionid sahaja.
 * Pulangkan bilangan cookie yang disimpan.
 */
export function saveCookies(input) {
  // iPhone/WhatsApp kadang-kadang tukar " kepada “ ”
  const text = String(input || '').replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'").trim()
  if (!text) throw new WebUploadError('Kosong. Hantar nilai sessionid atau JSON cookies.')

  const pairs = text.split(';').map((p) => p.trim()).filter((p) => /^[^=\s]+=/.test(p))

  let cookies
  if (!text.startsWith('[') && !text.startsWith('{') && pairs.length >= 3) {
    // "Header String" dari Cookie-Editor: nama=nilai; nama2=nilai2; ...
    cookies = pairs
      .map((p) => {
        const i = p.indexOf('=')
        return { name: p.slice(0, i), value: p.slice(i + 1) }
      })
      .filter((c) => !['path', 'domain', 'expires', 'max-age', 'samesite'].includes(c.name.toLowerCase()))
      .map((c) => toPlaywrightCookie({ ...c, domain: '.tiktok.com', secure: true, sameSite: 'no_restriction' }))
    if (!cookies.some((c) => c.name === 'sessionid')) {
      throw new WebUploadError('Cookie "sessionid" tiada dalam teks tu. Pastikan anda dah login TikTok sebelum export.')
    }
  } else if (text.startsWith('[') || text.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WebUploadError('JSON cookies tak sah. Pastikan copy semua (Export → JSON dalam Cookie-Editor).')
    }
    const list = Array.isArray(parsed) ? parsed : parsed.cookies
    if (!Array.isArray(list)) throw new WebUploadError('Format cookies tak dikenali.')
    cookies = list.filter((c) => c?.name && c.value != null && String(c.domain || '.tiktok.com').includes('tiktok')).map(toPlaywrightCookie)
    if (!cookies.some((c) => c.name === 'sessionid')) {
      throw new WebUploadError('Cookie "sessionid" tiada dalam JSON tu. Pastikan anda dah login TikTok dalam browser sebelum export.')
    }
  } else {
    const value = text.replace(/^sessionid\s*[=:]\s*/i, '').replace(/;.*$/, '').trim()
    if (!/^[A-Za-z0-9%_-]{16,}$/.test(value)) throw new WebUploadError('Nilai sessionid nampak tak betul.')
    cookies = sessionCookies(value)
  }
  writeJson(COOKIE_FILE, cookies)
  return cookies.length
}

export function hasCookies() {
  const c = readJson(COOKIE_FILE, null)
  return Array.isArray(c) && c.length > 0
}

export function clearCookies() {
  writeJson(COOKIE_FILE, [])
}

// ---------- Browser ----------

async function withPage(fn, { useCookies = true, scale = 1 } = {}) {
  const cookies = useCookies ? readJson(COOKIE_FILE, []) : []
  if (useCookies && !cookies.length) throw new WebUploadError('Belum ada login TikTok. Taip !loginqr (disyorkan) atau hantar !cookies <JSON>.')

  const browser = await chromium.launch({
    headless: config.web.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  })
  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      deviceScaleFactor: scale,
      locale: 'en-US',
      timezoneId: config.web.timezone,
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    if (cookies.length) await context.addCookies(cookies)
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    try {
      return await fn(page)
    } catch (e) {
      const shot = await screenshot(page).catch(() => null)
      if (e instanceof WebUploadError) {
        e.screenshot ??= shot
        throw e
      }
      throw new WebUploadError(e.message.split('\n')[0], shot)
    } finally {
      // Simpan cookies terkini (TikTok kadang-kadang refresh session)
      const fresh = await context.cookies(ORIGIN).catch(() => [])
      if (fresh.some((c) => c.name === 'sessionid')) writeJson(COOKIE_FILE, fresh)
    }
  } finally {
    await browser.close()
  }
}

async function screenshot(page) {
  const file = path.join(config.downloadDir, `shot-${Date.now()}.png`)
  await page.screenshot({ path: file, timeout: 10_000 })
  return file
}

async function dismissCookieBanner(page) {
  const btn = page.getByRole('button', { name: /^(Decline optional cookies|Allow all|Tolak kuki pilihan|Benarkan semua)$/i }).first()
  if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) await btn.click().catch(() => {})
}

async function openUploadPage(page) {
  // Buka laman utama dulu supaya TikTok set cookie asas (ttwid, msToken) macam browser biasa
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {})
  await page.waitForTimeout(4000)
  await dismissCookieBanner(page)

  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(4000)
  await dismissCookieBanner(page)
  if (/\/login/.test(page.url())) {
    const onlySession = readJson(COOKIE_FILE, []).length <= 3
    throw new WebUploadError(
      onlySession
        ? 'TikTok tak terima sessionid sahaja. Cuba hantar SEMUA cookies: guna extension Cookie-Editor di tiktok.com → Export → JSON, kemudian hantar !cookies <JSON> (atau fail .json dengan caption !cookies).'
        : 'Login TikTok dah tamat / cookies tak sah. Login semula di browser, export cookies baru dan hantar !cookies <JSON>.',
    )
  }
  await failIfCaptcha(page)
}

async function failIfCaptcha(page) {
  const captcha = page.locator('#captcha-verify-container, .captcha_verify_container, [id*="captcha" i] iframe, .captcha-verify-container')
  if (await captcha.first().isVisible().catch(() => false)) {
    throw new WebUploadError('TikTok minta captcha. Login TikTok dalam browser biasa, selesaikan captcha di sana, kemudian cuba lagi (atau hantar sessionid baru).')
  }
}

/** Semak login: buka page upload dan ambil screenshot. */
const ACCOUNT_INFO_URL = `${ORIGIN}/passport/web/account/info/?aid=1459&app_language=en&app_name=tiktok_web`

/** Tanya TikTok terus: session ni masih login atau tidak. Pulangkan teks ringkas untuk diagnostik. */
async function accountStatus(page) {
  try {
    const res = await page.request.get(ACCOUNT_INFO_URL, { timeout: 20_000 })
    const json = await res.json().catch(() => null)
    const user = json?.data?.username || json?.data?.screen_name
    if (user) return { loggedIn: true, text: `akaun @${user}` }
    const why = json?.data?.description || json?.data?.error_code || json?.message || `HTTP ${res.status()}`
    return { loggedIn: false, text: `TikTok kata: ${why}` }
  } catch (e) {
    return { loggedIn: null, text: `tak dapat semak (${e.message.split('\n')[0]})` }
  }
}

async function hasSessionCookie(page) {
  const list = await page.context().cookies(ORIGIN)
  return list.some((c) => c.name === 'sessionid' && c.value)
}

/** Semak login: buka page upload, ambil screenshot, dan bagi maklumat diagnostik. */
export async function checkLogin() {
  return withPage(async (page) => {
    const loaded = readJson(COOKIE_FILE, []).length
    const before = await accountStatus(page)
    try {
      await openUploadPage(page)
    } catch (e) {
      const kept = await hasSessionCookie(page).catch(() => null)
      e.message +=
        `\n\n🔎 Diagnostik:\n• Cookies dimuat: ${loaded}\n• Status session (sebelum buka page): ${before.text}` +
        `\n• sessionid selepas buka page: ${kept ? 'masih ada' : 'DIPADAM oleh TikTok'}` +
        '\n\n💡 Cuba !loginqr: login terus dalam browser bot guna QR code.'
      throw e
    }
    const input = page.locator('input[type="file"]').first()
    const ok = await input.waitFor({ state: 'attached', timeout: 45_000 }).then(() => true, () => false)
    return { ok, info: before.text, screenshot: await screenshot(page).catch(() => null) }
  })
}

/**
 * Login guna QR code dalam browser bot sendiri (session dicipta di VPS, jadi TikTok tak tolak).
 * onQr(fail) dipanggil setiap kali QR baru sedia untuk discan.
 */
export async function loginWithQr({ onQr, onStatus, timeoutMs = 180_000 }) {
  const pageText = (page) => page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '')
  return withPage(
    async (page) => {
      await page.goto(`${ORIGIN}/login/qrcode`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForTimeout(5000)
      await dismissCookieBanner(page)
      await failIfCaptcha(page)
      await onQr(await qrScreenshot(page))

      const deadline = Date.now() + timeoutMs
      let refreshes = 0
      let lastText = await pageText(page)
      let updates = 0
      while (Date.now() < deadline) {
        await page.waitForTimeout(2500)
        if (await hasSessionCookie(page)) {
          await page.waitForTimeout(4000) // biar TikTok habis set semua cookies
          const status = await accountStatus(page)
          await onStatus?.(await screenshot(page).catch(() => null), '✅ Page TikTok selepas login')
          writeJson(COOKIE_FILE, await page.context().cookies(ORIGIN))
          return { account: status.loggedIn ? status.text : null }
        }
        const expired = await page.getByText(/QR code (has )?expired|kod QR (telah )?tamat/i).first().isVisible().catch(() => false)
        if (expired) {
          if (++refreshes > 2) break
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.waitForTimeout(5000)
          await dismissCookieBanner(page)
          await onQr(await qrScreenshot(page))
          lastText = await pageText(page)
          continue
        }
        // Hantar screenshot bila page berubah (cth selepas QR discan: "confirm on your phone")
        const text = await pageText(page)
        if (text && text !== lastText && updates < 5) {
          lastText = text
          updates++
          await onStatus?.(await screenshot(page).catch(() => null), '👀 Page TikTok berubah:')
        }
      }
      throw new WebUploadError('Masa tamat, QR tak discan. Taip !loginqr untuk cuba lagi.')
    },
    { useCookies: false, scale: 2 },
  )
}

/** Screenshot QR code sahaja (besar & jelas). Kalau tak jumpa, screenshot satu page. */
async function qrScreenshot(page) {
  const candidates = page.locator('canvas, img[src^="data:image"], img[alt*="qr" i], [data-e2e*="qr" i]')
  const n = await candidates.count().catch(() => 0)
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i)
    const box = await el.boundingBox().catch(() => null)
    if (box && box.width >= 100 && box.height >= 100 && Math.abs(box.width - box.height) < 40) {
      const pad = 24
      const file = path.join(config.downloadDir, `qr-${Date.now()}.png`)
      await page.screenshot({
        path: file,
        clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
      })
      return file
    }
  }
  return screenshot(page)
}

async function typeCaption(page, caption) {
  const editor = page.locator('.public-DraftEditor-content, div[contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: 120_000 })
  await editor.click()
  // TikTok isi nama fail sebagai caption: padam dulu
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)

  const lines = caption.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line) await page.keyboard.type(line, { delay: 25 })
    // Tutup popup cadangan hashtag/mention sebelum baris baru
    if (/[#@][^\s#@]+$/.test(line)) {
      await page.waitForTimeout(800)
      await page.keyboard.type(' ', { delay: 25 })
    }
    if (i < lines.length - 1) await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(1000)
}

function postButton(page) {
  return page
    .locator('button[data-e2e="post_video_button"]')
    .or(page.getByRole('button', { name: /^\s*(Post|Siarkan|Hantar)\s*$/i }))
    .first()
}

async function waitUntilEnabled(page, button, timeoutMs) {
  await button.waitFor({ state: 'visible', timeout: 120_000 })
  const handle = await button.elementHandle()
  await page.waitForFunction(
    (el) =>
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      el.getAttribute('data-disabled') !== 'true' &&
      !String(el.className).includes('disabled'),
    handle,
    { timeout: timeoutMs, polling: 1000 },
  )
}

/** Upload & post satu video. */
export async function uploadVideo({ filePath, caption, onStage }) {
  if (!fs.existsSync(filePath)) throw new WebUploadError('Fail video tak jumpa.')
  return withPage(async (page) => {
    onStage?.('open')
    await openUploadPage(page)

    const input = page.locator('input[type="file"]').first()
    await input.waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {
      throw new WebUploadError('Tak jumpa butang upload dalam page TikTok (mungkin design dah berubah).')
    })
    await input.setInputFiles(filePath)
    onStage?.('uploading')

    if (caption) await typeCaption(page, caption)

    const button = postButton(page)
    await waitUntilEnabled(page, button, config.web.uploadTimeoutMin * 60_000).catch(() => {
      throw new WebUploadError('Upload terlalu lama atau butang Post tak aktif.')
    })
    await failIfCaptcha(page)
    await page.waitForTimeout(1500)
    onStage?.('posting')
    await button.click()

    // Kadang-kadang TikTok tanya "Continue to post?" / "Post now"
    const confirm = page.getByRole('button', { name: /^\s*(Post now|Continue|Siarkan sekarang|Teruskan)\s*$/i }).first()
    if (await confirm.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)) {
      await confirm.click()
    }

    const success = await Promise.race([
      page.waitForURL(/tiktokstudio\/content|\/manage|creator-center\/content/, { timeout: 180_000 }).then(() => true),
      page
        .getByText(/(video (has been )?(posted|published|uploaded)|your video is being uploaded|manage your posts|dimuat naik|disiarkan)/i)
        .first()
        .waitFor({ state: 'visible', timeout: 180_000 })
        .then(() => true),
    ]).catch(() => false)

    await failIfCaptcha(page)
    if (!success) throw new WebUploadError('Tak pasti video dah post atau belum. Semak dalam app TikTok.')
    return { screenshot: await screenshot(page).catch(() => null) }
  })
}
