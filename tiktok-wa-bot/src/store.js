import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

function file(name) {
  return path.join(config.dataDir, name)
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(name, value) {
  const target = file(name)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
}

export function getSettings() {
  return {
    mode: config.tiktok.defaultMode,
    privacy: config.tiktok.defaultPrivacy,
    ...readJson('settings.json', {}),
  }
}

export function updateSettings(patch) {
  const next = { ...readJson('settings.json', {}), ...patch }
  writeJson('settings.json', next)
  return getSettings()
}
