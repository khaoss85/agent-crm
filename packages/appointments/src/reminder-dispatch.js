// @ts-check

import {
  AppError,
  ValidationError,
  trustedSystemActor,
} from '../../core/index.js';
import { reminderMessageKey, reminderThreadKey } from './appointments.js';

/**
 * **Due-reminder dispatch — the automatic send (backlog:fe0fe10b85d1).**
 *
 * The booking owns *what* (the reminder follow-up, due at `remindAt`) and
 * *where* (the validated channel target). This module owns *firing*: it
 * scans held bookings whose instant has come, sends each through the
 * composed `channel-template-send@1` seam, and records the send in the
 * customer's thread through the composed `interaction-log@1` seam — the
 * history the customer card reads. Delivery timing comes from a durable-job
 * sweep (the same timer vehicle channel sends and scheduled asks ride):
 * the deployment beats `seedReminderSweep` on its own interval, the worker
 * fires due sweeps, and the dispatch sends only what is due — a sweep that
 * runs early sends nothing.
 *
 * Every step is idempotent, so a retried sweep or a second worker can never
 * double-send: the provider call keys on the reminder's deterministic
 * message key, the history thread and message replay on theirs, and a sent
 * reminder carries `reminderSentAt` and is never picked up again.
 *
 * Fail-closed throughout: a booking that left the open states
 * (`booked`/`confirmed`), a reminder whose follow-up is no longer open, or
 * a row whose stored target no longer parses is skipped or refused — never
 * sent on a guess. A failed send leaves the follow-up open: the human still
 * owes the reminder, and the jobs table shows why the automatic try failed.
 */

export const APPOINTMENT_REMINDER_SWEEP_KIND = 'appointment-reminder-sweep';
export const APPOINTMENT_REMINDER_SWEEP_HANDLER = 'appointment-reminder-sweep';
export const APPOINTMENT_REMINDER_SEND_ACTION = 'send-reminder';
export const APPOINTMENT_REMINDER_SWEEP_VERSION = 1;
export const APPOINTMENT_REMINDER_SWEEP_MAX_ATTEMPTS = 5;

/** Bookings that still hold their slot and may still remind. */
const SENDABLE_STATES = Object.freeze(['booked', 'confirmed']);
/** The interaction message body bound (`packages/interactions`), restated: no cross-package import. */
const MAX_HISTORY_BODY = 2000;

const TIMER_ACTOR = trustedSystemActor('sending due appointment reminders');

function requireService(handle, name) {
  if (!handle || typeof handle.listWhere !== 'function') {
    throw new AppError(`Appointment reminders need the "${name}" record service`, {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  return handle;
}

function requireSeam(seam, name, fns) {
  if (!seam || fns.some((fn) => typeof seam[fn] !== 'function')) {
    throw new AppError(
      `Appointment reminders need an opened ${name} capability (${fns.join(', ')})`,
      { code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500 },
    );
  }
  return seam;
}

function parseTemplateVars(row) {
  if (row.reminderTemplateVars === null || row.reminderTemplateVars === undefined || row.reminderTemplateVars === '') {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(row.reminderTemplateVars);
  } catch {
    throw new AppError(`The reminder target of booking "${row.sourceKey}" is unreadable`, {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new AppError(`The reminder target of booking "${row.sourceKey}" is unreadable`, {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  return [...parsed];
}

/**
 * The history line for one sent reminder: which appointment, which
 * template, which variables — the evidence of what the customer received.
 * Bounded before any send, so a pathological variable list truncates the
 * record (marked) instead of refusing the history after the send went out.
 */
export function reminderHistoryBody(row) {
  const head = `Appointment reminder (${row.serviceKey} at ${row.startsAt}) via WhatsApp template `
    + `"${row.reminderTemplateName}" (${row.reminderTemplateLanguage ?? 'default'})`;
  const vars = parseTemplateVars(row);
  if (vars.length === 0) return head.slice(0, MAX_HISTORY_BODY);
  const tailed = `${head}: ${vars.join(' | ')}`;
  if (tailed.length <= MAX_HISTORY_BODY) return tailed;
  return `${tailed.slice(0, MAX_HISTORY_BODY - 1)}…`;
}

function subjectOf(row) {
  return {
    resource: row.subjectResource,
    id: row.subjectId,
    owner: row.subjectOwner,
    ...(row.subjectOwnerPackage !== null && row.subjectOwnerPackage !== undefined
      ? { ownerPackage: row.subjectOwnerPackage } : {}),
    ...(row.subjectLabel !== null && row.subjectLabel !== undefined && row.subjectLabel !== ''
      ? { label: row.subjectLabel } : {}),
  };
}

/**
 * Send every due reminder once. `now` is the instant the sweep fires at —
 * injected, so tests pin it and production passes the worker clock.
 *
 * @param {{
 *   appointments: any, tasks: any, templateSend: any, interactionLog: any,
 *   now?: () => string,
 * }} handles `appointments`/`tasks` are the record services;
 *   `templateSend`/`interactionLog` the opened seams.
 */
export async function dispatchDueReminders(handles) {
  const appointments = requireService(handles?.appointments, 'appointment');
  const tasks = requireService(handles?.tasks, 'work-task');
  const templateSend = requireSeam(handles?.templateSend, 'channels channel-template-send@1', ['sendTemplate']);
  const interactionLog = requireSeam(handles?.interactionLog, 'interactions interaction-log@1', ['openConversation', 'logMessage']);
  const now = typeof handles?.now === 'function' ? handles.now : () => new Date().toISOString();
  const instant = now();

  const due = [];
  for (const state of SENDABLE_STATES) {
    for (const row of await appointments.listWhere({ status: state })) {
      if (!row || row.reminderDueAt === null || row.reminderDueAt === undefined || row.reminderDueAt === '') continue;
      if (row.reminderDueAt > instant) continue;
      // No channel named, no send: a follow-up-only reminder stays the
      // human's checklist and the sweep never touches it.
      if (row.reminderTo === null || row.reminderTo === undefined || row.reminderTo === '') continue;
      // Already sent: the marker below is the replay guard.
      if (row.reminderSentAt !== null && row.reminderSentAt !== undefined && row.reminderSentAt !== '') continue;
      due.push(row);
    }
  }
  // Deterministic order: the earliest instant first, then the booking key —
  // so two sweeps racing send in the same order and the second replays.
  due.sort((a, b) => (a.reminderDueAt < b.reminderDueAt ? -1 : a.reminderDueAt > b.reminderDueAt ? 1 : 0)
    || (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));

  const sent = [];
  const skipped = [];
  const failed = [];
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await dispatchOneReminder({ appointments, tasks, templateSend, interactionLog, instant }, row);
      if (outcome === null) {
        skipped.push({ sourceKey: row.sourceKey, reason: 'follow-up-closed' });
      } else {
        sent.push(outcome);
      }
    } catch (error) {
      failed.push({
        sourceKey: row.sourceKey,
        code: error && typeof error === 'object' && typeof /** @type {any} */ (error).code === 'string'
          ? /** @type {any} */ (error).code
          : 'UNKNOWN',
      });
    }
  }
  if (failed.length > 0) {
    // Processed every reminder first, then fail the sweep: the sent ones
    // carry their marker and replay as skips, so the retry only re-tries
    // the failed ones.
    throw new AppError(
      `The reminder sweep sent what it could and failed on ${failed.map((entry) => entry.sourceKey).join(', ')}`,
      { code: 'APPOINTMENTS_REMINDER_SWEEP_FAILED', status: 500, details: { failed, sent: sent.length } },
    );
  }
  return Object.freeze({ sent: Object.freeze(sent), skipped: Object.freeze(skipped), at: instant });
}

/**
 * Send one due reminder: the follow-up must still be open (a human-closed
 * reminder stays closed — the sweep never overrides it), then send, record
 * in the thread, and mark sent. Answers null on the closed skip.
 */
async function dispatchOneReminder({ appointments, tasks, templateSend, interactionLog, instant }, row) {
  const followUps = await tasks.listWhere({ sourceKey: row.reminderSourceKey });
  const followUp = followUps[0] ?? null;
  if (!followUp) {
    throw new AppError(
      `Booking "${row.sourceKey}" names a reminder follow-up that is not stored: refusing to send on a missing reminder`,
      { code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500 },
    );
  }
  if (followUp.status !== 'open') return null;
  if (row.reminderSpaceId === null || row.reminderSpaceId === undefined
    || row.reminderConnectionKey === null || row.reminderConnectionKey === undefined
    || row.reminderTemplateName === null || row.reminderTemplateName === undefined) {
    throw new AppError(`Booking "${row.sourceKey}" names a channel without a stored target`, {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  const variables = parseTemplateVars(row);
  const messageKey = reminderMessageKey(row.sourceKey);
  const threadKey = reminderThreadKey(row.sourceKey);
  const body = reminderHistoryBody(row);
  const template = {
    name: row.reminderTemplateName,
    ...(row.reminderTemplateLanguage !== null && row.reminderTemplateLanguage !== undefined
      && row.reminderTemplateLanguage !== '' ? { language: row.reminderTemplateLanguage } : {}),
    variables,
  };
  const sent = await templateSend.sendTemplate({
    spaceId: row.reminderSpaceId,
    connectionKey: row.reminderConnectionKey,
    to: row.reminderTo,
    template,
    messageKey,
  });
  const subject = subjectOf(row);
  const source = { package: 'appointments', action: APPOINTMENT_REMINDER_SEND_ACTION };
  const thread = await interactionLog.openConversation({
    sourceKey: threadKey,
    subject,
    channel: 'whatsapp',
    source,
  });
  const conversationId = thread?.conversation?.id;
  if (typeof conversationId !== 'string' || conversationId === '') {
    throw new AppError('The reminder history thread did not open', {
      code: 'APPOINTMENTS_REMINDER_UNAVAILABLE', status: 500,
    });
  }
  await interactionLog.logMessage({
    sourceKey: messageKey,
    conversationId,
    direction: 'outbound',
    channel: 'whatsapp',
    body,
    teamAuthorId: row.teamMemberId,
    remoteHandle: sent.providerMessageId,
    subject,
    occurredAt: instant,
    source,
  });
  if (typeof appointments.applyManaged !== 'function') {
    throw new AppError('The appointments package is installed without a managed write on its "appointment" records', {
      code: 'APPOINTMENTS_STORAGE_INVALID', status: 500,
    });
  }
  await appointments.applyManaged(row.id, { reminderSentAt: instant }, { actor: TIMER_ACTOR });
  return Object.freeze({
    sourceKey: row.sourceKey,
    providerMessageId: sent.providerMessageId,
    conversationId,
  });
}

/**
 * Register the sweep on a durable-job registry — the timer half. The
 * deployment beats `seedReminderSweep` on its own interval; the worker
 * fires due sweeps; the dispatch sends only what is due.
 *
 * @param {any} registry
 * @param {{
 *   appointments: any, tasks: any, templateSend: any, interactionLog: any,
 *   clock?: () => string,
 * }} composition Handles are validated here, not at the first fire.
 */
export function registerAppointmentReminderSweep(registry, composition) {
  requireService(composition?.appointments, 'appointment');
  requireService(composition?.tasks, 'work-task');
  requireSeam(composition?.templateSend, 'channels channel-template-send@1', ['sendTemplate']);
  requireSeam(composition?.interactionLog, 'interactions interaction-log@1', ['openConversation', 'logMessage']);
  if (!registry || typeof registry.register !== 'function') {
    throw new ValidationError('registerAppointmentReminderSweep needs a durable-job handler registry', {
      field: 'registry',
    });
  }
  const clock = typeof composition?.clock === 'function' ? composition.clock : () => new Date().toISOString();
  registry.register({
    kind: APPOINTMENT_REMINDER_SWEEP_KIND,
    name: APPOINTMENT_REMINDER_SWEEP_HANDLER,
    version: APPOINTMENT_REMINDER_SWEEP_VERSION,
    async execute() {
      const outcome = await dispatchDueReminders({
        appointments: composition.appointments,
        tasks: composition.tasks,
        templateSend: composition.templateSend,
        interactionLog: composition.interactionLog,
        now: clock,
      });
      return { outcomeReference: `${APPOINTMENT_REMINDER_SWEEP_KIND}:${outcome.at}:sent-${outcome.sent.length}` };
    },
  });
  return registry;
}

/**
 * Queue one sweep now (or at `at`): the beat the deployment owns. Queuing
 * while a sweep is already pending is a no-op answered with the pending
 * job — the idempotency root is fixed, so a double beat cannot stack
 * sweeps. A pending sweep from an earlier beat with a different instant
 * answers the same way: one sweep queued is enough, the dispatch sends
 * everything due when it fires.
 *
 * @param {{store: any, actor?: unknown, at?: string}} context
 */
export async function seedReminderSweep(context) {
  const store = context?.store;
  if (!store || typeof store.enqueue !== 'function') {
    throw new ValidationError('seedReminderSweep needs a durable-job store', { field: 'store' });
  }
  const at = typeof context?.at === 'string' && context.at !== '' ? context.at : new Date().toISOString();
  try {
    const job = await store.enqueue({
      kind: APPOINTMENT_REMINDER_SWEEP_KIND,
      handler: { name: APPOINTMENT_REMINDER_SWEEP_HANDLER, contract: 1, version: APPOINTMENT_REMINDER_SWEEP_VERSION },
      payload: {},
      scheduleAt: at,
      maxAttempts: APPOINTMENT_REMINDER_SWEEP_MAX_ATTEMPTS,
      idempotencyRoot: APPOINTMENT_REMINDER_SWEEP_KIND,
      outcomeReference: APPOINTMENT_REMINDER_SWEEP_KIND,
      recoveryPolicy: 'reconcilable_at_least_once',
    }, context?.actor === undefined ? {} : { actor: context.actor });
    return Object.freeze({ job, seeded: true });
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH') {
      return Object.freeze({ job: null, seeded: false });
    }
    throw error;
  }
}
