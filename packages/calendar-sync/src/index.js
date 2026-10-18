// @ts-check

import { definePackage, selectPackageGraph, ValidationError } from '../../core/index.js';
import { createCalendarSyncOperations } from './sync.js';

/**
 * Calendar sync v1 — the hybrid Accordo / Google Calendar story
 * (backlog:bf0351325a8c).
 *
 * What it does: imports future Google Calendar events as appointment rows,
 * pulls incremental changes on the stored sync token (a push notification
 * only says "something changed" — the pull reads what), and pushes local
 * bookings and cancellations back to Google. The second of two syncs in a
 * row changes nothing: sync tokens resume, links dedup at storage level,
 * and a repeated push with an unchanged fingerprint is a no-op.
 *
 * What it deliberately is **not**: a customer system (no master table —
 * the customer of an imported event is the deployment mapping, the same
 * opaque envelope appointments store); a roster, catalog or pricing
 * authority (member, service and price are deployment mappings); a
 * notification system (Google keeps notifying on its side); a series
 * engine (recurrence is not expanded — each synced event is one timed
 * occurrence); the HTTP route (the pilot owns it and passes the verified
 * push delivery in).
 */

export const CALENDAR_SYNC_PACKAGE = 'calendar-sync';

/** The record modules this package owns; declaring them makes a collision detectable. */
export const CALENDAR_SYNC_RESOURCES = Object.freeze(['calendar-link', 'calendar-sync-state']);

const CALENDAR_INPUT = {
  name: 'calendarId',
  type: 'string',
  required: true,
  hint: 'The Google calendar id this space syncs (the deployment maps it to one team member).',
};
const SPACE_INPUT = {
  name: 'spaceId',
  type: 'string',
  required: true,
  hint: 'The Accordo space slug — always explicit, never inferred.',
};

/**
 * Build the package definition the application composes.
 *
 * The factory builds with no bindings at all — package tooling
 * (`crm package validate`, conformance) constructs every factory with
 * `{}` — and the runtime bindings are checked when the operations are
 * created for a runtime, not when the definition is read.
 *
 * @param {{
 *   appointmentBook?: any, provider?: any, mapping?: any,
 *   actor?: unknown, now?: () => string, modules?: Record<string, string>,
 *   database?: any,
 * }} [options] `appointmentBook` is the created `appointment-book@1`
 * capability object — the same handover shape appointments uses for work's
 * `follow-up@1`, so the reminder-style name resolution happens once, at
 * the provider. `provider` is the Google Calendar binding (fake-backed
 * until credentials exist — owner decision MEM_ACC_DECISIONS) and
 * `mapping` names the deployment's customer/member/service bindings.
 * All three are required before any operation runs, because a sync that
 * books without them would invent identities. `database` is optional and
 * never replaces those bindings: it only lets a reschedule commit its
 * cancel and its rebook in one storage transaction. An explicit `database`
 * wins over the runtime's; without either, the link records' own handle
 * is tried, then the prove-before-cancel fallback.
 */
export function createCalendarSyncPackage(options = {}) {
  for (const key of ['appointmentBook', 'provider', 'mapping']) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'object' || value === null)) {
      throw new ValidationError(`calendar-sync ${key} must be an object when provided`, { field: key });
    }
  }
  if (options.database !== undefined && options.database !== null && typeof options.database !== 'object') {
    throw new ValidationError('calendar-sync database must be an object when provided', { field: 'database' });
  }

  const composedByRuntime = new WeakMap();
  const operations = (runtime) => {
    let composed = composedByRuntime.get(runtime);
    if (!composed) {
      composed = createCalendarSyncOperations({
        modules: runtime.modules,
        moduleNames: options.modules,
        appointmentBook: options.appointmentBook,
        provider: options.provider,
        mapping: options.mapping,
        actor: options.actor,
        now: options.now,
        database: options.database ?? runtime.database,
      });
      composedByRuntime.set(runtime, composed);
    }
    return composed;
  };

  const pkg = definePackage({
    packageContract: 1,
    name: CALENDAR_SYNC_PACKAGE,
    version: 1,
    label: 'Calendar sync',
    description: 'Two-way Accordo / Google Calendar sync: future-event import, incremental pull on sync tokens with push-notification triggers, and push of local bookings and cancellations. Accordo owns lifecycle, Google owns schedule — the conflict rule both sides converge on.',
    resources: [...CALENDAR_SYNC_RESOURCES],

    // The one declared reach into another package: the appointment rows the
    // sync links. Without appointments composed, the application refuses to
    // start naming this edge — never a missing-module stack trace at sync
    // time. Identity (customer, member, service, price) arrives through the
    // deployment mapping, not through a second package edge.
    requires: [{ package: 'appointments', capability: 'appointment-book', version: 1 }],

    capabilities: [],
    actions: [],
    policies: [],
    operations: [
      {
        operationContract: 1,
        name: 'import-future-events',
        label: 'Import future events',
        appMethod: 'importFutureCalendarEvents',
        description: 'Book one appointment per future Google event of a calendar (human decision). Idempotent by event id; overlaps and unmapped events are reported, never force-booked.',
        input: [{ ...SPACE_INPUT }, { ...CALENDAR_INPUT }],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.importFuture(params.calendarId, params);
        },
      },
      {
        operationContract: 1,
        name: 'pull-calendar',
        label: 'Pull calendar changes',
        appMethod: 'pullCalendarChanges',
        description: 'Apply Google-side creates, reschedules and cancellations since the stored sync token (an expired token reconciles fully instead of guessing).',
        input: [{ ...SPACE_INPUT }, { ...CALENDAR_INPUT }],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.pullIncremental(params.calendarId, params);
        },
      },
      {
        operationContract: 1,
        name: 'push-appointment',
        label: 'Push appointment',
        appMethod: 'pushAppointmentToCalendar',
        description: 'Export one local appointment to Google, or converge a local cancellation there (human decision). A repeated push with nothing changed is a no-op.',
        input: [
          { ...SPACE_INPUT },
          { ...CALENDAR_INPUT },
          {
            name: 'sourceKey',
            type: 'string',
            required: true,
            hint: 'The appointment source key to export (calendar-scoped gcal key for imports, the booking key for local rows).',
          },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.pushAppointment(params.calendarId, params.sourceKey, params);
        },
      },
      {
        operationContract: 1,
        name: 'sync-calendar',
        label: 'Sync calendar both ways',
        appMethod: 'syncCalendar',
        description: 'One incremental pull plus one push of moved local rows. The second consecutive run changes nothing.',
        input: [{ ...SPACE_INPUT }, { ...CALENDAR_INPUT }],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.syncOnce(params.calendarId, params);
        },
      },
      {
        operationContract: 1,
        name: 'register-calendar-push',
        label: 'Register calendar push channel',
        appMethod: 'registerCalendarPush',
        description: 'Record the push channel the deployment opened with the provider (human decision): the channel id and the bearer token hash — the token itself never lands in a row. Without this, push deliveries refuse as unknown channels.',
        input: [
          { ...SPACE_INPUT },
          { ...CALENDAR_INPUT },
          { name: 'channelId', type: 'string', required: true, hint: 'The provider channel id from watch.' },
          { name: 'resourceId', type: 'string', required: false, hint: 'The provider resource id from watch.' },
          {
            name: 'channelToken',
            type: 'string',
            required: true,
            hint: 'The bearer token the deployment set on watch: handled like a credential (hashed at rest, never logged).',
          },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.watchCalendar(params.calendarId, params);
        },
      },
      {
        operationContract: 1,
        name: 'handle-calendar-push',
        label: 'Handle calendar push',
        appMethod: 'handleCalendarPush',
        description: 'Verify one Google push delivery (known channel, matching bearer token) and pull what changed. Unknown or forged signals are refused before anything is read.',
        input: [
          { ...SPACE_INPUT },
          { name: 'channelId', type: 'string', required: true, hint: 'The provider channel id, from the verified route.' },
          { name: 'channelToken', type: 'string', required: true, hint: 'The bearer token Google echoed for the channel.' },
          { name: 'resourceState', type: 'string', required: true, hint: 'The provider resource state (sync for the watch handshake, exists when something changed).' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.handlePush(params);
        },
      },
    ],
    /** Function-free, additive schema metadata — never a secret, never a function. */
    metadata() {
      return {
        calendarSyncContract: 1,
        conflictRule: {
          lifecycle: 'Accordo owns lifecycle: a Google change never advances or reverts an appointment state; only the sync\'s own cancel-with-reason moves it, and a terminal row (done, no-show) is never rewritten — a happened visit is evidence.',
          schedule: 'Google owns schedule: a Google slot change on an open row moves the booking atomically — the old row is cancelled (reason "Rescheduled in Google Calendar") only with its rebook under a revisioned key, carrying a `confirmed` forward, so a refused rebook keeps the valid row; notes/summary-only edits are acknowledged without a local write (rows are evidence-immutable outside lifecycle).',
          cancellationWins: 'a local cancellation beats any concurrent Google change: the sync pushes the cancellation to Google so both sides converge on the freed slot, and the pending conflict clears.',
          noSilentLoss: 'a remote change that cannot apply yet (move refused onto a held slot, import refused with no link) keeps the valid local row and is kept as a pending snapshot on the link and retried on every pull — the token moves on, the retry does not depend on it; a tombstone between two full imports applies before the token moves past it.',
          importRefusals: 'an event overlapping a held slot is refused 409 and reported (the no-double-booking invariant is never booked over); an event with no customer mapping is skipped and reported, never booked against a fabricated contact.',
        },
        idempotency: 'sync tokens resume pulls; link rows dedup at storage level (unique event and source keys); export reconciles with the provider before inserting; a repeated push with an unchanged fingerprint is a no-op — the second of two syncs in a row writes nothing anywhere',
        pushDiscipline: 'a push notification carries no event data, only "something changed": unknown channels and token mismatches refuse before any read; the channel token is stored as a hash, never the bearer',
        humanApproval: 'import, export and push-channel registration are human decisions (actor required on every booking); provider-driven pulls run under a system actor',
        notModeled: [
          'recurrence or series expansion — each synced event is one timed occurrence; all-day events are refused by slot validation',
          'reminders for imported bookings (remindAt stays null — Google keeps notifying on its side)',
          'confirmed/done/no-show propagation to Google — lifecycle stays Accordo-side',
          'the per-space HTTP route — the pilot owns it and passes spaceId from the verified path',
          'real Google credentials — fake-backed until they exist (owner decision MEM_ACC_DECISIONS)',
        ],
        reuses: ['appointment-book@1'],
      };
    },
  });

  return selectPackageGraph(pkg, 1);
}

export { createCalendarSyncOperations, appointmentFingerprint } from './sync.js';
export { createFakeGoogleCalendar, GOOGLE_SYNC_TOKEN_INVALID } from './google-fake.js';
