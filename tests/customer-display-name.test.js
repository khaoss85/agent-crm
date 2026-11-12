import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  companyDisplayName, contactDisplayName, isPlaceholderCompanyName, labelFromEmail, nameWithoutAddressEchoes,
  readableName, registrableDomain,
} from '../packages/customer-data/src/display-name.js';
import { shapeCustomerRow } from '../packages/customer-data/src/customers.js';
import { contactNamesFor, leadNamesForEmail } from '../packages/customer-data/src/sender.js';
import { shapeCustomerCard } from '../packages/customer-hub/src/card.js';
import { splitGmailDisplayName, parseGmailAddressHeader } from '../packages/channels/src/gmail.js';
import {
  nameFromProfile, readableName as browserReadableName,
} from '../apps/admin/public/admin-labels.js';
import { createCustomerListView } from '../apps/admin/public/admin-clienti.js';
import { shownCompanyName } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * The name a customer is shown by (production 10/11): the
 * Clienti list, the scheda and Oggi printed «Fastweb —», «PayPal Unknown»
 * with «Unknown (assistenza@paypal.it)» under it, and a Google bounce
 * address as the name. One rule (customer-data display-name.js) now runs
 * at read time — the stored records are untouched — and the Gmail intake
 * no longer writes those names for new contacts.
 * Domains are the real brands; the machine local part is anonymized.
 */

const BOUNCE = '9xq7exampletoken42-abc@identity-reachout.bounces.google.com';

const CASES = [
  // [stored first, stored last, email, shown]
  ['Fastweb', '—', 'noreply@fastweb.it', 'Fastweb'],
  ['NOW', '—', 'info@nowtv.it', 'NOW'],
  ['MuscleWiki', '—', 'hello@musclewiki.com', 'MuscleWiki'],
  ['PayPal', 'Unknown', 'assistenza@paypal.it', 'PayPal'],
  ['Unknown', 'unknown', 'assistenza@paypal.it', 'Paypal'],
  ['Mario', 'null', 'mario@esempio.it', 'Mario'],
  ['Anna', 'N/A', 'anna@esempio.it', 'Anna'],
  ['Mittente:', BOUNCE, BOUNCE, 'Google'],
  ['Marco', 'Rossi', 'marco@esempio.it', 'Marco Rossi'],
];

test('the shared rule drops the dash and placeholders and never shows an address', () => {
  for (const [firstName, lastName, email, shown] of CASES) {
    assert.equal(contactDisplayName({ firstName, lastName, email }), shown, `${firstName} ${lastName}`);
  }
  assert.equal(readableName(`Mittente: ${BOUNCE}`), null, 'a name carrying an address names nobody');
  assert.equal(registrableDomain(BOUNCE), 'google.com', 'technical subdomains dropped');
  assert.equal(labelFromEmail(BOUNCE), 'Google');
  assert.equal(labelFromEmail('ordini@shop.amazon.co.uk'), 'Amazon', 'two-level public suffix');
  assert.equal(labelFromEmail('mario.rossi@gmail.com'), 'Mario Rossi', 'a personal mailbox never reads «Gmail»');
  assert.equal(labelFromEmail('x9f8e7d6c5@gmail.com'), null, 'a machine local part at a personal mailbox names nobody');
  assert.equal(labelFromEmail('not-an-address'), null);
  assert.equal(isPlaceholderCompanyName('Unknown (assistenza@paypal.it)'), true);
  assert.equal(isPlaceholderCompanyName('Palestra Esempio (Milano)'), false);
});

test('the browser twin reads every stored name exactly like the package rule', () => {
  const samples = [
    ...CASES.map(([first, last]) => `${first} ${last}`),
    'Fastweb —', 'PayPal Unknown', 'Unknown', '—', '', '  ', BOUNCE, `Mittente: ${BOUNCE}`, 'Studio Ä Ñ', 'none',
    'Studio @ Home', 'Caffè @ Roma', '@studio', 'x@y', `<${BOUNCE}>`, `"${BOUNCE}"`,
  ];
  for (const sample of samples) {
    assert.equal(browserReadableName(sample), readableName(sample), JSON.stringify(sample));
  }
});

test('the Clienti row: name without dash or placeholder, a placeholder company reads as none', () => {
  const row = (contact, company) => shapeCustomerRow({ contact: { id: 'c1', companyId: 'co1', ...contact }, company }, {});
  assert.equal(row({ firstName: 'Vercel', lastName: '—', email: 'ship@vercel.com' }, { id: 'co1', name: 'Senza azienda' }).name, 'Vercel');
  const paypal = row({ firstName: 'PayPal', lastName: 'Unknown', email: 'assistenza@paypal.it' },
    { id: 'co1', name: 'Unknown (assistenza@paypal.it)' });
  assert.equal(paypal.name, 'PayPal');
  assert.equal(paypal.company, null, '«Unknown (…)» is no company');
  assert.equal(paypal.email, 'assistenza@paypal.it');
  const google = row({ firstName: 'Mittente:', lastName: BOUNCE, email: BOUNCE }, { id: 'co1', name: 'Senza azienda' });
  assert.equal(google.name, 'Google');
  const real = row({ firstName: 'Marco', lastName: 'Rossi', email: 'marco@esempio.it' }, { id: 'co1', name: 'Palestra Esempio' });
  assert.equal(real.name, 'Marco Rossi');
  assert.deepEqual({ ...real.company }, { id: 'co1', name: 'Palestra Esempio' });
});

test('the Clienti screen shows the email under a name with no company, never «Unknown (…)»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const items = [{
    resource: 'contact', id: 'c1', name: 'PayPal', company: null, email: 'assistenza@paypal.it',
    phone: null, channels: ['gmail'], status: { value: 'contatto', reason: 'x' },
    lastContactAt: null, lastContactChannel: null, offerValueCents: null, offerCurrency: null, nextStep: null,
    budget: { available: false, value: null, source: null, reason: 'x' },
  }];
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return { customerListContract: 1, items, total: 1, page: 1, pageSize: 10, pages: 1, totalIsExact: true };
    },
  };
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const view = createCustomerListView({ doc, mount, client, storage: store, notify: () => {} });
  await view.render();
  const row = mount.findAll('article').find((node) => node.getAttribute('data-customer') === 'contact:c1');
  assert.ok(row, 'the row renders');
  const sub = row.findAll('span').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-sub'));
  assert.equal(sub?.textContent, 'assistenza@paypal.it');
  assert.ok(!row.textContent.includes('Unknown'));
});

test('the scheda reads the provider display name, and a legacy profile still joins', () => {
  const section = (available) => ({ available, count: 0, items: [] });
  const sections = {
    externalIdentities: [], subscriptions: section(false), orders: section(false), contracts: section(false),
    opportunities: section(false), quotes: section(false),
    status: { value: 'contatto', reason: 'no signed business' },
  };
  const card = shapeCustomerCard({
    ...sections,
    identity: { displayName: 'Google', contact: { firstName: 'Mittente:', lastName: BOUNCE, email: BOUNCE }, company: null },
  }, { resource: 'contact', id: 'c1' });
  assert.equal(card.name, 'Google');
  const legacy = shapeCustomerCard({
    ...sections,
    identity: { contact: { firstName: 'Marco', lastName: 'Rossi', email: 'marco@esempio.it' }, company: null },
  }, { resource: 'contact', id: 'c1' });
  assert.equal(legacy.name, 'Marco Rossi');
});

test('Oggi and Calendario read the profile display name', () => {
  assert.equal(nameFromProfile({ identity: { displayName: 'Fastweb', contact: { firstName: 'Fastweb', lastName: '—' } } }), 'Fastweb');
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'Mittente:', lastName: BOUNCE } } }), null,
    'a legacy profile never prints the address');
});

test('the stored records stay as they are and the card reads them clean end to end', async (t) => {
  const root = project(t, {});
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    'const customerData = createCustomerDataPackage();',
    'export const generatedDomains = [',
    '  customerData,',
    '  createCustomerHubPackage({ customerData }),',
    '];',
    '',
  ].join('\n'));
  const context = await boot(root, join(root, 'data', 'display-name.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'reviewer' };
  const company = await app.services.companies.create({ name: 'Unknown (assistenza@paypal.it)' }, { actor });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'PayPal', lastName: 'Unknown', email: 'assistenza@paypal.it',
  }, { actor });
  const card = await app.readCustomerCard({ resource: 'contact', id: contact.id });
  assert.equal(card.name, 'PayPal');
  assert.equal(card.company, null, 'the placeholder company is not shown');
  const stored = await app.services.contacts.get(contact.id);
  assert.equal(stored.lastName, 'Unknown', 'the cure is at read time: the record is untouched');
});

test('new contacts from Gmail are born with a readable name', () => {
  assert.deepEqual(splitGmailDisplayName(`Mittente: ${BOUNCE}`), { firstName: null, lastName: null },
    'a display name carrying an address names nobody');
  const parsed = parseGmailAddressHeader(`"${BOUNCE}" <${BOUNCE}>`);
  assert.equal(parsed.firstName, null);
  assert.deepEqual(leadNamesForEmail(BOUNCE), { firstName: 'Google', lastName: '—' },
    'a machine mailbox takes its domain label, never the token');
  assert.deepEqual(leadNamesForEmail('noreply@fastweb.it'), { firstName: 'Fastweb', lastName: '—' });
  assert.deepEqual(leadNamesForEmail('mario.rossi@azienda.it'), { firstName: 'Mario', lastName: 'Rossi' });
  assert.deepEqual(contactNamesFor({ firstName: 'Fastweb', lastName: null, email: 'info.clienti@fastweb.it' }),
    { firstName: 'Fastweb', lastName: '—' }, 'a brand never borrows a mailbox word as surname');
  assert.deepEqual(contactNamesFor({ firstName: 'Mario', lastName: null, email: 'mario.rossi@azienda.it' }),
    { firstName: 'Mario', lastName: 'Rossi' }, 'an agreeing first name keeps the surname from the address');
  assert.deepEqual(contactNamesFor({ firstName: 'PayPal', lastName: 'Unknown', email: 'assistenza@paypal.it' }),
    { firstName: 'PayPal', lastName: '—' }, 'a placeholder never becomes a stored surname');
});

test('review #739 P2: only an address-shaped word hides a name, never a lone @', () => {
  assert.equal(readableName('Studio @ Home'), 'Studio @ Home');
  assert.equal(contactDisplayName({ firstName: 'Studio', lastName: '@ Home', email: 'info@studio.it' }), 'Studio @ Home');
  assert.equal(isPlaceholderCompanyName('Caffè @ Roma'), false);
  assert.equal(readableName(`<${BOUNCE}>`), null, 'a bracketed address is still an address');
});

test('review #739 P1: a name that is only the token of its technical address is no name', () => {
  // Intake still stores a non-empty first name (the core requires one); the
  // reader never shows the token, old records included.
  assert.deepEqual(leadNamesForEmail('x9f8e7d6c5@gmail.com'), { firstName: 'X9f8e7d6c5', lastName: '—' });
  const stored = contactNamesFor({ email: 'x9f8e7d6c5@gmail.com' });
  assert.equal(contactDisplayName({ ...stored, email: 'x9f8e7d6c5@gmail.com' }), null,
    'a personal mailbox token: no name, the screen says «senza nome»');
  assert.equal(contactDisplayName({ firstName: '9xq7exampletoken42', lastName: 'Abc', email: BOUNCE }), 'Google',
    'a token stored before this PR reads the domain label');
  assert.equal(contactDisplayName({ firstName: 'Mario', lastName: 'Rossi', email: 'x9f8e7d6c5@gmail.com' }), 'Mario Rossi',
    'a real name beside a token address stays');
});

test('review #739 P3: a placeholder company subject and a legacy profile never show the placeholder or an address', () => {
  assert.equal(companyDisplayName({ name: 'Unknown (assistenza@paypal.it)' }), null);
  assert.equal(companyDisplayName({ name: ' Palestra Esempio ' }), 'Palestra Esempio');
  const row = shapeCustomerRow({ contact: null, company: { id: 'co9', name: 'Unknown (assistenza@paypal.it)' } }, {});
  assert.equal(row.name, null, 'the list then says «Cliente senza nome»');
  const section = (available) => ({ available, count: 0, items: [] });
  const legacy = shapeCustomerCard({
    externalIdentities: [], subscriptions: section(false), orders: section(false), contracts: section(false),
    opportunities: section(false), quotes: section(false), status: { value: 'contatto', reason: 'x' },
    identity: { contact: { firstName: 'Mittente:', lastName: BOUNCE, email: BOUNCE }, company: null },
  }, { resource: 'contact', id: 'c1' });
  assert.equal(legacy.name, null, 'a legacy profile never prints the bounce address');
});

test('review #739 giro 2: human handles with a number stay people, Oggi honors the provider null, Gmail keeps a lone @', () => {
  for (const email of ['marco123@azienda.it', 'mario.rossi123@azienda.it', 'giuseppe1985@azienda.it']) {
    assert.notEqual(leadNamesForEmail(email).firstName, 'Azienda', email);
  }
  assert.deepEqual(leadNamesForEmail('mario.rossi123@azienda.it'), { firstName: 'Mario', lastName: 'Rossi123' });
  assert.equal(contactDisplayName({ firstName: 'Marco123', lastName: 'Rossi', email: 'marco123@azienda.it' }), 'Marco123 Rossi');
  assert.equal(leadNamesForEmail(BOUNCE).firstName, 'Google', 'a generated id is still technical');
  assert.equal(nameFromProfile({ identity: { displayName: null, contact: { firstName: 'X9f8e7d6c5', lastName: '—' } } }), null,
    'Oggi and Calendario read the same «no name» as the scheda');
  assert.deepEqual(splitGmailDisplayName('Studio @ Home'), { firstName: 'Studio', lastName: '@ Home' });
  assert.deepEqual(splitGmailDisplayName(`<${BOUNCE}>`), { firstName: null, lastName: null });
});

// Follow-up of review #739 giro 3: the three P2 left as seguito.

const LEGACY_SECTIONS = () => {
  const section = (available) => ({ available, count: 0, items: [] });
  return {
    externalIdentities: [], subscriptions: section(false), orders: section(false), contracts: section(false),
    opportunities: section(false), quotes: section(false), status: { value: 'contatto', reason: 'x' },
  };
};

test('seguito #739 (1): a legacy profile card drops placeholders exactly like the provider rule', () => {
  const card = (contact) => shapeCustomerCard({ ...LEGACY_SECTIONS(), identity: { contact, company: null } },
    { resource: 'contact', id: 'c1' }).name;
  assert.equal(card({ firstName: 'PayPal', lastName: 'Unknown', email: 'assistenza@paypal.it' }), 'PayPal');
  assert.equal(card({ firstName: 'Fastweb', lastName: '—', email: 'noreply@fastweb.it' }), 'Fastweb');
  const samples = [...CASES.map(([first, last]) => [first, last]), ['Studio', '@ Home'], ['Unknown', 'unknown'], ['N/A', 'null']];
  for (const [firstName, lastName] of samples) {
    assert.equal(card({ firstName, lastName, email: 'x@esempio.it' }), readableName(`${firstName} ${lastName}`),
      `${firstName} ${lastName}: the hub restates the provider rule`);
  }
  const company = shapeCustomerCard({ ...LEGACY_SECTIONS(), identity: { contact: null, company: { id: 'co9', name: 'Unknown (assistenza@paypal.it)' } } },
    { resource: 'company', id: 'co9' });
  assert.equal(company.name, null, 'a legacy placeholder company names nobody');
});

test('seguito #739 (2): a machine mailbox at a personal provider names nobody', () => {
  for (const email of ['noreply@gmail.com', 'bounces@outlook.com', 'mailer-daemon@libero.it', 'notifications@icloud.com']) {
    assert.equal(labelFromEmail(email), null, email);
    const stored = contactNamesFor({ email });
    assert.equal(contactDisplayName({ ...stored, email }), null, `${email}: never «Noreply» as a person`);
  }
  assert.equal(labelFromEmail('mario.rossi@gmail.com'), 'Mario Rossi', 'a human personal mailbox still reads');
});

test('seguito #739 (3): a company subject named by a placeholder shows no company line', () => {
  const row = shapeCustomerRow({ contact: null, company: { id: 'co9', name: 'Unknown (assistenza@paypal.it)' } }, {});
  assert.equal(row.name, null);
  assert.equal(row.company, null, 'the Clienti subtitle never prints «Unknown (…)»');
  assert.equal(row.id, 'co9', 'the row keeps its record');
  const real = shapeCustomerRow({ contact: null, company: { id: 'co1', name: 'Palestra Esempio' } }, {});
  assert.deepEqual({ ...real.company }, { id: 'co1', name: 'Palestra Esempio' });
  assert.equal(shownCompanyName({ company: { id: 'co9', name: 'Unknown (assistenza@paypal.it)' } }), null,
    'the scheda header drops the placeholder too');
  assert.equal(shownCompanyName({ company: { id: 'co1', name: 'Caffè @ Roma' } }), 'Caffè @ Roma');
});

// Production check 10/11 16:48Z, Clienti: names carrying pieces of the
// address. Domains are the real brands; the branch number is invented.
const ADDRESS_PIECES = [
  // [stored first, stored last, email, shown]
  ['Amazon.it', 'It', 'conferma-spedizione@amazon.it', 'Amazon.it'],
  ['UniCredit', 'S.p.A. Noreply', 'noreply@unicredit.it', 'UniCredit S.p.A.'],
  ['Whirlpool', 'Servizio Assistenza NO-REPLY', 'no-reply@whirlpool.com', 'Whirlpool Servizio Assistenza'],
  ['filiale_458', '—', 'filiale_458@bancaesempio.it', 'Bancaesempio'],
];

test('seguito #743: no-reply suffixes, address echoes and mailbox ids never reach the name', () => {
  for (const [firstName, lastName, email, shown] of ADDRESS_PIECES) {
    assert.equal(contactDisplayName({ firstName, lastName, email }), shown, `${firstName} ${lastName}`);
    const row = shapeCustomerRow({ contact: { id: 'c1', companyId: 'co1', firstName, lastName, email }, company: { id: 'co1', name: 'Senza azienda' } }, {});
    assert.equal(row.name, shown, `Clienti row: ${firstName} ${lastName}`);
  }
  // Real names keep those words when they are not a suffix, an echo or an id.
  assert.equal(contactDisplayName({ firstName: 'Studio', lastName: 'Noreply Design', email: 'info@studio.it' }), 'Studio Noreply Design');
  assert.equal(contactDisplayName({ firstName: 'Amazon', lastName: '—', email: 'x@amazon.it' }), 'Amazon', 'a first mention of the domain stays');
  assert.equal(contactDisplayName({ firstName: 'Mario', lastName: 'De Rossi', email: 'mario@rossi.de' }), 'Mario De Rossi');
  assert.equal(contactDisplayName({ firstName: 'Filiale', lastName: '458', email: 'x@banca.it' }), 'Filiale 458', 'a number alone is not an id');
});

test('seguito #743: new senders are born without those pieces', () => {
  assert.deepEqual(contactNamesFor({ firstName: 'Amazon.it', lastName: 'It', email: 'conferma-spedizione@amazon.it' }),
    { firstName: 'Amazon.it', lastName: '—' });
  assert.deepEqual(contactNamesFor({ firstName: 'UniCredit', lastName: 'S.p.A. Noreply', email: 'noreply@unicredit.it' }),
    { firstName: 'UniCredit', lastName: 'S.p.A.' });
  assert.deepEqual(contactNamesFor({ firstName: 'Whirlpool', lastName: 'NO-REPLY', email: 'no-reply@whirlpool.com' }),
    { firstName: 'Whirlpool', lastName: '—' });
});

test('seguito #743: the browser and hub twins drop the same suffixes and ids', () => {
  const samples = ['UniCredit S.p.A. Noreply', 'Whirlpool Servizio Assistenza NO-REPLY', 'filiale_458', 'filiale_458 —',
    'Studio Noreply Design', 'Banca (no-reply)', 'Noreply', 'Ufficio DoNotReply'];
  for (const sample of samples) {
    assert.equal(browserReadableName(sample), readableName(sample), `browser: ${sample}`);
    const card = shapeCustomerCard({ ...LEGACY_SECTIONS(), identity: { contact: { firstName: sample, lastName: '' }, company: null } },
      { resource: 'contact', id: 'c1' }).name;
    assert.equal(card, readableName(sample), `hub: ${sample}`);
  }
});

// Seguito P3 di #743 (backlog:2a5f23b00f6f): the copies of the rule that
// the hub (legacy profile) and the browser (nameFromProfile fallback) keep
// apply every step the package applies to a stored name, address echoes
// included; arrival drops echoes field by field.

const STORED = [
  // [first, last, email]
  ['Amazon.it', 'It', 'conferma-spedizione@amazon.it'],
  ['Amazon.it It', '', 'conferma-spedizione@amazon.it'],
  ['Amazon.it', 'It Rossi', 'conferma-spedizione@amazon.it'],
  ['Fastweb', 'Fastweb', 'info@fastweb.it'],
  ['Mario', 'De Rossi', 'mario@rossi.de'],
  ['Amazon', '—', 'x@amazon.it'],
  ['UniCredit', 'S.p.A. Noreply', 'noreply@unicredit.it'],
  ['PayPal', 'Unknown', 'assistenza@paypal.it'],
  ['filiale_458', '—', 'filiale_458@bancaesempio.it'],
  ['Studio', '@ Home', 'info@studio.it'],
  ['Mittente:', BOUNCE, BOUNCE],
  ['Unknown', 'null', 'x@esempio.it'],
];

test('seguito P3 #743 (1): hub and browser copies read a legacy stored name exactly like the package', () => {
  for (const [firstName, lastName, email] of STORED) {
    const read = readableName(`${firstName} ${lastName}`);
    const expected = read === null ? null : nameWithoutAddressEchoes(read, email);
    const hub = shapeCustomerCard({ ...LEGACY_SECTIONS(), identity: { contact: { firstName, lastName, email }, company: null } },
      { resource: 'contact', id: 'c1' }).name;
    const browser = nameFromProfile({ identity: { contact: { firstName, lastName, email }, company: null } });
    assert.equal(hub, expected, `hub: ${firstName} ${lastName}`);
    assert.equal(browser, expected, `browser: ${firstName} ${lastName}`);
  }
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'Amazon.it', lastName: 'It', email: 'a@amazon.it' } } }), 'Amazon.it');
});

test('seguito P3 #743 (2): arrival drops a repeated piece even inside the last name, never a real name', () => {
  const email = 'conferma-spedizione@amazon.it';
  assert.deepEqual(contactNamesFor({ firstName: 'Amazon.it', lastName: 'It Rossi', email }), { firstName: 'Amazon.it', lastName: 'Rossi' });
  assert.deepEqual(contactNamesFor({ firstName: 'Amazon.it It', lastName: null, email }), { firstName: 'Amazon.it', lastName: '—' });
  assert.deepEqual(contactNamesFor({ firstName: 'Fastweb', lastName: 'Fastweb', email: 'info@fastweb.it' }), { firstName: 'Fastweb', lastName: '—' });
  assert.deepEqual(contactNamesFor({ firstName: 'Mario', lastName: 'De Rossi', email: 'mario@rossi.de' }), { firstName: 'Mario', lastName: 'De Rossi' });
  assert.deepEqual(contactNamesFor({ firstName: 'Mario', lastName: null, email: 'mario.rossi@azienda.it' }), { firstName: 'Mario', lastName: 'Rossi' });
});
