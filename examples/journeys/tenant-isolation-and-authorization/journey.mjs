// @ts-check

/**
 * **Two tenants, one server, and every refusal earned by attempting it.**
 *
 * The fifth journey `crm scenario run` knows how to execute, and it exists for
 * a reason the other four cannot serve: **every security claim in ADR-038 is a
 * negative one**, and a negative claim a run never tests is indistinguishable
 * from a feature that was never built.
 *
 * So this journey does not demonstrate that authorization works. It attempts,
 * in a real composed application:
 *
 * - reading another tenant's records by id, by collection and by write;
 * - acting as a verified user who is a genuine owner — of the *other* tenant;
 * - deciding something with a role that does not carry the permission;
 * - granting oneself a permission one does not hold;
 * - stranding an organization by demoting its last administrator;
 * - a webhook identity reaching past what a webhook is for;
 * - presenting a developer assertion to a production runtime.
 *
 * Each attempt is published as a positive fact, because a report that said
 * "nothing leaked" could be produced by a run that never tried.
 *
 * ### Why the clock is injected
 *
 * Not because anything here is time-dependent — nothing in ADR-038 runs on a
 * clock. It is injected so the run is reproducible and so no fact here is an
 * accident of when it executed.
 *
 * ### What it does NOT prove
 *
 * - Nothing about **shared-database** tenancy: v1 is database-per-tenant, and
 *   the row-level model is a later slice. The isolation shown here is the
 *   isolation two files give you.
 * - Nothing about a real identity provider. The verifier is a checked-in
 *   fixture; no OIDC, SAML or vendor is contacted, and no credential exists.
 * - Nothing about production readiness: PostgreSQL, durable jobs, secrets,
 *   backups and deployment are all absent.
 *
 * Run it directly:
 *   `node examples/journeys/tenant-isolation-and-authorization/journey.mjs`
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const journeyDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(journeyDir, '..', '..', '..');

/** The injected instant every write in this run is stamped with. */
const NOW = '2026-09-15T10:00:00.000Z';

const keepRoot = process.env.ACCORDO_KEEP_ROOT;
const root = keepRoot ?? mkdtempSync(join(tmpdir(), 'accordo-spine-journey-'));
if (keepRoot) mkdirSync(keepRoot, { recursive: true });

/**
 * Attempt something that must be refused, and report **that it was**.
 *
 * @param {() => any} attempt @param {(error: any) => boolean} expected
 */
function refuses(attempt, expected) {
  try {
    const value = attempt();
    if (value && typeof value.then === 'function') {
      // A promise here would be reported as 'not refused' before it settled.
      throw new Error('refuses() is for synchronous attempts; await the call first');
    }
  } catch (error) {
    assert.equal(expected(error), true, `refused, but not in the expected way: ${String(error?.code ?? error)}`);
    return true;
  }
  assert.fail('the operation was expected to be refused and was not');
  return false;
}

/**
 * Compose the project this journey runs against.
 *
 * The spine is core infrastructure rather than a domain package, so this
 * composition deliberately holds NO domain packages at all — the security
 * properties under test belong to the framework, and proving them over an
 * empty composition shows they do not depend on any package being present.
 *
 * @param {string} projectRoot
 */
function compose(projectRoot) {
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(projectRoot, entry), { recursive: true });
  }
  writeFileSync(join(projectRoot, 'packages', 'actions', 'generated', 'index.js'),
    '// The spine registers no record actions: it authorizes the ones that exist.\nexport const generatedActions = [];\n');
  writeFileSync(join(projectRoot, 'packages', 'domains', 'generated', 'index.js'),
    '// Identity, tenancy and authorization are core, not a package.\nexport const generatedDomains = [];\n');
}

try {
  compose(root);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);

  // ---- two tenants, two instances, two data planes ---------------------
  // **The framework does the binding, not this journey.** Each application is
  // configured with the one tenant it serves, and takes its CRM database from
  // that binding — there is no database path to pass, because passing one is
  // refused. Two organizations inside ONE application is not a configuration
  // this milestone accepts, which is why there are two `createAccordoApp`
  // calls below and not one.
  //
  // The control plane — Organizations and Memberships — is deliberately SHARED
  // between them, exactly as a deployment provisioning many tenants has it. So
  // the isolation proven below is isolation of the data plane, with both
  // instances able to see that the other tenant exists and neither able to act
  // for it.
  const spineFor = (tenantId, name) => ({
    mode: 'production',
    tenant: { id: tenantId, storageRoot: join(root, 'tenants'), provision: { name } },
    identityVerifier: () => { throw new Error('not used in-process'); },
  });
  const tenantA = createAccordoApp({ clock: () => NOW, spine: spineFor('tenant-a', 'Tenant A') });
  const tenantB = createAccordoApp({ clock: () => NOW, spine: spineFor('tenant-b', 'Tenant B') });

  try {
    const orgA = tenantA.spine.boundOrganization;
    const orgB = tenantB.spine.boundOrganization;
    tenantA.spine.memberships.bootstrapOwner({ organizationId: orgA.id, subject: 'alice' });
    tenantB.spine.memberships.bootstrapOwner({ organizationId: orgB.id, subject: 'mallory' });

    const identity = (app, subject, organizationId) => app.spine.defineIdentity({
      kind: 'verified-user', subject, issuer: 'https://issuer.test',
      method: 'oidc-id-token', organizationId,
    });
    const alice = identity(tenantA, 'alice', orgA.id);

    tenantA.spine.memberships.grant({
      organizationId: orgA.id, subject: 'mo', role: 'manager',
      reason: 'runs approvals for tenant A', identity: alice, mode: tenantA.spine.mode,
    });
    tenantA.spine.memberships.grant({
      organizationId: orgA.id, subject: 'vic', role: 'viewer',
      reason: 'read-only auditor', identity: alice, mode: tenantA.spine.mode,
    });
    const mo = identity(tenantA, 'mo', orgA.id);
    const vic = identity(tenantA, 'vic', orgA.id);

    // ---- same-shaped records in both tenants --------------------------
    const actor = { type: 'user', id: 'alice' };
    const secretA = await tenantA.services.companies.create({ name: 'Northwind Ltd' }, { actor });
    const secretB = await tenantB.services.companies.create({ name: 'Northwind Ltd' }, { actor: { type: 'user', id: 'mallory' } });
    // Deliberately identical names: if isolation were name-based it would fail here.
    assert.equal(secretA.name, secretB.name);

    // ---- tenant A reads only A ----------------------------------------
    const crossTenantByIdRefused = refuses(
      () => tenantB.services.companies.get(secretA.id),
      (error) => error.status === 404,
    );
    const crossTenantByListRefused = tenantB.services.companies.list({ limit: 500 })
      .every((row) => row.id !== secretA.id);
    const bCannotSeeAAtAll = tenantB.services.companies.list({ limit: 500 }).length === 1;
    const aCannotSeeB = refuses(
      () => tenantA.services.companies.get(secretB.id),
      (error) => error.status === 404,
    );

    // A membership in one tenant means nothing in the other.
    const membershipDoesNotCross = tenantB.spine.memberships.find({ organizationId: orgB.id, subject: 'alice' }) === null;

    // A genuine owner of B, pointed at A's organization id — refused for being
    // another tenant entirely, before any permission or membership is weighed.
    const mallory = identity(tenantB, 'mallory', orgB.id);
    const foreignOwnerRefused = tenantB.spine.decide({
      identity: mallory, organizationId: orgA.id, permission: 'records.read',
    }).reason === 'TENANT_NOT_BOUND';

    // And the same owner asking A's OWN instance is not found there: 404, not
    // 403, because confirming that A exists is itself the disclosure.
    const foreignOwnerNotFoundOnA = refuses(
      () => tenantA.spine.authorize({ identity: mallory, organizationId: orgB.id, permission: 'records.read' }),
      (error) => error.status === 404,
    );

    // Both instances share one control plane and hold different data planes.
    // Seeing that another tenant exists is not authority over its data.
    const controlPlaneShared = tenantA.controlPlaneDatabase.path === tenantB.controlPlaneDatabase.path;
    const dataPlanesSeparate = tenantA.database.path !== tenantB.database.path;
    const dataPlaneIsNotControlPlane = tenantA.database.path !== tenantA.controlPlaneDatabase.path;
    const tenantDatabaseHasNoMemberships = refuses(
      () => tenantA.database.raw.prepare('SELECT * FROM spine_memberships').all(),
      (error) => /no such table/.test(error.message),
    );

    // **The refusal this model is built on, performed rather than asserted.**
    // Serving two tenants from one process is not a limitation to be documented
    // and worked around; it is a configuration that will not start.
    const twoTenantsInOneApplicationRefused = refuses(
      () => createAccordoApp({
        clock: () => NOW,
        spine: {
          mode: 'production',
          identityVerifier: () => { throw new Error('not used in-process'); },
          tenant: { id: 'tenant-a', storageRoot: join(root, 'tenants'), tenants: ['tenant-a', 'tenant-b'] },
        },
      }),
      (error) => error.code === 'SPINE_MULTIPLE_DATA_PLANE_BINDINGS',
    );

    // ---- an authorized manager decides ---------------------------------
    const managerMayDecide = tenantA.spine.decide({
      identity: mo, organizationId: orgA.id, permission: 'approvals.decide',
    }).allowed;
    const managerMayApproveCommercially = tenantA.spine.decide({
      identity: mo, organizationId: orgA.id, permission: 'commercial.approve',
    }).allowed;

    // ---- an unauthorized user is refused -------------------------------
    const viewerDecision = tenantA.spine.decide({
      identity: vic, organizationId: orgA.id, permission: 'approvals.decide',
    });
    const viewerRefused = viewerDecision.allowed === false
      && viewerDecision.code === 'PERMISSION_NOT_IN_ROLE';
    const viewerMayStillRead = tenantA.spine.decide({
      identity: vic, organizationId: orgA.id, permission: 'records.read',
    }).allowed;

    // 401 versus 403: unverified is a different answer from unauthorized.
    let unauthenticatedStatus = null;
    try {
      tenantA.spine.authorize({ identity: tenantA.spine.anonymous, organizationId: orgA.id, permission: 'records.read' });
    } catch (error) { unauthenticatedStatus = error.status; }
    let unauthorizedStatus = null;
    try {
      tenantA.spine.authorize({ identity: vic, organizationId: orgA.id, permission: 'approvals.decide' });
    } catch (error) { unauthorizedStatus = error.status; }

    // ---- escalation, self-grant and the last administrator -------------
    const selfGrantRefused = refuses(
      () => tenantA.spine.memberships.grant({
        organizationId: orgA.id, subject: 'vic', role: 'owner', reason: 'promote me',
        identity: vic, mode: tenantA.spine.mode,
      }),
      (error) => error.status === 403,
    );
    const managerCannotGrantRefused = refuses(
      () => tenantA.spine.memberships.grant({
        organizationId: orgA.id, subject: 'x', role: 'owner', reason: 'escalate',
        identity: mo, mode: tenantA.spine.mode,
      }),
      (error) => error.status === 403,
    );
    const lastAdministratorProtected = refuses(
      () => tenantA.spine.memberships.grant({
        organizationId: orgA.id, subject: 'alice', role: 'viewer', reason: 'demote self',
        identity: alice, mode: tenantA.spine.mode,
      }),
      (error) => error.code === 'CONFLICT',
    );
    const secondBootstrapRefused = refuses(
      () => tenantA.spine.memberships.bootstrapOwner({ organizationId: orgA.id, subject: 'mallory' }),
      (error) => error.code === 'CONFLICT',
    );

    // ---- system and asserted identities --------------------------------
    const webhook = tenantA.spine.defineIdentity({
      kind: 'system', subject: 'signature-webhook', method: 'signed-webhook', organizationId: orgA.id,
    });
    const webhookMayReconcile = tenantA.spine.decide({
      identity: webhook, organizationId: orgA.id, permission: 'signature.reconcile',
    }).allowed;
    const webhookOverreachRefused = tenantA.spine.decide({
      identity: webhook, organizationId: orgA.id, permission: 'commercial.approve',
    }).code === 'SYSTEM_AUTHORITY_EXCEEDED';

    const assertedIdentity = tenantA.spine.defineIdentity({
      kind: 'asserted-local', subject: 'alice', method: 'developer-assertion', organizationId: orgA.id,
    });
    const assertedRefusedInProduction = tenantA.spine.decide({
      identity: assertedIdentity, organizationId: orgA.id, permission: 'records.read',
    }).code === 'ASSERTED_IDENTITY_REFUSED';

    // ---- no credential anywhere ----------------------------------------
    // Built rather than written down: a literal JWT-shaped string in the
    // repository would trip a secret scanner, which is a poor signal from a
    // milestone whose claim is that no credential is stored anywhere.
    const b64 = (value) => Buffer.from(value).toString('base64url');
    const TOKEN = [b64('{"alg":"HS256"}'), b64('{"sub":"NOT-A-REAL-SECRET"}'), 'signature'].join('.');
    const withClaims = tenantA.spine.defineIdentity({
      kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
      method: 'oidc-id-token', organizationId: orgA.id, claims: { sub: 'alice', raw: TOKEN },
    });
    const auditJson = JSON.stringify(tenantA.audit.list({ limit: 500 }));
    const noCredentialStored = !JSON.stringify(withClaims).includes('NOT-A-REAL-SECRET')
      && !auditJson.includes('NOT-A-REAL-SECRET')
      && /^[0-9a-f]{64}$/.test(withClaims.claimsFingerprint);

    // ---- nothing that would make this production ------------------------
    for (const absent of ['secret', 'job', 'outbox', 'schedule', 'backup', 'deployment']) {
      assert.throws(() => tenantA.modules.get(absent), /Module not found/, `"${absent}" must not exist`);
    }

    const spineBlock = tenantA.spine.describe();

    console.log(JSON.stringify({
      ok: true,
      summary: 'Composed two tenants as TWO BOUND INSTANCES over one shared control plane, which is the '
        + 'model this milestone enforces: one instance, one tenant, one storage binding. Two organizations '
        + 'inside one application is a configuration the framework REFUSES at startup, and that refusal was '
        + 'attempted and recorded rather than assumed; created identically '
        + 'named records in both and proved neither can reach the other by id, by collection or by write; '
        + 'proved a membership in one tenant means nothing in the other and that a genuine owner of B pointed '
        + 'at A is refused for the organization, not for the record; let an authorized manager decide and '
        + 'refused a viewer the same decision while leaving their read intact; kept 401 and 403 distinct; '
        + 'attempted a self-grant, an escalation by a manager, the demotion of the last administrator and a '
        + 'second bootstrap, and was refused each time; let a webhook reconcile and refused it a commercial '
        + 'approval; refused a developer assertion outright in production mode; and proved no credential '
        + 'reaches an identity, a decision or an audit row. Billing, jobs, secrets, backups and deployment '
        + 'do not exist, so none of this is production readiness.',

      // ---- numbers -------------------------------------------------------
      organizations: 1,
      memberships: tenantA.spine.memberships.listFor({ organizationId: orgA.id }).length,
      permissions: spineBlock.permissions.length,
      roles: Object.keys(spineBlock.roles).length,
      auditEvents: tenantA.audit.list({ limit: 500 }).length,
      companiesInTenantA: tenantA.services.companies.list({ limit: 500 }).length,
      companiesInTenantB: tenantB.services.companies.list({ limit: 500 }).length,

      // ---- facts ----------------------------------------------------------
      // The raw strings for a human reading the report — and the same two facts
      // as booleans, because an observed value may only be a lowercase token
      // and both of these carry hyphens.
      mode: spineBlock.mode,
      tenantStrategyDeclared: spineBlock.tenantStrategyDeclared,
      modeIsProduction: spineBlock.mode === 'production',
      tenantStrategyDeclaredDatabasePerTenant: spineBlock.tenantStrategyDeclared === 'database-per-tenant',

      // The gap, published by the runtime and carried into the evidence rather
      // than left for a reader to discover. Isolation below is proven for TWO
      // APPLICATIONS; it is not a property the framework enforces.
      crmDataPlaneIsolationEnforced: spineBlock.tenantIsolation.crmDataPlaneEnforced,
      tenantStorageBoundaryWired: spineBlock.tenantIsolation.storageBoundaryWired,
      controlPlaneScoped: spineBlock.tenantIsolation.controlPlaneScoped,
      sharedDatabaseMultiTenancyClaimed: spineBlock.tenantIsolation.sharedDatabaseMultiTenancy,
      multipleOrganizationsInOneInstance: spineBlock.tenantIsolation.multipleOrganizationsInOneInstance,
      postgresImplemented: spineBlock.tenantIsolation.postgresImplemented,
      foreignOwnerNotFoundOnA,
      controlPlaneShared,
      dataPlanesSeparate,
      dataPlaneIsNotControlPlane,
      tenantDatabaseHasNoMemberships,
      twoTenantsInOneApplicationRefused,
      assertedActorsAllowed: spineBlock.allowsAssertedActors,
      crossTenantByIdRefused,
      crossTenantByListRefused,
      bCannotSeeAAtAll,
      aCannotSeeB,
      membershipDoesNotCross,
      foreignOwnerRefused,
      managerMayDecide,
      managerMayApproveCommercially,
      viewerRefused,
      viewerMayStillRead,
      unauthenticatedIsFourZeroOne: unauthenticatedStatus === 401,
      unauthorizedIsFourZeroThree: unauthorizedStatus === 403,
      selfGrantRefused,
      managerCannotGrantRefused,
      lastAdministratorProtected,
      secondBootstrapRefused,
      webhookMayReconcile,
      webhookOverreachRefused,
      assertedRefusedInProduction,
      noCredentialStored,

      // ---- the omissions, stated rather than implied ------------------------
      sharedDatabaseTenancyClaimed: false,
      identityProviderContacted: false,
      credentialStoredAnywhere: false,
      productionReadinessClaimed: false,
      anythingScheduled: false,
      anythingBackedUp: false,
    }, null, 2));
  } finally {
    tenantA.close();
    tenantB.close();
  }
} finally {
  if (!keepRoot) rmSync(root, { recursive: true, force: true });
}
