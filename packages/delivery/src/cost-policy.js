// @ts-check

import { ValidationError, computeDefinitionFingerprint, validateDeclaredConfig } from '../../core/index.js';

/**
 * The Delivery Cost Policy (Milestone 14).
 *
 * It answers one bounded question: **what does a minute of this kind of work
 * cost, for planning and variance purposes?** It maps a trusted planning
 * identifier — a resource role reference, a partner engagement, a work-package
 * delivery mode — to a rate per minute in a currency.
 *
 * What it deliberately is not:
 *
 * - **not a costing language.** No expressions, no conditions, no arithmetic
 *   supplied by config. A lookup and a rate, because a rule engine over money
 *   is a product, not a policy.
 * - **not payroll, and not employee identity.** A `resourceRef` is an opaque
 *   operational label the delivery team chose. Nothing here reads an HR system,
 *   claims a salary, or asserts that the reference identifies a real person.
 * - **not accounting.** The rate is an operational planning input. It produces
 *   an estimate, never a recognized cost.
 *
 * The handler is deterministic and synchronous over a deep-frozen input, and the
 * declared `config` is inside the fingerprint (ADR-015), so the *rates* are
 * versioned as strictly as the code.
 */

export const COST_POLICY_KIND = 'delivery-cost-policy';
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@ -]*$/;
const MAX_REF = 120;
const MAX_REASON = 300;
/** A rate per minute in minor units. One million minor units a minute is already absurd. */
const MAX_RATE_PER_MINUTE = 1_000_000;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate a cost policy definition. Same shape as every other versioned
 * definition in the framework: name, version, declared JSON-safe config, and a
 * pure handler.
 *
 * @param {any} definition
 */
export function defineDeliveryCostPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('A delivery cost policy must be an object');
  }
  if (typeof definition.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(definition.name)) {
    throw new ValidationError('A delivery cost policy name must be lowercase, hyphenated and at most 64 characters');
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new ValidationError(`Delivery cost policy "${definition.name}": version must be a positive integer`);
  }
  if (typeof definition.rateFor !== 'function') {
    throw new ValidationError(`Delivery cost policy "${definition.name}": rateFor() is required`);
  }
  validateDeclaredConfig(`delivery cost policy "${definition.name}@${definition.version}"`, definition.config);
  return definition;
}

/**
 * Run a cost policy and bound everything it returns.
 *
 * A policy is trusted to be *written*, not to be *correct*: an unknown shape,
 * an unsafe rate, a mismatched currency or a Promise is a policy defect that
 * fails closed here rather than becoming a wrong number in stored evidence.
 *
 * @param {{policy: any, fingerprint: string, input: any, expectedCurrency: string}} request
 */
export function resolveRate({ policy, fingerprint, input, expectedCurrency }) {
  const frozen = deepFreeze(structuredClone(input));
  const result = policy.rateFor({ ...frozen, config: deepFreeze(structuredClone(policy.config ?? {})) });
  if (result && typeof result.then === 'function') {
    throw new ValidationError(`Delivery cost policy "${policy.name}@${policy.version}" must be synchronous`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError(`Delivery cost policy "${policy.name}@${policy.version}" must return an object`);
  }
  const { ratePerMinuteCents, currency, reason } = result;
  if (!Number.isSafeInteger(ratePerMinuteCents) || ratePerMinuteCents < 0 || ratePerMinuteCents > MAX_RATE_PER_MINUTE) {
    throw new ValidationError(
      `Delivery cost policy "${policy.name}@${policy.version}": ratePerMinuteCents must be a safe integer between 0 and ${MAX_RATE_PER_MINUTE}`,
    );
  }
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    throw new ValidationError(`Delivery cost policy "${policy.name}@${policy.version}": currency must be three uppercase letters`);
  }
  // A rate in a different currency than the work it costs would be an
  // unconvertible number: there is no FX in this framework, deliberately.
  if (currency !== expectedCurrency) {
    throw new ValidationError(
      `Delivery cost policy "${policy.name}@${policy.version}" returned ${currency} for work priced in ${expectedCurrency}; there is no currency conversion in this framework`,
    );
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON)) {
    throw new ValidationError(`Delivery cost policy "${policy.name}@${policy.version}": reason must be a bounded string`);
  }
  return {
    ratePerMinuteCents, currency,
    reason: reason ?? `${policy.name}@${policy.version}`,
    policy: policy.name, policyVersion: policy.version, policyFingerprint: fingerprint,
  };
}

/**
 * A resource reference is an opaque operational label. It is bounded and
 * control-character-free because it is stored free text, and it identifies
 * nobody: see the policy note above.
 *
 * @param {unknown} value @param {string} field
 */
export function requireReference(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_REF) throw new ValidationError(`${field} must be at most ${MAX_REF} characters`);
  if (!REF_RE.test(trimmed)) {
    throw new ValidationError(`${field} must be a plain reference (letters, digits and . _ : @ - and spaces)`);
  }
  return trimmed;
}

/** The fingerprint of a cost policy, declared config included (ADR-015). */
export function costPolicyFingerprint(definition) {
  return computeDefinitionFingerprint({
    type: COST_POLICY_KIND,
    name: definition.name,
    version: definition.version,
    config: definition.config ?? null,
    handlers: [{ property: 'rateFor', source: definition.rateFor }],
  });
}

/** @param {any} value */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export { MAX_RATE_PER_MINUTE, MAX_REF, MAX_REASON };
