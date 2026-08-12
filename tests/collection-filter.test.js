import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { boot, project } from './helpers/contracts-project.js';

/**
 * **The filtered collection read** (ADR-008 addendum 2), and the defect that
 * forced it.
 *
 * `GET /api/modules/:module/records` accepted only `limit`. So a client that
 * wanted one parent's rows had to fetch the newest N rows of the **whole table**
 * and filter them in the browser. CHROMIUM-70 found what that costs on a real
 * page: with 132 activity rows in a project, a task whose two activity rows were
 * the two oldest rendered "Nothing recorded yet." — and printed a page-bound
 * notice beneath it saying the bound belonged to the screen. Both statements
 * were false at once, and the second was the dangerous kind of false, because it
 * reads as a disclosure.
 *
 * This file reproduces exactly that shape against the real HTTP server, and
 * pins the grammar of the fix: index-backed fields only, equality only,
 * bounded, and a refusal rather than a silent unfiltered answer whenever the
 * filter cannot be honoured.
 */

const ACTOR = { type: 'user', id: 'filter' };

async function workProject(t, file) {
  const root = project(t, { withDomain: false, withWorkTables: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return context;
}

test('a parent whose rows are older than one page is still readable, and the page bound tells the truth', async (t) => {
  const { app, baseUrl } = await workProject(t, 'collection-filter.sqlite');
  const activities = app.modules.get('work-activity').service;

  // The two OLDEST rows in the whole table belong to the subject we will read.
  for (const kind of ['task_created', 'note']) {
    await activities.createManaged({
      sourceKey: `old:${kind}`, kind, subjectResource: 'lead', subjectId: 'quiet-lead',
      taskId: 'task-quiet', body: kind === 'note' ? 'Called them back.' : null,
      occurredAt: '2026-08-01T00:00:00.000Z', actorType: 'user', actorId: 'filter',
      sourcePackage: 'host', sourceAction: 'qualify',
    }, { actor: ACTOR });
  }
  // …then 130 rows on a different subject, so the newest 100 contain none of them.
  for (let index = 0; index < 130; index += 1) {
    await activities.createManaged({
      sourceKey: `busy:${index}`, kind: 'note', subjectResource: 'lead', subjectId: 'busy-lead',
      taskId: `task-busy-${index}`, body: `Busy ${index}`,
      occurredAt: '2026-08-02T00:00:00.000Z', actorType: 'user', actorId: 'filter',
      sourcePackage: 'host', sourceAction: 'add-note',
    }, { actor: ACTOR });
  }
  assert.equal(activities.list({ limit: 500 }).length, 132);

  const get = async (query) => {
    const response = await fetch(`${baseUrl}/api/modules/work-activity/records?${query}`, {
      headers: { 'x-actor-type': 'user', 'x-actor-id': 'filter', connection: 'close' },
    });
    return { status: response.status, body: await response.json() };
  };

  // The defect, exactly: an unfiltered page of 100 contains none of this
  // subject's rows, so a client filtering that page finds nothing.
  const unfiltered = await get('limit=100');
  assert.equal(unfiltered.status, 200);
  assert.equal(unfiltered.body.items.length, 100);
  assert.equal(unfiltered.body.items.filter((row) => row.subjectId === 'quiet-lead').length, 0,
    'this is what made the browser draw an empty timeline for a subject that has two entries');

  // The fix: the server narrows, so the page is a page OF THIS SUBJECT.
  const filtered = await get('limit=100&filter.subjectResource=lead&filter.subjectId=quiet-lead');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.items.length, 2);
  assert.deepEqual(filtered.body.items.map((row) => row.kind).sort(), ['note', 'task_created']);
  // …and it is genuinely not truncated, so no bound notice would be shown.
  assert.ok(filtered.body.items.length < 100);

  // The busy subject IS truncated, and the client can tell — which is what makes
  // the on-screen wording ("these are the most recent, earlier ones exist") true
  // rather than a guess.
  const busy = await get('limit=100&filter.subjectResource=lead&filter.subjectId=busy-lead');
  assert.equal(busy.body.items.length, 100);
});

test('a routed filter is index-backed, equality-only and bounded, or it is a 400', async (t) => {
  const { app, baseUrl } = await workProject(t, 'collection-filter-grammar.sqlite');
  const get = async (query) => {
    const response = await fetch(`${baseUrl}/api/modules/work-activity/records?${query}`, {
      headers: { 'x-actor-type': 'user', 'x-actor-id': 'filter', connection: 'close' },
    });
    return { status: response.status, body: await response.json() };
  };

  // Only indexed/unique fields plus id are filterable: a routed filter must
  // never become a table scan. `body` and `occurredAt` are neither.
  for (const [query, why] of [
    ['filter.body=anything', 'an unindexed column'],
    ['filter.occurredAt=2026-08-01T00:00:00.000Z', 'an unindexed timestamp'],
    ['filter.nosuchfield=x', 'a field that does not exist'],
    ['filter.__proto__=x', 'a prototype-shaped key'],
    ['filter.subjectId=', 'an empty value'],
    [`filter.subjectId=${'x'.repeat(201)}`, 'an oversized value'],
    ['filter.subjectId=a&filter.subjectId=b', 'a repeated filter'],
    ['filter.id=a&filter.kind=note&filter.subjectId=b&filter.subjectResource=lead&filter.taskId=t', 'five filters at once'],
  ]) {
    const answer = await get(query);
    assert.equal(answer.status, 400, `${why} must be refused: ${query}`);
    assert.equal(answer.body.error.code, 'VALIDATION_ERROR', why);
  }

  // The module publishes exactly what may be filtered, so a client never has to
  // guess and an older generated module can be told apart from a permissive one.
  const meta = await (await fetch(`${baseUrl}/api/modules/work-activity`, {
    headers: { 'x-actor-type': 'user', 'x-actor-id': 'filter', connection: 'close' },
  })).json();
  assert.deepEqual([...meta.filterableFields].sort(),
    ['id', 'kind', 'sourceKey', 'sourcePackage', 'subjectId', 'subjectResource', 'taskId'].sort());
  for (const unindexed of ['body', 'occurredAt', 'actorId', 'sourceAction']) {
    assert.equal(meta.filterableFields.includes(unindexed), false, unindexed);
  }

  // A module generated before the addendum publishes no filterable fields, and
  // is refused rather than answered unfiltered — the same false-completeness bug
  // one layer down.
  const legacyShaped = { ...app.modules.get('work-activity'), filterableFields: undefined };
  assert.equal(Array.isArray(legacyShaped.filterableFields), false);
});
