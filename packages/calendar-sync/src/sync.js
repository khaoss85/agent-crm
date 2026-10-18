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
 * pattern): when it carries `transactionAsync`, a reschedule commits its
 * cancel and its rebook together. Without it the link records' own handle
 * is tried; without either, the rebook is proven before the cancel.
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
  const defaultActor = options.actor ?? { type: 'system', id: 'calendar-sync' };
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const context = { modules, names };
  const database = options.database ?? null;
  if (database !== null && typeof database !== 'object') {
    throw new ValidationError('calendar-sync database must be an object when provided', { field: 'database' });
  }

  /**
   * The storage transaction a reschedule commits in: the deployment's
   * explicit handle first, else the link records' own handle (the same
   * `?.database?.transactionAsync` idiom the appointments booking path
   * uses). Null when neither carries one — every write still goes through
   * the capability and the record services, the transaction only adds
   * atomicity, so a missing one degrades to prove-before-cancel, never to
   * cancel-before-proof.
   */
  function transactionRunner() {
    if (typeof database?.transactionAsync === 'function') {
      return (critical) => database.transactionAsync(critical);
    }
    const linkDb = linkService(context)?.database ?? null;
    if (typeof linkDb?.transactionAsync === 'function') {
      return (critical) => linkDb.transactionAsync(critical);
    }
    return null;
  }

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
      ...patch,
    }, { actor });
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
   * half-written link. Anything else (a 500, a mapping bug) throws.
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
      if (error instanceof AppError && (error.status === 409 || error.status === 422)) {
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
   * Retry one pending snapshot: an orphan replays the import; a snapshot
   * whose cancel already committed replays only the booking half and
   * finishes like the fresh path, confirmed-forward included; a refused
   * move whose cancel never committed re-decides on current state through
   * the tracked path — terminal immunity and cancellation-wins included —
   * so a locally cancelled or completed row is never rebooked over.
   */
  async function retryPending(handle, actor, calendarId, link) {
    let envelope;
    try {
      envelope = JSON.parse(link.pendingRemote);
    } catch {
      await linkService(context).applyManaged(link.id, { pendingRemote: null, conflictNote: 'pending snapshot unreadable: dropped by operator decision' }, { actor });
      return { status: 'conflict', eventId: link.googleEventId, reason: 'pending snapshot unreadable' };
    }
    const orphan = link.appointmentId === '';
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
      if (cancelled) {
        // A tombstone supersedes the outstanding snapshot: the event is
        // gone, so retrying its move would book a dead slot and swallow
        // the cancellation with the advancing token. The tracked path
        // cancels the local row and clears the snapshot with it.
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
      const pushed = await provider.cancelEvent({ calendarId, eventId });
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
   * valid local row: the cancel commits only with its rebook. With a
   * storage transaction both commit together — rollback on refusal, which
   * also covers self-overlapping moves (a cancelled row holds no slot, so
   * the rebook reads the freed slot inside the same commit). Without one
   * the rebook is proven first and the cancel follows only on success,
   * staged behind a pending snapshot so a crash between the proven booking
   * and its link update still retries instead of dropping the move. A
   * refused move keeps the row and the pending snapshot retries it; the
   * token is acknowledged either way.
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
    const transact = transactionRunner();
    if (transact) {
      try {
        await transact(async () => {
          await handle.advanceAppointment(live, 'cancelled', 'Rescheduled in Google Calendar');
          const booked = await handle.bookAppointment(request);
          await finishReschedule(handle, actor, calendarId, event, link, revision, row.status, { appointmentId: booked.appointment.id });
        });
      } catch (error) {
        if (error instanceof AppError && (error.status === 409 || error.status === 422)) {
          return keepPending(actor, calendarId, event, link, `${error.code}: ${error.message}`, row.status, { cancelCommitted: false });
        }
        throw error;
      }
      return { status: 'applied', eventId, direction: 'google-to-local', change: 'rescheduled', revision };
    }
    await keepPending(actor, calendarId, event, link, 'move staged: proving the new slot before cancelling', row.status, { cancelCommitted: false });
    let booked;
    try {
      booked = await handle.bookAppointment(request);
    } catch (error) {
      if (error instanceof AppError && (error.status === 409 || error.status === 422)) {
        return keepPending(actor, calendarId, event, link, `${error.code}: ${error.message}`, row.status, { cancelCommitted: false });
      }
      throw error;
    }
    // The new slot proved free: finish the move. The pre-cancel read above
    // still holds, so only a still-open row is cancelled — a concurrent
    // local move is never overwritten, and the success clears the staged
    // snapshot through the link update.
    const afterBook = await readLocal(handle, link);
    if (afterBook && afterBook.status !== 'cancelled' && !TERMINAL_STATUSES.includes(afterBook.status)) {
      await handle.advanceAppointment(afterBook, 'cancelled', 'Rescheduled in Google Calendar');
    }
    await finishReschedule(handle, actor, calendarId, event, link, revision, row.status, { appointmentId: booked.appointment.id });
    return { status: 'applied', eventId, direction: 'google-to-local', change: 'rescheduled', revision };
  }

  async function reconcileFull(handle, actor, calendarId, timeMin) {
    const page = await provider.listEvents({ calendarId, timeMin: timeMin ?? now(), showDeleted: true });
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
    async importFuture(calendarId, { timeMin, actor } = {}) {
      const who = actor ?? defaultActor;
      const handle = bookHandle(who);
      const page = await provider.listEvents({ calendarId, timeMin: timeMin ?? now(), showDeleted: true });
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
    async pullIncremental(calendarId, { actor } = {}) {
      const who = actor ?? defaultActor;
      const handle = bookHandle(who);
      const state = await readState(calendarId);
      if (!state?.syncToken) {
        throw syncError('CALENDAR_SYNC_NEVER_IMPORTED', 500,
          `calendar "${calendarId}" was never imported: run importFuture before the first incremental pull`);
      }
      const retried = await retryPendings(handle, who, calendarId);
      let page;
      try {
        page = await provider.listEvents({ calendarId, syncToken: state.syncToken });
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
    async pushAppointment(calendarId, sourceKey, { actor } = {}) {
      const who = actor ?? defaultActor;
      const handle = bookHandle(who);
      const row = await handle.appointmentBySourceKey(sourceKey);
      if (!row) {
        throw syncError('CALENDAR_SYNC_UNKNOWN_APPOINTMENT', 404, `no appointment with sourceKey "${sourceKey}"`);
      }
      const link = await findLinkBySource(sourceKey);
      if (!link) {
        const reconciled = await provider.findByAccordoSourceKey(calendarId, row.sourceKey);
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
        const created = await provider.insertEvent({
          calendarId,
          summary: summary.slice(0, 200),
          description: row.notes ?? '',
          start: { dateTime: row.startsAt },
          end: { dateTime: row.endsAt },
          extendedProperties: { accordoSourceKey: row.sourceKey, accordoSubject: `${row.subjectResource}:${row.subjectId}` },
        });
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
        const pushed = await provider.cancelEvent({ calendarId, eventId: rowLinkEventId(link, calendarId) });
        await linkService(context).applyManaged(link.id, {
          googleUpdated: pushed.updated, localFingerprint: fingerprint, conflictNote: null,
        }, { actor: who });
        return { status: 'pushed', sourceKey, change: 'cancelled' };
      }
      await linkService(context).applyManaged(link.id, { localFingerprint: fingerprint }, { actor: who });
      return { status: 'acknowledged', sourceKey, reason: 'lifecycle is Accordo-owned: confirmed/done/no-show stay local' };
    },

    /** Push every linked row of a calendar whose local half moved. */
    async pushLocalChanges(calendarId, { actor } = {}) {
      const links = await linkService(context).listWhere({ calendarId });
      const entries = [];
      for (const link of links.filter((row) => row.appointmentId !== '')) {
        entries.push(await api.pushAppointment(calendarId, link.appointmentSourceKey, { actor }));
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
     * refused before anything is read; the handshake state (`sync`) only
     * acknowledges the watch; anything else pulls incrementally.
     */
    async handlePush({ channelId, channelToken, resourceState } = {}) {
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
      if (resourceState === 'sync') return { effect: 'ack', calendarId: state.calendarId };
      const pull = await api.pullIncremental(state.calendarId);
      return { effect: 'pulled', calendarId: state.calendarId, pull };
    },

    /**
     * Register a push channel: stores the channel id and the token hash —
     * the bearer token itself never lands in a row — and stamps the sync
     * token baseline when the watch answers `sync`.
     */
    async watchCalendar(calendarId, { channelId, resourceId, channelToken, actor } = {}) {
      const who = actor ?? defaultActor;
      if (typeof channelId !== 'string' || channelId === '' || typeof channelToken !== 'string' || channelToken === '') {
        throw new ValidationError('watchCalendar needs the provider channel id and bearer token', { field: 'watch' });
      }
      const channelTokenHash = createHash('sha256').update(channelToken).digest('hex');
      await writeState(calendarId, { channelId, channelTokenHash, resourceId: resourceId ?? null }, who);
      return { channelId, calendarId };
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
