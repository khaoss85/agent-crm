import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Lifecycle-renewal operations e2e, fourth shard (voce f268787b540c): split
 * out of `tests/lifecycle-renewal-operations-e2e.test.js` so each file stays
 * under the per-file ceiling (`MEASURE_FILE_MAX_SEC`, 600 s) even with the
 * server loaded. Same cases, same assertions — only the file layout changed.
 */

const ACTOR = { type: 'user', id: 'e2e' };

const setup = async (t, file, options = {}) => {
  const root = project(t, { withLifecycle: true, ...options });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
};

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

test('every correctness read is exact past the 500-row page bound', async (t) => {
  const { root, context } = await setup(t, 'scale.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Scale Deal' });
  const actor = ACTOR;

  // (1) The baseline decides what is persisted on the handoff, so it must see
  //     every line, not the first page of them.
  const lines = app.modules.get('contract-line').service;
  const version = app.modules.get('contract-version').service.listWhere({ contractId: contract.id })[0];
  const seeded = lines.listWhere({ contractId: contract.id }).length;
  for (let index = seeded; index < 620; index += 1) {
    await lines.createManaged({
      sourceKey: `scale:line:${index}`, contractId: contract.id, contractVersionId: version.id,
      label: `Seeded ${index}`, componentKey: `seed-${index}`, chargeType: 'recurring', pricingModel: 'flat_fee',
      interval: 'month', intervalCount: 1, quantity: 1, netAmountCents: 100, currency: 'EUR',
      commercialActivation: 'subscription', position: 1000 + index,
    }, { actor });
  }
  const allLines = lines.listWhere({ contractId: contract.id });
  assert.ok(allLines.length > 500, 'the fixture is genuinely past the bound');
  assert.equal(lines.list({ limit: 500 }).length, 500, 'the paged list is a display bound, and stays one');
  const plan = await run(app, 'commercial-contract', 'plan-renewal', contract.id, { asOf: '2027-08-01' });
  assert.equal(plan.result.baseline.contractLineCount, allLines.length);
  const monthly = plan.result.baseline.groups.find((group) => group.interval === 'month');
  assert.equal(monthly.netAmountCents, allLines
    .filter((line) => line.currency === 'EUR' && line.chargeType === 'recurring' && line.interval === 'month')
    .reduce((sum, line) => sum + line.netAmountCents, 0), 'the total is over every line, exactly');

  // (2) The decisionId check authorizes a link, so a legitimate decision beyond
  //     the page bound must still be citable.
  const decisions = app.modules.get('renewal-decision').service;
  for (let index = 0; index < 610; index += 1) {
    await decisions.createManaged({
      sourceKey: `scale:decision:${index}`, contractId: contract.id, decision: 'undecided',
      reason: `seed ${index}`, asOfDate: '2027-01-01', termEndDate: '2027-08-31',
      termSource: 'post-signature-operational-activation', daysToBoundary: 242,
      decidedBy: 'seed', decidedAt: '2026-09-15T10:00:00.000Z',
    }, { actor });
  }
  const oldest = [...decisions.listWhere({ contractId: contract.id })]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  assert.equal(decisions.list({ limit: 500 }).some((row) => row.id === oldest.id), false,
    'the oldest decision is invisible to the paged list — which is exactly the trap');
  const cited = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'pricing_change', summary: 'cites an old decision', decisionId: oldest.id });
  assert.equal(cited.result.decisionId, oldest.id, 'and the exact read still finds it');

  // (3) The pending guard decides a 409, so an open follow-up buried under more
  //     than a page of resolved ones must still block a duplicate.
  const followups = app.modules.get('commercial-followup').service;
  for (let index = 0; index < 560; index += 1) {
    await followups.createManaged({
      sourceKey: `scale:followup:${index}`, contractId: contract.id, intent: 'scope_change',
      status: 'resolved_externally', summary: `seed ${index}`, requestedBy: 'seed',
      requestedAt: '2026-09-15T10:00:00.000Z', resolutionReason: 'seeded',
      resolvedBy: 'seed', resolvedAt: '2026-09-15T10:00:00.000Z',
    }, { actor });
  }
  await followups.createManaged({
    sourceKey: 'scale:followup:open', contractId: contract.id, intent: 'scope_change',
    status: 'pending_commercial_followup', summary: 'the buried open one',
    requestedBy: 'seed', requestedAt: '2026-09-15T10:00:00.000Z',
  }, { actor });
  await assert.rejects(
    () => run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
      { intent: 'scope_change', summary: 'would be a duplicate' }),
    (error) => error.code === 'FOLLOWUP_ALREADY_PENDING',
    'the guard sees past the page bound',
  );
});

test('the evidence is read-only through every generic surface, and writing needs a human', async (t) => {
  const { root, context } = await setup(t, 'boundary.sqlite');
  const { app, client, agentClient } = context;
  const { contract } = await activatedContract(root, app, { name: 'Boundary Deal' });
  const decision = (await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'seed', asOf: '2027-08-01' })).result;
  const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'seed' })).result;

  const refused = async (method, path, body) => {
    await assert.rejects(() => client.request(path, { method, body }), (error) => error.status === 404,
      `${method} ${path} must not be a route`);
  };
  for (const [module, id] of [['renewal-decision', decision.id], ['commercial-followup', followup.id]]) {
    // Readable…
    assert.ok((await client.request(`/api/modules/${module}/records`)).items.length > 0);
    assert.ok((await client.request(`/api/modules/${module}/records/${id}`)).id);
    // …and not writable, not even with an empty body.
    await refused('POST', `/api/modules/${module}/records`, {});
    await refused('POST', `/api/modules/${module}/records`, { contractId: 'forged', status: 'withdrawn' });
    await refused('PATCH', `/api/modules/${module}/records/${id}`, {});
    await refused('PATCH', `/api/modules/${module}/records/${id}`, { status: 'withdrawn', decision: 'not_renewing' });
    await refused('DELETE', `/api/modules/${module}/records/${id}`);
  }

  // Every writing action is a human decision, over the real route.
  for (const [module, action, recordId, input] of [
    ['commercial-contract', 'record-renewal-decision', contract.id, { decision: 'undecided', reason: 'bot', asOf: '2027-05-01' }],
    ['commercial-contract', 'request-commercial-followup', contract.id, { intent: 'contraction', summary: 'bot' }],
    ['commercial-followup', 'resolve-commercial-followup', followup.id, { outcome: 'withdrawn', reason: 'bot' }],
  ]) {
    await assert.rejects(
      () => agentClient.request(`/api/modules/${module}/records/${recordId}/actions/${action}`, { method: 'POST', body: input }),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
    );
  }
  assert.equal(app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id }).length, 1,
    'the agent wrote nothing while being refused');

  // AX1: the package, its one dependency and its actions are on the schema.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains.lifecycle.packageContract, 1);
  assert.deepEqual(schema.domains.lifecycle.requires,
    [
      { package: 'contracts', capability: 'contract-lifecycle-source', version: 2 },
      { package: 'contracts', capability: 'contracts-successor-activation', version: 1 },
    ]);
  assert.deepEqual(schema.domains.lifecycle.provides, [], 'this package consumes; it offers nothing');
  assert.deepEqual([...schema.domains.lifecycle.actions].sort(), [
    // M16b (ADR-035): the governed round and its execution.
    'amendment-run.abandon-amendment-run', 'amendment-run.attach-successor-order',
    'amendment-run.execute-amendment',
    'commercial-contract.open-amendment-run', 'commercial-contract.plan-amendment',
    // M16a: planning and intent evidence, unchanged.
    'commercial-contract.plan-renewal', 'commercial-contract.record-renewal-decision',
    'commercial-contract.request-commercial-followup', 'commercial-followup.resolve-commercial-followup',
  ], 'exactly the actions that exist — still no expansion-intent action, and the successor arrives as an executed agreement rather than a recorded link');
});

test('a retry after a restart still replays, over rows a previous process wrote', async (t) => {
  const root = project(t, { withLifecycle: true });
  const dbPath = join(root, 'data', 'restart.sqlite');
  const context = await boot(root, dbPath);
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Restart Deal' });
  const ask = { decision: 'pursue_renewal', reason: 'recorded before the restart', asOf: '2027-08-01' };
  const first = (await run(app, 'commercial-contract', 'record-renewal-decision', contract.id, ask)).result;
  const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'asked before the restart' })).result;
  await context.close();

  // A SEPARATE PROCESS, not a second boot in this one. Node caches ES modules
  // by URL, so an in-process reboot re-uses the composition already loaded and
  // proves nothing about a cold start over existing rows.
  const probe = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { createAccordoApp } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/app/src/index.js')).href)});
    const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)}, clock: () => '2026-12-01T09:00:00.000Z' });
    const actor = { type: 'user', id: 'e2e' };
    const decision = await app.runAction({
      module: 'commercial-contract', action: 'record-renewal-decision',
      recordId: ${JSON.stringify(contract.id)}, input: ${JSON.stringify(ask)}, actor,
    });
    const followup = await app.runAction({
      module: 'commercial-contract', action: 'request-commercial-followup',
      recordId: ${JSON.stringify(contract.id)}, input: { intent: 'renewal', summary: 'asked before the restart' }, actor,
    });
    let divergent = null;
    try {
      await app.runAction({
        module: 'commercial-contract', action: 'record-renewal-decision',
        recordId: ${JSON.stringify(contract.id)},
        input: { decision: 'not_renewing', reason: 'a different mind', asOf: '2027-08-01' }, actor,
      });
    } catch (error) { divergent = { code: error.code, status: error.status, fields: error.details?.conflictingFields }; }
    console.log(JSON.stringify({
      decisionId: decision.result.id,
      followupId: followup.result.id,
      groups: followup.result.baselineGroupsJson,
      decisions: app.modules.get('renewal-decision').service.listWhere({}).length,
      followups: app.modules.get('commercial-followup').service.listWhere({}).length,
      divergent,
    }));
    app.close();
  `], { encoding: 'utf8', cwd: root });
  assert.equal(probe.status, 0, probe.stderr);
  const cold = JSON.parse(probe.stdout.trim().split('\n').at(-1));

  // The clock moved and the process is new; the identity is neither, so both
  // retries answer with the rows the previous process wrote.
  assert.equal(cold.decisionId, first.id, 'the decision replays across a restart');
  assert.equal(cold.followupId, followup.id, 'and so does the open handoff');
  assert.equal(cold.groups, followup.baselineGroupsJson, 'with its money evidence intact');
  assert.equal(cold.decisions, 1, 'and nothing was duplicated');
  assert.equal(cold.followups, 1);
  // A divergent retry after a restart is still refused by field, not adopted.
  assert.deepEqual(cold.divergent, { code: 'RENEWAL_DECISION_CONFLICT', status: 409, fields: ['decision', 'reason'] });
});

test('the package detaches and reattaches, and its rows outlive it', async (t) => {
  const root = project(t, { withLifecycle: true });
  const dbPath = join(root, 'data', 'absence.sqlite');
  const composition = join(root, 'packages/domains/generated/index.js');
  const attached = readFileSync(composition, 'utf8');

  const context = await boot(root, dbPath);
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Absence Deal' });
  await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'recorded before the package was removed', asOf: '2027-08-01' });
  await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'also recorded before' });
  await context.close();

  // Each phase runs in ITS OWN process. Node caches ES modules by URL, so
  // re-booting in-process would re-use the composition already loaded and give
  // a false pass — a mistake this repository has made before.
  const inspect = () => {
    const probe = spawnSync(process.execPath, ['--no-warnings', '-e', `
      const { createAccordoApp } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/app/src/index.js')).href)});
      const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)}, clock: () => '2026-09-15T10:00:00.000Z' });
      const decisions = app.modules.get('renewal-decision').service.listWhere({});
      const followups = app.modules.get('commercial-followup').service.listWhere({});
      console.log(JSON.stringify({
        packages: [...app.domains.names()].sort(),
        lifecycleActions: app.domains.actions().map((a) => a.module + '.' + a.name).filter((n) => /renewal|followup/.test(n)).sort(),
        decisions: decisions.length,
        followups: followups.length,
        reason: decisions[0] ? decisions[0].reason : null,
        status: followups[0] ? followups[0].status : null,
      }));
      app.close();
    `], { encoding: 'utf8', cwd: root });
    assert.equal(probe.status, 0, probe.stderr);
    return JSON.parse(probe.stdout.trim().split('\n').at(-1));
  };

  // Removing the package is one line in the composition file.
  writeFileSync(composition, attached.split('\n')
    .filter((line) => !line.includes('createLifecyclePackage')).join('\n'));
  const detached = inspect();
  assert.deepEqual(detached.packages, ['commercial', 'contracts', 'signature'], 'the application boots without it');
  assert.deepEqual(detached.lifecycleActions, [], 'and its actions are gone with it');
  assert.equal(detached.decisions, 1, 'the rows it wrote are left alone, not deleted');
  assert.equal(detached.followups, 1);
  assert.equal(detached.reason, 'recorded before the package was removed', 'and are still readable');
  assert.equal(detached.status, 'pending_commercial_followup');

  // Putting the line back restores the surface over the same rows.
  writeFileSync(composition, attached);
  const reattached = inspect();
  assert.deepEqual(reattached.packages, ['commercial', 'contracts', 'lifecycle', 'signature']);
  assert.equal(reattached.lifecycleActions.length, 4);
  assert.equal(reattached.decisions, 1, 'the same row, not a new one');
  assert.equal(reattached.reason, 'recorded before the package was removed');
  assert.equal(reattached.status, 'pending_commercial_followup');
});
