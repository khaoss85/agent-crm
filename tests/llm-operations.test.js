import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeLlmAdapter } from '../packages/llm/src/fake.js';
import { createLlmOperations } from '../packages/llm/src/operations.js';

/**
 * The guarded doorway: dry-run, caps, enablement and audit
 * (backlog:6e54d6a7988a).
 *
 * Every acceptance line is a test here: without a key the call is an
 * explicit dry-run with no provider traffic; past the daily cap it is
 * refused with a reason; a space without AI sends nothing anywhere; and
 * the audit carries counts and a prompt hash — never the prompt text, and
 * the provider key never reaches a row, a log line, or a thrown error.
 */

const ACTOR = { type: 'user', id: 'llm-ops-test' };
const SECRET_KEY = 'sk-test-SECRET-XYZ-999';
const PROMPT = 'Quanto deve ancora pagare il cliente Rossi?';

/** In-memory managed-record double with the module-service interface. */
function memoryModules() {
  const rows = [];
  let seq = 0;
  const service = {
    async createManaged(patch) {
      const row = { id: `llm-call-${++seq}`, ...patch };
      rows.push(row);
      return row;
    },
    async listWhere(filter) {
      return rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
    },
    async countWhere(filter) {
      return (await this.listWhere(filter)).length;
    },
  };
  return { modules: { get: (name) => (name === 'llm-call' ? { service } : undefined) }, rows };
}

const SPACES = {
  enabled: { aiEnabled: true, dailyCap: 100, secretRef: 'vault://presti/openai', model: 'gpt-6-luna' },
  nokey: { aiEnabled: true, dailyCap: 100 },
  capped: { aiEnabled: true, dailyCap: 2, secretRef: 'vault://presti/openai' },
  off: { aiEnabled: false, dailyCap: 100, secretRef: 'vault://presti/openai' },
};

function setup({ spaces = SPACES, now = () => '2026-10-19T12:00:00.000Z' } = {}) {
  const adapter = createFakeLlmAdapter();
  const { modules, rows } = memoryModules();
  const ops = createLlmOperations({
    adapter,
    resolveSecret: async () => SECRET_KEY,
    spaces,
    modules,
    now,
  });
  return { adapter, modules, ops, rows };
}

const asCode = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
};

test('without a key the call is an explicit dry-run with no provider traffic', async () => {
  const { adapter, ops, rows } = setup();
  const out = await ops.complete({
    spaceId: 'nokey', actor: ACTOR, purpose: 'assistant', messages: [{ role: 'user', content: PROMPT }],
  });
  assert.equal(outcomeOf(out), 'dry-run');
  assert.equal(out.dryRun, true);
  assert.equal(out.reason, 'LLM_KEY_MISSING');
  assert.equal(adapter.calls(), 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'dry-run');
  const serialized = JSON.stringify(rows[0]);
  assert.ok(!serialized.includes(PROMPT), 'audit row carries prompt text');
  assert.ok(typeof rows[0].promptHash === 'string' && rows[0].promptHash.length === 64, 'audit row needs a prompt hash');
});

test('past the daily cap the call is refused with a reason before any provider traffic', async () => {
  const { adapter, ops, rows } = setup();
  const messages = [{ role: 'user', content: PROMPT }];
  await ops.complete({ spaceId: 'capped', actor: ACTOR, purpose: 'advisor', messages });
  await ops.complete({ spaceId: 'capped', actor: ACTOR, purpose: 'advisor', messages });
  const refused = await asCode(() => ops.complete({ spaceId: 'capped', actor: ACTOR, purpose: 'advisor', messages }));
  assert.equal(refused?.code, 'LLM_DAILY_CAP_EXCEEDED');
  assert.ok(String(refused?.message).includes('2 calls'), `reason names the cap: ${refused?.message}`);
  assert.ok(String(refused?.message).includes('resets at'), `reason names the reset: ${refused?.message}`);
  assert.equal(adapter.calls(), 2);
  assert.equal(rows.filter((row) => row.outcome === 'refused').length, 1);
});

test('a space without AI enabled sends nothing anywhere', async () => {
  const { adapter, ops, rows } = setup();
  const refused = await asCode(() => ops.complete({
    spaceId: 'off', actor: ACTOR, purpose: 'suggest', messages: [{ role: 'user', content: PROMPT }],
  }));
  assert.equal(refused?.code, 'LLM_SPACE_DISABLED');
  assert.equal(adapter.calls(), 0);
  assert.equal(rows.filter((row) => row.outcome === 'refused').length, 1);
});

test('a completed call audits counts and hash, never text or key', async () => {
  const { adapter, ops, rows } = setup();
  const out = await ops.complete({
    spaceId: 'enabled', actor: ACTOR, purpose: 'free-question', messages: [{ role: 'user', content: PROMPT }],
  });
  assert.equal(outcomeOf(out), 'ok');
  assert.ok(typeof out.text === 'string' && out.text.length > 0);
  assert.equal(out.model, 'gpt-6-luna');
  assert.ok(Number.isSafeInteger(out.usage.inputTokens) && Number.isSafeInteger(out.usage.outputTokens));
  assert.equal(adapter.calls(), 1);
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]);
  assert.ok(!serialized.includes(PROMPT), 'audit row carries prompt text');
  assert.ok(!serialized.includes(SECRET_KEY), 'audit row carries the provider key');
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].inputTokens, out.usage.inputTokens);
});

test('a provider failure is audited by code and rethrown without key material', async () => {
  const { adapter, ops, rows } = setup();
  adapter.transientNext();
  const failed = await asCode(() => ops.complete({
    spaceId: 'enabled', actor: ACTOR, purpose: 'write', messages: [{ role: 'user', content: PROMPT }],
  }));
  assert.equal(failed?.code, 'LLM_PROVIDER_UNAVAILABLE');
  assert.ok(!String(failed?.message).includes(SECRET_KEY), 'thrown error leaks the key');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'error');
  assert.equal(rows[0].errorCode, 'LLM_PROVIDER_UNAVAILABLE');
  assert.ok(!JSON.stringify(rows[0]).includes(SECRET_KEY), 'error audit leaks the key');
});

test('a space with a key reference but no wired custody refuses fail-closed', async () => {
  const adapter = createFakeLlmAdapter();
  const { modules, rows } = memoryModules();
  const ops = createLlmOperations({ adapter, spaces: SPACES, modules });
  const refused = await asCode(() => ops.complete({
    spaceId: 'enabled', actor: ACTOR, purpose: 'assistant', messages: [{ role: 'user', content: PROMPT }],
  }));
  assert.equal(refused?.code, 'LLM_SECRET_UNAVAILABLE');
  assert.equal(adapter.calls(), 0);
  assert.equal(rows.length, 1);
});

function outcomeOf(out) {
  return out?.outcome;
}
