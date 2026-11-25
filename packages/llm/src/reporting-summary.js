// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * The two-line AI summary of the Reporting header (backlog:766e9cf9469e,
 * follow-up of 526e1bf4bd28 which wrote the same two lines as computed
 * text from the channel breakdown).
 *
 * The operator asked «in testa due righe scritte dall'AI su cosa è
 * cambiato nel periodo»: the model rewrites the period's own numbers —
 * customers, preventivi, vendite, previsione — into two plain lines. It
 * reuses and never duplicates (MEM_ACC_REUSE):
 * - spend, caps, dry-run and audit stay inside `complete` — this module
 *   passes one purpose and reads one result, adding no second billing path;
 * - the dashboard numbers stay the analytics registry's: the caller (the
 *   reporting route, which already reads them) hands over facts and the
 *   integers the answer may echo, preformatted with the registry's
 *   `formatMinor`, so this module imports no analytics and invents no
 *   format of its own.
 *
 * No call without something to say: a period with no customers and no
 * pipeline movement answers `{ lines: null, reason: 'empty' }` before any
 * `complete` is touched. A disabled space, a spent cap, a missing key
 * (dry-run) or any provider or parse failure answers `{ lines: null }`
 * with its reason — the caller keeps the computed fallback of 526e1bf4bd28
 * and the header never shows an error. What is deliberately NOT here: any
 * storage, any session, any HTTP. It takes values and returns values,
 * which is also what makes it testable against a fake `complete`.
 */

/** The purpose this summary spends as: its own audited workload. */
export const REPORTING_SUMMARY_PURPOSE = 'reporting-summary';

/** The header renders exactly two lines, never more. */
export const REPORTING_SUMMARY_LINES = 2;
/** One header line stays a line: bounded like the brief lines. */
export const REPORTING_SUMMARY_MAX_LINE_CHARS = 200;
/** Facts ride the prompt as short lines; the prompt stays bounded. */
export const REPORTING_SUMMARY_MAX_FACTS = 12;
export const REPORTING_SUMMARY_MAX_FACT_CHARS = 200;
/** The provider per-message bound the built prompt is measured against. */
const REPORTING_SUMMARY_MAX_PROMPT_CHARS = 8000;

/** Control characters never reach a line: matched like message-draft's fence. */
function hasControlChars(value) {
  const cleaned = String(value).replace(/\n/g, '');
  for (const char of cleaned) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * @param {unknown} value @param {string} field @param {number} max
 */
function summaryText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`reporting summary ${field} must be non-empty text`, { field });
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length === 0 || text.length > max) {
    throw new ValidationError(`reporting summary ${field} is at most ${max} characters`, { field });
  }
  if (hasControlChars(text)) {
    throw new ValidationError(`reporting summary ${field} carries no control characters`, { field });
  }
  return text;
}

/**
 * The numbers the answer may echo: every integer the model writes must be
 * one of these, digit for digit (thousand separators ignored on both
 * sides, so «26.000 €» reads as the 26000 the facts carry). Anything else
 * is an invented number and the answer is refused.
 * @param {unknown} integers
 */
function assertSummaryIntegers(integers) {
  if (!Array.isArray(integers) || integers.length === 0 || integers.length > 64) {
    throw new ValidationError('reporting summary integers must be a non-empty array of at most 64 entries', {
      field: 'integers',
    });
  }
  const seen = new Set();
  for (const entry of integers) {
    if (!Number.isSafeInteger(entry)) {
      throw new ValidationError('reporting summary integers must be safe integers', { field: 'integers' });
    }
    seen.add(String(entry));
  }
  return seen;
}

/**
 * @param {{ text?: unknown, integers?: unknown }} facts
 */
export function assertReportingSummaryFacts(facts) {
  if (facts === null || facts === undefined || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new ValidationError('reporting summary facts must be an object', { field: 'facts' });
  }
  const { text, integers } = /** @type {{ text?: unknown, integers?: unknown }} */ (facts);
  if (!Array.isArray(text) || text.length === 0 || text.length > REPORTING_SUMMARY_MAX_FACTS) {
    throw new ValidationError(
      `reporting summary facts.text must list 1..${REPORTING_SUMMARY_MAX_FACTS} facts`,
      { field: 'facts.text' },
    );
  }
  const lines = text.map((entry, index) => summaryText(entry, `facts.text[${index}]`, REPORTING_SUMMARY_MAX_FACT_CHARS));
  return Object.freeze({ text: Object.freeze(lines), integers: assertSummaryIntegers(integers) });
}

/**
 * Whether the period has anything to say: at least one new customer or
 * one pipeline movement. The caller passes the dashboard's own counts;
 * anything else is «no data» and no model is called.
 * @param {{ customersTotal?: unknown, openCount?: unknown, wonCount?: unknown, lostCount?: unknown }} counts
 */
export function reportingSummaryHasData(counts) {
  if (counts === null || counts === undefined || typeof counts !== 'object') return false;
  return ['customersTotal', 'openCount', 'wonCount', 'lostCount'].some((key) => {
    const value = /** @type {Record<string, unknown>} */ (counts)[key];
    return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
  });
}

/**
 * @param {{ text: readonly string[] }} facts
 */
export function buildReportingSummaryPrompt(facts) {
  const checked = assertReportingSummaryFacts(facts);
  const body = checked.text.map((line) => `- ${line}`).join('\n');
  const user = [
    'Riassumi questo periodo del gestionale in ESATTAMENTE due righe di italiano semplice, per l\u2019operatore.',
    'Regole: usa SOLO i numeri scritti qui sotto, senza aggiungerne altri e senza cambiarli;',
    'mai previsioni oltre la stima indicata, mai consigli, mai nomi di persone o canali non elencati.',
    'Prima riga: cosa ha portato il periodo. Seconda riga: il confronto o la previsione.',
    'Dati del periodo:',
    body,
  ].join('\n');
  const messages = Object.freeze([
    Object.freeze({
      role: 'system',
      content: 'Scrivi due righe di riepilogo per il titolare. Solo i numeri dati, mai inventati.',
    }),
    Object.freeze({ role: 'user', content: user }),
  ]);
  const joined = messages.map((message) => message.content).join('\n');
  if (joined.length > REPORTING_SUMMARY_MAX_PROMPT_CHARS) {
    throw new ValidationError('reporting summary prompt exceeds its bound', { field: 'facts' });
  }
  return Object.freeze({ messages });
}

/**
 * Parse the model's answer back into the two header lines. Exactly two
 * non-empty lines; every numeric token must be one of the allowed
 * integers and every line must carry at least one, so a line of pure
 * words with no period number — or a number the period never had —
 * never reaches the header.
 * @param {unknown} text @param {{ text: readonly string[], integers: Set<string> | readonly unknown[] }} facts
 */
export function parseReportingSummaryResponse(text, facts) {
  const cleaned = summaryText(text, 'response', REPORTING_SUMMARY_MAX_LINE_CHARS * 3);
  const lines = cleaned.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length !== REPORTING_SUMMARY_LINES) {
    throw new ValidationError(
      `reporting summary answer must be exactly ${REPORTING_SUMMARY_LINES} lines`,
      { field: 'response' },
    );
  }
  const allowed = facts.integers instanceof Set
    ? facts.integers
    : new Set([...facts.integers].map((entry) => String(entry)));
  for (const line of lines) {
    if (line.length > REPORTING_SUMMARY_MAX_LINE_CHARS) {
      throw new ValidationError('reporting summary line exceeds its bound', { field: 'response' });
    }
    const tokens = line.match(/\d[\d.,]*/g) ?? [];
    if (tokens.length === 0) {
      throw new ValidationError('reporting summary line names no period number', { field: 'response' });
    }
    for (const token of tokens) {
      if (!allowed.has(token.replace(/[.,]/g, ''))) {
        throw new ValidationError(`reporting summary line invents the number ${token}`, { field: 'response' });
      }
    }
  }
  return Object.freeze({ lines: Object.freeze([...lines]) });
}

/** Reasons the header keeps the computed fallback: never an error to show. */
export const REPORTING_SUMMARY_FALLBACK_REASONS = Object.freeze([
  'empty',
  'ai-unavailable',
  'ai-disabled',
  'ai-capped',
  'ai-secret',
  'ai-error',
  'unparseable',
]);

/**
 * Summarize one reporting period through the package's `complete` handle.
 * Never throws for a missing, disabled or failing AI: those answer
 * `{ lines: null }` with their reason and the caller keeps the computed
 * fallback. Only a malformed caller input (bad facts, no complete
 * function) throws, like the brief.
 *
 * @param {{complete?: unknown, spaceId?: unknown, actor?: unknown, organizationId?: string,
 *   facts: { text?: unknown, integers?: unknown },
 *   counts: { customersTotal?: unknown, openCount?: unknown, wonCount?: unknown, lostCount?: unknown },
 *   maxTokens?: number}} input
 */
export async function summarizeReportingPeriod({
  complete, spaceId, actor, organizationId = undefined, facts, counts, maxTokens = 256,
}) {
  const checked = assertReportingSummaryFacts(facts);
  if (!reportingSummaryHasData(counts)) return Object.freeze({ lines: null, reason: 'empty' });
  if (typeof complete !== 'function' || typeof spaceId !== 'string' || spaceId === '') {
    return Object.freeze({ lines: null, reason: 'ai-unavailable' });
  }
  // The prompt builder re-checks the caller's raw facts (asserted again
  // inside): `checked` carries the integers as a Set for the parser, which
  // the builder's array shape would refuse.
  const { messages } = buildReportingSummaryPrompt(facts);
  /** @type {{ text?: unknown, dryRun?: unknown }} */
  let result;
  try {
    result = await complete({
      actor, spaceId, purpose: REPORTING_SUMMARY_PURPOSE, messages, maxTokens,
      // Voce 5c9e006a: the caller organization, threaded by the caller from
      // the verified identity (never the body), so `complete` refuses spend
      // on another organization's space. Absent keeps historic behavior.
      ...(organizationId === undefined ? {} : { organizationId }),
    });
  } catch (error) {
    const code = error && typeof error === 'object' ? /** @type {any} */ (error)?.code ?? null : null;
    if (code === 'LLM_SPACE_DISABLED') return Object.freeze({ lines: null, reason: 'ai-disabled' });
    if (code === 'LLM_DAILY_CAP_EXCEEDED') return Object.freeze({ lines: null, reason: 'ai-capped' });
    if (code === 'LLM_SECRET_UNAVAILABLE') return Object.freeze({ lines: null, reason: 'ai-secret' });
    return Object.freeze({ lines: null, reason: 'ai-error' });
  }
  if (result?.dryRun === true) {
    // No key, no network behind it: fixture wording is announced, never
    // rendered as the AI summary — the header keeps the computed text.
    return Object.freeze({ lines: null, reason: 'ai-disabled', dryRun: true });
  }
  try {
    const parsed = parseReportingSummaryResponse(result?.text, checked);
    return Object.freeze({ lines: parsed.lines, reason: 'ai', dryRun: result?.dryRun === true });
  } catch (error) {
    if (error instanceof ValidationError) return Object.freeze({ lines: null, reason: 'unparseable' });
    throw error;
  }
}
