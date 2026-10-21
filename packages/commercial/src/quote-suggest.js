// @ts-check

import { AppError, ValidationError, requireQuantity } from '../../core/index.js';

/**
 * AI-suggested quote lines (accordo BO-F2-03, "Suggerisci voci dalle
 * conversazioni" with a cited motive).
 *
 * The backoffice "06 Pipeline" scheda Offerta offers to suggest catalog lines
 * from the customer conversations: each suggestion carries the offer, a
 * quantity, a MOTIVE in words, and the SOURCE excerpt it was drawn from (the
 * excerpt id plus a short quoted span), so the operator can check every
 * proposal against the conversation before adding the line to the draft.
 * Suggestions never write to the draft themselves — adding the line stays a
 * server-priced `quote.add-line` call.
 *
 * What it reuses, per MEM_ACC_REUSE: the `llm-complete@1` capability's
 * audited `suggest` purpose — this module never talks to a provider. The
 * caller hands over a `complete` function; the production adapter is one
 * line:
 *
 *   complete: ({ messages, maxTokens }) =>
 *     llm.complete({ actor, spaceId, purpose: 'suggest', messages, maxTokens }, modules)
 *
 * With no `complete` — or when the model answers that AI is disabled for
 * the space (`LLM_SPACE_DISABLED`) — suggestions stay off: the result is
 * `{ status: 'llm-disabled', suggestions: [] }`, never hallucinated lines.
 * Anything the model returns is validated item by item against the offers
 * and excerpts the caller passed in: an unknown offer, a bad quantity, an
 * empty motive or an unknown source excerpt refuses that item with a typed
 * code instead of inventing a line. A reply that is not a JSON array
 * refuses the whole call (`QUOTE_SUGGEST_INVALID`), fail-closed.
 */

/** The llm-complete purpose this feature spends under (audited there). */
export const QUOTE_SUGGEST_PURPOSE = 'suggest';
/** Hard cap on suggestions per call: the operator checks each one. */
export const MAX_SUGGESTIONS = 10;
/** Only the most recent excerpts travel to the model. */
export const MAX_EXCERPTS = 20;
/** Per-excerpt bound so the prompt stays bounded. */
export const MAX_EXCERPT_CHARS = 2000;
/** A motive is one checkable sentence, not a paragraph. */
export const MAX_MOTIVE_CHARS = 500;
/** The quoted span shown beside each suggestion. */
export const SOURCE_QUOTE_CHARS = 140;

/** @param {unknown} value @param {string} field — non-empty bounded text */
function requireText(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be non-empty text`, { field });
  }
  if (value.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  }
  return value;
}

/**
 * Normalize the conversation excerpts: most recent first is the caller's
 * order — keep the TAIL (most recent) when over the bound and truncate long
 * texts, saying so in the result.
 */
function normalizeExcerpts(excerpts) {
  if (!Array.isArray(excerpts)) {
    throw new ValidationError('excerpts must be an array of { id, text }', { field: 'excerpts' });
  }
  let truncated = excerpts.length > MAX_EXCERPTS;
  const kept = excerpts.slice(-MAX_EXCERPTS).map((excerpt, index) => {
    if (!excerpt || typeof excerpt !== 'object') {
      throw new ValidationError(`excerpts[${index}] must be an object with id and text`, { field: 'excerpts' });
    }
    const id = requireText(excerpt.id, `excerpts[${index}].id`, 128);
    const text = requireText(excerpt.text, `excerpts[${index}].text`, 64_000);
    const short = text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS) : text;
    if (short !== text) truncated = true;
    return { id, text: short };
  });
  return { kept, truncated };
}

function normalizeOffers(offers) {
  if (!Array.isArray(offers)) {
    throw new ValidationError('offers must be an array of { offerId, name }', { field: 'offers' });
  }
  return offers.map((offer, index) => {
    if (!offer || typeof offer !== 'object') {
      throw new ValidationError(`offers[${index}] must be an object with offerId`, { field: 'offers' });
    }
    return {
      offerId: requireText(offer.offerId, `offers[${index}].offerId`, 256),
      name: typeof offer.name === 'string' && offer.name.trim() !== '' ? offer.name.slice(0, 256) : null,
    };
  });
}

/**
 * Build the bounded messages for the model: the eligible offers, then the
 * excerpts by id. The model answers with a JSON array only. A suggestion may
 * carry an optional `discountBps` (integer basis points, 0–10000): the
 * discount the model proposes for that line. It travels through untouched
 * and the price rules judge it at `quote.submit` exactly like an
 * operator-entered discount (BO-F2-04: the rules block the AI too).
 */
export function buildSuggestMessages({ excerpts, offers }) {
  const offerLines = offers.map((offer) => `- ${offer.offerId}${offer.name ? ` — ${offer.name}` : ''}`).join('\n');
  const excerptLines = excerpts.map((excerpt) => `[${excerpt.id}] ${excerpt.text}`).join('\n');
  return [
    {
      role: 'system',
      content: 'Sei il suggeritore di voci di preventivo del backoffice. Rispondi SOLO con un array JSON, senza testo fuori dall\u2019array. '
        + 'Ogni elemento: {"offerId": string, "quantity": integer >= 1, "motive": string, "sourceExcerptId": string, "discountBps": integer 0-10000 opzionale}. '
        + 'offerId deve essere uno di quelli elencati, quantity un intero positivo, motive una frase in italiano che spiega il perch\u00e9 citando la conversazione, '
        + 'sourceExcerptId l\u2019id dell\u2019estratto da cui nasce il suggerimento. Non inventare mai offerte, quantit\u00e0 o motivi: se la conversazione non chiede nulla, rispondi [].',
    },
    {
      role: 'user',
      content: `Offerte tra cui scegliere (solo queste):\n${offerLines}\n\nEstratti della conversazione:\n${excerptLines}`,
    },
  ];
}

/** Strip fenced code blocks the model may wrap around the JSON array. */
function extractJsonArray(text) {
  const trimmed = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError('the suggestion model did not answer a JSON array: no line is suggested', {
      code: 'QUOTE_SUGGEST_INVALID', status: 500,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new AppError('the suggestion model did not answer a JSON array: no line is suggested', {
      code: 'QUOTE_SUGGEST_INVALID', status: 500,
    });
  }
  return parsed;
}

function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Suggest quote lines from conversation excerpts.
 *
 * @param {{
 *   excerpts: Array<{id: string, text: string}>,
 *   offers: Array<{offerId: string, name?: string}>,
 *   complete?: ((request: {messages: Array<{role: string, content: string}>, maxTokens: number}) => Promise<{text: string, dryRun?: boolean}>) | null,
 *   maxSuggestions?: number, maxTokens?: number
 * }} input
 */
export async function suggestQuoteLines({ excerpts, offers, complete, maxSuggestions = MAX_SUGGESTIONS, maxTokens = 1024 }) {
  if (!Number.isSafeInteger(maxSuggestions) || maxSuggestions < 1 || maxSuggestions > 50) {
    throw new ValidationError('maxSuggestions must be an integer between 1 and 50', { field: 'maxSuggestions' });
  }
  const { kept, truncated } = normalizeExcerpts(excerpts ?? []);
  const catalog = normalizeOffers(offers ?? []);
  if (kept.length === 0 || catalog.length === 0) {
    return Object.freeze({
      status: 'no-evidence',
      reason: kept.length === 0 ? 'no conversation excerpts to suggest from' : 'no eligible offers to suggest',
      suggestions: Object.freeze([]),
      refused: Object.freeze([]),
      truncatedExcerpts: truncated,
    });
  }
  if (complete === undefined || complete === null) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'no completion function was provided: suggestions stay off until the caller wires one (for example the llm-complete@1 capability)',
      suggestions: Object.freeze([]),
      refused: Object.freeze([]),
      truncatedExcerpts: truncated,
    });
  }
  if (typeof complete !== 'function') {
    throw new ValidationError('complete must be a function or null', { field: 'complete' });
  }
  const ids = new Set(kept.map((excerpt) => excerpt.id));
  const textById = new Map(kept.map((excerpt) => [excerpt.id, excerpt.text]));
  const offerById = new Map(catalog.map((offer) => [offer.offerId, offer]));
  const messages = buildSuggestMessages({ excerpts: kept, offers: catalog });

  /** @type {{ text: string, dryRun?: boolean }} */
  let answer;
  try {
    answer = await complete({ messages, maxTokens });
  } catch (error) {
    if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'LLM_SPACE_DISABLED') {
      return Object.freeze({
        status: 'llm-disabled',
        reason: String(/** @type {any} */ (error).message ?? 'AI is not enabled for this space').slice(0, 200),
        suggestions: Object.freeze([]),
        refused: Object.freeze([]),
        truncatedExcerpts: truncated,
      });
    }
    throw error;
  }
  const items = extractJsonArray(answer?.text);
  const suggestions = [];
  const refused = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const refuse = (code, reason) => refused.push({ index, code, reason });
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      refuse('QUOTE_SUGGEST_ITEM_INVALID', 'the suggestion is not an object');
      continue;
    }
    const offerId = typeof item.offerId === 'string' ? item.offerId : '';
    const offer = offerById.get(offerId);
    if (!offer) {
      refuse('SUGGESTION_UNKNOWN_OFFER', `unknown offerId "${offerId.slice(0, 80)}": only the listed offers can be suggested`);
      continue;
    }
    let quantity;
    try {
      quantity = requireQuantity(item.quantity, `suggestions[${index}].quantity`);
    } catch {
      refuse('SUGGESTION_QUANTITY_INVALID', 'quantity must be an integer of at least 1');
      continue;
    }
    let discountBps = 0;
    if (item.discountBps !== undefined) {
      if (!Number.isSafeInteger(item.discountBps) || item.discountBps < 0 || item.discountBps > 10_000) {
        refuse('SUGGESTION_DISCOUNT_INVALID', 'discountBps must be an integer 0–10000 when present');
        continue;
      }
      discountBps = item.discountBps;
    }
    if (typeof item.motive !== 'string' || item.motive.trim() === '') {
      refuse('SUGGESTION_MOTIVE_MISSING', 'every suggestion carries its motive in words');
      continue;
    }
    if (item.motive.length > MAX_MOTIVE_CHARS) {
      refuse('SUGGESTION_MOTIVE_TOO_LONG', `motive must be at most ${MAX_MOTIVE_CHARS} characters`);
      continue;
    }
    const sourceExcerptId = typeof item.sourceExcerptId === 'string' ? item.sourceExcerptId : '';
    if (!ids.has(sourceExcerptId)) {
      refuse('SUGGESTION_UNKNOWN_SOURCE', 'sourceExcerptId must be one of the excerpts the call passed in');
      continue;
    }
    if (suggestions.length >= maxSuggestions) {
      refuse('SUGGESTION_OVER_LIMIT', `at most ${maxSuggestions} suggestions per call`);
      continue;
    }
    suggestions.push(Object.freeze({
      offerId: offer.offerId,
      offerName: offer.name,
      quantity,
      discountBps,
      motive: collapseWhitespace(item.motive),
      sourceExcerptId,
      sourceQuote: collapseWhitespace(textById.get(sourceExcerptId) ?? '').slice(0, SOURCE_QUOTE_CHARS),
    }));
  }
  return Object.freeze({
    status: 'ok',
    reason: null,
    suggestions: Object.freeze(suggestions),
    refused: Object.freeze(refused),
    dryRun: answer?.dryRun === true,
    truncatedExcerpts: truncated,
  });
}
