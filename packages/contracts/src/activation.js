// @ts-check

import { AppError } from '../../core/src/errors.js';
import {
  OBLIGATIONS_AMBIGUOUS,
  assertClassificationCoherent,
  canonicalObligations,
  classificationContext,
  normalizeClassification,
  normalizeOverrides,
} from './activation-policy.js';
import { TERMS_NOTE, TERMS_SOURCE, activationState, requireTerm } from './dates.js';

/**
 * Order → Commercial Contract activation (Milestone 12).
 *
 *   order.plan-activation     read-only: what activation WOULD create
 *   order.activate-contract   human-approved: creates all of it, atomically
 *
 * The signed immutable Order is the **only** commercial source. Nothing here
 * reads the catalog, recomputes a price, or infers an obligation from
 * recurrence: every amount is copied, and every classification is an explicit
 * versioned policy decision recorded as evidence.
 */

const POLICY_KIND = 'order-activation-policy';
const MAX_JSON = 200_000;

/** @typedef {Record<string, string>} ContractModuleConfig */

/** @param {ContractModuleConfig} [config] */
export function resolvedNames(config = {}) {
  return {
    order: config.orderModule ?? 'order',
    orderLine: config.orderLineModule ?? 'order-line',
    orderComponent: config.orderComponentModule ?? 'order-component',
    orderTotal: config.orderTotalModule ?? 'order-total',
    envelope: config.envelopeModule ?? 'signature-envelope',
    artifact: config.artifactModule ?? 'signed-artifact',
    contract: config.contractModule ?? 'commercial-contract',
    contractVersion: config.contractVersionModule ?? 'contract-version',
    contractLine: config.contractLineModule ?? 'contract-line',
    activation: config.activationModule ?? 'contract-activation',
    subscription: config.subscriptionModule ?? 'subscription',
    subscriptionLine: config.subscriptionLineModule ?? 'subscription-line',
    deliveryObligation: config.deliveryObligationModule ?? 'delivery-obligation',
    serviceObligation: config.serviceObligationModule ?? 'service-obligation',
  };
}

/** Trusted read-only managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'CONTRACT_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

function toJson(value, label) {
  const text = JSON.stringify(value);
  if (text.length > MAX_JSON) {
    throw new AppError(`The ${label} exceeds the storable bound`, { code: 'EVIDENCE_TOO_LARGE', status: 409 });
  }
  return text;
}

/**
 * Load the signed Order and prove it is activatable. Every check is a stable
 * refusal — an Order whose signature evidence is missing or incoherent is
 * never activated on the assumption that it is probably fine.
 */
export function loadActivationSource(modules, names, order) {
  if (order.status !== 'accepted') {
    throw new AppError(`The order is ${order.status}, not accepted`, { code: 'ORDER_NOT_ACTIVATABLE', status: 409 });
  }
  if (!order.envelopeId || !order.signedArtifactId) {
    throw new AppError('The order carries no signature evidence', { code: 'ORDER_NOT_SIGNED', status: 409 });
  }
  const envelope = trusted(modules, names.envelope).get(order.envelopeId);
  if (envelope.status !== 'completed') {
    throw new AppError(`The signature envelope is ${envelope.status}, not completed`, { code: 'ORDER_NOT_SIGNED', status: 409 });
  }
  if (envelope.quoteVersionId !== order.quoteVersionId) {
    throw new AppError('The signature envelope belongs to another quote version', { code: 'SOURCE_INCOHERENT', status: 409 });
  }
  const artifact = trusted(modules, names.artifact).get(order.signedArtifactId);
  if (artifact.envelopeId !== envelope.id) {
    throw new AppError('The signed artifact belongs to another envelope', { code: 'SOURCE_INCOHERENT', status: 409 });
  }
  // The Order recorded the hash of the document that was actually signed; if
  // the three no longer agree, the commercial source is not trustworthy.
  if (order.documentHash !== envelope.documentHash || artifact.documentHash !== envelope.documentHash) {
    throw new AppError('The order, envelope and artifact disagree on the signed document', {
      code: 'SOURCE_HASH_MISMATCH', status: 409,
    });
  }

  const lines = trusted(modules, names.orderLine)
    .listWhere({ orderId: order.id })
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
  if (lines.length === 0 || lines.length !== order.lineCount) {
    throw new AppError('The order snapshot is incomplete', { code: 'SOURCE_INCOMPLETE', status: 409, details: { expected: order.lineCount, found: lines.length } });
  }
  const componentService = trusted(modules, names.orderComponent);
  const components = [];
  for (const line of lines) {
    const forLine = componentService
      .listWhere({ orderLineId: line.id })
      .sort((a, b) => (a.componentKey < b.componentKey ? -1 : a.componentKey > b.componentKey ? 1 : a.id < b.id ? -1 : 1));
    if (forLine.length !== line.componentCount) {
      throw new AppError('An order line is missing price components', {
        code: 'SOURCE_INCOMPLETE', status: 409, details: { orderLineId: line.id },
      });
    }
    for (const component of forLine) components.push({ line, component });
  }
  const totals = trusted(modules, names.orderTotal).listWhere({ orderId: order.id });
  if (totals.length === 0) {
    throw new AppError('The order snapshot carries no grouped totals', { code: 'SOURCE_INCOMPLETE', status: 409 });
  }
  return { envelope, artifact, lines, components, totals };
}

/**
 * Apply the policy (and any human override) to every component. Pure: it
 * reads, it decides, it writes nothing.
 */
export function classifyComponents({ policy, fingerprint, order, components, overrides }) {
  const label = `Order activation policy "${policy.name}@${policy.version}"`;
  return components.map(({ line, component }) => {
    /** @type {unknown} */
    let raw;
    try {
      raw = policy.classifyComponent(classificationContext({ line, component, order, config: policy.config }));
    } catch (error) {
      throw new AppError(
        `${label} threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}) — activation policies must be total and deterministic`,
        { code: 'ACTIVATION_POLICY_INVALID', status: 500 },
      );
    }
    const policyDecision = normalizeClassification(label, raw);
    // Each dimension is resolved independently: a human may settle the
    // commercial axis while the policy's obligations stand, or the reverse.
    const commercialOverride = overrides.get(`${component.id}/commercial`) ?? null;
    const obligationsOverride = overrides.get(`${component.id}/obligations`) ?? null;
    const commercialActivation = commercialOverride
      ? commercialOverride.value
      : policyDecision.commercialActivation;
    const obligations = obligationsOverride
      ? canonicalObligations(obligationsOverride.value)
      : policyDecision.obligations;

    assertClassificationCoherent({ commercialActivation }, component);
    return {
      line,
      component,
      policyDecision,
      commercialActivation,
      obligations,
      classificationReason: (commercialOverride ?? obligationsOverride)?.reason ?? policyDecision.reason,
      commercialOverride,
      obligationsOverride,
      overridden: Boolean(commercialOverride || obligationsOverride),
      // Which axes are still undecided — the plan reports exactly this, so a
      // human knows what to answer rather than "something is ambiguous".
      ambiguousDimensions: [
        ...(commercialActivation === 'ambiguous' ? ['commercial'] : []),
        ...(obligations === OBLIGATIONS_AMBIGUOUS ? ['obligations'] : []),
      ],
      policy: policy.name,
      policyVersion: policy.version,
      policyFingerprint: fingerprint,
    };
  });
}

/** @param {any[]} decisions */
function summarize(decisions) {
  const counts = { subscriptionLines: 0, delivery: 0, service: 0, noObligation: 0, ambiguous: 0 };
  for (const decision of decisions) {
    if (decision.ambiguousDimensions.length > 0) counts.ambiguous += 1;
    if (decision.commercialActivation === 'subscription') counts.subscriptionLines += 1;
    if (Array.isArray(decision.obligations)) {
      if (decision.obligations.includes('delivery')) counts.delivery += 1;
      if (decision.obligations.includes('service')) counts.service += 1;
      if (decision.obligations.length === 0) counts.noObligation += 1;
    }
  }
  return counts;
}

/** The machine-readable plan an agent can prepare and a human can approve. */
function planPayload({ order, envelope, artifact, decisions, totals, existingContract, policy, fingerprint }) {
  const counts = summarize(decisions);
  return {
    orderId: order.id,
    currency: order.currency,
    customerName: order.customerName,
    quoteVersionId: order.quoteVersionId,
    signature: { envelopeId: envelope.id, signedArtifactId: artifact.id, documentHash: envelope.documentHash },
    policy: policy.name,
    policyVersion: policy.version,
    policyFingerprint: fingerprint,
    alreadyActivated: Boolean(existingContract),
    contractId: existingContract?.id ?? null,
    activatable: !existingContract && counts.ambiguous === 0,
    // Everything a caller must still decide, stated rather than defaulted.
    requiredInputs: existingContract
      ? []
      : ['effectiveDate', 'termStartDate', 'termEndDate', 'termsReason'],
    // The term is NOT part of what was signed, and the plan says so before a
    // single record exists (ADR-018 addendum, review finding C1).
    termsProvenance: { source: TERMS_SOURCE, note: TERMS_NOTE },
    counts,
    components: decisions.map((decision) => ({
      orderLineId: decision.line.id,
      orderComponentId: decision.component.id,
      componentKey: decision.component.componentKey,
      label: decision.component.label,
      sku: decision.line.sku,
      chargeType: decision.component.chargeType,
      interval: decision.component.interval,
      intervalCount: decision.component.intervalCount,
      quantity: decision.component.quantity,
      netAmountCents: decision.component.netAmountCents,
      // Two independent answers, each reported with what the policy said.
      commercialActivation: decision.commercialActivation,
      obligations: decision.obligations,
      policyCommercialActivation: decision.policyDecision.commercialActivation,
      policyObligations: decision.policyDecision.obligations,
      reason: decision.classificationReason,
      overridden: decision.overridden,
      overriddenDimensions: [
        ...(decision.commercialOverride ? ['commercial'] : []),
        ...(decision.obligationsOverride ? ['obligations'] : []),
      ],
      ambiguousDimensions: decision.ambiguousDimensions,
      requiresOverride: decision.ambiguousDimensions.length > 0,
    })),
    totals: totals.map((total) => ({
      kind: total.kind, currency: total.currency, interval: total.interval,
      intervalCount: total.intervalCount, netAmountCents: total.netAmountCents,
    })),
    // Nothing about billing, invoicing, fulfilment or service activation is
    // implied by this plan, and the payload says so.
    notModeled: ['billing', 'invoicing', 'payment', 'usage rating', 'proration', 'tax', 'FX', 'renewal scheduling', 'delivery execution', 'service activation'],
  };
}

/**
 * `order.plan-activation` — read-only. It computes exactly what
 * `activate-contract` would create, writes no domain record and emits no
 * business audit or event. The action runtime still records a trace, which is
 * the framework's existing policy for a read-shaped action.
 *
 * @param {ContractModuleConfig} [config]
 */
export function buildPlanActivationAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.order,
    name: 'plan-activation',
    label: 'Plan activation',
    description: 'Show what activating this signed order would create. Writes nothing.',
    actionContract: 1,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered order activation policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
      { name: 'classificationOverrides', type: 'json', required: false, hint: 'Preview overrides: [{orderComponentId, type, reason}].' },
    ],
    /** @param {any} ctx */
    async execute({ record: order, input, modules, domains, step }) {
      const { definition: policy, fingerprint } = domains.getPolicy('contracts', POLICY_KIND, input.policy, input.policyVersion);
      const source = loadActivationSource(modules, names, order);
      const overrides = normalizeOverrides(
        input.classificationOverrides,
        new Set(source.components.map(({ component }) => component.id)),
      );
      const decisions = classifyComponents({ policy, fingerprint, order, components: source.components, overrides });
      const existingContract = trusted(modules, names.contract).listWhere({ orderId: order.id })[0] ?? null;
      step('activation.planned', { orderId: order.id, ...summarize(decisions) });
      return {
        plan: planPayload({ order, envelope: source.envelope, artifact: source.artifact, decisions, totals: source.totals, existingContract, policy, fingerprint }),
        policy: { name: policy.name, version: policy.version, fingerprint },
      };
    },
  };
}

/**
 * `order.activate-contract` — the human-approved transition. One transaction
 * creates the activation run, the contract, its immutable version and lines,
 * the subscription and its lines, and every pending delivery/service
 * obligation. Everything commits or nothing does.
 *
 * @param {ContractModuleConfig} [config]
 */
export function buildActivateContractAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.order,
    name: 'activate-contract',
    label: 'Activate contract',
    description: 'Activate a commercial contract and its subscription from this signed order (human decision).',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered order activation policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version.' },
      { name: 'effectiveDate', type: 'string', required: true, hint: 'Calendar date YYYY-MM-DD.' },
      { name: 'termStartDate', type: 'string', required: true, hint: 'Calendar date YYYY-MM-DD.' },
      { name: 'termEndDate', type: 'string', required: true, hint: 'Calendar date YYYY-MM-DD, inclusive.' },
      { name: 'autoRenew', type: 'boolean', required: false, hint: 'Recorded only — no scheduler exists in this milestone.' },
      { name: 'renewalNoticeDays', type: 'integer', required: false, hint: 'Recorded only (0-365); requires autoRenew.' },
      { name: 'termsReason', type: 'string', required: true, hint: 'Where this term came from: it is operational metadata recorded after signature, not a signed term.' },
      { name: 'classificationOverrides', type: 'json', required: false, hint: '[{orderComponentId, dimension: "commercial"|"obligations", value, reason}] — a human decision per dimension, with a reason.' },
    ],
    /** @param {any} ctx */
    async execute({ record: order, input, actor, modules, domains, managed, now, step }) {
      // Activating a commercial commitment is a human decision. An agent may
      // prepare the plan and the inputs; it may not commit the business.
      if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Activating a contract requires a human user actor', { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
      }
      const { definition: policy, fingerprint } = domains.getPolicy('contracts', POLICY_KIND, input.policy, input.policyVersion);
      const term = requireTerm(input);

      // The plan is recomputed here, inside the transaction, from the Order —
      // a plan the caller computed earlier is never trusted.
      const source = loadActivationSource(modules, names, order);

      // Already activated is the first answer, before any classification work:
      // a retry deserves the same stable refusal whether or not it repeats the
      // overrides the first call carried.
      const contracts = trusted(modules, names.contract);
      const existing = contracts.listWhere({ orderId: order.id })[0];
      if (existing) {
        throw new AppError('This order is already activated', {
          code: 'ORDER_ALREADY_ACTIVATED', status: 409, details: { contractId: existing.id },
        });
      }

      const overrides = normalizeOverrides(
        input.classificationOverrides,
        new Set(source.components.map(({ component }) => component.id)),
      );
      const decisions = classifyComponents({ policy, fingerprint, order, components: source.components, overrides });
      const ambiguous = decisions.filter((decision) => decision.ambiguousDimensions.length > 0);
      if (ambiguous.length > 0) {
        throw new AppError(
          `${ambiguous.length} order component(s) could not be classified and need an explicit human override`,
          {
            code: 'CLASSIFICATION_AMBIGUOUS',
            status: 409,
            details: {
              orderComponentIds: ambiguous.map((decision) => decision.component.id),
              // Which axis each one needs, so the answer is actionable.
              dimensions: ambiguous.map((decision) => ({
                orderComponentId: decision.component.id,
                dimensions: decision.ambiguousDimensions,
              })),
            },
          },
        );
      }

      const activatedAt = now();
      // State follows the business date, never the wish: a term that starts
      // next month is `scheduled`, and NOTHING flips it — there is no
      // scheduler in this framework, which the schema and the Admin state.
      const businessDate = activatedAt.slice(0, 10);
      const state = activationState(term, businessDate);
      if (state === 'ended') {
        throw new AppError('The term ended before this activation', {
          code: 'TERM_ALREADY_ENDED', status: 409,
          details: { termEndDate: term.termEndDate, businessDate },
        });
      }
      const counts = summarize(decisions);
      const activations = trusted(modules, names.activation);
      const activation = await activations.createManaged(
        {
          sourceKey: `activation:order:${order.id}`,
          orderId: order.id,
          quoteId: order.quoteId,
          quoteVersionId: order.quoteVersionId,
          envelopeId: source.envelope.id,
          signedArtifactId: source.artifact.id,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          documentHash: order.documentHash,
          sourceFingerprint: order.sourceFingerprint,
          effectiveDate: term.effectiveDate,
          termStartDate: term.termStartDate,
          termEndDate: term.termEndDate,
          termsSource: term.termsSource,
          termsReason: term.termsReason,
          activationState: state,
          subscriptionLineCount: counts.subscriptionLines,
          deliveryObligationCount: counts.delivery,
          serviceObligationCount: counts.service,
          noObligationCount: counts.noObligation,
          overrideCount: decisions.reduce(
            (total, decision) => total + (decision.commercialOverride ? 1 : 0) + (decision.obligationsOverride ? 1 : 0),
            0,
          ),
          decisionsJson: toJson(
            decisions.map((decision) => ({
              orderComponentId: decision.component.id,
              componentKey: decision.component.componentKey,
              policyCommercialActivation: decision.policyDecision.commercialActivation,
              policyObligations: decision.policyDecision.obligations,
              policyReason: decision.policyDecision.reason,
              commercialActivation: decision.commercialActivation,
              obligations: decision.obligations,
              commercialOverrideReason: decision.commercialOverride?.reason ?? null,
              obligationsOverrideReason: decision.obligationsOverride?.reason ?? null,
            })),
            'activation decisions',
          ),
          activatedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
          activatedAt,
        },
        { actor },
      );

      const contract = await contracts.createManaged(
        {
          sourceKey: `contract:order:${order.id}`,
          orderId: order.id,
          quoteId: order.quoteId,
          quoteVersionId: order.quoteVersionId,
          envelopeId: source.envelope.id,
          signedArtifactId: source.artifact.id,
          opportunityId: order.opportunityId,
          companyId: order.companyId,
          contactId: order.contactId,
          // Copied from the Order's own party snapshot: the contract renders
          // its customer without reading a live CRM row.
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          currency: order.currency,
          status: state,
          effectiveDate: term.effectiveDate,
          termStartDate: term.termStartDate,
          termEndDate: term.termEndDate,
          termDays: term.termDays,
          autoRenew: term.autoRenew,
          renewalNoticeDays: term.renewalNoticeDays,
          termsSource: term.termsSource,
          termsReason: term.termsReason,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          documentHash: order.documentHash,
          artifactHash: order.artifactHash,
          sourceFingerprint: order.sourceFingerprint,
          activationId: activation.id,
          activatedAt,
        },
        { actor },
      );

      const versions = trusted(modules, names.contractVersion);
      const version = await versions.createManaged(
        {
          sourceKey: `contract-version:${contract.id}:1`,
          contractId: contract.id,
          versionNumber: 1,
          orderId: order.id,
          quoteVersionId: order.quoteVersionId,
          documentHash: order.documentHash,
          artifactHash: order.artifactHash,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          companyId: order.companyId,
          contactId: order.contactId,
          currency: order.currency,
          effectiveDate: term.effectiveDate,
          termStartDate: term.termStartDate,
          termEndDate: term.termEndDate,
          termDays: term.termDays,
          autoRenew: term.autoRenew,
          renewalNoticeDays: term.renewalNoticeDays,
          termsSource: term.termsSource,
          termsReason: term.termsReason,
          // The Order's grouped totals, copied verbatim. They are period sums
          // of what was signed — never MRR, ARR or TCV.
          totalsJson: order.totalsJson,
          oneTimeNetCents: order.oneTimeNetCents,
          recurringGroupCount: order.recurringGroupCount,
          lineCount: source.components.length,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          activationId: activation.id,
          activatedAt,
        },
        { actor },
      );
      await contracts.applyManaged(contract.id, { currentVersionId: version.id }, { actor });

      // One Subscription per contract in v1, created only when at least one
      // component was explicitly classified as a subscription.
      let subscription = null;
      if (counts.subscriptionLines > 0) {
        subscription = await trusted(modules, names.subscription).createManaged(
          {
            sourceKey: `subscription:contract:${contract.id}`,
            contractId: contract.id,
            contractVersionId: version.id,
            orderId: order.id,
            status: state,
            currency: order.currency,
            startDate: term.termStartDate,
            endDate: term.termEndDate,
            lineCount: counts.subscriptionLines,
            activationId: activation.id,
            activatedAt,
          },
          { actor },
        );
      }

      const contractLines = trusted(modules, names.contractLine);
      const subscriptionLines = trusted(modules, names.subscriptionLine);
      const deliveryObligations = trusted(modules, names.deliveryObligation);
      const serviceObligations = trusted(modules, names.serviceObligation);
      let position = 0;
      for (const decision of decisions) {
        position += 1;
        const { line, component } = decision;
        const contractLine = await contractLines.createManaged(
          {
            sourceKey: `contract-line:${version.id}:${component.id}`,
            contractId: contract.id,
            contractVersionId: version.id,
            orderId: order.id,
            orderLineId: line.id,
            orderComponentId: component.id,
            productId: line.productId,
            productVersionId: line.productVersionId,
            offerId: line.offerId,
            offerLogicalKey: line.offerLogicalKey,
            offerRevision: line.offerRevision,
            offerName: line.offerName,
            sku: line.sku,
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
            tiersJson: component.tiersJson,
            tierBreakdownJson: component.tierBreakdownJson,
            listAmountCents: component.listAmountCents,
            discountAmountCents: component.discountAmountCents,
            netAmountCents: component.netAmountCents,
            currency: order.currency,
            provider: component.provider,
            externalPriceId: component.externalPriceId,
            sourcePricingModel: component.sourcePricingModel,
            // Dimension 1: what the money is, with the policy's own answer.
            commercialActivation: decision.commercialActivation,
            policyCommercialActivation: decision.policyDecision.commercialActivation,
            commercialOverridden: Boolean(decision.commercialOverride),
            commercialOverrideReason: decision.commercialOverride?.reason ?? null,
            // Dimension 2: what we owe beyond the money, likewise.
            obligationsJson: toJson(decision.obligations, 'obligations'),
            policyObligationsJson: toJson(decision.policyDecision.obligations, 'policy obligations'),
            obligationsOverridden: Boolean(decision.obligationsOverride),
            obligationsOverrideReason: decision.obligationsOverride?.reason ?? null,
            classificationReason: decision.classificationReason,
            classificationPolicy: policy.name,
            classificationPolicyVersion: policy.version,
            classificationPolicyFingerprint: fingerprint,
            overriddenBy: decision.overridden ? String(/** @type {any} */ (actor).id ?? 'unknown') : null,
            position,
          },
          { actor },
        );

        // The two axes are written independently: the same component can be a
        // recurring commitment AND a future obligation (annual support is
        // exactly that), and an exclusive branch would silently drop one.
        if (decision.commercialActivation === 'subscription') {
          await subscriptionLines.createManaged(
            {
              sourceKey: `subscription-line:${subscription.id}:${component.id}`,
              subscriptionId: subscription.id,
              contractId: contract.id,
              contractLineId: contractLine.id,
              orderComponentId: component.id,
              componentKey: component.componentKey,
              label: component.label,
              chargeType: component.chargeType,
              pricingModel: component.pricingModel,
              interval: component.interval,
              intervalCount: component.intervalCount,
              quantity: component.quantity,
              unitAmountCents: component.unitAmountCents,
              flatAmountCents: component.flatAmountCents,
              tiersJson: component.tiersJson,
              tierBreakdownJson: component.tierBreakdownJson,
              netAmountCents: component.netAmountCents,
              currency: order.currency,
              startDate: term.termStartDate,
              endDate: term.termEndDate,
              provider: component.provider,
              externalPriceId: component.externalPriceId,
              sourcePricingModel: component.sourcePricingModel,
              status: state,
              activationId: activation.id,
            },
            { actor },
          );
        }
        if (decision.obligations.includes('delivery')) {
          await deliveryObligations.createManaged(
            {
              sourceKey: `delivery-obligation:${contract.id}:${component.id}`,
              contractId: contract.id,
              contractLineId: contractLine.id,
              orderId: order.id,
              orderComponentId: component.id,
              status: 'pending_handover',
              label: component.label,
              componentKey: component.componentKey,
              sku: line.sku,
              chargeType: component.chargeType,
              interval: component.interval,
              intervalCount: component.intervalCount,
              quantity: component.quantity,
              netAmountCents: component.netAmountCents,
              currency: order.currency,
              productId: line.productId,
              productVersionId: line.productVersionId,
              provider: component.provider,
              activationId: activation.id,
            },
            { actor },
          );
        }
        if (decision.obligations.includes('service')) {
          await serviceObligations.createManaged(
            {
              sourceKey: `service-obligation:${contract.id}:${component.id}`,
              contractId: contract.id,
              contractLineId: contractLine.id,
              orderId: order.id,
              orderComponentId: component.id,
              status: 'pending_activation',
              label: component.label,
              componentKey: component.componentKey,
              sku: line.sku,
              chargeType: component.chargeType,
              interval: component.interval,
              intervalCount: component.intervalCount,
              quantity: component.quantity,
              netAmountCents: component.netAmountCents,
              currency: order.currency,
              activationId: activation.id,
            },
            { actor },
          );
        }
        // An empty obligations list creates a Contract Line and nothing else:
        // the decision that a component owes nothing further is itself
        // recorded, and is not the same as never having decided.
      }

      await activations.applyManaged(
        activation.id,
        { contractId: contract.id, contractVersionId: version.id, subscriptionId: subscription?.id ?? null, status: 'completed' },
        { actor },
      );
      // The Order itself is never modified: only its managed link is set.
      const updatedOrder = await managed(order.id, { contractId: contract.id, activatedAt });

      step('contract.activated', {
        contractId: contract.id,
        contractVersionId: version.id,
        subscriptionId: subscription?.id ?? null,
        ...counts,
      });

      return {
        activationId: activation.id,
        contract: {
          id: contract.id,
          status: state,
          currency: contract.currency,
          customerName: contract.customerName,
          currentVersionId: version.id,
          effectiveDate: term.effectiveDate,
          termStartDate: term.termStartDate,
          termEndDate: term.termEndDate,
          termDays: term.termDays,
          autoRenew: term.autoRenew,
          renewalNoticeDays: term.renewalNoticeDays,
          termsSource: term.termsSource,
          termsReason: term.termsReason,
        },
        subscriptionId: subscription?.id ?? null,
        counts,
        order: { id: updatedOrder.id, contractId: updatedOrder.contractId },
      };
    },
  };
}

/** @param {ContractModuleConfig} [config] */
export function buildContractActions(config) {
  return [buildPlanActivationAction(config), buildActivateContractAction(config)];
}
