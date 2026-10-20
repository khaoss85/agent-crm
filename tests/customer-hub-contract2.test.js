// @ts-check

/**
 * Customer Hub contract-2 twin (production incident 20/10).
 *
 * The shared-space reader composes a `packageContract: 2` graph, and the v1
 * `createCustomerHubPackage()` in that graph refuses to start with
 * `PACKAGE_ASYNC_CONTRACT_REQUIRED` — every shared space failed. The pilot
 * patch removed customer-hub, losing the card sections; the twin below puts
 * them back on the async graph. What this must prove: the V2 hub composes in
 * a contract-2 graph beside the V2 providers, and `read-customer-card` plus
 * `read-customer-timeline` answer on the async SQLite app — while v1 stays
 * exactly as it was (the existing hub tests cover it).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
const { resolvePackageComposition } = await import('../packages/core/src/package-composition.js');
const customerData = await import('../packages/customer-data/src/index.js');
const customerHub = await import('../packages/customer-hub/src/index.js');
const work = await import('../packages/work/src/index.js');
const interactions = await import('../packages/interactions/src/index.js');
const appointments = await import('../packages/appointments/src/index.js');

const ACTOR = { type: 'user', id: 'hub-v2-probe' };
const EMAIL = 'guido@palestra-esempio.it';
const NOW = '2026-10-21T08:00:00.000Z';

function packageManifests(packageName) {
  const dir = join(ROOT, 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

function v2Providers() {
  const customerDataV2 = customerData.createCustomerDataPackageV2();
  const workV2 = work.createWorkPackageV2();
  const interactionsV2 = interactions.createInteractionsPackageV2();
  const appointmentsV2 = appointments.createAppointmentsPackageV2({ work: workV2 });
  return { customerDataV2, workV2, interactionsV2, appointmentsV2 };
}

/** @param {{after: (fn: () => void) => void}} t */
async function composedHubV2(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-hub-v2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { customerDataV2, workV2, interactionsV2, appointmentsV2 } = v2Providers();
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'packages.sqlite'),
    selected: {
      packageContract: 2,
      packages: [
        customerDataV2,
        workV2,
        interactionsV2,
        appointmentsV2,
        customerHub.createCustomerHubPackageV2({
          customerData: customerDataV2,
          interactions: interactionsV2,
          appointments: appointmentsV2,
        }),
      ],
      actions: [],
      modules: [
        ...packageManifests('customer-data'),
        ...packageManifests('work'),
        ...packageManifests('interactions'),
        ...packageManifests('appointments'),
      ],
    },
  });
  t.after(() => app.close());
  return app;
}

test('the v1 hub in a contract-2 graph refuses with PACKAGE_ASYNC_CONTRACT_REQUIRED', () => {
  const { customerDataV2, workV2, interactionsV2, appointmentsV2 } = v2Providers();
  const resolved = resolvePackageComposition([
    customerDataV2,
    workV2,
    interactionsV2,
    appointmentsV2,
    customerHub.createCustomerHubPackage({
      customerData: customerDataV2,
      interactions: interactionsV2,
      appointments: appointmentsV2,
    }),
  ]);
  const asyncRefusal = resolved.problems.find((problem) => problem.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.ok(asyncRefusal, 'the 19/10 reader graph must refuse, not serve a partial card');
  assert.match(String(asyncRefusal.message), /customer-hub/);
});

test('the v1 hub in a contract-2 graph fails the async composition, never a read', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-hub-v1-in-v2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { customerDataV2, workV2 } = v2Providers();
  await assert.rejects(
    createAccordoAppAsync({
      dbPath: join(directory, 'packages.sqlite'),
      selected: {
        packageContract: 2,
        packages: [
          customerDataV2,
          workV2,
          customerHub.createCustomerHubPackage({ customerData: customerDataV2 }),
        ],
        actions: [],
        modules: [...packageManifests('customer-data'), ...packageManifests('work')],
      },
    }),
    (error) => error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
    'the incident graph fails at composition with the contract code',
  );
});

test('createCustomerHubPackageV2 selects the awaited graph and keeps v1 synchronous', () => {
  const v1 = customerHub.createCustomerHubPackage({ customerData: { capabilities: [] } });
  assert.equal(v1.packageContract, 1, 'omitted contract keeps the synchronous v1 graph');
  for (const operation of v1.operations) {
    assert.equal(operation.operationContract, 1, `v1 ${operation.name} stays synchronous`);
  }

  const v2 = customerHub.createCustomerHubPackageV2({ customerData: { capabilities: [] } });
  assert.equal(v2.packageContract, 2, 'the twin selects the awaited graph');
  assert.equal(v2.resources.length, 0, 'the twin owns no records, like v1');
  const names = new Map(v2.operations.map((operation) => [operation.name, operation.operationContract]));
  assert.equal(names.get('read-customer-card'), 2, 'the card settles on the async graph');
  assert.equal(names.get('read-customer-timeline'), 2, 'the timeline settles on the async graph');
  assert.deepEqual(
    v2.requires,
    [{ package: 'customer-data', capability: 'customer-profile', version: 1 }],
    'the twin keeps the single declared reach into customer-data',
  );
});

test('read-customer-card answers on the async app', async (t) => {
  const app = await composedHubV2(t);

  await app.operations.run('apply-customer-import', {
    system: 'whatsapp',
    rows: [{ externalId: '+39 333 1234567', email: EMAIL, firstName: 'Guido', lastName: 'Presti' }],
    acceptance: 'partial',
  });

  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1, 'the import resolves to one host contact');
  const card = await app.operations.run('read-customer-card', { resource: 'contact', id: contacts[0].id });

  assert.equal(card.customerCardContract, 1, 'the domain contract is unchanged, only the graph is awaited');
  assert.equal(card.name, 'Guido Presti');
  assert.equal(card.email, EMAIL);
  assert.equal(card.phone.available, true);
  assert.equal(card.phone.value, '+39 333 1234567');
  assert.equal(card.status.value, 'contatto');
});

test('read-customer-timeline answers on the async app', async (t) => {
  const app = await composedHubV2(t);

  await app.operations.run('apply-customer-import', {
    system: 'whatsapp',
    rows: [{ externalId: '+39 333 1234567', email: EMAIL, firstName: 'Guido', lastName: 'Presti' }],
    acceptance: 'partial',
  });
  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1);
  const subject = { resource: 'contact', id: contacts[0].id, owner: 'host' };
  const SOURCE = { package: 'host', action: 'hub-v2-test' };
  const scope = { modules: app.modules, actor: ACTOR, now: () => NOW };

  const { openConversation, logMessage } = interactions;
  const first = await openConversation(scope, {
    sourceKey: 'wa:thread:1', subject, channel: 'whatsapp', remoteHandle: '+39 333 1234567', source: SOURCE,
  });
  await logMessage(scope, {
    sourceKey: 'wa:msg:1', conversationId: first.conversation.id, direction: 'inbound', channel: 'whatsapp',
    body: 'Ciao, vorrei prenotare una prova', remoteHandle: '+39 333 1234567',
    subject, occurredAt: '2026-10-20T09:00:00.000Z', source: SOURCE,
  });

  const { bookAppointment } = appointments;
  await bookAppointment({ ...scope, moduleNames: {}, followUps: null }, {
    sourceKey: 'gym:book:1', subject, teamMemberId: 'coach-guido', serviceKey: 'pt-single',
    priceCents: 4000, currency: 'EUR',
    startsAt: '2026-10-23T16:00:00.000Z', endsAt: '2026-10-23T17:00:00.000Z', source: SOURCE,
  });

  const timeline = await app.operations.run('read-customer-timeline', { resource: 'contact', id: contacts[0].id });

  assert.equal(timeline.customerTimelineContract, 1, 'the domain contract is unchanged, only the graph is awaited');
  assert.equal(timeline.conversations.available, true);
  assert.equal(timeline.conversations.count, 1);
  assert.equal(timeline.conversations.items[0].channel, 'whatsapp');
  assert.equal(timeline.conversations.items[0].last.body, 'Ciao, vorrei prenotare una prova');
  assert.equal(timeline.appointments.available, true);
  assert.equal(timeline.appointments.count, 1);
  assert.equal(timeline.appointments.items[0].startsAt, '2026-10-23T16:00:00.000Z');
  assert.equal(timeline.contactPoints.available, true);
});

test('the twin creates no record the v1 graph does not', async (t) => {
  const app = await composedHubV2(t);
  const before = app.modules.list().map((entry) => entry.name).sort();
  await app.operations.run('apply-customer-import', {
    system: 'whatsapp',
    rows: [{ externalId: '+39 333 1111111', email: 'solo@palestra-esempio.it', firstName: 'Solo', lastName: 'Lettura' }],
    acceptance: 'partial',
  });
  const contacts = await app.services.contacts.list();
  const found = contacts.find((contact) => contact.email === 'solo@palestra-esempio.it');
  assert.ok(found, 'the import lands for the timeline read');
  await app.operations.run('read-customer-card', { resource: 'contact', id: found.id });
  await app.operations.run('read-customer-timeline', { resource: 'contact', id: found.id });
  const after = app.modules.list().map((entry) => entry.name).sort();
  assert.deepEqual(after, before, 'both reads are projections: no module appears, none disappears');
});
