import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * M16a end to end, against a real composed application.
 *
 * The shipped M16a suite tested the package's exported functions against hand
 * written module maps. That proves arithmetic and wording; it cannot prove that
 * `plan-renewal` writes nothing, that a key is idempotent, that a race has one
 * winner, that a rollback leaves no orphan, that a correctness read survives
 * past the page bound, or that the rows outlive the package. Those are claims
 * about a running application, so they are made against one here: the real CLI
 * builds the project, the real app composes the packages, and the real HTTP
 * routes carry the asks where the claim is about what a *client* sees.
 *
 * **What is deliberately not tested, and why.**
 *
 * - *Reads past the 500-row page bound on primary-key paths.* `termEvidence`,
 *   `service.get` and every `sourceKey` lookup are exact single-row reads with
 *   no page bound to exceed, so seeding 500 rows in front of them tests the
 *   fixture and nothing else. The bound is proven where correctness genuinely
 *   depends on a *collection* query — the baseline, the `decisionId` check and
 *   the pending-follow-up guard — and nowhere else. **N/A, by reason.**
 * - *FX, totals and revenue arithmetic.* There is none to test: the package
 *   computes no cross-currency or cross-recurrence total, by design.
 * - *A scheduler firing on a boundary.* Nothing fires; the plan is asked for.
 *
 * Split (voce f268787b540c): the remaining cases live in
 * `lifecycle-renewal-operations-e2e-1/2/3.test.js`, at most four cases per
 * file so each stays under the 600 s per-file ceiling under load. Same cases,
 * same assertions — only the file layout changed (pinned by
 * `tests/lifecycle-renewal-shards.test.js`).
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

test('a lost response can be retried: the identical ask replays, a different one is refused by field', async (t) => {
  const { root, context } = await setup(t, 'idempotency.sqlite');
  const { app, client } = context;
  const { contract } = await activatedContract(root, app, { name: 'Idempotent Deal' });
  const ask = { decision: 'pursue_renewal', reason: 'they are happy', asOf: '2027-08-01' };
  const post = (module, action, recordId, input) =>
    client.request(`/api/modules/${module}/records/${recordId}/actions/${action}`, { method: 'POST', body: input });

  // Over the real route, because the defect is a client's: the response is lost
  // in transit and the client retries what it believes never happened.
  const first = await post('commercial-contract', 'record-renewal-decision', contract.id, ask);
  assert.equal(first.result.sourceKey, `renewal-decision:${contract.id}:2027-08-01`,
    'the key is (contract, calendar date) — derived from the ask, never from the clock');

  // Regression: this used to be a bare 409. The record existed, the client
  // could not reach it, and nothing in the response said which record it was.
  const retry = await post('commercial-contract', 'record-renewal-decision', contract.id, ask);
  assert.equal(retry.result.id, first.result.id, 'the retry returns the record it already created');
  assert.deepEqual(retry.result, first.result, 'and returns it unchanged, byte for byte');
  const third = await post('commercial-contract', 'record-renewal-decision', contract.id, ask);
  assert.equal(third.result.id, first.result.id, 'a retry is safe however many times it happens');

  // A DIFFERENT decision behind the SAME identity is refused rather than
  // adopted, and the refusal NAMES the fields instead of making the caller diff
  // two records to find out what it collided with.
  await assert.rejects(
    () => post('commercial-contract', 'record-renewal-decision', contract.id,
      { ...ask, decision: 'not_renewing', reason: 'changed my mind' }),
    (error) => error.status === 409 && error.code === 'RENEWAL_DECISION_CONFLICT'
      && error.details.conflictingFields.join() === 'decision,reason'
      && error.details.existingId === first.result.id,
  );
  // Only the reason differs: only the reason is named.
  await assert.rejects(
    () => post('commercial-contract', 'record-renewal-decision', contract.id, { ...ask, reason: 'a different why' }),
    (error) => error.details.conflictingFields.join() === 'reason',
  );

  const rows = app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id, asOfDate: '2027-08-01' });
  assert.equal(rows.length, 1, 'three identical asks and two divergent ones produced exactly one row');
  assert.equal(rows[0].decision, 'pursue_renewal', 'the first decision stands');

  // A genuinely different day is a genuinely different decision, never collapsed.
  const later = await post('commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'needs_changes', reason: 'the price has to move', asOf: '2027-08-02' });
  assert.notEqual(later.result.id, first.result.id);
  assert.equal(app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id }).length, 2);
});

