import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROWS, boot, project } from './helpers/customer-data-project.js';

/**
 * **Customer Data Foundation v1 (ADR-037), against a real composed app.**
 *
 * The claims this suite exists to hold are the ones that would be expensive to
 * get wrong: a preview that writes nothing, receipts that reconcile exactly, an
 * idempotency key derived from the payload rather than a clock, matching that
 * never guesses, and a canonical identity decision that links records without
 * deleting or rewriting a single one.
 */

const ACTOR = { type: 'user', id: 'cdf' };
const AGENT = { type: 'agent', id: 'bot' };

/** Everything in the database, hashed — the honest way to assert "wrote nothing". */
function fingerprintDatabase(app) {
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    for (const row of app.database.raw.prepare(`SELECT * FROM ${table}`).all()) {
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest('hex');
}

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message), details: error.details ?? null };
  }
}

async function scene(t, tag, options = {}) {
  const root = project(t, options);
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

/* ------------------------------------------------------------------ import */

test('a preview resolves the whole batch and writes absolutely nothing', async (t) => {
  const { app } = await scene(t, 'preview');
  const rows = [ROWS.newContact, ROWS.otherContact, ROWS.invalidEmail, ROWS.noIdentity];

  const before = fingerprintDatabase(app);
  const preview = await app.previewCustomerImport({ system: 'crm-export', rows, actor: ACTOR });
  const after = fingerprintDatabase(app);

  assert.equal(after, before, 'a preview must not change one byte of the database');
  assert.equal(preview.mode, 'preview');
  assert.match(preview.writes, /^nothing/i, 'the contract states plainly that it wrote nothing');
  assert.match(preview.writes, /neither business data nor an import run/i);
  assert.equal(preview.runId, null);

  // It still answers the whole question.
  assert.equal(preview.counts.rows, 4);
  assert.equal(preview.counts.accepted, 2, 'two rows identify somebody new');
  assert.equal(preview.counts.rejected, 2, 'an invalid email and a row identifying nobody');
  assert.deepEqual(preview.receipts.map((receipt) => receipt.reasonCode),
    ['CREATED_RECORD', 'CREATED_RECORD', 'INVALID_EMAIL', 'MISSING_REQUIRED_IDENTITY']);
});

test('every row gets a receipt, and the counts reconcile exactly', async (t) => {
  const { app } = await scene(t, 'receipts');
  const rows = [ROWS.newContact, ROWS.otherContact, ROWS.invalidEmail, ROWS.noIdentity, ROWS.sameContactAgain];

  const applied = await app.applyCustomerImport({ system: 'crm-export', rows, actor: ACTOR });
  const { rows: total, accepted, rejected, skipped } = applied.counts;
  assert.equal(accepted + rejected + skipped, total, 'no receipt may go missing');
  assert.equal(applied.receipts.length, total, 'one receipt per input row, always');

  // The stored receipts say the same thing as the returned summary.
  const stored = app.modules.get('customer-import-row').service.listWhere({ runId: applied.runId });
  assert.equal(stored.length, total);
  const run = app.modules.get('customer-import-run').service.get(applied.runId);
  assert.equal(run.rowCount, total);
  assert.equal(run.acceptedCount + run.rejectedCount + run.skippedCount, run.rowCount);
  assert.equal(stored.filter((row) => row.outcome === 'rejected').length, run.rejectedCount);
  // A rejected row keeps its reason and never echoes the offending value.
  const bad = stored.find((row) => row.reasonCode === 'INVALID_EMAIL');
  assert.ok(bad.reason && !bad.reason.includes('not..an@address'));
});

test('the idempotency key is business-derived: the same payload replays, a different one does not', async (t) => {
  const { app } = await scene(t, 'idempotency');
  const rows = [ROWS.newContact, ROWS.otherContact];

  const first = await app.applyCustomerImport({ system: 'crm-export', rows, actor: ACTOR });
  assert.equal(first.replayed, false);

  // Same rows in a different order are the same import.
  const replay = await app.applyCustomerImport({ system: 'crm-export', rows: [...rows].reverse(), actor: ACTOR });
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, first.runId, 'a retry returns the same run, not a second one');
  assert.equal(app.modules.get('customer-import-run').service.list({ limit: 50 }).length, 1);
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 2, 'and it creates nothing twice');

  // A different payload is a different import, never an adoption of this one.
  const different = await app.applyCustomerImport({
    system: 'crm-export', rows: [...rows, { externalId: 'CRM-9', email: 'new@northwind.example' }], actor: ACTOR,
  });
  assert.notEqual(different.idempotencyKey, first.idempotencyKey);
  assert.equal(different.replayed, false);

  // The key contains no clock: two runs of the same payload agree.
  assert.equal(replay.idempotencyKey, first.idempotencyKey);
  assert.match(first.idempotencyKey, /^[0-9a-f]{64}$/);
});

test('all-or-nothing refuses the whole batch, and writes nothing at all', async (t) => {
  const { app } = await scene(t, 'all-or-nothing');
  const before = fingerprintDatabase(app);

  const refused = await refusal(app.applyCustomerImport({
    system: 'crm-export', acceptance: 'all_or_nothing',
    rows: [ROWS.newContact, ROWS.invalidEmail], actor: ACTOR,
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'IMPORT_NOT_FULLY_ACCEPTABLE');
  assert.equal(refused.status, 409);
  assert.equal(refused.details.firstProblemRow, 1, 'the refusal names which row stopped it');
  assert.equal(fingerprintDatabase(app), before, 'an all-or-nothing refusal writes nothing');

  // The same batch under partial acceptance keeps the good row and receipts the bad one.
  const partial = await app.applyCustomerImport({
    system: 'crm-export', acceptance: 'partial', rows: [ROWS.newContact, ROWS.invalidEmail], actor: ACTOR,
  });
  assert.equal(partial.counts.accepted, 1);
  assert.equal(partial.counts.rejected, 1);
});

test('external identity is recorded beside the record, with provenance and no payload', async (t) => {
  const { app } = await scene(t, 'identity');
  const applied = await app.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact], actor: ACTOR });

  const identities = app.modules.get('external-identity').service.list({ limit: 10 });
  assert.equal(identities.length, 1);
  const identity = identities[0];
  assert.equal(identity.system, 'crm-export');
  assert.equal(identity.externalId, 'CRM-1');
  assert.equal(identity.sourceKey, 'crm-export:CRM-1');
  assert.equal(identity.subjectResource, 'contact');
  assert.equal(identity.status, 'active');
  assert.equal(identity.firstObservedRunId, applied.runId);

  // Provenance, not payload: no column holds a raw source record.
  const columns = Object.keys(identity);
  assert.equal(columns.some((name) => /payload|raw|body|response|secret|token|credential/i.test(name)), false,
    `external-identity must store no raw payload or secret: ${columns.join(', ')}`);

  // A second sighting updates lastObserved rather than creating a second row.
  const again = await app.applyCustomerImport({
    system: 'crm-export', rows: [ROWS.newContact, { externalId: 'CRM-5', email: 'zoe@northwind.example' }], actor: ACTOR,
  });
  assert.equal(again.replayed, false);
  const after = app.modules.get('external-identity').service.listWhere({ sourceKey: 'crm-export:CRM-1' });
  assert.equal(after.length, 1, 'one identifier names one record, once');
  assert.equal(after[0].lastObservedRunId, again.runId);
});

test('matching is deterministic: the same identifier matches, and nothing else is guessed', async (t) => {
  const { app } = await scene(t, 'matching');
  await app.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact], actor: ACTOR });

  // Rule 1: exact external identity, even when the email is written differently.
  const byExternal = await app.previewCustomerImport({
    system: 'crm-export', rows: [{ externalId: 'CRM-1', email: 'ADA@NORTHWIND.EXAMPLE' }], actor: ACTOR,
  });
  assert.equal(byExternal.receipts[0].matchRule, 'external-identity');
  assert.equal(byExternal.receipts[0].outcome, 'accepted');

  // Rule 2: exact normalized email, with no external id at all.
  const byEmail = await app.previewCustomerImport({
    system: 'other-system', rows: [{ email: '  Ada@Northwind.Example ' }], actor: ACTOR,
  });
  assert.equal(byEmail.receipts[0].matchRule, 'contact-email');
  assert.equal(byEmail.receipts[0].outcome, 'accepted');

  // A near-miss is NOT a match: one character different is a different person.
  const nearMiss = await app.previewCustomerImport({
    system: 'other-system', rows: [{ email: 'adaa@northwind.example', companyName: 'Northwind Ltd', domain: 'northwind.example' }], actor: ACTOR,
  });
  assert.notEqual(nearMiss.receipts[0].matchRule, 'contact-email', 'no fuzzy email matching exists');

  // Company name alone never matches; it needs the domain too.
  const nameOnly = await app.previewCustomerImport({
    system: 'other-system', rows: [{ companyName: 'Northwind Ltd' }], actor: ACTOR,
  });
  assert.equal(nameOnly.receipts[0].outcome, 'skipped');
  assert.equal(nameOnly.receipts[0].reasonCode, 'AMBIGUOUS_CANDIDATES');
  assert.match(nameOnly.receipts[0].reason, /no domain/i);
});

/* --------------------------------------------------------------- canonical */

test('canonical identity is a human-only LOGICAL link: both records survive untouched', async (t) => {
  const { app } = await scene(t, 'canonical');

  // Two companies that a deterministic rule flags as candidates.
  const first = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  const second = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  const preview = await app.previewCustomerImport({
    system: 'crm-export', rows: [{ companyName: 'Globex Srl', domain: 'globex.example' }], actor: ACTOR,
  });
  assert.equal(preview.receipts[0].outcome, 'skipped', 'two identical companies are ambiguous, never auto-picked');
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Globex Srl', domain: 'globex.example' }], actor: ACTOR });

  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];
  assert.ok(candidate, 'the ambiguity became a candidate for a human');
  assert.equal(candidate.status, 'unresolved');

  // An agent may not decide identity.
  const byAgent = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same company' }, actor: AGENT,
  }));
  assert.equal(byAgent.ok, false);
  assert.equal(byAgent.code, 'HUMAN_APPROVAL_REQUIRED');

  // The canonical record must be one of the two under discussion.
  const foreign = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: 'someone-else', reason: 'same company' }, actor: ACTOR,
  }));
  assert.equal(foreign.ok, false);

  const linked = await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same legal entity, imported twice' }, actor: ACTOR,
  });
  assert.match(linked.result.semantics, /logical canonical merge/i);
  assert.match(linked.result.semantics, /nothing was deleted/i);

  // THE claim: both records still exist, unchanged.
  const bothStillThere = app.database.raw.prepare('SELECT id, name, domain FROM companies ORDER BY created_at').all();
  assert.equal(bothStillThere.length, 2, 'a logical link deletes nothing');
  assert.equal(app.services.companies.get(first.id).name, 'Globex Srl');
  assert.equal(app.services.companies.get(second.id).name, 'Globex Srl', 'the alias record is untouched and still resolves');

  // The cluster is recorded with both members and one canonical.
  const links = app.modules.get('canonical-link').service.list({ limit: 10 });
  assert.equal(links.length, 2);
  assert.equal(links.filter((row) => row.role === 'canonical').length, 1);
  assert.equal(links.every((row) => row.decidedByType === 'user' && row.decidedById === 'cdf'), true);
  assert.equal(links.every((row) => row.status === 'active'), true);

  // …and a record already in a cluster cannot be silently re-parented.
  const secondCandidate = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'again' }, actor: ACTOR,
  }));
  assert.equal(secondCandidate.ok, false, 'a decided candidate is not decidable twice');
});

test('a dismissed candidate links nothing and deletes nothing', async (t) => {
  const { app } = await scene(t, 'dismiss');
  await app.services.companies.create({ name: 'Initech Srl', domain: 'initech.example' }, { actor: ACTOR });
  await app.services.companies.create({ name: 'Initech Srl', domain: 'initech.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Initech Srl', domain: 'initech.example' }], actor: ACTOR });
  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];

  const dismissed = await app.runAction({
    module: 'duplicate-candidate', action: 'dismiss-duplicate-candidate', recordId: candidate.id,
    input: { reason: 'two genuinely different subsidiaries' }, actor: ACTOR,
  });
  assert.equal(dismissed.result.candidate.status, 'dismissed');
  assert.equal(app.modules.get('canonical-link').service.list({ limit: 10 }).length, 0, 'dismissing links nothing');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 2, 'and deletes nothing');
});

/* ----------------------------------------------------------- data quality */

test('data-quality findings are explainable, and governing one never erases it', async (t) => {
  const { app } = await scene(t, 'quality');
  await app.applyCustomerImport({
    system: 'crm-export', rows: [ROWS.newContact, ROWS.invalidEmail, ROWS.noIdentity], actor: ACTOR,
  });

  const issues = app.modules.get('data-quality-issue').service.list({ limit: 50 });
  const kinds = issues.map((issue) => issue.kind).sort();
  assert.deepEqual(kinds, ['invalid_email', 'missing_required_identity']);
  assert.equal(issues.every((issue) => issue.status === 'open' && issue.evidence && issue.detector), true);

  const issue = issues[0];
  const governed = await app.runAction({
    module: 'data-quality-issue', action: 'govern-data-quality-issue', recordId: issue.id,
    input: { decision: 'resolved', reason: 'fixed at the source system' }, actor: ACTOR,
  });
  assert.equal(governed.result.issue.status, 'resolved');
  assert.match(governed.result.retained, /never erases/i);

  const after = app.modules.get('data-quality-issue').service.get(issue.id);
  assert.equal(after.status, 'resolved');
  assert.equal(after.evidence, issue.evidence, 'the finding and its evidence survive being resolved');
  assert.equal(after.kind, issue.kind);
  assert.equal(after.decidedById, 'cdf');

  // An agent may not govern an issue either.
  const other = issues[1];
  const byAgent = await refusal(app.runAction({
    module: 'data-quality-issue', action: 'govern-data-quality-issue', recordId: other.id,
    input: { decision: 'dismissed', reason: 'acceptable' }, actor: AGENT,
  }));
  assert.equal(byAgent.code, 'HUMAN_APPROVAL_REQUIRED');
});

/* --------------------------------------------------------------- profile */

test('the profile reads across packages, and absence is "not available" rather than empty', async (t) => {
  const { app } = await scene(t, 'profile');
  await app.applyCustomerImport({ system: 'crm-export', rows: [ROWS.newContact], actor: ACTOR });
  const contact = app.database.raw.prepare('SELECT id FROM contacts LIMIT 1').get();

  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(profile.customerProfileContract, 1);
  assert.equal(profile.identity.contact.email, 'ada@northwind.example');
  assert.equal(profile.identity.company.name, 'Northwind Ltd');
  assert.equal(profile.externalIdentities.length, 1);
  assert.equal(profile.externalIdentities[0].system, 'crm-export');

  // The packages that are NOT composed say so, with a reason — never `[]`.
  for (const key of ['quotes', 'orders', 'contracts', 'subscriptions', 'deliveryProjects', 'serviceCoverages', 'workTasks', 'successions']) {
    assert.equal(profile[key].available, false, `${key} must report unavailable`);
    assert.equal(profile[key].items, null, `${key} must not report an empty list as truth`);
    assert.equal(profile[key].count, null);
    assert.match(profile[key].reason, /not composed/);
    assert.match(profile[key].reason, /not a claim that there are none/);
  }

  // The one host package that IS present answers for real.
  assert.equal(profile.opportunities.available, true);
  assert.equal(profile.opportunities.count, 0, 'a composed package may honestly report zero');

  // And it refuses to call itself a timeline.
  assert.equal(profile.completeTimeline, false);
  assert.match(profile.timelineNote, /not a cross-channel customer timeline/i);

  // Reading a profile writes nothing.
  const before = fingerprintDatabase(app);
  await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(fingerprintDatabase(app), before);
});

test('the profile follows canonical identity across the whole cluster', async (t) => {
  const { app } = await scene(t, 'profile-cluster');
  const first = await app.services.companies.create({ name: 'Umbrella Srl', domain: 'umbrella.example' }, { actor: ACTOR });
  await app.services.companies.create({ name: 'Umbrella Srl', domain: 'umbrella.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Umbrella Srl', domain: 'umbrella.example' }], actor: ACTOR });
  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];
  await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'one company' }, actor: ACTOR,
  });

  const profile = await app.readCustomerProfile({ resource: 'company', id: first.id });
  assert.equal(profile.canonicalIdentity.linked, true);
  assert.equal(profile.canonicalIdentity.members.length, 2);
  assert.equal(profile.canonicalIdentity.canonical.id, first.id);
  assert.match(profile.canonicalIdentity.note, /every record below still exists/i);
});

/* ------------------------------------------------------- hostile and bounds */

test('hostile and oversized input is refused, and never echoed back', async (t) => {
  const { app } = await scene(t, 'hostile');
  const control = `Acme${String.fromCharCode(0)}Ltd`;
  const separator = `Acme${String.fromCharCode(0x2028)}Ltd`;

  for (const [label, rows] of [
    ['a control character', [{ companyName: control, domain: 'acme.example' }]],
    ['a line separator', [{ companyName: separator, domain: 'acme.example' }]],
  ]) {
    const preview = await app.previewCustomerImport({ system: 'crm-export', rows, actor: ACTOR });
    assert.equal(preview.receipts[0].outcome, 'rejected', label);
    assert.equal(preview.receipts[0].reasonCode, 'UNSAFE_VALUE');
    assert.equal(preview.receipts[0].reason.includes(String.fromCharCode(0)), false, 'the refusal never echoes the value');
  }

  // Prototype pollution through a row key changes nothing about Object.
  await app.previewCustomerImport({
    system: 'crm-export', rows: [{ __proto__: { polluted: true }, email: 'x@acme.example' }], actor: ACTOR,
  });
  assert.equal({}.polluted, undefined, 'no prototype was polluted');

  // Bounds are refusals, not truncations.
  const tooMany = await refusal(app.previewCustomerImport({
    system: 'crm-export', rows: Array.from({ length: 501 }, (_, i) => ({ email: `p${i}@acme.example` })), actor: ACTOR,
  }));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /bounded to 500 rows/);

  const longValue = await app.previewCustomerImport({
    system: 'crm-export', rows: [{ companyName: 'x'.repeat(400), domain: 'acme.example' }], actor: ACTOR,
  });
  assert.equal(longValue.receipts[0].outcome, 'rejected');

  // A system name is an identifier, not free text.
  const badSystem = await refusal(app.previewCustomerImport({ system: 'Not A System', rows: [ROWS.newContact], actor: ACTOR }));
  assert.equal(badSystem.ok, false);
  assert.match(badSystem.message, /lowercase identifier/);
});

test('every record this package owns refuses public writes', async (t) => {
  const { app } = await scene(t, 'readonly');
  for (const name of ['customer-import-run', 'customer-import-row', 'external-identity',
    'duplicate-candidate', 'canonical-link', 'data-quality-issue']) {
    const service = app.modules.get(name).service;
    assert.equal(typeof service.create, 'undefined', `${name} must expose no public create`);
    assert.equal(typeof service.update, 'undefined', `${name} must expose no public update`);
    assert.equal(typeof service.createManaged, 'function', `${name} is written only through the managed path`);
  }
});

test('exact reads stay exact past the paged bound', async (t) => {
  const { app } = await scene(t, 'scale');
  // 600 identities: more than any page bound in the read paths.
  const rows = Array.from({ length: 600 }, (_, i) => ({ externalId: `BULK-${i}`, email: `bulk${i}@scale.example` }));
  const applied = await app.applyCustomerImport({ system: 'crm-export', rows: rows.slice(0, 500), actor: ACTOR });
  assert.equal(applied.counts.accepted, 500);
  await app.applyCustomerImport({ system: 'crm-export', rows: rows.slice(500), actor: ACTOR });

  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM external_identities').get().n, 600);

  // The 600th identity is found by exact key, not by scanning a first page.
  const preview = await app.previewCustomerImport({
    system: 'crm-export', rows: [{ externalId: 'BULK-599', email: 'bulk599@scale.example' }], actor: ACTOR,
  });
  assert.equal(preview.receipts[0].matchRule, 'external-identity',
    'an exact identifier read must not degrade past the page bound');
  assert.equal(preview.receipts[0].outcome, 'accepted');
});
