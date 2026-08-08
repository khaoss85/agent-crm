// @ts-check

import { AppError, requiredString } from '../../core/index.js';
import { serviceNames } from './service-actions.js';

/**
 * What the Service package offers **other packages** — and nothing more.
 *
 * All three are read-only. None of them decides anything, none reaches
 * commercial storage, and none grants a customer or an agent any access. They
 * exist so a future milestone (renewal signals, analytics, a customer-success
 * slice) can read service reality without importing a service table.
 *
 * Each is created per call with the **caller's** runtime handles, so a read
 * happens inside the caller's transaction while this package keeps its storage
 * private.
 */

export const COVERAGE_CAPABILITY = 'service-coverage';
export const CASE_CAPABILITY = 'service-case-management';
export const SLA_CAPABILITY = 'service-sla-evidence';

function modulesOf(context, capability) {
  const modules = context?.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError(`${capability} requires the caller's module handles`, {
      code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
    });
  }
  return modules;
}

/** The operational coverage and entitlements of one contract. */
export function createCoverageCapability(options = {}) {
  const names = serviceNames(options.modules);
  return {
    name: COVERAGE_CAPABILITY,
    version: 1,
    description: 'Read the operational service coverage and entitlements activated from one contract. Read-only. A coverage is NOT a signed agreement and grants no access; an entitlement is evidence, not a permission or a billing unit.',
    create(context) {
      const modules = modulesOf(context, COVERAGE_CAPABILITY);
      return Object.freeze({
        capabilityContract: 1,
        /** @param {string} contractId */
        forContract(contractId) {
          const id = requiredString(contractId, 'contractId');
          const coverages = modules.get(names.coverage).service.listWhere({ contractId: id });
          return Object.freeze({
            coverages,
            entitlements: modules.get(names.entitlement).service.listWhere({ contractId: id }),
            basis: 'operational coverage activated from service obligations; not a signed agreement, and it amends no commercial record',
          });
        },
        /** Coverage that is running today, for a caller deciding what is live. */
        activeCoverages() {
          return modules.get(names.coverage).service.listWhere({ status: 'active' });
        },
      });
    },
  };
}

/** Support cases and their append-only activity, for one coverage. */
export function createCaseManagementCapability(options = {}) {
  const names = serviceNames(options.modules);
  return {
    name: CASE_CAPABILITY,
    version: 1,
    description: 'Read the support cases and append-only case activity of one service coverage. Read-only: it opens, moves and closes nothing. Every row is what a USER ACTOR recorded — never an authenticated customer action.',
    create(context) {
      const modules = modulesOf(context, CASE_CAPABILITY);
      return Object.freeze({
        capabilityContract: 1,
        /** @param {string} serviceCoverageId */
        forCoverage(serviceCoverageId) {
          const id = requiredString(serviceCoverageId, 'serviceCoverageId');
          modules.get(names.coverage).service.get(id);
          return Object.freeze({
            cases: modules.get(names.supportCase).service.listWhere({ serviceCoverageId: id }),
            activity: modules.get(names.caseActivity).service.listWhere({ serviceCoverageId: id }),
            basis: 'recorded by a user actor; no customer is authenticated and no channel is integrated',
          });
        },
      });
    },
  };
}

/** Recorded SLA evaluations and escalations — evidence about moments. */
export function createSlaEvidenceCapability(options = {}) {
  const names = serviceNames(options.modules);
  return {
    name: SLA_CAPABILITY,
    version: 1,
    description: 'Read the recorded elapsed-time SLA evaluations and escalations of one service coverage. Each evaluation is what the clock said at a stated instant — never current truth, never a contractual or legal SLA judgement.',
    create(context) {
      const modules = modulesOf(context, SLA_CAPABILITY);
      return Object.freeze({
        capabilityContract: 1,
        /** @param {string} serviceCoverageId */
        forCoverage(serviceCoverageId) {
          const id = requiredString(serviceCoverageId, 'serviceCoverageId');
          modules.get(names.coverage).service.get(id);
          return Object.freeze({
            evaluations: modules.get(names.slaEvaluation).service.listWhere({ serviceCoverageId: id }),
            escalations: modules.get(names.escalation).service.listWhere({ serviceCoverageId: id }),
            basis: 'elapsed wall-clock minutes against the injected UTC clock at the stated instant; no business hours, no holidays, no paused clock, and no contractual SLA interpretation',
          });
        },
      });
    },
  };
}
