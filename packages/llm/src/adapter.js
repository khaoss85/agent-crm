// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * The LLM adapter contract (backlog:6e54d6a7988a).
 *
 * One named, versioned definition per model provider (OpenAI, …). Like
 * every declared definition (ADR-015) it is code-first, validated
 * fail-closed at composition, and fingerprinted — a changed adapter source
 * or config is a new version, never a silent edit.
 *
 * An adapter turns one bounded message list into one completion:
 * `complete({ key, messages, model?, maxTokens? })` resolves to
 * `{ text, model, usage: { inputTokens, outputTokens } }`.
 *
 * The provider key travels per call (custody stays deployment-owned: the
 * operations resolve it from the space secret reference for each call, and
 * the owner generates the real key later — MEM_ACC_DECISIONS). An adapter
 * never logs, stores, or echoes the key: an error it throws must not carry
 * key material, and the shared kit in `kit.js` proves that with a probe
 * secret on every adapter, including the OpenAI one (driven with fake
 * HTTP, never the network).
 *
 * The package ships no network primitive: the OpenAI adapter speaks
 * through an injected `transport` the deployment wires (the pilot's HTTPS
 * POST). Without it the adapter refuses with LLM_TRANSPORT_UNAVAILABLE
 * instead of inventing custody or dialling out.
 */

export const LLM_ADAPTER_CONTRACT = 1;

/** Roles an adapter accepts on a message. New roles are new contract work. */
export const LLM_ROLES = Object.freeze(['system', 'developer', 'user', 'assistant']);

export const LLM_MESSAGE_MAX = 100;
export const LLM_CONTENT_MAX = 100000;
export const LLM_TOTAL_CONTENT_MAX = 500000;
export const LLM_MAX_TOKENS_MAX = 128000;

const ADAPTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const ADAPTER_KEYS = Object.freeze(['name', 'version', 'label', 'model', 'config', 'complete']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
 * Validate one completion message list fail-closed. Returns the normalized
 * list (role + content only) so an adapter never sees a caller extra.
 */
export function assertLlmMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > LLM_MESSAGE_MAX) {
    throw new ValidationError(`llm messages must be a list of 1-${LLM_MESSAGE_MAX} entries`, { field: 'messages' });
  }
  let total = 0;
  const normalized = messages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`llm messages[${index}] must be an object`, { field: `messages[${index}]` });
    }
    if (!LLM_ROLES.includes(entry.role)) {
      throw new ValidationError(
        `llm messages[${index}].role must be one of ${LLM_ROLES.join(', ')}`, { field: `messages[${index}].role` },
      );
    }
    if (typeof entry.content !== 'string' || entry.content.length < 1 || entry.content.length > LLM_CONTENT_MAX) {
      throw new ValidationError(
        `llm messages[${index}].content must be 1-${LLM_CONTENT_MAX} chars`, { field: `messages[${index}].content` },
      );
    }
    total += entry.content.length;
    if (total > LLM_TOTAL_CONTENT_MAX) {
      throw new ValidationError(`llm messages exceed ${LLM_TOTAL_CONTENT_MAX} chars in total`, { field: 'messages' });
    }
    return { role: entry.role, content: entry.content };
  });
  return normalized;
}

/** Validate the max-output-tokens bound when the caller sets it. */
export function assertLlmMaxTokens(maxTokens) {
  if (maxTokens === undefined) return undefined;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > LLM_MAX_TOKENS_MAX) {
    throw new ValidationError(`llm maxTokens must be 1-${LLM_MAX_TOKENS_MAX}`, { field: 'maxTokens' });
  }
  return maxTokens;
}

/** Validate the adapter's declared default model id (bounded, no spaces). */
export function assertLlmModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new ValidationError('llm adapter model must be a bounded model id', { field: 'adapter.model' });
  }
  return model;
}

/**
 * Validate one LLM adapter definition fail-closed: the full shape or a
 * refusal — a half-declared adapter would complete while looking checked.
 */
export function validateLlmAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new ValidationError('llm adapter must be an object', { field: 'adapter' });
  }
  if (Object.getOwnPropertyNames(adapter).some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('llm adapter carries a hostile key', { field: 'adapter' });
  }
  for (const key of ADAPTER_KEYS) {
    if (!(key in adapter)) {
      throw new ValidationError(`llm adapter misses "${key}"`, { field: `adapter.${key}` });
    }
  }
  if (typeof adapter.name !== 'string' || !ADAPTER_NAME.test(adapter.name)) {
    throw new ValidationError('llm adapter name must be lowercase hyphenated', { field: 'adapter.name' });
  }
  if (!Number.isSafeInteger(adapter.version) || adapter.version < 1) {
    throw new ValidationError('llm adapter version must be a positive integer', { field: 'adapter.version' });
  }
  if (typeof adapter.label !== 'string' || adapter.label.length < 1 || adapter.label.length > 128) {
    throw new ValidationError('llm adapter label must be 1-128 chars', { field: 'adapter.label' });
  }
  assertLlmModel(adapter.model);
  if (adapter.config !== undefined && !isPlainJsonSafe(adapter.config)) {
    throw new ValidationError('llm adapter config must be plain JSON-safe data', { field: 'adapter.config' });
  }
  if (typeof adapter.complete !== 'function') {
    throw new ValidationError('llm adapter complete must be a function', { field: 'adapter.complete' });
  }
  return adapter;
}

/**
 * Normalize one adapter completion result fail-closed: non-empty text, the
 * model that produced it, and safe-integer token counts.
 */
export function assertLlmCompletion(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('llm completion must be an object', { field: 'completion' });
  }
  if (typeof result.text !== 'string' || result.text.length < 1) {
    throw new ValidationError('llm completion text must be non-empty', { field: 'completion.text' });
  }
  assertLlmModel(result.model);
  const usage = result.usage;
  if (!usage || typeof usage !== 'object') {
    throw new ValidationError('llm completion usage must be an object', { field: 'completion.usage' });
  }
  for (const key of ['inputTokens', 'outputTokens']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) {
      throw new ValidationError(`llm completion usage.${key} must be a safe non-negative integer`, {
        field: `completion.usage.${key}`,
      });
    }
  }
  return { text: result.text, model: result.model, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
}
