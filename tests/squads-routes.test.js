import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { SQUAD_TEMPLATES, squadSourceKey } from '../packages/agents/src/squads.js';

/**
 * The «Squadre» screen's routes (backlog:0d2d8f2e): the template catalogue,
 * creating a squad from a template and reading its overview. Proven against
 * the real reference composition (the agents package composed in
 * packages/domains/generated) and against a stub app without the package,
 * which must answer an honest 404.
 */

const USER_HEADERS = { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' };

async function withServer(app, fn) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: USER_HEADERS, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('catalogue lists the five ready-made squad templates', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/squads/catalog`, { headers: USER_HEADERS });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.squads.length, 5);
      assert.deepEqual(body.squads.map((entry) => entry.slug), SQUAD_TEMPLATES.map((entry) => entry.slug));
    });
  } finally {
    app.close();
  }
});

test('creating a squad from a template stores it once and the overview reads it', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const first = await post(base, '/api/squads/create', { spaceId: 'presti', key: 'squadra-lead-1', templateSlug: 'lead-generation' });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.duplicate, false);
      assert.equal(first.body.squad.name, 'Acquisizione lead');
      assert.equal(first.body.members.length, 2);
      assert.equal(first.body.routines.length, 2);
      const again = await post(base, '/api/squads/create', { spaceId: 'presti', key: 'squadra-lead-1', templateSlug: 'lead-generation' });
      assert.equal(again.status, 201);
      assert.equal(again.body.duplicate, true);
      const overviewResponse = await fetch(
        `${base}/api/squads/overview?spaceId=presti&squad=${encodeURIComponent(squadSourceKey('presti', 'squadra-lead-1'))}`,
        { headers: USER_HEADERS },
      );
      assert.equal(overviewResponse.status, 200);
      const overview = await overviewResponse.json();
      assert.equal(overview.backlogA.length, 2);
      assert.equal(overview.routines.length, 2);
      assert.equal(overview.backlogB.length, 0);
      assert.equal(overview.metrics.target, 20);
      assert.equal(overview.metrics.actual, null);
      // The squad and its members are readable from the records surface.
      const read = await fetch(`${base}/api/modules/teammate-squad/records?filter.spaceId=presti`, { headers: USER_HEADERS });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).items.length, 1);
      const unknownTemplate = await post(base, '/api/squads/create', { spaceId: 'presti', key: 'squadra-x1', templateSlug: 'inventata' });
      assert.equal(unknownTemplate.status, 400);
      const unclear = await post(base, '/api/squads/create', { spaceId: 'presti', key: 'squadra-x2', brief: 'fai cose belle' });
      assert.equal(unclear.status, 422);
      assert.equal(unclear.body.error.code, 'SQUAD_BRIEF_UNCLEAR');
      const unknown = await fetch(`${base}/api/squads/overview?spaceId=presti&squad=squad%3Apresti%3Afantasma`, { headers: USER_HEADERS });
      assert.equal(unknown.status, 404);
    });
  } finally {
    app.close();
  }
});

test('without the agents package every squad route answers 404, never 500', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const withoutAgents = { ...app, createTeammateSquad: undefined, readTeammateSquadOverview: undefined };
  try {
    await withServer(withoutAgents, async (base) => {
      const catalog = await fetch(`${base}/api/squads/catalog`, { headers: USER_HEADERS });
      assert.equal(catalog.status, 404);
      const created = await post(base, '/api/squads/create', { spaceId: 'presti', key: 'squadra-lead-1', templateSlug: 'lead-generation' });
      assert.equal(created.status, 404);
      const overview = await fetch(`${base}/api/squads/overview?spaceId=presti&squad=x`, { headers: USER_HEADERS });
      assert.equal(overview.status, 404);
    });
  } finally {
    app.close();
  }
});
