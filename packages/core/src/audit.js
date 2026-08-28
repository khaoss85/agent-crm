// @ts-check

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeActor } from './actor.js';
import { AppError } from './errors.js';
import { nowIso } from './time.js';

export class AuditLog {
  /** @param {import('./database.js').AccordoDatabase} database */
  constructor(database) {
    this.database = database;
  }

  /**
   * @param {{actor?: unknown, action: string, entityType: string, entityId: string, data?: unknown}} event
   */
  record(event) {
    const actor = normalizeActor(event.actor);
    const item = {
      id: randomUUID(),
      actorType: actor.type,
      actorId: actor.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      data: event.data ?? {},
      createdAt: nowIso(),
    };
    this.database.storage.sync.execute({
      kind: 'insert', table: 'audit_events', values: [
        { column: 'id', value: item.id },
        { column: 'actor_type', value: item.actorType },
        { column: 'actor_id', value: item.actorId },
        { column: 'action', value: item.action },
        { column: 'entity_type', value: item.entityType },
        { column: 'entity_id', value: item.entityId },
        { column: 'data_json', value: JSON.stringify(item.data) },
        { column: 'created_at', value: item.createdAt },
      ],
    });
    return item;
  }

  /** @param {{limit?: number, entityType?: string, entityId?: string}} [filters] */
  list(filters = {}) {
    const where = [];
    if (filters.entityType) {
      where.push({ column: 'entity_type', op: 'eq', value: filters.entityType });
    }
    if (filters.entityId) {
      where.push({ column: 'entity_id', op: 'eq', value: filters.entityId });
    }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const rows = this.database.storage.sync.many({
      kind: 'select', table: 'audit_events', columns: '*', where,
      orderBy: [{ column: 'created_at', direction: 'desc' }], limit,
    });
    return rows.map(mapAuditRow);
  }
}

/**
 * Deep-internal, exact-id audit insertion for the Spine recovery path.
 *
 * Deliberately not re-exported from `packages/core/index.js`: ordinary callers
 * keep the historical `AuditLog.record()` contract where identity and time are
 * owned by the framework. Only a committed cross-plane intent may supply them.
 *
 * @param {import('./database.js').AccordoDatabase} database
 * @param {{
 *   id: string,
 *   createdAt: string,
 *   actor?: unknown,
 *   action: string,
 *   entityType: string,
 *   entityId: string,
 *   data?: unknown,
 * }} event
 */
export function putAuditEventExact(database, event) {
  const actor = normalizeActor(event.actor);
  const item = {
    id: event.id,
    actorType: actor.type,
    actorId: actor.id,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    data: event.data ?? {},
    createdAt: event.createdAt,
  };
  if (typeof item.id !== 'string' || item.id === '' || item.id.length > 200
    || typeof item.createdAt !== 'string' || item.createdAt === '') {
    throw new AppError('Audit identity is invalid', {
      code: 'AUDIT_EVENT_INVALID', status: 500,
    });
  }

  const existing = auditById(database, item.id);
  if (existing) return assertSameAudit(existing, item);
  try {
    database.storage.sync.execute({
      kind: 'insert', table: 'audit_events', values: [
        { column: 'id', value: item.id },
        { column: 'actor_type', value: item.actorType },
        { column: 'actor_id', value: item.actorId },
        { column: 'action', value: item.action },
        { column: 'entity_type', value: item.entityType },
        { column: 'entity_id', value: item.entityId },
        { column: 'data_json', value: JSON.stringify(item.data) },
        { column: 'created_at', value: item.createdAt },
      ],
    });
    return item;
  } catch (error) {
    const raced = auditById(database, item.id);
    if (raced) return assertSameAudit(raced, item);
    throw error;
  }
}

/** @param {import('./database.js').AccordoDatabase} database @param {string} id */
function auditById(database, id) {
  const row = database.storage.sync.maybeOne({
    kind: 'select', table: 'audit_events', columns: '*',
    where: [{ column: 'id', op: 'eq', value: id }], limit: 1,
  });
  return row ? mapAuditRow(row) : null;
}

function assertSameAudit(existing, wanted) {
  if (
    existing.id === wanted.id
    && existing.actorType === wanted.actorType
    && existing.actorId === wanted.actorId
    && existing.action === wanted.action
    && existing.entityType === wanted.entityType
    && existing.entityId === wanted.entityId
    && existing.createdAt === wanted.createdAt
    && isDeepStrictEqual(existing.data, wanted.data)
  ) return existing;

  throw new AppError('An audit event id already names different immutable evidence', {
    code: 'AUDIT_EVENT_DIVERGENT', status: 409,
  });
}

/** @param {any} row */
function mapAuditRow(row) {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    data: JSON.parse(row.data_json),
    createdAt: row.created_at,
  };
}
