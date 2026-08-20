import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * **Every mutating and evidence-bearing HTTP route is behind the authorizer.**
 *
 * Review finding. ADR-038's C8 states that authorization applies at "HTTP
 * generic records · generic actions · package application operations · Admin
 * requests · SDK-mediated requests · **human approvals** · Customer Data
 * identity decisions · Signature send/reconcile · Contract and M16b execution",
 * and that "no package may bypass the authorizer by calling a lower-level
 * public service".
 *
 * The gate had been fitted to the generic `/api/modules/*` routes and the
 * spine's own routes only. Every hand-written domain route still went straight
 * to the service beneath it, so in **production mode, with a verifier
 * configured**, an entirely unauthenticated caller could:
 *
 *   - create companies, contacts and opportunities (`201`);
 *   - move an opportunity's stage;
 *   - **approve a human approval** — it came back `200`, the approval read
 *     `approved`, and `decidedBy` was `anonymous`;
 *   - read the whole audit trail, every workflow trace and every notification.
 *
 * The last one is the worst of them: the workflow's own guard, *"Approval
 * decisions require an explicit human actor"*, was satisfied by the anonymous
 * placeholder actor the HTTP layer substitutes, so the framework's strongest
 * human-decision check passed for nobody at all.
 *
 * These tests hold the boundary at the route, which is the only place a
 * hand-written route can be held.
 */

const ORG_HEADER = 'x-test-org';
const SUBJECT_HEADER = 'x-test-subject';

/** A stand-in deployment adapter: it verifies whoever presents the header. */
const verifier = ({ headers }) => {
  const subject = headers[SUBJECT_HEADER];
  if (typeof subject !== 'string' || subject === '') return null;
  return {
    kind: 'verified-user',
    subject,
    issuer: 'https://issuer.test',
    method: 'oidc-id-token',
    organizationId: headers[ORG_HEADER] || null,
    claims: { sub: subject },
  };
};

async function scene(t, { roles = { vic: 'viewer' } } = {}) {
  const app = createAccordoApp({
    dbPath: ':memory:',
    spine: {
      mode: 'production',
      identityVerifier: verifier,
      tenantStrategy: { strategy: 'database-per-tenant' },
    },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); app.close(); });

  const organization = app.spine.organizations.create({ name: 'Acme', slug: 'acme' });
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  const owner = app.spine.defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: organization.id,
  });
  for (const [subject, role] of Object.entries(roles)) {
    app.spine.memberships.grant({
      organizationId: organization.id, subject, role, reason: 'fixture',
      identity: owner, mode: app.spine.mode,
    });
  }

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };
  const as = (subject) => ({ [SUBJECT_HEADER]: subject, [ORG_HEADER]: organization.id });
  return { app, organization, call, as };
}

/** Every route a caller with no verified identity must not reach. */
const GUARDED = [
  ['GET', '/api/companies'],
  ['POST', '/api/companies', { name: 'Evil Ltd', domain: 'evil.example' }],
  ['GET', '/api/contacts'],
  ['POST', '/api/contacts', { companyId: 'x', firstName: 'A', lastName: 'B', email: 'a@b.example' }],
  ['GET', '/api/opportunities'],
  ['POST', '/api/opportunities', { companyId: 'x', name: 'D', valueCents: 1, currency: 'EUR', owner: 'o' }],
  ['GET', '/api/approvals'],
  ['GET', '/api/audit'],
  ['GET', '/api/traces'],
  ['GET', '/api/notifications'],
  ['POST', '/api/catalog/sync', { provider: 'x' }],
  ['POST', '/api/demo/seed'],
  ['GET', '/api/modules/company/records'],
];

test('no unauthenticated caller reaches any domain route in production mode', async (t) => {
  const { call } = await scene(t);
  for (const [method, path, body] of GUARDED) {
    const response = await call(method, path, body);
    assert.equal(response.status, 401,
      `${method} ${path} must refuse an unverified caller, got ${response.status}: ${response.body.slice(0, 120)}`);
    assert.match(response.body, /UNAUTHENTICATED/,
      `${method} ${path} must refuse with the stable unauthenticated code`);
  }
});

test('forged legacy actor headers are not an identity in production mode', async (t) => {
  const { app, call } = await scene(t);
  const forged = { 'x-actor-type': 'user', 'x-actor-id': 'mallory' };
  const response = await call('POST', '/api/companies', { name: 'Forged Ltd' }, forged);
  assert.equal(response.status, 401, 'the header pair must not authenticate anybody in production');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 0,
    'and nothing may be written by a caller who was refused');
});

test('a verified viewer may read, and may not write', async (t) => {
  const { call, as } = await scene(t);
  assert.equal((await call('GET', '/api/companies', undefined, as('vic'))).status, 200);
  assert.equal((await call('GET', '/api/audit', undefined, as('vic'))).status, 200);

  for (const [method, path, body] of GUARDED.filter(([m]) => m === 'POST')) {
    const response = await call(method, path, body, as('vic'));
    assert.equal(response.status, 403,
      `${method} ${path} must refuse a viewer with 403, got ${response.status}`);
  }
});

test('the human approval boundary is authorization, not just a shaped actor', async (t) => {
  const { app, call, as } = await scene(t, { roles: { vic: 'viewer', mgr: 'manager' } });
  const actor = { type: 'user', id: 'alice' };
  const company = await app.services.companies.create({ name: 'Acme SpA', domain: 'acme.example' }, { actor });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'A', lastName: 'B', email: 'a@acme.example' }, { actor });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name: 'Deal', valueCents: 500000, currency: 'EUR', owner: 'alice' },
    { actor });
  app.database.raw.prepare('UPDATE opportunities SET stage = ? WHERE id = ?').run('approval_pending', opportunity.id);
  const approval = await app.services.approvals.request(
    { opportunityId: opportunity.id, reason: 'discount beyond policy' }, { actor });

  // Nobody at all: the workflow's "requires an explicit human actor" guard is
  // satisfied by the anonymous placeholder, so only the authorizer stops this.
  const anonymous = await call('POST', `/api/approvals/${approval.id}/approve`);
  assert.equal(anonymous.status, 401, 'an unauthenticated caller must never decide an approval');

  // Verified, but without approvals.decide.
  const viewer = await call('POST', `/api/approvals/${approval.id}/approve`, undefined, as('vic'));
  assert.equal(viewer.status, 403, 'a viewer holds no approvals.decide');

  assert.equal(app.services.approvals.get(approval.id).status, 'pending',
    'neither refusal may have decided anything');
  assert.equal(app.services.approvals.get(approval.id).decidedBy, null,
    'and nothing may be recorded as having decided it');

  // The role that does carry it succeeds, so the gate is a boundary and not a wall.
  const manager = await call('POST', `/api/approvals/${approval.id}/approve`, undefined, as('mgr'));
  assert.equal(manager.status, 200, `a manager carries approvals.decide: ${manager.body.slice(0, 160)}`);
  const decided = app.services.approvals.get(approval.id);
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decidedBy, 'mgr', 'and the decision is recorded against the verified human');
});

test('an application with no spine composed is unchanged', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // The gate is a no-op without a spine: this composition authorizes nothing
  // and `app inspect` publishes exactly that, so the historical behaviour of
  // every route above must be untouched.
  const listed = await fetch(`${base}/api/companies`);
  assert.equal(listed.status, 200);
  const created = await fetch(`${base}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unspined Ltd', domain: 'unspined.example' }),
  });
  assert.equal(created.status, 201, 'a spineless application keeps its historical behaviour exactly');
});

/**
 * Review finding. `requiredPermission` reached the runtime but was never
 * checked where every other contractual field is checked. Two consequences:
 *
 *   - a typo failed closed at *request* time rather than at registration, so a
 *     permanently unreachable action was discoverable only in production —
 *     against this repository's own rule that a process boots correctly
 *     configured or does not boot; and
 *   - the stated floor was only a default. A package could declare
 *     `records.read` on a record action, and since every record action mutates
 *     a record, that silently handed every `viewer` a write.
 */
test('a record action may ask for more than the floor, never less', async () => {
  const { validateActionDefinition } = await import('../packages/core/src/action-registry.js');
  const deps = { moduleExists: () => true };
  const register = (definition) => validateActionDefinition(definition, deps);
  const base = {
    actionContract: 1,
    module: 'thing',
    name: 'do-it',
    label: 'Do it',
    description: 'A record action used to exercise the permission declaration.',
    input: [],
    execute: () => ({}),
  };

  assert.throws(
    () => register({ ...base, requiredPermission: 'reocrds.write' }),
    /requiredPermission must be one of/,
    'an unknown permission is caught at registration, not at the first request',
  );
  assert.throws(
    () => register({ ...base, requiredPermission: 'records.read' }),
    /may not require only "records.read"/,
    'a mutating action may not drop below the write floor',
  );

  // Stronger than the floor is exactly what the declaration is for.
  assert.doesNotThrow(() => register({ ...base, name: 'decide-it', requiredPermission: 'approvals.decide' }),
    'a stronger permission is exactly what the declaration is for');

  // And declaring nothing at all stays legal — the default applies.
  assert.doesNotThrow(() => register({ ...base, name: 'plain-it' }),
    'an action that declares nothing keeps the records.write default');
});
