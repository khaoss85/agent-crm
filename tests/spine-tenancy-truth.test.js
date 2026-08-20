import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { TENANT_ISOLATION_NOT_ENFORCED } from '../packages/app/src/spine.js';

/**
 * **What the schema says about tenant isolation must be what the runtime does.**
 *
 * Review finding F-2. `createTenantStorage` is defined, unit-tested and — as
 * shipped — called by nothing. `tenantStrategy` was checked for presence at
 * startup and then never used, so every organization composed into one
 * application shares one database while `/api/schema` published
 * `tenantStrategy: 'database-per-tenant'`. A reader had no way to tell the
 * declaration from the delivery except by attacking the product, which is the
 * one failure mode this repository exists to prevent.
 *
 * **This file fixes nothing.** Which way the gap closes — bind one application
 * to one tenant so that "two organizations in one database" becomes a refused
 * configuration, or scope every read by organization as a Spine v2 slice — is a
 * tenancy-model decision for a human. What these tests do is make the published
 * claim and the measured behaviour impossible to separate, in **both**
 * directions:
 *
 * - if isolation stays unenforced, the schema must keep saying so;
 * - the day somebody enforces it, these tests fail until the schema is updated
 *   to say *that* instead.
 *
 * A test that only asserted "the schema says false" would rot into a lie the
 * moment the product improved. This one cannot.
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

/** One production-mode application holding two bootstrapped organizations. */
async function twoTenantsInOneApplication(t) {
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

  const alpha = app.spine.organizations.create({ name: 'Alpha', slug: 'alpha' });
  const bravo = app.spine.organizations.create({ name: 'Bravo', slug: 'bravo' });
  app.spine.memberships.bootstrapOwner({ organizationId: alpha.id, subject: 'alice' });
  app.spine.memberships.bootstrapOwner({ organizationId: bravo.id, subject: 'mallory' });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
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
    app,
    call,
    alpha,
    bravo,
    asAlice: { [SUBJECT_HEADER]: 'alice', [ORG_HEADER]: alpha.id },
    asMallory: { [SUBJECT_HEADER]: 'mallory', [ORG_HEADER]: bravo.id },
  };
}

test('the published isolation claim equals the measured cross-tenant behaviour', async (t) => {
  const { app, call, alpha, asAlice, asMallory } = await twoTenantsInOneApplication(t);

  // Alpha's owner writes a record with a name nobody would confuse.
  const created = await call('POST', '/api/companies',
    { name: 'Alpha Confidential Ltd', domain: 'alpha-confidential.example' }, asAlice);
  assert.equal(created.status, 201, 'the owner of Alpha may create a company in Alpha');

  // ---- MEASURED: can Bravo's owner reach Alpha's data? -------------------
  const bravoLists = await call('GET', '/api/companies', undefined, asMallory);
  const namesVisibleToBravo = (bravoLists.json?.items ?? []).map((row) => row.name);
  const observedCrossTenantRead =
    bravoLists.status === 200 && namesVisibleToBravo.includes('Alpha Confidential Ltd');

  const bravoWrites = await call('POST', '/api/companies',
    { name: 'Written By Bravo', domain: 'bravo-wrote-this.example' }, asMallory);
  const alphaLists = await call('GET', '/api/companies', undefined, asAlice);
  const namesVisibleToAlpha = (alphaLists.json?.items ?? []).map((row) => row.name);
  const observedCrossTenantWrite =
    bravoWrites.status === 201 && namesVisibleToAlpha.includes('Written By Bravo');

  const bravoReadsAudit = await call('GET', '/api/audit', undefined, asMallory);
  const observedCrossTenantAudit =
    bravoReadsAudit.status === 200
    && (bravoReadsAudit.json?.items ?? []).some((row) => row.actorId === 'alice');

  // ---- PUBLISHED: what does the schema say about all three? --------------
  const published = app.spine.describe().tenantIsolation;
  assert.ok(published, 'the spine must publish a tenantIsolation block');

  assert.equal(published.crossTenantCrmReadPossible, observedCrossTenantRead,
    'the published cross-tenant READ claim disagrees with the measured behaviour — '
    + 'if this now refuses, say so in the schema; if it still discloses, keep saying so');
  assert.equal(published.crossTenantCrmWritePossible, observedCrossTenantWrite,
    'the published cross-tenant WRITE claim disagrees with the measured behaviour');
  assert.equal(published.crossTenantAuditReadPossible, observedCrossTenantAudit,
    'the published cross-tenant AUDIT claim disagrees with the measured behaviour');

  // Enforcement is the conjunction: it is enforced only when none of the three
  // is possible. This is what makes the file impossible to satisfy by editing
  // one boolean.
  const observedEnforced =
    !observedCrossTenantRead && !observedCrossTenantWrite && !observedCrossTenantAudit;
  assert.equal(published.crmDataPlaneEnforced, observedEnforced,
    'crmDataPlaneEnforced must equal what a cross-tenant caller actually experiences');
});

test('the control plane is scoped, and the schema says exactly that', async (t) => {
  const { app, call, alpha } = await twoTenantsInOneApplication(t);

  // Bravo's genuine owner, pointed at Alpha's organization.
  const refused = await call('GET', '/api/spine/memberships', undefined, {
    [SUBJECT_HEADER]: 'mallory', [ORG_HEADER]: alpha.id,
  });
  const observedControlPlaneScoped = refused.status === 403;
  assert.match(refused.text, /MEMBERSHIP_MISSING/,
    'the refusal must name the missing membership rather than an empty organization');

  assert.equal(app.spine.describe().tenantIsolation.controlPlaneScoped, observedControlPlaneScoped,
    'the published control-plane claim disagrees with the measured behaviour');
});

test('the limitation is published exactly while the gap is open', async (t) => {
  const { app } = await twoTenantsInOneApplication(t);
  const block = app.spine.describe();
  const carriesTheCode = block.limitations.includes(TENANT_ISOLATION_NOT_ENFORCED);

  assert.equal(carriesTheCode, block.tenantIsolation.crmDataPlaneEnforced !== true,
    'TENANT_ISOLATION_NOT_ENFORCED must be published while, and only while, isolation is unenforced');
  assert.match(TENANT_ISOLATION_NOT_ENFORCED, /^TENANT_ISOLATION_NOT_ENFORCED — /,
    'the limitation must lead with its stable code, like the four beside it');
  assert.equal(block.limitations[0], TENANT_ISOLATION_NOT_ENFORCED,
    'the gap leads the list — a reader needs it before they trust anything else in the block');
});

test('no key in the published block asserts isolation as delivered', async (t) => {
  const { app } = await twoTenantsInOneApplication(t);
  const block = app.spine.describe();

  assert.ok(!('tenantStrategy' in block),
    'the bare `tenantStrategy` key read as a delivered property of the running application; '
    + 'the declared value belongs under `tenantStrategyDeclared` and the truth under `tenantIsolation`');
  assert.equal(block.tenantStrategyDeclared, 'database-per-tenant',
    'the declared strategy is still published — as a declaration');
  assert.equal(block.tenantIsolation.declaredStrategy, block.tenantStrategyDeclared,
    'the two published copies of the declaration must not be able to disagree');
});

/**
 * The wiring guard.
 *
 * `storageBoundaryWired` is a literal in the published block, and a literal can
 * go stale silently. This walks the shipped source — everything the application
 * actually runs, tests excluded — and holds the literal against whether
 * anything calls `createTenantStorage`. Wire it without republishing the truth
 * and this fails; republish without wiring it and this fails too.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED_ROOTS = ['packages', 'apps'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', 'tests', '__tests__']);
const CALL_RE = /(?<!function\s)createTenantStorage\s*\(/;

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

  const { app } = await twoTenantsInOneApplication(t);
  const published = app.spine.describe().tenantIsolation.storageBoundaryWired;

  assert.equal(published, callers.length > 0,
    callers.length > 0
      ? `createTenantStorage is now called from ${callers.join(', ')} — the published `
        + 'tenantIsolation block still says the boundary is unwired. Re-derive what this '
        + 'application actually enforces before shipping it.'
      : 'no shipped source calls createTenantStorage, so storageBoundaryWired must be false');
});
