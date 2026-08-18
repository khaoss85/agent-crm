import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSERTED, CLASSIFICATIONS, LEGACY_CHARACTERIZATION_CONTRACT, canonical, compareToBaseline, sortKeysDeep,
} from './characterization-contract.mjs';
import {
  ATTACHMENT, BEHAVIOUR_BEARING_SOURCE, SIGNATURE_SOURCE, buildSignatureBaseline,
  sigObservation, unownedSignatureSource,
} from './signature-harness.mjs';
import { generateBaseline, sourceFingerprints } from './run-signature-characterization.mjs';

/**
 * LA0 for Signature & Order — the characterization gate.
 *
 * This suite freezes what Signature & Order *externally does* today, so a
 * future extraction can be proved to change none of it. It moves no code,
 * changes no architecture, moves no route and adds no seam.
 *
 * Only `contractual` and `compatibility_required` observations are compared;
 * `incidental` is recorded without being asserted, `defect_candidate` is
 * reproduced without being frozen, and `pre_extraction_evidence` records the
 * wiring the extraction exists to change.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(repoRoot, 'tests/characterization/signature-baseline.json'), 'utf8'));

/** Generated once: booting real projects for every test would prove nothing new. */
let fresh;
test.before(async (t) => { fresh = await generateBaseline(t); }, { timeout: 900_000 });

test('the checked-in signature baseline is a valid contract document', () => {
  assert.equal(BASELINE.legacyCharacterizationContract, LEGACY_CHARACTERIZATION_CONTRACT);
  assert.equal(BASELINE.domain, 'signature-order');
  assert.equal(BASELINE.attachment, ATTACHMENT);
  assert.ok(BASELINE.observations.length > 80, 'a thin baseline proves thin things');

  for (const entry of BASELINE.observations) {
    assert.ok(CLASSIFICATIONS.includes(entry.classification), `${entry.id}: ${entry.classification}`);
    if (entry.classification === 'defect_candidate') {
      assert.ok(entry.note, `${entry.id}: a defect candidate without an explanation is not a finding`);
    }
  }
  // No absolute path, no secret material, no wall clock. The fixture HMAC key
  // is deliberately allowed: it is test-only, checked into source, and labelled.
  const text = JSON.stringify(BASELINE);
  assert.doesNotMatch(text, /\/home\/|\/Users\/|C:\\\\|\/tmp\//, 'no absolute path');
  assert.doesNotMatch(text, /-----BEGIN|password/i, 'no credential-shaped text');
  assert.ok(text.length < 2_000_000, 'a baseline nobody can read is a baseline nobody reviews');
});

test('the current Signature & Order behaviour matches the frozen baseline', () => {
  const comparison = compareToBaseline(BASELINE, fresh.observations);
  assert.deepEqual(comparison.changed, [], 'an asserted value moved: that is a behaviour change, not a baseline update');
  assert.deepEqual(comparison.missing, [], 'a case stopped running, which would hide a behaviour change');
  assert.deepEqual(comparison.added, [], 'the suite grew; regenerate the baseline deliberately');
  assert.deepEqual(comparison.reclassified, [], 'an observation changed classification without review');
  assert.equal(fresh.fingerprint, BASELINE.fingerprint);
});

test('the baseline is stale when behaviour-bearing source changes', () => {
  assert.deepEqual(sourceFingerprints(repoRoot), BASELINE.source,
    'a source file that decides Signature & Order behaviour changed — regenerate the baseline deliberately '
    + 'with `node scripts/characterize-signature.mjs` and review the diff');
  for (const [file, digest] of Object.entries(BASELINE.source)) {
    assert.notEqual(digest, 'absent', `${file} is recorded as absent; the baseline was generated against a different tree`);
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test('generation is separate from verification, and never runs during verify', () => {
  const script = readFileSync(join(repoRoot, 'scripts/characterize-signature.mjs'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.doesNotMatch(String(manifest.scripts.verify), /characterize/);
  assert.match(script, /signature-baseline\.json/);
  // The npm alias arrives with the extraction, not with the characterization
  // branch; until then the runner is invoked directly.
  assert.equal(existsSync(join(repoRoot, 'scripts/characterize-signature.mjs')), true);
});

test('incidental observations are recorded and never asserted', () => {
  const incidental = BASELINE.observations.filter((entry) => entry.classification === 'incidental');
  assert.ok(incidental.length > 0, 'nothing is purely incidental? that is a classification nobody used honestly');
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'incidental'
    ? { ...entry, observed: ['completely', 'different', 'order'] } : entry));
  const rebuilt = buildSignatureBaseline({ source: BASELINE.source, observations: mutated });
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
  // The one found today, so a reader of the diff knows what it is: signer
  // name/role accept control characters, and a NUL byte is silently mutated
  // in storage — on data that enters the signed document package.
  assert.deepEqual(defects.map((entry) => entry.id).sort(), [
    'hostile-input.signer-newline-and-null-byte',
  ]);
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'defect_candidate'
    ? { ...entry, observed: { refused: true, status: 400 } } : entry));
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

test('every behaviour-bearing file is owned by the digest, and the set cannot rot', () => {
  for (const file of [
    'packages/core/src/signature-operations.js',
    'packages/core/src/signature-registry.js',
    'packages/core/src/external-operation.js',
    'packages/core/src/action-runtime.js',
    'packages/commercial/src/actions.js',
    'apps/server/src/http-server.js',
    'packages/app/src/create-app.js',
    'examples/starters/b2b-lead-qualification/signature.js',
  ]) {
    assert.ok(BEHAVIOUR_BEARING_SOURCE.includes(file), `${file} is not owned by the source digest`);
  }
  assert.deepEqual(unownedSignatureSource(repoRoot), []);
});

test('the wiring seam owns every path that knows where Signature lives', () => {
  // Everything under signature-* except the harness (which owns the paths)
  // and this test (which asserts ABOUT them) reaches the internals only
  // through the seam, so an extraction edits one file.
  for (const file of ['signature-cases.mjs', 'run-signature-characterization.mjs']) {
    const source = readFileSync(join(repoRoot, 'tests/characterization', file), 'utf8');
    assert.doesNotMatch(source, /['"][^'"]*core\/src\/signature-(operations|registry)[^'"]*['"]/,
      `${file} reaches a Signature internal directly; it belongs in the harness`);
    assert.doesNotMatch(source, /['"][^'"]*core\/src\/external-operation[^'"]*['"]/, file);
  }
  assert.match(SIGNATURE_SOURCE.operations, /signature-operations\.js$/);
  assert.match(SIGNATURE_SOURCE.registry, /signature-registry\.js$/);
  // Today the domain still lives in the kernel — this flips at extraction.
  assert.equal(existsSync(join(repoRoot, 'packages/core/src/signature-operations.js')), true);
});

test('an observation with an unknown category, classification or surface is refused', () => {
  const valid = { id: 'x', category: 'webhook', classification: 'contractual', surface: 'http', observed: 1 };
  assert.throws(() => sigObservation({ ...valid, category: 'vibes' }), /unknown category/);
  assert.throws(() => sigObservation({ ...valid, classification: 'probably-fine' }), /unknown classification/);
  assert.throws(() => sigObservation({ ...valid, surface: 'telepathy' }), /unknown surface/);
  assert.throws(() => sigObservation({ ...valid, classification: 'defect_candidate' }), /the note IS the finding/);
  for (const empty of [[], {}, null, undefined, '']) {
    assert.throws(() => sigObservation({ ...valid, observed: empty }), /observed nothing/);
  }
  assert.doesNotThrow(() => sigObservation({ ...valid, observed: [], allowEmpty: true, note: 'emptiness is the finding here' }));
});

// ---------------------------------------------------------------------------
// mutation sensitivity — a characterization suite that cannot fail is decoration
// ---------------------------------------------------------------------------

function mutate(id, change) {
  return fresh.observations.map((entry) => (entry.id === id ? { ...entry, observed: change(entry.observed) } : entry));
}

test('the gate fails when a state-machine cell flips', () => {
  const comparison = compareToBaseline(BASELINE, mutate('envelope-lifecycle.transition-matrix',
    (observed) => ({ ...observed, completed: { ...observed.completed, declined: true } })));
  assert.equal(comparison.ok, false, 'a terminal state regressing must be caught');
  assert.deepEqual(comparison.changed.map((entry) => entry.id), ['envelope-lifecycle.transition-matrix']);
});

test('the gate fails when the canonical document hash moves', () => {
  const comparison = compareToBaseline(BASELINE, mutate('document.canonical-hash-properties',
    (observed) => ({ ...observed, fixedDocumentHash: 'f'.repeat(64) })));
  assert.equal(comparison.ok, false);
});

test('the gate fails when a provider fingerprint changes', () => {
  const target = BASELINE.observations.find((entry) => entry.id.startsWith('schema-metadata.provider-fingerprint.'));
  assert.ok(target, 'the fixture provider fingerprint must be frozen');
  const comparison = compareToBaseline(BASELINE, mutate(target.id, (observed) => ({ ...observed, fingerprint: 'a'.repeat(64) })));
  assert.equal(comparison.ok, false);
});

test('the gate fails when replay stops being free of side effects', () => {
  const comparison = compareToBaseline(BASELINE, mutate('audit-events-trace.replay-creates-nothing',
    (observed) => ({ ...observed, auditDelta: { ...observed.auditDelta, order: 1 }, orders: 2 })));
  assert.equal(comparison.ok, false, 'a replay that creates a second order must be caught');
});

test('the gate fails when an amount on the order snapshot moves', () => {
  const comparison = compareToBaseline(BASELINE, mutate('completion-order.order-lines',
    (observed) => observed.map((line) => ({ ...line, netAmountCents: (line.netAmountCents ?? 0) + 1 }))));
  assert.equal(comparison.ok, false, 'a stored amount disagreeing is the Commercial-adjacent regression shape');
});

test('the gate fails when the human-actor boundary is relaxed', () => {
  const comparison = compareToBaseline(BASELINE, mutate('envelope-lifecycle.agent-actor-refused',
    () => ({ refused: false, code: null, status: null })));
  assert.equal(comparison.ok, false);
});

test('the gate fails when crash recovery stops producing exactly one envelope', () => {
  const comparison = compareToBaseline(BASELINE, mutate('races-restart.kill-between-phases-recovery',
    (observed) => ({ ...observed, envelopesForVersion: 2 })));
  assert.equal(comparison.ok, false, 'a second provider envelope is the regression this domain exists to prevent');
});

test('the gate fails when the webhook verification outcome table moves', () => {
  const comparison = compareToBaseline(BASELINE, mutate('webhook.hmac-verification-outcomes',
    (observed) => ({ ...observed, at301Early: { ok: true, reason: null } })));
  assert.equal(comparison.ok, false, 'the replay window widening must be caught');
});

test('the gate fails when a case silently stops running', () => {
  const survivors = fresh.observations.filter((entry) => entry.id !== 'completion-order.order-record');
  const comparison = compareToBaseline(BASELINE, survivors);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, ['completion-order.order-record']);
});

test('the gate fails when an observation is quietly reclassified', () => {
  const mutated = fresh.observations.map((entry) => (entry.id === 'completion-order.order-record'
    ? { ...entry, classification: 'incidental' } : entry));
  const comparison = compareToBaseline(BASELINE, mutated);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.reclassified, [{ id: 'completion-order.order-record', from: 'contractual', to: 'incidental' }]);
});

test('pre-extraction evidence is recorded, never a contract the extraction must preserve', () => {
  const evidence = BASELINE.observations.filter((entry) => entry.classification === 'pre_extraction_evidence');
  assert.ok(evidence.length >= 5, 'the wiring evidence must exist');
  for (const id of [
    'architecture.b7-route-ownership',
    'architecture.signature-internal-importers',
    'architecture.external-operation-importers',
    'architecture.kernel-public-api-signature-surface',
    'architecture.signature-generated-slot-dependants',
  ]) {
    assert.ok(evidence.some((entry) => entry.id === id), `${id} must be recorded`);
  }
  const mutated = BASELINE.observations.map((entry) => (entry.classification === 'pre_extraction_evidence'
    ? { ...entry, observed: { moved: true } } : entry));
  assert.deepEqual(compareToBaseline(BASELINE, mutated).changed, [],
    'the extraction must be free to change the wiring these record');
});

test('the baseline file is byte-reproducible, so its diff is the change', () => {
  const serialize = (value) => `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
  assert.equal(serialize(fresh), readFileSync(join(repoRoot, 'tests/characterization/signature-baseline.json'), 'utf8'));
});

test('the comparison is order-independent and key-order-independent', () => {
  const shuffled = [...fresh.observations].reverse();
  assert.equal(compareToBaseline(BASELINE, shuffled).ok, true);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});
