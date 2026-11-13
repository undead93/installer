// Router tests with a fake WhatsApp socket — no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/bot/router.js';
import { JobQueue } from '../src/bot/queue.js';

const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000999@g.us';

const baseConfig = () => ({
  prefix: '.',
  owners: [],
  allowed: [],
  replyIn: 'group',
  groupIds: [],
  allowSelf: true,
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
      return { key: { id: `m${sent.length}`, remoteJid: chat, fromMe: true } };
    },
    download: async (waMessage, file) => {
      calls.download.push(waMessage);
      fs.writeFileSync(file, 'fake');
    },
    probeDuration: async () => overrides.duration ?? 5,
    runEngine: async (input, output, opts, onProgress) => {
      calls.engine.push({ input, output, opts });
      onProgress({ stage: 'video', percent: null, fps: 0 }); // ffmpeg's first report has no percentage
      onProgress({ stage: 'mux', percent: 100 });
      if (gate) await gate;
      fs.writeFileSync(output, 'result');
      if (opts.cleanCopy) fs.writeFileSync(opts.cleanCopy, 'clean');
      return fakeResult;
    },
    analyzeText: async (file) => {
      calls.info.push(file);
      return 'ANALYSIS';
    },
  });
  return { handle, sent, calls, release: () => release?.(), config };
}

const now = () => Math.floor(Date.now() / 1000);
const dm = (message, extra = {}) => ({
  key: { remoteJid: '60123456789@s.whatsapp.net', id: `id${Math.random()}`, fromMe: false, ...extra },
  messageTimestamp: now(),
  message,
});
const gm = (message, extra = {}) => ({
  key: { remoteJid: GROUP, participant: '201234567890123@lid', participantAlt: '60123456789@s.whatsapp.net', id: `g${Math.random()}`, fromMe: false, ...extra },
  messageTimestamp: now(),
  message,
});
const doc = (caption, fileName = 'IMG_1880.MOV', mimetype = 'video/quicktime') => ({
  documentWithCaptionMessage: { message: { documentMessage: { fileName, mimetype, caption, fileLength: 81074151, url: 'x', mediaKey: 'k' } } },
});
const video = (caption = '') => ({ videoMessage: { mimetype: 'video/mp4', seconds: 10, fileLength: 1e6, url: 'x', caption } });

// ---------------------------------------------------------------- group mode (the default)

test('default = group only: a document in the group comes back converted, quoting and tagging the sender', async () => {
  const { handle, sent, calls } = setup();
  await handle(dm(doc('')));
  assert.equal(sent.length, 0, 'private chat ignored in group mode');

  await handle(gm(doc('')));
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].opts.mode, 'max');
  assert.equal(calls.engine[0].opts.pad, true, 'full reference layout by default');
  assert.equal(calls.engine[0].opts.dupAudio, true);
  const file = sent.find((s) => s.content.document);
  assert.ok(file, 'result document sent');
  assert.equal(file.chat, GROUP);
  assert.equal(file.content.mimetype, 'application/octet-stream', 'sent as a plain file so iPhone WhatsApp downloads it as-is');
  assert.equal(file.content.fileName, 'IMG_1880_hd.mp4');
  assert.ok(file.options.quoted, 'quotes the original message');
  assert.deepEqual(file.content.mentions, ['201234567890123@lid']);
  assert.match(file.content.caption, /^@201234567890123 ✅ \*Siap!\*/);
  assert.ok(sent.some((s) => s.content.edit && / 0%/.test(s.content.text || '')), 'progress edit survives a null percentage');
  assert.ok(sent.some((s) => s.content.edit && /100%/.test(s.content.text || '')), 'progress reaches 100%');
});

test('group: chatter and normal videos are ignored, replying ".hd" to a video processes it', async () => {
  const { handle, sent, calls } = setup();
  await handle(gm({ conversation: 'hello semua' }));
  await handle(gm(video()));
  await handle(gm(doc('', 'notes.pdf', 'application/pdf')));
  await handle(gm({ conversation: '.unknown' }));
  assert.equal(sent.length, 0, 'bot stays quiet in the group');

  await handle(gm({ extendedTextMessage: { text: '.hd', contextInfo: { stanzaId: 'V1', participant: '999@lid', quotedMessage: video() } } }));
  assert.equal(calls.engine.length, 1);
  assert.equal(calls.engine[0].opts.mode, 'hd');
  assert.equal(calls.download[0].key.id, 'V1');
  assert.ok(sent.some((s) => /video biasa/.test(s.content.text || '')), 'warns that the video was compressed');
});

test('GROUP_IDS limits the bot to chosen groups; ".id" shows the group id anywhere', async () => {
  const { handle, sent, calls } = setup({ config: { groupIds: [GROUP] } });
  await handle(gm(doc(''), { remoteJid: OTHER_GROUP }));
  assert.equal(calls.engine.length, 0);
  await handle(gm({ conversation: '.id' }, { remoteJid: OTHER_GROUP }));
  assert.match(sent.at(-1).content.text, new RegExp(OTHER_GROUP));
  await handle(gm(doc('')));
  assert.equal(calls.engine.length, 1);
});

test('own number: a document captioned ".max" is processed; the bot never re-triggers on its own messages', async () => {
  const { handle, sent, calls } = setup();
  await handle(gm(doc(''), { fromMe: true, participant: undefined, participantAlt: undefined }));
  assert.equal(calls.engine.length, 0, 'own message without a command ignored');
  await handle(gm(doc('.max'), { fromMe: true, participant: undefined, participantAlt: undefined }));
  assert.equal(calls.engine.length, 1);
  const result = sent.find((s) => s.content.document);
  await handle(gm(doc('.max', result.content.fileName, 'video/mp4'), { fromMe: true, id: 'm' + (sent.indexOf(result) + 1) }));
  assert.equal(calls.engine.length, 1, "the bot's own sent message is never processed");
});

// ---------------------------------------------------------------- private chats (REPLY_IN=private / all)

test('private: document with ".hd" caption is processed and returned as a document', async () => {
  const { handle, sent, calls } = setup({ config: { replyIn: 'all' } });
  await handle(dm(doc('.hd')));
  assert.equal(calls.engine[0].opts.mode, 'hd');
  assert.match(calls.engine[0].input, /input\.mov$/);
  const file = sent.find((s) => s.content.document);
  assert.equal(file.content.fileName, 'IMG_1880_hd.mp4');
  assert.equal(file.content.mentions, undefined, 'no tag in private chats');
  assert.match(file.content.caption, /^✅ \*Siap!\*/);
});

test('private: plain document uses the default mode, "60" sets 60 fps, plain text gets no reply', async () => {
  const a = setup({ config: { replyIn: 'private' } });
  await a.handle(dm(doc('')));
  assert.equal(a.calls.engine[0].opts.mode, 'max');
  const b = setup({ config: { replyIn: 'private' } });
  await b.handle(dm(doc('60')));
  assert.equal(b.calls.engine[0].opts.fps, 60);
  const before = b.sent.length;
  await b.handle(dm({ conversation: 'hai bro, apa khabar' }));
  assert.equal(b.sent.length, before, 'no menu spam on normal chat');
});

test('private: compressed video accepted with a warning; replying ".info" analyses the quoted file', async () => {
  const { handle, sent, calls } = setup({ config: { replyIn: 'private' } });
  await handle(dm(video()));
  assert.equal(calls.engine.length, 1);
  assert.ok(sent.some((s) => /video biasa/.test(s.content.text || '')));
  const quoted = { documentMessage: { fileName: 'clip.mp4', mimetype: 'video/mp4', url: 'x' } };
  await handle(dm({ extendedTextMessage: { text: '.info', contextInfo: { stanzaId: 'Q1', quotedMessage: quoted } } }));
  assert.equal(calls.info.length, 1);
  assert.ok(sent.some((s) => s.content.text === 'ANALYSIS'));
});

test('limits: menu, non-video documents, size and duration', async () => {
  const { handle, sent, calls } = setup({ duration: 999, config: { replyIn: 'all' } });
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

test('REPLY_IN=private ignores groups; the allow-list matches the phone number behind a LID', async () => {
  const g = setup({ config: { replyIn: 'private' } });
  await g.handle(gm(doc('.max')));
  assert.equal(g.sent.length, 0);

  const allow = setup({ config: { replyIn: 'all', allowed: ['60123456789'] } });
  await allow.handle(dm({ conversation: '.ping' }, { remoteJid: '9988776655@lid', remoteJidAlt: '60123456789@s.whatsapp.net' }));
  assert.equal(allow.sent.at(-1).content.text, 'pong 🏓');
  await allow.handle(dm({ conversation: '.ping' }, { remoteJid: '5550001@lid', remoteJidAlt: '60999999999@s.whatsapp.net' }));
  assert.equal(allow.sent.length, 1, 'stranger ignored');
  await allow.handle(gm({ conversation: '.ping' }));
  assert.equal(allow.sent.length, 2, 'allowed member in a group (participantAlt) accepted');
});

test('one job per user: a second video while the first runs is refused politely', async () => {
  const s = setup({ slowEngine: true });
  const first = s.handle(gm(doc('.max')));
  await new Promise((r) => setTimeout(r, 50));
  await s.handle(gm(doc('.hd')));
  assert.match(s.sent.at(-1).content.text, /sedang diproses/);
  s.release();
  await first;
  assert.equal(s.calls.engine.length, 1);
});

// ---------------------------------------------------------------- delivery format + .uji diagnostics

test('DOC_FORMAT=mov + DOC_MIME=video + OUTPUT_STYLE=clean; per-message "bersih"/"haze" override', async () => {
  const { handle, sent, calls } = setup({ config: { method: 'haze', docFormat: 'mov', docMime: 'video', outputStyle: 'clean' } });
  await handle(gm(doc('')));
  assert.equal(calls.engine[0].opts.pad, false);
  assert.equal(calls.engine[0].opts.dupAudio, false);
  const file = sent.find((s) => s.content.document);
  assert.equal(file.content.fileName, 'IMG_1880_hd.mov');
  assert.equal(file.content.mimetype, 'video/quicktime');
  const b = setup({ config: { method: 'haze' } });
  await b.handle(gm(doc('.max bersih')));
  assert.equal(b.calls.engine[0].opts.pad, false);
  const c = setup({ config: { method: 'haze', outputStyle: 'clean' } });
  await c.handle(gm(doc('.max haze')));
  assert.equal(c.calls.engine[0].opts.dupAudio, true);
});

test('".uji" encodes once and sends variants A–E plus instructions', async () => {
  const { handle, sent, calls } = setup();
  const small = doc('.uji');
  small.documentWithCaptionMessage.message.documentMessage.fileLength = 20e6;
  await handle(gm(small));
  assert.equal(calls.engine.length, 1, 'one encode only');
  const opts = calls.engine[0].opts;
  assert.equal(opts.pad, true);
  assert.equal(opts.dupAudio, true);
  assert.match(opts.cleanCopy, /clean\.mov$/);
  const docs = sent.filter((s) => s.content.document);
  assert.deepEqual(docs.map((d) => d.content.fileName), ['A_IMG_1880_haze.mp4', 'B_IMG_1880_haze.mov', 'C_IMG_1880_bersih.mov', 'D_IMG_1880_haze.mp4', 'E_asal_IMG_1880.MOV']);
  assert.deepEqual(docs.map((d) => d.content.mimetype), ['video/mp4', 'video/quicktime', 'video/quicktime', 'application/octet-stream', 'video/quicktime']);
  assert.equal(docs[2].content.document.url, opts.cleanCopy, 'C is the clean copy');
  assert.equal(docs[0].content.document.url, docs[1].content.document.url, 'A/B/D share the same bytes');
  assert.match(docs[4].content.document.url, /input\.mov$/, 'E is the untouched original');
  assert.match(sent.at(-1).content.text, /Ujian siap[\s\S]*A, B, C, D, E/);
});

test('".uji" skips the original-file control when the original is big', async () => {
  const { handle, sent } = setup();
  await handle(gm(doc('.uji'))); // 81 MB original
  const names = sent.filter((s) => s.content.document).map((d) => d.content.fileName);
  assert.equal(names.length, 4);
  assert.ok(!names.some((n) => n.startsWith('E_')));
});

test('default method is tt (copy + TikTok editor tags); .max/.hd/.haze switch to re-encoding, .tt back', async () => {
  const a = setup();
  await a.handle(gm(doc('')));
  assert.equal(a.calls.engine[0].opts.method, 'tt');
  const b = setup();
  await b.handle(gm(doc('.max')));
  assert.equal(b.calls.engine[0].opts.method, 'haze');
  assert.equal(b.calls.engine[0].opts.mode, 'max');
  const c = setup({ config: { method: 'haze' } });
  await c.handle(gm(doc('.tt')));
  assert.equal(c.calls.engine[0].opts.method, 'tt');
});
