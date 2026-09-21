import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers/contracts-project.js';

const rootSource = fileURLToPath(new URL('..', import.meta.url));
const POLICY = { policy: 'standard-proposal', policyVersion: 1 };
const DRAFT = {
  title: 'Recover trial activation', mode: 'one-shot',
  audienceJson: '{"rule":"trial teams"}', exclusionsJson: '["unsubscribed"]', channel: 'email',
  providerRationale: 'Proposed provider only; none is configured or contacted.',
  contentPlanJson: '{"subject":"<script>alert(1)</script>"}', trackingPlanJson: '{"metric":"activation"}',
  risksJson: '["consent requires review"]', requiredApprovalsJson: '["marketing owner"]',
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-marketing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'package.json']) cpSync(join(rootSource, entry), join(root, entry), { recursive: true });
  for (const manifest of readdirSync(join(root, 'packages/marketing/modules'))) {
    const applied = spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'),
      'module', 'create', join(root, 'packages/marketing/modules', manifest), '--apply', '--root', root], { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  }
  writeFileSync(join(root, 'packages/domains/generated/index.js'), `import { createMarketingDomain } from '../../marketing/src/index.js';
export const generatedDomains = [createMarketingDomain({proposalPolicies:[{name:'standard-proposal',version:1,label:'Standard',config:{allowedChannels:['email']}}]})];\n`);
  const context = await boot(root, join(root, 'marketing.sqlite'));
  t.after(() => context.close());
  return { root, ...context };
}

const recordPath = (module, id = '') => `/api/modules/${module}/records${id ? `/${encodeURIComponent(id)}` : ''}`;
const action = (client, module, id, name, input) => client.request(`${recordPath(module, id)}/actions/${name}`, { method: 'POST', body: input });
const create = (client, module, value) => client.request(recordPath(module), { method: 'POST', body: value });

test('MK1 public journey: supplied counts to a complete proposal, human approval and immutable evidence', async t => {
  const { client, agentClient, app, root } = await fixture(t);
  const schema = await client.schema();
  assert.equal(schema.domains.marketing.marketingContract, 1);
  const definition = await create(agentClient, 'funnel-definition', { name: 'trial', label: 'Trial activation', stepsJson: '["Visit","Trial","Activated"]', version: 1 });
  const observed = await action(agentClient, 'funnel-definition', definition.id, 'observe', { counts: [100, 80, 20], source: 'Manually supplied monthly cohort' });
  assert.ok(observed.runId || observed.result?.runId, JSON.stringify(observed));
  const observation = observed.result ?? observed;
  const insight = await client.request(recordPath('funnel-drop-insight', observation.insightId));
  assert.equal(insight.dropRateBps, 7500);
  await assert.rejects(() => action(agentClient, 'funnel-drop-insight', insight.id, 'prepare-proposal', { draft: { ...DRAFT, status: 'approved' } }), error => error.status === 400);
  assert.equal(app.modules.get('campaign-proposal').service.list({ limit: 100 }).length, 0);
  const prepared = await action(agentClient, 'funnel-drop-insight', insight.id, 'prepare-proposal', { draft: { ...DRAFT, risksJson: '' } });
  const proposalId = (prepared.result ?? prepared).proposalId;
  const review = await action(agentClient, 'campaign-proposal', proposalId, 'propose', POLICY);
  assert.equal((review.result ?? review).refused, true);
  await action(agentClient, 'campaign-proposal', proposalId, 'revise', { draft: DRAFT });
  await action(agentClient, 'campaign-proposal', proposalId, 'propose', POLICY);
  await assert.rejects(() => action(agentClient, 'campaign-proposal', proposalId, 'approve', POLICY), error => error.code === 'HUMAN_APPROVAL_REQUIRED');
  const approved = await action(client, 'campaign-proposal', proposalId, 'approve', POLICY);
  const versionId = (approved.result ?? approved).versionId;
  const snapshot = await client.request(recordPath('campaign-version', versionId));
  assert.equal(snapshot.approvedBy, 'e2e');
  assert.equal(JSON.parse(snapshot.snapshotJson).contentPlanJson, DRAFT.contentPlanJson);
  for (const operation of ['propose', 'approve', 'revise']) {
    await assert.rejects(() => action(client, 'campaign-proposal', proposalId, operation, operation === 'revise' ? { draft: DRAFT } : POLICY), error => error.code === 'PROPOSAL_STATE_INVALID');
  }
  for (const module of ['funnel-run', 'funnel-drop-insight', 'campaign-proposal', 'campaign-version']) {
    await assert.rejects(() => create(client, module, {}), error => [404, 405].includes(error.status));
    await assert.rejects(() => client.request(recordPath(module, proposalId), { method: 'PATCH', body: {} }), error => [404, 405].includes(error.status));
  }
  await client.request(recordPath('funnel-definition', definition.id), { method: 'PATCH', body: { stepsJson: '["Changed","Different"]' } });
  const run = await client.request(recordPath('funnel-run', observation.runId));
  assert.deepEqual(JSON.parse(run.stepsJson), ['Visit', 'Trial', 'Activated']);
  assert.deepEqual(await client.request(recordPath('campaign-version', versionId)), snapshot);
  assert.equal(app.modules.get('campaign-version').service.listWhere({ proposalId }).length, 1);
  // Static composition stays opt-in. Removing it leaves previously generated records intact.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');
  const detached = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import {createAccordoApp} from './packages/app/src/index.js'; const app=createAccordoApp({dbPath:'marketing.sqlite'}); if(app.domains.metadata().marketing) process.exit(2); console.log(app.modules.get('campaign-version').service.get('${versionId}').id); app.close();`], { cwd: root, encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr + detached.stdout);
  assert.match(detached.stdout, new RegExp(versionId));
});

test('MK1 rolls every observation/proposal/approval write back on failure; retries leave one artifact', async t => {
  const { client, agentClient, app } = await fixture(t);
  const definition = await create(agentClient, 'funnel-definition', { name: 'trial', label: 'Trial', stepsJson: '["Visit","Trial"]', version: 1 });
  const events = [];
  const unsubscribe = app.events.subscribe('*', event => events.push(event));
  t.after(unsubscribe);
  async function failAfter(module, method, invoke) {
    const service = app.modules.get(module).service;
    const original = service[method];
    const before = app.audit.list({ limit: 500 }).length;
    const traceCount = app.workflows.listRuns({ limit: 100 }).length;
    const eventCount = events.length;
    service[method] = async function (...args) { await original.apply(this, args); throw new Error('injected after write'); };
    try { await assert.rejects(invoke, /injected after write/); }
    finally { service[method] = original; }
    assert.equal(app.audit.list({ limit: 500 }).length, before, 'failed transaction adds no business audit');
    assert.equal(events.length, eventCount, 'failed transaction dispatches no event');
    assert.equal(app.workflows.listRuns({ limit: 100 }).length, traceCount + 1, 'one failed action trace remains');
  }
  const observe = () => action(agentClient, 'funnel-definition', definition.id, 'observe', { counts: [100, 20], source: 'Test cohort' });
  for (const module of ['funnel-run', 'funnel-drop-insight']) {
    await failAfter(module, 'createManaged', observe);
    assert.equal(app.modules.get('funnel-run').service.list({ limit: 100 }).length, 0);
    assert.equal(app.modules.get('funnel-drop-insight').service.list({ limit: 100 }).length, 0);
  }
  const observation = (await observe()).result;
  const prepare = () => action(agentClient, 'funnel-drop-insight', observation.insightId, 'prepare-proposal', { draft: DRAFT });
  await failAfter('campaign-proposal', 'createManaged', prepare);
  await failAfter('funnel-drop-insight', 'applyManaged', prepare);
  const proposalId = (await prepare()).result.proposalId;
  await assert.rejects(prepare, error => error.code === 'INSIGHT_ALREADY_PROPOSED');
  await action(agentClient, 'campaign-proposal', proposalId, 'propose', POLICY);
  const approve = () => action(client, 'campaign-proposal', proposalId, 'approve', POLICY);
  await failAfter('campaign-version', 'createManaged', approve);
  await failAfter('campaign-proposal', 'applyManaged', approve);
  assert.equal(app.modules.get('campaign-version').service.listWhere({ proposalId }).length, 0);
  assert.equal(app.modules.get('campaign-proposal').service.get(proposalId).status, 'proposed');
  const before = app.audit.list({ limit: 500 }).length;
  const eventCount = events.length;
  await approve();
  assert.equal(app.modules.get('campaign-version').service.listWhere({ proposalId }).length, 1);
  assert.equal(app.audit.list({ limit: 500 }).length - before, 2);
  assert.equal(events.length - eventCount, 2);
  assert.ok(app.workflows.listRuns({ limit: 100 }).length > 0, 'the action journey leaves workflow traces');
});

test('two independent app connections racing approval create one immutable version', async t => {
  const { client, agentClient, app, root } = await fixture(t);
  const definition = await create(agentClient, 'funnel-definition', { name: 'race', label: 'Race', stepsJson: '["Visit","Trial"]', version: 1 });
  const observation = (await action(agentClient, 'funnel-definition', definition.id, 'observe', { counts: [100, 20], source: 'Race cohort' })).result;
  const proposalId = (await action(agentClient, 'funnel-drop-insight', observation.insightId, 'prepare-proposal', { draft: DRAFT })).result.proposalId;
  await action(agentClient, 'campaign-proposal', proposalId, 'propose', POLICY);
  const { spawn } = await import('node:child_process');
  const race = id => new Promise((resolve, reject) => {
    const source = `import {createAccordoApp} from './packages/app/src/index.js'; const app=createAccordoApp({dbPath:'marketing.sqlite'}); try { await app.runAction({module:'campaign-proposal',action:'approve',recordId:${JSON.stringify(proposalId)},input:${JSON.stringify(POLICY)},actor:{type:'user',id:${JSON.stringify(id)}}}); console.log('approved'); } catch(e) { console.log(e.code); } finally { app.close(); }`;
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { cwd: root });
    let output = ''; let error = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
  });
  assert.deepEqual((await Promise.all([race('one'), race('two')])).sort(), ['PROPOSAL_STATE_INVALID', 'approved'].sort());
  assert.equal(app.modules.get('campaign-version').service.listWhere({ proposalId }).length, 1);
});
