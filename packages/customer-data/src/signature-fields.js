// @ts-check

import { ValidationError } from '../../core/index.js';
import { CONTROL_RE, MAX_FIELD_LENGTH, emailShape, safeString } from './normalize.js';

/**
 * Email-signature field parser (backlog:3de717335694).
 *
 * The second free enrichment source beside Google Contacts: a signature
 * block parsed locally, with no provider, no credential and no paid
 * service. Pure function — it reads text and returns candidate contact
 * fields, and the enrichment operation decides what to store.
 *
 * Deliberately conservative: it extracts only what a signature states
 * plainly. Labeled lines (`Ruolo:`, `Tel:`, …) win over position; the name
 * is the first name-shaped line near the top; the phone comes from a
 * phone-labeled line (with or without the colon) or, as a last resort,
 * from an explicitly international (`+`-prefixed) token on a line naming
 * no fax, VAT or date infrastructure. Dates, VAT numbers and fax lines
 * never become phones. Anything ambiguous is left absent rather than
 * guessed — enrichment fills gaps, it never invents a customer.
 */

const MAX_SIGNATURE_CHARS = 8000;
const MAX_SIGNATURE_LINES = 100;

const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?\.[a-z]{2,}/i;
const PHONE_RE = /\+?[0-9][0-9 .\-()/]{5,}[0-9]/;
const NAME_WORD_RE = /^\p{Lu}[\p{L}'’.-]*$/u;
/** Lines that name infrastructure, never a person. */
const NOT_A_NAME_RE = /tel|phone|fax|email|e-mail|www|http|p\.?\s*iva|vat|via |viale|piazza|corso|@|\d/i;

function canonicalPhone(raw) {
  const digits = String(raw).replaceAll(/[ .\-()/]/g, '');
  if (!/^\+?[0-9]{6,18}$/.test(digits)) return null;
  return digits;
}

function nameShaped(line) {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (NOT_A_NAME_RE.test(line)) return false;
  return words.every((word) => NAME_WORD_RE.test(word));
}

/**
 * Parse one signature block into candidate contact fields.
 * @param {unknown} text the signature block as pasted (plain text)
 * @param {{ messageId?: unknown }} [options] opaque source detail carried onto the enriched rows
 */
export function parseEmailSignature(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ValidationError('an email signature needs text to parse', { field: 'text' });
  }
  if (text.length > MAX_SIGNATURE_CHARS) {
    throw new ValidationError('an email signature must be at most 8000 characters', { field: 'text' });
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length > MAX_SIGNATURE_LINES) {
    throw new ValidationError('an email signature must be at most 100 lines', { field: 'text' });
  }
  for (const line of lines) {
    if (CONTROL_RE.test(line)) {
      throw new ValidationError('an email signature must not contain control characters', { field: 'text' });
    }
  }

  const messageId = typeof options.messageId === 'string' && options.messageId.trim() !== ''
    ? options.messageId.trim().slice(0, MAX_FIELD_LENGTH)
    : null;

  /** @type {{firstName: string|null, lastName: string|null, role: string|null, companyName: string|null, phone: string|null, email: string|null}} */
  const found = { firstName: null, lastName: null, role: null, companyName: null, phone: null, email: null };

  const emailMatch = EMAIL_RE.exec(text);
  if (emailMatch) {
    const shaped = emailShape(emailMatch[0]);
    if (shaped.ok) found.email = shaped.value;
  }

  for (const line of lines) {
    const labeled = /^([a-zà-ÿ .'-]{2,20})\s*:\s*(.+)$/i.exec(line);
    if (!labeled) continue;
    const label = labeled[1].trim().toLowerCase();
    const value = labeled[2].trim();
    if (/^(ruolo|role|mansione|title|posizione)$/.test(label) && !found.role) {
      found.role = safeString(value, 'role');
    } else if (/^(azienda|company|società|societa|ditta|organizzazione)$/.test(label) && !found.companyName) {
      found.companyName = safeString(value, 'companyName');
    } else if (/^(tel|telefono|phone|cell|cellulare|mobile|telephone)$/.test(label) && !found.phone) {
      const phoneMatch = PHONE_RE.exec(value);
      if (phoneMatch) found.phone = canonicalPhone(phoneMatch[0]);
    }
  }

  if (!found.phone) {
    // A phone label without the colon still names a phone (`Tel 02 1234`).
    for (const line of lines) {
      const bare = /^(tel|telefono|phone|cell|cellulare|mobile|telephone)\b\s*(.+)$/i.exec(line);
      if (!bare) continue;
      const phoneMatch = PHONE_RE.exec(bare[2]);
      if (!phoneMatch) continue;
      const phone = canonicalPhone(phoneMatch[0]);
      if (phone) {
        found.phone = phone;
        break;
      }
    }
  }

  if (!found.phone) {
    // Last resort, explicit evidence only: a leading `+` on a line that
    // names no other infrastructure. Dates (`12/05/2024`), VAT numbers
    // (`P.IVA 01234567890`) and fax lines never start with `+` on a clean
    // line, and anything carrying a `/` is a date, not a number — so an
    // unlabeled fallback number can never be a date, a tax id or a fax.
    // A bare national number without a label stays absent rather than
    // guessed: enrichment fills gaps, it never invents a customer.
    for (const line of lines) {
      if (/fax|p\.?\s*iva|vat|partita\s*iva/i.test(line)) continue;
      const phoneMatch = PHONE_RE.exec(line);
      if (!phoneMatch || !phoneMatch[0].startsWith('+') || phoneMatch[0].includes('/')) continue;
      const phone = canonicalPhone(phoneMatch[0]);
      if (phone) {
        found.phone = phone;
        break;
      }
    }
  }

  const head = lines.slice(0, 5);
  for (const line of head) {
    if (line.length > MAX_FIELD_LENGTH) continue;
    if (!nameShaped(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    found.firstName = words.slice(0, -1).join(' ');
    found.lastName = words[words.length - 1];
    break;
  }

  return Object.freeze({
    ...found,
    sourceDetail: messageId,
  });
}
