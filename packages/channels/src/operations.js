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
import { transitionInbox } from './transitions.js';

/**
 * Channel operations (backlog:e5532d1c9146).
 *
 * The application-scoped entry points a deployment (and the kit) drives:
 * register a connection, ingest a verified webhook, queue a send through
 * the durable-jobs outbox, work the dead-letter queue, and run the
 * progressive initial history import (start one bounded page at a time,
 * read its progress) for adapters that declare readable past. Reads are
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
 * Sender outcomes the import ledger records. `pending` means the row is
 * stored (and counted when new) but its sender is not resolved yet — the
 * retry resolves and counts only the sender. Every other value means the
 * event's outcome is fully counted and the retry must skip it.
 */
const IMPORT_SENDER_OUTCOMES = new Set(['created', 'matched', 'unresolved', 'none', 'pending']);

/**
 * Decode the import row's recovery ledger to provider id → outcome. Unknown
 * or malformed content decodes as empty and is overwritten by the next
 * commit: the ledger is written only by this package, so anything
 * unreadable is operator surgery, and refusing the import over it would
 * brick the run with no writer left to heal it.
 * @param {unknown} value
 * @returns {Map<string, {row: 'imported'|'duplicate', sender: string}>}
 */
function decodeImportLedger(value) {
  const ledger = new Map();
  if (typeof value !== 'string' || value === '') return ledger;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return ledger;
  }
  if (!Array.isArray(parsed)) return ledger;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { id, row, sender } = /** @type {{id?: unknown, row?: unknown, sender?: unknown}} */ (entry);
    if (typeof id !== 'string' || id === '' || id.length > 256) continue;
    if (row !== 'imported' && row !== 'duplicate') continue;
    if (typeof sender !== 'string' || !IMPORT_SENDER_OUTCOMES.has(sender)) continue;
    if (!ledger.has(id)) ledger.set(id, { row, sender });
  }
  return ledger;
}

/**
 * Merge this attempt's outcomes over the freshly re-read ledger: entries
 * this attempt processed replace older ones, entries it skipped (already
 * counted by an earlier attempt) survive. Null when empty, so a clean page
 * leaves no recovery state behind.
 */
function encodeImportLedger(previous, outcomes) {
  const merged = new Map(previous);
  for (const entry of outcomes) merged.set(entry.id, { row: entry.row, sender: entry.sender });
  if (merged.size === 0) return null;
  return JSON.stringify([...merged.entries()].map(([id, outcome]) => ({ id, row: outcome.row, sender: outcome.sender })));
}

/** @param {Record<string, string>} [config] */
function resolvedNames(config = {}) {
  return {
    connection: config.connectionModule ?? 'channel-connection',
    inbox: config.inboxModule ?? 'channel-inbox-event',
    letter: config.letterModule ?? 'channel-dead-letter',
    importState: config.importStateModule ?? 'channel-import-state',
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
   * The same provider message in the other path's envelope: normalized
   * identity agrees, and either this call imports (it knows the envelope
   * differs) or the stored row does (it carries the import marker).
   * Anything else with different bytes stays a 409 — the webhook contract
   * does not move.
   */
  function sameImportEvent(already, item, imported) {
    if (!imported && already.effectReason !== CHANNEL_IMPORT_ROW_REASON) return false;
    return already.providerEventId === item.providerEventId
      && (already.subject ?? '') === (item.subject ?? '')
      && already.sequence === item.sequence
      && already.occurredAt === item.occurredAt;
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
   * `imported` marks history-path calls: the same message listed from the
   * provider past never shares the webhook bytes, so an import adopts the
   * stored row when the normalized identity agrees instead of 409ing on
   * the envelope — and import-stored applied rows earn the same adoption
   * from later webhooks through their marker.
   */
  async function storeInboxItem(service, {
    spaceId, connection, adapter, item, payloadFingerprint, actor, now, imported = false,
  }) {
    const already = service.listWhere({ sourceKey: item.sourceKey })[0];
    if (already) {
      if (already.payloadFingerprint !== payloadFingerprint) {
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
      const resumed = await transitionInbox(service, already.id, {
        event: transition,
        patch: { effectReason: decision.effectReason === '' ? 'redelivery resumed the received row' : decision.effectReason },
        actor,
      });
      return { duplicate: false, resumed: true, eventId: resumed.id, effect: resumed.effect };
    }

    const baseRow = {
      sourceKey: item.sourceKey, spaceId, connectionKey: connection.sourceKey,
      adapter: adapter.name, adapterVersion: adapter.version,
      providerEventId: item.providerEventId, subject: item.subject, payloadFingerprint,
      sequence: item.sequence, occurredAt: item.occurredAt, receivedAt: now,
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
      // payload is CHANNEL_EVENT_ID_CONFLICT 409 on every path.
      const raced = service.listWhere({ sourceKey: item.sourceKey })[0];
      if (raced) {
        if (raced.payloadFingerprint === payloadFingerprint) {
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
    const now = nowIso();
    const receiveMs = Date.parse(now);
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
   * The progress surface the pilot reads: counts only, never the provider
   * cursor (opaque, server-side) and never sender addresses (they live in
   * the customer-data identity rows, not in a progress report).
   */
  function importStateSummary(row) {
    return Object.freeze({
      spaceId: row.spaceId,
      connectionKey: row.connectionKey,
      adapter: row.adapter,
      adapterVersion: row.adapterVersion,
      status: row.status,
      windowStart: row.windowStart,
      importedEvents: row.importedEvents,
      duplicateEvents: row.duplicateEvents,
      matchedContacts: row.matchedContacts,
      createdContacts: row.createdContacts,
      unresolvedContacts: row.unresolvedContacts,
      eventsWithoutSender: row.eventsWithoutSender,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      lastErrorCode: row.lastErrorCode,
      lastErrorReason: row.lastErrorReason,
    });
  }

  function importSourceKey(spaceId, connectionKey) {
    return boundedKey('ch-imp', spaceId, connectionKey);
  }

  function findImportState(spaceId, connectionKey) {
    return importStates().listWhere({ sourceKey: importSourceKey(spaceId, connectionKey) })[0] ?? null;
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

  function requireSenderResolution() {
    if (!resolveSender) {
      throw new AppError('Channel initial import needs the composed channel-sender@1 capability: compose the package with the customer-data definition', {
        code: 'CHANNEL_SENDER_UNAVAILABLE', status: 409,
      });
    }
    return resolveSender;
  }

  /**
   * Start the progressive initial import of one connection's provider past.
   * A human decision (connecting the channel): the actor is required, like
   * registration. Records the window the adapter declares and the cursor to
   * resume from; pulling starts with the first advance call. Restarting a
   * running import resumes it; a completed one refuses — a refresh is a new
   * voice, not a silent re-import.
   */
  async function startInitialImport(params) {
    const actor = requireUser(params?.actor);
    const spaceId = assertSpaceId(params?.spaceId);
    const connectionKey = typeof params?.connectionKey === 'string' ? params.connectionKey : '';
    const connection = requireActiveConnection(spaceId, connectionKey);
    const adapter = requireHistoryAdapter(connection);
    requireSenderResolution();
    const sourceKey = importSourceKey(spaceId, connection.sourceKey);
    const existing = importStates().listWhere({ sourceKey })[0];
    if (existing) {
      if (existing.status === 'done') {
        throw new AppError('Initial import already completed for this connection', {
          code: 'CHANNEL_IMPORT_COMPLETE', status: 409,
        });
      }
      return { resumed: true, started: false, state: importStateSummary(existing) };
    }
    const now = nowIso();
    const row = await importStates().createManaged({
      sourceKey,
      spaceId,
      connectionKey: connection.sourceKey,
      adapter: adapter.name,
      adapterVersion: adapter.version,
      status: 'running',
      windowStart: new Date(Date.parse(now) - adapter.historyImport.windowMs).toISOString(),
      nextPageToken: null,
      importedEvents: 0,
      duplicateEvents: 0,
      matchedContacts: 0,
      createdContacts: 0,
      unresolvedContacts: 0,
      eventsWithoutSender: 0,
      startedAt: now,
      finishedAt: null,
      lastErrorCode: null,
      lastErrorReason: null,
      processedEvents: null,
    }, { actor });
    return { resumed: false, started: true, state: importStateSummary(row) };
  }

  /**
   * Pull one bounded history page and reconcile it. Mechanical work the
   * scheduler repeats until done, so it runs under the package system
   * actor: a caller-supplied actor is ignored, never trusted for audit
   * attribution — the same discipline as provider-driven ingest.
   *
   * Crash-safe by per-event outcomes, not by one big transaction: every
   * processed event records its outcome (row stored or duplicate, sender
   * created/matched/unresolved, none, or pending) in the import row's
   * ledger next to the running counters. A page that aborts commits what
   * its completed events earned and keeps the cursor, so the retry skips
   * already-counted events and replays to the same rows and the same
   * counts as a clean run. Sender resolution itself stays autonomous —
   * its own transactions, never nested in the page's: the ledger records
   * which outcomes are already counted, so the retry skips those events
   * and finishes only what the failed attempt left pending.
   * The state cursor moves only after the whole page reconciled.
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
    const resolve = requireSenderResolution();
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
    const now = nowIso();
    const receiveMs = Date.parse(now);
    const done = checked.nextPageToken === null;
    const commitKey = importSourceKey(spaceId, connection.sourceKey);
    const counts = {
      imported: 0, duplicates: 0, matched: 0, created: 0, unresolved: 0, withoutSender: 0,
    };
    /** @type {Array<{id: string, row: 'imported'|'duplicate', sender: string}>} */
    const outcomes = [];

    const tallySenderOutcome = (answer) => {
      if (answer.outcome === 'matched') { counts.matched += 1; return 'matched'; }
      if (answer.outcome === 'created') { counts.created += 1; return 'created'; }
      counts.unresolved += 1;
      return 'unresolved';
    };

    const processPage = async (recovered) => {
      for (const event of checked.events) {
        const covered = recovered.get(event.providerEventId);
        if (covered && covered.sender !== 'pending') {
          // An earlier attempt of this page already stored this row and
          // counted its outcome: replaying it must not tally again. Rows are
          // never deleted by any package path, so the row is still there.
          continue;
        }
        // A pending replay finishes an event the failed attempt stored but
        // never resolved: its row is already counted, so only a genuinely
        // new store tallies a row below — the sender resolution always does.
        const pendingOnly = covered?.sender === 'pending';
        const item = toInboxItem(event, {
          spaceId, connectionKey: connection.sourceKey, now, receiveMs,
        });
        const stored = await storeInboxItem(service, {
          spaceId,
          connection,
          adapter,
          item,
          payloadFingerprint: fingerprintPayload(JSON.stringify(event)),
          actor,
          now,
          imported: true,
        });
        const rowOutcome = stored.duplicate ? (covered?.row ?? 'duplicate') : 'imported';
        if (!pendingOnly || !stored.duplicate) {
          if (stored.duplicate) counts.duplicates += 1;
          else counts.imported += 1;
        }
        // A replayed row keeps its evidence, but an applied row's sender is
        // still reconciled: the first store may have been a webhook — which
        // never resolves senders — or a crash may have landed between the
        // inbox write and the resolution. Resolution is idempotent, so the
        // replay converges instead of doubling.
        // Quarantined or set-aside items stay evidence: no contact is ever
        // invented from a row the package refused to apply.
        if (stored.effect !== 'applied' || !event.sender) {
          if (stored.effect === 'applied') counts.withoutSender += 1;
          outcomes.push({ id: event.providerEventId, row: rowOutcome, sender: 'none' });
          continue;
        }
        let answer;
        try {
          answer = await resolve({
            channel: adapter.channel,
            handle: event.sender.handle,
            ...(event.sender.email === undefined ? {} : { email: event.sender.email }),
            ...(event.sender.firstName === undefined ? {} : { firstName: event.sender.firstName }),
            ...(event.sender.lastName === undefined ? {} : { lastName: event.sender.lastName }),
            actor,
          });
        } catch (error) {
          // Malformed sender evidence names nobody: the message is kept, the
          // contact is not invented, and the count says so. Anything else is
          // genuine — the outcome stays pending so the retry resolves (and
          // counts) only the sender, and the abort below carries no error
          // text: it may echo provider-controlled secrets or PII.
          if (error instanceof ValidationError) {
            counts.withoutSender += 1;
            outcomes.push({ id: event.providerEventId, row: rowOutcome, sender: 'none' });
            continue;
          }
          outcomes.push({ id: event.providerEventId, row: rowOutcome, sender: 'pending' });
          throw error;
        }
        outcomes.push({ id: event.providerEventId, row: rowOutcome, sender: tallySenderOutcome(answer) });
      }
    };

    // One managed write carries a commit's counters, cursor move, failure
    // stamp, and ledger together, so tallies and the ledger can never drift
    // apart: the retry replays exactly what the last commit recorded.
    const commitTallies = (fresh, patch) => importStates().applyManaged(row.id, {
      importedEvents: fresh.importedEvents + counts.imported,
      duplicateEvents: fresh.duplicateEvents + counts.duplicates,
      matchedContacts: fresh.matchedContacts + counts.matched,
      createdContacts: fresh.createdContacts + counts.created,
      unresolvedContacts: fresh.unresolvedContacts + counts.unresolved,
      eventsWithoutSender: fresh.eventsWithoutSender + counts.withoutSender,
      ...patch,
    }, { actor });

    let commitTransaction = null;
    if (database && typeof database.transactionAsync === 'function') {
      let proof = null;
      try {
        proof = proveCallerTransaction([{ database }]);
      } catch {
        proof = null;
      }
      if (proof === TRANSACTION_PROOF.NO_TRANSACTION) {
        commitTransaction = (critical) => database.transactionAsync(critical);
      }
    }
    // The single managed write is already atomic on one connection; the
    // transaction below keeps two processes from interleaving a re-read
    // between them. Same proof idiom as the ingest batch above.
    const transact = commitTransaction ?? ((critical) => critical());
    // Processing and both commits run in one serialized slot per import: an
    // advance racing this one's page window commits first, and this one adds
    // to the winner's counters instead of overwriting them with the snapshot
    // read before the provider call. A page that aborts commits only what
    // its completed events earned — the cursor never moves on failure — so
    // the retry replays the same page from the ledger.
    const updated = await withImportCommit(commitKey, async () => {
      // Re-read inside the slot: a racing advance may have committed a
      // partial page (ledger plus counters) while this one fetched its
      // page from the provider. Replaying from the live ledger keeps the
      // loser from tallying the winner's events twice or wiping them.
      const live = findImportState(spaceId, connection.sourceKey) ?? row;
      // Outcomes a failed attempt of this same page already counted: the
      // retry replays those events to the same rows but never tallies them
      // twice, so it converges to the same counts as a clean run.
      const recovered = decodeImportLedger(live.processedEvents);
      try {
        await processPage(recovered);
      } catch (error) {
        // Package-own aborts keep their code and travel unchanged (their
        // messages are static); anything provider-adjacent is rethrown with
        // the same code and a fixed message, never the original text.
        const owned = error instanceof AppError
          && (error.code === 'CHANNEL_EVENT_ID_CONFLICT' || error.code === 'CHANNEL_EVENT_MALFORMED');
        const code = owned ? error.code : importFailureCode(error, 'CHANNEL_HISTORY_UNAVAILABLE');
        const fresh = findImportState(spaceId, connection.sourceKey) ?? row;
        try {
          await transact(() => commitTallies(fresh, {
            lastErrorCode: code,
            lastErrorReason: CHANNEL_IMPORT_PAGE_FAILED_NOTE,
            processedEvents: encodeImportLedger(decodeImportLedger(fresh.processedEvents), outcomes),
          }));
        } catch {
          // The page already failed: a storage outage while committing the
          // partial counts must not replace the failure the caller retries
          // on. The next advance replays from the last committed ledger,
          // which is still consistent with its counters.
        }
        if (owned) throw error;
        const normalized = normalizeError(error);
        throw new AppError('Import page failed before completion: retry the advance', {
          code, status: normalized instanceof AppError ? normalized.status : 500,
        });
      }
      const fresh = findImportState(spaceId, connection.sourceKey) ?? row;
      return transact(() => commitTallies(fresh, {
        nextPageToken: checked.nextPageToken,
        ...(done ? { status: 'done', finishedAt: now } : {}),
        lastErrorCode: null,
        lastErrorReason: null,
        processedEvents: null,
      }));
    });
    return {
      done,
      state: importStateSummary(updated),
      page: Object.freeze({ ...counts }),
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
    const nowMs = Date.now();
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
      if (ms > nowMs + CHANNEL_INGEST_FUTURE_SKEW_MS) continue;
      if (latest === null || ms > latest) latest = ms;
    }
    return latest === null ? null : new Date(latest).toISOString();
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
    // Resolved outside the normalize try: a storage failure here is a 500
    // of its own, never a malformed message.
    const windowCtx = adapter.outboundWindow
      ? {
        lastInboundAt: resolveWindowObservation(
          spaceId, connection.sourceKey, params?.message, adapter.outboundWindow,
        ),
      }
      : undefined;
    try {
      message = adapter.outboundWindow
        ? adapter.normalizeOutbound(params?.message, windowCtx)
        : adapter.normalizeOutbound(params?.message);
    } catch (error) {
      // A window refusal is the adapter's contract with its callers (send a
      // template instead): it travels intact, never flattened into the
      // generic malformed code.
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'CHANNEL_TEMPLATE_REQUIRED') {
        throw error;
      }
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
    startInitialImport,
    advanceInitialImport,
    readInitialImport,
  });
}
