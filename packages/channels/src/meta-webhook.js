// @ts-check

import { AppError } from '../../core/index.js';

/**
 * The one Meta webhook logic WhatsApp and Instagram share (backlog:87d4769dde7e).
 *
 * Both Meta adapters fixed the same three defects in separate reviews
 * (#232 WhatsApp, #233 Instagram): batched webhook deliveries truncated to
 * the first message, echoes off our own account applied as customer
 * inbound, and the 24-hour service window read from caller time or
 * adapter-global memory. Each fix landed in its own adapter first; this
 * module holds the common rule once, and both adapters delegate to it:
 *
 * - batches: {@link iterateMetaBatchItems} walks every `entry` of a
 *   verified webhook body in document order — the Cloud API dialect
 *   (`entry[].changes[].value.{messages[],statuses[]}`) and the Graph
 *   dialect (`entry[].messaging[]`) — so one delivery normalizes to one
 *   channel event per item, never only the first;
 * - echoes: {@link isMetaSelfEcho} spots a delivery off our own account —
 *   the Graph `is_echo` flag or a sender/line id equal to the bound
 *   account — so it never becomes a customer. The disposition stays with
 *   the adapter (WhatsApp quarantines the echo as evidence with an empty
 *   subject, Instagram leaves it out of the inbox), only the detection is
 *   shared;
 * - window: {@link checkMetaServiceWindow} classifies the server-provided
 *   window observation (`{ lastInboundAt }` operations resolves from the
 *   inbox, never caller time, never adapter memory) against one rule —
 *   absent, non-canonical, beyond-skew future, or stale. The adapters map
 *   the verdict to their own errors, so messages stay provider-specific
 *   while the policy lives here once.
 *
 * Provider time is never trusted here beyond classification: a skewed or
 * forged instant travels through as data and the ingest path quarantines
 * it centrally (receive time + anomaly note), exactly as before.
 */

/** The Meta customer-service window: free replies only within 24h of the last inbound. */
export const META_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function malformedEvent(providerLabel, reason) {
  throw new AppError(`${providerLabel} event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

/**
 * Parse one verified webhook body to the object the batch iterator walks.
 * Throws `CHANNEL_EVENT_MALFORMED` when the body is not JSON or not an
 * object — the same refusal both adapters raised inline before.
 *
 * @param {unknown} event the verified event string the transport hands in
 * @param {string} providerLabel the adapter name for the refusal text (e.g. `'WhatsApp'`)
 * @returns {Record<string, any>} the parsed webhook body
 */
export function parseMetaWebhookBody(event, providerLabel) {
  let parsed;
  try {
    parsed = JSON.parse(String(event));
  } catch {
    malformedEvent(providerLabel, 'body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformedEvent(providerLabel, 'body is not an object');
  }
  return /** @type {Record<string, any>} */ (parsed);
}

/**
 * Every Meta item of one verified delivery, in document order — both
 * envelope dialects at once. The ingest path stores exactly one inbox row
 * per normalized event, so every item of a batched delivery lands and
 * nothing is truncated to the first item.
 *
 * - Cloud API dialect (`entry[].changes[].value`): `messages[]` items keep
 *   `kind: 'message'`, `statuses[]` items keep `kind: 'status'`. Entries
 *   whose `value.messaging_product` names another product are skipped when
 *   `messagingProduct` is given (WhatsApp passes `'whatsapp'`).
 * - Graph dialect (`entry[].messaging[]`): items keep `kind: 'message'`.
 *   Echo, receipt and id filtering stays with the caller — WhatsApp and
 *   Instagram dispose of non-customer items differently (quarantine vs.
 *   skip) — so this iterator never drops a raw item on its own.
 *
 * @param {Record<string, any>} parsed the parsed webhook body
 * @param {{ messagingProduct?: string }} [options]
 * @returns {Array<{ dialect: 'cloud' | 'graph', kind: 'message' | 'status', item: Record<string, any> }>}
 */
export function iterateMetaBatchItems(parsed, options = {}) {
  const messagingProduct = options.messagingProduct;
  const entries = Array.isArray(parsed?.entry) ? parsed.entry : [];
  /** @type {Array<{ dialect: 'cloud' | 'graph', kind: 'message' | 'status', item: Record<string, any> }>} */
  const found = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = /** @type {any} */ (entry).changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        const value = change?.value;
        if (!value || typeof value !== 'object') continue;
        if (messagingProduct !== undefined
          && value.messaging_product !== undefined
          && value.messaging_product !== messagingProduct) continue;
        for (const item of Array.isArray(value.messages) ? value.messages : []) {
          if (item && typeof item === 'object') found.push({ dialect: 'cloud', kind: 'message', item });
        }
        for (const item of Array.isArray(value.statuses) ? value.statuses : []) {
          if (item && typeof item === 'object') found.push({ dialect: 'cloud', kind: 'status', item });
        }
      }
    }
    const messaging = /** @type {any} */ (entry).messaging;
    if (Array.isArray(messaging)) {
      for (const item of messaging) {
        if (item && typeof item === 'object') found.push({ dialect: 'graph', kind: 'message', item });
      }
    }
  }
  return found;
}

/**
 * True when a raw Meta item is our own account talking, never a customer:
 * the Graph `is_echo` flag, or a Cloud API line id (`from` on messages,
 * `recipient_id` on statuses) equal to the bound account (`ownId` — the
 * canonical business number on Cloud API, canonicalized by the caller
 * before comparing; the page id on Graph). An echo never maps to a
 * customer conversation; the adapter decides quarantine vs. skip.
 *
 * Deliberately narrow: a Graph `messaging` item whose sender is our page
 * id but carries NO `is_echo` flag is NOT an echo here — main applies it
 * as inbound today (the channel kit seeds its windowed inbound exactly
 * that way), so flagging it would be a regression, not this cure. That
 * hardening is a follow-up, not part of this module.
 *
 * @param {unknown} item one raw `messages[]`, `statuses[]` or `messaging[]` item
 * @param {string} [ownId] the bound account id the echo is compared against
 * @returns {boolean}
 */
export function isMetaSelfEcho(item, ownId = '') {
  if (!item || typeof item !== 'object') return false;
  const raw = /** @type {Record<string, any>} */ (item);
  if (raw.is_echo === true) return true;
  if (typeof ownId !== 'string' || ownId === '') return false;
  if (typeof raw.from === 'string' && raw.from === ownId) return true;
  if (typeof raw.recipient_id === 'string' && raw.recipient_id === ownId) return true;
  return false;
}

/**
 * Classify the window observation against the one Meta service-window
 * rule both adapters enforce. `observedAt` is the `{ lastInboundAt }`
 * instant operations resolved server-side from the inbox — never caller
 * time, never adapter memory. Pure: it never throws, the caller maps the
 * verdict to its own refusal errors (both adapters refuse `missing`,
 * `future` and `stale` with `CHANNEL_TEMPLATE_REQUIRED` and reject
 * `invalid` as malformed; messages stay provider-specific).
 *
 * - `missing`: no observation — free text refuses, a template may still send;
 * - `invalid`: not a canonical ISO-8601 instant — the observation itself is malformed;
 * - `future`: past `nowMs() + skewMs` — provider time never holds the window open;
 * - `stale`: older than `windowMs` — outside the window, a template may still send;
 * - `ok`: inside the window.
 *
 * @param {unknown} observedAt the `{ lastInboundAt }` observation
 * @param {{ nowMs: () => number, windowMs?: number, skewMs?: number }} options
 * @returns {'ok' | 'missing' | 'invalid' | 'future' | 'stale'}
 */
export function checkMetaServiceWindow(observedAt, options) {
  const nowMs = options?.nowMs;
  const windowMs = options?.windowMs ?? META_CUSTOMER_SERVICE_WINDOW_MS;
  const skewMs = options?.skewMs ?? 0;
  if (observedAt === undefined || observedAt === null) return 'missing';
  if (typeof observedAt !== 'string') return 'invalid';
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at) || new Date(observedAt).toISOString() !== observedAt) return 'invalid';
  const now = nowMs();
  if (at > now + skewMs) return 'future';
  if (now - at > windowMs) return 'stale';
  return 'ok';
}
