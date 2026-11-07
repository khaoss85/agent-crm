// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { apiErrorToFormErrors, humanReadError, isNotComposedFailure } from './admin-core.js';
import { matchConnections } from './admin-connectors.js';
import { readProfile } from './admin-profilo.js';
import { writePendingCustomerPick } from './admin-prefill.js';
import { bindAdminMutations } from './admin-submission.js';
import {
  addFieldForm,
  defineField,
  fetchFieldDefs,
  fetchFieldValues,
  fieldControl,
  formatCustomValue,
  saveFieldValue,
} from './admin-custom-fields.js';

/**
 * **The customer scheda (BO-F1-06): one customer, three columns.**
 *
 * A read-only projection over records other packages already hold — the card
 * (`read-customer-card`), the timeline (`read-customer-timeline`) and the
 * consolidated profile (`read-customer-profile`). It creates nothing: no
 * master row, no copy, no new table.
 *
 * Layout, like the backoffice prototype ("05 Scheda cliente"):
 * - left: quick actions, linked identities with their human motivation,
 *   details, "Arricchito dall'AI" with the free source and date of every
 *   datum (BO-F4-03, read from the customer-data enrichment operations);
 * - center: the channel timeline, every passage with channel, direction and
 *   sync state, filterable per channel;
 * - right: AI summary, next steps, offer, next appointment.
 *
 * Every panel the composed packages cannot feed stays in plain Italian: data
 * panels with nothing readable show a short empty state, blocks whose
 * package is not composed at all stay hidden instead of explaining
 * themselves — never an empty value that could be mistaken for "none",
 * never an English system reason, id or ISO date on screen (those live on
 * in the API responses and the logs). The
 * message composer «Scrivi» (BO-F1-07, backlog:e9b4fc2f) IS here: the
 * operator writes inside the scheda, choosing the channel among the
 * customer's own, and Invia queues through the outbox — the human click is
 * the approval, the worker sends. The call summary with signals and
 * transcript (BO-F1-08) IS here, read from the call-intelligence
 * operations: a call exists only under a recorded start-of-call notice,
 * and a transcript erased by retention reads as erased, never as missing.
 */

const CHANNEL_LABELS = Object.freeze({
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Messenger',
  // Voce 19c2e22a64a1 (6): every CARD_CHANNEL_MARKS key reads Italian — the
  // scheda never prints a raw channel key. `messenger` follows `facebook`
  // (both paint FB); `calendar` follows the prototype chip (`Google
  // Calendar`); `web`/`form` follow the Oggi tile note (`WEB (Form sito)` in
  // admin-ui.js); `outlook` keeps its product name like `gmail` keeps Gmail.
  // Voce 59def6cb805d: stessa copertura per C15/C17.
  tiktok: 'TikTok',
  email: 'Email',
  gmail: 'Gmail',
  outlook: 'Outlook',
  sms: 'SMS',
  phone: 'Telefono',
  voice: 'Telefono',
  tel: 'Telefono',
  mobile: 'Telefono',
  messenger: 'Messenger',
  calendar: 'Google Calendar',
  web: 'Sito',
  form: 'Form sito',
});

/** The composer channel order (backlog:e9b4fc2f): Email first, like the prototype's quick actions. */
const COMPOSER_CHANNEL_ORDER = Object.freeze(['email', 'whatsapp', 'instagram', 'facebook', 'sms']);
// A send the worker has not settled within the web's own wait (504
// BO_SEND_PENDING) is read back every 4 s for about two and a half minutes:
// production 06/11 measured 2.5 min from tap to Gmail.
const SEND_RESUME_EVERY_MS = 4000;
/** An unknown send outcome: never «non inviato», and a re-tap is safe. */
const SEND_UNCERTAIN = 'Non sappiamo ancora se è partito: controlla la cronologia tra poco. Se lo invii di nuovo non parte due volte.';
/** Statuses that say «try later», never «refused». */
const TRANSIENT_STATUSES = new Set([408, 425, 429]);
/**
 * A 4xx that refuses the request itself (validation, not connected,
 * refused body). 408/425/429, 5xx, network errors and a missing status
 * leave the outcome unknown.
 * @param {any} error
 */
export function isDefinitiveRefusal(error) {
  const status = typeof error?.status === 'number' ? error.status : 0;
  return status >= 400 && status < 500 && !TRANSIENT_STATUSES.has(status);
}
const SEND_RESUME_ROUNDS = 40;

/** Delivery/sync state, inbound or outbound, in the operator's words. */
const SYNC_LABELS = Object.freeze({
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
 * Voce cc525cd6a3c5: the quote and opportunity-fallback stages share the
 * Italian-only table below (anything unknown reads back as null, never raw
 * English) — kept as one table with the 1a066ddf labels, not two.
 *
 * Voce 1a066ddfe42a: the scheda speaks only plain Italian. The API reasons
 * stay in English in the responses (the honest system phrases live there
 * and in the logs) — the page never prints them. Dates render readable in
 * Europe/Rome, ids and UUIDs never reach visible text.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_SHAPE.test(String(value ?? '').trim());
/**
 * A handle readable by a human operator (a name or username), never a code:
 * UUIDs, letter-digit codes (`c1`, `user-123`) and long digit runs stay out.
 */
const isHumanHandle = (value) => {
  const text = String(value ?? '').trim();
  if (text === '' || isUuid(text)) return false;
  if (/[0-9]{4,}/.test(text)) return false;
  if (/^[a-zÀ-ÿ]*\d+$/i.test(text)) return false;
  if (/^[a-zÀ-ÿ]+-\d+$/i.test(text)) return false;
  return true;
};

const dateTimeParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const dateParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const dayParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const timeParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

/**
 * Voce 59def6cb805d (C16): the Rome calendar day of an instant, as
 * `YYYY-MM-DD`, so the timeline can mark the passages of today with the
 * prototype's `OGGI · ` prefix. Day-level only — never an instant on screen.
 */
const romeDayKey = (ms) => {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
};

/**
 * Voce 59def6cb805d (C19): a call duration in `<m:ss>` for the timeline
 * card (`372` → `6:12`). Null when the data holds no usable duration — the
 * card then shows no duration instead of an invented one.
 */
const durationParts = (sec) => {
  const total = typeof sec === 'number' ? Math.floor(sec) : Number.NaN;
  if (!Number.isFinite(total) || total < 0) return null;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Dan 07/11: the conversation reads like a chat, so the writer of an
 * outbound passage reads as a name, never as a handle. A slug handle
 * (`coach-guido`, `elena`) becomes `Coach Guido` / `Elena`; an e-mail keeps
 * its local part; anything that is not a human handle reads as null and the
 * caller says «il team».
 * @param {unknown} value
 */
export function teamName(value) {
  if (!isHumanHandle(value)) return null;
  const text = String(value).trim();
  const local = text.includes('@') ? text.slice(0, text.indexOf('@')) : text;
  if (!/^[a-zà-ÿ]+([._-][a-zà-ÿ]+)*$/i.test(local)) return text;
  return local.split(/[._-]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Own-property label lookup: a hostile or unknown key (`constructor`,
 * `toString`, `__proto__`, …) never reads through to `Object.prototype` —
 * it falls to the caller's fallback, never a function source on screen.
 */
const ownLabel = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;

const STATUS_LABELS = Object.freeze({ cliente: 'Cliente', contatto: 'Contatto' });
const statusLabel = (value) => ownLabel(STATUS_LABELS, String(value ?? '').toLowerCase())
  ?? String(value ?? 'Contatto').replace(/^./, (first) => first.toUpperCase());

/**
 * The Italian line under the stato: a definitive «none» only when the three
 * evidence sections are readable with exact zero counts — the same
 * absence-proof discipline the API verdict follows. Otherwise the line stays
 * honest about the unreadable checks.
 */
const EVIDENCE_KEYS = Object.freeze(['orders', 'contracts', 'subscriptions']);
const statusMicrocopy = (card, profile) => {
  if (String(card?.status?.value ?? '').toLowerCase() === 'cliente') return 'Attività firmata collegata';
  const proven = EVIDENCE_KEYS.every((key) => profile?.[key]?.available === true
    && (profile[key]?.count ?? 0) === 0
    && profile[key]?.countIsComplete !== false);
  return proven
    ? 'Nessuna attività firmata collegata'
    : 'Ordini e contratti non leggibili adesso';
};

const OFFER_STATUS_LABELS = Object.freeze({
  sent: 'inviata', draft: 'bozza', approved: 'approvata', rejected: 'rifiutata',
  open: 'aperta', won: 'vinta', lost: 'persa', expired: 'scaduta', accepted: 'accettata',
  pending_approval: 'in attesa di approvazione', approval_pending: 'in attesa di approvazione',
  discovery: 'scoperta', qualification: 'qualificazione', proposal: 'proposta', negotiation: 'trattativa',
});
const offerStatusLabel = (status) => ownLabel(OFFER_STATUS_LABELS, String(status ?? '').toLowerCase()) ?? null;

// Voce 714433c2: the opportunity stages the «Cambia stato» menu offers.
// Mirrors ALLOWED_TRANSITIONS in
// packages/modules/opportunity/src/opportunity-service.js (this view ships
// as a static file, so it names the table instead of importing it, like
// TERMINAL_APPOINTMENT below). A test pins this mirror to the governed
// table, so a workflow change that the menu ignores fails loudly. Every key
// has an Italian voice in OFFER_STATUS_LABELS above, so the menu never
// prints a raw stage key.
export const OPPORTUNITY_ALLOWED_TRANSITIONS = Object.freeze({
  discovery: ['qualification', 'lost'],
  qualification: ['proposal', 'approval_pending', 'lost'],
  proposal: ['approval_pending', 'negotiation', 'won', 'lost'],
  approval_pending: ['proposal', 'qualification', 'lost'],
  negotiation: ['proposal', 'won', 'lost'],
  won: [],
  lost: ['discovery'],
});

// System states the workflow enters on its own (only approval_pending
// today): the menu never offers them — they are reached through the approval
// gate, never hand-picked by the operator.
const GOVERNED_SYSTEM_STAGES = Object.freeze(['approval_pending']);

/**
 * The legal «Cambia stato» voices for the shown stage: the workflow's
 * allowed transitions minus the governed system states. Never the current
 * stage, never a raw key without an Italian voice upstream.
 * @param {unknown} current
 * @returns {Array<string>}
 */
export function offerStageTargets(current) {
  const key = String(current ?? '').toLowerCase();
  const allowed = OPPORTUNITY_ALLOWED_TRANSITIONS[key];
  if (!Array.isArray(allowed)) return [];
  return allowed.filter((stage) => stage !== key && !GOVERNED_SYSTEM_STAGES.includes(stage));
}

const PACKAGE_STATUS_LABELS = Object.freeze({ active: 'attivo' });
const packageStatusLabel = (status) => ownLabel(PACKAGE_STATUS_LABELS, String(status ?? '').toLowerCase()) ?? null;

const RESOURCE_LABELS = Object.freeze({ contact: 'Contatto', company: 'Azienda' });
const resourceLabel = (resource) => ownLabel(RESOURCE_LABELS, String(resource ?? '').toLowerCase()) ?? 'Scheda';

const ROLE_LABELS = Object.freeze({ canonical: 'scheda principale', alias: 'scheda collegata' });
const roleLabel = (role) => ownLabel(ROLE_LABELS, String(role ?? '').toLowerCase()) ?? null;
const channelLabel = (channel) => ownLabel(CHANNEL_LABELS, String(channel ?? '').toLowerCase()) ?? String(channel ?? 'canale');
const syncLabel = (sync) => ownLabel(SYNC_LABELS, String(sync ?? '').toLowerCase()) ?? String(sync ?? 'stato ignoto');

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   spaceId?: string | (() => (string | null | undefined)),
 *   onAskAi?: (screenId: string, draft: string, customer: { resource: string, id: string }) => void}} deps
 * `spaceId` is the shell's active space (string or thunk): the calls read
 * stays space-explicit, never inferred. Without it the calls section stays
 * honestly unavailable. `onAskAi` is the BO-F0-04 assistant seam (same as the
 * Clienti, Pipeline and Reporting views): the «✦ Chiedi all'AI» voice opens
 * the panel with this customer in the context instead of navigating away.
 */
const CARD_CHANNEL_MARKS = Object.freeze({ whatsapp: 'WA', instagram: 'IG', facebook: 'FB', tiktok: 'TT', email: '@', gmail: '@', outlook: '@', phone: 'TEL', tel: 'TEL', mobile: 'TEL', voice: 'TEL', sms: 'SMS', web: 'WEB', form: 'WEB', calendar: 'CAL', messenger: 'FB' });

/** Identity systems whose handle is a phone number once display separators are stripped. */
const PHONE_LIKE_SYSTEMS = Object.freeze(['whatsapp', 'sms', 'voice', 'phone', 'tel', 'mobile']);

/**
 * Manual Collega/Scollega (backlog:826e377c) was split into a follow-up voce
 * by the owner: this PR keeps only the read of observed identities, so the
 * card offers no link buttons. When the follow-up returns, its Collega gate
 * mirrors `CHANNEL_SYSTEMS` in packages/customer-data/src/sender.js and its
 * Scollega gate accepts every system a held row can carry (imports accept
 * any lowercase system identifier, e.g. sms, gmail, voice), not just the
 * sender vocabulary.
 */

/**
 * List the channels observed on the customer's own messages (voce 826e377c,
 * read-only since the owner split manual Collega/Scollega into a follow-up
 * voce): one row per (system, handle). Rows come from the timeline the
 * scheda already loads — thread peers and entry remote handles, inbound and
 * outbound alike naming the customer — with the same honesty filter the
 * section always applied (Italian label only, no UUID handles). One number
 * in two display forms reads as one row (separators stripped on phone-like
 * systems, lowercased email), since no action depends on the key anymore.
 * Email appears when observed on the email channel — the contact record
 * email stays in Dettagli, not here. Held identities stay in the profile
 * and in the Clienti CANALI column, not in this section. Evidence that
 * names no handle (a call from an unknown number, a thread with no peer)
 * still counts as an observed channel — a display-only row with no handle,
 * never an invented one — instead of a silent under-count. A timeline
 * without readable conversations/entries sections (a 404 null, a foreign
 * shape) merges to available:false, never to an empty channel list; a
 * truncated section merges its page with complete:false, never an exact
 * count — the section names the shortfall instead.
 * @param {any} timeline the read-customer-timeline answer
 */
export function mergeLinkedIdentities(timeline) {
  const rows = [];
  const seen = new Set();
  const dedupeKey = (system, externalId) => {
    const value = String(externalId);
    if (PHONE_LIKE_SYSTEMS.includes(system)) return `${system}|${value.replace(/[ .\-()/]/g, '')}`;
    if (system === 'email' || system === 'gmail' || system === 'outlook') return `${system}|${value.toLowerCase()}`;
    return `${system}|${value}`;
  };
  const push = (system, externalId) => {
    const key = dedupeKey(system, externalId);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.freeze({ system, externalId: String(externalId), source: 'observed' }));
  };
  // Review giro-7 on 826e377c (P2 head 3c77ca1): the merge honors the
  // timeline's own availability and truncation flags before claiming a
  // count. A null timeline (honest 404: the package is not composed) or a
  // shape without readable sections is unavailable, never an empty list;
  // a truncated section is a partial page, never an exact total.
  const sections = timeline != null && typeof timeline === 'object' ? timeline : null;
  const threads = Array.isArray(sections?.conversations?.items) ? sections.conversations.items : null;
  const entries = Array.isArray(sections?.entries?.items) ? sections.entries.items : null;
  const available = threads !== null && entries !== null;
  const truncated = available
    && (sections.conversations?.truncated === true || sections.entries?.truncated === true);
  // Every labeled channel the timeline names, with or without a handle: a
  // channel observed without a handle still reads here (as a handle-less
  // row below), never as a silent under-count. The list CANALI column shares
  // the in-filter observed channels with these rows and adds every held
  // identity system — the two surfaces overlap, they are not one union.
  const seenChannels = new Set();
  if (available) {
    for (const thread of threads) {
      const system = String(thread?.channel ?? '').toLowerCase();
      if (ownLabel(CHANNEL_LABELS, system) === undefined) continue;
      seenChannels.add(system);
      if (typeof thread?.peer !== 'string' || thread.peer.trim() === '') continue;
      if (isUuid(thread.peer)) continue;
      push(system, thread.peer);
    }
    for (const entry of entries) {
      const system = String(entry?.channel ?? '').toLowerCase();
      if (ownLabel(CHANNEL_LABELS, system) === undefined) continue;
      seenChannels.add(system);
      if (typeof entry?.remoteHandle !== 'string' || entry.remoteHandle.trim() === '') continue;
      if (isUuid(entry.remoteHandle)) continue;
      push(system, entry.remoteHandle);
    }
    // Channels observed without any handle (a call from an unknown number, a
    // thread with no peer): one display-only row per channel, with no handle
    // to link. The display vocabulary is wider than the list filter's, so an
    // observed legacy channel reads here while CANALI skips it.
    for (const system of [...seenChannels].sort()) {
      if (rows.some((row) => row.system === system)) continue;
      rows.push(Object.freeze({ system, externalId: null, source: 'observed' }));
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    channelCount: new Set(rows.map((row) => row.system)).size,
    available,
    complete: available && !truncated,
  });
}

/**
 * «Da leggere»: the one rule for an unread passage, shared by the «Nuovo»
 * badge and by mark-read so the two never disagree — an inbound message the
 * server names unread, with a date mark-read can reach (`upTo`). A passage
 * outside it never lights up, so it can never stay lit forever.
 * @param {any} item a timeline entry
 * @returns {number | null} its time in ms when unread, null otherwise
 */
export function unreadInboundAt(item) {
  if (String(item?.direction ?? '') !== 'inbound' || item?.read !== false) return null;
  const ms = Date.parse(String(item?.occurredAt ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/** Timeline page size (Dan 06/11): the newest 20, then «Mostra precedenti». */
const TIMELINE_PAGE = 20;
/** A message longer than this folds behind «Mostra tutto». */
const ENTRY_FOLD_CHARS = 280;
const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
/**
 * Message text as a person reads it: HTML entities the mail provider left in
 * the snippet are decoded (as text — nothing is ever parsed as markup), the
 * invisible preheader padding (U+034F, zero-widths, BOM, soft hyphen) is
 * dropped and runs of blanks collapse. The stored value stays untouched.
 * @param {string} value
 */
export function readableText(value) {
  return String(value ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : whole;
    })
    .replace(/[\u034f\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createCustomerCardView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  // Every write of the card (note, Dettagli, phone, call, message, stage)
  // goes through the submission controller like every other view
  // (bindAdminMutations, #567): the raw client refuses a mutation without a
  // submission-owned Idempotency-Key before any request leaves, so in
  // production «Aggiungi nota» answered «Nota non salvata» with no request
  // at all (04/11).
  const { client } = bindAdminMutations(deps.client, deps);
  // The one-time creation handoff («Nuova offerta», «Nuovo appuntamento»).
  // The shell passes its storage; without one the buttons still navigate
  // and the creation screens open unpicked.
  const storage = deps.storage ?? null;
  // The shell toast, like every sibling admin view: Aggiorna reports through
  // it, never through a bare status line. Without a shell it stays a noop.
  const toast = deps.toast ?? (() => {});
  // The composer's poll-back pause (BO_SEND_PENDING): injectable so tests
  // run the wait loop without real time.
  const wait = typeof deps.wait === 'function'
    ? deps.wait
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  // Voce d525f4aa48b2: the BO-F0-04 assistant seam. Without a shell panel the
  // button toasts the ⌘K hint, like the Clienti seam in app.js.
  const onAskAi = typeof deps.onAskAi === 'function' ? deps.onAskAi : null;
  const activeSpaceId = () => {
    const raw = typeof deps.spaceId === 'function' ? deps.spaceId() : deps.spaceId;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  };
  const el = elFor(doc); // BO-F6-02: shared element builder.
  const link = (href, text, action) => {
    const node = el('a', undefined, text);
    node.setAttribute('href', href);
    if (action) node.setAttribute('data-action', action);
    return node;
  };

  let channelFilter = 'all';

  // Voce 908f2eb9bbfb: one slow or failing read must never fail the whole
  // scheda. Every read settles on its own: the card stays the identity
  // source (without it there is no name to show), while every other read
  // feeds only its own section and carries its own failure there. A 404
  // keeps meaning "not composed here" (null, section hidden or empty as
  // before); any other failure is kept beside the value so the section
  // can name it instead of failing the card.
  // Voce 908f2eb9bbfb, review round 2: the work arrives as a thunk, so a
  // synchronously-throwing read settles like a rejection instead of escaping
  // while the Promise.all array is still being built.
  const settle = (thunk) => Promise.resolve().then(
    typeof thunk === 'function' ? thunk : () => thunk,
  ).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  const nullOn404 = (settled) => (settled.error && isNotComposedFailure(settled.error)
    ? { value: null, error: null }
    : settled);

  async function load(resource, id) {
    const encoded = `${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const spaceId = activeSpaceId();
    const [card, timelineRaw, profileRaw, enrichmentRaw, callsRaw, fieldDefsRaw, fieldValuesRaw] = await Promise.all([
      settle(() => client.request(`/api/customer-hub/card/${encoded}`)),
      settle(() => client.request(`/api/customer-hub/timeline/${encoded}`)),
      settle(() => client.request(`/api/customer-data/profile/${encoded}`)),
      // The enrichment read lives in the same package as the profile, so it
      // shares its fate — but an older server that does not serve the route
      // yet answers 404, and the scheda must stay honest about the section
      // instead of failing the whole card.
      settle(() => client.request(`/api/customer-data/enriched/${encoded}`)),
      // Without intelligence composed (honest 404) or without a space the
      // calls read stays unavailable — never a failed card.
      spaceId === null
        ? { value: null, error: null }
        : settle(() => client.request(`/api/call-intelligence/calls/${encoded}?spaceId=${encodeURIComponent(spaceId)}`)),
      // Custom fields (backlog:434cc39a): the space-wide definitions with
      // this customer's values. An older server without the routes answers
      // 404, and the section hides instead of failing the card.
      settle(() => fetchFieldDefs(client)),
      settle(() => fetchFieldValues(client, resource, id)),
    ]);
    // Voce 908f2eb9bbfb, review round 2: a 404/NOT_FOUND is not a failure to
    // retry — the package is not composed for this reader, so the read stays
    // null and the section keeps its honest not-composed state. Only a
    // non-404 failure names the retry error on the section.
    const timeline = nullOn404(timelineRaw);
    const profile = nullOn404(profileRaw);
    const enrichment = nullOn404(enrichmentRaw);
    const calls = nullOn404(callsRaw);
    const fieldDefs = nullOn404(fieldDefsRaw);
    const fieldValues = nullOn404(fieldValuesRaw);
    return {
      card: card.value,
      cardError: card.error,
      timeline: timeline.value,
      timelineError: timeline.error,
      profile: profile.value,
      profileError: profile.error,
      enrichment: enrichment.value,
      enrichmentError: enrichment.error,
      calls: calls.value,
      callsError: calls.error,
      fieldDefs: fieldDefs.value,
      fieldDefsError: fieldDefs.error,
      fieldValues: fieldValues.value,
      fieldValuesError: fieldValues.error,
    };
  }

  /** First Unicode letter of a word, or '?' when the word holds none. */
  function firstLetter(word) {
    const hit = String(word ?? '').match(/\p{L}/u);
    return hit ? hit[0] : '?';
  }

  /**
   * Initials for the header avatar ("Guido Presti" → "GP"): first letter of
   * the first and last word, uppercased. Text only, so a hostile name stays
   * inert text inside the circle.
   */
  function initialsFor(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    const last = words.length > 1 ? firstLetter(words[words.length - 1]) : '';
    return `${firstLetter(words[0])}${last}`.toUpperCase();
  }

  function header(panel, card, resource, id) {
    // BO-F6-09 fetta 2a: ghost back button, avatar with initials, H1 name
    // and the stato pill. The meta line (città · provenienza · referente) is
    // NOT rendered: no record holds it yet (the contact record has no city,
    // nothing names a referente), so the header shows the company instead —
    // never an invented meta. Fetta C3 (backlog:f84626a0) renders it now:
    // the origin is the earliest-observed identity the card reports; city
    // and referente have no record yet, so those segments are left out.
    void resource;
    void id;
    const back = el('button', 'bo-scheda-back', '← Clienti');
    back.setAttribute('type', 'button');
    back.setAttribute('data-action', 'back-to-clienti');
    back.addEventListener('click', () => navigate('#/customer-data'));
    panel.appendChild(back);
    const head = el('div', 'bo-scheda-head');
    const avatar = el('span', 'bo-scheda-avatar', initialsFor(card?.name));
    avatar.setAttribute('aria-hidden', 'true');
    head.appendChild(avatar);
    const titles = el('div', 'bo-scheda-titles');
    titles.appendChild(el('h1', 'bo-scheda-name', card?.name ?? 'Scheda cliente'));
    const meta = el('div', 'bo-scheda-meta');
    meta.appendChild(el('span', 'bo-scheda-badge', statusLabel(card?.status?.value)));
    // C3, as the prototype reads it: `<città> · via <canale> · la segue
    // <referente>`. Only what a record holds is shown: a missing segment is
    // left out, never written as `Da raccogliere` three times in a row
    // (that amber word belongs to the profile fields below). With no segment
    // at all the line keeps the company, as before C3. Only a system the
    // prototype names reads as its Italian label; every segment is text.
    const headline = card?.headline ?? null;
    const city = headline?.city?.available === true
      && typeof headline.city.value === 'string' && headline.city.value !== ''
      ? headline.city.value : null;
    const originSystem = headline?.origin?.available === true
      ? String(headline.origin.system ?? '').toLowerCase() : '';
    const origin = ownLabel(CHANNEL_LABELS, originSystem) ?? null;
    const follow = headline?.assignee?.available === true
      && typeof headline.assignee.value === 'string' && headline.assignee.value !== ''
      ? headline.assignee.value : null;
    const segments = [city, origin === null ? null : `via ${origin}`, follow === null ? null : `la segue ${follow}`]
      .filter((segment) => segment !== null);
    if (segments.length > 0) meta.appendChild(el('span', 'bo-scheda-sub', segments.join(' · ')));
    else if (card?.company?.name) meta.appendChild(el('span', 'bo-scheda-sub', card.company.name));
    titles.appendChild(meta);
    head.appendChild(titles);
    panel.appendChild(head);
  }

  /**
   * Voce 714433c2: the customer the creation flows start with. Only a
   * named contact/company record qualifies — anything else navigates
   * unpicked instead of inventing a customer.
   */
  function customerPickFor(navCtx, card) {
    const resource = navCtx?.resource;
    const id = navCtx?.id;
    const name = typeof card?.name === 'string' ? card.name.trim() : '';
    if ((resource !== 'contact' && resource !== 'company')) return null;
    if (typeof id !== 'string' || id === '' || name === '') return null;
    // The offer form files under a company: a company pick is its own
    // company, a contact pick rides the linked one (null when the scheda
    // knows none — the offer form then says so honestly).
    const companyId = typeof card?.company?.id === 'string' && card.company.id !== '' ? card.company.id : null;
    const companyName = typeof card?.company?.name === 'string' && card.company.name.trim() !== ''
      ? card.company.name.trim()
      : null;
    const company = resource === 'company'
      ? { id, name }
      : (companyId !== null && companyName !== null ? { id: companyId, name: companyName } : null);
    return { resource, id, name, company };
  }

  /**
   * The channels the «Scrivi» composer offers (backlog:e9b4fc2f): Email
   * through the linked Gmail, WhatsApp, Instagram, Messenger, SMS — the
   * same five the server route accepts, so the screen can never offer one
   * the send refuses. `facebook` is the Messenger connection channel, like
   * the scheda labels it; every row is text, never a raw channel key.
   * @param {any} card the frozen card from `read-customer-card`
   * @param {unknown} connections the sync-state entries (`GET /api/connectors`), or null before they load
   * @param {unknown} profile the space-profile answer (`GET /api/profile`, served by
   *   the pilot), or null when unreadable — its linked Gmail mailbox also
   *   connects Email (backlog:a935af6a6d19)
   */
  function composerChannelsFor(card, connections, profile) {
    const list = Array.isArray(connections) ? connections : [];
    // Voce a935af6a6d19: the profile Google link counts for Email. The
    // Connettori screen links channel connections (one row per account),
    // while Profilo links the operator's Gmail mailbox — without this the
    // composer says «non collegato» on a space whose mailbox is linked.
    // A revoked, errored or unreadable link changes nothing: only a
    // `connected` Gmail item with a mailbox connects the channel.
    const items = Array.isArray(profile?.connections?.items) && profile.connections.available === true
      ? profile.connections.items
      : [];
    const gmail = items.find((item) => item?.connector === 'gmail' && item?.status === 'connected'
      && typeof item?.account === 'string' && item.account.trim() !== '') ?? null;
    const gmailSender = gmail !== null ? gmail.account.trim() : null;
    const socials = Array.isArray(card?.socials) ? card.socials : [];
    const handleFor = (system) => {
      const found = socials.find((row) => String(row?.system ?? '').toLowerCase() === system
        && typeof row?.handle === 'string' && row.handle.trim() !== '');
      return found ? found.handle.trim() : null;
    };
    const phone = card?.phone?.available === true
      && typeof card.phone.value === 'string' && card.phone.value.trim() !== ''
      ? card.phone.value.trim() : null;
    const recipientFor = (channel) => {
      if (channel === 'email') {
        return typeof card?.email === 'string' && card.email.trim() !== '' ? card.email.trim() : null;
      }
      if (channel === 'whatsapp' || channel === 'sms') return phone;
      return handleFor(channel === 'instagram' ? 'instagram' : 'facebook');
    };
    return COMPOSER_CHANNEL_ORDER.map((channel) => {
      const recipient = recipientFor(channel);
      const live = matchConnections(channel, list).find((entry) => entry.status === 'active') ?? null;
      // The channel connection wins (it carries the connectionKey the send
      // queues on); the profile Gmail mailbox only fills the gap, with no
      // key — the server still needs its own email connection to send.
      const gmailLinked = channel === 'email' && live === null && gmailSender !== null;
      return Object.freeze({
        channel,
        label: ownLabel(CHANNEL_LABELS, channel) ?? channel,
        recipient,
        connected: live !== null || gmailLinked,
        connectionKey: live?.connectionKey ?? null,
        sender: gmailLinked ? gmailSender : null,
      });
    });
  }

  /** The worker still holds the send: a 504 naming its request to read back. */
  function isSendPending(error) {
    return error?.code === 'BO_SEND_PENDING'
      && typeof error.requestId === 'string' && error.requestId !== ''
      && typeof error.claimId === 'string' && error.claimId !== '';
  }

  /** One fresh idempotency key per send: retries reuse it, two sends never share it. */
  function freshMessageKey() {
    try {
      const uuid = globalThis.crypto?.randomUUID?.();
      if (typeof uuid === 'string' && uuid !== '') return uuid;
    } catch {
      // No secure randomness here: the dated fallback below stays unique.
    }
    return `composer-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }

  function quickActions(box, card, navCtx, extra = {}) {
    box.appendChild(el('h4', undefined, 'Azioni rapide'));
    const row = el('div', 'bo-scheda-actions');
    const phone = card?.phone?.available === true
      && typeof card.phone.value === 'string' && card.phone.value.trim() !== ''
      ? card.phone.value.trim() : null;
    if (phone !== null) {
      // Voce 105563eea902: voice-aware «Chiama» — the number is dialed from
      // the CRM only through a linked voice connection (the call then enters
      // the scheda cronologia through POST /api/customer-hub/calls); without
      // one the card says so and falls back to `tel:`, never logging a call
      // the CRM never placed. A hostile value stays text in the title: the
      // href is built only from the fallback branch below, never here.
      const call = el('button', 'bo-scheda-tile', 'Chiama');
      call.setAttribute('type', 'button');
      call.setAttribute('data-action', 'call-customer');
      call.setAttribute('title', `Chiama ${phone}`);
      call.addEventListener('click', () => {
        openCallPanel(box, card, navCtx, phone);
      });
      row.appendChild(call);
    } else {
      // Voce 1a066ddfe42a: the API reason stays in the response, never on screen.
      row.appendChild(el('span', 'bo-scheda-disabled', 'Nessun telefono collegato'));
      // Voce 105563eea902: the empty state offers its own cure — the
      // operator holds the number here, through POST /api/customer-hub/phone.
      const add = el('button', 'bo-scheda-tile', 'Aggiungi telefono');
      add.setAttribute('type', 'button');
      add.setAttribute('data-action', 'add-phone');
      add.setAttribute('title', 'Salva il numero del cliente per chiamarlo dalla scheda');
      add.addEventListener('click', () => {
        openPhonePanel(box, navCtx);
      });
      row.appendChild(add);
    }
    // Backlog:e9b4fc2f: no mailto: anymore — «Scrivi» opens the composer
    // inside the scheda, and Invia sends through the outbox worker.
    const writable = composerChannelsFor(card, null).filter((entry) => entry.recipient !== null);
    if (writable.length === 0) {
      row.appendChild(el('span', 'bo-scheda-disabled', 'nessun canale scrivibile'));
    } else {
      const write = el('button', 'bo-scheda-tile', 'Scrivi');
      write.setAttribute('type', 'button');
      write.setAttribute('data-action', 'compose-message');
      write.setAttribute('title', 'Scrivi al cliente sui suoi canali');
      write.addEventListener('click', () => {
        openComposer(card, navCtx);
      });
      row.appendChild(write);
    }
  /**
   * The «Aggiungi telefono» panel (voce 105563eea902): the operator holds
   * one callable number beside the customer, through
   * `POST /api/customer-hub/phone`. The server validates E.164 and refuses
   * a number already held beside another customer (409); the panel shows
   * the Italian sentence, never the code. A saved number re-reads the whole
   * card, like the Dettagli form — the shown number is the server's, never
   * an optimistic copy.
   */
  function openPhonePanel(box, navCtx) {
    const old = box.querySelector('div[data-phone="open"]');
    if (old) {
      while (old.firstChild) old.removeChild(old.firstChild);
    }
    const panel = old ?? el('div', 'bo-scheda-composer');
    panel.setAttribute('data-phone', 'open');
    if (!old) box.appendChild(panel);
    panel.appendChild(el('h4', undefined, 'Aggiungi telefono'));
    const input = el('input');
    input.setAttribute('type', 'tel');
    input.setAttribute('placeholder', '+393331234567');
    input.setAttribute('aria-label', 'Numero di telefono in formato internazionale');
    panel.appendChild(input);
    const err = el('p', 'field-error', '');
    const row = el('div', 'bo-scheda-form-actions');
    const save = el('button', undefined, 'Salva');
    save.setAttribute('type', 'button');
    save.setAttribute('data-action', 'save-phone');
    const cancel = el('button', undefined, 'Annulla');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-action', 'cancel-phone');
    row.appendChild(save);
    row.appendChild(cancel);
    panel.appendChild(row);
    panel.appendChild(err);
    let busy = false;
    save.addEventListener('click', async () => {
      if (busy) return;
      const phone = input.value.trim();
      if (phone === '') {
        err.textContent = 'Scrivi il numero prima di salvarlo.';
        return;
      }
      busy = true;
      err.textContent = '';
      try {
        await client.request('/api/customer-hub/phone', {
          method: 'POST',
          body: JSON.stringify({ resource: navCtx.resource, id: navCtx.id, phone }),
        });
        toast('Telefono salvato');
        await renderCard(navCtx.resource, navCtx.id);
      } catch (error) {
        err.textContent = humanReadError(error, { failed: 'Numero non salvato. Riprova più tardi.' });
      } finally {
        busy = false;
      }
    });
    cancel.addEventListener('click', async () => {
      await renderCard(navCtx.resource, navCtx.id);
    });
  }
  /**
   * The voice-aware «Chiama» panel (voce 105563eea902): with an active
   * voice connection the operator declares the outcome and the call is
   * logged through `POST /api/customer-hub/calls`, entering the scheda
   * cronologia; without one the panel says so and offers the device
   * dialer (`tel:`) instead — never a logged call the CRM never placed.
   * The dialed number is shown, never sent: the server re-derives it from
   * the card.
   */
  // Voce 105563eea902 (giri 1-2): one source of truth for the device
  // dialer. Dialing needs no space and no connectors read, so every
  // branch that cannot offer the CRM-logged form still offers the same
  // tel: fallback — no space, no linked voice, or a connectors read that
  // failed (404 not composed or any other error).
  const appendDeviceDialFallback = (into, dialPhone) => {
    const dialable = dialPhone.replaceAll(/[^\d+]/g, '');
    into.appendChild(link(
      `tel:${dialable === '' ? dialPhone : dialable}`,
      `Chiama ${dialPhone} (tel:)`, 'call-fallback'));
  };
  function openCallPanel(box, card, navCtx, phone) {
    const old = box.querySelector('div[data-call="open"]');
    if (old) {
      while (old.firstChild) old.removeChild(old.firstChild);
    }
    const panel = old ?? el('div', 'bo-scheda-composer');
    panel.setAttribute('data-call', 'open');
    if (!old) box.appendChild(panel);
    panel.appendChild(el('h4', undefined, 'Chiama dal CRM'));
    const spaceId = activeSpaceId();
    if (spaceId === null) {
      panel.appendChild(el('p', 'bo-muted', 'Scegli uno spazio per chiamare dal CRM.'));
      appendDeviceDialFallback(panel, phone);
      return;
    }
    const wait = el('p', 'bo-muted', 'Controllo il connettore voce…');
    panel.appendChild(wait);
    client.request(`/api/connectors?spaceId=${encodeURIComponent(spaceId)}`).then(
      (sync) => {
        panel.removeChild(wait);
        const entries = Array.isArray(sync?.connectors) ? sync.connectors : [];
        // The same gate the calls route enforces: active AND a non-empty
      // connectionKey. An entry without a key would be refused 409
      // VOICE_CONNECTION_NOT_ACTIVE after the operator already filled the
      // outcome form, so the form is offered exactly when the route would
      // accept it.
      const voice = matchConnections('voice', entries)
        .find((entry) => entry.status === 'active'
          && typeof entry.connectionKey === 'string' && entry.connectionKey !== '') ?? null;
        if (voice === null) {
          panel.appendChild(el('p', 'bo-muted',
            'Nessun connettore voce collegato: la chiamata parte dal telefono del computer.'));
          appendDeviceDialFallback(panel, phone);
          return;
        }
        buildCallForm(panel, navCtx, spaceId, phone);
      },
      (error) => {
        panel.removeChild(wait);
        panel.appendChild(el('p', 'bo-muted',
          'La chiamata dal CRM non è disponibile qui: chiama dal telefono.'));
        panel.appendChild(el('p', 'field-error', humanReadError(error, {
          failed: 'Il connettore voce non si è potuto leggere. Riprova più tardi.',
        })));
        appendDeviceDialFallback(panel, phone);
      },
    );
  }
  function buildCallForm(panel, navCtx, spaceId, phone) {
    panel.appendChild(el('p', 'bo-muted',
      `Chiamata al ${phone} dal CRM: dopo la chiamata dichiara com'è andata.`));
    const outcomeLabel = el('label', 'bo-scheda-field-label', "Com'è andata la chiamata?");
    outcomeLabel.setAttribute('for', 'call-outcome');
    const outcome = el('select');
    outcome.setAttribute('id', 'call-outcome');
    for (const choice of [
      { value: 'completed', label: 'Completata' },
      { value: 'missed', label: 'Persa' },
      { value: 'no-answer', label: 'Senza risposta' },
      { value: 'failed', label: 'Fallita' },
    ]) {
      const option = el('option', undefined, choice.label);
      option.setAttribute('value', choice.value);
      outcome.appendChild(option);
      if (outcome.value === undefined || outcome.value === '') outcome.value = choice.value;
    }
    panel.appendChild(outcomeLabel);
    panel.appendChild(outcome);
    // The 'Fallita' outcome needs the errorCode validateCallRequest
    // requires, and no other outcome may send one: the code field lives in
    // this wrapper only while 'failed' is picked, so the payload carries
    // errorCode exactly when the server demands it.
    const codeWrap = el('div');
    codeWrap.setAttribute('data-code', 'error-code');
    const codeLabel = el('label', 'bo-scheda-field-label', 'Codice errore (solo se fallita)');
    codeLabel.setAttribute('for', 'call-error-code');
    const code = el('input');
    code.setAttribute('id', 'call-error-code');
    code.value = '';
    const syncCodeField = () => {
      if (outcome.value === 'failed') {
        if (!codeWrap.contains(code)) {
          codeWrap.appendChild(codeLabel);
          codeWrap.appendChild(code);
        }
      } else {
        codeWrap.textContent = '';
      }
    };
    outcome.addEventListener('change', syncCodeField);
    panel.appendChild(codeWrap);
    const durationLabel = el('label', 'bo-scheda-field-label', 'Durata in secondi (solo se completata)');
    durationLabel.setAttribute('for', 'call-duration');
    const duration = el('input');
    duration.setAttribute('id', 'call-duration');
    duration.setAttribute('inputmode', 'numeric');
    duration.value = '0';
    panel.appendChild(durationLabel);
    panel.appendChild(duration);
    const err = el('p', 'field-error', '');
    const save = el('button', undefined, 'Registra chiamata');
    save.setAttribute('type', 'button');
    save.setAttribute('data-action', 'log-call');
    panel.appendChild(save);
    panel.appendChild(err);
    let busy = false;
    save.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      err.textContent = '';
      try {
        const callBody = {
          spaceId,
          resource: navCtx.resource,
          id: navCtx.id,
          callKey: freshMessageKey(),
          outcome: outcome.value,
          durationSec: Number(duration.value),
        };
        if (outcome.value === 'failed') {
          const errorCode = code.value.trim();
          if (errorCode === '') {
            err.textContent = 'Indica il codice di errore per una chiamata fallita.';
            return;
          }
          callBody.errorCode = errorCode;
        }
        await client.request('/api/customer-hub/calls', {
          method: 'POST',
          body: JSON.stringify(callBody),
        });
        toast('Chiamata registrata');
        await renderCard(navCtx.resource, navCtx.id);
      } catch (error) {
        err.textContent = humanReadError(error, { failed: 'Chiamata non registrata. Riprova più tardi.' });
      } finally {
        busy = false;
      }
    });
  }
  /**
   * The «Scrivi» composer panel (backlog:e9b4fc2f): channel choice among
   * the customer's own channels, preselected recipient, text, Invia.
   * A channel without a connection reads switched off with its link to
   * Connettori — except Email with the space Gmail linked in the profile,
   * which reads connected with its sender (backlog:a935af6a6d19); a channel
   * without any address names that instead. Invia queues through
   * `POST /api/customer-hub/messages` — the recipient stays server-derived,
   * the panel only shows it.
   */
  // Voce 8ce25b0f445f: every Scrivi press opens a new composer generation.
  // A slow first load never paints over (or crashes on) a newer opening:
  // stale callbacks return without touching the panel.
  let composerGeneration = 0;

  function openComposer(card, navCtx) {
    const generation = (composerGeneration += 1);
    // The window hangs off the view, not off the Azioni column: a sticky
    // column is its own stacking layer painted in page order, so a fixed
    // window inside the left column sat under the right one (#605).
    const old = mount.querySelector('div[data-composer="open"]');
    if (old) {
      while (old.firstChild) old.removeChild(old.firstChild);
    }
    const panel = old ?? el('div', 'bo-scheda-composer');
    panel.setAttribute('data-composer', 'open');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Scrivi al cliente');
    panel.removeAttribute?.('data-minimized');
    if (!old) mount.appendChild(panel);
    // Gmail-style window (Dan 04/11): a header bar with the purpose and the
    // customer, minimize and close; the form lives in the body below.
    const head = el('div', 'bo-composer-head');
    const customer = typeof card?.name === 'string' ? card.name.trim() : '';
    const title = el('h4', 'bo-composer-title', 'Scrivi al cliente');
    if (customer !== '') title.appendChild(el('span', 'bo-composer-to-name', ` · ${customer}`));
    head.appendChild(title);
    const minimize = el('button', 'bo-composer-icon', '–');
    minimize.setAttribute('type', 'button');
    minimize.setAttribute('aria-label', 'Riduci');
    minimize.setAttribute('data-action', 'composer-minimize');
    minimize.addEventListener('click', () => {
      if (panel.getAttribute('data-minimized') === 'true') panel.removeAttribute?.('data-minimized');
      else panel.setAttribute('data-minimized', 'true');
    });
    const close = el('button', 'bo-composer-icon', '✕');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Chiudi');
    close.setAttribute('data-action', 'composer-close');
    close.addEventListener('click', () => {
      // Closing supersedes this composer: pending loads and AI drafts stop.
      composerGeneration += 1;
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    });
    head.appendChild(minimize);
    head.appendChild(close);
    panel.appendChild(head);
    const spaceId = activeSpaceId();
    if (spaceId === null) {
      panel.appendChild(el('p', 'bo-muted', 'Scegli uno spazio per collegare i canali e inviare.'));
      return;
    }
    const wait = el('p', 'bo-muted', 'Leggo i canali collegati…');
    panel.appendChild(wait);
    // Voce a935af6a6d19: Email also reads the space profile's Gmail link
    // (`GET /api/profile`, served by the pilot). An unreadable profile
    // resolves to null and changes nothing — the channel connections
    // decide alone, like before.
    readProfile(client).then((profile) => {
      if (generation !== composerGeneration) return;
      client.request(`/api/connectors?spaceId=${encodeURIComponent(spaceId)}`).then(
      (sync) => {
        if (generation !== composerGeneration) return;
        if (wait.parentNode === panel) panel.removeChild(wait);
        buildComposerForm(panel, card, navCtx, spaceId, Array.isArray(sync?.connectors) ? sync.connectors : [], profile);
      },
      (error) => {
        if (generation !== composerGeneration) return;
        if (wait.parentNode === panel) panel.removeChild(wait);
        if (isNotComposedFailure(error)) {
          buildComposerForm(panel, card, navCtx, spaceId, [], profile);
          return;
        }
        panel.appendChild(el('p', 'field-error', humanReadError(error, {
          failed: 'I canali non si sono potuti leggere. Riprova più tardi.',
        })));
      },
      );
    });
  }

  /**
   * «Chiedi all'AI» (Dan 05/11: the composer is agentic — a prompt writes
   * the text, as an alternative to writing it from scratch). The prompt goes
   * to `POST /api/customer-hub/messages/draft` { spaceId, contactId, channel,
   * prompt } → { subject?, body }: the server drafts from the customer's
   * own history through the space LLM gate and never sends. The draft lands
   * in the message field, editable; the previous text can be restored once
   * with «Annulla»; Invia stays the person's click. AI off (503
   * LLM_SPACE_DISABLED / LLM_SECRET_UNAVAILABLE) or a pilot without the
   * route (404/405) turns the row into one honest line, never a dead button.
   */
  const COMPOSER_PROMPT_MAX = 500;
  function composerAiRow({ spaceId, navCtx, text, channel, subject, restoreSubject, changed, baseline, setBaseline }) {
    const row = el('div', 'bo-composer-ai');
    // The composer generation this row was built in: Scrivi again, ✕ or Esc
    // supersede it (openComposer bumps the counter on every opening).
    const born = composerGeneration;
    const stale = () => born !== composerGeneration || row.isConnected === false;
    const mark = el('span', 'bo-composer-ai-mark', '✦');
    mark.setAttribute('aria-hidden', 'true');
    const prompt = el('input', 'bo-composer-ai-input');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('aria-label', 'Chiedi all’AI di scrivere il messaggio');
    prompt.setAttribute('placeholder', 'Chiedi all’AI: «conferma la prova di giovedì, tono amichevole»');
    prompt.setAttribute('maxlength', String(COMPOSER_PROMPT_MAX));
    const go = el('button', 'bo-composer-ai-go', 'Genera');
    go.setAttribute('type', 'button');
    go.setAttribute('data-action', 'composer-ai-generate');
    const line = el('p', 'bo-composer-ai-line', '');
    line.setAttribute('aria-live', 'polite');
    const field = el('div', 'bo-composer-ai-field');
    field.appendChild(mark);
    field.appendChild(prompt);
    field.appendChild(go);
    row.appendChild(field);
    row.appendChild(line);
    let busy = false;
    // The person's own text before the first AI draft (review #599 P2): kept
    // with the shared per-customer draft, so Annulla survives ✕/Esc and a
    // reopen, and restores the subject too.
    const off = (sentence) => {
      while (row.firstChild) row.removeChild(row.firstChild);
      row.setAttribute('data-off', 'true');
      row.appendChild(el('p', 'bo-composer-ai-off', sentence));
    };
    const say = (sentence, undo = false) => {
      while (line.firstChild) line.removeChild(line.firstChild);
      line.textContent = '';
      if (sentence === '') return;
      line.appendChild(el('span', undefined, sentence));
      if (undo) {
        const back = el('button', 'bo-composer-ai-undo', 'Annulla');
        back.setAttribute('type', 'button');
        back.setAttribute('data-action', 'composer-ai-undo');
        back.addEventListener('click', () => {
          const kept = baseline();
          if (kept === null) return;
          text.value = kept.text;
          // Muse P2 on #599: with no subject field mounted (channel switched
          // to WhatsApp) the undone subject goes to the shared draft, so the
          // AI subject never comes back when Email returns.
          restoreSubject(kept.subject);
          setBaseline(null);
          changed();
          go.textContent = 'Genera';
          say('Testo di prima ripristinato.');
        });
        line.appendChild(el('span', undefined, ' · '));
        line.appendChild(back);
      }
    };
    async function generate() {
      if (busy) return;
      const words = prompt.value.trim().slice(0, COMPOSER_PROMPT_MAX);
      const picked = channel();
      if (words === '') {
        say('Scrivi cosa vuoi dire al cliente, poi Genera.');
        return;
      }
      if (picked === null) {
        say('Nessun canale collegato: l’AI scrive per il canale scelto.');
        return;
      }
      busy = true;
      go.setAttribute('disabled', 'disabled');
      go.textContent = 'Scrivo…';
      say('');
      try {
        const answer = await client.request('/api/customer-hub/messages/draft', {
          method: 'POST',
          body: JSON.stringify({ spaceId, contactId: navCtx.id, channel: picked, prompt: words }),
        });
        // Review #599 P2: the composer may have been closed or reopened while
        // the AI wrote. A stale answer never touches a detached form nor the
        // shared per-customer draft.
        if (stale()) return;
        const drafted = typeof answer?.body === 'string' ? answer.body.trim() : '';
        if (drafted === '') {
          say('L’AI non ha scritto niente: prova a dirlo in un altro modo.');
          return;
        }
        const subjectField = subject();
        // Regenerating keeps the person's original, never a previous AI draft.
        if (baseline() === null) setBaseline({ text: text.value, subject: subjectField !== null ? subjectField.value : '' });
        text.value = drafted.slice(0, 2000);
        const title = typeof answer?.subject === 'string' ? answer.subject.trim() : '';
        if (subjectField !== null && title !== '' && subjectField.value.trim() === '') subjectField.value = title.slice(0, 256);
        changed();
        go.textContent = 'Rigenera';
        const kept = baseline();
        say('Bozza dell’AI: rileggila e modificala prima di inviare.', kept !== null && (kept.text.trim() !== '' || kept.subject.trim() !== ''));
        if (typeof text.focus === 'function') text.focus();
      } catch (error) {
        if (stale()) return;
        const code = error?.code ?? null;
        const status = error?.status ?? null;
        const aiOff = code === 'LLM_SPACE_DISABLED' || code === 'LLM_SECRET_UNAVAILABLE' || status === 404 || status === 405;
        // The operator sees why the row went quiet; never the person's prompt.
        if (aiOff && typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] AI spenta nel composer', { code, status: typeof status === 'number' ? status : null, spaceId: spaceId ?? null });
        }
        if (code === 'LLM_SPACE_DISABLED') off('L’AI non è attiva in questo spazio: scrivi il messaggio qui sotto.');
        else if (code === 'LLM_SECRET_UNAVAILABLE') off('L’AI non è ancora configurata: scrivi il messaggio qui sotto.');
        else if (status === 404 || status === 405) off('La scrittura con l’AI non è ancora disponibile qui: scrivi il messaggio qui sotto.');
        else if (status === 400) say('Richiesta non valida: scrivila più breve e con parole tue.');
        else say(humanReadError(error, { failed: 'L’AI non ha risposto. Riprova tra poco.' }));
      } finally {
        busy = false;
        if (row.getAttribute('data-off') !== 'true') {
          go.removeAttribute?.('disabled');
          if (go.textContent === 'Scrivo…') go.textContent = baseline() === null ? 'Genera' : 'Rigenera';
        }
      }
    }
    go.addEventListener('click', () => { void generate(); });
    // Reopened after an AI draft: the way back to the person's text stays.
    const kept = baseline();
    if (kept !== null) {
      go.textContent = 'Rigenera';
      say('Bozza dell’AI: rileggila e modificala prima di inviare.', kept.text.trim() !== '' || kept.subject.trim() !== '');
    }
    prompt.addEventListener?.('keydown', (event) => {
      if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
        event.preventDefault?.();
        // The composer's Cmd/Ctrl+Invio still means Invia; plain Invio in
        // the prompt means Genera, never a send.
        event.stopPropagation?.();
        void generate();
      }
    });
    return row;
  }

  // Composer drafts by customer (Gmail habit, never lose text): ✕ and Esc
  // close the window, the typed text and subject stay here and come back
  // when the composer reopens on the same customer. Cleared only by a send
  // the server accepted. In memory: a reload still drops them, like any
  // unsent form.
  const composerDrafts = new Map();
  // The idempotency key of a send whose outcome is not yet known, keyed by
  // the message itself (draft, channel, connection, subject, trimmed text). A re-tap of the same message reuses it, so
  // the server finds its own request instead of mailing twice (production
  // 06/11: the worker sent at +2.5 min while the panel said «non inviato»).
  // A changed text, subject or channel is a new message with a new key; a
  // definitive answer (sent, refused, failed) drops the key.
  const composerSendKeys = new Map();

  function buildComposerForm(panel, card, navCtx, spaceId, connections, profile) {
    // Keyed by space too: a draft never crosses into another workspace
    // (Muse P2 on #588), the same boundary the send payload keeps.
    const draftKey = `${spaceId ?? ''}:${navCtx?.resource ?? ''}:${navCtx?.id ?? ''}`;
    const draft = composerDrafts.get(draftKey) ?? { text: '', subject: '', aiBefore: null };
    const keepDraft = () => {
      const subject = subjectInput !== null ? subjectInput.value : draft.subject;
      const aiBefore = draft.aiBefore ?? null;
      if (text.value === '' && subject === '' && aiBefore === null) composerDrafts.delete(draftKey);
      else composerDrafts.set(draftKey, { text: text.value, subject, aiBefore });
      draft.subject = subject;
    };
    const channels = composerChannelsFor(card, connections, profile);
    const body = el('div', 'bo-composer-body');
    // Channel chips: one radio per channel (kept for keyboard and tests),
    // visually a pill row like Gmail's «Da/A» chips. Unusable channels stay
    // visible but switched off, and say why in one line under the row.
    const list = el('div', 'bo-scheda-composer-channels');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Canale');
    const offLine = el('p', 'bo-composer-off', '');
    const fromRow = el('div', 'bo-composer-row');
    const toRow = el('div', 'bo-composer-row');
    const toLine = el('span', 'bo-composer-value', '');
    const fromValue = el('span', 'bo-composer-value', '');
    fromRow.appendChild(el('span', 'bo-composer-label', 'Da'));
    fromRow.appendChild(fromValue);
    toRow.appendChild(el('span', 'bo-composer-label', 'A'));
    toRow.appendChild(toLine);
    const subjectHolder = el('div', 'bo-composer-subject-row', '');
    const text = el('textarea', 'bo-scheda-composer-text');
    text.setAttribute('rows', '8');
    text.setAttribute('placeholder', 'Scrivi il messaggio…');
    text.setAttribute('aria-label', 'Messaggio');
    if (draft.text !== '') text.value = draft.text;
    text.addEventListener?.('input', keepDraft);
    const foot = el('div', 'bo-composer-foot');
    const limitHint = el('span', 'bo-composer-limit', 'Massimo 2000 caratteri');
    const err = el('p', 'field-error', '');
    const send = el('button', 'primary', 'Invia');
    send.setAttribute('type', 'button');
    send.setAttribute('data-action', 'composer-send');
    let selected = null;
    let subjectInput = null;
    const radios = [];
    const select = (entry) => {
      selected = entry;
      for (const row of radios) {
        row.radio.checked = row.entry === entry;
        row.chip.setAttribute('data-selected', row.entry === entry ? 'true' : 'false');
      }
      toLine.textContent = entry.recipient;
      const sender = typeof entry.sender === 'string' && entry.sender !== '' ? entry.sender : '';
      fromValue.textContent = sender;
      fromRow.setAttribute('data-empty', sender === '' ? 'true' : 'false');
      if (subjectInput !== null) {
        subjectHolder.removeChild(subjectInput);
        subjectInput = null;
      }
      subjectHolder.setAttribute('data-empty', entry.channel === 'email' ? 'false' : 'true');
      if (entry.channel === 'email') {
        subjectInput = el('input', 'bo-scheda-composer-subject');
        subjectInput.setAttribute('type', 'text');
        subjectInput.setAttribute('placeholder', 'Oggetto');
        subjectInput.setAttribute('aria-label', 'Oggetto');
        subjectInput.setAttribute('maxlength', '256');
        if (draft.subject !== '') subjectInput.value = draft.subject;
        subjectInput.addEventListener?.('input', keepDraft);
        subjectHolder.appendChild(subjectInput);
      }
    };
    const offLinked = [];
    for (const entry of channels) {
      const chip = el('label', 'bo-scheda-composer-channel');
      const radio = el('input', undefined, '');
      radio.setAttribute('type', 'radio');
      radio.setAttribute('name', 'composer-channel');
      radio.setAttribute('value', entry.channel);
      chip.appendChild(radio);
      chip.appendChild(el('span', undefined, entry.label));
      if (entry.recipient === null) {
        radio.setAttribute('disabled', 'disabled');
        chip.setAttribute('data-off', 'true');
        chip.setAttribute('title', `${entry.label}: nessun indirizzo su questo canale`);
      } else if (!entry.connected) {
        radio.setAttribute('disabled', 'disabled');
        chip.setAttribute('data-off', 'true');
        chip.setAttribute('title', `${entry.label}: ${entry.recipient}, non collegato`);
        // Voce 8ce25b0f445f: the address reads in the line too, not only in
        // the title — a phone has no hover.
        offLinked.push(`${entry.label} (${entry.recipient})`);
      } else {
        chip.setAttribute('title', `${entry.label}: ${entry.recipient}`);
        radio.addEventListener('click', () => select(entry));
        // Arrow keys move a radio with `change`, not `click` (Muse P2 on #588).
        radio.addEventListener('change', () => select(entry));
        if (selected === null) selected = entry;
      }
      list.appendChild(chip);
      radios.push({ entry, radio, chip });
    }
    if (offLinked.length > 0) {
      offLine.appendChild(el('span', undefined, `${offLinked.join(', ')}: canale non collegato · `));
      offLine.appendChild(link('#/connettori', 'Collega in Connettori', 'composer-connectors'));
    }
    body.appendChild(list);
    if (offLinked.length > 0) body.appendChild(offLine);
    body.appendChild(fromRow);
    body.appendChild(toRow);
    body.appendChild(subjectHolder);
    const ai = composerAiRow({
      spaceId, navCtx, text,
      channel: () => (selected !== null ? selected.channel : null),
      subject: () => subjectInput,
      restoreSubject: (value) => {
        if (subjectInput !== null) subjectInput.value = value;
        else draft.subject = value;
      },
      changed: keepDraft,
      baseline: () => draft.aiBefore ?? null,
      setBaseline: (value) => { draft.aiBefore = value; keepDraft(); },
    });
    body.appendChild(ai);
    body.appendChild(text);
    body.appendChild(err);
    foot.appendChild(send);
    foot.appendChild(limitHint);
    panel.appendChild(body);
    panel.appendChild(foot);
    if (selected !== null) select(selected);
    else {
      send.setAttribute('disabled', 'disabled');
      toLine.textContent = 'Nessun canale collegato per questo cliente';
      fromRow.setAttribute('data-empty', 'true');
      subjectHolder.setAttribute('data-empty', 'true');
    }
    // Gmail habits: Esc closes, Cmd/Ctrl+Invio sends. openComposer reuses the
    // panel across rebuilds, so the listener is added once per panel and
    // always reaches the current form's send (Muse P1 on #588: one listener
    // per rebuild queued one POST each).
    panel.__composerSend = () => doSend();
    if (panel.__composerKeys !== true) {
      panel.__composerKeys = true;
      panel.addEventListener?.('keydown', (event) => {
        if (event.key === 'Escape') {
          composerGeneration += 1;
          if (panel.parentNode) panel.parentNode.removeChild(panel);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault?.();
          if (typeof panel.__composerSend === 'function') void panel.__composerSend();
        }
      });
    }
    if (typeof text.focus === 'function' && selected !== null) text.focus();
    let busy = false;
    send.addEventListener('click', () => { void doSend(); });
    const setBusy = (on) => {
      busy = on;
      send.textContent = on ? 'Invio…' : 'Invia';
      if (on) send.setAttribute('disabled', 'disabled');
      else send.removeAttribute?.('disabled');
      send.setAttribute('aria-busy', on ? 'true' : 'false');
    };
    const showStatus = (message) => {
      err.textContent = message;
      err.setAttribute('data-tone', message === '' ? '' : 'pending');
    };
    const showError = (message) => {
      err.textContent = message;
      err.setAttribute('data-tone', 'error');
    };
    async function doSend() {
      if (busy || selected === null) return;
      // The window this send belongs to. Reopening «Scrivi» rebuilds the
      // form in the same panel and bumps the generation: from then on this
      // send is stale and never touches the UI (the key stays, so the same
      // text sent again from the new form reads back the same request).
      const generation = composerGeneration;
      const stale = () => generation !== composerGeneration || panel.parentNode == null;
      if (text.value.trim() === '') {
        showError('Scrivi il messaggio prima di inviarlo.');
        return;
      }
      setBusy(true);
      showStatus('');
      const payload = {
        spaceId,
        resource: navCtx.resource,
        id: navCtx.id,
        channel: selected.channel,
        text: text.value,
      };
      if (selected.connectionKey !== null) payload.connectionKey = selected.connectionKey;
      if (selected.channel === 'email' && subjectInput !== null && subjectInput.value.trim() !== '') {
        payload.subject = subjectInput.value.trim();
      }
      // Trimmed like the empty check above: a trailing space or newline
      // added after a pending send is still the same message.
      const sendKey = `${draftKey}\0${payload.channel}\0${payload.connectionKey ?? ''}\0${payload.subject ?? ''}\0${payload.text.trim()}`;
      // One key per message, never one slot per customer: a second message
      // sent while the first is still queued must not evict its key.
      const messageKey = composerSendKeys.get(sendKey) ?? freshMessageKey();
      composerSendKeys.set(sendKey, messageKey);
      payload.messageKey = messageKey;
      const sent = async () => {
        if (stale()) return;
        composerSendKeys.delete(sendKey);
        composerDrafts.delete(draftKey);
        toast('Messaggio in consegna');
        await renderCard(navCtx.resource, navCtx.id);
      };
      try {
        await client.request('/api/customer-hub/messages', { method: 'POST', body: JSON.stringify(payload) });
        await sent();
        return;
      } catch (error) {
        if (stale()) return;
        if (!isSendPending(error)) {
          failSend(error, sendKey);
          return;
        }
        // The worker holds the message: say so and read the same request
        // back, never a second POST. The log carries the ids to trace it,
        // never the claim or the text.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] invio in attesa', { code: error.code, status: typeof error.status === 'number' ? error.status : null, requestId: error.requestId });
        }
        showStatus('In consegna: il messaggio è in coda. Non serve inviarlo di nuovo.');
        let pending = error;
        for (let round = 0; round < SEND_RESUME_ROUNDS; round += 1) {
          await wait(SEND_RESUME_EVERY_MS);
          // The panel was closed or reopened: stop reading back. The key
          // stays, so a re-tap after reopening still finds the same request.
          if (stale()) return;
          try {
            const query = `spaceId=${encodeURIComponent(spaceId)}&requestId=${encodeURIComponent(pending.requestId)}&claimId=${encodeURIComponent(pending.claimId)}`;
            await client.request(`/api/customer-hub/messages?${query}`);
            await sent();
            return;
          } catch (next) {
            if (stale()) return;
            if (isSendPending(next)) {
              pending = next;
              continue;
            }
            // The worker's verdict on the original send: failed or
            // cancelled. Only this ends the wait with an error.
            if (next?.code === 'BO_SEND_FAILED' || next?.code === 'BO_SEND_CANCELLED') {
              failSend(next, sendKey);
              return;
            }
            // A transient miss of the read itself (gateway, network, rate
            // limit, unreadable status): the message is still queued, keep
            // reading the same request.
            if (!isDefinitiveRefusal(next)) continue;
            // The read was refused outright: the send's outcome is unknown,
            // never «non inviato». The key stays for a safe re-tap.
            showStatus(SEND_UNCERTAIN);
            return;
          }
        }
        // Still queued: the key stays, so a re-tap finds the same request.
        if (stale()) return;
        showStatus('Ancora in coda: comparirà nella cronologia appena parte. Non serve inviarlo di nuovo.');
      } finally {
        if (!stale()) setBusy(false);
      }
    }
    function failSend(error, sendKey) {
      // Only a definitive answer drops the key and reads «non inviato»: a
      // refused request replayed under the same key would answer the same
      // refusal forever. An unknown outcome (gateway timeout, 5xx, 408/425/
      // 429, network) keeps the key — the first request may still be queued,
      // and a re-tap under the same key cannot mail twice.
      if (!isDefinitiveRefusal(error) && error?.code !== 'BO_SEND_FAILED' && error?.code !== 'BO_SEND_CANCELLED') {
        humanReadError(error, { failed: SEND_UNCERTAIN });
        showStatus(SEND_UNCERTAIN);
        return;
      }
      composerSendKeys.delete(sendKey);
      const logged = humanReadError(error, { failed: 'Messaggio non inviato. Riprova più tardi.' });
      const formErrors = apiErrorToFormErrors(error);
      showError(formErrors.fields.text ?? logged);
    }
  }
    // Voce 714433c2: «Nuova offerta» and «Nuovo appuntamento» start the
    // creation flows with this customer already chosen. The pick travels
    // as a one-time handoff the target screen takes on render (the router
    // carries path-only hashes, so no query tail); without a named record
    // or without a storage the buttons still navigate, and the creation
    // screen opens unpicked instead of inventing a customer.
    const pick = customerPickFor(navCtx, card);
    // Voce c2793930850a: the creation voices are tiles like Chiama and
    // Scrivi — the 2x2 grid below stays equal, no bare button overflows it.
    const offer = el('button', 'bo-scheda-tile', 'Nuova offerta');
    offer.setAttribute('type', 'button');
    offer.setAttribute('data-action', 'new-offer');
    offer.addEventListener('click', () => {
      if (pick !== null) writePendingCustomerPick(storage, 'offer', pick);
      navigate('#/modules/opportunity/new');
    });
    row.appendChild(offer);
    const appointment = el('button', 'bo-scheda-tile', 'Nuovo appuntamento');
    appointment.setAttribute('type', 'button');
    appointment.setAttribute('data-action', 'new-appointment');
    appointment.addEventListener('click', () => {
      if (pick !== null) writePendingCustomerPick(storage, 'appointment', pick);
      navigate('#/calendario');
    });
    row.appendChild(appointment);
    box.appendChild(row);
  }

  function linkedIdentities(box, profile, timeline, profileError = null, timelineError = null) {
    // Voce 1a066ddfe42a: every identity reads as plain Italian — a resource
    // label and a role label, never a bare id or UUID. The English cluster
    // note stays in the API response, never on screen.
    // Voce 59def6cb805d (C10): one row per observed channel — the badge the
    // prototype paints plus the handle the outside world called this customer.
    // Only systems with an Italian label read on screen (the enrichment-only
    // `google-contacts` system and UUID handles never do); a sync direction
    // (`↔ sincronizzato` / `← in entrata`) is NOT printed here because the
    // profile carries no connector direction — that needs the
    // channel-connection exposure of arch fetta 3, noted in the PR.
    // Voce 826e377c, read-only since the owner split manual Collega/Scollega
    // into a follow-up voce: the rows list only the channels observed on the
    // customer's own messages (the timeline the scheda already loads), so
    // messages list their number, handle or address with no buttons.
    box.appendChild(el('h4', undefined, 'Identità collegate'));
    // Voce 908f2eb9bbfb, review round 2: a failed profile read fails this
    // section too — hiding it would read as "no identities", which is a
    // different claim from "the read failed".
    if (profileError) {
      readError(box, profileError, 'Le identità non si sono potute leggere. Riprova più tardi.');
      return;
    }
    const cluster = profile?.canonicalIdentity;
    if (!cluster) {
      box.appendChild(el('p', 'bo-muted', 'identità non leggibili: il profilo non è disponibile'));
      return;
    }
    // Voce 826e377c review giro-6 (P1 head f1ed030c): a timeline read
    // failure must not claim knowledge of zero channels — merging null
    // yields zero rows and the zero-row branch would print 'nessun canale
    // osservato' beside the failure notice. The section names the failure
    // and stops: no count, no empty claim, no rows.
    if (timelineError) {
      readError(box, timelineError, 'I canali osservati non si sono potuti leggere. Riprova più tardi.');
      return;
    }
    const merged = mergeLinkedIdentities(timeline);
    // Voce 826e377c review giro-7 (P2 head 3c77ca1): the count is exact
    // only on a complete read. An unavailable timeline (honest 404: the
    // package is not composed) names its state instead of zero channels;
    // a truncated page names itself partial instead of an exact total.
    if (merged.available !== true) {
      box.appendChild(el('p', 'bo-muted', 'I canali osservati non sono disponibili.'));
      return;
    }
    const count = merged.channelCount;
    box.appendChild(el('p', 'bo-muted',
      merged.rows.length === 0
        ? 'nessun canale osservato'
        : (merged.complete === true
          ? `${count} ${count === 1 ? 'canale' : 'canali'}`
          : `${count} ${count === 1 ? 'canale' : 'canali'} (elenco parziale)`)));
    for (const row of merged.rows) {
      const { system } = row;
      const line = el('p', 'bo-scheda-identity');
      line.setAttribute('data-channel', system);
      line.setAttribute('data-source', row.source);
      const known = Object.hasOwn(CARD_CHANNEL_MARKS, system);
      line.appendChild(el('span', `bo-scheda-chan bo-tile-${known ? system : 'other'}`, known ? CARD_CHANNEL_MARKS[system] : '·'));
      line.appendChild(el('span', undefined, row.externalId == null
        ? ` ${channelLabel(system)} · senza identificativo`
        : ` ${channelLabel(system)} · ${row.externalId}`));
      box.appendChild(line);
    }
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    box.appendChild(el('p', 'bo-muted',
      cluster.linked === true
        ? `${members.length} ${members.length === 1 ? 'scheda' : 'schede'} della stessa persona`
        : 'una sola scheda: nessuna unione registrata'));
    for (const member of members) {
      const line = el('p', 'bo-scheda-identity');
      line.setAttribute('data-member', `${member?.resource ?? ''}:${member?.id ?? ''}`);
      const role = roleLabel(member?.role);
      line.appendChild(el('strong', undefined,
        role ? `${resourceLabel(member?.resource)} · ${role}` : resourceLabel(member?.resource)));
      // BO-F1-06: the motivation the decider recorded, with who and when —
      // never a bare id the operator has to trust.
      if (typeof member?.reason === 'string' && member.reason !== '') {
        line.appendChild(el('span', undefined, ` — ${member.reason}`));
      } else {
        line.appendChild(el('span', 'bo-muted', ' — motivazione non registrata'));
      }
      const when = dateParts(member?.decidedAt);
      if (isHumanHandle(member?.decidedBy?.id) || when) {
        const who = isHumanHandle(member?.decidedBy?.id) ? `da ${String(member.decidedBy.id).trim()}` : 'da un operatore';
        line.appendChild(el('span', 'bo-muted', ` (${when ? `${who} il ${when}` : who})`));
      }
      box.appendChild(line);
    }
    // Voce 59def6cb805d (C11): the prototype's violet note under the
    // identities — the union motivation the decider recorded, never an
    // invented one. Voce d525f4aa48b2: the ✦ phrase reads exactly once —
    // distinct recorded reasons join into one note, never one note each.
    // With no linked union, or no recorded reason, no note is shown.
    if (cluster.linked === true) {
      const reasons = [...new Set(members
        .map((member) => (typeof member?.reason === 'string' ? member.reason.trim() : ''))
        .filter((reason) => reason !== ''))];
      if (reasons.length > 0) {
        box.appendChild(el('p', 'bo-scheda-union-note', `✦ ${reasons.join(' · ')}`));
      }
    }
  }

  /**
   * Voce 714433c2: in-place edit of Dettagli for contact subjects. The form
   * edits what the section shows (Nome, Cognome, Email); company records
   * have no update path yet, so a company scheda keeps no Modifica button
   * (remaining). Salva PATCHes the contact and re-reads the card; Annulla
   * drops the edits by re-reading too, so nothing stale stays on screen.
   */
  function details(box, card, profile, editCtx, profileError = null) {
    box.appendChild(el('h4', undefined, 'Dettagli'));
    // Voce 908f2eb9bbfb: the profile failing must not fail the scheda. The
    // facts below join the card with the profile, so without the profile
    // they cannot be shown — but the name (header, from the card) and the
    // timeline stay, and only Dettagli names the failure.
    if (profileError) {
      readError(box, profileError, 'I dettagli non si sono potuti leggere. Riprova più tardi.');
      return;
    }
    const fact = (label, value) => {
      const row = el('p', 'bo-scheda-fact');
      row.appendChild(el('span', 'bo-scheda-fact-label', label));
      row.appendChild(el('span', undefined, value));
      box.appendChild(row);
    };
    fact('Nome', card?.name ?? '—');
    if (card?.company?.name) fact('Azienda', card.company.name);
    fact('Email', card?.email ?? 'non disponibile');
    // Voce 1a066ddfe42a: plain Italian empty states; the English card reasons
    // stay in the API response, never on screen.
    fact('Telefono', card?.phone?.available === true && card.phone.value
      ? String(card.phone.value)
      : 'Nessun telefono collegato');
    fact('Stato', statusLabel(card?.status?.value));
    // Voce 1a066ddfe42a, P2 di review: «nessuna attività» è definitivo solo a
    // prove complete (le tre sezioni leggibili con conteggio esatto a zero),
    // altrimenti l'italiano resta onesto sulle verifiche mancanti.
    box.appendChild(el('p', 'bo-muted', statusMicrocopy(card, profile)));
    const active = card?.activePackage;
    const activeItems = active?.available === true && Array.isArray(active.active) ? active.active : null;
    if (activeItems && activeItems.length > 0) {
      for (const item of activeItems) {
        const itemStatus = packageStatusLabel(item?.status);
        const itemName = typeof item?.name === 'string' && item.name !== '' ? item.name : 'pacchetto';
        fact('Pacchetto', itemStatus ? `${itemName} (${itemStatus})` : itemName);
      }
    } else if (active?.available === true && active.truncated !== true && active.countIsComplete !== false) {
      // A complete readable page with no active row: honestly none.
      // Anything else (not composed, truncated, a floor count) hides the line
      // instead of printing the English reason or a false "none".
      box.appendChild(el('p', 'bo-muted', 'Nessun pacchetto attivo'));
    }
    // Voce 714433c2: Modifica opens the in-place form below. Company
    // records have no update path yet, so a company scheda shows no button.
    const contact = profile?.identity?.contact ?? null;
    if (editCtx && card?.subject?.resource === 'contact'
      && contact && typeof contact.id === 'string' && contact.id !== '') {
      const edit = el('button', undefined, 'Modifica');
      edit.setAttribute('type', 'button');
      edit.setAttribute('data-action', 'edit-details');
      // Dan 06/11: Annulla puts this card back as it was — no reload of the
      // whole scheda (it used to blank for seconds and jump to the top).
      const restore = () => {
        while (box.firstChild) box.removeChild(box.firstChild);
        details(box, card, profile, editCtx, profileError);
      };
      edit.addEventListener('click', () => renderDetailsForm(box, card, contact, editCtx, restore));
      box.appendChild(edit);
    }
    // Voce d525f4aa48b2: the main AI voice of the scheda, beside Modifica.
    // It opens the BO-F0-04 bar with this customer already in the context —
    // the panel then proposes «cambia telefono in …» and «aggiungi nota: …»,
    // and every write still passes its own confirmation, on the panel for
    // the assistant actions and on Salva/Invia for the scheda forms. Company
    // schede get it too: the context is the shown subject, not the edit path.
    if (editCtx && typeof editCtx.resource === 'string' && editCtx.resource !== ''
      && typeof editCtx.id === 'string' && editCtx.id !== '') {
      const ask = el('button', 'bo-scheda-ask-ai', "✦ Chiedi all'AI");
      ask.setAttribute('type', 'button');
      ask.setAttribute('data-action', 'ask-ai');
      ask.setAttribute('title', 'Chiedi all\u2019assistente con questo cliente nel contesto (⌘K)');
      ask.addEventListener('click', () => {
        const name = typeof card?.name === 'string' && card.name.trim() !== '' ? card.name.trim() : 'senza nome';
        const customer = { resource: editCtx.resource, id: editCtx.id };
        if (onAskAi) onAskAi('scheda-cliente', `Cliente ${name} (${editCtx.resource}/${editCtx.id})`, customer);
        else toast('Apri la barra AI (⌘K) e descrivi cosa vuoi fare per questo cliente.');
      });
      box.appendChild(ask);
    }
  }

  /**
   * Voce 714433c2: the Dettagli edit form. Salva PATCHes the contact and
   * re-reads the whole card (the same reload the section helpers use), so a
   * saved value is the server's value, never an optimistic copy. Annulla
   * drops the edits by re-reading too, so nothing stale stays on screen. A
   * refused save keeps the form with the server's Italian error, never a
   * blank card.
   */
  function renderDetailsForm(box, card, contact, editCtx, restore = null) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(el('h4', undefined, 'Dettagli'));
    const field = (label, name, value) => {
      const labelNode = el('label', 'bo-scheda-field-label', label);
      const input = el('input');
      input.setAttribute('name', name);
      input.value = value;
      input.setAttribute('aria-label', label);
      box.appendChild(labelNode);
      box.appendChild(input);
      return input;
    };
    const firstInput = field('Nome', 'firstName',
      typeof contact.firstName === 'string' ? contact.firstName : '');
    const lastInput = field('Cognome', 'lastName',
      typeof contact.lastName === 'string' ? contact.lastName : '');
    const emailInput = field('Email', 'email',
      typeof contact.email === 'string' ? contact.email : '');
    const error = el('small', 'field-error', '');
    const row = el('div', 'bo-scheda-form-actions');
    const save = el('button', undefined, 'Salva');
    save.setAttribute('type', 'button');
    save.setAttribute('data-action', 'save-details');
    const cancel = el('button', undefined, 'Annulla');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-action', 'cancel-details');
    row.appendChild(save);
    row.appendChild(cancel);
    box.appendChild(row);
    box.appendChild(error);
    let busy = false;
    save.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      error.textContent = '';
      try {
        await client.request(`/api/contacts/${encodeURIComponent(contact.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            firstName: firstInput.value,
            lastName: lastInput.value,
            email: emailInput.value,
          }),
        });
        toast('Dati salvati');
        await renderCard(editCtx.resource, editCtx.id);
      } catch (err) {
        error.textContent = humanReadError(err, { failed: 'Salvataggio non riuscito. Riprova più tardi.' });
        toast(humanReadError(err, { failed: 'Salvataggio non riuscito. Riprova più tardi.' }), true);
      } finally {
        busy = false;
      }
    });
    cancel.addEventListener('click', async () => {
      if (typeof restore === 'function') {
        restore();
        return;
      }
      await renderCard(editCtx.resource, editCtx.id);
    });
    void card;
  }

  /**
   * Campi personalizzati (backlog:434cc39a): every space-wide field with
   * this customer's value, editable in place, plus «+ Aggiungi campo». An
   * edit rewrites the single row and re-reads the whole card, so a reload
   * reads the edit. A failed read hides the section, never the scheda.
   * @param {any} box
   * @param {{defs: any, values: any, resource: string, id: string}} ctx
   */
  function customFields(box, ctx) {
    if (!Array.isArray(ctx?.defs)) return false;
    if (ctx.defs.length === 0 && !Array.isArray(ctx?.values)) return false;
    box.appendChild(el('h4', undefined, 'Campi personalizzati'));
    const byKey = new Map((Array.isArray(ctx.values) ? ctx.values : []).map((row) => [row?.key, row]));
    for (const def of ctx.defs) {
      const row = el('p', 'bo-scheda-fact');
      row.appendChild(el('span', 'bo-scheda-fact-label', def?.label ?? def?.key ?? 'campo'));
      const shown = formatCustomValue(def, byKey.get(def?.key)?.value ?? null);
      row.appendChild(el('span', undefined, shown ?? '—'));
      const edit = el('button', undefined, 'Modifica');
      edit.setAttribute('type', 'button');
      edit.setAttribute('data-action', `edit-field:${def?.key ?? ''}`);
      edit.addEventListener('click', () => renderFieldForm(box, ctx, def));
      row.appendChild(edit);
      box.appendChild(row);
    }
    const add = el('button', undefined, '+ Aggiungi campo');
    add.setAttribute('type', 'button');
    add.setAttribute('data-action', 'add-field');
    add.addEventListener('click', () => {
      if (box.querySelector?.('.bo-campo-add')) return;
      const form = addFieldForm(el, {
        onDefine: async (input) => {
          const created = await defineField(client, input);
          await renderCard(ctx.resource, ctx.id);
          toast('Campo creato: ora è in tutte le schede, nei filtri e nelle colonne.');
          return created;
        },
      });
      form.cancel.addEventListener('click', async () => {
        await renderCard(ctx.resource, ctx.id);
      });
      box.appendChild(form.wrap);
    });
    box.appendChild(add);
    return true;
  }

  /** In-place edit of one custom-field value: Salva rewrites the single row. */
  function renderFieldForm(box, ctx, def) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(el('h4', undefined, 'Campi personalizzati'));
    const rows = Array.isArray(ctx.values) ? ctx.values : [];
    const current = rows.find((row) => row?.key === def?.key)?.value ?? null;
    const entry = fieldControl(el, def, current);
    box.appendChild(entry.wrap);
    const row = el('div', 'bo-scheda-form-actions');
    const save = el('button', undefined, 'Salva');
    save.setAttribute('type', 'button');
    save.setAttribute('data-action', 'save-field-value');
    const cancel = el('button', undefined, 'Annulla');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-action', 'cancel-field-value');
    row.appendChild(save);
    row.appendChild(cancel);
    box.appendChild(row);
    let busy = false;
    save.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      entry.setError('');
      try {
        await saveFieldValue(client, {
          resource: ctx.resource, id: ctx.id, key: def?.key, value: entry.read(),
        });
        toast('Campo salvato');
        await renderCard(ctx.resource, ctx.id);
      } catch (err) {
        entry.setError(humanReadError(err, { failed: 'Salvataggio non riuscito. Riprova più tardi.' }));
        busy = false;
      }
    });
    cancel.addEventListener('click', async () => {
      await renderCard(ctx.resource, ctx.id);
    });
  }

  const ENRICHED_FIELD_LABELS = Object.freeze({
    firstName: 'Nome', lastName: 'Cognome', role: 'Ruolo', companyName: 'Azienda', phone: 'Telefono',
  });
  const ENRICHMENT_SOURCE_LABELS = Object.freeze({
    'google-contacts': 'Contatti Google', 'email-signature': 'firma email',
  });

  function enriched(box, enrichment, reload, enrichmentError = null) {
    // BO-F4-03, ref "05 Scheda cliente": every enriched datum cites the free
    // source that filled it and its observation date; an opted-out customer
    // reads as opted out, never as empty; no row without a recorded source
    // is ever shown. Values are text, never markup.
    // Voce 59def6cb805d (C13): the ghost `Aggiorna` button re-reads the
    // enrichment through the same operation the card load uses and reports
    // through the shell toast — `Dati aggiornati` when the re-read changed
    // the section, `Nessun dato nuovo` when it did not. A failed re-read is
    // the Italian retry sentence, and the section keeps its previous rows.
    box.appendChild(el('h4', undefined, "Arricchito dall'AI"));
    // Voce 908f2eb9bbfb: a failed enrichment read fails only this section,
    // never the scheda.
    if (enrichmentError) {
      readError(box, enrichmentError, "I dati arricchiti non si sono potuti leggere. Riprova più tardi.");
      return;
    }
    if (typeof reload === 'function') {
      const refresh = el('button', 'bo-scheda-refresh', 'Aggiorna');
      refresh.setAttribute('type', 'button');
      refresh.setAttribute('data-action', 'refresh-enrichment');
      let busy = false;
      refresh.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          const fresh = await reload();
          const before = JSON.stringify([enrichment?.optedOut ?? null, enrichment?.items ?? null]);
          const after = JSON.stringify([fresh?.optedOut ?? null, fresh?.items ?? null]);
          while (box.firstChild) box.removeChild(box.firstChild);
          enriched(box, fresh, reload);
          toast(before === after ? 'Nessun dato nuovo' : 'Dati aggiornati');
        } catch (error) {
          toast(humanReadError(error, { failed: 'Qualcosa non ha funzionato. Riprova tra poco.' }), true);
        } finally {
          busy = false;
        }
      });
      box.appendChild(refresh);
    }
    const items = Array.isArray(enrichment?.items) ? enrichment.items : null;
    if (items === null) {
      box.appendChild(el('p', 'bo-muted', 'I dati arricchiti non si sono potuti leggere per questo cliente'));
      return;
    }
    if (enrichment?.optedOut) {
      const when = dateParts(enrichment.optedOut.optedOutAt);
      box.appendChild(el('p', 'bo-muted',
        `arricchimento disattivato${when ? ` il ${when}` : ''} (opt-out): nessun nuovo dato verrà salvato`));
    }
    if (items.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'Nessun dato arricchito ancora'));
      return;
    }
    for (const item of items) {
      const label = ownLabel(ENRICHED_FIELD_LABELS, String(item?.field ?? '')) ?? String(item?.field ?? 'dato');
      const source = ownLabel(ENRICHMENT_SOURCE_LABELS, String(item?.source ?? '')) ?? String(item?.source ?? 'fonte non registrata');
      const when = dateParts(item?.observedAt);
      box.appendChild(el('p', 'bo-scheda-enriched',
        `${label}: ${String(item?.value ?? '—')} (fonte: ${source}${when ? ` · ${when}` : ''})`));
    }
  }

  function timelineBox(box, timeline, noteCtx) {
    // Voce 59def6cb805d (C14): the prototype names this section, not the
    // record kind behind it.
    box.appendChild(el('h4', undefined, 'Tutti i contatti'));
    const entries = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : [];
    const channels = [...new Set(entries.map((item) => String(item?.channel ?? '')).filter((channel) => channel !== ''))];
    // Dan 06/11: the notes get their own chip — «Note · N» — and, once
    // there, one chip per writer («da dan», «dal team»).
    const notes = entries.filter((item) => item?.entry === 'note');
    const noteAuthor = (item) => (isHumanHandle(item?.teamAuthorId) ? String(item.teamAuthorId).trim() : '');
    const authors = [...new Set(notes.map(noteAuthor))];
    const chips = el('p', 'bo-scheda-chips');
    const chip = (label, key, active, onPick) => {
      const node = el('button', undefined, label);
      node.setAttribute('type', 'button');
      node.setAttribute('data-channel', key);
      if (active) node.setAttribute('data-active', 'true');
      node.addEventListener('click', onPick);
      return node;
    };
    const drawChips = () => {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      const pick = (key) => () => {
        channelFilter = key;
        noteAuthorFilter = null;
        shownCount = TIMELINE_PAGE;
        drawChips();
        drawList();
      };
      for (const key of ['all', ...channels]) {
        chips.appendChild(chip(key === 'all' ? 'Tutti' : channelLabel(key), key, channelFilter === key, pick(key)));
      }
      if (notes.length > 0) {
        // Review #617: a cut cronologia may hold older notes past the page,
        // so the count reads as a floor («3+»), never an exact total.
        const partial = timeline?.entries?.truncated === true;
        const noteChip = chip(`Note · ${notes.length}${partial ? '+' : ''}`, 'note', channelFilter === 'note', pick('note'));
        noteChip.setAttribute('class', 'bo-scheda-chip-note');
        chips.appendChild(noteChip);
      }
      if (channelFilter === 'note' && authors.length > 1) {
        const byAuthor = el('span', 'bo-scheda-chips-authors');
        for (const author of authors) {
          const label = author === '' ? 'dal team' : `da ${author}`;
          const node = chip(label, `note:${author}`, noteAuthorFilter === author, () => {
            noteAuthorFilter = noteAuthorFilter === author ? null : author;
            shownCount = TIMELINE_PAGE;
            drawChips();
            drawList();
          });
          node.setAttribute('data-author', author === '' ? 'team' : author);
          byAuthor.appendChild(node);
        }
        chips.appendChild(byAuthor);
      }
    };
    let noteAuthorFilter = null;
    const list = el('div', 'bo-scheda-timeline');
    // Voce 32820692: the timeline entry carries the attachment reference
    // the host logged, and the card shows it — a thumbnail for photos, a
    // player for audio and video, an icon with the name for documents. A
    // captionless message still shows its attachment instead of an empty
    // bubble. Handles are server-validated (https without credentials, or
    // a provider media id fetched server-side); the card embeds same-shape
    // values only, never markup, and names stay text.
    const attachmentNode = (attachment) => {
      if (!attachment || typeof attachment !== 'object') return null;
      const kinds = ['photo', 'video', 'audio', 'document'];
      if (!kinds.includes(attachment.kind)) return null;
      const clean = (value) => (typeof value === 'string' && value !== ''
        && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null);
      const handle = clean(attachment.preview) ?? clean(attachment.ref);
      if (!handle) return null;
      if (attachment.kind === 'photo') {
        const img = el('img', 'bo-scheda-allegato');
        img.setAttribute('src', handle);
        img.setAttribute('alt', typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : 'foto allegata');
        return img;
      }
      if (attachment.kind === 'video' || attachment.kind === 'audio') {
        const player = el(attachment.kind, 'bo-scheda-allegato');
        player.setAttribute('src', handle);
        player.setAttribute('controls', '');
        return player;
      }
      const name = typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : 'Documento';
      return el('p', 'bo-scheda-allegato', `Documento: ${name}`);
    };
    const drawList = () => {
      while (list.firstChild) list.removeChild(list.firstChild);
      // Voce 714433c2: operator notes are channel-less, so they read under
      // `Tutti` only — a channel filter shows that channel's passages alone.
      // Dan 06/11: newest first, a page at a time — 42 e-mails used to make
      // a 5.600px page. «Mostra precedenti» opens the next page below.
      const filtered = entries.filter((item) => {
        if (channelFilter === 'all') return true;
        if (channelFilter === 'note') return item?.entry === 'note' && (noteAuthorFilter === null || noteAuthor(item) === noteAuthorFilter);
        return String(item?.channel ?? '') === channelFilter;
      });
      const ordered = [...filtered].sort((a, b) => (Date.parse(String(b?.occurredAt ?? '')) || 0) - (Date.parse(String(a?.occurredAt ?? '')) || 0));
      const visible = ordered.slice(0, shownCount);
      if (filtered.length === 0) {
        // Voce 59def6cb805d (C27): the exact empty state of the prototype,
        // never a technical sentence.
        if (channelFilter === 'note') {
          list.appendChild(el('p', 'bo-scheda-empty-title', 'Nessuna nota qui'));
          list.appendChild(el('p', 'bo-muted', 'Scrivi una nota qui sotto: resta nella cronologia del cliente.'));
          return;
        }
        list.appendChild(el('p', 'bo-scheda-empty-title', 'Nessun messaggio qui'));
        list.appendChild(el('p', 'bo-muted', 'Prova un altro canale oppure scrivi il primo messaggio qui sotto.'));
        return;
      }
      const todayKey = romeDayKey(Date.now());
      let currentDay = null;
      for (const item of visible) {
        // Voce 1a066ddfe42a: group and label by the readable Rome day.
        // Voce 59def6cb805d (C16): the day reads uppercase, like the
        // prototype (`LUNEDÌ 20 OTTOBRE 2026`), with the `OGGI · ` prefix on
        // the passages of today.
        const occurredMs = Date.parse(String(item?.occurredAt ?? ''));
        const dayKey = romeDayKey(occurredMs);
        const day = (dayParts(item?.occurredAt) ?? 'senza data').toUpperCase();
        const dayLabel = dayKey !== null && dayKey === todayKey ? `OGGI · ${day}` : day;
        if (dayLabel !== currentDay) {
          currentDay = dayLabel;
          list.appendChild(el('h5', 'bo-scheda-day', dayLabel));
        }
        const row = el('div', 'bo-scheda-entry');
        row.setAttribute('data-entry', String(item?.id ?? ''));
        if (item?.entry === 'note') {
          // Voce 714433c2: the operator note. No channel badge and no sync
          // line — it is a statement about the customer, not a passage.
          // The writer reads when the row names a human handle, like the
          // outbound passages above; markup in the body stays text.
          // Dan 06/11: «ho aggiunto una nota ma non si vede» — the note
          // reads as a note at a glance: its own mark and a paper tone.
          const when = timeParts(item?.occurredAt);
          const author = teamName(item?.teamAuthorId) !== null
            ? `da ${teamName(item.teamAuthorId)}` : 'dal team';
          row.setAttribute('class', 'bo-scheda-entry bo-scheda-entry-note');
          const mark = el('span', 'bo-scheda-chan bo-tile-note', '✎');
          mark.setAttribute('aria-hidden', 'true');
          row.appendChild(mark);
          const paper = el('div', 'bo-scheda-note-paper');
          paper.appendChild(el('p', 'bo-scheda-entry-head',
            when ? `Nota · ${author} · ${when}` : `Nota · ${author}`));
          if (typeof item?.body === 'string' && item.body !== '') {
            paper.appendChild(el('p', 'bo-scheda-note-body', readableText(item.body)));
          }
          row.appendChild(paper);
          list.appendChild(row);
          continue;
        }
        const channelKey = String(item?.channel ?? '').trim().toLowerCase();
        const known = Object.hasOwn(CARD_CHANNEL_MARKS, channelKey);
        const isOutbound = String(item?.direction ?? '') === 'outbound';
        // Dan 07/11: «inviato e ricevuto sarebbe più chiaro a destra e
        // sinistra, come una conversazione». Received passages sit on the
        // left, the team's on the right, each in its own bubble; the channel
        // badge stays on the outer edge so the filter chips still read.
        row.setAttribute('class', `bo-scheda-entry ${isOutbound ? 'bo-scheda-entry-out' : 'bo-scheda-entry-in'}`);
        row.setAttribute('data-direction', isOutbound ? 'out' : 'in');
        row.setAttribute('aria-label', isOutbound ? 'Inviato' : 'Ricevuto');
        row.appendChild(el('span', `bo-scheda-chan bo-tile-${known ? channelKey : 'other'}`, known ? CARD_CHANNEL_MARKS[channelKey] : '·'));
        const bubble = el('div', 'bo-scheda-bubble');
        // The side already says the direction: the head names channel,
        // person and hour once (it used to repeat the channel three times).
        const who = isOutbound
          ? (teamName(item?.teamAuthorId) ?? 'il team')
          : (typeof item?.remoteHandle === 'string' && item.remoteHandle.trim() !== '' ? item.remoteHandle.trim() : null);
        // Voce 59def6cb805d (C17): the day already heads the group, so the
        // card shows the hour only (`<hh:mm>`).
        const when = timeParts(item?.occurredAt);
        const entryHead = el('p', 'bo-scheda-entry-head');
        // «Da leggere»: an unread passage (unreadInboundAt, the same rule
        // mark-read uses) lights up with «Nuovo» for this visit. Without the
        // field nothing changes — the server may not serve read state yet.
        if (unreadInboundAt(item) !== null) {
          row.setAttribute('data-unread', 'true');
          entryHead.appendChild(el('span', 'bo-scheda-new', 'Nuovo'));
        }
        entryHead.appendChild(el('span', undefined, [channelLabel(item?.channel), who, when].filter(Boolean).join(' · ')));
        bubble.appendChild(entryHead);
        const outcome = typeof item?.sync === 'string' && item.sync !== '' ? syncLabel(item.sync) : null;
        if (item?.entry === 'call') {
          // Voce 59def6cb805d (C19): the duration reads `<m:ss>`; with no
          // audio URL in the data no player is rendered (never a dead one).
          const dur = durationParts(item?.durationSec);
          bubble.appendChild(el('p', 'bo-scheda-entry-body',
            [`chiamata ${isOutbound ? 'in uscita' : 'in entrata'}`, dur, outcome].filter(Boolean).join(' · ')));
        } else if (typeof item?.body === 'string' && item.body !== '') {
          const text = readableText(item.body);
          const bodyNode = el('p', 'bo-scheda-entry-body', text);
          bubble.appendChild(bodyNode);
          if (text.length > ENTRY_FOLD_CHARS) {
            bodyNode.setAttribute('data-folded', 'true');
            const more = el('button', 'bo-scheda-entry-more', 'Mostra tutto');
            more.setAttribute('type', 'button');
            more.setAttribute('data-action', 'entry-expand');
            more.addEventListener('click', () => {
              const folded = bodyNode.getAttribute('data-folded') === 'true';
              bodyNode.setAttribute('data-folded', folded ? 'false' : 'true');
              more.textContent = folded ? 'Mostra meno' : 'Mostra tutto';
            });
            bubble.appendChild(more);
          }
        }
        const attachment = attachmentNode(item?.attachment);
        if (attachment) bubble.appendChild(attachment);
        // The delivery state reads only where it says something: under the
        // team's messages (inviato, consegnato, letto, non consegnato) and
        // under a received one only when it is not the plain «ricevuto».
        const plainReceived = !isOutbound && String(item?.sync ?? '') === 'received';
        if (item?.entry !== 'call' && outcome && !plainReceived) {
          const state = el('p', 'bo-scheda-sync', outcome);
          state.setAttribute('data-sync', String(item.sync));
          bubble.appendChild(state);
        }
        row.appendChild(bubble);
        list.appendChild(row);
      }
      if (ordered.length > visible.length) {
        const rest = ordered.length - visible.length;
        const older = el('button', 'bo-scheda-older', `Mostra precedenti · ${Math.min(rest, TIMELINE_PAGE)} di ${rest}`);
        older.setAttribute('type', 'button');
        older.setAttribute('data-action', 'timeline-older');
        older.addEventListener('click', () => {
          shownCount += TIMELINE_PAGE;
          drawList();
        });
        list.appendChild(older);
      }
    };
    let shownCount = TIMELINE_PAGE;
    drawChips();
    box.appendChild(chips);
    drawList();
    box.appendChild(list);
    // Voce 714433c2: "Aggiungi nota" — the operator statement that reads
    // back in the cronologia above. Plain text only, like the work views; it
    // emails nobody and notifies nobody. A refused save keeps the text with
    // the server's Italian error, and a saved note re-reads the card so the
    // row is the server's row, never an optimistic copy.
    if (noteCtx && typeof noteCtx.resource === 'string' && typeof noteCtx.id === 'string') {
      const noteForm = el('div', 'bo-scheda-note-form');
      const noteInput = el('input');
      noteInput.setAttribute('name', 'noteBody');
      noteInput.setAttribute('aria-label', 'Nota da aggiungere alla cronologia del cliente');
      noteInput.setAttribute('placeholder', 'Scrivi una nota (massimo 1000 caratteri)');
      const noteButton = el('button', undefined, 'Aggiungi nota');
      noteButton.setAttribute('type', 'button');
      noteButton.setAttribute('data-action', 'add-note');
      const noteError = el('small', 'field-error', '');
      let noteBusy = false;
      noteButton.addEventListener('click', async () => {
        if (noteBusy) return;
        noteBusy = true;
        noteError.textContent = '';
        try {
          await client.request('/api/customer-hub/notes', {
            method: 'POST',
            body: JSON.stringify({ resource: noteCtx.resource, id: noteCtx.id, body: noteInput.value }),
          });
          toast('Nota aggiunta');
          await renderCard(noteCtx.resource, noteCtx.id);
        } catch (error) {
          noteError.textContent = humanReadError(error, { failed: 'Nota non salvata. Riprova più tardi.' });
          toast(humanReadError(error, { failed: 'Nota non salvata. Riprova più tardi.' }), true);
        } finally {
          noteBusy = false;
        }
      });
      noteForm.appendChild(noteInput);
      noteForm.appendChild(noteButton);
      noteForm.appendChild(noteError);
      noteForm.appendChild(el('p', 'bo-muted',
        'La nota resta qui, nella cronologia del cliente. Non viene inviata a nessuno.'));
      box.appendChild(noteForm);
    }
  }

  function nextSteps(box, profile, profileError = null) {
    // Voce 908f2eb9bbfb, review round 2: a failed profile read fails this
    // section too, instead of vanishing as "no next steps".
    if (profileError) {
      box.appendChild(el('h4', undefined, 'Prossimi passi'));
      readError(box, profileError, 'I prossimi passi non si sono potuti leggere. Riprova più tardi.');
      return true;
    }
    // Voce 1a066ddfe42a: an uncomposed work package hides the whole block
    // instead of printing its English reason.
    if (profile?.workTasks?.available !== true) return false;
    box.appendChild(el('h4', undefined, 'Prossimi passi'));
    const items = Array.isArray(profile.workTasks.items) ? profile.workTasks.items : [];
    const tasks = items.filter((item) => item?.status !== 'done' && item?.status !== 'completed');
    if (tasks.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun passo aperto'));
      return true;
    }
    for (const task of tasks.slice(0, 5)) {
      const name = typeof task?.name === 'string' && task.name !== '' ? task.name : 'attività';
      box.appendChild(el('p', 'bo-scheda-step', name));
    }
    return true;
  }

  function offer(box, profile, offerCtx, profileError = null) {
    // Voce 908f2eb9bbfb, review round 2: a failed profile read fails this
    // section too, instead of vanishing as "no offer".
    if (profileError) {
      box.appendChild(el('h4', undefined, 'Offerta'));
      readError(box, profileError, "L'offerta non si è potuta leggere. Riprova più tardi.");
      return true;
    }
    // Voce cc525cd6a3c5: the offer panel shows one commercial line for THIS
    // customer only — the profile behind it is already scoped to the customer
    // (contact-scoped records never leak onto a company-mate's card), so the
    // first row here is this customer's own. A quote carries no human name of
    // its own, so it reads after the opportunity it was made for; the state
    // reads in Italian, never a raw English status or a bare record id.
    // Voce 1a066ddfe42a: uncomposed offer packages hide the whole block;
    // a composed-but-empty one reads «Nessuna offerta firmata».
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : null;
    const opportunities = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : null;
    if (quotes === null && opportunities === null) return false;
    box.appendChild(el('h4', undefined, 'Offerta'));
    const fromQuote = (quotes ?? []).length > 0;
    const first = fromQuote ? quotes[0] : ((opportunities ?? [])[0] ?? null);
    if (!first) {
      // No linked offer: only when BOTH commercial sections were readable
      // (even empty) the customer plainly has none. An empty opportunities
      // read never proves there are no quotes when the quotes read itself
      // failed — the unavailable reason reads instead, never a confirmed
      // absence.
      if (quotes !== null && opportunities !== null) {
        box.appendChild(el('p', 'bo-muted', 'Nessuna offerta firmata'));
        return true;
      }
      // The unavailable reason stays in the API response and the logs, never
      // on screen: production reasons are English system phrases, and the
      // scheda reads only fixed Italian (voce 1a066ddf).
      box.appendChild(el('p', 'bo-muted', 'offerte non disponibili'));
      return true;
    }
    const rawName = fromQuote ? (first?.opportunityName ?? first?.name) : first?.name;
    const name = typeof rawName === 'string' && rawName !== '' ? rawName : 'offerta';
    const offerStatus = offerStatusLabel(first?.status);
    // Name and state read as one line for assistive tech and tests («nome · stato»); on screen the state is the prototype's pill.
    const line = el('p', 'bo-scheda-offer');
    line.appendChild(el('span', 'bo-scheda-offer-name', name));
    if (offerStatus) {
      line.appendChild(el('span', 'bo-scheda-sep', ' · '));
      line.appendChild(el('span', 'bo-scheda-offer-state', offerStatus));
    }
    // Voce cf340b571e98: a quote row opens its detail (righe, totale, stato,
    // storia) — the line is a link to #/quotes/<id>. An opportunity without
    // a quote has no detail screen, so its fallback line stays plain text.
    const quoteId = fromQuote && typeof first?.id === 'string' && first.id !== '' ? first.id : null;
    if (quoteId === null) {
      box.appendChild(line);
    } else {
      const link = el('a', 'bo-scheda-offer-link');
      link.setAttribute('href', `#/quotes/${encodeURIComponent(quoteId)}`);
      link.appendChild(line);
      box.appendChild(link);
    }
    // Voce 714433c2: «Cambia stato» — the stato shown above changes from a
    // menu. The menu moves the shown opportunity through the governed
    // `request-opportunity-stage-change` workflow (POST
    // /api/opportunities/:id/stage), never a direct write: a renewal moving
    // to proposal past the approval threshold lands in «in attesa di
    // approvazione» with a toast saying so, like the pipeline board. The
    // menu acts on exactly the stato the line shows: when the line reads a
    // quote (no governed stage transition exists for quotes), there is no
    // menu — the quote's state changes from the quotes screen. A refused
    // move keeps the menu with the server's Italian error, and a completed
    // move re-reads the card so the line is the server's state, never an
    // optimistic copy. The header Cliente/Contatto pill stays derived (see
    // customer-status.js): this menu does not touch it.
    const shownOpportunity = fromQuote ? null : first;
    if (shownOpportunity && typeof shownOpportunity.id === 'string' && shownOpportunity.id !== ''
      && offerCtx && typeof offerCtx.resource === 'string' && typeof offerCtx.id === 'string') {
      const current = String(shownOpportunity.status ?? '').toLowerCase();
      const targets = offerStageTargets(current);
      if (targets.length > 0) {
        const wrap = el('div', 'bo-scheda-stage-menu');
        const button = el('button', undefined, 'Cambia stato');
        button.setAttribute('type', 'button');
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('data-action', 'change-offer-stage');
        const menu = el('div', 'bo-scheda-stage-voices hidden');
        menu.setAttribute('role', 'menu');
        const isClosed = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
        const syncMenu = () => {
          button.setAttribute('aria-expanded', isClosed() ? 'false' : 'true');
        };
        const close = () => {
          if (!isClosed()) menu.setAttribute('class', 'bo-scheda-stage-voices hidden');
          syncMenu();
        };
        button.addEventListener('click', () => {
          menu.setAttribute('class', isClosed() ? 'bo-scheda-stage-voices' : 'bo-scheda-stage-voices hidden');
          syncMenu();
        });
        button.addEventListener('keydown', (event) => { if (event?.key === 'Escape') close(); });
        menu.addEventListener('keydown', (event) => { if (event?.key === 'Escape') close(); });
        const stageError = el('small', 'field-error', '');
        let stageBusy = false;
        for (const stage of targets) {
          const voice = el('button', undefined, offerStatusLabel(stage) ?? stage);
          voice.setAttribute('type', 'button');
          voice.setAttribute('role', 'menuitem');
          voice.setAttribute('data-stage', stage);
          voice.addEventListener('click', async () => {
            if (stageBusy) return;
            stageBusy = true;
            stageError.textContent = '';
            try {
              const result = await client.request(
                `/api/opportunities/${encodeURIComponent(shownOpportunity.id)}/stage`,
                { method: 'POST', body: JSON.stringify({ targetStage: stage }) },
              );
              close();
              // The stage route returns the workflow envelope
              // { runId, status, output }: the approval gate reads in
              // output.outcome, never in a top-level outcome.
              toast(result?.output?.outcome === 'approval_required'
                ? 'Stato aggiornato: serve un\u2019approvazione'
                : 'Stato aggiornato');
              await renderCard(offerCtx.resource, offerCtx.id);
            } catch (error) {
              stageError.textContent = humanReadError(error, { failed: 'Stato non aggiornato. Riprova più tardi.' });
              toast(humanReadError(error, { failed: 'Stato non aggiornato. Riprova più tardi.' }), true);
            } finally {
              stageBusy = false;
            }
          });
          menu.appendChild(voice);
        }
        wrap.appendChild(button);
        wrap.appendChild(menu);
        wrap.appendChild(stageError);
        box.appendChild(wrap);
      }
    }
    return true;
  }

  // Terminal booking states, mirroring APPOINTMENT_TERMINAL in
  // packages/appointments/src/appointments.js (this view ships as a static
  // file, so it names the set instead of importing it).
  const TERMINAL_APPOINTMENT = Object.freeze(['done', 'no-show', 'cancelled']);

  function nextAppointment(box, timeline, timelineError = null) {
    box.appendChild(el('h4', undefined, 'Prossimo appuntamento'));
    // Voce 908f2eb9bbfb, review round 2: a failed timeline read fails this
    // section too, instead of vanishing as "no appointment booked".
    if (timelineError) {
      readError(box, timelineError, 'Il prossimo appuntamento non si è potuto leggere. Riprova più tardi.');
      return;
    }
    const items = Array.isArray(timeline?.appointments?.items) ? timeline.appointments.items : [];
    // readSchedule lists every booking soonest-first, past and terminal rows
    // included: the next appointment is the soonest booking that can still
    // happen — a non-terminal row starting now or later.
    const nowMs = Date.now();
    const upcoming = items.filter((item) => {
      if (TERMINAL_APPOINTMENT.includes(String(item?.status ?? ''))) return false;
      const startsMs = Date.parse(String(item?.startsAt ?? ''));
      return Number.isFinite(startsMs) && startsMs >= nowMs;
    });
    if (upcoming.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun appuntamento prenotato'));
      return;
    }
    // Soonest slot first, like the timeline projection. Voce 1a066ddfe42a:
    // the slot reads as a plain Italian date — no ISO instants, no member id.
    const next = upcoming[0];
    const start = dateTimeParts(next?.startsAt);
    if (!start) {
      box.appendChild(el('p', 'bo-scheda-appt', 'data non disponibile'));
      return;
    }
    const endTime = timeParts(next?.endsAt);
    const sameDay = dateParts(next?.startsAt) === dateParts(next?.endsAt);
    const when = endTime && endTime !== timeParts(next?.startsAt)
      ? (sameDay ? `${start}–${endTime}` : `${start} – ${dateTimeParts(next?.endsAt)}`)
      : start;
    box.appendChild(el('p', 'bo-scheda-appt', when));
  }

  const SIGNAL_LABELS = Object.freeze({
    budget: 'Budget', timing: 'Tempi', interest: 'Interesse', doubt: 'Dubbi',
  });

  function latestSummarized(calls) {
    const items = Array.isArray(calls?.calls) ? calls.calls : [];
    return items.find((call) => typeof call?.summary === 'string' && call.summary !== '') ?? null;
  }

  function aiSummary(box, calls) {
    // BO-F1-08: the per-customer AI summary is the latest summarized call.
    // Without a recorded source it stays unavailable — never an invented one.
    // Voce 59def6cb805d (C23): the prototype's `<quando aggiornato>` row —
    // when the summarized call was recorded, never an invented freshness.
    box.appendChild(el('h4', undefined, '✦ Riepilogo AI'));
    const latest = latestSummarized(calls);
    if (!latest) {
      box.appendChild(el('p', 'bo-muted', 'Nessun riepilogo registrato per questo cliente'));
      return;
    }
    const updated = dateTimeParts(latest?.recordedAt);
    if (updated) box.appendChild(el('p', 'bo-scheda-summary-when', `Aggiornato ${updated}`));
    box.appendChild(el('p', 'bo-scheda-summary', latest.summary));
  }

  function callsBox(box, calls) {
    // BO-F1-08, ref "05 Scheda cliente": signals (budget/tempi/interesse/
    // dubbi) with their transcript source, and the openable transcript.
    box.appendChild(el('h4', undefined, 'Chiamate'));
    const items = Array.isArray(calls?.calls) ? calls.calls : [];
    if (items.length === 0) {
      box.appendChild(el('p', 'bo-muted',
        calls === null || calls === undefined
          ? 'Nessun dato di chiamata registrato per questo cliente'
          : 'nessuna chiamata registrata per questo cliente'));
      return;
    }
    const [latest, ...older] = items;
    const when = dateParts(latest?.recordedAt);
    box.appendChild(el('p', 'bo-scheda-call-head',
      `ultima chiamata${latest?.channel ? ` · ${channelLabel(latest.channel)}` : ''}${when ? ` · ${when}` : ''}`));
    if (typeof latest?.summary === 'string' && latest.summary !== '') {
      box.appendChild(el('p', 'bo-scheda-summary', latest.summary));
    }
    const signals = Array.isArray(latest?.signals) ? latest.signals : [];
    if (signals.length > 0) {
      const list = el('ul', 'bo-scheda-signals');
      for (const signal of signals) {
        const label = ownLabel(SIGNAL_LABELS, String(signal?.type ?? '')) ?? String(signal?.type ?? 'segnale');
        // A purged transcript keeps its signal rows without the quoted words:
        // the label stays as proof of what was found, never an empty quote.
        const line = typeof signal?.excerpt === 'string' && signal.excerpt !== ''
          ? el('li', undefined, `${label}: “${signal.excerpt}”`)
          : el('li', undefined, `${label} (citazione cancellata: retention scaduta)`);
        list.appendChild(line);
      }
      box.appendChild(list);
    } else {
      box.appendChild(el('p', 'bo-muted', 'nessun segnale registrato per questa chiamata'));
    }
    const transcript = latest?.transcript;
    if (transcript?.available === true) {
      // Voce 59def6cb805d (C20): the prototype's toggle with its exact
      // texts — one speaker row per transcript line. The rows mount only
      // while open, so a closed transcript shows nothing of its content.
      const toggle = el('button', 'bo-scheda-transcript-toggle', 'Mostra trascrizione');
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-expanded', 'false');
      const body = el('div', 'bo-scheda-transcript');
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? 'Nascondi trascrizione' : 'Mostra trascrizione';
        while (body.firstChild) body.removeChild(body.firstChild);
        if (open) {
          for (const line of String(transcript.text ?? '').split('\n')) {
            if (line.trim() === '') continue;
            body.appendChild(el('p', 'bo-scheda-transcript-row', line));
          }
        }
      });
      box.appendChild(toggle);
      box.appendChild(body);
    } else {
      box.appendChild(el('p', 'bo-muted',
        typeof transcript?.reason === 'string' && transcript.reason !== ''
          ? `trascrizione ${transcript.reason}`
          : 'trascrizione non disponibile per questa chiamata'));
    }
    if (older.length > 0) {
      box.appendChild(el('p', 'bo-muted', `+ ${older.length} chiamate precedenti`));
    }
  }

  // Voce 908f2eb9bbfb: a section that fails shows its own error and leaves
  // the rest of the scheda. Only the card read failing fails the whole
  // scheda — it carries the name, and without a name there is no card.
  const readError = (box, error, failed) => {
    box.appendChild(el('p', 'field-error', humanReadError(error, { failed })));
  };

  async function renderCard(resource, id) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    channelFilter = 'all';
    // Voce 908f2eb9bbfb, review round 2: the load itself must never throw
    // out of here — a synchronous throw (a throwing spaceId thunk, a hostile
    // id) used to blank the scheda with neither the card nor the error panel.
    let loaded;
    try {
      loaded = await load(resource, id);
    } catch (error) {
      loaded = { card: null, cardError: error };
    }
    if (loaded.cardError) {
      const panel = el('div', 'bo-scheda-error');
      panel.appendChild(el('h3', undefined, 'Scheda non disponibile'));
      panel.appendChild(el('p', 'bo-muted', humanReadError(loaded.cardError, {
        failed: 'La scheda non si è potuta leggere. Riprova più tardi.',
      })));
      mount.appendChild(panel);
      return;
    }
    const {
      card, timeline, timelineError, profile, profileError,
      enrichment, enrichmentError, calls, callsError,
      fieldDefs, fieldDefsError, fieldValues, fieldValuesError,
    } = loaded;
    // C13: the re-read behind `Aggiorna` — the same enriched route the load
    // uses, with the same honest 404. Anything else still rejects, so the
    // button toasts the Italian retry instead of inventing rows.
    const enrichedPath = `/api/customer-data/enriched/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const reloadEnrichment = () => client.request(enrichedPath).catch((error) => {
      if (error && error.status === 404) return null;
      throw error;
    });
    const panel = el('div', 'bo-scheda');
    header(panel, card, resource, id);
    const grid = el('div', 'bo-scheda-grid');
    // Dan 06/11: the side columns stay put while the conversation scrolls.
    const left = el('div', 'bo-scheda-col bo-scheda-col-side');
    const center = el('div', 'bo-scheda-col bo-scheda-col-main');
    const right = el('div', 'bo-scheda-col bo-scheda-col-side');
    // Supervisor design pass: every section is its own card, like the
    // prototype; a section that hides itself (returns false) leaves no card.
    const section = (col, cls, fn, ...args) => {
      const box = el('section', `bo-scheda-card${cls ? ` ${cls}` : ''}`);
      const shown = fn(box, ...args);
      if (shown !== false && box.childNodes.length > 0) col.appendChild(box);
    };
    section(left, '', quickActions, card, { resource, id });
    section(left, '', linkedIdentities, profile, timeline, profileError, timelineError);
    section(left, '', details, card, profile, { resource, id }, profileError);
    // Custom fields (backlog:434cc39a): a failed defs/values read hides the
    // section, never the scheda — like enrichment above.
    if (!fieldDefsError && !fieldValuesError) {
      section(left, '', customFields, { defs: fieldDefs, values: fieldValues, resource, id });
    }
    section(left, '', enriched, enrichment, reloadEnrichment, enrichmentError);
    if (timelineError) {
      section(center, 'bo-scheda-card-timeline', (box) => {
        box.appendChild(el('h4', undefined, 'Tutti i contatti'));
        readError(box, timelineError, 'La cronologia non si è potuta leggere. Riprova più tardi.');
      });
    } else {
      section(center, 'bo-scheda-card-timeline', timelineBox, timeline, { resource, id });
    }
    if (callsError) {
      section(right, 'bo-scheda-ai', (box) => {
        box.appendChild(el('h4', undefined, '✦ Riepilogo AI'));
        readError(box, callsError, 'Il riepilogo non si è potuto leggere. Riprova più tardi.');
      });
      section(right, '', (box) => {
        box.appendChild(el('h4', undefined, 'Chiamate'));
        readError(box, callsError, 'Le chiamate non si sono potute leggere. Riprova più tardi.');
      });
    } else {
      section(right, 'bo-scheda-ai', aiSummary, calls);
      section(right, '', callsBox, calls);
    }
    section(right, '', nextSteps, profile, profileError);
    section(right, 'bo-scheda-card-offer', offer, profile, { resource, id }, profileError);
    section(right, 'bo-scheda-card-appt', nextAppointment, timeline, timelineError);
    grid.appendChild(left);
    grid.appendChild(center);
    grid.appendChild(right);
    panel.appendChild(grid);
    mount.appendChild(panel);
    markRead(resource, id, timeline);
  }

  /**
   * «Da leggere»: opening the scheda marks its inbound messages read, up to
   * the newest unread one. The highlights stay for this visit — the operator
   * still sees what was new — and the list loses the badge on its next read.
   * Without read state (no `read: false` anywhere) or without a space nothing
   * is sent; a refused mark is silent, the badge simply stays.
   */
  function markRead(resource, id, timeline) {
    const items = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : [];
    let upTo = null;
    let upToMs = -Infinity;
    for (const item of items) {
      const ms = unreadInboundAt(item);
      if (ms !== null && ms > upToMs) {
        upToMs = ms;
        upTo = String(item.occurredAt);
      }
    }
    if (upTo === null) return;
    let spaceId = null;
    try {
      spaceId = activeSpaceId();
    } catch {
      return;
    }
    if (spaceId === null) return;
    Promise.resolve()
      .then(() => client.request('/api/customer-hub/mark-read', {
        method: 'POST',
        body: JSON.stringify({ spaceId, resource, id, upTo }),
      }))
      .catch(() => {});
  }

  return { renderCard };
}
