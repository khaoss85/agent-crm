// @ts-check

import { definePackage } from '../../core/index.js';
import { buildDeliveryActions } from './handover.js';
import { buildExecutionActions, executionMetadata } from './execution.js';
import {
  buildEconomicsActions, createEconomicsCapability, economicsMetadata,
} from './economics-actions.js';
import { COST_POLICY_KIND, defineDeliveryCostPolicy } from './cost-policy.js';
import { DELIVERY_MODES, OVERRIDABLE_MODES, defineDeliveryHandoverPolicy } from './handover-policy.js';
import { DATES_NOTE, DATES_SOURCE, MAX_PLAN_DAYS } from './dates.js';

/**
 * The Delivery domain package — the **second** package built under ADR-018, and
 * the first one that depends on another package.
 *
 * M13 turns the pending Delivery Obligations the contracts package raised into
 * a planned Delivery Project: one work package per obligation, a milestone
 * plan, and an optional third-party partner engagement. M14a lets a human
 * **run** that project: bounded, human-driven state transitions over an
 * explicit table, with the block that stopped work stated as evidence.
 *
 * It plans and records. Nothing here schedules, staffs, costs, bills, accepts
 * or grants anyone access, and nothing moves on a clock.
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
  // M14b1: the immutable economics evidence.
  'delivery-time-entry', 'delivery-expense-entry',
  'delivery-economic-plan', 'delivery-economic-plan-line', 'delivery-economic-snapshot',
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
  // Cost policies are a separate kind with their own contract: a handover
  // policy decides who delivers, a cost policy decides what an hour costs, and
  // conflating them would version two unrelated decisions together.
  const costPolicies = (options.costPolicies ?? []).map((definition) => ({
    kind: COST_POLICY_KIND,
    definition: defineDeliveryCostPolicy(definition),
  }));

  return definePackage({
    packageContract: 1,
    name: DELIVERY_PACKAGE,
    label: 'Delivery handover',
    version: 3,
    description: 'Plans the handover of a signed, activated contract to delivery, records its execution through bounded human-driven transitions, and records what it consumed: immutable time and expense evidence, a versioned cost plan and a reproducible contribution estimate.',
    // The one declared reach into another package. Without it, this package
    // refuses to register — it cannot invent the obligations it plans.
    requires: [{ package: 'contracts', capability: 'delivery-obligations', version: 1 }],
    // Additive: `delivery-obligations@1` stays exactly as it was, and this
    // package now also offers what it learned while running the work.
    capabilities: [createEconomicsCapability({ modules: options.modules })],
    resources: [...DELIVERY_RESOURCES],
    actions: [
      ...buildDeliveryActions(options.modules),
      ...buildExecutionActions(options.modules),
      ...buildEconomicsActions({ modules: options.modules, costPolicies }),
    ],
    policies: [...policies, ...costPolicies],
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
        economics: economicsMetadata(costPolicies),
        notModeled: [
          'resource scheduling', 'capacity',
          'billing milestones',
          'invoicing', 'partner access', 'partner portal', 'revenue share',
          'service contracts', 'entitlements', 'SLA', 'support cases',
          'deliverables', 'reopening completed work', 'a scheduler',
          'change requests', 'customer acceptance',
        ],
      };
    },
  });
}

export { defineDeliveryHandoverPolicy, DELIVERY_MODES, OVERRIDABLE_MODES };
export { defineDeliveryCostPolicy, COST_POLICY_KIND } from './cost-policy.js';
export { ECONOMICS_CAPABILITY, PLAN_LINE_KINDS, CONTRIBUTOR_TYPES } from './economics-actions.js';
export {
  ROUNDING_RULE, ECONOMICS_BASIS, ECONOMICS_NOTE, computeEconomics, costOfMinutes,
  CONTRIBUTION_BASIS, CONTRIBUTION_UNAVAILABLE_REASONS,
} from './economics.js';
export { buildDeliveryActions } from './handover.js';
export { requireDeliveryWindow, requireCalendarDate, daysBetween, DATES_SOURCE, DATES_NOTE } from './dates.js';
