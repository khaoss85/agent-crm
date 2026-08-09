// @ts-check

import { AppError } from '../../core/index.js';
import { resolvedNames } from './activation.js';
import { TERMS_SOURCE } from './dates.js';

/**
 * `contract-lifecycle-source@1` — the term and commercial evidence an
 * operational lifecycle package needs, and **nothing it could act with**.
 *
 * Contracts already offers `delivery-obligations@1` and `service-obligations@1`.
 * Neither exposes a term, a line or a subscription, so M16a could not have been
 * built without either a new capability or a private import — and a private
 * import is what the package seam exists to refuse. This is the smallest
 * capability that answers *what did we agree, until when, and on what evidence*.
 *
 * **Read-only by construction.** There is no method here that writes, and there
 * is no handle a caller could write through: no service, no database, no
 * transaction. A consumer that wants to change a contract must go through
 * Contracts' own actions, as a human. Everything handed back is frozen — the
 * interface, the evidence, the lists and every row in them — and every field on
 * a row is a primitive copy, so a consumer holds no reference to a live record
 * and mutating what it was given reaches nothing.
 *
 * **Provenance travels with every date.** M12 records activation terms as
 * *operational metadata*, and `termsSource` exists precisely because those
 * dates may never have been signed. Every term this capability returns carries
 * its source, so a consumer physically cannot report a date without being able
 * to say where it came from — and `signed` is *derived* from that source rather
 * than asserted next to it, so the two can never disagree.
 */

export const LIFECYCLE_SOURCE = Object.freeze({ name: 'contract-lifecycle-source', version: 1 });

/**
 * Whether a term from each declared `termsSource` is carried by a **signed**
 * instrument — one entry per value the contract's enum allows.
 *
 * `signed` used to be the literal `false`. That was the right answer and the
 * wrong mechanism: it stated in a second place a fact `termsSource` already
 * carries, as a constant rather than as data. The day M12 gains a source that
 * *is* signed, `termsSource` starts telling the truth on its own while a
 * literal in this file keeps saying `false` — a silent, permanent
 * under-claim that no test would notice, in a different package from the one
 * that changed.
 *
 * A map instead of a list, so the failure mode is a failing test rather than a
 * wrong answer: `tests/lifecycle-renewal-operations.test.js` asserts these keys
 * are exactly the manifest's enum values, so adding a source without deciding
 * whether it is signed stops the suite.
 *
 * Unknown or absent stays `false`. The direction matters: reporting a signed
 * term as unsigned costs somebody a redundant check, while reporting an
 * unsigned date as a signed renewal term is the failure this whole package
 * exists to prevent. It fails towards the safe side, always.
 */
export const TERM_SOURCE_SIGNED = Object.freeze({
  // Recorded by a human *after* signature; the signed document carries no term.
  [TERMS_SOURCE]: false,
});

/** @param {unknown} source */
export function termIsSigned(source) {
  return typeof source === 'string' && TERM_SOURCE_SIGNED[source] === true;
}

/** @param {Record<string, string>} [moduleNames] */
export function createContractLifecycleSourceCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: LIFECYCLE_SOURCE.name,
    version: LIFECYCLE_SOURCE.version,
    description:
      'Read one contract\'s term evidence with its declared provenance, its current version, its contract lines and its subscription lines. Grants no write path, no contract storage and no ability to change what was agreed.',
    /** @param {{modules?: any}} context */
    create(context = {}) {
      const modules = context.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError(`${LIFECYCLE_SOURCE.name} requires the caller's modules view`, {
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
      const safeGet = (svc, id) => { try { return svc.get(id); } catch { return null; } };

      // Frozen, like everything else it hands back: the interface a consumer
      // holds is evidence too, and a consumer that can redefine `termEvidence`
      // on it can make its own package lie in its own trace.
      return Object.freeze({
        capabilityContract: 1,

        /**
         * One contract's term evidence, or null.
         *
         * An exact primary-key read. A filtered list here could hand back
         * somebody else's contract when the filter is not understood, which is
         * the worst failure mode available across a package boundary.
         *
         * @param {string} contractId
         */
        termEvidence(contractId) {
          const contract = typeof contractId === 'string' && contractId !== ''
            ? safeGet(service(names.contract), contractId) : null;
          if (!contract) return null;
          const version = contract.currentVersionId
            ? safeGet(service(names.contractVersion), contract.currentVersionId) : null;
          return Object.freeze({
            contractId: contract.id,
            status: contract.status,
            currency: contract.currency,
            customerName: contract.customerName,
            companyId: contract.companyId,
            contactId: contract.contactId,
            orderId: contract.orderId,
            quoteId: contract.quoteId,
            currentVersionId: contract.currentVersionId,
            versionNumber: version ? version.versionNumber : null,
            term: Object.freeze({
              startDate: contract.termStartDate,
              // Inclusive. A term ending 2026-12-31 is live ON 2026-12-31.
              endDate: contract.termEndDate,
              endDateIsInclusive: true,
              days: contract.termDays,
              autoRenew: Boolean(contract.autoRenew),
              renewalNoticeDays: contract.renewalNoticeDays ?? null,
              // The whole reason this capability exists in this shape.
              source: contract.termsSource ?? null,
              reason: contract.termsReason ?? null,
              // Derived from the source above, never asserted independently of
              // it: one truth, in one place. See TERM_SOURCE_SIGNED.
              signed: termIsSigned(contract.termsSource),
              provenanceNote:
                'these dates are post-signature OPERATIONAL metadata recorded at activation (M12). They are not signed renewal terms, and nothing here should be reported as one',
            }),
          });
        },

        /**
         * The contract's lines, in a deterministic order — the commercial
         * baseline a renewal conversation starts from. Amounts are integer
         * minor units and are never summed across currencies here.
         *
         * @param {string} contractId
         */
        listContractLines(contractId) {
          if (typeof contractId !== 'string' || contractId === '') return Object.freeze([]);
          return Object.freeze(service(names.contractLine)
            .listWhere({ contractId })
            .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position))
            .map((row) => Object.freeze({
              id: row.id,
              contractVersionId: row.contractVersionId,
              label: row.label,
              componentKey: row.componentKey,
              chargeType: row.chargeType,
              pricingModel: row.pricingModel,
              interval: row.interval,
              intervalCount: row.intervalCount,
              quantity: row.quantity,
              netAmountCents: row.netAmountCents,
              currency: row.currency,
              commercialActivation: row.commercialActivation,
              position: row.position,
            })));
        },

        /**
         * The subscription lines that are live under this contract, if any.
         * @param {string} contractId
         */
        listSubscriptionLines(contractId) {
          if (typeof contractId !== 'string' || contractId === '') return Object.freeze([]);
          const subscriptions = service(names.subscription).listWhere({ contractId });
          const lines = [];
          for (const subscription of subscriptions) {
            for (const row of service(names.subscriptionLine).listWhere({ subscriptionId: subscription.id })) {
              lines.push(Object.freeze({
                id: row.id,
                subscriptionId: row.subscriptionId,
                contractLineId: row.contractLineId,
                label: row.label,
                componentKey: row.componentKey,
                chargeType: row.chargeType,
                interval: row.interval,
                intervalCount: row.intervalCount,
                quantity: row.quantity,
                netAmountCents: row.netAmountCents,
                currency: row.currency,
                status: row.status,
                startDate: row.startDate,
                endDate: row.endDate,
              }));
            }
          }
          return Object.freeze(lines.sort((a, b) => (a.componentKey === b.componentKey ? (a.id < b.id ? -1 : 1)
            : a.componentKey < b.componentKey ? -1 : 1)));
        },
      });
    },
  };
}
