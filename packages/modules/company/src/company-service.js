// @ts-check

import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../../core/src/errors.js';
import { requiredString, optionalString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';
import { isSyncStorage, storageMany, storageMaybeOne, storageMutate } from '../../../core/src/storage-runtime.js';

export class CompanyService {
  /** @param {{database: any, audit: any, events: any}} dependencies */
  constructor({ database, audit, events }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
  }

  /** @param {{name: unknown, domain?: unknown}} input @param {{actor?: unknown}} [context] */
  async create(input, context = {}) {
    const timestamp = nowIso();
    const company = {
      id: randomUUID(),
      name: requiredString(input.name, 'name'),
      domain: optionalString(input.domain, 'domain')?.toLowerCase() ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const insert = {
      kind: 'insert', table: 'companies', values: [
        { column: 'id', value: company.id },
        { column: 'name', value: company.name },
        { column: 'domain', value: company.domain },
        { column: 'created_at', value: company.createdAt },
        { column: 'updated_at', value: company.updatedAt },
      ],
    };
    if (isSyncStorage(this.database)) {
      this.database.storage.sync.savepoint('company_create', () => {
        this.database.storage.sync.execute(insert);
        this.audit.record({
          actor: context.actor,
          action: 'company.created',
          entityType: 'company',
          entityId: company.id,
          data: company,
        });
      });
    } else {
      await storageMutate(this.database, 'company_create', async (tx) => {
        await tx.execute(insert);
        await this.audit.record({
          actor: context.actor,
          action: 'company.created',
          entityType: 'company',
          entityId: company.id,
          data: company,
        }, tx);
      });
    }
    await this.events.emit('company.created', company);
    return company;
  }

  /** @param {string} id */
  get(id) {
    return storageMaybeOne(this.database, {
      kind: 'select', table: 'companies', columns: '*', where: [{ column: 'id', op: 'eq', value: id }],
    }, (row) => {
      if (!row) throw new NotFoundError('Company', id);
      return mapCompanyRow(row);
    });
  }

  /** @param {{limit?: number}} [filters] */
  list(filters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return storageMany(this.database, {
      kind: 'select', table: 'companies', columns: '*',
      orderBy: [{ column: 'created_at', direction: 'desc' }], limit,
    }, mapCompanyRow);
  }
}

/** @param {any} row */
function mapCompanyRow(row) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
