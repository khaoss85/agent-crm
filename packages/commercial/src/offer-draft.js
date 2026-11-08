// @ts-check

import { AppError, ValidationError, requireQuantity } from '../../core/index.js';
import { applyDiscount, checkedAdd, checkedMultiply } from './money.js';

/**
 * AI-suggested offer draft from one operator sentence (backlog:7847b4cf,
 * «Bozza dell'offerta da una frase»): the /bo panel's «scrivi …» line fills
 * the offer fields by itself. The member types a sentence («offerta 10
 * ingressi con sconto 10%») and this module answers what the panel fills
 * in: `{ title?, valueCents?, currency?, expectedCloseDate?, catalogOfferIds?, lines }`
 * (`lines`: the rows the panel renders, backlog:8efd56406c7e).
 *
 * What it reuses, per MEM_ACC_REUSE: the `llm-complete@1` capability's
 * audited `suggest` purpose — this module never talks to a provider. The
 * caller hands over a `complete` function; the pilot worker's adapter is one
 * line:
 *
 *   complete: ({ messages, maxTokens }) =>
 *     assistant.complete({ actor, spaceId, purpose: 'suggest', sources, messages, maxTokens })
 *
 * The model chooses WHAT (which catalog offers, how many, which discount)
 * and the domain computes the MONEY: `valueCents` is priced server-side from
 * the catalog prices the caller passed in, never taken from the model, so a
 * model-invented amount can never reach the panel. A discount above the
 * space policy refuses that line with a typed code — the price rules judge
 * AI discounts exactly like operator-entered ones, and the draft carries no
 * approval flow, so an over-policy line stays out rather than in. An
 * unknown offerId refuses that line too: `catalogOfferIds` names only ids
 * from the catalog the caller passed in, never invented products. With no
 * `complete` the result is `{ status: 'llm-disabled', draft: null }`, never
 * hallucinated lines.
 *
 * With an empty catalog the result is `{ status: 'no-evidence', draft: null }`:
 * a draft from no catalog would be invented by construction.
 */

/** The llm-complete purpose this feature spends under (audited there). */
export const OFFER_DRAFT_PURPOSE = 'suggest';
/** The member's sentence, as the panel sends it: 1..500 characters. */
export const MAX_OFFER_DRAFT_PROMPT_CHARS = 500;
/** The draft title bound: one short line on the panel, never a paragraph. */
export const MAX_OFFER_DRAFT_TITLE_CHARS = 120;
/** At most this many lines per draft: the operator checks each one. */
export const MAX_OFFER_DRAFT_LINES = 10;
/**
 * At most this many active offers travel in the prompt, like the excerpt
 * bound of quote-suggest: the model only ever chooses among listed offers,
 * so the eligible catalog is capped once, before the prompt and the domain
 * both read it.
 */
export const MAX_OFFER_DRAFT_PROMPT_OFFERS = 50;

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
 * The eligible catalog offers, as the worker read them from the space
 * catalog (active rows of `GET /api/catalog/products`): every id the model
 * may name, with the unit price the draft is computed from and the
 * per-offer discount ceiling from the product version (`maxDiscountBps`).
 * A `null` price means the catalog carries no single unit price for that
 * offer (tiers, mixed components): such a line can still be drafted, but
 * the draft carries no computed total rather than a guessed one.
 */
function normalizeOffers(offers) {
  if (!Array.isArray(offers)) {
    throw new ValidationError('offers must be an array of { offerId }', { field: 'offers' });
  }
  return offers.map((offer, index) => {
    if (!offer || typeof offer !== 'object') {
      throw new ValidationError(`offers[${index}] must be an object with offerId`, { field: 'offers' });
    }
    const normalized = {
      offerId: requireText(offer.offerId, `offers[${index}].offerId`, 256),
      name: typeof offer.name === 'string' && offer.name.trim() !== '' ? offer.name.slice(0, 256) : null,
      priceCents: null,
      currency: null,
      maxDiscountBps: null,
    };
    if (offer.priceCents !== undefined && offer.priceCents !== null) {
      if (!Number.isSafeInteger(offer.priceCents) || offer.priceCents < 0) {
        throw new ValidationError(`offers[${index}].priceCents must be an integer of at least 0`, { field: 'offers' });
      }
      normalized.priceCents = offer.priceCents;
    }
    if (offer.currency !== undefined && offer.currency !== null) {
      if (typeof offer.currency !== 'string' || !/^[A-Z]{3}$/.test(offer.currency)) {
        throw new ValidationError(`offers[${index}].currency must be a three-letter code`, { field: 'offers' });
      }
      normalized.currency = offer.currency;
    }
    if (offer.maxDiscountBps !== undefined && offer.maxDiscountBps !== null) {
      if (!Number.isSafeInteger(offer.maxDiscountBps) || offer.maxDiscountBps < 0 || offer.maxDiscountBps > 10_000) {
        throw new ValidationError(`offers[${index}].maxDiscountBps must be an integer 0-10000`, { field: 'offers' });
      }
      normalized.maxDiscountBps = offer.maxDiscountBps;
    }
    return normalized;
  });
}

/**
 * The space discount policy: the ceiling the model is told and the domain
 * enforces. A line above the ceiling refuses with
 * `OFFER_DRAFT_DISCOUNT_ABOVE_POLICY` instead of entering the draft at a
 * discount nobody approved. Null means the space sets no ceiling beyond the
 * per-offer ones (a 100% line with no ceiling at all still refuses as
 * needing an approval flow the draft does not carry).
 */
function normalizePolicy(policy) {
  if (policy === undefined || policy === null) return { maxDiscountBps: null, currency: null };
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ValidationError('policy must be an object with maxDiscountBps', { field: 'policy' });
  }
  const normalized = { maxDiscountBps: null, currency: null };
  if (policy.maxDiscountBps !== undefined && policy.maxDiscountBps !== null) {
    if (!Number.isSafeInteger(policy.maxDiscountBps) || policy.maxDiscountBps < 0 || policy.maxDiscountBps > 10_000) {
      throw new ValidationError('policy.maxDiscountBps must be an integer 0-10000', { field: 'policy' });
    }
    normalized.maxDiscountBps = policy.maxDiscountBps;
  }
  if (policy.currency !== undefined && policy.currency !== null) {
    if (typeof policy.currency !== 'string' || !/^[A-Z]{3}$/.test(policy.currency)) {
      throw new ValidationError('policy.currency must be a three-letter code', { field: 'policy' });
    }
    normalized.currency = policy.currency;
  }
  return normalized;
}

/** The member's sentence, trimmed: the panel caps the input at 500. */
function normalizePrompt(prompt) {
  const text = requireText(prompt, 'prompt', MAX_OFFER_DRAFT_PROMPT_CHARS).trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new ValidationError('prompt carries no control characters', { field: 'prompt' });
  }
  return text;
}

/**
 * Build the bounded messages for the model: the eligible offers with their
 * unit prices, the discount ceiling, then the member's sentence. The model
 * answers with one JSON object only. It names lines, never money: the total
 * is computed here, so the model cannot invent an amount.
 */
/**
 * The effective discount ceiling for one offer under a space policy: the
 * tightest bound wins, so a per-offer allowance can never loosen the space
 * ceiling (and vice versa). Null when neither side sets one.
 */
export function effectiveDiscountCeiling(offerMaxDiscountBps, policyMaxDiscountBps) {
  const caps = [offerMaxDiscountBps, policyMaxDiscountBps]
    .filter((cap) => cap !== null && cap !== undefined);
  return caps.length === 0 ? null : Math.min(...caps);
}

export function buildOfferDraftMessages({ prompt, offers, policy }) {
  // The space ceiling is the space policy's own: a per-offer allowance binds
  // only its own line (shown beside that offer below), so the message never
  // shows the minimum of the two as if it were the space rule.
  const ceiling = policy.maxDiscountBps ?? null;
  // The prompt never carries more than MAX_OFFER_DRAFT_PROMPT_OFFERS: the
  // model only ever chooses among listed offers, and the caller caps the
  // eligible catalog to the same fifty, so the two agree on what drafts.
  const listed = offers.slice(0, MAX_OFFER_DRAFT_PROMPT_OFFERS);
  const offerLines = listed.map((offer) => {
    const price = offer.priceCents === null ? 'prezzo a listino' : `${offer.priceCents} cent`;
    const cap = effectiveDiscountCeiling(offer.maxDiscountBps, policy.maxDiscountBps);
    return `- ${offer.offerId}${offer.name ? ` — ${offer.name}` : ''} (${price}`
      + `${cap === null || cap === undefined ? '' : `, sconto massimo ${cap / 100}%`})`;
  }).join('\n');
  return [
    {
      role: 'system',
      content: 'Sei il compilatore della bozza di offerta del backoffice. Rispondi SOLO con un oggetto JSON, senza testo fuori dall\u2019oggetto. '
        + 'Forma: {"title"?: string, "expectedCloseDate"?: "YYYY-MM-DD", "lines": [{"offerId": string, "quantity"?: integer >= 1, "discountBps"?: integer 0-10000}]}. '
        + 'offerId deve essere uno di quelli elencati, quantity un intero positivo (1 se omesso), discountBps lo sconto in punti base (100 = 1%, 1000 = 10%). '
        + 'Non inventare mai offerte: se nessuna offerta elencata risponde alla richiesta, rispondi {"lines": []}. '
        + 'Non superare mai lo sconto massimo indicato per ciascuna offerta. '
        + 'Il titolo è una riga in italiano che riassume la richiesta; la data di chiusura attesa solo se la richiesta la indica o è ovvia, altrimenti omettila. '
        + 'Decidi dal contesto senza chiedere chiarimenti: non fare mai domande, completa il compito con i dati dati.',
    },
    {
      role: 'user',
      content: `Offerte tra cui scegliere (solo queste):\n${offerLines}\n\n`
        + `Sconto massimo di spazio: ${ceiling === null ? 'nessun tetto oltre quelli delle offerte' : `${ceiling / 100}%`}.\n\n`
        + `Richiesta dell\u2019operatore: ${prompt}`,
    },
  ];
}

/** Strip fenced code blocks the model may wrap around the JSON object. */
function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError('the offer model did not answer a JSON object: no draft is suggested', {
      code: 'OFFER_DRAFT_INVALID', status: 500,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('the offer model did not answer a JSON object: no draft is suggested', {
      code: 'OFFER_DRAFT_INVALID', status: 500,
    });
  }
  return parsed;
}

/**
 * A real calendar date in `YYYY-MM-DD`, or null when the model answered no
 * usable date. An unshapable date refuses the whole call: a closing date the
 * model invented in the wrong shape must never reach the panel.
 */
function normalizeCloseDate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('the offer model did not answer a usable closing date', {
      code: 'OFFER_DRAFT_DATE_INVALID', status: 500,
    });
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('the offer model did not answer a usable closing date', {
      code: 'OFFER_DRAFT_DATE_INVALID', status: 500,
    });
  }
  return value;
}

/** A panel title: one trimmed line, or null when the model answered none. */
function normalizeTitle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_OFFER_DRAFT_TITLE_CHARS);
}

/**
 * Suggest one offer draft from the member's sentence.
 *
 * @param {{
 *   prompt: string,
 *   offers: Array<{offerId: string, name?: string, priceCents?: number | null, currency?: string | null, maxDiscountBps?: number | null}>,
 *   policy?: {maxDiscountBps?: number | null, currency?: string | null} | null,
 *   complete?: ((request: {messages: Array<{role: string, content: string}>, maxTokens: number}) => Promise<{text: string, dryRun?: boolean}>) | null,
 *   maxTokens?: number
 * }} input
 */
export async function suggestOfferDraft({
  prompt, offers, policy = null, complete, maxTokens = 1024,
}) {
  const sentence = normalizePrompt(prompt);
  const catalog = normalizeOffers(offers ?? []).slice(0, MAX_OFFER_DRAFT_PROMPT_OFFERS);
  const spacePolicy = normalizePolicy(policy);
  if (catalog.length === 0) {
    return Object.freeze({
      status: 'no-evidence',
      reason: 'no eligible offers to draft from',
      draft: null,
      refused: Object.freeze([]),
    });
  }
  if (complete === undefined || complete === null) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'no completion function was provided: the draft stays off until the caller wires one (for example the llm-complete@1 capability)',
      draft: null,
      refused: Object.freeze([]),
    });
  }
  if (typeof complete !== 'function') {
    throw new ValidationError('complete must be a function or null', { field: 'complete' });
  }
  const offerById = new Map(catalog.map((offer) => [offer.offerId, offer]));
  const messages = buildOfferDraftMessages({ prompt: sentence, offers: catalog, policy: spacePolicy });

  /** @type {{ text: string, dryRun?: boolean }} */
  let answer;
  try {
    answer = await complete({ messages, maxTokens });
  } catch (error) {
    if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === 'LLM_SPACE_DISABLED') {
      return Object.freeze({
        status: 'llm-disabled',
        reason: String(/** @type {any} */ (error).message ?? 'AI is not enabled for this space').slice(0, 200),
        draft: null,
        refused: Object.freeze([]),
      });
    }
    throw error;
  }
  if (answer?.dryRun === true) {
    throw new AppError('the offer model answered without its key', {
      code: 'OFFER_DRAFT_DRY_RUN', status: 500,
    });
  }
  const parsed = extractJsonObject(answer?.text);
  const lines = Array.isArray(parsed.lines) ? parsed.lines : null;
  if (lines === null) {
    throw new AppError('the offer model did not answer usable lines', {
      code: 'OFFER_DRAFT_INVALID', status: 500,
    });
  }
  const accepted = [];
  const refused = [];
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const refuse = (code, reason) => refused.push({ index, code, reason });
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      refuse('OFFER_DRAFT_LINE_INVALID', 'the line is not an object');
      continue;
    }
    const offerId = typeof item.offerId === 'string' ? item.offerId : '';
    const offer = offerById.get(offerId);
    if (!offer) {
      refuse('OFFER_DRAFT_UNKNOWN_OFFER', `unknown offerId "${offerId.slice(0, 80)}": only the listed offers can be drafted`);
      continue;
    }
    let quantity;
    try {
      quantity = item.quantity === undefined ? 1 : requireQuantity(item.quantity, `lines[${index}].quantity`);
    } catch {
      refuse('OFFER_DRAFT_QUANTITY_INVALID', 'quantity must be an integer of at least 1');
      continue;
    }
    let discountBps = 0;
    if (item.discountBps !== undefined) {
      if (!Number.isSafeInteger(item.discountBps) || item.discountBps < 0 || item.discountBps > 10_000) {
        refuse('OFFER_DRAFT_DISCOUNT_INVALID', 'discountBps must be an integer 0-10000 when present');
        continue;
      }
      discountBps = item.discountBps;
    }
    const ceiling = effectiveDiscountCeiling(offer.maxDiscountBps, spacePolicy.maxDiscountBps);
    if (ceiling !== null && discountBps > ceiling) {
      refuse('OFFER_DRAFT_DISCOUNT_ABOVE_POLICY', `discountBps ${discountBps} exceeds the ${ceiling} ceiling`);
      continue;
    }
    if (ceiling === null && discountBps >= 10_000) {
      refuse('OFFER_DRAFT_DISCOUNT_ABOVE_POLICY', 'a 100% line needs an approval flow the draft does not carry');
      continue;
    }
    if (accepted.length >= MAX_OFFER_DRAFT_LINES) {
      refuse('OFFER_DRAFT_OVER_LIMIT', `at most ${MAX_OFFER_DRAFT_LINES} lines per draft`);
      continue;
    }
    accepted.push(Object.freeze({ offer: offer.offerId, quantity, discountBps }));
  }
  // The money is computed here from catalog prices, never taken from the
  // model: a line without a catalog price keeps the draft honest by
  // leaving the total out rather than guessing it. Each line nets through
  // the one domain rounding rule, money.applyDiscount() — the draft owns no
  // rounding formula of its own — and an overflow keeps the total out rather
  // than emitting a rounded-up lie. A total is only emitted when every
  // accepted line shares one currency that the space policy does not
  // contradict: mixed or relabelled currencies leave both valueCents and
  // currency out rather than sending a mislabelled total.
  const acceptedCurrencies = accepted.map(({ offer: id }) => offerById.get(id)?.currency ?? null);
  const unanimousCurrency = acceptedCurrencies.length > 0 && acceptedCurrencies.every((currency) => currency !== null && currency === acceptedCurrencies[0])
    ? /** @type {string} */ (acceptedCurrencies[0])
    : null;
  const currencySupported = unanimousCurrency !== null
    && (spacePolicy.currency === null || spacePolicy.currency === unanimousCurrency);
  let valueCents = null;
  if (
    accepted.length > 0
    && currencySupported
    && accepted.every(({ offer: id }) => offerById.get(id)?.priceCents !== null)
  ) {
    try {
      let total = 0;
      for (const { offer: id, quantity, discountBps } of accepted) {
        const price = /** @type {number} */ (offerById.get(id)?.priceCents);
        const list = checkedMultiply(price, quantity, 'offer draft list');
        total = checkedAdd(total, applyDiscount(list, discountBps).netAmountCents, 'offer draft total');
      }
      valueCents = total;
    } catch {
      valueCents = null;
    }
  }
  const currency = currencySupported ? unanimousCurrency : null;
  const validatedCloseDate = normalizeCloseDate(parsed.expectedCloseDate);
  const expectedCloseDate = accepted.length === 0 ? null : validatedCloseDate;
  const title = accepted.length === 0 ? null : normalizeTitle(parsed.title);
  // The rows the panel renders (backlog:8efd56406c7e): one per accepted
  // catalog offer, in model order, with the catalog's own product (offerId
  // and name), quantity, unit price and the line discount. The line net is
  // the same applyDiscount() rule as the total, per line; a line without a
  // catalog price carries no net rather than a guessed one, exactly like
  // the total. catalogOfferIds stays beside lines for the older panel.
  const rows = Object.freeze(accepted.map(({ offer: id, quantity, discountBps }) => {
    const catalogOffer = offerById.get(id);
    let netCents = null;
    if (catalogOffer?.priceCents !== null && catalogOffer?.priceCents !== undefined) {
      try {
        const list = checkedMultiply(catalogOffer.priceCents, quantity, 'offer draft list');
        netCents = applyDiscount(list, discountBps).netAmountCents;
      } catch {
        netCents = null;
      }
    }
    return Object.freeze({
      offerId: id,
      ...(typeof catalogOffer?.name === 'string' && catalogOffer.name !== '' ? { name: catalogOffer.name } : {}),
      quantity,
      ...(catalogOffer?.priceCents !== null && catalogOffer?.priceCents !== undefined ? { priceCents: catalogOffer.priceCents } : {}),
      ...(typeof catalogOffer?.currency === 'string' ? { currency: catalogOffer.currency } : {}),
      discountBps,
      ...(netCents === null ? {} : { netCents }),
    });
  }));
  const draft = {
    ...(title === null ? {} : { title }),
    ...(valueCents === null ? {} : { valueCents }),
    ...(currency === null ? {} : { currency }),
    ...(expectedCloseDate === null ? {} : { expectedCloseDate }),
    catalogOfferIds: Object.freeze([...new Set(accepted.map(({ offer }) => offer))]),
    lines: rows,
  };
  return Object.freeze({
    status: 'ok',
    reason: null,
    draft: Object.freeze(draft),
    refused: Object.freeze(refused),
  });
}
