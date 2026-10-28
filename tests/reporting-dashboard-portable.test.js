// @ts-check

/**
 * Production /bo Reporting (backlog:0e3e67eb).
 *
 * The portable (async) composition that production serves /bo from exposes
 * no `database` handle, so GET /api/reporting/dashboard threw
 * STORAGE_UNAVAILABLE (500) while the same request on the synchronous
 * factory answered 200. The dashboard must answer 200 with an empty model
 * on empty data — never a 500 — and real numbers once rows exist.
 *
 * Real sqlite (`:memory:`) through createAccordoAppAsync + createHttpServer,
 * the same production shape (narrow `selected` graph, no `database` key).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { formatMinor } from '../packages/analytics/src/dashboard.js';
import { createHttpServer } from '../apps/server/src/index.js';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const REPORTING_MANIFEST = JSON.parse(
  readFileSync(join(repoRoot, '..', 'bundles', 'reporting', '1.2.0', 'module.manifest.json'), 'utf8'),
);

const ACTOR = 'test:reporting-portable';

/** @param {{modules?: Array<{name: string, manifest: unknown} | string>}} [selection] */
async function portableServer(t, selection = {}) {
  const app = await createAccordoAppAsync({
    dbPath: ':memory:',
    selected: {
      packageContract: 2,
      packages: [],
      actions: [],
      modules: selection.modules ?? [],
      pipelines: [],
    },
  });
  assert.equal(app.database, undefined, 'the portable facade carries no database handle (production shape)');
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  return { app, baseUrl };
}

test('portable dashboard without data answers 200 with an empty model, never 500', async (t) => {
  const { baseUrl } = await portableServer(t);
  const response = await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10&currency=EUR`);
  assert.equal(response.status, 200, 'empty data is an empty model, not a 500');
  const model = await response.json();
  assert.equal(model.period, '2026-10');
  assert.equal(model.owner, null);
  assert.equal(model.currency, 'EUR');
  assert.equal(model.kpis.length, 5);
  for (const kpi of model.kpis) {
    assert.match(kpi.display, /^(0|0,00 €|n\.d\.)/, `kpi ${kpi.id} reads zero, got ${kpi.display}`);
  }
  assert.deepEqual(model.insights, [
    { id: 'no-data', text: 'Ancora nessun preventivo in questa vista: i grafici si riempiono da soli.' },
  ]);
  assert.equal(model.proposal, null);
  assert.equal(model.forecast.targetMinor, null);
  assert.equal(model.channels.total, 0);
  assert.deepEqual(model.owners, []);
});

test('portable dashboard reads real rows once they exist', async (t) => {
  const { app, baseUrl } = await portableServer(t);
  const company = await app.services.companies.create({ name: 'Palestra Presti' }, { actor: ACTOR });
  await app.services.opportunities.create(
    {
      companyId: company.id,
      name: 'Abbonamento annuale',
      type: 'new_business',
      valueCents: 120000,
      currency: 'EUR',
      stage: 'won',
      owner: 'guido',
      expectedCloseDate: '2026-10-12',
    },
    { actor: ACTOR },
  );
  const response = await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10&currency=EUR`);
  assert.equal(response.status, 200);
  const model = await response.json();
  const won = model.kpis.find((entry) => entry.id === 'won-period');
  assert.equal(won.display, formatMinor(120000, 'EUR'));
  assert.equal(won.sub, '1 chiusure');
  assert.deepEqual(model.owners, ['guido']);
});

test('selecting the reporting bundle manifest exposes its records on portable', async (t) => {
  const without = await portableServer(t);
  const missing = await fetch(`${without.baseUrl}/api/modules/reporting/records?limit=100`);
  assert.equal(missing.status, 404, 'uncomposed module stays 404');

  const { baseUrl } = await portableServer(t, {
    modules: [{ name: 'reporting', manifest: REPORTING_MANIFEST }],
  });
  const response = await fetch(`${baseUrl}/api/modules/reporting/records?limit=100`);
  assert.equal(response.status, 200, 'the composed bundle lists, even with zero rows');
  assert.deepEqual(await response.json(), { items: [] });
});
