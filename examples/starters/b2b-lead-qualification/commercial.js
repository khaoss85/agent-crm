// @ts-check

/**
 * Commercial Operations fixtures for the B2B starter (ADR-016): a
 * deterministic catalog provider and versioned discount policies.
 *
 * The provider behaves like an external catalog without needing one: the
 * result derives deterministically from the requested variant, and magic
 * variants exercise the failure paths (outage, hang, invalid data). No
 * network, no credentials, no secrets. Future provider packages may target
 * Stripe Products/Prices, Zuora, ERP or custom CPQ APIs — none ships here.
 *
 * Discount thresholds live in each policy's DECLARED config (fingerprinted;
 * changing a threshold without publishing a new version stops the boot).
 */

const BASE_PRODUCTS = [
  { sourceKey: 'fixture:product:saas-platform', sku: 'SAAS-PLAT-A', name: 'SaaS Platform — Annual', description: 'Platform subscription, billed annually.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:user-seat', sku: 'SEAT-A', name: 'User Seat — Annual', description: 'Per-seat license, billed annually.', category: 'subscription', active: true },
  { sourceKey: 'fixture:product:onboarding', sku: 'ONB-STD', name: 'Onboarding & Implementation', description: 'One-time guided onboarding package.', category: 'services', active: true },
];

const BASE_ENTRIES = [
  { sourceKey: 'fixture:entry:saas-platform-eur', productSourceKey: 'fixture:product:saas-platform', priceBookSourceKey: 'fixture:pb:standard-eur', unitAmountCents: 1_200_000, currency: 'EUR', pricingMode: 'recurring', recurringInterval: 'year', active: true },
  { sourceKey: 'fixture:entry:user-seat-eur', productSourceKey: 'fixture:product:user-seat', priceBookSourceKey: 'fixture:pb:standard-eur', unitAmountCents: 30_000, currency: 'EUR', pricingMode: 'recurring', recurringInterval: 'year', active: true },
  { sourceKey: 'fixture:entry:onboarding-eur', productSourceKey: 'fixture:product:onboarding', priceBookSourceKey: 'fixture:pb:standard-eur', unitAmountCents: 250_000, currency: 'EUR', pricingMode: 'one_time', recurringInterval: null, active: true },
];

export const fixtureSaasCatalogProvider = {
  name: 'fixture-saas-catalog',
  version: 1,
  label: 'Fixture SaaS catalog (deterministic)',
  config: { source: 'fixture', deactivateMissing: false },
  /** @param {any} input @param {{now: () => string}} _ctx */
  async fetchCatalog(input) {
    const variant = typeof input?.variant === 'string' ? input.variant : 'v1';
    if (variant === 'fail') throw new Error('simulated catalog outage');
    if (variant === 'slow') return new Promise(() => {}); // never settles → timeout path
    if (variant === 'invalid') return { priceBooks: [{ sourceKey: 'fixture:pb:standard-eur', name: 'Bad', currency: 'euros' }], products: [], entries: [] };
    const products = BASE_PRODUCTS.map((product) => ({ ...product }));
    const entries = BASE_ENTRIES.map((entry) => ({ ...entry }));
    if (variant === 'v2') {
      // A price change and a description change: both must create NEW
      // immutable revisions/versions, never rewrite quoted evidence.
      entries[0] = { ...entries[0], unitAmountCents: 1_350_000 };
      products[2] = { ...products[2], description: 'One-time guided onboarding package (updated scope).' };
    }
    return {
      sourceRef: `fixture:${variant}`,
      priceBooks: [
        { sourceKey: 'fixture:pb:standard-eur', name: 'Standard EUR', currency: 'EUR', active: true },
      ],
      products,
      entries,
    };
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
