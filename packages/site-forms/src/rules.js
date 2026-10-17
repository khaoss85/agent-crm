// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError } from '../../core/index.js';

/**
 * Site-form intake rules (backlog:9d42035eca26).
 *
 * Pure functions only: no database, no clock, no randomness. The action and
 * the operations in `index.js` supply the rows and the timestamps; everything
 * decidable is decided here so the tests pin the rule without a database.
 *
 * Three rules:
 * 1. **Field bounds** — a form request is bounded text. Anything unbounded,
 *    hostile or missing is refused before a row names it.
 * 2. **Base anti-spam** — honeypot, minimum dwell time and a per-submitter
 *    rate window over the package's own submission rows. No paid service, no
 *    tracker, no third party sees the request.
 * 3. **Reply channel** — WhatsApp when the request carries a phone number,
 *    email when it carries only an email address, both when it carries both.
 */

export const SITE_FORMS_PACKAGE = 'site-forms';

/** Field bounds. */
export const BODY_MAX = 2000;
export const NAME_MAX = 100;
export const EMAIL_MAX = 200;
export const PHONE_MAX = 32;
export const COMPANY_MAX = 200;
export const SPACE_MAX = 128;
export const IP_HASH_MAX = 128;

/** Base anti-spam thresholds. */
export const MIN_DWELL_MS = 1500;
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 5;
/** Fail-closed cap: past this many rows for one submitter the window read is itself the flood. */
export const RATE_READ_CAP = 1000;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_DIGITS_RE = /\d/g;

/** Stable spam and refusal reason codes. A receipt names one of these, never free text alone. */
export const REASON = Object.freeze({
  HONEYPOT: 'SPAM_HONEYPOT',
  TOO_FAST: 'SPAM_TOO_FAST',
  RATE_LIMITED: 'SPAM_RATE_LIMITED',
  NEEDS_REVIEW: 'SENDER_UNRESOLVED',
});

/**
 * @param {unknown} value @param {string} field @param {number} max
 * @returns {string|null} trimmed text, or null when absent
 */
function optionalText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field });
  }
  const text = value.trim();
  if (text === '') return null;
  if (text.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(text)) {
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  return text;
}

/**
 * Validate the raw fields of one form request. Throws fail-closed; reads and
 * writes nothing. Returns the normalized fields the row stores.
 * @param {unknown} raw
 */
export function validateFormFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('a form request object is required', { field: 'request' });
  }
  const value = /** @type {any} */ (raw);
  const spaceId = optionalText(value.spaceId, 'spaceId', SPACE_MAX);
  if (!spaceId) throw new ValidationError('spaceId is required', { field: 'spaceId' });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spaceId)) {
    throw new ValidationError('spaceId must be a lowercase slug', { field: 'spaceId' });
  }
  const email = optionalText(value.email, 'email', EMAIL_MAX);
  if (email !== null) {
    const lower = email.toLowerCase();
    if (!EMAIL_RE.test(lower)) {
      throw new ValidationError('email must be a valid address shape', { field: 'email' });
    }
  }
  const phone = optionalText(value.phone, 'phone', PHONE_MAX);
  if (phone !== null && (phone.match(PHONE_DIGITS_RE) ?? []).length < 5) {
    throw new ValidationError('phone must carry at least 5 digits', { field: 'phone' });
  }
  // The message is the one field allowed line breaks: textareas send them.
  // They collapse to spaces before the control-character check, because the
  // interaction message stores bounded plain text without line breaks.
  const rawInput = value.body;
  if (typeof rawInput !== 'string' || rawInput.trim() === '') {
    throw new ValidationError('body is required', { field: 'body' });
  }
  const rawBody = rawInput.trim();
  if (rawBody.length > BODY_MAX + 512) {
    throw new ValidationError(`body must be at most ${BODY_MAX + 512} characters`, { field: 'body' });
  }
  const collapsed = rawBody.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (collapsed === '') throw new ValidationError('body is required', { field: 'body' });
  if (collapsed.length > BODY_MAX) {
    throw new ValidationError(`body must be at most ${BODY_MAX} characters`, { field: 'body' });
  }
  if (CONTROL_RE.test(collapsed)) {
    throw new ValidationError('body must not contain control characters', { field: 'body' });
  }
  const dwellMs = value.dwellMs;
  if (!Number.isInteger(dwellMs) || dwellMs < 0 || dwellMs > 86_400_000) {
    throw new ValidationError('dwellMs must be a non-negative integer of milliseconds', { field: 'dwellMs' });
  }
  const ipHash = optionalText(value.ipHash, 'ipHash', IP_HASH_MAX);
  if (!ipHash) throw new ValidationError('ipHash is required', { field: 'ipHash' });
  // A request the team cannot answer is triage, not intake: refused at the door.
  replyChannels({ phone, email });
  return Object.freeze({
    spaceId,
    firstName: optionalText(value.firstName, 'firstName', NAME_MAX),
    lastName: optionalText(value.lastName, 'lastName', NAME_MAX),
    email: email === null ? null : email.toLowerCase(),
    phone,
    companyName: optionalText(value.companyName, 'companyName', COMPANY_MAX),
    body: collapsed,
    ipHash,
    honeypotFilled: value.honeypotFilled === true,
    dwellMs,
  });
}

/**
 * The base anti-spam verdict over normalized fields plus the timestamps of
 * this submitter's recent submissions. Pure: `recentOccurredAtMs` is the
 * caller-read window, already bounded by `RATE_READ_CAP`.
 *
 * @param {{honeypotFilled: boolean, dwellMs: number}} fields
 * @param {number[]} recentOccurredAtMs epoch milliseconds, newest last
 * @param {number} nowMs
 * @returns {{spam: boolean, reasonCode: string|null}}
 */
export function evaluateSpam(fields, recentOccurredAtMs, nowMs) {
  if (fields.honeypotFilled) return { spam: true, reasonCode: REASON.HONEYPOT };
  if (fields.dwellMs < MIN_DWELL_MS) return { spam: true, reasonCode: REASON.TOO_FAST };
  if (recentOccurredAtMs.length >= RATE_READ_CAP) {
    return { spam: true, reasonCode: REASON.RATE_LIMITED };
  }
  const windowStart = nowMs - RATE_WINDOW_MS;
  let inWindow = 0;
  for (let index = recentOccurredAtMs.length - 1; index >= 0; index -= 1) {
    if (recentOccurredAtMs[index] < windowStart) break;
    inWindow += 1;
    if (inWindow >= RATE_MAX_PER_WINDOW) {
      return { spam: true, reasonCode: REASON.RATE_LIMITED };
    }
  }
  return { spam: false, reasonCode: null };
}

/**
 * The reply-channel rule: WhatsApp when the request carries a phone number,
 * email when it carries only an email address, both when both. At least one
 * is required — a request the team cannot answer is triage, not intake.
 * @param {{phone: string|null, email: string|null}} contact
 */
export function replyChannels(contact) {
  const whatsapp = contact.phone !== null;
  const email = contact.email !== null;
  if (!whatsapp && !email) {
    throw new ValidationError('a form request needs a phone number or an email address to answer', {
      field: 'phone',
    });
  }
  return Object.freeze({ whatsapp, email });
}

/**
 * The idempotency source key for one submission: the space plus the
 * caller-supplied idempotency key (one form render, one key). A retry replays
 * the stored row; a new render is a new request.
 * @param {string} spaceId @param {string} idempotencyKey
 */
export function submissionSourceKey(spaceId, idempotencyKey) {
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (key === '' || key.length > 128 || CONTROL_RE.test(key)) {
    throw new ValidationError('idempotencyKey must be bounded text (1-128 characters)', {
      field: 'idempotencyKey',
    });
  }
  return `site-form:${spaceId}:${key}`;
}

/** Hash a caller IP for the rate window. The raw address is never stored. */
export function hashIp(ip, spaceId) {
  if (typeof ip !== 'string' || ip.trim() === '') {
    throw new ValidationError('ip is required to hash', { field: 'ip' });
  }
  return createHash('sha256').update(`site-form|${spaceId}|${ip.trim()}`, 'utf8').digest('hex');
}

const SNIPPET_MAX_ENDPOINT = 200;

/**
 * The paste-into-the-website snippet for one space: a dependency-free form
 * posting JSON to the pilot's per-space route. No tracker, no third party,
 * no credential — the endpoint and the space slug are the whole config.
 * @param {{spaceId: string, endpoint: string, formId?: string}} input
 */
export function buildSnippet(input) {
  const spaceId = optionalText(input.spaceId, 'spaceId', SPACE_MAX);
  if (!spaceId || !/^[a-z0-9][a-z0-9-]*$/.test(spaceId)) {
    throw new ValidationError('spaceId must be a lowercase slug', { field: 'spaceId' });
  }
  const endpoint = optionalText(input.endpoint, 'endpoint', SNIPPET_MAX_ENDPOINT);
  if (!endpoint || !/^https:\/\/[^\s"<>]+$/.test(endpoint)) {
    throw new ValidationError('endpoint must be an https URL', { field: 'endpoint' });
  }
  const formId = optionalText(input.formId, 'formId', 64) ?? 'richiesta';
  const action = `${endpoint.replace(/\/+$/, '')}/site/${spaceId}/submit`;
  const html = [
    `<form data-accordo-space="${spaceId}" data-accordo-form="${formId}" method="post" action="${action}">`,
    '  <label>Nome <input name="firstName" maxlength="100" autocomplete="given-name"></label>',
    '  <label>Cognome <input name="lastName" maxlength="100" autocomplete="family-name"></label>',
    '  <label>Email <input name="email" type="email" maxlength="200" autocomplete="email"></label>',
    '  <label>Telefono <input name="phone" type="tel" maxlength="32" autocomplete="tel"></label>',
    '  <label>Messaggio <textarea name="body" maxlength="2000" required></textarea></label>',
    '  <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">',
    '  <button type="submit">Invia la richiesta</button>',
    '</form>',
    '<script>(function(){',
    'var f=document.querySelector(\'form[data-accordo-space=\"'+JSON.stringify(spaceId)+'\"\']\');',
    'if(!f)return;var t0=Date.now();',
    'f.addEventListener("submit",function(e){e.preventDefault();',
    'var d={spaceId:'+JSON.stringify(spaceId)+',dwellMs:Date.now()-t0,honeypotFilled:!!(f.website&&f.website.value),idempotencyKey:(window.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now()))};',
    '["firstName","lastName","email","phone","companyName","body"].forEach(function(k){d[k]=f[k]?f[k].value:"";});',
    'fetch(f.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});',
    '});})();</script>',
  ].join('\n');
  return Object.freeze({ spaceId, action, html });
}
