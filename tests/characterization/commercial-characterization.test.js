import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSERTED, CLASSIFICATIONS, LEGACY_CHARACTERIZATION_CONTRACT, buildBaseline, canonical,
  compareToBaseline, sortKeysDeep,
} from './characterization-contract.mjs';
import {
  ATTACHMENT, BEHAVIOUR_BEARING_SOURCE, COMMERCIAL_SOURCE, unownedCommercialSource,
} from './commercial-harness.mjs';
import { generateBaseline, sourceFingerprints } from './run-commercial-characterization.mjs';

/**
 * LA0-Commercial — the Commercial Operations characterization gate.
 *
 * This suite freezes what Commercial Operations *externally does* today, so
 * the extraction can be proved to change none of it. It moves no code, splits
 * no module, replaces no ambient field and adds no seam.
 *
 * Commercial carries money: an observation here is an exact amount, an exact
 * fingerprint, an exact refusal — never a pass/fail summary. Only
 * `contractual` and `compatibility_required` observations are compared;
 * `incidental` is recorded without being asserted, and
 * `pre_extraction_evidence` records the wiring the extraction exists to
 * change.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(repoRoot, 'tests/characterization/commercial-baseline.json'), 'utf8'));

/** Generated once: booting real projects for every test would be minutes of nothing new. */
let fresh;
test.before(async (t) => { fresh = await generateBaseline(t); }, { timeout: 600_000 });

test('the checked-in commercial baseline is a valid contract document', () => {
  assert.equal(BASELINE.legacyCharacterizationContract, LEGACY_CHARACTERIZATION_CONTRACT);
  assert.equal(BASELINE.domain, 'commercial-operations');
  assert.equal(BASELINE.attachment, ATTACHMENT);
  assert.ok(BASELINE.observations.length > 60, 'a thin baseline proves thin things');

  for (const entry of BASELINE.observations) {
    assert.ok(CLASSIFICATIONS.includes(entry.classification), `${entry.id}: ${entry.classification}`);
    if (entry.classification === 'defect_candidate') {
      assert.ok(entry.note, `${entry.id}: a defect candidate without an explanation is not a finding`);
    }
  }
  const text = JSON.stringify(BASELINE);
  assert.doesNotMatch(text, /\/home\/|\/Users\/|C:\\\\/, 'no absolute path');
  assert.doesNotMatch(text, /-----BEGIN|password|secret_key/i, 'no credential-shaped text');
  assert.ok(text.length < 2_000_000, 'a baseline nobody can read is a baseline nobody reviews');
});

test('the current commercial behaviour matches the frozen baseline', () => {
  const comparison = compareToBaseline(BASELINE, fresh.observations);
  assert.deepEqual(comparison.changed, [], 'an asserted value moved: that is a behaviour change, not a baseline update');
  assert.deepEqual(comparison.missing, [], 'a case stopped running, which would hide a behaviour change');
  assert.deepEqual(comparison.added, [], 'the suite grew; regenerate the baseline deliberately');
  assert.deepEqual(comparison.reclassified, [], 'an observation changed classification without review');
  assert.equal(fresh.fingerprint, BASELINE.fingerprint);
});

test('the commercial baseline is stale when behaviour-bearing source changes', () => {
  assert.deepEqual(sourceFingerprints(repoRoot), BASELINE.source,
    'a source file that decides Commercial behaviour changed — regenerate the baseline deliberately '
    + 'with `npm run characterize:commercial` and review the diff');
  for (const [file, digest] of Object.entries(BASELINE.source)) {
    assert.notEqual(digest, 'absent', `${file} is recorded as absent; the baseline was generated against a different tree`);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test('commercial generation is separate from verification, and never runs during verify', () => {
  const script = readFileSync(join(repoRoot, 'scripts/characterize-commercial.mjs'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.doesNotMatch(String(manifest.scripts.verify), /characterize/);
  assert.match(String(manifest.scripts['characterize:commercial']), /characterize-commercial/);
  assert.match(script, /commercial-baseline\.json/);
});

test('incidental commercial observations are recorded and never asserted', () => {
  const incidental = BASELINE.observations.filter((entry) => entry.classification === 'incidental');
  assert.ok(incidental.length > 0, 'nothing is purely incidental? that is a classification nobody used honestly');
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'incidental'
    ? { ...entry, observed: ['completely', 'different', 'order'] } : entry));
  const rebuilt = buildBaseline({
    domain: BASELINE.domain, attachment: BASELINE.attachment, source: BASELINE.source, observations: mutated,
    limitations: BASELINE.limitations.map((entry) => [entry.code, entry.message]),
  });
  assert.equal(rebuilt.fingerprint, BASELINE.fingerprint);
  assert.deepEqual(compareToBaseline(BASELINE, mutated).changed, []);
});

test('more than 500 individual commercial values are asserted, not a summary count', () => {
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

test('every commercial behaviour-bearing file is owned by the digest, and the set cannot rot', () => {
  for (const file of [
    'packages/core/src/action-runtime.js',
    'packages/app/src/create-app.js',
    'apps/server/src/http-server.js',
    'packages/sdk/src/index.js',
    'apps/admin/public/admin-quotes.js',
    'examples/starters/b2b-lead-qualification/commercial.js',
    'packages/commercial/modules/quote.module.json',
  ]) {
    assert.ok(BEHAVIOUR_BEARING_SOURCE.includes(file), `${file} is not owned by the source digest`);
  }
  assert.deepEqual(unownedCommercialSource(repoRoot), []);
});

test('the commercial wiring seam owns every path that knows where Commercial lives', () => {
  const dir = join(repoRoot, 'tests/characterization');
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('commercial-')) continue;
    if (file === 'commercial-harness.mjs' || file === 'commercial-characterization.test.js') continue;
    if (!/\.(mjs|js)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(source, /['"][^'"]*(commercial-(actions|registry|money)|catalog-sync)\.js[^'"]*['"]/,
      `${file} reaches a Commercial internal directly; it belongs in the harness`);
    assert.doesNotMatch(source, /['"][^'"]*commercial\/generated[^'"]*['"]/, file);
  }
  // The seam's own claims about where the domain lives, asserted so the
  // extraction has to update them deliberately.
  assert.match(COMMERCIAL_SOURCE.money, /commercial-money\.js$|commercial\/src\/money\.js$/);
  assert.match(COMMERCIAL_SOURCE.actions, /commercial-actions\.js$|commercial\/src\/actions\.js$/);
  assert.ok(COMMERCIAL_SOURCE.greps.length >= 4);
});

test('a money value is asserted as an exact amount, never a summary', () => {
  // The one property a commercial characterization cannot lose: amounts are
  // frozen by value. Spot-check that the grouped totals observation carries
  // integer cents rather than booleans.
  const totals = BASELINE.observations.find((entry) => entry.id === 'quote.grouped-totals');
  assert.equal(totals.classification, 'contractual');
  assert.ok(Number.isSafeInteger(totals.observed.oneTimeTotal.netAmountCents));
  assert.ok(totals.observed.oneTimeTotal.netAmountCents > 0);
  assert.ok(totals.observed.recurringTotals.length > 0);
  for (const group of totals.observed.recurringTotals) {
    assert.ok(Number.isSafeInteger(group.netAmountCents));
  }
  assert.equal(totals.observed.hasGrandTotal, false);
});

test('commercial architecture facts are evidence, not a contract the extraction must preserve', () => {
  const evidence = BASELINE.observations.filter((entry) => entry.classification === 'pre_extraction_evidence');
  assert.deepEqual(evidence.map((entry) => entry.id).sort(), [
    'architecture.app-commercial-consumers',
    'architecture.app-commercial-field-present',
    'architecture.app-inspect-commercial-shape',
    'architecture.catalog-route-in-kernel-server',
    'architecture.catalog-sync-ownership',
    'architecture.commercial-internal-importers',
    'architecture.definition-registry-slot',
    'architecture.schema-commercial-block-present',
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

// ---------------------------------------------------------------------------
// mutation sensitivity — a characterization suite that cannot fail is decoration
// ---------------------------------------------------------------------------

function mutate(id, change) {
  return fresh.observations.map((entry) => (entry.id === id
    ? { ...entry, observed: change(entry.observed) } : entry));
}

test('LA0-Commercial fails when a stored amount moves by one cent', () => {
  const comparison = compareToBaseline(BASELINE, mutate('quote.grouped-totals', (observed) => ({
    ...observed,
    oneTimeTotal: { ...observed.oneTimeTotal, netAmountCents: observed.oneTimeTotal.netAmountCents + 1 },
  })));
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.changed.map((entry) => entry.id), ['quote.grouped-totals']);
});

test('LA0-Commercial fails when a policy keeps its decision but changes its fingerprint', () => {
  const target = BASELINE.observations.find((entry) => entry.id.startsWith('architecture.fingerprint.discountPolicies.'));
  assert.ok(target, 'a discount-policy fingerprint must be frozen');
  const comparison = compareToBaseline(BASELINE, mutate(target.id, () => 'f'.repeat(64)));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when a catalog provider fingerprint changes', () => {
  const target = BASELINE.observations.find((entry) => entry.id.startsWith('architecture.fingerprint.catalogProviders.'));
  const comparison = compareToBaseline(BASELINE, mutate(target.id, () => 'a'.repeat(64)));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when a tier boundary or tier price moves', () => {
  const comparison = compareToBaseline(BASELINE, mutate('pricing.component-amount-table', (observed) => ({
    ...observed,
    'volume-q21': { ...observed['volume-q21'], listAmountCents: observed['volume-q21'].listAmountCents + 100 },
  })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when discount rounding starts rounding up', () => {
  const comparison = compareToBaseline(BASELINE, mutate('pricing.discount-rounding-table', (observed) => ({
    ...observed,
    '999@5000': { ...observed['999@5000'], discountAmountCents: 500 },
  })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when frozen version evidence is rewritten by catalog movement', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('versions.frozen-across-catalog-change', (observed) => ({ ...observed, byteIdentical: false })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when the human approval boundary is relaxed', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('approval.agent-actor-refused', () => ({ refused: false, status: null, code: null })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when a provider failure stops rolling back', () => {
  const comparison = compareToBaseline(BASELINE,
    mutate('catalog.provider-failures-leave-no-partial-state', (observed) => ({ ...observed, offerCountUnchanged: false })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when an audit event disappears', () => {
  const comparison = compareToBaseline(BASELINE, mutate('audit.counts-by-action', (observed) => {
    const [first] = Object.keys(observed);
    const { [first]: _dropped, ...rest } = observed;
    return rest;
  }));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when an action contract or module capability changes', () => {
  for (const change of [
    (observed) => ({ ...observed, path: '/api/somewhere/else' }),
    (observed) => ({ ...observed, input: observed.input.slice(1) }),
    (observed) => ({ ...observed, fromStates: [...observed.fromStates, 'approved'] }),
  ]) {
    const comparison = compareToBaseline(BASELINE, mutate('architecture.action-contract.submit', change));
    assert.equal(comparison.ok, false, 'an action contract change must be caught');
  }
  const contract = BASELINE.observations.find((entry) => entry.id === 'architecture.action-contract.submit');
  assert.ok(contract.observed.input.length > 0, 'the action contract case captured no inputs');
  assert.ok(contract.observed.fromStates.length > 0);
  assert.match(contract.observed.path, /^\/api\//);
  const capabilities = compareToBaseline(BASELINE, mutate('architecture.module-capabilities', (observed) => ({
    ...observed, quote: ['create', 'get', 'list'],
  })));
  assert.equal(capabilities.ok, false, 'a module gaining public create must be caught');
});

test('LA0-Commercial fails when >500-scale exact reads truncate', () => {
  const comparison = compareToBaseline(BASELINE, mutate('scale.exact-reads-beyond-page-bounds', (observed) => ({
    ...observed, countWhere: 500,
  })));
  assert.equal(comparison.ok, false);
});

test('LA0-Commercial fails when a case silently stops running or is reclassified', () => {
  const removed = compareToBaseline(BASELINE, fresh.observations.filter((entry) => entry.id !== 'quote.grouped-totals'));
  assert.equal(removed.ok, false);
  assert.deepEqual(removed.missing, ['quote.grouped-totals']);
  const reclassified = fresh.observations.map((entry) => (entry.id === 'quote.grouped-totals'
    ? { ...entry, classification: 'incidental' } : entry));
  const comparison = compareToBaseline(BASELINE, reclassified);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.reclassified, [{ id: 'quote.grouped-totals', from: 'contractual', to: 'incidental' }]);
});

test('the commercial baseline file is byte-reproducible, so its diff is the change', () => {
  const serialize = (value) => `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
  assert.equal(serialize(fresh), readFileSync(join(repoRoot, 'tests/characterization/commercial-baseline.json'), 'utf8'));
});

test('the commercial comparison is order-independent and key-order-independent', () => {
  const shuffled = [...fresh.observations].reverse();
  assert.equal(compareToBaseline(BASELINE, shuffled).ok, true);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});
