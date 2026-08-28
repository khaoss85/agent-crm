// @ts-check

import {
  AppError, ConflictError, TRANSACTION_PROOF, ValidationError, isCalendarDate, normalizeActor,
  optionalIsoDate, proveCallerTransaction,
} from '../../core/index.js';

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
 * **Why there is no clock heuristic here, and where the guarantee lives instead.**
 *
 * A key that moves identifies nothing, and M16a shipped exactly that defect
 * once: a deterministic key that carried `now()` made every retry a new
 * business fact. The first cut of this package answered it with a regex that
 * refused any ISO instant and any run of 13 or more digits. That regex is
 * **gone**, because it was a one-domain bug fix promoted into a universal false
 * restriction, and it refused real business identities:
 *
 *   - `customer:1234567890123` — a 13-digit external customer number;
 *   - `stripe-evt:1712345678901` — a provider event id;
 *   - `order:9876543210987654` — a 16-digit order number;
 *   - `meeting:2027-01-31T14:00` — a business event whose *scheduled* instant is
 *     deliberately part of its identity and is stable under every retry.
 *
 * None of those moves between two calls, which is the only property that
 * matters, and none is distinguishable from a clock by looking at the string.
 * Work is a **generic** capability: it cannot infer a caller's business
 * identity, so it does not pretend to. It refuses what it can actually judge —
 * structurally invalid syntax and unbounded length — and the stability of the
 * identity stays with the caller who owns it, proven by that caller's own retry
 * test. Every consumer in this repository has one, in
 * `tests/work-source-key-stability.test.js`, and every key is derived from a
 * committed record id rather than from a clock.
 */

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
 * The framework's actor authority, and **only** that.
 *
 * This used to be a local re-implementation that also did
 * `id.trim().slice(0, 200)`. Truncation is not a bound, it is a **merge**: two
 * distinct identities that share their first 200 characters became one string,
 * so `openedById`, `completedBy` and every Activity `actorId` would name a
 * person who may not have done it — while the audit row written by the same
 * transaction, through the kernel's own `normalizeActor`, still carried the
 * full id. Two records of one write disagreeing about who did it is the worst
 * kind of evidence defect, because both look authoritative.
 *
 * So Work no longer normalizes its own actor: it calls the same public helper
 * the audit log calls, and stores exactly what audit stores. There is nothing
 * left here to drift.
 */
export function normalizeWorkActor(actor) {
  return normalizeActor(actor);
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

/**
 * A `dueAt` that names a day which never existed is refused, not rolled over.
 *
 * `optionalIsoDate` is `Date.parse` underneath, and `Date.parse` does not
 * validate a calendar day: it rolls it. `2027-02-30` becomes `2027-03-02` and
 * `2027-04-31` becomes `2027-05-01`, silently, so a caller that asked for an
 * impossible date got a *different, plausible* one stored as evidence — the
 * exact class of defect ADR-028 added `isCalendarDate` for after it shipped in
 * M16a. A due date nobody chose is worse than a refusal, because nothing about
 * the stored row says it was invented.
 *
 * The check is the framework's one round-trip authority, applied to the
 * calendar-day part of whatever ISO form the caller sent: a date, a date with a
 * time, an offset form, all of them. The time part is left to `optionalIsoDate`
 * as before, and the value is still stored canonically in UTC.
 *
 * @param {unknown} value @param {string} field
 */
function optionalRealIsoDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (day && !isCalendarDate(day[1])) {
      throw new ValidationError(
        `${field} is not a real calendar date: ${day[1]} never existed, and it would otherwise be stored as the day it rolls over to`,
        { field },
      );
    }
  }
  return optionalIsoDate(value, field);
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

/**
 * **Bind provenance to the identity the registry proved, not to caller text.**
 *
 * `source.package` is stored as evidence of which package opened a piece of
 * work, and it used to be nothing but a string the caller typed. Every checked-
 * in consumer typed the truth, but the *record* could not tell: the Service
 * package could write `source.package: 'lifecycle'` on an escalation's task,
 * Lifecycle could write `'host'`, and both would read back as authoritative
 * provenance for the rest of the row's life. Redundant caller text that nobody
 * can check is not evidence.
 *
 * The registry already resolves and verifies the consumer at
 * `PackageRegistry.capability()` — against that package's own declared
 * `requires` — so from Work v1 it hands that identity to the provider, and this
 * is where it lands. When it is present it **is** the provenance: a request
 * that asserts a different package is refused rather than quietly corrected, so
 * a consumer that believes it is somebody else finds out.
 *
 * **What this is not.** It is not authentication. The registry checks that the
 * named consumer is a registered package which itself declared
 * `work/follow-up@1`; it cannot tell which package's *code* is running (ADR-018
 * addendum 4 states plainly that the consumer name is asserted by the caller).
 * So the floor moves from "any package name a caller types" to "a package that
 * also declared this capability" — a real narrowing, not a boundary, and
 * published as such in `metadata().capability.bindingLimitation`. Building a
 * generic authentication system is explicitly out of scope for Work v1.
 *
 * When it is absent, the caller is the **host** — the project's own action
 * code, which imports {@link createFollowUp} directly because a host
 * application action is not a registered package and cannot open a capability
 * (see `metadata().capability.hostLimitation`). A host caller may only assert
 * `host`: it has no package identity to claim, and claiming one would be the
 * same spoof from the other direction.
 *
 * `subject.ownerPackage` is a different fact and stays caller-asserted: it
 * describes who owns the *subject*, which is legitimately a third package, so
 * the consumer's identity cannot bind it. That limitation is published in
 * `metadata()` rather than papered over.
 *
 * @param {{package: string, action: string}} source
 * @param {unknown} consumer the registry-resolved consumer, or undefined
 */
function bindSourcePackage(source, consumer) {
  const bound = typeof consumer === 'string' && consumer !== '' ? consumer : 'host';
  if (source.package !== bound) {
    throw new AppError(
      `A follow-up opened by "${bound}" may not record source.package "${source.package}": provenance is bound to the `
        + `${consumer ? 'package the registry resolved as the consumer of work/follow-up@1' : 'host, because no package consumer opened this capability'}, `
        + 'not to the request body.',
      { code: 'WORK_SOURCE_PACKAGE_MISMATCH', status: 403, details: { asserted: source.package, bound } },
    );
  }
  return { package: bound, action: source.action };
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
  return {
    sourceKey,
    title: safeText(value.title, 'title', MAX_TITLE),
    // Evidence only. Nothing schedules on it, nothing fires from it, and no
    // clock changes a status because of it — but it must still be a day that
    // existed.
    dueAt: optionalRealIsoDate(value.dueAt, 'dueAt') ?? null,
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
  // Not the error *text*. The kernel raises a typed `ConflictError` for a
  // violated unique constraint, and matching `/already exists/` on the message
  // instead meant any other 409 whose sentence happened to contain those two
  // words — a pending approval, a second envelope, a busy-database retry —
  // could be read as "the unique index picked a winner" and answered with a
  // replay. The type is what the framework publishes, so the type is what is
  // checked; a transient busy conflict is explicitly not one of these.
  if (!(error instanceof ConflictError)) return false;
  return /** @type {any} */ (error).details?.transient !== true;
}

/**
 * Why a transaction can be open and still not be the caller's, and what to do
 * about it. Shared by the refusals below so the diagnosis is written once.
 */
const LOST_ASYNC_CONTEXT = 'It was opened by a different asynchronous flow. Either another request owns it — and writing here would join a transaction this code does not control, to be committed or rolled back by somebody else — or this call has crossed a boundary that dropped its async context. Context survives await, queueMicrotask, process.nextTick, setTimeout, setImmediate and an event emitted inside the transaction; it is lost by a callback that leaves the transaction and is invoked later, including a listener registered inside it and emitted outside. Call this inside the transaction, or wrap the callback with AsyncResource.bind before it leaves.';

/**
 * **Fail closed when the promised transaction is not there.**
 *
 * This package's whole guarantee is that a Task and its creation Activity are
 * one atomic pair, and the only thing that makes them one is the caller's
 * enclosing transaction. Called *outside* one — from a script, from a
 * `prepare` phase, from a future consumer that forgot — each managed write
 * commits on its own SAVEPOINT, and a failure between them leaves a committed
 * Task with no Activity: the half pair the README says this package never
 * produces. It was reachable, and it produced one (probe: inject a fault into
 * the activity write with no transaction open, and the task survives).
 *
 * So the transactional context is verified rather than assumed — and verified
 * without the driver.
 *
 * This used to read the SQLite driver's `isTransaction` flag straight off the
 * module service's database handle: one boolean, bought by holding the driver
 * itself, and with it `exec`, `prepare` and every table in the application,
 * inside a business package. `proveCallerTransaction` answers
 * the same question through the storage seam (Spine v2 M2D). It pulls the
 * opaque witness from the handle the write will actually land on, so it still
 * cannot be satisfied by a caller holding a *different* transaction's handle,
 * and it now also refuses a value the core witness module never minted.
 *
 * **Both services, not one.** The Task and the Activity are resolved
 * independently from the caller's `modules`, and nothing used to prove they
 * were the same connection. Two handles would break the pair even *inside* a
 * transaction, because they would be inside two different ones. That is one
 * identity comparison, and it is the "same storage handle" half of the promise
 * this function's name makes.
 *
 * @param {any} tasks @param {any} activities
 */
export function requireCallerTransaction(tasks, activities) {
  const proof = proveCallerTransaction([tasks, activities]);
  if (proof === TRANSACTION_PROOF.ACTIVE) return;
  // A genuine handle honestly reporting that nothing is open is the one case a
  // caller can fix, so it keeps the sentence that says how.
  if (proof === TRANSACTION_PROOF.NO_TRANSACTION) {
    throw new AppError(
      'work/follow-up@1 must be called inside the caller\'s transaction: it writes a task and its creation activity '
        + 'as one pair, and outside a transaction a failure between them would leave the task without the activity. '
        + 'Call it from a package action\'s execute, or from inside database.transactionAsync.',
      { code: 'WORK_TRANSACTION_REQUIRED', status: 500 },
    );
  }
  // A real transaction, opened by somebody else. Refused with the cause named:
  // a generic "no transaction" here would send a caller hunting for one that is
  // already open, which is the worst version of this message.
  if (proof === TRANSACTION_PROOF.NOT_TRANSACTION_OWNER) {
    throw new AppError(
      'work/follow-up@1 found a transaction open on this connection that this call does not own, so it refuses '
        + 'to write a task and its activity into it. ' + LOST_ASYNC_CONTEXT,
      { code: 'WORK_TRANSACTION_REQUIRED', status: 500, details: { proof } },
    );
  }
  // Everything else — no handle, two handles, a handle that cannot answer, or
  // an answer nothing minted — is the same refusal it has always been: this
  // code cannot prove the pair will commit together, so it writes neither half.
  throw new AppError(
    'A follow-up cannot prove it is running inside the caller\'s transaction, so it refuses to write a task '
      + 'whose activity might not commit with it.',
    { code: 'WORK_TRANSACTION_REQUIRED', status: 500, details: { proof } },
  );
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

/**
 * Resolve a module without letting the registry's own miss become the answer.
 *
 * `ModuleRegistry.get` **throws** `NotFoundError` for an unregistered name, so
 * `modules.get(TASK_MODULE)?.service` never evaluates to `undefined` — it
 * escapes. The named refusal below was therefore unreachable, and a project
 * that composed the host Lead path without applying the Work manifests got a
 * bare `404 Module not found: work-task` instead of the sentence telling it what
 * to run. That matters most exactly here: the host path is the one consumer the
 * registry cannot refuse at startup, so a runtime refusal is all it ever gets.
 *
 * @param {any} modules @param {string} name
 */
export function resolveModule(modules, name) {
  try {
    return modules?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/** @param {{modules: any}} context */
function services(context) {
  const tasks = resolveModule(context.modules, TASK_MODULE)?.service;
  const activities = resolveModule(context.modules, ACTIVITY_MODULE)?.service;
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
 * @param {{modules: any, actor?: unknown, now?: () => string, consumer?: string}} context
 *   the caller's own runtime handles — `modules` is what makes this the
 *   caller's transaction rather than a second connection. `consumer` is set by
 *   `PackageRegistry.capability()` and is never supplied by a caller.
 * @param {unknown} request
 * @returns {Promise<{task: any, activity: any, replayed: boolean}>}
 */
export async function createFollowUp(context, request) {
  const { tasks, activities } = services(context);
  requireCallerTransaction(tasks, activities);
  const now = typeof context.now === 'function' ? context.now : () => new Date().toISOString();
  const actor = context.actor;
  const who = normalizeWorkActor(actor);
  const input = validateFollowUpRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);

  /**
   * **The semantic identity of a follow-up**, and the whole of it.
   *
   * A source key is a promise that two calls describe the *same* piece of work.
   * This comparison is what enforces that promise, so everything that changes
   * what the work IS belongs in it. The first cut compared four fields —
   * title, dueAt and the subject's resource and id — which meant the same key
   * could be replayed with a different **subject owner**, a different **owning
   * package**, a different **source package** or a different **source action**,
   * and be answered "yes, already done" while the stored row said something
   * else entirely. A Service escalation could reuse a Lifecycle key and be
   * handed Lifecycle's task, with Lifecycle's provenance, as if it were its own.
   *
   * `subjectLabel` is deliberately **not** here: the contract states it is a
   * display snapshot taken at creation and never refreshed, so a caller whose
   * only difference is a renamed company is describing the same work with a
   * newer label, and replaying it is correct. That is the single documented
   * non-authoritative field; every other stored fact is identity.
   */
  const submitted = {
    title: input.title,
    dueAt: input.dueAt,
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    sourcePackage: source.package,
    sourceAction: source.action,
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
      status: TASK_OPEN,
      // Every semantic field, from the one object the replay comparison reads,
      // so the two can never describe different rows.
      ...submitted,
      subjectLabel: input.subject.label,
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
    source,
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
 * **Lexical, never `localeCompare`.** The first cut compared with
 * `localeCompare` and no locale argument, which asks the host's ICU collation
 * — a property of the machine, the Node build (full-icu versus small-icu) and
 * the `LANG` the process happened to inherit. ICU collation is not code-point
 * order: it treats `-` and `_` as variable punctuation and orders case the
 * other way round, so `x_1` sorts before `x-1` in every locale while code
 * points say the opposite, and `da-DK` puts `aa` after `ab`. Two readers of the
 * same rows on two machines could therefore see two orders — which is exactly
 * the thing this function exists to prevent. Code-point comparison is the same
 * everywhere and needs no ICU at all.
 *
 * @param {any[]} rows
 */
export function sortTimeline(rows) {
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

export const bounds = Object.freeze({
  sourceKey: MAX_SOURCE_KEY,
  title: MAX_TITLE,
  label: MAX_LABEL,
  noteBody: MAX_BODY,
  reason: MAX_REASON,
});

export { safeText, optionalSafeText };
