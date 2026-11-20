// @ts-check
/**
 * backlog:1f7cb20d3c30 — reproTest of the VERIFIER_BACK failure: a capped
 * agent cannot be assigned even when the caller sends costPerRunCents,
 * because `crm_create_assignment` drops the field (the only caller path
 * that does not speak the framework's single cost name).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccordoApp } from '../packages/app/src/index.js';
import { createMcpServer } from '../packages/mcp/src/index.js';

const USER = { type: 'user', id: 'presti-owner' };
const SPACE = 'presti';

async function call(mcp, name, args) {
  return mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args },
  });
}

test('crm_create_assignment carries costPerRunCents to a capped agent', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  await app.createTeammateAgent({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'ag-spesaconta',
    name: 'Spesaconta',
    role: 'Conta le spese',
    instructions: 'Ogni lunedì conta le spese della settimana.',
    spendingCapCents: 1000,
  });
  const mcp = createMcpServer({ app });

  const created = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-mcp-capped',
    agentSourceKey: 'ag-spesaconta',
    phrase: 'ogni lunedì conta le spese',
    costPerRunCents: 10,
    actorId: 'external-agent',
  });
  assert.equal(created.result.isError, false, JSON.stringify(created.result.content?.[0]?.text).slice(0, 300));
  assert.equal(created.result.structuredContent.assignment.costPerRunCents, 10);

  const stored = await app.modules.get('teammate-assignment').service.listWhere({
    spaceId: SPACE, sourceKey: 'as-mcp-capped',
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].costPerRunCents, 10);
});
