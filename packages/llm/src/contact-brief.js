// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { assertMessageDraftPlaybook, buildPlaybookContextBlock } from './message-draft.js';

/**
 * The customer brief for the scheda cliente (backlog:317fcc684f51).
 *
 * The top of the card shows three short AI lines — chi è la persona, cosa
 * è successo con noi, cosa conviene dire adesso — each with its own
 * source. This module is the framework side: it builds the prompt from
 * the card's own inputs, calls the package's `complete` handle (purpose
 * `contact-brief`, so the spend is audited exactly like every other llm
 * call), and parses the model's answer back into the labeled shape the
 * card renders.
 *
 * It reuses and never duplicates (MEM_ACC_REUSE):
 * - spend, caps, dry-run and audit stay inside `complete` — this module
 *   passes one purpose and reads one result, adding no second billing path;
 * - the playbook validation and context block are message-draft's own
 *   (`assertMessageDraftPlaybook`, `buildPlaybookContextBlock`): the
 *   space playbook keeps one home and one shape;
 * - the history entry shape and bounds mirror message-draft's, so a
 *   history accepted here travels the same provider fence.
 *
 * Regeneration is structural, not cached: the brief is a pure function
 * of the inputs (history, offers, appointments), so a new message, a new
 * offer or a new appointment changes the prompt and the caller re-runs
 * the brief. No cache, no invalidation key, nothing to go stale.
 *
 * What is deliberately NOT here: any storage, any session, any HTTP. The
 * pilot owns the route and the worker owns the history read; this module
 * takes values and returns values, which is also what makes it testable
 * against a fake `complete`.
 */

/** The purpose this brief spends as: its own audited workload. */
export const CONTACT_BRIEF_PURPOSE = 'contact-brief';

/** The three lines the card renders, in the order it renders them. */
export const CONTACT_BRIEF_LINES = Object.freeze(['chiE', 'cosaSuccesso', 'cosaDire']);

export const CONTACT_BRIEF_MAX_HISTORY = 20;
export const CONTACT_BRIEF_MAX_HISTORY_TEXT_CHARS = 2000;
export const CONTACT_BRIEF_MAX_ITEMS = 20;
export const CONTACT_BRIEF_MAX_ITEM_TEXT_CHARS = 500;
export const CONTACT_BRIEF_MAX_LINE_CHARS = 500;
export const CONTACT_BRIEF_MAX_SOURCE_CHARS = 200;
export const CONTACT_BRIEF_MAX_NAME_CHARS = 100;
/** The provider per-message bound the built prompt is measured against. */
const CONTACT_BRIEF_MAX_PROMPT_CHARS = 32000;

/**
 * Words no brief line may carry: personality judgments (Kombo section 10,
 * group C: the DISC/MBTI profile is not copied). The prompt forbids them
 * and the parser refuses them typed, so a model that judges anyway never
 * reaches the card. Word-boundary match on the joined lines, so ordinary
 * words that merely contain a banned token (discutere, disciplina) pass.
 */
const CONTACT_BRIEF_BANNED = Object.freeze([
  /\bdisc\b/,
  /\bmbti\b/,
  /\benneagramma\b/,
  /\bnarcisista\b/,
  /\bpsicopatico\b/,
  /\bpigro\b/,
  /\bmaleducato\b/,
  /\bstupido\b/,
  /\bdisonesto\b/,
  /\bmanipolatore\b/,
  /personalità disturbata/,
  /disturbo di personalità/,
]);

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * @param {unknown} value @param {string} field @param {number} max
 */
function briefText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`contact brief ${field} must be non-empty text`, { field });
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > max) {
    throw new ValidationError(`contact brief ${field} is at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(text.replace(/\n/g, ''))) {
    throw new ValidationError(`contact brief ${field} carries no control characters`, { field });
  }
  return text;
}

/** @param {unknown} history */
function assertBriefHistory(history) {
  if (!Array.isArray(history) || history.length > CONTACT_BRIEF_MAX_HISTORY) {
    throw new ValidationError(
      `contact brief history must be an array of at most ${CONTACT_BRIEF_MAX_HISTORY} entries`,
      { field: 'history' },
    );
  }
  return Object.freeze(history.map((entry, index) => {
    const field = `history[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('contact brief history entry must be a plain object', { field });
    }
    const { direction, text } = /** @type {Record<string, unknown>} */ (entry);
    if (direction !== 'in' && direction !== 'out') {
      throw new ValidationError("contact brief history direction is 'in' or 'out'", { field: `${field}.direction` });
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > CONTACT_BRIEF_MAX_HISTORY_TEXT_CHARS) {
      throw new ValidationError(
        `contact brief history text is bounded non-empty text (at most ${CONTACT_BRIEF_MAX_HISTORY_TEXT_CHARS} characters)`,
        { field: `${field}.text` },
      );
    }
    return Object.freeze({ direction, text: text.trim() });
  }));
}

/**
 * Offers or appointments: short dated facts the brief may cite. Each
 * carries the text the card already shows and nothing else — no ids, no
 * prices, no payloads the model does not need.
 * @param {unknown} items @param {string} field
 */
function assertBriefItems(items, field, maxText) {
  if (items === undefined || items === null) return Object.freeze([]);
  if (!Array.isArray(items) || items.length > CONTACT_BRIEF_MAX_ITEMS) {
    throw new ValidationError(
      `contact brief ${field} must be an array of at most ${CONTACT_BRIEF_MAX_ITEMS} entries`,
      { field },
    );
  }
  return Object.freeze(items.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '' || entry.length > maxText) {
      throw new ValidationError(
        `contact brief ${field}[${index}] is bounded non-empty text (at most ${maxText} characters)`,
        { field: `${field}[${index}]` },
      );
    }
    const text = entry.replace(/\r\n/g, '\n').trim();
    if (CONTROL_RE.test(text.replace(/\n/g, ''))) {
      throw new ValidationError(`contact brief ${field}[${index}] carries no control characters`, {
        field: `${field}[${index}]`,
      });
    }
    return text;
  }));
}

/**
 * Validate the brief request. Throws fail-closed; returns the frozen
 * request the prompt builder and the caller execute.
 */
export function assertContactBriefInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('contact brief input must be a plain object', { field: 'input' });
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  return Object.freeze({
    customerName: briefText(value.customerName, 'customerName', CONTACT_BRIEF_MAX_NAME_CHARS),
    history: assertBriefHistory(value.history ?? []),
    offers: assertBriefItems(value.offers ?? [], 'offers', CONTACT_BRIEF_MAX_ITEM_TEXT_CHARS),
    appointments: assertBriefItems(value.appointments ?? [], 'appointments', CONTACT_BRIEF_MAX_ITEM_TEXT_CHARS),
    playbook: assertMessageDraftPlaybook(value.playbook ?? null),
  });
}

/**
 * Build the completion messages for one brief. Pure: the acceptance pins
 * that the card's own data reaches the model — the customer name, the
 * latest inbound line, the newest offer and the newest appointment travel
 * verbatim — so the test reads them back from exactly what this function
 * returns. The prompt bans personality judgments outright (no DISC/MBTI,
 * no character verdicts: only observable facts), and every line it asks
 * for names its source, so the card can drop a line whose source is
 * missing.
 *
 * @param {{customerName: string, history?: unknown, offers?: unknown, appointments?: unknown, playbook?: unknown}} brief
 */
export function buildContactBriefPrompt(brief) {
  const checked = assertContactBriefInput(brief);
  const historyLines = checked.history.map((entry) => `- ${entry.direction === 'in' ? 'cliente' : 'team'}: ${entry.text}`);
  const playbookBlock = buildPlaybookContextBlock(checked.playbook);
  const user = [
    `Cliente: ${checked.customerName}`,
    ...(playbookBlock === null ? [] : [playbookBlock]),
    'Cronologia della scheda (dalla meno recente alla più recente):',
    ...(historyLines.length > 0 ? historyLines : ['- (nessun messaggio precedente)']),
    'Offerte (dalla meno recente alla più recente):',
    ...(checked.offers.length > 0 ? checked.offers.map((offer) => `- ${offer}`) : ['- (nessuna offerta)']),
    'Appuntamenti (dal meno recente al più recente):',
    ...(checked.appointments.length > 0
      ? checked.appointments.map((appointment) => `- ${appointment}`)
      : ['- (nessun appuntamento)']),
    '',
    'Scrivi tre righe per la scheda del cliente. Rispondi SOLO con un oggetto JSON,',
    'senza testo prima o dopo, con esattamente queste chiavi:',
    '{"chiE": {"testo": "<chi è la persona, dai fatti osservabili>", "fonte": "<quale riga sopra lo dice>"},',
    ' "cosaSuccesso": {"testo": "<cosa è successo con noi>", "fonte": "<quale riga sopra lo dice>"},',
    ' "cosaDire": {"testo": "<cosa conviene dire adesso>", "fonte": "<quale riga sopra lo dice>"}}.',
    'Regole: ogni riga cita SOLO fatti osservabili dalle righe sopra (messaggi, offerte,',
    'appuntamenti, playbook); MAI giudizi sulla personalità o sul carattere — niente tipi',
    'psicologici (DISC, MBTI, enneagramma), niente etichette sul carattere, niente diagnosi.',
    'Ogni fonte nomina la riga che la sostiene; se per una riga non c\u2019è nessuna fonte,',
    'lasciane la fonte vuota e la scheda non la mostrerà.',
  ].join('\n');
  if (user.length > CONTACT_BRIEF_MAX_PROMPT_CHARS) {
    throw new ValidationError(
      `contact brief prompt is ${user.length} characters: at most ${CONTACT_BRIEF_MAX_PROMPT_CHARS} fit the provider per-message fence`,
      { field: 'prompt' },
    );
  }
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        role: 'system',
        content: 'Sei l\u2019assistente che riassume la scheda di un cliente per un team italiano. '
          + 'Scrivi in italiano, tono concreto e neutro. Citi solo fatti osservabili, mai giudizi '
          + 'sulla personalità o sul carattere: niente tipi psicologici, etichette o diagnosi. '
          + 'Rispondi solo con il JSON richiesto.',
      }),
      Object.freeze({ role: 'user', content: user }),
    ]),
  });
}

/** @param {unknown} text */
function briefLineSource(text) {
  if (text === undefined || text === null) return null;
  if (typeof text !== 'string' || text.trim() === '') return null;
  const fonte = text.replace(/\r\n/g, '\n').trim();
  if (fonte.length > CONTACT_BRIEF_MAX_SOURCE_CHARS || CONTROL_RE.test(fonte.replace(/\n/g, ''))) return null;
  return fonte;
}

/**
 * Parse one model answer back into the card lines. A line whose source is
 * missing, empty or malformed does NOT appear in the output (the card
 * renders only what this function returns); a line whose text judges the
 * person refuses typed, like an unusable answer. Returns the frozen
 * `{ lines }` shape: only the lines with a source.
 *
 * @param {unknown} text
 */
export function parseContactBriefResponse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AppError('the model did not answer a usable brief', {
      code: 'CONTACT_BRIEF_INVALID', status: 502,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new AppError('the model did not answer a usable brief', {
      code: 'CONTACT_BRIEF_INVALID', status: 502,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('the model did not answer a usable brief', {
      code: 'CONTACT_BRIEF_INVALID', status: 502,
    });
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const lines = {};
  for (const key of CONTACT_BRIEF_LINES) {
    const entry = record[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('the model did not answer a usable brief', {
        code: 'CONTACT_BRIEF_INVALID', status: 502,
      });
    }
    const { testo, fonte } = /** @type {Record<string, unknown>} */ (entry);
    const source = briefLineSource(fonte);
    if (source === null) continue;
    const line = briefText(testo, key, CONTACT_BRIEF_MAX_LINE_CHARS);
    lines[key] = Object.freeze({ testo: line, fonte: source });
  }
  const joined = Object.values(lines).map((line) => `${line.testo} ${line.fonte}`).join('\n').toLowerCase();
  if (CONTACT_BRIEF_BANNED.some((banned) => banned.test(joined))) {
    throw new AppError('the model judged the person instead of citing facts', {
      code: 'CONTACT_BRIEF_JUDGMENT', status: 502,
    });
  }
  return Object.freeze({ lines: Object.freeze(lines) });
}

/**
 * Brief one customer through the package's `complete` handle. The space,
 * the caps and the audit are `complete`'s own: a disabled space refuses
 * with `LLM_SPACE_DISABLED` and a missing key with
 * `LLM_SECRET_UNAVAILABLE` before any provider is touched, and the pilot
 * maps those two codes to its clear Italian answer.
 *
 * A dry run (no key) answers without error but stays off, following the
 * message-draft off-status pattern: no presentable wording rides a dry
 * run, only the reason, so a card that misses the flag can neither render
 * fixture text as model wording nor show the section — with the AI off
 * the section does not appear.
 *
 * @param {{complete: (request: any) => Promise<any>, spaceId: string, actor: unknown,
 *   customerName: string, history?: unknown, offers?: unknown, appointments?: unknown,
 *   playbook?: unknown, maxTokens?: number, organizationId?: string}} input
 */
export async function briefCustomer({
  complete, spaceId, actor, customerName, history = [], offers = [], appointments = [], playbook = null,
  maxTokens = 1024, organizationId = undefined,
}) {
  if (typeof complete !== 'function') {
    throw new ValidationError('contact brief needs the llm complete handle', { field: 'complete' });
  }
  const checked = assertContactBriefInput({ customerName, history, offers, appointments, playbook });
  const { messages } = buildContactBriefPrompt(checked);
  const result = await complete({
    actor, spaceId, purpose: CONTACT_BRIEF_PURPOSE, messages, maxTokens,
    // Voce 5c9e006a: the caller organization, threaded by the caller from
    // the verified identity (never the body), so `complete` refuses spend
    // on another organization's space. Absent keeps historic behavior.
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  if (result?.dryRun === true) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'the completion ran as a dry run without a key: the brief stays off, retry with a key instead',
      lines: null,
      dryRun: true,
    });
  }
  const parsed = parseContactBriefResponse(result?.text);
  return Object.freeze({ ...parsed, dryRun: result?.dryRun === true });
}
