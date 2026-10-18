// @ts-check

import {
  AppError,
  SENSITIVE_KEY,
  ValidationError,
  normalizeError,
  nowIso,
  requireAmount,
  trustedSystemActor,
  withTimeout,
} from '../../core/index.js';
import {
  assertConnectionInput,
  assertCurrency,
  assertSpaceId,
  boundedKey,
  paymentIntentKey,
} from './connection.js';
import { fingerprintPayload } from './crypto.js';
import { STRIPE_FINAL_TYPES } from './stripe.js';
import { REQUEST_STATUSES, REQUEST_TERMINAL, advancePaymentRequest, withPaymentWrite } from './transitions.js';

/**
 * Payment operations (backlog:1972e16d33f2).
 *
 * The application-scoped entry points a deployment drives: register a
 * Stripe connection per space, request a payment from a quote or an offer
 * (intent → provider checkout → pending), and ingest the verified provider
 * webhook that finalizes it exactly once. Reads (`getPaymentStatus`,
 * `listPayments`) are what the customer card and the sales pipeline render.
 *
 * What is deliberately NOT here: invoices (the packet forbids them — this
 * record is the payment, never a fiscal document), the per-space HTTP route
 * (the pilot owns it), secret custody (the deployment injects
 * `resolveSecret`), card and pipeline rendering (they read the status —
 * follow-up voice), and reconciliation (follow-up — redelivery resumes).
 */

export const PAYMENT_CREATE_TIMEOUT_MS = 10000;
export const PAYMENT_VERIFY_TIMEOUT_MS = 2000;
export const PAYMENT_MAX_BODY_BYTES = 1024 * 1024;
export const PAYMENT_SECRET_PURPOSE_INBOUND = 'payment-inbound';
export const PAYMENT_SECRET_PURPOSE_OUTBOUND = 'payment-outbound';

/**
 * Stripe-family secret prefixes the generic SENSITIVE_KEY denylist does not
 * name: a minted checkout value carrying one is refused, never stored.
 */
const STRIPE_SECRET_SHAPE = /(?:sk_live_|sk_test_|rk_live_|rk_test_|whsec_)/;

/**
 * Quarantine-reason prefix for deliveries held only because their
 * connection was not active. A same-id redelivery after reactivation
 * resumes from this marker instead of replaying the old quarantine
 * forever (suspend-connection quarantines "until reinstatement").
 */
const QUARANTINE_INACTIVE_PREFIX = 'connection is ';

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    connection: config.connectionModule ?? 'payment-connection',
    request: config.requestModule ?? 'payment-request',
    event: config.eventModule ?? 'payment-event',
  };
}

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name, code) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply it from the current manifest`, {
      code, status: 500,
    });
  }
  return service;
}

function isCanonicalInstant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function requireUser(actor) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError('Payment requests and connection changes require a human user actor', {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
  return actor;
}

function actorId(actor) {
  const id = /** @type {any} */ (actor)?.id;
  return typeof id === 'string' && id !== '' ? id : 'unknown';
}

const SYSTEM = () => trustedSystemActor('payment package internal write');

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedId(value, label, max = 256) {
  if (typeof value !== 'string' || value === '' || value.length > max
    || hasControlChar(value)) {
    throw new ValidationError(`${label} must be bounded single-line text (at most ${max} characters)`, { field: label });
  }
  return value;
}

/**
 * The idempotency contract: the same intent key with the same terms
 * resolves to the same checkout; the same key with different terms is a
 * conflict, never the original checkout (which would collect the wrong
 * amount while the caller believes it asked for the new one).
 */
function assertSamePaymentTerms(existing, terms) {
  if (existing.amount !== terms.amount || existing.currency !== terms.currency
    || (existing.quoteId ?? '') !== terms.quoteId || (existing.offerId ?? '') !== terms.offerId) {
    throw new AppError('Payment request already recorded with different terms: start a new intent with a new requestKey', {
      code: 'PAYMENT_REQUEST_CONFLICT', status: 409, details: { status: existing.status },
    });
  }
}

/**
 * @param {{
 *   database: any, modules: any, registries: any,
 *   resolveSecret: (reference: string, context: {spaceId: string, purpose: string}) => Promise<string>,
 *   tenantId?: string,
 *   config?: Record<string, any>,
 * }} deps `resolveSecret` is the deployment's custody edge (platform
 * runtime-vault in production, a fixture map in tests): the reference is
 * stored, the value is resolved at call time and never persisted.
 */
export function createPaymentOperations(deps) {
  const { database, modules, registries } = deps;
  if (!modules || !registries || typeof registries.getAdapter !== 'function') {
    throw new ValidationError('createPaymentOperations needs modules and payment registries — compose the package rather than wiring it by hand');
  }
  // Custody is deployment-owned and optional at composition: without it
  // every secret resolution refuses, so payment creation and inbound
  // verification cannot run until the deployment wires its vault.
  // Validation and conformance compose empty on purpose.
  const resolveSecret = typeof deps.resolveSecret === 'function' ? deps.resolveSecret : async () => {
    throw new AppError('Payment secret custody is not wired: compose the package with resolveSecret', {
      code: 'PAYMENT_SECRET_UNAVAILABLE', status: 500,
    });
  };
  const names = resolvedNames(deps.config ?? {});
  const createTimeoutMs = Number.isSafeInteger(deps.config?.createTimeoutMs) ? deps.config.createTimeoutMs : PAYMENT_CREATE_TIMEOUT_MS;
  const verifyTimeoutMs = Number.isSafeInteger(deps.config?.verifyTimeoutMs) ? deps.config.verifyTimeoutMs : PAYMENT_VERIFY_TIMEOUT_MS;

  const connections = () => trusted(modules, names.connection, 'PAYMENT_STORAGE_INVALID');
  const requests = () => trusted(modules, names.request, 'PAYMENT_STORAGE_INVALID');
  const events = () => trusted(modules, names.event, 'PAYMENT_STORAGE_INVALID');

  /**
   * The stores every request state change moves through: the single path
   * (transitions.js `advancePaymentRequest`) re-reads both rows inside one
   * transaction and derives the move from the table.
   */
  const requestStores = () => ({ requests: requests(), connections: connections(), database });

  /**
   * Load one connection, scoped to its space. A key from another space is
   * not found (404), never forbidden (403): the caller learns nothing about
   * which spaces exist or what they bound.
   */
  function getConnection(spaceId, connectionKey) {
    const space = assertSpaceId(spaceId);
    if (typeof connectionKey !== 'string' || connectionKey === '') return null;
    return connections().listWhere({ spaceId: space, sourceKey: connectionKey })[0] ?? null;
  }

  function requireConnection(spaceId, connectionKey) {
    const row = getConnection(spaceId, connectionKey);
    if (!row) {
      throw new AppError('Unknown payment connection', { code: 'PAYMENT_CONNECTION_UNKNOWN', status: 404 });
    }
    return row;
  }

  function requireActiveConnection(spaceId, connectionKey) {
    const row = requireConnection(spaceId, connectionKey);
    if (row.status !== 'active') {
      throw new AppError(`Payment connection is ${row.status}`, { code: 'PAYMENT_CONNECTION_NOT_ACTIVE', status: 409 });
    }
    return row;
  }

  /**
   * Register one connection. The DB-unique source key makes a repeated
   * registration resolve identically; the same key with different bindings
   * is a conflict, not an adoption.
   */
  async function registerPaymentConnection(params) {
    const actor = requireUser(params?.actor);
    const normalized = assertConnectionInput(params, registries);
    const service = connections();
    const resolveExisting = (existing) => {
      // Identity is the lowercased source key, so equality is too: a
      // case-only retry of the same account resolves identically instead
      // of conflicting with itself.
      if (existing.provider === normalized.provider && existing.adapter === normalized.adapter
        && existing.adapterVersion === normalized.adapterVersion
        && typeof existing.account === 'string'
        && existing.account.toLowerCase() === normalized.account.toLowerCase()
        && existing.secretRef === normalized.secretRef) {
        return { duplicate: true, connection: existing };
      }
      // A revoked-then-reregistered account is refused here on purpose:
      // the explicit rebind-connection action is the only way back, so the
      // refusal names it instead of a revoke that could never unblock this.
      const guidance = existing.status === 'revoked'
        ? 'rebind it with the rebind-connection action'
        : 'rotate its secret with rotate-connection-secret, or revoke it and rebind it with rebind-connection';
      throw new AppError(`A connection already binds this account differently — ${guidance}`, {
        code: 'PAYMENT_CONNECTION_CONFLICT', status: 409,
        details: { connectionKey: existing.sourceKey, status: existing.status },
      });
    };
    const existing = service.listWhere({ sourceKey: normalized.sourceKey })[0];
    if (existing) return resolveExisting(existing);
    const now = nowIso();
    try {
      const connection = await service.createManaged({
        sourceKey: normalized.sourceKey,
        spaceId: normalized.spaceId,
        provider: normalized.provider,
        account: normalized.account,
        adapter: normalized.adapter,
        adapterVersion: normalized.adapterVersion,
        adapterFingerprint: normalized.adapterFingerprint,
        status: 'pending',
        statusReason: 'registered, awaiting activation',
        secretRef: normalized.secretRef,
        secretRotatedAt: now,
        createdBy: actorId(actor),
      }, { actor });
      return { duplicate: false, connection };
    } catch (error) {
      // A concurrent registration won the same source key: losing the race
      // resolves against the committed row, never as a raw unique violation.
      const raced = service.listWhere({ sourceKey: normalized.sourceKey })[0];
      if (raced) return resolveExisting(raced);
      throw error;
    }
  }

  /**
   * Request a payment from exactly one of a quote (proposal) or an offer.
   * The intent row (`open`) is written first; the provider checkout is
   * minted under the deterministic intent key, so a retried request with
   * the same key resolves to the same checkout instead of minting a
   * second one. A raw secret value anywhere near the input is refused
   * before anything is stored.
   */
  async function requestPayment(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const connection = requireActiveConnection(spaceId, params?.connectionKey);
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    // Trimmed before the exactly-one check: a whitespace-only id is no
    // id at all, and the trimmed value is what gets stored and compared.
    const quoteId = typeof params?.quoteId === 'string' ? params.quoteId.trim() : '';
    const offerId = typeof params?.offerId === 'string' ? params.offerId.trim() : '';
    if ((quoteId === '') === (offerId === '')) {
      throw new ValidationError('payment needs exactly one of quoteId or offerId', { field: 'quoteId' });
    }
    if (quoteId !== '') boundedId(quoteId, 'quoteId');
    if (offerId !== '') boundedId(offerId, 'offerId');
    const amount = requireAmount(params?.amount, 'amount');
    if (amount <= 0) {
      throw new ValidationError('payment amount must be a positive integer in minor units', { field: 'amount' });
    }
    const currency = assertCurrency(params?.currency);
    const requestKey = boundedId(params?.requestKey ?? '', 'requestKey', 256);
    const sourceKey = paymentIntentKey({ spaceId, connectionKey: connection.sourceKey, requestKey });

    const service = requests();
    const newTerms = { amount, currency, quoteId, offerId };
    const existing = service.listWhere({ sourceKey })[0];
    if (existing) {
      assertSamePaymentTerms(existing, newTerms);
      if (existing.status === 'open') {
        return mintExternal(existing);
      }
      if (existing.status === 'pending' || existing.status === 'paid') {
        return { duplicate: true, request: existing };
      }
      throw new AppError(`Payment request is ${existing.status}: start a new intent with a new requestKey`, {
        code: 'PAYMENT_REQUEST_CLOSED', status: 409, details: { status: existing.status },
      });
    }

    let intent;
    try {
      intent = await service.createManaged({
        sourceKey, spaceId, connectionKey: connection.sourceKey,
        quoteId, offerId, amount, currency,
        status: 'open', statusReason: 'intent recorded, provider checkout not yet minted',
        providerRef: '', providerUrl: '', paidAt: null,
        createdBy: actorId(actor),
      }, { actor });
    } catch (error) {
      // A concurrent request won the same intent key: resolve against the
      // committed row instead of surfacing a raw unique violation.
      const raced = service.listWhere({ sourceKey })[0];
      if (raced) {
        assertSamePaymentTerms(raced, newTerms);
        if (raced.status === 'open') return mintExternal(raced);
        if (raced.status === 'pending' || raced.status === 'paid') return { duplicate: true, request: raced };
        throw new AppError(`Payment request is ${raced.status}: start a new intent with a new requestKey`, {
          code: 'PAYMENT_REQUEST_CLOSED', status: 409, details: { status: raced.status },
        });
      }
      throw error;
    }
    return mintExternal(intent);

    async function mintExternal(row) {
      // A held checkout from a suspended mint is never minted twice: an
      // open row already carrying a provider reference resumes it below,
      // so a retry after reactivation moves the same session to pending
      // instead of minting a second one. Only the hold path below ever
      // sets a reference on an open row, so a non-empty reference here
      // always means a held checkout for this same intent.
      if (typeof row.providerRef === 'string' && row.providerRef !== '') {
        const resumed = await advancePaymentRequest(requestStores(), row.id, {
          event: 'mint',
          patch: {
            providerRef: row.providerRef, providerUrl: row.providerUrl ?? '',
            statusReason: 'held provider checkout resumed after suspension',
          },
          actor: SYSTEM(),
          requireActiveConnection: true,
        });
        return { duplicate: false, request: resumed.request };
      }
      let secret;
      try {
        secret = await resolveSecret(connection.secretRef, { spaceId, purpose: PAYMENT_SECRET_PURPOSE_OUTBOUND });
      } catch {
        throw new AppError('Payment secret is unavailable', { code: 'PAYMENT_SECRET_UNAVAILABLE', status: 500 });
      }
      if (typeof secret !== 'string' || secret === '') {
        throw new AppError('Payment secret is unavailable', { code: 'PAYMENT_SECRET_UNAVAILABLE', status: 500 });
      }
      let created;
      try {
        created = await withTimeout(
          Promise.resolve(adapter.createPayment({
            amount: row.amount, currency: row.currency, intentKey: row.sourceKey, secret,
          })),
          createTimeoutMs,
          `payment adapter "${adapter.name}" createPayment`,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === 'PROVIDER_TIMEOUT') {
          throw new AppError('Payment provider timed out: retry the request with the same requestKey', {
            code: 'PAYMENT_PROVIDER_UNAVAILABLE', status: 503,
          });
        }
        throw new AppError('Payment provider refused the checkout', {
          code: 'PAYMENT_PROVIDER_REFUSED', status: 502,
        });
      }
      const providerRef = boundedId(created?.providerRef ?? '', 'providerRef');
      const providerUrl = boundedId(created?.url ?? '', 'providerUrl', 1024);
      // The checkout URL is provider output, never a secret: still, a minted
      // value shaped like a secret — including Stripe-family prefixes the
      // generic denylist does not name — is refused rather than stored.
      if (SENSITIVE_KEY.test(providerRef) || SENSITIVE_KEY.test(providerUrl)
        || STRIPE_SECRET_SHAPE.test(providerRef) || STRIPE_SECRET_SHAPE.test(providerUrl)) {
        throw new AppError('Payment provider returned a secret-shaped reference', {
          code: 'PAYMENT_PROVIDER_INVALID', status: 502,
        });
      }
      // The single state path re-reads the row and its connection inside
      // one transaction: a suspend that landed during the provider call is
      // refused here, never minted onto a dead binding.
      let moved;
      try {
        moved = await advancePaymentRequest(requestStores(), row.id, {
          event: 'mint',
          patch: {
            providerRef, providerUrl,
            statusReason: 'provider checkout minted, awaiting webhook finalization',
          },
          actor: SYSTEM(),
          requireActiveConnection: true,
        });
      } catch (error) {
        // A suspend landed after the provider minted but before the move
        // committed: the live session is held on the intent instead of
        // dropped, so its later webhook still matches this row and a retry
        // with the same key resumes it (see above) instead of minting a
        // second session. The refusal still surfaces, so the caller knows
        // to retry after reactivation. First holder wins: the conditional
        // write never overwrites a reference another mint already held.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_CONNECTION_NOT_ACTIVE') {
          await withPaymentWrite(async () => {
            const current = await service.get(row.id);
            if (!current) throw error;
            if (typeof current.providerRef === 'string' && current.providerRef !== '') return;
            await service.applyManaged(row.id, {
              providerRef, providerUrl,
              statusReason: 'provider checkout minted while the connection suspended: held for resume, never dropped',
            }, { actor: SYSTEM() });
          });
        }
        // A concurrent mint won the same open intent while this call was at
        // the provider: the single path read the winner, so this call
        // resolves against the winner instead of erroring the retry — the
        // same key with the same terms is the same checkout.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_TRANSITION_INVALID') {
          const current = await service.get(row.id);
          if (current) {
            // Stored nulls normalize to '' exactly like the pre-check terms
            // do: the row is evidence, and only real term differences
            // conflict.
            assertSamePaymentTerms(current, {
              amount: row.amount, currency: row.currency,
              quoteId: row.quoteId ?? '', offerId: row.offerId ?? '',
            });
            if (current.status === 'pending' || current.status === 'paid') {
              return { duplicate: true, request: current };
            }
            throw new AppError(`Payment request is ${current.status}: start a new intent with a new requestKey`, {
              code: 'PAYMENT_REQUEST_CLOSED', status: 409, details: { status: current.status },
            });
          }
        }
        throw error;
      }
      return { duplicate: false, request: moved.request };
    }
  }

  /**
   * Ingest one provider webhook delivery for one space and connection.
   * Verification sees the exact bytes the provider signed, before any
   * mutation; the event row is DB-unique per (space, connection, provider
   * event id), so a replay is idempotent; a redelivery carrying a
   * different payload under the same id is a provider contract violation
   * (409), not a second payment; an event for an unknown checkout is
   * quarantined as evidence. A terminal request never regresses: an event
   * that agrees with it resolves without writing; one that contradicts it
   * quarantines, and the stored outcome wins.
   */
  async function ingestPaymentEvent(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireConnection(spaceId, connectionKey);
    // Provider-driven writes always run under the package system actor: a
    // caller-supplied actor is ignored, never trusted for audit attribution.
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const rawBody = Buffer.isBuffer(params?.rawBody) ? params.rawBody : String(params?.rawBody ?? '');
    if (Buffer.byteLength(rawBody) > PAYMENT_MAX_BODY_BYTES) {
      throw new AppError('Webhook body exceeds the bound', { code: 'PAYMENT_BODY_TOO_LARGE', status: 413 });
    }
    const headers = params?.headers && typeof params.headers === 'object' && !Array.isArray(params.headers)
      ? params.headers : {};
    const actor = SYSTEM();

    // Resolve + verify first. A failure never echoes the payload, the
    // signature or the secret, and never writes anything.
    let secret;
    try {
      secret = await resolveSecret(connection.secretRef, { spaceId, purpose: PAYMENT_SECRET_PURPOSE_INBOUND });
    } catch {
      throw new AppError('Payment secret is unavailable', { code: 'PAYMENT_SECRET_UNAVAILABLE', status: 500 });
    }
    if (typeof secret !== 'string' || secret === '') {
      throw new AppError('Payment secret is unavailable', { code: 'PAYMENT_SECRET_UNAVAILABLE', status: 500 });
    }
    let verified;
    try {
      verified = await withTimeout(
        Promise.resolve(adapter.verifyInbound({ rawBody, headers, secret, config: adapter.config })),
        verifyTimeoutMs,
        `payment adapter "${adapter.name}" verifyInbound`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      // A verification timeout is a retryable provider-side stall, never a
      // bad signature: reporting 401 would tell the provider to drop a
      // delivery that was never recorded. The 503 keeps the redelivery coming.
      if (normalized.code === 'PROVIDER_TIMEOUT') {
        throw new AppError('Payment event verification timed out: retry the delivery', {
          code: 'PAYMENT_VERIFY_UNAVAILABLE', status: 503,
        });
      }
      throw new AppError('Payment event verification failed: invalid signature', {
        code: 'PAYMENT_SIGNATURE_INVALID', status: 401,
      });
    }
    if (!verified || verified.ok !== true) {
      throw new AppError('Payment event verification failed: invalid signature', { code: 'PAYMENT_SIGNATURE_INVALID', status: 401 });
    }
    // Awaited like verifyInbound and createPayment: the adapter contract
    // allows an async normalizeInbound, and an async rejection maps to the
    // same 422 as a sync throw. Stripe sends one event per delivery, never
    // a batch — a list-shaped normalization is refused, never mapped.
    let normalized;
    try {
      normalized = await Promise.resolve(adapter.normalizeInbound(verified.event));
    } catch {
      throw new AppError('Payment event is not well-formed', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
    }
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new AppError('Payment event is not well-formed', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
    }
    // Re-read the connection AFTER the verification/normalization awaits:
    // a suspend racing this in-flight delivery quarantines below on the
    // fresh status, never applies on the binding read before the awaits.
    // The single state path re-reads it once more inside the move itself,
    // so a suspend landing between the branch and the write quarantines
    // instead of finalizing.
    const live = requireConnection(spaceId, connectionKey);
    const service = events();
    const requestService = requests();
    const stores = { requests: requestService, connections: connections(), database };
    const now = nowIso();
    const payloadFingerprint = fingerprintPayload(rawBody);
    const event = normalized;
    const providerEventId = typeof event?.providerEventId === 'string' && event.providerEventId !== ''
      && event.providerEventId.length <= 256 ? event.providerEventId : null;
    if (!providerEventId) {
      throw new AppError('Payment event is not well-formed', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
    }
    const paymentRef = typeof event?.paymentRef === 'string' && event.paymentRef !== ''
      && event.paymentRef.length <= 256 ? event.paymentRef : '';
    const eventType = typeof event?.eventType === 'string' && event.eventType !== ''
      && event.eventType.length <= 128 ? event.eventType : '';
    if (paymentRef === '' || eventType === '') {
      throw new AppError('Payment event is not well-formed', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
    }
    const item = {
      providerEventId,
      paymentRef,
      eventType,
      occurredAt: isCanonicalInstant(event?.occurredAt) ? event.occurredAt : now,
      sourceKey: boundedKey('pay-evt', spaceId, live.sourceKey, providerEventId),
    };
    return storeOne(item);

    /**
     * Insert one event row. A concurrent delivery of the same event that won
     * the insert resolves against the committed row instead of surfacing a
     * raw unique violation — the same contract as the pre-read branch above
     * (MEM_ACC_REUSE: the channels inbox proves the same shape).
     */
    async function insertEvent(fields) {
      try {
        const row = await service.createManaged(fields, { actor });
        return { row, raced: false };
      } catch (error) {
        const raced = service.listWhere({ sourceKey: fields.sourceKey })[0];
        if (raced) {
          if (raced.payloadFingerprint !== payloadFingerprint) {
            throw new AppError('Provider event id was already recorded with a different payload', {
              code: 'PAYMENT_EVENT_ID_CONFLICT', status: 409, details: { providerEventId: fields.providerEventId },
            });
          }
          return { row: raced, raced: true };
        }
        throw error;
      }
    }

    /**
     * Record the event against an already-terminal request: an agreeing
     * outcome resolves without moving the request, a contradicting one
     * quarantines, and the stored outcome always wins. With `stored`, the
     * existing event row is moved instead of inserting a new one — the
     * resume path after reactivation.
     */
    async function storeTerminalEvent(terminalRequest, item, outcome, stored = null) {
      // Chained like every payment write: on one connection an event row
      // written while another flow's move transaction is open would join
      // it and die with its rollback.
      return withPaymentWrite(async () => {
        const agrees = (outcome === 'pay' && terminalRequest.status === 'paid')
          || (outcome === 'fail' && terminalRequest.status === 'failed');
        const patch = {
          processed: true, effect: agrees ? 'applied' : 'quarantined',
          effectReason: agrees
            ? `request already ${terminalRequest.status}: no state change`
            : `request already ${terminalRequest.status}: contradicting provider event held as evidence`,
        };
        if (stored) {
          const updated = await service.applyManaged(stored.id, patch, { actor });
          return { duplicate: true, alreadyFinal: true, eventId: updated.id, effect: updated.effect };
        }
        const inserted = await insertEvent({
          sourceKey: item.sourceKey, spaceId, connectionKey: live.sourceKey,
          providerEventId: item.providerEventId, paymentRequestId: terminalRequest.id,
          eventType: item.eventType, payloadFingerprint,
          occurredAt: item.occurredAt, receivedAt: now,
          ...patch,
        });
        return { duplicate: true, alreadyFinal: true, eventId: inserted.row.id, effect: inserted.row.effect };
      });
    }

    /**
     * Resume a delivery quarantined only because its connection was not
     * active: the binding is active again, so the same Stripe retry bytes
     * are re-evaluated instead of replaying the old quarantine forever.
     * The request lookup stays scoped to the webhook connection, so a
     * sibling binding still cannot finalize another connection's checkout.
     */
    async function resumeOne(stored, item) {
      const request = requestService.listWhere({
        spaceId, connectionKey: live.sourceKey, providerRef: item.paymentRef,
      })[0] ?? null;
      if (!request || !STRIPE_FINAL_TYPES.includes(item.eventType)) {
        return { duplicate: true, eventId: stored.id, effect: stored.effect };
      }
      const outcome = item.eventType === 'checkout.session.completed' ? 'pay' : 'fail';
      if (REQUEST_TERMINAL.includes(request.status)) {
        return storeTerminalEvent(request, item, outcome, stored);
      }
      let finalized;
      try {
        finalized = await advancePaymentRequest(stores, request.id, {
          event: outcome,
          patch: outcome === 'pay'
            ? { paidAt: now, statusReason: `provider webhook ${item.providerEventId}: checkout completed` }
            : { statusReason: `provider webhook ${item.providerEventId}: ${item.eventType}` },
          actor,
          requireActiveConnection: true,
          // The resumed event row commits with the move: a concurrent
          // loser's rollback can never swallow it. applyManaged validates
          // every patched field required-style, so the reason is a real
          // sentence, never blank.
          write: () => service.applyManaged(stored.id, {
            processed: true, effect: 'applied',
            effectReason: `resumed after reactivation: provider webhook ${item.providerEventId} applied`,
          }, { actor }),
        });
      } catch (error) {
        // Re-suspended between reactivation and this write: the stored
        // quarantine evidence stands, and the request is untouched.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_CONNECTION_NOT_ACTIVE') {
          return { duplicate: true, eventId: stored.id, effect: stored.effect };
        }
        // A concurrent delivery finalized the request first: the redelivery
        // follows the terminal contract instead of erroring the provider.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_TRANSITION_INVALID') {
          const current = await requestService.get(request.id);
          if (current && REQUEST_TERMINAL.includes(current.status)) {
            return storeTerminalEvent(current, item, outcome, stored);
          }
        }
        throw error;
      }
      const updated = finalized.wrote;
      return { duplicate: true, eventId: updated.id, effect: updated.effect, status: finalized.request.status, resumed: true };
    }

    /**
     * Hold one delivery as inactive-connection quarantine evidence. Used by
     * the pre-branch below and by a finalize that lost its binding between
     * the branch and the write.
     */
    async function quarantineInactive(item, requestId) {
      // Chained like every payment write (see storeTerminalEvent).
      return withPaymentWrite(async () => {
        const stored = await insertEvent({
          sourceKey: item.sourceKey, spaceId, connectionKey: live.sourceKey,
          providerEventId: item.providerEventId,
          paymentRequestId: requestId ?? '',
          eventType: item.eventType, payloadFingerprint,
          occurredAt: item.occurredAt, receivedAt: now,
          processed: true, effect: 'quarantined',
          effectReason: `${QUARANTINE_INACTIVE_PREFIX}${live.status}: verify the binding before applying provider state`,
        });
        if (stored.raced) return { duplicate: true, eventId: stored.row.id, effect: stored.row.effect };
        const row = stored.row;
        return { duplicate: false, quarantined: true, eventId: row.id, effect: row.effect };
      });
    }

    async function storeOne(item) {
      const already = service.listWhere({ sourceKey: item.sourceKey })[0];
      if (already) {
        if (already.payloadFingerprint !== payloadFingerprint) {
          throw new AppError('Provider event id was already recorded with a different payload', {
            code: 'PAYMENT_EVENT_ID_CONFLICT', status: 409, details: { providerEventId: item.providerEventId },
          });
        }
        if (already.effect === 'quarantined'
          && typeof already.effectReason === 'string'
          && already.effectReason.startsWith(QUARANTINE_INACTIVE_PREFIX)
          && live.status === 'active') {
          return resumeOne(already, item);
        }
        return { duplicate: true, eventId: already.id, effect: already.effect };
      }

      // The request must belong to the webhook connection: a checkout minted
      // under one connection is never finalized through a sibling one, so a
      // suspended or revoked binding cannot be bypassed cross-connection.
      const request = requestService.listWhere({
        spaceId, connectionKey: live.sourceKey, providerRef: item.paymentRef,
      })[0] ?? null;
      // Inactive connections keep no inbound state silently: the delivery is
      // preserved as quarantine evidence, and nothing is applied.
      if (live.status !== 'active') {
        return quarantineInactive(item, request?.id ?? '');
      }
      if (!request) {
        const sibling = requestService.listWhere({ spaceId, providerRef: item.paymentRef })[0] ?? null;
        // Chained like every payment write (see storeTerminalEvent).
        const stored = await withPaymentWrite(() => insertEvent({
          sourceKey: item.sourceKey, spaceId, connectionKey: live.sourceKey,
          providerEventId: item.providerEventId, paymentRequestId: '',
          eventType: item.eventType, payloadFingerprint,
          occurredAt: item.occurredAt, receivedAt: now,
          processed: true, effect: 'quarantined',
          effectReason: sibling
            ? 'provider reference belongs to another connection: verify the binding before applying provider state'
            : 'unknown checkout: no payment request carries this provider reference',
        }));
        if (stored.raced) return { duplicate: true, eventId: stored.row.id, effect: stored.row.effect };
        const row = stored.row;
        return { duplicate: false, quarantined: true, eventId: row.id, effect: row.effect };
      }
      if (!STRIPE_FINAL_TYPES.includes(item.eventType)) {
        // Chained like every payment write (see storeTerminalEvent).
        const stored = await withPaymentWrite(() => insertEvent({
          sourceKey: item.sourceKey, spaceId, connectionKey: live.sourceKey,
          providerEventId: item.providerEventId, paymentRequestId: request.id,
          eventType: item.eventType, payloadFingerprint,
          occurredAt: item.occurredAt, receivedAt: now,
          processed: true, effect: 'quarantined',
          effectReason: `event type is not a payment outcome: ${item.eventType}`,
        }));
        if (stored.raced) return { duplicate: true, eventId: stored.row.id, effect: stored.row.effect };
        const row = stored.row;
        return { duplicate: false, quarantined: true, eventId: row.id, effect: row.effect };
      }
      const outcome = item.eventType === 'checkout.session.completed' ? 'pay' : 'fail';
      if (REQUEST_TERMINAL.includes(request.status)) {
        return storeTerminalEvent(request, item, outcome);
      }
      let finalized;
      try {
        finalized = await advancePaymentRequest(stores, request.id, {
          event: outcome,
          patch: outcome === 'pay'
            ? { paidAt: now, statusReason: `provider webhook ${item.providerEventId}: checkout completed` }
            : { statusReason: `provider webhook ${item.providerEventId}: ${item.eventType}` },
          actor,
          requireActiveConnection: true,
          // The applied event row commits with the move: a concurrent
          // loser's rollback can never swallow the winner's row.
          write: () => insertEvent({
            sourceKey: item.sourceKey, spaceId, connectionKey: live.sourceKey,
            providerEventId: item.providerEventId, paymentRequestId: request.id,
            eventType: item.eventType, payloadFingerprint,
            occurredAt: item.occurredAt, receivedAt: now,
            processed: true, effect: 'applied',
            effectReason: '',
          }),
        });
      } catch (error) {
        // A suspend that landed between the branch and the write: the
        // single path saw the fresh inactive binding, so this delivery
        // quarantines instead of finalizing on a dead binding.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_CONNECTION_NOT_ACTIVE') {
          return quarantineInactive(item, request.id);
        }
        // A concurrent delivery finalized the request first: the redelivery
        // follows the terminal contract instead of erroring the provider.
        if (error && typeof error === 'object' && error.code === 'PAYMENT_TRANSITION_INVALID') {
          const current = await requestService.get(request.id);
          if (current && REQUEST_TERMINAL.includes(current.status)) {
            return storeTerminalEvent(current, item, outcome);
          }
        }
        throw error;
      }
      const stored = finalized.wrote;
      if (stored.raced) return { duplicate: true, eventId: stored.row.id, effect: stored.row.effect };
      const row = stored.row;
      return { duplicate: false, eventId: row.id, effect: row.effect, status: finalized.request.status };
    }
  }

  /**
   * The payment status the customer card and the sales pipeline render:
   * function-free data, never a secret, never a handle. A request from
   * another space is not found (404), never forbidden (403).
   */
  function getPaymentStatus(spaceId, requestId) {
    const space = assertSpaceId(spaceId);
    if (typeof requestId !== 'string' || requestId === '') return null;
    let row = null;
    try {
      row = requests().get(requestId);
    } catch {
      row = requests().listWhere({ spaceId: space, sourceKey: requestId })[0] ?? null;
    }
    if (!row || row.spaceId !== space) return null;
    return Object.freeze({
      id: row.id, status: row.status, amount: row.amount, currency: row.currency,
      quoteId: row.quoteId, offerId: row.offerId,
      providerRef: row.providerRef, providerUrl: row.providerUrl,
      paidAt: row.paidAt, statusReason: row.statusReason,
    });
  }

  /**
   * Every request of one space, newest intent first (insertion order). An
   * unknown status filter is refused here — where every caller lands, not
   * only the composed wrapper — never answered with a silent empty list.
   */
  function listPayments(spaceId, { status = null } = {}) {
    const space = assertSpaceId(spaceId);
    if (status !== null && status !== undefined && !REQUEST_STATUSES.includes(status)) {
      throw new ValidationError(`payment status filter must be one of: ${REQUEST_STATUSES.join(', ')}`, { field: 'status' });
    }
    const rows = requests().listWhere({ spaceId: space });
    const filtered = status === null ? rows : rows.filter((row) => row.status === status);
    return Object.freeze(filtered.map((row) => getPaymentStatus(space, row.id)));
  }

  return {
    registerPaymentConnection,
    requestPayment,
    ingestPaymentEvent,
    getPaymentStatus,
    listPayments,
    getConnection,
  };
}
