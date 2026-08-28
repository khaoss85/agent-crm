// @ts-check

import { AppError } from './errors.js';

/**
 * A thenable used where a domain value, decision, capability or service is
 * required is the Promise-as-v1-value failure M2E-2C refuses at the first
 * observable execution seam. Native Promises and `{ then }` traps both count.
 *
 * @param {unknown} value
 */
export function isThenable(value) {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && typeof /** @type {{ then?: unknown }} */ (value).then === 'function',
  );
}

/**
 * @param {string} label
 */
export function thenableDomainValueError(label) {
  return new AppError(
    `Refusing thenable ${label} as a domain value; async-v2 results must be awaited at the execution seam`,
    {
      code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
      status: 500,
      details: { label },
    },
  );
}

/**
 * Refuse a thenable standing in for a settled service, decision, capability or
 * HTTP/domain payload. Nested `items` / `body` / `result` thenables are the
 * HTTP envelope shape that would otherwise JSON.stringify to `{}`.
 *
 * @param {unknown} value
 * @param {string} [label]
 */
export function refuseThenableDomainValue(value, label = 'value') {
  if (isThenable(value)) {
    throw thenableDomainValueError(label);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of ['items', 'body', 'result']) {
      if (Object.prototype.hasOwnProperty.call(record, key) && isThenable(record[key])) {
        throw thenableDomainValueError(`${label}.${key}`);
      }
    }
  }
  return value;
}

/**
 * Contract 2 settles a thenable; every contract then refuses a still-thenable
 * standing in for the domain value.
 *
 * @param {unknown} value
 * @param {number} contract
 * @param {string} [label]
 */
export async function settleContractValue(value, contract, label = 'value') {
  let settled = value;
  if (contract === 2 && isThenable(settled)) {
    settled = await settled;
  }
  return refuseThenableDomainValue(settled, label);
}
