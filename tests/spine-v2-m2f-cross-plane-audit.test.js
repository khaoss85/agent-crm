// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { AuditLog } from '../packages/core/src/audit.js';
import {
  CORE_MIGRATIONS_FOR_CHARACTERIZATION,
  MIGRATION_VERSIONS,
  createDatabase,
} from '../packages/core/src/database.js';
import { createSpineStore } from '../packages/core/index.js';

function spineConfig(root, tenant = 'alpha', controlPlanePath = undefined) {
  return {
    mode: 'production',
    identityVerifier: () => {},
    tenant: {
      id: tenant,
      storageRoot: root,
      ...(controlPlanePath ? { controlPlanePath } : {}),
      provision: { name: tenant },
    },
  };
}

function fixture(t, tenant = 'alpha', options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'accordo-m2f-audit-'));
  if (!options.root) t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = createAccordoApp({
    spine: {
      ...spineConfig(root, tenant, options.controlPlanePath),
    },
  });
  t.after(() => app.close());
  return app;
}

function count(database, table, where = '1 = 1') {
  return Number(database.raw.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get().n);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const organizationKeys = ['createdAt', 'id', 'name', 'provenance', 'slug', 'updatedAt'];
const membershipKeys = [
  'createdAt', 'grantedBySubject', 'grantedReason', 'id', 'issuer', 'organizationId',
  'permissions', 'role', 'status', 'subject', 'updatedAt',
];

const RAW_DRIVER_SPELLINGS = Object.freeze([
  /database\s*\??\.\s*raw\b/,
  /\??\.\s*raw\s*\??\.\s*(?:prepare|exec)\s*\(/,
  /database\s*\??\.?\s*\[\s*['"]raw['"]\s*\]/,
  /\{[^{}]*\braw\b[^{}]*\}\s*=\s*[^;\n]*\bdatabase\b/i,
  /\bDatabaseSync\b/,
]);

const rawDriverSpelling = (source) => RAW_DRIVER_SPELLINGS.find((pattern) => pattern.test(source)) ?? null;

test('a committed membership mutation reports pending audit instead of a false rollback', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_refuse_membership_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'sentinel credential must never escape');
    END;
  `);

  let result;
  let refusal;
  try {
    result = app.spine.memberships.bootstrapOwner({
      organizationId: organization.id,
      subject: 'alice',
    });
  } catch (error) {
    refusal = error;
  }

  assert.equal(
    app.spine.memberships.find({ organizationId: organization.id, subject: 'alice' })?.status,
    'active',
    'the control-plane mutation committed before data-plane audit failed',
  );
  assert.equal(
    app.audit.list({ entityType: 'spine_membership', limit: 10 }).length,
    0,
    'the data plane has no matching audit evidence',
  );
  assert.equal(refusal, undefined, 'a committed mutation must not be reported as rolled back');
  assert.equal(result.auditDelivery.status, 'committed_with_pending_audit');
  assert.equal(result.auditDelivery.code, 'SPINE_AUDIT_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /sentinel credential/);
});

test('a caller-owned data transaction is refused before mutation or recovery', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  const beforeIntents = count(app.controlPlaneDatabase, 'spine_audit_intents');
  const beforeAudits = count(app.database, 'audit_events');

  assert.throws(
    () => app.database.transaction(() => app.spine.memberships.bootstrapOwner({
      organizationId: organization.id,
      subject: 'alice',
    })),
    (error) => error.code === 'SPINE_AUDIT_DATA_TRANSACTION_ACTIVE',
  );

  assert.equal(app.spine.memberships.find({ organizationId: organization.id, subject: 'alice' }), null);
  assert.equal(count(app.controlPlaneDatabase, 'spine_audit_intents'), beforeIntents);
  assert.equal(count(app.database, 'audit_events'), beforeAudits);
});

test('a caller-owned control transaction is refused before mutation or recovery', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  const beforeIntents = count(app.controlPlaneDatabase, 'spine_audit_intents');
  const beforeAudits = count(app.database, 'audit_events');

  assert.throws(
    () => app.controlPlaneDatabase.transaction(() => app.spine.memberships.bootstrapOwner({
      organizationId: organization.id,
      subject: 'alice',
    })),
    (error) => error.code === 'SPINE_AUDIT_CONTROL_TRANSACTION_ACTIVE',
  );

  assert.equal(app.spine.memberships.find({ organizationId: organization.id, subject: 'alice' }), null);
  assert.equal(count(app.controlPlaneDatabase, 'spine_audit_intents'), beforeIntents);
  assert.equal(count(app.database, 'audit_events'), beforeAudits);
});

test('successful audit delivery preserves exact v1 result shapes across all four consumers', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  assert.deepEqual(Object.keys(organization).sort(), organizationKeys);

  const alice = app.spine.memberships.bootstrapOwner({
    organizationId: organization.id,
    subject: 'alice',
  });
  assert.deepEqual(Object.keys(alice).sort(), membershipKeys);
  const identity = app.spine.defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: organization.id,
  });
  const bob = app.spine.memberships.grant({
    organizationId: organization.id,
    subject: 'bob',
    role: 'owner',
    reason: 'second administrator',
    identity,
    mode: app.spine.mode,
  });
  assert.deepEqual(Object.keys(bob).sort(), membershipKeys);
  const changed = app.spine.memberships.grant({
    organizationId: organization.id,
    subject: 'bob',
    role: 'viewer',
    reason: 'review-only access',
    identity,
    mode: app.spine.mode,
  });
  assert.deepEqual(Object.keys(changed).sort(), membershipKeys);
  const suspended = app.spine.memberships.suspend({
    organizationId: organization.id,
    subject: 'bob',
    reason: 'access ended',
    identity,
    mode: app.spine.mode,
  });
  assert.deepEqual(Object.keys(suspended).sort(), membershipKeys);

  const intents = app.controlPlaneDatabase.raw.prepare(
    'SELECT action, delivered_at FROM spine_audit_intents ORDER BY created_at, id',
  ).all();
  assert.deepEqual(intents.map(({ action }) => action), [
    'created', 'bootstrapped', 'granted', 'role_changed', 'suspended',
  ]);
  assert.equal(intents.every(({ delivered_at: deliveredAt }) => deliveredAt !== null), true);
  assert.equal(count(app.database, 'audit_events', "entity_type IN ('spine_organization', 'spine_membership')"), 5);
});

test('a control fault before mutation rolls back entity, intent and audit together', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  const beforeIntents = count(app.controlPlaneDatabase, 'spine_audit_intents');
  const beforeAudits = count(app.database, 'audit_events');
  app.controlPlaneDatabase.raw.exec(`
    CREATE TRIGGER m2f_refuse_membership_before_insert
    BEFORE INSERT ON spine_memberships
    BEGIN
      SELECT RAISE(ABORT, 'injected control mutation failure');
    END;
  `);

  assert.throws(
    () => app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' }),
    /injected control mutation failure/,
  );
  assert.equal(app.spine.memberships.find({ organizationId: organization.id, subject: 'alice' }), null);
  assert.equal(count(app.controlPlaneDatabase, 'spine_audit_intents'), beforeIntents);
  assert.equal(count(app.database, 'audit_events'), beforeAudits);
});

test('short control -> committed data -> short control CAS recovers exactly once', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.controlPlaneDatabase.raw.exec(`
    CREATE TRIGGER m2f_refuse_delivered_transition
    BEFORE UPDATE OF delivered_at ON spine_audit_intents
    BEGIN
      SELECT RAISE(ABORT, 'injected after-audit failure');
    END;
  `);

  // The data audit commits before the injected terminal control CAS fails.
  // Seeing one audit plus a pending intent therefore pins the phase order; a
  // retry must verify that committed row and perform only the final control CAS.
  const result = app.spine.memberships.bootstrapOwner({
    organizationId: organization.id,
    subject: 'alice',
  });
  assert.equal(result.auditDelivery.status, 'committed_with_pending_audit');
  assert.equal(result.auditDelivery.code, 'SPINE_AUDIT_DELIVERY_FAILED');
  assert.equal(app.spine.auditIntents.listPending().length, 1);
  assert.equal(count(app.database, 'audit_events', "entity_type = 'spine_membership'"), 1);

  app.controlPlaneDatabase.raw.exec('DROP TRIGGER m2f_refuse_delivered_transition');
  assert.deepEqual(app.spine.auditIntents.reconcile(), {
    auditIntentContract: 1, attempted: 1, delivered: 1,
    failed: 0, failures: [], pending: 0,
  });
  assert.equal(count(app.database, 'audit_events', "entity_type = 'spine_membership'"), 1);
  assert.deepEqual(app.spine.auditIntents.reconcile(), {
    auditIntentContract: 1, attempted: 0, delivered: 0,
    failed: 0, failures: [], pending: 0,
  });
});

test('public v1 store and AuditLog keep their released surface while internals gain exact retry', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const audit = new AuditLog(database);
  const store = createSpineStore({ database, audit, now: () => '2026-08-28T10:00:00.000Z' });
  const organization = store.organizations.create({ slug: 'alpha', name: 'Alpha' });
  const directStore = createSpineStore({
    database: database.raw,
    audit,
    now: () => '2026-08-28T10:00:01.000Z',
  });
  const directOrganization = directStore.organizations.create({ slug: 'beta', name: 'Beta' });

  assert.deepEqual(Object.keys(store).sort(), ['memberships', 'organizations']);
  assert.deepEqual(Object.keys(organization).sort(), organizationKeys);
  assert.deepEqual(Object.keys(directStore).sort(), ['memberships', 'organizations']);
  assert.deepEqual(Object.keys(directOrganization).sort(), organizationKeys);
  const supplied = audit.record(/** @type {any} */ ({
    id: 'caller-chosen-id',
    createdAt: '2000-01-01T00:00:00.000Z',
    actor: { type: 'user', id: 'alice' },
    action: 'checked',
    entityType: 'surface_probe',
    entityId: 'probe',
  }));
  assert.notEqual(supplied.id, 'caller-chosen-id', 'public callers still cannot choose audit identity');
  assert.notEqual(supplied.createdAt, '2000-01-01T00:00:00.000Z', 'or audit time');

  assert.throws(
    () => store.memberships.grant({
      organizationId: 'missing', subject: null, role: 'not-a-role', reason: null,
      identity: null, mode: null,
    }),
    (error) => error.code === 'NOT_FOUND',
    'v1 still resolves the Organization before validating grant input',
  );
  store.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  assert.throws(
    () => store.memberships.bootstrapOwner({ organizationId: organization.id, subject: null }),
    (error) => error.code === 'CONFLICT',
    'v1 still refuses a second bootstrap before inspecting its new input',
  );
  assert.throws(
    () => store.memberships.suspend({
      organizationId: 'missing', subject: 'alice', reason: 'probe', identity: null, mode: null,
    }),
    (error) => error.code === 'FORBIDDEN',
    'v1 suspend still authorizes before it tries to resolve a target membership',
  );

  const publicIndex = readFileSync(new URL('../packages/core/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    publicIndex,
    /createRecoverableSpineStore|putAuditEventExact|spineStoreStorage/,
  );
});

test('audit-intent recovery exposes one bounded tenant-scoped surface', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_bounded_surface_audit_fault
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'bounded surface probe');
    END;
  `);
  app.spine.memberships.bootstrapOwner({
    organizationId: organization.id,
    subject: 'alice',
  });

  assert.equal(Object.isFrozen(app.spine.auditIntents), true);
  assert.deepEqual(Object.keys(app.spine.auditIntents).sort(), [
    'auditIntentContract', 'listPending', 'reconcile',
  ]);
  assert.equal(app.spine.describe().auditIntentContract, 1);
  const pending = app.spine.auditIntents.listPending({ limit: 500 });
  assert.equal(pending.length, 1);
  assert.equal(Object.isFrozen(pending[0]), true);
  assert.deepEqual(Object.keys(pending[0]).sort(), [
    'action', 'createdAt', 'entityId', 'entityType', 'intentId',
  ]);
  assert.doesNotMatch(JSON.stringify(pending), /actor|dataPlane|payload|tenant|credential/i);
});

test('spine-store carries no known raw-driver spelling, and the token guard is falsifiable', () => {
  const source = readFileSync(new URL('../packages/core/src/spine-store.js', import.meta.url), 'utf8');
  assert.equal(rawDriverSpelling(source), null);
  const anchor = 'export const MAX_ORG_NAME = 200;';
  assert.equal(source.includes(anchor), true, 'the planted mutation must have a live anchor');
  const planted = source.replace(anchor, `const escaped = database?.['raw']?.prepare(sql);\n${anchor}`);
  assert.notEqual(rawDriverSpelling(planted), null, 'the same source is rejected when the escape is planted');
  assert.equal(
    rawDriverSpelling("const key = 'ra' + 'w'; const driver = database[key];"),
    null,
    'this is a bounded spelling scan, not a semantic reachability proof',
  );
});

test('an unbound Organization commits with a NULL binding and only its own instance can recover it', (t) => {
  const appA = fixture(t, 'alpha');
  const beta = appA.spine.organizations.create({ slug: 'beta', name: 'Beta' });
  assert.deepEqual(Object.keys(beta).sort(), [...organizationKeys, 'auditDelivery'].sort());
  assert.equal(beta.auditDelivery.status, 'committed_with_pending_audit');
  assert.equal(beta.auditDelivery.code, 'SPINE_AUDIT_DESTINATION_NOT_BOUND');

  const binding = appA.controlPlaneDatabase.raw.prepare(
    'SELECT tenant_slug, data_plane_id FROM spine_tenant_bindings WHERE tenant_slug = ?',
  ).get('beta');
  assert.deepEqual({ ...binding }, { tenant_slug: 'beta', data_plane_id: null });
  const beforeClaim = appA.controlPlaneDatabase.raw.prepare(
    'SELECT * FROM spine_audit_intents WHERE destination_tenant_slug = ?',
  ).get('beta');
  const digest = createHash('sha256').update(canonicalJson({
    contract: 1,
    tenantSlug: 'beta',
    entityType: beforeClaim.entity_type,
    entityId: beforeClaim.entity_id,
    revision: Number(beforeClaim.mutation_revision),
  })).digest('hex');
  assert.equal(beforeClaim.id, `sai_${digest}`);
  assert.equal(beforeClaim.audit_event_id, `spine_${digest}`);
  assert.equal(count(appA.controlPlaneDatabase, 'spine_audit_intents', "destination_tenant_slug = 'beta' AND delivered_at IS NULL"), 1);
  assert.equal(appA.audit.list({ entityId: beta.id, limit: 10 }).length, 0);
  assert.equal(appA.spine.auditIntents.reconcile().attempted, 0, 'A cannot even claim B pending work');

  const rootB = mkdtempSync(join(tmpdir(), 'accordo-m2f-beta-'));
  t.after(() => rmSync(rootB, { recursive: true, force: true }));
  const appB = createAccordoApp({
    spine: spineConfig(rootB, 'beta', appA.controlPlaneDatabase.path),
  });
  t.after(() => appB.close());
  assert.equal(appB.spine.boundOrganization.id, beta.id);
  const afterClaim = appB.controlPlaneDatabase.raw.prepare(
    'SELECT id, payload_fingerprint FROM spine_audit_intents WHERE destination_tenant_slug = ?',
  ).get('beta');
  assert.deepEqual(
    { ...afterClaim },
    { id: beforeClaim.id, payload_fingerprint: beforeClaim.payload_fingerprint },
    'claiming a destination cannot change mutation identity or evidence fingerprint',
  );
  assert.equal(appB.spine.auditIntents.listPending().length, 1);
  assert.equal(appB.spine.auditIntents.reconcile().delivered, 1);
  assert.equal(appB.audit.list({ entityId: beta.id, limit: 10 }).length, 1);
  assert.equal(appA.audit.list({ entityId: beta.id, limit: 10 }).length, 0, 'A never copies B evidence');
});

test('two distinct files race one slug CAS: exactly one wins and the loser refuses stably', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'accordo-m2f-binding-race-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const rootA = join(workspace, 'a');
  const rootB = join(workspace, 'b');
  const controlPath = join(workspace, 'shared-control.sqlite');
  const control = createDatabase({ path: controlPath, plane: 'control' });
  control.raw.prepare(
    `INSERT INTO spine_organizations(
       id, slug, name, provenance, created_at, updated_at, audit_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'org_alpha', 'alpha', 'Alpha', 'operator-configured',
    '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', 0,
  );
  control.close();
  createDatabase({ path: join(rootA, 'tenants', 'alpha.sqlite'), plane: 'data' }).close();
  createDatabase({ path: join(rootB, 'tenants', 'alpha.sqlite'), plane: 'data' }).close();

  const appUrl = new URL('../packages/app/src/index.js', import.meta.url).href;
  const childSource = `
    import { createAccordoApp } from ${JSON.stringify(appUrl)};
    try {
      const app = createAccordoApp({ spine: {
        mode: 'production', identityVerifier: () => {},
        tenant: {
          id: 'alpha', storageRoot: process.env.M2F_ROOT,
          controlPlanePath: process.env.M2F_CONTROL, provision: { name: 'Alpha' },
        },
      } });
      const id = app.database.raw.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id;
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.close();
      console.log(JSON.stringify({ ok: true, id }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code }));
    }
  `;
  const runChild = (root) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childSource], {
      env: { ...process.env, M2F_ROOT: root, M2F_CONTROL: controlPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
  const results = await Promise.all([runChild(rootA), runChild(rootB)]);
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(
    results.filter(({ ok }) => !ok).map(({ code }) => code),
    ['SPINE_DATA_PLANE_BINDING_CONFLICT'],
  );
  const winner = results.find(({ ok }) => ok);
  const loserRoot = results[0].ok ? rootB : rootA;
  const loser = new DatabaseSync(join(loserRoot, 'tenants', 'alpha.sqlite'));
  const loserMarker = loser.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id;
  loser.close();
  const controlAfter = new DatabaseSync(controlPath);
  const mapped = controlAfter.prepare(
    'SELECT data_plane_id FROM spine_tenant_bindings WHERE tenant_slug = ?',
  ).get('alpha').data_plane_id;
  controlAfter.close();
  const winnerMarker = winner.id;
  assert.notEqual(loserMarker, winnerMarker);
  assert.equal(mapped, winnerMarker);

  assert.throws(
    () => createAccordoApp({ spine: spineConfig(loserRoot, 'alpha', controlPath) }),
    (error) => error.code === 'SPINE_DATA_PLANE_BINDING_CONFLICT',
    'the losing file refuses stably on restart rather than adopting the winner id',
  );
});

test('a crash after marker mint but before control CAS retries with the same physical identity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-marker-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controlPath = join(root, 'control.sqlite');
  const control = createDatabase({ path: controlPath, plane: 'control' });
  control.raw.exec(`
    CREATE TRIGGER m2f_refuse_first_binding
    BEFORE INSERT ON spine_tenant_bindings
    BEGIN
      SELECT RAISE(ABORT, 'injected before binding CAS');
    END;
  `);
  control.close();

  assert.throws(
    () => createAccordoApp({ spine: spineConfig(root, 'alpha', controlPath) }),
    /injected before binding CAS/,
  );
  const dataPath = join(root, 'tenants', 'alpha.sqlite');
  const afterCrash = new DatabaseSync(dataPath);
  const firstId = afterCrash.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id;
  afterCrash.close();
  const repair = new DatabaseSync(controlPath);
  assert.equal(repair.prepare('SELECT COUNT(*) AS n FROM spine_tenant_bindings').get().n, 0);
  repair.exec('DROP TRIGGER m2f_refuse_first_binding');
  repair.close();

  const retried = createAccordoApp({ spine: spineConfig(root, 'alpha', controlPath) });
  t.after(() => retried.close());
  assert.equal(
    retried.database.raw.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id,
    firstId,
  );
  assert.equal(
    retried.controlPlaneDatabase.raw.prepare('SELECT data_plane_id FROM spine_tenant_bindings').get().data_plane_id,
    firstId,
  );
});

test('unknown production tenant refuses before marker or control mapping is created', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createAccordoApp({
      spine: {
        mode: 'production', identityVerifier: () => {},
        tenant: { id: 'alpha', storageRoot: root },
      },
    }),
    (error) => error.code === 'SPINE_BOUND_TENANT_UNKNOWN',
  );

  const data = new DatabaseSync(join(root, 'tenants', 'alpha.sqlite'));
  const control = new DatabaseSync(join(root, 'control-plane.sqlite'));
  t.after(() => { data.close(); control.close(); });
  assert.equal(data.prepare('SELECT COUNT(*) AS n FROM spine_data_plane_binding').get().n, 0);
  assert.equal(control.prepare('SELECT COUNT(*) AS n FROM spine_tenant_bindings').get().n, 0);
});

test('two processes for one physical file converge on one marker and one control binding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-same-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  const expected = initialized.database.raw.prepare(
    'SELECT data_plane_id FROM spine_data_plane_binding',
  ).get().data_plane_id;
  initialized.close();

  const appUrl = new URL('../packages/app/src/index.js', import.meta.url).href;
  const childSource = `
    import { createAccordoApp } from ${JSON.stringify(appUrl)};
    const app = createAccordoApp({ spine: {
      mode: 'production', identityVerifier: () => {},
      tenant: { id: 'alpha', storageRoot: process.env.M2F_ROOT, provision: { name: 'alpha' } },
    } });
    console.log(app.database.raw.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    app.close();
  `;
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childSource], {
      env: { ...process.env, M2F_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(stdout.trim());
    });
  });
  const [firstId, secondId] = await Promise.all([runChild(), runChild()]);
  assert.equal(firstId, expected);
  assert.equal(secondId, expected);

  const verified = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  t.after(() => verified.close());
  assert.equal(
    verified.controlPlaneDatabase.raw.prepare(
      'SELECT data_plane_id FROM spine_tenant_bindings WHERE tenant_slug = ?',
    ).get('alpha').data_plane_id,
    expected,
  );
});

test('a crash after control CAS but before first audit leaves restart-visible pending evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-cas-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataPath = join(root, 'tenants', 'alpha.sqlite');
  const data = createDatabase({ path: dataPath, plane: 'data' });
  data.raw.exec(`
    CREATE TRIGGER m2f_refuse_first_audit
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'injected after control CAS');
    END;
  `);
  data.close();

  const first = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  assert.equal(first.spine.boundOrganization.auditDelivery.status, 'committed_with_pending_audit');
  assert.equal(first.spine.auditIntents.listPending().length, 1);
  assert.equal(count(first.database, 'audit_events'), 0);
  const markerId = first.database.raw.prepare('SELECT data_plane_id FROM spine_data_plane_binding').get().data_plane_id;
  assert.equal(
    first.controlPlaneDatabase.raw.prepare('SELECT data_plane_id FROM spine_tenant_bindings').get().data_plane_id,
    markerId,
  );
  first.close();

  const repair = new DatabaseSync(dataPath);
  repair.exec('DROP TRIGGER m2f_refuse_first_audit');
  repair.close();
  const restarted = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  t.after(() => restarted.close());
  assert.equal(restarted.spine.auditIntents.listPending().length, 1);
  assert.equal(restarted.spine.auditIntents.reconcile().delivered, 1);
  assert.equal(count(restarted.database, 'audit_events', "entity_type = 'spine_organization'"), 1);
});

test('an M1-era A+B control plane upgrades, records B pending from A, then B claims and recovers', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'accordo-m2f-v5-upgrade-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const controlPath = join(workspace, 'control.sqlite');
  const legacy = new DatabaseSync(controlPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const v5 = CORE_MIGRATIONS_FOR_CHARACTERIZATION.find(({ version }) => version === 5);
  legacy.exec(v5.sql);
  legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
    .run(5, v5.name, '2026-08-28T00:00:00.000Z');
  legacy.prepare(
    `INSERT INTO spine_organizations(id, slug, name, provenance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
  ).run(
    'org_alpha', 'alpha', 'Alpha', 'operator-configured', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
    'org_beta', 'beta', 'Beta', 'operator-configured', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
  );
  legacy.prepare(
    `INSERT INTO spine_memberships(
       id, organization_id, subject, issuer, role, status,
       granted_by_subject, granted_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'mem_beta_owner', 'org_beta', 'betty', 'https://issuer.test', 'owner', 'active',
    null, 'legacy owner', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
  );
  legacy.close();

  const appA = createAccordoApp({ spine: spineConfig(join(workspace, 'a'), 'alpha', controlPath) });
  t.after(() => appA.close());
  const betty = appA.spine.defineIdentity({
    kind: 'verified-user', subject: 'betty', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: 'org_beta',
  });
  const granted = appA.spine.memberships.grant({
    organizationId: 'org_beta', subject: 'bob', role: 'viewer', reason: 'legacy tenant migration',
    identity: betty, mode: appA.spine.mode,
  });
  assert.equal(granted.auditDelivery.status, 'committed_with_pending_audit');
  assert.equal(
    appA.controlPlaneDatabase.raw.prepare(
      'SELECT data_plane_id FROM spine_tenant_bindings WHERE tenant_slug = ?',
    ).get('beta').data_plane_id,
    null,
  );
  assert.equal(appA.audit.list({ entityId: granted.id, limit: 10 }).length, 0);

  const appB = createAccordoApp({ spine: spineConfig(join(workspace, 'b'), 'beta', controlPath) });
  t.after(() => appB.close());
  assert.equal(appB.spine.auditIntents.reconcile().delivered, 1);
  assert.equal(appB.audit.list({ entityId: granted.id, limit: 10 }).length, 1);
  assert.equal(appA.audit.list({ entityId: granted.id, limit: 10 }).length, 0);
});

test('core migration identities and plane order are append-only and wrong names refuse stably', (t) => {
  assert.deepEqual(MIGRATION_VERSIONS, {
    combined: [1, 2, 3, 4, 5, 6, 7],
    data: [1, 2, 3, 4, 6],
    control: [5, 7],
  });
  const released = CORE_MIGRATIONS_FOR_CHARACTERIZATION
    .filter(({ version }) => version <= 5)
    .map(({ plane, version, name, sql }) => ({
      plane, version, name, checksum: createHash('sha256').update(sql).digest('hex'),
    }));
  assert.deepEqual(released, [
    { plane: 'data', version: 1, name: 'initial_crm_schema', checksum: '2d386db73f44bc6da6e76942ba8dba2ee37d6799e5442e9c894d035848a2555e' },
    { plane: 'data', version: 2, name: 'opportunity_source_key', checksum: 'deed722482124ab96deb2f884ab4e0fb9308318f9411cc8b67e1bf5552d0093a' },
    { plane: 'data', version: 3, name: 'opportunity_pipeline_state', checksum: 'fccd2e6dd49aa73245b301b08bfc7f4dc167e7154a24cd5c56fcb66e444a8c6b' },
    { plane: 'data', version: 4, name: 'definition_versions', checksum: 'f2b4daf5f0dbee756ae2b04087c28c0debafcfe474fb78f976ac1dfdfde744a8' },
    { plane: 'control', version: 5, name: 'production_spine_identity', checksum: 'dd5ab2cc2a946e2f573bd1536952e18974c19a776b71074f4335602a47cc04fc' },
  ]);

  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-bad-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'control.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (5, 'wrong_name', '2026-08-28T00:00:00.000Z');
  `);
  raw.close();
  assert.throws(
    () => createDatabase({ path, plane: 'control' }),
    (error) => error.code === 'CORE_MIGRATION_IDENTITY_MISMATCH'
      && error.details.version === 5
      && error.details.expectedName === 'production_spine_identity',
  );
});

test('stored payload fingerprint is reverified before delivery and divergent intent stays pending', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_hold_membership_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'hold pending');
    END;
  `);
  const pending = app.spine.memberships.bootstrapOwner({
    organizationId: organization.id, subject: 'alice',
  });
  app.database.raw.exec('DROP TRIGGER m2f_hold_membership_audit');
  app.controlPlaneDatabase.raw.exec('DROP TRIGGER spine_audit_intents_terminal_update');
  app.controlPlaneDatabase.raw.prepare(
    'UPDATE spine_audit_intents SET data_json = ? WHERE id = ?',
  ).run('{"tampered":true}', pending.auditDelivery.intentId);

  const receipt = app.spine.auditIntents.reconcile();
  assert.equal(receipt.attempted, 1);
  assert.equal(receipt.delivered, 0);
  assert.equal(receipt.failed, 1);
  assert.deepEqual(receipt.failures, [{
    intentId: pending.auditDelivery.intentId,
    code: 'SPINE_AUDIT_INTENT_DIVERGENT',
  }]);
  assert.equal(receipt.pending, 1);
  assert.equal(count(app.database, 'audit_events', "entity_type = 'spine_membership'"), 0);
});

test('marker mismatch is reverified inside delivery and leaves the intent visibly pending', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_hold_marker_probe
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'hold marker probe');
    END;
  `);
  const pending = app.spine.memberships.bootstrapOwner({
    organizationId: organization.id, subject: 'alice',
  });
  app.database.raw.exec(`
    DROP TRIGGER m2f_hold_marker_probe;
    DROP TRIGGER spine_data_plane_binding_no_update;
    UPDATE spine_data_plane_binding SET data_plane_id = 'dp_tampered';
  `);

  const receipt = app.spine.auditIntents.reconcile();
  assert.equal(receipt.delivered, 0);
  assert.deepEqual(receipt.failures, [{
    intentId: pending.auditDelivery.intentId,
    code: 'SPINE_DATA_PLANE_BINDING_MISMATCH',
  }]);
  assert.equal(receipt.pending, 1);
  assert.equal(count(app.database, 'audit_events', "entity_type = 'spine_membership'"), 0);
});

test('a poisoned oldest intent does not starve the next valid pending audit', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_hold_two_membership_audits
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'hold pending');
    END;
  `);
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  const alice = app.spine.defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: organization.id,
  });
  app.spine.memberships.grant({
    organizationId: organization.id, subject: 'bob', role: 'viewer', reason: 'read only',
    identity: alice, mode: app.spine.mode,
  });
  app.database.raw.exec('DROP TRIGGER m2f_hold_two_membership_audits');

  const pending = app.controlPlaneDatabase.raw.prepare(
    `SELECT * FROM spine_audit_intents
      WHERE destination_tenant_slug = ? AND delivered_at IS NULL
      ORDER BY created_at, id`,
  ).all('alpha');
  assert.equal(pending.length, 2);
  const poisoned = pending[0];
  app.database.raw.prepare(
    `INSERT INTO audit_events(
       id, actor_type, actor_id, action, entity_type, entity_id, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    poisoned.audit_event_id,
    'system', 'divergent', 'wrong', poisoned.entity_type, poisoned.entity_id,
    '{}', poisoned.created_at,
  );

  const receipt = app.spine.auditIntents.reconcile();
  assert.equal(receipt.attempted, 2);
  assert.equal(receipt.delivered, 1);
  assert.equal(receipt.failed, 1);
  assert.deepEqual(receipt.failures, [{
    intentId: poisoned.id,
    code: 'AUDIT_EVENT_DIVERGENT',
  }]);
  assert.equal(receipt.pending, 1);
  const valid = pending[1];
  assert.equal(app.audit.list({ entityId: valid.entity_id, limit: 10 }).length, 1);
});

test('binding, marker and intent triggers permit only their one declared transition', (t) => {
  const app = fixture(t);
  const beta = app.spine.organizations.create({ slug: 'beta', name: 'Beta' });
  const intentId = beta.auditDelivery.intentId;

  assert.throws(
    () => app.database.raw.exec("UPDATE spine_data_plane_binding SET tenant_slug = 'other'"),
    /immutable/,
  );
  assert.throws(() => app.database.raw.exec('DELETE FROM spine_data_plane_binding'), /immutable/);
  assert.throws(
    () => app.controlPlaneDatabase.raw.exec(
      "UPDATE spine_tenant_bindings SET created_at = 'changed' WHERE tenant_slug = 'beta'",
    ),
    /first data-plane claim/,
  );
  assert.throws(
    () => app.controlPlaneDatabase.raw.exec(
      "UPDATE spine_tenant_bindings SET data_plane_id = NULL WHERE tenant_slug = 'beta'",
    ),
    /first data-plane claim/,
  );
  app.controlPlaneDatabase.raw.exec(
    "UPDATE spine_tenant_bindings SET data_plane_id = 'dp_first' WHERE tenant_slug = 'beta'",
  );
  assert.throws(
    () => app.controlPlaneDatabase.raw.exec(
      "UPDATE spine_tenant_bindings SET data_plane_id = 'dp_second' WHERE tenant_slug = 'beta'",
    ),
    /first data-plane claim/,
  );
  assert.throws(
    () => app.controlPlaneDatabase.raw.exec("DELETE FROM spine_tenant_bindings WHERE tenant_slug = 'beta'"),
    /immutable/,
  );

  assert.throws(
    () => app.controlPlaneDatabase.raw.prepare(
      'UPDATE spine_audit_intents SET action = ? WHERE id = ?',
    ).run('changed', intentId),
    /immutable except pending-to-delivered/,
  );
  assert.throws(
    () => app.controlPlaneDatabase.raw.prepare('DELETE FROM spine_audit_intents WHERE id = ?').run(intentId),
    /immutable/,
  );
  app.controlPlaneDatabase.raw.prepare(
    'UPDATE spine_audit_intents SET delivered_at = ? WHERE id = ?',
  ).run('2026-08-28T12:00:00.000Z', intentId);
  assert.throws(
    () => app.controlPlaneDatabase.raw.prepare(
      'UPDATE spine_audit_intents SET delivered_at = ? WHERE id = ?',
    ).run('2026-08-28T12:00:01.000Z', intentId),
    /immutable except pending-to-delivered/,
  );
});

test('unsafe mutation revisions are refused at the schema boundary before they can enter identity', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  const alice = app.spine.defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: organization.id,
  });
  const bob = app.spine.memberships.grant({
    organizationId: organization.id, subject: 'bob', role: 'viewer', reason: 'read only',
    identity: alice, mode: app.spine.mode,
  });
  const beforeIntents = count(app.controlPlaneDatabase, 'spine_audit_intents');
  const beforeAudits = count(app.database, 'audit_events');
  assert.throws(
    () => app.controlPlaneDatabase.raw.prepare(
      'UPDATE spine_memberships SET audit_revision = ? WHERE id = ?',
    ).run(9007199254740992, bob.id),
    /non-negative safe integer/,
  );
  assert.equal(app.spine.memberships.find({ organizationId: organization.id, subject: 'bob' }).role, 'viewer');
  assert.equal(count(app.controlPlaneDatabase, 'spine_audit_intents'), beforeIntents);
  assert.equal(count(app.database, 'audit_events'), beforeAudits);

  const changed = app.spine.memberships.grant({
    organizationId: organization.id, subject: 'bob', role: 'manager', reason: 'safe next revision',
    identity: alice, mode: app.spine.mode,
  });
  assert.equal(changed.role, 'manager');
});

test('bounded reconciliation reports the true pending count beyond one page', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_hold_many_membership_audits
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'hold many pending');
    END;
  `);
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  const alice = app.spine.defineIdentity({
    kind: 'verified-user', subject: 'alice', issuer: 'https://issuer.test',
    method: 'oidc-id-token', organizationId: organization.id,
  });
  for (let index = 0; index < 104; index += 1) {
    app.spine.memberships.grant({
      organizationId: organization.id,
      subject: `viewer-${index}`,
      role: 'viewer',
      reason: 'bounded pending count probe',
      identity: alice,
      mode: app.spine.mode,
    });
  }
  assert.equal(app.spine.auditIntents.listPending().length, 100);
  const receipt = app.spine.auditIntents.reconcile();
  assert.equal(receipt.attempted, 100);
  assert.equal(receipt.delivered, 0);
  assert.equal(receipt.failed, 100);
  assert.equal(receipt.failures.length, 100);
  assert.equal(receipt.pending, 105, 'pending is a count query, never the bounded page length');
});

test('explicit recovery refuses either caller-owned plane and leaves pending evidence untouched', (t) => {
  const app = fixture(t);
  const organization = app.spine.boundOrganization;
  app.database.raw.exec(`
    CREATE TRIGGER m2f_hold_recovery_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'hold recovery pending');
    END;
  `);
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  app.database.raw.exec('DROP TRIGGER m2f_hold_recovery_audit');

  assert.throws(
    () => app.database.transaction(() => app.spine.auditIntents.reconcile()),
    (error) => error.code === 'SPINE_AUDIT_DATA_TRANSACTION_ACTIVE',
  );
  assert.throws(
    () => app.controlPlaneDatabase.transaction(() => app.spine.auditIntents.reconcile()),
    (error) => error.code === 'SPINE_AUDIT_CONTROL_TRANSACTION_ACTIVE',
  );
  assert.equal(app.spine.auditIntents.listPending().length, 1);
  assert.equal(count(app.database, 'audit_events', "entity_type = 'spine_membership'"), 0);
});

test('two-process bootstrap race reads emptiness inside BEGIN IMMEDIATE and commits exactly one owner', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-bootstrap-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  const organizationId = initialized.spine.boundOrganization.id;
  initialized.close();

  const appUrl = new URL('../packages/app/src/index.js', import.meta.url).href;
  const childSource = `
    import { createAccordoApp } from ${JSON.stringify(appUrl)};
    const app = createAccordoApp({ spine: {
      mode: 'production', identityVerifier: () => {},
      tenant: { id: 'alpha', storageRoot: process.env.M2F_ROOT, provision: { name: 'Alpha' } },
    } });
    const wait = Math.max(0, Number(process.env.M2F_START) - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const result = app.spine.memberships.bootstrapOwner({
        organizationId: process.env.M2F_ORG, subject: process.env.M2F_SUBJECT,
      });
      console.log(JSON.stringify({ ok: true, id: result.id }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code }));
    } finally {
      app.close();
    }
  `;
  const start = String(Date.now() + 300);
  const runChild = (subject) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childSource], {
      env: {
        ...process.env,
        M2F_ROOT: root,
        M2F_START: start,
        M2F_ORG: organizationId,
        M2F_SUBJECT: subject,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
  const results = await Promise.all([runChild('alice'), runChild('bob')]);
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(results.filter(({ ok }) => !ok).map(({ code }) => code), ['CONFLICT']);

  const verified = createAccordoApp({ spine: spineConfig(root, 'alpha') });
  t.after(() => verified.close());
  assert.equal(verified.spine.memberships.listFor({ organizationId }).length, 1);
  assert.equal(count(verified.controlPlaneDatabase, 'spine_audit_intents', "entity_type = 'spine_membership'"), 1);
  assert.equal(count(verified.database, 'audit_events', "entity_type = 'spine_membership'"), 1);
});

test('HTTP preserves membership fields and adds the pending-audit receipt without leaking the fault', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-http-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = createAccordoApp({
    spine: {
      ...spineConfig(root, 'alpha'),
      identityVerifier: ({ headers }) => ({
        kind: 'verified-user',
        subject: headers['x-verified-subject'],
        issuer: 'https://issuer.test',
        method: 'oidc-id-token',
        organizationId: headers['x-verified-org'],
      }),
    },
  });
  const organization = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: organization.id, subject: 'alice' });
  app.database.raw.exec(`
    CREATE TRIGGER m2f_http_audit_fault
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'spine_membership'
    BEGIN
      SELECT RAISE(ABORT, 'credential-shaped internal sentinel');
    END;
  `);
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spine/memberships`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-verified-subject': 'alice',
      'x-verified-org': organization.id,
    },
    body: JSON.stringify({ subject: 'bob', role: 'viewer', reason: 'read only' }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(body).sort(), [...membershipKeys, 'auditDelivery'].sort());
  assert.deepEqual(body.auditDelivery, {
    status: 'committed_with_pending_audit',
    intentId: body.auditDelivery.intentId,
    code: 'SPINE_AUDIT_DELIVERY_FAILED',
  });
  assert.doesNotMatch(JSON.stringify(body), /credential-shaped internal sentinel/);
});
