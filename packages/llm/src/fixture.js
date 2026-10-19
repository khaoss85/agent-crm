// @ts-check

import { AppError } from '../../core/index.js';
import { assertCompletion, assertGenerateInput } from './adapter.js';

/**
 * Fixture LLM adapter (backlog:6e54d6a7988a).
 *
 * The adapter the kit proves today, and the shape every real adapter takes
 * tomorrow: one bounded completion per call, provider-reported usage when
 * the provider reports it, typed errors that never carry key material.
 * Real credentials do not exist yet (owner decision MEM_ACC_DECISIONS) —
 * the secret here is a declared test-only fixture value, resolved through
 * the same `resolveSecret` edge production uses.
 *
 * Failure modes are programmable per test: `ok`, `transient` (the next
 * call fails retryable), `auth` (the next call fails as a bad key),
 * `limited` (the next call fails as rate-limited). `calls()` counts
 * executions and `lastCall()` exposes only metadata — model, message
 * count, token ceiling — never the prompt text, so a test asserting no
 * retention has something to hold.
 */

export const FIXTURE_LLM_ADAPTER_NAME = 'fixture-llm';
export const FIXTURE_LLM_ADAPTER_VERSION = 1;

const TRANSIENT = 'LLM_PROVIDER_TRANSIENT';
const AUTH_FAILED = 'LLM_AUTH_FAILED';
const RATE_LIMITED = 'LLM_RATE_LIMITED';

/**
 * @param {{name?: string, secret?: string, answers?: Array<{match?: string, text: string, inputTokens?: number, outputTokens?: number}>}} [options]
 */
export function createFixtureLlmAdapter(options = {}) {
  const name = options.name ?? FIXTURE_LLM_ADAPTER_NAME;
  const expectedSecret = options.secret ?? 'fixture-llm-secret';
  const state = {
    mode: 'ok',
    /** @type {Array<{model: string, messageCount: number, maxTokens: number}>} */
    calls: [],
    answers: (Array.isArray(options.answers) ? options.answers : []).map((entry) => ({ ...entry })),
  };

  const api = {
    state,
    /** @param {'ok'|'transient'|'auth'|'limited'} mode */
    setMode(mode) {
      state.mode = mode;
    },
    reset() {
      state.mode = 'ok';
      state.calls.length = 0;
      state.answers.length = 0;
    },
    /**
     * Queue one canned answer: used when any prompt contains `match`
     * (or for every prompt when `match` is omitted).
     * @param {string} text @param {{match?: string, inputTokens?: number, outputTokens?: number}} [options]
     */
    answer(text, answerOptions = {}) {
      state.answers.push({ text, ...answerOptions });
    },
    calls() {
      return state.calls.length;
    },
    lastCall() {
      return state.calls.length === 0 ? null : { ...state.calls[state.calls.length - 1] };
    },
  };

  return {
    definition: {
      name,
      version: FIXTURE_LLM_ADAPTER_VERSION,
      label: 'Fixture LLM',
      config: { testOnly: true },

      /**
       * @param {{secret?: unknown, messages: any, model: string, maxTokens: number, timeoutMs?: number}} request
       */
      async generate(request) {
        const { messages, model, maxTokens } = assertGenerateInput(request);
        if (typeof request?.secret !== 'string' || request.secret === '') {
          throw new AppError('the llm adapter needs its provider secret', {
            code: AUTH_FAILED, status: 401,
          });
        }
        if (request.secret !== expectedSecret) {
          // A wrong key fails like a bad provider key: typed, no value echoed.
          throw new AppError('the provider refused the llm credential', {
            code: AUTH_FAILED, status: 401,
          });
        }
        if (state.mode === 'transient') {
          state.mode = 'ok';
          throw new AppError('the provider failed transiently', { code: TRANSIENT, status: 503 });
        }
        if (state.mode === 'auth') {
          state.mode = 'ok';
          throw new AppError('the provider refused the llm credential', { code: AUTH_FAILED, status: 401 });
        }
        if (state.mode === 'limited') {
          state.mode = 'ok';
          throw new AppError('the provider rate-limited the llm call', { code: RATE_LIMITED, status: 429 });
        }
        state.calls.push({ model, messageCount: messages.length, maxTokens });
        const joined = messages.map((message) => message.content).join('\n');
        const canned = state.answers.find((entry) => entry.match === undefined || joined.includes(entry.match))
          ?? { text: 'fixture answer', inputTokens: 12, outputTokens: 3 };
        return assertCompletion({
          text: canned.text,
          model,
          inputTokens: canned.inputTokens ?? 12,
          outputTokens: canned.outputTokens ?? 3,
        }, model);
      },
    },
    api,
  };
}
