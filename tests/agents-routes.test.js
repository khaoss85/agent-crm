// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { AGENT_CATALOG, catalogAgentSourceKey, customAgentSourceKey } from '../packages/agents/src/index.js';

/**
 * The «Agenti» screen's routes (backlog:33782ba68747): the catalogue read,
 * adding a catalogue agent through create-agent and instructing an agent
 * through create-assignment. Proven against the real reference composition
 * (the agents package composed in packages/domains/generated) and against
 * a stub app without the package, which must answer an honest 404.
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

test('catalogue lists the ready-made agents with the source key of the asked space', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/agents/catalog?spaceId=presti`, { headers: USER_HEADERS });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.agents.length, AGENT_CATALOG.length);
      const riaggancio = body.agents.find((entry) => entry.slug === 'riaggancio');
      assert.equal(riaggancio.name, 'Riaggancio');
      assert.equal(riaggancio.agentSourceKey, catalogAgentSourceKey('presti', 'riaggancio'));
    });
  } finally {
    app.close();
  }
});

test('adding a catalogue agent creates it once, in its space, readable from the records surface', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const first = await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio', name: 'Hacked' });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.duplicate, false);
      assert.equal(first.body.agent.name, 'Riaggancio', 'the catalogue, never the body, names the agent');
      assert.equal(first.body.agent.actorId, 'op-1');
      const again = await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio' });
      assert.equal(again.status, 201);
      assert.equal(again.body.duplicate, true);
      const other = await post(base, '/api/agents/create', { spaceId: 'altro', slug: 'riaggancio' });
      assert.equal(other.body.duplicate, false, 'the same catalogue agent in another space is another agent');
      const read = await fetch(`${base}/api/modules/teammate-agent/records?filter.spaceId=presti`, { headers: USER_HEADERS });
      assert.equal(read.status, 200);
      const rows = (await read.json()).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sourceKey, catalogAgentSourceKey('presti', 'riaggancio'));
      const unknown = await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'inventato' });
      assert.equal(unknown.status, 404);
    });
  } finally {
    app.close();
  }
});

test('an instruction without a schedule refuses; the explicit «una volta, adesso» plan creates it', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio' });
      const agentSourceKey = catalogAgentSourceKey('presti', 'riaggancio');
      const phrase = 'occupati dei lead WhatsApp non contattati';
      const unclear = await post(base, '/api/agents/assign', { spaceId: 'presti', sourceKey: 'bo-assign-1', agentSourceKey, phrase });
      assert.equal(unclear.status, 422);
      assert.equal(unclear.body.error.code, 'AGENT_PHRASE_UNCLEAR');
      const runAt = new Date().toISOString();
      const once = await post(base, '/api/agents/assign', {
        spaceId: 'presti', sourceKey: 'bo-assign-1', agentSourceKey, phrase, plan: { cadence: 'once', runAt },
      });
      assert.equal(once.status, 201);
      assert.equal(once.body.assignment.cadence, 'once');
      assert.equal(once.body.assignment.phrase, phrase);
      const weekly = await post(base, '/api/agents/assign', {
        spaceId: 'presti', sourceKey: 'bo-assign-2', agentSourceKey, phrase: 'ogni lunedì il report vendite',
      });
      assert.equal(weekly.status, 201);
      assert.equal(weekly.body.assignment.cadence, 'weekly');
    });
  } finally {
    app.close();
  }
});

test('without the agents package every route answers 404, never 500', async () => {
  const app = { calls: [] };
  await withServer(app, async (base) => {
    const catalog = await fetch(`${base}/api/agents/catalog?spaceId=presti`, { headers: USER_HEADERS });
    assert.equal(catalog.status, 404);
    const create = await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio' });
    assert.equal(create.status, 404);
    const assign = await post(base, '/api/agents/assign', { spaceId: 'presti', sourceKey: 'k', agentSourceKey: 'a', phrase: 'x' });
    assert.equal(assign.status, 404);
  });
});

test('review #661: an agent of one space cannot be instructed under another space id', async () => {
  // Spaces of one organization share one team by design (the organization
  // is the tenant, ADR-038): the space id is not an authorization boundary
  // inside it. What the route does enforce is that an assignment names an
  // agent of the space it is written to.
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio' });
      const crossed = await post(base, '/api/agents/assign', {
        spaceId: 'altro', sourceKey: 'bo-x-1', agentSourceKey: catalogAgentSourceKey('presti', 'riaggancio'), phrase: 'ogni lunedì il report',
      });
      assert.equal(crossed.status, 404);
      assert.equal(crossed.body.error.code, 'AGENT_UNKNOWN');
    });
  } finally {
    app.close();
  }
});

test('review #661 giro 2 P3: a padded or capitalised slug finds its agent; an oversized space id is refused', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const padded = await post(base, '/api/agents/create', { spaceId: 'presti', slug: '  Riaggancio ' });
      assert.equal(padded.status, 201);
      assert.equal(padded.body.agent.name, 'Riaggancio');
      const unknown = await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'x'.repeat(5000) });
      assert.equal(unknown.status, 404);
      assert.ok(JSON.stringify(unknown.body).length < 1000, 'the refusal never echoes the raw input');
      const long = await fetch(`${base}/api/agents/catalog?spaceId=${'s'.repeat(200)}`, { headers: USER_HEADERS });
      assert.equal(long.status, 400);
    });
  } finally {
    app.close();
  }
});

/**
 * backlog:1f7cb20d3c30 — «Nuovo agente»: an agent written by hand, not taken
 * from the catalogue, through the same create-agent operation.
 */
const CUSTOM = {
  spaceId: 'presti',
  key: 'v1.20261112.0123456789abcdef0123456789abcdef',
  name: 'Ricorda compleanni',
  role: 'Fa gli auguri ai clienti',
  instructions: 'Ogni mattina guarda chi compie gli anni e prepara un messaggio di auguri. Ogni messaggio aspetta il tuo ok.',
  spendingCapCents: 500,
};

test('1f7cb20d3c30: a hand-written agent is created once, with a source key the server makes', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const first = await post(base, '/api/agents/create', { ...CUSTOM, sourceKey: 'agent:presti:riaggancio' });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.duplicate, false);
      const agent = first.body.agent;
      assert.equal(agent.name, CUSTOM.name);
      assert.equal(agent.role, CUSTOM.role);
      assert.equal(agent.instructions, CUSTOM.instructions);
      assert.equal(agent.spendingCapCents, 500);
      assert.equal(agent.sourceKey, customAgentSourceKey('presti', CUSTOM.key), 'the body never picks the source key');
      assert.ok(!agent.sourceKey.startsWith('agent:'), 'never shaped like a catalogue key');
      assert.equal(agent.actorId, 'op-1');
      const again = await post(base, '/api/agents/create', CUSTOM);
      assert.equal(again.status, 201);
      assert.equal(again.body.duplicate, true, 'the same caller key replays');
      const read = await fetch(`${base}/api/modules/teammate-agent/records?filter.spaceId=presti`, { headers: USER_HEADERS });
      const rows = (await read.json()).items;
      assert.equal(rows.length, 1);
      // Instructed like a catalogue agent: an assignment to it is created.
      const assign = await post(base, '/api/agents/assign', {
        spaceId: 'presti', sourceKey: 'bo-assign-c1', agentSourceKey: agent.sourceKey,
        phrase: 'ogni lunedì fai gli auguri', costPerRunCents: 20,
      });
      assert.equal(assign.status, 201, JSON.stringify(assign.body));
      assert.equal(assign.body.assignment.costPerRunCents, 20);
      const noCost = await post(base, '/api/agents/assign', {
        spaceId: 'presti', sourceKey: 'bo-assign-c2', agentSourceKey: agent.sourceKey, phrase: 'ogni lunedì fai gli auguri',
      });
      assert.equal(noCost.status, 422, 'an agent with a cap needs the cost of a run');
      assert.equal(noCost.body.error.code, 'AGENT_COST_ESTIMATE_REQUIRED');
    });
  } finally {
    app.close();
  }
});

test('1f7cb20d3c30: two agents of one space never answer to the same @name; bad bodies refuse', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      await post(base, '/api/agents/create', { spaceId: 'presti', slug: 'riaggancio' });
      const clash = await post(base, '/api/agents/create', { ...CUSTOM, name: 'riaggàncio ' });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.error.code, 'AGENT_NAME_TAKEN');
      const otherSpace = await post(base, '/api/agents/create', { ...CUSTOM, spaceId: 'altro', name: 'Riaggancio' });
      assert.equal(otherSpace.status, 201, 'another space may use the name');
      const noKey = await post(base, '/api/agents/create', { ...CUSTOM, key: undefined });
      assert.equal(noKey.status, 400, 'no caller key, no agent');
      const badKey = await post(base, '/api/agents/create', { ...CUSTOM, key: '../agent:presti:riaggancio' });
      assert.equal(badKey.status, 400);
      const noName = await post(base, '/api/agents/create', { ...CUSTOM, key: 'v1.20261112.ffffffffffffffffffffffffffffffff', name: '' });
      assert.equal(noName.status, 400);
      const noSpace = await post(base, '/api/agents/create', { ...CUSTOM, spaceId: '' });
      assert.equal(noSpace.status, 400);
      const badCap = await post(base, '/api/agents/create', { ...CUSTOM, key: 'v1.20261112.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Altro', spendingCapCents: -1 });
      assert.equal(badCap.status, 400);
    });
  } finally {
    app.close();
  }
});
