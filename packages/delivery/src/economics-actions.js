// @ts-check

import { AppError, ValidationError, optionalString, requiredString } from '../../core/index.js';
import {
  CONTRIBUTION_UNAVAILABLE_REASONS, ECONOMICS_BASIS, ECONOMICS_NOTE,
  MAX_MINUTES_PER_ENTRY, ROUNDING_RULE,
  computeEconomics, costOfMinutes, requireCurrency, requireMinorUnits, requireMinutes,
  requirePlannedMinutes,
} from './economics.js';
import { COST_POLICY_KIND, MAX_REF, costPolicyFingerprint, requireReference, resolveRate } from './cost-policy.js';
import { resolvedNames } from './handover.js';

/**
 * Delivery economics (Milestone 14b1).
 *
 * M13 planned a delivery project; M14a let a human run it. This records **what
 * it consumed** — time and expenses — and computes a reproducible **delivery
 * contribution estimate** against a versioned plan.
 *
 * Four rules decide everything here:
 *
 * - **evidence is immutable.** Every record is `writable: "managed"`, so there
 *   is no public create, update or delete anywhere: not through the service,
 *   HTTP, the SDK, the Admin or MCP. A correction is a new entry, because a
 *   snapshot computed on Tuesday must still be reproducible on Wednesday.
 * - **the server computes money.** A caller supplies minutes; the cost policy
 *   supplies the rate; this file multiplies and rounds. No client-supplied cost
 *   or total is ever authoritative.
 * - **currencies are never mixed.** There is no FX in this framework, so every
 *   total is grouped by currency and a group is a complete answer for that
 *   currency alone.
 * - **these are operational estimates.** No revenue is recognized, no invoice
 *   amount is implied, no accounting or gross margin is computed, nothing is
 *   paid, and no billing eligibility is created.
 *
 * Recording, publishing and snapshotting are **human decisions**
 * (`actor.type === 'user'`) — a human-actor boundary, not RBAC. An agent may
 * call the read-only preview and nothing else.
 */

export const ECONOMICS_CAPABILITY = 'delivery-economics';
const MAX_NOTE = 500;
const MAX_CATEGORY = 64;
const MAX_PLAN_LINES = 500;
const MAX_KEY = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
export const PLAN_LINE_KINDS = Object.freeze(['internal_time', 'partner', 'expense', 'contingency']);
export const CONTRIBUTOR_TYPES = Object.freeze(['internal', 'partner']);
/** Consumption is recorded while work is happening — not before it starts, not after it is done. */
export const RECORDING_WORK_PACKAGE_STATES = Object.freeze(['in_progress', 'blocked']);
export const RECORDING_PROJECT_STATES = Object.freeze(['in_progress']);

/** @param {any} actor @param {string} what */
function requireHuman(actor, what) {
  if (!actor || actor.type !== 'user') {
    throw new AppError(`${what} is a human decision: sign in as a user actor`, {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
}

/** Trusted read-only managed storage handle; a CRUD-writable module is refused. */
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
function boundedText(value, field, { required = false, max = MAX_NOTE } = {}) {
  const text = required ? requiredString(value, field) : optionalString(value, field);
  if (text === null) return null;
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  if (CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  return text;
}

/** A calendar date, with no clock and no timezone claim. */
function calendarDate(value, field) {
  const text = requiredString(value, field);
  if (!DATE_RE.test(text)) throw new ValidationError(`${field} must be a YYYY-MM-DD calendar date`, { field });
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ValidationError(`${field} is not a real calendar date`, { field });
  }
  return text;
}

/** The actor id as stored evidence: who did this, truncated to an identifier. */
function actorId(actor) {
  return String(actor?.id ?? 'unknown').slice(0, MAX_REF);
}

/** One enum value from a declared set, refused rather than defaulted. */
function oneOf(value, allowed, field) {
  const text = requiredString(value, field);
  if (!allowed.includes(text)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return text;
}

/** The project a work package belongs to, in a state that permits consumption. */
function executingContext({ record, modules, names }) {
  const project = modules.get(names.project).service.get(record.deliveryProjectId);
  if (!RECORDING_PROJECT_STATES.includes(project.status)) {
    throw new AppError(
      `delivery-project "${project.id}" must be ${RECORDING_PROJECT_STATES.join(' or ')} to record consumption against it (it is "${project.status}")`,
      { code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409, details: { id: project.id, state: project.status, allowed: [...RECORDING_PROJECT_STATES] } },
    );
  }
  if (!RECORDING_WORK_PACKAGE_STATES.includes(record.status)) {
    throw new AppError(
      `delivery-work-package "${record.id}" must be ${RECORDING_WORK_PACKAGE_STATES.join(' or ')} to record consumption against it (it is "${record.status}")`,
      { code: 'DELIVERY_STATE_NOT_ALLOWED', status: 409, details: { id: record.id, state: record.status, allowed: [...RECORDING_WORK_PACKAGE_STATES] } },
    );
  }
  return project;
}

/**
 * The cost policy this application composed. Exactly one is required to record
 * time: a rate nobody declared is a number nobody can defend.
 */
function costPolicy(policies, requested) {
  const available = policies ?? [];
  if (available.length === 0) {
    throw new AppError('No delivery cost policy is registered, so no rate can be resolved', {
      code: 'DELIVERY_COST_POLICY_MISSING', status: 409,
    });
  }
  const name = optionalString(requested?.policy, 'policy');
  const version = requested?.policyVersion;
  if (version !== undefined && version !== null && !Number.isSafeInteger(version)) {
    throw new ValidationError('policyVersion must be a whole number', { field: 'policyVersion' });
  }
  const wanted = version === undefined || version === null ? null : Number(version);
  // A requested version is honoured whether or not a name came with it. The
  // earlier code fell back to the first registered policy the moment no name
  // was given, so `policyVersion: 3` alone priced the work at version 1 and
  // stored that as evidence — the caller's explicit choice, silently ignored,
  // in the one place the framework is deciding money.
  const found = available.find((entry) => (name === null || entry.definition.name === name)
    && (wanted === null || entry.definition.version === wanted));
  if (!found) {
    throw new AppError(`Delivery cost policy "${name ?? 'any'}@${wanted ?? 'any'}" is not registered`, {
      code: 'DELIVERY_COST_POLICY_MISSING', status: 409,
      details: { available: available.map((entry) => `${entry.definition.name}@${entry.definition.version}`) },
    });
  }
  return { policy: found.definition, fingerprint: costPolicyFingerprint(found.definition) };
}

/**
 * Compare a retry against what that key already recorded.
 *
 * An idempotency key promises "the same call records once". It does not promise
 * that a *different* call under a reused key silently succeeds — and here the
 * difference is money. An operator who resubmits `entryKey: "day-1"` with 480
 * minutes instead of 60 got a 200 and `created: false`, and the entry still
 * said 60. The correction was lost, and the response looked like success.
 *
 * The framework already takes the stricter line where an external event id is
 * replayed with a different payload (`signature-operations.js`), and evidence
 * that money is derived from deserves at least that. A correction is a new
 * entry, so a divergent retry is a conflict and says so.
 *
 * @param {any} existing @param {Record<string, unknown>} fields @param {string} what
 */
function requireSameEntry(existing, fields, what) {
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

/** Return the existing record for a source key, or null. Exact, indexed, unpaged. */
function bySourceKey(service, sourceKey) {
  const rows = service.listWhere({ sourceKey });
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Every economics action this package contributes.
 *
 * @param {{modules?: Record<string, string>, costPolicies?: any[]}} [options]
 */
export function buildEconomicsActions(options = {}) {
  const names = economicsNames(options.modules);
  const policies = options.costPolicies ?? [];

  return [
    {
      module: names.workPackage,
      name: 'record-delivery-time',
      label: 'Record delivery time',
      description: 'Record time consumed on this work package. The rate comes from the versioned cost policy and the cost is computed here; it is evidence, not a timesheet, and it is neither payroll nor an accounting cost.',
      actionContract: 1,
      input: [
        { name: 'entryKey', type: 'string', required: true, hint: 'Your identifier for this entry. The same key records once, so a retry is safe.' },
        { name: 'contributorRef', type: 'string', required: true, hint: 'An operational label for who did the work. It identifies nobody and reads no HR system.' },
        { name: 'contributorType', type: 'string', required: true, hint: 'internal or partner.' },
        { name: 'workDate', type: 'string', required: true, hint: 'YYYY-MM-DD, the day the work happened.' },
        { name: 'minutes', type: 'integer', required: true, hint: `Whole minutes, at most ${MAX_MINUTES_PER_ENTRY} in one entry.` },
        { name: 'category', type: 'string', required: true, hint: 'The cost category the policy prices.' },
        { name: 'policy', type: 'string', required: false, hint: 'Which registered cost policy to use; the only one, by default.' },
        { name: 'policyVersion', type: 'integer', required: false },
        { name: 'note', type: 'string', required: false, hint: `Why, in the operator's words. At most ${MAX_NOTE} characters.` },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording delivery time');
        const project = executingContext({ record, modules, names });
        const entries = trusted(modules, names.timeEntry);

        const entryKey = boundedText(input.entryKey, 'entryKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-time-entry:${record.id}:${entryKey}`;
        const existing = bySourceKey(entries, sourceKey);

        const contributorType = oneOf(input.contributorType, CONTRIBUTOR_TYPES, 'contributorType');
        const contributorRef = requireReference(input.contributorRef, 'contributorRef');
        const workDate = calendarDate(input.workDate, 'workDate');
        const minutes = requireMinutes(input.minutes, 'minutes');
        const category = boundedText(input.category, 'category', { required: true, max: MAX_CATEGORY });
        const currency = requireCurrency(record.currency, 'work package currency');
        const note = boundedText(input.note, 'note');

        // A retry answers from the stored entry — but only once it has proved
        // it is the same call. Divergent bytes under a reused key are refused,
        // never absorbed. Validation runs first so a malformed retry is a
        // validation error rather than a false "already recorded".
        if (existing) {
          requireSameEntry(existing, {
            contributorRef, contributorType, workDate, minutes, category, note,
          }, 'time entry');
          step('delivery.time.already-recorded', { id: existing.id });
          return { timeEntry: existing, created: false };
        }

        // A partner contribution must name the engagement the project actually
        // has, so partner cost is never attributed to a partner nobody planned.
        let partnerEngagementId = null;
        if (contributorType === 'partner') {
          const engagements = modules.get(names.partner).service.listWhere({ deliveryProjectId: project.id });
          if (engagements.length === 0) {
            throw new AppError('This delivery project has no partner engagement, so partner time cannot be recorded against it', {
              code: 'DELIVERY_PARTNER_NOT_ENGAGED', status: 409,
            });
          }
          partnerEngagementId = engagements[0].id;
        }

        const { policy, fingerprint } = costPolicy(policies, input);
        const rate = resolveRate({
          policy, fingerprint, expectedCurrency: currency,
          input: {
            contributorType, contributorRef, category, minutes, workDate,
            deliveryMode: record.deliveryMode, partnerRef: record.partnerRef ?? null,
            currency,
          },
        });
        const costCents = costOfMinutes(minutes, rate.ratePerHourCents, 'time entry cost');

        const created = await entries.createManaged({
          sourceKey,
          deliveryProjectId: project.id,
          deliveryWorkPackageId: record.id,
          contributorRef,
          contributorType,
          partnerEngagementId,
          workDate,
          minutes,
          category,
          ratePerHourCents: rate.ratePerHourCents,
          costCents,
          currency,
          rateReason: rate.reason,
          policy: rate.policy,
          policyVersion: rate.policyVersion,
          policyFingerprint: rate.policyFingerprint,
          note,
          recordedBy: actorId(actor),
          recordedAt: now(),
        }, { actor });

        step('delivery.time-recorded', { id: created.id, minutes, costCents, currency });
        return { timeEntry: created, created: true };
      },
    },

    {
      module: names.workPackage,
      name: 'record-delivery-expense',
      label: 'Record delivery expense',
      description: 'Record an expense consumed on this work package. It is evidence, not an invoice: nothing is verified, reimbursed, paid or attached, and no receipt is stored.',
      actionContract: 1,
      input: [
        { name: 'entryKey', type: 'string', required: true, hint: 'Your identifier for this expense. The same key records once, so a retry is safe.' },
        { name: 'expenseDate', type: 'string', required: true, hint: 'YYYY-MM-DD, the day the expense was incurred.' },
        { name: 'category', type: 'string', required: true },
        { name: 'amountCents', type: 'integer', required: true, hint: 'Integer minor units in the work package currency. There is no currency conversion.' },
        { name: 'vendorRef', type: 'string', required: false, hint: 'An operational label for the supplier. No vendor record is created.' },
        { name: 'partnerCost', type: 'boolean', required: false, hint: 'True when this expense is the engaged partner\'s cost.' },
        { name: 'evidenceRef', type: 'string', required: false, hint: 'Your own reference to the document. Nothing is stored or verified here.' },
        { name: 'note', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording a delivery expense');
        const project = executingContext({ record, modules, names });
        const expenses = trusted(modules, names.expenseEntry);

        const entryKey = boundedText(input.entryKey, 'entryKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-expense-entry:${record.id}:${entryKey}`;
        const existing = bySourceKey(expenses, sourceKey);

        const currency = requireCurrency(record.currency, 'work package currency');
        const amountCents = requireMinorUnits(input.amountCents, 'amountCents');
        if (amountCents <= 0) throw new ValidationError('amountCents must be a positive number of minor units', { field: 'amountCents' });
        const expenseDate = calendarDate(input.expenseDate, 'expenseDate');
        const category = boundedText(input.category, 'category', { required: true, max: MAX_CATEGORY });
        const vendorRef = input.vendorRef === undefined || input.vendorRef === null || input.vendorRef === ''
          ? null : requireReference(input.vendorRef, 'vendorRef');
        const evidenceRef = boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF });
        const note = boundedText(input.note, 'note');

        if (existing) {
          requireSameEntry(existing, {
            expenseDate, category, amountCents, vendorRef, evidenceRef, note,
          }, 'expense');
          step('delivery.expense.already-recorded', { id: existing.id });
          return { expenseEntry: existing, created: false };
        }

        let partnerEngagementId = null;
        if (input.partnerCost === true) {
          const engagements = modules.get(names.partner).service.listWhere({ deliveryProjectId: project.id });
          if (engagements.length === 0) {
            throw new AppError('This delivery project has no partner engagement, so a partner expense cannot be recorded against it', {
              code: 'DELIVERY_PARTNER_NOT_ENGAGED', status: 409,
            });
          }
          partnerEngagementId = engagements[0].id;
        }

        const created = await expenses.createManaged({
          sourceKey,
          deliveryProjectId: project.id,
          deliveryWorkPackageId: record.id,
          expenseDate,
          category,
          amountCents,
          currency,
          vendorRef,
          partnerEngagementId,
          evidenceRef,
          note,
          recordedBy: actorId(actor),
          recordedAt: now(),
        }, { actor });

        step('delivery.expense-recorded', { id: created.id, amountCents, currency });
        return { expenseEntry: created, created: true };
      },
    },

    {
      module: names.project,
      name: 'publish-economic-plan',
      label: 'Publish delivery economic plan',
      description: 'Publish a new immutable version of this project\'s cost plan. A plan is never edited: publishing again creates the next version, and every earlier version stays readable.',
      actionContract: 1,
      input: [
        { name: 'reason', type: 'string', required: true, hint: 'Why this version exists. Required: an unexplained plan change is not evidence.' },
        { name: 'lines', type: 'json', required: true, hint: 'The planned cost items. Each carries its own currency; currencies are never summed.' },
        { name: 'policy', type: 'string', required: false },
        { name: 'policyVersion', type: 'integer', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Publishing a delivery economic plan');
        const plans = trusted(modules, names.plan);
        const planLines = trusted(modules, names.planLine);

        const lines = normalizePlanLines(input.lines, record, modules, names);
        const reason = boundedText(input.reason, 'reason', { required: true });
        // The next version is derived from an exact count, never from a client.
        const version = plans.countWhere({ deliveryProjectId: record.id }) + 1;
        const sourceKey = `delivery-economic-plan:${record.id}:v${version}`;
        const existing = bySourceKey(plans, sourceKey);
        if (existing) {
          step('delivery.economic-plan.already-published', { id: existing.id, version });
          return { plan: existing, lines: planLines.listWhere({ deliveryEconomicPlanId: existing.id }), created: false };
        }

        const { policy, fingerprint } = policies.length > 0 ? costPolicy(policies, input) : { policy: null, fingerprint: null };
        const plan = await plans.createManaged({
          sourceKey,
          deliveryProjectId: record.id,
          version,
          reason,
          lineCount: lines.length,
          policy: policy ? policy.name : null,
          policyVersion: policy ? policy.version : null,
          policyFingerprint: fingerprint,
          publishedBy: actorId(actor),
          publishedAt: now(),
        }, { actor });

        const stored = [];
        for (const [position, line] of lines.entries()) {
          stored.push(await planLines.createManaged({
            sourceKey: `delivery-economic-plan-line:${plan.id}:${position}`,
            deliveryEconomicPlanId: plan.id,
            deliveryProjectId: record.id,
            deliveryWorkPackageId: line.deliveryWorkPackageId,
            kind: line.kind,
            category: line.category,
            plannedMinutes: line.plannedMinutes,
            plannedTotalCostCents: line.plannedTotalCostCents,
            currency: line.currency,
            note: line.note,
            position,
          }, { actor }));
        }

        step('delivery.economic-plan.published', { id: plan.id, version, lines: stored.length });
        return { plan, lines: stored, created: true };
      },
    },

    {
      module: names.project,
      name: 'snapshot-delivery-economics',
      label: 'Snapshot delivery economics',
      description: 'Compute and store an immutable, reproducible view of this project\'s economics, grouped by currency and citing the evidence it was computed from. These are operational estimates: nothing is recognized, invoiced or paid.',
      actionContract: 1,
      input: [
        { name: 'snapshotKey', type: 'string', required: true, hint: 'Your identifier for this snapshot. The same key computes once, so a retry is safe.' },
        { name: 'note', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Snapshotting delivery economics');
        const snapshots = trusted(modules, names.snapshot);
        const snapshotKey = boundedText(input.snapshotKey, 'snapshotKey', { required: true, max: MAX_KEY });
        const sourceKey = `delivery-economic-snapshot:${record.id}:${snapshotKey}`;
        const existing = bySourceKey(snapshots, sourceKey);
        if (existing) {
          step('delivery.economics.already-snapshotted', { id: existing.id });
          return { snapshot: existing, created: false };
        }

        const evidence = gatherEvidence(record.id, modules, names);
        const computed = computeEconomics(evidence);
        const created = await snapshots.createManaged({
          sourceKey,
          deliveryProjectId: record.id,
          economicPlanId: computed.plan ? computed.plan.id : null,
          economicPlanVersion: computed.plan ? computed.plan.version : null,
          basis: computed.basis,
          groupsJson: JSON.stringify(computed.groups),
          currencyCount: computed.groups.length,
          timeEntryCount: evidence.timeEntries.length,
          expenseEntryCount: evidence.expenses.length,
          planLineCount: evidence.planLines.length,
          workPackageCount: evidence.workPackages.length,
          roundingRule: ROUNDING_RULE,
          note: boundedText(input.note, 'note') ?? ECONOMICS_NOTE,
          calculatedBy: actorId(actor),
          calculatedAt: now(),
        }, { actor });

        step('delivery.economics.snapshotted', { id: created.id, currencies: computed.groups.length });
        return { snapshot: created, economics: computed, created: true };
      },
    },

    {
      module: names.project,
      name: 'preview-delivery-economics',
      label: 'Preview delivery economics',
      description: 'Compute this project\'s economics without storing anything. Read-only, so an agent may call it — and its answer is a preview, never evidence.',
      actionContract: 1,
      input: [],
      /** @param {any} ctx */
      async execute({ record, modules, step }) {
        const evidence = gatherEvidence(record.id, modules, names);
        const computed = computeEconomics(evidence);
        step('delivery.economics.previewed', { currencies: computed.groups.length });
        // Explicitly marked, so no caller can mistake a preview for a snapshot.
        return { economics: computed, stored: false, basis: ECONOMICS_BASIS };
      },
    },
  ];
}

/**
 * Every input a computation needs, read exactly — `listWhere` is an indexed,
 * unpaged read, because a correctness decision must never depend on a page
 * bound.
 */
function gatherEvidence(projectId, modules, names) {
  const plans = modules.get(names.plan).service.listWhere({ deliveryProjectId: projectId });
  // The latest published version is the plan a snapshot is measured against.
  const plan = plans.length > 0 ? plans.reduce((best, row) => (row.version > best.version ? row : best)) : null;
  return {
    workPackages: modules.get(names.workPackage).service.listWhere({ deliveryProjectId: projectId }),
    plan,
    planLines: plan ? modules.get(names.planLine).service.listWhere({ deliveryEconomicPlanId: plan.id }) : [],
    timeEntries: modules.get(names.timeEntry).service.listWhere({ deliveryProjectId: projectId }),
    expenses: modules.get(names.expenseEntry).service.listWhere({ deliveryProjectId: projectId }),
  };
}

/** Validate the plan lines a caller submitted. Bounded, typed and traceable. */
function normalizePlanLines(value, project, modules, names) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('lines must be a non-empty array of planned cost items', { field: 'lines' });
  }
  if (value.length > MAX_PLAN_LINES) {
    throw new ValidationError(`lines must contain at most ${MAX_PLAN_LINES} items`, { field: 'lines' });
  }
  const workPackages = new Map(
    modules.get(names.workPackage).service.listWhere({ deliveryProjectId: project.id }).map((row) => [row.id, row]),
  );
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError(`lines[${index}] must be an object`, { field: 'lines' });
    }
    const label = `lines[${index}]`;
    const kind = oneOf(raw.kind, PLAN_LINE_KINDS, `${label}.kind`);
    let deliveryWorkPackageId = null;
    if (raw.deliveryWorkPackageId !== undefined && raw.deliveryWorkPackageId !== null && raw.deliveryWorkPackageId !== '') {
      const id = requiredString(raw.deliveryWorkPackageId, `${label}.deliveryWorkPackageId`);
      if (!workPackages.has(id)) {
        throw new ValidationError(`${label}.deliveryWorkPackageId does not belong to this delivery project`, { field: 'lines' });
      }
      deliveryWorkPackageId = id;
    }
    const plannedMinutes = raw.plannedMinutes === undefined || raw.plannedMinutes === null
      ? null
      : requirePlannedMinutes(raw.plannedMinutes, `${label}.plannedMinutes`);
    return {
      kind,
      deliveryWorkPackageId,
      category: boundedText(raw.category, `${label}.category`, { required: true, max: MAX_CATEGORY }),
      plannedMinutes,
      plannedTotalCostCents: requireMinorUnits(raw.plannedTotalCostCents, `${label}.plannedTotalCostCents`),
      currency: requireCurrency(raw.currency, `${label}.currency`),
      note: boundedText(raw.note, `${label}.note`),
    };
  });
}

/** Record-module names, overridable by a project that renamed them. */
export function economicsNames(config = {}) {
  return {
    ...resolvedNames(config),
    timeEntry: config.timeEntryModule ?? 'delivery-time-entry',
    expenseEntry: config.expenseEntryModule ?? 'delivery-expense-entry',
    plan: config.economicPlanModule ?? 'delivery-economic-plan',
    planLine: config.economicPlanLineModule ?? 'delivery-economic-plan-line',
    snapshot: config.economicSnapshotModule ?? 'delivery-economic-snapshot',
  };
}

/**
 * The read-only economics capability another package may declare a dependency
 * on. It opens with the caller's own runtime handles, so it reads inside the
 * caller's transaction and this package keeps its services private.
 *
 * @param {{modules?: Record<string, string>}} [options]
 */
export function createEconomicsCapability(options = {}) {
  const names = economicsNames(options.modules);
  return {
    name: ECONOMICS_CAPABILITY,
    version: 1,
    description: 'Read-only grouped delivery economics for one project: operational estimates, never accounting, and never summed across currencies.',
    create(context) {
      const modules = context?.modules;
      if (!modules) throw new AppError('delivery-economics requires the caller\'s module handles', { code: 'CAPABILITY_INVALID', status: 500 });
      return Object.freeze({
        /** @param {string} deliveryProjectId */
        forProject(deliveryProjectId) {
          const id = requiredString(deliveryProjectId, 'deliveryProjectId');
          // A project that does not exist is a NotFoundError from the service,
          // not an empty answer that reads like "this project costs nothing".
          modules.get(names.project).service.get(id);
          return computeEconomics(gatherEvidence(id, modules, names));
        },
      });
    },
  };
}

/** Function-free schema metadata for the economics surface. */
export function economicsMetadata(costPolicies = []) {
  return {
    economicsContract: 1,
    basis: ECONOMICS_BASIS,
    note: ECONOMICS_NOTE,
    money: {
      units: 'integer minor units, 1/100 of the currency unit, two decimals — no ISO-4217 exponent is claimed',
      rounding: ROUNDING_RULE,
      grouping: 'every total is grouped by currency; there is no FX and two currencies are never summed. Within a currency, commercial input is further grouped by charge type, interval and interval count, and periods are never summed or annualized',
      authority: 'cost is computed server-side from recorded minutes and the policy rate; no client-supplied cost or total is authoritative',
    },
    humanApproval: 'recording time or an expense, publishing a plan and taking a snapshot each require actor.type === "user"; an agent is refused 403 HUMAN_APPROVAL_REQUIRED and may call preview-delivery-economics only. This is a human-actor boundary, not Delivery Manager role enforcement',
    evidence: {
      immutable: 'time entries, expenses, plan versions, plan lines and snapshots have no public create, update or delete; a correction is a new entry',
      recordingStates: {
        'delivery-project': [...RECORDING_PROJECT_STATES],
        'delivery-work-package': [...RECORDING_WORK_PACKAGE_STATES],
      },
      commercialSource: 'the commercial delivery input is the immutable work-package snapshot M13 copied from the M12 delivery obligation; no live catalog, quote or price is read, and an obligation with no deterministic amount is reported as unavailable rather than invented',
    },
    contribution: {
      supportedBasis: 'one_time',
      rule: 'a delivery contribution estimate is computed only where every commercial input in that currency is a one-time amount; otherwise contributionBasis is "unavailable", deliveryContributionEstimateCents is null and contributionUnavailableReason states why',
      unavailableReasons: Object.values(CONTRIBUTION_UNAVAILABLE_REASONS).sort(),
      recurringInput: 'preserved as evidence in commercialInputs[], grouped by charge type, interval and interval count; never annualized, normalized or summed across periods',
    },
    costPolicies: costPolicies.map((entry) => ({
      kind: COST_POLICY_KIND,
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: costPolicyFingerprint(entry.definition),
      configKeys: Object.keys(entry.definition.config ?? {}).sort(),
    })),
    planLineKinds: [...PLAN_LINE_KINDS],
    contributorTypes: [...CONTRIBUTOR_TYPES],
    notModeled: [
      'invoicing', 'payment', 'tax', 'FX or currency conversion', 'accounting',
      'revenue recognition', 'gross or accounting margin', 'profit',
      'payroll', 'employee identity', 'resource scheduling', 'capacity',
      'partner payout', 'billing eligibility', 'receipt or document storage',
      'reimbursement', 'contract term or renewal semantics', 'ARR, MRR or TCV',
      'subscription lifetime value', 'change requests', 'deliverables', 'customer acceptance',
    ],
  };
}
