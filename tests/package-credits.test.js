import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allocateConsumption,
  consumingAppointments,
  createPackageCreditsCapability,
  grantPackageEntries,
  readPackageBalance,
} from '../packages/commercial/src/index.js';
import { NotFoundError } from '../packages/core/index.js';

/**
 * Package credits, model-level: every claim here is about the grant, the
 * FIFO allocation across grants and the balance rule, so fakes prove it and a
 * database would only slow the answer. The manifest, the composition and the
 * characterization baseline are covered where they live
 * (`crm module create`, `tests/package-contract.test.js`, the commercial
 * characterization suite).
 *
 * The packet's two acceptance tests are the first two below: the balance
 * after three kept appointments, and the floor at zero without an explicit
 * choice.
 */

const NOW = '2026-10-18T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const ACTOR = { type: 'user', id: 'owner' };

const grant = (overrides = {}) => ({
  sourceKey: 'stripe:evt:1',
  subject: SUBJECT,
  productKey: 'pack-10',
  totalEntries: 5,
  source: { package: 'host', action: 'grant' },
  ...overrides,
});

const appointment = (overrides = {}) => ({
  id: 'appt-1',
  subjectResource: 'contact',
  subjectId: 'c-presti',
  // Real booking rows carry the full envelope (appointments.js): the balance
  // filters on it, so the fakes mirror it.
  subjectOwner: 'host',
  subjectOwnerPackage: null,
  status: 'done',
  decidedAt: '2026-10-18T10:00:00.000Z',
  ...overrides,
});

function fakeCredits(seed = []) {
  const rows = seed.map((row, index) => ({ id: `pc-${index + 1}`, ...row }));
  return {
    rows,
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      const stored = { id: `pc-${rows.length + 1}`, ...row };
      rows.push(stored);
      return stored;
    },
  };
}

function fakeAppointments(seed = []) {
  const rows = seed.map((row, index) => ({ id: row.id ?? `appt-${index + 1}`, ...row }));
  return {
    rows,
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
  };
}

const modulesFor = ({ credits, appointments = null }) => ({
  get: (name) => {
    if (name === 'package-credit') return { service: credits };
    if (name === 'appointment' && appointments) return { service: appointments };
    throw new NotFoundError('module', name);
  },
});

test('acceptance: the balance is correct after three kept appointments', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', decidedAt: '2026-10-18T10:00:00.000Z' }),
    appointment({ id: 'appt-2', decidedAt: '2026-10-18T11:00:00.000Z' }),
    appointment({ id: 'appt-3', decidedAt: '2026-10-18T12:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  const { grant: stored, replayed } = await grantPackageEntries(context, grant());
  assert.equal(replayed, false);
  assert.equal(stored.totalEntries, 5);

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.available, true);
  assert.equal(balance.granted, 5);
  assert.equal(balance.consumed, 3);
  assert.equal(balance.uncovered, 0);
  assert.equal(balance.balance, 2, 'five entries minus three kept appointments leaves two');
});

test('acceptance: the balance never drops below zero without an explicit choice', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', decidedAt: '2026-10-18T10:00:00.000Z' }),
    appointment({ id: 'appt-2', decidedAt: '2026-10-18T11:00:00.000Z' }),
    appointment({ id: 'appt-3', decidedAt: '2026-10-18T12:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(context, grant({ sourceKey: 'stripe:evt:small', totalEntries: 2 }));

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.available, true);
  assert.equal(balance.granted, 2);
  assert.equal(balance.consumed, 2);
  assert.equal(balance.uncovered, 1, 'the third appointment has no entry left to spend');
  assert.equal(balance.balance, 0, 'two entries cannot pay for three sessions: the floor holds');
});

test('an explicit allow-negative grant may report below zero', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', decidedAt: '2026-10-18T10:00:00.000Z' }),
    appointment({ id: 'appt-2', decidedAt: '2026-10-18T11:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(context, grant({ totalEntries: 1, allowNegative: true }));

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.balance, -1, 'only the explicit allowNegative choice opens the negative');
  assert.equal(balance.grants[0].remaining, -1);
  assert.equal(balance.uncovered, 0);
});

test('a no-show costs nothing unless the grant configures it', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', status: 'no-show', decidedAt: '2026-10-18T10:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(context, grant({ totalEntries: 3 }));

  const ignored = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(ignored.consumed, 0, 'the default no-show rule ignores the missed session');
  assert.equal(ignored.balance, 3);

  const strictCredits = fakeCredits();
  const strictModules = modulesFor({ credits: strictCredits, appointments: held });
  const strictContext = { modules: strictModules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(strictContext, grant({ sourceKey: 'stripe:evt:strict', totalEntries: 3, noShowConsumes: true }));

  const charged = await readPackageBalance({ modules: strictModules }, SUBJECT);
  assert.equal(charged.consumed, 1, 'the configured grant charges the no-show');
  assert.equal(charged.balance, 2);
});

test('the balance never crosses the subject owner: same resource and id, other owner', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-host', decidedAt: '2026-10-18T10:00:00.000Z' }),
    appointment({
      id: 'appt-pkg',
      subjectOwner: 'package',
      subjectOwnerPackage: 'loyalty',
      decidedAt: '2026-10-18T11:00:00.000Z',
    }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(context, grant({ totalEntries: 2 }));

  const host = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(host.granted, 2);
  assert.equal(host.consumed, 1, 'the package-owned appointment is not the host subject’s session');
  assert.equal(host.balance, 1);

  const pkg = await readPackageBalance(
    { modules },
    { resource: 'contact', id: 'c-presti', owner: 'package', ownerPackage: 'loyalty' },
  );
  assert.equal(pkg.granted, 0, 'the host grant is not the package-owned subject’s entries');
  assert.equal(pkg.consumed, 0);
  assert.equal(pkg.balance, 0);
});

test('open, cancelled and booked appointments consume nothing', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', status: 'booked', decidedAt: null }),
    appointment({ id: 'appt-2', status: 'confirmed', decidedAt: null }),
    appointment({ id: 'appt-3', status: 'cancelled', decidedAt: '2026-10-18T10:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  await grantPackageEntries({ modules, actor: ACTOR, now: () => NOW }, grant({ totalEntries: 4 }));

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.consumed, 0, 'only sessions that happened scale entries off');
  assert.equal(balance.balance, 4);
});

test('consumption allocates oldest grant first', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', decidedAt: '2026-10-18T10:00:00.000Z' }),
    appointment({ id: 'appt-2', decidedAt: '2026-10-18T11:00:00.000Z' }),
    appointment({ id: 'appt-3', decidedAt: '2026-10-18T12:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  const first = { modules, actor: ACTOR, now: () => '2026-10-17T09:00:00.000Z' };
  await grantPackageEntries(first, grant({ sourceKey: 'stripe:evt:first', totalEntries: 2 }));
  const later = { modules, actor: ACTOR, now: () => '2026-10-18T08:00:00.000Z' };
  await grantPackageEntries(later, grant({ sourceKey: 'stripe:evt:second', totalEntries: 5 }));

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.granted, 7);
  assert.equal(balance.consumed, 3);
  assert.equal(balance.balance, 4);
  assert.equal(balance.grants[0].used, 2, 'the oldest grant spends first');
  assert.equal(balance.grants[0].remaining, 0);
  assert.equal(balance.grants[1].used, 1);
  assert.equal(balance.grants[1].remaining, 4);
});

test('a grant never pays for a session decided before it was granted', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([
    appointment({ id: 'appt-1', decidedAt: '2026-10-18T10:00:00.000Z' }),
  ]);
  const modules = modulesFor({ credits, appointments: held });
  // Granted the day after the session happened.
  const context = { modules, actor: ACTOR, now: () => '2026-10-19T09:00:00.000Z' };
  await grantPackageEntries(context, grant({ totalEntries: 5 }));

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.consumed, 0, 'a later package never pays for an earlier session');
  assert.equal(balance.balance, 5);
});

test('the same payment reference replays the grant instead of doubling entries', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits, appointments: fakeAppointments() });
  const context = { modules, actor: ACTOR, now: () => NOW };
  const first = await grantPackageEntries(context, grant());
  assert.equal(first.replayed, false);
  const second = await grantPackageEntries(context, grant());
  assert.equal(second.replayed, true, 'a webhook redelivery replays');
  assert.equal(second.grant.id, first.grant.id);
  assert.equal(credits.rows.length, 1, 'exactly one grant row');

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.granted, 5, 'no doubled entries');
});

test('the same payment reference with a different grant is a 409, never an overwrite', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits, appointments: fakeAppointments() });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await grantPackageEntries(context, grant());
  await assert.rejects(
    grantPackageEntries(context, grant({ totalEntries: 10 })),
    (error) => error.code === 'COMMERCIAL_PACKAGE_CREDIT_CONFLICT' && error.status === 409,
  );
  assert.equal(credits.rows[0].totalEntries, 5, 'the stored grant is untouched');
});

test('without the appointments package the balance refuses instead of guessing', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits });
  await grantPackageEntries({ modules, actor: ACTOR, now: () => NOW }, grant());

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.available, false);
  assert.equal(balance.balance, null);
  assert.match(balance.note, /not composed/, 'the reason names the missing package');
});

test('no grant is a known zero, not an unknown', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits, appointments: fakeAppointments() });

  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.available, true);
  assert.equal(balance.granted, 0);
  assert.equal(balance.balance, 0);
});

test('grant validation refuses what the ledger cannot store', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits, appointments: fakeAppointments() });
  const context = { modules, actor: ACTOR, now: () => NOW };
  await assert.rejects(grantPackageEntries(context, grant({ totalEntries: 0 })), /totalEntries/);
  await assert.rejects(grantPackageEntries(context, grant({ totalEntries: -2 })), /totalEntries/);
  await assert.rejects(grantPackageEntries(context, grant({ productKey: 'Pack 10!' })), /productKey/);
  await assert.rejects(
    grantPackageEntries(context, grant({ subject: { resource: 'contact', id: '', owner: 'host' } })),
    /subject\.id/,
  );
  await assert.rejects(grantPackageEntries(context, grant({ allowNegative: 'yes' })), /allowNegative/);
  await assert.rejects(
    grantPackageEntries({ modules, now: () => NOW }, grant()),
    /actor/,
    'an anonymous grant would hold entries nobody is accountable for',
  );
});

test('a done row without a provable decision instant refuses the balance', () => {
  assert.throws(
    () => consumingAppointments([appointment({ decidedAt: 'not-an-instant' })]),
    (error) => error.code === 'COMMERCIAL_PACKAGE_CREDIT_UNPROVABLE',
  );
});

test('allocation is a pure deterministic order: oldest decision first', () => {
  const grants = [
    { id: 'g1', grantedAt: '2026-10-18T09:00:00.000Z', totalEntries: 1 },
    { id: 'g2', grantedAt: '2026-10-18T09:30:00.000Z', totalEntries: 1 },
  ];
  const consuming = consumingAppointments([
    appointment({ id: 'late', decidedAt: '2026-10-18T12:00:00.000Z' }),
    appointment({ id: 'early', decidedAt: '2026-10-18T10:00:00.000Z' }),
  ]);
  assert.equal(consuming[0].id, 'early');
  const { ledgers, uncovered } = allocateConsumption(grants, consuming);
  assert.equal(uncovered, 0);
  assert.deepEqual(ledgers.map((ledger) => ledger.used), [1, 1]);
});

test('a grant asserting another package provenance is refused, not corrected', async () => {
  const credits = fakeCredits();
  const modules = modulesFor({ credits, appointments: fakeAppointments() });
  const context = { modules, actor: ACTOR, now: () => NOW, consumer: 'payments' };
  await assert.rejects(
    grantPackageEntries(context, grant({ source: { package: 'host', action: 'grant' } })),
    (error) => error.code === 'COMMERCIAL_PACKAGE_CREDIT_SOURCE_MISMATCH' && error.status === 403,
  );
  assert.equal(credits.rows.length, 0, 'nothing is stored on a refused provenance');
  const bound = await grantPackageEntries(
    context, grant({ source: { package: 'payments', action: 'finalize' } }),
  );
  assert.equal(bound.replayed, false);
  assert.equal(bound.grant.sourcePackage, 'payments');
});

test('stored 0/1 flags replay and read as the booleans they are', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([appointment({ status: 'no-show' })]);
  const modules = modulesFor({ credits, appointments: held });
  const context = { modules, actor: ACTOR, now: () => NOW };
  // SQLite keeps booleans as integers: the stored row reads back 1/0.
  credits.rows.push({
    id: 'pc-0',
    sourceKey: 'stripe:evt:int',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    subjectOwner: 'host',
    subjectOwnerPackage: null,
    productKey: 'pack-10',
    totalEntries: 2,
    allowNegative: 1,
    noShowConsumes: 1,
    sourcePackage: 'host',
    sourceAction: 'grant',
    grantedAt: NOW,
  });
  const replayed = await grantPackageEntries(context, grant({
    sourceKey: 'stripe:evt:int', totalEntries: 2, allowNegative: true, noShowConsumes: true,
  }));
  assert.equal(replayed.replayed, true, '1 reads as true: no false conflict');
  assert.equal(replayed.grant.id, 'pc-0');
  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.consumed, 1, '1 reads as true: the no-show consumes');
  assert.equal(balance.balance, 1, 'two entries minus one charged no-show leaves one');
  assert.equal(balance.grants[0].allowNegative, true);
  assert.equal(balance.grants[0].noShowConsumes, true);
});

test('the checked-in manifest migrates and round-trips a grant on real storage', async (t) => {
  // The fakes above prove the accounting; only real storage can prove the
  // manifest — the table, the boolean CHECKs, the timestamp and enum shapes.
  const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
  const manifest = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'commercial', 'modules', 'package-credit.module.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'package-credit');
  const dir = mkdtempSync(join(tmpdir(), 'accordo-package-credit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await createAccordoAppAsync({
    dbPath: join(dir, 'credits.sqlite'),
    selected: { packageContract: 2, packages: [], actions: [], modules: [{ name: 'package-credit', manifest }] },
  });
  t.after(() => app.close());
  const service = app.modules.get('package-credit').service;
  const stored = await service.createManaged({
    sourceKey: 'stripe:evt:real',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    subjectOwner: 'host',
    subjectOwnerPackage: null,
    subjectLabel: null,
    productKey: 'pack-10',
    totalEntries: 5,
    allowNegative: false,
    noShowConsumes: true,
    grantedAt: NOW,
    actorType: 'user',
    actorId: 'owner',
    sourcePackage: 'host',
    sourceAction: 'grant',
  }, { actor: ACTOR });
  assert.ok(stored.id, 'the grant row exists');
  const read = (await service.listWhere({ subjectResource: 'contact', subjectId: 'c-presti' }))[0];
  assert.equal(read.totalEntries, 5);
  assert.ok(read.noShowConsumes === true || read.noShowConsumes === 1, 'the stored flag reads back true in either encoding');

  // The accounting runs unchanged on the real rows.
  const modules = {
    get: (name) => {
      if (name === 'package-credit') return { service };
      throw new NotFoundError('module', name);
    },
  };
  const balance = await readPackageBalance({ modules }, SUBJECT);
  assert.equal(balance.available, false, 'no appointment module composed here: no silent full balance');
});

test('the capability opens on the caller modules view and grants through it', async () => {
  const credits = fakeCredits();
  const held = fakeAppointments([appointment({})]);
  const modules = modulesFor({ credits, appointments: held });
  const capability = createPackageCreditsCapability().create({ modules, actor: ACTOR, now: () => NOW });
  assert.equal(capability.capabilityContract, 1);
  await capability.grantPackageEntries(grant());
  const balance = await capability.packageBalance(SUBJECT);
  assert.equal(balance.balance, 4);

  assert.throws(
    () => createPackageCreditsCapability().create({}),
    (error) => error.code === 'CAPABILITY_CONTEXT_INVALID',
  );
});
