// Full "send a video document -> get the converted document back" flow using Baileys' real media code:
// the incoming document is AES-encrypted exactly like WhatsApp does and served from a local HTTP server,
// the bot downloads/decrypts it with downloadMediaMessage, converts it with the engine child process, and
// builds its reply with generateWAMessageContent (real encryption, fake upload). Only the socket is fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pino from 'pino';
import { encryptedStream, generateWAMessageContent, downloadMediaMessage } from 'baileys';
import { createDeps } from '../src/bot/deps.js';
import { createRouter } from '../src/bot/router.js';
import { JobQueue } from '../src/bot/queue.js';

const logger = pino({ level: 'silent' });
// E2E_INPUT=/path/video.mov runs the same flow on your own file (default caption: E2E_CAPTION or none).
const OWN_INPUT = process.env.E2E_INPUT;
let dir;
let server;
let base;
const served = new Map();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wae2e-'));
  if (OWN_INPUT) fs.copyFileSync(OWN_INPUT, path.join(dir, 'IMG_TEST.MOV'));
  else execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '1.5',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', '-tag:v', 'hvc1',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-c:a', 'aac', '-ac', '2', path.join(dir, 'IMG_TEST.MOV')]);
  server = http.createServer((req, res) => {
    const body = served.get(req.url);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('group: document video in -> converted document out', async () => {
  // 1. The user sends IMG_TEST.MOV as a document: WhatsApp encrypts it and the message carries the keys.
  const enc = await encryptedStream({ url: path.join(dir, 'IMG_TEST.MOV') }, 'document', { logger });
  served.set('/in.enc', fs.readFileSync(enc.encFilePath));
  fs.rmSync(enc.encFilePath, { force: true });
  const incoming = {
    key: { remoteJid: '120363000000000001@g.us', participant: '201234567890123@lid', participantAlt: '60123456789@s.whatsapp.net', id: 'USERMSG1', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            url: `${base}/in.enc`,
            mimetype: 'video/quicktime',
            fileName: 'IMG_TEST.MOV',
            caption: OWN_INPUT ? process.env.E2E_CAPTION || '' : '.hd',
            mediaKey: enc.mediaKey,
            fileSha256: enc.fileSha256,
            fileEncSha256: enc.fileEncSha256,
            fileLength: enc.fileLength,
          },
        },
      },
    },
  };

  // 2. A socket whose sendMessage builds real WhatsApp message content; uploads land on the local server.
  const sent = [];
  const sock = {
    updateMediaMessage: async (m) => m,
    sendMessage: async (jid, content, options) => {
      const message = await generateWAMessageContent(content, {
        logger,
        jid,
        upload: async (encFilePath) => {
          const name = `/up${served.size}.enc`;
          served.set(name, fs.readFileSync(encFilePath));
          return { mediaUrl: `${base}${name}`, directPath: undefined };
        },
      });
      sent.push({ jid, content, options, message });
      return { key: { remoteJid: jid, id: `BOT${sent.length}`, fromMe: true }, message };
    },
  };

  const config = {
    prefix: '.', owners: [], allowed: [], replyIn: 'group', groupIds: [], allowSelf: true, autoProcess: true,
    defaultMode: 'max', defaultFps: 30, preset: OWN_INPUT ? 'medium' : 'ultrafast', crf: 17,
    maxFileMb: 2048, maxDurationSec: 600, encoderTag: 'TikTok HD Bot',
    workDir: path.join(dir, 'work'),
  };
  const handle = createRouter({ config, queue: new JobQueue(1), ...createDeps({ getSock: () => sock, logger, config }) });

  // 3. The bot handles the message end to end.
  await handle(incoming);

  const reply = sent.find((s) => s.content.document);
  assert.ok(reply, `bot sent a document (got: ${sent.map((s) => s.content.text || 'doc').join(' | ')})`);
  assert.equal(reply.jid, incoming.key.remoteJid);
  assert.equal(reply.options.quoted, incoming, 'reply quotes the user message');
  const docMsg = reply.message.documentMessage || reply.message.documentWithCaptionMessage?.message?.documentMessage;
  assert.ok(docMsg, 'WhatsApp document message generated');
  assert.equal(docMsg.mimetype, 'application/octet-stream');
  assert.equal(docMsg.fileName, 'IMG_TEST_hd.mp4');
  assert.match(docMsg.caption, /^@201234567890123 ✅ \*Siap!\*/);
  assert.deepEqual(docMsg.contextInfo?.mentionedJid, ['201234567890123@lid'], 'sender is tagged in the group');
  assert.ok(sent.some((s) => s.content.edit && s.message.protocolMessage), 'progress edits are valid edit messages');

  // 4. The user downloads the reply: decrypt it like a WhatsApp client and check it is the converted video.
  const file = await downloadMediaMessage({ key: { remoteJid: reply.jid, id: 'BOT', fromMe: true }, message: reply.message }, 'buffer', {});
  assert.equal(file.length, Number(docMsg.fileLength));
  assert.deepEqual(crypto.createHash('sha256').update(file).digest(), Buffer.from(docMsg.fileSha256), 'payload intact');
  const outPath = path.join(dir, docMsg.fileName);
  fs.writeFileSync(outPath, file);
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outPath]).toString());
  const v = p.streams.find((s) => s.codec_type === 'video');
  assert.equal(p.format.tags.major_brand, 'qt  ');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.color_transfer, 'bt709');
  assert.equal(v.r_frame_rate, '30/1');
  if (OWN_INPUT) {
    if (process.env.E2E_KEEP) fs.copyFileSync(outPath, process.env.E2E_KEEP);
  } else {
    assert.equal(`${v.width}x${v.height}`, '1920x1080');
  }

  // 5. Temporary files are cleaned up.
  assert.deepEqual(fs.readdirSync(config.workDir).filter((n) => n.startsWith('wa-')), []);
});

test('group: ".uji" delivers variants A–E that all decrypt to the expected files', { skip: Boolean(OWN_INPUT) }, async () => {
  const enc = await encryptedStream({ url: path.join(dir, 'IMG_TEST.MOV') }, 'document', { logger });
  served.set('/in2.enc', fs.readFileSync(enc.encFilePath));
  fs.rmSync(enc.encFilePath, { force: true });
  const incoming = {
    key: { remoteJid: '120363000000000001@g.us', participant: '201234567890123@lid', id: 'USERMSG2', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { documentMessage: { url: `${base}/in2.enc`, mimetype: 'video/quicktime', fileName: 'IMG_TEST.MOV', caption: '.uji', mediaKey: enc.mediaKey, fileSha256: enc.fileSha256, fileEncSha256: enc.fileEncSha256, fileLength: enc.fileLength } },
  };
  const sent = [];
  const sock = {
    updateMediaMessage: async (m) => m,
    sendMessage: async (jid, content, options) => {
      const message = await generateWAMessageContent(content, {
        logger,
        jid,
        upload: async (encFilePath) => {
          const name = `/u2_${served.size}.enc`;
          served.set(name, fs.readFileSync(encFilePath));
          return { mediaUrl: `${base}${name}`, directPath: undefined };
        },
      });
      sent.push({ content, message });
      return { key: { remoteJid: jid, id: `T${sent.length}`, fromMe: true }, message };
    },
  };
  const config = {
    prefix: '.', owners: [], allowed: [], replyIn: 'group', groupIds: [], allowSelf: true, autoProcess: true,
    defaultMode: 'hd', defaultFps: 30, preset: 'ultrafast', crf: 17, maxFileMb: 100, maxDurationSec: 300,
    encoderTag: 'TikTok HD Bot', docFormat: 'mov', outputStyle: 'clean', workDir: path.join(dir, 'work2'),
  };
  const handle = createRouter({ config, queue: new JobQueue(1), ...createDeps({ getSock: () => sock, logger, config }) });
  await handle(incoming);

  const docs = sent.filter((s) => s.content.document).map((s) => s.message.documentMessage || s.message.documentWithCaptionMessage?.message?.documentMessage);
  assert.deepEqual(docs.map((d) => d.fileName[0]), ['A', 'B', 'C', 'D', 'E']);
  const bodies = [];
  for (const d of docs) bodies.push(await downloadMediaMessage({ key: { id: 'x' }, message: { documentMessage: d } }, 'buffer', {}));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(sha(bodies[0]), sha(bodies[1]), 'A and B are the same file');
  assert.equal(sha(bodies[0]), sha(bodies[3]), 'A and D are the same file');
  assert.notEqual(sha(bodies[2]), sha(bodies[0]), 'C is the clean variant');
  assert.equal(sha(bodies[4]), sha(fs.readFileSync(path.join(dir, 'IMG_TEST.MOV'))), 'E is the untouched original');
  assert.equal(bodies[2].includes('mdat') && bodies[2].indexOf('mdat') === bodies[2].lastIndexOf('mdat'), true, 'clean copy has a single mdat');
  assert.match(sent.at(-1).content.text, /Ujian siap/);
});
