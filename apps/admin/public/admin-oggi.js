// @ts-check

// Home under a space mount (BO-F3-04 — backlog:8e07adfee555).
//
// When the shell is served at the domain root the home is the framework demo
// dashboard (apps/admin/public/admin-demo.js). When the same shell is mounted
// for a space (createAdminShellMount with a basePath such as `/bo`), a space
// user must never see that demo: the home is the Oggi screen from the
// approved prototype — a greeting with a one-sentence recap, the Advisor with
// its actions, the progress bar, today's agenda, the pre-call brief with
// clickable sources, and the invite for the missing channels — with no
// invented data anywhere.
//
// Conventions follow apps/admin/public/admin-shell.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile record strings are inert text,
// never markup.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the generic /api/modules/:module/records surface over the native
//   record modules of packages/work (work-task), packages/appointments
//   (appointment), packages/channels (channel-connection) and
//   packages/interactions (interaction-message, interaction-call);
// - writes: the work-task `complete` module action, the same server path the
//   Work section uses — executing from Oggi re-reads the cited record first
//   and refuses on drift, so no action ever runs on stale data;
// - labels: CONNECTOR_CATALOG from admin-connectors.js for the channel
//   invite — one Italian label list, not two;
// - the backoffice tokens and rows of styles.css (bo-*), single column under
//   700px like every other backoffice screen.

import { CONNECTOR_CATALOG } from './admin-connectors.js';
import { NINE_CHANNEL_IDS, channelConnectRoute, channelConnectionCount, mergeProfileConnections } from './admin-channels-count.js';
import { bindAdminMutations } from './admin-submission.js';
import { memberLabel, nameFromProfile, readableName } from './admin-labels.js';

/**
 * Framework demo strings. None of them may reach a space user: the mount
 * serves no demo markup (see admin-demo.js) and the Oggi screen below renders
 * none of them. Tests assert both.
 */
export const DEMO_STRINGS = Object.freeze([
  'Commercial logic',
  'Run demo',
  'Opportunities',
  'Approvals',
  'Workflow traces',
]);

/**
 * Whether the shell runs mounted for a space. The mount injects
 * `<meta name="admin-base" content="/bo">` (or the fuller public path);
 * the standalone server owns the domain root, so the prefix is empty there.
 * @param {unknown} adminBase
 */
export function isSpaceMount(adminBase) {
  return typeof adminBase === 'string' && adminBase !== '';
}

/**
 * Time-aware Italian greeting for the given hour of day (0-23).
 * @param {unknown} hour
 */
export function greetingForHour(hour) {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return 'Buongiorno';
  if (hour >= 5 && hour < 12) return 'Buongiorno';
  if (hour >= 12 && hour < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

/**
 * The date line above the greeting, in Italian ("Lunedì 19 ottobre").
 * Always the real current date — never a fixed showcase date.
 * @param {Date} [now]
 */
export function oggiDateLine(now = new Date()) {
  const text = new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Links to the screens that are already delivered: the shell's available
 * voices, minus Oggi itself (the open screen). Disabled voices stay out —
 * they name the story that delivers them in the sidebar already, and the
 * home must never link a screen that is not there.
 * @param {Array<{ id?: unknown, label?: unknown, route?: unknown, available?: unknown }>} shellItems
 */
export function buildOggiLinks(shellItems) {
  if (!Array.isArray(shellItems)) return [];
  const links = [];
  for (const item of shellItems) {
    if (item == null || item.id === 'oggi') continue;
    if (item.available !== true) continue;
    if (typeof item.route !== 'string' || item.route === '') continue;
    if (typeof item.label !== 'string' || item.label === '') continue;
    links.push({ id: item.id, label: item.label, route: item.route });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Rome clock. Whoever uses the app always sees Rome time: instants are
// formatted with timeZone 'Europe/Rome', never as UTC or ISO.
// ---------------------------------------------------------------------------

/** IANA zone for every time shown in Oggi. */
export const OGGI_TIME_ZONE = 'Europe/Rome';

/**
 * Parse a Date or ISO string, null when it is not a real instant.
 * @param {unknown} value
 */
function toInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Rome calendar day of an instant, 'YYYY-MM-DD', null when unparsable.
 * @param {unknown} value
 */
export function romeDayKey(value) {
  const instant = toInstant(value);
  if (!instant) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: OGGI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * Rome clock time of an instant, 'HH:MM', null when unparsable.
 * @param {unknown} value
 */
export function romeTime(value) {
  const instant = toInstant(value);
  if (!instant) return null;
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: OGGI_TIME_ZONE, hour: '2-digit', minute: '2-digit',
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * Short Italian day for motives and agenda meta ("19 ott"), null when
 * unparsable. Never the year: motives talk about this season's records.
 * @param {unknown} value
 */
export function romeShortDay(value) {
  const instant = toInstant(value);
  if (!instant) return null;
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: OGGI_TIME_ZONE, day: 'numeric', month: 'short',
    }).format(instant).replace(/\./g, '');
  } catch {
    return null;
  }
}

/**
 * Day and full month on the Rome calendar («12 novembre»), null when
 * unparsable (backlog:7d30fb517785: Oggi writes dates the way a person
 * does, never «12 nov»). Never the year, like romeShortDay.
 * @param {unknown} value
 */
export function romeLongDay(value) {
  const instant = toInstant(value);
  if (!instant) return null;
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: OGGI_TIME_ZONE, day: 'numeric', month: 'long',
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * The Rome calendar day `shift` days from `now`'s Rome day, 'YYYY-MM-DD',
 * null when `now` is not a real instant. Calendar arithmetic on the Rome
 * date, never `now` ± 24 h: a 23 h or 25 h day (the DST change on the last
 * Sunday of March and October) would skip or repeat a day (review #746).
 * @param {unknown} now
 * @param {number} shift
 */
export function romeDayKeyShift(now, shift) {
  const key = romeDayKey(now);
  if (key === null) return null;
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + shift)).toISOString().slice(0, 10);
}

/**
 * A day as Oggi writes it after a preposition (backlog:7d30fb517785,
 * production 10/11: «Appuntamento di 12 nov»): «oggi», «ieri», «domani» on
 * those Rome days, else the day with its article — `del` gives «del 12
 * novembre» / «dell'8 novembre», `il` gives «il 12 novembre» / «l'8
 * novembre». Null when unparsable.
 * @param {unknown} value
 * @param {Date} now
 * @param {'del' | 'il'} article
 */
export function romeDayPhrase(value, now, article) {
  const key = romeDayKey(value);
  if (key === null) return null;
  const near = [[0, 'oggi'], [-1, 'ieri'], [1, 'domani']].find(([shift]) => romeDayKeyShift(now, shift) === key);
  if (near) return article === 'del' ? `di ${near[1]}` : near[1];
  const long = romeLongDay(value);
  if (long === null) return null;
  // «l'8», «l'11», «l'1»: the number is read with a vowel.
  const elided = /^(1|8|11) /.test(long);
  if (article === 'del') return elided ? `dell\u2019${long}` : `del ${long}`;
  return elided ? `l\u2019${long}` : `il ${long}`;
}

/**
 * Whether an instant falls on the Rome-calendar day of `now`.
 * @param {unknown} value
 * @param {Date} [now]
 */
export function isTodayInRome(value, now = new Date()) {
  const day = romeDayKey(value);
  if (day === null) return false;
  return day === romeDayKey(now);
}

// ---------------------------------------------------------------------------
// Advisor actions. Every action cites the record that motivates it — the
// `record` triple (module, id, href) is mandatory, never optional, so an
// action can never render without something real to point at. Status-note
// style (admin-assistant.js) value objects: frozen, DOM-free.
// ---------------------------------------------------------------------------

/** Display bound per read and cap on the advisor list: both disclosed on screen. */
export const OGGI_READ_LIMIT = 100;
export const ADVISOR_ACTION_LIMIT = 10;

/**
 * @param {unknown} value
 */
function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @param {unknown} value
 */
function isCanonicalModule(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

/**
 * Encode one path segment for a hash route: a hostile id never becomes a
 * lookup outside its own segment.
 * @param {unknown} value
 */
function segment(value) {
  return encodeURIComponent(String(value ?? ''));
}

/**
 * Customer-card route for a host-owned subject, null when the subject cannot
 * open a scheda (package-owned or malformed). The appointment record detail
 * stays the fallback, so the agenda never holds a dead link.
 * @param {{ subjectOwner?: unknown, subjectResource?: unknown, subjectId?: unknown }} subject
 */
export function cardHrefForSubject(subject) {
  if (subject?.subjectOwner !== 'host') return null;
  if (!isCanonicalModule(subject.subjectResource)) return null;
  const id = nonEmptyText(subject.subjectId);
  if (!id) return null;
  return `#/customer-card/${subject.subjectResource}/${segment(id)}`;
}

/**
 * @param {string} module
 * @param {unknown} id
 */
export function recordDetailHref(module, id) {
  return `#/modules/${module}/${segment(id)}`;
}

/**
 * Label shown for the cited record: the stored snapshot label when present,
 * otherwise a generic Italian name — never a technical `resource · id`
 * (the screen must never print labels like "lead · lead-1").
 * @param {{ subjectLabel?: unknown, subjectResource?: unknown, subjectId?: unknown }} row
 */
function subjectDisplayLabel(row, names = {}) {
  // The customer's readable name first (backlog:5083e7a77c26, production
  // 08/11: the brief read «il cliente · 10 nov alle 11:00» for Fio Neri —
  // the channel syncs store no subject label on the appointment): the
  // profile name read for that subject, else the stored label, and «il
  // cliente» only when no name exists at all.
  const key = inboxSubjectKey(row);
  const fromProfile = key && names !== null && typeof names === 'object' && Object.hasOwn(names, key)
    ? readableName(nonEmptyText(names[key])) : null;
  return fromProfile ?? readableName(nonEmptyText(row?.subjectLabel)) ?? 'il cliente';
}

/**
 * The next call's guest name, or null when no name exists yet — never a
 * stand-in noun. The next-call card (verification 09/11, backlog
 * 1a3a0ba236c0) must not print «il cliente» before the name: with no
 * stored or profile name it waits for the name with a neutral
 * placeholder, never a presumed customer.
 */
const APPOINTMENT_GUEST_LABEL = 'un ospite da confermare';

/**
 * @param {{ subjectLabel?: unknown, subjectResource?: unknown, subjectId?: unknown }} appointment
 * @param {Record<string, string|null>} [names] profile names by `resource:id`
 */
function appointmentGuestName(appointment, names = {}) {
  const key = inboxSubjectKey(appointment);
  const fromProfile = key && names !== null && typeof names === 'object' && Object.hasOwn(names, key)
    ? readableName(nonEmptyText(names[key])) : null;
  return fromProfile ?? readableName(nonEmptyText(appointment?.subjectLabel));
}

/**
 * One advisor action from an open follow-up. The CTA completes the real
 * work-task (same server action the Work section uses); the motive names the
 * record that opened it.
 * @param {Record<string, any>} task an open work-task row
 */
/**
 * The prototype's row badge: a short human mark (initials of the person the
 * action is about), never a record id or a kind code.
 * @param {unknown} label
 */
const OGGI_CHANNEL_TILES = Object.freeze({ whatsapp: 'WA', instagram: 'IG', facebook: 'FB', tiktok: 'TT', email: '@', phone: 'TEL', voice: 'TEL', sms: 'SMS', web: 'WEB', stripe: 'S', calendar: 'CAL' });
/** The prototype's channel tile mark, or null when the channel is unknown. */
function channelTile(channel) {
  return OGGI_CHANNEL_TILES[String(channel ?? '').toLowerCase()] ?? null;
}

/**
 * The prototype's primary-action verb per channel: the card does what the
 * channel asks (reply, call, send), it never says the generic "Completa".
 * Channels the prototype shows no card for keep the generic verb — the run
 * behind the button is unchanged (the work-task `complete` action), only
 * the word on it follows the prototype.
 * @param {unknown} channel
 */
const OGGI_CHANNEL_CTA = Object.freeze({
  email: 'Invia follow-up',
  whatsapp: 'Rispondi',
  sms: 'Rispondi',
  tiktok: 'Rispondi',
  phone: 'Chiama',
  voice: 'Chiama',
  instagram: 'Riscrivi',
  stripe: 'Invia promemoria',
});
/** The prototype's CTA verb for the channel, or null when it has none. */
function channelCta(channel) {
  return OGGI_CHANNEL_CTA[String(channel ?? '').toLowerCase()] ?? null;
}

function badgeInitials(label) {
  const words = String(label ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const marks = words.slice(0, 2).map((word) => (word.match(/\p{L}/u)?.[0] ?? '').toUpperCase());
  return marks.join('') || '·';
}

function followupAction(task, now = new Date()) {
  const id = nonEmptyText(task?.id);
  if (!id) return null;
  const title = nonEmptyText(task?.title) ?? 'Follow-up';
  const label = subjectDisplayLabel(task);
  // «aperto l'8 novembre», «aperto ieri» (backlog:7d30fb517785).
  const opened = romeDayPhrase(task?.openedAt, now, 'il');
  const why = `Follow-up aperto${opened ? ` ${opened}` : ''}: ${label}.`;
  return Object.freeze({
    id: `bo04:followup:${id}`,
    kind: 'followup',
    mono: channelTile(task?.channel) ?? badgeInitials(label),
    channel: nonEmptyText(task?.channel) ?? null,
    note: nonEmptyText(task?.note) ?? null,
    title,
    why,
    cta: channelCta(task?.channel) ?? 'Completa',
    run: 'complete-task',
    href: `#/work/${segment(id)}`,
    record: Object.freeze({
      module: 'work-task', id, label, href: `#/work/${segment(id)}`,
    }),
    snapshot: Object.freeze({
      status: task?.status ?? null,
      dueAt: task?.dueAt ?? null,
      title: task?.title ?? null,
    }),
  });
}

/**
 * One advisor action preparing today's next appointment. The CTA opens the
 * customer scheda (or the appointment record when no scheda resolves): the
 * preparation itself happens on fresh reads there, so this run navigates
 * rather than duplicating a mutation the scheda already owns.
 * @param {Record<string, any>} appointment a booked/confirmed appointment row
 * @param {Record<string, string|null>} [names] profile names by `resource:id`
 */
function appointmentPrepAction(appointment, names = {}) {
  const id = nonEmptyText(appointment?.id);
  if (!id) return null;
  const time = romeTime(appointment?.startsAt);
  if (!time) return null;
  const label = appointmentGuestName(appointment, names) ?? APPOINTMENT_GUEST_LABEL;
  const href = cardHrefForSubject(appointment) ?? recordDetailHref('appointment', id);
  return Object.freeze({
    id: `bo04:appointment:${id}`,
    kind: 'appointment-prep',
    mono: 'CAL',
    channel: 'calendar',
    title: `Prepara la call con ${label}`,
    why: `Appuntamento oggi alle ${time} con ${label}.`,
    cta: 'Apri scheda',
    run: 'open',
    href,
    record: Object.freeze({
      module: 'appointment', id, label: `Appuntamento delle ${time} con ${label}`, href,
    }),
    snapshot: Object.freeze({
      status: appointment?.status ?? null,
      startsAt: appointment?.startsAt ?? null,
    }),
  });
}

/**
 * Deterministic advisor list: open follow-ups due (overdue first), then the
 * preparation of today's next appointment. Capped — the screen says so when
 * the cap hides actions.
 * @param {{ tasks?: Array<Record<string, any>>, appointments?: Array<Record<string, any>>, now?: Date, names?: Record<string, string|null> }} input
 */
export function buildAdvisorActions({ tasks = [], appointments = [], now = new Date(), names = {} } = {}) {
  const open = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task != null && task.status === 'open');
  open.sort((a, b) => {
    const left = a?.dueAt == null || a.dueAt === '' ? null : String(a.dueAt);
    const right = b?.dueAt == null || b.dueAt === '' ? null : String(b.dueAt);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const actions = [];
  for (const task of open) {
    const action = followupAction(task, now);
    if (action) actions.push(action);
  }
  const today = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && isTodayInRome(row.startsAt, now));
  today.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  if (today.length > 0) {
    const prep = appointmentPrepAction(today[0], names);
    if (prep) actions.push(prep);
  }
  const capped = actions.length > ADVISOR_ACTION_LIMIT;
  return Object.freeze({
    actions: Object.freeze(actions.slice(0, ADVISOR_ACTION_LIMIT)),
    capped,
  });
}

// ---------------------------------------------------------------------------
// Triage. "Fatto" and "Rimandato a domani" are decisions on the suggestion:
// the map holds only decided suggestions, so a reload recomputes every
// suggestion from its record and drops the ones whose record is gone or
// closed. "Domani" on a follow-up is durable — it runs the work-task
// `postpone` action, moving the due date and writing a timeline note — and
// the triage flag is only the attenuated paint. A durable deferral offers no
// session "Annulla": clearing the flag would display the suggestion as
// undecided while tomorrow's date stays stored. Session-only decisions (the
// pre-call prep, which navigates instead of mutating) keep "Annulla", which
// truly reverses them. Session-local on purpose (same precedent as the
// assistant panel history): the durable facts live in the cited records, and
// triage never invents domain state.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} actionId
 */
function isTriageKey(actionId) {
  return typeof actionId === 'string' && actionId !== '' && actionId.length <= 200;
}

/**
 * Record a triage decision. Unknown decisions and unknown keys leave the map
 * untouched — the screen only ever sends keys it rendered.
 * @param {Record<string, string>} [triage]
 * @param {unknown} actionId
 * @param {unknown} decision 'done' | 'postpone'
 */
export function applyTriageDecision(triage, actionId, decision) {
  const base = triage != null && typeof triage === 'object' ? { ...triage } : {};
  if (!isTriageKey(actionId)) return base;
  if (decision !== 'done' && decision !== 'postpone') return base;
  base[actionId] = decision;
  return base;
}

/**
 * Undo a triage decision: the suggestion returns open.
 * @param {Record<string, string>} [triage]
 * @param {unknown} actionId
 */
export function undoTriage(triage, actionId) {
  if (triage == null || typeof triage !== 'object' || Array.isArray(triage)) return {};
  if (!isTriageKey(actionId) || !Object.hasOwn(triage, actionId)) return { ...triage };
  const next = { ...triage };
  delete next[actionId];
  return next;
}

/**
 * @param {Record<string, string>} [triage]
 * @param {unknown} actionId
 */
export function triageState(triage, actionId) {
  const decision = triage != null && typeof triage === 'object' ? triage[actionId] : undefined;
  if (decision === 'done') return 'done';
  if (decision === 'postpone') return 'postponed';
  return 'open';
}

/**
 * Progress over today's suggestions: done over total. A postponed card is
 * not «fatta» — the prototype's bar counts done cards only
 * (backlog:9c7d1477a8d4).
 * @param {Array<{ id?: unknown }>} [actions]
 * @param {Record<string, string>} [triage]
 */
export function advisorProgress(actions = [], triage = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const handled = list.filter((action) => triageState(triage, action?.id) === 'done').length;
  return Object.freeze({ handled, total: list.length });
}

// ---------------------------------------------------------------------------
// Execute with a fresh read. Before any mutation the cited record is read
// again by id and the fields the suggestion depended on are compared: on any
// drift the run refuses with OGGI_STALE_RECORD and the domain action never
// fires — no action ever runs on stale data.
// ---------------------------------------------------------------------------

/**
 * Fields of the cited snapshot that no longer match the fresh row.
 * @param {Record<string, unknown>} [snapshot]
 * @param {Record<string, unknown>} [fresh]
 */
export function staleFields(snapshot = {}, fresh = {}) {
  const drift = [];
  const base = snapshot != null && typeof snapshot === 'object' ? snapshot : {};
  const current = fresh != null && typeof fresh === 'object' ? fresh : {};
  for (const key of Object.keys(base)) {
    const expected = base[key] ?? null;
    const actual = current[key] ?? null;
    if (expected !== actual) drift.push(key);
  }
  return drift;
}

/**
 * Re-read the cited record and run only when nothing it depended on moved.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {{ record?: { module?: unknown, id?: unknown }, snapshot?: Record<string, unknown> }} action
 * @param {(action: any, fresh: any) => Promise<any>} run the domain dispatch
 */
export async function executeAdvisorAction(client, action, run) {
  const module = action?.record?.module;
  const id = action?.record?.id;
  if (!isCanonicalModule(module) || !nonEmptyText(id)) {
    const error = new Error('Questa azione non cita un record valido: non può essere eseguita.');
    error.code = 'OGGI_INVALID_RECORD';
    throw error;
  }
  if (typeof run !== 'function') {
    const error = new Error('Azione senza esecuzione: non può partire.');
    error.code = 'OGGI_INVALID_RUN';
    throw error;
  }
  const fresh = await client.request(`/api/modules/${module}/records/${segment(id)}`);
  const drift = staleFields(action?.snapshot ?? {}, fresh ?? {});
  if (drift.length > 0) {
    // The drifted field names stay in `details`: they are internal names,
    // never screen copy (C23, backlog:9c7d1477a8d4).
    const error = new Error('Il dato è cambiato mentre leggevi: ricarica e rileggi prima di agire.');
    error.code = 'OGGI_STALE_RECORD';
    error.details = { fields: drift };
    throw error;
  }
  return run(action, fresh);
}

// ---------------------------------------------------------------------------
// Recap, agenda, pre-call brief, channel invite. Every line comes from a
// record just read: counts from real rows, names from stored labels, sources
// as links to the records themselves. Nothing is invented to fill a gap —
// a gap renders as its own honest line.
// ---------------------------------------------------------------------------

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 */
function countNoun(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * One-sentence recap of the day, verbatim from the prototype: open chores
 * and today's appointments with a minute estimate, or the no-pending line.
 * The closing promise names prepared messages only when a task actually
 * carries a draft note — a manual call with no draft must never read as
 * prepared work. AI stays out of it: without a configured key the llm
 * package is dry-run only, and a recap must never read as generated
 * insight — it is arithmetic over records.
 * @param {{ appointments?: Array<Record<string, any>>, openTasks?: Array<Record<string, any>>, now?: Date }} input
 */
export function buildTodayRecap({ appointments = [], openTasks = [], now = new Date() } = {}) {
  const today = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && isTodayInRome(row.startsAt, now));
  today.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  const tasks = Array.isArray(openTasks)
    ? openTasks.filter((row) => row != null && row.status === 'open')
    : [];
  // backlog:7d30fb517785 (production 10/11: «Ti restano 1 appuntamento.»):
  // the verb agrees with the count, and zero reads as a person says it.
  if (tasks.length === 0) {
    if (today.length === 0) return 'Niente in sospeso e nessun appuntamento per oggi.';
    return `Niente in sospeso. ${today.length === 1 ? 'Ti resta' : 'Ti restano'} ${countNoun(today.length, 'appuntamento', 'appuntamenti')}.`;
  }
  const appointmentsPart = today.length === 0 ? 'nessun appuntamento' : countNoun(today.length, 'appuntamento', 'appuntamenti');
  const base = `Oggi hai ${countNoun(tasks.length, 'cosa da fare', 'cose da fare')} e ${appointmentsPart}. Ti servono circa ${tasks.length * 3} minuti`;
  const drafted = tasks.filter((row) => nonEmptyText(row?.note) !== null).length;
  return drafted > 0 ? `${base}: ho già preparato i messaggi.` : `${base}.`;
}

/**
 * Today's booked or confirmed appointments, in start order: the rows the
 * agenda renders.
 * @param {Array<Record<string, any>>} [appointments]
 * @param {Date} [now]
 */
function buildTodayAgendaRows(appointments = [], now = new Date()) {
  const today = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && romeTime(row.startsAt) !== null
      && isTodayInRome(row.startsAt, now));
  today.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  return today;
}

/**
 * Today's agenda: booked/confirmed appointments on the Rome day, oldest
 * first. Each row links the customer scheda when the subject resolves, else
 * the appointment record itself — never a dead link.
 * @param {Array<Record<string, any>>} [appointments]
 * @param {Date} [now]
 * @param {Record<string, string|null>} [names] profile names by `resource:id`
 */
export function buildTodayAgenda(appointments = [], now = new Date(), names = {}, members = []) {
  const today = buildTodayAgendaRows(appointments, now);
  return today.map((row) => {
    const id = nonEmptyText(row?.id) ?? '';
    // The prototype's second line under each appointment ("chi"): who the
    // appointment is with — the team member's name from the roster, else a
    // short honest cue from the notes. Never invented when neither exists,
    // and never the member's technical id (production 10/11 read
    // «broker+…@accordo.invalid» and «google|…» here).
    const team = memberLabel(row?.teamMemberId, members);
    const cue = team ?? (nonEmptyText(row?.notes) ? briefSnippet(row.notes, 80) : null);
    // The prototype attenuates an appointment already behind us today.
    const start = toInstant(row.startsAt);
    return Object.freeze({
      id,
      time: romeTime(row.startsAt),
      title: subjectDisplayLabel(row, names),
      who: cue,
      status: row.status,
      past: now instanceof Date && start !== null && start.getTime() < now.getTime(),
      href: cardHrefForSubject(row) ?? (id !== '' ? recordDetailHref('appointment', id) : null),
    });
  });
}

/**
 * The next upcoming appointment today (booked/confirmed, startsAt >= now),
 * null when the day holds nothing else.
 * @param {Array<Record<string, any>>} [appointments]
 * @param {Date} [now]
 */
export function nextAppointment(appointments = [], now = new Date()) {
  const mark = now instanceof Date ? now.getTime() : NaN;
  const upcoming = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && isTodayInRome(row.startsAt, now)
      && toInstant(row.startsAt) !== null
      && (Number.isNaN(mark) || toInstant(row.startsAt).getTime() >= mark));
  upcoming.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * The appointment the «Prima della prossima call» card prepares
 * (backlog:5083e7a77c26): the next one today, else the soonest booked or
 * confirmed one still ahead — the prototype always shows the card, and a
 * day with no more calls must not hide tomorrow's. Null when nothing is
 * ahead at all.
 * @param {Array<Record<string, any>>} [appointments]
 * @param {Date} [now]
 */
export function upcomingAppointment(appointments = [], now = new Date()) {
  const today = nextAppointment(appointments, now);
  if (today !== null) return today;
  const mark = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(mark)) return null;
  const ahead = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && toInstant(row.startsAt) !== null
      && toInstant(row.startsAt).getTime() >= mark);
  ahead.sort((a, b) => toInstant(a.startsAt).getTime() - toInstant(b.startsAt).getTime());
  return ahead.length > 0 ? ahead[0] : null;
}

/**
 * When one appointment happens, in the words of the brief: «oggi alle
 * 10:00», «domani alle 10:00», «12 novembre alle 10:00» — the month in
 * full (backlog:7d30fb517785, production 10/11 read «12 nov»).
 * @param {unknown} startsAt
 * @param {Date} now
 */
function briefWhen(startsAt, now) {
  const time = romeTime(startsAt) ?? '—';
  if (isTodayInRome(startsAt, now)) return `oggi alle ${time}`;
  const tomorrow = romeDayKeyShift(now, 1);
  if (tomorrow !== null && romeDayKey(startsAt) === tomorrow) {
    return `domani alle ${time}`;
  }
  const day = romeLongDay(startsAt);
  return day !== null ? `${day} alle ${time}` : `alle ${time}`;
}

/**
 * Bound and clean a provider/customer string for a brief bullet: control
 * characters out, whitespace collapsed, capped — the brief quotes records,
 * it never pastes them whole.
 * @param {unknown} value
 * @param {number} [max]
 */
function briefSnippet(value, max = 140) {
  const str = value === null || value === undefined ? '' : String(value);
  const clean = str.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (clean === '') return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A source cited by the brief: a label and the route of the record behind
 * it. Every source opens something real.
 * @param {string} label
 * @param {unknown} href
 */
function briefSource(label, href) {
  if (typeof href !== 'string' || href === '') return null;
  return Object.freeze({ label, href });
}

/**
 * Pre-call brief for one appointment: what the appointment itself says plus
 * the latest messages and calls with the same subject. Sources are the
 * records behind every line, each clickable.
 * @param {{ appointment?: Record<string, any>, messages?: Array<Record<string, any>>, calls?: Array<Record<string, any>>, now?: Date, names?: Record<string, string|null> }} input
 */
export function buildPreCallBrief({ appointment = null, messages = [], calls = [], now = new Date(), names = {} } = {}) {
  if (appointment == null) return null;
  const id = nonEmptyText(appointment?.id) ?? '';
  const time = romeTime(appointment?.startsAt) ?? '—';
  const who = appointmentGuestName(appointment, names) ?? APPOINTMENT_GUEST_LABEL;
  const when = briefWhen(appointment?.startsAt, now);
  // Today's call keeps the short line; a later day names its day with the
  // right article: «di domani», «del 12 novembre», «dell'8 novembre»
  // (backlog:7d30fb517785, production 10/11 read «Appuntamento di 12 nov»).
  const day = romeDayPhrase(appointment?.startsAt, now, 'del');
  const opening = when.startsWith('oggi ')
    ? `Appuntamento delle ${time}`
    : day !== null ? `Appuntamento ${day} alle ${time}` : `Appuntamento delle ${time}`;
  const bullets = [];
  const notes = briefSnippet(appointment?.notes);
  bullets.push(notes !== ''
    ? `${opening} con ${who}: ${notes}`
    : `${opening} con ${who}.`);
  const sources = [];
  if (id !== '') {
    const source = briefSource(`Appuntamento delle ${time}`, recordDetailHref('appointment', id));
    if (source) sources.push(source);
  }
  const inbound = (Array.isArray(messages) ? messages : [])
    .filter((row) => row != null && nonEmptyText(row?.id) !== null)
    .sort((a, b) => (String(a.occurredAt ?? '') < String(b.occurredAt ?? '') ? 1 : String(a.occurredAt ?? '') > String(b.occurredAt ?? '') ? -1 : 0))
    .slice(0, 3);
  for (const message of inbound) {
    const body = briefSnippet(message?.body);
    // «Messaggio WhatsApp di ieri», «del 12 novembre»; without a stored
    // date «senza data», never «del data non registrata».
    const when = romeDayPhrase(message?.occurredAt, now, 'del') ?? 'senza data';
    const channel = messageChannelName(message?.channel);
    const head = `${channel} ${when}`;
    bullets.push(body !== ''
      ? `${head}: “${body}”`
      : `${head} (senza testo registrato).`);
    const source = briefSource(
      head,
      recordDetailHref('interaction-message', message.id),
    );
    if (source) sources.push(source);
  }
  const recent = (Array.isArray(calls) ? calls : [])
    .filter((row) => row != null && nonEmptyText(row?.id) !== null)
    .sort((a, b) => (String(a.occurredAt ?? '') < String(b.occurredAt ?? '') ? 1 : String(a.occurredAt ?? '') > String(b.occurredAt ?? '') ? -1 : 0))
    .slice(0, 2);
  for (const call of recent) {
    const when = romeDayPhrase(call?.occurredAt, now, 'del') ?? 'senza data';
    const outcome = briefSnippet(call?.outcome, 80);
    bullets.push(outcome !== ''
      ? `Chiamata ${when}: ${outcome}`
      : `Chiamata ${when} (esito non registrato).`);
    const source = briefSource(
      `Chiamata ${when}`,
      recordDetailHref('interaction-call', call.id),
    );
    if (source) sources.push(source);
  }
  if (inbound.length === 0 && recent.length === 0) {
    bullets.push('Nessun messaggio o chiamata registrati per questo contatto.');
  }
  const card = cardHrefForSubject(appointment);
  if (card) {
    const source = briefSource('Apri la scheda', card);
    if (source) sources.push(source);
  }
  return Object.freeze({
    title: who,
    when,
    bullets: Object.freeze(bullets),
    sources: Object.freeze(sources.slice(0, 6)),
    cardHref: card,
  });
}

/**
 * Channels the backoffice counts for the invite, per the prototype: 9.
 * The exact per-channel table lives in Stato sync; Oggi only needs the
 * headline count, so the total is a fixed constant, never metadata.
 */
/**
 * «Messaggio WhatsApp», «Email»: the brief names the channel as people
 * do (backlog:7d30fb517785), never the stored key («Messaggio whatsapp»).
 * @param {unknown} channel
 */
function messageChannelName(channel) {
  const key = String(channel ?? '').toLowerCase();
  if (key === 'email') return 'Email';
  const name = OGGI_CHANNEL_NAMES[key];
  return typeof name === 'string' ? `Messaggio ${name}` : 'Messaggio';
}

/** Italian channel names for the inbox rows. */
const OGGI_CHANNEL_NAMES = Object.freeze({ whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger', tiktok: 'TikTok', email: 'Email', phone: 'Telefono', voice: 'Telefono', sms: 'SMS', 'website-form': 'Form del sito', web: 'Form del sito', telegram: 'Telegram' });
export const INBOX_LIMIT = 6;

/**
 * How long a message has waited, in plain Italian.
 * @param {unknown} value
 * @param {Date} now
 */
export function waitedFor(value, now = new Date()) {
  const at = Date.parse(String(value ?? ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60000));
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return `da ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'da 1 ora' : `da ${hours} ore`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'da ieri' : `da ${days} giorni`;
}

/** `resource:id` of an inbox subject, the key profile names are read under; null without one. */
export function inboxSubjectKey(subject) {
  const resource = nonEmptyText(subject?.subjectResource);
  const id = nonEmptyText(subject?.subjectId);
  return resource && id ? `${resource}:${id}` : null;
}

/**
 * A stored subject label that names someone: the generic «Cliente»
 * placeholder does not, and a stored `Unknown` word is dropped
 * («PayPal Unknown» reads «PayPal», backlog:5083e7a77c26).
 */
function realLabel(value) {
  const text = readableName(nonEmptyText(value));
  return text && text.toLowerCase() !== 'cliente' ? text : null;
}

/**
 * The «Da rispondere» inbox (MVP Presti, Dan 04/11): the conversations whose
 * latest message is the customer's, newest first. One row per conversation,
 * never per message; a conversation the team answered last is not waiting.
 * The name is the customer's (production 07/11: every row read «Cliente»,
 * because the channel syncs store no subject label): the resolved profile
 * name, else the stored subject snapshot, else the sender handle the
 * message kept (e-mail, number, @handle) — never an id and never the
 * generic «Cliente».
 * @param {{ messages?: Array<any>, conversations?: Array<any>, now?: Date, limit?: number, names?: Record<string, string|null> }} input
 */
export function buildInbox({ messages = [], conversations = [], now = new Date(), limit = INBOX_LIMIT, names = {} } = {}) {
  const byId = new Map();
  for (const conversation of conversations) {
    if (nonEmptyText(conversation?.id)) byId.set(conversation.id, conversation);
  }
  const latest = new Map();
  for (const message of messages) {
    // A message without a conversation still belongs to someone: grouped by
    // subject and channel, so a channel that does not thread is not lost.
    const key = nonEmptyText(message?.conversationId)
      ?? (nonEmptyText(message?.subjectId) ? `${message.subjectResource ?? ''}:${message.subjectId}:${message.channel ?? ''}` : null);
    const at = Date.parse(String(message?.occurredAt ?? ''));
    if (!key || !Number.isFinite(at)) continue;
    const seen = latest.get(key);
    if (!seen || at > seen.at) latest.set(key, { at, message });
  }
  const waiting = [];
  for (const [conversationId, { at, message }] of latest) {
    if (message.direction !== 'inbound') continue;
    const conversation = byId.get(conversationId) ?? null;
    if (conversation?.status === 'closed') continue;
    const channel = String(message.channel ?? conversation?.channel ?? '').toLowerCase();
    const subject = {
      subjectOwner: message.subjectOwner ?? conversation?.subjectOwner,
      subjectResource: message.subjectResource ?? conversation?.subjectResource,
      subjectId: message.subjectId ?? conversation?.subjectId,
    };
    const subjectKey = inboxSubjectKey(subject);
    const name = (subjectKey ? nonEmptyText(names?.[subjectKey]) : null)
      ?? realLabel(conversation?.subjectLabel)
      ?? realLabel(message.subjectLabel)
      ?? nonEmptyText(message.remoteHandle)
      ?? nonEmptyText(conversation?.remoteHandle)
      ?? 'Contatto senza nome';
    waiting.push({
      id: conversationId,
      at,
      channel,
      subjectKey,
      mono: channelTile(channel) ?? badgeInitials(name),
      name,
      preview: briefSnippet(message.body, 110) || (message.attachmentKind ? 'Allegato' : 'Messaggio senza testo'),
      when: [waitedFor(message.occurredAt, now), OGGI_CHANNEL_NAMES[channel] ?? null].filter(Boolean).join(' · '),
      href: cardHrefForSubject(subject),
    });
  }
  waiting.sort((a, b) => b.at - a.at);
  return { total: waiting.length, rows: waiting.slice(0, Math.max(0, limit)) };
}

export const OGGI_TOTAL_CHANNELS = 9;

/**
 * The nine counted channel ids, in Stato sync order: re-exported from the
 * shared count (admin-channels-count.js), so Oggi and Stato sync count
 * from one list, never two kept in step by a test.
 */
export const OGGI_NINE_CHANNELS = NINE_CHANNEL_IDS;

/**
 * Google connectors of GET /api/profile mapped onto the nine counted
 * channels: Gmail carries the Email vote, Calendar its own. Reuses the
 * Profilo screen's connector ids (admin-profilo.js), never a new list.
 */
export const GOOGLE_CONNECTOR_TO_NINE = Object.freeze({
  gmail: 'email',
  calendar: 'calendar',
});

/**
 * Nine-channel ids contributed by a GET /api/profile answer. Only status
 * `connected` counts — revoked, error or missing read as not connected, and
 * an unreadable answer contributes nothing (fail-soft, like the Calendario
 * week panel). Own keys only: a prototype name reads as unknown.
 * @param {unknown} profile the /api/profile payload, null when unreadable
 */
export function googleNineChannels(profile) {
  const connections = profile !== null && typeof profile === 'object'
    ? /** @type {any} */ (profile).connections
    : null;
  const rawItems = connections !== null && typeof connections === 'object'
    && /** @type {any} */ (connections).available === true
    && Array.isArray(/** @type {any} */ (connections).items)
    ? /** @type {any} */ (connections).items
    : null;
  if (!Array.isArray(rawItems)) return [];
  const items = rawItems;
  const votes = [];
  for (const item of items) {
    if (item == null || item.status !== 'connected') continue;
    if (typeof item.connector !== 'string' || item.connector === '') continue;
    if (!Object.hasOwn(GOOGLE_CONNECTOR_TO_NINE, item.connector)) continue;
    const channel = GOOGLE_CONNECTOR_TO_NINE[item.connector];
    if (!votes.includes(channel)) votes.push(channel);
  }
  return Object.freeze(votes);
}

/**
 * Distinct connected channels among the nine: active rows only, one vote
 * per channel, capped at the nine. A channel outside the nine never moves
 * this count. The profile links from GET /api/profile vote too (Gmail for
 * Email, Calendar for Calendar, the Meta links for their channels): without
 * them Oggi reads «0 di 9 collegati» while Gmail and Calendar are connected.
 * The screen strip prints the shared `channelConnectionCount` instead, which
 * also counts a linked channel outside the nine.
 * @param {Array<Record<string, any>>} [connections]
 * @param {unknown} [profile] the /api/profile payload, null when unreadable
 */
export function countConnectedNine(connections = [], profile = null) {
  const { connectedChannels } = channelConnectionCount(mergeProfileConnections(connections, profile));
  return connectedChannels.filter((channel) => OGGI_NINE_CHANNELS.includes(channel)).length;
}

/**
 * Lead channels with no active connection, in catalog order with catalog
 * labels. `calendar` and `stripe` are not lead channels and stay out of the
 * invite: connecting them loses no lead. A connected Gmail removes Email
 * from the invite, like an active Email row does.
 * @param {Array<Record<string, any>>} [connections]
 * @param {unknown} [profile] the /api/profile payload, null when unreadable
 */
export function missingLeadChannels(connections = [], profile = null) {
  const active = new Set(
    (Array.isArray(connections) ? connections : [])
      .filter((row) => row != null && row.status === 'active' && typeof row.channel === 'string')
      .map((row) => row.channel),
  );
  for (const channel of googleNineChannels(profile)) active.add(channel);
  return CONNECTOR_CATALOG
    .filter((entry) => entry != null && !active.has(entry.channel))
    .map((entry) => Object.freeze({ channel: entry.channel, label: entry.label }));
}

/**
 * The Oggi channel strip (9c7d1477a8d4): «x di 9» over the spec's nine, the
 * connectable lead channels missing (the names after «Collega»), and an
 * aside for the missing channels that are not leads to connect here —
 * Google Calendar «dal Profilo» when the profile offers it, else «non
 * ancora disponibile» like Stripe — so connected + named = 9.
 * @param {{ connections?: Array<any>, profile?: unknown }} input
 * @returns {{ connected: number, total: number, leads: Array<string>, aside: string | null }}
 */
export function buildChannelInvite({ connections = [], profile = null } = {}) {
  const count = channelConnectionCount(mergeProfileConnections(connections, profile));
  const guided = CONNECTOR_CATALOG.map((entry) => entry.channel);
  const leads = [];
  const fromProfile = [];
  const unavailable = [];
  for (const entry of count.missing) {
    if (guided.includes(entry.channel)) {
      leads.push(entry.label);
      continue;
    }
    // Outside the guided flow only Google Calendar has a destination
    // (CHANNEL_CONNECT_ROUTES: Profilo, when the profile offers Google).
    if (channelConnectRoute(entry.channel, { guided, profile }) !== null) {
      fromProfile.push(`${entry.label} dal Profilo`);
    } else {
      unavailable.push(entry.label);
    }
  }
  const notes = [...fromProfile];
  if (unavailable.length === 1) notes.push(`${unavailable[0]} non ancora disponibile`);
  if (unavailable.length > 1) {
    notes.push(`${unavailable.slice(0, -1).join(', ')} e ${unavailable[unavailable.length - 1]} non ancora disponibili`);
  }
  // Oggi stays on the spec's nine (review #692): a linked channel outside
  // the nine (SMS, Telegram) never turns the strip into «1 di 10» — that
  // extra row lives on Stato sync only.
  return {
    connected: count.connectedChannels.filter((channel) => OGGI_NINE_CHANNELS.includes(channel)).length,
    total: OGGI_TOTAL_CHANNELS,
    leads,
    aside: notes.length > 0 ? notes.join('; ') : null,
  };
}

// ---------------------------------------------------------------------------
// Data load. One bounded page per module, narrowed on the server where the
// generic surface allows it (ADR-008 addendum 2); the day filter stays
// client-side on Rome time. A missing package is not an error: its section
// renders the honest "not composed" line instead of a blank screen.
// ---------------------------------------------------------------------------

/**
 * A failed section read must stay diagnosable: the section degrades to its
 * honest line, and the cause (name only, never record bodies) goes to the
 * console — same rule as the shell badge read in admin-shell.js.
 * @param {string} scope
 * @param {unknown} error
 */
function noteReadFailure(scope, error) {
  try {
    console.warn(`bo-oggi ${scope} unreadable:`, error instanceof Error ? error.name : 'unknown');
  } catch {
    // Logging must never break the load.
  }
}

/**
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} module
 * @param {Record<string, string>} [filters]
 */
async function readModulePage(client, module, filters = {}) {
  const query = new URLSearchParams({ limit: String(OGGI_READ_LIMIT) });
  for (const [field, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) query.set(`filter.${field}`, String(value));
  }
  const answer = await client.request(`/api/modules/${module}/records?${query.toString()}`);
  if (!Array.isArray(answer?.items)) return [];
  return answer.items;
}

/**
 * The customer name of every shown «Da rispondere» row (production 07/11:
 * the channel syncs store no subject label, so every row read «Cliente»).
 * One read-only profile per shown subject — at most the inbox limit —
 * settled together; a refused or unknown profile leaves the row on its
 * stored label or sender handle, never an error on Oggi.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Array<any>} messages @param {Array<any>} conversations @param {Date} now
 * @returns {Promise<Record<string, string>>}
 */
export async function readInboxNames(client, messages, conversations, now) {
  const { rows } = buildInbox({ messages, conversations, now });
  const keys = [...new Set(rows.map((row) => row.subjectKey).filter((key) => typeof key === 'string'))];
  /** @type {Record<string, string>} */
  const names = {};
  const settled = await Promise.allSettled(keys.map(async (key) => {
    const cut = key.indexOf(':');
    const resource = key.slice(0, cut);
    const id = key.slice(cut + 1);
    const profile = await client.request(`/api/customer-data/profile/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`);
    return { key, name: nameFromProfile(profile) };
  }));
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value.name) names[result.value.key] = result.value.name;
  }
  return names;
}

/** Profile reads for appointment names, at most: the agenda never has more on one screen. */
export const APPOINTMENT_NAME_LIMIT = 10;

/**
 * Customer names for the agenda of today and the next call
 * (backlog:5083e7a77c26): appointments synced from a calendar carry no
 * subject label, so the brief and the agenda read «il cliente». One
 * read-only profile per subject (the same read the inbox uses), the next
 * call first, bounded, settled together; a refused or unknown profile
 * leaves the row on its stored label, never an error on Oggi.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Array<any>} appointments @param {any} next @param {Date} now
 * @returns {Promise<Record<string, string>>}
 */
export async function readAppointmentNames(client, appointments, next, now) {
  const rows = [next, ...buildTodayAgendaRows(appointments, now)].filter((row) => row != null);
  const keys = [...new Set(rows.map((row) => inboxSubjectKey(row)).filter((key) => typeof key === 'string'))]
    .slice(0, APPOINTMENT_NAME_LIMIT);
  /** @type {Record<string, string>} */
  const names = {};
  const settled = await Promise.allSettled(keys.map(async (key) => {
    const cut = key.indexOf(':');
    const profile = await client.request(`/api/customer-data/profile/${encodeURIComponent(key.slice(0, cut))}/${encodeURIComponent(key.slice(cut + 1))}`);
    return { key, name: nameFromProfile(profile) };
  }));
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value.name) names[result.value.key] = result.value.name;
  }
  return names;
}

/**
 * Load everything Oggi renders. Never throws for a missing package: each
 * section carries its own availability.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Date} [now]
 */
export async function loadOggiData(client, now = new Date(), { onEssentials = null } = {}) {
  const outcome = {
    workAvailable: false,
    appointmentsAvailable: false,
    channelsAvailable: false,
    interactionsAvailable: false,
    tasks: [],
    appointments: [],
    connections: [],
    profile: null,
    briefMessages: [],
    briefCalls: [],
    inboxComposed: false,
    inboxAvailable: false,
    inboxMessages: [],
    inboxConversations: [],
    /** Customer names of the shown inbox rows, by `resource:id` (profile reads). */
    inboxNames: {},
    /** Customer names of the agenda and next-call subjects, by `resource:id`. */
    appointmentNames: {},
    /** Organization team (`GET /api/spine/memberships` items): names the agenda's «chi» line. */
    members: [],
    next: null,
  };
  // Backlog 2a075e2d9250 (production fc3fa62: the day at 8–20 s cold,
  // every read once but one after the other): the independent reads start
  // together, each fail-soft as before. The profile needs no schema, so it
  // starts beside it.
  const profileRead = client.request('/api/profile').then(
    (answer) => (answer && typeof answer === 'object' ? answer : null),
    (error) => { noteReadFailure('profile', error); return null; },
  );
  let domains = {};
  try {
    const schema = await client.request('/api/schema');
    domains = schema?.domains ?? {};
  } catch (error) {
    noteReadFailure('schema', error);
    // The profile read started already: nothing waits on it.
    return outcome;
  }
  /** One fail-soft module read: the rows, or null after naming the failure. */
  const page = (scope, module, filters) => readModulePage(client, module, filters).then(
    (rows) => rows,
    (error) => { noteReadFailure(scope, error); return null; },
  );
  const skip = Promise.resolve(undefined);
  const interactions = domains.interactions != null;
  const [tasks, appointments, connections, profile, messages, conversations] = await Promise.all([
    domains.work != null ? page('work-task', 'work-task', { status: 'open' }) : skip,
    domains.appointments != null ? page('appointment', 'appointment') : skip,
    domains.channels != null ? page('channel-connection', 'channel-connection') : skip,
    profileRead,
    // The «Da rispondere» inbox: the latest messages and their conversations.
    // Messages are the inbox; conversations only lend the name and the closed
    // state, so a space without the conversation module still lists who is
    // waiting. A failed read keeps the section honest (unavailable).
    interactions ? page('inbox', 'interaction-message') : skip,
    interactions ? readModulePage(client, 'conversation').catch(() => null) : skip,
  ]);
  if (Array.isArray(tasks)) {
    outcome.tasks = tasks;
    outcome.workAvailable = true;
  }
  if (Array.isArray(appointments)) {
    outcome.appointments = appointments;
    outcome.appointmentsAvailable = true;
  }
  if (Array.isArray(connections)) {
    outcome.connections = connections;
    outcome.channelsAvailable = true;
  }
  // Google Calendar and Gmail connect per person through the pilot's Google
  // consent, not through channel-connection rows: the same GET /api/profile
  // answer the Profilo screen reads. Unreadable stays null and contributes
  // no vote — an unknown state never poses as connected or missing.
  outcome.profile = profile ?? null;
  if (interactions) {
    outcome.inboxComposed = true;
    if (Array.isArray(messages)) {
      outcome.inboxMessages = messages;
      outcome.inboxAvailable = true;
    }
    if (Array.isArray(conversations)) outcome.inboxConversations = conversations;
  }
  outcome.next = upcomingAppointment(outcome.appointments, now);
  // The essentials are in (agenda, Da rispondere, advisor, channels): the
  // day can paint now; the names and the call recap fill in after.
  if (typeof onEssentials === 'function') {
    try {
      onEssentials({ ...outcome, pending: true });
    } catch (error) {
      noteReadFailure('paint', error);
    }
  }
  const subject = outcome.next != null && interactions
    ? { subjectResource: outcome.next.subjectResource, subjectId: outcome.next.subjectId }
    : null;
  const withMember = outcome.appointments.some((row) => nonEmptyText(row?.teamMemberId) !== null);
  const [inboxNames, appointmentNames, members] = await Promise.all([
    outcome.inboxAvailable
      ? readInboxNames(client, outcome.inboxMessages, outcome.inboxConversations, now)
      : Promise.resolve({}),
    readAppointmentNames(client, outcome.appointments, outcome.next, now),
    // The roster names the member holding each slot: read only when a slot
    // names one, fail-soft (the line then falls back to the notes cue).
    withMember
      ? client.request('/api/spine/memberships').then(
        (answer) => (Array.isArray(answer?.items) ? answer.items : []),
        (error) => { noteReadFailure('memberships', error); return []; },
      )
      : Promise.resolve([]),
    (async () => {
      if (subject === null || !nonEmptyText(subject.subjectResource) || !nonEmptyText(subject.subjectId)) return;
      try {
        const [briefMessages, calls] = await Promise.all([
          readModulePage(client, 'interaction-message', subject),
          readModulePage(client, 'interaction-call', subject),
        ]);
        outcome.briefMessages = briefMessages;
        outcome.briefCalls = calls;
        outcome.interactionsAvailable = true;
      } catch (error) {
        noteReadFailure('interactions', error);
        outcome.briefMessages = [];
        outcome.briefCalls = [];
      }
    })(),
  ]);
  outcome.inboxNames = inboxNames;
  outcome.appointmentNames = appointmentNames;
  outcome.members = members;
  return outcome;
}

// ---------------------------------------------------------------------------
// Renderer: the greeting frame plus, once loaded, the recap, the advisor,
// the agenda, the brief and the channel invite. Sections with no data render
// their honest line, never a blank hole and never invented content.
// ---------------------------------------------------------------------------

/**
 * @param {object} doc DOM document (real or fake).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
import { el, uiButton, uiEmpty, uiLoading } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * One advisor row: record tag, title, motive, the Domani and CTA buttons
 * while open, the decided state after. A durable "Domani" (a follow-up,
 * whose `run` commits through the work-task action) attenuates with no
 * session undo; session-only decisions keep "Annulla".
 * @param {object} doc
 * @param {{ id?: unknown, kind?: unknown, mono?: unknown, title?: unknown, why?: unknown, cta?: unknown, href?: unknown, run?: unknown }} action
 * @param {'open' | 'done' | 'postponed'} state
 * @param {{ onExecute?: (action: any) => void, onPostpone?: (id: string) => void, onUndo?: (id: string) => void, navigate?: (hash: string) => void }} [events]
 * @param {boolean} [disabled]
 */
function renderAdvisorRow(doc, action, state, events = {}, disabled = false) {
  const row = el(doc, 'div', 'bo-oggi-row');
  row.setAttribute('data-action', String(action?.id ?? ''));
  if (state !== 'open') row.setAttribute('data-state', state);
  row.appendChild(el(doc, 'span', `bo-oggi-mono${action?.channel ? ` bo-tile-${String(action.channel).toLowerCase()}` : ''}`, String(action?.mono ?? '')));
  const body = el(doc, 'div', 'bo-oggi-body');
  // The prototype's title opens the record the suggestion is about, through
  // the shell router like every other in-app anchor.
  const href = typeof action?.href === 'string' && action.href !== '' ? action.href : null;
  const title = el(doc, href ? 'a' : 'p', 'bo-oggi-title', String(action?.title ?? ''));
  if (href) {
    title.setAttribute('href', href);
    if (typeof events?.navigate === 'function') {
      title.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        events.navigate(href);
      });
    }
  }
  body.appendChild(title);
  body.appendChild(el(doc, 'p', 'bo-oggi-why', String(action?.why ?? '')));
  // The prototype's violet third line: the AI's prepared next step, only
  // when the action carries one — never an invented suggestion. The note
  // renders verbatim: prototype notes already carry their own ✦ when they
  // are AI suggestions, and prefixing one here would double it.
  if (typeof action?.note === 'string' && action.note !== '') body.appendChild(el(doc, 'p', 'bo-oggi-note', action.note));
  row.appendChild(body);
  if (state === 'open') {
    const controls = el(doc, 'div', 'bo-oggi-btns');
    const postpone = el(doc, 'button', 'small ghost', 'Domani');
    postpone.setAttribute('data-triage', 'postpone');
    postpone.disabled = disabled;
    postpone.addEventListener('click', () => events.onPostpone?.(action.id));
    const execute = el(doc, 'button', 'small primary', String(action?.cta ?? 'Apri'));
    execute.setAttribute('data-triage', 'execute');
    execute.disabled = disabled;
    execute.addEventListener('click', () => events.onExecute?.(action));
    controls.appendChild(postpone);
    controls.appendChild(execute);
    row.appendChild(controls);
  } else if (action?.run === 'complete-task') {
    // Durable decision: the work-task postpone action already moved the due
    // date, or complete already closed the task, with timeline evidence. No
    // session "Annulla" here — it would imply the decision was reversed
    // while the stored record says otherwise (the work package has no
    // reopen).
    const done = el(doc, 'div', 'bo-oggi-btns');
    done.appendChild(el(doc, 'span', 'bo-oggi-state', state === 'done' ? '✓ Fatto' : 'Rimandato a domani'));
    row.appendChild(done);
  } else {
    const done = el(doc, 'div', 'bo-oggi-btns');
    done.appendChild(el(
      doc, 'span', 'bo-oggi-state',
      state === 'done' ? '✓ Fatto' : 'Rimandato a domani',
    ));
    const undo = el(doc, 'button', 'small secondary', 'Annulla');
    undo.setAttribute('data-triage', 'undo');
    undo.disabled = disabled;
    undo.addEventListener('click', () => events.onUndo?.(action.id));
    done.appendChild(undo);
    row.appendChild(done);
  }
  return row;
}

/**
 * Render the Oggi home into the given mount. Without `home` this is the
 * greeting frame over the delivered-screen links (pre-BO-F3-04 behavior);
 * with `loading` the frame shows the loading state instead of the links,
 * while the home's reads are pending; with `home` it is the full screen.
 *
 * @param {{
 *   doc: object,
 *   mount: object,
 *   spaceName?: unknown,
 *   userName?: unknown,
 *   links?: Array<{ id: unknown, label: string, route: string }>,
 *   navigate?: (hash: string) => void,
 *   now?: Date,
 *   loading?: boolean,
 *   stalled?: { onRetry?: () => void } | null,
 *   home?: {
 *     recap?: string,
 *     actions?: Array<any>,
 *     triage?: Record<string, string>,
 *     capped?: boolean,
 *     agenda?: Array<{ id: unknown, time: unknown, title: unknown, who?: unknown, href: unknown }>,
 *     brief?: { title: unknown, when: unknown, bullets: Array<string>, sources: Array<{ label: string, href: string }> } | null,
 *     missing?: Array<{ channel: unknown, label: unknown }>,
 *     connections?: Array<{ channel?: unknown, status?: unknown }>,
 *     profile?: unknown,
 *     availability?: { work?: boolean, appointments?: boolean, channels?: boolean },
 *     error?: string,
 *     events?: { onExecute?: (action: any) => void, onPostpone?: (id: string) => void, onUndo?: (id: string) => void, navigate?: (hash: string) => void },
 *     disabled?: boolean,
 *   },
 * }} options
 */
export function renderOggi({
  doc,
  mount,
  spaceName = '',
  userName = '',
  links = [],
  navigate = () => {},
  now = new Date(),
  loading = false,
  stalled = null,
  home = null,
} = {}) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  // The prototype's Oggi is one centred 900 px column (data-screen-label "00 Oggi").
  const page = el(doc, 'div', 'bo-oggi');
  mount.appendChild(page);
  const person = nonEmptyText(userName) ?? (typeof spaceName === 'string' && spaceName !== '' ? spaceName : 'il tuo spazio');
  const hour = now instanceof Date ? now.getHours() : NaN;

  page.appendChild(el(doc, 'p', 'bo-kicker', oggiDateLine(now)));
  // The prototype's only h1: same bo-oggi-hello token, so the supervisor's
  // scale is untouched — only the semantics change (C6).
  page.appendChild(el(doc, 'h1', 'bo-oggi-hello', `${greetingForHour(hour)}, ${person}`));

  if (home == null && stalled) {
    // Backlog 2a075e2d9250: the reads passed their ceiling — an honest note
    // with Riprova, never «Carico…» forever.
    const note = uiEmpty(doc, {
      title: 'La tua giornata ci mette più del solito.',
      text: 'Il server risponde piano: riprova tra poco.',
    });
    note.setAttribute('role', 'alert');
    const retry = uiButton(doc, { label: 'Riprova', attrs: { type: 'button', 'data-action': 'oggi-retry' } });
    retry.addEventListener('click', () => { if (typeof stalled.onRetry === 'function') stalled.onRetry(); });
    note.appendChild(retry);
    page.appendChild(note);
    return;
  }

  if (home == null && loading === true) {
    // Reads pending (production 07/11): a neutral loading line under the
    // greeting, never the shortcut list that looked like the real home.
    page.appendChild(uiLoading(doc, { label: 'la tua giornata' }));
    return;
  }

  if (home == null) {
    page.appendChild(el(
      doc,
      'p',
      'bo-muted',
      'Le schermate pronte del tuo spazio, in un posto solo.',
    ));
    appendLinkList(doc, page, links, navigate);
    return;
  }

  const events = home.events ?? {};
  const disabled = home.disabled === true;
  const triage = home.triage ?? {};
  const actions = Array.isArray(home.actions) ? home.actions : [];

  if (typeof home.recap === 'string' && home.recap !== '') {
    page.appendChild(el(doc, 'p', 'bo-oggi-recap', home.recap));
  }

  // ---- Advisor ----
  const advisor = el(doc, 'section', 'bo-oggi-section');
  const head = el(doc, 'div', 'bo-oggi-head');
  head.appendChild(el(doc, 'h3', undefined, '✦ Il tuo advisor'));
  const progress = advisorProgress(actions, triage);
  if (progress.total > 0) {
    const bar = el(doc, 'div', 'bo-oggi-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(progress.total));
    bar.setAttribute('aria-valuenow', String(progress.handled));
    const fill = el(doc, 'div', 'bo-oggi-fill');
    const ratio = progress.handled / progress.total;
    fill.setAttribute('style', `width: ${Math.round(ratio * 100)}%`);
    bar.appendChild(fill);
    head.appendChild(bar);
  }
  head.appendChild(el(doc, 'p', 'bo-oggi-progress', `${progress.handled} di ${progress.total} ${progress.total === 1 ? 'fatta' : 'fatte'}`));
  advisor.appendChild(head);
  // The prototype's done line shows once no card is open (allDone): the
  // decided cards stay listed above it, attenuated (C14).
  const allDone = actions.every((action) => triageState(triage, action?.id) !== 'open');
  if (actions.length > 0) {
    const list = el(doc, 'div', 'bo-oggi-actions');
    for (const action of actions) {
      list.appendChild(renderAdvisorRow(doc, action, triageState(triage, action?.id), { ...events, navigate }, disabled));
    }
    advisor.appendChild(list);
    if (home.capped === true) {
      advisor.appendChild(el(doc, 'p', 'bo-muted', `Mostro le prime ${actions.length} azioni.`));
    }
  }
  if (allDone) {
    advisor.appendChild(el(doc, 'p', 'bo-oggi-empty', '✓ Hai finito per oggi. Ti scrivo io se arriva qualcosa di urgente.'));
  }
  if (home.availability?.work === false) {
    advisor.appendChild(el(doc, 'p', 'bo-muted', 'I follow-up non sono attivi in questo spazio: niente azioni da proporre.'));
  }
  page.appendChild(advisor);

  // ---- Da rispondere: the conversations waiting for the team ----
  if (home.inbox != null) {
    const inbox = el(doc, 'section', 'bo-oggi-section bo-oggi-inbox');
    inbox.setAttribute('data-oggi-section', 'inbox');
    const inboxHead = el(doc, 'div', 'bo-oggi-head');
    inboxHead.appendChild(el(doc, 'h3', undefined, 'Da rispondere'));
    const waitingCount = Number(home.inbox.total ?? 0);
    inboxHead.appendChild(el(doc, 'p', 'bo-oggi-progress', waitingCount === 1 ? '1 in attesa' : `${waitingCount} in attesa`));
    inbox.appendChild(inboxHead);
    const inboxRows = Array.isArray(home.inbox.rows) ? home.inbox.rows : [];
    if (home.inbox.available === false) {
      inbox.appendChild(el(doc, 'p', 'bo-muted', 'I messaggi non si sono potuti leggere. Riprova più tardi.'));
    } else if (inboxRows.length === 0) {
      inbox.appendChild(el(doc, 'p', 'bo-muted', 'Nessun messaggio aspetta una risposta.'));
    } else {
      const list = el(doc, 'div', 'bo-oggi-actions');
      for (const entry of inboxRows) {
        const row = el(doc, 'div', 'bo-oggi-row bo-oggi-inbox-row');
        row.setAttribute('data-conversation', String(entry.id ?? ''));
        row.appendChild(el(doc, 'span', `bo-oggi-mono${entry.channel ? ` bo-tile-${entry.channel}` : ''}`, String(entry.mono ?? '')));
        const body = el(doc, 'div', 'bo-oggi-body');
        const href = typeof entry.href === 'string' && entry.href !== '' ? entry.href : null;
        const title = el(doc, href ? 'a' : 'p', 'bo-oggi-title', String(entry.name ?? ''));
        if (href) {
          title.setAttribute('href', href);
          title.addEventListener('click', (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            navigate(href);
          });
        }
        body.appendChild(title);
        body.appendChild(el(doc, 'p', 'bo-oggi-why', String(entry.preview ?? '')));
        if (entry.when) body.appendChild(el(doc, 'p', 'bo-oggi-note', String(entry.when)));
        row.appendChild(body);
        if (href) {
          const controls = el(doc, 'div', 'bo-oggi-btns');
          const reply = el(doc, 'button', 'small primary', 'Rispondi');
          reply.setAttribute('data-action', 'inbox-reply');
          reply.addEventListener('click', () => navigate(href));
          controls.appendChild(reply);
          row.appendChild(controls);
        }
        list.appendChild(row);
      }
      inbox.appendChild(list);
      if (waitingCount > inboxRows.length) {
        inbox.appendChild(el(doc, 'p', 'bo-muted', `Mostro le ${inboxRows.length} conversazioni più recenti su ${waitingCount}.`));
      }
    }
    page.appendChild(inbox);
  }

  // ---- Agenda and pre-call brief: two cards side by side ----
  const pair = el(doc, 'div', 'bo-oggi-pair');
  page.appendChild(pair);
  const agenda = el(doc, 'section', 'bo-oggi-card');
  agenda.setAttribute('data-oggi-section', 'agenda');
  agenda.appendChild(el(doc, 'h3', undefined, 'Agenda di oggi'));
  const rows = Array.isArray(home.agenda) ? home.agenda : [];
  if (home.availability?.appointments === false) {
    agenda.appendChild(el(doc, 'p', 'bo-muted', 'Il calendario non è attivo in questo spazio.'));
  } else if (rows.length === 0) {
    agenda.appendChild(el(doc, 'p', 'bo-muted', 'Niente appuntamenti oggi.'));
  } else {
    const list = el(doc, 'div', 'bo-oggi-agenda');
    for (const entry of rows) {
      const item = el(doc, 'div', 'bo-oggi-agenda-row');
      if (entry?.past === true) item.setAttribute('data-state', 'past');
      item.appendChild(el(doc, 'span', 'bo-oggi-time', String(entry?.time ?? '')));
      const cell = el(doc, 'div');
      if (typeof entry?.href === 'string' && entry.href !== '') {
        // The prototype's agenda title is dark ink, not a green underlined
        // link: the same `bo-oggi-title` hook the advisor titles use (ink,
        // underline on hover only). Navigation stays — a click still opens
        // the scheda — only the paint follows the prototype. No new class.
        const anchor = el(doc, 'a', 'bo-oggi-title', String(entry?.title ?? ''));
        anchor.setAttribute('href', entry.href);
        anchor.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          navigate(entry.href);
        });
        cell.appendChild(anchor);
      } else {
        cell.appendChild(el(doc, 'span', undefined, String(entry?.title ?? '')));
      }
      // The prototype's "chi" line under every appointment: who holds the
      // slot or what the appointment is about. A shared muted token (no new
      // stylesheet); the supervisor dresses the exact spacing.
      if (typeof entry?.who === 'string' && entry.who !== '') {
        cell.appendChild(el(doc, 'div', 'bo-muted', entry.who));
      }
      item.appendChild(cell);
      list.appendChild(item);
    }
    agenda.appendChild(list);
  }
  if (home.availability?.appointments !== false) {
    const toCalendar = el(doc, 'a', 'bo-oggi-more', 'Apri il calendario →');
    toCalendar.setAttribute('href', '#/calendario');
    toCalendar.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate('#/calendario');
    });
    agenda.appendChild(toCalendar);
  }
  pair.appendChild(agenda);

  // ---- Pre-call brief ----
  // The prototype's grid always pairs the agenda with this card
  // (backlog:5083e7a77c26): with no call ahead it stays, with an honest
  // line instead of disappearing from the screen.
  const brief = el(doc, 'section', 'bo-oggi-card bo-oggi-ai');
  brief.setAttribute('data-oggi-section', 'brief');
  brief.appendChild(el(doc, 'h3', undefined, '✦ Prima della prossima call'));
  if (home.briefPending === true && home.brief != null) {
    // Backlog 2a075e2d9250: the day paints before the call's messages are
    // read; the card says it is still reading instead of an empty recap.
    brief.appendChild(el(doc, 'p', 'bo-oggi-brief-who', `${String(home.brief.title ?? '')} · ${String(home.brief.when ?? '')}`));
    brief.appendChild(uiLoading(doc, { label: 'messaggi e chiamate da ripassare' }));
  } else if (home.availability?.appointments === false) {
    brief.appendChild(el(doc, 'p', 'bo-muted', 'Il calendario non è attivo in questo spazio: qui comparirà il ripasso prima di ogni call.'));
  } else if (home.brief == null) {
    brief.appendChild(el(doc, 'p', 'bo-muted', 'Nessuna call in programma. Quando ne fissi una, qui trovi messaggi e chiamate da ripassare prima.'));
  } else {
    brief.appendChild(el(
      doc, 'p', 'bo-oggi-brief-who',
      `${String(home.brief.title ?? '')} · ${String(home.brief.when ?? '')}`,
    ));
    const bullets = el(doc, 'ul', 'bo-oggi-brief');
    for (const bullet of home.brief.bullets ?? []) {
      bullets.appendChild(el(doc, 'li', undefined, String(bullet)));
    }
    brief.appendChild(bullets);
    if (Array.isArray(home.brief.sources) && home.brief.sources.length > 0) {
      const sources = el(doc, 'p', 'bo-oggi-sources');
      sources.appendChild(el(doc, 'span', undefined, 'Fonti: '));
      const cardSource = home.brief.sources.find((source) => source?.label === 'Apri la scheda') ?? null;
      home.brief.sources.filter((source) => source !== cardSource).forEach((source, index) => {
        if (index > 0) sources.appendChild(el(doc, 'span', undefined, ' · '));
        const anchor = el(doc, 'a', 'bo-setting-link', String(source?.label ?? ''));
        anchor.setAttribute('href', String(source?.href ?? ''));
        anchor.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          navigate(String(source?.href ?? ''));
        });
        sources.appendChild(anchor);
      });
      brief.appendChild(sources);
      if (cardSource) {
        // The prototype's violet CTA under the sources: a real button that
        // navigates to the customer scheda, like the prototype. The explicit
        // `ui-btn` base (no `ui-btn-*` variant) keeps the `ui-*` contract
        // the raw-control test enforces without letting the later
        // `.ui-btn-secondary` rule override the violet `.bo-oggi-cta`
        // background in styles.css (which this screen must not touch).
        const open = el(doc, 'button', 'bo-oggi-cta ui-btn', 'Apri la scheda');
        open.setAttribute('type', 'button');
        open.addEventListener('click', () => {
          navigate(String(cardSource.href ?? ''));
        });
        brief.appendChild(open);
      }
    }
  }
  pair.appendChild(brief);

  // ---- Missing channels ----
  const missing = Array.isArray(home.missing) ? home.missing : [];
  if (home.availability?.channels === false) {
    const note = el(doc, 'section', 'bo-oggi-section');
    note.appendChild(el(doc, 'p', 'bo-muted', 'I canali non sono attivi in questo spazio.'));
    page.appendChild(note);
  } else {
    // The prototype strip (9c7d1477a8d4, production 08/11 after #687):
    // «x di 9 collegati», always the line «per non perdere nessun lead», and
    // the names are the connectable lead channels missing. The missing
    // channels that are not leads to connect here (Google Calendar, Stripe)
    // are named apart, so what the text promises adds up with the count.
    const invite = Array.isArray(home.connections)
      ? buildChannelInvite({ connections: home.connections, profile: home.profile ?? null })
      : {
        connected: OGGI_TOTAL_CHANNELS - Math.min(missing.length, OGGI_TOTAL_CHANNELS),
        total: OGGI_TOTAL_CHANNELS,
        leads: missing.map((entry) => String(entry?.label ?? '')).filter((label) => label !== ''),
        aside: null,
      };
    if (invite.leads.length > 0) {
      const section = el(doc, 'section', 'bo-oggi-section');
      // The strip lands on #/connettori, whose head is the Collegamenti
      // Google card with the Collega links.
      const anchor = el(doc, 'a', 'bo-oggi-invite', '');
      anchor.appendChild(el(doc, 'strong', undefined, `${invite.connected} di ${invite.total} collegati`));
      const aside = invite.aside !== null ? ` (${invite.aside})` : '';
      anchor.appendChild(el(doc, 'span', undefined, ` Collega ${invite.leads.join(', ')} per non perdere nessun lead${aside} →`));
      anchor.setAttribute('href', '#/connettori');
      anchor.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/connettori');
      });
      section.appendChild(anchor);
      page.appendChild(section);
    }
  }

  if (typeof home.error === 'string' && home.error !== '') {
    page.appendChild(el(doc, 'p', 'field-error', home.error));
  }

}

/**
 * Same rows as the Impostazioni screen: no new stylesheet needed for the
 * delivered-screen links, and the home automatically matches the backoffice
 * look.
 */
function appendLinkList(doc, mount, links, navigate) {
  const list = el(doc, 'div', 'bo-settings');
  for (const link of links) {
    if (link == null || typeof link.label !== 'string' || typeof link.route !== 'string') continue;
    const row = el(doc, 'div', 'bo-setting-row');
    row.appendChild(el(doc, 'span', 'bo-setting-label', link.label));
    const anchor = el(doc, 'a', 'bo-setting-link', 'Apri');
    anchor.setAttribute('href', link.route);
    anchor.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate(link.route);
    });
    row.appendChild(anchor);
    list.appendChild(row);
  }
  if (list.childNodes.length === 0) {
    list.appendChild(el(
      doc,
      'p',
      'bo-muted',
      'Nessuna schermata pronta oltre a questa: le voci in arrivo sono nella barra laterale.',
    ));
  }
  mount.appendChild(list);
}

// ---------------------------------------------------------------------------
// View: loads the records, paints the home, and wires triage plus the one
// executing CTA. A stale async response is discarded, controls disable while
// a request is in flight, and a failed execute keeps the row open with the
// refusal on screen.
// ---------------------------------------------------------------------------

/**
 * @param {{ doc: any, mount: any, client: { request: Function }, navigate?: (hash: string) => void, submissions?: any, storage?: any }} deps
 */
/** Backlog 2a075e2d9250: how long Oggi shows «Carico…» before the Riprova note. */
export const OGGI_LOAD_CEILING_MS = 10_000;

export function createOggiView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const ceilingMs = Number.isFinite(deps.loadCeilingMs) ? deps.loadCeilingMs : OGGI_LOAD_CEILING_MS;
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : (id) => clearTimeout(id);
  const { client: bound } = bindAdminMutations(deps.client, deps);
  /**
   * Guard against a stale async response overwriting a newer view
   * (backlog:607f33ee): the home paints into the shell's shared mount, so
   * a late Oggi response must not repaint a screen the operator already
   * left. The shell calls invalidate() on every route that is not the
   * home; the token below covers overlapping home reads.
   */
  let renderToken = 0;
  /**
   * Backlog 2a075e2d9250 (production 2d2fe23): one loading round per
   * opening of Oggi. The ceiling starts at the round's FIRST render; a
   * redraw while the reads are still pending (the shell re-routes Oggi once
   * the schema and the Clienti count arrive) keeps the same deadline instead
   * of starting a new 10 s. The round ends when a render paints the home,
   * when the operator leaves (invalidate) or on Riprova. The round also
   * owns its reads: a redraw inside it awaits the same in-flight load
   * instead of reading everything again (a cold start used to pay Oggi
   * twice, and the first answer was thrown away).
   * The day paints as soon as the essentials are read (backlog
   * 2a075e2d9250, fc3fa62): `essentials` keeps that first answer, so a
   * redraw inside the round shows it again instead of «Carico…».
   * @type {{ timer: any, stalled: boolean, load: Promise<any> | null, essentials: any } | null}
   */
  let round = null;
  function endRound() {
    if (round !== null) clearTimer(round.timer);
    round = null;
  }
  function stalledNote() {
    const { spaceName, userName, links, now } = lastMeta;
    renderOggi({
      doc, mount, spaceName, userName, links, navigate, now,
      stalled: {
        onRetry: () => {
          endRound();
          void view.render({ spaceName, userName, links, now: new Date() });
        },
      },
    });
  }
  function invalidate() {
    renderToken += 1;
    endRound();
  }
  /** Session-local triage: decided suggestions only, records stay the truth. */
  let triage = {};
  /** Last loaded data, repainted on triage without re-reading. */
  let last = null;
  /** Last advisor list, so Domani finds the suggestion it defers. */
  let lastBuilt = null;
  /**
   * Follow-ups completed in this session, with the place they held: the
   * task leaves the open list on the next read, but like the prototype the
   * card stays, struck through, and the bar counts it (C12). Each entry
   * keeps the Rome day it was completed on: a paint on another day drops
   * it, so yesterday's completions never come back into today's list.
   * @type {Map<string, { action: any, index: number, day: string | null }>}
   */
  const completed = new Map();
  /** The cards last painted, completed ones included: their order is the place a completion keeps. */
  let lastActions = [];
  let lastMeta = { spaceName: '', userName: '', links: [], now: new Date() };
  let error = '';
  let busy = false;

  /** @param {any} [target] where to paint: the live mount, or a detached box for fill() */
  function paint(target = mount) {
    if (!last) return;
    const built = buildAdvisorActions({ tasks: last.tasks, appointments: last.appointments, now: lastMeta.now, names: last.appointmentNames ?? {} });
    lastBuilt = built;
    const merged = [...built.actions];
    const today = romeDayKey(lastMeta.now);
    for (const [id, entry] of completed) {
      if (entry.day !== today) {
        completed.delete(id);
        continue;
      }
      if (merged.some((action) => action?.id === id)) continue;
      merged.splice(Math.min(entry.index, merged.length), 0, entry.action);
    }
    // The cap holds on what is painted, completed cards included, and the
    // disclosure follows the merged list rather than the open one.
    const actions = merged.slice(0, ADVISOR_ACTION_LIMIT);
    const capped = built.capped || merged.length > ADVISOR_ACTION_LIMIT;
    lastActions = actions;
    const agenda = buildTodayAgenda(last.appointments, lastMeta.now, last.appointmentNames ?? {}, last.members ?? []);
    const brief = last.next
      ? buildPreCallBrief({ appointment: last.next, messages: last.briefMessages, calls: last.briefCalls, now: lastMeta.now, names: last.appointmentNames ?? {} })
      : null;
    const missing = missingLeadChannels(last.connections, last.profile ?? null);
    renderOggi({
      doc,
      mount: target,
      spaceName: lastMeta.spaceName,
      userName: lastMeta.userName,
      links: lastMeta.links,
      navigate,
      now: lastMeta.now,
      home: {
        recap: buildTodayRecap({ appointments: last.appointments, openTasks: last.tasks, now: lastMeta.now }),
        actions,
        triage,
        capped,
        agenda,
        brief,
        briefPending: last.pending === true,
        inbox: !last.inboxComposed
          ? null
          : last.inboxAvailable
            ? { available: true, ...buildInbox({ messages: last.inboxMessages, conversations: last.inboxConversations, names: last.inboxNames ?? {}, now: lastMeta.now }) }
            : { available: false, total: 0, rows: [] },
        missing,
        connections: last.connections,
        profile: last.profile ?? null,
        availability: {
          work: last.workAvailable,
          appointments: last.appointmentsAvailable,
          channels: last.channelsAvailable,
        },
        error,
        disabled: busy,
        events: {
          onPostpone: (actionId) => {
            void postpone(actionId);
          },
          onUndo: (actionId) => {
            triage = undoTriage(triage, actionId);
            error = '';
            paint();
          },
          onExecute: (action) => {
            void execute(action);
          },
        },
      },
    });
  }

  /**
   * "Domani" on a follow-up suggestion: the durable work-task `postpone`
   * action, with the same fresh re-read that guards every execution — the
   * row attenuates as "Rimandato a domani" only after the deferral commits,
   * and a refusal keeps the row open with the reason on screen. A suggestion
   * with no deferrable record (the pre-call prep only navigates) keeps the
   * previous session-only flag: there is nothing durable to write for it.
   * @param {unknown} actionId
   */
  async function postpone(actionId) {
    const action = (lastBuilt?.actions ?? []).find((candidate) => candidate?.id === actionId);
    if (!action) return;
    if (action?.run !== 'complete-task') {
      triage = applyTriageDecision(triage, actionId, 'postpone');
      error = '';
      paint();
      return;
    }
    if (busy) return;
    busy = true;
    error = '';
    paint();
    try {
      await executeAdvisorAction(bound, action, (checked) => bound.request(
        `/api/modules/work-task/records/${encodeURIComponent(checked.record.id)}/actions/postpone`,
        { method: 'POST', body: JSON.stringify({}) },
      ));
      triage = applyTriageDecision(triage, action.id, 'postpone');
    } catch (failure) {
      error = failure?.message ?? 'Azione non riuscita.';
    } finally {
      busy = false;
    }
    // The task stays open with its new due date: reload so the row re-sorts
    // instead of lingering on stale data.
    if (error === '') {
      await refresh();
    } else {
      paint();
    }
  }

  async function execute(action) {
    if (busy) return;
    busy = true;
    error = '';
    paint();
    try {
      if (action?.run === 'complete-task') {
        await executeAdvisorAction(bound, action, (checked) => bound.request(
          `/api/modules/work-task/records/${encodeURIComponent(checked.record.id)}/actions/complete`,
          { method: 'POST', body: JSON.stringify({}) },
        ));
        triage = applyTriageDecision(triage, action.id, 'done');
        const index = lastActions.findIndex((candidate) => candidate?.id === action.id);
        completed.set(action.id, { action, index: index === -1 ? 0 : index, day: romeDayKey(lastMeta.now) });
      } else {
        if (typeof action?.href === 'string' && action.href !== '') navigate(action.href);
        triage = applyTriageDecision(triage, action?.id, 'done');
      }
    } catch (failure) {
      error = failure?.message ?? 'Azione non riuscita.';
    } finally {
      busy = false;
    }
    // A completed task is gone from the open list: reload so consumed rows
    // disappear instead of lingering as done.
    if (error === '' && action?.run === 'complete-task') {
      await refresh();
    } else {
      paint();
    }
  }

  /**
   * Backlog 2a075e2d9250: the late answers (customer names, the call recap)
   * fill their own sections — Da rispondere, the agenda, the brief — in
   * place. The rest of the day (the advisor with its buttons, a focused
   * control) is never repainted. A structure that moved paints in full.
   */
  function fill() {
    const scratch = doc.createElement('div');
    paint(scratch);
    const section = (root, key) => root.querySelector(`section[data-oggi-section="${key}"]`);
    const pairs = [];
    for (const key of ['inbox', 'agenda', 'brief']) {
      const live = section(mount, key);
      const fresh = section(scratch, key);
      if ((live === null) !== (fresh === null)) {
        paint();
        return;
      }
      if (live !== null) pairs.push([live, fresh]);
    }
    for (const [live, fresh] of pairs) {
      while (live.firstChild) live.removeChild(live.firstChild);
      for (const child of Array.from(fresh.childNodes)) live.appendChild(child);
    }
    // backlog:7d30fb517785 (production 10/11: the advisor read «con un
    // ospite da confermare» while the agenda, at the same hour, named Fio
    // Neri): the customer names land after the advisor painted. Its rows
    // stay (buttons, focus); only their words take the names the agenda
    // just took, from the same map.
    for (const action of lastActions) {
      const id = String(action?.id ?? '');
      if (id === '' || id.includes('"')) continue;
      const liveRow = mount.querySelector(`div[data-action="${id}"]`);
      const freshRow = scratch.querySelector(`div[data-action="${id}"]`);
      if (liveRow === null || freshRow === null) continue;
      for (const cls of ['.bo-oggi-title', '.bo-oggi-why']) {
        const liveText = liveRow.querySelector(cls);
        const freshText = freshRow.querySelector(cls);
        if (liveText !== null && freshText !== null && liveText.textContent !== freshText.textContent) {
          liveText.textContent = freshText.textContent;
        }
      }
    }
  }

  async function refresh() {
    const token = ++renderToken;
    let data;
    try {
      data = await loadOggiData(bound, lastMeta.now);
    } catch {
      data = null;
    }
    if (token !== renderToken) return;
    if (data) last = data;
    paint();
  }

  const view = {
    /**
     * Render the home: the greeting frame with the loading state first,
     * the full screen once the records arrive. `userName` greets the person; without it the space
     * name stands in, as before.
     */
    async render({ spaceName = '', userName = '', links = [], now = new Date() } = {}) {
      const token = ++renderToken;
      lastMeta = { spaceName, userName, links, now };
      // Backlog 2a075e2d9250: past the ceiling the loading line gives way to
      // a note with Riprova. The reads keep going: if they land while this
      // render still owns the screen, the home replaces the note. A redraw
      // inside the same round keeps the first deadline (and a note already
      // shown), never a fresh 10 s.
      if (round === null) {
        const mine = { timer: null, stalled: false, load: null, essentials: null };
        mine.timer = setTimer(() => {
          // The day already painted from its essentials: no note over it.
          if (round !== mine || mine.essentials !== null) return;
          mine.stalled = true;
          stalledNote();
        }, ceilingMs);
        round = mine;
      }
      if (round.essentials !== null) {
        last = round.essentials;
        paint();
      } else if (round.stalled) {
        stalledNote();
      } else {
        renderOggi({ doc, mount, spaceName, userName, links, navigate, now, loading: true });
      }
      const current = round;
      if (current.load === null) {
        current.load = Promise.resolve().then(() => loadOggiData(bound, now, {
          // Backlog 2a075e2d9250: agenda and Da rispondere are in — paint
          // the day now, the names and the call recap fill in after.
          onEssentials: (partial) => {
            if (round !== current) return;
            current.essentials = partial;
            last = partial;
            paint();
          },
        })).catch(() => null);
      }
      const data = await current.load;
      if (token !== renderToken) return;
      endRound();
      const partialShown = last?.pending === true;
      if (data && partialShown) {
        last = data;
        fill();
        return;
      }
      if (data) last = data;
      else if (partialShown) last = { ...last, pending: false };
      else if (!last) {
        last = {
          workAvailable: false, appointmentsAvailable: false, channelsAvailable: false,
          interactionsAvailable: false, tasks: [], appointments: [], connections: [],
          profile: null,
          briefMessages: [], briefCalls: [], next: null, appointmentNames: {},
          inboxAvailable: false, inboxMessages: [], inboxConversations: [], inboxNames: {},
        };
      }
      paint();
    },
    invalidate,
  };
  return view;
}
