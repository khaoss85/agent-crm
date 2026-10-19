// @ts-check

import { validateLlmAdapter } from './adapter.js';

/**
 * The LLM adapter contract-test kit (backlog:6e54d6a7988a,
 * INTEGRATION_RUNTIME.md §Provider contract-test kit).
 *
 * A published suite an LLM adapter runs against its own implementation:
 * contract shape, happy-path completion, fail-closed input validation,
 * error hygiene (no key material in thrown errors), and bounded usage.
 * An adapter that passes it is compatible; one that does not is not
 * shipped. The OpenAI adapter passes this same kit with fake HTTP —
 * never the network — so provider parsing is proven without credentials.
 *
 * The kit drives the adapter directly: adapters are pure request/response
 * bindings with no storage of their own, so there is no harness to build —
 * storage, caps and audits live one layer up, in `operations.js`, with
 * their own tests. Fault injection (`causeFailure`) is caller-provided
 * because only the adapter's own double knows how to fail on cue; the
 * fixture adapter's cue is `transientNext()`.
 *
 * ```js
 * const results = await runLlmAdapterKit({
 *   adapter,
 *   key: 'test-key-never-a-real-secret',
 *   causeFailure: async () => { adapter.transientNext(); return adapter.complete({ key, messages }); },
 * });
 * ```
 */

const CHECKS = Object.freeze(['contract', 'complete', 'input-validation', 'error-hygiene', 'usage-bounded']);

/**
 * @param {{
 *   adapter: any,
 *   key: string,
 *   messages?: Array<{ role: string, content: string }>,
 *   causeFailure?: (key: string) => Promise<never>,
 * }} options
 * @returns {Promise<Array<{name: string, pass: boolean, detail: string}>>}
 */
export async function runLlmAdapterKit(options) {
  const adapter = options?.adapter;
  if (!adapter || typeof adapter.complete !== 'function') {
    throw new Error('runLlmAdapterKit needs the adapter definition under test');
  }
  const key = options?.key;
  if (typeof key !== 'string' || key === '') {
    throw new Error('runLlmAdapterKit needs a probe key (never a real secret)');
  }
  const messages = options?.messages ?? [{ role: 'user', content: 'Riassumi lo stato del cliente in una frase.' }];

  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn() ?? 'ok';
      results.push({ name, pass: true, detail: String(detail) });
    } catch (error) {
      results.push({
        name,
        pass: false,
        detail: error && typeof error === 'object' && 'code' in error
          ? `${error.code}: ${error.message}` : String(error?.message ?? error),
      });
    }
  };
  const fail = (message) => { throw new Error(message); };
  const leaked = (error) => {
    const seen = [error?.message, (() => { try { return JSON.stringify(error?.details ?? null); } catch { return null; } })(),
      (() => { try { return JSON.stringify(error); } catch { return null; } })(),
    ].filter((part) => typeof part === 'string');
    return seen.some((part) => part.includes(key));
  };

  await check('contract', async () => {
    validateLlmAdapter(adapter);
    return `${adapter.name}@${adapter.version} model=${adapter.model}`;
  });

  await check('complete', async () => {
    const out = await adapter.complete({ key, messages });
    if (!out || typeof out.text !== 'string' || out.text.length < 1) fail('empty completion text');
    if (typeof out.model !== 'string' || out.model.length < 1) fail('missing completion model');
    const usage = out.usage ?? {};
    for (const field of ['inputTokens', 'outputTokens']) {
      if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) fail(`usage.${field} not a safe non-negative integer`);
    }
    if (leaked(out)) fail('completion echoes the provider key');
    return `${out.model} in=${usage.inputTokens} out=${usage.outputTokens}`;
  });

  await check('input-validation', async () => {
    let code = null;
    try {
      await adapter.complete({ key, messages: [] });
    } catch (error) {
      code = error && typeof error === 'object' ? error.code ?? null : null;
    }
    if (code === null) fail('empty messages completed instead of refusing');
    return `empty-refused:${code}`;
  });

  await check('error-hygiene', async () => {
    if (typeof options?.causeFailure !== 'function') fail('kit needs causeFailure to prove error hygiene');
    let error = null;
    try {
      await options.causeFailure(key);
    } catch (caught) {
      error = caught;
    }
    if (!error) fail('causeFailure did not fail');
    if (!error.code || typeof error.code !== 'string') fail('failure carries no typed code');
    if (leaked(error)) fail('thrown error carries key material');
    return error.code;
  });

  await check('usage-bounded', async () => {
    const out = await adapter.complete({ key, messages });
    if (out.usage.inputTokens > 1e9 || out.usage.outputTokens > 1e9) fail('usage counts implausibly large');
    return `in=${out.usage.inputTokens} out=${out.usage.outputTokens}`;
  });

  const names = results.map((row) => row.name).sort().join(',');
  if (names !== [...CHECKS].sort().join(',')) fail(`kit checks drifted: ${names}`);
  return results;
}
