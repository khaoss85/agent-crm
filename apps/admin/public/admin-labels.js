// @ts-check

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
 * A stored name with its placeholder words dropped («PayPal Unknown» reads
 * «PayPal»), null when nothing real is left. A name that carries an
 * address (`Mittente: x@…`, or a bare email used as a label) names nobody:
 * null, never the long address on screen (production 10/11).
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
  const kept = words.filter((word) => !NAME_PLACEHOLDERS.has(word.toLowerCase()) && !(word.includes('_') && /\d/.test(word)));
  while (kept.length > 0 && NO_REPLY_WORD.test(kept[kept.length - 1].replace(/^[([<"']+|[)\]>"',;:]+$/g, ''))) kept.pop();
  const text = kept.join(' ');
  return text !== '' && /[\p{L}\p{N}]/u.test(text) ? text : null;
}

/** A trailing no-reply marker (`Noreply`, `NO-REPLY`), any case (production 10/11). */
const NO_REPLY_WORD = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|no[._-]?risposta|non[._-]?rispondere)$/i;

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
 * digits, like «user-12345» or a UUID, names nobody), anything else — a
 * typed name, a real mailbox — reads as itself.
 * @param {unknown} value
 * @returns {string | null}
 */
export function subjectText(value) {
  const text = memberText(value);
  if (text === null) return null;
  return SLUG_SHAPE.test(text) ? slugAsName(text) : text;
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
    const name = memberText(member.displayName);
    const identity = email === null || name === null
      ? null
      : `${email.toLowerCase()}\u0000${name.replace(/\s+/g, ' ').toLowerCase()}`;
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
  for (const row of rows) byBase.set(row.base, [...(byBase.get(row.base) ?? []), row]);
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
  return people.find((row) => row.subjects.includes(wanted) || row.keys.includes(wanted)) ?? null;
}

/**
 * The words a screen shows for a person id it stores (an offer referente,
 * a reporting owner, an audit actor): the person label from the team, else
 * the id as words (`subjectText`: a typed name or a real mailbox reads as
 * itself, a slug as words), else null — never a technical mailbox or a
 * provider id.
 * @param {unknown} id
 * @param {unknown} rosterOrPeople
 * @returns {string | null}
 */
export function personLabel(id, rosterOrPeople) {
  const row = personOf(id, rosterOrPeople);
  if (row !== null) return row.known ? row.label : null;
  return subjectText(id);
}

/**
 * The name of the team member behind a subject, or null — never the id
 * itself when it is technical. Reads the person row of `teamPeople`, so an
 * identity without a name of its own borrows the profile name of the same
 * person. A subject the roster does not know reads as itself only when it
 * is a plain word an operator typed («Marco»).
 * @param {unknown} subject
 * @param {unknown} members roster items
 * @returns {string | null}
 */
export function memberLabel(subject, members) {
  if (typeof subject !== 'string' || subject.trim() === '') return null;
  const row = teamPeople(members).find((person) => person.subjects.includes(subject)) ?? null;
  if (row !== null) return row.name;
  const typed = subjectText(subject);
  return typed !== null && !typed.includes('@') ? typed : null;
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
 * pipeline reads its core stage from OFFER_STATE_LABELS. Null when neither
 * is known. A quote's approval state is not the offer's stage.
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
  }
  return offerStateLabel(offer.stage);
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
 * detail and the scheda «Storia stati». The system reads `sistema`, UUIDs
 * and known service handles read `utente`, and any other id paints only when
 * a record corroborates it as a human display value (the referente, the
 * contact or the company the deal stores). Empty actors stay an em dash.
 * @param {any} entry one `/api/audit` item
 * @param {Array<unknown>} known human display values the record corroborates
 * @returns {string}
 */
export function auditActorLabel(entry, known = [], roster = []) {
  if (entry?.actorType === 'system') return 'sistema';
  const id = typeof entry?.actorId === 'string' ? entry.actorId.trim() : '';
  if (id === '') return '—';
  // A team member (by subject or person key) reads their profile name
  // (backlog:ddf7f416ad22: «Creata da: utente»).
  const person = personOf(id, roster);
  if (person !== null && person.name !== null) return person.label;
  if (isTechnicalMemberText(id)) return 'utente';
  if (UUID_SHAPE.test(id) || SERVICE_ACTORS.has(id)) return 'utente';
  const names = (Array.isArray(known) ? known : []).filter((value) => typeof value === 'string' && value !== '');
  return names.includes(id) ? id : 'utente';
}
