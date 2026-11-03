// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The customer message draft (backlog:5194f583).
 *
 * The scheda cliente composer asks for three ready-to-send wordings of one
 * operator intent — short, long and direct — plus the email subject line
 * and the suggested channel. This module is the framework side: it builds
 * the prompt from the card's own history, calls the package's `complete`
 * handle (purpose `assistant`, so the spend is audited exactly like every
 * other assistant call), and parses the model's answer back into the
 * labeled shape the composer renders.
 *
 * It reuses and never duplicates (MEM_ACC_REUSE):
 * - spend, caps, dry-run and audit stay inside `complete` — this module
 *   passes one purpose and reads one result, adding no second billing path;
 * - the channel membership rule is the caller's: the pilot hands over the
 *   card's connected channels and this module only enforces that the
 *   suggestion names one of them (falling back to the first), so the
 *   seven-channel vocabulary keeps its single home in `packages/channels`
 *   and is never re-declared here;
 * - the single-paragraph bound mirrors the message text the framework's
 *   interaction log accepts, so a draft the model returns is sendable
 *   without a second refusal at send time.
 *
 * What is deliberately NOT here: any storage, any session, any HTTP. The
 * pilot owns the route and the worker owns the history read; this module
 * takes values and returns values, which is also what makes it testable
 * against a fake `complete`.
 */

/** The purpose this draft spends as: the assistant's own audited workload. */
export const MESSAGE_DRAFT_PURPOSE = 'assistant';

/** The three labels the composer renders, in the order it renders them. */
export const MESSAGE_DRAFT_KINDS = Object.freeze(['corta', 'lunga', 'diretta']);

export const MESSAGE_DRAFT_MAX_INTENT_CHARS = 500;
export const MESSAGE_DRAFT_MAX_HISTORY = 20;
export const MESSAGE_DRAFT_MAX_HISTORY_TEXT_CHARS = 2000;
export const MESSAGE_DRAFT_MAX_VARIANT_CHARS = 2000;
export const MESSAGE_DRAFT_MAX_SUBJECT_CHARS = 200;
export const MESSAGE_DRAFT_MAX_NAME_CHARS = 100;
export const MESSAGE_DRAFT_MAX_CHANNELS = 11;

/** Control characters no draft, subject or intent may carry. */
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9f]/;

const CHANNEL_SHAPE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * @param {unknown} value @param {string} field @param {number} max
 * @param {boolean} allowNewlines
 */
function boundedText(value, field, max, allowNewlines) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`message draft ${field} must be non-empty text`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ValidationError(`message draft ${field} is at most ${max} characters`, { field });
  }
  const probe = allowNewlines ? text.replace(/\n|\t/g, '') : text;
  if (CONTROL_RE.test(probe)) {
    throw new ValidationError(`message draft ${field} carries no control characters`, { field });
  }
  return text;
}

/** @param {unknown} history */
function assertHistory(history) {
  if (!Array.isArray(history) || history.length > MESSAGE_DRAFT_MAX_HISTORY) {
    throw new ValidationError(
      `message draft history must be an array of at most ${MESSAGE_DRAFT_MAX_HISTORY} entries`,
      { field: 'history' },
    );
  }
  return Object.freeze(history.map((entry, index) => {
    const field = `history[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('message draft history entry must be a plain object', { field });
    }
    const { direction, text } = /** @type {Record<string, unknown>} */ (entry);
    if (direction !== 'in' && direction !== 'out') {
      throw new ValidationError("message draft history direction is 'in' or 'out'", { field: `${field}.direction` });
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > MESSAGE_DRAFT_MAX_HISTORY_TEXT_CHARS) {
      throw new ValidationError(
        `message draft history text is bounded non-empty text (at most ${MESSAGE_DRAFT_MAX_HISTORY_TEXT_CHARS} characters)`,
        { field: `${field}.text` },
      );
    }
    return Object.freeze({ direction, text: text.trim() });
  }));
}

/** @param {unknown} connectedChannels */
function assertConnectedChannels(connectedChannels) {
  if (!Array.isArray(connectedChannels)
    || connectedChannels.length < 1
    || connectedChannels.length > MESSAGE_DRAFT_MAX_CHANNELS) {
    throw new ValidationError(
      `message draft connectedChannels must list 1-${MESSAGE_DRAFT_MAX_CHANNELS} channels`,
      { field: 'connectedChannels' },
    );
  }
  return Object.freeze(connectedChannels.map((channel, index) => {
    if (typeof channel !== 'string' || !CHANNEL_SHAPE.test(channel)) {
      throw new ValidationError('message draft channel must be a bounded lowercase slug', {
        field: `connectedChannels[${index}]`,
      });
    }
    return channel;
  }));
}

/**
 * Validate the draft request. Throws fail-closed; returns the frozen
 * request the prompt builder and the caller execute.
 */
export function assertMessageDraftInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('message draft input must be a plain object', { field: 'input' });
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  return Object.freeze({
    customerName: boundedText(value.customerName, 'customerName', MESSAGE_DRAFT_MAX_NAME_CHARS, false),
    history: assertHistory(value.history),
    intent: boundedText(value.intent, 'intent', MESSAGE_DRAFT_MAX_INTENT_CHARS, false),
    connectedChannels: assertConnectedChannels(value.connectedChannels),
  });
}

/**
 * Build the completion messages for one draft. Pure: the acceptance pins
 * that the card's own data reaches the model — the customer name and the
 * latest inbound line travel verbatim — so the test reads them back from
 * exactly what this function returns.
 *
 * @param {{customerName: string, history: Array<{direction: string, text: string}>, intent: string, connectedChannels: string[]}} draft
 */
export function buildMessageDraftPrompt(draft) {
  const checked = assertMessageDraftInput(draft);
  const lines = checked.history.map((entry) => `- ${entry.direction === 'in' ? 'cliente' : 'team'}: ${entry.text}`);
  const user = [
    `Cliente: ${checked.customerName}`,
    'Cronologia della scheda (dalla meno recente alla più recente):',
    ...(lines.length > 0 ? lines : ['- (nessun messaggio precedente)']),
    `Canali collegati alla scheda: ${checked.connectedChannels.join(', ')}`,
    `Intenzione dell'operatore: ${checked.intent}`,
    '',
    'Scrivi tre versioni del messaggio da inviare al cliente per questa intenzione,',
    'tenendo conto del tono della cronologia. Rispondi SOLO con un oggetto JSON,',
    'senza testo prima o dopo, con esattamente queste chiavi:',
    '{"corta": "<una frase breve>", "lunga": "<versione completa e cortese>",',
    ' "diretta": "<versione schietta>", "oggetto": "<oggetto per email>",',
    ` "canale": "<uno tra: ${checked.connectedChannels.join(', ')}>"} —`,
    'il canale suggerito deve essere uno di quelli collegati.',
  ].join('\n');
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        role: 'system',
        content: 'Sei l\u2019assistente che scrive i messaggi di un team italiano verso i suoi clienti. '
          + 'Scrivi in italiano, tono cordiale e concreto, mai formale. Rispondi solo con il JSON richiesto.',
      }),
      Object.freeze({ role: 'user', content: user }),
    ]),
  });
}

/**
 * Parse one model answer back into the labeled draft. The suggestion must
 * name a connected channel: anything else falls back to the first
 * connected one rather than inventing a route the card cannot send on.
 *
 * @param {unknown} text @param {string[]} connectedChannels
 */
export function parseMessageDraftResponse(text, connectedChannels) {
  const channels = assertConnectedChannels(connectedChannels);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AppError('the model did not answer a usable draft', {
      code: 'MESSAGE_DRAFT_INVALID', status: 502,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new AppError('the model did not answer a usable draft', {
      code: 'MESSAGE_DRAFT_INVALID', status: 502,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('the model did not answer a usable draft', {
      code: 'MESSAGE_DRAFT_INVALID', status: 502,
    });
  }
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const variants = {};
  for (const kind of MESSAGE_DRAFT_KINDS) {
    variants[kind] = boundedText(record[kind], kind, MESSAGE_DRAFT_MAX_VARIANT_CHARS, true);
  }
  const oggetto = boundedText(record.oggetto, 'oggetto', MESSAGE_DRAFT_MAX_SUBJECT_CHARS, false);
  const suggested = typeof record.canale === 'string' ? record.canale.trim() : '';
  const canale = channels.includes(suggested) ? suggested : channels[0];
  return Object.freeze({ ...variants, oggetto, canale });
}

/**
 * Draft one customer message through the package's `complete` handle.
 * The space, the caps and the audit are `complete`'s own: a disabled
 * space refuses with `LLM_SPACE_DISABLED` and a missing key with
 * `LLM_SECRET_UNAVAILABLE` before any provider is touched, and the pilot
 * maps those two codes to its clear Italian answer.
 *
 * @param {{complete: (request: any) => Promise<any>, spaceId: string, actor: unknown,
 *   customerName: string, history: unknown, intent: string, connectedChannels: unknown,
 *   maxTokens?: number}} input
 */
export async function draftCustomerMessage({
  complete, spaceId, actor, customerName, history, intent, connectedChannels, maxTokens = 1024,
}) {
  if (typeof complete !== 'function') {
    throw new ValidationError('message draft needs the llm complete handle', { field: 'complete' });
  }
  const checked = assertMessageDraftInput({ customerName, history, intent, connectedChannels });
  const { messages } = buildMessageDraftPrompt(checked);
  const result = await complete({
    actor, spaceId, purpose: MESSAGE_DRAFT_PURPOSE, messages, maxTokens,
  });
  const parsed = parseMessageDraftResponse(result?.text, [...checked.connectedChannels]);
  return Object.freeze({ ...parsed, dryRun: result?.dryRun === true });
}
