// @ts-check

import { NotFoundError, ValidationError } from '../../../core/src/errors.js';
import { requiredString, optionalString, optionalBoolean } from '../../../core/src/validation.js';
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
   * @param {{name: unknown, domain?: unknown, placeholder?: unknown}} input
   * @param {{actor?: unknown, identity?: any, idempotencyKey?: string, tenantId?: string, allowPlaceholder?: boolean}} [context]
   */
  async create(input, context = {}) {
    const name = requiredString(input.name, 'name');
    const domain = optionalString(input.domain, 'domain')?.toLowerCase() ?? null;
    // The «no company» flag (backlog:ac65e448fcb4, review giro 2 P1): only
    // the trusted internal placeholder path (the customer-data sender via
    // the core adapters, carrying `allowPlaceholder`) may set it. Every
    // other caller gets a real company, whatever it sends — the public
    // POST /api/companies refuses the key with a 400 before it reaches
    // here, so a records.write caller can never hide a company. Readers
    // never match the name, so a real company keeps false whatever its
    // name is.
    const placeholder = context?.allowPlaceholder === true
      ? (optionalBoolean(input.placeholder, 'placeholder') ?? false)
      : false;
    const insertFor = (company) => ({
      kind: 'insert', table: 'companies', values: [
        { column: 'id', value: company.id },
        { column: 'name', value: company.name },
        { column: 'domain', value: company.domain },
        { column: 'placeholder', value: company.placeholder ? 1 : 0 },
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
        placeholder,
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
        input: { name, domain, placeholder },
      }, async ({ emit }) => {
        const timestamp = nowIso();
        const company = {
          id: nextWriteId('record'),
          name,
          domain,
          placeholder,
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
      placeholder,
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

  /**
   * Rewrite a company's name, domain or placeholder flag
   * (backlog:d271d723, GDPR erasure; backlog:ac65e448fcb4, V11 recovery).
   * In-process only — no HTTP route reaches it: the customer-data erasure
   * anonymizes an erased company through here instead of leaving its name
   * readable, and a V11-misflagged row is unflagged through here (the one
   * recovery path for the one-time name repair, which no public write can
   * use to hide a company). The write names only the columns the patch
   * supplies, and the update and its audit row commit together, like the
   * contact update.
   * @param {string} id
   * @param {{name?: unknown, domain?: unknown, placeholder?: unknown}} patch
   * @param {{actor?: unknown}} [context]
   */
  async update(id, patch, context = {}) {
    const current = await this.get(id);
    if (!patch || typeof patch !== 'object') {
      throw new ValidationError('a company update needs at least one field', { field: 'patch' });
    }
    const values = [];
    const next = { ...current };
    if (patch.name !== undefined) {
      next.name = requiredString(patch.name, 'name');
      values.push({ column: 'name', value: next.name });
    }
    if (patch.domain !== undefined) {
      next.domain = optionalString(patch.domain, 'domain')?.toLowerCase() ?? null;
      values.push({ column: 'domain', value: next.domain });
    }
    if (patch.placeholder !== undefined) {
      next.placeholder = optionalBoolean(patch.placeholder, 'placeholder') ?? false;
      values.push({ column: 'placeholder', value: next.placeholder ? 1 : 0 });
    }
    if (values.length === 0) {
      throw new ValidationError('a company update needs at least one of name, domain, placeholder', { field: 'patch' });
    }
    next.updatedAt = nowIso();
    values.push({ column: 'updated_at', value: next.updatedAt });
    const write = {
      kind: 'update', table: 'companies', values,
      where: [{ column: 'id', op: 'eq', value: id }],
    };
    const entry = {
      actor: context.actor,
      action: 'company.updated',
      entityType: 'company',
      entityId: id,
      data: next,
    };
    if (isSyncStorage(this.database)) {
      const sync = this.database.storage.sync;
      sync.savepoint('company_update', () => {
        sync.execute(write);
        this.audit.record(entry, sync);
      });
    } else {
      await storageMutate(this.database, 'company_update', async (tx) => {
        await tx.execute(write);
        await this.audit.record(entry, tx);
      });
    }
    const reread = await this.get(id);
    await this.events.emit('company.updated', reread);
    return reread;
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

  /**
   * A bounded search scan (backlog:d128847d21fc): newest first like
   * `list`, but with a larger fixed ceiling (SCAN_MAX_ROWS) for a caller
   * that filters in memory and must reach past the display page — the
   * customer search. Not reachable over HTTP: the route keeps `list` and
   * its 500 cap.
   * @param {{limit?: number}} [options]
   */
  scan(options = {}) {
    const requested = Number.isInteger(options.limit) ? options.limit : SCAN_MAX_ROWS;
    const limit = Math.min(Math.max(requested, 1), SCAN_MAX_ROWS);
    return storageMany(this.database, {
      kind: 'select', table: 'companies', columns: '*',
      orderBy: [{ column: 'created_at', direction: 'desc' }], limit,
    }, mapCompanyRow);
  }
}

/** The ceiling of one search scan: a fixed bound, never the whole table. */
export const SCAN_MAX_ROWS = 5000;

/** @param {any} row */
function mapCompanyRow(row) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    // The «no company» flag (backlog:ac65e448fcb4): every reader keys on
    // this, never on the name — a real company keeps false whatever its
    // name is. SQLite stores 0/1, other callers may carry a boolean.
    placeholder: row.placeholder === true || row.placeholder === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
