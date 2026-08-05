// @ts-check

import { ValidationError } from './errors.js';

/** @param {unknown} value @param {string} field */
export function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
export function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
export function requiredEmail(value, field = 'email') {
  const email = requiredString(value, field).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError(`${field} must be a valid email`, { field });
  }
  return email;
}

/** @param {unknown} value @param {string} field */
export function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, { field });
  }
  return Number(value);
}

/** @param {unknown} value @param {string[]} allowed @param {string} field */
export function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`, {
      field,
      allowed,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function optionalIsoDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

/** @param {unknown} value @param {string} field */
export function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function requiredInteger(value, field) {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`, { field });
  }
  return Number(value);
}

/** @param {unknown} value @param {string} field */
export function optionalInteger(value, field) {
  if (value === undefined || value === null) return null;
  return requiredInteger(value, field);
}

/** @param {unknown} value @param {string[]} allowed @param {string} field */
export function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null;
  return enumValue(value, allowed, field);
}

/** @param {unknown} value @param {string} field */
export function optionalEmail(value, field = 'email') {
  if (value === undefined || value === null || value === '') return null;
  return requiredEmail(value, field);
}

/** @param {unknown} value @param {string} field */
export function requiredIsoDate(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

/** @param {unknown} value @param {string} field */
export function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`, { field });
  }
  return value;
}
