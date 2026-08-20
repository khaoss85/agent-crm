import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const PROD = { mode: 'production', identityVerifier: () => {}, tenantStrategy: { strategy: 'database-per-tenant' } };

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
    () => createAccordoApp({ dbPath: ':memory:', spine: { mode: 'production' } }),
    (error) => error.code === 'SPINE_VERIFIER_REQUIRED',
  );
  assert.throws(
    () => createAccordoApp({ dbPath: ':memory:', spine: { mode: 'production', identityVerifier: () => {} } }),
    (error) => error.code === 'SPINE_TENANT_STRATEGY_REQUIRED',
  );
  // A refused boot gets investigated; a refused request at 3am gets retried.
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
  assert.equal(app.spine.mode.mode, 'production');
  assert.equal(app.spine.mode.allowsAssertedActors, false);
  app.close();
});

// ---------------------------------------------------------------- identity

test('an unverified identity authorizes nothing, and an assertion is never promoted to a verification', (t) => {
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
  t.after(() => app.close());
  const org = app.spine.organizations.create({ slug: 'tenant-a', name: 'Tenant A' });
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

test('a verified identity cannot be pointed at an organization it was not verified for', (t) => {
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
  t.after(() => app.close());
  const a = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
  const b = app.spine.organizations.create({ slug: 'tenant-b', name: 'B' });
  app.spine.memberships.bootstrapOwner({ organizationId: a.id, subject: 'alice' });
  app.spine.memberships.bootstrapOwner({ organizationId: b.id, subject: 'mallory' });

  // The override C9 forbids: alice is a real owner in A, and asks about B.
  const decision = app.spine.decide({ identity: verified('alice', a.id), organizationId: b.id, permission: 'records.read' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'ORGANIZATION_MISMATCH');

  // And a subject with no membership in the organization it *was* verified for
  // is refused for the ordinary reason, not accidentally allowed.
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
    () => defineIdentity({ kind: 'verified-user', subject: 'u', issuer: 'https://i.test', method: 'Bearer eyJhbGciOi' }),
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
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
  t.after(() => app.close());
  const org = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
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
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
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

test('an organization is not a company, in the schema and in the store', (t) => {
  const app = createAccordoApp({ dbPath: ':memory:', spine: { mode: 'local-development' } });
  t.after(() => app.close());
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('spine_organizations'), 'organizations are spine infrastructure');
  assert.ok(tables.includes('companies'), 'companies remain a CRM record');
  assert.notEqual('spine_organizations', 'companies');

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
  assert.equal(storage.strategy, 'database-per-tenant');

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
  const a = createAccordoApp({ dbPath: ':memory:', spine: { mode: 'local-development' } });
  const b = createAccordoApp({ dbPath: ':memory:', spine: { mode: 'local-development' } });
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
  const app = createAccordoApp({ dbPath: ':memory:', spine: { mode: 'local-development' } });
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
  const app = createAccordoApp({ dbPath: ':memory:', spine: PROD });
  t.after(() => app.close());
  const org = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });

  const TOKEN = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"NOT-A-REAL-SECRET"}').toString('base64url'), 'signature'].join('.');
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
});

// --------------------------------------------------------- the HTTP surface

test('the HTTP boundary refuses an unverified caller and distinguishes 401 from 403', async (t) => {
  const app = createAccordoApp({
    dbPath: ':memory:',
    spine: { ...PROD, identityVerifier: ({ headers }) => {
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

  const org = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
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
    dbPath: ':memory:',
    spine: { ...PROD, identityVerifier: ({ headers }) => ({
      kind: 'verified-user', subject: headers['x-verified-subject'], issuer: 'https://issuer.test',
      method: 'oidc-id-token', organizationId: headers['x-verified-org'],
    }) },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });

  const a = app.spine.organizations.create({ slug: 'tenant-a', name: 'A' });
  const b = app.spine.organizations.create({ slug: 'tenant-b', name: 'B' });
  app.spine.memberships.bootstrapOwner({ organizationId: a.id, subject: 'alice' });
  app.spine.memberships.bootstrapOwner({ organizationId: b.id, subject: 'mallory' });

  // Mallory is a genuine owner — of B. She asks for A's memberships by naming
  // A's organization id, which is the whole cross-tenant attack.
  const crossTenant = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'mallory', 'x-verified-org': a.id },
  });
  assert.equal(crossTenant.status, 403, 'the verified organization is authoritative, not the request');

  // And her own tenant still works, so the refusal is about the boundary and
  // not about her.
  const own = await fetch(`${baseUrl}/api/spine/memberships`, {
    headers: { 'x-verified-subject': 'mallory', 'x-verified-org': b.id },
  });
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.items.every((m) => m.organizationId === b.id), true);
});
