import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFICATIONS, CONTINUITIES, NOT_MODELED, classifyDelta, createSuccessorActivationCapability,
  deriveDelta, groupBaseline, lineKey, termContinuity,
} from '../packages/contracts/src/succession.js';
import { createContractsDomain } from '../packages/contracts/src/index.js';
import {
  AMENDMENT_LIMITATIONS, AMENDMENT_STATES, AMENDMENT_TERMINAL, AMENDMENT_TRANSITIONS,
  amendmentRunKey, executionRefOf, readinessFrom,
} from '../packages/lifecycle/src/amendment.js';
import { createLifecyclePackage } from '../packages/lifecycle/src/index.js';

/**
 * M16b's arithmetic, its vocabulary and its refusal surface, held at the level
 * where a mistake is cheap to find.
 *
 * The damage a renewal package can do is not a crash. It is a confident label
 * on a change nobody classified, or the word "signed" attached to a date that
 * was typed in after the signature. These tests exist to make both impossible
 * to introduce quietly.
 */

const line = (over = {}) => ({
  offerLogicalKey: 'offer:a', componentKey: 'seats', label: 'Seats',
  quantity: 10, netAmountCents: 100_000, currency: 'EUR',
  chargeType: 'recurring', interval: 'month', intervalCount: 1, ...over,
});
const component = (over = {}) => ({
  line: { offerLogicalKey: over.offerLogicalKey ?? 'offer:a', sku: over.sku ?? null },
  component: {
    componentKey: over.componentKey ?? 'seats', label: over.label ?? 'Seats',
    quantity: over.quantity ?? 10, netAmountCents: over.netAmountCents ?? 100_000,
    chargeType: over.chargeType ?? 'recurring', interval: over.interval ?? 'month',
    intervalCount: over.intervalCount ?? 1,
  },
});

function refuses(fn, pattern) {
  try {
    fn();
  } catch (error) {
    assert.match(String(error.message), pattern);
    return error;
  }
  assert.fail('expected a refusal');
}

/* ------------------------------------------------------------ the delta */

test('a line keeps its identity across a catalogue revision, and a rename does not split it', () => {
  assert.equal(lineKey({ offerLogicalKey: 'offer:a' }, { componentKey: 'seats' }), 'offer:a|seats');
  // The offer id is deliberately NOT in the key: an offer revision mints a new
  // id, and keying on it would read every renewal as a total replacement.
  assert.equal(lineKey({ offerLogicalKey: 'offer:a', offerId: 'rev-2' }, { componentKey: 'seats' }), 'offer:a|seats');
  // A label change does not move the key either — a renamed product would
  // otherwise turn a plain renewal into one removal and one addition.
  const delta = deriveDelta([line({ label: 'Seats' })], [component({ label: 'User seats' })], 'EUR');
  assert.deepEqual(delta.counts, { added: 0, removed: 0, changed: 0, unchanged: 1 });
  // The fallback for an offer that carried no logical key.
  assert.equal(lineKey({ offerLogicalKey: null, sku: 'SKU-1' }, { componentKey: 'seats' }), 'SKU-1|seats');
});

test('the delta names exactly what moved, field by field', () => {
  const delta = deriveDelta(
    [line(), line({ componentKey: 'support', quantity: 1, netAmountCents: 50_000 })],
    [component({ quantity: 20, netAmountCents: 190_000 }), component({ componentKey: 'api', quantity: 5, netAmountCents: 9_000 })],
    'EUR',
  );
  assert.deepEqual(delta.counts, { added: 1, removed: 1, changed: 1, unchanged: 0 });
  const changed = delta.lines.find((entry) => entry.key === 'offer:a|seats');
  assert.deepEqual(changed.changedFields, ['quantity', 'netAmountCents']);
  assert.equal(changed.before.quantity, 10);
  assert.equal(changed.after.quantity, 20);
  assert.equal(delta.lines.find((entry) => entry.key === 'offer:a|support').status, 'removed');
  assert.equal(delta.lines.find((entry) => entry.key === 'offer:a|api').status, 'added');
});

test('a baseline is grouped by currency and the FULL recurrence, and never summed', () => {
  const groups = groupBaseline([
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1, netAmountCents: 100 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 3, netAmountCents: 400 },
    { currency: 'EUR', chargeType: 'one_time', interval: null, intervalCount: null, netAmountCents: 900 },
  ]);
  assert.equal(groups.length, 3, 'quarterly is month x 3 and is not monthly');
  assert.equal(groups.reduce((total, group) => total + group.netAmountCents, 0), 1400,
    'the numbers are all there — they are simply never added up FOR the caller');
  const delta = deriveDelta([line()], [component({ quantity: 20, netAmountCents: 190_000 })], 'EUR');
  assert.equal(delta.baselineDelta.length, 1);
  assert.equal(delta.baselineDelta[0].netAmountCentsDelta, 90_000);
  assert.match(delta.baselineNote, /no FX exists here/);
  assert.match(delta.baselineNote, /No MRR, ARR or TCV/);
});

/* --------------------------------------------------------- classification */

test('the classification vocabulary is closed, and the narrow labels are claimed only on one reading', () => {
  assert.deepEqual([...CLASSIFICATIONS], ['renewal', 'expansion', 'contraction', 'mixed', 'commercial_change']);

  const identical = deriveDelta([line()], [component()], 'EUR');
  assert.equal(classifyDelta(identical).classification, 'renewal');

  const up = deriveDelta([line()], [component({ quantity: 20, netAmountCents: 190_000 })], 'EUR');
  assert.equal(classifyDelta(up).classification, 'expansion');

  const down = deriveDelta([line()], [component({ quantity: 5, netAmountCents: 50_000 })], 'EUR');
  assert.equal(classifyDelta(down).classification, 'contraction');

  const both = deriveDelta(
    [line(), line({ componentKey: 'api', quantity: 8, netAmountCents: 8_000 })],
    [component({ quantity: 20, netAmountCents: 190_000 }), component({ componentKey: 'api', quantity: 2, netAmountCents: 2_000 })],
    'EUR',
  );
  assert.equal(classifyDelta(both).classification, 'mixed');
});

test('a price movement with no quantity movement is never called an expansion', () => {
  const uplift = deriveDelta([line()], [component({ netAmountCents: 120_000 })], 'EUR');
  const derived = classifyDelta(uplift);
  assert.equal(derived.classification, 'commercial_change');
  assert.match(derived.basis, /without changing quantity/);
  // The exact delta is still there: an unclaimable label loses no evidence.
  assert.equal(uplift.lines[0].before.netAmountCents, 100_000);
  assert.equal(uplift.lines[0].after.netAmountCents, 120_000);
});

test('a change that cannot be compared is commercial_change, never a guess', () => {
  // A different currency: the two amounts are not comparable and there is no FX.
  const currency = deriveDelta([line()], [component()], 'USD');
  assert.equal(classifyDelta(currency).classification, 'commercial_change');

  // A different recurrence: monthly and quarterly amounts are different money.
  const recurrence = deriveDelta([line()], [component({ intervalCount: 3 })], 'EUR');
  assert.equal(classifyDelta(recurrence).classification, 'commercial_change');
  assert.match(classifyDelta(recurrence).basis, /currency, charge type or recurrence/);

  // A key that appears twice on one side cannot be matched at all.
  const ambiguous = deriveDelta([line(), line({ netAmountCents: 1 })], [component()], 'EUR');
  assert.deepEqual(ambiguous.ambiguousKeys, ['offer:a|seats']);
  assert.equal(classifyDelta(ambiguous).classification, 'commercial_change');
  assert.match(classifyDelta(ambiguous).basis, /more than once/);
});

/* ----------------------------------------------------------- continuity */

test('term continuity is measured against an INCLUSIVE end date, and only one relation blocks', () => {
  assert.deepEqual([...CONTINUITIES], ['contiguous', 'gap', 'overlap', 'unknown']);
  const source = { startDate: '2026-09-01', endDate: '2027-08-31' };

  const next = termContinuity(source, { termStartDate: '2027-09-01', termEndDate: '2028-08-31' });
  assert.equal(next.relation, 'contiguous');
  assert.equal(next.gapDays, 0, 'the day after an inclusive end is zero days later, not one');

  const lapse = termContinuity(source, { termStartDate: '2027-10-01', termEndDate: '2028-09-30' });
  assert.equal(lapse.relation, 'gap');
  assert.equal(lapse.gapDays, 30);
  assert.match(lapse.note, /Recorded, not refused/);

  const midTerm = termContinuity(source, { termStartDate: '2027-03-01', termEndDate: '2028-02-29' });
  assert.equal(midTerm.relation, 'overlap');
  assert.equal(midTerm.gapDays, -184);
  assert.match(midTerm.note, /mid-term amendment overlaps/);

  assert.equal(termContinuity({ startDate: null, endDate: null }, { termStartDate: '2027-09-01' }).relation, 'unknown');
  assert.equal(termContinuity(source, { termStartDate: '2027-02-30' }).relation, 'unknown',
    'a date that names no real day yields "cannot say", never a number measured from March 2');
});

/* ------------------------------------------------------- the state table */

test('the run state machine is a table, terminal rows are empty, and no row has a clock input', () => {
  assert.deepEqual([...AMENDMENT_STATES], ['planned', 'awaiting_signed_order', 'ready', 'executed', 'abandoned']);
  assert.deepEqual([...AMENDMENT_TERMINAL], ['executed', 'abandoned']);
  for (const state of AMENDMENT_STATES) {
    assert.ok(Object.hasOwn(AMENDMENT_TRANSITIONS, state), `${state} must have a row`);
    for (const target of AMENDMENT_TRANSITIONS[state]) {
      assert.ok(AMENDMENT_STATES.includes(target), `${state} → ${target} names a state that exists`);
    }
  }
  for (const terminal of AMENDMENT_TERMINAL) {
    assert.deepEqual(AMENDMENT_TRANSITIONS[terminal], [], `${terminal} never regresses`);
  }
  // Every non-terminal state can reach a terminal one: no dead ends.
  for (const state of AMENDMENT_STATES.filter((entry) => !AMENDMENT_TERMINAL.includes(entry))) {
    assert.ok(AMENDMENT_TRANSITIONS[state].some((target) => AMENDMENT_TERMINAL.includes(target)),
      `${state} must have an exit`);
  }
  // `executed` is reachable from exactly one state, and it is the one whose
  // readiness the execution re-proves.
  const toExecuted = AMENDMENT_STATES.filter((state) => AMENDMENT_TRANSITIONS[state].includes('executed'));
  assert.deepEqual(toExecuted, ['ready']);
});

test('readiness distinguishes a wait from a wrong pairing, using the provider\'s own flag', () => {
  assert.deepEqual(readinessFrom({ coherent: true, refusals: [] }), { state: 'ready', gaps: [], blocking: [] });

  const maturing = readinessFrom({
    coherent: false,
    refusals: [{ code: 'SUCCESSOR_TERMS_NOT_SIGNED', message: 'not yet', resolvableByMaturity: true }],
  });
  assert.equal(maturing.state, 'awaiting_signed_order');
  assert.deepEqual(maturing.blocking, [], 'waiting can still fix this');

  const wrong = readinessFrom({
    coherent: false,
    refusals: [{ code: 'SUCCESSOR_CUSTOMER_MISMATCH', message: 'another customer', resolvableByMaturity: false }],
  });
  assert.equal(wrong.blocking.length, 1, 'waiting will never fix this, and the run must not promise it might');
});

test('identities carry no clock, and one run can never produce two successors', () => {
  assert.equal(amendmentRunKey('c1', 3), 'amendment-run:c1:3');
  assert.equal(executionRefOf('r1'), 'amendment-run:r1');
  for (const key of [amendmentRunKey('c1', 1), executionRefOf('r1')]) {
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(key), false, 'a key that moves every millisecond identifies nothing');
  }
});

/* ------------------------------------------------------- the declarations */

test('the capability refuses a caller that brings no modules view, and one that never applied the lineage record', () => {
  const capability = createSuccessorActivationCapability();
  assert.equal(capability.name, 'contracts-successor-activation');
  assert.equal(capability.version, 1);
  refuses(() => capability.create({}), /requires the caller's modules view/);
  refuses(
    () => capability.create({ modules: { get: () => ({ service: { list() { return []; } } }) } }),
    /installed without its "contract-succession" records/,
  );
});

test('the contracts package publishes the succession contract, function-free, without claiming a scheduler', () => {
  const metadata = createContractsDomain().metadata();
  assert.equal(metadata.succession.successionContract, 1);
  assert.deepEqual(metadata.succession.classification.values, [...CLASSIFICATIONS]);
  assert.deepEqual(metadata.succession.termContinuity.values, [...CONTINUITIES]);
  assert.match(metadata.succession.uniqueness, /UNIQUE/);
  assert.match(metadata.succession.uniqueness, /not by an in-process lock/);
  assert.match(metadata.succession.signedTermRequired, /SUCCESSOR_TERMS_NOT_SIGNED/);
  assert.match(metadata.succession.classification.derivation, /never supplied by a caller/);
  for (const absent of ['billing', 'scheduler', 'automatic renewal', 'customer notification', 'MRR/ARR/TCV']) {
    assert.ok(metadata.succession.notModeled.includes(absent), `${absent} must be declared absent`);
  }
  assert.deepEqual([...NOT_MODELED].sort(), [...metadata.succession.notModeled].sort());
  // Published on /api/schema, so it must survive a JSON round trip untouched.
  assert.equal(JSON.stringify(metadata), JSON.stringify(JSON.parse(JSON.stringify(metadata))));
});

test('the lifecycle package publishes the run contract and still refuses the words it cannot honour', () => {
  const metadata = createLifecyclePackage().metadata();
  assert.equal(metadata.amendment.amendmentContract, 1);
  assert.equal(metadata.amendment.capability, 'contracts-successor-activation@1');
  assert.deepEqual(metadata.amendment.states, [...AMENDMENT_STATES]);
  assert.deepEqual(metadata.amendment.transitions, AMENDMENT_TRANSITIONS);
  assert.match(metadata.amendment.authority, /never an authorisation/);
  assert.match(metadata.amendment.rounds, /succeeded exactly once/);
  assert.deepEqual(metadata.amendment.limitations, [...AMENDMENT_LIMITATIONS]);
  // Executing a successor is still not "renewing" or "amending" anything: those
  // words claim a legal effect this framework does not produce.
  for (const forbidden of ['renewed', 'amended', 'cancelled', 'churned', 'invoiced', 'signed']) {
    assert.ok(metadata.wording.neverClaimed.includes(forbidden));
  }
  assert.ok(metadata.wording.recorded.includes('successor agreement executed'));
  assert.equal(JSON.stringify(metadata), JSON.stringify(JSON.parse(JSON.stringify(metadata))));
});

test('every limitation this milestone repeats is one of the hard boundaries it was given', () => {
  const text = AMENDMENT_LIMITATIONS.join(' ');
  for (const boundary of ['NO_SCHEDULER', 'NO_AUTOMATIC_RENEWAL', 'NO_CUSTOMER_NOTIFICATION',
    'NO_BILLING', 'NO_RBAC', 'NO_RETROACTIVE_MUTATION', 'NO_CANCELLATION', 'SIGNED_TERM_REQUIRED']) {
    assert.ok(text.includes(boundary), `${boundary} must be stated verbatim`);
  }
});

test('the two new records are evidence: every field is managed, and neither describes itself with a word it cannot honour', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const [path, name] of [
    [`${root}packages/contracts/modules/contract-succession.module.json`, 'contract-succession'],
    [`${root}packages/lifecycle/modules/amendment-run.module.json`, 'amendment-run'],
  ]) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(manifest.name, name);
    for (const field of manifest.fields) {
      assert.equal(field.writable, 'managed',
        `${name}.${field.name} must be managed: evidence a client could edit is not evidence`);
    }
    assert.equal(/\b(renewed|cancelled|churned|invoiced)\b/.test(manifest.description), false,
      `${name} must not describe itself with a word it cannot honour`);
  }
  // The uniqueness that makes "one execution per source" a schema fact.
  const succession = JSON.parse(readFileSync(`${root}packages/contracts/modules/contract-succession.module.json`, 'utf8'));
  for (const unique of ['sourceContractId', 'successorContractId', 'successorOrderId', 'executionRef']) {
    assert.equal(succession.fields.find((field) => field.name === unique)?.unique, true,
      `${unique} must be UNIQUE — an in-process lock is not a guarantee`);
  }
  const run = JSON.parse(readFileSync(`${root}packages/lifecycle/modules/amendment-run.module.json`, 'utf8'));
  assert.equal(run.fields.find((field) => field.name === 'sourceKey').unique, true);
  assert.deepEqual(run.fields.find((field) => field.name === 'state').values, [...AMENDMENT_STATES]);
});

test('the successor activation capability is the only writing capability contracts offers, and it is declared', () => {
  const pkg = createContractsDomain();
  const writing = pkg.capabilities.filter((entry) => entry.name === 'contracts-successor-activation');
  assert.equal(writing.length, 1);
  assert.match(writing[0].description, /Grants no storage handle/);
  // Lifecycle declares it, and the declaration is what the registry enforces.
  const lifecycle = createLifecyclePackage();
  assert.ok(lifecycle.requires.some((entry) => entry.package === 'contracts'
    && entry.capability === 'contracts-successor-activation' && entry.version === 1));
  assert.deepEqual(lifecycle.capabilities, [], 'lifecycle offers nothing; it orchestrates');
});
