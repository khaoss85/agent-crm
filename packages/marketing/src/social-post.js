// @ts-check

import { AppError } from '../../core/index.js';

/**
 * Squadra social posting (prima slice): proposta Telegram da un articolo,
 * ok umano, tetto di spesa e verifica del post online.
 *
 * Una squadra propone un post Telegram partendo da un articolo già
 * pubblicato; la proposta arriva in Accordo, un umano (Dan) approva e solo
 * dopo l'ok il post esce sul canale Telegram collegato. Il verificatore
 * confronta il post online con la versione approvata; il tetto di spesa è
 * sempre acceso e il costo per post è visibile sulla proposta.
 *
 * Questa slice è volutamente pura: non accoda all'outbox dei canali, non
 * tocca la rete e non spende nulla. Riusa il confine umano di
 * `packages/marketing/src/proposal.js` (solo `actor.type === 'user'`
 * approva), l'adattatore `telegram-bot` di `packages/channels` come unica
 * via di invio futura e i centesimi interi per il denaro. Non copre:
 * accodamento all'outbox, pagina Admin, invio reale e lettura API del
 * canale (il testo online arriva dal verificatore, già prodotto).
 */

/** L'unico canale che la squadra può proporre in questa slice. */
export const SOCIAL_POST_CHANNEL = 'telegram';

/** Gli stati di una proposta social, in ordine di avanzamento. */
export const SOCIAL_POST_STATUSES = Object.freeze(['draft', 'proposed', 'approved', 'published']);

const MAX_TEXT = 4096;
const MAX_TITLE = 280;
const MAX_URL = 2048;

function statedText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/** @param {unknown} value */
function isCents(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalid(message, details) {
  throw new AppError(message, { code: 'SOCIAL_POST_INVALID', status: 400, ...(details ? { details } : {}) });
}

/**
 * Propone un post Telegram da un articolo già pubblicato.
 *
 * @param {{article?: {title?: unknown, text?: unknown, url?: unknown}, text?: unknown, channel?: unknown, costCents?: unknown, proposedAt?: unknown}} [request]
 * @returns {Record<string, any>} proposta congelata in stato `proposed`
 */
export function proposeSocialPost(request = {}) {
  const { article = {}, text, channel, costCents, proposedAt } = request;
  const source = article && typeof article === 'object' ? article : {};
  if (channel !== SOCIAL_POST_CHANNEL) {
    invalid(`A social post proposal names its channel: only "${SOCIAL_POST_CHANNEL}" is supported`, { channel: channel ?? null });
  }
  const body = text ?? source.text;
  if (!statedText(body, MAX_TEXT)) {
    invalid('A social post proposal states the post text (or the article text it derives from)', { field: 'text' });
  }
  const title = source.title;
  const articleUrl = source.url;
  if (title !== undefined && !statedText(title, MAX_TITLE)) {
    invalid('A social post title, when stated, is non-empty text', { field: 'title' });
  }
  if (!statedText(articleUrl, MAX_URL)) {
    invalid('A social post proposal names the published article url it derives from', { field: 'articleUrl' });
  }
  if (!isCents(costCents)) {
    invalid('A social post proposal states its cost in integer cents', { field: 'costCents' });
  }
  if (typeof proposedAt !== 'string' || proposedAt.trim() === '') {
    invalid('A social post proposal states when it was proposed', { field: 'proposedAt' });
  }
  return Object.freeze({
    title: typeof title === 'string' ? title.trim() : null,
    text: String(body).trim(),
    articleUrl: String(articleUrl).trim(),
    channel: SOCIAL_POST_CHANNEL,
    costCents,
    status: 'proposed',
    proposedAt,
  });
}

/**
 * Riesamina una bozza: una proposta incompleta è un dato, mai un'eccezione.
 *
 * @param {Record<string, any>} draft
 * @returns {{complete: boolean, missing: readonly string[]}} congelato
 */
export function reviewSocialPost(draft) {
  const record = draft && typeof draft === 'object' ? draft : {};
  /** @type {string[]} */
  const missing = [];
  if (!statedText(record.text, MAX_TEXT)) missing.push('text');
  if (!statedText(record.articleUrl, MAX_URL)) missing.push('articleUrl');
  if (record.channel !== SOCIAL_POST_CHANNEL) missing.push('channel');
  if (!isCents(record.costCents)) missing.push('costCents');
  return Object.freeze({ complete: missing.length === 0, missing: Object.freeze([...missing]) });
}

/**
 * L'ok umano alla proposta: solo un attore `user` approva, dopo aver
 * ricontrollato la completezza sulla riga salvata (mai sul piano del
 * chiamante). Non scrive nulla: risponde lo snapshot immutabile e la patch.
 *
 * @param {{post?: Record<string, any>, actor?: any, approvedAt?: unknown}} [request]
 */
export function approveSocialPost(request = {}) {
  const { post, actor, approvedAt } = request;
  if (!actor || typeof actor !== 'object' || actor.type !== 'user') {
    throw new AppError('Approving a social post requires a human user actor', {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
  if (!post || typeof post !== 'object') {
    throw new AppError('approveSocialPost needs the stored social post', {
      code: 'SOCIAL_POST_REQUEST_INVALID', status: 400,
    });
  }
  if (post.status !== 'proposed') {
    throw new AppError(`Only a proposed social post can be approved (status: ${String(post.status ?? 'missing')})`, {
      code: 'SOCIAL_POST_STATE_INVALID', status: 409,
    });
  }
  const review = reviewSocialPost(post);
  if (!review.complete) {
    throw new AppError('This social post no longer states text, article url, channel and cost, so it cannot be approved', {
      code: 'SOCIAL_POST_INCOMPLETE', status: 409,
      details: { missing: [...review.missing] },
    });
  }
  if (typeof approvedAt !== 'string' || approvedAt === '') {
    throw new AppError('approveSocialPost needs the approval instant', {
      code: 'SOCIAL_POST_REQUEST_INVALID', status: 400,
    });
  }
  return Object.freeze({
    approval: Object.freeze({
      title: post.title ?? null,
      text: post.text,
      articleUrl: post.articleUrl,
      channel: post.channel,
      costCents: post.costCents,
      approvedBy: String(actor.id ?? 'unknown'),
      approvedAt,
    }),
    postPatch: Object.freeze({
      status: 'approved',
      decidedBy: String(actor.id ?? 'unknown'),
      decidedAt: approvedAt,
    }),
  });
}

/**
 * Tetto di spesa: il tetto è sempre acceso (niente tetto = rifiuto) e il
 * costo del post resta visibile nella risposta.
 *
 * @param {{spentCents?: unknown, costCents?: unknown, capCents?: unknown}} [request]
 * @returns {{allowed: boolean, remainingCents: number, costCents: number}} congelato
 */
export function checkPostSpendCap(request = {}) {
  const { spentCents, costCents, capCents } = request;
  if (!isCents(capCents)) {
    throw new AppError('Publishing a social post requires an explicit spend cap in integer cents', {
      code: 'SOCIAL_POST_CAP_MISSING', status: 409,
    });
  }
  if (!isCents(spentCents)) {
    invalid('checkPostSpendCap states what this space already spent, in integer cents', { field: 'spentCents' });
  }
  if (!isCents(costCents)) {
    invalid('checkPostSpendCap states the post cost, in integer cents', { field: 'costCents' });
  }
  const remaining = capCents - spentCents;
  return Object.freeze({
    allowed: remaining >= costCents,
    remainingCents: remaining,
    costCents,
  });
}

/** Normalizza un testo pubblicato per il confronto: mai riscrittura, solo lettura. */
function normalizePublished(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Verifica del post online: confronta il testo che il canale ha prodotto
 * con la versione approvata. Non riesegue l'invio, legge solo ciò che il
 * canale ha pubblicato.
 *
 * @param {{approvedText?: unknown, onlineText?: unknown}} [request]
 * @returns {{match: boolean, mismatches: readonly string[]}} congelato
 */
export function verifyPublishedPost(request = {}) {
  const { approvedText, onlineText } = request;
  /** @type {string[]} */
  const mismatches = [];
  if (!statedText(approvedText, MAX_TEXT)) mismatches.push('approved-missing');
  if (!statedText(onlineText, MAX_TEXT)) mismatches.push('online-missing');
  if (mismatches.length === 0
    && normalizePublished(onlineText) !== normalizePublished(approvedText)) {
    mismatches.push('text-differs');
  }
  return Object.freeze({ match: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}
