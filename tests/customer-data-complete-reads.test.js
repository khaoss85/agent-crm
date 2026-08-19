import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createCustomerIdentityCapability } from '../packages/customer-data/src/capability.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **A read that decides something is never a display page.**
 *
 * Review finding. The generated record service offers two reads: `list()` is a
 * bounded display page that clamps any requested limit to **500** and returns
 * the newest rows first, and `listWhere()` is the complete exact-match
 * correctness query — the framework says as much in the generated source. This
 * package asked `list({ limit: 1000 })` and believed it. The bound is not
 * exotic: 250 decided duplicate pairs write 500 canonical-link rows, and from
 * the 501st row onwards
 *
 *   - the consolidated profile reported `linked: false` — "no canonical
 *     identity decision has been recorded for this record; it stands for
 *     itself" — for a record a human *had* linked, and
 *   - `ALREADY_IN_CANONICAL_CLUSTER`, the guard whose stated job is to refuse
 *     to "silently rewrite an earlier one", stopped firing, so the same record
 *     could be made canonical of one cluster and alias of another.
 *
 * Both are the same defect, and the same defect reached the published
 * capability: a consumer asking what the outside world calls a record was told
 * "nothing" whenever the answer was older than one page.
 *
 * These tests hold every deciding read complete. The filler rows are written
 * directly because every record here is read-only-managed — there is no public
 * create path — and they stand for exactly what they look like: other
 * customers' decisions, newer than this one.
 */

const ACTOR = { type: 'user', id: 'reviewer' };
const PAGE_BOUND = 500;

/** Clone one row of `table` `count` times, newer than everything already there. */
function fillPastThePageBound(db, table, count, mutate) {
  const template = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
  assert.ok(template, `${table} needs one real row to clone`);
  const keys = Object.keys(template);
  const insert = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  for (let i = 0; i < count; i += 1) {
    const row = { ...template, id: `filler-${table}-${i}`, created_at: `2099-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` };
    mutate(row, i);
    insert.run(...keys.map((key) => row[key]));
  }
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > PAGE_BOUND,
    `${table} must now hold more rows than one display page`);
}

/** Two companies sharing a name and a domain, linked by a human decision. */
async function linkedPair(app, name, domain, externalId) {
  const first = await app.services.companies.create({ name, domain }, { actor: ACTOR });
  const second = await app.services.companies.create({ name, domain }, { actor: ACTOR });
  await app.applyCustomerImport({ actor: ACTOR, system: 'crm', rows: [{ externalId, companyName: name, domain }] });
  const db = app.database.raw;
  const candidate = db.prepare('SELECT * FROM duplicate_candidates WHERE status = ?').get('unresolved');
  assert.ok(candidate, 'the shared name and domain produced a candidate for a human');
  await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    actor: ACTOR, input: { canonicalResource: 'company', canonicalId: first.id, reason: 'same legal entity' },
  });
  return { first, second };
}

test('a recorded canonical decision survives past the display page bound', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'complete-reads.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const { first } = await linkedPair(app, 'Northwind Ltd', 'northwind.example', 'CRM-1');

  const before = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: first.id });
  assert.equal(before.canonicalIdentity.linked, true);
  assert.equal(before.canonicalIdentity.members.length, 2);

  // 500 other customers' canonical decisions land afterwards.
  fillPastThePageBound(db, 'canonical_links', PAGE_BOUND, (row, i) => {
    row.source_key = `canonical-link:cluster:company:filler-${i}:company:filler-${i}`;
    row.cluster_key = `cluster:company:filler-${i}`;
    row.subject_id = `filler-company-${i}`;
  });

  const after = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: first.id });
  assert.equal(after.canonicalIdentity.linked, true,
    'the profile must still see the human decision — a cluster read from a page denies decisions older than the page');
  assert.equal(after.canonicalIdentity.members.length, 2,
    'and it must still see both members of that cluster');
  assert.equal(after.canonicalIdentity.clusterKey, before.canonicalIdentity.clusterKey);
});

test('the re-parenting guard still fires past the display page bound', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'complete-reads-guard.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const { first } = await linkedPair(app, 'Northwind Ltd', 'northwind.example', 'CRM-1');
  fillPastThePageBound(db, 'canonical_links', PAGE_BOUND, (row, i) => {
    row.source_key = `canonical-link:cluster:company:filler-${i}:company:filler-${i}`;
    row.cluster_key = `cluster:company:filler-${i}`;
    row.subject_id = `filler-company-${i}`;
  });

  // A third record with the same name and domain produces a new candidate that
  // names the record already inside a cluster.
  const third = await app.services.companies.create({ name: 'Northwind Ltd', domain: 'northwind.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ actor: ACTOR, system: 'crm', rows: [{ externalId: 'CRM-2', companyName: 'Northwind Ltd', domain: 'northwind.example' }] });
  const pending = db.prepare('SELECT * FROM duplicate_candidates WHERE status = ?').all('unresolved')
    .find((row) => row.left_id === first.id || row.right_id === first.id);
  assert.ok(pending, 'a new candidate names the record that is already canonical');

  await assert.rejects(
    () => app.runAction({
      module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: pending.id,
      actor: ACTOR, input: { canonicalResource: 'company', canonicalId: third.id, reason: 're-parenting' },
    }),
    (error) => {
      assert.equal(error.code, 'ALREADY_IN_CANONICAL_CLUSTER');
      return true;
    },
    'a record already inside a cluster must never be re-parented, however many other decisions were taken since',
  );

  const clusters = db.prepare('SELECT DISTINCT cluster_key FROM canonical_links WHERE subject_id = ? AND status = ?')
    .all(first.id, 'active');
  assert.equal(clusters.length, 1, 'the record belongs to exactly one canonical cluster');
});

test('the published capability answers completely past the display page bound', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'complete-reads-capability.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  // One import that creates a company and records the identifier naming it…
  await app.applyCustomerImport({
    actor: ACTOR, system: 'crm',
    rows: [{ externalId: 'KEEP-1', companyName: 'Contoso Ltd', domain: 'contoso.example' }],
  });
  const kept = db.prepare('SELECT * FROM external_identities WHERE external_id = ?').get('KEEP-1');
  assert.ok(kept, 'the accepted row recorded its external identity');

  // …and an unresolved candidate that no human has decided.
  const { first } = { first: await app.services.companies.create({ name: 'Fabrikam Ltd', domain: 'fabrikam.example' }, { actor: ACTOR }) };
  await app.services.companies.create({ name: 'Fabrikam Ltd', domain: 'fabrikam.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ actor: ACTOR, system: 'crm', rows: [{ externalId: 'CRM-9', companyName: 'Fabrikam Ltd', domain: 'fabrikam.example' }] });
  assert.ok(db.prepare('SELECT * FROM duplicate_candidates WHERE status = ?').get('unresolved'),
    'an undecided duplicate candidate exists');

  fillPastThePageBound(db, 'external_identities', PAGE_BOUND, (row, i) => {
    row.source_key = `crm:filler-${i}`;
    row.external_id = `filler-${i}`;
    row.subject_id = `filler-company-${i}`;
  });
  fillPastThePageBound(db, 'duplicate_candidates', PAGE_BOUND, (row, i) => {
    row.source_key = `duplicate:company:filler-a-${i}|company:filler-b-${i}`;
    row.left_id = `filler-a-${i}`;
    row.right_id = `filler-b-${i}`;
    row.status = 'unresolved';
  });

  const capability = createCustomerIdentityCapability().create({ modules: app.modules });
  const identities = capability.externalIdentities({ resource: kept.subject_resource, id: kept.subject_id });
  assert.deepEqual(identities.map((entry) => entry.externalId), ['KEEP-1'],
    'the identifier the outside world uses must not disappear behind newer rows');

  const open = capability.openDuplicateCandidates({ resource: 'company', id: first.id });
  assert.equal(open.length, 1,
    'an outstanding duplicate candidate must not disappear behind newer ones');
  assert.equal(open[0].left.resource, 'company');

  // The profile reads the same way, for the same reason.
  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: first.id });
  assert.equal(profile.duplicateCandidates.length, 1);
  assert.deepEqual(
    (await app.readCustomerProfile({ actor: ACTOR, resource: kept.subject_resource, id: kept.subject_id }))
      .externalIdentities.map((entry) => entry.externalId),
    ['KEEP-1'],
  );
});

/**
 * The same defect in its other form: a section that reported `count: 0` for a
 * customer who plainly has one. A quote names an **opportunity**, not a
 * company, and the projection only knew how to follow a company or a contact —
 * so a real quote came back as "0", which reads as "this customer has none".
 * The profile's own doctrine is that absence is never published as an empty
 * result, and that has to hold in both directions.
 */
test('a section reports what it can actually reach, and says which kind of number it is', async (t) => {
  const root = project(t, { withCommercial: true });
  const context = await boot(root, join(root, 'data', 'complete-reads-sections.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  const company = await app.services.companies.create({ name: 'Litware Ltd', domain: 'litware.example' }, { actor: ACTOR });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Ann', lastName: 'Poe', email: 'ann@litware.example' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name: 'Renewal', valueCents: 100000, currency: 'EUR', owner: 'rep' },
    { actor: ACTOR });
  db.prepare(`INSERT INTO quotes (id, opportunity_id, price_book_id, currency, status, draft_revision, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('quote-1', opportunity.id, 'pb-1', 'EUR', 'draft', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: company.id });

  assert.equal(profile.quotes.available, true);
  assert.equal(profile.quotes.count, 1,
    'a quote for this customer\'s opportunity belongs to this customer — reporting 0 would say they have none');
  assert.equal(profile.quotes.items[0].id, 'quote-1');
  assert.equal(profile.quotes.countIsComplete, true,
    'the quote module declares the reference, so the count is of the table rather than of a page');

  for (const [key, section] of Object.entries(profile)) {
    if (!section || typeof section !== 'object' || section.available !== true || !('count' in section)) continue;
    assert.equal(typeof section.countIsComplete, 'boolean',
      `${key} publishes a count, so it must state whether that count is of the table or of one page`);
    if (section.countIsComplete === false) {
      assert.match(section.countNote, /not exactly this many/,
        `${key} counted a page, so it must say the count is a floor`);
    }
  }

  // Every unavailable section still explains itself and never publishes an
  // empty result as an answer.
  for (const [key, section] of Object.entries(profile)) {
    if (!section || typeof section !== 'object' || section.available !== false) continue;
    assert.equal(section.items, null, `${key} must not publish an empty list as truth`);
    assert.equal(section.count, null, `${key} must not publish a zero as truth`);
    assert.match(section.reason, /not a claim that there are none/);
  }
});
