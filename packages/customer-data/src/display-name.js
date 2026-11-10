// @ts-check

/**
 * **The name a customer is shown by (production 10/11).**
 *
 * One rule for every reader — the customer list, the profile behind the
 * scheda, Oggi and Calendario — so a contact never reads differently on
 * two screens. It runs at read time on the stored record: the data is not
 * rewritten, so it covers the contacts that already exist.
 *
 * What production showed, and what it reads now:
 * - `Fastweb —`: the lead path stores `—` as the last name of a one-token
 *   address (the core requires a non-empty last name) → `Fastweb`.
 * - `PayPal Unknown`: older writers stored `Unknown` (and kin) instead of a
 *   name → `PayPal`; a company stored as `Unknown (assistenza@…)` is no
 *   company, so the subtitle falls back to the email.
 * - `Mittente: 32ez…@identity-reachout.bounces.google.com`: a name carrying
 *   an address names nobody → a label from the registrable domain, without
 *   technical subdomains (`google.com` → `Google`). Never the long address.
 */

import { isNoCompany } from './sender.js';

/** Placeholder words older writers stored instead of a name. */
const NAME_PLACEHOLDERS = new Set([
  'unknown', 'sconosciuto', 'sconosciuta', 'n/a', 'na', 'null', 'undefined', 'none', '-', '—', '–',
]);

/**
 * Two-level public suffixes where the registrable name is the third label
 * from the right (`amazon.co.uk` → `amazon`). Deliberately small: a miss
 * reads the suffix's own first label, never an address.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'co.in',
  'co.za', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.sg', 'com.hk', 'gov.it',
]);

/**
 * Personal mailbox providers: the domain names the provider, not the
 * customer, so a label from it would call every Gmail sender «Gmail».
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it', 'live.com', 'live.it',
  'msn.com', 'yahoo.com', 'yahoo.it', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'libero.it',
  'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it', 'tin.it', 'email.it', 'fastwebnet.it', 'inwind.it',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.it', 'gmx.de', 'pec.it', 'legalmail.it',
]);

/**
 * A word shaped like an address (`x@y.com`, `<x@y.com>`): a lone `@` or a
 * handle (`@ Home`, `@studio`) is not one (review #739).
 */
const ADDRESS_WORD = /^[<("']*[^@\s<>()"']+@[^@\s<>()"']+\.[^@\s<>()"']+[>)"',;:]*$/;

/**
 * A stored name with its placeholder words dropped («PayPal Unknown» reads
 * «PayPal»), null when nothing real is left. A name that carries an
 * address-shaped word (`Mittente: x@y.com`) names nobody: null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function readableName(value) {
  if (typeof value !== 'string') return null;
  const words = value.trim().split(/\s+/).filter((word) => word !== '');
  if (words.some((word) => ADDRESS_WORD.test(word))) return null;
  const kept = words.filter((word) => !NAME_PLACEHOLDERS.has(word.toLowerCase()));
  const text = kept.join(' ');
  return text !== '' && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/**
 * The registrable domain of an address, lowercase, technical subdomains
 * dropped (`x@identity-reachout.bounces.google.com` → `google.com`). Null
 * when the value is not an address with a dotted domain.
 * @param {unknown} email
 * @returns {string | null}
 */
export function registrableDomain(email) {
  const text = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const at = text.lastIndexOf('@');
  if (at <= 0) return null;
  const labels = text.slice(at + 1).split('.').filter((label) => label !== '');
  if (labels.length < 2 || labels.some((label) => !/^[\p{L}\p{N}-]+$/u.test(label))) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && SECOND_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * A readable label for an address with no usable name: the registrable
 * domain's own name, capitalized (`…@bounces.google.com` → `Google`,
 * `assistenza@paypal.it` → `Paypal`). A personal mailbox provider names
 * the provider, not the customer: the local part reads as a name when it
 * looks like one (`mario.rossi@gmail.com` → `Mario Rossi`), else null.
 * Never the address itself.
 * @param {unknown} email
 * @returns {string | null}
 */
export function labelFromEmail(email) {
  const domain = registrableDomain(email);
  if (domain === null) return null;
  if (PERSONAL_MAIL_DOMAINS.has(domain)) {
    const text = String(email).trim();
    const local = text.slice(0, text.lastIndexOf('@')).split('+')[0] ?? '';
    if (!/^\p{L}+(?:[._-]\p{L}+){0,3}$/u.test(local) || local.length > 40) return null;
    return local.split(/[._-]+/).map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
  }
  const base = domain.split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Whether a local part names a mailbox, not a person (`noreply`,
 * `bounces`, `32ezyaggtanwlm-…`): a lead created from it reads the
 * sender's domain, never the machine token.
 * @param {unknown} email
 */
export function isTechnicalLocalPart(email) {
  const text = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const at = text.lastIndexOf('@');
  const local = (at > 0 ? text.slice(0, at) : text).split('+')[0] ?? '';
  if (/^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster|bounces?|notifications?|notify|alerts?)$/.test(local)) {
    return true;
  }
  return local.split(/[._-]+/).some((token) => token.length >= 24
    || (token.length >= 8 && /\d/.test(token) && /\p{L}/u.test(token)));
}

/**
 * The name a contact is shown by: first and last name with placeholders
 * dropped, else a label from its email, else null (the caller says «senza
 * nome» in its own words).
 * @param {{firstName?: unknown, lastName?: unknown, email?: unknown} | null | undefined} contact
 * @returns {string | null}
 */
export function contactDisplayName(contact) {
  if (!contact) return null;
  const parts = [contact.firstName, contact.lastName].filter((part) => typeof part === 'string');
  const name = readableName(parts.join(' '));
  if (name !== null && !isTokenName(name, contact.email)) return name;
  return labelFromEmail(contact.email);
}

/**
 * Whether a stored name is only the machine token of its own technical
 * address (review #739): the lead path names a contact from its local part,
 * so `x9f8e7d6c5@gmail.com` was stored as «X9f8e7d6c5» and
 * `32ez…-abc@…google.com` as «32ez… Abc». Such a name is no name: the
 * reader falls to the domain label, or to none.
 * @param {string} name
 * @param {unknown} email
 */
function isTokenName(name, email) {
  if (!isTechnicalLocalPart(email)) return false;
  const text = String(email).trim().toLowerCase();
  const local = text.slice(0, text.lastIndexOf('@')).split('+')[0] ?? '';
  const tokens = local.split(/[._-]+/).filter(Boolean);
  const said = name.toLowerCase();
  return tokens.length > 0 && (said === tokens[0] || said === tokens.join(' '));
}

/**
 * The name a company subject is shown by: its stored name, or null for a
 * placeholder (`Unknown (assistenza@…)`) — the screen then says «senza
 * nome» in its own words, never the placeholder (review #739).
 * @param {{name?: unknown} | null | undefined} company
 * @returns {string | null}
 */
export function companyDisplayName(company) {
  const name = company?.name;
  if (typeof name !== 'string' || isPlaceholderCompanyName(name)) return null;
  return name.trim();
}

/**
 * Whether a stored company name is a placeholder rather than a company:
 * `Unknown`, `Unknown (assistenza@paypal.it)` and kin. The reserved
 * «Senza azienda» is `isNoCompany` in sender.js.
 * @param {unknown} name
 */
export function isPlaceholderCompanyName(name) {
  if (typeof name !== 'string') return true;
  const bare = name.replace(/\([^)]*\)/g, ' ');
  return readableName(bare) === null;
}

/**
 * The company a reader shows beside a customer, or null: the reserved
 * «Senza azienda» behind a contact and a placeholder name are no company.
 * A company subject keeps its own record (its name is all it has).
 * @template {{name?: unknown}} T
 * @param {T | null | undefined} company
 * @param {unknown} contact
 * @returns {T | null}
 */
export function shownCompanyOf(company, contact) {
  if (!company) return null;
  if (!contact) return company;
  if (isNoCompany(company) || isPlaceholderCompanyName(company.name)) return null;
  return company;
}
