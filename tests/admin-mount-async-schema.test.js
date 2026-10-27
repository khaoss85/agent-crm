import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';

/**
 * BO-F6-04 seguito (backlog:282de375): in produzione `/bo/api/schema` non
 * pubblicava `domains` ne' `pipeline`.
 *
 * Due cause, entrambe nel percorso async (il sync pubblica entrambi):
 * `app.domains` e' una facade senza `.size`, quindi la condizione
 * `app.domains.size > 0` della rotta e' sempre falsa; e nessun grafo
 * selezionato puo' registrare una pipeline (il registro resta vuoto).
 * Questi test guidano la mount dell'Admin (`createAdminShellMount`, la
 * stessa del web condiviso) contro un'app async reale.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function recordManifests(packageName) {
  return readdirSync(join(root, 'packages', packageName, 'modules'))
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(root, 'packages', packageName, 'modules', file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

async function composeAsync(t, { packages, pipelines }) {
  const customerData = await import('../packages/customer-data/src/index.js');
  const directory = mkdtempSync(join(tmpdir(), 'accordo-async-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'async-schema.sqlite'),
    selected: {
      packageContract: 2,
      packages: packages ?? [customerData.createCustomerDataPackageV2()],
      actions: [],
      modules: recordManifests('customer-data'),
      ...(pipelines === undefined ? {} : { pipelines }),
    },
  });
  t.after(() => app.close());
  return app;
}

const schemaThroughMount = async (app) => {
  const mount = createAdminShellMount(app, { basePath: '/bo' });
  const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
  assert.equal(answer.status, 200);
  return JSON.parse(typeof answer.body === 'string' ? answer.body : answer.body.toString('utf8'));
};

test('async /bo/api/schema publishes the composed domains', async (t) => {
  const app = await composeAsync(t, {});
  const body = await schemaThroughMount(app);
  assert.equal(
    body.domains?.['customer-data']?.customerDataContract,
    1,
    'customer-data is composed, so /bo/api/schema names its domain',
  );
});

test('async selected graph opts into pipelines: /bo/api/schema lists them', async (t) => {
  const app = await composeAsync(t, { pipelines: [accordoSalesPipeline] });
  const body = await schemaThroughMount(app);
  assert.ok(Array.isArray(body.pipelines), 'pipelines travels as a list');
  const sales = body.pipelines.find((entry) => entry?.name === 'accordo-sales');
  assert.ok(sales, 'the opted-in sales pipeline is listed');
  assert.equal(sales.module, 'opportunity');
  assert.equal(sales.movePath, '/api/modules/opportunity/records/:id/actions/move-stage');
});

test('a pipeline on a non-staged module fails closed at composition', async (t) => {
  await assert.rejects(
    () => composeAsync(t, {
      pipelines: [{ ...accordoSalesPipeline, name: 'ghost-sales', module: 'ghost' }],
    }),
    /not staged-eligible/,
  );
});
