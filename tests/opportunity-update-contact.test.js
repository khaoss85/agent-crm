import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * backlog:619b477c0464 — an offer filed under the company only (the pilot's
 * «Offerta esempio — <nome>» rows had no contactId) never reached the scheda
 * of the person it is for, while the Pipeline showed it. The service can
 * now tie it to that contact: audited, same rule as create (the contact
 * belongs to the offer's company), in-process only (HTTP PATCH unchanged).
 */

const actor = { type: 'user', id: 'seed-esempio' };

async function setup(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Presti Group' }, { actor });
  const other = await app.services.companies.create({ name: 'Altra' }, { actor });
  const bea = await app.services.contacts.create({ companyId: company.id, firstName: 'Bea', lastName: 'Bianchi', email: 'bea@esempio.invalid' }, { actor });
  const stranger = await app.services.contacts.create({ companyId: other.id, firstName: 'Ugo', lastName: 'Altri', email: 'ugo@esempio.invalid' }, { actor });
  const offer = await app.services.opportunities.create({ companyId: company.id, name: 'Offerta esempio — Bea Bianchi', valueCents: 35000, owner: 'coach-guido' }, { actor });
  return { app, company, bea, stranger, offer };
}

test('619b477c0464: an offer with no contact is tied to its person, audited, and keeps everything else', async (t) => {
  const { app, bea, offer } = await setup(t);
  assert.equal(offer.contactId ?? null, null);
  const updated = await app.services.opportunities.update(offer.id, { contactId: bea.id }, { actor });
  assert.equal(updated.contactId, bea.id);
  assert.equal(updated.contactName, 'Bea Bianchi', 'the list now names the person');
  assert.equal(updated.valueCents, 35000);
  const audit = app.audit.list({ entityType: 'opportunity', entityId: offer.id, limit: 10 });
  assert.ok(audit.some((entry) => entry.action === 'opportunity.updated' && entry.data?.contactId === bea.id && entry.actorId === 'seed-esempio'));
  // The scheda's profile reads offers by contact: it now holds this one.
  const listed = app.services.opportunities.list({ companyId: offer.companyId });
  assert.equal(listed.find((row) => row.id === offer.id)?.contactId, bea.id);
});

test('619b477c0464: a contact of another company, an empty or an unknown one is refused before any write', async (t) => {
  const { app, stranger, offer } = await setup(t);
  await assert.rejects(() => app.services.opportunities.update(offer.id, { contactId: stranger.id }, { actor }), /must belong to the opportunity company/);
  await assert.rejects(() => app.services.opportunities.update(offer.id, { contactId: '' }, { actor }), /contactId/);
  await assert.rejects(() => app.services.opportunities.update(offer.id, { contactId: 'missing' }, { actor }));
  assert.equal(app.services.opportunities.get(offer.id).contactId ?? null, null, 'nothing was written');
});
