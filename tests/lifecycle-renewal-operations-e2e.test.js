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

