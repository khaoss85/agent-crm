// @ts-check
/**
 * Minimal PNG decode/compare for the Admin visual-baseline proof (BO-F0-01).
 *
 * `scripts/admin-shots.js` captures real Chromium pixels; the committed
 * before/after pair is compared with `diffPngFiles` here — no native
 * dependency, no browser at compare time, so the evidence test runs in CI
 * and in the sandbox alike. Supports the PNGs Chromium writes (8-bit,
 * non-interlaced, colour types 0/2/3/4/6). Anything else throws instead of
 * passing quietly.
 */

import { inflateSync, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** @param {Buffer} buffer */
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** @type {Uint32Array | undefined} */
crc32.table = undefined;

/**
 * @param {string} type four ASCII letters
 * @param {Buffer} data
 */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * @param {Buffer} raw filtered scanlines
 * @param {number} width
 * @param {number} height
 * @param {number} bpp bytes per pixel
 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const v = raw[pos++];
      if (filter === 0) row[x] = v;
      else if (filter === 1) row[x] = (v + left) & 0xff;
      else if (filter === 2) row[x] = (v + up) & 0xff;
      else if (filter === 3) row[x] = (v + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[x] = (v + pr) & 0xff;
      } else {
        throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
    }
  }
  return out;
}

/**
 * Decode a PNG into raw RGBA pixels.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG: bad signature');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  /** @type {Buffer[]} */
  const idat = [];
  /** @type {Buffer | null} */
  let palette = null;
  /** @type {Buffer | null} */
  let transparency = null;
  let offset = 8;
  let seenIhdr = false;
  let seenIend = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error(`truncated PNG chunk ${type}`);
    const want = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (buffer.readUInt32BE(offset + 8 + length) !== want) {
      throw new Error(`corrupt PNG chunk ${type}: CRC mismatch`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      seenIhdr = true;
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }
    offset += 12 + length;
  }
  if (!seenIhdr) throw new Error('PNG without IHDR');
  if (!seenIend) throw new Error('truncated PNG: missing IEND');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }
  if (width === 0 || height === 0) throw new Error('PNG with zero width or height');
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      r = g = b = raw[i];
    } else if (colorType === 2) {
      r = raw[i * 3];
      g = raw[i * 3 + 1];
      b = raw[i * 3 + 2];
    } else if (colorType === 3) {
      if (!palette || raw[i] * 3 + 2 >= palette.length) {
        throw new Error(`palette index ${raw[i]} outside PLTE`);
      }
      r = palette[raw[i] * 3];
      g = palette[raw[i] * 3 + 1];
      b = palette[raw[i] * 3 + 2];
      if (transparency && raw[i] < transparency.length) a = transparency[raw[i]];
    } else if (colorType === 4) {
      r = g = b = raw[i * 2];
      a = raw[i * 2 + 1];
    } else {
      r = raw[i * 4];
      g = raw[i * 4 + 1];
      b = raw[i * 4 + 2];
      a = raw[i * 4 + 3];
    }
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { width, height, pixels };
}

/**
 * Compare two PNG buffers pixel by pixel (tolerance: none).
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function diffPng(a, b) {
  const left = decodePng(a);
  const right = decodePng(b);
  if (left.width !== right.width || left.height !== right.height) {
    return {
      equal: false,
      reason: 'dimensions',
      left: { width: left.width, height: left.height },
      right: { width: right.width, height: right.height },
      diffPixels: -1,
      firstDiff: null,
    };
  }
  let diffPixels = 0;
  /** @type {{ x: number, y: number, left: number[], right: number[] } | null} */
  let firstDiff = null;
  for (let i = 0; i < left.pixels.length; i += 4) {
    if (
      left.pixels[i] !== right.pixels[i] ||
      left.pixels[i + 1] !== right.pixels[i + 1] ||
      left.pixels[i + 2] !== right.pixels[i + 2] ||
      left.pixels[i + 3] !== right.pixels[i + 3]
    ) {
      diffPixels++;
      if (!firstDiff) {
        const p = i / 4;
        firstDiff = {
          x: p % left.width,
          y: Math.floor(p / left.width),
          left: [...left.pixels.subarray(i, i + 4)],
          right: [...right.pixels.subarray(i, i + 4)],
        };
      }
    }
  }
  return {
    equal: diffPixels === 0,
    reason: diffPixels === 0 ? 'identical' : 'pixels',
    left: { width: left.width, height: left.height },
    right: { width: right.width, height: right.height },
    diffPixels,
    firstDiff,
  };
}

/**
 * Encode raw RGBA pixels as a PNG. Test and tooling helper: the committed
 * proof PNGs are written by Chromium, never by this encoder.
 * @param {{ width: number, height: number, pixels: Buffer, filter?: number }} image
 */
export function encodePng({ width, height, pixels, filter = 0 }) {
  if (![0, 1, 2, 3, 4].includes(filter)) throw new Error(`unknown filter ${filter}`);
  if (pixels.length !== width * height * 4) throw new Error('pixel buffer does not match dimensions');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    if (filter !== 0) {
      // Store pre-filtered bytes so every decoder filter path is exercisable.
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
        const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
        const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
        const v = pixels[y * stride + x];
        const at = y * (stride + 1) + 1 + x;
        if (filter === 1) raw[at] = (v - left) & 0xff;
        else if (filter === 2) raw[at] = (v - up) & 0xff;
        else if (filter === 3) raw[at] = (v - ((left + up) >> 1)) & 0xff;
        else {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          raw[at] = (v - pr) & 0xff;
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
