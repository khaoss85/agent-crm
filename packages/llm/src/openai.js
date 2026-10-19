// @ts-check

import { AppError } from '../../core/index.js';
import { assertCompletion, assertGenerateInput } from './adapter.js';

/**
 * The OpenAI LLM adapter (backlog:6e54d6a7988a).
 *
 * The first real provider on the LLM contract (owner decision 19/10 on
 * Q-L1: assistant, Advisor, "write/suggest with AI" and free questions run
 * on OpenAI's cheapest model). It proves the same shared kit as the fake
 * adapter, with a stubbed transport and a fixture secret — no network, no
 * credentials (owner decision MEM_ACC_DECISIONS).
 *
 * Wiring, never storage: the key arrives per call from the package's
 * `resolveSecret` edge and is held only for the request; the prompt is
 * held only for the request. Nothing is logged, nothing is retained, and
 * every provider refusal maps to a typed error whose text carries neither
 * the key nor the prompt.
 */

/** The cheapest OpenAI model, named once: every other file imports this. */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.6-luna';

export const OPENAI_ADAPTER_NAME = 'openai';
export const OPENAI_ADAPTER_VERSION = 1;

/** Plain HTTPS against the provider: one request, one bounded completion. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_TIMEOUT_MS = 30000;

function fail(code, status, message) {
  throw new AppError(message, { code, status });
}

/** Rough token fallback when the provider reports no usage: ~4 chars each. */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

/**
 * @param {{
 *   model?: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: (url: string, init: any) => Promise<any>,
 * }} [options]
 */
export function createOpenAiLlmAdapter(options = {}) {
  const model = options.model ?? OPENAI_DEFAULT_MODEL;
  if (typeof model !== 'string' || model.trim() === '' || model.length > 128) {
    throw new Error('createOpenAiLlmAdapter needs a bounded non-blank model name');
  }
  const baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (typeof baseUrl !== 'string' || baseUrl === '' || baseUrl.length > 256) {
    throw new Error('createOpenAiLlmAdapter needs a bounded baseUrl');
  }
  const defaultTimeoutMs = options.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs < 1000 || defaultTimeoutMs > 300000) {
    throw new Error('createOpenAiLlmAdapter timeoutMs must be 1000-300000 ms');
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    definition: {
      name: OPENAI_ADAPTER_NAME,
      version: OPENAI_ADAPTER_VERSION,
      label: 'OpenAI',
      config: { model, baseUrl },

      /**
       * @param {{secret?: unknown, messages: any, model?: string, maxTokens: number, timeoutMs?: number}} request
       */
      async generate(request) {
        // Fail closed on the caller's model: only an absent model falls
        // back to the composed default. A mistyped model (a number, a
        // blank string) refuses in `assertGenerateInput` instead of
        // silently billing and auditing the wrong model.
        const callModel = request?.model === undefined ? model : request.model;
        const { messages, maxTokens } = assertGenerateInput({ ...request, model: callModel });
        const secret = request?.secret;
        if (typeof secret !== 'string' || secret === '') {
          fail('LLM_AUTH_FAILED', 401, 'the llm adapter needs its provider secret');
        }
        const timeoutMs = request?.timeoutMs ?? defaultTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
          fail('LLM_REQUEST_INVALID', 422, 'llm timeoutMs must be 1000-300000 ms');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({
              model: callModel,
              messages: messages.map((message) => ({ role: message.role, content: message.content })),
              max_tokens: maxTokens,
              stream: false,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error && typeof error === 'object' && /** @type {any} */ (error).name === 'AbortError') {
            fail('LLM_PROVIDER_TRANSIENT', 503, 'the llm provider timed out and the call may be retried');
          }
          // Transport failures carry no provider text: a fixed typed error,
          // never the request, never the key.
          fail('LLM_PROVIDER_TRANSIENT', 503, 'the llm provider was unreachable and the call may be retried');
        } finally {
          clearTimeout(timer);
        }
        const status = Number(response?.status ?? 0);
        if (status === 401 || status === 403) {
          fail('LLM_AUTH_FAILED', 401, 'the provider refused the llm credential');
        }
        if (status === 429) {
          fail('LLM_RATE_LIMITED', 429, 'the provider rate-limited the llm call');
        }
        if (status === 400) {
          fail('LLM_REQUEST_INVALID', 422, 'the provider refused the llm request');
        }
        if (status < 200 || status >= 300) {
          fail('LLM_PROVIDER_TRANSIENT', 503, 'the provider failed transiently and the call may be retried');
        }
        let body;
        try {
          body = await response.json();
        } catch {
          fail('LLM_PROVIDER_FAILED', 502, 'the provider answered unreadably');
        }
        const text = body?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || text === '') {
          fail('LLM_PROVIDER_FAILED', 502, 'the provider answered with no completion text');
        }
        const usage = body?.usage ?? {};
        return assertCompletion({
          text,
          model: callModel,
          inputTokens: Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0
            ? usage.prompt_tokens
            : estimateTokens(messages.map((message) => message.content).join('\n')),
          outputTokens: Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0
            ? usage.completion_tokens
            : estimateTokens(text),
        }, callModel);
      },
    },
  };
}
