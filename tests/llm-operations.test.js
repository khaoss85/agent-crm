import test from 'node:test';
import assert from 'node:assert/strict';

import { createLlmOperations } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';
import { createOpenAiLlmAdapter } from '../packages/llm/src/openai.js';

/**
 * LLM operations tests (backlog:6e54d6a7988a): the guards the acceptance
 * names — explicit dry-run without a key and no network, daily ceiling
 * refused with its reason, nothing to the provider for a space without
 * AI, one audit row per attempt with usage but never the prompt text,
 * and the key in neither storage nor errors.
 */

const ACTOR = { type: 'user', id: 'llm-operations-kit' };
const SECRET = 'llm-operations-secret-1';
const SECRET_REF = 'secret://presti/openai';
const T0 = Date.parse('2026-10-19T10:00:00.000Z');

/** Minimal managed-record double: unique key, create/read/patch. */
function stubService(uniqueKey) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    createManaged: async (row) => {
      if (rows.some((existing) => existing[uniqueKey] === row[uniqueKey])) {
        const error = new Error(`UNIQUE constraint failed: ${uniqueKey}`);
        throw error;
      }
      seq += 1;
      const stored = { ...row, id: `row-${seq}` };
      rows.push(stored);
      return { ...stored };
    },
    applyManaged: async (id, patch) => {
      const stored = rows.find((row) => row.id === id);
      if (!stored) throw new Error(`missing row ${id}`);
      Object.assign(stored, patch);
      return { ...stored };
    },
    listWhere: async (filter) => rows
      .filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value))
      .map((row) => ({ ...row })),
  };
}

function stubFetchOk(seen) {
  return async (url, init) => {
    seen.push({ url, init });
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'live answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    };
  };
}

function setup(options = {}) {
  const usage = stubService('dayKey');
  const audit = stubService('callKey');
  const modules = new Map([
    ['llm-usage-day', { service: usage }],
    ['llm-call-audit', { service: audit }],
  ]);
  const seen = [];
  const fetchImpl = options.fetchImpl ?? stubFetchOk(seen);
  const openai = createOpenAiLlmAdapter({ fetchImpl });
  const ops = createLlmOperations({
    adapters: options.adapters ?? [openai.definition],
    resolveSecret: options.resolveSecret ?? (async () => SECRET),
    secretRef: SECRET_REF,
    spaces: options.spaces ?? { presti: { enabled: true } },
    clock: () => T0,
  });
  const dump = () => JSON.stringify([...usage.rows, ...audit.rows]);
  return { ops, modules, usage, audit, seen, dump, openai };
}

const PROMPT = (tag) => `PROMPT-UNIQUE-${tag}-do-not-store-or-log`;

function call(ops, modules, overrides = {}) {
  return ops.complete({
    actor: ACTOR,
    spaceId: 'presti',
    purpose: 'free-question',
    messages: [{ role: 'user', content: PROMPT(overrides.tag ?? 'base') }],
    maxTokens: 64,
    ...overrides,
  }, modules);
}

const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error && typeof error === 'object' ? error.code : null;
  }
  return null;
};

test('a live call audits usage without prompt text or key', async () => {
  const { ops, modules, dump } = setup();
  const out = await call(ops, modules, { tag: 'live' });
  assert.equal(out.text, 'live answer');
  assert.equal(out.adapter, 'openai');
  assert.equal(out.dryRun, false);
  assert.deepEqual([out.inputTokens, out.outputTokens], [10, 4]);
  const usage = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(usage.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[10, 4, 1]]);
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].refused, '');
  assert.equal(audit[0].errorCode, '');
  assert.equal(audit[0].dryRun, false);
  assert.ok(!dump().includes(PROMPT('live')), 'the prompt text reached storage');
  assert.ok(!dump().includes(SECRET), 'the key reached storage');
});

test('a disabled space sends nothing to the provider', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules, dump } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: false, adapter: 'fixture-llm', adapterVersion: 1 } },
  });
  const code = await codeOf(() => call(ops, modules, { tag: 'disabled' }));
  assert.equal(code, 'LLM_SPACE_DISABLED');
  assert.equal(api.calls(), 0, 'the adapter ran for a disabled space');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].refused, 'space-disabled');
  assert.deepEqual([audit[0].inputTokens, audit[0].outputTokens], [0, 0]);
  assert.ok(!dump().includes(PROMPT('disabled')), 'the prompt text reached storage');
});

test('past the daily ceiling the call refuses with its reason', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1, dailyTokenCap: 10 } },
  });
  const first = await call(ops, modules, { tag: 'cap-first' });
  assert.equal(first.dryRun, false);
  assert.equal(api.calls(), 1);
  const code = await codeOf(() => call(ops, modules, { tag: 'cap-second' }));
  assert.equal(code, 'LLM_DAILY_CAP_EXCEEDED');
  assert.equal(api.calls(), 1, 'the adapter ran past the ceiling');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit[audit.length - 1].refused, 'daily-cap');
});

test('without a key the call is an explicit dry-run with no network', async () => {
  const { ops, modules, seen, dump } = setup({ resolveSecret: async () => null });
  const out = await call(ops, modules, { tag: 'dry' });
  assert.equal(out.dryRun, true);
  assert.equal(out.dryRunReason, 'missing-key');
  assert.equal(out.adapter, 'fixture-llm-dry-run');
  assert.equal(seen.length, 0, 'a dry-run reached the network');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].dryRun, true);
  assert.ok(!dump().includes(PROMPT('dry')), 'the prompt text reached storage');
});

test('the key reaches neither storage nor errors', async () => {
  const seen = [];
  const { ops, modules, dump } = setup({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 401, json: async () => ({ error: 'invalid key' }) };
    },
  });
  let thrown = null;
  try {
    await call(ops, modules, { tag: 'auth' });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'LLM_AUTH_FAILED');
  assert.ok(!JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)).includes(SECRET), 'the error carries the key');
  assert.ok(!dump().includes(SECRET), 'the key reached storage');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit[0].errorCode, 'LLM_AUTH_FAILED');
  assert.equal(seen.length, 1);
});

test('answers carry their record sources, ids only', async () => {
  const { ops, modules, dump } = setup();
  const out = await call(ops, modules, { tag: 'sources', sources: ['contact:7', 'conversation:9'] });
  assert.deepEqual([...out.sources], ['contact:7', 'conversation:9']);
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit[0].sourceCount, 2);
  assert.equal(audit[0].sources, 'contact:7,conversation:9');
  assert.ok(!dump().includes(PROMPT('sources')), 'the prompt text reached storage');
});

test('requests validate fail-closed before any provider is touched', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
  });
  assert.equal(await codeOf(() => call(ops, modules, { purpose: 'hypnosis' })), 'VALIDATION_ERROR');
  assert.equal(await codeOf(() => call(ops, modules, { spaceId: 'Presti' })), 'VALIDATION_ERROR');
  assert.equal(await codeOf(() => call(ops, modules, { sources: ['not an id!!'] })), 'VALIDATION_ERROR');
  assert.equal(await codeOf(() => call(ops, modules, { maxTokens: 0 })), 'VALIDATION_ERROR');
  assert.equal(await codeOf(() => ops.complete({
    spaceId: 'presti', purpose: 'assistant', messages: [{ role: 'user', content: 'x' }],
  }, modules)), 'VALIDATION_ERROR');
  assert.equal(api.calls(), 0, 'a refused request reached the adapter');
  const unknown = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'no-such-adapter', adapterVersion: 1 } },
  });
  assert.equal(await codeOf(() => call(unknown.ops, unknown.modules, {})), 'LLM_ADAPTER_UNKNOWN');
});
