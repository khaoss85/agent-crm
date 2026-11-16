// @ts-check

/**
 * External-agent MCP tools (backlog:5752407ae9b3): everything the screen does,
 * an external agent can do — read the space playbook, give a teammate agent
 * an assignment, list the human-approval proposals and decide one.
 *
 * Every write runs through the governed operation or record action with the
 * caller identity, so it carries identity and audit; without the identity
 * (or without the human identity on a decision) the tool refuses before
 * calling, and a proposal of another space is refused. Production MCP stays
 * the declared static surface: no tools there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccordoApp } from '../packages/app/src/index.js';
import { createMcpServer } from '../packages/mcp/src/index.js';
import {
  createProductionToolRegistry,
} from '../packages/mcp/src/production-surface.js';
import { MCP_PRODUCTION_SURFACE_UNAVAILABLE } from '../packages/mcp/src/production-surface.js';
import { buildAiProposal } from '../packages/space-permissions/src/proposals.js';

const USER = { type: 'user', id: 'presti-owner' };
const AGENT = { type: 'agent', id: 'external-agent' };
const SPACE = 'presti';
const OTHER_SPACE = 'arvo-fiori';
const NOW = '2026-11-16T10:00:00.000Z';

function appFor(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  return app;
}

async function seedPlaybook(app) {
  await app.modules.get('sales-playbook').service.savePlaybook(SPACE, {
    companyName: 'Presti Group',
    description: 'Palestra con personal training e corsi di gruppo.',
    products: 'Abbonamento mensile',
    idealCustomer: 'Adulti 25-50 vicino casa.',
    tone: 'Energico ma mai pressante.',
  }, { actor: USER });
}

async function seedAgent(app) {
  await app.createTeammateAgent({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'ag-vendite',
    name: 'Vendi',
    role: 'Prepara il report vendite',
    instructions: 'Leggi le vendite e proponi il report.',
  });
}

async function seedProposal(app, over = {}) {
  const draft = buildAiProposal({
    spaceId: over.spaceId ?? SPACE,
    permission: 'send-without-approval',
    actionKind: over.actionKind ?? 'send-message',
    actionKey: over.actionKey ?? 'msg-welcome-1',
    summary: over.summary ?? 'Invia il messaggio di benvenuto al nuovo iscritto.',
    proposedAt: NOW,
  });
  return app.modules.get('space-ai-proposal').service.createManaged({ ...draft }, { actor: AGENT });
}

async function call(mcp, name, args) {
  return mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args },
  });
}

test('the external-agent tools are listed with read and write annotations', async (t) => {
  const mcp = createMcpServer({ app: appFor(t) });
  const list = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const byName = new Map(list.result.tools.map((tool) => [tool.name, tool]));
  for (const name of ['crm_read_playbook', 'crm_create_assignment', 'crm_list_proposals', 'crm_decide_proposal']) {
    assert.ok(byName.has(name), `missing MCP tool: ${name}`);
  }
  assert.equal(byName.get('crm_read_playbook').annotations.readOnlyHint, true);
  assert.equal(byName.get('crm_list_proposals').annotations.readOnlyHint, true);
  assert.equal(byName.get('crm_create_assignment').annotations.readOnlyHint, false);
  assert.equal(byName.get('crm_decide_proposal').annotations.readOnlyHint, false);
  assert.equal(
    byName.get('crm_decide_proposal')._meta['anthropic/requiresUserInteraction'],
    true,
  );
});

test('crm_read_playbook reads the playbook the member compiled', async (t) => {
  const app = appFor(t);
  await seedPlaybook(app);
  const mcp = createMcpServer({ app });

  const found = await call(mcp, 'crm_read_playbook', { spaceId: SPACE });
  assert.equal(found.result.isError, false);
  assert.equal(found.result.structuredContent.spaceId, SPACE);
  assert.equal(found.result.structuredContent.companyName, 'Presti Group');
  assert.equal(found.result.structuredContent.tone, 'Energico ma mai pressante.');

  const missing = await call(mcp, 'crm_read_playbook', { spaceId: OTHER_SPACE });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /No sales playbook/);
});

test('crm_create_assignment turns a phrase into an assignment with identity and audit', async (t) => {
  const app = appFor(t);
  await seedAgent(app);
  const mcp = createMcpServer({ app });

  const created = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-mcp-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    actorId: 'external-agent',
  });
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.duplicate, false);
  assert.equal(created.result.structuredContent.assignment.cadence, 'weekly');
  assert.ok(created.result.structuredContent.assignment.nextRunAt);
  assert.equal(created.result.structuredContent.assignment.actorType, 'agent');
  assert.equal(created.result.structuredContent.assignment.actorId, 'external-agent');

  const stored = await app.modules.get('teammate-assignment').service.listWhere({
    spaceId: SPACE, sourceKey: 'as-mcp-report',
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].phrase, 'ogni lunedì il report vendite');

  const retry = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-mcp-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    actorId: 'external-agent',
  });
  assert.equal(retry.result.isError, false);
  assert.equal(retry.result.structuredContent.duplicate, true);
});

test('crm_create_assignment refuses without an identity, with a vague phrase or an unknown agent', async (t) => {
  const app = appFor(t);
  await seedAgent(app);
  const mcp = createMcpServer({ app });

  const anonymous = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-no-actor',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
  });
  assert.equal(anonymous.result.isError, true);
  assert.match(anonymous.result.content[0].text, /actorId/);

  const vague = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-vague',
    agentSourceKey: 'ag-vendite',
    phrase: 'fai qualcosa di utile ogni tanto',
    actorId: 'external-agent',
  });
  assert.equal(vague.result.isError, true);
  assert.match(vague.result.content[0].text, /AGENT_PHRASE_UNCLEAR/);

  const unknown = await call(mcp, 'crm_create_assignment', {
    spaceId: SPACE,
    sourceKey: 'as-unknown',
    agentSourceKey: 'ag-che-non-ce',
    phrase: 'ogni lunedì il report vendite',
    actorId: 'external-agent',
  });
  assert.equal(unknown.result.isError, true);

  assert.equal(
    await app.modules.get('teammate-assignment').service.countWhere({ spaceId: SPACE }),
    0,
    'refused assignments write nothing',
  );
});

test('crm_list_proposals lists one space queue only', async (t) => {
  const app = appFor(t);
  await seedProposal(app, { actionKey: 'msg-welcome-1' });
  await seedProposal(app, { spaceId: OTHER_SPACE, actionKey: 'msg-welcome-1', actionKind: 'send-message' });
  const mcp = createMcpServer({ app });

  const listed = await call(mcp, 'crm_list_proposals', { spaceId: SPACE });
  assert.equal(listed.result.isError, false);
  assert.equal(listed.result.structuredContent.items.length, 1);
  assert.equal(listed.result.structuredContent.items[0].spaceId, SPACE);
  assert.equal(listed.result.structuredContent.items[0].status, 'proposed');

  const filtered = await call(mcp, 'crm_list_proposals', { spaceId: SPACE, status: 'approved' });
  assert.equal(filtered.result.isError, false);
  assert.deepEqual(filtered.result.structuredContent.items, []);

  const badStatus = await call(mcp, 'crm_list_proposals', { spaceId: SPACE, status: 'sent' });
  assert.equal(badStatus.result.isError, true);
});

test('crm_decide_proposal approves through the governed action with the human identity', async (t) => {
  const app = appFor(t);
  const proposal = await seedProposal(app);
  const mcp = createMcpServer({ app });

  const decided = await call(mcp, 'crm_decide_proposal', {
    spaceId: SPACE,
    proposalId: proposal.id,
    decision: 'approved',
    decidedBy: 'presti-owner',
  });
  assert.equal(decided.result.isError, false);
  const stored = app.modules.get('space-ai-proposal').service.get(proposal.id);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.decidedBy, 'presti-owner');

  const again = await call(mcp, 'crm_decide_proposal', {
    spaceId: SPACE,
    proposalId: proposal.id,
    decision: 'refused',
    decidedBy: 'presti-owner',
    refusalReason: 'ripensato',
  });
  assert.equal(again.result.isError, true);
  assert.equal(app.modules.get('space-ai-proposal').service.get(proposal.id).status, 'approved');
});

test('crm_decide_proposal refuses without the human identity or from another space', async (t) => {
  const app = appFor(t);
  const proposal = await seedProposal(app);
  const mcp = createMcpServer({ app });

  const anonymous = await call(mcp, 'crm_decide_proposal', {
    spaceId: SPACE,
    proposalId: proposal.id,
    decision: 'approved',
  });
  assert.equal(anonymous.result.isError, true);
  assert.match(anonymous.result.content[0].text, /decidedBy/);

  const crossSpace = await call(mcp, 'crm_decide_proposal', {
    spaceId: OTHER_SPACE,
    proposalId: proposal.id,
    decision: 'approved',
    decidedBy: 'presti-owner',
  });
  assert.equal(crossSpace.result.isError, true);
  assert.match(crossSpace.result.content[0].text, /another space/);

  assert.equal(
    app.modules.get('space-ai-proposal').service.get(proposal.id).status,
    'proposed',
    'refused decisions write nothing',
  );
});

test('production MCP keeps the declared static surface: no tools', () => {
  assert.deepEqual(createProductionToolRegistry().list(), []);
  assert.match(MCP_PRODUCTION_SURFACE_UNAVAILABLE, /PRODUCTION/);
});
