// Image header probing.
//
// The handoff record must state the true pixel size of every source image: a
// mark's size is only meaningful as "N x M pixels at this resolution", and the
// reader of the handoff cannot open the file to check. So the size is read from
// the file header itself, never from a caller's claim and never from a
// dependency that may not be installed.

import { readFileSync } from 'node:fs';

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Identify an image from its leading bytes.
 *
 * @returns {{ mime: string, width: number, height: number, format: string, bytes: number }}
 * @throws when the file is not a raster format the vision API accepts.
 */
export function probeImage(path) {
  const buf = readFileSync(path);
  return probeImageBuffer(buf, path);
}

export function probeImageBuffer(buf, path = '<buffer>') {
  const bytes = buf.length;
  if (bytes >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes };
  }
  if (bytes >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const dim = jpegSize(buf);
    if (!dim) throw new Error(`${path}: JPEG 头里找不到 SOF 尺寸段，无法确认像素尺寸`);
    return { mime: 'image/jpeg', format: 'jpeg', width: dim.width, height: dim.height, bytes };
  }
  if (bytes >= 30 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', format: 'webp', width: webpSize(buf, path), height: 0, bytes };
  }
  if (bytes >= 10 && buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { mime: 'image/gif', format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), bytes };
  }
  throw new Error(`${path}: 不是可识别的 png / jpeg / webp / gif 图片`);
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf, path) {
  const fourcc = buf.slice(12, 16).toString('latin1');
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    return w;
  }
  if (fourcc === 'VP8 ') {
    return buf.readUInt16LE(26) & 0x3fff;
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return (bits & 0x3fff) + 1;
  }
  throw new Error(`${path}: 无法识别的 WebP 变体 ${JSON.stringify(fourcc)}`);
}

/** Human-facing one-line size, used in the handoff header and the tool result. */
export function describeImageSize(info) {
  const px = info.width && info.height ? `${info.width}×${info.height}px` : '尺寸未知';
  return `${px}, ${(info.bytes / 1024).toFixed(0)} KB, ${info.format}`;
}
