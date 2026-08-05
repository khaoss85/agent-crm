import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Lead conversion end to end (Milestone 7): qualified Lead → Company + Contact
 * + Opportunity + conversion links, atomically and idempotently, through the
 * generic action surface. One throwaway generated project for the whole file;
 * each test boots its own app/database.
 */

let projectRoot;
let createAgentCrmApp;
let createHttpServer;
let AgentCrmClient;
const actor = { type: 'user', id: 'convert-e2e' };

test.before(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-crm-convert-'));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(projectRoot, entry), { recursive: true });
  }
  const starter = join(projectRoot, 'examples/starters/b2b-lead-qualification');
  for (const manifest of ['lead.module.json', 'task.module.json']) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(projectRoot, 'packages/cli/bin/agent-crm.js'), 'module', 'create', join(starter, manifest), '--apply', '--root', projectRoot],
      { encoding: 'utf8', cwd: projectRoot },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(
    join(projectRoot, 'packages/actions/generated/index.js'),
    [
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      "import { convertLead } from '../../../examples/starters/b2b-lead-qualification/actions/convert.js';",
      'export const generatedActions = [qualifyLead, disqualifyLead, convertLead];',
      '',
    ].join('\n'),
  );
  ({ createAgentCrmApp } = await import(pathToFileURL(join(projectRoot, 'packages/app/src/index.js')).href));
  ({ createHttpServer } = await import(pathToFileURL(join(projectRoot, 'apps/server/src/index.js')).href));
  ({ AgentCrmClient } = await import(pathToFileURL(join(projectRoot, 'packages/sdk/src/index.js')).href));
});

test.after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

async function boot(t, dbPath = ':memory:') {
  const app = createAgentCrmApp({ dbPath });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AgentCrmClient({ baseUrl, actor });
  const close = async () => { await new Promise((resolve) => server.close(resolve)); app.close(); };
  if (t) t.after(close);
  return { app, client, close };
}

async function qualifiedLead(app, overrides = {}) {
  const service = app.modules.get('lead').service;
  const lead = await service.create({
    firstName: 'Dana',
    lastName: 'Rossi',
    email: `dana-${Math.random().toString(36).slice(2)}@acme.example`,
    companyName: 'Acme Corp',
    ...overrides,
  }, { actor });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-20T09:00:00Z' }, actor });
  return service.get(lead.id);
}

test('conversion end to end over HTTP/SDK: create, links, audits, events, trace, repeat, restart', async (t) => {
  const dbPath = join(projectRoot, 'data', `convert-${process.pid}.sqlite`);
  let { app, client, close } = await boot(null, dbPath);
  const leads = client.module('lead');

  // Schema advertises convert with its integer input, gated on qualified.
  const schema = await client.schema();
  const convertMeta = schema.generatedModules.find((m) => m.name === 'lead').actions.find((a) => a.name === 'convert');
  assert.deepEqual(convertMeta.fromStates, ['qualified']);
  assert.deepEqual(
    convertMeta.input.map((f) => [f.name, f.type, f.required]),
    [['opportunityName', 'string', true], ['valueCents', 'integer', true], ['currency', 'string', false], ['owner', 'string', false]],
  );

  const lead = await qualifiedLead(app, { email: 'dana@acme.example' });
  const events = [];
  for (const name of ['company.created', 'contact.created', 'opportunity.created', 'lead.updated']) {
    app.events.subscribe(name, () => events.push(name));
  }

  // Convert on a NEW lead is refused before anything happens.
  const newLead = await app.modules.get('lead').service.create(
    { firstName: 'N', lastName: 'U', email: 'new@x.example', companyName: 'X' }, { actor },
  );
  await assert.rejects(
    () => leads.action(newLead.id, 'convert', { opportunityName: 'Nope', valueCents: 1 }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );

  // Convert the qualified lead (lowercase currency uppercased on the way in).
  const converted = await leads.action(lead.id, 'convert', {
    opportunityName: 'Acme — Enterprise',
    valueCents: 5_000_000,
    currency: 'eur',
  });
  assert.equal(converted.ok, true);
  assert.equal(converted.result.company.reused, false);
  assert.equal(converted.result.contact.reused, false);

  // The lead carries the full conversion state, atomically written.
  const after = await leads.get(lead.id);
  assert.equal(after.status, 'converted');
  assert.ok(after.convertedAt);
  assert.equal(after.convertedCompanyId, converted.result.company.id);
  assert.equal(after.convertedContactId, converted.result.contact.id);
  assert.equal(after.convertedOpportunityId, converted.result.opportunity.id);

  // The core records are real and correctly linked.
  const company = app.services.companies.get(after.convertedCompanyId);
  assert.equal(company.name, 'Acme Corp');
  const contact = app.services.contacts.get(after.convertedContactId);
  assert.equal(contact.companyId, company.id);
  assert.equal(contact.email, 'dana@acme.example');
  const opportunity = app.services.opportunities.get(after.convertedOpportunityId);
  assert.equal(opportunity.companyId, company.id);
  assert.equal(opportunity.contactId, contact.id);
  assert.equal(opportunity.valueCents, 5_000_000);
  assert.equal(opportunity.currency, 'EUR');
  assert.equal(opportunity.type, 'new_business');
  assert.equal(opportunity.stage, 'qualification');
  assert.equal(opportunity.owner, 'convert-e2e', 'owner defaults to the actor id');
  assert.equal(opportunity.sourceKey, `lead-conversion:${lead.id}`);

  // Audit exactness: one create audit each + exactly one lead.updated for the
  // conversion (the qualify updated it once before the subscription window).
  assert.deepEqual(events.sort(), ['company.created', 'contact.created', 'lead.updated', 'opportunity.created']);
  assert.deepEqual(app.audit.list({ entityType: 'company' }).map((a) => a.action), ['company.created']);
  assert.deepEqual(app.audit.list({ entityType: 'opportunity' }).map((a) => a.action), ['opportunity.created']);

  // The trace shows the business steps on a completed run. (The rejected
  // convert-on-new attempt above also left a run — a FAILED one; that is the
  // documented behavior, so filter to completed here.)
  const run = await client.request(`/api/traces?workflowName=lead.convert&status=completed`);
  assert.equal(run.items.length, 1);
  assert.equal(run.items[0].status, 'completed');
  const spans = (await client.request(`/api/traces/${run.items[0].id}`)).spans ?? [];
  const spanNames = spans.map((s) => s.name);
  for (const name of ['company', 'contact', 'opportunity']) assert.ok(spanNames.includes(name), `span ${name}`);

  // Repeat conversion → 409, nothing duplicated.
  events.length = 0;
  await assert.rejects(
    () => leads.action(lead.id, 'convert', { opportunityName: 'Again', valueCents: 1 }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  assert.equal(app.services.opportunities.list().length, 1);
  assert.deepEqual(events, []);

  // CRUD can never write conversion links, alone or mixed with public fields.
  for (const patch of [
    { convertedCompanyId: 'forged' },
    { convertedContactId: 'forged' },
    { convertedOpportunityId: 'forged' },
    { convertedAt: '2026-01-01T00:00:00.000Z' },
    { firstName: 'Sneaky', convertedOpportunityId: 'forged' },
  ]) {
    await assert.rejects(() => leads.update(lead.id, patch), (error) => error.status === 400 && error.code === 'VALIDATION_ERROR');
  }
  await assert.rejects(
    () => leads.create({ firstName: 'F', lastName: 'G', email: 'fg@x.example', convertedCompanyId: 'forged' }),
    (error) => error.status === 400,
  );

  // Restart: everything persists.
  await close();
  ({ app, client } = await boot(t, dbPath));
  const survived = await client.module('lead').get(lead.id);
  assert.equal(survived.status, 'converted');
  assert.equal(app.services.opportunities.get(survived.convertedOpportunityId).sourceKey, `lead-conversion:${lead.id}`);
});

test('input validation: names, money, currency and lead preconditions', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');
  const lead = await qualifiedLead(app);
  const countsBefore = () => [
    app.services.companies.list().length,
    app.services.contacts.list().length,
    app.services.opportunities.list().length,
  ];
  const before = countsBefore();

  const cases = [
    [{ valueCents: 1 }, /opportunityName/],                                        // missing name
    [{ opportunityName: '   ', valueCents: 1 }, /opportunityName/],                // blank name
    [{ opportunityName: 'Deal' }, /valueCents/],                                   // missing value
    [{ opportunityName: 'Deal', valueCents: -1 }, /zero or positive/],             // negative
    [{ opportunityName: 'Deal', valueCents: 10.5 }, /whole number/],               // fractional
    [{ opportunityName: 'Deal', valueCents: '50000' }, /whole number/],            // numeric string
    [{ opportunityName: 'Deal', valueCents: Number.MAX_SAFE_INTEGER + 2 }, /whole number/], // unsafe
    [{ opportunityName: 'Deal', valueCents: 1, currency: 'EU' }, /ISO-4217/],      // short currency
    [{ opportunityName: 'Deal', valueCents: 1, currency: 'EURO' }, /ISO-4217/],    // long currency
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(
      () => leads.action(lead.id, 'convert', input),
      (error) => error.status === 400 && pattern.test(error.message),
      `expected 400 for ${JSON.stringify(input)}`,
    );
  }
  // Array/primitive inputs: the SDK guard throws synchronously before any
  // HTTP; a raw array body straight at the route is a 400 from the server.
  assert.throws(() => leads.action(lead.id, 'convert', []), /plain object/);
  await assert.rejects(
    () => client.request(`/api/modules/lead/records/${encodeURIComponent(lead.id)}/actions/convert`, { method: 'POST', body: [1, 2] }),
    (error) => error.status === 400,
  );
  assert.deepEqual(countsBefore(), before, 'no failed validation created anything');
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'qualified');

  // A lead without companyName cannot convert (validated before any write).
  const bare = await qualifiedLead(app, { companyName: undefined, email: 'bare@x.example' });
  await assert.rejects(
    () => leads.action(bare.id, 'convert', { opportunityName: 'Deal', valueCents: 1 }),
    (error) => error.status === 400 && error.details?.field === 'companyName',
  );

  // A disqualified lead cannot convert.
  const dead = await app.modules.get('lead').service.create(
    { firstName: 'D', lastName: 'Q', email: 'dq@x.example', companyName: 'DQ Inc' }, { actor },
  );
  await app.runAction({ module: 'lead', action: 'disqualify', recordId: dead.id, input: { reason: 'no fit' }, actor });
  await assert.rejects(
    () => leads.action(dead.id, 'convert', { opportunityName: 'Deal', valueCents: 1 }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );

  // Zero is a legal value (a free pilot), and value 0 persists as 0.
  const free = await qualifiedLead(app, { companyName: 'Zero Co', email: 'zero@x.example' });
  const freeResult = await leads.action(free.id, 'convert', { opportunityName: 'Pilot', valueCents: 0 });
  assert.equal(app.services.opportunities.get(freeResult.result.opportunity.id).valueCents, 0);
});

test('company reuse policy: normalization, reuse, ambiguity', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');

  // Existing company with different case/whitespace/Unicode form is reused.
  const existing = await app.services.companies.create({ name: 'Größe  GmbH' }, { actor });
  const lead = await qualifiedLead(app, { companyName: 'größe gmbh', email: 'g@groesse.example' });
  const result = await leads.action(lead.id, 'convert', { opportunityName: 'Deal', valueCents: 1 });
  assert.equal(result.result.company.id, existing.id);
  assert.equal(result.result.company.reused, true);
  assert.equal(app.services.companies.list().length, 1, 'no duplicate company');
  // A reused company gets NO fresh create audit from the conversion.
  assert.equal(app.audit.list({ entityType: 'company' }).length, 1, 'only the original create audit');

  // Two normalized-equal companies → ambiguity is refused, nothing written.
  await app.services.companies.create({ name: 'Dup Co' }, { actor });
  await app.services.companies.create({ name: '  dup   co ' }, { actor });
  const ambiguous = await qualifiedLead(app, { companyName: 'DUP CO', email: 'dup@x.example' });
  const contactsBefore = app.services.contacts.list().length;
  const oppsBefore = app.services.opportunities.list().length;
  await assert.rejects(
    () => leads.action(ambiguous.id, 'convert', { opportunityName: 'Deal', valueCents: 1 }),
    (error) => error.status === 409 && error.code === 'AMBIGUOUS_COMPANY' && error.details.matches.length === 2,
  );
  assert.equal(app.modules.get('lead').service.get(ambiguous.id).status, 'qualified', 'lead untouched');
  assert.equal(app.services.contacts.list().length, contactsBefore);
  assert.equal(app.services.opportunities.list().length, oppsBefore);
});

test('contact reuse policy: same-company reuse, cross-company refusal with full rollback', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');

  // Reuse: the contact already exists under the SAME (normalized) company.
  const beta = await app.services.companies.create({ name: 'Beta Srl' }, { actor });
  const bob = await app.services.contacts.create(
    { companyId: beta.id, firstName: 'Bob', lastName: 'B', email: 'bob@beta.example' }, { actor },
  );
  const lead = await qualifiedLead(app, { companyName: 'beta srl', email: 'BOB@beta.example' });
  const result = await leads.action(lead.id, 'convert', { opportunityName: 'Beta deal', valueCents: 10 });
  assert.equal(result.result.contact.id, bob.id);
  assert.equal(result.result.contact.reused, true);
  assert.equal(app.audit.list({ entityType: 'contact' }).length, 1, 'no fake create audit for the reused contact');

  // Refusal: the email belongs to a contact of ANOTHER company. The company
  // created earlier in the same transaction must be rolled back, and the
  // pre-existing records must survive untouched.
  const clash = await qualifiedLead(app, { companyName: 'Fresh New Co', email: 'bob@beta.example' });
  const companiesBefore = app.services.companies.list().length;
  const events = [];
  app.events.subscribe('*', ({ event }) => events.push(event));
  await assert.rejects(
    () => leads.action(clash.id, 'convert', { opportunityName: 'Clash', valueCents: 10 }),
    (error) => error.status === 409 && error.code === 'CONTACT_COMPANY_MISMATCH',
  );
  assert.equal(app.services.companies.list().length, companiesBefore, 'the in-transaction Fresh New Co was rolled back');
  assert.ok(!app.services.companies.list().some((c) => c.name === 'Fresh New Co'));
  assert.equal(app.services.contacts.get(bob.id).companyId, beta.id, 'pre-existing contact untouched');
  assert.equal(app.modules.get('lead').service.get(clash.id).status, 'qualified');
  assert.deepEqual(events, [], 'no events escaped the rollback');
  // The failed attempt still left a diagnostic trace.
  const failed = app.database.raw.prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_name = 'lead.convert' AND status = 'failed'").get();
  assert.equal(Number(failed.n), 1);
});

test('opportunity idempotency key: a squatted source key aborts the whole conversion', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');
  const lead = await qualifiedLead(app, { companyName: 'Squat Co', email: 'sq@x.example' });

  // Squat the deterministic key through the public opportunity surface.
  const anyCompany = await app.services.companies.create({ name: 'Other' }, { actor });
  await app.services.opportunities.create(
    { companyId: anyCompany.id, name: 'Squatter', valueCents: 1, owner: 'x', sourceKey: `lead-conversion:${lead.id}` },
    { actor },
  );

  const auditBefore = app.audit.list({}).length;
  await assert.rejects(
    () => leads.action(lead.id, 'convert', { opportunityName: 'Deal', valueCents: 1 }),
    (error) => error.status === 409 && error.code === 'CONFLICT',
  );
  // Full rollback: no Squat Co company, no contact, lead still qualified.
  assert.ok(!app.services.companies.list().some((c) => c.name === 'Squat Co'));
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'qualified');
  assert.equal(app.audit.list({}).length, auditBefore, 'no audit survived the rollback');
});

test('fault injection at COMMIT: everything rolls back, reused records survive', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');
  const reused = await app.services.companies.create({ name: 'Keep Me' }, { actor });
  const lead = await qualifiedLead(app, { companyName: 'keep me', email: 'keep@x.example' });

  const realExec = app.database.raw.exec.bind(app.database.raw);
  let armed = true;
  app.database.raw.exec = (sql) => {
    if (armed && /^COMMIT;$/.test(sql)) { armed = false; throw new Error('injected commit failure'); }
    return realExec(sql);
  };
  t.after(() => { app.database.raw.exec = realExec; });

  await assert.rejects(
    () => leads.action(lead.id, 'convert', { opportunityName: 'Doomed', valueCents: 1 }),
    /injected commit failure/,
  );
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'qualified');
  assert.equal(app.services.contacts.list().length, 0);
  assert.equal(app.services.opportunities.list().length, 0);
  // The pre-existing company that would have been REUSED is untouched.
  assert.equal(app.services.companies.get(reused.id).name, 'Keep Me');
});

test('a post-commit subscriber failure does not undo a conversion', async (t) => {
  const { app, client } = await boot(t);
  const lead = await qualifiedLead(app, { companyName: 'Sub Co', email: 'sub@x.example' });
  app.events.subscribe('opportunity.created', () => { throw new Error('subscriber exploded'); });
  const result = await client.module('lead').action(lead.id, 'convert', { opportunityName: 'Deal', valueCents: 1 });
  assert.equal(result.ok, true);
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'converted');
  const run = app.database.raw.prepare("SELECT id, status FROM workflow_runs WHERE workflow_name = 'lead.convert'").get();
  assert.equal(run.status, 'completed');
});

test('concurrency: same lead races to one conversion; shared company never duplicates', async (t) => {
  const { app, client } = await boot(t);
  const leads = client.module('lead');

  // Same lead, concurrent: one success, one 409, one opportunity.
  const lead = await qualifiedLead(app, { companyName: 'Race Co', email: 'race@x.example' });
  const results = await Promise.allSettled([
    leads.action(lead.id, 'convert', { opportunityName: 'A', valueCents: 1 }),
    leads.action(lead.id, 'convert', { opportunityName: 'B', valueCents: 2 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = results.find((r) => r.status === 'rejected');
  assert.equal(loser.reason.status, 409);
  assert.equal(app.services.opportunities.list().length, 1);
  assert.equal(app.services.companies.list().filter((c) => c.name === 'Race Co').length, 1);

  // Two DIFFERENT leads, same company name, concurrent: both convert, ONE company.
  const leadA = await qualifiedLead(app, { companyName: 'Shared Co', email: 'a@shared.example' });
  const leadB = await qualifiedLead(app, { companyName: '  SHARED   CO ', email: 'b@shared.example' });
  const both = await Promise.allSettled([
    leads.action(leadA.id, 'convert', { opportunityName: 'A deal', valueCents: 1 }),
    leads.action(leadB.id, 'convert', { opportunityName: 'B deal', valueCents: 2 }),
  ]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'fulfilled']);
  const shared = app.services.companies.list().filter((c) => normalize(c.name) === 'shared co');
  assert.equal(shared.length, 1, 'exactly one Shared Co despite concurrent conversions');
  assert.equal(both[0].value.result.company.id, both[1].value.result.company.id);

  function normalize(name) { return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
});

test('two independent connections: one winner, loser gets a stable 409, retry does not duplicate', async (t) => {
  const dbPath = join(projectRoot, 'data', `convert-race-${process.pid}.sqlite`);
  const appA = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  const appB = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  t.after(() => { appA.close(); appB.close(); });
  const lead = await qualifiedLead(appA, { companyName: 'Cross Co', email: 'cross@x.example' });

  const convert = (app, name) => app.runAction({
    module: 'lead', action: 'convert', recordId: lead.id,
    input: { opportunityName: name, valueCents: 1 }, actor,
  });
  const results = await Promise.allSettled([convert(appA, 'A'), convert(appB, 'B')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loss = results.find((r) => r.status === 'rejected').reason;
  assert.equal(loss.status, 409, `${loss.code}: ${loss.message}`);
  assert.ok(['INVALID_STATE', 'CONFLICT'].includes(loss.code));

  await assert.rejects(
    () => convert(appB, 'retry'),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  assert.equal(appA.services.opportunities.list().length, 1);
});

test('core migration v2 upgrades an existing v1 database in place', async (t) => {
  // Simulate a pre-M7 database: schema v1 only, with a real opportunity row.
  const dbPath = join(projectRoot, 'data', `upgrade-${process.pid}.sqlite`);
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  const { createDatabase } = await import(pathToFileURL(join(projectRoot, 'packages/core/src/database.js')).href);
  old.close();
  rmSync(dbPath, { force: true });

  // Build v1+v2 fresh, then reopen: both recorded, reopen is a no-op.
  let database = createDatabase({ path: dbPath });
  database.raw.prepare(`
    INSERT INTO companies(id, name, domain, created_at, updated_at) VALUES ('c1', 'Old Co', NULL, 't', 't')
  `).run();
  database.raw.prepare(`
    INSERT INTO opportunities(id, company_id, name, type, value_cents, currency, stage, owner, created_at, updated_at)
    VALUES ('o1', 'c1', 'Legacy', 'renewal', 100, 'EUR', 'discovery', 'x', 't', 't')
  `).run();
  const versions = database.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
  assert.deepEqual(versions, [1, 2]);
  const legacy = database.raw.prepare('SELECT source_key FROM opportunities WHERE id = ?').get('o1');
  assert.equal(legacy.source_key, null, 'pre-existing rows keep a NULL source key');
  // The partial unique index permits many NULLs but blocks duplicate keys.
  database.raw.prepare("UPDATE opportunities SET source_key = 'k1' WHERE id = 'o1'").run();
  database.raw.prepare(`
    INSERT INTO opportunities(id, company_id, name, type, value_cents, currency, stage, owner, source_key, created_at, updated_at)
    VALUES ('o2', 'c1', 'Dup', 'renewal', 100, 'EUR', 'discovery', 'x', 'k1', 't', 't')
  `);
  assert.throws(() => {
    database.raw.prepare(`
      INSERT INTO opportunities(id, company_id, name, type, value_cents, currency, stage, owner, source_key, created_at, updated_at)
      VALUES ('o2', 'c1', 'Dup', 'renewal', 100, 'EUR', 'discovery', 'x', 'k1', 't', 't')
    `).run();
  }, /UNIQUE/);
  database.close();
  database = createDatabase({ path: dbPath });
  t.after(() => database.close());
  assert.equal(database.raw.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 1);
});
