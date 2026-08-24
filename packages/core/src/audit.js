// @ts-check

import { randomUUID } from 'node:crypto';
import { normalizeActor } from './actor.js';
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
