// WhatsApp bot entry point: connection, login (QR or pairing code) and wiring of the router.
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config, ROOT } from '../config.js';
import { detectCaps } from '../engine/ffmpeg.js';
import { createDeps } from './deps.js';
import { JobQueue } from './queue.js';
import { createRouter } from './router.js';

const logger = pino({ level: config.logLevel });
const current = { sock: null };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let retries = 0;

const handle = createRouter({
  config,
  queue: new JobQueue(config.concurrency),
  log,
  ...createDeps({ getSock: () => current.sock, logger, config }),
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
