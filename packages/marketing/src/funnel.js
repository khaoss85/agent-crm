// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * Funnel drop insight derivation (MK1).
 *
 * Pure and deterministic: the same steps over the same counts always yield the
 * same insight, and the rule is fingerprinted nowhere because it is not a
 * decision — it is arithmetic. The *reading* of the insight (which campaign a
 * drop deserves) belongs to the proposal policy; this module only names the
 * largest relative step-to-step loss.
 *
 * A run with no measurable drop produces NO insight (null): the framework
 * says "nothing to propose from" rather than rendering a half-filled cause.
 */

const MAX_STEPS = 64;

/** @param {unknown} value @param {string} label */
function requireSteps(value, label) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_STEPS) {
    throw new ValidationError(`${label} must list between 2 and ${MAX_STEPS} steps`);
  }
  for (const step of value) {
    if (typeof step !== 'string' || step.trim() === '' || step.length > 120) {
      throw new ValidationError(`${label} steps must be non-blank strings of at most 120 characters`);
    }
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} length */
function requireCounts(value, label, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new ValidationError(`${label} must carry exactly one count per step (${length})`);
  }
  for (const count of value) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ValidationError(`${label} counts must be non-negative safe integers`);
    }
  }
  return value;
}

/**
 * Derive the single largest relative drop between consecutive steps.
 *
 * Answers null when no drop is measurable: a monotone non-decreasing run, or
 * a run whose only losses start from a zero count (a rate from zero is not a
 * measurement). Ties resolve to the earliest step, so the answer is stable.
 *
 * @param {{steps: unknown, counts: unknown}} run
 * @returns {{stepIndex: number, step: string, previousStep: string, previousCount: number, stepCount: number, dropRateBps: number} | null} basis points, integer, truncated
 */
export function deriveDropInsight(run) {
  const steps = requireSteps(run?.steps, 'funnel run');
  const counts = requireCounts(run?.counts, 'funnel run', steps.length);
  let best = null;
  for (let index = 1; index < steps.length; index += 1) {
    const previous = counts[index - 1];
    const current = counts[index];
    if (previous <= 0 || current >= previous) continue;
    const dropRateBps = Number((BigInt(previous - current) * 10000n) / BigInt(previous));
    if (dropRateBps <= 0) continue;
    if (!best || dropRateBps > best.dropRateBps) {
      best = {
        stepIndex: index,
        step: steps[index],
        previousStep: steps[index - 1],
        previousCount: previous,
        stepCount: current,
        dropRateBps,
      };
    }
  }
  return best ? Object.freeze(best) : null;
}
