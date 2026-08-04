// @ts-check

import { randomUUID } from 'node:crypto';
import { normalizeActor } from './actor.js';
import { nowIso } from './time.js';

export class AuditLog {
  /** @param {import('./database.js').AgentCrmDatabase} database */
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
    this.database.raw.prepare(`
      INSERT INTO audit_events(
        id, actor_type, actor_id, action, entity_type, entity_id, data_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.actorType,
      item.actorId,
      item.action,
      item.entityType,
      item.entityId,
      JSON.stringify(item.data),
      item.createdAt,
    );
    return item;
  }

  /** @param {{limit?: number, entityType?: string, entityId?: string}} [filters] */
  list(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.entityType) {
      clauses.push('entity_type = ?');
      params.push(filters.entityType);
    }
    if (filters.entityId) {
      clauses.push('entity_id = ?');
      params.push(filters.entityId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const rows = this.database.raw.prepare(`
      SELECT * FROM audit_events ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit);
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
