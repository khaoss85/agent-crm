// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The outreach model (backlog:a9306c5f) — find, evaluate, write; the human
 * approves the send. It extends the squad templates (backlog:0d2d8f2e) with
 * the sales-outreach / lead-generation content: every proposed candidate
 * carries its provenance and its reason, a dismissal is recorded and reused
 * on the next run, stop rules halt the run and say so, and page, contact or
 * reply content that carries instructions for the agent is treated as data
 * and flagged.
 *
 * What this file owns: pure validation and run planning. It stores nothing
 * (MEM_ACC_REUSE: no second store beside the record modules); the caller
 * reads production rows (candidates, dismissals, opt-outs, replies, sends
 * of the week) and passes them in, and the plan answers what the run sends,
 * skips or halts on. Persisting dismissals and counting the weekly sends
 * from run rows ships as the follow-up named in the item row.
 */

/** Default weekly send cap of one outreach run: at most this many first messages per week. */
export const OUTREACH_DEFAULT_WEEKLY_CAP = 25;

/** Stop and skip reasons of one outreach run. */
export const OUTREACH_STOP_REASONS = Object.freeze({
  OPT_OUT: 'OPT_OUT',
  NO_PROVENANCE: 'NO_PROVENANCE',
  REPLY_RECEIVED: 'REPLY_RECEIVED',
  WEEKLY_CAP_REACHED: 'WEEKLY_CAP_REACHED',
  DISMISSED: 'DISMISSED',
  UNTRUSTED_CONTENT: 'UNTRUSTED_CONTENT',
  OVER_CAP: 'OVER_CAP',
  RUN_HALTED: 'RUN_HALTED',
});

/** @param {unknown} value @param {string} field @param {number} max */
function boundedLine(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line text`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} max */
function boundedText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ValidationError(`${field} must be text of 1 to ${max} characters`, { field });
  }
  return value;
}

/** Accents folded so «ignora» matches accented evasions. @param {unknown} value */
function foldOutreach(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

const UNTRUSTED_SIGNALS = Object.freeze([
  { code: 'IGNORE_INSTRUCTIONS', re: /(ignora|dimentica|non seguire)[\w ]{0,30}(istruzioni|direttive)|(ignore|disregard|forget)[\w ]{0,30}(instructions|directives)/ },
  { code: 'SYSTEM_MARKER', re: /(^|\n)\s*(system|istruzioni di sistema)\s*:|\[system\]|<system>|###\s*system|system prompt/ },
  { code: 'ROLE_HIJACK', re: /(sei ora|da ora sei|agisci come se fossi)|(you are now|from now on you are|act as if you (are|were))/ },
  { code: 'EXFIL_ORDER', re: /(inoltra|copia e (incolla|inoltra)).{0,60}(a |tutto |tutta )|(forward|send|copy).{0,60}(this|the|all).{0,40}(conversation|chat|data|transcript).{0,20}to/ },
]);

/**
 * Page, contact or reply content is data, never orders: scan it for
 * instruction-shaped text aimed at the agent.
 * @param {unknown} text
 */
export function scanUntrustedContent(text) {
  const folded = foldOutreach(text);
  const signals = [];
  for (const { code, re } of UNTRUSTED_SIGNALS) {
    if (re.test(folded)) signals.push(code);
  }
  return Object.freeze({ flagged: signals.length > 0, signals: Object.freeze(signals) });
}

/**
 * One proposed candidate: who, where they come from, why they fit, and the
 * draft first message. Provenance and reason are mandatory — a candidate
 * without them is refused, never guessed. Content carrying instructions
 * for the agent stays valid data but is marked untrusted (quarantined at
 * planning, never sent silently).
 * @param {unknown} input
 */
export function checkOutreachCandidate(input) {
  const record = input && typeof input === 'object' ? input : {};
  const key = boundedLine(/** @type {any} */ (record).key ?? '', 'candidate.key', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) {
    throw new ValidationError('candidate.key must be a safe key', { field: 'candidate.key' });
  }
  const provenance = /** @type {any} */ (record).provenance;
  const channel = typeof provenance?.channel === 'string' ? provenance.channel : '';
  const reference = typeof provenance?.reference === 'string' ? provenance.reference : '';
  if (channel.trim() === '' || reference.trim() === '') {
    throw new AppError('A candidate needs provenance (channel and reference): a candidate without it never sends', {
      code: 'OUTREACH_NO_PROVENANCE', status: 422,
    });
  }
  const reason = /** @type {any} */ (record).reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new AppError('A candidate needs its reason: why this person, in one line', {
      code: 'OUTREACH_NO_REASON', status: 422,
    });
  }
  const draft = /** @type {any} */ (record).draft;
  if (typeof draft !== 'string' || draft.trim() === '') {
    throw new AppError('A candidate needs its draft first message', {
      code: 'OUTREACH_NO_DRAFT', status: 422,
    });
  }
  const excerpt = /** @type {any} */ (record).excerpt ?? '';
  if (excerpt !== '' && (typeof excerpt !== 'string' || excerpt.length > 2000)) {
    throw new ValidationError('candidate.excerpt must be text of at most 2000 characters', { field: 'candidate.excerpt' });
  }
  const scan = scanUntrustedContent(`${draft}\n${excerpt}`);
  return Object.freeze({
    key,
    provenance: Object.freeze({
      channel: boundedLine(channel, 'provenance.channel', 80),
      reference: boundedLine(reference, 'provenance.reference', 256),
    }),
    reason: boundedLine(reason, 'candidate.reason', 280),
    draft: boundedText(draft, 'candidate.draft', 2000),
    excerpt,
    untrusted: scan.flagged,
    untrustedSignals: scan.signals,
  });
}

/**
 * Record a human dismissal: the key, why it was dismissed, who dismissed
 * it. The reason is mandatory — a dismissal without it refuses, so the next
 * run never inherits a silent exclusion.
 * @param {unknown} input
 */
export function recordOutreachDismissal(input) {
  const record = input && typeof input === 'object' ? input : {};
  const key = boundedLine(/** @type {any} */ (record).key ?? '', 'dismissal.key', 64);
  const reason = /** @type {any} */ (record).reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new AppError('A dismissal needs its reason: it is reused on the next run', {
      code: 'OUTREACH_DISMISSAL_NO_REASON', status: 422,
    });
  }
  const actorId = /** @type {any} */ (record).actorId;
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new AppError('A dismissal needs the human who dismissed it', {
      code: 'OUTREACH_DISMISSAL_NO_ACTOR', status: 422,
    });
  }
  const dismissedAt = /** @type {any} */ (record).dismissedAt ?? null;
  if (dismissedAt !== null && (typeof dismissedAt !== 'string' || !Number.isFinite(Date.parse(dismissedAt)))) {
    throw new ValidationError('dismissal.dismissedAt must be a canonical instant', { field: 'dismissal.dismissedAt' });
  }
  return Object.freeze({
    key,
    reason: boundedLine(reason, 'dismissal.reason', 280),
    actorId: boundedLine(actorId, 'dismissal.actorId', 120),
    dismissedAt,
  });
}

/** @param {unknown} value @param {string} field */
function checkCount(value, field) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > 1000000) {
    throw new ValidationError(`${field} must be an integer from 0 to 1000000`, { field });
  }
  return /** @type {number} */ (value);
}

/**
 * Plan one outreach run from production rows the caller passes in. The
 * stop rules halt the whole run and name the rule and the keys: an opt-out
 * seen in the batch, a reply received (the human conversation resumed, the
 * automation stops), data without provenance, or the weekly cap already
 * reached. Dismissed candidates are excluded (the dismissal recorded
 * earlier is reused here), untrusted content is quarantined, and past the
 * cap the overflow waits for next week. Nothing sends on a halted run.
 */
export function planOutreachRun(input) {
  const record = input && typeof input === 'object' ? input : {};
  const rawCandidates = /** @type {any} */ (record).candidates;
  if (!Array.isArray(rawCandidates)) {
    throw new ValidationError('planOutreachRun needs the candidate list', { field: 'candidates' });
  }
  const toSet = (value) => new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => typeof entry === 'string' ? entry : entry?.key)
      .filter((key) => typeof key === 'string' && key !== ''),
  );
  const dismissed = toSet(/** @type {any} */ (record).dismissals);
  const optOuts = toSet(/** @type {any} */ (record).optOuts);
  const replies = toSet(/** @type {any} */ (record).replies);
  const weeklyCap = /** @type {any} */ (record).weeklyCap ?? OUTREACH_DEFAULT_WEEKLY_CAP;
  if (!Number.isInteger(weeklyCap) || weeklyCap <= 0 || weeklyCap > 1000000) {
    throw new ValidationError('weeklyCap must be a positive integer', { field: 'weeklyCap' });
  }
  const sentThisWeek = checkCount(/** @type {any} */ (record).sentThisWeek ?? 0, 'sentThisWeek');

  /** @type {Array<{ key: string, why: string, note: string }>} */
  const skipped = [];
  /** @type {Array<any>} */
  const sendable = [];
  const haltKeys = { OPT_OUT: [], REPLY_RECEIVED: [], NO_PROVENANCE: [] };
  for (const raw of rawCandidates) {
    const key = typeof raw?.key === 'string' && raw.key !== '' ? raw.key : '(senza chiave)';
    const channel = typeof raw?.provenance?.channel === 'string' ? raw.provenance.channel : '';
    const reference = typeof raw?.provenance?.reference === 'string' ? raw.provenance.reference : '';
    if (channel.trim() === '' || reference.trim() === '') {
      skipped.push({ key, why: 'NO_PROVENANCE', note: 'Dato senza provenienza: la corsa si ferma, il candidato non si manda.' });
      haltKeys.NO_PROVENANCE.push(key);
      continue;
    }
    if (optOuts.has(raw?.key)) {
      skipped.push({ key, why: 'OPT_OUT', note: 'Opt-out: la persona ha chiesto di non essere ricontattata, la corsa si ferma.' });
      haltKeys.OPT_OUT.push(key);
      continue;
    }
    if (replies.has(raw?.key)) {
      skipped.push({ key, why: 'REPLY_RECEIVED', note: 'Risposta ricevuta: la conversazione continua con la persona, la corsa si ferma.' });
      haltKeys.REPLY_RECEIVED.push(key);
      continue;
    }
    if (dismissed.has(raw?.key)) {
      skipped.push({ key, why: 'DISMISSED', note: 'Scartato dalla persona in una corsa precedente: escluso anche da questa.' });
      continue;
    }
    const scan = scanUntrustedContent(`${raw?.draft ?? ''}\n${raw?.excerpt ?? ''}`);
    if (scan.flagged || raw?.untrusted === true) {
      const signals = [].concat(raw?.untrustedSignals ?? scan.signals).filter((signal) => typeof signal === 'string' && signal !== '');
      skipped.push({ key, why: 'UNTRUSTED_CONTENT', note: `Contenuto con istruzioni per l'agente (${signals.length > 0 ? signals.join(', ') : 'segnale sospetto'}): trattato come dato, non si manda.` });
      continue;
    }
    sendable.push(raw);
  }

  const remaining = weeklyCap - sentThisWeek;
  if (remaining <= 0) {
    return Object.freeze({
      halted: true,
      haltReason: Object.freeze({
        rule: 'WEEKLY_CAP_REACHED',
        keys: Object.freeze([]),
        note: `Tetto settimanale raggiunto: ${sentThisWeek} invii su ${weeklyCap}. La corsa si ferma qui.`,
      }),
      queued: Object.freeze([]),
      skipped: Object.freeze(skipped.concat(sendable.map((candidate) => ({
        key: candidate?.key,
        why: 'WEEKLY_CAP_REACHED',
        note: 'Tetto settimanale raggiunto: rimandato alla prossima settimana.',
      })))),
    });
  }
  /** @type {{ rule: string, keys: string[], note: string } | null} */
  let haltReason = null;
  if (haltKeys.OPT_OUT.length > 0) {
    haltReason = {
      rule: 'OPT_OUT',
      keys: [...haltKeys.OPT_OUT],
      note: `Opt-out (${haltKeys.OPT_OUT.join(', ')}): la corsa si ferma, niente invii.`,
    };
  } else if (haltKeys.REPLY_RECEIVED.length > 0) {
    haltReason = {
      rule: 'REPLY_RECEIVED',
      keys: [...haltKeys.REPLY_RECEIVED],
      note: `Risposta ricevuta (${haltKeys.REPLY_RECEIVED.join(', ')}): la persona continua, la corsa si ferma.`,
    };
  } else if (haltKeys.NO_PROVENANCE.length > 0) {
    haltReason = {
      rule: 'NO_PROVENANCE',
      keys: [...haltKeys.NO_PROVENANCE],
      note: `Dato senza provenienza (${haltKeys.NO_PROVENANCE.join(', ')}): la corsa si ferma, niente invii al buio.`,
    };
  }
  if (haltReason !== null) {
    return Object.freeze({
      halted: true,
      haltReason: Object.freeze({ ...haltReason, keys: Object.freeze(haltReason.keys) }),
      queued: Object.freeze([]),
      skipped: Object.freeze(skipped.concat(sendable.map((candidate) => ({
        key: candidate?.key,
        why: 'RUN_HALTED',
        note: `La corsa si è fermata (${haltReason.rule}): rimandato.`,
      })))),
    });
  }
  const queued = sendable.slice(0, remaining);
  const overflow = sendable.slice(remaining).map((candidate) => ({
    key: candidate?.key,
    why: 'OVER_CAP',
    note: `Tetto settimanale: ${weeklyCap - sentThisWeek} invii rimasti, rimandato alla prossima settimana.`,
  }));
  return Object.freeze({
    halted: false,
    haltReason: null,
    queued: Object.freeze([...queued]),
    skipped: Object.freeze([...skipped, ...overflow]),
  });
}
