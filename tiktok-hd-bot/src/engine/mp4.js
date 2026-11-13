// Minimal ISO-BMFF / QuickTime reader.
// Reads only the `moov` box into memory; sample data stays on disk and is
// copied later by the writer, so multi-GB inputs are fine.
import fs from 'node:fs';

export class Source {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }

  read(pos, len) {
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(this.fd, buf, off, len - off, pos + off);
      if (n <= 0) throw new Error(`Unexpected end of file in ${this.path} at byte ${pos + off}`);
      off += n;
    }
    return buf;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export function readBoxHeader(buf, p, end) {
  if (p + 8 > end) return null;
  let size = buf.readUInt32BE(p);
  const type = buf.toString('latin1', p + 4, p + 8);
  let header = 8;
  if (size === 1) {
    if (p + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(p + 8));
    header = 16;
  } else if (size === 0) {
    size = end - p;
  }
  if (size < header || p + size > end) return null;
  return { type, start: p, body: p + header, end: p + size };
}

export function* boxes(buf, start = 0, end = buf.length) {
  let p = start;
  for (;;) {
    const h = readBoxHeader(buf, p, end);
    if (!h) return;
    yield h;
    p = h.end;
  }
}

export function child(buf, parent, type) {
  if (!parent) return null;
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

export function children(buf, parent, type) {
  const out = [];
  if (!parent) return out;
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) out.push(b);
  return out;
}

export function descend(buf, parent, ...types) {
  let cur = parent;
  for (const t of types) {
    cur = child(buf, cur, t);
    if (!cur) return null;
  }
  return cur;
}

/** Scan the top-level boxes of a file without reading their payloads. */
export function scanTopLevel(src) {
  const out = [];
  let p = 0;
  while (p + 8 <= src.size) {
    const h = src.read(p, Math.min(16, src.size - p));
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = src.size - p;
    }
    if (size < header || p + size > src.size) break;
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

const raw = (buf, b) => (b ? Buffer.from(buf.subarray(b.start, b.end)) : null);

function parseTkhd(buf, b) {
  const v = buf[b.body];
  const flags = buf.readUIntBE(b.body + 1, 3);
  let p = b.body + 4;
  let id;
  let duration;
  if (v === 1) {
    p += 16; // creation + modification
    id = buf.readUInt32BE(p);
    p += 8; // id + reserved
    duration = Number(buf.readBigUInt64BE(p));
    p += 8;
  } else {
    p += 8;
    id = buf.readUInt32BE(p);
    p += 8;
    duration = buf.readUInt32BE(p);
    p += 4;
  }
  p += 8; // reserved
  const layer = buf.readInt16BE(p);
  const altGroup = buf.readInt16BE(p + 2);
  const volume = buf.readInt16BE(p + 4);
  p += 8; // layer, alt group, volume, reserved
  const matrix = [];
  for (let i = 0; i < 9; i++) matrix.push(buf.readInt32BE(p + 4 * i));
  p += 36;
  const width = buf.readUInt32BE(p) / 65536;
  const height = buf.readUInt32BE(p + 4) / 65536;
  return { version: v, flags, id, duration, layer, altGroup, volume, matrix, width, height };
}

function parseMdhd(buf, b) {
  const v = buf[b.body];
  let p = b.body + 4;
  let timescale;
  let duration;
  if (v === 1) {
    p += 16;
    timescale = buf.readUInt32BE(p);
    duration = Number(buf.readBigUInt64BE(p + 4));
    p += 12;
  } else {
    p += 8;
    timescale = buf.readUInt32BE(p);
    duration = buf.readUInt32BE(p + 4);
    p += 8;
  }
  const language = buf.readUInt16BE(p);
  return { timescale, duration, language };
}

function parseMvhd(buf, b) {
  const v = buf[b.body];
  const p = b.body + 4;
  if (v === 1) {
    return {
      creation: Number(buf.readBigUInt64BE(p)),
      timescale: buf.readUInt32BE(p + 16),
      duration: Number(buf.readBigUInt64BE(p + 20)),
    };
  }
  return { creation: buf.readUInt32BE(p), timescale: buf.readUInt32BE(p + 8), duration: buf.readUInt32BE(p + 12) };
}

function parseHdlr(buf, b) {
  if (!b) return { componentType: '', subtype: '', name: '' };
  const componentType = buf.toString('latin1', b.body + 4, b.body + 8);
  const subtype = buf.toString('latin1', b.body + 8, b.body + 12);
  let name = '';
  const nameStart = b.body + 24;
  if (nameStart < b.end) {
    const len = buf[nameStart];
    // QuickTime uses a Pascal string, ISO uses a C string.
    if (componentType === 'mhlr' || componentType === 'dhlr') {
      name = buf.toString('utf8', nameStart + 1, Math.min(b.end, nameStart + 1 + len));
    } else {
      name = buf.toString('utf8', nameStart, b.end).replace(/\0.*$/s, '');
    }
  }
  return { componentType, subtype, name };
}

function parseElst(buf, b) {
  if (!b) return null;
  const v = buf[b.body];
  const n = buf.readUInt32BE(b.body + 4);
  const out = [];
  let p = b.body + 8;
  for (let i = 0; i < n; i++) {
    if (v === 1) {
      out.push({
        segDur: Number(buf.readBigUInt64BE(p)),
        mediaTime: Number(buf.readBigInt64BE(p + 8)),
        rate: buf.readInt32BE(p + 16) / 65536,
      });
      p += 20;
    } else {
      out.push({ segDur: buf.readUInt32BE(p), mediaTime: buf.readInt32BE(p + 4), rate: buf.readInt32BE(p + 8) / 65536 });
      p += 12;
    }
  }
  return out;
}

function buildSamples(buf, stbl) {
  let sizes = [];
  const stsz = child(buf, stbl, 'stsz');
  const stz2 = child(buf, stbl, 'stz2');
  if (stsz) {
    const fixed = buf.readUInt32BE(stsz.body + 4);
    const n = buf.readUInt32BE(stsz.body + 8);
    sizes = new Array(n);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < n; i++) sizes[i] = buf.readUInt32BE(stsz.body + 12 + 4 * i);
  } else if (stz2) {
    const field = buf[stz2.body + 7];
    const n = buf.readUInt32BE(stz2.body + 8);
    sizes = new Array(n);
    const base = stz2.body + 12;
    for (let i = 0; i < n; i++) {
      if (field === 16) sizes[i] = buf.readUInt16BE(base + 2 * i);
      else if (field === 8) sizes[i] = buf[base + i];
      else sizes[i] = (buf[base + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;
    }
  }

  const offsets = [];
  const stco = child(buf, stbl, 'stco');
  const co64 = child(buf, stbl, 'co64');
  if (stco) {
    const n = buf.readUInt32BE(stco.body + 4);
    for (let i = 0; i < n; i++) offsets.push(buf.readUInt32BE(stco.body + 8 + 4 * i));
  } else if (co64) {
    const n = buf.readUInt32BE(co64.body + 4);
    for (let i = 0; i < n; i++) offsets.push(Number(buf.readBigUInt64BE(co64.body + 8 + 8 * i)));
  }

  const stscEntries = [];
  const stsc = child(buf, stbl, 'stsc');
  if (stsc) {
    const n = buf.readUInt32BE(stsc.body + 4);
    for (let i = 0; i < n; i++) {
      const p = stsc.body + 8 + 12 * i;
      stscEntries.push({ first: buf.readUInt32BE(p), spc: buf.readUInt32BE(p + 4), sdi: buf.readUInt32BE(p + 8) });
    }
  }

  const n = sizes.length;
  const samples = [];
  let si = 0;
  for (let e = 0; e < stscEntries.length && si < n; e++) {
    const { first, spc, sdi } = stscEntries[e];
    const last = e + 1 < stscEntries.length ? stscEntries[e + 1].first - 1 : offsets.length;
    for (let c = first; c <= last && si < n; c++) {
      let p = offsets[c - 1];
      if (p === undefined) break;
      for (let k = 0; k < spc && si < n; k++) {
        samples.push({ offset: p, size: sizes[si], sdi, dts: 0, dur: 0, cto: 0, sync: true, dep: undefined });
        p += sizes[si];
        si++;
      }
    }
  }

  const stts = child(buf, stbl, 'stts');
  if (stts) {
    const cnt = buf.readUInt32BE(stts.body + 4);
    let t = 0;
    let i = 0;
    for (let e = 0; e < cnt; e++) {
      const count = buf.readUInt32BE(stts.body + 8 + 8 * e);
      const delta = buf.readUInt32BE(stts.body + 12 + 8 * e);
      for (let k = 0; k < count && i < samples.length; k++, i++) {
        samples[i].dts = t;
        samples[i].dur = delta;
        t += delta;
      }
    }
  }

  const ctts = child(buf, stbl, 'ctts');
  if (ctts) {
    const cnt = buf.readUInt32BE(ctts.body + 4);
    let i = 0;
    for (let e = 0; e < cnt; e++) {
      const count = buf.readUInt32BE(ctts.body + 8 + 8 * e);
      const off = buf.readInt32BE(ctts.body + 12 + 8 * e); // signed in practice (QuickTime + ISO v1)
      for (let k = 0; k < count && i < samples.length; k++, i++) samples[i].cto = off;
    }
  }

  const stss = child(buf, stbl, 'stss');
  if (stss) {
    for (const s of samples) s.sync = false;
    const cnt = buf.readUInt32BE(stss.body + 4);
    for (let e = 0; e < cnt; e++) {
      const num = buf.readUInt32BE(stss.body + 8 + 4 * e);
      if (samples[num - 1]) samples[num - 1].sync = true;
    }
  }

  const sdtp = child(buf, stbl, 'sdtp');
  if (sdtp) {
    for (let i = 0; i < samples.length && sdtp.body + 4 + i < sdtp.end; i++) samples[i].dep = buf[sdtp.body + 4 + i];
  }

  return { samples, hasStss: Boolean(stss), hasSdtp: Boolean(sdtp) };
}

function parseSampleGroups(buf, stbl, n) {
  const sgpd = children(buf, stbl, 'sgpd').map((b) => ({
    type: buf.toString('latin1', b.body + 4, b.body + 8),
    raw: raw(buf, b),
  }));
  const sbgp = [];
  for (const b of children(buf, stbl, 'sbgp')) {
    const version = buf[b.body];
    const type = buf.toString('latin1', b.body + 4, b.body + 8);
    let p = b.body + 8;
    let param = null;
    if (version === 1) {
      param = buf.readUInt32BE(p);
      p += 4;
    }
    const count = buf.readUInt32BE(p);
    p += 4;
    const idx = new Uint32Array(n);
    let s = 0;
    for (let i = 0; i < count; i++) {
      const sc = buf.readUInt32BE(p);
      const gi = buf.readUInt32BE(p + 4);
      p += 8;
      for (let k = 0; k < sc && s < n; k++) idx[s++] = gi;
    }
    sbgp.push({ type, version, param, idx });
  }
  return { sgpd, sbgp };
}

function parseTrak(buf, trak) {
  const tkhd = parseTkhd(buf, child(buf, trak, 'tkhd'));
  const mdia = child(buf, trak, 'mdia');
  const mdhd = parseMdhd(buf, child(buf, mdia, 'mdhd'));
  const hdlr = parseHdlr(buf, child(buf, mdia, 'hdlr'));
  const minf = child(buf, mdia, 'minf');
  const stbl = child(buf, minf, 'stbl');
  const stsd = child(buf, stbl, 'stsd');
  const stsdEntries = [];
  if (stsd) for (const e of boxes(buf, stsd.body + 8, stsd.end)) stsdEntries.push(raw(buf, e));
  const trefBox = child(buf, trak, 'tref');
  const tref = [];
  if (trefBox) {
    for (const r of boxes(buf, trefBox.body, trefBox.end)) {
      const ids = [];
      for (let p = r.body; p + 4 <= r.end; p += 4) ids.push(buf.readUInt32BE(p));
      tref.push({ type: r.type, ids });
    }
  }
  const { samples, hasStss, hasSdtp } = stbl ? buildSamples(buf, stbl) : { samples: [], hasStss: false, hasSdtp: false };
  const mediaHeader =
    child(buf, minf, 'vmhd') || child(buf, minf, 'smhd') || child(buf, minf, 'gmhd') || child(buf, minf, 'nmhd') || child(buf, minf, 'sthd');
  return {
    id: tkhd.id,
    tkhd,
    mdhd,
    handler: hdlr.subtype,
    handlerName: hdlr.name,
    fourcc: stsdEntries[0] ? stsdEntries[0].toString('latin1', 4, 8) : null,
    stsdEntries,
    elst: parseElst(buf, descend(buf, trak, 'edts', 'elst')),
    tref,
    tapt: raw(buf, child(buf, trak, 'tapt')),
    elng: raw(buf, child(buf, mdia, 'elng')),
    mediaHeader: raw(buf, mediaHeader),
    minfHdlr: raw(buf, child(buf, minf, 'hdlr')),
    dinf: raw(buf, child(buf, minf, 'dinf')),
    groups: stbl ? parseSampleGroups(buf, stbl, samples.length) : { sgpd: [], sbgp: [] },
    hasStss,
    hasSdtp,
    samples,
  };
}

/** QuickTime `meta`/`keys`/`ilst` metadata (com.apple.quicktime.*), returns { key: value }. */
function parseQuickTimeKeys(buf, meta) {
  const out = {};
  if (!meta) return out;
  // QuickTime meta has no version/flags, ISO meta has 4 extra bytes.
  let scope = meta;
  const first = readBoxHeader(buf, meta.body, meta.end);
  if (!first || !['hdlr', 'keys', 'ilst'].includes(first.type)) scope = { ...meta, body: meta.body + 4 };
  const keysBox = child(buf, scope, 'keys');
  const ilst = child(buf, scope, 'ilst');
  if (!keysBox || !ilst) return out;
  const names = [];
  const count = buf.readUInt32BE(keysBox.body + 4);
  let p = keysBox.body + 8;
  for (let i = 0; i < count && p + 8 <= keysBox.end; i++) {
    const size = buf.readUInt32BE(p);
    names.push(buf.toString('utf8', p + 8, p + size));
    p += size;
  }
  for (const item of boxes(buf, ilst.body, ilst.end)) {
    const index = buf.readUInt32BE(item.start + 4); // the box "type" is the 1-based key index
    const data = child(buf, item, 'data');
    if (!data) continue;
    const typeCode = buf.readUInt32BE(data.body) & 0xffffff;
    const payload = buf.subarray(data.body + 8, data.end);
    let value;
    if (typeCode === 1) value = payload.toString('utf8');
    else if (typeCode === 21 || typeCode === 22) value = payload.length === 1 ? payload[0] : payload.readIntBE(0, Math.min(6, payload.length));
    else if (typeCode === 23 && payload.length === 4) value = payload.readFloatBE(0);
    else value = payload.toString('hex');
    if (names[index - 1]) out[names[index - 1]] = value;
  }
  return out;
}

export function parseMovie(path) {
  const src = new Source(path);
  try {
    const top = scanTopLevel(src);
    const moovH = top.find((b) => b.type === 'moov');
    if (!moovH) throw new Error('Tiada kotak "moov" — bukan fail MP4/MOV atau fail tidak lengkap');
    const ftypH = top.find((b) => b.type === 'ftyp');
    let brand = null;
    if (ftypH) brand = src.read(ftypH.body, 4).toString('latin1');
    const buf = src.read(moovH.start, moovH.end - moovH.start);
    const root = { type: 'moov', start: 0, body: moovH.body - moovH.start, end: buf.length };
    const mvhd = parseMvhd(buf, child(buf, root, 'mvhd'));
    const tracks = children(buf, root, 'trak').map((t) => parseTrak(buf, t));
    const appleKeys = parseQuickTimeKeys(buf, child(buf, root, 'meta'));
    return { src, brand, mvhd, tracks, appleKeys, topLevel: top.map((b) => b.type) };
  } catch (err) {
    src.close();
    throw err;
  }
}

/** Offset where child boxes start inside a raw sample entry (box header included). */
export function sampleEntryChildrenStart(entry) {
  const fourcc = entry.toString('latin1', 4, 8);
  if (['mp4a', 'apac', 'ac-3', 'ec-3', 'Opus', 'fLaC', 'alac', 'lpcm', 'sowt', 'twos'].includes(fourcc)) {
    const version = entry.readUInt16BE(16);
    return version === 1 ? 52 : version === 2 ? 72 : 36;
  }
  if (['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'mp4v', 'av01', 'vp09', 'apcn', 'apch'].includes(fourcc)) return 86;
  return 8;
}

/** Find a box inside a raw sample entry, looking into QuickTime `wave` containers too. */
export function findInSampleEntry(entry, type) {
  const stack = [{ start: sampleEntryChildrenStart(entry), end: entry.length }];
  while (stack.length) {
    const range = stack.pop();
    for (const b of boxes(entry, range.start, range.end)) {
      if (b.type === type) return b;
      if (b.type === 'wave') stack.push({ start: b.body, end: b.end });
    }
  }
  return null;
}
