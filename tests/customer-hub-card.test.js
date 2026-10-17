import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shapeCustomerCard } from '../packages/customer-hub/src/card.js';
import { renderCustomerCardHtml } from '../packages/customer-hub/src/render.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **The customer card: the readable projection with no master record.**
 *
 * What it must prove: the card shows the listed fields from records the
 * application already owns (the host contact, channel identities held beside
 * it, the consolidated profile) — and reading it creates nothing. No master
 * customer table appears, no row count moves, and the package itself declares
 * zero owned resources. A space that does not compose the package has no card
 * operation at all: enablement is composition, not a flag.
 */

const ACTOR = { type: 'user', id: 'reviewer' };
const EMAIL = 'guido@palestra-esempio.it';

function row(externalId) {
  return {
    externalId, email: EMAIL, firstName: 'Guido', lastName: 'Presti',
    companyName: 'Palestra Esempio', domain: 'palestra-esempio.it',
  };
}

/** The same project as the customer-data helper, plus the hub composed. */
function projectWithHub(t) {
  const root = project(t, {});
  const path = join(root, 'packages/domains/generated/index.js');
  const before = readFileSync(path, 'utf8');
  assert.ok(before.includes('createCustomerDataPackage()'), 'helper composes customer-data');
  writeFileSync(path, before
    .replace(
      "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
      "import { createCustomerDataPackage } from '../../customer-data/src/index.js';\nimport { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    )
    .replace('  createCustomerDataPackage(),', '  createCustomerDataPackage(),\n  createCustomerHubPackage(),'));
  return root;
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
}

function counts(db) {
  const out = {};
  for (const table of tables(db)) {
    out[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  return out;
}

test('the card reads name, phone, email, socials and status from reused records', async (t) => {
  const root = projectWithHub(t);
  const context = await boot(root, join(root, 'data', 'hub-card.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  await app.applyCustomerImport({ actor: ACTOR, system: 'instagram', rows: [row('guido.presti')] });

  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1, 'the second source matched the same contact — no parallel record');
  const card = await app.readCustomerCard({ resource: 'contact', id: contacts[0].id });

  assert.equal(card.customerCardContract, 1);
  assert.equal(card.name, 'Guido Presti');
  assert.equal(card.email, EMAIL);
  assert.equal(card.phone.available, true);
  assert.equal(card.phone.value, '+39 333 1234567');
  assert.equal(card.phone.system, 'whatsapp');
  assert.deepEqual(card.socials, [{ system: 'instagram', handle: 'guido.presti' }]);
  assert.equal(card.status.value, 'contatto');
  assert.match(card.status.reason, /not all readable here/,
    'the evidence packages are not composed here, so the card refuses the definitive "none" claim');
  assert.equal(card.activePackage.available, false);
  assert.ok(card.activePackage.reason.length > 0, 'an absent package reads as a reason, never as empty');
  assert.equal(card.notes.available, false);
  assert.ok(card.notes.reason.length > 0);
});

test('reading the card creates no master customer record', async (t) => {
  const root = projectWithHub(t);
  const context = await boot(root, join(root, 'data', 'hub-no-master.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  const listed = await app.services.contacts.list();
  assert.equal(listed.length, 1, 'the import created exactly one contact');
  const contact = listed[0];

  const db = app.database.raw;
  const tablesBefore = tables(db);
  assert.ok(!tablesBefore.some((name) => /customer.?hub|customers/.test(name)),
    `no customer master table exists beside the foundation's own: ${tablesBefore.join(',')}`);
  const countsBefore = counts(db);

  await app.readCustomerCard({ resource: 'contact', id: contact.id });
  await app.readCustomerCard({ resource: 'contact', id: contact.id });

  assert.deepEqual(tables(db), tablesBefore, 'a card read adds no table');
  assert.deepEqual(counts(db), countsBefore, 'a card read adds no row anywhere');
});

test('the hub package owns no records by declaration', async (t) => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const definition = createCustomerHubPackage();
  assert.deepEqual(definition.resources, [], 'the hub owns no tables — the guarantee is a declaration, not a comment');
  assert.equal(definition.metadata().ownsRecords, false, 'the published metadata repeats the guarantee');
});

test('the hub declares its customer-data edge instead of reaching into its source', async (t) => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const definition = createCustomerHubPackage();
  assert.deepEqual(definition.requires,
    [{ package: 'customer-data', capability: 'customer-profile', version: 1 }],
    'the profile arrives through the declared customer-profile@1 capability, so both packages share one name resolution');
});

test('without customer-data composed the application refuses to start naming the edge', async (t) => {
  const root = project(t, {});
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    'export const generatedDomains = [',
    '  createCustomerHubPackage(),',
    '];',
    '',
  ].join('\n'));
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  assert.throws(
    () => createAccordoApp({ dbPath: join(root, 'data', 'hub-no-provider.sqlite') }),
    /customer-data/,
    'a missing provider stops startup naming the edge — never a missing-module stack at card-read time',
  );
});

test('a space without the hub has no card operation', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'hub-absent.sqlite'));
  t.after(() => context.close());
  assert.equal(typeof context.app.readCustomerCard, 'undefined',
    'enablement is composition: no package, no operation');
});

test('signed business promotes the card to cliente', () => {
  const section = (available, count) => ({ available, count, items: [] });
  const base = {
    identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
    externalIdentities: [],
    subscriptions: section(false, 0), orders: section(false, 0), contracts: section(false, 0),
    opportunities: section(true, 1), quotes: section(true, 2),
  };
  const uncomposed = shapeCustomerCard(base, { resource: 'contact', id: 'c1' });
  assert.equal(uncomposed.status.value, 'contatto',
    'quotes and opportunities alone never promote a contact');
  assert.match(uncomposed.status.reason, /not all readable here/,
    'unread evidence sections refuse the definitive "none" claim');
  const signed = {
    ...base,
    subscriptions: { available: true, count: 1, items: [{ id: 's1', status: 'active', name: 'Pacchetto 10 ingressi' }] },
  };
  const card = shapeCustomerCard(signed, { resource: 'contact', id: 'c1' });
  assert.equal(card.status.value, 'cliente');
  assert.match(card.status.reason, /subscriptions/);
  assert.equal(card.activePackage.available, true);
  assert.deepEqual(card.activePackage.active, [{ id: 's1', status: 'active', name: 'Pacchetto 10 ingressi' }]);
});

test('the definitive "no signed business" needs every evidence package readable and complete', () => {
  const section = (available, count, extra = {}) => ({ available, count, items: [], ...extra });
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const proven = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: section(true, 0), orders: section(true, 0), contracts: section(true, 0),
  }, { resource: 'contact', id: 'c1' });
  assert.equal(proven.status.value, 'contatto');
  assert.match(proven.status.reason, /no orders, contracts or subscriptions reference this customer/,
    'all three evidence packages readable with complete zero counts: the negative claim is proven');
  const partial = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: section(true, 0),
    orders: section(true, 0),
    contracts: section(true, 0, { countIsComplete: false, countNote: 'contracts were read from a bounded page' }),
  }, { resource: 'contact', id: 'c1' });
  assert.equal(partial.status.value, 'contatto');
  assert.match(partial.status.reason, /not all readable here/,
    'a partially read evidence package refuses the definitive "none" claim');
  assert.match(partial.status.reason, /contracts: partially readable/);
});

test('the card renders as one self-contained phone page', async (t) => {
  const root = projectWithHub(t);
  const context = await boot(root, join(root, 'data', 'hub-render.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  await app.applyCustomerImport({ actor: ACTOR, system: 'instagram', rows: [row('guido.presti')] });
  const listed = await app.services.contacts.list();
  assert.equal(listed.length, 1, 'the import created exactly one contact');
  const contact = listed[0];
  const html = renderCustomerCardHtml(await app.readCustomerCard({ resource: 'contact', id: contact.id }));

  assert.ok(html.includes('<meta name="viewport"'), 'the page scales to a phone viewport');
  assert.ok(html.includes('tel:+393331234567'), 'the phone is a tap-to-call link');
  assert.ok(html.includes(`mailto:${EMAIL}`), 'the email is a tap-to-write link');
  assert.ok(html.includes('Guido Presti'), 'the name is on the page');
  assert.ok(html.includes('stato: contatto'), 'the status badge is on the page');
  assert.ok(html.includes('guido.presti'), 'the social handle is on the page');
  assert.ok(!html.includes('<script'), 'no script: the page works from the device with nothing to execute');

  const hostile = renderCustomerCardHtml({
    name: '<script>alert(1)</script>', status: { value: 'contatto', reason: '' }, email: null,
    company: null, phone: { available: false, reason: '' }, socials: [],
    activePackage: { available: false, reason: '' }, notes: { available: false, reason: '' },
    history: { available: false, reason: '' },
  });
  assert.ok(!hostile.includes('<script>alert'), 'card text is escaped');
});

test('a card for a missing record says the customer does not exist, never a ghost contatto', () => {
  const section = (available, count) => ({ available, count, items: [] });
  const ghost = {
    identity: {
      contact: null,
      company: null,
      note: 'the canonical record for this subject could not be read from the host application',
    },
    externalIdentities: [],
    subscriptions: section(false, 0), orders: section(false, 0), contracts: section(false, 0),
    opportunities: section(false, 0), quotes: section(false, 0),
  };
  assert.throws(
    () => shapeCustomerCard(ghost, { resource: 'contact', id: 'deleted-id' }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'a deleted or mistyped id throws NOT_FOUND instead of a null-name contatto card',
  );
});

test('the package count is escaped like every other card field', () => {
  const html = renderCustomerCardHtml({
    name: 'Guido Presti', status: { value: 'contatto', reason: '' }, email: null,
    company: null, phone: { available: false, reason: '' }, socials: [],
    activePackage: { available: true, count: '<img src=x onerror=alert(1)>', active: [], items: [], reason: null },
    notes: { available: false, reason: '' },
    history: { available: false, reason: '' },
  });
  assert.ok(!html.includes('<img src=x'), 'markup in the package count never lands verbatim in the page');
  assert.ok(html.includes('&lt;img'), 'the count is escaped like every other field');
});

test('a non-dialable channel id is held, never presented as a callable phone', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const crmId = shapeCustomerCard({
    identity,
    externalIdentities: [{ system: 'whatsapp', externalId: 'CRM-1' }],
    subscriptions: off, orders: off, contracts: off,
  }, { resource: 'contact', id: 'c1' });
  assert.equal(crmId.phone.available, false, 'a CRM identifier is not a phone number');
  assert.match(crmId.phone.reason, /not a dialable phone number/,
    'the reason names the held identity as non-dialable, never as "no phone"');
  const html = renderCustomerCardHtml({ ...crmId, name: 'A B', email: 'a@b.it' });
  assert.ok(!html.includes('tel:CRM-1'), 'no tap-to-call link points at a CRM identifier');

  const dialable = shapeCustomerCard({
    identity,
    externalIdentities: [{ system: 'whatsapp', externalId: '+39 333 1234567' }],
    subscriptions: off, orders: off, contracts: off,
  }, { resource: 'contact', id: 'c1' });
  assert.equal(dialable.phone.available, true);
  assert.equal(dialable.phone.value, '+39 333 1234567');
});

test('a floor package count reads as "at least N", never as an exact total', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const floor = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: {
      available: true, count: 500, items: [],
      countIsComplete: false, countNote: 'subscriptions were read from a bounded page',
    },
    orders: off, contracts: off,
  }, { resource: 'contact', id: 'c1' });
  assert.equal(floor.status.value, 'cliente');
  assert.equal(floor.activePackage.countIsComplete, false);
  assert.equal(floor.activePackage.countNote, 'subscriptions were read from a bounded page');
  const floorHtml = renderCustomerCardHtml({ ...floor, name: 'A B', email: 'a@b.it' });
  assert.ok(floorHtml.includes('(record: almeno 500)'), 'a floor count reads as a floor');

  const exact = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 2, items: [], countIsComplete: true },
    orders: { available: true, count: 0, items: [] }, contracts: { available: true, count: 0, items: [] },
  }, { resource: 'contact', id: 'c1' });
  assert.equal(exact.activePackage.countIsComplete, true);
  const exactHtml = renderCustomerCardHtml({ ...exact, name: 'A B', email: 'a@b.it' });
  assert.ok(exactHtml.includes('(record: 2)'), 'a complete count keeps its exact reading');
  assert.ok(!exactHtml.includes('almeno'), 'no floor qualifier leaks into an exact count');
});

test('a truncated subscriptions page without an active record in hand refuses the definitive "none"', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const slice = Array.from({ length: 50 }, (_, index) => ({ id: `s${index}`, status: 'expired', name: `Pacchetto ${index}` }));
  const card = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 60, items: slice, truncated: true },
    orders: off, contracts: off,
  }, { resource: 'contact', id: 'c1' });
  assert.equal(card.activePackage.available, false, 'no active record in hand on a truncated page is not a "none"');
  assert.equal(card.activePackage.truncated, true, 'the qualifier travels with the package');
  assert.equal(card.activePackage.count, 60);
  assert.match(card.activePackage.reason, /not a claim none exists/,
    'the reason says an active package may sit past the readable slice');
  const html = renderCustomerCardHtml({ ...card, name: 'A B', email: 'a@b.it' });
  assert.ok(!html.includes('nessun pacchetto attivo'), 'no definitive negative is rendered from a truncated page');
});

test('a truncated page that holds an active record still shows it', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const slice = [{ id: 's-active', status: 'active', name: 'Pacchetto annuale' },
    ...Array.from({ length: 49 }, (_, index) => ({ id: `s${index}`, status: 'expired', name: `Pacchetto ${index}` }))];
  const card = shapeCustomerCard({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 60, items: slice, truncated: true },
    orders: off, contracts: off,
  }, { resource: 'contact', id: 'c1' });
  assert.equal(card.activePackage.available, true, 'an active record in hand is shown even when the page is truncated');
  assert.equal(card.activePackage.truncated, true);
  assert.deepEqual(card.activePackage.active.map((item) => item.id), ['s-active']);
});
