// @ts-check

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../../core/src/errors.js';
import {
  enumValue,
  nonNegativeInteger,
  optionalIsoDate,
  optionalString,
  requiredString,
} from '../../../core/src/validation.js';
import { OPPORTUNITY_STAGES, OPPORTUNITY_TYPES } from '../../../core/src/schema.js';
import { nowIso } from '../../../core/src/time.js';

const ALLOWED_TRANSITIONS = Object.freeze({
  discovery: ['qualification', 'lost'],
  qualification: ['proposal', 'approval_pending', 'lost'],
  proposal: ['approval_pending', 'negotiation', 'won', 'lost'],
  approval_pending: ['proposal', 'qualification', 'lost'],
  negotiation: ['proposal', 'won', 'lost'],
  won: [],
  lost: ['discovery'],
});

export class OpportunityService {
  /** @param {{database: any, audit: any, events: any, companies: any, contacts: any}} dependencies */
  constructor({ database, audit, events, companies, contacts }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.companies = companies;
    this.contacts = contacts;
  }

  /**
   * @param {{companyId: unknown, contactId?: unknown, name: unknown, type?: unknown, valueCents: unknown, currency?: unknown, stage?: unknown, owner: unknown, expectedCloseDate?: unknown, sourceKey?: unknown}} input
   * @param {{actor?: unknown}} [context]
   */
  async create(input, context = {}) {
    const companyId = requiredString(input.companyId, 'companyId');
    this.companies.get(companyId);
    const contactId = optionalString(input.contactId, 'contactId');
    if (contactId) {
      const contact = this.contacts.get(contactId);
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

    try {
      this.database.raw.prepare(`
        INSERT INTO opportunities(
          id, company_id, contact_id, name, type, value_cents, currency, stage,
          owner, expected_close_date, source_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opportunity.id,
        opportunity.companyId,
        opportunity.contactId,
        opportunity.name,
        opportunity.type,
        opportunity.valueCents,
        opportunity.currency,
        opportunity.stage,
        opportunity.owner,
        opportunity.expectedCloseDate,
        opportunity.sourceKey,
        opportunity.createdAt,
        opportunity.updatedAt,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(`An opportunity already exists for source ${opportunity.sourceKey}`, {
          sourceKey: opportunity.sourceKey,
        });
      }
      throw error;
    }

    this.audit.record({
      actor: context.actor,
      action: 'opportunity.created',
      entityType: 'opportunity',
      entityId: opportunity.id,
      data: opportunity,
    });
    await this.events.emit('opportunity.created', opportunity);
    return opportunity;
  }

  /** @param {string} id */
  get(id) {
    const row = this.database.raw.prepare(`
      SELECT o.*, c.name AS company_name,
             ct.first_name || ' ' || ct.last_name AS contact_name
      FROM opportunities o
      JOIN companies c ON c.id = o.company_id
      LEFT JOIN contacts ct ON ct.id = o.contact_id
      WHERE o.id = ?
    `).get(id);
    if (!row) throw new NotFoundError('Opportunity', id);
    return mapOpportunityRow(row);
  }

  /** @param {{stage?: string, type?: string, companyId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.stage) {
      enumValue(filters.stage, [...OPPORTUNITY_STAGES], 'stage');
      clauses.push('o.stage = ?');
      params.push(filters.stage);
    }
    if (filters.type) {
      enumValue(filters.type, [...OPPORTUNITY_TYPES], 'type');
      clauses.push('o.type = ?');
      params.push(filters.type);
    }
    if (filters.companyId) {
      clauses.push('o.company_id = ?');
      params.push(filters.companyId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.raw.prepare(`
      SELECT o.*, c.name AS company_name,
             ct.first_name || ' ' || ct.last_name AS contact_name
      FROM opportunities o
      JOIN companies c ON c.id = o.company_id
      LEFT JOIN contacts ct ON ct.id = o.contact_id
      ${where}
      ORDER BY o.updated_at DESC
      LIMIT ?
    `).all(...params, limit).map(mapOpportunityRow);
  }

  /**
   * Internal state mutation. Call from a named workflow, not directly from API/MCP.
   * @param {string} id
   * @param {string} targetStage
   * @param {{actor?: unknown, workflowRunId?: string, bypassTransitionCheck?: boolean}} [context]
   */
  async setStage(id, targetStage, context = {}) {
    const opportunity = this.get(id);
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
    this.database.raw.prepare(`
      UPDATE opportunities SET stage = ?, updated_at = ? WHERE id = ?
    `).run(stage, updatedAt, id);
    const updated = this.get(id);
    this.audit.record({
      actor: context.actor,
      action: 'opportunity.stage_changed',
      entityType: 'opportunity',
      entityId: id,
      data: {
        from: opportunity.stage,
        to: stage,
        workflowRunId: context.workflowRunId ?? null,
      },
    });
    await this.events.emit('opportunity.stage_changed', {
      opportunity: updated,
      from: opportunity.stage,
      to: stage,
      workflowRunId: context.workflowRunId ?? null,
    });
    return updated;
  }
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
