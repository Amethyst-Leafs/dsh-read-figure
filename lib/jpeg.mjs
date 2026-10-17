// Minimal baseline-JPEG decoder, grayscale output only.
//
// Why this exists instead of an image dependency: read-figure's whole point is to
// hand a *pure text* model the few pixel-level facts it cannot infer, and the one
// that keeps failing is a 3x3-pixel stray dot. A vision model reliably reports
// smudges and reliably misses dots, so the measurement has to be mechanical — and
// a physics assistant's scanned figures are JPEG, which Node cannot decode on its
// own. A dependency would also mean every user of the plugin inherits a native
// build; this file is ~350 lines of straightforward arithmetic instead.
//
// Scope is deliberately narrow: 8-bit precision, baseline sequential and
// progressive DCT, any component count (extra components are skipped), grayscale
// (luma) output. Anything else raises DecodeError rather than guessing, because a
// silently wrong decode would produce confident nonsense about a figure.

import { inflateSync } from 'node:zlib';

export class DecodeError extends Error {
  constructor(message) {
    super(`read-figure: 无法解码该 JPEG（${message}）`);
    this.name = 'DecodeError';
  }
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const UNZIGZAG = new Uint8Array(64);
for (let i = 0; i < 64; i++) UNZIGZAG[ZIGZAG[i]] = i;

// Inverse DCT basis, applied along rows and then along columns.
//
// The scale here has exactly one correct answer and four plausible-looking wrong
// ones, all of which survive a casual look because a line-art figure stays
// recognisable under any constant gain. Speck detection compares ABSOLUTE
// luminance, so the DC gain must be exactly 1/8 (mean of a block = DC*quant/8).
//
// This basis (sqrt(1/8) at u=0, sqrt(2/8) above) applied along both axes already
// *is* the full 2-D IDCT: for a DC-only block the two passes give
// 8 * (1/8) * F(0,0) / 8 = F(0,0)/8 with nothing left over. Verified numerically
// (raw row sum 124.0 for F(0,0)=992 -> 252).
//
// Wrong versions seen in this file's history, each off by a clean power of two:
//   * sqrt(2/8) on both axes, no extra factor   -> DC/4  (white clamps to 255)
//   * sqrt(1/8)/sqrt(2/8), then an extra /4     -> DC/32 (252-white renders 159)
//   * sqrt(1/16), sqrt(1/8) on both axes        -> DC/16 (252-white renders 190)
// tools/check.mjs pins this against a known block mean so it cannot drift again.
//
// F(u) = c(u) * sum_x f(x) * cos((2x+1)u*pi/16)
// f(x) = c(u) * sum_u F(u) * cos((2x+1)u*pi/16)
// 2-D is separable, so this one matrix is applied twice (columns, then rows).
// Substituting the forward transform back in gives 4 * c(0)^2 = 1, so the
// vector here is c(u), NOT the "normalised" pair that already carries the
// outer 1/4 -- that factor comes from the separable product. Carrying it in
// both places yields DC/4 instead of DC/8, i.e. every pixel lands 64 levels
// too dark (a 252-white renders as 188).
const IDCT = (() => {
  const m = new Float32Array(64);
  const s0 = Math.sqrt(1 / 8);
  const sU = Math.sqrt(2 / 8);
  for (let i = 0; i < 8; i++) {
    for (let u = 0; u < 8; u++) {
      m[i * 8 + u] = (u === 0 ? s0 : sU) * Math.cos(((2 * i + 1) * u * Math.PI) / 16);
    }
  }
  return m;
})();

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  u8() {
    if (this.pos >= this.buf.length) throw new DecodeError('数据在读取中耗尽');
    return this.buf[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
}

/**
 * Decode a JPEG to an 8-bit luminance plane.
 *
 * Returns `{ width, height, data }` where `data` is `width*height` bytes of luma.
 * Colour information is intentionally discarded: speck detection and figure
 * layout both live in luminance.
 */
export function decodeGray(buf, options = {}) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new DecodeError('没有 SOI 标记，不是 JPEG');
  const r = new Reader(buf, 2);
  const frame = { progressive: false, components: [], maxH: 1, maxV: 1 };
  const tables = new Map(); // 'dc'/'ac' -> index -> huffman table
  const quant = new Map(); // index -> Int32Array(64)
  let restartInterval = 0;
  let scan = { components: [], ss: 0, se: 63, ah: 0, al: 0 };
  const planes = [];

  while (r.pos < buf.length) {
    let marker = r.u8();
    if (marker !== 0xff) continue; // scan data leftovers are consumed elsewhere
    while (marker === 0xff) marker = r.u8();
    if (marker === 0x00 || marker === 0xd8) continue;
    if (marker === 0xd9) break; // EOI
    if (marker >= 0xd0 && marker <= 0xd7) continue; // RSTn

    const len = r.u16();
    const segEnd = r.pos - 2 + len;

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      frame.progressive = marker === 0xc2;
      if (marker === 0xc1) throw new DecodeError('不支持 12 位精度');
      r.u8(); // precision
      frame.height = r.u16();
      frame.width = r.u16();
      const n = r.u8();
      if (!frame.height || !frame.width) throw new DecodeError('图像尺寸为 0');
      for (let i = 0; i < n; i++) {
        const id = r.u8();
        const hv = r.u8();
        frame.components.push({
          id,
          h: hv >> 4,
          v: hv & 15,
          tq: r.u8(),
          blocksPerLine: 0,
          blocksPerColumn: 0,
          pred: 0,
          coeffs: null,
        });
      }
      frame.maxH = Math.max(...frame.components.map((c) => c.h));
      frame.maxV = Math.max(...frame.components.map((c) => c.v));
      // The entropy stream is written one MCU at a time, and an MCU is always
      // full: at the right/bottom edge the encoder still emits the padding
      // blocks that fall outside the image. So the coefficient array must be
      // allocated on the MCU grid (mcusPerLine * c.h wide), not on the true
      // image size -- otherwise we skip those padding blocks and lose bit
      // sync a few thousand MCUs in. The true size is kept separately for
      // rendering, which must not read the padding blocks.
      frame.mcusPerLine = Math.ceil(frame.width / (8 * frame.maxH));
      frame.mcusPerColumn = Math.ceil(frame.height / (8 * frame.maxV));
      for (const c of frame.components) {
        c.blocksPerLine = Math.ceil(Math.ceil(frame.width / 8) * (c.h / frame.maxH));
        c.blocksPerColumn = Math.ceil(Math.ceil(frame.height / 8) * (c.v / frame.maxV));
        c.allocPerLine = frame.mcusPerLine * c.h;
        c.allocPerColumn = frame.mcusPerColumn * c.v;
        c.coeffs = new Int32Array(c.allocPerLine * c.allocPerColumn * 64);
      }
    } else if (marker === 0xdd) {
      restartInterval = r.u16();
    } else if (marker === 0xc4) {
      while (r.pos < segEnd) {
        const tc = r.u8();
        const bits = new Uint8Array(17);
        let total = 0;
        for (let i = 1; i <= 16; i++) {
          bits[i] = r.u8();
          total += bits[i];
        }
        const values = new Uint8Array(total);
        for (let i = 0; i < total; i++) values[i] = r.u8();
        tables.set(`${tc >> 4}:${tc & 15}`, buildHuffman(bits, values));
      }
    } else if (marker === 0xdb) {
      while (r.pos < segEnd) {
        const pq = r.u8();
        const tq = pq & 15;
        if (pq >> 4) throw new DecodeError('不支持 16 位量化表');
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) t[ZIGZAG[i]] = r.u8();
        quant.set(tq, t);
      }
    } else if (marker === 0xda) {
      const n = r.u8();
      scan = { components: [], ss: 0, se: 63, ah: 0, al: 0 };
      for (let i = 0; i < n; i++) {
        const cs = r.u8();
        const tdta = r.u8();
        const comp = frame.components.find((c) => c.id === cs);
        if (!comp) throw new DecodeError(`扫描引用了不存在的分量 ${cs}`);
        scan.components.push({ comp, td: tdta >> 4, ta: tdta & 15 });
      }
      scan.ss = r.u8();
      scan.se = r.u8();
      const ahal = r.u8();
      scan.ah = ahal >> 4;
      scan.al = ahal & 15;
      if (scan.components.length > 4) throw new DecodeError('扫描分量过多');
      const end = decodeScan(buf, r.pos, { frame, tables, quant, scan, restartInterval });
      r.pos = end;
      if (!frame.progressive) planes.push(...frame.components.map((c) => c));
    } else if (marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      throw new DecodeError(`不支持该编码方式（SOF 标记 0x${marker.toString(16)}）`);
    } else {
      r.pos = segEnd;
    }
  }

  if (!frame.width) throw new DecodeError('没有找到 SOF 帧头');

  // Inverse quantisation happens here, once, at render time. Storing
  // dequantised coefficients instead would apply the table twice, which is
  // invisible in aggregate (a uniform scale factor just brightens everything)
  // yet fatal for speck detection, which compares absolute luminance.
  return finish(frame, quant);
}

function buildHuffman(bits, values) {
  // Canonical code -> (length, value) lookup, decoded one bit at a time.
  const maxLen = 16;
  const minCode = new Int32Array(maxLen + 1);
  const maxCode = new Int32Array(maxLen + 1).fill(-1);
  const valPtr = new Int32Array(maxLen + 1);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= maxLen; len++) {
    if (bits[len] > 0) {
      minCode[len] = code;
      valPtr[len] = k;
      code += bits[len];
      maxCode[len] = code - 1;
      k += bits[len];
    }
    code <<= 1;
  }
  return { minCode, maxCode, valPtr, values };
}

/** Decode one entropy-coded scan segment, returning the byte offset just past it. */
function decodeScan(buf, start, { frame, tables, quant, scan, restartInterval }) {
  const reader = new BitReader(buf, start);
  const { progressive } = frame;
  const ss = scan.ss;
  const se = scan.se;
  const eobrun = { n: 0 };

  if (!progressive) {
    for (const c of scan.components) {
      if (c.td === undefined) throw new DecodeError('缺少直流 Huffman 表');
    }
  }

  const mcusPerLine = Math.ceil(frame.width / (8 * frame.maxH));
  const mcusPerColumn = Math.ceil(frame.height / (8 * frame.maxV));
  const total = mcusPerLine * mcusPerColumn;
  let mcu = 0;

  while (mcu < total) {
    if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
      reader.alignToByte();
      const m = reader.peekMarker();
      if (m >= 0xd0 && m <= 0xd7) reader.skipRestart();
      for (const c of scan.components) c.comp.pred = 0;
      eobrun.n = 0;
    }
    const limit = restartInterval ? Math.min(total, mcu + restartInterval) : total;
    for (; mcu < limit; mcu++) {
      for (const sc of scan.components) {
        const comp = sc.comp;
        const h = comp.h;
        const v = comp.v;
        const hBlocks = progressive && scan.components.length === 1 ? 1 : h;
        const vBlocks = progressive && scan.components.length === 1 ? 1 : v;
        for (let by = 0; by < vBlocks; by++) {
          for (let bx = 0; bx < hBlocks; bx++) {
            // Index on the MCU grid (allocPerLine/allocPerColumn) so the
            // padding blocks at the right/bottom edge stay inside the array.
            // Every block must be decoded, because the encoder wrote its bits.
            const row = Math.floor(mcu / mcusPerLine) * v + by;
            const col = (mcu % mcusPerLine) * h + bx;
            decodeBlock(reader, {
              comp,
              blockOffset: (row * comp.allocPerLine + col) * 64,
              tables,
              quant: quant.get(comp.tq),
              td: sc.td,
              ta: sc.ta,
              progressive,
              ss,
              se,
              ah: scan.ah,
              al: scan.al,
              eobrun,
              where: { mcu, total, bx, by },
            });
          }
        }
      }
    }
  }
  reader.alignToByte();
  return reader.pos;
}

function decodeBlock(reader, ctx) {
  const { comp } = ctx;
  const mark = reader.bitsUsed;
  try {
    decodeBlockInner(reader, ctx);
  } catch (err) {
    // Say where it died. The block coordinates and bit cursor are what turn
    // "illegal Huffman code" from a dead end into a lead.
    throw new DecodeError(
      `${err.message}（MCU ${ctx.where?.mcu}/${ctx.where?.total} 分量 ${comp.id} ` +
        `块 (${ctx.where?.bx},${ctx.where?.by})，比特游标 ${mark}，已读字节 ${reader.bytesUsed}）`,
    );
  }
}

function decodeBlockInner(reader, ctx) {
  const { comp, blockOffset, tables, quant: q, progressive, ss, se, ah, al, eobrun } = ctx;
  const coeffs = comp.coeffs;
  const qt = q ?? IDENTITY_QUANT;

  if (!progressive) {
    const dcTable = tables.get(`0:${ctx.td}`);
    const acTable = tables.get(`1:${ctx.ta}`);
    if (!dcTable || !acTable) throw new DecodeError('缺少 Huffman 表');
    const t = reader.decodeHuffman(dcTable);
    const diff = t === 0 ? 0 : reader.receiveExtend(t);
    comp.pred += diff;
    coeffs[blockOffset] = comp.pred;
    let k = 1;
    while (k < 64) {
      const rs = reader.decodeHuffman(acTable);
      const s = rs & 15;
      const run = rs >> 4;
      if (s === 0) {
        if (run !== 15) break;
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) break;
      // ZIGZAG maps a zigzag position to its natural (row-major) index; the
      // coefficients array is in natural order, so this is the table to use.
      coeffs[blockOffset + ZIGZAG[k]] = reader.receiveExtend(s);
      k++;
    }
    return;
  }

  // Progressive
  const eob = 1 << al;
  if (ss === 0) {
    const dcTable = tables.get(`0:${ctx.td}`);
    if (!dcTable) throw new DecodeError('缺少直流 Huffman 表');
    if (ah === 0) {
      const t = reader.decodeHuffman(dcTable);
      const diff = t === 0 ? 0 : reader.receiveExtend(t);
      comp.pred += diff;
      coeffs[blockOffset] = comp.pred << al;
    } else if (reader.readBit()) {
      coeffs[blockOffset] += reader.readBit() ? eob : -eob;
    }
    return;
  }

  const acTable = tables.get(`1:${ctx.ta}`);
  if (!acTable) throw new DecodeError('缺少交流 Huffman 表');
  let k = ss;
  if (ah === 0) {
    if (eobrun.n > 0) {
      eobrun.n--;
      return;
    }
    while (k <= se) {
      const rs = reader.decodeHuffman(acTable);
      const s = rs & 15;
      const run = rs >> 4;
      if (s === 0) {
        if (run !== 15) {
          eobrun.n = (1 << run) - 1;
          if (run) eobrun.n += reader.readBits(run);
          break;
        }
        k += 16;
        continue;
      }
      k += run;
      if (k > se) break;
      coeffs[blockOffset + ZIGZAG[k]] = reader.receiveExtend(s) * (1 << al);
      k++;
    }
  } else {
    if (eobrun.n > 0) {
      eobrun.n--;
      return;
    }
    while (k <= se) {
      const zig = ZIGZAG[k];
      if (coeffs[blockOffset + zig] !== 0) {
        if (reader.readBit()) coeffs[blockOffset + zig] += reader.readBit() ? eob : -eob;
      } else {
        const rs = reader.decodeHuffman(acTable);
        const s = rs & 15;
        const run = rs >> 4;
        if (s === 0) {
          if (run !== 15) {
            eobrun.n = (1 << run) - 1;
            if (run) eobrun.n += reader.readBits(run);
            break;
          }
          k += 16;
          continue;
        }
        k += run;
        if (k > se) break;
        coeffs[blockOffset + ZIGZAG[k]] = reader.receiveExtend(s) * eob;
      }
      k++;
    }
  }
}

const IDENTITY_QUANT = new Int32Array(64).fill(1);

class BitReader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCount = 0;
    this.bytesUsed = 0;
    this.bitsUsed = 0;
    // Rolling window of the last 64 bits, kept only so a mid-stream desync can
    // report the exact code that failed. A plain number, not an array, so this
    // costs nothing on the hot path.
    this.recent = 0;
    this.recentLen = 0;
  }
  recentBits(n) {
    const k = Math.min(n, this.recentLen);
    let out = '';
    for (let i = k - 1; i >= 0; i--) out += ((this.recent >>> i) & 1) ? '1' : '0';
    return out;
  }
  readBit() {
    if (this.bitCount === 0) {
      if (this.pos >= this.buf.length) throw new DecodeError('熵编码数据提前结束');
      let b = this.buf[this.pos++];
      if (b === 0xff) {
        const next = this.buf[this.pos];
        if (next === 0x00) this.pos++;
        else throw new DecodeError('熵编码段内出现标记');
      }
      this.bitBuf = b;
      this.bitCount = 8;
      this.bytesUsed++;
    }
    this.bitCount--;
    this.bitsUsed++;
    const bit = (this.bitBuf >> this.bitCount) & 1;
    this.recent = ((this.recent << 1) | bit) >>> 0;
    if (this.recentLen < 64) this.recentLen++;
    return bit;
  }
  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }
  decodeHuffman(table) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.readBit();
      const max = table.maxCode[len];
      if (max >= 0 && code <= max) {
        const idx = table.valPtr[len] + code - table.minCode[len];
        const v = table.values[idx];
        if (v === undefined) throw new DecodeError('Huffman 码越界');
        return v;
      }
    }
    throw new DecodeError('非法的 Huffman 码');
  }
  receiveExtend(s) {
    const v = this.readBits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }
  alignToByte() {
    this.bitCount = 0;
  }
  peekMarker() {
    return this.buf[this.pos] === 0xff ? this.buf[this.pos + 1] : -1;
  }
  skipRestart() {
    this.pos += 2;
    this.bitCount = 0;
  }
}

/** Dequantize, IDCT, upsample, and convert to luma. */
function finish(frame, quant) {
  const { width, height, components } = frame;
  const out = new Uint8Array(width * height);
  const y = components[0];
  const yPlane = renderComponent(y, frame, width, height, quant);

  if (components.length === 1) {
    out.set(yPlane);
    return { width, height, data: out };
  }

  // Chroma is only needed to recover luma from YCbCr. A figure scan has no colour
  // to speak of, but the transform is cheap and skipping it would skew greys.
  const isYCbCr = components.length >= 3;
  if (!isYCbCr) {
    out.set(yPlane);
    return { width, height, data: out };
  }
  const cb = renderComponent(components[1], frame, width, height, quant);
  const cr = renderComponent(components[2], frame, width, height, quant);
  for (let i = 0; i < out.length; i++) {
    const yy = yPlane[i];
    const blue = cb[i] - 128;
    const red = cr[i] - 128;
    const r = yy + 1.402 * red;
    const g = yy - 0.344136 * blue - 0.714136 * red;
    const b = yy + 1.772 * blue;
    // Rec.601 luma of the reconstructed RGB keeps the number comparable to the
    // Y channel alone while removing colour casts.
    out[i] = clamp((0.299 * r + 0.587 * g + 0.114 * b) | 0);
  }
  return { width, height, data: out };
}

function renderComponent(comp, frame, width, height, quant) {
  const plane = new Uint8Array(width * height);
  const bw = comp.blocksPerLine;
  const bh = comp.blocksPerColumn;
  const blockPixels = new Uint8Array(64);
  const dequant = new Float32Array(64);
  const qt = quant.get(comp.tq);
  const sxs = comp.h / frame.maxH;
  const sys = comp.v / frame.maxV;
  const outW = Math.ceil(width * sxs);
  const outH = Math.ceil(height * sys);
  const scaled = new Uint8Array(outW * outH);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // Coeffs are stored on the MCU grid (allocPerLine); only render the
      // blocks that overlap the real image (bw x bh).
      const base = (by * comp.allocPerLine + bx) * 64;
      for (let i = 0; i < 64; i++) dequant[i] = comp.coeffs[base + i] * qt[i];
      idct(dequant, blockPixels);
      for (let py = 0; py < 8; py++) {
        const oy = by * 8 + py;
        if (oy >= outH) break;
        for (let px = 0; px < 8; px++) {
          const ox = bx * 8 + px;
          if (ox >= outW) break;
          scaled[oy * outW + ox] = blockPixels[py * 8 + px];
        }
      }
    }
  }

  if (outW === width && outH === height) return scaled;

  // Nearest-neighbour upsample: figures are line art, so interpolating would only
  // invent grey ramps around every stroke and weaken the speck contrast.
  for (let y2 = 0; y2 < height; y2++) {
    const sy = Math.min(outH - 1, Math.floor((y2 * outH) / height));
    for (let x2 = 0; x2 < width; x2++) {
      const sx = Math.min(outW - 1, Math.floor((x2 * outW) / width));
      plane[y2 * width + x2] = scaled[sy * outW + sx];
    }
  }
  return plane;
}

function idct(coeffs, out) {
  const tmp = new Float32Array(64);
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += IDCT[x * 8 + u] * coeffs[v * 8 + u];
      tmp[v * 8 + x] = sum;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += IDCT[y * 8 + v] * tmp[v * 8 + x];
      out[y * 8 + x] = clamp(Math.round(sum + 128));
    }
  }
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** PNG passthrough so callers can hand both formats to the same pipeline. */
export function decodeGrayPng(buf) {
  const r = new Reader(buf, 8);
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  while (r.pos < buf.length) {
    const len = r.u32();
    const type = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
    const dataStart = r.pos;
    if (type === 'IHDR') {
      width = r.u32();
      height = r.u32();
      bitDepth = r.u8();
      colorType = r.u8();
      if (r.u8() !== 0) throw new DecodeError('不支持隔行 PNG');
      r.u8();
      r.u8();
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    r.pos = dataStart + len + 4; // skip CRC
  }
  if (!width || !height) throw new DecodeError('PNG 缺少 IHDR');
  if (bitDepth !== 8) throw new DecodeError(`不支持 ${bitDepth} 位 PNG`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new DecodeError(`不支持 PNG 颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= channels ? prior[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new DecodeError(`未知 PNG 过滤器 ${filter}`);
      cur[i] = v & 255;
    }
  }

  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const base = i * channels;
    if (colorType === 3) {
      const idx = px[base];
      const [r2, g2, b2] = [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]];
      out[i] = (0.299 * r2 + 0.587 * g2 + 0.114 * b2) | 0;
    } else if (colorType === 0 || colorType === 4) {
      out[i] = px[base];
    } else {
      const r2 = px[base];
      const g2 = px[base + 1];
      const b2 = px[base + 2];
      const alpha = colorType === 6 ? px[base + 3] : 255;
      const lum = (0.299 * r2 + 0.587 * g2 + 0.114 * b2) | 0;
      out[i] = alpha === 255 ? lum : (lum * alpha + 255 * (255 - alpha)) / 255;
    }
  }
  void trns;
  return { width, height, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
