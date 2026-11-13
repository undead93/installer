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

export function ttPostProcess(input, output, { pad = true, dup = true } = {}) {
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
        if (type !== 'dvcC' && type !== 'dvvC' && type !== 'dvwC') kids.push(entry.subarray(p, p + size));
        p += size;
      }
      const newEntry = Buffer.concat([entry.subarray(0, 86), ...kids]);
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

    // Offsets: everything after moov moves by delta; padding goes at the end of mdat.
    const newMoovSize = serialize(moov).length;
    const delta = newFtyp.length + newMoovSize - (moovBox.end - ftypBox.start);
    const padStart = src.size + delta; // first padding byte in the new file
    const padOffsets = [padStart, padStart + 9 * (padBytes.length / PAD_FRAMES)];
    for (const t of moov.children.filter((c) => c.type === 'trak')) {
      const stbl = find(t, 'mdia', 'minf', 'stbl');
      const stco = find(stbl, 'stco') || find(stbl, 'co64');
      const big = stco.type === 'co64';
      const n = u32(stco.data, 4);
      for (let i = 0; i < n; i++) {
        const at = 8 + (big ? 8 : 4) * i;
        const padIdx = stco.padChunks ? stco.padChunks.indexOf(i) : -1;
        const old = big ? Number(stco.data.readBigUInt64BE(at)) : u32(stco.data, at);
        const val = padIdx >= 0 ? padOffsets[padIdx] : old + delta;
        if (!big && val > 0xffffffff) throw new Error('file too large for 32-bit chunk offsets');
        if (big) stco.data.writeBigUInt64BE(BigInt(val), at);
        else stco.data.writeUInt32BE(val, at);
      }
    }
    const moovBytes = serialize(moov);
    if (moovBytes.length !== newMoovSize) throw new Error('moov size changed');

    // write: ftyp + moov + [free] + mdat header (size grows by the padding) + mdat data + padding
    const fd = fs.openSync(output, 'w');
    try {
      let pos = 0;
      const put = (b) => {
        fs.writeSync(fd, b, 0, b.length, pos);
        pos += b.length;
      };
      put(newFtyp);
      put(moovBytes);
      if (top.length === 4) put(src.read(top[2].start, top[2].end - top[2].start)); // free
      const hdrLen = mdatBox.body - mdatBox.start;
      const mdatHdr = src.read(mdatBox.start, hdrLen);
      if (hdrLen === 8) mdatHdr.writeUInt32BE(mdatBox.end - mdatBox.start + padBytes.length, 0);
      else mdatHdr.writeBigUInt64BE(BigInt(mdatBox.end - mdatBox.start + padBytes.length), 8);
      put(mdatHdr);
      const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
      for (let p = mdatBox.body; p < mdatBox.end; ) {
        const n = fs.readSync(src.fd, chunk, 0, Math.min(chunk.length, mdatBox.end - p), p);
        fs.writeSync(fd, chunk, 0, n, pos);
        pos += n;
        p += n;
      }
      put(padBytes);
      return { size: pos, padded: padBytes.length > 0, duplicated: Boolean(audio && dup) };
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    src.close();
  }
}
