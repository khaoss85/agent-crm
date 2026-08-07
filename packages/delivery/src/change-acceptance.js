// @ts-check

import { AppError, ValidationError, optionalString, requiredString } from '../../core/index.js';
import { resolvedNames } from './handover.js';

/**
 * Delivery change, deliverables and acceptance (Milestone 14b2).
 *
 * M13 planned a delivery project, M14a ran it, M14b1 recorded what it consumed.
 * This records what **changed** about it, what it **produced**, and whether
 * anyone said the work was done.
 *
 * Four rules decide everything here, and the second is the one that matters:
 *
 * - **evidence is immutable.** Every record is `writable: "managed"`: no public
 *   create, update or delete through the service, HTTP, the SDK, the Admin or
 *   MCP. A correction is a new record, because acceptance is testimony about a
 *   moment and a row somebody can edit afterwards is not testimony.
 * - **the commercial record is never touched.** A change with commercial
 *   consequence raises an immutable *candidate* and stops. Nothing here mutates
 *   a Quote, an Order, a Contract, a Contract Version or a Subscription; nothing
 *   creates an amendment; nothing recognizes an amount; nothing is sent
 *   anywhere. A future Commercial Amendment milestone consumes the candidate
 *   through a declared capability, in the package that owns commercial truth.
 * - **acceptance is evidence, not authentication.** The strongest claim any of
 *   this makes is *a user actor recorded that a customer accepted or rejected*.
 *   Not an authenticated customer, not a legal signature, not a verified
 *   identity, and not authorization to bill.
 * - **deciding is a human decision.** Every writing action requires
 *   `actor.type === 'user'`; an agent is refused `403`. A human-actor boundary,
 *   **not RBAC**.
 */

export const CHANGE_CAPABILITY = 'delivery-change-management';
export const ACCEPTANCE_CAPABILITY = 'delivery-acceptance-evidence';

const MAX_TEXT = 2_000;
const MAX_LABEL = 200;
const MAX_KEY = 120;
const MAX_REF = 200;
const MAX_REFS = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
/** ADR-014: integer minor units, and a delta may be negative — a change can reduce scope. */
const MAX_MINOR_UNITS = Number.MAX_SAFE_INTEGER;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const CHANGE_TYPES = Object.freeze(['non_commercial_replan', 'commercial_change_required']);
export const CHANGE_STATES = Object.freeze(['proposed', 'approved', 'rejected', 'pending_commercial_followup']);
/** A change is decided exactly once, from `proposed`. There is no re-decision. */
export const CHANGE_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['approved', 'rejected', 'pending_commercial_followup']),
  approved: Object.freeze([]),
  rejected: Object.freeze([]),
  pending_commercial_followup: Object.freeze([]),
});
export const DELIVERABLE_STATES = Object.freeze(['planned', 'completed']);
export const ACCEPTANCE_STATES = Object.freeze(['pending', 'accepted', 'rejected']);
export const ACCEPTANCE_OUTCOMES = Object.freeze(['accepted', 'rejected']);

/** A change may be proposed only while the project is running. */
export const CHANGE_PROJECT_STATES = Object.freeze(['in_progress']);
/** A deliverable completes only from a work package the server says finished. */
export const COMPLETING_WORK_PACKAGE_STATES = Object.freeze(['completed']);

/** @param {any} actor @param {string} what */
function requireHuman(actor, what) {
  if (!actor || actor.type !== 'user') {
    throw new AppError(`${what} is a human decision: sign in as a user actor`, {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
}

/** Trusted read-only managed storage; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'DELIVERY_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/** Operator free text: bounded, and free of the controls that break a line. */
function boundedText(value, field, { required = false, max = MAX_TEXT } = {}) {
  const text = required ? requiredString(value, field) : optionalString(value, field);
  if (text === null) return null;
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  if (CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  return text;
}

/** A calendar date, with no clock and no timezone claim. */
function calendarDate(value, field, { required = false } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  const text = requiredString(value, field);
  if (!DATE_RE.test(text)) throw new ValidationError(`${field} must be a YYYY-MM-DD calendar date`, { field });
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ValidationError(`${field} is not a real calendar date`, { field });
  }
  return text;
}

/** One enum value from a declared set, refused rather than defaulted. */
function oneOf(value, allowed, field) {
  const text = requiredString(value, field);
  if (!allowed.includes(text)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return text;
}

/** The actor id as stored evidence: who did this, truncated to an identifier. */
function actorId(actor) {
  return String(actor?.id ?? 'unknown').slice(0, MAX_REF);
}

/**
 * A bounded list of identifiers belonging to this project, stored as a
 * canonical JSON array. Every id is checked against the project it claims, so a
 * change request can never quietly reference another project's work.
 */
function projectRefs(value, field, service, projectId) {
  if (value === undefined || value === null) return '[]';
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of ids`, { field });
  if (value.length > MAX_REFS) throw new ValidationError(`${field} must contain at most ${MAX_REFS} ids`, { field });
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    const id = requiredString(raw, `${field}[${index}]`);
    if (seen.has(id)) throw new ValidationError(`${field}[${index}] repeats "${id}"`, { field });
    seen.add(id);
    const row = service.listWhere({ id }).find((entry) => entry.deliveryProjectId === projectId);
    if (!row) {
      throw new ValidationError(`${field}[${index}] does not belong to this delivery project`, { field });
    }
  }
  return JSON.stringify([...seen].sort());
}

/** Return the existing record for a source key, or null. Exact, indexed, unpaged. */
function bySourceKey(service, sourceKey) {
  const rows = service.listWhere({ sourceKey });
  return rows.length > 0 ? rows[0] : null;
}

/**
 * A retry answers from the stored record only once it has proved it is the
 * same call. Divergent bytes under a reused key are a conflict, never absorbed
 * — the boundary M14b1's review established for money evidence, applied here
 * because acceptance evidence deserves at least as much.
 */
function requireSameRecord(existing, fields, what) {
  const changed = Object.entries(fields)
    .filter(([field, value]) => (existing[field] ?? null) !== (value ?? null))
    .map(([field]) => field)
    .sort();
  if (changed.length === 0) return;
  throw new AppError(
    `This key already recorded a different ${what} (${changed.join(', ')} differ). Recorded evidence is never edited: record a correction as a new entry with its own key.`,
    { code: 'DELIVERY_EVIDENCE_CONFLICT', status: 409, details: { id: existing.id, fields: changed } },
  );
}

/** The project a record belongs to, in a state that permits the operation. */
function projectIn(record, modules, names, allowed, operation) {
  const project = modules.get(names.project).service.get(record.deliveryProjectId ?? record.id);
  if (!allowed.includes(project.status)) {
    throw new AppError(
      `delivery-project "${project.id}" must be ${allowed.join(' or ')} to ${operation} (it is "${project.status}")`,
      { code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409, details: { id: project.id, state: project.status, allowed: [...allowed] } },
    );
  }
  return project;
}

/** An integer minor-unit amount that may be negative: a change can reduce scope. */
function signedMinorUnits(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a whole number of minor units`, { field });
  }
  if (Math.abs(value) > MAX_MINOR_UNITS) {
    throw new ValidationError(`${field} exceeded the supported range for money`, { field });
  }
  return Number(value);
}

function currencyOf(value, field) {
  const text = requiredString(value, field);
  if (!CURRENCY_RE.test(text)) {
    throw new ValidationError(`${field} must be an uppercase three-letter currency code`, { field });
  }
  return text;
}

/** Record-module names, overridable by a project that renamed them. */
export function changeNames(config = {}) {
  return {
    ...resolvedNames(config),
    changeRequest: config.changeRequest ?? 'delivery-change-request',
    planRevision: config.planRevision ?? 'delivery-plan-revision',
    commercialChange: config.commercialChange ?? 'delivery-commercial-change',
    deliverable: config.deliverable ?? 'delivery-deliverable',
    acceptanceRequest: config.acceptanceRequest ?? 'delivery-acceptance-request',
    acceptanceEvidence: config.acceptanceEvidence ?? 'delivery-acceptance-evidence',
  };
}

/**
 * Every change, deliverable and acceptance action this package contributes.
 * @param {{modules?: Record<string, string>}} [options]
 */
export function buildChangeAcceptanceActions(options = {}) {
  const names = changeNames(options.modules);

  return [
    {
      module: names.project,
      name: 'propose-change-request',
      label: 'Propose a change request',
      description: 'Propose a change to this project\'s scope or dates. It is a proposal: nothing replans, nothing re-prices, and a change with commercial consequence is handed off rather than applied.',
      actionContract: 1,
      input: [
        { name: 'changeKey', type: 'string', required: true, hint: 'Your identifier for this change. The same key records once, so a retry is safe.' },
        { name: 'changeType', type: 'string', required: true, hint: 'non_commercial_replan or commercial_change_required.' },
        { name: 'title', type: 'string', required: true },
        { name: 'reason', type: 'string', required: true, hint: 'Why, in the operator\'s words. An unexplained change is not evidence.' },
        { name: 'requestedScope', type: 'string', required: false },
        { name: 'requestedStartDate', type: 'string', required: false, hint: 'Planning date YYYY-MM-DD — never a signed commitment.' },
        { name: 'requestedEndDate', type: 'string', required: false },
        { name: 'workPackageIds', type: 'json', required: false, hint: 'Work packages this change affects, all in this project.' },
        { name: 'milestoneIds', type: 'json', required: false },
        { name: 'commercialDeltaCents', type: 'integer', required: false, hint: 'Planning evidence only. Nothing is priced, quoted or recognized from it.' },
        { name: 'currency', type: 'string', required: false },
        { name: 'evidenceRef', type: 'string', required: false, hint: 'Your own reference to the request. Nothing is stored or verified here.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Proposing a change request');
        projectIn(record, modules, names, CHANGE_PROJECT_STATES, 'propose a change against it');
        const changes = trusted(modules, names.changeRequest);

        const changeKey = boundedText(input.changeKey, 'changeKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-change-request:${record.id}:${changeKey}`;
        const existing = bySourceKey(changes, sourceKey);

        const changeType = oneOf(input.changeType, CHANGE_TYPES, 'changeType');
        const title = boundedText(input.title, 'title', { required: true, max: MAX_LABEL });
        const reason = boundedText(input.reason, 'reason', { required: true });
        const requestedScope = boundedText(input.requestedScope, 'requestedScope');
        const requestedStartDate = calendarDate(input.requestedStartDate, 'requestedStartDate');
        const requestedEndDate = calendarDate(input.requestedEndDate, 'requestedEndDate');
        if (requestedStartDate && requestedEndDate && requestedEndDate < requestedStartDate) {
          throw new ValidationError('requestedEndDate must not be before requestedStartDate', { field: 'requestedEndDate' });
        }
        const workPackageRefs = projectRefs(input.workPackageIds, 'workPackageIds', modules.get(names.workPackage).service, record.id);
        const milestoneRefs = projectRefs(input.milestoneIds, 'milestoneIds', modules.get(names.milestone).service, record.id);

        // A delta without a currency is a number nobody can read, and a currency
        // without a delta is a claim with no content. Both or neither.
        const commercialDeltaCents = signedMinorUnits(input.commercialDeltaCents, 'commercialDeltaCents');
        const currency = commercialDeltaCents === null ? null : currencyOf(input.currency, 'currency');
        if (commercialDeltaCents === null && input.currency !== undefined && input.currency !== null && input.currency !== '') {
          throw new ValidationError('currency is only meaningful with commercialDeltaCents', { field: 'currency' });
        }
        const evidenceRef = boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF });

        if (existing) {
          requireSameRecord(existing, {
            changeType, title, reason, requestedScope, requestedStartDate, requestedEndDate,
            workPackageRefs, milestoneRefs, commercialDeltaCents, currency, evidenceRef,
          }, 'change request');
          step('delivery.change-request.already-proposed', { id: existing.id });
          return { changeRequest: existing, created: false };
        }

        const created = await changes.createManaged({
          sourceKey,
          deliveryProjectId: record.id,
          changeType, title, reason, requestedScope, requestedStartDate, requestedEndDate,
          workPackageRefs, milestoneRefs, commercialDeltaCents, currency, evidenceRef,
          status: 'proposed',
          decisionReason: null, decidedBy: null, decidedAt: null,
          proposedBy: actorId(actor), proposedAt: now(),
        }, { actor });

        step('delivery.change-request.proposed', { id: created.id, changeType });
        return { changeRequest: created, created: true };
      },
    },

    {
      module: names.changeRequest,
      name: 'decide-change-request',
      label: 'Decide a change request',
      description: 'Approve or reject this change. Approving a non-commercial replan creates an immutable plan revision; approving a commercial change raises a candidate for a future amendment and changes no commercial record. A change is decided once.',
      actionContract: 1,
      fromStates: ['proposed'],
      input: [
        { name: 'decision', type: 'string', required: true, hint: 'approve or reject.' },
        { name: 'reason', type: 'string', required: true, hint: 'Why. An unexplained decision is not evidence.' },
        { name: 'revisedScope', type: 'string', required: false, hint: 'The scope the approved replan plans from here.' },
        { name: 'revisedStartDate', type: 'string', required: false },
        { name: 'revisedEndDate', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Deciding a change request');
        // Decided exactly once. `fromStates` makes the kernel refuse a second
        // decision before this body runs; the table is stated here too so the
        // rule is readable where the decision is made.
        if (!CHANGE_TRANSITIONS[record.status].length) {
          throw new AppError(`delivery-change-request "${record.id}" was already decided ("${record.status}")`, {
            code: 'DELIVERY_TRANSITION_NOT_ALLOWED', status: 409,
            details: { id: record.id, from: record.status, allowed: [] },
          });
        }
        const decision = oneOf(input.decision, ['approve', 'reject'], 'decision');
        const reason = boundedText(input.reason, 'reason', { required: true });
        const changes = trusted(modules, names.changeRequest);

        if (decision === 'reject') {
          const rejected = await changes.applyManaged(record.id, {
            status: 'rejected', decisionReason: reason, decidedBy: actorId(actor), decidedAt: now(),
          }, { actor });
          step('delivery.change-request.decided', { id: record.id, decision: 'rejected' });
          return { changeRequest: rejected, decision: 'rejected', planRevision: null, commercialChange: null };
        }

        // A commercial change stops at the boundary. It raises an immutable
        // candidate and moves to a state a human can see — never an implicit
        // hop into the commercial record, which this package does not own.
        if (record.changeType === 'commercial_change_required') {
          const candidates = trusted(modules, names.commercialChange);
          const project = modules.get(names.project).service.get(record.deliveryProjectId);
          const sourceKey = `delivery-commercial-change:${record.id}`;
          const already = bySourceKey(candidates, sourceKey);
          const candidate = already ?? await candidates.createManaged({
            sourceKey,
            deliveryProjectId: record.deliveryProjectId,
            deliveryChangeRequestId: record.id,
            contractId: project.contractId ?? null,
            summary: record.title,
            estimatedDeltaCents: record.commercialDeltaCents,
            currency: record.currency,
            status: 'pending_commercial_followup',
            raisedBy: actorId(actor), raisedAt: now(),
          }, { actor });
          const handed = await changes.applyManaged(record.id, {
            status: 'pending_commercial_followup', decisionReason: reason,
            decidedBy: actorId(actor), decidedAt: now(),
          }, { actor });
          step('delivery.commercial-change.requested', { id: candidate.id, changeRequestId: record.id });
          step('delivery.change-request.decided', { id: record.id, decision: 'pending_commercial_followup' });
          return { changeRequest: handed, decision: 'pending_commercial_followup', planRevision: null, commercialChange: candidate };
        }

        // A non-commercial replan produces an immutable revision describing
        // what is planned *from here*. It never rewrites the M13 handover
        // snapshot, the signed Order or completed historical work.
        const revisions = trusted(modules, names.planRevision);
        const revisedStartDate = calendarDate(input.revisedStartDate, 'revisedStartDate');
        const revisedEndDate = calendarDate(input.revisedEndDate, 'revisedEndDate');
        if (revisedStartDate && revisedEndDate && revisedEndDate < revisedStartDate) {
          throw new ValidationError('revisedEndDate must not be before revisedStartDate', { field: 'revisedEndDate' });
        }
        const version = revisions.countWhere({ deliveryProjectId: record.deliveryProjectId }) + 1;
        const revision = await revisions.createManaged({
          sourceKey: `delivery-plan-revision:${record.deliveryProjectId}:v${version}`,
          deliveryProjectId: record.deliveryProjectId,
          deliveryChangeRequestId: record.id,
          version,
          revisedScope: boundedText(input.revisedScope, 'revisedScope') ?? record.requestedScope,
          revisedStartDate: revisedStartDate ?? record.requestedStartDate,
          revisedEndDate: revisedEndDate ?? record.requestedEndDate,
          reason,
          createdBy: actorId(actor), revisedAt: now(),
        }, { actor });
        const approved = await changes.applyManaged(record.id, {
          status: 'approved', decisionReason: reason, decidedBy: actorId(actor), decidedAt: now(),
        }, { actor });
        step('delivery.plan-revision.created', { id: revision.id, version });
        step('delivery.change-request.decided', { id: record.id, decision: 'approved' });
        return { changeRequest: approved, decision: 'approved', planRevision: revision, commercialChange: null };
      },
    },

    {
      module: names.workPackage,
      name: 'plan-deliverable',
      label: 'Plan a deliverable',
      description: 'Record something this work package is expected to produce. Planning one commits nothing and stores no file.',
      actionContract: 1,
      input: [
        { name: 'deliverableKey', type: 'string', required: true, hint: 'Your identifier. The same key records once.' },
        { name: 'label', type: 'string', required: true },
        { name: 'scopeSnapshot', type: 'string', required: false, hint: 'What "done" means for it, in the operator\'s words.' },
        { name: 'milestoneId', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Planning a deliverable');
        const deliverables = trusted(modules, names.deliverable);
        const deliverableKey = boundedText(input.deliverableKey, 'deliverableKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-deliverable:${record.id}:${deliverableKey}`;
        const existing = bySourceKey(deliverables, sourceKey);

        const label = boundedText(input.label, 'label', { required: true, max: MAX_LABEL });
        const scopeSnapshot = boundedText(input.scopeSnapshot, 'scopeSnapshot');
        let deliveryMilestoneId = null;
        if (input.milestoneId !== undefined && input.milestoneId !== null && input.milestoneId !== '') {
          const id = requiredString(input.milestoneId, 'milestoneId');
          const milestone = modules.get(names.milestone).service.listWhere({ id })
            .find((row) => row.deliveryProjectId === record.deliveryProjectId);
          if (!milestone) throw new ValidationError('milestoneId does not belong to this delivery project', { field: 'milestoneId' });
          deliveryMilestoneId = id;
        }

        if (existing) {
          requireSameRecord(existing, { label, scopeSnapshot, deliveryMilestoneId }, 'deliverable');
          step('delivery.deliverable.already-planned', { id: existing.id });
          return { deliverable: existing, created: false };
        }

        const created = await deliverables.createManaged({
          sourceKey,
          deliveryProjectId: record.deliveryProjectId,
          deliveryWorkPackageId: record.id,
          deliveryMilestoneId,
          label, scopeSnapshot,
          status: 'planned',
          completionEvidenceRef: null, completedBy: null, completedAt: null,
          plannedBy: actorId(actor), plannedAt: now(),
        }, { actor });
        step('delivery.deliverable.planned', { id: created.id });
        return { deliverable: created, created: true };
      },
    },

    {
      module: names.deliverable,
      name: 'complete-deliverable',
      label: 'Complete a deliverable',
      description: 'Record that this deliverable is finished. It requires the work package the server says is complete — and it never says anyone accepted it.',
      actionContract: 1,
      fromStates: ['planned'],
      input: [
        { name: 'completionEvidenceRef', type: 'string', required: false, hint: 'Your own reference. Nothing is stored or verified here.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Completing a deliverable');
        // Server-authoritative: a deliverable cannot outrun the execution state
        // M14a owns. A caller cannot assert completion the work does not show.
        const workPackage = modules.get(names.workPackage).service.get(record.deliveryWorkPackageId);
        if (!COMPLETING_WORK_PACKAGE_STATES.includes(workPackage.status)) {
          throw new AppError(
            `delivery-work-package "${workPackage.id}" must be ${COMPLETING_WORK_PACKAGE_STATES.join(' or ')} before its deliverable completes (it is "${workPackage.status}")`,
            { code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409, details: { id: workPackage.id, state: workPackage.status, allowed: [...COMPLETING_WORK_PACKAGE_STATES] } },
          );
        }
        const deliverables = trusted(modules, names.deliverable);
        const completed = await deliverables.applyManaged(record.id, {
          status: 'completed',
          completionEvidenceRef: boundedText(input.completionEvidenceRef, 'completionEvidenceRef', { max: MAX_REF }),
          completedBy: actorId(actor), completedAt: now(),
        }, { actor });
        step('delivery.deliverable.completed', { id: record.id });
        return { deliverable: completed, accepted: false };
      },
    },

    {
      module: names.milestone,
      name: 'request-acceptance',
      label: 'Request acceptance',
      description: 'Submit this milestone\'s completed deliverables for customer acceptance. Nothing is emailed, no portal exists and no customer is authenticated: this records that a human asked.',
      actionContract: 1,
      input: [
        { name: 'requestKey', type: 'string', required: true, hint: 'Your identifier. The same key records once.' },
        { name: 'customerRef', type: 'string', required: true, hint: 'An operational label for the customer. It authenticates nobody.' },
        { name: 'customerContactRef', type: 'string', required: false },
        { name: 'customerNameSnapshot', type: 'string', required: false, hint: 'The name as it read when asked; a later rename does not rewrite it.' },
        { name: 'evidenceRef', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Requesting acceptance');
        const requests = trusted(modules, names.acceptanceRequest);
        const requestKey = boundedText(input.requestKey, 'requestKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-acceptance-request:${record.id}:${requestKey}`;
        const existing = bySourceKey(requests, sourceKey);

        const customerRef = boundedText(input.customerRef, 'customerRef', { required: true, max: MAX_REF });
        const customerContactRef = boundedText(input.customerContactRef, 'customerContactRef', { max: MAX_REF });
        const customerNameSnapshot = boundedText(input.customerNameSnapshot, 'customerNameSnapshot', { max: MAX_LABEL });
        const evidenceRef = boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF });

        if (existing) {
          requireSameRecord(existing, { customerRef, customerContactRef, customerNameSnapshot, evidenceRef }, 'acceptance request');
          step('delivery.acceptance.already-requested', { id: existing.id });
          return { acceptanceRequest: existing, created: false };
        }

        // Only over work the server says is finished, and only once at a time:
        // two open requests for one milestone is a question nobody can answer.
        const deliverables = modules.get(names.deliverable).service
          .listWhere({ deliveryMilestoneId: record.id });
        if (deliverables.length === 0) {
          throw new AppError('This milestone has no deliverables, so there is nothing to accept', {
            code: 'DELIVERY_NOTHING_TO_ACCEPT', status: 409,
          });
        }
        const unfinished = deliverables.filter((row) => row.status !== 'completed');
        if (unfinished.length > 0) {
          throw new AppError(
            `${unfinished.length} deliverable(s) on this milestone are not complete, so acceptance cannot be requested`,
            { code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409, details: { pending: unfinished.map((row) => row.id).sort() } },
          );
        }
        const open = requests.listWhere({ deliveryMilestoneId: record.id })
          .filter((row) => row.status === 'pending');
        if (open.length > 0) {
          throw new AppError('This milestone already has a pending acceptance request', {
            code: 'DELIVERY_ACCEPTANCE_ALREADY_PENDING', status: 409, details: { id: open[0].id },
          });
        }

        const created = await requests.createManaged({
          sourceKey,
          deliveryProjectId: record.deliveryProjectId,
          deliveryMilestoneId: record.id,
          deliverableRefs: JSON.stringify(deliverables.map((row) => row.id).sort()),
          customerRef, customerContactRef, customerNameSnapshot, evidenceRef,
          status: 'pending',
          requestedBy: actorId(actor), requestedAt: now(),
        }, { actor });
        step('delivery.acceptance.requested', { id: created.id, deliverables: deliverables.length });
        return { acceptanceRequest: created, created: true };
      },
    },

    {
      module: names.acceptanceRequest,
      name: 'record-acceptance',
      label: 'Record acceptance evidence',
      description: 'Record what the customer said. This is evidence a human recorded — not an authenticated customer action, not a legal signature, not a verified identity, and not authorization to bill.',
      actionContract: 1,
      fromStates: ['pending'],
      input: [
        { name: 'outcome', type: 'string', required: true, hint: 'accepted or rejected.' },
        { name: 'assertedCustomerRef', type: 'string', required: true, hint: 'Who the recorder says accepted. Asserted, never verified.' },
        { name: 'assertedContactRef', type: 'string', required: false },
        { name: 'note', type: 'string', required: false },
        { name: 'evidenceRef', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording acceptance evidence');
        const evidence = trusted(modules, names.acceptanceEvidence);
        const requests = trusted(modules, names.acceptanceRequest);
        const outcome = oneOf(input.outcome, ACCEPTANCE_OUTCOMES, 'outcome');
        const sourceKey = `delivery-acceptance-evidence:${record.id}`;
        const existing = bySourceKey(evidence, sourceKey);
        if (existing) {
          step('delivery.acceptance.already-recorded', { id: existing.id });
          return { acceptanceEvidence: existing, acceptanceRequest: record, created: false };
        }

        const created = await evidence.createManaged({
          sourceKey,
          deliveryProjectId: record.deliveryProjectId,
          deliveryAcceptanceRequestId: record.id,
          outcome,
          assertedCustomerRef: boundedText(input.assertedCustomerRef, 'assertedCustomerRef', { required: true, max: MAX_REF }),
          assertedContactRef: boundedText(input.assertedContactRef, 'assertedContactRef', { max: MAX_REF }),
          note: boundedText(input.note, 'note'),
          evidenceRef: boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF }),
          recordedBy: actorId(actor), recordedAt: now(),
        }, { actor });

        // A rejection preserves execution history. Reopening completed work
        // would rewrite the M14a evidence M14b1's economics are computed from,
        // and a snapshot taken on Tuesday must still reproduce on Wednesday.
        // Replanning after a rejection is a new change request, deliberately.
        const settled = await requests.applyManaged(record.id, { status: outcome }, { actor });
        step('delivery.acceptance.recorded', { id: created.id, outcome });
        return { acceptanceEvidence: created, acceptanceRequest: settled, created: true };
      },
    },
  ];
}

/** Function-free schema metadata for the change and acceptance surface. */
export function changeAcceptanceMetadata() {
  return {
    changeAcceptanceContract: 1,
    changeTypes: [...CHANGE_TYPES],
    changeStates: [...CHANGE_STATES],
    changeTransitions: Object.fromEntries(
      Object.entries(CHANGE_TRANSITIONS).map(([from, to]) => [from, [...to]]),
    ),
    deliverableStates: [...DELIVERABLE_STATES],
    acceptanceStates: [...ACCEPTANCE_STATES],
    humanApproval: 'proposing, deciding, planning, completing, requesting and recording each require actor.type === "user"; an agent is refused 403 HUMAN_APPROVAL_REQUIRED. This is a human-actor boundary, not Delivery Manager or customer role enforcement',
    commercialBoundary: 'a change with commercial consequence raises an immutable delivery-commercial-change candidate and stops. No Quote, Order, Contract, Contract Version or Subscription is created or altered, no amendment exists, no amount is recognized and nothing is sent. A future Commercial Amendment milestone consumes the candidate through a declared capability',
    acceptanceMeaning: 'acceptance evidence records what a USER ACTOR says a customer said. It is not an authenticated customer action, not a legal signature, not a verified identity, and not authorization to bill',
    rejectionSemantics: 'a rejected acceptance preserves execution history: it is recorded, and replanning requires a new change request. Completed work is never destructively reopened, because M14b1 economics snapshots must stay reproducible',
    immutability: 'change requests, plan revisions, commercial-change candidates, deliverables, acceptance requests and acceptance evidence have no public create, update or delete; a correction is a new record',
    notModeled: [
      'invoicing', 'payment', 'billing eligibility', 'contract amendment',
      'Quote/Order/Contract mutation', 'legal acceptance', 'authenticated customer identity',
      'customer portal', 'external send or notification', 'e-signature',
      'resource scheduling', 'capacity', 'document or binary storage',
      'SLA', 'service activation', 'entitlements',
    ],
  };
}

/**
 * Read-only change-management evidence for one delivery project, offered to
 * another package. It reads; it never decides, and it never reaches commercial
 * storage.
 */
export function createChangeCapability(options = {}) {
  const names = changeNames(options.modules);
  return {
    name: CHANGE_CAPABILITY,
    version: 1,
    description: 'Read the change requests, plan revisions and pending commercial-change candidates of one delivery project. Read-only: it decides nothing, and it grants no access to commercial storage.',
    create(context) {
      const modules = context?.modules;
      if (!modules) throw new AppError('delivery-change-management requires the caller\'s module handles', { code: 'CAPABILITY_INVALID', status: 500 });
      return Object.freeze({
        /** @param {string} deliveryProjectId */
        forProject(deliveryProjectId) {
          const id = requiredString(deliveryProjectId, 'deliveryProjectId');
          modules.get(names.project).service.get(id);
          return {
            changeRequests: modules.get(names.changeRequest).service.listWhere({ deliveryProjectId: id }),
            planRevisions: modules.get(names.planRevision).service.listWhere({ deliveryProjectId: id }),
            commercialChanges: modules.get(names.commercialChange).service.listWhere({ deliveryProjectId: id }),
          };
        },
        /**
         * The candidates a future Commercial Amendment milestone would consume.
         * Reading one changes nothing: consuming it is that milestone's job, in
         * the package that owns commercial truth.
         */
        pendingCommercialChanges() {
          return modules.get(names.commercialChange).service
            .listWhere({ status: 'pending_commercial_followup' });
        },
      });
    },
  };
}

/** Read-only acceptance evidence. It is testimony a human recorded, never authorization. */
export function createAcceptanceCapability(options = {}) {
  const names = changeNames(options.modules);
  return {
    name: ACCEPTANCE_CAPABILITY,
    version: 1,
    description: 'Read the acceptance requests and recorded acceptance evidence of one delivery project. This is what a USER ACTOR recorded a customer as saying — never an authenticated customer action, a legal signature or authorization to bill.',
    create(context) {
      const modules = context?.modules;
      if (!modules) throw new AppError('delivery-acceptance-evidence requires the caller\'s module handles', { code: 'CAPABILITY_INVALID', status: 500 });
      return Object.freeze({
        /** @param {string} deliveryProjectId */
        forProject(deliveryProjectId) {
          const id = requiredString(deliveryProjectId, 'deliveryProjectId');
          modules.get(names.project).service.get(id);
          return {
            deliverables: modules.get(names.deliverable).service.listWhere({ deliveryProjectId: id }),
            acceptanceRequests: modules.get(names.acceptanceRequest).service.listWhere({ deliveryProjectId: id }),
            acceptanceEvidence: modules.get(names.acceptanceEvidence).service.listWhere({ deliveryProjectId: id }),
            basis: 'recorded by a user actor; not an authenticated customer action, not a legal signature, and not authorization to bill',
          };
        },
      });
    },
  };
}
