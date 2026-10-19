// @ts-check

import { AppError } from '../../core/index.js';
import { assertLlmCompletion, assertLlmMaxTokens, assertLlmMessages } from './adapter.js';

/**
 * Fake LLM adapter (backlog:6e54d6a7988a).
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: the owner
 * generates the real OpenAI key later, and none is invented here): a
 * deterministic in-memory double that speaks the adapter contract the
 * operations depend on, so completions, caps, dry-runs and audits are
 * proven without dialling any provider.
 *
 * Semantics (the subset the operations need, nothing more):
 * - `complete` answers the canned `text` with usage counted from the
 *   normalized input (length-derived counts, never content), so a usage
 *   test moves messages instead of stubbing numbers.
 * - the fake never touches the network: it has no transport, no fetch,
 *   no socket — a network attempt would be a defect, not a fallback.
 * - `transientNext()` fails the next call with LLM_PROVIDER_UNAVAILABLE
 *   (retryable); `refuseNext(code)` fails it with that code. Faults are
 *   explicit because only the test knows when to fail on cue.
 * - calls are counted, never stored with content: `calls()` returns the
 *   count, so a "no data sent" test observes the count staying at zero
 *   while the audit proves the prompt text stayed home.
 */

/** The model id the fake declares: never a real provider model. */
export const FAKE_LLM_MODEL = 'fake-llm-1';

function fakeError(code, status, message, retryable = false) {
  const error = new AppError(message, { code, status });
  error.retryable = retryable;
  return error;
}

/**
 * @param {{
 *   text?: string, faults?: { fail?: Array<{ code: string, status: number, retryable?: boolean }> }
 * }} [options]
 */
export function createFakeLlmAdapter(options = {}) {
  const text = options.text ?? 'Assistente Accordo: risposta di prova dal fake LLM.';
  if (typeof text !== 'string' || text.length < 1) {
    throw new Error('createFakeLlmAdapter needs a non-empty text');
  }
  let calls = 0;
  const queue = Array.isArray(options.faults?.fail) ? [...options.faults.fail] : [];

  const adapter = {
    name: 'fake-llm',
    version: 1,
    label: 'Fake LLM (tests only)',
    model: FAKE_LLM_MODEL,
    config: { kind: 'fake' },
    /** Fail the next call on cue; the kit drives this, never the network. */
    transientNext() {
      queue.push({ code: 'LLM_PROVIDER_UNAVAILABLE', status: 503, retryable: true });
    },
    /** How many completions ran: content-free, so isolation tests read it. */
    calls() {
      return calls;
    },
    async complete(request = {}) {
      const messages = assertLlmMessages(request.messages);
      assertLlmMaxTokens(request.maxTokens);
      const fault = queue.shift();
      if (fault) {
        throw fakeError(fault.code, fault.status, `fake llm refuses on cue: ${fault.code}`, fault.retryable ?? false);
      }
      calls += 1;
      const inputChars = messages.reduce((sum, entry) => sum + entry.content.length, 0);
      const result = {
        text,
        model: typeof request.model === 'string' && request.model !== '' ? request.model : FAKE_LLM_MODEL,
        usage: { inputTokens: Math.max(1, Math.ceil(inputChars / 4)), outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
      };
      return assertLlmCompletion(result);
    },
  };
  return adapter;
}
