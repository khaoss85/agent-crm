// @ts-check

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../../core/src/errors.js';
import { requiredString, requiredEmail, optionalString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';
import { isSyncStorage, storageMany, storageMaybeOne, storageMutate } from '../../../core/src/storage-runtime.js';

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
    await Promise.resolve(this.companies.get(companyId));
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

    const insert = { kind: 'insert', table: 'contacts', values: contactValues(contact) };
    try {
      if (isSyncStorage(this.database)) {
        this.database.storage.sync.execute(insert);
        this.audit.record({
          actor: context.actor,
          action: 'contact.created',
          entityType: 'contact',
          entityId: contact.id,
          data: contact,
        });
      } else {
        await storageMutate(this.database, 'contact_create', async (tx) => {
          await tx.execute(insert);
          await this.audit.record({
            actor: context.actor,
            action: 'contact.created',
            entityType: 'contact',
            entityId: contact.id,
            data: contact,
          }, tx);
        });
      }
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ConflictError(`A contact already uses ${contact.email}`, { email: contact.email });
      }
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(`A contact already uses ${contact.email}`, { email: contact.email });
      }
      throw error;
    }
    await this.events.emit('contact.created', contact);
    return contact;
  }

  /**
   * Voce 714433c2: the scheda cliente edits Dettagli in place. A partial
   * patch — only the keys present are touched, and at least one editable key
   * must be present. Email stays unique like in create: a taken address
   * refuses with ConflictError, never a silent duplicate.
   *
   * @param {string} id
   * @param {{firstName?: unknown, lastName?: unknown, email?: unknown, role?: unknown}} patch
   * @param {{actor?: unknown}} [context]
   */
  async update(id, patch, context = {}) {
    const current = await this.get(id);
    if (!patch || typeof patch !== 'object') {
      throw new ValidationError('a contact update needs at least one field', { field: 'patch' });
    }
    // The write names only the columns the patch supplies (plus updatedAt):
    // two concurrent partial updates touch disjoint columns instead of
    // replaying each other's stale snapshot (lost update). The merged copy
    // below feeds the audit payload only, never the write.
    const values = [];
    const next = { ...current };
    if (patch.firstName !== undefined) {
      next.firstName = requiredString(patch.firstName, 'firstName');
      values.push({ column: 'first_name', value: next.firstName });
    }
    if (patch.lastName !== undefined) {
      next.lastName = requiredString(patch.lastName, 'lastName');
      values.push({ column: 'last_name', value: next.lastName });
    }
    if (patch.email !== undefined) {
      next.email = requiredEmail(patch.email);
      values.push({ column: 'email', value: next.email });
    }
    if (patch.role !== undefined) {
      next.role = optionalString(patch.role, 'role');
      values.push({ column: 'role', value: next.role });
    }
    if (values.length === 0) {
      throw new ValidationError('a contact update needs at least one of firstName, lastName, email, role', { field: 'patch' });
    }
    next.updatedAt = nowIso();
    values.push({ column: 'updated_at', value: next.updatedAt });
    const write = {
      kind: 'update', table: 'contacts',
      values,
      where: [{ column: 'id', op: 'eq', value: id }],
    };
    const entry = {
      actor: context.actor,
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      data: next,
    };
    try {
      // The update and its audit row commit together. On sync storage the
      // callback stays fully synchronous inside the savepoint (a sync
      // savepoint releases as soon as an async callback returns, so no
      // await may sit between the two writes); on async storage the same
      // unit runs as one transaction. A refused audit rolls the update
      // back instead of leaving an unaudited write behind.
      if (isSyncStorage(this.database)) {
        const sync = this.database.storage.sync;
        sync.savepoint('contact_update', () => {
          sync.execute(write);
          this.audit.record(entry, sync);
        });
      } else {
        await storageMutate(this.database, 'contact_update', async (tx) => {
          await tx.execute(write);
          await this.audit.record(entry, tx);
        });
      }
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ConflictError(`A contact already uses ${next.email}`, { email: next.email });
      }
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(`A contact already uses ${next.email}`, { email: next.email });
      }
      throw error;
    }
    const reread = await this.get(id);
    await this.events.emit('contact.updated', reread);
    return reread;
  }

  /** @param {string} id */
  get(id) {
    return storageMaybeOne(this.database, {
      kind: 'select', table: 'contacts', columns: '*', where: [{ column: 'id', op: 'eq', value: id }],
    }, (row) => {
      if (!row) throw new NotFoundError('Contact', id);
      return mapContactRow(row);
    });
  }

  /** @param {{companyId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const where = filters.companyId
      ? [{ column: 'company_id', op: 'eq', value: filters.companyId }]
      : [];
    return storageMany(this.database, {
      kind: 'select', table: 'contacts', columns: '*', where,
      orderBy: [{ column: 'created_at', direction: 'desc' }], limit,
    }, mapContactRow);
  }
}

/** @param {any} contact */
function contactValues(contact) {
  return [
    ['id', contact.id], ['company_id', contact.companyId], ['first_name', contact.firstName],
    ['last_name', contact.lastName], ['email', contact.email], ['role', contact.role],
    ['created_at', contact.createdAt], ['updated_at', contact.updatedAt],
  ].map(([column, value]) => ({ column, value }));
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
