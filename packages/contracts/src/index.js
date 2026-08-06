// @ts-check

import {
  COMMERCIAL_ACTIVATIONS,
  DIMENSIONS,
  OBLIGATION_TYPES,
  OVERRIDABLE_COMMERCIAL,
  defineOrderActivationPolicy,
} from './activation-policy.js';
import { buildContractActions } from './activation.js';
import { MAX_NOTICE_DAYS, MAX_TERM_DAYS, TERMS_NOTE, TERMS_SOURCE } from './dates.js';

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
        classification: {
          dimensions: [...DIMENSIONS],
          commercialActivation: [...COMMERCIAL_ACTIVATIONS],
          overridableCommercialActivation: [...OVERRIDABLE_COMMERCIAL],
          obligations: [...OBLIGATION_TYPES],
          note: 'Two independent axes: what the money is (subscription or not) and what is owed beyond it (delivery, service, or nothing). Annual support is both a subscription line and a service obligation, so one exclusive axis would lose a real commitment. Recurrence alone never decides either axis, and an ambiguous axis blocks activation until a human resolves that axis with a reason.',
        },
        humanApproval: 'activate-contract requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. This is a human-actor boundary, not Sales/Legal/Finance role enforcement',
        term: {
          format: 'YYYY-MM-DD calendar dates; termEndDate is inclusive',
          maxTermDays: MAX_TERM_DAYS,
          maxRenewalNoticeDays: MAX_NOTICE_DAYS,
          renewalNotice: 'recorded only — no scheduler exists, so nothing fires on it; a notice period requires autoRenew',
          // Provenance, stated in the machine-readable contract itself.
          source: TERMS_SOURCE,
          limitation: TERMS_NOTE,
          requiresReason: true,
        },
        activationState: {
          states: ['scheduled', 'active'],
          rule: 'a contract and its subscription are "active" only when the business date has reached termStartDate; a future term is "scheduled"',
          limitation: 'no scheduler exists: a scheduled contract never becomes active on its own, and nothing in this milestone transitions it',
          endedTerm: 'a term that already ended is refused (TERM_ALREADY_ENDED) rather than recorded',
        },
        source: 'the signed immutable Order is the only commercial source for price, product and party; the live catalog is never read and no amount is recalculated. The term is the one exception and is explicitly NOT signed — see term.source',
        notModeled: [
          'billing', 'invoicing', 'payment', 'usage rating', 'proration', 'tax', 'FX',
          'revenue recognition', 'MRR/ARR/TCV', 'amendments', 'seat changes', 'renewal',
          'cancellation', 'delivery execution', 'service activation', 'entitlements', 'SLA',
        ],
      };
    },
  };
}

export { defineOrderActivationPolicy, COMMERCIAL_ACTIVATIONS, OBLIGATION_TYPES, OVERRIDABLE_COMMERCIAL, DIMENSIONS };
export { buildContractActions } from './activation.js';
export { requireTerm, requireCalendarDate, daysBetween, activationState, TERMS_SOURCE, TERMS_NOTE } from './dates.js';
