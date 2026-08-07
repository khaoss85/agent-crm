// @ts-check

import {
  AppError, ValidationError, computeDefinitionFingerprint, optionalString, requiredString,
} from '../../core/index.js';
import {
  AMBIGUOUS, CASE_PRIORITIES, SERVICE_POLICY_KIND, decideEntitlement,
} from './activation-policy.js';

export { CASE_PRIORITIES };

/**
 * Service Operations (Milestone 15).
 *
 * M12 raised pending Service Obligations when a contract activated, and then
 * stopped. This turns them into an operational support relationship: coverage,
 * entitlements, support cases, elapsed-time SLA evidence and manually recorded
 * escalation.
 *
 * Five rules decide everything here:
 *
 * - **it is not a contract.** A Service Coverage is operational. Nobody signed
 *   it, it has no envelope, signer or artifact, and it neither amends nor
 *   replaces the Commercial Contract it was activated from. The word
 *   *coverage* is chosen so that nothing here reads as a second agreement.
 * - **the commercial record is never touched.** Activation consumes service
 *   obligations through a declared capability and writes nothing else in
 *   contracts. No Quote, Order, Contract, Contract Version or Subscription is
 *   created or altered; nothing is priced, recognized or invoiced.
 * - **a case is evidence, not authentication.** Every case, note and reply is
 *   what a **user actor** recorded. No customer is authenticated, nothing is
 *   emailed, called or messaged, and no channel integration exists.
 * - **SLA is elapsed time, and says so.** Targets are wall-clock minutes from
 *   the injected UTC clock. There is no business-hours calendar, no holiday
 *   table, no paused clock and no contractual interpretation. A stored
 *   evaluation is what the clock said at a stated instant, never current truth.
 * - **deciding is a human decision.** Every writing action requires
 *   `actor.type === 'user'`; an agent is refused `403`. A human-actor boundary,
 *   **not RBAC** — there are no roles to enforce.
 */

export const SERVICE_PACKAGE = 'service';
export const REQUIRED_CAPABILITY = Object.freeze({ package: 'contracts', capability: 'service-obligations', version: 1 });

export const COVERAGE_STATES = Object.freeze(['planned', 'active', 'ended']);
export const CASE_STATES = Object.freeze(['new', 'in_progress', 'waiting_customer', 'resolved', 'closed']);
/** Every allowed move, as data. A state with no row is terminal by declaration. */
export const CASE_TRANSITIONS = Object.freeze({
  new: Object.freeze(['in_progress', 'waiting_customer', 'resolved']),
  in_progress: Object.freeze(['waiting_customer', 'resolved']),
  waiting_customer: Object.freeze(['in_progress', 'resolved']),
  resolved: Object.freeze(['closed']),
  closed: Object.freeze([]),
});
export const ACTIVITY_TYPES = Object.freeze(['note', 'transition', 'customer_reply', 'internal_note', 'escalation']);
export const VISIBILITY = Object.freeze(['internal', 'customer_visible']);
export const ESCALATION_LEVELS = Object.freeze(['internal', 'management', 'vendor']);
export const SLA_STATES = Object.freeze(['met', 'on_track', 'at_risk', 'breached', 'not_applicable']);
/** A case may be opened only while the coverage is genuinely running. */
export const OPENING_COVERAGE_STATES = Object.freeze(['active']);
/** The share of the window that counts as "nearly out of time". */
export const AT_RISK_FRACTION = 0.25;

const MAX_TEXT = 4_000;
const MAX_LABEL = 200;
const MAX_KEY = 120;
const MAX_REF = 200;
const MAX_OBLIGATIONS = 500;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
const LINE_BREAKS = /[\r\n\t]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      code: 'SERVICE_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

function boundedText(value, field, { required = false, max = MAX_TEXT, singleLine = false } = {}) {
  const text = required ? requiredString(value, field) : optionalString(value, field);
  if (text === null) return null;
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  if (CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  // A case description is prose and legitimately has newlines. A title, a
  // category, a tier or a reference is one line by definition, and a newline in
  // one is either a paste accident or an attempt to fake a second row in a list.
  if (singleLine && LINE_BREAKS.test(text)) {
    throw new ValidationError(`${field} must be a single line`, { field });
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

function oneOf(value, allowed, field) {
  const text = requiredString(value, field);
  if (!allowed.includes(text)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return text;
}

function actorId(actor) {
  return String(actor?.id ?? 'unknown').slice(0, MAX_REF);
}

/** A retry answers from storage only once it has proved it is the same call. */
function requireSameRecord(existing, fields, what) {
  const changed = Object.entries(fields)
    .filter(([field, value]) => (existing[field] ?? null) !== (value ?? null))
    .map(([field]) => field)
    .sort();
  if (changed.length === 0) return;
  throw new AppError(
    `This key already recorded a different ${what} (${changed.join(', ')} differ). Recorded evidence is never edited: record a correction as a new entry with its own key.`,
    { code: 'SERVICE_EVIDENCE_CONFLICT', status: 409, details: { id: existing.id, fields: changed } },
  );
}

function bySourceKey(service, sourceKey) {
  const rows = service.listWhere({ sourceKey });
  return rows.length > 0 ? rows[0] : null;
}

/** Record-module names, overridable by a project that renamed them. */
export function serviceNames(config = {}) {
  return {
    coverage: config.coverage ?? 'service-coverage',
    entitlement: config.entitlement ?? 'service-entitlement',
    activationRun: config.activationRun ?? 'service-activation-run',
    supportCase: config.supportCase ?? 'support-case',
    caseActivity: config.caseActivity ?? 'support-case-activity',
    slaEvaluation: config.slaEvaluation ?? 'service-sla-evaluation',
    escalation: config.escalation ?? 'service-escalation',
    contract: config.contract ?? 'commercial-contract',
  };
}

/** The fingerprint of a service activation policy, declared config included. */
export function servicePolicyFingerprint(definition) {
  return computeDefinitionFingerprint({
    type: SERVICE_POLICY_KIND,
    name: definition.name,
    version: definition.version,
    config: definition.config ?? null,
    handlers: [{ property: 'decide', source: definition.decide }],
  });
}

/**
 * Open the contracts capability. An undeclared reach is refused by the registry
 * itself; an application without the contracts package fails here with a stable
 * code rather than a missing-module stack trace.
 */
function obligationsCapability({ domains, modules, actor, now }) {
  try {
    return domains.capability({
      consumer: SERVICE_PACKAGE,
      capability: REQUIRED_CAPABILITY.capability,
      version: REQUIRED_CAPABILITY.version,
      context: { modules, actor, now },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      'The service package requires the contracts package capability service-obligations@1, which is not available',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/** The activation policy this application composed, chosen explicitly. */
function activationPolicy(policies, requested) {
  const available = policies ?? [];
  if (available.length === 0) {
    throw new AppError('No service activation policy is registered, so no entitlement can be decided', {
      code: 'SERVICE_POLICY_MISSING', status: 409,
    });
  }
  const name = optionalString(requested?.policy, 'policy');
  const version = requested?.policyVersion;
  if (version !== undefined && version !== null && !Number.isSafeInteger(version)) {
    throw new ValidationError('policyVersion must be a whole number', { field: 'policyVersion' });
  }
  const wanted = version === undefined || version === null ? null : Number(version);
  const found = available.find((entry) => (name === null || entry.definition.name === name)
    && (wanted === null || entry.definition.version === wanted));
  if (!found) {
    throw new AppError(`Service activation policy "${name ?? 'any'}@${wanted ?? 'any'}" is not registered`, {
      code: 'SERVICE_POLICY_MISSING', status: 409,
      details: { available: available.map((entry) => `${entry.definition.name}@${entry.definition.version}`) },
    });
  }
  return { policy: found.definition, fingerprint: servicePolicyFingerprint(found.definition) };
}

/**
 * The whole activation decision, computed from the source and the policy alone.
 *
 * `plan-service-activation` returns this and writes nothing. `activate-service`
 * recomputes it server-side and writes from *its own* result — a client may say
 * which policy to use and may resolve an ambiguity, but it never supplies the
 * outcome.
 */
function computeActivation({ contract, obligations, policy, fingerprint, overrides }) {
  const entitlements = [];
  const ambiguous = [];
  for (const obligation of obligations) {
    const decision = decideEntitlement(policy, { obligation, contract });
    if (decision.outcome === AMBIGUOUS) {
      const override = overrides.get(obligation.id);
      if (!override) {
        ambiguous.push({ obligationId: obligation.id, label: obligation.label, reason: decision.reason });
        continue;
      }
      entitlements.push({
        obligationId: obligation.id,
        label: obligation.label,
        supportTier: override.supportTier,
        categories: override.categories,
        priorities: override.priorities,
        firstResponseTargetMinutes: override.firstResponseTargetMinutes,
        resolutionTargetMinutes: override.resolutionTargetMinutes,
        maxOpenCases: override.maxOpenCases,
        decidedBy: 'human-override',
        reason: override.reason,
      });
      continue;
    }
    entitlements.push({
      obligationId: obligation.id,
      label: obligation.label,
      supportTier: decision.supportTier,
      categories: decision.categories,
      priorities: decision.priorities,
      firstResponseTargetMinutes: decision.firstResponseTargetMinutes,
      resolutionTargetMinutes: decision.resolutionTargetMinutes,
      maxOpenCases: decision.maxOpenCases,
      decidedBy: 'policy',
      reason: decision.reason,
    });
  }
  entitlements.sort((a, b) => (a.obligationId < b.obligationId ? -1 : 1));
  ambiguous.sort((a, b) => (a.obligationId < b.obligationId ? -1 : 1));
  return {
    contractId: contract.id,
    policy: policy.name,
    policyVersion: policy.version,
    policyFingerprint: fingerprint,
    obligationIds: obligations.map((row) => row.id).sort(),
    entitlements,
    ambiguous,
    decidable: ambiguous.length === 0,
  };
}

/** Overrides a human supplied, validated exactly like a policy decision. */
function readOverrides(input) {
  const raw = input?.overrides;
  const map = new Map();
  if (raw === undefined || raw === null) return map;
  if (!Array.isArray(raw)) throw new ValidationError('overrides must be an array', { field: 'overrides' });
  if (raw.length > MAX_OBLIGATIONS) throw new ValidationError('overrides is too large', { field: 'overrides' });
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`overrides[${index}] must be an object`, { field: 'overrides' });
    }
    const obligationId = requiredString(entry.serviceObligationId, `overrides[${index}].serviceObligationId`);
    if (map.has(obligationId)) {
      throw new ValidationError(`overrides[${index}] repeats "${obligationId}"`, { field: 'overrides' });
    }
    const categories = entry.categories;
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new ValidationError(`overrides[${index}].categories must be a non-empty array`, { field: 'overrides' });
    }
    map.set(obligationId, {
      supportTier: boundedText(entry.supportTier, `overrides[${index}].supportTier`, { required: true, max: 60 }),
      categories: categories.map((value, position) =>
        boundedText(value, `overrides[${index}].categories[${position}]`, { required: true, max: 60 })).sort(),
      priorities: Array.isArray(entry.priorities) && entry.priorities.length > 0
        ? CASE_PRIORITIES.filter((priority) => entry.priorities.includes(priority))
        : [...CASE_PRIORITIES],
      firstResponseTargetMinutes: wholeMinutes(entry.firstResponseTargetMinutes, `overrides[${index}].firstResponseTargetMinutes`),
      resolutionTargetMinutes: wholeMinutes(entry.resolutionTargetMinutes, `overrides[${index}].resolutionTargetMinutes`),
      maxOpenCases: entry.maxOpenCases === undefined || entry.maxOpenCases === null
        ? null : wholeMinutes(entry.maxOpenCases, `overrides[${index}].maxOpenCases`),
      // A human override without a stated reason is a guess with a signature on
      // it: the whole point of the override is that somebody explains it.
      reason: boundedText(entry.reason, `overrides[${index}].reason`, { required: true, max: MAX_LABEL }),
    });
  }
  return map;
}

function wholeMinutes(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive whole number`, { field });
  }
  return value;
}

/** Minutes added to an ISO instant, as an ISO instant. No local timezone. */
export function addMinutes(iso, minutes) {
  if (minutes === null || minutes === undefined) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    throw new AppError('The clock produced an unreadable timestamp', { code: 'SERVICE_CLOCK_INVALID', status: 500 });
  }
  return new Date(at + minutes * 60_000).toISOString();
}

/**
 * The elapsed-time judgement for one case at one instant.
 *
 * Deliberately total and deliberately small: no calendar, no pause, no
 * contractual reading. `waiting_customer` does **not** stop the clock — pausing
 * needs accumulated-time evidence, and a half-implemented pause understates a
 * breach, which is the direction that hurts.
 */
export function evaluateSla(record, at) {
  const now = Date.parse(at);
  const measure = (dueAt, answeredAt) => {
    if (!dueAt) return 'not_applicable';
    if (answeredAt) return Date.parse(answeredAt) <= Date.parse(dueAt) ? 'met' : 'breached';
    const due = Date.parse(dueAt);
    if (now > due) return 'breached';
    const opened = Date.parse(record.openedAt);
    const window = due - opened;
    if (window <= 0) return 'breached';
    return (due - now) / window <= AT_RISK_FRACTION ? 'at_risk' : 'on_track';
  };
  return {
    evaluatedAt: at,
    firstResponseState: measure(record.firstResponseDueAt, record.firstRespondedAt),
    resolutionState: measure(record.resolutionDueAt, record.resolvedAt ?? record.closedAt),
    openedAt: record.openedAt,
    firstResponseDueAt: record.firstResponseDueAt ?? null,
    resolutionDueAt: record.resolutionDueAt ?? null,
    firstRespondedAt: record.firstRespondedAt ?? null,
    resolvedAt: record.resolvedAt ?? null,
    basis: 'elapsed wall-clock minutes from openedAt against the injected UTC clock; no business hours, no holidays, no paused clock, and no contractual SLA interpretation',
  };
}

/** Coverage in a state that permits the operation. */
function coverageIn(coverage, allowed, operation) {
  if (!allowed.includes(coverage.status)) {
    throw new AppError(
      `service-coverage "${coverage.id}" must be ${allowed.join(' or ')} to ${operation} (it is "${coverage.status}")`,
      { code: 'SERVICE_STATE_NOT_ALLOWED', status: 409, details: { id: coverage.id, state: coverage.status, allowed: [...allowed] } },
    );
  }
  return coverage;
}

/**
 * The two key namespaces on `support-case-activity`.
 *
 * They exist because the caller's `activityKey` and the keys the framework
 * writes itself used to share one namespace, and `sourceKey` is unique. A
 * caller who recorded a note under the key `first-response` — or
 * `transition:resolved:closed` — permanently blocked the action that owns it,
 * on records that are append-only and can never be corrected.
 *
 * The prefixes make that collision structurally impossible in both directions.
 */
const CALLER_ACTIVITY = 'user';
const SYSTEM_ACTIVITY = 'system';

/** The source key for an activity a caller asked for, by their own key. */
function callerActivityKey(supportCaseId, activityKey) {
  return `support-case-activity:${supportCaseId}:${CALLER_ACTIVITY}:${activityKey}`;
}

/**
 * The ordinal of the next activity on a case.
 *
 * A transition's evidence used to be keyed `transition:<from>:<to>`, which is
 * not unique: `in_progress → waiting_customer → in_progress → waiting_customer`
 * is the ordinary support loop, and its fourth move collided with its own
 * earlier evidence and left the case stuck. Every activity write increments
 * this, so the ordinal is strictly increasing per case and unique per
 * occurrence — and a second connection racing the same move is serialized by
 * the outer transaction and refused by the state machine before it gets here.
 */
function activitySequence(activities, supportCaseId) {
  return activities.listWhere({ supportCaseId }).length;
}

/** Append-only activity, written by every action that changes a case. */
async function recordActivity(activities, { supportCaseId, serviceCoverageId, type, body, evidenceRef, visibility, fromStatus, toStatus, actor, now, key }) {
  return activities.createManaged({
    sourceKey: `support-case-activity:${supportCaseId}:${SYSTEM_ACTIVITY}:${key}`,
    supportCaseId,
    serviceCoverageId,
    type,
    body: body ?? null,
    evidenceRef: evidenceRef ?? null,
    visibility: visibility ?? 'internal',
    fromStatus: fromStatus ?? null,
    toStatus: toStatus ?? null,
    recordedBy: actorId(actor),
    occurredAt: now(),
  }, { actor });
}

export { computeActivation, readOverrides, activationPolicy, obligationsCapability, trusted, boundedText, calendarDate, oneOf, actorId, requireHuman, requireSameRecord, bySourceKey, coverageIn, recordActivity, activitySequence, callerActivityKey, MAX_TEXT, MAX_LABEL, MAX_KEY, MAX_REF };
