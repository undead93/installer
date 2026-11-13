// Tiny H.264 helpers used by the muxer.

/**
 * SEI NAL units written by Apple's hardware H.264 encoder (VideoToolbox), as found in iPhone
 * recordings and in the reference HD files: user_data_unregistered with Apple's UUID
 * 47564adc-5c4c-433f-94ef-c5113cd143a8 — a long one on the first frame, a short one on every
 * other keyframe.
 */
export const APPLE_SEI_FIRST = Buffer.from(
  '06052d47564adc5c4c433f94efc5113cd143a8010000030006030000030003020339d2000b00000300000300001d600c03912b0180',
  'hex',
);
export const APPLE_SEI_KEYFRAME = Buffer.from('06051547564adc5c4c433f94efc5113cd143a803000003000380', 'hex');

/** Length-prefix a NAL unit (4-byte big-endian length). */
export function lengthPrefixed(nal) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(nal.length);
  return Buffer.concat([head, nal]);
}

/**
 * Apple marks every reference NAL with nal_ref_idc = 1 (x264 uses 3/2). Only zero vs non-zero
 * matters to a decoder, so rewriting it in place is lossless. Works on a length-prefixed access unit.
 */
export function appleNalRefIdc(au, lengthSize = 4) {
  let p = 0;
  while (p + lengthSize < au.length) {
    const len = au.readUIntBE(p, lengthSize);
    const h = au[p + lengthSize];
    if ((h >> 5) & 3) au[p + lengthSize] = (h & 0x9f) | 0x20;
    if (len <= 0) break;
    p += lengthSize + len;
  }
  return au;
}

/** Same rewrite for the SPS/PPS stored in an avcC box (full box bytes). Returns a patched copy. */
export function appleAvcC(avcCBox) {
  const b = Buffer.from(avcCBox);
  let p = 8 + 5;
  const nsps = b[p++] & 0x1f;
  for (let i = 0; i < nsps; i++) {
    const len = b.readUInt16BE(p);
    if (b[p + 2] >> 5) b[p + 2] = (b[p + 2] & 0x9f) | 0x20;
    p += 2 + len;
  }
  const npps = b[p++];
  for (let i = 0; i < npps; i++) {
    const len = b.readUInt16BE(p);
    if (b[p + 2] >> 5) b[p + 2] = (b[p + 2] & 0x9f) | 0x20;
    p += 2 + len;
  }
  return b;
}

/**
 * QuickTime/ISO `sdtp` byte for an H.264 slice NAL header byte, matching what
 * AVFoundation writes: 0x20 = IDR (depends on nothing), 0x10 = reference
 * frame, 0x18 = disposable (non-reference, e.g. most B-frames).
 */
export function nalDependency(nalHeader) {
  const type = nalHeader & 0x1f;
  if (type === 5) return 0x20;
  return ((nalHeader >> 5) & 3) === 0 ? 0x18 : 0x10;
}

export const isVcl = (nalHeader) => {
  const type = nalHeader & 0x1f;
  return type >= 1 && type <= 5;
};

/** Dependency byte for one length-prefixed access unit held in memory. */
export function sampleDependency(sample, lengthSize = 4) {
  let p = 0;
  while (p + lengthSize < sample.length) {
    const len = sample.readUIntBE(p, lengthSize);
    p += lengthSize;
    if (isVcl(sample[p])) return nalDependency(sample[p]);
    if (len <= 0) break;
    p += len;
  }
  return 0x10;
}
