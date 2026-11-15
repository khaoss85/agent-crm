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
 * company shows the same offer. Voce 1e89d516cfc3: a company-scoped
 * opportunity (no contact) belongs to the company card only, never to a
 * contact card under it — or, with every Presti contact under one company,
 * every card shows the same offer. A company card keeps the wide rule
 * (everything under it, contact-scoped included).
 */

const ACTOR = { type: 'user', id: 'offer-scoping' };

function insertQuote(db, id, opportunityId, status) {
  db.prepare(`INSERT INTO quotes (id, opportunity_id, price_book_id, currency, status, draft_revision, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, opportunityId, 'pb-1', 'EUR', status, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

test('a contact-scoped offer shows on its contact card only, a company-scoped one on the company card only', async (t) => {
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
  // Voce 59def6cb805d (C25): a one-time quote carries its server total; a
  // quote with recurring groups carries none.
  db.prepare('UPDATE quotes SET one_time_net_cents = ?, recurring_group_count = ? WHERE id = ?').run(27500, 0, 'quote-ada-1');
  db.prepare('UPDATE quotes SET one_time_net_cents = ?, recurring_group_count = ? WHERE id = ?').run(9000, 1, 'quote-co-1');

  // Voce 1e89d516cfc3: a contact card holds only its contact's offers — a
  // company-linked opportunity (and its quotes) belongs to the company
  // card, never to a contact card under it.
  const adaProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: ada.id });
  assert.deepEqual(
    adaProfile.opportunities.items.map((item) => item.id).sort(),
    [adaOpportunity.id].sort(),
    "Ada's card holds her contact-scoped opportunity, never the company one");
  assert.deepEqual(
    adaProfile.quotes.items.map((item) => item.id).sort(),
    ['quote-ada-1'].sort(),
    "Ada's card holds her quote, never the company one");
  const adaQuote = adaProfile.quotes.items.find((item) => item.id === 'quote-ada-1');
  assert.equal(adaQuote.opportunityId, adaOpportunity.id, 'a quote item names the opportunity it was made for');
  assert.equal(adaQuote.opportunityName, 'Pacchetto Ada', 'a quote item carries its opportunity name for the scheda');
  assert.equal(adaQuote.amountCents, 27500, 'a one-time quote carries its server total');
  assert.equal(adaQuote.currency, 'EUR');
  const adaOpportunityItem = adaProfile.opportunities.items.find((item) => item.id === adaOpportunity.id);
  assert.equal(adaOpportunityItem.amountCents, 10000, 'an opportunity carries its value');
  assert.equal(adaOpportunityItem.currency, 'EUR');

  const beaProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: bea.id });
  assert.deepEqual(
    beaProfile.opportunities.items.map((item) => item.id),
    [],
    "Bea's card holds no opportunity: neither Ada's contact-scoped one nor the company one");
  assert.deepEqual(
    beaProfile.quotes.items.map((item) => item.id),
    [],
    "Bea's card never shows Ada's quote nor the company one");

  const companyProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: company.id });
  assert.deepEqual(
    companyProfile.opportunities.items.map((item) => item.id).sort(),
    [adaOpportunity.id, companyOpportunity.id].sort(),
    'a company card keeps the wide rule: everything under it, contact-scoped included');
  assert.deepEqual(
    companyProfile.quotes.items.map((item) => item.id).sort(),
    ['quote-ada-1', 'quote-co-1'].sort(),
    'a company card holds every quote under it');
  const companyQuote = companyProfile.quotes.items.find((item) => item.id === 'quote-co-1');
  assert.equal(companyQuote.amountCents, null, 'a quote with recurring groups carries no single total');
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

/**
 * Backlog 1e89d516cfc3 (recidiva di cc525cd6a3c5, verifica 07/11 21:53Z su
 * Presti Group): an offer linked to the company only (empty contactId, like
 * production offer 3795a020 «Proposta esempio — Pacchetto 10 PT») showed on
 * every contact card under that company — Ada Rossi, Bea Bianchi and
 * Fio Neri all read the same OFFERTA line. A contact card shows only its
 * contact's offers (its contact-scoped opportunities and the quotes hopping
 * through them); a company-linked offer belongs to the company card. Two
 * contacts in the same company, production-shaped ids.
 */
test('a company-linked offer never shows on a contact card, only on the company card', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-company-link.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const company = await app.services.companies.create({ name: 'Presti Group', domain: 'presti.example' }, { actor: ACTOR });
  const ada = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@presti.example' }, { actor: ACTOR });
  const bea = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Bea', lastName: 'Bianchi', email: 'bea@presti.example' }, { actor: ACTOR });

  // Production shape: linked to the company only, no contact.
  const companyOpportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Proposta esempio — Pacchetto 10 PT', valueCents: 35000, currency: 'EUR', owner: 'rep', stage: 'proposal' },
    { actor: ACTOR });
  assert.equal(companyOpportunity.contactId ?? null, null, 'the fixture is company-linked, like the production offer');
  insertQuote(db, 'quote-co-1', companyOpportunity.id, 'approved');

  for (const contact of [ada, bea]) {
    const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: contact.id });
    assert.deepEqual(
      profile.opportunities.items.map((item) => item.id),
      [],
      `${contact.id}'s card never shows the company-linked opportunity`);
    assert.deepEqual(
      profile.quotes.items.map((item) => item.id),
      [],
      `${contact.id}'s card never shows the company-linked quote`);
  }

  const companyProfile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: company.id });
  assert.deepEqual(
    companyProfile.opportunities.items.map((item) => item.id),
    [companyOpportunity.id],
    'the company card still shows the company-linked opportunity');
  assert.deepEqual(
    companyProfile.quotes.items.map((item) => item.id),
    ['quote-co-1'],
    'the company card still shows the company-linked quote');
});

/**
 * Backlog a551982c06eb: an approved quote on an offer in «Proposta» read
 * «approvata» on the scheda, while the Pipeline board and the offer detail
 * said «Proposta». The quote item carries its opportunity's stage and
 * pipeline placement, and the opportunity item its own, so the scheda can
 * say the sale's stage with the board's words.
 */
test('a quote item carries its opportunity stage and pipeline placement', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-pipeline-stage.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const company = await app.services.companies.create({ name: 'Palestra', domain: 'palestra.example' }, { actor: ACTOR });
  const ada = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra.example' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: ada.id, name: 'Pacchetto Ada', valueCents: 10000, currency: 'EUR', owner: 'rep' },
    { actor: ACTOR });
  await app.services.opportunities.applyManaged(
    opportunity.id, { pipelineKey: 'accordo-sales', pipelineStage: 'proposta' }, { actor: ACTOR });
  insertQuote(db, 'quote-ada-1', opportunity.id, 'approved');

  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: ada.id });
  const quote = profile.quotes.items.find((item) => item.id === 'quote-ada-1');
  assert.equal(quote.status, 'approved', 'the quote keeps its own approval state');
  assert.equal(quote.opportunityStage, 'qualification', 'the quote item carries its opportunity core stage');
  assert.equal(quote.opportunityPipelineKey, 'accordo-sales');
  assert.equal(quote.opportunityPipelineStage, 'proposta', 'the quote item carries its opportunity pipeline stage');
  const item = profile.opportunities.items.find((row) => row.id === opportunity.id);
  assert.equal(item.stage, 'qualification');
  assert.equal(item.pipelineKey, 'accordo-sales');
  assert.equal(item.pipelineStage, 'proposta', 'the opportunity item carries its pipeline stage');
});

/**
 * Voce 1e89d516cfc3, review giro 2 (P2 sulla testa c28bebaa): the empty-hop
 * probe must carry no NUL byte. PostgreSQL rejects NUL in text parameters,
 * so a NUL-bearing probe throws on the supported PostgreSQL adapter instead
 * of answering zero rows — and the suppressed error leaves the section
 * `available: false`, the same «offerte non disponibili» this change fixes.
 * Proved through a contact with no opportunities behind a PostgreSQL-like
 * `listWhere` that refuses NUL the way PostgreSQL does: the quotes section
 * still reads available with zero rows.
 */
test('an empty-hop probe carries no NUL byte: a PostgreSQL-like store still reads zero quotes, never unavailable', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-empty-hop-pg.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const company = await app.services.companies.create({ name: 'Palestra', domain: 'palestra.example' }, { actor: ACTOR });
  const bea = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Bea', lastName: 'Bianchi', email: 'bea@palestra.example' }, { actor: ACTOR });

  const quoteService = app.modules.get('quote').service;
  const realListWhere = quoteService.listWhere.bind(quoteService);
  quoteService.listWhere = async (filters) => {
    for (const value of Object.values(filters)) {
      const values = Array.isArray(value) ? value : [value];
      for (const one of values) {
        if (typeof one === 'string' && one.includes('\0')) {
          throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
        }
      }
    }
    return realListWhere(filters);
  };
  t.after(() => { quoteService.listWhere = realListWhere; });

  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: bea.id });
  assert.equal(profile.quotes.available, true, 'zero quotes reads available, never unavailable, on a NUL-refusing store');
  assert.deepEqual(profile.quotes.items, [], 'a contact with no opportunities holds no quote');
  assert.equal(profile.quotes.count, 0);
});

// backlog:82235e46e3e9 (review Muse #793): the scheda cronologia shows when
// each offer was created, and «Storia stati» names its referente — so the
// profile carries both, read from the opportunity record itself.
test('82235e46e3e9: profile opportunities carry the record createdAt and owner', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'offer-created-at.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const company = await app.services.companies.create({ name: 'Palestra', domain: 'palestra.example' }, { actor: ACTOR });
  const ada = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra.example' }, { actor: ACTOR });
  const created = await app.services.opportunities.create(
    { companyId: company.id, contactId: ada.id, name: 'Pacchetto Ada', valueCents: 10000, currency: 'EUR', owner: 'Elena Rinaldi' },
    { actor: ACTOR });
  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'contact', id: ada.id });
  const row = profile.opportunities.items.find((item) => item.id === created.id);
  assert.ok(row, 'the offer is on the card');
  assert.equal(row.createdAt, created.createdAt, 'the record creation time');
  assert.ok(Number.isFinite(Date.parse(row.createdAt)));
  assert.equal(row.owner, 'Elena Rinaldi', 'the referente');
});
