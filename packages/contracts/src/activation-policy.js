// @ts-check

import { AppError, ValidationError } from '../../core/src/errors.js';

/**
 * The Order Activation Policy: how a signed Order's components become
 * commercial obligations.
 *
 * **Recurrence is not a classification.** A recurring component may be a
 * subscription (a platform fee) or a service obligation (annual support); a
 * one-time component may be delivery work (migration) or something the
 * business simply does not track further. Inferring from `chargeType` alone
 * would silently mis-file real money, so classification is an explicit,
 * versioned, fingerprinted decision — and a component the policy cannot place
 * is `ambiguous`, which **blocks activation** until a human resolves it with a
 * reason.
 *
 * The policy is deterministic and synchronous: no network, no database, no
 * clock, no randomness. It receives a deep-frozen view of what the Order
 * already recorded — never the live catalog.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LABEL = 80;
const MAX_REASON = 300;
const MAX_VERSION = 1_000_000;
/**
 * Control characters are refused in the free text this package stores. The
 * reason is storage truth, not markup fear: SQLite's text binding ends a value
 * at the first NUL byte, so a reason containing one would be persisted
 * *shorter than it was submitted* — an audit record that quietly disagrees with
 * what the human wrote. Refusing is the honest answer; tab, newline and
 * carriage return remain allowed because real people type them.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * `other` is a deliberate, recorded decision — "this component creates no
 * further obligation" — and is not the same as `ambiguous`, which means the
 * policy could not decide and refuses to guess.
 */
export const CLASSIFICATION_TYPES = Object.freeze(['subscription', 'delivery', 'service', 'other', 'ambiguous']);
/** The types a human override may select: never `ambiguous` (that is the problem, not a resolution). */
export const OVERRIDABLE_TYPES = Object.freeze(['subscription', 'delivery', 'service', 'other']);

/** @param {any} definition */
export function defineOrderActivationPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('order activation policy must be an object');
  }
  const label = `order activation policy "${String(definition.name)}"`;
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`${label}: version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label}: label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  if (typeof definition.classifyComponent !== 'function') {
    throw new ValidationError(`${label}: classifyComponent must be a function`);
  }
  return definition;
}

/**
 * Validate one classification result into the bounded contract. A Promise, an
 * unknown type or an unbounded reason is a policy defect and fails closed —
 * activation never proceeds on a result it does not understand.
 *
 * @param {string} label @param {unknown} result
 */
export function normalizeClassification(label, result) {
  if (result instanceof Promise) {
    throw new AppError(`${label} must classify synchronously — Promises are rejected`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AppError(`${label} must return {type, reason}`, { code: 'ACTIVATION_POLICY_INVALID', status: 500 });
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  if (typeof value.type !== 'string' || !CLASSIFICATION_TYPES.includes(/** @type {any} */ (value.type))) {
    throw new AppError(`${label} type must be one of: ${CLASSIFICATION_TYPES.join(', ')}`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  if (value.reason !== undefined && value.reason !== null && (typeof value.reason !== 'string' || value.reason.length === 0)) {
    throw new AppError(`${label} reason must be a non-empty string when present`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  return {
    type: /** @type {'subscription'|'delivery'|'service'|'other'|'ambiguous'} */ (value.type),
    reason: typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON) : null,
  };
}

/**
 * A classification must be coherent with the commercial evidence it describes.
 * The one hard rule: **a subscription line has to recur** — a one-time charge
 * is not a recurring right, and calling it one would put a false amount into
 * every future recurring figure. Delivery and service obligations legitimately
 * carry either recurrence.
 *
 * @param {{type: string}} classification @param {{chargeType: string, componentKey: string}} component
 */
export function assertClassificationCoherent(classification, component) {
  if (classification.type === 'subscription' && component.chargeType !== 'recurring') {
    throw new AppError(
      `Component "${component.componentKey}" is ${component.chargeType} and cannot be a subscription line`,
      { code: 'CLASSIFICATION_INCOHERENT', status: 409, details: { componentKey: component.componentKey } },
    );
  }
  return classification;
}

/**
 * The deep-frozen view a policy classifies. Everything here comes from the
 * **Order snapshot** — no catalog read, no product lookup, no live record.
 *
 * The policy's own declared `config` is included — deep-frozen, structurally
 * cloned — so thresholds and mappings live in the fingerprinted definition
 * rather than in a closure the fingerprint cannot see.
 *
 * @param {{line: any, component: any, order: any, config?: unknown}} source
 */
export function classificationContext({ line, component, order, config }) {
  return deepFreeze({
    config: structuredClone(config ?? {}),
    order: {
      id: order.id,
      currency: order.currency,
      quoteVersionId: order.quoteVersionId,
    },
    line: {
      id: line.id,
      sku: line.sku,
      offerLogicalKey: line.offerLogicalKey,
      offerRevision: line.offerRevision,
      offerName: line.offerName,
      productId: line.productId,
      productVersionId: line.productVersionId,
      quantity: line.quantity,
    },
    component: {
      id: component.id,
      componentKey: component.componentKey,
      label: component.label,
      chargeType: component.chargeType,
      pricingModel: component.pricingModel,
      interval: component.interval,
      intervalCount: component.intervalCount,
      quantity: component.quantity,
      netAmountCents: component.netAmountCents,
      provider: component.provider,
      externalPriceId: component.externalPriceId,
      sourcePricingModel: component.sourcePricingModel,
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
 * Validate the caller-supplied overrides into a bounded, canonical map keyed
 * by component id. An override is a **human** decision: it needs a real
 * reason, and it may not select `ambiguous`.
 *
 * @param {unknown} raw @param {Set<string>} knownComponentIds
 */
export function normalizeOverrides(raw, knownComponentIds) {
  if (raw === undefined || raw === null) return new Map();
  if (!Array.isArray(raw)) {
    throw new ValidationError('classificationOverrides must be an array', { field: 'classificationOverrides' });
  }
  if (raw.length > 100) {
    throw new ValidationError('too many classification overrides', { field: 'classificationOverrides' });
  }
  const out = new Map();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`classificationOverrides[${index}] must be an object`, { field: 'classificationOverrides' });
    }
    const value = /** @type {Record<string, unknown>} */ (entry);
    const componentId = value.orderComponentId;
    if (typeof componentId !== 'string' || componentId === '' || componentId.length > 200) {
      throw new ValidationError(`classificationOverrides[${index}].orderComponentId is required`, { field: 'classificationOverrides' });
    }
    if (!knownComponentIds.has(componentId)) {
      throw new AppError('A classification override targets a component of another order', {
        code: 'OVERRIDE_COMPONENT_UNKNOWN', status: 409, details: { orderComponentId: componentId },
      });
    }
    if (out.has(componentId)) {
      throw new ValidationError('duplicate classification override for one component', { field: 'classificationOverrides' });
    }
    if (typeof value.type !== 'string' || !OVERRIDABLE_TYPES.includes(/** @type {any} */ (value.type))) {
      throw new ValidationError(
        `classificationOverrides[${index}].type must be one of: ${OVERRIDABLE_TYPES.join(', ')}`,
        { field: 'classificationOverrides' },
      );
    }
    const reason = value.reason;
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_REASON) {
      throw new ValidationError(
        `classificationOverrides[${index}].reason is required (1-${MAX_REASON} characters)`,
        { field: 'classificationOverrides' },
      );
    }
    if (CONTROL_RE.test(reason)) {
      throw new ValidationError(
        `classificationOverrides[${index}].reason must not contain control characters`,
        { field: 'classificationOverrides' },
      );
    }
    out.set(componentId, { type: /** @type {any} */ (value.type), reason: reason.trim() });
  });
  return out;
}
