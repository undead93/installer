#!/usr/bin/env node
// Command line front-end for the engine. The WhatsApp bot runs this as a child process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { processVideo } from './engine/pipeline.js';
import { analyze, formatAnalysis } from './engine/analyze.js';
import { parseMovie } from './engine/mp4.js';

const HELP = `Guna:
  node src/cli.js <input> [-o output.mp4] [pilihan]   proses video (kaedah TikTok HD)
  node src/cli.js info <input>                         semak sama ada video sedia untuk TikTok HD
  node src/cli.js compare <a> <b>                      banding struktur dua fail trek demi trek

Pilihan:
  --mode max|hd|keep    max = 4K 2160p (lalai), hd = 1080p, keep = resolusi asal
  --fps 30|60           had fps (lalai 30, tidak pernah gandakan frame)
  --preset <nama>       preset x264: veryfast, faster, fast, medium (lalai), slow
  --crf <n>             kualiti x264 (lalai 16), dihadkan oleh --maxrate & lantai QP 21
  --maxrate <n>         contoh 11M (lalai ikut resolusi)
  --tag <teks>          teks tag encoder (©too)
  --no-pad              jangan tambah 17 frame AAC senyap
  --no-dup-audio        jangan gandakan trek AAC
  --no-apple-tracks     buang trek metadata kamera iPhone (mebx/APAC)
  --clean-copy <fail>   tulis juga salinan "bersih" (tanpa AAC pendua & frame senyap) dari encode yang sama
  --no-apple-sei        jangan tambah SEI encoder Apple / nal_ref_idc gaya Apple
  --json                cetak kemajuan & keputusan sebagai baris JSON`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') out.output = argv[++i];
    else if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a === '--json' || a === '-h' || a === '--help') out[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const parseRate = (s) => {
  if (!s) return 0;
  const m = String(s).match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1));
};

function md5Samples(movie, track) {
  const h = crypto.createHash('md5');
  for (const s of track.samples) h.update(movie.src.read(s.offset, s.size));
  return h.digest('hex').slice(0, 12);
}

function describe(file) {
  const m = parseMovie(file);
  try {
    const rows = m.tracks.map((t) => ({
      id: t.id,
      handler: t.handler,
      fourcc: t.fourcc,
      samples: t.samples.length,
      bytes: t.samples.reduce((a, s) => a + s.size, 0),
      stsd: t.stsdEntries.length,
      flags: t.tkhd.flags,
      tref: t.tref.map((r) => `${r.type}->${r.ids.join('/')}`).join(' '),
      md5: md5Samples(m, t),
    }));
    return { brand: m.brand, top: m.topLevel.join(' '), timescale: m.mvhd.timescale, keys: Object.keys(m.appleKeys), rows };
  } finally {
    m.src.close();
  }
}

// Exit quietly when the reader goes away (e.g. `| head`).
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  if (!cmd || args.help || args.h) {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === 'info') {
    const a = await analyze(rest[0]);
    a.movie?.src.close();
    if (args.json) console.log(JSON.stringify({ type: 'info', text: formatAnalysis(a), tiktok: a.tiktok, video: a.video, apple: a.apple }));
    else console.log(formatAnalysis(a));
    return;
  }

  if (cmd === 'compare') {
    for (const f of rest.slice(0, 2)) {
      const d = describe(f);
      console.log(`\n== ${path.basename(f)}  brand=${JSON.stringify(d.brand)} timescale=${d.timescale}\n   top-level: ${d.top}\n   apple keys: ${d.keys.join(', ') || '-'}`);
      for (const r of d.rows) {
        console.log(`   #${r.id} ${r.handler} ${r.fourcc} n=${r.samples} bytes=${r.bytes} stsd=${r.stsd} flags=${r.flags} md5=${r.md5} ${r.tref}`);
      }
    }
    return;
  }

  const input = cmd;
  if (!fs.existsSync(input)) throw new Error(`Fail tidak wujud: ${input}`);
  const output = args.output || path.join(path.dirname(input), `${path.parse(input).name}_hd.mp4`);
  const options = {
    mode: args.mode,
    fps: args.fps ? Number(args.fps) : undefined,
    preset: args.preset,
    crf: args.crf ? Number(args.crf) : undefined,
    maxrate: parseRate(args.maxrate) || undefined,
    encoderTag: args.tag,
    pad: args.pad !== false,
    dupAudio: args['dup-audio'] !== false,
    keepAppleTracks: args['apple-tracks'] !== false,
    appleBitstream: args['apple-sei'] !== false,
    variants: args['clean-copy'] ? [{ output: args['clean-copy'], pad: false, dupAudio: false }] : undefined,
  };
  let lastPrint = 0;
  const res = await processVideo(input, output, options, (p) => {
    const now = Date.now();
    if (args.json) {
      if (now - lastPrint > 1000 || p.done || p.stage === 'mux') {
        lastPrint = now;
        console.log(JSON.stringify({ type: 'progress', ...p }));
      }
    } else if (now - lastPrint > 1000 || p.done) {
      lastPrint = now;
      process.stderr.write(`\r[${p.stage}] ${p.percent.toFixed(1)}% ${p.fps ? `${p.fps} fps` : ''} ${p.speed || ''}   `);
    }
  });
  if (args.json) {
    console.log(JSON.stringify({ type: 'done', ...res }));
  } else {
    const r = res.result;
    process.stderr.write('\n');
    console.log(`✅ Siap dalam ${res.seconds.toFixed(1)}s -> ${res.output}`);
    console.log(`   ${r.width}x${r.height} ${res.plan.fps}fps H.264, ${(r.bitrate / 1e6).toFixed(1)} Mbps, ${(r.size / 1048576).toFixed(1)} MB, ${r.duration.toFixed(2)}s`);
    console.log(`   trek: ${r.tracks.map((t) => `${t.id}:${t.fourcc}`).join(' ')}`);
  }
}

main().catch((err) => {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ type: 'error', message: err.message }));
  else console.error(`❌ ${err.message}`);
  process.exit(1);
});
