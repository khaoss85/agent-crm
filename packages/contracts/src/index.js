// @ts-check

import { defineOrderActivationPolicy, CLASSIFICATION_TYPES, OVERRIDABLE_TYPES } from './activation-policy.js';
import { buildContractActions } from './activation.js';
import { MAX_NOTICE_DAYS, MAX_TERM_DAYS } from './dates.js';

/**
 * The Contracts domain package (Milestone 12) — the first domain built under
 * ADR-018 outside `packages/core`.
 *
 * It owns every Contract / Subscription / Obligation concept: its records
 * (starter-applied manifests under `packages/contracts/modules/`), its
 * versioned activation policy and its two actions. It depends on the kernel's
 * generic contracts — the module factory, the action runtime, managed writes,
 * the domain registry — and **the kernel never imports it**. Removing the one
 * static import in `packages/domains/generated/index.js` removes the domain,
 * and everything else keeps working.
 *
 * What this package does NOT do, deliberately: billing, invoicing, payment,
 * usage rating, proration, tax, FX, revenue recognition, MRR/ARR/TCV,
 * amendments, seat changes, renewal, cancellation, delivery execution,
 * partner assignment, service contracts, entitlements or SLA.
 */

export const CONTRACTS_DOMAIN = 'contracts';
export const ACTIVATION_POLICY_KIND = 'order-activation-policy';

/**
 * Build the domain definition the application registers.
 *
 * @param {{policies?: any[], modules?: Record<string, string>}} [options]
 *   `policies` are order-activation policy definitions (validated here);
 *   `modules` overrides record-module names for a project that renamed them.
 */
export function createContractsDomain(options = {}) {
  const policies = (options.policies ?? []).map((definition) => ({
    kind: ACTIVATION_POLICY_KIND,
    definition: defineOrderActivationPolicy(definition),
  }));

  return {
    name: CONTRACTS_DOMAIN,
    domainContract: 1,
    label: 'Contracts and subscriptions',
    actions: buildContractActions(options.modules),
    policies,
    /** Function-free, additive schema metadata — never a handler or a secret. */
    metadata() {
      return {
        contractsContract: 1,
        resources: [
          'commercial-contract', 'contract-version', 'contract-line', 'contract-activation',
          'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
        ],
        classificationTypes: [...CLASSIFICATION_TYPES],
        overridableTypes: [...OVERRIDABLE_TYPES],
        classification: 'explicit and versioned: recurrence alone never determines an obligation, and an ambiguous component blocks activation until a human overrides it with a reason',
        humanApproval: 'activate-contract requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. This is a human-actor boundary, not Sales/Legal/Finance role enforcement',
        term: {
          format: 'YYYY-MM-DD calendar dates; termEndDate is inclusive',
          maxTermDays: MAX_TERM_DAYS,
          maxRenewalNoticeDays: MAX_NOTICE_DAYS,
          renewalNotice: 'recorded only — no scheduler exists, so nothing fires on it',
        },
        source: 'the signed immutable Order is the only commercial source; the live catalog is never read and no amount is recalculated',
        notModeled: [
          'billing', 'invoicing', 'payment', 'usage rating', 'proration', 'tax', 'FX',
          'revenue recognition', 'MRR/ARR/TCV', 'amendments', 'seat changes', 'renewal',
          'cancellation', 'delivery execution', 'service activation', 'entitlements', 'SLA',
        ],
      };
    },
  };
}

export { defineOrderActivationPolicy, CLASSIFICATION_TYPES, OVERRIDABLE_TYPES };
export { buildContractActions } from './activation.js';
export { requireTerm, requireCalendarDate, daysBetween } from './dates.js';
