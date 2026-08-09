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

