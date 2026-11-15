import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createCleanupProposals } from '../packages/customer-data/src/cleanup.js';
import { defineCustomerMatchPolicy } from '../packages/customer-data/src/policy.js';
import { resolvedNames } from '../packages/customer-data/src/store.js';
import { createWorkPackageV2 } from '../packages/work/src/index.js';

const { bootPostgresqlApp } = await import('./helpers/postgresql-application.js');

const HERE = dirname(fileURLToPath(import.meta.url));

function packageManifests(packageName) {
  const dir = join(HERE, '..', 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

/**
 * Voce 0477e5de: la scansione apre il follow-up senza await.
 *
 * Con il work al contratto 2 la `create` della capability è asincrona, così
 * `openFollowUps` restituisce una Promise e `followUps.createFollowUp` non è
 * una funzione (TypeError). La cura apre l'handle con await dentro la
 * transazione che il work riconosce, su SQLite e PostgreSQL, e le attività
 * della pulizia compaiono in «Da fare».
 */

const AGENT = { type: 'agent', id: 'pulizia-test' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const guido = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const guidoDup = await app.services.contacts.create({
    companyId: company.id, firstName: 'guido', lastName: '  PRESTI ',
    email: 'guido.presti@palestra-esempio.it',
  });
  return { app, guido, guidoDup };
}

function v2FollowUpProvider() {
  const work = createWorkPackageV2();
  const entry = (work.capabilities ?? []).find((candidate) => candidate?.name === 'follow-up' && candidate?.version === 1);
  assert.ok(entry, 'il work v2 offre follow-up@1');
  return entry;
}

test('con il work al contratto 2 il follow-up si apre con await in transazione e finisce in «Da fare»', async (t) => {
  const { app, guidoDup } = await scene(t);

  const receipt = await createCleanupProposals({
    database: app.database,
    modules: app.modules,
    policy: defineCustomerMatchPolicy(),
    names: resolvedNames(),
    followUpProvider: v2FollowUpProvider(),
  }).proposeDataCleanup({ actor: AGENT });

  assert.equal(receipt.tasksUnavailable, null, 'il bordo work v2 è cablato');
  assert.ok(receipt.counts.tasksWritten > 0, 'la prima scansione apre i task');

  const merge = receipt.proposals.find((proposal) => proposal.kind === 'merge');
  assert.ok(merge, 'il doppione propone l\u2019unione');
  assert.ok(merge.taskId, 'l\u2019unione è proposta in «Da fare»');

  const task = (await app.modules.get('work-task').service.listWhere({ id: merge.taskId }))[0];
  assert.ok(task, 'il task è leggibile nello store');
  assert.equal(task.status, 'open', 'il task aspetta in «Da fare»');
  assert.equal(task.sourcePackage, 'customer-data', 'la provenienza nomina chi ha aperto');

  const step = receipt.proposals.find((proposal) => proposal.kind === 'next-step' && proposal.subject?.id === guidoDup.id);
  assert.ok(step?.taskId, 'anche il passo mancante è in «Da fare»');
});

test('lo stesso bordo composto apre i task in «Da fare» anche su PostgreSQL', { timeout: 120_000 }, async (t) => {
  const customerData = await import('../packages/customer-data/src/index.js');
  const work = await import('../packages/work/src/index.js');
  const workDefinition = work.createWorkPackageV2();
  const booted = await bootPostgresqlApp(t, {
    selected: {
      packageContract: 2,
      packages: [
        customerData.createCustomerDataPackageV2({ work: workDefinition }),
        workDefinition,
      ],
      actions: [],
      modules: [...packageManifests('customer-data'), ...packageManifests('work'), 'lead'],
    },
  });
  if (!booted) return;
  const { app } = booted;

  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const guidoDup = await app.services.contacts.create({
    companyId: company.id, firstName: 'guido', lastName: '  PRESTI ',
    email: 'guido.presti@palestra-esempio.it',
  });

  const receipt = await app.operations.run('propose-data-cleanup', { actor: AGENT });

  assert.equal(receipt.tasksUnavailable, null, 'il bordo work v2 è cablato su PostgreSQL');
  assert.ok(receipt.counts.tasksWritten > 0, 'la prima scansione apre i task su PostgreSQL');

  const merge = receipt.proposals.find((proposal) => proposal.kind === 'merge');
  assert.ok(merge, 'il doppione propone l’unione su PostgreSQL');
  assert.ok(merge.taskId, 'l’unione è proposta in «Da fare» su PostgreSQL');

  const task = (await app.modules.get('work-task').service.listWhere({ id: merge.taskId }))[0];
  assert.ok(task, 'il task è leggibile nello store su PostgreSQL');
  assert.equal(task.status, 'open', 'il task aspetta in «Da fare» su PostgreSQL');

  const step = receipt.proposals.find((proposal) => proposal.kind === 'next-step' && proposal.subject?.id === guidoDup.id);
  assert.ok(step?.taskId, 'anche il passo mancante è in «Da fare» su PostgreSQL');
});
