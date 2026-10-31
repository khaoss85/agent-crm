import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPackageConforms } from './helpers/package-conformance.js';
import {
  LLM_ADAPTER_CONTRACT,
  LlmRegistries,
  assertCompletion,
  assertGenerateInput,
  validateLlmAdapter,
} from '../packages/llm/src/adapter.js';
import { createLlmPackage } from '../packages/llm/src/index.js';

/**
 * LLM contract tests (backlog:6e54d6a7988a): the adapter contract, the
 * request/completion shapes, the registry, and the package conformance.
 * No provider, no storage — pure contract.
 */

const packageDir = fileURLToPath(new URL('../packages/llm', import.meta.url));

const adapter = (overrides = {}) => ({
  name: 'fixture-llm',
  version: 1,
  label: 'Fixture LLM',
  config: { testOnly: true },
  generate: async () => ({ text: 'hi', model: 'm', inputTokens: 1, outputTokens: 1 }),
  ...overrides,
});

const input = (overrides = {}) => ({
  messages: [{ role: 'user', content: 'hello' }],
  model: 'gpt-6-luna',
  maxTokens: 64,
  ...overrides,
});

test('adapter identity validates fail-closed', () => {
  assert.doesNotThrow(() => validateLlmAdapter(adapter()));
  assert.equal(validateLlmAdapter(adapter()).contract, LLM_ADAPTER_CONTRACT);
  assert.throws(() => validateLlmAdapter(adapter({ name: 'Fixture LLM' })), /adapter name must match/);
  assert.throws(() => validateLlmAdapter(adapter({ name: '__proto__' })), /adapter name must match/);
  assert.throws(() => validateLlmAdapter(adapter({ version: 0 })), /positive integer/);
  assert.throws(() => validateLlmAdapter(adapter({ config: { when: new Date(0) } })), /JSON-safe/);
  assert.throws(() => validateLlmAdapter(adapter({ generate: 'nope' })), /generate must be a function/);
  assert.throws(() => validateLlmAdapter({ ...adapter(), extra: 1 }), /unsupported field/);
});

test('adapter registry is unique per identity and fingerprinted', () => {
  const registry = new LlmRegistries({ llmAdapters: [adapter()] });
  const entry = registry.getAdapter('fixture-llm', 1);
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => registry.getAdapter('fixture-llm', 2), (e) => e.code === 'LLM_ADAPTER_UNKNOWN');
  assert.throws(() => registry.getAdapter('__proto__', 1), (e) => e.code === 'LLM_ADAPTER_UNKNOWN');
  assert.throws(() => new LlmRegistries({ llmAdapters: [adapter(), adapter()] }), /Duplicate llm adapter identity/);
  const two = new LlmRegistries({ llmAdapters: [adapter(), adapter({ version: 2 })] });
  assert.equal(two.getAdapter('fixture-llm', 2).definition.version, 2);
  const drifted = new LlmRegistries({ llmAdapters: [adapter({ config: { testOnly: false } })] });
  assert.notEqual(drifted.getAdapter('fixture-llm', 1).fingerprint, entry.fingerprint);
  const metadata = registry.metadata();
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata, 'metadata JSON round-trips');
  assert.equal(JSON.stringify(metadata).includes('function'), false);
});

test('generate input validates fail-closed', () => {
  assert.doesNotThrow(() => assertGenerateInput(input()));
  assert.throws(() => assertGenerateInput(input({ messages: [] })), /1-64 messages/);
  assert.throws(() => assertGenerateInput(input({ messages: [{ role: 'wizard', content: 'x' }] })), /role must be system, user or assistant/);
  assert.throws(() => assertGenerateInput(input({ messages: [{ role: 'user', content: '' }] })), /bounded non-empty text/);
  assert.throws(() => assertGenerateInput(input({ messages: [{ role: 'user', content: 'x'.repeat(32001) }] })), /bounded non-empty text/);
  assert.throws(() => assertGenerateInput(input({ model: '' })), /bounded non-blank name/);
  assert.throws(() => assertGenerateInput(input({ maxTokens: 0 })), /between 1 and 32000/);
  assert.throws(() => assertGenerateInput(input({ maxTokens: 32001 })), /between 1 and 32000/);
  const frozen = assertGenerateInput(input());
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.messages));
});

test('completions name their model and bound their counts', () => {
  const completion = { text: 'answer', model: 'gpt-6-luna', inputTokens: 10, outputTokens: 4 };
  assert.doesNotThrow(() => assertCompletion(completion, 'gpt-6-luna'));
  assert.throws(() => assertCompletion({ ...completion, model: 'other' }, 'gpt-6-luna'), /names the model/);
  assert.throws(() => assertCompletion({ ...completion, text: '' }, 'gpt-6-luna'), /bounded non-empty text/);
  assert.throws(() => assertCompletion({ ...completion, inputTokens: -1 }, 'gpt-6-luna'), /non-negative integer/);
});

test('completion text stays within the request token ceiling', () => {
  const completion = (text) => ({ text, model: 'gpt-6-luna', inputTokens: 10, outputTokens: 4 });
  // 100000 chars at ~3.1 chars/token: valid inside a 32000-token ceiling,
  // refused under the nameless absolute bound — a long paid response is
  // never rejected for length when it fits its own ceiling.
  assert.doesNotThrow(() => assertCompletion(completion('x'.repeat(100000)), 'gpt-6-luna', { maxTokens: 32000 }));
  assert.throws(() => assertCompletion(completion('x'.repeat(100000)), 'gpt-6-luna'), /at most 32000 characters/);
  // 513 chars cannot come from 64 tokens: fail-closed against absurd output.
  assert.doesNotThrow(() => assertCompletion(completion('x'.repeat(512)), 'gpt-6-luna', { maxTokens: 64 }));
  assert.throws(() => assertCompletion(completion('x'.repeat(513)), 'gpt-6-luna', { maxTokens: 64 }),
    /at most 512 characters/);
  assert.throws(() => assertCompletion(completion('ok'), 'gpt-6-luna', { maxTokens: 0 }), /maxTokens/);
  assert.throws(() => assertCompletion(completion('ok'), 'gpt-6-luna', { maxTokens: 32001 }), /maxTokens/);
});

test('the model name is written in exactly one place', () => {
  // The item forbids the model name in several places: every file imports
  // the single constant instead of repeating it.
  const hits = [];
  for (const file of readdirSync(join(packageDir, 'src'))) {
    const source = readFileSync(join(packageDir, 'src', file), 'utf8');
    const count = (source.match(/gpt-6-luna/g) ?? []).length;
    if (count > 0) hits.push(`${file}:${count}`);
  }
  assert.deepEqual(hits, ['openai.js:1'], `model name repeats: ${hits.join(', ')}`);
});

test('the composed package exposes registries and fingerprint persistence', () => {
  // ADR-015 drift detection only runs when the package exposes the same
  // surface as channels: `registries` and `persistFingerprints`.
  const definition = createLlmPackage({});
  assert.equal(typeof definition.persistFingerprints, 'function');
  assert.ok(definition.registries instanceof LlmRegistries);
  assert.deepEqual(
    definition.registries.metadata().adapters.map((entry) => entry.name).sort(),
    [],
    'no adapters composed, none fingerprinted',
  );
  const withAdapter = createLlmPackage({ adapters: [adapter()] });
  assert.deepEqual(
    withAdapter.registries.metadata().adapters.map((entry) => entry.name),
    ['fixture-llm'],
  );
});

test('the llm package conforms and imports no sibling package', () => {
  const definition = createLlmPackage({});
  assertPackageConforms({
    definition,
    dir: packageDir,
    expected: {
      name: 'llm',
      version: 1,
      resources: ['llm-usage-day', 'llm-call-audit'],
      provides: ['llm-complete@1'],
      requires: [],
    },
    forbiddenImports: [/\.\.\/\.\.\/(?!core\/)/],
  });
});
