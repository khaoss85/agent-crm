// @ts-check

import { AppError, ValidationError, computeDefinitionFingerprint, createDefinitionVersionStore } from '../../core/index.js';

/**
 * The payment adapter contract (backlog:1972e16d33f2).
 *
 * One named, versioned definition per payment provider (Stripe Checkout and
 * Payment Links today, through the fixture until real credentials exist).
 * Like every declared definition (ADR-015) it is code-first, validated
 * fail-closed at composition, and fingerprinted — a changed adapter source
 * or config is a new version, never a silent edit.
 *
 * The lifecycle mirrors the M11 external-operation shape the packet names
 * (intent → external → finalize):
 * - intent: the local `payment-request` row (`open`);
 * - external: `createPayment`, the one provider call that mints the checkout
 *   or payment link from the intent;
 * - finalize: `verifyInbound` + `normalizeInbound` on the provider webhook,
 *   which moves the intent to its terminal state exactly once.
 *
 * `normalizeInbound` returns one event per provider item: a single object
 * for a single delivery, or a list when the provider batches several items
 * in one webhook. Operations stores one event row per item, atomically,
 * with dedup per providerEventId — an adapter never truncates a batch.
 */

export const PAYMENT_ADAPTER_CONTRACT = 1;

/** Providers one connection may bind. New providers are new enum values. */
export const PAYMENT_PROVIDERS = Object.freeze(['stripe']);

const ADAPTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const ADAPTER_KEYS = Object.freeze([
  'name', 'version', 'label', 'provider', 'config',
  'verifyInbound', 'normalizeInbound', 'createPayment',
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
export function validatePaymentAdapter(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new ValidationError('payment adapter must be a plain object', { field: 'adapter' });
  }
  const names = Object.getOwnPropertyNames(definition);
  if (names.some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('payment adapter carries a hostile key', { field: 'adapter' });
  }
  for (const key of ADAPTER_KEYS) {
    if (!Object.hasOwn(definition, key)) {
      throw new ValidationError(`payment adapter requires "${key}"`, { field: `adapter.${key}` });
    }
  }
  const unknown = names.find((key) => !ADAPTER_KEYS.includes(key));
  if (unknown) {
    throw new ValidationError(`payment adapter carries an unsupported field "${unknown}"`, { field: `adapter.${unknown}` });
  }
  const value = /** @type {Record<string, any>} */ (definition);
  if (typeof value.name !== 'string' || !ADAPTER_NAME.test(value.name) || value.name.length > 64) {
    throw new ValidationError('payment adapter name must match ^[a-z][a-z0-9-]*$ (at most 64 characters)', { field: 'adapter.name' });
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new ValidationError('payment adapter version must be a positive integer', { field: 'adapter.version' });
  }
  if (typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 128) {
    throw new ValidationError('payment adapter label must be bounded non-blank text', { field: 'adapter.label' });
  }
  if (!PAYMENT_PROVIDERS.includes(value.provider)) {
    throw new ValidationError(`payment adapter provider must be one of: ${PAYMENT_PROVIDERS.join(', ')}`, { field: 'adapter.provider' });
  }
  if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)
    || !isPlainJsonSafe(value.config)) {
    throw new ValidationError('payment adapter config must be plain JSON-safe data', { field: 'adapter.config' });
  }
  for (const handler of ['verifyInbound', 'normalizeInbound', 'createPayment']) {
    if (typeof value[handler] !== 'function') {
      throw new ValidationError(`payment adapter ${handler} must be a function`, { field: `adapter.${handler}` });
    }
  }
  // Declared config AND handler source are inside the fingerprint: a changed
  // threshold, key or line of adapter code is a different definition, which
  // is what stops a silent edit at boot (ADR-015).
  const fingerprint = computeDefinitionFingerprint({
    type: 'payment-adapter',
    name: value.name,
    version: value.version,
    provider: value.provider,
    config: value.config,
    verifyInbound: value.verifyInbound,
    normalizeInbound: value.normalizeInbound,
    createPayment: value.createPayment,
  });
  return Object.freeze({
    contract: PAYMENT_ADAPTER_CONTRACT,
    name: value.name,
    version: value.version,
    label: value.label,
    provider: value.provider,
    config: Object.freeze(structuredClone(value.config)),
    verifyInbound: value.verifyInbound,
    normalizeInbound: value.normalizeInbound,
    createPayment: value.createPayment,
    fingerprint,
  });
}

/** Map-backed, unique-per-identity adapter registry with fingerprints. */
export class PaymentRegistries {
  /** @param {{paymentAdapters?: any[]}} [options] */
  constructor(options = {}) {
    const adapters = options.paymentAdapters ?? [];
    if (!Array.isArray(adapters)) {
      throw new ValidationError('payment adapters must be an array', { field: 'paymentAdapters' });
    }
    this.adapters = new Map();
    for (const definition of adapters) {
      const adapter = validatePaymentAdapter(definition);
      // Same name with another version coexists; the same identity twice is a
      // composition fault. The version is always explicit — never an implicit
      // latest — so there is no "which one" to resolve later.
      const key = `${adapter.name}@${adapter.version}`;
      if (this.adapters.has(key)) {
        throw new ValidationError(`Duplicate payment adapter identity: ${key}`, { field: 'paymentAdapters' });
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
      throw new AppError('Unknown payment adapter', { code: 'PAYMENT_ADAPTER_UNKNOWN', status: 404 });
    }
    const entry = this.adapters.get(`${name}@${version}`);
    if (!entry) {
      throw new AppError('Unknown payment adapter', { code: 'PAYMENT_ADAPTER_UNKNOWN', status: 404 });
    }
    return entry;
  }

  metadata() {
    return Object.freeze({
      paymentAdapterContract: PAYMENT_ADAPTER_CONTRACT,
      adapters: [...this.adapters.values()].map((entry) => Object.freeze({
        name: entry.definition.name,
        version: entry.definition.version,
        label: entry.definition.label,
        provider: entry.definition.provider,
        fingerprint: entry.fingerprint,
      })),
    });
  }

  /** @param {any} database */
  persistFingerprints(database) {
    const entries = [...this.adapters.values()];
    if (entries.length === 0) return;
    createDefinitionVersionStore(database).persist(entries.map((entry) => ({
      type: 'payment-adapter',
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: entry.fingerprint,
    })));
  }
}
