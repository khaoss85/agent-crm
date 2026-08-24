// @ts-check

import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../../core/src/errors.js';
import { requiredString, optionalString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';

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

    await this.database.storage.execute({
      kind: 'insert', table: 'companies', values: [
        { column: 'id', value: company.id },
        { column: 'name', value: company.name },
        { column: 'domain', value: company.domain },
        { column: 'created_at', value: company.createdAt },
        { column: 'updated_at', value: company.updatedAt },
      ],
    });

    this.audit.record({
      actor: context.actor,
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      data: company,
    });
    await this.events.emit('company.created', company);
    return company;
  }

  /** @param {string} id */
  get(id) {
    const row = this.database.storage.sync.maybeOne({
      kind: 'select', table: 'companies', columns: '*', where: [{ column: 'id', op: 'eq', value: id }],
    });
    if (!row) throw new NotFoundError('Company', id);
    return mapCompanyRow(row);
  }

  /** @param {{limit?: number}} [filters] */
  list(filters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.storage.sync.many({
      kind: 'select', table: 'companies', columns: '*',
      orderBy: [{ column: 'created_at', direction: 'desc' }], limit,
    }).map(mapCompanyRow);
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
