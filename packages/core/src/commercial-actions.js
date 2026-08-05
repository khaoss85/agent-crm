// @ts-check

import { AppError, ValidationError } from './errors.js';
import { normalizePolicyResult } from './commercial-registry.js';
import { computeLineAmounts, computeQuoteTotals } from './commercial-money.js';

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
 * All storage modules are read-only public (M9 pattern): every price and
 * total is server-derived from catalog data; clients never submit amounts.
 * Draft edits are optimistic-concurrency guarded by `expectedRevision`
 * (stable 409 STALE_REVISION); version numbers and approvals are DB-unique.
 * Approved is terminal in M10 — no signature, no order (Milestone 11).
 */

/** @typedef {{
 *   quoteModule?: string, lineModule?: string, versionModule?: string,
 *   versionLineModule?: string, approvalModule?: string,
 *   priceBookModule?: string, entryModule?: string, productVersionModule?: string,
 * }} CommercialActionConfig */

/** @param {CommercialActionConfig} [config] */
function resolved(config = {}) {
  return {
    quoteModule: config.quoteModule ?? 'quote',
    lineModule: config.lineModule ?? 'quote-line',
    versionModule: config.versionModule ?? 'quote-version',
    versionLineModule: config.versionLineModule ?? 'quote-version-line',
    approvalModule: config.approvalModule ?? 'quote-approval',
    priceBookModule: config.priceBookModule ?? 'price-book',
    entryModule: config.entryModule ?? 'price-book-entry',
    productVersionModule: config.productVersionModule ?? 'product-version',
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

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
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

/** Recalculate quote totals and bump the draft revision, atomically with the edit. */
async function recalc(modules, cfg, quote, managed) {
  const totals = computeQuoteTotals(activeLines(modules, cfg, quote.id));
  return managed(quote.id, {
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    totalCents: totals.totalCents,
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
      const quote = await trusted(modules, cfg.quoteModule).createManaged(
        {
          opportunityId: record.id,
          priceBookId: book.id,
          currency: book.currency,
          draftRevision: 1,
          subtotalCents: 0,
          discountCents: 0,
          totalCents: 0,
        },
        { actor },
      );
      step('quote.created', { quoteId: quote.id, priceBookId: book.id, currency: book.currency });
      return { quote: { id: quote.id, opportunityId: record.id, priceBookId: book.id, currency: book.currency, status: quote.status, draftRevision: quote.draftRevision } };
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
    description: 'Add a product line priced from the quote\'s price book.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['draft'],
    input: [
      { name: 'priceBookEntryId', type: 'string', required: true },
      { name: 'quantity', type: 'integer', required: true, hint: 'Positive integer (1–1,000,000).' },
      { name: 'discountBps', type: 'integer', required: false, hint: 'Basis points: 1000 = 10.00%. Integer 0–10000.' },
      { name: 'expectedRevision', type: 'integer', required: false, hint: 'Optimistic concurrency: current draft revision.' },
    ],
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, managed, step }) {
      checkRevision(quote, input);
      const entry = trusted(modules, cfg.entryModule).get(input.priceBookEntryId);
      if (entry.priceBookId !== quote.priceBookId) {
        throw new AppError('The entry belongs to another price book', { code: 'PRICE_BOOK_MISMATCH', status: 409 });
      }
      if (entry.active !== true) {
        throw new AppError('The price book entry is no longer active', { code: 'ENTRY_INACTIVE', status: 409 });
      }
      if (entry.currency !== quote.currency) {
        throw new AppError(`Entry currency ${entry.currency} does not match quote currency ${quote.currency}`, { code: 'CURRENCY_MISMATCH', status: 409 });
      }
      const productVersion = trusted(modules, cfg.productVersionModule).get(entry.productVersionId);
      const amounts = computeLineAmounts({
        listUnitAmountCents: entry.unitAmountCents,
        quantity: input.quantity,
        discountBps: input.discountBps ?? 0,
      });
      const lines = trusted(modules, cfg.lineModule);
      const line = await lines.createManaged(
        {
          quoteId: quote.id,
          priceBookEntryId: entry.id,
          entryRevision: entry.revision,
          productId: entry.productId,
          productVersionId: entry.productVersionId,
          sku: productVersion.sku,
          name: productVersion.name,
          pricingMode: entry.pricingMode,
          recurringInterval: entry.recurringInterval,
          removed: false,
          position: lines.countWhere({ quoteId: quote.id }) + 1,
          ...amounts,
        },
        { actor },
      );
      step('quote.line-added', { lineId: line.id, sku: line.sku, quantity: line.quantity });
      const updated = await recalc(modules, cfg, quote, managed);
      return { line: lineSummary(line), quote: quoteSummary(updated) };
    },
  };

  const updateLine = {
    module: cfg.quoteModule,
    name: 'update-line',
    label: 'Update line',
    description: 'Change a draft line\'s quantity or requested discount.',
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
      const amounts = computeLineAmounts({
        listUnitAmountCents: line.listUnitAmountCents,
        quantity: input.quantity ?? line.quantity,
        discountBps: input.discountBps ?? line.discountBps,
      });
      const updatedLine = await trusted(modules, cfg.lineModule).applyManaged(line.id, { ...amounts }, { actor });
      step('quote.line-updated', { lineId: line.id, quantity: updatedLine.quantity, discountBps: updatedLine.discountBps });
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

/** @param {CommercialActionConfig} [config] */
export function buildSubmitQuoteAction(config) {
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
    async execute({ record: quote, input, actor, modules, services, commercial, managed, now, step }) {
      checkRevision(quote, input);
      const lines = activeLines(modules, cfg, quote.id);
      if (lines.length === 0) {
        throw new AppError('A quote needs at least one active line before submission', { code: 'EMPTY_QUOTE', status: 409 });
      }
      const { definition: policy, fingerprint } = commercial.getDiscountPolicy(input.policy, input.version);
      const totals = computeQuoteTotals(lines);
      const submittedAt = now();

      let opportunity = null;
      try {
        const record = services.opportunities?.get(quote.opportunityId);
        if (record) opportunity = { id: record.id, valueCents: record.valueCents, stage: record.stage, pipelineStage: record.pipelineStage ?? null };
      } catch {
        opportunity = null; // conversion evidence lives on the quote either way
      }

      const context = deepFreeze({
        quote: { id: quote.id, opportunityId: quote.opportunityId, priceBookId: quote.priceBookId, currency: quote.currency },
        opportunity,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        totalCents: totals.totalCents,
        maxLineDiscountBps: totals.maxLineDiscountBps,
        effectiveDiscountBps: totals.effectiveDiscountBps,
        lines: lines.map((line) => ({ sku: line.sku, quantity: line.quantity, discountBps: line.discountBps, lineTotalCents: line.lineTotalCents })),
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
          subtotalCents: totals.subtotalCents,
          discountCents: totals.discountCents,
          totalCents: totals.totalCents,
          maxLineDiscountBps: totals.maxLineDiscountBps,
          effectiveDiscountBps: totals.effectiveDiscountBps,
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
      const versionLines = trusted(modules, cfg.versionLineModule);
      for (const line of lines) {
        await versionLines.createManaged(
          {
            versionId: version.id,
            productId: line.productId,
            productVersionId: line.productVersionId,
            sku: line.sku,
            name: line.name,
            priceBookEntryId: line.priceBookEntryId,
            entryRevision: line.entryRevision,
            quantity: line.quantity,
            listUnitAmountCents: line.listUnitAmountCents,
            discountBps: line.discountBps,
            netUnitAmountCents: line.netUnitAmountCents,
            lineSubtotalCents: line.lineSubtotalCents,
            lineDiscountCents: line.lineDiscountCents,
            lineTotalCents: line.lineTotalCents,
            pricingMode: line.pricingMode,
            recurringInterval: line.recurringInterval,
            position: line.position,
          },
          { actor },
        );
      }
      step('quote.version-created', { versionId: version.id, versionNumber, decision: result.decision });

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
            maxLineDiscountBps: totals.maxLineDiscountBps,
            effectiveDiscountBps: totals.effectiveDiscountBps,
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
        version: { id: version.id, versionNumber, decision: result.decision, reason: result.reason, policy: policy.name, policyVersion: policy.version, policyFingerprint: fingerprint, totals },
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

/** @param {any} line */
function lineSummary(line) {
  return {
    id: line.id,
    sku: line.sku,
    name: line.name,
    quantity: line.quantity,
    discountBps: line.discountBps,
    listUnitAmountCents: line.listUnitAmountCents,
    netUnitAmountCents: line.netUnitAmountCents,
    lineSubtotalCents: line.lineSubtotalCents,
    lineDiscountCents: line.lineDiscountCents,
    lineTotalCents: line.lineTotalCents,
    position: line.position,
    removed: line.removed,
  };
}

/** @param {any} quote */
function quoteSummary(quote) {
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
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
  };
}

/** Convenience bundle for starters. */
export function buildCommercialActions(config) {
  return [
    buildCreateQuoteAction(config),
    ...buildQuoteLineActions(config),
    buildSubmitQuoteAction(config),
    ...buildQuoteDecisionActions(config),
    buildReviseQuoteAction(config),
  ];
}
