import test from 'node:test';
import assert from 'node:assert/strict';

import { DomainRegistries, validateDomainDefinition } from '../packages/core/src/domain-registry.js';
import {
  CLASSIFICATION_TYPES,
  OVERRIDABLE_TYPES,
  assertClassificationCoherent,
  classificationContext,
  defineOrderActivationPolicy,
  normalizeClassification,
  normalizeOverrides,
} from '../packages/contracts/src/activation-policy.js';
import { createContractsDomain } from '../packages/contracts/src/index.js';
import { daysBetween, requireCalendarDate, requireTerm } from '../packages/contracts/src/dates.js';
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
  classifyComponent: () => ({ type: 'other', reason: 'fixture' }),
  ...overrides,
});

const domain = (overrides = {}) => ({
  name: 'contracts',
  domainContract: 1,
  label: 'Contracts',
  actions: [],
  policies: [{ kind: 'order-activation-policy', definition: policy() }],
  metadata: () => ({ contractsContract: 1 }),
  ...overrides,
});

test('the domain-package contract is generic and validated fail-closed', () => {
  assert.equal(validateDomainDefinition(domain()).name, 'contracts');
  refuses(() => validateDomainDefinition({ ...domain(), name: 'Contracts' }), /name must match/);
  refuses(() => validateDomainDefinition({ ...domain(), name: '__proto__' }), /name must match/);
  refuses(() => validateDomainDefinition({ ...domain(), domainContract: 2 }), /domainContract must be 1/);
  refuses(() => validateDomainDefinition({ ...domain(), actions: 'nope' }), /actions must be an array/);
  refuses(() => validateDomainDefinition({ ...domain(), metadata: 'nope' }), /metadata must be a function/);
  refuses(() => validateDomainDefinition({ ...domain(), policies: [{ kind: 'Bad Kind', definition: policy() }] }), /policy kind must match/);
  refuses(() => validateDomainDefinition({ ...domain(), policies: [{ kind: 'k', definition: { ...policy(), version: 0 } }] }), /version must be a positive integer/);
  refuses(() => validateDomainDefinition({ ...domain(), policies: [{ kind: 'k', definition: { ...policy(), config: 'x' } }] }), /config must be a plain object/);

  // The kernel seam knows nothing about contracts: the same registry accepts
  // any domain, which is the whole point of ADR-018.
  assert.equal(validateDomainDefinition({ ...domain(), name: 'delivery', policies: [] }).name, 'delivery');
});

test('the domain registry is Map-backed, unique, fingerprinted and function-free', () => {
  const registry = new DomainRegistries({ domains: [domain()] });
  const entry = registry.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1);
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(registry.has('contracts'), true);
  assert.equal(registry.has('__proto__'), false);
  refuses(() => registry.get('__proto__'), /Domain package/);
  refuses(() => registry.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 2), /Domain policy/);
  refuses(() => registry.getPolicy('__proto__', 'k', 'n', 1), /Domain policy/);
  refuses(() => new DomainRegistries({ domains: [domain(), domain()] }), /Duplicate domain package/);

  // Declared config is inside the fingerprint: an edited mapping is a
  // different definition, which is what stops a silent change at boot.
  const changed = new DomainRegistries({
    domains: [domain({ policies: [{ kind: 'order-activation-policy', definition: policy({ config: { componentKeys: { seats: 'delivery' } } }) }] })],
  });
  assert.notEqual(changed.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1).fingerprint, entry.fingerprint);

  // …and so is the handler source.
  const rewritten = new DomainRegistries({
    domains: [domain({ policies: [{ kind: 'order-activation-policy', definition: policy({ classifyComponent: () => ({ type: 'delivery' }) }) }] })],
  });
  assert.notEqual(rewritten.getPolicy('contracts', 'order-activation-policy', 'b2b-activation', 1).fingerprint, entry.fingerprint);

  const metadata = registry.metadata();
  assert.equal(metadata.contracts.domainContract, 1);
  assert.equal(metadata.contracts.policies[0].fingerprint, entry.fingerprint);
  assert.equal(JSON.stringify(metadata).includes('function'), false);
  // No registered domain means no metadata at all, not an empty shell.
  assert.deepEqual(new DomainRegistries().metadata(), {});
  assert.deepEqual(new DomainRegistries().actions(), []);
});

test('the contracts domain declares its resources, limits and human boundary', () => {
  const built = createContractsDomain({ policies: [policy()] });
  assert.equal(built.name, 'contracts');
  assert.equal(built.domainContract, 1);
  assert.deepEqual(built.actions.map((action) => `${action.module}.${action.name}`), ['order.plan-activation', 'order.activate-contract']);

  const metadata = built.metadata();
  assert.equal(metadata.resources.length, 8);
  assert.deepEqual(metadata.classificationTypes, [...CLASSIFICATION_TYPES]);
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

test('classification results are bounded, and recurrence alone never decides', () => {
  assert.deepEqual(normalizeClassification('p', { type: 'delivery', reason: 'setup work' }), { type: 'delivery', reason: 'setup work' });
  assert.equal(normalizeClassification('p', { type: 'other' }).reason, null);
  assert.equal(normalizeClassification('p', { type: 'delivery', reason: 'x'.repeat(500) }).reason.length, 300);

  refuses(() => normalizeClassification('p', Promise.resolve({ type: 'other' })), /must classify synchronously/);
  refuses(() => normalizeClassification('p', { type: 'billing' }), /type must be one of/);
  refuses(() => normalizeClassification('p', 'delivery'), /must return \{type, reason\}/);
  refuses(() => normalizeClassification('p', null), /must return \{type, reason\}/);
  refuses(() => normalizeClassification('p', { type: 'other', reason: '' }), /reason must be a non-empty string/);

  // The one coherence rule: a subscription line must actually recur.
  const oneTime = { chargeType: 'one_time', componentKey: 'setup' };
  const recurring = { chargeType: 'recurring', componentKey: 'platform' };
  refuses(() => assertClassificationCoherent({ type: 'subscription' }, oneTime), /cannot be a subscription line/);
  assert.equal(assertClassificationCoherent({ type: 'subscription' }, recurring).type, 'subscription');
  // Delivery and service legitimately carry either recurrence.
  for (const type of ['delivery', 'service', 'other']) {
    assert.equal(assertClassificationCoherent({ type }, oneTime).type, type);
    assert.equal(assertClassificationCoherent({ type }, recurring).type, type);
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

test('overrides are human decisions: bounded, reasoned and never ambiguous', () => {
  const known = new Set(['c1', 'c2']);
  const parsed = normalizeOverrides([{ orderComponentId: 'c1', type: 'delivery', reason: '  migration work  ' }], known);
  assert.deepEqual(parsed.get('c1'), { type: 'delivery', reason: 'migration work' });
  assert.equal(normalizeOverrides(undefined, known).size, 0);

  refuses(() => normalizeOverrides('c1', known), /must be an array/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c3', type: 'delivery', reason: 'x' }], known), /targets a component of another order/);
  refuses(() => normalizeOverrides([{ type: 'delivery', reason: 'x' }], known), /orderComponentId is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', type: 'ambiguous', reason: 'x' }], known), /type must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', type: 'billing', reason: 'x' }], known), /type must be one of/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', type: 'delivery' }], known), /reason is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', type: 'delivery', reason: '   ' }], known), /reason is required/);
  refuses(() => normalizeOverrides([{ orderComponentId: 'c1', type: 'delivery', reason: 'x'.repeat(400) }], known), /reason is required/);
  refuses(
    () => normalizeOverrides([{ orderComponentId: 'c1', type: 'delivery', reason: 'a' }, { orderComponentId: 'c1', type: 'service', reason: 'b' }], known),
    /duplicate classification override/,
  );
  assert.deepEqual([...OVERRIDABLE_TYPES], ['subscription', 'delivery', 'service', 'other']);
  assert.equal(OVERRIDABLE_TYPES.includes('ambiguous'), false);
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
  const term = requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: true, renewalNoticeDays: 90 });
  assert.equal(term.termDays, 365, 'the end date is inclusive: both boundary days are inside the term');
  assert.equal(term.autoRenew, true);
  assert.equal(term.renewalNoticeDays, 90);
  // A single-day term is legal and still inclusive.
  assert.equal(requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-01' }).termDays, 1);
  assert.equal(requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-01' }).autoRenew, false);

  refuses(() => requireTerm({ effectiveDate: '2026-09-02', termStartDate: '2026-09-01', termEndDate: '2027-08-31' }), /termStartDate cannot precede effectiveDate/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-02', termEndDate: '2026-09-01' }), /termEndDate cannot precede termStartDate/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2099-01-01' }), /cannot exceed 3650 days/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: 'true' }), /autoRenew must be a boolean/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', autoRenew: 1 }), /autoRenew must be a boolean/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: -1 }), /renewalNoticeDays must be an integer/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: 1.5 }), /renewalNoticeDays must be an integer/);
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', renewalNoticeDays: 400 }), /renewalNoticeDays must be an integer/);
  // A notice period longer than the term itself is incoherent.
  refuses(() => requireTerm({ effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-10', renewalNoticeDays: 90 }), /cannot exceed the term length/);
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
