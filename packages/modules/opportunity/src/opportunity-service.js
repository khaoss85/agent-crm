// @ts-check

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../../core/src/errors.js';
import {
  enumValue,
  nonNegativeInteger,
  optionalIsoDate,
  optionalString,
  requiredIsoDate,
  requiredString,
} from '../../../core/src/validation.js';
import { OPPORTUNITY_STAGES, OPPORTUNITY_TYPES } from '../../../core/src/schema.js';
import { nowIso } from '../../../core/src/time.js';
import { isSyncStorage, storageMany, storageMaybeOne, storageMutate } from '../../../core/src/storage-runtime.js';

const ALLOWED_TRANSITIONS = Object.freeze({
  discovery: ['qualification', 'lost'],
  qualification: ['proposal', 'approval_pending', 'lost'],
  proposal: ['approval_pending', 'negotiation', 'won', 'lost'],
  approval_pending: ['proposal', 'qualification', 'lost'],
  negotiation: ['proposal', 'won', 'lost'],
  won: [],
  lost: ['discovery'],
});

// Pipeline state (migration v3, ADR-014) is server-managed: never accepted
// from public create input, written only through applyManaged below.
const PIPELINE_MANAGED_FIELDS = Object.freeze([
  'pipelineKey',
  'pipelineStage',
  'stageEnteredAt',
  'closedAt',
  'closeReason',
]);

export class OpportunityService {
  /** @param {{database: any, audit: any, events: any, companies: any, contacts: any}} dependencies */
  constructor({ database, audit, events, companies, contacts }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.companies = companies;
    this.contacts = contacts;
  }

  /** @param {Record<string, unknown>} input */
  #rejectManagedInput(input) {
    for (const name of PIPELINE_MANAGED_FIELDS) {
      if (input && Object.hasOwn(input, name)) {
        throw new ValidationError(`${name} is managed by the pipeline runtime and cannot be set directly`, { field: name });
      }
    }
  }

  /**
   * In-process write path for pipeline-managed fields (mirrors the generated
   * modules' applyManaged boundary): validates only the managed keys, writes
   * them with audit + event inside a savepoint, and is never routed over HTTP.
   * Stage-set membership is the pipeline runtime's job; this method enforces
   * shape (strings/timestamps or null).
   *
   * @param {string} id @param {Record<string, unknown>} patch @param {{actor?: unknown}} [context]
   */
  async applyManaged(id, patch, context = {}) {
    await Promise.resolve(this.get(id));
    /** @type {{column: string, value: unknown}[]} */
    const values = [];
    /** @type {Record<string, unknown>} */
    const changes = {};
    const columns = {
      pipelineKey: 'pipeline_key',
      pipelineStage: 'pipeline_stage',
      stageEnteredAt: 'stage_entered_at',
      closedAt: 'closed_at',
      closeReason: 'close_reason',
    };
    for (const [field, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, field)) continue;
      const raw = patch[field];
      let value;
      if (raw === null) {
        value = null;
      } else if (field === 'stageEnteredAt' || field === 'closedAt') {
        value = requiredIsoDate(raw, field);
      } else {
        value = requiredString(raw, field);
      }
      values.push({ column, value });
      changes[field] = value;
    }
    if (!values.length) return Promise.resolve(this.get(id));
    values.push({ column: 'updated_at', value: nowIso() });

    const write = {
      kind: 'update', table: 'opportunities', values,
      where: [{ column: 'id', op: 'eq', value: id }],
    };
    let updated;
    if (isSyncStorage(this.database)) {
      updated = this.database.storage.sync.savepoint('opportunity_managed', () => {
        this.database.storage.sync.execute(write);
        const next = this.get(id);
        this.audit.record({
          actor: context.actor,
          action: 'opportunity.updated',
          entityType: 'opportunity',
          entityId: id,
          data: changes,
        });
        return next;
      });
    } else {
      await storageMutate(this.database, 'opportunity_managed', async (tx) => {
        await tx.execute(write);
        await this.audit.record({
          actor: context.actor,
          action: 'opportunity.updated',
          entityType: 'opportunity',
          entityId: id,
          data: changes,
        }, tx);
      });
      updated = await this.get(id);
    }
    await this.events.emit('opportunity.updated', updated);
    return updated;
  }

  /**
   * @param {{companyId: unknown, contactId?: unknown, name: unknown, type?: unknown, valueCents: unknown, currency?: unknown, stage?: unknown, owner: unknown, expectedCloseDate?: unknown, sourceKey?: unknown}} input
   * @param {{actor?: unknown}} [context]
   */
  async create(input, context = {}) {
    this.#rejectManagedInput(input);
    const companyId = requiredString(input.companyId, 'companyId');
    await Promise.resolve(this.companies.get(companyId));
    const contactId = optionalString(input.contactId, 'contactId');
    if (contactId) {
      const contact = await Promise.resolve(this.contacts.get(contactId));
      if (contact.companyId !== companyId) {
        throw new ValidationError('contactId must belong to companyId', { contactId, companyId });
      }
    }
    const timestamp = nowIso();
    const opportunity = {
      id: randomUUID(),
      companyId,
      contactId,
      name: requiredString(input.name, 'name'),
      type: enumValue(input.type ?? 'new_business', [...OPPORTUNITY_TYPES], 'type'),
      valueCents: nonNegativeInteger(input.valueCents, 'valueCents'),
      currency: requiredString(input.currency ?? 'EUR', 'currency').toUpperCase(),
      stage: enumValue(input.stage ?? 'qualification', [...OPPORTUNITY_STAGES], 'stage'),
      owner: requiredString(input.owner, 'owner'),
      expectedCloseDate: optionalIsoDate(input.expectedCloseDate, 'expectedCloseDate'),
      // Deterministic origin key for workflow/action-created opportunities
      // (e.g. 'lead-conversion:<leadId>'); a partial UNIQUE index makes a
      // duplicate origin impossible at the database layer.
      sourceKey: optionalString(input.sourceKey, 'sourceKey'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const insert = { kind: 'insert', table: 'opportunities', values: opportunityValues(opportunity) };
    try {
      if (isSyncStorage(this.database)) {
        this.database.storage.sync.execute(insert);
        this.audit.record({
          actor: context.actor,
          action: 'opportunity.created',
          entityType: 'opportunity',
          entityId: opportunity.id,
          data: opportunity,
        });
      } else {
        await storageMutate(this.database, 'opportunity_create', async (tx) => {
          await tx.execute(insert);
          await this.audit.record({
            actor: context.actor,
            action: 'opportunity.created',
            entityType: 'opportunity',
            entityId: opportunity.id,
            data: opportunity,
          }, tx);
        });
      }
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ConflictError(`An opportunity already exists for source ${opportunity.sourceKey}`, {
          sourceKey: opportunity.sourceKey,
        });
      }
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(`An opportunity already exists for source ${opportunity.sourceKey}`, {
          sourceKey: opportunity.sourceKey,
        });
      }
      throw error;
    }
    await this.events.emit('opportunity.created', opportunity);
    return opportunity;
  }

  /** @param {string} id */
  get(id) {
    return storageMaybeOne(this.database, {
      kind: 'select', table: 'opportunities', columns: '*', where: [{ column: 'id', op: 'eq', value: id }],
    }, (row) => {
      if (!row) throw new NotFoundError('Opportunity', id);
      return this.#mapRow(row);
    });
  }

  /** @param {{stage?: string, type?: string, companyId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const where = [];
    if (filters.stage) {
      enumValue(filters.stage, [...OPPORTUNITY_STAGES], 'stage');
      where.push({ column: 'stage', op: 'eq', value: filters.stage });
    }
    if (filters.type) {
      enumValue(filters.type, [...OPPORTUNITY_TYPES], 'type');
      where.push({ column: 'type', op: 'eq', value: filters.type });
    }
    if (filters.companyId) {
      where.push({ column: 'company_id', op: 'eq', value: filters.companyId });
    }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return storageMany(this.database, {
      kind: 'select', table: 'opportunities', columns: '*', where,
      orderBy: [{ column: 'updated_at', direction: 'desc' }], limit,
    }, (row) => this.#mapRow(row));
  }

  /**
   * Internal state mutation. Call from a named workflow, not directly from API/MCP.
   * @param {string} id
   * @param {string} targetStage
   * @param {{actor?: unknown, workflowRunId?: string, bypassTransitionCheck?: boolean}} [context]
   */
  async setStage(id, targetStage, context = {}) {
    const opportunity = await Promise.resolve(this.get(id));
    const stage = enumValue(targetStage, [...OPPORTUNITY_STAGES], 'targetStage');
    if (opportunity.stage === stage) return opportunity;
    const allowed = ALLOWED_TRANSITIONS[opportunity.stage] ?? [];
    if (!context.bypassTransitionCheck && !allowed.includes(stage)) {
      throw new ValidationError(`Invalid stage transition: ${opportunity.stage} → ${stage}`, {
        from: opportunity.stage,
        to: stage,
        allowed,
      });
    }
    const updatedAt = nowIso();
    const write = {
      kind: 'update', table: 'opportunities', values: [
        { column: 'stage', value: stage }, { column: 'updated_at', value: updatedAt },
      ], where: [{ column: 'id', op: 'eq', value: id }],
    };
    if (isSyncStorage(this.database)) this.database.storage.sync.execute(write);
    else await storageMutate(this.database, 'opportunity_stage', async (tx) => { await tx.execute(write); });
    const updated = await Promise.resolve(this.get(id));
    await Promise.resolve(this.audit.record({
      actor: context.actor,
      action: 'opportunity.stage_changed',
      entityType: 'opportunity',
      entityId: id,
      data: {
        from: opportunity.stage,
        to: stage,
        workflowRunId: context.workflowRunId ?? null,
      },
    }));
    await this.events.emit('opportunity.stage_changed', {
      opportunity: updated,
      from: opportunity.stage,
      to: stage,
      workflowRunId: context.workflowRunId ?? null,
    });
    return updated;
  }

  /** @param {any} row */
  #mapRow(row) {
    const company = this.companies.get(row.company_id);
    const contact = row.contact_id ? this.contacts.get(row.contact_id) : null;
    const map = (resolvedCompany, resolvedContact) => mapOpportunityRow({
      ...row, company_name: resolvedCompany.name,
      contact_name: resolvedContact ? `${resolvedContact.firstName} ${resolvedContact.lastName}` : null,
    });
    if (isSyncStorage(this.database)) return map(company, contact);
    return Promise.all([Promise.resolve(company), Promise.resolve(contact)]).then(([resolvedCompany, resolvedContact]) => (
      map(resolvedCompany, resolvedContact)
    ));
  }
}

/** @param {any} opportunity */
function opportunityValues(opportunity) {
  return [
    ['id', opportunity.id], ['company_id', opportunity.companyId], ['contact_id', opportunity.contactId],
    ['name', opportunity.name], ['type', opportunity.type], ['value_cents', opportunity.valueCents],
    ['currency', opportunity.currency], ['stage', opportunity.stage], ['owner', opportunity.owner],
    ['expected_close_date', opportunity.expectedCloseDate], ['source_key', opportunity.sourceKey],
    ['created_at', opportunity.createdAt], ['updated_at', opportunity.updatedAt],
  ].map(([column, value]) => ({ column, value }));
}

/** @param {any} row */
function mapOpportunityRow(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name ?? null,
    contactId: row.contact_id,
    contactName: row.contact_name ?? null,
    name: row.name,
    type: row.type,
    valueCents: Number(row.value_cents),
    currency: row.currency,
    stage: row.stage,
    owner: row.owner,
    expectedCloseDate: row.expected_close_date,
    sourceKey: row.source_key ?? null,
    pipelineKey: row.pipeline_key ?? null,
    pipelineStage: row.pipeline_stage ?? null,
    stageEnteredAt: row.stage_entered_at ?? null,
    closedAt: row.closed_at ?? null,
    closeReason: row.close_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
