// Voce 96e7b579: the pipeline card edits importo, data di chiusura and
// referente in place. The service touches only the columns the patch names
// (plus updatedAt) and refuses anything else — companyId, stage and the
// pipeline-managed keys can never move through an edit. The HTTP route
// mirrors the contacts PATCH contract: unknown fields refuse with 400,
// a missing record 404s.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

const ACTOR = { type: 'user', id: 'opportunity-update' };

async function fixture(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const company = await app.services.companies.create({ name: 'Palestra' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    name: 'Pacchetto 10 ingressi',
    valueCents: 25000,
    owner: 'elena',
    expectedCloseDate: '2026-12-31T00:00:00.000Z',
  }, { actor: ACTOR });
  t.after(() => app.close());
  return { app, opportunity };
}

function startServer(t, app) {
  const server = createHttpServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      t.after(async () => { await new Promise((r) => server.close(r)); });
      resolve(baseUrl);
    });
  });
}

async function patch(baseUrl, id, body) {
  const response = await fetch(`${baseUrl}/api/opportunities/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'opportunity-update' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, payload: text === '' ? null : JSON.parse(text) };
}

test('update edits importo, chiusura and referente and nothing else', async (t) => {
  const { app, opportunity } = await fixture(t);
  const updated = await app.services.opportunities.update(opportunity.id, {
    valueCents: 30000,
    expectedCloseDate: '2027-01-15T00:00:00.000Z',
    owner: 'guido',
  }, { actor: ACTOR });
  assert.equal(updated.valueCents, 30000);
  assert.equal(updated.expectedCloseDate, '2027-01-15T00:00:00.000Z');
  assert.equal(updated.owner, 'guido');
  assert.equal(updated.companyId, opportunity.companyId, 'the customer never moves through an edit');
  assert.equal(updated.stage, opportunity.stage, 'the lifecycle stage never moves through an edit');
});

test('update is partial: untouched columns keep their values', async (t) => {
  const { app, opportunity } = await fixture(t);
  const updated = await app.services.opportunities.update(opportunity.id, { owner: 'maria' }, { actor: ACTOR });
  assert.equal(updated.owner, 'maria');
  assert.equal(updated.valueCents, 25000);
  assert.equal(updated.expectedCloseDate, '2026-12-31T00:00:00.000Z');
});

test('update refuses an empty patch, unknown fields and bad values', async (t) => {
  const { app, opportunity } = await fixture(t);
  await assert.rejects(
    app.services.opportunities.update(opportunity.id, {}, { actor: ACTOR }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
    'an empty patch is refused',
  );
  for (const patch of [
    { companyId: 'other' },
    { stage: 'won' },
    { pipelineStage: 'proposta' },
    { name: 'Nuovo nome' },
  ]) {
    await assert.rejects(
      app.services.opportunities.update(opportunity.id, patch, { actor: ACTOR }),
      (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
      `a customer, stage or pipeline move through an edit is refused (${Object.keys(patch)[0]})`,
    );
  }
  await assert.rejects(
    app.services.opportunities.update(opportunity.id, { valueCents: -1 }, { actor: ACTOR }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
    'a negative importo is refused',
  );
  await assert.rejects(
    app.services.opportunities.update(opportunity.id, { owner: '  ' }, { actor: ACTOR }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
    'an empty referente is refused',
  );
  await assert.rejects(
    app.services.opportunities.update(opportunity.id, { expectedCloseDate: 'non-una-data' }, { actor: ACTOR }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
    'a bad chiusura is refused',
  );
  const reread = await app.services.opportunities.get(opportunity.id);
  assert.equal(reread.valueCents, 25000, 'a refused edit writes nothing');
  assert.equal(reread.owner, 'elena');
});

test('update on a missing record 404s', async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(
    app.services.opportunities.update('00000000-0000-0000-0000-000000000000', { owner: 'maria' }, { actor: ACTOR }),
    (error) => error?.status === 404,
    'no record is invented',
  );
});

test('PATCH /api/opportunities/:id edits and refuses unknown fields', async (t) => {
  const { app, opportunity } = await fixture(t);
  const baseUrl = await startServer(t, app);

  const edited = await patch(baseUrl, opportunity.id, { valueCents: 27500, owner: 'guido' });
  assert.equal(edited.status, 200);
  assert.equal(edited.payload.valueCents, 27500);
  assert.equal(edited.payload.owner, 'guido');

  const unknown = await patch(baseUrl, opportunity.id, { stage: 'won' });
  assert.equal(unknown.status, 400);

  const missing = await patch(baseUrl, '00000000-0000-0000-0000-000000000000', { owner: 'maria' });
  assert.equal(missing.status, 404);
});
