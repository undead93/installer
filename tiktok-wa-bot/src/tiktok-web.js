// Upload ke TikTok melalui laman web (tiktok.com) guna browser automatik (Playwright).
// BUKAN cara rasmi: TikTok boleh tukar design website bila-bila masa dan akaun boleh kena flag.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { config } from './config.js'
import { readJson, writeJson } from './store.js'

const COOKIE_FILE = 'tiktok-cookies.json'
const UPLOAD_URL = process.env.TIKTOK_UPLOAD_URL || 'https://www.tiktok.com/tiktokstudio/upload?from=webapp'
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

async function withPage(fn) {
  const cookies = readJson(COOKIE_FILE, [])
  if (!cookies.length) throw new WebUploadError('Belum ada login TikTok. Hantar !sessionid <nilai> dulu.')

  const browser = await chromium.launch({
    headless: config.web.headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  })
  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      timezoneId: config.web.timezone,
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    await context.addCookies(cookies)
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
      const fresh = await context.cookies('https://www.tiktok.com').catch(() => [])
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
  await page.goto(`${new URL(UPLOAD_URL).origin}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {})
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
export async function checkLogin() {
  return withPage(async (page) => {
    await openUploadPage(page)
    const input = page.locator('input[type="file"]').first()
    const ok = await input.waitFor({ state: 'attached', timeout: 45_000 }).then(() => true, () => false)
    return { ok, screenshot: await screenshot(page).catch(() => null) }
  })
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
