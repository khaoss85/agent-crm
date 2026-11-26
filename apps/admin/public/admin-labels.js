// @ts-check

import { NO_REPLY_WORD, isAutomatedSender, isNotificationMessage } from './admin-sender-kind.js';

/**
 * Shared operator vocabulary for message and call states (voce 52854fd292a3).
 *
 * The scheda cliente and the assistant panel read the same enum values from
 * interaction-message (`status`) and interaction-call (`outcome`); both say
 * them in the same plain Italian. An unknown value reads as a neutral Italian
 * word, never as the raw English key.
 */

/** Delivery/sync state, inbound or outbound, in the operator's words. */
export const SYNC_LABELS = Object.freeze({
  received: 'ricevuto',
  sent: 'inviato',
  delivered: 'consegnato',
  read: 'letto',
  failed: 'non consegnato',
  completed: 'completata',
  missed: 'persa',
  'no-answer': 'senza risposta',
});

/**
 * Outcome of one phone call as a summary says it («chiamata riuscita»,
 * «chiamata persa»): a call is not delivered, so `failed` reads «non
 * riuscita» here, and `completed` reads «riuscita».
 */
export const CALL_OUTCOME_LABELS = Object.freeze({
  completed: 'riuscita',
  missed: 'persa',
  'no-answer': 'senza risposta',
  failed: 'non riuscita',
});

/**
 * The Italian word of one enum value in `table`, `fallback` when the value is
 * missing or unknown — never the raw key.
 * @param {Readonly<Record<string, string>>} table
 * @param {unknown} value
 * @param {string} fallback
 */
export function italianLabel(table, value, fallback) {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(table, key) ? table[key] : fallback;
}

/**
 * State of one history import (`channel-import-state.status`, the
 * `sync.status` of the connectors reads) in the operator's words
 * (backlog:cf365ada15b9: the connector detail printed the raw `done`).
 */
export const IMPORT_STATE_LABELS = Object.freeze({
  running: 'in corso',
  done: 'completata',
  failed: 'non riuscita',
});

/** @param {unknown} status */
export const importStateLabel = (status) => italianLabel(IMPORT_STATE_LABELS, status, 'stato sconosciuto');

/** @param {unknown} outcome */
export const callOutcomeLabel = (outcome) => italianLabel(CALL_OUTCOME_LABELS, outcome, 'senza esito');

const ROME_CLOCK = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/Rome',
});

/**
 * Wall-clock time of an instant in Europe/Rome («06:25:28»), '' when the
 * value is not a readable instant. Never a UTC stamp on screen.
 * @param {unknown} value
 */
export function romeClock(value) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '';
  return ROME_CLOCK.format(new Date(ms));
}

/**
 * Placeholder words older writers stored instead of a name. Before #606 the
 * sender path created contacts as `Unknown Unknown` (or kept the real first
 * name beside `lastName: 'Unknown'`, so Oggi read «PayPal Unknown»), and the
 * lead path still stores `—` as the last name of a one-token address. None of
 * them names anyone: they are dropped from what the operator reads.
 */
const NAME_PLACEHOLDERS = new Set([
  'unknown', 'sconosciuto', 'sconosciuta', 'n/a', 'na', 'null', 'undefined', 'none', '-', '—', '–',
]);

/** An address-shaped word; a lone `@` or a handle is not one (review #739). */
const ADDRESS_WORD = /^[<("']*[^@\s<>()"']+@[^@\s<>()"']+\.[^@\s<>()"']+[>)"',;:]*$/;

/**
 * A bare reply word: a mailbox token, never a surname on its own
 * (backlog:088b639d96a2). In the read path it drops only past a kept
 * surname (review rev-agent-crm-955-d7262d39, so `John Reply` stays):
 * a word in the middle stays.
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
  for (;;) {
    const trailing = /\s*\([^()]*\)\s*$/.exec(out);
    if (trailing) {
      out = out.slice(0, trailing.index);
      continue;
    }
    const pipe = out.indexOf('|');
    if (pipe >= 0) {
      out = out.slice(0, pipe);
      continue;
    }
    return out;
  }
}

/**
 * A stored name with its placeholder words dropped («PayPal Unknown» reads
 * «PayPal»), null when nothing real is left. A name that carries an
 * address (`Mittente: x@…`, or a bare email used as a label) names nobody:
 * null, never the long address on screen (production 10/11). The address
 * check runs on the whole stored value first, so a qualifier never hides
 * an address (`Mario (x@y.com)` still names nobody).
 * The browser twin of customer-data `readableName` (display-name.js): the
 * bundle cannot import a package, so tests/customer-display-name.test.js
 * runs both on the same table.
 * @param {unknown} value
 * @returns {string | null}
 */
export function readableName(value) {
  if (typeof value !== 'string') return null;
  const words = value.trim().split(/\s+/).filter((word) => word !== '');
  if (words.some((word) => ADDRESS_WORD.test(word))) return null;
  const head = stripNameQualifier(value.trim()).split(/\s+/).filter((word) => word !== '');
  const kept = head.filter((word) => !NAME_PLACEHOLDERS.has(word.toLowerCase()) && !(word.includes('_') && /\d/.test(word)));
  while (kept.length > 0) {
    const last = kept[kept.length - 1].replace(NAME_WRAPPING, '');
    if (NO_REPLY_WORD.test(last)) {
      kept.pop();
      continue;
    }
    if (BARE_REPLY_WORD.test(last) && kept.length > 2) {
      kept.pop();
      continue;
    }
    break;
  }
  const text = kept.join(' ');
  return text !== '' && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/**
 * The sender rule lives in the kernel (core/sender-kind.js); the /bo shell
 * reads its byte-identical copy and re-exports it here for the screens
 * (backlog:bab63e32acdb, backlog:c2bf6b206d96).
 */
export { isAutomatedSender, isNotificationMessage };

/**
 * Display name from a read-only customer profile
 * (`GET /api/customer-data/profile/:resource/:id`): the contact's full name,
 * else the company name. The email is deliberately not a «nome», and an
 * unknown customer resolves to null (the caller falls back to its own label
 * or handle) — never a guessed name, and never a stored placeholder such as
 * `Unknown` (backlog:5083e7a77c26). Shared by Calendario and Oggi.
 * @param {any} profile
 * @returns {string | null}
 */
export function nameFromProfile(profile) {
  // The provider's display name first (customer-data display-name.js): the
  // one rule every screen reads, with the domain label for a nameless
  // address. A profile from before the field keeps the join below.
  const provided = profile?.identity?.displayName;
  // An explicit null is the provider's verdict «no name» (review #739 giro
  // 2): only a profile without the field falls back to the join below.
  if (provided === null) return null;
  if (typeof provided === 'string') return readableName(provided);
  const contact = profile?.identity?.contact ?? null;
  const full = readableName([contact?.firstName, contact?.lastName]
    .filter((part) => typeof part === 'string')
    .join(' '));
  if (full !== null) return nameWithoutAddressEchoes(full, contact?.email);
  return readableName(profile?.identity?.company?.name);
}

/**
 * The name without the pieces it repeats from its own address
 * («Amazon.it It» reads «Amazon.it»): the browser twin of customer-data
 * `nameWithoutAddressEchoes`, held to it by the parity test in
 * tests/customer-display-name.test.js (seguito P3 di #743).
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
 * Whether a member text is a technical identity rather than a name
 * (production 10/11: Oggi › Agenda read «broker+adopted-…@accordo.invalid»
 * and «google|1049…», Spazi e accessi listed the broker mailboxes): a
 * provider subject (`google|…`, `github|…`) or the broker's reserved mailbox
 * (`broker+…`, `…@accordo.invalid`) never reaches the screen.
 * @param {unknown} value
 */
export function isTechnicalMemberText(value) {
  if (typeof value !== 'string') return true;
  const text = value.trim().toLowerCase();
  return text === '' || text.includes('|') || text.startsWith('broker+') || text.endsWith('@accordo.invalid');
}

/**
 * A lower-case id joined by `-` or `_` («coach-guido», a UUID): the shape
 * of a stored id (a roster subject, an offer owner), read through
 * `subjectText` — never applied to a displayName, so a real name with a
 * hyphen («anna-maria») is never hidden (review Muse #750).
 */
const SLUG_SHAPE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

/**
 * A member text worth showing (a roster displayName or mailbox), trimmed,
 * or null when it is empty or technical. The one filter every team screen
 * (Oggi, Calendario, Spazi e accessi) reads member text through.
 * @param {unknown} value
 * @returns {string | null}
 */
export function memberText(value) {
  if (typeof value !== 'string' || isTechnicalMemberText(value)) return null;
  return value.trim();
}

/**
 * A stored id (a roster subject, an offer referente, a reporting owner) as
 * words, or null (backlog:b3d88f6e38ef, ddf7f416ad22): a technical id never
 * shows, a slug reads as words («coach-guido» → «Coach Guido»; one with
 * digits, like «user-12345» or a UUID, names nobody), a one-word
 * lower-case id reads as a name («marco» → «Marco», design check #750),
 * anything else — a typed name, a real mailbox — reads as itself.
 * @param {unknown} value
 * @returns {string | null}
 */
export function subjectText(value) {
  const text = memberText(value);
  if (text === null) return null;
  if (SLUG_SHAPE.test(text)) return slugAsName(text);
  if (/^[a-zà-ÿ]+$/.test(text)) return text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}

/**
 * A letters-only slug as a person says it («coach-guido» → «Coach Guido»,
 * the scheda's `teamName` rule), null for anything else: a slug with
 * digits («user-12345», a UUID) names nobody.
 * @param {unknown} value
 * @returns {string | null}
 */
export function slugAsName(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[a-zà-ÿ]+(?:[-_][a-zà-ÿ]+)+$/.test(text)) return null;
  return text.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** The control-plane same-person key of a roster row, or null. @param {any} member */
function operatorKeyOf(member) {
  const value = member?.operatorAccountId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Member creation instant (epoch ms), or null. @param {any} member */
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
 * The profile name of a person among the names of their identities: a full
 * name («Daniele Pelleri») beats a handle («khaoss85»), a capitalised one
 * beats a lower-case copy («daniele pelleri»); ties keep roster order.
 * @param {Array<string>} names
 */
function profileName(names) {
  let best = null;
  let bestScore = -1;
  for (const name of names) {
    const score = (/\s/.test(name) ? 2 : 0) + (/^\p{Lu}/u.test(name) ? 1 : 0);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The session profile's own member (name and mailbox) from a `/api/profile`
 * answer, or null. Both fields pass the same member-text filter the team
 * rows use, so a technical id never becomes a name. backlog:71a6574a: the
 * self row's fallback when the roster leaves it with a bare handle.
 * @param {unknown} answer
 */
export function profileMemberOf(answer) {
  const member = answer !== null && typeof answer === 'object'
    ? /** @type {{member?: unknown}} */ (answer).member
    : null;
  if (member === null || typeof member !== 'object') return null;
  const shaped = /** @type {{name?: unknown, email?: unknown}} */ (member);
  const name = memberText(shaped.name);
  const email = memberText(shaped.email);
  if (name === null && email === null) return null;
  return { name, email };
}

/**
 * backlog:3ce220e60c33 (famiglia F5) — the team as PEOPLE, one row each.
 * The roster (`GET /api/spine/memberships`) lists one row per identity
 * (broker+adopted, github, google): rows join on the control-plane person
 * key (`operatorAccountId`) first, then — only without two different keys —
 * when mailbox AND display name both match (trimmed, case-insensitive). A
 * mailbox alone never joins (a shared info@ would fold a stranger), a name
 * alone never joins (two homonyms are two people): the agent-crm#644/#742
 * rule. Each row carries the profile name, the first real mailbox and a
 * `label` that never shows a technical id (`broker+…@accordo.invalid`,
 * `google|…`, `github|…`, a slug like `coach-guido`): name, else mailbox,
 * else a plain subject, else «Membro del team»; two rows with the same label
 * read «Rossi (1)», «Rossi (2)» in member-creation order.
 * Team, «Scegli una persona…», Calendario, Spazi e accessi, Oggi, Reporting
 * and the offer screens all read people through this one function.
 * @param {unknown} roster `/api/spine/memberships` items
 * @returns {Array<{subjects: string[], members: any[], keys: string[], name: string|null, email: string|null, known: boolean, label: string, born: number|null, index: number}>}
 */
export function teamPeople(roster) {
  const list = Array.isArray(roster) ? roster : [];
  /** @type {Array<any>} */
  const people = [];
  const byKey = new Map();
  const byIdentity = new Map();
  const seen = new Set();
  for (const member of list) {
    if (!member || typeof member !== 'object' || typeof member.subject !== 'string' || member.subject === '') continue;
    if (seen.has(member.subject)) continue;
    seen.add(member.subject);
    const key = operatorKeyOf(member);
    const email = memberText(member.email);
    const rawName = memberText(member.displayName);
    const identity = email === null || rawName === null
      ? null
      : `${email.toLowerCase()}\u0000${rawName.replace(/\s+/g, ' ').toLowerCase()}`;
    let person = (key !== null && byKey.get(key)) || null;
    if (person === null && identity !== null) {
      const candidate = byIdentity.get(identity) ?? null;
      // Two different person keys never fold into one row, whatever the
      // mailbox and name say.
      if (candidate !== null && (key === null || candidate.keys.length === 0 || candidate.keys.includes(key))) person = candidate;
    }
    if (person === null) {
      person = { subjects: [], members: [], keys: [], names: [], email: null, born: null, index: people.length };
      people.push(person);
    }
    person.subjects.push(member.subject);
    person.members.push(member);
    if (key !== null && !person.keys.includes(key)) person.keys.push(key);
    if (key !== null && !byKey.has(key)) byKey.set(key, person);
    if (identity !== null && !byIdentity.has(identity)) byIdentity.set(identity, person);
    // backlog:e52c5e0dd49f (review Muse #750 giro 2): a slug-shaped
    // displayName on a plain stored id is an unenriched echo of the id, not
    // a name («coach-guido» on subject «coach-guido»): it reads as words,
    // never the raw slug (a digit slug names nobody and drops out). A
    // displayName on a technical subject (a pipe id) is a genuine name
    // signal and reads verbatim («anna-maria»).
    const name = rawName !== null && SLUG_SHAPE.test(rawName) && !isTechnicalMemberText(member.subject)
      ? slugAsName(rawName)
      : rawName;
    if (name !== null) person.names.push(name);
    if (person.email === null && email !== null) person.email = email;
    const born = memberBornAt(member);
    if (born !== null) person.born = person.born === null ? born : Math.min(person.born, born);
  }
  const rows = people.map((person) => {
    const name = profileName(person.names);
    const plain = person.subjects.map((subject) => subjectText(subject)).find((text) => text !== null) ?? null;
    return {
      subjects: person.subjects,
      members: person.members,
      keys: person.keys,
      name,
      email: person.email,
      known: name !== null || person.email !== null || plain !== null,
      base: name ?? person.email ?? plain ?? 'Membro del team',
      born: person.born,
      index: person.index,
    };
  });
  const byBase = new Map();
  for (const row of rows) {
    // backlog:6563edf41aab: same name modulo case is one unreadable pair —
    // «Daniele Pelleri» and «daniele pelleri» number like the homonyms,
    // never two identical-looking rows.
    const key = row.base.toLowerCase();
    byBase.set(key, [...(byBase.get(key) ?? []), row]);
  }
  const ordinal = new Map();
  for (const same of byBase.values()) {
    if (same.length < 2) continue;
    const dated = same.every((row) => row.born !== null);
    [...same]
      .sort((a, b) => (dated ? (a.born - b.born || a.index - b.index) : a.index - b.index))
      .forEach((row, at) => ordinal.set(row, at + 1));
  }
  return rows.map((row) => {
    const { base, ...rest } = row;
    return { ...rest, label: ordinal.has(row) ? `${base} (${ordinal.get(row)})` : base };
  });
}

/**
 * `teamPeople` rows for an id lookup: roster items or already-built rows.
 * @param {unknown} rosterOrPeople roster items or `teamPeople` rows
 */
function rowsOf(rosterOrPeople) {
  const list = Array.isArray(rosterOrPeople) ? rosterOrPeople : [];
  return list.length > 0 && Array.isArray(list[0]?.subjects) ? list : teamPeople(list);
}

/**
 * The person row behind an id — a roster subject or a control-plane
 * person key (`operatorAccountId`, the actor of an audit entry) — or null.
 * @param {unknown} id
 * @param {unknown} rosterOrPeople roster items or `teamPeople` rows
 */
export function personOf(id, rosterOrPeople) {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const wanted = id.trim();
  const list = Array.isArray(rosterOrPeople) ? rosterOrPeople : [];
  const people = list.length > 0 && Array.isArray(list[0]?.subjects) ? list : teamPeople(list);
  const exact = people.find((row) => row.subjects.includes(wanted) || row.keys.includes(wanted)) ?? null;
  if (exact !== null) return exact;
  // backlog:3f3c143b (seguito di #918): an audit may record another
  // identifier of the same person — their mailbox or display name — while
  // the roster holds the opaque subject. The same resolution function
  // matches every identity the person's members carry, but only when a
  // single person claims it: a shared mailbox or a homonym name never picks
  // a person (agent-crm#644/#742; review Codex su #999: teamPeople keeps
  // the first mailbox and the preferred name only, so the row's `email`
  // and `name` alone cannot prove uniqueness).
  const folded = wanted.toLowerCase();
  const claimed = people.filter((row) => identitiesOf(row).has(folded));
  if (claimed.length === 1) return claimed[0];
  return null;
}

/**
 * backlog:3f3c143b (seguito di #918): every identifier one person row
 * claims — each member's real mailbox and display name, plus the row's own
 * email and profile name (hand-built rows carry no members). Lower-cased
 * and trimmed for the lookup; technical mailboxes and placeholder words
 * never count as a person's name.
 * @param {any} row one `teamPeople` row
 * @returns {Set<string>}
 */
function identitiesOf(row) {
  const out = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim().toLowerCase();
    if (text !== '' && !NAME_PLACEHOLDERS.has(text)) out.add(text);
  };
  for (const member of Array.isArray(row?.members) ? row.members : []) {
    if (member === null || typeof member !== 'object') continue;
    const mail = memberText(member.email);
    if (mail !== null) out.add(mail.toLowerCase());
    add(member.displayName);
  }
  add(row?.email);
  add(row?.name);
  return out;
}

/**
 * backlog:54a83e2fd0d2 — the author's word in cronologia, «Creata da»,
 * Storico and the scheda signatures (notes, outbound passages:
 * backlog:3f3c143b seguito): the row's own profile name, never the Team
 * ordinal («Rossi (2)») and never merged across rows (review Muse
 * rev-agent-crm-988 testa fe04fb68: two rows that paint the same name
 * modulo case stay distinct authors, each with its own casing — a
 * lower-cased name alone never joins people, agent-crm#644/#742). The same
 * person reads one author because it joins in one `teamPeople` row first
 * (same operatorAccountId, or same mailbox and name modulo case) and reads
 * that row's name.
 * @param {{ name?: string | null, email?: string | null, subjects?: Array<string> }} row
 * @returns {string | null}
 */
export function authorName(row) {
  const plain = Array.isArray(row?.subjects)
    ? row.subjects.map((subject) => subjectText(subject)).find((text) => text !== null) ?? null
    : null;
  return row?.name ?? row?.email ?? plain;
}

/**
 * The words a screen shows for a person id it stores (an offer referente,
 * a reporting owner, an owner filter, a Pipeline card): the team's
 * disambiguated label — «Rossi (1)»/«Rossi (2)» where the team numbers
 * homonyms — else the id as words (`subjectText`: a typed name or a real
 * mailbox reads as itself, a slug as words), else null — never a technical
 * mailbox or a provider id. Cronologia, «Creata da» and Storico never read
 * this: they read the author through `auditActorLabel`/`offerActorLabel`
 * (backlog:54a83e2fd0d2, no «(2)» there).
 * @param {unknown} id
 * @param {unknown} rosterOrPeople
 * @returns {string | null}
 */
export function personLabel(id, rosterOrPeople) {
  const rows = rowsOf(rosterOrPeople);
  const row = personOf(id, rows);
  if (row !== null) return row.known ? row.label : null;
  return subjectText(id);
}

/**
 * The name of the team member behind a subject, or null — never the id
 * itself when it is technical. Reads the person row of `teamPeople`, so an
 * identity without a name of its own borrows the profile name of the same
 * person. A subject the roster does not know reads as itself (a typed
 * name, a real mailbox, a slug as words); null only for a technical id or
 * a slug with digits that names nobody. A person the roster knows reads
 * the profile name, else their first real mailbox like `personLabel`
 * does, so Oggi shows the same mailbox Pipeline and Reporting show.
 * @param {unknown} subject
 * @param {unknown} members roster items
 * @returns {string | null}
 */
export function memberLabel(subject, members) {
  if (typeof subject !== 'string' || subject.trim() === '') return null;
  const row = teamPeople(members).find((person) => person.subjects.includes(subject)) ?? null;
  // backlog:e52c5e0dd49f (review Muse #750 giro 2): a person known only by
  // a real mailbox keeps it, like personLabel — never the notes snippet.
  if (row !== null) return row.name ?? row.email ?? subjectText(subject);
  return subjectText(subject);
}

const ROME_DAY_TIME = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Rome',
});

/**
 * Backlog 5a1e6d8dc42e: an instant as a person writes it, in Europe/Rome
 * («7 nov, 14:30»), null when the value is not a readable instant. Never a
 * raw ISO stamp on screen.
 * @param {unknown} value
 * @returns {string | null}
 */
export function italianDateTime(value) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return ROME_DAY_TIME.format(new Date(ms)).replace(/\./g, '');
}

/**
 * Commercial states in the operator's words: quote states and the core
 * opportunity stages. Backlog a551982c06eb: one map for every screen that
 * names the state of an offer.
 */
export const OFFER_STATE_LABELS = Object.freeze({
  sent: 'inviata', draft: 'bozza', approved: 'approvata', rejected: 'rifiutata',
  open: 'aperta', won: 'vinta', lost: 'persa', expired: 'scaduta', accepted: 'accettata',
  pending_approval: 'in attesa di approvazione', approval_pending: 'in attesa di approvazione',
  discovery: 'scoperta', qualification: 'qualificazione', proposal: 'proposta', negotiation: 'trattativa',
});

/**
 * The Italian word of one commercial state, null when unknown — own keys
 * only, so `constructor` or `__proto__` never read through.
 * @param {unknown} state
 * @returns {string | null}
 */
export function offerStateLabel(state) {
  const key = String(state ?? '').trim().toLowerCase();
  return Object.hasOwn(OFFER_STATE_LABELS, key) ? OFFER_STATE_LABELS[key] : null;
}

/**
 * Backlog a551982c06eb: the stage of one offer (opportunity) as every screen
 * says it — the scheda, the Pipeline board and the offer detail. A placed
 * offer reads its pipeline stage's own label from `/api/schema` `pipelines`
 * (its named pipeline first, like the board); an offer outside any composed
 * pipeline — including a placed offer whose pipelines are not readable here —
 * reads its core stage from OFFER_STATE_LABELS, never a prettified raw key.
 * Null when neither is known. A quote's approval state is not the offer's stage.
 * @param {unknown} pipelines `/api/schema` pipelines
 * @param {{ pipelineKey?: unknown, pipelineStage?: unknown, stage?: unknown } | null | undefined} offer
 * @returns {string | null}
 */
export function offerStageLabel(pipelines, offer) {
  if (!offer || typeof offer !== 'object') return null;
  const placed = typeof offer.pipelineStage === 'string' && offer.pipelineStage !== '' ? offer.pipelineStage : null;
  if (placed !== null) {
    const ordered = orderedPipelines(pipelines, offer.pipelineKey);
    for (const pipeline of ordered) {
      const stage = pipeline.stages.find((candidate) => candidate?.key === placed);
      if (stage) return typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : null;
    }
    // Review Muse #887 giro 2: a placed offer whose pipelines are not
    // readable here (the schema read failed or timed out) never derives a
    // label from the raw stage key — it reads its core stage in Italian
    // (or null, which every screen paints as an em dash).
  }
  return offerStateLabel(offer.stage);
}

/**
 * Backlog 169cd4bc988c: who one offer (opportunity row) is for, and where
 * their scheda lives — the contact first, else the company. The reserved
 * «Senza azienda» a contact without Azienda sits under, and any stored
 * placeholder company (`Unknown (…)`), name nobody: the same rule as the
 * scheda's shownCompanyName, so no screen reads «Per Senza azienda». Null
 * when the offer names no one.
 * @param {any} offer
 * @returns {{ name: string, href: string | null } | null}
 */
export function offerCustomer(offer) {
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const contactName = text(offer?.contactName);
  const contactId = text(offer?.contactId);
  if (contactName !== null) {
    return { name: contactName, href: contactId !== null ? `#/customer-card/contact/${encodeURIComponent(contactId)}` : null };
  }
  const company = text(offer?.companyName);
  const companyId = text(offer?.companyId);
  if (company === null) return null;
  // The core placeholder flag (backlog:ac65e448fcb4): a real company named
  // «Senza azienda» stays a customer. The name check below is only the
  // legacy fallback for rows without the flag — never the rule.
  if (offer?.companyPlaceholder === true || offer?.companyPlaceholder === 1) return null;
  if (offer?.companyPlaceholder !== false && offer?.companyPlaceholder !== 0) {
    const reserved = company.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase() === 'senza azienda';
    if (reserved) return null;
  }
  if (readableName(company.replace(/\([^)]*\)/g, ' ')) === null) return null;
  return { name: company, href: companyId !== null ? `#/customer-card/company/${encodeURIComponent(companyId)}` : null };
}

/**
 * Backlog 169cd4bc988c: a state word as a heading or a list shows it —
 * «Proposta», never the bare «proposta» — the first letter upper-cased,
 * the rest untouched. Null stays null.
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function upperFirst(text) {
  if (typeof text !== 'string' || text === '') return text ?? null;
  return text.charAt(0).toLocaleUpperCase('it-IT') + text.slice(1);
}

/**
 * Backlog c1649d1d: the label of one pipeline stage key for the state
 * history (scheda «Storia stati», offerta «Cronologia»). The named pipeline
 * first, like the scheda line and the board; any composed pipeline after it.
 * Null when no composed pipeline defines the key — the row then reads the
 * generic Italian line, never the raw key.
 * @param {unknown} pipelines `/api/schema` pipelines
 * @param {unknown} key the pipeline stage key
 * @returns {string | null}
 */
export function pipelineStageLabel(pipelines, key) {
  if (typeof key !== 'string' || key === '') return null;
  for (const pipeline of orderedPipelines(pipelines, null)) {
    const stage = pipeline.stages.find((candidate) => candidate?.key === key);
    if (stage) return typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : null;
  }
  return null;
}

/** Composed pipelines, the named one first when known; never what the server did not compose. */
function orderedPipelines(pipelines, name) {
  const list = (Array.isArray(pipelines) ? pipelines : []).filter((pipeline) => pipeline && Array.isArray(pipeline.stages));
  if (typeof name !== 'string' || name === '') return list;
  return [
    ...list.filter((pipeline) => pipeline.name === name),
    ...list.filter((pipeline) => pipeline.name !== name),
  ];
}

/**
 * Backlog c1649d1d: the from/to stage keys of one audit entry, or null when
 * the entry is not a state move. A pipeline move (`opportunity.updated`
 * whose data carries the `fromPipelineStage` the service stamps in
 * applyManaged) names pipeline keys; a core move (`opportunity.stage_changed`)
 * names core stages in `from`/`to`. Anything else — commercial edits, the
 * creation event, a move the data does not describe — is not a move.
 * @param {any} entry one `/api/audit` item
 * @returns {{ kind: 'pipeline' | 'core', from: string, to: string } | null}
 */
/**
 * Whether an audit row only records where the card sits on the board — an
 * order inside its column, written beside a drag move — and so is no event
 * of the offer's history (backlog:a060a4aa65b6).
 * @param {any} entry one `/api/audit` item
 * @returns {boolean}
 */
export function isBoardPlacement(entry) {
  if (!entry || typeof entry !== 'object' || entry.action !== 'opportunity.updated') return false;
  const data = entry.data;
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  return keys.length > 0 && keys.every((key) => BOARD_PLACEMENT_KEYS.has(key));
}

/**
 * backlog:a060a4aa65b6 (pilota 14/11: «Offerta aggiornata · da …» beside
 * every state move, 4 rows out of 11): the keys of the audit row a board
 * placement writes (positionOnBoard in the opportunity service) — the card's
 * order in its column, never a change of the offer.
 */
const BOARD_PLACEMENT_KEYS = new Set(['boardPosition', 'afterId', 'first', 'renumbered']);

export function stageMoveOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.action === 'opportunity.stage_changed') {
    const from = entry?.data?.from;
    const to = entry?.data?.to;
    if (typeof from === 'string' && from !== '' && typeof to === 'string' && to !== '' && from !== to) {
      return { kind: 'core', from, to };
    }
    return null;
  }
  if (entry.action === 'opportunity.updated') {
    const data = entry?.data;
    if (!data || typeof data !== 'object') return null;
    const from = data.fromPipelineStage;
    const to = data.pipelineStage;
    if (typeof from === 'string' && from !== '' && typeof to === 'string' && to !== '' && from !== to) {
      return { kind: 'pipeline', from, to };
    }
    return null;
  }
  return null;
}

/**
 * Backlog c1649d1d: the from/to words of one state move in the operator's
 * Italian, or null when a side has no label. A pipeline side reads its
 * pipeline label; a core side its core stage word. Null means the row reads
 * the generic Italian line, never a raw key.
 * @param {unknown} pipelines `/api/schema` pipelines
 * @param {{ kind: 'pipeline' | 'core', from: string, to: string }} move
 * @returns {{ from: string, to: string } | null}
 */
export function stageMoveLabels(pipelines, move) {
  if (!move || typeof move !== 'object') return null;
  const label = (key) => (move.kind === 'pipeline' ? pipelineStageLabel(pipelines, key) : offerStateLabel(key));
  const from = label(move.from);
  const to = label(move.to);
  if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') return null;
  return { from, to };
}

/** UUID shape: never painted as a name, it is a technical id, not a person. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Documented service identities: technical handles, never a person's name.
 * (Admin mutations write `admin-ui`; the system writes with `system`.)
 */
const SERVICE_ACTORS = new Set(['admin-ui']);

/**
 * Backlog c1649d1d: display name of an audit actor, shared by the offerta
 * detail and the scheda «Storia stati». The system reads `sistema`, and an
 * empty actor stays an em dash. A team member reads their profile name —
 * else their mailbox (backlog:3f3c143b); any other id paints only when a
 * record corroborates it as a human display value (the referente, the
 * contact or the company the deal stores). Anything else reads as itself
 * only when it is a real mailbox, else the dash: never «utente».
 * @param {any} entry one `/api/audit` item
 * @param {Array<unknown>} known human display values the record corroborates
 * @returns {string}
 */
export function auditActorLabel(entry, known = [], roster = []) {
  if (entry?.actorType === 'system') return 'sistema';
  const id = typeof entry?.actorId === 'string' ? entry.actorId.trim() : '';
  if (id === '') return '—';
  // A team member (by subject or person key) reads the author word —
  // else their mailbox, like personLabel does (backlog:3f3c143b), never
  // with the Team ordinal (backlog:54a83e2fd0d2).
  const person = personOf(id, roster);
  if (person !== null && person.known) return authorName(person);
  // A technical or service id is never corroborated into a name: a record
  // value that literally equals a provider subject stays hidden, like the
  // old code hid technical ids first (review Muse rev-agent-crm-918 P2).
  if (SERVICE_ACTORS.has(id) || isTechnicalMemberText(id) || UUID_SHAPE.test(id)) return '—';
  const names = (Array.isArray(known) ? known : []).filter((value) => typeof value === 'string' && value !== '');
  // A corroborated slug still paints as words, never the raw stored id
  // («coach-guido» reads «Coach Guido», a digit slug names nobody and
  // reads as unknown); any other corroborated value paints verbatim, like
  // the scheda tests read it («elena», a typed name, a real mailbox).
  if (names.includes(id)) return SLUG_SHAPE.test(id) ? (subjectText(id) ?? '—') : id;
  // A real mailbox is self-describing and reads as itself even when no
  // roster names it; a lone or malformed '@' is no mailbox and stays
  // hidden, like any other uncorroborated id (review Muse rev-agent-crm-918
  // P2: ADDRESS_WORD, the same shape readableName trusts).
  const text = subjectText(id);
  return text !== null && ADDRESS_WORD.test(id) ? text : '—';
}

/**
 * Who an offer's audit entry names (its creation, a stage move): the
 * offer's owner reads their profile name when they are the actor, anyone
 * else through auditActorLabel. One rule for the offer page («Creata da»)
 * and the scheda cronologia («Offerta creata · da …», backlog:6c40dcfaeb3f).
 * @param {any} entry the audit entry @param {any} record the offer @param {unknown} [people] the roster
 */
export function offerActorLabel(entry, record, people = []) {
  // A team member reads the author word (famiglia F5, never the Team
  // ordinal in «Creata da»: backlog:54a83e2fd0d2): the roster first, then
  // the deal's own display values — never a slug like «coach-guido».
  const ownerRow = personOf(record?.owner, people);
  const owner = ownerRow !== null && ownerRow.known ? authorName(ownerRow) : personLabel(record?.owner, people);
  const actor = typeof entry?.actorId === 'string' ? entry.actorId.trim() : '';
  if (entry?.actorType !== 'system' && owner !== null && actor !== '' && actor === record?.owner) return owner;
  return auditActorLabel(entry, [owner, record?.contactName, record?.companyName], people);
}

/** How many audit entries an offer's trail reads (the offer page and the scheda). */
export const OFFER_AUDIT_LIMIT = 100;

/**
 * Who created an offer, read from its audit trail — the offer page's
 * «Creata da» and the scheda's «Offerta creata · da …» (backlog:6c40dcfaeb3f).
 * A full page may hide the creation entry past its end (review Muse #894):
 * then, like a trail that could not be read, nobody is named — null.
 * @param {unknown} items the trail's entries @param {any} record the offer
 * @param {unknown} [people] the roster @param {number} [limit] the page size read
 * @returns {string | null}
 */
export function offerCreatorLabel(items, record, people = [], limit = OFFER_AUDIT_LIMIT) {
  if (!Array.isArray(items) || items.length >= limit) return null;
  const created = items.find((entry) => entry?.action === 'opportunity.created') ?? null;
  return created === null ? null : offerActorLabel(created, record, people);
}

// ---------------------------------------------------------------------------
// Famiglia F8 (backlog:9236684c96a7, 1d99c8207f90): counts and screen names
// in Italian, from one place. Money is NOT here: every view that writes
// money reads the single display helper formatAmount in admin-core.js
// («1.080 €», cents only when non-zero — backlog:93e26f3d2cdc), so a fix
// lands on every screen. Dates: italianDateTime above («7 nov, 14:30»),
// italianDay in admin-core («20 nov 2026») and romeDayPhrase in admin-oggi
// («di domani», «del 12 novembre», agent-crm#746) — never a raw ISO stamp
// on screen.
// ---------------------------------------------------------------------------

/**
 * A count with its noun: «1 appuntamento», «3 appuntamenti», «0 righe».
 * Only exactly one takes the singular.
 * @param {unknown} count
 * @param {string} one
 * @param {string} many
 */
export function plural(count, one, many) {
  return `${count} ${Number(count) === 1 ? one : many}`;
}

/**
 * Italian names of the core modules, for the breadcrumb and the kickers
 * (uppercased by CSS: a raw key read «OPPORTUNITY» on Nuova offerta,
 * backlog:1d99c8207f90). `one`/`many` name the record and the list,
 * `create` the creation screen.
 */
export const MODULE_NAMES = Object.freeze({
  opportunity: Object.freeze({ one: 'Offerta', many: 'Offerte', create: 'Nuova offerta' }),
  company: Object.freeze({ one: 'Azienda', many: 'Aziende', create: 'Nuova azienda' }),
  contact: Object.freeze({ one: 'Contatto', many: 'Contatti', create: 'Nuovo contatto' }),
  quote: Object.freeze({ one: 'Preventivo', many: 'Preventivi', create: 'Nuovo preventivo' }),
  appointment: Object.freeze({ one: 'Appuntamento', many: 'Appuntamenti', create: 'Nuovo appuntamento' }),
  product: Object.freeze({ one: 'Prodotto', many: 'Prodotti', create: 'Nuovo prodotto' }),
  order: Object.freeze({ one: 'Ordine', many: 'Ordini', create: 'Nuovo ordine' }),
  contract: Object.freeze({ one: 'Contratto', many: 'Contratti', create: 'Nuovo contratto' }),
  task: Object.freeze({ one: 'Attività', many: 'Attività', create: 'Nuova attività' }),
  lead: Object.freeze({ one: 'Lead', many: 'Lead', create: 'Nuovo lead' }),
});

/**
 * The screen name of one module route for the breadcrumb: «Nuova offerta»
 * for `new`, «Offerta» for `detail`, «Offerte» for `list`. A module the
 * table does not know (one the operator generated) reads its own name with
 * spaces for dashes and a capital first letter — its key is the name the
 * operator gave it.
 * @param {'list' | 'new' | 'detail' | string} view
 * @param {unknown} moduleName
 */
export function moduleScreenLabel(view, moduleName) {
  const key = typeof moduleName === 'string' ? moduleName.trim().toLowerCase() : '';
  if (key === '') return 'Modulo';
  const known = Object.hasOwn(MODULE_NAMES, key) ? MODULE_NAMES[key] : null;
  if (known !== null) return view === 'new' ? known.create : view === 'detail' ? known.one : known.many;
  const words = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * backlog:a3d3b99c738e: a price book as a person reads it in a menu. The
 * manual book the catalog creates is named after its currency («Manuale
 * EUR»), so «Manuale EUR (EUR)» said the currency twice: the trailing code
 * leaves the name, the manual book reads «Listino manuale», and the
 * currency rides once, as € for euro. «Listino (€)», «Stripe (USD)».
 * @param {{ name?: unknown, currency?: unknown } | null | undefined} book
 * @returns {string}
 */
export function priceBookLabel(book) {
  const currency = typeof book?.currency === 'string' ? book.currency.trim().toUpperCase() : '';
  let name = typeof book?.name === 'string' ? book.name.trim() : '';
  if (currency !== '' && name.toUpperCase().endsWith(` ${currency}`)) name = name.slice(0, -(currency.length + 1)).trim();
  if (name === '' || name.toLowerCase() === 'manuale') name = name === '' ? 'Listino' : 'Listino manuale';
  const unit = currency === 'EUR' ? '€' : currency;
  return unit === '' ? name : `${name} (${unit})`;
}

/**
 * backlog:bfc070243427 (coordina backlog:ef92f7289b30): a discount rule as the
 * operator reads it in a frozen version row. The record carries `name@version`
 * (`presti-sales-discount@2`): the id never paints — the name as words with
 * its version, «Presti sales discount (v2)».
 * @param {unknown} name the rule id @param {unknown} version its version number
 * @returns {string}
 */
export function discountRuleLabel(name, version) {
  const words = String(name ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const head = words === '' ? 'Regola di sconto' : words.charAt(0).toUpperCase() + words.slice(1);
  return Number.isSafeInteger(version) ? `${head} (v${version})` : head;
}

/**
 * backlog:6563edf41aab (punto (d)): the painted team rows and the possible
 * duplicate hints live here, with `teamPeople` above, so both the Spazi e
 * accessi view and the Impostazioni fix count read the same rows from the
 * same roster — one resolution, never a second one. Moved verbatim from
 * admin-spazi-accessi.js; that module re-exports them.
 */

/**
 * Italian names for the control-plane membership roles the spine mirrors —
 * the same words the shell prints under the space name and the user
 * (admin-session.js), so one screen never calls the same role «Titolare»
 * in the sidebar and something else in the card (prototype 08: «Tu:
 * Titolare»).
 */
export const SPACE_ROLE_LABELS = Object.freeze({
  owner: 'Titolare',
  operator: 'Operatore',
  observer: 'Osservatore',
});

/**
 * Italian label for a membership role. A role the framework does not know is
 * shown as-is, never blank and never mapped to a wrong one.
 * @param {unknown} role
 */
export function spaceRoleLabel(role) {
  if (typeof role === 'string' && role !== '' && Object.hasOwn(SPACE_ROLE_LABELS, role)) {
    return SPACE_ROLE_LABELS[role];
  }
  return typeof role === 'string' && role !== '' ? role : 'non disponibile';
}

/**
 * Avatar initials for a team subject: the first two alphanumeric characters,
 * uppercased. The spine store itself carries no display name; when the
 * roster arrives without the enriched displayName/email, the subject is the
 * only honest source — never a prettier invention (buildTeamRows uses the
 * person name when the roster carries one).
 * @param {unknown} subject
 */
export function memberInitials(subject) {
  if (typeof subject !== 'string') return '·';
  const clean = subject.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, '');
  if (clean === '') return '·';
  return clean.slice(0, 2).toUpperCase();
}

/**
 * One team row per membership: avatar initials, subject, Italian role pill,
 * status. Sorted by subject so the list is stable regardless of store order.
 * @param {Array<{subject?: unknown, role?: unknown, status?: unknown}>} members
 */
const MEMBER_STATUS = Object.freeze({ active: 'attivo', suspended: 'sospeso', invited: 'invitato', pending: 'in attesa', sending: 'invio in corso' });
// The `sending` key is the Spazi e accessi in-flight marker (backlog:71a6574a
// giro 4): a client-only status the grant 200 has not confirmed yet. Only
// that view writes it; the mapping here only paints it honestly.

/** Strongest role first: a person holding two subjects shows the higher one. */
const ROLE_RANK = Object.freeze(['owner', 'operator', 'observer']);

/** Liveliest status first: a person reads «sospeso» only when no subject is live. */
const STATUS_RANK = Object.freeze(['active', 'invited', 'pending']);

/**
 * Avatar initials for a person name: the first letter of the first two
 * words («Daniele Pelleri» → «DP»), or the subject rule for one word.
 * @param {string} name
 */
export function nameInitials(name) {
  const words = name.split(/\s+/).map((word) => word.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, '')).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return memberInitials(name);
}

/** The sign-in kind of a person's subjects, or null (never a technical id). Also read by the Calendario Team card sub-line. */
const ACCESS_KINDS = Object.freeze([['google|', 'Accesso Google'], ['github|', 'Accesso GitHub'], ['broker+', 'Accesso di servizio']]);
/** @param {Array<string>} subjects */
export function accessLabel(subjects) {
  const kinds = [];
  for (const subject of subjects) {
    const hit = ACCESS_KINDS.find(([prefix]) => String(subject).toLowerCase().startsWith(prefix));
    if (hit && !kinds.includes(hit[1])) kinds.push(hit[1]);
  }
  return kinds.length > 0 ? kinds.join(' · ') : null;
}

/**
 * One team row per PERSON. The roster (`GET /api/spine/memberships`) may
 * carry, beside each opaque subject, the control-plane displayName, email
 * and `operatorAccountId` the pilot enriches it with — the same fields the
 * Calendario team reads. One human can hold several subjects (an adopted
 * broker member, the github one and the Google one: prod 07/11 listed
 * «Daniele Pelleri» twice with `broker+…@accordo.invalid` mailboxes).
 * Subjects merge into one row on the control-plane person key first
 * (backlog:810ed0bfd505 AC-2: `operatorAccountId`, one per human), then —
 * only without that key — when both the mailbox and the display name match
 * (trimmed, case-insensitive). Two explicit person keys never fold into one
 * row: the mailbox fallback joins only a group with no key of its own, or
 * the same key. A mailbox alone never merges: a shared mailbox (info@…)
 * or stale enrichment could fold a different human into the row, hide them
 * and let «Rimuovi» suspend them. A name alone never merges either: two
 * homonyms without email are two people. Nothing merges
 * in the backend: the row keeps every subject, and removal suspends each
 * of them. Internal broker mailboxes (`…@accordo.invalid`) never paint:
 * the row shows the person's first real mailbox, or no email line when
 * the roster carries none — the name is then the profile displayName.
 *
 * Without enrichment the subject is the name when it reads as one, else
 * «Membro del team» — never a technical subject (production 10/11) — and
 * the status sits under it. Sorted by name, then subject, so the
 * list is stable regardless of store order.
 * @param {Array<{subject?: unknown, role?: unknown, status?: unknown, displayName?: unknown, email?: unknown, operatorAccountId?: unknown}>} members
 * @param {{selfSubject?: unknown, selfName?: unknown, selfEmail?: unknown}} [options]
 *   the session profile's own name and mailbox: only the session's own
 *   person may borrow them, when the roster leaves it with a bare handle
 */
export function buildTeamRows(members = [], { selfSubject = null, selfName = null, selfEmail = null } = {}) {
  // backlog:3ce220e60c33 (famiglia F5): the people come from the shared
  // teamPeople, the same rows the Calendario team reads.
  const people = teamPeople(Array.isArray(members) ? members : []).map((row) => ({
    subjects: row.subjects,
    keys: row.keys,
    live: row.members.filter((member) => member.status !== 'suspended').map((member) => member.subject),
    displayName: row.name,
    email: row.email,
    roles: row.members.map((member) => member.role),
    statuses: row.members.map((member) => member.status),
    self: typeof selfSubject === 'string' && selfSubject !== '' && row.subjects.includes(selfSubject),
  }));
  // backlog:9d06eb1e174b (review Muse #897 P1): a name is never a proof of
  // identity — not even the session's own name. Without a person key or a
  // server link a same-named subject stays a row of its own, with its own
  // «Rimuovi», told apart by its access kind (accessLabel below): one row
  // too many beats a person hidden.
  // backlog:71a6574a (verifica Mac 11/11, punto 5): the session profile
  // names the operator's own person when the roster does not — a bare
  // profile handle («khaoss85») never stands alone. The profile name joins
  // the same candidates `profileName` scores below, so a full name wins
  // over the handle and nothing else changes; the profile mailbox fills a
  // missing row email. Only the session's own person is enriched — another
  // row never borrows the operator's name or mailbox.
  if (typeof selfSubject === 'string' && selfSubject !== '') {
    const self = people.find((person) => person.subjects.includes(selfSubject));
    if (self !== undefined) {
      // The same pick made among roster names, with the profile name added:
      // a full name wins over the handle, ties and better roster names keep
      // what the team already showed.
      const candidates = [self.displayName, memberText(selfName)]
        .filter((name) => typeof name === 'string');
      const best = profileName(candidates);
      if (best !== null) self.displayName = best;
      const profileMailbox = memberText(selfEmail);
      if (self.email === null && profileMailbox !== null) self.email = profileMailbox;
    }
  }
  return people
    .map((person) => {
      const subject = [...person.subjects].sort()[0];
      // No readable name or mailbox: the subject when it reads as a word,
      // else a generic label — never a technical subject (`google|…`,
      // `broker+…`), the same fallback the Calendario team uses.
      const readable = person.displayName ?? person.email ?? subjectText(subject);
      const name = readable ?? 'Membro del team';
      const known = person.roles.filter((role) => typeof role === 'string' && ROLE_RANK.includes(role));
      const role = known.length > 0
        ? [...known].sort((a, b) => ROLE_RANK.indexOf(/** @type {string} */ (a)) - ROLE_RANK.indexOf(/** @type {string} */ (b)))[0]
        : person.roles[0];
      // Deterministic, whatever the store order: the liveliest status wins,
      // and «sospeso» only when every subject of the person is suspended.
      const other = person.statuses.findIndex((status) => status !== 'suspended');
      const rawStatus = STATUS_RANK.find((status) => person.statuses.includes(status))
        ?? (other >= 0 ? person.statuses[other] : 'suspended');
      return {
        subject,
        subjects: [...person.subjects].sort(),
        // What «Rimuovi» suspends: every subject of the person not already
        // suspended (all of them when none is live, so a retry still asks).
        removable: [...(person.live.length > 0 ? person.live : person.subjects)].sort(),
        name,
        email: person.email,
        initials: person.displayName !== null
          ? nameInitials(person.displayName)
          : (readable !== null ? memberInitials(readable) : '·'),
        role: spaceRoleLabel(role),
        // The session's own person: never offered «Rimuovi» on themself.
        self: person.self,
        // How this person signs in, when no real mailbox names them: two
        // same-named rows read apart («Accesso GitHub», «Accesso Google»).
        access: accessLabel(person.subjects),
        status: MEMBER_STATUS[/** @type {keyof typeof MEMBER_STATUS} */ (rawStatus)] ?? (typeof rawStatus === 'string' && rawStatus !== '' ? rawStatus : 'sconosciuto'),
      };
    })
    .sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      if (a !== b) return a < b ? -1 : 1;
      return left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0;
    });
}

/**
 * backlog:6563edf41aab — possible team duplicates for Impostazioni: roster
 * rows that paint the same REAL name are indistinguishable on screen
 * («Daniele Pelleri» vs «daniele pelleri», both with the same avatar),
 * even when the mailbox or the access line tells them apart («Accesso
 * Google» vs «Accesso di servizio»). One entry per colliding painted name,
 * in team order; mailbox and access kind never silence the hint — the same
 * person resolution covers different accesses, and two homonyms stay
 * candidates the operator keeps. The generic placeholder («Membro del
 * team», review #1043 P2) is not a name: rows without a real name fall back
 * to the mailbox, then to their subjects, so two unenriched rows never
 * collide. A name alone never proves one person (backlog:9d06eb1e174b), so
 * the hint explains the two access lines and warns that removing suspends
 * the person in the whole organisation — it never merges or removes
 * anything itself.
 * @param {Array<{name?: unknown, email?: unknown, access?: unknown, subject?: unknown, subjects?: unknown}>} rows
 */
const PLACEHOLDER_TEAM_NAME = 'membro del team';

/** A painted name the hint may key on: never empty, never the generic placeholder. @param {string} name */
function teamHintHasName(name) {
  return name !== '' && name.toLowerCase() !== PLACEHOLDER_TEAM_NAME;
}

/** @param {unknown} row */
function teamHintSubjects(row) {
  if (!row || typeof row !== 'object') return [];
  const fromList = Array.isArray(row.subjects) ? row.subjects : [];
  const single = typeof row.subject === 'string' ? [row.subject] : [];
  return [...fromList, ...single].filter((subject) => typeof subject === 'string' && subject !== '');
}

export function duplicateTeamHints(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const byPaint = new Map();
  list.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const name = typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ') : '';
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    const subjects = [...new Set(teamHintSubjects(row))].sort();
    // Same person resolution, access included: a real painted name alone
    // keys the hint (case-insensitive), so a Google row and a servizio row
    // with the same name collide; the placeholder never keys it (review
    // #1043 P2: it would invite removing a live member), falling back to
    // the mailbox and then to the subjects.
    const key = teamHintHasName(name)
      ? `name:${name.toLowerCase()}`
      : email !== ''
        ? `mail:${email.toLowerCase()}`
        : subjects.length > 0 ? `subject:${subjects.join('+')}` : `row:${index}`;
    byPaint.set(key, [...(byPaint.get(key) ?? []), row]);
  });
  const hints = [];
  for (const group of byPaint.values()) {
    if (group.length < 2) continue;
    const variants = [...new Set(group.flatMap((row) => teamHintSubjects(row)))];
    if (variants.length < 2) continue;
    const first = group[0];
    const firstName = typeof first.name === 'string' ? first.name.trim().replace(/\s+/g, ' ') : '';
    const firstEmail = typeof first.email === 'string' ? first.email.trim() : '';
    const painted = teamHintHasName(firstName) ? firstName : firstEmail;
    const accesses = [...new Set(group.map((row) => (
      typeof row.access === 'string' && row.access.trim() !== '' ? row.access.trim() : null
    )).filter((access) => access !== null))];
    const cause = accesses.length > 0 ? ` ma con accessi diversi (${accesses.join(', ')})` : '';
    hints.push({
      name: painted,
      count: group.length,
      accesses,
      text: `«${painted}» compare ${group.length} volte con lo stesso nome${cause}: è quasi sempre la stessa persona che entra in due modi. Non rimuovere nessuna delle due righe per sistemare: la rimozione sospende la persona in tutta l'organizzazione.`,
    });
  }
  return hints;
}
