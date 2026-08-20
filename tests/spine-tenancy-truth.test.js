import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * **What the schema says about tenant isolation must be what the runtime does.**
 *
 * Review finding F-2. `createTenantStorage` was defined, unit-tested and called
 * by nothing; `tenantStrategy` was checked for presence at startup and then
 * unused, so two organizations in one application shared one database while
 * `/api/schema` published `database-per-tenant`. A human decided how to close
 * it — **one instance, one tenant, one storage binding** — and it is closed.
 *
 * These tests survived that change on purpose. They never asserted "the schema
 * says false"; they asserted **agreement** between the published metadata and
 * the measured behaviour, in both directions. A test written the other way
 * would have had to be deleted the moment the product improved, and deleting
 * the test that caught a defect is how the defect comes back.
 *
 * So the same assertions now hold the opposite result, without a line of their
 * logic changing shape: measure, publish, compare.
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

/**
 * Two tenants, as the model requires them: **two instances**, sharing one
 * control plane, each bound to its own data plane.
 *
 * The old version of this helper composed one application holding two
 * organizations. That configuration is now refused, which is the fix — so the
 * fixture had to change shape, and the assertions below did not.
 */
async function twoBoundTenants(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-truth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const boot = (id, name) => createAccordoApp({
    spine: {
      mode: 'production',
      identityVerifier: verifier,
      tenant: { id, storageRoot: root, provision: { name } },
    },
  });

  const alpha = boot('alpha', 'Alpha');
  const bravo = boot('bravo', 'Bravo');
  const alphaServer = createHttpServer(alpha);
  const bravoServer = createHttpServer(bravo);
  await new Promise((resolve) => alphaServer.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => bravoServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    alphaServer.close(); bravoServer.close(); alpha.close(); bravo.close();
  });

  alpha.spine.memberships.bootstrapOwner({
    organizationId: alpha.spine.boundOrganization.id, subject: 'alice',
  });
  bravo.spine.memberships.bootstrapOwner({
    organizationId: bravo.spine.boundOrganization.id, subject: 'mallory',
  });

  const callTo = (server) => async (method, path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, text, json: parsed };
  };

  return {
    root,
    alpha,
    bravo,
    toAlpha: callTo(alphaServer),
    toBravo: callTo(bravoServer),
    asAlice: { [SUBJECT_HEADER]: 'alice', [ORG_HEADER]: alpha.spine.boundOrganization.id },
    asMallory: { [SUBJECT_HEADER]: 'mallory', [ORG_HEADER]: bravo.spine.boundOrganization.id },
  };
}

test('the published isolation claim equals the measured cross-tenant behaviour', async (t) => {
  const { alpha, toAlpha, toBravo, asAlice, asMallory } = await twoBoundTenants(t);

  const created = await toAlpha('POST', '/api/companies',
    { name: 'Alpha Confidential Ltd', domain: 'alpha-confidential.example' }, asAlice);
  assert.equal(created.status, 201, "the owner of Alpha may create a company in Alpha");

  // ---- MEASURED: can Bravo's owner reach Alpha's data? -------------------
  // Two ways, because there are two ways to try: her own instance, and Alpha's.
  const onHerOwnInstance = await toBravo('GET', '/api/companies', undefined, asMallory);
  const acrossInstances = await toAlpha('GET', '/api/companies', undefined, asMallory);
  const namesVisibleToBravo = [
    ...(onHerOwnInstance.json?.items ?? []),
    ...(acrossInstances.json?.items ?? []),
  ].map((row) => row.name);
  const observedCrossTenantRead = namesVisibleToBravo.includes('Alpha Confidential Ltd');

  const bravoWrites = await toBravo('POST', '/api/companies',
    { name: 'Written By Bravo', domain: 'bravo-wrote-this.example' }, asMallory);
  const alphaLists = await toAlpha('GET', '/api/companies', undefined, asAlice);
  const namesVisibleToAlpha = (alphaLists.json?.items ?? []).map((row) => row.name);
  const observedCrossTenantWrite =
    bravoWrites.status === 201 && namesVisibleToAlpha.includes('Written By Bravo');

  const bravoReadsAudit = await toBravo('GET', '/api/audit', undefined, asMallory);
  const bravoReadsAlphaAudit = await toAlpha('GET', '/api/audit', undefined, asMallory);
  const observedCrossTenantAudit = [
    ...(bravoReadsAudit.json?.items ?? []),
    ...(bravoReadsAlphaAudit.json?.items ?? []),
  ].some((row) => row.actorId === 'alice');

  // ---- PUBLISHED: what does the schema say about all three? --------------
  const published = alpha.spine.describe().tenantIsolation;
  assert.ok(published, 'the spine must publish a tenantIsolation block');

  assert.equal(published.crossTenantCrmReadPossible, observedCrossTenantRead,
    'the published cross-tenant READ claim disagrees with the measured behaviour');
  assert.equal(published.crossTenantCrmWritePossible, observedCrossTenantWrite,
    'the published cross-tenant WRITE claim disagrees with the measured behaviour');
  assert.equal(published.crossTenantAuditReadPossible, observedCrossTenantAudit,
    'the published cross-tenant AUDIT claim disagrees with the measured behaviour');

  // Enforcement is the conjunction, so the file cannot be satisfied by editing
  // one boolean.
  const observedEnforced =
    !observedCrossTenantRead && !observedCrossTenantWrite && !observedCrossTenantAudit;
  assert.equal(published.crmDataPlaneEnforced, observedEnforced,
    'crmDataPlaneEnforced must equal what a cross-tenant caller actually experiences');
});

test('a foreign tenant is not found, and is told nothing about what exists here', async (t) => {
  const { alpha, bravo, toAlpha, asMallory } = await twoBoundTenants(t);

  const refused = await toAlpha('GET', '/api/companies', undefined, asMallory);
  assert.equal(refused.status, 404, 'another tenant is not found here, not forbidden here');
  assert.ok(!refused.text.includes(bravo.spine.boundOrganization.id));
  assert.ok(!refused.text.includes(alpha.spine.boundOrganization.id));
  assert.ok(!refused.text.includes('alpha'), 'the bound tenant is not named in the refusal');

  // Unauthenticated stays 401: "you presented nothing" describes the request,
  // not this instance, so it discloses nothing and stays useful.
  const anonymous = await toAlpha('GET', '/api/companies', undefined, {});
  assert.equal(anonymous.status, 401);
});

test('the control plane is scoped, and the schema says exactly that', async (t) => {
  const { alpha, toAlpha, asMallory } = await twoBoundTenants(t);

  const refused = await toAlpha('GET', '/api/spine/memberships', undefined, asMallory);
  const observedControlPlaneScoped = refused.status === 404 || refused.status === 403;

  assert.equal(alpha.spine.describe().tenantIsolation.controlPlaneScoped, observedControlPlaneScoped,
    'the published control-plane claim disagrees with the measured behaviour');
});

test('the published storage separation equals the storage the app is holding', async (t) => {
  const { alpha, bravo } = await twoBoundTenants(t);
  const published = alpha.spine.describe().tenantIsolation;

  const observedSeparate =
    alpha.database.path !== alpha.controlPlaneDatabase.path
    && alpha.database.plane === 'data'
    && alpha.controlPlaneDatabase.plane === 'control';
  assert.equal(published.dataPlaneSeparateFromControlPlane, observedSeparate);

  // And the two tenants really are two files, which is the isolation claim.
  assert.notEqual(alpha.database.path, bravo.database.path);
  assert.equal(alpha.controlPlaneDatabase.path, bravo.controlPlaneDatabase.path);

  // A tenant database has no membership table, so a stray control-plane read
  // from tenant-reachable code raises rather than returns.
  assert.throws(
    () => alpha.database.raw.prepare('SELECT * FROM spine_memberships').all(),
    /no such table/,
  );
});

test('nothing in the published block claims more than the model delivers', async (t) => {
  const { alpha } = await twoBoundTenants(t);
  const block = alpha.spine.describe();

  assert.equal(block.tenantIsolation.sharedDatabaseMultiTenancy, false);
  assert.equal(block.tenantIsolation.multipleOrganizationsInOneInstance, false);
  assert.equal(block.tenantIsolation.postgresImplemented, false);
  assert.equal(block.tenantStrategy, 'one-tenant-per-instance');
  assert.ok(!('tenantStrategyDeclared' in block),
    'declared-versus-enforced existed only while the two could disagree; they no longer can');

  // The measured version of `multipleOrganizationsInOneInstance: false`: the
  // configuration that would need it is refused, not accommodated.
  assert.throws(
    () => createAccordoApp({
      spine: {
        mode: 'production',
        identityVerifier: verifier,
        tenant: { id: 'alpha', storageRoot: '/tmp/never-created', tenants: ['alpha', 'bravo'] },
      },
    }),
    (error) => error.code === 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS',
  );
});

/**
 * The wiring guard, kept and inverted.
 *
 * It used to prove the boundary was *not* wired, by scanning the shipped source
 * for a call that did not exist. The scan is the same; what it now proves is
 * that `storageBoundaryWired` still matches whether anything actually binds
 * tenant storage. Unwire it and the published block must say so, or this fails.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED_ROOTS = ['packages', 'apps'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', 'tests', '__tests__']);
const CALL_RE = /(?<!function\s)bindTenantStorage\s*\(/;

/** @param {string} dir @param {string[]} found */
function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(full, found);
      continue;
    }
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
    if (/\.test\.(js|mjs|cjs)$/.test(entry.name)) continue;
    if (CALL_RE.test(readFileSync(full, 'utf8'))) found.push(relative(REPO_ROOT, full));
  }
}

test('storageBoundaryWired is what the shipped source actually does', async (t) => {
  const callers = [];
  for (const root of SHIPPED_ROOTS) walk(join(REPO_ROOT, root), callers);

  const { alpha } = await twoBoundTenants(t);
  const published = alpha.spine.describe().tenantIsolation.storageBoundaryWired;

  assert.equal(published, callers.length > 0,
    callers.length > 0
      ? `bindTenantStorage is called from ${callers.join(', ')}, so the published block must not `
        + 'say the boundary is unwired'
      : 'no shipped source binds tenant storage, so storageBoundaryWired must be false — '
        + 'and if that is genuinely the case, this milestone has regressed to F-2');
  assert.ok(callers.length > 0, 'the tenant storage boundary must be wired into the application');
});
