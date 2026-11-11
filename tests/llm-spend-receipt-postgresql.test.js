// @ts-check

/**
 * LLM spend and receipt on real PostgreSQL (backlog:dc423e525af2).
 *
 * The SQLite suite (`tests/llm-async-spend.test.js`) proves a receipt
 * failure rolls the spend back on sync storage. This file proves the same
 * contract where `storage.sync` is absent: on the portable async facade
 * the claim runs on `mutationAsync`, so the claim UPDATE, the framework
 * audit row and the domain `llm-call-audit` receipt land in one unit —
 * and a receipt INSERT failure rolls the spend back to zero instead of
 * landing money no row explains.
 *
 * Skips cleanly without a database; CI always runs this suite against
 * postgres:16.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { bootPostgresqlApp } = await import('./helpers/postgresql-application.js');
const llm = await import('../packages/llm/src/index.js');

const ACTOR = { type: 'user', id: 'llm-pg-spend-kit' };
const SECRET = ['llm', 'pg', 'spend', 'secret'].join('-');
const SECRET_REF = 'secret://presti/openai';

function packageManifests(packageName) {
  const dir = join(ROOT, 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

function llmPackage(spaceConfig) {
  const { definition, api } = llm.createFixtureLlmAdapter({ secret: SECRET });
  const space = () => ({
    enabled: true,
    adapter: 'fixture-llm',
    adapterVersion: 1,
    secretRef: SECRET_REF,
    ...spaceConfig,
  });
  return {
    api,
    definition,
    selected: {
      packageContract: 2,
      packages: [
        llm.createLlmPackageV2({
          adapters: [definition],
          resolveSecret: async () => SECRET,
          spaceConfig: space,
        }),
      ],
      actions: [],
      modules: [...packageManifests('llm')],
    },
    ops: llm.createLlmOperations({
      adapters: [definition],
      resolveSecret: async () => SECRET,
      spaceConfig: space,
    }),
  };
}

test('on PostgreSQL the LLM spend rolls back when the receipt fails', { timeout: 120_000 }, async (t) => {
  const { api, selected, ops } = llmPackage();
  const booted = await bootPostgresqlApp(t, { selected });
  if (!booted) return;
  const { app } = booted;
  const auditTable = app.modules.get('llm-call-audit').service.manifest.table;
  // Same injection as the SQLite receipt test: the claim UPDATE lands,
  // then the domain receipt INSERT throws. The spend must roll back
  // with it — on async storage the whole claim is one `mutationAsync`
  // unit, so the poisoned handle only needs the async entry point.
  // The tx handle is frozen, so it is spread into a fresh handle.
  const poison = (tx) => {
    const realExecute = tx.execute.bind(tx);
    return {
      ...tx,
      execute: (statement) => {
        if (statement?.kind === 'insert' && statement?.table === auditTable) {
          throw new Error('injected llm receipt failure');
        }
        return realExecute(statement);
      },
    };
  };
  const receiptFails = {
    get(name) {
      const entry = app.modules.get(name);
      if (name !== 'llm-usage-day') return entry;
      const service = entry.service;
      const wrapped = { ...service };
      if (typeof service.mutationAsync === 'function') {
        wrapped.mutationAsync = (fn) => service.mutationAsync(async (tx) => fn(poison(tx)));
      }
      if (typeof service.mutationSync === 'function') {
        wrapped.mutationSync = (fn) => service.mutationSync((tx) => fn(tx ? poison(tx) : tx));
      }
      return { ...entry, service: Object.freeze(wrapped) };
    },
    list: () => app.modules.list(),
    schema: () => app.modules.schema(),
  };
  let failure = null;
  try {
    await ops.complete({
      actor: ACTOR,
      spaceId: 'presti',
      purpose: 'free-question',
      messages: [{ role: 'user', content: 'ciao' }],
      maxTokens: 64,
    }, receiptFails);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the receipt failure surfaces to the caller');
  assert.equal(api.calls(), 1, 'the provider answered once before the receipt failed');
  const usage = await app.operations.run('read-llm-usage', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(usage.length, 1, 'the day row exists');
  assert.equal(usage[0].calls, 0, 'the spend rolled back with its receipt');
  assert.equal(usage[0].inputTokens + usage[0].outputTokens, 0, 'no tokens landed without receipt');
  const audit = await app.operations.run('read-llm-audit', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(audit.length, 0, 'no half receipt landed');
});
