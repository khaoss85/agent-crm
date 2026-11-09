// @ts-check

// Team calendar (BO-F3 \"07 Calendario\"): the week the team holds, the
// \"fissa con una frase\" draft box, the free-slot proposals and the manual
// booking form — over the declared appointments operations, never over a
// second store. Every value renders through textContent/setAttribute, never
// innerHTML, so hostile member identities, notes or subjects are inert text.
//
// Honest states, never a blank screen: when the appointments package is not
// composed the week panel says so (the route answers 404 and the nav voice
// names the story); the team is the space roster when it reads, auto-listed
// with its week on mount — the typed filter stays only while the roster is
// unread, and a week for nobody is never answered with everyone's bookings;
// when nothing is held the week shows seven empty days, not an error. With
// no calendar connected the panel says so and points at Profilo. The human
// confirms every booking: propose plans, confirm creates, and a slot click
// only ever proposes — the confirm click is always the operator's own.
//
// Rome clock: every instant renders with timeZone 'Europe/Rome' through the
// Oggi helpers, never as UTC or ISO.

import { humanReadError, humanWriteError, isNotComposedFailure, isUnsupportedContractFailure, pendingRequestId, readBackPending, unrefWait } from './admin-core.js';
import { markUnsaved } from './admin-version.js';
import { isTodayInRome, romeDayKey, romeShortDay, romeTime } from './admin-oggi.js';
import { bindAdminMutations } from './admin-submission.js';
import { takePendingCustomerPick } from './admin-prefill.js';
import { ACTIVE_SPACE_KEY } from './admin-shell.js';
import { nameFromProfile } from './admin-labels.js';
import { uiAddOption, uiButton, uiChannelChip, uiSearchField, uiSecondaryButton, uiSelect } from './admin-ui.js';

/**
 * The currently open "Nuovo appuntamento" menu, if any: one live view at a
 * time, so one closer slot is enough. Set when a menu opens, cleared when it
 * closes — a stale closer only hides a detached menu, never live content.
 * @type {{ wrap: any, close: () => void } | null}
 */
let openMenu = null;

/** The document the single outside-click closer is installed on, if any. */
let outsideInstalledOn = null;

/**
 * Install once per document: a click outside the open menu closes it. The
 * containment walk uses parentNode, so the dependency-free fake DOM used by
 * the unit tests behaves like a real Element. Documents without
 * addEventListener (the fake document) skip the closer; the toggle button,
 * the voices and Escape still work there.
 * @param {any} doc
 */
function installOutsideCloser(doc) {
  if (outsideInstalledOn === doc || typeof doc?.addEventListener !== 'function') return;
  outsideInstalledOn = doc;
  doc.addEventListener('click', (event) => {
    const current = openMenu;
    if (!current) return;
    let node = event?.target ?? null;
    while (node) {
      if (node === current.wrap) return;
      node = node.parentNode ?? null;
    }
    current.close();
  });
}

/**
 * The week the calendar opens on (backlog:df55cf25): the Rome Mon..Sun week
 * containing `now`, except on Saturday/Sunday — when the painted Mon..Fri
 * work days would already be over — when the following Mon..Sun opens
 * instead, so the grid shows the coming days, never the past ones. Pure and
 * DOM-free so it is unit-tested without a browser.
 */
export function openingWeekKeys(now = new Date()) {
  const instant = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const todayKey = romeDayKey(instant);
  if (!todayKey) return romeWeekKeys(instant);
  // Noon UTC of the Rome day is afternoon in Rome on the same calendar
  // day, so its UTC weekday is the Rome weekday — no DST arithmetic.
  const dayIndex = (new Date(`${todayKey}T12:00:00Z`).getUTCDay() + 6) % 7;
  if (dayIndex < 5) return romeWeekKeys(instant);
  const monday = new Date(Date.parse(`${todayKey}T12:00:00Z`) + (7 - dayIndex) * 24 * 3600 * 1000);
  return romeWeekKeys(monday);
}

/** Rome week (Monday..Sunday) containing `now`, as YYYY-MM-DD keys. */
export function romeWeekKeys(now = new Date()) {
  const instant = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const todayKey = romeDayKey(instant);
  if (!todayKey) return [];
  // Noon UTC of the Rome day is afternoon in Rome on the same calendar
  // day, so its UTC weekday is the Rome weekday — no DST arithmetic.
  const monday = new Date(`${todayKey}T12:00:00Z`);
  const dayIndex = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - dayIndex);
  const keys = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday.getTime() + offset * 24 * 3600 * 1000);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * ISO window covering a Rome week: the Rome Monday 00:00 is Sunday 22:00Z
 * (summer) or 23:00Z (winter), so a day of margin on each side keeps every
 * event of the Rome week inside whatever the offset is.
 * @param {Array<string>} weekKeys
 */
export function weekWindow(weekKeys) {
  if (!Array.isArray(weekKeys) || weekKeys.length === 0) return null;
  const first = Date.parse(`${weekKeys[0]}T00:00:00Z`);
  const last = Date.parse(`${weekKeys[weekKeys.length - 1]}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last)) return null;
  return {
    from: new Date(first - 24 * 3600 * 1000).toISOString(),
    to: new Date(last + 2 * 24 * 3600 * 1000).toISOString(),
  };
}

/**
 * Split a member filter line (\"marco, sara\") into identities.
 * @param {unknown} value
 */
export function parseMemberFilter(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''),
  )];
}

/**
 * Required manual booking fields, checked before any request
 * (backlog:9046f940). Pure and DOM-free so it is unit-tested without a
 * browser. The customer rides the name-search pick, never a typed id:
 * without a pick the claim would book «senza-cliente», so a missing pick
 * counts as missing too. Returns the Italian labels of the empty fields.
 * @param {{teamMemberId?: unknown, serviceKey?: unknown, date?: unknown, start?: unknown, end?: unknown}} values
 * @param {unknown} hasCustomerPick
 */
export function missingBookingFields(values, hasCustomerPick) {
  const read = (name) => String(values?.[name] ?? '').trim();
  const missing = [];
  if (hasCustomerPick !== true) missing.push('cliente');
  if (read('teamMemberId') === '') missing.push('persona del team');
  if (read('serviceKey') === '') missing.push('servizio');
  if (read('date') === '') missing.push('giorno');
  if (read('start') === '') missing.push('inizio');
  if (read('end') === '') missing.push('fine');
  return missing;
}

/** Week label for the nav ("19 – 25 ott 2026"), null when unparsable. */
export function weekLabel(weekKeys) {
  if (!Array.isArray(weekKeys) || weekKeys.length === 0) return null;
  const first = romeShortDay(`${weekKeys[0]}T12:00:00Z`);
  const last = romeShortDay(`${weekKeys[weekKeys.length - 1]}T12:00:00Z`);
  if (!first || !last) return null;
  // The short day labels carry no year, and a Rome week can straddle New
  // Year: name both years when they differ instead of pinning the first
  // key's year on the January days.
  const firstYear = String(weekKeys[0]).slice(0, 4);
  const lastYear = String(weekKeys[weekKeys.length - 1]).slice(0, 4);
  if (firstYear === lastYear) return `${first} – ${last} ${lastYear}`;
  return `${first} ${firstYear} – ${last} ${lastYear}`;
}

/**
 * BO-F6-11 fetta 4 (specs/calendario.md C13): the prototype shows a work
 * week — Monday..Friday against an 09:00–18:00 hour axis. The loaded week
 * stays Monday..Sunday (the pager and the window do not move); only the
 * painted columns are the first five keys.
 * @param {Array<string>} weekKeys
 */
export function displayKeys(weekKeys) {
  return Array.isArray(weekKeys) ? weekKeys.slice(0, 5) : [];
}

/** Grid geometry: half-hour rows from 09:00 (inclusive) to 18:00. */
export const GRID_START_MINUTES = 9 * 60;
/** Customer names read per loaded week for the block titles (backlog:5fbebe8559e9). */
const WEEK_PROFILE_READS = 40;
export const GRID_END_MINUTES = 18 * 60;
export const GRID_SLOT_MINUTES = 30;
export const GRID_ROWS = (GRID_END_MINUTES - GRID_START_MINUTES) / GRID_SLOT_MINUTES;

/** Column header `<ddd> <n>` ("lun 19"), null when unparsable. */
export function dayHead(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric',
    }).format(new Date(`${key}T12:00:00Z`)).replace(/\./g, '');
  } catch {
    return null;
  }
}

/**
 * Member colour, deterministic per identity: the same member keeps the same
 * tint across days and renders. No roster exists (space-permissions stores
 * no members), so the tint hashes the opaque member id — never a name.
 * @param {unknown} memberId
 */
export function memberColorIndex(memberId) {
  const id = typeof memberId === 'string' ? memberId : '';
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 5;
}

/**
 * Avatar initials from the painted person name ("Dan" → "DA"): unicode
 * letters, so accented Italian names keep their initial ("Èlena" → "ÈL").
 * Falls back to the opaque subject when no name is known, and to "··" when
 * nothing readable names the person. @param {unknown} memberId
 */
export function memberInitials(memberId) {
  if (typeof memberId !== 'string') return '··';
  const letters = Array.from(memberId.replace(/[^\p{L}]/gu, '')).slice(0, 2).join('').toUpperCase();
  return letters === '' ? '··' : letters;
}

/**
 * WhatsApp origin marker, fail-closed: only an explicit 'whatsapp' channel
 * on the row paints the WA badge. Team-week rows carry no channel today, so
 * live rows show no badge and never a guess — the origin capability
 * (interaction-log/timeline) plugs in here when it is composed.
 * @param {any} row
 */
export function channelOf(row) {
  return row && row.channel === 'whatsapp' ? 'whatsapp' : null;
}

/**
 * backlog:29bb3f2c0d64 — where a week row was booked, read only from what
 * the row proves: the explicit WhatsApp marker first, then the booking
 * source key every writer stamps with its own prefix — `gcal:` for an
 * event imported by calendar-sync (packages/calendar-sync sourceKeyFor),
 * `booking-link:` for the public booking link (appointments bookFromLink),
 * `calendario:` for a booking made on this screen (manual form or phrase
 * Conferma, indistinguishable on the row). Anything else is null: no pill,
 * never a guess.
 * @param {any} row
 * @returns {'whatsapp'|'google'|'link'|'calendario'|null}
 */
export function originOf(row) {
  if (channelOf(row) === 'whatsapp') return 'whatsapp';
  const key = typeof row?.sourceKey === 'string' ? row.sourceKey : '';
  if (key.startsWith('gcal:')) return 'google';
  if (key.startsWith('booking-link:')) return 'link';
  if (key.startsWith('calendario:')) return 'calendario';
  return null;
}

/**
 * BO-F6-11 fetta 6 (specs/calendario.md C10): one Team toggle row per NAMED
 * member — never invented people. The framework stores no roster
 * (space-permissions keeps no members; membership is control-plane data),
 * so each row shows the opaque identity the operator named, tinted and
 * initialled by that identity. No role line: no role source exists in the
 * framework, and an invented role would lie to the operator.
 * @param {unknown} named @param {unknown} hidden
 */
export function teamRows(named, hidden) {
  const names = Array.isArray(named) ? named.filter((id) => typeof id === 'string' && id !== '') : [];
  const off = new Set(Array.isArray(hidden) ? hidden.filter((id) => typeof id === 'string') : []);
  return [...new Set(names)].map((id) => ({
    id,
    active: !off.has(id),
    color: memberColorIndex(id),
    initials: memberInitials(id),
  }));
}

/**
 * Non-empty trimmed text, or null. Display names and mailboxes travel
 * through here, so a blank or non-string value never becomes a person.
 * @param {unknown} value
 */
function cleanPersonText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** Lower-cased person key for grouping, or null when there is none. @param {unknown} value */
function personKeyOf(value) {
  const text = cleanPersonText(value);
  return text === null ? null : text.toLowerCase();
}

/**
 * backlog:810ed0bf — the control-plane same-person key of a roster row
 * (`operatorAccountId`, one per human), or null when the roster carries
 * none. The pilot forwards it beside the subject when it knows it, so the
 * Team card unites one member's identities (broker, github, google) even
 * when they carry different mailboxes. Only this documented key merges:
 * generic `personKey`/`personId`/`userId` fields have no producer contract
 * in this repo, and two unrelated humans sharing one would merge into a
 * single unbookable row — so they never merge here.
 * @param {any} member
 */
function rosterPersonId(member) {
  if (!member || typeof member !== 'object') return null;
  const value = member.operatorAccountId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Member creation instant (epoch ms), or null when the roster carries none.
 * The roster's own order is the fallback: it lists members oldest first.
 * @param {any} member
 */
function memberBornAt(member) {
  const raw = member?.createdAt ?? member?.created_at ?? null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * backlog:df55cf25 — one Team row per PERSON, never a technical id on
 * screen. The roster (`GET /api/spine/memberships`, enriched by the pilot
 * with the control-plane displayName/email beside each opaque subject) names
 * the human behind every subject, and one human can hold several subjects
 * (`github|…`, `google|…`, mailbox): subjects merge ONLY on the shared
 * mailbox (unique per person), so Dan is one row called Dan. A shared
 * display name alone never merges — two email-less homonyms are two humans,
 * two rows with distinct booking identities and ordinal labels («Rossi (1)»,
 * «Rossi (2)» in member-creation order, never a technical id). A group
 * with no roster name and no mailbox paints the
 * operator's own typed words, unless they look like a technical subject
 * (a pipe id never paints anywhere); such a row falls back to the generic
 * «Membro del team». No role line: the E2E takes the «Proprietario» chip out
 * of the card — the Team card filters the week, roles live on in Spazi e
 * accessi. Tint stays hashed on the stable primary subject and initials
 * follow the painted name, so a block and its toggle always match.
 * backlog:3ce220e6 (verification Mac 09/11 on 810ed0bf AC-2): Dan holds
 * three identities (broker, github, google) with different mailboxes and NO
 * control-plane person key — the pilot forwards only displayName and email
 * beside each subject (see the /bo/api/spine/memberships shape), so the
 * shared display name is the only same-person signal left, and it merges.
 * This narrows backlog:df55cf25 («a shared display name alone never
 * merges»): two same-named email-less homonyms now paint one row. The
 * trade-off is documented: two truly different humans sharing one display
 * name fold into one row, with every identity still listed, bookable and
 * removable inside it. Different names never merge.
 * @param {unknown} named @param {unknown} hidden @param {unknown} members
 */
export function personRows(named, hidden, members) {
  const names = Array.isArray(named) ? [...new Set(named.filter((id) => typeof id === 'string' && id !== ''))] : [];
  const off = new Set(Array.isArray(hidden) ? hidden.filter((id) => typeof id === 'string') : []);
  const roster = Array.isArray(members)
    ? members.filter((member) => member && typeof member.subject === 'string' && member.subject !== '')
    : [];
  /** @type {Array<{subjects: Array<string>, displayName: string|null, email: string|null, personId: string|null, nameKey: string|null, born: number|null, bornIndex: number}>} */
  const groups = [];
  const bySubject = new Map();
  const byEmail = new Map();
  const byPerson = new Map();
  const byName = new Map();
  const mailBySubject = new Map();
  const groupFor = (subject) => bySubject.get(subject) ?? null;
  for (const member of roster) {
    const subject = member.subject;
    if (bySubject.has(subject)) continue;
    const personId = rosterPersonId(member);
    const email = personKeyOf(member.email);
    const display = cleanPersonText(member.displayName);
    const nameKey = personKeyOf(display);
    // One human shares one mailbox, one control-plane person key, or one
    // display name (backlog:3ce220e6): the roster the pilot forwards carries
    // no person key, and one human's identities (broker, github, google)
    // carry different mailboxes, so the shared name is the same-person
    // signal that is left. Different names never merge.
    let group = (personId !== null && byPerson.get(personId))
      || (email !== null && byEmail.get(email))
      || (nameKey !== null && byName.get(nameKey))
      || null;
    if (!group) {
      group = { subjects: [], displayName: null, email: null, personId: null, nameKey: null, born: null, bornIndex: groups.length };
      groups.push(group);
    }
    group.subjects.push(subject);
    bySubject.set(subject, group);
    const rawMail = cleanPersonText(member.email);
    if (rawMail !== null && !mailBySubject.has(subject)) mailBySubject.set(subject, rawMail);
    const born = memberBornAt(member);
    if (born !== null) group.born = group.born === null ? born : Math.min(group.born, born);
    if (personId !== null && group.personId === null) {
      group.personId = personId;
      byPerson.set(personId, group);
    }
    if (email !== null && group.email === null) {
      group.email = member.email.trim();
      byEmail.set(email, group);
    }
    if (nameKey !== null && group.nameKey === null) {
      group.nameKey = nameKey;
      if (!byName.has(nameKey)) byName.set(nameKey, group);
    }
    if (group.displayName === null && display !== null) group.displayName = display;
  }
  // The operator's named filter joins in: a named subject joins its roster
  // group, an unknown one stands alone with no roster name.
  for (const id of names) {
    if (!groupFor(id)) {
      const group = { subjects: [id], displayName: null, email: null };
      groups.push(group);
      bySubject.set(id, group);
    }
  }
  const order = [];
  const seen = new Set();
  const rosterSubjects = roster.map((member) => member.subject);
  for (const id of [...names, ...rosterSubjects]) {
    const group = groupFor(id);
    if (group && !seen.has(group)) {
      seen.add(group);
      order.push(group);
    }
  }
  const painted = order.map((group) => {
    const primary = group.subjects.find((subject) => names.includes(subject)) ?? group.subjects[0];
    const name = group.displayName ?? group.email;
    const listed = group.subjects.some((subject) => names.includes(subject));
    const base = name ?? (listed && !primary.includes('|') ? primary : 'Membro del team');
    return { group, primary, name, listed, base };
  });
  // Same base label on two humans is unreadable: the operator could not tell
  // which toggle hides whose blocks (owner 04/11: «Marco Rossi (1)»,
  // «Marco Rossi (2)», in member-creation order, never a technical id).
  // Numbering follows member creation — member.createdAt when the roster
  // carries it, else the roster's own order — and stays in this one place,
  // so Team, manual choice and booking lines read the same label.
  const byBase = new Map();
  for (const entry of painted) {
    const list = byBase.get(entry.base) ?? [];
    list.push(entry);
    byBase.set(entry.base, list);
  }
  const ordinalOf = new Map();
  for (const entries of byBase.values()) {
    if (entries.length < 2) continue;
    const dated = entries.every((entry) => entry.group.born !== null);
    const ranked = [...entries].sort((left, right) => (
      dated
        ? (left.group.born - right.group.born || left.group.bornIndex - right.group.bornIndex)
        : (left.group.bornIndex - right.group.bornIndex)
    ));
    ranked.forEach((entry, index) => ordinalOf.set(entry.group, index + 1));
  }
  // One readable descriptor per booked subject, in roster order: the mailbox
  // the roster knows for it, else the identity kind (`github` in
  // `github|…`), never a raw pipe id. Multi-identity rows paint them so the
  // operator sees every identity the row books, hides or shows.
  const descriptorOf = (subject) => {
    const mail = mailBySubject.get(subject) ?? null;
    if (mail !== null) return mail;
    const cut = subject.indexOf('|');
    if (cut === -1) return subject;
    const kind = subject.slice(0, cut).trim().toLowerCase();
    return kind === '' ? null : kind;
  };
  return painted.map(({ group, primary, name, listed, base }) => {
    const ordinal = ordinalOf.get(group);
    const label = ordinal === undefined ? base : `${base} (${ordinal})`;
    const identities = [];
    for (const subject of group.subjects) {
      const descriptor = descriptorOf(subject);
      if (descriptor !== null && !identities.includes(descriptor)) identities.push(descriptor);
    }
    return {
      ids: [...group.subjects],
      id: primary,
      name,
      label,
      listed,
      identities,
      // Pressed while any of the person's identities paints: a partially
      // hidden row still shows blocks, so it reads as on until fully off.
      active: listed && group.subjects.some((subject) => !off.has(subject)),
      color: memberColorIndex(primary),
      initials: memberInitials(name ?? primary),
    };
  });
}

/**
 * backlog:df55cf25 — the readable member name for a week subject: the
 * roster person name when the roster knows the subject, else the
 * operator's own typed words unless they look like a technical subject. A
 * pipe id never paints — the caller omits the member part instead. Null
 * when nothing readable names the subject.
 * @param {unknown} subject @param {unknown} named @param {unknown} members
 */
export function resolveMemberName(subject, named, members) {
  if (typeof subject !== 'string' || subject === '') return null;
  const rows = personRows(named, [], members);
  const group = rows.find((row) => row.ids.includes(subject));
  // The painted person label, with the homonym ordinal when two humans share
  // the base name — the same string the Team toggle and the manual choice
  // show, so every line names the same human.
  if (group && group.name) return group.label;
  // A readable nickname the phrase or slot named paints back; a pipe id is
  // a technical subject and never paints — the caller omits it instead.
  if (!subject.includes('|')) return subject;
  return null;
}

/**
 * backlog:df55cf25 — the painted Team label for a week subject: the person
 * name, the operator's typed words, or the generic fallback. Used where a
 * line needs a member unconditionally (draft and confirmation lines).
 * @param {unknown} subject @param {unknown} named @param {unknown} members
 */
export function memberLabelFor(subject, named, members) {
  return resolveMemberName(subject, named, members) ?? 'Membro del team';
}

/**
 * Rome wall minutes since midnight for an instant, or null when the instant
 * does not parse. Presentation only: the server stays the write authority.
 * @param {unknown} value
 */
export function romeMinutes(value) {
  const instant = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(String(value ?? ''));
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const hour = get('hour') % 24;
    const minute = get('minute');
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Half-hour grid rows (1-based, inside the day column) for an event: start
 * row and span, clamped into the 09:00–18:00 body so an out-of-hours booking
 * still paints at the edge with its exact time in the label — never dropped.
 * @param {unknown} startsAt @param {unknown} endsAt
 */
export function gridRowsFor(startsAt, endsAt) {
  const startMin = romeMinutes(startsAt);
  const endMin = romeMinutes(endsAt);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return { row: 1, span: 1 };
  }
  const clampedStart = Math.min(Math.max(startMin, GRID_START_MINUTES), GRID_END_MINUTES);
  const clampedEnd = Math.min(Math.max(endMin, GRID_START_MINUTES + GRID_SLOT_MINUTES), GRID_END_MINUTES);
  const row = Math.min(Math.floor((clampedStart - GRID_START_MINUTES) / GRID_SLOT_MINUTES), GRID_ROWS - 1) + 1;
  const span = Math.max(1, Math.ceil((Math.max(clampedEnd, clampedStart + 1) - (GRID_START_MINUTES + (row - 1) * GRID_SLOT_MINUTES)) / GRID_SLOT_MINUTES));
  return { row, span: Math.min(span, GRID_ROWS - row + 1) };
}

/**
 * Whether a proposed slot paints inside the 09:00–18:00 grid body: only a
 * slot starting inside the painted hours lands on its own rows. Anything
 * earlier or later would clamp onto another hour's row under its real time
 * (a 19:00 proposal painted on the 17:00 row), so the grid names it below
 * instead of painting it — the grid covers the proposal hours or says so.
 * @param {unknown} startsAt @param {unknown} endsAt
 */
export function slotInGrid(startsAt, endsAt) {
  const startMin = romeMinutes(startsAt);
  const endMin = romeMinutes(endsAt);
  if (startMin === null || endMin === null || endMin <= startMin) return false;
  // 18:00 is the bottom edge of the grid, not a row: a slot starting there
  // would clamp onto the 17:30 row (backlog:5fbebe8559e9), so it is named
  // below the grid like every other out-of-hours step.
  return startMin >= GRID_START_MINUTES && startMin < GRID_END_MINUTES;
}

/** Phrase read-back cadence: every 3 s, about a minute (production 07/11). */
/** Quiet time after the last keystroke before the customer search reads (backlog:29bb3f2c0d64). */
export const SEARCH_DEBOUNCE_MS = 300;
/**
 * backlog:3771ac637027 — slot Conferma refusals the manual form fixes. They
 * name the form by its title, never «qui sotto»: a slot Conferma only
 * exists after a phrase draft, which opens and fills the form
 * (fillManual), so the form is always open here — but it sits in the
 * rail, or in the popover beside the grid, not necessarily below the card.
 */
const CONFIRM_SERVICE_NOTE = 'Conferma non riuscita: scegli un servizio dal listino nel modulo «Nuovo appuntamento».';
const CONFIRM_FORM_NOTE = 'Conferma non riuscita: controlla cliente, servizio e prezzo nel modulo «Nuovo appuntamento».';
export const PHRASE_RESUME_EVERY_MS = 3000;
export const PHRASE_RESUME_ROUNDS = 20;

/**
 * backlog:d1e4d90e — draft duration in whole minutes for the suggest path:
 * the model's endsAt minus startsAt when the draft searched that size, else
 * the stated durationMinutes when the search accepts it, else the default
 * step. A «45 minuti» sentence without a time still searches 45, never 30.
 * @param {any} draft
 */
export function draftMinutes(draft) {
  const from = draft?.startsAt ? Date.parse(draft.startsAt) : NaN;
  const to = draft?.endsAt ? Date.parse(draft.endsAt) : NaN;
  const pair = Math.round((to - from) / 60000);
  const stated = draft?.durationMinutes;
  const statedOk = Number.isSafeInteger(stated) && [15, 30, 45, 60, 90, 120].includes(stated);
  // A day-only draft (midnight start, production 07/11) carries an end the
  // model padded, not one the sentence stated: the stated minutes win.
  if (statedOk && draftDayOnly(draft)) return stated;
  if ([15, 30, 45, 60, 90, 120].includes(pair)) return pair;
  if (statedOk) return stated;
  return 30;
}

/**
 * Production 07/11 («trova 45 minuti con Daniele giovedì» drafted «12 nov
 * 00:00–00:30»): the model answers a named day without a time as a Rome
 * midnight instant. A midnight start is a day, not a time — the booking
 * hours never start at 00:00 — so the draft paints «orario da scegliere»
 * and the manual form leaves the hours empty.
 * @param {any} draft
 */
export function draftDayOnly(draft) {
  const startsAt = typeof draft?.startsAt === 'string' ? draft.startsAt : '';
  if (startsAt !== '') return romeTime(startsAt) === '00:00';
  // backlog:65ed7430 — the server names a stated day without a time as
  // `day` with no startsAt: still a day, not a time.
  return typeof draft?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.day);
}

/**
 * The Rome day a phrase draft names, or null: the slot search is bound to
 * it, so «giovedì» never proposes Monday first (production 07/11).
 * @param {any} draft
 */
export function draftDayKey(draft) {
  // backlog:65ed7430 — a stated `day` with no startsAt names the day the
  // same way, so the slot search stays bound to it.
  if (typeof draft?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.day)) return draft.day;
  const startsAt = typeof draft?.startsAt === 'string' ? draft.startsAt : '';
  return startsAt === '' ? null : romeDayKey(startsAt);
}

/**
 * The draft line's «when»: day and hours when the sentence gave a time,
 * the day plus «orario da scegliere» when it named only a day, else the
 * minutes it will search — never «00:00» and never «? –».
 * @param {any} draft
 */
export function draftWhen(draft) {
  const day = romeShortDay(draft?.startsAt);
  if (day && draftDayOnly(draft)) {
    // The weekday leads, so «giovedì» reads back as the operator said it.
    const weekday = romeWeekdayShort(draft.startsAt);
    return `${weekday ? `${weekday} ` : ''}${day} · orario da scegliere · ${draftMinutes(draft)} minuti`;
  }
  // backlog:65ed7430 — a stated `day` with no startsAt reads the same way:
  // noon UTC always falls on the same Rome day (+1/+2). Never «?».
  if (!day && typeof draft?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.day)) {
    const noon = `${draft.day}T12:00:00Z`;
    const label = romeShortDay(noon) ?? draft.day;
    const weekday = romeWeekdayShort(noon);
    return `${weekday ? `${weekday} ` : ''}${label} · orario da scegliere · ${draftMinutes(draft)} minuti`;
  }
  const from = romeTime(draft?.startsAt);
  const to = romeTime(draft?.endsAt);
  if (day && from && to) return `${day} ${from}–${to}`;
  if (day && from) return `${day} ${from}`;
  return `${draftMinutes(draft)} minuti`;
}

/** Short Italian Rome weekday («gio») of an instant, or null. @param {unknown} value */
function romeWeekdayShort(value) {
  const at = Date.parse(String(value ?? ''));
  if (!Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short' })
      .format(new Date(at)).replace(/\./g, '');
  } catch {
    return null;
  }
}

/**
 * Proposal row label (backlog:29bb3f2c0d64): weekday, day and month, then
 * the hours, the prototype's «Mar 20 · 11:30–12:15» in the screen's own
 * words — «gio 13 nov · 10:00–10:45». Without the weekday the operator had
 * to count days to know which «13 nov» it was.
 * @param {any} slot
 */
export function slotLabel(slot) {
  const day = [romeWeekdayShort(slot?.startsAt), romeShortDay(slot?.startsAt)].filter(Boolean).join(' ');
  return `${day} · ${romeTime(slot?.startsAt) ?? ''}–${romeTime(slot?.endsAt) ?? ''}`;
}

/**
 * The listino key a typed service names: the key itself when typed, or
 * the key of the one catalog product whose name the operator typed
 * («Lezione prova» → `lezione-prova`). Anything else travels as typed when
 * its shape is sendable and the server decides; an unsendable shape never
 * leaves the form (servicePresendError, production 07/11).
 * @param {unknown} typed @param {Map<string, string> | null | undefined} names sku → name
 */
export function serviceKeyFor(typed, names) {
  const text = typeof typed === 'string' ? typed.trim() : '';
  if (text === '' || !(names instanceof Map)) return text;
  if (names.has(text.toLowerCase())) return text.toLowerCase();
  const wanted = text.toLowerCase();
  const hits = [...names.entries()].filter(([, name]) => String(name).trim().toLowerCase() === wanted);
  return hits.length === 1 ? hits[0][0] : text;
}

/** A listino product key: lowercase slug, like the booking server requires. */
const CATALOG_SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * backlog:810ed0bf — the catalog slug of a product or offer name
 * («Lezione prova» → `lezione-prova`): lowercase, spaces and underscores
 * become one hyphen, anything outside the key alphabet drops out. Empty
 * when the name holds no slug character at all — never guessed.
 * @param {unknown} value
 */
export function slugifyServiceKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 48);
}

/** Minor units of one `one_time` component, or null when it fixes no hour price. @param {any} only */
function catalogSingleAmount(only) {
  if (!only || typeof only !== 'object') return null;
  if (only.chargeType !== 'one_time') return null;
  const amount = only.pricingModel === 'per_unit'
    ? only.unitAmountCents
    : (only.pricingModel === 'flat_fee' ? only.flatAmountCents : undefined);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

/**
 * backlog:810ed0bf — the bookable services of a `GET /api/catalog/products`
 * answer: one entry per active product with an active offer fixing one
 * `one_time` hour price — the same singles rule the booking worker uses, so
 * the menu never offers a pack, a subscription or a price the worker would
 * refuse. The key is the product sku the week titles already read as the
 * listino key, slugified from the product name when the sku is no key;
 * a product with no key and no nameable offer stays out. First
 * bookable offer wins per product, first product wins per key.
 * @param {unknown} payload
 */
export function catalogBookingServices(payload) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const out = [];
  const seen = new Set();
  for (const product of products) {
    if (!product || typeof product !== 'object' || product.active !== true) continue;
    const sku = typeof product.sku === 'string' ? product.sku.trim().toLowerCase() : '';
    const name = typeof product.name === 'string' ? product.name.trim() : '';
    if (name === '' || name.length > 200) continue;
    const offers = Array.isArray(product.offers) ? product.offers : [];
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object' || offer.active !== true) continue;
      // The claim and the menu label only speak EUR (the form prices in
      // EUR and the claim hardcodes currency:'EUR'): a non-EUR single
      // would be mislabeled and misbooked, so it stays out of the menu.
      const currency = offer.currency === 'EUR' ? 'EUR' : null;
      if (currency === null) continue;
      const components = Array.isArray(offer.components) ? offer.components : [];
      if (components.length !== 1) continue;
      const priceCents = catalogSingleAmount(components[0]);
      if (priceCents === null) continue;
      const key = CATALOG_SLUG_RE.test(sku) ? sku : slugifyServiceKey(name);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({ key, name, priceCents, currency }));
      break;
    }
  }
  return Object.freeze(out);
}

/**
 * backlog:810ed0bf — minor units to the price text the manual form paints
 * (`4500` → `'45.00'`), two decimals, dot separator like the form hint.
 * Null when the amount is no integer of cents.
 * @param {unknown} priceCents
 */
export function formatPriceCents(priceCents) {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return null;
  return `${Math.floor(priceCents / 100)}.${String(priceCents % 100).padStart(2, '0')}`;
}

/**
 * The sendable shape of the service the claim carries: the framework books
 * the listino product key (lowercase slug, letters, digits, hyphens, at most
 * 48 characters — `packages/appointments` SERVICE_KEY_RE), and the pilot
 * /bo route refuses anything else with BO_APPOINTMENT_SERVICE_REFUSED before
 * the queue. Mirrored here so the form blocks a hand-typed service that
 * could never book instead of sending it to a 400.
 */
const BOOKING_SERVICE_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * The Italian sentence blocking a hand-typed service before any request, or
 * null when the mapped key is sendable (backlog:9a853f44: a hand-written
 * service either books or is stopped here with a clear message — never a
 * 400 with «Riprova più tardi»). Empty stays null: a missing service is the
 * required-fields check's job, and the slot Conferma keeps its server
 * refusal for it. Pure and DOM-free, unit-tested without a browser.
 * @param {unknown} serviceKey the mapped claim value (serviceKeyFor first)
 */
export function servicePresendError(serviceKey) {
  if (typeof serviceKey !== 'string' || serviceKey === '') return null;
  if (BOOKING_SERVICE_KEY_RE.test(serviceKey)) return null;
  return 'Scegli un servizio dal listino: questo servizio non c’è.';
}

/**
 * The Italian sentence for a calendar refusal whose code names the cause
 * (production 07/11: a typed service fell to «Riprova più tardi», AI off
 * fell to «Ricerca non riuscita»). Null when the code is not one of these:
 * the caller keeps its generic sentence.
 * @param {unknown} error
 */
export function calendarRefusalText(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = record.code;
  // The pilot web refuses with its own code; the framework answers a
  // validation error naming the field.
  if (code === 'BO_APPOINTMENT_SERVICE_REFUSED' || record.details?.field === 'serviceKey') {
    return 'Scegli un servizio dal listino: questo servizio non c’è.';
  }
  // backlog:3771ac637027 (production 08/11): never «usa il modulo qui
  // sotto» — the manual form is closed until asked for. The card paints a
  // «Compila a mano» button beside these sentences (aiBlockOf).
  if (code === 'LLM_SPACE_DISABLED' || code === 'LLM_SECRET_UNAVAILABLE') {
    return 'AI spenta per questo spazio: puoi compilare l’appuntamento a mano.';
  }
  if (code === 'LLM_DAILY_CAP_EXCEEDED') {
    return 'Hai raggiunto il tetto di spesa AI di oggi: puoi compilare l’appuntamento a mano, o riprovare domani.';
  }
  return null;
}

/**
 * backlog:3771ac637027 — whether a phrase refusal blocks the AI for now:
 * 'off' (AI switched off or not configured for the space) or 'cap' (the
 * daily AI spend ceiling, 429). Both offer «Compila a mano»; null for any
 * other refusal.
 * @param {unknown} error
 * @returns {'off'|'cap'|null}
 */
export function aiBlockOf(error) {
  const code = error !== null && typeof error === 'object' ? /** @type {any} */ (error).code : null;
  if (code === 'LLM_SPACE_DISABLED' || code === 'LLM_SECRET_UNAVAILABLE') return 'off';
  if (code === 'LLM_DAILY_CAP_EXCEEDED') return 'cap';
  return null;
}

/**
 * backlog:d1e4d90e — resolve a phrase-drafted person against the known team:
 * the model answers a name («Marco»), the search needs booking identities.
 * An exact identity wins; then one display-name match (case-insensitive).
 * backlog:3ce220e6: same-named identities are one person row, so a shared
 * name resolves to every identity of that row; strangers resolve to
 * nothing — the caller keeps the drafted words on the outsider path.
 * @param {unknown} draftMember @param {unknown} named @param {unknown} members
 */
export function resolveDraftMemberIds(draftMember, named, members) {
  if (typeof draftMember !== 'string' || draftMember.trim() === '') return [];
  const rows = personRows(named, [], members);
  const exact = rows.find((row) => row.ids.includes(draftMember));
  if (exact) return [...exact.ids];
  const wanted = draftMember.trim().toLowerCase();
  const byName = rows.filter((row) => typeof row.name === 'string' && row.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return [...byName[0].ids];
  return [];
}

/**
 * backlog:d1e4d90e — keep phrase proposals bookable: begun steps are cut, so
 * a «45 minuti con Marco» search never proposes the past. Out-of-hours steps
 * stay, named below the grid by their honest lines (BO-F6-11 fetta 8, owner
 * 29/10) — only the past is unbookable for everyone.
 * @param {unknown} slots @param {number} [nowMs]
 */
export function filterPhraseProposals(slots, nowMs = Date.now()) {
  if (!Array.isArray(slots)) return [];
  return slots.filter((slot) => {
    const startMs = Date.parse(String(slot?.startsAt ?? ''));
    return Number.isFinite(startMs) && startMs >= nowMs;
  });
}

/**
 * backlog:d1e4d90e — rank phrase proposals so the painted hours win: the
 * night is always free, so the first free steps of the week are night steps
 * and a plain time order fills every proposal with the night. Steps inside
 * the 09:00–18:00 grid come first (in time order), out-of-hours steps after
 * (in time order, for the honest lines below the grid) — never dropped, only
 * ordered, so fetta 8 still names them.
 * @param {unknown} slots
 */
export function rankPhraseProposals(slots) {
  if (!Array.isArray(slots)) return [];
  return [...slots].sort((left, right) => {
    const leftIn = slotInGrid(left?.startsAt, left?.endsAt) ? 0 : 1;
    const rightIn = slotInGrid(right?.startsAt, right?.endsAt) ? 0 : 1;
    if (leftIn !== rightIn) return leftIn - rightIn;
    return String(left?.startsAt ?? '').localeCompare(String(right?.startsAt ?? ''));
  });
}

/**
 * backlog:d1e4d90e — one person's free steps across every booking identity
 * they hold: the server answers per identity, so a step the human holds
 * under one identity looks free under their other one. A step is offered
 * only when every searched identity reports it free — otherwise Conferma
 * would book the same human twice. A searched identity with no answer
 * group proves nothing, so its steps stay unoffered (fail closed). A
 * single searched identity keeps the plain union, exactly as before.
 * The offered step books the drafted identity when the draft named one of
 * the searched identities, else the first searched identity — deterministic,
 * never invented.
 * @param {unknown} groups @param {unknown} searchIds @param {unknown} member
 */
export function personFreeSlots(groups, searchIds, member) {
  const list = Array.isArray(groups) ? groups : [];
  const ids = Array.isArray(searchIds)
    ? searchIds.filter((id) => typeof id === 'string' && id !== '')
    : [];
  const valid = (slot) => slot
    && typeof slot.startsAt === 'string' && slot.startsAt !== ''
    && typeof slot.endsAt === 'string' && slot.endsAt !== '';
  const named = typeof member === 'string' && ids.includes(member) ? member : null;
  if (ids.length <= 1) {
    const kept = [];
    for (const group of list) {
      for (const slot of group?.slots ?? []) {
        if (!slot?.startsAt || !slot?.endsAt) continue;
        kept.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, teamMemberId: group?.teamMemberId ?? member });
      }
    }
    return kept;
  }
  const keyOf = (slot) => `${slot.startsAt} ${slot.endsAt}`;
  let common = null;
  for (const id of ids) {
    const group = list.find((entry) => entry?.teamMemberId === id);
    if (!group) return [];
    const keys = new Set((group.slots ?? []).filter(valid).map(keyOf));
    common = common === null ? keys : new Set([...common].filter((key) => keys.has(key)));
    if (common.size === 0) return [];
  }
  const first = list.find((entry) => entry?.teamMemberId === ids[0]);
  const bookAs = named ?? first?.teamMemberId ?? ids[0];
  const kept = [];
  for (const slot of first?.slots ?? []) {
    if (!valid(slot) || !common.has(keyOf(slot))) continue;
    kept.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, teamMemberId: bookAs });
  }
  return kept;
}

/** Statuses that no longer hold their slot, in the operator's words (C14: never English). */
const STATUS_WORDS = Object.freeze({ cancelled: 'annullato', done: 'svolto', 'no-show': 'non presentato' });

/**
 * backlog:5fbebe8559e9 (C14) — the Italian word of a row status that no
 * longer holds its slot; anything unknown reads «non attivo», never the raw
 * English value.
 * @param {unknown} status
 */
export function statusWord(status) {
  const key = String(status ?? '').trim().toLowerCase();
  return Object.hasOwn(STATUS_WORDS, key) ? STATUS_WORDS[key] : 'non attivo';
}

/**
 * backlog:5fbebe8559e9 — the service name of a booked row: the catalog
 * product name for its listino key when the catalog names it, else the key
 * itself made readable («lezione-prova» → «Lezione prova»), never the raw
 * slug. A row without a key reads «Appuntamento».
 * @param {unknown} serviceKey @param {Map<string, string> | null | undefined} names sku → name
 */
export function serviceLabel(serviceKey, names) {
  const key = typeof serviceKey === 'string' ? serviceKey.trim() : '';
  if (key === '') return 'Appuntamento';
  const named = names instanceof Map ? names.get(key.toLowerCase()) : undefined;
  if (typeof named === 'string' && named !== '') return named;
  const words = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words === '' ? 'Appuntamento' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * backlog:5fbebe8559e9 — a proposal never overlaps a booking the searched
 * person already holds in the painted week. The server answers free steps
 * per identity; this second check runs on the very rows the grid paints, so
 * a ghost can never sit on top of the person's own held block. Cancelled,
 * done and no-show rows free their time. Fail closed: a held row whose time
 * does not parse blocks nothing it cannot prove, a slot that does not parse
 * is dropped.
 * @param {unknown} slots @param {unknown} week team-week answer @param {unknown} searchIds
 */
export function dropHeldOverlaps(slots, week, searchIds) {
  if (!Array.isArray(slots)) return [];
  const ids = new Set(Array.isArray(searchIds) ? searchIds : []);
  /** @type {Array<[number, number]>} */
  const held = [];
  const groups = Array.isArray(/** @type {any} */ (week)?.members) ? /** @type {any} */ (week).members : [];
  for (const group of groups) {
    if (!ids.has(group?.teamMemberId)) continue;
    for (const row of group?.appointments ?? []) {
      const status = String(row?.status ?? 'booked');
      if (status !== 'booked' && status !== 'confirmed') continue;
      const from = Date.parse(String(row?.startsAt ?? ''));
      const to = Date.parse(String(row?.endsAt ?? ''));
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) held.push([from, to]);
    }
  }
  return slots.filter((slot) => {
    const from = Date.parse(String(slot?.startsAt ?? ''));
    const to = Date.parse(String(slot?.endsAt ?? ''));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
    return !held.some(([start, end]) => start < to && from < end);
  });
}

/**
 * Whether a loaded team week lists every searched identity, so the
 * held-overlap guard can read their bookings from it (review #657).
 * @param {any} week @param {Array<string>} searchIds
 */
export function weekCovers(week, searchIds) {
  const groups = Array.isArray(week?.members) ? week.members : null;
  if (!groups || !Array.isArray(searchIds) || searchIds.length === 0) return false;
  const listed = new Set(groups.map((group) => group?.teamMemberId));
  return searchIds.every((id) => listed.has(id));
}

/**
 * Overlap lanes per day column: blocks sharing grid rows split the column
 * width instead of painting over each other. Greedy by start time, keyed by
 * the row objects of this render pass, so every entry carries its lane and
 * the column lane count. Lanes follow the PAINTED half-hour rows, not the
 * exact minutes (backlog:5fbebe8559e9): a 10:00–10:45 booking and a
 * 10:45–11:30 proposal both cover the 10:30 row, so they sit side by side.
 * Events and «✦ Proposta» ghosts share one pass, so a ghost never covers a
 * booking or another ghost.
 * @param {Array<any>} rows
 * @returns {Map<any, {lane: number, lanes: number}>}
 */
export function lanesFor(rows) {
  const ordered = [...rows].sort((a, b) => (
    String(a?.startsAt ?? '').localeCompare(String(b?.startsAt ?? ''))
    || String(a?.endsAt ?? '').localeCompare(String(b?.endsAt ?? ''))
  ));
  /** @type {Array<number>} */
  const laneEnd = [];
  /** @type {Map<any, {lane: number, lanes: number}>} */
  const placed = new Map();
  for (const row of ordered) {
    const painted = gridRowsFor(row?.startsAt, row?.endsAt);
    const startMin = painted.row;
    const endMin = painted.row + painted.span;
    let lane = laneEnd.findIndex((end) => end <= startMin);
    if (lane === -1) {
      lane = laneEnd.length;
      laneEnd.push(endMin);
    } else {
      laneEnd[lane] = endMin;
    }
    placed.set(row, { lane, lanes: 0 });
  }
  const lanes = Math.max(1, laneEnd.length);
  for (const entry of placed.values()) entry.lanes = lanes;
  return placed;
}

/** @param {any} doc @param {string} tag @param {{text?: string, className?: string, attrs?: Record<string,string>}} [options] */
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * @param {{doc: any, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean) => void, storage?: any, now?: () => Date, navigate?: (hash: string) => void}} deps
 */
export function createCalendarioView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const storage = deps.storage ?? null;
  const clock = typeof deps.now === 'function' ? deps.now : () => new Date();
  // The phrase read-back pause (BO_PHRASE_PENDING): injectable so tests run
  // the wait loop without real time, like the composer's send wait.
  const wait = typeof deps.wait === 'function' ? deps.wait : unrefWait;
  /** Guards the phrase search and its read-back: a newer search or a route away stops the old one. */
  let phraseSeq = 0;
  let renderToken = 0;
  /** Guards the member-list read, like renderToken guards the week. */
  let memberToken = 0;
  /**
   * Drops a pending read (backlog:607f33ee): the view paints into the
   * shell's shared mount, so a late week response must not repaint a
   * screen the operator already left. The shell calls this on every route
   * that is not Calendario.
   */
  function invalidate() {
    renderToken += 1;
    phraseSeq += 1;
    // The search in flight is dropped with the route (review #664): the
    // card comes back idle, never wedged on «Sto cercando…».
    state.aiLoading = false;
    state.phraseWaiting = false;
    state.phrasePending = null;
    memberToken += 1;
    // A search pending or in flight dies with the route, like the week.
    cancelCustomerSearch();
    trackRetainedDraft();
  }

  /**
   * Retained user text (backlog:49bd3657b0f8): the view keeps what the
   * operator typed in module state across re-renders, so after the shell
   * routes away the DOM check would read a clean page while the draft
   * survives here. Mirror it into the bundle watch: a kept draft defers
   * the reload behind the notice instead of losing the text. Runs on
   * every repaint and on every route away, so the mark always matches
   * the state — set or cleared, never stale. The auto-filled roster
   * (autoTeam) is nobody's text and never counts; only what the operator
   * typed does.
   */
  function trackRetainedDraft() {
    const typedFilter = state.autoTeam === true ? '' : (state.memberFilter ?? '');
    const manualText = Object.values(state.manual ?? {})
      .some((value) => String(value ?? '') !== '');
    markUnsaved('calendario-draft',
      (state.phrase ?? '') !== ''
      || String(typedFilter) !== ''
      || (state.customerQuery ?? '') !== ''
      || manualText);
  }
  installOutsideCloser(doc);

  const readSpace = () => {
    try {
      const stored = storage !== null ? storage.getItem(ACTIVE_SPACE_KEY) : null;
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  };

  const state = {
    memberFilter: '',
    /** True while the filter holds the roster auto-fill nobody edited yet:
     * a later roster refusal clears it back to the honest prompt instead of
     * keeping names the space no longer lists. Any keystroke or toggle
     * click is the operator's own choice and clears it. */
    autoTeam: false,
    /** Deselected opaque member ids: their events stay loaded but hidden (C11). @type {Array<string>} */
    hiddenMembers: [],
    /** Organization team (`GET /api/spine/memberships` items), or null when
     * unread or refused: the card then keeps its typed-name fallback. @type {any} */
    members: null,
    /** Connected-calendar state from `GET /api/profile` (the same shape the
     * Profilo screen reads): null while unknown, else {connected}.
     * Only a positive `connected` calendar counts — anything else is the
     * honest "not connected" the week panel links to Profilo for. */
    calendar: null,
    weekKeys: openingWeekKeys(clock()),
    /** Selected event id: a block click opens the detail card (fetta 4). @type {string|null} */
    selectedId: null,
    /** Slot chosen on the grid by press-and-drag (Google/Apple style): `{key, start, end}` in Rome minutes. @type {any} */
    selection: null,
    /** Resolved customer display names by `resource:id`, null when the profile is unavailable. @type {Record<string, string|null>} */
    profiles: {},
    /** Catalog product names by lowercase listino key; undefined until read, an empty Map when unreadable. @type {Map<string, string> | null | undefined} */
    services: undefined,
    /** @type {any} */
    week: null,
    weekError: null,
    unavailable: false,
    /** Free-text phrase, kept in the AI card field across re-renders. */
    phrase: '',
    /** Week proposals from "Trova slot liberi": real free slots, never invented. @type {Array<any>} */
    proposals: [],
    /** The AI search is in flight: the button stays disabled, no jargon. */
    aiLoading: false,
    /** Latest AI card note: zero slots, missing person, confirm outcome. */
    aiNote: '',
    /** The spaces the server said have the AI off: the phrase box stays disabled there only. @type {Set<string>} */
    aiOff: new Set(),
    /** The last phrase refusal blocked the AI ('off' or 'cap'): the card offers «Compila a mano». @type {'off'|'cap'|null} */
    aiBlocked: null,
    /** The last phrase answer carried no draft: the card offers «Compila a mano» too. */
    phraseNoDraft: false,
    /** The space the view last rendered for, so a switch drops that space's search. @type {string|null} */
    renderedSpace: null,
    /** The phrase POST was queued and is being read back: the card says «Sto cercando…». */
    phraseWaiting: false,
    /** The queued phrase request still pending after the read-back, the phrase and the space that asked it, for Riprova (never a new POST). @type {{requestId: string, phrase: string, spaceId: string}|null} */
    phrasePending: null,
    /** Live manual form nodes, so a slot Conferma books the claim the operator sees. @type {any} */
    manualNodes: null,
    /** @type {any} */
    draft: null,
    draftNote: '',
    bookingNote: '',
    /** The service field's own refusal, painted under it (BO_APPOINTMENT_SERVICE_REFUSED). */
    serviceError: '',
    /** @type {any} */
    confirmed: null,
    /** Last manual form values, restored on every re-render. @type {any} */
    manual: null,
    /** The manual form shows once asked for, or once a draft or an edit fills it. */
    manualOpen: false,
    /** The member filter row, painted inside the Team card. @type {any} */
    filterRow: null,
    /** The painted manual form panel, opened in place by the menu voice. @type {any} */
    manualPanel: null,
    /** Draft absorbed into manual on submit. @type {any} */
    draftFill: null,
    /** Latest phrase input, so the "Crea con l'AI" voice can focus it. @type {any} */
    phraseInput: null,
    /** First manual-form field, so "Compila manualmente" can focus it. @type {any} */
    manualFirst: null,
    /** Manual booking customer picked by name, never typed as id: {resource, id, name} or null. @type {any} */
    customerPick: null,
    /** Live customer search text, kept across re-renders like the other edits. */
    customerQuery: '',
    /** Latest customer search results (`GET /api/customer-data/customers` items). @type {Array<any>} */
    customerItems: [],
    /** Customer search failure in the operator's own words, or null. @type {string|null} */
    customerError: null,
    /** The last customer search answer was read in part (complete:false). */
    customerPartial: false,
  };
  /** Guards the customer search, like renderToken guards the week. */
  let customerSeq = 0;
  /**
   * backlog:29bb3f2c0d64 (production 08/11): the customer search fired one
   * request per keystroke; on the small web instance they queued (about 30 s
   * on the first round, then 5 s each, against 0.5 s for one read alone).
   * Typing now waits SEARCH_DEBOUNCE_MS of quiet before one request, and a
   * newer keystroke aborts the request in flight. Injectable for tests
   * (0 searches at once, like before).
   */
  const searchDelayMs = Number.isInteger(deps.searchDelayMs) && deps.searchDelayMs >= 0
    ? deps.searchDelayMs
    : SEARCH_DEBOUNCE_MS;
  /** The pending debounce timer, or null. @type {any} */
  let customerTimer = null;
  /** The controller of the search request in flight, or null. @type {AbortController|null} */
  let customerAbort = null;

  /** Drops the pending and in-flight customer search: no stale answer paints. */
  function cancelCustomerSearch() {
    if (customerTimer !== null) {
      clearTimeout(customerTimer);
      customerTimer = null;
    }
    if (customerAbort !== null) {
      customerAbort.abort();
      customerAbort = null;
    }
    customerSeq += 1;
  }

  /** One keystroke in the customer search: debounce, then one request. @param {string} query */
  function scheduleCustomerSearch(query) {
    cancelCustomerSearch();
    const q = String(query ?? '').trim();
    // A cleared or too-short query answers at once: nothing is read for it.
    if (searchDelayMs === 0 || q.length < 2) {
      void searchCustomers(query);
      return;
    }
    customerTimer = setTimeout(() => {
      customerTimer = null;
      void searchCustomers(query);
    }, searchDelayMs);
  }

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message @param {{retry?: () => void}} [options] */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { className: 'panel' });
    box.appendChild(el(doc, 'p', { className: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { className: 'small secondary', text: 'Riprova' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  function shiftWeek(days) {
    const keys = state.weekKeys;
    if (keys.length === 0) return;
    const base = Date.parse(`${keys[0]}T12:00:00Z`);
    if (Number.isNaN(base)) return;
    const next = new Date(base + days * 24 * 3600 * 1000);
    state.weekKeys = romeWeekKeys(next);
    state.week = null;
    // A moved week drops its proposals: ghosts belong to the searched week.
    state.proposals = [];
    state.aiNote = '';
    // The pager moves the window but keeps the named members: reload for
    // them like the "Oggi" button does, so browsing never drops back to the
    // "name someone" prompt mid-week.
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0) void loadWeek(members);
    else renderAll();
  }

  /** @param {Array<string>} members */
  async function loadWeek(members) {
    const token = ++renderToken;
    const window = weekWindow(state.weekKeys);
    if (!window) {
      state.weekError = 'Settimana non valida.';
      return;
    }
    try {
      // One row per person, every identity of each listed person: the roster
      // may name sibling subjects after the filter was set (or the filter
      // names a subset), and the merged row must show the whole person's
      // week — never the filter subset only. The typed filter stays
      // untouched: only the request widens to the listed rows' subjects.
      const listedIds = personRows(members, [], state.members)
        .filter((row) => row.listed)
        .flatMap((row) => row.ids);
      const expanded = [...members, ...listedIds.filter((id) => !members.includes(id))];
      const week = await client.request(
        `/api/appointments/team-week?teamMemberIds=${encodeURIComponent(expanded.join(','))}`
        + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
      );
      if (token !== renderToken) return;
      state.week = week;
      state.weekError = null;
      state.unavailable = false;
      // A reloaded week drops deselections nobody named anymore: toggling a
      // ghost would filter nothing and confuse the next render. A hidden
      // sibling of a listed person stays hidden with its row — pruning to
      // the raw filter would resurrect half a hidden person. A selection
      // whose member stays hidden loses its detail card with the reload.
      state.hiddenMembers = state.hiddenMembers.filter((id) => expanded.includes(id));
      if (state.selectedId !== null) {
        const reselected = selectedRow();
        if (reselected && state.hiddenMembers.includes(String(reselected.teamMemberId ?? ''))) state.selectedId = null;
      }
    } catch (error) {
      if (token !== renderToken) return;
      if (error?.code === 'NOT_FOUND' || error?.status === 404) {
        state.unavailable = true;
        state.week = null;
        state.weekError = null;
      } else {
        state.weekError = humanReadError(error, {
          failed: 'La settimana non si è potuta leggere. Riprova più tardi.',
        });
      }
    }
    // Same mount guard as the roster and profile reads below: a late week
    // answer never paints over another screen sharing the mount
    // (backlog:607f33ee).
    if (mount.querySelector('.cal-wrap') !== null) {
      renderAll();
      void loadWeekLabels(token);
    }
  }

  /**
   * backlog:5fbebe8559e9 — the names a block title needs: the catalog
   * service names (read once per view) and the customer name of every linked
   * row in the loaded week (one read-only profile per customer, cached by
   * key, capped). One repaint when they settle, only while this week is
   * still the painted one; until then the block paints the readable key.
   * @param {number} token
   */
  async function loadWeekLabels(token) {
    const pending = [];
    if (state.services === undefined) {
      state.services = null;
      pending.push(ensureServices());
    }
    let reads = 0;
    for (const group of state.week?.members ?? []) {
      for (const row of group?.appointments ?? []) {
        const linked = subjectKeyOf(row);
        if (!linked || linked.key in state.profiles || reads >= WEEK_PROFILE_READS) continue;
        reads += 1;
        state.profiles[linked.key] = null;
        pending.push(fetchSubjectName(linked));
      }
    }
    if (pending.length === 0) return;
    await Promise.all(pending);
    if (token !== renderToken) return;
    if (mount.querySelector('.cal-wrap') !== null) renderAll();
  }

  /** The catalog read in flight, shared so a booking and the week labels read it once. @type {Promise<void>|null} */
  let servicesRead = null;
  /**
   * The catalog names a booking needs to turn a typed product name into its
   * listino key (review #657: a Conferma racing the first catalog read sent
   * the raw name and was refused). Resolves at once once the catalog is read.
   */
  function ensureServices() {
    if (state.services instanceof Map) return Promise.resolve();
    if (servicesRead === null) {
      servicesRead = loadServices().finally(() => { servicesRead = null; });
    }
    return servicesRead;
  }

  /** Catalog product names for the block titles; fail-soft to the readable key. */
  async function loadServices() {
    /** @type {Map<string, string>} */
    const names = new Map();
    /** @type {Array<{key: string, name: string, priceCents: number, currency: string}>} */
    let bookable = [];
    try {
      const answer = await client.request('/api/catalog/products?limit=200');
      for (const product of Array.isArray(answer?.products) ? answer.products : []) {
        const sku = typeof product?.sku === 'string' ? product.sku.trim().toLowerCase() : '';
        const name = typeof product?.name === 'string' ? product.name.trim() : '';
        if (sku !== '' && name !== '' && !names.has(sku)) names.set(sku, name);
      }
      // The manual form's service menu (backlog:810ed0bf): the same
      // singles rule the booking worker applies, read once with the names.
      bookable = catalogBookingServices(answer);
    } catch (error) {
      // No catalog in this project (or a stale bundle): the readable key
      // stays. Anything else is unexpected and logged without the message.
      if (!isNotComposedFailure(error) && !isUnsupportedContractFailure(error)) {
        console.warn(
          'bo-calendario catalog unreadable:',
          error instanceof Error ? error.name : (error?.code ?? 'unknown'),
          `spaceId=${readSpace()}`,
        );
      }
    }
    state.services = names;
    state.catalogServices = bookable;
    // The service menu paints from this read: repaint once it settles while
    // the calendar is still mounted (same guard as the roster read).
    if (mount.querySelector('.cal-wrap') !== null) renderAll();
  }

  /**
   * The organization team behind the Team card (specs/calendario.md C10):
   * one toggle row per member with its Italian role, only when the server
   * names a list. Any refusal — forbidden, uncomposed spine, network fault —
   * keeps `members` null, so the card falls back to its opaque named
   * toggles: no error where the week should be, no invented roster, and the
   * same fallback the Spazi e accessi screen states in words. A late answer
   * repaints only while the calendar is still mounted (same guard as the
   * profile read below).
   */
  /**
   * The connected-calendar state behind the week (backlog:0533362e8efe):
   * the same `GET /api/profile` answer the Profilo screen reads, reduced
   * to the calendar connector. Only status `connected` counts — a revoked,
   * error or missing calendar is "not connected", and an unreadable profile
   * stays unknown (null): the week keeps its old behavior instead of
   * crying wolf about a link the operator may already have.
   */
  async function loadCalendar() {
    try {
      const answer = await client.request('/api/profile');
      const items = answer?.connections?.available === true && Array.isArray(answer.connections.items)
        ? answer.connections.items
        : null;
      const calendar = Array.isArray(items)
        ? items.find((entry) => entry && entry.connector === 'calendar')
        : null;
      // Only the connector status travels: the account is the Profilo
      // screen's own line, and this panel never prints provider data.
      state.calendar = items === null ? null : { connected: calendar?.status === 'connected' };
    } catch {
      state.calendar = null;
    }
    if (mount.querySelector('.cal-wrap') !== null) renderAll();
  }

  async function loadMembers() {
    const token = ++memberToken;
    try {
      const answer = await client.request('/api/spine/memberships');
      if (token !== memberToken) return;
      state.members = Array.isArray(answer?.items) ? answer.items : [];
      // The roster is the team: with nobody named yet, list the whole
      // space and load its week at once — no typing (backlog:0533362e8efe).
      // A named filter is the operator's own choice and is never overwritten.
      const subjects = state.members
        .filter((member) => member && typeof member.subject === 'string' && member.subject !== '')
        .map((member) => member.subject);
      if (!state.autoTeam && parseMemberFilter(state.memberFilter).length === 0 && subjects.length > 0) {
        state.memberFilter = [...new Set(subjects)].join(', ');
        state.autoTeam = true;
        if (mount.querySelector('.cal-wrap') !== null) renderAll();
        void loadWeek([...new Set(subjects)]);
        return;
      }
    } catch (error) {
      if (token !== memberToken) return;
      // Fail-soft UI, but a failure nobody can diagnose blocks review
      // (AGENTS.md): record the sanitized cause with the active space —
      // never the message or personal data, like the profile read below.
      // A refused list (403) or an uncomposed spine (404) is an expected
      // absence, not a fault: silent.
      const refused = error?.code === 'SPINE_MEMBERSHIP_FORBIDDEN' || error?.status === 403;
      if (!refused && !isNotComposedFailure(error) && !isUnsupportedContractFailure(error)) {
        console.warn(
          'bo-calendario members unreadable:',
          error instanceof Error ? error.name : (error?.code ?? 'unknown'),
          `spaceId=${readSpace()}`,
        );
      }
      // A failed reload repaints too: without it the card would keep
      // showing the previous roster and its Italian roles instead of
      // falling back to the named toggles (same mount guard as
      // the success path, so a late answer never paints over another
      // screen sharing the mount). An auto-filled roster is not the
      // operator's choice: it clears back to the honest prompt, while a
      // typed filter stays — the operator named those people themselves.
      state.members = null;
      if (state.autoTeam) {
        state.memberFilter = '';
        state.autoTeam = false;
      }
      if (mount.querySelector('.cal-wrap') !== null) renderAll();
      return;
    }
    if (mount.querySelector('.cal-wrap') !== null) renderAll();
  }

  /** The selected row, when it is still in the loaded week. */
  function selectedRow() {
    if (state.selectedId === null || !state.week) return null;
    for (const group of state.week?.members ?? []) {
      for (const row of group?.appointments ?? []) {
        if (row && String(row.id ?? '') === state.selectedId) {
          return { ...row, teamMemberId: group.teamMemberId };
        }
      }
    }
    return null;
  }

  /**
   * backlog:739c0c81f55c — the field the operator is typing in, before a
   * repaint replaces it. Late reads (roster, week, labels, profile) repaint
   * the whole view, and a replaced node loses focus and caret: the next
   * keystrokes landed on the page and the phrase looked wiped (production
   * 08/11). Every typed control carries a `name`, so the new node is found
   * by it. Null when focus is outside the view or on a non-text control.
   */
  function focusedField() {
    const active = doc?.activeElement ?? null;
    if (!active || typeof mount.contains !== 'function' || !mount.contains(active)) return null;
    const tag = String(active.tagName ?? '').toLowerCase();
    if (tag !== 'textarea' && tag !== 'input' && tag !== 'select') return null;
    const name = typeof active.getAttribute === 'function' ? active.getAttribute('name') : null;
    if (typeof name !== 'string' || name === '' || !/^[A-Za-z0-9_-]+$/.test(name)) return null;
    let start = null;
    let end = null;
    let direction = null;
    try {
      // Some input types (date, number) have no text selection: null, or a
      // throw on older engines — focus is restored either way.
      start = typeof active.selectionStart === 'number' ? active.selectionStart : null;
      end = typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
      direction = typeof active.selectionDirection === 'string' ? active.selectionDirection : null;
    } catch {
      start = null;
      end = null;
    }
    return { tag, name, start, end, direction };
  }

  /**
   * Puts focus and caret back on the repainted field the operator was
   * typing in. The value itself already survives through state (every
   * typed field writes it on input). A field the repaint dropped, or one
   * now disabled, stays unfocused.
   * @param {{tag: string, name: string, start: number|null, end: number|null, direction: string|null} | null} kept
   */
  function restoreField(kept) {
    if (kept === null) return;
    const node = mount.querySelector(`${kept.tag}[name="${kept.name}"]`);
    if (!node || typeof node.focus !== 'function') return;
    if (node.disabled === true || (typeof node.getAttribute === 'function' && node.getAttribute('disabled') !== null)) return;
    node.focus();
    if (kept.start === null || kept.end === null) return;
    const length = String(node.value ?? '').length;
    const start = Math.min(kept.start, length);
    const end = Math.min(kept.end, length);
    try {
      if (typeof node.setSelectionRange === 'function') node.setSelectionRange(start, end, kept.direction ?? undefined);
      else {
        node.selectionStart = start;
        node.selectionEnd = end;
      }
    } catch {
      // A control without a text selection keeps the focus only.
    }
  }

  function renderAll() {
    const kept = focusedField();
    renderView();
    restoreField(kept);
  }

  function renderView() {
    clear();
    const wrap = el(doc, 'div', { className: 'cal-wrap' });
    wrap.appendChild(renderHeader());
    if (state.unavailable) {
      const box = el(doc, 'div', { className: 'panel' });
      box.appendChild(el(doc, 'p', {
        className: 'empty',
        text: 'Il calendario non è composto in questo spazio: nessun pacchetto appointments, nessuna settimana da mostrare.',
      }));
      wrap.appendChild(box);
      mount.appendChild(wrap);
      trackRetainedDraft();
      return;
    }
    // BO-F6-11 fetta 4 (specs/calendario.md C6): the detail card paints above
    // the grid while a block stays selected. Fetta 6 seats the Team toggles
    // between the detail and the grid they filter; fetta 7 adds the honest
    // booking card at the rail end (its final left-column home lands with
    // the responsive pass, fetta 8).
    // Supervisor design pass: the prototype's two columns — a 300 px rail
    // (selected block, phrase, team, manual form when asked) beside the grid.
    const layout = el(doc, 'div', { className: 'cal-layout' });
    const rail = el(doc, 'div', { className: 'cal-rail' });
    const main = el(doc, 'div', { className: 'cal-main' });
    const selected = selectedRow();
    if (selected) rail.appendChild(renderDetailCard(selected));
    else state.selectedId = null;
    rail.appendChild(renderAi());
    rail.appendChild(renderTeam());
    if (!state.selection) rail.appendChild(renderManual());
    rail.appendChild(renderBooking());
    main.appendChild(renderWeek());
    let pop = null;
    if (state.selection) {
      // The form opens beside the chosen block, like a calendar app; × or
      // Esc closes it and the rail form comes back.
      pop = el(doc, 'div', { className: 'cal-pop', attrs: { role: 'dialog', 'aria-label': 'Nuovo appuntamento' } });
      const close = el(doc, 'button', { className: 'cal-pop-close', text: '×', attrs: { type: 'button', 'aria-label': 'Chiudi' } });
      close.addEventListener('click', () => closeSlot());
      pop.appendChild(close);
      pop.appendChild(renderManual());
      pop.addEventListener?.('keydown', (event) => { if (event.key === 'Escape') closeSlot(); });
      main.appendChild(pop);
    }
    layout.appendChild(rail);
    layout.appendChild(main);
    wrap.appendChild(layout);
    mount.appendChild(wrap);
    if (pop) placePopover(main, pop);
    trackRetainedDraft();
  }

  /** Seats the popover beside the pick: right of it, or left on the last columns. */
  function placePopover(main, pop) {
    const pick = main.querySelector?.('[data-role="slot-pick"]');
    if (!pick || typeof pick.getBoundingClientRect !== 'function' || typeof main.getBoundingClientRect !== 'function') return;
    const box = main.getBoundingClientRect();
    const at = pick.getBoundingClientRect();
    const width = 340;
    const right = at.right - box.left + 12;
    const left = right + width > box.width ? Math.max(0, at.left - box.left - width - 12) : right;
    const top = Math.max(0, Math.min(at.top - box.top, box.height - 120));
    pop.setAttribute('style', `left: ${Math.round(left)}px; top: ${Math.round(top)}px`);
  }

  /**
   * BO-F6-11 fetta 2 (specs/calendario.md C3): the "Nuovo appuntamento" menu.
   * The dropdown mechanics reuse the shared shell pattern (the same classes
   * as the clienti menus, no new CSS): a relative wrap, an absolutely
   * positioned menu, `hidden` to close. Every voice carries only system
   * classes through `el` normalization; subtitles reuse `ui-hint`.
   */
  function renderNewMenu() {
    const wrap = el(doc, 'div', { className: 'bo-clienti-menuwrap' });
    const toggle = uiButton(doc, {
      variant: 'cta',
      small: true,
      label: 'Nuovo appuntamento ▾',
      attrs: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    });
    const menu = el(doc, 'div', { className: 'bo-clienti-menu ui-add-menu hidden' });
    menu.setAttribute('role', 'menu');
    /** @type {{ wrap: any, close: () => void }} */
    const handle = { wrap, close: () => {} };
    const close = () => {
      menu.classList.toggle('hidden', true);
      toggle.setAttribute('aria-expanded', 'false');
      if (openMenu === handle) openMenu = null;
    };
    handle.close = close;
    const open = () => {
      if (openMenu && openMenu !== handle) openMenu.close();
      menu.classList.toggle('hidden', false);
      toggle.setAttribute('aria-expanded', 'true');
      openMenu = handle;
    };
    toggle.addEventListener('click', () => {
      if (menu.classList.contains('hidden')) open();
      else close();
    });
    wrap.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape' || event?.key === 'Esc') {
        close();
        if (typeof toggle.focus === 'function') toggle.focus();
      }
    });
    const voices = [
      {
        title: "Crea con l'AI",
        sub: "Trovo gli slot liberi e invio l'invito",
        focus: () => state.phraseInput,
      },
      {
        title: 'Compila manualmente',
        sub: 'Giorno, ora, cliente e partecipanti',
        focus: () => {
          // Open the painted form in place: a re-render would swap the
          // field the operator is about to type in.
          state.manualOpen = true;
          state.manualPanel?.classList?.add('open');
          return state.manualFirst;
        },
      },
    ];
    for (const voice of voices) {
      const item = uiAddOption(doc, { kind: voice.title === 'Compila manualmente' ? 'manual' : 'ai',
        title: voice.title, line: voice.sub });
      item.addEventListener('click', () => {
        close();
        const target = voice.focus();
        if (target && typeof target.focus === 'function') target.focus();
        if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView();
      });
      menu.appendChild(item);
    }
    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    return wrap;
  }

  function renderHeader() {
    const head = el(doc, 'div', { className: 'panel-heading cal-page-head' });
    const titleBox = el(doc, 'div');
    // BO-F6-11 fetta 2 (specs/calendario.md C1): fixed page chrome — the
    // eyebrow and title never carry data. The lede stays because the
    // bo:shots probe reads the pinned week from it (`.cal-wrap .lede`).
    // Fetta 4: the label names the painted work week (Mon..Fri), not the
    // loaded seven days.
    titleBox.appendChild(el(doc, 'p', { className: 'eyebrow', text: 'Calendario condiviso' }));
    titleBox.appendChild(el(doc, 'h2', { className: 'cal-page-title', text: 'Agenda del team' }));
    const label = weekLabel(displayKeys(state.weekKeys));
    if (label) titleBox.appendChild(el(doc, 'p', { className: 'lede', text: `La settimana del team · ${label}` }));
    head.appendChild(titleBox);
    const nav = el(doc, 'div', { className: 'actions' });
    // BO-F6-11 fetta 2 (C2): ‹ interval › Oggi Nuovo-appuntamento, in order.
    const prev = el(doc, 'button', {
      className: 'secondary small',
      text: '‹',
      attrs: { type: 'button', 'aria-label': 'Settimana prima', title: 'Settimana prima' },
    });
    prev.addEventListener('click', () => shiftWeek(-7));
    const interval = el(doc, 'span', { attrs: { 'data-role': 'week-interval' }, text: label ?? '' });
    const next = el(doc, 'button', {
      className: 'secondary small',
      text: '›',
      attrs: { type: 'button', 'aria-label': 'Settimana dopo', title: 'Settimana dopo' },
    });
    next.addEventListener('click', () => shiftWeek(7));
    const today = el(doc, 'button', { className: 'secondary small', text: 'Oggi', attrs: { type: 'button' } });
    today.addEventListener('click', () => {
      state.weekKeys = openingWeekKeys(clock());
      state.week = null;
      state.proposals = [];
      state.aiNote = '';
      const members = parseMemberFilter(state.memberFilter);
      if (members.length > 0) void loadWeek(members);
      else renderAll();
    });
    nav.appendChild(prev);
    nav.appendChild(interval);
    nav.appendChild(next);
    nav.appendChild(today);
    nav.appendChild(renderNewMenu());
    head.appendChild(nav);
    // The team comes from the space roster when it is known
    // (backlog:0533362e8efe): no text field, the toggles below are the
    // team. The typed filter stays only while the roster is unread —
    // the fallback that keeps the week reachable when the list refuses.
    const filterRow = el(doc, 'div', { className: 'cal-filter' });
    if (state.members === null) {
      const input = el(doc, 'input', { attrs: { type: 'text', name: 'members', placeholder: 'Persone del team: marco, sara' } });
      input.value = state.memberFilter;
      input.addEventListener('input', () => {
        state.memberFilter = String(input.value ?? '');
        state.autoTeam = false;
      });
      const show = el(doc, 'button', { className: 'primary small', text: 'Mostra settimana' });
      show.addEventListener('click', () => {
        state.memberFilter = String(input.value ?? '');
        state.autoTeam = false;
        const members = parseMemberFilter(state.memberFilter);
        if (members.length === 0) {
          state.week = null;
          state.weekError = 'Indica almeno una persona del team: la settimana di nessuno resterebbe vuota.';
          renderAll();
          return;
        }
        void loadWeek(members);
      });
      filterRow.appendChild(input);
      filterRow.appendChild(show);
    }
    state.filterRow = filterRow;
    const box = el(doc, 'div');
    box.appendChild(head);
    return box;
  }

  /** Group the loaded week rows by Rome day key, in work-week order (Mon..Fri). */
  function weekColumns() {
    /** @type {Map<string, Array<any>>} */
    const byDay = new Map(displayKeys(state.weekKeys).map((key) => [key, []]));
    const hidden = new Set(state.hiddenMembers);
    for (const group of state.week?.members ?? []) {
      // C11: a deselected member's events stay loaded but paint nothing —
      // reselecting shows them again with no reload.
      if (hidden.has(group?.teamMemberId)) continue;
      for (const row of group?.appointments ?? []) {
        const key = romeDayKey(row.startsAt);
        if (key !== null && byDay.has(key)) byDay.get(key).push({ ...row, teamMemberId: group.teamMemberId });
      }
    }
    for (const rows of byDay.values()) {
      rows.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    }
    return [...byDay.entries()];
  }

  /**
   * backlog:df55cf25 (specs/calendario.md C10, C11): the Team card — one
   * toggle row per PERSON, never a technical id. Each row paints the person
   * name (displayName, mailbox, or the operator's own typed words), tinted
   * and initialled to match its grid blocks. No role line: the E2E takes
   * the «Proprietario» chip out of the card (roles live on in Spazi e
   * accessi). A click on a listed person hides all of their identities'
   * blocks (C11) with no reload; a click on a roster person nobody named yet
   * lists all of their subjects and loads their week instead of typing
   * blind. Hiding the selected block's member closes the detail card, since
   * its selection border is gone. Every row is a button, so the raw-control
   * walk stays green.
   */
  function renderTeam() {
    const panel = el(doc, 'div', { className: 'panel cal-team' });
    panel.appendChild(el(doc, 'h2', { text: 'Team' }));
    if (state.filterRow) panel.appendChild(state.filterRow);
    const named = parseMemberFilter(state.memberFilter);
    const rows = personRows(named, state.hiddenMembers, state.members);
    if (rows.length === 0) {
      panel.appendChild(el(doc, 'p', {
        className: 'empty',
        text: state.members === null
          ? 'Nomina le persone del team sopra: qui compaiono come interruttori per filtrare la settimana.'
          : 'Nello spazio non risulta ancora nessuna persona: quando il titolare invita il team, la settimana si riempie da sé.',
      }));
      return panel;
    }
    for (const row of rows) {
      const toggle = el(doc, 'button', {
        className: 'secondary small',
        attrs: {
          type: 'button',
          'aria-pressed': row.active ? 'true' : 'false',
          title: row.listed
            ? (row.active ? `Nascondi ${row.label} dalla settimana` : `Mostra ${row.label} nella settimana`)
            : `Mostra ${row.label} nella settimana`,
        },
      });
      const box = el(doc, 'span', { className: `cal-m${row.color}`, attrs: { 'aria-hidden': 'true' }, text: row.active ? '✓' : '' });
      toggle.appendChild(box);
      toggle.appendChild(el(doc, 'span', { className: `cal-m${row.color}`, attrs: { 'aria-hidden': 'true' }, text: row.initials }));
      toggle.appendChild(el(doc, 'span', { text: row.label }));
      // One row per person, every identity visible inside it (backlog:3ce220e6):
      // the badges name each booked identity behind the row, never a pipe id.
      if (row.identities.length > 1) {
        for (const identity of row.identities) {
          toggle.appendChild(el(doc, 'span', { className: 'badge', attrs: { 'aria-hidden': 'true' }, text: identity }));
        }
      }
      toggle.addEventListener('click', () => {
        // A toggle click is the operator's own choice: the roster auto-fill
        // no longer owns the filter from here on.
        state.autoTeam = false;
        const current = parseMemberFilter(state.memberFilter);
        if (!row.listed) {
          // A roster person nobody named yet: list all of their subjects and
          // load their week, like «Mostra settimana» does for typed names.
          // Only a fully-unlisted row takes this path — a listed row (even
          // partially listed) hides or shows with no reload below.
          state.memberFilter = [...current, ...row.ids.filter((id) => !current.includes(id))].join(', ');
          state.hiddenMembers = state.hiddenMembers.filter((id) => !row.ids.includes(id));
          const next = parseMemberFilter(state.memberFilter);
          if (next.length > 0) void loadWeek(next);
          else renderAll();
          return;
        }
        const hidden = new Set(state.hiddenMembers);
        if (row.active) {
          for (const id of row.ids) hidden.add(id);
          // A hidden selection has no visible border: close its detail card.
          const selected = selectedRow();
          if (selected && row.ids.includes(String(selected.teamMemberId ?? ''))) state.selectedId = null;
        } else {
          for (const id of row.ids) hidden.delete(id);
        }
        state.hiddenMembers = [...hidden];
        renderAll();
      });
      panel.appendChild(toggle);
    }
    return panel;
  }

  /**
   * BO-F6-11 fetta 7 (specs/calendario.md C12): the «Prenotazione online»
   * card — the prototype's title and fixed line, nothing else invented. The
   * package books from an online link token (`bookFromLink`) but nothing
   * issues or publishes `accordo.dev/p/<slug>` to /bo, and the space id is
   * opaque: so no URL is guessed and no `Copia` paints with nothing to copy
   * (a fake copy button would be a control without a function). When a link
   * source exists the card will show the link beside a `Copia` button; until
   * then the honest Italian line below states it. Every booking made from a
   * link lands on the customer card through the booking's subject, like the
   * manual form's bookings do.
   */
  function renderBooking() {
    const panel = el(doc, 'div', { className: 'panel cal-booking' });
    panel.appendChild(el(doc, 'h2', { text: 'Prenotazione online' }));
    panel.appendChild(el(doc, 'p', {
      text: 'I clienti vedono solo gli slot liberi del team. Ogni prenotazione finisce nella loro scheda.',
    }));
    panel.appendChild(el(doc, 'p', {
      className: 'empty',
      text: 'Il link pubblico non è configurato per questo spazio.',
    }));
    return panel;
  }

  /**
   * BO-F6-11 fetta 4 (specs/calendario.md C13–C16): the prototype time grid —
   * an 09:00–18:00 hour gutter beside five work-day columns, event blocks on
   * their Rome half-hour rows, the red now-line on the current day. Empty
   * days paint their empty timeline, never a message. DOM order interleaves
   * each day head with its column, so the narrow-screen stack (heads above
   * their day, hours hidden) needs no extra markup.
   */
  /**
   * The connect notice (backlog:0533362e8efe): with no calendar connected
   * the page says so in plain words and points at Profilo — the only place
   * a connection is made — instead of leaving an empty week. It paints
   * above the grid whenever the profile positively reports no connection;
   * an unreadable profile stays silent (unknown is not "not connected").
   */
  function renderConnectNotice() {
    if (state.calendar === null || state.calendar.connected) return null;
    const notice = el(doc, 'div', { className: 'notice' });
    notice.appendChild(el(doc, 'p', {
      text: 'Il calendario di Google non è collegato: la settimana mostra solo gli appuntamenti presi qui. Collegalo dal Profilo per vedere anche quelli del calendario.',
    }));
    const go = uiButton(doc, {
      variant: 'secondary', small: true, label: 'Vai al Profilo',
      attrs: { type: 'button' },
    });
    go.addEventListener('click', () => navigate('#/profilo'));
    notice.appendChild(go);
    return notice;
  }

  /** «HH:MM» for minutes after midnight. */
  function minutesLabel(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  /** The half-hour row under a pointer, as Rome minutes clamped to the grid body. */
  function minuteAt(col, event) {
    const rect = typeof col.getBoundingClientRect === 'function' ? col.getBoundingClientRect() : null;
    if (!rect || !(rect.height > 0)) return null;
    const fraction = Math.min(Math.max((Number(event.clientY) - rect.top) / rect.height, 0), 0.9999);
    return GRID_START_MINUTES + Math.floor(fraction * GRID_ROWS) * GRID_SLOT_MINUTES;
  }

  /** Opens the manual form for a slot chosen on the grid. */
  function openSlot(key, start, end) {
    state.selection = { key, start, end };
    state.selectedId = null;
    state.manual = { ...(state.manual ?? {}), date: key, start: minutesLabel(start), end: minutesLabel(end) };
    state.manualOpen = true;
    renderAll();
    state.manualFirst?.focus?.();
  }

  /**
   * «+ Prenota» on a compact empty day (phone, backlog:5fbebe8559e9): the
   * manual form opens on that day, with the time left to the operator —
   * never an invented hour.
   * @param {string} key
   */
  function bookDay(key) {
    state.selection = null;
    state.selectedId = null;
    // Review #646 P1: the day is the only thing «+ Prenota» chooses. Times
    // from an earlier slot or phrase draft are dropped (never booked on the
    // wrong hour), and a pending phrase draft keeps only its person, service
    // and note — its own day and time would overwrite the tapped day.
    const pending = state.draftFill;
    state.draftFill = null;
    const kept = { ...(state.manual ?? {}) };
    if (pending) {
      if (typeof pending.teamMemberId === 'string' && pending.teamMemberId !== '') kept.teamMemberId = pending.teamMemberId;
      if (typeof pending.serviceKey === 'string' && pending.serviceKey !== '') kept.serviceKey = pending.serviceKey;
      if (typeof pending.notes === 'string' && pending.notes !== '') kept.notes = pending.notes;
    }
    state.manual = { ...kept, date: key, start: '', end: '' };
    state.manualOpen = true;
    renderAll();
    state.manualFirst?.focus?.();
  }

  function closeSlot() {
    if (!state.selection) return;
    state.selection = null;
    renderAll();
  }

  /**
   * Press-and-drag on a day column: the live block follows the pointer in
   * half hours; release opens the form. Presses on an event, a ghost or the
   * pick itself keep their own click.
   * @param {any} col @param {string} key
   */
  function bindSlotDrag(col, key) {
    if (typeof col.addEventListener !== 'function') return;
    let drag = null;
    const paint = () => {
      if (!drag) return;
      const start = Math.min(drag.anchor, drag.current);
      const end = Math.max(drag.anchor, drag.current) + GRID_SLOT_MINUTES;
      drag.node.setAttribute('style', `grid-row: ${(start - GRID_START_MINUTES) / GRID_SLOT_MINUTES + 1} / span ${(end - start) / GRID_SLOT_MINUTES}; grid-column: 1 / -1`);
      drag.node.textContent = `${minutesLabel(start)}–${minutesLabel(end)}`;
    };
    col.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target?.closest?.('.cal-event, .bo-add-button, .cal-pick')) return;
      const minute = minuteAt(col, event);
      if (minute === null) return;
      event.preventDefault?.();
      const node = el(doc, 'div', { className: 'cal-pick is-dragging', attrs: { 'aria-hidden': 'true' } });
      col.appendChild(node);
      drag = { anchor: minute, current: minute, node };
      col.setPointerCapture?.(event.pointerId);
      paint();
    });
    col.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const minute = minuteAt(col, event);
      if (minute === null || minute === drag.current) return;
      drag.current = minute;
      paint();
    });
    col.addEventListener('pointerup', () => {
      if (!drag) return;
      const start = Math.min(drag.anchor, drag.current);
      const end = Math.max(drag.anchor, drag.current) + GRID_SLOT_MINUTES;
      drag = null;
      openSlot(key, start, end);
    });
    col.addEventListener('pointercancel', () => { drag?.node?.remove?.(); drag = null; });
  }

  function renderWeek() {
    const panel = el(doc, 'div', { className: 'panel cal-week' });
    panel.appendChild(el(doc, 'h2', { text: 'Settimana del team' }));
    const notice = renderConnectNotice();
    if (notice) panel.appendChild(notice);
    if (state.weekError) {
      panel.appendChild(el(doc, 'p', { className: 'empty', text: state.weekError }));
      return panel;
    }
    if (!state.week) {
      // backlog:29bb3f2c0d64: with nobody to show (a space with no people
      // yet, or no names while the roster is unread) the week still paints
      // its empty grid, like the prototype, with one honest line above it —
      // never a bare message where the calendar should be. Nothing is read
      // for nobody: the grid is empty because no week was asked.
      // A known roster with people means their week is on its way (the
      // roster auto-fills the team): no line, the grid fills when it lands.
      const roster = Array.isArray(state.members) ? personRows([], [], state.members) : null;
      const line = roster === null
        ? 'Scegli le persone del team e premi «Mostra settimana»: niente settimana senza nomi, mai quella di tutti.'
        : (roster.length === 0
          ? 'Nello spazio non c’è ancora nessuna persona: la settimana resta vuota finché il titolare non invita il team.'
          : '');
      if (line !== '') panel.appendChild(el(doc, 'p', { className: 'empty cal-week-empty', text: line }));
    }
    const grid = el(doc, 'div', { className: 'cal-grid' });
    grid.appendChild(el(doc, 'div', { className: 'cal-corner', attrs: { 'aria-hidden': 'true' } }));
    for (let hour = GRID_START_MINUTES / 60; hour <= GRID_END_MINUTES / 60; hour += 1) {
      const label = el(doc, 'div', {
        className: 'cal-hour',
        attrs: { 'aria-hidden': 'true', style: `grid-row: ${(hour - 9) * 2 + 2} / span 2` },
        text: `${String(hour).padStart(2, '0')}:00`,
      });
      grid.appendChild(label);
    }
    // Today in Rome, once per render: heads and the now-line share it.
    const now = clock();
    const nowMin = romeMinutes(now);
    const columns = weekColumns();
    /** Rome days holding any loaded booking, hidden people included. */
    const heldDays = new Set();
    for (const group of state.week?.members ?? []) {
      for (const row of group?.appointments ?? []) {
        const day = romeDayKey(row?.startsAt);
        if (day !== null) heldDays.add(day);
      }
    }
    columns.forEach(([key, rows], dayIndex) => {
      const ghosts = state.proposals.filter((slot) => romeDayKey(slot?.startsAt) === key
        && slotInGrid(slot?.startsAt, slot?.endsAt));
      // backlog:5fbebe8559e9: on the stacked phone layout a day with nothing
      // painted collapses to one compact row (CSS ≤ 700px); desktop keeps
      // the empty timeline, the compact row stays hidden there.
      // Review #646 round 3: «Nessun appuntamento» is a claim about the day,
      // so it reads the whole loaded week — a day whose only bookings belong
      // to a hidden person keeps its timeline, never the compact row.
      const empty = rows.length === 0 && ghosts.length === 0 && state.selection?.key !== key && !heldDays.has(key);
      const head = el(doc, 'div', {
        className: empty ? 'cal-day-head is-empty' : 'cal-day-head',
        attrs: { style: `grid-column: ${dayIndex + 2}; grid-row: 1` },
      });
      const headText = dayHead(key) ?? key;
      if (isTodayInRome(`${key}T12:00:00Z`, now)) {
        // Today reads as a black disc with a light number, like the prototype.
        const disc = el(doc, 'span', { className: 'cal-today', text: headText });
        disc.setAttribute('aria-current', 'date');
        head.appendChild(disc);
      } else {
        head.appendChild(el(doc, 'span', { text: headText }));
      }
      grid.appendChild(head);
      const col = el(doc, 'div', {
        className: empty ? 'cal-day is-empty' : 'cal-day',
        attrs: { style: `grid-column: ${dayIndex + 2}; grid-row: 2 / span ${GRID_ROWS}` },
      });
      // Events and ghosts share the lanes (backlog:5fbebe8559e9): a ghost
      // never paints over a booking or over another ghost.
      const lanes = lanesFor([...rows, ...ghosts]);
      const laneCount = lanes.size === 0 ? 1 : Math.max(...[...lanes.values()].map((entry) => entry.lanes));
      col.setAttribute('style', `${col.getAttribute('style')}; --lanes: ${laneCount}`);
      for (const row of rows) {
        col.appendChild(renderEvent(row, lanes.get(row) ?? { lane: 0, lanes: 1 }));
      }
      // BO-F6-11 fetta 3 (specs/calendario.md C5): the "✦ Proposta" ghosts.
      // One dashed ghost per searched slot on its Rome day, clickable to
      // confirm like the card rows. The dashed `bo-add-button` is the shared
      // shell control for add-an-item blocks, not a new style. Fetta 4 seats
      // each ghost on its time rows, spanning the day width. Fetta 8: a slot
      // starting outside 09:00–18:00 never lands on another hour's row — it
      // joins the honest out-of-hours lines below the grid instead.
      for (const slot of ghosts) {
        const placed = gridRowsFor(slot?.startsAt, slot?.endsAt);
        const lane = lanes.get(slot) ?? { lane: 0, lanes: 1 };
        const ghost = el(doc, 'button', {
          className: 'bo-add-button',
          attrs: { type: 'button', style: `grid-row: ${placed.row} / span ${placed.span}; grid-column: ${lane.lane + 1}` },
          text: `✦ Proposta ${romeTime(slot.startsAt) ?? ''}`,
        });
        ghost.addEventListener('click', () => void confirmSlot(slot));
        col.appendChild(ghost);
      }
      // Supervisor design pass (Dan 03/11, «come Google/Apple»): press on an
      // empty part of the day and drag to choose the slot; a plain click is
      // 30 minutes. Releasing opens the Nuovo appuntamento form beside the
      // chosen block, already filled with day, start and end.
      if (state.selection && state.selection.key === key) {
        col.appendChild(el(doc, 'div', {
          className: 'cal-pick',
          attrs: {
            'data-role': 'slot-pick',
            style: `grid-row: ${(state.selection.start - GRID_START_MINUTES) / GRID_SLOT_MINUTES + 1} / span ${Math.max(1, (state.selection.end - state.selection.start) / GRID_SLOT_MINUTES)}; grid-column: 1 / -1`,
          },
          text: `${minutesLabel(state.selection.start)}–${minutesLabel(state.selection.end)}`,
        }));
      }
      bindSlotDrag(col, key);
      // The red now-line crosses the current day at the current Rome time,
      // only while the time falls inside the painted hours.
      if (isTodayInRome(`${key}T12:00:00Z`, now) && nowMin !== null && nowMin >= GRID_START_MINUTES && nowMin < GRID_END_MINUTES) {
        const line = el(doc, 'div', {
          className: 'cal-now',
          attrs: {
            'aria-hidden': 'true',
            style: `top: ${(((nowMin - GRID_START_MINUTES) / (GRID_END_MINUTES - GRID_START_MINUTES)) * 100).toFixed(2)}%`,
          },
        });
        col.appendChild(line);
      }
      grid.appendChild(col);
      if (empty) {
        const compact = el(doc, 'div', { className: 'cal-day-compact', attrs: { 'data-day': key } });
        compact.appendChild(el(doc, 'span', { className: 'cal-day-compact-name', text: dayHead(key) ?? key }));
        compact.appendChild(el(doc, 'span', { text: 'Nessun appuntamento' }));
        const book = uiButton(doc, {
          variant: 'secondary', small: true, label: '+ Prenota',
          attrs: { type: 'button', 'aria-label': `Prenota ${dayName(key)} ${romeShortDay(`${key}T12:00:00Z`) ?? ''}`.trim() },
        });
        book.addEventListener('click', () => bookDay(key));
        compact.appendChild(book);
        grid.appendChild(compact);
      }
    });
    panel.appendChild(grid);
    // BO-F6-11 fetta 8 (owner 29/10: the grid covers the proposal hours or
    // says so): proposals starting outside 09:00–18:00 are named here with
    // their real time instead of landing on another hour's row. Confirming
    // stays in the «Fissa con una frase» card rows, like every other slot.
    for (const slot of state.proposals) {
      if (slotInGrid(slot?.startsAt, slot?.endsAt)) continue;
      const when = `${[romeWeekdayShort(slot?.startsAt), romeShortDay(slot?.startsAt)].filter(Boolean).join(' ')} ${romeTime(slot?.startsAt) ?? ''}`.trim();
      panel.appendChild(el(doc, 'p', {
        className: 'empty',
        text: `✦ Proposta ${when}: è fuori dall'orario mostrato (09:00–18:00), la confermi dalla card «Fissa con una frase».`,
      }));
    }
    return panel;
  }

  /** Italian weekday name for a YYYY-MM-DD key, noon UTC avoids DST edges. */
  function dayName(key) {
    try {
      const text = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' })
        .format(new Date(`${key}T12:00:00Z`));
      return text.charAt(0).toUpperCase() + text.slice(1);
    } catch {
      return key;
    }
  }

  /**
   * backlog:df55cf25 — the booking identity a grid block tints by: the
   * person's stable primary subject, the same identity the Team toggle
   * hashes, so a block and its toggle always match even when the person
   * holds several subjects. Unknown subjects tint by themselves.
   * @param {unknown} subject
   */
  function tintSubjectOf(subject) {
    if (typeof subject !== 'string' || subject === '') return subject;
    const rows = personRows(parseMemberFilter(state.memberFilter), [], state.members);
    return rows.find((row) => row.ids.includes(subject))?.id ?? subject;
  }

  /**
   * A week block: the whole block is one button, so a click selects it and
   * opens the detail card (C6). Colour comes from the person's stable
   * primary subject while initials follow the painted person name
   * (backlog:df55cf25), like the Team toggle; gray stays reserved for
   * multi-participant rows, which team-week never returns (one member per
   * booking), so it never paints.
   * @param {any} row @param {{lane: number, lanes: number}} lane
   */
  function renderEvent(row, lane) {
    const placed = gridRowsFor(row?.startsAt, row?.endsAt);
    const classes = ['cal-event', `cal-m${memberColorIndex(tintSubjectOf(row?.teamMemberId))}`];
    const memberName = resolveMemberName(row?.teamMemberId, parseMemberFilter(state.memberFilter), state.members);
    const selected = state.selectedId !== null && String(row?.id ?? '') === state.selectedId;
    if (selected) classes.push('cal-selected');
    const status = String(row?.status ?? 'booked');
    const cancelled = status !== 'booked' && status !== 'confirmed';
    if (cancelled) classes.push('cal-cancelled');
    const item = el(doc, 'button', {
      className: classes.join(' '),
      attrs: {
        type: 'button',
        style: `grid-row: ${placed.row} / span ${placed.span}; grid-column: ${lane.lane + 1}`,
        'aria-pressed': selected ? 'true' : 'false',
      },
    });
    const time = `${romeTime(row.startsAt) ?? '?'}–${romeTime(row.endsAt) ?? '?'}`;
    item.appendChild(el(doc, 'span', { className: 'cal-time', text: time }));
    item.appendChild(el(doc, 'strong', { text: titleOf(row) }));
    const foot = el(doc, 'span', { className: 'cal-day-foot' });
    // Initials decorate (the tint already encodes the member); the WA badge
    // stays readable because it names the booking origin.
    foot.appendChild(el(doc, 'span', { className: 'cal-avatar', text: memberInitials(memberName ?? row?.teamMemberId), attrs: { 'aria-hidden': 'true' } }));
    // backlog:29bb3f2c0d64: the channel pill of the prototype block — WA
    // keeps its badge, a Google-imported event and an online-link booking
    // carry their own short pill; a booking made here carries none, like
    // the prototype's non-WA blocks.
    const origin = originOf(row);
    if (origin === 'whatsapp') {
      foot.appendChild(el(doc, 'span', { className: 'cal-wa', text: 'WA' }));
    } else if (origin === 'google') {
      foot.appendChild(el(doc, 'span', { className: 'cal-pill cal-pill-google', text: '↔ Google', attrs: { title: 'Da Google Calendar' } }));
    } else if (origin === 'link') {
      foot.appendChild(el(doc, 'span', { className: 'cal-pill cal-pill-link', text: 'Link', attrs: { title: 'Prenotato con il link online' } }));
    }
    // A cancelled booking still reads as cancelled: the tint alone must
    // never pass a dead booking as held.
    if (cancelled) {
      foot.appendChild(el(doc, 'span', { className: 'badge', text: statusWord(status) }));
    }
    item.appendChild(foot);
    const id = String(row?.id ?? '');
    item.addEventListener('click', () => {
      state.selectedId = state.selectedId === id ? null : id;
      renderAll();
    });
    return item;
  }

  /**
   * Event title, like the prototype «Prima call · Giulia Romano»: the service
   * name, then the customer name when the row is linked to a named customer
   * (backlog:5fbebe8559e9). Never the raw listino key, never an invented
   * name; the free notes move to the detail card.
   */
  function titleOf(row) {
    const service = serviceLabel(row?.serviceKey, state.services);
    const customer = displayNameOf(row, subjectKeyOf(row));
    return customer ? `${service} · ${customer}` : service;
  }

  /**
   * The linked customer of a week row, or null: resource and id must both be
   * non-empty strings, so a half envelope never builds a scheda route.
   * @param {any} row
   */
  function subjectKeyOf(row) {
    const subject = row?.subject ?? {};
    const resource = typeof subject.resource === 'string' ? subject.resource : '';
    const id = typeof subject.id === 'string' ? subject.id : '';
    if (resource === '' || id === '') return null;
    return { resource, id, key: `${resource}:${id}` };
  }

  // nameFromProfile lives in admin-labels.js: Oggi reads the same name.

  /**
   * The customer display name: the cached profile name first, then the row
   * label the server attached — never the raw id, which is not a name. Pure
   * read: the caller fetches an uncached profile once (read-only,
   * fail-soft). @param {any} row @param {{resource: string, id: string, key: string} | null} linked
   */
  function displayNameOf(row, linked) {
    const cached = linked ? state.profiles[linked.key] : undefined;
    if (typeof cached === 'string' && cached !== '') return cached;
    const label = typeof row?.subject?.label === 'string' ? row.subject.label.trim() : '';
    return label !== '' ? label : null;
  }

  /** @param {{resource: string, id: string, key: string}} linked */
  async function loadSubjectName(linked) {
    await fetchSubjectName(linked);
    // The operator may have opened the customer card while the read was in
    // flight: that view clears this same mount, so no calendar wrap means
    // the calendar is gone and repainting would wipe the card in its place.
    if (state.selectedId !== null && mount.querySelector('.cal-wrap') !== null) renderAll();
  }

  /** @param {{resource: string, id: string, key: string}} linked */
  async function fetchSubjectName(linked) {
    // The cache is keyed, not selection-bound: a late answer stays valid
    // data for its key whatever is selected meanwhile — the repaint below
    // only refreshes the calendar while it is still the mounted view.
    try {
      const profile = await client.request(
        `/api/customer-data/profile/${encodeURIComponent(linked.resource)}/${encodeURIComponent(linked.id)}`,
      );
      state.profiles[linked.key] = nameFromProfile(profile);
    } catch (error) {
      // Unavailable (not composed, unknown customer, stale Admin bundle):
      // the card keeps the row label or id. Anything else — a network fault,
      // an HTTP 5xx — is unexpected: log the sanitized cause with the active
      // space, never the message or personal data, and keep the soft
      // fallback (AGENTS.md: a swallowed 5xx without a log blocks review).
      if (!isNotComposedFailure(error) && !isUnsupportedContractFailure(error)) {
        console.warn(
          'bo-calendario profile unreadable:',
          error instanceof Error ? error.name : (error?.code ?? 'unknown'),
          `spaceId=${readSpace()}`,
        );
      }
      state.profiles[linked.key] = null;
    }
  }

  /**
   * BO-F6-11 fetta 5 (specs/calendario.md C7, C8): the selected-event card —
   * title, day · time row, participant names, the channel pill and the
   * customer button. No location paints because team-week rows carry none;
   * the row names day and time only. The customer name resolves through the
   * read-only customer profile (the map's own read), falling back to the row
   * label or id when the profile is unavailable. The WA pill paints only
   * from the explicit row marker (fetta 4's fail-closed rule) with the
   * shared channel chip. backlog:29bb3f2c0d64: the other origins come from
   * the row's source key (originOf) — never "✦ Fissato con l'AI", which the
   * row cannot prove — and the «↔ Google Calendar» line paints only for
   * events calendar-sync imported (`gcal:`); a booking made here carries no
   * sync state, so it gets no «invito inviato» guess. "Apri scheda cliente"
   * is the dark primary button over the shared customer-card route, only for linked events.
   * @param {any} row
   */
  function renderDetailCard(row) {
    const card = el(doc, 'div', { className: 'panel', attrs: { 'data-role': 'event-detail' } });
    // backlog:29bb3f2c0d64 (production 08/11): the card title is a card
    // title, never the 46px page title.
    const head = el(doc, 'div', { className: 'panel-heading cal-detail-head' });
    head.appendChild(el(doc, 'h2', { className: 'cal-detail-title', text: titleOf(row) }));
    const close = el(doc, 'button', {
      className: 'small secondary',
      attrs: { type: 'button', 'aria-label': 'Chiudi dettaglio' },
      text: '×',
    });
    close.addEventListener('click', () => {
      state.selectedId = null;
      renderAll();
    });
    head.appendChild(close);
    card.appendChild(head);
    const key = romeDayKey(row?.startsAt);
    const when = `${key ? `${dayName(key)} ${romeShortDay(`${key}T12:00:00Z`) ?? ''}` : '?'} · ${romeTime(row?.startsAt) ?? '?'}–${romeTime(row?.endsAt) ?? '?'}`;
    card.appendChild(el(doc, 'p', { text: when }));
    const linked = subjectKeyOf(row);
    if (linked && !(linked.key in state.profiles)) {
      // In flight: the label or id paints meanwhile, and one request serves
      // every re-render until it resolves.
      state.profiles[linked.key] = null;
      void loadSubjectName(linked);
    }
    const display = displayNameOf(row, linked);
    const customer = display ?? (linked ? linked.id : null);
    // backlog:df55cf25 — the member part is a person name, never the opaque
    // team subject: the roster person name when known, else the operator's
    // own typed words, else nothing (a pipe id never paints). The customer
    // fallback (label, then id as inert text) stays: the card must name whom
    // the booking is for even without a profile.
    const member = resolveMemberName(row?.teamMemberId, parseMemberFilter(state.memberFilter), state.members);
    const participants = [member, customer].filter((part) => typeof part === 'string' && part !== '');
    if (participants.length > 0) {
      card.appendChild(el(doc, 'p', { text: participants.join(', ') }));
    }
    const notes = typeof row?.notes === 'string' ? row.notes.trim() : '';
    if (notes !== '') card.appendChild(el(doc, 'p', { text: `Nota: ${notes}` }));
    const origin = originOf(row);
    if (origin === 'whatsapp') {
      const pill = el(doc, 'p');
      pill.appendChild(uiChannelChip(doc, 'WA'));
      // Leading space: the chip and the sentence are sibling inline boxes. A
      // raw id is not a name, so the pill degrades to the nameless sentence
      // instead of printing one.
      pill.appendChild(el(doc, 'span', {
        text: display ? ` Prenotato da ${display} su WhatsApp` : ' Prenotato su WhatsApp',
      }));
      card.appendChild(pill);
    } else if (origin !== null) {
      // backlog:29bb3f2c0d64 (C8): the other origins the row proves, in the
      // prototype pill. A booking made here never claims «Fissato con
      // l'AI»: manual and phrase bookings look the same on the row.
      const words = {
        google: 'Arrivato da Google Calendar',
        link: 'Prenotato dal cliente con il link online',
        calendario: 'Fissato dal calendario',
      }[origin];
      const pill = el(doc, 'p');
      pill.appendChild(el(doc, 'span', { className: `cal-via cal-via-${origin}`, attrs: { 'data-role': 'event-origin' }, text: words }));
      card.appendChild(pill);
    }
    if (origin === 'google') {
      // backlog:29bb3f2c0d64 (C8): the «↔ Google Calendar» line, only where
      // the row proves the link — an event calendar-sync imported. A
      // booking made here carries no sync evidence on the row, so it stays
      // without the line (no «invito inviato» guess).
      // Review #678: «collegato» only on positive proof from the profile; an
      // unknown state (profile unavailable or unread) says only where the
      // event came from.
      const connected = state.calendar?.connected;
      card.appendChild(el(doc, 'p', {
        className: 'cal-sync',
        attrs: { 'data-role': 'event-sync' },
        text: connected === true
          ? '↔ Google Calendar · evento importato dal calendario collegato'
          : connected === false
            ? '↔ Google Calendar · non più collegato: ricollegalo dal Profilo'
            : '↔ Google Calendar · evento importato da Google Calendar',
      }));
    }
    if (linked) {
      const open = uiButton(doc, {
        variant: 'primary',
        small: true,
        label: 'Apri scheda cliente',
        attrs: { type: 'button' },
      });
      open.addEventListener('click', () => {
        navigate(`#/customer-card/${encodeURIComponent(linked.resource)}/${encodeURIComponent(linked.id)}`);
      });
      card.appendChild(open);
    }
    return card;
  }

  /**
   * BO-F6-11 fetta 3 (specs/calendario.md C4, C5): the "✦ Fissa con una
   * frase" card. The phrase interprets to a draft (person, day, duration);
   * "Trova slot liberi" reads that person's free slots over the shown week
   * — never invented — and renders one row plus one grid ghost per slot.
   * Every Conferma (row or ghost) books through confirmBooking with the
   * claim the manual form below holds; a missing customer, service or price
   * fails closed with a plain sentence naming the manual form.
   */
  /**
   * backlog:3771ac637027 — «Compila a mano» from the phrase card: opens the
   * manual form like «Compila manualmente» and carries the phrase into its
   * Note field when the operator has not written a note yet, so nothing
   * typed is lost. Focus lands on the form's first field.
   */
  function openManualFromPhrase() {
    const phrase = String(state.phrase ?? '').trim();
    state.manualOpen = true;
    if (phrase !== '' && String(state.manual?.notes ?? '').trim() === '') {
      state.manual = { ...(state.manual ?? {}), notes: phrase.slice(0, 2000) };
    }
    renderAll();
    const target = state.manualFirst;
    if (target && typeof target.focus === 'function') target.focus();
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView();
  }

  function renderAi() {
    const panel = el(doc, 'div', { className: 'panel cal-ai' });
    panel.appendChild(el(doc, 'h2', { text: '✦ Fissa con una frase' }));
    panel.appendChild(el(doc, 'p', {
      className: 'lede',
      text: 'Scrivi come lo diresti: dalla frase leggo persona e durata, poi mostro gli slot liberi di quella persona nella settimana. Ogni Conferma prenota davvero.',
    }));
    const row = el(doc, 'div', { className: 'cal-filter' });
    const input = el(doc, 'textarea', {
      attrs: { name: 'phrase', rows: '3', placeholder: '«trova 45 minuti con Marco»' },
    });
    input.value = state.phrase;
    input.addEventListener('input', () => { state.phrase = String(input.value ?? ''); });
    state.phraseInput = input;
    const find = el(doc, 'button', { className: 'primary small', text: 'Trova slot liberi' });
    // AI off in this space (production 07/11): once the server said so, the
    // phrase box stays disabled for the visit and the note points at the
    // manual form, instead of a retry that can only fail the same way.
    const aiOff = state.aiOff.has(readSpace());
    if (aiOff) {
      input.setAttribute('disabled', 'true');
      find.setAttribute('disabled', 'true');
    } else if (state.aiLoading) find.setAttribute('disabled', 'true');
    else find.addEventListener('click', () => void submitAi(String(input.value ?? '')));
    row.appendChild(input);
    row.appendChild(find);
    panel.appendChild(row);
    if (state.aiLoading) {
      panel.appendChild(el(doc, 'p', {
        className: 'empty',
        text: state.phraseWaiting ? 'Sto cercando… la risposta arriva tra poco.' : 'Cerco gli slot liberi…',
      }));
    }
    const aiNote = state.aiNote || (aiOff ? calendarRefusalText({ code: 'LLM_SPACE_DISABLED' }) : '');
    if (aiNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: aiNote }));
    if (!state.aiLoading && state.phrasePending && state.phrasePending.spaceId === readSpace()) {
      // Still queued after the read-back: Riprova reads the SAME request
      // back, never a new POST (the pilot parses each POST again).
      // The phrase that produced the request rides with it (review #664):
      // an edit after the timeout never paints that request's draft under
      // other words — Riprova restores the asked phrase with its answer.
      const queued = state.phrasePending;
      const retry = el(doc, 'button', { className: 'small secondary', text: 'Riprova', attrs: { type: 'button', 'data-action': 'phrase-resume' } });
      retry.addEventListener('click', () => void submitAi(queued.phrase, { resumeId: queued.requestId }));
      panel.appendChild(retry);
    }
    if (state.draft) panel.appendChild(renderDraft(state.draft));
    if (state.draftNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: state.draftNote }));
    // backlog:3771ac637027: with the AI off or over today's ceiling the way
    // forward is the manual form, opened right here — the same form as
    // «Nuovo appuntamento › Compila manualmente» (also when the phrase gave
    // no draft). No «Accendi l'AI»: no /bo screen switches the AI on (the
    // pilot's operator does), so none is offered rather than a button that
    // leads nowhere.
    if (!state.aiLoading && (aiOff || state.aiBlocked !== null || state.phraseNoDraft)) {
      const manual = uiButton(doc, {
        variant: 'secondary', small: true, label: 'Compila a mano',
        attrs: { type: 'button', 'data-action': 'phrase-manual' },
      });
      manual.addEventListener('click', () => openManualFromPhrase());
      panel.appendChild(manual);
    }
    if (state.proposals.length > 0) {
      const list = el(doc, 'div', { className: 'cal-slots' });
      for (const slot of state.proposals.slice(0, 24)) {
        const item = el(doc, 'div');
        item.appendChild(el(doc, 'span', { text: slotLabel(slot) }));
        const confirm = el(doc, 'button', { className: 'small secondary', text: 'Conferma' });
        confirm.addEventListener('click', () => void confirmSlot(slot));
        item.appendChild(confirm);
        list.appendChild(item);
      }
      panel.appendChild(list);
    }
    return panel;
  }


  /**
   * The team week holding every searched identity: the painted week when it
   * already lists them all, else one team-week read for the searched ones
   * over the shown window (review #646 P2).
   * @param {Array<string>} searchIds @param {Array<string>} weekKeys the searched week
   */
  async function heldWeekFor(searchIds, weekKeys) {
    if (state.weekKeys === weekKeys && weekCovers(state.week, searchIds)) return state.week;
    const window = weekWindow(weekKeys);
    if (!window) throw new Error('Settimana non valida.');
    return client.request(
      `/api/appointments/team-week?teamMemberIds=${encodeURIComponent(searchIds.join(','))}`
      + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
    );
  }

  /**
   * Suggest window over the shown Rome week, with the day-margin idiom of
   * the booking path — or over the one Rome day the phrase named.
   * @param {string|null} [dayKey]
   */
  function suggestBounds(dayKey = null) {
    const keys = typeof dayKey === 'string' && dayKey !== '' ? [dayKey] : state.weekKeys;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    const first = Date.parse(`${keys[0]}T00:00:00Z`);
    const last = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
    if (Number.isNaN(first) || Number.isNaN(last)) return null;
    return {
      from: new Date(first - 2 * 3600 * 1000).toISOString(),
      to: new Date(last + 26 * 3600 * 1000).toISOString(),
    };
  }

  /**
   * The phrase answer: the POST, or — when the pilot queues it (504
   * BO_PHRASE_PENDING with a requestId, production 07/11) — the same
   * request read back every 3 s for about a minute. Throws PHRASE_STILL_PENDING
   * (with the requestId) when it is still queued after that.
   * @param {{resumeId?: string|null, seq: number}} options
   */
  async function phraseAnswer({ resumeId = null, seq }) {
    let requestId = resumeId;
    if (requestId === null) {
      try {
        return await client.request('/api/appointments/phrase', {
          method: 'POST',
          body: { spaceId: readSpace(), phrase: state.phrase },
        });
      } catch (error) {
        requestId = pendingRequestId(error, 'BO_PHRASE_PENDING');
        if (requestId === null) throw error;
      }
    }
    // A route away (or a newer search) during the POST owns the mount now:
    // never paint the waiting card over it (review #664, backlog:607f33ee).
    if (seq !== phraseSeq) throw Object.assign(new Error('stale'), { code: 'PHRASE_STALE' });
    state.phraseWaiting = true;
    renderAll();
    const read = await readBackPending(client, '/api/appointments/phrase', requestId, {
      expectedCode: 'BO_PHRASE_PENDING',
      spaceId: readSpace(),
      wait, everyMs: PHRASE_RESUME_EVERY_MS, rounds: PHRASE_RESUME_ROUNDS, stale: () => seq !== phraseSeq,
    });
    if (read.stale) throw Object.assign(new Error('stale'), { code: 'PHRASE_STALE' });
    if (read.error) throw read.error;
    if (read.pending) throw Object.assign(new Error('pending'), { code: 'PHRASE_STILL_PENDING', requestId: read.requestId });
    return read.answer;
  }

  /** @param {string} phrase @param {{resumeId?: string|null}} [options] */
  async function submitAi(phrase, { resumeId = null } = {}) {
    const seq = ++phraseSeq;
    state.phrasePending = null;
    state.phraseWaiting = false;
    state.phrase = String(phrase ?? '');
    if (state.phrase.trim() === '' && resumeId === null) {
      state.draft = null;
      state.draftNote = '';
      state.proposals = [];
      state.aiNote = 'Scrivi prima la frase.';
      renderAll();
      return;
    }
    state.aiLoading = true;
    state.draft = null;
    state.draftNote = '';
    state.proposals = [];
    state.aiNote = '';
    state.aiBlocked = null;
    state.phraseNoDraft = false;
    renderAll();
    // The phrase that asks this request (review #664): the queued id and the
    // answer both ride with it, never with a later edit of the textarea.
    const asked = state.phrase;
    // The space that asks it (review #664): a queued id is never read back
    // under another space.
    const askedSpace = readSpace();
    try {
      const answer = await phraseAnswer({ resumeId, seq });
      state.phraseWaiting = false;
      // An edit while the answer was on its way never relabels it: the
      // draft paints under the phrase that asked it (review #664 P3).
      state.phrase = asked;
      const draft = answer?.draft ?? null;
      state.draft = draft;
      if (!draft) {
        state.draftNote = 'Nessuna bozza dalla frase: riscrivila, o compila l’appuntamento a mano.';
        state.phraseNoDraft = true;
        return;
      }
      const member = typeof draft.teamMemberId === 'string' ? draft.teamMemberId : '';
      if (member === '') {
        state.draftNote = '';
        state.draft = null;
        state.aiNote = 'Dalla frase non capisco la persona: scrivi con chi, per esempio «trova 45 minuti con Marco».';
        return;
      }
      // Production 07/11: «giovedì» named a day, the search spanned the
      // whole week and Monday came first. A named day bounds the search to
      // it, and the grid moves to that day's week so the ghosts show there.
      const dayKey = draftDayKey(draft);
      const movedWeek = Boolean(dayKey && !state.weekKeys.includes(dayKey));
      if (movedWeek) {
        state.weekKeys = romeWeekKeys(new Date(`${dayKey}T12:00:00Z`));
        state.week = null;
        const shown = parseMemberFilter(state.memberFilter);
        // The held-overlap guard below reads the named week: wait for it,
        // never filter against a nulled week (review #657).
        const wantedKeys = state.weekKeys;
        if (shown.length > 0) await loadWeek(shown);
        // A pager move during the preload leaves this answer unpublished:
        // the guard must never read a week other than the named one
        // (review #657, round 5).
        if (state.weekKeys !== wantedKeys) return;
      }
      const bounds = suggestBounds(dayKey);
      if (!bounds) {
        state.aiNote = 'Settimana non valida.';
        return;
      }
      // Review #646 round 3: the searched week is captured once; a pager
      // move while the search runs leaves this answer unpublished.
      const searchKeys = state.weekKeys;
      // backlog:d1e4d90e — the draft names a person («Marco»), the search
      // needs booking identities: resolve against the known team, and search
      // every identity the human holds. Unresolved words keep the outsider
      // path below, never a booking as the wrong human.
      const memberIds = resolveDraftMemberIds(member, parseMemberFilter(state.memberFilter), state.members);
      const searchIds = memberIds.length > 0 ? memberIds : [member];
      const found = await client.request(
        `/api/appointments/suggest-slots?teamMemberIds=${encodeURIComponent(searchIds.join(','))}`
        + `&from=${encodeURIComponent(bounds.from)}&to=${encodeURIComponent(bounds.to)}`
        + `&slotMinutes=${encodeURIComponent(String(draftMinutes(draft)))}`,
      );
      const groups = Array.isArray(found?.members) ? found.members : [];
      // backlog:d1e4d90e — the searched identities belong to one resolved
      // person: offer a step only when every identity reports it free, so a
      // booking under one identity never double-books their other one.
      const kept = personFreeSlots(groups, searchIds, member);
      // One row and one ghost per slot, like the week grid caps its own
      // columns: the first 24 carry the search, never an invented rest. Only
      // future steps are proposed — cut against the view clock so tests pin
      // it (backlog:d1e4d90e). Out-of-hours steps stay for the honest lines
      // below the grid (fetta 8), never dropped.
      // backlog:d1e4d90e — the night is always free, so rank the painted
      // hours first: day steps fill the proposals, night steps stay behind
      // for the honest lines, never dropped (fetta 8).
      // Review #646 P2: the held-booking guard reads the SEARCHED person's
      // week. When the painted week does not hold every searched identity
      // (nobody named, the filter shows marco and the phrase names sara, a
      // moved week the grid could not load), the guard reads theirs too — a
      // failed read proposes nothing, never an unguarded list (review #657).
      if (state.weekKeys !== searchKeys) return;
      let heldWeek = null;
      try {
        heldWeek = await heldWeekFor(searchIds, searchKeys);
      } catch {
        heldWeek = null;
      }
      if (state.weekKeys !== searchKeys) return;
      if (!heldWeek) {
        state.aiNote = 'Non riesco a leggere gli appuntamenti di quella settimana: riprova tra poco.';
        return;
      }
      const onDay = dayKey ? kept.filter((slot) => romeDayKey(slot?.startsAt) === dayKey) : kept;
      const proposals = rankPhraseProposals(dropHeldOverlaps(filterPhraseProposals(onDay, clock().getTime()), heldWeek, searchIds));
      state.proposals = proposals.slice(0, 24);
      state.draftNote = 'Bozza pronta: controlla i campi nel modulo e conferma.';
      state.aiNote = proposals.length === 0
        ? (dayKey ? 'Nessuno slot libero quel giorno, prova con un altro giorno.' : 'Nessuno slot libero questa settimana, prova con altri giorni.')
        : '';
    } catch (error) {
      const record = error !== null && typeof error === 'object' ? error : {};
      // A newer search or a route away owns the card now: touch nothing.
      if (record.code === 'PHRASE_STALE') return;
      state.draft = null;
      state.draftNote = '';
      state.proposals = [];
      state.phraseWaiting = false;
      if (record.code === 'PHRASE_STILL_PENDING') {
        // Never «Ricerca non riuscita» on an answer that may be ready: say
        // it is slow, and offer Riprova on the same request.
        console.warn('bo-calendario phrase still pending:', `requestId=${String(record.requestId ?? '')}`, `spaceId=${readSpace()}`);
        state.phrasePending = typeof record.requestId === 'string' ? { requestId: record.requestId, phrase: asked, spaceId: askedSpace } : null;
        state.aiNote = 'La ricerca sta impiegando più del previsto.';
        return;
      }
      const refusal = calendarRefusalText(error);
      if (record.code === 'LLM_SPACE_DISABLED' || record.code === 'LLM_SECRET_UNAVAILABLE') state.aiOff.add(readSpace());
      state.aiBlocked = aiBlockOf(error);
      if (refusal !== null) console.warn('bo-calendario phrase refused:', String(record.code ?? 'unknown'), `spaceId=${readSpace()}`);
      state.aiNote = record.code === 'APPOINTMENTS_AI_DRAFT_IN_PAST'
        ? 'La frase indica un momento già passato: prova con un giorno futuro.'
        : refusal ?? humanReadError(error, {
          failed: 'Ricerca non riuscita. Riprova più tardi.',
          notComposed: 'Il calendario non è composto in questo spazio.',
        });
    } finally {
      if (seq === phraseSeq) {
        state.aiLoading = false;
        renderAll();
      }
    }
    if (seq !== phraseSeq) return;
    // A resolved person prefills its single booking identity; with several
    // (or none) the choice stays with the operator on the manual form.
    if (state.draft) {
      const ids = resolveDraftMemberIds(
        typeof state.draft.teamMemberId === 'string' ? state.draft.teamMemberId : '',
        parseMemberFilter(state.memberFilter),
        state.members,
      );
      fillManual(ids.length === 1 ? { ...state.draft, teamMemberId: ids[0] } : state.draft);
    }
  }

  /** @param {any} draft */
  function renderDraft(draft) {
    const box = el(doc, 'div', { className: 'cal-draft' });
    // backlog:5fbebe8559e9 + backlog:65ed7430: one «when» line for every
    // draft shape — a day without a time reads «orario da scegliere»,
    // never «00:00» and never «?».
    const when = draftWhen(draft);
    box.appendChild(el(doc, 'p', {
      text: `Bozza: ${memberLabelFor(draft.teamMemberId, parseMemberFilter(state.memberFilter), state.members)} · ${when}`,
    }));
    if (draft.notes) box.appendChild(el(doc, 'p', { text: `Nota: ${draft.notes}` }));
    return box;
  }

  /** Live manual values, from the rendered inputs when present. @param {string} name */
  function manualValue(name) {
    const node = state.manualNodes?.[name];
    if (node && typeof node.value === 'string') return node.value;
    const kept = state.manual?.[name];
    return typeof kept === 'string' ? kept : '';
  }

  /**
   * backlog:df55cf25 — the person identity the claim books: the visible
   * field when the operator typed or chose someone, else the opaque
   * identity kept in state. A pipe outsider never paints, so an empty
   * visible field still books the exact drafted subject.
   * @param {any} inputs
   */
  function claimedMember(inputs) {
    const typed = String(inputs.teamMemberId?.value ?? '').trim();
    if (typed !== '') return typed;
    const kept = typeof state.manual?.teamMemberId === 'string' ? state.manual.teamMemberId.trim() : '';
    return kept;
  }

  /**
   * The manual booking customer: picked by name from the search, never typed
   * as an id or a resource (owner 29/10). Without a pick the claim keeps the
   * historical fallback — contact with an empty id, «senza-cliente» downstream.
   */
  function pickedCustomer() {
    const pick = state.customerPick;
    const id = typeof pick?.id === 'string' ? pick.id : '';
    const resource = typeof pick?.resource === 'string' && pick.resource !== '' ? pick.resource : 'contact';
    return { resource, id };
  }

  /**
   * Customer name search for the manual form: the same read-only list the
   * Clienti view pages (`GET /api/customer-data/customers?q=`). The list
   * only serves pages 10, 25 and 50, so the search asks for the smallest
   * page and shows five rows at most. Late answers paint the live results
   * box only — never a full re-render, so the operator keeps typing without
   * losing focus. Stale answers lose the token race and paint nothing.
   * @param {unknown} query
   */
  async function searchCustomers(query) {
    const token = ++customerSeq;
    const q = String(query ?? '').trim();
    if (q.length < 2) {
      if (token !== customerSeq) return;
      state.customerItems = [];
      state.customerError = null;
      paintCustomerResults(liveCustomerBox());
      return;
    }
    // The space the search asked in: an answer never paints in another one.
    const askedSpace = readSpace();
    try {
      const params = new URLSearchParams({ q, page: '1', pageSize: '10' });
      const spaceId = askedSpace;
      if (spaceId) params.set('spaceId', spaceId);
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      customerAbort = controller;
      const answer = await client.request(
        `/api/customer-data/customers?${params.toString()}`,
        controller ? { signal: controller.signal } : {},
      );
      if (customerAbort === controller) customerAbort = null;
      if (token !== customerSeq || readSpace() !== askedSpace) return;
      state.customerItems = (Array.isArray(answer?.items) ? answer.items : []).slice(0, 5);
      // backlog:d128847d21fc: a list the server read only in part says so,
      // never a flat «nessun cliente».
      state.customerPartial = answer?.complete === false;
      state.customerError = null;
    } catch (error) {
      // An aborted request belongs to a search a newer keystroke replaced.
      if (token !== customerSeq || error?.name === 'AbortError' || readSpace() !== askedSpace) return;
      state.customerPartial = false;
      state.customerItems = [];
      state.customerError = humanReadError(error, {
        failed: 'L’elenco non si è potuto leggere. Riprova più tardi.',
      });
    }
    paintCustomerResults(liveCustomerBox());
  }

  /**
   * The customer-results box currently on screen, if the manual form is
   * still mounted: a re-render (week move, roster, slots) while a search is
   * in flight detaches the captured box, so late answers paint here.
   */
  function liveCustomerBox() {
    return mount.querySelector('[data-role="customer-results"]');
  }

  /**
   * Paint the last customer search into its box: one button per customer
   * carrying the name and nothing else — ids and resources never reach the
   * screen. A click picks the customer and rebuilds the form around the
   * pick, so the claim below books exactly the shown name.
   * @param {any} box
   */
  function paintCustomerResults(box) {
    if (!box || typeof box.appendChild !== 'function') return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (state.customerError) {
      box.appendChild(el(doc, 'p', { className: 'empty', text: state.customerError }));
      return;
    }
    if (String(state.customerQuery ?? '').trim().length < 2) return;
    if (state.customerItems.length === 0) {
      box.appendChild(el(doc, 'p', {
        className: 'empty',
        text: state.customerPartial
          ? 'Nessun cliente corrisponde tra quelli letti: l’elenco è parziale. Prova con nome o cognome.'
          : 'Nessun cliente corrisponde. Prova con un altro nome.',
      }));
      return;
    }
    for (const item of state.customerItems) {
      const name = typeof item?.name === 'string' && item.name !== '' ? item.name : 'Cliente senza nome';
      const pick = uiSecondaryButton(doc, name);
      pick.addEventListener('click', () => {
        // Review #690 (P2): the choice ends the search — no pending timer or
        // request in flight reads again after it.
        cancelCustomerSearch();
        state.customerPick = {
          resource: typeof item?.resource === 'string' && item.resource !== '' ? item.resource : 'contact',
          id: typeof item?.id === 'string' ? item.id : '',
          name,
        };
        state.customerQuery = '';
        state.customerItems = [];
        state.customerError = null;
        renderAll();
      });
      box.appendChild(pick);
    }
  }

  /** Price text to integer minor units, or null when empty — the manual form's own rule. @param {unknown} raw */
  function priceToCents(raw) {
    const price = String(raw ?? '').replace(',', '.');
    return price === '' ? null : Math.round(Number(price) * 100);
  }

  /**
   * A proposal Conferma (row or ghost) books through confirmBooking: the
   * claim is the manual form the operator sees, with the slot's person and
   * times. The source key binds member, slot and customer, so a retry or a
   * double click replays instead of double-booking.
   * @param {{teamMemberId?: unknown, startsAt?: unknown, endsAt?: unknown}} slot
   */
  async function confirmSlot(slot) {
    await ensureServices();
    const member = typeof slot?.teamMemberId === 'string' ? slot.teamMemberId : '';
    const startsAt = typeof slot?.startsAt === 'string' ? slot.startsAt : '';
    const endsAt = typeof slot?.endsAt === 'string' ? slot.endsAt : '';
    if (member === '' || startsAt === '' || endsAt === '') {
      state.aiNote = 'Questo slot non è più valido: cerca di nuovo gli slot.';
      renderAll();
      return;
    }
    const customer = pickedCustomer();
    const claim = {
      spaceId: readSpace(),
      subject: { resource: customer.resource, id: customer.id, owner: 'host' },
      teamMemberId: member,
      serviceKey: serviceKeyFor(manualValue('serviceKey'), state.services),
      priceCents: priceToCents(manualValue('price')),
      currency: 'EUR',
      startsAt,
      endsAt,
      notes: manualValue('notes') === '' ? null : manualValue('notes'),
      sourceKey: `calendario:${member}:${startsAt}:${customer.id === '' ? 'senza-cliente' : customer.id}`,
      source: { package: 'host', action: 'calendar-book' },
    };
    state.confirmed = null;
    state.serviceError = '';
    const presend = servicePresendError(claim.serviceKey);
    if (presend !== null) {
      // A typed service the server could never book (backlog:9a853f44,
      // production 07/11): said under the field before anything is sent —
      // never a 400 with «Riprova più tardi».
      state.serviceError = presend;
      state.aiNote = CONFIRM_SERVICE_NOTE;
      renderAll();
      return;
    }
    // Same in-flight rule as the manual Conferma (review #657): the queued
    // write can take a while, the stale draft note never stays on screen.
    state.draftNote = '';
    state.aiNote = 'Prenotazione in corso…';
    renderAll();
    try {
      const booked = await client.request('/api/appointments/confirm', {
        method: 'POST',
        body: { ...claim, confirmed: true },
      });
      if (booked?.decision === 'booked') {
        markBooked(booked.appointment ?? claim);
      } else {
        state.aiNote = 'Registrata come proposta: lo spazio non fissa in automatico.';
      }
    } catch (error) {
      const refusal = calendarRefusalText(error);
      if (refusal !== null && isServiceRefusal(error)) {
        // The cause is the service field: say it there, and point at it here.
        state.serviceError = refusal;
        state.aiNote = CONFIRM_SERVICE_NOTE;
      } else {
        state.aiNote = humanWriteError(error, {
          failed: CONFIRM_FORM_NOTE,
          notComposed: 'Il calendario non è composto in questo spazio.',
        });
      }
    }
    renderAll();
    reloadAfterBooking();
  }

  /** @param {unknown} error */
  function isServiceRefusal(error) {
    const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
    return record.code === 'BO_APPOINTMENT_SERVICE_REFUSED' || record.details?.field === 'serviceKey';
  }

  /**
   * Production 07/11: after a «booked» answer the form still read «Bozza
   * pronta: premi Conferma…» and the phrase card kept its draft. A booking
   * is a done state: every draft note, proposal and form value goes, the
   * form stays open on «Prenotato: <persona> · <giorno ora>», and the grid
   * moves to the booked day's week so the event shows once the week reloads.
   * @param {any} appointment
   */
  function markBooked(appointment) {
    state.confirmed = appointment;
    state.selection = null;
    state.draft = null;
    state.draftNote = '';
    state.draftFill = null;
    state.proposals = [];
    state.aiNote = '';
    state.bookingNote = '';
    state.serviceError = '';
    state.manual = null;
    state.customerPick = null;
    state.manualOpen = true;
    const day = romeDayKey(appointment?.startsAt);
    if (day && !state.weekKeys.includes(day)) {
      state.weekKeys = romeWeekKeys(new Date(`${day}T12:00:00Z`));
      state.week = null;
    }
  }

  /** Reload the week after a booking, so the new event paints on the grid. */
  function reloadAfterBooking() {
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0 && state.confirmed) void loadWeek(members);
  }

  /**
   * The manual form's customer block: a name search, never an id or a
   * resource field (owner 29/10 gap). Without a pick the operator types at
   * least two letters into the shared search field and picks one of the
   * five name buttons; with a pick the block names the chosen customer and
   * offers «Cambia cliente» to search again. Ids and resources never reach
   * the screen — they ride the claim from `pickedCustomer()` only.
   * @param {any} form
   */
  function renderCustomerPick(form) {
    const pick = state.customerPick;
    if (pick && typeof pick?.name === 'string') {
      form.appendChild(el(doc, 'p', { attrs: { 'data-role': 'customer-pick' }, text: `Cliente: ${pick.name}` }));
      const change = uiSecondaryButton(doc, 'Cambia cliente');
      change.addEventListener('click', () => {
        // Review #690 (P2): a search still pending never lands after the reset.
        cancelCustomerSearch();
        state.customerPick = null;
        state.customerQuery = '';
        state.customerItems = [];
        state.customerError = null;
        renderAll();
      });
      form.appendChild(change);
      state.manualFirst = change;
      return;
    }
    const search = uiSearchField(doc, {
      name: 'customerSearch',
      placeholder: 'Cerca il cliente per nome…',
      value: state.customerQuery,
    });
    const box = el(doc, 'div', { attrs: { 'data-role': 'customer-results' } });
    const field = search.querySelector('input');
    if (field) {
      field.addEventListener('input', () => {
        state.customerQuery = String(field.value ?? '');
        scheduleCustomerSearch(state.customerQuery);
      });
    }
    form.appendChild(search);
    form.appendChild(box);
    paintCustomerResults(box);
    if (field) state.manualFirst = field;
  }

  /**
   * BO-F6-11 fetta 9 (backlog:5fbebe8559e9, owner 29/10: never an id the
   * operator types blind): the manual form's person is a choice among the
   * known team — the same names the Team card toggles (named filter ids plus
   * roster subjects), through the design-system select, so the claim still
   * carries the opaque identity the server books. With nobody known, or when
   * a phrase draft names someone outside the known team, the plain «Persona
   * del team» text field stays so nothing the operator or the AI named is
   * lost. An empty choice books nothing: the server requires the person and
   * the form answers in plain words.
   * @param {any} form
   * @returns {any} the live teamMemberId node (the select, or the fallback input)
   */
  function renderPersonChoice(form) {
    const named = parseMemberFilter(state.memberFilter);
    const rows = personRows(named, state.hiddenMembers, state.members);
    const draftPerson = typeof state.draftFill?.teamMemberId === 'string' ? state.draftFill.teamMemberId : '';
    const keptPerson = typeof state.manual?.teamMemberId === 'string' ? state.manual.teamMemberId : '';
    const groupOf = (subject) => rows.find((row) => row.ids.includes(subject)) ?? null;
    // The incoming draft decides the control: a draft naming someone outside
    // the known team paints the fallback field, even when a previous choice
    // is kept — otherwise the draft id would be assigned to a select with no
    // matching option, the browser would clear it, and the snapshot would
    // save an empty person, losing the drafted identity (fetta 10, P2 di #481).
    const draftKnown = draftPerson === '' || rows.length === 0 || groupOf(draftPerson) !== null;
    const current = draftKnown ? (keptPerson !== '' ? keptPerson : draftPerson) : draftPerson;
    const known = rows.length > 0 && (current === '' || groupOf(current) !== null);
    if (!known) {
      const input = el(doc, 'input', { attrs: { type: 'text', name: 'teamMemberId', placeholder: 'Persona del team' } });
      if (current !== '' && !current.includes('|')) input.value = current;
      if (current.includes('|')) {
        // A pipe id never paints: the visible field stays empty while the
        // opaque identity rides in state for the claim only.
        state.manual = { ...(state.manual ?? {}), teamMemberId: current };
      }
      input.addEventListener('input', () => {
        state.manual = { ...(state.manual ?? {}), teamMemberId: String(input.value ?? '') };
      });
      form.appendChild(input);
      return input;
    }
    // One option per PERSON under the person label (backlog:810ed0bf:
    // the Team card and this menu read the same personRows, so three
    // identities of Dan are one «Dan» here too). The row's option carries
    // the exact chosen or drafted subject — never the row primary — so
    // the claim books precisely the identity the operator or the AI
    // named, with no silent remap to another opaque subject.
    const currentRow = current === '' ? null : groupOf(current);
    const shown = current;
    const options = [{ value: '', label: 'Scegli una persona…' },
      ...rows.map((row) => ({
        value: currentRow === row && current !== '' ? current : row.id,
        label: row.identities.length > 1 ? `${row.label} (${row.identities.join(', ')})` : row.label,
      }))];
    const wrap = uiSelect(doc, { name: 'teamMemberId', value: shown, options });
    const select = wrap.querySelector('select');
    if (select) {
      if (shown !== '') select.value = shown;
      const track = () => {
        state.manual = { ...(state.manual ?? {}), teamMemberId: String(select.value ?? '') };
      };
      select.addEventListener('input', track);
      select.addEventListener('change', track);
      form.appendChild(wrap);
      return select;
    }
    return wrap;
  }

  /**
   * backlog:810ed0bf — the manual form's service field: a menu of the
   * bookable catalog singles (the same singles rule the booking worker
   * applies, read once with the week labels), never free text. The first
   * entry is preselected — the first bookable single, the same singles
   * rule the worker's default-service is confirmed against — and the price
   * field prefills from the chosen entry. The price follows every service
   * change; a typed price sticks until the service changes again. Without
   * a readable catalog the old typed field stays, and the server refuses
   * unknown keys in Italian under the field.
   * @param {any} form @param {any} priceInput
   */
  function renderServiceChoice(form, priceInput) {
    const bookable = Array.isArray(state.catalogServices) ? state.catalogServices : null;
    const paintUnder = (node) => {
      if (state.serviceError) {
        // Production 07/11: a refused service names its cause under the
        // field, never «Riprova più tardi». The hint clears on input AND
        // on change: a menu switch fires change only, and a stale refusal
        // must never stay painted under the newly chosen service.
        const hint = el(doc, 'small', { className: 'field-error', attrs: { role: 'alert', 'data-role': 'service-error' }, text: state.serviceError });
        node.setAttribute('aria-invalid', 'true');
        const clear = () => {
          state.serviceError = '';
          hint.setAttribute('class', 'field-error hidden');
          node.setAttribute('aria-invalid', 'false');
        };
        node.addEventListener('input', clear);
        node.addEventListener('change', clear);
        form.appendChild(hint);
      }
    };
    if (bookable === null || bookable.length === 0) {
      const input = el(doc, 'input', { attrs: { type: 'text', name: 'serviceKey', placeholder: 'Servizio' } });
      if (state.manual?.serviceKey != null) input.value = String(state.manual.serviceKey);
      input.addEventListener('input', () => {
        state.manual = { ...(state.manual ?? {}), serviceKey: String(input.value ?? '') };
      });
      form.appendChild(input);
      paintUnder(input);
      return input;
    }
    const kept = typeof state.manual?.serviceKey === 'string' ? state.manual.serviceKey : '';
    const drafted = typeof state.draftFill?.serviceKey === 'string' ? state.draftFill.serviceKey : '';
    const wanted = kept !== '' ? kept : drafted;
    // A kept or drafted service is never replaced by the default: the
    // match is case-insensitive (plus the catalog-name mapping), and an
    // unknown key keeps the typed value in a text field instead of
    // booking a service the operator never chose. Only with nothing kept
    // and nothing drafted does the first entry preselect.
    const mapped = serviceKeyFor(wanted, state.services);
    const match = bookable.find((entry) => entry.key === wanted)
      ?? bookable.find((entry) => entry.key === wanted.toLowerCase())
      ?? bookable.find((entry) => entry.key === mapped)
      ?? (wanted === '' ? bookable[0] : null);
    if (match === null) {
      const input = el(doc, 'input', { attrs: { type: 'text', name: 'serviceKey', placeholder: 'Servizio' } });
      input.value = wanted;
      state.manual = { ...(state.manual ?? {}), serviceKey: wanted };
      input.addEventListener('input', () => {
        state.manual = { ...(state.manual ?? {}), serviceKey: String(input.value ?? '') };
      });
      form.appendChild(input);
      paintUnder(input);
      return input;
    }
    const priceText = (entry) => formatPriceCents(entry.priceCents) ?? '';
    const options = bookable.map((entry) => ({
      value: entry.key,
      label: `${entry.name} · ${priceText(entry)} €`,
    }));
    const wrap = uiSelect(doc, { name: 'serviceKey', value: match.key, options });
    const select = wrap.querySelector('select') ?? wrap;
    select.value = match.key;
    const track = () => {
      const chosen = bookable.find((entry) => entry.key === String(select.value ?? '')) ?? null;
      state.manual = { ...(state.manual ?? {}), serviceKey: String(select.value ?? '') };
      if (chosen !== null && priceInput) {
        priceInput.value = priceText(chosen);
        state.manual = { ...(state.manual ?? {}), price: priceInput.value };
      }
    };
    select.addEventListener('input', track);
    select.addEventListener('change', track);
    // The default is already chosen (backlog:810ed0bf): the price paints
    // with it unless the operator already typed their own price. The
    // default never lands in state: the claim, the snapshot and the next
    // render all read the live menu, so a preselect stored here could
    // never shadow a later draft as a «kept» choice (a kept choice is
    // only what the operator or an absorbed draft actually set).
    if (priceInput && (typeof state.manual?.price !== 'string' || state.manual.price === '')) {
      priceInput.value = priceText(match);
      state.manual = { ...(state.manual ?? {}), price: priceInput.value };
    }
    form.appendChild(wrap);
    paintUnder(select);
    return select;
  }

  function renderManual() {
    // Closed until «Nuovo appuntamento → Compila manualmente» (prototype): the
    // form stays in the DOM, so a draft can still prefill it.
    const panel = el(doc, 'div', { className: `panel cal-manual${state.manualOpen || state.draftFill || state.manual ? ' open' : ''}` });
    state.manualPanel = panel;
    panel.appendChild(el(doc, 'h2', { text: 'Nuovo appuntamento' }));
    panel.appendChild(el(doc, 'p', {
      className: 'lede',
      text: 'Compila e premi «Proponi»: niente è scritto finché non premi «Conferma».',
    }));
    // The done state leads the panel (production 07/11): after «booked» the
    // operator reads what was booked first, never a stale draft note.
    if (state.confirmed) {
      panel.appendChild(el(doc, 'p', {
        className: 'cal-ok',
        attrs: { role: 'status', 'data-role': 'booked' },
        text: `Prenotato: ${memberLabelFor(state.confirmed.teamMemberId, parseMemberFilter(state.memberFilter), state.members)} · ${romeShortDay(state.confirmed.startsAt) ?? ''} ${romeTime(state.confirmed.startsAt) ?? ''}.`,
      }));
    }
    const form = el(doc, 'div', { className: 'cal-form' });
    // The customer is picked by name from the search, never typed as an id
    // or a resource (owner 29/10): the search block below owns the pick, so
    // no raw customer field paints here.
    renderCustomerPick(form);
    const inputs = {};
    // The person is chosen from the known team, never typed as an opaque id
    // while the team is known (fetta 9): the select owns the claim value.
    inputs.teamMemberId = renderPersonChoice(form);
    // The price rides the chosen catalog entry (backlog:810ed0bf): it
    // prefills from the menu default and follows every service change
    // until the operator types their own price.
    const priceInput = el(doc, 'input', { attrs: { type: 'text', name: 'price', placeholder: 'Prezzo EUR (es. 45.00)' } });
    if (state.manual?.price != null) priceInput.value = String(state.manual.price);
    priceInput.addEventListener('input', () => {
      state.manual = { ...(state.manual ?? {}), price: String(priceInput.value ?? '') };
    });
    // The service is a catalog menu with the default already chosen, never
    // free text (backlog:810ed0bf): the claim sends the menu key the worker
    // books by, with its price precompiled beside it.
    inputs.serviceKey = renderServiceChoice(form, priceInput);
    form.appendChild(priceInput);
    inputs.price = priceInput;
    const fields = [
      ['date', 'date', 'Giorno'],
      ['start', 'time', 'Inizio'],
      ['end', 'time', 'Fine'],
      ['notes', 'text', 'Note'],
    ];
    for (const [name, type, placeholder] of fields) {
      const input = el(doc, 'input', { attrs: { type, name, placeholder } });
      // Keep what the operator typed: a re-render (propose, slots, week)
      // rebuilds the inputs, so restore the last manual values first — and
      // track every keystroke live, so an unrelated re-render (week load,
      // slot search, phrase draft) never discards unsubmitted edits.
      if (state.manual?.[name] != null) input.value = String(state.manual[name]);
      input.addEventListener('input', () => {
        state.manual = { ...(state.manual ?? {}), [name]: String(input.value ?? '') };
      });
      inputs[name] = input;
      form.appendChild(input);
    }
    // Live nodes for the slot Conferma: it books the claim the operator
    // sees, not a stale snapshot.
    state.manualNodes = inputs;
    // state.manualFirst is the customer search field (or the «Cambia
    // cliente» button over an existing pick), set by renderCustomerPick
    // above so «Compila manualmente» focuses the customer first.
    if (state.draftFill) {
      state.manualOpen = true;
      const draft = state.draftFill;
      if (draft.teamMemberId) {
        // The select offers one row per person whose option carries the
        // exact drafted subject, so a draft naming a known identity lands
        // on the person's row AND books that exact identity; a pipe
        // outsider never paints — its identity already rides in state for
        // the claim only.
        const raw = String(draft.teamMemberId);
        const people = personRows(parseMemberFilter(state.memberFilter), state.hiddenMembers, state.members);
        const person = people.find((row) => row.ids.includes(raw));
        if (inputs.teamMemberId?.tagName === 'SELECT') {
          if (person) inputs.teamMemberId.value = raw;
        } else if (person || !raw.includes('|')) inputs.teamMemberId.value = raw;
      }
      if (draft.serviceKey) {
        // The service is a menu (backlog:810ed0bf): a drafted key the
        // catalog knows lands on its option (case-insensitively, like the
        // menu match); an unknown one already paints as typed text from
        // the menu render, so here it only needs its value confirmed.
        const rawService = String(draft.serviceKey);
        if (inputs.serviceKey?.tagName === 'SELECT') {
          const bookable = Array.isArray(state.catalogServices) ? state.catalogServices : [];
          const hit = bookable.find((entry) => entry.key === rawService)
            ?? bookable.find((entry) => entry.key === rawService.toLowerCase())
            ?? null;
          if (hit !== null) {
            inputs.serviceKey.value = hit.key;
            const priceText = formatPriceCents(hit.priceCents) ?? '';
            if (inputs.price) inputs.price.value = priceText;
            state.manual = { ...(state.manual ?? {}), serviceKey: hit.key, price: priceText };
          }
        } else inputs.serviceKey.value = rawService;
      }
      if (draft.notes) inputs.notes.value = String(draft.notes);
      // backlog:65ed7430 — a day-only phrase rides draft.day with no hour:
      // prefill the day and ask the hour, never paint an invented midnight.
      const dayKey = draftDayKey(draft);
      if (dayKey) inputs.date.value = dayKey;
      // A day-only draft (a Rome-midnight start, or `day` with no startsAt)
      // leaves the hours to choose: clear them, so neither 00:00 nor a stale
      // hour from an earlier edit is ever booked as stated (backlog:65ed7430).
      if (draftDayOnly(draft) || draft.startsAt === undefined) inputs.start.value = '';
      else if (romeTime(draft.startsAt)) inputs.start.value = romeTime(draft.startsAt);
      if (draftDayOnly(draft) || draft.endsAt === undefined) inputs.end.value = '';
      else if (romeTime(draft.endsAt)) inputs.end.value = romeTime(draft.endsAt);
      // The draft has been absorbed into the visible form: snapshot it, so
      // a later re-render keeps the draft values instead of replaying them
      // over the operator's own edits. A pipe outsider never painted, so an
      // empty field keeps the drafted identity from state, not a blank.
      const absorbed = snapshotManual(inputs);
      if (absorbed.teamMemberId === '' && typeof draft.teamMemberId === 'string' && draft.teamMemberId !== '') {
        absorbed.teamMemberId = String(draft.teamMemberId);
      }
      state.manual = absorbed;
      state.draftFill = null;
    }
    const propose = el(doc, 'button', { className: 'primary small', text: 'Proponi' });
    propose.addEventListener('click', () => void submitBooking(inputs, false));
    const confirm = el(doc, 'button', { className: 'secondary small', text: 'Conferma' });
    confirm.addEventListener('click', () => void submitBooking(inputs, true));
    form.appendChild(propose);
    form.appendChild(confirm);
    panel.appendChild(form);
    if (state.bookingNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: state.bookingNote }));
    return panel;
  }

  /** Prefill the manual form from a phrase draft or a picked slot. */
  function fillManual(draft) {
    state.draftFill = draft;
    renderAll();
  }

  /** Live manual values, field by field, as the operator sees them. */
  function snapshotManual(inputs) {
    return Object.fromEntries(
      Object.entries(inputs).map(([name, node]) => [name, String(node?.value ?? '')]),
    );
  }

  /** Build the booking claim from the manual form: Rome day + HH:MM to instants. */
  function claimFrom(inputs) {
    const read = (name) => String(inputs[name]?.value ?? '').trim();
    const day = read('date');
    const start = read('start');
    const end = read('end');
    const startsAt = day !== '' && start !== '' ? romeInstant(day, start) : null;
    const endsAt = day !== '' && end !== '' ? romeInstant(day, end) : null;
    const priceCents = priceToCents(read('price'));
    const member = claimedMember(inputs);
    // The customer rides the name-search pick, never a typed id or
    // resource: without a pick the historical contact/empty fallback stays.
    const customer = pickedCustomer();
    return {
      claim: {
        spaceId: readSpace(),
        subject: { resource: customer.resource, id: customer.id, owner: 'host' },
        teamMemberId: member,
        serviceKey: serviceKeyFor(read('serviceKey'), state.services),
        priceCents,
        currency: 'EUR',
        startsAt,
        endsAt,
        notes: read('notes') === '' ? null : read('notes'),
        sourceKey: member !== '' && startsAt
          ? `calendario:${member}:${startsAt}:${customer.id || 'senza-cliente'}`
          : undefined,
        source: { package: 'host', action: 'calendar-book' },
      },
    };
  }

  /** Rome day + HH:MM to an ISO instant, or null when not a real time. */
  function romeInstant(day, hm) {
    const [hour, minute] = String(hm).split(':').map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return null;
    return romeWallToIso(day, hour, minute);
  }

  /**
   * Interpret HH:MM on a Rome day as a Rome wall time, returned as ISO.
   * Solved by round-trip: guess UTC, read back the Rome wall datetime,
   * correct the guess. A late-evening guess reads back on the next Rome
   * day, so whole-day drift is corrected separately from minutes — and the
   * answer is accepted only when the full Rome wall datetime (day, hour,
   * minute) matches. A drift that cannot be corrected fails closed (null),
   * never books the wrong date. The server re-checks DST edges on write.
   */
  function romeWallToIso(day, hour, minute) {
    const fmt = (instant) => {
      try {
        const seenDay = romeDayKey(instant);
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(instant);
        const get = (type) => Number(parts.find((part) => part.type === type)?.value);
        if (seenDay === null || Number.isNaN(get('hour')) || Number.isNaN(get('minute'))) return null;
        return { day: seenDay, h: get('hour') % 24, m: get('minute') };
      } catch {
        return null;
      }
    };
    let guess = Date.parse(`${day}T${pad(hour)}:${pad(minute)}:00Z`);
    if (Number.isNaN(guess)) return null;
    for (let pass = 0; pass < 3; pass += 1) {
      const seen = fmt(new Date(guess));
      if (!seen) return null;
      if (seen.day === day && seen.h === hour && seen.m === minute) return new Date(guess).toISOString();
      if (seen.day !== day) {
        const drift = Math.round((Date.parse(`${seen.day}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
        if (!Number.isFinite(drift) || drift === 0) return null;
        guess -= drift * 86400000;
        continue;
      }
      guess += ((hour * 60 + minute) - (seen.h * 60 + seen.m)) * 60000;
    }
    const seen = fmt(new Date(guess));
    if (!seen || seen.day !== day || seen.h !== hour || seen.m !== minute) return null;
    return new Date(guess).toISOString();
  }

  /** @param {number} value */
  function pad(value) {
    return String(value).padStart(2, '0');
  }

  /**
   * Required manual fields of the live form nodes, checked before any
   * request: empty ones are named in Italian next to the form, and nothing
   * is sent until the operator fills them (backlog:9046f940).
   */
  function missingManualFields(inputs) {
    return missingBookingFields(
      {
        teamMemberId: claimedMember(inputs),
        serviceKey: String(inputs.serviceKey?.value ?? ''),
        date: String(inputs.date?.value ?? ''),
        start: String(inputs.start?.value ?? ''),
        end: String(inputs.end?.value ?? ''),
      },
      Boolean(state.customerPick && typeof state.customerPick.id === 'string' && state.customerPick.id !== ''),
    );
  }

  /** @param {any} inputs @param {boolean} confirm */
  async function submitBooking(inputs, confirm) {
    await ensureServices();
    const { claim } = claimFrom(inputs);
    // The manual form is the source of truth for this submit: remember every
    // raw value (draft-derived ones included) so the re-render after propose
    // shows the same form Conferma will book. The draft has been absorbed.
    // A pipe outsider never painted: an empty field must not wipe the
    // identity the claim just booked.
    state.manual = snapshotManual(inputs);
    if (state.manual.teamMemberId === '' && typeof claim.teamMemberId === 'string' && claim.teamMemberId !== '') {
      state.manual.teamMemberId = claim.teamMemberId;
    }
    state.draftFill = null;
    state.confirmed = null;
    state.serviceError = '';
    const missing = missingManualFields(inputs);
    if (missing.length > 0) {
      state.bookingNote = `Mancano dei dati: ${missing.join(', ')}. Compilali prima di confermare.`;
      renderAll();
      return;
    }
    const presend = servicePresendError(claim.serviceKey);
    if (presend !== null) {
      // Same rule as the slot Conferma above (backlog:9a853f44): one
      // function, both callers — a typed service the server could never
      // book never leaves the form, on Proponi or Conferma alike.
      state.serviceError = presend;
      state.bookingNote = 'Prenotazione non riuscita: scegli un servizio dal listino.';
      renderAll();
      return;
    }
    // The queued write can take a while on the pilot: the stale «Bozza
    // pronta» never stays on screen while Conferma is in flight.
    state.bookingNote = confirm ? 'Prenotazione in corso…' : 'Controllo lo slot…';
    renderAll();
    try {
      if (!confirm) {
        const proposed = await client.request('/api/appointments/propose', {
          method: 'POST',
          body: claim,
        });
        state.bookingNote = proposed?.decision === 'proposal'
          ? 'Registrata come proposta: lo spazio non fissa in automatico.'
          : 'Bozza pronta: premi «Conferma» per scriverla davvero.';
        renderAll();
        return;
      }
      // Explicit confirmation rides the idempotent confirm operation
      // directly: the server re-checks the slot and replays the same source
      // key, so a retry after a committed-but-lost confirm reaches the
      // replay instead of dying on propose against the confirmed row.
      const booked = await client.request('/api/appointments/confirm', {
        method: 'POST',
        body: { ...claim, confirmed: true },
      });
      if (booked?.decision === 'booked') {
        markBooked(booked.appointment ?? claim);
      } else {
        state.bookingNote = 'Registrata come proposta: lo spazio non fissa in automatico.';
      }
    } catch (error) {
      if (isServiceRefusal(error)) {
        // The cause is the service field: the sentence sits under it, and
        // the panel note says what to do, never «Riprova più tardi».
        console.warn('bo-calendario booking refused:', String(error?.code ?? 'unknown'), `spaceId=${readSpace()}`);
        state.serviceError = calendarRefusalText(error) ?? '';
        state.bookingNote = 'Prenotazione non riuscita: scegli un servizio dal listino.';
      } else {
        state.bookingNote = humanWriteError(error, {
          failed: 'Prenotazione non riuscita. Riprova più tardi.',
          notComposed: 'Il calendario non è composto in questo spazio.',
        });
      }
    }
    renderAll();
    reloadAfterBooking();
  }

  async function render() {
    // A space switch while on Calendario (review #664): the search in flight
    // and the queued request belong to the space just left — drop them, so
    // nothing of space A is read back or painted under space B.
    const space = readSpace();
    if (state.renderedSpace !== null && state.renderedSpace !== space) {
      phraseSeq += 1;
      state.aiLoading = false;
      state.phraseWaiting = false;
      state.phrasePending = null;
      state.aiNote = '';
      state.aiBlocked = null;
      state.phraseNoDraft = false;
      // Review #690 (P1): the customer search of space A dies with the
      // switch too — no pending timer fires under B, no answer read for A
      // paints A's customer names in B, and A's query, results and picked
      // customer never carry over into B's booking form.
      cancelCustomerSearch();
      state.customerQuery = '';
      state.customerItems = [];
      state.customerError = null;
      state.customerPartial = false;
      state.customerPick = null;
    }
    state.renderedSpace = space;
    // Voce 714433c2: «Nuovo appuntamento» from the scheda cliente stashes a
    // one-time pick the calendar takes here, once, on entry — read and
    // cleared, so a later visit starts unpicked. A fresh pick opens the
    // manual form around the named customer; without one the form keeps its
    // own state (an operator search in progress is never clobbered).
    const freshPick = takePendingCustomerPick(storage, 'appointment');
    if (freshPick !== null) {
      state.customerPick = freshPick;
      state.manualOpen = true;
    }
    renderAll();
    // The roster arrives beside the week and becomes the team once it
    // lands (auto-fill plus week load inside loadMembers); its failure is
    // silent by design (the typed filter stays). The connection state
    // arrives the same way and only adds the Profilo notice when the
    // profile positively reports no connected calendar.
    void loadMembers();
    void loadCalendar();
    // The service menu reads the catalog on entry (backlog:810ed0bf), not
    // only with the first week: the manual form shows its options and its
    // preselected default before any member is named. Shared in-flight
    // with the week labels; the settled read repaints while mounted.
    void ensureServices();
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0) await loadWeek(members);
  }

  return { render, invalidate };
}
