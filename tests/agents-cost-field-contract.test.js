// @ts-check
/**
 * backlog:1f7cb20d3c30 — contract of the cost field from the page to the
 * framework: the «Affida» payload the page builds (assignAttempt +
 * assignToAgent) travels through POST /api/agents/assign and lands in the
 * stored assignment under the same name, `costPerRunCents`. A capped agent
 * refuses an assignment without it (422 AGENT_COST_ESTIMATE_REQUIRED) and
 * accepts one with it (201). One name on the whole chain, never an alias.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { customAgentSourceKey } from '../packages/agents/src/index.js';
import { assignAttempt, assignToAgent } from '../apps/admin/public/admin-agenti.js';

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

test('the page cost field reaches the stored assignment under the same name', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const created = await post(base, '/api/agents/create', {
        spaceId: 'presti',
        key: 'spesaconta',
        name: 'Spesaconta',
        role: 'Conta le spese',
        instructions: 'Ogni lunedì conta le spese della settimana.',
        spendingCapCents: 1000,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const agentSourceKey = customAgentSourceKey('presti', 'spesaconta');

      // The payload exactly as the «Affida» card builds it: €0,10 a giro.
      let attempt = assignAttempt(null, {
        spaceId: 'presti', agentSourceKey, phrase: 'ogni lunedì conta le spese', costPerRunCents: 10,
      });
      const seen = [];
      const bound = {
        async request(path, options = {}) {
          assert.equal(path, '/api/agents/assign');
          seen.push(options.body);
          const answer = await post(base, path, options.body);
          if (answer.status >= 400) {
            throw Object.assign(new Error('request failed'), {
              code: answer.body?.error?.code, status: answer.status,
            });
          }
          return answer.body;
        },
      };
      const made = await assignToAgent(bound, attempt, { once: true, nowIso: new Date().toISOString() });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].costPerRunCents, 10, 'the page posts costPerRunCents');
      assert.equal(made?.costPerRunCents, 10, 'the stored assignment keeps costPerRunCents');

      const read = await fetch(
        `${base}/api/modules/teammate-assignment/records?filter.spaceId=presti`, { headers: USER_HEADERS },
      );
      assert.equal(read.status, 200);
      const rows = (await read.json()).items;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].costPerRunCents, 10, 'the record surface reads costPerRunCents');
    });
  } finally {
    app.close();
  }
});

test('a capped agent refuses an assignment without the cost estimate', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    await withServer(app, async (base) => {
      const created = await post(base, '/api/agents/create', {
        spaceId: 'presti',
        key: 'spesaconta',
        name: 'Spesaconta',
        role: 'Conta le spese',
        instructions: 'Ogni lunedì conta le spese della settimana.',
        spendingCapCents: 1000,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const refused = await post(base, '/api/agents/assign', {
        spaceId: 'presti',
        sourceKey: 'bo-assign-nocost',
        agentSourceKey: customAgentSourceKey('presti', 'spesaconta'),
        phrase: 'ogni lunedì conta le spese',
        plan: { cadence: 'once', runAt: new Date().toISOString() },
      });
      assert.equal(refused.status, 422);
      assert.equal(refused.body.error.code, 'AGENT_COST_ESTIMATE_REQUIRED');
    });
  } finally {
    app.close();
  }
});
