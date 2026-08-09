import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * M16a end to end, against a real composed application.
 *
 * The shipped M16a suite tested the package's exported functions against hand
 * written module maps. That proves arithmetic and wording; it cannot prove that
 * `plan-renewal` writes nothing, that a key is idempotent, that a race has one
 * winner, that a rollback leaves no orphan, that a correctness read survives
 * past the page bound, or that the rows outlive the package. Those are claims
 * about a running application, so they are made against one here.
 */

const ACTOR = { type: 'user', id: 'e2e' };
const AGENT = { type: 'agent', id: 'bot' };

const setup = async (t, file, options = {}) => {
  const root = project(t, { withLifecycle: true, ...options });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
};

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

/** Every table with its row count and a content digest. */
function snapshot(app) {
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  return Object.fromEntries(tables.map((table) => {
    const rows = app.database.raw.prepare(`SELECT * FROM "${table}"`).all();
    return [table, `${rows.length}|${rows.map((row) => JSON.stringify(row)).sort().join('')}`];
  }));
}

const changedTables = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((table) => before[table] !== after[table]).sort();

test('plan-renewal reads: it changes no table, and reports the boundary with its provenance', async (t) => {
  const { root, context } = await setup(t, 'plan.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Plan Deal' });

  const before = snapshot(app);
  const plan = await run(app, 'commercial-contract', 'plan-renewal', contract.id, { asOf: '2027-08-01' });
  const after = snapshot(app);

  // The ONLY tables that may move are the runtime's own trace, which is written
  // for every action, successful or not, outside the business transaction.
  assert.deepEqual(changedTables(before, after), ['trace_spans', 'workflow_runs'],
    'a read-only plan writes no business row anywhere — not a decision, not a follow-up, not an audit entry');
  const auditBefore = app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  await run(app, 'commercial-contract', 'plan-renewal', contract.id, { asOf: '2027-08-01' });
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, auditBefore,
    'and it records no audit event, however often it is asked');

  assert.equal(plan.result.writes, 'nothing — this is a read-only plan');
  // Inclusive end date: 2027-08-31 is live ON the 31st, so 2027-08-01 is 30 days out.
  assert.deepEqual(plan.result.boundary, { daysToBoundary: 30, category: 'within_window', endDateIsInclusive: true });
  assert.equal(plan.result.term.source, 'post-signature-operational-activation');
  assert.equal(plan.result.term.signed, false, 'an activation term is never presented as signed');
  assert.deepEqual(plan.result.evidenceGaps, []);
  // A baseline stays grouped: three kinds of money remain three numbers.
  assert.ok(plan.result.baseline.groups.length > 1);
  assert.equal(plan.result.baseline.groups.some((group) => 'total' in group), false);
  // A read commits nobody, so an agent may ask.
  const asAgent = await run(app, 'commercial-contract', 'plan-renewal', contract.id, { asOf: '2027-08-01' }, AGENT);
  assert.equal(asAgent.result.boundary.daysToBoundary, 30);
});

test('an impossible calendar date is refused rather than rolled over into evidence', async (t) => {
  const { root, context } = await setup(t, 'dates.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Date Deal' });

  // Regression: `asOf` was validated by shape alone, so `2027-02-30` passed and
  // JavaScript rolled it over to March 2. The record then stored an `asOfDate`
  // naming a day that never existed, beside a `daysToBoundary` measured from a
  // different one — a single row whose own two fields disagreed. M12 already
  // refuses exactly this for the term dates it validates.
  for (const asOf of ['2027-02-30', '2027-02-29', '2027-06-31', '2027-13-01', '2027-00-10', '2027-01-32']) {
    for (const action of ['plan-renewal', 'record-renewal-decision']) {
      const input = action === 'plan-renewal' ? { asOf } : { decision: 'undecided', reason: 'x', asOf };
      await assert.rejects(
        () => run(app, 'commercial-contract', action, contract.id, input),
        (error) => error.status === 400 && error.details?.field === 'asOf',
        `${action} must refuse ${asOf}`,
      );
    }
  }
  assert.equal(app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id }).length, 0,
    'and nothing was written while trying');

  // A leap day that really exists is still accepted.
  const leap = await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'undecided', reason: 'leap day is a real day', asOf: '2028-02-29' });
  assert.equal(leap.result.asOfDate, '2028-02-29');
});

test('a renewal decision is idempotent under a deterministic key, and a mismatch fails closed', async (t) => {
  const { root, context } = await setup(t, 'idempotency.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Idempotent Deal' });

  const first = await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'they are happy', asOf: '2027-08-01' });
  assert.equal(first.result.sourceKey, `renewal-decision:${contract.id}:2027-08-01`,
    'the key is derived from the contract and the date, not from the clock');

  const repeat = () => run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'they are happy', asOf: '2027-08-01' });
  await assert.rejects(repeat, (error) => error.status === 409);

  // A DIFFERENT decision behind the SAME key is refused rather than adopted:
  // somebody's recorded intent is never silently overwritten.
  await assert.rejects(
    () => run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
      { decision: 'not_renewing', reason: 'changed my mind', asOf: '2027-08-01' }),
    (error) => error.status === 409,
  );
  const rows = app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id, asOfDate: '2027-08-01' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'pursue_renewal', 'the first decision stands');
});

test('a follow-up key is a round number, so resolved work can come round again', async (t) => {
  const { root, context } = await setup(t, 'rounds.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Rounds Deal' });

  // Regression: the key used to embed `now()`. Under the injected clock every
  // test and every deterministic deployment runs at one instant, so round two
  // collided with round one and was refused 409 for all time — contradicting
  // this package's own documented rule. Under a wall clock the key changed on
  // every call instead, so it identified nothing and guarded nothing.
  const first = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'first ask' });
  assert.equal(first.result.sourceKey, `commercial-followup:${contract.id}:renewal:1`);
  assert.equal(first.result.status, 'pending_commercial_followup');

  // While it is open, the same intent is not duplicated.
  await assert.rejects(
    () => run(app, 'commercial-contract', 'request-commercial-followup', contract.id, { intent: 'renewal', summary: 'again' }),
    (error) => error.code === 'FOLLOWUP_ALREADY_PENDING' && error.status === 409,
  );
  // A different intent is a different ask, and is allowed alongside it.
  const expansion = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'expansion', summary: 'more seats' });
  assert.equal(expansion.result.sourceKey, `commercial-followup:${contract.id}:expansion:1`);

  await run(app, 'commercial-followup', 'resolve-commercial-followup', first.result.id,
    { outcome: 'resolved_externally', reason: 'quote issued elsewhere' });
  const second = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'it came round again' });
  assert.equal(second.result.sourceKey, `commercial-followup:${contract.id}:renewal:2`,
    'the round number advances; the clock is not consulted');
  assert.equal(second.result.status, 'pending_commercial_followup');
});

test('the follow-up state model is an explicit table: terminal never regresses', async (t) => {
  const { root, context } = await setup(t, 'states.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'States Deal' });

  for (const [intent, outcome] of [['renewal', 'resolved_externally'], ['expansion', 'withdrawn']]) {
    const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
      { intent, summary: `ask about ${intent}` })).result;
    const resolved = (await run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
      { outcome, reason: 'a human said why' })).result;
    assert.equal(resolved.status, outcome, 'both terminal states are reachable — no dead end');
    assert.equal(resolved.resolvedBy, 'e2e');
    assert.equal(resolved.resolutionReason, 'a human said why');

    // Contradictory input after the fact is refused with the state named, and
    // changes nothing: a terminal state never regresses, not even sideways.
    for (const contradiction of ['resolved_externally', 'withdrawn']) {
      await assert.rejects(
        () => run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
          { outcome: contradiction, reason: 'no' }),
        (error) => error.status === 409 && String(error.message).includes(outcome),
      );
    }
    const after = app.modules.get('commercial-followup').service.get(followup.id);
    assert.equal(after.status, outcome);
    assert.equal(after.resolutionReason, 'a human said why');
  }
});

test('an amount is recorded only with the recurrence that gives it meaning', async (t) => {
  const { root, context } = await setup(t, 'money.sqlite');
  const { app } = context;

  // A baseline that collapses to exactly one kind of money: the amount travels.
  const mono = await activatedContract(root, app, { name: 'Mono Deal', offers: ['fixture:offer:api-monthly'] });
  const single = (await run(app, 'commercial-contract', 'request-commercial-followup', mono.contract.id,
    { intent: 'renewal', summary: 'one kind of money' })).result;
  assert.equal(single.currency, 'EUR');
  assert.ok(Number.isSafeInteger(single.baselineNetAmountCents) && single.baselineNetAmountCents > 0);
  // Regression: the row used to carry a bare amount. "EUR 171.00" is not a
  // fact — monthly, annually and once are three different asks, and this row is
  // what Commercial reads.
  assert.equal(single.baselineChargeType, 'recurring');
  assert.equal(single.baselineInterval, 'month');

  // A mixed baseline: no amount at all, rather than a total that is not money.
  const mixed = await activatedContract(root, app, { name: 'Mixed Deal' });
  const many = (await run(app, 'commercial-contract', 'request-commercial-followup', mixed.contract.id,
    { intent: 'renewal', summary: 'several kinds of money' })).result;
  assert.equal(many.baselineNetAmountCents, null, 'no grand total across recurrences');
  assert.equal(many.baselineChargeType, null);
  assert.equal(many.baselineInterval, null);
  assert.equal(many.currency, 'EUR', 'a single shared currency is still honest to state');
});

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

  // Contradictory decisions behind one key, from two connections at once.
  const decisions = await Promise.allSettled([
    run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
      { decision: 'pursue_renewal', reason: 'A says keep it', asOf: '2027-08-01' }),
    run(second.app, 'commercial-contract', 'record-renewal-decision', contract.id,
      { decision: 'not_renewing', reason: 'B says drop it', asOf: '2027-08-01' }),
  ]);
  assert.equal(outcome(decisions).filter((value) => value === 'ok').length, 1, 'exactly one winner');
  assert.ok(noRawSqlite(decisions), 'the loser gets a normalized conflict, never a driver error');
  assert.equal(app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id, asOfDate: '2027-08-01' }).length, 1);

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

  // The same for the transition half of the milestone.
  const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'contraction', summary: 'fewer seats' })).result;
  const followups = app.modules.get('commercial-followup').service;
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
    [{ package: 'contracts', capability: 'contract-lifecycle-source', version: 1 }]);
  assert.deepEqual(schema.domains.lifecycle.provides, [], 'M16a consumes; it offers nothing yet');
  assert.deepEqual(schema.domains.lifecycle.actions, [
    'commercial-contract.plan-renewal', 'commercial-contract.record-renewal-decision',
    'commercial-contract.request-commercial-followup', 'commercial-followup.resolve-commercial-followup',
  ], 'exactly the four actions that exist — no expansion-intent action and no successor action');
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
  assert.deepEqual(detached.packages, ['contracts'], 'the application boots without it');
  assert.deepEqual(detached.lifecycleActions, [], 'and its actions are gone with it');
  assert.equal(detached.decisions, 1, 'the rows it wrote are left alone, not deleted');
  assert.equal(detached.followups, 1);
  assert.equal(detached.reason, 'recorded before the package was removed', 'and are still readable');
  assert.equal(detached.status, 'pending_commercial_followup');

  // Putting the line back restores the surface over the same rows.
  writeFileSync(composition, attached);
  const reattached = inspect();
  assert.deepEqual(reattached.packages, ['contracts', 'lifecycle']);
  assert.equal(reattached.lifecycleActions.length, 4);
  assert.equal(reattached.decisions, 1, 'the same row, not a new one');
  assert.equal(reattached.reason, 'recorded before the package was removed');
  assert.equal(reattached.status, 'pending_commercial_followup');
});
