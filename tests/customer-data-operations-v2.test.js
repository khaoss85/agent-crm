import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROWS, boot, project } from './helpers/customer-data-project.js';
import { bulkIdempotencyKeyFor } from '../packages/customer-data/src/bulk.js';
import { EXPORT_MAX_ROWS } from '../packages/customer-data/src/export.js';

/**
 * **Customer Data Operations v2 — bulk actions and export at scale
 * (TASKS.md:45).**
 *
 * The four claims the backlog item demands, each held by at least one test
 * below:
 *
 * 1. a bulk action reports, per record, whether it applied, and a partial
 *    result reads `partial` rather than success;
 * 2. an interrupted bulk can be resumed, a finished one replays without
 *    running twice, and nothing ever silently reapplies;
 * 3. an export states its row count and its bound, and a set larger than
 *    the bound refuses rather than returning a short file;
 * 4. the role boundary is held at the enumerated HTTP routes (covered in
 *    `spine-route-authorization.test.js`): bulk gates `records.write`,
 *    export gates `records.read`.
 */

const ACTOR = { type: 'user', id: 'ops2' };
const AGENT = { type: 'agent', id: 'bot' };

/** Everything in the database, hashed — the honest way to assert "wrote nothing". */
function fingerprintDatabase(app) {
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    for (const row of app.database.raw.prepare(`SELECT * FROM ${table}`).all()) {
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest('hex');
}

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message) };
  }
}

/** Governable findings: one invalid email, one row identifying nobody. */
async function openIssues(app) {
  await app.applyCustomerImport({
    system: 'ops2', rows: [ROWS.invalidEmail, ROWS.noIdentity], actor: ACTOR,
  });
  const issues = app.modules.get('data-quality-issue').service.listWhere({ status: 'open' });
  assert.equal(issues.length, 2);
  return issues;
}

/* -------------------------------------------------------------------- bulk */

test('a bulk governs many findings at once, with one receipt per record', async (t) => {
  const { app } = await scene(t, 'bulk-happy');
  const issues = await openIssues(app);

  const bulk = await app.applyBulkCustomerAction({
    action: 'govern-data-quality-issue',
    items: issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'accepted risk, reviewed' } })),
    actor: ACTOR,
  });

  assert.equal(bulk.mode, 'apply');
  assert.equal(bulk.replayed, false);
  assert.equal(bulk.status, 'completed');
  assert.deepEqual(bulk.counts, { items: 2, applied: 2, failed: 0 });
  assert.equal(bulk.receipts.length, 2, 'one receipt per input record, always');
  assert.ok(bulk.receipts.every((receipt) => receipt.outcome === 'applied' && receipt.code === 'APPLIED'));

  // The stored run and its receipts say the same thing as the summary.
  const run = app.modules.get('customer-bulk-run').service.get(bulk.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.appliedCount + run.failedCount, run.itemCount);
  const stored = app.modules.get('customer-bulk-item').service.listWhere({ runId: bulk.runId });
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.outcome === 'applied'));

  // And the decisions actually landed.
  assert.equal(app.modules.get('data-quality-issue').service.listWhere({ status: 'dismissed' }).length, 2);
});

test('one refusal stops nothing else, and the run reads partial rather than success', async (t) => {
  const { app } = await scene(t, 'bulk-partial');
  const issues = await openIssues(app);

  // The middle item names no record; the last one is already decided twice over.
  const bulk = await app.applyBulkCustomerAction({
    action: 'govern-data-quality-issue',
    items: [
      { recordId: issues[0].id, input: { decision: 'resolved', reason: 'fixed upstream' } },
      { recordId: 'no-such-issue', input: { decision: 'resolved', reason: 'fixed upstream' } },
      { recordId: issues[1].id, input: { decision: 'dismissed', reason: 'accepted risk' } },
    ],
    actor: ACTOR,
  });

  // A partial run is a result, not an error: the call succeeds and names the failures.
  assert.equal(bulk.status, 'partial');
  assert.deepEqual(bulk.counts, { items: 3, applied: 2, failed: 1 });
  assert.deepEqual(bulk.receipts.map((receipt) => receipt.outcome), ['applied', 'failed', 'applied']);
  assert.equal(bulk.receipts[1].code, 'NOT_FOUND');

  // The refusal rolled back nothing else: both real decisions landed.
  assert.equal(app.modules.get('data-quality-issue').service.get(issues[0].id).status, 'resolved');
  assert.equal(app.modules.get('data-quality-issue').service.get(issues[1].id).status, 'dismissed');

  const run = app.modules.get('customer-bulk-run').service.get(bulk.runId);
  assert.equal(run.status, 'partial', 'the stored run reads partial too, never completed');
});

test('malformed input is refused before a transaction opens', async (t) => {
  const { app } = await scene(t, 'bulk-refusals');
  await openIssues(app);
  const before = fingerprintDatabase(app);

  const cases = [
    [{ action: 'erase-everything', items: [{ recordId: 'x', input: {} }] }, 'BULK_UNKNOWN_ACTION'],
    [{ action: 'govern-data-quality-issue', items: [] }, 'BULK_REQUEST_INVALID'],
    [{ action: 'govern-data-quality-issue', items: [{ recordId: 'x', input: { decision: 'maybe', reason: 'r' } }] }, 'BULK_ITEM_INPUT_INVALID'],
    [{ action: 'govern-data-quality-issue', items: [{ recordId: 'x', input: { decision: 'resolved', reason: '   ' } }] }, 'BULK_ITEM_INPUT_INVALID'],
    [{ action: 'govern-data-quality-issue', items: [{ recordId: '', input: { decision: 'resolved', reason: 'r' } }] }, 'BULK_REQUEST_INVALID'],
  ];
  for (const [request, code] of cases) {
    const refused = await refusal(app.applyBulkCustomerAction({ ...request, actor: ACTOR }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, code);
  }
  // 501 items exceed the bound.
  const tooLarge = await refusal(app.applyBulkCustomerAction({
    action: 'govern-data-quality-issue',
    items: Array.from({ length: 501 }, (_, i) => ({ recordId: `issue-${i}`, input: { decision: 'resolved', reason: 'r' } })),
    actor: ACTOR,
  }));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'BULK_TOO_LARGE');

  assert.equal(fingerprintDatabase(app), before, 'a refused bulk writes nothing at all');
  assert.equal(app.modules.get('customer-bulk-run').service.listWhere({}).length, 0, 'not even a run row');
});

test('retrying a finished bulk replays the stored run and runs nothing twice', async (t) => {
  const { app } = await scene(t, 'bulk-replay');
  const issues = await openIssues(app);
  const items = issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'reviewed' } }));

  const first = await app.applyBulkCustomerAction({ action: 'govern-data-quality-issue', items, actor: ACTOR });
  assert.equal(first.replayed, false);

  const before = fingerprintDatabase(app);
  // Same items in a different order are the same bulk.
  const replay = await app.applyBulkCustomerAction({
    action: 'govern-data-quality-issue', items: [...items].reverse(), actor: ACTOR,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, first.runId, 'a retry returns the same run, not a second one');
  assert.equal(replay.status, first.status);
  assert.deepEqual(replay.counts, first.counts);
  // Receipts follow the retried order, not the original one: index 0 must
  // describe the caller's item 0. The per-record outcomes are the stored ones.
  const retried = [...items].reverse();
  assert.deepEqual(replay.receipts.map((receipt) => receipt.index), [0, 1]);
  assert.deepEqual(replay.receipts.map((receipt) => receipt.recordId), retried.map((item) => item.recordId));
  const firstByRecord = new Map(first.receipts.map((receipt) => [receipt.recordId, receipt.outcome]));
  assert.ok(replay.receipts.every((receipt) => firstByRecord.get(receipt.recordId) === receipt.outcome),
    'a replay reports the stored per-record outcomes');
  assert.equal(fingerprintDatabase(app), before, 'a replay writes nothing at all');
  assert.equal(app.modules.get('customer-bulk-run').service.listWhere({}).length, 1);
});

test('an interrupted run resumes: applied items report already-applied, the rest run', async (t) => {
  const { app } = await scene(t, 'bulk-resume');
  const issues = await openIssues(app);
  const action = 'govern-data-quality-issue';
  const items = issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'reviewed' } }));
  const idempotencyKey = bulkIdempotencyKeyFor({ action, items });

  // The crash as the database would show it: a run stuck in_progress with
  // the first item's applied receipt already stored.
  const runs = app.modules.get('customer-bulk-run').service;
  const receipts = app.modules.get('customer-bulk-item').service;
  const run = await runs.createManaged({
    sourceKey: `customer-bulk-run:${idempotencyKey}`,
    idempotencyKey,
    actionName: action,
    status: 'in_progress',
    itemCount: items.length,
    appliedCount: 0,
    failedCount: 0,
    actorType: 'user',
    actorId: 'ops2',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }, { actor: ACTOR });
  await app.runAction({
    module: 'data-quality-issue', action: 'govern-data-quality-issue', recordId: issues[0].id,
    input: { decision: 'dismissed', reason: 'reviewed' }, actor: ACTOR,
  });
  await receipts.createManaged({
    sourceKey: `customer-bulk-item:${run.id}:0`,
    runId: run.id,
    itemIndex: 0,
    recordModule: 'data-quality-issue',
    recordId: issues[0].id,
    outcome: 'applied',
    code: 'APPLIED',
    reason: `${action} applied`,
    decidedAt: new Date().toISOString(),
  }, { actor: ACTOR });

  const resumed = await app.applyBulkCustomerAction({ action, items, actor: ACTOR });

  assert.equal(resumed.replayed, false, 'a resumed run is continued work, not a replay');
  assert.equal(resumed.runId, run.id, 'the same run finishes');
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.counts, { items: 2, applied: 2, failed: 0 });
  assert.deepEqual(resumed.receipts.map((receipt) => receipt.outcome), ['already-applied', 'applied']);
  assert.equal(
    app.modules.get('customer-bulk-item').service.listWhere({ runId: run.id }).length, 2,
    'the resumed item wrote its receipt; the applied one kept its single receipt',
  );
  assert.equal(app.modules.get('data-quality-issue').service.listWhere({ status: 'dismissed' }).length, 2);
});

test('a resume with reordered items resumes the same records, never by position', async (t) => {
  const { app } = await scene(t, 'bulk-resume-reordered');
  const issues = await openIssues(app);
  const action = 'govern-data-quality-issue';
  const items = issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'reviewed' } }));
  const idempotencyKey = bulkIdempotencyKeyFor({ action, items });

  // The same crash as above: the run is stuck in_progress with the first
  // item's applied receipt already stored.
  const runs = app.modules.get('customer-bulk-run').service;
  const receipts = app.modules.get('customer-bulk-item').service;
  const run = await runs.createManaged({
    sourceKey: `customer-bulk-run:${idempotencyKey}`,
    idempotencyKey,
    actionName: action,
    status: 'in_progress',
    itemCount: items.length,
    appliedCount: 0,
    failedCount: 0,
    actorType: 'user',
    actorId: 'ops2',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }, { actor: ACTOR });
  await app.runAction({
    module: 'data-quality-issue', action: 'govern-data-quality-issue', recordId: issues[0].id,
    input: { decision: 'dismissed', reason: 'reviewed' }, actor: ACTOR,
  });
  await receipts.createManaged({
    sourceKey: `customer-bulk-item:${run.id}:0`,
    runId: run.id,
    itemIndex: 0,
    recordModule: 'data-quality-issue',
    recordId: issues[0].id,
    outcome: 'applied',
    code: 'APPLIED',
    reason: `${action} applied`,
    decidedAt: new Date().toISOString(),
  }, { actor: ACTOR });

  // The retry lists the same set of records in the opposite order. The key
  // is order-independent, so this is the same bulk — and the already-decided
  // record must be recognized by record, not re-applied by position.
  const reordered = [...items].reverse();
  const resumed = await app.applyBulkCustomerAction({ action, items: reordered, actor: ACTOR });

  assert.equal(resumed.replayed, false, 'a resumed run is continued work, not a replay');
  assert.equal(resumed.runId, run.id, 'the same run finishes');
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.counts, { items: 2, applied: 2, failed: 0 });
  assert.deepEqual(
    resumed.receipts.map((receipt) => [receipt.index, receipt.recordId, receipt.outcome]),
    [[0, issues[1].id, 'applied'], [1, issues[0].id, 'already-applied']],
    'receipts follow the retried order; the decided record is reported, not executed again',
  );
  assert.equal(
    app.modules.get('customer-bulk-item').service.listWhere({ runId: run.id }).length, 2,
    'the resumed item wrote its receipt; the applied one kept its single receipt',
  );
  assert.equal(app.modules.get('data-quality-issue').service.listWhere({ status: 'dismissed' }).length, 2);
});

test('a non-user actor gets one HUMAN_APPROVAL_REQUIRED receipt per item', async (t) => {
  const { app } = await scene(t, 'bulk-agent');
  const issues = await openIssues(app);

  const bulk = await app.applyBulkCustomerAction({
    action: 'govern-data-quality-issue',
    items: issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'agent triage' } })),
    actor: AGENT,
  });

  assert.equal(bulk.status, 'partial');
  assert.deepEqual(bulk.counts, { items: 2, applied: 0, failed: 2 });
  assert.ok(bulk.receipts.every((receipt) => receipt.outcome === 'failed' && receipt.code === 'HUMAN_APPROVAL_REQUIRED'),
    'the human boundary holds per record, not as one silent refusal for the batch');
  assert.equal(app.modules.get('data-quality-issue').service.listWhere({ status: 'open' }).length, 2,
    'and nothing was decided');
});

test('bulk applies the canonical link too: both records survive the decision', async (t) => {
  const { app } = await scene(t, 'bulk-link');
  const first = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  const second = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  await app.applyCustomerImport({
    system: 'crm-export', rows: [{ companyName: 'Globex Srl', domain: 'globex.example' }], actor: ACTOR,
  });
  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];
  assert.ok(candidate, 'the ambiguity became a candidate for a human');

  const bulk = await app.applyBulkCustomerAction({
    action: 'link-canonical-identity',
    items: [{ recordId: candidate.id, input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same legal entity' } }],
    actor: ACTOR,
  });

  assert.equal(bulk.status, 'completed');
  assert.equal(bulk.receipts[0].outcome, 'applied');
  assert.equal(app.services.companies.get(first.id).name, 'Globex Srl');
  assert.equal(app.services.companies.get(second.id).name, 'Globex Srl', 'the alias still resolves, untouched');
  assert.equal(app.modules.get('canonical-link').service.listWhere({}).length, 2);

  // Deciding the same candidate again is not a second decision: it is a
  // per-item refusal with the runtime's own code.
  const again = await app.applyBulkCustomerAction({
    action: 'link-canonical-identity',
    items: [{ recordId: candidate.id, input: { canonicalResource: 'company', canonicalId: first.id, reason: 'again' } }],
    actor: ACTOR,
  });
  assert.equal(again.status, 'partial');
  assert.equal(again.receipts[0].code, 'INVALID_STATE');
});

/* ------------------------------------------------------------------ export */

test('an export states its row count and its bound, and returns every row', async (t) => {
  const { app } = await scene(t, 'export-happy');
  await openIssues(app);

  const exported = await app.exportCustomerRecords({ resource: 'data-quality-issue' });

  assert.equal(exported.resource, 'data-quality-issue');
  assert.equal(exported.rowCount, 2);
  assert.equal(exported.bound, EXPORT_MAX_ROWS);
  assert.equal(exported.complete, true);
  assert.equal(exported.rows.length, exported.rowCount, 'the rows always equal the count stated');
  assert.ok(Object.isFrozen(exported.rows), 'the answer is frozen like every other operation result');
});

test('a set larger than the bound refuses rather than returning a short file', async (t) => {
  const { app } = await scene(t, 'export-truncate');
  await openIssues(app);

  const refusal = await app.exportCustomerRecords({ resource: 'data-quality-issue', bound: 1 })
    .then(() => null, (error) => error);
  assert.ok(refusal, 'the export must refuse');
  assert.equal(refusal.code, 'EXPORT_WOULD_TRUNCATE');
  assert.equal(refusal.status, 409);
  assert.deepEqual(refusal.details, { resource: 'data-quality-issue', rowCount: 2, bound: 1 });

  // The refusal names the bound that fits: asking for exactly it succeeds.
  const fitting = await app.exportCustomerRecords({ resource: 'data-quality-issue', bound: 2 });
  assert.equal(fitting.complete, true);
  assert.equal(fitting.rows.length, 2);
});

test('a larger bound than the server allows is refused, never clamped', async (t) => {
  const { app } = await scene(t, 'export-bound');
  for (const [request, code] of [
    [{ resource: 'data-quality-issue', bound: EXPORT_MAX_ROWS + 1 }, 'EXPORT_BOUND_EXCEEDS_MAX'],
    [{ resource: 'no-such-records' }, 'EXPORT_UNKNOWN_RESOURCE'],
    [{ resource: 'data-quality-issue', where: ['status'] }, 'EXPORT_FILTERS_INVALID'],
    [{ resource: 'data-quality-issue', bound: 0 }, 'EXPORT_BOUND_INVALID'],
  ]) {
    const refused = await refusal(app.exportCustomerRecords(request));
    assert.equal(refused.ok, false, `${code} must refuse`);
    assert.equal(refused.code, code);
  }
});

test('an export writes nothing and filters select exactly', async (t) => {
  const { app } = await scene(t, 'export-filters');
  const issues = await openIssues(app);
  await app.runAction({
    module: 'data-quality-issue', action: 'govern-data-quality-issue', recordId: issues[0].id,
    input: { decision: 'resolved', reason: 'fixed upstream' }, actor: ACTOR,
  });

  const before = fingerprintDatabase(app);
  const open = await app.exportCustomerRecords({ resource: 'data-quality-issue', where: { status: 'open' } });
  assert.equal(open.rowCount, 1);
  assert.equal(open.rows[0].id, issues[1].id);
  const all = await app.exportCustomerRecords({ resource: 'customer-bulk-item' });
  assert.equal(all.rowCount, 0, 'an empty set exports as zero rows, not as absent');
  assert.equal(fingerprintDatabase(app), before, 'an export writes nothing at all');
});

test('a run whose receipts do not reconcile is refused, never reported short', async (t) => {
  const { app } = await scene(t, 'bulk-reconcile');
  const issues = await openIssues(app);
  const items = issues.map((issue) => ({ recordId: issue.id, input: { decision: 'dismissed', reason: 'reviewed' } }));
  const first = await app.applyBulkCustomerAction({ action: 'govern-data-quality-issue', items, actor: ACTOR });
  assert.equal(first.status, 'completed');

  // Out-of-band corruption: a receipt row disappears behind the run's back.
  app.database.raw.prepare('DELETE FROM customer_bulk_items WHERE run_id = ? AND item_index = 0').run(first.runId);
  const refused = await refusal(app.applyBulkCustomerAction({ action: 'govern-data-quality-issue', items, actor: ACTOR }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'BULK_RECEIPTS_UNRECONCILED');
});

/* ------------------------------------------------- contract-2 graph (M3P) */

test('bulk and export ride the distinct contract-2 graph unchanged', async (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
  const customerData = await import('../packages/customer-data/src/index.js');

  const directory = mkdtempSync(join(tmpdir(), 'accordo-ops2-v2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const records = readdirSync(join(root, 'packages/customer-data/modules'))
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(root, 'packages/customer-data/modules', file), 'utf8'));
      return { name: manifest.name, manifest };
    });
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'packages.sqlite'),
    selected: {
      packageContract: 2,
      packages: [customerData.createCustomerDataPackageV2()],
      actions: [],
      modules: records,
    },
  });
  t.after(() => app.close());

  const actor = { type: 'user', id: 'ops2' };
  await app.operations.run('apply-customer-import', {
    system: 'v2', rows: [{ externalId: 'V-1', email: 'bad-email', firstName: 'B' }], actor,
  });
  const issues = await app.operations.run('export-customer-records', {
    resource: 'data-quality-issue', where: { status: 'open' },
  });
  assert.equal(issues.rowCount, 1);

  const bulk = await app.operations.run('apply-bulk-customer-action', {
    action: 'govern-data-quality-issue',
    items: [{ recordId: issues.rows[0].id, input: { decision: 'dismissed', reason: 'v2 triage' } }],
    actor,
  });
  assert.equal(bulk.status, 'completed');
  assert.equal(bulk.receipts[0].outcome, 'applied');
});

/* ----------------------------------------------------------------- contract */

test('the machine-readable contract now owns bulk and export, and defers neither', async (t) => {
  const { app } = await scene(t, 'contract');
  const meta = app.domains.metadata()['customer-data'];

  assert.ok(meta.bulk, 'bulk has a contract section');
  assert.deepEqual(meta.bulk.actions, ['link-canonical-identity', 'dismiss-duplicate-candidate', 'govern-data-quality-issue']);
  assert.equal(meta.bulk.maxItems, 500);
  assert.ok(meta.export, 'export has a contract section');
  assert.equal(meta.export.maxRows, EXPORT_MAX_ROWS);
  assert.ok(meta.export.resources.includes('customer-bulk-run'), 'the new records export too');
  assert.ok(!meta.deferred.items.includes('bulk actions'), 'bulk actions are no longer deferred');
  assert.ok(!meta.deferred.items.includes('export at scale'), 'export at scale is no longer deferred');
  assert.ok(meta.deferred.items.includes('physical merge or consolidation'), 'what is still refused stays deferred');
  assert.ok(meta.limitations.some((entry) => entry.startsWith('PARTIAL_IS_PARTIAL')), 'the partial guarantee is stated');
  assert.ok(meta.limitations.some((entry) => entry.startsWith('NO_SILENT_TRUNCATION')), 'the truncation guarantee is stated');
});
