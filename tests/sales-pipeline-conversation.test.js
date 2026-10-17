import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { boot } from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { type: 'user', id: 'sales-scenario' };
const SOURCE = { package: 'host', action: 'seed' };

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * A throwaway project composing the interactions package against the
 * repository's own composition: the Accordo sales pipeline and the
 * conversation `open-opportunity` action arrive with it, exactly as the
 * pilot's space composes them from the pinned framework.
 */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-sales-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of ['conversation.module.json', 'interaction-message.module.json', 'interaction-call.module.json']) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/interactions/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      "import { buildMoveStageAction } from '../../core/src/pipeline-actions.js';",
      'export const generatedActions = [buildMoveStageAction({ module: \'opportunity\' })];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages/domains/generated/index.js'),
    [
      "import { createInteractionsPackage } from '../../interactions/src/index.js';",
      'export const generatedDomains = [createInteractionsPackage(),];',
      '',
    ].join('\n'),
  );
  return root;
}

async function saleConversation(app, interactions, { subject, channel = 'whatsapp', handle = '+3902000001' } = {}) {
  const { conversation } = await interactions.openConversation(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey: `wa:thread:${handle.replace(/\+/g, '')}:${Math.random().toString(36).slice(2)}`,
      subject,
      channel,
      remoteHandle: handle,
      source: SOURCE,
    },
  );
  const inbound = await interactions.logMessage(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey: `wa:msg:in:${conversation.id}`,
      conversationId: conversation.id,
      direction: 'inbound',
      channel,
      body: 'Ciao! Vorrei provare la palestra, quanto costa un pacchetto?',
      remoteHandle: handle,
      subject,
      occurredAt: new Date().toISOString(),
      source: SOURCE,
    },
  );
  return { conversation, inbound: inbound.message };
}

test('the space works the Accordo sales stages, and a message opens the sale for the right customer', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'sales.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;
  const interactions = await import(pathToFileURL(join(root, 'packages/interactions/src/index.js')).href);

  // Acceptance 2: the phases are configured for the space, in order.
  const schema = await client.schema();
  const pipeline = schema.pipelines.find((entry) => entry.name === 'accordo-sales');
  assert.ok(pipeline, 'the Accordo sales pipeline is advertised');
  assert.equal(pipeline.module, 'opportunity');
  assert.equal(pipeline.defaultStage, 'richiesta-info');
  assert.deepEqual(pipeline.stages.map((stage) => stage.key), ['richiesta-info', 'prova', 'proposta', 'pagato', 'perso']);
  assert.deepEqual(pipeline.stages.map((stage) => stage.type), ['open', 'open', 'open', 'won', 'lost']);

  // Two customers; the sale must name the one who wrote.
  const company = await app.services.companies.create({ name: 'Presti Group ASD' }, { actor: ACTOR });
  const right = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Daniele', lastName: 'Pelleri', email: 'daniele@presti.example' },
    { actor: ACTOR },
  );
  await app.services.contacts.create(
    { companyId: company.id, firstName: 'Altro', lastName: 'Cliente', email: 'altro@presti.example' },
    { actor: ACTOR },
  );
  const subject = { resource: 'contact', id: right.id, owner: 'host' };
  const { conversation, inbound } = await saleConversation(app, interactions, { subject });

  // Acceptance 1: the opportunity is created from the message, for the right customer.
  const opened = await app.runAction({
    module: 'conversation', action: 'open-opportunity', recordId: conversation.id,
    input: { messageId: inbound.id, opportunityName: 'Prova in palestra', valueCents: 9900 },
    actor: ACTOR,
  });
  const opportunity = await app.services.opportunities.get(opened.result.opportunity.id);
  assert.equal(opportunity.contactId, right.id);
  assert.equal(opportunity.companyId, company.id);
  assert.equal(opportunity.pipelineKey, 'accordo-sales');
  assert.equal(opportunity.pipelineStage, 'richiesta-info');

  // The sale walks the gym's stages to paid, then the terminal stage holds.
  const walk = ['prova', 'proposta', 'pagato'];
  let from = 'richiesta-info';
  for (const to of walk) {
    const moved = await app.runAction({
      module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
      input: { toStage: to, fromStage: from }, actor: ACTOR,
    });
    assert.equal(moved.result.record.pipelineStage, to);
    from = to;
  }
  await assert.rejects(
    () => app.runAction({
      module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
      input: { toStage: 'prova' }, actor: ACTOR,
    }),
    (error) => error.status === 409 && error.code === 'TERMINAL_STAGE',
  );
});

test('one conversation opens one opportunity; the trigger must be its own inbound message', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'sales-guards.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const interactions = await import(pathToFileURL(join(root, 'packages/interactions/src/index.js')).href);

  const company = await app.services.companies.create({ name: 'Presti Group ASD' }, { actor: ACTOR });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Daniele', lastName: 'Pelleri', email: 'daniele@presti.example' },
    { actor: ACTOR },
  );
  const subject = { resource: 'contact', id: contact.id, owner: 'host' };
  const { conversation, inbound } = await saleConversation(app, interactions, { subject });
  const input = (messageId) => ({ messageId, opportunityName: 'Prova', valueCents: 100 });

  // A message logged under this conversation but about ANOTHER customer is
  // refused: a sale never opens from the wrong customer's words, and the
  // refused attempt stores nothing (the valid open below would hit the
  // duplicate-409 otherwise).
  const stranger = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Estraneo', lastName: 'Cliente', email: 'estraneo@presti.example' },
    { actor: ACTOR },
  );
  const foreign = await interactions.logMessage(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey: `wa:msg:foreign:${conversation.id}`, conversationId: conversation.id, direction: 'inbound',
      channel: 'whatsapp', body: 'Vorrei un rimborso!', remoteHandle: '+3902000099',
      subject: { resource: 'contact', id: stranger.id, owner: 'host' },
      occurredAt: new Date().toISOString(), source: SOURCE,
    },
  );
  await assert.rejects(
    () => app.runAction({ module: 'conversation', action: 'open-opportunity', recordId: conversation.id, input: input(foreign.message.id), actor: ACTOR }),
    (error) => error.code === 'OPPORTUNITY_MESSAGE_SUBJECT_MISMATCH' && error.status === 409,
  );

  const first = await app.runAction({ module: 'conversation', action: 'open-opportunity', recordId: conversation.id, input: input(inbound.id), actor: ACTOR });
  // No owner passed: the acting user owns the sale; control characters never land in owner.
  assert.equal((await app.services.opportunities.get(first.result.opportunity.id)).owner, ACTOR.id);
  await assert.rejects(
    () => app.runAction({
      module: 'conversation', action: 'open-opportunity', recordId: conversation.id,
      input: { ...input(inbound.id), owner: 'alice\nINJECTED' }, actor: ACTOR,
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.status === 400,
  );
  // A second message in the same thread does not open a second sale.
  const second = await interactions.logMessage(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey: `wa:msg:in2:${conversation.id}`, conversationId: conversation.id, direction: 'inbound',
      channel: 'whatsapp', body: 'Ci sono anche gli armadietti?', remoteHandle: '+3902000001',
      subject, occurredAt: new Date().toISOString(), source: SOURCE,
    },
  );
  await assert.rejects(
    () => app.runAction({ module: 'conversation', action: 'open-opportunity', recordId: conversation.id, input: input(second.message.id), actor: ACTOR }),
    (error) => error.status === 409,
  );

  // The team's own outbound message never opens a sale.
  const outbound = await interactions.logMessage(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey: `wa:msg:out:${conversation.id}`, conversationId: conversation.id, direction: 'outbound',
      channel: 'whatsapp', body: 'Certo, ti aspettiamo!', teamAuthorId: 'coach',
      remoteHandle: '+3902000001', subject, occurredAt: new Date().toISOString(), source: SOURCE,
    },
  );
  await assert.rejects(
    () => app.runAction({ module: 'conversation', action: 'open-opportunity', recordId: conversation.id, input: input(outbound.message.id), actor: ACTOR }),
    (error) => error.code === 'OPPORTUNITY_NOT_INBOUND',
  );

  // Neither does a message logged on another thread.
  const other = await saleConversation(app, interactions, { subject, handle: '+3902000002' });
  await assert.rejects(
    () => app.runAction({ module: 'conversation', action: 'open-opportunity', recordId: conversation.id, input: input(other.inbound.id), actor: ACTOR }),
    (error) => error.code === 'OPPORTUNITY_MESSAGE_MISMATCH',
  );
});
