// @ts-check

import { AppError, ValidationError, computeDefinitionFingerprint, createDefinitionVersionStore } from '../../core/index.js';

/**
 * The LLM adapter contract (backlog:6e54d6a7988a).
 *
 * One named, versioned definition per language-model provider binding
 * (OpenAI's chat API, a future second provider, …). Like every declared
 * definition (ADR-015) it is code-first, validated fail-closed at
 * composition, and fingerprinted — a changed adapter source or config is a
 * new version, never a silent edit. Same schema as the channel adapters in
 * `packages/channels` and the calendar provider in `packages/calendar-sync`:
 * a fake adapter, a shared contract-test kit, and the real adapter proving
 * the same kit.
 *
 * An adapter turns caller-composed messages into one bounded completion:
 * `generate({ secret, messages, model, maxTokens, timeoutMs })` resolves to
 * `{ text, model, inputTokens, outputTokens }`. Token counts are the
 * provider's own usage figures when it reports them, otherwise the
 * adapter's documented estimate — the daily cap and the audit row read
 * them either way. A provider refusal maps to a typed error the package
 * relays without the secret: 401/403 is `LLM_AUTH_FAILED`, 429 is
 * `LLM_RATE_LIMITED`, a timeout or 5xx is `LLM_PROVIDER_TRANSIENT`, a bad
 * request the adapter could have validated is `LLM_REQUEST_INVALID`.
 * Anything else is `LLM_PROVIDER_FAILED`. No error text carries key
 * material, and no adapter logs the prompt.
 */

export const LLM_ADAPTER_CONTRACT = 1;

const ADAPTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const ADAPTER_KEYS = Object.freeze([
  'name', 'version', 'label', 'config', 'generate',
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

const MESSAGE_ROLES = Object.freeze(['system', 'user', 'assistant']);

/**
 * Validate one completion request the way every adapter receives it:
 * bounded roles and text, a bounded model name, a sane token ceiling.
 * Throws fail-closed; returns the frozen request the adapter executes.
 *
 * @param {unknown} input
 */
export function assertGenerateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('llm generate input must be a plain object', { field: 'input' });
  }
  const value = /** @type {Record<string, any>} */ (input);
  if (Object.getOwnPropertyNames(value).some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('llm generate input carries a hostile key', { field: 'input' });
  }
  const { messages, model, maxTokens } = value;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 64) {
    throw new ValidationError('llm generate needs 1-64 messages', { field: 'input.messages' });
  }
  const checked = messages.map((message, index) => {
    const field = `input.messages[${index}]`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ValidationError('llm message must be a plain object', { field });
    }
    const entry = /** @type {Record<string, any>} */ (message);
    if (!MESSAGE_ROLES.includes(entry.role)) {
      throw new ValidationError('llm message role must be system, user or assistant', { field: `${field}.role` });
    }
    if (typeof entry.content !== 'string' || entry.content === '' || entry.content.length > 32000) {
      throw new ValidationError('llm message content must be bounded non-empty text (at most 32000 characters)', {
        field: `${field}.content`,
      });
    }
    return Object.freeze({ role: entry.role, content: entry.content });
  });
  if (typeof model !== 'string' || model.trim() === '' || model.length > 128) {
    throw new ValidationError('llm model must be a bounded non-blank name', { field: 'input.model' });
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32000) {
    throw new ValidationError('llm maxTokens must be an integer between 1 and 32000', { field: 'input.maxTokens' });
  }
  return Object.freeze({ messages: Object.freeze(checked), model, maxTokens });
}

/**
 * Validate one completion the way every adapter returns it: bounded text,
 * the model that produced it, non-negative token counts. Throws
 * fail-closed; returns the frozen completion the package audits.
 *
 * @param {unknown} completion @param {string} expectedModel
 */
export function assertCompletion(completion, expectedModel) {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    throw new ValidationError('llm completion must be a plain object', { field: 'completion' });
  }
  const value = /** @type {Record<string, any>} */ (completion);
  if (typeof value.text !== 'string' || value.text === '' || value.text.length > 32000) {
    throw new ValidationError('llm completion text must be bounded non-empty text (at most 32000 characters)', {
      field: 'completion.text',
    });
  }
  if (value.model !== expectedModel) {
    throw new ValidationError('llm completion names the model it ran on', { field: 'completion.model' });
  }
  for (const key of ['inputTokens', 'outputTokens']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1000000) {
      throw new ValidationError(`llm completion ${key} must be a bounded non-negative integer`, {
        field: `completion.${key}`,
      });
    }
  }
  return Object.freeze({
    text: value.text,
    model: value.model,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
  });
}

/**
 * Validate one adapter definition fail-closed. Returns the frozen,
 * fingerprinted definition the registries store.
 */
export function validateLlmAdapter(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new ValidationError('llm adapter must be a plain object', { field: 'adapter' });
  }
  const names = Object.getOwnPropertyNames(definition);
  if (names.some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('llm adapter carries a hostile key', { field: 'adapter' });
  }
  for (const key of ADAPTER_KEYS) {
    if (!Object.hasOwn(definition, key)) {
      throw new ValidationError(`llm adapter requires "${key}"`, { field: `adapter.${key}` });
    }
  }
  const unknown = names.find((key) => !ADAPTER_KEYS.includes(key));
  if (unknown) {
    throw new ValidationError(`llm adapter carries an unsupported field "${unknown}"`, { field: `adapter.${unknown}` });
  }
  const value = /** @type {Record<string, any>} */ (definition);
  if (typeof value.name !== 'string' || !ADAPTER_NAME.test(value.name) || value.name.length > 64) {
    throw new ValidationError('llm adapter name must match ^[a-z][a-z0-9-]*$ (at most 64 characters)', { field: 'adapter.name' });
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new ValidationError('llm adapter version must be a positive integer', { field: 'adapter.version' });
  }
  if (typeof value.label !== 'string' || value.label.trim() === '' || value.label.length > 128) {
    throw new ValidationError('llm adapter label must be bounded non-blank text', { field: 'adapter.label' });
  }
  if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)
    || !isPlainJsonSafe(value.config)) {
    throw new ValidationError('llm adapter config must be plain JSON-safe data', { field: 'adapter.config' });
  }
  if (typeof value.generate !== 'function') {
    throw new ValidationError('llm adapter generate must be a function', { field: 'adapter.generate' });
  }
  // Declared config AND handler source are inside the fingerprint: a changed
  // threshold or line of adapter code is a different definition, which is
  // what stops a silent edit at boot (ADR-015, same shape as channels).
  const fingerprint = computeDefinitionFingerprint({
    type: 'llm-adapter',
    name: value.name,
    version: value.version,
    config: value.config,
    generate: value.generate,
  });
  return Object.freeze({
    contract: LLM_ADAPTER_CONTRACT,
    name: value.name,
    version: value.version,
    label: value.label,
    config: Object.freeze(structuredClone(value.config)),
    generate: value.generate,
    fingerprint,
  });
}

/** Map-backed, unique-per-identity adapter registry with fingerprints. */
export class LlmRegistries {
  /** @param {{llmAdapters?: any[]}} [options] */
  constructor(options = {}) {
    const adapters = options.llmAdapters ?? [];
    if (!Array.isArray(adapters)) {
      throw new ValidationError('llm adapters must be an array', { field: 'llmAdapters' });
    }
    this.adapters = new Map();
    for (const definition of adapters) {
      const adapter = validateLlmAdapter(definition);
      // Same name with another version coexists; the same identity twice is a
      // composition fault. The version is always explicit — never an implicit
      // latest — so there is no "which one" to resolve later.
      const key = `${adapter.name}@${adapter.version}`;
      if (this.adapters.has(key)) {
        throw new ValidationError(`Duplicate llm adapter identity: ${key}`, { field: 'llmAdapters' });
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
      throw new AppError('Unknown llm adapter', { code: 'LLM_ADAPTER_UNKNOWN', status: 404 });
    }
    const entry = this.adapters.get(`${name}@${version}`);
    if (!entry) {
      throw new AppError('Unknown llm adapter', { code: 'LLM_ADAPTER_UNKNOWN', status: 404 });
    }
    return entry;
  }

  metadata() {
    return Object.freeze({
      llmAdapterContract: LLM_ADAPTER_CONTRACT,
      adapters: [...this.adapters.values()].map((entry) => Object.freeze({
        name: entry.definition.name,
        version: entry.definition.version,
        label: entry.definition.label,
        fingerprint: entry.fingerprint,
      })),
    });
  }

  /** @param {any} database */
  persistFingerprints(database) {
    const entries = [...this.adapters.values()];
    if (entries.length === 0) return;
    createDefinitionVersionStore(database).persist(entries.map((entry) => ({
      type: 'llm-adapter',
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: entry.fingerprint,
    })));
  }
}
