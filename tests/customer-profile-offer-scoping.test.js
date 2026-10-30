import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **One customer's offer is never another customer's offer.**
 *
 * The scheda cliente names one commercial line per customer from the
 * consolidated profile. A quote reaches its customer through one explicit
 * hop — its opportunity — and an opportunity scoped to one contact
 * (`contactId` set) belongs to that contact's card only: a company match
 * must not leak it onto a company-mate's card, or every card in the
 * company shows the same offer. A company-scoped opportunity (no contact)
 * belongs to every card under that company, and a company card keeps the
 * wide rule (everything under it, contact-scoped included).
 */

const ACTOR = { type: 'user', id: 'offer-scoping' };

function insertQuote(db, id, opportunityId, status) {
  db.prepare(`INSERT INTO quotes (id, opportunity_id, price_book_id, currency, status, draft_revision, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, opportunityId, 'pb-1', 'EUR', status, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

test('a contact-scoped offer shows on its contact card only, a company-scoped one on every card under it', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-scoping.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const company = await app.services.companies.create({ name: 'Palestra', domain: 'palestra.example' }, { actor: ACTOR });
  const ada = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra.example' }, { actor: ACTOR });
  const bea = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Bea', lastName: 'Bianchi', email: 'bea@palestra.example' }, { actor: ACTOR });

  const adaOpportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: ada.id, name: 'Pacchetto Ada', valueCents: 10000, currency: 'EUR', owner: 'rep' },
    { actor: ACTOR });
  insertQuote(db, 'quote-ada-1', adaOpportunity.id, 'approved');

  const companyOpportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Pacchetto sede', valueCents: 5000, currency: 'EUR', owner: 'rep' },
    { actor: ACTOR });
  insertQuote(db, 'quote-co-1', companyOpportunity.id, 'draft');

  const adaProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: ada.id });
  assert.deepEqual(
    adaProfile.opportunities.items.map((item) => item.id).sort(),
    [adaOpportunity.id, companyOpportunity.id].sort(),
    "Ada's card holds her contact-scoped opportunity and the company one");
  assert.deepEqual(
    adaProfile.quotes.items.map((item) => item.id).sort(),
    ['quote-ada-1', 'quote-co-1'].sort(),
    "Ada's card holds both quotes");
  const adaQuote = adaProfile.quotes.items.find((item) => item.id === 'quote-ada-1');
  assert.equal(adaQuote.opportunityId, adaOpportunity.id, 'a quote item names the opportunity it was made for');
  assert.equal(adaQuote.opportunityName, 'Pacchetto Ada', 'a quote item carries its opportunity name for the scheda');

  const beaProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: bea.id });
  assert.deepEqual(
    beaProfile.opportunities.items.map((item) => item.id),
    [companyOpportunity.id],
    "Bea's card holds only the company-scoped opportunity, never Ada's contact-scoped one");
  assert.deepEqual(
    beaProfile.quotes.items.map((item) => item.id),
    ['quote-co-1'],
    "Bea's card never shows Ada's quote");

  const companyProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: company.id });
  assert.deepEqual(
    companyProfile.opportunities.items.map((item) => item.id).sort(),
    [adaOpportunity.id, companyOpportunity.id].sort(),
    'a company card keeps the wide rule: everything under it, contact-scoped included');
  assert.deepEqual(
    companyProfile.quotes.items.map((item) => item.id).sort(),
    ['quote-ada-1', 'quote-co-1'].sort(),
    'a company card holds every quote under it');
});

/**
 * Voce cc525cd6a3c5 (review head 02e64495, P2): opportunity records expose
 * `stage`, never `status` — the profile item must still carry a renderable
 * state, or the scheda opportunity-fallback offer line reads the bare name
 * with no Italian state. Built through readCustomerProfile with a real
 * staged opportunity and no quotes, never a hand-injected status.
 */
test('an opportunity-only card carries the opportunity stage as its item status', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-stage.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const company = await app.services.companies.create({ name: 'Palestra', domain: 'palestra.example' }, { actor: ACTOR });
  const ada = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra.example' }, { actor: ACTOR });

  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: ada.id, name: 'Pacchetto Ada', valueCents: 10000, currency: 'EUR', owner: 'rep', stage: 'proposal' },
    { actor: ACTOR });
  assert.equal(opportunity.stage, 'proposal', 'the stored record carries a stage, never a status');
  assert.ok(!('status' in opportunity) || opportunity.status == null, 'a real opportunity row has no status to copy');

  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: ada.id });
  assert.deepEqual(
    profile.quotes.items.map((item) => item.id),
    [],
    'no quotes: the scheda falls back to the opportunity line');
  assert.equal(profile.opportunities.items.length, 1, "Ada's card holds her opportunity");
  assert.equal(
    profile.opportunities.items[0].status,
    'proposal',
    'the opportunity item carries its stage as status, so the scheda reads «Pacchetto Ada · proposta»');
});
