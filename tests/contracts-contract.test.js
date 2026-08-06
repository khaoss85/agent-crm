import test from 'node:test';
import assert from 'node:assert/strict';

import { PackageRegistry, validatePackageDefinition } from '../packages/core/index.js';
import {
  COMMERCIAL_ACTIVATIONS,
  OBLIGATION_TYPES,
  OVERRIDABLE_COMMERCIAL,
  assertClassificationCoherent,
  classificationContext,
  defineOrderActivationPolicy,
  normalizeClassification,
  normalizeOverrides,
} from '../packages/contracts/src/activation-policy.js';
import { createContractsDomain } from '../packages/contracts/src/index.js';
import { activationState, daysBetween, requireCalendarDate, requireTerm } from '../packages/contracts/src/dates.js';
import { validateActionInput } from '../packages/core/src/action-runtime.js';

/**
 * Milestone 12 contract tests: the generic domain-package seam (ADR-018
 * addendum), the versioned order-activation policy, the calendar-date term
 * contract and the override rules. No database, no HTTP, no app.
 */

const refuses = (fn, match) => assert.throws(fn, match);

const policy = (overrides = {}) => ({
  name: 'b2b-activation',
  version: 1,
  label: 'Activation',
  config: { componentKeys: { seats: 'subscription' } },
  classifyComponent: () => ({ commercialActivation: 'non_subscription', obligations: [], reason: 'fixture' }),
  ...overrides,
});

const domain = (overrides = {}) => ({
  name: 'contracts',
  packageContract: 1,
  version: 1,
  label: 'Contracts',
  actions: [],
  policies: [{ kind: 'order-activation-policy', definition: policy() }],
  metadata: () => ({ contractsContract: 1 }),
  ...overrides,
});

test('the domain-package contract is generic and validated fail-closed', () => {
  assert.equal(validatePackageDefinition(domain()).name, 'contracts');
  refuses(() => validatePackageDefinition({ ...domain(), name: 'Contracts' }), /name must match/);
  refuses(() => validatePackageDefinition({ ...domain(), name: '__proto__' }), /name must match/);
  refuses(() => validatePackageDefinition({ ...domain(), packageContract: 2 }), /packageContract must be 1/);
  refuses(() => validatePackageDefinition({ ...domain(), actions: 'nope' }), /actions must be an array/);
  refuses(() => validatePackageDefinition({ ...domain(), metadata: 'nope' }), /metadata must be a function/);
  refuses(() => validatePackageDefinition({ ...domain(), policies: [{ kind: 'Bad Kind', definition: policy() }] }), /policy kind must match/);
  refuses(() => validatePackageDefinition({ ...domain(), policies: [{ kind: 'k', definition: { ...policy(), version: 0 } }] }), /version must be a positive integer/);
  refuses(() => validatePackageDefinition({ ...domain(), policies: [{ kind: 'k', definition: { ...policy(), config: 'x' } }] }), /config must be a plain object/);

  // The kernel seam knows nothing about contracts: the same registry accepts
  // any domain, which is the whole point of ADR-018.
  assert.equal(validatePackageDefinition({ ...domain(), name: 'delivery', policies: [] }).name, 'delivery');
});

test('the domain registry is Map-backed, unique, fingerprinted and function-free', () => {
  const registry = new PackageRegistry({ packages: [domain()] });
  const entry = registry.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1);
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(registry.has('contracts'), true);
  assert.equal(registry.has('__proto__'), false);
  refuses(() => registry.get('__proto__'), /Domain package/);
  refuses(() => registry.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 2), /Domain policy/);
  refuses(() => registry.getPolicy('__proto__', 'k', 'n', 1), /Domain policy/);
  refuses(() => new PackageRegistry({ packages: [domain(), domain()] }), /Duplicate domain package/);

  // Declared config is inside the fingerprint: an edited mapping is a
  // different definition, which is what stops a silent change at boot.
  const changed = new PackageRegistry({
    domains: [domain({ policies: [{ kind: 'order-activation-policy', definition: policy({ config: { componentKeys: { seats: 'delivery' } } }) }] })],
  });
  assert.notEqual(changed.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1).fingerprint, entry.fingerprint);

  // …and so is the handler source.
  const rewritten = new PackageRegistry({
    domains: [domain({ policies: [{ kind: 'order-activation-policy', definition: policy({ classifyComponent: () => ({ commercialActivation: 'non_subscription', obligations: ['delivery'] }) }) }] })],
  });
  assert.notEqual(rewritten.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1).fingerprint, entry.fingerprint);

  const metadata = registry.metadata();
  assert.equal(metadata.contracts.packageContract, 1);
  assert.equal(metadata.contracts.policies[0].fingerprint, entry.fingerprint);
  assert.equal(JSON.stringify(metadata).includes('function'), false);
  // No registered domain means no metadata at all, not an empty shell.
  assert.deepEqual(new PackageRegistry().metadata(), {});
  assert.deepEqual(new PackageRegistry().actions(), []);
});

test('the contracts domain declares its resources, limits and human boundary', () => {
  const built = createContractsDomain({ policies: [policy()] });
  assert.equal(built.name, 'contracts');
  assert.equal(built.packageContract, 1);
  assert.deepEqual(built.actions.map((action) => `${action.module}.${action.name}`), ['order.plan-activation', 'order.activate-contract']);

  const metadata = built.metadata();
  // Resources are declared on the package itself now — that is what makes a
  // collision between two packages detectable before boot.
  assert.equal(built.resources.length, 8);
  assert.ok(built.resources.includes('delivery-obligation'));
  // …and the package offers exactly one capability to other packages.
  assert.deepEqual(built.capabilities.map((entry) => `${entry.name}@${entry.version}`), ['delivery-obligations@1']);
  assert.deepEqual(metadata.classification.commercialActivation, [...COMMERCIAL_ACTIVATIONS]);
  assert.deepEqual(metadata.classification.obligations, [...OBLIGATION_TYPES]);
  assert.deepEqual(metadata.classification.dimensions, ['commercial', 'obligations']);
  assert.match(metadata.classification.note, /two independent axes/i);
  // The provenance of the term is part of the published contract, because the
  // signed document does not carry one (review finding C1).
  assert.equal(metadata.term.source, 'post-signature-operational-activation');
  assert.equal(metadata.term.requiresReason, true);
  assert.match(metadata.activationState.limitation, /no scheduler/i);
  assert.ok(metadata.humanApproval.includes('HUMAN_APPROVAL_REQUIRED'));
  assert.ok(metadata.humanApproval.includes('not Sales/Legal/Finance role enforcement'));
  assert.ok(metadata.source.includes('never read'));
  // The things this milestone does NOT do are part of the published contract.
  for (const absent of ['billing', 'invoicing', 'MRR/ARR/TCV', 'renewal', 'cancellation', 'SLA']) {
    assert.ok(metadata.notModeled.includes(absent), absent);
  }
  assert.equal(metadata.term.renewalNotice.includes('no scheduler'), true);
  // A malformed policy never reaches the registry.
  refuses(() => createContractsDomain({ policies: [{ ...policy(), classifyComponent: 'nope' }] }), /classifyComponent must be a function/);
});

test('classification results are bounded on both axes, and recurrence decides neither', () => {
  assert.deepEqual(
    normalizeClassification('p', { commercialActivation: 'non_subscription', obligations: ['delivery'], reason: 'setup work' }),
    { commercialActivation: 'non_subscription', obligations: ['delivery'], reason: 'setup work' },
  );
  // The case the second axis exists for: recurring money AND future service.
  assert.deepEqual(
    normalizeClassification('p', { commercialActivation: 'subscription', obligations: ['service'], reason: 'annual support' }),
    { commercialActivation: 'subscription', obligations: ['service'], reason: 'annual support' },
  );
  // Obligations are canonically ordered, so one decision stores as one string.
  assert.deepEqual(normalizeClassification('p', { commercialActivation: 'subscription', obligations: ['service', 'delivery'] }).obligations, ['delivery', 'service']);
  // Omitted obligations mean "nothing further is owed" — a decision, not a gap.
  assert.deepEqual(normalizeClassification('p', { commercialActivation: 'subscription' }).obligations, []);
  // …which is NOT the same as admitting the axis is undecided.
  assert.equal(normalizeClassification('p', { commercialActivation: 'subscription', obligations: 'ambiguous' }).obligations, 'ambiguous');
  assert.equal(normalizeClassification('p', { commercialActivation: 'subscription', obligations: ['ambiguous'] }).obligations, 'ambiguous');
  assert.equal(normalizeClassification('p', { commercialActivation: 'non_subscription' }).reason, null);
  assert.equal(normalizeClassification('p', { commercialActivation: 'non_subscription', reason: 'x'.repeat(500) }).reason.length, 300);

  refuses(() => normalizeClassification('p', Promise.resolve({ commercialActivation: 'non_subscription' })), /must classify synchronously/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'billing' }), /commercialActivation must be one of/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'delivery' }), /commercialActivation must be one of/);
  refuses(() => normalizeClassification('p', 'delivery'), /must return \{commercialActivation, obligations, reason\}/);
  refuses(() => normalizeClassification('p', null), /must return \{commercialActivation, obligations, reason\}/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'subscription', obligations: ['billing'] }), /obligations may only contain/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'subscription', obligations: ['delivery', 'delivery'] }), /duplicate obligation/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'subscription', obligations: 'delivery' }), /obligations must be an array/);
  refuses(() => normalizeClassification('p', { commercialActivation: 'non_subscription', reason: '' }), /reason must be a non-empty string/);

  // The one coherence rule: a subscription line must actually recur.
  const oneTime = { chargeType: 'one_time', componentKey: 'setup' };
  const recurring = { chargeType: 'recurring', componentKey: 'platform' };
  refuses(() => assertClassificationCoherent({ commercialActivation: 'subscription' }, oneTime), /cannot be a subscription line/);
  assert.equal(assertClassificationCoherent({ commercialActivation: 'subscription' }, recurring).commercialActivation, 'subscription');
  // Obligations legitimately carry either recurrence — that is the point of
  // keeping them on their own axis.
  for (const chargeType of ['one_time', 'recurring']) {
    assert.equal(
      assertClassificationCoherent({ commercialActivation: 'non_subscription' }, { chargeType, componentKey: 'x' }).commercialActivation,
      'non_subscription',
    );
  }
});

test('the classification context is frozen order evidence plus declared config', () => {
  const context = classificationContext({
    order: { id: 'o1', currency: 'EUR', quoteVersionId: 'v1', secret: 'nope' },
    line: { id: 'l1', sku: 'PLATFORM', quantity: 20 },
    component: { id: 'c1', componentKey: 'seats', chargeType: 'recurring', netAmountCents: 100 },
    config: { componentKeys: { seats: 'subscription' } },
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.component), true);
  assert.equal(Object.isFrozen(context.config), true);
  assert.equal(context.config.componentKeys.seats, 'subscription');
  // Only the declared projection travels: no stray order field leaks through.
  assert.equal(context.order.secret, undefined);
  assert.deepEqual(Object.keys(context).sort(), ['component', 'config', 'line', 'order']);
  // A policy cannot mutate what it was given.
  assert.throws(() => { context.component.netAmountCents = 1; }, TypeError);
});

test('overrides are human decisions about ONE dimension: bounded and reasoned', () => {
  const known = new Set(['c1', 'c2']);
  const parsed = normalizeOverrides(
    [{ orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: '  it recurs  ' }],
    known,
  );
  assert.deepEqual(parsed.get('c1/commercial'), {
    orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: 'it recurs',
  });
  // Both axes of one component can be decided independently.
  const both = normalizeOverrides([
    { orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: 'recurring right' },
    { orderComponentId: 'c1', dimension: 'obligations', value: ['service', 'delivery'], reason: 'we run it for them' },
  ], known);
  assert.equal(both.size, 2);
  assert.deepEqual(both.get('c1/obligations').value, ['delivery', 'service'], 'canonical order');
  assert.equal(normalizeOverrides(undefined, known).size, 0);
  // An explicit empty list is a decision: this component owes nothing further.
  assert.deepEqual(normalizeOverrides([{ orderComponentId: 'c1', dimension: 'obligations', value: [], reason: 'nothing owed' }], known).get('c1/obligations').value, []);

  refuses(() => normalizeOverrides('c1', known), /must be an array/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c3', dimension: 'commercial', value: 'subscription', reason: 'x' }], known), /targets a component of another order/);
  refuses(() => normalizeOverrides([{ dimension: 'commercial', value: 'subscription', reason: 'x' }], known), /orderComponentId is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', value: 'subscription', reason: 'x' }], known), /dimension must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'billing', value: 'subscription', reason: 'x' }], known), /dimension must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'ambiguous', reason: 'x' }], known), /value must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'delivery', reason: 'x' }], known), /value must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'obligations', value: 'delivery', reason: 'x' }], known), /must be an array of obligations/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'obligations', value: ['delivery', 'delivery'], reason: 'x' }], known), /duplicate obligation/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'obligations', value: ['nope'], reason: 'x' }], known), /value may only contain/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'subscription' }], known), /reason is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: '   ' }], known), /reason is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: 'x'.repeat(400) }], known), /reason is required/);
  refuses(
    () => normalizeOverrides([{ orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: `a${String.fromCharCode(0)}b` }], known),
    /control characters/,
  );
  refuses(
    () => normalizeOverrides([
      { orderComponentId: 'c1', dimension: 'commercial', value: 'subscription', reason: 'a' },
      { orderComponentId: 'c1', dimension: 'commercial', value: 'non_subscription', reason: 'b' },
    ], known),
    /duplicate classification override/,
  );
  assert.deepEqual([...OVERRIDABLE_COMMERCIAL], ['subscription', 'non_subscription']);
  assert.equal(OVERRIDABLE_COMMERCIAL.includes('ambiguous'), false);
});

test('commercial terms are calendar dates, validated by round trip', () => {
  assert.equal(requireCalendarDate('2026-09-01', 'd'), '2026-09-01');
  assert.equal(requireCalendarDate('2028-02-29', 'd'), '2028-02-29', 'a real leap day is valid');

  refuses(() => requireCalendarDate('2026-02-30', 'd'), /not a real calendar date/);
  refuses(() => requireCalendarDate('2026-06-31', 'd'), /not a real calendar date/);
  refuses(() => requireCalendarDate('2027-02-29', 'd'), /not a real calendar date/);
  refuses(() => requireCalendarDate('2026-13-01', 'd'), /not a real calendar date/);
  refuses(() => requireCalendarDate('2026-09-01T00:00:00Z', 'd'), /calendar date \(YYYY-MM-DD\)/);
  refuses(() => requireCalendarDate(' 2026-09-01', 'd'), /calendar date \(YYYY-MM-DD\)/);
  refuses(() => requireCalendarDate('2026-9-1', 'd'), /calendar date \(YYYY-MM-DD\)/);
  refuses(() => requireCalendarDate(20260901, 'd'), /calendar date \(YYYY-MM-DD\)/);
  refuses(() => requireCalendarDate(null, 'd'), /calendar date \(YYYY-MM-DD\)/);
  refuses(() => requireCalendarDate(['2026-09-01'], 'd'), /calendar date \(YYYY-MM-DD\)/);

  assert.equal(daysBetween('2026-09-01', '2027-08-31'), 364);
  assert.equal(daysBetween('2026-09-01', '2026-09-01'), 0);
});

test('the term is one coherent object with an inclusive end date', () => {
  const term = requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: true, renewalNoticeDays: 90, termsReason: 'agreed by email' });
  assert.equal(term.termDays, 365, 'the end date is inclusive: both boundary days are inside the term');
  assert.equal(term.autoRenew, true);
  assert.equal(term.renewalNoticeDays, 90);
  // A single-day term is legal and still inclusive.
  assert.equal(requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-01', termsReason: 'r' }).termDays, 1);
  assert.equal(requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-01', termsReason: 'r' }).autoRenew, false);

  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-02', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }), /termStartDate cannot precede effectiveDate/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-02', termEndDate: '2026-09-01' }), /termEndDate cannot precede termStartDate/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2099-01-01' }), /cannot exceed 3650 days/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: 'true' }), /autoRenew must be a boolean/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: 1 }), /autoRenew must be a boolean/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: -1 }), /renewalNoticeDays must be an integer/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: 1.5 }), /renewalNoticeDays must be an integer/);
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: 400 }), /renewalNoticeDays must be an integer/);
  // A notice period longer than the term itself is incoherent.
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-10', autoRenew: true, renewalNoticeDays: 90 }), /cannot exceed the term length/);
  // A notice period without auto-renewal is a clause that can never apply.
  refuses(() => requireTerm({ termsReason: 'r', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: 30 }), /renewalNoticeDays requires autoRenew/);

  // The term is NOT signed: it carries its provenance and needs a reason.
  assert.equal(term.termsSource, 'post-signature-operational-activation');
  assert.equal(term.termsReason, 'agreed by email');
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }), /termsReason is required/);
  refuses(() => requireTerm({ termsReason: '  ', effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }), /termsReason is required/);
  refuses(() => requireTerm({ termsReason: `a${String.fromCharCode(0)}b`, effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }), /control characters/);

  // Activation state is decided against the business date, never assumed.
  const window = { termStartDate: '2026-09-01', termEndDate: '2027-08-31' };
  assert.equal(activationState(window, '2026-08-01'), 'scheduled');
  assert.equal(activationState(window, '2026-09-01'), 'active', 'the first day is inside the term');
  assert.equal(activationState(window, '2027-08-31'), 'active', 'and so is the last');
  assert.equal(activationState(window, '2027-09-01'), 'ended');
});

test('a strict boolean action input never coerces', () => {
  const schema = [{ name: 'autoRenew', type: 'boolean', required: false }];
  assert.equal(validateActionInput(schema, { autoRenew: true }).autoRenew, true);
  assert.equal(validateActionInput(schema, { autoRenew: false }).autoRenew, false);
  assert.equal(validateActionInput(schema, {}).autoRenew, undefined);
  assert.throws(() => validateActionInput(schema, { autoRenew: 'true' }), /must be true or false/);
  assert.throws(() => validateActionInput(schema, { autoRenew: 1 }), /must be true or false/);
  assert.throws(() => validateActionInput(schema, { autoRenew: 'yes' }), /must be true or false/);
});
