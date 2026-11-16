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
import { isTechnicalLocalPart, labelFromEmail, registrableDomain } from '../../core/sender-kind.js';

/** Placeholder words older writers stored instead of a name. */
const NAME_PLACEHOLDERS = new Set([
  'unknown', 'sconosciuto', 'sconosciuta', 'n/a', 'na', 'null', 'undefined', 'none', '-', '—', '–',
]);

/**
 * A word shaped like an address (`x@y.com`, `<x@y.com>`): a lone `@` or a
 * handle (`@ Home`, `@studio`) is not one (review #739).
 */
const ADDRESS_WORD = /^[<("']*[^@\s<>()"']+@[^@\s<>()"']+\.[^@\s<>()"']+[>)"',;:]*$/;

/**
 * A bare reply word: a mailbox token, never a surname (backlog:088b639d96a2:
 * `apple.reply@…` was stored and shown as «Apple Reply»). Dropped only at
 * the end, like the no-reply markers: a word in the middle stays.
 */
const BARE_REPLY_WORD = /^(?:reply|replies)$/i;

/** Wrapping punctuation around a word of a display name. */
const NAME_WRAPPING = /^[([<"']+|[)\]>"',;:]+$/g;

/**
 * A stored name without its trailing platform qualifier: the co-brand after
 * a pipe («MailUp | TeamSystem» reads «MailUp») and trailing parenthetical
 * notes («Francesco Tirsi (Documenti Google)» reads «Francesco Tirsi»).
 * Only trailing qualifiers go — inner words stay untouched.
 * @param {string} text
 */
function stripNameQualifier(text) {
  let out = text;
  const pipe = out.indexOf('|');
  if (pipe >= 0) out = out.slice(0, pipe);
  for (;;) {
    const trailing = /\s*\([^()]*\)\s*$/.exec(out);
    if (!trailing) return out;
    out = out.slice(0, trailing.index);
  }
}

/**
 * A stored name with its placeholder words dropped («PayPal Unknown» reads
 * «PayPal»), null when nothing real is left. A name that carries an
 * address-shaped word (`Mittente: x@y.com`) names nobody: null. The
 * address check runs on the whole stored value first, so a qualifier never
 * hides an address (`Mario (x@y.com)` still names nobody).
 * @param {unknown} value
 * @returns {string | null}
 */
export function readableName(value) {
  if (typeof value !== 'string') return null;
  const words = value.trim().split(/\s+/).filter((word) => word !== '');
  if (words.some((word) => ADDRESS_WORD.test(word))) return null;
  const head = stripNameQualifier(value.trim()).split(/\s+/).filter((word) => word !== '');
  const kept = head.filter((word) => !NAME_PLACEHOLDERS.has(word.toLowerCase()) && !MAILBOX_ID_WORD(word));
  while (kept.length > 0) {
    const last = kept[kept.length - 1].replace(NAME_WRAPPING, '');
    if (!NO_REPLY_WORD.test(last) && !BARE_REPLY_WORD.test(last)) break;
    kept.pop();
  }
  const text = kept.join(' ');
  return text !== '' && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/**
 * A no-reply marker the sender appended to its name (production 10/11:
 * «UniCredit S.p.A. Noreply», «Whirlpool Servizio Assistenza NO-REPLY»),
 * any case. Dropped only at the end: a word in the middle stays.
 */
const NO_REPLY_WORD = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|no[._-]?risposta|non[._-]?rispondere)$/i;

/**
 * A mailbox id used as a name (production 10/11: «filiale_458»): an
 * underscore with digits is how a mailbox is numbered, never how a person
 * or a company is written.
 * @param {string} word
 */
function MAILBOX_ID_WORD(word) {
  return word.includes('_') && /\d/.test(word);
}

/**
 * The name without the pieces it repeats from its own address (production
 * 10/11: «Amazon.it It», the `it` of `amazon.it` written again as a word):
 * a word equal to a label of the email domain that the name already said
 * earlier — as a word or as a dotted part — is dropped. A first mention
 * stays («Amazon» from `amazon.it` is the name).
 * @param {string} name
 * @param {unknown} email
 * @returns {string | null}
 */
export function nameWithoutAddressEchoes(name, email) {
  const text = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const labels = new Set(text.slice(text.lastIndexOf('@') + 1).split('.').filter((label) => label !== ''));
  const said = new Set();
  const kept = [];
  for (const word of name.split(/\s+/).filter((part) => part !== '')) {
    const bare = word.toLowerCase().replace(/[^\p{L}\p{N}.-]/gu, '');
    if (kept.length > 0 && labels.has(bare) && said.has(bare)) continue;
    kept.push(word);
    for (const part of bare.split('.')) if (part !== '') said.add(part);
  }
  const out = kept.join(' ');
  return out !== '' ? out : null;
}

/**
 * Whether a local part names a mailbox, not a person (`noreply`, `bounces`,
 * `comments-noreply`, `32ezyaggtanwlm-…`): the kernel sender rule
 * (core/sender-kind.js), re-exported so the lead path keeps its import.
 */
export { isTechnicalLocalPart };

/**
 * The registrable domain of an address and the readable label it lends a
 * nameless sender: the kernel sender rule (core/sender-kind.js), so the
 * Oggi notifications name a sender like Clienti does (backlog:bab63e32acdb).
 */
export { labelFromEmail, registrableDomain };

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
  const read = readableName(parts.join(' '));
  const name = read === null ? null : nameWithoutAddressEchoes(read, contact.email);
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
 * placeholder (`Unknown (assistenza@…)`, a documentation domain like
 * `esempio.invalid`) — the screen then says «senza nome» in its own words,
 * never the placeholder (review #739, backlog:088b639d96a2). Co-branded
 * names read by their own brand («MailUp | TeamSystem» reads «MailUp»)
 * and bare domains read united (`amazon.it`, never `Amazon.it` beside it).
 * @param {{name?: unknown} | null | undefined} company
 * @returns {string | null}
 */
export function companyDisplayName(company) {
  const name = company?.name;
  if (typeof name !== 'string' || isPlaceholderCompanyName(name)) return null;
  let text = name.trim();
  const pipe = text.indexOf('|');
  if (pipe >= 0) text = text.slice(0, pipe).trim();
  if (text === '') return null;
  if (!/\s/.test(text) && BARE_DOMAIN_SHAPE.test(text) && text.slice(text.lastIndexOf('.') + 1).length >= 2) {
    text = text.toLowerCase();
  }
  return text;
}

/**
 * A bare domain name with no spaces: case is how it was typed, not who it
 * is, so `amazon.it` and `Amazon.it` read united. The last label needs at
 * least two characters, so an abbreviation like `S.p.A` never counts.
 */
const BARE_DOMAIN_SHAPE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Whether a stored company name is a placeholder rather than a company:
 * `Unknown`, `Unknown (assistenza@paypal.it)` and kin, or a documentation
 * / test domain stored as a company (`esempio.invalid`, RFC 2606 — never a
 * customer). The reserved «Senza azienda» is `isNoCompany` in sender.js.
 * @param {unknown} name
 */
export function isPlaceholderCompanyName(name) {
  if (typeof name !== 'string') return true;
  const bare = name.replace(/\([^)]*\)/g, ' ');
  if (readableName(bare) === null) return true;
  // A well-shaped domain has a registrable domain — except a documentation
  // / test one, whose registrable domain is null (core sender-kind.js).
  const text = bare.trim();
  return !/\s/.test(text) && BARE_DOMAIN_SHAPE.test(text) && registrableDomain(`placeholder@${text}`) === null;
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
