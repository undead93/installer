// Message router: decides what to do with each incoming WhatsApp message.
// Everything external (socket, downloader, engine) is injected so it can be tested offline.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMessageContent } from 'baileys';
import * as T from './texts.js';

export const MODE_ALIASES = { max: 'max', '4k': 'max', uhd: 'max', hd: 'hd', 1080: 'hd', '1080p': 'hd', keep: 'keep', ori: 'keep', asal: 'keep' };
const VIDEO_EXT = /\.(mov|mp4|m4v|mkv|webm|3gp|avi|hevc)$/i;

/** protobuf Long -> number */
export const toNum = (v) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v || 0));

export function senderOf(msg) {
  const chat = msg.key.remoteJid;
  const isGroup = chat.endsWith('@g.us');
  const ids = isGroup ? [msg.key.participant, msg.key.participantAlt] : [chat, msg.key.remoteJidAlt];
  const numbers = ids.filter(Boolean).map((j) => j.split('@')[0].split(':')[0]);
  return { chat, isGroup, user: ids.find(Boolean) || chat, numbers };
}

const textOf = (c) => (c?.conversation || c?.extendedTextMessage?.text || c?.documentMessage?.caption || c?.videoMessage?.caption || '').trim();

function mediaOf(c) {
  if (c?.documentMessage) return { kind: 'document', node: c.documentMessage };
  if (c?.videoMessage) return { kind: 'video', node: c.videoMessage };
  return null;
}

function quotedOf(msg, c) {
  const ctx = c?.extendedTextMessage?.contextInfo || c?.documentMessage?.contextInfo || c?.videoMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  const message = normalizeMessageContent(ctx.quotedMessage);
  const media = mediaOf(message);
  if (!media) return null;
  return { ...media, waMessage: { key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message } };
}

export const isVideoNode = (m) => m.kind === 'video' || /^video\//.test(m.node.mimetype || '') || VIDEO_EXT.test(m.node.fileName || '');

export function extFor(node) {
  const m = (node.fileName || '').match(/\.[a-z0-9]{2,5}$/i);
  if (m) return m[0].toLowerCase();
  return /quicktime/.test(node.mimetype || '') ? '.mov' : '.mp4';
}

export function baseFor(node) {
  const name = (node.fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return name.replace(/[^\w.-]+/g, '_').slice(0, 60) || `video_${Date.now()}`;
}

export function parseCommand(text, prefix) {
  if (!text.startsWith(prefix)) return null;
  const [name = '', ...args] = text.slice(prefix.length).trim().split(/\s+/);
  return { name: name.toLowerCase(), args: args.map((a) => a.toLowerCase()) };
}

export function optionsFrom(config, mode, args = [], method = config.method || 'tt') {
  const haze = (config.outputStyle || 'haze') === 'haze';
  const opts = { method, mode, fps: config.defaultFps, preset: config.preset, crf: config.crf, pad: haze, dupAudio: haze };
  if (method === 'tt') opts.pad = opts.dupAudio = true; // part of the reference file layout
  for (const a of args) {
    if (/^60(fps)?$/.test(a)) opts.fps = 60;
    else if (/^30(fps)?$/.test(a)) opts.fps = 30;
    else if (/^(laju|fast)$/.test(a)) opts.preset = 'faster';
    else if (a === 'haze') opts.pad = opts.dupAudio = true;
    else if (/^(bersih|clean)$/.test(a)) opts.pad = opts.dupAudio = false;
    else if (MODE_ALIASES[a]) opts.mode = MODE_ALIASES[a];
  }
  return opts;
}

/**
 * Name + MIME type of the reply document. Default: .mp4 sent as application/octet-stream — iPhone WhatsApp
 * then downloads the file as-is (it refused the same bytes sent as video/mp4), and iOS still offers
 * "Save Video" from the .mp4 extension.
 */
export function replyFile(config, node) {
  const ext = config.docFormat === 'mov' ? '.mov' : '.mp4';
  const mimetype = config.docMime === 'video' ? (ext === '.mov' ? 'video/quicktime' : 'video/mp4') : 'application/octet-stream';
  return { fileName: `${baseFor(node)}_hd${ext}`, mimetype };
}

/**
 * deps: {
 *   config, queue, log,
 *   send(chat, content, options) -> Promise<{key}>,
 *   download(waMessage, file) -> Promise<void>,
 *   probeDuration(file) -> Promise<number>,
 *   runEngine(input, output, opts, onProgress) -> Promise<result>,
 *   analyzeText(file, media) -> Promise<string>,
 * }
 *
 * config.replyIn: 'group' (default) | 'private' | 'all' — where the bot answers.
 * config.groupIds: optional list of group JIDs the bot is limited to.
 */
export function createRouter(deps) {
  const { config, queue, log = () => {} } = deps;
  const replyIn = config.replyIn || 'group';
  const groupIds = config.groupIds || [];
  const startedAt = Math.floor(Date.now() / 1000);

  // Remember what the bot itself sent, so its own messages never trigger it again.
  const sentIds = new Set();
  const send = async (chat, content, options) => {
    const res = await deps.send(chat, content, options);
    if (res?.key?.id) {
      sentIds.add(res.key.id);
      if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
    }
    return res;
  };

  async function processJob({ chat, msg, media, opts, isGroup, user }) {
    fs.mkdirSync(config.workDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(config.workDir, 'wa-'));
    const setStatus = statusUpdater(chat, msg);
    try {
      if (media.kind === 'video') await send(chat, { text: T.compressedWarning() }, { quoted: msg });
      await setStatus(T.downloading());
      const input = path.join(dir, `input${extFor(media.node)}`);
      await deps.download(media.waMessage, input);
      const duration = await deps.probeDuration(input);
      if (duration > config.maxDurationSec + 1) throw new Error(T.tooLong(duration, config.maxDurationSec));
      const { fileName, mimetype } = replyFile(config, media.node);
      const output = path.join(dir, fileName);
      const res = await deps.runEngine(input, output, opts, progressReporter(setStatus));
      await setStatus('✅ Selesai — menghantar fail...');
      // In a group, tag the sender so they get notified even in a busy chat.
      const tag = isGroup && user ? `@${user.split('@')[0].split(':')[0]} ` : '';
      const doc = { document: { url: output }, mimetype, fileName, caption: tag + T.done(res) };
      if (tag) doc.mentions = [user];
      await send(chat, doc, { quoted: msg });
      log(`done ${fileName} in ${Math.round(res.seconds)}s`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function progressReporter(setStatus) {
    let last = 0;
    return (p) => {
      try {
        const now = Date.now();
        if (now - last > 12000 || p.stage === 'mux') {
          last = now;
          setStatus(T.progress(p.stage, p.percent, p.fps));
        }
      } catch (err) {
        log(`progress update skipped: ${err.message}`); // a status message must never break the job
      }
    };
  }

  function statusUpdater(chat, msg) {
    let statusKey = null;
    return async (text) => {
      try {
        if (!statusKey) statusKey = (await send(chat, { text }, { quoted: msg }))?.key;
        else await send(chat, { text, edit: statusKey });
      } catch {
        // progress edits are best effort
      }
    };
  }

  /**
   * ".uji": one encode, several ways of delivering it, so the user can see on their phone which
   * documents WhatsApp lets them download (iPhone WhatsApp rejects some files as "Couldn't download").
   */
  async function testJob({ chat, msg, media }) {
    fs.mkdirSync(config.workDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(config.workDir, 'wa-'));
    const setStatus = statusUpdater(chat, msg);
    try {
      await setStatus(T.downloading());
      const input = path.join(dir, `input${extFor(media.node)}`);
      await deps.download(media.waMessage, input);
      const duration = await deps.probeDuration(input);
      if (duration > config.maxDurationSec + 1) throw new Error(T.tooLong(duration, config.maxDurationSec));
      const hazeOut = path.join(dir, 'haze.mov');
      const cleanOut = path.join(dir, 'clean.mov');
      const opts = { ...optionsFrom(config, config.defaultMode, [], 'haze'), pad: true, dupAudio: true, cleanCopy: cleanOut };
      await deps.runEngine(input, hazeOut, opts, progressReporter(setStatus));
      await setStatus('🧪 Menghantar fail ujian...');
      const base = baseFor(media.node);
      const files = [
        { label: 'A', file: hazeOut, fileName: `A_${base}_haze.mp4`, mimetype: 'video/mp4', desc: 'gaya Haze penuh, .mp4 (format lama bot)' },
        { label: 'B', file: hazeOut, fileName: `B_${base}_haze.mov`, mimetype: 'video/quicktime', desc: 'gaya Haze penuh, .mov' },
        { label: 'C', file: cleanOut, fileName: `C_${base}_bersih.mov`, mimetype: 'video/quicktime', desc: 'gaya iPhone bersih, .mov' },
        { label: 'D', file: hazeOut, fileName: `D_${base}_haze.mp4`, mimetype: 'application/octet-stream', desc: 'gaya Haze penuh, dihantar sebagai fail biasa (lalai)' },
      ];
      const original = toNum(media.node.fileLength) || fs.statSync(input).size;
      if (original <= 64 * 1048576) {
        files.push({ label: 'E', file: input, fileName: `E_asal_${media.node.fileName || `video${extFor(media.node)}`}`, mimetype: media.node.mimetype || 'video/quicktime', desc: 'fail asal anda tanpa diubah (kawalan)' });
      }
      for (const f of files) {
        await send(chat, { document: { url: f.file }, mimetype: f.mimetype, fileName: f.fileName, caption: `🧪 ${f.label}: ${f.desc}` });
      }
      await send(chat, { text: T.testDone(files.map((f) => f.label)) }, { quoted: msg });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function infoJob({ chat, msg, media }) {
    fs.mkdirSync(config.workDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(config.workDir, 'info-'));
    try {
      const input = path.join(dir, `input${extFor(media.node)}`);
      await deps.download(media.waMessage, input);
      const text = await deps.analyzeText(input, media);
      const note = media.kind === 'video' ? '\n\nℹ️ Ini video yang sudah dimampat WhatsApp — hantar sebagai dokumen untuk semak fail asal.' : '';
      await send(chat, { text: text + note }, { quoted: msg });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function enqueue(ctx, media, opts, kind = 'process') {
    const { chat, msg, user } = ctx;
    const reply = (text) => send(chat, { text }, { quoted: msg });
    if (!isVideoNode(media)) return reply(T.notVideo());
    if (queue.has(user)) return reply(T.alreadyQueued(queue.position(user)));
    const size = toNum(media.node.fileLength);
    if (size > config.maxFileMb * 1048576) return reply(T.tooBig(size, config.maxFileMb));
    const seconds = toNum(media.node.seconds);
    if (seconds > config.maxDurationSec) return reply(T.tooLong(seconds, config.maxDurationSec));
    const job = queue.push(user, () => (kind === 'test' ? testJob({ ...ctx, media }) : processJob({ ...ctx, media, opts })));
    const pos = queue.position(user);
    if (pos > 0) await reply(T.queued(pos));
    try {
      await job;
    } catch (err) {
      log(`job failed: ${err.message}`);
      await reply(T.failed(err.message)).catch(() => {});
    }
  }

  return async function handle(msg) {
    if (!msg?.message || !msg.key?.remoteJid) return;
    const chat = msg.key.remoteJid;
    if (chat === 'status@broadcast' || chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) return;
    if (msg.key.fromMe && (config.allowSelf === false || sentIds.has(msg.key.id))) return;
    const ts = toNum(msg.messageTimestamp);
    if (ts && ts < startedAt - 1800) return; // ignore a stale backlog after downtime

    const who = senderOf(msg);
    const content = normalizeMessageContent(msg.message);
    const text = textOf(content);
    const cmd = parseCommand(text, config.prefix);
    // Messages typed on the bot's own number only count when they are commands (e.g. a document captioned ".max").
    if (msg.key.fromMe && !cmd) return;
    const reply = (t) => send(chat, { text: t }, { quoted: msg });

    // Where the bot works.
    if (who.isGroup) {
      if (replyIn === 'private') return;
      if (cmd?.name === 'id') return reply(`🆔 ID group ini:\n${chat}`);
      if (groupIds.length && !groupIds.includes(chat)) return;
    } else if (replyIn === 'group') {
      return;
    }
    // Optional allow-list of people (the bot's own number is always allowed).
    if (config.allowed.length && !msg.key.fromMe && !who.numbers.some((n) => config.allowed.includes(n) || config.owners.includes(n))) return;

    const own = mediaOf(content);
    const media = own ? { ...own, waMessage: msg } : quotedOf(msg, content);
    const ctx = { chat, msg, user: who.user, isGroup: who.isGroup };

    if (cmd) {
      const { name, args } = cmd;
      if (['menu', 'help', 'start', 'bantuan'].includes(name)) return reply(T.menu(config.prefix, who.isGroup));
      if (name === 'ping') return reply('pong 🏓');
      if (name === 'id') return reply(`🆔 ${chat}`);
      if (['status', 'queue', 'giliran'].includes(name)) return reply(T.status(queue));
      if (['info', 'cek', 'check', 'semak'].includes(name)) {
        if (!media) return reply(T.needMedia(config.prefix, name));
        try {
          return await infoJob({ chat, msg, media });
        } catch (err) {
          return reply(T.failed(err.message));
        }
      }
      if (['tt', 'tiktok'].includes(name)) {
        if (!media) return reply(T.needMedia(config.prefix, name));
        return enqueue(ctx, media, optionsFrom(config, config.defaultMode, args, 'tt'));
      }
      if (MODE_ALIASES[name] || name === 'haze') {
        // resolution modes belong to the re-encoding (haze) method
        if (!media) return reply(T.needMedia(config.prefix, name));
        return enqueue(ctx, media, optionsFrom(config, MODE_ALIASES[name] || config.defaultMode, args, 'haze'));
      }
      if (['uji', 'test', 'tes'].includes(name)) {
        if (!media) return reply(T.needMedia(config.prefix, name));
        return enqueue(ctx, media, null, 'test');
      }
      return; // unknown command: stay quiet
    }

    if (!own || config.autoProcess === false) return; // plain chatter never gets a reply
    if (own.kind === 'document') {
      // The main flow: a video sent as a document comes back converted, also as a document.
      if (isVideoNode(own)) return enqueue(ctx, media, optionsFrom(config, config.defaultMode, text.toLowerCase().split(/\s+/)));
      return who.isGroup ? undefined : reply(T.notVideo());
    }
    // A normal (WhatsApp-compressed) video: processed on its own only in private chats;
    // in groups people share videos all the time, so it needs a command there.
    if (!who.isGroup) return enqueue(ctx, media, optionsFrom(config, config.defaultMode, text.toLowerCase().split(/\s+/)));
  };
}
