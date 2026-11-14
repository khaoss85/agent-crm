import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
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
  const orphan = await app.services.companies.create({ name: NO_COMPANY_NAME, domain: null, placeholder: true }, { actor: OPERATOR, allowPlaceholder: true });
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

test('isNoCompany reads the core placeholder flag, never the name (backlog:ac65e448fcb4)', () => {
  assert.equal(isNoCompany({ name: 'Senza azienda', placeholder: true }), true);
  assert.equal(isNoCompany({ name: 'Senza azienda', placeholder: 1 }), true);
  // A real company keeps the flag down whatever its name is — even the
  // placeholder's own name reads as a company.
  for (const company of [
    { name: 'Senza azienda', placeholder: false },
    { name: 'SENZA AZIENDA', placeholder: false },
    { name: '  Senza   azienda  ', placeholder: false },
    { name: 'Senza aziende srl', placeholder: false },
    { name: 'Senza azienda' },
    { name: 'Senza azienda', placeholder: 0 },
    null,
    undefined,
  ]) {
    assert.equal(isNoCompany(company), false, JSON.stringify(company));
  }
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

test('the backoffice hides the flagged placeholder and shows a real company whatever its name (backlog:ac65e448fcb4)', () => {
  // The static admin bundle cannot import a package: its copy is pinned here.
  assert.equal(ADMIN_NO_COMPANY_NAME, NO_COMPANY_NAME);
  assert.equal(shownCompanyName({ company: { name: 'Senza azienda', placeholder: true } }), null);
  assert.equal(shownCompanyName({ company: { name: 'Senza azienda', placeholder: 1 } }), null);
  // A real company shows — even with the placeholder's own name — as long
  // as it carries its flag down. A flag-less shape with the reserved name
  // (stale cache, old server) hides through the name fallback (giro 2).
  for (const company of [
    { name: 'Senza azienda', placeholder: false },
    { name: 'SENZA AZIENDA', placeholder: false },
    { name: 'Palestra Esempio', placeholder: false },
    { name: 'Palestra Esempio' },
  ]) {
    assert.equal(shownCompanyName({ company }), company.name.trim(), JSON.stringify(company));
  }
  assert.equal(shownCompanyName({ company: { name: 'Senza azienda' } }), null, 'flag-less reserved name hides (legacy fallback)');
  assert.equal(shownCompanyName({ company: { id: 'k-old', name: 'Senza azienda' } }), null, 'flag-less legacy card hides');
  assert.equal(shownCompanyName({ company: null }), null);
  assert.equal(shownCompanyName({ company: { name: '  ' } }), null);
});

test('review #654 giro 4: an explicit «Senza azienda» never reuses another customer placeholder', async (t) => {
  const { app } = scene(t);
  const first = await applyOne(app, { firstName: 'Anna', email: 'anna@uno.invalid' });
  const anna = await app.services.contacts.get(first.receipts[0].subject.id);
  for (const [index, companyName] of ['Senza azienda', '  SENZA   azienda '].entries()) {
    const next = await applyOne(app, { firstName: `Bruno${index}`, email: `bruno${index}@due.invalid`, companyName });
    assert.equal(next.receipts[0].outcome, 'accepted');
    const bruno = await app.services.contacts.get(next.receipts[0].subject.id);
    assert.notEqual(bruno.companyId, anna.companyId, `${JSON.stringify(companyName)} gets its own placeholder, never Anna's`);
    assert.equal(isNoCompany(await app.services.companies.get(bruno.companyId)), true);
  }
  // A company-only row with the reserved name never matches a placeholder.
  const companyOnly = await applyOne(app, { companyName: 'Senza azienda', externalId: 'X-1' }, 'crm-export');
  const receipt = companyOnly.receipts[0];
  assert.notEqual(receipt.reasonCode, 'MATCHED_EXISTING', 'no match onto a contact placeholder');
  assert.notEqual(receipt.subject?.id, anna.companyId);
});

test('a real company named «Senza azienda» reads as a company everywhere (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  // Created through the company path it is real: the flag stays down.
  const real = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  assert.equal(real.placeholder, false);
  const stored = await app.services.companies.get(real.id);
  assert.equal(isNoCompany(stored), false, 'the stored row is not a placeholder');
  // A contact filed under it names the company in the list …
  const contact = await app.services.contacts.create({
    companyId: real.id, firstName: 'Vera', lastName: 'Azienda', email: 'vera@senzazienda.invalid',
  }, { actor: OPERATOR });
  const list = await app.listCustomers({});
  assert.equal(list.items.find((item) => item.id === contact.id)?.company?.name, 'Senza azienda');
  // … in the profile and in the card …
  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(profile.identity.company?.name, 'Senza azienda');
  const card = shapeCustomerCard(profile, { resource: 'contact', id: contact.id });
  assert.equal(card.company?.name, 'Senza azienda');
  assert.equal(shownCompanyName({ company: { name: 'Senza azienda', placeholder: false } }), 'Senza azienda');
  // … and two real same-named companies still pair as duplicate suspects.
  const twin = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  await app.proposeDataCleanup({ actor: { type: 'agent', id: 'pulizia-test' } });
  const candidates = await app.modules.get('duplicate-candidate').service.list({ limit: 500 });
  assert.ok(
    candidates.some((row) => row.leftResource === 'company' && row.rightResource === 'company'
      && JSON.stringify(row).includes(real.id) && JSON.stringify(row).includes(twin.id)),
    'real same-named companies still pair as duplicates',
  );
});

test('sender resolution never matches a placeholder company by name (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  // The placeholder carries the explicit domain as evidence (review #654),
  // so a sender naming that exact company and domain is the sharp case: the
  // core adapters must hide the placeholder (the portable copy mirrors them).
  const imported = await applyOne(app, { firstName: 'Mario', email: 'mario@acme.example', domain: 'acme.example' }, 'crm-export');
  const contact = await app.services.contacts.get(imported.receipts[0].subject.id);
  const placeholder = await app.services.companies.get(contact.companyId);
  assert.equal(placeholder.placeholder, true);
  assert.equal(placeholder.domain, 'acme.example');
  const answer = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000099',
    companyName: 'Senza azienda', domain: 'acme.example', actor: OPERATOR,
  });
  assert.equal(answer.rule, 'none', 'no company rule fires on a placeholder');
  assert.deepEqual(answer.candidates, [], 'the placeholder is never a resolution candidate');
  assert.equal(answer.contact, null, 'no contact is created from a placeholder match');
});

test('GET /api/companies hides placeholders: the «Nuova offerta» list and the Aziende surfaces pick real companies only (backlog:ece81578305d)', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  // Two contacts without Azienda mint two placeholders behind them …
  await applyOne(app, { firstName: 'Anna', email: 'anna@uno.invalid' });
  await applyOne(app, { firstName: 'Bruno', email: 'bruno@due.invalid' });
  // … beside one real company.
  const real = await app.services.companies.create({ name: 'Palestra Esempio', domain: null }, { actor: OPERATOR });
  assert.equal((await app.services.companies.list({ limit: 50 })).filter((company) => isNoCompany(company)).length, 2);

  const body = await fetch(`${baseUrl}/api/companies?limit=100`).then((response) => response.json());
  assert.ok(Array.isArray(body.items), 'the endpoint answers a list');
  assert.ok(!body.items.some((company) => isNoCompany(company)), 'no placeholder in the company list');
  assert.ok(!body.items.some((company) => company?.name === NO_COMPANY_NAME), 'no row named after the placeholder');
  assert.deepEqual(body.items.map((company) => company.id), [real.id], 'the real company still lists');
});

test('a real company named «Senza azienda» reads as a company everywhere (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  // Created through the company path it is real: the flag stays down.
  const real = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  assert.equal(real.placeholder, false);
  const stored = await app.services.companies.get(real.id);
  assert.equal(isNoCompany(stored), false, 'the stored row is not a placeholder');
  // A contact filed under it names the company in the list …
  const contact = await app.services.contacts.create({
    companyId: real.id, firstName: 'Vera', lastName: 'Azienda', email: 'vera@senzazienda.invalid',
  }, { actor: OPERATOR });
  const list = await app.listCustomers({});
  assert.equal(list.items.find((item) => item.id === contact.id)?.company?.name, 'Senza azienda');
  // … in the profile and in the card …
  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(profile.identity.company?.name, 'Senza azienda');
  const card = shapeCustomerCard(profile, { resource: 'contact', id: contact.id });
  assert.equal(card.company?.name, 'Senza azienda');
  assert.equal(shownCompanyName({ company: { name: 'Senza azienda', placeholder: false } }), 'Senza azienda');
  // … and two real same-named companies still pair as duplicate suspects.
  const twin = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  await app.proposeDataCleanup({ actor: { type: 'agent', id: 'pulizia-test' } });
  const candidates = await app.modules.get('duplicate-candidate').service.list({ limit: 500 });
  assert.ok(
    candidates.some((row) => row.leftResource === 'company' && row.rightResource === 'company'
      && JSON.stringify(row).includes(real.id) && JSON.stringify(row).includes(twin.id)),
    'real same-named companies still pair as duplicates',
  );
});

test('sender resolution never matches a placeholder company by name (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  // The placeholder carries the explicit domain as evidence (review #654),
  // so a sender naming that exact company and domain is the sharp case: the
  // core adapters must hide the placeholder (the portable copy mirrors them).
  const imported = await applyOne(app, { firstName: 'Mario', email: 'mario@acme.example', domain: 'acme.example' }, 'crm-export');
  const contact = await app.services.contacts.get(imported.receipts[0].subject.id);
  const placeholder = await app.services.companies.get(contact.companyId);
  assert.equal(placeholder.placeholder, true);
  assert.equal(placeholder.domain, 'acme.example');
  const answer = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000099',
    companyName: 'Senza azienda', domain: 'acme.example', actor: OPERATOR,
  });
  assert.equal(answer.rule, 'none', 'no company rule fires on a placeholder');
  assert.deepEqual(answer.candidates, [], 'the placeholder is never a resolution candidate');
  assert.equal(answer.contact, null, 'no contact is created from a placeholder match');
});

test('only the internal placeholder path may set the flag (backlog:ac65e448fcb4, review giro 2 P1)', async (t) => {
  const { app } = scene(t);
  // A public create sending the flag gets a real company: the flag stays down.
  const sneaky = await app.services.companies.create(
    { name: 'Acme', domain: null, placeholder: true }, { actor: OPERATOR },
  );
  assert.equal(sneaky.placeholder, false, 'no grant, no flag');
  assert.equal(isNoCompany(await app.services.companies.get(sneaky.id)), false);
  // The trusted internal path sets it, carrying its grant.
  const inner = await app.services.companies.create(
    { name: NO_COMPANY_NAME, domain: null, placeholder: true },
    { actor: OPERATOR, allowPlaceholder: true },
  );
  assert.equal(isNoCompany(await app.services.companies.get(inner.id)), true);
});

test('POST /api/companies refuses the placeholder key with a 400 (backlog:ac65e448fcb4, review giro 2 P1)', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const refused = await fetch(`${baseUrl}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Intrusa', placeholder: true }),
  });
  assert.equal(refused.status, 400, 'the flag never enters over HTTP');
  const accepted = await fetch(`${baseUrl}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Reale Srl', domain: 'reale.invalid' }),
  });
  assert.equal(accepted.status, 201);
  const stored = await app.services.companies.get((await accepted.json()).id);
  assert.equal(isNoCompany(stored), false, 'an HTTP-created company is real');
});

test('a V12-misflagged row is unflagged through company update, the one recovery path (backlog:ac65e448fcb4, review giro 2 P1)', async (t) => {
  const { app } = scene(t);
  const real = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  assert.equal(isNoCompany(real), false, 'created through the company path it is real');
  // The one-time name repair flags by exact name, so a real same-named row
  // is caught too — the privileged update clears it again.
  const flagged = await app.services.companies.update(real.id, { placeholder: true }, { actor: OPERATOR });
  assert.equal(isNoCompany(flagged), true);
  const recovered = await app.services.companies.update(real.id, { placeholder: false }, { actor: OPERATOR });
  assert.equal(isNoCompany(recovered), false, 'the misflagged row reads as a company again');
  assert.equal(isNoCompany(await app.services.companies.get(real.id)), false);
});

test('a company-only import row naming «Senza azienda» takes its own placeholder (backlog:ac65e448fcb4, review giro 2 P2)', async (t) => {
  const { app } = scene(t);
  const result = await applyOne(app, { companyName: 'Senza azienda', externalId: 'X-1' }, 'crm-export');
  const subject = result.receipts[0].subject;
  assert.equal(subject.resource, 'company');
  const company = await app.services.companies.get(subject.id);
  assert.equal(isNoCompany(company), true, 'the reserved name never becomes a visible company');
  const list = await app.listCustomers({});
  assert.ok(!list.items.some((item) => item.id === company.id), 'no standalone row for the reserved name');
});

test('nessuna rotta HTTP cambia placeholder (backlog:ac65e448fcb4, arbitrato 14/11 giro 5)', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const real = await app.services.companies.create({ name: 'Reale Srl', domain: null }, { actor: OPERATOR });
  assert.equal(real.placeholder, false);

  for (const method of ['PATCH', 'PUT']) {
    const response = await fetch(`${baseUrl}/api/companies/${real.id}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ placeholder: true }),
    });
    assert.ok(response.status < 200 || response.status >= 300, `${method} non risponde 2xx`);
    await response.text().catch(() => {});
    assert.equal(isNoCompany(await app.services.companies.get(real.id)), false, `${method} non cambia il flag`);
  }

  const refused = await fetch(`${baseUrl}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Intrusa', placeholder: true }),
  });
  assert.equal(refused.status, 400, 'POST con placeholder resta 400');
});
