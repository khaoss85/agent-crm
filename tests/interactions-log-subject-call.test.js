import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * Voce 105563eea902: the scheda cliente's «Chiama dal CRM».
 *
 * What it must prove: an operator-placed call lands as an `interaction-call`
 * row — the same row, outcome vocabulary and human-actor boundary as the
 * adapter `logCall` path (MEM_ACC_REUSE: no new record), with the channel
 * fixed to `phone` and the direction to `outbound`. The outcome is
 * operator-declared and idempotent by `callKey`: a replay returns the stored
 * row, a divergent payload behind the same key refuses 409. The call reads
 * back on the subject timeline, so the scheda cronologia shows it.
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };
const AT = '2026-10-30T09:00:00.000Z';

const INTERACTIONS_MANIFESTS = [
  'conversation.module.json',
  'interaction-message.module.json',
  'interaction-call.module.json',
  'conversation-assignment.module.json',
  'conversation-read.module.json',
  'conversation-thread-key.module.json',
];

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/** The same project as the customer-data helper, plus the interactions package. */
function projectWithCalls(t) {
  const root = project(t, {});
  for (const manifest of INTERACTIONS_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/interactions/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  const path = join(root, 'packages/domains/generated/index.js');
  writeFileSync(path, [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    'export const generatedDomains = [',
    '  createCustomerDataPackage(),',
    '  createInteractionsPackage(),',
    '];',
    '',
  ].join('\n'));
  return root;
}

async function scene(t, file) {
  const root = projectWithCalls(t);
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { app } = context;
  assert.equal(typeof app.logSubjectCall, 'function', 'the interactions package offers the call operation');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const rootUrl = pathToFileURL(join(root, 'packages/interactions/src/index.js')).href;
  const { readTimeline } = await import(rootUrl);
  return { app, contact, readTimeline };
}

const CALL = {
  callKey: 'call-scheda-1',
  outcome: 'completed',
  durationSec: 120,
  teamAuthorId: 'scheda-op',
  remoteHandle: '+393331234567',
  occurredAt: AT,
};

test('an operator-placed call logs and reads on the subject timeline', async (t) => {
  const { app, contact, readTimeline } = await scene(t, 'subject-call.sqlite');
  const logged = await app.logSubjectCall({ resource: 'contact', id: contact.id, ...CALL, actor: OPERATOR });
  assert.equal(logged.replayed, false);
  assert.equal(logged.call.direction, 'outbound');
  assert.equal(logged.call.channel, 'phone');
  assert.equal(logged.call.outcome, 'completed');
  assert.equal(logged.call.durationSec, 120);
  assert.equal(logged.call.teamAuthorId, 'scheda-op');
  assert.equal(logged.call.remoteHandle, '+393331234567');

  const replay = await app.logSubjectCall({ resource: 'contact', id: contact.id, ...CALL, actor: OPERATOR });
  assert.equal(replay.replayed, true, 'the same key with the same payload replays');
  assert.equal(replay.call.id, logged.call.id);

  const rows = app.modules.get('interaction-call').service.listWhere({ sourceKey: 'call-scheda-1' });
  assert.equal(rows.length, 1, 'one key, one row');

  const timeline = await readTimeline(
    { modules: app.modules, moduleNames: undefined },
    { resource: 'contact', id: contact.id, owner: 'host' },
  );
  const calls = timeline.entries.filter((entry) => entry.entry === 'call');
  assert.equal(calls.length, 1, 'the scheda cronologia shows the placed call once');
  assert.equal(calls[0].outcome, 'completed');
});

test('a divergent payload behind the same key, a bad outcome and not a human refuse', async (t) => {
  const { app, contact } = await scene(t, 'subject-call-refusals.sqlite');
  await app.logSubjectCall({ resource: 'contact', id: contact.id, ...CALL, actor: OPERATOR });
  await assert.rejects(
    () => app.logSubjectCall({
      resource: 'contact', id: contact.id, ...CALL, durationSec: 5, actor: OPERATOR,
    }),
    (error) => error?.code === 'INTERACTIONS_LOG_CONFLICT' && error?.status === 409,
    'the same key with a different payload refuses, never adopts',
  );
  await assert.rejects(
    () => app.logSubjectCall({
      resource: 'contact', id: contact.id, ...CALL, callKey: 'call-scheda-2',
      outcome: 'missed', durationSec: 45, actor: OPERATOR,
    }),
    'a missed call with minutes stored as talk time refuses',
  );
  await assert.rejects(
    () => app.logSubjectCall({
      resource: 'contact', id: contact.id, ...CALL, callKey: 'call-scheda-3',
      actor: { type: 'agent', id: 'bot' },
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
    'placing a call is a human decision',
  );
  await assert.rejects(
    () => app.logSubjectCall({ resource: 'lead', id: contact.id, ...CALL, callKey: 'call-scheda-4', actor: OPERATOR }),
    (error) => error?.code === 'INTERACTIONS_CALL_SUBJECT_INVALID',
    'only contact and company subjects take calls',
  );
  assert.equal(
    app.modules.get('interaction-call').service.listWhere({}).length,
    1,
    'refused calls write nothing',
  );
});
