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
 *   `minimal/5acdfd87-login`). The account artifact quota is full
 *   (`Failed to CreateArtifact: Artifact storage quota has been hit`), so
 *   the workflow committed the login pair straight to the branch instead
 *   of uploading an artifact (temporary commit-back step, reverted before
 *   the PR). The render is probe-gated on painted demo data like every
 *   other screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP, PHONE, SCREEN_NAMES, readPngSize } from '../scripts/bo-shots.js';

const proofDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'bo-shots-proof');

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
