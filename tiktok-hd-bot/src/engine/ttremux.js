// Post-processing for the "TikTok editor" method: takes the MP4 that ffmpeg 6.1 writes with
// -c copy +faststart +use_metadata_tags and changes only what the reference file changes on top of it:
//   - ftyp compatible brands isom/iso2/mp41 (no dby1) and no dvcC/dvvC box in the video sample entry
//   - 17 silent AAC frames appended at the end of mdat (9 with the normal config, 8 with a PCE config)
//   - a duplicate AAC track (id 3) sharing the same data, written after udta
// Everything else stays byte-for-byte what ffmpeg produced.
import fs from 'node:fs';
import { Source, scanTopLevel } from './mp4.js';
import { inspectMp4a, pceAsc, SILENT_STEREO_FRAME, SILENT_MONO_FRAME } from './aac.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta']);
const PAD_FRAMES = 17;

function parseTree(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw new Error(`bad box ${type}`);
    const node = { type };
    if (CONTAINERS.has(type)) node.children = parseTree(buf, p + hdr, p + size);
    else node.data = Buffer.from(buf.subarray(p + hdr, p + size));
    out.push(node);
    p += size;
  }
  return out;
}

function serialize(node) {
  const body = node.children ? Buffer.concat(node.children.map(serialize)) : node.data;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(node.type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

const find = (node, ...path) => path.reduce((n, t) => n && n.children.find((c) => c.type === t), node);
const clone = (node) => (node.children ? { type: node.type, children: node.children.map(clone) } : { type: node.type, data: Buffer.from(node.data) });

/** Replace the AudioSpecificConfig of an ffmpeg mp4a sample entry (4-byte descriptor lengths). */
function withAsc(entry, asc) {
  const esdsAt = entry.indexOf('esds') - 4;
  if (esdsAt < 0) throw new Error('no esds');
  const dsiAt = entry.indexOf(Buffer.from([0x05, 0x80, 0x80, 0x80]), esdsAt);
  if (dsiAt < 0) throw new Error('unexpected esds layout');
  const oldLen = entry[dsiAt + 4];
  const d = asc.length - oldLen;
  const out = Buffer.concat([entry.subarray(0, dsiAt + 4), Buffer.from([asc.length]), asc, entry.subarray(dsiAt + 5 + oldLen)]);
  out.writeUInt32BE(out.readUInt32BE(0) + d, 0); // sample entry size
  out.writeUInt32BE(out.readUInt32BE(esdsAt) + d, esdsAt); // esds size
  const esAt = esdsAt + 12; // 03 80 80 80 len
  const dcdAt = out.indexOf(Buffer.from([0x04, 0x80, 0x80, 0x80]), esAt);
  if (out[esAt] !== 0x03 || dcdAt < 0) throw new Error('unexpected esds layout');
  out[esAt + 4] += d;
  out[dcdAt + 4] += d;
  return out;
}

const u32 = (b, o) => b.readUInt32BE(o);

/** hvcC box with only its parameter-set arrays (VPS/SPS/PPS), like the reference — SEI arrays dropped. */
function hvcCWithoutSei(box) {
  const body = box.subarray(8);
  if (body.length < 23) return box;
  const n = body[22];
  const keep = [];
  let p = 23;
  for (let i = 0; i < n; i++) {
    const start = p;
    const type = body[p] & 63;
    const count = body.readUInt16BE(p + 1);
    p += 3;
    for (let k = 0; k < count; k++) p += 2 + body.readUInt16BE(p);
    if (type !== 39 && type !== 40) keep.push(body.subarray(start, p));
  }
  const head = Buffer.from(body.subarray(0, 23));
  head[22] = keep.length;
  const out = Buffer.concat([Buffer.alloc(8), head, ...keep, body.subarray(p)]);
  out.writeUInt32BE(out.length, 0);
  out.write('hvcC', 4, 'latin1');
  return out;
}

/**
 * videoTransform(index, au) -> Buffer: optional rewrite of each video access unit (decode order),
 * e.g. to add Apple SEI / Dolby Vision RPUs to a re-encoded stream.
 */
export function ttPostProcess(input, output, { pad = true, dup = true, videoTransform = null } = {}) {
  const src = new Source(input);
  try {
    const top = scanTopLevel(src);
    const types = top.map((b) => b.type).join(' ');
    if (types !== 'ftyp moov free mdat' && types !== 'ftyp moov mdat') throw new Error(`unexpected layout: ${types}`);
    const ftypBox = top[0];
    const moovBox = top[1];
    const mdatBox = top[top.length - 1];
    const moov = { type: 'moov', children: parseTree(src.read(moovBox.body, moovBox.end - moovBox.body)) };

    // ftyp: same brands as the reference (ffmpeg adds dby1 when Dolby Vision side data is present)
    const ftyp = src.read(ftypBox.body, ftypBox.end - ftypBox.body);
    const newFtyp = serialize({ type: 'ftyp', data: Buffer.concat([ftyp.subarray(0, 8), Buffer.from('isomiso2mp41', 'latin1')]) });

    const traks = moov.children.filter((c) => c.type === 'trak');
    const handlerOf = (t) => find(t, 'mdia', 'hdlr').data.toString('latin1', 8, 12);
    const video = traks.find((t) => handlerOf(t) === 'vide');
    const audio = traks.find((t) => handlerOf(t) === 'soun');

    // video sample entry: drop dvcC/dvvC (the reference carries Dolby Vision RPUs without them)
    if (video) {
      const stsd = find(video, 'mdia', 'minf', 'stbl', 'stsd');
      const entry = stsd.data.subarray(8);
      const kids = [];
      for (let p = 86; p + 8 <= entry.length; ) {
        const size = u32(entry, p);
        if (size < 8) break;
        const type = entry.toString('latin1', p + 4, p + 8);
        // dvcC/dvvC: the reference carries Dolby Vision RPUs without them; fiel: not in the reference
        if (type === 'hvcC') kids.push(hvcCWithoutSei(entry.subarray(p, p + size)));
        else if (!['dvcC', 'dvvC', 'dvwC', 'fiel'].includes(type)) kids.push(entry.subarray(p, p + size));
        p += size;
      }
      const fixed = Buffer.from(entry.subarray(0, 86));
      fixed.fill(0, 50, 82); // empty compressor name (ffmpeg writes "Lavc... libx265" when it encodes)
      const newEntry = Buffer.concat([fixed, ...kids]);
      newEntry.writeUInt32BE(newEntry.length, 0);
      stsd.data = Buffer.concat([stsd.data.subarray(0, 8), newEntry]);
    }

    let padBytes = Buffer.alloc(0);
    const mvhd = find(moov, 'mvhd');
    const movieTs = u32(mvhd.data, 12);
    if (audio && pad) {
      const stbl = find(audio, 'mdia', 'minf', 'stbl');
      const stsd = find(stbl, 'stsd');
      const entry1 = stsd.data.subarray(8, 8 + u32(stsd.data, 8));
      const info = inspectMp4a(entry1);
      const silent = info && info.asc.aot === 2 ? (info.channels === 2 ? SILENT_STEREO_FRAME : info.channels === 1 ? SILENT_MONO_FRAME : null) : null;
      if (silent) {
        const entry2 = withAsc(entry1, pceAsc(info.asc.sfi, info.channels));
        const stsdData = Buffer.concat([stsd.data.subarray(0, 4), Buffer.from([0, 0, 0, 2]), entry1, entry2]);
        stsd.data = stsdData;
        const stts = find(stbl, 'stts');
        const n = u32(stts.data, 4);
        const runs = [];
        for (let i = 0; i < n; i++) runs.push([u32(stts.data, 8 + 8 * i), u32(stts.data, 12 + 8 * i)]);
        const frameDur = runs.length ? runs[0][1] : 1024;
        if (runs.length && runs[runs.length - 1][1] === frameDur) runs[runs.length - 1][0] += PAD_FRAMES;
        else runs.push([PAD_FRAMES, frameDur]);
        const sttsData = Buffer.alloc(8 + 8 * runs.length);
        sttsData.writeUInt32BE(runs.length, 4);
        runs.forEach(([c, d2], i) => {
          sttsData.writeUInt32BE(c, 8 + 8 * i);
          sttsData.writeUInt32BE(d2, 12 + 8 * i);
        });
        stts.data = sttsData;

        const stsz = find(stbl, 'stsz');
        const fixed = u32(stsz.data, 4);
        const count = u32(stsz.data, 8);
        const sizes = fixed ? new Array(count).fill(fixed) : Array.from({ length: count }, (_, i) => u32(stsz.data, 12 + 4 * i));
        for (let k = 0; k < PAD_FRAMES; k++) sizes.push(silent.length);
        const stszData = Buffer.alloc(12 + 4 * sizes.length);
        stszData.writeUInt32BE(sizes.length, 8);
        sizes.forEach((s, i) => stszData.writeUInt32BE(s, 12 + 4 * i));
        stsz.data = stszData;

        const stco = find(stbl, 'stco') || find(stbl, 'co64');
        const big = stco.type === 'co64';
        const nChunks = u32(stco.data, 4);
        const stsc = find(stbl, 'stsc');
        const ne = u32(stsc.data, 4);
        const entries = [];
        for (let i = 0; i < ne; i++) entries.push([u32(stsc.data, 8 + 12 * i), u32(stsc.data, 12 + 12 * i), u32(stsc.data, 16 + 12 * i)]);
        entries.push([nChunks + 1, 9, 1], [nChunks + 2, 8, 2]);
        const stscData = Buffer.alloc(8 + 12 * entries.length);
        stscData.writeUInt32BE(entries.length, 4);
        entries.forEach((e, i) => e.forEach((v, j) => stscData.writeUInt32BE(v, 8 + 12 * i + 4 * j)));
        stsc.data = stscData;
        // two new chunks at the end of mdat; real offsets are filled in once moov's final size is known
        const w = big ? 8 : 4;
        const extra = Buffer.alloc(2 * w);
        stco.data = Buffer.concat([stco.data.subarray(0, 4), Buffer.alloc(4), stco.data.subarray(8), extra]);
        stco.data.writeUInt32BE(nChunks + 2, 4);
        stco.padChunks = [nChunks, nChunks + 1];

        const sbgp = find(stbl, 'sbgp');
        if (sbgp) {
          const m = u32(sbgp.data, 8);
          const sb = Buffer.concat([sbgp.data, Buffer.alloc(8)]);
          sb.writeUInt32BE(m + 1, 8);
          sb.writeUInt32BE(PAD_FRAMES, 12 + 8 * m);
          sb.writeUInt32BE(0, 16 + 8 * m);
          sbgp.data = sb;
        }

        // durations: mdhd (media), elst + tkhd (movie timescale), mvhd
        const mdhd = find(audio, 'mdia', 'mdhd');
        const ats = u32(mdhd.data, 12);
        const mediaDur = u32(mdhd.data, 16) + PAD_FRAMES * frameDur;
        mdhd.data.writeUInt32BE(mediaDur, 16);
        const elst = find(audio, 'edts', 'elst');
        const mediaTime = elst ? elst.data.readInt32BE(12) : 0;
        const segDur = Math.round(((mediaDur - Math.max(0, mediaTime)) / ats) * movieTs);
        if (elst) elst.data.writeUInt32BE(segDur, 8);
        find(audio, 'tkhd').data.writeUInt32BE(segDur, 20);
        padBytes = Buffer.concat(new Array(PAD_FRAMES).fill(silent));
      }
    }

    if (audio && dup) {
      const copy = clone(audio);
      const maxId = Math.max(...traks.map((t) => u32(find(t, 'tkhd').data, 12)));
      find(copy, 'tkhd').data.writeUInt32BE(maxId + 1, 12);
      const stbl = find(copy, 'stbl') || find(copy, 'mdia', 'minf', 'stbl');
      const stsd = find(stbl, 'stsd');
      const entry1 = stsd.data.subarray(8, 8 + u32(stsd.data, 8));
      stsd.data = Buffer.concat([stsd.data.subarray(0, 4), Buffer.from([0, 0, 0, 1]), entry1]);
      const stsc = find(stbl, 'stsc');
      for (let i = 0; i < u32(stsc.data, 4); i++) stsc.data.writeUInt32BE(1, 16 + 12 * i);
      const stco = find(stbl, 'stco') || find(stbl, 'co64');
      stco.padChunks = find(find(audio, 'mdia', 'minf', 'stbl'), 'stco')?.padChunks || find(find(audio, 'mdia', 'minf', 'stbl'), 'co64')?.padChunks;
      moov.children.push(copy); // after udta, like the reference
      mvhd.data.writeUInt32BE(maxId + 2, mvhd.data.length - 4); // next_track_ID
    }

    // movie duration = longest track
    const tdur = moov.children.filter((c) => c.type === 'trak').map((t) => u32(find(t, 'tkhd').data, 20));
    mvhd.data.writeUInt32BE(Math.max(...tdur), 16);

    // ---- chunk layout: every chunk of the original mdat keeps its order; video samples may be rewritten
    const allTraks = moov.children.filter((c) => c.type === 'trak');
    const stcoOf = (t) => {
      const stbl = find(t, 'mdia', 'minf', 'stbl');
      return find(stbl, 'stco') || find(stbl, 'co64');
    };
    const readOffsets = (t) => {
      const b = stcoOf(t);
      const big = b.type === 'co64';
      return Array.from({ length: u32(b.data, 4) }, (_, i) => (big ? Number(b.data.readBigUInt64BE(8 + 8 * i)) : u32(b.data, 8 + 4 * i)));
    };
    const chunkSamples = (t) => {
      // [first sample index, count] per chunk, from stsc
      const stbl = find(t, 'mdia', 'minf', 'stbl');
      const stsc = find(stbl, 'stsc');
      const n = readOffsets(t).length;
      const ents = Array.from({ length: u32(stsc.data, 4) }, (_, i) => [u32(stsc.data, 8 + 12 * i), u32(stsc.data, 12 + 12 * i)]);
      const out = [];
      let sample = 0;
      for (let c = 1; c <= n; c++) {
        let spc = 0;
        for (const [first, k] of ents) if (first <= c) spc = k;
        out.push([sample, spc]);
        sample += spc;
      }
      return out;
    };
    const sizesOf = (t) => {
      const stsz = find(find(t, 'mdia', 'minf', 'stbl'), 'stsz');
      const fixed = u32(stsz.data, 4);
      const n = u32(stsz.data, 8);
      return Array.from({ length: n }, (_, i) => (fixed ? fixed : u32(stsz.data, 12 + 4 * i)));
    };

    // Rewrite video samples first (into memory-light temp file) so their sizes are known before moov.
    let vtmp = null;
    let vNew = null; // [{offset in temp, size}]
    if (video && videoTransform) {
      const offs = readOffsets(video);
      const chunks = chunkSamples(video);
      const sizes = sizesOf(video);
      vtmp = `${output}.vtmp`;
      const fdv = fs.openSync(vtmp, 'w');
      vNew = [];
      let tp = 0;
      try {
        chunks.forEach(([first, count], ci) => {
          let p = offs[ci];
          for (let k = 0; k < count; k++) {
            const i = first + k;
            const au = videoTransform(i, src.read(p, sizes[i]));
            p += sizes[i];
            fs.writeSync(fdv, au, 0, au.length, tp);
            vNew.push({ offset: tp, size: au.length });
            tp += au.length;
          }
        });
      } finally {
        fs.closeSync(fdv);
      }
      const stsz = find(find(video, 'mdia', 'minf', 'stbl'), 'stsz');
      const data = Buffer.alloc(12 + 4 * vNew.length);
      data.writeUInt32BE(vNew.length, 8);
      vNew.forEach((x, i) => data.writeUInt32BE(x.size, 12 + 4 * i));
      stsz.data = data;
    }

    // Original chunks in file order (the duplicate audio track shares audio's chunks, so skip it here).
    const units = [];
    const owners = allTraks.filter((t) => t !== moov.children[moov.children.length - 1] || !(audio && dup));
    for (const t of owners) {
      const offs = readOffsets(t);
      const chunks = chunkSamples(t);
      const sizes = t === video && vNew ? vNew.map((x) => x.size) : sizesOf(t);
      offs.forEach((off, ci) => {
        if (stcoOf(t).padChunks?.includes(ci)) return; // padding chunks go at the end
        const [first, count] = chunks[ci] || [0, 0];
        let len = 0;
        for (let k = 0; k < count; k++) len += sizes[first + k];
        units.push({ t, ci, off, len, first, count });
      });
    }
    units.sort((x, y) => x.off - y.off || (x.t === video ? 1 : -1));
    // dedupe chunks that point at the same bytes (defensive)
    const dataLen = units.reduce((a, u) => a + u.len, 0) + padBytes.length;

    const moovSize = serialize(moov).length;
    const freeBox = top.length === 4 ? src.read(top[2].start, top[2].end - top[2].start) : Buffer.alloc(0);
    const large = 8 + dataLen > 0xffffffff;
    const mdatHdrLen = large ? 16 : 8;
    let pos = newFtyp.length + moovSize + freeBox.length + mdatHdrLen;
    const newOffset = new Map(); // trak -> Map(ci -> offset)
    for (const u of units) {
      if (!newOffset.has(u.t)) newOffset.set(u.t, new Map());
      newOffset.get(u.t).set(u.ci, pos);
      u.newOff = pos;
      pos += u.len;
    }
    const padStart = pos;
    const padUnit = padBytes.length / PAD_FRAMES;
    const padOffsets = [padStart, padStart + 9 * padUnit];
    for (const t of allTraks) {
      const b = stcoOf(t);
      const big = b.type === 'co64';
      const owner = owners.includes(t) ? t : audio; // duplicate track -> audio's chunks
      const map = newOffset.get(owner) || new Map();
      const n = u32(b.data, 4);
      for (let i = 0; i < n; i++) {
        const padIdx = b.padChunks ? b.padChunks.indexOf(i) : -1;
        const val = padIdx >= 0 ? padOffsets[padIdx] : map.get(i);
        if (val === undefined) throw new Error('chunk offset mapping failed');
        if (!big && val > 0xffffffff) throw new Error('file too large for 32-bit chunk offsets');
        if (big) b.data.writeBigUInt64BE(BigInt(val), 8 + 8 * i);
        else b.data.writeUInt32BE(val, 8 + 4 * i);
      }
    }
    const moovBytes = serialize(moov);
    if (moovBytes.length !== moovSize) throw new Error('moov size changed');

    const fd = fs.openSync(output, 'w');
    const vfd = vtmp ? fs.openSync(vtmp, 'r') : null;
    try {
      let w = 0;
      const put = (b) => {
        fs.writeSync(fd, b, 0, b.length, w);
        w += b.length;
      };
      put(newFtyp);
      put(moovBytes);
      put(freeBox);
      const hdr = Buffer.alloc(mdatHdrLen);
      if (large) {
        hdr.writeUInt32BE(1, 0);
        hdr.write('mdat', 4, 'latin1');
        hdr.writeBigUInt64BE(BigInt(16 + dataLen), 8);
      } else {
        hdr.writeUInt32BE(8 + dataLen, 0);
        hdr.write('mdat', 4, 'latin1');
      }
      put(hdr);
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      const copy = (fromFd, start, len) => {
        let done = 0;
        while (done < len) {
          const n = fs.readSync(fromFd, buf, 0, Math.min(buf.length, len - done), start + done);
          if (n <= 0) throw new Error('short read');
          fs.writeSync(fd, buf, 0, n, w);
          w += n;
          done += n;
        }
      };
      for (const u of units) {
        if (u.t === video && vNew) {
          if (u.count) copy(vfd, vNew[u.first].offset, u.len);
        } else copy(src.fd, u.off, u.len);
      }
      put(padBytes);
      return { size: w, padded: padBytes.length > 0, duplicated: Boolean(audio && dup), rewrittenVideo: Boolean(vNew) };
    } finally {
      fs.closeSync(fd);
      if (vfd !== null) fs.closeSync(vfd);
      if (vtmp) fs.rmSync(vtmp, { force: true });
    }
  } finally {
    src.close();
  }
}
