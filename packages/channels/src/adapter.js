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
  const unknown = names.find((key) => !ADAPTER_KEYS.includes(key));
  if (unknown) {
    throw new ValidationError(`channel adapter carries an unsupported field "${unknown}"`, { field: `adapter.${unknown}` });
  }
  const value = /** @type {Record<string, any>} */ (definition);
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
