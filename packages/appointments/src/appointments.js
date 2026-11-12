// @ts-check

import { createHash } from 'node:crypto';

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
 *   `follow-up@1` capability inside the booking transaction. A booking that
 *   also names `reminderChannel` is sent at that instant by the reminder
 *   sweep (`./reminder-dispatch.js`): the durable-job timer owns *when*,
 *   this package owns *what is asked*, the channels seam owns the send and
 *   the interactions seam owns the history — the division of labour
 *   `packages/core/src/domain-timers.js` states, extended to the send.
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
// The reminder channel coordinates, mirrored from the packages that own
// them (a cross-package source import is forbidden, so the shapes are
// restated here and re-proved by the owner at send time): the space slug
// follows channels' `assertSpaceId`, the template name and language follow
// the WhatsApp adapter's `TEMPLATE_NAME`/`TEMPLATE_LANGUAGE`, and the
// recipient is an E.164 number the adapter canonicalizes strictly.
const SPACE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
/**
 * Voce 785428ec3de0: a shared-host space is named by its workspace id, a
 * lowercase UUID, and about two in three of those start with a digit, which
 * the slug rule refused («spaceId must be a lowercase slug…») — every call
 * read of such a space failed. A canonical lowercase UUID is accepted beside
 * the slug; nothing else widens.
 */
const SPACE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isSpaceId = (value) => SPACE_ID_RE.test(value) || SPACE_UUID_RE.test(value);
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,64}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2}(?:_[A-Z]{2})?$/;
const RECIPIENT_RE = /^\+[0-9][0-9 .\-()/]{3,}$/;
const MAX_CONNECTION_KEY = 200;
const MAX_RECIPIENT = 64;
const MAX_TEMPLATE_VARIABLES = 32;
const MAX_VARIABLE_CHARS = 1024;
// (The history-identity fit is checked through reminderThreadKey and
// reminderMessageKey themselves at booking time: one bound, one place.)

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
  const sourceKey = validateSourceKey(value.sourceKey, 'sourceKey');
  const reminderChannel = validateReminderChannel(value.reminderChannel, remindAt);
  if (reminderChannel !== null) {
    // One bound, one place: the derivation throws naming it when the
    // booking key leaves no room for the history identities.
    reminderThreadKey(sourceKey);
    reminderMessageKey(sourceKey);
  }
  return {
    sourceKey,
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
    reminderChannel,
    source: validateSource(value.source),
  };
}

/**
 * Owner busy blocks (backlog:af190faf): a commitment with no guest holds its
 * member like a booking, without becoming a booking — no customer, no
 * appointment row. Shape `{ teamMemberId, startsAt, endsAt, title? }`, the
 * same shape the Google sync writes.
 *
 * One source of truth, server-side only: blocks enter this package ONLY
 * through the composed `calendarSync` handle (`listOwnerBlocks`), never
 * through caller/request input. A request `busyBlocks` key is never read —
 * omitting it changes nothing and forging it changes nothing — so the write
 * paths cannot be bypassed by dropping the field and the GET routes carry
 * no private titles in the URL. The deployment that wires the handle (its
 * own calendar-sync store) gets enforcement; a composition without the
 * handle keeps main behaviour (no blocks). A wired store that cannot be
 * read fails the call closed (503 `APPOINTMENTS_OWNER_BLOCKS_UNAVAILABLE`,
 * cause kept): never an empty block list over unknown state.
 *
 * Every block is proven up front, on every path (week read, suggestion,
 * proposal, booking): exactly `{ teamMemberId, startsAt, endsAt, title? }` —
 * any other key (`status`, `id`, `kind`, ...) is refused, so a crafted entry
 * can never flip the owner/appointment discriminator. The member identity
 * is trimmed exactly like the member filter, so a padded store identity
 * holds its member instead of silently holding nobody. An unattributed or
 * unprovable entry fails closed 400 (field `busyBlocks`) on every path
 * alike: grid and booking never disagree. No wildcard — a block holds
 * exactly the member it names.
 *
 * @param {any} calendarSync the composed calendar-sync handle, or null
 * @param {string} teamMemberId the member the caller checks (already normalized)
 * @param {string} fromIso window start, ISO instant
 * @param {string} toIso window end, ISO instant
 * @returns {Promise<Array<object>>} the proven blocks holding that member, tagged
 */
async function ownerBlocksFor(calendarSync, teamMemberId, fromIso, toIso) {
  if (!calendarSync || typeof calendarSync.listOwnerBlocks !== 'function') return [];
  let found;
  try {
    found = await calendarSync.listOwnerBlocks({ teamMemberId, from: fromIso, to: toIso });
  } catch (error) {
    throw new AppError(
      'The owner-hold store did not answer: the slot is refused instead of booked over unknown state.',
      { code: 'APPOINTMENTS_OWNER_BLOCKS_UNAVAILABLE', status: 503, cause: error },
    );
  }
  if (found === undefined || found === null) {
    throw new AppError(
      'The owner-hold store answered nothing: the slot is refused instead of booked over unknown state.',
      { code: 'APPOINTMENTS_OWNER_BLOCKS_UNAVAILABLE', status: 503 },
    );
  }
  return proveOwnerBlocks(found).filter((block) => block.teamMemberId === teamMemberId);
}

/** The tag an owner block carries from construction: the only discriminator. */
const OWNER_BLOCK_KIND = 'owner-block';

/** The only keys a server-provided owner block may carry. */
const OWNER_BLOCK_KEYS = Object.freeze(['teamMemberId', 'startsAt', 'endsAt', 'title']);

/**
 * Prove server-provided owner blocks: closed shape, trimmed identity,
 * provable slot, tagged at construction. A store bug surfaces as a 400 the
 * deployment fixes, never as storage corruption and never as a free slot.
 *
 * @param {unknown} value the store answer
 * @returns {Array<object>} the proven blocks, in store order
 */
function proveOwnerBlocks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('owner blocks must be an array of owner blocks: one member holds one slot at a time', {
      field: 'busyBlocks',
    });
  }
  return value.map((block, index) => {
    const where = `busyBlocks[${index}]`;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new ValidationError(`${where} must be an object { teamMemberId, startsAt, endsAt, title? }: a hold nobody described holds nobody`, {
        field: 'busyBlocks',
      });
    }
    for (const key of Object.keys(block)) {
      if (!OWNER_BLOCK_KEYS.includes(key)) {
        throw new ValidationError(`${where} carries no "${key}": an owner block is exactly { teamMemberId, startsAt, endsAt, title? }`, {
          field: 'busyBlocks',
        });
      }
    }
    let member;
    try {
      member = safeText(block.teamMemberId, 'teamMemberId', MAX_ID);
    } catch {
      throw new ValidationError(`${where}.teamMemberId must be a non-empty member identity: an unattributed hold is refused, never widened to the whole team`, {
        field: 'busyBlocks',
      });
    }
    const startMs = Date.parse(block.startsAt);
    const endMs = Date.parse(block.endsAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new ValidationError(`${where} must name a provable slot (startsAt before endsAt): an unprovable hold fails closed, never reads as free`, {
        field: 'busyBlocks',
      });
    }
    if (block.title !== undefined && block.title !== null && typeof block.title !== 'string') {
      throw new ValidationError(`${where}.title must be a string when named`, {
        field: 'busyBlocks',
      });
    }
    return {
      teamMemberId: member, startsAt: block.startsAt, endsAt: block.endsAt, title: block.title, kind: OWNER_BLOCK_KIND,
    };
  });
}

/**
 * The no-double-booking invariant: one team member holds one slot at a time.
 * Two half-open slots `[startsAt, endsAt)` overlap when each starts before the
 * other ends; back-to-back slots share an endpoint and do not overlap. A
 * cancelled booking holds nothing — cancelling is how a slot is freed — but
 * every other state holds its slot even after it ends, because the slot was
 * real: the member was busy then, and the row is the evidence. An owner busy
 * block (backlog:af190faf, tagged `kind: 'owner-block'` at construction by
 * `proveOwnerBlocks`) holds its slot the same way: the member is busy then,
 * with no guest and no appointment row. Behaviour is keyed ONLY on that tag,
 * never on `status === undefined`: a closed shape at the boundary means a
 * block can carry no `status` at all, so `cancelled` can never turn a hold
 * into a free slot.
 *
 * @param {{teamMemberId: string, startMs: number, endMs: number}} candidate
 * @param {Array<any>} held the team member's existing rows, tagged owner blocks included
 * @returns {any|null} the conflicting row or block, or null
 */
export function findOverlap(candidate, held) {
  for (const row of held ?? []) {
    if (!row || row.status === CANCELLED_STATE) continue;
    const startMs = Date.parse(row.startsAt);
    const endMs = Date.parse(row.endsAt);
    // A held row whose slot cannot be proven is a corrupt witness, never a
    // free slot: ignoring it would silently switch the no-double-booking
    // invariant off, so the booking is refused instead of booked over it.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      const kind = row.kind === OWNER_BLOCK_KIND ? 'owner block' : 'appointment';
      throw new AppError(
        `The held ${kind} "${typeof row.id === 'string' && row.id !== '' ? row.id : 'unknown'}" carries a slot this package cannot prove `
        + `(startsAt "${String(row.startsAt)}", endsAt "${String(row.endsAt)}"): a booking overlapping an unprovable slot is refused, never booked over it.`,
        {
          code: 'APPOINTMENTS_STORAGE_INVALID',
          status: 500,
          details: { rowId: typeof row.id === 'string' ? row.id : null, status: row.status ?? null },
        },
      );
    }
    if (startMs < candidate.endMs && candidate.startMs < endMs) return row;
  }
  return null;
}

/**
 * The 409 a held slot answers (backlog:af190faf): a booking conflict names
 * the held appointment; an owner-block conflict stays generic — the block
 * title is the owner's private commitment (medical, personal) and must never
 * leak to a booker probing slots, so the refusal names only the held range.
 * The title stays in the authorized backoffice week read (`busy[].title`),
 * where the operator already sees the member's commitments. Same code, same
 * status, same details shape either way.
 *
 * @param {string} teamMemberId
 * @param {any} conflict the row or block `findOverlap` returned
 * @returns {AppError}
 */
function overlapRefusal(teamMemberId, conflict) {
  if (conflict && conflict.kind === OWNER_BLOCK_KIND) {
    return new AppError(
      `The team member "${teamMemberId}" holds an owner commitment overlapping this slot `
        + `(${conflict.startsAt} to ${conflict.endsAt}): one member holds one slot at a time. `
        + 'Book another slot, or book another member.',
      { code: 'APPOINTMENTS_OVERLAP', status: 409, details: { conflictingId: null, status: null } },
    );
  }
  return new AppError(
    `The team member "${teamMemberId}" already holds an appointment overlapping this slot `
      + `(${conflict.startsAt} to ${conflict.endsAt}, status "${conflict.status}"): one member holds one slot at a time. `
      + 'Cancel the held booking to free the slot, or book another member.',
    { code: 'APPOINTMENTS_OVERLAP', status: 409, details: { conflictingId: conflict.id ?? null, status: conflict.status ?? null } },
  );
}

/**
 * **One member, one writer at a time — in this process.**
 *
 * The overlap check is a read-then-write: two bookings for the same member
 * interleaved on one process both read an empty slot and both commit. The
 * chain below serializes them per team member — a process-local advisory
 * lock, one FIFO chain per member identity. Acquisition attaches
 * synchronously (no `await` before the chain is extended), so two callers
 * racing in the same tick still order; the waiter re-reads after the winner
 * commits and gets the 409 the invariant promises. Different members never
 * contend. Entries are removed when their chain drains, so the map holds
 * only members with a booking in flight.
 *
 * This closes the same-process window. Across connections the handle
 * transaction below serializes writers on real storage: SQLite
 * `BEGIN IMMEDIATE` makes the second connection wait for the winner's commit
 * and re-read it, Postgres `SERIALIZABLE` refuses the loser with a retryable
 * conflict whose retry re-reads the winner. The two-connection race test
 * proves the SQLite leg on a real file database.
 */
const memberBookingChains = new Map();

/**
 * One appointment, one advancer at a time — in this process.
 *
 * `advanceAppointment` re-reads the row and then writes the transition: two
 * advances interleaved on one process can both read `booked` before either
 * writes, and both write `confirmed` — duplicate audit/events — or a stale
 * confirmation can overwrite a concurrent cancellation. The chain below
 * serializes the re-read and the write per appointment id, with the same
 * attach-synchronously discipline as the booking chain above, so the loser
 * re-reads the winner's committed transition (409, never a silent
 * overwrite). Across connections the booking envelope below serializes
 * writers on real storage — SQLite `BEGIN IMMEDIATE` holds the second
 * connection until the winner commits, Postgres `SERIALIZABLE` refuses the
 * loser with a retryable conflict whose retry re-reads the winner. The two
 * chains nest only in one fixed order — a reschedule holds the member chain
 * outside and the id chain inside, an advance holds only the id chain —
 * so they cannot deadlock each other.
 */
const appointmentAdvanceChains = new Map();

/** @param {string} recordId @param {() => Promise<any>} critical */
async function withAppointmentAdvance(recordId, critical) {
  const previous = appointmentAdvanceChains.get(recordId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  appointmentAdvanceChains.set(recordId, tail);
  // Synchronous until here: two callers racing in the same tick still order.
  await previous;
  try {
    return await critical();
  } finally {
    // Remove only our own tail: a waiter queued behind us owns the slot now.
    if (appointmentAdvanceChains.get(recordId) === tail) appointmentAdvanceChains.delete(recordId);
    release();
  }
}

/** @param {string} teamMemberId @param {() => Promise<any>} critical */
async function withMemberBooking(teamMemberId, critical) {
  const previous = memberBookingChains.get(teamMemberId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  // Tails never reject (the second handler joins even after a refusal), so a
  // refused booking never wedges the member's chain — but the join is kept
  // explicit rather than assumed.
  const tail = previous.then(() => current, () => current);
  memberBookingChains.set(teamMemberId, tail);
  // Synchronous until here: two callers racing in the same tick still order.
  await previous;
  try {
    return await critical();
  } finally {
    // Remove only our own tail: a waiter queued behind us owns the slot now.
    if (memberBookingChains.get(teamMemberId) === tail) memberBookingChains.delete(teamMemberId);
    release();
  }
}

/**
 * The outer transaction the overlap re-read and the insert commit in, when
 * the service exposes one and the caller is not already inside it.
 *
 * A booking with `remindAt` always runs inside the caller's transaction (the
 * pair promise, proven above). A booking without one is a single row today,
 * so its re-read and its insert are two separate commits — the window the
 * chain above cannot close across connections. When the service carries a
 * real database handle and no transaction is open, the critical section runs
 * inside that handle's own `transactionAsync` instead: on SQLite that is
 * `BEGIN IMMEDIATE`, so a second connection's `BEGIN` waits for the winner's
 * commit and then re-reads the winner — 409, never a silent double booking
 * (a busy timeout past the winner's commit surfaces a retryable conflict
 * whose retry re-reads the winner); on Postgres that is `SERIALIZABLE`, so
 * the loser gets a retryable serialization conflict with the same retry
 * into the 409. Inside a caller transaction, or without a storage handle,
 * the section runs as it does today.
 *
 * @param {any} appointments the resolved appointment module service
 */
function bookingTransaction(appointments) {
  const transactionAsync = appointments?.database?.transactionAsync;
  if (typeof transactionAsync !== 'function') return null;
  if (proveCallerTransaction([appointments]) !== TRANSACTION_PROOF.NO_TRANSACTION) return null;
  return (/** @type {() => Promise<any>} */ critical) => transactionAsync.call(appointments.database, critical);
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
 * Where the reminder goes, named at booking time: the space and connection
 * that send it, the customer's WhatsApp number, and the approved template
 * with its variables. A channel without an instant is a send that never
 * fires, so it is refused — `remindAt` carries the instant, this carries
 * the address. The shapes are checked here and re-proved by the channels
 * seam at booking time (`checkSendable`) and again at send time, so a
 * stored row always names a target the adapter accepts.
 *
 * @param {unknown} value @param {string|null} remindAt
 */
export function validateReminderChannel(value, remindAt) {
  if (value === undefined || value === null) return null;
  if (remindAt === null) {
    throw new ValidationError('reminderChannel needs remindAt: a send with no instant sends never', {
      field: 'reminderChannel',
    });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('reminderChannel must be an object {spaceId, connectionKey, to, template}', {
      field: 'reminderChannel',
    });
  }
  const channel = /** @type {any} */ (value);
  const spaceId = safeText(channel.spaceId, 'reminderChannel.spaceId', 63);
  if (!isSpaceId(spaceId)) {
    throw new ValidationError('reminderChannel.spaceId must be a lowercase slug (letters, digits, hyphens, starting with a letter) or a workspace id', {
      field: 'reminderChannel.spaceId',
    });
  }
  const connectionKey = safeText(channel.connectionKey, 'reminderChannel.connectionKey', MAX_CONNECTION_KEY);
  const to = safeText(channel.to, 'reminderChannel.to', MAX_RECIPIENT);
  if (!RECIPIENT_RE.test(to)) {
    throw new ValidationError('reminderChannel.to must be an E.164 number ("+" followed by digits)', {
      field: 'reminderChannel.to',
    });
  }
  const template = channel.template;
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new ValidationError('reminderChannel.template must be an object {name, language?, variables?}', {
      field: 'reminderChannel.template',
    });
  }
  const name = safeText(template.name, 'reminderChannel.template.name', 64);
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new ValidationError('reminderChannel.template.name must be a Meta template name (lowercase letters, digits, underscores)', {
      field: 'reminderChannel.template.name',
    });
  }
  const language = template.language === undefined || template.language === null || template.language === ''
    ? null
    : safeText(template.language, 'reminderChannel.template.language', 16);
  if (language !== null && !TEMPLATE_LANGUAGE_RE.test(language)) {
    throw new ValidationError('reminderChannel.template.language must look like "it" or "it_IT"', {
      field: 'reminderChannel.template.language',
    });
  }
  const variables = template.variables === undefined || template.variables === null ? [] : template.variables;
  if (!Array.isArray(variables) || variables.length > MAX_TEMPLATE_VARIABLES
    || variables.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > MAX_VARIABLE_CHARS
      || CONTROL_RE.test(entry))) {
    throw new ValidationError(
      'reminderChannel.template.variables must be a bounded list of non-empty single-line text '
      + `(at most ${MAX_TEMPLATE_VARIABLES}, at most ${MAX_VARIABLE_CHARS} chars each)`,
      { field: 'reminderChannel.template.variables' },
    );
  }
  return {
    spaceId,
    connectionKey,
    to,
    template: { name, language, variables: [...variables] },
  };
}

/**
 * The deterministic business identities of the reminder send: the history
 * thread the send is recorded in and the outbound message row. One booking
 * owns at most one of each, and a retried sweep replays them rather than
 * duplicating them. Derived from the booking source key, like the
 * follow-up identity above — and for the same reason the booking key stays
 * short enough to fit them, checked at booking time.
 *
 * @param {string} sourceKey
 */
export function reminderThreadKey(sourceKey) {
  // The interaction sourceKey bound: the history thread row must satisfy
  // it, and this package owns the derivation. Checked again at booking
  // time through this same function, so a stored booking always fits.
  const derived = `appointment:${sourceKey}:reminder:thread`;
  if (derived.length > 200) {
    throw new ValidationError(
      'a booking with reminderChannel needs a sourceKey of at most 171 characters, '
      + 'so the derived history identities fit the interaction bound',
      { field: 'sourceKey' },
    );
  }
  return derived;
}

/** @param {string} sourceKey */
export function reminderMessageKey(sourceKey) {
  const derived = `appointment:${sourceKey}:reminder:send`;
  if (derived.length > 200) {
    throw new ValidationError(
      'a booking with reminderChannel needs a sourceKey of at most 171 characters, '
      + 'so the derived history identities fit the interaction bound',
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
    // booking whose reminder row says something else. The send target rides
    // the same identity: a retry that moves the channel, the recipient or
    // the template is a different claim, not a replay. Stored as given and
    // validated — the adapter canonicalizes deterministically at send time,
    // so a retry compares exactly what the first booking stored.
    reminderSourceKey: reminderKey,
    reminderDueAt: input.remindAt,
    reminderSpaceId: input.reminderChannel?.spaceId ?? null,
    reminderConnectionKey: input.reminderChannel?.connectionKey ?? null,
    reminderTo: input.reminderChannel?.to ?? null,
    reminderTemplateName: input.reminderChannel?.template.name ?? null,
    reminderTemplateLanguage: input.reminderChannel?.template.language ?? null,
    reminderTemplateVars: input.reminderChannel ? JSON.stringify(input.reminderChannel.template.variables) : null,
    sourcePackage: source.package,
    sourceAction: source.action,
  };

  // The check-then-act below runs serialized per team member on every path:
  // the member chain above orders same-process bookings so the loser re-reads
  // the winner's committed row (409, or a replay for the same key), and the
  // handle transaction below serializes writers across connections — SQLite
  // BEGIN IMMEDIATE holds the second connection until the winner commits, so
  // it re-reads the winner (409); the source-key unique guard below only
  // replays same-key races and never meets different source keys, so this
  // serialization — not the guard — is what refuses the cross-connection
  // double booking, proven by the two-connection race test.
  // (A busy timeout past the winner's commit, or a Postgres serialization
  // abort, surfaces a retryable conflict whose retry re-reads the winner.)
  const runCritical = async () => {
    const existing = (await appointments.listWhere({ sourceKey: input.sourceKey }))[0];
    if (existing) {
      // A stable shape on every path: the replay answers with the same keys the
      // fresh booking does. With a reminder named, the reminder is re-issued
      // through work — which replays the identical reminder rather than
      // duplicating it, and heals a booking whose reminder was never created —
      // or fails APPOINTMENTS_REMINDER_UNAVAILABLE when no reminder handle is
      // composed, exactly like the fresh path.
      return {
        appointment: replayOrConflict(existing, submitted),
        reminder: await replayReminder(context, { input, source }),
        replayed: true,
      };
    }

    const held = await appointments.listWhere({ teamMemberId: input.teamMemberId });
    // Owner holds come only from the composed calendar-sync handle — a
    // request `busyBlocks` key is never read, so omitting or forging it
    // changes nothing on the write path.
    const blocks = await ownerBlocksFor(context.calendarSync, input.teamMemberId, input.startsAt, input.endsAt);
    const conflict = findOverlap({ teamMemberId: input.teamMemberId, startMs: input.startMs, endMs: input.endMs },
      [...held, ...blocks]);
    if (conflict) {
      throw overlapRefusal(input.teamMemberId, conflict);
    }

    // The send target is proven before the first write: a fresh booking that
    // names a channel that cannot send (unknown connection, unapproved
    // template, malformed recipient) is refused here, not at the instant.
    // A replay answers the stable shape without re-proving: the stored row
    // already fixed the target, and the sweep enforces it again at fire
    // time — so a revoked connection fails the send, never the replay.
    if (input.reminderChannel !== null) {
      await checkReminderSendable(context, { input });
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
        reminderSentAt: null,
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
  };

  const runInTransaction = bookingTransaction(appointments);
  return withMemberBooking(
    input.teamMemberId,
    runInTransaction ? () => runInTransaction(runCritical) : runCritical,
  );
}

/**
 * The opened work follow-up handle, or a named refusal: a booking that names
 * a reminder cannot schedule it — fresh or replayed — without the handle. A
 * replay that answers null next to a stored reminderDueAt would report a
 * missing reminder as success, so the replay fails exactly like the fresh
 * path; only a booking with no reminder named answers an explicit null.
 */
function requireFollowUps(context) {
  const followUps = context.followUps;
  if (!followUps || typeof followUps.createFollowUp !== 'function') {
    throw new AppError(
      'The appointments package is composed without an opened work follow-up@1 capability, so a booking with remindAt cannot schedule its reminder',
      { code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500 },
    );
  }
  return followUps;
}

/**
 * The opened channels template-send handle, or a named refusal: a fresh
 * booking that names a send target cannot prove it without the handle. The
 * edge is optional — bookings without `reminderChannel` never touch it, so
 * a composition without channels books exactly as before.
 */
function requireTemplateSend(context) {
  const templateSend = context.templateSend;
  if (!templateSend || typeof templateSend.checkSendable !== 'function' || typeof templateSend.sendTemplate !== 'function') {
    throw new AppError(
      'The appointments package is composed without an opened channels channel-template-send@1 capability, '
      + 'so a booking with reminderChannel cannot prove its send target',
      { code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500 },
    );
  }
  return templateSend;
}

/**
 * Prove the reminder send target before the booking row exists: the
 * connection is active and the template is approved for it. Proof only —
 * nothing is sent, and the stored row keeps the validated as-given values.
 */
async function checkReminderSendable(context, { input }) {
  const templateSend = requireTemplateSend(context);
  const channel = /** @type {any} */ (input.reminderChannel);
  const template = channel.template;
  await templateSend.checkSendable({
    actor: context.actor,
    spaceId: channel.spaceId,
    connectionKey: channel.connectionKey,
    to: channel.to,
    template: {
      name: template.name,
      ...(template.language ? { language: template.language } : {}),
      variables: [...template.variables],
    },
  });
}

/**
 * Open the one reminder follow-up for a fresh booking, through the work
 * package's `follow-up@1` capability — never by writing the work tables
 * directly. The title fits the 200-character follow-up bound by construction.
 */
async function createReminder(context, { input, source }) {
  const followUps = requireFollowUps(context);
  const { task, activity, replayed } = await followUps.createFollowUp(reminderRequest(input, source));
  return { task, activity, replayed: replayed ?? false };
}

/**
 * The reminder half of a replay: with a reminder named, the identical reminder
 * is re-issued through work — which replays it rather than duplicating it,
 * and heals a booking whose reminder was never created. Without a reminder
 * named there is nothing to re-issue: an explicit null keeps the shape
 * stable.
 */
async function replayReminder(context, { input, source }) {
  if (input.remindAt === null) return null;
  const followUps = requireFollowUps(context);
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
 * is refused 409. The re-read and the write run serialized per appointment
 * id on this process, and inside the storage handle's own transaction on a
 * real database when one is available and no caller transaction is open —
 * so two confirms of one booking advance once (the loser re-reads the
 * winner's `confirmed` and answers it), and a confirm racing a cancellation
 * never overwrites the winner.
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
  // The record names its row before anything is read: a null, undefined or
  // id-less record — e.g. a missed exact lookup forwarded straight into the
  // advance — is a typed ValidationError naming the field, never a TypeError
  // off an absent property. A well-formed id for a row deleted since it was
  // read surfaces the storage's own NotFoundError rather than advancing a
  // ghost.
  const recordId = safeText(record?.id, 'id', MAX_ID);
  const runInTransaction = bookingTransaction(appointments);
  const critical = async () => {
    const current = await appointments.get(recordId);
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
  };
  // The re-read and the write above are one critical section per appointment:
  // the id chain orders same-process advancers so the loser re-reads the
  // winner, and the booking envelope orders cross-connection writers on real
  // storage (reused here: it is generic over the record service, not tied to
  // the insert it was written for).
  return withAppointmentAdvance(
    recordId,
    runInTransaction ? () => runInTransaction(critical) : critical,
    );
}

/**
 * Move one booking to a new slot (backlog:bdca2010d471): the governed write
 * behind dragging a calendar event to another day or hour, or stretching its
 * bottom edge. The caller names the row by exactly one of `id` / `sourceKey`
 * and the new `startsAt` / `endsAt`; the move commits only when:
 *
 * - the actor is present (an anonymous move holds nobody accountable, like
 *   the booking path);
 * - the row is still movable (`booked` or `confirmed` — terminal states
 *   never regress: a repeated visit is a new booking, like everywhere else);
 * - no other booking of the same team member holds the new slot. The row
 *   itself is excluded, so a stretch over its own old slot is a longer
 *   booking, not a conflict. A real conflict is refused 409 with
 *   `APPOINTMENTS_OVERLAP` and an Italian message: it is the text the
 *   operator's confirm dialog shows.
 *
 * The check and the write run serialized per team member (the same member
 * chain the booking path holds) with a fresh re-read inside, and inside the
 * storage handle's own transaction on a real database when one is available
 * — so two concurrent moves onto one slot move once and the loser gets the
 * 409, the way concurrent bookings do.
 *
 * A drop without a move (same instants) is a no-op answering the stored row
 * with `moved: false`, never a second write. The stored reminder keeps its
 * `dueAt` only when the new slot still starts after it: a move that would
 * strand the reminder at or after the slot is refused, so the booking
 * invariant (`remindAt` before `startsAt`) survives the drag. When the
 * request names `calendar`, it also names the `spaceId` the push is gated
 * on (required, like the confirm path), and the linked Google event is
 * converged through the injected `calendarSync.pushAppointment` handle
 * after the commit, exactly like the confirm path: validated before any
 * row exists, answered as data (`push` / `pushError`) after it, never a
 * throw past the commit.
 */
export async function rescheduleAppointment(context, request) {
  const names = resolvedNames(context.moduleNames);
  const appointments = appointmentService({ modules: context.modules, names });
  // Evidence names its author: an anonymous move would hold a customer's
  // slot with nobody accountable for it, so a missing actor is refused.
  const who = requireActor(context.actor);
  const record = request && typeof request === 'object' ? request : {};
  const named = [record.id, record.sourceKey]
    .filter((value) => value !== undefined && value !== null);
  if (named.length !== 1) {
    throw new ValidationError('reschedule needs exactly one of id or sourceKey', {
      field: named.length === 0 ? 'id' : 'id/sourceKey',
    });
  }
  const startsAt = realIsoInstant(record.startsAt, 'startsAt');
  const endsAt = realIsoInstant(record.endsAt, 'endsAt');
  if (endsAt.ms <= startsAt.ms) {
    throw new ValidationError('endsAt must be after startsAt: a slot with no duration books nothing', { field: 'endsAt' });
  }
  if (endsAt.ms - startsAt.ms > MAX_SLOT_MS) {
    throw new ValidationError('an appointment slot is at most 24 hours: a longer hold is not a booking', { field: 'endsAt' });
  }
  // A named calendar is validated before any row is touched: a statically
  // preventable miscomposition fails here, never after a committed move the
  // caller received an error for — the same order the confirm path keeps.
  // The push is space-gated (a bound calendar syncs only for its owning
  // space), so a calendar move also names the spaceId, exactly like the
  // confirm path: without it a bound calendar would answer
  // CALENDAR_GRANT_UNKNOWN after the row already moved.
  let calendarId = null;
  let spaceId = null;
  let calendarPush = null;
  if (record.calendar !== undefined && record.calendar !== null) {
    if (typeof record.spaceId !== 'string' || record.spaceId.trim() === '') {
      throw new ValidationError('spaceId is required: a calendar move is gated on the space switch', { field: 'spaceId' });
    }
    spaceId = record.spaceId;
    calendarId = safeText(record.calendar.calendarId, 'calendar.calendarId', MAX_ID);
    const calendarSync = context?.calendarSync ?? null;
    if (!calendarSync || typeof calendarSync.pushAppointment !== 'function') {
      throw new AppError(
        'The reschedule names a calendar but the appointments package is composed without a calendar-sync push handle, '
        + 'so the event cannot be moved: reschedule without a calendar, or compose the push handle.',
        { code: 'APPOINTMENTS_CALENDAR_UNAVAILABLE', status: 500 },
      );
    }
    calendarPush = calendarSync.pushAppointment.bind(calendarSync);
  }
  if (!appointments?.get || !appointments?.applyManaged || typeof appointments?.listWhere !== 'function') {
    throw new AppError('The appointments package is installed without a managed "appointment" record module', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  const lookup = async () => {
    if (record.id !== undefined && record.id !== null) {
      const rowId = safeText(record.id, 'id', MAX_ID);
      try {
        return await appointments.get(rowId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new NotFoundError(`no appointment with id "${rowId}"`);
        }
        throw error;
      }
    }
    const key = validateSourceKey(record.sourceKey, 'sourceKey');
    const row = (await appointments.listWhere({ sourceKey: key }))[0] ?? null;
    if (!row) throw new NotFoundError(`no appointment with sourceKey "${key}"`);
    return row;
  };
  // The member is known only after the first read; the critical section
  // re-reads inside the member chain, so the check and the write see the
  // winner of any race that committed between the two reads.
  const first = await lookup();
  const memberId = typeof first.teamMemberId === 'string' && first.teamMemberId !== ''
    ? first.teamMemberId
    : safeText(first.teamMemberId, 'teamMemberId', MAX_ID);
  const runInTransaction = bookingTransaction(appointments);
  const critical = async () => {
    const current = await lookup();
    if (APPOINTMENT_TERMINAL.includes(current.status)) {
      throw new AppError(
        `An appointment in state "${current.status}" cannot be rescheduled; it is terminal and moves nowhere`,
        { code: 'APPOINTMENTS_INVALID_STATE', status: 409, details: { from: current.status, to: null } },
      );
    }
    if (current.startsAt === startsAt.iso && current.endsAt === endsAt.iso) {
      return { appointment: current, moved: false };
    }
    // The booking invariant survives the drag: the stored reminder still
    // fires before the slot. Re-read inside the critical section, so a
    // reminder written between the two reads is seen too.
    const dueAt = current.reminderDueAt ?? null;
    if (dueAt !== null && dueAt !== undefined && dueAt !== '') {
      const dueMs = Date.parse(dueAt);
      if (Number.isFinite(dueMs) && startsAt.ms <= dueMs) {
        throw new AppError(
          `The stored reminder is due at ${dueAt}: the new slot starts at ${startsAt.iso}, at or after the reminder, `
          + 'so nobody would be reminded before the appointment — move to a later slot or cancel the reminder first.',
          { code: 'APPOINTMENTS_REMINDER_AFTER_SLOT', status: 409, details: { reminderDueAt: dueAt } },
        );
      }
    }
    const held = await appointments.listWhere({ teamMemberId: current.teamMemberId });
    const others = held.filter((row) => row && row.id !== current.id);
    const blocks = await ownerBlocksFor(context.calendarSync, current.teamMemberId, startsAt.iso, endsAt.iso);
    const conflict = findOverlap(
      { teamMemberId: current.teamMemberId, startMs: startsAt.ms, endMs: endsAt.ms },
      [...others, ...blocks],
    );
    if (conflict) {
      if (conflict.kind === OWNER_BLOCK_KIND) {
        throw new AppError(
          `Il membro "${current.teamMemberId}" ha un impegno del titolare in questa fascia oraria `
          + `(dalle ${conflict.startsAt} alle ${conflict.endsAt}): `
          + "sposta l'appuntamento in una fascia libera oppure scegli un altro membro.",
          { code: 'APPOINTMENTS_OVERLAP', status: 409, details: { conflictingId: null, status: null } },
        );
      }
      throw new AppError(
        `Il membro "${current.teamMemberId}" ha già un altro appuntamento in questa fascia oraria `
        + `(dalle ${conflict.startsAt} alle ${conflict.endsAt}, stato "${conflict.status}"): `
        + "sposta l'appuntamento in una fascia libera oppure scegli un altro membro.",
        { code: 'APPOINTMENTS_OVERLAP', status: 409, details: { conflictingId: conflict.id ?? null, status: conflict.status ?? null } },
      );
    }
    return {
      appointment: await appointments.applyManaged(
        current.id,
        { startsAt: startsAt.iso, endsAt: endsAt.iso },
        { actor: who },
      ),
      moved: true,
    };
  };
  // The move serializes on the appointment identity as well as the member:
  // withMemberBooking outside, withAppointmentAdvance inside, always in
  // this order. A move racing a cancel or a confirm on the same row can no
  // longer commit from a stale read — the loser re-reads the winner inside
  // critical (the terminal check above runs under both chains) and either
  // refuses 409 or advances the winner's row, never a terminal row silently
  // moved to a new slot.
  const recordId = safeText(first.id, 'id', MAX_ID);
  const { appointment, moved } = await withMemberBooking(
    memberId,
    () => withAppointmentAdvance(
      recordId,
      runInTransaction ? () => runInTransaction(critical) : critical,
    ),
  );
  // The calendar edge was validated above, before any row was touched: the
  // push rides the idempotent path. A runtime push failure must not throw —
  // the moved row is already committed and the caller would observe a
  // failure for a move that happened — so it is answered as data. Only the
  // provider's code is surfaced, never its text.
  let push = null;
  let pushError = null;
  if (calendarPush !== null) {
    try {
      push = await calendarPush(calendarId, appointment.sourceKey, { spaceId, actor: who });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== ''
        ? error.code
        : 'APPOINTMENTS_CALENDAR_PUSH_FAILED';
      pushError = Object.freeze({ code });
    }
  }
  return Object.freeze({ appointment, moved, push, pushError });
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
 * Every appointment row naming this subject, soonest slot first. The read the
 * customer scheda renders as its Appuntamenti section: the same complete
 * exact-match query the booking path re-reads before every write, so a
 * booking the overlap check saw is a booking this read shows. Cancelled rows
 * stay listed — a cancelled slot is still evidence the customer once held it,
 * and the status names it.
 *
 * @param {{appointments: any}} storage
 * @param {unknown} subject the ADR-030 envelope pointing at the host record
 */
export async function readSchedule({ appointments }, subject) {
  const envelope = validateSubject(subject);
  if (!appointments || typeof appointments.listWhere !== 'function') {
    throw new AppError('The appointments package is installed without an exact-match read on its "appointment" records', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  const rows = await appointments.listWhere({
    subjectResource: envelope.resource,
    subjectId: envelope.id,
  });
  const bySlot = [...rows].sort((a, b) => (
    String(a.startsAt ?? '').localeCompare(String(b.startsAt ?? ''))
    || String(a.endsAt ?? '').localeCompare(String(b.endsAt ?? ''))
    || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  ));
  return Object.freeze(bySlot.map((row) => Object.freeze({
    id: row.id,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    serviceKey: row.serviceKey,
    teamMemberId: row.teamMemberId,
    priceCents: row.priceCents,
    currency: row.currency,
    notes: row.notes ?? null,
  })));
}

const MAX_TEAM_WEEK_MEMBERS = 32;
const MAX_TEAM_WEEK_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * One frozen week row for the BO-F3-01 team view: the same projection as
 * `readSchedule`, plus the `sourceKey` (the join key the calendar detail
 * reads the sync state through) and the subject envelope (who the slot is
 * for — the detail links it to the customer). Cancelled rows stay listed
 * with their status, like the scheda read: a cancelled slot is still
 * evidence the member once held it.
 */
/**
 * One frozen owner-block row for the BO-F3-01 team view (backlog:af190faf):
 * `{ startsAt, endsAt, title }`, null for a misshapen entry the strict
 * validation above already refused — a second net, never the first. The
 * title defaults to «Occupato»: a commitment with no guest has no customer
 * to name. Titles live only here, in the authorized backoffice read: booking
 * refusals stay generic so a booker can never probe private commitments.
 *
 * @param {any} block
 * @returns {object|null}
 */
function projectBusyWeekRow(block) {
  if (!block || typeof block !== 'object') return null;
  const startMs = Date.parse(block.startsAt);
  const endMs = Date.parse(block.endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const title = typeof block.title === 'string' && block.title.trim() !== ''
    ? block.title.trim().slice(0, 120) : 'Occupato';
  return Object.freeze({
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    title,
  });
}

function projectTeamWeekRow(row) {
  return Object.freeze({
    id: row.id,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    serviceKey: row.serviceKey,
    teamMemberId: row.teamMemberId,
    priceCents: row.priceCents,
    currency: row.currency,
    notes: row.notes ?? null,
    sourceKey: row.sourceKey,
    subject: Object.freeze({
      resource: row.subjectResource,
      id: row.subjectId,
      owner: row.subjectOwner,
      ownerPackage: row.subjectOwnerPackage ?? null,
    }),
  });
}

/**
 * The team week (BO-F3-01, "07 Calendario"): every appointment overlapping
 * `[from, to)` for each named team member, grouped per person, soonest slot
 * first. The caller passes the person filter as the member list itself — a
 * subset of members is a filtered week, and an empty list is refused rather
 * than answered with the whole team: a week for nobody is a caller bug, and
 * answering it with everyone's bookings would leak the roster it names.
 *
 * Reads are exact-match per member — the same reads the booking path
 * overlap-checks against, so a booking the overlap check saw is a booking
 * this week shows. No bounded page: a booking silently past a page boundary
 * is a booking the team cannot see but the member still holds. Members are
 * bounded instead (at most 32): the team is named per call, never scanned,
 * because there is no roster to scan — the same opaque identities bookings
 * already store.
 *
 * Owner commitments with no guest (backlog:af190faf) arrive only through the
 * composed `calendarSync` handle (`listOwnerBlocks`) — never through the
 * filter — and read as «Occupato» beside the bookings, so the grid paints
 * what the booking path refuses. The blocks are proven up front like on
 * every other path: a malformed store entry fails the read closed (400),
 * exactly like the booking and suggestion paths, so grid and booking agree.
 * The `busy` list is required on every member group (version 3): an empty
 * week reads `busy: []`, never an absent key.
 *
 * @param {{appointments: any, calendarSync?: any}} storage
 * @param {{teamMemberIds?: unknown, from?: unknown, to?: unknown}} filter
 */
export async function readTeamWeek({ appointments, calendarSync }, filter) {
  const value = filter && typeof filter === 'object' && !Array.isArray(filter) ? filter : {};
  if (!Array.isArray(value.teamMemberIds) || value.teamMemberIds.length === 0) {
    throw new ValidationError('teamMemberIds names at least one team member: a week for nobody books nothing to show', { field: 'teamMemberIds' });
  }
  if (value.teamMemberIds.length > MAX_TEAM_WEEK_MEMBERS) {
    throw new ValidationError(`teamMemberIds names at most ${MAX_TEAM_WEEK_MEMBERS} team members per call`, { field: 'teamMemberIds' });
  }
  const seen = new Set();
  const members = [];
  value.teamMemberIds.forEach((member, index) => {
    const id = safeText(member, `teamMemberIds[${index}]`, MAX_ID);
    if (!seen.has(id)) {
      seen.add(id);
      members.push(id);
    }
  });
  const from = realIsoInstant(value.from, 'from');
  const to = realIsoInstant(value.to, 'to');
  if (to.ms <= from.ms) {
    throw new ValidationError('to must be after from: a week with no duration shows nothing', { field: 'to' });
  }
  if (to.ms - from.ms > MAX_TEAM_WEEK_MS) {
    throw new ValidationError('a team week spans at most 31 days: a wider window is a report, not a week', { field: 'to' });
  }
  if (!appointments || typeof appointments.listWhere !== 'function') {
    throw new AppError('The appointments package is installed without an exact-match read on its "appointment" records', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  const groups = [];
  for (const teamMemberId of members) {
    const held = await appointments.listWhere({ teamMemberId });
    const overlapping = held.filter((row) => (
      String(row.startsAt ?? '') < to.iso && String(row.endsAt ?? '') > from.iso
    ));
    overlapping.sort((a, b) => (
      String(a.startsAt ?? '').localeCompare(String(b.startsAt ?? ''))
      || String(a.endsAt ?? '').localeCompare(String(b.endsAt ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? ''))
    ));
    const busy = (await ownerBlocksFor(calendarSync, teamMemberId, from.iso, to.iso))
      .map((block) => projectBusyWeekRow(block))
      .filter((projected) => projected !== null)
      .filter((projected) => projected.startsAt < to.iso && projected.endsAt > from.iso)
      .sort((a, b) => (
        a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt)
      ));
    groups.push(Object.freeze({
      teamMemberId,
      appointments: Object.freeze(overlapping.map(projectTeamWeekRow)),
      busy: Object.freeze(busy),
    }));
  }
  return Object.freeze({ from: from.iso, to: to.iso, members: Object.freeze(groups) });
}

/**
 * The BO-F3-02 booking flow ("07 Calendario"): propose slots from real
 * availability, confirm explicitly, book online idempotently.
 *
 * Three rules, one section:
 *
 * - Slots are read, never invented: `suggestSlots` steps the named window and
 *   keeps the steps no held booking overlaps, using the same exact-match
 *   reads and the same `findOverlap` invariant the booking path enforces. A
 *   held row whose slot cannot be proven fails the suggestion closed, exactly
 *   like it fails the booking — never a silent free slot over a corrupt row.
 * - Nothing is created without confirmation: `proposeBooking` never writes
 *   an appointment row. With the space's `book-appointments` switch on it
 *   answers a draft the caller confirms; with the switch off it records a
 *   `space-ai-proposal` through the permission gate and stops. `confirmBooking`
 *   refuses without `confirmed: true`, re-checks the switch, then books,
 *   advances `booked -> confirmed` and — when the caller names a calendar —
 *   pushes the event through calendar-sync.
 * - An online booking link is idempotent by construction: `bookFromLink`
 *   derives the booking source key deterministically from the link token and
 *   the slot, so a retried or doubled submission replays the winner's row
 *   (or 409s on a divergent claim) instead of writing a second booking, and
 *   the member serialization plus the source-key unique guard serialize the
 *   race. The link path reads the same `book-appointments` switch as
 *   propose/confirm: switch on books, switch off records a
 *   `space-ai-proposal` and stays a proposal — a published link never
 *   bypasses a switch the owner turned off.
 *
 * No new record, no new module: the flow reads and writes the appointment
 * rows, the work follow-up and the space-ai-proposal rows that already exist,
 * through the capabilities that already own them. Cross-package handles (the
 * permission gate, the phrase LLM, the calendar push) arrive injected and
 * opened — never imported, never re-instantiated here.
 */

/** The BO-F0-06 switch this flow gates agent-initiated bookings on. */
export const BOOK_APPOINTMENTS_PERMISSION = 'book-appointments';

/** The proposal kind recorded when the switch is off. */
export const PROPOSE_ACTION_KIND = 'book-appointment';

/** Step granularities a suggestion window may be cut into, in minutes. */
export const SUGGEST_SLOT_MINUTES = Object.freeze([15, 30, 45, 60, 90, 120]);

const MAX_SUGGEST_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_SUGGEST_STEPS_PER_MEMBER = 2000;
const MAX_PHRASE = 500;
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const LINK_SOURCE_PREFIX = 'booking-link:';
const DRAFT_SERVICE_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** The opened permission gate, or a named refusal when the flow needs one. */
function requireFlowPermissionGate(context) {
  const gate = context?.permissionGate ?? null;
  if (!gate || typeof gate.gate !== 'function' || typeof gate.propose !== 'function') {
    throw new AppError(
      'The appointments package is composed without an opened space-permission-gate@1 capability, '
      + 'so a permission-aware booking (propose or confirm with a space) cannot read the space switch',
      { code: 'APPOINTMENTS_PERMISSION_UNAVAILABLE', status: 500 },
    );
  }
  return gate;
}

/** The appointment record service behind the caller's modules view. */
function flowAppointments(context, names) {
  const service = resolveModule(context?.modules, names?.appointment)?.service;
  if (!service?.listWhere) {
    throw new AppError('The appointments package is installed without an exact-match read on its "appointment" records', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * Validate the suggestion filter: named members (never a scan — there is no
 * roster to scan), a bounded window, a step from the fixed set, and the
 * optional reference instant past steps are cut against (backlog:d1e4d90e:
 * a proposal must be bookable, so a step already begun is never offered).
 */
function validateSuggestFilter(filter) {
  const value = filter && typeof filter === 'object' && !Array.isArray(filter) ? filter : {};
  if (!Array.isArray(value.teamMemberIds) || value.teamMemberIds.length === 0) {
    throw new ValidationError('teamMemberIds names at least one team member: a suggestion for nobody suggests nothing', {
      field: 'teamMemberIds',
    });
  }
  // Same bound as the team week: the team is named per call, never scanned,
  // because there is no roster to scan.
  if (value.teamMemberIds.length > MAX_TEAM_WEEK_MEMBERS) {
    throw new ValidationError(`teamMemberIds names at most ${MAX_TEAM_WEEK_MEMBERS} team members per call`, {
      field: 'teamMemberIds',
    });
  }
  const seen = new Set();
  const members = [];
  value.teamMemberIds.forEach((member, index) => {
    const id = safeText(member, `teamMemberIds[${index}]`, MAX_ID);
    if (!seen.has(id)) {
      seen.add(id);
      members.push(id);
    }
  });
  const from = realIsoInstant(value.from, 'from');
  const to = realIsoInstant(value.to, 'to');
  if (to.ms <= from.ms) {
    throw new ValidationError('to must be after from: a window with no duration holds no slots', { field: 'to' });
  }
  if (to.ms - from.ms > MAX_SUGGEST_WINDOW_MS) {
    throw new ValidationError('a suggestion window spans at most 31 days: a wider window is a report, not a suggestion', {
      field: 'to',
    });
  }
  const slotMinutes = value.slotMinutes === undefined || value.slotMinutes === null ? 30 : value.slotMinutes;
  if (!Number.isSafeInteger(slotMinutes) || !SUGGEST_SLOT_MINUTES.includes(slotMinutes)) {
    throw new ValidationError(`slotMinutes must be one of ${SUGGEST_SLOT_MINUTES.join(', ')}`, { field: 'slotMinutes' });
  }
  // The instant past steps are cut against: named by callers that propose to
  // a human (the backoffice calendar passes its own now), absent for plain
  // window reads, which keep every step exactly as before.
  let nowMs = null;
  if (value.nowIso !== undefined && value.nowIso !== null) {
    nowMs = realIsoInstant(value.nowIso, 'nowIso').ms;
  }
  const steps = Math.floor((to.ms - from.ms) / (slotMinutes * 60 * 1000));
  if (steps > MAX_SUGGEST_STEPS_PER_MEMBER) {
    throw new ValidationError(
      `this window cut into ${slotMinutes}-minute steps is ${steps} slots per member: narrow the window (at most ${MAX_SUGGEST_STEPS_PER_MEMBER})`,
      { field: 'to' },
    );
  }
  return {
    members, fromMs: from.ms, toMs: to.ms, fromIso: from.iso, toIso: to.iso, slotMinutes, nowMs,
  };
}

/**
 * The first round instant at or after `fromMs` a proposal may start on
 * (backlog:c2f21b5debdd): half hours for steps that are multiples of 30
 * minutes, quarters for the 15- and 45-minute ones.
 * @param {number} fromMs @param {number} slotMinutes
 */
export function alignedSlotStart(fromMs, slotMinutes) {
  const gridMs = (slotMinutes % 30 === 0 ? 30 : 15) * 60 * 1000;
  return Math.ceil(fromMs / gridMs) * gridMs;
}

/**
 * Suggest free slots from real availability (BO-F3-02): the named window cut
 * into `slotMinutes` steps, minus every step a held booking overlaps. Read
 * only: no row is written, no slot is invented. Cancelled bookings hold
 * nothing; every other state holds its slot — the same rule `findOverlap`
 * enforces, reused here so a suggestion never offers a slot the booking path
 * would refuse. When the filter names `nowIso`, a step already begun is cut
 * too: a proposal must be bookable, so the past is never offered
 * (backlog:d1e4d90e).
 *
 * @param {{modules: any, moduleNames?: Record<string, string>, calendarSync?: any}} storage
 */
export async function suggestSlots({ modules, moduleNames, calendarSync }, filter) {
  const names = { appointment: moduleNames?.appointment ?? 'appointment' };
  const appointments = flowAppointments({ modules }, names);
  const checked = validateSuggestFilter(filter);
  const slotMs = checked.slotMinutes * 60 * 1000;
  // backlog:c2f21b5debdd: a proposal starts on a round time — the hour, the
  // half hour, or the quarter for the 15- and 45-minute services — never
  // at the window's own odd instant (a draft «ora» at 09:14 used to offer
  // 09:14, 09:44, …). Rome is a whole-hour offset from UTC, so aligning
  // the epoch aligns the Rome clock too.
  const firstStart = alignedSlotStart(checked.fromMs, checked.slotMinutes);
  const groups = [];
  for (const teamMemberId of checked.members) {
    const held = await appointments.listWhere({ teamMemberId });
    // Owner commitments with no guest (backlog:af190faf) hold like bookings:
    // the same store rows the booking path overlap-checks, so a suggestion
    // never offers a slot the booking would refuse. Server handle only —
    // a filter `busyBlocks` key is never read.
    const heldWithBlocks = [...held, ...(await ownerBlocksFor(calendarSync, teamMemberId, checked.fromIso, checked.toIso))];
    const slots = [];
    for (let start = firstStart; start + slotMs <= checked.toMs; start += slotMs) {
      // A proposal must be fully ahead: a step already begun cannot be
      // booked whole, so with a reference instant named it is cut silently —
      // an empty answer, never an invented one.
      if (checked.nowMs !== null && start < checked.nowMs) continue;
      const candidate = { teamMemberId, startMs: start, endMs: start + slotMs };
      // findOverlap throws on a held row whose slot cannot be proven: a
      // corrupt witness fails the suggestion closed, never a silent free slot.
      if (findOverlap(candidate, heldWithBlocks) === null) {
        slots.push(Object.freeze({
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + slotMs).toISOString(),
        }));
      }
    }
    groups.push(Object.freeze({ teamMemberId, slots: Object.freeze(slots) }));
  }
  return Object.freeze({
    from: checked.fromIso,
    to: checked.toIso,
    slotMinutes: checked.slotMinutes,
    members: Object.freeze(groups),
  });
}

/**
 * The validated booking subset a `confirm-required` draft carries: everything
 * the confirm re-validates, minus the internal millisecond bounds.
 */
function publicDraft(input) {
  return Object.freeze({
    sourceKey: input.sourceKey,
    subject: Object.freeze({ ...input.subject }),
    teamMemberId: input.teamMemberId,
    serviceKey: input.serviceKey,
    priceCents: input.priceCents,
    currency: input.currency,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    notes: input.notes,
    remindAt: input.remindAt,
    reminderChannel: input.reminderChannel === null ? null : Object.freeze({
      spaceId: input.reminderChannel.spaceId,
      connectionKey: input.reminderChannel.connectionKey,
      to: input.reminderChannel.to,
      template: Object.freeze({
        name: input.reminderChannel.template.name,
        language: input.reminderChannel.template.language,
        variables: Object.freeze([...input.reminderChannel.template.variables]),
      }),
    }),
    source: Object.freeze({ ...input.source }),
  });
}

/** The gate replays an open proposal for one action key: bind that key to
 * the whole booking claim, not just its source key. The booking path treats
 * the customer, member, service, price, slot, reminder and provenance behind
 * one source key as one claim — a divergent field is a 409, never an
 * adoption — so a resubmitted claim with any of those fields changed opens a
 * distinct proposal describing the new claim. Answering the old proposal as
 * `replayed: true` would tell the caller the new request was proposed while
 * the stored summary describes the old one. The digest is sha256 over the
 * validated claim in fixed field order (the channels `boundedKey` idiom: a
 * short readable prefix, a hash for the tail); the source key stays readable
 * up front for the operator. The label is deliberately not identity: it is a
 * display snapshot, like the booking replay treats it.
 *
 * @param {ReturnType<typeof validateAppointmentRequest>} input
 */
function proposalActionKey(input) {
  const subject = input.subject;
  const claim = JSON.stringify([
    input.sourceKey,
    subject.resource, subject.id, subject.owner, subject.ownerPackage,
    input.teamMemberId, input.serviceKey, input.priceCents, input.currency,
    input.startsAt, input.endsAt, input.notes,
    input.remindAt, input.reminderChannel,
    input.source.package, input.source.action,
  ]);
  const digest = createHash('sha256').update(claim, 'utf8').digest('hex').slice(0, 32);
  return 'book-appointment:' + input.sourceKey + ':claim-' + digest;
}

/** @param {ReturnType<typeof validateAppointmentRequest>} input */
function proposalSummary(input) {
  const label = input.subject.label ? ` (${input.subject.label})` : '';
  const price = `${input.priceCents} ${input.currency}`;
  return `Book ${input.serviceKey} for ${input.subject.resource}:${input.subject.id}${label} `
    + `with ${input.teamMemberId} from ${input.startsAt} to ${input.endsAt}, agreed ${price}`
    .slice(0, 2000);
}

/**
 * Propose one booking (BO-F3-02 "Nuovo appuntamento", first step): validate
 * the request and fail fast on a held slot, then read the space switch. With
 * `book-appointments` on, answer the draft and write nothing — the
 * appointment row is created only by the confirm step. With the switch off,
 * record a `space-ai-proposal` through the gate and stop: the booking stays a
 * proposal a human approves, and no appointment row exists on either path.
 */
export async function proposeBooking(context, request) {
  const actor = requireActor(context?.actor);
  const record = request && typeof request === 'object' ? request : {};
  if (typeof record.spaceId !== 'string' || record.spaceId.trim() === '') {
    throw new ValidationError('spaceId is required: a proposal is gated on the space switch', { field: 'spaceId' });
  }
  const spaceId = record.spaceId;
  const input = validateAppointmentRequest(request);
  const names = { appointment: context?.moduleNames?.appointment ?? 'appointment' };
  const appointments = flowAppointments(context, names);
  const held = await appointments.listWhere({ teamMemberId: input.teamMemberId });
  const blocks = await ownerBlocksFor(context.calendarSync, input.teamMemberId, input.startsAt, input.endsAt);
  const conflict = findOverlap({ teamMemberId: input.teamMemberId, startMs: input.startMs, endMs: input.endMs },
    [...held, ...blocks]);
  if (conflict) {
    throw overlapRefusal(input.teamMemberId, conflict);
  }
  const gate = requireFlowPermissionGate(context);
  const verdict = await gate.gate({ spaceId, permission: BOOK_APPOINTMENTS_PERMISSION });
  if (verdict && verdict.decision === 'allow') {
    return Object.freeze({
      decision: 'confirm-required',
      draft: publicDraft(input),
      spaceId,
      permission: BOOK_APPOINTMENTS_PERMISSION,
    });
  }
  const proposal = await gate.propose({
    spaceId,
    permission: BOOK_APPOINTMENTS_PERMISSION,
    actionKind: PROPOSE_ACTION_KIND,
    actionKey: proposalActionKey(input),
    summary: proposalSummary(input),
    actor,
  });
  return Object.freeze({
    decision: 'proposal',
    proposalId: proposal?.proposalId ?? null,
    replayed: proposal?.replayed ?? false,
    spaceId,
    permission: BOOK_APPOINTMENTS_PERMISSION,
  });
}

/**
 * Confirm one proposed booking (BO-F3-02, second step): without
 * `confirmed: true` nothing is created — the call is refused before any read
 * or write. With confirmation, a named calendar is validated first (a
 * miscomposed calendar edge fails before any row exists), the space switch
 * is read again (a switch flipped off after the proposal still stops the
 * booking), then the booking is stored, advanced `booked -> confirmed`,
 * and — when the caller names a calendar — pushed to the provider through
 * calendar-sync.
 *
 * The calendar push rides the idempotent `pushAppointment` path. A push that
 * fails at runtime never throws: the booking is already committed, so the
 * confirm answers `decision: 'booked'` with `push: null` and
 * `pushError: { code }` naming the failure, and a retry of this same confirm
 * (same source key) replays the confirmed row and links or exports the event
 * exactly once, never twice. Only the pre-write miscomposition above throws.
 */
export async function confirmBooking(context, request) {
  const record = request && typeof request === 'object' ? request : {};
  if (record.confirmed !== true) {
    throw new ValidationError('confirmed must be true: a booking is created only by an explicit confirmation', {
      field: 'confirmed',
    });
  }
  const actor = requireActor(context?.actor);
  if (typeof record.spaceId !== 'string' || record.spaceId.trim() === '') {
    throw new ValidationError('spaceId is required: a confirmation is gated on the space switch', { field: 'spaceId' });
  }
  const spaceId = record.spaceId;
  const input = validateAppointmentRequest(request);
  // A named calendar is validated before any row exists: a statically
  // preventable miscomposition fails here, never after a committed
  // confirmed booking the caller received an error for.
  let calendarId = null;
  let calendarPush = null;
  if (record.calendar !== undefined && record.calendar !== null) {
    calendarId = safeText(record.calendar.calendarId, 'calendar.calendarId', MAX_ID);
    const calendarSync = context?.calendarSync ?? null;
    if (!calendarSync || typeof calendarSync.pushAppointment !== 'function') {
      throw new AppError(
        'The confirmation names a calendar but the appointments package is composed without a calendar-sync push handle, '
        + 'so the event cannot be created: confirm without a calendar, or compose the push handle.',
        { code: 'APPOINTMENTS_CALENDAR_UNAVAILABLE', status: 500 },
      );
    }
    calendarPush = calendarSync.pushAppointment.bind(calendarSync);
  }
  const gate = requireFlowPermissionGate(context);
  const verdict = await gate.gate({ spaceId, permission: BOOK_APPOINTMENTS_PERMISSION });
  if (!verdict || verdict.decision !== 'allow') {
    const proposal = await gate.propose({
      spaceId,
      permission: BOOK_APPOINTMENTS_PERMISSION,
      actionKind: PROPOSE_ACTION_KIND,
      actionKey: proposalActionKey(input),
      summary: proposalSummary(input),
      actor,
    });
    return Object.freeze({
      decision: 'proposal',
      proposalId: proposal?.proposalId ?? null,
      replayed: proposal?.replayed ?? false,
      spaceId,
      permission: BOOK_APPOINTMENTS_PERMISSION,
    });
  }
  const booked = await bookAppointment(context, request);
  const names = { appointment: context?.moduleNames?.appointment ?? 'appointment' };
  const appointments = flowAppointments(context, names);
  let appointment = booked.appointment;
  if (appointment && appointment.status === 'booked') {
    try {
      appointment = await advanceAppointment(
        { appointments, actor, now: context?.now },
        appointment,
        'confirmed',
      );
    } catch (error) {
      // A concurrent confirm of the same source key may have advanced the
      // row between the booking replay and this advance: re-read, and only a
      // row that is still not confirmed keeps the refusal.
      if (!(error instanceof AppError) || error.code !== 'APPOINTMENTS_INVALID_STATE') throw error;
      const fresh = await readAppointment({ appointments }, appointment.id);
      if (!fresh || fresh.status !== 'confirmed') throw error;
      appointment = fresh;
    }
  }
  // The calendar edge was validated above, before any row existed: the
  // push rides the idempotent path. A runtime push failure must not throw —
  // the confirmed row is already committed and the caller would observe a
  // failure for a booking that exists — so it is answered as data: the same
  // retry (same source key) replays the row and links the event exactly
  // once. Only the provider's code is surfaced, never its text.
  let push = null;
  let pushError = null;
  if (calendarPush !== null) {
    try {
      push = await calendarPush(calendarId, booked.appointment.sourceKey, { spaceId, actor });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== ''
        ? error.code
        : 'APPOINTMENTS_CALENDAR_PUSH_FAILED';
      pushError = Object.freeze({ code });
    }
  }
  return Object.freeze({
    decision: 'booked',
    appointment,
    reminder: booked.reminder ?? null,
    push,
    pushError,
    replayed: booked.replayed ?? false,
    spaceId,
  });
}

/**
 * Validate an online booking-link token: opaque, URL-safe, long enough to
 * guess never (at least 128 bits at 6 bits per character) and bounded so it
 * fits the derived source key.
 */
export function validateBookingLinkToken(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('linkToken is required', { field: 'linkToken' });
  }
  const token = value.trim();
  if (!LINK_TOKEN_RE.test(token)) {
    throw new ValidationError(
      'linkToken must be an opaque URL-safe token of 16-128 characters (letters, digits, _ and -): '
      + 'a guessable or unbounded token books nothing',
      { field: 'linkToken' },
    );
  }
  return token;
}

/**
 * Book from an online booking link (`accordo.dev/p/...`, BO-F3-02): the
 * customer picked a slot on the business's own page and submitted it — that
 * submission IS the confirmation, so no `confirmed` flag is asked. The link
 * path reads the same `book-appointments` switch as propose/confirm: switch
 * on books, switch off records a `space-ai-proposal` and stays a proposal —
 * a published link never bypasses a switch the owner turned off. The booking
 * source key derives deterministically from the link token and the slot, so
 * the same link submitted twice — a double click, a retry, two racers —
 * replays the winner's row through the booking path's idempotency instead of
 * writing a second booking, and two different slots behind one link stay two
 * bookings. The link token itself is issued and verified by the deployment
 * (the pilot maps it to the business, the team member and the service before
 * calling here); this path only refuses malformed tokens, never invents a
 * mapping.
 */
export async function bookFromLink(context, request) {
  // The actor is validated here and bound by the booking path below: an
  // anonymous link booking would hold a slot with nobody accountable for it.
  // The deployment passes its own identified actor (it verified the link).
  const actor = requireActor(context?.actor);
  const record = request && typeof request === 'object' ? request : {};
  if (typeof record.spaceId !== 'string' || record.spaceId.trim() === '') {
    throw new ValidationError('spaceId is required: a link booking is gated on the space switch', { field: 'spaceId' });
  }
  const spaceId = record.spaceId;
  const linkToken = validateBookingLinkToken(record.linkToken);
  // Canonicalize the slot before deriving the identity: validation normalizes
  // instants to UTC ISO, and the source key must derive from that canonical
  // form — never from the caller's spelling. Otherwise a valid spelling the
  // key charset rejects (`+02:00`, whose `+` is outside SOURCE_KEY_RE)
  // refuses a real instant, and two spellings of one instant (`Z` vs
  // `-00:00`) derive two keys, so a resubmission conflicts instead of
  // replaying. The canonical instant re-enters validation below, which
  // accepts its own output unchanged.
  const startsAt = realIsoInstant(record.startsAt, 'startsAt').iso;
  const input = validateAppointmentRequest({
    ...record,
    startsAt,
    sourceKey: LINK_SOURCE_PREFIX + linkToken + ':' + startsAt,
  });
  // The switch is read before any row exists: with the switch off the
  // link stays a proposal a human approves, like the confirm path — the
  // proposal action key binds the whole derived claim, so a resubmitted
  // link replays its own proposal instead of opening a second one.
  const gate = requireFlowPermissionGate(context);
  const verdict = await gate.gate({ spaceId, permission: BOOK_APPOINTMENTS_PERMISSION });
  if (!verdict || verdict.decision !== 'allow') {
    const proposal = await gate.propose({
      spaceId,
      permission: BOOK_APPOINTMENTS_PERMISSION,
      actionKind: PROPOSE_ACTION_KIND,
      actionKey: proposalActionKey(input),
      summary: proposalSummary(input),
      actor,
    });
    return Object.freeze({
      decision: 'proposal',
      proposalId: proposal?.proposalId ?? null,
      replayed: proposal?.replayed ?? false,
      spaceId,
      permission: BOOK_APPOINTMENTS_PERMISSION,
      linkToken,
    });
  }
  // The whole record rides, with only the source key derived: a link booking
  // naming remindAt or a reminderChannel keeps its reminder — dropping them
  // here would store a booking that claims less than the customer asked for.
  const booked = await bookAppointment(context, { ...record, sourceKey: input.sourceKey });
  return Object.freeze({
    decision: 'booked',
    linkToken,
    appointment: booked.appointment,
    reminder: booked.reminder ?? null,
    replayed: booked.replayed ?? false,
    spaceId,
  });
}

/**
 * The Rome weekday line beside the reference instant (backlog:d1e4d90e): the
 * model resolves a named weekday against it, so «lunedì» past never answers
 * a past Monday. Presentation only — an unparseable instant adds nothing and
 * the parse still runs against the raw instant.
 */
function romeDayLine(nowIso) {
  try {
    const instant = new Date(String(nowIso));
    if (Number.isNaN(instant.getTime())) return '';
    const words = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(instant);
    return ` (Europe/Rome: ${words})`;
  } catch {
    return '';
  }
}

const PHRASE_SYSTEM = 'You extract appointment booking parameters from an Italian customer sentence. '
  + 'Reply with JSON only, no other text, with any of these keys: '
  + '{"teamMemberId": "opaque team identity, only when the sentence names a person", '
  + '"serviceKey": "lowercase listino slug, only when the sentence names a service", '
  + '"day": "YYYY-MM-DD calendar day in Europe/Rome, only when the sentence names a day but no time", '
  + '"startsAt": "ISO instant the sentence asks for, resolved against the reference instant, only when the sentence states a time", '
  + '"endsAt": "ISO instant the appointment ends, when the sentence gives a duration or an end", '
  + '"durationMinutes": "integer minutes the sentence states for the appointment, only when stated", '
  + '"notes": "anything else worth keeping, at most one line"}. '
  + 'Omit every key the sentence does not state. Never invent a person, a service or a time. '
  + 'When the sentence names a day but no time (for example «giovedì»), return day and never startsAt: '
  + 'never invent 00:00, noon or any other hour for a missing time — the caller asks the human for the hour. '
  + 'A stated midnight («mezzanotte») always rides with its day: return day together with startsAt, '
  + 'never startsAt alone. '
  + 'The reference instant also names the weekday: a weekday the sentence names means its NEXT occurrence after '
  + 'the reference instant, never a past day. When the sentence states a time, startsAt is required — '
  + 'never drop it. When the sentence states a duration in minutes, endsAt is startsAt plus that duration; '
  + 'when no day or time is stated, still record the stated durationMinutes so the caller can size the search.';

/**
 * Parse "fissa con una frase" (BO-F3-02, AI option): turn the customer's
 * sentence into a booking draft through the composed `llm-complete@1`
 * handle, purpose `suggest` — a suggestion the human confirms, like every
 * other suggest-path the framework audits. Without the handle the parse is
 * refused with a named code (off, not broken); a completion that is not
 * usable JSON, or carries an invalid known field, is refused naming the
 * cause — the model is never trusted, only strictly validated. Unknown keys
 * are dropped, never stored. The price is never taken from the model: it is
 * resolved from the listino at booking time, so a draft carries no price.
 */
export async function parseBookingPhrase(context, request) {
  const record = request && typeof request === 'object' ? request : {};
  const phrase = safeText(record.phrase, 'phrase', MAX_PHRASE);
  if (typeof record.spaceId !== 'string' || record.spaceId.trim() === '') {
    throw new ValidationError('spaceId is required: the phrase is parsed for one space', { field: 'spaceId' });
  }
  const llm = context?.phraseLlm ?? null;
  if (!llm || typeof llm.complete !== 'function') {
    throw new AppError(
      'The appointments package is composed without an opened llm-complete@1 capability, '
      + 'so the booking phrase cannot be parsed: book with the manual option instead',
      { code: 'APPOINTMENTS_AI_UNAVAILABLE', status: 500 },
    );
  }
  const actor = requireActor(context?.actor);
  const now = typeof context?.now === 'function' ? context.now() : new Date().toISOString();
  const nowMs = Date.parse(String(now));
  let completion;
  try {
    completion = await llm.complete({
      actor,
      spaceId: record.spaceId,
      purpose: 'suggest',
      messages: [
        { role: 'system', content: PHRASE_SYSTEM },
        { role: 'user', content: `Reference instant: ${now}${romeDayLine(now)}. Sentence: ${phrase}` },
      ],
      maxTokens: 512,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`The booking phrase could not be parsed: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'APPOINTMENTS_AI_DRAFT_UNUSABLE',
      status: 503,
    });
  }
  const text = completion && typeof completion.text === 'string' ? completion.text : '';
  const draft = extractPhraseDraft(text, nowMs);
  return Object.freeze({
    draft,
    dryRun: completion?.dryRun === true,
    spaceId: record.spaceId,
  });
}

/**
 * The Rome calendar day of an instant, for the day/startsAt agreement check
 * below (backlog:65ed7430). `en-CA` formats as YYYY-MM-DD; anything else is
 * unprovable and the draft is refused, never guessed.
 *
 * @param {string} iso
 */
function romeDayKeyOfInstant(iso) {
  try {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * The Rome wall-clock time of an instant as 'HH:MM', null when unparsable —
 * the same shape the admin calendar paints (hour12:false, like its own
 * romeWallToIso), so the check below refuses what the operator would see. A
 * lone midnight (backlog:65ed7430) is 00:00 on the Rome clock only: 00:00Z is
 * 01:00/02:00 in Rome, a stated early hour, never an invented midnight.
 *
 * @param {string} iso
 */
function romeClockOfInstant(iso) {
  try {
    const seen = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
    // Some ICU builds paint midnight as 24:00: same wall time, one spelling.
    const clock = seen === '24:00' ? '00:00' : seen;
    return /^\d{2}:\d{2}$/.test(clock) ? clock : null;
  } catch {
    return null;
  }
}

/**
 * Strictly validate the model's JSON: known keys only, every one proven. A
 * draft naming a moment at or before the reference instant is refused with
 * its own code (backlog:d1e4d90e): the caller tells the human to name a
 * future day instead of proposing the past. A draft naming a day but no
 * time rides `day` (backlog:65ed7430): an invented midnight is never
 * accepted as a stated hour, so when both ride they must name the same Rome
 * day or the draft is unusable — and a Rome midnight with no day is refused
 * even when it names a future instant, because the prompt alone cannot stop
 * the model from writing 00:00 for a missing hour.
 */
function extractPhraseDraft(text, nowMs) {
  const fenced = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    throw new AppError('The workspace AI returned no usable booking draft: book with the manual option instead', {
      code: 'APPOINTMENTS_AI_DRAFT_UNUSABLE',
      status: 502,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('The workspace AI returned no usable booking draft: book with the manual option instead', {
      code: 'APPOINTMENTS_AI_DRAFT_UNUSABLE',
      status: 502,
    });
  }
  const draft = {};
  try {
    if (parsed.teamMemberId !== undefined) {
      draft.teamMemberId = safeText(parsed.teamMemberId, 'draft.teamMemberId', MAX_ID);
    }
    if (parsed.serviceKey !== undefined) {
      const key = safeText(parsed.serviceKey, 'draft.serviceKey', 48);
      if (!DRAFT_SERVICE_KEY_RE.test(key)) {
        throw new ValidationError('draft.serviceKey must be the listino product key', { field: 'draft.serviceKey' });
      }
      draft.serviceKey = key;
    }
    if (parsed.startsAt !== undefined) draft.startsAt = realIsoInstant(parsed.startsAt, 'draft.startsAt').iso;
    if (parsed.day !== undefined) {
      const day = safeText(parsed.day, 'draft.day', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isCalendarDate(day)) {
        throw new ValidationError(
          'draft.day must be a real calendar day as YYYY-MM-DD: a day that never existed is refused, not rolled over',
          { field: 'draft.day' },
        );
      }
      draft.day = day;
    }
    if (draft.startsAt !== undefined && draft.day !== undefined) {
      const startsDay = romeDayKeyOfInstant(draft.startsAt);
      if (startsDay === null || startsDay !== draft.day) {
        throw new ValidationError(
          'draft.day must name the same Europe/Rome day as draft.startsAt: a midnight invented for a missing hour is never a stated time',
          { field: 'draft.day' },
        );
      }
    }
    if (draft.startsAt !== undefined && draft.day === undefined) {
      // backlog:65ed7430 — the Rome wall clock only: a lone 00:00 in Rome is
      // an invented midnight, while a lone 00:00Z is 01:00/02:00 in Rome, a
      // stated early hour that must stay bookable.
      if (romeClockOfInstant(draft.startsAt) === '00:00') {
        throw new ValidationError(
          'draft.startsAt at 00:00 Europe/Rome with no draft.day is an invented midnight, never a stated time: '
          + 'a stated midnight rides with its day (backlog:65ed7430)',
          { field: 'draft.startsAt' },
        );
      }
    }
    if (parsed.endsAt !== undefined) draft.endsAt = realIsoInstant(parsed.endsAt, 'draft.endsAt').iso;
    if (draft.startsAt !== undefined && draft.endsAt !== undefined
      && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) {
      throw new ValidationError('draft.endsAt must be after draft.startsAt', { field: 'draft.endsAt' });
    }
    if (draft.startsAt !== undefined && Number.isSafeInteger(nowMs)
      && Date.parse(draft.startsAt) <= nowMs) {
      throw new AppError(
        'The workspace AI placed the booking at or before the reference instant: name a future day instead',
        { code: 'APPOINTMENTS_AI_DRAFT_IN_PAST', status: 422, details: { field: 'draft.startsAt' } },
      );
    }
    if (parsed.durationMinutes !== undefined) {
      const minutes = parsed.durationMinutes;
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw new ValidationError('draft.durationMinutes must be whole minutes from 1 to 1440', { field: 'draft.durationMinutes' });
      }
      draft.durationMinutes = minutes;
    }
    if (parsed.notes !== undefined) {
      draft.notes = safeText(parsed.notes, 'draft.notes', MAX_NOTES);
    }
  } catch (error) {
    // A known key with an invalid value is an unusable draft, never a raw
    // validation leak: the caller books with the manual option instead. A
    // past draft keeps its own code so the caller can name the fix.
    if (error instanceof AppError
      && (error.code === 'APPOINTMENTS_AI_DRAFT_UNUSABLE' || error.code === 'APPOINTMENTS_AI_DRAFT_IN_PAST')) throw error;
    throw new AppError(
      `The workspace AI returned an invalid booking draft (${error instanceof Error ? error.message : String(error)}): book with the manual option instead`,
      {
        code: 'APPOINTMENTS_AI_DRAFT_UNUSABLE',
        status: 502,
        details: { field: (error instanceof ValidationError && error.details?.field) || 'draft' },
      },
    );
  }
  return Object.freeze(draft);
}

/**
 * `appointment-schedule@1` — the reads the customer scheda and the team
 * calendar render: one subject's appointments (`scheduleFor`), and the team
 * week (`teamWeekFor`). Read-only by construction: frozen rows, no storage
 * handle, no write path of any kind. `teamWeekFor` is additive (BO-F3-01):
 * it widens the read surface without changing `scheduleFor` or the contract.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createAppointmentScheduleCapability({ moduleNames, calendarSync } = {}) {
  const names = resolvedNames(moduleNames);
  return {
    name: 'appointment-schedule',
    version: 1,
    description:
      'Read one subject\'s appointments — every booking naming it, soonest slot first, cancelled rows included '
      + 'with their status — and the team week: every booking overlapping a window for each named member, '
      + 'grouped per person. Owner commitments with no guest read as «Occupato» from the composed calendar-sync '
      + 'handle. Read-only: frozen rows, no storage handle, no write path.',
    /** @param {{modules: any, calendarSync?: any}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('appointment-schedule@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const service = resolveModule(modules, names.appointment)?.service;
      // The owner-block feed is deployment-injected server state: the
      // factory handle wins, a per-opener handle fills the gap, like the
      // book capability below. The filter never carries blocks.
      const blocks = calendarSync ?? context?.calendarSync ?? null;
      return Object.freeze({
        capabilityContract: 1,
        /** @param {{resource: string, id: string, owner: string, ownerPackage?: string|null, label?: string|null}} subject */
        scheduleFor: (subject) => readSchedule({ appointments: service }, subject),
        /** @param {{teamMemberIds?: unknown, from?: unknown, to?: unknown}} filter */
        teamWeekFor: (filter) => readTeamWeek({ appointments: service, calendarSync: blocks }, filter),
      });
    },
  };
}

/**
 * Refuse a handed-over edge whose opened handle settles on another contract.
 * The flow edges below stay out of `requires` on purpose: a composition
 * without space-permissions or llm must keep booting and booking (the
 * customer-hub timeline keeps its optional providers out of `requires` for
 * the same reason), and the direct booking path never touches them. So the
 * registry cannot validate these handovers at startup — this open-time check
 * is what keeps a wrong one fail-closed instead of silently opened.
 * The edge version pins the provider capability contract (`@1` settles on
 * contract 1): the appointments graph contract (v1/v2) governs this
 * package's own graph, never the provider's handle, so every graph accepts
 * these handovers. An explicitly injected handle (tests, or an opener's own
 * wiring) is the opener's responsibility and is not re-checked here.
 *
 * @param {any} opened the created handle
 * @param {string} edge the edge name for the refusal, e.g. `space-permission-gate@1`
 */
function assertHandoverContract(opened, edge) {
  if (!opened || opened.capabilityContract !== 1) {
    throw new AppError(
      'The appointments package needs ' + edge + ' on provider capability contract 1: '
      + 'the handed-over handle settles on another contract — hand over the provider definition '
      + 'for the named capability version',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
}

/**
 * Open the handed-over `space-permission-gate@1` capability for one runtime
 * (BO-F3-02): the propose/confirm flow gates on the space's
 * `book-appointments` switch. Absent until a proposal is requested — the
 * direct booking path never touches it, so a composition without
 * space-permissions books exactly as before.
 */
function openPermissionGate(gateCapability, runtime) {
  if (gateCapability === undefined || gateCapability === null) return null;
  if (typeof gateCapability.create !== 'function') {
    throw new AppError(
      'The appointments package needs the space-permissions package capability space-permission-gate@1: '
      + 'compose it with the provider definition, e.g. createAppointmentsPackage({ spacePermissions }) '
      + 'beside createSpacePermissionsPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  const opened = gateCapability.create({ modules: runtime.modules, consumer: APPOINTMENTS_PACKAGE, now: runtime.now });
  if (!opened || typeof opened.gate !== 'function' || typeof opened.propose !== 'function') {
    throw new AppError(
      'The appointments package needs the space-permissions package capability space-permission-gate@1: '
      + 'the created capability opens no gate/propose',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  assertHandoverContract(opened, 'space-permission-gate@1');
  return opened;
}

/**
 * Open the handed-over `llm-complete@1` capability for one runtime (BO-F3-02
 * "fissa con una frase"): the phrase parse suggests booking parameters the
 * human confirms. Absent until a phrase is parsed — bookings never touch it.
 */
function openPhraseLlm(llmCapability, runtime) {
  if (llmCapability === undefined || llmCapability === null) return null;
  if (typeof llmCapability.create !== 'function') {
    throw new AppError(
      'The appointments package needs the llm package capability llm-complete@1: '
      + 'compose it with the provider definition, e.g. createAppointmentsPackage({ llm }) beside createLlmPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  const opened = llmCapability.create({ modules: runtime.modules });
  if (!opened || typeof opened.complete !== 'function') {
    throw new AppError(
      'The appointments package needs the llm package capability llm-complete@1: '
      + 'the created capability opens no complete',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }
  assertHandoverContract(opened, 'llm-complete@1');
  return opened;
}

/**
 * `appointment-book@1` — the only write path: book appointments and advance
 * them along the lifecycle. It is created with the caller's runtime handles
 * and writes through them; every booking is one row, idempotent by source
 * key, so a retry replays rather than duplicates. It hands out no service, no
 * table and no query handle. Reads are exact: one row by id, never a scan.
 *
 * The BO-F3-02 flow widens the surface additively: `suggestSlots` reads free
 * slots from the same held rows the booking path overlap-checks;
 * `proposeBooking` plans without writing (a draft when the space switch is
 * on, a `space-ai-proposal` when it is off); `confirmBooking` creates only on
 * explicit confirmation and answers a runtime calendar-push failure as data
 * (`push: null`, `pushError: { code }`), never a throw past the commit;
 * `bookFromLink` books from the business's own online link idempotently
 * behind the same switch (off stays a proposal); `parseBookingPhrase` drafts
 * parameters from one Italian sentence through the composed LLM. Nothing
 * here changes `bookAppointment`, `advanceAppointment` or the contract.
 *
 * @param {Record<string, string>} [moduleNames]
 * @param {any} [spacePermissions] the composed space-permissions package definition (handover, optional)
 * @param {any} [permissionGate] an already-opened space-permission-gate@1 handle (tests; wins over the handover)
 * @param {any} [llm] the composed llm package definition (handover, optional)
 * @param {any} [phraseLlm] an already-opened llm-complete@1 handle (tests; wins over the handover)
 * @param {any} [calendarSync] a calendar-sync handle `{pushAppointment, listOwnerBlocks?}` (per opener; optional):
 *   the push writes confirmed events, the owner-block feed is the ONLY source of owner holds on every path
 */
export function createAppointmentBookCapability({ moduleNames, provider, followUps, templateSendProvider, templateSend, spacePermissions, permissionGate, llm, phraseLlm, calendarSync } = {}) {
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
  /**
   * Open the template-send handle for this opener: same handover shape as
   * the follow-up handle above. The handle only proves the send target at
   * booking time; the sweep opens its own handle on the composition
   * modules. No handle is fine until a booking names reminderChannel.
   */
  const openTemplateSend = (context) => {
    if (templateSend ?? context.templateSend) return templateSend ?? context.templateSend;
    if (!templateSendProvider || typeof templateSendProvider.create !== 'function') return null;
    return templateSendProvider.create({ modules: context.modules });
  };
  /**
   * Open the permission gate for this opener: an explicitly injected handle
   * wins (tests), otherwise the space-permissions definition handed to the
   * package factory is opened with the opener's own modules.
   */
  const openGate = (context) => {
    if (permissionGate !== undefined && permissionGate !== null) return permissionGate;
    if (context?.permissionGate) return context.permissionGate;
    if (!spacePermissions || !Array.isArray(spacePermissions.capabilities)) return null;
    const offered = spacePermissions.capabilities
      .find((entry) => entry?.name === 'space-permission-gate' && entry?.version === 1) ?? null;
    return openPermissionGate(offered, { modules: context.modules, now: context.now });
  };
  /**
   * Open the phrase LLM for this opener: same handover shape as the gate
   * above. Absent until a phrase is parsed.
   */
  const openLlm = (context) => {
    if (phraseLlm !== undefined && phraseLlm !== null) return phraseLlm;
    if (context?.phraseLlm) return context.phraseLlm;
    if (!llm || !Array.isArray(llm.capabilities)) return null;
    const offered = llm.capabilities
      .find((entry) => entry?.name === 'llm-complete' && entry?.version === 1) ?? null;
    return openPhraseLlm(offered, { modules: context.modules });
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
    templateSend: openTemplateSend(context),
    permissionGate: openGate(context),
    phraseLlm: openLlm(context),
    calendarSync: calendarSync ?? context.calendarSync ?? null,
  });
  return {
    name: 'appointment-book',
    version: 1,
    description:
      'Book one appointment per call — validated, overlap-checked, stored as booked — '
      + 'and advance it along the lifecycle or move its slot. '
      + 'A booking with remindAt opens one work follow-up in the same transaction. '
      + 'BO-F3-02 adds suggestSlots, propose/confirmBooking, bookFromLink and parseBookingPhrase. '
      + 'Every write is idempotent by source key; reads exact only, no update and no delete.',
    /** @param {{modules: any, actor?: unknown, now?: () => string, consumer?: string, followUps?: any, templateSend?: any, permissionGate?: any, phraseLlm?: any, calendarSync?: any}} context */
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
        /** @param {{teamMemberIds?: unknown, from?: unknown, to?: unknown, slotMinutes?: unknown}} filter */
        suggestSlots: (filter) => suggestSlots({
          modules: scope.modules, moduleNames: scope.moduleNames, calendarSync: scope.calendarSync,
        }, filter),
        /** @param {unknown} request */
        proposeBooking: (request) => proposeBooking(scope, request),
        /** @param {unknown} request */
        confirmBooking: (request) => confirmBooking(scope, request),
        /** @param {unknown} request */
        bookFromLink: (request) => bookFromLink(scope, request),
        /** @param {unknown} request */
        parseBookingPhrase: (request) => parseBookingPhrase(scope, request),
        /** @param {unknown} record @param {unknown} to @param {unknown} [reason] */
        advanceAppointment: (record, to, reason) => advanceAppointment(
          { appointments: storage(), actor: scope.actor, now: scope.now }, record, to, reason,
        ),
        /** @param {unknown} request */
        rescheduleAppointment: (request) => rescheduleAppointment(scope, request),
        /** @param {unknown} id */
        appointment: (id) => readAppointment({ appointments: storage() }, id),
        /**
         * Exact read of one appointment by source key — the identity
         * sync writers join on. Only the expected miss becomes absence;
         * a storage failure stays the caller's outage, never a quiet
         * unknown appointment.
         * @param {unknown} sourceKey
         */
        appointmentBySourceKey: async (sourceKey) => {
          const key = safeText(sourceKey, 'sourceKey', MAX_SOURCE_KEY);
          const rows = await storage().listWhere({ sourceKey: key });
          const row = rows[0] ?? null;
          return row ? Object.freeze({ ...row }) : null;
        },
      });
    },
  };
}

export { safeText, optionalSafeText };
