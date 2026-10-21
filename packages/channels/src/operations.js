// @ts-check

import {
  AppError,
  SENSITIVE_KEY,
  TRANSACTION_PROOF,
  ValidationError,
  canonicalJobPayload,
  createDurableJobStore,
  normalizeError,
  nowIso,
  proveCallerTransaction,
  trustedSystemActor,
  withTimeout,
} from '../../core/index.js';
import { assertHistoryPage, CHANNEL_HISTORY_PAGE_MAX } from './adapter.js';
import { assertConnectionInput, assertSpaceId, boundedKey, channelSendIdempotencyKey } from './connection.js';
import { fingerprintPayload } from './crypto.js';
import { advanceLetter, assertJobTransition, jobSendState, transitionInbox } from './transitions.js';

/**
 * Channel operations (backlog:e5532d1c9146).
 *
 * The application-scoped entry points a deployment (and the kit) drives:
 * register a connection, ingest a verified webhook, queue a send through
 * the durable-jobs outbox, work the dead-letter queue, and run the
 * progressive initial history import (start one bounded page at a time,
 * read its progress) for adapters that declare readable past. The reply
 * flow (BO-F1-07) proposes a human answer on the preferred channel —
 * drafted by the caller or the workspace AI — gates it on the space's
 * `send-without-approval` switch, sends the approved bytes through the
 * outbox, and reads the reply lifecycle back. Reads are
 * plain functions over the same module services.
 *
 * What is deliberately NOT here: the per-space HTTP route (the pilot owns
 * it), secret custody (the deployment injects `resolveSecret`), and the
 * sender reconciliation itself (the composed `channel-sender@1`
 * capability resolves; this package only hands it the imported senders).
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
/**
 * One delivery may carry several provider items (Meta routinely batches
 * messages[] and statuses[] in one webhook): one inbox row per event, so
 * the batch is bounded and a hostile adapter cannot loop forever.
 */
export const CHANNEL_MAX_BATCH_EVENTS = 500;
/**
 * Provider timestamps beyond receive time + skew are untrustworthy (skewed
 * or forged clocks): they are kept as quarantine evidence at receive time
 * and never become the window observation nor the out-of-order sequence.
 */
export const CHANNEL_INGEST_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CHANNEL_SECRET_PURPOSE_INBOUND = 'channel-inbound';
export const CHANNEL_SECRET_PURPOSE_OUTBOUND = 'channel-outbound';
export const CHANNEL_SECRET_PURPOSE_HISTORY = 'channel-history';
/** One history page per advance call: bounded work per call, so a large past never holds a worker. */
export const CHANNEL_HISTORY_DEFAULT_PAGE = 50;
/** A history page is provider I/O plus up to a hundred row writes: slower than a webhook verify. */
export const CHANNEL_HISTORY_TIMEOUT_MS = 10000;
export const CHANNEL_IMPORT_STATES = Object.freeze(['running', 'done']);
/**
 * The backoffice reply flow (BO-F1-07, "05 Scheda cliente"): a human writes
 * an answer on the customer's preferred channel, optionally drafted by the
 * workspace LLM ("Scrivi con AI"), and the send obeys the space's
 * `send-without-approval` switch (BO-F0-06, off by default): with the switch
 * off the reply waits for a human ok as a `space-ai-proposal` row and is
 * never enqueued; the approval authorizes exactly the proposed bytes.
 *
 * Lifecycle, as the backoffice shows it: `pending-approval` (waiting for
 * the ok) -> `approved` (ok recorded, send not yet requested) -> `queued`
 * ("in consegna": the outbox job exists) -> `sent` ("consegnato": the
 * provider accepted the message and proved its id) or `failed`; a refused
 * proposal is `refused` and never sends. Provider delivered/read receipts
 * keep arriving as inbox status events on the existing path; "consegnato"
 * here is the provider's send receipt, guarded by CHANNEL_SEND_UNPROVEN.
 */
export const CHANNEL_REPLY_PERMISSION = 'send-without-approval';
export const CHANNEL_REPLY_ACTION_KIND = 'channel-reply';
export const CHANNEL_REPLY_STATES = Object.freeze([
  'pending-approval', 'approved', 'queued', 'sent', 'failed', 'refused',
]);
/** A reply fits the proposal summary that carries it under approval. */
export const CHANNEL_REPLY_TEXT_MAX = 2000;
/**
 * The effect reason import-stored applied rows carry. It is provenance for
 * humans and the marker the webhook path trusts: the same provider message
 * arrives in a different envelope on each path (push bytes vs history
 * payload), so fingerprints can never match across paths — the stored
 * normalized fields can, and only for rows this import wrote.
 */
export const CHANNEL_IMPORT_ROW_REASON = 'initial history import';
/**
 * The only failure notes the import row ever carries. An adapter throw may
 * echo secrets, tokens, or PII from the provider request, so the row keeps
 * the failure code plus one of these fixed notes — never adapter-controlled
 * text — and the progress surface exposes only codes, notes, and counts.
 */
export const CHANNEL_IMPORT_READ_FAILED_NOTE = 'provider history read failed: retry the advance';
export const CHANNEL_IMPORT_PAGE_FAILED_NOTE = 'import page failed before completion: retry the advance';
/**
 * The only technical notes an import-outcome row ever carries. An event's
 * stable identity is its (connection, providerEventId) — the inbox source
 * key — so a re-listed event whose envelope drifted (a webhook-first echo
 * later listed with its provider instant, a skewed redelivery, a second
 * sighting with conflicting sender evidence) is adopted as the same event,
 * never a 409, and the drift is annotated here. Every fragment is static
 * package text: provider-controlled values never reach the row.
 */
export const CHANNEL_IMPORT_NOTE_SUBJECT = 'subject differs from the stored row: adopted as the same event';
export const CHANNEL_IMPORT_NOTE_SEQUENCE = 'sequence differs from the stored row: adopted as the same event';
export const CHANNEL_IMPORT_NOTE_OCCURRED_AT = 'occurredAt differs from the stored row: adopted as the same event';
export const CHANNEL_IMPORT_NOTE_SENDER_CONFLICT = 'sender evidence conflicts with the earlier sighting: left for a human to confirm';
export const CHANNEL_IMPORT_NOTE_SENDER_REFUSED = 'sender resolution refused: left for a human to confirm';

/**
 * Same-process serialization for import progress commits, one FIFO chain
 * per import: two advances racing the same connection commit in order, so
 * the loser re-reads the winner's counters instead of overwriting them
 * with its stale snapshot. Cross-process writers still serialize on the
 * storage transaction below. (MEM_ACC_REUSE: the same tail pattern the
 * payments package uses for its request moves — a package imports only
 * core, so the helper lives here rather than crossing the boundary.)
 */
const importCommitChains = new Map();

/** @param {string} key @param {() => Promise<any>} critical */
function withImportCommit(key, critical) {
  const previous = importCommitChains.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  importCommitChains.set(key, tail);
  // Synchronous until here: two callers racing in the same tick still
  // order. Tails never reject, so a refused commit never wedges the chain.
  return (async () => {
    await previous;
    try {
      return await critical();
    } finally {
      if (importCommitChains.get(key) === tail) importCommitChains.delete(key);
      release();
    }
  })();
}

/**
 * The failure code an import abort stamps: the adapter's own when it names
 * one, else the normalized wrapper's, else the unavailable fallback. The
 * message is never read here — it may carry provider-controlled text.
 */
function importFailureCode(error, fallback) {
  if (error !== null && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && error.code !== '') {
    return error.code;
  }
  return normalizeError(error).code ?? fallback;
}

/**
 * Import outcome rows (`channel-import-outcome`) are the import's memory:
 * one row per (import, provider event), written once and counted by the
 * progress surface — never tallied by hand. `pending` means the inbox row
 * is stored but its sender is not resolved yet: a composition without the
 * `channel-sender@1` capability leaves it there ("reconciliation pending",
 * counted as unresolved), and a retry with the capability resolves only
 * the sender. `failed` means the event did not complete: a poisoned event
 * (one that fails deterministically, whatever the attempt) is recorded
 * failed and skipped — the page continues and the cursor advances past
 * it — while a transient failure still aborts the page with the cursor
 * unmoved, so the retry reprocesses it like a new event. Every other
 * sender value is final and the retry skips it, except a re-listed same
 * event whose sender evidence now conflicts: the fresh `unresolved`
 * verdict refines a previously final sender, routing the conflict to the
 * human confirm queue the reconciliation already keeps
 * (duplicate-candidate), never a 409.
 *
 * Refinement is one-directional with that single exception: absent →
 * anything, `failed` → anything, `pending` → a final sender, final →
 * kept — except final created/matched → `unresolved` when a later
 * sighting of the same event resolves to conflicting sender evidence.
 * Notes only accumulate static fragments: a replay never rewrites them,
 * so two advances racing one page converge instead of recounting each
 * other — and a store that just won the inbox insert always records
 * `imported`, even when a racer already wrote `duplicate`.
 */
const IMPORT_OUTCOME_FINAL_SENDERS = new Set(['created', 'matched', 'unresolved', 'none']);

/** @param {string} importKey @param {string} providerEventId */
function outcomeSourceKey(importKey, providerEventId) {
  return boundedKey('ch-imp-out', importKey, providerEventId);
}

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    connection: config.connectionModule ?? 'channel-connection',
    inbox: config.inboxModule ?? 'channel-inbox-event',
    letter: config.letterModule ?? 'channel-dead-letter',
    importState: config.importStateModule ?? 'channel-import-state',
    importOutcome: config.importOutcomeModule ?? 'channel-import-outcome',
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
  // The single clock the package reads for receive time and window
  // resolution: one injected clock drives ingest, the queue-time window
  // check and the worker recheck together, so tests never mix a frozen
  // adapter clock with the real receive clock. Production composes without
  // it and reads the wall clock, exactly as before.
  if (deps.nowMs !== undefined && typeof deps.nowMs !== 'function') {
    throw new ValidationError('channel nowMs must be a clock function returning milliseconds', {
      field: 'nowMs',
    });
  }
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();
  const names = resolvedNames(deps.config ?? {});
  // The opened `channel-sender@1` resolve function the composition hands
  // over (or a test double with the same shape). Absent is fine until an
  // import starts: webhook ingest and sends never resolve senders, so
  // standalone compositions keep working exactly as before.
  const resolveSender = deps.resolveSender ?? null;
  if (resolveSender !== null && typeof resolveSender !== 'function') {
    throw new ValidationError('channel resolveSender must be a function opening the composed channel-sender@1 capability', {
      field: 'resolveSender',
    });
  }
  // The handed-over `space-permission-gate@1` capability the composition
  // creates (same hand-over shape as channel-sender@1). The reply flow
  // refuses without it: an unwired composition must not send, nor silently
  // skip the approval the roadmap promises.
  const permissionGate = deps.permissionGate ?? null;
  if (permissionGate !== null && (typeof permissionGate !== 'object'
    || typeof permissionGate.gate !== 'function'
    || typeof permissionGate.propose !== 'function'
    || typeof permissionGate.proposal !== 'function')) {
    throw new ValidationError('channel permissionGate must open the composed space-permission-gate@1 capability (gate, propose, proposal)', {
      field: 'permissionGate',
    });
  }
  // The opened `llm-complete@1` handle ("Scrivi con AI"). Optional: without
  // it a caller-drafted reply still sends, but an AI draft refuses instead
  // of reaching for another model.
  const llm = deps.llm ?? null;
  if (llm !== null && (typeof llm !== 'object' || typeof llm.complete !== 'function')) {
    throw new ValidationError('channel llm must open the composed llm-complete@1 capability (complete)', {
      field: 'llm',
    });
  }
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
  const importStates = () => trusted(modules, names.importState, 'CHANNEL_STORAGE_INVALID');
  const importOutcomes = () => trusted(modules, names.importOutcome, 'CHANNEL_STORAGE_INVALID');

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
   * Normalize one channel event to its inbox item. Webhook deliveries and
   * history pages share these four fields, so both paths dedup on the same
   * source key and earn the same effect — a replayed past never becomes a
   * second row, on either path.
   */
  function toInboxItem(event, { spaceId, connectionKey, now, receiveMs }) {
    const providerEventId = typeof event?.providerEventId === 'string' && event.providerEventId !== ''
      && event.providerEventId.length <= 256 ? event.providerEventId : null;
    if (!providerEventId) {
      throw new AppError('Channel event is not well-formed', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
    }
    // The record contract stores no empty managed text (generated services
    // reject '' while the core runtime folds it to null): an absent subject
    // travels as null on the item, and every reader treats null like '' —
    // quarantine evidence, never a conversation.
    const subject = typeof event?.subject === 'string' && event.subject !== '' && event.subject.length <= 256
      ? event.subject : null;
    let sequence = Number.isSafeInteger(event?.sequence) ? event.sequence : null;
    let occurredAt = isCanonicalInstant(event?.occurredAt) ? event.occurredAt : null;
    // Fail-closed on provider time, here in the package so every adapter
    // shares it: a provider instant beyond receive time + skew never
    // becomes the window observation nor the out-of-order sequence — one
    // skewed or forged delivery would otherwise close the service window
    // and suppress every legitimate message after it. It is kept as
    // quarantine evidence at receive time, with the anomaly annotated.
    const futureSkew = occurredAt !== null && Date.parse(occurredAt) > receiveMs + CHANNEL_INGEST_FUTURE_SKEW_MS;
    if (futureSkew) {
      sequence = null;
      occurredAt = now;
    }
    return {
      providerEventId,
      subject,
      sequence,
      occurredAt,
      futureSkew,
      sourceKey: boundedKey('ch-in', spaceId, connectionKey, providerEventId),
    };
  }

  /**
   * The effect one item earns against its already-stored siblings: skewed
   * or subject-less items quarantine as evidence, an out-of-order item is
   * set aside, everything else applies.
   */
  function decideEffect(item, siblingRows) {
    if (item.futureSkew) {
      return { effect: 'quarantined', effectReason: 'provider timestamp beyond +5min skew: kept as evidence at receive time, never a window observation' };
    }
    if (item.subject === null || item.subject === '') {
      return { effect: 'quarantined', effectReason: 'unknown subject: no local mapping for this provider subject' };
    }
    if (item.sequence !== null) {
      const newer = siblingRows.filter((row) => row.subject === item.subject
        && row.effect === 'applied' && Number.isSafeInteger(row.sequence) && row.sequence > item.sequence);
      if (newer.length > 0) {
        return { effect: 'ignored', effectReason: `out-of-order delivery: newer sequence already applied for this subject` };
      }
    }
    return { effect: 'applied', effectReason: '' };
  }

  /**
   * The same provider message in the webhook envelope: the stored row was
   * import-marked and the normalized fields agree. The import path never
   * calls this — its identity is the (connection, providerEventId) source
   * key alone, so a re-listed event is always adopted and its drift
   * annotated, never a 409. Anything else with different bytes on the
   * webhook path stays a 409 — the webhook contract does not move.
   */
  function sameImportEvent(already, item, imported) {
    if (!imported && already.effectReason !== CHANNEL_IMPORT_ROW_REASON) return false;
    return already.providerEventId === item.providerEventId
      && (already.subject ?? '') === (item.subject ?? '')
      && already.sequence === item.sequence
      && already.occurredAt === item.occurredAt;
  }

  /**
   * The static annotation an import adoption carries when the re-listed
   * envelope drifted from the stored row. Compared field by field; every
   * fragment is fixed package text — provider-controlled values never
   * reach the outcome row. Null when nothing drifted.
   */
  function adoptionNote(already, item) {
    const parts = [];
    if ((already.subject ?? '') !== (item.subject ?? '')) parts.push(CHANNEL_IMPORT_NOTE_SUBJECT);
    if (already.sequence !== item.sequence) parts.push(CHANNEL_IMPORT_NOTE_SEQUENCE);
    if (already.occurredAt !== item.occurredAt) parts.push(CHANNEL_IMPORT_NOTE_OCCURRED_AT);
    return parts.length > 0 ? parts.join('; ') : null;
  }

  /**
   * A per-event failure the event will fail again: an owned 4xx the caller
   * can read and fix (malformed event, refused sender resolution). Anything
   * else — 5xx, timeouts, outages, unknown shapes — is retryable or
   * unknown, so the page aborts with the cursor unmoved instead of
   * skipping an event that a retry could complete. Fail-closed: unknown
   * errors never become silent skips.
   */
  function isDeterministicImportEventError(error) {
    const status = error !== null && typeof error === 'object'
      ? /** @type {any} */ (error).status : undefined;
    return Number.isSafeInteger(status) && status >= 400 && status < 500;
  }

  /**
   * Generated services reject empty managed text while the core runtime
   * folds it to null: an absent reason stores as null on both, so one
   * package runs unchanged on either service.
   */
  function storedReason(reason) {
    return reason === '' ? null : reason;
  }

  function eventIdConflict(item) {
    throw new AppError('Provider event id was already recorded with a different payload', {
      code: 'CHANNEL_EVENT_ID_CONFLICT', status: 409, details: { providerEventId: item.providerEventId },
    });
  }

  /**
   * Store one inbox item with the webhook contract both paths share:
   * the DB-unique source key makes a replay idempotent and a conflicting
   * payload a 409, a redelivery resumes an unprocessed row, and an
   * inactive connection quarantines instead of applying.
   *
   * `imported` marks history-path calls: an event's identity there is its
   * (connection, providerEventId) source key alone, so an import always
   * adopts the stored row — a webhook-first echo later listed with its
   * provider instant, a skewed redelivery, a re-listed past — and the
   * caller annotates the drift on the outcome row instead of 409ing.
   * Import-stored applied rows earn the same adoption from later webhooks
   * through their marker, subject to the normalized envelope agreeing.
   */
  async function storeInboxItem(service, {
    spaceId, connection, adapter, item, payloadFingerprint, actor, now, imported = false, importKey = null,
  }) {
    const already = service.listWhere({ sourceKey: item.sourceKey })[0];
    if (already) {
      if (already.payloadFingerprint !== payloadFingerprint) {
        // The import path adopts on stable identity alone: the same
        // message arrives in a different envelope on each path (push bytes
        // vs history payload), so fingerprints can never match across
        // paths — and a drifted re-listing must never brick the run with
        // a 409 the retry replays forever. The webhook path keeps its
        // conflict contract below.
        if (imported) {
          return { duplicate: true, eventId: already.id, effect: already.effect };
        }
        if (sameImportEvent(already, item, imported)) {
          return { duplicate: true, eventId: already.id, effect: already.effect };
        }
        eventIdConflict(item);
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
      const decision = decideEffect(item, service.listWhere({ spaceId, connectionKey: connection.sourceKey }));
      const transition = decision.effect === 'applied' ? 'apply' : decision.effect === 'ignored' ? 'discard' : 'quarantine';
      // Two redeliveries racing the same unprocessed row both read it as
      // received: the winner moves it, the loser's transition then lands on
      // the committed state and refuses CHANNEL_TRANSITION_INVALID. The loss
      // is not a conflict — the same bytes already earned their effect — so
      // the loser adopts the winner's row instead of 409ing (the same
      // loser-adopts-winner contract as the insert races in this function).
      let resumed;
      try {
        resumed = await transitionInbox(service, already.id, {
          event: transition,
          patch: { effectReason: decision.effectReason === '' ? 'redelivery resumed the received row' : decision.effectReason },
          actor,
        });
      } catch (error) {
        if (!error || typeof error !== 'object' || /** @type {any} */ (error).code !== 'CHANNEL_TRANSITION_INVALID') throw error;
        const winner = await service.get(already.id);
        if (!winner || winner.processed !== true) throw error;
        return { duplicate: true, eventId: winner.id, effect: winner.effect };
      }
      return { duplicate: false, resumed: true, eventId: resumed.id, effect: resumed.effect };
    }

    const baseRow = {
      sourceKey: item.sourceKey, spaceId, connectionKey: connection.sourceKey,
      adapter: adapter.name, adapterVersion: adapter.version,
      providerEventId: item.providerEventId, subject: item.subject, payloadFingerprint,
      sequence: item.sequence, occurredAt: item.occurredAt, receivedAt: now,
      // A history row carries the import that stored it (null on the webhook
      // path): a replayed page derives stored-by-this-import from the row
      // instead of recounting it, so crash retries converge to a clean run.
      ...(importKey ? { importKey } : {}),
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

    const decision = decideEffect(item, service.listWhere({ spaceId, connectionKey: connection.sourceKey }));
    // An applied import row carries the import marker instead of the empty
    // reason: later webhooks of the same message adopt it through the
    // marker rather than 409ing on the envelope. Quarantine and ignore
    // reasons stay exactly as decided — evidence keeps its explanation.
    const reason = imported && decision.effect === 'applied' && decision.effectReason === ''
      ? CHANNEL_IMPORT_ROW_REASON
      : decision.effectReason;
    try {
      const row = await service.createManaged({
        ...baseRow,
        processed: true,
        effect: decision.effect,
        effectReason: storedReason(reason),
      }, { actor });
      return { duplicate: false, eventId: row.id, effect: row.effect };
    } catch (error) {
      // A concurrent delivery of the same event won the insert: resolve
      // against the committed row instead of surfacing a raw violation —
      // the same contract as the pre-read branch above, so a conflicting
      // payload is CHANNEL_EVENT_ID_CONFLICT 409 on the webhook path,
      // while the import path adopts on stable identity alone.
      const raced = service.listWhere({ sourceKey: item.sourceKey })[0];
      if (raced) {
        if (raced.payloadFingerprint === payloadFingerprint) {
          return { duplicate: true, eventId: raced.id, effect: raced.effect };
        }
        if (imported) {
          return { duplicate: true, eventId: raced.id, effect: raced.effect };
        }
        if (sameImportEvent(raced, item, imported)) {
          return { duplicate: true, eventId: raced.id, effect: raced.effect };
        }
        eventIdConflict(item);
      }
      throw error;
    }
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
   * When the adapter normalizes the delivery to a list of events (a batched
   * provider webhook), one inbox row is stored per event in a single
   * transaction, each with its own dedup — a single event keeps today's
   * result shape, a batch returns `{ batched: true, events }`.
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
      // The same holds for any other adapter throw (a downstream outage, a
      // malformed header, a crypto failure): only an explicit invalid
      // signature — the adapter returning `{ ok: false }` below — is a 401.
      // Anything the adapter raises is a server-side stall the provider must
      // redeliver, never a forgery verdict.
      if (normalized.code === 'PROVIDER_TIMEOUT') {
        throw new AppError('Channel event verification timed out: retry the delivery', {
          code: 'CHANNEL_VERIFY_UNAVAILABLE', status: 503,
        });
      }
      throw new AppError('Channel event verification failed: retry the delivery', {
        code: 'CHANNEL_VERIFY_UNAVAILABLE', status: 503,
      });
    }
    if (!verified || verified.ok !== true) {
      throw new AppError('Channel event verification failed: invalid signature', { code: 'CHANNEL_SIGNATURE_INVALID', status: 401 });
    }
    let normalized;
    try {
      normalized = adapter.normalizeInbound(verified.event);
    } catch {
      throw new AppError('Channel event is not well-formed', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
    }
    // One delivery may carry several provider items (a batched Meta webhook
    // carries messages[] and statuses[] together): the adapter returns one
    // event per item, and the ingest stores one inbox row per event. Any
    // other adapter keeps returning its single event. Every event is
    // validated before any row is written, so a malformed item refuses the
    // whole delivery instead of storing half of it.
    const rawEvents = Array.isArray(normalized) ? normalized : [normalized];
    if (rawEvents.length === 0 || rawEvents.length > CHANNEL_MAX_BATCH_EVENTS) {
      throw new AppError('Channel event is not well-formed', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
    }
    const service = inbox();
    const receiveMs = nowMs();
    const now = new Date(receiveMs).toISOString();
    const payloadFingerprint = fingerprintPayload(rawBody);
    const storeParams = {
      spaceId, connection, adapter, payloadFingerprint, actor, now,
    };
    const items = rawEvents.map((event) => toInboxItem(event, {
      spaceId, connectionKey: connection.sourceKey, now, receiveMs,
    }));

    // A single event keeps today's result shape. A batch stores one row per
    // item in a single transaction — siblings are re-read per item inside
    // it, so an earlier item of the same delivery already orders a later
    // one — and a conflicting item refuses the whole delivery instead of
    // storing half of it. The transaction is ours only when no caller owns
    // one on this handle already (MEM_ACC_REUSE: the same proof the sibling
    // packages use): generated services nest on SAVEPOINT, a second outer
    // transaction would not.
    if (items.length === 1) {
      return storeInboxItem(service, { ...storeParams, item: items[0] });
    }
    const storeBatch = async () => {
      const results = [];
      for (const item of items) results.push(await storeInboxItem(service, { ...storeParams, item }));
      return results;
    };
    let batchTransaction = null;
    if (database && typeof database.transactionAsync === 'function') {
      let proof = null;
      try {
        proof = proveCallerTransaction([{ database }]);
      } catch {
        proof = null;
      }
      if (proof === TRANSACTION_PROOF.NO_TRANSACTION) {
        batchTransaction = (critical) => database.transactionAsync(critical);
      }
    }
    const events = batchTransaction ? await database.transactionAsync(storeBatch) : await storeBatch();
    return { batched: true, events };
  }

  /**
   * Count one import's outcome rows, one COUNT per state. The number is
   * always the rows themselves: no advance tallies anything by hand, so a
   * racing advance or a crash retry cannot drift the counts — the retry
   * replays to the same rows and the COUNT reads them. `pending` senders
   * (stored rows whose reconciliation is still waiting for the composed
   * capability) count as unresolved: no contact names them yet.
   * @param {string} importKey the import row's sourceKey
   */
  function countImportOutcomes(importKey) {
    const totals = {
      imported: 0, duplicates: 0, failed: 0,
      matched: 0, created: 0, unresolved: 0, withoutSender: 0,
    };
    for (const entry of importOutcomes().listWhere({ importKey })) {
      if (entry.outcome === 'imported') totals.imported += 1;
      else if (entry.outcome === 'duplicate') totals.duplicates += 1;
      else if (entry.outcome === 'failed') totals.failed += 1;
      if (entry.sender === 'matched') totals.matched += 1;
      else if (entry.sender === 'created') totals.created += 1;
      else if (entry.sender === 'unresolved' || entry.sender === 'pending') totals.unresolved += 1;
      if (entry.sender === 'none' && entry.applied === true) totals.withoutSender += 1;
    }
    return totals;
  }

  /**
   * The progress surface the pilot reads: counts only, never the provider
   * cursor (opaque, server-side) and never sender addresses (they live in
   * the customer-data identity rows, not in a progress report).
   */
  function importStateSummary(row) {
    const counts = countImportOutcomes(row.sourceKey);
    return Object.freeze({
      spaceId: row.spaceId,
      connectionKey: row.connectionKey,
      adapter: row.adapter,
      adapterVersion: row.adapterVersion,
      status: row.status,
      windowStart: row.windowStart,
      importedEvents: counts.imported,
      duplicateEvents: counts.duplicates,
      failedEvents: counts.failed,
      matchedContacts: counts.matched,
      createdContacts: counts.created,
      unresolvedContacts: counts.unresolved,
      eventsWithoutSender: counts.withoutSender,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      lastErrorCode: row.lastErrorCode,
      lastErrorReason: row.lastErrorReason,
    });
  }

  /**
   * Record one event's outcome under its unique (import, event) key. A
   * concurrent advance that won the same event keeps its row: the loser
   * re-reads it instead of surfacing a raw unique violation — the same
   * contract as the inbox store below. Refinement is one-directional:
   * absent and `failed` take the new values, `pending` takes the refined
   * sender, a final outcome is kept. The row part never needs forcing: the
   * caller derives it from the inbox row (a store that inserted proves
   * `imported`; a duplicate reads the row's importKey), so whatever the
   * interleave, the recorded outcome agrees with the row.
   */
  async function recordImportOutcome({ spaceId, connectionKey, importKey, providerEventId, outcome, sender, applied, note = null }) {
    const service = importOutcomes();
    const sourceKey = outcomeSourceKey(importKey, providerEventId);
    const actor = SYSTEM();
    // Notes only accumulate static fragments (a '; '-separated set union):
    // a replay carrying the same annotation is a no-op, never a rewrite —
    // so racing advances still converge instead of recounting each other.
    const mergeNote = (current, incoming) => {
      if (!incoming) return null;
      if (!current) return incoming;
      const seen = new Set(String(current).split('; '));
      const fresh = String(incoming).split('; ').filter((part) => !seen.has(part));
      return fresh.length > 0 ? `${current}; ${fresh.join('; ')}` : null;
    };
    const refine = (current) => {
      const patch = {};
      const senderFinal = IMPORT_OUTCOME_FINAL_SENDERS.has(current.sender) && current.outcome !== 'failed';
      if (!senderFinal) {
        const nextOutcome = current.outcome === 'failed' ? outcome : current.outcome;
        const nextSender = current.sender === 'pending' || current.outcome === 'failed' ? sender : current.sender;
        if (nextOutcome !== current.outcome) patch.outcome = nextOutcome;
        if (nextSender !== current.sender) patch.sender = nextSender;
        if (applied !== current.applied) patch.applied = applied;
      } else if ((current.sender === 'created' || current.sender === 'matched') && sender === 'unresolved') {
        // A later sighting of the same event resolves to conflicting sender
        // evidence: the conflict belongs to the human confirm queue, so the
        // outcome refines toward unresolved — the only direction a final
        // sender ever moves.
        patch.sender = sender;
      }
      const notePatch = mergeNote(current.note ?? null, note);
      if (notePatch) patch.note = notePatch;
      if (Object.keys(patch).length === 0) return null;
      return patch;
    };
    const existing = service.listWhere({ sourceKey })[0] ?? null;
    if (existing) {
      const patch = refine(existing);
      if (!patch || Object.keys(patch).length === 0) return existing;
      return service.applyManaged(existing.id, patch, { actor });
    }
    try {
      return await service.createManaged({
        sourceKey, spaceId, connectionKey, importKey, providerEventId,
        outcome, sender, applied, note,
      }, { actor });
    } catch {
      // A concurrent advance won the same event between the read and the
      // insert: resolve against the committed row like the inbox store.
      const raced = service.listWhere({ sourceKey })[0] ?? null;
      if (!raced) {
        throw new AppError('Channel import outcome write lost its race with no winner', {
          code: 'CHANNEL_STORE_TRANSIENT', status: 503,
        });
      }
      const patch = refine(raced);
      if (!patch || Object.keys(patch).length === 0) return raced;
      return service.applyManaged(raced.id, patch, { actor });
    }
  }

  function importSourceKey(spaceId, connectionKey) {
    return boundedKey('ch-imp', spaceId, connectionKey);
  }

  function findImportState(spaceId, connectionKey) {
    return importStates().listWhere({ sourceKey: importSourceKey(spaceId, connectionKey) })[0] ?? null;
  }

  /**
   * Whether a connection can ever contribute to the sync totals: its
   * adapter resolves and declares `historyImport`. An unresolvable
   * adapter reads as not importable — the read stays available for the
   * whole space instead of refusing it — and the entry still lists the
   * binding status, so the broken wiring stays visible.
   */
  function isHistoryImportable(connection) {
    try {
      const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
      return Boolean(adapter.historyImport);
    } catch {
      return false;
    }
  }

  function requireHistoryAdapter(connection) {
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    if (!adapter.historyImport) {
      throw new AppError(`Channel adapter "${connection.adapter}" keeps no readable history: initial import is unavailable`, {
        code: 'CHANNEL_HISTORY_UNAVAILABLE', status: 409,
      });
    }
    return adapter;
  }

  /**
   * Resolve one imported sender through the composed `channel-sender@1`
   * capability, or record it pending when the composition runs without
   * customer-data. A null resolver never refuses the import: conversations
   * and messages are stored either way, and the outcome stays `pending`
   * ("reconciliation pending", counted as unresolved) until an advance
   * with the capability resolves it. A genuine resolution failure throws
   * for the caller to record: its text is never read here, because it may
   * echo provider-controlled secrets or PII.
   * @returns {Promise<'created'|'matched'|'unresolved'|'none'|'pending'>}
   */
  async function resolveImportSender(event, adapter, actor) {
    if (!resolveSender) return 'pending';
    let answer;
    try {
      answer = await resolveSender({
        channel: adapter.channel,
        handle: event.sender.handle,
        ...(event.sender.email === undefined ? {} : { email: event.sender.email }),
        ...(event.sender.firstName === undefined ? {} : { firstName: event.sender.firstName }),
        ...(event.sender.lastName === undefined ? {} : { lastName: event.sender.lastName }),
        actor,
      });
    } catch (error) {
      // Malformed sender evidence names nobody: the message is kept, the
      // contact is not invented.
      if (error instanceof ValidationError) return 'none';
      throw error;
    }
    if (answer.outcome === 'matched') return 'matched';
    if (answer.outcome === 'created') return 'created';
    return 'unresolved';
  }

  /**
   * Start the progressive initial import of one connection's provider past.
   * A human decision (connecting the channel): the actor is required, like
   * registration. Records the window the adapter declares and the cursor to
   * resume from; pulling starts with the first advance call. Restarting a
   * running import resumes it — including two overlapping starts, which
   * resolve to the single stored row instead of a raw unique violation;
   * a completed one refuses — a refresh is a new voice, not a silent
   * re-import.
   */
  async function startInitialImport(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    const adapter = requireHistoryAdapter(connection);
    // No sender requirement at start: without the composed capability the
    // import still stores conversations and messages, leaving sender
    // reconciliation pending — never a new boot requirement.
    const sourceKey = importSourceKey(spaceId, connection.sourceKey);
    // Starting is idempotent: a repeated start resumes the running import,
    // and two overlapping starts resolve to the single stored row — never
    // a raw unique violation, never a second import of one connection.
    const resolveExisting = (existing) => {
      if (existing.status === 'done') {
        throw new AppError('Initial import already completed for this connection', {
          code: 'CHANNEL_IMPORT_COMPLETE', status: 409,
        });
      }
      return { resumed: true, started: false, state: importStateSummary(existing) };
    };
    const existing = importStates().listWhere({ sourceKey })[0];
    if (existing) return resolveExisting(existing);
    const now = nowIso();
    try {
      const row = await importStates().createManaged({
        sourceKey,
        spaceId,
        connectionKey: connection.sourceKey,
        adapter: adapter.name,
        adapterVersion: adapter.version,
        status: 'running',
        windowStart: new Date(Date.parse(now) - adapter.historyImport.windowMs).toISOString(),
        nextPageToken: null,
        startedAt: now,
        finishedAt: null,
        lastErrorCode: null,
        lastErrorReason: null,
      }, { actor });
      return { resumed: false, started: true, state: importStateSummary(row) };
    } catch (error) {
      // A concurrent start won the same source key between the read and
      // the insert: losing the race resumes the committed row — the same
      // contract as the connection registration above.
      const raced = importStates().listWhere({ sourceKey })[0];
      if (raced) return resolveExisting(raced);
      throw error;
    }
  }

  /**
   * Pull one bounded history page and reconcile it. Mechanical work the
   * scheduler repeats until done, so it runs under the package system
   * actor: a caller-supplied actor is ignored, never trusted for audit
   * attribution — the same discipline as provider-driven ingest.
   *
   * Crash-safe by per-event outcome rows, not by tallies: every processed
   * event writes one `channel-import-outcome` row under its unique (import,
   * event) key — row stored or duplicate, sender created/matched/unresolved,
   * none, pending, or failed — and the progress surface counts those rows
   * (one COUNT per state) instead of trusting hand-kept counters. A page
   * that aborts keeps the cursor, so the retry replays to the same rows and
   * the COUNT reads them: the same numbers as a clean run, because the
   * number is always the rows themselves. A poisoned event — one that
   * fails deterministically (an owned 4xx), whatever the attempt — is
   * recorded failed and skipped instead: the page continues and the cursor
   * advances past it, so one bad event can never brick the run. Only
   * transient failures abort with the cursor unmoved. Sender resolution itself stays
   * autonomous — its own transactions, never nested in the page's — and
   * optional: without the composed capability the import still stores
   * conversations and messages, leaving senders pending.
   * The state cursor moves only on an owned transition: a racing advance
   * never regresses it and never marks done on a stale page.
   */
  async function advanceInitialImport(params) {
    const actor = SYSTEM();
    const spaceId = assertSpaceId(params?.spaceId);
    // Pure-input bounds fail identically regardless of import state: a
    // malformed limit must never oracle whether an import row exists.
    const limit = params?.limit === undefined ? CHANNEL_HISTORY_DEFAULT_PAGE : params.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANNEL_HISTORY_PAGE_MAX) {
      throw new ValidationError(`history page limit must be an integer 1-${CHANNEL_HISTORY_PAGE_MAX}`, { field: 'limit' });
    }
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    const row = findImportState(spaceId, connection.sourceKey);
    if (!row) {
      throw new AppError('No initial import started for this connection', {
        code: 'CHANNEL_IMPORT_UNKNOWN', status: 404,
      });
    }
    if (row.status === 'done') {
      return { done: true, state: importStateSummary(row), page: null };
    }
    const adapter = requireHistoryAdapter(connection);
    let secret;
    try {
      secret = await resolveSecret(connection.secretRef, { spaceId, purpose: CHANNEL_SECRET_PURPOSE_HISTORY });
    } catch {
      throw new AppError('Channel secret is unavailable', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
    }
    if (typeof secret !== 'string' || secret === '') {
      throw new AppError('Channel secret is unavailable', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
    }

    const stampFailure = async (code, reason) => {
      try {
        await importStates().applyManaged(row.id, { lastErrorCode: code, lastErrorReason: reason }, { actor });
      } catch {
        // The page already failed: a storage outage while stamping it must
        // not replace the failure the caller retries on.
      }
    };

    let page;
    try {
      page = await withTimeout(
        Promise.resolve(adapter.historyImport.listHistory({
          secret,
          account: connection.account,
          since: row.windowStart,
          pageToken: row.nextPageToken,
          limit,
        })),
        CHANNEL_HISTORY_TIMEOUT_MS,
        `channel adapter "${adapter.name}" listHistory`,
      );
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'PROVIDER_TIMEOUT') {
        await stampFailure('CHANNEL_HISTORY_TRANSIENT', 'provider history read timed out: retry the advance');
        throw new AppError('Channel history read timed out: retry the advance', {
          code: 'CHANNEL_HISTORY_TRANSIENT', status: 503,
        });
      }
      // The row keeps the failure code plus a static note only. An adapter
      // throw may echo secrets, tokens, or PII from the provider request,
      // so its message is never persisted and never rethrown: the caller
      // gets the same code with a fixed message instead.
      const code = importFailureCode(error, 'CHANNEL_HISTORY_UNAVAILABLE');
      await stampFailure(code, CHANNEL_IMPORT_READ_FAILED_NOTE);
      throw new AppError('Channel history read failed: retry the advance', {
        code, status: normalized instanceof AppError ? normalized.status : 500,
      });
    }
    let checked;
    try {
      checked = assertHistoryPage(page, limit);
    } catch (error) {
      await stampFailure('CHANNEL_HISTORY_MALFORMED', 'provider history page failed validation: retry the advance');
      throw new AppError('Channel history page is not well-formed', {
        code: 'CHANNEL_HISTORY_MALFORMED', status: 422,
      });
    }

    const service = inbox();
    const outcomeService = importOutcomes();
    const receiveMs = nowMs();
    const now = new Date(receiveMs).toISOString();
    const done = checked.nextPageToken === null;
    const commitKey = importSourceKey(spaceId, connection.sourceKey);
    const importKey = row.sourceKey;

    const knownOutcome = (providerEventId) => outcomeService.listWhere({
      sourceKey: outcomeSourceKey(importKey, providerEventId),
    })[0] ?? null;

    const processEvent = async (event) => {
      const known = knownOutcome(event.providerEventId);
      if (known && known.outcome !== 'failed' && known.sender !== 'pending') {
        // A final outcome from an earlier attempt: replaying it recounts
        // nothing — except a re-listed same event whose sender evidence
        // now conflicts with the earlier sighting. The stored rows carry
        // no sender text by design, so the conflict is detected by
        // re-resolving: only a fresh `unresolved` verdict refines, routing
        // the conflict to the human confirm queue the reconciliation
        // already keeps. Anything else keeps the recorded outcome, and a
        // resolution outage on this best-effort check never aborts a page
        // whose rows are already final.
        if (event.sender && known.applied === true
          && (known.sender === 'created' || known.sender === 'matched')) {
          let fresh = null;
          try {
            fresh = await resolveImportSender(event, adapter, actor);
          } catch {
            fresh = null;
          }
          if (fresh === 'unresolved') {
            await recordImportOutcome({
              spaceId, connectionKey: connection.sourceKey, importKey,
              providerEventId: event.providerEventId, outcome: known.outcome,
              sender: fresh, applied: known.applied,
              note: CHANNEL_IMPORT_NOTE_SENDER_CONFLICT,
            });
          }
        }
        return;
      }
      let item;
      try {
        item = toInboxItem(event, {
          spaceId, connectionKey: connection.sourceKey, now, receiveMs,
        });
      } catch (error) {
        // The envelope itself is malformed — deterministically, whatever
        // the attempt: record the failure and continue with the page.
        // Anything unrecognized still aborts below, fail-closed.
        if (isDeterministicImportEventError(error)) {
          await recordImportOutcome({
            spaceId, connectionKey: connection.sourceKey, importKey,
            providerEventId: event.providerEventId, outcome: 'failed',
            sender: 'none', applied: false, note: null,
          });
          return;
        }
        throw error;
      }
      const record = (outcome, sender, applied, note = null) => recordImportOutcome({
        spaceId, connectionKey: connection.sourceKey, importKey,
        providerEventId: event.providerEventId, outcome, sender, applied, note,
      });
      let stored;
      try {
        stored = await storeInboxItem(service, {
          spaceId,
          connection,
          adapter,
          item,
          payloadFingerprint: fingerprintPayload(JSON.stringify(event)),
          actor,
          now,
          imported: true,
          importKey,
        });
      } catch (error) {
        // A deterministically failing event is recorded failed and
        // skipped: the page continues and the cursor advances past it. A
        // transient failure still aborts the page — the cursor stays, so
        // the retry reprocesses it like a new event. The abort below
        // carries no error text: it may echo provider-controlled secrets
        // or PII.
        if (isDeterministicImportEventError(error)) {
          await record('failed', 'none', false);
          return;
        }
        if (!known) await record('failed', 'none', false);
        throw error;
      }
      // A store that inserted proves `imported`. A duplicate derives from
      // the row: one this import stored carries its importKey, so a crash
      // between the inbox write and the outcome write replays as `imported`
      // and converges to a clean run — while a webhook-first row stays a
      // duplicate. A resumed row predates the import by construction. An
      // adopted duplicate annotates how the re-listed envelope drifted
      // from the stored row — static text only, never provider values.
      let rowOutcome;
      let note = null;
      if (stored.duplicate === false && stored.resumed !== true) {
        rowOutcome = 'imported';
      } else if (stored.duplicate === true) {
        const current = service.listWhere({ sourceKey: item.sourceKey })[0];
        rowOutcome = current && current.importKey === importKey ? 'imported' : 'duplicate';
        if (current) note = adoptionNote(current, item);
      } else {
        const current = service.listWhere({ sourceKey: item.sourceKey })[0];
        rowOutcome = current && current.importKey === importKey ? 'imported' : 'duplicate';
      }
      const appliedNow = stored.effect === 'applied';
      // A replayed row keeps its evidence, but an applied row's sender is
      // still reconciled: the first store may have been a webhook — which
      // never resolves senders — or a crash may have landed between the
      // inbox write and the resolution. Resolution is idempotent, so the
      // replay converges instead of doubling.
      // Quarantined or set-aside items stay evidence: no contact is ever
      // invented from a row the package refused to apply.
      if (!appliedNow || !event.sender) {
        await record(rowOutcome, 'none', appliedNow, note);
        return;
      }
      let sender;
      try {
        sender = await resolveImportSender(event, adapter, actor);
      } catch (error) {
        // A deterministically refused sender fails whatever the attempt:
        // record it failed and skip like a poisoned event. A transient
        // outage still leaves the outcome pending and aborts the page, so
        // the retry resolves only the sender — and the abort carries no
        // error text.
        if (isDeterministicImportEventError(error)) {
          await record('failed', 'unresolved', appliedNow, note
            ? `${note}; ${CHANNEL_IMPORT_NOTE_SENDER_REFUSED}`
            : CHANNEL_IMPORT_NOTE_SENDER_REFUSED);
          return;
        }
        await record(rowOutcome, 'pending', appliedNow, note);
        throw error;
      }
      await record(rowOutcome, sender, appliedNow, note);
    };

    const processPage = async () => {
      for (const event of checked.events) await processEvent(event);
    };

    // One managed write carries the cursor move, the phase change and the
    // failure stamp. Tallies travel in the outcome rows the page already
    // wrote, so the commit and the counts can never drift apart.

    // Processing and the cursor commit run in one serialized slot per import
    // (same-process chain above; cross-process advances converge through the
    // outcome rows, never through shared counters). A page that aborts keeps
    // the cursor — the completed events already wrote their outcomes, so
    // the retry replays the same page to the same rows and counts.
    const committed = await withImportCommit(commitKey, async () => {
      // The page answer reports deltas, derived from the rows before and
      // after inside this serialized slot — never tallied by hand, so a
      // retry never double-counts and a racing loser reports exact zeros.
      const before = countImportOutcomes(importKey);
      try {
        await processPage();
      } catch (error) {
        // Package-own aborts keep their code and travel unchanged (their
        // messages are static); anything provider-adjacent is rethrown with
        // the same code and a fixed message, never the original text.
        const owned = error instanceof AppError
          && (error.code === 'CHANNEL_EVENT_ID_CONFLICT' || error.code === 'CHANNEL_EVENT_MALFORMED');
        const code = owned ? error.code : importFailureCode(error, 'CHANNEL_HISTORY_UNAVAILABLE');
        try {
          await importStates().applyManaged(row.id, {
            lastErrorCode: code,
            lastErrorReason: CHANNEL_IMPORT_PAGE_FAILED_NOTE,
          }, { actor });
        } catch {
          // The page already failed: a storage outage while stamping it must
          // not replace the failure the caller retries on. The completed
          // events already wrote their outcomes, so the next advance replays
          // from the rows themselves.
        }
        if (owned) throw error;
        const normalized = normalizeError(error);
        throw new AppError('Import page failed before completion: retry the advance', {
          code, status: normalized instanceof AppError ? normalized.status : 500,
        });
      }
      // Owned cursor transition only: a racing advance may have moved the
      // cursor while this one fetched its page from the provider. Keeping
      // the winner's cursor never regresses the run and never marks done on
      // a stale page — the events this page processed already wrote their
      // outcomes, so nothing is lost either way.
      const live = findImportState(spaceId, connection.sourceKey) ?? row;
      if (live.nextPageToken !== row.nextPageToken) return { updated: live, before };
      const committed = await importStates().applyManaged(row.id, {
        nextPageToken: checked.nextPageToken,
        ...(done ? { status: 'done', finishedAt: now } : {}),
        lastErrorCode: null,
        lastErrorReason: null,
      }, { actor });
      return { updated: committed, before };
    });
    const { updated, before } = committed;
    const after = countImportOutcomes(importKey);
    return {
      done: updated.status === 'done' ? true : done && updated.nextPageToken === checked.nextPageToken,
      state: importStateSummary(updated),
      page: Object.freeze({
        imported: after.imported - before.imported,
        duplicates: after.duplicates - before.duplicates,
        failed: after.failed - before.failed,
        matched: after.matched - before.matched,
        created: after.created - before.created,
        unresolved: after.unresolved - before.unresolved,
        withoutSender: after.withoutSender - before.withoutSender,
      }),
    };
  }

  /**
   * Read the import progress of one connection: status and counts. Null
   * when no import ever started — an honest absence, not an empty report.
   */
  function readInitialImport(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireConnection(spaceId, connectionKey);
    if (!connection) return null;
    const row = findImportState(spaceId, connection.sourceKey);
    return row ? importStateSummary(row) : null;
  }

  /**
   * Read the sync state of every connection in one space (backlog:f815763b7aa5):
   * one entry per connection — its binding and, when its first import
   * started, the same progress surface `readInitialImport` returns — plus
   * the connected/completed totals the pilot's banner reads. Only `active`
   * connections whose adapter keeps a readable history count as connected:
   * a pending, suspended or revoked binding cannot sync, and an adapter
   * without `historyImport` (WhatsApp, Instagram) can never start one —
   * `startInitialImport` refuses it with CHANNEL_HISTORY_UNAVAILABLE — so
   * neither ever holds the banner back. Such entries stay listed with
   * `importable: false` and `sync: null`: not finished, never an invented
   * report. Entries sort by connection key, so two reads of one space
   * always agree. Read-only like the other progress surface: no actor, no
   * mutation, no secret material — the entry carries the binding identity
   * (including the account, so the backoffice can resume an incomplete
   * connection through authorize) and the adapter, never the secret
   * reference.
   */
  function readSyncState(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const entries = connections().listWhere({ spaceId }).map((connection) => {
      const row = findImportState(spaceId, connection.sourceKey);
      return Object.freeze({
        connectionKey: connection.sourceKey,
        channel: connection.channel,
        account: connection.account,
        adapter: connection.adapter,
        adapterVersion: connection.adapterVersion,
        status: connection.status,
        importable: isHistoryImportable(connection),
        sync: row ? importStateSummary(row) : null,
      });
    }).sort((left, right) => (left.connectionKey < right.connectionKey ? -1
      : left.connectionKey > right.connectionKey ? 1 : 0));
    const connected = entries.filter((entry) => entry.status === 'active' && entry.importable).length;
    const completed = entries.filter((entry) => entry.status === 'active' && entry.importable && entry.sync?.status === 'done').length;
    return Object.freeze({
      spaceId,
      connectors: Object.freeze(entries),
      connected,
      completed,
    });
  }

  /**
   * Read the sync activity of every connection in one space
   * (backlog:8fdbc5f21cd0, BO-F1-03): the counters and the live feed the
   * "Stato sync" screen renders, all read from the real inbox and
   * dead-letter rows — never invented, never provider text. One entry per
   * connection — its binding, the same import progress surface
   * `readInitialImport` returns, inbox tallies by effect, open dead
   * letters, the observed direction (`in` when inbox rows exist, `out`
   * when dead-letter rows exist, `both` when both do, null before any
   * traffic), and a health verdict (`idle` while a binding waits for
   * activation or before the first pull of an importable connection
   * with no traffic yet, `down` when a binding is suspended or revoked,
   * `attention` when quarantined rows, open dead letters or a failed
   * import need a human, `ok` otherwise) — plus the space feed (latest inbox rows as `in` with
   * their effect, latest open dead letters as `out` with their normalized
   * error code, newest first) and the `needsFix` total that lights the
   * Impostazioni badge (quarantined inbox rows plus open dead letters).
   * The feed carries no subject, no payload and no provider wording: a
   * secret or personal handle repeated by the provider must never reach
   * the screen. Read-only: no actor, no mutation.
   */
  function readSyncActivity(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const feedLimit = params?.feedLimit === undefined ? 20 : params.feedLimit;
    if (!Number.isSafeInteger(feedLimit) || feedLimit < 1 || feedLimit > 100) {
      throw new ValidationError('feed limit must be an integer 1-100', { field: 'feedLimit' });
    }
    const inboxRows = inbox().listWhere({ spaceId });
    const letterRows = letters().listWhere({ spaceId });
    const byConnection = new Map();
    const atConnection = (connectionKey) => {
      let entry = byConnection.get(connectionKey);
      if (!entry) {
        entry = { inbox: [], letters: [] };
        byConnection.set(connectionKey, entry);
      }
      return entry;
    };
    for (const row of inboxRows) atConnection(row.connectionKey).inbox.push(row);
    for (const row of letterRows) atConnection(row.connectionKey).letters.push(row);

    const inboxSummary = (rows) => {
      const tallies = { applied: 0, quarantined: 0, ignored: 0, duplicate: 0, pending: 0 };
      let lastReceivedAt = null;
      for (const row of rows) {
        if (Object.hasOwn(tallies, row.effect)) tallies[row.effect] += 1;
        if (typeof row.receivedAt === 'string'
          && (lastReceivedAt === null || row.receivedAt > lastReceivedAt)) {
          lastReceivedAt = row.receivedAt;
        }
      }
      return Object.freeze({ received: rows.length, ...tallies, lastReceivedAt });
    };
    const outboxSummary = (rows) => {
      const open = rows.filter((row) => row.state === 'open');
      let lastFailedAt = null;
      for (const row of open) {
        if (typeof row.lastFailedAt === 'string'
          && (lastFailedAt === null || row.lastFailedAt > lastFailedAt)) {
          lastFailedAt = row.lastFailedAt;
        }
      }
      return Object.freeze({ openDeadLetters: open.length, lastFailedAt });
    };

    const entries = connections().listWhere({ spaceId }).map((connection) => {
      const traffic = byConnection.get(connection.sourceKey) ?? { inbox: [], letters: [] };
      const inboxCount = inboxSummary(traffic.inbox);
      const outbox = outboxSummary(traffic.letters);
      const row = findImportState(spaceId, connection.sourceKey);
      const sync = row ? importStateSummary(row) : null;
      const fixes = inboxCount.quarantined + outbox.openDeadLetters;
      const health = connection.status !== 'active'
        ? (connection.status === 'pending' ? 'idle' : 'down')
        : fixes > 0 || Boolean(sync && sync.lastErrorCode) ? 'attention'
          : sync === null && isHistoryImportable(connection) && inboxCount.received === 0 ? 'idle' : 'ok';
      const direction = inboxCount.received > 0 && traffic.letters.length > 0 ? 'both'
        : inboxCount.received > 0 ? 'in'
          : traffic.letters.length > 0 ? 'out' : null;
      return Object.freeze({
        connectionKey: connection.sourceKey,
        channel: connection.channel,
        account: connection.account,
        adapter: connection.adapter,
        adapterVersion: connection.adapterVersion,
        status: connection.status,
        importable: isHistoryImportable(connection),
        sync,
        inbox: inboxCount,
        outbox,
        direction,
        health,
        needsFix: fixes,
      });
    }).sort((left, right) => (left.connectionKey < right.connectionKey ? -1
      : left.connectionKey > right.connectionKey ? 1 : 0));

    const feed = [];
    for (const row of inboxRows) {
      if (typeof row.receivedAt !== 'string') continue;
      const connection = entries.find((entry) => entry.connectionKey === row.connectionKey);
      feed.push(Object.freeze({
        direction: 'in',
        connectionKey: row.connectionKey,
        channel: connection?.channel ?? null,
        at: row.receivedAt,
        kind: typeof row.effect === 'string' ? row.effect : 'unknown',
      }));
    }
    for (const row of letterRows) {
      if (row.state !== 'open' || typeof row.lastFailedAt !== 'string') continue;
      const connection = entries.find((entry) => entry.connectionKey === row.connectionKey);
      feed.push(Object.freeze({
        direction: 'out',
        connectionKey: row.connectionKey,
        channel: connection?.channel ?? null,
        at: row.lastFailedAt,
        kind: 'dead-letter',
        code: typeof row.errorCode === 'string' ? row.errorCode : 'CHANNEL_SEND_FAILED',
      }));
    }
    feed.sort((left, right) => (left.at > right.at ? -1 : left.at < right.at ? 1
      : left.connectionKey < right.connectionKey ? -1
        : left.connectionKey > right.connectionKey ? 1 : 0));
    const capped = feed.slice(0, feedLimit);

    let lastActivityAt = null;
    for (const entry of entries) {
      for (const at of [entry.inbox.lastReceivedAt, entry.outbox.lastFailedAt]) {
        if (typeof at === 'string' && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at;
      }
    }
    const needsFix = entries.reduce((total, entry) => total + entry.needsFix, 0);
    return Object.freeze({
      spaceId,
      connections: Object.freeze(entries),
      feed: Object.freeze(capped),
      needsFix,
      lastActivityAt,
    });
  }

  /**
   * Pull one bounded history page of a connection right now
   * (backlog:8fdbc5f21cd0, BO-F1-03 "Sincronizza ora"): the same paged
   * pull the progressive import walks, driven by a human instead of the
   * scheduler. Starting is a human decision, so the actor is required and
   * travels into the import start like the guided connect flow; the page
   * itself runs under the package system actor like every other advance.
   * When no import ever started, this call starts it and pulls the first
   * page; when one is running, it pulls the next page; when it is done,
   * it reports done with a null page — a refresh of a finished past is a
   * new voice, never a silent re-import. New events are stored through
   * the deduped ingest path, so a re-listed past recounts as duplicates
   * instead of doubling. Adapters without `historyImport` refuse with
   * CHANNEL_HISTORY_UNAVAILABLE, so the screen only enables the button
   * where a pull exists.
   */
  async function syncNowChannel(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const limit = params?.limit === undefined ? CHANNEL_HISTORY_DEFAULT_PAGE : params.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANNEL_HISTORY_PAGE_MAX) {
      throw new ValidationError(`history page limit must be an integer 1-${CHANNEL_HISTORY_PAGE_MAX}`, { field: 'limit' });
    }
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    requireHistoryAdapter(connection);
    let started = false;
    if (!findImportState(spaceId, connection.sourceKey)) {
      const created = await startInitialImport({ spaceId, connectionKey, actor });
      started = created.started === true;
    }
    const advanced = await advanceInitialImport({ spaceId, connectionKey, limit });
    return Object.freeze({
      started,
      done: advanced.done,
      state: advanced.state,
      page: advanced.page,
    });
  }

  /**
   * Resolve the service-window observation server-side for adapters that
   * declare `outboundWindow`: the latest applied customer-message instant
   * recorded in the inbox for the recipient's conversation — the provider
   * timestamp when present, else our receipt time. Caller time never
   * enters: a forged or absent `lastInboundAt` cannot open the window.
   * Returns the canonical instant, or null when nothing observable opens it.
   */
  function resolveWindowObservation(spaceId, connectionKey, rawMessage, window) {
    let subject = null;
    try {
      subject = window.subjectForRecipient(rawMessage?.to);
    } catch {
      return null;
    }
    if (typeof subject !== 'string' || subject === '') return null;
    const referenceMs = nowMs();
    let latest = null;
    for (const row of inbox().listWhere({ spaceId, connectionKey })) {
      if (row.subject !== subject || row.effect !== 'applied') continue;
      try {
        if (!window.isObservation(row)) continue;
      } catch {
        continue;
      }
      const at = typeof row.occurredAt === 'string' ? row.occurredAt : row.receivedAt;
      if (typeof at !== 'string') continue;
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      // Belt and braces with the ingest skew quarantine above: an
      // observation dated beyond now + skew (a row stored before the
      // quarantine existed) never opens the window.
      if (ms > referenceMs + CHANNEL_INGEST_FUTURE_SKEW_MS) continue;
      if (latest === null || ms > latest) latest = ms;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }

  /**
   * Normalize one human-supplied outbound message through the adapter,
   * window included. Shared by queue and requeue: the window observation is
   * re-resolved server-side from the inbox in both, so a message approved
   * while the window was open but sent after it still refuses at execution.
   */
  function normalizeOutboundMessage(adapter, spaceId, connection, rawMessage) {
    // Resolved outside the normalize try: a storage failure here is a 500
    // of its own, never a malformed message.
    const windowCtx = adapter.outboundWindow
      ? {
        lastInboundAt: resolveWindowObservation(
          spaceId, connection.sourceKey, rawMessage, adapter.outboundWindow,
        ),
      }
      : undefined;
    let message;
    try {
      message = adapter.outboundWindow
        ? adapter.normalizeOutbound(rawMessage, windowCtx)
        : adapter.normalizeOutbound(rawMessage);
    } catch (error) {
      // A window refusal is the adapter's contract with its callers (send a
      // template instead): it travels intact, never flattened into the
      // generic malformed code.
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'CHANNEL_TEMPLATE_REQUIRED') {
        throw error;
      }
      throw new AppError('Channel message is not well-formed', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
    }
    return assertOutboundMessage(message);
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
    const message = normalizeOutboundMessage(adapter, spaceId, connection, params?.message);
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

  /**
   * Queue one APPROVED TEMPLATE through the durable-jobs outbox under the
   * caller's deterministic message key (backlog:fe0fe10b85d1). The timer
   * half of automatic reminder sends: the appointment sweep calls this
   * instead of sending, so the persistent enqueue IS the cross-process
   * claim — two sweeps racing queue the identical job and the second gets
   * the first's row back, never a second send. Retries, the execution-time
   * window re-check and the dead-letter queue are the outbox's own, shared
   * with human-queued sends: there is no second send path (MEM_ACC_REUSE).
   *
   * Template-only by construction, like the `channel-template-send@1` seam:
   * there is no text field, an unapproved template is refused by the adapter
   * before anything is queued, and the payload carries routing and content
   * only (the secret resolves at execution time). The caller's actor is
   * recorded for audit: automatic sends arrive under the timer's system
   * actor, human ones under their user actor.
   */
  async function queueTemplateSend(params) {
    const actor = params?.actor;
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const template = params?.template;
    const rawMessage = {
      to: params?.to,
      template: {
        name: template?.name,
        ...(template?.language === undefined || template?.language === null || template?.language === ''
          ? {} : { language: template.language }),
        ...(template?.variables === undefined ? { variables: [] } : { variables: template.variables }),
      },
    };
    const message = normalizeOutboundMessage(adapter, spaceId, connection, rawMessage);
    if (message.kind !== 'template') {
      throw new AppError('This queue sends approved templates only', {
        code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
      });
    }
    const messageKey = typeof params?.messageKey === 'string' && params.messageKey !== ''
      ? params.messageKey : null;
    if (!messageKey) {
      throw new ValidationError('queueTemplateSend needs a deterministic messageKey', { field: 'messageKey' });
    }
    const idempotencyKey = channelSendIdempotencyKey({ spaceId, connectionKey: connection.sourceKey, messageKey });
    let job;
    try {
      job = await jobs().enqueue({
        kind: CHANNEL_SEND_KIND,
        handler: { name: CHANNEL_SEND_HANDLER, contract: CHANNEL_SEND_CONTRACT, version: CHANNEL_SEND_VERSION },
        payload: { spaceId, connectionKey: connection.sourceKey, idempotencyKey, message },
        idempotencyRoot: idempotencyKey,
        outcomeReference: idempotencyKey,
        recoveryPolicy: 'reconcilable_at_least_once',
        ...(typeof params?.scheduleAt === 'string' && params.scheduleAt !== '' ? { scheduleAt: params.scheduleAt } : {}),
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

  function requireReplyGate() {
    if (!permissionGate) {
      throw new AppError('Channel replies need the composed space-permission-gate@1 capability', {
        code: 'CHANNEL_REPLY_GATE_MISSING', status: 500,
      });
    }
    return permissionGate;
  }

  /**
   * Resolve the connection a reply sends through. An explicit key wins and
   * stays space-scoped (a key of another space is not found, never
   * forbidden); otherwise the space's single active connection for the
   * preferred channel answers. Zero or several matches refuse with a typed
   * code so the caller names the connection instead of guessing.
   */
  function resolveReplyConnection(spaceId, { connectionKey = null, channel = null } = {}) {
    if (typeof connectionKey === 'string' && connectionKey !== '') {
      return requireActiveConnection(spaceId, connectionKey);
    }
    if (typeof channel !== 'string' || channel.trim() === '') {
      throw new ValidationError('a reply names its connectionKey or its channel', { field: 'channel' });
    }
    const matches = connections()
      .listWhere({ spaceId: assertSpaceId(spaceId) })
      .filter((row) => row && row.channel === channel && row.status === 'active');
    if (matches.length === 0) {
      throw new AppError(`No active ${channel} connection in this space`, {
        code: 'CHANNEL_REPLY_NO_CONNECTION', status: 404,
      });
    }
    if (matches.length > 1) {
      throw new AppError(`Several active ${channel} connections in this space: name the connectionKey`, {
        code: 'CHANNEL_REPLY_AMBIGUOUS_CHANNEL', status: 409,
      });
    }
    return matches[0];
  }

  /**
   * Escape one reply-key component so the tuple join stays injective. Same
   * shape as the channels `boundedKey` (MEM_ACC_REUSE): `%` first, then
   * `:` — a separator inside a component (a nested connection key, a long
   * caller message key) can never collide with the real separator.
   */
  function escapeReplyPart(value) {
    return value.replace(/%/g, '%25').replace(/:/g, '%3A');
  }

  /**
   * Reverse `escapeReplyPart`. `%3A` first, then `%25`, so an original
   * `%3A` text (escaped as `%253A`) round-trips instead of double-decoding.
   */
  function unescapeKeyPart(value) {
    return String(value).replace(/%3A/g, ':').replace(/%25/g, '%');
  }

  /**
   * The reply identity the approval binds:
   * `reply:<connection>:<to>:<key>:<text-hash>`, each free-charset
   * component escaped so the join stays injective and always parses back
   * into the same 5-part tuple. Deliberately NOT `boundedKey`: that helper
   * replaces >128-char components with `sha256:<hex>` (which adds a `:`)
   * and folds >256-char joins to 2 parts, so longer-but-legal inputs never
   * round-tripped — the proposal was recorded, then every later send and
   * read refused and the reply stuck forever. The text fingerprint binds
   * the approved bytes themselves: a summary changed after the human ok no
   * longer reproduces the key, so the approved send refuses instead of
   * sending something the human did not see. The proposal store holds at
   * most 256 chars, so a tuple past that bound refuses here with a typed
   * code — before anything is recorded — instead of stranding a proposal
   * no send or read can parse.
   */
  function replyActionKey(connectionKey, to, replyKey, textHash) {
    const parts = [connectionKey, to, replyKey, textHash];
    for (const part of parts) {
      if (typeof part !== 'string' || part === '' || part.length > 1024 || /[\x00-\x1f\x7f]/.test(part)) {
        throw new ValidationError('reply key parts must be bounded single-line text', { field: 'key' });
      }
    }
    const key = `reply:${parts.map(escapeReplyPart).join(':')}`;
    if (key.length > 256) {
      throw new AppError('Channel reply addresses more key than the approval record holds: shorten the message key or recipient', {
        code: 'CHANNEL_REPLY_KEY_TOO_LONG', status: 422,
      });
    }
    return key;
  }

  /** Split a reply action key back into its tuple. Fail-closed on drift. */
  function parseReplyActionKey(actionKey) {
    const parts = String(actionKey ?? '').split(':');
    if (parts.length !== 5 || parts[0] !== 'reply'
      || parts.some((part) => part === '')) {
      throw new AppError('Channel reply key is not a reply the package proposed', {
        code: 'CHANNEL_REPLY_KEY_INVALID', status: 500,
      });
    }
    const [, connectionKey, to, replyKey, textHash] = parts.map(unescapeKeyPart);
    return { connectionKey, to, replyKey, textHash };
  }

  /**
   * The reply text: the caller's draft, or the workspace LLM's ("Scrivi con
   * AI"). The adapter is used when present and refused when absent — a
   * missing adapter never falls back to canned text.
   */
  async function replyText({ spaceId, channel, to, text, useAi, aiPrompt, actor }) {
    if (typeof text === 'string' && text !== '') {
      if (text.trim() === '' || text.length > CHANNEL_REPLY_TEXT_MAX) {
        throw new ValidationError(`reply text must be non-empty text of at most ${CHANNEL_REPLY_TEXT_MAX} characters`, {
          field: 'text',
        });
      }
      return text;
    }
    if (useAi !== true) {
      throw new ValidationError('a reply carries text or useAi, never neither', { field: 'text' });
    }
    if (!llm) {
      throw new AppError('No workspace AI adapter is composed: draft the reply text instead', {
        code: 'CHANNEL_LLM_UNAVAILABLE', status: 500,
      });
    }
    const prompt = typeof aiPrompt === 'string' && aiPrompt.trim() !== ''
      ? aiPrompt.trim().slice(0, 2000)
      : `Draft a short customer-service reply for the ${channel} conversation with ${to}. Reply in the customer's language. Text only.`;
    const completion = await llm.complete({
      spaceId, purpose: 'write-assist', sources: [], actor,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
    });
    const draft = completion && typeof completion.text === 'string' ? completion.text : '';
    if (draft.trim() === '' || draft.length > CHANNEL_REPLY_TEXT_MAX) {
      throw new AppError('The workspace AI returned no usable draft', {
        code: 'CHANNEL_LLM_DRAFT_EMPTY', status: 500,
      });
    }
    return draft;
  }

  /**
   * Queue one reply send through the outbox (MEM_ACC_REUSE: the same durable
   * enqueue as every channel send). A deduped terminal job never reports
   * `queued`: the existing row already settled, so nothing will ever send —
   * the retry refuses with a typed code directing to a new round (a new
   * messageKey) instead of letting the human believe it is in consegna.
   */
  const REPLY_SETTLED_JOB_STATES = new Set(['succeeded', 'failed_terminal', 'cancelled']);
  async function queueReplySend({ spaceId, connectionKey, message, messageKey, actor }) {
    const queued = await queueChannelSend({ spaceId, connectionKey, message, messageKey, actor });
    const job = await jobs().get(queued.jobId);
    if (job && REPLY_SETTLED_JOB_STATES.has(job.state)) {
      throw new AppError(`This reply already settled as ${job.state}: propose a new round with a new messageKey`, {
        code: 'CHANNEL_REPLY_SEND_SETTLED', status: 409,
        details: { jobId: queued.jobId, jobState: job.state },
      });
    }
    return queued;
  }

  /**
   * Propose one human reply (BO-F1-07). The gate's own `propose` is the
   * single decision point: with `send-without-approval` on in this space it
   * throws `SPACE_PERMISSION_ENABLED` and the reply queues through the
   * outbox at once (`queued`); with the switch off (the default) the reply
   * waits as a `space-ai-proposal` row (`pending-approval`) and nothing is
   * enqueued — the provider sees nothing until a human approves and the
   * approved send runs. There is deliberately no `gate()` pre-read on this
   * path: an allow verdict read before the enqueue would go stale on an
   * on-to-off flip and bypass approval; the enqueue decision always rests
   * on the gate's own fresh verdict inside `propose`.
   */
  async function proposeReply(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const gate = requireReplyGate();
    const connection = resolveReplyConnection(spaceId, {
      connectionKey: params?.connectionKey ?? null,
      channel: params?.channel ?? null,
    });
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const draft = await replyText({
      spaceId, channel: connection.channel, to: params?.to, text: params?.text,
      useAi: params?.useAi, aiPrompt: params?.aiPrompt, actor,
    });
    const rawMessage = { to: params?.to, text: draft };
    const message = normalizeOutboundMessage(adapter, spaceId, connection, rawMessage);
    const replyKey = typeof params?.messageKey === 'string' && params.messageKey !== ''
      ? params.messageKey
      : fingerprintPayload(JSON.stringify(message));
    const actionKey = replyActionKey(
      connection.sourceKey, message.to, replyKey, fingerprintPayload(message.text),
    );
    let proposed;
    try {
      proposed = await gate.propose({
        spaceId, permission: CHANNEL_REPLY_PERMISSION,
        actionKind: CHANNEL_REPLY_ACTION_KIND, actionKey, summary: message.text, actor,
      });
    } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'SPACE_PERMISSION_ENABLED') {
        // The space allows unattended sends: send at once, with no proposal
        // row. The lifecycle still reads back through the returned jobId or
        // idempotencyKey.
        const queued = await queueReplySend({
          spaceId, connectionKey: connection.sourceKey, message, messageKey: replyKey, actor,
        });
        return {
          state: 'queued', proposalId: null, replayed: false,
          connectionKey: connection.sourceKey, channel: connection.channel, to: message.to,
          jobId: queued.jobId, idempotencyKey: queued.idempotencyKey,
        };
      }
      throw error;
    }
    return {
      state: 'pending-approval', proposalId: proposed.proposalId, replayed: proposed.replayed === true,
      connectionKey: connection.sourceKey, channel: connection.channel, to: message.to,
      idempotencyKey: channelSendIdempotencyKey({
        spaceId, connectionKey: connection.sourceKey, messageKey: replyKey,
      }),
    };
  }

  /**
   * Send one approved reply. The proposal authorizes exactly the bytes it
   * carries: the text sends verbatim from the approved row (re-normalized
   * through the adapter, which must reproduce the approved text), and the
   * recomputed action key must equal the proposal's — any drift refuses
   * instead of sending something the human did not see.
   */
  async function sendApprovedReply(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const gate = requireReplyGate();
    const proposalId = typeof params?.proposalId === 'string' && params.proposalId !== ''
      ? params.proposalId
      : null;
    if (!proposalId) {
      throw new ValidationError('sendApprovedReply needs the approved proposalId', { field: 'proposalId' });
    }
    const row = await gate.proposal(spaceId, proposalId);
    if (!row) {
      throw new AppError('Unknown reply proposal', { code: 'CHANNEL_REPLY_UNKNOWN', status: 404 });
    }
    if (row.permission !== CHANNEL_REPLY_PERMISSION || row.actionKind !== CHANNEL_REPLY_ACTION_KIND) {
      throw new AppError('This proposal is not a channel reply', { code: 'CHANNEL_REPLY_MISMATCH', status: 409 });
    }
    if (row.status === 'refused') {
      throw new AppError('This reply was refused: it never sends', { code: 'CHANNEL_REPLY_REFUSED', status: 409 });
    }
    if (row.status !== 'approved') {
      throw new AppError('This reply still waits for a human ok', { code: 'CHANNEL_REPLY_NOT_APPROVED', status: 409 });
    }
    const routed = parseReplyActionKey(row.actionKey);
    const connection = requireActiveConnection(spaceId, routed.connectionKey);
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const message = normalizeOutboundMessage(adapter, spaceId, connection, { to: routed.to, text: row.summary });
    if (message.text !== row.summary || fingerprintPayload(message.text) !== routed.textHash) {
      throw new AppError('The approved text changed after the human ok: re-propose the reply', {
        code: 'CHANNEL_REPLY_TEXT_DRIFT', status: 409,
      });
    }
    const recomputed = replyActionKey(
      connection.sourceKey, message.to, routed.replyKey, fingerprintPayload(message.text),
    );
    if (recomputed !== row.actionKey) {
      throw new AppError('The approved reply no longer addresses its connection: re-propose the reply', {
        code: 'CHANNEL_REPLY_KEY_INVALID', status: 409,
      });
    }
    const queued = await queueReplySend({
      spaceId, connectionKey: connection.sourceKey, message, messageKey: routed.replyKey, actor,
    });
    return {
      state: 'queued', proposalId: row.id ?? proposalId,
      connectionKey: connection.sourceKey, channel: connection.channel, to: message.to,
      jobId: queued.jobId, idempotencyKey: queued.idempotencyKey,
    };
  }

  /**
   * Project one reply send onto the lifecycle the backoffice card shows —
   * shared by the proposal read and the proposal-less read below, so both
   * keys report the same queued / sent / failed from the same rows.
   */
  function replySendRead({ spaceId, job, idempotencyKey, base }) {
    if (!job) {
      return { ...base, state: 'approved', idempotencyKey };
    }
    const letter = letters().listWhere({ spaceId, sourceKey: boundedKey('ch-dl', idempotencyKey) })[0] ?? null;
    const sendState = jobSendState({ jobState: job.state, letterState: letter?.state ?? null });
    if (sendState === 'sent') {
      return {
        ...base, state: 'sent', idempotencyKey,
        jobId: job.id, attempts: job.attempt ?? 1,
      };
    }
    if (sendState === 'failed' || sendState === 'dead-letter') {
      return { ...base, state: 'failed', idempotencyKey, jobId: job.id };
    }
    return { ...base, state: 'queued', idempotencyKey, jobId: job.id };
  }

  /**
   * Read one reply's lifecycle state for the backoffice card: waiting for
   * the ok, approved, in consegna (the outbox job exists), consegnato (the
   * provider receipt is in), failed, or refused.
   *
   * Exactly one key: the proposal id for the gated path, or — for the
   * switch-on path, which records no proposal row — the jobId or
   * idempotencyKey the propose call handed back. The job lookup is always
   * exact (by id or by idempotency root, the same rows the worker settles),
   * never a newest-N window scan that forgets older sends.
   */
  async function readReply(params) {
    const spaceId = assertSpaceId(params?.spaceId);
    const gate = requireReplyGate();
    const proposalId = typeof params?.proposalId === 'string' && params.proposalId !== ''
      ? params.proposalId
      : null;
    const jobId = typeof params?.jobId === 'string' && params.jobId !== ''
      ? params.jobId
      : null;
    const idempotencyKey = typeof params?.idempotencyKey === 'string' && params.idempotencyKey !== ''
      ? params.idempotencyKey
      : null;
    if ((proposalId ? 1 : 0) + (jobId ? 1 : 0) + (idempotencyKey ? 1 : 0) !== 1) {
      throw new ValidationError('readReply needs exactly one of proposalId, jobId or idempotencyKey', {
        field: 'proposalId',
      });
    }
    if (proposalId) {
      const row = await gate.proposal(spaceId, proposalId);
      if (!row) {
        throw new AppError('Unknown reply proposal', { code: 'CHANNEL_REPLY_UNKNOWN', status: 404 });
      }
      if (row.permission !== CHANNEL_REPLY_PERMISSION || row.actionKind !== CHANNEL_REPLY_ACTION_KIND) {
        throw new AppError('This proposal is not a channel reply', { code: 'CHANNEL_REPLY_MISMATCH', status: 409 });
      }
      const routed = parseReplyActionKey(row.actionKey);
      const connection = getConnection(spaceId, routed.connectionKey);
      const base = {
        proposalId: row.id ?? proposalId,
        connectionKey: routed.connectionKey,
        channel: connection?.channel ?? null,
        to: routed.to,
      };
      if (row.status === 'refused') {
        return {
          ...base, state: 'refused',
          decidedBy: row.decidedBy ?? null, decidedAt: row.decidedAt ?? null,
          refusalReason: row.refusalReason ?? null,
        };
      }
      if (row.status !== 'approved') {
        return { ...base, state: 'pending-approval' };
      }
      const key = channelSendIdempotencyKey({
        spaceId, connectionKey: routed.connectionKey, messageKey: routed.replyKey,
      });
      const job = await jobs().getByRoot(key);
      return replySendRead({ spaceId, job, idempotencyKey: key, base });
    }
    // Proposal-less sends (the switch-on path records no proposal row):
    // the job the propose call handed back is the lifecycle. The job store
    // is bound to the deployment tenant, not the space, so the payload's
    // space must match — a key of another space is not found, never
    // forbidden.
    const job = jobId ? await jobs().get(jobId) : await jobs().getByRoot(idempotencyKey);
    const payload = job && job.payload && typeof job.payload === 'object' ? job.payload : null;
    if (!job || !payload || payload.spaceId !== spaceId) {
      throw new AppError('Unknown channel reply send', { code: 'CHANNEL_REPLY_UNKNOWN', status: 404 });
    }
    const routedKey = typeof payload.connectionKey === 'string' ? payload.connectionKey : '';
    const connection = routedKey !== '' ? getConnection(spaceId, routedKey) : null;
    const to = payload.message && typeof payload.message === 'object' && typeof payload.message.to === 'string'
      ? payload.message.to
      : null;
    return replySendRead({
      spaceId,
      job,
      idempotencyKey: typeof job.idempotencyRoot === 'string' ? job.idempotencyRoot : idempotencyKey,
      base: {
        proposalId: null,
        connectionKey: routedKey === '' ? null : routedKey,
        channel: connection?.channel ?? null,
        to,
      },
    });
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
        // Time-of-check equals time-of-use for windowed adapters (Meta's
        // 24h): a job queued inside the window but executed after it —
        // backoff, retry, worker delay — must not send free text outside
        // it. The window is re-resolved server-side from the inbox, exactly
        // like at queue time; an expired job lands in the dead letter with
        // the template code (window closed, send a template instead).
        // Templates bypass the window by contract, so only free text can
        // refuse here. Adapters without the capability send as before.
        if (adapter.outboundWindow) {
          try {
            await adapter.normalizeOutbound(message, {
              lastInboundAt: resolveWindowObservation(spaceId, connectionKey, message, adapter.outboundWindow),
            });
          } catch (error) {
            const code = error && typeof error === 'object'
              && /** @type {any} */ (error).code === 'CHANNEL_TEMPLATE_REQUIRED'
              ? 'CHANNEL_TEMPLATE_REQUIRED'
              : 'CHANNEL_MESSAGE_MALFORMED';
            return failTerminal(code);
          }
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

  /**
   * Requeue one open dead letter with a human-supplied message (backlog:560ff58370a8).
   * The letter carries no payload by design, so retrying means approving the
   * content again — a human actor owns it, and the new job gets a
   * deterministic key derived from the letter AND the new message
   * (boundedKey, always within the 256-char outbox bound), so the same
   * content dedups and different content keys differently. A settled letter
   * 404s on repeat: one letter, one provider send.
   *
   * Claim-first, never enqueue-first: the letter moves `open` -> `requeued`
   * through advanceLetter (one chain slot, one durable unit, one fresh
   * re-read — conditioned on the state read, never on a stale copy) BEFORE
   * any job exists, and the new job is enqueued only for the winner, in the
   * SAME unit as the claim: the two commit together or roll back together,
   * so no failure between them leaves a claimed letter without its send. A
   * concurrent requeue reads the winner's state and is refused with
   * CHANNEL_LETTER_UNKNOWN before creating anything: the winner's job is
   * never touched — no cancel path exists anywhere here, because an
   * idempotent enqueue can hand the loser the winner's own job.
   */
  async function requeueChannelLetter(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    // Exact read by id, then the space check: a letter from another space is
    // not found (404), never forbidden (403).
    let letter = null;
    try {
      letter = typeof params?.letterId === 'string' && params.letterId !== ''
        ? letters().get(params.letterId) : null;
    } catch {
      letter = null;
    }
    if (!letter || letter.spaceId !== spaceId) {
      throw new AppError('Unknown or settled dead letter', { code: 'CHANNEL_LETTER_UNKNOWN', status: 404 });
    }
    // A settled letter is not found (404), never a transition refusal: the
    // API contract reports unknown-or-settled, and the machine below keeps
    // the same answer for a race that settles between this read and the
    // claim.
    if (letter.state !== 'open') {
      throw new AppError('Unknown or settled dead letter', { code: 'CHANNEL_LETTER_UNKNOWN', status: 404 });
    }
    // The job-side edge of the same move: an open letter IS a send in
    // `dead-letter`, and only `requeue` leaves it. Both tables gate this
    // path, so a future row shape that drifts from the machine breaks loudly
    // here instead of sending from a state the machine forbids.
    assertJobTransition(jobSendState({ letterState: letter.state }), 'requeue');
    const connection = requireActiveConnection(spaceId, letter.connectionKey);
    const { definition: adapter } = registries.getAdapter(connection.adapter, connection.adapterVersion);
    const message = normalizeOutboundMessage(adapter, spaceId, connection, params?.message);
    const messageFingerprint = fingerprintPayload(JSON.stringify(message));
    const idempotencyKey = boundedKey('ch-send', spaceId, connection.sourceKey, `requeue:${letter.id}`, messageFingerprint);
    // The claim carries the intended send identity either way: where the
    // store opens no durable unit, the follow-up still runs in the same
    // chain slot right after the move, and the root names the job that
    // should exist so the gap stays observable.
    const stateReason = `human retry by ${actorId(actor)} as ${idempotencyKey}`;
    const letterService = letters();
    let moved;
    try {
      moved = await advanceLetter({ letters: letterService, database }, letter.id, {
        event: 'requeue',
        patch: { stateReason },
        actor,
        write: async ({ transaction }) => {
          try {
            const job = await jobs().enqueue({
              kind: CHANNEL_SEND_KIND,
              handler: { name: CHANNEL_SEND_HANDLER, contract: CHANNEL_SEND_CONTRACT, version: CHANNEL_SEND_VERSION },
              payload: { spaceId, connectionKey: connection.sourceKey, idempotencyKey, message },
              idempotencyRoot: idempotencyKey,
              outcomeReference: idempotencyKey,
              recoveryPolicy: 'reconcilable_at_least_once',
              maxAttempts: maxSendAttempts,
            }, transaction ? { transaction, actor } : { actor });
            return { jobId: job.id, idempotencyKey };
          } catch (error) {
            if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DURABLE_JOB_PAYLOAD_INVALID') {
              throw new AppError('Channel message is not well-formed: message refused by the outbox payload controls', {
                code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
              });
            }
            throw error;
          }
        },
      });
    } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'CHANNEL_TRANSITION_INVALID') {
        throw new AppError('Unknown or settled dead letter', { code: 'CHANNEL_LETTER_UNKNOWN', status: 404 });
      }
      throw error;
    }
    return { jobId: moved.wrote.jobId, letterId: moved.letter.id, idempotencyKey: moved.wrote.idempotencyKey };
  }

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
    queueTemplateSend,
    requeueChannelLetter,
    proposeReply,
    sendApprovedReply,
    readReply,
    registerChannelSendHandlers,
    startInitialImport,
    advanceInitialImport,
    readInitialImport,
    readSyncState,
    readSyncActivity,
    syncNowChannel,
  });
}
