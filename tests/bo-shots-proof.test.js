// @ts-check
/**
 * Backoffice BO-F6-05 — viewable proof PNGs (backlog:5acdfd87bbd0, continues #405).
 *
 * The command output stays outside the repo by spec (`--out <dir>`); the
 * fixtures below are the AC-3 viewable proof: one PNG per screen at desktop
 * (1440x1800) and phone (390x1600) widths, every one a genuine
 * `scripts/bo-shots.js` render (the render is probe-gated on painted demo
 * data, so a committed fixture can never come from an empty screen).
 *
 * Provenance, per screen (see the PR body for SHAs and run ids):
 * - oggi, clienti, calendario, sequenze, personalizzazione, catalogo,
 *   stato-sync, spazi-accessi: rendered by the supervisor with
 *   `npm run bo:shots` outside the sandbox for the #406 restyle and
 *   committed there under docs/backoffice/design-pass-{1,2}/; copied here
 *   byte-identical. #408 after them touched only the login files, so these
 *   eight still depict the current tree.
 * - cliente, pipeline, reporting, connettori, componenti: rendered by the
 *   CI `bo-shots` workflow (run 40750281740, 2026-10-28T19:31Z, self-hosted
 *   Mac runner). Their paint inputs (view modules, fixtures, harness) are
 *   byte-identical between that run's tree and this one — that tree changes
 *   only `admin-clienti.js` (loaded solely by the clienti harness) and
 *   `admin-customer-data.js` (loaded by no harness page, only by app.js).
 *   Only the global stylesheet moved since (#406), so these show the same
 *   screens and demo data in the previous dressing.
 * - login: rendered by the CI `bo-shots` workflow on the self-hosted Mac
 *   runner for this branch (workflow_dispatch run 40775943607 on
 *   `minimal/5acdfd87-login`; `login.html`/`login.js` byte-identical to
 *   this tree). The account artifact quota is full
 *   (`Failed to CreateArtifact: Artifact storage quota has been hit`), so
 *   the workflow committed the login pair straight to the branch instead
 *   of uploading an artifact (temporary commit-back step, reverted before
 *   the PR). That render checked the login expects in the painted DOM; the
 *   pair below is tied to the current tree two ways: the stale pre-#408
 *   blobs are refused outright and the login source fingerprints must
 *   match, so a restyle without a fresh render fails. The next render also
 *   runs the login probe gate (`assertProbe` 'login': magic form, email
 *   field, Google button, story panel, installed #408 enhancement).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP, PHONE, SCREEN_NAMES, readPngSize } from '../scripts/bo-shots.js';

const proofDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'bo-shots-proof');
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// All fourteen screens carry committed proof PNGs, login included.
const PROVEN_SCREENS = [...SCREEN_NAMES];

test('bo:shots proof fixtures show every committed screen filled at both widths', () => {
  assert.deepEqual(
    [...PROVEN_SCREENS].sort(),
    [...SCREEN_NAMES].sort(),
    'the proof set covers the whole screen registry',
  );
  assert.equal(PROVEN_SCREENS.length, 14, 'fourteen screens carry committed proof');
  for (const name of PROVEN_SCREENS) {
    for (const [viewport, floor] of [[DESKTOP, 20000], [PHONE, 10000]]) {
      const file = `${name}-${viewport.width}x${viewport.height}.png`;
      const shot = readPngSize(join(proofDir, file));
      assert.equal(shot.width, viewport.width, `${file} renders at ${viewport.width}px wide`);
      assert.equal(shot.height, viewport.height, `${file} renders at ${viewport.height}px tall`);
      assert.ok(shot.bytes > floor, `${file} is a filled render (${shot.bytes}B over the ${floor}B floor)`);
    }
  }
});

// Regression for the review P2 on this PR: the proof above is size-only, so
// the stale pre-#408 login pair (1440x1800 at 113941 bytes, 390x1600 at
// 86426 bytes) passed it. The committed pair must differ from those blobs
// AND come from the current login sources: the fingerprints below are the
// sha256 of apps/admin/public/login.html and login.js at the CI render
// (byte-identical to this tree), so a login restyle without a fresh render
// fails here first.
const STALE_LOGIN_BLOBS = Object.freeze({
  'login-1440x1800.png': '853fda6b8fd1c9ea46e3dfca0297ecaa5fdb21127ff60a774e82c1106f6f0c48',
  'login-390x1600.png': 'f9f61b8291c3e94667d52adf643acf66ec1b9df90ad87e193bcb81400abcde03',
});

const LOGIN_SOURCES = Object.freeze({
  'apps/admin/public/login.html': 'e03cb839f27a4ed6234570ca40bc4a74bf6b1c8864d59a88c042bce3d9c62b64',
  'apps/admin/public/login.js': '15e8530c640156e11f00afad2f489f824de5dcf88ee831ad7e8bca069633e55e',
});

function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// The catalogo proof pair (BO-F6-15, backlog:11f49cab2517) carries the same
// freshness gate as login: the committed PNGs must differ from the #413-era
// blobs (rendered for the #406 restyle, before the #426 spec-exact lede) AND
// come from the current catalog view sources, so a view restyle without a
// fresh `npm run bo:shots -- --screen catalogo` render fails here first.
const STALE_CATALOGO_BLOBS = Object.freeze({
  'catalogo-1440x1800.png': 'f4cad2199d044aa14c275fc573dbcd6e6a96cfaf2ec3b3a3ec821447a83bf501',
  'catalogo-390x1600.png': '1a79a8e3a6465a7f3faf3d82f6bb01b2ef18e2b991aa505606b47c4f041c8365',
});

const CATALOGO_SOURCES = Object.freeze({
  'apps/admin/public/admin-catalog.js': '1b1ebca802e3233cfc4f376b7924a63a3d03a68a4fdf3c3386aa9e2d7636fe8c',
});

test('the catalogo proof pair is a render of the current tree, never the pre-#426 pair', () => {
  for (const [file, stale] of Object.entries(STALE_CATALOGO_BLOBS)) {
    assert.notEqual(
      sha256Hex(join(proofDir, file)),
      stale,
      `${file} is the stale pre-#426 render: re-run \`npm run bo:shots -- --screen catalogo\`, copy the pair here and record the new source fingerprints`,
    );
  }
  const current = {};
  for (const relative of Object.keys(CATALOGO_SOURCES)) {
    current[relative] = sha256Hex(join(repoRoot, relative));
  }
  assert.deepEqual(
    current,
    { ...CATALOGO_SOURCES },
    'a catalogo source moved without a fresh render: re-run `npm run bo:shots -- --screen catalogo`, copy the pair here and record the new fingerprints deliberately',
  );
});

test('the login proof pair is a render of the current tree, never the stale pre-#408 pair', () => {
  for (const [file, stale] of Object.entries(STALE_LOGIN_BLOBS)) {
    assert.notEqual(
      sha256Hex(join(proofDir, file)),
      stale,
      `${file} is the stale pre-#408 render: re-run \`npm run bo:shots -- --screen login\`, copy the pair here and record the new source fingerprints`,
    );
  }
  const current = {};
  for (const relative of Object.keys(LOGIN_SOURCES)) {
    current[relative] = sha256Hex(join(repoRoot, relative));
  }
  assert.deepEqual(
    current,
    { ...LOGIN_SOURCES },
    'a login source moved without a fresh render: re-run `npm run bo:shots -- --screen login`, copy the pair here and record the new fingerprints deliberately',
  );
});
