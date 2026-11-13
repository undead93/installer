// Real I/O for the router: WhatsApp send/download (Baileys), the engine child process and analysis.
// Kept apart from index.js so the full document-in -> document-out path can be tested without a live socket.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { downloadMediaMessage } from 'baileys';
import { ROOT } from '../config.js';
import { analyze, formatAnalysis } from '../engine/analyze.js';
import { ffprobe } from '../engine/ffmpeg.js';

const CLI = path.join(ROOT, 'src', 'cli.js');

/** Run the engine in a child process so encoding never blocks the WhatsApp socket. */
export function runEngine(config, input, output, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [CLI, input, '-o', output, '--json', '--mode', opts.mode, '--fps', String(opts.fps), '--preset', opts.preset, '--crf', String(opts.crf), '--tag', config.encoderTag];
    if (opts.pad === false) args.push('--no-pad');
    if (opts.dupAudio === false) args.push('--no-dup-audio');
    if (opts.cleanCopy) args.push('--clean-copy', opts.cleanCopy);
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
        if (m.type === 'progress') {
          try {
            onProgress(m);
          } catch {
            // never let a progress callback throw inside a stream event (it would crash the bot)
          }
        } else if (m.type === 'done') result = m;
        else if (m.type === 'error') error = m.message;
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => (result ? resolve(result) : reject(new Error(error || stderr.trim().split('\n').pop() || `enjin keluar dengan kod ${code}`))));
  });
}

/** getSock() returns the current Baileys socket (it changes after a reconnect). */
export function createDeps({ getSock, logger, config }) {
  return {
    send: (chat, content, options) => getSock().sendMessage(chat, content, options),

    download: async (waMessage, file) => {
      const sock = getSock();
      const stream = await downloadMediaMessage(waMessage, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage });
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

    runEngine: (input, output, opts, onProgress) => runEngine(config, input, output, opts, onProgress),

    analyzeText: async (file, media) => {
      const a = await analyze(file);
      a.movie?.src.close();
      a.file = media.node.fileName || a.file;
      return formatAnalysis(a);
    },
  };
}
