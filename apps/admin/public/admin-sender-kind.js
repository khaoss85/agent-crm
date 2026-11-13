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

/**
 * The footer words of mass mail (verification 12/11 on the pilot: a SaaS
 * newsletter «View in browser» and a crawl report «Unsubscribe from this
 * project», from mailboxes like `pesupport@` and `sa@` no address rule can
 * name without hurting real people). The Gmail readers now quarantine mass
 * mail by its headers, so this is the cure for the rows stored before that:
 * it counts only for a sender the team never wrote to.
 */
const BULK_FOOTER_WORDS = /\b(?:unsubscribe|view (?:it )?in (?:your )?browser|manage (?:your )?(?:email )?preferences|annulla (?:l[\x27\u2019])?iscrizione|disiscriviti|cancella (?:la tua |l[\x27\u2019])?iscrizione|visualizza (?:nel|sul|in) (?:tuo )?browser|gestisci le preferenze)\b/i;

/** How far from each end of a body a mass-mail footer (or preheader link) is looked for. */
const FOOTER_REGION = 400;


/** Pieces of a footer: lines, sentences, separators and the long blank runs of preheader padding. */
const FOOTER_PIECES = /[\n\r.!?|\u2022\u00b7]+|[\s\u2007\u00a0\u200b]{3,}/;

/** A person asking, not a template footer (review Muse #821: «Please help me unsubscribe from this charge»). */
const FIRST_PERSON = /\b(?:me|my|mine|please|help|can you|could you|i am|i want|i need|i would|vorrei|voglio|mi|mio|mia|miei|per favore|aiut\w*|potete|potreste|puoi|può)\b/i;

/**
 * Whether a body ends like mass mail (review Muse #821, P1): a short piece
 * near its end that is a footer link («Unsubscribe from this project»,
 * «View in browser», «Disiscriviti»), never a person's sentence that only
 * contains the word. Short pieces only, the end of the body only, and a
 * piece in the first person is a person asking.
 * @param {unknown} body
 */
export function hasBulkFooter(body) {
  if (typeof body !== 'string' || body === '') return false;
  // The tail, and the head too — «View in browser» opens many newsletters
  // as a preheader link. Never the middle, not even of a body cut at the
  // storage fence (review Muse #821 giro 4): a person's reply quoting a
  // newsletter must not read as one. A cut newsletter with no preheader
  // link stays a person — the safe side; such mail no longer enters (the
  // Gmail readers quarantine it by its headers).
  const region = body.length <= FOOTER_REGION * 2
    ? body
    : `${body.slice(0, FOOTER_REGION)}\n${body.slice(-FOOTER_REGION)}`;
  return region.split(FOOTER_PIECES).some((piece) => {
    const text = piece.trim();
    return text !== '' && text.length <= 60 && BULK_FOOTER_WORDS.test(text) && !FIRST_PERSON.test(text);
  });
}

/**
 * Who the team ever wrote to among some messages: their conversations and
 * the addresses outbound messages went to (review Muse #821: per sender,
 * never per customer — one answered thread must not vouch for another
 * sender's newsletter).
 * @param {Iterable<any>} messages
 * @returns {{ conversations: Set<string>, addresses: Set<string> }}
 */
export function teamCorrespondents(messages) {
  const conversations = new Set();
  const addresses = new Set();
  for (const row of messages ?? []) {
    if (row?.direction !== 'outbound' || row?.entry === 'call') continue;
    if (row.conversationId !== undefined && row.conversationId !== null && row.conversationId !== '') conversations.add(String(row.conversationId));
    const address = senderAddress(row.remoteHandle);
    if (address !== null) addresses.add(address);
  }
  return { conversations, addresses };
}

/**
 * Whether the team ever wrote to the sender of one inbound message: in its
 * conversation, or to its address anywhere.
 * @param {{ conversations: Set<string>, addresses: Set<string> }} correspondents
 * @param {any} message
 */
export function teamWroteTo(correspondents, message) {
  if (message?.conversationId != null && correspondents.conversations.has(String(message.conversationId))) return true;
  const address = senderAddress(message?.remoteHandle);
  return address !== null && correspondents.addresses.has(address);
}

/**
 * The scan-wide «who the team wrote to» across the server/browser boundary
 * (seguito P2 review Muse #821 giro 4, backlog:095fb37de6bb): Oggi reads
 * only its latest 100 messages while the server view scans everything, so
 * the same sender read as «never written to» on one screen and as a
 * correspondent on the other. The list answer carries this base and Oggi
 * reuses it for the same rows — one scope for both readers, never two
 * kept in step by a test. Plain data only (arrays of strings), so it
 * survives JSON; unknown shapes read as nobody ever written to, never a
 * crash and never an invented correspondent.
 * @param {{ conversations?: unknown, addresses?: unknown } | null | undefined} correspondents
 * @returns {{ conversations: Array<string>, addresses: Array<string> }}
 */
export function serializeCorrespondents(correspondents) {
  const pick = (value) => {
    const items = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
    return items.filter((entry) => typeof entry === 'string' && entry !== '');
  };
  return {
    conversations: pick(correspondents?.conversations),
    addresses: pick(correspondents?.addresses),
  };
}

/**
 * Two «who the team wrote to» bases into one (same item,
 * backlog:095fb37de6bb): every conversation and address either names. The
 * server base covers every customer thread; the page base lends the threads
 * with no customer subject the server never saw. A union never invents —
 * both sides are outbounds the team really sent — and on the threads both
 * readers classify it is exactly the server base.
 * @param {any} first @param {any} second
 * @returns {{ conversations: Set<string>, addresses: Set<string> }}
 */
export function unionCorrespondents(first, second) {
  const both = [reviveCorrespondents(first), reviveCorrespondents(second)];
  return {
    conversations: new Set(both.flatMap((base) => [...base.conversations])),
    addresses: new Set(both.flatMap((base) => [...base.addresses])),
  };
}

/**
 * Back from the wire into the shape `teamWroteTo` reads (same item,
 * backlog:095fb37de6bb): live Sets pass through untouched, serialized
 * arrays become Sets, anything else reads as nobody ever written to.
 * @param {any} value
 * @returns {{ conversations: Set<string>, addresses: Set<string> }}
 */
export function reviveCorrespondents(value) {
  const sets = (input) => new Set(
    (Array.isArray(input) ? input : (input instanceof Set ? [...input] : []))
      .filter((entry) => typeof entry === 'string' && entry !== ''),
  );
  if (value !== null && typeof value === 'object') {
    if (value.conversations instanceof Set && value.addresses instanceof Set) return value;
    return { conversations: sets(value.conversations), addresses: sets(value.addresses) };
  }
  return { conversations: new Set(), addresses: new Set() };
}

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
 * a reply (production 11/11, the pilot inbox). A general rule, never
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
 * - the owner writing to themselves: a sender among `ownAddresses`;
 * - mass mail stored before the Gmail readers quarantined it by its
 *   headers (List-Unsubscribe, Precedence, Auto-Submitted — today such mail
 *   is never stored): the footer words of mass mail («Unsubscribe», «View
 *   in browser») from a sender the team never wrote to (`weWrote: false`).
 * @param {{ channel?: unknown, remoteHandle?: unknown, subjectLabel?: unknown, mailSubject?: unknown, body?: unknown } | null | undefined} message
 * @param {{ ownAddresses?: Iterable<unknown>, labels?: Array<unknown>, weWrote?: boolean }} [context]
 */
export function isNotificationMessage(message, { ownAddresses = [], labels = [], weWrote = true } = {}) {
  if (!message || typeof message !== 'object') return false;
  const channel = String(message.channel ?? '').toLowerCase();
  if (channel === 'website-form' || channel === 'web' || channel === 'site-form') return false;
  const opening = typeof message.body === 'string' ? message.body.slice(0, 300) : '';
  const subject = typeof message.mailSubject === 'string' ? message.mailSubject : '';
  if (CONTACT_FORM_WORDS.test(subject) || CONTACT_FORM_WORDS.test(opening)) return false;
  if (channel !== 'email') return false;
  if (weWrote === false && hasBulkFooter(message.body)) return true;
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

/**
 * Two-level public suffixes where the registrable name is the third label
 * from the right (`amazon.co.uk` → `amazon`). Deliberately small: a miss
 * reads the suffix's own first label, never an address.
 */
export const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'co.in',
  'co.za', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.sg', 'com.hk', 'gov.it',
]);

/**
 * Personal mailbox providers: the domain names the provider, not the
 * customer, so a label from it would call every Gmail sender «Gmail».
 */
export const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it', 'live.com', 'live.it',
  'msn.com', 'yahoo.com', 'yahoo.it', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'libero.it',
  'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it', 'tin.it', 'email.it', 'fastwebnet.it', 'inwind.it',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.it', 'gmx.de', 'pec.it', 'legalmail.it',
]);

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
    // A machine mailbox at a personal provider (`noreply@gmail.com`) names
    // nobody: never «Noreply» as a person (review #739 giro 3).
    if (isTechnicalLocalPart(email)) return null;
    const text = String(email).trim();
    const local = text.slice(0, text.lastIndexOf('@')).split('+')[0] ?? '';
    if (!/^\p{L}+(?:[._-]\p{L}+){0,3}$/u.test(local) || local.length > 40) return null;
    return local.split(/[._-]+/).map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
  }
  const base = domain.split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}
