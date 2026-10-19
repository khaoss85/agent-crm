import test from 'node:test';
import assert from 'node:assert/strict';

import { createLlmOperations, estimateCostCents } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';
import { createOpenAiLlmAdapter } from '../packages/llm/src/openai.js';

/**
 * LLM operations tests (backlog:6e54d6a7988a): the guards the acceptance
 * names — explicit dry-run without a key and no network, daily ceiling
 * refused with its reason, nothing to the provider for a space without
 * AI, one audit row per attempt with usage but never the prompt text,
 * and the key in neither storage nor errors. Plus the review-hardened
 * guards: a failing or unwired custody refuses instead of dry-running,
 * racing calls serialize on the day row, the model surface is closed to
 * the default plus the space allowlist with a price for each, and the
 * audit keeps every cited source id.
 */

const ACTOR = { type: 'user', id: 'llm-operations-kit' };
// Built at runtime, never written down: a literal secret-shaped value in
// the repository trips secret scanners (see dd9c05c).
const SECRET = ['llm', 'operations', 'secret', '1'].join('-');
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
  const packageOptions = {
    adapters: options.adapters ?? [openai.definition],
    spaces: options.spaces ?? { presti: { enabled: true } },
    clock: () => T0,
  };
  if (!options.noKey) {
    packageOptions.secretRef = options.secretRef ?? SECRET_REF;
  }
  if (options.resolveSecret !== undefined) {
    packageOptions.resolveSecret = options.resolveSecret;
  } else if (!options.noKey && !options.omitResolver) {
    packageOptions.resolveSecret = async () => SECRET;
  }
  if (options.pricing !== undefined) packageOptions.pricing = options.pricing;
  if (options.defaultModel !== undefined) packageOptions.defaultModel = options.defaultModel;
  const ops = createLlmOperations(packageOptions);
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
  const { ops, modules, seen, dump } = setup({ noKey: true });
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

test('a key expected but the vault failing refuses with no canned text', async () => {
  const { ops, modules, seen, dump } = setup({ resolveSecret: async () => { throw new Error('vault down'); } });
  const code = await codeOf(() => call(ops, modules, { tag: 'vault' }));
  assert.equal(code, 'LLM_SECRET_UNAVAILABLE');
  assert.equal(seen.length, 0, 'the provider ran without a key');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].errorCode, 'LLM_SECRET_UNAVAILABLE');
  assert.equal(audit[0].dryRun, false);
  assert.ok(!dump().includes(PROMPT('vault')), 'the prompt text reached storage');
});

test('a key expected but custody unwired refuses', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    omitResolver: true,
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
  });
  assert.equal(await codeOf(() => call(ops, modules, { tag: 'unwired' })), 'LLM_SECRET_UNAVAILABLE');
  assert.equal(api.calls(), 0, 'the adapter ran without custody');
});

test('racing calls serialize: the loser of a filled cap refuses', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1, dailyTokenCap: 10 } },
  });
  const results = await Promise.allSettled([
    call(ops, modules, { tag: 'race-a' }),
    call(ops, modules, { tag: 'race-b' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason?.code, 'LLM_DAILY_CAP_EXCEEDED');
  assert.equal(api.calls(), 1, 'the adapter ran past the ceiling');
  const usage = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(usage.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[12, 3, 1]]);
});

test('racing calls keep both spends: no update is lost', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1, dailyTokenCap: 100 } },
  });
  const results = await Promise.allSettled([
    call(ops, modules, { tag: 'race-c' }),
    call(ops, modules, { tag: 'race-d' }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(api.calls(), 2);
  const usage = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(usage.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[24, 6, 2]]);
});

test('an unknown request model refuses before the adapter runs', async () => {
  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const { ops, modules } = setup({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
  });
  assert.equal(await codeOf(() => call(ops, modules, { tag: 'model', model: 'gpt-5-most-expensive' })), 'VALIDATION_ERROR');
  assert.equal(api.calls(), 0, 'the adapter ran for an unlisted model');
});

test('an allowlisted and priced model runs, the rest refuse fail-closed', async () => {
  const priced = {
    'gpt-5.6-luna': { input: 0.02, output: 0.08 },
    'pro-model': { input: 1, output: 2 },
  };
  const space = (overrides) => ({
    enabled: true, adapter: 'fixture-llm', adapterVersion: 1, models: ['pro-model'], model: 'pro-model', ...overrides,
  });
  const first = createFixtureLlmAdapter({ secret: SECRET });
  const allowed = setup({ adapters: [first.definition], pricing: priced, spaces: { presti: space({}) } });
  const out = await call(allowed.ops, allowed.modules, { tag: 'pro' });
  assert.equal(out.model, 'pro-model');
  assert.equal(out.dryRun, false);
  assert.equal(first.api.calls(), 1);

  const second = createFixtureLlmAdapter({ secret: SECRET });
  const unpriced = setup({
    adapters: [second.definition],
    pricing: { 'gpt-5.6-luna': { input: 0.02, output: 0.08 } },
    spaces: { presti: space({}) },
  });
  assert.equal(await codeOf(() => call(unpriced.ops, unpriced.modules, { tag: 'unpriced' })), 'LLM_PRICING_UNAVAILABLE');
  assert.equal(second.api.calls(), 0, 'the provider ran without a price');

  const third = createFixtureLlmAdapter({ secret: SECRET });
  const unlisted = setup({
    adapters: [third.definition],
    pricing: priced,
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1, model: 'pro-model' } },
  });
  assert.equal(await codeOf(() => call(unlisted.ops, unlisted.modules, { tag: 'unlisted' })), 'LLM_MODEL_UNAVAILABLE');
  assert.equal(third.api.calls(), 0, 'the provider ran for an unlisted space model');
});

test('a malformed pricing table refuses at composition', () => {
  assert.throws(() => createLlmOperations({ pricing: { 'gpt-5.6-luna': { input: 'cheap' } } }), /pricing/);
  assert.throws(() => createLlmOperations({ pricing: {} }), /pricing/);
  assert.throws(
    () => estimateCostCents({ inputTokens: 10, outputTokens: 4, model: 'no-such-model' }),
    (error) => error?.code === 'LLM_PRICING_UNAVAILABLE',
  );
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

test('the audit keeps every cited source id, not the first few', async () => {
  const { ops, modules } = setup();
  const ids = Array.from({ length: 20 }, (_, index) => `contact:${index + 1}`);
  const out = await call(ops, modules, { tag: 'many-sources', sources: ids });
  assert.deepEqual([...out.sources], ids);
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(audit[0].sourceCount, 20);
  assert.equal(audit[0].sources, ids.join(','));
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
