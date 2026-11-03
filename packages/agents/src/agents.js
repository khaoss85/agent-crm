// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * Teammate agents — the automation engine (backlog:8986f4459f0f).
 *
 * Pure domain logic over managed record services. No provider is contacted
 * and no secret is resolved here: an execution calls the
 * composition-provided `execute` seam (the worker/AI side), and an approved
 * proposal reaches production only through the composition-provided
 * `applyAction` seam (the governed write path — MEM_ACC_REUSE: no duplicate
 * of channels, work or commercial writes, the deployment wires their
 * operations there). No import from any other domain package.
 *
 * Four invariants, one per acceptance criterion:
 *
 * 1. **Phrase to schedule, never a guess.** An assignment is created from a
 *    human phrase plus an explicit plan (the fake-AI seam the tests use) or
 *    from the built-in Italian parser. A phrase the parser cannot place
 *    refuses with `AGENT_PHRASE_UNCLEAR` — no silent default cadence.
 * 2. **Approval before writes.** An execution that proposes actions stores
 *    the proposals and waits: nothing is applied until a human approves, and
 *    approval needs an identified human actor (plus the space permission
 *    gate when the deployment provides one). The artifact path stores a
 *    versioned artifact instead and needs no approval.
 * 3. **Spending cap.** The agent's monthly cap (cents, calendar month) is
 *    checked before the execute seam runs: over the cap the run is recorded
 *    as `capped`, says so in its note, costs nothing and never executes.
 * 4. **Every run recorded.** Due, capped, failed, proposed, applied and
 *    artifact runs are all rows with agent, assignment, cost and outcome —
 *    counts are computed from rows, never stored.
 */

export const AGENT_STATES = Object.freeze(['active', 'paused']);
export const ASSIGNMENT_STATES = Object.freeze(['active', 'paused', 'completed']);
export const ASSIGNMENT_TERMINAL = Object.freeze(['completed']);
export const RUN_OUTCOMES = Object.freeze(['proposed', 'applied', 'artifact', 'capped', 'failed']);
export const CADENCES = Object.freeze(['daily', 'weekly', 'monthly', 'once']);

export const AGENTS_DOMAIN = 'agents';

/** The permission an approval checks when the deployment provides the gate. */
export const AGENT_APPLY_PERMISSION = 'agent-action-apply';

export const AGENT_TIMER_ACTOR = Object.freeze({ type: 'system', id: 'agent-sweep' });

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = Object.freeze({
  // Both accented and unaccented Italian forms; lookup runs on a normalized phrase.
  'lunedi': 1, 'martedi': 2, 'mercoledi': 3, 'giovedi': 4,
  'venerdi': 5, 'sabato': 6, 'domenica': 0,
});

/** @param {unknown} value @param {string} field @param {number} max */
function boundedLine(value, field, max = 1024) {
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
export function requireAgentActor(actor, what) {
  if (!actor || typeof actor !== 'object'
    || typeof /** @type {any} */ (actor).type !== 'string' || /** @type {any} */ (actor).type.trim() === ''
    || typeof /** @type {any} */ (actor).id !== 'string' || /** @type {any} */ (actor).id.trim() === '') {
    throw new AppError(`${what} requires an identified actor`, { code: 'AGENT_ACTOR_REQUIRED', status: 403 });
  }
  return { type: /** @type {any} */ (actor).type.trim(), id: /** @type {any} */ (actor).id.trim() };
}

/** Approvals are human: the timer and other agents never approve. @param {{type:string,id:string}} actor */
export function requireHumanActor(actor, what) {
  if (actor.type !== 'user') {
    throw new AppError(`${what} requires a human approver`, { code: 'AGENT_APPROVAL_FORBIDDEN', status: 403 });
  }
  return actor;
}

/** @param {unknown} value @param {string} field */
function checkRecordKey(value, field) {
  return boundedLine(value, field, 256);
}

/** @param {unknown} value @param {string} field */
function checkInstant(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${field} must be a canonical instant`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function checkCostCents(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new ValidationError(`${field} must be an integer number of cents from 0 to 1000000000`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function checkInstructions(value, field) {
  return boundedLine(value, field, 4000);
}

/** First day of the UTC month of `nowIso`, as an instant. @param {string} nowIso */
export function monthStartIso(nowIso) {
  const ms = Date.parse(checkInstant(nowIso, 'now'));
  const date = new Date(ms);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

/**
 * Validate an explicit schedule plan (the fake-AI seam): the machine shape a
 * phrase becomes. `weekday` is ISO (1 Monday … 7 Sunday) for weekly;
 * `timeOfDay` is HH:MM; `runAt` is the single instant for once.
 * @param {unknown} plan
 */
export function checkSchedulePlan(plan) {
  const record = plan && typeof plan === 'object' ? plan : {};
  const cadence = /** @type {any} */ (record).cadence;
  if (!CADENCES.includes(cadence)) {
    throw new ValidationError('plan cadence must be one of daily, weekly, monthly, once', { field: 'plan.cadence' });
  }
  let weekday = null;
  if (cadence === 'weekly') {
    weekday = /** @type {any} */ (record).weekday;
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new ValidationError('a weekly plan needs weekday 1 (Monday) to 7 (Sunday)', { field: 'plan.weekday' });
    }
  }
  let timeOfDay = null;
  const rawTime = /** @type {any} */ (record).timeOfDay;
  if (rawTime !== undefined && rawTime !== null) {
    if (typeof rawTime !== 'string' || !TIME_RE.test(rawTime)) {
      throw new ValidationError('plan timeOfDay must be HH:MM', { field: 'plan.timeOfDay' });
    }
    timeOfDay = rawTime;
  }
  let runAt = null;
  if (cadence === 'once') {
    runAt = checkInstant(/** @type {any} */ (record).runAt, 'plan.runAt');
  }
  return { cadence, weekday, timeOfDay: timeOfDay ?? '08:00', runAt };
}

/** Strip accents and lowercase for weekday matching. @param {string} text */
function foldItalian(text) {
  return text.toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

function findWeekday(folded) {
  for (const [name, day] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(folded)) return day === 0 ? 7 : day;
  }
  return null;
}

/**
 * The built-in Italian phrase parser: turns «ogni lunedì il report
 * vendite» into a weekly plan. Covers daily, weekly (named day or plain
 * «ogni settimana»), monthly and once. Anything else refuses with
 * `AGENT_PHRASE_UNCLEAR` — the caller passes an explicit plan instead.
 * @param {unknown} phrase @param {string} nowIso
 */
export function parsePhraseSchedule(phrase, nowIso) {
  const text = boundedLine(phrase, 'phrase', 280);
  checkInstant(nowIso, 'now');
  const folded = foldItalian(text);
  if (/\buna\s+tantum\b|\buna\s+volta\b|\bsubito\b|\badesso\b/.test(folded)) {
    return { cadence: 'once', weekday: null, timeOfDay: '08:00', runAt: nowIso };
  }
  if (/\bogni\s+mese\b|\bmensile\b|\bogni\s+primo\s+del\s+mese\b/.test(folded)) {
    return { cadence: 'monthly', weekday: null, timeOfDay: '08:00', runAt: null };
  }
  const weekday = findWeekday(folded);
  if (weekday !== null) {
    return { cadence: 'weekly', weekday, timeOfDay: '08:00', runAt: null };
  }
  if (/\bogni\s+settimana\b|\bsettimanale\b/.test(folded)) {
    const day = new Date(Date.parse(nowIso)).getUTCDay();
    return { cadence: 'weekly', weekday: day === 0 ? 7 : day, timeOfDay: '08:00', runAt: null };
  }
  if (/\bogni\s+giorno\b|\bquotidiano\b|\bogni\s+mattina\b|\btutti\s+i\s+giorni\b/.test(folded)) {
    return { cadence: 'daily', weekday: null, timeOfDay: '08:00', runAt: null };
  }
  throw new AppError('This phrase does not name a schedule: pass an explicit plan', {
    code: 'AGENT_PHRASE_UNCLEAR', status: 422,
  });
}

function atTimeOfDay(date, timeOfDay) {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hh, mm)).toISOString();
}

/**
 * The next run after `fromIso` for a schedule. Weekly `weekday` is ISO
 * (1 Monday … 7 Sunday); a time that already passed today moves to the next
 * matching day. @param {{cadence:string,weekday:number|null,timeOfDay:string,runAt:string|null}} schedule
 */
export function computeNextRun(schedule, fromIso) {
  const fromMs = Date.parse(checkInstant(fromIso, 'from'));
  const from = new Date(fromMs);
  if (schedule.cadence === 'once') {
    if (!schedule.runAt) throw new ValidationError('a once schedule needs runAt', { field: 'runAt' });
    return schedule.runAt;
  }
  if (schedule.cadence === 'daily') {
    const today = atTimeOfDay(from, schedule.timeOfDay);
    if (Date.parse(today) > fromMs) return today;
    return new Date(Date.parse(today) + DAY_MS).toISOString();
  }
  if (schedule.cadence === 'weekly') {
    const target = schedule.weekday ?? 1;
    const current = from.getUTCDay() === 0 ? 7 : from.getUTCDay();
    let delta = (target - current + 7) % 7;
    const candidate = new Date(Date.parse(atTimeOfDay(from, schedule.timeOfDay)) + delta * DAY_MS).toISOString();
    if (Date.parse(candidate) > fromMs) return candidate;
    return new Date(Date.parse(candidate) + 7 * DAY_MS).toISOString();
  }
  // monthly: same day next month (clamped to the month's last day), same time.
  const [hh, mm] = schedule.timeOfDay.split(':').map(Number);
  const day = from.getUTCDate();
  const sameMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, hh, mm));
  if (sameMonth.getUTCMonth() === from.getUTCMonth() && sameMonth.getTime() > fromMs) {
    return sameMonth.toISOString();
  }
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, hh, mm));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(day, lastDay), hh, mm)).toISOString();
}

/** Explicit transition tables — terminal states never regress. */
function assertTransition(kind, from, event, allowed) {
  const states = allowed[event];
  if (!states || !states.includes(from)) {
    throw new AppError(`${kind} cannot ${event} from ${from}`, { code: 'AGENT_TRANSITION_INVALID', status: 409 });
  }
}

export function assertAgentTransition(from, event) {
  assertTransition('Agent', from, event, { pause: ['active'], resume: ['paused'] });
}

export function assertAssignmentTransition(from, event) {
  assertTransition('Assignment', from, event, {
    pause: ['active'], resume: ['paused'], complete: ['active', 'paused'],
  });
}

export function assertRunTransition(from, event) {
  assertTransition('Run', from, event, { approve: ['proposed'] });
}

/** Deterministic run identity: a retry of the same due instant replays the stored run. */
export function agentRunKey(assignmentSourceKey, startedAt) {
  return `run:${assignmentSourceKey}:${startedAt}`;
}

/** @param {Array<{startedAt?:string,costCents?:number,outcome?:string}>} runs */
export function spentSince(runs, monthStart) {
  const startMs = Date.parse(monthStart);
  let total = 0;
  for (const run of runs ?? []) {
    if (!run || typeof run !== 'object') continue;
    const at = typeof run.startedAt === 'string' ? Date.parse(run.startedAt) : NaN;
    if (!Number.isFinite(at) || at < startMs) continue;
    if (typeof run.costCents === 'number' && Number.isFinite(run.costCents) && run.costCents > 0) {
      total += run.costCents;
    }
  }
  return total;
}

/**
 * Validate one action proposal: a bounded action key plus a bounded JSON
 * payload. Proposals are data, never functions — approval executes them
 * through the `applyAction` seam. @param {unknown} proposal
 */
export function checkProposal(proposal) {
  const record = proposal && typeof proposal === 'object' ? proposal : {};
  const action = boundedLine(/** @type {any} */ (record).action ?? '', 'proposal.action', 128);
  const payload = /** @type {any} */ (record).payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('proposal payload must be a JSON object', { field: 'proposal.payload' });
  }
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new ValidationError('proposal payload must be JSON-encodable', { field: 'proposal.payload' });
  }
  if (encoded.length > 8192) {
    throw new ValidationError('proposal payload must fit 8 KiB of JSON', { field: 'proposal.payload' });
  }
  return { action, payload };
}

/**
 * Validate an execution result from the `execute` seam: either proposals
 * waiting for approval, or a versioned artifact. Anything else refuses —
 * an execution that is neither is not recorded as a success.
 * @param {unknown} result
 */
export function checkExecuteResult(result) {
  const record = result && typeof result === 'object' ? result : {};
  const kind = /** @type {any} */ (record).kind;
  const costCents = checkCostCents(/** @type {any} */ (record).costCents ?? 0, 'result.costCents') ?? 0;
  if (kind === 'proposals') {
    const raw = /** @type {any} */ (record).proposals;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 25) {
      throw new ValidationError('a proposals result carries 1 to 25 proposals', { field: 'result.proposals' });
    }
    return { kind, proposals: raw.map(checkProposal), costCents };
  }
  if (kind === 'artifact') {
    const artifact = /** @type {any} */ (record).artifact ?? {};
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new ValidationError('an artifact result carries a JSON object', { field: 'result.artifact' });
    }
    let encoded;
    try {
      encoded = JSON.stringify(artifact);
    } catch {
      throw new ValidationError('artifact must be JSON-encodable', { field: 'result.artifact' });
    }
    if (encoded.length === 0 || encoded.length > 32768) {
      throw new ValidationError('artifact must fit 32 KiB of JSON', { field: 'result.artifact' });
    }
    return { kind, artifact, costCents };
  }
  throw new ValidationError("an execution result is either { kind: 'proposals' } or { kind: 'artifact' }", {
    field: 'result.kind',
  });
}

/** Validate the agent create input. */
export function checkAgentInput(record) {
  const input = record && typeof record === 'object' ? record : {};
  return {
    spaceId: checkSpaceId(input.spaceId),
    sourceKey: checkRecordKey(input.sourceKey, 'sourceKey'),
    name: boundedLine(input.name, 'name', 120),
    role: boundedLine(input.role, 'role', 120),
    instructions: checkInstructions(input.instructions, 'instructions'),
    spendingCapCents: checkCostCents(input.spendingCapCents, 'spendingCapCents'),
  };
}

/** Validate the assignment create input. */
export function checkAssignmentInput(record) {
  const input = record && typeof record === 'object' ? record : {};
  const costPerRunCents = checkCostCents(input.costPerRunCents, 'costPerRunCents') ?? 0;
  return {
    spaceId: checkSpaceId(input.spaceId),
    sourceKey: checkRecordKey(input.sourceKey, 'sourceKey'),
    agentSourceKey: checkRecordKey(input.agentSourceKey, 'agentSourceKey'),
    phrase: boundedLine(input.phrase, 'phrase', 280),
    costPerRunCents,
  };
}
