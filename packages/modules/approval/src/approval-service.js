// @ts-check

import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../../core/src/errors.js';
import { enumValue, requiredString } from '../../../core/src/validation.js';
import { APPROVAL_STATUSES } from '../../../core/src/schema.js';
import { normalizeActor } from '../../../core/src/actor.js';
import { nowIso } from '../../../core/src/time.js';

export class ApprovalService {
  /** @param {{database: any, audit: any, events: any, opportunities: any}} dependencies */
  constructor({ database, audit, events, opportunities }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.opportunities = opportunities;
  }

  /**
   * @param {{opportunityId: unknown, reason: unknown}} input
   * @param {{actor?: unknown, workflowRunId?: string}} [context]
   */
  async request(input, context = {}) {
    const opportunityId = requiredString(input.opportunityId, 'opportunityId');
    this.opportunities.get(opportunityId);
    const existing = this.findPendingByOpportunity(opportunityId);
    if (existing) return existing;
    const actor = normalizeActor(context.actor);
    const approval = {
      id: randomUUID(),
      opportunityId,
      status: 'pending',
      reason: requiredString(input.reason, 'reason'),
      requestedBy: actor.id,
      decidedBy: null,
      requestedAt: nowIso(),
      decidedAt: null,
    };
    this.database.storage.sync.execute({
      kind: 'insert', table: 'approvals', values: approvalValues(approval),
    });
    this.audit.record({
      actor,
      action: 'approval.requested',
      entityType: 'approval',
      entityId: approval.id,
      data: { ...approval, workflowRunId: context.workflowRunId ?? null },
    });
    await this.events.emit('approval.requested', approval);
    return approval;
  }

  /**
   * @param {string} id
   * @param {'approved'|'rejected'} decision
   * @param {{actor?: unknown, workflowRunId?: string}} [context]
   */
  async decide(id, decision, context = {}) {
    const approval = this.get(id);
    if (approval.status !== 'pending') {
      throw new ConflictError(`Approval ${id} is already ${approval.status}`, { id, status: approval.status });
    }
    const status = enumValue(decision, [...APPROVAL_STATUSES].filter((item) => item !== 'pending'), 'decision');
    const actor = normalizeActor(context.actor);
    const decidedAt = nowIso();
    this.database.storage.sync.execute({
      kind: 'update', table: 'approvals', values: [
        { column: 'status', value: status }, { column: 'decided_by', value: actor.id },
        { column: 'decided_at', value: decidedAt },
      ], where: [{ column: 'id', op: 'eq', value: id }],
    });
    const updated = this.get(id);
    this.audit.record({
      actor,
      action: `approval.${status}`,
      entityType: 'approval',
      entityId: id,
      data: { opportunityId: updated.opportunityId, workflowRunId: context.workflowRunId ?? null },
    });
    await this.events.emit(`approval.${status}`, updated);
    return updated;
  }

  /** @param {string} id */
  get(id) {
    const row = this.database.storage.sync.maybeOne({
      kind: 'select', table: 'approvals', columns: '*', where: [{ column: 'id', op: 'eq', value: id }],
    });
    if (!row) throw new NotFoundError('Approval', id);
    return this.#mapRow(row);
  }

  /** @param {string} opportunityId */
  findPendingByOpportunity(opportunityId) {
    const row = this.database.storage.sync.maybeOne({
      kind: 'select', table: 'approvals', columns: '*', where: [
        { column: 'opportunity_id', op: 'eq', value: opportunityId },
        { column: 'status', op: 'eq', value: 'pending' },
      ],
    });
    return row ? this.#mapRow(row) : null;
  }

  /** @param {{status?: string, opportunityId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const where = [];
    if (filters.status) {
      enumValue(filters.status, [...APPROVAL_STATUSES], 'status');
      where.push({ column: 'status', op: 'eq', value: filters.status });
    }
    if (filters.opportunityId) {
      where.push({ column: 'opportunity_id', op: 'eq', value: filters.opportunityId });
    }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.storage.sync.many({
      kind: 'select', table: 'approvals', columns: '*', where,
      orderBy: [{ column: 'requested_at', direction: 'desc' }], limit,
    }).map((row) => this.#mapRow(row));
  }

  /** @param {any} row */
  #mapRow(row) {
    const opportunity = this.opportunities.get(row.opportunity_id);
    return mapApprovalRow({
      ...row, opportunity_name: opportunity.name, company_name: opportunity.companyName,
      value_cents: opportunity.valueCents, currency: opportunity.currency,
    });
  }
}

/** @param {any} approval */
function approvalValues(approval) {
  return [
    ['id', approval.id], ['opportunity_id', approval.opportunityId], ['status', approval.status],
    ['reason', approval.reason], ['requested_by', approval.requestedBy], ['decided_by', approval.decidedBy],
    ['requested_at', approval.requestedAt], ['decided_at', approval.decidedAt],
  ].map(([column, value]) => ({ column, value }));
}

/** @param {any} row */
function mapApprovalRow(row) {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    opportunityName: row.opportunity_name ?? null,
    companyName: row.company_name ?? null,
    valueCents: row.value_cents == null ? null : Number(row.value_cents),
    currency: row.currency ?? null,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  };
}
