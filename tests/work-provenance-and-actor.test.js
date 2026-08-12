import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { boot, project } from './helpers/contracts-project.js';
import { PackageRegistry, definePackage } from '../packages/core/index.js';
import { createFollowUp, createWorkPackage } from '../packages/work/src/index.js';

/**
 * **REVIEW-70 — provenance and actor identity.**
 *
 * Two defects this file exists to keep fixed, both of the same kind: a record
 * that says who did something, when the code had no way of knowing whether that
 * was true.
 *
 *   1. **`source.package` was caller text.** A declared consumer could store any
 *      other package's name as the provenance of work it opened, and the row
 *      would read as authoritative for the rest of its life. The registry
 *      already resolves and verifies the consumer at capability resolution, so
 *      that identity is now what gets stored, and a mismatch is refused.
 *   2. **The actor id was silently truncated to 200 characters.** Two distinct
 *      identities sharing a 200-character prefix became one string on the task
 *      and on every activity, while the audit row written in the same
 *      transaction still carried the full id. Work now uses the kernel's own
 *      actor authority and stores exactly what audit stores.
 */

const ACTOR = { type: 'user', id: 'e2e' };

/** The B2B starter's Lead path — the host consumer — with the Work records only. */
async function leadProject(t, file) {
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
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return context;
}

// ---------------------------------------------------------------------------
// The registry binds the consumer, and a caller cannot forge it
// ---------------------------------------------------------------------------

test('the registry hands the consumer identity it resolved to the provider, and a caller cannot override it', () => {
  let seen = 'never called';
  const provider = definePackage({
    packageContract: 1,
    name: 'probe-provider',
    version: 1,
    label: 'Probe provider',
    description: 'Records the consumer identity the registry supplies.',
    resources: [],
    requires: [],
    capabilities: [{
      name: 'probe',
      version: 1,
      description: 'Returns the consumer identity the registry supplied.',
      create(context) { seen = context.consumer; return { seen: context.consumer }; },
    }],
    actions: [],
    policies: [],
    metadata: () => ({}),
  });
  const consumer = definePackage({
    packageContract: 1,
    name: 'probe-consumer',
    version: 1,
    label: 'Probe consumer',
    description: 'Declares the probe capability.',
    resources: [],
    requires: [{ package: 'probe-provider', capability: 'probe', version: 1 }],
    capabilities: [],
    actions: [],
    policies: [],
    metadata: () => ({}),
  });
  const registry = new PackageRegistry({ packages: [provider, consumer] });

  const value = registry.capability({ consumer: 'probe-consumer', capability: 'probe', version: 1 });
  assert.equal(value.seen, 'probe-consumer');
  assert.equal(seen, 'probe-consumer');

  // A context that carries its own `consumer` does not get to keep it: the
  // registry's own resolution always wins, so this is not a second spoofing
  // surface.
  const forged = registry.capability({
    consumer: 'probe-consumer', capability: 'probe', version: 1,
    context: { consumer: 'probe-provider' },
  });
  assert.equal(forged.seen, 'probe-consumer');
});

// ---------------------------------------------------------------------------
// Work refuses a false source package
// ---------------------------------------------------------------------------

test('a declared consumer cannot record another package as the source of work it opened', async (t) => {
  const context = await leadProject(t, 'provenance.sqlite');
  const { app } = context;
  const base = {
    title: 'Follow up', dueAt: null,
    subject: { resource: 'lead', id: 'l1', owner: 'host' },
  };
  const tx = (consumer, request) => app.database.transactionAsync(() => createFollowUp(
    { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z', consumer },
    request,
  ));

  // Every one of these stored a false provenance before the fix.
  const spoofs = [
    ['service', 'lifecycle', 'the Service consumer claiming Lifecycle'],
    ['lifecycle', 'host', 'Lifecycle claiming the host'],
    ['lifecycle', 'service', 'Lifecycle claiming Service'],
    [undefined, 'lifecycle', 'a direct host caller claiming a package'],
    [undefined, 'work', 'a direct host caller claiming the provider itself'],
  ];
  for (const [consumer, asserted, what] of spoofs) {
    await assert.rejects(
      () => tx(consumer, { ...base, sourceKey: `spoof:${asserted}:${consumer ?? 'host'}`, source: { package: asserted, action: 'qualify' } }),
      (error) => {
        assert.equal(error.code, 'WORK_SOURCE_PACKAGE_MISMATCH', what);
        assert.equal(error.status, 403, what);
        assert.equal(error.details.asserted, asserted, what);
        assert.equal(error.details.bound, consumer ?? 'host', what);
        return true;
      },
      what,
    );
  }
  assert.equal(app.modules.get('work-task').service.list().length, 0, 'a refused spoof writes nothing');

  // The truthful callers still work, and what is stored is the bound identity.
  const byService = await tx('service', {
    ...base, sourceKey: 'service-escalation:e1',
    subject: { resource: 'service-escalation', id: 'e1', owner: 'package', ownerPackage: 'service' },
    source: { package: 'service', action: 'record-escalation' },
  });
  assert.equal(byService.task.sourcePackage, 'service');
  const byHost = await tx(undefined, { ...base, sourceKey: 'lead-qualified:l1', source: { package: 'host', action: 'qualify' } });
  assert.equal(byHost.task.sourcePackage, 'host');

  // The stored provenance is also part of the replay identity, so a second,
  // truthful package cannot be handed the first one's task under the same key.
  // Before the fix this replayed silently and Lifecycle received Service's row.
  await assert.rejects(
    () => tx('lifecycle', {
      ...base, sourceKey: 'service-escalation:e1',
      subject: { resource: 'service-escalation', id: 'e1', owner: 'package', ownerPackage: 'service' },
      source: { package: 'lifecycle', action: 'record-escalation' },
    }),
    (error) => {
      assert.equal(error.code, 'WORK_FOLLOW_UP_CONFLICT');
      assert.deepEqual(error.details.conflictingFields, ['sourcePackage']);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Actor identity is the kernel's, byte for byte
// ---------------------------------------------------------------------------

test('two identities sharing a 200-character prefix stay two identities, and match the audit row', async (t) => {
  const context = await leadProject(t, 'actor-identity.sqlite');
  const { app } = context;
  const prefix = `user-${'x'.repeat(200)}`;
  const alice = { type: 'user', id: `${prefix}-alice` };
  const bob = { type: 'user', id: `${prefix}-bob` };
  assert.equal(alice.id.slice(0, 200), bob.id.slice(0, 200), 'the two ids are indistinguishable at 200 characters');

  const leads = app.modules.get('lead').service;
  const first = await leads.create({ firstName: 'A', lastName: 'One', email: 'a@x.example' }, { actor: alice });
  const second = await leads.create({ firstName: 'B', lastName: 'Two', email: 'b@x.example' }, { actor: bob });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: first.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor: alice });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: second.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor: bob });

  const tasks = app.modules.get('work-task').service;
  const aliceTask = tasks.listWhere({ sourceKey: `lead-qualified:${first.id}` })[0];
  const bobTask = tasks.listWhere({ sourceKey: `lead-qualified:${second.id}` })[0];
  assert.notEqual(aliceTask.openedById, bobTask.openedById, 'truncation would have merged these two people');
  assert.equal(aliceTask.openedById, alice.id, 'the identity is stored whole, not to 200 characters');
  assert.equal(bobTask.openedById, bob.id);

  // The activity written in the same transaction agrees.
  const activities = app.modules.get('work-activity').service;
  assert.equal(activities.listWhere({ taskId: aliceTask.id })[0].actorId, alice.id);
  assert.equal(activities.listWhere({ taskId: bobTask.id })[0].actorId, bob.id);

  // And so does the audit row for the very same write — one write, one identity,
  // two records that cannot disagree about who did it.
  const audited = app.database.raw
    .prepare("SELECT actor_id FROM audit_events WHERE entity_type = 'work-task' AND entity_id = ?")
    .get(aliceTask.id);
  assert.equal(audited.actor_id, alice.id, 'the task and its audit row must name the same person');

  // A closing decision records the same identity.
  const closed = await app.runAction({
    module: 'work-task', action: 'complete', recordId: aliceTask.id, input: {}, actor: alice,
  });
  assert.equal(closed.result.task.completedBy, alice.id);
});

// ---------------------------------------------------------------------------
// The work package still declares nothing about the consumer it serves
// ---------------------------------------------------------------------------

test('the published contract states what is bound and what is still asserted', () => {
  const meta = createWorkPackage().metadata();
  assert.match(meta.capability.sourcePackageIsBound, /NOT caller text/);
  assert.match(meta.capability.sourcePackageIsBound, /WORK_SOURCE_PACKAGE_MISMATCH/);
  assert.match(meta.capability.stillAsserted, /source\.action and subject\.ownerPackage remain caller-asserted/);
  assert.match(meta.capability.stillAsserted, /neither is authentication/);
  assert.match(meta.capability.transaction, /WORK_TRANSACTION_REQUIRED/);
});
