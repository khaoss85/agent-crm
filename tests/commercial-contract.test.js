import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommercialRegistries,
  validateCatalogProvider,
  validateDiscountPolicy,
  normalizePolicyResult,
} from '../packages/core/src/commercial-registry.js';
import {
  computeLineAmounts,
  computeQuoteTotals,
  requireAmount,
  requireBps,
  requireQuantity,
  requireCurrency,
} from '../packages/core/src/commercial-money.js';
import { createDatabase } from '../packages/core/src/database.js';

function provider(overrides = {}) {
  return {
    name: 'fixture-catalog',
    version: 1,
    label: 'Fixture',
    config: { source: 'fixture' },
    async fetchCatalog() { return { priceBooks: [], products: [], entries: [] }; },
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    name: 'discounts',
    version: 1,
    label: 'Discounts',
    config: { autoApproveMaxBps: 1000 },
    evaluate: (ctx) => (ctx.maxLineDiscountBps <= ctx.config.autoApproveMaxBps
      ? { decision: 'auto_approve' }
      : { decision: 'approval_required', requiredApprovalKey: 'sales-manager' }),
    ...overrides,
  };
}

test('commercial definitions validate and fail closed with precise reasons', () => {
  assert.doesNotThrow(() => validateCatalogProvider(provider()));
  assert.doesNotThrow(() => validateDiscountPolicy(policy()));
  const cases = [
    [() => validateCatalogProvider(provider({ name: '__proto__' })), /name must match/],
    [() => validateCatalogProvider(provider({ version: 0 })), /positive integer/],
    [() => validateCatalogProvider(provider({ fetchCatalog: undefined })), /fetchCatalog must be a function/],
    [() => validateCatalogProvider(provider({ config: { when: new Date(0) } })), /config must be plain JSON-safe data/],
    [() => validateCatalogProvider(provider({ label: 'x'.repeat(81) })), /at most 80/],
    [() => validateDiscountPolicy(policy({ evaluate: 'nope' })), /evaluate must be a function/],
    [() => validateDiscountPolicy(policy({ version: 1.5 })), /positive integer/],
    [() => validateDiscountPolicy(policy({ config: [1] })), /config must be a plain object/],
  ];
  for (const [fn, pattern] of cases) assert.throws(fn, pattern);
  // Duplicate identities are refused; distinct versions coexist.
  assert.throws(() => new CommercialRegistries({ discountPolicies: [policy(), policy()] }), /Duplicate discount policy identity/);
  assert.doesNotThrow(() => new CommercialRegistries({ discountPolicies: [policy(), policy({ version: 2 })] }));
  assert.throws(() => new CommercialRegistries({ catalogProviders: [provider(), provider()] }), /Duplicate catalog provider name/);
});

test('policy results are normalized into the bounded contract', () => {
  const label = 'policy';
  assert.deepEqual(
    normalizePolicyResult(label, { decision: 'auto_approve' }),
    { decision: 'auto_approve', reason: null, requiredApprovalKey: null, matchedRule: null },
  );
  assert.equal(normalizePolicyResult(label, { decision: 'reject', reason: 'x'.repeat(600) }).reason.length, 500, 'reasons bounded');
  assert.throws(() => normalizePolicyResult(label, Promise.resolve({ decision: 'auto_approve' })), /synchronously/);
  assert.throws(() => normalizePolicyResult(label, { decision: 'maybe' }), /decision must be one of/);
  assert.throws(() => normalizePolicyResult(label, null), /must return/);
  assert.throws(() => normalizePolicyResult(label, 'auto_approve'), /must return/);
  assert.throws(() => normalizePolicyResult(label, { decision: 'reject', reason: 42 }), /reason must be a non-empty string/);
});

test('registries: fingerprints persist transactionally; config drift stops re-registration', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const registries = new CommercialRegistries({ catalogProviders: [provider()], discountPolicies: [policy()] });
  registries.persistFingerprints(database);
  assert.doesNotThrow(() => registries.persistFingerprints(database), 'idempotent re-registration');
  const rows = database.raw.prepare('SELECT type, name, version FROM definition_versions ORDER BY type').all();
  assert.deepEqual(rows.map((row) => `${row.type}:${row.name}@${row.version}`), ['catalog-provider:fixture-catalog@1', 'discount-policy:discounts@1']);
  // Changing DECLARED CONFIG under the same version is drift.
  const drifted = new CommercialRegistries({ discountPolicies: [policy({ config: { autoApproveMaxBps: 9999 } })] });
  assert.throws(() => drifted.persistFingerprints(database), /source changed after registration/);
  // A new version derived from the old definition registers cleanly (rollback pattern).
  const rollback = new CommercialRegistries({ discountPolicies: [policy(), policy({ version: 3 })] });
  assert.doesNotThrow(() => rollback.persistFingerprints(database));
  // Prototype-name lookups never resolve.
  for (const hostile of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => registries.getCatalogProvider(hostile), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => registries.getDiscountPolicy(hostile, 1), (e) => e.code === 'NOT_FOUND');
  }
  const meta = registries.metadata();
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, 'metadata JSON round-trips');
  assert.match(meta.discountPolicies[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('money and discount arithmetic: safe integers, documented trunc rounding, overflow-checked', () => {
  // Happy path: €25.00 × 3 at 12.34% discount.
  const line = computeLineAmounts({ listUnitAmountCents: 2500, quantity: 3, discountBps: 1234 });
  assert.equal(line.lineSubtotalCents, 7500);
  assert.equal(line.lineDiscountCents, Math.trunc((7500 * 1234) / 10000)); // 925 (925.5 truncated)
  assert.equal(line.lineDiscountCents, 925);
  assert.equal(line.lineTotalCents, 6575, 'lineTotal = subtotal - discount is authoritative');
  assert.equal(line.netUnitAmountCents, Math.trunc((2500 * (10000 - 1234)) / 10000), 'net unit is informational rounding');
  // Zero discount and 100% discount.
  assert.equal(computeLineAmounts({ listUnitAmountCents: 1, quantity: 1, discountBps: 0 }).lineTotalCents, 1);
  assert.equal(computeLineAmounts({ listUnitAmountCents: 999, quantity: 7, discountBps: 10000 }).lineTotalCents, 0);
  // Invalid inputs fail before any arithmetic.
  const bad = [
    [() => computeLineAmounts({ listUnitAmountCents: -1, quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: 1.5, quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: '100', quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: Number.MAX_SAFE_INTEGER + 2, quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: null, quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: [1], quantity: 1, discountBps: 0 }), /non-negative safe integer/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 0, discountBps: 0 }), /between 1 and/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 2.5, discountBps: 0 }), /between 1 and/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 1_000_001, discountBps: 0 }), /between 1 and/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 1, discountBps: -1 }), /between 0 and 10000/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 1, discountBps: 10001 }), /between 0 and 10000/],
    [() => computeLineAmounts({ listUnitAmountCents: 100, quantity: 1, discountBps: 25.5 }), /between 0 and 10000/],
    // Multiplication overflow is a refusal, never a silently wrong number.
    [() => computeLineAmounts({ listUnitAmountCents: Number.MAX_SAFE_INTEGER - 1, quantity: 3, discountBps: 0 }), /overflows/],
  ];
  for (const [fn, pattern] of bad) assert.throws(fn, pattern);
  // Totals: checked sums + effective bps truncation; empty subtotal → 0 bps.
  const totals = computeQuoteTotals([
    { lineSubtotalCents: 7500, lineDiscountCents: 925, lineTotalCents: 6575, discountBps: 1234 },
    { lineSubtotalCents: 1000, lineDiscountCents: 0, lineTotalCents: 1000, discountBps: 0 },
  ]);
  assert.equal(totals.subtotalCents, 8500);
  assert.equal(totals.discountCents, 925);
  assert.equal(totals.totalCents, 7575);
  assert.equal(totals.maxLineDiscountBps, 1234);
  assert.equal(totals.effectiveDiscountBps, Math.trunc((925 * 10000) / 8500));
  assert.equal(computeQuoteTotals([]).effectiveDiscountBps, 0);
  // Currency and scalar validators.
  assert.equal(requireCurrency('EUR'), 'EUR');
  for (const badCurrency of ['eur', 'EU', 'EURO', 'E1R', '€€€', '']) {
    assert.throws(() => requireCurrency(badCurrency), /uppercase three-letter/);
  }
  assert.equal(requireAmount(0, 'x'), 0);
  assert.equal(requireBps(10000, 'x'), 10000);
  assert.equal(requireQuantity(1_000_000, 'x'), 1_000_000);
});
