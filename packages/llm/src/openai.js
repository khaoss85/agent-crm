// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { assertLlmCompletion, assertLlmMaxTokens, assertLlmMessages, assertLlmModel } from './adapter.js';

/**
 * OpenAI LLM adapter (backlog:6e54d6a7988a).
 *
 * The first real provider adapter behind the LLM contract: it speaks the
 * provider's Responses API (`POST /v1/responses`) through an injected
 * `transport` the deployment wires — the package holds no network
 * primitive, calls no fetch, and stores no key. The tests drive this same
 * code with fake HTTP, so parsing and error mapping are proven without
 * credentials and without the network (the real key arrives later, from
 * the owner — MEM_ACC_DECISIONS).
 *
 * DECISION (to be confirmed): the default model is `gpt-6-luna`. The owner
 * asked for "GPT-5.6 Luna, il modello a minor costo" (Q-L1, 19/10), but the
 * official model docs list no `gpt-5.6-luna`: the Luna line — documented as
 * the fastest and most cost-effective ("Fastest and most cost-effective",
 * https://developers.openai.com/api/docs/models/gpt-6-luna) — ships as
 * `gpt-6-luna`. That id honours the "minor costo" intent; the model stays
 * per-space configurable, so a rename is one config edit. If the owner
 * meant a different id, the fix is the default string plus its test.
 *
 * Error mapping (typed codes, never key material):
 * - 401 → LLM_AUTH_FAILED (a wrong or revoked key: retrying is pointless);
 * - 429 → LLM_RATE_LIMITED (retryable);
 * - 5xx, transport throw, abort → LLM_PROVIDER_UNAVAILABLE (retryable);
 * - 4xx otherwise → LLM_REQUEST_REFUSED;
 * - 2xx without usable text → LLM_RESPONSE_MALFORMED.
 */

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** Default model: the cheapest documented Luna id (see DECISION above). */
export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna';

function llmError(code, status, message, retryable = false) {
  const error = new AppError(message, { code, status });
  error.retryable = retryable;
  return error;
}

function scrubKey(text, key) {
  if (typeof text !== 'string' || typeof key !== 'string' || key === '') return text;
  return text.split(key).join('[REDACTED]');
}

/**
 * @param {{
 *   transport?: (request: { url: string, method: string, headers: Record<string, string>, bodyText: string, signal?: any }) => Promise<{ status: number, bodyText: string }>,
 *   defaultModel?: string,
 * }} [options]
 * `transport` is the deployment's HTTPS edge. Absent, the adapter refuses
 * every call with LLM_TRANSPORT_UNAVAILABLE instead of dialling out.
 */
export function createOpenAIAdapter(options = {}) {
  const { transport } = options;
  if (transport !== undefined && typeof transport !== 'function') {
    throw new ValidationError('openai adapter transport must be a function', { field: 'transport' });
  }
  const defaultModel = options.defaultModel === undefined ? OPENAI_DEFAULT_MODEL : assertLlmModel(options.defaultModel);

  const adapter = {
    name: 'openai',
    version: 1,
    label: 'OpenAI (Responses API)',
    model: defaultModel,
    config: { kind: 'openai-responses', endpoint: OPENAI_RESPONSES_URL },
    async complete(request = {}) {
      const messages = assertLlmMessages(request.messages);
      const maxTokens = assertLlmMaxTokens(request.maxTokens);
      const model = request.model === undefined ? defaultModel : assertLlmModel(request.model);
      const key = request.key;
      if (typeof key !== 'string' || key === '') {
        throw llmError('LLM_KEY_MISSING', 500, 'openai completion needs a provider key for this call');
      }
      if (typeof transport !== 'function') {
        throw llmError('LLM_TRANSPORT_UNAVAILABLE', 500, 'openai completion needs a deployment transport: none is wired');
      }
      const body = { model, input: messages.map((entry) => ({ role: entry.role, content: entry.content })) };
      if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
      let response;
      try {
        response = await transport({
          url: OPENAI_RESPONSES_URL,
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          bodyText: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        throw llmError('LLM_PROVIDER_UNAVAILABLE', 503,
          `openai transport failed: ${scrubKey(error?.message ?? String(error), key)}`, true);
      }
      const status = response?.status;
      let payload = null;
      try {
        payload = JSON.parse(response?.bodyText ?? '');
      } catch {
        payload = null;
      }
      if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
        const providerMessage = typeof payload?.error?.message === 'string' ? payload.error.message : `http ${String(status)}`;
        const safe = scrubKey(providerMessage.slice(0, 500), key);
        if (status === 401) throw llmError('LLM_AUTH_FAILED', 401, `openai refused the key: ${safe}`);
        if (status === 429) throw llmError('LLM_RATE_LIMITED', 429, `openai rate limited: ${safe}`, true);
        if (Number.isSafeInteger(status) && status >= 500) {
          throw llmError('LLM_PROVIDER_UNAVAILABLE', 503, `openai unavailable: ${safe}`, true);
        }
        throw llmError('LLM_REQUEST_REFUSED', 422, `openai refused the request: ${safe}`);
      }
      const text = extractOutputText(payload);
      if (typeof text !== 'string' || text.length < 1) {
        throw llmError('LLM_RESPONSE_MALFORMED', 502, 'openai answered without usable text');
      }
      const rawUsage = payload?.usage ?? {};
      const usage = {
        inputTokens: Number.isSafeInteger(rawUsage.input_tokens) && rawUsage.input_tokens >= 0 ? rawUsage.input_tokens : 0,
        outputTokens: Number.isSafeInteger(rawUsage.output_tokens) && rawUsage.output_tokens >= 0 ? rawUsage.output_tokens : 0,
      };
      const result = { text, model, usage };
      if (leaksKey(result, key)) {
        throw llmError('LLM_RESPONSE_MALFORMED', 502, 'openai echoed credential material: refused');
      }
      return assertLlmCompletion(result);
    },
  };
  return adapter;
}

/** Concatenate every output_text part of a Responses API payload. */
function extractOutputText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const output = payload.output;
  if (!Array.isArray(output)) return null;
  const parts = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  if (parts.length === 0) return null;
  return parts.join('');
}

function leaksKey(result, key) {
  if (typeof key !== 'string' || key === '') return false;
  try {
    return JSON.stringify(result).includes(key);
  } catch {
    return false;
  }
}
