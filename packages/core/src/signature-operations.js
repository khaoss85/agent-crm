// @ts-check

import { AppError, NotFoundError, ValidationError, normalizeError } from './errors.js';
import { computeDefinitionFingerprint } from './intelligence-registry.js';
import { runExternalOperation, withExternalTimeout } from './external-operation.js';
import { nowIso } from './time.js';
import {
  MAX_SIGNERS,
  TERMINAL_ENVELOPE_STATES,
  canTransition,
  normalizeProviderArtifact,
  normalizeProviderEnvelope,
  normalizeProviderEvent,
} from './signature-registry.js';

/**
 * Signature and Order operations (ADR-017).
 *
 *   quote.request-signature   external-operation action:
 *                             intent (envelope + signer intent, transaction A)
 *                             → provider.createEnvelope (no transaction open)
 *                             → finalize (provider id + `sent`, transaction B)
 *                             → compensate (`failed`, recoverable) on failure
 *   app.ingestSignatureEvent  verify → inbox → (artifact fetch) → transition
 *   app.reconcileSignature    provider truth → monotonic local transition
 *
 * A verified `completed` transition creates, in ONE transaction, the signed
 * artifact evidence and exactly one immutable Order with its lines,
 * components, tier schedules and grouped totals — copied from the approved
 * Quote Version snapshot, never re-read from the live catalog.
 *
 * Nothing here claims atomicity between the local database and the remote
 * provider: the envelope state machine plus reconciliation is the recovery
 * story, and it is explicit.
 */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_TEXT = 200;
export const DOCUMENT_FORMAT = 'application/vnd.agent-crm.quote-package+json';

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    quote: config.quoteModule ?? 'quote',
    version: config.versionModule ?? 'quote-version',
    versionLine: config.versionLineModule ?? 'quote-version-line',
    versionComponent: config.versionComponentModule ?? 'quote-version-component',
    versionTotal: config.versionTotalModule ?? 'quote-version-total',
    envelope: config.envelopeModule ?? 'signature-envelope',
    signer: config.signerModule ?? 'signature-signer',
    event: config.eventModule ?? 'signature-event',
    artifact: config.artifactModule ?? 'signed-artifact',
    order: config.orderModule ?? 'order',
    orderLine: config.orderLineModule ?? 'order-line',
    orderComponent: config.orderComponentModule ?? 'order-component',
    orderTier: config.orderTierModule ?? 'order-tier',
    orderTotal: config.orderTotalModule ?? 'order-total',
  };
}

/** Trusted read-only managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'SIGNATURE_STORAGE_INVALID',
      status: 500,
    });
  }
  return service;
}

function toJson(value, label = 'evidence') {
  const text = JSON.stringify(value);
  if (text.length > 200_000) {
    throw new AppError(`The ${label} exceeds the storable bound`, { code: 'EVIDENCE_TOO_LARGE', status: 409 });
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

/** Validate the caller-supplied signer list into a bounded, canonical shape. */
export function normalizeSigners(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('signers must be a non-empty array', { field: 'signers' });
  }
  if (raw.length > MAX_SIGNERS) {
    throw new ValidationError(`at most ${MAX_SIGNERS} signers are supported`, { field: 'signers' });
  }
  const emails = new Set();
  const signers = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`signers[${index}] must be an object`, { field: 'signers' });
    }
    const value = /** @type {Record<string, unknown>} */ (entry);
    const text = (field, { required = true, max = MAX_TEXT } = {}) => {
      const item = value[field];
      if (item === undefined || item === null || item === '') {
        if (!required) return null;
        throw new ValidationError(`signers[${index}].${field} is required`, { field: 'signers' });
      }
      if (typeof item !== 'string' || item.trim() === '' || item.length > max) {
        throw new ValidationError(`signers[${index}].${field} must be a string of at most ${max} characters`, { field: 'signers' });
      }
      return item.trim();
    };
    const email = /** @type {string} */ (text('email', { max: 254 })).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new ValidationError(`signers[${index}].email is not a valid address`, { field: 'signers' });
    }
    if (emails.has(email)) {
      throw new ValidationError('signers must have distinct email addresses', { field: 'signers' });
    }
    emails.add(email);
    const order = value.order === undefined || value.order === null ? index + 1 : value.order;
    if (!Number.isSafeInteger(order) || /** @type {number} */ (order) < 1 || /** @type {number} */ (order) > MAX_SIGNERS) {
      throw new ValidationError(`signers[${index}].order must be an integer 1-${MAX_SIGNERS}`, { field: 'signers' });
    }
    return {
      signerKey: `s${index + 1}`,
      name: /** @type {string} */ (text('name')),
      email,
      role: text('role', { required: false, max: 80 }) ?? 'signer',
      order: /** @type {number} */ (order),
    };
  });
  return signers.sort((a, b) => (a.order === b.order ? (a.signerKey < b.signerKey ? -1 : 1) : a.order - b.order));
}

/**
 * Build the deterministic canonical document package for an approved quote
 * version. It is derived ONLY from immutable snapshot rows plus the signer
 * list — never from the live catalog — so the same version always produces the
 * same hash. It is structured JSON, not a PDF, and is never described as one.
 */
export function buildDocumentPackage({ modules, names, services, quote, version, signers }) {
  const lines = trusted(modules, names.versionLine)
    .listWhere({ versionId: version.id })
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
  const components = trusted(modules, names.versionComponent).listWhere({ versionId: version.id });
  const totals = trusted(modules, names.versionTotal).listWhere({ versionId: version.id });

  let parties = { companyId: null, companyName: null, contactId: null, contactEmail: null, opportunityId: version.opportunityId ?? null };
  try {
    const opportunity = services?.opportunities?.get(version.opportunityId);
    if (opportunity) {
      parties.opportunityId = opportunity.id;
      parties.contactId = opportunity.contactId ?? null;
      const company = opportunity.companyId ? services?.companies?.get(opportunity.companyId) : null;
      if (company) {
        parties.companyId = company.id;
        parties.companyName = company.name ?? null;
      }
      if (opportunity.contactId && services?.contacts) {
        const contact = services.contacts.get(opportunity.contactId);
        if (contact) parties.contactEmail = contact.email ?? null;
      }
    }
  } catch {
    // A missing or unreadable party never blocks the package: identity that
    // exists is snapshotted, identity that does not stays null.
  }

  const document = {
    documentContract: 1,
    format: DOCUMENT_FORMAT,
    quote: { id: quote.id, priceBookId: quote.priceBookId, currency: quote.currency },
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      submittedAt: version.submittedAt,
      policy: version.policy,
      policyVersion: version.policyVersion,
      policyFingerprint: version.policyFingerprint,
      policyDecision: version.policyDecision,
      decisionReason: version.decisionReason ?? null,
      maxLineDiscountBps: version.maxLineDiscountBps,
      effectiveDiscountBps: version.effectiveDiscountBps,
    },
    parties,
    lines: lines.map((line) => ({
      id: line.id,
      offerLogicalKey: line.offerLogicalKey,
      offerRevision: line.offerRevision,
      offerName: line.offerName,
      productVersionId: line.productVersionId,
      sku: line.sku,
      quantity: line.quantity,
      discountBps: line.discountBps,
      listAmountCents: line.listAmountCents,
      discountAmountCents: line.discountAmountCents,
      netAmountCents: line.netAmountCents,
      position: line.position,
      components: components
        .filter((component) => component.versionLineId === line.id)
        .sort((a, b) => (a.componentKey < b.componentKey ? -1 : a.componentKey > b.componentKey ? 1 : a.id < b.id ? -1 : 1))
        .map((component) => ({
          componentKey: component.componentKey,
          label: component.label,
          chargeType: component.chargeType,
          pricingModel: component.pricingModel,
          interval: component.interval,
          intervalCount: component.intervalCount,
          quantity: component.quantity,
          unitAmountCents: component.unitAmountCents,
          flatAmountCents: component.flatAmountCents,
          tiers: fromJson(component.tiersJson),
          tierBreakdown: fromJson(component.tierBreakdownJson),
          listAmountCents: component.listAmountCents,
          discountAmountCents: component.discountAmountCents,
          netAmountCents: component.netAmountCents,
          sourcePricingModel: component.sourcePricingModel,
        })),
    })),
    totals: totals
      .map((total) => ({
        kind: total.kind,
        currency: total.currency,
        interval: total.interval,
        intervalCount: total.intervalCount,
        listAmountCents: total.listAmountCents,
        discountAmountCents: total.discountAmountCents,
        netAmountCents: total.netAmountCents,
      }))
      .sort((a, b) => `${a.kind}${a.interval ?? ''}${a.intervalCount ?? ''}`.localeCompare(`${b.kind}${b.interval ?? ''}${b.intervalCount ?? ''}`)),
    signers: signers.map((signer) => ({ signerKey: signer.signerKey, name: signer.name, email: signer.email, role: signer.role, order: signer.order })),
  };
  return { document, documentHash: computeDefinitionFingerprint(document) };
}

/** Load the quote version and validate it is signable for this quote. */
function requireApprovedVersion(modules, names, quote, quoteVersionId) {
  const version = trusted(modules, names.version).get(quoteVersionId);
  if (version.quoteId !== quote.id) {
    throw new AppError('The quote version belongs to another quote', { code: 'VERSION_MISMATCH', status: 409 });
  }
  if (quote.currentVersionId !== version.id) {
    throw new AppError('Only the current quote version can be signed — a superseded version is historical evidence', {
      code: 'VERSION_SUPERSEDED', status: 409,
    });
  }
  if (version.policyDecision === 'reject') {
    throw new AppError('The quote version was rejected by its discount policy', { code: 'VERSION_NOT_APPROVED', status: 409 });
  }
  const lineCount = trusted(modules, names.versionLine).countWhere({ versionId: version.id });
  if (lineCount === 0) {
    throw new AppError('The quote version carries no commercial snapshot', { code: 'VERSION_SNAPSHOT_INCOMPLETE', status: 409 });
  }
  if (trusted(modules, names.versionTotal).countWhere({ versionId: version.id }) === 0) {
    throw new AppError('The quote version carries no grouped totals', { code: 'VERSION_SNAPSHOT_INCOMPLETE', status: 409 });
  }
  return { version, lineCount };
}

/**
 * quote.request-signature — the external-operation action.
 * @param {Record<string, string>} [config]
 */
export function buildRequestSignatureAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.quote,
    name: 'request-signature',
    label: 'Request signature',
    description: 'Send the approved quote version to a signature provider (human decision).',
    actionContract: 1,
    externalOperation: 1,
    stateField: 'status',
    fromStates: ['approved'],
    confirm: true,
    input: [
      { name: 'quoteVersionId', type: 'string', required: true, hint: 'The approved quote version to sign.' },
      { name: 'provider', type: 'string', required: true, hint: 'Registered signature provider name.' },
      { name: 'providerVersion', type: 'integer', required: true, hint: 'Explicit provider version — never an implicit latest.' },
      { name: 'signers', type: 'json', required: true, hint: '1-5 signers: {name, email, role?, order?}. All signers are required to sign.' },
    ],

    /** Transaction A: local intent only — no remote call has happened yet. */
    intent({ record: quote, input, actor, modules, services, signature, now, step }) {
      // Sending for signature is a real external side effect: a human user
      // actor must own it. This is a HUMAN-ACTOR boundary, not Sales/Legal
      // role enforcement — real roles need the Production Spine.
      if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Requesting a signature requires a human user actor', { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
      }
      const { definition: provider, fingerprint } = signature.getSignatureProvider(input.provider, input.providerVersion);
      const { version } = requireApprovedVersion(modules, names, quote, input.quoteVersionId);
      const signers = normalizeSigners(input.signers);

      const envelopes = trusted(modules, names.envelope);
      // Exactly one envelope per quote version, ever — the DB-unique source
      // key is also the provider idempotency key, so a repeated request can
      // never produce a second provider envelope.
      const existing = envelopes.listWhere({ quoteVersionId: version.id })[0];
      if (existing) {
        throw new AppError(
          `A signature envelope already exists for this quote version (${existing.status}) — reconcile it instead of requesting a second one`,
          { code: 'ENVELOPE_EXISTS', status: 409, details: { envelopeId: existing.id, status: existing.status } },
        );
      }
      const { document, documentHash } = buildDocumentPackage({ modules, names, services, quote, version, signers });
      const idempotencyKey = `env:quote-version:${version.id}`;
      const requestedAt = now();
      const envelope = envelopes.createManaged(
        {
          sourceKey: idempotencyKey,
          idempotencyKey,
          quoteId: quote.id,
          quoteVersionId: version.id,
          provider: provider.name,
          providerVersion: provider.version,
          providerFingerprint: fingerprint,
          status: 'preparing',
          documentHash,
          documentFormat: DOCUMENT_FORMAT,
          signerCount: signers.length,
          providerSequence: 0,
          requestedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
          requestedAt,
        },
        { actor },
      );
      return Promise.resolve(envelope).then(async (created) => {
        const signerService = trusted(modules, names.signer);
        for (const signer of signers) {
          await signerService.createManaged(
            {
              sourceKey: `sgn:${created.id}:${signer.signerKey}`,
              envelopeId: created.id,
              signerKey: signer.signerKey,
              name: signer.name,
              email: signer.email,
              role: signer.role,
              signingOrder: signer.order,
              status: 'pending',
            },
            { actor },
          );
        }
        step('signature.intent-created', { envelopeId: created.id, signers: signers.length, documentHash });
        return {
          envelopeId: created.id,
          idempotencyKey,
          documentHash,
          document,
          provider: provider.name,
          providerVersion: provider.version,
          signers,
        };
      });
    },

    /** No transaction is open here, and no database handle is reachable. */
    async external({ intent, signature, step }) {
      const { definition: provider } = signature.getSignatureProvider(intent.provider, intent.providerVersion);
      const raw = await provider.createEnvelope({
        idempotencyKey: intent.idempotencyKey,
        documentHash: intent.documentHash,
        document: intent.document,
        signers: intent.signers,
      });
      const normalized = normalizeProviderEnvelope(raw);
      step('signature.provider-envelope', { providerEnvelopeId: normalized.providerEnvelopeId, status: normalized.status });
      return normalized;
    },

    /** Transaction B: persist the provider's answer. */
    async finalize({ intent, external, actor, modules, managed, now, step }) {
      const envelopes = trusted(modules, names.envelope);
      const envelope = envelopes.get(intent.envelopeId);
      const patch = {
        providerEnvelopeId: external.providerEnvelopeId,
        providerSequence: external.sequence,
        sentAt: now(),
        failureCode: null,
        failurePhase: null,
      };
      const status = canTransition(envelope.status, external.status) ? external.status : envelope.status;
      const updated = await envelopes.applyManaged(envelope.id, { ...patch, status }, { actor });
      await managed(envelope.quoteId, { signatureEnvelopeId: envelope.id, signatureStatus: status });
      step('signature.sent', { envelopeId: envelope.id, status });
      return { envelope: envelopeSummary(updated), signers: intent.signers.length };
    },

    /**
     * Transaction C: the provider call or the local finalization failed. The
     * envelope becomes `failed` — a RECOVERABLE state, because a timeout or an
     * unknown error may hide a provider envelope that really exists. The one
     * documented policy is: never silently retry, always reconcile.
     */
    async compensate({ intent, actor, modules, failure, phase, now, step }) {
      if (!intent?.envelopeId) return null;
      const envelopes = trusted(modules, names.envelope);
      const envelope = envelopes.get(intent.envelopeId);
      if (TERMINAL_ENVELOPE_STATES.includes(envelope.status)) return null;
      const updated = await envelopes.applyManaged(
        envelope.id,
        {
          status: 'failed',
          failedAt: now(),
          failurePhase: phase,
          failureCode: String(failure?.code ?? 'UNKNOWN').slice(0, 80),
        },
        { actor },
      );
      step('signature.failed', { envelopeId: envelope.id, phase, code: updated.failureCode });
      return { envelope: envelopeSummary(updated) };
    },
  };
}

/** @param {any} envelope */
function envelopeSummary(envelope) {
  return {
    id: envelope.id,
    quoteId: envelope.quoteId,
    quoteVersionId: envelope.quoteVersionId,
    provider: envelope.provider,
    providerVersion: envelope.providerVersion,
    providerEnvelopeId: envelope.providerEnvelopeId,
    status: envelope.status,
    documentHash: envelope.documentHash,
    documentFormat: envelope.documentFormat,
    signerCount: envelope.signerCount,
    signedArtifactId: envelope.signedArtifactId,
    orderId: envelope.orderId,
    failureCode: envelope.failureCode,
    failurePhase: envelope.failurePhase,
  };
}

/**
 * Apply a normalized provider state to an envelope, monotonically, and create
 * the completion evidence when (and only when) the envelope reaches
 * `completed` for the first time. Runs INSIDE a write transaction.
 */
async function applyProviderState({ modules, services, names, envelope, provider, state, artifact, eventId, actor, now, step }) {
  const envelopes = trusted(modules, names.envelope);
  if (!canTransition(envelope.status, state.status)) {
    return { applied: false, reason: TERMINAL_ENVELOPE_STATES.includes(envelope.status) ? 'terminal' : 'not-newer', status: envelope.status };
  }
  const at = now();
  /** @type {Record<string, unknown>} */
  const patch = { status: state.status, providerSequence: Math.max(envelope.providerSequence ?? 0, state.sequence ?? 0) };
  if (state.status === 'sent') patch.sentAt = envelope.sentAt ?? at;
  if (state.status === 'delivered') patch.deliveredAt = at;
  if (state.status === 'declined') patch.declinedAt = at;
  if (state.status === 'voided') patch.voidedAt = at;
  if (state.status === 'completed') patch.completedAt = state.completedAt ?? at;
  if (state.status !== 'failed') { patch.failureCode = null; patch.failurePhase = null; }

  // Signer evidence follows the provider, bounded to the signers we snapshotted.
  const signerService = trusted(modules, names.signer);
  const signerRows = signerService.listWhere({ envelopeId: envelope.id });
  for (const providerSigner of state.signers ?? []) {
    const row = signerRows.find((candidate) => candidate.signerKey === providerSigner.signerKey);
    if (!row || row.status === providerSigner.status) continue;
    if (row.status !== 'pending') continue; // signer decisions are terminal too
    await signerService.applyManaged(row.id, { status: providerSigner.status, decidedAt: providerSigner.decidedAt ?? at }, { actor });
  }

  let order = null;
  let signedArtifact = null;
  if (state.status === 'completed') {
    const evidence = await createCompletionEvidence({
      modules, services, names, envelope, provider, artifact, eventId, actor, now, step,
    });
    signedArtifact = evidence.artifact;
    order = evidence.order;
    patch.signedArtifactId = signedArtifact.id;
    patch.orderId = order.id;
  }
  const updated = await envelopes.applyManaged(envelope.id, patch, { actor });
  step(`signature.${state.status}`, { envelopeId: envelope.id, orderId: order?.id ?? null });
  return { applied: true, status: state.status, envelope: envelopeSummary(updated), orderId: order?.id ?? null, signedArtifactId: signedArtifact?.id ?? null };
}

/**
 * The atomic completion: signed-artifact evidence plus exactly ONE immutable
 * Order with its lines, components, tier schedules and grouped totals, copied
 * from the approved Quote Version snapshot. Runs inside the caller's
 * transaction, so everything here commits together or not at all.
 */
async function createCompletionEvidence({ modules, services, names, envelope, artifact, eventId, actor, now, step }) {
  const quotes = trusted(modules, names.quote);
  const quote = quotes.get(envelope.quoteId);
  const versions = trusted(modules, names.version);
  const version = versions.get(envelope.quoteVersionId);
  if (version.quoteId !== envelope.quoteId) {
    throw new AppError('The envelope points at a version of another quote', { code: 'SIGNATURE_STATE_CORRUPT', status: 409 });
  }
  if (quote.status !== 'approved') {
    throw new AppError(`The source quote is ${quote.status}, not approved`, { code: 'VERSION_NOT_APPROVED', status: 409 });
  }

  const signers = trusted(modules, names.signer)
    .listWhere({ envelopeId: envelope.id })
    .sort((a, b) => (a.signingOrder === b.signingOrder ? (a.signerKey < b.signerKey ? -1 : 1) : a.signingOrder - b.signingOrder));

  // The document package is rebuilt from the snapshot and must hash to exactly
  // what was sent for signature: proof that nothing in the commercial evidence
  // moved between the request and the signature.
  const rebuilt = buildDocumentPackage({
    modules, names, services, quote, version,
    signers: signers.map((signer) => ({ signerKey: signer.signerKey, name: signer.name, email: signer.email, role: signer.role, order: signer.signingOrder })),
  });
  if (rebuilt.documentHash !== envelope.documentHash) {
    throw new AppError('The signed document package no longer matches the stored quote version snapshot', {
      code: 'DOCUMENT_HASH_MISMATCH', status: 409,
    });
  }

  const artifacts = trusted(modules, names.artifact);
  const existingArtifact = artifacts.listWhere({ envelopeId: envelope.id })[0];
  const completedAt = artifact?.completedAt ?? now();
  const signedArtifact = existingArtifact ?? await artifacts.createManaged(
    {
      sourceKey: `art:${envelope.id}`,
      envelopeId: envelope.id,
      quoteId: envelope.quoteId,
      quoteVersionId: envelope.quoteVersionId,
      provider: envelope.provider,
      providerArtifactId: artifact?.artifactId ?? null,
      documentHash: envelope.documentHash,
      documentFormat: envelope.documentFormat,
      artifactHash: artifact?.artifactHash ?? null,
      mimeType: artifact?.mimeType ?? null,
      sizeBytes: artifact?.sizeBytes ?? null,
      storageRef: artifact?.storageRef ?? null,
      completionEventId: eventId ?? null,
      completedAt,
      signerEvidenceJson: toJson(
        signers.map((signer) => ({ signerKey: signer.signerKey, email: signer.email, role: signer.role, order: signer.signingOrder, status: signer.status, decidedAt: signer.decidedAt ?? null })),
        'signer evidence',
      ),
    },
    { actor },
  );

  const orders = trusted(modules, names.order);
  const existingOrder = orders.listWhere({ quoteVersionId: envelope.quoteVersionId })[0];
  if (existingOrder) {
    step('order.exists', { orderId: existingOrder.id });
    return { artifact: signedArtifact, order: existingOrder };
  }

  const versionLines = trusted(modules, names.versionLine)
    .listWhere({ versionId: version.id })
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position));
  const versionComponents = trusted(modules, names.versionComponent).listWhere({ versionId: version.id });
  const versionTotals = trusted(modules, names.versionTotal).listWhere({ versionId: version.id });

  let companyId = null;
  let contactId = null;
  try {
    const opportunity = services?.opportunities?.get(version.opportunityId);
    companyId = opportunity?.companyId ?? null;
    contactId = opportunity?.contactId ?? null;
  } catch {
    companyId = null;
  }

  const order = await orders.createManaged(
    {
      sourceKey: `order:quote-version:${version.id}`,
      quoteId: quote.id,
      quoteVersionId: version.id,
      envelopeId: envelope.id,
      signedArtifactId: signedArtifact.id,
      opportunityId: version.opportunityId,
      companyId,
      contactId,
      currency: version.currency,
      status: 'accepted',
      versionNumber: version.versionNumber,
      policy: version.policy,
      policyVersion: version.policyVersion,
      policyDecision: version.policyDecision,
      documentHash: envelope.documentHash,
      artifactHash: signedArtifact.artifactHash,
      totalsJson: version.totalsJson,
      oneTimeNetCents: version.oneTimeNetCents,
      recurringGroupCount: version.recurringGroupCount,
      lineCount: versionLines.length,
      acceptedAt: completedAt,
      sourceFingerprint: rebuilt.documentHash,
    },
    { actor },
  );

  const orderLines = trusted(modules, names.orderLine);
  const orderComponents = trusted(modules, names.orderComponent);
  const orderTiers = trusted(modules, names.orderTier);
  for (const line of versionLines) {
    const orderLine = await orderLines.createManaged(
      {
        orderId: order.id,
        versionLineId: line.id,
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
    for (const component of versionComponents.filter((candidate) => candidate.versionLineId === line.id)) {
      const orderComponent = await orderComponents.createManaged(
        {
          orderId: order.id,
          orderLineId: orderLine.id,
          versionComponentId: component.id,
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
          provider: component.provider,
          externalPriceId: component.externalPriceId,
          sourcePricingModel: component.sourcePricingModel,
        },
        { actor },
      );
      for (const tier of fromJson(component.tiersJson) ?? []) {
        await orderTiers.createManaged(
          {
            orderId: order.id,
            orderComponentId: orderComponent.id,
            position: tier.position,
            upToQuantity: tier.upTo ?? null,
            unitAmountCents: tier.unitAmountCents,
            flatAmountCents: tier.flatAmountCents ?? 0,
          },
          { actor },
        );
      }
    }
  }
  const orderTotals = trusted(modules, names.orderTotal);
  for (const total of versionTotals) {
    await orderTotals.createManaged(
      {
        orderId: order.id,
        kind: total.kind,
        currency: total.currency,
        interval: total.interval,
        intervalCount: total.intervalCount,
        listAmountCents: total.listAmountCents,
        discountAmountCents: total.discountAmountCents,
        netAmountCents: total.netAmountCents,
      },
      { actor },
    );
  }
  await quotes.applyManaged(quote.id, { orderId: order.id, signatureStatus: 'completed' }, { actor });
  step('order.created', { orderId: order.id, lines: versionLines.length, totals: versionTotals.length });
  return { artifact: signedArtifact, order };
}

/**
 * App-level signature operations: verified event ingestion and reconciliation.
 * Both follow the external-operation contract, so neither holds a transaction
 * open across a provider call.
 *
 * @param {{database: any, events: any, modules: any, services?: any, signature: any, config?: Record<string, any>}} deps
 */
export function createSignatureOperations(deps) {
  const { database, events, modules, services, signature } = deps;
  const names = resolvedNames(deps.config ?? {});
  const timeoutMs = deps.config?.signatureTimeoutMs;

  /**
   * Ingest one provider event. Verification happens BEFORE any state is
   * touched; the inbox row is DB-unique per provider event id, so a replay is
   * idempotent; artifact metadata is fetched outside the transaction; and the
   * transition plus all completion evidence commit together.
   *
   * @param {{provider: string, rawBody: string, headers?: Record<string, unknown>, actor?: unknown}} params
   */
  async function ingestSignatureEvent(params) {
    const providerName = typeof params.provider === 'string' ? params.provider : '';
    const { definition: provider, fingerprint } = signature.getSignatureProviderByName(providerName);
    const rawBody = typeof params.rawBody === 'string' ? params.rawBody : '';
    const actor = params.actor ?? { type: 'system', id: `signature:${provider.name}` };

    // Verify first. A failure never echoes the payload, the signature or the
    // key, and never writes anything.
    /** @type {any} */
    let verified;
    try {
      verified = await withExternalTimeout(
        Promise.resolve(provider.verifyEvent({ rawBody, headers: params.headers ?? {}, config: provider.config ?? {} })),
        Number.isSafeInteger(timeoutMs) ? timeoutMs : 2_000,
        `signature provider "${provider.name}" verifyEvent`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      throw new AppError(`Signature event verification failed: ${normalized.code === 'PROVIDER_TIMEOUT' ? 'verification timed out' : 'invalid signature'}`, {
        code: 'SIGNATURE_INVALID', status: 401,
      });
    }
    if (!verified || verified.ok !== true) {
      throw new AppError('Signature event verification failed: invalid signature', { code: 'SIGNATURE_INVALID', status: 401 });
    }
    const event = normalizeProviderEvent(verified.event);

    const { result } = await runExternalOperation({
      database,
      events,
      name: 'signature.event',
      input: { provider: provider.name, providerEventId: event.providerEventId, status: event.status },
      actor,
      timeoutMs,
      /** Transaction A: the append-only inbox row. */
      intent({ now, step }) {
        const inbox = trusted(modules, names.event);
        const already = inbox.listWhere({ provider: provider.name, providerEventId: event.providerEventId })[0];
        if (already) {
          step('signature.event-duplicate', { providerEventId: event.providerEventId });
          return { duplicate: true, eventId: already.id, effect: already.effect };
        }
        const envelope = trusted(modules, names.envelope).listWhere({ providerEnvelopeId: event.providerEnvelopeId })[0] ?? null;
        return Promise.resolve(inbox.createManaged(
          {
            sourceKey: `sev:${provider.name}:${event.providerEventId}`,
            provider: provider.name,
            providerVersion: provider.version,
            providerFingerprint: fingerprint,
            providerEventId: event.providerEventId,
            providerEnvelopeId: event.providerEnvelopeId,
            envelopeId: envelope?.id ?? null,
            status: event.status,
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            receivedAt: now(),
            processed: false,
            // Unknown envelope: recorded as evidence and quarantined rather
            // than erroring — one documented policy, no silent discard.
            effect: envelope ? 'pending' : 'quarantined',
            effectReason: envelope ? null : 'no local envelope for this provider envelope id',
          },
          { actor },
        )).then((row) => {
          step('signature.event-accepted', { eventId: row.id, status: event.status, envelopeId: envelope?.id ?? null });
          return {
            duplicate: false,
            quarantined: !envelope,
            eventId: row.id,
            envelopeId: envelope?.id ?? null,
            currentStatus: envelope?.status ?? null,
            needsArtifact: Boolean(envelope) && event.status === 'completed' && canTransition(envelope.status, 'completed'),
            providerEnvelopeId: event.providerEnvelopeId,
          };
        });
      },
      /** Only a first, applicable completion needs artifact metadata. */
      async external({ intent, step }) {
        if (!intent?.needsArtifact) return null;
        const raw = await provider.getSignedArtifact({ providerEnvelopeId: intent.providerEnvelopeId });
        const artifact = normalizeProviderArtifact(raw);
        step('signature.artifact-fetched', { artifactId: artifact.artifactId });
        return artifact;
      },
      /** Transaction B: monotonic transition + atomic completion evidence. */
      async finalize({ intent, external, now, step }) {
        if (intent.duplicate) return { duplicate: true, eventId: intent.eventId, effect: intent.effect };
        const inbox = trusted(modules, names.event);
        if (intent.quarantined) {
          await inbox.applyManaged(intent.eventId, { processed: true }, { actor });
          return { quarantined: true, eventId: intent.eventId };
        }
        const envelope = trusted(modules, names.envelope).get(intent.envelopeId);
        const outcome = await applyProviderState({
          modules, services, names, envelope, provider,
          state: { status: event.status, sequence: event.sequence, signers: event.signers, completedAt: event.occurredAt },
          artifact: external, eventId: intent.eventId, actor, now, step,
        });
        await inbox.applyManaged(
          intent.eventId,
          {
            processed: true,
            effect: outcome.applied ? 'applied' : 'ignored',
            effectReason: outcome.applied ? null : `envelope already ${outcome.status} (${outcome.reason})`,
          },
          { actor },
        );
        return { eventId: intent.eventId, envelopeId: envelope.id, ...outcome };
      },
    });
    return { ok: true, provider: provider.name, ...result };
  }

  /**
   * Reconcile one envelope against the provider. This is the documented
   * recovery for a lost webhook, a provider success whose local finalization
   * failed, or a restart mid-flight. It never duplicates events, artifacts or
   * orders, and it never regresses a terminal envelope.
   *
   * @param {{envelopeId: string, actor?: unknown}} params
   */
  async function reconcileSignature(params) {
    const actor = params.actor ?? { type: 'system', id: 'signature-reconcile' };
    const { result } = await runExternalOperation({
      database,
      events,
      name: 'signature.reconcile',
      input: { envelopeId: params.envelopeId },
      actor,
      timeoutMs,
      /** Read-only intent: reconciliation records nothing before it knows. */
      intent({ step }) {
        const envelope = trusted(modules, names.envelope).get(String(params.envelopeId));
        step('signature.reconcile-start', { envelopeId: envelope.id, status: envelope.status });
        return {
          envelopeId: envelope.id,
          status: envelope.status,
          provider: envelope.provider,
          providerVersion: envelope.providerVersion,
          providerEnvelopeId: envelope.providerEnvelopeId,
          idempotencyKey: envelope.idempotencyKey,
          terminal: TERMINAL_ENVELOPE_STATES.includes(envelope.status),
        };
      },
      async external({ intent, step }) {
        if (intent.terminal) return null;
        const { definition: provider } = signature.getSignatureProvider(intent.provider, intent.providerVersion);
        // Look the envelope up by provider id when known, and otherwise by the
        // deterministic idempotency key — which is exactly how a provider
        // success whose local finalization failed is recovered.
        const raw = await provider.getEnvelope({
          providerEnvelopeId: intent.providerEnvelopeId,
          idempotencyKey: intent.idempotencyKey,
        });
        if (raw === null || raw === undefined) {
          step('signature.reconcile-absent', { envelopeId: intent.envelopeId });
          return { absent: true };
        }
        const state = normalizeProviderEnvelope(raw);
        const artifact = state.status === 'completed'
          ? normalizeProviderArtifact(await provider.getSignedArtifact({ providerEnvelopeId: state.providerEnvelopeId }))
          : null;
        step('signature.reconcile-state', { status: state.status });
        return { absent: false, state, artifact };
      },
      async finalize({ intent, external, now, step }) {
        if (intent.terminal) return { envelopeId: intent.envelopeId, applied: false, reason: 'terminal', status: intent.status };
        if (!external || external.absent) return { envelopeId: intent.envelopeId, applied: false, reason: 'absent-at-provider', status: intent.status };
        const envelopes = trusted(modules, names.envelope);
        const envelope = envelopes.get(intent.envelopeId);
        const state = external.state;
        // A recovered provider envelope id is persisted even when the state
        // itself does not advance, so later lookups stop needing the key.
        if (!envelope.providerEnvelopeId && state.providerEnvelopeId) {
          await envelopes.applyManaged(envelope.id, { providerEnvelopeId: state.providerEnvelopeId, sentAt: envelope.sentAt ?? now() }, { actor });
        }
        const current = envelopes.get(envelope.id);
        const outcome = await applyProviderState({
          modules, services, names, envelope: current, provider: intent.provider,
          state, artifact: external.artifact, eventId: null, actor, now, step,
        });
        return { envelopeId: envelope.id, ...outcome };
      },
    });
    return { ok: true, ...result };
  }

  return { ingestSignatureEvent, reconcileSignature };
}

export { resolvedNames as signatureModuleNames, NotFoundError };
