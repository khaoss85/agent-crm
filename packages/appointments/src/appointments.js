// @ts-check

import {
  AppError, ConflictError, NotFoundError, TRANSACTION_PROOF, ValidationError, isCalendarDate, proveCallerTransaction,
  requireActor, optionalIsoDate, requireAmount,
} from '../../core/index.js';

/**
 * **Appointments — the native booking record.**
 *
 * One evidence record and no more: an **Appointment** — a customer meeting one
 * team member for one listino service in one time slot, with the price that
 * was agreed and the booking lifecycle around it.
 *
 * **Reuse, not duplication (the packet's first acceptance bullet).**
 *
 * - The customer is the ADR-030 opaque envelope — `subjectResource`,
 *   `subjectId`, `subjectOwner`, `subjectOwnerPackage`, `subjectLabel` — the
 *   same shape `packages/work`, `packages/customer-data` and
 *   `packages/interactions` store. Nothing here copies a contact or a company,
 *   and no customer master table is created: the customer stays the host
 *   contact (or company) record.
 * - The service and its price come from the commercial listino: the booking
 *   path resolves the service key and the agreed amount from the
 *   `product`/`price-book` records the catalog sync materializes and passes
 *   them in; this package stores the key plus an immutable snapshot. There is
 *   no parallel catalog here, no pricing authority and no price re-resolution:
 *   a later listino change never rewrites a booked price.
 * - The team member is an opaque team identity string — the same convention
 *   as the interactions package's `teamAuthorId`. There is no staff roster
 *   here and none is created.
 * - The reminder is a work follow-up. The work package "schedules nothing,
 *   reminds nobody": its primitive is a deterministic follow-up task with
 *   evidence-only `dueAt`, which this package opens through the declared
 *   `follow-up@1` capability inside the booking transaction. A spine
 *   scheduled-ask timer may later open that follow-up at the instant; the
 *   timer owns *when*, this package owns *what is asked* — the division of
 *   labour `packages/core/src/domain-timers.js` states.
 */

export const APPOINTMENT_MODULE = 'appointment';

export const APPOINTMENTS_PACKAGE = 'appointments';

/**
 * The whole booking lifecycle. Not a rank, not a comparison: a map from a
 * state to the states it may become, and every state that is not listed as a
 * key can become nothing.
 *
 * A booking starts `booked` and becomes real when the customer confirms:
 * `booked -> confirmed`. From there it ends `done` (it happened), `no-show`
 * (the customer never came) or `cancelled`. A booking is cancelled from
 * `booked` or `confirmed`, always with a reason — a cancellation nobody can
 * explain is not evidence. Terminal states never regress and there is no
 * reopen: a repeated visit is a new appointment under a new source key.
 */
export const APPOINTMENT_STATES = Object.freeze(['booked', 'confirmed', 'done', 'no-show', 'cancelled']);
export const APPOINTMENT_TRANSITIONS = Object.freeze({
  booked: Object.freeze(['confirmed', 'cancelled']),
  confirmed: Object.freeze(['done', 'no-show', 'cancelled']),
  done: Object.freeze([]),
  'no-show': Object.freeze([]),
  cancelled: Object.freeze([]),
});
export const APPOINTMENT_TERMINAL = Object.freeze(['done', 'no-show', 'cancelled']);
export const APPOINTMENT_INITIAL = 'booked';

/** A cancelled booking explains itself; any other move carries no reason. */
export const CANCELLED_STATE = 'cancelled';

const MAX_SOURCE_KEY = 200;
const MAX_ID = 200;
const MAX_LABEL = 200;
const MAX_NOTES = 2000;
const MAX_REASON = 300;
const MAX_FOLLOW_UP_TITLE = 200;
const MAX_SLOT_MS = 24 * 60 * 60 * 1000;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_RE = /^[a-z][a-z0-9-]*$/;
const SOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]*$/;
const SERVICE_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const bounds = Object.freeze({
  sourceKey: MAX_SOURCE_KEY,
  notes: MAX_NOTES,
  reason: MAX_REASON,
  slotMs: MAX_SLOT_MS,
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
 * The ADR-030 opaque subject envelope, same shape `packages/work` and
 * `packages/interactions` store. SQLite cannot enforce a foreign key whose
 * target table varies per row; what is checked is the shape, and the
 * existence was proven by the caller — the booking path running against the
 * contact record it names.
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
 * booking code, which imports these functions directly because the host is not
 * a registered package and cannot open a capability. A host caller may only
 * assert `host`.
 */
function bindSourcePackage(source, consumer) {
  const bound = typeof consumer === 'string' && consumer !== '' ? consumer : 'host';
  if (source.package !== bound) {
    throw new AppError(
      `An appointment booked by "${bound}" may not record source.package "${source.package}": provenance is bound to the `
        + `${consumer ? 'package the registry resolved as the consumer' : 'host, because no package consumer opened this capability'}, `
        + 'not to the request body.',
      { code: 'APPOINTMENTS_SOURCE_PACKAGE_MISMATCH', status: 403, details: { asserted: source.package, bound } },
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
function realIsoInstant(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`, { field });
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (day && !isCalendarDate(day[1])) {
    throw new ValidationError(
      `${field} is not a real calendar date: ${day[1]} never existed, and it would otherwise be stored as the day it rolls over to`,
      { field },
    );
  }
  const normalized = optionalIsoDate(value, field);
  if (normalized === null || normalized === undefined) {
    throw new ValidationError(`${field} is required`, { field });
  }
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new ValidationError(`${field} must be a valid ISO instant`, { field });
  return { iso: normalized, ms };
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
  return { appointment: moduleNames[APPOINTMENT_MODULE] ?? APPOINTMENT_MODULE };
}

/** @param {{modules: any, names: {appointment: string}}} context */
function appointmentService(context) {
  const service = resolveModule(context.modules, context.names.appointment)?.service;
  if (!service?.createManaged) {
    throw new AppError(
      'The appointments package is installed without its "appointment" records. '
        + 'Apply the manifest with `crm module create` before composing it.',
      { code: 'APPOINTMENTS_STORAGE_INVALID', status: 500 },
    );
  }
  return service;
}

/**
 * **Refuse to start a booking pair that cannot finish as one.**
 *
 * A booking with `remindAt` stores the appointment row and opens its work
 * follow-up reminder as one pair. Each managed write lands on its own
 * SAVEPOINT so it nests safely inside an enclosing transaction — but outside
 * one that SAVEPOINT *is* the transaction and `RELEASE` commits it, so a
 * reminder refusal after the booking commit leaves a row that claims a
 * reminder that was never created (and every retry under the same source key
 * then replays without ever creating it). The proof is the same storage-seam
 * witness `packages/work` and `packages/contracts` require, on the handle the
 * appointment write is about to land on; the reminder write is proven again by
 * work itself on its own services when it runs.
 *
 * A booking without `remindAt` is one atomic row and needs no enclosing
 * transaction, so this is required only on the reminder path — before the
 * first write, with every input refusal already past.
 *
 * @param {any} appointments the resolved appointment module service
 */
function requireBookingTransaction(appointments) {
  const proof = proveCallerTransaction([appointments]);
  if (proof === TRANSACTION_PROOF.ACTIVE) return;
  if (proof === TRANSACTION_PROOF.NO_TRANSACTION) {
    throw new AppError(
      'A booking with remindAt must run inside the caller\'s transaction: it stores the appointment and opens '
        + 'its work follow-up reminder as one pair, and outside a transaction a reminder refusal would leave a booking '
        + 'that claims a reminder that was never created. Call it from inside database.transactionAsync.',
      { code: 'APPOINTMENTS_TRANSACTION_REQUIRED', status: 500 },
    );
  }
  if (proof === TRANSACTION_PROOF.NOT_TRANSACTION_OWNER) {
    throw new AppError(
      'A booking with remindAt found a transaction open on this connection that this call does not own, so it refuses '
        + 'to store the first row of a pair into it. Either another request owns it, or this call crossed a boundary '
        + 'that dropped its async context; call it inside the transaction, or wrap the callback with AsyncResource.bind '
        + 'before it leaves.',
      { code: 'APPOINTMENTS_TRANSACTION_REQUIRED', status: 500, details: { proof } },
    );
  }
  throw new AppError(
    'A booking with remindAt cannot prove it is running inside the caller\'s transaction, so it refuses to store '
      + 'the first row of a pair whose reminder might not commit with it.',
    { code: 'APPOINTMENTS_TRANSACTION_REQUIRED', status: 500, details: { proof } },
  );
}

/** @param {unknown} request */
export function validateAppointmentRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('an appointment request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (request);
  const startsAt = realIsoInstant(value.startsAt, 'startsAt');
  const endsAt = realIsoInstant(value.endsAt, 'endsAt');
  if (endsAt.ms <= startsAt.ms) {
    throw new ValidationError('endsAt must be after startsAt: a slot with no duration books nothing', { field: 'endsAt' });
  }
  if (endsAt.ms - startsAt.ms > MAX_SLOT_MS) {
    throw new ValidationError('an appointment slot is at most 24 hours: a longer hold is not a booking', { field: 'endsAt' });
  }
  const serviceKey = safeText(value.serviceKey, 'serviceKey', 48);
  if (!SERVICE_KEY_RE.test(serviceKey)) {
    throw new ValidationError(
      'serviceKey must be the listino product key (lowercase slug, letters, digits, hyphens, at most 48 characters)',
      { field: 'serviceKey' },
    );
  }
  const currency = safeText(value.currency, 'currency', 3);
  if (!CURRENCY_RE.test(currency)) {
    throw new ValidationError('currency must be a 3-letter ISO code (e.g. EUR)', { field: 'currency' });
  }
  const remindAt = value.remindAt === undefined || value.remindAt === null || value.remindAt === ''
    ? null
    : realIsoInstant(value.remindAt, 'remindAt').iso;
  if (remindAt !== null && Date.parse(remindAt) >= startsAt.ms) {
    throw new ValidationError('remindAt must be before startsAt: a reminder at or after the slot reminds nobody', { field: 'remindAt' });
  }
  return {
    sourceKey: validateSourceKey(value.sourceKey, 'sourceKey'),
    subject: validateSubject(value.subject),
    // The team member is an opaque team identity — the same convention as the
    // interactions package's teamAuthorId. No roster is read and none is
    // created; the overlap check below is what makes the identity load-bearing.
    teamMemberId: safeText(value.teamMemberId, 'teamMemberId', MAX_ID),
    serviceKey,
    // The price snapshot, resolved by the booking path from the commercial
    // listino and stored as agreed. Integer minor units, never floats
    // (ADR-014): the shared `requireAmount` bound, not a local limit.
    priceCents: requireAmount(value.priceCents, 'priceCents'),
    currency,
    startsAt: startsAt.iso,
    endsAt: endsAt.iso,
    startMs: startsAt.ms,
    endMs: endsAt.ms,
    notes: optionalSafeText(value.notes, 'notes', MAX_NOTES),
    remindAt,
    source: validateSource(value.source),
  };
}

/**
 * The no-double-booking invariant: one team member holds one slot at a time.
 * Two half-open slots `[startsAt, endsAt)` overlap when each starts before the
 * other ends; back-to-back slots share an endpoint and do not overlap. A
 * cancelled booking holds nothing — cancelling is how a slot is freed — but
 * every other state holds its slot even after it ends, because the slot was
 * real: the member was busy then, and the row is the evidence.
 *
 * @param {{teamMemberId: string, startMs: number, endMs: number}} candidate
 * @param {Array<any>} held the team member's existing rows
 * @returns {any|null} the conflicting row, or null
 */
export function findOverlap(candidate, held) {
  for (const row of held ?? []) {
    if (!row || row.status === CANCELLED_STATE) continue;
    const startMs = Date.parse(row.startsAt);
    const endMs = Date.parse(row.endsAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (startMs < candidate.endMs && candidate.startMs < endMs) return row;
  }
  return null;
}

/**
 * Same key, same payload → the row that already exists. Same key, different
 * payload → 409 naming the fields, so recorded evidence is never overwritten
 * and the caller is never left diffing two rows to find out why. The compared
 * payload carries the whole subject envelope: a retry that moves the customer
 * from host-owned to package-owned is a different claim behind the same key,
 * and is refused rather than replayed. `subjectLabel` is deliberately not
 * identity: it is a display snapshot taken at creation and never refreshed.
 */
function replayOrConflict(existing, submitted) {
  const conflictingFields = Object.keys(submitted)
    .filter((field) => (existing[field] ?? null) !== (submitted[field] ?? null))
    .sort();
  if (conflictingFields.length === 0) return existing;
  throw new AppError(
    `An appointment already exists for this source key with a different ${conflictingFields.join(' and ')}; `
      + 'it is not overwritten. Read the existing row, or use a new source key for a new booking.',
    { code: 'APPOINTMENTS_LOG_CONFLICT', status: 409, details: { conflictingFields, existingId: existing.id } },
  );
}

/**
 * The deterministic business identity of the reminder follow-up: one booking
 * owns at most one reminder, and a retried booking replays the same reminder
 * rather than scheduling a second.
 *
 * The booking source key already matches the canonical shape, but the derived
 * key is longer than the booking key — so a booking whose key nearly fills
 * the source-key bound would derive a reminder key the follow-up refuses.
 * That booking is refused here, at booking time, naming the bound: a silent
 * truncation would hand two bookings the same reminder identity, and a second
 * key scheme would make the identity depend on the key length.
 *
 * @param {string} sourceKey
 */
export function reminderSourceKey(sourceKey) {
  // The follow-up sourceKey bound (packages/work/src/follow-up.js): the
  // reminder row must satisfy it, and this package owns the derivation.
  const REMINDER_SOURCE_KEY_MAX = 200;
  const derived = `appointment:${sourceKey}:reminder`;
  if (derived.length > REMINDER_SOURCE_KEY_MAX) {
    throw new ValidationError(
      `a booking with remindAt needs a sourceKey of at most ${REMINDER_SOURCE_KEY_MAX - 'appointment::reminder'.length} characters, `
        + 'so the derived reminder identity fits the follow-up bound',
      { field: 'sourceKey' },
    );
  }
  return derived;
}

/**
 * The follow-up request a booking's reminder is made of, derived once so the
 * fresh path and the replay path cannot describe two different reminders: the
 * same booking always names the same reminder identity, title, instant,
 * customer and provenance.
 */
function reminderRequest(input, source) {
  return {
    sourceKey: reminderSourceKey(input.sourceKey),
    title: `Appointment reminder: ${input.serviceKey} at ${input.startsAt}`.slice(0, MAX_FOLLOW_UP_TITLE),
    dueAt: input.remindAt,
    // The reminder is follow-up work on the customer, so it names the
    // appointment's customer subject — the same envelope, the same record.
    subject: {
      resource: input.subject.resource,
      id: input.subject.id,
      owner: input.subject.owner,
      ownerPackage: input.subject.ownerPackage,
      label: input.subject.label,
    },
    // The provenance work binds is the identity the follow-up handle was
    // opened as — this package — never the booking's own source package:
    // forwarding the booking source (e.g. `host`) makes work refuse the write
    // with WORK_SOURCE_PACKAGE_MISMATCH after the booking row is committed.
    source: { package: APPOINTMENTS_PACKAGE, action: source.action },
  };
}

/**
 * Book one appointment: validate, refuse a slot the team member already holds,
 * store the row as `booked`, and — when the request names `remindAt` — open
 * exactly one work follow-up reminder inside the same transaction, due at the
 * named instant. Idempotent by source key.
 *
 * A booking with `remindAt` must run inside the caller's
 * `database.transactionAsync`: the appointment and its reminder commit as one
 * pair, so a reminder refusal rolls the booking back with it. A booking
 * without `remindAt` is one atomic row and carries no such requirement.
 *
 * The reminder title fits the follow-up bound by construction: the service key
 * is at most 48 characters and the instant renders at 24.
 */
export async function bookAppointment(context, request) {
  const names = resolvedNames(context.moduleNames);
  const appointments = appointmentService({ modules: context.modules, names });
  const actor = context.actor;
  // Evidence names its author: an anonymous booking would hold a customer's
  // slot with nobody accountable for it, so a missing actor is refused.
  const who = requireActor(actor);
  const input = validateAppointmentRequest(request);
  const source = bindSourcePackage(input.source, context.consumer);
  const now = typeof context.now === 'function' ? context.now() : new Date().toISOString();
  // Derived before any read or write, so a key that cannot own a reminder
  // fails closed at validation time rather than mid-booking.
  const reminderKey = input.remindAt === null ? null : reminderSourceKey(input.sourceKey);

  // The overlap and idempotency reads below are exact-match — never a bounded
  // page: a booking that silently misses a row past a page boundary is a
  // double booking or a duplicate. Without an exact-match read neither
  // invariant can be checked, so a service without one fails closed before the
  // first read rather than booking blind.
  if (typeof appointments.listWhere !== 'function') {
    throw new AppError('The appointments package is installed without an exact-match read on its "appointment" records', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }

  // The pair promise, proven before the first write: with a reminder named,
  // the booking and its follow-up must commit together.
  if (input.remindAt !== null) requireBookingTransaction(appointments);

  const submitted = {
    subjectResource: input.subject.resource,
    subjectId: input.subject.id,
    subjectOwner: input.subject.owner,
    subjectOwnerPackage: input.subject.ownerPackage,
    teamMemberId: input.teamMemberId,
    serviceKey: input.serviceKey,
    priceCents: input.priceCents,
    currency: input.currency,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    notes: input.notes,
    // The reminder intent IS the booking's identity: the same source key with
    // a different reminder (added, removed or moved) is a different claim
    // behind the same key and is refused 409 rather than replayed into a
    // booking whose reminder row says something else.
    reminderSourceKey: reminderKey,
    reminderDueAt: input.remindAt,
    sourcePackage: source.package,
    sourceAction: source.action,
  };

  const existing = (await appointments.listWhere({ sourceKey: input.sourceKey }))[0];
  if (existing) {
    // A stable shape on every path: the replay answers with the same keys the
    // fresh booking does. With a reminder named, the reminder is re-issued
    // through work — which replays the identical reminder rather than
    // duplicating it, and heals a booking whose reminder was never created —
    // or an explicit null when no reminder handle is composed.
    return {
      appointment: replayOrConflict(existing, submitted),
      reminder: await replayReminder(context, { input, source }),
      replayed: true,
    };
  }

  // (Residual: two concurrent bookings can both read an empty slot and both
  // commit; a conditional write or slot lock in core would close the window.
  // The loser of a source-key race still replays.)
  const held = await appointments.listWhere({ teamMemberId: input.teamMemberId });
  const conflict = findOverlap({ teamMemberId: input.teamMemberId, startMs: input.startMs, endMs: input.endMs }, held);
  if (conflict) {
    throw new AppError(
      `The team member "${input.teamMemberId}" already holds an appointment overlapping this slot `
        + `(${conflict.startsAt} to ${conflict.endsAt}, status "${conflict.status}"): one member holds one slot at a time. `
        + 'Cancel the held booking to free the slot, or book another member.',
      { code: 'APPOINTMENTS_OVERLAP', status: 409, details: { conflictingId: conflict.id ?? null, status: conflict.status ?? null } },
    );
  }

  let appointment;
  try {
    appointment = await appointments.createManaged({
      sourceKey: input.sourceKey,
      ...submitted,
      subjectLabel: input.subject.label,
      status: APPOINTMENT_INITIAL,
      reminderSourceKey: reminderKey,
      reminderDueAt: input.remindAt,
      bookedAt: now,
      decidedAt: null,
      cancelReason: null,
      actorType: who.type,
      actorId: who.id,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = (await appointments.listWhere({ sourceKey: input.sourceKey }))[0];
    if (!raced) throw error;
    return {
      appointment: replayOrConflict(raced, submitted),
      reminder: await replayReminder(context, { input, source }),
      replayed: true,
    };
  }

  let reminder = null;
  if (input.remindAt !== null) {
    reminder = await createReminder(context, { input, source });
  }
  return { appointment, reminder, replayed: false };
}

/**
 * Open the one reminder follow-up for a fresh booking, through the work
 * package's `follow-up@1` capability — never by writing the work tables
 * directly. The title fits the 200-character follow-up bound by construction.
 */
async function createReminder(context, { input, source }) {
  const followUps = context.followUps;
  if (!followUps || typeof followUps.createFollowUp !== 'function') {
    throw new AppError(
      'The appointments package is composed without an opened work follow-up@1 capability, so a booking with remindAt cannot schedule its reminder',
      { code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500 },
    );
  }
  const { task, activity, replayed } = await followUps.createFollowUp(reminderRequest(input, source));
  return { task, activity, replayed: replayed ?? false };
}

/**
 * The reminder half of a replay: with a reminder named, the identical reminder
 * is re-issued through work — which replays it rather than duplicating it,
 * and heals a booking whose reminder was never created — or an explicit null
 * when no reminder handle is composed. Without a reminder named there is
 * nothing to re-issue: an explicit null keeps the shape stable.
 */
async function replayReminder(context, { input, source }) {
  if (input.remindAt === null) return null;
  const followUps = context.followUps;
  if (!followUps || typeof followUps.createFollowUp !== 'function') return null;
  const { task, activity, replayed } = await followUps.createFollowUp(reminderRequest(input, source));
  return { task, activity, replayed: replayed ?? true };
}

/**
 * Move one booking one step along its lifecycle: `booked -> confirmed`, then
 * `confirmed -> done`, `confirmed -> no-show`, or either of the open states
 * `-> cancelled` with a reason. Anything else — including any move from a
 * terminal state — is a 409 naming the moves the current state allows. A
 * cancellation without a reason is refused: a cancelled slot nobody can
 * explain is not evidence.
 *
 * The move is enforced against the row as stored, re-read inside this call —
 * never against the caller-supplied copy, which another writer may have moved
 * since it was read. A stale copy advancing from a state the row already left
 * is refused 409. (Residual: two advances racing between the re-read and the
 * write can still interleave; inside a package action the transaction envelope
 * closes the window.)
 */
export async function advanceAppointment({ appointments, actor, now }, record, to, reason) {
  // A state change names its author, like the booking path does: an undefined
  // actor would flow into the audit write for a lifecycle mutation.
  requireActor(actor);
  if (!appointments?.get || !appointments?.applyManaged) {
    throw new AppError('The appointments package is installed without a managed "appointment" record module', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  const target = typeof to === 'string' ? to.trim() : to;
  // The fresh row, not the caller's copy: the transition below is enforced
  // against what is stored now. A row deleted since it was read surfaces the
  // storage's own miss rather than advancing a ghost.
  const current = await appointments.get(record.id);
  const allowed = APPOINTMENT_TRANSITIONS[current.status] ?? [];
  if (!APPOINTMENT_STATES.includes(target) || !allowed.includes(target)) {
    throw new AppError(
      `An appointment in state "${current.status}" cannot advance to "${target}"`
        + (allowed.length > 0 ? `; it may advance to ${allowed.join(' or ')}` : '; it is terminal and advances nowhere'),
      { code: 'APPOINTMENTS_INVALID_STATE', status: 409, details: { from: current.status, to: target, allowed } },
    );
  }
  const cancelReason = target === CANCELLED_STATE
    ? safeText(reason, 'cancelReason', MAX_REASON)
    : null;
  if (target !== CANCELLED_STATE && reason !== undefined && reason !== null && reason !== '') {
    throw new ValidationError('cancelReason is recorded only when an appointment is cancelled', { field: 'cancelReason' });
  }
  const stamp = typeof now === 'function' ? now() : new Date().toISOString();
  return appointments.applyManaged(current.id, { status: target, cancelReason, decidedAt: stamp }, { actor });
}

/**
 * Exact read of one appointment by row id — a primary-key lookup, never a
 * scan. Only the expected miss becomes absence: a storage or connection
 * failure is the caller's outage to see, never a quiet unknown appointment.
 */
export async function readAppointment({ appointments }, id) {
  const rowId = safeText(id, 'id', MAX_ID);
  if (!appointments?.get) {
    throw new AppError('The appointments package is installed without a managed "appointment" record module', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  try {
    const row = await appointments.get(rowId);
    return Object.freeze({ ...row });
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * `appointment-book@1` — the only write path: book appointments and advance
 * them along the lifecycle. It is created with the caller's runtime handles
 * and writes through them; every booking is one row, idempotent by source
 * key, so a retry replays rather than duplicates. It hands out no service, no
 * table and no query handle. Reads are exact: one row by id, never a scan.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createAppointmentBookCapability({ moduleNames, provider, followUps } = {}) {
  const names = resolvedNames(moduleNames);
  /**
   * Open the reminder handle for this opener: an explicitly injected handle
   * wins (tests), otherwise the provider definition handed to the package
   * factory is opened with the opener's own modules — so the reminder writes
   * inside the opener's transaction with the provider's name resolution.
   * No handle is fine until a booking names remindAt; then it fails closed
   * naming the edge.
   */
  const openFollowUps = (context) => {
    if (followUps ?? context.followUps) return followUps ?? context.followUps;
    if (!provider || typeof provider.create !== 'function') return null;
    return provider.create({
      modules: context.modules,
      actor: context.actor,
      now: context.now,
      consumer: APPOINTMENTS_PACKAGE,
    });
  };
  const scoped = (context) => ({
    modules: {
      get: (name) => context.modules.get(name === APPOINTMENT_MODULE ? names.appointment : name),
    },
    moduleNames: { [APPOINTMENT_MODULE]: names.appointment },
    actor: context.actor,
    now: context.now,
    consumer: context.consumer,
    followUps: openFollowUps(context),
  });
  return {
    name: 'appointment-book',
    version: 1,
    description:
      'Book one appointment per call — validated, overlap-checked against the team member\'s held slots, stored as booked — '
      + 'and advance it along the booking lifecycle. A booking with remindAt also opens exactly one work follow-up reminder '
      + 'in the same transaction. Every write is idempotent by source key. Grants no read beyond the written row and the exact id lookup, no update and no delete.',
    /** @param {{modules: any, actor?: unknown, now?: () => string, consumer?: string, followUps?: any}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('appointment-book@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const scope = scoped(context);
      const storage = () => appointmentService({ modules: scope.modules, names });
      return Object.freeze({
        capabilityContract: 1,
        /** @param {unknown} request */
        bookAppointment: (request) => bookAppointment(scope, request),
        /** @param {unknown} record @param {unknown} to @param {unknown} [reason] */
        advanceAppointment: (record, to, reason) => advanceAppointment(
          { appointments: storage(), actor: scope.actor, now: scope.now }, record, to, reason,
        ),
        /** @param {unknown} id */
        appointment: (id) => readAppointment({ appointments: storage() }, id),
      });
    },
  };
}

export { safeText, optionalSafeText };
