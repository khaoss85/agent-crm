// @ts-check

/**
 * Commercial Operations fixtures for the B2B starter (ADR-016): a
 * deterministic catalog provider and versioned discount policies.
 *
 * The provider behaves like an external catalog without needing one — the
 * result derives deterministically from the requested variant, and magic
 * variants exercise the failure paths (outage, hang, invalid data). No
 * network, no credentials, no secrets.
 *
 * The catalog deliberately covers every supported pricing shape:
 *
 *   1. one-time flat fee                (setup)
 *   2. one-time per-unit                (data migration per record)
 *   3. recurring monthly flat fee       (platform fee)
 *   4. recurring annual flat fee        (premium support)
 *   5. recurring per-unit               (API add-on)
 *   6. recurring volume-tiered          (seats — whole quantity at one tier)
 *   7. recurring graduated-tiered       (storage — each band priced)
 *   8. a COMPOSITE offer                (setup + monthly platform + tiered seats)
 *   9. an unsupported metered offer     (quoteEligible: false, never approximated)
 *
 * Provider-model mapping the normalized contract preserves (documented in
 * `docs/COMMERCIAL_OPERATIONS.md`):
 *
 *   Stripe one_time / recurring          → chargeType one_time / recurring
 *   Stripe tiers_mode=volume             → pricingModel volume
 *   Stripe tiers_mode=graduated          → pricingModel graduated
 *   Zuora one-time charge                → chargeType one_time
 *   Zuora recurring charge               → chargeType recurring
 *   Zuora Volume Pricing                 → pricingModel volume
 *   Zuora Tiered/Cumulative Pricing      → pricingModel graduated
 *   Stripe metered / Zuora usage         → unsupported, quoteEligible false
 *
 * `sourcePricingModel` keeps the provider's own model name so provenance is
 * never lost. No real Stripe/Zuora adapter or credential ships here.
 */

const PRICE_BOOK = { sourceKey: 'fixture:pb:standard-eur', name: 'Standard EUR', currency: 'EUR', active: true };

const PRODUCTS = [
  { sourceKey: 'fixture:product:platform', externalId: 'prod_platform', sku: 'PLATFORM', name: 'SaaS Platform', description: 'Core platform subscription.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:seats', externalId: 'prod_seats', sku: 'SEATS', name: 'User Seats', description: 'Named user seats.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:storage', externalId: 'prod_storage', sku: 'STORAGE', name: 'Storage', description: 'Managed storage in GB.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:services', externalId: 'prod_services', sku: 'SERVICES', name: 'Professional Services', description: 'Setup, migration and training.', category: 'services', active: true },
  { sourceKey: 'fixture:product:support', externalId: 'prod_support', sku: 'SUPPORT', name: 'Premium Support', description: 'Annual premium support.', category: 'support', active: true },
  { sourceKey: 'fixture:product:api', externalId: 'prod_api', sku: 'API', name: 'API Add-on', description: 'Per-call API capacity.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:usage', externalId: 'prod_usage', sku: 'USAGE', name: 'Metered Bandwidth', description: 'Usage-billed bandwidth.', category: 'usage', active: true },
];

/** Seat tiers: volume pricing — the reached tier prices the WHOLE quantity. */
const SEAT_TIERS_V1 = [
  { upTo: 20, unitAmountCents: 5000 },
  { upTo: 100, unitAmountCents: 4000 },
  { upTo: null, unitAmountCents: 3000 },
];

/** Storage tiers: graduated — every band is priced independently. */
const STORAGE_TIERS_V1 = [
  { upTo: 100, unitAmountCents: 200 },
  { upTo: 1000, unitAmountCents: 150 },
  { upTo: null, unitAmountCents: 100 },
];

function offers(variant) {
  const seatTiers = variant === 'v2'
    // A tier boundary AND a price move: must create a new immutable revision.
    ? [{ upTo: 25, unitAmountCents: 5500 }, { upTo: 100, unitAmountCents: 4200 }, { upTo: null, unitAmountCents: 3000 }]
    : SEAT_TIERS_V1;
  const platformAmount = variant === 'v2' ? 220_000 : 200_000;
  return [
    {
      sourceKey: 'fixture:offer:setup',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:services',
      name: 'Setup & Migration',
      externalOfferId: 'plan_setup',
      active: true,
      components: [
        { sourceKey: 'setup-fee', label: 'Setup fee', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 500_000, externalPriceId: 'price_setup', sourcePricingModel: 'stripe:one_time.flat' },
        { sourceKey: 'migration-records', label: 'Data migration (per record)', chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 25, externalPriceId: 'price_migration', sourcePricingModel: 'stripe:one_time.per_unit' },
      ],
    },
    {
      sourceKey: 'fixture:offer:platform-monthly',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:platform',
      name: 'Platform — Monthly',
      externalOfferId: 'plan_platform_monthly',
      active: true,
      components: [
        { sourceKey: 'platform-fee', label: 'Platform fee', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, flatAmountCents: platformAmount, externalPriceId: 'price_platform_m', sourcePricingModel: 'stripe:recurring.flat' },
      ],
    },
    {
      sourceKey: 'fixture:offer:support-annual',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:support',
      name: 'Premium Support — Annual',
      externalOfferId: 'plan_support_annual',
      active: true,
      components: [
        { sourceKey: 'support-fee', label: 'Premium support', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'year', intervalCount: 1, flatAmountCents: 1_000_000, externalPriceId: 'price_support_y', sourcePricingModel: 'zuora:recurring.flat' },
      ],
    },
    {
      sourceKey: 'fixture:offer:api-monthly',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:api',
      name: 'API Add-on — Monthly',
      externalOfferId: 'plan_api_monthly',
      active: true,
      components: [
        { sourceKey: 'api-calls', label: 'API capacity (per 1k calls)', chargeType: 'recurring', pricingModel: 'per_unit', interval: 'month', intervalCount: 1, unitAmountCents: 900, externalPriceId: 'price_api_m', sourcePricingModel: 'stripe:recurring.per_unit' },
      ],
    },
    {
      sourceKey: 'fixture:offer:seats-monthly',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:seats',
      name: 'Seats — Monthly (volume)',
      externalOfferId: 'plan_seats_monthly',
      active: true,
      components: [
        { sourceKey: 'seats', label: 'User seats', chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, tiers: seatTiers, externalPriceId: 'price_seats_m', sourcePricingModel: 'stripe:tiers_mode=volume' },
      ],
    },
    {
      sourceKey: 'fixture:offer:storage-monthly',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:storage',
      name: 'Storage — Monthly (graduated)',
      externalOfferId: 'plan_storage_monthly',
      active: true,
      components: [
        { sourceKey: 'storage-gb', label: 'Storage (per GB)', chargeType: 'recurring', pricingModel: 'graduated', interval: 'month', intervalCount: 1, tiers: STORAGE_TIERS_V1, externalPriceId: 'price_storage_m', sourcePricingModel: 'zuora:tiered.cumulative' },
      ],
    },
    {
      // The composite offer the corrected model exists for: one-time setup +
      // recurring monthly platform fee + recurring volume-tiered seats, all in
      // ONE sellable package priced from ONE quote line.
      sourceKey: 'fixture:offer:enterprise',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:platform',
      name: 'Enterprise Plan',
      externalOfferId: 'plan_enterprise',
      active: true,
      components: [
        { sourceKey: 'ent-setup', label: 'Setup and migration', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 500_000, externalPriceId: 'price_ent_setup', sourcePricingModel: 'stripe:one_time.flat' },
        { sourceKey: 'ent-platform', label: 'Platform fee', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, flatAmountCents: 200_000, externalPriceId: 'price_ent_platform', sourcePricingModel: 'stripe:recurring.flat' },
        { sourceKey: 'ent-seats', label: 'Seats', chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, tiers: seatTiers, externalPriceId: 'price_ent_seats', sourcePricingModel: 'stripe:tiers_mode=volume' },
      ],
    },
    {
      // Unsupported provider model: preserved as provenance, never
      // approximated as a flat price, and refused for quoting.
      sourceKey: 'fixture:offer:bandwidth-metered',
      priceBookSourceKey: PRICE_BOOK.sourceKey,
      productSourceKey: 'fixture:product:usage',
      name: 'Metered Bandwidth',
      externalOfferId: 'plan_bandwidth_metered',
      active: true,
      unsupportedReason: 'metered usage billing is not modeled in this milestone (no usage records, no rating)',
      components: [
        { sourceKey: 'bandwidth', label: 'Bandwidth (metered)', unsupportedModel: 'metered_usage', externalPriceId: 'price_bandwidth', sourcePricingModel: 'stripe:recurring.metered' },
      ],
    },
  ];
}

export const fixtureSaasCatalogProvider = {
  name: 'fixture-saas-catalog',
  version: 1,
  label: 'Fixture SaaS catalog (deterministic)',
  config: { source: 'fixture', deactivateMissing: false },
  /** @param {any} input */
  async fetchCatalog(input) {
    const variant = typeof input?.variant === 'string' ? input.variant : 'v1';
    if (variant === 'fail') throw new Error('simulated catalog outage');
    if (variant === 'slow') return new Promise(() => {}); // never settles → timeout path
    if (variant === 'invalid') {
      return { priceBooks: [{ sourceKey: 'fixture:pb:standard-eur', name: 'Bad', currency: 'euros' }], products: [], offers: [] };
    }
    if (variant === 'bad-tiers') {
      return {
        priceBooks: [PRICE_BOOK],
        products: [PRODUCTS[1]],
        offers: [{
          sourceKey: 'fixture:offer:seats-monthly',
          priceBookSourceKey: PRICE_BOOK.sourceKey,
          productSourceKey: 'fixture:product:seats',
          name: 'Seats — broken tiers',
          active: true,
          components: [{
            sourceKey: 'seats', label: 'Seats', chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1,
            tiers: [{ upTo: 100, unitAmountCents: 4000 }, { upTo: 20, unitAmountCents: 5000 }],
          }],
        }],
      };
    }
    return { sourceRef: `fixture:${variant}`, priceBooks: [PRICE_BOOK], products: PRODUCTS, offers: offers(variant) };
  },
};

export const standardSalesDiscountV1 = {
  name: 'standard-sales-discount',
  version: 1,
  label: 'Standard sales discount policy',
  config: { autoApproveMaxBps: 1000, rejectAboveBps: 5000, approvalKey: 'sales-manager' },
  /** @param {any} ctx */
  evaluate({ maxLineDiscountBps, config }) {
    if (maxLineDiscountBps <= config.autoApproveMaxBps) {
      return { decision: 'auto_approve', reason: `max line discount ${maxLineDiscountBps}bps within auto-approve limit ${config.autoApproveMaxBps}bps`, matchedRule: 'auto-approve-threshold' };
    }
    if (maxLineDiscountBps <= config.rejectAboveBps) {
      return {
        decision: 'approval_required',
        reason: `max line discount ${maxLineDiscountBps}bps exceeds auto-approve limit ${config.autoApproveMaxBps}bps`,
        requiredApprovalKey: config.approvalKey,
        matchedRule: 'manager-approval-band',
      };
    }
    return { decision: 'reject', reason: `max line discount ${maxLineDiscountBps}bps exceeds hard limit ${config.rejectAboveBps}bps`, matchedRule: 'hard-reject-threshold' };
  },
};

export const standardSalesDiscountV2 = {
  name: 'standard-sales-discount',
  version: 2,
  label: 'Standard sales discount policy (tighter auto-approve)',
  config: { autoApproveMaxBps: 500, rejectAboveBps: 5000, approvalKey: 'sales-manager' },
  evaluate: standardSalesDiscountV1.evaluate,
};
