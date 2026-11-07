import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { NO_COMPANY_NAME, isNoCompany } from '../packages/customer-data/src/sender.js';

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

test('every contact without Azienda shares the one reserved company (no duplicate suspects)', async (t) => {
  const { app } = scene(t);
  const first = await applyOne(app, { firstName: 'Anna', email: 'anna@uno.invalid' });
  const second = await applyOne(app, { firstName: 'Bruno', email: 'bruno@due.invalid' });
  const a = await app.services.contacts.get(first.receipts[0].subject.id);
  const b = await app.services.contacts.get(second.receipts[0].subject.id);
  assert.equal(a.companyId, b.companyId, 'one reserved company per space, never one per contact');
  const companies = await app.services.companies.list({ limit: 50 });
  assert.equal(companies.filter((company) => isNoCompany(company)).length, 1);
  assert.ok(!companies.some((company) => company.name === 'uno.invalid' || company.name === 'due.invalid'));
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
