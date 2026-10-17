// @ts-check

import {
  AppError,
  SENSITIVE_KEY,
  ValidationError,
  canonicalJobPayload,
  createDurableJobStore,
  normalizeError,
  nowIso,
  trustedSystemActor,
  withTimeout,
} from '../../core/index.js';
import { assertConnectionInput, assertSpaceId, boundedKey, channelSendIdempotencyKey } from './connection.js';
import { fingerprintPayload } from './crypto.js';
import { transitionInbox } from './transitions.js';

/**
 * Channel operations (backlog:e5532d1c9146).
 *
 * The application-scoped entry points a deployment (and the kit) drives:
 * register a connection, ingest a verified webhook, queue a send through
 * the durable-jobs outbox, and work the dead-letter queue. Reads are plain
 * functions over the same module services.
 *
 * What is deliberately NOT here: the per-space HTTP route (the pilot owns
 * it), secret custody (the deployment injects `resolveSecret`), and
 * reconciliation (follow-up — redelivery resumes unprocessed rows).
 */

export const CHANNEL_SEND_KIND = 'channel-send';
export const CHANNEL_SEND_HANDLER = 'channel-send';
// Worker-control codes the adapter layer must never speak: thrown by a
// buggy or hostile adapter they are refusals, never worker instructions.
const WORKER_CONTROL_CODES = new Set(['JOB_HANDLER_FAILED', 'JOB_HANDLER_TEMPORARY_UNAVAILABLE']);
export const CHANNEL_SEND_CONTRACT = 1;
export const CHANNEL_SEND_VERSION = 1;
export const CHANNEL_SEND_MAX_ATTEMPTS = 5;
export const CHANNEL_SEND_TIMEOUT_MS = 5000;
export const CHANNEL_VERIFY_TIMEOUT_MS = 2000;
export const CHANNEL_MAX_BODY_BYTES = 1024 * 1024;
export const CHANNEL_SECRET_PURPOSE_INBOUND = 'channel-inbound';
export const CHANNEL_SECRET_PURPOSE_OUTBOUND = 'channel-outbound';

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    connection: config.connectionModule ?? 'channel-connection',
    inbox: config.inboxModule ?? 'channel-inbox-event',
    letter: config.letterModule ?? 'channel-dead-letter',
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

function isJsonSafe(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 500 && value.every((entry) => isJsonSafe(entry, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  // Same hostile-key fence as the durable-jobs payload controls (MEM_ACC_REUSE):
  // __proto__/constructor/prototype never pass, even before the secret scan.
  return Object.keys(value).every((key) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
    && key.length <= 128 && isJsonSafe(value[key], depth + 1));
}

// Fail-fast against the kernel denylist itself (MEM_ACC_REUSE): the same
// SENSITIVE_KEY the durable-jobs layer enforces, so a secret-shaped key is
// refused here with the channel code instead of surfacing as a generic
// DURABLE_JOB_PAYLOAD_INVALID from the enqueue.
const UNSAFE_MESSAGE_KEY = SENSITIVE_KEY;

function malformedMessage(reason) {
  throw new AppError(`Channel message is not well-formed: ${reason}`, {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

function assertOutboundMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    malformedMessage('message must be a plain object');
  }
  if (!isJsonSafe(message)) {
    malformedMessage('message must be plain JSON-safe data');
  }
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) > 32 * 1024) {
    malformedMessage('message exceeds the 32 KiB outbound bound');
  }
  const bad = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      for (const key of Object.keys(value)) {
        if (UNSAFE_MESSAGE_KEY.test(key)) bad.push(key);
        visit(value[key]);
      }
    }
  };
  visit(message);
  if (bad.length > 0) {
    malformedMessage(`message carries a secret-shaped key ("${bad[0]}"): resolve secrets at send time, never place them in the message`);
  }
  // Reuse the kernel payload controls as the final fence (MEM_ACC_REUSE): any
  // hostile shape the local scan does not model (symbols, exotic prototypes,
  // array bounds) still refuses here with the channel code, never as a raw
  // DURABLE_JOB_PAYLOAD_INVALID from the enqueue.
  try {
    canonicalJobPayload(message);
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DURABLE_JOB_PAYLOAD_INVALID') {
      malformedMessage('message refused by the outbox payload controls');
    }
    throw error;
  }
  return message;
}

function requireUser(actor) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError('Channel sends and connection changes require a human user actor', {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
  return actor;
}

function actorId(actor) {
  const id = /** @type {any} */ (actor)?.id;
  return typeof id === 'string' && id !== '' ? id : 'unknown';
}

const SYSTEM = () => trustedSystemActor('channel package internal write');

/**
 * @param {{
 *   database: any, modules: any, registries: any,
 *   resolveSecret: (reference: string, context: {spaceId: string, purpose: string}) => Promise<string>,
 *   tenantId: string,
 *   config?: Record<string, any>,
 * }} deps `resolveSecret` is the deployment's custody edge (platform
 * runtime-vault in production, a fixture map in tests): the reference is
 * stored, the value is resolved at call time and never persisted.
 */
export function createChannelOperations(deps) {
  const { database, modules, registries } = deps;
  if (!database || !modules || !registries || typeof registries.getAdapter !== 'function') {
    throw new ValidationError('createChannelOperations needs database, modules and channel registries — compose the package rather than wiring it by hand');
  }
  // Custody is deployment-owned and optional at composition: without it every
  // secret resolution refuses, so sends and inbound verification cannot run
  // until the deployment wires its vault. Validation and conformance compose
  // empty on purpose.
  const resolveSecret = typeof deps.resolveSecret === 'function' ? deps.resolveSecret : async () => {
    throw new AppError('Channel secret custody is not wired: compose the package with resolveSecret', {
      code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500,
    });
  };
  const tenantId = deps.tenantId === undefined ? null : deps.tenantId;
  if (tenantId !== null && (typeof tenantId !== 'string' || tenantId.trim() === '' || tenantId.length > 256)) {
    throw new ValidationError('channel tenant id must be bounded text for the jobs-table namespace');
  }
  const names = resolvedNames(deps.config ?? {});
  const sendTimeoutMs = Number.isSafeInteger(deps.config?.sendTimeoutMs) ? deps.config.sendTimeoutMs : CHANNEL_SEND_TIMEOUT_MS;
  const verifyTimeoutMs = Number.isSafeInteger(deps.config?.verifyTimeoutMs) ? deps.config.verifyTimeoutMs : CHANNEL_VERIFY_TIMEOUT_MS;
  const maxSendAttempts = Number.isSafeInteger(deps.config?.maxSendAttempts)
    && deps.config.maxSendAttempts >= 1 && deps.config.maxSendAttempts <= 100
    ? deps.config.maxSendAttempts : CHANNEL_SEND_MAX_ATTEMPTS;
  let jobStore = null;
  const jobs = () => {
    if (!tenantId) {
      throw new AppError('Channel sends need the bound tenant id: compose the package with tenantId', {
        code: 'CHANNEL_TENANT_UNBOUND', status: 500,
      });
    }
    if (!jobStore) jobStore = createDurableJobStore({ storage: database.storage, tenantId });
    return jobStore;
  };

  const connections = () => trusted(modules, names.connection, 'CHANNEL_STORAGE_INVALID');
  const inbox = () => trusted(modules, names.inbox, 'CHANNEL_STORAGE_INVALID');
  const letters = () => trusted(modules, names.letter, 'CHANNEL_STORAGE_INVALID');

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
      throw new AppError('Unknown channel connection', { code: 'CHANNEL_CONNECTION_UNKNOWN', status: 404 });
    }
    return row;
  }

  function requireActiveConnection(spaceId, connectionKey) {
    const row = requireConnection(spaceId, connectionKey);
    if (row.status !== 'active') {
      throw new AppError(`Channel connection is ${row.status}`, { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', status: 409 });
    }
    return row;
  }

  /**
   * Register one connection. The DB-unique source key makes a repeated
   * registration resolve identically; the same key with different bindings
   * is a conflict, not an adoption.
   */
  async function registerChannelConnection(params) {
    const actor = requireUser(params?.actor);
    const normalized = assertConnectionInput(params, registries);
    const service = connections();
    const resolveExisting = (existing) => {
      if (existing.adapter === normalized.adapter && existing.adapterVersion === normalized.adapterVersion
        && existing.account === normalized.account && existing.secretRef === normalized.secretRef) {
        return { duplicate: true, connection: existing };
      }
      throw new AppError('A connection already binds this account differently — revoke it before rebinding', {
        code: 'CHANNEL_CONNECTION_CONFLICT', status: 409,
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
        channel: normalized.channel,
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
   * Ingest one provider webhook delivery for one space and connection.
   * Verification sees the exact bytes the provider signed, before any
   * mutation; the inbox row is DB-unique per (space, connection, provider
   * event id), so a replay is idempotent; a redelivery carrying a
   * different payload under the same id is a provider contract violation
   * (409), not a duplicate; an unknown subject is quarantined as evidence.
   * The identity is per connection on purpose: two accounts of one space
   * on the same adapter each own their events, even when the provider
   * reuses an event id across the two accounts.
   */
  async function ingestChannelEvent(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireConnection(spaceId, connectionKey);
    // Provider-driven writes always run under the package system actor: a
    // caller-supplied actor is ignored, never trusted for audit attribution.
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const rawBody = Buffer.isBuffer(params?.rawBody) ? params.rawBody : String(params?.rawBody ?? '');
    if (Buffer.byteLength(rawBody) > CHANNEL_MAX_BODY_BYTES) {
      throw new AppError('Webhook body exceeds the bound', { code: 'CHANNEL_BODY_TOO_LARGE', status: 413 });
    }
    const headers = params?.headers && typeof params.headers === 'object' && !Array.isArray(params.headers)
      ? params.headers : {};
    const actor = SYSTEM();

    // Resolve + verify first. A failure never echoes the payload, the
    // signature or the secret, and never writes anything.
    let secret;
    try {
      secret = await resolveSecret(connection.secretRef, { spaceId, purpose: CHANNEL_SECRET_PURPOSE_INBOUND });
    } catch {
      throw new AppError('Channel secret is unavailable', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
    }
    if (typeof secret !== 'string' || secret === '') {
      throw new AppError('Channel secret is unavailable', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
    }
    let verified;
    try {
      verified = await withTimeout(
        Promise.resolve(adapter.verifyInbound({ rawBody, headers, secret, config: adapter.config })),
        verifyTimeoutMs,
        `channel adapter "${adapter.name}" verifyInbound`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      // A verification timeout is a retryable provider-side stall, never a
      // bad signature: reporting 401 would tell the provider to drop a
      // delivery that was never recorded. The 503 keeps the redelivery coming.
      if (normalized.code === 'PROVIDER_TIMEOUT') {
        throw new AppError('Channel event verification timed out: retry the delivery', {
          code: 'CHANNEL_VERIFY_UNAVAILABLE', status: 503,
        });
      }
      throw new AppError('Channel event verification failed: invalid signature', {
        code: 'CHANNEL_SIGNATURE_INVALID', status: 401,
      });
    }
    if (!verified || verified.ok !== true) {
      throw new AppError('Channel event verification failed: invalid signature', { code: 'CHANNEL_SIGNATURE_INVALID', status: 401 });
    }
    let event;
    try {
      event = adapter.normalizeInbound(verified.event);
    } catch {
      throw new AppError('Channel event is not well-formed', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
    }
    const providerEventId = typeof event?.providerEventId === 'string' && event.providerEventId !== ''
      && event.providerEventId.length <= 256 ? event.providerEventId : null;
    if (!providerEventId) {
      throw new AppError('Channel event is not well-formed', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
    }
    const subject = typeof event?.subject === 'string' && event.subject !== '' && event.subject.length <= 256
      ? event.subject : '';
    const sequence = Number.isSafeInteger(event?.sequence) ? event.sequence : null;
    const occurredAt = isCanonicalInstant(event?.occurredAt) ? event.occurredAt : null;
    const payloadFingerprint = fingerprintPayload(rawBody);
    const sourceKey = boundedKey('ch-in', spaceId, connection.sourceKey, providerEventId);
    const service = inbox();
    const now = nowIso();

    const decideEffect = (siblingRows) => {
      if (subject === '') {
        return { effect: 'quarantined', effectReason: 'unknown subject: no local mapping for this provider subject' };
      }
      if (sequence !== null) {
        const newer = siblingRows.filter((row) => row.subject === subject
          && row.effect === 'applied' && Number.isSafeInteger(row.sequence) && row.sequence > sequence);
        if (newer.length > 0) {
          return { effect: 'ignored', effectReason: `out-of-order delivery: newer sequence already applied for this subject` };
        }
      }
      return { effect: 'applied', effectReason: '' };
    };

    const already = service.listWhere({ sourceKey })[0];
    if (already) {
      if (already.payloadFingerprint !== payloadFingerprint) {
        throw new AppError('Provider event id was already recorded with a different payload', {
          code: 'CHANNEL_EVENT_ID_CONFLICT', status: 409, details: { providerEventId },
        });
      }
      if (already.processed === true) {
        return { duplicate: true, eventId: already.id, effect: already.effect };
      }
      // A row whose processing never completed is evidence of an event that
      // has not had its effect yet: a redelivery resumes it — but only while
      // its connection is active. Against a pending, suspended or revoked
      // binding the row stays quarantined: provider state is never applied
      // to a binding that was never activated, or to a revoked one.
      if (connection.status !== 'active') {
        return { duplicate: true, quarantined: true, eventId: already.id, effect: already.effect };
      }
      const decision = decideEffect(service.listWhere({ spaceId, connectionKey: connection.sourceKey }));
      const event = decision.effect === 'applied' ? 'apply' : decision.effect === 'ignored' ? 'discard' : 'quarantine';
      const resumed = await transitionInbox(service, already.id, {
        event,
        patch: { effectReason: decision.effectReason === '' ? 'redelivery resumed the received row' : decision.effectReason },
        actor,
      });
      return { duplicate: false, resumed: true, eventId: resumed.id, effect: resumed.effect };
    }

    const baseRow = {
      sourceKey, spaceId, connectionKey: connection.sourceKey,
      adapter: adapter.name, adapterVersion: adapter.version,
      providerEventId, subject, payloadFingerprint,
      sequence, occurredAt, receivedAt: now,
    };
    // Inactive connections keep no inbound state silently: the delivery is
    // preserved as quarantine evidence, and nothing is applied.
    if (connection.status !== 'active') {
      const row = await service.createManaged({
        ...baseRow,
        processed: false,
        effect: 'quarantined',
        effectReason: `connection is ${connection.status}: verify the binding before applying provider state`,
      }, { actor });
      return { duplicate: false, quarantined: true, eventId: row.id, effect: row.effect };
    }

    const decision = decideEffect(service.listWhere({ spaceId, connectionKey: connection.sourceKey }));
    try {
      const row = await service.createManaged({
        ...baseRow,
        processed: true,
        effect: decision.effect,
        effectReason: decision.effectReason,
      }, { actor });
      return { duplicate: false, eventId: row.id, effect: row.effect };
    } catch (error) {
      // A concurrent delivery of the same event won the insert: resolve
      // against the committed row instead of surfacing a raw violation —
      // the same contract as the pre-read branch above, so a conflicting
      // payload is CHANNEL_EVENT_ID_CONFLICT 409 on every path.
      const raced = service.listWhere({ sourceKey })[0];
      if (raced) {
        if (raced.payloadFingerprint === payloadFingerprint) {
          return { duplicate: true, eventId: raced.id, effect: raced.effect };
        }
        throw new AppError('Provider event id was already recorded with a different payload', {
          code: 'CHANNEL_EVENT_ID_CONFLICT', status: 409, details: { providerEventId },
        });
      }
      throw error;
    }
  }

  /**
   * Queue one outbound message through the durable-jobs outbox. The payload
   * carries routing and content only — the handler resolves the secret at
   * execution time, so no secret material ever rests in the jobs table.
   */
  async function queueChannelSend(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    let message;
    try {
      message = adapter.normalizeOutbound(params?.message);
    } catch {
      throw new AppError('Channel message is not well-formed', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
    }
    assertOutboundMessage(message);
    const messageKey = typeof params?.messageKey === 'string' && params.messageKey !== ''
      ? params.messageKey : null;
    const keyInput = messageKey ?? fingerprintPayload(JSON.stringify(message));
    const idempotencyKey = channelSendIdempotencyKey({ spaceId, connectionKey: connection.sourceKey, messageKey: keyInput });
    let job;
    try {
      job = await jobs().enqueue({
        kind: CHANNEL_SEND_KIND,
        handler: { name: CHANNEL_SEND_HANDLER, contract: CHANNEL_SEND_CONTRACT, version: CHANNEL_SEND_VERSION },
        payload: { spaceId, connectionKey: connection.sourceKey, idempotencyKey, message },
        idempotencyRoot: idempotencyKey,
        outcomeReference: idempotencyKey,
        recoveryPolicy: 'reconcilable_at_least_once',
        maxAttempts: maxSendAttempts,
      }, { actor });
    } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DURABLE_JOB_PAYLOAD_INVALID') {
        throw new AppError('Channel message is not well-formed: message refused by the outbox payload controls', {
          code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
        });
      }
      throw error;
    }
    return { jobId: job.id, idempotencyKey, attempts: job.attempt, state: job.state };
  }

  /** Record one terminal send failure. Never the raw payload, never a secret. */
  async function recordDeadLetter({ spaceId, connectionKey, idempotencyKey, jobId, errorCode, payloadFingerprint, attempts }) {
    const now = nowIso();
    const service = letters();
    const sourceKey = boundedKey('ch-dl', idempotencyKey);
    const existing = service.listWhere({ sourceKey })[0];
    if (existing) {
      return existing;
    }
    return service.createManaged({
      sourceKey, spaceId, connectionKey, idempotencyKey, jobId,
      phase: 'send', errorCode, payloadFingerprint, attempts,
      firstFailedAt: now, lastFailedAt: now,
      state: 'open', stateReason: 'bounded attempts exhausted',
    }, { actor: SYSTEM() });
  }

  /**
   * Register the `channel-send` consumer on a durable-job handler registry.
   * The deployment starts the worker; the kit drives one attempt at a time.
   *
   * Retry discipline: adapter transient failures (`CHANNEL_SEND_TRANSIENT`,
   * provider timeouts, momentarily unavailable secrets) throw
   * JOB_HANDLER_TEMPORARY_UNAVAILABLE and ride the worker backoff while
   * attempts remain. Anything else is terminal: the real code lands in the
   * dead-letter row first, then the job settles terminal.
   */
  function registerChannelSendHandlers(registry) {
    registry.register({
      kind: CHANNEL_SEND_KIND,
      name: CHANNEL_SEND_HANDLER,
      version: CHANNEL_SEND_VERSION,
      async execute({ job, payload }) {
        const body = payload && typeof payload === 'object' ? payload : {};
        const spaceId = typeof body.spaceId === 'string' ? body.spaceId : '';
        const connectionKey = typeof body.connectionKey === 'string' ? body.connectionKey : '';
        const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
        const message = body.message && typeof body.message === 'object' ? body.message : null;
        const failTerminal = async (code) => {
          const letter = await recordDeadLetter({
            spaceId, connectionKey, idempotencyKey,
            jobId: job.id, errorCode: code,
            payloadFingerprint: fingerprintPayload(JSON.stringify(body)),
            attempts: job.attempt,
          });
          throw new AppError(`Channel send failed terminally (${code}); see dead letter ${letter.id}`, {
            code: 'JOB_HANDLER_FAILED', status: 500,
          });
        };
        const failRetryable = (code) => {
          throw new AppError(`Channel send temporarily unavailable (${code})`, {
            code: 'JOB_HANDLER_TEMPORARY_UNAVAILABLE', status: 503,
          });
        };
        let connection = null;
        try {
          connection = getConnection(spaceId, connectionKey);
        } catch {
          connection = null;
        }
        if (!connection) return failTerminal('CHANNEL_CONNECTION_UNKNOWN');
        if (connection.status !== 'active' || !message || idempotencyKey === '') {
          return failTerminal(connection.status !== 'active' ? 'CHANNEL_CONNECTION_NOT_ACTIVE' : 'CHANNEL_MESSAGE_MALFORMED');
        }
        let adapter;
        try {
          ({ definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion));
        } catch {
          return failTerminal('CHANNEL_ADAPTER_UNKNOWN');
        }
        let secret;
        try {
          secret = await resolveSecret(connection.secretRef, { spaceId, purpose: CHANNEL_SECRET_PURPOSE_OUTBOUND });
        } catch {
          secret = null;
        }
        // The worker claims an execution only while the pre-claim attempt is
        // below maxAttempts, so the handler sees a 1-based execution number:
        // retry while job.attempt < maxAttempts, letter on the last one.
        if (typeof secret !== 'string' || secret === '') {
          if (job.attempt < job.maxAttempts) failRetryable('CHANNEL_SECRET_UNAVAILABLE');
          return failTerminal('CHANNEL_SECRET_UNAVAILABLE');
        }
        try {
          const sent = await withTimeout(
            Promise.resolve(adapter.sendOutbound({ message, secret, idempotencyKey, config: adapter.config })),
            sendTimeoutMs,
            `channel adapter "${adapter.name}" sendOutbound`,
          );
          const providerMessageId = sent && typeof sent.providerMessageId === 'string' ? sent.providerMessageId : '';
          if (providerMessageId === '' || providerMessageId.length > 256) {
            return failTerminal('CHANNEL_SEND_UNPROVEN');
          }
          return { outcomeReference: idempotencyKey };
        } catch (error) {
          const normalized = normalizeError(error);
          const transient = normalized.code === 'CHANNEL_SEND_TRANSIENT' || normalized.code === 'PROVIDER_TIMEOUT';
          if (transient && job.attempt < job.maxAttempts) failRetryable(normalized.code);
          const rawCode = /** @type {any} */ (error)?.code;
          // Worker-control codes are never adapter vocabulary: a buggy or
          // hostile adapter that throws one lands in the dead letter as a
          // refusal. Every adapter throw writes the dead-letter row first —
          // no bypass — and only then settles the job terminal.
          const code = transient ? normalized.code
            : (typeof rawCode === 'string' && !WORKER_CONTROL_CODES.has(rawCode)
              && /^[A-Z][A-Z0-9_]*$/.test(rawCode) ? rawCode : 'CHANNEL_SEND_REFUSED');
          return failTerminal(code);
        }
      },
    });
    return registry;
  }

  // Dead-letter requeue (human retry of an open letter) is intentionally NOT
  // here: it moves to its own follow-up voice with its own state machine, so
  // this PR keeps register / ingest / queue / dead-letter inventory only.
  // The dead-letter rows stay readable through listDeadLetters.

  function listConnections(spaceId) {
    return connections().listWhere({ spaceId: assertSpaceId(spaceId) });
  }

  function listInbox(spaceId, connectionKey = null) {
    const space = assertSpaceId(spaceId);
    const filters = connectionKey ? { spaceId: space, connectionKey } : { spaceId: space };
    return inbox().listWhere(filters);
  }

  function listDeadLetters(spaceId, state = null) {
    const space = assertSpaceId(spaceId);
    const filters = state ? { spaceId: space, state } : { spaceId: space };
    return letters().listWhere(filters);
  }

  return Object.freeze({
    tenantId,
    moduleNames: names,
    maxSendAttempts,
    getConnection,
    listConnections,
    listInbox,
    listDeadLetters,
    registerChannelConnection,
    ingestChannelEvent,
    queueChannelSend,
    registerChannelSendHandlers,
  });
}
