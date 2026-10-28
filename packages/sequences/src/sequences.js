// @ts-check

import { createHash } from 'node:crypto';
import { AppError, ConflictError, ValidationError } from '../../core/index.js';

/**
 * **Sequences — BO-F3-03, the backoffice follow-up sequences (backlog:22bb154a72ea).**
 *
 * Pure domain logic over managed record services. No provider is contacted
 * here and no secret is resolved here: a due step is queued into the
 * channels outbox through the composition-provided `queueTemplate` seam
 * (the same durable enqueue as every channel send — MEM_ACC_REUSE), and the
 * reply stop reads the channels inbox rows through the `inbox` record
 * service with the connection's own reply window
 * (`subjectForRecipient`/`isObservation` from the adapter definition the
 * composition passes in). No import from any other domain package — the key
 * helpers below are restated here on purpose, like every other package does.
 *
 * Four invariants, one per acceptance criterion:
 *
 * 1. **Stop on reply.** Every sweep looks for an applied inbox row from
 *    each active enrollment's recipient recorded after the enrollment — due
 *    or not. The first one stops the enrollment (`stopped-replied`) and no
 *    further step fires — the sweep never consults a caller timestamp.
 *    Completion means every step was attempted; a dead-lettered step stays
 *    visible in metrics and the outbox dead-letter queue.
 * 2. **Fail-closed permission.** Every fire passes the
 *    `space-permission-gate@1` verdict for `send-without-approval`. On
 *    `proposal` the sweep records the approval proposal (the permission
 *    notice a human decides) and the step waits: nothing is queued, and the
 *    step stays due until a human approves and the enrollment resumes.
 * 3. **Pause/resume without doubles.** A send row is keyed by the
 *    deterministic message key, unique in storage: a retry or a resume
 *    replays the stored row instead of queueing a second job, and the
 *    outbox's own idempotency returns the same job for the same key.
 * 4. **Metrics from records.** Counts are computed from enrollment and send
 *    rows on every read — no stored counters exist to drift after a crash
 *    or a race.
 */

/** Enrollment lifecycle. Terminal states never fire again. */
export const ENROLLMENT_STATES = Object.freeze(['active', 'paused', 'stopped-replied', 'completed']);
export const ENROLLMENT_TERMINAL = Object.freeze(['stopped-replied', 'completed']);

/** Sequence lifecycle. Only an active sequence fires its steps. */
export const SEQUENCE_STATES = Object.freeze(['draft', 'active', 'paused']);

/** Send-row lifecycle. `skipped` names a step the sweep refused row-locally. */
export const SEND_STATES = Object.freeze(['queued', 'waiting-approval', 'sent', 'dead-letter', 'skipped']);

/** The gated AI permission every sequence step sends under (BO-F0-06). */
export const SEQUENCE_SEND_PERMISSION = 'send-without-approval';

const SEQUENCES_DOMAIN_REF = 'sequences';

export const SEQUENCE_TIMER_ACTOR = Object.freeze({ type: 'system', id: 'sequence-sweep' });

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_COMPONENT_MAX = 128;
const KEY_TOTAL_MAX = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_LINE = 1024;
const MAX_NAME = 200;

/** Restated from the channels key helper: no cross-package import. */
function escapeKeyPart(value) {
  return value.replace(/%/g, '%25').replace(/:/g, '%3A');
}

/** Deterministic, bounded, injective join — same contract as the channels `boundedKey`. */
export function sequenceKey(...parts) {
  if (parts.length === 0) {
    throw new ValidationError('sequenceKey needs at least one part', { field: 'key' });
  }
  const texts = parts.map((part) => {
    if (typeof part !== 'string' || part === '' || part.length > 1024 || CONTROL_RE.test(part)) {
      throw new ValidationError('sequenceKey parts must be bounded single-line text', { field: 'key' });
    }
    return escapeKeyPart(part);
  });
  const safe = texts.map((text) => (
    text.length <= KEY_COMPONENT_MAX
      ? text
      : `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
  ));
  const joined = safe.join(':');
  if (joined.length <= KEY_TOTAL_MAX) return joined;
  const tailHash = createHash('sha256').update(safe.slice(1).join(':'), 'utf8').digest('hex');
  return `${safe[0]}:${tailHash}`;
}

/**
 * The deterministic send identity of one enrollment step. The space id is
 * an explicit part: two spaces running the same sequence key enroll and
 * queue under different identities, so neither space can squat or read the
 * other's rows through the global sourceKey uniqueness.
 */
export function sequenceMessageKey(spaceId, enrollmentSourceKey, stepOrder) {
  return sequenceKey('seq', spaceId, enrollmentSourceKey, String(stepOrder));
}

/** @param {unknown} value @param {string} field */
export function checkRecordKey(value, field, max = 256) {
  return boundedLine(value, field, max);
}

/**
 * Optional backoffice label for the `Quando …` / `Si ferma quando: …` pills
 * (BO-F6-12, backlog:ca96298ca38a): null when the sequence carries no label,
 * otherwise bounded single-line text (280 keeps the pill on one line).
 * Empty and overlong labels refuse fail-closed, like every other row field.
 * @param {unknown} value @param {string} field
 */
export function optionalSequenceLabel(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 280 || CONTROL_RE.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line text when present`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function boundedLine(value, field, max = MAX_LINE) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL_RE.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line text`, { field });
  }
  return value;
}

/** @param {unknown} value */
export function checkSpaceId(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('spaceId must be a string issued by the control plane', { field: 'spaceId' });
  }
  const id = value.trim();
  if (id === '' || id.length > 128 || CONTROL_RE.test(id)) {
    throw new ValidationError('spaceId must be a non-empty id of at most 128 characters', { field: 'spaceId' });
  }
  return id;
}

/** Identified callers only — restated, never imported from space-permissions. @param {unknown} actor */
export function requireSequenceActor(actor, what) {
  if (!actor || typeof actor !== 'object'
    || typeof /** @type {any} */ (actor).type !== 'string' || /** @type {any} */ (actor).type.trim() === ''
    || typeof /** @type {any} */ (actor).id !== 'string' || /** @type {any} */ (actor).id.trim() === '') {
    throw new AppError(`${what} requires an identified actor`, { code: 'SEQUENCE_ACTOR_REQUIRED', status: 403 });
  }
  return { type: /** @type {any} */ (actor).type.trim(), id: /** @type {any} */ (actor).id.trim() };
}

/** @param {unknown} value */
function checkInstant(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${field} must be a canonical instant`, { field });
  }
  return value;
}

function isWinnerConflict(error) {
  if (error instanceof ConflictError) return true;
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'SEQUENCES_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/** Read-only record handle for the channels inbox rows the stop reads. */
function trustedReadable(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.listWhere !== 'function') {
    throw new AppError(`Module "${name}" is not readable — compose the channels package beside sequences`, {
      code: 'SEQUENCES_INBOX_MISSING', status: 500,
    });
  }
  return service;
}

/**
 * Validate one step definition. `templateVars` is the JSON array of template
 * variables with `{{placeholder}}` slots the sweep personalizes per person.
 */
export function checkStepInput(step, order) {
  const record = step && typeof step === 'object' ? step : {};
  const dayOffset = /** @type {any} */ (record).dayOffset;
  if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 365) {
    throw new ValidationError('step dayOffset must be an integer number of days, 0 to 365', { field: 'dayOffset' });
  }
  const channel = boundedLine(/** @type {any} */ (record).channel ?? '', 'channel', 64);
  const templateName = boundedLine(/** @type {any} */ (record).templateName ?? '', 'templateName', 128);
  const templateLanguage = boundedLine(/** @type {any} */ (record).templateLanguage ?? 'it', 'templateLanguage', 16);
  let templateVars = /** @type {any} */ (record).templateVars ?? [];
  if (typeof templateVars === 'string') {
    try {
      templateVars = JSON.parse(templateVars);
    } catch {
      throw new ValidationError('step templateVars must be a JSON array of strings', { field: 'templateVars' });
    }
  }
  if (!Array.isArray(templateVars) || templateVars.some((entry) => typeof entry !== 'string' || entry.length > 1024)) {
    throw new ValidationError('step templateVars must be an array of strings', { field: 'templateVars' });
  }
  return {
    stepOrder: order,
    dayOffset,
    channel,
    templateName,
    templateLanguage,
    templateVars: JSON.stringify(templateVars),
  };
}

/**
 * True when a stored step row carries exactly the checked step definition.
 * A deterministic-order UNIQUE collision is only an idempotent replay when
 * the content matches: two operators appending different steps at the same
 * order must hear a conflict, never a silent drop of their step.
 */
export function sameSequenceStepContent(stored, checked) {
  return !!stored && !!checked
    && stored.dayOffset === checked.dayOffset
    && stored.channel === checked.channel
    && stored.templateName === checked.templateName
    && stored.templateLanguage === checked.templateLanguage
    && stored.templateVars === checked.templateVars;
}

/** Substitute `{{key}}` slots from the enrolled person's vars. Unknown slots stay empty, never undefined. */
export function personalizeVars(templateVarsJson, enrollment) {
  let slots = [];
  try {
    const parsed = JSON.parse(templateVarsJson ?? '[]');
    slots = Array.isArray(parsed) ? parsed : [];
  } catch {
    slots = [];
  }
  let vars = {};
  try {
    const parsed = JSON.parse(enrollment?.vars ?? '{}');
    vars = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    vars = {};
  }
  const label = typeof enrollment?.subjectLabel === 'string' ? enrollment.subjectLabel : '';
  const lookup = { ...vars };
  if (lookup.name === undefined || lookup.name === null || lookup.name === '') lookup.name = label;
  if (lookup.label === undefined || lookup.label === null || lookup.label === '') lookup.label = label;
  return slots.map((slot) => {
    if (typeof slot !== 'string') return '';
    return slot.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
      const value = lookup[key];
      return value === undefined || value === null ? '' : String(value);
    });
  });
}

/**
 * The first recorded reply of one enrollment: an applied inbox row for the
 * recipient's conversation after the enrollment, where "the recipient's
 * conversation" and "a reply" (not a delivery report) are the connection
 * window's own rule. Returns the row, or null when no reply is recorded.
 *
 * A window the sweep cannot use — missing, truthy but malformed (no
 * `subjectForRecipient`/`isObservation` functions), a `subjectForRecipient`
 * that throws for this recipient, or a non-string subject — is NOT "no
 * reply": it is "cannot tell". This throws (`SEQUENCES_WINDOW_MALFORMED`)
 * instead of returning null, so callers fail closed (blind enrollment,
 * never fired) instead of queueing the next follow-up to someone who may
 * already have replied. A raw-recipient comparison could never equal a
 * normalized conversation subject (such as `wa:<digits>`), so matching
 * here would only miss the reply and send anyway.
 */
export function findReply({ inboxRows, window, to, sinceMs }) {
  const usable = window
    && typeof window.subjectForRecipient === 'function'
    && typeof window.isObservation === 'function';
  if (!usable) {
    throw new AppError('Sequence reply window is missing or malformed', {
      code: 'SEQUENCES_WINDOW_MALFORMED', status: 500,
    });
  }
  let subject;
  try {
    subject = window.subjectForRecipient(to);
  } catch (error) {
    const cause = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    throw new AppError('Sequence reply window cannot determine the conversation', {
      code: 'SEQUENCES_WINDOW_MALFORMED', status: 500,
      details: { cause },
    });
  }
  if (typeof subject !== 'string' || subject === '') {
    throw new AppError('Sequence reply window cannot determine the conversation', {
      code: 'SEQUENCES_WINDOW_MALFORMED', status: 500,
    });
  }
  const rows = Array.isArray(inboxRows) ? inboxRows : [];
  let earliest = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.subject !== subject || row.effect !== 'applied') continue;
    let observation;
    try {
      observation = window.isObservation(row) === true;
    } catch (error) {
      const cause = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN';
      throw new AppError('Sequence reply window cannot classify an inbox row', {
        code: 'SEQUENCES_WINDOW_MALFORMED', status: 500,
        details: { cause },
      });
    }
    if (!observation) continue;
    const at = typeof row.occurredAt === 'string' && row.occurredAt !== '' ? row.occurredAt : row.receivedAt;
    if (typeof at !== 'string') continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms <= sinceMs) continue;
    if (earliest === null || ms < earliest.ms) earliest = { ms, row };
  }
  return earliest?.row ?? null;
}

/** Count-only metrics over enrollment and send rows — no stored counters. */
export function computeSequenceMetrics({ enrollments, sends }) {
  const people = Array.isArray(enrollments) ? enrollments : [];
  const fires = Array.isArray(sends) ? sends : [];
  const perStep = new Map();
  for (const row of fires) {
    if (!row || typeof row !== 'object') continue;
    const order = /** @type {any} */ (row).stepOrder;
    if (!Number.isInteger(order)) continue;
    if (!perStep.has(order)) {
      perStep.set(order, { stepOrder: order, queued: 0, waitingApproval: 0, sent: 0, deadLetter: 0, skipped: 0 });
    }
    const cell = perStep.get(order);
    switch (/** @type {any} */ (row).status) {
      case 'queued': cell.queued += 1; break;
      case 'waiting-approval': cell.waitingApproval += 1; break;
      case 'sent': cell.sent += 1; break;
      case 'dead-letter': cell.deadLetter += 1; break;
      case 'skipped': cell.skipped += 1; break;
      default: break;
    }
  }
  let active = 0;
  let paused = 0;
  let stoppedReplied = 0;
  let completed = 0;
  for (const row of people) {
    switch (row?.status) {
      case 'active': active += 1; break;
      case 'paused': paused += 1; break;
      case 'stopped-replied': stoppedReplied += 1; break;
      case 'completed': completed += 1; break;
      default: break;
    }
  }
  return Object.freeze({
    enrolled: people.length,
    active,
    paused,
    stoppedReplied,
    completed,
    sends: fires.length,
    perStep: Object.freeze([...perStep.values()].sort((a, b) => a.stepOrder - b.stepOrder).map((cell) => Object.freeze({ ...cell }))),
  });
}

/** @param {string} from @param {string} event */
function assertEnrollmentTransition(from, event) {
  const allowed = {
    pause: ['active'],
    resume: ['paused'],
    'stop-replied': ['active'],
    complete: ['active'],
  }[event];
  if (!allowed || !allowed.includes(from)) {
    throw new AppError(`Enrollment cannot ${event} from ${from}`, {
      code: 'SEQUENCE_TRANSITION_INVALID', status: 409,
    });
  }
}

/** @param {string} from @param {string} event */
function assertSequenceTransition(from, event) {
  const allowed = { pause: ['active'], resume: ['paused'], activate: ['draft', 'paused'] }[event];
  if (!allowed || !allowed.includes(from)) {
    throw new AppError(`Sequence cannot ${event} from ${from}`, {
      code: 'SEQUENCE_TRANSITION_INVALID', status: 409,
    });
  }
}

/** Queue-time refusals that belong to one row, never to the sweep. */
const QUEUE_REFUSAL_SKIPS = new Set([
  'CHANNEL_CONNECTION_NOT_ACTIVE',
  'CHANNEL_CONNECTION_UNKNOWN',
  'CHANNEL_ADAPTER_UNKNOWN',
  'CHANNEL_MESSAGE_MALFORMED',
  'CHANNEL_TEMPLATE_REQUIRED',
]);

function addDaysMs(baseMs, days) {
  return new Date(baseMs + days * DAY_MS).toISOString();
}

/**
 * Advance every due step of every active sequence: reply stop, permission
 * gate, queue, then confirm. Returns the sweep summary; a refused row is
 * recorded and the sweep stays green for every other due step.
 */
export async function advanceSequences({
  modules, queueTemplate, permissionGate, replyWindows, now, actor, personalize,
}) {
  const timer = requireSequenceActor(actor ?? SEQUENCE_TIMER_ACTOR, 'Advancing sequences');
  if (typeof queueTemplate !== 'function') {
    throw new AppError('Sequence advance needs the channels template queue seam (queueTemplateSend)', {
      code: 'SEQUENCES_QUEUE_MISSING', status: 500,
    });
  }
  const nowIso = typeof now === 'function' ? now() : new Date().toISOString();
  const nowMs = Date.parse(checkInstant(nowIso, 'now'));
  const sequences = trusted(modules, 'sequence');
  const steps = trusted(modules, 'sequence-step');
  const enrollments = trusted(modules, 'sequence-enrollment');
  const sends = trusted(modules, 'sequence-send');
  const inbox = trustedReadable(modules, 'channel-inbox-event');
  const summary = {
    advanced: 0, stoppedReplied: 0, waitingApproval: 0, confirmed: 0, skipped: 0,
    inboxUnavailable: [],
    sweepErrors: [],
  };
  /** Enrollments the sweep cannot see the inbox of: never fired blind. */
  const blindEnrollments = new Set();
  const blindKey = (enrollment) => `${enrollment.spaceId} ${enrollment.sourceKey}`;
  const noteInboxBlind = (enrollment, error) => {
    const details = error && typeof error === 'object' ? error.details : null;
    const cause = details && typeof details === 'object' && typeof details.cause === 'string' ? details.cause : null;
    const code = cause
      ?? (error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN');
    summary.inboxUnavailable.push(Object.freeze({
      enrollmentSourceKey: enrollment.sourceKey, spaceId: enrollment.spaceId, code,
    }));
    blindEnrollments.add(blindKey(enrollment));
  };
  /**
   * One enrollment (or confirm row) failed with a non-terminal error: a bad
   * personalize output, a gate failure, a transient queue failure. The sweep
   * records it here and moves on — one broken enrollment never starves the
   * later enrollments or the confirm pass behind it.
   */
  const noteSweepError = (enrollment, error, phase) => {
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    summary.sweepErrors.push(Object.freeze({
      enrollmentSourceKey: enrollment?.sourceKey ?? '',
      spaceId: enrollment?.spaceId ?? '',
      phase,
      code,
    }));
  };

  /**
   * The reply window of one enrollment: its connection key first, then the
   * channel of the step it currently waits on — the same resolution in the
   * stop pass and in the due path. Null when the deployment composed no
   * window for either: the caller records the enrollment blind (fail
   * closed) instead of matching a recipient that could never equal a
   * normalized conversation subject.
   */
  const resolveReplyWindow = async (enrollment) => {
    const direct = replyWindows?.[enrollment.connectionKey] ?? null;
    if (direct) return direct;
    try {
      const sibs = await steps.listWhere({ spaceId: enrollment.spaceId, sequenceSourceKey: enrollment.sequenceSourceKey });
      const ordered = (Array.isArray(sibs) ? sibs : [])
        .filter((row) => row && Number.isInteger(row.stepOrder))
        .sort((a, b) => a.stepOrder - b.stepOrder);
      const at = Number.isInteger(enrollment.currentStep) ? enrollment.currentStep : 0;
      const step = ordered.find((row) => row.stepOrder >= at) ?? ordered[0] ?? null;
      const channel = step && typeof step.channel === 'string' ? step.channel : '';
      if (channel !== '') return replyWindows?.[channel] ?? null;
    } catch {
      return null;
    }
    return null;
  };

  /**
   * Inbox rows of one enrollment's own connection. A transient read failure
   * is fail-closed: the caller records it and never fires that enrollment
   * blind — a reply the sweep cannot see must not be answered with a send.
   */
  const loadEnrollmentInbox = async (enrollment) => {
    let rows;
    try {
      rows = await inbox.listWhere({ spaceId: enrollment.spaceId });
    } catch (error) {
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN';
      throw new AppError(`Sequence inbox of space "${enrollment.spaceId}" is unreadable`, {
        code: 'SEQUENCES_INBOX_UNAVAILABLE', status: 500,
        details: { spaceId: enrollment.spaceId, cause: code },
      });
    }
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.connectionKey === enrollment.connectionKey);
  };

  const gateFor = (spaceId) => {
    if (!permissionGate || typeof permissionGate.gate !== 'function') {
      throw new AppError('Sequence advance needs the space-permission-gate@1 capability', {
        code: 'SEQUENCES_GATE_MISSING', status: 500,
      });
    }
    return permissionGate.gate({ spaceId, permission: SEQUENCE_SEND_PERMISSION });
  };

  /**
   * The human decision already recorded for this exact step, through the
   * gate capability only — never by reading another package's tables. Null
   * when no proposal was recorded yet or the capability cannot answer; the
   * caller then proposes (or fails closed) instead of guessing.
   */
  const readStoredProposal = async (spaceId, sendRow) => {
    const proposalId = sendRow && typeof sendRow.detail === 'string' && sendRow.detail !== ''
      ? sendRow.detail
      : '';
    if (proposalId === '' || !permissionGate || typeof permissionGate.proposal !== 'function') return null;
    try {
      const row = await permissionGate.proposal(spaceId, proposalId);
      return row && typeof row.status === 'string' ? row.status : null;
    } catch {
      return null;
    }
  };

  /**
   * Move the cursor past one step. After a queue the cursor only advances:
   * completing a fired final step waits for the confirm pass (the live-empty
   * branch completes once the send settles). After a terminal refusal there
   * is no send to wait for, so the last step completes at once. One skip
   * records one row and moves once — never a retry on the next sweep.
   */
  /**
   * True while one send of this enrollment still waits for an answer: a
   * queued row the outbox has not settled, or a step waiting for a human
   * ok. Skipped, sent and dead rows are settled and never block completion.
   */
  const hasUnsettledSends = async (spaceId, enrollmentSourceKey) => {
    const outstanding = await sends.listWhere({ spaceId, enrollmentSourceKey });
    return (Array.isArray(outstanding) ? outstanding : [])
      .some((row) => row && (row.status === 'queued' || row.status === 'waiting-approval'));
  };

  /**
   * Move the cursor past a terminally skipped step. The last step completes
   * the enrollment only once every prior send settled: a sweep that skips
   * the final step while an earlier send is still queued or waiting for a
   * human ok stays active, and the live-empty branch completes later once
   * the confirm pass settles the priors — otherwise the orphaned queued
   * row belongs to a completed enrollment the confirm pass never reads.
   * A read failure stays active too (fail closed): the next sweep retries
   * the check instead of completing blind.
   */
  const moveCursorAfterSkip = async (current, ordered, step) => {
    let unsettled = true;
    try {
      unsettled = await hasUnsettledSends(current.spaceId, current.sourceKey);
    } catch (error) {
      noteSweepError(current, error, 'due');
    }
    return moveCursorPast({
      current, ordered, step, nowIso, nowMs, completeWhenLast: !unsettled,
    });
  };

  const moveCursorPast = async ({ current, ordered, step, nowIso, nowMs, completeWhenLast = true }) => {
    const next = ordered.find((row) => row && row.stepOrder === step.stepOrder + 1) ?? null;
    if (!next) {
      if (!completeWhenLast) {
        await enrollments.applyManaged(current.id, {
          currentStep: step.stepOrder + 1, decidedAt: nowIso,
        }, { actor: timer });
        return 'advanced';
      }
      await enrollments.applyManaged(current.id, { status: 'completed', decidedAt: nowIso }, { actor: timer });
      return 'completed';
    }
    await enrollments.applyManaged(current.id, {
      currentStep: step.stepOrder + 1,
      nextDueAt: addDaysMs(fireMs(current, nowMs), next.dayOffset),
      decidedAt: nowIso,
    }, { actor: timer });
    return 'advanced';
  };

  /**
   * Record one terminal refusal (a revoked connection, an unapproved
   * template, a human refusal) on the step's own row. True when this call
   * recorded the skip; false when the row already carries provider evidence
   * the refusal must not rewrite — a confirmed outbox claim, a send, or a
   * dead row belongs to the confirm pass, never to the refusal. The refusal
   * belongs to the row, never to the sweep.
   */
  const recordTerminalSkip = async ({ seqKey, current, step, messageKey, nowIso, detail, pre }) => {
    if (!pre) {
      try {
        await sends.createManaged({
          sourceKey: messageKey,
          enrollmentSourceKey: current.sourceKey,
          sequenceSourceKey: seqKey,
          spaceId: current.spaceId,
          stepOrder: step.stepOrder,
          messageKey,
          jobId: '',
          status: 'skipped',
          queuedAt: nowIso,
          decidedAt: nowIso,
          detail,
          variables: '[]',
          actorType: timer.type,
          actorId: timer.id,
        }, { actor: timer });
      } catch (error) {
        if (!isWinnerConflict(error)) throw error;
      }
      return true;
    }
    if (pre.status === 'waiting-approval'
      || (pre.status === 'queued' && (!pre.jobId || pre.jobId === ''))) {
      // A waiting row never reached the outbox, and a queued row without a
      // confirmed job id is a claim whose enqueue outcome is unknown — every
      // refusal code below is raised before the enqueue, and a job orphaned
      // by an earlier crash either already sent the allowed step once or
      // dead-letters at execute time, so it never sends twice from this row.
      await sends.applyManaged(pre.id, { status: 'skipped', decidedAt: nowIso, detail }, { actor: timer });
      return true;
    }
    return false;
  };

  /**
   * Resolve the queued template variables for one step. The due pass
   * persists the payload on the send row BEFORE the outbox enqueue and every
   * later attempt reuses it, so the personalize hook runs once per step: a
   * non-deterministic hook cannot wedge the enrollment on idempotency
   * mismatch — the first payload wins and retries replay it byte-identical.
   * The confirm pass reuses the same stored payload for the same reason. A
   * row with no stored variables (never written by this code) reproduces
   * what queueing would do, hook included, as a best effort.
   */
  const resolveSendVariables = async (step, enrollment, storedJson) => {
    if (typeof storedJson === 'string' && storedJson !== '') {
      try {
        const parsed = JSON.parse(storedJson);
        if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed;
      } catch {
        // Fall through and reproduce below.
      }
    }
    let variables = personalizeVars(step.templateVars, enrollment);
    if (typeof personalize === 'function') {
      const rewritten = await personalize({
        channel: step.channel,
        template: { name: step.templateName, language: step.templateLanguage },
        variables,
        enrollment: { ...enrollment },
      });
      if (!Array.isArray(rewritten) || rewritten.some((entry) => typeof entry !== 'string')) {
        throw new AppError('The personalize hook must return the template variables as strings', {
          code: 'SEQUENCES_PERSONALIZE_INVALID', status: 500,
        });
      }
      variables = rewritten;
    }
    return variables;
  };

  const rows = await sequences.listWhere({ status: 'active' });

  /**
   * The stop pass: the first recorded reply stops the enrollment, due or
   * not. A reply that arrives between two steps must not wait for the next
   * due instant — the stop is recorded as soon as the sweep sees it.
   */
  const stopIfReplied = async (enrollment) => {
    let current = enrollment;
    try {
      const reread = await enrollments.get(enrollment.id);
      if (reread) current = reread;
    } catch {
      current = enrollment;
    }
    if (!current || current.status !== 'active') return false;
    let inboxRows;
    try {
      inboxRows = await loadEnrollmentInbox(current);
    } catch (error) {
      noteInboxBlind(current, error);
      return 'blind';
    }
    const window = await resolveReplyWindow(current);
    if (!window) {
      noteInboxBlind(current, { code: 'SEQUENCES_WINDOW_MISSING' });
      return 'blind';
    }
    let reply;
    try {
      reply = findReply({
        inboxRows,
        window,
        to: current.recipient,
        sinceMs: Date.parse(current.enrolledAt),
      });
    } catch (error) {
      // "Cannot tell" is not "no reply": a malformed or throwing window
      // blinds this enrollment instead of letting the sweep fire past a
      // reply it cannot see.
      noteInboxBlind(current, error);
      return 'blind';
    }
    if (!reply) return false;
    await enrollments.applyManaged(current.id, { status: 'stopped-replied', decidedAt: nowIso }, { actor: timer });
    summary.stoppedReplied += 1;
    return true;
  };

  for (const sequence of Array.isArray(rows) ? rows : []) {
    if (!sequence || typeof sequence !== 'object') continue;
    // One sequence's unreadable enrollment list never starves the later
    // sequences or the due and confirm passes behind it: the throw is
    // recorded on the summary and the sweep moves on.
    let active;
    try {
      active = await enrollments.listWhere({
        spaceId: /** @type {any} */ (sequence).spaceId,
        sequenceSourceKey: /** @type {any} */ (sequence).sourceKey, status: 'active',
      });
    } catch (error) {
      noteSweepError(
        { sourceKey: '', spaceId: /** @type {any} */ (sequence).spaceId ?? '' },
        error,
        'stop',
      );
      continue;
    }
    for (const enrollment of Array.isArray(active) ? active : []) {
      if (!enrollment || typeof enrollment !== 'object') continue;
      try {
        await stopIfReplied(enrollment);
      } catch (error) {
        // A failing stop write (or reread) stays with that enrollment: the
        // sweep records it and checks the next enrollment instead of
        // aborting the whole multi-space sweep.
        noteSweepError(enrollment, error, 'stop');
      }
    }
  }

  for (const sequence of Array.isArray(rows) ? rows : []) {
    if (!sequence || typeof sequence !== 'object') continue;
    const spaceId = /** @type {any} */ (sequence).spaceId;
    const seqKey = /** @type {any} */ (sequence).sourceKey;
    // One sequence's unreadable steps or enrollments never starve the later
    // sequences or the confirm pass behind them: the throw is recorded on
    // the summary and the sweep moves on to the next sequence.
    let ordered;
    try {
      ordered = (await steps.listWhere({ spaceId, sequenceSourceKey: seqKey }))
        .filter((row) => row && Number.isInteger(row.stepOrder))
        .sort((a, b) => a.stepOrder - b.stepOrder);
    } catch (error) {
      noteSweepError({ sourceKey: '', spaceId }, error, 'due');
      continue;
    }
    if (ordered.length === 0) continue;
    let due;
    try {
      due = (await enrollments.listWhere({ spaceId, sequenceSourceKey: seqKey, status: 'active' }))
        .filter((row) => row && typeof row.nextDueAt === 'string' && Date.parse(row.nextDueAt) <= nowMs);
    } catch (error) {
      noteSweepError({ sourceKey: '', spaceId }, error, 'due');
      continue;
    }
    for (const enrollment of due) {
      // The due list is only a snapshot: re-read the row before firing, so a
      // pause or a stop between the list and the fire is honored.
      let current = null;
      try {
        current = await enrollments.get(enrollment.id);
      } catch {
        current = null;
      }
      if (!current || current.status !== 'active' || Date.parse(current.nextDueAt) > nowMs) continue;
      if (current.sequenceSourceKey !== seqKey) continue;
      // The active-sequence snapshot above may predate a pause-sequence
      // racing this sweep: re-read the sequence row space-scoped before
      // firing, and fire nothing — no queue and no completion — for a
      // sequence that is no longer active. Confirm of already-queued rows
      // is unchanged: the provider send was already claimed or answered.
      let liveSequence = null;
      try {
        const fresh = await sequences.listWhere({ spaceId, sourceKey: seqKey });
        liveSequence = fresh[0] ?? null;
      } catch (error) {
        noteSweepError(current, error, 'due');
        continue;
      }
      if (!liveSequence || liveSequence.status !== 'active') continue;
      if (blindEnrollments.has(blindKey(current))) continue;

      const live = ordered.filter((row) => row.stepOrder >= current.currentStep);
      if (live.length === 0) {
        // The final send settles before the enrollment completes: a sweep
        // that queued the last step but never saw the outbox answer leaves
        // the enrollment active so the confirm pass below still finds it.
        // Both storage reads and the completion write below stay with this
        // enrollment: a transient failure is recorded on the summary and
        // the sweep fires the next enrollment instead of aborting.
        let outstanding;
        try {
          outstanding = await sends.listWhere({ spaceId: current.spaceId, enrollmentSourceKey: current.sourceKey });
        } catch (error) {
          noteSweepError(current, error, 'due');
          continue;
        }
        const unsettled = (Array.isArray(outstanding) ? outstanding : [])
          .some((row) => row && (row.status === 'queued' || row.status === 'waiting-approval'));
        if (unsettled) continue;
        try {
          await enrollments.applyManaged(current.id, { status: 'completed', decidedAt: nowIso }, { actor: timer });
        } catch (error) {
          noteSweepError(current, error, 'due');
          continue;
        }
        summary.confirmed += 1;
        continue;
      }
      const step = live[0];
      const messageKey = sequenceMessageKey(current.spaceId, current.sourceKey, step.stepOrder);

      // 1. Stop on reply: the first recorded reply ends the enrollment.
      // Without the inbox — or without the reply window — this sweep
      // cannot know, so it fails closed and never fires. The window
      // resolution is the same connectionKey-then-channel lookup as the
      // stop pass above, and an unusable window blinds the enrollment
      // instead of letting the sweep fire past a reply it cannot see.
      const window = await resolveReplyWindow(current);
      if (!window) {
        noteInboxBlind(current, { code: 'SEQUENCES_WINDOW_MISSING' });
        continue;
      }
      let inboxRows;
      try {
        inboxRows = await loadEnrollmentInbox(current);
      } catch (error) {
        noteInboxBlind(current, error);
        continue;
      }
      let reply;
      try {
        reply = findReply({
          inboxRows,
          window,
          to: current.recipient,
          sinceMs: Date.parse(current.enrolledAt),
        });
      } catch (error) {
        noteInboxBlind(current, error);
        continue;
      }
      if (reply) {
        try {
          await enrollments.applyManaged(current.id, { status: 'stopped-replied', decidedAt: nowIso }, { actor: timer });
        } catch (error) {
          noteSweepError(current, error, 'due');
          continue;
        }
        summary.stoppedReplied += 1;
        continue;
      }

      // 2. Permission gate: without send-without-approval the step becomes
      // a human-decided proposal and waits — never queued. An approval the
      // human already recorded for this exact step unblocks it even while
      // the global switch stays off; a refusal ends the step as skipped.
      // The gate-and-queue section below runs isolated per enrollment (the
      // catch at its end): one enrollment's gate failure, bad personalize
      // output, or transient queue failure is recorded on the summary and
      // the sweep fires the next enrollment instead of throwing out.
      try {
        const verdict = await gateFor(current.spaceId);
        if (!verdict || verdict.decision !== 'allow') {
          const pre = await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey });
          const decided = await readStoredProposal(current.spaceId, pre[0] ?? null);
          if (decided === 'refused') {
            const recorded = await recordTerminalSkip({
              seqKey, current, step, messageKey, nowIso,
              detail: 'SPACE_PROPOSAL_REFUSED', pre: pre[0] ?? null,
            });
            await moveCursorAfterSkip(current, ordered, step);
            if (recorded) summary.skipped += 1;
            continue;
          }
          if (decided !== 'approved') {
            let proposed = null;
            let queueAllowedRacing = false;
            try {
              proposed = await permissionGate.propose({
                spaceId: current.spaceId,
                permission: SEQUENCE_SEND_PERMISSION,
                actionKind: 'sequence-step-send',
                actionKey: messageKey,
                summary: `Sequence step ${step.stepOrder + 1} for ${current.subjectLabel || current.subjectId} waits for send approval`,
                actor: timer,
              });
            } catch (error) {
              const race = error && typeof error === 'object' ? /** @type {any} */ (error).code : null;
              if (race === 'SPACE_PERMISSION_ENABLED') {
                // The owner enabled send-without-approval between the gate
                // verdict above and this propose call: propose re-read the
                // switch and refused to open a proposal. The step is allowed
                // now, so fall through to the queue branch below — the same
                // path as a racing approval — instead of throwing out of the
                // sweep and skipping every later enrollment.
                queueAllowedRacing = true;
              } else {
                if (race !== 'SPACE_PROPOSAL_DECIDED') throw error;
                const raced = await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey });
                let late = await readStoredProposal(current.spaceId, raced[0] ?? null);
                if (late === null) {
                  // No local waiting row: a crash between propose() and the
                  // row write above, decided by the human while this sweep
                  // re-proposes. propose() answers with SPACE_PROPOSAL_DECIDED
                  // and no id, so recover the winner by action key instead of
                  // wedging the enrollment on every later sweep.
                  const winner = typeof permissionGate.proposalForAction === 'function'
                    ? await permissionGate.proposalForAction(current.spaceId, SEQUENCE_SEND_PERMISSION, messageKey)
                    : null;
                  late = winner && typeof winner.status === 'string' ? winner.status : null;
                }
                if (late === 'refused') {
                  const recorded = await recordTerminalSkip({
                    seqKey, current, step, messageKey, nowIso,
                    detail: 'SPACE_PROPOSAL_REFUSED', pre: raced[0] ?? null,
                  });
                  await moveCursorAfterSkip(current, ordered, step);
                  if (recorded) summary.skipped += 1;
                  continue;
                }
                if (late !== 'approved') throw error;
                queueAllowedRacing = true;
              }
            }
            if (!queueAllowedRacing) {
              const proposalId = proposed.proposalId;
              const waiting = await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey });
              if (!waiting[0]) {
                try {
                  await sends.createManaged({
                    sourceKey: messageKey,
                    enrollmentSourceKey: current.sourceKey,
                    sequenceSourceKey: seqKey,
                    spaceId: current.spaceId,
                    stepOrder: step.stepOrder,
                    messageKey,
                    jobId: '',
                    status: 'waiting-approval',
                    queuedAt: nowIso,
                    decidedAt: nowIso,
                    detail: proposalId,
                    variables: '[]',
                    actorType: timer.type,
                    actorId: timer.id,
                  }, { actor: timer });
                } catch (error) {
                  if (!isWinnerConflict(error)) throw error;
                }
              }
              summary.waitingApproval += 1;
              continue;
            }
          }
        }

        // 3. Allowed: personalize and queue through the channels outbox. The
        // persisted send row IS the cross-process claim, written BEFORE the
        // outbox enqueue: every attempt reuses the row's payload, so a crash
        // between the enqueue and the job-id write retries with a
        // byte-identical payload — the outbox replays the first job instead
        // of raising DURABLE_JOB_IDEMPOTENCY_MISMATCH, even when the
        // personalize hook is non-deterministic. Two sweeps racing the first
        // claim collide on the deterministic row and the loser reuses the
        // winner's payload.
        const stored = await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey });
        if (stored[0] && stored[0].status === 'skipped') {
          // A crash between the skip record and the cursor move left the
          // cursor behind: repair it idempotently — the skip was already
          // recorded, so this never re-fires the step. Completion still
          // waits for unsettled priors like the skip path itself.
          await moveCursorAfterSkip(current, ordered, step);
          continue;
        }
        // A missing job id reads back as '' or null (the record layer
        // normalizes empty strings): a queued row without one is an
        // unconfirmed claim and this attempt must carry the persisted
        // payload. Any other stored row — a confirmed claim, a send, a dead
        // row — needs only the cursor repair below.
        const unconfirmedClaim = stored[0] && (stored[0].status === 'waiting-approval'
          || (stored[0].status === 'queued' && !stored[0].jobId));
        if (stored[0] && !unconfirmedClaim) {
          // A claimed send the cursor never passed (crash between the send
          // row and the cursor write): repair the cursor idempotently —
          // never a second job for the same step, and never a completion on
          // an unsettled send (the live-empty branch completes once settled).
          await moveCursorPast({ current, ordered, step, nowIso, nowMs, completeWhenLast: false });
          continue;
        }
        if (!stored[0]) {
          const computed = await resolveSendVariables(step, current, null);
          try {
            await sends.createManaged({
              sourceKey: messageKey,
              enrollmentSourceKey: current.sourceKey,
              sequenceSourceKey: seqKey,
              spaceId: current.spaceId,
              stepOrder: step.stepOrder,
              messageKey,
              jobId: '',
              status: 'queued',
              queuedAt: nowIso,
              decidedAt: nowIso,
              detail: '',
              variables: JSON.stringify(computed),
              actorType: timer.type,
              actorId: timer.id,
            }, { actor: timer });
          } catch (error) {
            if (!isWinnerConflict(error)) throw error;
          }
        } else if (stored[0].status === 'waiting-approval') {
          // A human-approved waiting row still carries the placeholder
          // payload: persist the computed variables before the first outbox
          // claim, so a crash retry reuses them instead of recomputing.
          const computed = await resolveSendVariables(step, current, null);
          await sends.applyManaged(stored[0].id, {
            variables: JSON.stringify(computed),
          }, { actor: timer });
        }
        const claim = (await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey }))[0] ?? null;
        if (!claim) {
          throw new AppError('Sequence send claim vanished before the outbox enqueue', {
            code: 'SEQUENCES_SEND_MISSING', status: 500,
            details: { spaceId: current.spaceId },
          });
        }
        const variables = await resolveSendVariables(step, current, claim.variables);
        let queued;
        try {
          queued = await queueTemplate({
            spaceId: current.spaceId,
            connectionKey: current.connectionKey,
            to: current.recipient,
            template: { name: step.templateName, language: step.templateLanguage, variables },
            messageKey,
            actor: timer,
          });
        } catch (error) {
          const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : null;
          if (code !== null && QUEUE_REFUSAL_SKIPS.has(code)) {
            const recorded = await recordTerminalSkip({
              seqKey, current, step, messageKey, nowIso,
              detail: code, pre: claim,
            });
            await moveCursorAfterSkip(current, ordered, step);
            if (recorded) summary.skipped += 1;
            continue;
          }
          if (code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH') {
            // Another writer already claimed this key with a different
            // payload (a pre-fix crash orphan, or a foreign writer): the
            // outbox holds exactly one send for this step, so re-firing
            // ours would double-send. Keep the persisted claim, record the
            // mismatch on the summary for the operator, and move the cursor
            // past the step without completing — the enrollment keeps moving
            // instead of wedging due on a key it can never match.
            noteSweepError(current, error, 'due');
            await moveCursorPast({ current, ordered, step, nowIso, nowMs, completeWhenLast: false });
            continue;
          }
          throw error;
        }
        const jobId = typeof queued?.jobId === 'string' ? queued.jobId : '';
        const jobState = typeof queued?.state === 'string' ? queued.state : '';
        const variablesJson = JSON.stringify(variables);
        {
          const latest = (await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey }))[0] ?? null;
          if (latest && (latest.status === 'queued' || latest.status === 'waiting-approval')) {
            await sends.applyManaged(latest.id, {
              jobId, status: 'queued', queuedAt: nowIso, decidedAt: nowIso, variables: variablesJson,
            }, { actor: timer });
          }
        }
        if (jobState === 'succeeded') {
          const rows = await sends.listWhere({ spaceId: current.spaceId, sourceKey: messageKey });
          if (rows[0] && rows[0].status === 'queued') {
            await sends.applyManaged(rows[0].id, { status: 'sent', decidedAt: nowIso }, { actor: timer });
          }
        }
        let cursor = current;
        try {
          const reread = await enrollments.get(current.id);
          if (reread && reread.status === 'active') cursor = reread;
        } catch {
          cursor = current;
        }
        await moveCursorPast({ current: cursor, ordered, step, nowIso, nowMs, completeWhenLast: false });
        summary.advanced += 1;
      } catch (error) {
        // One enrollment's gate failure, bad personalize output, or
        // transient queue failure stays with that enrollment: record it on
        // the summary and fire the next enrollment instead of aborting the
        // whole multi-space sweep and skipping the confirm pass behind it.
        noteSweepError(current, error, 'due');
        continue;
      }
    }
  }

  // 4. Confirm: re-queue every queued row (the outbox replays the stored
  // job with its current state) and record what the provider answered.
  // No provider is contacted here — the re-enqueue is a storage read.
  const queuedRows = [];
  for (const sequence of Array.isArray(rows) ? rows : []) {
    if (!sequence || typeof sequence !== 'object') continue;
    // One sequence's unreadable queued rows never skip the confirm rows
    // already collected or the later sequences: the throw is recorded and
    // the collection moves on.
    let pending;
    try {
      pending = await sends.listWhere({
        spaceId: /** @type {any} */ (sequence).spaceId,
        sequenceSourceKey: /** @type {any} */ (sequence).sourceKey, status: 'queued',
      });
    } catch (error) {
      noteSweepError(
        { sourceKey: '', spaceId: /** @type {any} */ (sequence).spaceId ?? '' },
        error,
        'confirm',
      );
      continue;
    }
    for (const row of Array.isArray(pending) ? pending : []) queuedRows.push(row);
  }
  for (const row of queuedRows) {
    // One broken confirm row never aborts the confirm pass: its failure is
    // recorded on the summary and the sweep confirms the next row instead.
    let enrollment = null;
    try {
      const enrollmentRows = await enrollments.listWhere({ spaceId: row.spaceId, sourceKey: row.enrollmentSourceKey });
      enrollment = enrollmentRows[0] ?? null;
      if (!enrollment || enrollment.status !== 'active') continue;
      const stepRows = await steps.listWhere({ spaceId: row.spaceId, sequenceSourceKey: row.sequenceSourceKey });
      const step = (Array.isArray(stepRows) ? stepRows : []).find((entry) => entry && entry.stepOrder === row.stepOrder) ?? null;
      if (!step) continue;
      let requeue = null;
      const confirmVariables = await resolveSendVariables(step, enrollment, row.variables ?? null);
      try {
        requeue = await queueTemplate({
          spaceId: enrollment.spaceId,
          connectionKey: enrollment.connectionKey,
          to: enrollment.recipient,
          template: {
            name: step.templateName,
            language: step.templateLanguage,
            variables: confirmVariables,
          },
          messageKey: row.messageKey,
          actor: timer,
        });
      } catch (error) {
        if (error && typeof error === 'object' && QUEUE_REFUSAL_SKIPS.has(/** @type {any} */ (error).code)) {
          // Terminal refusal on confirm: the connection died or the template
          // was revoked after queueing, so this row can never send. Move it
          // out of queued (dead-letter with the refusal code) instead of
          // leaving it queued forever — the enrollment then settles on the
          // next sweep like every other terminal row.
          const latest = await sends.listWhere({ spaceId: row.spaceId, sourceKey: row.sourceKey });
          if (latest[0] && latest[0].status === 'queued') {
            await sends.applyManaged(latest[0].id, {
              status: 'dead-letter', decidedAt: nowIso, detail: /** @type {any} */ (error).code,
            }, { actor: timer });
          }
          summary.skipped += 1;
          continue;
        }
        throw error;
      }
      const state = requeue && typeof requeue.state === 'string' ? requeue.state : '';
      const jobId = requeue && typeof requeue.jobId === 'string' ? requeue.jobId : row.jobId;
      if (state === 'succeeded') {
        const latest = await sends.listWhere({ spaceId: row.spaceId, sourceKey: row.sourceKey });
        if (latest[0] && latest[0].status === 'queued') {
          await sends.applyManaged(latest[0].id, { jobId, status: 'sent', decidedAt: nowIso }, { actor: timer });
          summary.confirmed += 1;
        }
        const siblings = await steps.listWhere({ spaceId: row.spaceId, sequenceSourceKey: row.sequenceSourceKey });
        const last = (Array.isArray(siblings) ? siblings : [])
          .filter((entry) => entry && Number.isInteger(entry.stepOrder))
          .sort((a, b) => b.stepOrder - a.stepOrder)[0] ?? null;
        if (last && row.stepOrder >= last.stepOrder) {
          const target = await enrollments.listWhere({ spaceId: row.spaceId, sourceKey: row.enrollmentSourceKey });
          if (target[0] && target[0].status === 'active') {
            await enrollments.applyManaged(target[0].id, { status: 'completed', decidedAt: nowIso }, { actor: timer });
          }
        }
      } else if (state === 'failed_terminal' || state === 'cancelled') {
        const latest = await sends.listWhere({ spaceId: row.spaceId, sourceKey: row.sourceKey });
        if (latest[0] && latest[0].status === 'queued') {
          await sends.applyManaged(latest[0].id, { jobId, status: 'dead-letter', decidedAt: nowIso }, { actor: timer });
        }
      }
    } catch (error) {
      noteSweepError(enrollment ?? { sourceKey: row.enrollmentSourceKey, spaceId: row.spaceId ?? '' }, error, 'confirm');
      continue;
    }
  }

  summary.inboxUnavailable = Object.freeze(summary.inboxUnavailable.map((entry) => Object.freeze({ ...entry })));
  summary.sweepErrors = Object.freeze(summary.sweepErrors.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ ...summary });
}

/** Fire instant of the current sweep (the re-read row may carry its own due instant). */
function fireMs(current, nowMs) {
  const due = Date.parse(current?.nextDueAt ?? '');
  return Number.isFinite(due) ? due : nowMs;
}

/**
 * Enroll one person in an active sequence. Idempotent by enrollment key: a
 * retry replays the stored enrollment. The first step is due at once, so a
 * same-day first step fires on the next advance.
 */
export async function enrollSequencePerson({ modules, input, at }) {
  const record = input && typeof input === 'object' ? input : {};
  const actor = requireSequenceActor(record.actor, 'Enrolling a person in a sequence');
  const spaceId = checkSpaceId(record.spaceId);
  const sequenceSourceKey = boundedLine(record.sequenceSourceKey ?? '', 'sequenceSourceKey');
  const subject = record.subject && typeof record.subject === 'object' ? record.subject : {};
  const subjectResource = boundedLine(subject.resource ?? '', 'subjectResource', 64);
  const subjectId = boundedLine(subject.id ?? '', 'subjectId');
  const subjectLabel = typeof record.subjectLabel === 'string' && record.subjectLabel !== ''
    ? boundedLine(record.subjectLabel, 'subjectLabel') : subjectId;
  const recipient = boundedLine(record.recipient ?? '', 'recipient');
  const connectionKey = boundedLine(record.connectionKey ?? '', 'connectionKey');
  let vars = {};
  if (record.vars !== undefined && record.vars !== null) {
    if (typeof record.vars !== 'object' || Array.isArray(record.vars)) {
      throw new ValidationError('vars must be an object of strings', { field: 'vars' });
    }
    for (const [key, value] of Object.entries(record.vars)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 1024) {
        throw new ValidationError('vars must map names to bounded strings', { field: 'vars' });
      }
      vars[key] = value;
    }
  }
  // Space-scoped by construction: the same sequence key and subject in two
  // spaces enroll under different identities, so neither space can block or
  // read the other's enrollment through the global sourceKey uniqueness.
  const key = sequenceKey('seq-enroll', spaceId, sequenceSourceKey, subjectResource, subjectId);
  const sequences = trusted(modules, 'sequence');
  const found = await sequences.listWhere({ spaceId, sourceKey: sequenceSourceKey });
  const sequence = found[0] ?? null;
  if (!sequence) {
    throw new AppError('Unknown sequence in this space', { code: 'SEQUENCE_UNKNOWN', status: 404 });
  }
  if (sequence.status !== 'active') {
    throw new AppError(`Sequence is ${sequence.status}: enrollment needs an active sequence`, {
      code: 'SEQUENCE_NOT_ACTIVE', status: 409,
    });
  }
  const enrollments = trusted(modules, 'sequence-enrollment');
  const atIso = checkInstant(at ?? new Date().toISOString(), 'at');
  const existing = await enrollments.listWhere({ spaceId, sourceKey: key });
  if (existing[0]) return { enrollment: existing[0], replayed: true };
  const row = {
    sourceKey: key,
    sequenceSourceKey,
    spaceId,
    subjectResource,
    subjectId,
    subjectLabel,
    recipient,
    connectionKey,
    vars: JSON.stringify(vars),
    status: 'active',
    currentStep: 0,
    nextDueAt: atIso,
    enrolledAt: atIso,
    decidedAt: atIso,
    actorType: actor.type,
    actorId: actor.id,
    sourcePackage: SEQUENCES_DOMAIN_REF,
    sourceAction: 'enroll-sequence-person',
  };
  try {
    const enrollment = await enrollments.createManaged(row, { actor });
    return { enrollment, replayed: false };
  } catch (error) {
    if (!isWinnerConflict(error)) throw error;
    const winner = await enrollments.listWhere({ spaceId, sourceKey: key });
    if (!winner[0]) throw error;
    return { enrollment: winner[0], replayed: true };
  }
}

/** Move one sequence row through its lifecycle, re-reading the state first. */
export async function transitionSequence({ sequences, sequence, event, at, actor }) {
  assertSequenceTransition(sequence.status, event);
  const target = event === 'activate' || event === 'resume' ? 'active' : 'paused';
  let current = sequence;
  try {
    const reread = await sequences.listWhere({ spaceId: sequence.spaceId, sourceKey: sequence.sourceKey });
    if (reread[0]) current = reread[0];
  } catch {
    current = sequence;
  }
  assertSequenceTransition(current.status, event);
  await sequences.applyManaged(current.id, { status: target, decidedAt: at }, { actor });
  const rows = await sequences.listWhere({ spaceId: sequence.spaceId, sourceKey: sequence.sourceKey });
  return { sequence: rows[0] ?? { ...current, status: target }, event };
}

/**
 * Move one enrollment through its lifecycle, re-reading the state first —
 * the same pattern as every appointment advance. `resumeNow` makes an
 * overdue step due at resume instead of waiting for a stored instant that
 * already passed; steps already queued or sent still never fire twice.
 */
export async function transitionEnrollment({ enrollments, enrollment, event, at, actor, resumeNow = false, spaceId = null }) {
  assertEnrollmentTransition(enrollment.status, event);
  let current = enrollment;
  try {
    const reread = await enrollments.listWhere(
      spaceId === null ? { sourceKey: enrollment.sourceKey } : { spaceId, sourceKey: enrollment.sourceKey },
    );
    if (reread[0]) current = reread[0];
  } catch {
    current = enrollment;
  }
  assertEnrollmentTransition(current.status, event);
  const target = event === 'pause' ? 'paused'
    : event === 'resume' ? 'active'
      : event === 'stop-replied' ? 'stopped-replied' : 'completed';
  const patch = { status: target, decidedAt: at };
  if (event === 'resume' && resumeNow) {
    const due = Date.parse(current.nextDueAt ?? '');
    if (!Number.isFinite(due) || due < Date.parse(at)) patch.nextDueAt = at;
  }
  await enrollments.applyManaged(current.id, patch, { actor });
  const knownSpace = spaceId ?? enrollment.spaceId ?? current.spaceId ?? null;
  const rows = await enrollments.listWhere(
    knownSpace === null ? { sourceKey: enrollment.sourceKey } : { spaceId: knownSpace, sourceKey: enrollment.sourceKey },
  );
  return { enrollment: rows[0] ?? { ...current, ...patch }, event };
}

/**
 * `activate` — the only way a sequence starts (or restarts) sending.
 *
 * `fromStates: ['draft', 'paused']` is the transition table, enforced by the
 * action runtime before this code runs: any other state answers `409` naming
 * the state it is in. The write itself goes through `transitionSequence`,
 * which re-reads the row inside the transaction first, so a decision taken
 * on a stale screen cannot silently win over a newer one. `confirm: true`
 * marks it for the backoffice: starting a sequence sends messages to real
 * people, so the screen asks twice.
 */
export function buildActivateSequenceAction() {
  return {
    module: 'sequence',
    name: 'activate',
    label: 'Activate sequence',
    description: 'Start a draft or paused sequence: due steps may queue sends. A human decision; it notifies nobody by itself.',
    actionContract: 1,
    confirm: true,
    stateField: 'status',
    fromStates: ['draft', 'paused'],
    toState: 'active',
    async execute({ record, actor, modules, now }) {
      const who = requireSequenceActor(actor, 'Activating a sequence');
      const sequences = trusted(modules, 'sequence');
      const present = await trusted(modules, 'sequence-step')
        .listWhere({ spaceId: record.spaceId, sequenceSourceKey: record.sourceKey });
      if (!present.some((row) => row && Number.isInteger(row.stepOrder))) {
        throw new AppError('Cannot activate a sequence with no steps', {
          code: 'SEQUENCE_NO_STEPS', status: 409,
        });
      }
      return transitionSequence({ sequences, sequence: record, event: 'activate', at: now(), actor: who });
    },
  };
}

/**
 * `pause` — the only way an active sequence stops firing.
 *
 * A paused sequence fires nothing and a resume re-fires only steps with no
 * send row, so pausing can never double-send on resume. Same double-ask as
 * the activation: stopping a sequence in front of a customer is a decision
 * the screen confirms.
 */
export function buildPauseSequenceAction() {
  return {
    module: 'sequence',
    name: 'pause',
    label: 'Pause sequence',
    description: 'Stop an active sequence from firing. Steps already queued or sent are untouched; resume re-fires only steps with no send row.',
    actionContract: 1,
    confirm: true,
    stateField: 'status',
    fromStates: ['active'],
    toState: 'paused',
    async execute({ record, actor, modules, now }) {
      const who = requireSequenceActor(actor, 'Pausing a sequence');
      const sequences = trusted(modules, 'sequence');
      return transitionSequence({ sequences, sequence: record, event: 'pause', at: now(), actor: who });
    },
  };
}