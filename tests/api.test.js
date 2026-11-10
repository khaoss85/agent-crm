import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';
import { buildMoveStageAction } from '../packages/core/src/pipeline-actions.js';

test('HTTP API and Admin use the same application state', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
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

  const root = await fetch(baseUrl);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Accordo/);

  const demoResponse = await fetch(`${baseUrl}/api/demo/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(demoResponse.status, 200);

  const opportunities = await fetch(`${baseUrl}/api/opportunities`).then((response) => response.json());
  assert.equal(opportunities.items.length, 2);
  assert.equal(opportunities.items.filter((item) => item.stage === 'approval_pending').length, 1);

  const approvals = await fetch(`${baseUrl}/api/approvals?status=pending`).then((response) => response.json());
  assert.equal(approvals.items.length, 1);

  const approveResponse = await fetch(`${baseUrl}/api/approvals/${approvals.items[0].id}/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actor-id': 'vp-sales',
      'x-actor-type': 'user',
    },
    body: '{}',
  });
  assert.equal(approveResponse.status, 200);
  assert.equal(app.services.approvals.get(approvals.items[0].id).decidedBy, 'vp-sales');
});

async function bootServer(t, { pipeline = false } = {}) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  if (pipeline) {
    app.pipelines.register(accordoSalesPipeline);
    app.actions.register(buildMoveStageAction({ module: 'opportunity' }));
  }
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

const SCHEDA_HEADERS = {
  'content-type': 'application/json',
  'x-actor-id': 'scheda-test',
  'x-actor-type': 'user',
};

// Voce ba47a73b: an offer created from the scheda (POST /api/opportunities)
// takes the space's default pipeline at its first stage, shows on the board
// at once, and its card can move.
test('POST /api/opportunities enters the default pipeline at its first stage', async (t) => {
  const { app, baseUrl } = await bootServer(t, { pipeline: true });
  const actor = { type: 'user', id: 'scheda-test' };
  const company = await app.services.companies.create({ name: 'Scheda Co' }, { actor });

  const post = await fetch(`${baseUrl}/api/opportunities`, {
    method: 'POST',
    headers: SCHEDA_HEADERS,
    body: JSON.stringify({ companyId: company.id, name: 'Offerta scheda', valueCents: 25000, owner: 'scheda-test' }),
  });
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.equal(created.pipelineKey, 'accordo-sales');
  assert.equal(created.pipelineStage, 'richiesta-info');
  assert.ok(typeof created.stageEnteredAt === 'string');

  // The board lists it at once, with its pipeline position.
  const listed = await fetch(`${baseUrl}/api/opportunities`).then((response) => response.json());
  const row = listed.items.find((item) => item.id === created.id);
  assert.equal(row?.pipelineKey, 'accordo-sales');
  assert.equal(row?.pipelineStage, 'richiesta-info');

  // And the card moves along the board instead of refusing NO_PIPELINE.
  const move = await fetch(`${baseUrl}/api/modules/opportunity/records/${created.id}/actions/move-stage`, {
    method: 'POST',
    headers: SCHEDA_HEADERS,
    body: JSON.stringify({ toStage: 'prova', fromStage: 'richiesta-info' }),
  });
  assert.equal(move.status, 200);
  const reread = await fetch(`${baseUrl}/api/opportunities/${created.id}`).then((response) => response.json());
  assert.equal(reread.pipelineStage, 'prova');
});

// Without a pipeline installed the legacy behavior stays: null pipeline
// state, never an invented stage.
test('POST /api/opportunities keeps null pipeline state with no pipeline installed', async (t) => {
  const { app, baseUrl } = await bootServer(t);
  const actor = { type: 'user', id: 'scheda-test' };
  const company = await app.services.companies.create({ name: 'Legacy Co' }, { actor });

  const post = await fetch(`${baseUrl}/api/opportunities`, {
    method: 'POST',
    headers: SCHEDA_HEADERS,
    body: JSON.stringify({ companyId: company.id, name: 'Offerta legacy', valueCents: 1000, owner: 'scheda-test' }),
  });
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.equal(created.pipelineKey, null);
  assert.equal(created.pipelineStage, null);
});
