import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Lifecycle-renewal operations e2e, third shard (voce f268787b540c): split
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

test('audit, events and trace are exact, and every event name is one M16a can honour', async (t) => {
  const { root, context } = await setup(t, 'evidence.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Evidence Deal' });

  const emitted = [];
  const original = app.events.emit.bind(app.events);
  app.events.emit = async (name, payload) => { emitted.push(name); return original(name, payload); };

  const countAudit = () => app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  const countRuns = () => app.database.raw.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get().n;
  const auditBefore = countAudit();
  const runsBefore = countRuns();

  const decision = (await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'worth keeping', asOf: '2027-08-01' })).result;
  const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'please requote', decisionId: decision.id })).result;
  await run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
    { outcome: 'resolved_externally', reason: 'handled by Commercial' });
  await run(app, 'commercial-contract', 'plan-renewal', contract.id, { asOf: '2027-08-01' });

  // Counts, not presence: three writes produce three audit rows and no more.
  assert.equal(countAudit() - auditBefore, 3);
  assert.equal(countRuns() - runsBefore, 4, 'four actions, four trace runs — the read is traced too');
  assert.deepEqual(emitted, ['renewal-decision.created', 'commercial-followup.created', 'commercial-followup.updated'],
    'the plan emits nothing at all');

  // The names M16a must never emit, because it does none of these things.
  for (const forbidden of ['contract.renewed', 'customer.churned', 'subscription.cancelled', 'invoice.created']) {
    assert.equal(emitted.includes(forbidden), false, `${forbidden} must never be emitted`);
  }
  const auditActions = app.database.raw
    .prepare("SELECT DISTINCT action FROM audit_events WHERE action LIKE 'renewal-decision%' OR action LIKE 'commercial-followup%'")
    .all().map((row) => row.action).sort();
  assert.deepEqual(auditActions, ['commercial-followup.created', 'commercial-followup.updated', 'renewal-decision.created']);
});

test('two application instances race one transition: one winner, and no raw SQLite error', async (t) => {
  const { root, context } = await setup(t, 'race.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Race Deal' });
  const second = await boot(root, join(root, 'data', 'race.sqlite'));
  t.after(() => second.close());

  const outcome = (results) => results.map((entry) => (entry.status === 'fulfilled'
    ? 'ok' : `${entry.reason.code}/${entry.reason.status}`));
  const noRawSqlite = (results) => results.every((entry) => entry.status === 'fulfilled'
    || !/SQLITE_|database is locked/i.test(String(entry.reason.message)));

  // Contradictory decisions behind one key, from two connections at once. They
  // disagree, so exactly one may win and the loser must be told which field it
  // collided on rather than handed a driver error.
  const decisions = await Promise.allSettled([
    run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
      { decision: 'pursue_renewal', reason: 'A says keep it', asOf: '2027-08-01' }),
    run(second.app, 'commercial-contract', 'record-renewal-decision', contract.id,
      { decision: 'not_renewing', reason: 'B says drop it', asOf: '2027-08-01' }),
  ]);
  assert.equal(outcome(decisions).filter((value) => value === 'ok').length, 1, 'exactly one winner');
  assert.ok(noRawSqlite(decisions), 'the loser gets a normalized conflict, never a driver error');
  assert.equal(app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id, asOfDate: '2027-08-01' }).length, 1);

  // Two connections sending the SAME ask is the retry case, not a conflict: one
  // row, and whoever succeeds names it. A duplicate delivery must never be
  // punished for arriving twice.
  const same = { decision: 'undecided', reason: 'both sides sent the same thing', asOf: '2027-09-01' };
  const twins = await Promise.allSettled([
    run(app, 'commercial-contract', 'record-renewal-decision', contract.id, same),
    run(second.app, 'commercial-contract', 'record-renewal-decision', contract.id, same),
  ]);
  assert.ok(noRawSqlite(twins));
  const rows = app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id, asOfDate: '2027-09-01' });
  assert.equal(rows.length, 1, 'one row, whichever connection got there first');
  for (const entry of twins.filter((value) => value.status === 'fulfilled')) {
    assert.equal(entry.value.result.id, rows[0].id, 'and every winner names that same row');
  }

  // The pending-follow-up guard is a read followed by a write; two instances
  // must not both pass it.
  const followups = await Promise.allSettled([
    run(app, 'commercial-contract', 'request-commercial-followup', contract.id, { intent: 'renewal', summary: 'from A' }),
    run(second.app, 'commercial-contract', 'request-commercial-followup', contract.id, { intent: 'renewal', summary: 'from B' }),
  ]);
  assert.equal(outcome(followups).filter((value) => value === 'ok').length, 1);
  assert.ok(noRawSqlite(followups));
  assert.equal(
    app.modules.get('commercial-followup').service
      .listWhere({ contractId: contract.id, intent: 'renewal', status: 'pending_commercial_followup' }).length,
    1, 'no lost update: one pending follow-up, not two',
  );

  // And the same for the terminal transition.
  const open = app.modules.get('commercial-followup').service
    .listWhere({ contractId: contract.id, intent: 'renewal', status: 'pending_commercial_followup' })[0];
  const resolves = await Promise.allSettled([
    run(app, 'commercial-followup', 'resolve-commercial-followup', open.id, { outcome: 'resolved_externally', reason: 'A closes it' }),
    run(second.app, 'commercial-followup', 'resolve-commercial-followup', open.id, { outcome: 'withdrawn', reason: 'B withdraws it' }),
  ]);
  assert.equal(outcome(resolves).filter((value) => value === 'ok').length, 1);
  assert.ok(noRawSqlite(resolves));
});

test('a failure after the write rolls everything back, and the retry produces exactly one result', async (t) => {
  const { root, context } = await setup(t, 'faults.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Fault Deal' });

  const decisions = app.modules.get('renewal-decision').service;
  const originalCreate = decisions.createManaged.bind(decisions);
  const auditBefore = app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;

  decisions.createManaged = async (patch, ctx) => {
    await originalCreate(patch, ctx);
    throw new Error('injected failure after the decision row was written');
  };
  await assert.rejects(() => run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'needs_changes', reason: 'the price has to move', asOf: '2027-08-01' }));
  decisions.createManaged = originalCreate;

  assert.equal(decisions.listWhere({ contractId: contract.id }).length, 0, 'no orphan row survives the rollback');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, auditBefore,
    'and no audit entry claims a write that did not happen');
  const failed = app.workflows.listRuns({ workflowName: 'commercial-contract.record-renewal-decision', limit: 5 })[0];
  assert.equal(failed.status, 'failed', 'the failed attempt is still traced honestly');

  const retry = await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'needs_changes', reason: 'the price has to move', asOf: '2027-08-01' });
  const rows = decisions.listWhere({ contractId: contract.id, asOfDate: '2027-08-01' });
  assert.equal(rows.length, 1, 'exactly one complete result, not two and not none');
  assert.equal(rows[0].id, retry.result.id);

  // The second write: the handoff. A failure after its row exists must leave
  // nothing behind, and the retry must produce the FIRST round again — not
  // round two over a row that was rolled back.
  const followups = app.modules.get('commercial-followup').service;
  const originalFollowupCreate = followups.createManaged.bind(followups);
  followups.createManaged = async (patch, ctx) => {
    await originalFollowupCreate(patch, ctx);
    throw new Error('injected failure after the follow-up row was written');
  };
  await assert.rejects(() => run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'expansion', summary: 'more seats please' }));
  followups.createManaged = originalFollowupCreate;
  assert.equal(followups.listWhere({ contractId: contract.id, intent: 'expansion' }).length, 0,
    'no orphan handoff survives the rollback');
  const reasked = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'expansion', summary: 'more seats please' });
  assert.equal(reasked.result.sourceKey, `commercial-followup:${contract.id}:expansion:1`,
    'the round number counts committed rounds, so a rolled-back attempt does not consume one');
  assert.equal(followups.listWhere({ contractId: contract.id, intent: 'expansion' }).length, 1);

  // The third write: the terminal transition.
  const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'contraction', summary: 'fewer seats' })).result;
  const originalApply = followups.applyManaged.bind(followups);
  followups.applyManaged = async (id, patch, ctx) => {
    await originalApply(id, patch, ctx);
    throw new Error('injected failure after the status was updated');
  };
  await assert.rejects(() => run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
    { outcome: 'withdrawn', reason: 'never mind' }));
  followups.applyManaged = originalApply;

  const rolledBack = followups.get(followup.id);
  assert.equal(rolledBack.status, 'pending_commercial_followup', 'the transition rolled back with everything else');
  assert.equal(rolledBack.resolutionReason, null, 'and left no half-written reason behind');
  const done = await run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
    { outcome: 'withdrawn', reason: 'never mind' });
  assert.equal(done.result.status, 'withdrawn');
});

