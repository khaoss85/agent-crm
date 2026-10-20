// @ts-check

import { AppError, ConflictError, ValidationError, nowIso, requireActor } from '../../core/index.js';

/**
 * Call intelligence (BO-F1-08, backlog:588db7766206): the start-of-call
 * notice, the transcript, its AI summary and its buying signals.
 *
 * Owner decision Q-G2 (19/10): a notice at the start of the call is enough —
 * the notice is recorded before any audio or text is saved, and the
 * transcript is kept 12 months, then erased (per-space configurable). The
 * transcript and the signals live in `packages/intelligence` and the summary
 * and the signals come from the workspace LLM adapter.
 *
 * What it reuses, not duplicates (MEM_ACC_REUSE): the call itself stays the
 * interactions package's `interaction-call` row (named here by its
 * `callRef`); the customer stays the host contact or company, named by the
 * opaque subject envelope like appointments does — never copied, never a
 * new master table; spend caps, audit and the adapter contract stay the
 * llm package's `llm-complete` handle, handed over at composition like
 * channels does (never re-instantiated here). The lead-scoped
 * `behavioral-signal` is deliberately NOT reused: a call signal is scoped
 * to a call and cites its transcript, a different subject with different
 * source semantics.
 *
 * Storage: three managed record modules, created only here —
 * `call-notice` (append-only), `call-transcript` (summary added once by the
 * summarize step, text wiped by the purge), `call-signal` (append-only,
 * immutable). No public create/update exists on any of them.
 *
 * Retention erasure wipes the personal data (text and summary become null,
 * `purgedAt` is stamped) instead of deleting the row, so the retention
 * proof survives the erasure. The framework's storage has no row delete,
 * and an erasure that leaves no trace cannot be audited.
 */

export const CALL_INTELLIGENCE_MODULES = Object.freeze(['call-notice', 'call-transcript', 'call-signal']);

/** Q-G2 default: a transcript lives 12 months, then the purge erases it. */
export const CALL_TRANSCRIPT_DEFAULT_RETENTION_MONTHS = 12;
export const CALL_TRANSCRIPT_MIN_RETENTION_MONTHS = 1;
export const CALL_TRANSCRIPT_MAX_RETENTION_MONTHS = 120;

export const CALL_SIGNAL_TYPES = Object.freeze(['budget', 'timing', 'interest', 'doubt']);
export const CALL_SUBJECT_RESOURCES = Object.freeze(['contact', 'company']);

const SPACE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const CALL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_TRANSCRIPT_CHARS = 30000;
const MAX_SUMMARY_CHARS = 2000;
const MAX_EXCERPT_CHARS = 500;
const MAX_SIGNALS_PER_CALL = 20;
const MAX_CALLS_READ = 50;

/**
 * @param {unknown} value @param {string} field
 */
function assertSpaceId(value, field = 'spaceId') {
  if (typeof value !== 'string' || !SPACE_ID_RE.test(value)) {
    throw new ValidationError(`${field} must be a lowercase slug (letters, digits, hyphens, starting with a letter, at most 63 characters)`, { field });
  }
  return value;
}

/**
 * @param {unknown} value @param {string} field
 */
function assertCallRef(value, field = 'callRef') {
  if (typeof value !== 'string' || !CALL_REF_RE.test(value)) {
    throw new ValidationError(`${field} must be a bounded record reference (letters, digits, :, _, -, at most 128 characters)`, { field });
  }
  return value;
}

/**
 * @param {unknown} value @param {string} field
 */
function assertSubjectResource(value, field = 'subjectResource') {
  if (typeof value !== 'string' || !CALL_SUBJECT_RESOURCES.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${CALL_SUBJECT_RESOURCES.join(', ')}`, { field });
  }
  return value;
}

/**
 * @param {unknown} value @param {string} field
 */
function assertSubjectId(value, field = 'subjectId') {
  if (typeof value !== 'string' || !CALL_REF_RE.test(value)) {
    throw new ValidationError(`${field} must be a bounded record reference (at most 128 characters)`, { field });
  }
  return value;
}

/**
 * @param {unknown} value @param {string} field
 */
function assertChannel(value, field = 'channel') {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw new ValidationError(`${field} is required (at most 64 characters)`, { field });
  }
  return value.trim();
}

/**
 * @param {unknown} value @param {string} field
 */
function assertIsoDate(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

/**
 * Calendar months from an instant, in UTC: the retention deadline of a
 * transcript recorded on 2026-10-20 with 12 months is 2027-10-20, not
 * 365 days later. End-of-month clamping follows the Date constructor
 * (Jan 31 + 1 month reads back as Mar 2/3): the deadline never moves
 * earlier than the same day, it only ever lands later, so erasure is
 * never early.
 * @param {string} iso
 * @param {number} months
 */
export function addMonthsUtc(iso, months) {
  const date = new Date(iso);
  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  )).toISOString();
}

/**
 * @param {Map<string, any>} modules @param {string} name
 */
function trusted(modules, name) {
  const entry = modules?.get?.(name);
  const service = entry?.service ?? entry;
  if (!service || typeof service.createManaged !== 'function' || typeof service.listWhere !== 'function') {
    throw new AppError(`call intelligence needs the ${name} record service`, {
      code: 'CALL_STORE_MISSING', status: 500,
    });
  }
  return service;
}

/**
 * @param {{
 *   modules: Map<string, any>,
 *   llm?: { complete: (request: any) => Promise<any> } | null,
 *   retention?: { defaultMonths?: number, bySpace?: Record<string, number> },
 *   now?: () => string,
 * }} options
 * `modules` is the runtime's module view (the same Map shape channels
 * tests build); `llm` is the opened `llm-complete@1` handle handed over at
 * composition — absent is fine until a call asks for an AI summary, which
 * refuses then, never at boot. `retention` carries the per-space
 * transcript lifetime in months (Q-G2, configurable per space); spaces
 * without an entry keep the 12-month default.
 */
export function createCallIntelligence(options = {}) {
  const modules = options.modules;
  const llm = options.llm ?? null;
  const clock = typeof options.now === 'function' ? options.now : () => nowIso();
  const retention = options.retention ?? {};
  const defaultMonths = retention.defaultMonths ?? CALL_TRANSCRIPT_DEFAULT_RETENTION_MONTHS;
  if (!Number.isInteger(defaultMonths)
    || defaultMonths < CALL_TRANSCRIPT_MIN_RETENTION_MONTHS
    || defaultMonths > CALL_TRANSCRIPT_MAX_RETENTION_MONTHS) {
    throw new ValidationError(`retention.defaultMonths must be an integer ${CALL_TRANSCRIPT_MIN_RETENTION_MONTHS}-${CALL_TRANSCRIPT_MAX_RETENTION_MONTHS}`, { field: 'retention.defaultMonths' });
  }
  const bySpace = retention.bySpace ?? {};
  if (!bySpace || typeof bySpace !== 'object' || Array.isArray(bySpace)) {
    throw new ValidationError('retention.bySpace must be a plain object', { field: 'retention.bySpace' });
  }

  /**
   * @param {string} spaceId
   */
  function monthsFor(spaceId) {
    const configured = Object.hasOwn(bySpace, spaceId) ? bySpace[spaceId] : defaultMonths;
    if (!Number.isInteger(configured)
      || configured < CALL_TRANSCRIPT_MIN_RETENTION_MONTHS
      || configured > CALL_TRANSCRIPT_MAX_RETENTION_MONTHS) {
      throw new ValidationError(`retention for space "${spaceId}" must be an integer ${CALL_TRANSCRIPT_MIN_RETENTION_MONTHS}-${CALL_TRANSCRIPT_MAX_RETENTION_MONTHS} months`, { field: 'retention.bySpace' });
    }
    return configured;
  }

  /**
   * @param {string} spaceId @param {string} callRef
   */
  async function findNotice(spaceId, callRef) {
    const rows = await trusted(modules, 'call-notice').listWhere({ spaceId, callRef });
    return rows[0] ?? null;
  }

  /**
   * @param {string} spaceId @param {string} callRef
   */
  async function findTranscript(spaceId, callRef) {
    const rows = await trusted(modules, 'call-transcript').listWhere({ spaceId, callRef });
    return rows[0] ?? null;
  }

  /**
   * Record the start-of-call notice (Q-G2 avviso): without this row the
   * call's audio or text cannot be saved. A repeated notice for the same
   * call resolves identically; a notice that names a different customer
   * or channel for the same call is refused.
   */
  async function recordCallNotice(input = {}) {
    const actor = requireActor(input.actor);
    const spaceId = assertSpaceId(input.spaceId);
    const subjectResource = assertSubjectResource(input.subjectResource);
    const subjectId = assertSubjectId(input.subjectId);
    const callRef = assertCallRef(input.callRef);
    const channel = assertChannel(input.channel);
    const noticedAt = input.noticedAt === undefined ? clock() : assertIsoDate(input.noticedAt, 'noticedAt');

    const existing = await findNotice(spaceId, callRef);
    if (existing) {
      if (existing.subjectResource !== subjectResource || existing.subjectId !== subjectId
        || existing.channel !== channel) {
        throw new AppError('A notice for this call names a different customer or channel', {
          code: 'CALL_NOTICE_CONFLICT', status: 409,
        });
      }
      return { notice: existing, replayed: true };
    }
    const notice = await trusted(modules, 'call-notice').createManaged({
      sourceKey: `call-notice:${spaceId}:${callRef}`,
      spaceId, subjectResource, subjectId, callRef, channel, noticedAt,
      actorType: actor.type, actorId: actor.id,
    }, { actor });
    return { notice, replayed: false };
  }

  /**
   * Save the call transcript. Refused with CALL_NOTICE_MISSING when no
   * start-of-call notice is on file — neither audio nor text is stored
   * before the notice, and the refusal writes nothing.
   */
  async function saveCallTranscript(input = {}) {
    const actor = requireActor(input.actor);
    const spaceId = assertSpaceId(input.spaceId);
    const subjectResource = assertSubjectResource(input.subjectResource);
    const subjectId = assertSubjectId(input.subjectId);
    const callRef = assertCallRef(input.callRef);
    const recordedAt = input.recordedAt === undefined ? clock() : assertIsoDate(input.recordedAt, 'recordedAt');
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new ValidationError('text is required', { field: 'text' });
    }
    if (input.text.length > MAX_TRANSCRIPT_CHARS) {
      throw new ValidationError(`text must be at most ${MAX_TRANSCRIPT_CHARS} characters: longer calls are summarized in bounded parts, never truncated silently`, { field: 'text' });
    }
    const text = input.text;

    const notice = await findNotice(spaceId, callRef);
    if (!notice) {
      throw new AppError('No start-of-call notice is recorded for this call: nothing is saved', {
        code: 'CALL_NOTICE_MISSING', status: 409,
      });
    }
    if (notice.subjectResource !== subjectResource || notice.subjectId !== subjectId) {
      throw new AppError('This transcript names a different customer than the recorded notice', {
        code: 'CALL_SUBJECT_MISMATCH', status: 409,
      });
    }
    const existing = await findTranscript(spaceId, callRef);
    if (existing) {
      if (existing.text === text) return { transcript: existing, replayed: true };
      throw new AppError('A transcript for this call is already saved with different text', {
        code: 'CALL_TRANSCRIPT_CONFLICT', status: 409,
      });
    }
    const transcript = await trusted(modules, 'call-transcript').createManaged({
      sourceKey: `call-transcript:${spaceId}:${callRef}`,
      spaceId, subjectResource, subjectId, callRef, text, recordedAt,
      expiresAt: addMonthsUtc(recordedAt, monthsFor(spaceId)),
      actorType: actor.type, actorId: actor.id,
    }, { actor });
    return { transcript, replayed: false };
  }

  /**
   * Parse the LLM's bounded extraction answer fail-closed: valid JSON with
   * a bounded summary and bounded signal excerpts quoted word for word
   * from the transcript. Anything else is CALL_SUMMARY_INVALID — a signal
   * never cites text the transcript does not contain.
   * @param {unknown} answer @param {string} transcriptText
   */
  function parseSummaryAnswer(answer, transcriptText) {
    let parsed;
    try {
      parsed = JSON.parse(String(answer?.text ?? ''));
    } catch {
      throw new AppError('The summary answer is not valid JSON', { code: 'CALL_SUMMARY_INVALID', status: 502 });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('The summary answer must be a JSON object', { code: 'CALL_SUMMARY_INVALID', status: 502 });
    }
    const summary = parsed.summary;
    if (typeof summary !== 'string' || summary.trim() === '' || summary.length > MAX_SUMMARY_CHARS) {
      throw new AppError(`The summary must be 1-${MAX_SUMMARY_CHARS} characters`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
    }
    const rawSignals = parsed.signals ?? [];
    if (!Array.isArray(rawSignals) || rawSignals.length > MAX_SIGNALS_PER_CALL) {
      throw new AppError(`The signals must be an array of at most ${MAX_SIGNALS_PER_CALL}`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
    }
    const signals = rawSignals.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AppError(`Signal ${index} must be an object`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
      }
      if (!CALL_SIGNAL_TYPES.includes(entry.type)) {
        throw new AppError(`Signal ${index} must be one of: ${CALL_SIGNAL_TYPES.join(', ')}`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
      }
      if (typeof entry.excerpt !== 'string' || entry.excerpt.trim() === ''
        || entry.excerpt.length > MAX_EXCERPT_CHARS) {
        throw new AppError(`Signal ${index} excerpt must be 1-${MAX_EXCERPT_CHARS} characters`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
      }
      if (!transcriptText.includes(entry.excerpt)) {
        throw new AppError(`Signal ${index} quotes text the transcript does not contain`, { code: 'CALL_SUMMARY_INVALID', status: 502 });
      }
      return { type: entry.type, excerpt: entry.excerpt };
    });
    return { summary, signals };
  }

  /**
   * Summarize a call with the workspace LLM adapter and store the buying
   * signals, each citing the transcript it was read from. Once summarized,
   * a call replays its stored summary without spending again; a purged
   * transcript cannot be summarized anymore.
   */
  async function summarizeCall(input = {}) {
    const actor = requireActor(input.actor);
    const spaceId = assertSpaceId(input.spaceId);
    const callRef = assertCallRef(input.callRef);

    const transcript = await findTranscript(spaceId, callRef);
    if (!transcript) {
      throw new AppError('Unknown call transcript', { code: 'CALL_TRANSCRIPT_UNKNOWN', status: 404 });
    }
    if (transcript.purgedAt) {
      throw new AppError('This transcript was erased by retention and cannot be summarized', {
        code: 'CALL_TRANSCRIPT_PURGED', status: 404,
      });
    }
    const storedSignals = await trusted(modules, 'call-signal').listWhere({ spaceId, callRef });
    if (transcript.summary) {
      return {
        summary: transcript.summary,
        signals: storedSignals.map((row) => ({ type: row.signalType, excerpt: row.excerpt })),
        replayed: true,
      };
    }
    if (!llm || typeof llm.complete !== 'function') {
      throw new AppError('No language model is composed for this space: the call cannot be summarized', {
        code: 'CALL_SUMMARY_UNAVAILABLE', status: 409,
      });
    }
    const completion = await llm.complete({
      actor,
      spaceId,
      purpose: 'call-summary',
      messages: [
        {
          role: 'system',
          content: 'Summarize the call transcript that follows for a salesperson. Answer with JSON only, exactly {"summary": string, "signals": [{"type": "budget"|"timing"|"interest"|"doubt", "excerpt": string}]}. The summary is at most 2000 characters. Every excerpt quotes the transcript word for word.',
        },
        { role: 'user', content: transcript.text },
      ],
      maxTokens: 2048,
    });
    const { summary, signals } = parseSummaryAnswer(completion, transcript.text);
    const observedAt = clock();
    const created = [];
    try {
      for (let index = 0; index < signals.length; index += 1) {
        const signal = signals[index];
        created.push(await trusted(modules, 'call-signal').createManaged({
          sourceKey: `call-signal:${spaceId}:${callRef}:${signal.type}:${index}`,
          spaceId,
          subjectResource: transcript.subjectResource,
          subjectId: transcript.subjectId,
          callRef,
          transcriptRef: transcript.sourceKey,
          signalType: signal.type,
          excerpt: signal.excerpt,
          observedAt,
        }, { actor }));
      }
    } catch (error) {
      // A concurrent summarize won the same deterministic keys: converge
      // on the winner's rows instead of failing the operator. First write
      // wins; the keys make a second summary the same summary.
      if (!(error instanceof ConflictError)) throw error;
      const winner = await findTranscript(spaceId, callRef);
      const winnerSignals = await trusted(modules, 'call-signal').listWhere({ spaceId, callRef });
      return {
        summary: winner?.summary ?? null,
        signals: winnerSignals.map((row) => ({ type: row.signalType, excerpt: row.excerpt })),
        replayed: true,
      };
    }
    const updated = await trusted(modules, 'call-transcript').applyManaged(transcript.id, { summary }, { actor });
    return {
      summary: updated.summary,
      signals: created.map((row) => ({ type: row.signalType, excerpt: row.excerpt })),
      replayed: false,
    };
  }

  /**
   * Erase every transcript whose retention expired at `now`: the personal
   * data (text and summary) is wiped and `purgedAt` is stamped, so the row
   * that remains proves the erasure instead of hiding it. Signals keep
   * their transcript reference and excerpt — they are the team's working
   * evidence, quoted from a transcript that no longer exists.
   */
  async function purgeExpiredTranscripts(input = {}) {
    const actor = requireActor(input.actor);
    const at = input.now === undefined ? clock() : assertIsoDate(input.now, 'now');
    const scoped = input.spaceId === undefined ? {} : { spaceId: assertSpaceId(input.spaceId) };
    const candidates = await trusted(modules, 'call-transcript').listWhere(scoped);
    const service = trusted(modules, 'call-transcript');
    const purged = [];
    for (const row of candidates) {
      if (row.purgedAt) continue;
      if (typeof row.expiresAt !== 'string' || row.expiresAt > at) continue;
      const wiped = await service.applyManaged(row.id, { text: null, summary: null, purgedAt: at }, { actor });
      purged.push(wiped);
    }
    return { purged: purged.map((row) => ({ callRef: row.callRef, purgedAt: row.purgedAt })) };
  }

  /**
   * The calls of one customer, latest first, for the scheda cliente: the
   * AI summary, the signals with their transcript source, and the
   * transcript itself while retention keeps it. A purged transcript reads
   * as erased with its date, never as missing.
   */
  async function readCustomerCalls(input = {}) {
    const spaceId = assertSpaceId(input.spaceId);
    const subjectResource = assertSubjectResource(input.subjectResource);
    const subjectId = assertSubjectId(input.subjectId);
    const transcripts = await trusted(modules, 'call-transcript')
      .listWhere({ spaceId, subjectResource, subjectId });
    const notices = await trusted(modules, 'call-notice')
      .listWhere({ spaceId, subjectResource, subjectId });
    const noticeByCall = new Map(notices.map((row) => [row.callRef, row]));
    const ordered = [...transcripts]
      .sort((left, right) => String(right.recordedAt ?? '').localeCompare(String(left.recordedAt ?? '')))
      .slice(0, MAX_CALLS_READ);
    const calls = [];
    for (const transcript of ordered) {
      const notice = noticeByCall.get(transcript.callRef);
      const signals = await trusted(modules, 'call-signal').listWhere({ spaceId, callRef: transcript.callRef });
      calls.push({
        callRef: transcript.callRef,
        channel: notice?.channel ?? null,
        noticedAt: notice?.noticedAt ?? null,
        recordedAt: transcript.recordedAt,
        expiresAt: transcript.expiresAt,
        summary: transcript.purgedAt ? null : transcript.summary,
        summarized: transcript.summary !== null && transcript.summary !== undefined,
        purgedAt: transcript.purgedAt,
        signals: signals.map((row) => ({
          type: row.signalType, excerpt: row.excerpt, transcriptRef: row.transcriptRef,
        })),
        transcript: transcript.purgedAt
          ? { available: false, reason: `cancellata il ${transcript.purgedAt.slice(0, 10)} (retention scaduta)` }
          : { available: true, text: transcript.text },
      });
    }
    return { calls };
  }

  return {
    recordCallNotice,
    saveCallTranscript,
    summarizeCall,
    purgeExpiredTranscripts,
    readCustomerCalls,
  };
}
