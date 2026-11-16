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
/**
 * Up to twenty history entries, as on main: the count cap alone cannot
 * enforce the provider per-message fence (eleven short entries fit it
 * easily while twenty full-length ones do not), so the built user
 * message is measured below and only a prompt that truly exceeds the
 * 32000-character fence the llm adapter enforces
 * (packages/llm/src/adapter.js) refuses, fail-closed, before any
 * provider is touched (backlog:a1c597a4, review giro 1).
 */
export const MESSAGE_DRAFT_MAX_HISTORY = 20;
/** The provider per-message bound the built prompt is measured against. */
const MESSAGE_DRAFT_MAX_PROMPT_CHARS = 32000;
export const MESSAGE_DRAFT_MAX_HISTORY_TEXT_CHARS = 2000;
export const MESSAGE_DRAFT_MAX_VARIANT_CHARS = 2000;
export const MESSAGE_DRAFT_MAX_SUBJECT_CHARS = 200;
export const MESSAGE_DRAFT_MAX_NAME_CHARS = 100;
export const MESSAGE_DRAFT_MAX_CHANNELS = 11;
/** One playbook field, as the member compiled it: concrete text, never a paragraph of prose. */
export const MESSAGE_DRAFT_MAX_PLAYBOOK_FIELD_CHARS = 2000;

/**
 * The playbook fields the draft may quote, in the order the prompt reads
 * them: who the space is, what it sells, to whom, in what tone, what it
 * never says, where to point, when it is open.
 */
export const MESSAGE_DRAFT_PLAYBOOK_FIELDS = Object.freeze([
  'companyName',
  'description',
  'products',
  'idealCustomer',
  'tone',
  'avoidTopics',
  'links',
  'hours',
]);

/**
 * Control characters no draft, subject or intent may carry: the line feed
 * aside, the same fence as the interaction log's safeMessageBody
 * (packages/interactions/src/interactions.js) and the composer timeline
 * row (packages/channels/src/composer-text.js), mirrored here so a draft
 * accepted here is never refused downstream at send time (backlog:a1c597a4).
 * In particular the tab, the carriage return and U+2028/U+2029 refuse here
 * exactly as they refuse there; only `\n` may pass, and only in the three
 * variants.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const CHANNEL_SHAPE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * @param {unknown} value @param {string} field @param {number} max
 * @param {boolean} allowNewlines
 */
function boundedText(value, field, max, allowNewlines) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`message draft ${field} must be non-empty text`, { field });
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > max) {
    throw new ValidationError(`message draft ${field} is at most ${max} characters`, { field });
  }
  const probe = allowNewlines ? text.replace(/\n/g, '') : text;
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
 * Validate the space playbook the draft writes from, or null when the
 * space compiled none (backlog:ad7e03ac: with the AI off the member
 * compiles the playbook by hand, and one may equally be absent). A
 * non-object refuses fail-closed; a missing or empty field stays null so
 * the prompt quotes only what the member wrote; a playbook with no usable
 * field answers null, never an empty context block.
 *
 * @param {unknown} playbook
 */
export function assertMessageDraftPlaybook(playbook) {
  if (playbook === undefined || playbook === null) return null;
  if (typeof playbook !== 'object' || Array.isArray(playbook)) {
    throw new ValidationError('message draft playbook must be a plain object', { field: 'playbook' });
  }
  const value = /** @type {Record<string, unknown>} */ (playbook);
  const normalized = {};
  for (const field of MESSAGE_DRAFT_PLAYBOOK_FIELDS) {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      normalized[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw new ValidationError(`message draft playbook ${field} must be text`, { field: `playbook.${field}` });
    }
    const text = raw.replace(/\r\n/g, '\n').trim();
    if (text === '') {
      normalized[field] = null;
      continue;
    }
    if (text.length > MESSAGE_DRAFT_MAX_PLAYBOOK_FIELD_CHARS) {
      throw new ValidationError(
        `message draft playbook ${field} is at most ${MESSAGE_DRAFT_MAX_PLAYBOOK_FIELD_CHARS} characters`,
        { field: `playbook.${field}` },
      );
    }
    if (CONTROL_RE.test(text.replace(/\n/g, ''))) {
      throw new ValidationError(`message draft playbook ${field} carries no control characters`, {
        field: `playbook.${field}`,
      });
    }
    normalized[field] = text;
  }
  if (Object.values(normalized).every((entry) => entry === null)) return null;
  return Object.freeze(normalized);
}

/**
 * Render one validated playbook as the prompt's context block, or null
 * when the space compiled none. Pure: the acceptance pins that two
 * playbooks give the same request a different context, so the test reads
 * the difference back from exactly what this function returns.
 *
 * @param {{companyName: string | null, description: string | null, products: string | null, idealCustomer: string | null, tone: string | null, avoidTopics: string | null, links: string | null, hours: string | null} | null} playbook
 */
export function buildPlaybookContextBlock(playbook) {
  const checked = assertMessageDraftPlaybook(playbook);
  if (checked === null) return null;
  const labels = {
    companyName: 'Azienda',
    description: 'Cosa fa',
    products: 'Cosa vende',
    idealCustomer: 'A chi vende',
    tone: 'Tono di voce',
    avoidTopics: 'Cose da non dire mai',
    links: 'Link utili',
    hours: 'Orari',
  };
  const lines = ['Playbook dello spazio (chi siamo, cosa vendiamo, a chi):'];
  for (const field of MESSAGE_DRAFT_PLAYBOOK_FIELDS) {
    const text = checked[field];
    if (typeof text === 'string' && text !== '') {
      lines.push(`- ${labels[field]}: ${text.replace(/\n/g, ' | ')}`);
    }
  }
  if (lines.length === 1) return null;
  return lines.join('\n');
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
    playbook: assertMessageDraftPlaybook(value.playbook ?? null),
  });
}

/**
 * Build the completion messages for one draft. Pure: the acceptance pins
 * that the card's own data reaches the model — the customer name and the
 * latest inbound line travel verbatim — so the test reads them back from
 * exactly what this function returns. The space playbook rides the same
 * road (backlog:ad7e03ac): with different playbooks the same request
 * produces a different context, with none the prompt stays as on main.
 *
 * @param {{customerName: string, history: Array<{direction: string, text: string}>, intent: string, connectedChannels: string[], playbook?: unknown}} draft
 */
export function buildMessageDraftPrompt(draft) {
  const checked = assertMessageDraftInput(draft);
  const lines = checked.history.map((entry) => `- ${entry.direction === 'in' ? 'cliente' : 'team'}: ${entry.text}`);
  const playbookBlock = buildPlaybookContextBlock(checked.playbook);
  const user = [
    `Cliente: ${checked.customerName}`,
    ...(playbookBlock === null ? [] : [playbookBlock]),
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
  // Voce a1c597a4, review giro 1: the count cap is not the fence — measure
  // what would actually travel. Only a user message past the 32000
  // per-message bound the adapter enforces refuses here, fail-closed,
  // before any provider is touched; shorter full histories draft as
  // on main.
  if (user.length > MESSAGE_DRAFT_MAX_PROMPT_CHARS) {
    throw new ValidationError(
      `message draft prompt is ${user.length} characters: at most ${MESSAGE_DRAFT_MAX_PROMPT_CHARS} fit the provider per-message fence`,
      { field: 'prompt' },
    );
  }
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
 *   playbook?: unknown, maxTokens?: number, organizationId?: string}} input
 */
export async function draftCustomerMessage({
  complete, spaceId, actor, customerName, history, intent, connectedChannels, playbook = null,
  maxTokens = 1024, organizationId = undefined,
}) {
  if (typeof complete !== 'function') {
    throw new ValidationError('message draft needs the llm complete handle', { field: 'complete' });
  }
  const checked = assertMessageDraftInput({ customerName, history, intent, connectedChannels, playbook });
  const { messages } = buildMessageDraftPrompt(checked);
  const result = await complete({
    actor, spaceId, purpose: MESSAGE_DRAFT_PURPOSE, messages, maxTokens,
    // Voce 5c9e006a: the caller organization, threaded by the caller from
    // the verified identity (never the body), so `complete` refuses spend
    // on another organization's space. Absent keeps historic behavior.
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  // Voce a1c597a4, review giro 1: the no-key dry run answers the
  // fixture's literal 'fixture answer', which is not the labeled JSON
  // the model owes — parsing it failed every dry run. A dry run answers
  // without error but stays off, following the product-import off-status
  // pattern: no presentable wording rides a dry run, only the reason,
  // so a pilot that misses the flag can neither render nor dispatch
  // fixture text as model wording. The success shape is untouched.
  // DECISION (to be confirmed): off-status instead of a thrown
  // MESSAGE_DRAFT_DRY_RUN because the acceptance pins a dry run that
  // responds without error; the pilot must branch on status/dryRun
  // before reading any draft, and no production pilot exists yet.
  if (result?.dryRun === true) {
    return Object.freeze({
      status: 'llm-disabled',
      reason: 'the completion ran as a dry run without a key: the message draft stays off, retry with a key instead',
      draft: null,
      dryRun: true,
    });
  }
  const parsed = parseMessageDraftResponse(result?.text, [...checked.connectedChannels]);
  return Object.freeze({ ...parsed, dryRun: result?.dryRun === true });
}
