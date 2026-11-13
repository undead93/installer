// QuickTime movie writer that lays files out the way iPhone/AVFoundation does:
//   ftyp('qt  ') + wide + mdat (0.5 s interleaved chunks) [+ small tail mdat] + moov
// Sample data is streamed from the source files, never fully loaded in memory.
import fs from 'node:fs';

export const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff);
  return b;
};
export const i16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(v);
  return b;
};
export const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
export const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v | 0);
  return b;
};
const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v));
  return b;
};
const ascii = (s) => Buffer.from(s, 'latin1');

export function box(type, ...parts) {
  const body = Buffer.concat(parts.flat(Infinity).filter(Boolean));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

export function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE((((version & 0xff) << 24) | (flags & 0xffffff)) >>> 0);
  return box(type, vf, ...parts);
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const matrixBuf = (m = IDENTITY) => Buffer.concat(m.map((v) => i32(v)));

function pascal(name) {
  const s = Buffer.from(name, 'utf8');
  return Buffer.concat([Buffer.from([s.length]), s]);
}

/** Apple media handler, e.g. ('soun', 'Core Media Audio'). */
export function mediaHandler(sub, name) {
  return fullBox('hdlr', 0, 0, ascii('mhlr'), ascii(sub), ascii('appl'), u32(0), u32(0), pascal(name));
}

export const dataHandler = () =>
  fullBox('hdlr', 0, 0, ascii('dhlr'), ascii('alis'), ascii('appl'), u32(0), u32(0), pascal('Core Media Data Handler'));
export const dataInfo = () => box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('alis', 0, 1)));
export const videoMediaHeader = () => fullBox('vmhd', 0, 1, u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000));
export const soundMediaHeader = () => fullBox('smhd', 0, 0, u16(0), u16(0));

export function trackAperture(width, height) {
  const dims = () => [u32(Math.round(width * 65536)), u32(Math.round(height * 65536))];
  return box('tapt', fullBox('clef', 0, 0, dims()), fullBox('prof', 0, 0, dims()), fullBox('enof', 0, 0, dims()));
}

function runLength(values) {
  const runs = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  return runs;
}

function buildStbl(track, chunks, use64) {
  const s = track.samples;
  const parts = {};
  parts.stsd = fullBox('stsd', 0, 0, u32(track.stsdEntries.length), ...track.stsdEntries);

  const stts = runLength(s.map((x) => x.dur));
  parts.stts = fullBox('stts', 0, 0, u32(stts.length), ...stts.map(([c, d]) => [u32(c), u32(d)]));

  if (track.writeCtts && s.some((x) => x.cto !== 0)) {
    const ctts = runLength(s.map((x) => x.cto));
    // Version 0 with signed offsets — exactly what AVFoundation writes (paired with cslg).
    parts.ctts = fullBox('ctts', 0, 0, u32(ctts.length), ...ctts.map(([c, o]) => [u32(c), i32(o)]));
    if (track.writeCslg) {
      let least = Infinity;
      let greatest = -Infinity;
      let start = Infinity;
      let end = -Infinity;
      for (const x of s) {
        least = Math.min(least, x.cto);
        greatest = Math.max(greatest, x.cto);
        start = Math.min(start, x.dts + x.cto);
        end = Math.max(end, x.dts + x.cto + x.dur);
      }
      parts.cslg = fullBox('cslg', 0, 0, i32(Math.max(0, -least)), i32(least), i32(greatest), i32(start), i32(end));
    }
  }

  if (track.writeStss && s.some((x) => !x.sync)) {
    const nums = [];
    s.forEach((x, i) => x.sync && nums.push(i + 1));
    parts.stss = fullBox('stss', 0, 0, u32(nums.length), ...nums.map(u32));
  }

  if (track.writeSdtp) parts.sdtp = fullBox('sdtp', 0, 0, Buffer.from(s.map((x) => x.dep ?? 0)));

  parts.sgpd = track.sgpd || [];
  parts.sbgp = (track.sbgp || []).map((g) => {
    const runs = runLength(Array.from(g.idx));
    return fullBox('sbgp', 0, 0, ascii(g.type), u32(runs.length), ...runs.map(([c, gi]) => [u32(c), u32(gi)]));
  });

  const stsc = [];
  chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last.spc !== c.count || last.sdi !== c.sdi) stsc.push({ first: i + 1, spc: c.count, sdi: c.sdi });
  });
  parts.stsc = fullBox('stsc', 0, 0, u32(stsc.length), ...stsc.map((e) => [u32(e.first), u32(e.spc), u32(e.sdi)]));

  const fixed = s.length > 0 && s.every((x) => x.size === s[0].size) ? s[0].size : 0;
  parts.stsz = fixed
    ? fullBox('stsz', 0, 0, u32(fixed), u32(s.length))
    : fullBox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size)));

  parts.stco = use64
    ? fullBox('co64', 0, 0, u32(chunks.length), ...chunks.map((c) => u64(c.offset)))
    : fullBox('stco', 0, 0, u32(chunks.length), ...chunks.map((c) => u32(c.offset)));

  // Box order copied from AVFoundation output for each kind of track.
  const order =
    track.kind === 'video'
      ? ['stsd', 'stts', 'ctts', 'cslg', 'stss', 'sdtp', 'stsc', 'stsz', 'stco']
      : track.kind === 'audio'
        ? ['stsd', 'sgpd', 'sbgp', 'stts', 'stss', 'stsc', 'stsz', 'stco']
        : ['stsd', 'sgpd', 'sbgp', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco'];
  return box('stbl', ...order.map((k) => parts[k]));
}

function mediaDuration(track) {
  return track.samples.reduce((a, x) => a + x.dur, 0);
}

function buildTrak(track, chunks, movieTimescale, use64) {
  const mdur = mediaDuration(track);
  const elst = track.elst || [{ segDur: Math.floor((mdur / track.timescale) * movieTimescale), mediaTime: 0, rate: 1 }];
  const tdur = elst.reduce((a, e) => a + e.segDur, 0);
  const t = track.tkhd;
  const tkhd = fullBox(
    'tkhd',
    0,
    t.flags,
    u32(0),
    u32(0),
    u32(track.id),
    u32(0),
    u32(tdur),
    Buffer.alloc(8),
    i16(t.layer || 0),
    i16(t.altGroup || 0),
    i16(t.volume || 0),
    u16(0),
    matrixBuf(t.matrix),
    u32(Math.round((t.width || 0) * 65536)),
    u32(Math.round((t.height || 0) * 65536)),
  );
  const edts = box(
    'edts',
    fullBox('elst', 0, 0, u32(elst.length), ...elst.map((e) => [u32(e.segDur), i32(e.mediaTime), i32(Math.round((e.rate ?? 1) * 65536))])),
  );
  const tref = track.tref?.length ? box('tref', ...track.tref.map((r) => box(r.type, ...r.ids.map(u32)))) : null;
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(mdur), u16(track.language ?? 0x55c4), u16(0));
  const minf = box('minf', track.mediaHeader, track.minfHdlr || dataHandler(), track.dinf || dataInfo(), buildStbl(track, chunks, use64));
  const mdia = box('mdia', mdhd, track.elng, mediaHandler(track.handlerSub, track.handlerName), minf);
  return { trak: box('trak', tkhd, track.tapt, edts, tref, mdia), duration: tdur };
}

/** Split samples into time-window chunks (AVFoundation interleaves every 0.5 s). */
function planChunks(tracks, chunkSeconds) {
  const main = [];
  const ptr = tracks.map(() => 0);
  let maxT = 0;
  for (const t of tracks) {
    const last = t.samples[t.samples.length - 1];
    if (last) maxT = Math.max(maxT, (last.dts + last.dur) / t.timescale);
  }
  const windows = Math.max(1, Math.ceil(maxT / chunkSeconds) + 1);
  for (let w = 0; w < windows; w++) {
    const wEnd = (w + 1) * chunkSeconds;
    tracks.forEach((t, ti) => {
      if (t.shareChunksWith !== undefined) return;
      let chunk = null;
      while (ptr[ti] < t.samples.length) {
        const s = t.samples[ptr[ti]];
        if (s.tail) break;
        if (w < windows - 1 && s.dts / t.timescale >= wEnd) break;
        if (!chunk || chunk.sdi !== s.sdi) {
          chunk = { ti, sdi: s.sdi, samples: [] };
          main.push(chunk);
        }
        chunk.samples.push(s);
        ptr[ti]++;
      }
    });
  }
  const tail = [];
  tracks.forEach((t, ti) => {
    if (t.shareChunksWith !== undefined) return;
    let chunk = null;
    for (; ptr[ti] < t.samples.length; ptr[ti]++) {
      const s = t.samples[ptr[ti]];
      if (!chunk || chunk.sdi !== s.sdi) {
        chunk = { ti, sdi: s.sdi, samples: [] };
        tail.push(chunk);
      }
      chunk.samples.push(s);
    }
  });
  return { main, tail };
}

const SCRATCH = Buffer.allocUnsafe(4 * 1024 * 1024);

function copyRange(fd, src, start, len, pos) {
  let done = 0;
  while (done < len) {
    const n = fs.readSync(src.fd, SCRATCH, 0, Math.min(SCRATCH.length, len - done), start + done);
    if (n <= 0) throw new Error(`Unexpected end of ${src.path}`);
    fs.writeSync(fd, SCRATCH, 0, n, pos + done);
    done += n;
  }
  return pos + len;
}

function writeChunk(fd, chunk, pos) {
  const s = chunk.samples;
  let i = 0;
  while (i < s.length) {
    const a = s[i];
    if (a.data) {
      fs.writeSync(fd, a.data, 0, a.data.length, pos);
      pos += a.data.length;
      i++;
      continue;
    }
    let len = a.size;
    let j = i + 1;
    while (j < s.length && !s[j].data && s[j].src === a.src && s[j].offset === a.offset + len) {
      len += s[j].size;
      j++;
    }
    pos = copyRange(fd, a.src, a.offset, len, pos);
    i = j;
  }
  return pos;
}

const chunkBytes = (c) => c.samples.reduce((a, x) => a + x.size, 0);

/**
 * tracks: array of OutTrack objects (see mux.js). Returns a small report.
 */
export function writeQuickTime(outPath, { tracks, movieTimescale = 1000, encoderTag = null, chunkSeconds = 0.5 }) {
  const plan = planChunks(tracks, chunkSeconds);
  const mainBytes = plan.main.reduce((a, c) => a + chunkBytes(c), 0);
  const tailBytes = plan.tail.reduce((a, c) => a + chunkBytes(c), 0);
  const large = 8 + mainBytes > 0xffffffff;

  const fd = fs.openSync(outPath, 'w');
  try {
    let pos = 0;
    const put = (b) => {
      fs.writeSync(fd, b, 0, b.length, pos);
      pos += b.length;
    };
    put(box('ftyp', ascii('qt  '), u32(0), ascii('qt  ')));
    if (large) {
      // The `wide` placeholder exists so a 64-bit mdat header can replace it — do just that.
      put(Buffer.concat([u32(1), ascii('mdat'), u64(16 + mainBytes)]));
    } else {
      put(box('wide'));
      put(Buffer.concat([u32(8 + mainBytes), ascii('mdat')]));
    }
    for (const c of plan.main) {
      c.offset = pos;
      pos = writeChunk(fd, c, pos);
    }
    if (plan.tail.length) {
      put(Buffer.concat([u32(8 + tailBytes), ascii('mdat')]));
      for (const c of plan.tail) {
        c.offset = pos;
        pos = writeChunk(fd, c, pos);
      }
    }

    const use64 = pos > 0xffffffff;
    const perTrack = tracks.map(() => []);
    for (const c of [...plan.main, ...plan.tail]) perTrack[c.ti].push({ offset: c.offset, count: c.samples.length, sdi: c.sdi });
    tracks.forEach((t, ti) => {
      if (t.shareChunksWith !== undefined) {
        perTrack[ti] = perTrack[t.shareChunksWith].map((c) => ({ ...c, sdi: 1 }));
      }
    });

    let movieDur = 0;
    const traks = tracks.map((t, ti) => {
      const { trak, duration } = buildTrak(t, perTrack[ti], movieTimescale, use64);
      movieDur = Math.max(movieDur, duration);
      return trak;
    });
    const nextId = Math.max(...tracks.map((t) => t.id)) + 1;
    const mvhd = fullBox(
      'mvhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(movieTimescale),
      u32(movieDur),
      u32(0x10000),
      u16(0x100),
      Buffer.alloc(10),
      matrixBuf(),
      Buffer.alloc(24),
      u32(nextId),
    );
    let udta = null;
    if (encoderTag) {
      const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('mdir'), Buffer.alloc(12), Buffer.alloc(1));
      const item = box('\xa9too', box('data', u32(1), u32(0), Buffer.from(encoderTag, 'utf8')));
      udta = box('udta', fullBox('meta', 0, 0, hdlr, box('ilst', item)));
    }
    put(box('moov', mvhd, ...traks, udta));
    return { size: pos, movieDuration: movieDur / movieTimescale, chunks: plan.main.length + plan.tail.length, large };
  } finally {
    fs.closeSync(fd);
  }
}
