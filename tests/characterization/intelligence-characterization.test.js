import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSERTED, CLASSIFICATIONS, LEGACY_CHARACTERIZATION_CONTRACT, buildBaseline, canonical,
  compareToBaseline, observation,
} from './characterization-contract.mjs';
import { ATTACHMENT } from './intelligence-harness.mjs';
import { generateBaseline, sourceFingerprints } from './run-intelligence-characterization.mjs';

/**
 * LA0 — the Lead Intelligence characterization gate.
 *
 * This suite freezes what Lead Intelligence *externally does* today, so the
 * extraction can be proved to change none of it. It moves no code, changes no
 * architecture, moves no helper, replaces no ambient field and adds no seam.
 *
 * The one thing it must never become is a suite that freezes bugs. Every
 * observation is classified, and only `contractual` and
 * `compatibility_required` are compared — `incidental` is recorded so a change
 * is visible without forbidding it, and `defect_candidate` is reproduced and
 * documented so nobody rediscovers it mid-extraction.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(repoRoot, 'tests/characterization/intelligence-baseline.json'), 'utf8'));

/** Generated once: booting real projects for every test would be minutes of nothing new. */
let fresh;
test.before(async (t) => { fresh = await generateBaseline(t); }, { timeout: 600_000 });

test('the checked-in baseline is a valid contract document', () => {
  assert.equal(BASELINE.legacyCharacterizationContract, LEGACY_CHARACTERIZATION_CONTRACT);
  assert.equal(BASELINE.domain, 'lead-intelligence');
  assert.equal(BASELINE.attachment, ATTACHMENT);
  assert.ok(BASELINE.observations.length > 100, 'a thin baseline proves thin things');

  for (const entry of BASELINE.observations) {
    assert.ok(CLASSIFICATIONS.includes(entry.classification), `${entry.id}: ${entry.classification}`);
    if (entry.classification === 'defect_candidate') {
      assert.ok(entry.note, `${entry.id}: a defect candidate without an explanation is not a finding`);
    }
  }
  // No absolute path, no secret, no source body, no wall clock.
  const text = JSON.stringify(BASELINE);
  assert.doesNotMatch(text, /\/home\/|\/Users\/|C:\\\\/, 'no absolute path');
  assert.doesNotMatch(text, /-----BEGIN|password|secret_key/i, 'no credential-shaped text');
  assert.ok(text.length < 2_000_000, 'a baseline nobody can read is a baseline nobody reviews');
});

test('the current behaviour matches the frozen baseline', () => {
  const comparison = compareToBaseline(BASELINE, fresh.observations);
  assert.deepEqual(comparison.changed, [], 'an asserted value moved: that is a behaviour change, not a baseline update');
  assert.deepEqual(comparison.missing, [], 'a case stopped running, which would hide a behaviour change');
  assert.deepEqual(comparison.added, [], 'the suite grew; regenerate the baseline deliberately');
  assert.deepEqual(comparison.reclassified, [], 'an observation changed classification without review');
  assert.equal(fresh.fingerprint, BASELINE.fingerprint);
});

test('the baseline is stale when behaviour-bearing source changes', () => {
  // Not a git SHA: a baseline must go stale when the source that decides
  // behaviour changes, and a SHA moves for a typo in a README.
  assert.deepEqual(sourceFingerprints(repoRoot), BASELINE.source,
    'a source file that decides Lead Intelligence behaviour changed — regenerate the baseline deliberately '
    + 'with `npm run characterize:intelligence` and review the diff');

  for (const [file, digest] of Object.entries(BASELINE.source)) {
    assert.notEqual(digest, 'absent', `${file} is recorded as absent; the baseline was generated against a different tree`);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test('generation is separate from verification, and never runs during verify', () => {
  const script = readFileSync(join(repoRoot, 'scripts/characterize-intelligence.mjs'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  // A harness that refreshed its own baseline during `verify` would turn every
  // behaviour change into a silent update — the one thing it must never do.
  assert.doesNotMatch(String(manifest.scripts.verify), /characterize/);
  assert.match(String(manifest.scripts['characterize:intelligence']), /characterize-intelligence/);
  assert.match(script, /intelligence-baseline\.json/);
});

test('incidental observations are recorded and never asserted', () => {
  const incidental = BASELINE.observations.filter((entry) => entry.classification === 'incidental');
  assert.ok(incidental.length > 0, 'nothing is purely incidental? that is a classification nobody used honestly');

  // Changing an incidental value must not move the fingerprint. Freezing row
  // ordering is how a characterization suite becomes the thing that blocks the
  // refactor it was built to enable.
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'incidental'
    ? { ...entry, observed: ['completely', 'different', 'order'] } : entry));
  const rebuilt = buildBaseline({
    domain: BASELINE.domain, attachment: BASELINE.attachment, source: BASELINE.source, observations: mutated,
  });
  assert.equal(rebuilt.fingerprint, BASELINE.fingerprint);
  assert.deepEqual(compareToBaseline(BASELINE, mutated).changed, []);
});

test('defect candidates are reproduced, documented and never frozen as contract', () => {
  const defects = BASELINE.observations.filter((entry) => entry.classification === 'defect_candidate');
  assert.ok(defects.length > 0);
  for (const entry of defects) {
    assert.ok(!ASSERTED.includes(entry.classification), `${entry.id} must not be asserted as must-stay`);
    assert.match(entry.note, /[Rr]ecommend/, `${entry.id}: a defect candidate names the fix it recommends`);
  }
  // The two found today, so a reader of the diff knows what they are.
  assert.deepEqual(defects.map((entry) => entry.id).sort(), [
    'hostile-input.record-signal.control',
    'hostile-input.record-signal.oversized',
  ]);
  // And changing one must not fail the suite: they are not the contract.
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'defect_candidate'
    ? { ...entry, observed: { accepted: false, status: 422, stored: null } } : entry));
  assert.deepEqual(compareToBaseline(BASELINE, mutated).changed, []);
});

test('more than 500 individual values are asserted, not a summary count', () => {
  const leaves = (value) => {
    if (Array.isArray(value)) return value.length === 0 ? 1 : value.reduce((total, entry) => total + leaves(entry), 0);
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      return keys.length === 0 ? 1 : keys.reduce((total, key) => total + leaves(value[key]), 0);
    }
    return 1;
  };
  const asserted = BASELINE.observations.filter((entry) => ASSERTED.includes(entry.classification));
  const total = asserted.reduce((sum, entry) => sum + leaves(entry.observed), 0);
  assert.ok(total > 500, `only ${total} exact values are asserted`);
});

// ---------------------------------------------------------------------------
// mutation sensitivity — a characterization suite that cannot fail is decoration
// ---------------------------------------------------------------------------

/** Apply a mutation to a copy of the fresh observations and expect it to be caught. */
function mutate(id, change) {
  return fresh.observations.map((entry) => (entry.id === id || (typeof id === 'function' && id(entry))
    ? { ...entry, observed: change(entry.observed) } : entry));
}

test('LA0 fails when a score keeps its number but changes its fingerprint', () => {
  const mutated = mutate('scoring.v1.identity', (observed) => ({ ...observed, fingerprint: 'f'.repeat(64) }));
  const comparison = compareToBaseline(BASELINE, mutated);
  // The most important assertion in this file. A model returning the same
  // number under a different fingerprint is a DIFFERENT decision, and a suite
  // that only compared totals would call the extraction a success.
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.changed.map((entry) => entry.id), ['scoring.v1.identity']);
});

test('LA0 fails when a provider fingerprint changes', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('architecture.fingerprint.enrichmentProviders.fixture-firmographics@1', () => 'a'.repeat(64)));
  assert.equal(comparison.ok, false);
});

test('LA0 fails when the routing target set changes', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('routing.v1.target-set-evidence', (observed) => observed.slice(0, 1)));
  assert.equal(comparison.ok, false);
  assert.equal(comparison.changed[0].id, 'routing.v1.target-set-evidence');
});

test('LA0 fails when a capacity or routing decision changes', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('routing.v1.decision', (observed) => ({ ...observed, targetKey: 'somewhere-else' })));
  assert.equal(comparison.ok, false);
});

test('LA0 fails when an assignment stops being written', () => {
  const comparison = compareToBaseline(BASELINE, mutate('assignment.created-from-routing', () => []));
  assert.equal(comparison.ok, false);
});

test('LA0 fails when an audit event disappears', () => {
  const comparison = compareToBaseline(BASELINE, mutate('audit.counts-by-action', (observed) => {
    const [first] = Object.keys(observed);
    const { [first]: _dropped, ...rest } = observed;
    return rest;
  }));
  assert.equal(comparison.ok, false);
});

test('LA0 fails when a lifecycle gate is relaxed', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('lifecycle.disqualified-lead.score', () => ({ refused: false, status: null })));
  assert.equal(comparison.ok, false);
});

test('LA0 fails when >500-scale correctness breaks for a single lead', () => {
  const target = BASELINE.observations.find((entry) => entry.id.startsWith('scale.lead-'));
  const comparison = compareToBaseline(BASELINE,
    mutate(target.id, (observed) => ({ ...observed, total: observed.total + 1 })));
  assert.equal(comparison.ok, false);
  assert.equal(comparison.changed[0].id, target.id);
});

test('LA0 fails when schema or action metadata changes', () => {
  for (const id of ['architecture.lead-actions-advertised', 'architecture.lead-managed-fields']) {
    const comparison = compareToBaseline(BASELINE, mutate(id, (observed) => observed.slice(1)));
    assert.equal(comparison.ok, false, `${id} must be caught`);
  }
  // Each part of an action's public contract separately: the route a consumer
  // calls, the declared inputs, and the states it is allowed from.
  for (const change of [
    (observed) => ({ ...observed, path: '/api/somewhere/else' }),
    (observed) => ({ ...observed, input: observed.input.slice(1) }),
    (observed) => ({ ...observed, fromStates: [...observed.fromStates, 'disqualified'] }),
  ]) {
    const comparison = compareToBaseline(BASELINE, mutate('architecture.action-contract.score', change));
    assert.equal(comparison.ok, false, 'an action contract change must be caught');
  }
  // And the case must actually be capturing something: an empty observation
  // asserts nothing, which is how the first version of it passed while blind.
  const contract = BASELINE.observations.find((entry) => entry.id === 'architecture.action-contract.score');
  assert.ok(contract.observed.input.length > 0, 'the action contract case captured no inputs');
  assert.ok(contract.observed.fromStates.length > 0);
  assert.match(contract.observed.path, /^\/api\//);
});

test('LA0 fails when a neutral helper changes behaviour', () => {
  // The evidence that makes the recommended mechanical helper move checkable.
  for (const id of ['helpers.computeDefinitionFingerprint.nested', 'helpers.withTimeout.outcomes']) {
    const comparison = compareToBaseline(BASELINE, mutate(id, () => ({ changed: true })));
    assert.equal(comparison.ok, false, `${id} must be caught`);
  }
});

test('LA0 fails when a case silently stops running', () => {
  const comparison = compareToBaseline(BASELINE, fresh.observations.filter((entry) => entry.id !== 'scoring.v1.total'));
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, ['scoring.v1.total']);
});

test('LA0 fails when an observation is quietly reclassified', () => {
  // Downgrading a contractual observation to incidental is how somebody makes a
  // failing extraction pass. It is caught as its own kind of difference.
  const mutated = fresh.observations.map((entry) => (entry.id === 'scoring.v1.total'
    ? { ...entry, classification: 'incidental' } : entry));
  const comparison = compareToBaseline(BASELINE, mutated);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.reclassified, [{ id: 'scoring.v1.total', from: 'contractual', to: 'incidental' }]);
});

test('the comparison is order-independent and key-order-independent', () => {
  const shuffled = [...fresh.observations].reverse();
  assert.equal(compareToBaseline(BASELINE, shuffled).ok, true);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('an observation with an unknown classification, category or surface is refused', () => {
  const valid = { id: 'x', category: 'scoring', classification: 'contractual', surface: 'sdk', observed: 1 };
  assert.throws(() => observation({ ...valid, classification: 'probably-fine' }), /unknown classification/);
  assert.throws(() => observation({ ...valid, category: 'vibes' }), /unknown category/);
  assert.throws(() => observation({ ...valid, surface: 'telepathy' }), /unknown surface/);
  assert.throws(() => observation({ ...valid, classification: 'defect_candidate' }), /the note IS the finding/);
});
