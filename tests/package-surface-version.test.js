// @ts-check

/**
 * The package surface version gate (backlog:61355d3ed19b).
 *
 * Twice in the night of 2026-11-07/08 a merged PR changed a package's
 * declared surface without bumping its version (agent-crm#662 interactions,
 * agent-crm#668 customer-data): the pilot pins every composed surface's
 * fingerprint, turned red, and needed repair PRs. This test recomputes every
 * fingerprint on every PR (via its own `scripts/ci-fast.sh` phase, so it runs
 * even when the touched-file selection would not pick it) and fails when the
 * live triplets drift from `tests/package-surface-baseline.json`:
 *
 * - fingerprint moved, version still → "aumenta la versione di <pacchetto>";
 * - both moved (or version moved alone) → red until the baseline is
 *   regenerated in the same commit (`npm run surface:baseline`).
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  BASELINE_PATH,
  PACKAGES,
  compareSurfaces,
  declaredPackageDirs,
  liveSurfaces,
  readBaseline,
} from '../scripts/package-surface.js';

test('every declared package is pinned, and the pins match the live surfaces', async () => {
  const baseline = readBaseline();
  const live = await liveSurfaces();
  const listed = new Set(PACKAGES.map((entry) => entry.dir));
  assert.deepEqual(
    declaredPackageDirs(),
    [...listed].sort(),
    'a packages/ directory that declares a package but is missing from PACKAGES '
    + 'in scripts/package-surface.js would ship an unpinned surface',
  );
  const { problems } = compareSurfaces(baseline, live);
  assert.deepEqual(
    problems.map((problem) => problem.message),
    [],
    `package surfaces drifted from ${BASELINE_PATH} — see each message for the fix`,
  );
});

// The #662 shape: agent-crm#662 added the delivery advance
// (`advanceMessage` on the interaction-log capability, plus its new
// description) while interactions was still at version 2. The pilot saw a
// new fingerprint under the old version and turned red. A baseline that
// still pins the old fingerprint at the same version must demand a version
// bump — never a silent baseline refresh.
test('#662: a changed surface at the same version demands a version bump', async () => {
  const live = await liveSurfaces();
  const current = live.find((entry) => entry.name === 'interactions');
  assert.ok(current, 'the interactions package exists');
  const staleBaseline = {
    contract: 1,
    packages: live.map((entry) => entry.name === 'interactions'
      ? { name: entry.name, version: entry.version, fingerprint: '0'.repeat(64) }
      : { name: entry.name, version: entry.version, fingerprint: entry.fingerprint }),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved fingerprint at the same version must fail');
  assert.equal(problems.length, 1, 'only interactions drifted');
  assert.equal(problems[0].package, 'interactions');
  assert.equal(problems[0].code, 'VERSION_BUMP_REQUIRED');
  assert.match(problems[0].message, /aumenta la versione di interactions/);
});

// The other half of the rule: once the version moves with the surface, the
// test stays red until the baseline is regenerated in the same commit, so
// the diff that changed the surface and the new pins travel together.
test('a moved version and surface stay red until the baseline is refreshed in the same commit', async () => {
  const live = await liveSurfaces();
  const current = live.find((entry) => entry.name === 'interactions');
  assert.ok(current, 'the interactions package exists');
  const staleBaseline = {
    contract: 1,
    packages: live.map((entry) => entry.name === 'interactions'
      ? { name: entry.name, version: Math.max(1, entry.version - 1), fingerprint: '0'.repeat(64) }
      : { name: entry.name, version: entry.version, fingerprint: entry.fingerprint }),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved version and surface without a refreshed baseline must fail');
  assert.equal(problems.length, 1, 'only interactions drifted');
  assert.equal(problems[0].package, 'interactions');
  assert.equal(problems[0].code, 'BASELINE_STALE');
  assert.match(problems[0].message, /npm run surface:baseline/);
  assert.match(problems[0].message, /stesso commit/);
});
