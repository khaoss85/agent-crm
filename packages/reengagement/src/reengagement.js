// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * The re-engagement agent (backlog:f50ad5c9): a teammate agent that
 * re-contacts silent customers.
 *
 * Every day it finds the customers who arrived from WhatsApp, Instagram or
 * email and were never answered — or not contacted for N days — prepares one
 * message each with the card's own history on the right channel, and hands
 * the proposals to the caller for approval. With raised autonomy the caller
 * sends them alone; the switch is the existing `send-without-approval`
 * space permission, never a new one.
 *
 * It reuses and never duplicates (MEM_ACC_REUSE):
 * - the 24-hour Meta service window stays in `packages/channels`
 *   (`checkMetaServiceWindow`): the caller observes `windowState` from the
 *   channels inbox and passes it in as a value — this module never
 *   re-implements the window and never reads the inbox;
 * - the message wording stays in `packages/llm` (`draftCustomerMessage`):
 *   the caller injects `draftText` and this module only builds the intent
 *   from the customer's own facts;
 * - approval stays in `packages/agents` (backlog:fd36da512b0e): «Da fare»
 *   lists `teammate-run` rows with outcome `proposed`, so
 *   `createReengagementExecutor` below is the `execute` seam of `run-due`
 *   and each proposal is one action of that run — nothing is stored twice;
 * - customer identity stays in `packages/customer-data`: there is no
 *   customer table here, only the caller's `customerId` reference.
 *
 * What is deliberately NOT here: any storage, any session, any HTTP, any
 * timer. The pilot owns the daily run and the worker owns the history and
 * window reads; this module takes values and returns values, which is also
 * what makes it testable against a fake `draftText`.
 *
 * The one invariant the acceptance pins: on a Meta channel outside the
 * window this module never proposes free text — only an approved template
 * or another connected channel. A customer with no sendable route is
 * skipped with a reason, never forced onto a forbidden route.
 */

/** The agent's package identity, also the proposal `actionKind` root. */
export const REENGAGEMENT_PACKAGE = 'reengagement';

/** The proposal kind the approval record stores for one re-engagement. */
export const REENGAGEMENT_ACTION_KIND = 'reengagement-message';

/**
 * The space switch that turns a proposal into an autonomous send. Reused
 * from `packages/space-permissions`: on, the caller sends; off, the caller
 * records a `space-ai-proposal` for a human. No new permission is declared.
 */
export const REENGAGEMENT_PERMISSION = 'send-without-approval';

/** Arrival channels in scope for this agent, in the packet's order. */
export const REENGAGEMENT_INBOUND_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'email']);

/**
 * Channels whose free text needs the 24-hour window. Mirrors the adapters
 * that declare `outboundWindow` in `packages/channels` (whatsapp.js,
 * instagram.js, messenger.js serving `facebook`): the window itself stays
 * enforced there, this list only steers the route away from free text no
 * channel observation could send.
 */
export const REENGAGEMENT_WINDOW_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'facebook']);

/** Customer silence before the agent knocks, unless the caller says otherwise. */
export const REENGAGEMENT_DEFAULT_QUIET_DAYS = 7;

/** Bounds: quiet days, customer references, summaries, template variables. */
export const REENGAGEMENT_MIN_QUIET_DAYS = 1;
export const REENGAGEMENT_MAX_QUIET_DAYS = 90;
export const REENGAGEMENT_MAX_CUSTOMER_ID = 200;
export const REENGAGEMENT_MAX_NAME = 100;
export const REENGAGEMENT_MAX_SUMMARY = 500;
export const REENGAGEMENT_MAX_HISTORY = 20;
export const REENGAGEMENT_MAX_HISTORY_TEXT = 2000;
export const REENGAGEMENT_MAX_TEMPLATE_VARIABLES = 32;
export const REENGAGEMENT_MAX_TEMPLATE_VARIABLE_CHARS = 1024;

/** The window observation the caller resolves from the channels inbox. */
export const REENGAGEMENT_WINDOW_STATES = Object.freeze(['in-window', 'needs-template']);

/** Consent as the caller resolved it from customer-data opt-out. */
export const REENGAGEMENT_CONSENTS = Object.freeze(['granted', 'opted-out', 'unknown']);

/** Why a customer got no proposal: legitimate states, never errors. */
export const REENGAGEMENT_SKIP_REASONS = Object.freeze([
  'unsupported-channel',
  'opted-out',
  'consent-unknown',
  'replied',
  'recent',
  'no-inbound',
  'no-sendable-route',
  'no-draft',
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9f]/;
/** Template names stay provider-shaped; the shape authority is packages/channels. */
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,64}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2}(?:_[A-Z]{2})?$/;

/** @param {unknown} value @param {string} field @param {number} max */
function boundedLine(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`reengagement ${field} must be non-empty text`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ValidationError(`reengagement ${field} is at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(text)) {
    throw new ValidationError(`reengagement ${field} carries no control characters`, { field });
  }
  return text;
}

/** @param {unknown} value @param {string} field */
function boundedId(value, field) {
  return boundedLine(value, field, REENGAGEMENT_MAX_CUSTOMER_ID);
}

/** @param {unknown} value @param {string} field */
function assertIsoInstant(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`reengagement ${field} must be an ISO instant`, { field });
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    throw new ValidationError(`reengagement ${field} must be an ISO instant`, { field });
  }
  return at;
}

/** @param {unknown} history */
function assertHistory(history) {
  if (history === undefined || history === null) return Object.freeze([]);
  if (!Array.isArray(history) || history.length > REENGAGEMENT_MAX_HISTORY) {
    throw new ValidationError(
      `reengagement history must be an array of at most ${REENGAGEMENT_MAX_HISTORY} entries`,
      { field: 'history' },
    );
  }
  return Object.freeze(history.map((entry, index) => {
    const field = `history[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('reengagement history entry must be a plain object', { field });
    }
    const { direction, text } = /** @type {Record<string, unknown>} */ (entry);
    if (direction !== 'in' && direction !== 'out') {
      throw new ValidationError("reengagement history direction is 'in' or 'out'", { field: `${field}.direction` });
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > REENGAGEMENT_MAX_HISTORY_TEXT) {
      throw new ValidationError(
        `reengagement history text is bounded non-empty text (at most ${REENGAGEMENT_MAX_HISTORY_TEXT} characters)`,
        { field: `${field}.text` },
      );
    }
    return Object.freeze({ direction, text: text.trim() });
  }));
}

/** @param {unknown} channels */
function assertConnectedChannels(channels) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 11) {
    throw new ValidationError('reengagement connectedChannels must list 1-11 channels', { field: 'connectedChannels' });
  }
  return Object.freeze(channels.map((channel, index) => {
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(channel)) {
      throw new ValidationError('reengagement channel must be a bounded lowercase slug', {
        field: `connectedChannels[${index}]`,
      });
    }
    return channel;
  }));
}

/** @param {unknown} template */
function assertApprovedTemplate(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new ValidationError('reengagement approvedTemplate must be a plain object', { field: 'approvedTemplate' });
  }
  const record = /** @type {Record<string, unknown>} */ (template);
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new ValidationError('reengagement template name must be a bounded provider template name', {
      field: 'approvedTemplate.name',
    });
  }
  let language;
  if (record.language !== undefined) {
    if (typeof record.language !== 'string' || !TEMPLATE_LANGUAGE_RE.test(record.language.trim())) {
      throw new ValidationError('reengagement template language must look like it or it_IT', {
        field: 'approvedTemplate.language',
      });
    }
    language = record.language.trim();
  }
  const rawVariables = record.variables === undefined ? [] : record.variables;
  if (!Array.isArray(rawVariables) || rawVariables.length > REENGAGEMENT_MAX_TEMPLATE_VARIABLES) {
    throw new ValidationError(
      `reengagement template variables are at most ${REENGAGEMENT_MAX_TEMPLATE_VARIABLES} bounded texts`,
      { field: 'approvedTemplate.variables' },
    );
  }
  const variables = Object.freeze(rawVariables.map((variable, index) => {
    if (typeof variable !== 'string' || variable.trim() === ''
      || variable.trim().length > REENGAGEMENT_MAX_TEMPLATE_VARIABLE_CHARS) {
      throw new ValidationError('reengagement template variable must be bounded non-empty text', {
        field: `approvedTemplate.variables[${index}]`,
      });
    }
    return variable.trim();
  }));
  return Object.freeze({ name, ...(language === undefined ? null : { language }), variables });
}

/**
 * Validate one customer the caller hands over. Throws fail-closed on
 * malformed shape; legitimate quiet states (opted out, replied, recent)
 * are skips decided later, never refusals.
 *
 * @param {unknown} customer
 */
export function assertReengagementCustomer(customer) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    throw new ValidationError('reengagement customer must be a plain object', { field: 'customer' });
  }
  const value = /** @type {Record<string, unknown>} */ (customer);
  const customerId = boundedId(value.customerId, 'customerId');
  const displayName = boundedLine(value.displayName, 'displayName', REENGAGEMENT_MAX_NAME);
  if (typeof value.channel !== 'string' || value.channel.trim() === '') {
    throw new ValidationError('reengagement channel must be a non-empty slug', { field: 'channel' });
  }
  const channel = value.channel.trim();
  if (typeof value.lastInboundAt !== 'string' || value.lastInboundAt.trim() === '') {
    throw new ValidationError('reengagement lastInboundAt must be an ISO instant', { field: 'lastInboundAt' });
  }
  const lastInboundAt = value.lastInboundAt.trim();
  assertIsoInstant(lastInboundAt, 'lastInboundAt');
  let lastOutboundAt = null;
  if (value.lastOutboundAt !== undefined && value.lastOutboundAt !== null) {
    if (typeof value.lastOutboundAt !== 'string' || value.lastOutboundAt.trim() === '') {
      throw new ValidationError('reengagement lastOutboundAt must be an ISO instant or null', {
        field: 'lastOutboundAt',
      });
    }
    lastOutboundAt = value.lastOutboundAt.trim();
    assertIsoInstant(lastOutboundAt, 'lastOutboundAt');
  }
  if (typeof value.consent !== 'string' || !REENGAGEMENT_CONSENTS.includes(value.consent)) {
    throw new ValidationError(`reengagement consent is one of ${REENGAGEMENT_CONSENTS.join(', ')}`, {
      field: 'consent',
    });
  }
  const connectedChannels = assertConnectedChannels(value.connectedChannels);
  let windowState = null;
  if (REENGAGEMENT_WINDOW_CHANNELS.includes(channel)) {
    if (typeof value.windowState !== 'string' || !REENGAGEMENT_WINDOW_STATES.includes(value.windowState)) {
      throw new ValidationError(
        `reengagement windowState is one of ${REENGAGEMENT_WINDOW_STATES.join(', ')} on a windowed channel`,
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
    customerId, displayName, channel, lastInboundAt, lastOutboundAt,
    consent: value.consent, connectedChannels, windowState, approvedTemplate, history,
  });
}

/** @param {unknown} quietDays */
function assertQuietDays(quietDays) {
  if (quietDays === undefined || quietDays === null) return REENGAGEMENT_DEFAULT_QUIET_DAYS;
  if (!Number.isInteger(quietDays) || quietDays < REENGAGEMENT_MIN_QUIET_DAYS || quietDays > REENGAGEMENT_MAX_QUIET_DAYS) {
    throw new ValidationError(
      `reengagement quietDays is ${REENGAGEMENT_MIN_QUIET_DAYS}-${REENGAGEMENT_MAX_QUIET_DAYS} days`,
      { field: 'quietDays' },
    );
  }
  return quietDays;
}

/**
 * Whole days of customer silence at `nowMs`. Counts from the last inbound
 * the caller observed — the same instant the window rule reads.
 *
 * @param {string} lastInboundAt @param {number} nowMs
 */
export function silentDays(lastInboundAt, nowMs) {
  const at = Date.parse(lastInboundAt);
  const diff = nowMs - at;
  if (diff < 0) return 0;
  return Math.floor(diff / DAY_MS);
}

/**
 * Decide whether one validated customer needs a knock. Returns the
 * candidate with its silence, or the skip reason — never both.
 *
 * @param {ReturnType<typeof assertReengagementCustomer>} customer
 * @param {{nowMs: number, quietDays: number}} options
 */
export function selectReengagementCandidate(customer, { nowMs, quietDays }) {
  if (!REENGAGEMENT_INBOUND_CHANNELS.includes(customer.channel)) {
    return Object.freeze({ candidate: null, skip: 'unsupported-channel' });
  }
  if (customer.consent === 'opted-out') return Object.freeze({ candidate: null, skip: 'opted-out' });
  if (customer.consent === 'unknown') return Object.freeze({ candidate: null, skip: 'consent-unknown' });
  const inboundAt = Date.parse(customer.lastInboundAt);
  if (customer.lastOutboundAt !== null && Date.parse(customer.lastOutboundAt) >= inboundAt) {
    // Answered once, but silence still counts: the knock returns when the
    // latest contact — the reply itself — is older than quietDays.
    const outDays = silentDays(customer.lastOutboundAt, nowMs);
    if (outDays < quietDays) return Object.freeze({ candidate: null, skip: 'replied' });
    return Object.freeze({
      candidate: Object.freeze({ ...customer, silentDays: outDays }),
      skip: null,
    });
  }
  const days = silentDays(customer.lastInboundAt, nowMs);
  if (days < quietDays) return Object.freeze({ candidate: null, skip: 'recent' });
  return Object.freeze({ candidate: Object.freeze({ ...customer, silentDays: days }), skip: null });
}

/**
 * Pick the sendable route for one candidate. The acceptance invariant:
 * a windowed channel outside the window never yields free text — only an
 * approved template (whatsapp, the sole adapter with template sends),
 * another connected channel, or no route at all. Instagram and Messenger
 * document no template fallback, so their needs-template customers fall
 * through to the fallback below.
 *
 * @param {ReturnType<typeof assertReengagementCustomer>} candidate
 */
export function decideReengagementRoute(candidate) {
  if (!REENGAGEMENT_WINDOW_CHANNELS.includes(candidate.channel)) {
    return Object.freeze({ kind: 'free-text', channel: candidate.channel, template: null });
  }
  if (candidate.windowState === 'in-window') {
    return Object.freeze({ kind: 'free-text', channel: candidate.channel, template: null });
  }
  if (candidate.approvedTemplate !== null && candidate.channel === 'whatsapp') {
    return Object.freeze({ kind: 'template', channel: candidate.channel, template: candidate.approvedTemplate });
  }
  // Fallback only to a channel that sends free text with no window
  // observation (the scan observes one window: the arrival channel's).
  const fallback = candidate.connectedChannels.find((name) => !REENGAGEMENT_WINDOW_CHANNELS.includes(name));
  if (fallback !== undefined) {
    return Object.freeze({ kind: 'free-text', channel: fallback, template: null });
  }
  return Object.freeze({ kind: 'none', channel: candidate.channel, template: null, reason: 'no-sendable-route' });
}

/**
 * Build the drafting intent from the customer's own facts: who they are,
 * where they arrived, how long they have been silent, and their last
 * inbound line. Bounded, so a long history cannot smuggle an unbounded
 * prompt through the composer.
 *
 * @param {ReturnType<typeof assertReengagementCustomer> & {silentDays: number}} candidate
 */
export function buildReengagementIntent(candidate) {
  const lastInbound = [...candidate.history].reverse().find((entry) => entry.direction === 'in');
  const excerpt = lastInbound ? lastInbound.text.slice(0, 200) : null;
  const parts = [
    `Ricontatta ${candidate.displayName}: arrivato da ${candidate.channel} ${candidate.silentDays} giorni fa senza risposta.`,
    excerpt ? `Ultimo messaggio: "${excerpt}".` : 'Nessun messaggio precedente agli atti.',
    'Scrivi un messaggio per riaprire la conversazione, un invito concreto a rispondere.',
  ];
  return parts.join(' ');
}

/**
 * Build the approval values for one drafted knock (`actionKind`,
 * `actionKey`, `permission`, `summary`, plus the route and the draft): the
 * payload of one `reengagement-message` action of a teammate run when the
 * space switch is off, the send itself when it is on. Executing it stays
 * the deployment's `applyAction` seam.
 *
 * @param {{candidate: {customerId: string, displayName: string, channel: string},
 *   route: {kind: string, channel: string, template?: any},
 *   draft: {text?: unknown} | null, day: string}} input
 */
export function buildReengagementProposal({ candidate, route, draft, day }) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new ValidationError('reengagement day must be a UTC YYYY-MM-DD day', { field: 'day' });
  }
  if (route.kind === 'free-text'
    && (draft === null || draft === undefined
      || typeof draft.text !== 'string' || draft.text.trim() === '')) {
    throw new ValidationError('reengagement free-text proposal needs a non-empty draft', {
      field: 'draft.text',
    });
  }
  const actionKey = `reengagement:${candidate.customerId}:${day}`;
  if (actionKey.length > 256) {
    throw new ValidationError('reengagement actionKey is at most 256 characters', { field: 'actionKey' });
  }
  const routeLabel = route.kind === 'template'
    ? `modello ${route.template.name}`
    : route.kind === 'free-text' && route.channel !== candidate.channel
      ? `altro canale (${route.channel})`
      : route.channel;
  const summary = `Ricontatta ${candidate.displayName} su ${routeLabel}: ultimo contatto ${candidate.channel}.`.slice(0, REENGAGEMENT_MAX_SUMMARY);
  return Object.freeze({
    actionKind: REENGAGEMENT_ACTION_KIND,
    actionKey,
    permission: REENGAGEMENT_PERMISSION,
    summary,
    channel: route.channel,
    kind: route.kind,
    template: route.template ?? null,
    text: typeof draft?.text === 'string' && draft.text.trim() !== '' ? draft.text.trim().slice(0, 2000) : null,
    customerRef: Object.freeze({ customerId: candidate.customerId, displayName: candidate.displayName }),
  });
}

/**
 * Run one daily scan over the caller's customers: select the silent ones,
 * decide each route, draft each knock through the injected `draftText`,
 * and return the proposals beside the skips. `draftText` is required —
 * without a wording edge the scan refuses instead of proposing blind —
 * and `windowState` arrives per customer from the channels inbox, never
 * recomputed here.
 *
 * @param {{customers: unknown, quietDays?: unknown, nowMs?: unknown, draftText: unknown}} input
 */
export async function scanReengagement({ customers, quietDays, nowMs, draftText }) {
  if (!Array.isArray(customers)) {
    throw new ValidationError('reengagement customers must be an array', { field: 'customers' });
  }
  if (typeof draftText !== 'function') {
    throw new ValidationError('reengagement needs the draftText wording edge', { field: 'draftText' });
  }
  const days = assertQuietDays(quietDays);
  const at = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const day = new Date(at).toISOString().slice(0, 10);
  const proposals = [];
  const skipped = [];
  for (const raw of customers) {
    const checked = assertReengagementCustomer(raw);
    const { candidate, skip } = selectReengagementCandidate(checked, { nowMs: at, quietDays: days });
    if (candidate === null) {
      skipped.push(Object.freeze({ customerId: checked.customerId, reason: skip }));
      continue;
    }
    const route = decideReengagementRoute(candidate);
    if (route.kind === 'none') {
      skipped.push(Object.freeze({ customerId: checked.customerId, reason: route.reason }));
      continue;
    }
    const intent = buildReengagementIntent(candidate);
    let draft = null;
    if (route.kind !== 'template') {
      try {
        draft = await draftText({ candidate, route, intent });
      } catch {
        skipped.push(Object.freeze({ customerId: checked.customerId, reason: 'no-draft' }));
        continue;
      }
    }
    if (route.kind === 'free-text'
      && (draft === null || draft === undefined
        || typeof draft.text !== 'string' || draft.text.trim() === '')) {
      skipped.push(Object.freeze({ customerId: checked.customerId, reason: 'no-draft' }));
      continue;
    }
    proposals.push(buildReengagementProposal({ candidate, route, draft, day }));
  }
  return Object.freeze({ proposals: Object.freeze(proposals), skipped: Object.freeze(skipped) });
}

/** One teammate run carries at most this many proposals (the agents package rule). */
export const REENGAGEMENT_MAX_PROPOSALS_PER_RUN = 25;
/** One stored proposal payload fits the agents package bound (8 KiB of JSON). */
export const REENGAGEMENT_MAX_PAYLOAD_CHARS = 8192;

/**
 * The `execute` seam of the agents package's `run-due` for the
 * re-engagement agent (backlog:fd36da512b0e).
 *
 * «Da fare» in the backoffice lists teammate runs with outcome `proposed`,
 * so the re-engagement proposals travel that way and no other: `run-due`
 * calls this executor, records the run, and the human approves, edits or
 * rejects that row (`approve-run`, `revise-run`, `reject-run`). Approving
 * applies each proposal through the deployment's `applyAction` seam, which
 * sends `reengagement-message` actions through the channels outbox (the
 * outbox re-checks the 24-hour window). No `space-ai-proposal` row is
 * written: nothing duplicates the approval queue.
 *
 * - `loadCustomers({ agent, assignment })` is the caller's read of the
 *   silent customers (channels inbox for the window, customer-data for the
 *   consent). It should leave out customers already waiting in «Da fare»:
 *   they stay silent until the message is approved and sent.
 * - `draftText` is the wording edge, as in `scanReengagement`.
 *
 * Returns the agents execute result: `{ kind: 'proposals' }` with one
 * proposal per knock (action `reengagement-message`, payload = the
 * proposal values), at most 25 per run in scan order — the rest are still
 * silent at the next run. A proposal whose payload would not fit 8 KiB is
 * skipped as `payload-too-large`, never truncated blind. When nobody needs
 * a knock the run is an `artifact` that counts the skips by reason, so the
 * agent's run says what it saw instead of failing.
 *
 * @param {{
 *   loadCustomers: (context: {agent: any, assignment: any}) => Promise<unknown> | unknown,
 *   draftText: (input: any) => Promise<any>,
 *   quietDays?: number,
 *   nowMs?: () => number,
 * }} options
 */
export function createReengagementExecutor(options) {
  const { loadCustomers, draftText, quietDays } = options ?? /** @type {any} */ ({});
  if (typeof loadCustomers !== 'function') {
    throw new ValidationError('reengagement executor needs loadCustomers', { field: 'loadCustomers' });
  }
  if (typeof draftText !== 'function') {
    throw new ValidationError('reengagement needs the draftText wording edge', { field: 'draftText' });
  }
  const clock = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  if (quietDays !== undefined) assertQuietDays(quietDays);
  return async function executeReengagement({ agent, assignment } = /** @type {any} */ ({})) {
    const nowMs = clock();
    const customers = await loadCustomers({ agent, assignment });
    const scan = await scanReengagement({ customers, quietDays, nowMs, draftText });
    const proposals = [];
    const skipped = [...scan.skipped];
    for (const proposal of scan.proposals) {
      const payload = JSON.parse(JSON.stringify(proposal));
      if (JSON.stringify(payload).length > REENGAGEMENT_MAX_PAYLOAD_CHARS) {
        skipped.push(Object.freeze({ customerId: proposal.customerRef.customerId, reason: 'payload-too-large' }));
        continue;
      }
      if (proposals.length >= REENGAGEMENT_MAX_PROPOSALS_PER_RUN) break;
      proposals.push({ action: REENGAGEMENT_ACTION_KIND, payload });
    }
    if (proposals.length > 0) return { kind: 'proposals', proposals, costCents: 0 };
    /** @type {Record<string, number>} */
    const byReason = {};
    for (const entry of skipped) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
    return {
      kind: 'artifact',
      costCents: 0,
      artifact: {
        reengagement: 1,
        day: new Date(nowMs).toISOString().slice(0, 10),
        customers: Array.isArray(customers) ? customers.length : 0,
        proposed: 0,
        skippedByReason: byReason,
      },
    };
  };
}
