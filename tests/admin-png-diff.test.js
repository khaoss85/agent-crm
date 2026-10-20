// @ts-check
/**
 * Unit tests for `scripts/admin-png-diff.js`: the comparator behind the
 * Admin visual-baseline proof. Synthetic PNGs only — no browser, no fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, diffPng, encodePng } from '../scripts/admin-png-diff.js';

/** Deterministic gradient pixels: every channel derives from x/y. */
function gradient(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = (x * 37) & 0xff;
      pixels[i + 1] = (y * 53) & 0xff;
      pixels[i + 2] = ((x + y) * 17) & 0xff;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

test('identical buffers compare equal, with zero diff pixels', () => {
  const pixels = gradient(9, 7);
  const a = encodePng({ width: 9, height: 7, pixels });
  const b = encodePng({ width: 9, height: 7, pixels: Buffer.from(pixels) });
  const result = diffPng(a, b);
  assert.equal(result.equal, true);
  assert.equal(result.reason, 'identical');
  assert.equal(result.diffPixels, 0);
  assert.equal(result.firstDiff, null);
});

test('every PNG filter row survives a round trip', () => {
  const pixels = gradient(11, 5);
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(encodePng({ width: 11, height: 5, pixels, filter }));
    assert.equal(decoded.width, 11);
    assert.equal(decoded.height, 5);
    assert.ok(decoded.pixels.equals(pixels), `filter ${filter} must round-trip exactly`);
  }
});

test('a single changed pixel is located exactly', () => {
  const width = 6;
  const height = 4;
  const pixels = gradient(width, height);
  const changed = Buffer.from(pixels);
  // Third row, second column: flip the green channel only.
  const at = (2 * width + 1) * 4 + 1;
  changed[at] = (changed[at] + 1) & 0xff;
  const result = diffPng(
    encodePng({ width, height, pixels }),
    encodePng({ width, height, pixels: changed }),
  );
  assert.equal(result.equal, false);
  assert.equal(result.reason, 'pixels');
  assert.equal(result.diffPixels, 1);
  assert.equal(result.firstDiff?.x, 1);
  assert.equal(result.firstDiff?.y, 2);
  assert.deepEqual(result.firstDiff?.left, [37, 106, 51, 255]);
  assert.deepEqual(result.firstDiff?.right, [37, 107, 51, 255]);
});

test('different dimensions fail as dimensions, never as pixels', () => {
  const result = diffPng(
    encodePng({ width: 4, height: 4, pixels: gradient(4, 4) }),
    encodePng({ width: 5, height: 4, pixels: gradient(5, 4) }),
  );
  assert.equal(result.equal, false);
  assert.equal(result.reason, 'dimensions');
  assert.deepEqual(result.left, { width: 4, height: 4 });
  assert.deepEqual(result.right, { width: 5, height: 4 });
});

test('grayscale, palette and gray-alpha PNGs decode to the same RGBA', () => {
  // Built with an independent local writer (not the module encoder), so the
  // decoder is checked against separately-constructed bytes. 2x1: red, green.
  const gray = buildPng({ width: 2, height: 1, colorType: 0, rows: [[0, 76]] });
  assert.deepEqual([...decodePng(gray).pixels], [0, 0, 0, 255, 76, 76, 76, 255]);
  const paletted = buildPng({
    width: 2,
    height: 1,
    colorType: 3,
    palette: [255, 0, 0, 0, 255, 0],
    rows: [[0, 1]],
  });
  assert.deepEqual([...decodePng(paletted).pixels], [255, 0, 0, 255, 0, 255, 0, 255]);
  const grayAlpha = buildPng({ width: 2, height: 1, colorType: 4, rows: [[0, 255, 200, 128]] });
  assert.deepEqual([...decodePng(grayAlpha).pixels], [0, 0, 0, 255, 200, 200, 200, 128]);
});

/**
 * Minimal independent PNG writer for decoder tests: filter-0 rows only.
 * @param {{ width: number, height: number, colorType: number, rows: number[][], palette?: number[] }} image
 */
function buildPng({ width, height, colorType, rows, palette = [] }) {
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = Buffer.alloc(height * (width * channels + 1));
  rows.forEach((values, y) => {
    raw[y * (width * channels + 1)] = 0;
    Buffer.from(values).copy(raw, y * (width * channels + 1) + 1);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunkOf('IHDR', ihdr),
  ];
  if (palette.length > 0) parts.push(chunkOf('PLTE', Buffer.from(palette)));
  parts.push(chunkOf('IDAT', deflateSync(raw)), chunkOf('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** @param {string} type @param {Buffer} data */
function chunkOf(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crcOf(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Buffer} buffer */
function crcOf(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('corrupt input throws instead of comparing', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/);
  const good = encodePng({ width: 2, height: 2, pixels: gradient(2, 2) });
  const truncated = good.subarray(0, good.length - 10);
  assert.throws(() => decodePng(truncated), /truncat|CRC/i);
  const tampered = Buffer.from(good);
  tampered[tampered.length - 5] ^= 0xff;
  assert.throws(() => decodePng(tampered), /CRC/);
});

test('short pixel data throws instead of decoding as black', () => {
  // Valid signature, chunks and CRCs throughout — only the inflated rows
  // stop early. Without a length check the missing tail would decode as
  // zeros and a truncated capture could compare equal.
  const full = encodePng({ width: 4, height: 2, pixels: gradient(4, 2) });
  const ihdr = full.subarray(8, 8 + 25);
  const idatStart = full.indexOf(Buffer.from('IDAT')) - 4;
  const idatLen = full.readUInt32BE(idatStart);
  const inflated = inflateSync(full.subarray(idatStart + 8, idatStart + 8 + idatLen));
  const short = chunkOf('IDAT', deflateSync(inflated.subarray(0, inflated.length - 5)));
  const png = Buffer.concat([full.subarray(0, 8), ihdr, short, chunkOf('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(png), /pixel data/);
});
