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
 * live pins drift from `tests/package-surface-baseline.json`:
 *
 * - fingerprint moved, version still → "aumenta la versione di <pacchetto>";
 * - both moved (or version moved alone) → red until the baseline is
 *   regenerated in the same commit (`npm run surface:baseline`).
 *
 * Both contract graphs are pinned (giro 2, review P1 on #675): a V2-only move
 * must stay red exactly like a V1 one. New-package detection is checked by
 * two independent methods (giro 2, review P2 on #675): the gate probes
 * modules at runtime, this file scans the `src/` tree as text, and the first
 * test asserts both methods agree — a disagreement is itself red, so one
 * heuristic can never silently blind the pair.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_PATH,
  PACKAGES,
  compareSurfaces,
  declaredPackageDirs,
  liveSurfaces,
  readBaseline,
} from '../scripts/package-surface.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Independent package enumeration: a declaration-shaped source-text scan of
 * the whole `src/` tree per package directory. Comments, block comments and
 * template literals are stripped first, so scaffold templates (packages/cli)
 * and the kernel's own `definePackage` definition and re-wrap call
 * (packages/core) do not count — only a real `definePackage({` declaration
 * does. Deliberately separate code from the gate's runtime probe in
 * `scripts/package-surface.js`: different mechanism, different blind spots.
 * The runtime probe catches what this scan cannot (an aliased call such as
 * `dp({`), this scan catches what the probe cannot (a factory the probe
 * would not call), and the agreement assertion below makes a disagreement
 * red instead of silent.
 * @returns {string[]}
 */
function staticPackageDirs() {
  const strip = (source) => source
    .replace(/`(?:\\.|[^`\\])*`/gs, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S:])\/\/[^\n]*/g, '$1');
  const out = [];
  const packagesRoot = join(repoRoot, 'packages');
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcRoot = join(packagesRoot, entry.name, 'src');
    try {
      if (!statSync(srcRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    const stack = [srcRoot];
    let found = false;
    while (stack.length > 0 && !found) {
      const current = stack.pop();
      if (current === undefined) break;
      for (const child of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, child.name);
        if (child.isDirectory()) {
          stack.push(full);
        } else if (child.isFile() && child.name.endsWith('.js')) {
          if (/definePackage\s*\(\s*\{/.test(strip(readFileSync(full, 'utf8')))) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) out.push(entry.name);
  }
  return out.sort();
}

/**
 * Packages legitimately pinned once: their factory refuses the contract-2
 * option (unknown-option validation), so no contract-2 graph exists. The day
 * a twin lands, its new pin appears as BASELINE_MISSING red — and this set
 * must shrink back (asserted below), so the exception cannot outlive its
 * reason.
 */
const SINGLE_GRAPH = new Set(['magic-link']);

test('every declared package is pinned on both graphs, and the pins match the live surfaces', async () => {
  const baseline = readBaseline();
  const live = await liveSurfaces();
  const listed = PACKAGES.map((entry) => entry.dir).sort();
  const probed = await declaredPackageDirs();
  const scanned = staticPackageDirs();
  assert.deepEqual(
    probed,
    scanned,
    'the gate runtime probe and this test source scan disagree — '
    + 'one heuristic is blind to a package directory, investigate before pinning either result',
  );
  assert.deepEqual(
    probed,
    listed,
    'a packages/ directory that declares a package but is missing from PACKAGES '
    + 'in scripts/package-surface.js would ship an unpinned surface',
  );
  for (const { dir } of PACKAGES) {
    const graphs = live.filter((entry) => entry.dir === dir).map((entry) => entry.graph).sort();
    if (SINGLE_GRAPH.has(dir)) {
      assert.deepEqual(graphs, ['contract1'], `${dir} is marked single-graph but now pins more — remove it from SINGLE_GRAPH`);
    } else {
      assert.deepEqual(graphs, ['contract1', 'contract2'], `${dir} must pin both contract graphs`);
    }
  }
  const staleSingle = [...SINGLE_GRAPH].filter((dir) => !listed.includes(dir));
  assert.deepEqual(staleSingle, [], `SINGLE_GRAPH names removed packages: ${staleSingle.join(', ')}`);
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
  const current = live.find((entry) => entry.name === 'interactions' && entry.graph === 'contract1');
  assert.ok(current, 'the interactions contract1 pin exists');
  const staleBaseline = {
    contract: 2,
    packages: live.map((entry) => (entry.name === 'interactions' && entry.graph === 'contract1'
      ? { ...entry, fingerprint: '0'.repeat(64) }
      : { ...entry })),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved fingerprint at the same version must fail');
  assert.equal(problems.length, 1, 'only interactions contract1 drifted');
  assert.equal(problems[0].package, 'interactions');
  assert.equal(problems[0].code, 'VERSION_BUMP_REQUIRED');
  assert.match(problems[0].message, /aumenta la versione di interactions/);
});

// The other half of the rule: once the version moves with the surface, the
// test stays red until the baseline is regenerated in the same commit, so
// the diff that changed the surface and the new pins travel together.
test('a moved version and surface stay red until the baseline is refreshed in the same commit', async () => {
  const live = await liveSurfaces();
  const current = live.find((entry) => entry.name === 'interactions' && entry.graph === 'contract1');
  assert.ok(current, 'the interactions contract1 pin exists');
  const staleBaseline = {
    contract: 2,
    packages: live.map((entry) => (entry.name === 'interactions' && entry.graph === 'contract1'
      ? { ...entry, version: Math.max(1, entry.version - 1), fingerprint: '0'.repeat(64) }
      : { ...entry })),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved version and surface without a refreshed baseline must fail');
  assert.equal(problems.length, 1, 'only interactions contract1 drifted');
  assert.equal(problems[0].package, 'interactions');
  assert.equal(problems[0].code, 'BASELINE_STALE');
  assert.match(problems[0].message, /npm run surface:baseline/);
  assert.match(problems[0].message, /stesso commit/);
});

// Giro 2 (review P1 on #675): the contract-2 twin is a distinct declared
// surface — sequences and space-permissions honour `{ packageContract: 2 }`
// with no `*V2` export at all, so a V1-only pin would let a V2-only change
// merge green. The commercial contract-2 graph stands in for the case: a
// stale V2 fingerprint at the same version must demand a version bump.
test('a V2-only surface change at the same version demands a version bump', async () => {
  const live = await liveSurfaces();
  const current = live.find((entry) => entry.name === 'commercial' && entry.graph === 'contract2');
  assert.ok(current, 'the commercial contract2 pin exists');
  const staleBaseline = {
    contract: 2,
    packages: live.map((entry) => (entry.name === 'commercial' && entry.graph === 'contract2'
      ? { ...entry, fingerprint: '0'.repeat(64) }
      : { ...entry })),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved contract-2 fingerprint at the same version must fail');
  assert.equal(problems.length, 1, 'only commercial contract2 drifted');
  assert.equal(problems[0].package, 'commercial');
  assert.equal(problems[0].graph, 'contract2');
  assert.equal(problems[0].code, 'VERSION_BUMP_REQUIRED');
  assert.match(problems[0].message, /aumenta la versione di commercial/);
  assert.match(problems[0].message, /contract2/);
});

// Giro 2 (review P1 on #675): the other half of the rule holds per graph —
// a moved contract-2 version and surface stay red until the baseline is
// refreshed in the same commit.
test('a moved contract-2 version and surface stay red until the baseline is refreshed', async () => {
  const live = await liveSurfaces();
  const current = live.find((entry) => entry.name === 'commercial' && entry.graph === 'contract2');
  assert.ok(current, 'the commercial contract2 pin exists');
  const staleBaseline = {
    contract: 2,
    packages: live.map((entry) => (entry.name === 'commercial' && entry.graph === 'contract2'
      ? { ...entry, version: Math.max(1, entry.version - 1), fingerprint: '0'.repeat(64) }
      : { ...entry })),
  };
  const { ok, problems } = compareSurfaces(staleBaseline, live);
  assert.equal(ok, false, 'a moved contract-2 version and surface without a refreshed baseline must fail');
  assert.equal(problems.length, 1, 'only commercial contract2 drifted');
  assert.equal(problems[0].package, 'commercial');
  assert.equal(problems[0].code, 'BASELINE_STALE');
  assert.match(problems[0].message, /npm run surface:baseline/);
  assert.match(problems[0].message, /stesso commit/);
});
