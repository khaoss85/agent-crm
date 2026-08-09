import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISIONS, FOLLOWUP_OPEN, FOLLOWUP_TERMINAL, INTENTS, LIFECYCLE_RESOURCES,
  SOURCE_CAPABILITY, createLifecyclePackage, daysToBoundary, evidenceGaps,
  groupBaseline, requireCalendarDate, requireReason,
} from '../packages/lifecycle/src/index.js';
import {
  createContractLifecycleSourceCapability, LIFECYCLE_SOURCE, TERM_SOURCE_SIGNED, termIsSigned,
} from '../packages/contracts/src/lifecycle-capability.js';

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
  assert.deepEqual([...pkg.resources].sort(), ['commercial-followup', 'renewal-decision']);
  // The contract is the project's host record here: acted on, never owned.
  assert.equal(pkg.resources.includes('commercial-contract'), false,
    'the contract belongs to Contracts; claiming it would be a collision and a lie');
  assert.deepEqual(pkg.requires, [{ package: 'contracts', capability: 'contract-lifecycle-source', version: 1 }]);
  assert.deepEqual(pkg.capabilities, [], 'M16a offers nothing yet; it consumes');
  assert.deepEqual(pkg.actions.map((a) => `${a.module}.${a.name}`).sort(), [
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
  for (const absent of ['amendment execution', 'billing', 'invoicing', 'revenue recognition', 'ARR/MRR/TCV', 'FX']) {
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
  assert.equal(capability.version, 1);
  assert.equal(SOURCE_CAPABILITY.capability, capability.name);

  const rows = new Map([
    ['commercial-contract', { get: (id) => (id === 'c1' ? {
      id: 'c1', status: 'active', currency: 'EUR', customerName: 'Rossi', currentVersionId: 'v1',
      termStartDate: '2026-01-01', termEndDate: '2026-12-31', termDays: 365,
      autoRenew: 1, renewalNoticeDays: 30, termsSource: 'order-form', termsReason: 'as ordered',
    } : null) }],
    ['contract-version', { get: () => ({ versionNumber: 2 }) }],
    ['contract-line', { listWhere: () => [] }],
    ['subscription', { listWhere: () => [] }],
    ['subscription-line', { listWhere: () => [] }],
  ]);
  const opened = capability.create({ modules: { get: (name) => ({ service: rows.get(name) }) } });

  // Every exposed member is a read. There is no write, and no handle to write with.
  const members = Object.keys(opened).filter((key) => key !== 'capabilityContract');
  assert.deepEqual(members.sort(), ['listContractLines', 'listSubscriptionLines', 'termEvidence']);

  const evidence = opened.termEvidence('c1');
  assert.equal(evidence.term.endDate, '2026-12-31');
  assert.equal(evidence.term.endDateIsInclusive, true);
  // The whole reason this capability exists in this shape.
  assert.equal(evidence.term.source, 'order-form');
  assert.equal(evidence.term.signed, false, 'activation terms are never presented as signed');
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
  const writing = createLifecyclePackage().actions.filter((a) => a.name !== 'plan-renewal');
  for (const action of writing) {
    assert.equal(action.confirm, true, `${action.name} must be confirmed`);
    assert.ok(action.input.some((i) => i.name === 'reason' || i.name === 'summary'),
      `${action.name} must require a human reason`);
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
  for (const bad of ['31/12/2027', '2027-8-1', '', undefined, null, 42, {}]) {
    assert.throws(() => requireCalendarDate(bad, 'asOf'), /must be a calendar date/);
  }
  // And the arithmetic refuses to produce a number from a day that is not one.
  assert.equal(daysToBoundary('2027-02-30', '2027-08-31'), null);
  assert.equal(daysToBoundary('2027-08-01', '2027-02-30'), null);
  assert.equal(daysToBoundary('2027-08-01', '2027-08-31'), 30);
});


test('`signed` is derived from the declared term source, and every source is classified', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}packages/contracts/modules/commercial-contract.module.json`, 'utf8'));
  const declared = manifest.fields.find((field) => field.name === 'termsSource').values;

  // The point of the map: the day M12 adds a source, this fails until somebody
  // decides whether a term from it is signed. A hard-coded `false` would have
  // gone on quietly answering for a value nobody had thought about.
  assert.deepEqual(Object.keys(TERM_SOURCE_SIGNED).sort(), [...declared].sort(),
    'every declared termsSource must be classified as signed or not');
  assert.equal(termIsSigned('post-signature-operational-activation'), false,
    'an activation term is operational metadata, never a signed renewal term');
  // Fails closed: unknown, absent and non-string are all "not signed", because
  // reporting an unsigned date as signed is the one failure that matters.
  for (const unknown of ['something-new', '', null, undefined, 42, {}, true]) {
    assert.equal(termIsSigned(unknown), false);
  }
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
  const opened = capability.create({ modules: { get: (name) => ({ service: rows.get(name) }) } });

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
