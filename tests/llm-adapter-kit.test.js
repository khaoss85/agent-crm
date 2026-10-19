import test from 'node:test';
import assert from 'node:assert/strict';

import { runLlmAdapterKit } from '../packages/llm/src/kit.js';
import { createFakeLlmAdapter } from '../packages/llm/src/fake.js';
import { OPENAI_DEFAULT_MODEL, OPENAI_RESPONSES_URL, createOpenAIAdapter } from '../packages/llm/src/openai.js';

/**
 * The shared adapter kit, run against both adapters (backlog:6e54d6a7988a):
 * the fake proves the kit, and the OpenAI adapter passes the same kit with
 * fake HTTP — never the network, never a real key.
 */

const MESSAGES = [{ role: 'user', content: 'Riassumi lo stato del cliente in una frase.' }];
const PROBE_KEY = 'sk-test-probe-key-never-real-abc123';

function okTransport(text = 'Risposta di prova dal provider finto.') {
  return async () => ({
    status: 200,
    bodyText: JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 12, output_tokens: 5 },
    }),
  });
}

test('the fake adapter passes the shared kit', async () => {
  const adapter = createFakeLlmAdapter();
  const results = await runLlmAdapterKit({
    adapter,
    key: PROBE_KEY,
    messages: MESSAGES,
    causeFailure: async (key) => {
      adapter.transientNext();
      return adapter.complete({ key, messages: MESSAGES });
    },
  });
  assert.deepEqual(results.map((row) => row.name).sort(),
    ['complete', 'contract', 'error-hygiene', 'input-validation', 'usage-bounded']);
  for (const row of results) assert.equal(row.pass, true, `${row.name}: ${row.detail}`);
});

test('the OpenAI adapter passes the same kit with fake HTTP', async () => {
  const seen = [];
  let failNext = null;
  const adapter = createOpenAIAdapter({
    transport: async (request) => {
      seen.push(request);
      if (failNext) {
        const forced = failNext;
        failNext = null;
        return forced;
      }
      return okTransport()(request);
    },
  });
  const results = await runLlmAdapterKit({
    adapter,
    key: PROBE_KEY,
    messages: MESSAGES,
    causeFailure: async (key) => {
      failNext = { status: 401, bodyText: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }) };
      return adapter.complete({ key, messages: MESSAGES });
    },
  });
  for (const row of results) assert.equal(row.pass, true, `${row.name}: ${row.detail}`);
  assert.ok(seen.length > 0, 'expected at least one fake HTTP call');
  for (const call of seen) {
    assert.equal(call.url, OPENAI_RESPONSES_URL);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${PROBE_KEY}`);
    const body = JSON.parse(call.bodyText);
    assert.equal(body.model, OPENAI_DEFAULT_MODEL);
  }
});

test('the OpenAI default is the cheapest documented Luna model', () => {
  assert.equal(OPENAI_DEFAULT_MODEL, 'gpt-6-luna');
});

test('the OpenAI adapter maps provider failures to typed codes without key material', async () => {
  const key = 'sk-test-SECRET-XYZ-999';
  const byStatus = (status, message) => createOpenAIAdapter({
    transport: async () => ({ status, bodyText: JSON.stringify({ error: { message, type: 't' } }) }),
  });
  const unauth = await byStatus(401, 'Incorrect API key provided').complete({ key, messages: MESSAGES }).then(
    () => null, (error) => error);
  assert.equal(unauth?.code, 'LLM_AUTH_FAILED');
  assert.ok(!String(unauth?.message).includes(key), 'auth error leaks the key');

  const limited = await byStatus(429, 'Rate limit reached').complete({ key, messages: MESSAGES }).then(
    () => null, (error) => error);
  assert.equal(limited?.code, 'LLM_RATE_LIMITED');
  assert.equal(limited?.retryable, true);
  assert.ok(!String(limited?.message).includes(key), 'rate-limit error leaks the key');

  const down = createOpenAIAdapter({
    transport: async () => { throw new Error(`socket hang up with ${key}`); },
  });
  const failed = await down.complete({ key, messages: MESSAGES }).then(() => null, (error) => error);
  assert.equal(failed?.code, 'LLM_PROVIDER_UNAVAILABLE');
  assert.ok(!String(failed?.message).includes(key), 'transport error leaks the key');
});

test('the OpenAI adapter refuses without a key or without a transport', async () => {
  const adapter = createOpenAIAdapter({ transport: okTransport() });
  const noKey = await adapter.complete({ messages: MESSAGES }).then(() => null, (error) => error);
  assert.equal(noKey?.code, 'LLM_KEY_MISSING');

  const unwired = createOpenAIAdapter();
  const noTransport = await unwired.complete({ key: PROBE_KEY, messages: MESSAGES }).then(() => null, (error) => error);
  assert.equal(noTransport?.code, 'LLM_TRANSPORT_UNAVAILABLE');
});
