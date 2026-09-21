// @ts-check

import { NotFoundError } from '../../../core/src/errors.js';
import { requiredString, optionalString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';
import { isSyncStorage, storageMany, storageMaybeOne, storageMutate } from '../../../core/src/storage-runtime.js';
import { nextWriteId } from '../../../core/src/write-ids.js';
import { runIdempotentWrite, usesWriteOutcomes } from '../../../core/src/write-outcome-runtime.js';

export class CompanyService {
  /** @param {{database: any, audit: any, events: any}} dependencies */
  constructor({ database, audit, events }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
  }

  /**
   * @param {{name: unknown, domain?: unknown}} input
   * @param {{actor?: unknown, identity?: any, idempotencyKey?: string, tenantId?: string}} [context]
   */
  async create(input, context = {}) {
    const name = requiredString(input.name, 'name');
    const domain = optionalString(input.domain, 'domain')?.toLowerCase() ?? null;
    const insertFor = (company) => ({
      kind: 'insert', table: 'companies', values: [
        { column: 'id', value: company.id },
        { column: 'name', value: company.name },
        { column: 'domain', value: company.domain },
        { column: 'created_at', value: company.createdAt },
        { column: 'updated_at', value: company.updatedAt },
      ],
    });
    const auditFor = (company, handle) => this.audit.record({
      actor: context.actor,
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      data: company,
    }, handle);

    if (isSyncStorage(this.database)) {
      const timestamp = nowIso();
      const company = {
        id: nextWriteId('record'),
        name,
        domain,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.database.storage.sync.savepoint('company_create', () => {
        this.database.storage.sync.execute(insertFor(company));
        auditFor(company);
      });
      await this.events.emit('company.created', company);
      return company;
    }

    if (usesWriteOutcomes(this.database)) {
      const outcome = await runIdempotentWrite(this.database, this.events, {
        tenantId: context.tenantId ?? this.database.tenantId,
        idempotencyKey: context.idempotencyKey,
        identity: context.identity,
        actor: context.actor,
        operation: 'company.create',
        target: '',
        contractVersion: 'write.v1',
        input: { name, domain },
      }, async ({ emit }) => {
        const timestamp = nowIso();
        const company = {
          id: nextWriteId('record'),
          name,
          domain,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await storageMutate(this.database, 'company_create', async (tx) => {
          await tx.execute(insertFor(company));
          await auditFor(company, tx);
        });
        await emit('company.created', company);
        return company;
      });
      const company = outcome.result;
      Object.defineProperty(company, 'idempotencyKey', { value: outcome.idempotencyKey, enumerable: false });
      Object.defineProperty(company, 'runId', { value: outcome.runId, enumerable: false });
      Object.defineProperty(company, 'replayed', { value: outcome.replayed, enumerable: false });
      return company;
    }

    const timestamp = nowIso();
    const company = {
      id: nextWriteId('record'),
      name,
      domain,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await storageMutate(this.database, 'company_create', async (tx) => {
      await tx.execute(insertFor(company));
      await auditFor(company, tx);
    });
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
