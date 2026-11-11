// @ts-check
/**
 * Who wrote a message: a person, or a machine (backlog:bab63e32acdb,
 * backlog:c2bf6b206d96). One rule for every reader — the Gmail door that
 * quarantines bulk mail, the names leads are created with, the Clienti
 * «Da rispondere» view and the Oggi inbox — so a sender never reads as a
 * person on one screen and a notification on another.
 *
 * Pure and import-free on purpose: the /bo shell cannot import packages,
 * so this file ships twice, byte-identical — the core source
 * (packages/core/src/sender-kind.js) and the shell copy
 * (apps/admin/public/admin-sender-kind.js). tests/sender-kind.test.js fails
 * when the two differ. Regex literals spell quotes as \x22 and \x27: the
 * shell bundler reads quotes as string starts.
 */

/**
 * Local parts that are never a person writing (backlog:1a4d9b30,
 * supervisor arbitration 06/11 on #606): the bare address decides alone. A
 * local part matches exactly or as the stem of a separator-suffixed variant
 * (`noreply-it`, `order-update-2`), after the `+` tag is stripped. Closed
 * vocabulary — an unknown local part is a person until proven otherwise.
 */
export const AUTOMATED_SENDER_LOCALS = Object.freeze([
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notify', 'notification', 'notifications',
  'alerts', 'order', 'order-update', 'invoice', 'billing', 'statements',
  'renewals', 'support', 'onboarding',
  'mailer-daemon', 'postmaster',
]);

/**
 * First DNS labels that mark a sender domain as sending infrastructure
 * (backlog:1a4d9b30): `hello@notify.railway.app` is platform traffic even
 * with a human-looking local part. Only the first label counts.
 */
export const SENDING_SUBDOMAINS = Object.freeze(['mail', 'notify', 'em', 'news', 'bounce']);

/** Bulk-infrastructure domains: their subdomains match too. */
export const NOTIFICATION_DOMAINS = Object.freeze([
  'amazonses.com',
  'sendgrid.net',
  'mandrillapp.com',
  'mailchimp.com',
  'list-manage.com',
  'campaign-archive.com',
  'constantcontact.com',
  'mailgun.org',
  'hubspotemail.net',
  'mktomail.com',
  'cmail20.com',
]);

/**
 * The Italian mailboxes of the automated roles (`notifiche@`, `ricevute@`).
 * Notification readers only: the
 * Gmail door keeps storing these messages (receipts carry their subject and
 * attachments), they just never wait for a reply.
 */
export const ITALIAN_ROLE_LOCALS = Object.freeze(['notifiche', 'avvisi', 'fatturazione', 'fatture', 'ordini', 'ricevute']);

/**
 * Payment providers whose service mailboxes send receipts (team-lead
 * decision 11/11: `assistenza@paypal.it`, `service@paypal.com`): a domain
 * label naming one, with a service local part, is a receipt — never a
 * person waiting. Kept to the receipt locals: elsewhere `assistenza@` can
 * be a person.
 */
export const PAYMENT_PROVIDERS = Object.freeze(['paypal', 'stripe', 'satispay', 'klarna', 'scalapay', 'sumup', 'nexi']);
export const RECEIPT_LOCALS = Object.freeze(['assistenza', 'service', 'servizio-clienti', 'payments', 'pagamenti', 'receipts']);

/** The certified-mail wording a PEC copy or receipt carries in its subject or body. */
const PEC_WORDS = /posta elettronica certificata|^posta certificata:|^(?:accettazione|avvenuta consegna|consegna|anomalia messaggio):/i;


/** PEC-only providers; any domain with a `pec` label is a PEC mailbox too. */
export const PEC_PROVIDERS = Object.freeze(['legalmail.it', 'postacert.it', 'postecert.it', 'arubapec.it']);

/** A no-reply word (`Noreply`, `NO-REPLY`, `non-rispondere`), any case. */
export const NO_REPLY_WORD = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|no[._-]?risposta|non[._-]?rispondere)$/i;

/** A no-reply piece of a longer local part (`comments-noreply`, `drive-shares-dm-noreply`). */
const NO_REPLY_PIECE = /(?:^|[._-])(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:[._-]|$)/;

/** Words of a website contact form in a subject or the opening of a body. */
const CONTACT_FORM_WORDS = /\b(?:contact[ -]?form|form submission|new submission|modulo di contatto|richiesta di contatto|nuovo contatto dal sito|messaggio dal sito)\b/i;

/** Wrapping punctuation around a word of a display name. */
const WRAPPING = /^[([<\x22\x27]+|[)\]>\x22\x27,;:]+$/g;

/**
 * A lower-case address out of a handle («Ada <ada@x.it>» reads `ada@x.it`),
 * null when it holds none.
 * @param {unknown} handle
 * @returns {string | null}
 */
export function senderAddress(handle) {
  if (typeof handle !== 'string') return null;
  const text = handle.trim().toLowerCase();
  const inside = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = inside ? inside[1] : text;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : null;
}

/**
 * A machine id, not a human handle (review #739 giro 2): very long, or at
 * least 10 characters mixing letters and digits the way generated ids do.
 * A name with a number after it (`marco123`) stays a person.
 * @param {string} token
 */
function isMachineToken(token) {
  if (token.length >= 24) return true;
  if (token.length < 10 || !/\d/.test(token) || !/\p{L}/u.test(token)) return false;
  if (/^\d/.test(token)) return true;
  return (token.match(/(?:\p{L}(?=\d)|\d(?=\p{L}))/gu) ?? []).length >= 3;
}

/**
 * Whether a local part names a mailbox, not a person (`noreply`, `bounces`,
 * `comments-noreply`, `32ezyaggtanwlm-…`): a lead created from it reads the
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
  if (NO_REPLY_PIECE.test(local)) return true;
  return local.split(/[._-]+/).some(isMachineToken);
}

/**
 * The Gmail door rule (backlog:1a4d9b30): an automated local part or a
 * sending subdomain or a bulk platform. Pure and total — an unreadable
 * address is simply not automated.
 * @param {unknown} from
 */
export function isAutomatedAddress(from) {
  const address = typeof from === 'string' ? from.trim().toLowerCase() : '';
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const base = address.slice(0, at).split('+')[0] ?? '';
  if (AUTOMATED_SENDER_LOCALS.includes(base)) return true;
  if (AUTOMATED_SENDER_LOCALS.some((stem) => ['-', '_', '.'].some((sep) => base.startsWith(`${stem}${sep}`)))) return true;
  const domain = address.slice(at + 1);
  const labels = domain.split('.');
  if (labels.length >= 2 && SENDING_SUBDOMAINS.includes(labels[0] ?? '')) return true;
  return NOTIFICATION_DOMAINS.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/**
 * Whether a sender is a machine: the Gmail door rule, a technical local
 * part, or a display name carrying a no-reply marker («UniCredit S.p.A.
 * Noreply»). An unreadable handle and an unmarked name are a person.
 * @param {unknown} handle the sender address (`remoteHandle`)
 * @param {...unknown} labels stored display names
 */
export function isAutomatedSender(handle, ...labels) {
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    if (label.trim().split(/\s+/).some((word) => NO_REPLY_WORD.test(word.replace(WRAPPING, '')))) return true;
  }
  const address = senderAddress(handle);
  if (address === null) return false;
  return isAutomatedAddress(address) || isTechnicalLocalPart(address);
}

/**
 * Whether one inbound message is a notification, not a person waiting for
 * a reply (production 11/11, Presti › Da rispondere). A general rule, never
 * a list of names:
 * - a website contact form is a real person writing: never a notification,
 *   whatever mailbox the form sends from (the form channel, or
 *   contact-form words in the subject or the opening of the body);
 * - only e-mail is classified: a WhatsApp or Instagram message is a person;
 * - an automated sender (`isAutomatedSender`) or the Italian mailbox of the
 *   same roles (`notifiche@`, `ricevute@`…);
 * - a payment receipt: a service mailbox (`assistenza@`, `service@`) of a
 *   payment provider (`paypal.*`, `stripe.*`…);
 * - a certified-mail (PEC) message: a PEC mailbox (`pec.*` domains,
 *   `posta-certificata@`) or the PEC wording in subject or body;
 * - the owner writing to themselves: a sender among `ownAddresses`.
 * @param {{ channel?: unknown, remoteHandle?: unknown, subjectLabel?: unknown, mailSubject?: unknown, body?: unknown } | null | undefined} message
 * @param {{ ownAddresses?: Iterable<unknown>, labels?: Array<unknown> }} [context]
 */
export function isNotificationMessage(message, { ownAddresses = [], labels = [] } = {}) {
  if (!message || typeof message !== 'object') return false;
  const channel = String(message.channel ?? '').toLowerCase();
  if (channel === 'website-form' || channel === 'web' || channel === 'site-form') return false;
  const opening = typeof message.body === 'string' ? message.body.slice(0, 300) : '';
  const subject = typeof message.mailSubject === 'string' ? message.mailSubject : '';
  if (CONTACT_FORM_WORDS.test(subject) || CONTACT_FORM_WORDS.test(opening)) return false;
  if (channel !== 'email') return false;
  if (isAutomatedSender(message.remoteHandle, message.subjectLabel, ...labels)) return true;
  const address = senderAddress(message.remoteHandle);
  if (address === null) return false;
  const local = address.slice(0, address.lastIndexOf('@')).split('+')[0] ?? '';
  if (ITALIAN_ROLE_LOCALS.some((role) => local === role || ['-', '_', '.'].some((sep) => local.startsWith(`${role}${sep}`)))) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const domainLabels = domain.split('.');
  if (RECEIPT_LOCALS.includes(local) && domainLabels.some((label) => PAYMENT_PROVIDERS.includes(label))) return true;
  if (PEC_WORDS.test(subject) || PEC_WORDS.test(opening.trim())) return true;
  if (domainLabels.includes('pec') || PEC_PROVIDERS.includes(domain) || local === 'posta-certificata') return true;
  for (const own of ownAddresses) {
    if (senderAddress(own) === address) return true;
  }
  return false;
}
