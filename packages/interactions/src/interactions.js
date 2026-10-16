// @ts-check

import {
  AppError, ConflictError, NotFoundError, ValidationError, isCalendarDate, requireActor,
  optionalIsoDate,
} from '../../core/index.js';

/**
 * **Interactions — the native message and call records.**
 *
 * Three evidence records and no more: a **Conversation** — one message thread
 * with a customer on one channel — an **Interaction message** — one inbound or
 * outbound message with its delivery state — and an **Interaction call** — one
 * inbound or outbound call with its outcome and duration. Every row is fully
 * managed: there is no public create or update path to any of them, so a
 * client cannot forge a message, rewrite a delivery state or invent a call.
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

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;

export const bounds = Object.freeze({
  sourceKey: MAX_SOURCE_KEY,
  body: MAX_BODY,
  handle: MAX_HANDLE,
  label: MAX_LABEL,
  errorCode: MAX_ERROR_CODE,
  callSeconds: MAX_CALL_SECONDS,
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
    workActivity: moduleNames[WORK_ACTIVITY_MODULE] ?? WORK_ACTIVITY_MODULE,
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
 * Open one conversation: one thread with one customer on one channel.
 * Idempotent by source key: the key is the adapter's business identity for the
 * thread (provider + remote thread id), stable under every retry.
 */
export async function openConversation(context, request) {
  const names = resolvedNames(context.moduleNames);
  const { conversations } = interactionServices({ modules: context.modules, names });
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
  if (existing) return { conversation: replayOrConflict(existing, submitted, 'conversation'), replayed: true };

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
    return { conversation: replayOrConflict(raced, submitted, 'conversation'), replayed: true };
  }
  return { conversation, replayed: false };
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
  return Object.freeze({ conversation: Object.freeze({ ...found }), entries: Object.freeze(entries) });
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
 * and calls. It is created with the caller's runtime handles and writes
 * through them; every write is one row, idempotent by source key, so a retry
 * replays rather than duplicates. It hands out no service, no table and no
 * query handle.
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
            : name === CALL_MODULE ? names.call : name,
      ),
    },
    moduleNames: {
      [CONVERSATION_MODULE]: names.conversation,
      [MESSAGE_MODULE]: names.message,
      [CALL_MODULE]: names.call,
    },
    actor: context.actor,
    now: context.now,
    consumer: context.consumer,
  });
  return {
    name: 'interaction-log',
    version: 1,
    description:
      'Append interaction evidence — open a conversation, log a message or a call — inside the caller\'s handles. '
      + 'Every write is one row, idempotent by source key. Grants no read beyond the written row, no update and no delete.',
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
      + 'subject, oldest first. Read-only: frozen rows, no storage handle, no write path.',
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
          [WORK_ACTIVITY_MODULE]: names.workActivity,
        },
      };
      return Object.freeze({
        capabilityContract: 1,
        /** @param {{resource: string, id: string, owner?: string, ownerPackage?: string|null, label?: string|null}} subject */
        timeline: (subject) => readTimeline(fullScope, subject),
        /** @param {string} conversationId */
        conversationThread: (conversationId) => readConversationThread(fullScope, conversationId),
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

export { safeText, optionalSafeText };
