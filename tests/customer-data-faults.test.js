import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROWS, boot, project } from './helpers/customer-data-project.js';

/**
 * **Attacking every write: faults, races, restarts and detach.**
 *
 * The properties under attack are the ones a foundation cannot get wrong
 * without becoming untrustworthy: an import that fails leaves *nothing*
 * behind, two connections racing produce one winner through database
 * uniqueness rather than an in-process lock, a canonical identity decision is
 * never half-applied, and detaching the package leaves every business record
 * exactly where it was.
 */

const ACTOR = { type: 'user', id: 'faults' };

function fingerprint(app) {
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    for (const row of app.database.raw.prepare(`SELECT * FROM ${table}`).all()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

async function refusal(promise) {
  try { return { ok: true, value: await promise }; }
  catch (error) { return { ok: false, code: error.code ?? null, message: String(error.message) }; }
}

test('a fault after the run row is written rolls the whole import back', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'fault.sqlite');
  const { app, close } = await boot(root, dbPath);
  t.after(() => close());

  const before = fingerprint(app);

  // Inject a failure into the middle of the transaction: the receipt writer
  // throws after the run row and the first records already exist.
  const rowService = app.modules.get('customer-import-row').service;
  const realCreate = rowService.createManaged.bind(rowService);
  let seen = 0;
  rowService.createManaged = async (...args) => {
    seen += 1;
    if (seen === 2) throw new Error('injected storage failure');
    return realCreate(...args);
  };

  const failed = await refusal(app.applyCustomerImport({
    system: 'crm-export', rows: [ROWS.newContact, ROWS.otherContact], actor: ACTOR,
  }));
  rowService.createManaged = realCreate;

  assert.equal(failed.ok, false, 'the injected fault must surface');
  assert.equal(fingerprint(app), before,
    'a failed import leaves no run, no receipt, no identity, no company and no contact');
  for (const table of ['customer_import_runs', 'customer_import_rows', 'external_identities', 'companies', 'contacts']) {
    assert.equal(app.database.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} must be empty`);
  }

  // …and the same import retried afterwards succeeds completely.
  const retried = await app.applyCustomerImport({
    system: 'crm-export', rows: [ROWS.newContact, ROWS.otherContact], actor: ACTOR,
  });
  assert.equal(retried.counts.accepted, 2);
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM customer_import_runs').get().n, 1);
});

test('two connections racing the same import produce exactly one run', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'race.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const one = createAccordoApp({ dbPath });
  const two = createAccordoApp({ dbPath, busyTimeoutMs: 5000 });
  t.after(() => { one.close(); two.close(); });

  const rows = [ROWS.newContact, ROWS.otherContact];
  const results = await Promise.allSettled([
    one.applyCustomerImport({ system: 'crm-export', rows, actor: ACTOR }),
    two.applyCustomerImport({ system: 'crm-export', rows, actor: ACTOR }),
  ]);

  const runs = one.database.raw.prepare('SELECT id, idempotency_key FROM customer_import_runs').all();
  assert.equal(runs.length, 1, 'the unique idempotency key decides the winner, not an in-process lock');
  assert.equal(one.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 2,
    'and the losing connection creates no duplicate contacts');

  // Whatever each connection returned, neither invented a second run.
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.runId) {
      assert.equal(result.value.runId, runs[0].id);
    }
  }
  // No raw SQLite error escaped to the caller.
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.doesNotMatch(String(result.reason?.message ?? ''), /SQLITE_|constraint failed/i,
        'a race must not surface a raw SQLite error');
    }
  }
});

test('a canonical identity decision is never half applied', async (t) => {
  const root = project(t);
  const { app, close } = await boot(root, join(root, 'data', 'half.sqlite'));
  t.after(() => close());

  const first = await app.services.companies.create({ name: 'Soylent Srl', domain: 'soylent.example' }, { actor: ACTOR });
  await app.services.companies.create({ name: 'Soylent Srl', domain: 'soylent.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Soylent Srl', domain: 'soylent.example' }], actor: ACTOR });
  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 5 })[0];

  // Fail while writing the SECOND cluster member.
  const links = app.modules.get('canonical-link').service;
  const realCreate = links.createManaged.bind(links);
  let calls = 0;
  links.createManaged = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error('injected failure writing the alias member');
    return realCreate(...args);
  };
  const failed = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same entity' }, actor: ACTOR,
  }));
  links.createManaged = realCreate;

  assert.equal(failed.ok, false);
  assert.equal(app.modules.get('canonical-link').service.list({ limit: 10 }).length, 0,
    'a cluster is written whole or not at all — never one member');
  assert.equal(app.modules.get('duplicate-candidate').service.get(candidate.id).status, 'unresolved',
    'and the candidate is still open for a real decision');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 2);

  // The decision then succeeds cleanly.
  const linked = await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same entity' }, actor: ACTOR,
  });
  assert.equal(linked.result.clusterKey.startsWith('cluster:company:'), true);
  assert.equal(app.modules.get('canonical-link').service.list({ limit: 10 }).length, 2);
});

test('a restart preserves every record and every decision', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'restart.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);

  const first = createAccordoApp({ dbPath });
  const applied = await first.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact, ROWS.otherContact], actor: ACTOR });
  const contactId = first.database.raw.prepare('SELECT id FROM contacts ORDER BY created_at LIMIT 1').get().id;
  const beforeClose = fingerprint(first);
  first.close();

  const second = createAccordoApp({ dbPath });
  t.after(() => second.close());
  assert.equal(fingerprint(second), beforeClose, 'a restart changes nothing');
  const run = second.modules.get('customer-import-run').service.get(applied.runId);
  assert.equal(run.acceptedCount, 2);
  const profile = await second.readCustomerProfile({ resource: 'contact', id: contactId });
  assert.equal(profile.externalIdentities.length, 1, 'provenance survives a restart');

  // And the same import is still recognised as already applied.
  const replay = await second.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact, ROWS.otherContact], actor: ACTOR });
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, applied.runId);
});

test('detaching the package leaves every business record exactly where it was', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'detach.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);

  const composed = createAccordoApp({ dbPath });
  await composed.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact, ROWS.otherContact], actor: ACTOR });
  const companies = composed.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  const contacts = composed.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const identities = composed.database.raw.prepare('SELECT COUNT(*) AS n FROM external_identities').get().n;
  composed.close();

  // Remove the composition line and nothing else. A fresh process, because a
  // composition change is a restart.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');
  const script = join(root, 'detached.mjs');
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    'const out = {};',
    'try {',
    "  out.previewGone = typeof app.previewCustomerImport;",
    "  out.applyGone = typeof app.applyCustomerImport;",
    "  out.profileGone = typeof app.readCustomerProfile;",
    "  out.companies = app.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n;",
    "  out.contacts = app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;",
    "  out.identities = app.database.raw.prepare('SELECT COUNT(*) AS n FROM external_identities').get().n;",
    "  out.coreStillWorks = Boolean((await app.services.companies.create({ name: 'After Detach' }, { actor: { type: 'user', id: 'd' } })).id);",
    '} finally { app.close(); }',
    'console.log("__RESULT__" + JSON.stringify(out));',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `the detached app did not boot:\n${run.stderr}`);
  const result = JSON.parse(line.slice('__RESULT__'.length));

  assert.equal(result.previewGone, 'undefined', 'the operations leave with the package');
  assert.equal(result.applyGone, 'undefined');
  assert.equal(result.profileGone, 'undefined');
  assert.equal(result.coreStillWorks, true, 'and the application keeps working without it');

  // The rows stay: removing a package is not a data migration.
  assert.equal(result.companies, companies, 'companies are untouched');
  assert.equal(result.contacts, contacts, 'contacts are untouched');
  assert.equal(result.identities, identities, 'and the foundation records are still on disk');
});

test('an old database with no customer-data tables upgrades cleanly', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'upgrade.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);

  // A project that predates the package: composition removed, so its
  // migrations have not run and its tables do not exist.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');
  const before = spawnSync(process.execPath, ['--no-warnings', '-e', `
    import('${pathToFileURL(join(root, 'packages/app/src/index.js')).href}').then(async ({ createAccordoApp }) => {
      const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });
      const company = await app.services.companies.create({ name: 'Legacy Co', domain: 'legacy.example' }, { actor: { type: 'user', id: 'legacy' } });
      await app.services.contacts.create({ companyId: company.id, firstName: 'Old', lastName: 'Record', email: 'old@legacy.example' }, { actor: { type: 'user', id: 'legacy' } });
      console.log('__PRE__' + JSON.stringify({ companyId: company.id }));
      app.close();
    });
  `], { encoding: 'utf8', cwd: root });
  const pre = JSON.parse((before.stdout || '').split('\n').find((l) => l.startsWith('__PRE__')).slice('__PRE__'.length));

  // Now compose the package on top of that database.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    'export const generatedDomains = [createCustomerDataPackage()];',
    '',
  ].join('\n'));
  const app = createAccordoApp({ dbPath });
  t.after(() => app.close());

  // The pre-existing rows are readable and untouched.
  assert.equal(app.services.companies.get(pre.companyId).name, 'Legacy Co');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1);

  // …and the foundation now works over that history: the legacy contact is
  // matched by email rather than duplicated.
  const applied = await app.applyCustomerImport({
    system: 'crm-export', rows: [{ externalId: 'LEG-1', email: 'old@legacy.example' }], actor: ACTOR,
  });
  assert.equal(applied.counts.accepted, 1);
  assert.equal(applied.receipts[0].matchRule, 'contact-email');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1,
    'an existing contact is matched, never duplicated by an upgrade');
});
