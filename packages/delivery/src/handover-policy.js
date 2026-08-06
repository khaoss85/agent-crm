// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The Delivery Handover Policy: what each pending Delivery Obligation becomes
 * when the sale is handed to Delivery.
 *
 * One question per obligation — **who delivers it** — and the framework never
 * guesses the answer from a label. A policy decides from identity the
 * obligation already carries (component key, SKU, product, provider), returns
 * `ambiguous` when it cannot, and `ambiguous` blocks the handover until a
 * human decides with a reason.
 *
 * The policy also proposes the work-package label and which milestones the
 * project needs. Those are *planning* proposals: a human sees them before
 * anything is created, and none of it claims the customer agreed to them.
 *
 * Deterministic and synchronous: no network, no database, no clock, no
 * randomness, and a deep-frozen view of the obligation as its only input.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_LABEL = 120;
const MAX_REASON = 300;
const MAX_VERSION = 1_000_000;
const MAX_MILESTONES = 12;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Who performs the work. `ambiguous` is the absence of a decision, not a third party. */
export const DELIVERY_MODES = Object.freeze(['internal', 'partner', 'ambiguous']);
/** What a human may choose: never `ambiguous` — that is the question, not an answer. */
export const OVERRIDABLE_MODES = Object.freeze(['internal', 'partner']);

/** @param {any} definition */
export function defineDeliveryHandoverPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('delivery handover policy must be an object');
  }
  const label = `delivery handover policy "${String(definition.name)}"`;
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`${label}: version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > 80)) {
    throw new ValidationError(`${label}: label must be a non-empty string of at most 80 characters`);
  }
  if (typeof definition.planObligation !== 'function') {
    throw new ValidationError(`${label}: planObligation must be a function`);
  }
  return definition;
}

/**
 * Validate one policy result into the bounded contract. Anything the runtime
 * does not understand — a Promise, an unknown mode, an unbounded label, a
 * milestone key that is not canonical — is a policy defect and fails closed.
 *
 * @param {string} label @param {unknown} result @param {any} obligation
 */
export function normalizeHandoverDecision(label, result, obligation) {
  if (result instanceof Promise) {
    throw new AppError(`${label} must plan synchronously — Promises are rejected`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError(`${label} must return {deliveryMode, workPackageLabel, milestoneKeys, reason}`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  if (typeof value.deliveryMode !== 'string' || !DELIVERY_MODES.includes(/** @type {any} */ (value.deliveryMode))) {
    throw new AppError(`${label} deliveryMode must be one of: ${DELIVERY_MODES.join(', ')}`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  const workPackageLabel = boundedText(label, value.workPackageLabel ?? obligation.label ?? obligation.componentKey, 'workPackageLabel', MAX_LABEL);
  const milestoneKeys = normalizeMilestoneKeys(label, value.milestoneKeys);
  return {
    deliveryMode: /** @type {'internal'|'partner'|'ambiguous'} */ (value.deliveryMode),
    workPackageLabel,
    milestoneKeys,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON) : null,
  };
}

/** @param {string} label @param {unknown} raw */
function normalizeMilestoneKeys(label, raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError(`${label} milestoneKeys must be an array`, { code: 'HANDOVER_POLICY_INVALID', status: 500 });
  }
  if (raw.length > MAX_MILESTONES) {
    throw new AppError(`${label} proposed more than ${MAX_MILESTONES} milestones`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  const out = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !KEY_RE.test(key) || key.length > 40) {
      throw new AppError(`${label} milestone keys must match ${KEY_RE}`, {
        code: 'HANDOVER_POLICY_INVALID', status: 500,
      });
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** @param {string} label @param {unknown} value @param {string} field @param {number} max */
function boundedText(label, value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`${label} ${field} must be a non-empty string`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  if (value.length > max || CONTROL_RE.test(value)) {
    throw new AppError(`${label} ${field} must be at most ${max} characters and free of control characters`, {
      code: 'HANDOVER_POLICY_INVALID', status: 500,
    });
  }
  return value.trim();
}

/**
 * The deep-frozen view a policy plans from: the obligation snapshot the
 * contracts package published, plus the policy's own declared config. No live
 * catalog, no contract internals, no CRM row.
 *
 * @param {{obligation: any, contract: any, config?: unknown}} source
 */
export function handoverContext({ obligation, contract, config }) {
  return deepFreeze({
    config: structuredClone(config ?? {}),
    contract: {
      id: contract.id,
      currency: contract.currency,
      customerName: contract.customerName,
      effectiveDate: contract.effectiveDate,
      termStartDate: contract.termStartDate,
      termEndDate: contract.termEndDate,
    },
    obligation: {
      id: obligation.id,
      componentKey: obligation.componentKey,
      label: obligation.label,
      sku: obligation.sku,
      chargeType: obligation.chargeType,
      interval: obligation.interval,
      intervalCount: obligation.intervalCount,
      quantity: obligation.quantity,
      netAmountCents: obligation.netAmountCents,
      currency: obligation.currency,
      productId: obligation.productId,
      productVersionId: obligation.productVersionId,
      provider: obligation.provider,
    },
  });
}

/** @param {any} value */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Human overrides of the delivery mode. One decision per obligation, with a
 * real reason: choosing who performs contracted work is a commitment, not a
 * dropdown default.
 *
 * @param {unknown} raw @param {Set<string>} knownObligationIds
 */
export function normalizeModeOverrides(raw, knownObligationIds) {
  if (raw === undefined || raw === null) return new Map();
  if (!Array.isArray(raw)) {
    throw new ValidationError('modeOverrides must be an array', { field: 'modeOverrides' });
  }
  if (raw.length > 100) {
    throw new ValidationError('too many mode overrides', { field: 'modeOverrides' });
  }
  const out = new Map();
  raw.forEach((entry, index) => {
    const field = 'modeOverrides';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`modeOverrides[${index}] must be an object`, { field });
    }
    const value = /** @type {Record<string, unknown>} */ (entry);
    const obligationId = value.obligationId;
    if (typeof obligationId !== 'string' || obligationId === '' || obligationId.length > 200) {
      throw new ValidationError(`modeOverrides[${index}].obligationId is required`, { field });
    }
    if (!knownObligationIds.has(obligationId)) {
      throw new AppError('A mode override targets an obligation of another contract', {
        code: 'OVERRIDE_OBLIGATION_UNKNOWN', status: 409, details: { obligationId },
      });
    }
    if (out.has(obligationId)) {
      throw new ValidationError('duplicate mode override for one obligation', { field });
    }
    if (typeof value.deliveryMode !== 'string' || !OVERRIDABLE_MODES.includes(/** @type {any} */ (value.deliveryMode))) {
      throw new ValidationError(
        `modeOverrides[${index}].deliveryMode must be one of: ${OVERRIDABLE_MODES.join(', ')}`,
        { field },
      );
    }
    const reason = value.reason;
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_REASON) {
      throw new ValidationError(`modeOverrides[${index}].reason is required (1-${MAX_REASON} characters)`, { field });
    }
    if (CONTROL_RE.test(reason)) {
      throw new ValidationError(`modeOverrides[${index}].reason must not contain control characters`, { field });
    }
    out.set(obligationId, { deliveryMode: /** @type {any} */ (value.deliveryMode), reason: reason.trim() });
  });
  return out;
}

/**
 * The optional third-party partner. It is a **business reference and a name
 * snapshot** — not a principal, not an account, not an invitation. M13 grants
 * a partner no access of any kind, and this validation says so by refusing
 * anything that looks like a credential-bearing structure.
 *
 * @param {unknown} raw
 */
export function normalizePartner(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('partner must be an object', { field: 'partner' });
  }
  const value = /** @type {Record<string, unknown>} */ (raw);
  const ref = value.partnerRef;
  if (typeof ref !== 'string' || ref.trim() === '' || ref.length > 120 || CONTROL_RE.test(ref)) {
    throw new ValidationError('partner.partnerRef is required (1-120 characters, no control characters)', { field: 'partner' });
  }
  const name = value.partnerName;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200 || CONTROL_RE.test(name)) {
    throw new ValidationError('partner.partnerName is required (1-200 characters, no control characters)', { field: 'partner' });
  }
  const reason = value.reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON || CONTROL_RE.test(reason))) {
    throw new ValidationError('partner.reason must be a bounded string', { field: 'partner' });
  }
  return { partnerRef: ref.trim(), partnerName: name.trim(), reason: typeof reason === 'string' ? reason.trim() : null };
}
