import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shapeCustomerCard } from '../packages/customer-hub/src/card.js';
import { renderCustomerCardHtml } from '../packages/customer-hub/src/render.js';
import { deriveCustomerStatus } from '../packages/customer-data/src/customer-status.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * The verdict the real `profileFor` would carry for these evidence sections.
 * Fabricated profiles state it explicitly because the card reads it through
 * the capability shape instead of computing its own.
 */
const profileStatusOf = ({ orders, contracts, subscriptions }) => deriveCustomerStatus({ orders, contracts, subscriptions });
/** A fabricated profile with the verdict the real provider would carry. */
const withStatus = (profile) => ({ ...profile, status: profileStatusOf(profile) });

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

/** The same project as the customer-data helper, plus work, interactions, appointments and the hub. */
function projectWithHub(t) {
  const root = project(t, {});
  for (const manifest of [
    'conversation.module.json',
    'interaction-message.module.json',
    'interaction-call.module.json',
    'conversation-assignment.module.json',
    'conversation-read.module.json',
    'conversation-thread-key.module.json',
  ]) {
    const applied = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
        join(root, 'packages/interactions/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of ['appointment.module.json']) {
    const applied = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
        join(root, 'packages/appointments/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
    const applied = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
        join(root, 'packages/work/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  const path = join(root, 'packages/domains/generated/index.js');
  const before = readFileSync(path, 'utf8');
  assert.ok(before.includes('createCustomerDataPackage()'), 'helper composes customer-data');
  writeFileSync(path, [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    "import { createAppointmentsPackage } from '../../appointments/src/index.js';",
    "import { createWorkPackage } from '../../work/src/index.js';",
    // One name resolution per provider: each definition is built once, and
    // the hub consumes their created capability handles — the hub never
    // re-instantiates a provider factory from its own options.
    'const customerData = createCustomerDataPackage();',
    'const work = createWorkPackage();',
    'const interactions = createInteractionsPackage();',
    'const appointments = createAppointmentsPackage({ work });',
    'export const generatedDomains = [',
    '  customerData,',
    '  work,',
    '  interactions,',
    '  appointments,',
    '  createCustomerHubPackage({ customerData, interactions, appointments }),',
    '];',
    '',
  ].join('\n'));
  const after = readFileSync(path, 'utf8');
  assert.ok(after.includes('createCustomerHubPackage({ customerData, interactions, appointments })'),
    'the hub is composed with all three provider definitions');
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

test('the hub declares the card edge and opens the timeline edges at operation time', async (t) => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const definition = createCustomerHubPackage();
  assert.deepEqual(definition.requires,
    [{ package: 'customer-data', capability: 'customer-profile', version: 1 }],
    'only the card profile is a startup edge, so card-only compositions keep booting; '
    + 'threads and bookings fail closed when the timeline operation opens, never at startup');
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

test('a card-only composition boots and serves the card without the timeline providers', async (t) => {
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
  const context = await boot(root, join(root, 'data', 'hub-card-only.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1, 'one contact imported with no timeline provider composed');
  const card = await app.readCustomerCard({ resource: 'contact', id: contacts[0].id });
  assert.equal(card.customerCardContract, 1);
  assert.equal(card.name, 'Guido Presti');
  assert.equal(card.phone.value, '+39 333 1234567');
});

test('signed business promotes the card to cliente', () => {
  const section = (available, count) => ({ available, count, items: [] });
  const base = {
    identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
    externalIdentities: [],
    subscriptions: section(false, 0), orders: section(false, 0), contracts: section(false, 0),
    opportunities: section(true, 1), quotes: section(true, 2),
  };
  const uncomposed = shapeCustomerCard(withStatus(base), { resource: 'contact', id: 'c1' });
  assert.equal(uncomposed.status.value, 'contatto',
    'quotes and opportunities alone never promote a contact');
  assert.match(uncomposed.status.reason, /not all readable here/,
    'unread evidence sections refuse the definitive "none" claim');
  const signed = {
    ...base,
    subscriptions: { available: true, count: 1, items: [{ id: 's1', status: 'active', name: 'Pacchetto 10 ingressi' }] },
  };
  const card = shapeCustomerCard(withStatus(signed), { resource: 'contact', id: 'c1' });
  assert.equal(card.status.value, 'cliente');
  assert.match(card.status.reason, /subscriptions/);
  assert.equal(card.activePackage.available, true);
  assert.deepEqual(card.activePackage.active, [{ id: 's1', status: 'active', name: 'Pacchetto 10 ingressi' }]);
});

test('the definitive "no signed business" needs every evidence package readable and complete', () => {
  const section = (available, count, extra = {}) => ({ available, count, items: [], ...extra });
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const proven = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: section(true, 0), orders: section(true, 0), contracts: section(true, 0),
  }), { resource: 'contact', id: 'c1' });
  assert.equal(proven.status.value, 'contatto');
  assert.match(proven.status.reason, /no orders, contracts or subscriptions reference this customer/,
    'all three evidence packages readable with complete zero counts: the negative claim is proven');
  const partial = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: section(true, 0),
    orders: section(true, 0),
    contracts: section(true, 0, { countIsComplete: false, countNote: 'contracts were read from a bounded page' }),
  }), { resource: 'contact', id: 'c1' });
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
  const crmId = shapeCustomerCard(withStatus({
    identity,
    externalIdentities: [{ system: 'whatsapp', externalId: 'CRM-1' }],
    subscriptions: off, orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(crmId.phone.available, false, 'a CRM identifier is not a phone number');
  assert.match(crmId.phone.reason, /not a dialable phone number/,
    'the reason names the held identity as non-dialable, never as "no phone"');
  const html = renderCustomerCardHtml({ ...crmId, name: 'A B', email: 'a@b.it' });
  assert.ok(!html.includes('tel:CRM-1'), 'no tap-to-call link points at a CRM identifier');

  const dialable = shapeCustomerCard(withStatus({
    identity,
    externalIdentities: [{ system: 'whatsapp', externalId: '+39 333 1234567' }],
    subscriptions: off, orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(dialable.phone.available, true);
  assert.equal(dialable.phone.value, '+39 333 1234567');
});

test('a floor package count reads as "at least N", never as an exact total', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const floor = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: {
      available: true, count: 500, items: [],
      countIsComplete: false, countNote: 'subscriptions were read from a bounded page',
    },
    orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(floor.status.value, 'cliente');
  assert.equal(floor.activePackage.available, false,
    'a floor count with no active record in hand is not a definitive "none"');
  assert.equal(floor.activePackage.countIsComplete, false);
  assert.equal(floor.activePackage.countNote, 'subscriptions were read from a bounded page');
  assert.equal(floor.activePackage.truncated, false, 'the page itself was not truncated — only the count is a floor');
  assert.match(floor.activePackage.reason, /not a claim none exists/,
    'the reason refuses the definitive negative');
  assert.match(floor.activePackage.reason, /bounded page/,
    'the floor qualifier travels with the refusal');
  const floorHtml = renderCustomerCardHtml({ ...floor, name: 'A B', email: 'a@b.it' });
  assert.ok(!floorHtml.includes('nessun pacchetto attivo'),
    'a floor count never renders the definitive "no active package"');
  assert.ok(floorHtml.includes('bounded page'), 'the page shows the floor reason instead');

  const exact = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 2, items: [], countIsComplete: true },
    orders: { available: true, count: 0, items: [] }, contracts: { available: true, count: 0, items: [] },
  }), { resource: 'contact', id: 'c1' });
  assert.equal(exact.activePackage.countIsComplete, true);
  const exactHtml = renderCustomerCardHtml({ ...exact, name: 'A B', email: 'a@b.it' });
  assert.ok(exactHtml.includes('(record: 2)'), 'a complete count keeps its exact reading');
  assert.ok(!exactHtml.includes('almeno'), 'no floor qualifier leaks into an exact count');
});

test('read-customer-card keeps the profile\u2019s no-RBAC posture: any caller reads the same card', async () => {
  const { readCustomerCard } = await import('../packages/customer-hub/src/card.js');
  const profile = {
    identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
    externalIdentities: [],
    subscriptions: { available: false, count: 0, items: [] },
    orders: { available: false, count: 0, items: [] },
    contracts: { available: false, count: 0, items: [] },
  };
  const readProfile = async () => withStatus(profile);
  const subject = { resource: 'contact', id: 'c1' };
  const anonymous = await readCustomerCard({ subject, readProfile });
  const asOwner = await readCustomerCard({ subject, readProfile, actor: { type: 'user', id: 'owner' } });
  const asStranger = await readCustomerCard({ subject, readProfile, actor: { type: 'user', id: 'stranger' } });
  assert.deepEqual(asOwner, anonymous, 'no caller check: an actor reads what an anonymous read returns');
  assert.deepEqual(asStranger, asOwner,
    'no RBAC, like read-customer-profile states in its limitations '
    + '("No RBAC exists; the Production Spine is absent, so this is local-development posture"): '
    + 'the card is identical for every caller');
});

test('a truncated subscriptions page without an active record in hand refuses the definitive "none"', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const slice = Array.from({ length: 50 }, (_, index) => ({ id: `s${index}`, status: 'expired', name: `Pacchetto ${index}` }));
  const card = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 60, items: slice, truncated: true },
    orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
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
  const card = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    subscriptions: { available: true, count: 60, items: slice, truncated: true },
    orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(card.activePackage.available, true, 'an active record in hand is shown even when the page is truncated');
  assert.equal(card.activePackage.truncated, true);
  assert.deepEqual(card.activePackage.active.map((item) => item.id), ['s-active']);
});

test('the hub imports no file from another domain package', () => {
  const hubSrc = dirname(fileURLToPath(new URL('../packages/customer-hub/src/card.js', import.meta.url)));
  const repoPackages = dirname(dirname(hubSrc));
  const violations = [];
  for (const file of readdirSync(hubSrc).filter((name) => name.endsWith('.js')).sort()) {
    const source = readFileSync(join(hubSrc, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const match of source.matchAll(/(?:\bimport\s[^'"]*|\bexport\s+[^'"]*\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = resolve(hubSrc, specifier);
      if (resolved.startsWith(join(hubSrc, '/')) || resolved === hubSrc) continue;
      if (resolved === join(repoPackages, 'core/index.js')) continue;
      violations.push(`${file} reaches ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], 'the profile arrives through the injected capability handle, never through a source import');
});

test('the hub opens the injected provider handle with the caller modules', async () => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const seen = [];
  const injected = {
    name: 'customer-profile',
    version: 1,
    create: (context) => {
      seen.push(context);
      return { readProfile: async () => { throw new Error('no database in this unit proof'); } };
    },
  };
  const definition = createCustomerHubPackage({ customerData: { capabilities: [injected] } });
  const operation = definition.operations.find((entry) => entry.name === 'read-customer-card');
  const modules = { get: () => { throw new Error('unused here'); } };
  operation.create({ modules, core: {}, database: {}, events: {}, config: {} });
  assert.equal(seen.length, 1, 'the hub opens exactly the injected handle, never a re-instantiated factory');
  assert.equal(seen[0].modules, modules, 'the read runs inside the caller transaction');
  assert.equal(seen[0].consumer, 'customer-hub');
});

test('the hub without the provider handle fails closed at composition naming the edge', async () => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  for (const options of [undefined, {}, { customerData: null }, { customerData: { capabilities: [] } }]) {
    const operation = createCustomerHubPackage(options).operations.find((entry) => entry.name === 'read-customer-card');
    assert.throws(
      () => operation.create({ modules: { get() { return null; } }, core: {}, database: {}, events: {}, config: {} }),
      /customer-data.*customer-profile@1/,
      'no handle means no silent read of the wrong tables — the edge is named',
    );
  }
});

test('a newer non-dialable channel id never hides an older callable number', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const card = shapeCustomerCard(withStatus({
    identity,
    externalIdentities: [
      { system: 'whatsapp', externalId: 'CRM-1' },
      { system: 'whatsapp', externalId: '+39 333 1234567' },
    ],
    subscriptions: off, orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(card.phone.available, true, 'the older callable number is surfaced despite the newer channel id');
  assert.equal(card.phone.value, '+39 333 1234567');

  const none = shapeCustomerCard(withStatus({
    identity,
    externalIdentities: [{ system: 'sms', externalId: 'CRM-9' }],
    subscriptions: off, orders: off, contracts: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(none.phone.available, false);
  assert.match(none.phone.reason, /CRM-9/, 'the reason names the newest held non-dialable id');
});

test('a complete 50-row timeline reads complete, a cut one reads truncated', () => {
  const identity = { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null };
  const off = { available: false, count: 0, items: [] };
  const items = (prefix, count) => Array.from({ length: count },
    (_, index) => ({ id: `${prefix}${index}`, name: `${prefix} ${index}`, status: 'open' }));
  const complete = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    opportunities: { available: true, count: 30, items: items('o', 30) },
    quotes: { available: true, count: 20, items: items('q', 20) },
    orders: off, contracts: off, subscriptions: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(complete.history.available, true);
  assert.equal(complete.history.count, 50);
  assert.equal(complete.history.truncated, false, 'exactly 50 rows with nothing beyond reads complete');

  const cut = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    opportunities: { available: true, count: 30, items: items('o', 30) },
    quotes: { available: true, count: 21, items: items('q', 21) },
    orders: off, contracts: off, subscriptions: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(cut.history.count, 50);
  assert.equal(cut.history.truncated, true, 'the 51st row left out marks the timeline truncated');

  const sectionCut = shapeCustomerCard(withStatus({
    identity, externalIdentities: [],
    opportunities: { available: true, count: 60, truncated: true, items: items('o', 10) },
    orders: off, contracts: off, subscriptions: off,
  }), { resource: 'contact', id: 'c1' });
  assert.equal(sectionCut.history.count, 10);
  assert.equal(sectionCut.history.truncated, true, 'a consumed section that reports its own truncation marks the timeline truncated');
});

test('a remapped customer-data composition serves the card through the provider resolution', async (t) => {
  // The P1 scenario: customer-data reads its identities from renamed modules
  // while the hub holds no config of its own. The card must still read the
  // same tables, because it consumes the provider's created handle.
  const root = project(t, {});
  const manifestPath = join(root, 'packages/customer-data/modules/external-identity.module.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = 'custom-ext-id';
  const remappedPath = join(root, 'packages/customer-data/modules/custom-ext-id.module.json');
  writeFileSync(remappedPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const applied = spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', remappedPath, '--apply', '--root', root],
    { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, `apply remapped identity module: ${applied.stderr}`);
  for (const [dir, manifest] of [
    ['interactions', 'conversation.module.json'],
    ['interactions', 'interaction-message.module.json'],
    ['interactions', 'interaction-call.module.json'],
    ['interactions', 'conversation-assignment.module.json'],
    ['interactions', 'conversation-read.module.json'],
    ['interactions', 'conversation-thread-key.module.json'],
    ['appointments', 'appointment.module.json'],
    ['work', 'work-task.module.json'],
    ['work', 'work-activity.module.json'],
  ]) {
    const step = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
        join(root, 'packages', dir, 'modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(step.status, 0, `apply ${manifest}: ${step.stderr}`);
  }
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    "import { createAppointmentsPackage } from '../../appointments/src/index.js';",
    "import { createWorkPackage } from '../../work/src/index.js';",
    'const customerData = createCustomerDataPackage({ config: { externalIdentityModule: \'custom-ext-id\' } });',
    'const work = createWorkPackage();',
    'const interactions = createInteractionsPackage();',
    'const appointments = createAppointmentsPackage({ work });',
    'export const generatedDomains = [',
    '  customerData,',
    '  work,',
    '  interactions,',
    '  appointments,',
    '  createCustomerHubPackage({ customerData, interactions, appointments }),',
    '];',
    '',
  ].join('\n'));

  const context = await boot(root, join(root, 'data', 'hub-remapped.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1);
  const card = await app.readCustomerCard({ resource: 'contact', id: contacts[0].id });
  assert.equal(card.phone.available, true, 'the card reads the renamed identity table through the provider resolution');
  assert.equal(card.phone.value, '+39 333 1234567');
});
