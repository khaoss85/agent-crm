// @ts-check

import {
  COMMERCIAL_ACTIVATIONS,
  DIMENSIONS,
  OBLIGATION_TYPES,
  OVERRIDABLE_COMMERCIAL,
  defineOrderActivationPolicy,
} from './activation-policy.js';
import { buildContractActions } from './activation.js';
import { MAX_NOTICE_DAYS, MAX_TERM_DAYS, SIGNED_TERMS_NOTE, SIGNED_TERMS_SOURCE, TERMS_NOTE, TERMS_SOURCE } from './dates.js';
import { definePackage } from '../../core/index.js';
import { createDeliveryObligationsCapability } from './capabilities.js';
import { createServiceObligationsCapability } from './service-capability.js';
import { createContractLifecycleSourceCapability } from './lifecycle-capability.js';
import { CLASSIFICATIONS, CONTINUITIES, NOT_MODELED, createSuccessorActivationCapability } from './succession.js';

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
/** The record modules this package owns; declaring them makes a collision detectable. */
export const CONTRACTS_RESOURCES = Object.freeze([
  'commercial-contract', 'contract-version', 'contract-line', 'contract-activation',
  'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
  // M16b (ADR-034): the immutable lineage between one agreement and the
  // successor agreement that replaces it. A record, not a mutation.
  'contract-succession',
]);
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

  return definePackage({
    packageContract: 1,
    name: CONTRACTS_DOMAIN,
    // 4: `contract-lifecycle-source` moved to @2. It now refuses to open while
    // any declared `termsSource` is unclassified, and reports `signed: null`
    // instead of a confident `false` for a source nobody decided about — both
    // observable changes to what a consumer is told, so the version moved.
    // 5: the Signature & Order extraction added the declared
    // `signature/signature-orders@1` requirement. "A package version describes
    // its composition contract, including `requires`, not only its
    // consumer-visible records/actions": the new required edge changes
    // composability (contracts no longer composes without signature), startup
    // behaviour when Signature is absent, AX1's reported graph, and deployment
    // compatibility — so the version moved with it. Records, actions and every
    // offered capability are untouched.
    // 6: signed commercial terms. `termsSource` widens with
    // `signed-order-terms` (manifest revision 2 ×3, classified `true` in
    // TERM_SOURCE_SIGNED), `activate-contract`'s term inputs become
    // conditionally required — refused outright on an order that carries a
    // signed term snapshot (`SIGNED_TERMS_AUTHORITATIVE`) — and the plan
    // reports which provenance applies. Consumer-visible action contract and
    // stored vocabulary both moved, so the version moved.
    // 7: M16b successor activation. One new record (`contract-succession`),
    // one new offered capability (`contracts-successor-activation@1`) and the
    // shared activation writer behind both `order.activate-contract` and a
    // successor execution. Records and offered capabilities both moved, so the
    // composition contract moved. Nothing existing changed shape: every M12
    // record, every M12 action input and all three previously offered
    // capabilities answer byte-identically, which is why none of THEIR versions
    // moved with it.
    version: 7,
    label: 'Contracts and subscriptions',
    description: 'Activates a signed immutable Order into a commercial contract, a subscription and pending delivery/service obligations.',
    resources: [...CONTRACTS_RESOURCES],
    // The actions below target `order` and read its signature evidence — records
    // the Signature & Order package owns since its extraction. The DECLARATION
    // is what changed, not the reads: activation keeps proving the evidence
    // itself through the same trusted managed-module path it always used, and
    // the conformance rail requires the record-level dependency to be declared
    // through a capability of the owning package (DX4).
    requires: [{ package: 'signature', capability: 'signature-orders', version: 1 }],
    // Additive: `delivery-obligations@1` is untouched, and the package now also
    // offers the service half of the same idea to the optional Service package.
    capabilities: [
      createDeliveryObligationsCapability(options.modules),
      createServiceObligationsCapability(options.modules),
      // The two obligation capabilities are untouched. This one offers the
      // term evidence an operational lifecycle package needs — read-only, with
      // provenance attached and its signed state DERIVED from that provenance
      // rather than asserted beside it (M16a).
      createContractLifecycleSourceCapability(options.modules),
      // M16b (ADR-034). The only capability in this package that writes, and
      // it writes exactly one thing: a successor agreement built from a signed
      // immutable Order, plus the immutable lineage row beside it. It mutates
      // no historical record, accepts no client-supplied classification, and
      // refuses an Order whose signed document carried no commercial term.
      createSuccessorActivationCapability(options.modules),
    ],
    actions: buildContractActions(options.modules),
    policies,
    /** Function-free, additive schema metadata — never a handler or a secret. */
    metadata() {
      return {
        contractsContract: 1,

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
          // Provenance, stated in the machine-readable contract itself. The
          // keys below keep describing the OPERATIONAL fallback path — the
          // one that needs human input and a reason — for every reader built
          // against them; `signedTerms` states the other provenance.
          source: TERMS_SOURCE,
          limitation: TERMS_NOTE,
          requiresReason: true,
          // A term that WAS signed: activation copies the order's term
          // snapshot verbatim, refuses manual term inputs, and records this
          // source instead. No reason is collected — the signature is the
          // reason.
          signedTerms: {
            source: SIGNED_TERMS_SOURCE,
            note: SIGNED_TERMS_NOTE,
            requiresReason: false,
            manualInputs: 'refused with 409 SIGNED_TERMS_AUTHORITATIVE when the order carries a signed term snapshot',
          },
        },
        activationState: {
          states: ['scheduled', 'active'],
          rule: 'a contract and its subscription are "active" only when the business date has reached termStartDate; a future term is "scheduled"',
          limitation: 'no scheduler exists: a scheduled contract never becomes active on its own, and nothing in this milestone transitions it',
          endedTerm: 'a term that already ended is refused (TERM_ALREADY_ENDED) rather than recorded',
        },
        source: 'the signed immutable Order is the only commercial source for price, product and party; the live catalog is never read and no amount is recalculated. The term is the one exception and is explicitly NOT signed — see term.source',
        // M16b (ADR-034). Function-free, additive: an older client ignores it.
        succession: {
          successionContract: 1,
          capability: 'contracts-successor-activation@1',
          model:
            'a renewal or amendment produces a SUCCESSOR agreement — its own signed Order, its own document hash, its own term and its own '
            + 'subscription — plus one immutable contract-succession row naming what it replaces. No historical contract, version, line, '
            + 'subscription or obligation row is modified, and the successor is shaped identically to any other activated contract',
          uniqueness:
            'enforced by the database, not by an in-process lock: contract-succession.sourceContractId, .successorContractId and '
            + '.successorOrderId are each UNIQUE, so a contract has at most one successor, at most one predecessor, and a signed Order is '
            + 'consumed at most once',
          signedTermRequired:
            'a successor agreement is built ONLY from an order carrying the signed term snapshot (order-term, covered by the signed '
            + 'documentHash). An order whose signed document carried no term is refused 409 SUCCESSOR_TERMS_NOT_SIGNED: post-signature '
            + 'operational dates are never promoted to signed renewal terms',
          classification: {
            values: [...CLASSIFICATIONS],
            derivation:
              'derived from the immutable line delta and never supplied by a caller. A narrower label is claimed only when the evidence '
              + 'supports exactly one reading; everything else is commercial_change with the same exact per-line delta attached. A price '
              + 'movement with no quantity movement is deliberately commercial_change, not expansion',
          },
          termContinuity: {
            values: [...CONTINUITIES],
            rule:
              'measured against the source term\'s INCLUSIVE end date. contiguous means the successor starts the day after. Overlap and gap '
              + 'are recorded, never refused — a mid-term amendment overlaps and a lapse-then-re-signing gaps. Only a successor term that '
              + 'starts before the source term started is refused (SUCCESSOR_TERM_PRECEDES_SOURCE)',
          },
          humanApproval:
            'executing a successor requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. A human-actor '
            + 'boundary, not Sales/Legal/Finance role enforcement',
          notModeled: [...NOT_MODELED],
        },
        notModeled: [
          'billing', 'invoicing', 'payment', 'usage rating', 'proration', 'tax', 'FX',
          'revenue recognition', 'MRR/ARR/TCV', 'seat changes',
          'automatic or scheduled renewal', 'renewal notice delivery', 'customer notification',
          'cancellation', 'delivery execution', 'service activation', 'entitlements', 'SLA',
        ],
      };
    },
  });
}

export { defineOrderActivationPolicy, COMMERCIAL_ACTIVATIONS, OBLIGATION_TYPES, OVERRIDABLE_COMMERCIAL, DIMENSIONS };
export { buildContractActions } from './activation.js';
export {
  requireTerm, requireCalendarDate, daysBetween, activationState,
  TERMS_SOURCE, TERMS_NOTE, SIGNED_TERMS_SOURCE, SIGNED_TERMS_NOTE, signedTermFromSnapshot,
} from './dates.js';
