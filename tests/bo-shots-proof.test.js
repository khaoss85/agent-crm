// @ts-check
/**
 * Backoffice BO-F6-05 — viewable proof PNGs (backlog:5acdfd87bbd0, continues #405).
 *
 * The command output stays outside the repo by spec (`--out <dir>`); the
 * fixtures below are the AC-3 viewable proof: one PNG per screen at desktop
 * (1440x1800) and phone (390x1600) widths. They are genuine
 * `scripts/bo-shots.js` renders from the CI `bo-shots` workflow
 * (run 40750281740, 2026-10-28T19:31Z, on the self-hosted Mac runner — the
 * only runner where Chromium paints): the render itself is probe-gated on
 * painted demo data, so a committed fixture can never come from an empty
 * screen. The painted inputs of these 13 screens (styles, shell, view
 * modules, harness, fixtures) are byte-identical between that run's tree
 * (`minimal/22d4dd0f-clienti` @ e0461744) and this branch's tree — that
 * branch changes only `admin-clienti.js` (plus its tests), which only the
 * clienti harness loads.
 *
 * The clienti pair is NOT committed here: that branch's clienti PNGs show
 * its newer clienti module, not this tree's, and the account artifact quota
 * is full (`Failed to CreateArtifact: Artifact storage quota has been hit`,
 * recalculated every 6-12 h), so the 2026-10-28 main render (run
 * 40757974910, 28 PNGs painted) could not be stored. The clienti fixtures
 * land in a follow-up once the quota frees: re-run
 * `gh workflow run bo-shots.yml --ref <branch>`, copy `clienti-*.png` here,
 * and drop the PENDING_CLIENTI exception below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP, PHONE, SCREEN_NAMES, readPngSize } from '../scripts/bo-shots.js';

const proofDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'bo-shots-proof');

// Screens whose proof PNGs are committed. `clienti` stays out until the
// quota-blocked CI upload can store a render of this tree (see header).
const PENDING_CLIENTI = ['clienti'];
const PROVEN_SCREENS = SCREEN_NAMES.filter((name) => !PENDING_CLIENTI.includes(name));

test('bo:shots proof fixtures show every committed screen filled at both widths', () => {
  assert.deepEqual(
    [...PROVEN_SCREENS, ...PENDING_CLIENTI].sort(),
    [...SCREEN_NAMES].sort(),
    'the proof set plus the pending clienti pair covers the whole registry',
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

test.todo('bo:shots proof fixtures for clienti (quota-blocked CI upload, see file header)');
