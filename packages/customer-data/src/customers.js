// @ts-check

import { ValidationError } from '../../core/index.js';
import { CHANNEL_SYSTEMS, isNoCompany } from './sender.js';

/**
 * **The customer list (BO-F1-05): one page of customers, server-side.**
 *
 * Rows are the host records the application already owns (`contact` joined to
 * its `company`), enriched from the same reads the scheda uses — channel
 * identities beside the record (`external-identity`), signed-business
 * evidence (orders, contracts, subscriptions), open opportunities, open work
 * tasks, the latest message or call, and budget signals the intelligence
 * package stored. It creates nothing: no master customer row, no copy, no
 * new table.
 *
 * Two layers, like the card (`card.js`): the pure shaping below (provable
 * without a database) and the batched reads in `operations.js`
 * (`listCustomerRecords`), which stays the only place that touches storage.
 */

export const CUSTOMER_LIST_CONTRACT = 1;

/** Display bound of one scan: contacts and companies are display reads. */
export const CUSTOMER_SCAN_LIMIT = 500;

/**
 * The ceiling of the search scan (backlog:d128847d21fc): rows read across
 * contacts and companies together when a text search must reach past
 * CUSTOMER_SCAN_LIMIT. A fixed bound, never the whole table — the web runs
 * on a small instance and the list read is already the slow one. Past it
 * the answer stays complete:false.
 */
export const CUSTOMER_SEARCH_SCAN_LIMIT = 5000;

/**
 * Rows of the shared search ceiling reserved for companies
 * (backlog:7d82fd84, review #678 giro-2 P3): contacts are scanned up to the
 * ceiling minus this reserve, companies up to the reserve, so a contact
 * scan that fills its budget never starves the company scan. Past either
 * bound the answer stays complete:false.
 */
export const CUSTOMER_SEARCH_COMPANY_RESERVE = 1000;

/**
 * Rows of the bounded identity scan behind a phone search (backlog:7d82fd84):
 * a digit-only query also scans the held identities for the digit
 * substring, so a phone held beside a customer past the subject scans is
 * still found. A fixed bound, never the whole table; past it the answer
 * stays complete:false. A full number (7 or more digits) is also looked up
 * by exact identity key, complete by construction.
 */
export const CUSTOMER_IDENTITY_SCAN_LIMIT = 1000;

/**
 * Bound of the last-contact preview in a list row (prototype "04 Clienti":
 * the Ultimo contatto cell shows the channel mark plus a short message
 * excerpt, never the full body). Single-line: newlines collapse to spaces.
 */
export const LAST_CONTACT_PREVIEW_CHARS = 140;

/**
 * Short single-line excerpt of the latest message for the list row. Calls
 * carry no text, so a latest call (or no activity) previews as null — the
 * view renders the channel and the date alone, never an invented excerpt.
 * @param {unknown} value the latest message body, if any
 */
export function previewLastContactText(value) {
  if (typeof value !== 'string') return null;
  const single = value.replace(/\s+/g, ' ').trim();
  if (single === '') return null;
  if (single.length <= LAST_CONTACT_PREVIEW_CHARS) return single;
  return `${single.slice(0, LAST_CONTACT_PREVIEW_CHARS).trimEnd()}…`;
}

/** Server page sizes from the approved prototype ("04 Clienti"). */
export const CUSTOMER_PAGE_SIZES = Object.freeze([10, 25, 50]);

/** Channels a customer row can carry: the sender vocabulary, reused. */
export const CUSTOMER_CHANNELS = Object.freeze([...CHANNEL_SYSTEMS]);

/**
 * Identity systems whose held id is a phone number. The subset mirrors the
 * card's `PHONE_SYSTEMS` (packages/customer-hub/src/card.js), which stays
 * the only dialability verdict: the list shows the held identity, never a
 * "callable" claim — that verdict is the scheda's, with its E.164 rule.
 */
export const PHONE_BEARING_SYSTEMS = Object.freeze(['whatsapp', 'sms', 'voice', 'phone', 'tel', 'mobile']);

/**
 * Quick views as saved queries. Each view is a filter descriptor over the
 * same query grammar the endpoint parses — saving a view stores the query,
 * never a row snapshot, so a view re-reads current records on every open.
 * The two derived views (`ricontattare-oggi`, `rinnovi-30-giorni`) need the
 * work and contracts packages: without them the view answers "not available"
 * with its reason, never a list that silently omits customers.
 */
/**
 * View order follows the approved prototype ("04 Clienti", checklist C10):
 * Tutti, Da ricontattare oggi, Nuovi lead, Clienti attivi, Rinnovi entro
 * 30 giorni. The list view renders the server order as sent, so the
 * canonical order lives here, not in the view.
 */
export const CUSTOMER_VIEWS = Object.freeze([
  { id: 'tutti', label: 'Tutti', filters: Object.freeze({}) },
  { id: 'ricontattare-oggi', label: 'Da ricontattare oggi', filters: Object.freeze({ ricontattareOggi: true }) },
  { id: 'nuovi-lead', label: 'Nuovi lead', filters: Object.freeze({ stato: 'contatto' }) },
  { id: 'clienti-attivi', label: 'Clienti attivi', filters: Object.freeze({ stato: 'cliente' }) },
  { id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni', filters: Object.freeze({ rinnoviGiorni: 30 }) },
  // «Da leggere» (backlog:9e003582): only customers with unread inbound
  // messages, most recent unread first. A saved query like the rest: no row
  // snapshot, so it re-reads current records on every open. Rows without
  // read state (no member, no watermark table) carry unreadCount null and
  // never match — the view reads empty, never everybody.
  { id: 'da-leggere', label: 'Da leggere', filters: Object.freeze({ daLeggere: true }) },
]);

/** Sort orders from the approved prototype ("04 Clienti"). */
export const CUSTOMER_SORTS = Object.freeze([
  { id: 'recent', label: 'Ultimo contatto' },
  { id: 'name', label: 'Nome A–Z' },
  { id: 'value', label: 'Valore offerta' },
  { id: 'status', label: 'Stato' },
]);

/** Prototype status order for the Stato sort. */
export const CUSTOMER_STATUS_ORDER = Object.freeze(['cliente', 'contatto']);

/**
 * Configurable columns. `cliente` is always visible; `budget` is the AI
 * column: it renders only from stored budget signals with their source, and
 * stays off (not broken) when the intelligence package has none.
 */
export const CUSTOMER_COLUMNS = Object.freeze([
  { id: 'cliente', label: 'Cliente', always: true, ai: false },
  { id: 'canali', label: 'Canali', always: false, ai: false, def: true },
  { id: 'stato', label: 'Stato', always: false, ai: false, def: true },
  { id: 'ultimo', label: 'Ultimo contatto', always: false, ai: false, def: true },
  { id: 'prossimo', label: 'Prossimo passo', always: false, ai: false, def: true },
  { id: 'email', label: 'Email', always: false, ai: false, def: false },
  { id: 'telefono', label: 'Telefono', always: false, ai: false, def: false },
  { id: 'offerta', label: 'Valore offerta', always: false, ai: false, def: false },
  { id: 'budget', label: 'Budget dichiarato', always: false, ai: true, def: false },
]);

/**
 * Strict query parsing for the list read. Everything refused is refused with
 * a 400 rather than a silent default: a page the caller did not ask for is
 * the same false-completeness bug the strict collection filter guards.
 * @param {any} input
 */
export function parseCustomerListQuery(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const text = (value, field, max) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new ValidationError(`customer list query: ${field} must be a string`, { field });
    if (value.length > max) throw new ValidationError(`customer list query: ${field} must be at most ${max} characters`, { field });
    return value;
  };
  const q = text(source.q, 'q', 200);
  const canale = source.canale === undefined || source.canale === null || source.canale === ''
    ? 'all'
    : String(source.canale).toLowerCase();
  if (canale !== 'all' && !CUSTOMER_CHANNELS.includes(/** @type {any} */ (canale))) {
    throw new ValidationError(`customer list query: unknown channel ${String(source.canale)}`, { field: 'canale' });
  }
  const stato = source.stato === undefined || source.stato === null || source.stato === '' ? 'all' : String(source.stato).toLowerCase();
  if (stato !== 'all' && stato !== 'cliente' && stato !== 'contatto') {
    throw new ValidationError('customer list query: stato must be cliente or contatto', { field: 'stato' });
  }
  const sort = source.sort === undefined || source.sort === null || source.sort === '' ? 'recent' : String(source.sort);
  if (!CUSTOMER_SORTS.some((entry) => entry.id === sort)) {
    throw new ValidationError(`customer list query: unknown sort ${sort}`, { field: 'sort' });
  }
  const vista = source.vista === undefined || source.vista === null || source.vista === '' ? 'tutti' : String(source.vista);
  const view = CUSTOMER_VIEWS.find((entry) => entry.id === vista);
  if (!view) throw new ValidationError(`customer list query: unknown view ${vista}`, { field: 'vista' });
  const pageSizeRaw = source.pageSize === undefined || source.pageSize === null || source.pageSize === '' ? 10 : Number(source.pageSize);
  if (!CUSTOMER_PAGE_SIZES.includes(/** @type {any} */ (pageSizeRaw))) {
    throw new ValidationError('customer list query: pageSize must be 10, 25 or 50', { field: 'pageSize' });
  }
  const pageRaw = source.page === undefined || source.page === null || source.page === '' ? 1 : Number(source.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    throw new ValidationError('customer list query: page must be a positive integer', { field: 'page' });
  }
  const spaceId = text(source.spaceId, 'spaceId', 200);
  // Custom-field filter (backlog:434cc39a): one space-wide field key plus an
  // optional value needle. Syntax-checked here; the field must exist or the
  // read refuses CUSTOM_FIELD_UNKNOWN in operations.js — a filter over an
  // unknown field would answer an exact-looking empty page.
  const campoRaw = text(source.campo, 'campo', 40);
  const campo = campoRaw === undefined ? undefined : campoRaw.toLowerCase();
  if (campo !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(campo)) {
    throw new ValidationError('customer list query: campo must be a field key slug', { field: 'campo' });
  }
  const valore = text(source.valore, 'valore', 200);
  return Object.freeze({
    q, canale, stato, sort, vista, view,
    page: pageRaw, pageSize: pageSizeRaw, spaceId,
    campo, valore,
  });
}

/**
 * Channel words in a search string act as a channel filter (the prototype's
 * "clienti di Milano su WhatsApp" behavior): deterministic, no LLM needed.
 * @param {string} q
 */
export function channelWordsIn(q) {
  const words = String(q ?? '').toLowerCase().split(/[^a-zà-öø-ÿ]+/i).filter((word) => word !== '');
  const names = {
    whatsapp: 'whatsapp', wa: 'whatsapp', instagram: 'instagram', ig: 'instagram',
    facebook: 'facebook', messenger: 'facebook', fb: 'facebook', tiktok: 'tiktok', tik: 'tiktok',
    email: 'email', mail: 'email', gmail: 'email', telefono: 'phone', phone: 'phone', tel: 'phone',
    sms: 'sms', voce: 'voice',
  };
  const hit = new Set();
  for (const word of words) {
    const channel = names[word];
    if (channel) hit.add(channel);
  }
  return [...hit];
}

/**
 * Glue words of the supported natural-language grammar ("clienti di Milano
 * su WhatsApp"): they join the place to the channel and carry no search
 * meaning, so they leave the text needle like the channel words do.
 */
const NL_GLUE_WORDS = Object.freeze(new Set(['di', 'su']));

/**
 * Search text folded for matching (backlog:d128847d21fc): lowercase and
 * without accents, so «Josè», «JOSE» and «jose» are one word.
 * @param {unknown} value
 */
export function foldSearchText(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
}

/** The folded words of a text: letters and digits, every other mark splits. @param {unknown} value */
function searchWords(value) {
  return foldSearchText(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
}

/**
 * The text needle of a search (backlog:d128847d21fc): the folded words of
 * `q` minus the channel words (they filter by channel) and the glue words
 * of the phrase grammar. Empty when only channel or glue words were typed.
 * @param {unknown} q
 */
export function searchNeedle(q) {
  const text = String(q ?? '');
  if (text.trim() === '') return [];
  const channelWordSet = new Set(channelWordsIn(text).flatMap((channel) => [channel, ...channelAliases(channel)]));
  return searchWords(text.replace(/^(chi è di|chi e di|clienti di|clienti)\s+/i, ''))
    .filter((word) => !channelWordSet.has(word) && !NL_GLUE_WORDS.has(word));
}

/** The shortest needle word that may match inside a word, not only at its start. */
export const SEARCH_INFIX_MIN_CHARS = 4;

/**
 * Digits in a query name a phone number, not words (backlog:7d82fd84,
 * review #678 giro-2 P3): the numeric words joined match as one substring
 * of the digits of a held phone, so «333» finds «+39333123456» while «ada»
 * still never matches inside «Canada». Fewer digits match nothing, so a
 * one- or two-digit query does not match every phone on the page.
 */
export const PHONE_SEARCH_MIN_DIGITS = 3;

/**
 * How a customer's searchable parts match the needle (backlog:d128847d21fc,
 * review #678): 0 when every needle word starts some word of the parts, 1
 * when every needle word matches but some only inside a word, -1 when one
 * does not match. A word of at least SEARCH_INFIX_MIN_CHARS letters may sit
 * inside a word («ovanni» finds «Giovanni», «xample» an «example» mailbox);
 * a shorter one only at the start, so «ada» finds «Ada Rossi» but not
 * «Canada». Case and accents never matter. Digits in the needle are also a
 * phone search (backlog:7d82fd84): the numeric words joined match inside
 * the digits of a held phone («333» finds «+39333123456»), ranked 1.
 * @param {Array<unknown>} parts name, email, company, phone
 * @param {Array<string>} needle from searchNeedle
 * @param {unknown} phone the phone-designated value (the held phone beside
 *   the row), or nothing when the caller has no phone: the digit rule below
 *   reads ONLY this value, never name/email/company digits, so «333» never
 *   matches «user333@example.com» (review agent-crm#707: digit-substring
 *   false positives).
 */
export function searchRank(parts, needle, phone = '') {
  if (!Array.isArray(needle) || needle.length === 0) return 0;
  const words = parts.filter((part) => typeof part === 'string' && part !== '').flatMap(searchWords);
  let rank = 0;
  let failed = false;
  for (const wanted of needle) {
    if (words.some((word) => word.startsWith(wanted))) continue;
    if (wanted.length >= SEARCH_INFIX_MIN_CHARS && words.some((word) => word.includes(wanted))) {
      rank = 1;
      continue;
    }
    failed = true;
    break;
  }
  if (!failed) return rank;
  // A needle carrying digits is also a phone search (backlog:7d82fd84):
  // every non-numeric word must still match by the word rules above, and
  // the joined digits must sit inside the digits of the HELD phone, so
  // «333» finds «+39333123456» and «Ada 333» finds Ada Rossi by her phone.
  // Ranked like an infix match, never a word start.
  const numeric = needle.filter((word) => /^[0-9]+$/.test(word));
  const text = needle.filter((word) => !/^[0-9]+$/.test(word));
  if (numeric.length > 0) {
    const digits = numeric.join('');
    const textOk = text.every((wanted) => words.some((word) => word.startsWith(wanted))
      || (wanted.length >= SEARCH_INFIX_MIN_CHARS && words.some((word) => word.includes(wanted))));
    if (textOk && digits.length >= PHONE_SEARCH_MIN_DIGITS
      && phoneDigitsOf(phone).includes(digits)) {
      return 1;
    }
  }
  return -1;
}

/** The digits of a value, for the phone-substring rule. @param {unknown} value */
export function phoneDigitsOf(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

/**
 * Whether a customer's searchable parts match the needle (see searchRank).
 * @param {Array<unknown>} parts name, email, company, phone
 * @param {Array<string>} needle from searchNeedle
 * @param {unknown} phone the phone-designated value (see searchRank)
 */
export function matchesSearch(parts, needle, phone = '') {
  return searchRank(parts, needle, phone) >= 0;
}

/** The searchable parts of a shaped list row: name, email, company, phone. @param {any} row */
function searchPartsOf(row) {
  return [row?.name, row?.email, row?.company?.name, row?.phone?.value];
}

/** All the words (canonical + aliases) that name one channel. */
function channelAliases(channel) {
  return {
    whatsapp: ['wa'], instagram: ['ig'], facebook: ['messenger', 'fb'],
    tiktok: ['tik'], email: ['mail', 'gmail'], phone: ['telefono', 'tel'],
    sms: [], voice: ['voce'],
  }[channel] ?? [];
}

/**
 * The saved-query semantic of one view: which extra predicates a view adds
 * on top of the explicit filters. Pure, so the endpoint and its tests share
 * it with the admin panel, which renders the same five views.
 * @param {{id: string}} view
 */
export function viewFilters(view) {
  return { ...(view?.filters ?? {}) };
}

/**
 * The row-matching stage of the list query, without sorting or pagination.
 * Pure, so the endpoint reuses it for the per-view pill counts: a pill count
 * is the same predicate the page itself applies, with that view's filters.
 * @param {Array<any>} rows shaped rows
 * @param {ReturnType<typeof parseCustomerListQuery>} query explicit filters (q, canale, stato)
 * @param {{id: string}} view the view whose extra predicates apply
 * @param {string} [todayIso] YYYY-MM-DD for the ricontattare-oggi view (injectable for tests)
 */
export function filterCustomerRows(rows, query, view, todayIso) {
  const all = Array.isArray(rows) ? rows : [];
  const viewExtra = viewFilters(view);
  const wantedStatus = query.stato !== 'all' ? query.stato : viewExtra.stato ?? 'all';
  const channelHits = query.q ? channelWordsIn(query.q) : [];
  // Channel words filter by channel AND are removed from the text: unlike the
  // prototype (which ignored the remaining words once a channel hit), "marco
  // whatsapp" must not match every WhatsApp customer. The remaining words
  // match by word start (backlog:d128847d21fc), never as one glued phrase.
  const textNeedle = searchNeedle(query.q ?? '');

  const today = typeof todayIso === 'string' && todayIso !== '' ? todayIso : new Date().toISOString().slice(0, 10);
  const needle = typeof query.valore === 'string' && query.valore !== ''
    ? query.valore.toLowerCase() : null;
  const filtered = all.filter((row) => {
    if (wantedStatus !== 'all' && row?.status?.value !== wantedStatus) return false;
    if (query.campo !== undefined) {
      const entry = (row?.customFields ?? []).find((field) => field?.key === query.campo) ?? null;
      if (entry === null || entry.value === null || entry.value === undefined) return false;
      if (needle !== null && !String(entry.value).toLowerCase().includes(needle)) return false;
    }
    if (query.canale !== 'all' && !(row?.channels ?? []).includes(query.canale)) return false;
    if (channelHits.length > 0 && !channelHits.some((channel) => (row?.channels ?? []).includes(channel))) return false;
    if (textNeedle.length > 0 && !matchesSearch(searchPartsOf(row), textNeedle, row?.phone?.value)) return false;
    if (viewExtra.ricontattareOggi === true && row?.nextStep?.dueAt?.slice(0, 10) !== today && !(row?.nextStep?.overdue === true)) return false;
    if (typeof viewExtra.rinnoviGiorni === 'number' && !(row?.renewalWithinDays === true)) return false;
    // «Da leggere»: only rows with unread inbound messages. A null
    // unreadCount (no member, no watermark table) never matches.
    if (viewExtra.daLeggere === true && !((row?.unreadCount ?? 0) > 0)) return false;
    return true;
  });
  return Object.freeze(filtered);
}

/**
 * Filter, sort and paginate shaped rows in memory. The scan behind `rows`
 * is a bounded display read (see CUSTOMER_SCAN_LIMIT): the answer carries
 * `complete: false` when the bound truncated it, and the total is exact only
 * when `complete` is true.
 * @param {Array<any>} rows shaped rows
 * @param {ReturnType<typeof parseCustomerListQuery>} query
 * @param {string} [todayIso] YYYY-MM-DD for the ricontattare-oggi view (injectable for tests)
 */
export function applyCustomerListQuery(rows, query, todayIso) {
  const filtered = filterCustomerRows(rows, query, query.view, todayIso);

  const byName = (a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'it');
  const lastContactMs = (row) => {
    const time = Date.parse(String(row?.lastContactAt ?? ''));
    return Number.isFinite(time) ? time : -1;
  };
  const lastUnreadMs = (row) => {
    const time = Date.parse(String(row?.lastUnreadAt ?? ''));
    return Number.isFinite(time) ? time : -1;
  };
  const sorted = [...filtered];
  if (query.sort === 'name') sorted.sort(byName);
  else if (query.sort === 'value') sorted.sort((a, b) => (Number(b?.offerValueCents ?? 0) - Number(a?.offerValueCents ?? 0)) || byName(a, b));
  else if (query.sort === 'status') {
    sorted.sort((a, b) => (
      CUSTOMER_STATUS_ORDER.indexOf(a?.status?.value) - CUSTOMER_STATUS_ORDER.indexOf(b?.status?.value)
    ) || byName(a, b));
  } else if (query.view?.id === 'da-leggere') {
    // «Da leggere» recency is the newest unread message, not the newest
    // contact: a customer whose latest event is an outbound reply still sorts
    // by the inbound message nobody read. Nulls (no unread) sort last.
    sorted.sort((a, b) => (lastUnreadMs(b) - lastUnreadMs(a)) || byName(a, b));
  } else {
    sorted.sort((a, b) => (lastContactMs(b) - lastContactMs(a)) || byName(a, b));
  }
  // Review #678: with text searched, word-start matches come first; the
  // chosen order holds inside each group (Array#sort is stable).
  const textNeedle = searchNeedle(query.q ?? '');
  if (textNeedle.length > 0) {
    const rankOf = new Map(sorted.map((row) => [row, searchRank(searchPartsOf(row), textNeedle, row?.phone?.value)]));
    sorted.sort((a, b) => rankOf.get(a) - rankOf.get(b));
  }

  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const start = (page - 1) * query.pageSize;
  return Object.freeze({
    items: Object.freeze(sorted.slice(start, start + query.pageSize)),
    total, page, pageSize: query.pageSize, pages,
  });
}

/**
 * Shape one list row from the host records and the batched reads. Pure: the
 * caller hands over maps keyed by `resource:id`, so this never touches
 * storage and the endpoint stays the only IO edge. The phone is the held
 * phone-bearing identity beside the record (a WhatsApp identity IS a phone
 * number; the contact record carries no phone field) — shown as held, never
 * as a dialability verdict, which stays the scheda's.
 * @param {{contact?: any, company?: any}} subject
 * @param {{identitiesBySubject?: Map<string, Array<any>>, observedChannelsBySubject?: Map<string, Array<string>>, observedComplete?: boolean, statusBySubject?: Map<string, any>, activityBySubject?: Map<string, any>, offerBySubject?: Map<string, any>, taskBySubject?: Map<string, any>, renewalBySubject?: Map<string, boolean>, budgetBySubject?: Map<string, any>, customFieldsBySubject?: Map<string, Array<any>>}} reads
 *   customFields entries are shaped `{ key, label, type, options, value, updatedAt, updatedBy }`
 *   (backlog:434cc39a): every defined field reads on every row — the list
 *   columns — with a null value when never set.
 *   observedComplete is scan-wide (backlog:826e377c): false when the
 *   message or call scan behind the observed channels was partial or
 *   unreadable — the row then reads channelsComplete:false instead of an
 *   exact union. Absent means exact, so hand-built reads stay honest.
 *   activity entries name `{ occurredAt, channel, text }`: `text` is the
 *   latest message body (a call carries none, so it stays null there).
 *   observed channels name the message channels read for this customer in
 *   the same scan (backlog:826e377c), already on the canale-filter
 *   vocabulary (CUSTOMER_CHANNELS, see operations.js).
 *   The CANALI column unions every held identity system (imports accept any
 *   lowercase system, so legacy sms/gmail/voice rows exist and are held —
 *   main listed them) with those observed channels, so a customer with
 *   messages but no held identity still shows its channels. It is NOT the
 *   same union the scheda's Identità collegate reads: that section lists
 *   only the observed timeline channels in the wider display vocabulary
 *   (CHANNEL_LABELS), while held identities stay in the profile and in this
 *   column. A held sms row names its channel here even though canale=sms
 *   still refuses with 400 — the filter vocabulary is unchanged on purpose.
 */
export function shapeCustomerRow(subject, reads = {}) {
  const contact = subject?.contact ?? null;
  const company = subject?.company ?? null;
  const resource = contact ? 'contact' : 'company';
  const id = contact?.id ?? company?.id ?? null;
  if (!id) throw new ValidationError('a customer row needs a contact or a company', { field: 'id' });
  const key = `${resource}:${id}`;
  const name = contact
    ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email
    : company?.name ?? null;
  const identities = reads.identitiesBySubject?.get(key) ?? [];
  const observed = reads.observedChannelsBySubject?.get(key) ?? [];
  // Review giro-6 on 826e377c (P1 head f1ed030c): the held side keeps
  // every system main showed — filtering it to CUSTOMER_CHANNELS hid held
  // legacy sms/gmail/voice rows that main listed in CANALI. Only the
  // observed side keeps the filter vocabulary (operations.js already feeds
  // it on CUSTOMER_CHANNELS; the filter below keeps direct callers honest),
  // so the column never invents an observed channel its own filter refuses.
  const heldChannels = identities
    .map((row) => String(row?.system ?? '').toLowerCase())
    .filter((system) => system !== '');
  const observedChannels = observed
    .map((channel) => String(channel ?? '').toLowerCase())
    .filter((channel) => channel !== '' && CUSTOMER_CHANNELS.includes(/** @type {any} */ (channel)));
  const channels = [...new Set([...heldChannels, ...observedChannels])].sort();
  // Review giro-7 on 826e377c (P1 head 3c77ca1): the union is exact only
  // when the observed half behind it was fully read. A partial or
  // unreadable message/call scan still shapes its best-effort channels,
  // but the row marks them partial — canale-filtered queries refuse
  // upstream instead of filtering over this short union.
  const channelsComplete = reads.observedComplete !== false;
  const phoneIdentity = identities.find((row) => PHONE_BEARING_SYSTEMS.includes(String(row?.system ?? '').toLowerCase())) ?? null;
  const status = reads.statusBySubject?.get(key)
    ?? { value: 'contatto', reason: 'no signed-business evidence was read for this customer in the list scan' };
  const activity = reads.activityBySubject?.get(key) ?? null;
  const offer = reads.offerBySubject?.get(key) ?? null;
  // «Da leggere» (backlog:9e003582): inbound messages nobody read, counted
  // with the core's one unread rule. Nulls when the caller passed no read
  // state (no member, no watermark table) — never an invented zero.
  const unread = reads.unreadBySubject?.get(key) ?? null;
  const task = reads.taskBySubject?.get(key) ?? null;
  const budget = reads.budgetBySubject?.get(key)
    ?? { available: false, value: null, source: null, reason: 'nessun budget estratto dall\u2019AI per questo cliente' };
  return Object.freeze({
    customerListContract: CUSTOMER_LIST_CONTRACT,
    subject: Object.freeze({ resource, id }),
    name, resource, id,
    // The reserved «no company» behind a contact typed without Azienda
    // reads as no company (production 07/11), never as a company name.
    company: company && !(contact && isNoCompany(company)) ? Object.freeze({ id: company.id, name: company.name }) : null,
    email: contact?.email ?? null,
    phone: phoneIdentity ? Object.freeze({ value: phoneIdentity.externalId ?? null, system: phoneIdentity.system ?? null }) : null,
    channels: Object.freeze(channels),
    channelsComplete,
    status: Object.freeze({ value: status.value ?? 'contatto', reason: status.reason ?? null }),
    lastContactAt: activity?.occurredAt ?? null,
    lastContactChannel: activity?.channel ?? null,
    lastContactText: previewLastContactText(activity?.text ?? null),
    unreadCount: unread === null ? null : unread.unread,
    lastUnreadAt: unread === null ? null : (unread.lastUnreadAt ?? null),
    offerValueCents: offer?.valueCents ?? null,
    offerCurrency: offer?.currency ?? null,
    nextStep: task ? Object.freeze({ title: task.title ?? null, dueAt: task.dueAt ?? null, overdue: task.overdue ?? false }) : null,
    renewalWithinDays: reads.renewalBySubject?.get(key) === true,
    budget: Object.freeze({
      available: budget.available === true,
      value: budget.available === true ? (budget.value ?? null) : null,
      source: budget.available === true ? (budget.source ?? null) : null,
      reason: budget.available === true ? null : (budget.reason ?? null),
    }),
    customFields: Object.freeze((reads.customFieldsBySubject?.get(key) ?? []).map((entry) => Object.freeze({
      key: entry?.key ?? null,
      label: entry?.label ?? null,
      type: entry?.type ?? null,
      options: Object.freeze(Array.isArray(entry?.options) ? [...entry.options] : []),
      value: entry?.value ?? null,
      updatedAt: entry?.updatedAt ?? null,
      updatedBy: entry?.updatedBy ?? null,
    }))),
  });
}
