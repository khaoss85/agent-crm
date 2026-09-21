import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  IDENTITY_CONFLICT_DETECTOR,
  IDENTITY_CONFLICT_SCOPE_KIND,
  IDENTITY_CONFLICT_WINDOW,
  detectIdentityConflicts,
} from '../packages/customer-data/src/conflicts.js';
import { resolvedNames, subjectKey, trusted } from '../packages/customer-data/src/store.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **Customer Data Operations v2 — the indexed/windowed identity-conflict
 * detector (backlog:48de928b2dfa, TASKS.md:45).**
 *
 * v1 found `conflicting_external_identity` with a correctness-first
 * whole-table read: every active identity row in memory, grouped by source
 * key. v2 must find the same conflicts without that read. The contract, from
 * the approved backlog item:
 *
 * 1. v2 finds the conflicts v1's whole-table read finds, on a dataset where
 *    both are run;
 * 2. the read is indexed or windowed and the bound is declared, not
 *    discovered under load;
 * 3. a conflict the windowed read cannot see is reported as out of window
 *    rather than as absent;
 * 4. the v1 behaviour is retired only after this comparison is recorded —
 *    this file is that record.
 *
 * The v1 reference below is the retired whole-table grouping, frozen as the
 * oracle. Conflicting rows are written directly because the import path
 * cannot create them — they stand for what v1's own comment names: a
 * restore, a migration or a second writer.
 */

const ACTOR = { type: 'user', id: 'conflicts' };

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

/** The retired v1 grouping, frozen as the equivalence oracle. */
async function wholeTableConflicts(app) {
  const names = resolvedNames();
  const identities = await trusted(app.modules, names.identity).listWhere({ status: 'active' });
  const bySourceKey = new Map();
  const conflicts = [];
  for (const row of identities) {
    const key = row.sourceKey;
    const seen = bySourceKey.get(key);
    if (seen && subjectKey({ resource: seen.subjectResource, id: seen.subjectId })
      !== subjectKey({ resource: row.subjectResource, id: row.subjectId })) {
      conflicts.push(`${key} ${subjectKey({ resource: row.subjectResource, id: row.subjectId })}`);
      continue;
    }
    bySourceKey.set(key, row);
  }
  return conflicts.sort();
}

function flatten(report) {
  return report.conflicts.flatMap((conflict) => conflict.others.map((other) =>
    `${conflict.sourceKey} ${subjectKey({ resource: other.resource, id: other.id })}`)).sort();
}

/**
 * Relax the scaffolded UNIQUE constraint on `source_key`, standing for
 * exactly the states v1's own comment names — a restore, a migration or a
 * second writer whose table does not carry the constraint. The table is
 * rebuilt from its own DDL with that one keyword removed, rows and remaining
 * indexes preserved, so the detectors run against the state they exist for.
 */
function relaxSourceKeyUniqueness(db) {
  const before = db.prepare("SELECT COUNT(*) AS n FROM external_identities WHERE status = 'active'").get().n;
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_identities'").get().sql;
  assert.match(ddl, /UNIQUE/, 'the scaffolded table carries the UNIQUE constraint the conflict state bypasses');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'external_identities' AND sql IS NOT NULL").all()
    .map((row) => row.sql);
  db.exec('ALTER TABLE external_identities RENAME TO external_identities_constrained');
  db.exec(ddl.replace('UNIQUE', ''));
  db.exec('INSERT INTO external_identities SELECT * FROM external_identities_constrained');
  db.exec('DROP TABLE external_identities_constrained');
  for (const sql of indexes) db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM external_identities WHERE status = 'active'").get().n, before,
    'relaxing the constraint must preserve every row');
}

/** Clone one stored identity row under a new id, standing for a second writer. */
function cloneIdentityRow(db, externalId, mutate) {
  const template = db.prepare('SELECT * FROM external_identities WHERE external_id = ?').get(externalId);
  assert.ok(template, `identity ${externalId} must exist to clone`);
  const keys = Object.keys(template);
  const row = { ...template };
  mutate(row);
  db.prepare(`INSERT INTO external_identities (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((key) => row[key]));
  return row;
}

function subjectIdOf(db, externalId) {
  return db.prepare('SELECT subject_id FROM external_identities WHERE external_id = ?').get(externalId).subject_id;
}

test('v2 finds the conflicts v1 finds, on a dataset where both are run', async (t) => {
  const { app } = await scene(t, 'identity-conflicts-equivalence');
  const db = app.database.raw;

  await app.applyCustomerImport({
    actor: ACTOR,
    system: 'crm',
    rows: [
      { externalId: 'KEY-1', companyName: 'Acme Ltd', domain: 'acme.example' },
      { externalId: 'KEY-2', companyName: 'Globex Inc', domain: 'globex.example' },
      { externalId: 'KEY-3', companyName: 'Initech LLC', domain: 'initech.example' },
    ],
  });
  const acme = subjectIdOf(db, 'KEY-1');
  const globex = subjectIdOf(db, 'KEY-2');
  const initech = subjectIdOf(db, 'KEY-3');

  // Two conflicting keys, each active against two different records, plus a
  // same-subject duplicate row v1 deliberately does not flag.
  relaxSourceKeyUniqueness(db);
  // Explicit older timestamps: the per-key read orders newest-first, so the
  // originals deterministically set the baseline and each double is flagged,
  // exactly as v1 saw them.
  const older = (second) => `2020-02-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  cloneIdentityRow(db, 'KEY-1', (row) => {
    row.id = 'dup-key-1-other-subject';
    row.subject_id = globex;
    row.created_at = older(1);
    row.updated_at = older(1);
  });
  cloneIdentityRow(db, 'KEY-2', (row) => {
    row.id = 'dup-key-2-other-subject';
    row.subject_id = initech;
    row.created_at = older(2);
    row.updated_at = older(2);
  });
  cloneIdentityRow(db, 'KEY-1', (row) => {
    row.id = 'dup-key-1-same-subject';
    row.subject_id = acme;
    row.created_at = older(3);
    row.updated_at = older(3);
  });

  const names = resolvedNames();
  const report = await detectIdentityConflicts({
    identityService: trusted(app.modules, names.identity),
  });

  assert.equal(report.detector, IDENTITY_CONFLICT_DETECTOR);
  assert.equal(report.coverage.mode, 'complete', 'a table that fits the window is covered completely');
  assert.equal(report.coverage.outOfWindow, false);
  assert.deepEqual(flatten(report), await wholeTableConflicts(app),
    'v2 reports exactly the conflict set of the v1 whole-table read');
  assert.deepEqual(flatten(report), ['crm:KEY-1 company:' + globex, 'crm:KEY-2 company:' + initech].sort(),
    'each conflicting key is reported once, against the non-first record, like v1');
});

test('the window bound is declared, and an explicit window is honoured', async (t) => {
  const { app } = await scene(t, 'identity-conflicts-bound');
  const db = app.database.raw;

  assert.ok(Number.isInteger(IDENTITY_CONFLICT_WINDOW) && IDENTITY_CONFLICT_WINDOW >= 1
    && IDENTITY_CONFLICT_WINDOW <= 500,
    `the window is a declared constant inside the display-page bound, got ${IDENTITY_CONFLICT_WINDOW}`);

  await app.applyCustomerImport({
    actor: ACTOR,
    system: 'crm',
    rows: [
      { externalId: 'W-1', companyName: 'Acme Ltd', domain: 'acme.example' },
      { externalId: 'W-2', companyName: 'Globex Inc', domain: 'globex.example' },
      { externalId: 'W-3', companyName: 'Initech LLC', domain: 'initech.example' },
    ],
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM external_identities WHERE status = 'active'").get().n, 3);

  const names = resolvedNames();
  const report = await detectIdentityConflicts({
    identityService: trusted(app.modules, names.identity),
    windowSize: 2,
  });
  assert.equal(report.coverage.windowSize, 2);
  assert.ok(report.coverage.examinedActive <= 2, 'no more than one window is ever read');
  assert.equal(report.coverage.mode, 'windowed', 'three active rows do not fit a window of two');
  assert.equal(report.coverage.outOfWindow, true);
});

test('a conflict outside the window is out of window, never absent', async (t) => {
  const { app } = await scene(t, 'identity-conflicts-windowed');
  const db = app.database.raw;

  await app.applyCustomerImport({
    actor: ACTOR,
    system: 'crm',
    rows: [
      { externalId: 'OLD-1', companyName: 'Acme Ltd', domain: 'acme.example' },
      { externalId: 'OLD-2', companyName: 'Globex Inc', domain: 'globex.example' },
      { externalId: 'NEW-1', companyName: 'Initech LLC', domain: 'initech.example' },
      { externalId: 'NEW-2', companyName: 'Umbrella Co', domain: 'umbrella.example' },
    ],
  });
  const acme = subjectIdOf(db, 'OLD-1');
  const globex = subjectIdOf(db, 'OLD-2');
  const initech = subjectIdOf(db, 'NEW-1');
  const umbrella = subjectIdOf(db, 'NEW-2');

  // The old conflict ages out of the window; the new one stays inside it.
  relaxSourceKeyUniqueness(db);
  cloneIdentityRow(db, 'OLD-1', (row) => {
    row.id = 'dup-old-1';
    row.subject_id = globex;
    row.created_at = '2020-01-01T00:00:00.000Z';
    row.updated_at = '2020-01-01T00:00:00.000Z';
  });
  db.prepare('UPDATE external_identities SET created_at = ?, updated_at = ? WHERE external_id IN (?, ?)')
    .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'OLD-1', 'OLD-2');
  // Older than the original it doubles, but still inside the window: the
  // newest-first read meets the original first and flags this row.
  cloneIdentityRow(db, 'NEW-1', (row) => {
    row.id = 'dup-new-1';
    row.subject_id = umbrella;
    row.created_at = new Date(Date.now() - 3600000).toISOString();
    row.updated_at = new Date(Date.now() - 3600000).toISOString();
  });
  assert.ok(acme && globex && initech && umbrella);

  const names = resolvedNames();
  const report = await detectIdentityConflicts({
    identityService: trusted(app.modules, names.identity),
    windowSize: 3,
  });

  assert.equal(report.coverage.mode, 'windowed');
  assert.equal(report.coverage.outOfWindow, true);
  assert.deepEqual(flatten(report), [`crm:NEW-1 company:${umbrella}`],
    'the in-window conflict is found');
  assert.ok(!flatten(report).some((entry) => entry.startsWith('crm:OLD-1')),
    'the out-of-window conflict is not reported — and the windowed coverage above is what says so, not an all-clear');
});

test('the production findings path records v1-identical conflicts plus the window scope', async (t) => {
  const { app } = await scene(t, 'identity-conflicts-findings');
  const db = app.database.raw;

  await app.applyCustomerImport({
    actor: ACTOR,
    system: 'crm',
    rows: [{ externalId: 'FRESH-1', companyName: 'Acme Ltd', domain: 'acme.example' }],
  });
  const acme = subjectIdOf(db, 'FRESH-1');
  const other = await app.services.companies.create({ name: 'Other Inc', domain: 'other.example' }, { actor: ACTOR });
  relaxSourceKeyUniqueness(db);
  cloneIdentityRow(db, 'FRESH-1', (row) => {
    row.id = 'dup-fresh-1';
    row.subject_id = other.id;
    row.created_at = new Date(Date.now() - 3600000).toISOString();
    row.updated_at = new Date(Date.now() - 3600000).toISOString();
  });

  // Push the table past the declared window with older filler rows, so the
  // production default window reads windowed coverage.
  const template = db.prepare('SELECT * FROM external_identities WHERE external_id = ?').get('FRESH-1');
  const keys = Object.keys(template);
  const insert = db.prepare(`INSERT INTO external_identities (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  for (let i = 0; i < IDENTITY_CONFLICT_WINDOW; i += 1) {
    insert.run(...keys.map((key) => {
      if (key === 'id') return `filler-${i}`;
      if (key === 'source_key') return `crm:filler-${i}`;
      if (key === 'external_id') return `filler-${i}`;
      if (key === 'subject_id') return `filler-company-${i}`;
      if (key === 'created_at' || key === 'updated_at') return '2020-06-01T00:00:00.000Z';
      return template[key];
    }));
  }
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM external_identities WHERE status = 'active'").get().n
    > IDENTITY_CONFLICT_WINDOW);
  assert.ok(acme);

  await app.applyCustomerImport({
    actor: ACTOR,
    system: 'crm',
    rows: [{ externalId: 'TRIGGER-1', email: 'trigger@example.com' }],
  });

  const issues = db.prepare('SELECT kind, evidence, detector FROM data_quality_issues').all();
  const conflicts = issues.filter((issue) => issue.kind === 'conflicting_external_identity');
  assert.equal(conflicts.length, 1, 'the in-window conflict is recorded');
  assert.equal(conflicts[0].evidence, 'external identity crm:FRESH-1 is active against more than one record',
    'byte-identical to the v1 evidence');
  assert.equal(conflicts[0].detector, IDENTITY_CONFLICT_DETECTOR);

  const scope = issues.filter((issue) => issue.kind === IDENTITY_CONFLICT_SCOPE_KIND);
  assert.equal(scope.length, 1, 'windowed coverage is recorded as out-of-window scope, not as absence');
  assert.match(scope[0].evidence, /out of scope here, not absent/);
  assert.match(scope[0].evidence, new RegExp(`window ${IDENTITY_CONFLICT_WINDOW}`));
});
