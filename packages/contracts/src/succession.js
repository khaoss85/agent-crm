// @ts-check

import { AppError, calendarDaysBetween } from '../../core/index.js';
import {
  classifyComponents,
  loadActivationSource,
  resolvedNames,
  toJson,
  trusted,
  writeActivation,
} from './activation.js';
import { normalizeOverrides } from './activation-policy.js';
import { SIGNED_TERMS_NOTE, SIGNED_TERMS_SOURCE, signedTermFromSnapshot } from './dates.js';
import { termSignedState } from './lifecycle-capability.js';

/**
 * **Successor activation and lineage (M16b, ADR-034).**
 *
 * A renewal or an amendment does not rewrite what was agreed. It produces a
 * *successor commercial agreement*: its own signed Order, its own signed
 * document hash, its own term, its own subscription — and one immutable row
 * saying which agreement it replaces. Everything historical is untouched, and
 * this file contains no `UPDATE` against any pre-existing contract, version,
 * line, subscription or obligation row.
 *
 * **The invariant this module exists to hold.** A successor term is claimed as
 * *signed* only when the successor Order carries the ADR-033 chain — a
 * `quote-version-term` frozen at submit, embedded in the canonical document,
 * covered by the `documentHash`, copied onto the Order as `order-term`. An
 * Order whose signed document carried no term is refused outright
 * (`SUCCESSOR_TERMS_NOT_SIGNED`); its dates are post-signature operational
 * metadata, and no amount of business need makes them a signed renewal term.
 *
 * **The derivation lives here, not in the consumer.** The delta between the
 * source agreement and the successor Order, and the classification derived from
 * it, are computed by the package that owns the source lines and declares the
 * Signature edge. A label an orchestrator computed and handed in would be a
 * client-provided classification, which is exactly what a renewal record must
 * never contain. `planSuccession` and `executeSuccession` call the same
 * derivation, so a plan and an execution cannot disagree about what changed.
 */

export const SUCCESSION_CAPABILITY = Object.freeze({ name: 'contracts-successor-activation', version: 1 });

const POLICY_KIND = 'order-activation-policy';

/** The derived labels, in the order a reader should think about them. */
export const CLASSIFICATIONS = Object.freeze(['renewal', 'expansion', 'contraction', 'mixed', 'commercial_change']);

/** How the successor term sits against the source term. */
export const CONTINUITIES = Object.freeze(['contiguous', 'gap', 'overlap', 'unknown']);

export const NOT_MODELED = Object.freeze([
  'billing', 'invoicing', 'payment', 'tax', 'usage rating', 'proration', 'FX',
  'revenue recognition', 'MRR/ARR/TCV', 'scheduler', 'automatic renewal',
  'renewal notice delivery', 'customer notification', 'RBAC or role enforcement',
  'cancellation', 'retroactive amendment of a historical record', 'price computation',
  'live catalog read',
]);

/**
 * The refusals a **maturing** Order can still resolve on its own, without
 * anybody changing the pairing.
 *
 * The distinction is the whole reason an amendment run has two non-terminal
 * states rather than one. "This order has not been signed yet" is a wait;
 * "this order belongs to a different customer" is a wrong pairing that waiting
 * will never fix, and offering to wait for it would be a lie the UI tells.
 * Every refusal carries the flag so a consumer never has to re-derive it from a
 * code list of its own — the day this set moves, one file moves.
 */
const RESOLVABLE_BY_MATURITY = Object.freeze(new Set([
  'ORDER_NOT_ACTIVATABLE',
  'ORDER_NOT_SIGNED',
  'SOURCE_INCOMPLETE',
  'SUCCESSOR_TERMS_NOT_SIGNED',
  'CLASSIFICATION_AMBIGUOUS',
]));

/** @param {string} code @param {string} message @param {number} status @param {any} [details] */
function refusal(code, message, status, details = null) {
  return Object.freeze({
    code,
    message,
    status,
    details: details ? Object.freeze(details) : null,
    resolvableByMaturity: RESOLVABLE_BY_MATURITY.has(code),
  });
}

/** Turn a refusal record back into the error the execution path throws. */
function asError(entry) {
  return new AppError(entry.message, {
    code: entry.code,
    status: entry.status,
    ...(entry.details ? { details: { ...entry.details } } : {}),
  });
}

/**
 * The identity a commercial line keeps across a renewal.
 *
 * `offerLogicalKey` is the catalogue's stable identity — it survives an offer
 * revision, which `offerId` does not — and `componentKey` names the priced
 * component inside it. `sku` is the fallback for a line whose offer carried no
 * logical key. Matching on `label` was considered and rejected: a renamed
 * product would read as one line removed and another added, turning a plain
 * renewal into `mixed`.
 *
 * @param {{offerLogicalKey?: string|null, sku?: string|null}} line
 * @param {{componentKey?: string|null}} component
 */
export function lineKey(line, component) {
  const offer = line?.offerLogicalKey ?? line?.sku ?? '';
  return `${offer}|${component?.componentKey ?? ''}`;
}

/** The comparable commercial shape of one line, source or successor. */
function commercialShape(row) {
  return {
    quantity: Number.isSafeInteger(row.quantity) ? row.quantity : null,
    netAmountCents: Number.isSafeInteger(row.netAmountCents) ? row.netAmountCents : null,
    currency: row.currency ?? null,
    chargeType: row.chargeType ?? null,
    interval: row.chargeType === 'recurring' ? row.interval ?? null : null,
    intervalCount: row.chargeType === 'recurring' && Number.isSafeInteger(row.intervalCount) ? row.intervalCount : null,
  };
}

const COMPARED_FIELDS = Object.freeze(['quantity', 'netAmountCents', 'currency', 'chargeType', 'interval', 'intervalCount']);

/**
 * Group a baseline honestly: by currency **and** the full recurrence, never as
 * one number. A one-time fee, a monthly charge and a quarterly charge
 * (`month × 3`) are three different kinds of money, and there is no FX here.
 *
 * @param {any[]} shapes
 */
export function groupBaseline(shapes) {
  const groups = new Map();
  for (const shape of shapes) {
    const key = `${shape.currency}|${shape.chargeType}|${shape.interval ?? 'none'}|${shape.intervalCount ?? 'none'}`;
    const existing = groups.get(key) ?? {
      currency: shape.currency, chargeType: shape.chargeType,
      interval: shape.interval, intervalCount: shape.intervalCount,
      lineCount: 0, netAmountCents: 0,
    };
    existing.lineCount += 1;
    existing.netAmountCents += shape.netAmountCents ?? 0;
    groups.set(key, existing);
  }
  return [...groups.values()].sort(byGroup);
}

function byGroup(a, b) {
  const byCurrency = String(a.currency).localeCompare(String(b.currency));
  if (byCurrency !== 0) return byCurrency;
  const byCharge = String(a.chargeType).localeCompare(String(b.chargeType));
  if (byCharge !== 0) return byCharge;
  const byInterval = String(a.interval).localeCompare(String(b.interval));
  return byInterval !== 0 ? byInterval : Number(a.intervalCount ?? 0) - Number(b.intervalCount ?? 0);
}

/** The per-group movement between two baselines. Never a single total. */
function baselineDelta(before, after) {
  const keyOf = (g) => `${g.currency}|${g.chargeType}|${g.interval ?? 'none'}|${g.intervalCount ?? 'none'}`;
  const map = new Map();
  for (const group of before) map.set(keyOf(group), { ...group, beforeNetAmountCents: group.netAmountCents, afterNetAmountCents: 0, beforeLineCount: group.lineCount, afterLineCount: 0 });
  for (const group of after) {
    const entry = map.get(keyOf(group)) ?? { ...group, beforeNetAmountCents: 0, afterNetAmountCents: 0, beforeLineCount: 0, afterLineCount: 0 };
    entry.afterNetAmountCents = group.netAmountCents;
    entry.afterLineCount = group.lineCount;
    map.set(keyOf(group), entry);
  }
  return [...map.values()]
    .map((entry) => ({
      currency: entry.currency,
      chargeType: entry.chargeType,
      interval: entry.interval,
      intervalCount: entry.intervalCount,
      beforeLineCount: entry.beforeLineCount,
      afterLineCount: entry.afterLineCount,
      beforeNetAmountCents: entry.beforeNetAmountCents,
      afterNetAmountCents: entry.afterNetAmountCents,
      netAmountCentsDelta: entry.afterNetAmountCents - entry.beforeNetAmountCents,
    }))
    .sort(byGroup);
}

/**
 * The exact line-level delta between the source agreement's contract lines and
 * the successor Order's priced components.
 *
 * `ambiguousKeys` is not a detail: a key appearing twice on one side means the
 * two sides cannot be matched by that key at all, and a classification derived
 * from an arbitrary pairing would be a guess wearing a label. It is reported,
 * and it forces `commercial_change`.
 *
 * @param {any[]} sourceLines contract lines of the source agreement
 * @param {{line: any, component: any}[]} successorComponents the successor Order's components
 * @param {string|null} successorCurrency the successor Order's currency — order
 *   lines and components carry no currency of their own; the Order does, which
 *   is exactly how M12 stamped it onto the contract lines being compared.
 */
export function deriveDelta(sourceLines, successorComponents, successorCurrency = null) {
  const before = new Map();
  const ambiguousKeys = new Set();
  for (const row of sourceLines) {
    const key = lineKey(row, row);
    if (before.has(key)) ambiguousKeys.add(key);
    before.set(key, { key, label: row.label ?? null, ...commercialShape(row) });
  }
  const after = new Map();
  for (const { line, component } of successorComponents) {
    const key = lineKey(line, component);
    if (after.has(key)) ambiguousKeys.add(key);
    after.set(key, {
      key,
      label: component.label ?? null,
      ...commercialShape({ ...component, currency: successorCurrency }),
    });
  }

  const lines = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const from = before.get(key) ?? null;
    const to = after.get(key) ?? null;
    if (from && to) {
      const changedFields = COMPARED_FIELDS.filter((field) => from[field] !== to[field]);
      lines.push({
        key,
        status: changedFields.length === 0 ? 'unchanged' : 'changed',
        label: to.label ?? from.label,
        changedFields,
        before: shapeOnly(from),
        after: shapeOnly(to),
        ambiguous: ambiguousKeys.has(key),
      });
      continue;
    }
    lines.push({
      key,
      status: from ? 'removed' : 'added',
      label: (from ?? to).label,
      changedFields: [],
      before: from ? shapeOnly(from) : null,
      after: to ? shapeOnly(to) : null,
      ambiguous: ambiguousKeys.has(key),
    });
  }

  const counts = {
    added: lines.filter((line) => line.status === 'added').length,
    removed: lines.filter((line) => line.status === 'removed').length,
    changed: lines.filter((line) => line.status === 'changed').length,
    unchanged: lines.filter((line) => line.status === 'unchanged').length,
  };
  const baselineBefore = groupBaseline([...before.values()]);
  const baselineAfter = groupBaseline([...after.values()]);
  return {
    lines,
    counts,
    ambiguousKeys: [...ambiguousKeys].sort(),
    baselineBefore,
    baselineAfter,
    baselineDelta: baselineDelta(baselineBefore, baselineAfter),
    baselineNote:
      'grouped by currency, charge type, interval AND interval count. Never summed into one number and never converted: '
      + 'a one-time fee, a monthly charge and a quarterly charge (month x 3) are three different kinds of money, and no FX exists here. '
      + 'No MRR, ARR or TCV is computed anywhere.',
  };
}

function shapeOnly(entry) {
  return {
    quantity: entry.quantity,
    netAmountCents: entry.netAmountCents,
    currency: entry.currency,
    chargeType: entry.chargeType,
    interval: entry.interval,
    intervalCount: entry.intervalCount,
  };
}

/**
 * The classification, **derived** from the delta and never supplied.
 *
 * The narrow labels are claimed only when the evidence supports exactly one
 * reading. In particular a price movement with no quantity movement is
 * deliberately **not** `expansion`: nothing about it expanded, and calling a
 * mid-term uplift an expansion is the kind of marketing-friendly label a
 * commercial record must not manufacture. It is `commercial_change`, with the
 * same exact per-line delta attached as every other label.
 *
 * @param {ReturnType<typeof deriveDelta>} delta
 */
export function classifyDelta(delta) {
  if (delta.ambiguousKeys.length > 0) {
    return {
      classification: 'commercial_change',
      basis: 'a line identity appears more than once on one side, so the two agreements cannot be matched line for line; '
        + 'a narrower label would be a guess and is left unclaimed',
    };
  }
  if (delta.counts.added === 0 && delta.counts.removed === 0 && delta.counts.changed === 0) {
    return {
      classification: 'renewal',
      basis: 'every line is present on both sides with the same quantity, amount, currency and recurrence',
    };
  }

  let up = 0;
  let down = 0;
  for (const line of delta.lines) {
    if (line.status === 'added') { up += 1; continue; }
    if (line.status === 'removed') { down += 1; continue; }
    if (line.status !== 'changed') continue;
    // A changed recurrence or currency is not a size movement at all: the two
    // amounts are not comparable, so no direction can be derived from them.
    if (line.changedFields.some((field) => field !== 'quantity' && field !== 'netAmountCents')) {
      return {
        classification: 'commercial_change',
        basis: `line "${line.key}" changed its currency, charge type or recurrence, so no expansion or contraction can be derived from it`,
      };
    }
    if (!line.changedFields.includes('quantity')) {
      return {
        classification: 'commercial_change',
        basis: `line "${line.key}" changed amount without changing quantity — a pricing change, which is neither an expansion nor a contraction`,
      };
    }
    if (line.after.quantity > line.before.quantity) up += 1;
    else down += 1;
  }
  if (up > 0 && down > 0) {
    return { classification: 'mixed', basis: 'quantities moved in both directions, and/or lines were both added and removed' };
  }
  if (up > 0) return { classification: 'expansion', basis: 'quantities only increased, and/or lines were only added' };
  if (down > 0) return { classification: 'contraction', basis: 'quantities only decreased, and/or lines were only removed' };
  return { classification: 'commercial_change', basis: 'the delta is non-empty but no direction could be derived from it' };
}

/**
 * How the successor term sits against the source term.
 *
 * Only one relation is incoherent and blocking — a successor that starts before
 * the source agreement itself started. An overlap is a real mid-term amendment
 * and a gap is a real lapse followed by a re-signing; recording either as a
 * refusal would force somebody to lie about dates to get their own history in.
 *
 * `termEndDate` is **inclusive** throughout, which decides the arithmetic: a
 * successor starting the day after the source's end date is `contiguous` with
 * `gapDays: 0`.
 *
 * @param {{startDate: string|null, endDate: string|null}} source
 * @param {{termStartDate: string, termEndDate: string}} successor
 */
export function termContinuity(source, successor) {
  if (!source.endDate || !successor?.termStartDate) {
    return {
      relation: 'unknown',
      gapDays: null,
      note: 'the source agreement has no readable term end date, so continuity cannot be derived and is not asserted',
    };
  }
  const days = calendarDaysBetween(source.endDate, successor.termStartDate);
  if (days === null) {
    return { relation: 'unknown', gapDays: null, note: 'one of the two term boundaries is not a canonical calendar date' };
  }
  // days === 1 means the successor starts the day after the inclusive end.
  const gapDays = days - 1;
  if (gapDays === 0) {
    return { relation: 'contiguous', gapDays: 0, note: 'the successor term begins the day after the source term ends (end dates are inclusive)' };
  }
  if (gapDays > 0) {
    return { relation: 'gap', gapDays, note: `${gapDays} day(s) are covered by neither agreement. Recorded, not refused: a lapse followed by a re-signing is a real history` };
  }
  return {
    relation: 'overlap',
    gapDays,
    note: `${-gapDays} day(s) are covered by both agreements. Recorded, not refused: a mid-term amendment overlaps by construction`,
  };
}

/* ------------------------------------------------------------------------ */

function safeGet(service, id) {
  try { return service.get(id); } catch { return null; }
}

/** Frozen public shape of one lineage row. */
function freezeSuccession(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    sourceContractId: row.sourceContractId,
    sourceContractVersionId: row.sourceContractVersionId,
    sourceSubscriptionId: row.sourceSubscriptionId,
    sourceOrderId: row.sourceOrderId,
    successorContractId: row.successorContractId,
    successorContractVersionId: row.successorContractVersionId,
    successorSubscriptionId: row.successorSubscriptionId,
    successorOrderId: row.successorOrderId,
    successorActivationId: row.successorActivationId,
    executionRef: row.executionRef,
    companyId: row.companyId,
    customerName: row.customerName,
    currency: row.currency,
    classification: row.classification,
    classificationBasis: row.classificationBasis,
    addedLineCount: row.addedLineCount,
    removedLineCount: row.removedLineCount,
    changedLineCount: row.changedLineCount,
    unchangedLineCount: row.unchangedLineCount,
    sourceTermStartDate: row.sourceTermStartDate,
    sourceTermEndDate: row.sourceTermEndDate,
    sourceTermsSource: row.sourceTermsSource,
    sourceTermSigned: row.sourceTermSigned === true || row.sourceTermSigned === 1,
    successorTermStartDate: row.successorTermStartDate,
    successorTermEndDate: row.successorTermEndDate,
    successorTermsSource: row.successorTermsSource,
    successorTermsFingerprint: row.successorTermsFingerprint,
    termContinuity: row.termContinuity,
    termGapDays: row.termGapDays,
    documentHash: row.documentHash,
    policy: row.policy,
    policyVersion: row.policyVersion,
    policyFingerprint: row.policyFingerprint,
    executedBy: row.executedBy,
    executedAt: row.executedAt,
    deltaJson: row.deltaJson,
  });
}

/**
 * The source agreement's term, with the provenance derived in exactly one
 * place — `TERM_SOURCE_SIGNED`, the same map `contract-lifecycle-source@2`
 * derives from. The three provenances never collapse into one badge: signed,
 * post-signature operational, or a source nobody classified.
 */
function sourceTermEvidence(contract) {
  const signed = termSignedState(contract.termsSource);
  return Object.freeze({
    startDate: contract.termStartDate ?? null,
    endDate: contract.termEndDate ?? null,
    endDateIsInclusive: true,
    days: contract.termDays ?? null,
    autoRenew: Boolean(contract.autoRenew),
    renewalNoticeDays: contract.renewalNoticeDays ?? null,
    source: contract.termsSource ?? null,
    reason: contract.termsReason ?? null,
    signed,
    signedBasis: contract.termsSource == null
      ? 'NO_DECLARED_TERM_SOURCE'
      : signed === null ? 'UNCLASSIFIED_TERM_SOURCE' : 'DERIVED_FROM_DECLARED_TERM_SOURCE',
    provenanceNote: signed === true
      ? SIGNED_TERMS_NOTE
      : signed === false
        ? 'these dates are post-signature OPERATIONAL metadata recorded at activation (M12). They are not signed renewal terms, and nothing here should be reported as one'
        : 'this term names a provenance nobody classified; whether it was signed is unknown and must be surfaced as a gap, never asserted either way',
  });
}

/**
 * `contracts-successor-activation@1` — plan a successor, execute one, and read
 * the lineage. Offered by Contracts, sized by its one real consumer (Lifecycle).
 *
 * The capability is created per call with the **caller's** runtime handles, so
 * every read and every write happens inside the caller's transaction while
 * Contracts keeps its storage private. That is what makes the successor, its
 * subscription, its obligations and the lineage row one atomic commit across a
 * package boundary.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createSuccessorActivationCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: SUCCESSION_CAPABILITY.name,
    version: SUCCESSION_CAPABILITY.version,
    description:
      'Plan and execute a governed successor commercial agreement from a signed immutable Order, and read the immutable lineage it produced. '
      + 'Planning writes nothing; execution recomputes every fact inside the caller\'s transaction and refuses an Order whose signed document '
      + 'carried no term. Grants no storage handle, mutates no historical record, and cancels, schedules, prices and bills nothing.',
    /** @param {{modules?: any, domains?: any, actor?: unknown, now?: () => string}} context */
    create(context = {}) {
      const modules = context.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError(`${SUCCESSION_CAPABILITY.name} requires the caller's modules view`, {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const domains = context.domains ?? null;
      // The lineage record is what this capability exists to write; a project
      // that composed the package without applying the manifest gets a
      // sentence at the boundary rather than a NotFoundError from three calls
      // deeper, where it reads as "the contract is missing".
      let successionModule = null;
      try { successionModule = modules.get(names.succession); } catch { successionModule = null; }
      if (!successionModule?.service?.createManaged) {
        throw new AppError(
          `The contracts package is installed without its "${names.succession}" records, so successor lineage cannot be recorded. `
          + 'Apply packages/contracts/modules/contract-succession.module.json.',
          { code: 'CONTRACT_STORAGE_INVALID', status: 500 },
        );
      }

      /** Everything both entry points need, derived once. */
      function derive({ sourceContractId, successorOrderId, policy, policyVersion, overrides }) {
        /** @type {any[]} */
        const refusals = [];
        const successions = trusted(modules, names.succession);

        const contract = typeof sourceContractId === 'string' && sourceContractId !== ''
          ? safeGet(trusted(modules, names.contract), sourceContractId) : null;
        if (!contract) {
          refusals.push(refusal('SOURCE_CONTRACT_NOT_FOUND', 'The source commercial contract does not exist', 404,
            { sourceContractId: String(sourceContractId ?? '') }));
          return { coherent: false, refusals, source: null, successor: null, delta: null };
        }
        if (!contract.currentVersionId) {
          refusals.push(refusal('SOURCE_CONTRACT_INCOHERENT', 'The source contract has no current version', 409,
            { sourceContractId: contract.id }));
        }
        const sourceTerm = sourceTermEvidence(contract);
        if (sourceTerm.signed === null && sourceTerm.source !== null) {
          refusals.push(refusal('SOURCE_TERM_PROVENANCE_UNCLASSIFIED',
            'The source contract names a term provenance nobody classified, so nothing may be derived from its term', 409,
            { termsSource: sourceTerm.source }));
        }

        // Exact indexed reads, never a paged scan: both guards must be
        // complete, not the first 500 rows.
        const sourceLines = trusted(modules, names.contractLine)
          .listWhere({ contractId: contract.id })
          .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
        const sourceSubscription = trusted(modules, names.subscription).listWhere({ contractId: contract.id })[0] ?? null;
        if (sourceLines.length === 0) {
          refusals.push(refusal('SOURCE_CONTRACT_INCOHERENT', 'The source contract carries no contract lines', 409,
            { sourceContractId: contract.id }));
        }
        if (sourceSubscription) {
          const strayLine = trusted(modules, names.subscriptionLine)
            .listWhere({ subscriptionId: sourceSubscription.id })
            .find((row) => row.contractId !== contract.id);
          if (strayLine) {
            refusals.push(refusal('SOURCE_CONTRACT_INCOHERENT',
              'A subscription line under this contract names a different contract', 409,
              { subscriptionLineId: strayLine.id }));
          }
        }

        const existing = freezeSuccession(successions.listWhere({ sourceContractId: contract.id })[0] ?? null);
        if (existing) {
          refusals.push(refusal('CONFLICTING_SUCCESSOR',
            'This contract already has a successor agreement; a contract is succeeded exactly once', 409,
            { successionId: existing.id, successorContractId: existing.successorContractId }));
        }

        const source = Object.freeze({
          contractId: contract.id,
          status: contract.status,
          currency: contract.currency,
          companyId: contract.companyId ?? null,
          contactId: contract.contactId ?? null,
          customerName: contract.customerName ?? null,
          customerEmail: contract.customerEmail ?? null,
          orderId: contract.orderId,
          currentVersionId: contract.currentVersionId ?? null,
          subscriptionId: sourceSubscription?.id ?? null,
          documentHash: contract.documentHash ?? null,
          lineCount: sourceLines.length,
          term: sourceTerm,
        });

        const orders = trusted(modules, names.order);
        const order = typeof successorOrderId === 'string' && successorOrderId !== ''
          ? safeGet(orders, successorOrderId) : null;
        if (!order) {
          refusals.push(refusal('SUCCESSOR_ORDER_NOT_FOUND', 'The successor order does not exist', 404,
            { successorOrderId: String(successorOrderId ?? '') }));
          return { coherent: false, refusals, source, successor: null, delta: null, existing, sourceLines, contract };
        }
        if (order.id === contract.orderId) {
          refusals.push(refusal('SUCCESSOR_ORDER_IS_SOURCE_ORDER',
            'The successor order is the order this contract was activated from; an agreement cannot succeed itself', 409,
            { orderId: order.id }));
        }

        /** @type {any} */
        let evidence = null;
        try {
          evidence = loadActivationSource(modules, names, order);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          refusals.push(refusal(error.code ?? 'SOURCE_INCOHERENT', error.message, error.status ?? 409,
            /** @type {any} */ (error).details ?? null));
        }

        let successor = null;
        let delta = null;
        let classification = null;
        let continuity = { relation: 'unknown', gapDays: null, note: 'not derived: the successor order could not be read' };
        let decisions = null;

        if (evidence) {
          // **The core invariant.** No signed term snapshot, no successor.
          if (!evidence.signedTerm) {
            refusals.push(refusal('SUCCESSOR_TERMS_NOT_SIGNED',
              'The successor order carries no signed commercial term: its signed document contained none, so a successor term cannot be '
              + 'claimed as signed. Post-signature operational dates are never promoted to signed renewal terms.', 409,
              { successorOrderId: order.id, documentHash: order.documentHash }));
          }
          if (!customerMatches(contract, order)) {
            refusals.push(refusal('SUCCESSOR_CUSTOMER_MISMATCH',
              'The successor order belongs to a different customer than the source contract', 409,
              {
                sourceCompanyId: contract.companyId ?? null,
                successorCompanyId: order.companyId ?? null,
              }));
          }
          const alreadyActivated = trusted(modules, names.contract).listWhere({ orderId: order.id })[0] ?? null;
          if (alreadyActivated) {
            refusals.push(refusal('ORDER_ALREADY_ACTIVATED', 'This order is already activated', 409,
              { contractId: alreadyActivated.id }));
          }
          const consumed = successions.listWhere({ successorOrderId: order.id })[0] ?? null;
          if (consumed) {
            refusals.push(refusal('SUCCESSOR_ORDER_ALREADY_CONSUMED',
              'This order is already the successor of another agreement', 409, { successionId: consumed.id }));
          }

          const signedTerm = evidence.signedTerm ? signedTermFromSnapshot(evidence.signedTerm) : null;
          if (signedTerm) {
            continuity = termContinuity(sourceTerm, signedTerm);
            if (sourceTerm.startDate
              && calendarDaysBetween(sourceTerm.startDate, signedTerm.termStartDate) !== null
              && calendarDaysBetween(sourceTerm.startDate, signedTerm.termStartDate) < 0) {
              refusals.push(refusal('SUCCESSOR_TERM_PRECEDES_SOURCE',
                'The successor term starts before the source agreement started', 409,
                { sourceTermStartDate: sourceTerm.startDate, successorTermStartDate: signedTerm.termStartDate }));
            }
          }

          delta = deriveDelta(sourceLines, evidence.components, order.currency ?? null);
          const derived = classifyDelta(delta);
          classification = derived;

          successor = Object.freeze({
            orderId: order.id,
            quoteId: order.quoteId ?? null,
            quoteVersionId: order.quoteVersionId ?? null,
            documentHash: order.documentHash,
            artifactHash: order.artifactHash ?? null,
            companyId: order.companyId ?? null,
            contactId: order.contactId ?? null,
            customerName: order.customerName ?? null,
            customerEmail: order.customerEmail ?? null,
            currency: order.currency,
            componentCount: evidence.components.length,
            term: signedTerm
              ? Object.freeze({
                effectiveDate: signedTerm.effectiveDate,
                startDate: signedTerm.termStartDate,
                endDate: signedTerm.termEndDate,
                endDateIsInclusive: true,
                days: signedTerm.termDays,
                autoRenew: signedTerm.autoRenew,
                renewalNoticeDays: signedTerm.renewalNoticeDays,
                source: SIGNED_TERMS_SOURCE,
                signed: true,
                signedBasis: 'DERIVED_FROM_DECLARED_TERM_SOURCE',
                provenanceNote: SIGNED_TERMS_NOTE,
                termsFingerprint: evidence.signedTerm.termsFingerprint,
              })
              : null,
            termsProvenance: signedTerm
              ? { source: SIGNED_TERMS_SOURCE, signed: true, note: SIGNED_TERMS_NOTE }
              : {
                source: null,
                signed: false,
                note: 'this order\'s signed document carried no commercial term. Any dates recorded against it would be post-signature '
                  + 'operational metadata, and M16b refuses to build a successor agreement on them',
              },
          });

          // The policy is optional for a plan and mandatory for an execution.
          if (policy && domains) {
            const resolved = domains.getPolicy('contracts', POLICY_KIND, policy, policyVersion);
            const normalized = normalizeOverrides(overrides, new Set(evidence.components.map(({ component }) => component.id)));
            decisions = classifyComponents({
              policy: resolved.definition,
              fingerprint: resolved.fingerprint,
              order,
              components: evidence.components,
              overrides: normalized,
            });
            const ambiguous = decisions.filter((decision) => decision.ambiguousDimensions.length > 0);
            if (ambiguous.length > 0) {
              refusals.push(refusal('CLASSIFICATION_AMBIGUOUS',
                `${ambiguous.length} order component(s) could not be classified and need an explicit human override`, 409,
                {
                  orderComponentIds: ambiguous.map((decision) => decision.component.id),
                  dimensions: ambiguous.map((decision) => ({
                    orderComponentId: decision.component.id,
                    dimensions: decision.ambiguousDimensions,
                  })),
                }));
            }
            decisions = { decisions, policy: resolved.definition, fingerprint: resolved.fingerprint };
          }
        }

        return {
          coherent: refusals.length === 0,
          refusals,
          source,
          successor,
          delta,
          classification,
          continuity,
          existing,
          sourceLines,
          contract,
          order,
          evidence,
          decisions,
        };
      }

      return Object.freeze({
        capabilityContract: 1,

        /**
         * What executing this pairing would do, and every reason it would be
         * refused — **writing nothing at all**: no record, no audit entry, no
         * domain event. A plan is never an authorisation; `executeSuccession`
         * recomputes all of it inside its own transaction.
         */
        planSuccession(request = {}) {
          const derived = derive({
            sourceContractId: request.sourceContractId,
            successorOrderId: request.successorOrderId,
            policy: request.policy ?? null,
            policyVersion: request.policyVersion ?? null,
            overrides: request.classificationOverrides ?? null,
          });
          return Object.freeze({
            successionContract: 1,
            writes: 'nothing — this is a read-only plan',
            sourceContractId: request.sourceContractId ?? null,
            successorOrderId: request.successorOrderId ?? null,
            coherent: derived.coherent,
            refusals: Object.freeze(derived.refusals),
            source: derived.source,
            successor: derived.successor,
            termContinuity: derived.continuity ? Object.freeze({ ...derived.continuity }) : null,
            delta: derived.delta,
            classification: derived.classification?.classification ?? null,
            classificationBasis: derived.classification?.basis ?? null,
            classificationVocabulary: [...CLASSIFICATIONS],
            existingSuccession: derived.existing ?? null,
            notModeled: [...NOT_MODELED],
            limitations: Object.freeze([
              'NO_SCHEDULER — nothing here fires on a date, and no term renews itself',
              'NOT_A_LEGAL_INSTRUMENT — the successor agreement is evidence assembled from a signed order, not a legal opinion about it',
              'SIGNED_TERM_REQUIRED — an order whose signed document carried no term cannot produce a successor agreement',
              'NO_BILLING — no invoice, payment, tax, proration or revenue recognition exists to follow from this',
              'NO_NOTIFICATION — nobody is told that any of this happened',
            ]),
          });
        },

        /**
         * Execute the successor agreement, inside the caller's transaction.
         *
         * Every fact is recomputed here from immutable evidence — a plan the
         * caller computed earlier is never trusted, and no classification the
         * caller supplies is accepted. The first refusal is thrown, whole:
         * partial execution is not a state this framework produces.
         */
        async executeSuccession(request = {}) {
          const actor = request.actor ?? context.actor;
          if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
            throw new AppError('Executing a successor commercial agreement requires a human user actor', {
              code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
            });
          }
          if (typeof request.policy !== 'string' || request.policy === '' || !Number.isSafeInteger(request.policyVersion)) {
            throw new AppError('An explicit order activation policy name and version are required', {
              code: 'ACTIVATION_POLICY_REQUIRED', status: 400,
            });
          }
          if (typeof request.executionRef !== 'string' || request.executionRef === '' || request.executionRef.length > 200) {
            throw new AppError('An execution reference is required', { code: 'EXECUTION_REF_REQUIRED', status: 400 });
          }

          const derived = derive({
            sourceContractId: request.sourceContractId,
            successorOrderId: request.successorOrderId,
            policy: request.policy,
            policyVersion: request.policyVersion,
            overrides: request.classificationOverrides ?? null,
          });
          if (derived.refusals.length > 0) throw asError(derived.refusals[0]);

          const now = typeof context.now === 'function' ? context.now : () => new Date().toISOString();
          const activatedAt = now();
          const term = signedTermFromSnapshot(derived.evidence.signedTerm);

          let written;
          try {
            written = await writeActivation({
              order: derived.order,
              source: derived.evidence,
              term,
              policy: derived.decisions.policy,
              fingerprint: derived.decisions.fingerprint,
              decisions: derived.decisions.decisions,
              actor,
              modules,
              names,
              activatedAt,
            });
          } catch (error) {
            throw translateRace(error, 'ORDER_ALREADY_ACTIVATED',
              'This order was activated by another connection while this execution was running');
          }

          const delta = derived.delta;
          const classification = derived.classification;
          const continuity = derived.continuity;
          const successions = trusted(modules, names.succession);
          let lineage;
          try {
            lineage = await successions.createManaged({
              // The lineage's identity is the source agreement: a contract is
              // succeeded exactly once, so nothing smaller identifies it and
              // no clock belongs in it.
              sourceKey: `contract-succession:${derived.source.contractId}`,
              sourceContractId: derived.source.contractId,
              sourceContractVersionId: derived.source.currentVersionId,
              sourceSubscriptionId: derived.source.subscriptionId,
              sourceOrderId: derived.source.orderId,
              successorContractId: written.contract.id,
              successorContractVersionId: written.version.id,
              successorSubscriptionId: written.subscription?.id ?? null,
              successorOrderId: derived.order.id,
              successorActivationId: written.activation.id,
              executionRef: request.executionRef,
              companyId: derived.source.companyId,
              customerName: derived.source.customerName,
              currency: derived.order.currency,
              classification: classification.classification,
              classificationBasis: classification.basis,
              deltaJson: toJson(delta, 'successor delta'),
              addedLineCount: delta.counts.added,
              removedLineCount: delta.counts.removed,
              changedLineCount: delta.counts.changed,
              unchangedLineCount: delta.counts.unchanged,
              sourceTermStartDate: derived.source.term.startDate,
              sourceTermEndDate: derived.source.term.endDate,
              sourceTermsSource: derived.source.term.source,
              sourceTermSigned: derived.source.term.signed === true,
              successorTermStartDate: term.termStartDate,
              successorTermEndDate: term.termEndDate,
              successorTermsSource: term.termsSource,
              successorTermsFingerprint: derived.evidence.signedTerm.termsFingerprint,
              termContinuity: continuity.relation,
              termGapDays: continuity.gapDays,
              documentHash: derived.order.documentHash,
              policy: derived.decisions.policy.name,
              policyVersion: derived.decisions.policy.version,
              policyFingerprint: derived.decisions.fingerprint,
              executedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
              executedAt: activatedAt,
            }, { actor });
          } catch (error) {
            throw translateRace(error, 'CONFLICTING_SUCCESSOR',
              'Another connection recorded a successor for this agreement while this execution was running');
          }

          return {
            succession: freezeSuccession(lineage),
            successorContractId: written.contract.id,
            successorContractVersionId: written.version.id,
            successorSubscriptionId: written.subscription?.id ?? null,
            successorActivationId: written.activation.id,
            successorStatus: written.state,
            counts: written.counts,
            classification: classification.classification,
            classificationBasis: classification.basis,
            termContinuity: continuity.relation,
            termGapDays: continuity.gapDays,
            delta,
          };
        },

        /** The lineage recorded for one source agreement, or null. */
        succession(sourceContractId) {
          if (typeof sourceContractId !== 'string' || sourceContractId === '') return null;
          return freezeSuccession(trusted(modules, names.succession).listWhere({ sourceContractId })[0] ?? null);
        },

        /** The lineage that produced one successor agreement, or null. */
        successionBySuccessor(successorContractId) {
          if (typeof successorContractId !== 'string' || successorContractId === '') return null;
          return freezeSuccession(trusted(modules, names.succession).listWhere({ successorContractId })[0] ?? null);
        },

        /** The lineage that consumed one signed order, or null. */
        successionByOrder(successorOrderId) {
          if (typeof successorOrderId !== 'string' || successorOrderId === '') return null;
          return freezeSuccession(trusted(modules, names.succession).listWhere({ successorOrderId })[0] ?? null);
        },
      });
    },
  };
}

/**
 * Customer coherence between the source agreement and the successor Order.
 *
 * `companyId` decides it when both sides have one — it is the CRM identity the
 * Order snapshotted at signature. When either side has none (an order raised
 * without a company), the snapshotted customer email is the fallback, and when
 * neither is comparable the pairing is refused rather than assumed: a successor
 * agreement for the wrong customer is the single worst record this milestone
 * could produce.
 */
function customerMatches(contract, order) {
  if (contract.companyId && order.companyId) return contract.companyId === order.companyId;
  if (contract.customerEmail && order.customerEmail) {
    return String(contract.customerEmail).toLowerCase() === String(order.customerEmail).toLowerCase();
  }
  return false;
}

/**
 * A lost insert race, answered as the business refusal it is.
 *
 * The generated services normalize `UNIQUE constraint failed` into a
 * `ConflictError` before it leaves the module, so no driver text ever reaches a
 * client. This maps that normalized error onto the stable code for the column
 * that decided the race, and **re-throws** rather than replaying: the losing
 * connection has already written rows in this transaction, and answering it
 * from the winner's row would commit a partial successor. It rolls back whole.
 */
function translateRace(error, code, message) {
  const isUnique = error instanceof AppError && error.status === 409
    && /already exists|unique constraint/i.test(String(error.message));
  if (!isUnique) return error;
  return new AppError(message, { code, status: 409 });
}
