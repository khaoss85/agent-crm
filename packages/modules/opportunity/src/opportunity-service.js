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

// Test probe (mirrors injectPostgresqlCommitFault in core
// postgresql-storage): armed only by tests that must force two stage claims
// to overlap. The workflow pins its intent at load-opportunity, before
// setStage runs, so holding every claim here until all parties arrive
// guarantees every pin predates every commit. Production never arms it, so
// setStage never waits outside those tests.
/** @type {(() => Promise<unknown>) | null} */
let stageClaimProbe = null;
/** @param {(() => Promise<unknown>) | null} probe */
export function injectOpportunityStageClaimProbe(probe) {
  stageClaimProbe = typeof probe === 'function' ? probe : null;
}

/**
 * A lost conditional claim reports which of the two defeats happened, so the
 * caller can tell a genuine stage race (fresh pin required) from a row touch
 * that left the stage alone (re-read and retry the same intent).
 */
function stageClaimConflict(from, target, current) {
  if (current !== from) {
    return new ConflictError(
      `Opportunity stage changed under this caller: ${from} → ${current ?? '?'} (wanted ${target})`,
      { from, to: target, current, reason: 'stage_moved' },
    );
  }
  return new ConflictError(
    `Opportunity changed under this caller without a stage move: ${from} (wanted ${target}); re-read the opportunity and retry with a fresh pin`,
    { from, to: target, current, reason: 'row_touched' },
  );
}

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
   * @param {{actor?: unknown, workflowRunId?: string, bypassTransitionCheck?: boolean, expectedFromStage?: string}} [context]
   *   expectedFromStage pins the intent to a previously read stage; when the
   *   stored stage moved meanwhile the caller loses with 409 instead of
   *   re-basing onto the new stage. Omit it only when the read above is the
   *   intent (the committing write still claims exactly one winner).
   */
  async setStage(id, targetStage, context = {}) {
    const opportunity = await Promise.resolve(this.get(id));
    const stage = enumValue(targetStage, [...OPPORTUNITY_STAGES], 'targetStage');
    // A caller acting on a stage it read earlier pins it via
    // expectedFromStage: the intent is only valid from that stage. A fresh
    // read that already moved means a concurrent writer won, so the loser
    // reports 409 instead of re-basing its intent onto the new stage.
    const from = context.expectedFromStage ?? opportunity.stage;
    if (from !== opportunity.stage) {
      // Any pin mismatch loses, even when the current stage happens to equal
      // the target: returning success there would report a commit this request
      // never made (its policy ran against the stage it read, not the current
      // one). Same-intent retries are replayed by idempotency key one layer up,
      // never by stage equality here.
      throw new ConflictError(
        `Opportunity stage changed under this caller: ${from} → ${opportunity.stage} (wanted ${stage})`,
        { from, to: stage, current: opportunity.stage, reason: 'stage_moved' },
      );
    }
    if (opportunity.stage === stage) return opportunity;
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    if (!context.bypassTransitionCheck && !allowed.includes(stage)) {
      throw new ValidationError(`Invalid stage transition: ${from} → ${stage}`, {
        from,
        to: stage,
        allowed,
      });
    }
    // The committing write is a conditional claim (the product-import
    // `affectedRows` verdict idiom): the check above and this write are not
    // atomic, so two writers that both passed the check still serialize here.
    // The claim is fenced on the stage-generation token (stage,
    // stage_entered_at), not the stage alone: the stage value is re-enterable
    // (proposal ↔ negotiation …), so a stale intent must not commit after the
    // opportunity cycled away and back (ABA). The token is stamped by every
    // stage write and forced strictly monotonic here; the pipeline runtime's
    // applyManaged never stamps it unless the lifecycle position itself moves,
    // so an unrelated managed patch between the read and the claim preserves
    // the fence and a valid transition still commits. Rows that never entered
    // a pipeline carry no token yet: they fence on (stage, updated_at)
    // exactly once and graduate to the token on this commit. Zero rows means
    // a concurrent writer moved the opportunity first, so the loser re-reads
    // for the error detail and reports 409 — never success, even when the
    // current stage happens to equal the target.
    const readToken = typeof opportunity.stageEnteredAt === 'string' ? opportunity.stageEnteredAt : null;
    const readUpdatedAt = typeof opportunity.updatedAt === 'string' ? opportunity.updatedAt : null;
    let updatedAt = nowIso();
    if (readUpdatedAt !== null && updatedAt <= readUpdatedAt) {
      updatedAt = new Date(Date.parse(readUpdatedAt) + 1).toISOString();
    }
    let stageToken = updatedAt;
    if (readToken !== null && stageToken <= readToken) {
      stageToken = new Date(Date.parse(readToken) + 1).toISOString();
    }
    const where = [
      { column: 'id', op: 'eq', value: id },
      { column: 'stage', op: 'eq', value: from },
    ];
    if (readToken !== null) where.push({ column: 'stage_entered_at', op: 'eq', value: readToken });
    else if (readUpdatedAt !== null) where.push({ column: 'updated_at', op: 'eq', value: readUpdatedAt });
    const write = {
      kind: 'update', table: 'opportunities', values: [
        { column: 'stage', value: stage }, { column: 'updated_at', value: updatedAt },
        { column: 'stage_entered_at', value: stageToken },
      ], where,
    };
    if (stageClaimProbe) await stageClaimProbe();
    let claimed;
    try {
      if (isSyncStorage(this.database)) claimed = this.database.storage.sync.execute(write);
      else claimed = await storageMutate(this.database, 'opportunity_stage', async (tx) => tx.execute(write));
    } catch (error) {
      // A pinned intent that loses the commit contest is decided, not
      // retryable: the write-outcome envelope would otherwise retry this same
      // run with a fresh read, re-basing an intent formed on a stage that is
      // gone and committing a transition this request never evaluated (two
      // terminal changes committing twice). A serialization or deadlock loss
      // on this fenced claim always means a concurrent writer moved the row
      // first, so the loser reports 409; a genuinely new intent needs a
      // genuinely new request. The re-read is best-effort: the contest may
      // have left this transaction aborted.
      const transient = /** @type {any} */ (error)?.code === 'CONFLICT'
        && /** @type {any} */ (error)?.details?.transient === true;
      if (!transient) throw error;
      let current = null;
      try {
        current = await Promise.resolve(this.get(id));
      } catch {
        current = null;
      }
      throw stageClaimConflict(from, stage, current?.stage ?? null);
    }
    if (Number(claimed?.affectedRows ?? 0) !== 1) {
      const current = await Promise.resolve(this.get(id));
      throw stageClaimConflict(from, stage, current.stage);
    }
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
