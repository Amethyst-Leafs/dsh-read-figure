// Test-only 8-bit grey PNG encoder.
//
// The pixel layer is checked against synthetic images whose exact blob sizes
// are known, so the tests need to build those images. The plugin itself ships
// no image encoder -- `lib/jpeg.mjs` only ever decodes -- so this lives under
// tools/ and is never part of the published entry points.
//
// Deliberately written from the PNG spec rather than pulled from a dependency:
// the point of these fixtures is to be independent of the decoder under test,
// and a shared codec would share its bugs.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode a single-channel 8-bit image as a PNG.
 *
 * @param {(x:number,y:number)=>number} shade pixel value 0-255
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodeGrayPng(shade, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per row, then the raw samples. Filtering is left
  // off on purpose: the decoder under test is what should be exercised.
  const raw = Buffer.alloc(height * (1 + width));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) raw[p++] = shade(x, y) & 0xff;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
