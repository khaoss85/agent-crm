// @ts-check

/**
 * LLM spend and receipt inside the async composition (backlog:1943c161).
 *
 * The pilot hit this on the shared worker: on `createAccordoAppAsync` the
 * `app.modules` facade hid the record manifest and the database handle, so
 * `spendSeam`/`receiptSeam` refused with `LLM_STORAGE_INVALID` only AFTER
 * the provider had already answered — and the queued request repaid the
 * provider on every retry. The cure keeps the database handle private,
 * exposes what the claim needs on the portable service, runs the claim on
 * the `mutationAsync` transaction, and proves both seams BEFORE the
 * provider is touched.
 *
 * Every test below composes the real async app with a fixture provider and
 * counts its calls: success lands spend and receipt with exactly one
 * provider call, and a storage or price refusal stops before the provider.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
const llm = await import('../packages/llm/src/index.js');
const { suggestQuoteLines } = await import('../packages/commercial/src/quote-suggest.js');
const { extractProductDrafts } = await import('../packages/commercial/src/product-import.js');

const ACTOR = { type: 'user', id: 'llm-async-spend-kit' };
const SECRET = ['llm', 'async', 'spend', 'secret'].join('-');
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

/**
 * One async app with only the llm package, on a fixture provider whose
 * calls the test counts. `spaceConfig` overrides the enabled space.
 */
async function composedLlmApp(t, { spaceConfig, answers = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-llm-async-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { definition, api } = llm.createFixtureLlmAdapter({ secret: SECRET });
  for (const answer of answers) api.answer(answer.text, answer.options ?? {});
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'llm-async.sqlite'),
    selected: {
      packageContract: 2,
      packages: [
        llm.createLlmPackageV2({
          adapters: [definition],
          resolveSecret: async () => SECRET,
          spaceConfig: () => ({
            enabled: true,
            adapter: 'fixture-llm',
            adapterVersion: 1,
            secretRef: SECRET_REF,
            ...spaceConfig,
          }),
        }),
      ],
      actions: [],
      modules: [...packageManifests('llm')],
    },
  });
  t.after(() => app.close());
  // The pilot's path: the llm handle with the public facade (the same
  // binding `openLlmComplete` closes over for the llm-complete capability).
  const ops = llm.createLlmOperations({
    adapters: [definition],
    resolveSecret: async () => SECRET,
    spaceConfig: () => ({
      enabled: true,
      adapter: 'fixture-llm',
      adapterVersion: 1,
      secretRef: SECRET_REF,
      ...spaceConfig,
    }),
  });
  return { app, api, ops };
}

const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error && typeof error === 'object' ? error.code : null;
  }
  return null;
};

function facadeComplete(ops, app, purpose) {
  return ({ messages, maxTokens }) => ops.complete({
    actor: ACTOR, spaceId: 'presti', purpose, messages, maxTokens,
  }, app.modules).then((out) => ({ text: out.text, dryRun: out.dryRun }));
}

test('complete-llm-call lands spend and receipt in the async app with one provider call', async (t) => {
  const { app, api } = await composedLlmApp(t);
  const out = await app.operations.run('complete-llm-call', {
    actor: ACTOR,
    spaceId: 'presti',
    purpose: 'free-question',
    messages: [{ role: 'user', content: 'quanto costa il listino?' }],
    maxTokens: 64,
  });
  assert.equal(out.adapter, 'fixture-llm');
  assert.equal(out.dryRun, false);
  assert.equal(api.calls(), 1, 'the provider ran exactly once');
  const usage = await app.operations.run('read-llm-usage', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].calls, 1);
  assert.ok(usage[0].inputTokens + usage[0].outputTokens > 0, 'the spend landed');
  const audit = await app.operations.run('read-llm-audit', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(audit.length, 1, 'the receipt landed');
  assert.equal(audit[0].refused, '');
});

test('the llm handle on the public facade spends without LLM_STORAGE_INVALID', async (t) => {
  const { app, api, ops } = await composedLlmApp(t);
  const out = await ops.complete({
    actor: ACTOR,
    spaceId: 'presti',
    purpose: 'assistant',
    messages: [{ role: 'user', content: 'riassumi la richiesta' }],
    maxTokens: 64,
  }, app.modules);
  assert.equal(out.adapter, 'fixture-llm');
  assert.equal(api.calls(), 1, 'the provider ran exactly once');
  const audit = await ops.readAudit({ actor: ACTOR, spaceId: 'presti' }, app.modules);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].purpose, 'assistant');
});

test('suggest runs on the async app with one provider call', async (t) => {
  const { app, api, ops } = await composedLlmApp(t, {
    answers: [{
      text: JSON.stringify([{
        offerId: 'off-1', quantity: 2, motive: 'Il cliente chiede due abbonamenti', sourceExcerptId: 'ex-1',
      }]),
    }],
  });
  const result = await suggestQuoteLines({
    excerpts: [{ id: 'ex-1', text: 'vorrei due abbonamenti annuali per la palestra' }],
    offers: [{ offerId: 'off-1', name: 'Abbonamento annuale' }],
    complete: facadeComplete(ops, app, 'suggest'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].offerId, 'off-1');
  assert.equal(api.calls(), 1, 'suggest called the provider exactly once');
});

test('enrichment (product import) runs on the async app with one provider call', async (t) => {
  const { app, api, ops } = await composedLlmApp(t, {
    answers: [{ text: JSON.stringify([{ sku: 'SKU-1', name: 'Abbonamento', amountCents: 5000 }]) }],
  });
  const result = await extractProductDrafts({
    documentText: 'Listino: SKU-1 Abbonamento 50 euro.',
    complete: facadeComplete(ops, app, 'free-question'),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].sku, 'SKU-1');
  assert.equal(api.calls(), 1, 'enrichment called the provider exactly once');
});

test('an unpriced model refuses before the provider is touched', async (t) => {
  const { api, ops, app } = await composedLlmApp(t, {
    spaceConfig: { model: 'unpriced-model', models: ['unpriced-model'] },
  });
  const code = await codeOf(() => ops.complete({
    actor: ACTOR,
    spaceId: 'presti',
    purpose: 'free-question',
    messages: [{ role: 'user', content: 'ciao' }],
    maxTokens: 64,
  }, app.modules));
  assert.equal(code, 'LLM_PRICING_UNAVAILABLE');
  assert.equal(api.calls(), 0, 'no provider call was paid for a refusal');
});

test('a broken spend seam refuses before the provider is touched', async (t) => {
  const { app, api, ops } = await composedLlmApp(t);
  // A usage service the facade shape cannot spend through: the registry
  // trio `trusted` needs is there, but no manifest and no mutation entry
  // point, so the seam must refuse — before any provider call.
  const broken = {
    get(name) {
      if (name !== 'llm-usage-day') return app.modules.get(name);
      return {
        service: {
          createManaged: async () => { throw new Error('must not create'); },
          applyManaged: async () => { throw new Error('must not patch'); },
          listWhere: async () => [],
        },
      };
    },
    list: () => app.modules.list(),
    schema: () => app.modules.schema(),
  };
  const code = await codeOf(() => ops.complete({
    actor: ACTOR,
    spaceId: 'presti',
    purpose: 'free-question',
    messages: [{ role: 'user', content: 'ciao' }],
    maxTokens: 64,
  }, broken));
  assert.equal(code, 'LLM_STORAGE_INVALID');
  assert.equal(api.calls(), 0, 'no provider call was paid for a broken seam');
});

test('a receipt failure rolls the spend back: zero spend without receipt', async (t) => {
  const { app, api, ops } = await composedLlmApp(t);
  const auditTable = app.modules.get('llm-call-audit').service.manifest.table;
  // The reviewer's scenario (backlog:1943c161 P1): the claim UPDATE lands,
  // then the domain receipt INSERT fails. The spend must roll back with it.
  // The poison wraps both entry points the claim may take — `mutationSync`
  // (sync storage, the facade hands the transaction handle) and
  // `mutationAsync` (async storage) — and fails only the receipt insert.
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

test('a concurrent claim keeps its spend when another claim rolls back on SQLite', async (t) => {
  const { app, api, ops } = await composedLlmApp(t);
  const auditTable = app.modules.get('llm-call-audit').service.manifest.table;
  // P1 of the review on 31a03ad1 (backlog:1943c161): on sync storage the
  // facade claim ran an async body inside one connection-wide savepoint, so
  // a second claim started while the first was parked at an await nested
  // inside it — and the first claim's rollback undid the second claim's
  // spend and receipt after the second had already reported success. The
  // failing claim (space «altro») parks on its receipt insert until the
  // healthy claim (space «presti») has finished; on sync storage the claim
  // must be one synchronous unit, so no other claim can land inside it.
  let reached;
  const reachedReceipt = new Promise((resolve) => { reached = resolve; });
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const poison = (tx, park) => {
    const realExecute = tx.execute.bind(tx);
    return {
      ...tx,
      execute: (statement) => {
        if (statement?.kind === 'insert' && statement?.table === auditTable) {
          reached();
          if (park) return gate.then(() => { throw new Error('injected llm receipt failure'); });
          throw new Error('injected llm receipt failure');
        }
        return realExecute(statement);
      },
    };
  };
  const failingModules = {
    get(name) {
      const entry = app.modules.get(name);
      if (name !== 'llm-usage-day') return entry;
      const service = entry.service;
      const wrapped = { ...service };
      if (typeof service.mutationAsync === 'function') {
        wrapped.mutationAsync = (fn) => service.mutationAsync(async (tx) => fn(poison(tx, true)));
      }
      if (typeof service.mutationSync === 'function') {
        wrapped.mutationSync = (fn) => service.mutationSync((tx) => fn(tx ? poison(tx, false) : tx));
      }
      return { ...entry, service: Object.freeze(wrapped) };
    },
    list: () => app.modules.list(),
    schema: () => app.modules.schema(),
  };
  const ask = (spaceId, modules) => ops.complete({
    actor: ACTOR,
    spaceId,
    purpose: 'free-question',
    messages: [{ role: 'user', content: `ciao da ${spaceId}` }],
    maxTokens: 64,
  }, modules);
  const failing = ask('altro', failingModules).then(() => null, (error) => error);
  await reachedReceipt;
  const healthy = await ask('presti', app.modules);
  open();
  const failure = await failing;
  assert.ok(failure, 'the poisoned claim surfaces its receipt failure');
  assert.equal(healthy.adapter, 'fixture-llm');
  assert.equal(api.calls(), 2, 'each claim paid the provider once');

  const usage = await app.operations.run('read-llm-usage', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].calls, 1, 'the healthy claim kept its spend');
  const audit = await app.operations.run('read-llm-audit', { actor: ACTOR, spaceId: 'presti' });
  assert.equal(audit.length, 1, 'the healthy claim kept its receipt');

  const otherUsage = await app.operations.run('read-llm-usage', { actor: ACTOR, spaceId: 'altro' });
  assert.equal(otherUsage.length, 1);
  assert.equal(otherUsage[0].calls, 0, 'the failed claim rolled its spend back');
  const otherAudit = await app.operations.run('read-llm-audit', { actor: ACTOR, spaceId: 'altro' });
  assert.equal(otherAudit.length, 0, 'the failed claim left no receipt');
});
