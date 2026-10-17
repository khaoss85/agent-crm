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
 *   stay in `packages/appointments`, written only through its
 *   `appointment-book@1` capability, opened here per call with this
 *   package as the consumer — so `source.package` on imported rows is
 *   `calendar-sync`, the identity the registry proved, never caller text.
 * - no customer master table: the customer of an imported event is the
 *   deployment-owned mapping (`mapping.subjectForEvent`), the same opaque
 *   envelope appointments already store. No roster, no catalog, no pricing:
 *   the team member, service and price are deployment mappings too.
 *
 * What it owns: the link rows joining one Google event to one appointment
 * row, the per-calendar sync token, the push-channel registry (token hashes
 * only), and the written conflict rule — Accordo owns lifecycle, Google
 * owns schedule — applied in `applyRemoteChange` and proven by the tests.
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

const sourceKeyFor = (eventId, revision) => (revision > 0 ? `gcal:${eventId}:r${revision}` : `gcal:${eventId}`);
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
 *   actor?: unknown, now?: () => string,
 * }} options `appointmentBook` is the created `appointment-book@1`
 * capability definition (it carries `.create`); the deployment hands the
 * created object over, the way appointments receives work's `follow-up@1`.
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
  for (const key of ['listEvents', 'insertEvent', 'patchEvent', 'cancelEvent']) {
    if (typeof provider?.[key] !== 'function') {
      throw syncError('CALENDAR_SYNC_CONTEXT_INVALID', 500, `calendar-sync provider needs "${key}"`);
    }
  }
  const mapping = requireMapping(options.mapping);
  const defaultActor = options.actor ?? { type: 'system', id: 'calendar-sync' };
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const context = { modules, names };

  const bookHandle = (actor) => appointmentBook.create({
    modules, actor: actor ?? defaultActor, now, consumer: CALENDAR_SYNC_CONSUMER,
  });

  async function findLinkByEvent(calendarId, eventId) {
    const rows = await linkService(context).listWhere({ googleEventId: linkKeyFor(calendarId, eventId) });
    return rows[0] ?? null;
  }

  async function findLinkBySource(sourceKey) {
    const rows = await linkService(context).listWhere({ appointmentSourceKey: sourceKey });
    return rows[0] ?? null;
  }

  async function readLocal(handle, link) {
    const rows = await handleStorage().listWhere({ sourceKey: link.appointmentSourceKey });
    return rows[0] ?? null;
  }

  function handleStorage() {
    const service = resolveModule(modules, 'appointment')?.service;
    if (!service || typeof service.listWhere !== 'function') {
      throw syncError('CALENDAR_SYNC_STORAGE_INVALID', 500,
        'calendar-sync cannot read appointment rows: the "appointment" module is not composed');
    }
    return service;
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
   */
  async function importSingle(handle, actor, calendarId, event, revision, priorLink) {
    const eventId = event?.id;
    const sourceKey = sourceKeyFor(eventId, revision);
    const request = mapEventToBooking(event, calendarId, sourceKey);
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
    };
    if (priorLink) {
      await linkService(context).applyManaged(priorLink.id, { ...link, linkKey: priorLink.linkKey }, { actor });
    } else {
      await storeLink(link, actor);
    }
    return { status: 'imported', eventId, appointmentId: row.id, replayed: booked.replayed ?? false };
  }

  /**
   * **The written conflict rule** (acceptance, also in README.md §Conflict
   * rule and in the package metadata): Accordo owns lifecycle, Google owns
   * schedule. A Google schedule change on an open local row cancels that
   * row (reason naming Google) and rebooks under a revisioned key,
   * preserving a `confirmed` forward; on a terminal row it is ignored —
   * a happened visit is evidence, never rewritten. A local cancellation
   * always wins over a concurrent Google change: the sync pushes the
   * cancellation to Google so both sides converge on the freed slot.
   */
  async function applyRemoteChange(handle, actor, calendarId, event) {
    const eventId = event?.id;
    const link = await findLinkByEvent(calendarId, eventId);
    const cancelled = event?.status === 'cancelled';

    if (!link) {
      if (cancelled) return { status: 'ignored', eventId, reason: 'tombstone for an event never imported' };
      return importSingle(handle, actor, calendarId, event, 0, null);
    }

    const row = await readLocal(handle, link);
    if (!row) {
      await linkService(context).applyManaged(link.id, {
        conflictNote: 'the linked appointment row is gone; booked evidence must not be re-created by the sync',
      }, { actor });
      return { status: 'conflict', eventId, reason: 'CALENDAR_SYNC_ORPHAN_LINK: the linked appointment row is gone' };
    }
    const localStatus = JSON.parse(link.localFingerprint)[3];
    const locallyCancelled = row.status === 'cancelled' && localStatus !== 'cancelled';

    if (cancelled) {
      if (row.status === 'cancelled') {
        await linkService(context).applyManaged(link.id, {
          googleUpdated: event.updated, localFingerprint: appointmentFingerprint(row), conflictNote: null,
        }, { actor });
        return { status: 'replayed', eventId, reason: 'already cancelled on both sides' };
      }
      if (TERMINAL_STATUSES.includes(row.status)) {
        await linkService(context).applyManaged(link.id, { googleUpdated: event.updated }, { actor });
        return { status: 'ignored', eventId, reason: `local row is terminal ("${row.status}"): a happened visit is never rewritten` };
      }
      await handle.advanceAppointment(row, 'cancelled', 'Cancelled in Google Calendar');
      const updated = await readLocal(handle, link);
      await linkService(context).applyManaged(link.id, {
        googleUpdated: event.updated, localFingerprint: appointmentFingerprint(updated), conflictNote: null,
      }, { actor });
      return { status: 'applied', eventId, direction: 'google-to-local', change: 'cancelled' };
    }

    // An active remote event.
    if (event.updated === link.googleUpdated && row.status === localStatus) {
      return { status: 'replayed', eventId, reason: 'same sync token delivered twice: stored once' };
    }
    if (locallyCancelled) {
      // Cancellation wins: converge Google onto the freed slot.
      const pushed = provider.cancelEvent({ calendarId, eventId });
      await linkService(context).applyManaged(link.id, {
        googleUpdated: pushed.updated, localFingerprint: appointmentFingerprint(row), conflictNote: null,
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
      await linkService(context).applyManaged(link.id, { googleUpdated: event.updated }, { actor });
      return { status: 'ignored', eventId, reason: `local row is terminal ("${row.status}"): a happened visit is never rewritten` };
    }
    // Reschedule: cancel naming Google, rebook revisioned, carry a
    // `confirmed` forward (the only lifecycle a moved booking can keep).
    await handle.advanceAppointment(row, 'cancelled', 'Rescheduled in Google Calendar');
    const revision = (link.revision ?? 0) + 1;
    const entry = await importSingle(handle, actor, calendarId, event, revision, link);
    if (entry.status !== 'imported') return { ...entry, eventId };
    if (row.status === 'confirmed') {
      const fresh = await readLocal(handle, { appointmentSourceKey: sourceKeyFor(eventId, revision) });
      await handle.advanceAppointment(fresh, 'confirmed');
    }
    const final = await readLocal(handle, { appointmentSourceKey: sourceKeyFor(eventId, revision) });
    await linkService(context).applyManaged(link.id, {
      appointmentSourceKey: final.sourceKey,
      appointmentId: final.id,
      googleUpdated: event.updated,
      localFingerprint: appointmentFingerprint(final),
      revision,
      conflictNote: null,
    }, { actor });
    return { status: 'applied', eventId, direction: 'google-to-local', change: 'rescheduled', revision };
  }

  async function reconcileFull(handle, actor, calendarId, timeMin) {
    const page = provider.listEvents({ calendarId, timeMin: timeMin ?? now(), showDeleted: true });
    const entries = [];
    for (const event of page.items) {
      entries.push(await applyRemoteChange(handle, actor, calendarId, event));
    }
    await writeState(calendarId, { syncToken: page.nextSyncToken }, actor);
    return { recovered: true, entries, nextSyncToken: page.nextSyncToken };
  }

  async function pendingConflicts() {
    const rows = await linkService(context).listWhere({});
    return rows.filter((row) => row.conflictNote).map((row) => ({ eventId: row.googleEventId, reason: row.conflictNote }));
  }

  return {
    /** Full import of future events (the first sync ever on a calendar). */
    async importFuture(calendarId, { timeMin, actor } = {}) {
      const who = actor ?? defaultActor;
      const handle = bookHandle(who);
      const page = provider.listEvents({ calendarId, timeMin: timeMin ?? now(), showDeleted: false });
      const entries = [];
      for (const event of page.items) {
        if (event?.status === 'cancelled') continue;
        const known = await findLinkByEvent(calendarId, event.id);
        if (known) {
          entries.push({ status: 'already-tracked', eventId: event.id });
          continue;
        }
        entries.push(await importSingle(handle, who, calendarId, event, 0, null));
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
      let page;
      try {
        page = provider.listEvents({ calendarId, syncToken: state.syncToken });
      } catch (error) {
        if (error?.code === 'GOOGLE_SYNC_TOKEN_INVALID') {
          const recovered = await reconcileFull(handle, who, calendarId);
          return { calendarId, ...recovered, pendingConflicts: await pendingConflicts() };
        }
        throw error;
      }
      const entries = [];
      for (const event of page.items) {
        entries.push(await applyRemoteChange(handle, who, calendarId, event));
      }
      await writeState(calendarId, { syncToken: page.nextSyncToken }, who);
      return { calendarId, entries, nextSyncToken: page.nextSyncToken, pendingConflicts: await pendingConflicts() };
    },

    /**
     * Push one local appointment to Google by source key: first export
     * inserts the event (with the round-trip properties the import reads
     * back), later pushes converge a local cancellation. Any other
     * lifecycle advance is Accordo-owned and acknowledged without a
     * provider write. A repeated push with nothing changed is a no-op —
     * the second of two syncs in a row writes nothing anywhere.
     */
    async pushAppointment(calendarId, sourceKey, { actor } = {}) {
      const who = actor ?? defaultActor;
      const handle = bookHandle(who);
      const rows = await handleStorage().listWhere({ sourceKey });
      const row = rows[0] ?? null;
      if (!row) {
        throw syncError('CALENDAR_SYNC_UNKNOWN_APPOINTMENT', 404, `no appointment with sourceKey "${sourceKey}"`);
      }
      const link = await findLinkBySource(sourceKey);
      if (!link) {
        const summary = mapping.summaryForAppointment(row, calendarId);
        if (typeof summary !== 'string' || summary.trim() === '') {
          throw new ValidationError('calendar-sync mapping.summaryForAppointment must return non-empty text', {
            field: 'mapping.summaryForAppointment',
          });
        }
        const created = provider.insertEvent({
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
        }, who);
        return { status: 'exported', eventId: created.id, sourceKey: row.sourceKey };
      }
      const fingerprint = appointmentFingerprint(row);
      if (fingerprint === link.localFingerprint && !link.conflictNote) {
        return { status: 'noop', sourceKey, reason: 'nothing changed since the last push' };
      }
      if (row.status === 'cancelled' && JSON.parse(link.localFingerprint)[3] !== 'cancelled') {
        const pushed = provider.cancelEvent({ calendarId, eventId: rowLinkEventId(link, calendarId) });
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
      for (const link of links) {
        entries.push(await this.pushAppointment(calendarId, link.appointmentSourceKey, { actor }));
      }
      return { calendarId, entries };
    },

    /** One pull plus one push: the second consecutive run changes nothing. */
    async syncOnce(calendarId, options = {}) {
      const pull = await this.pullIncremental(calendarId, options);
      const push = await this.pushLocalChanges(calendarId, options);
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
      const pull = await this.pullIncremental(state.calendarId);
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

  function rowLinkEventId(link, calendarId) {
    // The stored Google id is scoped as `<calendarId>:<eventId>`: strip the
    // known prefix rather than splitting, so a scoped id stays exact.
    const scoped = String(link.googleEventId ?? '');
    const prefix = `${calendarId}:`;
    return scoped.startsWith(prefix) ? scoped.slice(prefix.length) : scoped;
  }
}
