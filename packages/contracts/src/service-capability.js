// @ts-check

import { AppError } from '../../core/index.js';
import { resolvedNames } from './activation.js';

/**
 * `service-obligations@1` — the entire surface the Service package (M15) gets.
 *
 * It is the sibling of `delivery-obligations@1` and follows it exactly: created
 * per call with the **caller's** runtime handles, so every read and every write
 * happens inside the caller's transaction while contracts keeps its storage
 * private. The Service package cannot import a contracts service, read a
 * contracts table or learn a contracts source key.
 *
 * The one difference from delivery's capability is the vocabulary: a service
 * obligation is **activated**, not handed over, and the record it produces is
 * an operational Service Coverage rather than a project. Nothing here creates,
 * alters or amends a Contract, a Contract Version, a Subscription or an Order.
 */

const ACTIVATED_STATUS = 'activated';
const PENDING_STATUS = 'pending_activation';
const MAX_BATCH = 500;

/**
 * @param {Record<string, string>} [moduleNames] project-level module renames,
 *   the same map the activation actions use.
 */
export function createServiceObligationsCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: 'service-obligations',
    version: 1,
    description:
      'Read the pending service obligations of an activated contract and mark selected ones activated, inside the caller\'s transaction. Grants no access to contract storage, and amends no commercial record.',
    /** @param {{modules?: any, actor?: unknown}} context */
    create(context = {}) {
      const modules = context.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('service-obligations requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const service = (name) => {
        const module = modules.get(name);
        if (!module?.service) {
          throw new AppError(`The contracts package is installed without its "${name}" records`, {
            code: 'CONTRACT_STORAGE_INVALID', status: 500,
          });
        }
        return module.service;
      };

      return {
        capabilityContract: 1,

        /**
         * The activated contract, or null — only the fields another package may
         * legitimately snapshot. An exact primary-key read: a filtered list here
         * would hand back somebody else's contract when the filter is not
         * understood, the worst failure mode across a package boundary.
         *
         * @param {string} contractId
         */
        getContract(contractId) {
          const contract = typeof contractId === 'string' && contractId !== ''
            ? safeGet(service(names.contract), contractId)
            : null;
          if (!contract) return null;
          return Object.freeze({
            id: contract.id,
            orderId: contract.orderId,
            activationId: contract.activationId,
            currentVersionId: contract.currentVersionId,
            status: contract.status,
            currency: contract.currency,
            customerName: contract.customerName,
            customerEmail: contract.customerEmail,
            companyId: contract.companyId,
            contactId: contract.contactId,
            opportunityId: contract.opportunityId,
            effectiveDate: contract.effectiveDate,
            termStartDate: contract.termStartDate,
            termEndDate: contract.termEndDate,
            termsSource: contract.termsSource,
          });
        },

        /**
         * The obligations of one contract still pending activation, in a
         * deterministic order. An exact indexed read, never a paged scan.
         *
         * @param {string} contractId
         */
        listPending(contractId) {
          return service(names.serviceObligation)
            .listWhere({ contractId, status: PENDING_STATUS })
            .sort((a, b) => (a.componentKey === b.componentKey ? (a.id < b.id ? -1 : 1) : a.componentKey < b.componentKey ? -1 : 1))
            .map((row) => Object.freeze({
              id: row.id,
              contractId: row.contractId,
              contractLineId: row.contractLineId,
              orderId: row.orderId,
              orderComponentId: row.orderComponentId,
              status: row.status,
              label: row.label,
              componentKey: row.componentKey,
              sku: row.sku,
              chargeType: row.chargeType,
              interval: row.interval,
              intervalCount: row.intervalCount,
              quantity: row.quantity,
              netAmountCents: row.netAmountCents,
              currency: row.currency,
              activationId: row.activationId,
            }));
        },

        /**
         * Mark exactly these obligations activated, in the caller's
         * transaction. Every id must belong to the named contract and must
         * still be pending: a stale plan, a foreign id or a second activation
         * is a stable refusal rather than a silent no-op.
         *
         * @param {{contractId: string, obligationIds: string[], coverageRef: string, actor: unknown}} request
         */
        async markActivated({ contractId, obligationIds, coverageRef, actor }) {
          if (!Array.isArray(obligationIds) || obligationIds.length === 0) {
            throw new AppError('No service obligations were selected for activation', {
              code: 'SERVICE_OBLIGATIONS_REQUIRED', status: 409,
            });
          }
          if (obligationIds.length > MAX_BATCH) {
            throw new AppError('Too many service obligations in one activation', {
              code: 'SERVICE_OBLIGATIONS_TOO_MANY', status: 409,
            });
          }
          if (typeof coverageRef !== 'string' || coverageRef === '' || coverageRef.length > 200) {
            throw new AppError('A service coverage reference is required', {
              code: 'SERVICE_COVERAGE_REF_REQUIRED', status: 400,
            });
          }
          const obligations = service(names.serviceObligation);
          const updated = [];
          for (const id of new Set(obligationIds)) {
            const row = safeGet(obligations, id);
            if (!row || row.contractId !== contractId) {
              throw new AppError('A service obligation does not belong to this contract', {
                code: 'SERVICE_OBLIGATION_NOT_OF_CONTRACT', status: 409, details: { obligationId: String(id) },
              });
            }
            if (row.status !== PENDING_STATUS) {
              throw new AppError('A service obligation was already activated', {
                code: 'SERVICE_OBLIGATION_ALREADY_ACTIVATED', status: 409, details: { obligationId: row.id },
              });
            }
            // Awaited, deliberately: an unawaited managed write would escape the
            // caller's transaction, and a failure in it would surface as an
            // unhandled rejection AFTER a "successful" activation.
            updated.push(await obligations.applyManaged(
              row.id,
              { status: ACTIVATED_STATUS, coverageRef, activatedAt: nowFrom(context) },
              { actor: actor ?? context.actor },
            ));
          }
          return updated.length;
        },
      };
    },
  };
}

/** @param {any} service @param {string} id */
function safeGet(service, id) {
  try {
    return service.get(id);
  } catch {
    return null;
  }
}

/** The caller's clock when it passes one, so a capability never reads its own. */
function nowFrom(context) {
  return typeof context.now === 'function' ? context.now() : new Date().toISOString();
}
