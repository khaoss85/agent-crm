import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAccordoApp, createAccordoAppAsync } from '../packages/app/src/index.js';
import { PackageRegistry } from '../packages/core/src/package-registry.js';
import { createPartnerScorecardPackage } from '../examples/custom-packages/partner-scorecard/src/index.js';

/**
 * **Production Spine v2 M2-23 — portable SQLite exit proof.**
 *
 * One representative clean child-process scenario through the public export
 * `createAccordoAppAsync` (not `startPortableSqliteApp`): open a real SQLite
 * file, write and read Company/Contact/Opportunity, run one uniform v2 action,
 * read audit (and the action-runtime trace the selected path writes), close,
 * restart from the same file, read again, close exactly once.
 *
 * Adjacent in-process proofs keep the v1 synchronous factory, the v1 custom
 * package on v1, v1 fail-closed on portable, and PostgreSQL refuse-before-
 * connect with a closed adapter token. This file does not import
 * `create-app.js` and does not wrap `createAccordoApp()` in `Promise.resolve`.
 */

const factoryHref = new URL('../packages/app/src/index.js', import.meta.url).href;

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2-final-exit-'));
  return {
    root,
    dbPath: join(root, 'data', 'accordo.sqlite'),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function workspaceFor(t) {
  const workspace = tempRoot();
  t.after(() => workspace.dispose());
  return workspace;
}

function isAsyncContract(error) {
  return error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400;
}

function v2ExitPackage() {
  return {
    packageContract: 2,
    name: 'probe-exit',
    version: 1,
    label: 'probe-exit',
    actions: [{
      module: 'opportunity',
      name: 'probe-tag',
      actionContract: 2,
      execute: async (ctx) => ({ id: ctx.record.id, tagged: true }),
    }],
    operations: [{
      name: 'probe-ping',
      operationContract: 2,
      appMethod: 'probePing',
      create: () => async () => ({ ok: true }),
    }],
    capabilities: [],
  };
}

function v2ExitSelected() {
  return {
    packageContract: 2,
    packages: [v2ExitPackage()],
    actions: [],
    modules: ['opportunity'],
  };
}

test('this file uses the public async factory, not the source-private portable starter', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*portable-app(?:\.js)?['"]/.test(source), false);
  assert.equal(/from ['"][^'"]*create-app\.js['"]/.test(source), false);
  assert.equal(/Promise\.resolve\s*\(\s*createAccordoApp/.test(source), false);
});

test('createAccordoApp remains synchronous, non-thenable and immediately readable', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.equal(typeof app.then, 'undefined');
    assert.equal(typeof app.services.companies.list, 'function');
    assert.deepEqual(app.services.companies.list(), []);
    assert.equal('database' in app, true);
    assert.equal(typeof app.close.then, 'undefined');
  } finally {
    app.close();
  }
});

test('legacy v1 custom package partner-scorecard still works on v1', () => {
  const custom = createPartnerScorecardPackage();
  assert.equal(custom.packageContract, 1);
  assert.equal(custom.name, 'partner-scorecard');
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.equal(typeof app.then, 'undefined');
    const registry = new PackageRegistry({ packages: [custom] });
    registry.persistFingerprints(app.database);
    assert.deepEqual([...registry.names()], ['partner-scorecard']);
    assert.equal(registry.get('partner-scorecard').packageContract, 1);
    assert.deepEqual(
      registry.get('partner-scorecard').actions,
      ['delivery-partner-engagement.rate-partner'],
    );
    assert.equal('database' in app, true);
  } finally {
    app.close();
  }
});

test('a v1 package fails closed on the portable v2 path before any sqlite path is created', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  const custom = createPartnerScorecardPackage();
  assert.equal(custom.packageContract, 1);

  await assert.rejects(
    () => createAccordoAppAsync({
      selected: {
        packageContract: 2,
        packages: [custom],
        actions: [],
        modules: [],
      },
      dbPath: missingParent,
    }),
    isAsyncContract,
  );
  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('PostgreSQL-shaped options refuse before connection and never echo credentials', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  const user = 'm2-user';
  const token = 's3cret-unavailable';
  const sentinel = `postgresql://${user}:${token}@localhost:5432/accordo`;

  const cases = [
    { adapter: 'postgresql', dbPath: missingParent },
    { adapter: 'postgres', dbPath: missingParent },
    { adapter: sentinel, dbPath: missingParent },
    { dbPath: sentinel },
    { connectionString: sentinel, dbPath: missingParent },
    { connection: { host: 'localhost', user, password: token }, dbPath: missingParent },
  ];

  for (const options of cases) {
    await assert.rejects(
      () => createAccordoAppAsync(options),
      (error) => {
        assert.equal(error.code, 'STORAGE_ADAPTER_UNAVAILABLE');
        assert.equal(error.status, 400);
        assert.equal(error.details?.adapter, 'postgresql');
        const blob = `${error.message}\n${JSON.stringify(error.details)}`;
        assert.equal(blob.includes(token), false, blob);
        assert.equal(blob.includes(user), false, blob);
        assert.equal(blob.includes(sentinel), false, blob);
        if (typeof options.adapter === 'string' && /:\/\//.test(options.adapter)) {
          assert.equal(
            blob.includes(options.adapter),
            false,
            `closed adapter token must be postgresql, never the caller locator: ${blob}`,
          );
        }
        return true;
      },
    );
  }

  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('in-process portable selected graph writes Company, Contact, Opportunity, action, audit and trace', async (t) => {
  const workspace = workspaceFor(t);
  const actor = { type: 'system', id: 'm2-exit' };
  const app = await createAccordoAppAsync({
    dbPath: workspace.dbPath,
    selected: v2ExitSelected(),
  });
  t.after(() => app.close());

  const company = await app.services.companies.create(
    { name: 'Exit Co', domain: 'exit.example' },
    { actor },
  );
  const contact = await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@exit.example',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Exit deal',
    type: 'new_business',
    valueCents: 2500,
    currency: 'EUR',
    stage: 'qualification',
    owner: 'ada',
  }, { actor });

  assert.equal(app.services.companies.get(company.id).name, 'Exit Co');
  assert.equal(app.services.contacts.get(contact.id).email, 'ada@exit.example');
  assert.equal(app.services.opportunities.get(opportunity.id).name, 'Exit deal');
  assert.equal(app.audit.list({ entityType: 'company', entityId: company.id }).length, 1);

  const tagged = await app.runAction({
    module: 'opportunity',
    action: 'probe-tag',
    recordId: opportunity.id,
    actor,
  });
  assert.equal(tagged.ok, true);
  assert.deepEqual(tagged.result, { id: opportunity.id, tagged: true });
  const run = app.workflows.getRun(tagged.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.workflowName, 'opportunity.probe-tag');

  const pinged = await app.operations.run('probe-ping');
  assert.deepEqual(pinged, { ok: true });
});

test('a child process opens portable SQLite, writes, restarts from the same file and closes once', (t) => {
  const workspace = workspaceFor(t);
  const script = `
import { createAccordoAppAsync } from ${JSON.stringify(factoryHref)};

const selected = {
  packageContract: 2,
  packages: [{
    packageContract: 2,
    name: 'probe-exit',
    version: 1,
    label: 'probe-exit',
    actions: [{
      module: 'opportunity',
      name: 'probe-tag',
      actionContract: 2,
      execute: async (ctx) => ({ id: ctx.record.id, tagged: true }),
    }],
    operations: [{
      name: 'probe-ping',
      operationContract: 2,
      appMethod: 'probePing',
      create: () => async () => ({ ok: true }),
    }],
    capabilities: [],
  }],
  actions: [],
  modules: ['opportunity'],
};

const dbPath = ${JSON.stringify(workspace.dbPath)};
const actor = { type: 'system', id: 'm2-exit-child' };

const firstApp = await createAccordoAppAsync({ dbPath, selected });
if (firstApp.packageContract !== 2) process.exit(8);
if (firstApp.storage.adapter !== 'sqlite' || firstApp.storage.available !== true) process.exit(5);
if ('database' in firstApp) process.exit(6);

const company = await firstApp.services.companies.create(
  { name: 'Child Exit Co', domain: 'child-exit.example' },
  { actor },
);
const contact = await firstApp.services.contacts.create({
  companyId: company.id,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@child-exit.example',
}, { actor });
const opportunity = await firstApp.services.opportunities.create({
  companyId: company.id,
  contactId: contact.id,
  name: 'Child exit deal',
  type: 'new_business',
  valueCents: 2500,
  currency: 'EUR',
  stage: 'qualification',
  owner: 'ada',
}, { actor });

if (firstApp.services.companies.get(company.id).name !== 'Child Exit Co') process.exit(2);
if (firstApp.services.contacts.get(contact.id).email !== 'ada@child-exit.example') process.exit(2);
if (firstApp.services.opportunities.get(opportunity.id).name !== 'Child exit deal') process.exit(2);

const companyAudit = firstApp.audit.list({ entityType: 'company', entityId: company.id });
if (companyAudit.length !== 1) process.exit(4);

const tagged = await firstApp.runAction({
  module: 'opportunity',
  action: 'probe-tag',
  recordId: opportunity.id,
  actor,
});
if (!tagged.ok || tagged.result?.tagged !== true) process.exit(9);
const run = firstApp.workflows.getRun(tagged.runId);
if (run.status !== 'completed' || run.workflowName !== 'opportunity.probe-tag') process.exit(9);

const pinged = await firstApp.operations.run('probe-ping');
if (!pinged || pinged.ok !== true) process.exit(10);

const ids = { companyId: company.id, contactId: contact.id, opportunityId: opportunity.id };
await firstApp.close();

const secondApp = await createAccordoAppAsync({ dbPath, selected });
const persistedCompany = secondApp.services.companies.get(ids.companyId);
const persistedContact = secondApp.services.contacts.get(ids.contactId);
const persistedOpportunity = secondApp.services.opportunities.get(ids.opportunityId);
if (persistedCompany.name !== 'Child Exit Co') process.exit(7);
if (persistedContact.email !== 'ada@child-exit.example') process.exit(7);
if (persistedOpportunity.name !== 'Child exit deal') process.exit(7);
if (secondApp.audit.list({ entityType: 'company', entityId: ids.companyId }).length !== 1) process.exit(4);

const firstClose = secondApp.close();
const secondClose = secondApp.close();
if (firstClose !== secondClose) process.exit(3);
await firstClose;
`;

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(existsSync(workspace.dbPath), true);
});
