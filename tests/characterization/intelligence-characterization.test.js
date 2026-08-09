import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSERTED, CLASSIFICATIONS, LEGACY_CHARACTERIZATION_CONTRACT, buildBaseline, canonical,
  compareToBaseline, normalizeIds, observation, sortKeysDeep,
} from './characterization-contract.mjs';
import {
  ATTACHMENT, BEHAVIOUR_BEARING_SOURCE, INTELLIGENCE_SOURCE, unownedIntelligenceSource,
} from './intelligence-harness.mjs';
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

test('generated ids are normalized positionally, so a swap is still a difference', () => {
  // A single `<id>` token made every UUID identical, which made the values
  // deterministic and destroyed the property worth keeping: a run whose signal
  // pointed at the wrong lead compared equal to a correct one.
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  assert.deepEqual(normalizeIds({ x: a, y: a }), { x: '<id:1>', y: '<id:1>' }, 'same id, same token');
  assert.deepEqual(normalizeIds({ x: a, y: b }), { x: '<id:1>', y: '<id:2>' }, 'different ids, different tokens');

  // The property that matters is the RELATIONSHIP, not the label. Two rows
  // pointing at one lead and two rows pointing at different leads must not
  // compare equal — that is how a signal attached to the wrong lead is caught.
  assert.notDeepEqual(normalizeIds({ x: a, y: a }), normalizeIds({ x: a, y: b }),
    'a broken relationship must be visible');

  // And the limitation, stated rather than assumed: a *consistent* global
  // relabelling IS equivalent, because a generated id is arbitrary. Two runs
  // that differ only in which UUID the database happened to mint are the same
  // run, and demanding otherwise would make every regeneration fail.
  assert.deepEqual(normalizeIds({ x: a, y: b }), normalizeIds({ x: b, y: a }));
  // Embedded in a string, which is where the sourceKey carries one.
  assert.equal(normalizeIds(`signal:${a}:x`).endsWith(':x'), true);
  assert.equal(normalizeIds(`signal:${a}:x`), 'signal:<id:1>:x');
  // Provider, model and version identities are never generated and never touched.
  assert.deepEqual(normalizeIds({ model: 'b2b-saas-score', version: 2, fingerprint: 'a'.repeat(64) }),
    { fingerprint: 'a'.repeat(64), model: 'b2b-saas-score', version: 2 });

  const stored = BASELINE.observations.find((entry) => entry.id === 'signals.stored-shape');
  assert.match(stored.observed[0].sourceKey, /^signal:<id:\d+>:/);
});

test('every behaviour-bearing file is owned by the digest, and the set cannot rot', () => {
  // The first version listed eleven files and missed six that matter, including
  // the action runtime, the starter's qualify/disqualify actions whose gating
  // this suite freezes, and the HTTP server that publishes the schema block it
  // freezes. Any of them could have changed observed behaviour without staling
  // the baseline — the one failure a freshness mechanism cannot have.
  for (const file of [
    'packages/core/src/action-runtime.js',
    'packages/app/src/create-app.js',
    'apps/server/src/http-server.js',
    'packages/sdk/src/index.js',
    'examples/starters/b2b-lead-qualification/actions/qualify.js',
    'examples/starters/b2b-lead-qualification/actions/disqualify.js',
  ]) {
    assert.ok(BEHAVIOUR_BEARING_SOURCE.includes(file), `${file} is not owned by the source digest`);
  }
  // And the guard: a future intelligence-*.js in the kernel, or a new
  // Intelligence module manifest, cannot silently fall outside ownership.
  assert.deepEqual(unownedIntelligenceSource(repoRoot), []);
});

test('the wiring seam owns every path that knows where Intelligence lives', () => {
  // The "one file changes at extraction" claim was false: the helper cases
  // imported the internals directly and the evidence cases grepped for those
  // paths, so extraction would have edited two files.
  const dir = join(repoRoot, 'tests/characterization');
  for (const file of readdirSync(dir)) {
    // The harness owns the paths; this file asserts *about* them, so both are
    // expected to mention them.
    if (file === 'intelligence-harness.mjs' || file === 'intelligence-characterization.test.js') continue;
    if (!/\.(mjs|js)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(source, /['"][^'"]*intelligence-(actions|registry)[^'"]*['"]/,
      `${file} reaches an Intelligence internal directly; it belongs in the harness`);
    assert.doesNotMatch(source, /['"][^'"]*intelligence\/generated[^'"]*['"]/, file);
  }
  // Post-extraction the seam points into the package. This assertion used to
  // read /intelligence-registry/, which was the pre-extraction filename — a
  // test that encoded the old topology and had to move with it.
  assert.match(INTELLIGENCE_SOURCE.registry, /packages\/intelligence\/src\/registry\.js$/);
  assert.match(INTELLIGENCE_SOURCE.entry, /packages\/intelligence\/src\/index\.js$/);
  assert.equal(INTELLIGENCE_SOURCE.greps.length, 4);
  // And the kernel must no longer contain the domain at all.
  assert.equal(existsSync(join(repoRoot, 'packages/core/src/intelligence-registry.js')), false,
    'the extraction is not done while the kernel still carries an Intelligence file');
  assert.equal(existsSync(join(repoRoot, 'packages/intelligence/generated/index.js')), false,
    'the fixed project-owned definition slot is replaced by composition, not kept alongside it');
});

test('a case that observes nothing is refused at build time', () => {
  const valid = { id: 'x', category: 'scoring', classification: 'contractual', surface: 'sdk' };
  for (const empty of [[], {}, null, undefined, '']) {
    assert.throws(() => observation({ ...valid, observed: empty }), /observed nothing/,
      `${JSON.stringify(empty)} must be refused`);
  }
  // Unless the emptiness IS the answer and somebody said so.
  assert.doesNotThrow(() => observation({ ...valid, observed: [], allowEmpty: true, note: 'no targets are configured in this fixture' }));
  assert.throws(() => observation({ ...valid, observed: [], allowEmpty: true }), /without saying why/);
  // A non-asserted classification may legitimately observe nothing.
  assert.doesNotThrow(() => observation({ ...valid, classification: 'incidental', observed: [] }));
});

test('legacy architecture facts are evidence, not a contract the extraction must preserve', () => {
  const evidence = BASELINE.observations.filter((entry) => entry.classification === 'pre_extraction_evidence');
  // The ambient field, the ambient schema block, the internal importers and the
  // fixed definition slot are exactly what the extraction exists to move.
  // Asserting them would make LA0 fail a correct extraction.
  assert.deepEqual(evidence.map((entry) => entry.id).sort(), [
    'architecture.app-intelligence-consumers',
    'architecture.app-intelligence-field-present',
    'architecture.definition-registry-slot',
    'architecture.intelligence-internal-importers',
    'architecture.schema-intelligence-block-present',
  ]);
  assert.ok(!ASSERTED.includes('pre_extraction_evidence'));
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'pre_extraction_evidence'
    ? { ...entry, observed: { present: false } } : entry));
  assert.deepEqual(compareToBaseline(BASELINE, mutated).changed, [],
    'the extraction must be free to change these');

  // But consumer-visible facts about the same area stay contractual.
  const kinds = BASELINE.observations.find((entry) => entry.id === 'architecture.definition-kinds-published');
  assert.equal(kinds.classification, 'contractual');
});

test('correctness evidence does not depend on a page bound', () => {
  // `list()` defaults to 100 rows and caps at 500; `listWhere()` is the complete
  // query. Reading evidence through an unbounded list() would truncate silently,
  // and a truncated observation compared against a truncated baseline still
  // passes while proving nothing.
  const page = BASELINE.observations.find((entry) => entry.id === 'signals.beyond-the-default-page');
  assert.equal(page.observed.written, 130);
  assert.equal(page.observed.readBack, 130);
  assert.equal(page.observed.complete, true);
  assert.ok(page.observed.written > 100, 'the case must actually cross the default page');

  const scored = BASELINE.observations.find((entry) => entry.id === 'scoring.signal-count-beyond-the-default-page');
  assert.equal(scored.observed.signalCount, 130, 'the score must count every signal, not one page of them');

  // No unbounded read remains in the cases.
  const cases = readFileSync(join(repoRoot, 'tests/characterization/intelligence-cases.mjs'), 'utf8');
  assert.doesNotMatch(cases, /\.list\(\)/, 'every read asks for an explicit bound');
});

test('the 60-lead scenario is a scale scenario, not the >500 claim', () => {
  const scale = BASELINE.observations.filter((entry) => entry.id.startsWith('scale.lead-'));
  assert.equal(scale.length, 60);
  // The ">500 exact reads" bar is met by the total number of individually
  // asserted VALUES across the whole baseline, which the test above counts.
  // Sixty leads is a separate thing: breadth of input, not depth of assertion.
  assert.ok(scale.length < 500, 'sixty is sixty; the >500 claim is about asserted values');
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

test('the baseline file is byte-reproducible, so its diff is the change', () => {
  // `audit.counts-by-action` and `scale.total-distribution` are built by
  // reduction, so their key order follows runtime iteration order. Two
  // regenerations of identical behaviour produced two byte-different files
  // until the writer sorted keys — and a baseline whose diff is noise is a
  // baseline nobody reads.
  const serialize = (value) => `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
  assert.equal(serialize(fresh), readFileSync(join(repoRoot, 'tests/characterization/intelligence-baseline.json'), 'utf8'));
  assert.equal(serialize({ b: 1, a: { d: 2, c: 3 } }), serialize({ a: { c: 3, d: 2 }, b: 1 }));
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
