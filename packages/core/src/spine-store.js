// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { ROLES, ROLE_BUNDLES, decideAuthorization } from './authorization.js';
import { identityString } from './identity.js';
import { normalizeActor } from './actor.js';
import { putAuditEventExact } from './audit.js';
import { spineStoreStorage } from './spine-store-storage-adapter.js';

/**
 * **Organizations and memberships (ADR-038).**
 *
 * ### An Organization is not a Company
 *
 * This is the distinction the whole milestone rests on, so it is stated in the
 * table names, here, in the schema block, in the Admin and in the docs:
 *
 * - a **CRM Company** is a customer, recorded *inside* one tenant's data;
 * - an **Accordo Organization** is the tenant — a customer *of the software*,
 *   whose people log in and whose data is isolated from every other tenant's.
 *
 * Blurring them would be catastrophic in a specific way: it would make it
 * natural to "grant someone access to a Company", and from there to leak one
 * tenant's customer list into another tenant's authorization model.
 *
 * ### No self-grant
 *
 * Membership administration is the one permission that can manufacture every
 * other permission, so it carries two extra rules that are not negotiable:
 *
 * 1. **Nobody can grant a permission they do not hold.** An administrator
 *    cannot mint an owner. Otherwise `admin.memberships.manage` is silently
 *    equivalent to every permission there is.
 * 2. **The last active administrator cannot demote or suspend themselves.** Not
 *    to protect them — to stop an organization becoming permanently
 *    unadministrable, which is a support incident nobody can fix from inside.
 */

export const MAX_ORG_NAME = 200;
export const MAX_REASON = 500;
export const SPINE_AUDIT_INTENT_CONTRACT = 1;
const DATA_PLANE_BINDING_SINGLETON = 1;
const MAX_RECONCILE = 100;
const MAX_AUDIT_DATA_BYTES = 4096;

/** Slugs are the operator-facing tenant handle: bounded, lowercase, no surprises. */
const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Preserve the released raw-SQLite list semantics behind the closed seam. */
function v1ListLimit(value, fallback, maximum) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric < 0) return undefined;
  return Math.min(numeric || fallback, maximum);
}

function auditIntentLimit(options) {
  let prototype;
  let keys;
  let limitDescriptor;
  try {
    if (options === null || typeof options !== 'object' || isProxy(options)) throw new Error('invalid');
    prototype = Object.getPrototypeOf(options);
    keys = Reflect.ownKeys(options);
    limitDescriptor = Object.getOwnPropertyDescriptor(options, 'limit');
  } catch {
    throw new AppError('Spine audit-intent options must be a plain options object', {
      code: 'SPINE_AUDIT_INTENT_OPTIONS_INVALID', status: 400,
    });
  }
  if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => key !== 'limit')
      || (keys.includes('limit')
        && (!limitDescriptor || !Object.prototype.hasOwnProperty.call(limitDescriptor, 'value')))) {
    throw new AppError('Spine audit-intent options must be a plain object containing only limit', {
      code: 'SPINE_AUDIT_INTENT_OPTIONS_INVALID', status: 400,
    });
  }
  if (!keys.includes('limit')) return MAX_RECONCILE;
  const limit = limitDescriptor.value;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECONCILE) {
    throw new AppError('Spine audit-intent limit must be an integer from 1 through 100', {
      code: 'SPINE_AUDIT_INTENT_LIMIT_INVALID', status: 400,
    });
  }
  return limit;
}

/** The one organization a local-development project gets, when it gets one. */
export const LOCAL_ORGANIZATION_SLUG = 'local-development';

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError('spine audit data must be bounded plain data', { field: 'audit.data' });
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function newDataPlaneId() {
  return `dp_${randomUUID().replaceAll('-', '')}`;
}

function nextAuditRevision(value) {
  const current = Number(value);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new AppError('Spine audit revision is outside the positive safe-integer contract', {
      code: 'SPINE_AUDIT_REVISION_INVALID', status: 409,
    });
  }
  return current + 1;
}

/**
 * Create/verify the physical data-plane marker, then CAS the shared control
 * mapping before Organization resolution can mutate the control plane.
 *
 * Internal composition seam: it is deliberately not re-exported from the core
 * package. The marker contains no path, URL, credential or provider detail.
 *
 * @param {{
 *   database: any,
 *   dataPlane: any,
 *   tenantSlug: string,
 *   mayProvision: boolean,
 *   now?: () => string,
 *   newId?: () => string,
 * }} deps
 */
export function prepareSpineAuditBinding({
  database,
  dataPlane,
  tenantSlug,
  mayProvision,
  now = () => new Date().toISOString(),
  newId = newDataPlaneId,
}) {
  const slug = identityString(tenantSlug, 'tenant.slug', { required: true, max: 63 });
  if (!SLUG_RE.test(/** @type {string} */ (slug))) {
    throw new ValidationError('tenant.slug is not a canonical tenant slug', { field: 'tenant.slug' });
  }
  const existingOrganization = database.storage.sync.maybeOne({
    kind: 'select', table: 'spine_organizations', columns: ['id'],
    where: [{ column: 'slug', op: 'eq', value: slug }], limit: 1,
  });
  if (!existingOrganization && mayProvision !== true) {
    throw new AppError(
      'the bound tenant has no Organization in the control plane. This instance will not serve a '
      + 'tenant it cannot resolve, and it will not create one implicitly: provision the organization '
      + 'first, or configure explicit provisioning for this deployment',
      { code: 'SPINE_BOUND_TENANT_UNKNOWN', status: 500, details: { mode: 'production' } },
    );
  }
  // The physical data plane mints its opaque identity first. Reading a shared
  // mapping and copying its id into an empty file would make two distinct files
  // look like one authoritative plane — exactly the alias this marker prevents.
  const binding = dataPlane.storage.sync.transaction(() => {
    const marker = dataPlane.storage.sync.maybeOne({
      kind: 'select', table: 'spine_data_plane_binding', columns: '*',
      where: [{ column: 'singleton', op: 'eq', value: DATA_PLANE_BINDING_SINGLETON }], limit: 1,
    });
    if (!marker) {
      const dataPlaneId = identityString(newId(), 'dataPlaneId', { required: true, max: 200 });
      dataPlane.storage.sync.execute({
        kind: 'insert', table: 'spine_data_plane_binding', values: [
          { column: 'singleton', value: DATA_PLANE_BINDING_SINGLETON },
          { column: 'tenant_slug', value: slug },
          { column: 'data_plane_id', value: dataPlaneId },
          { column: 'created_at', value: now() },
        ],
      });
      return Object.freeze({ tenantSlug: slug, dataPlaneId });
    }
    if (marker.tenant_slug !== slug) {
      throw new AppError(
        'The selected data plane is not the one assigned to this tenant binding',
        { code: 'SPINE_DATA_PLANE_BINDING_MISMATCH', status: 409 },
      );
    }
    return Object.freeze({ tenantSlug: marker.tenant_slug, dataPlaneId: marker.data_plane_id });
  });

  return database.storage.sync.transaction(() => {
    const existing = database.storage.sync.maybeOne({
      kind: 'select', table: 'spine_tenant_bindings', columns: '*',
      where: [{ column: 'tenant_slug', op: 'eq', value: slug }], limit: 1,
    });
    if (!existing) {
      database.storage.sync.execute({
        kind: 'insert', table: 'spine_tenant_bindings', values: [
          { column: 'tenant_slug', value: binding.tenantSlug },
          { column: 'data_plane_id', value: binding.dataPlaneId },
          { column: 'created_at', value: now() },
        ],
      });
      return binding;
    }
    if (existing.data_plane_id === null) {
      const claimed = database.storage.sync.execute({
        kind: 'update', table: 'spine_tenant_bindings',
        values: [{ column: 'data_plane_id', value: binding.dataPlaneId }],
        where: [
          { column: 'tenant_slug', op: 'eq', value: slug },
          { column: 'data_plane_id', op: 'is-null' },
        ],
      });
      if (claimed.affectedRows === 1) return binding;
      const raced = database.storage.sync.maybeOne({
        kind: 'select', table: 'spine_tenant_bindings', columns: '*',
        where: [{ column: 'tenant_slug', op: 'eq', value: slug }], limit: 1,
      });
      if (raced?.data_plane_id === binding.dataPlaneId) return binding;
      throw new AppError(
        'A different data plane won the first claim for this tenant binding',
        { code: 'SPINE_DATA_PLANE_BINDING_CONFLICT', status: 409 },
      );
    }
    if (existing.data_plane_id !== binding.dataPlaneId) {
      throw new AppError(
        'A different data plane is already assigned to this tenant binding',
        { code: 'SPINE_DATA_PLANE_BINDING_CONFLICT', status: 409 },
      );
    }
    return binding;
  });
}

function mapBinding(row) {
  return Object.freeze({ tenantSlug: row.tenant_slug, dataPlaneId: row.data_plane_id });
}

/**
 * The released synchronous v1 store. Its dependency shape and its observable
 * audit behaviour stay unchanged while the raw prepares move behind Storage
 * Contract v1.
 *
 * @param {{database: any, audit?: any, now?: () => string}} deps
 */
export function createSpineStore({ database, audit, now = () => new Date().toISOString() }) {
  return createSpineStoreImplementation({ database, audit, now, recovery: null });
}

/**
 * Deep-internal application composition for recoverable cross-plane audit.
 * Deliberately not re-exported by `packages/core/index.js`.
 *
 * @param {{
 *   database: any,
 *   dataPlane: any,
 *   dataPlaneBinding: {tenantSlug: string, dataPlaneId: string},
 *   now?: () => string,
 *   newId?: () => string,
 * }} deps
 */
export function createRecoverableSpineStore({
  database,
  dataPlane,
  dataPlaneBinding,
  now = () => new Date().toISOString(),
  newId = () => randomUUID().replaceAll('-', '').slice(0, 24),
}) {
  return createSpineStoreImplementation({
    database,
    audit: null,
    now,
    newId,
    recovery: { dataPlane, dataPlaneBinding },
  });
}

/** @param {any} deps */
function createSpineStoreImplementation({
  database,
  audit,
  now,
  newId = () => randomUUID().replaceAll('-', '').slice(0, 24),
  recovery,
}) {
  const storage = spineStoreStorage(database);
  const dataPlane = recovery?.dataPlane ?? null;
  const dataPlaneBinding = recovery?.dataPlaneBinding ?? null;
  const dataStorage = dataPlane?.storage?.sync ?? null;

  const rowToOrganization = (row) => row && Object.freeze({
    id: row.id,
    slug: row.slug,
    name: row.name,
    provenance: row.provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const rowToMembership = (row) => row && Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    subject: row.subject,
    issuer: row.issuer,
    role: row.role,
    status: row.status,
    grantedBySubject: row.granted_by_subject,
    grantedReason: row.granted_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /** The permissions this membership actually carries, resolved from the bundle. */
    permissions: Object.freeze([...(ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (row.role)] ?? [])]),
  });

  const organizationRow = (id) => storage.maybeOne({
    kind: 'select', table: 'spine_organizations', columns: '*',
    where: [{ column: 'id', op: 'eq', value: id }], limit: 1,
  });

  const organizationRowBySlug = (slug) => storage.maybeOne({
    kind: 'select', table: 'spine_organizations', columns: '*',
    where: [{ column: 'slug', op: 'eq', value: slug }], limit: 1,
  });

  const membershipRow = (organizationId, subject) => storage.maybeOne({
    kind: 'select', table: 'spine_memberships', columns: '*',
    where: [
      { column: 'organization_id', op: 'eq', value: organizationId },
      { column: 'subject', op: 'eq', value: subject },
    ],
    limit: 1,
  });

  function ensureAuditDestination(tenantSlug) {
    if (!recovery) return Object.freeze({ tenantSlug, dataPlaneId: null });
    const existing = storage.maybeOne({
      kind: 'select', table: 'spine_tenant_bindings', columns: '*',
      where: [{ column: 'tenant_slug', op: 'eq', value: tenantSlug }], limit: 1,
    });
    if (!existing) {
      storage.execute({
        kind: 'insert', table: 'spine_tenant_bindings', values: [
          { column: 'tenant_slug', value: tenantSlug },
          { column: 'data_plane_id', value: null },
          { column: 'created_at', value: now() },
        ],
      });
      return Object.freeze({ tenantSlug, dataPlaneId: null });
    }
    if (tenantSlug === dataPlaneBinding.tenantSlug
      && existing.data_plane_id !== dataPlaneBinding.dataPlaneId) {
      throw new AppError('The control-plane tenant binding does not match this data plane', {
        code: 'SPINE_DATA_PLANE_BINDING_MISMATCH', status: 409,
      });
    }
    return mapBinding(existing);
  }

  function createAuditIntent({ binding, actor, action, entityType, entityId, data, revision, createdAt }) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new AppError('Spine audit revision is outside the positive safe-integer contract', {
        code: 'SPINE_AUDIT_REVISION_INVALID', status: 409,
      });
    }
    const normalizedActor = normalizeActor(actor);
    const dataJson = canonicalJson(data);
    if (Buffer.byteLength(dataJson, 'utf8') > MAX_AUDIT_DATA_BYTES) {
      throw new ValidationError('spine audit evidence exceeds its bounded size', { field: 'audit.data' });
    }
    // Identity says *which committed mutation* this is. Evidence is verified
    // separately, so changed bytes under the same entity revision refuse
    // instead of minting a second event that looks legitimate.
    const digest = createHash('sha256').update(canonicalJson({
      contract: SPINE_AUDIT_INTENT_CONTRACT,
      tenantSlug: binding.tenantSlug,
      entityType,
      entityId,
      revision,
    })).digest('hex');
    const payloadFingerprint = createHash('sha256').update(canonicalJson({
      actorType: normalizedActor.type,
      actorId: normalizedActor.id,
      action,
      data,
      createdAt,
    })).digest('hex');
    const item = Object.freeze({
      id: `sai_${digest}`,
      idempotencyKey: `spine-audit-v1:${digest}`,
      destinationTenantSlug: binding.tenantSlug,
      auditEventId: `spine_${digest}`,
      payloadFingerprint,
      actorType: normalizedActor.type,
      actorId: normalizedActor.id,
      action,
      entityType,
      entityId,
      dataJson,
      mutationRevision: revision,
      createdAt,
      deliveredAt: null,
    });
    const existing = storage.maybeOne({
      kind: 'select', table: 'spine_audit_intents', columns: '*', where: [
        { column: 'entity_type', op: 'eq', value: entityType },
        { column: 'entity_id', op: 'eq', value: entityId },
        { column: 'mutation_revision', op: 'eq', value: revision },
      ], limit: 1,
    });
    if (existing) {
      if (
        existing.id === item.id
        && existing.idempotency_key === item.idempotencyKey
        && existing.destination_tenant_slug === item.destinationTenantSlug
        && existing.audit_event_id === item.auditEventId
        && existing.payload_fingerprint === item.payloadFingerprint
      ) return mapIntent(existing);
      throw new AppError('A Spine audit intent revision already names different immutable evidence', {
        code: 'SPINE_AUDIT_INTENT_DIVERGENT', status: 409,
      });
    }
    storage.execute({
      kind: 'insert', table: 'spine_audit_intents', values: [
        { column: 'id', value: item.id },
        { column: 'idempotency_key', value: item.idempotencyKey },
        { column: 'destination_tenant_slug', value: item.destinationTenantSlug },
        { column: 'audit_event_id', value: item.auditEventId },
        { column: 'payload_fingerprint', value: item.payloadFingerprint },
        { column: 'actor_type', value: item.actorType },
        { column: 'actor_id', value: item.actorId },
        { column: 'action', value: item.action },
        { column: 'entity_type', value: item.entityType },
        { column: 'entity_id', value: item.entityId },
        { column: 'data_json', value: item.dataJson },
        { column: 'mutation_revision', value: item.mutationRevision },
        { column: 'created_at', value: item.createdAt },
        { column: 'delivered_at', value: null },
      ],
    });
    return item;
  }

  function mapIntent(row) {
    return Object.freeze({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      destinationTenantSlug: row.destination_tenant_slug,
      auditEventId: row.audit_event_id,
      payloadFingerprint: row.payload_fingerprint,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      dataJson: row.data_json,
      mutationRevision: Number(row.mutation_revision),
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    });
  }

  function intentRow(id) {
    return storage.maybeOne({
      kind: 'select', table: 'spine_audit_intents', columns: '*',
      where: [{ column: 'id', op: 'eq', value: id }], limit: 1,
    });
  }

  function runMutation(work) {
    if (!recovery) {
      const committed = work();
      audit?.record?.({
        actor: committed.event.actor,
        action: committed.event.action,
        entityType: committed.event.entityType,
        entityId: committed.event.entityId,
        data: committed.event.data,
      });
      return committed.entity;
    }
    assertNoCallerControlTransaction();
    assertNoCallerDataTransaction();
    const committed = storage.transaction(() => {
      const result = work();
      const intent = createAuditIntent({
        binding: result.binding,
        actor: result.event.actor,
        action: result.event.action,
        entityType: result.event.entityType,
        entityId: result.event.entityId,
        data: result.event.data,
        revision: result.event.revision,
        createdAt: result.event.createdAt,
      });
      return { entity: result.entity, intent };
    });
    return withDeliveryReceipt(committed.entity, committed.intent);
  }

  function assertCurrentDataPlaneMarker() {
    const marker = dataStorage.maybeOne({
      kind: 'select', table: 'spine_data_plane_binding', columns: '*',
      where: [{ column: 'singleton', op: 'eq', value: DATA_PLANE_BINDING_SINGLETON }], limit: 1,
    });
    if (!marker || marker.tenant_slug !== dataPlaneBinding.tenantSlug
      || marker.data_plane_id !== dataPlaneBinding.dataPlaneId) {
      throw new AppError('The tenant data-plane marker no longer matches this application binding', {
        code: 'SPINE_DATA_PLANE_BINDING_MISMATCH', status: 409,
      });
    }
  }

  function assertNoCallerControlTransaction() {
    if (database.storage.activeTransaction() !== null) {
      throw new AppError('Spine mutation and audit recovery require their own control transaction', {
        code: 'SPINE_AUDIT_CONTROL_TRANSACTION_ACTIVE', status: 409,
      });
    }
  }

  function assertNoCallerDataTransaction() {
    if (dataPlane.storage.activeTransaction() !== null) {
      throw new AppError('Spine audit delivery requires its own data transaction', {
        code: 'SPINE_AUDIT_DATA_TRANSACTION_ACTIVE', status: 409,
      });
    }
  }

  function verifiedIntent(row) {
    let data;
    try {
      data = JSON.parse(row.data_json);
    } catch {
      throw new AppError('A Spine audit intent contains divergent immutable evidence', {
        code: 'SPINE_AUDIT_INTENT_DIVERGENT', status: 409,
      });
    }
    const revision = Number(row.mutation_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new AppError('Spine audit revision is outside the positive safe-integer contract', {
        code: 'SPINE_AUDIT_REVISION_INVALID', status: 409,
      });
    }
    const digest = createHash('sha256').update(canonicalJson({
      contract: SPINE_AUDIT_INTENT_CONTRACT,
      tenantSlug: row.destination_tenant_slug,
      entityType: row.entity_type,
      entityId: row.entity_id,
      revision,
    })).digest('hex');
    const payloadFingerprint = createHash('sha256').update(canonicalJson({
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      data,
      createdAt: row.created_at,
    })).digest('hex');
    if (row.id !== `sai_${digest}`
      || row.idempotency_key !== `spine-audit-v1:${digest}`
      || row.audit_event_id !== `spine_${digest}`
      || row.payload_fingerprint !== payloadFingerprint) {
      throw new AppError('A Spine audit intent contains divergent immutable evidence', {
        code: 'SPINE_AUDIT_INTENT_DIVERGENT', status: 409,
      });
    }
    return Object.freeze({ ...mapIntent(row), data });
  }

  function readDeliveryEligibility(intentId) {
    return storage.transaction(() => {
      const row = intentRow(intentId);
      if (!row) {
        throw new AppError('The Spine audit intent does not exist', {
          code: 'SPINE_AUDIT_INTENT_NOT_FOUND', status: 404,
        });
      }
      const intent = verifiedIntent(row);
      if (intent.deliveredAt !== null) return Object.freeze({ status: 'already_delivered', intentId });
      const destination = storage.maybeOne({
        kind: 'select', table: 'spine_tenant_bindings', columns: '*',
        where: [{ column: 'tenant_slug', op: 'eq', value: intent.destinationTenantSlug }], limit: 1,
      });
      if (!destination || destination.data_plane_id === null
        || intent.destinationTenantSlug !== dataPlaneBinding.tenantSlug
        || destination.data_plane_id !== dataPlaneBinding.dataPlaneId) {
        return Object.freeze({ status: 'not_bound', intentId });
      }
      return Object.freeze({ status: 'eligible', intent });
    });
  }

  function deliverIntent(intentId) {
    assertNoCallerControlTransaction();
    assertNoCallerDataTransaction();
    try {
      // Fixed lock order: short control eligibility -> independently committed
      // data audit -> short control delivered CAS. Never hold one plane while
      // opening a write transaction on the other.
      const eligibility = readDeliveryEligibility(intentId);
      if (eligibility.status !== 'eligible') return eligibility;
      const intent = eligibility.intent;

      // The control eligibility transaction is already closed. This exact data
      // transaction therefore cannot deadlock against an opposite-order caller.
      dataStorage.transaction(() => {
        assertCurrentDataPlaneMarker();
        const recorded = putAuditEventExact(dataPlane, {
          id: intent.auditEventId,
          createdAt: intent.createdAt,
          actor: { type: intent.actorType, id: intent.actorId },
          action: intent.action,
          entityType: intent.entityType,
          entityId: intent.entityId,
          data: intent.data,
        });
        if (!recorded || recorded.id !== intent.auditEventId) {
          throw new AppError('The exact audit sink returned the wrong event', {
            code: 'SPINE_AUDIT_DELIVERY_INVALID_RESULT', status: 500,
          });
        }
      });

      // Only after the data transaction has independently committed do we
      // reopen the control plane for the one terminal CAS.
      return storage.transaction(() => {
        const currentRow = intentRow(intentId);
        if (!currentRow) {
          throw new AppError('The Spine audit intent does not exist', {
            code: 'SPINE_AUDIT_INTENT_NOT_FOUND', status: 404,
          });
        }
        const current = verifiedIntent(currentRow);
        if (current.deliveredAt !== null) return Object.freeze({ status: 'already_delivered', intentId });
        const destination = storage.maybeOne({
          kind: 'select', table: 'spine_tenant_bindings', columns: '*',
          where: [{ column: 'tenant_slug', op: 'eq', value: current.destinationTenantSlug }], limit: 1,
        });
        if (!destination || destination.data_plane_id === null
          || current.destinationTenantSlug !== dataPlaneBinding.tenantSlug
          || destination.data_plane_id !== dataPlaneBinding.dataPlaneId) {
          return Object.freeze({ status: 'not_bound', intentId });
        }
        const updated = storage.execute({
          kind: 'update', table: 'spine_audit_intents',
          values: [{ column: 'delivered_at', value: now() }],
          where: [
            { column: 'id', op: 'eq', value: intentId },
            { column: 'delivered_at', op: 'is-null' },
          ],
        });
        if (updated.affectedRows !== 1) {
          throw new AppError('The Spine audit intent did not make its one terminal transition', {
            code: 'SPINE_AUDIT_INTENT_TRANSITION_FAILED', status: 409,
          });
        }
        return Object.freeze({ status: 'delivered', intentId });
      });
    } catch (error) {
      if (error instanceof AppError && [
        'AUDIT_EVENT_DIVERGENT',
        'SPINE_DATA_PLANE_BINDING_MISMATCH',
        'SPINE_AUDIT_DATA_TRANSACTION_ACTIVE',
        'SPINE_AUDIT_CONTROL_TRANSACTION_ACTIVE',
        'SPINE_AUDIT_INTENT_NOT_FOUND',
        'SPINE_AUDIT_INTENT_DIVERGENT',
        'SPINE_AUDIT_REVISION_INVALID',
        'SPINE_AUDIT_INTENT_TRANSITION_FAILED',
        'SPINE_AUDIT_DELIVERY_INVALID_RESULT',
      ].includes(error.code)) throw error;
      throw new AppError(
        'Spine audit delivery failed; committed control-plane evidence remains pending for reconciliation',
        { code: 'SPINE_AUDIT_DELIVERY_FAILED', status: 503 },
      );
    }
  }

  function withDeliveryReceipt(entity, intent) {
    try {
      const result = deliverIntent(intent.id);
      if (result.status === 'delivered' || result.status === 'already_delivered') return entity;
      return pendingEntity(entity, intent.id, 'SPINE_AUDIT_DESTINATION_NOT_BOUND');
    } catch (error) {
      return pendingEntity(
        entity,
        intent.id,
        error instanceof AppError ? error.code : 'SPINE_AUDIT_DELIVERY_FAILED',
      );
    }
  }

  function pendingEntity(entity, intentId, code) {
    return Object.freeze({
      ...entity,
      auditDelivery: Object.freeze({
        status: 'committed_with_pending_audit',
        intentId,
        code,
      }),
    });
  }

  const organizations = {
    /** @param {{slug: string, name: string, provenance?: string}} input */
    create({ slug, name, provenance = 'operator-configured' }) {
      const cleanSlug = identityString(slug, 'organization.slug', { required: true, max: 63 });
      if (!SLUG_RE.test(/** @type {string} */ (cleanSlug))) {
        throw new ValidationError(
          'organization.slug must be lowercase letters, digits and hyphens, starting with a letter',
          { field: 'organization.slug' },
        );
      }
      const cleanName = identityString(name, 'organization.name', { required: true, max: MAX_ORG_NAME });
      if (!['operator-configured', 'local-development-migration'].includes(provenance)) {
        throw new ValidationError('organization.provenance is not one this framework records', {
          field: 'organization.provenance',
        });
      }
      return runMutation(() => {
        if (organizations.bySlug(cleanSlug)) {
          throw new ConflictError(`an organization with slug "${cleanSlug}" already exists`, {
            field: 'organization.slug',
          });
        }
        const stamp = now();
        const id = `org_${newId()}`;
        const binding = ensureAuditDestination(cleanSlug);
        storage.execute({
          kind: 'insert', table: 'spine_organizations', values: [
            { column: 'id', value: id },
            { column: 'slug', value: cleanSlug },
            { column: 'name', value: cleanName },
            { column: 'provenance', value: provenance },
            { column: 'created_at', value: stamp },
            { column: 'updated_at', value: stamp },
            { column: 'audit_revision', value: 1 },
          ],
        });
        return {
          entity: rowToOrganization(organizationRow(id)),
          binding,
          event: {
            actor: { type: 'system', id: 'spine' },
            action: 'created', entityType: 'spine_organization', entityId: id,
            data: { slug: cleanSlug, provenance }, revision: 1, createdAt: stamp,
          },
        };
      });
    },

    /** @param {string} id */
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      return rowToOrganization(organizationRow(id)) ?? null;
    },

    /** @param {string} slug */
    bySlug(slug) {
      if (typeof slug !== 'string' || slug === '') return null;
      return rowToOrganization(organizationRowBySlug(slug)) ?? null;
    },

    list({ limit = 100 } = {}) {
      const bounded = v1ListLimit(limit, 100, 500);
      return storage.many({
        kind: 'select', table: 'spine_organizations', columns: '*', where: [],
        orderBy: [{ column: 'created_at' }, { column: 'id' }],
        ...(bounded === undefined ? {} : { limit: bounded }),
      }).map(rowToOrganization);
    },
  };

  const memberships = {
    /**
     * The membership the authorizer asks about. Exact, indexed, tenant-scoped —
     * never a scan, and never "the first membership this subject has".
     *
     * @param {{organizationId: string, subject: string}} query
     */
    find({ organizationId, subject }) {
      if (typeof organizationId !== 'string' || typeof subject !== 'string') return null;
      if (organizationId === '' || subject === '') return null;
      return rowToMembership(membershipRow(organizationId, subject)) ?? null;
    },

    /** @param {{organizationId: string, limit?: number}} query */
    listFor({ organizationId, limit = 200 }) {
      if (typeof organizationId !== 'string' || organizationId === '') return [];
      const bounded = v1ListLimit(limit, 200, 500);
      return storage.many({
        kind: 'select', table: 'spine_memberships', columns: '*',
        where: [{ column: 'organization_id', op: 'eq', value: organizationId }],
        orderBy: [{ column: 'created_at' }, { column: 'id' }],
        ...(bounded === undefined ? {} : { limit: bounded }),
      }).map(rowToMembership);
    },

    /** Every organization one subject may act in — the Admin's tenant switcher. */
    listForSubject({ subject, limit = 100 }) {
      if (typeof subject !== 'string' || subject === '') return [];
      const bounded = v1ListLimit(limit, 100, 500);
      return storage.many({
        kind: 'select', table: 'spine_memberships', columns: '*',
        where: [
          { column: 'subject', op: 'eq', value: subject },
          { column: 'status', op: 'eq', value: 'active' },
        ],
        orderBy: [{ column: 'created_at' }, { column: 'id' }],
        ...(bounded === undefined ? {} : { limit: bounded }),
      }).map(rowToMembership);
    },

    /**
     * Grant or change a membership. Human-only, authorized, and never a
     * self-grant.
     *
     * @param {{
     *   organizationId: string, subject: string, role: string, issuer?: string|null,
     *   reason: string, identity: any, mode: any,
     * }} input
     */
    grant({ organizationId, subject, role, issuer = null, reason, identity, mode }) {
      if (!recovery && !organizations.get(organizationId)) {
        throw new NotFoundError('Organization', String(organizationId));
      }
      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      const cleanReason = identityString(reason, 'membership.reason', { required: true, max: MAX_REASON });
      const cleanIssuer = identityString(issuer, 'membership.issuer');
      if (typeof role !== 'string' || !ROLES.includes(role)) {
        throw new ValidationError(`membership.role must be one of ${ROLES.join(', ')}`, {
          field: 'membership.role',
        });
      }

      return runMutation(() => {
        const organizationRowValue = organizationRow(organizationId);
        if (!organizationRowValue) throw new NotFoundError('Organization', String(organizationId));
        const binding = ensureAuditDestination(organizationRowValue.slug);
        const actorMembership = identity?.subject
          ? memberships.find({ organizationId, subject: identity.subject })
          : null;
        const decision = decideAuthorization({
          identity, organizationId, permission: 'admin.memberships.manage',
          membership: actorMembership, mode,
        });
        if (!decision.allowed) {
          throw new AppError(decision.reason, {
            code: 'FORBIDDEN', status: 403,
            details: Object.freeze({ permission: 'admin.memberships.manage', reason: decision.code }),
          });
        }
        const granterPermissions = actorMembership?.permissions ?? [];
        const wanted = ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (role)] ?? [];
        const escalation = wanted.filter((permission) => !granterPermissions.includes(permission));
        if (escalation.length > 0) {
          throw new AppError(
            `this membership would carry ${escalation.join(', ')}, which the granter does not hold`,
            {
              code: 'ROLE_ESCALATION_REFUSED', status: 403,
              details: Object.freeze({ role, escalation: Object.freeze([...escalation]) }),
            },
          );
        }

        const existingRow = membershipRow(organizationId, cleanSubject);
        const existing = rowToMembership(existingRow);
        if (existing && identity.subject === cleanSubject) {
          const losing = existing.permissions.includes('admin.memberships.manage')
            && !wanted.includes('admin.memberships.manage');
          if (losing && memberships.countAdministrators(organizationId) <= 1) {
            throw new ConflictError(
              'this is the last active administrator of the organization; demoting yourself would '
              + 'leave nobody able to administer it',
              { field: 'membership.role' },
            );
          }
        }

        const stamp = now();
        if (existingRow) {
          const revision = nextAuditRevision(existingRow.audit_revision);
          storage.execute({
            kind: 'update', table: 'spine_memberships', values: [
              { column: 'role', value: role },
              { column: 'issuer', value: cleanIssuer ?? existingRow.issuer },
              { column: 'granted_by_subject', value: identity.subject ?? null },
              { column: 'granted_reason', value: cleanReason },
              { column: 'updated_at', value: stamp },
              { column: 'audit_revision', value: revision },
            ],
            where: [{ column: 'id', op: 'eq', value: existingRow.id }],
          });
          return {
            entity: rowToMembership(membershipRow(organizationId, cleanSubject)),
            binding,
            event: {
              actor: { type: 'user', id: identity.subject ?? 'unknown' },
              action: 'role_changed', entityType: 'spine_membership', entityId: existingRow.id,
              data: {
                organizationId, subject: cleanSubject, from: existing.role, to: role, reason: cleanReason,
              },
              revision, createdAt: stamp,
            },
          };
        }

        const id = `mem_${newId()}`;
        storage.execute({
          kind: 'insert', table: 'spine_memberships', values: [
            { column: 'id', value: id },
            { column: 'organization_id', value: organizationId },
            { column: 'subject', value: cleanSubject },
            { column: 'issuer', value: cleanIssuer },
            { column: 'role', value: role },
            { column: 'status', value: 'active' },
            { column: 'granted_by_subject', value: identity.subject ?? null },
            { column: 'granted_reason', value: cleanReason },
            { column: 'created_at', value: stamp },
            { column: 'updated_at', value: stamp },
            { column: 'audit_revision', value: 1 },
          ],
        });
        return {
          entity: rowToMembership(membershipRow(organizationId, cleanSubject)),
          binding,
          event: {
            actor: { type: 'user', id: identity.subject ?? 'unknown' },
            action: 'granted', entityType: 'spine_membership', entityId: id,
            data: { organizationId, subject: cleanSubject, role, reason: cleanReason },
            revision: 1, createdAt: stamp,
          },
        };
      });
    },

    /**
     * Suspend a membership. Same authorization, same last-administrator rule.
     *
     * @param {{organizationId: string, subject: string, reason: string, identity: any, mode: any}} input
     */
    suspend({ organizationId, subject, reason, identity, mode }) {
      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      const cleanReason = identityString(reason, 'membership.reason', { required: true, max: MAX_REASON });

      return runMutation(() => {
        let binding = Object.freeze({ tenantSlug: '', dataPlaneId: null });
        if (recovery) {
          const organizationRowValue = organizationRow(organizationId);
          if (!organizationRowValue) throw new NotFoundError('Organization', String(organizationId));
          binding = ensureAuditDestination(organizationRowValue.slug);
        }
        const actorMembership = identity?.subject
          ? memberships.find({ organizationId, subject: identity.subject })
          : null;
        const decision = decideAuthorization({
          identity, organizationId, permission: 'admin.memberships.manage',
          membership: actorMembership, mode,
        });
        if (!decision.allowed) {
          throw new AppError(decision.reason, {
            code: 'FORBIDDEN', status: 403,
            details: Object.freeze({ permission: 'admin.memberships.manage', reason: decision.code }),
          });
        }
        const existingRow = membershipRow(organizationId, cleanSubject);
        const existing = rowToMembership(existingRow);
        if (!existing) throw new NotFoundError('Membership', `${organizationId}/${cleanSubject}`);
        if (existing.permissions.includes('admin.memberships.manage')
          && memberships.countAdministrators(organizationId) <= 1) {
          throw new ConflictError(
            'this is the last active administrator of the organization; suspending it would leave '
            + 'nobody able to administer it',
            { field: 'membership.subject' },
          );
        }
        const stamp = now();
        const revision = nextAuditRevision(existingRow.audit_revision);
        storage.execute({
          kind: 'update', table: 'spine_memberships', values: [
            { column: 'status', value: 'suspended' },
            { column: 'granted_reason', value: cleanReason },
            { column: 'updated_at', value: stamp },
            { column: 'audit_revision', value: revision },
          ],
          where: [{ column: 'id', op: 'eq', value: existing.id }],
        });
        return {
          entity: rowToMembership(membershipRow(organizationId, cleanSubject)),
          binding,
          event: {
            actor: { type: 'user', id: identity.subject ?? 'unknown' },
            action: 'suspended', entityType: 'spine_membership', entityId: existing.id,
            data: { organizationId, subject: cleanSubject, reason: cleanReason },
            revision, createdAt: stamp,
          },
        };
      });
    },

    /** @param {string} organizationId */
    countAdministrators(organizationId) {
      const administering = ROLES.filter((role) =>
        (ROLE_BUNDLES[/** @type {keyof typeof ROLE_BUNDLES} */ (role)] ?? []).includes('admin.memberships.manage'));
      if (administering.length === 0) return 0;
      const row = storage.maybeOne({
        kind: 'count', table: 'spine_memberships', where: [
          { column: 'organization_id', op: 'eq', value: organizationId },
          { column: 'status', op: 'eq', value: 'active' },
          { column: 'role', op: 'in', values: administering },
        ],
      });
      return Number(row?.n ?? 0);
    },

    /**
     * The very first administrator of a new organization.
     *
     * Bootstrapping is the one case rule 1 cannot cover — an empty organization
     * has nobody to do the granting — so it is a separate, named method rather
     * than a special case hidden inside `grant()`, and it refuses to run on an
     * organization that already has members.
     *
     * @param {{organizationId: string, subject: string, issuer?: string|null, role?: string}} input
     */
    bootstrapOwner({ organizationId, subject, issuer = null, role = 'owner',
      reason = 'bootstrapped as the first member of a new organization' }) {
      let legacyOrganization = null;
      if (!recovery) {
        legacyOrganization = organizations.get(organizationId);
        if (!legacyOrganization) throw new NotFoundError('Organization', String(organizationId));
        if (memberships.listFor({ organizationId, limit: 1 }).length > 0) {
          throw new ConflictError(
            'this organization already has members, so it cannot be bootstrapped again',
            { field: 'organizationId' },
          );
        }
      }
      const cleanSubject = identityString(subject, 'membership.subject', { required: true });
      if (!ROLES.includes(role)) {
        throw new ValidationError(`membership.role must be one of ${ROLES.join(', ')}`, { field: 'membership.role' });
      }
      const cleanIssuer = identityString(issuer, 'membership.issuer');
      const cleanReason = identityString(reason, 'membership.reason', { required: true, max: MAX_REASON });
      return runMutation(() => {
        const organizationRowValue = recovery ? organizationRow(organizationId) : legacyOrganization;
        if (!organizationRowValue) throw new NotFoundError('Organization', String(organizationId));
        if (recovery && memberships.listFor({ organizationId, limit: 1 }).length > 0) {
          throw new ConflictError(
            'this organization already has members, so it cannot be bootstrapped again',
            { field: 'organizationId' },
          );
        }
        const stamp = now();
        const id = `mem_${newId()}`;
        const binding = ensureAuditDestination(organizationRowValue.slug);
        storage.execute({
          kind: 'insert', table: 'spine_memberships', values: [
            { column: 'id', value: id },
            { column: 'organization_id', value: organizationId },
            { column: 'subject', value: cleanSubject },
            { column: 'issuer', value: cleanIssuer },
            { column: 'role', value: role },
            { column: 'status', value: 'active' },
            { column: 'granted_by_subject', value: null },
            { column: 'granted_reason', value: cleanReason },
            { column: 'created_at', value: stamp },
            { column: 'updated_at', value: stamp },
            { column: 'audit_revision', value: 1 },
          ],
        });
        return {
          entity: rowToMembership(membershipRow(organizationId, cleanSubject)),
          binding,
          event: {
            actor: { type: 'system', id: 'spine' },
            action: 'bootstrapped', entityType: 'spine_membership', entityId: id,
            data: { organizationId, subject: cleanSubject, role },
            revision: 1, createdAt: stamp,
          },
        };
      });
    },
  };

  const auditIntents = Object.freeze({
    auditIntentContract: SPINE_AUDIT_INTENT_CONTRACT,
    listPending(options = {}) {
      const bounded = auditIntentLimit(options);
      return storage.many({
        kind: 'select', table: 'spine_audit_intents', columns: '*',
        where: [
          { column: 'destination_tenant_slug', op: 'eq', value: dataPlaneBinding.tenantSlug },
          { column: 'delivered_at', op: 'is-null' },
        ],
        orderBy: [{ column: 'created_at' }, { column: 'id' }], limit: bounded,
      }).map((row) => Object.freeze({
        intentId: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        createdAt: row.created_at,
      }));
    },

    reconcile(options = {}) {
      const limit = auditIntentLimit(options);
      assertNoCallerControlTransaction();
      assertNoCallerDataTransaction();
      const pending = auditIntents.listPending({ limit });
      let delivered = 0;
      const failures = [];
      for (const item of pending) {
        try {
          const result = deliverIntent(item.intentId);
          if (result.status === 'delivered' || result.status === 'already_delivered') delivered += 1;
          else failures.push(Object.freeze({
            intentId: item.intentId,
            code: 'SPINE_AUDIT_DESTINATION_NOT_BOUND',
          }));
        } catch (error) {
          failures.push(Object.freeze({
            intentId: item.intentId,
            code: error instanceof AppError ? error.code : 'SPINE_AUDIT_DELIVERY_FAILED',
          }));
        }
      }
      const pendingCount = storage.maybeOne({
        kind: 'count', table: 'spine_audit_intents', where: [
          { column: 'destination_tenant_slug', op: 'eq', value: dataPlaneBinding.tenantSlug },
          { column: 'delivered_at', op: 'is-null' },
        ],
      });
      return Object.freeze({
        auditIntentContract: SPINE_AUDIT_INTENT_CONTRACT,
        attempted: pending.length,
        delivered,
        failed: failures.length,
        failures: Object.freeze(failures),
        pending: Number(pendingCount?.n ?? 0),
      });
    },
  });

  return recovery
    ? Object.freeze({ organizations, memberships, auditIntents })
    : Object.freeze({ organizations, memberships });
}
