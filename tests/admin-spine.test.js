import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  NO_SPINE_WARNING, ORGANIZATION_IS_NOT_A_COMPANY, SINGLE_TENANT_POSTURE,
  TENANT_ISOLATION_WARNING, createSpineView,
} from '../apps/admin/public/admin-spine.js';

/**
 * **The Production Spine Admin section (ADR-038).**
 *
 * The screen's job is to be honest about three things a security surface is
 * usually dishonest about: whether the identity was actually verified, whether
 * a refusal is a refusal or an empty list, and what the build cannot promise.
 */

const ROLES = {
  owner: ['records.read', 'records.write', 'admin.memberships.manage'],
  viewer: ['records.read'],
};

function stubClient({ context = {}, members = [], failMembers = false, noSpine = false, onPost = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (options.method === 'POST') { onPost({ path, body: options.body }); return { ok: true }; }
      if (path === '/api/spine/context') {
        if (noSpine) { const error = new Error('Operation not found: production spine'); error.status = 404; throw error; }
        return {
          spineContract: 1,
          mode: 'production',
          warning: null,
          tenantStrategy: 'one-tenant-per-instance',
          boundTenant: { slug: 'tenant-a', name: 'Tenant A', provenance: 'operator-configured' },
          tenantIsolation: {
            strategy: 'one-tenant-per-instance',
            controlPlaneScoped: true,
            crmDataPlaneEnforced: true,
            storageBoundaryWired: true,
            dataPlaneSeparateFromControlPlane: true,
            crossTenantCrmReadPossible: false,
            crossTenantCrmWritePossible: false,
            crossTenantAuditReadPossible: false,
            sharedDatabaseMultiTenancy: false,
            multipleOrganizationsInOneInstance: false,
            postgresImplemented: false,
          },
          roles: ROLES,
          permissions: ['records.read', 'records.write', 'admin.memberships.manage'],
          identity: { kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test', method: 'oidc-id-token' },
          organization: { name: 'Tenant A', slug: 'tenant-a', provenance: 'operator-configured' },
          membership: { role: 'owner' },
          limitations: ['NOT_SHARED_DATABASE_TENANCY — isolation comes from separate database files'],
          notModeled: ['durable jobs, outbox or scheduler (Spine v3)'],
          ...context,
        };
      }
      if (path === '/api/spine/memberships') {
        if (failMembers) throw new Error('the server is unreachable');
        return { items: members };
      }
      return {};
    },
  };
}

const render = async (client) => {
  const mount = createMount();
  await createSpineView({ doc: createFakeDocument(), mount, client }).render();
  return mount;
};

/** The unenforced-isolation warning node, by its own class hook. */
const gapNode = (mount) =>
  mount.findAll('p').find((node) => node.classList.contains('spine-tenant-isolation-gap'));

test('the bound tenant renders, and the single-tenant posture is stated rather than implied', async () => {
  // Review finding F-2, after the fix. The screen used to print "Tenant
  // strategy: database-per-tenant" beside a real Organization while the
  // application shared one database across every Organization in it. Now the
  // instance is bound to one tenant — so the screen names the binding, and says
  // why there is no tenant switcher, which otherwise reads as a missing feature
  // rather than the security posture.
  const mount = await render(stubClient());
  const text = mount.textContent;

  assert.match(text, /Bound tenant/, 'the bound tenant is named as bound');
  assert.ok(text.includes(SINGLE_TENANT_POSTURE),
    'the one-tenant-per-instance posture must be stated on the screen');
  assert.match(text, /no tenant switcher/,
    'an operator must be told why the control they expect is absent');
  assert.match(text, /refused as not found/,
    'and what happens to a request verified for another Organization');

  const posture = mount.findAll('p')
    .find((node) => node.classList.contains('spine-single-tenant-posture'));
  assert.ok(posture, 'the posture has its own hook so a browser check can assert it');
  assert.equal(posture.getAttribute('data-crm-data-plane-enforced'), 'true');
  assert.equal(posture.getAttribute('data-shared-database-multi-tenancy'), 'false');

  // And the failure warning is absent, because there is no failure.
  assert.equal(gapNode(mount), undefined);
  assert.equal(text.includes(TENANT_ISOLATION_WARNING), false);
});

test('a runtime that reported unenforced isolation would say so, loudly', async () => {
  // This should never render. It exists because a screen that can only say
  // "fine" cannot report the one failure an operator most needs to see — which
  // is exactly the shape of the defect this milestone closed.
  const mount = await render(stubClient({
    context: {
      tenantIsolation: {
        strategy: 'one-tenant-per-instance',
        controlPlaneScoped: true,
        crmDataPlaneEnforced: false,
        storageBoundaryWired: false,
        sharedDatabaseMultiTenancy: false,
      },
    },
  }));
  assert.ok(mount.textContent.includes(TENANT_ISOLATION_WARNING));
  const gap = gapNode(mount);
  assert.ok(gap, 'the failure has its own hook');
  assert.equal(gap.classList.contains('error'), true,
    'it is an error, not a muted footnote — the same rule the local-mode warning follows');
  assert.equal(gap.getAttribute('data-crm-data-plane-enforced'), 'false');
});

test('no tenant switcher is offered, because the data plane could not honour one', async () => {
  const mount = await render(stubClient());
  const controls = [...mount.findAll('select'), ...mount.findAll('button'), ...mount.findAll('input')];
  for (const control of controls) {
    const label = `${control.getAttribute('name') ?? ''} ${control.getAttribute('data-action') ?? ''}`;
    assert.doesNotMatch(label, /tenant|organization/i,
      'a control that appeared to switch tenant would be a control the storage binding cannot honour');
  }
});

test('an application with no spine says so, rather than rendering an empty screen', async () => {
  // The failure this prevents: an operator opens the security screen, sees
  // nothing alarming, and concludes they are protected.
  const mount = await render(stubClient({ noSpine: true }));
  const text = mount.textContent;
  assert.ok(text.includes(NO_SPINE_WARNING));
  assert.match(text, /no identity verification, no tenant isolation and no authorization/);
  assert.ok(text.includes(ORGANIZATION_IS_NOT_A_COMPANY));
});

test('an asserted identity is never displayed as a verified one', async () => {
  const mount = await render(stubClient({
    context: {
      mode: 'local-development',
      warning: 'LOCAL DEVELOPMENT MODE — actor identity is asserted, not verified.',
      identity: { kind: 'asserted-local', subject: 'dev', issuer: null, method: 'developer-assertion' },
    },
  }));
  const text = mount.textContent;
  assert.match(text, /LOCAL DEVELOPMENT MODE/);
  assert.match(text, /ASSERTED, not verified/);
  assert.match(text, /refused in production/);

  const kindRow = mount.findAll('p').find((n) => n.getAttribute('data-identity-kind'));
  assert.equal(kindRow.getAttribute('data-identity-kind'), 'asserted-local');
});

test('the local-development warning is rendered as an error, not a footnote', async () => {
  const mount = await render(stubClient({
    context: { mode: 'local-development', warning: 'LOCAL DEVELOPMENT MODE — actor identity is asserted, not verified.' },
  }));
  const warning = mount.findAll('p').find((n) => n.getAttribute('data-warning') === 'local-development');
  assert.ok(warning, 'the warning must be present and identifiable');
  assert.ok(warning.className.includes('field-error'), 'it must carry the error styling, not muted styling');
});

test('a refusal renders as a refusal, never as an organization with no members', async () => {
  const mount = await render(stubClient({
    context: { permissions: ['records.read'], membership: { role: 'viewer' } },
  }));
  const text = mount.textContent;
  assert.match(text, /This is a refusal, not an empty organization/);
  const denied = mount.findAll('p').find((n) => n.getAttribute('data-denied'));
  assert.equal(denied.getAttribute('data-denied'), 'admin.memberships.manage');
  // And it did not even ask for the list it may not see.
  assert.equal(mount.textContent.includes('member(s)'), false);
});

test('a member list that could not be read says so, and never renders as zero members', async () => {
  const mount = await render(stubClient({ failMembers: true }));
  const text = mount.textContent;
  assert.match(text, /could not be read/);
  assert.match(text, /not a claim that there are none/);
  assert.doesNotMatch(text, /0 member\(s\)/);
});

test('members render with the role and status that were actually granted', async () => {
  const mount = await render(stubClient({
    members: [
      { subject: 'alice', role: 'owner', status: 'active' },
      { subject: 'bob', role: 'viewer', status: 'suspended' },
    ],
  }));
  const text = mount.textContent;
  assert.match(text, /2 member\(s\)/);
  assert.match(text, /alice — owner \(active\)/);
  assert.match(text, /bob — viewer \(suspended\)/);
});

test('granting sends a subject, a role and a reason — and no invitation', async () => {
  const posted = [];
  const client = stubClient({ onPost: (call) => posted.push(call) });
  const mount = createMount();
  await createSpineView({ doc: createFakeDocument(), mount, client }).render();

  const control = (tag, name) => mount.findAll(tag).find((n) => n.getAttribute('name') === name);
  control('input', 'subject').value = 'carol';
  control('select', 'role').value = 'viewer';
  control('input', 'reason').value = 'read-only access for the audit';
  mount.findAll('button').find((b) => b.getAttribute('data-action') === 'grant-membership').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].body);
  assert.deepEqual(body, { subject: 'carol', role: 'viewer', reason: 'read-only access for the audit' });

  // No email, and the screen says so rather than implying one was sent.
  assert.match(mount.textContent, /No invitation is sent and no email exists/);
});

test('the section states what it cannot promise, including that it is not production readiness', async () => {
  const mount = await render(stubClient());
  const text = mount.textContent;
  assert.match(text, /NOT_SHARED_DATABASE_TENANCY/);
  assert.match(text, /Not modeled: durable jobs/);
  assert.match(text, /not a production-readiness statement/);
  assert.match(text, /PostgreSQL and shared-database tenancy, durable jobs, secrets, backups and deployment are all absent/);
});

test('an Organization never renders as a Company', async () => {
  const mount = await render(stubClient({
    members: [{ subject: 'alice', role: 'owner', status: 'active' }],
  }));
  const text = mount.textContent;
  // The distinction is stated in the operator's own words on the screen.
  assert.ok(text.includes(ORGANIZATION_IS_NOT_A_COMPANY));
  assert.match(text, /Organization \(tenant\)/);
  // And the section never labels the tenant a customer or a company.
  assert.doesNotMatch(text, /Company:/);
  assert.doesNotMatch(text, /customer account/i);
});

test('no credential, token or password field exists anywhere on the screen', async () => {
  const mount = await render(stubClient({
    members: [{ subject: 'alice', role: 'owner', status: 'active' }],
  }));
  for (const input of mount.findAll('input')) {
    const name = String(input.getAttribute('name') ?? '');
    assert.doesNotMatch(name, /password|token|secret|key|credential/i);
    assert.notEqual(input.getAttribute('type'), 'password');
  }
  // The prose may name what is absent; no VALUE may look like a credential.
  for (const node of mount.findAll('span')) {
    assert.doesNotMatch(String(node.textContent), /^(Bearer |eyJ)/);
  }
});
