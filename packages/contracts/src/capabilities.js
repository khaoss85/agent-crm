// @ts-check

import { AppError, TRANSACTION_PROOF, proveCallerTransaction } from '../../core/index.js';
import { resolvedNames } from './activation.js';

/**
 * What this package offers to **other packages** — and nothing more.
 *
 * `delivery-obligations@1` is the entire surface the Delivery package (M13)
 * gets. It cannot import a contracts service, read a contracts table or learn
 * a contracts source key: it asks this capability for the pending obligations
 * of one contract and, inside its own transaction, asks it to mark exactly
 * those obligations handed over.
 *
 * The capability is created per call with the **caller's** runtime handles, so
 * every read and write happens inside the caller's transaction while the
 * provider keeps its storage private. That is what makes a cross-package
 * commit atomic without a shared database handle.
 */

const HANDOVER_STATUS = 'handed_over';
const PENDING_STATUS = 'pending_handover';
const MAX_BATCH = 500;

/**
 * @param {Record<string, string>} [moduleNames] project-level module renames,
 *   the same map the actions use.
 */
export function createDeliveryObligationsCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: 'delivery-obligations',
    version: 1,
    description:
      'Read the pending delivery obligations of an activated contract and mark selected ones handed over, inside the caller\'s transaction. Grants no access to contract storage.',
    /** @param {{modules?: any, actor?: unknown}} context */
    create(context = {}) {
      const modules = context.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('delivery-obligations requires the caller\'s modules view', {
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
         * The activated contract, or null. Only the fields another package may
         * legitimately snapshot — never the whole row, never the policy
         * internals, never the signed document evidence.
         *
         * @param {string} contractId
         */
        getContract(contractId) {
          // Exact primary-key read only. A "list with a filter" here would
          // silently hand back somebody else's contract when the filter is not
          // understood — the worst possible failure mode across a package
          // boundary.
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
         * The obligations of one contract that are still pending handover, in
         * a deterministic order. An exact indexed read, never a paged scan.
         *
         * @param {string} contractId
         */
        listPending(contractId) {
          return service(names.deliveryObligation)
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
              productId: row.productId,
              productVersionId: row.productVersionId,
              provider: row.provider,
              activationId: row.activationId,
            }));
        },

        /**
         * Mark exactly these obligations handed over, in the caller's
         * transaction. Every id must belong to the named contract and must
         * still be pending: a stale plan, a foreign id or a second handover is
         * a stable refusal rather than a silent no-op.
         *
         * @param {{contractId: string, obligationIds: string[], handoverRef: string, actor: unknown}} request
         */
        async markHandedOver({ contractId, obligationIds, handoverRef, actor }) {
          if (!Array.isArray(obligationIds) || obligationIds.length === 0) {
            throw new AppError('No delivery obligations were selected for handover', {
              code: 'OBLIGATIONS_REQUIRED', status: 409,
            });
          }
          if (obligationIds.length > MAX_BATCH) {
            throw new AppError('Too many delivery obligations in one handover', {
              code: 'OBLIGATIONS_TOO_MANY', status: 409,
            });
          }
          if (typeof handoverRef !== 'string' || handoverRef === '' || handoverRef.length > 200) {
            throw new AppError('A handover reference is required', { code: 'HANDOVER_REF_REQUIRED', status: 400 });
          }
          const obligations = service(names.deliveryObligation);
          // Everything above this line is input validation, and it still
          // refuses first. Everything below writes.
          requireCallerTransaction([obligations], 'A delivery handover');
          const updated = [];
          for (const id of new Set(obligationIds)) {
            const row = safeGet(obligations, id);
            if (!row || row.contractId !== contractId) {
              throw new AppError('A delivery obligation does not belong to this contract', {
                code: 'OBLIGATION_NOT_OF_CONTRACT', status: 409, details: { obligationId: String(id) },
              });
            }
            if (row.status !== PENDING_STATUS) {
              throw new AppError('A delivery obligation was already handed over', {
                code: 'OBLIGATION_ALREADY_HANDED_OVER', status: 409, details: { obligationId: row.id },
              });
            }
            // Awaited, deliberately: an unawaited managed write would escape
            // the caller's transaction, and a failure in it would surface as an
            // unhandled rejection AFTER a "successful" handover.
            updated.push(await obligations.applyManaged(
              row.id,
              { status: HANDOVER_STATUS, handoverRef, handedOverAt: nowFrom(context) },
              { actor: actor ?? context.actor },
            ));
          }
          return updated.length;
        },
      };
    },
  };
}

/**
 * **Refuse to start a write set that cannot be finished as one.**
 *
 * A handover marks N obligations, and each `applyManaged` lands on its own
 * SAVEPOINT so it nests safely inside an enclosing transaction. Outside one,
 * that SAVEPOINT *is* the transaction and `RELEASE` commits it — so a refusal
 * at obligation 3 leaves obligations 1 and 2 committed, marked handed over to
 * a delivery project that will never exist, and permanently un-handoverable
 * because `OBLIGATION_ALREADY_HANDED_OVER` is terminal.
 *
 * That was reachable and it was measured, not reasoned about: the probe is in
 * `docs/plans/spine-v2-m2d-transaction-context.md` §2 and it is now a checked-in
 * regression. The doc comments on both write methods have always promised "in
 * the caller's transaction"; this is the line that makes the promise checkable.
 *
 * `proveCallerTransaction` asks the storage seam — never the SQLite driver —
 * for the opaque witness the database wrapper mints per outer transaction, on
 * the same handle the write is about to use.
 *
 * @param {any[]} services @param {string} what
 */
export function requireCallerTransaction(services, what) {
  const proof = proveCallerTransaction(services);
  if (proof === TRANSACTION_PROOF.ACTIVE) return;
  if (proof === TRANSACTION_PROOF.NO_TRANSACTION) {
    throw new AppError(
      `${what} must run inside the caller's transaction: it writes a set of rows that are only correct together, `
        + 'and outside a transaction a refusal partway through would leave the earlier ones committed. '
        + "Call it from a package action's execute, or from inside database.transactionAsync.",
      { code: 'CONTRACT_TRANSACTION_REQUIRED', status: 500, details: { proof } },
    );
  }
  throw new AppError(
    `${what} cannot prove it is running inside the caller's transaction, so it refuses to write the first row `
      + 'of a set whose remainder might not commit with it.',
    { code: 'CONTRACT_TRANSACTION_REQUIRED', status: 500, details: { proof } },
  );
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
