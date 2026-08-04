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
    this.database.raw.prepare(`
      INSERT INTO approvals(
        id, opportunity_id, status, reason, requested_by, decided_by, requested_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.id,
      approval.opportunityId,
      approval.status,
      approval.reason,
      approval.requestedBy,
      approval.decidedBy,
      approval.requestedAt,
      approval.decidedAt,
    );
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
    this.database.raw.prepare(`
      UPDATE approvals
      SET status = ?, decided_by = ?, decided_at = ?
      WHERE id = ?
    `).run(status, actor.id, decidedAt, id);
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
    const row = this.database.raw.prepare(`
      SELECT a.*, o.name AS opportunity_name, o.value_cents, o.currency,
             c.name AS company_name
      FROM approvals a
      JOIN opportunities o ON o.id = a.opportunity_id
      JOIN companies c ON c.id = o.company_id
      WHERE a.id = ?
    `).get(id);
    if (!row) throw new NotFoundError('Approval', id);
    return mapApprovalRow(row);
  }

  /** @param {string} opportunityId */
  findPendingByOpportunity(opportunityId) {
    const row = this.database.raw.prepare(`
      SELECT a.*, o.name AS opportunity_name, o.value_cents, o.currency,
             c.name AS company_name
      FROM approvals a
      JOIN opportunities o ON o.id = a.opportunity_id
      JOIN companies c ON c.id = o.company_id
      WHERE a.opportunity_id = ? AND a.status = 'pending'
    `).get(opportunityId);
    return row ? mapApprovalRow(row) : null;
  }

  /** @param {{status?: string, opportunityId?: string, limit?: number}} [filters] */
  list(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) {
      enumValue(filters.status, [...APPROVAL_STATUSES], 'status');
      clauses.push('a.status = ?');
      params.push(filters.status);
    }
    if (filters.opportunityId) {
      clauses.push('a.opportunity_id = ?');
      params.push(filters.opportunityId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.raw.prepare(`
      SELECT a.*, o.name AS opportunity_name, o.value_cents, o.currency,
             c.name AS company_name
      FROM approvals a
      JOIN opportunities o ON o.id = a.opportunity_id
      JOIN companies c ON c.id = o.company_id
      ${where}
      ORDER BY a.requested_at DESC
      LIMIT ?
    `).all(...params, limit).map(mapApprovalRow);
  }
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
