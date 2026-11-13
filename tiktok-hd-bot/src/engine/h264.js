// Tiny H.264 helpers used by the muxer.

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
