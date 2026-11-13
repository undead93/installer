// AAC helpers: esds/AudioSpecificConfig parsing and Apple-style mp4a sample entries.
import { findInSampleEntry } from './mp4.js';

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** A digitally silent AAC-LC channel-pair (stereo) raw data block, 6 bytes. */
export const SILENT_STEREO_FRAME = Buffer.from('211004608c1c', 'hex');

function readDescLen(buf, p) {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { len, p };
}

/** Parse an `esds` box (full box bytes) into its decoder configuration. */
export function parseEsds(esds) {
  let p = 12; // box header + version/flags
  const end = esds.length;
  const out = { objectType: 0x40, streamType: 5, bufferSizeDB: 0, maxBitrate: 0, avgBitrate: 0, asc: null };
  while (p < end) {
    const tag = esds[p++];
    const { len, p: q } = readDescLen(esds, p);
    p = q;
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1) [+ optional fields]
      const flags = esds[p + 2];
      p += 3;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + esds[p];
      if (flags & 0x20) p += 2;
      continue; // descend into children
    }
    if (tag === 0x04) {
      out.objectType = esds[p];
      out.streamType = esds[p + 1] >> 2;
      out.bufferSizeDB = esds.readUIntBE(p + 2, 3);
      out.maxBitrate = esds.readUInt32BE(p + 5);
      out.avgBitrate = esds.readUInt32BE(p + 9);
      p += 13;
      continue; // descend into DecoderSpecificInfo
    }
    if (tag === 0x05) {
      out.asc = Buffer.from(esds.subarray(p, p + len));
      p += len;
      continue;
    }
    p += len;
  }
  return out;
}

export function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  const bits = (asc[0] << 8) | asc[1];
  let aot = bits >> 11;
  const sfi = (bits >> 7) & 0x0f;
  const channelConfig = (bits >> 3) & 0x0f;
  let sampleRate = SAMPLE_RATES[sfi];
  if (sfi === 0x0f && asc.length >= 5) {
    sampleRate = ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
  }
  if (aot === 31) aot = 32; // escape value, not used by phones
  return { aot, sfi, sampleRate, channelConfig };
}

function descriptor(tag, payload) {
  // Apple writes every descriptor length with the 4-byte 0x80 0x80 0x80 xx form.
  const len = payload.length;
  const head = Buffer.from([tag, 0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f]);
  return Buffer.concat([head, payload]);
}

export function buildEsds({ asc, bufferSizeDB = 6144, maxBitrate = 192000, avgBitrate = 0 }) {
  const dcd = Buffer.alloc(13);
  dcd[0] = 0x40; // MPEG-4 Audio
  dcd[1] = 0x14; // streamType 5 (audio) << 2, as written by AVFoundation
  dcd.writeUIntBE(bufferSizeDB & 0xffffff, 2, 3);
  dcd.writeUInt32BE(maxBitrate >>> 0, 5);
  dcd.writeUInt32BE(avgBitrate >>> 0, 9);
  const decoderConfig = descriptor(0x04, Buffer.concat([dcd, descriptor(0x05, asc)]));
  const sl = descriptor(0x06, Buffer.from([0x02]));
  const es = descriptor(0x03, Buffer.concat([Buffer.from([0, 0, 0]), decoderConfig, sl]));
  const head = Buffer.alloc(12);
  head.writeUInt32BE(12 + es.length, 0);
  head.write('esds', 4, 'latin1');
  return Buffer.concat([head, es]);
}

/** QuickTime sound sample description v0 + esds — the layout AVFoundation writes for passthrough AAC. */
export function buildMp4aEntry({ channels, sampleRate, esds }) {
  const fixed = Buffer.alloc(36);
  fixed.write('mp4a', 4, 'latin1');
  fixed.writeUInt16BE(1, 14); // data reference index
  fixed.writeUInt16BE(channels, 24);
  fixed.writeUInt16BE(16, 26); // sample size
  fixed.writeUInt32BE((sampleRate >= 65536 ? 0 : sampleRate) * 65536, 32);
  const entry = Buffer.concat([fixed, esds]);
  entry.writeUInt32BE(entry.length, 0);
  return entry;
}

/** Inspect an mp4a sample entry from any MP4/MOV writer. */
export function inspectMp4a(entry) {
  const esdsBox = findInSampleEntry(entry, 'esds');
  if (!esdsBox) return null;
  const esds = parseEsds(entry.subarray(esdsBox.start, esdsBox.end));
  const asc = parseAsc(esds.asc);
  if (!asc) return null;
  const version = entry.readUInt16BE(16);
  let channels = entry.readUInt16BE(24);
  if (asc.channelConfig >= 1 && asc.channelConfig <= 7) channels = [0, 1, 2, 3, 4, 5, 6, 8][asc.channelConfig];
  return { esds, asc, channels, sampleRate: asc.sampleRate, version };
}
