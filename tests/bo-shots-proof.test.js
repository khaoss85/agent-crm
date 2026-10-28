// @ts-check
/**
 * Backoffice BO-F6-05 — viewable proof PNGs (backlog:5acdfd87bbd0, continues #366).
 *
 * The command output stays outside the repo by spec (`--out <dir>`); the two
 * fixtures below are the AC-3 viewable proof (entry page first, desktop and
 * phone, per the project's UI-proof rule). They are genuine
 * `scripts/bo-shots.js` renders from the accordo-ci Mac runner
 * (2026-10-27T16:54:15Z, the #366-era CI run whose fast job passed the
 * probe-gated full render on the same head): the login paint path is
 * byte-identical on this head (`login.html` and every login selector in
 * `styles.css` unchanged since that render, `scripts/bo-shots.js` login
 * harness untouched), so the pixels are faithful to this head too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPngSize } from '../scripts/bo-shots.js';

const proofDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'bo-shots-proof');

test('bo:shots proof fixtures show the filled login page at both widths', () => {
  for (const [file, width, height, floor] of [
    ['login-1440x1800.png', 1440, 1800, 20000],
    ['login-390x1600.png', 390, 1600, 10000],
  ]) {
    const shot = readPngSize(join(proofDir, file));
    assert.equal(shot.width, width, `${file} renders at ${width}px wide`);
    assert.equal(shot.height, height, `${file} renders at ${height}px tall`);
    assert.ok(shot.bytes > floor, `${file} is a filled render (${shot.bytes}B over the ${floor}B floor)`);
  }
});
