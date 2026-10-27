// @ts-check
/**
 * Backoffice BO-F6-01 AC-3 — the Oggi and Connettori PNGs at 1440px and
 * 390px, compared against the approved prototype
 * (`tests/fixtures/bo-reference/`, from shots-2026-10-24).
 *
 * What each test proves:
 * - the references ship with the repo at exactly the canvases
 *   `npm run bo:shots` paints, byte-identical to the approved prototype
 *   (sha over decoded pixels, encoder-independent);
 * - the PNG decoder is trustworthy: a synthetic RGBA image exercising all
 *   five PNG filters decodes to exact pixels, and interlaced, paletted or
 *   truncated input is refused fail-closed;
 * - where a runnable Chromium exists, Oggi and Connettori are rendered fresh
 *   and compared against the references (shell mask on desktop, whole image
 *   on phone). The swap protection is structural, not pixel-based: the
 *   harness wiring each screen to its real view module is asserted in
 *   tests/bo-shots.test.js, so the pixel gate only has to prove fidelity,
 *   presence of the chrome, and a painted (non-empty) screen. Every number
 *   is printed, so a CI failure carries its own diagnosis.
 *
 * Where no Chromium runs (sandboxes refuse its Mach bootstrap, bare images
 * lack the binary) the render test skips with its reason, exactly like the
 * other `*-shots` tests: the Mac CI runner paints for real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromiumRuns, findChromium } from '../scripts/bo-shots.js';
import {
  REFERENCES,
  REFERENCE_DIR,
  compareShot,
  decodePngRgb,
  sha256Rgb,
  shotFile,
} from '../scripts/bo-reference.js';

const root = join(fileURLToPath(import.meta.url), '..');

// A 3x5 RGBA image using all five PNG filters (one per row), built offline:
// translucent grays, a transparent pixel and opaque primaries.
const SYNTHETIC_RGBA_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAAR0lEQVR4nGP4z8DwHwwZ/v9n5BKR+y8nJ9cIxA1M+7auYVg8a2J9R33Zf+aFCxc0TJo0kWFOjDUDy+/fvxlZWVn/T3wknAoAWXgbEqeym1gAAAAASUVORK5CYII=';
const SYNTHETIC_RGBA_RGB = [
  255, 0, 0, 0, 255, 0, 0, 0, 255,
  10, 20, 30, 147, 152, 157, 255, 255, 255,
  200, 201, 202, 203, 204, 205, 206, 207, 208,
  5, 5, 5, 250, 250, 250, 128, 64, 32,
  255, 255, 255, 255, 255, 255, 162, 168, 175,
];

// Floors with wide margins, measured against the committed references:
// the shell masks are ~97% cream background at tolerance 32 and carry ~3%
// text ink, so a faithful render lands near 0.9 match / 0.8 recall while an
// empty render scores ~0.97 match but ~0 recall, and a missing chrome
// craters both. Bodies intentionally differ (later stories), which is why
// the desktop mask holds the shell only.
const FLOORS = Object.freeze({
  desktop: { match: 0.6, recall: 0.5 },
  phone: { match: 0.5, recall: 0.4 },
});

test('the reference fixtures ship with the repo at the render canvas sizes', () => {
  assert.equal(REFERENCES.length, 4, 'oggi and connettori, desktop and phone');
  for (const ref of REFERENCES) {
    const file = join(REFERENCE_DIR, ref.file);
    assert.ok(existsSync(file), `${ref.file} is committed, not downloaded at test time`);
    const image = decodePngRgb(file);
    assert.equal(image.width, ref.width, `${ref.file} is the desktop/phone canvas`);
    assert.equal(image.height, ref.height, `${ref.file} is the desktop/phone canvas`);
    assert.equal(
      sha256Rgb(image),
      ref.sha256,
      `${ref.file} paints the approved prototype byte for byte`,
    );
  }
});

test('the decoder composites alpha and reverses every PNG filter', () => {
  const image = decodePngRgb(Buffer.from(SYNTHETIC_RGBA_B64, 'base64'));
  assert.equal(image.width, 3);
  assert.equal(image.height, 5);
  assert.deepEqual(Array.from(image.data), SYNTHETIC_RGBA_RGB);
});

test('the decoder refuses interlaced, paletted and truncated input', () => {
  const valid = Buffer.from(SYNTHETIC_RGBA_B64, 'base64');
  // IHDR layout: 8 signature + 4 length + 4 type + 4 width + 4 height, then
  // bit depth (24), color type (25), compression (26), filter (27),
  // interlace (28).
  const interlaced = Buffer.from(valid);
  interlaced[28] = 1;
  assert.throws(() => decodePngRgb(interlaced), /interlaced/);
  const paletted = Buffer.from(valid);
  paletted[25] = 3;
  assert.throws(() => decodePngRgb(paletted), /color type/);
  assert.throws(() => decodePngRgb(valid.subarray(0, 40)), /truncated|broken|missing/);
  assert.throws(() => decodePngRgb(Buffer.from('not a png')), /not a PNG/);
});

const CHROMIUM = findChromium();
const RENDER_SKIP = chromiumRuns(CHROMIUM)
  ? false
  : 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN); the Mac CI runner produces the PNGs';

test('oggi and connettori renders match the approved prototype', { skip: RENDER_SKIP }, () => {
  for (const screen of ['oggi', 'connettori']) {
    const out = mkdtempSync(join(tmpdir(), `bo-reference-${screen}-`));
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out, '--screen', screen], {
      encoding: 'utf8',
      timeout: 600_000,
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, `${screen}: the render exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
    for (const ref of REFERENCES.filter((entry) => entry.screen === screen)) {
      const file = shotFile(out, screen, ref.width, ref.height);
      assert.ok(existsSync(file), `${screen} at ${ref.width}px was painted`);
      const rendered = decodePngRgb(file);
      assert.equal(rendered.width, ref.width, `${screen}: the render is the reference canvas`);
      assert.equal(rendered.height, ref.height, `${screen}: the render is the reference canvas`);
      const reference = decodePngRgb(join(REFERENCE_DIR, ref.file));
      const compared = compareShot(rendered, reference);
      const kind = ref.width === 1440 ? 'desktop' : 'phone';
      const floors = FLOORS[kind];
      console.log(
        `${screen} ${ref.width}x${ref.height} vs ${ref.file}: `
        + `match=${compared.matchFraction.toFixed(3)} recall=${compared.inkRecall.toFixed(3)} `
        + `(mask ${compared.maskPixels}px, ref ink ${compared.refInkPixels}px)`,
      );
      assert.ok(
        compared.matchFraction >= floors.match,
        `${screen} at ${ref.width}px drifts from the prototype `
        + `(match ${compared.matchFraction.toFixed(3)} < ${floors.match})`,
      );
      assert.ok(
        compared.inkRecall >= floors.recall,
        `${screen} at ${ref.width}px lost the prototype chrome `
        + `(ink recall ${compared.inkRecall.toFixed(3)} < ${floors.recall})`,
      );
    }
  }
});
