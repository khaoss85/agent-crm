// @ts-check

/**
 * Runtime record modules from manifests — the async composition's missing seam.
 *
 * The code generator (`packages/cli/src/module-factory.js`) turns a manifest
 * into checked-in source; the synchronous factory walks that registry. The
 * async factory cannot walk checked-in source for packages it composes by
 * selection, so it builds the same module at runtime from the same manifest.
 * Semantics mirror the generated service method by method (validation,
 * managed write policy, audit, events, UNIQUE mapping); storage goes through
 * `storage-runtime.js` so sync SQLite and async PostgreSQL both work.
 *
 * Services are class instances because the portable facade closes over
 * prototype methods; the three capability shapes (read-only, managed-mixed,
 * plain) are three classes, exactly like the three codegen branches, so a
 * method that must not exist (public `create` on a read-only record) does
 * not exist rather than throwing.
 *
 * What this file deliberately does NOT do (fail closed, follow-up logged in
 * the ExecPlan): manifests with `reference` fields are refused. None of the
 * customer-data / work / intelligence manifests use them; the metadata shape
 * for reference targets is a codegen concern this runtime does not re-decide.
 */

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { validateGeneratedModuleDefinition } from './generated-module-contract.js';
import {
  CORE_RESERVED_TABLES,
  generateModuleMigration,
  validateModuleManifest,
} from './module-manifest.js';
import { generatePostgresModuleBootstrap } from './module-evolution.js';
import {
  isSyncStorage,
  storageApi,
  storageMany,
  storageMaybeOne,
  storageMutate,
} from './storage-runtime.js';
import { nowIso } from './time.js';
import {
  enumValue,
  optionalBoolean,
  optionalEmail,
  optionalEnum,
  optionalInteger,
  optionalIsoDate,
  optionalString,
  requiredBoolean,
  requiredEmail,
  requiredInteger,
  requiredIsoDate,
  requiredString,
} from './validation.js';

/** @type {Record<string, {required: Function, optional: Function}>} */
const FIELD_VALIDATORS = {
  string: { required: requiredString, optional: optionalString },
  email: { required: requiredEmail, optional: optionalEmail },
  integer: { required: requiredInteger, optional: optionalInteger },
  boolean: { required: requiredBoolean, optional: optionalBoolean },
  timestamp: { required: requiredIsoDate, optional: optionalIsoDate },
};

/**
 * @param {any} field
 * @param {unknown} value
 * @param {any} references
 */
function validateFieldValue(field, value, references) {
  if (field.type === 'reference') {
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new ValidationError(`${field.name} is required`, { field: field.name });
      return null;
    }
    if (!references || typeof references.assertTarget !== 'function') {
      throw new ValidationError(`${field.name} cannot be validated: no reference resolver`, { field: field.name });
    }
    return references.assertTarget(field.references, value, field.name);
  }
  if (field.type === 'enum') {
    const allowed = field.values ?? [];
    return field.required
      ? enumValue(value, allowed, field.name)
      : optionalEnum(value, allowed, field.name);
  }
  const validators = FIELD_VALIDATORS[field.type];
  if (!validators) {
    throw new ValidationError(`Unsupported field type "${field.type}" for field "${field.name}"`, { field: field.name });
  }
  return (field.required ? validators.required : validators.optional)(value, field.name);
}

/**
 * @param {any} field
 * @param {unknown} value
 */
function toDbValue(field, value) {
  if (value === null || value === undefined) return null;
  if (field.type === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * @param {any} manifest
 * @param {any} row
 */
function mapRow(manifest, row) {
  const entity = { id: row.id };
  for (const field of manifest.fields) {
    const raw = row[field.column];
    entity[field.name] = field.type === 'boolean' ? (raw === null ? null : raw === 1) : raw;
  }
  entity.createdAt = row.created_at;
  entity.updatedAt = row.updated_at;
  return entity;
}

/**
 * @param {any} manifest
 * @param {Record<string, unknown>} [filters]
 */
function whereFor(manifest, filters = {}) {
  const columns = { id: 'id' };
  for (const field of manifest.fields) columns[field.name] = field.column;
  const predicates = [];
  for (const [field, value] of Object.entries(filters ?? {})) {
    if (!Object.hasOwn(columns, field)) {
      throw new ValidationError(`Unknown filter field: ${field}`, { field });
    }
    const column = columns[field];
    if (value === null) {
      predicates.push({ column, op: 'is-null' });
    } else if (Array.isArray(value)) {
      if (value.length === 0) throw new ValidationError(`Filter array for ${field} must not be empty`, { field });
      predicates.push({ column, op: 'in', values: value.map((item) => (typeof item === 'boolean' ? (item ? 1 : 0) : item)) });
    } else {
      predicates.push({ column, op: 'eq', value: typeof value === 'boolean' ? (value ? 1 : 0) : value });
    }
  }
  return predicates;
}

/**
 * @param {unknown} error
 */
function isUniqueViolation(error) {
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  // node-postgres surfaces the SQLSTATE on the error object.
  if (error !== null && typeof error === 'object' && /** @type {any} */ (error).code === '23505') return true;
  return false;
}

/**
 * @param {any} manifest
 * @param {Record<string, unknown>} source
 * @param {boolean} managed
 * @param {any} references
 */
function buildEntity(manifest, source, managed, references) {
  const timestamp = nowIso();
  const entity = { id: randomUUID(), createdAt: timestamp, updatedAt: timestamp };
  for (const field of manifest.fields) {
    if (field.writable === 'managed' && (!managed || !Object.hasOwn(source, field.name))) {
      entity[field.name] = field.default !== undefined ? field.default : null;
      continue;
    }
    entity[field.name] = validateFieldValue(field, source[field.name], references);
  }
  return entity;
}

/**
 * @param {any} manifest
 * @param {Record<string, unknown>} entity
 */
function insertValues(manifest, entity) {
  return [
    { column: 'id', value: entity.id },
    ...manifest.fields.map((field) => ({ column: field.column, value: toDbValue(field, entity[field.name]) })),
    { column: 'created_at', value: entity.createdAt },
    { column: 'updated_at', value: entity.updatedAt },
  ];
}

/**
 * @param {any} manifest
 * @param {Record<string, unknown>} input
 */
function rejectManagedInput(manifest, input) {
  for (const field of manifest.fields) {
    if (field.writable === 'managed' && input && Object.hasOwn(input, field.name)) {
      throw new ValidationError(`${field.name} is managed by a workflow action and cannot be set directly`, { field: field.name });
    }
  }
}

/**
 * @param {any} manifest
 * @param {Record<string, unknown>} patch
 * @param {any} references
 */
function managedAssignments(manifest, patch, references) {
  const assignments = [];
  const changes = {};
  for (const field of manifest.fields) {
    if (field.writable !== 'managed' || !Object.hasOwn(patch, field.name)) continue;
    let value;
    if (!field.required && patch[field.name] === null) {
      value = null;
    } else {
      // applyManaged validates with the required variant (null-clearing is
      // handled above), mirroring the codegen's managed branches.
      value = validateFieldValue({ ...field, required: true }, patch[field.name], references);
    }
    assignments.push({ column: field.column, value: toDbValue(field, value) });
    changes[field.name] = value;
  }
  return { assignments, changes };
}

/**
 * Trusted in-process managed update, shared by the read-only service (all
 * fields managed) and the mixed service. Never a capability, never HTTP:
 * `customer-data/src/store.js` `trusted()` defines the read-only managed
 * record contract as createManaged/applyManaged in-process writes plus
 * get/list reads — the codegen template simply never needed the update half
 * for user modules, while the framework's own packages do.
 * @param {RecordServiceBase} service
 */
async function applyManagedImpl(service, id, patch, context = {}) {
  const manifest = service.manifest;
  await service.get(id);
  const { assignments, changes } = managedAssignments(manifest, patch, service.references);
  if (assignments.length === 0) return service.get(id);
  assignments.push({ column: 'updated_at', value: nowIso() });
  const manifestName = manifest.name;
  const auditBase = { actor: context.actor, entityType: manifestName, entityId: id, data: changes };
  let updated;
  if (isSyncStorage(service.database)) {
    const api = service.database.storage.sync;
    updated = service.mutationSync(() => {
      api.execute({
        kind: 'update', table: manifest.table, values: assignments,
        where: [{ column: 'id', op: 'eq', value: id }],
      });
      const current = service.get(id);
      service.audit.record({ ...auditBase, action: `${manifestName}.updated` });
      return current;
    });
  } else {
    updated = await service.mutationAsync(async (storage) => {
      await storage.execute({
        kind: 'update', table: manifest.table, values: assignments,
        where: [{ column: 'id', op: 'eq', value: id }],
      });
      const row = await storage.maybeOne({
        kind: 'select', table: manifest.table, columns: '*',
        where: [{ column: 'id', op: 'eq', value: id }],
      });
      if (!row) throw new NotFoundError(service.pascal, id);
      await service.audit.record({ ...auditBase, action: `${manifestName}.updated` }, storage);
      return mapRow(manifest, row);
    });
  }
  await service.events.emit(`${manifestName}.updated`, updated);
  return updated;
}

class RecordServiceBase {
  /** @param {{manifest: any, database: any, audit: any, events: any, references?: any}} dependencies */
  constructor({ manifest, database, audit, events, references }) {
    this.manifest = manifest;
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.references = references;
    this.savepointName = `${manifest.name.replaceAll('-', '_')}_mutation`;
    this.pascal = manifest.name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    const uniqueFields = manifest.fields.filter((field) => field.unique);
    this.conflictMessage = uniqueFields.length
      ? `A ${manifest.name} with the same ${uniqueFields.map((field) => field.name).join(' or ')} already exists`
      : `A ${manifest.name} violates a unique constraint`;
  }

  /** Runs the data write and its audit record in one atomic unit. */
  mutationSync(fn) {
    try {
      return this.database.storage.sync.savepoint(this.savepointName, fn);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(this.conflictMessage);
      throw error;
    }
  }

  /** @param {(storage: any) => Promise<any>} fn */
  async mutationAsync(fn) {
    return storageMutate(this.database, this.savepointName, async (storage) => {
      try {
        return await fn(storage);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError(this.conflictMessage);
        throw error;
      }
    });
  }

  /** @param {string} id */
  get(id) {
    const statement = {
      kind: 'select', table: this.manifest.table, columns: '*',
      where: [{ column: 'id', op: 'eq', value: id }],
    };
    const mapped = (row) => {
      if (!row) throw new NotFoundError(this.pascal, id);
      return mapRow(this.manifest, row);
    };
    if (isSyncStorage(this.database)) {
      return mapped(this.database.storage.sync.maybeOne(statement));
    }
    return storageMaybeOne(this.database, statement, mapped);
  }

  /** @param {{limit?: number, where?: Record<string, unknown>}} [filters] */
  list(filters = {}) {
    const requested = Number.isInteger(filters.limit) ? filters.limit : 100;
    const limit = Math.min(Math.max(requested, 1), 500);
    const statement = {
      kind: 'select', table: this.manifest.table, columns: '*', where: whereFor(this.manifest, filters.where ?? {}),
      orderBy: [{ column: 'created_at', direction: 'desc' }, { column: 'id', direction: 'asc' }], limit,
    };
    const map = (row) => mapRow(this.manifest, row);
    if (isSyncStorage(this.database)) return this.database.storage.sync.many(statement).map(map);
    return storageMany(this.database, statement, map);
  }

  /** @param {Record<string, unknown>} [filters] */
  listWhere(filters = {}) {
    const statement = {
      kind: 'select', table: this.manifest.table, columns: '*', where: whereFor(this.manifest, filters),
      orderBy: [{ column: 'created_at', direction: 'desc' }, { column: 'id', direction: 'asc' }],
    };
    const map = (row) => mapRow(this.manifest, row);
    if (isSyncStorage(this.database)) return this.database.storage.sync.many(statement).map(map);
    return storageMany(this.database, statement, map);
  }

  /** @param {Record<string, unknown>} [filters] */
  countWhere(filters = {}) {
    const statement = { kind: 'count', table: this.manifest.table, where: whereFor(this.manifest, filters) };
    const map = (row) => Number(row.n);
    if (isSyncStorage(this.database)) return map(this.database.storage.sync.maybeOne(statement));
    return storageMaybeOne(this.database, statement, map);
  }
}

/**
 * Read-only record (every field managed, ADR-015): no public create. Records
 * exist only via trusted in-process action code through createManaged.
 */
class ReadOnlyRecordService extends RecordServiceBase {
  /** @param {Record<string, unknown>} patch @param {{actor?: unknown}} [context] */
  async createManaged(patch, context = {}) {
    const entity = buildEntity(this.manifest, patch, true, this.references);
    const manifest = this.manifest;
    const auditEvent = {
      actor: context.actor, action: `${manifest.name}.created`,
      entityType: manifest.name, entityId: entity.id, data: entity,
    };
    if (isSyncStorage(this.database)) {
      const api = this.database.storage.sync;
      this.mutationSync(() => {
        api.execute({ kind: 'insert', table: manifest.table, values: insertValues(manifest, entity) });
        this.audit.record(auditEvent);
      });
    } else {
      await this.mutationAsync(async (storage) => {
        await storage.execute({ kind: 'insert', table: manifest.table, values: insertValues(manifest, entity) });
        await this.audit.record(auditEvent, storage);
      });
    }
    await this.events.emit(`${manifest.name}.created`, entity);
    return entity;
  }

  /** @param {string} id @param {Record<string, unknown>} patch @param {{actor?: unknown}} [context] */
  async applyManaged(id, patch, context = {}) {
    return applyManagedImpl(this, id, patch, context);
  }
}

class WritableRecordService extends RecordServiceBase {
  /** @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async create(input, context = {}) {
    const manifest = this.manifest;
    if (manifest.fields.some((field) => field.writable === 'managed')) {
      rejectManagedInput(manifest, input);
    }
    const entity = buildEntity(manifest, input, false, this.references);
    const auditEvent = {
      actor: context.actor, action: `${manifest.name}.created`,
      entityType: manifest.name, entityId: entity.id, data: entity,
    };
    if (isSyncStorage(this.database)) {
      const api = this.database.storage.sync;
      this.mutationSync(() => {
        api.execute({ kind: 'insert', table: manifest.table, values: insertValues(manifest, entity) });
        this.audit.record(auditEvent);
      });
    } else {
      await this.mutationAsync(async (storage) => {
        await storage.execute({ kind: 'insert', table: manifest.table, values: insertValues(manifest, entity) });
        await this.audit.record(auditEvent, storage);
      });
    }
    await this.events.emit(`${manifest.name}.created`, entity);
    return entity;
  }

  /** @param {string} id @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async update(id, input, context = {}) {
    const manifest = this.manifest;
    if (manifest.fields.some((field) => field.writable === 'managed')) {
      rejectManagedInput(manifest, input);
    }
    await this.get(id);
    const assignments = [];
    const changes = {};
    for (const field of manifest.fields) {
      if (field.writable === 'managed' || !Object.hasOwn(input, field.name)) continue;
      const value = validateFieldValue(field, input[field.name], this.references);
      assignments.push({ column: field.column, value: toDbValue(field, value) });
      changes[field.name] = value;
    }
    if (assignments.length === 0) return this.get(id);
    assignments.push({ column: 'updated_at', value: nowIso() });
    const manifestName = manifest.name;
    const auditBase = { actor: context.actor, entityType: manifestName, entityId: id, data: changes };
    let updated;
    if (isSyncStorage(this.database)) {
      const api = this.database.storage.sync;
      updated = this.mutationSync(() => {
        api.execute({
          kind: 'update', table: manifest.table, values: assignments,
          where: [{ column: 'id', op: 'eq', value: id }],
        });
        const current = this.get(id);
        this.audit.record({ ...auditBase, action: `${manifestName}.updated` });
        return current;
      });
    } else {
      const self = this;
      updated = await this.mutationAsync(async (storage) => {
        await storage.execute({
          kind: 'update', table: manifest.table, values: assignments,
          where: [{ column: 'id', op: 'eq', value: id }],
        });
        const row = await storage.maybeOne({
          kind: 'select', table: manifest.table, columns: '*',
          where: [{ column: 'id', op: 'eq', value: id }],
        });
        if (!row) throw new NotFoundError(self.pascal, id);
        await self.audit.record({ ...auditBase, action: `${manifestName}.updated` }, storage);
        return mapRow(manifest, row);
      });
    }
    await this.events.emit(`${manifestName}.updated`, updated);
    return updated;
  }
}

/** Writable record with workflow-managed fields: adds the internal applyManaged path. */
class ManagedRecordService extends WritableRecordService {
  /** @param {string} id @param {Record<string, unknown>} patch @param {{actor?: unknown}} [context] */
  async applyManaged(id, patch, context = {}) {
    return applyManagedImpl(this, id, patch, context);
  }
}

/**
 * Build a validated, registry-ready record module from a manifest object.
 * The manifest is data (parsed JSON); nothing is imported, generated or
 * written. Throws closed on anything the codegen would refuse.
 *
 * @param {unknown} manifestInput
 * @param {{database: any, audit: any, events: any, references?: any}} dependencies
 */
export function createRecordModuleFromManifest(manifestInput, { database, audit, events, references }) {
  const manifest = validateModuleManifest(manifestInput);
  if (manifest.name === 'generated') {
    throw new ValidationError('"generated" is reserved for the module registry; choose another module name');
  }
  if (CORE_RESERVED_TABLES.has(manifest.table)) {
    throw new ValidationError(
      `Module "${manifest.name}" claims core table "${manifest.table}"; generated modules must not run on the core schema`,
      { field: manifest.table },
    );
  }
  if (manifest.fields.some((field) => field.type === 'reference')) {
    throw new ValidationError(
      `Module "${manifest.name}" declares reference fields, which the runtime constructor does not build yet; generate the module with module:create instead`,
      { field: manifest.name },
    );
  }

  const managedFields = manifest.fields.filter((field) => field.writable === 'managed');
  const publicFields = manifest.fields.filter((field) => field.writable !== 'managed');
  const hasManaged = managedFields.length > 0;
  const isReadOnly = hasManaged && publicFields.length === 0;
  const service = isReadOnly
    ? new ReadOnlyRecordService({ manifest, database, audit, events, references })
    : hasManaged
      ? new ManagedRecordService({ manifest, database, audit, events, references })
      : new WritableRecordService({ manifest, database, audit, events, references });

  const capabilities = isReadOnly ? ['get', 'list'] : ['create', 'get', 'list', 'update'];
  // Same definition shape the codegen emits: the registry, schema() and the
  // generic module surface read description/entities/filterableFields.
  const definition = {
    name: manifest.name,
    version: '0.1.0',
    description: manifest.description ?? `Generated ${manifest.name} module.`,
    kind: 'generated',
    manifestVersion: manifest.manifestVersion ?? 1,
    table: manifest.table,
    capabilities: Object.freeze([...capabilities]),
    filterableFields: Object.freeze([
      'id',
      ...manifest.fields.filter((field) => field.index === true || field.unique === true).map((field) => field.name),
    ]),
    fields: Object.freeze(manifest.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      unique: field.unique,
      writable: field.writable,
      ...(field.values ? { values: field.values } : {}),
    }))),
    references: Object.freeze([]),
    immutableFields: Object.freeze(['id', 'createdAt', 'updatedAt']),
    entities: [
      {
        name: manifest.name,
        fields: ['id', ...manifest.fields.map((field) => field.name), 'createdAt', 'updatedAt'],
      },
    ],
    service,
  };
  return validateGeneratedModuleDefinition(definition);
}

/**
 * The `{name, sql}` migrations a set of record manifests needs, in a stable
 * order. SQLite DDL (`generateModuleMigration`).
 *
 * @param {Array<{name: string, manifest: unknown}>} entries
 */
export function recordModuleMigrations(entries) {
  return entries.map(({ manifest }) => {
    const migration = generateModuleMigration(manifest);
    return { name: migration.migrationName, sql: migration.sql };
  });
}

/**
 * The PostgreSQL rendering of the same set, computed from the manifest — never
 * translated from the SQLite string. Names are stable (`pg_bootstrap_<table>`)
 * so the bootstrap checksum ledger treats a recomposition as the same DDL.
 *
 * @param {Array<{name: string, manifest: unknown}>} entries
 */
export function postgresRecordModuleMigrations(entries) {
  return entries.map(({ manifest }) => {
    const migration = generatePostgresModuleBootstrap(manifest);
    return { name: migration.name, sql: migration.sql };
  });
}
