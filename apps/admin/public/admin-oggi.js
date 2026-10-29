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
import { bindAdminMutations } from './admin-submission.js';

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
function subjectDisplayLabel(row) {
  return nonEmptyText(row?.subjectLabel) ?? 'il cliente';
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

function badgeInitials(label) {
  const words = String(label ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const marks = words.slice(0, 2).map((word) => (word.match(/\p{L}/u)?.[0] ?? '').toUpperCase());
  return marks.join('') || '·';
}

function followupAction(task) {
  const id = nonEmptyText(task?.id);
  if (!id) return null;
  const title = nonEmptyText(task?.title) ?? 'Follow-up';
  const label = subjectDisplayLabel(task);
  const opened = romeShortDay(task?.openedAt);
  const why = `Follow-up aperto${opened ? ` il ${opened}` : ''}: ${label}.`;
  return Object.freeze({
    id: `bo04:followup:${id}`,
    kind: 'followup',
    mono: channelTile(task?.channel) ?? badgeInitials(label),
    channel: nonEmptyText(task?.channel) ?? null,
    note: nonEmptyText(task?.note) ?? null,
    title,
    why,
    cta: 'Completa',
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
 */
function appointmentPrepAction(appointment) {
  const id = nonEmptyText(appointment?.id);
  if (!id) return null;
  const time = romeTime(appointment?.startsAt);
  if (!time) return null;
  const label = subjectDisplayLabel(appointment);
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
 * @param {{ tasks?: Array<Record<string, any>>, appointments?: Array<Record<string, any>>, now?: Date }} input
 */
export function buildAdvisorActions({ tasks = [], appointments = [], now = new Date() } = {}) {
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
    const action = followupAction(task);
    if (action) actions.push(action);
  }
  const today = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && isTodayInRome(row.startsAt, now));
  today.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  if (today.length > 0) {
    const prep = appointmentPrepAction(today[0]);
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
 * Progress over today's suggestions: decided (done or postponed) over total.
 * @param {Array<{ id?: unknown }>} [actions]
 * @param {Record<string, string>} [triage]
 */
export function advisorProgress(actions = [], triage = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const handled = list.filter((action) => triageState(triage, action?.id) !== 'open').length;
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
    const error = new Error(
      `Il dato è cambiato mentre leggevi (${drift.join(', ')}): ricarica e rileggi prima di agire.`,
    );
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
  if (tasks.length === 0) {
    return `Niente in sospeso. Ti restano ${countNoun(today.length, 'appuntamento', 'appuntamenti')}.`;
  }
  const base = `Oggi hai ${countNoun(tasks.length, 'cosa da fare', 'cose da fare')} e ${countNoun(today.length, 'appuntamento', 'appuntamenti')}. Ti servono circa ${tasks.length * 3} minuti`;
  const drafted = tasks.filter((row) => nonEmptyText(row?.note) !== null).length;
  return drafted > 0 ? `${base}: ho già preparato i messaggi.` : `${base}.`;
}

/**
 * Today's agenda: booked/confirmed appointments on the Rome day, oldest
 * first. Each row links the customer scheda when the subject resolves, else
 * the appointment record itself — never a dead link.
 * @param {Array<Record<string, any>>} [appointments]
 * @param {Date} [now]
 */
export function buildTodayAgenda(appointments = [], now = new Date()) {
  const today = (Array.isArray(appointments) ? appointments : [])
    .filter((row) => row != null
      && (row.status === 'booked' || row.status === 'confirmed')
      && romeTime(row.startsAt) !== null
      && isTodayInRome(row.startsAt, now));
  today.sort((a, b) => (String(a.startsAt) < String(b.startsAt) ? -1 : String(a.startsAt) > String(b.startsAt) ? 1 : 0));
  return today.map((row) => {
    const id = nonEmptyText(row?.id) ?? '';
    // The prototype's second line under each appointment ("chi"): who the
    // appointment is with — the team member holding the slot, else a short
    // honest cue from the notes. Never invented when neither exists.
    const team = nonEmptyText(row?.teamMemberId);
    const cue = team ?? (nonEmptyText(row?.notes) ? briefSnippet(row.notes, 80) : null);
    return Object.freeze({
      id,
      time: romeTime(row.startsAt),
      title: subjectDisplayLabel(row),
      who: cue,
      status: row.status,
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
 * @param {{ appointment?: Record<string, any>, messages?: Array<Record<string, any>>, calls?: Array<Record<string, any>> }} input
 */
export function buildPreCallBrief({ appointment = null, messages = [], calls = [] } = {}) {
  if (appointment == null) return null;
  const id = nonEmptyText(appointment?.id) ?? '';
  const time = romeTime(appointment?.startsAt) ?? '—';
  const who = subjectDisplayLabel(appointment);
  const bullets = [];
  const notes = briefSnippet(appointment?.notes);
  bullets.push(notes !== ''
    ? `Appuntamento delle ${time} con ${who}: ${notes}`
    : `Appuntamento delle ${time} con ${who}.`);
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
    const when = romeShortDay(message?.occurredAt) ?? 'data non registrata';
    const channel = nonEmptyText(message?.channel) ?? 'canale';
    bullets.push(body !== ''
      ? `Messaggio ${channel} del ${when}: “${body}”`
      : `Messaggio ${channel} del ${when} (senza testo registrato).`);
    const source = briefSource(
      `Messaggio ${channel} del ${when}`,
      recordDetailHref('interaction-message', message.id),
    );
    if (source) sources.push(source);
  }
  const recent = (Array.isArray(calls) ? calls : [])
    .filter((row) => row != null && nonEmptyText(row?.id) !== null)
    .sort((a, b) => (String(a.occurredAt ?? '') < String(b.occurredAt ?? '') ? 1 : String(a.occurredAt ?? '') > String(b.occurredAt ?? '') ? -1 : 0))
    .slice(0, 2);
  for (const call of recent) {
    const when = romeShortDay(call?.occurredAt) ?? 'data non registrata';
    const outcome = briefSnippet(call?.outcome, 80);
    bullets.push(outcome !== ''
      ? `Chiamata del ${when}: ${outcome}`
      : `Chiamata del ${when} (esito non registrato).`);
    const source = briefSource(
      `Chiamata del ${when}`,
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
    when: `oggi alle ${time}`,
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
export const OGGI_TOTAL_CHANNELS = 9;

/**
 * The nine counted channel ids, in Stato sync order. Mirrors SYNC_CHANNELS
 * in admin-sync.js (the table owner): the lead catalog and the nine differ
 * (SMS is a lead channel but not one of the nine; Calendar and Stripe are
 * nine but not lead), so the count must read the nine, never the catalog.
 * Kept as ids here so Oggi never imports another screen's view module; the
 * test pins the two lists together.
 */
export const OGGI_NINE_CHANNELS = Object.freeze([
  'whatsapp', 'instagram', 'facebook', 'tiktok', 'email',
  'voice', 'site-form', 'calendar', 'stripe',
]);

/**
 * Distinct connected channels among the nine: active rows only, one vote
 * per channel, capped at the nine. A channel outside the nine never moves
 * this count.
 * @param {Array<Record<string, any>>} [connections]
 */
export function countConnectedNine(connections = []) {
  const active = new Set();
  for (const row of Array.isArray(connections) ? connections : []) {
    if (row == null || row.status !== 'active') continue;
    if (typeof row.channel !== 'string' || row.channel === '') continue;
    if (!OGGI_NINE_CHANNELS.includes(row.channel)) continue;
    active.add(row.channel);
  }
  return Math.min(active.size, OGGI_TOTAL_CHANNELS);
}

/**
 * Lead channels with no active connection, in catalog order with catalog
 * labels. `calendar` and `stripe` are not lead channels and stay out of the
 * invite: connecting them loses no lead.
 * @param {Array<Record<string, any>>} [connections]
 */
export function missingLeadChannels(connections = []) {
  const active = new Set(
    (Array.isArray(connections) ? connections : [])
      .filter((row) => row != null && row.status === 'active' && typeof row.channel === 'string')
      .map((row) => row.channel),
  );
  return CONNECTOR_CATALOG
    .filter((entry) => entry != null && !active.has(entry.channel))
    .map((entry) => Object.freeze({ channel: entry.channel, label: entry.label }));
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
 * Load everything Oggi renders. Never throws for a missing package: each
 * section carries its own availability.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Date} [now]
 */
export async function loadOggiData(client, now = new Date()) {
  const outcome = {
    workAvailable: false,
    appointmentsAvailable: false,
    channelsAvailable: false,
    interactionsAvailable: false,
    tasks: [],
    appointments: [],
    connections: [],
    briefMessages: [],
    briefCalls: [],
    next: null,
  };
  let domains = {};
  try {
    const schema = await client.request('/api/schema');
    domains = schema?.domains ?? {};
  } catch (error) {
    noteReadFailure('schema', error);
    return outcome;
  }
  if (domains.work != null) {
    try {
      outcome.tasks = await readModulePage(client, 'work-task', { status: 'open' });
      outcome.workAvailable = true;
    } catch (error) {
      noteReadFailure('work-task', error);
      outcome.tasks = [];
    }
  }
  if (domains.appointments != null) {
    try {
      outcome.appointments = await readModulePage(client, 'appointment');
      outcome.appointmentsAvailable = true;
    } catch (error) {
      noteReadFailure('appointment', error);
      outcome.appointments = [];
    }
  }
  if (domains.channels != null) {
    try {
      outcome.connections = await readModulePage(client, 'channel-connection');
      outcome.channelsAvailable = true;
    } catch (error) {
      noteReadFailure('channel-connection', error);
      outcome.connections = [];
    }
  }
  outcome.next = nextAppointment(outcome.appointments, now);
  if (outcome.next != null && domains.interactions != null) {
    const subject = {
      subjectResource: outcome.next.subjectResource,
      subjectId: outcome.next.subjectId,
    };
    if (nonEmptyText(subject.subjectResource) && nonEmptyText(subject.subjectId)) {
      try {
        const [messages, calls] = await Promise.all([
          readModulePage(client, 'interaction-message', {
            subjectResource: subject.subjectResource,
            subjectId: subject.subjectId,
          }),
          readModulePage(client, 'interaction-call', {
            subjectResource: subject.subjectResource,
            subjectId: subject.subjectId,
          }),
        ]);
        outcome.briefMessages = messages;
        outcome.briefCalls = calls;
        outcome.interactionsAvailable = true;
      } catch (error) {
        noteReadFailure('interactions', error);
        outcome.briefMessages = [];
        outcome.briefCalls = [];
      }
    }
  }
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
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

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
  } else if (state === 'postponed' && action?.run === 'complete-task') {
    // Durable deferral: the work-task postpone action already moved the due
    // date and wrote timeline evidence. No session "Annulla" here — it would
    // imply the deferral was cancelled while tomorrow's date stays stored.
    const done = el(doc, 'div', 'bo-oggi-btns');
    done.appendChild(el(doc, 'span', 'bo-oggi-state', 'Rimandato a domani'));
    row.appendChild(done);
  } else {
    const done = el(doc, 'div', 'bo-oggi-btns');
    done.appendChild(el(
      doc, 'span', 'bo-oggi-state',
      state === 'done' ? 'Fatto' : 'Rimandato a domani',
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
 * greeting frame over the delivered-screen links (pre-BO-F3-04 behavior,
 * kept while data loads); with `home` it is the full screen.
 *
 * @param {{
 *   doc: object,
 *   mount: object,
 *   spaceName?: unknown,
 *   userName?: unknown,
 *   links?: Array<{ id: unknown, label: string, route: string }>,
 *   navigate?: (hash: string) => void,
 *   now?: Date,
 *   home?: {
 *     recap?: string,
 *     actions?: Array<any>,
 *     triage?: Record<string, string>,
 *     capped?: boolean,
 *     agenda?: Array<{ id: unknown, time: unknown, title: unknown, who?: unknown, href: unknown }>,
 *     brief?: { title: unknown, when: unknown, bullets: Array<string>, sources: Array<{ label: string, href: string }> } | null,
 *     missing?: Array<{ channel: unknown, label: unknown }>,
 *     connections?: Array<{ channel?: unknown, status?: unknown }>,
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
  head.appendChild(el(doc, 'p', 'bo-oggi-progress', `${progress.handled} di ${progress.total} fatte`));
  advisor.appendChild(head);
  if (actions.length === 0) {
    advisor.appendChild(el(doc, 'p', 'bo-oggi-empty', '✓ Hai finito per oggi. Ti scrivo io se arriva qualcosa di urgente.'));
  } else {
    const list = el(doc, 'div', 'bo-oggi-actions');
    for (const action of actions) {
      list.appendChild(renderAdvisorRow(doc, action, triageState(triage, action?.id), { ...events, navigate }, disabled));
    }
    advisor.appendChild(list);
    if (home.capped === true) {
      advisor.appendChild(el(doc, 'p', 'bo-muted', `Mostro le prime ${actions.length} azioni.`));
    }
  }
  if (home.availability?.work === false) {
    advisor.appendChild(el(doc, 'p', 'bo-muted', 'I follow-up non sono composti in questo spazio: niente azioni da proporre.'));
  }
  page.appendChild(advisor);

  // ---- Agenda and pre-call brief: two cards side by side ----
  const pair = el(doc, 'div', 'bo-oggi-pair');
  page.appendChild(pair);
  const agenda = el(doc, 'section', 'bo-oggi-card');
  agenda.appendChild(el(doc, 'h3', undefined, 'Agenda di oggi'));
  const rows = Array.isArray(home.agenda) ? home.agenda : [];
  if (home.availability?.appointments === false) {
    agenda.appendChild(el(doc, 'p', 'bo-muted', 'Il calendario non è composto in questo spazio.'));
  } else if (rows.length === 0) {
    agenda.appendChild(el(doc, 'p', 'bo-muted', 'Niente appuntamenti oggi.'));
  } else {
    const list = el(doc, 'div', 'bo-oggi-agenda');
    for (const entry of rows) {
      const item = el(doc, 'div', 'bo-oggi-agenda-row');
      item.appendChild(el(doc, 'span', 'bo-oggi-time', String(entry?.time ?? '')));
      const cell = el(doc, 'div');
      if (typeof entry?.href === 'string' && entry.href !== '') {
        const anchor = el(doc, 'a', 'bo-setting-link', String(entry?.title ?? ''));
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
  if (home.brief != null) {
    const brief = el(doc, 'section', 'bo-oggi-card bo-oggi-ai');
    brief.appendChild(el(doc, 'h3', undefined, '✦ Prima della prossima call'));
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
    pair.appendChild(brief);
  }

  // ---- Missing channels ----
  const missing = Array.isArray(home.missing) ? home.missing : [];
  if (home.availability?.channels === false) {
    const note = el(doc, 'section', 'bo-oggi-section');
    note.appendChild(el(doc, 'p', 'bo-muted', 'I canali non sono composti in questo spazio.'));
    page.appendChild(note);
  } else if (missing.length > 0) {
    const invite = el(doc, 'section', 'bo-oggi-section');
    const names = missing.map((entry) => String(entry?.label ?? '')).filter((label) => label !== '');
    // The prototype's headline count: connected of the 9 backoffice
    // channels, read from the actual connections. Hand-built homes without
    // connections (tests) fall back to nine minus the missing lead list;
    // the live view always carries connections, so production never guesses.
    const connected = Array.isArray(home.connections)
      ? countConnectedNine(home.connections)
      : OGGI_TOTAL_CHANNELS - missing.length;
    const anchor = el(doc, 'a', 'bo-oggi-invite', '');
    anchor.appendChild(el(doc, 'strong', undefined, `${connected} di ${OGGI_TOTAL_CHANNELS} collegati`));
    anchor.appendChild(el(doc, 'span', undefined, ` Collega ${names.join(', ')} per non perdere nessun lead →`));
    anchor.setAttribute('href', '#/connettori');
    anchor.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate('#/connettori');
    });
    invite.appendChild(anchor);
    page.appendChild(invite);
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
export function createOggiView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client: bound } = bindAdminMutations(deps.client, deps);
  /** Guard against a stale async response overwriting a newer view. */
  let renderToken = 0;
  /** Session-local triage: decided suggestions only, records stay the truth. */
  let triage = {};
  /** Last loaded data, repainted on triage without re-reading. */
  let last = null;
  /** Last advisor list, so Domani finds the suggestion it defers. */
  let lastBuilt = null;
  let lastMeta = { spaceName: '', userName: '', links: [], now: new Date() };
  let error = '';
  let busy = false;

  function paint() {
    if (!last) return;
    const built = buildAdvisorActions({ tasks: last.tasks, appointments: last.appointments, now: lastMeta.now });
    lastBuilt = built;
    const agenda = buildTodayAgenda(last.appointments, lastMeta.now);
    const brief = last.next
      ? buildPreCallBrief({ appointment: last.next, messages: last.briefMessages, calls: last.briefCalls })
      : null;
    const missing = missingLeadChannels(last.connections);
    renderOggi({
      doc,
      mount,
      spaceName: lastMeta.spaceName,
      userName: lastMeta.userName,
      links: lastMeta.links,
      navigate,
      now: lastMeta.now,
      home: {
        recap: buildTodayRecap({ appointments: last.appointments, openTasks: last.tasks, now: lastMeta.now }),
        actions: built.actions,
        triage,
        capped: built.capped,
        agenda,
        brief,
        missing,
        connections: last.connections,
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

  return {
    /**
     * Render the home: the greeting frame first, the full screen once the
     * records arrive. `userName` greets the person; without it the space
     * name stands in, as before.
     */
    async render({ spaceName = '', userName = '', links = [], now = new Date() } = {}) {
      const token = ++renderToken;
      lastMeta = { spaceName, userName, links, now };
      renderOggi({ doc, mount, spaceName, userName, links, navigate, now });
      let data;
      try {
        data = await loadOggiData(bound, now);
      } catch {
        data = null;
      }
      if (token !== renderToken) return;
      if (data) last = data;
      else if (!last) {
        last = {
          workAvailable: false, appointmentsAvailable: false, channelsAvailable: false,
          interactionsAvailable: false, tasks: [], appointments: [], connections: [],
          briefMessages: [], briefCalls: [], next: null,
        };
      }
      paint();
    },
  };
}
