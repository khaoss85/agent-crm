import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommercialRegistries,
  validateCatalogProvider,
  validateDiscountPolicy,
  normalizePolicyResult,
} from '../packages/commercial/src/registry.js';
import {
  computeComponentAmount,
  computeLineBreakdown,
  groupComponentTotals,
  effectiveDiscountBps,
  applyDiscount,
  validateTierSchedule,
  validatePriceComponent,
  requireAmount,
  requireBps,
  requireQuantity,
  requireCurrency,
} from '../packages/commercial/src/money.js';
import { createDatabase } from '../packages/core/src/database.js';

function provider(overrides = {}) {
  return {
    name: 'fixture-catalog',
    version: 1,
    label: 'Fixture',
    config: { source: 'fixture' },
    async fetchCatalog() { return { priceBooks: [], products: [], offers: [] }; },
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

const VOLUME_TIERS = [
  { upTo: 10, unitAmountCents: 1000 },
  { upTo: 100, unitAmountCents: 800 },
  { upTo: null, unitAmountCents: 500 },
];

test('commercial definitions validate and fail closed with precise reasons', () => {
  assert.doesNotThrow(() => validateCatalogProvider(provider()));
  assert.doesNotThrow(() => validateDiscountPolicy(policy()));
  const cases = [
    [() => validateCatalogProvider(provider({ name: '__proto__' })), /name must match/],
    [() => validateCatalogProvider(provider({ version: 0 })), /positive integer/],
    [() => validateCatalogProvider(provider({ fetchCatalog: undefined })), /fetchCatalog must be a function/],
    [() => validateCatalogProvider(provider({ config: { when: new Date(0) } })), /config must be plain JSON-safe data/],
    [() => validateDiscountPolicy(policy({ evaluate: 'nope' })), /evaluate must be a function/],
    [() => validateDiscountPolicy(policy({ config: [1] })), /config must be a plain object/],
  ];
  for (const [fn, pattern] of cases) assert.throws(fn, pattern);
  assert.throws(() => new CommercialRegistries({ discountPolicies: [policy(), policy()] }), /Duplicate discount policy identity/);
  assert.doesNotThrow(() => new CommercialRegistries({ discountPolicies: [policy(), policy({ version: 2 })] }));
});

test('policy results are normalized into the bounded contract', () => {
  const label = 'policy';
  assert.deepEqual(
    normalizePolicyResult(label, { decision: 'auto_approve' }),
    { decision: 'auto_approve', reason: null, requiredApprovalKey: null, matchedRule: null },
  );
  assert.equal(normalizePolicyResult(label, { decision: 'reject', reason: 'x'.repeat(600) }).reason.length, 500);
  assert.throws(() => normalizePolicyResult(label, Promise.resolve({ decision: 'auto_approve' })), /synchronously/);
  assert.throws(() => normalizePolicyResult(label, { decision: 'maybe' }), /decision must be one of/);
  assert.throws(() => normalizePolicyResult(label, null), /must return/);
});

test('registries: fingerprints persist transactionally; config drift stops re-registration', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const registries = new CommercialRegistries({ catalogProviders: [provider()], discountPolicies: [policy()] });
  registries.persistFingerprints(database);
  assert.doesNotThrow(() => registries.persistFingerprints(database));
  const drifted = new CommercialRegistries({ discountPolicies: [policy({ config: { autoApproveMaxBps: 9999 } })] });
  assert.throws(() => drifted.persistFingerprints(database), /source changed after registration/);
  const rollback = new CommercialRegistries({ discountPolicies: [policy(), policy({ version: 3 })] });
  assert.doesNotThrow(() => rollback.persistFingerprints(database));
  for (const hostile of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => registries.getCatalogProvider(hostile), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => registries.getDiscountPolicy(hostile, 1), (e) => e.code === 'NOT_FOUND');
  }
  const meta = registries.metadata();
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, 'metadata JSON round-trips');
  assert.deepEqual(meta.chargeTypes, ['one_time', 'recurring']);
  assert.deepEqual(meta.pricingModels, ['flat_fee', 'per_unit', 'volume', 'graduated']);
  assert.match(meta.discountPolicies[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('tier schedules validate: ordered, gap-free, exactly one open-ended last tier', () => {
  const ok = validateTierSchedule(VOLUME_TIERS, 'seats');
  assert.deepEqual(ok.map((tier) => tier.upTo), [10, 100, null]);
  assert.equal(ok[0].flatAmountCents, 0, 'flat amounts default to zero explicitly');
  const bad = [
    [[], /non-empty tier schedule/],
    [[{ upTo: 10, unitAmountCents: 100 }], /last tier must be open-ended/],
    [[{ upTo: null, unitAmountCents: 100 }, { upTo: 20, unitAmountCents: 90 }], /open-ended tier \(upTo null\) must be last/],
    [[{ upTo: null, unitAmountCents: 1 }, { upTo: null, unitAmountCents: 2 }], /open-ended tier \(upTo null\) must be last/],
    [[{ upTo: 100, unitAmountCents: 1 }, { upTo: 20, unitAmountCents: 2 }, { upTo: null, unitAmountCents: 3 }], /boundaries must strictly increase/],
    [[{ upTo: 20, unitAmountCents: 1 }, { upTo: 20, unitAmountCents: 2 }, { upTo: null, unitAmountCents: 3 }], /boundaries must strictly increase/],
    [[{ upTo: 0, unitAmountCents: 1 }, { upTo: null, unitAmountCents: 2 }], /must be a positive integer/],
    [[{ upTo: 1.5, unitAmountCents: 1 }, { upTo: null, unitAmountCents: 2 }], /must be a positive integer/],
    [[{ upTo: 10, unitAmountCents: -5 }, { upTo: null, unitAmountCents: 2 }], /non-negative safe integer/],
    [[{ upTo: 10, unitAmountCents: 1.5 }, { upTo: null, unitAmountCents: 2 }], /non-negative safe integer/],
    [[{ upTo: 10, unitAmountCents: '100' }, { upTo: null, unitAmountCents: 2 }], /non-negative safe integer/],
    [Array.from({ length: 51 }, (_, i) => ({ upTo: i + 1, unitAmountCents: 1 })), /at most 50 tiers/],
  ];
  for (const [tiers, pattern] of bad) assert.throws(() => validateTierSchedule(tiers, 'seats'), pattern);
});

test('price components reject incoherent charge/model/interval combinations', () => {
  const base = { chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, flatAmountCents: 1000 };
  assert.doesNotThrow(() => validatePriceComponent(base, 'c'));
  assert.doesNotThrow(() => validatePriceComponent({ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 500 }, 'c'));
  const bad = [
    [{ ...base, chargeType: 'usage' }, /chargeType must be one of/],
    [{ ...base, pricingModel: 'metered' }, /pricingModel must be one of/],
    [{ ...base, interval: 'week' }, /recurring components need interval/],
    [{ ...base, interval: null }, /recurring components need interval/],
    [{ ...base, intervalCount: 0 }, /intervalCount between 1 and/],
    [{ ...base, intervalCount: 999 }, /intervalCount between 1 and/],
    [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 1, interval: 'month' }, /must not declare interval/],
    [{ ...base, tiers: [{ upTo: null, unitAmountCents: 1 }] }, /only volume and graduated components may declare tiers/],
    [{ chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1 }, /need a non-empty tier schedule/],
    [{ chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, tiers: VOLUME_TIERS, unitAmountCents: 100 }, /carry their amounts in tiers/],
    [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 100, flatAmountCents: 50 }, /flatAmountCents is not supported/],
    [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100, unitAmountCents: 50 }, /unitAmountCents is not supported/],
    [{ chargeType: 'one_time', pricingModel: 'per_unit' }, /unitAmountCents/],
  ];
  for (const [component, pattern] of bad) assert.throws(() => validatePriceComponent(component, 'c'), pattern);
});

test('flat_fee is charged once; per_unit multiplies by quantity', () => {
  const flat = computeComponentAmount({ pricingModel: 'flat_fee', flatAmountCents: 500_000, tiers: [] }, 40);
  assert.equal(flat.listAmountCents, 500_000, 'line quantity never multiplies a flat fee');
  assert.equal(flat.quantityPriced, 0);
  assert.deepEqual(flat.tierBreakdown, []);
  const perUnit = computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: 2500, tiers: [] }, 40);
  assert.equal(perUnit.listAmountCents, 100_000);
  assert.equal(perUnit.quantityPriced, 40);
});

test('volume pricing applies the reached tier to the whole quantity, at every boundary', () => {
  const tiers = validateTierSchedule(VOLUME_TIERS, 'seats');
  const at = (quantity) => computeComponentAmount({ pricingModel: 'volume', tiers }, quantity);
  assert.equal(at(1).listAmountCents, 1 * 1000, 'first unit uses tier 1');
  assert.equal(at(10).listAmountCents, 10 * 1000, 'exactly at the tier-1 boundary');
  assert.equal(at(11).listAmountCents, 11 * 800, 'one past the boundary moves the WHOLE quantity to tier 2');
  assert.equal(at(20).listAmountCents, 20 * 800);
  assert.equal(at(100).listAmountCents, 100 * 800, 'exactly at the tier-2 boundary');
  assert.equal(at(101).listAmountCents, 101 * 500, 'open-ended tier prices everything');
  const breakdown = at(20).tierBreakdown;
  assert.equal(breakdown.length, 1, 'volume yields exactly one band');
  assert.deepEqual(
    { position: breakdown[0].position, quantity: breakdown[0].quantity, unitAmountCents: breakdown[0].unitAmountCents },
    { position: 2, quantity: 20, unitAmountCents: 800 },
  );
  // A tier flatAmount is added once to the whole component.
  const withFlat = computeComponentAmount({
    pricingModel: 'volume',
    tiers: validateTierSchedule([{ upTo: 10, unitAmountCents: 100, flatAmountCents: 5000 }, { upTo: null, unitAmountCents: 80, flatAmountCents: 9000 }], 'f'),
  }, 20);
  assert.equal(withFlat.listAmountCents, 20 * 80 + 9000, 'the reached tier flat amount is added once');
});

test('graduated pricing prices each band independently, at every boundary', () => {
  const tiers = validateTierSchedule(VOLUME_TIERS, 'storage');
  const at = (quantity) => computeComponentAmount({ pricingModel: 'graduated', tiers }, quantity);
  assert.equal(at(1).listAmountCents, 1 * 1000);
  assert.equal(at(10).listAmountCents, 10 * 1000);
  assert.equal(at(11).listAmountCents, 10 * 1000 + 1 * 800, 'only the eleventh unit reaches tier 2');
  assert.equal(at(20).listAmountCents, 10 * 1000 + 10 * 800);
  assert.equal(at(100).listAmountCents, 10 * 1000 + 90 * 800);
  assert.equal(at(150).listAmountCents, 10 * 1000 + 90 * 800 + 50 * 500);
  const bands = at(150).tierBreakdown;
  assert.deepEqual(bands.map((band) => [band.position, band.from, band.quantity]), [[1, 1, 10], [2, 11, 90], [3, 101, 50]]);
  assert.equal(bands.reduce((sum, band) => sum + band.amountCents, 0), at(150).listAmountCents, 'bands sum to the total');
  // Each band that receives quantity adds its own flat amount once.
  const withFlat = computeComponentAmount({
    pricingModel: 'graduated',
    tiers: validateTierSchedule([{ upTo: 10, unitAmountCents: 100, flatAmountCents: 1000 }, { upTo: null, unitAmountCents: 80, flatAmountCents: 2000 }], 'f'),
  }, 15);
  assert.equal(withFlat.listAmountCents, (10 * 100 + 1000) + (5 * 80 + 2000));
});

test('a line prices every component of a composite offer and applies its discount uniformly', () => {
  const components = [
    { id: 'c1', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 500_000, tiers: [] },
    { id: 'c2', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, flatAmountCents: 200_000, tiers: [] },
    { id: 'c3', chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, tiers: validateTierSchedule(VOLUME_TIERS, 'seats') },
  ];
  const breakdown = computeLineBreakdown({ components, quantity: 20, discountBps: 1000 });
  assert.equal(breakdown.components.length, 3);
  assert.equal(breakdown.components[0].listAmountCents, 500_000, 'flat fee is not multiplied by 20');
  assert.equal(breakdown.components[2].listAmountCents, 20 * 800);
  // Discount is applied per component, after tier calculation, truncating.
  assert.equal(breakdown.components[0].discountAmountCents, 50_000);
  assert.equal(breakdown.components[2].netAmountCents, 16_000 - 1600);
  assert.equal(breakdown.listAmountCents, 500_000 + 200_000 + 16_000);
  assert.equal(breakdown.netAmountCents, breakdown.listAmountCents - breakdown.discountAmountCents);

  // Grouped totals: one-time, monthly and annual never merge.
  const annual = { id: 'c4', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'year', intervalCount: 1, flatAmountCents: 1_000_000, tiers: [] };
  const full = computeLineBreakdown({ components: [...components, annual], quantity: 20, discountBps: 0 });
  const totals = groupComponentTotals(full.components, 'EUR');
  assert.equal(totals.oneTimeTotal.netAmountCents, 500_000);
  assert.deepEqual(totals.recurringTotals.map((group) => [group.interval, group.netAmountCents]), [['month', 216_000], ['year', 1_000_000]]);
  assert.equal(totals.recurringTotals.length, 2, 'no single grand total is produced');
  assert.equal(effectiveDiscountBps(totals), 0);
});

test('money arithmetic is safe-integer only and overflow-checked', () => {
  assert.deepEqual(applyDiscount(7500, 1234), { listAmountCents: 7500, discountAmountCents: 925, netAmountCents: 6575 });
  assert.equal(applyDiscount(999, 10000).netAmountCents, 0);
  assert.equal(applyDiscount(0, 5000).discountAmountCents, 0);
  const bad = [
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: -1, tiers: [] }, 1), /non-negative safe integer/],
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: 1.5, tiers: [] }, 1), /non-negative safe integer/],
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: '100', tiers: [] }, 1), /non-negative safe integer/],
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: 100, tiers: [] }, 0), /between 1 and/],
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: 100, tiers: [] }, 1_000_001), /between 1 and/],
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: 100, tiers: [] }, 2.5), /between 1 and/],
    // Overflow across quantity × unit and across grouped sums.
    [() => computeComponentAmount({ pricingModel: 'per_unit', unitAmountCents: Number.MAX_SAFE_INTEGER - 1, tiers: [] }, 1000), /overflows/],
    [() => applyDiscount(Number.MAX_SAFE_INTEGER, 10000), /overflows/],
    [() => groupComponentTotals([
      { chargeType: 'one_time', listAmountCents: Number.MAX_SAFE_INTEGER, discountAmountCents: 0, netAmountCents: Number.MAX_SAFE_INTEGER },
      { chargeType: 'one_time', listAmountCents: Number.MAX_SAFE_INTEGER, discountAmountCents: 0, netAmountCents: Number.MAX_SAFE_INTEGER },
    ], 'EUR'), /overflows/],
    [() => requireBps(10001, 'bps'), /between 0 and 10000/],
    [() => requireCurrency('eur'), /uppercase three-letter/],
  ];
  for (const [fn, pattern] of bad) assert.throws(fn, pattern);
  assert.equal(requireAmount(0, 'x'), 0);
  assert.equal(requireQuantity(1_000_000, 'x'), 1_000_000);
});
