import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { moduleAlreadyPresent } from './helpers/apply-module.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Appointments end to end, against a real composed application.
 *
 * The model file proves the tables, the transitions and the refusals against
 * doubles; the three claims here need real storage and the real work package,
 * so each runs on a throwaway project that composes both:
 *
 *   - the reminder is opened through the real `follow-up@1` handle, which
 *     binds `source.package` to the consumer the registry resolved — a fake
 *     handle cannot perform that check, so only this test can fail 403;
 *   - the pair promise is proven before the first write, on real tables;
 *   - a reminder failure rolls the booking back with it, on real tables.
 */

const ACTOR = { type: 'user', id: 'e2e' };
const NOW = '2026-10-17T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };

const booking = (overrides = {}) => ({
  sourceKey: 'gym:e2e:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  source: { package: 'appointments-probe', action: 'book' },
  remindAt: '2026-10-19T17:00:00.000Z',
  ...overrides,
});

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-appointments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const applied = cli(root, ['module', 'create', join(root, 'packages/appointments/modules/appointment.module.json'), '--apply']);
  assert.equal(applied.status, 0, `apply appointment: ${applied.stderr}`);
  for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
    if (moduleAlreadyPresent(root, manifest)) continue;
    const work = cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']);
    assert.equal(work.status, 0, `apply ${manifest}: ${work.stderr}`);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    "import { createAppointmentsPackage } from '../../appointments/src/index.js';",
    "import { definePackage } from '../../core/index.js';",
    'const work = createWorkPackage();',
    'const probe = definePackage({',
    "  packageContract: 1, name: 'appointments-probe', version: 1, label: 'Appointments probe',",
    "  description: 'A do-nothing consumer that declares appointment-book@1 so a test can open it through the registry.',",
    '  resources: [], actions: [], policies: [], capabilities: [],',
    '  requires: [',
    "    { package: 'appointments', capability: 'appointment-book', version: 1 },",
    '  ],',
    '});',
    'export const generatedDomains = [',
    '  work,',
    '  createAppointmentsPackage({ work }),',
    '  probe,',
    '];',
    '',
  ].join('\n'));
  return root;
}

async function boot(t, root, file) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', file) });
  t.after(() => app.close());
  return app;
}

const openBooking = (app) => app.domains.capability({
  consumer: 'appointments-probe',
  capability: 'appointment-book',
  version: 1,
  context: { modules: app.modules, actor: ACTOR, now: () => NOW },
});

test('a booking with remindAt opens one real follow-up bound to this package', async (t) => {
  const root = project(t);
  const app = await boot(t, root, 'binding.sqlite');
  const bookingCap = openBooking(app);

  const booked = await app.database.transactionAsync(() => bookingCap.bookAppointment(booking()));
  assert.equal(booked.replayed, false);
  assert.equal(booked.appointment.status, 'booked');
  assert.equal(booked.appointment.reminderDueAt, '2026-10-19T17:00:00.000Z');
  assert.ok(booked.reminder && booked.reminder.task, 'the replay-stable shape carries the reminder handle');

  // The real work package performed its binding check and stored it: this is
  // the write the old code lost with WORK_SOURCE_PACKAGE_MISMATCH after the
  // booking row was already committed.
  const tasks = app.modules.get('work-task').service.listWhere({ sourceKey: 'appointment:gym:e2e:1:reminder' });
  assert.equal(tasks.length, 1, 'exactly one reminder task, replayed never duplicated');
  assert.equal(tasks[0].sourcePackage, 'appointments');
  assert.equal(tasks[0].dueAt, '2026-10-19T17:00:00.000Z');
  assert.equal(app.modules.get('work-activity').service.listWhere({ taskId: tasks[0].id }).length, 1);
});

test('a booking with remindAt outside a transaction is refused before anything is written', async (t) => {
  const root = project(t);
  const app = await boot(t, root, 'pair-proof.sqlite');
  const bookingCap = openBooking(app);

  await assert.rejects(
    bookingCap.bookAppointment(booking()),
    (error) => error.code === 'APPOINTMENTS_TRANSACTION_REQUIRED' && error.status === 500,
  );
  assert.equal(app.modules.get('appointment').service.list().length, 0, 'the pair is proven before the first write');
  assert.equal(app.modules.get('work-task').service.list().length, 0);
});

test('a reminder failure rolls the booking back with it', async (t) => {
  const root = project(t);
  const app = await boot(t, root, 'rollback.sqlite');
  // The appointment side is real storage; only the reminder is fault-injected,
  // the way work's own tests inject a fault into the activity write.
  const { createAppointmentBookCapability } = await import(
    pathToFileURL(join(root, 'packages/appointments/src/index.js')).href
  );
  const bookingCap = createAppointmentBookCapability({}).create({
    modules: app.modules,
    actor: ACTOR,
    now: () => NOW,
    consumer: 'host',
    followUps: {
      createFollowUp: async () => { throw new Error('injected reminder failure'); },
    },
  });

  await assert.rejects(
    app.database.transactionAsync(() => bookingCap.bookAppointment(
      booking({ source: { package: 'host', action: 'book' } }),
    )),
    /injected reminder failure/,
  );
  assert.equal(
    app.modules.get('appointment').service.list().length, 0,
    'no orphan booking may survive a reminder that was never created',
  );
});
