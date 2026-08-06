// @ts-check

import { definePackage } from '../../core/index.js';
import { buildDeliveryActions } from './handover.js';
import { buildExecutionActions, executionMetadata } from './execution.js';
import { DELIVERY_MODES, OVERRIDABLE_MODES, defineDeliveryHandoverPolicy } from './handover-policy.js';
import { DATES_NOTE, DATES_SOURCE, MAX_PLAN_DAYS } from './dates.js';

/**
 * The Delivery domain package (Milestone 13) — the **second** package built
 * under ADR-018, and the first one that depends on another package.
 *
 * It turns the pending Delivery Obligations the contracts package raised into
 * a planned Delivery Project: one work package per obligation, a milestone
 * plan, and an optional third-party partner engagement.
 *
 * It **plans and records** the handover. It does not execute delivery: nothing
 * starts, progresses, completes, schedules, staffs, costs, bills or grants
 * anyone access.
 *
 * Its only reach into another package is the declared capability
 * `contracts/delivery-obligations@1`. It imports nothing from
 * `packages/contracts/src` and nothing from `packages/core/src`.
 */

export const DELIVERY_PACKAGE = 'delivery';
export const HANDOVER_POLICY_KIND = 'delivery-handover-policy';
/** The record modules this package owns; declaring them makes a collision detectable. */
export const DELIVERY_RESOURCES = Object.freeze([
  'delivery-project', 'delivery-work-package', 'delivery-milestone',
  'delivery-partner-engagement', 'delivery-handover-run',
]);

/**
 * Build the package definition the application registers.
 *
 * @param {{policies?: any[], modules?: Record<string, string>}} [options]
 *   `policies` are delivery handover policy definitions (validated here);
 *   `modules` overrides record-module names for a project that renamed them.
 */
export function createDeliveryPackage(options = {}) {
  const policies = (options.policies ?? []).map((definition) => ({
    kind: HANDOVER_POLICY_KIND,
    definition: defineDeliveryHandoverPolicy(definition),
  }));

  return definePackage({
    packageContract: 1,
    name: DELIVERY_PACKAGE,
    label: 'Delivery handover',
    version: 2,
    description: 'Plans the handover of a signed, activated contract to delivery, and records its execution: a delivery project, work packages, milestones, an optional partner engagement, and bounded human-driven state transitions.',
    // The one declared reach into another package. Without it, this package
    // refuses to register — it cannot invent the obligations it plans.
    requires: [{ package: 'contracts', capability: 'delivery-obligations', version: 1 }],
    resources: [...DELIVERY_RESOURCES],
    actions: [...buildDeliveryActions(options.modules), ...buildExecutionActions(options.modules)],
    policies,
    /** Function-free, additive schema metadata — never a handler or a secret. */
    metadata() {
      return {
        deliveryContract: 1,
        deliveryModes: [...DELIVERY_MODES],
        overridableDeliveryModes: [...OVERRIDABLE_MODES],
        classification: 'who performs the work is an explicit, versioned policy decision from identity the obligation already carries; a mode the policy cannot decide is ambiguous and blocks the handover until a human decides it with a reason',
        humanApproval: 'create-delivery-handover requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED. This is a human-actor boundary, not Delivery Manager role enforcement',
        dates: {
          format: 'YYYY-MM-DD calendar dates; both window dates are supplied together or not at all',
          maxPlanDays: MAX_PLAN_DAYS,
          source: DATES_SOURCE,
          limitation: DATES_NOTE,
        },
        partner: {
          maxPartners: 1,
          model: 'a business reference and a name snapshot, planned against the work packages a partner delivers',
          limitation: 'a partner engagement grants NO access of any kind: no account, no login, no portal, no invitation, no permission, no fee or revenue share, and no SLA. Multiple partners per project are not modelled.',
        },
        source: 'the pending delivery obligations published by the contracts package are the only source; the live catalog, the quote and CRM records are never read',
        execution: executionMetadata(),
        notModeled: [
          'time tracking',
          'expenses', 'cost', 'margin', 'resource scheduling', 'capacity',
          'change requests', 'customer acceptance', 'billing milestones',
          'invoicing', 'partner access', 'partner portal', 'revenue share',
          'service contracts', 'entitlements', 'SLA', 'support cases',
        ],
      };
    },
  });
}

export { defineDeliveryHandoverPolicy, DELIVERY_MODES, OVERRIDABLE_MODES };
export { buildDeliveryActions } from './handover.js';
export { requireDeliveryWindow, requireCalendarDate, daysBetween, DATES_SOURCE, DATES_NOTE } from './dates.js';
