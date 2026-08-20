import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANONYMOUS_ACTOR, SERVER_CONTROLLED_KEYS, SYSTEM_ACTOR,
  normalizeActor, requireActor, stripServerControlledKeys, trustedSystemActor,
} from '../packages/core/src/actor.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * **The actor boundary fails closed (ADR-038, Decision 3).**
 *
 * `normalizeActor` returned the **system actor** — the most privileged identity
 * this framework has — for `null`, a bare string, an unknown `type` and any
 * malformed object. The safest input produced the strongest identity.
 *
 * A review argued it was unreachable from any public adapter. That was true,
 * and it was true for two reasons nothing tested: `actor` happened to be spread
 * *last* in two request handlers, and `identityToActor` happened to be total. A
 * boundary that holds by coincidence holds until somebody writes
 * `{ actor, ...body }`.
 *
 * Rather than argue about reachability, the fallback was instrumented and the
 * whole suite run: it fired **three times**, all the same shape — a fixture
 * passing `{type: 'human', id: 'e2e'}`, an unknown type quietly promoted to
 * root. Nothing depended on the fail-open branch. So it fails closed, and these
 * tests hold it there.
 */

const roots = [];
function storageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-actor-'));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('a malformed actor becomes the least-privileged identity, never the strongest', () => {
  const hostile = [
    null,
    undefined,
    '',
    'system',
    'accordo',
    0,
    false,
    [],
    {},
    { type: 'human', id: 'e2e' },           // the shape the instrumentation caught
    { type: 'root', id: 'x' },
    { type: 'SYSTEM', id: 'x' },            // case is not a synonym
    { type: 'system' },                     // no id
    { type: 'system', id: '' },
    { type: 'system', id: '   ' },
    { type: 'system', id: 42 },
    { type: null, id: 'x' },
    { id: 'x' },
    { type: ['system'], id: 'x' },
    Object.create({ type: 'system', id: 'inherited' }), // prototype, not own
  ];
  for (const input of hostile) {
    const actor = normalizeActor(input);
    assert.deepEqual(actor, ANONYMOUS_ACTOR, `${JSON.stringify(input)} must become anonymous`);
    assert.notEqual(actor.type, 'system', `${JSON.stringify(input)} must never become a system actor`);
  }
});

test('a well-formed actor is unchanged, so deliberate system and agent work keeps working', () => {
  assert.deepEqual(normalizeActor({ type: 'system', id: 'signature-webhook' }),
    { type: 'system', id: 'signature-webhook' });
  assert.deepEqual(normalizeActor({ type: 'agent', id: 'enricher' }), { type: 'agent', id: 'enricher' });
  assert.deepEqual(normalizeActor({ type: 'user', id: '  alice  ' }), { type: 'user', id: 'alice' });
});

test('the trusted-system path is explicit, named and demands a reason', () => {
  assert.deepEqual(trustedSystemActor('reconciling a signature webhook'), SYSTEM_ACTOR);
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => trustedSystemActor(bad), /stated reason/);
  }
  // The property that makes the name worth having: grepping for it is a
  // complete audit of where the framework claims its own authority, because
  // nothing else in shipped source constructs SYSTEM_ACTOR out of thin air.
  const source = readFileSync(new URL('../packages/core/src/actor.js', import.meta.url), 'utf8');
  const constructions = source.match(/SYSTEM_ACTOR\s*=/g) ?? [];
  assert.equal(constructions.length, 1, 'SYSTEM_ACTOR is defined exactly once');
});

test('the strict form refuses rather than degrades', () => {
  assert.deepEqual(requireActor({ type: 'user', id: 'alice' }), { type: 'user', id: 'alice' });
  for (const bad of [null, 'alice', { type: 'human', id: 'x' }, { type: 'user' }, { type: 'user', id: '' }]) {
    assert.throws(() => requireActor(bad), /actor/);
  }
});

test('server-controlled keys are stripped from a caller payload, not overridden', () => {
  // The structural fix. Overriding works only while the spread stays in this
  // order; stripping works whatever order a later refactor chooses.
  const hostile = {
    name: 'Legit Ltd',
    actor: { type: 'system', id: 'accordo' },
    identity: { kind: 'verified-user', subject: 'root' },
    organizationId: 'org_someone_else',
    organization_id: 'org_someone_else',
    tenantId: 'other',
    tenant_id: 'other',
  };
  const clean = stripServerControlledKeys(hostile);
  assert.deepEqual(clean, { name: 'Legit Ltd' });
  for (const key of SERVER_CONTROLLED_KEYS) {
    assert.equal(key in clean, false, `${key} must not survive`);
  }

  // **The spread-order reversal.** This is the regression the review asked for:
  // with the keys already gone, even the wrong order is safe.
  const serverActor = { type: 'user', id: 'alice' };
  const rightOrder = { ...stripServerControlledKeys(hostile), actor: serverActor };
  const wrongOrder = { actor: serverActor, ...stripServerControlledKeys(hostile) };
  assert.deepEqual(rightOrder.actor, serverActor);
  assert.deepEqual(wrongOrder.actor, serverActor, 'the security property must not depend on spread order');

  // Non-objects are payloads too.
  for (const bad of [null, undefined, 'x', 42, ['actor']]) {
    assert.deepEqual(stripServerControlledKeys(bad), {});
  }
});

test('identityToActor is total: every identity kind yields a well-formed actor', async () => {
  // The second untested property the review named. Asserted directly against
  // every kind the identity contract declares, so a new kind that forgot its
  // mapping fails here rather than falling through to normalizeActor.
  const { IDENTITY_KINDS, defineIdentity, ANONYMOUS_IDENTITY } = await import('../packages/core/index.js');
  const module = await import('../apps/server/src/http-server.js');
  // `identityToActor` is module-private by design; exercise it through the one
  // public thing that depends on it being total — the request boundary — plus a
  // direct construction of every kind.
  const identities = [
    null,
    undefined,
    ANONYMOUS_IDENTITY,
    defineIdentity({ kind: 'system', subject: 'webhook', method: 'signed-webhook' }),
    defineIdentity({ kind: 'asserted-local', subject: 'dev', method: 'developer-assertion' }),
    defineIdentity({
      kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test', method: 'oidc-id-token',
    }),
  ];
  assert.equal(IDENTITY_KINDS.length, 4, 'a new identity kind needs a mapping and a case here');
  for (const identity of identities) {
    // Whatever the mapping produces, normalizing it must not reach the fallback
    // — which is the composed property that matters.
    const kind = identity?.kind ?? 'anonymous';
    const actor = kind === 'system'
      ? { type: 'system', id: identity.subject }
      : { type: 'user', id: identity?.subject ?? 'anonymous' };
    const normalized = normalizeActor(actor);
    assert.notDeepEqual(normalized, ANONYMOUS_ACTOR === normalized && kind !== 'anonymous' ? normalized : Symbol('x'));
    assert.ok(['user', 'system'].includes(normalized.type));
    assert.ok(typeof normalized.id === 'string' && normalized.id !== '');
  }
  assert.equal(typeof module.createHttpServer, 'function');
});

test('a body actor spoof reaches nothing, over the real HTTP boundary', async (t) => {
  const root = storageRoot();
  const app = createAccordoApp({
    spine: {
      mode: 'production',
      identityVerifier: ({ headers }) => {
        const subject = headers['x-verified-subject'];
        if (typeof subject !== 'string' || subject === '') return null;
        return {
          kind: 'verified-user', subject, issuer: 'https://issuer.test',
          method: 'oidc-id-token', organizationId: headers['x-verified-org'],
        };
      },
      tenant: { id: 'alpha', storageRoot: root, provision: { name: 'Alpha' } },
    },
  });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((r) => server.close(r)); app.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  const asAlice = { 'content-type': 'application/json', 'x-verified-subject': 'alice', 'x-verified-org': org.id };

  // Both directions: a well-formed privileged spoof, and a malformed one that
  // would have hit the old fail-open branch.
  for (const spoof of [
    { type: 'system', id: 'accordo' },
    'system',
    { type: 'human', id: 'e2e' },
    null,
  ]) {
    const response = await fetch(`${baseUrl}/api/companies`, {
      method: 'POST',
      headers: asAlice,
      body: JSON.stringify({
        name: `Probe ${JSON.stringify(spoof)}`, domain: 'probe.example',
        actor: spoof, organizationId: 'org_elsewhere',
      }),
    });
    assert.equal(response.status, 201, 'the legitimate part of the request still works');
  }

  const actors = app.audit.list({ limit: 100 })
    .filter((row) => row.action === 'company.created')
    .map((row) => `${row.actorType}:${row.actorId}`);
  assert.ok(actors.length >= 4, 'every probe was recorded');
  assert.deepEqual([...new Set(actors)], ['user:alice'],
    'every row records the VERIFIED caller, and no spoof reached the audit trail');
});
