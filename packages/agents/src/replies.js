// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * The inbound-reply agent (backlog:e5dd9214, «Risposte»): when a customer
 * writes in, the agent drafts the answer and the human approves it.
 *
 * One inbound message produces one reply proposal linked to its
 * conversation — never a blind send: the proposal carries the
 * `send-without-approval` permission, so with the switch off the run only
 * records it for approval. With the switch on the deployment sends and
 * counts: after `maxConsecutiveReplies` agent answers in a row on the same
 * conversation the planner halts with `consecutive-cap`, so a human takes
 * the thread back instead of the agent talking alone.
 *
 * It reuses and never duplicates (MEM_ACC_REUSE):
 * - the 24-hour Meta service window stays in `packages/channels`
 *   (`checkMetaServiceWindow`): the caller observes `windowState` from the
 *   channels inbox and passes it in as a value — this module never
 *   re-implements the window and never reads the inbox;
 * - the message wording stays in `packages/llm` (`draftCustomerMessage`):
 *   the caller injects `draftText` and this module only builds the intent
 *   from the conversation's own lines;
 * - approval stays in `packages/agents` (teammate-run, the «Da fare»
 *   queue): the proposal below is one `reply-message` action payload;
 * - customer identity stays in `packages/customer-data`: only the caller's
 *   `customerId` and conversation references travel here.
 *
 * What is deliberately NOT here: any storage, any session, any HTTP, any
 * timer, any send. The pilot owns the inbound event and the send; this
 * module takes values and returns values, which is also what makes it
 * testable against a fake `draftText`.
 *
 * The one invariant the acceptance pins: on a Meta channel outside the
 * window this module never proposes free text — only an approved template
 * or another connected message channel. A slug that carries no message
 * (stripe, calendar, site-form) is never a route: an inbound with no
 * sendable route is skipped with a reason, never forced onto one, and a
 * refused draft keeps its cause beside the `no-draft` skip.
 *
 * An opt-out — the caller's `consent: 'opted-out'` or a do-not-contact
 * line inside the inbound text itself — halts the agent, never a skip the
 * next message could overrule: the thread waits for a human.
 */

/** The proposal kind the approval record stores for one inbound reply. */
export const REPLIES_ACTION_KIND = 'reply-message';

/**
 * The space switch that turns a proposal into an autonomous send. Reused
 * from `packages/space-permissions`, never a new permission: on, the
 * caller sends and counts the streak; off, the caller records the proposal
 * for a human and nothing leaves.
 */
export const REPLIES_PERMISSION = 'send-without-approval';

/** Arrival channels in scope for this agent. */
export const REPLIES_INBOUND_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'email']);

/**
 * Channels whose free text needs the 24-hour window. Mirrors the adapters
 * that declare `outboundWindow` in `packages/channels` (whatsapp.js,
 * instagram.js, messenger.js serving `facebook`): the window itself stays
 * enforced there, this list only steers the route away from free text no
 * channel observation could send.
 */
export const REPLIES_WINDOW_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'facebook']);

/**
 * Channels that carry a free-text reply with no window observation.
 * Mirrors the adapters in `packages/channels` that declare `sendOutbound`
 * and no `outboundWindow` (gmail.js serving `email`, telegram.js): the
 * window itself stays enforced there, this list only steers the fallback
 * away from connected slugs no observation could send (stripe, calendar,
 * site-form, voice, tiktok, sms with no adapter).
 */
export const REPLIES_FREETEXT_CHANNELS = Object.freeze(['email', 'telegram']);

/**
 * After this many agent answers in a row on one conversation the agent
 * stops and hands the thread to a human. DECISION (to be confirmed): 3 —
 * enough for a greeting plus one clarification, never a whole conversation
 * alone. The deployment passes its own count and cap; this is the default.
 */
export const REPLIES_DEFAULT_MAX_CONSECUTIVE = 3;

/** Bounds: customer and conversation references, names, texts, streaks. */
export const REPLIES_MIN_CONSECUTIVE = 1;
export const REPLIES_MAX_CONSECUTIVE = 10;
export const REPLIES_MAX_CUSTOMER_ID = 200;
export const REPLIES_MAX_CONVERSATION_ID = 200;
export const REPLIES_MAX_MESSAGE_ID = 200;
export const REPLIES_MAX_NAME = 100;
export const REPLIES_MAX_INBOUND_TEXT = 4000;
export const REPLIES_MAX_HISTORY = 20;
export const REPLIES_MAX_HISTORY_TEXT = 2000;
/** Cause text kept beside a `no-draft` skip so a refused draft is never silent. */
export const REPLIES_MAX_CAUSE_CHARS = 280;
export const REPLIES_MAX_TEMPLATE_VARIABLES = 32;
export const REPLIES_MAX_TEMPLATE_VARIABLE_CHARS = 1024;

/** The window observation the caller resolves from the channels inbox. */
export const REPLIES_WINDOW_STATES = Object.freeze(['in-window', 'needs-template']);

/** Consent as the caller resolved it from customer-data opt-out. */
export const REPLIES_CONSENTS = Object.freeze(['granted', 'opted-out', 'unknown']);

/**
 * Why an inbound got no proposal: legitimate states, never errors. There
 * is no `no-inbound`: the edge refuses a missing or empty inbound text
 * before planning, so the planner never answers a message it cannot read.
 */
export const REPLIES_SKIP_REASONS = Object.freeze([
  'unsupported-channel',
  'consent-unknown',
  'no-sendable-route',
  'no-draft',
]);

/**
 * Why the agent stops on a thread: a human takes it back. `opted-out`
 * covers both the caller's consent and a do-not-contact line in the
 * inbound text; `consecutive-cap` covers the N-answers-in-a-row autonomy
 * stop.
 */
export const REPLIES_HALT_REASONS = Object.freeze(['opted-out', 'consecutive-cap']);

/** Template names stay provider-shaped; the shape authority is packages/channels. */
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,64}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2}(?:_[A-Z]{2})?$/;

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9f]/;

/**
 * Do-not-contact lines, folded (accents and case) before matching: a
 * customer who writes one of these stops the agent on this thread, even
 * with consent still `granted` — the message itself is the opt-out.
 * Deliberately narrow: only explicit stop lines, never bare sentiment
 * («non mi piace» keeps its proposal).
 */
const OPT_OUT_PATTERNS = Object.freeze([
  'non chiamarmi', 'non chiamate', 'non mi chiamare', 'non mi chiamate',
  'non scrivermi', 'non scrivetemi', 'non mi scrivere', 'non mi scrivete',
  'non mi contattare', 'non contattatemi', 'non contattarmi',
  'cancellami', 'cancellatemi', 'cancella i miei dati',
  'rimuovimi', 'rimuovetemi', 'toglietemi', 'eliminami', 'eliminatemi',
  'non voglio essere contattat', 'non voglio piu essere contattat',
  'smettetela di chiamarmi', 'smettetela di scrivermi',
  'basta messaggi', 'basta chiamate', 'basta telefonate',
  'disiscrivimi', 'disiscrizione', 'unsubscribe', "diritto all'oblio",
]);

/** @param {unknown} value */
function foldReply(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

/** @param {unknown} text */
export function carriesOptOut(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  const folded = foldReply(text);
  if (/(^|[\s.,!?:;()])stop($|[\s.,!?:;()])/.test(folded)) return true;
  return OPT_OUT_PATTERNS.some((pattern) => folded.includes(foldReply(pattern)));
}

/** @param {unknown} value @param {string} field @param {number} max */
function boundedLine(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`replies ${field} must be non-empty text`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ValidationError(`replies ${field} is at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(text)) {
    throw new ValidationError(`replies ${field} carries no control characters`, { field });
  }
  return text;
}

/** @param {unknown} value @param {string} field */
function assertIsoInstant(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`replies ${field} must be an ISO instant`, { field });
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new ValidationError(`replies ${field} must be an ISO instant`, { field });
  }
  return at;
}

/** @param {unknown} history */
function assertHistory(history) {
  if (history === undefined || history === null) return Object.freeze([]);
  if (!Array.isArray(history) || history.length > REPLIES_MAX_HISTORY) {
    throw new ValidationError(
      `replies history must be an array of at most ${REPLIES_MAX_HISTORY} entries`,
      { field: 'history' },
    );
  }
  return Object.freeze(history.map((entry, index) => {
    const field = `history[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('replies history entry must be a plain object', { field });
    }
    const { direction, text } = /** @type {Record<string, unknown>} */ (entry);
    if (direction !== 'in' && direction !== 'out') {
      throw new ValidationError("replies history direction is 'in' or 'out'", { field: `${field}.direction` });
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > REPLIES_MAX_HISTORY_TEXT) {
      throw new ValidationError(
        `replies history text is bounded non-empty text (at most ${REPLIES_MAX_HISTORY_TEXT} characters)`,
        { field: `${field}.text` },
      );
    }
    return Object.freeze({ direction, text: text.trim() });
  }));
}

/** @param {unknown} channels */
function assertConnectedChannels(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 11) {
    throw new ValidationError('replies connectedChannels must list 1-11 channels', { field: 'connectedChannels' });
  }
  return Object.freeze(channels.map((channel, index) => {
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(channel)) {
      throw new ValidationError('replies channel must be a bounded lowercase slug', {
        field: `connectedChannels[${index}]`,
      });
    }
    return channel;
  }));
}

/** @param {unknown} template */
function assertApprovedTemplate(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new ValidationError('replies approvedTemplate must be a plain object', { field: 'approvedTemplate' });
  }
  const record = /** @type {Record<string, unknown>} */ (template);
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new ValidationError('replies template name must be a bounded provider template name', {
      field: 'approvedTemplate.name',
    });
  }
  let language;
  if (record.language !== undefined) {
    if (typeof record.language !== 'string' || !TEMPLATE_LANGUAGE_RE.test(record.language.trim())) {
      throw new ValidationError('replies template language must look like it or it_IT', {
        field: 'approvedTemplate.language',
      });
    }
    language = record.language.trim();
  }
  const rawVariables = record.variables === undefined ? [] : record.variables;
  if (!Array.isArray(rawVariables) || rawVariables.length > REPLIES_MAX_TEMPLATE_VARIABLES) {
    throw new ValidationError(
      `replies template variables are at most ${REPLIES_MAX_TEMPLATE_VARIABLES} bounded texts`,
      { field: 'approvedTemplate.variables' },
    );
  }
  const variables = Object.freeze(rawVariables.map((variable, index) => {
    if (typeof variable !== 'string' || variable.trim() === ''
      || variable.trim().length > REPLIES_MAX_TEMPLATE_VARIABLE_CHARS) {
      throw new ValidationError('replies template variable must be bounded non-empty text', {
        field: `approvedTemplate.variables[${index}]`,
      });
    }
    return variable.trim();
  }));
  return Object.freeze({ name, ...(language === undefined ? null : { language }), variables });
}

/** @param {unknown} value */
function assertConsecutive(value, field) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > REPLIES_MAX_CONSECUTIVE) {
    throw new ValidationError(
      `replies ${field} is an integer 0-${REPLIES_MAX_CONSECUTIVE}`,
      { field },
    );
  }
  return value;
}

/** @param {unknown} value */
function assertMaxConsecutive(value) {
  if (value === undefined || value === null) return REPLIES_DEFAULT_MAX_CONSECUTIVE;
  if (!Number.isInteger(value) || value < REPLIES_MIN_CONSECUTIVE || value > REPLIES_MAX_CONSECUTIVE) {
    throw new ValidationError(
      `replies maxConsecutiveReplies is ${REPLIES_MIN_CONSECUTIVE}-${REPLIES_MAX_CONSECUTIVE}`,
      { field: 'maxConsecutiveReplies' },
    );
  }
  return value;
}

/**
 * Validate one arrived message with its thread. Throws fail-closed on
 * malformed shape; legitimate quiet states (unknown consent, no route)
 * are skips or halts decided later, never refusals.
 *
 * @param {unknown} input
 */
export function assertReplyInbound(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('replies inbound must be a plain object', { field: 'inbound' });
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const messageId = boundedLine(value.messageId, 'messageId', REPLIES_MAX_MESSAGE_ID);
  const conversationId = boundedLine(value.conversationId, 'conversationId', REPLIES_MAX_CONVERSATION_ID);
  const customerId = boundedLine(value.customerId, 'customerId', REPLIES_MAX_CUSTOMER_ID);
  const displayName = boundedLine(value.displayName, 'displayName', REPLIES_MAX_NAME);
  if (typeof value.channel !== 'string' || value.channel.trim() === '') {
    throw new ValidationError('replies channel must be a non-empty slug', { field: 'channel' });
  }
  const channel = value.channel.trim();
  const text = boundedLine(value.text, 'text', REPLIES_MAX_INBOUND_TEXT);
  if (typeof value.at !== 'string' || value.at.trim() === '') {
    throw new ValidationError('replies at must be an ISO instant', { field: 'at' });
  }
  assertIsoInstant(value.at.trim(), 'at');
  const at = value.at.trim();
  if (typeof value.consent !== 'string' || !REPLIES_CONSENTS.includes(value.consent)) {
    throw new ValidationError(`replies consent is one of ${REPLIES_CONSENTS.join(', ')}`, {
      field: 'consent',
    });
  }
  const connectedChannels = assertConnectedChannels(value.connectedChannels);
  let windowState = null;
  if (REPLIES_WINDOW_CHANNELS.includes(channel)) {
    if (typeof value.windowState !== 'string' || !REPLIES_WINDOW_STATES.includes(value.windowState)) {
      throw new ValidationError(
        `replies windowState is one of ${REPLIES_WINDOW_STATES.join(', ')} on a windowed channel`,
        { field: 'windowState' },
      );
    }
    windowState = value.windowState;
  }
  let approvedTemplate = null;
  if (value.approvedTemplate !== undefined && value.approvedTemplate !== null) {
    approvedTemplate = assertApprovedTemplate(value.approvedTemplate);
  }
  const history = assertHistory(value.history);
  return Object.freeze({
    messageId, conversationId, customerId, displayName, channel, text, at,
    consent: value.consent, connectedChannels, windowState, approvedTemplate, history,
  });
}

/**
 * Keep the cause of a refused draft beside the `no-draft` skip: the
 * wording edge threw, so the message or code it threw with is the reason
 * — a fixed word when the edge answered with unusable text instead.
 *
 * @param {unknown} error
 */
function draftRefusalCause(error) {
  const fromError = error instanceof Error ? (error.message || error.code || 'unknown') : error;
  const raw = String(fromError ?? 'unknown');
  const text = raw.trim().slice(0, REPLIES_MAX_CAUSE_CHARS);
  return text === '' ? 'unknown' : text;
}

/**
 * Pick the sendable route for one inbound. The acceptance invariant: a
 * windowed channel outside the window never yields free text — only an
 * approved template (whatsapp, the sole adapter with template sends),
 * another connected message channel, or no route at all. Instagram and
 * Messenger document no template fallback, so their needs-template
 * inbounds fall through to the fallback below. A channel that carries no
 * message (stripe, calendar, site-form) never yields free text either:
 * neither as the arrival channel nor as the fallback.
 *
 * @param {ReturnType<typeof assertReplyInbound>} inbound
 */
export function decideReplyRoute(inbound) {
  if (!REPLIES_WINDOW_CHANNELS.includes(inbound.channel)
    && !REPLIES_FREETEXT_CHANNELS.includes(inbound.channel)) {
    return Object.freeze({ kind: 'none', channel: inbound.channel, template: null, reason: 'no-sendable-route' });
  }
  if (!REPLIES_WINDOW_CHANNELS.includes(inbound.channel)) {
    return Object.freeze({ kind: 'free-text', channel: inbound.channel, template: null });
  }
  if (inbound.windowState === 'in-window') {
    return Object.freeze({ kind: 'free-text', channel: inbound.channel, template: null });
  }
  if (inbound.approvedTemplate !== null && inbound.channel === 'whatsapp') {
    return Object.freeze({ kind: 'template', channel: inbound.channel, template: inbound.approvedTemplate });
  }
  // Fallback only to a channel that sends free text with no window
  // observation. The reply leaves the arrival conversation, so the
  // proposal names the other channel plainly in its summary.
  const fallback = inbound.connectedChannels.find((name) => REPLIES_FREETEXT_CHANNELS.includes(name));
  if (fallback !== undefined) {
    return Object.freeze({ kind: 'free-text', channel: fallback, template: null });
  }
  return Object.freeze({ kind: 'none', channel: inbound.channel, template: null, reason: 'no-sendable-route' });
}

/**
 * Build the drafting intent from the thread's own lines: who writes,
 * where, and the last exchanges in order. Bounded, so a long thread
 * cannot smuggle an unbounded prompt through the composer.
 *
 * @param {ReturnType<typeof assertReplyInbound>} inbound
 */
export function buildReplyIntent(inbound) {
  const lines = [...inbound.history,
    Object.freeze({ direction: 'in', text: inbound.text }),
  ].slice(-6);
  const excerpt = lines
    .map((entry) => `${entry.direction === 'in' ? 'Cliente' : 'Noi'}: ${entry.text.slice(0, 200)}`)
    .join(' ');
  return `Rispondi a ${inbound.displayName} su ${inbound.channel} nel filo della conversazione.`
    + ` Ultimi scambi: ${excerpt}. Scrivi una risposta breve che riprende il suo ultimo messaggio.`;
}

/**
 * Build the approval values for one drafted reply (`actionKind`,
 * `actionKey`, `permission`, `summary`, plus the route, the draft and the
 * conversation link): the payload of one `reply-message` action when the
 * space switch is off, the send itself when it is on. Executing it stays
 * the deployment's `applyAction` seam, which re-checks the window and the
 * consent at send time.
 *
 * @param {{inbound: {messageId: string, conversationId: string, customerId: string, displayName: string, channel: string},
 *   route: {kind: string, channel: string, template?: any},
 *   draft: {text?: unknown} | null}} input
 */
export function buildReplyProposal({ inbound, route, draft }) {
  if (route.kind === 'free-text'
    && (draft === null || draft === undefined
      || typeof draft.text !== 'string' || draft.text.trim() === '')) {
    throw new ValidationError('replies free-text proposal needs a non-empty draft', {
      field: 'draft.text',
    });
  }
  const actionKey = `reply:${inbound.conversationId}:${inbound.messageId}`;
  if (actionKey.length > 256) {
    throw new ValidationError('replies actionKey is at most 256 characters', { field: 'actionKey' });
  }
  const routeLabel = route.kind === 'template'
    ? `modello ${route.template.name}`
    : route.kind === 'free-text' && route.channel !== inbound.channel
      ? `altro canale (${route.channel})`
      : route.channel;
  const summary = `Rispondi a ${inbound.displayName} su ${routeLabel}: segue il filo della conversazione.`
    .slice(0, 500);
  return Object.freeze({
    actionKind: REPLIES_ACTION_KIND,
    actionKey,
    permission: REPLIES_PERMISSION,
    summary,
    channel: route.channel,
    kind: route.kind,
    template: route.template ?? null,
    text: typeof draft?.text === 'string' && draft.text.trim() !== '' ? draft.text.trim().slice(0, 2000) : null,
    conversationRef: Object.freeze({
      conversationId: inbound.conversationId,
      inboundMessageId: inbound.messageId,
      customerId: inbound.customerId,
    }),
  });
}

/**
 * Plan the answer to one arrived message: halt on opt-out or on the
 * autonomy cap, skip the legitimate quiet states, or return the reply
 * proposal linked to the conversation. `draftText` is required — without
 * a wording edge the planner refuses instead of proposing blind — and
 * `windowState` arrives from the channels inbox, never recomputed here.
 * The planner never sends: with the switch off the caller records the
 * proposal for approval; with the switch on the caller sends, counts the
 * streak, and passes it back as `consecutiveReplies` on the next inbound.
 *
 * @param {{inbound: unknown, consecutiveReplies?: unknown, maxConsecutiveReplies?: unknown,
 *   draftText: unknown}} input
 */
export async function planReply({ inbound, consecutiveReplies, maxConsecutiveReplies, draftText }) {
  if (typeof draftText !== 'function') {
    throw new ValidationError('replies needs the draftText wording edge', { field: 'draftText' });
  }
  const checked = assertReplyInbound(inbound);
  const streak = assertConsecutive(consecutiveReplies, 'consecutiveReplies');
  const cap = assertMaxConsecutive(maxConsecutiveReplies);
  if (!REPLIES_INBOUND_CHANNELS.includes(checked.channel)) {
    return Object.freeze({ status: 'skipped', reason: 'unsupported-channel', proposal: null });
  }
  if (checked.consent === 'opted-out' || carriesOptOut(checked.text)) {
    return Object.freeze({
      status: 'halted',
      reason: 'opted-out',
      proposal: null,
      signal: Object.freeze({
        kind: 'needs-human',
        conversationId: checked.conversationId,
        customerId: checked.customerId,
        note: 'La persona ha chiesto di non essere contattata: il filo aspetta una persona.',
      }),
    });
  }
  if (checked.consent === 'unknown') {
    return Object.freeze({ status: 'skipped', reason: 'consent-unknown', proposal: null });
  }
  if (streak >= cap) {
    return Object.freeze({
      status: 'halted',
      reason: 'consecutive-cap',
      proposal: null,
      signal: Object.freeze({
        kind: 'needs-human',
        conversationId: checked.conversationId,
        customerId: checked.customerId,
        note: `L’agente ha gia risposto ${streak} volte di fila: il filo aspetta una persona.`,
      }),
    });
  }
  const route = decideReplyRoute(checked);
  if (route.kind === 'none') {
    return Object.freeze({ status: 'skipped', reason: route.reason, proposal: null });
  }
  let draft = null;
  if (route.kind !== 'template') {
    try {
      draft = await draftText({ inbound: checked, route, intent: buildReplyIntent(checked) });
    } catch (error) {
      return Object.freeze({
        status: 'skipped', reason: 'no-draft', proposal: null, cause: draftRefusalCause(error),
      });
    }
  }
  if (route.kind === 'free-text'
    && (draft === null || draft === undefined
      || typeof draft.text !== 'string' || draft.text.trim() === '')) {
    return Object.freeze({ status: 'skipped', reason: 'no-draft', proposal: null, cause: 'empty-text' });
  }
  return Object.freeze({
    status: 'proposed',
    reason: null,
    proposal: buildReplyProposal({ inbound: checked, route, draft }),
  });
}
