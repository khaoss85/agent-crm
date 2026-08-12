// @ts-check

import { definePackage } from '../../core/index.js';
import { buildServiceActions, serviceMetadata } from './actions.js';
import { SERVICE_POLICY_KIND, defineServiceActivationPolicy } from './activation-policy.js';
import {
  REQUIRED_CAPABILITY, SERVICE_PACKAGE, WORK_FOLLOW_UP_CAPABILITY, servicePolicyFingerprint,
} from './service-actions.js';
import {
  createCaseManagementCapability, createCoverageCapability, createSlaEvidenceCapability,
} from './capabilities.js';

/**
 * The Service domain package — the **third** built under ADR-018, and the
 * second that depends on another package.
 *
 * M12 raised pending Service Obligations when a contract activated and then
 * stopped. This turns them into an operational support relationship: a Service
 * Coverage with its Entitlements, support cases over an explicit transition
 * table, elapsed-time SLA evidence, and manually recorded escalation.
 *
 * **It is not a second contract.** A Service Coverage is operational: nobody
 * signed it, it has no envelope, signer or artifact, and it neither amends nor
 * replaces the Commercial Contract it was activated from. The concept is named
 * *coverage* precisely so that nothing here reads as a signed agreement.
 *
 * Its only reach into another package is the declared capability
 * `contracts/service-obligations@1`. It imports nothing from
 * `packages/contracts/src` and nothing from `packages/core/src`. Removing the
 * one static import in `packages/domains/generated/index.js` removes the
 * domain, and everything else keeps working.
 */

export { SERVICE_PACKAGE };
export const SERVICE_RESOURCES = Object.freeze([
  'service-coverage', 'service-entitlement', 'service-activation-run',
  'support-case', 'support-case-activity', 'service-sla-evaluation', 'service-escalation',
]);

/**
 * @param {{policies?: any[], modules?: Record<string, string>, followUp?: boolean}} [options]
 *   `policies` are service activation policy definitions (validated here);
 *   `modules` overrides record-module names for a project that renamed them;
 *   `followUp: true` makes this package a consumer of `work/follow-up@1`, so a
 *   recorded escalation also opens one work task in the same transaction. It is
 *   opt-in because `requires` is hard and every existing composition must keep
 *   booting unchanged (Work v1, ADR-030).
 */
export function createServicePackage(options = {}) {
  const followUp = options.followUp === true;
  const policies = (options.policies ?? []).map((definition) => ({
    kind: SERVICE_POLICY_KIND,
    definition: defineServiceActivationPolicy(definition),
  }));

  return definePackage({
    packageContract: 1,
    name: SERVICE_PACKAGE,
    label: 'Service operations',
    version: 1,
    description: 'Activates a contract\'s pending service obligations into an operational Service Coverage with immutable Entitlements, and records support cases, elapsed-time SLA evidence and manual escalation. It is not a signed agreement, it amends no commercial record, and it bills, sends and schedules nothing.',
    // The one declared reach into another package. Without it this package
    // refuses to register: it cannot invent the obligations it activates.
    requires: followUp
      ? [{ ...REQUIRED_CAPABILITY }, { ...WORK_FOLLOW_UP_CAPABILITY }]
      : [{ ...REQUIRED_CAPABILITY }],
    capabilities: [
      createCoverageCapability({ modules: options.modules }),
      createCaseManagementCapability({ modules: options.modules }),
      createSlaEvidenceCapability({ modules: options.modules }),
    ],
    resources: [...SERVICE_RESOURCES],
    actions: buildServiceActions({ modules: options.modules, policies, followUp }),
    policies,
    /** Function-free, additive schema metadata — never a handler or a secret. */
    metadata() {
      return {
        ...serviceMetadata(policies),
        workFollowUp: followUp
          ? 'composed with followUp enabled: recording an escalation also opens exactly one work task on that escalation, through work/follow-up@1, in the same transaction. Nothing is still routed, notified, assigned or scheduled by it, and the task carries no due date'
          : 'not composed. Without followUp enabled this package requires nothing from work, creates no task, and behaves exactly as it did before Work v1',
        policyFingerprints: policies.map(({ definition }) => ({
          name: definition.name,
          version: definition.version,
          fingerprint: servicePolicyFingerprint(definition),
        })),
      };
    },
  });
}

export { defineServiceActivationPolicy, SERVICE_POLICY_KIND, CASE_PRIORITIES, AMBIGUOUS } from './activation-policy.js';
export {
  CASE_STATES, CASE_TRANSITIONS, COVERAGE_STATES, ESCALATION_LEVELS, SLA_STATES,
  ACTIVITY_TYPES, VISIBILITY, AT_RISK_FRACTION, evaluateSla, addMinutes, servicePolicyFingerprint,
} from './service-actions.js';
export { serviceMetadata } from './actions.js';
export {
  COVERAGE_CAPABILITY, CASE_CAPABILITY, SLA_CAPABILITY,
} from './capabilities.js';
