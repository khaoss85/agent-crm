// @ts-check

/**
 * Backoffice BO-F6-01 AC-3 — Oggi and Connettori renders compared against
 * the approved prototype (`shots-2026-10-24`, committed under
 * `tests/fixtures/bo-reference/`).
 *
 * The prototype PNGs are exactly the canvases `npm run bo:shots` paints
 * (1440x1800 desktop, 390x1600 phone), so every render has a pixel-level
 * reference. Bodies intentionally depart from the prototype (named cards and
 * heroes belong to later stories, recorded as follow-ups), therefore the
 * desktop comparison is scoped to the shell both stories share — the
 * full-height sidebar rail plus the topbar — while the phone comparison is
 * scoped to the space selector, the one chrome block the rail reference
 * and the stacked phone render paint identically (the app stacks below
 * 700px by reviewed responsive design; bodies stay out on both canvases).
 *
 * Two signals, both printed by the test so a CI failure is diagnosable:
 * - match fraction: pixels whose channels all land within tolerance. Catches
 *   a missing/wrong chrome at scale. A blank render still matches the cream
 *   background, so this signal alone never proves a painted screen.
 * - ink recall: dark reference pixels (text cores) found next to dark
 *   rendered pixels (render ink dilated by 1px for antialiasing). Catches
 *   empty renders (recall ~0) where the match fraction stays high.
 * An earlier finding on #362 (view-only harness shots with no sidebar) fails
 * both signals at once: no rail ink and a fully mismatched rail band.
 *
 * PNG decoding uses node builtins only (`node:zlib`): 8-bit non-interlaced
 * PNGs with color types 0 (gray), 2 (RGB) or 6 (RGBA); alpha composites over
 * white, exactly what an opaque screenshot carries. Anything else is
 * rejected fail-closed, like the rest of the shots tooling.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const scriptDir = join(fileURLToPath(import.meta.url), '..');

export const REFERENCE_DIR = join(scriptDir, '..', 'tests', 'fixtures', 'bo-reference');

/**
 * The committed references. `sha256` is over the decoded RGB bytes (not the
 * file): it pins the painted prototype, byte for byte, regardless of PNG
 * encoder settings.
 */
export const REFERENCES = Object.freeze([
  {
    screen: 'oggi', width: 1440, height: 1800, file: 'oggi-desktop.png',
    sha256: '27980f4e16190842b8e227ce0f3de3589b9857b6f08a9a8c4320e8867a64d8bf',
  },
  {
    screen: 'oggi', width: 390, height: 1600, file: 'oggi-phone.png',
    sha256: 'b737d586030f5561354d9f9c0b3b7d8a88a26b6507b9e35cfb18abdb5ba343e0',
  },
  {
    screen: 'connettori', width: 1440, height: 1800, file: 'connettori-desktop.png',
    sha256: '8ef8888f022cf55d01ba0c3af858d6fe7f555255d69c87a11d04a004f2b4f0dc',
  },
  {
    screen: 'connettori', width: 390, height: 1600, file: 'connettori-phone.png',
    sha256: 'db26a4c7bd43e51d775b5bc345857a7ade055571d947a2fa2cd8a5b96718c5cd',
  },
]);

/** @param {string} outDir @param {string} screen @param {number} width @param {number} height */
export function shotFile(outDir, screen, width, height) {
  return join(outDir, `${screen}-${width}x${height}.png`);
}

/** @param {Buffer} bytes @param {number} offset */
function readU32(bytes, offset) {
  return bytes.readUInt32BE(offset);
}

/**
 * Decode a PNG to raw RGB bytes. Accepts a path or a Buffer.
 * @param {string | Buffer} file
 */
export function decodePngRgb(file) {
  const bytes = typeof file === 'string' ? readFileSync(file) : Buffer.from(file);
  const label = typeof file === 'string' ? file : 'buffer';
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`not a PNG: ${label}`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Array<Buffer>} */
  const idat = [];
  let seenIhdr = false;
  while (pos + 8 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = bytes.subarray(pos + 4, pos + 8).toString('ascii');
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (data.length !== length || pos + 12 + length > bytes.length) {
      throw new Error(`truncated PNG chunk in ${label}`);
    }
    if (type === 'IHDR') {
      if (seenIhdr) throw new Error(`double IHDR in ${label}`);
      seenIhdr = true;
      if (length !== 13) throw new Error(`bad IHDR in ${label}`);
      width = readU32(data, 0);
      height = readU32(data, 4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth} in ${label}`);
      if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported color type ${colorType} in ${label}`);
      }
      if (data[10] !== 0 || data[11] !== 0) throw new Error(`unsupported compression/filter in ${label}`);
      if (data[12] !== 0) throw new Error(`interlaced PNG not supported: ${label}`);
      channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
      if (width === 0 || height === 0) throw new Error(`empty image in ${label}`);
    } else if (type === 'IDAT') {
      if (!seenIhdr) throw new Error(`IDAT before IHDR in ${label}`);
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!seenIhdr) throw new Error(`missing IHDR in ${label}`);
  if (idat.length === 0) throw new Error(`missing image data in ${label}`);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error(`broken image stream in ${label}`);
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error(`broken image stream in ${label}`);
  const data = Buffer.alloc(width * height * 3);
  const prev = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    if (filter > 4) throw new Error(`unknown filter ${filter} in ${label}`);
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      if (channels === 1) {
        data[o] = line[x];
        data[o + 1] = line[x];
        data[o + 2] = line[x];
      } else {
        const s = x * channels;
        const alpha = channels === 4 ? line[s + 3] : 255;
        data[o] = Math.round((line[s] * alpha + 255 * (255 - alpha)) / 255);
        data[o + 1] = Math.round((line[s + 1] * alpha + 255 * (255 - alpha)) / 255);
        data[o + 2] = Math.round((line[s + 2] * alpha + 255 * (255 - alpha)) / 255);
      }
    }
    line.copy(prev);
  }
  return { width, height, data };
}

/** @param {{ width: number, height: number, data: Buffer }} image */
export function sha256Rgb(image) {
  return createHash('sha256').update(image.data).digest('hex');
}

/**
 * Whether a pixel belongs to the compared region. Desktop compares the
 * shell both stories share (sidebar rail plus topbar). The phone reference
 * keeps the rail while the app stacks below 700px by reviewed responsive
 * design, so the phone gate compares the one chrome block both layouts
 * paint identically: the space selector (the rail gutter starts at x=225
 * in both references; the block ends above y=64). Bodies stay out on both
 * canvases: named cards and heroes belong to later stories.
 * @param {number} x @param {number} y @param {number} width
 */
export function inCompareMask(x, y, width) {
  if (width === 1440) return x < 272 || y < 72;
  return x < 225 && y < 64;
}

/** @param {number} r @param {number} g @param {number} b */
export function isInk(r, g, b) {
  return (r + g + b) / 3 < 200;
}

/**
 * Compare a rendered shot against its reference. Dimensions must already
 * match (the test asserts them first for a clearer message); a mismatch
 * here is still a hard failure, never a skip.
 * @param {{ width: number, height: number, data: Buffer }} rendered
 * @param {{ width: number, height: number, data: Buffer }} reference
 * @param {{ tolerance?: number }} [options]
 */
export function compareShot(rendered, reference, options = {}) {
  const tolerance = options.tolerance ?? 32;
  if (rendered.width !== reference.width || rendered.height !== reference.height) {
    throw new Error(
      `size mismatch: render ${rendered.width}x${rendered.height}, `
      + `reference ${reference.width}x${reference.height}`,
    );
  }
  const { width, height } = reference;
  // Render ink dilated by 1px: antialiased text edges may move a pixel
  // between renderers, but every dark reference pixel (a text core) must
  // still land next to a dark rendered pixel.
  const renderInk = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      if (isInk(rendered.data[o], rendered.data[o + 1], rendered.data[o + 2])) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) renderInk[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  let mask = 0;
  let match = 0;
  let refInkInMask = 0;
  let foundInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!inCompareMask(x, y, width)) continue;
      mask += 1;
      const o = (y * width + x) * 3;
      const dr = Math.abs(rendered.data[o] - reference.data[o]);
      const dg = Math.abs(rendered.data[o + 1] - reference.data[o + 1]);
      const db = Math.abs(rendered.data[o + 2] - reference.data[o + 2]);
      if (Math.max(dr, dg, db) <= tolerance) match += 1;
      if (isInk(reference.data[o], reference.data[o + 1], reference.data[o + 2])) {
        refInkInMask += 1;
        if (renderInk[y * width + x] === 1) foundInk += 1;
      }
    }
  }
  return {
    width,
    height,
    maskPixels: mask,
    matchFraction: mask === 0 ? 1 : match / mask,
    inkRecall: refInkInMask === 0 ? 1 : foundInk / refInkInMask,
    refInkPixels: refInkInMask,
  };
}
