import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { NO_COMPANY_NAME, isNoCompany } from '../packages/customer-data/src/sender.js';
import { shapeCustomerCard } from '../packages/customer-hub/src/card.js';
import { NO_COMPANY_NAME as ADMIN_NO_COMPANY_NAME, shownCompanyName } from '../apps/admin/public/admin-customer-card.js';

/**
 * Production 07/11: «Nuovo cliente» with an empty Azienda got the email
 * domain as its company («esempio.invalid»). An empty Azienda stays empty:
 * the import never derives a company from the email. The core still needs a
 * company behind a contact, so the contact sits under the space's one
 * reserved NO_COMPANY_NAME company, and the customer list reads no company.
 */

const OPERATOR = { type: 'user', id: 'no-company-op' };

function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  return { app };
}

const applyOne = (app, row, system = 'inserimento-manuale') => app.applyCustomerImport({
  actor: OPERATOR, system, rows: [row], acceptance: 'partial',
});

test('an import row with no Azienda never becomes a company named after the email domain', async (t) => {
  const { app } = scene(t);
  const result = await applyOne(app, { firstName: 'Mario', lastName: 'Rossi', email: 'mario@esempio.invalid' });
  const subject = result.receipts[0].subject;
  assert.equal(result.receipts[0].outcome, 'accepted');
  assert.equal(subject.resource, 'contact');
  const contact = await app.services.contacts.get(subject.id);
  const company = await app.services.companies.get(contact.companyId);
  assert.notEqual(company.name, 'esempio.invalid', 'no company derived from the email domain');
  assert.equal(company.name, NO_COMPANY_NAME);
  assert.equal(isNoCompany(company), true);

  const list = await app.listCustomers({});
  const row = list.items.find((item) => item.id === subject.id);
  assert.ok(row, 'the customer reads in the list');
  assert.equal(row.company, null, 'the list reads no Azienda for it');
});

test('every contact without Azienda gets its own placeholder: no shared row between customers or spaces (review #654)', async (t) => {
  const { app } = scene(t);
  const first = await applyOne(app, { firstName: 'Anna', email: 'anna@uno.invalid' });
  const second = await applyOne(app, { firstName: 'Bruno', email: 'bruno@due.invalid' });
  const a = await app.services.contacts.get(first.receipts[0].subject.id);
  const b = await app.services.contacts.get(second.receipts[0].subject.id);
  assert.notEqual(a.companyId, b.companyId, 'never one company row linking unrelated customers');
  const companies = await app.services.companies.list({ limit: 50 });
  assert.equal(companies.filter((company) => isNoCompany(company)).length, 2);
  assert.ok(!companies.some((company) => company.name === 'uno.invalid' || company.name === 'due.invalid'));
});

test('an explicit domain column stays on the placeholder as evidence (review #654)', async (t) => {
  const { app } = scene(t);
  const result = await applyOne(app, { firstName: 'Mario', email: 'mario@acme.example', domain: 'acme.example' }, 'crm-export');
  const contact = await app.services.contacts.get(result.receipts[0].subject.id);
  const company = await app.services.companies.get(contact.companyId);
  assert.equal(company.name, NO_COMPANY_NAME, 'the domain is not turned into a company name');
  assert.equal(company.domain, 'acme.example', 'the caller-supplied domain is never dropped');
});

test('the placeholder lists no customer row of its own and is never a duplicate suspect (review #654)', async (t) => {
  const { app } = scene(t);
  await applyOne(app, { firstName: 'Anna', email: 'anna@uno.invalid' });
  await applyOne(app, { firstName: 'Bruno', email: 'bruno@due.invalid' });
  // A placeholder left without its contact still never reads as a customer.
  const orphan = await app.services.companies.create({ name: NO_COMPANY_NAME, domain: null }, { actor: OPERATOR });
  const list = await app.listCustomers({});
  assert.ok(!list.items.some((item) => item.resource === 'company' && item.id === orphan.id), 'no standalone placeholder row');
  assert.ok(!list.items.some((item) => item.name === NO_COMPANY_NAME), 'no row named after the placeholder');
  await app.proposeDataCleanup({ actor: { type: 'agent', id: 'pulizia-test' } });
  const candidates = await app.modules.get('duplicate-candidate').service.list({ limit: 500 });
  assert.ok(!candidates.some((row) => row.leftResource === 'company' && row.rightResource === 'company'),
    'same-named placeholders are never paired as duplicates');
});

test('the profile and the card name no company for a contact without Azienda, the offer id stays readable (review #654)', async (t) => {
  const { app } = scene(t);
  const result = await applyOne(app, { firstName: 'Mario', lastName: 'Rossi', email: 'mario@esempio.invalid' });
  const subject = result.receipts[0].subject;
  const contact = await app.services.contacts.get(subject.id);
  const profile = await app.readCustomerProfile({ resource: 'contact', id: subject.id });
  assert.equal(profile.identity.company, null, 'the profile reads no company');
  assert.equal(profile.identity.contact.companyId, contact.companyId, 'the id an offer is filed under stays readable');
  const card = shapeCustomerCard(profile, { resource: 'contact', id: subject.id });
  assert.equal(card.company, null, 'the card API agrees with the list: no company');
});

test('isNoCompany uses the same normalization as the company lookup (review #654)', () => {
  for (const name of ['Senza azienda', 'SENZA AZIENDA', '  Senza   azienda  ']) {
    assert.equal(isNoCompany({ name }), true, JSON.stringify(name));
  }
  assert.equal(isNoCompany({ name: 'Senza aziende srl' }), false);
  assert.equal(isNoCompany(null), false);
});

test('a named Azienda still files the contact under that company', async (t) => {
  const { app } = scene(t);
  const result = await applyOne(app, { firstName: 'Carla', email: 'carla@palestra.invalid', companyName: 'Palestra Esempio' });
  const contact = await app.services.contacts.get(result.receipts[0].subject.id);
  const company = await app.services.companies.get(contact.companyId);
  assert.equal(company.name, 'Palestra Esempio');
  const list = await app.listCustomers({});
  assert.equal(list.items.find((item) => item.id === contact.id)?.company?.name, 'Palestra Esempio');
});

test('the backoffice hides exactly the placeholder customer-data writes (one name, one rule)', () => {
  // The static admin bundle cannot import a package: its copy is pinned here.
  assert.equal(ADMIN_NO_COMPANY_NAME, NO_COMPANY_NAME);
  for (const name of ['Senza azienda', 'SENZA AZIENDA', '  Senza   azienda  ', 'Palestra Esempio']) {
    assert.equal(shownCompanyName({ company: { name } }) === null, isNoCompany({ name }), JSON.stringify(name));
  }
});
