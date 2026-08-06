// @ts-check

import { defineDeliveryHandoverPolicy } from '../../../packages/delivery/src/index.js';

/**
 * The starter's Delivery Handover Policy (Milestone 13).
 *
 * It answers one question per pending delivery obligation — **who performs
 * this work** — from explicit identity the obligation already carries
 * (component key, SKU, product), never from label text. A component it does
 * not recognize is `ambiguous`, which blocks the handover until a human
 * decides with a reason: guessing that a partner will deliver something is a
 * commitment nobody made.
 *
 * It also proposes the work-package label and the milestones the project
 * needs. Those are planning proposals — the customer signed none of them.
 *
 * Deterministic, synchronous, no clock, no network, no database. Mappings live
 * in `config`, so they are inside the declared-definition fingerprint and
 * cannot be edited without publishing a new version.
 */
export const b2bDeliveryHandoverV1 = defineDeliveryHandoverPolicy({
  name: 'b2b-delivery-handover',
  version: 1,
  label: 'B2B delivery handover',
  config: {
    // componentKey → who delivers it, what to call it, and which milestones
    // the project needs because of it.
    componentKeys: {
      'ent-setup': {
        mode: 'internal',
        label: 'Onboarding and setup',
        milestones: ['kickoff', 'delivery', 'go-live'],
      },
      'setup-fee': {
        mode: 'internal',
        label: 'Setup',
        milestones: ['kickoff', 'delivery', 'go-live'],
      },
      // Data migration is the work this business subcontracts.
      'migration-records': {
        mode: 'partner',
        label: 'Data migration',
        milestones: ['kickoff', 'delivery'],
      },
    },
    // SKU fallback, so a new component inside a known product family still
    // classifies deterministically.
    skus: {
      SERVICES: { mode: 'internal', label: 'Professional services', milestones: ['kickoff', 'delivery'] },
    },
  },

  /** @param {any} context */
  planObligation({ obligation, config }) {
    // The obligation carries the offer-qualified component key
    // (`fixture:offer:enterprise:1:ent-setup`); the stable part a policy maps
    // is the final segment, which is the provider's own key.
    const key = String(obligation.componentKey).split(':').pop();
    const mapped = Object.prototype.hasOwnProperty.call(config.componentKeys, key)
      ? config.componentKeys[key]
      : Object.prototype.hasOwnProperty.call(config.skus, obligation.sku)
        ? config.skus[obligation.sku]
        : null;
    if (mapped) {
      return {
        deliveryMode: mapped.mode,
        workPackageLabel: mapped.label,
        milestoneKeys: mapped.milestones,
        reason: `component "${key}" is delivered ${mapped.mode === 'partner' ? 'by a partner' : 'internally'}`,
      };
    }
    // Deliberately not a guess: an unmapped obligation goes to a human.
    return {
      deliveryMode: 'ambiguous',
      workPackageLabel: obligation.label ?? key,
      milestoneKeys: ['kickoff', 'delivery'],
      reason: `component "${key}" (SKU "${obligation.sku}") is not mapped by this policy version`,
    };
  },
});
