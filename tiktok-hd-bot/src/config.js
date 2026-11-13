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
  // Where the bot answers: group (default) | private | all
  replyIn: ['group', 'private', 'all'].includes(String(env.REPLY_IN).toLowerCase()) ? String(env.REPLY_IN).toLowerCase() : 'group',
  // Optional: only these groups (JIDs like 1203630xxxxxxxx@g.us — send ".id" in a group to see it)
  groupIds: String(env.GROUP_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  allowSelf: bool(env.ALLOW_SELF, true), // the bot's own number may use commands (useful on a personal number)
  autoProcess: bool(env.AUTO_PROCESS, true), // a video sent as a document is converted without any command
  // Reply file extension: mp4 (default, like the reference files) | mov
  docFormat: String(env.DOC_FORMAT).toLowerCase() === 'mov' ? 'mov' : 'mp4',
  // MIME type of the reply document: octet (application/octet-stream — iPhone WhatsApp downloads it
  // without inspecting it as video; default) | video (video/mp4 or video/quicktime)
  docMime: String(env.DOC_MIME).toLowerCase() === 'video' ? 'video' : 'octet',
  // haze  = full layout of the reference files (duplicate AAC track + 17 silent frames) — default
  // clean = iPhone-style container without those two quirks
  outputStyle: String(env.OUTPUT_STYLE).toLowerCase() === 'clean' ? 'clean' : 'haze',
  defaultMode: ['max', 'hd', 'keep'].includes(env.DEFAULT_MODE) ? env.DEFAULT_MODE : 'max',
  defaultFps: num(env.DEFAULT_FPS, 30),
  preset: env.X264_PRESET || 'medium',
  crf: num(env.CRF, 16),
  maxFileMb: num(env.MAX_FILE_MB, 1024),
  maxDurationSec: num(env.MAX_DURATION_SEC, 300),
  encoderTag: env.ENCODER_TAG || 'TikTok HD Bot',
  concurrency: Math.max(1, num(env.CONCURRENCY, 1)),
  sessionDir: path.resolve(ROOT, env.SESSION_DIR || 'session'),
  workDir: path.resolve(ROOT, env.WORK_DIR || 'tmp'),
  logLevel: env.LOG_LEVEL || 'silent',
};
