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
 * *where* (the validated channel target). This module owns *firing*, in two
 * steps that never overlap: queue, then confirm.
 *
 * 1. **Queue.** The sweep enqueues one job per due reminder in the channels
 *    outbox already used by human-queued sends (`queueTemplateSend`), under
 *    the reminder's deterministic message key. The persistent enqueue IS the
 *    cross-process claim: two sweeps racing queue the byte-identical job and
 *    the second gets the first's row back, so one reminder is one job. The
 *    sweep never calls the provider — retries, the execution-time window
 *    re-check and the dead-letter queue are the outbox's own (MEM_ACC_REUSE).
 * 2. **Confirm.** A later beat re-queues (returning the same row, now with
 *    its current state) and, only for jobs the outbox reports `succeeded`,
 *    records the send in the customer's thread and marks the booking sent.
 *    The marker is written from the job's confirmation, never before a send.
 *
 * What this does NOT promise: the provider-side dedup rides the idempotency
 * key the outbox hands every adapter — the fake honors it, and every real
 * adapter must. A crash between the provider send and the job's success
 * commit retries the send under the same key; that is the adapter contract
 * to honor, not a second send this module makes.
 *
 * Fail-closed throughout: a booking that left the open states
 * (`booked`/`confirmed`), a reminder whose follow-up is no longer open, or
 * a row whose stored target no longer parses is skipped or refused — never
 * sent on a guess. A failed send leaves the follow-up open: the human still
 * owes the reminder, and the jobs table (then the dead-letter queue a human
 * requeues) shows why the automatic try failed.
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
 * Bounded before recording, so a pathological variable list truncates the
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
 * Fire every due reminder once: queue its outbox send, then confirm the
 * sends the outbox has finished. `now` is the instant the sweep fires at —
 * injected, so tests pin it and production passes the worker clock.
 *
 * @param {{
 *   appointments: any, tasks: any, templateQueue: any, interactionLog: any,
 *   now?: () => string,
 * }} handles `appointments`/`tasks` are the record services;
 *   `templateQueue` the channel template queue (`queueTemplate`), opened on
 *   the composition's channel operations; `interactionLog` the history seam.
 */
export async function dispatchDueReminders(handles) {
  const appointments = requireService(handles?.appointments, 'appointment');
  const tasks = requireService(handles?.tasks, 'work-task');
  const templateQueue = requireSeam(handles?.templateQueue, 'channels template queue', ['queueTemplate']);
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
      // Already sent: the confirmation marker below is the replay guard.
      if (row.reminderSentAt !== null && row.reminderSentAt !== undefined && row.reminderSentAt !== '') continue;
      due.push(row);
    }
  }
  // Deterministic order: the earliest instant first, then the booking key —
  // so two sweeps racing queue the identical jobs in the same order.
  due.sort((a, b) => (a.reminderDueAt < b.reminderDueAt ? -1 : a.reminderDueAt > b.reminderDueAt ? 1 : 0)
    || (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));

  const sent = [];
  const queued = [];
  const skipped = [];
  const failed = [];
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await fireOneReminder({ appointments, tasks, templateQueue, interactionLog, instant }, row);
      if (outcome === null) {
        skipped.push({ sourceKey: row.sourceKey, reason: 'follow-up-closed' });
      } else if (outcome.status === 'sent') {
        sent.push({ sourceKey: outcome.sourceKey, jobId: outcome.jobId, conversationId: outcome.conversationId });
      } else if (outcome.status === 'queued') {
        queued.push({ sourceKey: outcome.sourceKey, jobId: outcome.jobId, jobState: outcome.jobState });
      } else {
        skipped.push({ sourceKey: outcome.sourceKey, reason: outcome.reason });
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
    // Processed every reminder first, then fail the sweep: queueing is
    // idempotent, so the retry re-queues nothing new and only re-tries the
    // failed ones.
    throw new AppError(
      `The reminder sweep queued what it could and failed on ${failed.map((entry) => entry.sourceKey).join(', ')}`,
      { code: 'APPOINTMENTS_REMINDER_SWEEP_FAILED', status: 500, details: { failed, sent: sent.length } },
    );
  }
  return Object.freeze({
    sent: Object.freeze(sent),
    queued: Object.freeze(queued),
    skipped: Object.freeze(skipped),
    at: instant,
  });
}

/**
 * Queue one due reminder's outbox send and confirm it when the outbox
 * reports it finished. Answers null on the closed skip (a human-closed
 * reminder stays closed — the sweep never overrides it).
 */
async function fireOneReminder({ appointments, tasks, templateQueue, interactionLog, instant }, row) {
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
  const template = {
    name: row.reminderTemplateName,
    ...(row.reminderTemplateLanguage !== null && row.reminderTemplateLanguage !== undefined
      && row.reminderTemplateLanguage !== '' ? { language: row.reminderTemplateLanguage } : {}),
    variables,
  };
  // The persistent claim, before any provider bytes: racing sweeps (or a
  // crash-retry) queue the byte-identical job and get the same row back.
  // The due instant schedules the job — stable per booking, so every beat
  // computes the identical enqueue and dedups on it.
  const queued = await templateQueue.queueTemplate({
    spaceId: row.reminderSpaceId,
    connectionKey: row.reminderConnectionKey,
    to: row.reminderTo,
    template,
    messageKey,
    scheduleAt: row.reminderDueAt,
    actor: TIMER_ACTOR,
  });
  if (queued.state === 'succeeded') {
    const conversationId = await confirmOneReminder({ appointments, interactionLog, instant }, row);
    return { status: 'sent', sourceKey: row.sourceKey, jobId: queued.jobId, conversationId };
  }
  // A send the outbox settled terminally (or cancelled) never fires on its
  // own again: the dead-letter queue owns the human requeue, and the
  // follow-up stays open for the human.
  if (queued.state === 'failed_terminal') {
    return { status: 'dead', sourceKey: row.sourceKey, reason: 'send-failed' };
  }
  if (queued.state === 'cancelled') {
    return { status: 'dead', sourceKey: row.sourceKey, reason: 'send-cancelled' };
  }
  return { status: 'queued', sourceKey: row.sourceKey, jobId: queued.jobId, jobState: queued.state };
}

/**
 * Record a confirmed send in the thread and mark the booking sent. Both
 * halves replay: the thread and the message re-resolve by their
 * deterministic source keys, and the marker is the same instant twice.
 */
async function confirmOneReminder({ appointments, interactionLog, instant }, row) {
  const messageKey = reminderMessageKey(row.sourceKey);
  const threadKey = reminderThreadKey(row.sourceKey);
  const body = reminderHistoryBody(row);
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
  // No remote handle: the provider id belongs to the outbox job, and this
  // package never copies provider truth into history — the thread proves
  // the send happened, the jobs table proves the provider answered.
  await interactionLog.logMessage({
    sourceKey: messageKey,
    conversationId,
    direction: 'outbound',
    channel: 'whatsapp',
    body,
    teamAuthorId: row.teamMemberId,
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
  return conversationId;
}

/**
 * Register the sweep on a durable-job registry — the timer half. The
 * deployment beats `seedReminderSweep` on its own interval; the worker
 * fires due sweeps; the dispatch queues (then confirms) only what is due.
 *
 * @param {any} registry
 * @param {{
 *   appointments: any, tasks: any, templateQueue: any, interactionLog: any,
 *   clock?: () => string,
 * }} composition Handles are validated here, not at the first fire.
 */
export function registerAppointmentReminderSweep(registry, composition) {
  requireService(composition?.appointments, 'appointment');
  requireService(composition?.tasks, 'work-task');
  requireSeam(composition?.templateQueue, 'channels template queue', ['queueTemplate']);
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
    async execute({ job }) {
      await dispatchDueReminders({
        appointments: composition.appointments,
        tasks: composition.tasks,
        templateQueue: composition.templateQueue,
        interactionLog: composition.interactionLog,
        now: clock,
      });
      // The seed's own reference back: a re-seed of the same beat finds the
      // identical reference and replays the finished row instead of
      // mismatching it.
      return {
        outcomeReference: job?.outcomeReference
          ?? `${APPOINTMENT_REMINDER_SWEEP_KIND}:${job?.scheduleAt ?? 'unknown'}`,
      };
    },
  });
  return registry;
}

/**
 * Queue one sweep for the beat at `at`: the beat the deployment owns. Each
 * beat is its own sweep — the idempotency root names the beat instant, so a
 * beat that already ran replays its own row (same instant, same job) while
 * the next beat queues separately: reminders booked after the first sweep
 * still fire. A double beat of the same instant stacks nothing.
 *
 * @param {{store: any, actor?: unknown, at?: string}} context
 */
export async function seedReminderSweep(context) {
  const store = context?.store;
  if (!store || typeof store.enqueue !== 'function') {
    throw new ValidationError('seedReminderSweep needs a durable-job store', { field: 'store' });
  }
  const at = typeof context?.at === 'string' && context.at !== '' ? context.at : new Date().toISOString();
  const beat = `${APPOINTMENT_REMINDER_SWEEP_KIND}:${at}`;
  try {
    const job = await store.enqueue({
      kind: APPOINTMENT_REMINDER_SWEEP_KIND,
      handler: { name: APPOINTMENT_REMINDER_SWEEP_HANDLER, contract: 1, version: APPOINTMENT_REMINDER_SWEEP_VERSION },
      payload: {},
      scheduleAt: at,
      maxAttempts: APPOINTMENT_REMINDER_SWEEP_MAX_ATTEMPTS,
      idempotencyRoot: beat,
      outcomeReference: beat,
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
