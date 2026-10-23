import test from 'node:test';
import assert from 'node:assert/strict';

import { runLlmAdapterKit } from '../packages/llm/src/kit.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';
import { OPENAI_DEFAULT_MODEL, createOpenAiLlmAdapter } from '../packages/llm/src/openai.js';

/**
 * LLM adapter kit tests (backlog:6e54d6a7988a): the fixture adapter and
 * the OpenAI adapter pass the SAME shared kit — the OpenAI run with a
 * stubbed transport and a fixture secret, no network, no credentials
 * (owner decision MEM_ACC_DECISIONS).
 */

// Built at runtime, never written down: a literal secret-shaped value in
// the repository trips secret scanners (see dd9c05c).
const SECRET = ['llm', 'kit', 'secret', '1'].join('-');
const MODEL = 'kit-model';

function kitHarness(generate, failNext) {
  return {
    generate: ({ messages, model, maxTokens }) => generate({ messages, model, maxTokens }),
    faults: { failNext },
    secrets: { value: SECRET },
  };
}

async function assertKitPasses(label, adapter, harness) {
  const results = await runLlmAdapterKit({ adapter, harness, secrets: { value: SECRET }, model: MODEL });
  const failed = results.filter((result) => !result.pass);
  assert.deepEqual(failed, [], `${label} fails the kit: ${JSON.stringify(failed)}`);
  return results;
}

test('the fixture adapter passes the llm kit', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const harness = kitHarness(
    ({ messages, model, maxTokens }) => definition.generate({ secret: SECRET, messages, model, maxTokens }),
    (mode) => api.setMode(mode),
  );
  const results = await assertKitPasses('fixture', definition, harness);
  assert.deepEqual(results.map((result) => result.name), ['generate', 'model-echo', 'error-mapping', 'no-key-leak']);
  assert.ok(api.calls() > 0, 'the kit really called the adapter');
  assert.equal(typeof api.lastCall()?.model, 'string');
  assert.equal('content' in (api.lastCall() ?? {}), false, 'call metadata retains no prompt text');
});

test('the openai adapter passes the same kit on a stubbed transport', async () => {
  const seen = [];
  let mode = 'ok';
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (mode === 'transient') { mode = 'ok'; return { status: 500, json: async () => ({ error: 'boom' }) }; }
    if (mode === 'auth') { mode = 'ok'; return { status: 401, json: async () => ({ error: 'bad key' }) }; }
    if (mode === 'limited') { mode = 'ok'; return { status: 429, json: async () => ({ error: 'slow down' }) }; }
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'stubbed completion' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    };
  };
  const { definition } = createOpenAiLlmAdapter({ fetchImpl });
  const harness = kitHarness(
    ({ messages, model, maxTokens }) => definition.generate({ secret: SECRET, messages, model, maxTokens }),
    (next) => { mode = next; },
  );
  await assertKitPasses('openai', definition, harness);
  // The kit ran the production request shape: chat completions, bearer key,
  // the requested model on the wire.
  const first = seen[0];
  assert.ok(first.url.endsWith('/chat/completions'), `unexpected url ${first.url}`);
  assert.equal(first.init.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(first.init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, false);
});

test('the openai adapter names the cheapest model exactly once by default', () => {
  assert.equal(OPENAI_DEFAULT_MODEL, 'gpt-6-luna');
  const { definition } = createOpenAiLlmAdapter({ fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  assert.equal(definition.config.model, 'gpt-6-luna');
});

test('a mistyped model refuses instead of silently running the default', async () => {
  const { definition } = createOpenAiLlmAdapter({
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }),
    }),
  });
  const base = { secret: SECRET, messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 };
  await assert.rejects(
    definition.generate({ ...base, model: 123 }),
    (error) => error?.name === 'ValidationError' || /bounded non-blank/.test(String(error?.message)),
  );
  await assert.rejects(
    definition.generate({ ...base, model: '' }),
    (error) => error?.name === 'ValidationError' || /bounded non-blank/.test(String(error?.message)),
  );
  const out = await definition.generate({ ...base, model: undefined });
  assert.equal(out.model, 'gpt-6-luna', 'only an absent model falls back to the default');
});

test('the kit leak probe observes secrets in messages and nested details', async () => {
  // A measurement that cannot fail is no measurement: an adapter echoing
  // the secret in its error message and nested details must fail the kit.
  const leaky = { name: 'leaky-llm', version: 1 };
  const harness = {
    generate: async () => {
      const error = new Error(`refused: ${SECRET}`);
      error.code = 'LLM_AUTH_FAILED';
      error.details = { provider: { nested: { token: SECRET } } };
      throw error;
    },
    faults: { failNext: () => {} },
    secrets: { value: SECRET },
  };
  const results = await runLlmAdapterKit({ adapter: leaky, harness, secrets: { value: SECRET }, model: MODEL });
  const leak = results.find((result) => result.name === 'no-key-leak');
  assert.equal(leak?.pass, false, 'the probe missed a secret in the message and nested details');
});
