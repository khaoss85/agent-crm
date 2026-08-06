// @ts-check

import { defineOrderActivationPolicy } from '../../../packages/contracts/src/index.js';

/**
 * The starter's Order Activation Policy (Milestone 12).
 *
 * It decides what each signed order component becomes — and it decides from
 * **explicit identity present in the Order snapshot** (component key, SKU,
 * offer key), never from recurrence and never from free text. A component it
 * does not recognize is `ambiguous`, which blocks activation until a human
 * classifies it with a reason: guessing would silently file real money in the
 * wrong place.
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
    // componentKey → classification. Explicit, auditable, versioned.
    componentKeys: {
      'ent-platform': 'subscription',
      'ent-seats': 'subscription',
      'ent-setup': 'delivery',
      'platform-fee': 'subscription',
      seats: 'subscription',
      'api-calls': 'other',
      'setup-fee': 'delivery',
      'migration-records': 'delivery',
      'support-fee': 'service',
    },
    // SKU fallback when the component key is not mapped, so a new component
    // inside a known product family still classifies deterministically.
    skus: {
      SERVICES: 'delivery',
      SUPPORT: 'service',
    },
  },

  /** @param {any} context */
  classifyComponent({ component, line, config }) {
    // The Order snapshot qualifies a component key with its offer and
    // revision (`fixture:offer:enterprise:1:ent-seats`); the stable part a
    // policy maps is the final segment, which is the provider's own key.
    const key = String(component.componentKey).split(':').pop();
    const byKey = Object.prototype.hasOwnProperty.call(config.componentKeys, key)
      ? config.componentKeys[key]
      : null;
    if (byKey) {
      return { type: byKey, reason: `component "${key}" is mapped to ${byKey}` };
    }
    const bySku = Object.prototype.hasOwnProperty.call(config.skus, line.sku)
      ? config.skus[line.sku]
      : null;
    if (bySku) {
      return { type: bySku, reason: `SKU "${line.sku}" is mapped to ${bySku}` };
    }
    // Deliberately not a guess: an unmapped component is escalated to a human.
    return {
      type: 'ambiguous',
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
    componentKeys: { ...b2bSaasOrderActivationV1.config.componentKeys, 'storage-gb': 'subscription' },
    skus: { ...b2bSaasOrderActivationV1.config.skus, STORAGE: 'subscription' },
  },
});
