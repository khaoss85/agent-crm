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
