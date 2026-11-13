// Settings come from environment variables or a .env file in the project root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  } else {
    // Node < 20.12: minimal KEY=VALUE parser
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const env = process.env;
const digits = (s) => String(s || '').replace(/\D/g, '');
const list = (s) =>
  String(s || '')
    .split(',')
    .map(digits)
    .filter(Boolean);
const bool = (s, d) => (s === undefined || s === '' ? d : /^(1|true|yes|ya|on)$/i.test(s));
const num = (s, d) => (s === undefined || s === '' || Number.isNaN(Number(s)) ? d : Number(s));

export const config = {
  botNumber: digits(env.BOT_NUMBER), // set to log in with a pairing code instead of a QR code
  prefix: env.PREFIX || '.',
  owners: list(env.OWNER_NUMBER),
  allowed: list(env.ALLOWED_NUMBERS), // empty = everyone may use the bot
  allowGroups: bool(env.ALLOW_GROUPS, false),
  autoProcess: bool(env.AUTO_PROCESS, true), // process any video sent in private chat without a command
  defaultMode: ['max', 'hd', 'keep'].includes(env.DEFAULT_MODE) ? env.DEFAULT_MODE : 'max',
  defaultFps: num(env.DEFAULT_FPS, 30),
  preset: env.X264_PRESET || 'medium',
  crf: num(env.CRF, 17),
  maxFileMb: num(env.MAX_FILE_MB, 1024),
  maxDurationSec: num(env.MAX_DURATION_SEC, 300),
  encoderTag: env.ENCODER_TAG || 'TikTok HD Bot',
  concurrency: Math.max(1, num(env.CONCURRENCY, 1)),
  sessionDir: path.resolve(ROOT, env.SESSION_DIR || 'session'),
  workDir: path.resolve(ROOT, env.WORK_DIR || 'tmp'),
  logLevel: env.LOG_LEVEL || 'silent',
};
