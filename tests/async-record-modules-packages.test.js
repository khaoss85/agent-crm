// @ts-check

/**
 * Package operations end-to-end on the async composition, SQLite (M3).
 *
 * The three framework packages compose with their record manifests selected;
 * import preview/apply execute, the consolidated customer profile reads, a
 * work action on a missing row refuses with the row (not the module), and
 * the host-owned `lead` record stays exactly that — selected by name, never
 * registered by the framework.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
const customerData = await import('../packages/customer-data/src/index.js');
const work = await import('../packages/work/src/index.js');
const intelligence = await import('../packages/intelligence/src/index.js');

function packageManifests(packageName) {
  const dir = join(ROOT, 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

/** @param {{after: (fn: () => void) => void}} t */
async function composedPackages(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-m3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const records = [
    ...packageManifests('customer-data'),
    ...packageManifests('work'),
    ...packageManifests('intelligence'),
  ];
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'packages.sqlite'),
    selected: {
      packageContract: 2,
      packages: [
        customerData.createCustomerDataPackageV2(),
        work.createWorkPackageV2(),
        intelligence.createIntelligenceDomainV2(),
      ],
      actions: [],
      modules: [...records, 'lead'],
    },
  });
  t.after(() => app.close());
  return app;
}

const IMPORT = {
  system: 'owner-csv',
  rows: [{ externalId: 'X1', email: 'a@b.example', firstName: 'A', lastName: 'B' }],
  acceptance: 'partial',
};

test('import apply writes receipts and the profile reads the customer', async (t) => {
  const app = await composedPackages(t);

  const applied = await app.operations.run('apply-customer-import', IMPORT);
  assert.equal(applied.mode, 'apply');
  assert.ok(applied.runId, 'the apply returns its run');

  const replayed = await app.operations.run('apply-customer-import', IMPORT);
  assert.equal(replayed.replayed, true, 'the same payload replays idempotently');

  const company = await app.services.companies.create({ name: 'Acme' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'C', lastName: 'D', email: 'boss@acme.example',
  });
  const profile = await app.operations.run('read-customer-profile', { resource: 'contact', id: contact.id });
  assert.equal(profile.customerProfileContract, 1);
  assert.equal(profile.subject.id, contact.id);
  assert.equal(profile.canonicalIdentity.linked, false);
});

test('work actions reach the record; the host lead stays unregistered', async (t) => {
  const app = await composedPackages(t);

  const missing = await app.runAction({
    module: 'work-task', action: 'complete', recordId: 'no-such-task', input: {}, actor: { type: 'user', id: 'op' },
  }).then(() => null, (error) => error);
  assert.ok(missing, 'a missing row still refuses');
  assert.equal(missing.code, 'NOT_FOUND');
  assert.match(String(missing.message), /WorkTask not found: no-such-task/);

  const lead = await app.runAction({
    module: 'lead', action: 'enrich', recordId: 'x', input: {}, actor: { type: 'user', id: 'op' },
  }).then(() => null, (error) => error);
  assert.ok(lead, 'the host record is not conjured by selection');
  assert.equal(lead.code, 'NOT_FOUND');
  assert.match(String(lead.message), /Module not found: lead/);
});
