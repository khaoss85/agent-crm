// @ts-check

import { defineOrderActivationPolicy } from '../../../packages/contracts/src/index.js';

/**
 * The starter's Order Activation Policy (Milestone 12).
 *
 * It answers **two** questions about each signed order component, from
 * **explicit identity present in the Order snapshot** (component key, SKU,
 * offer key) — never from recurrence and never from free text:
 *
 *   1. `commercialActivation` — is this a recurring right (a Subscription
 *      Line) or not?
 *   2. `obligations` — does it also owe delivery work or future service?
 *
 * Annual premium support is why both exist: it is a recurring commercial
 * commitment **and** a service obligation, and an exclusive single answer
 * would drop one of them. A component the policy does not recognize is
 * `ambiguous` on the axis it cannot decide, which blocks activation until a
 * human classifies it with a reason: guessing would silently file real money
 * in the wrong place.
 *
 * Deterministic, synchronous, no clock, no network, no database. Thresholds
 * and mappings live in `config`, so they are inside the declared-definition
 * fingerprint and cannot be edited without publishing a new version.
 */
export const b2bSaasOrderActivationV1 = defineOrderActivationPolicy({
  name: 'b2b-saas-order-activation',
  version: 1,
  label: 'B2B SaaS order activation',
  config: {
    // componentKey → {commercial, obligations}. Explicit, auditable, versioned.
    componentKeys: {
      'ent-platform': { commercial: 'subscription', obligations: [] },
      'ent-seats': { commercial: 'subscription', obligations: [] },
      'ent-setup': { commercial: 'non_subscription', obligations: ['delivery'] },
      'platform-fee': { commercial: 'subscription', obligations: [] },
      seats: { commercial: 'subscription', obligations: [] },
      // Metered capacity is billed elsewhere and owes nothing further: a
      // recurring charge is NOT automatically a recurring right.
      'api-calls': { commercial: 'non_subscription', obligations: [] },
      'setup-fee': { commercial: 'non_subscription', obligations: ['delivery'] },
      'migration-records': { commercial: 'non_subscription', obligations: ['delivery'] },
      // The two-axis case: a recurring commitment that also owes service.
      'support-fee': { commercial: 'subscription', obligations: ['service'] },
      // A recurring managed-implementation package: recurring money AND
      // continuing delivery work.
      'managed-implementation': { commercial: 'subscription', obligations: ['delivery'] },
    },
    // SKU fallback when the component key is not mapped, so a new component
    // inside a known product family still classifies deterministically.
    skus: {
      SERVICES: { commercial: 'non_subscription', obligations: ['delivery'] },
      SUPPORT: { commercial: 'subscription', obligations: ['service'] },
    },
  },

  /** @param {any} context */
  classifyComponent({ component, line, config }) {
    // The Order snapshot qualifies a component key with its offer and
    // revision (`fixture:offer:enterprise:1:ent-seats`); the stable part a
    // policy maps is the final segment, which is the provider's own key.
    const key = String(component.componentKey).split(':').pop();
    const mapped = Object.prototype.hasOwnProperty.call(config.componentKeys, key)
      ? config.componentKeys[key]
      : Object.prototype.hasOwnProperty.call(config.skus, line.sku)
        ? config.skus[line.sku]
        : null;
    if (mapped) {
      const owed = mapped.obligations.length > 0
        ? `and owes ${mapped.obligations.join(' and ')}`
        : 'and owes nothing further';
      return {
        commercialActivation: mapped.commercial,
        obligations: mapped.obligations,
        reason: `component "${key}" is mapped to ${mapped.commercial} ${owed}`,
      };
    }
    // Deliberately not a guess: an unmapped component is escalated to a human
    // on both axes at once.
    return {
      commercialActivation: 'ambiguous',
      obligations: 'ambiguous',
      reason: `component "${key}" (SKU "${line.sku}") is not mapped by this policy version`,
    };
  },
});

/**
 * v2 exists to prove that publishing a new version is the way to change a
 * decision: it additionally maps storage, which v1 escalates as ambiguous.
 * v1 is never edited — a historical activation stays explainable.
 */
export const b2bSaasOrderActivationV2 = defineOrderActivationPolicy({
  ...b2bSaasOrderActivationV1,
  version: 2,
  label: 'B2B SaaS order activation (storage mapped)',
  config: {
    componentKeys: {
      ...b2bSaasOrderActivationV1.config.componentKeys,
      'storage-gb': { commercial: 'subscription', obligations: [] },
    },
    skus: {
      ...b2bSaasOrderActivationV1.config.skus,
      STORAGE: { commercial: 'subscription', obligations: [] },
    },
  },
});
