import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **BO-F4-03: the scheda cliente reads enriched data with its source.**
 *
 * `readCustomerEnrichment` is the read behind the "Arricchito dall'AI"
 * section: every active enriched field of the customer's whole cluster with
 * the free source that filled it and its observation date, plus the opt-out
 * state. It creates nothing.
 *
 * What it must prove: each datum cites its own source and date; a linked
 * member's field shows on the canonical read; an unknown subject reads as
 * empty (never an error); an opted-out subject reads as opted out with no
 * active rows; bad input refuses.
 */

const ACTOR = { type: 'user', id: 'enrichment-read' };

async function scene(t, tag, options = {}) {
  const root = project(t, options);
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

async function linkMembers(app, members) {
  const service = app.modules.get('canonical-link').service;
  for (const member of members) {
    await service.createManaged({
      sourceKey: `test:link:${member.subjectId}`,
      clusterKey: 'cluster-test-1',
      subjectResource: member.subjectResource,
      subjectId: member.subjectId,
      subjectOwner: 'host',
      subjectOwnerPackage: null,
      subjectLabel: null,
      role: member.role,
      decisionId: 'decision-test-1',
      reason: 'stesso numero su WhatsApp e Instagram',
      decidedByType: 'user',
      decidedById: 'elena',
      decidedAt: '2026-10-20T10:00:00.000Z',
      status: 'active',
      withdrawnReason: null,
      withdrawnAt: null,
    }, { actor: ACTOR });
  }
}

test('BO-F4-03: the read cites the source and date of every datum', async (t) => {
  const { app } = await scene(t, 'enrichment-read-cites-source', { googleContacts: true });

  const role = await app.applyContactEnrichment({
    actor: ACTOR, email: 'guido@palestra-esempio.it',
    fields: { role: 'Istruttore' }, source: 'email-signature', sourceDetail: 'msg-1',
  });
  assert.equal(role.outcome, 'created');
  const contactId = role.contact.id;

  const name = await app.applyContactEnrichment({
    actor: ACTOR, email: 'guido@palestra-esempio.it',
    fields: { firstName: 'Guido' }, source: 'google-contacts', sourceDetail: 'people/c1',
  });
  assert.equal(name.outcome, 'enriched');

  const read = await app.readCustomerEnrichment({ resource: 'contact', id: contactId });
  assert.equal(read.customerEnrichmentContract, 1);
  assert.deepEqual(read.subject, { resource: 'contact', id: contactId });
  assert.equal(read.linked, false);
  assert.equal(read.optedOut, null);
  assert.equal(read.items.length, 2);

  const byField = new Map(read.items.map((item) => [item.field, item]));
  assert.equal(byField.get('role').value, 'Istruttore');
  assert.equal(byField.get('role').source, 'email-signature');
  assert.match(byField.get('role').observedAt, /^\d{4}-\d{2}-\d{2}T/, 'the observation date travels with the datum');
  assert.equal(byField.get('firstName').value, 'Guido');
  assert.equal(byField.get('firstName').source, 'google-contacts');
  assert.match(byField.get('firstName').observedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('BO-F4-03: a linked member field shows on the canonical read', async (t) => {
  const { app } = await scene(t, 'enrichment-read-cluster');

  const canonical = await app.applyContactEnrichment({
    actor: ACTOR, email: 'guido@palestra-esempio.it',
    fields: { role: 'Istruttore' }, source: 'email-signature',
  });
  const alias = await app.applyContactEnrichment({
    actor: ACTOR, email: 'guido.alias@palestra-esempio.it',
    fields: { lastName: 'Presti' }, source: 'email-signature',
  });
  await linkMembers(app, [
    { subjectResource: 'contact', subjectId: canonical.contact.id, role: 'canonical' },
    { subjectResource: 'contact', subjectId: alias.contact.id, role: 'alias' },
  ]);

  const read = await app.readCustomerEnrichment({ resource: 'contact', id: canonical.contact.id });
  assert.equal(read.linked, true);
  const fields = read.items.map((item) => item.field).sort();
  assert.deepEqual(fields, ['lastName', 'role'], 'the whole cluster feeds the scheda, not just the named record');
  const aliasField = read.items.find((item) => item.field === 'lastName');
  assert.equal(aliasField.subject.id, alias.contact.id, 'the row still names the member it was observed on');
  assert.equal(aliasField.source, 'email-signature');
});

test('BO-F4-03: an unknown subject reads as empty, never as an error', async (t) => {
  const { app } = await scene(t, 'enrichment-read-unknown');
  const read = await app.readCustomerEnrichment({ resource: 'contact', id: 'nobody-here' });
  assert.equal(read.optedOut, null);
  assert.deepEqual(read.items, []);
});

test('BO-F4-03: an opted-out subject reads as opted out with no active rows', async (t) => {
  const { app } = await scene(t, 'enrichment-read-opt-out');

  const created = await app.applyContactEnrichment({
    actor: ACTOR, email: 'guido@palestra-esempio.it',
    fields: { role: 'Istruttore' }, source: 'email-signature',
  });
  const contactId = created.contact.id;
  const before = await app.readCustomerEnrichment({ resource: 'contact', id: contactId });
  assert.equal(before.items.length, 1);

  const left = await app.optOutContactEnrichment({
    actor: ACTOR, email: 'guido@palestra-esempio.it', reason: 'asked at the desk',
  });
  assert.equal(left.outcome, 'opted-out');

  const read = await app.readCustomerEnrichment({ resource: 'contact', id: contactId });
  assert.deepEqual(read.items, [], 'purged rows never feed the scheda');
  assert.ok(read.optedOut, 'the opt-out itself is shown instead of an empty section');
  assert.equal(read.optedOut.reason, 'asked at the desk');
  assert.match(read.optedOut.optedOutAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('BO-F4-03: the read refuses without a subject', async (t) => {
  const { app } = await scene(t, 'enrichment-read-refuses');
  await assert.rejects(
    app.readCustomerEnrichment({ resource: 'contact', id: '' }),
    (error) => error.code === 'VALIDATION_ERROR');
  await assert.rejects(
    app.readCustomerEnrichment({ resource: '', id: 'c1' }),
    (error) => error.code === 'VALIDATION_ERROR');
});
