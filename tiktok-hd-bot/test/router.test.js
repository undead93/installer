// Router tests with a fake WhatsApp socket — no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/bot/router.js';
import { JobQueue } from '../src/bot/queue.js';

const baseConfig = () => ({
  prefix: '.',
  owners: [],
  allowed: [],
  allowGroups: false,
  autoProcess: true,
  defaultMode: 'max',
  defaultFps: 30,
  preset: 'medium',
  crf: 17,
  maxFileMb: 100,
  maxDurationSec: 300,
  workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'routertest-')),
});

const fakeResult = {
  seconds: 12,
  input: { file: 'a.mov', size: 5e7, duration: 5, video: { codec: 'hevc', width: 3840, height: 2160, fps: 120, hdr: 'hlg', dolbyVision: {} }, device: 'iPhone', appleTracks: 6, spatialAudio: true, hadGps: true },
  plan: { fps: 30 },
  result: { width: 3840, height: 2160, bitrate: 11e6, size: 8e6, tracks: [] },
};

function setup(overrides = {}) {
  const sent = [];
  const calls = { download: [], engine: [], info: [] };
  let release;
  const gate = overrides.slowEngine ? new Promise((r) => (release = r)) : null;
  const config = { ...baseConfig(), ...(overrides.config || {}) };
  const handle = createRouter({
    config,
    queue: new JobQueue(1),
    send: async (chat, content, options) => {
      sent.push({ chat, content, options });
      return { key: { id: `m${sent.length}`, remoteJid: chat } };
    },
    download: async (waMessage, file) => {
      calls.download.push(waMessage);
      fs.writeFileSync(file, 'fake');
    },
    probeDuration: async () => overrides.duration ?? 5,
    runEngine: async (input, output, opts, onProgress) => {
      calls.engine.push({ input, output, opts });
      onProgress({ stage: 'video', percent: 50, fps: 4 });
      if (gate) await gate;
      fs.writeFileSync(output, 'result');
      return fakeResult;
    },
    analyzeText: async (file) => {
      calls.info.push(file);
      return 'ANALYSIS';
    },
  });
  return { handle, sent, calls, release: () => release?.(), config };
}

const dm = (message, extra = {}) => ({
  key: { remoteJid: '60123456789@s.whatsapp.net', id: `id${Math.random()}`, fromMe: false, ...extra },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message,
});
const doc = (caption, fileName = 'IMG_1880.MOV', mimetype = 'video/quicktime') => ({
  documentWithCaptionMessage: { message: { documentMessage: { fileName, mimetype, caption, fileLength: 81074151, url: 'x', mediaKey: 'k' } } },
});

test('document with ".hd" caption is processed in 1080p mode and returned as a document', async () => {
  const { handle, sent, calls } = setup();
  await handle(dm(doc('.hd')));
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].opts.mode, 'hd');
  assert.match(calls.engine[0].input, /input\.mov$/);
  const file = sent.find((s) => s.content.document);
  assert.ok(file, 'result document sent');
  assert.equal(file.content.mimetype, 'video/mp4');
  assert.equal(file.content.fileName, 'IMG_1880_hd.mp4');
  assert.match(file.content.caption, /Siap/);
  assert.ok(sent.some((s) => s.content.edit), 'progress shown by editing the status message');
});

test('a plain document without caption uses the default mode (max) and "60" in caption sets 60 fps', async () => {
  const a = setup();
  await a.handle(dm(doc('')));
  assert.equal(a.calls.engine[0].opts.mode, 'max');
  const b = setup();
  await b.handle(dm(doc('60')));
  assert.equal(b.calls.engine[0].opts.fps, 60);
});

test('compressed WhatsApp video is accepted with a warning', async () => {
  const { handle, sent, calls } = setup();
  await handle(dm({ videoMessage: { mimetype: 'video/mp4', seconds: 10, fileLength: 1e6, url: 'x' } }));
  assert.equal(calls.engine.length, 1);
  assert.ok(sent.some((s) => /video biasa/.test(s.content.text || '')));
});

test('replying ".info" to a document analyses the quoted file', async () => {
  const { handle, sent, calls } = setup();
  const quoted = { documentMessage: { fileName: 'clip.mp4', mimetype: 'video/mp4', url: 'x' } };
  await handle(dm({ extendedTextMessage: { text: '.info', contextInfo: { stanzaId: 'Q1', participant: undefined, quotedMessage: quoted } } }));
  assert.equal(calls.info.length, 1);
  assert.equal(calls.download[0].key.id, 'Q1');
  assert.ok(sent.some((s) => s.content.text === 'ANALYSIS'));
});

test('menu, non-video documents, size and duration limits', async () => {
  const { handle, sent, calls } = setup({ duration: 999 });
  await handle(dm({ conversation: '.menu' }));
  assert.match(sent.at(-1).content.text, /TikTok HD Bot/);
  await handle(dm(doc('', 'notes.pdf', 'application/pdf')));
  assert.match(sent.at(-1).content.text, /bukan video/);
  await handle(dm({ documentMessage: { fileName: 'big.mov', mimetype: 'video/quicktime', fileLength: 5e9, url: 'x' } }));
  assert.match(sent.at(-1).content.text, /terlalu besar/);
  await handle(dm(doc('')));
  assert.match(sent.at(-1).content.text, /terlalu panjang/);
  assert.equal(calls.engine.length, 0);
});

test('groups are ignored by default and the allow-list matches the phone number behind a LID', async () => {
  const g = setup();
  await g.handle({ ...dm(doc('.max')), key: { remoteJid: '1203630@g.us', participant: '111@lid', id: 'g1' } });
  assert.equal(g.sent.length, 0);

  const allow = setup({ config: { allowed: ['60123456789'] } });
  await allow.handle(dm({ conversation: '.ping' }, { remoteJid: '9988776655@lid', remoteJidAlt: '60123456789@s.whatsapp.net' }));
  assert.equal(allow.sent.at(-1).content.text, 'pong 🏓');
  await allow.handle(dm({ conversation: '.ping' }, { remoteJid: '5550001@lid', remoteJidAlt: '60999999999@s.whatsapp.net' }));
  assert.equal(allow.sent.length, 1, 'stranger ignored');
});

test('one job per user: a second video while the first runs is refused politely', async () => {
  const s = setup({ slowEngine: true });
  const first = s.handle(dm(doc('.max')));
  await new Promise((r) => setTimeout(r, 50));
  await s.handle(dm(doc('.hd')));
  assert.match(s.sent.at(-1).content.text, /sedang diproses/);
  s.release();
  await first;
  assert.equal(s.calls.engine.length, 1);
});
