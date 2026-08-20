import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { assertBindAddress } from '../packages/core/src/tenant-binding.js';

/**
 * **The configuration refusal matrix (ADR-038, amended).**
 *
 * A deployment that is misconfigured must fail to **start**, not fail its first
 * request — a refused boot gets investigated, and a refused request at 3am gets
 * retried. Every refusal below is a startup refusal with a stable code.
 *
 * Two properties are asserted for every one of them, because a security error
 * message is frequently the first thing pasted into a chat window or a public
 * issue:
 *
 * - it carries **no filesystem path**, and
 * - it carries **no configured value** that might be sensitive.
 *
 * The second matters more than it looks. The obvious way to write "the bound
 * tenant id is invalid" is to say which one, and that string is attacker-chosen
 * on exactly the code path where an attacker-chosen string reached a path
 * resolver.
 */

const roots = [];
function storageRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-refuse-'));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const verifier = () => null;

/** Every refusal, as one table a reader can check against the ADR. */
const MATRIX = [
  {
    what: 'production mode with no identity verifier',
    code: 'SPINE_VERIFIER_REQUIRED',
    spine: () => ({ mode: 'production' }),
  },
  {
    what: 'production mode with no tenant configuration at all',
    code: 'SPINE_TENANT_STRATEGY_REQUIRED',
    spine: () => ({ mode: 'production', identityVerifier: verifier }),
  },
  {
    what: 'local-development mode with no explicit local tenant',
    code: 'SPINE_LOCAL_TENANT_REQUIRED',
    spine: () => ({ mode: 'local-development' }),
  },
  {
    what: 'a tenant binding that names no tenant',
    code: 'SPINE_BOUND_TENANT_REQUIRED',
    spine: () => ({ mode: 'production', identityVerifier: verifier, tenant: { storageRoot: storageRoot() } }),
  },
  {
    what: 'a bound tenant id that is not a slug',
    code: 'SPINE_BOUND_TENANT_INVALID',
    spine: () => ({
      mode: 'production', identityVerifier: verifier,
      tenant: { id: '../../etc/passwd', storageRoot: storageRoot() },
    }),
  },
  {
    what: 'a bound tenant id with an upper-case letter',
    code: 'SPINE_BOUND_TENANT_INVALID',
    spine: () => ({
      mode: 'production', identityVerifier: verifier,
      tenant: { id: 'Alpha', storageRoot: storageRoot() },
    }),
  },
  {
    what: 'a tenant binding with no storage root',
    code: 'SPINE_TENANT_STORAGE_ROOT_REQUIRED',
    spine: () => ({ mode: 'production', identityVerifier: verifier, tenant: { id: 'alpha' } }),
  },
  {
    what: 'more than one tenant named for one data plane',
    code: 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS',
    spine: () => ({
      mode: 'production', identityVerifier: verifier,
      tenant: { id: 'alpha', storageRoot: storageRoot(), tenants: ['alpha', 'bravo'] },
    }),
  },
  {
    what: 'a list of tenant ids instead of one',
    code: 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS',
    spine: () => ({
      mode: 'production', identityVerifier: verifier,
      tenant: { id: ['alpha', 'bravo'], storageRoot: storageRoot() },
    }),
  },
  {
    what: 'a tenant binding that is not a configuration object',
    code: 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS',
    spine: () => ({ mode: 'production', identityVerifier: verifier, tenant: ['alpha', 'bravo'] }),
  },
  {
    what: 'a bound tenant with no Organization and no explicit provisioning',
    code: 'SPINE_BOUND_TENANT_UNKNOWN',
    spine: () => ({
      mode: 'production', identityVerifier: verifier,
      tenant: { id: 'never-provisioned', storageRoot: storageRoot() },
    }),
  },
];

for (const entry of MATRIX) {
  test(`startup refuses: ${entry.what}`, () => {
    let thrown = null;
    try {
      createAccordoApp({ spine: entry.spine() });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'this configuration must refuse to start');
    assert.equal(thrown.code, entry.code, `expected ${entry.code}, got ${thrown.code}: ${thrown.message}`);

    const surface = `${thrown.message} ${JSON.stringify(thrown.details ?? null)}`;
    assert.doesNotMatch(surface, /\/tmp\/|\/home\/|\/var\/|\.sqlite|[A-Za-z]:\\/,
      'a startup refusal must not disclose a filesystem path');
    assert.doesNotMatch(surface, /passwd|Alpha|never-provisioned/,
      'nor echo the configured value it refused');
  });
}

test('an explicit CRM database path beside a tenant binding is refused, not merged', () => {
  // This is the F-2 shape itself: two answers to "where does this tenant's data
  // live", with the second silently winning.
  let thrown = null;
  try {
    createAccordoApp({
      dbPath: ':memory:',
      spine: {
        mode: 'production', identityVerifier: verifier,
        tenant: { id: 'alpha', storageRoot: storageRoot(), provision: { name: 'Alpha' } },
      },
    });
  } catch (error) { thrown = error; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE');
});

test('an unknown mode is refused, and so is an unset one', () => {
  for (const mode of [undefined, '', 'dev', 'PRODUCTION', 'prod', 0, true]) {
    assert.throws(
      () => createAccordoApp({ spine: { mode, env: {}, identityVerifier: verifier } }),
      (error) => /ACCORDO_MODE|exactly one of|set explicitly/.test(error.message),
      `mode ${JSON.stringify(mode)} must be refused`,
    );
  }
});

test('a local-development runtime may only listen on loopback', async (t) => {
  // Local mode accepts asserted identities: anyone who can reach the socket can
  // claim to be anyone. That is a fair trade on loopback and nowhere else.
  for (const remote of ['0.0.0.0', '::', '10.0.0.4', 'example.internal', undefined, '']) {
    assert.throws(
      () => assertBindAddress('local-development', remote),
      (error) => error.code === 'SPINE_LOCAL_MODE_REMOTE_BIND',
      `local mode must refuse to bind to ${JSON.stringify(remote)}`,
    );
  }
  for (const loopback of ['127.0.0.1', '::1', 'localhost']) {
    assert.doesNotThrow(() => assertBindAddress('local-development', loopback));
  }
  // Production is the mode that may be exposed, because it verifies.
  assert.doesNotThrow(() => assertBindAddress('production', '0.0.0.0'));

  // And the guard is on the path every server must take, not on a helper a
  // caller has to remember to call.
  const app = createAccordoApp({
    spine: {
      mode: 'local-development',
      tenant: { id: 'local', storageRoot: storageRoot(), provision: { name: 'Local' } },
    },
  });
  t.after(() => app.close());
  const server = createHttpServer(app);
  assert.throws(
    () => server.listen(0, '0.0.0.0'),
    (error) => error.code === 'SPINE_LOCAL_MODE_REMOTE_BIND',
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
});

test('a refused startup leaves no half-open database behind', () => {
  // The failure this prevents: a refusal that has already created the tenant
  // file, so the next boot finds a database nobody provisioned and treats its
  // existence as evidence of anything.
  const root = storageRoot();
  assert.throws(() => createAccordoApp({
    spine: {
      mode: 'production', identityVerifier: verifier,
      tenant: { id: 'unprovisioned', storageRoot: root },
    },
  }), (error) => error.code === 'SPINE_BOUND_TENANT_UNKNOWN');

  // Booting the same tenant properly afterwards works, and starts empty.
  const app = createAccordoApp({
    spine: {
      mode: 'production', identityVerifier: verifier,
      tenant: { id: 'unprovisioned', storageRoot: root, provision: { name: 'Later' } },
    },
  });
  assert.equal(app.services.companies.list({ limit: 10 }).length, 0);
  assert.equal(app.spine.boundOrganization.provenance, 'operator-configured');
  app.close();
});
