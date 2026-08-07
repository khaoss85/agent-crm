// @ts-check

import { defineDeliveryCostPolicy } from '../../../packages/delivery/src/index.js';

/**
 * The starter's Delivery Cost Policy (Milestone 14b1).
 *
 * It answers one bounded question — **what does an hour of this kind of work
 * cost, for planning and variance purposes?** — from a category the operator
 * chose and the delivery mode the handover already decided.
 *
 * What it deliberately is not:
 *
 * - **not payroll, and not employee identity.** A contributor reference is an
 *   opaque operational label. Nothing here reads an HR system, claims a salary
 *   or asserts the reference identifies a real person.
 * - **not accounting.** The rate is an operational planning input; it produces
 *   an estimate, never a recognized cost.
 * - **not a costing language.** A lookup and a rate. No expressions, no
 *   conditions, no arithmetic supplied by config — a rule engine over money is
 *   a product, not a policy.
 *
 * Deterministic and synchronous, with no clock, network, database or
 * randomness. The rates live in `config`, so they are inside the
 * declared-definition fingerprint (ADR-015) and cannot be changed without
 * publishing a new version — a rate is versioned as strictly as the code.
 */
export const b2bDeliveryCostV1 = defineDeliveryCostPolicy({
  name: 'b2b-delivery-cost',
  version: 1,
  label: 'B2B delivery cost',
  config: {
    currency: 'EUR',
    // category → rate per hour, in integer minor units of the currency above.
    internal: {
      consulting: 12_000,
      engineering: 14_000,
      'project-management': 10_000,
      training: 9_000,
    },
    partner: {
      consulting: 8_000,
      engineering: 9_500,
      migration: 9_000,
    },
    fallback: 10_000,
  },
  /**
   * @param {{contributorType: string, category: string, currency: string, config: any}} input
   */
  rateFor({ contributorType, category, currency, config }) {
    // The work's currency decides the answer's currency: there is no FX in this
    // framework, so a rate in another currency would be unconvertible.
    if (currency !== config.currency) {
      return { ratePerHourCents: config.fallback, currency, reason: `no ${currency} rate table; the default rate applies` };
    }
    const table = contributorType === 'partner' ? config.partner : config.internal;
    const rate = Object.prototype.hasOwnProperty.call(table, category) ? table[category] : null;
    return rate === null
      ? { ratePerHourCents: config.fallback, currency, reason: `"${category}" is not a mapped ${contributorType} category; the default rate applies` }
      : { ratePerHourCents: rate, currency, reason: `mapped ${contributorType} category "${category}"` };
  },
});
