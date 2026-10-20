import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { claimSpend, createLlmOperations, estimateCostCents, withDaySpend } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';
import { OPENAI_DEFAULT_MODEL, createOpenAiLlmAdapter } from '../packages/llm/src/openai.js';

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

/**
 * Minimal managed-record double: unique key, create/read/patch, plus the
 * storage seam the spend claim needs — a manifest (field names to columns,
 * identity-mapped here), a `database.storage.execute` that interprets the
 * conditional-update subset of the storage vocabulary with an
 * `affectedRows` verdict, a managed `get`, and audit/events collectors.
 * Single-threaded like the real single statement: `execute` runs to
 * completion with no awaits inside, so a stale claim deterministically
 * reports zero affected rows and the retry path is exercised for real.
 * `mutationAsync` emulates the savepoint the real service offers: the
 * callback runs on a transaction handle, and a throw restores the rows
 * and the audit collector, so the rollback path is exercised for real.
 */
const USAGE_MANIFEST = {
  name: 'llm-usage-day',
  table: 'llm_usage_days',
  fields: ['dayKey', 'spaceId', 'day', 'inputTokens', 'outputTokens', 'estimatedCostCents', 'calls']
    .map((name) => ({ name, column: name })),
};

// The audit double carries the shipped manifest shape (field names and
// types) with identity-mapped columns, so the spend receipt insert the
// claim unit runs proves the same validation and mapping as production.
const AUDIT_MANIFEST = {
  name: 'llm-call-audit',
  table: 'llm_call_audits',
  fields: [
    { name: 'callKey', column: 'callKey', type: 'string' },
    { name: 'at', column: 'at', type: 'timestamp' },
    { name: 'spaceId', column: 'spaceId', type: 'string' },
    { name: 'purpose', column: 'purpose', type: 'string' },
    { name: 'adapter', column: 'adapter', type: 'string' },
    { name: 'model', column: 'model', type: 'string' },
    { name: 'inputTokens', column: 'inputTokens', type: 'integer' },
    { name: 'outputTokens', column: 'outputTokens', type: 'integer' },
    { name: 'estimatedCostCents', column: 'estimatedCostCents', type: 'integer' },
    { name: 'dryRun', column: 'dryRun', type: 'boolean' },
    { name: 'refused', column: 'refused', type: 'string' },
    { name: 'errorCode', column: 'errorCode', type: 'string' },
    { name: 'sourceCount', column: 'sourceCount', type: 'integer' },
    { name: 'sources', column: 'sources', type: 'string' },
  ],
};

function stubService(uniqueKey, manifest = null) {
  const rows = [];
  let seq = 0;
  const auditRecords = [];
  const emitted = [];
  const matchWhere = (row, where) => (where ?? []).every((predicate) => {
    if (predicate.op !== 'eq') throw new Error(`stub storage supports only eq (got ${predicate.op})`);
    return row[predicate.column] === predicate.value;
  });
  // Rows the claim unit inserts carry physical coercion (booleans as 1/0,
  // like `toDbValue` persists in production): map them back on read, the
  // way `mapRow` does for real storage.
  const mapStored = (row) => {
    const mapped = { ...row };
    for (const field of manifest?.fields ?? []) {
      if (field.type !== 'boolean') continue;
      const key = field.column ?? field.name;
      if (mapped[key] === 1) mapped[key] = true;
      else if (mapped[key] === 0) mapped[key] = false;
    }
    return mapped;
  };
  // Tables another stub owns but this unit writes atomically (the spend
  // claim and its domain receipt share one savepoint in production): the
  // unit handle routes inserts by table, and the rollback below restores
  // every linked table and collector with this stub's own rows.
  const linkedTables = new Map();
  const linkedCollectors = [];
  const storage = {
    execute: async (statement) => {
      if (statement?.kind === 'insert') {
        const target = statement.table === manifest?.table
          ? { rows, uniqueKey }
          : linkedTables.get(statement.table);
        if (!target) throw new Error(`stub storage has no table ${statement?.table}`);
        const stored = {};
        for (const { column, value } of statement.values ?? []) stored[column] = value;
        if (target.uniqueKey !== null && target.uniqueKey !== undefined
          && target.rows.some((existing) => existing[target.uniqueKey] === stored[target.uniqueKey])) {
          throw new Error(`UNIQUE constraint failed: ${target.uniqueKey}`);
        }
        target.rows.push(stored);
        return { affectedRows: 1 };
      }
      if (statement?.kind !== 'update') {
        throw new Error(`stub storage supports only update/insert (got ${statement?.kind})`);
      }
      const targets = rows.filter((row) => matchWhere(row, statement.where));
      for (const target of targets) {
        for (const assignment of statement.values ?? []) {
          target[assignment.column] = assignment.value;
        }
      }
      return { affectedRows: targets.length };
    },
  };
  const tx = {
    execute: (statement) => storage.execute(statement),
    maybeOne: async (statement) => {
      if (statement?.kind !== 'select') throw new Error(`stub storage supports only update/select (got ${statement?.kind})`);
      const found = rows.find((row) => matchWhere(row, statement.where));
      return found ? { ...found } : null;
    },
  };
  return {
    rows,
    auditRecords,
    emitted,
    manifest,
    database: manifest ? { storage } : undefined,
    linkTable: (table, target) => { linkedTables.set(table, target); },
    linkCollector: (array) => { linkedCollectors.push(array); },
    mutationAsync: manifest ? async (fn) => {
      const snapshot = rows.map((row) => ({ ...row }));
      const linkedSnapshots = [...linkedTables.values()].map((target) => ({
        target, rows: target.rows.map((row) => ({ ...row })),
      }));
      const audits = auditRecords.length;
      const collectors = linkedCollectors.map((array) => array.length);
      try {
        return await fn(tx);
      } catch (error) {
        rows.length = 0;
        for (const row of snapshot) rows.push(row);
        for (const { target, rows: saved } of linkedSnapshots) {
          target.rows.length = 0;
          for (const row of saved) target.rows.push(row);
        }
        auditRecords.length = audits;
        linkedCollectors.forEach((array, index) => { array.length = collectors[index]; });
        throw error;
      }
    } : undefined,
    audit: manifest ? { record: async (entry) => { auditRecords.push(entry); } } : undefined,
    events: manifest ? { emit: async (name, payload) => { emitted.push({ name, payload }); } } : undefined,
    get: async (id) => {
      const stored = rows.find((row) => row.id === id);
      if (!stored) throw new Error(`missing row ${id}`);
      return mapStored(stored);
    },
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
      .map((row) => mapStored(row)),
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
  const usage = stubService('dayKey', USAGE_MANIFEST);
  const audit = stubService('callKey', AUDIT_MANIFEST);
  // The claim unit writes the domain receipt on its own handle, like the
  // shared savepoint in production: the double routes that table here and
  // rolls it back with the claim.
  usage.linkTable(audit.manifest.table, { rows: audit.rows, uniqueKey: 'callKey' });
  usage.linkCollector(audit.auditRecords);
  usage.linkCollector(audit.emitted);
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

test('dry-run and live results expose identical usage keys', async () => {
  const dry = setup({ noKey: true });
  const dryOut = await call(dry.ops, dry.modules, { tag: 'dry-usage' });
  const live = setup();
  const liveOut = await call(live.ops, live.modules, { tag: 'live-usage' });
  assert.deepEqual(Object.keys(dryOut.usage ?? {}).sort(), Object.keys(liveOut.usage ?? {}).sort());
  assert.deepEqual(dryOut.usage, {
    dayTokens: dryOut.inputTokens + dryOut.outputTokens,
    dayCostCents: dryOut.estimatedCostCents,
  });
  const totals = await dry.ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, dry.modules);
  assert.equal(dryOut.usage.dayTokens, totals[0].inputTokens + totals[0].outputTokens);
  assert.equal(dryOut.usage.dayCostCents, totals[0].estimatedCostCents);
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

test('a long response within maxTokens is accepted, an absurd one refused', async () => {
  const long = createFixtureLlmAdapter({ secret: SECRET });
  long.api.answer('x'.repeat(100000));
  const fixtureSpace = () => ({ presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } });
  const accepted = setup({ adapters: [long.definition], spaces: fixtureSpace() });
  const out = await call(accepted.ops, accepted.modules, { tag: 'long', maxTokens: 32000 });
  assert.equal(out.text.length, 100000, 'a response inside its own token ceiling is kept');
  const totals = await accepted.ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, accepted.modules);
  assert.equal(totals[0].calls, 1, 'the accepted long response claimed its spend');

  const absurd = createFixtureLlmAdapter({ secret: SECRET });
  absurd.api.answer('y'.repeat(60000), { match: 'absurd-marker' });
  const refused = setup({ adapters: [absurd.definition], spaces: fixtureSpace() });
  // 60000 chars cannot come from 64 tokens: refused fail-closed, no spend.
  assert.equal(
    await codeOf(() => call(refused.ops, refused.modules, { tag: 'absurd-marker', maxTokens: 64 })),
    'VALIDATION_ERROR',
  );
  const none = await refused.ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, refused.modules);
  assert.deepEqual(none.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[0, 0, 0]],
    'the refused absurd response claimed no spend');
});

test('a hung custody refuses within the timeout and frees the space chain', async () => {
  const hanging = setup({
    resolveSecret: () => new Promise(() => {}),
    spaces: { presti: { enabled: true, timeoutMs: 1000 } },
  });
  const code = await codeOf(() => call(hanging.ops, hanging.modules, { tag: 'hung' }));
  assert.equal(code, 'LLM_SECRET_UNAVAILABLE', 'a hung vault refuses with the stable code');
  const audit = await hanging.ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, hanging.modules);
  assert.equal(audit[audit.length - 1].refused, 'secret-timeout', 'the audit names the timeout cause');
  assert.equal(audit[audit.length - 1].errorCode, 'LLM_SECRET_UNAVAILABLE');
  // The chain is free: the same space serves the next attempt.
  const working = setup();
  const out = await call(working.ops, working.modules, { tag: 'after-hang' });
  assert.equal(out.text, 'live answer', 'the space chain stayed free after the timeout');
});

test('a secret failure records its cause and never the secret', async () => {
  // Built at runtime, never written down: a vault error echoing secret
  // material must not reach storage, errors or the audit.
  const LEAK = ['llm', 'operations', 'leaked', 'value', '9'].join('-');
  const failing = setup({
    resolveSecret: async () => { throw new Error(`vault exploded on ${LEAK}`); },
  });
  let thrown = null;
  try {
    await call(failing.ops, failing.modules, { tag: 'leak' });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'LLM_SECRET_UNAVAILABLE');
  assert.equal(thrown?.details?.reason, 'secret-error');
  assert.ok(!JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)).includes(LEAK),
    'the error carries the leaked value');
  assert.ok(!failing.dump().includes(LEAK), 'the leaked value reached storage');
  const audit = await failing.ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, failing.modules);
  assert.equal(audit[audit.length - 1].refused, 'secret-error', 'the audit names the throw cause');
  assert.ok(!JSON.stringify(audit).includes(LEAK), 'the leaked value reached the audit');

  const empty = setup({ resolveSecret: async () => '' });
  assert.equal(await codeOf(() => call(empty.ops, empty.modules, { tag: 'empty' })), 'LLM_SECRET_UNAVAILABLE');
  const emptyAudit = await empty.ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, empty.modules);
  assert.equal(emptyAudit[emptyAudit.length - 1].refused, 'secret-empty');

  const { definition, api } = createFixtureLlmAdapter({ secret: SECRET });
  const unwired = setup({
    adapters: [definition],
    omitResolver: true,
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
  });
  assert.equal(await codeOf(() => call(unwired.ops, unwired.modules, { tag: 'unwired-cause' })),
    'LLM_SECRET_UNAVAILABLE');
  assert.equal(api.calls(), 0, 'the adapter ran without custody');
  const unwiredAudit = await unwired.ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, unwired.modules);
  assert.equal(unwiredAudit[unwiredAudit.length - 1].refused, 'secret-unwired');
});

test('a wedged slot refuses retryable and frees the space chain', async () => {
  const code = await codeOf(() => withDaySpend('slot-probe-00647aef', () => new Promise(() => {}), 50));
  assert.equal(code, 'LLM_OPERATION_TIMEOUT', 'a wedged slot refuses with the stable retryable code');
  const next = await withDaySpend('slot-probe-00647aef', async () => 'served', 50);
  assert.equal(next, 'served', 'the chain stayed free after the slot timeout');
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

test('a lost claim retries on the winner totals instead of overwriting', async () => {
  const { ops, modules, usage } = setup();
  const realExecute = usage.database.storage.execute;
  let rigged = true;
  usage.database.storage.execute = async (statement) => {
    if (rigged) {
      rigged = false;
      return { affectedRows: 0 };
    }
    return realExecute(statement);
  };
  const out = await call(ops, modules, { tag: 'retry' });
  assert.equal(out.text, 'live answer');
  assert.equal(out.capExceeded, false);
  const totals = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(totals.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[10, 4, 1]]);
});

test('a spend landing past a filled ceiling is recorded and annotated', async () => {
  const { usage } = setup();
  // Racers filled the ceiling while this call was at the provider: the
  // day row already holds 15 tokens against a cap of 10.
  await usage.createManaged({
    dayKey: 'presti:2026-10-19', spaceId: 'presti', day: '2026-10-19',
    inputTokens: 12, outputTokens: 3, estimatedCostCents: 1, calls: 1,
  }, { actor: ACTOR });
  const caps = { dailyTokenCap: 10, dailyCostCentsCap: null };
  const { row, capExceeded } = await claimSpend(
    usage, 'presti:2026-10-19',
    { inputTokens: 10, outputTokens: 4, estimatedCostCents: 1 },
    ACTOR, caps, () => T0,
  );
  assert.equal(capExceeded, true, 'the over-cap landing is annotated');
  assert.deepEqual([row.inputTokens, row.outputTokens, row.calls], [22, 7, 2],
    'real spend is recorded, never hidden by the refusal');
});

test('an audit failure rolls the spend claim back instead of landing it silently', async () => {
  const { ops, modules, usage } = setup();
  const first = await call(ops, modules, { tag: 'rollback-first' });
  assert.equal(first.dryRun, false);
  const realRecord = usage.audit.record;
  usage.audit.record = () => { throw new Error('audit disk full'); };
  try {
    await assert.rejects(() => call(ops, modules, { tag: 'rollback-second' }), /audit disk full/);
  } finally {
    usage.audit.record = realRecord;
  }
  const totals = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(totals.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[10, 4, 1]],
    'the rolled-back spend left no totals behind');
  assert.equal(usage.auditRecords.length, 1, 'only the first claim kept its receipt');
  const retry = await call(ops, modules, { tag: 'rollback-retry' });
  assert.equal(retry.dryRun, false);
  const after = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(after.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[20, 8, 2]],
    'the retry claims once, never twice');
});

test('a domain receipt failure rolls the spend claim back instead of landing it silently', async () => {
  const { ops, modules, audit } = setup();
  const first = await call(ops, modules, { tag: 'receipt-first' });
  assert.equal(first.dryRun, false);
  // Rig the DOMAIN receipt — the llm-call-audit insert the claim unit
  // writes — not the framework receipt: the spend must still roll back.
  const realRecord = audit.audit.record;
  audit.audit.record = () => { throw new Error('audit disk full'); };
  try {
    await assert.rejects(() => call(ops, modules, { tag: 'receipt-second' }), /audit disk full/);
  } finally {
    audit.audit.record = realRecord;
  }
  const totals = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(totals.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[10, 4, 1]],
    'the rolled-back spend left no totals behind');
  assert.equal(audit.rows.length, 1, 'the rolled-back spend left no domain row behind');
  const reads = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.equal(reads.length, 1, 'only the first attempt kept its receipt');
  const retry = await call(ops, modules, { tag: 'receipt-retry' });
  assert.equal(retry.dryRun, false);
  const after = await ops.readUsage({ actor: ACTOR, spaceId: 'presti' }, modules);
  assert.deepEqual(after.map((row) => [row.inputTokens, row.outputTokens, row.calls]), [[20, 8, 2]],
    'the retry claims once, never twice');
  assert.equal(audit.rows.length, 2, 'the retry wrote its own receipt');
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

const llmPkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'llm');

function loadLlmManifest(name) {
  return JSON.parse(readFileSync(join(llmPkgRoot, 'modules', `${name}.module.json`), 'utf8'));
}

/**
 * One writer on real sqlite: its own connection, the real module services
 * built from the shipped manifests. Two writers share one file database
 * the way two processes share production storage.
 */
function realLlmWriter(dbFile) {
  const database = createDatabase({ path: dbFile });
  for (const { sql } of recordModuleMigrations(['llm-usage-day', 'llm-call-audit']
    .map((name) => ({ name, manifest: loadLlmManifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of ['llm-usage-day', 'llm-call-audit']) {
    const built = createRecordModuleFromManifest(loadLlmManifest(name), {
      database, audit, events, references: {},
    });
    modules.set(name, { service: built.service });
  }
  return { database, modules, close: () => database.close() };
}

test('two writers on real storage keep every spend: claims are conditional', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-llm-race-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* test litter */ } });
  const first = realLlmWriter(join(dir, 'llm-race.sqlite'));
  const second = realLlmWriter(join(dir, 'llm-race.sqlite'));
  t.after(() => { first.close(); second.close(); });

  const dayKey = 'presti:2026-10-19';
  await first.modules.get('llm-usage-day').service.createManaged({
    dayKey, spaceId: 'presti', day: '2026-10-19',
    inputTokens: 0, outputTokens: 0, estimatedCostCents: 0, calls: 0,
  }, { actor: ACTOR });
  const caps = { dailyTokenCap: 1000000, dailyCostCentsCap: null };
  const delta = { inputTokens: 10, outputTokens: 4, estimatedCostCents: 1 };
  const perWriter = 10;
  await Promise.all([
    ...Array.from({ length: perWriter }, () => claimSpend(
      first.modules.get('llm-usage-day').service, dayKey, delta, ACTOR, caps,
    )),
    ...Array.from({ length: perWriter }, () => claimSpend(
      second.modules.get('llm-usage-day').service, dayKey, delta, ACTOR, caps,
    )),
  ]);
  const rows = await first.modules.get('llm-usage-day').service.listWhere({ dayKey });
  assert.equal(rows.length, 1, 'exactly one day row exists');
  assert.deepEqual(
    [rows[0].inputTokens, rows[0].outputTokens, rows[0].estimatedCostCents, rows[0].calls],
    [perWriter * 2 * delta.inputTokens, perWriter * 2 * delta.outputTokens,
      perWriter * 2 * delta.estimatedCostCents, perWriter * 2],
    'every concurrent spend landed exactly once',
  );
});

test('a failing audit rolls the spend back on real storage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-llm-rollback-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* test litter */ } });
  const writer = realLlmWriter(join(dir, 'llm-rollback.sqlite'));
  t.after(() => { writer.close(); });
  const service = writer.modules.get('llm-usage-day').service;
  const dayKey = 'presti:2026-10-19';
  await service.createManaged({
    dayKey, spaceId: 'presti', day: '2026-10-19',
    inputTokens: 0, outputTokens: 0, estimatedCostCents: 0, calls: 0,
  }, { actor: ACTOR });
  const caps = { dailyTokenCap: 1000000, dailyCostCentsCap: null };
  const delta = { inputTokens: 10, outputTokens: 4, estimatedCostCents: 1 };
  const realAudit = service.audit;
  service.audit = { record: () => { throw new Error('audit disk full'); } };
  try {
    await assert.rejects(() => claimSpend(service, dayKey, delta, ACTOR, caps, () => T0), /audit disk full/);
  } finally {
    service.audit = realAudit;
  }
  const rows = await service.listWhere({ dayKey });
  assert.deepEqual([rows[0].inputTokens, rows[0].outputTokens, rows[0].calls], [0, 0, 0],
    'the savepoint undid the claim with its missing receipt');
  const kept = await claimSpend(service, dayKey, delta, ACTOR, caps, () => T0);
  assert.deepEqual([kept.row.inputTokens, kept.row.outputTokens, kept.row.calls], [10, 4, 1]);
});

test('a failing domain receipt rolls the spend back on real storage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-llm-receipt-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* test litter */ } });
  const writer = realLlmWriter(join(dir, 'llm-receipt.sqlite'));
  t.after(() => { writer.close(); });
  const usageService = writer.modules.get('llm-usage-day').service;
  const auditService = writer.modules.get('llm-call-audit').service;
  const dayKey = 'presti:2026-10-19';
  await usageService.createManaged({
    dayKey, spaceId: 'presti', day: '2026-10-19',
    inputTokens: 0, outputTokens: 0, estimatedCostCents: 0, calls: 0,
  }, { actor: ACTOR });
  const caps = { dailyTokenCap: 1000000, dailyCostCentsCap: null };
  const delta = { inputTokens: 10, outputTokens: 4, estimatedCostCents: 1 };
  const patch = {
    callKey: 'call:presti:receipt-1',
    at: new Date(T0).toISOString(),
    spaceId: 'presti', purpose: 'free-question',
    adapter: 'openai', model: OPENAI_DEFAULT_MODEL,
    inputTokens: 10, outputTokens: 4, estimatedCostCents: 1,
    dryRun: false, refused: null, errorCode: null,
    sourceCount: 0, sources: null,
  };
  // Both modules mirror one audit log: fail only the domain receipt, after
  // the claim landed, and the shared savepoint must undo both.
  assert.equal(usageService.audit, auditService.audit, 'both modules mirror one audit log');
  const sharedAudit = usageService.audit;
  const realRecord = sharedAudit.record.bind(sharedAudit);
  sharedAudit.record = (event, handle) => {
    if (event?.entityType === 'llm-call-audit') throw new Error('audit disk full');
    return realRecord(event, handle);
  };
  try {
    await assert.rejects(
      () => claimSpend(usageService, dayKey, delta, ACTOR, caps, () => T0, { service: auditService, patch }),
      /audit disk full/,
    );
  } finally {
    sharedAudit.record = realRecord;
  }
  const rows = await usageService.listWhere({ dayKey });
  assert.deepEqual([rows[0].inputTokens, rows[0].outputTokens, rows[0].calls], [0, 0, 0],
    'the savepoint undid the claim with its missing receipt');
  const audits = await auditService.listWhere({ spaceId: 'presti' });
  assert.equal(audits.length, 0, 'no domain row survived the rollback');
  const keptAfter = await claimSpend(usageService, dayKey, delta, ACTOR, caps, () => T0,
    { service: auditService, patch: { ...patch, callKey: 'call:presti:receipt-2' } });
  assert.deepEqual(
    [keptAfter.row.inputTokens, keptAfter.row.outputTokens, keptAfter.row.calls], [10, 4, 1]);
  const keptAudits = await auditService.listWhere({ spaceId: 'presti' });
  assert.equal(keptAudits.length, 1, 'the retry wrote its own receipt');
});

test('real storage round-trips the exact audit sentinels', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-llm-sentinels-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* test litter */ } });
  const writer = realLlmWriter(join(dir, 'llm-sentinels.sqlite'));
  t.after(() => { writer.close(); });
  const { definition } = createFixtureLlmAdapter({ secret: SECRET });
  const request = (tag) => ({
    actor: ACTOR, spaceId: 'presti', purpose: 'free-question',
    messages: [{ role: 'user', content: PROMPT(tag) }], maxTokens: 64,
  });
  const ops = createLlmOperations({
    adapters: [definition],
    spaces: { presti: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
    secretRef: SECRET_REF,
    resolveSecret: async () => SECRET,
    clock: () => T0,
  });
  const out = await ops.complete(request('real-live'), writer.modules);
  assert.equal(out.dryRun, false);
  const denied = createLlmOperations({
    adapters: [definition],
    spaces: { presti: { enabled: false } },
    clock: () => T0,
  });
  await assert.rejects(() => denied.complete(request('real-denied'), writer.modules),
    (error) => error?.code === 'LLM_SPACE_DISABLED');
  const rows = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, writer.modules);
  assert.equal(rows.length, 2);
  const live = rows.find((row) => row.refused === '');
  assert.equal(live.errorCode, '');
  assert.equal(live.adapter, 'fixture-llm');
  assert.equal(live.model, OPENAI_DEFAULT_MODEL);
  assert.equal(live.sources, '');
  const refusal = rows.find((row) => row.refused === 'space-disabled');
  assert.equal(refusal.adapter, '');
  assert.equal(refusal.model, '');
  assert.equal(refusal.errorCode, '');
  assert.equal(refusal.sources, '');
  assert.deepEqual([refusal.inputTokens, refusal.outputTokens], [0, 0]);
});
