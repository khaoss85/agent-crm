// @ts-check

import { AppError, ValidationError, computeDefinitionFingerprint, createDefinitionVersionStore } from '../../core/index.js';

/**
 * The channel adapter contract (backlog:e5532d1c9146).
 *
 * An adapter is the per-channel binding the framework never invents: one
 * named, versioned definition per channel protocol (WhatsApp Business Cloud,
 * Instagram Graph, …). Like every declared definition (ADR-015) it is
 * code-first, validated fail-closed at composition, and fingerprinted — a
 * changed adapter source or config is a new version, never a silent edit.
 *
 * Today the only adapters are fixtures: real credentials do not exist yet
 * (owner decision MEM_ACC_DECISIONS), so every adapter runs against the kit
 * in `kit.js` with a fixture secret. A real adapter implements the same
 * five functions against its provider's scheme.
 *
 * `normalizeInbound` returns one channel event per provider item: a single
 * object for a single delivery, or a list of event objects when the
 * provider batches several items in one webhook (Meta's messages[] plus
 * statuses[]). `operations.js` stores one inbox row per event, atomically,
 * with dedup per providerEventId — an adapter never truncates a batch to
 * its first item.
 *
 * An adapter whose provider keeps readable past additionally declares the
 * optional `historyImport` capability: `{ windowMs, listHistory }`.
 * `operations.js` then pulls that past one bounded page per advance call —
 * never the whole history in one call — stores one inbox row per event
 * through the same deduped path as webhooks, and reconciles every imported
 * sender through the composed `channel-sender@1` capability. Adapters
 * without it behave exactly as before: starting their import refuses with
 * `CHANNEL_HISTORY_UNAVAILABLE`.
 *
 * `listHistory({ secret, account, since, pageToken, limit })` resolves to
 * `{ events, nextPageToken }`: `events` are channel events in the
 * `normalizeInbound` shape (an event may carry an optional `sender`
 * `{ handle, email?, firstName?, lastName? }` the import reconciles);
 * `nextPageToken` is an opaque bounded cursor, or null when the past is
 * exhausted. The same token replays the same page — that determinism is
 * what makes an interrupted import resume instead of restart.
 *
 * An adapter whose provider restricts free text to a service window (Meta's
 * 24-hour customer-service window) additionally declares the optional
 * `outboundWindow` capability: `{ windowMs, subjectForRecipient,
 * seedInbound, isObservation }`. `operations.js` then resolves the last
 * inbound observation server-side from the inbox and hands it to
 * `normalizeOutbound` as `{ lastInboundAt }` — a caller-supplied instant is
 * never trusted on that path — and `kit.js` seeds one windowed inbound
 * before its send check. Adapters without it behave exactly as before.
 */

export const CHANNEL_ADAPTER_CONTRACT = 1;

/** Channels one connection may bind. New channels are new enum values. */
export const CHANNELS = Object.freeze([
  'whatsapp',
  'instagram',
  'facebook',
  'tiktok',
  'sms',
  'email',
  'voice',
  'site-form',
]);

const ADAPTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const ADAPTER_KEYS = Object.freeze([
  'name', 'version', 'label', 'channel', 'config',
  'verifyInbound', 'normalizeInbound', 'normalizeOutbound', 'sendOutbound',
]);
const ADAPTER_OPTIONAL_KEYS = Object.freeze(['outboundWindow', 'historyImport']);

/**
 * Bounds for the progressive initial history import (backlog:66282d13d81c):
 * an adapter that can list its provider's past may declare `historyImport`
 * so connecting the channel starts a paged, resumable import of that past.
 */
export const CHANNEL_HISTORY_WINDOW_MAX_MS = 366 * 24 * 3600 * 1000;
export const CHANNEL_HISTORY_PAGE_MAX = 100;
export const CHANNEL_HISTORY_TOKEN_MAX = 256;

function isPlainJsonSafe(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.length <= 500 && value.every((entry) => isPlainJsonSafe(entry, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).every((key) => key.length <= 128 && !HOSTILE_KEYS.includes(key)
    && isPlainJsonSafe(value[key], depth + 1));
}

/**
 * Validate the optional service-window capability fail-closed. Absent is
 * fine (adapters without a window behave exactly as before); present must
 * be the full shape — a half-declared window would enforce nothing while
 * looking enforced.
 */
function validateOutboundWindow(window) {
  if (window === undefined) return;
  if (!window || typeof window !== 'object' || Array.isArray(window)) {
    throw new ValidationError('channel adapter outboundWindow must be a plain object', { field: 'adapter.outboundWindow' });
  }
  if (Object.getOwnPropertyNames(window).some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('channel adapter outboundWindow carries a hostile key', { field: 'adapter.outboundWindow' });
  }
  if (!Number.isSafeInteger(window.windowMs) || window.windowMs < 1 || window.windowMs > 30 * 24 * 3600 * 1000) {
    throw new ValidationError('channel adapter outboundWindow.windowMs must be a positive duration in milliseconds', {
      field: 'adapter.outboundWindow.windowMs',
    });
  }
  for (const key of ['subjectForRecipient', 'seedInbound', 'isObservation']) {
    if (typeof window[key] !== 'function') {
      throw new ValidationError(`channel adapter outboundWindow.${key} must be a function`, {
        field: `adapter.outboundWindow.${key}`,
      });
    }
  }
}

/**
 * Validate the optional history-import capability fail-closed. Absent is
 * fine (adapters without readable past behave exactly as before); present
 * must be the full shape — a half-declared import would page nothing while
 * looking resumable.
 */
function validateHistoryImport(history) {
  if (history === undefined) return;
  if (!history || typeof history !== 'object' || Array.isArray(history)) {
    throw new ValidationError('channel adapter historyImport must be a plain object', { field: 'adapter.historyImport' });
  }
  if (Object.getOwnPropertyNames(history).some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('channel adapter historyImport carries a hostile key', { field: 'adapter.historyImport' });
  }
  if (!Number.isSafeInteger(history.windowMs) || history.windowMs < 1 || history.windowMs > CHANNEL_HISTORY_WINDOW_MAX_MS) {
    throw new ValidationError('channel adapter historyImport.windowMs must be a positive duration in milliseconds (at most 366 days)', {
      field: 'adapter.historyImport.windowMs',
    });
  }
  if (typeof history.listHistory !== 'function') {
    throw new ValidationError('channel adapter historyImport.listHistory must be a function', {
      field: 'adapter.historyImport.listHistory',
    });
  }
}

function isCanonicalInstant(value) {
  if (typeof value !== 'string' || value === '') return false;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value;
}

function assertHistorySender(sender) {
  if (sender === undefined) return undefined;
  if (!sender || typeof sender !== 'object' || Array.isArray(sender)) {
    throw new ValidationError('channel history event sender must be a plain object', { field: 'sender' });
  }
  const handle = typeof sender.handle === 'string' ? sender.handle : '';
  if (handle === '' || handle.length > 256) {
    throw new ValidationError('channel history event sender needs a bounded handle (1-256 characters)', { field: 'sender.handle' });
  }
  const bounded = (name, max) => {
    const value = sender[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value === '' || value.length > max) {
      throw new ValidationError(`channel history event sender.${name} must be bounded text when present`, { field: `sender.${name}` });
    }
    return value;
  };
  return {
    handle,
    ...(bounded('email', 256) === undefined ? {} : { email: bounded('email', 256) }),
    ...(bounded('firstName', 128) === undefined ? {} : { firstName: bounded('firstName', 128) }),
    ...(bounded('lastName', 128) === undefined ? {} : { lastName: bounded('lastName', 128) }),
  };
}

/**
 * Validate one history page against the channel-event contract both the
 * import engine and the adapter kit enforce: the same four fields the
 * webhook ingest requires, plus the optional sender evidence. Throws
 * fail-closed; returns the frozen page the engine stores and reconciles.
 *
 * @param {unknown} page @param {number} limit
 */
export function assertHistoryPage(page, limit) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new ValidationError('channel history page must be a plain object', { field: 'historyPage' });
  }
  const { events, nextPageToken } = /** @type {{events?: unknown, nextPageToken?: unknown}} */ (page);
  if (!Array.isArray(events) || events.length > limit) {
    throw new ValidationError(`channel history page carries 0-${limit} events`, { field: 'historyPage.events' });
  }
  if (nextPageToken !== null
    && (typeof nextPageToken !== 'string' || nextPageToken === '' || nextPageToken.length > CHANNEL_HISTORY_TOKEN_MAX)) {
    throw new ValidationError('channel history nextPageToken must be null or bounded opaque text', { field: 'historyPage.nextPageToken' });
  }
  const checked = events.map((event, index) => {
    const field = `historyPage.events[${index}]`;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new ValidationError('channel history event must be a plain object', { field });
    }
    const entry = /** @type {Record<string, any>} */ (event);
    if (typeof entry.providerEventId !== 'string' || entry.providerEventId === '' || entry.providerEventId.length > 256) {
      throw new ValidationError('channel history event needs a bounded providerEventId', { field: `${field}.providerEventId` });
    }
    if (typeof entry.subject !== 'string' || entry.subject.length > 256) {
      throw new ValidationError('channel history event needs a bounded subject', { field: `${field}.subject` });
    }
    if (entry.sequence !== null && entry.sequence !== undefined && !Number.isSafeInteger(entry.sequence)) {
      throw new ValidationError('channel history event sequence must be an integer when present', { field: `${field}.sequence` });
    }
    if (entry.occurredAt !== null && entry.occurredAt !== undefined && !isCanonicalInstant(entry.occurredAt)) {
      throw new ValidationError('channel history event occurredAt must be a canonical instant when present', { field: `${field}.occurredAt` });
    }
    return Object.freeze({
      providerEventId: entry.providerEventId,
      subject: entry.subject,
      sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : null,
      occurredAt: isCanonicalInstant(entry.occurredAt) ? entry.occurredAt : null,
      sender: assertHistorySender(entry.sender),
    });
  });
  return Object.freeze({ events: Object.freeze(checked), nextPageToken: nextPageToken ?? null });
}

/**
 * Validate one adapter definition fail-closed. Returns the frozen,
 * fingerprinted definition the registries store.
 */
export function validateChannelAdapter(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new ValidationError('channel adapter must be a plain object', { field: 'adapter' });
  }
  const names = Object.getOwnPropertyNames(definition);
  if (names.some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('channel adapter carries a hostile key', { field: 'adapter' });
  }
  for (const key of ADAPTER_KEYS) {
    if (!Object.hasOwn(definition, key)) {
      throw new ValidationError(`channel adapter requires "${key}"`, { field: `adapter.${key}` });
    }
  }
  const unknown = names.find((key) => !ADAPTER_KEYS.includes(key) && !ADAPTER_OPTIONAL_KEYS.includes(key));
  if (unknown) {
    throw new ValidationError(`channel adapter carries an unsupported field "${unknown}"`, { field: `adapter.${unknown}` });
  }
  const value = /** @type {Record<string, any>} */ (definition);
  validateOutboundWindow(value.outboundWindow);
  validateHistoryImport(value.historyImport);
  if (typeof value.name !== 'string' || !ADAPTER_NAME.test(value.name) || value.name.length > 64) {
    throw new ValidationError('channel adapter name must match ^[a-z][a-z0-9-]*$ (at most 64 characters)', { field: 'adapter.name' });
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new ValidationError('channel adapter version must be a positive integer', { field: 'adapter.version' });
  }
  if (typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 128) {
    throw new ValidationError('channel adapter label must be bounded non-blank text', { field: 'adapter.label' });
  }
  if (!CHANNELS.includes(value.channel)) {
    throw new ValidationError(`channel adapter channel must be one of: ${CHANNELS.join(', ')}`, { field: 'adapter.channel' });
  }
  if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)
    || !isPlainJsonSafe(value.config)) {
    throw new ValidationError('channel adapter config must be plain JSON-safe data', { field: 'adapter.config' });
  }
  for (const handler of ['verifyInbound', 'normalizeInbound', 'normalizeOutbound', 'sendOutbound']) {
    if (typeof value[handler] !== 'function') {
      throw new ValidationError(`channel adapter ${handler} must be a function`, { field: `adapter.${handler}` });
    }
  }
  // Declared config AND handler source are inside the fingerprint: a changed
  // threshold, key or line of adapter code is a different definition, which is
  // what stops a silent edit at boot (ADR-015, same shape as M11 providers).
  const fingerprint = computeDefinitionFingerprint({
    type: 'channel-adapter',
    name: value.name,
    version: value.version,
    channel: value.channel,
    config: value.config,
    verifyInbound: value.verifyInbound,
    normalizeInbound: value.normalizeInbound,
    normalizeOutbound: value.normalizeOutbound,
    sendOutbound: value.sendOutbound,
    ...(value.outboundWindow === undefined ? {} : { outboundWindow: value.outboundWindow }),
    ...(value.historyImport === undefined ? {} : { historyImport: value.historyImport }),
  });
  return Object.freeze({
    contract: CHANNEL_ADAPTER_CONTRACT,
    name: value.name,
    version: value.version,
    label: value.label,
    channel: value.channel,
    config: Object.freeze(structuredClone(value.config)),
    verifyInbound: value.verifyInbound,
    normalizeInbound: value.normalizeInbound,
    normalizeOutbound: value.normalizeOutbound,
    sendOutbound: value.sendOutbound,
    ...(value.outboundWindow === undefined ? {} : { outboundWindow: Object.freeze({ ...value.outboundWindow }) }),
    ...(value.historyImport === undefined ? {} : { historyImport: Object.freeze({ ...value.historyImport }) }),
    fingerprint,
  });
}

/** Map-backed, unique-per-identity adapter registry with fingerprints. */
export class ChannelRegistries {
  /** @param {{channelAdapters?: any[]}} [options] */
  constructor(options = {}) {
    const adapters = options.channelAdapters ?? [];
    if (!Array.isArray(adapters)) {
      throw new ValidationError('channel adapters must be an array', { field: 'channelAdapters' });
    }
    this.adapters = new Map();
    for (const definition of adapters) {
      const adapter = validateChannelAdapter(definition);
      // Same name with another version coexists; the same identity twice is a
      // composition fault. The version is always explicit — never an implicit
      // latest — so there is no "which one" to resolve later.
      const key = `${adapter.name}@${adapter.version}`;
      if (this.adapters.has(key)) {
        throw new ValidationError(`Duplicate channel adapter identity: ${key}`, { field: 'channelAdapters' });
      }
      this.adapters.set(key, Object.freeze({ definition: adapter, fingerprint: adapter.fingerprint }));
    }
  }

  /**
   * @param {string} name @param {number} version — returns {definition, fingerprint}
   */
  getAdapter(name, version) {
    if (typeof name !== 'string' || HOSTILE_KEYS.includes(name)
      || !Number.isSafeInteger(version) || version < 1) {
      throw new AppError('Unknown channel adapter', { code: 'CHANNEL_ADAPTER_UNKNOWN', status: 404 });
    }
    const entry = this.adapters.get(`${name}@${version}`);
    if (!entry) {
      throw new AppError('Unknown channel adapter', { code: 'CHANNEL_ADAPTER_UNKNOWN', status: 404 });
    }
    return entry;
  }

  metadata() {
    return Object.freeze({
      channelAdapterContract: CHANNEL_ADAPTER_CONTRACT,
      adapters: [...this.adapters.values()].map((entry) => Object.freeze({
        name: entry.definition.name,
        version: entry.definition.version,
        label: entry.definition.label,
        channel: entry.definition.channel,
        fingerprint: entry.fingerprint,
      })),
    });
  }

  /** @param {any} database */
  persistFingerprints(database) {
    const entries = [...this.adapters.values()];
    if (entries.length === 0) return;
    createDefinitionVersionStore(database).persist(entries.map((entry) => ({
      type: 'channel-adapter',
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: entry.fingerprint,
    })));
  }
}
