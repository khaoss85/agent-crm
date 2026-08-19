// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { normalizePolicyResult } from './registry.js';
import { requireSignedTerm } from './terms.js';
import {
  computeLineBreakdown,
  groupComponentTotals,
  effectiveDiscountBps,
  maxLineDiscountBps,
} from './money.js';

/**
 * Commercial Operations quote actions (ADR-016), framework-provided and
 * starter-registered like move-stage/enrich:
 *
 *   opportunity.create-quote           (opportunity is action-eligible core)
 *   quote.add-line / update-line / remove-line   (draft only, server-priced)
 *   quote.submit                       (immutable version + discount policy)
 *   quote.approve / quote.reject       (human actor only, one decision)
 *   quote.revise                       (rejected → draft, next version n+1)
 *
 * A quote line selects ONE Offer (rate plan) and a quantity. The offer's price
 * components — any mixture of one-time and recurring, flat_fee / per_unit /
 * volume / graduated — are priced server-side from the pinned offer revision.
 * Clients never submit a unit price, a tier definition or a total.
 *
 * Quantity semantics (ADR-016): flat_fee components are charged ONCE per line
 * (line quantity does not multiply them); per_unit multiplies by quantity;
 * volume prices the whole quantity at the tier the quantity reaches; graduated
 * prices each band independently. Totals are GROUPED by commercial period —
 * one one-time group plus one per (currency, interval, intervalCount) — and
 * unlike periods are never summed into a single misleading grand total.
 */

/** @typedef {{
 *   quoteModule?: string, lineModule?: string, versionModule?: string,
 *   versionLineModule?: string, versionComponentModule?: string,
 *   versionTotalModule?: string, approvalModule?: string,
 *   priceBookModule?: string, offerModule?: string, componentModule?: string,
 *   tierModule?: string, productVersionModule?: string,
 *   quoteTermModule?: string, versionTermModule?: string,
 * }} CommercialActionConfig */

/** @param {CommercialActionConfig} [config] */
function resolved(config = {}) {
  return {
    quoteModule: config.quoteModule ?? 'quote',
    lineModule: config.lineModule ?? 'quote-line',
    versionModule: config.versionModule ?? 'quote-version',
    versionLineModule: config.versionLineModule ?? 'quote-version-line',
    versionComponentModule: config.versionComponentModule ?? 'quote-version-component',
    versionTotalModule: config.versionTotalModule ?? 'quote-version-total',
    approvalModule: config.approvalModule ?? 'quote-approval',
    priceBookModule: config.priceBookModule ?? 'price-book',
    offerModule: config.offerModule ?? 'offer',
    componentModule: config.componentModule ?? 'price-component',
    tierModule: config.tierModule ?? 'price-tier',
    productVersionModule: config.productVersionModule ?? 'product-version',
    quoteTermModule: config.quoteTermModule ?? 'quote-term',
    versionTermModule: config.versionTermModule ?? 'quote-version-term',
  };
}

function trusted(modules, name) {
  const service = modules.get(name).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'COMMERCIAL_STORAGE_INVALID',
      status: 500,
    });
  }
  return service;
}

/**
 * A record module a project may not have applied. Terms shipped after the
 * first commercial projects did: a project without the `quote-term` manifest
 * keeps its exact pre-terms behaviour — submit sees no draft term and
 * freezes no snapshot — rather than failing on a module lookup.
 * @param {any} modules @param {string} name
 */
function optionalService(modules, name) {
  try {
    return modules.get(name)?.service ?? null;
  } catch {
    return null;
  }
}

/** Bounded JSON for server-generated evidence blobs (breakdowns, schedules). */
function toJson(value) {
  const text = JSON.stringify(value);
  if (text.length > 60_000) {
    throw new AppError('The calculated breakdown exceeds the storable bound', { code: 'BREAKDOWN_TOO_LARGE', status: 409 });
  }
  return text;
}

/** @param {string | null | undefined} text */
function fromJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Load a pinned offer revision with its immutable components and tier
 * schedules, in deterministic order. Exact indexed reads only.
 */
function loadOfferPricing(modules, cfg, offerId) {
  const offer = trusted(modules, cfg.offerModule).get(offerId);
  const components = trusted(modules, cfg.componentModule)
    .listWhere({ offerId: offer.id })
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
  const tierService = trusted(modules, cfg.tierModule);
  const priced = components.map((component) => ({
    id: component.id,
    sourceKey: component.sourceKey,
    componentKey: component.componentKey,
    label: component.label,
    position: component.position,
    chargeType: component.chargeType,
    pricingModel: component.pricingModel,
    interval: component.interval,
    intervalCount: component.intervalCount,
    unitAmountCents: component.unitAmountCents,
    flatAmountCents: component.flatAmountCents,
    currency: component.currency,
    provider: component.provider,
    externalPriceId: component.externalPriceId,
    sourcePricingModel: component.sourcePricingModel,
    tiers: tierService
      .listWhere({ componentId: component.id })
      .sort((a, b) => a.position - b.position)
      .map((tier) => ({
        position: tier.position,
        upTo: tier.upToQuantity,
        unitAmountCents: tier.unitAmountCents,
        flatAmountCents: tier.flatAmountCents,
      })),
  }));
  return { offer, components: priced };
}

/** Draft-revision optimistic concurrency guard. */
function checkRevision(quote, input) {
  if (input.expectedRevision !== undefined && input.expectedRevision !== quote.draftRevision) {
    throw new AppError(
      `Stale draft revision: expected ${input.expectedRevision}, quote is at ${quote.draftRevision}`,
      { code: 'STALE_REVISION', status: 409, details: { draftRevision: quote.draftRevision } },
    );
  }
}

/** Active (non-removed) draft lines in deterministic order. */
function activeLines(modules, cfg, quoteId) {
  return trusted(modules, cfg.lineModule)
    .listWhere({ quoteId, removed: false })
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
}

/** Every component amount across the quote's active lines, in line order. */
function quoteComponentAmounts(lines) {
  const out = [];
  for (const line of lines) {
    const breakdown = fromJson(line.breakdownJson);
    for (const component of breakdown?.components ?? []) out.push(component);
  }
  return out;
}

/**
 * Recalculate the quote's grouped totals from its active lines and bump the
 * draft revision — atomically with whatever edit triggered it.
 */
async function recalc(modules, cfg, quote, managed) {
  const lines = activeLines(modules, cfg, quote.id);
  const totals = groupComponentTotals(quoteComponentAmounts(lines), quote.currency);
  return managed(quote.id, {
    totalsJson: toJson(totals),
    oneTimeNetCents: totals.oneTimeTotal.netAmountCents,
    recurringGroupCount: totals.recurringTotals.length,
    draftRevision: quote.draftRevision + 1,
  });
}

/**
 * opportunity.create-quote — validate the Price Book and open a draft Quote
 * bound to exactly one Price Book and one currency.
 * @param {CommercialActionConfig} [config]
 */
export function buildCreateQuoteAction(config) {
  const cfg = resolved(config);
  return {
    module: 'opportunity',
    name: 'create-quote',
    label: 'Create quote',
    description: 'Open a draft quote for this opportunity against one price book.',
    actionContract: 1,
    input: [
      { name: 'priceBookId', type: 'string', required: true, hint: 'Active price book id (see the price-book module).' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, step }) {
      const book = trusted(modules, cfg.priceBookModule).get(input.priceBookId);
      if (book.active !== true) {
        throw new AppError(`Price book "${book.id}" is not active`, { code: 'PRICE_BOOK_INACTIVE', status: 409 });
      }
      const emptyTotals = groupComponentTotals([], book.currency);
      const quote = await trusted(modules, cfg.quoteModule).createManaged(
        {
          opportunityId: record.id,
          priceBookId: book.id,
          currency: book.currency,
          draftRevision: 1,
          totalsJson: toJson(emptyTotals),
          oneTimeNetCents: 0,
          recurringGroupCount: 0,
        },
        { actor },
      );
      step('quote.created', { quoteId: quote.id, priceBookId: book.id, currency: book.currency });
      return { quote: quoteSummary(quote) };
    },
  };
}

/** Shared validation for line-editing actions. */
function requireOwnLine(modules, cfg, quote, lineId) {
  const line = trusted(modules, cfg.lineModule).get(lineId);
  if (line.quoteId !== quote.id) {
    throw new AppError('The line belongs to another quote', { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
  }
  if (line.removed === true) {
    throw new AppError('The line was removed from this draft', { code: 'LINE_REMOVED', status: 409 });
  }
  return line;
}

/** @param {CommercialActionConfig} [config] */
export function buildQuoteLineActions(config) {
  const cfg = resolved(config);

  const addLine = {
    module: cfg.quoteModule,
    name: 'add-line',
    label: 'Add line',
    description: "Add an offer (rate plan) priced from the quote's price book.",
    actionContract: 1,
    stateField: 'status',
    fromStates: ['draft'],
    input: [
      { name: 'offerId', type: 'string', required: true, hint: 'Active, quote-eligible offer id (see the offer module).' },
      { name: 'quantity', type: 'integer', required: true, hint: 'Positive integer (1–1,000,000). Flat fees are charged once; per-unit and tiered components use it.' },
      { name: 'discountBps', type: 'integer', required: false, hint: 'Basis points: 1000 = 10.00%. Applies to every component of this line.' },
      { name: 'expectedRevision', type: 'integer', required: false, hint: 'Optimistic concurrency: current draft revision.' },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, managed, step }) {
      checkRevision(quote, input);
      const { offer, components } = loadOfferPricing(modules, cfg, input.offerId);
      if (offer.priceBookId !== quote.priceBookId) {
        throw new AppError('The offer belongs to another price book', { code: 'PRICE_BOOK_MISMATCH', status: 409 });
      }
      if (offer.active !== true) {
        throw new AppError('The offer revision is no longer active', { code: 'OFFER_INACTIVE', status: 409 });
      }
      if (offer.quoteEligible !== true) {
        throw new AppError(
          `The offer is not quote eligible: ${offer.unsupportedReason ?? 'unsupported provider pricing model'}`,
          { code: 'OFFER_NOT_QUOTE_ELIGIBLE', status: 409 },
        );
      }
      if (offer.currency !== quote.currency) {
        throw new AppError(`Offer currency ${offer.currency} does not match quote currency ${quote.currency}`, { code: 'CURRENCY_MISMATCH', status: 409 });
      }
      if (components.length === 0 || components.length !== offer.componentCount) {
        throw new AppError('The offer has an incomplete component set and cannot be quoted', { code: 'OFFER_INCOMPLETE', status: 409 });
      }
      const productVersion = trusted(modules, cfg.productVersionModule).get(offer.productVersionId);
      const breakdown = computeLineBreakdown({ components, quantity: input.quantity, discountBps: input.discountBps ?? 0 });
      const lines = trusted(modules, cfg.lineModule);
      const line = await lines.createManaged(
        {
          quoteId: quote.id,
          offerId: offer.id,
          offerLogicalKey: offer.logicalKey,
          offerRevision: offer.revision,
          offerName: offer.name,
          productId: offer.productId,
          productVersionId: offer.productVersionId,
          sku: productVersion.sku,
          quantity: input.quantity,
          discountBps: input.discountBps ?? 0,
          componentCount: components.length,
          breakdownJson: toJson(breakdown),
          listAmountCents: breakdown.listAmountCents,
          discountAmountCents: breakdown.discountAmountCents,
          netAmountCents: breakdown.netAmountCents,
          removed: false,
          position: lines.countWhere({ quoteId: quote.id }) + 1,
        },
        { actor },
      );
      step('quote.line-added', { lineId: line.id, offer: offer.logicalKey, quantity: line.quantity, components: components.length });
      const updated = await recalc(modules, cfg, quote, managed);
      return { line: lineSummary(line), quote: quoteSummary(updated) };
    },
  };

  const updateLine = {
    module: cfg.quoteModule,
    name: 'update-line',
    label: 'Update line',
    description: "Change a draft line's quantity or requested discount.",
    actionContract: 1,
    stateField: 'status',
    fromStates: ['draft'],
    input: [
      { name: 'lineId', type: 'string', required: true },
      { name: 'quantity', type: 'integer', required: false },
      { name: 'discountBps', type: 'integer', required: false, hint: 'Basis points: 1000 = 10.00%.' },
      { name: 'expectedRevision', type: 'integer', required: false },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, managed, step }) {
      checkRevision(quote, input);
      if (input.quantity === undefined && input.discountBps === undefined) {
        throw new ValidationError('Provide quantity and/or discountBps to update', { field: 'quantity' });
      }
      const line = requireOwnLine(modules, cfg, quote, input.lineId);
      // Re-price from the PINNED offer revision: a later catalog revision never
      // silently re-prices an existing draft line.
      const { components } = loadOfferPricing(modules, cfg, line.offerId);
      const quantity = input.quantity ?? line.quantity;
      const discountBps = input.discountBps ?? line.discountBps;
      const breakdown = computeLineBreakdown({ components, quantity, discountBps });
      const updatedLine = await trusted(modules, cfg.lineModule).applyManaged(
        line.id,
        {
          quantity,
          discountBps,
          breakdownJson: toJson(breakdown),
          listAmountCents: breakdown.listAmountCents,
          discountAmountCents: breakdown.discountAmountCents,
          netAmountCents: breakdown.netAmountCents,
        },
        { actor },
      );
      step('quote.line-updated', { lineId: line.id, quantity, discountBps });
      const updated = await recalc(modules, cfg, quote, managed);
      return { line: lineSummary(updatedLine), quote: quoteSummary(updated) };
    },
  };

  const removeLine = {
    module: cfg.quoteModule,
    name: 'remove-line',
    label: 'Remove line',
    description: 'Soft-remove a draft line (history preserved).',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['draft'],
    input: [
      { name: 'lineId', type: 'string', required: true },
      { name: 'expectedRevision', type: 'integer', required: false },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, managed, step }) {
      checkRevision(quote, input);
      const line = requireOwnLine(modules, cfg, quote, input.lineId);
      await trusted(modules, cfg.lineModule).applyManaged(line.id, { removed: true }, { actor });
      step('quote.line-removed', { lineId: line.id });
      const updated = await recalc(modules, cfg, quote, managed);
      return { removedLineId: line.id, quote: quoteSummary(updated) };
    },
  };

  return [addLine, updateLine, removeLine];
}

/**
 * @param {CommercialActionConfig|undefined} config
 * @param {{getDiscountPolicy: (name: string, version: number) => {definition: any, fingerprint: string}}} registries
 *   The package's own registries. Before the extraction this arrived as the
 *   ambient `commercial` context key every action received; the action now
 *   closes over the registries the composed package owns (ADR-021 applied to
 *   Commercial), and the ambient key is gone.
 */
export function buildSubmitQuoteAction(config, registries) {
  if (!registries || typeof registries.getDiscountPolicy !== 'function') {
    throw new ValidationError('buildSubmitQuoteAction needs the commercial registries — compose the package rather than registering the action bare');
  }
  const cfg = resolved(config);
  return {
    module: cfg.quoteModule,
    name: 'submit',
    label: 'Submit',
    description: 'Freeze an immutable quote version and evaluate the discount policy.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['draft'],
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered discount policy name (see schema commercial.discountPolicies).' },
      { name: 'version', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
      { name: 'expectedRevision', type: 'integer', required: false },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, services, managed, now, step }) {
      checkRevision(quote, input);
      const lines = activeLines(modules, cfg, quote.id);
      if (lines.length === 0) {
        throw new AppError('A quote needs at least one active line before submission', { code: 'EMPTY_QUOTE', status: 409 });
      }

      // The draft commercial term, when the quote carries one. It is validated
      // HERE — at the gate where it becomes part of the immutable version and
      // therefore of the signable document — and an incoherent draft refuses
      // the whole submission with a field-level error rather than freezing a
      // term nobody could honestly sign. A quote without a draft term submits
      // exactly as it always did, and a project that never applied the
      // quote-term manifest is indistinguishable from one that did and left it
      // empty.
      const draftTerms = optionalService(modules, cfg.quoteTermModule);
      const draftTerm = draftTerms ? (draftTerms.listWhere({ quoteId: quote.id })[0] ?? null) : null;
      const signedTerm = draftTerm
        ? requireSignedTerm({
          effectiveDate: draftTerm.effectiveDate,
          termStartDate: draftTerm.termStartDate,
          termEndDate: draftTerm.termEndDate,
          autoRenew: draftTerm.autoRenew === 1 ? true : draftTerm.autoRenew === 0 ? false : draftTerm.autoRenew,
          renewalNoticeDays: draftTerm.renewalNoticeDays ?? undefined,
        })
        : null;
      const { definition: policy, fingerprint } = registries.getDiscountPolicy(input.policy, input.version);
      const componentAmounts = quoteComponentAmounts(lines);
      const totals = groupComponentTotals(componentAmounts, quote.currency);
      const maxDiscountBps = maxLineDiscountBps(lines);
      const effectiveBps = effectiveDiscountBps(totals);
      const submittedAt = now();

      let opportunity = null;
      try {
        const record = services.opportunities?.get(quote.opportunityId);
        if (record) opportunity = { id: record.id, valueCents: record.valueCents, stage: record.stage, pipelineStage: record.pipelineStage ?? null };
      } catch {
        opportunity = null;
      }

      const context = deepFreeze({
        quote: { id: quote.id, opportunityId: quote.opportunityId, priceBookId: quote.priceBookId, currency: quote.currency },
        opportunity,
        currency: quote.currency,
        oneTimeTotal: totals.oneTimeTotal,
        recurringTotals: totals.recurringTotals,
        maxLineDiscountBps: maxDiscountBps,
        effectiveDiscountBps: effectiveBps,
        lines: lines.map((line) => ({
          offer: line.offerLogicalKey,
          offerRevision: line.offerRevision,
          sku: line.sku,
          quantity: line.quantity,
          discountBps: line.discountBps,
          netAmountCents: line.netAmountCents,
        })),
        components: componentAmounts.map((component) => ({
          chargeType: component.chargeType,
          pricingModel: component.pricingModel,
          interval: component.interval,
          intervalCount: component.intervalCount,
          listAmountCents: component.listAmountCents,
          discountAmountCents: component.discountAmountCents,
          netAmountCents: component.netAmountCents,
        })),
        actor: actor && typeof actor === 'object' ? { type: /** @type {any} */ (actor).type ?? null, id: /** @type {any} */ (actor).id ?? null } : null,
        config: structuredClone(policy.config ?? {}),
      });
      /** @type {unknown} */
      let rawResult;
      try {
        rawResult = policy.evaluate(context);
      } catch (error) {
        throw new AppError(
          `Discount policy "${policy.name}@${policy.version}" threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}) — policies must be total and deterministic`,
          { code: 'DISCOUNT_POLICY_INVALID', status: 500 },
        );
      }
      const result = normalizePolicyResult(`Discount policy "${policy.name}@${policy.version}"`, rawResult);

      const versionNumber = (quote.currentVersionNumber ?? 0) + 1;
      const versions = trusted(modules, cfg.versionModule);
      const version = await versions.createManaged(
        {
          quoteId: quote.id,
          versionNumber,
          sourceKey: `qv:${quote.id}:${versionNumber}`,
          opportunityId: quote.opportunityId,
          priceBookId: quote.priceBookId,
          currency: quote.currency,
          draftRevisionUsed: quote.draftRevision,
          oneTimeListCents: totals.oneTimeTotal.listAmountCents,
          oneTimeDiscountCents: totals.oneTimeTotal.discountAmountCents,
          oneTimeNetCents: totals.oneTimeTotal.netAmountCents,
          recurringGroupCount: totals.recurringTotals.length,
          totalsJson: toJson(totals),
          maxLineDiscountBps: maxDiscountBps,
          effectiveDiscountBps: effectiveBps,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          policyDecision: result.decision,
          decisionReason: result.reason,
          requiredApprovalKey: result.requiredApprovalKey,
          submittedAt,
          submittedBy: actor && typeof actor === 'object' ? String(/** @type {any} */ (actor).id ?? 'unknown') : 'unknown',
        },
        { actor },
      );

      // Immutable per-line and per-component evidence: everything needed to
      // reproduce the commercial decision after any catalog change.
      const versionLines = trusted(modules, cfg.versionLineModule);
      const versionComponents = trusted(modules, cfg.versionComponentModule);
      for (const line of lines) {
        const breakdown = fromJson(line.breakdownJson) ?? { components: [] };
        const versionLine = await versionLines.createManaged(
          {
            versionId: version.id,
            offerId: line.offerId,
            offerLogicalKey: line.offerLogicalKey,
            offerRevision: line.offerRevision,
            offerName: line.offerName,
            productId: line.productId,
            productVersionId: line.productVersionId,
            sku: line.sku,
            quantity: line.quantity,
            discountBps: line.discountBps,
            componentCount: line.componentCount,
            listAmountCents: line.listAmountCents,
            discountAmountCents: line.discountAmountCents,
            netAmountCents: line.netAmountCents,
            position: line.position,
          },
          { actor },
        );
        const priced = loadOfferPricing(modules, cfg, line.offerId);
        const definitionById = new Map(priced.components.map((component) => [component.id, component]));
        for (const component of breakdown.components ?? []) {
          const definition = definitionById.get(component.componentId) ?? null;
          await versionComponents.createManaged(
            {
              versionId: version.id,
              versionLineId: versionLine.id,
              componentId: component.componentId,
              componentKey: component.componentKey,
              label: component.label,
              chargeType: component.chargeType,
              pricingModel: component.pricingModel,
              interval: component.interval,
              intervalCount: component.intervalCount,
              quantity: component.quantity,
              unitAmountCents: component.unitAmountCents,
              flatAmountCents: component.flatAmountCents,
              tiersJson: definition ? toJson(definition.tiers) : null,
              tierBreakdownJson: toJson(component.tierBreakdown ?? []),
              listAmountCents: component.listAmountCents,
              discountAmountCents: component.discountAmountCents,
              netAmountCents: component.netAmountCents,
              provider: definition?.provider ?? null,
              externalPriceId: definition?.externalPriceId ?? null,
              sourcePricingModel: definition?.sourcePricingModel ?? null,
            },
            { actor },
          );
        }
      }
      const versionTotals = trusted(modules, cfg.versionTotalModule);
      await versionTotals.createManaged(
        {
          versionId: version.id,
          kind: 'one_time',
          currency: quote.currency,
          interval: null,
          intervalCount: null,
          listAmountCents: totals.oneTimeTotal.listAmountCents,
          discountAmountCents: totals.oneTimeTotal.discountAmountCents,
          netAmountCents: totals.oneTimeTotal.netAmountCents,
        },
        { actor },
      );
      for (const group of totals.recurringTotals) {
        await versionTotals.createManaged(
          {
            versionId: version.id,
            kind: 'recurring',
            currency: group.currency,
            interval: group.interval,
            intervalCount: group.intervalCount,
            listAmountCents: group.listAmountCents,
            discountAmountCents: group.discountAmountCents,
            netAmountCents: group.netAmountCents,
          },
          { actor },
        );
      }
      // The signed-term snapshot: write-once, same transaction as the version.
      // From this row the canonical document builds its `terms` section, so
      // the documentHash covers exactly these values — a term change after
      // this moment is a new version with a new hash, like any priced line.
      if (signedTerm) {
        await trusted(modules, cfg.versionTermModule).createManaged(
          {
            versionId: version.id,
            quoteId: quote.id,
            sourceKey: `qvt:${version.id}`,
            effectiveDate: signedTerm.effectiveDate,
            termStartDate: signedTerm.termStartDate,
            termEndDate: signedTerm.termEndDate,
            termDays: signedTerm.termDays,
            autoRenew: signedTerm.autoRenew,
            renewalNoticeDays: signedTerm.renewalNoticeDays,
            termsContract: signedTerm.termsContract,
            termsFingerprint: signedTerm.termsFingerprint,
          },
          { actor },
        );
        step('quote.term-frozen', { versionId: version.id, termsFingerprint: signedTerm.termsFingerprint });
      }
      step('quote.version-created', { versionId: version.id, versionNumber, decision: result.decision, recurringGroups: totals.recurringTotals.length });

      let approvalId = null;
      let status = 'approved';
      if (result.decision === 'approval_required') {
        const approval = await trusted(modules, cfg.approvalModule).createManaged(
          {
            quoteId: quote.id,
            quoteVersionId: version.id,
            sourceKey: `qa:${version.id}`,
            policy: policy.name,
            policyVersion: policy.version,
            policyFingerprint: fingerprint,
            maxLineDiscountBps: maxDiscountBps,
            effectiveDiscountBps: effectiveBps,
            requiredApprovalKey: result.requiredApprovalKey,
            reason: result.reason,
            requestedBy: actor && typeof actor === 'object' ? String(/** @type {any} */ (actor).id ?? 'unknown') : 'unknown',
            requestedAt: submittedAt,
          },
          { actor },
        );
        approvalId = approval.id;
        status = 'pending_approval';
        step('quote.approval-requested', { approvalId, requiredApprovalKey: result.requiredApprovalKey });
      } else if (result.decision === 'reject') {
        status = 'rejected';
      }
      await versions.applyManaged(version.id, { approvalId }, { actor });
      const updated = await managed(quote.id, {
        status,
        currentVersionId: version.id,
        currentVersionNumber: versionNumber,
        currentApprovalId: approvalId,
      });
      return {
        version: {
          id: version.id,
          versionNumber,
          decision: result.decision,
          reason: result.reason,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          maxLineDiscountBps: maxDiscountBps,
          effectiveDiscountBps: effectiveBps,
          totals,
        },
        approvalId,
        quote: quoteSummary(updated),
      };
    },
  };
}

/** @param {CommercialActionConfig} [config] */
export function buildQuoteDecisionActions(config) {
  const cfg = resolved(config);
  const decide = (name, label, terminalStatus) => ({
    module: cfg.quoteModule,
    name,
    label,
    description: `${label} the pending quote version (human decision).`,
    actionContract: 1,
    stateField: 'status',
    fromStates: ['pending_approval'],
    confirm: true,
    input: [
      { name: 'reason', type: 'string', required: name === 'reject', hint: name === 'reject' ? 'Why the discount is refused.' : 'Optional decision note.' },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, managed, now, step }) {
      // The same human-actor boundary the core approval workflow enforces:
      // only a user actor may decide. requiredApprovalKey is a LABEL — real
      // Sales-Manager/Finance role enforcement needs the Production Spine.
      if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Quote approval decisions require a human user actor', { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
      }
      if (!quote.currentApprovalId || !quote.currentVersionId) {
        throw new AppError('The quote is pending approval but carries no approval/version link', { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
      }
      const approvals = trusted(modules, cfg.approvalModule);
      const approval = approvals.get(quote.currentApprovalId);
      if (approval.quoteId !== quote.id || approval.quoteVersionId !== quote.currentVersionId) {
        throw new AppError('The approval link points at another quote or version', { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
      }
      if (approval.status !== 'pending') {
        throw new AppError(`The approval was already decided (${approval.status})`, { code: 'ALREADY_DECIDED', status: 409 });
      }
      const decidedAt = now();
      await approvals.applyManaged(
        approval.id,
        { status: terminalStatus, decisionReason: input.reason ?? null, decidedBy: String(/** @type {any} */ (actor).id ?? 'unknown'), decidedAt },
        { actor },
      );
      const updated = await managed(quote.id, { status: terminalStatus });
      step(`quote.${name}d`, { approvalId: approval.id, versionId: quote.currentVersionId });
      return { decision: terminalStatus, approvalId: approval.id, versionId: quote.currentVersionId, quote: quoteSummary(updated) };
    },
  });
  return [decide('approve', 'Approve', 'approved'), decide('reject', 'Reject', 'rejected')];
}

/** @param {CommercialActionConfig} [config] */
export function buildReviseQuoteAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.quoteModule,
    name: 'revise',
    label: 'Revise',
    description: 'Reopen a rejected quote as a draft; the next submission becomes the next version.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['rejected'],
    input: [],
    /** @param {any} ctx */
    async execute({ record: quote, managed, step }) {
      const updated = await managed(quote.id, { status: 'draft', draftRevision: quote.draftRevision + 1 });
      step('quote.revised', { quoteId: quote.id, draftRevision: updated.draftRevision });
      return { quote: quoteSummary(updated) };
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** @param {any} line */
function lineSummary(line) {
  return {
    id: line.id,
    offerId: line.offerId,
    offer: line.offerLogicalKey,
    offerRevision: line.offerRevision,
    offerName: line.offerName,
    sku: line.sku,
    quantity: line.quantity,
    discountBps: line.discountBps,
    listAmountCents: line.listAmountCents,
    discountAmountCents: line.discountAmountCents,
    netAmountCents: line.netAmountCents,
    components: fromJson(line.breakdownJson)?.components ?? [],
    position: line.position,
    removed: line.removed,
  };
}

/** @param {any} quote */
function quoteSummary(quote) {
  const totals = fromJson(quote.totalsJson) ?? { oneTimeTotal: null, recurringTotals: [] };
  return {
    id: quote.id,
    opportunityId: quote.opportunityId,
    priceBookId: quote.priceBookId,
    currency: quote.currency,
    status: quote.status,
    draftRevision: quote.draftRevision,
    currentVersionId: quote.currentVersionId,
    currentVersionNumber: quote.currentVersionNumber,
    currentApprovalId: quote.currentApprovalId,
    oneTimeTotal: totals.oneTimeTotal,
    recurringTotals: totals.recurringTotals,
  };
}

/**
 * The eight quote actions the package contributes, in registration order.
 * @param {CommercialActionConfig|undefined} config
 * @param {any} registries the package's CommercialRegistries instance
 */
export function buildCommercialActions(config, registries) {
  return [
    buildCreateQuoteAction(config),
    ...buildQuoteLineActions(config),
    buildSubmitQuoteAction(config, registries),
    ...buildQuoteDecisionActions(config),
    buildReviseQuoteAction(config),
  ];
}

export { fromJson as parseBreakdown };
