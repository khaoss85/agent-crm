// @ts-check

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../../core/src/errors.js';
import { requiredString, requiredEmail, optionalString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';

export class ContactService {
  /** @param {{database: any, audit: any, events: any, companies: any}} dependencies */
  constructor({ database, audit, events, companies }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.companies = companies;
  }

  /**
   * @param {{companyId: unknown, firstName: unknown, lastName: unknown, email: unknown, role?: unknown}} input
   * @param {{actor?: unknown}} [context]
   */
  async create(input, context = {}) {
    const companyId = requiredString(input.companyId, 'companyId');
    this.companies.get(companyId);
    const timestamp = nowIso();
    const contact = {
      id: randomUUID(),
      companyId,
      firstName: requiredString(input.firstName, 'firstName'),
      lastName: requiredString(input.lastName, 'lastName'),
      email: requiredEmail(input.email),
      role: optionalString(input.role, 'role'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      this.database.raw.prepare(`
        INSERT INTO contacts(
          id, company_id, first_name, last_name, email, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contact.id,
        contact.companyId,
        contact.firstName,
        contact.lastName,
        contact.email,
        contact.role,
        contact.createdAt,
        contact.updatedAt,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(`A contact already uses ${contact.email}`, { email: contact.email });
      }
      throw error;
    }

    this.audit.record({
      actor: context.actor,
      action: 'contact.created',
      entityType: 'contact',
      entityId: contact.id,
      data: contact,
    });
    await this.events.emit('contact.created', contact);
    return contact;
  }

  /** @param {string} id */
  get(id) {
    const row = this.database.raw.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Contact', id);
    return mapContactRow(row);
  }

  /** @param {{companyId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.companyId) {
      return this.database.raw.prepare(`
        SELECT * FROM contacts WHERE company_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(filters.companyId, limit).map(mapContactRow);
    }
    return this.database.raw.prepare(`
      SELECT * FROM contacts ORDER BY created_at DESC LIMIT ?
    `).all(limit).map(mapContactRow);
  }
}

/** @param {any} row */
function mapContactRow(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
