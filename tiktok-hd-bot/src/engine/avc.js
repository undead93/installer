// H.264 header transplant: make an x264 stream decode identically under the SPS/PPS that Apple's
// hardware encoder (VideoToolbox) writes, so the video's parameter sets and slice headers look like
// iPhone/AVFoundation output. Only headers are rewritten; the CABAC picture data is copied untouched.
//
// Supported input (what our pipeline produces): length-prefixed NALs, CABAC, progressive
// (frame_mbs_only), POC type 0, no weighted prediction (weightp=0, weightb=0), no scaling matrices.
// Anything else -> transplant is skipped and the caller keeps the original stream.

class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0; // in bits
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error('bitstream overrun');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error('bad exp-golomb');
    }
    return zeros ? 2 ** zeros - 1 + this.u(zeros) : 0;
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

class BitWriter {
  constructor() {
    this.bits = [];
  }
  u(v, n) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2);
  }
  ue(v) {
    const x = v + 1;
    const len = Math.floor(Math.log2(x));
    this.u(0, len);
    this.u(x, len + 1);
  }
  se(v) {
    this.ue(v > 0 ? 2 * v - 1 : -2 * v);
  }
  get length() {
    return this.bits.length;
  }
  bytes() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => (out[i >> 3] |= b << (7 - (i & 7))));
    return out;
  }
}

/** Emulation prevention: NAL payload <-> RBSP. */
export function unescapeRbsp(b) {
  const out = Buffer.alloc(b.length);
  let o = 0;
  let zeros = 0;
  for (let i = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) {
      zeros = 0;
      continue;
    }
    out[o++] = b[i];
    zeros = b[i] === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

export function escapeRbsp(b) {
  const out = [];
  let zeros = 0;
  for (const byte of b) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  if (out.length && out[out.length - 1] === 0) out.push(3); // RBSP ending in cabac_zero_word
  return Buffer.from(out);
}

export function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const s = { profile_idc: r.u(8), constraints: r.u(8), level_idc: r.u(8), id: r.ue() };
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(s.profile_idc)) {
    s.chroma_format_idc = r.ue();
    if (s.chroma_format_idc === 3) s.separate_colour_plane = r.u(1);
    s.bit_depth_luma = r.ue() + 8;
    s.bit_depth_chroma = r.ue() + 8;
    s.transform_bypass = r.u(1);
    s.scaling_matrix = r.u(1);
  } else {
    s.chroma_format_idc = 1;
    s.bit_depth_luma = s.bit_depth_chroma = 8;
    s.scaling_matrix = 0;
  }
  s.log2_max_frame_num = r.ue() + 4;
  s.poc_type = r.ue();
  if (s.poc_type === 0) s.log2_max_poc_lsb = r.ue() + 4;
  else return { ...s, unsupported: 'poc_type' };
  s.max_num_ref_frames = r.ue();
  s.gaps = r.u(1);
  s.width_mbs = r.ue() + 1;
  s.height_map_units = r.ue() + 1;
  s.frame_mbs_only = r.u(1);
  if (!s.frame_mbs_only) s.mb_adaptive = r.u(1);
  s.direct_8x8 = r.u(1);
  s.cropping = r.u(1);
  if (s.cropping) s.crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  return s;
}

export function parsePps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const p = { id: r.ue(), sps_id: r.ue(), entropy: r.u(1), bottom_field_poc: r.u(1), slice_groups: r.ue() + 1 };
  if (p.slice_groups > 1) return { ...p, unsupported: 'slice groups' };
  p.l0_default = r.ue() + 1;
  p.l1_default = r.ue() + 1;
  p.weighted_pred = r.u(1);
  p.weighted_bipred = r.u(2);
  p.pic_init_qp = 26 + r.se();
  p.pic_init_qs = 26 + r.se();
  p.chroma_qp_offset = r.se();
  p.deblocking_control = r.u(1);
  p.constrained_intra = r.u(1);
  p.redundant_pic_cnt = r.u(1);
  // more_rbsp_data(): High profile extension
  p.transform_8x8 = 0;
  p.scaling_matrix = 0;
  p.second_chroma_qp_offset = p.chroma_qp_offset;
  const rbsp = r.buf;
  let last = rbsp.length - 1;
  while (last > 0 && rbsp[last] === 0) last--;
  const stopBit = last * 8 + (7 - Math.log2(rbsp[last] & -rbsp[last]));
  if (r.pos < stopBit) {
    p.transform_8x8 = r.u(1);
    p.scaling_matrix = r.u(1);
    if (p.scaling_matrix) return { ...p, unsupported: 'scaling matrix' };
    p.second_chroma_qp_offset = r.se();
  }
  return p;
}

/**
 * SPS laid out the way Apple's encoder writes it: x264's coding fields, 5-bit frame_num, VUI with
 * video signal type (BT.709, limited range), 27 MHz timing (931034/27000000 at 30 fps), no aspect
 * ratio, no bitstream restriction. Byte-identical to the reference files' SPS for 3840x2160 @ L5.1.
 */
export function appleSps(s, fps = 30) {
  const w = new BitWriter();
  w.u(0x27, 8); // nal_ref_idc 1, type 7
  w.u(s.profile_idc, 8);
  w.u(s.constraints, 8);
  w.u(s.level_idc, 8);
  w.ue(0);
  if (s.profile_idc >= 100) {
    w.ue(s.chroma_format_idc);
    w.ue(s.bit_depth_luma - 8);
    w.ue(s.bit_depth_chroma - 8);
    w.u(0, 1); // transform bypass
    w.u(0, 1); // no scaling matrix
  }
  w.ue(APPLE_LOG2_MAX_FRAME_NUM - 4);
  w.ue(0); // poc type 0
  w.ue(s.log2_max_poc_lsb - 4);
  w.ue(s.max_num_ref_frames);
  w.u(0, 1); // gaps
  w.ue(s.width_mbs - 1);
  w.ue(s.height_map_units - 1);
  w.u(1, 1); // frame_mbs_only
  w.u(s.direct_8x8, 1);
  w.u(s.cropping, 1);
  if (s.cropping) s.crop.forEach((c) => w.ue(c));
  w.u(1, 1); // vui present
  w.u(0, 1); // aspect_ratio_info_present
  w.u(0, 1); // overscan_info_present
  w.u(1, 1); // video_signal_type_present
  w.u(5, 3); // video_format: unspecified
  w.u(0, 1); // limited range
  w.u(1, 1); // colour description
  w.u(1, 8); // BT.709 primaries
  w.u(1, 8); // BT.709 transfer
  w.u(1, 8); // BT.709 matrix
  w.u(0, 1); // chroma_loc_info_present
  w.u(1, 1); // timing_info_present
  w.u(Math.round(27000000 / Math.max(1, fps - 1)) | 0, 32); // 931034 at 30 fps, as Apple writes it
  w.u(27000000, 32);
  w.u(0, 1); // fixed_frame_rate_flag
  w.u(0, 1); // nal hrd
  w.u(0, 1); // vcl hrd
  w.u(0, 1); // pic_struct_present
  w.u(0, 1); // bitstream_restriction
  w.u(1, 1); // rbsp stop bit
  while (w.length % 8) w.u(0, 1);
  const b = w.bytes();
  return Buffer.concat([b.subarray(0, 1), escapeRbsp(b.subarray(1))]);
}

/** Apple's PPS: CABAC, 1/1 default refs, no weighting, init QP 26, 8x8 transform. */
export const APPLE_PPS = Buffer.from('28ee3cb0', 'hex');
const APPLE_PPS_FIELDS = { l0_default: 1, l1_default: 1, pic_init_qp: 26 };
const APPLE_LOG2_MAX_FRAME_NUM = 5;

/** Can this x264 stream be transplanted? Returns a reason string when not. */
export function transplantBlocker(sps, pps) {
  if (sps.unsupported || pps.unsupported) return sps.unsupported || pps.unsupported;
  if (!sps.frame_mbs_only) return 'interlaced';
  if (sps.scaling_matrix) return 'sps scaling matrix';
  if (sps.chroma_format_idc !== 1 || sps.bit_depth_luma !== 8) return 'not 8-bit 4:2:0';
  if (sps.log2_max_frame_num > APPLE_LOG2_MAX_FRAME_NUM) return 'frame_num too long';
  if (!pps.entropy) return 'CAVLC';
  if (pps.weighted_pred || pps.weighted_bipred) return 'weighted prediction';
  if (pps.bottom_field_poc || pps.redundant_pic_cnt || pps.constrained_intra) return 'pps flags';
  if (pps.chroma_qp_offset !== 0 || pps.second_chroma_qp_offset !== 0) return 'chroma qp offset';
  if (!pps.transform_8x8 || !pps.deblocking_control) return 'pps tools';
  return null;
}

/**
 * Rewrites the slices of a stream, picture by picture (call in decoding order).
 * state carries frame_num / POC tracking between calls.
 */
export function createSliceRewriter(sps, pps) {
  const maxFn = 2 ** sps.log2_max_frame_num;
  const maxLsb = 2 ** sps.log2_max_poc_lsb;
  const st = { prevRefFn: 0, prevMsb: 0, prevLsb: 0, halvePoc: true, pic: -1, picFn: 0, picPoc: 0 };

  function rewrite(nal, firstSliceOfPicture) {
    const header = nal[0];
    const refIdc = (header >> 5) & 3;
    const type = header & 31;
    const idr = type === 5;
    const r = new BitReader(unescapeRbsp(nal.subarray(1)));
    const first_mb = r.ue();
    const slice_type = r.ue();
    const pps_id = r.ue();
    const frame_num = r.u(sps.log2_max_frame_num);
    const idr_pic_id = idr ? r.ue() : 0;
    const poc_lsb = r.u(sps.log2_max_poc_lsb);
    const t = slice_type % 5; // 0 P, 1 B, 2 I
    const direct_spatial = t === 1 ? r.u(1) : 0;
    let l0 = pps.l0_default;
    let l1 = pps.l1_default;
    if (t === 0 || t === 1) {
      if (r.u(1)) {
        l0 = r.ue() + 1;
        if (t === 1) l1 = r.ue() + 1;
      }
    }
    const lists = [];
    const readMods = () => {
      const flag = r.u(1);
      const ops = [];
      if (flag) {
        for (;;) {
          const idc = r.ue();
          if (idc === 3) break;
          ops.push([idc, r.ue()]);
        }
      }
      return { flag, ops };
    };
    if (t !== 2) lists.push(readMods());
    if (t === 1) lists.push(readMods());
    let marking;
    if (refIdc) {
      if (idr) marking = { idr: true, noOutput: r.u(1), longTerm: r.u(1) };
      else {
        const adaptive = r.u(1);
        const ops = [];
        if (adaptive) {
          for (;;) {
            const op = r.ue();
            if (op === 0) break;
            const args = [];
            if (op === 1 || op === 3) args.push(r.ue());
            if (op === 2) args.push(r.ue());
            if (op === 3 || op === 6) args.push(r.ue());
            if (op === 4) args.push(r.ue());
            ops.push([op, args]);
          }
        }
        marking = { idr: false, adaptive, ops };
      }
    }
    const cabac_init = t !== 2 ? r.ue() : 0;
    const qp_delta = r.se();
    const dbk = r.ue();
    const dbkOffsets = dbk !== 1 ? [r.se(), r.se()] : null;
    const dataStart = Math.ceil(r.pos / 8); // CABAC data starts byte-aligned

    // frame_num: unwrap x264's counter and re-wrap it for Apple's 5-bit field.
    if (firstSliceOfPicture) {
      let fn;
      if (idr) fn = 0;
      else {
        fn = st.prevRefFn + 1;
        if (fn % maxFn !== frame_num) throw new Error(`frame_num gap (${frame_num} vs ${fn % maxFn})`);
      }
      // POC type 0 reconstruction (as a decoder does), so it can be renumbered with Apple's step of 1.
      let msb;
      if (idr) {
        st.prevMsb = 0;
        st.prevLsb = 0;
      }
      if (poc_lsb < st.prevLsb && st.prevLsb - poc_lsb >= maxLsb / 2) msb = st.prevMsb + maxLsb;
      else if (poc_lsb > st.prevLsb && poc_lsb - st.prevLsb > maxLsb / 2) msb = st.prevMsb - maxLsb;
      else msb = st.prevMsb;
      const poc = msb + poc_lsb;
      if (poc % 2) st.halvePoc = false; // never seen with x264 progressive streams
      st.picFn = fn;
      st.picPoc = poc;
      if (refIdc) {
        st.prevRefFn = fn;
        st.prevMsb = msb;
        st.prevLsb = poc_lsb;
      }
    }

    const w = new BitWriter();
    w.u((header & 0x9f) | (refIdc ? 0x20 : 0), 8);
    w.ue(first_mb);
    w.ue(t); // Apple writes 0/1/2, not the "all slices same type" 5/6/7
    w.ue(pps_id);
    w.u(st.picFn % 2 ** APPLE_LOG2_MAX_FRAME_NUM, APPLE_LOG2_MAX_FRAME_NUM);
    if (idr) w.ue(idr_pic_id);
    const newPoc = st.halvePoc ? st.picPoc / 2 : st.picPoc;
    w.u(((newPoc % maxLsb) + maxLsb) % maxLsb, sps.log2_max_poc_lsb);
    if (t === 1) w.u(direct_spatial, 1);
    if (t === 0 || t === 1) {
      const override = l0 !== APPLE_PPS_FIELDS.l0_default || (t === 1 && l1 !== APPLE_PPS_FIELDS.l1_default);
      w.u(override ? 1 : 0, 1);
      if (override) {
        w.ue(l0 - 1);
        if (t === 1) w.ue(l1 - 1);
      }
    }
    for (const list of lists) {
      w.u(list.flag, 1);
      if (list.flag) {
        for (const [idc, v] of list.ops) {
          w.ue(idc);
          w.ue(v);
        }
        w.ue(3);
      }
    }
    if (marking) {
      if (marking.idr) {
        w.u(marking.noOutput, 1);
        w.u(marking.longTerm, 1);
      } else {
        w.u(marking.adaptive, 1);
        if (marking.adaptive) {
          for (const [op, args] of marking.ops) {
            w.ue(op);
            args.forEach((a) => w.ue(a));
          }
          w.ue(0);
        }
      }
    }
    if (t !== 2) w.ue(cabac_init);
    w.se(qp_delta + pps.pic_init_qp - APPLE_PPS_FIELDS.pic_init_qp);
    w.ue(dbk);
    if (dbkOffsets) {
      w.se(dbkOffsets[0]);
      w.se(dbkOffsets[1]);
    }
    while (w.length % 8) w.u(1, 1); // cabac_alignment_one_bit
    const head = w.bytes();
    const rbsp = r.buf;
    const body = Buffer.concat([head.subarray(1), rbsp.subarray(dataStart)]);
    return Buffer.concat([head.subarray(0, 1), escapeRbsp(body)]);
  }
  return { rewrite };
}

/** avcC box (full box bytes) carrying the given SPS/PPS, High-profile style like VideoToolbox's. */
export function buildAvcC(sps, pps) {
  const parts = [
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 255]),
    sps,
    Buffer.from([1, pps.length >> 8, pps.length & 255]),
    pps,
  ];
  if (sps[1] >= 100) parts.push(Buffer.from([0xfd, 0xf8, 0xf8, 0x00]));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write('avcC', 4, 'latin1');
  return Buffer.concat([head, body]);
}
