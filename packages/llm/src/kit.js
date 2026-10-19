// @ts-check

/**
 * The LLM adapter contract-test kit (backlog:6e54d6a7988a).
 *
 * A published suite an LLM adapter runs against its own implementation:
 * a bounded completion, the requested model echoed back, provider failures
 * mapped to typed errors, and no key material anywhere in results or
 * errors. An adapter that passes it is compatible; one that does not is
 * not shipped. The OpenAI adapter passes this same kit with a stubbed
 * transport and a fixture secret — no network, no credentials (owner
 * decision MEM_ACC_DECISIONS).
 *
 * The kit drives behavior only through the caller-built harness — the same
 * wiring the deployment uses — so it proves the adapter against real
 * plumbing, never against a second implementation of it. Fault injection
 * (`faults.failNext`) is caller-provided because only the adapter's own
 * double knows how to fail on cue.
 *
 * Harness shape:
 * ```
 * {
 *   generate({ messages, model, maxTokens }) -> { text, model, inputTokens, outputTokens },
 *   faults: { failNext('transient' | 'auth' | 'limited') },
 *   secrets: { value: string },
 * }
 * ```
 */

const CHECKS = Object.freeze([
  'generate',
  'model-echo',
  'error-mapping',
  'no-key-leak',
]);

/**
 * @param {{adapter: any, harness: any, secrets: {value: string}, model?: string}} options
 * @returns {Promise<Array<{name: string, pass: boolean, detail: string}>>}
 */
export async function runLlmAdapterKit(options) {
  const adapter = options?.adapter;
  if (!adapter || typeof adapter.name !== 'string') {
    throw new Error('runLlmAdapterKit needs the adapter definition under test');
  }
  const harness = options?.harness;
  if (typeof harness?.generate !== 'function') {
    throw new Error('runLlmAdapterKit harness needs "generate"');
  }
  if (typeof harness?.faults?.failNext !== 'function') {
    throw new Error('runLlmAdapterKit harness.faults needs "failNext"');
  }
  const secretValue = options?.secrets?.value;
  if (typeof secretValue !== 'string' || secretValue === '') {
    throw new Error('runLlmAdapterKit needs secrets {value}');
  }
  const model = options?.model ?? 'kit-model';

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
  const messages = (content) => [{ role: 'user', content }];

  await check('generate', async () => {
    const out = await harness.generate({ messages: messages('kit hello'), model, maxTokens: 64 });
    if (!out || typeof out.text !== 'string' || out.text === '' || out.text.length > 32000) {
      fail(`expected bounded non-empty text, got ${JSON.stringify(out?.text)?.slice(0, 80)}`);
    }
    if (!Number.isSafeInteger(out.inputTokens) || out.inputTokens < 0
      || !Number.isSafeInteger(out.outputTokens) || out.outputTokens < 0) {
      fail(`expected non-negative token counts, got ${out.inputTokens}/${out.outputTokens}`);
    }
    return `${out.text.length} chars, ${out.inputTokens}+${out.outputTokens} tokens`;
  });

  await check('model-echo', async () => {
    const other = `${model}-other`;
    const out = await harness.generate({ messages: messages('which model?'), model: other, maxTokens: 64 });
    if (out.model !== other) fail(`expected model "${other}", got "${out.model}"`);
    return `ran on ${out.model}`;
  });

  await check('error-mapping', async () => {
    const cases = [
      ['transient', 'LLM_PROVIDER_TRANSIENT'],
      ['auth', 'LLM_AUTH_FAILED'],
      ['limited', 'LLM_RATE_LIMITED'],
    ];
    for (const [mode, code] of cases) {
      harness.faults.failNext(mode);
      let seen = null;
      try {
        await harness.generate({ messages: messages(`fail ${mode}`), model, maxTokens: 64 });
      } catch (error) {
        seen = error && typeof error === 'object' ? error.code : null;
      }
      if (seen !== code) fail(`mode ${mode}: expected ${code}, got ${seen}`);
    }
    return 'transient, auth and limited map to typed codes';
  });

  await check('no-key-leak', async () => {
    // Every failure the kit can provoke, stringified whole: the secret
    // value appears nowhere — not in the code, not in the message, not in
    // a nested detail.
    for (const mode of ['transient', 'auth', 'limited']) {
      harness.faults.failNext(mode);
      try {
        await harness.generate({ messages: messages('leak probe'), model, maxTokens: 64 });
        fail(`mode ${mode} should have thrown`);
      } catch (error) {
        const whole = JSON.stringify(error, Object.getOwnPropertyNames(error));
        if (whole.includes(secretValue)) fail(`mode ${mode} leaks the secret value`);
      }
    }
    const ok = await harness.generate({ messages: messages('clean probe'), model, maxTokens: 64 });
    if (JSON.stringify(ok).includes(secretValue)) fail('the completion carries the secret value');
    return 'secret value in neither errors nor completions';
  });

  return Object.freeze(results);
}

export const LLM_KIT_CHECKS = CHECKS;
