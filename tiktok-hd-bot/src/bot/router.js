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

export function optionsFrom(config, mode, args = []) {
  const opts = { mode, fps: config.defaultFps, preset: config.preset, crf: config.crf };
  for (const a of args) {
    if (/^60(fps)?$/.test(a)) opts.fps = 60;
    else if (/^30(fps)?$/.test(a)) opts.fps = 30;
    else if (/^(laju|fast)$/.test(a)) opts.preset = 'faster';
    else if (MODE_ALIASES[a]) opts.mode = MODE_ALIASES[a];
  }
  return opts;
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
 */
export function createRouter(deps) {
  const { config, queue, log = () => {} } = deps;
  const startedAt = Math.floor(Date.now() / 1000);

  async function processJob({ chat, msg, media, opts }) {
    fs.mkdirSync(config.workDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(config.workDir, 'wa-'));
    let statusKey = null;
    const setStatus = async (text) => {
      try {
        if (!statusKey) statusKey = (await deps.send(chat, { text }, { quoted: msg }))?.key;
        else await deps.send(chat, { text, edit: statusKey });
      } catch {
        // progress edits are best effort
      }
    };
    try {
      if (media.kind === 'video') await deps.send(chat, { text: T.compressedWarning() }, { quoted: msg });
      await setStatus(T.downloading());
      const input = path.join(dir, `input${extFor(media.node)}`);
      await deps.download(media.waMessage, input);
      const duration = await deps.probeDuration(input);
      if (duration > config.maxDurationSec + 1) throw new Error(T.tooLong(duration, config.maxDurationSec));
      const output = path.join(dir, `${baseFor(media.node)}_hd.mp4`);
      let last = 0;
      const res = await deps.runEngine(input, output, opts, (p) => {
        try {
          const now = Date.now();
          if (now - last > 8000 || p.stage === 'mux') {
            last = now;
            setStatus(T.progress(p.stage, p.percent, p.fps));
          }
        } catch (err) {
          log(`progress update skipped: ${err.message}`); // a status message must never break the job
        }
      });
      await setStatus('✅ Selesai — menghantar fail...');
      await deps.send(chat, { document: { url: output }, mimetype: 'video/mp4', fileName: path.basename(output), caption: T.done(res) }, { quoted: msg });
      log(`done ${path.basename(output)} in ${Math.round(res.seconds)}s`);
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
      await deps.send(chat, { text: text + note }, { quoted: msg });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function enqueue({ chat, msg, user }, media, opts) {
    const reply = (text) => deps.send(chat, { text }, { quoted: msg });
    if (!isVideoNode(media)) return reply(T.notVideo());
    if (queue.has(user)) return reply(T.alreadyQueued(queue.position(user)));
    const size = toNum(media.node.fileLength);
    if (size > config.maxFileMb * 1048576) return reply(T.tooBig(size, config.maxFileMb));
    const seconds = toNum(media.node.seconds);
    if (seconds > config.maxDurationSec) return reply(T.tooLong(seconds, config.maxDurationSec));
    const job = queue.push(user, () => processJob({ chat, msg, media, opts }));
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
    if (!msg?.message || msg.key?.fromMe || !msg.key?.remoteJid) return;
    const chat = msg.key.remoteJid;
    if (chat === 'status@broadcast' || chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) return;
    const ts = toNum(msg.messageTimestamp);
    if (ts && ts < startedAt - 1800) return; // ignore a stale backlog after downtime
    const who = senderOf(msg);
    if (who.isGroup && !config.allowGroups) return;
    if (config.allowed.length && !who.numbers.some((n) => config.allowed.includes(n) || config.owners.includes(n))) return;

    const content = normalizeMessageContent(msg.message);
    const text = textOf(content);
    const own = mediaOf(content);
    const media = own ? { ...own, waMessage: msg } : quotedOf(msg, content);
    const cmd = parseCommand(text, config.prefix);
    const ctx = { chat, msg, user: who.user };
    const reply = (t) => deps.send(chat, { text: t }, { quoted: msg });

    if (cmd) {
      const { name, args } = cmd;
      if (['menu', 'help', 'start', 'bantuan'].includes(name)) return reply(T.menu(config.prefix));
      if (name === 'ping') return reply('pong 🏓');
      if (['status', 'queue', 'giliran'].includes(name)) return reply(T.status(queue));
      if (['info', 'cek', 'check', 'semak'].includes(name)) {
        if (!media) return reply(T.needMedia(config.prefix, name));
        try {
          return await infoJob({ chat, msg, media });
        } catch (err) {
          return reply(T.failed(err.message));
        }
      }
      if (MODE_ALIASES[name]) {
        if (!media) return reply(T.needMedia(config.prefix, name));
        return enqueue(ctx, media, optionsFrom(config, MODE_ALIASES[name], args));
      }
      if (who.isGroup) return; // unknown command in a group: stay quiet
    }

    if (own && config.autoProcess && !who.isGroup) {
      if (!isVideoNode(own)) return own.kind === 'document' ? reply(T.notVideo()) : undefined;
      return enqueue(ctx, media, optionsFrom(config, config.defaultMode, text.toLowerCase().split(/\s+/)));
    }
    if (!who.isGroup && text && !cmd) return reply(T.menu(config.prefix));
  };
}
