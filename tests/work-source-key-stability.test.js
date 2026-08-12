import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { boot, project } from './helpers/contracts-project.js';
import { createFollowUp, sortTimeline } from '../packages/work/src/index.js';
import { workFollowUpKey as lifecycleKey } from '../packages/lifecycle/src/index.js';
import { workFollowUpKey as serviceKey } from '../packages/service/src/service-actions.js';

/**
 * **REVIEW-70 — where the "a key that moves identifies nothing" guarantee lives.**
 *
 * Work v1 first enforced it with a regex inside the generic capability: any
 * ISO instant, any run of 13 or more digits, refused. That is not a property of
 * a moving key, it is a property of *some* strings that look like one, and it
 * cost real business identities — a 13-digit customer number, a provider event
 * id, a 16-digit order number, a scheduled meeting slot. A generic capability
 * cannot infer a caller's business identity from a regex, so it no longer tries.
 *
 * The guarantee moved to where the identity actually is: **the caller owns a
 * stable business identity, and proves it here.** Every consumer's key is a
 * pure function of a committed record id, and this file runs each one at two
 * different clock instants and asserts the key does not move.
 *
 * The complement — that a stable key genuinely replays instead of opening a
 * second task — is in `tests/work-operations-e2e.test.js`.
 */

const ACTOR = { type: 'user', id: 'e2e' };

async function leadProject(t, file, clock) {
  const root = project(t, { withDomain: false, withWorkTables: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const { spawnSync } = await import('node:child_process');
  const applied = spawnSync(process.execPath, [
    '--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
    join(root, 'examples/starters/b2b-lead-qualification/lead.module.json'), '--apply', '--root', root,
  ], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);
  const context = await boot(root, join(root, 'data', file), clock ? { clock } : {});
  t.after(() => context.close());
  return context;
}

test('every consumer key is a pure function of a committed record id, at any instant', () => {
  // The two package consumers export their key builders, so the property is
  // checkable rather than a comment. Called a year apart, they answer the same.
  const originalNow = Date.now;
  try {
    Date.now = () => 1_700_000_000_000;
    const early = [lifecycleKey('followup-1'), serviceKey('escalation-1')];
    Date.now = () => 1_800_000_000_000;
    const late = [lifecycleKey('followup-1'), serviceKey('escalation-1')];
    assert.deepEqual(late, early, 'a key that moves with the clock identifies nothing');
    assert.deepEqual(early, ['lifecycle-commercial-followup:followup-1', 'service-escalation:escalation-1']);
  } finally {
    Date.now = originalNow;
  }
  // And they are distinct namespaces, so two domains cannot collide on one key.
  assert.notEqual(lifecycleKey('x'), serviceKey('x'));
});

test('the host consumer key survives a clock that has moved a year', async (t) => {
  let instant = '2026-08-01T00:00:00.000Z';
  const context = await leadProject(t, 'key-stability.sqlite', () => instant);
  const { app } = context;
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Stable', lastName: 'Key', email: 'stable@x.example' }, { actor: ACTOR },
  );
  await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor: ACTOR });
  const tasks = app.modules.get('work-task').service;
  const first = tasks.listWhere({ subjectResource: 'lead', subjectId: lead.id })[0];
  assert.equal(first.sourceKey, `lead-qualified:${lead.id}`);

  // A year later, the same business event computes the same key and replays.
  // This is the property the clock regex was standing in for, proven directly.
  instant = '2027-08-01T00:00:00.000Z';
  const retry = await app.database.transactionAsync(() => createFollowUp(
    { modules: app.modules, actor: ACTOR, now: () => instant },
    {
      sourceKey: `lead-qualified:${lead.id}`,
      title: first.title,
      dueAt: first.dueAt,
      subject: { resource: 'lead', id: lead.id, owner: 'host' },
      source: { package: 'host', action: 'qualify' },
    },
  ));
  assert.equal(retry.replayed, true);
  assert.equal(retry.task.id, first.id);
  assert.equal(tasks.list().length, 1, 'a year of clock movement opens no second task');
});

// ---------------------------------------------------------------------------
// REVIEW-70 — timeline order is a property of the data, not of the machine
// ---------------------------------------------------------------------------

test('the timeline order does not depend on the host locale or ICU build', () => {
  // `localeCompare` with no locale asks the host's ICU collation, which is a
  // property of the machine, the Node build and LANG — and it is NOT code-point
  // order: it treats `-` and `_` as variable punctuation and orders case the
  // other way round. Two readers of the same rows could see two orders.
  const rows = [
    { id: 'x_1', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
    { id: 'x-1', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
    { id: 'A1', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
    { id: 'a1', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
    { id: 'ab', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
    { id: 'aa', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'c' },
  ];
  const codePoint = [...rows].map((row) => row.id).sort();
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), codePoint);

  // Every one of these locales disagrees with code-point order on at least one
  // of the pairs above, so a locale-sensitive comparator would produce a
  // different list on a machine configured for any of them.
  for (const locale of ['en-US', 'tr-TR', 'sv-SE', 'da-DK', 'cs-CZ']) {
    const byLocale = [...rows].sort((a, b) => a.id.localeCompare(b.id, locale)).map((row) => row.id);
    assert.notDeepEqual(byLocale, codePoint, `${locale} must be a real counter-example`);
  }

  // Chronology still wins over every tie-break, in code-point order too.
  const chronological = sortTimeline([
    { id: 'z', occurredAt: '2026-09-15T10:00:00.000Z', createdAt: 'a' },
    { id: 'a', occurredAt: '2026-09-15T09:00:00.000Z', createdAt: 'b' },
  ]);
  assert.deepEqual(chronological.map((row) => row.id), ['a', 'z']);
});
