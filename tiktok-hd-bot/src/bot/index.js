// WhatsApp bot entry point: connection, login (QR or pairing code) and wiring of the router.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config, ROOT } from '../config.js';
import { analyze, formatAnalysis } from '../engine/analyze.js';
import { detectCaps, ffprobe } from '../engine/ffmpeg.js';
import { JobQueue } from './queue.js';
import { createRouter } from './router.js';

const CLI = path.join(ROOT, 'src', 'cli.js');
const logger = pino({ level: config.logLevel });
const current = { sock: null };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let retries = 0;

/** Run the engine in a child process so encoding never blocks the WhatsApp socket. */
function runEngine(input, output, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [CLI, input, '-o', output, '--json', '--mode', opts.mode, '--fps', String(opts.fps), '--preset', opts.preset, '--crf', String(opts.crf), '--tag', config.encoderTag];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: config.workDir } });
    let buf = '';
    let stderr = '';
    let result = null;
    let error = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === 'progress') onProgress(m);
        else if (m.type === 'done') result = m;
        else if (m.type === 'error') error = m.message;
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => (result ? resolve(result) : reject(new Error(error || stderr.trim().split('\n').pop() || `enjin keluar dengan kod ${code}`))));
  });
}

const handle = createRouter({
  config,
  queue: new JobQueue(config.concurrency),
  log,
  send: (chat, content, options) => current.sock.sendMessage(chat, content, options),
  download: async (waMessage, file) => {
    const stream = await downloadMediaMessage(waMessage, 'stream', {}, { logger, reuploadRequest: current.sock.updateMediaMessage });
    // Enforce the size limit on the bytes actually received, not only on the size the message claims.
    const limit = config.maxFileMb * 1048576;
    let received = 0;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        cb(received > limit ? new Error(`fail melebihi had ${config.maxFileMb} MB`) : null, chunk);
      },
    });
    await pipeline(stream, guard, fs.createWriteStream(file));
  },
  probeDuration: async (file) => Number((await ffprobe(file)).format?.duration || 0),
  runEngine,
  analyzeText: async (file, media) => {
    const a = await analyze(file);
    a.movie?.src.close();
    a.file = media.node.fileName || a.file;
    return formatAnalysis(a);
  },
});

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });
  current.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  let pairingAsked = false;
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !sock.authState.creds.registered) {
      if (config.botNumber) {
        if (!pairingAsked) {
          pairingAsked = true;
          try {
            const code = await sock.requestPairingCode(config.botNumber);
            log(`🔑 Kod pairing: ${code.match(/.{1,4}/g).join('-')}`);
            log('   WhatsApp > Peranti dipaut > Paut peranti > Paut dengan nombor telefon');
          } catch (err) {
            log(`Gagal minta kod pairing: ${err.message}`);
          }
        }
      } else {
        qrcode.generate(qr, { small: true });
        log('Imbas QR di atas: WhatsApp > Peranti dipaut > Paut peranti');
      }
    }
    if (connection === 'open') {
      retries = 0;
      log(`✅ Bot dalam talian sebagai ${sock.user?.id?.split(':')[0]}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log(`❌ Sesi log keluar. Padam folder "${path.relative(ROOT, config.sessionDir)}" dan jalankan semula untuk log masuk.`);
        process.exit(1);
      }
      // restartRequired is the normal step right after pairing; anything else backs off up to 1 minute.
      const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 3000 * 2 ** retries++);
      log(`Sambungan terputus (${code ?? '-'}), sambung semula dalam ${Math.round(wait / 1000)}s...`);
      setTimeout(() => connect().catch((e) => log(`reconnect error: ${e.message}`)), wait);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) handle(m).catch((err) => log(`handler error: ${err.message}`));
  });
}

async function main() {
  fs.mkdirSync(config.workDir, { recursive: true });
  // Remove leftovers of jobs interrupted by a restart (only folders this bot creates).
  for (const name of fs.readdirSync(config.workDir)) {
    if (/^(wa-|info-|tiktok-hd$)/.test(name)) fs.rmSync(path.join(config.workDir, name), { recursive: true, force: true });
  }
  let caps;
  try {
    caps = await detectCaps();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  log(`ffmpeg ${caps.version} • libx264: ${caps.x264 ? 'ya' : 'TIADA'} • zscale (HDR): ${caps.zscale ? 'ya' : 'TIADA'}`);
  if (!caps.x264) {
    console.error('❌ ffmpeg mesti ada libx264. Lihat README.');
    process.exit(1);
  }
  if (!caps.zscale) log('⚠️  Tiada zscale: video HDR (iPhone) tidak boleh diproses. Guna ffmpeg yang dibina dengan zimg.');
  await connect();
}

process.on('unhandledRejection', (err) => log(`unhandled: ${err?.message || err}`));
main();
