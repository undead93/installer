// Builds the final iPhone-style QuickTime file:
//   track 1  AAC (original packets, passthrough) + 17 silent frames in a tail mdat (mono or stereo)
//   track 2  APAC spatial audio (passthrough, disabled, 'fall' -> AAC)      [iPhone sources]
//   track 3  new H.264 video (timescale 600, signed ctts + cslg, sdtp, tapt)
//   track 4+ Apple camera timed metadata 'mebx' (passthrough)              [iPhone sources]
//   last     duplicate of the AAC track sharing the same chunks
// No make/model/date/GPS is written; mvhd/tkhd times are zero.
import { parseMovie } from './mp4.js';
import { inspectMp4a, buildEsds, buildMp4aEntry, pceAsc, SILENT_STEREO_FRAME, SILENT_MONO_FRAME } from './aac.js';
import { isVcl, nalDependency, APPLE_SEI_FIRST, APPLE_SEI_KEYFRAME, lengthPrefixed, appleNalRefIdc, appleAvcC } from './h264.js';
import {
  box,
  fullBox,
  u16,
  u32,
  i16,
  writeQuickTime,
  dataHandler,
  dataInfo,
  videoMediaHeader,
  soundMediaHeader,
  trackAperture,
} from './writer.js';

const MOVIE_TS = 1000;
const VIDEO_TS = 600;
const PAD_FRAMES = 17; // 9 + 8 frames, ~0.36 s at 48 kHz
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function avc1Entry(width, height, avcC) {
  const fixed = Buffer.alloc(86);
  fixed.write('avc1', 4, 'latin1');
  fixed.writeUInt16BE(1, 14); // data reference index
  fixed.writeUInt32BE(0x200, 24); // temporal quality: codecNormalQuality
  fixed.writeUInt32BE(0x200, 28); // spatial quality
  fixed.writeUInt16BE(width, 32);
  fixed.writeUInt16BE(height, 34);
  fixed.writeUInt32BE(0x00480000, 36); // 72 dpi
  fixed.writeUInt32BE(0x00480000, 40);
  fixed.writeUInt16BE(1, 48); // frame count
  fixed.writeUInt16BE(0x18, 82); // depth
  fixed.writeInt16BE(-1, 84); // color table id
  const colr = box('colr', Buffer.from('nclc', 'latin1'), u16(1), u16(1), u16(1)); // BT.709
  const amve = box('amve', u32(3140000), u16(15635), u16(16450)); // 314 lux, D65 — SDR reference viewing environment
  const entry = Buffer.concat([fixed, avcC, colr, amve, Buffer.alloc(4)]);
  entry.writeUInt32BE(entry.length, 0);
  return entry;
}

/** sdtp byte for one on-disk access unit: walk NAL length prefixes until the first slice. */
function readFirstVcl(src, offset, size, lengthSize) {
  let p = 0;
  while (p + lengthSize + 1 <= size) {
    const head = src.read(offset + p, lengthSize + 1);
    const len = head.readUIntBE(0, lengthSize);
    const nal = head[lengthSize];
    if (isVcl(nal)) return nalDependency(nal);
    if (len <= 0) break;
    p += lengthSize + len;
  }
  return 0x10;
}

function rollGroups(count, padCount) {
  const sgpd = fullBox('sgpd', 1, 0, Buffer.from('roll', 'latin1'), u32(2), u32(1), i16(-1));
  const idx = new Uint32Array(count + padCount);
  idx.fill(1, 0, count);
  return { sgpd: [sgpd], sbgp: [{ type: 'roll', idx }] };
}

function trimGroups(groups, keep, extra = 0) {
  return {
    sgpd: groups.sgpd.map((g) => g.raw),
    sbgp: groups.sbgp.map((g) => {
      const idx = new Uint32Array(keep + extra);
      idx.set(g.idx.subarray(0, keep));
      return { type: g.type, idx };
    }),
  };
}

const firstMediaTime = (elst) => (elst || []).find((e) => e.mediaTime >= 0)?.mediaTime ?? 0;

export function muxOutput({ output, videoPath, audioPath, original, plan, encoderTag, pad = true, dupAudio = true, keepAppleTracks = true, appleBitstream = true }) {
  const opened = [];
  const open = (p) => {
    const m = parseMovie(p);
    opened.push(m);
    return m;
  };
  try {
    // ---------- video ----------
    const vMovie = open(videoPath);
    const vt = vMovie.tracks.find((t) => t.handler === 'vide');
    if (!vt || !vt.samples.length) throw new Error('Encode video gagal: tiada sampel');
    const scale = VIDEO_TS / vt.mdhd.timescale;
    const shift = firstMediaTime(vt.elst);
    const avcCBox = (() => {
      const e = vt.stsdEntries[0];
      for (let p = 86; p + 8 <= e.length; ) {
        const size = e.readUInt32BE(p);
        if (e.toString('latin1', p + 4, p + 8) === 'avcC') return e.subarray(p, p + size);
        if (size < 8) break;
        p += size;
      }
      throw new Error('avcC tidak dijumpai dalam output x264');
    })();
    const lengthSize = (avcCBox[12] & 3) + 1;
    // Make the x264 bitstream look like Apple's hardware encoder output: Apple SEI before the slice of
    // the first frame and of every keyframe, and nal_ref_idc = 1 on reference NALs (lossless rewrite).
    const seiFirst = lengthPrefixed(APPLE_SEI_FIRST);
    const seiKey = lengthPrefixed(APPLE_SEI_KEYFRAME);
    const patch = appleBitstream && lengthSize === 4 ? (au) => appleNalRefIdc(au, lengthSize) : undefined;
    const vSamples = vt.samples.map((s, i) => {
      const dts = Math.round(s.dts * scale);
      const pts = Math.round((s.dts + s.cto - shift) * scale);
      const prefix = patch && s.sync ? (i === 0 ? seiFirst : seiKey) : undefined;
      return {
        src: vMovie.src,
        offset: s.offset,
        size: s.size + (prefix?.length || 0),
        prefix,
        patch,
        dts,
        dur: Math.round(s.dur * scale),
        cto: pts - dts,
        sync: s.sync,
        sdi: 1,
        dep: readFirstVcl(vMovie.src, s.offset, s.size, lengthSize),
      };
    });
    const videoMediaDur = vSamples.reduce((a, s) => a + s.dur, 0);
    const videoSeconds = videoMediaDur / VIDEO_TS;
    const codedW = vt.stsdEntries[0].readUInt16BE(32);
    const codedH = vt.stsdEntries[0].readUInt16BE(34);
    // tkhd/tapt carry the pre-transform size; the matrix (copied from the source) rotates it for display.
    const matrix = plan.matrix || IDENTITY;
    const rotated = matrix[0] === 0 && matrix[4] === 0; // 90° / 270°
    const dispW = rotated ? codedH : codedW;
    const dispH = rotated ? codedW : codedH;

    // ---------- audio (AAC) ----------
    let aac = null;
    if (audioPath || plan.audio?.mode === 'passthrough') {
      const aMovie = audioPath ? open(audioPath) : original;
      const at = audioPath ? aMovie.tracks.find((t) => t.handler === 'soun') : original.tracks.find((t) => t.id === plan.audio.trackId);
      const info = at && inspectMp4a(at.stsdEntries[0]);
      const firstStart = at?.samples[0] ? at.samples[0].dts - firstMediaTime(at.elst) : Infinity;
      if (at && info && firstStart < videoSeconds * at.mdhd.timescale) aac = { movie: aMovie, track: at, info };
    }

    const apac = keepAppleTracks && original ? original.tracks.find((t) => t.handler === 'soun' && t.fourcc === 'apac') : null;
    const metas = keepAppleTracks && original ? original.tracks.filter((t) => t.handler === 'meta' && t.fourcc === 'mebx' && t.samples.length) : [];
    const srcVideo = original ? original.tracks.find((t) => t.handler === 'vide') : null;
    const srcMovieTs = original?.mvhd.timescale || MOVIE_TS;

    const out = [];
    const ids = new Map(); // original track id -> new id
    let nextId = 1;

    let aacTrack = null;
    if (aac) {
      const { track: at, info, movie } = aac;
      const ts = at.mdhd.timescale;
      const mediaTime = firstMediaTime(at.elst);
      const endTs = Math.round(videoSeconds * ts);
      const kept = at.samples.filter((s) => s.dts - mediaTime < endTs);
      const samples = kept.map((s) => ({ src: movie.src, offset: s.offset, size: s.size, dts: s.dts, dur: s.dur, cto: 0, sync: true, sdi: 1 }));
      // Reference files append 17 silent frames (9 with the normal config, 8 with a PCE config) to mono and stereo AAC.
      const silent = info.channels === 2 ? SILENT_STEREO_FRAME : info.channels === 1 ? SILENT_MONO_FRAME : null;
      const canPad = pad && silent && info.asc.aot === 2 && samples.length > 0;
      const padCount = canPad ? PAD_FRAMES : 0;
      let t = samples.length ? samples[samples.length - 1].dts + samples[samples.length - 1].dur : 0;
      const frameDur = samples[0]?.dur || 1024;
      for (let k = 0; k < padCount; k++) {
        samples.push({ data: silent, size: silent.length, dts: t, dur: frameDur, cto: 0, sync: true, sdi: k < 9 ? 1 : 2, tail: true });
        t += frameDur;
      }
      const esdsFields = {
        bufferSizeDB: info.esds.bufferSizeDB || 6144,
        maxBitrate: info.esds.maxBitrate || 192000,
        avgBitrate: info.esds.avgBitrate || 0,
      };
      const entry = buildMp4aEntry({ channels: info.channels, sampleRate: info.sampleRate, esds: buildEsds({ asc: info.esds.asc, ...esdsFields }) });
      const pceEntry = padCount
        ? buildMp4aEntry({ channels: info.channels, sampleRate: info.sampleRate, esds: buildEsds({ asc: pceAsc(info.asc.sfi, info.channels), ...esdsFields }) })
        : null;
      const hasRoll = at.groups.sbgp.some((g) => g.type === 'roll');
      const groups = hasRoll ? trimGroups(at.groups, kept.length, padCount) : rollGroups(kept.length, padCount);
      const mediaDur = samples.reduce((a, s) => a + s.dur, 0);
      aacTrack = {
        id: nextId++,
        kind: 'audio',
        handlerSub: 'soun',
        handlerName: 'Core Media Audio',
        timescale: ts,
        language: 0x55c4,
        samples,
        stsdEntries: padCount ? [entry, pceEntry] : [entry],
        tkhd: { flags: 15, layer: 0, altGroup: 1, volume: 0x100, matrix: IDENTITY, width: 0, height: 0 },
        elst: [{ segDur: Math.round(((mediaDur - mediaTime) / ts) * MOVIE_TS), mediaTime, rate: 1 }],
        tref: [],
        elng: at.elng, // only when the source has one, like the reference files
        mediaHeader: soundMediaHeader(),
        sgpd: groups.sgpd,
        sbgp: groups.sbgp,
      };
      if (original && plan.audio?.mode === 'passthrough') ids.set(at.id, aacTrack.id);
      out.push(aacTrack);
    }

    const apacKept = apac ? apac.samples.filter((s) => s.dts - firstMediaTime(apac.elst) < Math.round(videoSeconds * apac.mdhd.timescale)) : [];
    if (apac && aacTrack && apacKept.length) {
      const ts = apac.mdhd.timescale;
      const mediaTime = firstMediaTime(apac.elst);
      const kept = apacKept;
      const mediaDur = kept.reduce((a, s) => a + s.dur, 0);
      const srcSeg = apac.elst?.[0] ? Math.round((apac.elst[0].segDur * MOVIE_TS) / srcMovieTs) : Infinity;
      const segDur = Math.min(srcSeg, Math.floor(((mediaDur - mediaTime) / ts) * MOVIE_TS));
      const g = trimGroups(apac.groups, kept.length);
      const t = {
        id: nextId++,
        kind: 'audio',
        handlerSub: 'soun',
        handlerName: 'Core Media Audio',
        timescale: ts,
        language: apac.mdhd.language,
        samples: kept.map((s) => ({ src: original.src, offset: s.offset, size: s.size, dts: s.dts, dur: s.dur, cto: s.cto, sync: s.sync, sdi: s.sdi })),
        stsdEntries: apac.stsdEntries,
        tkhd: { flags: apac.tkhd.flags, layer: 0, altGroup: apac.tkhd.altGroup || 1, volume: apac.tkhd.volume || 0x100, matrix: IDENTITY, width: 0, height: 0 },
        elst: [{ segDur, mediaTime, rate: 1 }],
        tref: [{ type: 'fall', ids: [aacTrack.id] }],
        elng: apac.elng,
        mediaHeader: apac.mediaHeader || soundMediaHeader(),
        minfHdlr: apac.minfHdlr,
        dinf: apac.dinf,
        sgpd: g.sgpd,
        sbgp: g.sbgp,
        writeStss: apac.hasStss,
      };
      ids.set(apac.id, t.id);
      out.push(t);
    }

    const videoTrack = {
      id: nextId++,
      kind: 'video',
      handlerSub: 'vide',
      handlerName: 'Core Media Video',
      timescale: VIDEO_TS,
      language: 0x55c4,
      samples: vSamples,
      stsdEntries: [avc1Entry(codedW, codedH, patch ? appleAvcC(avcCBox) : avcCBox)],
      tkhd: { flags: 15, layer: 0, altGroup: 0, volume: 0, matrix, width: codedW, height: codedH },
      elst: [{ segDur: Math.round(videoSeconds * MOVIE_TS), mediaTime: 0, rate: 1 }],
      tref: [],
      tapt: trackAperture(codedW, codedH),
      elng: null,
      mediaHeader: videoMediaHeader(),
      writeCtts: true,
      writeCslg: true,
      writeStss: true,
      writeSdtp: true,
    };
    if (srcVideo) ids.set(srcVideo.id, videoTrack.id);
    out.push(videoTrack);

    for (const m of metas) {
      const t = {
        id: nextId++,
        kind: 'meta',
        handlerSub: 'meta',
        handlerName: m.handlerName || 'Core Media Metadata',
        timescale: m.mdhd.timescale,
        language: m.mdhd.language,
        samples: m.samples.map((s) => ({ src: original.src, offset: s.offset, size: s.size, dts: s.dts, dur: s.dur, cto: s.cto, sync: s.sync, sdi: s.sdi })),
        stsdEntries: m.stsdEntries,
        tkhd: { flags: m.tkhd.flags, layer: 0, altGroup: m.tkhd.altGroup, volume: 0, matrix: IDENTITY, width: 0, height: 0 },
        elst: (m.elst || []).map((e) => ({ segDur: Math.round((e.segDur * MOVIE_TS) / srcMovieTs), mediaTime: e.mediaTime, rate: e.rate })),
        trefSrc: m.tref,
        elng: m.elng,
        mediaHeader: m.mediaHeader,
        minfHdlr: m.minfHdlr,
        dinf: m.dinf,
        writeStss: m.hasStss,
      };
      if (!t.elst.length) t.elst = null;
      // AVFoundation ends each metadata track exactly at its edit: shorten the last sample to fit.
      if (t.elst?.length === 1 && t.elst[0].mediaTime >= 0 && t.samples.length) {
        const end = Math.round((t.elst[0].segDur / MOVIE_TS) * t.timescale) + t.elst[0].mediaTime;
        const last = t.samples[t.samples.length - 1];
        const over = last.dts + last.dur - end;
        if (over > 0 && last.dur - over >= 1) t.samples[t.samples.length - 1] = { ...last, dur: last.dur - over };
      }
      ids.set(m.id, t.id);
      out.push(t);
    }
    // Remap references (cdsc/cdep/rndr...) now that every new id is known.
    for (const t of out) {
      if (!t.trefSrc) continue;
      t.tref = t.trefSrc
        .map((r) => ({ type: r.type, ids: r.ids.map((id) => ids.get(id)).filter(Boolean) }))
        .filter((r) => r.ids.length)
        .sort((a, b) => (a.type < b.type ? -1 : 1)); // AVFoundation writes reference types in sorted order
      delete t.trefSrc;
    }

    if (aacTrack && dupAudio) {
      out.push({
        ...aacTrack,
        id: nextId++,
        stsdEntries: [aacTrack.stsdEntries[0]],
        samples: aacTrack.samples.map((s) => ({ ...s, sdi: 1 })),
        shareChunksWith: out.indexOf(aacTrack),
      });
    }

    const report = writeQuickTime(output, { tracks: out, movieTimescale: MOVIE_TS, encoderTag });
    return {
      ...report,
      tracks: out.map((t) => ({ id: t.id, kind: t.kind, fourcc: t.stsdEntries[0].toString('latin1', 4, 8), samples: t.samples.length })),
      video: { width: dispW, height: dispH, frames: vSamples.length, seconds: videoSeconds },
    };
  } finally {
    for (const m of opened) m.src.close();
  }
}
