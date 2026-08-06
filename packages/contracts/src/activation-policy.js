// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The Order Activation Policy: how a signed Order's components become
 * commercial obligations.
 *
 * **Classification has two dimensions, because commerce does.** A component
 * answers two independent questions:
 *
 *   1. *commercial activation* — is this a recurring right the customer keeps
 *      paying for (a Subscription Line), or not?
 *   2. *obligations* — does it also commit us to future work (delivery) or
 *      future service?
 *
 * Annual premium support is the case that proves it: it is a recurring
 * commercial commitment **and** a future service obligation. A single
 * exclusive axis has to drop one of them, and dropping the first quietly
 * removes real recurring money from the subscription.
 *
 * **Recurrence still decides nothing.** A recurring component may owe no
 * obligation at all (metered API capacity), and a one-time component may owe
 * delivery work (migration). Both axes are explicit, versioned, fingerprinted
 * decisions, and either one can be `ambiguous` — which blocks activation until
 * a human resolves *that dimension* with a reason.
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

/** Dimension 1: what the money is. `non_subscription` is a decision, not a gap. */
export const COMMERCIAL_ACTIVATIONS = Object.freeze(['subscription', 'non_subscription', 'ambiguous']);
/** The values a human may choose for dimension 1: never `ambiguous`. */
export const OVERRIDABLE_COMMERCIAL = Object.freeze(['subscription', 'non_subscription']);
/** Dimension 2: what we owe beyond the money. An empty list is a decision too. */
export const OBLIGATION_TYPES = Object.freeze(['delivery', 'service']);
/** The marker a policy returns when it cannot decide dimension 2 at all. */
export const OBLIGATIONS_AMBIGUOUS = 'ambiguous';
export const DIMENSIONS = Object.freeze(['commercial', 'obligations']);

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
 * Validate one classification result into the bounded two-axis contract. A
 * Promise, an unknown value or an unbounded reason is a policy defect and
 * fails closed — activation never proceeds on a result it does not understand.
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
    throw new AppError(`${label} must return {commercialActivation, obligations, reason}`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  if (typeof value.commercialActivation !== 'string' || !COMMERCIAL_ACTIVATIONS.includes(/** @type {any} */ (value.commercialActivation))) {
    throw new AppError(`${label} commercialActivation must be one of: ${COMMERCIAL_ACTIVATIONS.join(', ')}`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  const obligations = normalizePolicyObligations(label, value.obligations);
  if (value.reason !== undefined && value.reason !== null && (typeof value.reason !== 'string' || value.reason.length === 0)) {
    throw new AppError(`${label} reason must be a non-empty string when present`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  return {
    commercialActivation: /** @type {'subscription'|'non_subscription'|'ambiguous'} */ (value.commercialActivation),
    obligations,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON) : null,
  };
}

/**
 * The obligations axis: a bounded set, `'ambiguous'` when the policy cannot
 * decide it, and `[]` when it decided that nothing further is owed. Ordered
 * canonically so two equivalent answers store identically.
 *
 * @param {string} label @param {unknown} raw
 */
function normalizePolicyObligations(label, raw) {
  if (raw === undefined || raw === null) return [];
  if (raw === OBLIGATIONS_AMBIGUOUS) return OBLIGATIONS_AMBIGUOUS;
  if (!Array.isArray(raw)) {
    throw new AppError(`${label} obligations must be an array or "${OBLIGATIONS_AMBIGUOUS}"`, {
      code: 'ACTIVATION_POLICY_INVALID', status: 500,
    });
  }
  if (raw.length === 1 && raw[0] === OBLIGATIONS_AMBIGUOUS) return OBLIGATIONS_AMBIGUOUS;
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !OBLIGATION_TYPES.includes(/** @type {any} */ (entry))) {
      throw new AppError(`${label} obligations may only contain: ${OBLIGATION_TYPES.join(', ')}`, {
        code: 'ACTIVATION_POLICY_INVALID', status: 500,
      });
    }
    if (out.includes(entry)) {
      throw new AppError(`${label} returned a duplicate obligation "${entry}"`, {
        code: 'ACTIVATION_POLICY_INVALID', status: 500,
      });
    }
    out.push(entry);
  }
  return canonicalObligations(out);
}

/** Canonical order, so the stored evidence of one decision is one string. */
export function canonicalObligations(list) {
  return OBLIGATION_TYPES.filter((type) => list.includes(type));
}

/**
 * A classification must be coherent with the commercial evidence it describes.
 * The one hard rule: **a subscription line has to recur** — a one-time charge
 * is not a recurring right, and calling it one would put a false amount into
 * every future recurring figure. Delivery and service obligations legitimately
 * carry either recurrence, which is exactly why they are a separate axis.
 *
 * @param {{commercialActivation: string}} classification
 * @param {{chargeType: string, componentKey: string}} component
 */
export function assertClassificationCoherent(classification, component) {
  if (classification.commercialActivation === 'subscription' && component.chargeType !== 'recurring') {
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
 * by `componentId/dimension`. An override is a **human** decision about **one
 * dimension**: it names which axis it replaces, it needs a real reason, and it
 * may not select the ambiguity it is supposed to resolve.
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
    const field = 'classificationOverrides';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`classificationOverrides[${index}] must be an object`, { field });
    }
    const value = /** @type {Record<string, unknown>} */ (entry);
    const componentId = value.orderComponentId;
    if (typeof componentId !== 'string' || componentId === '' || componentId.length > 200) {
      throw new ValidationError(`classificationOverrides[${index}].orderComponentId is required`, { field });
    }
    if (!knownComponentIds.has(componentId)) {
      throw new AppError('A classification override targets a component of another order', {
        code: 'OVERRIDE_COMPONENT_UNKNOWN', status: 409, details: { orderComponentId: componentId },
      });
    }
    const dimension = value.dimension;
    if (typeof dimension !== 'string' || !DIMENSIONS.includes(/** @type {any} */ (dimension))) {
      throw new ValidationError(
        `classificationOverrides[${index}].dimension must be one of: ${DIMENSIONS.join(', ')}`,
        { field },
      );
    }
    const key = `${componentId}/${dimension}`;
    if (out.has(key)) {
      throw new ValidationError(`duplicate classification override for one component dimension (${dimension})`, { field });
    }
    const decided = dimension === 'commercial'
      ? requireCommercialValue(index, value.value)
      : requireObligationsValue(index, value.value);
    out.set(key, {
      orderComponentId: componentId,
      dimension,
      value: decided,
      reason: requireOverrideReason(index, value.reason),
    });
  });
  return out;
}

/** @param {number} index @param {unknown} value */
function requireCommercialValue(index, value) {
  if (typeof value !== 'string' || !OVERRIDABLE_COMMERCIAL.includes(/** @type {any} */ (value))) {
    throw new ValidationError(
      `classificationOverrides[${index}].value must be one of: ${OVERRIDABLE_COMMERCIAL.join(', ')}`,
      { field: 'classificationOverrides' },
    );
  }
  return value;
}

/** @param {number} index @param {unknown} value */
function requireObligationsValue(index, value) {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `classificationOverrides[${index}].value must be an array of obligations (use [] for none)`,
      { field: 'classificationOverrides' },
    );
  }
  if (value.length > OBLIGATION_TYPES.length) {
    throw new ValidationError(`classificationOverrides[${index}].value has too many obligations`, {
      field: 'classificationOverrides',
    });
  }
  const seen = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !OBLIGATION_TYPES.includes(/** @type {any} */ (entry))) {
      throw new ValidationError(
        `classificationOverrides[${index}].value may only contain: ${OBLIGATION_TYPES.join(', ')}`,
        { field: 'classificationOverrides' },
      );
    }
    if (seen.includes(entry)) {
      throw new ValidationError(`classificationOverrides[${index}].value has a duplicate obligation`, {
        field: 'classificationOverrides',
      });
    }
    seen.push(entry);
  }
  return canonicalObligations(seen);
}

/** @param {number} index @param {unknown} reason */
function requireOverrideReason(index, reason) {
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
  return reason.trim();
}
