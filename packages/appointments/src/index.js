// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
// No import from any other domain package — not even work's public entry.
// What the reminder writes (the follow-up task) arrives as the provider's own
// created `follow-up@1` capability object, handed to this factory at the
// composition site. Re-instantiating the provider factory here would resolve
// work's module names a second time from this package's options, and the two
// resolutions could diverge; consuming the created handle means there is
// exactly one name resolution: the provider's.
import {
  APPOINTMENT_INITIAL,
  APPOINTMENT_MODULE,
  APPOINTMENT_STATES,
  APPOINTMENT_TERMINAL,
  APPOINTMENT_TRANSITIONS,
  APPOINTMENTS_PACKAGE,
  BOOK_APPOINTMENTS_PERMISSION,
  PROPOSE_ACTION_KIND,
  SUGGEST_SLOT_MINUTES,
  advanceAppointment,
  bookAppointment,
  bookFromLink,
  bounds,
  confirmBooking,
  createAppointmentBookCapability,
  createAppointmentScheduleCapability,
  findOverlap,
  parseBookingPhrase,
  proposeBooking,
  readAppointment,
  readSchedule,
  readTeamWeek,
  reminderMessageKey,
  reminderSourceKey,
  reminderThreadKey,
  suggestSlots,
  validateAppointmentRequest,
  validateBookingLinkToken,
  validateReminderChannel,
  validateSubject,
} from './appointments.js';
import {
  APPOINTMENT_REMINDER_SEND_ACTION,
  APPOINTMENT_REMINDER_SWEEP_HANDLER,
  APPOINTMENT_REMINDER_SWEEP_KIND,
  APPOINTMENT_REMINDER_SWEEP_MAX_ATTEMPTS,
  APPOINTMENT_REMINDER_SWEEP_VERSION,
  dispatchDueReminders,
  registerAppointmentReminderSweep,
  reminderHistoryBody,
  seedReminderSweep,
} from './reminder-dispatch.js';

/**
 * **Appointments v1 — the native booking record.**
 *
 * What it does: books one appointment between a customer (the host contact or
 * company, named by the opaque subject envelope — never copied, never a new
 * master table) and one team member (an opaque team identity, never a roster)
 * for one listino service in one time slot, with the agreed price stored as
 * an immutable snapshot and the booking lifecycle around it (`booked ->
 * confirmed -> done`, plus `no-show` and `cancelled` with a reason). One team
 * member holds one slot at a time: an overlapping booking for the same member
 * is refused 409 unless the held booking is cancelled. A booking that names
 * `remindAt` also opens exactly one work follow-up reminder in the same
 * transaction, due at the named instant. A booking that also names
 * `reminderChannel` is sent automatically at that instant: the reminder
 * sweep queues one channel-outbox job per due reminder under its
 * deterministic key (the cross-process claim, never a provider call) and,
 * once the outbox confirms the send, records it in the customer's thread
 * through `interaction-log@1`.
 *
 * What it deliberately is **not**: a customer system (the customer stays the
 * host contact); a service catalog or pricing authority (the service key and
 * the amount are resolved by the booking path from the commercial listino and
 * snapshotted here); a staff roster; a calendar sync (Google Calendar
 * two-way sync is the consuming project's adapter work, against these rows);
 * a free-text notifier (only the booking's own approved template sends, and
 * only to the booking's own recipient) or a credit ledger (package credits
 * scaled by appointments are commercial's accounting, read from these rows).
 */

export const APPOINTMENTS_DOMAIN = APPOINTMENTS_PACKAGE;

/**
 * The records this package owns. None of them duplicates a business record:
 * no other package holds appointments, and the customer envelope points at
 * host records rather than copying them.
 */
export const APPOINTMENTS_RESOURCES = Object.freeze([APPOINTMENT_MODULE]);

export {
  APPOINTMENT_INITIAL,
  APPOINTMENT_STATES,
  APPOINTMENT_TERMINAL,
  APPOINTMENT_TRANSITIONS,
  APPOINTMENT_REMINDER_SEND_ACTION,
  APPOINTMENT_REMINDER_SWEEP_HANDLER,
  APPOINTMENT_REMINDER_SWEEP_KIND,
  APPOINTMENT_REMINDER_SWEEP_MAX_ATTEMPTS,
  APPOINTMENT_REMINDER_SWEEP_VERSION,
  BOOK_APPOINTMENTS_PERMISSION,
  PROPOSE_ACTION_KIND,
  SUGGEST_SLOT_MINUTES,
  advanceAppointment,
  bookAppointment,
  bookFromLink,
  bounds,
  confirmBooking,
  dispatchDueReminders,
  findOverlap,
  parseBookingPhrase,
  proposeBooking,
  readAppointment,
  readSchedule,
  readTeamWeek,
  registerAppointmentReminderSweep,
  reminderHistoryBody,
  reminderMessageKey,
  reminderSourceKey,
  reminderThreadKey,
  seedReminderSweep,
  suggestSlots,
  validateAppointmentRequest,
  validateBookingLinkToken,
  validateReminderChannel,
  validateSubject,
};

/**
 * @param {{
 *   work?: { capabilities?: Array<any> },
 *   channels?: { capabilities?: Array<any> },
 *   spacePermissions?: { capabilities?: Array<any> },
 *   llm?: { capabilities?: Array<any> },
 *   config?: Record<string, string>
 * }} [options]
 *   `work` is the composed work package definition — the same object the
 *   composition lists beside this package. The appointments package takes the
 *   created `follow-up@1` capability object from it, so the reminder is always
 *   written with the provider's own name resolution and never with a second
 *   resolution from this package's options. `channels` is the same handover
 *   for the optional send edge: the created `channel-template-send@1`
 *   object, used only to prove the target of bookings that name
 *   `reminderChannel` (the sweep opens its own handle, and the history seam
 *   with it, on the composition modules). A composition without it books
 *   exactly as before — the edge is optional, like channels' own
 *   `channel-sender@1` edge, so no `requires` names it. `spacePermissions`
 *   and `llm` are the same handover for the BO-F3-02 flow: the
 *   `space-permission-gate@1` definition the propose/confirm steps gate on,
 *   and the `llm-complete@1` definition the phrase parse drafts through.
 *   Both absent is fine until a proposal or a phrase asks for them; the
 *   direct booking path never touches them. Both stay out of `requires` on
 *   purpose (a composition without them must keep booting and booking); what
 *   keeps a wrong handover fail-closed is the open-time check that the
 *   opened handle settles on the provider capability contract pinned by the
 *   edge version, refusing otherwise with PACKAGE_DEPENDENCY_MISMATCH
 *   naming the edge.
 */
export function createAppointmentsPackage(options = {}) {
  // One composed instance PER APPLICATION runtime: the schedule and book
  // capability handles below close over the package handovers and open per
  // runtime modules — the same per-runtime pattern the channels operations
  // use, so one composition module may serve several instances in one
  // process. The actor rides the call, never the composition: each write
  // opens its book handle with the caller's actor, so no caller ever books
  // as another.
  const composedByRuntime = new WeakMap();
  const flowFor = (runtime) => {
    let composed = composedByRuntime.get(runtime);
    if (!composed) {
      const schedule = createAppointmentScheduleCapability({ moduleNames: options.config });
      const book = createAppointmentBookCapability({
        moduleNames: options.config,
        spacePermissions: options.spacePermissions,
        llm: options.llm,
      });
      composed = {
        schedule: schedule.create({ modules: runtime.modules }),
        bookFor: (actor) => book.create({ modules: runtime.modules, actor }),
      };
      composedByRuntime.set(runtime, composed);
    }
    return composed;
  };
  // This package's own graph contract. The handed-over flow edges
  // (space-permissions, llm) are validated against the provider capability
  // contract pinned by their edge version, on every graph.
  const graphContract = options.packageContract === 2 ? 2 : 1;
  // The offered capability object, created once by the provider factory with
  // the provider's config. Held here by reference — never re-instantiated, so
  // a remapped work composition cannot leave the reminder writing the wrong
  // tables while work itself works.
  const offered = Array.isArray(options.work?.capabilities)
    ? options.work.capabilities.find((entry) => entry?.name === 'follow-up' && entry?.version === 1) ?? null
    : null;
  const offeredTemplateSend = Array.isArray(options.channels?.capabilities)
    ? options.channels.capabilities.find((entry) => entry?.name === 'channel-template-send' && entry?.version === 1) ?? null
    : null;

  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: APPOINTMENTS_DOMAIN,
    // 2: the backoffice calendar reads and the BO-F3-02 booking flow
    // (\"07 Calendario\"): the team-week and free-slot reads plus
    // propose/confirmBooking and the phrase-to-draft parse, attached
    // generically as `app.readAppointmentTeamWeek` and siblings. Additive:
    // capabilities, records and the booking contract are untouched.
    version: 2,
    label: 'Appointments',
    description:
      'Native appointment bookings: one customer meeting one team member for one listino service in one time slot, '
      + 'with the agreed price snapshotted and the booking lifecycle. One member holds one slot at a time; '
      + 'a booking with remindAt opens one work follow-up reminder, and a booking with reminderChannel is sent '
      + 'at that instant as an approved WhatsApp template and recorded in history.',
    resources: [...APPOINTMENTS_RESOURCES],

    // The one declared reach into another package: the follow-up the reminder
    // is written through. Without work composed, the application refuses to
    // start naming this edge — never a missing-module stack trace at booking
    // time. Everything beyond the host contact and this reminder stays out:
    // commercial listino rows are resolved by the booking path and snapshotted
    // here, so commercial is a host-record-style input, not a dependency.
    requires: [{ package: 'work', capability: 'follow-up', version: 1 }],

    capabilities: [
      createAppointmentBookCapability({
        moduleNames: options.config,
        provider: offered,
        templateSendProvider: offeredTemplateSend,
        spacePermissions: options.spacePermissions,
        llm: options.llm,
      }),
      createAppointmentScheduleCapability({ moduleNames: options.config }),
    ],
    actions: [],

    /**
     * The declared application operations (ADR-032): the backoffice
     * calendar reads and the BO-F3-02 booking flow, attached generically as
     * `app.readAppointmentTeamWeek` and siblings — replacing no named lookup.
     * Reads stay read-only; writes open their book handle with the caller's
     * actor on every call and fail closed (named code, never a silent
     * placeholder) when the space switch, the LLM edge or the calendar
     * push is not composed.
     */
    operations: [
      {
        operationContract: 1,
        name: 'read-team-week',
        label: 'Read team week',
        appMethod: 'readAppointmentTeamWeek',
        description:
          'The team week for the backoffice calendar (BO-F3-01): every appointment overlapping the window for each named team member, grouped per person. Returns an honest empty week when nothing is held.',
        input: [
          { name: 'teamMemberIds', type: 'json', required: true, hint: 'Named team member identities, at least one.' },
          { name: 'from', type: 'string', required: true, hint: 'Window start, ISO instant.' },
          { name: 'to', type: 'string', required: true, hint: 'Window end, ISO instant.' },
        ],
        create(runtime) {
          return (input) => flowFor(runtime).schedule.teamWeekFor(input);
        },
      },
      {
        operationContract: 1,
        name: 'suggest-appointment-slots',
        label: 'Suggest appointment slots',
        appMethod: 'suggestAppointmentSlots',
        description:
          'Free slots for the backoffice calendar (BO-F3-02): the named window cut into steps minus every step a held booking overlaps. Read-only: no row is written, no slot invented.',
        input: [
          { name: 'teamMemberIds', type: 'json', required: true, hint: 'Named team member identities, at least one.' },
          { name: 'from', type: 'string', required: true, hint: 'Window start, ISO instant.' },
          { name: 'to', type: 'string', required: true, hint: 'Window end, ISO instant.' },
          { name: 'slotMinutes', type: 'integer', required: false, hint: 'Step granularity, one of 15 30 45 60 90 120 (default 30).' },
        ],
        create(runtime) {
          // Read-only: the suggest path never touches the actor, so the book
          // handle opens actorless — like the schedule handle above.
          return (input) => flowFor(runtime).bookFor(undefined).suggestSlots(input);
        },
      },
      {
        operationContract: 1,
        name: 'propose-appointment',
        label: 'Propose appointment',
        appMethod: 'proposeAppointmentBooking',
        description:
          'Plan one booking without writing (BO-F3-02): a confirm-required draft when the space switch is on, a space-ai-proposal when it is off.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The space the booking is gated on.' },
        ],
        create(runtime) {
          return (input, actor) => flowFor(runtime).bookFor(actor).proposeBooking(input);
        },
      },
      {
        operationContract: 1,
        name: 'confirm-appointment',
        label: 'Confirm appointment',
        appMethod: 'confirmAppointmentBooking',
        description:
          'Create the proposed booking on explicit confirmation only (BO-F3-02): without confirmed: true the call is refused before any read or write.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The space the booking is gated on.' },
          { name: 'confirmed', type: 'json', required: true, hint: 'Must be true: nothing is created without it.' },
        ],
        create(runtime) {
          return (input, actor) => flowFor(runtime).bookFor(actor).confirmBooking(input);
        },
      },
      {
        operationContract: 1,
        name: 'parse-booking-phrase',
        label: 'Parse booking phrase',
        appMethod: 'parseBookingPhrase',
        description:
          'Draft booking parameters from one Italian sentence through the composed LLM (BO-F3-02 \"fissa con una frase\"). Without the LLM edge it fails closed naming the missing composition.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'The space the phrase is parsed for.' },
          { name: 'phrase', type: 'string', required: true, hint: 'One Italian booking sentence.' },
        ],
        create(runtime) {
          return (input, actor) => flowFor(runtime).bookFor(actor).parseBookingPhrase(input);
        },
      },
    ],

    // None. A versioned policy earns its fingerprint when two consumers share
    // a rule; the transition table and the overlap rule are published in
    // metadata and owned by this package alone.
    policies: [],

    /**
     * The machine-readable contract, function-free. Admin renders from this
     * and the limits are part of it rather than prose somebody may not read.
     */
    metadata() {
      return {
        appointmentsContract: 1,
        lifecycle: {
          states: [...APPOINTMENT_STATES],
          initial: APPOINTMENT_INITIAL,
          transitions: Object.fromEntries(
            Object.entries(APPOINTMENT_TRANSITIONS).map(([from, to]) => [from, [...to]]),
          ),
          terminal: [...APPOINTMENT_TERMINAL],
          idempotency: 'same source key with the same payload replays the stored row; a divergent payload behind the same key is refused 409, never adopted',
          cancellation: 'a cancellation always carries a reason; any other move carries none',
        },
        slot: {
          overlap: 'one team member holds one slot at a time: half-open [startsAt, endsAt) overlap with a held non-cancelled booking is refused 409; back-to-back slots share an endpoint and do not overlap',
          cancelledFrees: 'a cancelled booking holds nothing; every other state holds its slot even after it ends',
          bounds: { slotMs: bounds.slotMs, notes: bounds.notes, reason: bounds.reason },
        },
        price: {
          snapshot: 'serviceKey plus priceCents and currency as agreed at booking time; a later listino change never rewrites a booked row',
          serviceKey: 'the commercial listino product key, resolved by the booking path — not a catalog read from this package',
        },
        reminder: {
          mechanism: 'one work follow-up per booking with remindAt, opened through follow-up@1 in the booking transaction, due at the named instant; '
            + 'a booking with reminderChannel is queued at that instant by the reminder sweep into the channel outbox '
            + 'under the reminder message key and, once the outbox confirms the send, recorded in the customer thread through interaction-log@1',
          identity: 'the reminder source key is derived from the booking source key, so a retried booking replays its reminder; '
            + 'the send target rides the same identity, so a retry that moves it is refused 409',
          sweep: 'the deployment beats seedReminderSweep on its own interval (each beat its own sweep) and the worker fires due sweeps; '
            + 'the dispatch queues (then confirms) only due, open, unsent reminders of held bookings — cancelled, closed and already-sent ones never fire',
        },
        limitations: [
          'The customer is an opaque envelope on the host contact or company: no customer table is created and none is read beyond the envelope.',
          'The team member is an opaque team identity string: no roster is read and none is created.',
          'The price is a caller-resolved snapshot: this package never reads the commercial catalog and never re-prices a booking.',
          'The reminder send is the booking\'s own approved template to the booking\'s own recipient, and nothing else: no free text ever sends from this path.',
          'A failed automatic send leaves the follow-up open: the human still owes the reminder, and the jobs table shows why the try failed.',
        ],
        notModeled: ['customer master data', 'staff roster or shifts', 'service catalog or pricing', 'calendar synchronization',
          'free-text notifications or sends', 'package credits or payments', 'recurrence or series', 'waitlists'],
        reuses: ['contact', 'follow-up@1', 'channel-template-send@1', 'channel outbox (channel-send)', 'interaction-log@1', 'space-permission-gate@1', 'llm-complete@1'],
      };
    },
  }), graphContract);
}

/** Distinct awaited contract-2 graph. Existing `createAppointmentsPackage()` callers keep v1. */
export function createAppointmentsPackageV2(options = {}) {
  return createAppointmentsPackage({ ...options, packageContract: 2 });
}

export { createAppointmentBookCapability, createAppointmentScheduleCapability };
