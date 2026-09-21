// @ts-check

import { AppError } from '../../core/index.js';
import { resolvedNames } from './activation.js';
import { SIGNED_TERMS_SOURCE, TERMS_SOURCE } from './dates.js';

/**
 * `contract-lifecycle-source@2` — the term and commercial evidence an
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
 *
 * **Why version 2.** v1 answered `signed` from a classification map and quietly
 * returned `false` for anything the map did not name. That is safe for one
 * unknown row and unsafe as a rule: the day `termsSource` gains a value nobody
 * has classified, every contract carrying it is reported as unsigned by a
 * package that never considered the question. v2 refuses to open at all in that
 * state, and reports `signed: null` — *cannot say* — for a stored value outside
 * the declared enum, rather than the confident `false` that hides it. Both are
 * observable contract changes, so the version moved with them.
 */

export const LIFECYCLE_SOURCE = Object.freeze({ name: 'contract-lifecycle-source', version: 2 });

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
 * that changed. A `true` here is therefore possible, and no consumer has to
 * change for a signed term to become expressible.
 *
 * A map, not a list, and **exhaustiveness is enforced at runtime**, not only by
 * a test. `create()` reads the `termsSource` enum off the live module contract
 * and refuses to open the capability while any declared value is unclassified.
 * A test alone is not enough here: the manifest and this map live in the same
 * package but in different files, and the failure a test would catch on CI is
 * the same failure that would otherwise be answered — wrongly, silently and
 * confidently — in production.
 */
export const TERM_SOURCE_SIGNED = Object.freeze({
  // Recorded by a human *after* signature; the signed document carries no term.
  [TERMS_SOURCE]: false,
  // The day this map's own documentation anticipated: the term was part of
  // the canonical document the customer signed — frozen at quote submission,
  // covered by the documentHash, copied from the immutable order-term
  // snapshot at activation. `termsSource` now tells the truth on its own,
  // and this entry lets the derived claim agree with it.
  [SIGNED_TERMS_SOURCE]: true,
});

/**
 * The signed state of a term from `source`: `true`, `false`, or **`null` when
 * the source is not one this package has classified**.
 *
 * `null` is the honest answer and it is not the same as `false`. `false` says
 * "we looked, and a term from this source is not carried by a signed
 * instrument". `null` says "this row names a provenance nobody decided about" —
 * which a consumer must be able to surface as a gap instead of reporting a
 * decided fact. Consumers still receive `term.source` either way, so provenance
 * never disappears; only the *derived* claim does.
 *
 * @param {unknown} source @returns {boolean | null}
 */
export function termSignedState(source) {
  if (typeof source !== 'string' || !Object.hasOwn(TERM_SOURCE_SIGNED, source)) return null;
  return TERM_SOURCE_SIGNED[source] === true;
}

/**
 * Kept for the callers that only need the safe direction: an unclassified
 * source is never reported as signed.
 * @param {unknown} source
 */
export function termIsSigned(source) {
  return termSignedState(source) === true;
}

/**
 * The `termsSource` values the contract module actually declares, read off the
 * live module contract rather than re-typed here.
 *
 * Re-typing the enum would recreate exactly the defect this guard exists to
 * close: two lists that agree until the day one of them moves.
 *
 * @param {any} contractModule
 */
export function declaredTermSources(contractModule) {
  const field = (contractModule?.fields ?? []).find((entry) => entry?.name === 'termsSource');
  return Array.isArray(field?.values) ? [...field.values] : [];
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

      // **The fail-closed gate.** Every `termsSource` the contract module
      // declares must have been classified as signed or not before this
      // capability will answer anything at all. Adding a value to the manifest
      // without deciding its signed semantics stops the application here,
      // loudly, instead of being answered `false` by a map that never heard of
      // it. Both halves live in this package, so this is a local invariant a
      // single PR can always satisfy.
      let contractModule = null;
      try { contractModule = modules.get(names.contract); } catch { contractModule = null; }
      const declared = declaredTermSources(contractModule);
      if (declared.length === 0) {
        // No enum to derive from means no basis for the one claim this
        // capability exists to make. It refuses rather than defaulting.
        throw new AppError(
          `${LIFECYCLE_SOURCE.name} cannot report term provenance: the "${names.contract}" module declares no `
            + 'termsSource values, so whether a term is signed cannot be derived from anything.',
          { code: 'TERM_SOURCE_UNDECLARED', status: 500 },
        );
      }
      const unclassified = declared.filter((value) => !Object.hasOwn(TERM_SOURCE_SIGNED, value)).sort();
      if (unclassified.length > 0) {
        throw new AppError(
          `${LIFECYCLE_SOURCE.name} cannot report term provenance: the ${names.contract} module declares `
            + `termsSource ${unclassified.map((value) => `"${value}"`).join(', ')} with no decision on whether `
            + 'a term from that source is signed. Classify it in TERM_SOURCE_SIGNED.',
          { code: 'TERM_SOURCE_UNCLASSIFIED', status: 500, details: { unclassified } },
        );
      }

      // Frozen, like everything else it hands back: the interface a consumer
      // holds is evidence too, and a consumer that can redefine `termEvidence`
      // on it can make its own package lie in its own trace.
      return Object.freeze({
        // Historical interface-shape marker, not an async contract. M2E-1
        // resolves that collision: this interface is synchronous and therefore
        // contract 1. The declaration on the package capability is authoritative
        // for composition; this returned value remains descriptive only.
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
              // it: one truth, in one place. See TERM_SOURCE_SIGNED. `null`
              // means the stored source is outside the declared enum — the
              // capability will not invent a decision for a row whose
              // provenance nobody classified.
              signed: termSignedState(contract.termsSource),
              // Why `signed` says what it says, so a consumer can tell a
              // decided `false` apart from an absent decision without
              // re-implementing the rule.
              signedBasis: contract.termsSource == null
                ? 'NO_DECLARED_TERM_SOURCE'
                : termSignedState(contract.termsSource) === null
                  ? 'UNCLASSIFIED_TERM_SOURCE'
                  : 'DERIVED_FROM_DECLARED_TERM_SOURCE',
              // Derived from the SAME source as `signed`, so the sentence can
              // never contradict the flag: a signed term is described as
              // signed, an operational one as operational, and an
              // unclassified source gets the gap named rather than a guess.
              provenanceNote: termSignedState(contract.termsSource) === true
                ? 'these dates are the SIGNED commercial term: part of the canonical document the customer signed (covered by its documentHash), frozen at quote submission and copied from the order term snapshot at activation'
                : termSignedState(contract.termsSource) === false
                  ? 'these dates are post-signature OPERATIONAL metadata recorded at activation (M12). They are not signed renewal terms, and nothing here should be reported as one'
                  : 'this term names a provenance nobody classified; whether it was signed is unknown and must be surfaced as a gap, never asserted either way',
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
