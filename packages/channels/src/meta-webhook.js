// @ts-check

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../core/index.js';

/**
 * The one Meta webhook logic WhatsApp, Instagram and Messenger share
 * (backlog:87d4769dde7e, backlog:23d5b455cb3a).
 *
 * Both Meta adapters fixed the same three defects in separate reviews
 * (#232 WhatsApp, #233 Instagram): batched webhook deliveries truncated to
 * the first message, echoes off our own account applied as customer
 * inbound, and the 24-hour service window read from caller time or
 * adapter-global memory. Each fix landed in its own adapter first; this
 * module holds the common rule once, and every Meta adapter delegates to
 * it — Messenger adds no copy, including for the hub-signature check:
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
 * - auth: {@link verifyMetaHubSignature} checks Meta's
 *   `x-hub-signature-256` HMAC over the exact bytes before parsing — one
 *   copy for every Meta adapter, so the forgery decision cannot drift
 *   between WhatsApp, Instagram and Messenger.
 *
 * Provider time is never trusted here beyond classification: a skewed or
 * forged instant travels through as data and the ingest path quarantines
 * it centrally (receive time + anomaly note), exactly as before.
 */

/** The Meta customer-service window: free replies only within 24h of the last inbound. */
export const META_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time check of Meta's `sha256=<hex>` hub signature over the raw
 * body — the one production authentication every Meta adapter verifies
 * before parsing (`x-hub-signature-256`, shared by the Meta app WhatsApp,
 * Instagram and Messenger all ride). One copy on purpose: two copies of
 * an authentication check drift, and the drift decides forgeries.
 *
 * @param {unknown} rawBody the exact bytes the provider signed
 * @param {unknown} signature the `x-hub-signature-256` header value
 * @param {unknown} secret the app secret (compared in memory, never stored)
 * @returns {boolean} true only on a valid `sha256=<hex>` HMAC
 */
/**
 * The attachment kinds an inbound channel message can carry (backlog:32820692).
 * One reference per message: the CRM keeps the provider's reference (type,
 * display name, byte size, fetch handle) so the card can show a thumbnail, a
 * player or an icon — the bytes themselves never land in a row, a log or a
 * prompt. A photo, a video, a voice note or a PDF all fit; anything else
 * (stickers ride as photos) is documented per dialect below.
 */
export const CHANNEL_ATTACHMENT_KINDS = Object.freeze(['photo', 'video', 'audio', 'document']);

/** Display-name bound: a provider filename is a label, never a path. */
const MAX_ATTACHMENT_NAME = 200;
/** Fetch-handle bound: a media id or a bounded provider URL, never bytes. */
const MAX_ATTACHMENT_REF = 500;
/** Sanity cap: provider media limits sit well below this. */
const MAX_ATTACHMENT_BYTES = 134217728;

function malformedAttachment(providerLabel, reason) {
  throw new AppError(`${providerLabel} attachment is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

/**
 * Validate one attachment descriptor both Meta dialects build (backlog:32820692).
 * Fail-closed, and the refusal never echoes provider bytes: names and fetch
 * handles are caller-controlled enough to carry secrets, so errors name the
 * field, never the value. Returns the frozen descriptor the channel event
 * carries — the inbox keeps the envelope only, and the host logs the message
 * (with this reference) through `interaction-log@1`.
 *
 * @param {unknown} value the descriptor `{kind, name?, size?, ref}`
 * @param {string} providerLabel the adapter name for the refusal text
 */
export function assertChannelAttachment(value, providerLabel) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    malformedAttachment(providerLabel, 'attachment must be a plain object');
  }
  const entry = /** @type {Record<string, any>} */ (value);
  if (!CHANNEL_ATTACHMENT_KINDS.includes(entry.kind)) {
    malformedAttachment(providerLabel, 'attachment kind must be one of photo, video, audio or document');
  }
  let name = null;
  if (entry.name !== undefined && entry.name !== null && entry.name !== '') {
    if (typeof entry.name !== 'string') malformedAttachment(providerLabel, 'attachment name must be bounded display text when present');
    const trimmed = entry.name.trim();
    if (trimmed === '' || trimmed.length > MAX_ATTACHMENT_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
      malformedAttachment(providerLabel, 'attachment name must be bounded display text when present');
    }
    name = trimmed;
  }
  let size = null;
  if (entry.size !== undefined && entry.size !== null) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ATTACHMENT_BYTES) {
      malformedAttachment(providerLabel, 'attachment size must be a whole number of bytes within bounds when present');
    }
    size = entry.size;
  }
  let preview = null;
  if (entry.preview !== undefined && entry.preview !== null && entry.preview !== '') {
    if (typeof entry.preview !== 'string' || entry.preview.length > MAX_ATTACHMENT_REF
      || /[\s\u0000-\u001f\u007f-\u009f]/.test(entry.preview)) {
      malformedAttachment(providerLabel, 'attachment preview must be a bounded fetch handle without whitespace when present');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry.preview)) {
      let parsedPreview = null;
      try {
        parsedPreview = new URL(entry.preview);
      } catch {
        parsedPreview = null;
      }
      if (!parsedPreview || parsedPreview.protocol !== 'https:' || parsedPreview.username !== '' || parsedPreview.password !== '') {
        malformedAttachment(providerLabel, 'attachment preview must be a clean https URL when URL-shaped');
      }
    }
    preview = entry.preview;
  }
  if (typeof entry.ref !== 'string' || entry.ref === '' || entry.ref.length > MAX_ATTACHMENT_REF
    || /[\s\u0000-\u001f\u007f-\u009f]/.test(entry.ref)) {
    malformedAttachment(providerLabel, 'attachment ref must be a bounded fetch handle without whitespace');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry.ref)) {
    // A URL-shaped handle is fetched server-side with the call-time secret,
    // so it must never smuggle credentials or a session: https only, and no
    // userinfo — a token in the URL would ride into rows and renders.
    let parsed = null;
    try {
      parsed = new URL(entry.ref);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      malformedAttachment(providerLabel, 'attachment ref must be a clean https URL when URL-shaped');
    }
  }
  return Object.freeze({ kind: entry.kind, name, size, ref: entry.ref, preview });
}

/**
 * The text plus the single attachment of one WhatsApp Cloud API message
 * item (backlog:32820692). `type: 'text'` reads `text.body`; every media
 * type reads its caption, so a photo with a caption keeps its words and a
 * photo without one reads as no text rather than an empty message. The
 * Cloud API carries one media object per message, so one event carries at
 * most one attachment: `image` is a photo, `video` and `audio` keep their
 * kind, `document` keeps its provider filename, and `sticker` rides as a
 * photo (a webp the card thumbnails like any photo). A media object without
 * its fetch id, or a type this map does not know (reactions, contacts,
 * locations, interactive payloads), yields no attachment — the envelope is
 * still stored, exactly as before, and the gap is documented, not silent.
 *
 * @param {Record<string, any>} item one Cloud API `messages[]` item
 * @param {string} providerLabel the adapter name for the refusal text
 * @returns {{ text: string, attachment: null | ReturnType<typeof assertChannelAttachment> }}
 */
/**
 * The Cloud API text the card reads (backlog:32820692): WhatsApp markup is
 * display-only — `*bold*`, `_italic_`, `~strike~`, triple-backtick code —
 * so paired markers come off and the words stay, on one line at a time
 * (markers never span a line break) and only on word boundaries, so
 * `order_123_sent` keeps its underscores. An unmatched marker stays as
 * written rather than eating its line, and plain-text artefacts like
 * `2*3=6` keep their asterisk. Graph and Gmail text travel untouched: no
 * markup dialect there to misread.
 *
 * @param {string} text the provider caption or body
 */
export function readableCloudText(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.split('\n').map((line) => {
    let out = line.replace(/```([^`]+?)```/g, '$1');
    // Markers only read as markup on word boundaries: `order_123_sent` and
    // `2*3=6` keep their characters, while `*Promo*` and `(_note_)` render
    // as words. An unmatched marker stays as written.
    out = out.replace(/(^|[\s(\[{>])([*_~])([^*_~\n]+?)\2(?=[\s)\]}>.,;:!?]|$)/g, '$1$3');
    return out;
  }).join('\n');
}

export function normalizeCloudMessageContent(item, providerLabel) {
  const checkText = (text) => {
    if (typeof text !== 'string' || text.length > 4096) {
      malformedAttachment(providerLabel, 'message text must be text (at most 4096 characters)');
    }
    return text;
  };
  const mediaKind = { image: 'photo', video: 'video', audio: 'audio', document: 'document', sticker: 'photo' }[item?.type];
  if (item?.type === 'text') {
    const body = item?.text && typeof item.text === 'object' ? item.text.body : undefined;
    return { text: checkText(readableCloudText(typeof body === 'string' ? body : '')), attachment: null };
  }
  if (mediaKind === undefined) return { text: '', attachment: null };
  const media = item?.[item.type];
  const caption = media && typeof media === 'object' && typeof media.caption === 'string' ? media.caption : '';
  if (!media || typeof media !== 'object' || typeof media.id !== 'string' || media.id === '') {
    return { text: checkText(readableCloudText(caption)), attachment: null };
  }
  const name = item.type === 'document' && typeof media.filename === 'string' ? media.filename : null;
  return {
    text: checkText(readableCloudText(caption)),
    attachment: assertChannelAttachment({ kind: mediaKind, name, size: null, ref: media.id, preview: null }, providerLabel),
  };
}

/** Graph attachment type → the card kind it renders as (backlog:32820692). */
const GRAPH_ATTACHMENT_KINDS = Object.freeze({ image: 'photo', video: 'video', audio: 'audio', file: 'document' });

/**
 * The text plus every attachment of one Graph `message` object (backlog:32820692).
 * Instagram and Messenger share the shape: `message.text` plus
 * `message.attachments[]` with `{type, payload: {url}}`. Unknown attachment
 * types are skipped, never refused — one exotic sticker must not 422 the
 * two photos beside it — and a message whose attachments all skip reads as
 * text-only. The fetch handle is the provider URL; a URL carrying
 * credentials is refused by the shared assertion, never stored.
 *
 * @param {Record<string, any>} message one Graph `message` object
 * @param {string} providerLabel the adapter name for the refusal text
 * @returns {{ text: string, attachments: Array<ReturnType<typeof assertChannelAttachment>> }}
 */
export function normalizeGraphMessageContent(message, providerLabel) {
  const rawText = message?.text;
  const text = rawText === undefined ? '' : rawText;
  const raw = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = [];
  for (const candidate of raw) {
    const kind = candidate && typeof candidate === 'object' ? GRAPH_ATTACHMENT_KINDS[candidate.type] : undefined;
    if (kind === undefined) continue;
    const url = candidate?.payload && typeof candidate.payload === 'object' ? candidate.payload.url : undefined;
    if (typeof url !== 'string' || url === '') continue;
    try {
      attachments.push(assertChannelAttachment({ kind, name: null, size: null, ref: url }, providerLabel));
    } catch {
      // A URL the shared rule refuses (credentials in the handle) drops
      // that attachment only: the message and its siblings still land.
      continue;
    }
  }
  return { text, attachments };
}

export function verifyMetaHubSignature(rawBody, signature, secret) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  let expected;
  try {
    expected = createHmac('sha256', secret).update(body).digest();
  } catch {
    return false;
  }
  let provided;
  try {
    provided = Buffer.from(signature.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

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
