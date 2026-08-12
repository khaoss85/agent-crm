// @ts-check

import { AppError, ValidationError, optionalIsoDate } from '../../core/index.js';

/**
 * **Follow-up creation — the one implementation.**
 *
 * Everything that creates a Task in this framework goes through
 * {@link createFollowUp}. The `follow-up@1` capability closes over it for
 * consuming *packages*; the host application's own actions import it directly,
 * because `PackageRegistry.capability()` resolves its `consumer` against
 * registered packages and the host is not one (see `docs/plans/
 * activity-task-operations.md` §9). Two callers, one function, no fallback and
 * no second code path that could drift.
 *
 * It writes through the caller's own `modules` handle, so both rows land inside
 * the caller's transaction. If the caller's transaction rolls back, the Task and
 * its Activity roll back with it — there is no separate connection, no queue and
 * no post-commit hook anywhere in this package.
 */

export const TASK_MODULE = 'work-task';
export const ACTIVITY_MODULE = 'work-activity';

export const TASK_STATES = Object.freeze(['open', 'completed', 'cancelled']);
export const TASK_OPEN = 'open';
export const TASK_TERMINAL = Object.freeze(['completed', 'cancelled']);

/**
 * The whole transition table. Not a rank, not a comparison, not an ordering:
 * a map from a state to the states it may become, and every state that is not
 * listed as a key can become nothing.
 *
 * `open -> completed` is direct and deliberate. An `in_progress` state would
 * change no read, no action and no refusal in this milestone, so it would be a
 * label that also forces a rule nobody asked for. There is **no reopen**:
 * a repeated business round is a new task under a new source key, which the
 * idempotency rule already supports, and un-completing work would need a second
 * lifecycle nothing here has.
 */
export const TASK_TRANSITIONS = Object.freeze({
  open: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** The closed Activity vocabulary. Four entries, and adding a fifth is a decision. */
export const ACTIVITY_KINDS = Object.freeze(['task_created', 'task_completed', 'task_cancelled', 'note']);

const MAX_SOURCE_KEY = 200;
const MAX_TITLE = 200;
const MAX_LABEL = 200;
const MAX_BODY = 1000;
const MAX_REASON = 300;
const MAX_ID = 200;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;

/**
 * A key that moves identifies nothing.
 *
 * M16a fixed exactly this defect once already: a deterministic key that carried
 * `now()` made every retry a new business fact, so a lost response became a
 * duplicate record rather than a replay. It is cheap to refuse at the boundary
 * and expensive to find later, so it is refused here — an ISO-8601 *instant*
 * (a date with a time on it) or a run of 13+ digits, which is what an epoch
 * millisecond timestamp looks like.
 *
 * A bare calendar date is deliberately allowed: `renewal-decision:<id>:
 * 2027-01-31` is a real business identity, and M16a uses that shape.
 */
const CLOCK_IN_KEY_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{13,}/;

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

/** The framework's three actor types, normalized without reaching into a private module. */
export function normalizeWorkActor(actor) {
  const candidate = /** @type {any} */ (actor);
  const type = candidate?.type;
  const id = candidate?.id;
  if ((type === 'user' || type === 'agent' || type === 'system') && typeof id === 'string' && id.trim() !== '') {
    return { type, id: id.trim().slice(0, MAX_ID) };
  }
  return { type: 'system', id: 'accordo' };
}

/**
 * A human-actor boundary, and nothing more.
 *
 * It is **not** RBAC, not authentication and not secure assignment: a local
 * caller sets its own actor header. What it does buy is that an agent cannot
 * silently close somebody's work — the refusal is the same
 * `403 HUMAN_APPROVAL_REQUIRED` every other human decision in this repository
 * raises.
 *
 * @param {unknown} actor @param {string} what
 */
export function requireHumanActor(actor, what) {
  const normalized = normalizeWorkActor(actor);
  if (normalized.type !== 'user') {
    throw new AppError(`${what} is a human decision`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return normalized.id;
}

/**
 * Validate the **opaque subject envelope**.
 *
 * SQLite cannot enforce a foreign key whose target table varies per row, and
 * this package does not pretend it can. What it stores instead is an envelope
 * whose *shape* is checked and whose *existence* was proven by the caller — the
 * domain action that owns the source record, running on that record, inside the
 * transaction that is about to commit.
 *
 * `owner` keeps the Package Contract's distinction between a host/project-owned
 * record (a Lead: it disappears with the project) and a foreign package-owned
 * one (a `commercial-followup`: it disappears with Lifecycle). A reader of the
 * row can tell which, which is exactly what a dangling reference otherwise
 * costs you.
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
    // A display snapshot, stored once and never refreshed. It is labelled as a
    // snapshot everywhere it is rendered, because a name that has since changed
    // is stale evidence rather than a bug.
    label: optionalSafeText(subject.label, 'subject.label', MAX_LABEL),
  };
}

/** Where a follow-up came from. Caller-asserted, exactly like a capability's `consumer`. */
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

/** @param {unknown} request */
export function validateFollowUpRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a follow-up request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const sourceKey = safeText(value.sourceKey, 'sourceKey', MAX_SOURCE_KEY);
  if (!SOURCE_KEY_RE.test(sourceKey)) {
    throw new ValidationError('sourceKey must be a canonical business identity', { field: 'sourceKey' });
  }
  if (CLOCK_IN_KEY_RE.test(sourceKey)) {
    throw new ValidationError(
      'sourceKey must not contain a timestamp: a key that moves every millisecond identifies nothing, '
        + 'and every retry would create a second task',
      { field: 'sourceKey' },
    );
  }
  return {
    sourceKey,
    title: safeText(value.title, 'title', MAX_TITLE),
    // Evidence only. Nothing schedules on it, nothing fires from it, and no
    // clock changes a status because of it.
    dueAt: optionalIsoDate(value.dueAt, 'dueAt') ?? null,
    subject: validateSubject(value.subject),
    source: validateSource(value.source),
  };
}

/**
 * The framework's normalized unique-constraint refusal, recognized so the loser
 * of a race can replay the winner's row instead of surfacing driver text.
 * @param {unknown} error
 */
export function isUniqueConflict(error) {
  return error instanceof AppError && error.status === 409
    && /already exists|unique constraint/i.test(String(error.message));
}

/**
 * Same key, same payload → the record that already exists. Same key, different
 * payload → 409 naming the fields, so recorded work is never overwritten and
 * the caller is never left diffing two rows to find out why.
 *
 * @param {any} existing @param {Record<string, unknown>} submitted
 */
function replayOrConflict(existing, submitted) {
  const conflictingFields = Object.keys(submitted)
    .filter((field) => (existing[field] ?? null) !== (submitted[field] ?? null))
    .sort();
  if (conflictingFields.length === 0) return existing;
  throw new AppError(
    `A follow-up task already exists for this source key with a different ${conflictingFields.join(' and ')}; `
      + 'it is not overwritten. Read the existing task, or use a new source key for a new round of work.',
    { code: 'WORK_FOLLOW_UP_CONFLICT', status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/** @param {{modules: any}} context */
function services(context) {
  const tasks = context.modules?.get?.(TASK_MODULE)?.service;
  const activities = context.modules?.get?.(ACTIVITY_MODULE)?.service;
  if (!tasks?.createManaged || !activities?.createManaged) {
    throw new AppError(
      `The work package is installed without its "${TASK_MODULE}" and "${ACTIVITY_MODULE}" records. `
        + 'Apply both manifests with `crm module create` before composing it.',
      { code: 'WORK_STORAGE_INVALID', status: 500 },
    );
  }
  return { tasks, activities };
}

/**
 * Create exactly one follow-up Task and its `task_created` Activity, inside the
 * caller's transaction.
 *
 * @param {{modules: any, actor?: unknown, now?: () => string}} context the
 *   caller's own runtime handles — `modules` is what makes this the caller's
 *   transaction rather than a second connection.
 * @param {unknown} request
 * @returns {Promise<{task: any, activity: any, replayed: boolean}>}
 */
export async function createFollowUp(context, request) {
  const { tasks, activities } = services(context);
  const now = typeof context.now === 'function' ? context.now : () => new Date().toISOString();
  const actor = context.actor;
  const who = normalizeWorkActor(actor);
  const input = validateFollowUpRequest(request);

  const submitted = {
    title: input.title,
    dueAt: input.dueAt,
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
  };

  /** @param {any} task */
  const replay = (task) => ({
    task: replayOrConflict(task, submitted),
    // The creation activity is exact-read by its own deterministic key, so a
    // replay answers with the same pair the first call returned.
    activity: activities.listWhere({ sourceKey: creationKey(task.id) })[0] ?? null,
    replayed: true,
  });

  // Exact read on the unique business identity — never a paged list. This is
  // the read that decides whether work already exists, so it must be complete
  // rather than "the first page of it".
  const existing = tasks.listWhere({ sourceKey: input.sourceKey })[0];
  if (existing) return replay(existing);

  const openedAt = now();
  let task;
  try {
    task = await tasks.createManaged({
      sourceKey: input.sourceKey,
      title: input.title,
      status: TASK_OPEN,
      dueAt: input.dueAt,
      subjectResource: input.subject.resource,
      subjectId: input.subject.id,
      subjectOwner: input.subject.owner,
      subjectOwnerPackage: input.subject.ownerPackage,
      subjectLabel: input.subject.label,
      sourcePackage: input.source.package,
      sourceAction: input.source.action,
      openedByType: who.type,
      openedById: who.id,
      openedAt,
      completedBy: null,
      completedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      closingReason: null,
    }, { actor });
  } catch (error) {
    // Two connections computed the same identity and the unique constraint
    // picked the winner. The loser answers from the winner's row rather than
    // from a driver error — and a payload that genuinely differs is still a 409.
    if (!isUniqueConflict(error)) throw error;
    const raced = tasks.listWhere({ sourceKey: input.sourceKey })[0];
    if (!raced) throw error;
    return replay(raced);
  }

  const activity = await recordActivity({ activities, actor }, {
    sourceKey: creationKey(task.id),
    kind: 'task_created',
    subject: input.subject,
    taskId: task.id,
    body: null,
    occurredAt: openedAt,
    source: input.source,
  });

  return { task, activity, replayed: false };
}

/** @param {string} taskId */
export const creationKey = (taskId) => `work-activity:task-created:${taskId}`;
/** @param {string} taskId */
export const closingKey = (taskId, state) => `work-activity:task-${state}:${taskId}`;

/**
 * Append one Activity row. Append-only in the strict sense: nothing in this
 * package updates or deletes one, and the module has no public write path at
 * all.
 *
 * @param {{activities: any, actor?: unknown}} deps
 * @param {{sourceKey: string|null, kind: string, subject: {resource: string, id: string},
 *   taskId: string|null, body: string|null, occurredAt: string,
 *   source: {package: string, action: string}}} entry
 */
export async function recordActivity({ activities, actor }, entry) {
  if (!ACTIVITY_KINDS.includes(entry.kind)) {
    throw new ValidationError(`kind must be one of ${ACTIVITY_KINDS.join(', ')}`, { field: 'kind' });
  }
  const who = normalizeWorkActor(actor);
  return activities.createManaged({
    sourceKey: entry.sourceKey,
    kind: entry.kind,
    subjectResource: entry.subject.resource,
    subjectId: entry.subject.id,
    taskId: entry.taskId,
    body: entry.body,
    occurredAt: entry.occurredAt,
    actorType: who.type,
    actorId: who.id,
    sourcePackage: entry.source.package,
    sourceAction: entry.source.action,
  }, { actor });
}

/**
 * Order a subject's timeline oldest-first, deterministically.
 *
 * `occurredAt` is the business instant and decides the order. Two entries
 * recorded at the *same* instant — which an injected, stepped clock makes
 * routine — have no business order at all, so the row's own creation stamp and
 * then its id decide, purely so that two readers of the same data see the same
 * list. That is determinism, not chronology, and it is published as
 * `TIMELINE_ORDER_TIES_ARE_ARBITRARY` rather than presented as a sequence
 * somebody could reason about.
 *
 * @param {any[]} rows
 */
export function sortTimeline(rows) {
  return [...rows].sort((a, b) => {
    const byOccurred = String(a.occurredAt ?? '').localeCompare(String(b.occurredAt ?? ''));
    if (byOccurred !== 0) return byOccurred;
    const byCreated = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    if (byCreated !== 0) return byCreated;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
}

export const bounds = Object.freeze({
  sourceKey: MAX_SOURCE_KEY,
  title: MAX_TITLE,
  label: MAX_LABEL,
  noteBody: MAX_BODY,
  reason: MAX_REASON,
});

export { safeText, optionalSafeText };
