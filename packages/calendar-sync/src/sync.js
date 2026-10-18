// @ts-check

import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../core/index.js';

/**
 * Two-way calendar sync (backlog:bf0351325a8c): the hybrid Appointments /
 * Google Calendar story — the user works in Accordo, in Google Calendar,
 * or in both, and each side sees the other's changes.
 *
 * What it reuses, never duplicates:
 * - appointment rows and their invariants (overlap, idempotency, lifecycle)
 *   stay in `packages/appointments`, written and read only through its
 *   `appointment-book@1` capability, opened here per call with this
 *   package as the consumer — so `source.package` on imported rows is
 *   `calendar-sync`, the identity the registry proved, never caller text.
 *   The capability's module-name remap is forwarded, so a composition
 *   that renamed the appointment module still resolves.
 * - no customer master table: the customer of an imported event is the
 *   deployment-owned mapping (`mapping.subjectForEvent`), the same opaque
 *   envelope appointments already store. No roster, no catalog, no pricing:
 *   the team member, service and price are deployment mappings too.
 *
 * What it owns: the link rows joining one Google event to one appointment
 * row, the per-calendar sync token, the push-channel registry (token hashes
 * only), and the written conflict rule — Accordo owns lifecycle, Google
 * owns schedule — applied in `applyRemoteChange` and proven by the tests.
 *
 * Provider contract (fake-backed until credentials exist — owner decision
 * MEM_ACC_DECISIONS): every call is awaited, so a real adapter may return
 * promises; the fake answers synchronously and the engine cannot tell.
 * Required: `listEvents`, `insertEvent`, `cancelEvent`,
 * `findByAccordoSourceKey` (export reconciliation — a retry after a lost
 * link finds the already-inserted event instead of inserting a second).
 *
 * No remote change is ever silently dropped: a move the sync cannot apply
 * yet keeps its valid local row and is kept as a `pendingRemote` snapshot
 * on the link (an orphan link when no row exists yet) and retried on every
 * pull until it applies — the token moves on, the retry does not depend
 * on it. The cancel commits only with its rebook, never before it.
 */

export const CALENDAR_SYNC_PACKAGE = 'calendar-sync';
export const CALENDAR_SYNC_CONSUMER = 'calendar-sync';

export const CALENDAR_LINK_MODULE = 'calendar-link';
export const CALENDAR_SYNC_STATE_MODULE = 'calendar-sync-state';

const TERMINAL_STATUSES = Object.freeze(['done', 'no-show', 'cancelled']);

function syncError(code, status, message, details) {
  return new AppError(message, { code, status, ...(details === undefined ? {} : { details }) });
}

/** @param {Record<string, string>} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    link: moduleNames[CALENDAR_LINK_MODULE] ?? CALENDAR_LINK_MODULE,
    state: moduleNames[CALENDAR_SYNC_STATE_MODULE] ?? CALENDAR_SYNC_STATE_MODULE,
    appointment: moduleNames.appointment ?? 'appointment',
  };
}

/** @param {any} modules @param {string} name */
function resolveModule(modules, name) {
  try {
    return modules?.get?.(name) ?? null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

// The space-grant binding (backlog:43b62d4bcaa3): one calendar syncs under
// the space's Google grant, kept in the platform vault under the secretRef
// `vault://<space>/google-calendar`. The row stores the reference, never
// the grant — the same discipline the channel connections follow. The
// shape is re-stated here instead of imported: domain packages reach each
// other only through declared capabilities (docs/PACKAGE_AUTHORING.md),
// and the core secret pattern deliberately also matches a bare value, so
// a pasted grant would pass validation and land in the row.
const SECRET_REF_PATTERN = /^(?:vault|secret):\/\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const SECRET_REF_MAX = 256;
/** Custody purposes, so the deployment audit tells reads from writes. */
const GRANT_PURPOSE_READ = 'calendar-sync:read';
const GRANT_PURPOSE_WRITE = 'calendar-sync:write';
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A grant locator, never the grant: a pasted value is refused before storage. */
function assertSecretReference(value) {
  if (typeof value !== 'string' || value === '' || value.length > SECRET_REF_MAX
    || !SECRET_REF_PATTERN.test(value) || HOSTILE_KEYS.includes(value)) {
    throw new ValidationError('secretRef must be a bounded reference locator ("vault://<space>/<name>"), never a secret value', { field: 'secretRef' });
  }
  return value;
}

/** Bounded single-line text for grant identifiers the provider never sees. */
function assertGrantText(value, label, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL_RE.test(value)) {
    throw new ValidationError(`${label} must be bounded single-line text (at most ${max} characters)`, { field: label });
  }
  return value.trim();
}

/** Binding a grant and revoking one are human decisions, like connecting a channel. */
function requireUserActor(actor, action) {
  if (!actor || typeof actor !== 'object' || actor.type !== 'user') {
    throw syncError('HUMAN_APPROVAL_REQUIRED', 403, `${action} requires a human user actor`);
  }
  return actor;
}

/**
 * Provider errors never travel with provider text: a Google failure may
 * echo the grant, a token, or personal data from the request, so the code
 * (kept for control signals like the expired sync token) rides with a
 * fixed message instead. Rows, callers and audit see codes, never secrets.
 */
/** @param {any} error */
function providerErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : 'CALENDAR_PROVIDER_UNAVAILABLE';
}

/** @param {any} error */
function providerErrorStatus(error) {
  const status = error?.status;
  return Number.isSafeInteger(status) && status >= 400 && status < 600 ? status : 502;
}

function linkService(context) {
  const service = resolveModule(context.modules, context.names.link)?.service;
  if (!service?.createManaged || !service?.applyManaged || typeof service?.listWhere !== 'function') {
    throw syncError('CALENDAR_SYNC_STORAGE_INVALID', 500,
      'The calendar-sync package is installed without its "calendar-link" records. '
      + 'Apply the manifest with `crm module create` before syncing.');
  }
  return service;
}

function stateService(context) {
  const service = resolveModule(context.modules, context.names.state)?.service;
  if (!service?.createManaged || !service?.applyManaged || typeof service?.listWhere !== 'function') {
    throw syncError('CALENDAR_SYNC_STORAGE_INVALID', 500,
      'The calendar-sync package is installed without its "calendar-sync-state" records. '
      + 'Apply the manifest with `crm module create` before syncing.');
  }
  return service;
}

/**
 * The deployment-owned identity mapping, validated fail-closed: without it
 * the sync cannot name a customer, a team member or a service, and it
 * refuses to invent one rather than booking against a fabricated identity.
 */
function requireMapping(mapping) {
  for (const key of ['subjectForEvent', 'teamMemberForCalendar', 'serviceForEvent', 'summaryForAppointment']) {
    if (typeof mapping?.[key] !== 'function') {
      throw new ValidationError(`calendar-sync mapping.${key} must be a function`, { field: `mapping.${key}` });
    }
  }
  return mapping;
}

/** The local half of a linked row, as one comparable string. */
export function appointmentFingerprint(row) {
  return JSON.stringify([row?.startsAt ?? null, row?.endsAt ?? null, row?.notes ?? null, row?.status ?? null]);
}

// Google event ids are calendar-scoped, but the appointment source key is
// global: the calendar joins the key, so the same event id on two synced
// calendars books two rows instead of colliding on the unique guard.
const sourceKeyFor = (calendarId, eventId, revision) => (revision > 0
  ? `gcal:${calendarId}:${eventId}:r${revision}`
  : `gcal:${calendarId}:${eventId}`);
const linkKeyFor = (calendarId, eventId) => `${calendarId}:${eventId}`;
const stateKeyFor = (calendarId) => `calendar:${calendarId}`;

/**
 * Newest-wins comparison for the pending-snapshot rule: an in-hand Google
 * event supersedes a pending snapshot only when its `updated` stamp is
 * strictly newer. Missing or unparseable stamps never supersede —
 * retrying the snapshot is the fail-closed choice.
 */
function isNewerThan(candidateUpdated, baselineUpdated) {
  if (typeof candidateUpdated !== 'string' || typeof baselineUpdated !== 'string') return false;
  const candidateMs = Date.parse(candidateUpdated);
  const baselineMs = Date.parse(baselineUpdated);
  if (!Number.isNaN(candidateMs) && !Number.isNaN(baselineMs)) return candidateMs > baselineMs;
  return candidateUpdated > baselineUpdated;
}

/**
 * The Google event a pending snapshot holds. Every snapshot this code
 * writes is an envelope `{ event, preStatus, cancelCommitted }`; a pending
 * without a boolean `cancelCommitted` predates the atomic-move protocol
 * (calendar-sync never synced a real calendar before it existed) and is
 * rejected by `isLegacyPending` before this ever reads it. Null when the
 * snapshot is unreadable (the retry path drops those by operator decision).
 */
function pendingEnvelope(link) {
  if (!link?.pendingRemote) return null;
  try {
    const snapshot = JSON.parse(link.pendingRemote);
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

/** The Google event a pending envelope snapshot holds. */
function pendingSnapshotEvent(link) {
  const envelope = pendingEnvelope(link);
  return envelope?.event ?? null;
}

/**
 * A pending snapshot without a boolean `cancelCommitted` predates the
 * atomic-move protocol: calendar-sync never synced a real calendar before
 * the envelope existed, so such a row can only come from older code. It is
 * rejected with an explicit code and kept as a visible operator conflict —
 * never replayed, never superseded, and never converted into a Google
 * cancellation (the old row it raced may already read as locally
 * cancelled against a booked fingerprint, which a naive re-decision
 * would push to Google as a cancellation the user never made).
 */
function isLegacyPending(link) {
  const envelope = pendingEnvelope(link);
  return !!envelope && typeof envelope.cancelCommitted !== 'boolean';
}

/** A storage unique-guard refusal is the loser of a link race, never driver text. */
function isLinkConflict(error) {
  return error instanceof ConflictError && error.details?.transient !== true;
}

/**
 * @param {{
 *   modules: any, moduleNames?: Record<string, string>,
 *   appointmentBook: any, provider: any, mapping: any,
 *   actor?: unknown, now?: () => string, database?: any,
 * }} options `appointmentBook` is the created `appointment-book@1`
 * capability definition (it carries `.create`); the deployment hands the
 * created object over, the way appointments receives work's `follow-up@1`.
 * `database` is the deployment's database handle (the channels per-runtime
 * pattern): it must carry `transactionAsync`, because a reschedule commits
 * its cancel with its rebook in one storage transaction. Without it the
 * link records' own handle is tried; without either, creation refuses
 * with CALENDAR_SYNC_TRANSACTIONS_REQUIRED instead of running — there is
 * no transaction-less fallback. The package factory forwards its explicit
 * `database` option here, winning over the runtime's.
 */
export function createCalendarSyncOperations(options = {}) {
  const modules = options.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw syncError('CALENDAR_SYNC_CONTEXT_INVALID', 500, 'calendar-sync needs the caller\'s modules view', undefined);
  }
  const names = resolvedNames(options.moduleNames);
  const appointmentBook = options.appointmentBook;
  if (!appointmentBook || typeof appointmentBook.create !== 'function') {
    throw syncError('CALENDAR_SYNC_CONTEXT_INVALID', 500,
      'calendar-sync is composed without an opened appointment-book@1 capability, so it cannot write appointment rows');
  }
  const provider = options.provider;
  for (const key of ['listEvents', 'insertEvent', 'cancelEvent', 'findByAccordoSourceKey']) {
    if (typeof provider?.[key] !== 'function') {
      throw syncError('CALENDAR_SYNC_CONTEXT_INVALID', 500, `calendar-sync provider needs "${key}"`);
    }
  }
  const mapping = requireMapping(options.mapping);
  // The deployment custody edge, same shape the channel connections resolve
  // through: optional at composition so validation and conformance compose
  // empty, fail-closed at call time — a bound calendar refuses until the
  // deployment wires it, never with an invented grant.
  const resolveSecret = options.resolveSecret ?? null;
  if (resolveSecret !== null && typeof resolveSecret !== 'function') {
    throw new ValidationError('calendar-sync resolveSecret must be a function', { field: 'resolveSecret' });
  }
  const defaultActor = options.actor ?? { type: 'system', id: 'calendar-sync' };
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const context = { modules, names };
  const database = options.database ?? null;
  if (database !== null && typeof database !== 'object') {
    throw new ValidationError('calendar-sync database must be an object when provided', { field: 'database' });
  }

  /**
   * The storage transaction every reschedule commits in: the deployment's
   * explicit handle first, else the link records' own handle (the same
   * `?.database?.transactionAsync` idiom the appointments booking path
   * uses). Resolved once, at creation: a storage without transactions
   * refuses to start the sync at all (CALENDAR_SYNC_TRANSACTIONS_REQUIRED)
   * instead of degrading — the old prove-before-cancel fallback is gone,
   * because its crash window orphaned the rebooked row and the retry then
   * cancelled Google on a false cancellation-wins.
   */
  const links = linkService(context);
  const transactionSource = typeof database?.transactionAsync === 'function'
    ? database
    : (typeof links?.database?.transactionAsync === 'function' ? links.database : null);
  if (!transactionSource) {
    throw syncError('CALENDAR_SYNC_TRANSACTIONS_REQUIRED', 500,
      'calendar-sync needs a storage transaction (transactionAsync on the explicit database handle or the link records\' handle): a reschedule commits its cancel with its rebook, atomically, and never runs without that.');
  }
  const transact = (critical) => transactionSource.transactionAsync(critical);
  // The EventBus the record services emit on: the atomic move buffers its
  // domain events until after the storage commit (ADR-012, the same
  // events.buffered idiom catalog-sync and external-operation use), so a
  // rolled-back move emits nothing. Null when the services carry no bus —
  // then the transaction still rolls back the rows, only the ghost-event
  // suppression is absent.
  const serviceEvents = links?.events ?? null;
  const eventBuffer = serviceEvents && typeof serviceEvents.buffered === 'function' ? serviceEvents : null;

  const bookHandle = (actor) => appointmentBook.create({
    modules,
    moduleNames: { appointment: names.appointment },
    actor: actor ?? defaultActor,
    now,
    consumer: CALENDAR_SYNC_CONSUMER,
  });

  async function findLinkByEvent(calendarId, eventId) {
    const rows = await linkService(context).listWhere({ googleEventId: linkKeyFor(calendarId, eventId) });
    return rows[0] ?? null;
  }

  async function findLinkBySource(sourceKey) {
    const rows = await linkService(context).listWhere({ appointmentSourceKey: sourceKey });
    return rows[0] ?? null;
  }

  /** Read through the capability, never around it — the module name in force is the capability's own. */
  async function readLocal(handle, link) {
    if (!link || link.appointmentId === '') return null;
    return handle.appointmentBySourceKey(link.appointmentSourceKey);
  }

  async function storeLink(link, actor) {
    try {
      return await linkService(context).createManaged({ ...link }, { actor });
    } catch (error) {
      if (!isLinkConflict(error)) throw error;
      return (await linkService(context).listWhere({ linkKey: link.linkKey }))[0] ?? null;
    }
  }

  async function readState(calendarId) {
    const rows = await stateService(context).listWhere({ stateKey: stateKeyFor(calendarId) });
    return rows[0] ?? null;
  }

  async function writeState(calendarId, patch, actor) {
    const existing = await readState(calendarId);
    if (existing) {
      return stateService(context).applyManaged(existing.id, { ...patch }, { actor });
    }
    return stateService(context).createManaged({
      stateKey: stateKeyFor(calendarId),
      calendarId,
      syncToken: null,
      channelId: '',
      channelTokenHash: null,
      resourceId: null,
      spaceId: null,
      secretRef: null,
      grantStatus: null,
      ...patch,
    }, { actor });
  }

  /**
   * A revoked grant stops the sync the way a revoked channel binding does:
   * every Google-touching operation refuses before reading anything, so a
   * revocation the deployment records takes effect on the very next call —
   * including a pull already scheduled, which refuses instead of listing
   * with a dead grant. The caller's space is enforced first: a bound
   * calendar syncs only for its owning space, and a foreign or missing
   * space reads as unknown — never as a cross-space oracle. Unbound
   * calendars (synced before grants existed) stay unwired, as on main.
   */
  async function requireLiveGrant(calendarId, callerSpaceId) {
    const state = await readState(calendarId);
    if (state?.spaceId !== null && state?.spaceId !== undefined && state.spaceId !== callerSpaceId) {
      throw syncError('CALENDAR_GRANT_UNKNOWN', 404,
        `calendar "${calendarId}" has no grant for this space: bind it before syncing`);
    }
    if (state && state.grantStatus === 'revoked') {
      throw syncError('CALENDAR_GRANT_REVOKED', 409,
        `calendar "${calendarId}" grant is revoked: re-bind it before syncing`);
    }
    return state;
  }

  /**
   * Resolve the calendar's space grant for one call, through the same
   * custody edge the channel connections use. Resolved per call into a
   * local only — never cached, never stored — so revoking the binding
   * discards every live grant by simply refusing the next resolution.
   * Unbound calendars (bound before grants existed) sync unwired, exactly
   * as on main today: the binding is additive, never a new requirement.
   */
  async function resolveGrant(state, purpose) {
    const ref = state?.secretRef ?? null;
    if (ref === null || ref === undefined || ref === '') return null;
    if (resolveSecret === null) {
      throw syncError('CALENDAR_SECRET_UNWIRED', 500,
        'calendar-sync is composed without resolveSecret: compose it with the deployment custody edge before syncing a bound calendar');
    }
    let value;
    try {
      value = await resolveSecret(ref, { spaceId: state.spaceId ?? '', purpose });
    } catch {
      throw syncError('CALENDAR_SECRET_UNAVAILABLE', 500,
        'the space grant is unavailable: retry the sync');
    }
    if (typeof value !== 'string' || value === '') {
      throw syncError('CALENDAR_SECRET_UNAVAILABLE', 500,
        'the space grant is unavailable: retry the sync');
    }
    return value;
  }

  /**
   * One provider call under the calendar's live grant: the resolved grant
   * travels as the call-time `secret` the Google binding authenticates
   * with, and a provider throw is normalized to its code with a fixed
   * message — the expired sync token still reconciles, everything else
   * retries without provider text.
   */
  async function requireUsableGrant(calendarId) {
    // The per-call gate behind every provider call: a revoked grant refuses
    // before any Google read or write. Space scope is enforced once at each
    // public operation entry (requireLiveGrant) — every chain below runs on
    // the same calendarId under the entry that already proved the caller's
    // space owns this calendar.
    const state = await readState(calendarId);
    if (state && state.grantStatus === 'revoked') {
      throw syncError('CALENDAR_GRANT_REVOKED', 409,
        `calendar "${calendarId}" grant is revoked: re-bind it before syncing`);
    }
    return state;
  }

  async function providerCall(calendarId, op, params, purpose) {
    const state = await requireUsableGrant(calendarId);
    const grant = await resolveGrant(state, purpose);
    try {
      return await provider[op]({ ...params, ...(grant === null ? {} : { secret: grant }) });
    } catch (error) {
      if (error?.code === 'GOOGLE_SYNC_TOKEN_INVALID') throw error;
      throw syncError(providerErrorCode(error), providerErrorStatus(error),
        `google calendar ${op} failed without provider detail: retry the sync`);
    }
  }

  /**
   * Map one Google event to the booking request the appointments package
   * validates. Identity (customer, member, service, price) comes only from
   * the deployment mapping: a null subject is an explicit skip, never a
   * fabricated contact.
   */
  function mapEventToBooking(event, calendarId, sourceKey) {
    const subject = mapping.subjectForEvent(event, calendarId);
    if (subject === null || subject === undefined) return null;
    const service = mapping.serviceForEvent(event, calendarId) ?? {};
    return {
      sourceKey,
      subject,
      teamMemberId: mapping.teamMemberForCalendar(calendarId),
      serviceKey: service.serviceKey,
      priceCents: service.priceCents,
      currency: service.currency,
      startsAt: event?.start?.dateTime,
      endsAt: event?.end?.dateTime,
      notes: typeof event?.description === 'string' && event.description !== '' ? event.description : null,
      remindAt: null,
      source: { package: CALENDAR_SYNC_CONSUMER, action: 'calendar-import' },
    };
  }

  /**
   * Book one imported event, folding every expected refusal into a result
   * entry: an overlap or a divergent replay is the operator's conflict to
   * resolve in Accordo, never a row booked over a held slot and never a
   * half-written link. A transient storage conflict (busy, serialization)
   * is rethrown as a retryable error instead — contention is not an
   * operator conflict. Anything else (a 500, a mapping bug) throws.
   * A success clears any pending remote the link carried: it applied.
   */
  async function importSingle(handle, actor, calendarId, event, revision, priorLink, prebuilt = null) {
    const eventId = event?.id;
    const sourceKey = sourceKeyFor(calendarId, eventId, revision);
    const request = prebuilt ?? mapEventToBooking(event, calendarId, sourceKey);
    if (request === null) {
      return { status: 'skipped', eventId, reason: 'no customer mapping for this event (mapping.subjectForEvent returned null)' };
    }
    let booked;
    try {
      booked = await handle.bookAppointment(request);
    } catch (error) {
      if (error instanceof AppError && (error.status === 409 || error.status === 422) && error.details?.transient !== true) {
        return { status: 'conflict', eventId, reason: `${error.code}: ${error.message}` };
      }
      throw error;
    }
    const row = booked.appointment;
    const link = {
      linkKey: linkKeyFor(calendarId, eventId),
      calendarId,
      googleEventId: linkKeyFor(calendarId, eventId),
      appointmentSourceKey: row.sourceKey,
      appointmentId: row.id,
      googleUpdated: event.updated,
      localFingerprint: appointmentFingerprint(row),
      revision,
      conflictNote: null,
      pendingRemote: null,
    };
    if (priorLink) {
      await linkService(context).applyManaged(priorLink.id, { ...link, linkKey: priorLink.linkKey }, { actor });
    } else {
      await storeLink(link, actor);
    }
    return { status: 'imported', eventId, appointmentId: row.id, replayed: booked.replayed ?? false };
  }

  /**
   * Keep a remote change that did not apply as a pending snapshot on the
   * link (an orphan link when no row exists yet), so the next pull retries
   * it instead of losing it with the consumed token. `cancelCommitted`
   * records whether the failed attempt already cancelled the old row: a
   * refused move never cancels, so its retry proves the booking first
   * instead of replaying only the booking half.
   */
  async function keepPending(actor, calendarId, event, priorLink, reason, preStatus = null, opts = {}) {
    const patch = {
      conflictNote: String(reason).slice(0, 300),
      pendingRemote: JSON.stringify({ event, preStatus, cancelCommitted: opts.cancelCommitted ?? true }),
    };
    if (priorLink) {
      await linkService(context).applyManaged(priorLink.id, patch, { actor });
      return { status: 'conflict', eventId: event?.id, reason: patch.conflictNote, pending: true };
    }
    await storeLink({
      linkKey: linkKeyFor(calendarId, event?.id),
      calendarId,
      googleEventId: linkKeyFor(calendarId, event?.id),
      appointmentSourceKey: `pending:${linkKeyFor(calendarId, event?.id)}`,
      appointmentId: '',
      googleUpdated: '',
      localFingerprint: appointmentFingerprint(null),
      revision: 0,
      ...patch,
    }, actor);
    return { status: 'conflict', eventId: event?.id, reason: patch.conflictNote, pending: true };
  }

  /**
   * Refuse a pre-protocol pending with an explicit code and keep it as a
   * visible operator conflict: the snapshot stays on the link, nothing is
   * replayed, nothing is superseded, and no provider write happens — so a
   * legacy row can never turn into a Google cancellation. The operator
   * resolves it in Accordo; the token moves on, the conflict does not hide.
   */
  async function rejectLegacyPending(actor, calendarId, link) {
    const reason = 'CALENDAR_SYNC_PENDING_UPGRADE_REQUIRED: this pending predates the atomic reschedule protocol (no cancelCommitted flag): resolve it in Accordo — the sync will not replay it or cancel Google for it';
    await linkService(context).applyManaged(link.id, { conflictNote: reason.slice(0, 300) }, { actor });
    return { status: 'conflict', eventId: rowLinkEventId(link, calendarId), reason, pending: true };
  }

  /**
   * Finish a reschedule after its rebook committed: carry a `confirmed`
   * forward (the only lifecycle a moved booking keeps) and point the link
   * at the new row. Shared by the fresh path and the pending retry, so a
   * retried move keeps exactly what the first attempt would have kept.
   */
  async function finishReschedule(handle, actor, calendarId, event, link, revision, preStatus, entry) {
    if (preStatus === 'confirmed') {
      const fresh = await readLocal(handle, { appointmentSourceKey: sourceKeyFor(calendarId, event.id, revision), appointmentId: entry.appointmentId });
      // A retried move replays its booking by key: the row may already
      // carry the forward, so only a still-open row advances — never a
      // confirmed-to-confirmed throw on the retry.
      if (fresh && fresh.status === 'booked') {
        await handle.advanceAppointment(fresh, 'confirmed');
      }
    }
    const final = await readLocal(handle, { appointmentSourceKey: sourceKeyFor(calendarId, event.id, revision), appointmentId: entry.appointmentId });
    await linkService(context).applyManaged(link.id, {
      appointmentSourceKey: final.sourceKey,
      appointmentId: final.id,
      googleUpdated: event.updated,
      localFingerprint: appointmentFingerprint(final),
      revision,
      conflictNote: null,
      pendingRemote: null,
    }, { actor });
  }

  /**
   * Retry one pending snapshot: a pre-protocol envelope is rejected
   * visibly (never replayed, never a Google write); an orphan replays the
   * import; a snapshot whose cancel already committed replays only the
   * booking half and finishes like the fresh path, confirmed-forward
   * included; a refused move whose cancel never committed re-decides on
   * current state through the tracked path — terminal immunity and
   * cancellation-wins included — so a locally cancelled or completed row
   * is never rebooked over.
   */
  async function retryPending(handle, actor, calendarId, link) {
    let envelope;
    try {
      envelope = JSON.parse(link.pendingRemote);
    } catch {
      await linkService(context).applyManaged(link.id, { pendingRemote: null, conflictNote: 'pending snapshot unreadable: dropped by operator decision' }, { actor });
      return { status: 'conflict', eventId: link.googleEventId, reason: 'pending snapshot unreadable' };
    }
    if (isLegacyPending(link)) {
      return rejectLegacyPending(actor, calendarId, link);
    }
    const orphan = link.appointmentId === '';
    const snapshotEvent = (envelope && typeof envelope === 'object' ? (envelope.event ?? envelope) : null);
    if (snapshotEvent && isNewerThan(link.googleUpdated, snapshotEvent?.updated)) {
      // The link already decided a newer Google version than this snapshot
      // while the snapshot stood: retrying the older envelope would move
      // the link backward past consumed state, so it is left pending for
      // the operator instead of retried — never silently dropped.
      return { status: 'conflict', eventId: link.googleEventId, reason: `stale snapshot: the link knows a newer version (${link.conflictNote ?? 'no earlier note'})`, pending: true };
    }
    if (!orphan && envelope && typeof envelope === 'object' && envelope.cancelCommitted === false) {
      const out = await applyTrackedChange(handle, actor, calendarId, envelope.event ?? envelope, link);
      if (out.status === 'applied' || out.status === 'imported') return { ...out, retried: true };
      return out;
    }
    let event = envelope;
    // The envelope carries the pre-cancel status the failed attempt saw:
    // the cancel moved the row, so the link alone no longer knows it.
    // Older pendings predate the envelope — those fall back to the
    // fingerprint, which still holds the pre-cancel row for the same
    // reason (the cancel moved the row, never the link).
    const preStatus = orphan
      ? null
      : (typeof event?.preStatus === 'string' ? event.preStatus : JSON.parse(link.localFingerprint)[3]);
    event = event?.event ?? event;
    const entry = await importSingle(handle, actor, calendarId, event, orphan ? (link.revision ?? 0) : (link.revision ?? 0) + 1, link);
    if (entry.status !== 'imported') {
      await linkService(context).applyManaged(link.id, { conflictNote: String(entry.reason ?? entry.status).slice(0, 300) }, { actor });
      return { ...entry, pending: true };
    }
    if (!orphan) {
      await finishReschedule(handle, actor, calendarId, event, link, (link.revision ?? 0) + 1, preStatus, entry);
    }
    return { ...entry, retried: true };
  }

  /**
   * **The written conflict rule** (acceptance, also in README.md §Conflict
   * rule and in the package metadata): Accordo owns lifecycle, Google owns
   * schedule. A Google schedule change on an open local row moves the
   * booking atomically — the old row is cancelled (reason naming Google)
   * only with its rebook under a revisioned key, preserving a `confirmed`
   * forward, so a refused rebook keeps the valid local row; on a terminal
   * row the change is ignored — a happened visit is evidence, never
   * rewritten. A local cancellation always wins over a concurrent Google
   * change: the sync pushes the cancellation to Google so both sides
   * converge on the freed slot. A move that cannot apply yet is kept
   * pending and retried — the active event is never silently unrepresented
   * and the valid row is never sacrificed to the retry.
   */
  async function applyRemoteChange(handle, actor, calendarId, event) {
    const eventId = event?.id;
    const link = await findLinkByEvent(calendarId, eventId);
    const cancelled = event?.status === 'cancelled';

    if (!link) {
      if (cancelled) return { status: 'ignored', eventId, reason: 'tombstone for an event never imported' };
      const entry = await importSingle(handle, actor, calendarId, event, 0, null);
      if (entry.status !== 'imported') return keepPending(actor, calendarId, event, null, entry.reason);
      return entry;
    }
    if (link.pendingRemote) {
      if (isLegacyPending(link)) {
        // A pre-protocol snapshot is never re-decided — not even by a
        // tombstone or a newer event: the envelope predates the protocol
        // this decision would run under.
        return rejectLegacyPending(actor, calendarId, link);
      }
      if (cancelled) {
        // A tombstone supersedes the outstanding snapshot: the event is
        // gone, so retrying its move would book a dead slot and swallow
        // the cancellation with the advancing token. The tracked path
        // cancels the local row and clears the snapshot with it.
        return applyTrackedChange(handle, actor, calendarId, event, link);
      }
      const snapshotEvent = pendingSnapshotEvent(link);
      if (snapshotEvent && isNewerThan(event?.updated, snapshotEvent?.updated)) {
        // Newest Google version wins over the older pending snapshot: the
        // stale envelope is replaced by the event in hand, which is
        // decided through the tracked path. The old envelope is never
        // retried, and a refusal on the new event re-stages the NEW
        // snapshot — the token never advances past an event this branch
        // did not decide. (The tracked path never reads the cleared
        // snapshot; only the link id and its revisioned keys travel on.)
        await linkService(context).applyManaged(link.id, { pendingRemote: null, conflictNote: null }, { actor });
        return applyTrackedChange(handle, actor, calendarId, event, link);
      }
      const retried = await retryPending(handle, actor, calendarId, link);
      if (retried.status !== 'imported' && retried.status !== 'applied') return retried;
      // The retry settled the snapshot; the event in hand may be newer
      // than it (the token moved on), so it still goes through the normal
      // path — now pending-free, so this recurses exactly once.
      return applyRemoteChange(handle, actor, calendarId, event);
    }
    return applyTrackedChange(handle, actor, calendarId, event, link);
  }

  /**
   * The tracked half of the conflict rule: the link names a local row and
   * no snapshot is outstanding. Also the retry target for a refused move
   * whose cancel never committed — the link still names the valid old row,
   * so deciding on current state (terminal immunity, cancellation-wins,
   * atomic move) is exactly the fresh decision.
   */
  async function applyTrackedChange(handle, actor, calendarId, event, link) {
    const eventId = event?.id;
    const cancelled = event?.status === 'cancelled';
    const row = await readLocal(handle, link);
    if (!row) {
      if (cancelled) {
        // A tombstone for a row that is already gone (an orphan pending
        // import included): nothing to heal, so the snapshot clears
        // instead of booking a dead event's slot.
        await linkService(context).applyManaged(link.id, {
          googleUpdated: event.updated, conflictNote: null, pendingRemote: null,
        }, { actor });
        return { status: 'ignored', eventId, reason: 'tombstone for a lost row: nothing to heal' };
      }
      const entry = await importSingle(handle, actor, calendarId, event, link.revision ?? 0, link);
      if (entry.status !== 'imported') {
        return keepPending(actor, calendarId, event, link, entry.reason ?? 'linked row gone and re-import refused');
      }
      return { ...entry, healed: true };
    }
    const localStatus = JSON.parse(link.localFingerprint)[3];
    const locallyCancelled = row.status === 'cancelled' && localStatus !== 'cancelled';

    if (cancelled) {
      // A tombstone supersedes any outstanding move snapshot: the event is
      // gone, so the retry vehicle goes with it — never a perpetual pending
      // for a move nobody can apply anymore.
      if (row.status === 'cancelled') {
        await linkService(context).applyManaged(link.id, {
          googleUpdated: event.updated, localFingerprint: appointmentFingerprint(row),
          conflictNote: null, pendingRemote: null,
        }, { actor });
        return { status: 'replayed', eventId, reason: 'already cancelled on both sides' };
      }
      if (TERMINAL_STATUSES.includes(row.status)) {
        await linkService(context).applyManaged(link.id, {
          googleUpdated: event.updated, conflictNote: null, pendingRemote: null,
        }, { actor });
        return { status: 'ignored', eventId, reason: `local row is terminal ("${row.status}"): a happened visit is never rewritten` };
      }
      await handle.advanceAppointment(row, 'cancelled', 'Cancelled in Google Calendar');
      const updated = await readLocal(handle, link);
      await linkService(context).applyManaged(link.id, {
        googleUpdated: event.updated, localFingerprint: appointmentFingerprint(updated),
        conflictNote: null, pendingRemote: null,
      }, { actor });
      return { status: 'applied', eventId, direction: 'google-to-local', change: 'cancelled' };
    }

    // An active remote event.
    if (event.updated === link.googleUpdated && row.status === localStatus) {
      return { status: 'replayed', eventId, reason: 'same sync token delivered twice: stored once' };
    }
    if (locallyCancelled) {
      // Cancellation wins: converge Google onto the freed slot. A pending
      // move snapshot is moot — the local cancel it raced has won — so it
      // clears instead of retrying a move onto a freed booking forever.
      const pushed = await providerCall(calendarId, 'cancelEvent', { calendarId, eventId }, GRANT_PURPOSE_WRITE);
      await linkService(context).applyManaged(link.id, {
        googleUpdated: pushed.updated, localFingerprint: appointmentFingerprint(row),
        conflictNote: null, pendingRemote: null,
      }, { actor });
      return { status: 'applied', eventId, direction: 'local-to-google', change: 'cancelled' };
    }
    const slotMoved = row.startsAt !== event?.start?.dateTime || row.endsAt !== event?.end?.dateTime;
    if (!slotMoved) {
      // Notes/summary only: appointment rows are evidence-immutable outside
      // lifecycle, so there is no local write path — acknowledged, applied
      // to nothing, and said so in the entry.
      await linkService(context).applyManaged(link.id, {
        googleUpdated: event.updated, localFingerprint: appointmentFingerprint(row),
      }, { actor });
      return { status: 'acknowledged', eventId, reason: 'notes/summary only: appointment rows change lifecycle, never prose' };
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      await linkService(context).applyManaged(link.id, {
        googleUpdated: event.updated, conflictNote: null, pendingRemote: null,
      }, { actor });
      return { status: 'ignored', eventId, reason: `local row is terminal ("${row.status}"): a happened visit is never rewritten` };
    }
    return moveBooking(handle, actor, calendarId, event, link, row);
  }

  /**
   * Move one booking to Google's new slot without ever sacrificing the
   * valid local row: the cancel commits only with its rebook, in one
   * storage transaction — rollback on refusal, which also covers
   * self-overlapping moves (a cancelled row holds no slot, so the rebook
   * reads the freed slot inside the same commit). The domain events the
   * move emits stay buffered until after the storage commit (ADR-012):
   * a refused move rolls back the rows AND drops the ghost emissions, so
   * no in-process listener ever observes a cancel that never committed.
   * A refused move keeps the row and the pending snapshot retries it; a
   * transient storage conflict (busy, serialization) is rethrown as a
   * retryable error, never staged as a pending conflict.
   */
  async function moveBooking(handle, actor, calendarId, event, link, row) {
    const eventId = event?.id;
    const revision = (link.revision ?? 0) + 1;
    const request = mapEventToBooking(event, calendarId, sourceKeyFor(calendarId, eventId, revision));
    if (request === null) {
      return { status: 'skipped', eventId, reason: 'no customer mapping for this event (mapping.subjectForEvent returned null)' };
    }
    const live = await readLocal(handle, link);
    if (!live || live.status !== row.status) {
      // The row moved under us (a local cancel, a terminal advance, or a
      // retry on changed state): re-dispatch so the lifecycle, terminal and
      // cancellation-wins branches — never the move — decide. Terminates:
      // the re-dispatch reads fresh state and takes another branch.
      return applyTrackedChange(handle, actor, calendarId, event, link);
    }
    const critical = async () => {
      await handle.advanceAppointment(live, 'cancelled', 'Rescheduled in Google Calendar');
      const booked = await handle.bookAppointment(request);
      await finishReschedule(handle, actor, calendarId, event, link, revision, row.status, { appointmentId: booked.appointment.id });
    };
    try {
      if (eventBuffer) {
        await eventBuffer.buffered(async (outbox) => {
          await transact(critical);
          await outbox.commit();
        });
      } else {
        await transact(critical);
      }
    } catch (error) {
      if (error instanceof AppError && (error.status === 409 || error.status === 422) && error.details?.transient !== true) {
        return keepPending(actor, calendarId, event, link, `${error.code}: ${error.message}`, row.status, { cancelCommitted: false });
      }
      throw error;
    }
    return { status: 'applied', eventId, direction: 'google-to-local', change: 'rescheduled', revision };
  }

  async function reconcileFull(handle, actor, calendarId, timeMin) {
    const page = await providerCall(calendarId, 'listEvents',
      { calendarId, timeMin: timeMin ?? now(), showDeleted: true }, GRANT_PURPOSE_READ);
    const entries = [];
    for (const event of page.items) {
      entries.push(await applyRemoteChange(handle, actor, calendarId, event));
    }
    await writeState(calendarId, { syncToken: page.nextSyncToken }, actor);
    return { recovered: true, entries, nextSyncToken: page.nextSyncToken };
  }

  async function pendingConflicts(calendarId) {
    const rows = await linkService(context).listWhere({ calendarId });
    return rows
      .filter((row) => row.conflictNote)
      .map((row) => ({ eventId: row.googleEventId, reason: row.conflictNote }));
  }

  async function retryPendings(handle, actor, calendarId) {
    const rows = await linkService(context).listWhere({ calendarId });
    const entries = [];
    for (const link of rows.filter((row) => row.pendingRemote)) {
      entries.push(await retryPending(handle, actor, calendarId, link));
    }
    return entries;
  }

  const api = {
    /**
     * Full import of future events (the first sync ever on a calendar —
     * and the operator's re-run instead of an incremental pull). Deleted
     * events list as tombstones and converge through the tracked path
     * like any other remote change: the token never moves past a
     * cancellation it did not read, so a disdetta between two imports
     * applies instead of being skipped past. A tombstone for an event
     * never imported is ignored, never booked, never kept pending.
     */
    async importFuture(calendarId, { spaceId, timeMin, actor } = {}) {
      const who = actor ?? defaultActor;
      await requireLiveGrant(calendarId, spaceId);
      const handle = bookHandle(who);
      const page = await providerCall(calendarId, 'listEvents',
        { calendarId, timeMin: timeMin ?? now(), showDeleted: true }, GRANT_PURPOSE_READ);
      const entries = [];
      for (const event of page.items) {
        if (event?.status === 'cancelled') {
          // Tombstones converge through the tracked path whether or not
          // the event was imported: unknown ones ignore, known ones
          // cancel — including past an outstanding move snapshot, which
          // the tombstone supersedes.
          entries.push(await applyRemoteChange(handle, who, calendarId, event));
          continue;
        }
        const known = await findLinkByEvent(calendarId, event.id);
        if (known) {
          if (known.pendingRemote) {
            if (isLegacyPending(known)) {
              entries.push(await rejectLegacyPending(who, calendarId, known));
              continue;
            }
            const snapshotEvent = pendingSnapshotEvent(known);
            if (snapshotEvent && isNewerThan(event?.updated, snapshotEvent?.updated)) {
              // Same newest-wins rule as the incremental path: the newer
              // event in hand is decided instead of retrying the stale
              // snapshot first (the retry could converge the link onto the
              // older slot before the newer event is even examined).
              entries.push(await applyRemoteChange(handle, who, calendarId, event));
              continue;
            }
            const retried = await retryPending(handle, who, calendarId, known);
            // A settled retry is either state: 'imported' (orphan replay)
            // or 'applied' (a converged move via the tracked path, e.g. a
            // cancelCommitted:false retry that just booked). Like the
            // incremental path's guard, both fall through so the event in
            // hand — possibly newer than the snapshot — still decides.
            if (retried.status !== 'imported' && retried.status !== 'applied') {
              entries.push(retried);
              continue;
            }
          }
          const fresh = await findLinkByEvent(calendarId, event.id);
          if (fresh && event.updated === fresh.googleUpdated && !fresh.pendingRemote) {
            entries.push({ status: 'already-tracked', eventId: event.id });
          } else {
            entries.push(await applyRemoteChange(handle, who, calendarId, event));
          }
          continue;
        }
        const entry = await importSingle(handle, who, calendarId, event, 0, null);
        // A refusal (overlap) is kept pending and retried; a skip
        // (unmapped customer) is reported as-is — retrying it would heal
        // nothing, the mapping is still absent.
        entries.push(entry.status === 'conflict'
          ? await keepPending(who, calendarId, event, null, entry.reason)
          : entry);
      }
      await writeState(calendarId, { syncToken: page.nextSyncToken }, who);
      return { calendarId, entries, nextSyncToken: page.nextSyncToken };
    },

    /** Incremental pull on the stored sync token (expired token → full reconcile). */
    async pullIncremental(calendarId, { spaceId, actor } = {}) {
      const who = actor ?? defaultActor;
      await requireLiveGrant(calendarId, spaceId);
      const handle = bookHandle(who);
      const state = await readState(calendarId);
      if (!state?.syncToken) {
        throw syncError('CALENDAR_SYNC_NEVER_IMPORTED', 500,
          `calendar "${calendarId}" was never imported: run importFuture before the first incremental pull`);
      }
      const retried = await retryPendings(handle, who, calendarId);
      let page;
      try {
        page = await providerCall(calendarId, 'listEvents',
          { calendarId, syncToken: state.syncToken }, GRANT_PURPOSE_READ);
      } catch (error) {
        if (error?.code === 'GOOGLE_SYNC_TOKEN_INVALID') {
          const recovered = await reconcileFull(handle, who, calendarId);
          return { calendarId, retried, ...recovered, pendingConflicts: await pendingConflicts(calendarId) };
        }
        throw error;
      }
      const entries = [...retried];
      for (const event of page.items) {
        entries.push(await applyRemoteChange(handle, who, calendarId, event));
      }
      await writeState(calendarId, { syncToken: page.nextSyncToken }, who);
      return { calendarId, entries, nextSyncToken: page.nextSyncToken, pendingConflicts: await pendingConflicts(calendarId) };
    },

    /**
     * Push one local appointment to Google by source key: first reconcile
     * with the provider (an event the export already inserted but never
     * linked is linked, not inserted twice), then insert, then converge
     * local cancellations. Any other lifecycle advance is Accordo-owned
     * and acknowledged without a provider write. A repeated push with
     * nothing changed is a no-op — the second of two syncs in a row
     * writes nothing anywhere.
     */
    async pushAppointment(calendarId, sourceKey, { spaceId, actor } = {}) {
      const who = actor ?? defaultActor;
      await requireLiveGrant(calendarId, spaceId);
      const handle = bookHandle(who);
      const row = await handle.appointmentBySourceKey(sourceKey);
      if (!row) {
        throw syncError('CALENDAR_SYNC_UNKNOWN_APPOINTMENT', 404, `no appointment with sourceKey "${sourceKey}"`);
      }
      const link = await findLinkBySource(sourceKey);
      if (!link) {
        const reconciled = await providerCall(calendarId, 'findByAccordoSourceKey',
          { calendarId, sourceKey: row.sourceKey }, GRANT_PURPOSE_READ);
        if (reconciled) {
          await storeLink({
            linkKey: linkKeyFor(calendarId, reconciled.id),
            calendarId,
            googleEventId: linkKeyFor(calendarId, reconciled.id),
            appointmentSourceKey: row.sourceKey,
            appointmentId: row.id,
            googleUpdated: reconciled.updated,
            localFingerprint: appointmentFingerprint(row),
            revision: 0,
            conflictNote: null,
            pendingRemote: null,
          }, who);
          return { status: 'linked', eventId: reconciled.id, sourceKey: row.sourceKey, healed: true };
        }
        const summary = mapping.summaryForAppointment(row, calendarId);
        if (typeof summary !== 'string' || summary.trim() === '') {
          throw new ValidationError('calendar-sync mapping.summaryForAppointment must return non-empty text', {
            field: 'mapping.summaryForAppointment',
          });
        }
        const created = await providerCall(calendarId, 'insertEvent', {
          calendarId,
          summary: summary.slice(0, 200),
          description: row.notes ?? '',
          start: { dateTime: row.startsAt },
          end: { dateTime: row.endsAt },
          extendedProperties: { accordoSourceKey: row.sourceKey, accordoSubject: `${row.subjectResource}:${row.subjectId}` },
        }, GRANT_PURPOSE_WRITE);
        await storeLink({
          linkKey: linkKeyFor(calendarId, created.id),
          calendarId,
          googleEventId: linkKeyFor(calendarId, created.id),
          appointmentSourceKey: row.sourceKey,
          appointmentId: row.id,
          googleUpdated: created.updated,
          localFingerprint: appointmentFingerprint(row),
          revision: 0,
          conflictNote: null,
          pendingRemote: null,
        }, who);
        return { status: 'exported', eventId: created.id, sourceKey: row.sourceKey };
      }
      const fingerprint = appointmentFingerprint(row);
      if (fingerprint === link.localFingerprint && !link.conflictNote) {
        return { status: 'noop', sourceKey, reason: 'nothing changed since the last push' };
      }
      if (row.status === 'cancelled' && JSON.parse(link.localFingerprint)[3] !== 'cancelled') {
        const pushed = await providerCall(calendarId, 'cancelEvent',
          { calendarId, eventId: rowLinkEventId(link, calendarId) }, GRANT_PURPOSE_WRITE);
        await linkService(context).applyManaged(link.id, {
          googleUpdated: pushed.updated, localFingerprint: fingerprint, conflictNote: null,
        }, { actor: who });
        return { status: 'pushed', sourceKey, change: 'cancelled' };
      }
      await linkService(context).applyManaged(link.id, { localFingerprint: fingerprint }, { actor: who });
      return { status: 'acknowledged', sourceKey, reason: 'lifecycle is Accordo-owned: confirmed/done/no-show stay local' };
    },

    /** Push every linked row of a calendar whose local half moved. */
    async pushLocalChanges(calendarId, { spaceId, actor } = {}) {
      await requireLiveGrant(calendarId, spaceId);
      const links = await linkService(context).listWhere({ calendarId });
      const entries = [];
      for (const link of links.filter((row) => row.appointmentId !== '')) {
        entries.push(await api.pushAppointment(calendarId, link.appointmentSourceKey, { spaceId, actor }));
      }
      return { calendarId, entries };
    },

    /** One pull plus one push: the second consecutive run changes nothing. */
    async syncOnce(calendarId, options = {}) {
      const pull = await api.pullIncremental(calendarId, options);
      const push = await api.pushLocalChanges(calendarId, options);
      return { calendarId, pull, push };
    },

    /**
     * Handle one Google push delivery: unknown channel or wrong token is
     * refused before anything is read — the token is verified before the
     * grant state is even looked at, so an unauthenticated probe can never
     * tell a revoked channel from a live one; the handshake state (`sync`)
     * only acknowledges the watch; anything else pulls incrementally.
     */
    async handlePush({ channelId, channelToken, resourceState, spaceId } = {}) {
      const states = await stateService(context).listWhere({});
      const state = states.find((row) => row.channelId === channelId && channelId);
      if (!state) {
        throw syncError('CALENDAR_PUSH_UNKNOWN_CHANNEL', 404, 'push for an unknown channel: never pull on an unverified signal');
      }
      const candidate = typeof channelToken === 'string' ? channelToken : '';
      const digest = (value) => createHash('sha256').update(value).digest();
      const expected = Buffer.from(String(state.channelTokenHash ?? ''), 'hex');
      const actual = digest(candidate);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw syncError('CALENDAR_PUSH_FORBIDDEN', 403, 'push channel token mismatch: the signal is not Google\'s');
      }
      if (state.spaceId !== null && state.spaceId !== undefined && state.spaceId !== spaceId) {
        // Same unknown-channel refusal: a forged delivery for another
        // space reads as unknown, never as a cross-space oracle.
        throw syncError('CALENDAR_PUSH_UNKNOWN_CHANNEL', 404, 'push for an unknown channel: never pull on an unverified signal');
      }
      if (state.grantStatus === 'revoked') {
        throw syncError('CALENDAR_GRANT_REVOKED', 409,
          `calendar "${state.calendarId}" grant is revoked: re-bind it before syncing`);
      }
      if (resourceState === 'sync') return { effect: 'ack', calendarId: state.calendarId };
      const pull = await api.pullIncremental(state.calendarId, { spaceId });
      return { effect: 'pulled', calendarId: state.calendarId, pull };
    },

    /**
     * Register a push channel: stores the channel id and the token hash —
     * the bearer token itself never lands in a row — and stamps the sync
     * token baseline when the watch answers `sync`.
     */
    async watchCalendar(calendarId, { spaceId, channelId, resourceId, channelToken, actor } = {}) {
      const who = actor ?? defaultActor;
      if (typeof channelId !== 'string' || channelId === '' || typeof channelToken !== 'string' || channelToken === '') {
        throw new ValidationError('watchCalendar needs the provider channel id and Bearer [REDACTED]', { field: 'watch' });
      }
      await requireLiveGrant(calendarId, spaceId);
      const channelTokenHash = createHash('sha256').update(channelToken).digest('hex');
      await writeState(calendarId, { channelId, channelTokenHash, resourceId: resourceId ?? null }, who);
      return { channelId, calendarId };
    },

    /**
     * Bind one calendar to the space's Google grant: the human decision of
     * connecting. Stores the vault secretRef on the calendar's state row
     * and marks the grant active — the grant value itself is resolved per
     * call and never lands in a row. Re-binding a revoked calendar
     * reconnects it under the new reference; the push channel stays
     * forgotten until the deployment watches again.
     */
    async bindCalendarGrant({ spaceId, calendarId, secretRef, actor } = {}) {
      const who = requireUserActor(actor, 'Bind calendar grant');
      const space = assertGrantText(spaceId, 'spaceId', 128);
      const cal = assertGrantText(calendarId, 'calendarId', 128);
      const ref = assertSecretReference(secretRef);
      const existing = await readState(cal);
      if (existing && existing.grantStatus === 'active'
        && existing.spaceId !== null && existing.spaceId !== undefined && existing.spaceId !== space) {
        // One space never hijacks another's live binding: the owning space
        // revokes first. A conflict without naming the owning space.
        throw syncError('CALENDAR_GRANT_ALREADY_BOUND', 409,
          `calendar "${cal}" is already bound: revoke it from its owning space before re-binding`);
      }
      await writeState(cal, { spaceId: space, secretRef: ref, grantStatus: 'active' }, who);
      return { calendarId: cal, spaceId: space, secretRef: ref, grantStatus: 'active' };
    },

    /**
     * Revoke one calendar's space grant: the human decision of
     * disconnecting. The sync stops on the next call — pulls, pushes,
     * imports and push deliveries all refuse — and the push channel
     * registration is forgotten, so a stale Google push afterwards
     * refuses as an unknown channel. The resolved grant lives only in
     * per-call locals, so nothing in memory survives this return; the
     * row keeps the reference (a locator, never the grant) for audit.
     */
    async revokeCalendarGrant({ spaceId, calendarId, actor } = {}) {
      const who = requireUserActor(actor, 'Revoke calendar grant');
      const space = assertGrantText(spaceId, 'spaceId', 128);
      const cal = assertGrantText(calendarId, 'calendarId', 128);
      const state = await readState(cal);
      if (!state || state.grantStatus !== 'active' || !state.secretRef) {
        throw syncError('CALENDAR_GRANT_UNKNOWN', 404,
          `calendar "${cal}" has no active grant to revoke`);
      }
      if (state.spaceId !== null && state.spaceId !== undefined && state.spaceId !== space) {
        // The shared process syncs many spaces: one space never revokes
        // another's grant. Unknown either way — no cross-space oracle.
        throw syncError('CALENDAR_GRANT_UNKNOWN', 404,
          `calendar "${cal}" has no active grant to revoke`);
      }
      await writeState(cal, {
        grantStatus: 'revoked', channelId: null, channelTokenHash: null, resourceId: null,
      }, who);
      return { calendarId: cal, grantStatus: 'revoked' };
    },
  };

  return api;

  function rowLinkEventId(link, calendarId) {
    // The stored Google id is scoped as `<calendarId>:<eventId>`: strip the
    // known prefix rather than splitting, so a scoped id stays exact.
    const scoped = String(link.googleEventId ?? '');
    const prefix = `${calendarId}:`;
    return scoped.startsWith(prefix) ? scoped.slice(prefix.length) : scoped;
  }
}
