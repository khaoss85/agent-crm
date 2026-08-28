import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DECISIONS, FOLLOWUP_OPEN, FOLLOWUP_TERMINAL, INTENTS, LIFECYCLE_RESOURCES,
  SOURCE_CAPABILITY, createLifecyclePackage, daysToBoundary, evidenceGaps,
  groupBaseline, replayOrConflict, requireCalendarDate, requireReason, serializeBaselineGroups,
} from '../packages/lifecycle/src/index.js';
import {
  createContractLifecycleSourceCapability, declaredTermSources, LIFECYCLE_SOURCE,
  TERM_SOURCE_SIGNED, termIsSigned, termSignedState,
} from '../packages/contracts/src/lifecycle-capability.js';

/**
 * The `termsSource` values the contract manifest actually declares, read from
 * the manifest itself.
 *
 * These tests used to feed the capability `termsSource: 'order-form'` — a value
 * the manifest has never allowed — and then assert `signed === false`. That
 * assertion passed for the wrong reason: it pinned the old hard-coded literal
 * rather than the rule, so it would have gone on passing on the day a genuinely
 * signed source was added. Everything below derives from the manifest instead.
 */
const CONTRACT_MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL('../packages/contracts/modules/commercial-contract.module.json', import.meta.url)), 'utf8'),
);
const DECLARED_TERM_SOURCES = CONTRACT_MANIFEST.fields.find((field) => field.name === 'termsSource').values;

/** A contract module double that carries the manifest's own field contract. */
const contractModuleDouble = (service, values = DECLARED_TERM_SOURCES) => ({
  service,
  fields: [{ name: 'termsSource', type: 'enum', values: [...values] }],
});

/**
 * M16a is mostly about **what it refuses to say**. A renewal decision is intent
 * evidence, a term is term evidence with provenance attached, and neither is a
 * renewal. These tests hold the wording and the arithmetic to that, because the
 * damage a lifecycle package can do is not a crash — it is a confident sentence
 * about money or a contract that nobody actually agreed to.
 */

test('the package declares only what it owns, and reaches Contracts only by capability', () => {
  const pkg = createLifecyclePackage();
  assert.equal(pkg.name, 'lifecycle');
  assert.deepEqual([...pkg.resources].sort(), ['amendment-run', 'commercial-followup', 'renewal-decision']);
  // The contract is the project's host record here: acted on, never owned.
  assert.equal(pkg.resources.includes('commercial-contract'), false,
    'the contract belongs to Contracts; claiming it would be a collision and a lie');
  assert.deepEqual(pkg.requires, [
    { package: 'contracts', capability: 'contract-lifecycle-source', version: 2 },
    // M16b: the write path lives in Contracts, and this is the only way here.
    { package: 'contracts', capability: 'contracts-successor-activation', version: 1 },
  ]);
  assert.deepEqual(pkg.capabilities, [], 'this package offers nothing; it consumes');
  assert.deepEqual(pkg.actions.map((a) => `${a.module}.${a.name}`).sort(), [
    'amendment-run.abandon-amendment-run',
    'amendment-run.attach-successor-order',
    'amendment-run.execute-amendment',
    'commercial-contract.open-amendment-run',
    'commercial-contract.plan-amendment',
    'commercial-contract.plan-renewal',
    'commercial-contract.record-renewal-decision',
    'commercial-contract.request-commercial-followup',
    'commercial-followup.resolve-commercial-followup',
  ]);
});

test('the metadata refuses the words that would be lies', () => {
  const meta = createLifecyclePackage().metadata();
  assert.deepEqual(meta.decisions, [...DECISIONS]);
  assert.deepEqual(meta.intents, [...INTENTS]);
  assert.deepEqual(meta.followupStates.terminal, [...FOLLOWUP_TERMINAL]);
  for (const forbidden of ['renewed', 'amended', 'cancelled', 'churned', 'invoiced', 'signed']) {
    assert.ok(meta.wording.neverClaimed.includes(forbidden), `${forbidden} must be listed as never claimed`);
  }
  // 'amendment execution' left this list at M16b, because it stopped being
  // true. Everything that is still absent stays named.
  assert.equal(meta.notModeled.includes('amendment execution'), false,
    'M16b executes amendments, so claiming otherwise would be the lie in the other direction');
  for (const absent of ['billing', 'invoicing', 'revenue recognition', 'ARR/MRR/TCV', 'FX', 'customer notification', 'automatic or legal renewal']) {
    assert.ok(meta.notModeled.includes(absent), `${absent} must be declared not modelled`);
  }
  assert.match(meta.termProvenance, /may never have been signed/);
  assert.match(meta.limitation, /M16b/, 'the deferral is recorded, not silently omitted');
  // The metadata is published on /api/schema, so it must be function-free.
  assert.equal(JSON.stringify(meta), JSON.stringify(JSON.parse(JSON.stringify(meta))));
});

test('term boundaries use inclusive end-date arithmetic, and an ended term is not an opportunity', () => {
  // A term ending on the 31st is live ON the 31st.
  assert.equal(daysToBoundary('2026-12-31', '2026-12-31'), 0);
  assert.equal(daysToBoundary('2026-12-30', '2026-12-31'), 1);
  assert.equal(daysToBoundary('2026-10-02', '2026-12-31'), 90);
  // Already ended is negative, so it can never be graded as "within window".
  assert.equal(daysToBoundary('2027-01-05', '2026-12-31'), -5);
  // Leap day and year boundaries are real dates, not arithmetic on 365.
  assert.equal(daysToBoundary('2028-02-28', '2028-03-01'), 2);
  // A malformed date is null rather than a wrong number.
  assert.equal(daysToBoundary('not-a-date', '2026-12-31'), null);
  assert.equal(daysToBoundary('2026-12-31', '31/12/2026'), null);
});

test('a baseline is grouped by currency and recurrence, never summed into one number', () => {
  const groups = groupBaseline([
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', netAmountCents: 10_000 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', netAmountCents: 5_000 },
    { currency: 'EUR', chargeType: 'one_time', interval: null, netAmountCents: 250_000 },
    { currency: 'USD', chargeType: 'recurring', interval: 'year', netAmountCents: 900_000 },
  ]);
  assert.equal(groups.length, 3, 'three distinct kinds of money stay three numbers');
  const eurMonthly = groups.find((g) => g.currency === 'EUR' && g.interval === 'month');
  assert.equal(eurMonthly.netAmountCents, 15_000);
  assert.equal(eurMonthly.lineCount, 2);
  // Nothing anywhere adds EUR to USD, or a one-time fee to a monthly charge.
  const total = groups.reduce((sum, g) => sum + g.netAmountCents, 0);
  assert.notEqual(groups.length, 1);
  assert.ok(total > 0 && !groups.some((g) => g.netAmountCents === total),
    'no group carries the meaningless grand total');
  // Deterministic order, so two runs produce the same evidence.
  assert.deepEqual(groups.map((g) => `${g.currency}|${g.chargeType}|${g.interval}`),
    ['EUR|one_time|null', 'EUR|recurring|month', 'USD|recurring|year']);
});

test('interval count is part of the recurrence: quarterly is not monthly', () => {
  // Regression. M12 spells quarterly as `interval: month, intervalCount: 3`, so
  // grouping on `interval` alone folded EUR 400 quarterly into the same row as
  // EUR 400 monthly and reported EUR 800 "monthly" — a three-fold overstatement
  // of the baseline Commercial reads, produced silently, with the two follow-up
  // rows byte-identical afterwards.
  const groups = groupBaseline([
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1, netAmountCents: 40_000 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 3, netAmountCents: 40_000 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 3, netAmountCents: 10_000 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'year', intervalCount: 1, netAmountCents: 90_000 },
  ]);
  assert.equal(groups.length, 3, 'monthly, quarterly and annual are three kinds of money');
  const quarterly = groups.find((g) => g.interval === 'month' && g.intervalCount === 3);
  assert.equal(quarterly.netAmountCents, 50_000);
  assert.equal(quarterly.lineCount, 2);
  assert.equal(groups.find((g) => g.interval === 'month' && g.intervalCount === 1).netAmountCents, 40_000);

  // A one-time charge has no recurrence at all, so neither half of the pair is
  // invented for it — an `intervalCount: 1` there would read as "every one of
  // something" and there is no something.
  const [once] = groupBaseline([
    { currency: 'EUR', chargeType: 'one_time', interval: 'month', intervalCount: 1, netAmountCents: 120_000 },
  ]);
  assert.equal(once.interval, null);
  assert.equal(once.intervalCount, null);

  // The defect in one line: an annual EUR 1,200 and a one-time EUR 1,200 are
  // distinguishable in what gets stored, rather than byte-identical rows.
  const annual = serializeBaselineGroups(groupBaseline([
    { currency: 'EUR', chargeType: 'recurring', interval: 'year', intervalCount: 1, netAmountCents: 120_000 },
  ]));
  const oneTime = serializeBaselineGroups(groupBaseline([
    { currency: 'EUR', chargeType: 'one_time', interval: null, intervalCount: null, netAmountCents: 120_000 },
  ]));
  assert.notEqual(annual, oneTime);
  assert.deepEqual(JSON.parse(annual), [{
    currency: 'EUR', chargeType: 'recurring', interval: 'year', intervalCount: 1, lineCount: 1, netAmountCents: 120_000,
  }]);

  // Grouped evidence is stable: the same baseline serializes identically, so a
  // stored row can be compared against a recomputed one.
  const lines = [
    { currency: 'USD', chargeType: 'recurring', interval: 'year', intervalCount: 1, netAmountCents: 1 },
    { currency: 'EUR', chargeType: 'one_time', interval: null, intervalCount: null, netAmountCents: 2 },
  ];
  assert.equal(serializeBaselineGroups(groupBaseline(lines)),
    serializeBaselineGroups(groupBaseline([...lines].reverse())));
  // And nothing anywhere carries a cross-recurrence or cross-currency total.
  assert.equal(JSON.parse(serializeBaselineGroups(groupBaseline(lines))).some((g) => g.netAmountCents === 3), false);
});

test('an identical repeat replays; a different one is refused with the fields named', () => {
  const existing = { id: 'd1', decision: 'pursue_renewal', reason: 'they are happy', contractId: 'c1' };
  const options = { code: 'RENEWAL_DECISION_CONFLICT', what: 'A renewal decision' };

  // The lost-response case: the retry gets back the record it already created.
  assert.equal(replayOrConflict(existing, { decision: 'pursue_renewal', reason: 'they are happy' }, options), existing);
  // Fields the caller did not submit are not compared — a derived field moving
  // elsewhere must not turn a safe retry into a spurious conflict.
  assert.equal(replayOrConflict(existing, {}, options), existing);
  // Absent and null are the same submission, so an omitted optional replays.
  assert.equal(replayOrConflict({ id: 'f1', decisionId: null }, { decisionId: undefined }, options).id, 'f1');

  // A divergent repeat is refused, and says exactly which fields diverged.
  assert.throws(
    () => replayOrConflict(existing, { decision: 'not_renewing', reason: 'they are happy' }, options),
    (error) => error.status === 409 && error.code === 'RENEWAL_DECISION_CONFLICT'
      && error.details.conflictingFields.join() === 'decision'
      && error.details.existingId === 'd1'
      && /different decision/.test(error.message),
  );
  assert.throws(
    () => replayOrConflict(existing, { decision: 'not_renewing', reason: 'changed my mind' }, options),
    (error) => error.details.conflictingFields.join() === 'decision,reason',
  );
});

test('a non-integer amount cannot poison a baseline', () => {
  const groups = groupBaseline([
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', netAmountCents: 1_000 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', netAmountCents: 1.5 },
    { currency: 'EUR', chargeType: 'recurring', interval: 'month', netAmountCents: Number.NaN },
  ]);
  assert.equal(groups[0].netAmountCents, 1_000, 'a fractional or NaN amount contributes nothing rather than corrupting the sum');
  assert.equal(groups[0].lineCount, 3, 'but the line is still counted, so the gap is visible');
});

test('missing evidence is named, not guessed around', () => {
  assert.deepEqual(evidenceGaps({ term: { endDate: null, source: null }, currentVersionId: null }),
    ['NO_CURRENT_CONTRACT_VERSION', 'NO_DECLARED_TERM_SOURCE', 'NO_TERM_END_DATE']);
  assert.deepEqual(evidenceGaps({ term: { endDate: '2026-12-31', source: 'order' }, currentVersionId: 'v1' }), []);
});

test('a human reason is required, bounded and control-character free', () => {
  assert.equal(requireReason('  renewing early  '), 'renewing early');
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => requireReason(bad), /reason is required/);
  }
  assert.throws(() => requireReason('x'.repeat(301)), /at most 300 characters/);
  assert.throws(() => requireReason('two\nlines'), /control characters or line breaks/);
  assert.throws(() => requireReason('null\u0000byte'), /control characters or line breaks/);
  assert.throws(() => requireReason('sep\u2028arator'), /control characters or line breaks/);
  // The field name travels, so a summary refusal says "summary".
  assert.throws(() => requireReason('', 'summary'), /summary is required/);
});

test('the source capability is read-only by construction', () => {
  const capability = createContractLifecycleSourceCapability();
  assert.equal(capability.name, LIFECYCLE_SOURCE.name);
  assert.equal(capability.version, 2);
  assert.equal(SOURCE_CAPABILITY.capability, capability.name);

  // A source the manifest really declares, and whatever the classification rule
  // says about it — never a literal typed into the assertion.
  const declaredSource = DECLARED_TERM_SOURCES[0];
  const rows = new Map([
    ['commercial-contract', { get: (id) => (id === 'c1' ? {
      id: 'c1', status: 'active', currency: 'EUR', customerName: 'Rossi', currentVersionId: 'v1',
      termStartDate: '2026-01-01', termEndDate: '2026-12-31', termDays: 365,
      autoRenew: 1, renewalNoticeDays: 30, termsSource: declaredSource, termsReason: 'as ordered',
    } : null) }],
    ['contract-version', { get: () => ({ versionNumber: 2 }) }],
    ['contract-line', { listWhere: () => [] }],
    ['subscription', { listWhere: () => [] }],
    ['subscription-line', { listWhere: () => [] }],
  ]);
  const opened = capability.create({ modules: { get: (name) => contractModuleDouble(rows.get(name)) } });
  assert.equal(opened.capabilityContract, 1,
    'the synchronous interface uses capabilityContract 1; capability version 2 describes its domain shape');

  // Every exposed member is a read. There is no write, and no handle to write with.
  const members = Object.keys(opened).filter((key) => key !== 'capabilityContract');
  assert.deepEqual(members.sort(), ['listContractLines', 'listSubscriptionLines', 'termEvidence']);

  const evidence = opened.termEvidence('c1');
  assert.equal(evidence.term.endDate, '2026-12-31');
  assert.equal(evidence.term.endDateIsInclusive, true);
  // The whole reason this capability exists in this shape.
  assert.equal(evidence.term.source, declaredSource);
  assert.equal(evidence.term.signed, TERM_SOURCE_SIGNED[declaredSource],
    'signed is whatever the classification rule says about the declared source, not a constant');
  assert.equal(evidence.term.signedBasis, 'DERIVED_FROM_DECLARED_TERM_SOURCE');
  assert.match(evidence.term.provenanceNote, /OPERATIONAL metadata/);
  assert.equal(Object.isFrozen(evidence), true, 'a consumer cannot mutate the evidence it was handed');
  assert.equal(Object.isFrozen(evidence.term), true);

  // An unknown id is null, never somebody else's contract.
  assert.equal(opened.termEvidence('other'), null);
  assert.equal(opened.termEvidence(''), null);
  assert.equal(opened.termEvidence(undefined), null);
  assert.deepEqual(opened.listContractLines(''), []);
  assert.deepEqual(opened.listSubscriptionLines(null), []);
});

test('the capability refuses a caller that did not bring the modules view', () => {
  const capability = createContractLifecycleSourceCapability();
  assert.throws(() => capability.create({}), /requires the caller's modules view/);
  assert.throws(() => capability.create({ modules: {} }), /requires the caller's modules view/);
});

test('a termsSource nobody classified fails closed: the capability will not open at all', () => {
  const capability = createContractLifecycleSourceCapability();
  const service = { get: () => null, listWhere: () => [] };

  // The real composition, with the manifest's own enum: it opens.
  assert.ok(capability.create({ modules: { get: () => contractModuleDouble(service) } }));

  // A future M12 that adds a source and forgets to decide whether a term from
  // it is signed. v1 answered `false` for it — silently, permanently, from a
  // different package than the one that changed. v2 stops.
  const withNewSource = [...DECLARED_TERM_SOURCES, 'countersigned-renewal-instrument'];
  assert.throws(
    () => capability.create({ modules: { get: () => contractModuleDouble(service, withNewSource) } }),
    (error) => error.code === 'TERM_SOURCE_UNCLASSIFIED' && error.status === 500
      && error.details.unclassified.includes('countersigned-renewal-instrument')
      && /Classify it/.test(error.message),
    'the refusal names the value and says what to do about it',
  );

  // And a module contract that declares no termsSource at all has nothing to
  // derive from, so it is refused rather than defaulted.
  assert.throws(
    () => capability.create({ modules: { get: () => ({ service, fields: [] }) } }),
    (error) => error.code === 'TERM_SOURCE_UNDECLARED',
  );
});

test('signed is three-valued: decided, decided-false, and "nobody classified this"', () => {
  // Every declared source is classified — enforced against the manifest, so
  // this cannot drift.
  assert.deepEqual(Object.keys(TERM_SOURCE_SIGNED).sort(), [...DECLARED_TERM_SOURCES].sort());
  assert.deepEqual(declaredTermSources({ fields: [{ name: 'termsSource', values: ['a', 'b'] }] }), ['a', 'b']);
  assert.deepEqual(declaredTermSources(null), [], 'a missing module contract declares nothing');

  for (const source of DECLARED_TERM_SOURCES) {
    assert.equal(typeof termSignedState(source), 'boolean', `${source} is decided either way`);
    assert.equal(termSignedState(source), TERM_SOURCE_SIGNED[source]);
  }
  // `null` is not `false`: it is the absence of a decision, and a consumer must
  // be able to tell them apart to report it as a gap.
  for (const unknown of ['something-new', '', null, undefined, 42, {}, true]) {
    assert.equal(termSignedState(unknown), null);
    assert.equal(termIsSigned(unknown), false, 'but nothing unclassified is ever reported as signed');
  }
  // The map can carry `true`, so a future signed source needs no breaking change.
  assert.equal(Object.values(TERM_SOURCE_SIGNED).every((value) => typeof value === 'boolean'), true);
});

test('the follow-up state model has an exit, and every terminal state is reachable', () => {
  const resolve = createLifecyclePackage().actions.find((a) => a.name === 'resolve-commercial-followup');
  assert.deepEqual(resolve.fromStates, [FOLLOWUP_OPEN]);
  const outcomes = resolve.input.find((i) => i.name === 'outcome').values;
  assert.deepEqual([...outcomes].sort(), [...FOLLOWUP_TERMINAL].sort());
  assert.ok(outcomes.length >= 2, 'a handoff with one exit is a handoff nobody can withdraw');
  assert.equal(resolve.confirm, true, 'closing somebody else\'s request is a confirmed decision');
  // Delivery's lesson: no dead end.
  assert.ok(!FOLLOWUP_TERMINAL.includes(FOLLOWUP_OPEN));
});

test('plan-renewal declares itself as writing nothing', () => {
  const plan = createLifecyclePackage().actions.find((a) => a.name === 'plan-renewal');
  assert.equal(plan.confirm, undefined, 'a read commits nobody, so it asks for no confirmation');
  assert.deepEqual(plan.input.map((i) => i.name), ['asOf', 'windowDays']);
  assert.match(plan.description, /Writes nothing/);
  // The clock is an input, never the wall: two runs on the same asOf agree.
  assert.equal(plan.input.find((i) => i.name === 'asOf').required, true);
});

test('every writing action is a confirmed human decision', () => {
  const reads = new Set(['plan-renewal', 'plan-amendment']);
  const writing = createLifecyclePackage().actions.filter((a) => !reads.has(a.name));
  for (const action of writing) {
    assert.equal(action.confirm, true, `${action.name} must be confirmed`);
  }
  // A free-text reason is required where the human's *decision itself* is the
  // record: opening a round, recording intent, asking for work, closing it.
  // `attach-successor-order` and `execute-amendment` are deliberately not on
  // this list — what a human supplies there is evidence identity (which signed
  // Order, which policy version), and a prose box beside it would be
  // decoration that reads as governance.
  const reasoned = new Set([
    'record-renewal-decision', 'request-commercial-followup',
    'resolve-commercial-followup', 'open-amendment-run', 'abandon-amendment-run',
  ]);
  for (const action of writing.filter((a) => reasoned.has(a.name))) {
    assert.ok(action.input.some((i) => i.name === 'reason' || i.name === 'summary'),
      `${action.name} must require a human reason`);
  }
  for (const action of writing.filter((a) => !reasoned.has(a.name))) {
    assert.ok(['attach-successor-order', 'execute-amendment'].includes(action.name),
      `${action.name} writes without a stated reason and is not one of the two evidence-identity actions`);
  }
});

test('the resources it owns are evidence records, immutable through public CRUD', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const name of LIFECYCLE_RESOURCES) {
    const manifest = JSON.parse(readFileSync(`${root}packages/lifecycle/modules/${name}.module.json`, 'utf8'));
    for (const field of manifest.fields) {
      assert.equal(field.writable, 'managed',
        `${name}.${field.name} must be managed: a decision a client could edit is not evidence`);
    }
    assert.match(manifest.description, /^(?!.*\b(renewed|cancelled|churned)\b).*$/,
      `${name} must not describe itself with a word it cannot honour`);
  }
});

test('a date that matches the shape but names no real day is refused', () => {
  // Regression: `asOf` was checked with `/^\d{4}-\d{2}-\d{2}$/` alone, so
  // `2027-02-30` was accepted and JavaScript quietly rolled it over to March 2.
  // The stored evidence then held an `asOfDate` for a day that never existed
  // beside a `daysToBoundary` measured from a different one.
  assert.equal(requireCalendarDate('2027-08-01', 'asOf'), '2027-08-01');
  assert.equal(requireCalendarDate('2028-02-29', 'asOf'), '2028-02-29', 'a real leap day is a real day');
  for (const bad of ['2027-02-30', '2027-02-29', '2027-06-31', '2027-13-01', '2027-00-10', '2027-01-32']) {
    assert.throws(() => requireCalendarDate(bad, 'asOf'), (error) => error.details?.field === 'asOf', bad);
  }
  for (const bad of [
    '31/12/2027', '2027-8-1', '', undefined, null, 42, {},
    // A date-time is a different kind of fact and is refused as one: accepting
    // it would let the same day arrive under two spellings and stop colliding
    // on the key built from it.
    '2027-08-01T00:00:00.000Z', '2027-08-01T00:00:00Z', '2027-08-01 00:00:00',
    // Whitespace padding, in every position.
    ' 2027-08-01', '2027-08-01 ', '\t2027-08-01', '2027-08-01\n', '20 27-08-01',
    // Signed and expanded years, which `Date.parse` is happy to take.
    '+2027-08-01', '-2027-08-01', '02027-08-01',
  ]) {
    assert.throws(() => requireCalendarDate(bad, 'asOf'),
      (error) => error.details?.field === 'asOf', JSON.stringify(bad));
  }
  // Real boundaries, kept: the ends of a month, a year and a leap cycle.
  for (const good of ['2027-01-01', '2027-12-31', '2027-02-28', '2028-02-29', '2000-02-29', '2027-04-30']) {
    assert.equal(requireCalendarDate(good, 'asOf'), good);
  }
  // 1900 and 2100 are not leap years; 2000 is. The rule is the calendar's, not 365.
  for (const bad of ['1900-02-29', '2100-02-29', '2027-02-29']) {
    assert.throws(() => requireCalendarDate(bad, 'asOf'), /not a real calendar date/, bad);
  }
  // Inclusive end-date arithmetic across a leap day and a year boundary.
  assert.equal(daysToBoundary('2028-02-28', '2028-02-29'), 1);
  assert.equal(daysToBoundary('2027-12-31', '2028-01-01'), 1);
  assert.equal(daysToBoundary('2028-02-29', '2029-02-28'), 365);
  // And the arithmetic refuses to produce a number from a day that is not one.
  assert.equal(daysToBoundary('2027-02-30', '2027-08-31'), null);
  assert.equal(daysToBoundary('2027-08-01', '2027-02-30'), null);
  assert.equal(daysToBoundary('2027-08-01', '2027-08-31'), 30);
});


test('nothing the capability hands back is a handle a consumer could write through', () => {
  const capability = createContractLifecycleSourceCapability();
  const contract = {
    id: 'c1', status: 'active', currency: 'EUR', customerName: 'Rossi', currentVersionId: 'v1',
    termStartDate: '2026-01-01', termEndDate: '2026-12-31', termDays: 365, autoRenew: 1,
    renewalNoticeDays: 30, termsSource: 'post-signature-operational-activation', termsReason: 'as ordered',
  };
  const line = {
    id: 'l1', contractVersionId: 'v1', label: 'Seats', componentKey: 'seats', chargeType: 'recurring',
    pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, quantity: 1,
    netAmountCents: 1_000, currency: 'EUR', commercialActivation: 'subscription', position: 1,
  };
  const rows = new Map([
    ['commercial-contract', { get: (id) => (id === 'c1' ? contract : null) }],
    ['contract-version', { get: () => ({ versionNumber: 2 }) }],
    ['contract-line', { listWhere: () => [{ ...line }] }],
    ['subscription', { listWhere: () => [{ id: 's1' }] }],
    ['subscription-line', { listWhere: () => [{ id: 'sl1', subscriptionId: 's1', componentKey: 'seats' }] }],
  ]);
  const opened = capability.create({ modules: { get: (name) => contractModuleDouble(rows.get(name)) } });

  // The interface itself is frozen: a consumer cannot redefine `termEvidence`
  // to make its own package lie in its own trace.
  assert.equal(Object.isFrozen(opened), true);
  assert.throws(() => { /** @type {any} */ (opened).write = () => 'pwned'; }, TypeError);

  // Nothing exposed is, or reaches, a service, a database or a transaction.
  assert.deepEqual(Object.keys(opened).filter((key) => key !== 'capabilityContract').sort(),
    ['listContractLines', 'listSubscriptionLines', 'termEvidence']);
  assert.equal(Object.keys(opened).some((key) => /service|database|transaction|managed|create|update/i.test(key)), false);

  // Evidence is frozen all the way down, and carries no object a caller could
  // reach a live row through.
  const evidence = opened.termEvidence('c1');
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.term), true);
  assert.throws(() => Object.defineProperty(evidence, 'injected', { value: 1 }), TypeError);
  assert.throws(() => Object.setPrototypeOf(evidence, { pwned: 1 }), TypeError);
  assert.equal(Object.values(evidence).some((value) => typeof value === 'function'), false);
  assert.deepEqual(Object.entries(evidence).filter(([, value]) => value && typeof value === 'object').map(([key]) => key),
    ['term'], 'the only nested object is the term, and it is frozen too');

  // The lists are frozen too, and their rows are copies: mutating what a
  // consumer was handed can never reach the row behind it.
  for (const list of [opened.listContractLines('c1'), opened.listSubscriptionLines('c1'), opened.listContractLines(''), opened.listSubscriptionLines(null)]) {
    assert.equal(Object.isFrozen(list), true);
    assert.throws(() => list.push({ forged: true }), TypeError);
    for (const row of list) {
      assert.equal(Object.isFrozen(row), true);
      assert.equal(Object.values(row).some((value) => value && typeof value === 'object'), false,
        'every field is a primitive, so no live reference escapes');
    }
  }
  const first = opened.listContractLines('c1')[0];
  assert.throws(() => { /** @type {any} */ (first).netAmountCents = 1; }, TypeError);
  assert.equal(opened.listContractLines('c1')[0].netAmountCents, 1_000, 're-reading is unaffected');
});
