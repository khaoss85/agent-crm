import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import {
  ANONYMOUS_IDENTITY, PERMISSIONS, ROLE_BUNDLES, assertTenantId,
  createTenantStorage, decideAuthorization, defineIdentity, resolveRuntimeMode,
} from '../packages/core/index.js';

/**
 * **Production Spine v1 (ADR-038) — the attack suite.**
 *
 * These are not "does the happy path work" tests. Each one is an attempt to do
 * something the milestone claims is impossible, and the claim is only worth
 * what the attempt proves. The properties under attack:
 *
 * - an identity that was never verified authorizes nothing;
 * - an asserted developer identity is refused outside local-development mode;
 * - production refuses to *start* without a verifier and a tenant strategy;
 * - a role cannot be escalated, self-granted, or bootstrapped twice;
 * - a tenant cannot read, write or path-traverse into another tenant;
 * - a system identity cannot exceed its bounded authority;
 * - no secret or token appears in any error, decision or audit row.
 */

/**
 * A credential-shaped value, built at runtime rather than written down.
 *
 * The test needs something that *looks* exactly like a real bearer token, to
 * prove such a value never reaches an identity, a decision or an audit row. A
 * literal would put a JWT-shaped string in the repository and trip every secret
 * scanner that reads it — in a milestone whose entire claim is that no
 * credential is stored, shipping something that pattern-matches one is the
 * wrong signal to send. So it is assembled here.
 */
const b64 = (value) => Buffer.from(value).toString('base64url');
const FAKE_TOKEN = [b64('{"alg":"HS256"}'), b64('{"sub":"NOT-A-REAL-SECRET"}'), 'signature'].join('.');

/**
 * **Composing a bound spine (ADR-038, amended).**
 *
 * There is no in-memory shortcut here on purpose. A spine-composed application
 * takes its CRM database from the tenant binding and refuses an explicit path,
 * so these tests exercise the same two-file, two-plane composition a deployment
 * gets. The previous fixtures passed `dbPath: ':memory:'` and were, without
 * noticing, testing the exact composition that shipped the F-2 defect.
 */
const roots = [];
function storageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-spine-'));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Production spine config bound to one tenant, in its own storage root. */
const prod = (overrides = {}) => ({
  mode: 'production',
  identityVerifier: () => {},
  tenant: { id: 'alpha', storageRoot: storageRoot(), provision: { name: 'Alpha' } },
  ...overrides,
});

/** Production spine config sharing a caller-owned root, for restart tests. */
const prodIn = (root, id = 'alpha') => ({
  mode: 'production',
  identityVerifier: () => {},
  tenant: { id, storageRoot: root, provision: { name: id } },
});

/** Local-development spine config, bound like any other. */
const local = (root = storageRoot(), id = 'local') => ({
  mode: 'local-development',
  tenant: { id, storageRoot: root, provision: { name: 'Local development' } },
});

/** The app under test: bound, two-plane, and with no path to a shared database. */
const boundApp = (spine = prod()) => createAccordoApp({ spine });

/** A verified identity, as a deployment adapter would supply one. */
const verified = (subject, organizationId, issuer = 'https://issuer.test') =>
  defineIdentity({ kind: 'verified-user', subject, issuer, method: 'oidc-id-token', organizationId });

// ---------------------------------------------------------------- the mode

test('the runtime mode is explicit, and an unset one is an error rather than the permissive default', () => {
  // The whole failure mode this guards: a production deployment that forgot to
  // configure the mode must not inherit the mode that accepts assertions.
  assert.throws(() => resolveRuntimeMode({ env: {} }), /must be set explicitly/);
  assert.throws(() => resolveRuntimeMode({ mode: 'dev', env: {} }), /exactly one of/);
  assert.throws(() => resolveRuntimeMode({ mode: 'PRODUCTION', env: {} }), /exactly one of/);

  // And it is never inferred from anything ambient.
  const source = readFileSync(new URL('../packages/core/src/runtime-mode.js', import.meta.url), 'utf8');
  for (const ambient of ['localhost', '127.0.0.1', 'NODE_ENV', 'hostname']) {
    assert.doesNotMatch(
      source.replace(/^\s*\*.*$/gm, ''),
      new RegExp(`\\b${ambient}\\b`),
      `the mode must never be inferred from ${ambient}`,
    );
  }
});

test('production fails startup — not the first request — without a verifier or a tenant strategy', () => {
  assert.throws(
    () => createAccordoApp({ spine: { mode: 'production' } }),
    (error) => error.code === 'SPINE_VERIFIER_REQUIRED',
  );
  assert.throws(
    () => createAccordoApp({ spine: { mode: 'production', identityVerifier: () => {} } }),
    (error) => error.code === 'SPINE_TENANT_STRATEGY_REQUIRED',
  );
  // A refused boot gets investigated; a refused request at 3am gets retried.
  const app = boundApp();
  assert.equal(app.spine.mode.mode, 'production');
  assert.equal(app.spine.mode.allowsAssertedActors, false);
  app.close();
});

// ---------------------------------------------------------------- identity

test('an unverified identity authorizes nothing, and an assertion is never promoted to a verification', (t) => {
  const app = boundApp();
  t.after(() => app.close());
  // The bound tenant, not one this test invented: an instance serves exactly
  // the organization it was configured for.
  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });

  for (const permission of PERMISSIONS) {
    assert.equal(
      app.spine.decide({ identity: ANONYMOUS_IDENTITY, organizationId: org.id, permission }).allowed,
      false,
      `anonymous must never hold ${permission}`,
    );
  }

  // The forged-header case, end to end: in production the header pair produces
  // an anonymous identity, not a user.
  const asserted = defineIdentity({
    kind: 'asserted-local', subject: 'alice', method: 'developer-assertion', organizationId: org.id,
  });
  const decision = app.spine.decide({ identity: asserted, organizationId: org.id, permission: 'records.read' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'ASSERTED_IDENTITY_REFUSED');

  // Even though the *same subject* is a genuine owner when properly verified.
  assert.equal(app.spine.decide({ identity: verified('alice', org.id), organizationId: org.id, permission: 'records.read' }).allowed, true);
});

test('a verified identity cannot be pointed at an organization this instance is not bound to', (t) => {
  const app = boundApp();
  t.after(() => app.close());
  const a = app.spine.boundOrganization;
  // A SECOND organization exists in the control plane — a real deployment's
  // control plane holds every tenant it provisions. This instance still serves
  // exactly one of them, which is the property under test.
  const b = app.spine.organizations.create({ slug: 'tenant-b', name: 'B' });
  app.spine.memberships.bootstrapOwner({ organizationId: a.id, subject: 'alice' });
  app.spine.memberships.bootstrapOwner({ organizationId: b.id, subject: 'mallory' });

  // The override C9 forbids: alice is a real owner here, and asks about B.
  // Refused for being another tenant entirely, before any permission or
  // membership is considered.
  const decision = app.spine.decide({ identity: verified('alice', a.id), organizationId: b.id, permission: 'records.read' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'TENANT_NOT_BOUND');
  assert.equal(decision.organizationId, null, 'a refused tenant is not echoed back');

  // Mallory is a genuine owner of B. Against THIS instance she is nobody, and
  // she is told nothing about whether B exists.
  assert.throws(
    () => app.spine.authorize({ identity: verified('mallory', b.id), organizationId: b.id, permission: 'records.read' }),
    (error) => error.status === 404,
  );

  // And a subject with no membership in the bound tenant is refused for the
  // ordinary reason, not accidentally allowed.
  assert.equal(
    app.spine.decide({ identity: verified('nobody', a.id), organizationId: a.id, permission: 'records.read' }).code,
    'MEMBERSHIP_MISSING',
  );
});

test('hostile identity text is refused rather than stored', () => {
  const hostile = [
    'a'.repeat(1000),
    'line\u0000break',
    'paragraph\u2029separator',
    'bell\u0007',
  ];
  for (const subject of hostile) {
    assert.throws(
      () => defineIdentity({ kind: 'verified-user', subject, issuer: 'https://i.test', method: 'oidc-id-token' }),
      /must be at most|control characters/,
      `"${subject.slice(0, 12)}…" must be refused`,
    );
  }
  // An unknown evidence class is refused too: the method vocabulary is closed
  // precisely so a credential cannot be smuggled through as a "method".
  assert.throws(
    () => defineIdentity({ kind: 'verified-user', subject: 'u', issuer: 'https://i.test', method: `Bearer ${FAKE_TOKEN}` }),
    /identity.method must be one of/,
  );
  // A verified user with no issuer is not verified by anybody.
  assert.throws(() => defineIdentity({ kind: 'verified-user', subject: 'u' }), /identity.issuer is required/);
});

// ---------------------------------------------------------- authorization

test('every role bundle is a subset of the closed permission set, and owner is explicit', () => {
  for (const [role, bundle] of Object.entries(ROLE_BUNDLES)) {
    for (const permission of bundle) {
      assert.ok(PERMISSIONS.includes(permission), `${role} grants unknown permission ${permission}`);
    }
    assert.equal(new Set(bundle).size, bundle.length, `${role} lists a permission twice`);
  }
  // A viewer runs no action at all: every record action is a mutation.
  assert.equal(ROLE_BUNDLES.viewer.includes('records.write'), false);
  // The dangerous one is held by exactly the roles that should hold it.
  const admins = Object.entries(ROLE_BUNDLES)
    .filter(([, b]) => b.includes('admin.memberships.manage')).map(([r]) => r).sort();
  assert.deepEqual(admins, ['administrator', 'owner']);
});

test('an unknown permission fails closed rather than passing', () => {
  assert.throws(
    () => decideAuthorization({
      identity: verified('u', 'org_x'), organizationId: 'org_x', permission: 'records.delete_everything',
      membership: { role: 'owner', status: 'active' }, mode: { mode: 'production', allowsAssertedActors: false },
    }),
    /unknown permission/,
  );
});

test('a system identity cannot exceed its bounded authority', (t) => {
  const app = boundApp();
  t.after(() => app.close());
  const org = app.spine.boundOrganization;
  const webhook = defineIdentity({ kind: 'system', subject: 'signature-webhook', method: 'signed-webhook', organizationId: org.id });

  // What a webhook is for.
  assert.equal(app.spine.decide({ identity: webhook, organizationId: org.id, permission: 'signature.reconcile' }).allowed, true);

  // Everything a webhook must never be able to do — including the ones a
  // "powerful system role" would have handed it by accident.
  for (const permission of ['commercial.approve', 'approvals.decide', 'admin.memberships.manage',
    'contracts.activate', 'customer_identity.decide', 'records.write']) {
    const decision = app.spine.decide({ identity: webhook, organizationId: org.id, permission });
    assert.equal(decision.allowed, false, `a webhook must never ${permission}`);
    assert.equal(decision.code, 'SYSTEM_AUTHORITY_EXCEEDED');
  }
});

// ------------------------------------------------------------- membership

test('membership administration refuses self-grant, escalation and the last-administrator trap', (t) => {
  const app = boundApp();
  t.after(() => app.close());
  const org = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  const alice = verified('alice', org.id);

  app.spine.memberships.grant({
    organizationId: org.id, subject: 'bob', role: 'viewer', reason: 'read only', identity: alice, mode: app.spine.mode,
  });

  // A viewer cannot promote themselves.
  const bob = verified('bob', org.id);
  assert.throws(
    () => app.spine.memberships.grant({
      organizationId: org.id, subject: 'bob', role: 'owner', reason: 'promote me', identity: bob, mode: app.spine.mode,
    }),
    (error) => error.status === 403,
  );

  // A manager holds real power but not membership administration, so it cannot
  // grant at all — which is what stops the escalation chain at its first link.
  app.spine.memberships.grant({
    organizationId: org.id, subject: 'mgr', role: 'manager', reason: 'ops', identity: alice, mode: app.spine.mode,
  });
  assert.throws(
    () => app.spine.memberships.grant({
      organizationId: org.id, subject: 'x', role: 'owner', reason: 'escalate',
      identity: verified('mgr', org.id), mode: app.spine.mode,
    }),
    (error) => error.status === 403,
  );

  // The last administrator cannot strand the organization.
  assert.throws(
    () => app.spine.memberships.grant({
      organizationId: org.id, subject: 'alice', role: 'viewer', reason: 'demote self', identity: alice, mode: app.spine.mode,
    }),
    (error) => error.code === 'CONFLICT',
  );
  assert.throws(
    () => app.spine.memberships.suspend({
      organizationId: org.id, subject: 'alice', reason: 'suspend self', identity: alice, mode: app.spine.mode,
    }),
    (error) => error.code === 'CONFLICT',
  );

  // Bootstrapping is not a second way in.
  assert.throws(
    () => app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'mallory' }),
    (error) => error.code === 'CONFLICT',
  );
});

test('an organization is not a company, and now they are not even in the same database', (t) => {
  const app = boundApp(local());
  t.after(() => app.close());
  const tablesIn = (db) => db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const dataPlane = tablesIn(app.database);
  const controlPlane = tablesIn(app.controlPlaneDatabase);

  // The distinction used to be a naming convention inside one file. It is now
  // structural: the tenant's own database has no membership table at all, so a
  // stray read of one from tenant-reachable code raises `no such table` rather
  // than returning rows.
  assert.ok(controlPlane.includes('spine_organizations'), 'organizations are control-plane infrastructure');
  assert.ok(dataPlane.includes('companies'), 'companies remain a CRM record');
  assert.equal(dataPlane.includes('spine_organizations'), false, 'no tenant database holds organizations');
  assert.equal(dataPlane.includes('spine_memberships'), false, 'no tenant database holds memberships');
  assert.equal(controlPlane.includes('companies'), false, 'the control plane holds no CRM record');
  assert.notEqual(app.database.path, app.controlPlaneDatabase.path, 'two planes, two files');
  assert.throws(
    () => app.controlPlaneDatabase.raw.prepare('SELECT * FROM companies').all(),
    /no such table/,
    'a CRM read against the control plane fails rather than quietly returning nothing',
  );

  // The two are unrelated: creating a Company creates no Organization.
  const before = app.spine.organizations.list().length;
  return app.services.companies.create({ name: 'Globex' }, { actor: { type: 'user', id: 'dev' } })
    .then(() => {
      assert.equal(app.spine.organizations.list().length, before, 'a CRM Company must never become a tenant');
      assert.match(app.spine.describe().organizationIsNotACompany, /never the same thing/);
    });
});

// ----------------------------------------------------------------- tenancy

test('a tenant id is untrusted input on a filesystem path', () => {
  const storage = createTenantStorage({ root: '/tmp/spine-tenancy-test' });
  assert.equal(storage.strategy, 'one-tenant-per-instance');

  for (const hostile of ['../../etc/passwd', '/etc/passwd', 'a/../b', '..', '.', '', 'A-Tenant',
    'tenant_a', 'x'.repeat(64), 'te\u0000st', 'te\u2028st']) {
    assert.throws(() => storage.databasePathFor(hostile), /tenant id/, `"${hostile}" must be refused`);
  }
  assert.throws(() => assertTenantId(undefined), /tenant id is required/);

  // Two tenants land in two different files — which is the isolation claim.
  assert.notEqual(storage.databasePathFor('tenant-a'), storage.databasePathFor('tenant-b'));
  assert.ok(storage.databasePathFor('tenant-a').startsWith(storage.root));
});

test('two tenants are two databases: neither can read or write the other', async (t) => {
  // The isolation claim of v1, proven rather than asserted. Not a WHERE clause
  // anybody could forget — separate files, separate connections.
  const a = boundApp(local());
  const b = boundApp(local());
  t.after(() => { a.close(); b.close(); });

  const secret = await a.services.companies.create({ name: 'Tenant A Secret Customer' }, { actor: { type: 'user', id: 'dev' } });

  // By id: B cannot resolve A's record.
  assert.equal(b.services.companies.list({ limit: 500 }).length, 0);
  assert.throws(() => b.services.companies.get(secret.id), (error) => error.status === 404);

  // By filter: B's collection reads never see A's rows.
  assert.equal(b.services.companies.list({ limit: 500 }).find((c) => c.id === secret.id), undefined);

  // By write: a record B creates never appears in A, so the isolation holds in
  // both directions rather than only the one the attacker tried first.
  const bRecord = await b.services.companies.create({ name: 'Tenant B Customer' }, { actor: { type: 'user', id: 'dev' } });
  assert.throws(() => a.services.companies.get(bRecord.id), (error) => error.status === 404);
  assert.equal(a.services.companies.list({ limit: 500 }).length, 1);

  // And A is untouched by any of it.
  assert.equal(a.services.companies.get(secret.id).name, 'Tenant A Secret Customer');

  // The spine control planes are separate too: B's organization list is its own.
  assert.notEqual(a.spine.localOrganization().id, b.spine.localOrganization().id);
});

// -------------------------------------------------------------- local mode

test('local-development mode preserves the developer experience, visibly rather than invisibly', async (t) => {
  const app = boundApp(local());
  t.after(() => app.close());

  assert.equal(app.spine.mode.allowsAssertedActors, true);
  assert.match(app.spine.mode.warning, /LOCAL DEVELOPMENT MODE/);
  assert.match(app.spine.mode.warning, /anyone who can reach/i);

  const identity = app.spine.identityFor({ actor: { type: 'user', id: 'dev' } });
  assert.equal(identity.kind, 'asserted-local', 'an assertion stays an assertion');
  assert.notEqual(identity.kind, 'verified-user');

  // The permissive grant is a real row an operator can see and revoke — not a
  // branch hidden inside the authorizer.
  const org = app.spine.localOrganization();
  assert.equal(org.provenance, 'local-development-migration');
  const members = app.spine.memberships.listFor({ organizationId: org.id });
  assert.equal(members.length, 1);
  assert.equal(members[0].subject, 'dev');
  assert.match(members[0].grantedReason, /local-development/);

  // Ordinary work still works.
  const company = await app.services.companies.create({ name: 'Acme' }, { actor: { type: 'user', id: 'dev' } });
  assert.ok(company.id);
});

test('a project composed without the spine is unchanged, and says so rather than pretending', (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(app.spine, null, 'the spine is opt-in');
  // The honesty requirement: absence must be reportable, never silent. The
  // schema/inspection surface is asserted in tests/spine-schema.test.js.
});

// --------------------------------------------------------- no secret leaks

test('no decision, error or audit row can carry a credential', (t) => {
  const app = boundApp();
  t.after(() => app.close());
  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });

  const TOKEN = FAKE_TOKEN;
  const identity = defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: org.id,
    claims: { sub: 'alice', raw_token: TOKEN },
  });

  // The claims produced a fingerprint; the claims themselves are nowhere.
  assert.match(identity.claimsFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(identity).includes('NOT-A-REAL-SECRET'));
  assert.ok(!JSON.stringify(app.spine.identityEvidence(identity)).includes('NOT-A-REAL-SECRET'));

  const decision = app.spine.decide({ identity, organizationId: org.id, permission: 'records.read' });
  assert.ok(!JSON.stringify(decision).includes('NOT-A-REAL-SECRET'));

  // Force a real refusal: a viewer carrying the same hostile claims.
  app.spine.memberships.grant({
    organizationId: org.id, subject: 'vic', role: 'viewer', reason: 'read only',
    identity: verified('alice', org.id), mode: app.spine.mode,
  });
  const viewerIdentity = defineIdentity({
    kind: 'verified-user', subject: 'vic', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: org.id,
    claims: { sub: 'vic', raw_token: TOKEN },
  });
  let refusal = null;
  try {
    app.spine.authorize({ identity: viewerIdentity, organizationId: org.id, permission: 'admin.memberships.manage' });
  } catch (error) { refusal = error; }
  assert.ok(refusal, 'the refusal happened');
  assert.equal(refusal.status, 403);
  assert.ok(!JSON.stringify({ m: refusal.message, d: refusal.details }).includes('NOT-A-REAL-SECRET'));

  const audit = JSON.stringify(app.audit.list({ limit: 100 }));
  assert.ok(!audit.includes('NOT-A-REAL-SECRET'), 'no audit row carries a credential');

  // Both planes, not just the one this test wrote to: a credential that leaked
  // into control-plane evidence would be just as leaked.
  for (const db of [app.database, app.controlPlaneDatabase]) {
    const dump = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => JSON.stringify(db.raw.prepare(`SELECT * FROM "${row.name}" LIMIT 200`).all()))
      .join('');
    assert.ok(!dump.includes('NOT-A-REAL-SECRET'), `no row in ${db.plane} storage carries a credential`);
  }
});

// --------------------------------------------------------- the HTTP surface

test('the HTTP boundary refuses an unverified caller and distinguishes 401 from 403', async (t) => {
  const app = createAccordoApp({
    spine: { ...prod(), identityVerifier: ({ headers }) => {
      // A deliberately simple reference verifier: it trusts a header ONLY
      // because the test controls it, and it is the adapter's job — not the
      // framework's — to decide what verification means.
      const subject = headers['x-verified-subject'];
      if (typeof subject !== 'string' || subject === '') throw new Error('unverified');
      return {
        kind: 'verified-user', subject, issuer: 'https://issuer.test',
        method: 'oidc-id-token', organizationId: headers['x-verified-org'],
      };
    } },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });

  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  app.spine.memberships.grant({
    organizationId: org.id, subject: 'vic', role: 'viewer', reason: 'read only',
    identity: verified('alice', org.id), mode: app.spine.mode,
  });

  // 1. No identity at all — 401, and the forged legacy headers do not help.
  const anon = await fetch(`${baseUrl}/api/spine/memberships`);
  assert.equal(anon.status, 401);
  const forged = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-actor-type': 'user', 'x-actor-id': 'alice' },
  });
  assert.equal(forged.status, 401, 'the old header pair must buy nothing in production mode');

  // 2. Verified but unauthorized — 403, a different answer to a different question.
  const viewer = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'vic', 'x-verified-org': org.id },
  });
  assert.equal(viewer.status, 403);

  // 3. Verified and authorized — 200.
  const admin = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': org.id },
  });
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.equal(body.items.length, 2);

  // 4. No secret in any refusal body.
  for (const response of [anon, forged, viewer]) {
    assert.ok(!(await response.clone?.().text?.() ?? '').includes('x-verified-subject'));
  }

  // 5. The context route never publishes a token or a secret.
  const context = await fetch(`${baseUrl}/api/spine/context`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': org.id },
  });
  const contextBody = await context.json();
  assert.equal(context.status, 200);
  assert.equal(contextBody.mode, 'production');
  // The prose deliberately says the framework stores no password or token, so
  // banning the vocabulary would ban the disclaimer. What must not appear is a
  // credential-SHAPED VALUE, and no key may be named like one.
  const flatten = (value, path = '$') => (value && typeof value === 'object'
    ? Object.entries(value).flatMap(([k, v]) => flatten(v, `${path}.${k}`))
    : [[path, value]]);
  for (const [path, value] of flatten(contextBody)) {
    assert.doesNotMatch(path, /token|password|secret|credential|bearer|cookie/i, `${path} is named like a credential`);
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /^(Bearer |eyJ)/, `${path} carries something shaped like a token`);
    }
  }
  assert.ok(Array.isArray(contextBody.permissions) && contextBody.permissions.length === 11);
});

test('a caller cannot point the HTTP boundary at another tenant', async (t) => {
  const app = createAccordoApp({
    spine: { ...prod(), identityVerifier: ({ headers }) => ({
      kind: 'verified-user', subject: headers['x-verified-subject'], issuer: 'https://issuer.test',
      method: 'oidc-id-token', organizationId: headers['x-verified-org'],
    }) },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });

  const a = app.spine.boundOrganization;
  // B exists in the control plane — a real deployment provisions every tenant
  // there — but this instance is bound to A and serves nothing else.
  const b = app.spine.organizations.create({ slug: 'tenant-b', name: 'B' });
  app.spine.memberships.bootstrapOwner({ organizationId: a.id, subject: 'alice' });
  app.spine.memberships.bootstrapOwner({ organizationId: b.id, subject: 'mallory' });

  // Mallory is a genuine owner — of B — verified as such, asking this instance.
  // **404, not 403.** A 403 would confirm that B exists and that this instance
  // knows about it; across a tenant boundary that confirmation is the
  // disclosure.
  const crossTenant = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'mallory', 'x-verified-org': b.id },
  });
  assert.equal(crossTenant.status, 404, 'another tenant is not found here, not forbidden here');
  const refusalBody = await crossTenant.text();
  assert.ok(!refusalBody.includes(b.id), 'the refusal does not echo the organization it refused');
  assert.ok(!refusalBody.includes('tenant-b'), 'nor its slug');

  // Naming A's id instead does not help either: she holds no membership in the
  // tenant this instance serves, and that is an ordinary 403 about HER.
  const claimingA = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'mallory', 'x-verified-org': a.id },
  });
  assert.equal(claimingA.status, 403, 'membership is necessary, and she has none here');

  // And alice, the bound tenant's owner, is served normally — so the refusals
  // are about the boundary rather than about the route being broken.
  const own = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': a.id },
  });
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.items.every((m) => m.organizationId === a.id), true);
});

// ------------------------------------------- migration and concurrency

test('an existing project with no spine tables upgrades cleanly and keeps its data', async (t) => {
  // C12: a database written before ADR-038 must keep booting. The migration is
  // additive — it creates tables, it does not touch a single existing row.
  const dir = mkdtempSync(join(tmpdir(), 'spine-upgrade-'));
  const dbPath = join(dir, 'old.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1. An "old" project: no spine composed, so nothing spine-aware runs.
  const before = createAccordoApp({ dbPath });
  const company = await before.services.companies.create({ name: 'Legacy Ltd' }, { actor: { type: 'user', id: 'old' } });
  const auditBefore = before.audit.list({ limit: 500 }).length;
  before.close();

  // 2. The same rows, adopted by a build that HAS the spine. A spine-composed
  //    application takes its data plane from the binding, so adopting a legacy
  //    file means placing it where the binding names — which is the real
  //    migration an operator performs, and is deliberately explicit rather than
  //    something the framework does silently to a database it was handed.
  const adoptedRoot = join(dir, 'adopted');
  mkdirSync(join(adoptedRoot, 'tenants'), { recursive: true });
  copyFileSync(dbPath, join(adoptedRoot, 'tenants', 'legacy.sqlite'));
  const after = createAccordoApp({ spine: local(adoptedRoot, 'legacy') });
  t.after(() => after.close());
  assert.equal(after.services.companies.get(company.id).name, 'Legacy Ltd', 'existing rows survive untouched');
  assert.equal(after.audit.list({ limit: 500 }).length >= auditBefore, true, 'existing audit survives');

  // 3. And the historical actor is NOT retroactively treated as verified.
  const identity = after.spine.identityFor({ actor: { type: 'user', id: 'old' } });
  assert.equal(identity.kind, 'asserted-local');
  assert.notEqual(identity.kind, 'verified-user');

  // 4. The local organization carries its provenance, so nobody later mistakes
  //    it for one an operator configured.
  assert.equal(after.spine.localOrganization().provenance, 'local-development-migration');
});

test('a restart preserves organizations, memberships and their reasons', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spine-restart-'));
  const dbPath = join(dir, 'spine.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = createAccordoApp({ spine: prodIn(dir, 'tenant-a') });
  const org = first.spine.boundOrganization;
  first.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  first.spine.memberships.grant({
    organizationId: org.id, subject: 'vic', role: 'viewer',
    reason: 'read-only for the quarterly audit', identity: verified('alice', org.id), mode: first.spine.mode,
  });
  first.close();

  const second = createAccordoApp({ spine: prodIn(dir, 'tenant-a') });
  t.after(() => second.close());
  const reopened = second.spine.organizations.bySlug('tenant-a');
  assert.equal(reopened.id, org.id);
  const vic = second.spine.memberships.find({ organizationId: org.id, subject: 'vic' });
  assert.equal(vic.role, 'viewer');
  assert.equal(vic.grantedBySubject, 'alice', 'who granted it survives the restart');
  assert.match(vic.grantedReason, /quarterly audit/, 'and why');
  // The decision is the same after a restart as before it.
  assert.equal(second.spine.decide({ identity: verified('vic', org.id), organizationId: org.id, permission: 'records.write' }).allowed, false);
});

test('two connections to one tenant agree, and neither can reach the other tenant', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spine-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Two connections to tenant A, one to tenant B.
  const a1 = createAccordoApp({ spine: prodIn(dir, 'tenant-a') });
  const a2 = createAccordoApp({ spine: prodIn(dir, 'tenant-a') });
  const b1 = createAccordoApp({ spine: prodIn(dir, 'tenant-b') });
  t.after(() => { a1.close(); a2.close(); b1.close(); });

  const org = a1.spine.boundOrganization;
  a1.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });

  // The second connection sees the first's writes, and decides identically.
  assert.equal(a2.spine.organizations.bySlug('tenant-a').id, org.id);
  assert.equal(
    a2.spine.decide({ identity: verified('alice', org.id), organizationId: org.id, permission: 'records.write' }).allowed,
    true,
    'two connections to one tenant must not disagree about authorization',
  );

  // A duplicate organization slug is refused by the database, not by a race.
  assert.throws(
    () => a2.spine.organizations.create({ slug: 'tenant-a', name: 'A again' }),
    (error) => error.code === 'CONFLICT',
  );

  // **The two instances share one control plane and do not share a data plane.**
  // That separation is the whole model, so it is asserted rather than assumed:
  // B's CRM database is a different file from A's, and neither is the control
  // plane both of them read memberships from.
  assert.notEqual(a1.database.path, b1.database.path, 'two tenants, two CRM databases');
  assert.equal(a1.database.path, a2.database.path, 'two connections to one tenant, one file');
  assert.equal(a1.controlPlaneDatabase.path, b1.controlPlaneDatabase.path, 'one control plane');
  assert.notEqual(a1.database.path, a1.controlPlaneDatabase.path, 'and it is not either data plane');

  // B's instance can SEE A's organization row — a shared control plane is what
  // a deployment provisioning many tenants actually has — and still refuses to
  // act for it, as not found. Visibility in the control plane is not authority
  // over the data plane.
  assert.ok(b1.spine.organizations.bySlug('tenant-a'), 'the control plane is shared, and that is fine');
  assert.equal(b1.spine.isBoundTenant(org.id), false, 'but it is not the tenant B serves');
  assert.throws(
    () => b1.spine.authorize({ identity: verified('alice', org.id), organizationId: org.id, permission: 'records.read' }),
    (error) => error.status === 404,
    'a genuine owner of another tenant is not found on this instance',
  );

  // The decisive one: a row written in A is not reachable from B at all,
  // because it is not in B's database. No filter has to be remembered.
  return a1.services.companies.create({ name: 'Only In A' }, { actor: { type: 'user', id: 'alice' } })
    .then(() => {
      assert.equal(a2.services.companies.list({ limit: 500 }).some((c) => c.name === 'Only In A'), true);
      assert.equal(b1.services.companies.list({ limit: 500 }).length, 0, "B's data plane is empty");
    });
});

test('a configured verifier is honoured in local mode too, and a failed verification still falls back to an assertion', async (t) => {
  // Ignoring a verifier because the mode is local would silently discard
  // explicit operator configuration — and somebody who wired one up in
  // development did so precisely to exercise it.
  const localSpine = local();
  const app = createAccordoApp({
    spine: {
      ...localSpine,
      identityVerifier: ({ headers }) => {
        const subject = headers['x-verified-subject'];
        if (typeof subject !== 'string' || subject === '') throw new Error('unverified');
        return {
          kind: 'verified-user', subject, issuer: 'https://issuer.test', method: 'oidc-id-token',
          organizationId: localSpine.tenant.id,
        };
      },
    },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });

  // 1. The verifier runs, and the identity is genuinely VERIFIED — not asserted.
  const verifiedResponse = await fetch(`${baseUrl}/api/spine/context`, {
    headers: { 'x-verified-subject': 'alice' },
  });
  assert.equal(verifiedResponse.status, 200);
  const verifiedBody = await verifiedResponse.json();
  assert.equal(verifiedBody.identity.kind, 'verified-user');
  assert.equal(verifiedBody.identity.issuer, 'https://issuer.test');

  // 2. When it cannot verify, local mode still falls back to the asserted
  //    actor — which is what keeps the developer experience working.
  const assertedResponse = await fetch(`${baseUrl}/api/spine/context`, {
    headers: { 'x-actor-id': 'dev' },
  });
  assert.equal(assertedResponse.status, 200);
  const assertedBody = await assertedResponse.json();
  assert.equal(assertedBody.identity.kind, 'asserted-local');
  assert.notEqual(assertedBody.identity.kind, 'verified-user', 'a failed verification is never upgraded');
});

test('the SDK preserves 401, 403 and 200 — and holds no credential of its own', async (t) => {
  // Before this, the SDK could only send the legacy actor assertion, so every
  // call against a production-mode server came back 401 and the distinction
  // C11 requires could not even be exercised.
  const { AccordoClient } = await import('../packages/sdk/src/index.js');
  const app = createAccordoApp({
    spine: { ...prod(), identityVerifier: ({ headers }) => {
      const subject = headers['x-verified-subject'];
      if (typeof subject !== 'string' || subject === '') throw new Error('unverified');
      return {
        kind: 'verified-user', subject, issuer: 'https://issuer.test',
        method: 'oidc-id-token', organizationId: headers['x-verified-org'],
      };
    } },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });

  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  app.spine.memberships.grant({
    organizationId: org.id, subject: 'vic', role: 'viewer', reason: 'read only',
    identity: verified('alice', org.id), mode: app.spine.mode,
  });

  const call = async (headers) => {
    try {
      const body = await new AccordoClient({ baseUrl, headers }).request('/api/spine/memberships');
      return { status: 200, items: body.items.length };
    } catch (error) {
      return { status: error.status, code: error.code };
    }
  };

  assert.deepEqual(await call({}), { status: 401, code: 'UNAUTHENTICATED' });
  assert.deepEqual(
    await call({ 'x-verified-subject': 'vic', 'x-verified-org': org.id }),
    { status: 403, code: 'FORBIDDEN' },
    'authenticated-but-unauthorized is a different answer from unauthenticated',
  );
  assert.deepEqual(await call({ 'x-verified-subject': 'alice', 'x-verified-org': org.id }), { status: 200, items: 2 });

  // The client forwards what it is handed and keeps nothing: no default
  // credential, and no way for one to be stored on it.
  const client = new AccordoClient({ baseUrl });
  assert.deepEqual(client.headers, {});
  assert.equal(Object.isFrozen(client.headers), true, 'a caller cannot mutate them after construction');
});
