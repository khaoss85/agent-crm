// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';
// The single future-tolerance rule lives in the package (operations.js):
// the adapter never carries its own margin, so a message the ingest path
// accepts as in-window evidence always opens the window here too.
import { CHANNEL_INGEST_FUTURE_SKEW_MS } from './operations.js';
// Batch iteration, echo detection and the window rule live once in the
// shared Meta module both Meta adapters delegate to (backlog:87d4769dde7e).
import {
  META_CUSTOMER_SERVICE_WINDOW_MS,
  checkMetaServiceWindow,
  isMetaSelfEcho,
  iterateMetaBatchItems,
  parseMetaWebhookBody,
} from './meta-webhook.js';

/**
 * WhatsApp Business Cloud adapter (backlog:ecbd24753610).
 *
 * The first real-provider adapter on the shared channel foundation: inbound
 * WhatsApp messages, replies, delivery/read statuses, the 24-hour
 * customer-service window, and approved templates outside it — on the exact
 * adapter contract, registries, inbox, outbox and kit the channels package
 * already ships.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no Meta
 * credentials exist yet, and none are invented here): the transport is a
 * programmable in-memory double with the same modes as the fixture
 * (`ok`, `flaky(n)`, `refuse`, `timeout`), and the Cloud API REST mapping
 * is a pure function (`buildWhatsAppSendRequest`) so the URL, auth scheme
 * and body shape are unit-proven without dialing Meta. Inbound webhooks
 * verify with the shared channel HMAC scheme (`crypto.js`) — the scheme
 * the fake signs with, and the scheme the kit harness signs with. Meta's
 * own edge (`X-Hub-Signature-256`, subscription handshake) lands with the
 * Meta decision, as a `verifyInbound` variant: nothing here invents it.
 *
 * What the adapter owns (the WhatsApp policy, fail-closed):
 * - inbound: Meta Cloud API webhook shapes (`messages[]`, `statuses[]`)
 *   normalized to a list of channel events — one per item in document
 *   order, so a batched delivery (two messages, a message plus its
 *   statuses) stores one inbox row per item and never drops one. Each
 *   delivery/read state is its own inbox row (`<message-id>:<status>`),
 *   with no cross-message sequence (statuses of different messages never
 *   suppress each other), so the conversation timeline is the ordered
 *   rows. A delivery off our own line (a self echo or a status to the
 *   bound business number) normalizes to an empty subject and is
 *   quarantined as evidence, never mapped to a ghost customer.
 * - outbound: free text sends only inside the 24-hour window measured
 *   from the last inbound the inbox observed — resolved server-side by
 *   operations from the conversation rows, never from caller time. A
 *   `message.lastInboundAt` is never read: the observation arrives as the
 *   second argument (`{ lastInboundAt }`), which operations always
 *   provides on the real path. Absent, beyond-skew future, or stale
 *   observations refuse with CHANNEL_TEMPLATE_REQUIRED; outside the window only an
 *   approved template from the adapter config sends, and that code
 *   reaches the caller intact through the real queue path.
 */

export const WHATSAPP_ADAPTER_NAME = 'whatsapp-cloud';
export const WHATSAPP_ADAPTER_VERSION = 1;
/** The Meta customer-service window: free text only within 24h of the last inbound. */
export const WHATSAPP_WINDOW_MS = META_CUSTOMER_SERVICE_WINDOW_MS;
const MAX_TEXT = 4096;
const MAX_TEMPLATE_VARIABLES = 32;
const MAX_VARIABLE_CHARS = 1024;
/** E.164 without the leading `+`, as Meta carries numbers. */
const WA_DIGITS = /^[1-9]\d{7,14}$/;
/** Meta template names: lowercase letters, digits, underscores. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,64}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2}(?:_[A-Z]{2})?$/;
const PHONE_NUMBER_ID = /^\d{1,32}$/;
const API_VERSION = /^\d{1,2}\.\d{1,2}$/;
const META_STATUSES = Object.freeze(['sent', 'delivered', 'read', 'failed']);

function malformedEvent(reason) {
  throw new AppError(`WhatsApp event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function malformedMessage(reason) {
  throw new AppError(`WhatsApp message is not well-formed: ${reason}`, {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

/** Outside the window only an approved template may go: the queue refuses fast, 422. */
function templateRequired() {
  throw new AppError('WhatsApp message is outside the 24-hour window: send an approved template, not free text', {
    code: 'CHANNEL_TEMPLATE_REQUIRED', status: 422,
  });
}

/** Canonical `+E.164` from Meta digits or a `+`-prefixed caller number. Refuses anything else. */
export function canonicalWhatsAppNumber(value) {
  const digits = typeof value === 'string' ? value.trim().replace(/[\s\-().]/g, '') : '';
  const bare = digits.startsWith('+') ? digits.slice(1) : digits;
  if (!WA_DIGITS.test(bare)) {
    throw new AppError('WhatsApp recipient must be an E.164 number', {
      code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
    });
  }
  return `+${bare}`;
}

/** The conversation subject for one peer: the customer, never the business number. */
function conversationSubject(peer) {
  return `wa:${canonicalWhatsAppNumber(peer)}`;
}

function unixToParts(timestamp) {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return null;
  const seconds = typeof timestamp === 'string' && timestamp !== '' ? Number(timestamp) : timestamp;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 4102444800) return null;
  return { sequence: seconds, occurredAt: new Date(seconds * 1000).toISOString() };
}

/**
 * Normalize one verified webhook body to a LIST of channel events, one per
 * Meta item in document order. Accepts the Meta Cloud API shape and the
 * kit's minimal envelope (`{id, subject?, seq?, at?}`) the fake speaks on
 * the kit path (a single-element list). The ingest path stores one inbox
 * row per event, so a batched delivery (two messages, a message plus its
 * statuses) never loses an item. Batch iteration lives in the shared Meta
 * module; only Cloud API items are normalized here.
 */
function normalizeWhatsAppInbound(event, config) {
  const parsed = parseMetaWebhookBody(event, 'WhatsApp');
  const items = iterateMetaBatchItems(parsed, { messagingProduct: 'whatsapp' })
    .filter((entry) => entry.dialect === 'cloud');
  if (items.length === 0) {
    // The kit/fake minimal envelope: the provider id and subject directly.
    const providerEventId = typeof parsed.id === 'string' && parsed.id !== '' && parsed.id.length <= 256
      ? parsed.id : null;
    if (!providerEventId) malformedEvent('envelope needs a bounded "id"');
    return [{
      providerEventId,
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      sequence: Number.isSafeInteger(parsed.seq) ? parsed.seq : null,
      occurredAt: typeof parsed.at === 'string' ? parsed.at : null,
    }];
  }
  return items.map((meta) => normalizeMetaItem(meta, config));
}

/** Normalize one Meta item (one message or one status) to the channel event shape. */
function normalizeMetaItem(meta, config) {
  if (meta.kind === 'message') {
    const { item } = meta;
    if (typeof item.id !== 'string' || item.id === '' || item.id.length > 256) {
      malformedEvent('message needs a bounded id');
    }
    let peer;
    try {
      peer = canonicalWhatsAppNumber(item.from);
    } catch {
      malformedEvent('message needs a valid sender');
    }
    // Coexistence with the WhatsApp Business app: the API number and the
    // app number are different lines, but an echo off our own line must
    // never become a customer. No peer, no subject: the operations layer
    // quarantines it as evidence. Echo detection is the shared Meta rule.
    if (config.businessNumber && isMetaSelfEcho({ from: peer }, config.businessNumber)) {
      return { providerEventId: item.id, subject: '', sequence: null, occurredAt: null };
    }
    const parts = unixToParts(item.timestamp);
    if (!parts) malformedEvent('message needs a valid timestamp');
    return {
      providerEventId: item.id,
      subject: conversationSubject(peer),
      sequence: parts.sequence,
      occurredAt: parts.occurredAt,
    };
  }
  const { item } = meta;
  if (typeof item.id !== 'string' || item.id === '' || item.id.length > 200) {
    malformedEvent('status needs a bounded id');
  }
  if (!META_STATUSES.includes(item.status)) {
    malformedEvent(`unknown status "${typeof item.status === 'string' ? item.status.slice(0, 32) : typeof item.status}"`);
  }
  let peer;
  try {
    peer = canonicalWhatsAppNumber(item.recipient_id);
  } catch {
    malformedEvent('status needs a valid recipient');
  }
  // The echo quarantine covers statuses too: a delivery report addressed
  // to our own line is evidence, never a customer conversation.
  if (config.businessNumber && isMetaSelfEcho({ from: peer }, config.businessNumber)) {
    return { providerEventId: `${item.id}:${item.status}`, subject: '', sequence: null, occurredAt: null };
  }
  const parts = unixToParts(item.timestamp);
  if (!parts) malformedEvent('status needs a valid timestamp');
  // One row per delivery state: sent, delivered and read updates share the
  // message id, so the state joins the key — otherwise read would replay
  // delivered. The timeline of a message is its ordered rows. Statuses
  // carry no cross-message sequence: every status of every message applies
  // on its own row, so a late report of one message never suppresses the
  // report of another through the per-subject out-of-order rule.
  return {
    providerEventId: `${item.id}:${item.status}`,
    subject: conversationSubject(peer),
    sequence: null,
    occurredAt: parts.occurredAt,
  };
}

function assertApprovedTemplate(template, approved) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    malformedMessage('template must be an object {name, language?, variables?}');
  }
  const name = typeof template.name === 'string' ? template.name : '';
  const found = Array.isArray(approved)
    ? approved.find((entry) => entry && entry.name === name)
    : null;
  if (!TEMPLATE_NAME.test(name) || !found) {
    malformedMessage(`template "${name.slice(0, 64)}" is not an approved template of this adapter`);
  }
  const language = template.language === undefined ? found.language : template.language;
  if (typeof language !== 'string' || language.toLowerCase() !== found.language.toLowerCase()) {
    malformedMessage(`template "${name}" must use its approved language "${found.language}"`);
  }
  const variables = template.variables === undefined ? [] : template.variables;
  if (!Array.isArray(variables) || variables.length > MAX_TEMPLATE_VARIABLES
    || variables.some((value) => typeof value !== 'string' || value === '' || value.length > MAX_VARIABLE_CHARS)) {
    malformedMessage('template variables must be a bounded list of non-empty text (at most 32, at most 1024 chars each)');
  }
  return { name, language: found.language, variables: [...variables] };
}

/**
 * Normalize one outbound message and enforce the window policy.
 * Free text needs the conversation inside the 24-hour window; an approved
 * template sends at any time. `nowMs` is injectable for tests.
 *
 * The window observation is never caller time: `message.lastInboundAt` is
 * not read at all. On the real path operations resolves the last inbound
 * server-side from the inbox and hands it in as `{ lastInboundAt }`;
 * direct calls (unit tests) pass the observation the same way. An absent,
 * beyond-skew future, or stale observation refuses fail-closed with
 * CHANNEL_TEMPLATE_REQUIRED — the caller sends a template instead. Within
 * the package skew (a few minutes of clock drift) the observation stands.
 */
function normalizeWhatsAppOutbound(message, config, nowMs, windowCtx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    malformedMessage('message must be a plain object');
  }
  let to;
  try {
    to = canonicalWhatsAppNumber(message.to);
  } catch {
    malformedMessage('message needs a bounded E.164 "to"');
  }
  if (message.template !== undefined) {
    const template = assertApprovedTemplate(message.template, config.approvedTemplates);
    return { to, kind: 'template', template };
  }
  const text = typeof message.text === 'string' ? message.text : '';
  if (text === '' || text.length > MAX_TEXT) {
    malformedMessage('message needs non-empty "text" (at most 4096 chars) or an approved "template"');
  }
  const observed = windowCtx && typeof windowCtx === 'object' ? windowCtx.lastInboundAt : undefined;
  // The window verdict is the shared Meta rule (missing/future/stale refuse
  // with CHANNEL_TEMPLATE_REQUIRED, a non-canonical observation is
  // malformed). The package skew is passed in, not a second margin: an
  // observation the ingest path kept as in-window evidence (up to now +
  // skew) opens the window here too.
  const verdict = checkMetaServiceWindow(observed, {
    nowMs, windowMs: WHATSAPP_WINDOW_MS, skewMs: CHANNEL_INGEST_FUTURE_SKEW_MS,
  });
  if (verdict === 'missing' || verdict === 'future' || verdict === 'stale') templateRequired();
  if (verdict === 'invalid') malformedMessage('"lastInboundAt" must be an ISO-8601 instant');
  return { to, kind: 'text', text };
}

/**
 * The Cloud API REST mapping as a pure function: URL, bearer auth from the
 * call-time secret (never stored), and the text/template bodies. Unit-proven
 * here; the fake records exactly this shape per send.
 */
export function buildWhatsAppSendRequest({ message, config, secret }) {
  if (!message || typeof message !== 'object') {
    throw new AppError('WhatsApp send needs a normalized message', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new AppError('WhatsApp send needs the call-time secret', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
  }
  const to = canonicalWhatsAppNumber(message.to);
  const url = `${config.baseUrl}/v${config.apiVersion}/${config.phoneNumberId}/messages`;
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  if (message.kind === 'template') {
    const template = assertApprovedTemplate(message.template, config.approvedTemplates);
    return {
      method: 'POST',
      url,
      headers,
      body: {
        messaging_product: 'whatsapp',
        to: to.slice(1),
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          ...(template.variables.length > 0
            ? {
              components: [{
                type: 'body',
                parameters: template.variables.map((text) => ({ type: 'text', text })),
              }],
            }
            : {}),
        },
      },
    };
  }
  if (typeof message.text !== 'string' || message.text === '') {
    throw new AppError('WhatsApp send needs text or a template', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  return {
    method: 'POST',
    url,
    headers,
    body: {
      messaging_product: 'whatsapp',
      to: to.slice(1),
      type: 'text',
      text: { body: message.text, preview_url: false },
    },
  };
}

function assertAdapterConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('WhatsApp adapter options must be a plain object', { field: 'config' });
  }
  const phoneNumberId = typeof input.phoneNumberId === 'string' ? input.phoneNumberId : '';
  if (!PHONE_NUMBER_ID.test(phoneNumberId)) {
    throw new ValidationError('WhatsApp adapter needs a bounded phoneNumberId (Meta phone-number-id digits)', { field: 'config.phoneNumberId' });
  }
  const apiVersion = input.apiVersion === undefined ? '21.0' : input.apiVersion;
  if (typeof apiVersion !== 'string' || !API_VERSION.test(apiVersion)) {
    throw new ValidationError('WhatsApp adapter apiVersion must look like "21.0"', { field: 'config.apiVersion' });
  }
  const baseUrl = input.baseUrl === undefined ? 'https://graph.facebook.com' : input.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(baseUrl)) {
    throw new ValidationError('WhatsApp adapter baseUrl must be a bounded https origin', { field: 'config.baseUrl' });
  }
  const approvedTemplates = input.approvedTemplates === undefined ? [] : input.approvedTemplates;
  if (!Array.isArray(approvedTemplates) || approvedTemplates.length > 64
    || approvedTemplates.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !TEMPLATE_NAME.test(entry.name) || typeof entry.language !== 'string'
      || !TEMPLATE_LANGUAGE.test(entry.language))) {
    throw new ValidationError('WhatsApp adapter approvedTemplates must be a bounded list of {name, language}', { field: 'config.approvedTemplates' });
  }
  // The bound business line is required at composition: without it the
  // self-echo quarantine cannot tell our own number from a customer, and a
  // status to our own line would land as a business-as-customer ghost row.
  if (input.businessNumber === undefined) {
    throw new ValidationError('WhatsApp adapter needs businessNumber: the bound business line the echo quarantine compares against', {
      field: 'config.businessNumber',
    });
  }
  let businessNumber;
  try {
    businessNumber = canonicalWhatsAppNumber(input.businessNumber);
  } catch {
    throw new ValidationError('WhatsApp adapter businessNumber must be an E.164 number', { field: 'config.businessNumber' });
  }
  const nowMs = input.nowMs === undefined ? () => Date.now() : input.nowMs;
  if (typeof nowMs !== 'function') {
    throw new ValidationError('WhatsApp adapter nowMs must be a clock function', { field: 'nowMs' });
  }
  return Object.freeze({
    phoneNumberId,
    apiVersion,
    baseUrl,
    approvedTemplates: Object.freeze(approvedTemplates.map((entry) => Object.freeze({ name: entry.name, language: entry.language }))),
    businessNumber,
    testOnly: true,
  });
}

/**
 * Build the fake-backed WhatsApp adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. `secret` is the
 * declared test-only value the double expects; production resolves the
 * real token through the same `resolveSecret` edge.
 */
export function createWhatsAppChannelAdapter(options = {}) {
  const expectedSecret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret : 'whatsapp-fake-secret';
  const config = assertAdapterConfig(options);
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, request: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
    seedCounter: 0,
  };

  const api = {
    state,
    /** @param {'ok'|'refuse'|'timeout'} mode @param {number} [flakyFailures] */
    setMode(mode, flakyFailures = 0) {
      state.mode = mode;
      state.flakyRemaining = flakyFailures;
    },
    reset() {
      state.mode = 'ok';
      state.flakyRemaining = 0;
      state.sentByKey.clear();
      state.sendCalls = 0;
    },
    sentMessages() {
      return [...state.sentByKey.values()].map((entry) => entry.request.body);
    },
    sentRequests() {
      return [...state.sentByKey.values()].map((entry) => entry.request);
    },
  };

  return {
    definition: {
      name: options.name ?? WHATSAPP_ADAPTER_NAME,
      version: WHATSAPP_ADAPTER_VERSION,
      label: 'WhatsApp Business Cloud (fake-backed)',
      channel: 'whatsapp',
      config: {
        phoneNumberId: config.phoneNumberId,
        apiVersion: config.apiVersion,
        baseUrl: config.baseUrl,
        approvedTemplates: [...config.approvedTemplates],
        ...(config.businessNumber ? { businessNumber: config.businessNumber } : {}),
        testOnly: true,
      },

      verifyInbound({ rawBody, headers, secret }) {
        // The channel HMAC scheme the fake signs with — the same primitive
        // and headers the kit harness uses. Meta's own edge arrives with
        // the Meta decision, as a variant of this function.
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeWhatsAppInbound(event, config);
      },

      normalizeOutbound(message, windowCtx) {
        return normalizeWhatsAppOutbound(message, config, nowMs, windowCtx);
      },

      /**
       * The service-window capability the shared contract allows: the
       * conversation subject for one recipient, a seedable windowed
       * inbound for the kit, and the customer-message predicate that
       * keeps delivery reports out of the window observation.
       */
      outboundWindow: {
        windowMs: WHATSAPP_WINDOW_MS,
        subjectForRecipient(to) {
          return conversationSubject(to);
        },
        seedInbound({ from } = {}) {
          const peer = canonicalWhatsAppNumber(from);
          state.seedCounter += 1;
          return JSON.stringify({
            id: `wa-window-seed-${state.seedCounter}`,
            subject: `wa:${peer}`,
            seq: 1,
            at: new Date(nowMs()).toISOString(),
          });
        },
        isObservation(row) {
          return typeof row?.providerEventId === 'string'
            && !/:(sent|delivered|read|failed)$/.test(row.providerEventId);
        },
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('WhatsApp secret mismatch', { code: 'CHANNEL_SEND_REFUSED', status: 403 });
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {});
          throw new AppError('Unreachable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        if (state.mode === 'refuse') {
          throw new AppError('WhatsApp provider refuses this message', { code: 'CHANNEL_SEND_REFUSED', status: 422 });
        }
        if (state.mode === 'flaky' && state.flakyRemaining > 0) {
          state.flakyRemaining -= 1;
          throw new AppError('WhatsApp provider temporarily unavailable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const existing = state.sentByKey.get(idempotencyKey);
        if (existing) return { providerMessageId: existing.providerMessageId };
        const request = buildWhatsAppSendRequest({
          message,
          config: {
            phoneNumberId: config.phoneNumberId,
            apiVersion: config.apiVersion,
            baseUrl: config.baseUrl,
            approvedTemplates: [...config.approvedTemplates],
          },
          secret,
        });
        const providerMessageId = `wamid.fake-${state.sentByKey.size + 1}`;
        // The Bearer [REDACTED] is call-time only: the retained copy keeps the
        // wire shape minus the secret, so no dump of sentRequests() leaks it.
        const { Authorization: _withheld, ...publicHeaders } = request.headers;
        void _withheld;
        state.sentByKey.set(idempotencyKey, {
          providerMessageId,
          request: { method: request.method, url: request.url, headers: publicHeaders, body: request.body },
        });
        return { providerMessageId };
      },
    },
    api,
  };
}
