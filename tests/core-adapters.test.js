import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';
import {
  createCoreAdapters,
  normalizeCompanyName,
  normalizeEmail,
} from '../packages/core/src/core-adapters.js';

const actor = { type: 'user', id: 'adapter-test' };

test('normalization is one shared, deterministic implementation', () => {
  assert.equal(normalizeCompanyName('  Acme   Ltd '), 'acme ltd');
  assert.equal(normalizeCompanyName('ACME\tLtd'), 'acme ltd');
  // Composed and decomposed Unicode agree after NFC.
  assert.equal(normalizeCompanyName('Größe GmbH'), normalizeCompanyName('Größe GmbH'.normalize('NFD')));
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
});

test('malformed adapter dependencies fail closed at construction', () => {
  assert.throws(() => createCoreAdapters({ database: {}, services: {} }), /companies service/);
  assert.throws(
    () => createCoreAdapters({ database: {}, services: { companies: { create() {} }, contacts: {}, opportunities: { create() {} } } }),
    /contacts service/,
  );
});

test('the adapter registry is frozen and per-app instances are isolated', async (t) => {
  const appA = createAgentCrmApp({ dbPath: ':memory:' });
  const appB = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => { appA.close(); appB.close(); });

  const adaptersA = createCoreAdapters({ database: appA.database, services: appA.services });
  const adaptersB = createCoreAdapters({ database: appB.database, services: appB.services });

  assert.ok(Object.isFrozen(adaptersA), 'the registry object is frozen');
  assert.throws(() => { 'use strict'; adaptersA.createCompany = () => 'hijacked'; }, TypeError);

  // Writes through instance A are invisible to instance B (separate databases).
  await adaptersA.createCompany({ name: 'Only In A' }, { actor });
  assert.equal(adaptersA.findCompaniesByNormalizedName('only in a').length, 1);
  assert.equal(adaptersB.findCompaniesByNormalizedName('only in a').length, 0);

  // Reads validate their input.
  assert.throws(() => adaptersA.findCompaniesByNormalizedName(''), /companyName is required/);
  assert.throws(() => adaptersA.findContactByEmail('   '), /email is required/);

  // Deterministic order: two normalized-equal companies come back oldest first
  // regardless of lookup casing.
  await adaptersA.createCompany({ name: 'dup co' }, { actor });
  await adaptersA.createCompany({ name: 'DUP CO' }, { actor });
  const matches = adaptersA.findCompaniesByNormalizedName('Dup   Co');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].name, 'dup co', 'oldest first, insertion-order independent of query casing');
});
