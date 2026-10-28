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
 * - login: pending. #408 restyled the login files after every committed
 *   login render, and the account artifact quota is full (`Failed to
 *   CreateArtifact: Artifact storage quota has been hit`, recalculated
 *   every 6-12 h), so no fresh login render can be stored right now. The
 *   login pair lands in a follow-up once the quota frees: re-run
 *   `gh workflow run bo-shots.yml`, copy `login-*.png` here, and drop the
 *   PENDING_LOGIN exception below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP, PHONE, SCREEN_NAMES, readPngSize } from '../scripts/bo-shots.js';

const proofDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'bo-shots-proof');

// Screens whose proof PNGs are committed. `login` stays out until the
// quota-blocked CI upload can store a render of the current tree (see header).
const PENDING_LOGIN = ['login'];
const PROVEN_SCREENS = SCREEN_NAMES.filter((name) => !PENDING_LOGIN.includes(name));

test('bo:shots proof fixtures show every committed screen filled at both widths', () => {
  assert.deepEqual(
    [...PROVEN_SCREENS, ...PENDING_LOGIN].sort(),
    [...SCREEN_NAMES].sort(),
    'the proof set plus the pending login pair covers the whole registry',
  );
  assert.equal(PROVEN_SCREENS.length, 13, 'thirteen screens carry committed proof');
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

test.todo('bo:shots proof fixtures for login (quota-blocked CI upload, see file header)');
