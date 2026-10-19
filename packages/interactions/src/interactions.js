// @ts-check

import {
  AppError, ConflictError, NotFoundError, TRANSACTION_PROOF, ValidationError, isCalendarDate, proveCallerTransaction,
  requireActor, optionalIsoDate,
} from '../../core/index.js';

/**
 * **Interactions — the native message and call records.**
 *
 * Three evidence records, one ownership trail, one read watermark per
 * member and one thread key per joining channel key: a **Conversation** — one
 * message thread with a customer across channels — an **Interaction message**
 * — one inbound or outbound message with its delivery state — an **Interaction
 * call** — one inbound or outbound call with its outcome and duration — a
 * **Conversation assignment** — one immutable handover event per row, whose
 * rows for one conversation are the audit trail of who owned the thread — a
 * **Conversation read** — one watermark row per conversation and member, from
 * which each member's unread count is derived — and a **Conversation thread
 * key** — one row per channel key that opened or joined the thread, so a
 * retried open under a joined key replays the joined thread instead of
 * opening a duplicate. Every row is fully managed: there is no public create
 * or update path to any of them, so a client cannot forge a message, rewrite
 * a delivery state, invent a call, steal a thread or fake having read one.
 *
 * **Reuse, not duplication (the packet's first acceptance bullet).**
 *
 * - The subject is the ADR-030 opaque envelope — `subjectResource`,
 *   `subjectId`, `subjectOwner`, `subjectOwnerPackage`, `subjectLabel` — the
 *   same shape `packages/work` and `packages/customer-data` store. Nothing
 *   here copies a contact or a company, and no customer master table is
 *   created.
 * - Customer identity (which channel handle names which record, duplicate
 *   evidence, the canonical link) stays in `packages/customer-data`
 *   (`external-identity`, `duplicate-candidate`, `read-customer-profile`).
 *   `remoteHandle` on these rows is a display snapshot taken when the row was
 *   written, never an identifier.
 * - `work-activity` stays the record of human follow-up work. This package
 *   never writes it; the timeline only *reads* it, through the runtime modules
 *   handle, so an application without the work package still boots and the
 *   timeline says so honestly instead of reporting an empty history.
 */

export const CONVERSATION_MODULE = 'conversation';
export const MESSAGE_MODULE = 'interaction-message';
export const CALL_MODULE = 'interaction-call';
export const ASSIGNMENT_MODULE = 'conversation-assignment';
export const READ_MODULE = 'conversation-read';
export const THREAD_KEY_MODULE = 'conversation-thread-key';
export const WORK_ACTIVITY_MODULE = 'work-activity';

export const INTERACTIONS_PACKAGE = 'interactions';

/** Every channel the customer's first use case names: chat apps, the site form, email and the company phones. */
export const CHANNELS = Object.freeze([
  'whatsapp', 'instagram', 'facebook', 'tiktok', 'website-form', 'email', 'phone',
]);

export const MESSAGE_DIRECTIONS = Object.freeze(['inbound', 'outbound']);

/**
 * The whole message state machine. Not a rank, not a comparison: a map from a
 * state to the states it may become, and every state that is not listed as a
 * key can become nothing.
 *
 * Inbound messages are stored as `received` and have no lifecycle — a delivery
 * state on a message the customer wrote would be a claim about the customer's
 * phone this package cannot observe. Outbound messages move `sent ->
 * delivered -> read`, with `sent -> failed` and `delivered -> failed` as the
 * only other moves. There is no reopen and no retry-in-place: a repeated send
 * is a new message under a new source key, which the idempotency rule already
 * supports.
 */
export const MESSAGE_STATES = Object.freeze(['received', 'sent', 'delivered', 'read', 'failed']);
export const MESSAGE_TRANSITIONS = Object.freeze({
  received: Object.freeze([]),
  sent: Object.freeze(['delivered', 'failed']),
  delivered: Object.freeze(['read', 'failed']),
  read: Object.freeze([]),
  failed: Object.freeze([]),
});
export const MESSAGE_TERMINAL = Object.freeze(['received', 'read', 'failed']);

export const MESSAGE_INITIAL = Object.freeze({ inbound: 'received', outbound: 'sent' });

/** A call that happened with its outcome is immutable evidence, not a lifecycle: recorded once, never transitioned. */
export const CALL_OUTCOMES = Object.freeze(['completed', 'missed', 'no-answer', 'failed']);
export const CALL_DIRECTIONS = Object.freeze(['inbound', 'outbound']);

export const CONVERSATION_STATES = Object.freeze(['open', 'closed']);
export const CONVERSATION_TRANSITIONS = Object.freeze({
  open: Object.freeze(['closed']),
  closed: Object.freeze([]),
});

const MAX_SOURCE_KEY = 200;
const MAX_BODY = 2000;
const MAX_HANDLE = 200;
const MAX_LABEL = 200;
const MAX_ERROR_CODE = 120;
const MAX_ID = 200;
const MAX_CALL_SECONDS = 86400;
const MAX_MEMBER = 64;
const MAX_NOTE = 500;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;
const MEMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

export const bounds = Object.freeze({
  sourceKey: MAX_SOURCE_KEY,
  body: MAX_BODY,
  handle: MAX_HANDLE,
  label: MAX_LABEL,
  errorCode: MAX_ERROR_CODE,
  callSeconds: MAX_CALL_SECONDS,
  member: MAX_MEMBER,
  note: MAX_NOTE,
});

/** @param {unknown} value @param {string} field @param {number} max */
function safeText(value, field, max) {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`, { field });
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError(`${field} is required`, { field });
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError(`${field} must not contain control characters or line breaks`, { field });
  }
  return trimmed;
}

/** @param {unknown} value @param {string} field @param {number} max */
function optionalSafeText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  return safeText(value, field, max);
}

/**
 * The ADR-030 opaque subject envelope, same shape `packages/work` stores.
 * SQLite cannot enforce a foreign key whose target table varies per row; what
 * is checked is the shape, and the existence was proven by the caller — the
 * channel adapter running against the record it names.
 *
 * @param {unknown} value
 */
export function validateSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('subject is required', { field: 'subject' });
  }
  const subject = /** @type {any} */ (value);
  const resource = safeText(subject.resource, 'subject.resource', 64);
  if (!RESOURCE_RE.test(resource)) {
    throw new ValidationError('subject.resource must be a canonical resource name', { field: 'subject.resource' });
  }
  const id = safeText(subject.id, 'subject.id', MAX_ID);
  const owner = subject.owner;
  if (owner !== 'host' && owner !== 'package') {
    throw new ValidationError('subject.owner must be "host" or "package"', { field: 'subject.owner' });
  }
  let ownerPackage = null;
  if (owner === 'package') {
    ownerPackage = safeText(subject.ownerPackage, 'subject.ownerPackage', 64);
    if (!PACKAGE_RE.test(ownerPackage)) {
      throw new ValidationError('subject.ownerPackage must be a canonical package name', { field: 'subject.ownerPackage' });
    }
  } else if (subject.ownerPackage !== undefined && subject.ownerPackage !== null) {
    // A host-owned record has no owning package. Accepting one would store a
    // claim that a package owns a record the project owns.
    throw new ValidationError('subject.ownerPackage is not allowed when subject.owner is "host"', { field: 'subject.ownerPackage' });
  }
  return {
    resource,
    id,
    owner,
    ownerPackage,
    // A display snapshot, stored once and never refreshed — labelled as a
    // snapshot everywhere it is rendered.
    label: optionalSafeText(subject.label, 'subject.label', MAX_LABEL),
  };
}

/**
 * A team member id: an opaque string naming one person on the team, the same
 * shape as the team author on an outbound message. It starts with a letter or
 * a digit so prototype-pollution names (`__proto__`, `constructor`) never
 * become owners or readers, and it stays short so it fits the deterministic
 * read-state key with room to spare.
 *
 * @param {unknown} value @param {string} field
 */
export function validateMemberId(value, field) {
  const member = safeText(value, field, MAX_MEMBER);
  if (!MEMBER_RE.test(member) || member === '__proto__' || member === 'constructor' || member === 'prototype') {
    throw new ValidationError(
      `${field} must start with a letter or digit and hold only letters, digits, dots, underscores, @, slashes and hyphens`,
      { field },
    );
  }
  return member;
}

/** Where a row came from. Caller-asserted, exactly like a capability's `consumer`. */
function validateSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('source is required', { field: 'source' });
  }
  const source = /** @type {any} */ (value);
  const pkg = safeText(source.package, 'source.package', 64);
  if (pkg !== 'host' && !PACKAGE_RE.test(pkg)) {
    throw new ValidationError('source.package must be "host" or a canonical package name', { field: 'source.package' });
  }
  const action = safeText(source.action, 'source.action', 64);
  if (!RESOURCE_RE.test(action)) {
    throw new ValidationError('source.action must be a canonical action name', { field: 'source.action' });
  }
  return { package: pkg, action };
}

/**
 * **Bind provenance to the identity the registry proved, not to caller text.**
 * The registry resolves the consumer against that package's own declared
 * `requires` and hands it here; when it is present it IS the provenance, and a
 * request asserting a different package is refused rather than quietly
 * corrected. When it is absent the caller is the host — the project's own
 * adapter code, which imports these functions directly because the host is not
 * a registered package and cannot open a capability. A host caller may only
 * assert `host`.
 */
function bindSourcePackage(source, consumer) {
  const bound = typeof consumer === 'string' && consumer !== '' ? consumer : 'host';
  if (source.package !== bound) {
    throw new AppError(
      `An interaction logged by "${bound}" may not record source.package "${source.package}": provenance is bound to the `
        + `${consumer ? 'package the registry resolved as the consumer' : 'host, because no package consumer opened this capability'}, `
        + 'not to the request body.',
      { code: 'INTERACTIONS_SOURCE_PACKAGE_MISMATCH', status: 403, details: { asserted: source.package, bound } },
    );
  }
  return { package: bound, action: source.action };
}

/**
 * An instant that names a day which never existed is refused, not rolled over:
 * `Date.parse` silently rolls `2027-02-30` into March, and a caller that asked
 * for an impossible instant would get a different, plausible one stored as
 * evidence.
 *
 * @param {unknown} value @param {string} field
 */
function realIsoDate(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`, { field });
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (day && !isCalendarDate(day[1])) {
    throw new ValidationError(
      `${field} is not a real calendar date: ${day[1]} never existed, and it would otherwise be stored as the day it rolls over to`,
      { field },
    );
  }
  return optionalIsoDate(value, field);
}

/** @param {unknown} value @param {string} field */
function validateChannel(value, field) {
  const channel = safeText(value, field, 64);
  if (!CHANNELS.includes(channel)) {
    throw new ValidationError(`${field} must be one of ${CHANNELS.join(', ')}`, { field });
  }
  return channel;
}

/** @param {unknown} value @param {string} field */
function validateSourceKey(value, field) {
  const key = safeText(value, field, MAX_SOURCE_KEY);
  if (!SOURCE_KEY_RE.test(key)) {
    throw new ValidationError(`${field} must be a canonical business identity`, { field });
  }
  return key;
}

/**
 * The framework's normalized unique-constraint refusal, recognized so the loser
 * of a race replays the winner's row instead of surfacing driver text. Matched
 * on the typed `ConflictError`, never on message text; a transient busy
 * conflict is explicitly not one of these.
 *
 * @param {unknown} error
 */
export function isUniqueConflict(error) {
  if (!(error instanceof ConflictError)) return false;
  return /** @type {any} */ (error).details?.transient !== true;
}

/**
 * Resolve a module without letting the registry's own miss become the answer:
 * `ModuleRegistry.get` throws `NotFoundError` for an unregistered name, so an
 * optional read must catch rather than chain.
 *
 * @param {any} modules @param {string} name
 */
export function resolveModule(modules, name) {
  try {
    return modules?.get?.(name) ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** @param {Record<string, string>} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    conversation: moduleNames[CONVERSATION_MODULE] ?? CONVERSATION_MODULE,
    message: moduleNames[MESSAGE_MODULE] ?? MESSAGE_MODULE,
    call: moduleNames[CALL_MODULE] ?? CALL_MODULE,
    assignment: moduleNames[ASSIGNMENT_MODULE] ?? ASSIGNMENT_MODULE,
    read: moduleNames[READ_MODULE] ?? READ_MODULE,
    threadKey: moduleNames[THREAD_KEY_MODULE] ?? THREAD_KEY_MODULE,
    workActivity: moduleNames[WORK_ACTIVITY_MODULE] ?? WORK_ACTIVITY_MODULE,
  };
}

/**
 * The complete record mapping every write path resolves through — the same
 * map the capabilities hand out, so a package composed with renamed modules
 * opens, assigns and marks read through the renamed records instead of
 * looking for their canonical names. Forwarded whole, never per action, so a
 * new record cannot be added here and missed there.
 *
 * @param {{conversation: string, message: string, call: string, assignment: string, read: string, threadKey: string}} names
 */
function fullModuleNames(names) {
  return {
    [CONVERSATION_MODULE]: names.conversation,
    [MESSAGE_MODULE]: names.message,
    [CALL_MODULE]: names.call,
    [ASSIGNMENT_MODULE]: names.assignment,
    [READ_MODULE]: names.read,
    [THREAD_KEY_MODULE]: names.threadKey,
  };
}

/** @param {{modules: any, names: {conversation: string, message: string, call: string}}} context */
function interactionServices(context) {
  const { names } = context;
  const conversations = resolveModule(context.modules, names.conversation)?.service;
  const messages = resolveModule(context.modules, names.message)?.service;
  const calls = resolveModule(context.modules, names.call)?.service;
  if (!conversations?.createManaged || !messages?.createManaged || !calls?.createManaged) {
    throw new AppError(
      'The interactions package is installed without its "conversation", "interaction-message" and "interaction-call" records. '
        + 'Apply all three manifests with `crm module create` before composing it.',
      { code: 'INTERACTIONS_STORAGE_INVALID', status: 500 },
    );
  }
  return { conversations, messages, calls };
}

/**
 * The ownership record, for the write that keeps it — and for nothing else.
 * Assigning needs only the assignment record: an application composed with
 * the read-state record but without this one still marks threads read, and
 * one composed with neither still opens them. Each single-record write names
 * the record it needs, so a missing sibling never breaks it.
 *
 * @param {{modules: any, names: {assignment: string}}} context
 */
function assignmentServices(context) {
  const { names } = context;
  const assignments = resolveModule(context.modules, names.assignment)?.service;
  if (!assignments?.createManaged) {
    throw new AppError(
      'The interactions package is installed without its "conversation-assignment" record. '
        + 'Apply the conversation-assignment manifest with `crm module create` before assigning threads.',
      { code: 'INTERACTIONS_STORAGE_INVALID', status: 500 },
    );
  }
  return { assignments };
}

/**
 * The read-state record, for the write that keeps it — and for nothing else.
 * Marking read needs only the read record, mirroring the assignment record
 * above.
 *
 * @param {{modules: any, names: {read: string}}} context
 */
function readStateServices(context) {
  const { names } = context;
  const reads = resolveModule(context.modules, names.read)?.service;
  if (!reads?.createManaged) {
    throw new AppError(
      'The interactions package is installed without its "conversation-read" record. '
        + 'Apply the conversation-read manifest with `crm module create` before marking threads read.',
      { code: 'INTERACTIONS_STORAGE_INVALID', status: 500 },
    );
  }
  return { reads };
}

/**
 * The thread-key record a join leaves behind, when it is applied. Optional
 * on the open path: an application composed before this record existed still
 * opens threads and joins channels to them — the join simply leaves no alias
 * row behind, so a retry under a joined key re-joins the open thread instead
 * of replaying the alias. Only applications with the record applied get the
 * retry-after-close replay the record exists for.
 *
 * @param {{modules: any, names: {threadKey: string}}} context
 */
function optionalThreadKeyServices(context) {
  const { names } = context;
  const threadKeys = resolveModule(context.modules, names.threadKey)?.service;
  if (!threadKeys?.createManaged || !threadKeys?.listWhere) return { threadKeys: null };
  return { threadKeys };
}

/**
 * Same key, same payload → the row that already exists. Same key, different
 * payload → 409 naming the fields, so recorded evidence is never overwritten
 * and the caller is never left diffing two rows to find out why. The compared
 * payload carries the whole subject envelope: a retry that moves a subject
 * from host-owned to package-owned (or names another owning package) is a
 * different claim behind the same key, and is refused rather than replayed.
 * `subjectLabel` is deliberately not identity: it is a display snapshot taken
 * at creation and never refreshed, so a caller whose only difference is a
 * renamed contact describes the same conversation with a newer label.
 */
function replayOrConflict(existing, submitted, what) {
  const conflictingFields = Object.keys(submitted)
    .filter((field) => (existing[field] ?? null) !== (submitted[field] ?? null))
    .sort();
  if (conflictingFields.length === 0) return existing;
  throw new AppError(
    `An interaction ${what} already exists for this source key with a different ${conflictingFields.join(' and ')}; `
      + 'it is not overwritten. Read the existing row, or use a new source key for a new round.',
    { code: 'INTERACTIONS_LOG_CONFLICT', status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/** @param {unknown} request */
export function validateConversationRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a conversation request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  return {
    sourceKey: validateSourceKey(value.sourceKey, 'sourceKey'),
    subject: validateSubject(value.subject),
    channel: validateChannel(value.channel, 'channel'),
    remoteHandle: optionalSafeText(value.remoteHandle, 'remoteHandle', MAX_HANDLE),
    source: validateSource(value.source),
  };
}

/**
 * Record one channel key joined to one thread: the row that makes a join
 * idempotent. Two joins under the same key race on the key's UNIQUE guard,
 * exactly like every other write in this package: the loser replays the
 * winner's thread when it names the same conversation through the same
 * joiner and provenance, and is refused 409 when the same key claims another
 * conversation — or the same conversation through another joiner or
 * provenance, exactly like the alias path replays-or-refuses below.
 * `joinedAt` is not identity: it is when the row was written, not what the
 * join claims, so a retry that arrives later still replays instead of
 * conflicting with its own stamp.
 */
async function recordThreadKey(threadKeys, { sourceKey, conversationId, now, who, source, actor }) {
  try {
    return await threadKeys.createManaged({
      sourceKey,
      conversationId,
      joinedAt: now,
      joinedByType: who.type,
      joinedById: who.id,
      sourcePackage: source.package,
      sourceAction: source.action,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await threadKeys.listWhere({ sourceKey }))[0];
    if (!raced) throw error;
    return replayOrConflict(raced, {
      conversationId,
      joinedByType: who.type,
      joinedById: who.id,
      sourcePackage: source.package,
      sourceAction: source.action,
    }, 'thread key');
  }
}

/**
 * Open one conversation: one thread with one customer across channels.
 * Idempotent by source key: the key is the adapter's business identity for the
 * thread (provider + remote thread id), stable under every retry. A new key
 * for a customer that already has an open thread joins that thread — the
 * channel on the request names where this message arrived, and the thread
 * keeps messages from every channel in time order — so WhatsApp, Instagram
 * and email with one customer stay one conversation — and the join leaves one
 * thread-key row behind, so a retry under the joined key replays the joined
 * thread instead of opening a duplicate, even after the thread closed. Only
 * an `open` thread joins: a closed thread stays resolved, and a new key opens
 * a fresh one. When two opens for one customer race, both rows exist and the
 * earliest one is the thread every read joins; the check-then-create window
 * between the lookup and the insert is the documented residual, exactly like
 * the advance-action window this package already names.
 */
export async function openConversation(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { conversations } = interactionServices({ modules: context.modules, names });
  const { threadKeys } = optionalThreadKeyServices({ modules: context.modules, names });
  const actor = context.actor;
  // Evidence names its author: an anonymous log would store words the business
  // sent with nobody accountable for them, so a missing actor is refused.
  const who = requireActor(actor);
  const input = validateConversationRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);
  const now = typeof context.now === 'function' ? context.now() : new Date().toISOString();

  const submitted = {
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    channel: input.channel,
    remoteHandle: input.remoteHandle,
    sourcePackage: source.package,
    sourceAction: source.action,
  };

  const existing = (await conversations.listWhere({ sourceKey: input.sourceKey }))[0];
  if (existing) {
    return { conversation: replayOrConflict(existing, submitted, 'conversation'), replayed: true, joined: false };
  }

  // A key that joined a thread before names that thread still: without this
  // row a retry that arrives after the thread closed would miss every lookup
  // and open a second conversation behind the same key, breaking the
  // idempotency this function advertises. The replay compares the thread's
  // identity — the subject envelope and the provenance — but never the
  // channel or the remote handle: those name where this message arrived, not
  // the thread, and a joined key never recorded them.
  const alias = threadKeys ? (await threadKeys.listWhere({ sourceKey: input.sourceKey }))[0] : null;
  if (alias) {
    const target = await findConversationById(conversations, alias.conversationId);
    if (!target) {
      throw new AppError(
        `A thread key names conversation "${alias.conversationId}" and that conversation is gone: records are evidence and are never deleted, so this is corrupt storage, never an unknown thread`,
        { code: 'INTERACTIONS_STORAGE_INVALID', status: 500, details: { conversationId: alias.conversationId } },
      );
    }
    const claimed = {
      subjectResource: input.subject.resource,
      subjectId: input.subject.id,
      subjectOwner: input.subject.owner,
      subjectOwnerPackage: input.subject.ownerPackage,
      sourcePackage: source.package,
      sourceAction: source.action,
    };
    return { conversation: replayOrConflict(target, claimed, 'conversation'), replayed: true, joined: true };
  }

  const joined = await findOpenConversation(conversations, input.subject);
  if (joined) {
    if (threadKeys) {
      await recordThreadKey(threadKeys, {
        sourceKey: input.sourceKey, conversationId: joined.id, now, who, source, actor,
      });
    }
    return { conversation: joined, replayed: false, joined: true };
  }

  let conversation;
  try {
    conversation = await conversations.createManaged({
      sourceKey: input.sourceKey,
      ...submitted,
      subjectLabel: input.subject.label,
      status: 'open',
      openedAt: now,
      closedAt: null,
      openedByType: who.type,
      openedById: who.id,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await conversations.listWhere({ sourceKey: input.sourceKey }))[0];
    if (!raced) throw error;
    return { conversation: replayOrConflict(raced, submitted, 'conversation'), replayed: true, joined: false };
  }
  return { conversation, replayed: false, joined: false };
}

/**
 * The customer's open thread, if any: same ADR-030 subject envelope, still
 * open. `subjectOwnerPackage` is matched in memory rather than in the query
 * because a null owner package (every host-owned subject) is not an equality
 * any query builder can be trusted to spell the same way twice. When legacy
 * rows or a race left more than one open thread, the earliest one wins, by
 * the same oldest-first order the timeline reads.
 *
 * @param {any} conversations
 * @param {{resource: string, id: string, owner: string, ownerPackage: string|null}} subject
 */
async function findOpenConversation(conversations, subject) {
  const candidates = await conversations.listWhere({
    subjectResource: subject.resource,
    subjectId: subject.id,
    status: 'open',
  });
  const matching = candidates.filter((row) => (
    row.subjectOwner === subject.owner
    && (row.subjectOwnerPackage ?? null) === (subject.ownerPackage ?? null)
  ));
  if (matching.length === 0) return null;
  return sortByStamp(matching)[0];
}

/**
 * Oldest first, deterministically: the business stamp, then the row's own
 * creation stamp, then its id — the same tiebreak the timeline reads, so the
 * thread every read joins is the thread every read names.
 *
 * @param {any[]} rows
 */
function sortByStamp(rows) {
  /** @param {unknown} a @param {unknown} b */
  const lexical = (a, b) => {
    const left = String(a ?? '');
    const right = String(b ?? '');
    if (left < right) return -1;
    return left > right ? 1 : 0;
  };
  return [...rows].sort((a, b) => (
    lexical(a.openedAt ?? a.assignedAt, b.openedAt ?? b.assignedAt)
    || lexical(a.createdAt, b.createdAt)
    || lexical(a.id, b.id)
  ));
}

/** @param {unknown} request */
export function validateMessageRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a message request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const direction = safeText(value.direction, 'direction', 16);
  if (!MESSAGE_DIRECTIONS.includes(direction)) {
    throw new ValidationError(`direction must be one of ${MESSAGE_DIRECTIONS.join(', ')}`, { field: 'direction' });
  }
  const teamAuthorId = optionalSafeText(value.teamAuthorId, 'teamAuthorId', MAX_HANDLE);
  if (direction === 'outbound' && teamAuthorId === null) {
    // An outbound message with no team author names nobody for words the
    // business sent. The author is the accountability the packet asks for.
    throw new ValidationError('teamAuthorId is required for an outbound message', { field: 'teamAuthorId' });
  }
  if (direction === 'inbound' && teamAuthorId !== null) {
    // The mirror lie: the team did not write the customer's message.
    throw new ValidationError('teamAuthorId is not allowed on an inbound message', { field: 'teamAuthorId' });
  }
  if (value.errorCode !== undefined && value.errorCode !== null && value.errorCode !== '') {
    // A fresh message carries no failure yet; a failure arrives through the
    // advance action with its reason code. Accepting one here would store a
    // message that is both newly sent and already failed.
    throw new ValidationError('errorCode is recorded only when a message advances to failed', { field: 'errorCode' });
  }
  return {
    sourceKey: validateSourceKey(value.sourceKey, 'sourceKey'),
    conversationId: safeText(value.conversationId, 'conversationId', MAX_ID),
    direction,
    channel: validateChannel(value.channel, 'channel'),
    body: safeText(value.body, 'body', MAX_BODY),
    teamAuthorId,
    remoteHandle: optionalSafeText(value.remoteHandle, 'remoteHandle', MAX_HANDLE),
    subject: validateSubject(value.subject),
    occurredAt: realIsoDate(value.occurredAt, 'occurredAt'),
    source: validateSource(value.source),
  };
}

/**
 * Log one message. Inbound messages are stored as `received` — terminal, with
 * no lifecycle. Outbound messages start as `sent` and move only through the
 * advance action, so every delivery step is a validated transition rather than
 * a rewritten field.
 */
export async function logMessage(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { messages } = interactionServices({ modules: context.modules, names });
  const actor = context.actor;
  // Evidence names its author: an anonymous log would store words the business
  // sent with nobody accountable for them, so a missing actor is refused.
  const who = requireActor(actor);
  const input = validateMessageRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);

  const submitted = {
    conversationId: input.conversationId,
    direction: input.direction,
    channel: input.channel,
    body: input.body,
    teamAuthorId: input.teamAuthorId,
    remoteHandle: input.remoteHandle,
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    occurredAt: input.occurredAt,
    sourcePackage: source.package,
    sourceAction: source.action,
  };

  const existing = (await messages.listWhere({ sourceKey: input.sourceKey }))[0];
  if (existing) return { message: replayOrConflict(existing, submitted, 'message'), replayed: true };

  let message;
  try {
    message = await messages.createManaged({
      sourceKey: input.sourceKey,
      ...submitted,
      status: MESSAGE_INITIAL[input.direction],
      errorCode: null,
      actorType: who.type,
      actorId: who.id,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await messages.listWhere({ sourceKey: input.sourceKey }))[0];
    if (!raced) throw error;
    return { message: replayOrConflict(raced, submitted, 'message'), replayed: true };
  }
  return { message, replayed: false };
}

/**
 * Move one outbound message one step along its lifecycle: `sent -> delivered
 * -> read`, or either of them `-> failed` with a reason code. Anything else —
 * including any move from `received`, `read` or `failed` — is a 409 naming the
 * moves the current state allows. A failure without a reason code is refused:
 * a failed delivery nobody can diagnose is not evidence.
 */
export async function advanceMessage({ messages, actor }, record, to, errorCode) {
  const target = typeof to === 'string' ? to.trim() : to;
  const allowed = MESSAGE_TRANSITIONS[record.status] ?? [];
  if (!MESSAGE_STATES.includes(target) || !allowed.includes(target)) {
    throw new AppError(
      `An interaction message in state "${record.status}" cannot advance to "${target}"`
        + (allowed.length > 0 ? `; it may advance to ${allowed.join(' or ')}` : '; it is terminal and advances nowhere'),
      { code: 'INTERACTIONS_INVALID_STATE', status: 409, details: { from: record.status, to: target, allowed } },
    );
  }
  const code = target === 'failed'
    ? safeText(errorCode, 'errorCode', MAX_ERROR_CODE)
    : null;
  if (target !== 'failed' && errorCode !== undefined && errorCode !== null && errorCode !== '') {
    throw new ValidationError('errorCode is recorded only when a message advances to failed', { field: 'errorCode' });
  }
  if (!messages?.applyManaged) {
    throw new AppError('The interactions package is installed without a managed "interaction-message" record module', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }
  return messages.applyManaged(record.id, { status: target, errorCode: code }, { actor });
}

/** @param {unknown} request */
export function validateCallRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a call request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const direction = safeText(value.direction, 'direction', 16);
  if (!CALL_DIRECTIONS.includes(direction)) {
    throw new ValidationError(`direction must be one of ${CALL_DIRECTIONS.join(', ')}`, { field: 'direction' });
  }
  const outcome = safeText(value.outcome, 'outcome', 32);
  if (!CALL_OUTCOMES.includes(outcome)) {
    throw new ValidationError(`outcome must be one of ${CALL_OUTCOMES.join(', ')}`, { field: 'outcome' });
  }
  const durationSec = value.durationSec;
  if (typeof durationSec !== 'number' || !Number.isInteger(durationSec) || durationSec < 0 || durationSec > MAX_CALL_SECONDS) {
    throw new ValidationError(`durationSec must be a whole number of seconds from 0 to ${MAX_CALL_SECONDS}`, { field: 'durationSec' });
  }
  if (outcome !== 'completed' && durationSec !== 0) {
    // A call that never connected has no duration. Storing minutes on a
    // missed call would read as talk time in every report built on this row.
    throw new ValidationError('durationSec must be 0 unless the outcome is completed', { field: 'durationSec' });
  }
  const teamAuthorId = optionalSafeText(value.teamAuthorId, 'teamAuthorId', MAX_HANDLE);
  if (direction === 'outbound' && teamAuthorId === null) {
    throw new ValidationError('teamAuthorId is required for an outbound call', { field: 'teamAuthorId' });
  }
  if (direction === 'inbound' && teamAuthorId !== null) {
    throw new ValidationError('teamAuthorId is not allowed on an inbound call', { field: 'teamAuthorId' });
  }
  const errorCode = optionalSafeText(value.errorCode, 'errorCode', MAX_ERROR_CODE);
  if (outcome === 'failed' && errorCode === null) {
    throw new ValidationError('errorCode is required when the outcome is failed', { field: 'errorCode' });
  }
  if (outcome !== 'failed' && errorCode !== null) {
    throw new ValidationError('errorCode is recorded only when the outcome is failed', { field: 'errorCode' });
  }
  return {
    sourceKey: validateSourceKey(value.sourceKey, 'sourceKey'),
    conversationId: optionalSafeText(value.conversationId, 'conversationId', MAX_ID),
    direction,
    channel: validateChannel(value.channel, 'channel'),
    outcome,
    durationSec,
    teamAuthorId,
    remoteHandle: optionalSafeText(value.remoteHandle, 'remoteHandle', MAX_HANDLE),
    errorCode,
    subject: validateSubject(value.subject),
    occurredAt: realIsoDate(value.occurredAt, 'occurredAt'),
    source: validateSource(value.source),
  };
}

/**
 * Log one call with the outcome it already had. There is no advance: a call
 * that ended missed does not later become completed, and a second attempt is a
 * new call under a new source key.
 */
export async function logCall(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { calls } = interactionServices({ modules: context.modules, names });
  const actor = context.actor;
  // Evidence names its author: an anonymous log would store words the business
  // sent with nobody accountable for them, so a missing actor is refused.
  const who = requireActor(actor);
  const input = validateCallRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);

  const submitted = {
    conversationId: input.conversationId,
    direction: input.direction,
    channel: input.channel,
    outcome: input.outcome,
    durationSec: input.durationSec,
    teamAuthorId: input.teamAuthorId,
    remoteHandle: input.remoteHandle,
    errorCode: input.errorCode,
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    occurredAt: input.occurredAt,
    sourcePackage: source.package,
    sourceAction: source.action,
  };

  const existing = (await calls.listWhere({ sourceKey: input.sourceKey }))[0];
  if (existing) return { call: replayOrConflict(existing, submitted, 'call'), replayed: true };

  let call;
  try {
    call = await calls.createManaged({
      sourceKey: input.sourceKey,
      ...submitted,
      actorType: who.type,
      actorId: who.id,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await calls.listWhere({ sourceKey: input.sourceKey }))[0];
    if (!raced) throw error;
    return { call: replayOrConflict(raced, submitted, 'call'), replayed: true };
  }
  return { call, replayed: false };
}

/**
 * Assign one conversation to one team member — or to nobody, which clears it.
 * One row per handover, immutable: the rows for one conversation ARE the
 * audit trail, the latest row names the current owner, and reassigning writes
 * a new row rather than rewriting one. Idempotent by source key, like every
 * other write in this package: same key with the same payload replays the
 * stored row, a divergent payload behind the same key is refused 409 — and
 * without a key the handover names the row it follows, so a return to a
 * prior owner is a new row rather than a conflict behind the old one, while
 * repeating the current owner with the same note and provenance replays
 * instead of writing noise. A default-key handover that arrives after the
 * thread moved on follows the row that beat it as its previous owner: the
 * default names a handover, not a stable identity, and only an explicit key
 * promises strict replay-or-refusal.
 * The compared payload carries the handover but not its stamp — `assignedAt`
 * is when the row was written, not what the handover claims, exactly like
 * `subjectLabel` on a conversation — so a retry that arrives later still
 * replays instead of conflicting with its own stamp.
 *
 * @param {unknown} request
 */
export function validateAssignRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('an assignment request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const rawAssignee = value.assigneeMemberId;
  const assigneeMemberId = rawAssignee === undefined || rawAssignee === null
    ? null
    : validateMemberId(rawAssignee, 'assigneeMemberId');
  // The key is optional: without one the handover names the row it follows
  // (the latest handover row, or the conversation itself for the first one),
  // inside the serialized section below, so the default never names two
  // different handovers with one key.
  const rawKey = value.sourceKey;
  const sourceKey = rawKey === undefined || rawKey === null || String(rawKey).trim() === ''
    ? null
    : validateSourceKey(rawKey, 'sourceKey');
  return {
    sourceKey,
    conversationId: safeText(value.conversationId, 'conversationId', MAX_ID),
    assigneeMemberId,
    note: optionalSafeText(value.note, 'note', MAX_NOTE),
    source: validateSource(value.source),
  };
}

/**
 * **One conversation, one handover writer at a time — in this process.**
 *
 * Deriving the previous owner is a read-then-write: two handovers on one
 * thread interleaved in one process both read the same current owner and both
 * commit with it, so whichever sorts last claims the wrong immediate
 * predecessor and permanently corrupts the immutable audit trail. The chain
 * below serializes handovers per conversation — a process-local advisory
 * lock, one FIFO chain per thread. Acquisition attaches synchronously (no
 * `await` before the chain is extended), so two callers racing in the same
 * tick still order; the waiter re-reads after the winner commits and derives
 * the winner as its previous owner. The re-read is exact because every row
 * stamps itself past its predecessor (`nextHandoverStamp`), so same-tick
 * bursts never tie for "latest". Different conversations never contend.
 * Entries are removed when their chain drains, so the map holds only threads
 * with a handover in flight. The shape is the appointments package's
 * per-member booking chain, keyed by thread instead of member.
 *
 * This closes the same-process window. Across connections the handle
 * transaction below serializes writers on real storage, exactly like the
 * booking pair: SQLite `BEGIN IMMEDIATE` makes the second connection wait
 * for the winner's commit and re-read it, Postgres `SERIALIZABLE` refuses the
 * loser with a retryable conflict whose retry re-reads the winner.
 */
const conversationAssignmentChains = new Map();

/** @param {string} conversationId @param {() => Promise<any>} critical */
async function withConversationAssignment(conversationId, critical) {
  const previous = conversationAssignmentChains.get(conversationId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  // Tails never reject (the second handler joins even after a refusal), so a
  // refused handover never wedges the thread's chain — but the join is kept
  // explicit rather than assumed.
  const tail = previous.then(() => current, () => current);
  conversationAssignmentChains.set(conversationId, tail);
  // Synchronous until here: two callers racing in the same tick still order.
  await previous;
  try {
    return await critical();
  } finally {
    // Remove only our own tail: a waiter queued behind us owns the slot now.
    if (conversationAssignmentChains.get(conversationId) === tail) conversationAssignmentChains.delete(conversationId);
    release();
  }
}

/**
 * The outer transaction the previous-owner re-read and the insert commit in,
 * when the service exposes one and the caller is not already inside it —
 * the appointments booking-transaction shape on the assignment service.
 *
 * @param {any} assignments the resolved assignment module service
 */
function assignmentTransaction(assignments) {
  const transactionAsync = assignments?.database?.transactionAsync;
  if (typeof transactionAsync !== 'function') return null;
  if (proveCallerTransaction([assignments]) !== TRANSACTION_PROOF.NO_TRANSACTION) return null;
  return (/** @type {() => Promise<any>} */ critical) => transactionAsync.call(assignments.database, critical);
}

/**
 * The stamp the next handover carries: wall-clock time, never behind the row
 * it follows. Five handovers decided in one tick share the same `now`, and
 * two serialized inserts can share the same storage millisecond too, while
 * row ids are random — so "latest by stamp" ties its way to a random row and
 * a waiter derives a stale previous owner, permanently forking the immutable
 * audit trail (two rows sharing one predecessor). Bumping past the previous
 * row's stamp inside the serialized section below makes one thread's stamps
 * strictly increasing in commit order by construction, so the latest read
 * always names the true winner whatever the clock resolution is. A
 * predecessor-scoped uniqueness guard cannot do this: returning the thread
 * to a prior owner legitimately reuses a predecessor, and only the stamp
 * order tells the second visit from the first. The bump applies only on a
 * tie or backward clock — the common case keeps the true wall-clock time —
 * and the stamp never enters the replay comparison, so retries still replay.
 *
 * @param {string} now the caller's instant
 * @param {unknown} previousAssignedAt the previous row's stamp, if any
 */
function nextHandoverStamp(now, previousAssignedAt) {
  const base = Date.parse(now);
  if (Number.isNaN(base)) return now;
  const prev = typeof previousAssignedAt === 'string' ? Date.parse(previousAssignedAt) : NaN;
  if (Number.isNaN(prev) || prev < base) return now;
  return new Date(prev + 1).toISOString();
}

/**
 * The default identity of a handover: the row it follows, to who. A key
 * that names the (previous owner, next owner) pair cannot tell the second
 * visit to a pair from the first: a ping-pong guido->maria->guido->maria
 * replays the stale first row — or refuses the legitimate fourth handover
 * 409 — instead of writing it. Naming the predecessor row instead makes
 * every handover unique by construction: the first handover follows the
 * conversation itself, every later one follows the latest handover row, so
 * a retry still standing on the same predecessor replays while a thread
 * that moved on writes a new row. Member and row ids fit the source-key
 * alphabet by construction, so only an over-long conversation id can
 * overflow the bound — refused naming the bound, like the appointment
 * reminder key, with the way out (pass an explicit source key), never a
 * silent truncation that would hand two threads the same handover identity.
 */
function defaultAssignSourceKey(conversationId, predecessorRowId, assignee) {
  const key = `assign:${conversationId}:${predecessorRowId}:${assignee ?? 'unassigned'}`;
  if (key.length > MAX_SOURCE_KEY || !SOURCE_KEY_RE.test(key)) {
    throw new ValidationError(
      'a handover on this conversation needs an explicit sourceKey: the default handover identity does not fit the source-key bound',
      { field: 'sourceKey' },
    );
  }
  return key;
}

/**
 * The latest handover before this one: rows carrying this very source key are
 * excluded, so a retry recomputes the same previous owner the first attempt
 * saw instead of conflicting with its own stamp. A retry that arrives after
 * the thread moved on still names the move that beat it, through the replay
 * comparison, rather than silently adopting it.
 *
 * @param {any} assignments
 * @param {string} conversationId
 * @param {string|null} excludeSourceKey
 */
async function currentAssignmentRow(assignments, conversationId, excludeSourceKey = null) {
  const rows = await assignments.listWhere({ conversationId });
  const others = excludeSourceKey === null
    ? rows
    : rows.filter((row) => row.sourceKey !== excludeSourceKey);
  if (others.length === 0) return null;
  return sortByStamp(others)[others.length - 1];
}

export async function assignConversation(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { conversations } = interactionServices({ modules: context.modules, names });
  const { assignments } = assignmentServices({ modules: context.modules, names });
  const actor = context.actor;
  // Ownership names who decided it: an anonymous handover would move a
  // customer's thread with nobody accountable for the move.
  const who = requireActor(actor);
  const input = validateAssignRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);
  const now = typeof context.now === 'function' ? context.now() : new Date().toISOString();

  const conversation = await findConversationById(conversations, input.conversationId);
  if (!conversation) throw new NotFoundError('conversation', input.conversationId);

  // The derive-and-insert below runs serialized per conversation: the
  // previous-owner read and the insert commit as one critical section, so a
  // waiter re-reads the winner and names it as its previous owner instead of
  // corrupting the audit trail with the same predecessor twice.
  const runCritical = async () => {
    const excludeKey = input.sourceKey;
    const previousRow = await currentAssignmentRow(assignments, input.conversationId, excludeKey);
    const previous = previousRow ? previousRow.assigneeMemberId ?? null : null;

    // Repeating the member who already owns the thread replays the row that
    // established them instead of writing audit noise — but only when no
    // explicit key was supplied and the repeat carries nothing new. A
    // default-key repeat with another note or another provenance is a new
    // audit claim, not a retry: it falls through, derives its own
    // predecessor-based key below, and is written as a new row. An explicit
    // key is a strict replay-or-refusal promise, so it always falls through
    // to the listWhere + replayOrConflict path below, which persists the key
    // on first use and refuses a divergent reuse 409.
    if (excludeKey === null && previousRow && previous === input.assigneeMemberId
      && (previousRow.note ?? null) === (input.note ?? null)
      && previousRow.sourcePackage === source.package
      && previousRow.sourceAction === source.action) {
      return {
        assignment: previousRow,
        replayed: true,
        previous: previousRow.previousAssigneeMemberId ?? null,
      };
    }

    // The default key names the predecessor row, so two distinct handovers
    // never share one: the first handover follows the conversation itself.
    const sourceKey = excludeKey
      ?? defaultAssignSourceKey(
        input.conversationId,
        previousRow ? previousRow.id : input.conversationId,
        input.assigneeMemberId,
      );

    const submitted = {
      conversationId: input.conversationId,
      assigneeMemberId: input.assigneeMemberId,
      previousAssigneeMemberId: previous,
      note: input.note,
      sourcePackage: source.package,
      sourceAction: source.action,
    };

    const existing = (await assignments.listWhere({ sourceKey }))[0];
    if (existing) {
      return {
        assignment: replayOrConflict(existing, submitted, 'assignment'),
        replayed: true,
        previous,
      };
    }

    // Strictly past the row this handover follows: same-tick bursts share
    // `now` and serialized inserts can share a storage millisecond, so an
    // unmoved stamp ties its way to a random "latest" and forks the trail.
    const stamp = nextHandoverStamp(now, previousRow ? previousRow.assignedAt : null);

    let assignment;
    try {
      assignment = await assignments.createManaged({
        sourceKey,
        ...submitted,
        assignedAt: stamp,
        assignedByType: who.type,
        assignedById: who.id,
      }, { actor });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = (await assignments.listWhere({ sourceKey }))[0];
      if (!raced) throw error;
      return { assignment: replayOrConflict(raced, submitted, 'assignment'), replayed: true, previous };
    }
    return { assignment, replayed: false, previous };
  };

  const runInTransaction = assignmentTransaction(assignments);
  return withConversationAssignment(
    input.conversationId,
    runInTransaction ? () => runInTransaction(runCritical) : runCritical,
  );
}

/**
 * The ownership trail of one conversation, oldest first, with the current
 * owner on top. Unknown conversations answer null — absence, never an empty
 * trail presented as an unowned thread. When the assignment records were
 * never applied, the trail reports itself unavailable rather than reporting
 * no owner.
 */
export async function readConversationAssignment({ modules, moduleNames }, conversationId) {
  const names = resolvedNames(moduleNames);
  const id = safeText(conversationId, 'conversationId', MAX_ID);
  const conversations = resolveModule(modules, names.conversation)?.service;
  if (!conversations?.listWhere) {
    throw new AppError('The interactions package is installed without its records', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }
  const found = await findConversationById(conversations, id);
  if (!found) return null;
  const assignments = resolveModule(modules, names.assignment)?.service;
  if (!assignments?.listWhere) {
    return Object.freeze({
      available: false,
      assignee: null,
      assignedAt: null,
      assignedBy: null,
      history: Object.freeze([]),
      reason: 'the conversation-assignment record is not applied in this application, so the ownership trail is not available — this is not a claim that the thread is unowned',
    });
  }
  const rows = await assignments.listWhere({ conversationId: id });
  const history = Object.freeze(sortByStamp(rows).map((row) => Object.freeze({
    assignee: row.assigneeMemberId ?? null,
    previous: row.previousAssigneeMemberId ?? null,
    note: row.note ?? null,
    assignedAt: row.assignedAt,
    assignedBy: Object.freeze({ type: row.assignedByType, id: row.assignedById }),
  })));
  const current = history.length > 0 ? history[history.length - 1] : null;
  return Object.freeze({
    available: true,
    assignee: current ? current.assignee : null,
    assignedAt: current ? current.assignedAt : null,
    assignedBy: current ? current.assignedBy : null,
    history,
  });
}

/**
 * Mark one conversation read for the acting member: the watermark moves to
 * now. There is exactly one row per conversation and member, keyed
 * deterministically, so marking read twice updates the same row. The member
 * is always the actor — nobody marks another member read.
 */
export async function markConversationRead(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { conversations } = interactionServices({ modules: context.modules, names });
  const { reads } = readStateServices({ modules: context.modules, names });
  const actor = context.actor;
  // A read watermark without a reader would store that somebody saw the
  // customer's words with nobody saying who.
  const who = requireActor(actor);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a mark-read request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const conversationId = safeText(value.conversationId, 'conversationId', MAX_ID);
  bindSourcePackage(validateSource(value.source), context.consumer);
  const memberId = validateMemberId(who.id, 'memberId');
  const now = typeof context.now === 'function' ? context.now() : new Date().toISOString();

  const conversation = await findConversationById(conversations, conversationId);
  if (!conversation) throw new NotFoundError('conversation', conversationId);

  const sourceKey = `read:${conversationId}:${memberId}`;
  const existing = (await reads.listWhere({ sourceKey }))[0];
  if (existing) {
    const read = await reads.applyManaged(existing.id, {
      lastReadAt: now,
      updatedByType: who.type,
      updatedById: who.id,
    }, { actor });
    return { read, created: false };
  }
  try {
    const read = await reads.createManaged({
      sourceKey,
      conversationId,
      memberId,
      lastReadAt: now,
      updatedByType: who.type,
      updatedById: who.id,
    }, { actor });
    return { read, created: true };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await reads.listWhere({ sourceKey }))[0];
    if (!raced) throw error;
    const read = await reads.applyManaged(raced.id, {
      lastReadAt: now,
      updatedByType: who.type,
      updatedById: who.id,
    }, { actor });
    return { read, created: false };
  }
}

/**
 * One member's unread on one conversation: inbound messages later than the
 * member's watermark. Outbound messages never count — the team does not
 * unread its own words — and a channel delivery confirmation never moves a
 * team watermark, so this count and a message's `read` state stay two
 * different facts. Without a watermark every inbound message is unread.
 */
export async function unreadCount({ modules, moduleNames }, conversationId, memberId) {
  const names = resolvedNames(moduleNames);
  const id = safeText(conversationId, 'conversationId', MAX_ID);
  const member = validateMemberId(memberId, 'memberId');
  const conversations = resolveModule(modules, names.conversation)?.service;
  const messages = resolveModule(modules, names.message)?.service;
  const reads = resolveModule(modules, names.read)?.service;
  if (!conversations?.listWhere || !messages?.listWhere || !reads?.listWhere) {
    throw new AppError('The interactions package is installed without its records', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }
  const found = await findConversationById(conversations, id);
  if (!found) throw new NotFoundError('conversation', id);
  const watermark = (await reads.listWhere({ conversationId: id, memberId: member }))[0]?.lastReadAt ?? null;
  const inbound = await messages.listWhere({ conversationId: id, direction: 'inbound' });
  const unread = watermark === null
    ? inbound.length
    : inbound.filter((row) => String(row.occurredAt ?? '') > String(watermark)).length;
  return Object.freeze({ conversationId: id, memberId: member, unread, lastReadAt: watermark });
}

/**
 * Order one subject's history oldest-first, deterministically.
 *
 * `occurredAt` is the business instant and decides the order. Two entries at
 * the same instant have no business order at all, so the row's own creation
 * stamp and then its id decide, purely so two readers of the same data see the
 * same list. Lexical, never `localeCompare`: collation is a property of the
 * machine's ICU build, and two readers on two machines must see one order.
 *
 * @param {any[]} rows
 */
export function sortEntries(rows) {
  /** @param {unknown} a @param {unknown} b */
  const lexical = (a, b) => {
    const left = String(a ?? '');
    const right = String(b ?? '');
    if (left < right) return -1;
    return left > right ? 1 : 0;
  };
  return [...rows].sort((a, b) => (
    lexical(a.occurredAt, b.occurredAt)
    || lexical(a.createdAt, b.createdAt)
    || lexical(a.id, b.id)
  ));
}

/**
 * The customer history the card reads: this subject's messages and calls plus
 * the work-activity entries on the same subject, oldest first.
 *
 * Every read here *decides* what the customer history contains, so every one
 * is a complete exact-match query (`listWhere`), never a bounded display page:
 * a history that silently loses entries once a table outgrows a page is not a
 * history. `work-activity` is read through the runtime modules handle and is
 * optional — an application without the work package reads
 * `workActivity.available: false`, never an empty list presented as no work.
 */
export async function readTimeline({ modules, moduleNames }, subject) {
  const names = resolvedNames(moduleNames);
  const envelope = validateSubject(subject);
  const where = { subjectResource: envelope.resource, subjectId: envelope.id };

  const messages = resolveModule(modules, names.message)?.service;
  const calls = resolveModule(modules, names.call)?.service;
  if (!messages?.listWhere || !calls?.listWhere) {
    throw new AppError('The interactions package is installed without its message and call records', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }

  const messageRows = await messages.listWhere(where);
  const callRows = await calls.listWhere(where);

  const activityService = resolveModule(modules, names.workActivity)?.service;
  let workActivity = { available: false, count: null, entries: [] };
  if (activityService && typeof activityService.listWhere === 'function') {
    const activityRows = await activityService.listWhere(where);
    workActivity = {
      available: true,
      count: activityRows.length,
      entries: activityRows.map((row) => Object.freeze({
        entry: 'work-note',
        id: row.id,
        kind: row.kind,
        body: row.body ?? null,
        taskId: row.taskId ?? null,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt ?? null,
        actorType: row.actorType ?? null,
        actorId: row.actorId ?? null,
      })),
    };
  }

  const entries = sortEntries([
    ...messageRows.map((row) => Object.freeze({
      entry: 'message',
      id: row.id,
      conversationId: row.conversationId,
      direction: row.direction,
      channel: row.channel,
      status: row.status,
      body: row.body,
      teamAuthorId: row.teamAuthorId ?? null,
      remoteHandle: row.remoteHandle ?? null,
      errorCode: row.errorCode ?? null,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt ?? null,
    })),
    ...callRows.map((row) => Object.freeze({
      entry: 'call',
      id: row.id,
      conversationId: row.conversationId ?? null,
      direction: row.direction,
      channel: row.channel,
      outcome: row.outcome,
      durationSec: row.durationSec,
      teamAuthorId: row.teamAuthorId ?? null,
      remoteHandle: row.remoteHandle ?? null,
      errorCode: row.errorCode ?? null,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt ?? null,
    })),
    ...workActivity.entries,
  ]);

  return Object.freeze({
    subject: Object.freeze({ resource: envelope.resource, id: envelope.id }),
    entries: Object.freeze(entries),
    sources: Object.freeze({
      interactions: Object.freeze({ available: true, messageCount: messageRows.length, callCount: callRows.length }),
      workActivity: Object.freeze(workActivity.available
        ? { available: true, count: workActivity.count }
        : {
          available: false,
          count: null,
          reason: 'the work package is not composed in this application, so work-activity entries are not available — this is not a claim that there are none',
        }),
    }),
  });
}

/**
 * Every conversation row naming this subject, oldest first. The threads the
 * timeline entries arrived on — including threads with no message or call
 * logged yet, which a read grouped from timeline entries alone cannot see.
 * The same complete exact-match query the timeline uses, so a thread is never
 * lost once its table outgrows a page.
 */
export async function readSubjectConversations({ modules, moduleNames }, subject) {
  const names = resolvedNames(moduleNames);
  const envelope = validateSubject(subject);
  const conversations = resolveModule(modules, names.conversation)?.service;
  if (!conversations?.listWhere) {
    throw new AppError('The interactions package is installed without its conversation records', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }
  const rows = await conversations.listWhere({
    subjectResource: envelope.resource,
    subjectId: envelope.id,
  });
  return Object.freeze(sortByStamp(rows).map((row) => Object.freeze({
    id: row.id,
    channel: row.channel,
    status: row.status,
    openedAt: row.openedAt ?? null,
    closedAt: row.closedAt ?? null,
    remoteHandle: row.remoteHandle ?? null,
  })));
}

/**
 * One conversation as a thread: the conversation row with its messages and
 * calls, oldest first. An unknown conversation id answers null — absence,
 * never an empty thread presented as a quiet one.
 */
export async function readConversationThread({ modules, moduleNames }, conversationId) {
  const names = resolvedNames(moduleNames);
  const id = safeText(conversationId, 'conversationId', MAX_ID);
  const conversations = resolveModule(modules, names.conversation)?.service;
  const messages = resolveModule(modules, names.message)?.service;
  const calls = resolveModule(modules, names.call)?.service;
  if (!conversations?.listWhere || !messages?.listWhere || !calls?.listWhere) {
    throw new AppError('The interactions package is installed without its records', {
      code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
    });
  }
  const found = await findConversationById(conversations, id);
  if (!found) return null;
  const assignment = await readConversationAssignment({ modules, moduleNames }, id);
  const entries = sortEntries([
    ...(await messages.listWhere({ conversationId: id })).map((row) => Object.freeze({
      entry: 'message', id: row.id, direction: row.direction, channel: row.channel,
      status: row.status, body: row.body, teamAuthorId: row.teamAuthorId ?? null,
      remoteHandle: row.remoteHandle ?? null, errorCode: row.errorCode ?? null,
      occurredAt: row.occurredAt, createdAt: row.createdAt ?? null,
    })),
    ...(await calls.listWhere({ conversationId: id })).map((row) => Object.freeze({
      entry: 'call', id: row.id, direction: row.direction, channel: row.channel,
      outcome: row.outcome, durationSec: row.durationSec, teamAuthorId: row.teamAuthorId ?? null,
      remoteHandle: row.remoteHandle ?? null, errorCode: row.errorCode ?? null,
      occurredAt: row.occurredAt, createdAt: row.createdAt ?? null,
    })),
  ]);
  return Object.freeze({
    conversation: Object.freeze({ ...found }),
    // The thread carries its owner: readConversationAssignment answers null
    // only for unknown conversations, and this one exists, so the trail is
    // always present here — unavailable, never absent, on old compositions.
    assignment: Object.freeze({ ...(assignment ?? { available: false }) }),
    entries: Object.freeze(entries),
  });
}

/**
 * Exact read of one conversation by row id — a primary-key lookup, never a
 * scan. Only the expected miss becomes absence: a storage or connection
 * failure is the caller's outage to see, never a quiet unknown conversation.
 */
async function findConversationById(service, id) {
  try {
    return await service.get(id);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * `interaction-log@1` — the only write path: open conversations, log messages
 * and calls, hand threads to owners, move read watermarks. It is created with
 * the caller's runtime handles and writes through them; every write is one
 * row, idempotent by source key, so a retry replays rather than duplicates.
 * It hands out no service, no table and no query handle.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createInteractionLogCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  const scoped = (context) => ({
    modules: {
      get: (name) => context.modules.get(
        name === CONVERSATION_MODULE ? names.conversation
          : name === MESSAGE_MODULE ? names.message
            : name === CALL_MODULE ? names.call
              : name === ASSIGNMENT_MODULE ? names.assignment
                : name === READ_MODULE ? names.read
                  : name === THREAD_KEY_MODULE ? names.threadKey : name,
      ),
    },
    moduleNames: fullModuleNames(names),
    actor: context.actor,
    now: context.now,
    consumer: context.consumer,
  });
  return {
    name: 'interaction-log',
    version: 1,
    description:
      'Append interaction evidence — open a conversation, log a message or a call, assign its owner, mark it read — '
      + 'inside the caller\'s handles. Every write is one row, idempotent by source key. '
      + 'Grants no read beyond the written row, no update and no delete.',
    /** @param {{modules: any, actor?: unknown, now?: () => string, consumer?: string}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('interaction-log@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const scope = scoped(context);
      return Object.freeze({
        capabilityContract: 1,
        /** @param {unknown} request */
        openConversation: (request) => openConversation(scope, request),
        /** @param {unknown} request */
        logMessage: (request) => logMessage(scope, request),
        /** @param {unknown} request */
        logCall: (request) => logCall(scope, request),
        /** @param {unknown} request */
        assignConversation: (request) => assignConversation(scope, request),
        /** @param {unknown} request */
        markConversationRead: (request) => markConversationRead(scope, request),
      });
    },
  };
}

/**
 * `interaction-timeline@1` — the history the customer card reads. Read-only by
 * construction: frozen rows, no storage handle, no write path of any kind.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createInteractionTimelineCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: 'interaction-timeline',
    version: 1,
    description:
      'Read one subject\'s interaction history — its messages and calls plus the work-activity entries on the same '
      + 'subject, oldest first — every thread row naming the subject, one thread with its ownership trail, '
      + 'and one member\'s unread on a thread. '
      + 'Read-only: frozen rows, no storage handle, no write path.',
    /** @param {{modules: any}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('interaction-timeline@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const fullScope = {
        modules,
        moduleNames: {
          [CONVERSATION_MODULE]: names.conversation,
          [MESSAGE_MODULE]: names.message,
          [CALL_MODULE]: names.call,
          [ASSIGNMENT_MODULE]: names.assignment,
          [READ_MODULE]: names.read,
          [WORK_ACTIVITY_MODULE]: names.workActivity,
        },
      };
      return Object.freeze({
        capabilityContract: 1,
        /** @param {{resource: string, id: string, owner?: string, ownerPackage?: string|null, label?: string|null}} subject */
        timeline: (subject) => readTimeline(fullScope, subject),
        /** @param {{resource: string, id: string, owner?: string, ownerPackage?: string|null, label?: string|null}} subject */
        conversations: (subject) => readSubjectConversations(fullScope, subject),
        /** @param {string} conversationId */
        conversationThread: (conversationId) => readConversationThread(fullScope, conversationId),
        /** @param {string} conversationId */
        assignment: (conversationId) => readConversationAssignment(fullScope, conversationId),
        /** @param {string} conversationId @param {string} memberId */
        unread: (conversationId, memberId) => unreadCount(fullScope, conversationId, memberId),
      });
    },
  };
}

/**
 * `advance` — the only way an outbound message moves. `fromStates:
 * ['sent', 'delivered']` is enforced by the action runtime before this code
 * runs: a `received`, `read` or `failed` message answers `409 INVALID_STATE`
 * naming the state it is in. The exact target within the transition table is
 * checked here, because the runtime gates the entry and this package owns the
 * map.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildAdvanceMessageAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.message,
    name: 'advance',
    label: 'Advance message delivery',
    description: 'Move an outbound message one step along its lifecycle (sent -> delivered -> read, or either -> failed with a reason code). Terminal states never regress.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['sent', 'delivered'],
    input: [
      { name: 'to', type: 'string', required: true, hint: 'The next state: delivered, read, or failed.' },
      { name: 'errorCode', type: 'string', required: false, hint: 'Required when advancing to failed: the reason the delivery failed.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules }) {
      const service = resolveModule(modules, names.message)?.service;
      if (!service?.get || !service?.applyManaged) {
        throw new AppError('The interactions package is installed without a managed "interaction-message" record module', {
          code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
        });
      }
      // The runtime gates the entry state before this code runs, but a
      // concurrent advance can commit between that gate and this write: the
      // record handed here may already be stale. Re-read the authoritative
      // status immediately before writing, inside the same transaction, and
      // refuse a move the current state no longer allows — so two branches
      // from one state cannot both commit, and the loser names the move that
      // beat it instead of silently deciding the final state last.
      // (Residual: the framework's managed update is unconditional once
      // issued; a row lock or compare-and-set primitive in core would close
      // the remaining window between this read and the write.)
      const current = await service.get(record.id);
      if (current.status !== record.status) {
        const allowed = MESSAGE_TRANSITIONS[current.status] ?? [];
        throw new AppError(
          `An interaction message in state "${current.status}" cannot advance to "${input.to}": `
            + 'the message moved while this action ran'
            + (allowed.length > 0 ? `; it may advance to ${allowed.join(' or ')}` : '; it is terminal and advances nowhere'),
          { code: 'INTERACTIONS_INVALID_STATE', status: 409, details: { from: current.status, to: input.to, allowed } },
        );
      }
      return { message: await advanceMessage({ messages: service, actor }, current, input.to, input.errorCode) };
    },
  };
}

/**
 * `close` — the only way a conversation becomes `closed`.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildCloseConversationAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.conversation,
    name: 'close',
    label: 'Close conversation',
    description: 'Record that this thread is resolved. A closed conversation takes no position on its messages: their states stand as recorded.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['open'],
    toState: 'closed',
    input: [],
    /** @param {any} ctx */
    async execute({ record, actor, managed, now }) {
      const message = await managed(record.id, { status: 'closed', closedAt: now() });
      return { conversation: message };
    },
  };
}

/**
 * `assign` — hand one conversation to one team member, or clear it.
 *
 * A repeated handover to the member who already owns the thread replays
 * instead of writing audit noise — but only when the repeat carries the same
 * note through the same provenance; a new note is a new audit claim and is
 * written as a new row. Without a source key the handover names the row it
 * follows (the latest handover row, or the conversation itself for the
 * first), so the same handover retried is the same key with the same payload
 * while a return to a prior owner is a new row. A handover to someone else
 * is a new row with the previous owner named on it. Clearing names no owner
 * and keeps the previous one the same way.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildAssignConversationAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.conversation,
    name: 'assign',
    label: 'Assign conversation',
    description: 'Hand this thread to one team member, or clear its owner. Every handover is kept as audit; repeating the current owner replays.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['open', 'closed'],
    input: [
      { name: 'assigneeMemberId', type: 'string', required: false, hint: 'The team member who owns the thread now. Omit to clear the owner.' },
      { name: 'note', type: 'string', required: false, hint: 'One line saying why the thread moves.' },
      { name: 'sourceKey', type: 'string', required: false, hint: 'Idempotency key. Defaults to naming the handover row it follows, so every handover is unique.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, now }) {
      const assigneeMemberId = input.assigneeMemberId === undefined || input.assigneeMemberId === null
        || String(input.assigneeMemberId).trim() === ''
        ? null
        : validateMemberId(input.assigneeMemberId, 'assigneeMemberId');
      const note = input.note === undefined || input.note === null || String(input.note).trim() === ''
        ? null
        : optionalSafeText(input.note, 'note', MAX_NOTE);
      const rawKey = input.sourceKey;
      const sourceKey = rawKey === undefined || rawKey === null || String(rawKey).trim() === ''
        ? undefined
        : validateSourceKey(rawKey, 'sourceKey');
      const scope = {
        modules,
        moduleNames: fullModuleNames(names),
        actor,
        now,
        consumer: INTERACTIONS_PACKAGE,
      };
      const written = await assignConversation(scope, {
        sourceKey,
        conversationId: record.id,
        assigneeMemberId,
        note,
        source: { package: INTERACTIONS_PACKAGE, action: 'assign' },
      });
      return { assignment: written.assignment, replayed: written.replayed, previous: written.previous };
    },
  };
}

/**
 * `mark-read` — move the acting member's watermark on this conversation to
 * now. There is exactly one watermark row per conversation and member, so
 * reading again updates the same row. The member is always the actor: the
 * action takes no member input, so nobody marks another member read.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildMarkReadConversationAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.conversation,
    name: 'mark-read',
    label: 'Mark conversation read',
    description: 'Move my read watermark on this thread to now. One row per member: reading again updates it.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['open', 'closed'],
    input: [],
    /** @param {any} ctx */
    async execute({ record, actor, modules, now }) {
      const scope = {
        modules,
        moduleNames: fullModuleNames(names),
        actor,
        now,
        consumer: INTERACTIONS_PACKAGE,
      };
      const marked = await markConversationRead(scope, {
        conversationId: record.id,
        source: { package: INTERACTIONS_PACKAGE, action: 'mark-read' },
      });
      const who = requireActor(actor);
      const unread = await unreadCount(
        {
          modules,
          moduleNames: fullModuleNames(names),
        },
        record.id,
        who.id,
      );
      return { read: marked.read, created: marked.created, unread: unread.unread };
    },
  };
}

const OPPORTUNITY_CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * `open-opportunity` — open the sale this conversation is about.
 *
 * One conversation opens exactly one opportunity: the origin key
 * `conversation-opportunity:<conversationId>` carries the database UNIQUE
 * enforcement, so a retry or a second message in the same thread replays the
 * 409 naming the existing opportunity instead of opening a duplicate.
 *
 * The customer is never guessed — it is read from the conversation's own
 * subject envelope (a contact, or a company when no contact is named), through
 * the runtime services handle. Any other subject is refused: inventing a
 * customer for a sale is precisely the defect this action exists to prevent.
 * Identity resolution (which channel handle names which record) stays in
 * `packages/customer-data`; this action only follows the link the channel
 * adapter already recorded.
 *
 * The trigger must be an inbound message of this conversation about the same
 * subject: the sale opens from the customer's words, never from the team's
 * own outbound message, never from a message logged on another thread, and
 * never from another customer's words logged under this conversation.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildOpenOpportunityAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.conversation,
    name: 'open-opportunity',
    label: 'Open opportunity',
    description: 'Open one opportunity for this conversation\u2019s customer, from one of its inbound messages, entering the sales pipeline default stage.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['open', 'closed'],
    input: [
      { name: 'messageId', type: 'string', required: true, hint: 'The inbound message of this conversation the sale opens from.' },
      { name: 'opportunityName', type: 'string', required: true, hint: 'The sale name, e.g. the trial the customer asked about.' },
      {
        name: 'valueCents', type: 'integer', required: true,
        hint: 'Integer MINOR units: 500000 means 5,000.00 (not 500,000) in the chosen currency.',
      },
      { name: 'currency', type: 'string', required: false, hint: '3-letter ISO-4217 code, e.g. EUR (default). Uppercased automatically.' },
      { name: 'owner', type: 'string', required: false, hint: 'Defaults to the acting user id.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, core, modules, services, step, now }) {
      if (!core || typeof core.createOpportunity !== 'function' || typeof core.enterOpportunityPipeline !== 'function') {
        throw new AppError('conversation.open-opportunity needs the core-module adapters (ctx.core); run it through the application', {
          code: 'CORE_ADAPTERS_MISSING',
          status: 500,
        });
      }
      if (!services || !services.contacts || !services.companies) {
        throw new AppError('conversation.open-opportunity needs the customer services (ctx.services); run it through the application', {
          code: 'CUSTOMER_SERVICES_MISSING',
          status: 500,
        });
      }
      const messageService = resolveModule(modules, names.message)?.service;
      if (!messageService?.get) {
        throw new AppError('The interactions package is installed without a managed "interaction-message" record module', {
          code: 'INTERACTIONS_STORAGE_INVALID', status: 500,
        });
      }
      // Validate everything before the first write, so a bad input never
      // costs a rollback.
      const messageId = safeText(input.messageId, 'messageId', MAX_ID);
      const opportunityName = safeText(input.opportunityName, 'opportunityName', MAX_LABEL);
      if (typeof input.valueCents !== 'number' || !Number.isInteger(input.valueCents) || input.valueCents < 0) {
        throw new ValidationError('valueCents must be zero or positive (integer minor units)', { field: 'valueCents' });
      }
      const currency = input.currency ?? 'EUR';
      if (!OPPORTUNITY_CURRENCY_RE.test(currency)) {
        throw new ValidationError('currency must be a 3-letter ISO-4217 code', { field: 'currency' });
      }
      const actorId = actor && typeof actor === 'object' && typeof actor.id === 'string' ? actor.id : 'sale';
      const owner = optionalSafeText(input.owner, 'owner', MAX_LABEL) ?? actorId;

      // 1. The trigger: an inbound message of THIS conversation.
      const message = await messageService.get(messageId);
      if (message.conversationId !== record.id) {
        throw new AppError(
          `Cannot open an opportunity: message ${messageId} belongs to conversation ${message.conversationId}, not this one`,
          { code: 'OPPORTUNITY_MESSAGE_MISMATCH', status: 409, details: { messageId, conversationId: record.id } },
        );
      }
      if (message.direction !== 'inbound') {
        throw new AppError(
          'Cannot open an opportunity: the trigger must be an inbound message — a sale opens from the customer\u2019s words, not the team\u2019s',
          { code: 'OPPORTUNITY_NOT_INBOUND', status: 409, details: { messageId, direction: message.direction } },
        );
      }
      if (
        message.subjectResource !== record.subjectResource ||
        message.subjectId !== record.subjectId ||
        message.subjectOwner !== record.subjectOwner ||
        (message.subjectOwnerPackage ?? null) !== (record.subjectOwnerPackage ?? null)
      ) {
        throw new AppError(
          `Cannot open an opportunity: message ${messageId} is about another subject, not this conversation's customer — a sale opens from this customer's words`,
          { code: 'OPPORTUNITY_MESSAGE_SUBJECT_MISMATCH', status: 409, details: { messageId, conversationId: record.id } },
        );
      }
      step('message', { id: message.id, direction: message.direction });

      // 2. The customer: read from the conversation's subject, never guessed.
      let company;
      let contact = null;
      if (record.subjectResource === 'contact') {
        contact = await services.contacts.get(record.subjectId);
        company = await services.companies.get(contact.companyId);
      } else if (record.subjectResource === 'company') {
        company = await services.companies.get(record.subjectId);
      } else {
        throw new AppError(
          `Cannot open an opportunity: this conversation is about subject "${record.subjectResource}", not a contact or company the sale can name`,
          { code: 'OPPORTUNITY_SUBJECT_UNSUPPORTED', status: 409, details: { subjectResource: record.subjectResource } },
        );
      }
      step('customer', { companyId: company.id, ...(contact ? { contactId: contact.id } : {}) });

      // 3. Exactly one Opportunity, database-enforced via the unique sourceKey.
      // The legacy stage stays `qualification` (the pipeline stage carries the
      // sale's position); the pipeline entry below is what places it on the
      // board. With no pipeline installed the documented deterministic default
      // is legacy behavior: null pipeline state, never an invented stage.
      const opportunity = await core.createOpportunity(
        {
          companyId: company.id,
          ...(contact ? { contactId: contact.id } : {}),
          name: opportunityName,
          type: 'new_business',
          valueCents: input.valueCents,
          currency: currency.toUpperCase(),
          stage: 'qualification',
          owner,
          sourceKey: `conversation-opportunity:${record.id}`,
        },
        { actor },
      );
      const entered = await core.enterOpportunityPipeline(opportunity.id, { actor, now });
      step('opportunity', { id: opportunity.id, ...(entered ? { pipeline: entered.pipeline, stage: entered.stage } : {}) });

      return {
        opportunity: {
          id: opportunity.id,
          sourceKey: opportunity.sourceKey,
          ...(entered ? { pipeline: entered.pipeline, stage: entered.stage } : {}),
        },
        company: { id: company.id },
        ...(contact ? { contact: { id: contact.id } } : {}),
        message: { id: message.id },
      };
    },
  };
}

export { safeText, optionalSafeText };
