import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **The stored label is a snapshot, and every surface says so.**
 *
 * Review finding. The foundation's whole claim is that the existing records
 * stay the source of truth: it stores links, not customer truth. But every
 * subject envelope also carries a `subjectLabel` — a display string captured
 * when the row was written — and it was published as plain `label`. Rename the
 * source company afterwards and the profile served a **wrong customer name**
 * with nothing marking it non-authoritative: a parallel master record by the
 * back door, arriving as staleness rather than as a second write path.
 *
 * `packages/work` stores the identically-named field and has always stated the
 * contract — "a display snapshot taken at creation, never refreshed, may be
 * stale" — in its metadata and its Admin panel. This holds customer-data to
 * the same standard: the key is `labelSnapshot`, `labelIsAuthoritative` is
 * `false` beside it, and the id every envelope carries is how a consumer
 * reaches the current name.
 */

const ACTOR = { type: 'user', id: 'reviewer' };

test('a renamed source never reaches the profile as a current customer name', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'label-snapshot.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const db = app.database.raw;

  // Two companies sharing name and domain: the ambiguity the detector refuses
  // to resolve by picking one, which is what produces a decidable candidate.
  const first = await app.services.companies.create({ name: 'Northwind Ltd', domain: 'northwind.example' }, { actor: ACTOR });
  await app.services.companies.create({ name: 'Northwind Ltd', domain: 'northwind.example' }, { actor: ACTOR });
  await app.applyCustomerImport({
    actor: ACTOR, system: 'crm', idempotencyKey: 'label-snapshot-1',
    rows: [{ externalId: 'CRM-9', companyName: 'Northwind Ltd', domain: 'northwind.example' }],
  });
  const candidate = db.prepare('SELECT * FROM duplicate_candidates').get();
  assert.ok(candidate, 'the shared name and domain produced a candidate to decide');

  await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: candidate.left_resource, canonicalId: candidate.left_id, reason: 'same legal entity' },
    actor: ACTOR,
  });

  // The candidate the decision was made on captured both display labels. Those
  // are the strings that go stale, and they are what this test follows.
  assert.equal(candidate.left_label, 'Northwind Ltd');
  assert.equal(candidate.right_label, 'Northwind Ltd');

  // Rename the source. Direct SQL because the core company service exposes no
  // update path — the point is only that the world moved underneath the row.
  db.prepare('UPDATE companies SET name = ? WHERE id = ?').run('Northwind Holdings SRL', candidate.left_id);

  const profile = await app.readCustomerProfile({ actor: ACTOR, resource: 'company', id: candidate.left_id });
  const cluster = profile.canonicalIdentity ?? {};
  const members = [cluster.canonical, ...(cluster.members ?? []), ...(profile.duplicateCandidates?.items ?? [])].filter(Boolean);
  assert.ok(members.length > 0, 'the profile publishes the cluster it decided');

  for (const member of members) {
    if (!('labelSnapshot' in member) && !('label' in member)) continue; // not a subject envelope
    assert.equal('label' in member, false,
      'a bare `label` reads as current truth; the stored one is a decision-time snapshot and must not claim to be current');
    assert.equal(member.labelIsAuthoritative, false,
      'every subject envelope states that its stored label is not authoritative');
    assert.ok('labelSnapshot' in member, 'the snapshot is still published — as a snapshot');
    assert.ok(typeof member.resource === 'string' && typeof member.id === 'string',
      'and the source record it names is how a consumer reads the current name');
  }

  // The source has genuinely moved on, which is exactly why the captured
  // string may never be served as a current name.
  assert.equal(db.prepare('SELECT name FROM companies WHERE id = ?').get(candidate.left_id).name, 'Northwind Holdings SRL');

  // Nowhere in the whole profile does the stale string appear under a key that
  // reads as current truth. This is the assertion the defect would fail.
  const served = JSON.stringify(profile);
  assert.doesNotMatch(served, /"label":"Northwind Ltd"/,
    'the decision-time name must never be published as `label` — it is a snapshot, and the source has been renamed since');
  if (served.includes('Northwind Ltd')) {
    assert.match(served, /"labelSnapshot":"Northwind Ltd"/,
      'where the captured name survives, it survives framed as a snapshot');
  }

  // The quality payloads carry the same framing, for the same reason.
  const issues = profile.dataQualityIssues?.items ?? profile.dataQualityIssues ?? [];
  for (const issue of issues) {
    if (!issue?.subject) continue;
    assert.equal('label' in issue.subject, false, 'quality payloads use the same snapshot framing');
    assert.equal(issue.subject.labelIsAuthoritative, false);
  }
});
