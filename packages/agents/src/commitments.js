// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * Commitment reminders (backlog:df9e199eb4ef) — the written promises the
 * fixed-rule advisor cannot see: a team message that promises something
 * («ti mando il listino domani»), a note that sets a callback («ci
 * sentiamo giovedì»), a customer request left unanswered («mandami il
 * preventivo»).
 *
 * What this file owns: pure extraction and re-checking. It stores nothing
 * (MEM_ACC_REUSE: no second store beside the record modules); the caller
 * reads production rows (messages, notes) and passes them in. One source
 * row yields at most one commitment (its first promissory sentence): the
 * follow-up slice wires «Crea promemoria» (a work-task through the work
 * package) and «Ignora» (a dismissal the next run reuses). No LLM, no
 * network, no clock of its own — with the AI off the run is identical,
 * and the screen says so in one line (follow-up slice, not here).
 */

/** The two commitment kinds: a promise the team made, a request the customer made. */
export const COMMITMENT_KINDS = Object.freeze({
  TEAM_PROMISE: 'team-promise',
  CUSTOMER_REQUEST: 'customer-request',
});

const MAX_QUOTE = 280;
const MAX_KEY = 200;
const DUE_HOUR_UTC = 9;

/** @param {unknown} value */
function foldCommitment(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

/** @param {unknown} value */
function cleanLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A promise the team makes, in the present or future — never the past
// («ti ho mandato» yesterday is done, not a promise). Each entry is a
// fragment of a folded sentence.
const TEAM_PROMISE_SIGNALS = Object.freeze([
  /(^|\W)(ti|vi) (mando|mandiamo|invio|inviamo|giro|giriamo|preparo|prepariamo|confermo|richiamo|chiamiamo|chiamo|faccio|facciamo)( |,|$)/,
  /(^|\W)(mandero|manderemo|inviero|invieremo|chiamero|richiamero|provvedo|provvediamo|prometto|promettiamo)( |,|$)/,
  /(^|\W)(ci sentiamo|ci vediamo|ci aggiorniamo|me ne occupo|ce ne occupiamo|ti faccio sapere|ti facciamo sapere|ti tengo aggiornato|ti terro aggiornato)( |,|$)/,
]);

// A request the customer makes to the team.
const CUSTOMER_REQUEST_SIGNALS = Object.freeze([
  /(^|\W)(mandami|mandatemi|inviami|inviatemi|girami|richiamami|chiamami)( |,|$)/,
  /(^|\W)(mi mandi|mi mandate|mi invii|mi giri|mi puoi|mi potresti|potresti|puoi)( |,|$)/,
  /(^|\W)(mi serve|mi servono|ho bisogno|avrei bisogno|vorrei|aspetto|attendo|sollecito)( |,|$)/,
]);

const WEEKDAYS = Object.freeze([
  { names: ['domenica'], day: 0 },
  { names: ['lunedi'], day: 1 },
  { names: ['martedi'], day: 2 },
  { names: ['mercoledi'], day: 3 },
  { names: ['giovedi'], day: 4 },
  { names: ['venerdi'], day: 5 },
  { names: ['sabato'], day: 6 },
]);

/** @param {string} folded a folded sentence @param {Date} anchor the source row's date */
function resolveDueAt(folded, anchor) {
  const base = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), DUE_HOUR_UTC, 0, 0, 0));
  if (/(^|\W)domani(\W|$)/.test(folded)) {
    return new Date(base.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  for (const { names, day } of WEEKDAYS) {
    for (const name of names) {
      if (!new RegExp(`(^|\\W)${name}(\\W|$)`).test(folded)) continue;
      const ahead = (day - anchor.getUTCDay() + 7) % 7;
      // «giovedì prossimo»: the one after the nearest, never the nearest.
      const extra = /(^|\W)prossim[oaie](\W|$)/.test(folded) ? 7 : 0;
      return new Date(base.getTime() + (ahead + extra) * 24 * 60 * 60 * 1000).toISOString();
    }
  }
  return null;
}

/** @param {string} folded a folded sentence */
function resolveDueLabel(folded) {
  if (/(^|\W)domani(\W|$)/.test(folded)) return 'domani';
  for (const { names } of WEEKDAYS) {
    for (const name of names) {
      if (new RegExp(`(^|\\W)${name}(\\W|$)`).test(folded)) return name;
    }
  }
  return null;
}

/**
 * The thread a row belongs to: one conversation stays one thread, rows
 * without one group by customer and channel (same contract as the silent
 * threads in admin-oggi.js: the latest word of a thread decides).
 * @param {Record<string, any>} row
 */
export function commitmentThreadKey(row) {
  const conversation = cleanLine(row?.conversationId);
  if (conversation !== '') return `conversation:${conversation}`;
  const subject = cleanLine(row?.subjectId);
  if (subject !== '') {
    return `subject:${cleanLine(row?.subjectResource) || 'contact'}:${subject}:${cleanLine(row?.channel)}`;
  }
  return '';
}

/**
 * The first promissory sentence of a text, or null when it promises
 * nothing. Past-tense receipts («ti ho mandato») are not promises.
 * @param {unknown} text @param {ReadonlyArray<RegExp>} signals
 */
function firstCommitmentSentence(text, signals) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return null;
  const sentences = raw.split(/[\n.!?;]+/);
  for (const sentence of sentences) {
    const folded = ` ${foldCommitment(sentence)} `.replace(/\s+/g, ' ');
    if (signals.some((re) => re.test(folded))) {
      const quote = cleanLine(sentence).slice(0, MAX_QUOTE);
      if (quote !== '') return quote;
    }
  }
  return null;
}

/** @param {unknown} value @param {string} field */
function boundedKey(value, field) {
  const key = cleanLine(value);
  if (key === '' || key.length > MAX_KEY) {
    throw new ValidationError(`${field} must be text of 1 to ${MAX_KEY} characters`, { field });
  }
  return key;
}

/**
 * Extract the commitments written in team messages, team notes and
 * unanswered customer messages. Malformed rows (no id, no text, no date)
 * contribute nothing, never a crash — same contract as the advisor
 * signals. A note is always the team's words; a message is the team's
 * only when its direction is `outbound`, the customer's only when it is
 * `inbound`. Relative deadlines («domani», «giovedì») anchor to the
 * source row's own date, never to the extraction run: re-reading the
 * same rows tomorrow keeps the original deadline instead of postponing
 * it (review #1019 giro 1).
 * @param {{ messages?: Array<Record<string, any>>, notes?: Array<Record<string, any>> }} [input]
 */
export function extractCommitments({ messages = [], notes = [] } = {}) {
  const found = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message == null) continue;
    const id = cleanLine(message?.id);
    const occurredAt = Date.parse(String(message?.occurredAt ?? ''));
    if (id === '' || !Number.isFinite(occurredAt)) continue;
    const direction = message?.direction;
    const signals = direction === 'outbound' ? TEAM_PROMISE_SIGNALS
      : direction === 'inbound' ? CUSTOMER_REQUEST_SIGNALS : null;
    if (signals === null) continue;
    const quote = firstCommitmentSentence(message?.body ?? message?.text, signals);
    if (quote === null) continue;
    const anchor = new Date(occurredAt);
    const folded = ` ${foldCommitment(quote)} `.replace(/\s+/g, ' ');
    found.push(Object.freeze({
      key: `commit:message:${id}`,
      kind: direction === 'outbound' ? COMMITMENT_KINDS.TEAM_PROMISE : COMMITMENT_KINDS.CUSTOMER_REQUEST,
      quote,
      dueAt: resolveDueAt(folded, anchor),
      dueLabel: resolveDueLabel(folded),
      occurredAt: new Date(occurredAt).toISOString(),
      thread: commitmentThreadKey(message),
      source: Object.freeze({ kind: 'message', id }),
      customerRef: Object.freeze({
        conversationId: cleanLine(message?.conversationId) || null,
        subjectResource: cleanLine(message?.subjectResource) || null,
        subjectId: cleanLine(message?.subjectId) || null,
      }),
    }));
  }
  for (const note of Array.isArray(notes) ? notes : []) {
    if (note == null) continue;
    const id = cleanLine(note?.id);
    const occurredAt = Date.parse(String(note?.occurredAt ?? ''));
    if (id === '' || !Number.isFinite(occurredAt)) continue;
    const quote = firstCommitmentSentence(note?.body ?? note?.text, TEAM_PROMISE_SIGNALS);
    if (quote === null) continue;
    const anchor = new Date(occurredAt);
    const folded = ` ${foldCommitment(quote)} `.replace(/\s+/g, ' ');
    found.push(Object.freeze({
      key: `commit:note:${id}`,
      kind: COMMITMENT_KINDS.TEAM_PROMISE,
      quote,
      dueAt: resolveDueAt(folded, anchor),
      dueLabel: resolveDueLabel(folded),
      occurredAt: new Date(occurredAt).toISOString(),
      thread: commitmentThreadKey(note),
      source: Object.freeze({ kind: 'note', id }),
      customerRef: Object.freeze({
        conversationId: cleanLine(note?.conversationId) || null,
        subjectResource: cleanLine(note?.subjectResource) || null,
        subjectId: cleanLine(note?.subjectId) || null,
      }),
    }));
  }
  return Object.freeze(found);
}

/**
 * Re-check extracted commitments against the latest messages: a team
 * message (`outbound`) on the same thread after the commitment closes
 * it, and a dismissed key never returns. Closing needs the thread and a
 * newer date — a team message elsewhere, or at the same instant, changes
 * nothing.
 * @param {{ commitments?: Array<Record<string, any>>, messages?: Array<Record<string, any>>, dismissed?: Record<string, unknown> }} [input]
 */
export function recalcCommitments({ commitments = [], messages = [], dismissed = {} } = {}) {
  const out = dismissed != null && typeof dismissed === 'object' ? dismissed : {};
  const open = [];
  const closed = [];
  for (const commitment of Array.isArray(commitments) ? commitments : []) {
    if (commitment == null) continue;
    const key = cleanLine(commitment?.key);
    if (key === '' || Object.hasOwn(out, key)) continue;
    const thread = cleanLine(commitment?.thread);
    const since = Date.parse(String(commitment?.occurredAt ?? ''));
    let closedBy = null;
    if (thread !== '' && Number.isFinite(since)) {
      for (const message of Array.isArray(messages) ? messages : []) {
        if (message == null || message?.direction !== 'outbound') continue;
        if (cleanLine(message?.id) === cleanLine(commitment?.source?.id)) continue;
        if (commitmentThreadKey(message) !== thread) continue;
        const at = Date.parse(String(message?.occurredAt ?? ''));
        if (Number.isFinite(at) && at > since) {
          closedBy = cleanLine(message?.id) || null;
          break;
        }
      }
    }
    if (closedBy !== null) closed.push(Object.freeze({ ...commitment, closedBy }));
    else open.push(commitment);
  }
  return Object.freeze({ open: Object.freeze(open), closed: Object.freeze(closed) });
}

/**
 * Record an «Ignora» on a proposal: the key never resurfaces while the
 * dismissal is passed back in. The reason is mandatory — a dismissal
 * without one is refused, never guessed.
 * @param {Record<string, unknown>} [dismissals] @param {unknown} key @param {unknown} reason
 */
export function recordCommitmentDismissal(dismissals, key, reason) {
  const safeKey = boundedKey(key, 'dismissal.key');
  const safeReason = cleanLine(reason);
  if (safeReason === '' || safeReason.length > MAX_QUOTE) {
    throw new ValidationError(`dismissal.reason must be text of 1 to ${MAX_QUOTE} characters`, { field: 'dismissal.reason' });
  }
  const base = dismissals != null && typeof dismissals === 'object' && !Array.isArray(dismissals)
    ? { ...dismissals } : {};
  base[safeKey] = Object.freeze({ reason: safeReason });
  return Object.freeze(base);
}
