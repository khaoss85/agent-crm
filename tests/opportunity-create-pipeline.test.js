// Voce ba47a73b (P1 review su #669): creation and pipeline entry are one
// INSERT. A failing placement refuses the creation instead of orphaning a
// null-pipeline row: the registry is read and validated before the first
// write, and the service never performs a second managed write on create.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { OpportunityService } from '../packages/modules/opportunity/src/opportunity-service.js';

const ACTOR = { type: 'user', id: 'pipeline-single-write' };

async function fixture(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Palestra' }, { actor: ACTOR });
  return { app, company };
}

function serviceWithPipelines(app, pipelines) {
  return new OpportunityService({
    database: app.database,
    audit: app.audit,
    events: app.events,
    companies: app.services.companies,
    contacts: app.services.contacts,
    pipelines,
  });
}

function input(companyId) {
  return { companyId, name: 'Prova', valueCents: 1000, owner: 'x' };
}

test('a broken pipeline registry refuses the creation and leaves no orphan row', async (t) => {
  const { app, company } = await fixture(t);
  const service = serviceWithPipelines(app, { forModule: () => ({ name: 'broken' }) });
  await assert.rejects(
    () => service.create(input(company.id), { actor: ACTOR }),
    (error) => error.code === 'PIPELINE_MISCONFIGURED',
  );
  assert.equal(app.services.opportunities.list().length, 0, 'no orphan row remains');
  assert.equal(app.audit.list({ entityType: 'opportunity' }).length, 0, 'no partial audit');
});

test('a registry failure refuses the creation and leaves no orphan row', async (t) => {
  const { app, company } = await fixture(t);
  const service = serviceWithPipelines(app, { forModule: () => { throw new Error('registry down'); } });
  await assert.rejects(() => service.create(input(company.id), { actor: ACTOR }), /registry down/);
  assert.equal(app.services.opportunities.list().length, 0, 'no orphan row remains');
});

test('a default stage outside the definition refuses the creation with no orphan row', async (t) => {
  const { app, company } = await fixture(t);
  const service = serviceWithPipelines(app, {
    forModule: () => ({ name: 'p', defaultStage: 'ghost', stages: [{ key: 'a' }] }),
  });
  await assert.rejects(
    () => service.create(input(company.id), { actor: ACTOR }),
    (error) => error.code === 'PIPELINE_MISCONFIGURED',
  );
  assert.equal(app.services.opportunities.list().length, 0, 'no orphan row remains');
});
