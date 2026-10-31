// @ts-check

import { ValidationError } from '../../core/index.js';
import { CHANNEL_SYSTEMS } from './sender.js';

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
  return Object.freeze({
    q, canale, stato, sort, vista, view,
    page: pageRaw, pageSize: pageSizeRaw, spaceId,
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
  const haystackOf = (row) => [
    row?.name, row?.email, row?.company?.name, row?.phone?.value,
  ].filter((part) => typeof part === 'string' && part !== '').join(' ').toLowerCase();
  // Channel words filter by channel AND are removed from the text: unlike the
  // prototype (which ignored the remaining words once a channel hit), "marco
  // whatsapp" must not match every WhatsApp customer.
  const channelWordSet = new Set(channelHits.flatMap((channel) => [channel, ...channelAliases(channel)]));
  const strippedQ = (query.q ?? '')
    .replace(/^(chi è di|chi e di|clienti di|clienti)\s+/i, '')
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9+]+/i)
    .filter((word) => word !== '' && !channelWordSet.has(word) && !NL_GLUE_WORDS.has(word))
    .join(' ');

  const today = typeof todayIso === 'string' && todayIso !== '' ? todayIso : new Date().toISOString().slice(0, 10);
  const filtered = all.filter((row) => {
    if (wantedStatus !== 'all' && row?.status?.value !== wantedStatus) return false;
    if (query.canale !== 'all' && !(row?.channels ?? []).includes(query.canale)) return false;
    if (channelHits.length > 0 && !channelHits.some((channel) => (row?.channels ?? []).includes(channel))) return false;
    if (strippedQ !== '' && !haystackOf(row).includes(strippedQ)) return false;
    if (viewExtra.ricontattareOggi === true && row?.nextStep?.dueAt?.slice(0, 10) !== today && !(row?.nextStep?.overdue === true)) return false;
    if (typeof viewExtra.rinnoviGiorni === 'number' && !(row?.renewalWithinDays === true)) return false;
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
  const sorted = [...filtered];
  if (query.sort === 'name') sorted.sort(byName);
  else if (query.sort === 'value') sorted.sort((a, b) => (Number(b?.offerValueCents ?? 0) - Number(a?.offerValueCents ?? 0)) || byName(a, b));
  else if (query.sort === 'status') {
    sorted.sort((a, b) => (
      CUSTOMER_STATUS_ORDER.indexOf(a?.status?.value) - CUSTOMER_STATUS_ORDER.indexOf(b?.status?.value)
    ) || byName(a, b));
  } else {
    sorted.sort((a, b) => (lastContactMs(b) - lastContactMs(a)) || byName(a, b));
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
 * @param {{identitiesBySubject?: Map<string, Array<any>>, observedChannelsBySubject?: Map<string, Array<string>>, observedComplete?: boolean, statusBySubject?: Map<string, any>, activityBySubject?: Map<string, any>, offerBySubject?: Map<string, any>, taskBySubject?: Map<string, any>, renewalBySubject?: Map<string, boolean>, budgetBySubject?: Map<string, any>}} reads
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
  const task = reads.taskBySubject?.get(key) ?? null;
  const budget = reads.budgetBySubject?.get(key)
    ?? { available: false, value: null, source: null, reason: 'nessun budget estratto dall\u2019AI per questo cliente' };
  return Object.freeze({
    customerListContract: CUSTOMER_LIST_CONTRACT,
    subject: Object.freeze({ resource, id }),
    name, resource, id,
    company: company ? Object.freeze({ id: company.id, name: company.name }) : null,
    email: contact?.email ?? null,
    phone: phoneIdentity ? Object.freeze({ value: phoneIdentity.externalId ?? null, system: phoneIdentity.system ?? null }) : null,
    channels: Object.freeze(channels),
    channelsComplete,
    status: Object.freeze({ value: status.value ?? 'contatto', reason: status.reason ?? null }),
    lastContactAt: activity?.occurredAt ?? null,
    lastContactChannel: activity?.channel ?? null,
    lastContactText: previewLastContactText(activity?.text ?? null),
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
  });
}
