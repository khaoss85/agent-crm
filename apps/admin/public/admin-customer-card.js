// @ts-check

import { elFor, uiBusy, uiIcon, uiSkeleton } from './admin-ui.js'; // BO-F6-02: the single component library.
import { apiErrorToFormErrors, customerInitials, formatAmount, humanReadError, humanWriteError, isNotComposedFailure, pendingRequestId, readBackPending } from './admin-core.js';
import { channelState, countedChannel } from './admin-channels-count.js';
import { matchConnections } from './admin-connectors.js';
import { readProfile } from './admin-profilo.js';
import { bindAdminMutations } from './admin-submission.js';
import { SYNC_LABELS, auditActorLabel, isTechnicalMemberText, italianDateTime, offerStageLabel, offerStateLabel, personOf, plural, readableName, stageMoveLabels, stageMoveOf, teamPeople } from './admin-labels.js';
import { openOfferPanel } from './admin-offer-panel.js';
import { openAppointmentPanel } from './admin-appointment-panel.js';
import { knownNumbers, openCallNumberPanel } from './admin-call-number.js';
import { cleanMessageBody, cleanPreviewText, decodeHtmlEntities, isPlaceholderBody, messagePreview } from './admin-message-preview.js';
import { createStageConfirm, readStageConfirm, showStageConfirm, stageNeedsConfirm } from './admin-pipeline.js';
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

// Delivery/sync state words: shared with the assistant panel (admin-labels.js).

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

/** «10 nov»: the short Rome day, no year (backlog:5346ab531538). */
const shortDayParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'short',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms)).replace(/\./g, '');
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
  // A provider id or the broker's reserved mailbox is no name (production
  // 10/11: `broker+…@accordo.invalid` read «Broker»), shared filter.
  if (!isHumanHandle(value) || isTechnicalMemberText(value)) return null;
  const text = String(value).trim();
  const isEmail = text.includes('@');
  // An e-mail never shows its domain: the local part, without a `+tag`.
  const local = isEmail ? text.slice(0, text.indexOf('@')).split('+')[0] : text;
  if (!/^[a-zà-ÿ]+([._-][a-zà-ÿ]+)*$/i.test(local)) return isEmail ? (local === '' ? null : local) : text;
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
 * Voce ebde30a307f2: when the space composes none of the order,
 * commercial-contract and subscription modules, every evidence section reads
 * «not composed» (or the whole profile is a 404 null) — the line is hidden
 * instead of printing a false «non leggibili adesso», which would read as a
 * fault. A read failure on composed modules keeps the temporary hedge.
 */
const EVIDENCE_KEYS = Object.freeze(['orders', 'contracts', 'subscriptions']);
const isNotComposedSection = (section) => section?.available === false
  && typeof section?.reason === 'string'
  && /not composed/i.test(section.reason);
const statusMicrocopy = (card, profile) => {
  if (String(card?.status?.value ?? '').toLowerCase() === 'cliente') return 'Attività firmata collegata';
  if (profile == null) return null;
  if (EVIDENCE_KEYS.every((key) => profile?.[key] == null || isNotComposedSection(profile[key]))) return null;
  const proven = EVIDENCE_KEYS.every((key) => profile?.[key]?.available === true
    && (profile[key]?.count ?? 0) === 0
    && profile[key]?.countIsComplete !== false);
  return proven
    ? 'Nessuna attività firmata collegata'
    : 'Ordini e contratti non leggibili adesso';
};

// Backlog a551982c06eb: the commercial states share one map with the
// Pipeline board and the offer detail (admin-labels.js).
const offerStatusLabel = offerStateLabel;

// Voce 714433c2: the opportunity stages the «Cambia stato» menu offers.
// Mirrors ALLOWED_TRANSITIONS in
// packages/modules/opportunity/src/opportunity-service.js (this view ships
// as a static file, so it names the table instead of importing it, like
// TERMINAL_APPOINTMENT below). A test pins this mirror to the governed
// table, so a workflow change that the menu ignores fails loudly. Every key
// has an Italian voice in OFFER_STATE_LABELS (admin-labels.js), so the menu never
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

/**
 * Backlog a551982c06eb: the state the scheda offer line shows. An
 * opportunity reads its own stage; a quote reads the stage of the
 * opportunity it was made for — from the profile's join on the quote item,
 * else the opportunity row of the same profile — and only a quote with no
 * readable opportunity falls back to its own status.
 * @param {any} first the shown row (quote or opportunity)
 * @param {boolean} fromQuote
 * @param {Array<any> | null} opportunities the profile's opportunity rows
 * @param {unknown} pipelines `/api/schema` pipelines
 * @returns {string | null}
 */
export function shownOfferState(first, fromQuote, opportunities, pipelines) {
  if (!first || typeof first !== 'object') return null;
  if (!fromQuote) {
    return offerStageLabel(pipelines, {
      pipelineKey: first.pipelineKey, pipelineStage: first.pipelineStage, stage: first.stage ?? first.status,
    });
  }
  const joined = first.opportunityStage != null || first.opportunityPipelineStage != null
    ? { pipelineKey: first.opportunityPipelineKey, pipelineStage: first.opportunityPipelineStage, stage: first.opportunityStage }
    : null;
  const row = joined === null && typeof first.opportunityId === 'string' && Array.isArray(opportunities)
    ? opportunities.find((candidate) => candidate?.id === first.opportunityId) ?? null
    : null;
  const parent = joined ?? (row === null ? null : {
    pipelineKey: row.pipelineKey, pipelineStage: row.pipelineStage, stage: row.stage ?? row.status,
  });
  return (parent === null ? null : offerStageLabel(pipelines, parent)) ?? offerStateLabel(first.status);
}

/**
 * Backlog 1e939a362c7c: the «Cambia stato» menu of the scheda offer line,
 * for every offer — a quote line acts on the opportunity it was made for.
 * An offer placed on a composed pipeline moves through that pipeline's
 * stages, on the same `move-stage` action the Pipeline board posts (the
 * line shows the pipeline stage, so the menu moves exactly that). An offer
 * outside any pipeline keeps the governed core workflow
 * (`POST /api/opportunities/:id/stage`). Null when no opportunity is known,
 * or when it is placed on a pipeline this reader does not compose (never a
 * core move the line would not show).
 * @param {any} first the shown row (quote or opportunity)
 * @param {boolean} fromQuote
 * @param {Array<any> | null} opportunities the profile's opportunity rows
 * @param {unknown} pipelines `/api/schema` pipelines
 * @returns {{ id: string, kind: 'pipeline', pipeline: any, current: string, voices: Array<{ key: string, label: string, type: string }> }
 *   | { id: string, kind: 'core', current: string, voices: Array<{ key: string, label: string, type: string }> } | null}
 */
export function offerStageMenu(first, fromQuote, opportunities, pipelines) {
  if (!first || typeof first !== 'object') return null;
  const row = fromQuote && typeof first.opportunityId === 'string' && Array.isArray(opportunities)
    ? opportunities.find((candidate) => candidate?.id === first.opportunityId) ?? null
    : null;
  const id = fromQuote ? first.opportunityId : first.id;
  if (typeof id !== 'string' || id === '') return null;
  const pick = (joined, own) => (typeof joined === 'string' && joined !== '' ? joined : (typeof own === 'string' && own !== '' ? own : null));
  const pipelineKey = fromQuote ? pick(first.opportunityPipelineKey, row?.pipelineKey) : pick(first.pipelineKey, null);
  const pipelineStage = fromQuote ? pick(first.opportunityPipelineStage, row?.pipelineStage) : pick(first.pipelineStage, null);
  const coreStage = fromQuote ? pick(first.opportunityStage, row?.stage ?? row?.status) : pick(first.stage, first.status);
  if (pipelineKey !== null && pipelineStage !== null) {
    const pipeline = (Array.isArray(pipelines) ? pipelines : [])
      .find((candidate) => candidate?.name === pipelineKey && Array.isArray(candidate?.stages));
    if (!pipeline || typeof pipeline.module !== 'string' || pipeline.module === '') return null;
    // Review #683: a stage the pipeline no longer defines (drift, «Fuori
    // definizione» on the board) offers no move — the server would refuse
    // every one with 409 PIPELINE_STATE_CORRUPT, like the board knows.
    if (!pipeline.stages.some((stage) => stage?.key === pipelineStage)) return null;
    const voices = pipeline.stages
      .filter((stage) => typeof stage?.key === 'string' && stage.key !== pipelineStage)
      .map((stage) => ({
        key: stage.key,
        label: typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : stage.key,
        type: typeof stage.type === 'string' ? stage.type : 'open',
      }));
    return voices.length > 0 ? { id, kind: 'pipeline', pipeline, current: pipelineStage, voices } : null;
  }
  if (coreStage === null) return null;
  const current = coreStage.toLowerCase();
  const voices = offerStageTargets(current).map((stage) => ({
    key: stage, label: offerStateLabel(stage) ?? stage, type: 'core',
  }));
  return voices.length > 0 ? { id, kind: 'core', current, voices } : null;
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
 * Voce 97cba17cbb8c (VALIDAZIONE A4): un invio fallito resta visibile in
 * cronologia con il motivo e Riprova. La riga del server porta `sync:
 * 'failed'` e il codice inglese in `errorCode`: qui si legge solo italiano,
 * mai il codice grezzo da solo.
 */
export function failedSendReason(errorCode) {
  const code = String(errorCode ?? '').trim();
  if (code === 'CHANNEL_TEMPLATE_REQUIRED') return 'Fuori dalla finestra di 24 ore: serve un modello approvato.';
  if (code === 'CHANNEL_CONNECTION_NOT_ACTIVE' || code === 'CHANNEL_CONNECTION_UNKNOWN') return 'Il canale non è collegato: aprilo in Connettori e riprova.';
  if (code === 'CHANNEL_SECRET_UNAVAILABLE') return 'Il canale non può firmare l’invio: ricontrolla il collegamento e riprova.';
  if (code !== '') return `Motivo: ${code}.`;
  return 'Non sappiamo perché: controlla il collegamento e riprova.';
}

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
/**
 * The counted channel (admin-channels-count.js) of one identity system the
 * scheda reads: phone numbers are the Telefono channel, web forms the Form
 * sito, any mailbox is Email; the shared aliases cover the rest.
 * @param {string} system
 */
function cardCountedChannel(system) {
  const local = { phone: 'voice', tel: 'voice', mobile: 'voice', web: 'site-form', form: 'site-form', outlook: 'email' };
  return Object.hasOwn(local, system) ? local[system] : countedChannel(system);
}

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
 * Dan 11/11: the numbers «Chiama» can offer — the one held on the card,
 * the phone-bearing identities the profile holds beside the record, and the
 * phone handles observed on its passages — deduplicated on their dialable
 * form (admin-call-number.js `knownNumbers`).
 * @param {any} card @param {any} profile @param {any} timeline
 */
export function schedaNumbers(card, profile, timeline) {
  const held = card?.phone?.available === true && typeof card.phone.value === 'string' ? card.phone.value : null;
  const identities = Array.isArray(profile?.externalIdentities) ? profile.externalIdentities : [];
  const observed = mergeLinkedIdentities(timeline).rows.filter((row) => PHONE_LIKE_SYSTEMS.includes(row.system));
  return knownNumbers({ held, identities, observed });
}

/**
 * Voce 59def6cb805d (C10): the directions observed per channel on the
 * customer's passages — `{in, out}` by lowercase system. Evidence only: a
 * direction nobody recorded is never assumed.
 * @param {any} timeline the read-customer-timeline answer
 * @returns {Map<string, {in: boolean, out: boolean}>}
 */
export function observedDirections(timeline) {
  /** @type {Map<string, {in: boolean, out: boolean}>} */
  const seen = new Map();
  const entries = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : [];
  for (const entry of entries) {
    const system = String(entry?.channel ?? '').toLowerCase();
    if (system === '') continue;
    const direction = String(entry?.direction ?? '');
    if (direction !== 'inbound' && direction !== 'outbound') continue;
    const current = seen.get(system) ?? { in: false, out: false };
    if (direction === 'inbound') current.in = true;
    else current.out = true;
    seen.set(system, current);
  }
  return seen;
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
/** What a passage reads when neither its text nor its subject says anything. */
export const PASSAGE_NO_TEXT = '(nessun testo)';

/**
 * The line a passage shows in the cronologia, like Gmail (Dan 10/11):
 * «Oggetto — testo pulito» through the shared preview cleaning, bounded like
 * every other preview; the clean text alone without a subject (WhatsApp,
 * forms); the subject when the text cleans to nothing. '' when neither says
 * anything — the caller writes PASSAGE_NO_TEXT unless an attachment speaks.
 * @param {{ body?: unknown, subject?: unknown }} item
 */
export function passagePreview(item) {
  return messagePreview(typeof item?.body === 'string' ? item.body : null, { subject: item?.subject });
}

/**
 * The whole passage behind «Mostra tutto»: the full body as written, losing
 * only markup residue (always clean); '' for a body that is only a stand-in
 * («Please view this email in an HTML-capable email client»). A body that is
 * only a link keeps it here: the line shows the host, «Mostra tutto» the URL.
 * @param {{ body?: unknown }} item
 */
export function passageFullText(item) {
  const body = typeof item?.body === 'string' ? item.body : '';
  if (body === '' || (isPlaceholderBody(body) && !/(?:https?:\/\/|www\.)\S/i.test(body))) return '';
  return readableText(cleanMessageBody(body));
}

/**
 * One passage per real message (Dan 10/11): the same mail synced several
 * times — same channel, direction, sender, subject, text and minute — reads
 * once in the cronologia. Notes, calls and attachments are never folded; the first copy
 * in the list wins.
 * @param {Array<any>} entries
 */
export function collapseDuplicatePassages(entries) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    // An attachment is its own passage: two photos in one minute are two.
    const hasAttachment = item?.attachment != null && typeof item.attachment === 'object';
    if (item?.entry !== 'message' || hasAttachment) { out.push(item); continue; }
    const at = Date.parse(String(item?.occurredAt ?? ''));
    const minute = Number.isFinite(at) ? Math.floor(at / 60000) : null;
    const key = minute === null ? null : JSON.stringify([
      String(item?.channel ?? ''), String(item?.direction ?? ''), String(item?.remoteHandle ?? ''),
      cleanPreviewText(item?.subject), passageFullText(item) || passagePreview(item), minute,
    ]);
    if (key !== null && seen.has(key)) continue;
    if (key !== null) seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Message text as a person reads it: HTML entities the mail provider left in
 * the snippet are decoded (as text — nothing is ever parsed as markup), the
 * invisible preheader padding (U+034F, zero-widths, BOM, soft hyphen) is
 * dropped and runs of blanks collapse. The stored value stays untouched.
 * @param {string} value
 */
export function readableText(value) {
  // The shared decoder (Dan 12/11): «&zwnj;», «&lrm;» and the other
  // padding entities decode, then every format character goes.
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/[\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u00ad]/g, '')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** «Aggiungi telefono»: the Italian reason for each refusal the server names. */
const PHONE_REFUSALS = Object.freeze({
  400: 'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567',
  404: 'Il cliente non è più in questo spazio: ricarica la scheda',
  409: 'Questo numero è già collegato a un altro cliente',
});
const PHONE_SAVE_FAILED = 'Numero non salvato. Riprova più tardi.';
/** The /bo edge's generic refusal: Italian, but it says nothing the operator can act on. */
const GENERIC_PANEL_REFUSAL = 'Scrittura del pannello rifiutata';

/**
 * Whether a server message is an Italian sentence the operator can read:
 * the /bo edge answers its refusals in Italian, the standalone framework
 * in English, and a code or path never reaches the screen.
 * @param {unknown} message
 */
function isItalianSentence(message) {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text === '' || text.length > 240 || text === GENERIC_PANEL_REFUSAL) return false;
  if (/[_/{}<>]|\b[A-Z]{2,}_[A-Z]/.test(text)) return false;
  return /[àèéìòù]|\b(il|lo|la|non|un|una|questo|questa|già|del|della|di|per|scrivilo|ricarica)\b/i.test(text);
}

/**
 * Production 07/11 (pilot #426): «Aggiungi telefono» always said «Numero
 * non salvato…». A 400 (bad format), 404 (customer gone) or 409 (number
 * held by another customer) now reads its own reason — the server's Italian
 * sentence when it sends one, else the same reason in our words; anything
 * else (unknown, 5xx, network) keeps the generic retry line.
 * @param {unknown} error the rejection from `client.request`
 */
export function phoneRefusalText(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const status = typeof record.status === 'number' ? record.status
    : (record.code === 'PHONE_ALREADY_HELD' ? 409 : null);
  const own = status === null ? undefined : PHONE_REFUSALS[/** @type {400|404|409} */ (status)];
  if (own === undefined) {
    return humanReadError(error, { failed: PHONE_SAVE_FAILED });
  }
  humanReadError(error, { failed: own });
  return isItalianSentence(record.message) ? String(record.message).trim() : own;
}

const DETAILS_SAVE_FAILED = 'Salvataggio non riuscito. Riprova più tardi.';
const EMAIL_TAKEN_REFUSAL = 'Questa email è già di un altro cliente';

/**
 * Voce 5e13c9ef: «Dettagli» Salva said «Salvataggio non riuscito…» even for
 * a 409 the server already names (CONFLICT, email taken by another customer:
 * contact-service EMAIL_TAKEN_MESSAGE). A 409 now reads its own reason —
 * the server's Italian sentence when it sends one, else the same reason in
 * our words; anything else (other 4xx, 5xx, network) keeps the generic retry
 * line through humanReadError, exactly as before.
 * @param {unknown} error the rejection from `client.request`
 */
export function detailsRefusalText(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const status = typeof record.status === 'number' ? record.status
    : (record.code === 'CONFLICT' ? 409 : null);
  if (status !== 409) {
    return humanReadError(error, { failed: DETAILS_SAVE_FAILED });
  }
  humanReadError(error, { failed: EMAIL_TAKEN_REFUSAL });
  return isItalianSentence(record.message) ? String(record.message).trim() : EMAIL_TAKEN_REFUSAL;
}

/**
 * The reserved company a contact typed without Azienda sits under
 * (customer-data `NO_COMPANY_NAME`, production 07/11): the core needs a
 * company behind every contact, the scheda shows none.
 */
export const NO_COMPANY_NAME = 'Senza azienda';

/** The company name the scheda shows, or null for none / the reserved one. @param {any} card */
export function shownCompanyName(card) {
  const name = typeof card?.company?.name === 'string' ? card.company.name.trim() : '';
  // Same normalization as customer-data `isNoCompany` (core normalizeCompanyName).
  const normalized = name.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase();
  if (name === '' || normalized === NO_COMPANY_NAME.toLowerCase()) return null;
  // A stored placeholder (`Unknown (assistenza@…)`) is no company either
  // (review #739 giro 3): the same rule as customer-data
  // `isPlaceholderCompanyName`, through the browser twin.
  if (readableName(name.replace(/\([^)]*\)/g, ' ')) === null) return null;
  return name;
}

/**
 * backlog:2a214b66fe12 — the write applied to what the scheda shows, so
 * the screen changes the moment the toast speaks. Each helper returns a new
 * `loaded` object and never touches the one it reads; the re-read of the
 * touched part replaces the copy with the server's answer right after.
 */

/** A just-saved note at the top of the cronologia. @param {any} loaded @param {any} saved @param {string} body */
export function withNote(loaded, saved, body) {
  const entries = loaded?.timeline?.entries;
  if (!entries || !Array.isArray(entries.items)) return loaded;
  const note = {
    entry: 'note',
    id: typeof saved?.id === 'string' && saved.id !== '' ? saved.id : `nota-${Date.now().toString(36)}`,
    conversationId: null,
    channel: null,
    direction: null,
    sync: null,
    body: typeof saved?.body === 'string' ? saved.body : body,
    teamAuthorId: typeof saved?.actorId === 'string' ? saved.actorId : null,
    remoteHandle: null,
    errorCode: null,
    occurredAt: typeof saved?.occurredAt === 'string' ? saved.occurredAt : new Date().toISOString(),
  };
  return { ...loaded, timeline: { ...loaded.timeline, entries: { ...entries, items: [note, ...entries.items] } } };
}

/** The saved Nome, Cognome and Email on the card, the header and Dettagli. @param {any} loaded @param {{firstName: string, lastName: string, email: string}} typed */
export function withContactDetails(loaded, typed) {
  const name = [typed.firstName, typed.lastName].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
  const email = String(typed.email ?? '').trim();
  const card = loaded?.card ? { ...loaded.card, ...(name !== '' ? { name } : {}), email: email === '' ? null : email } : loaded?.card;
  const contact = loaded?.profile?.identity?.contact;
  const profile = contact
    ? { ...loaded.profile, identity: { ...loaded.profile.identity, contact: { ...contact, ...typed } } }
    : loaded?.profile;
  return { ...loaded, card, profile };
}

/** A just-created offer first among the profile's offers. @param {any} loaded @param {any} created */
export function withOpportunity(loaded, created) {
  const opportunities = loaded?.profile?.opportunities;
  if (!created || typeof created !== 'object' || typeof created.id !== 'string'
    || !opportunities || !Array.isArray(opportunities.items)) return loaded;
  const items = [created, ...opportunities.items.filter((row) => row?.id !== created.id)];
  return { ...loaded, profile: { ...loaded.profile, opportunities: { ...opportunities, available: true, items } } };
}

/**
 * The moved stage on the offer and on the quotes made for it.
 * @param {any} loaded @param {string} opportunityId @param {'pipeline' | 'core'} kind @param {string} stage
 */
export function withOfferStage(loaded, opportunityId, kind, stage) {
  const profile = loaded?.profile;
  if (!profile) return loaded;
  const own = kind === 'pipeline' ? { pipelineStage: stage } : { stage };
  const joined = kind === 'pipeline' ? { opportunityPipelineStage: stage } : { opportunityStage: stage };
  const mapItems = (section, match, change) => (section && Array.isArray(section.items)
    ? { ...section, items: section.items.map((row) => (match(row) ? { ...row, ...change } : row)) }
    : section);
  return {
    ...loaded,
    profile: {
      ...profile,
      opportunities: mapItems(profile.opportunities, (row) => row?.id === opportunityId, own),
      quotes: mapItems(profile.quotes, (row) => row?.opportunityId === opportunityId
        && (row.opportunityStage != null || row.opportunityPipelineStage != null), joined),
    },
  };
}

/** The longest note the server keeps (work `bounds.noteBody`). */
const NOTE_MAX = 1000;
const NOTE_TOO_LONG = `La nota è troppo lunga: al massimo ${NOTE_MAX} caratteri.`;

/**
 * What a refused note says (backlog:82235e46e3e9 seguito, production
 * 12/11): a validation refusal names what to correct, never «Riprova più
 * tardi» — retrying the same text would be refused again. Anything else
 * keeps the write's own wording.
 * @param {unknown} error
 */
export function noteRefusalText(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const status = typeof record.status === 'number' ? record.status : null;
  if (code === 'VALIDATION_ERROR' || code === 'BO_CRM_BODY_REFUSED' || status === 400 || status === 422) {
    const said = String(record.message ?? '');
    if (/at most|between 1 and/i.test(said)) return NOTE_TOO_LONG;
    if (/control characters/i.test(said)) return 'La nota contiene caratteri non ammessi: riscrivila come testo semplice.';
    return `La nota non è stata accettata: scrivi un testo semplice, da 1 a ${NOTE_MAX} caratteri.`;
  }
  return humanWriteError(error, { failed: 'Nota non salvata. Riprova più tardi.' });
}

export function createCustomerCardView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  // Every write of the card (note, Dettagli, phone, call, message, stage)
  // goes through the submission controller like every other view
  // (bindAdminMutations, #567): the raw client refuses a mutation without a
  // submission-owned Idempotency-Key before any request leaves, so in
  // production «Aggiungi nota» answered «Nota non salvata» with no request
  // at all (04/11).
  const { client, submissions } = bindAdminMutations(deps.client, deps);
  /** Dettagli saves in flight, view-wide: one PATCH per contact at a time. */
  const detailsInFlight = new Set();
  // «Chiama» on a number just saved from the number window (Dan 11/11):
  // the call opens on the re-read card of that same customer, once.
  /** @type {{key: string, number: string} | null} */
  let pendingCallAfterSave = null;
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
  // Voce 2f2d22f2: the shell breadcrumb follows the shown customer. The hook
  // fires only when the shown name changes — the card name on a good read,
  // null when the card read fails — so a re-read of the same scheda does
  // not repaint the shell crumb. Without a shell hook nothing fires.
  const onCustomerTitle = typeof deps.onCustomerTitle === 'function' ? deps.onCustomerTitle : null;
  let lastTitle;
  let titleKnown = false;
  const resetTitle = () => {
    titleKnown = false;
    lastTitle = undefined;
  };
  const emitTitle = (name) => {
    const title = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    if (titleKnown && title === lastTitle) return;
    titleKnown = true;
    lastTitle = title;
    if (onCustomerTitle) onCustomerTitle(title);
  };
  const activeSpaceId = () => {
    const raw = typeof deps.spaceId === 'function' ? deps.spaceId() : deps.spaceId;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  };
  const el = elFor(doc); // BO-F6-02: shared element builder.
  // backlog:e381c48581fa: the space's channel state, read once per space
  // (GET /api/connectors plus GET /api/profile, the same pair Connettori
  // reads) and kept a minute, so «↔ sincronizzato» is claimed only for a
  // channel `channelState` calls collegato. Never one of the scheda's own
  // reads: the identities paint at once and the claim lands when known.
  /** @type {{ spaceId: string, at: number, promise: Promise<{ rows: Array<any>, profile: unknown, profileRead: boolean } | null> } | null} */
  let spaceChannelsRead = null;
  const readSpaceChannels = () => {
    const spaceId = activeSpaceId();
    if (spaceId === null) return Promise.resolve(null);
    if (spaceChannelsRead !== null && spaceChannelsRead.spaceId === spaceId
      && Date.now() - spaceChannelsRead.at < 60000) return spaceChannelsRead.promise;
    // A failed read is logged with its safe fields (name/code/status and
    // the space, never a message) and kept only as «unknown» (review #819
    // P2): an unread state never downgrades a line, it only claims nothing.
    const warn = (what, error) => {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`bo-scheda ${what} unreadable:`,
          error instanceof Error ? error.name : 'unknown',
          typeof error?.code === 'string' ? error.code : '',
          Number.isFinite(error?.status) ? error.status : '', `spaceId=${spaceId}`);
      }
    };
    const promise = Promise.all([
      readProfile(client, (_label, status) => warn('profile', { code: 'PROFILE_UNREADABLE', status })),
      client.request(`/api/connectors?spaceId=${encodeURIComponent(spaceId)}`)
        .then((sync) => (Array.isArray(sync?.connectors) ? sync.connectors : []), (error) => {
          warn('channels', error);
          return null;
        }),
    ]).then(([profile, rows]) => (rows === null ? null : { rows, profile, profileRead: profile !== null }));
    spaceChannelsRead = { spaceId, at: Date.now(), promise };
    return promise;
  };
  // Azioni rapide: the prototype's stroke icon above the label, drawn as a
  // real SVG element. A CSS data: mask is blocked by the host CSP
  // (default-src 'self'), so the icons of #627 never painted in production.
  const tile = (label, icon) => {
    const node = el('button', 'bo-scheda-tile');
    node.appendChild(uiIcon(doc, icon));
    node.appendChild(el('span', undefined, label));
    return node;
  };
  const link = (href, text, action) => {
    const node = el('a', undefined, text);
    node.setAttribute('href', href);
    if (action) node.setAttribute('data-action', action);
    return node;
  };

  let channelFilter = 'all';
  // The note writer picked under «Note» (Dan 06/11). Kept with the channel
  // filter through a re-read of the same scheda, reset on a new one.
  let noteAuthorFilter = null;
  // How far the conversation is opened (Mostra precedenti). Kept with the
  // channel filter when the same scheda re-reads itself, reset on a new one.
  let timelineShown = TIMELINE_PAGE;
  // The scheda on screen, so a re-read of the same customer (after Invia,
  // a note, an edit) redraws in place instead of blanking the page.
  // Voce 8ce25b0f445f: every Scrivi press opens a new composer generation.
  // A slow first load never paints over (or crashes on) a newer opening:
  // stale callbacks return without touching the panel.
  let composerGeneration = 0;
  // Composer drafts by customer (Gmail habit, never lose text): ✕ and Esc
  // close the window, the typed text and subject stay here and come back
  // when the composer reopens on the same customer. Cleared only by a send
  // the server accepted. In memory: a reload still drops them, like any
  // unsent form. backlog:d998cf15f011: this state lives with the view, not
  // with one painted scheda — declared inside the quick actions it was born
  // again at every re-read, so a draft was lost on the way back from
  // another screen or after any save that re-reads the card.
  const composerDrafts = new Map();
  // AI drafts still queued on the pilot (504 BO_DRAFT_PENDING), keyed by
  // space, customer, channel and words → requestId (review #664): a close
  // and reopen of the composer reads the same request back, never a new POST.
  /** @type {Map<string, string>} */
  const composerAiPending = new Map();
  // The idempotency key of a send whose outcome is not yet known, keyed by
  // the message itself (draft, channel, connection, subject, trimmed text). A re-tap of the same message reuses it, so
  // the server finds its own request instead of mailing twice (production
  // 06/11: the worker sent at +2.5 min while the panel said «non inviato»).
  // A changed text, subject or channel is a new message with a new key; a
  // definitive answer (sent, refused, failed) drops the key.
  const composerSendKeys = new Map();
  let shownKey = null;
  let shownSides = [];
  // Review #612: what the person was typing in the scheda on screen (a note,
  // the open Dettagli form, a phone number) when a re-read swaps it. The new
  // scheda is built with it, so an Invia elsewhere never wipes their text.
  let pendingDrafts = null;
  // Review #612 round 5: what was being typed when a re-read of the same
  // scheda failed. The error panel replaces the scheda, so the typing is
  // kept here and handed to the next scheda that loads for this customer.
  let retainedDrafts = null;

  function readDrafts(root) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const drafts = {};
    const note = root.querySelector('[name="noteBody"]');
    if (note && typeof note.value === 'string' && note.value !== '') drafts.note = note.value;
    if (root.querySelector('button[data-action="save-details"]')) {
      // Review #612 round 3: only the fields the person changed travel to
      // the new scheda. An untouched field takes the freshly read value, so a
      // later Salva never writes back what another operator just changed.
      drafts.details = {};
      for (const name of ['firstName', 'lastName', 'email']) {
        const input = root.querySelector(`input[name="${name}"]`);
        if (input && typeof input.value === 'string' && input.value !== input.getAttribute('data-initial')) {
          drafts.details[name] = input.value;
        }
      }
    }
    // Review Muse #835 (P2): a custom field being edited, or a field being
    // added, keeps its typing through a repaint — the sections of a first
    // read now land one by one, so the editor can be open while the rest
    // arrives.
    const editing = root.querySelector('.bo-campo-editing');
    if (editing) {
      const key = editing.getAttribute('data-editing-field');
      const control = typeof editing.querySelector === 'function'
        ? editing.querySelector(`[data-field-key="${key}"]`) : null;
      drafts.field = { key, value: String(control?.value ?? '') };
    }
    const adding = root.querySelector('.bo-campo-add');
    if (adding) {
      drafts.fieldAdd = {};
      for (const name of ['nuovo-campo-label', 'nuovo-campo-tipo', 'nuovo-campo-opzioni']) {
        const input = adding.querySelector(`[name="${name}"]`);
        if (input && typeof input.value === 'string') drafts.fieldAdd[name] = input.value;
      }
    }
    return Object.keys(drafts).length > 0 ? drafts : null;
  }

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

  // backlog:2a214b66fe12: the reads one write can re-read alone. `load`
  // uses the same three, so a section re-read is exactly the full read's.
  const PART_READS = Object.freeze({
    card: (encoded) => settle(() => client.request(`/api/customer-hub/card/${encoded}`)),
    timeline: (encoded) => settle(() => client.request(`/api/customer-hub/timeline/${encoded}`)),
    profile: (encoded) => settle(() => client.request(`/api/customer-data/profile/${encoded}`)),
  });

  /** Every read of the scheda, none landed yet (backlog:1a96094db71d). */
  const PART_NAMES_PENDING = () => new Set(['card', 'timeline', 'profile', 'enrichment', 'calls', 'fieldDefs', 'fieldValues', 'pipelines']);

  /**
   * The scheda's reads, all in flight at once. backlog:1a96094db71d: with
   * `onPart` the caller hears each read as it lands (production 12/11: the
   * card answered in 5.4 s, the cronologia in 7 s, and the scheda waited for
   * the slowest before painting anything), so a section fills the moment
   * its own read is back. The final answer is the same shape as before.
   * @param {string} resource @param {string} id
   * @param {((loaded: any, pending: Set<string>) => void) | null} [onPart]
   */
  async function load(resource, id, onPart = null) {
    const encoded = `${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const spaceId = activeSpaceId();
    const loaded = {
      card: null, cardError: null, timeline: null, timelineError: null,
      profile: null, profileError: null, enrichment: null, enrichmentError: null,
      calls: null, callsError: null, fieldDefs: null, fieldDefsError: null,
      fieldValues: null, fieldValuesError: null, pipelines: [],
    };
    const pending = PART_NAMES_PENDING();
    // Voce 908f2eb9bbfb, review round 2: a 404/NOT_FOUND is not a failure to
    // retry — the package is not composed for this reader, so the read stays
    // null and the section keeps its honest not-composed state. Only a
    // non-404 failure names the retry error on the section. The card is the
    // identity source: its failure is the scheda's.
    const take = (part, settledRead, notComposedIsNull = true) => {
      const settled = notComposedIsNull ? nullOn404(settledRead) : settledRead;
      if (part === 'pipelines') {
        loaded.pipelines = Array.isArray(settled.value?.pipelines) ? settled.value.pipelines : [];
      } else {
        loaded[part] = settled.value;
        loaded[`${part}Error`] = settled.error;
      }
      pending.delete(part);
      if (typeof onPart === 'function') onPart({ ...loaded }, new Set(pending));
    };
    await Promise.all([
      PART_READS.card(encoded).then((read) => take('card', read, false)),
      PART_READS.timeline(encoded).then((read) => take('timeline', read)),
      PART_READS.profile(encoded).then((read) => take('profile', read)),
      // The enrichment read lives in the same package as the profile, so it
      // shares its fate — but an older server that does not serve the route
      // yet answers 404, and the scheda must stay honest about the section
      // instead of failing the whole card.
      settle(() => client.request(`/api/customer-data/enriched/${encoded}`)).then((read) => take('enrichment', read)),
      // Without intelligence composed (honest 404) or without a space the
      // calls read stays unavailable — never a failed card.
      (spaceId === null
        ? Promise.resolve({ value: null, error: null })
        : settle(() => client.request(`/api/call-intelligence/calls/${encoded}?spaceId=${encodeURIComponent(spaceId)}`)))
        .then((read) => take('calls', read)),
      // Custom fields (backlog:434cc39a): the space-wide definitions with
      // this customer's values. An older server without the routes answers
      // 404, and the section hides instead of failing the card.
      settle(() => fetchFieldDefs(client)).then((read) => take('fieldDefs', read)),
      settle(() => fetchFieldValues(client, resource, id)).then((read) => take('fieldValues', read)),
      // Backlog a551982c06eb: the composed pipelines name the offer's stage
      // exactly like the Pipeline board (the shell shares one schema read).
      // Without them the offer line falls back to the core stage.
      settle(() => client.request('/api/schema')).then((read) => take('pipelines', read, false)),
    ]);
    return { ...loaded };
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
    const avatar = el('span', 'bo-scheda-avatar', customerInitials(card?.name));
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
    else if (shownCompanyName(card)) meta.appendChild(el('span', 'bo-scheda-sub', shownCompanyName(card)));
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
    // Review #654: a contact typed without Azienda shows no company (the
    // card API names none for its «no company» placeholder). Its offer is
    // still filed under the contact's own placeholder — the one id the core
    // accepts beside this contact, shared with no other customer — and the
    // offer form reads the person's name, never «Senza azienda».
    const shown = shownCompanyName(card);
    const companyId = shown !== null && typeof card?.company?.id === 'string' && card.company.id !== ''
      ? card.company.id : null;
    const ownCompanyId = typeof navCtx?.contactCompanyId === 'string' && navCtx.contactCompanyId !== ''
      ? navCtx.contactCompanyId : null;
    const company = resource === 'company'
      ? { id, name }
      : (companyId !== null
        ? { id: companyId, name: shown }
        : (shown === null && ownCompanyId !== null ? { id: ownCompanyId, name } : null));
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
    /** A `profile:` handle (any case) is a pilot key, never an account or a route. */
    const isProfileKey = (value) => typeof value === 'string' && value.trim().toLowerCase().startsWith('profile:');
    /** The pilot's profile mailbox merged as a connection row: never a route. */
    const isSyntheticRow = (entry) => entry?.source === 'profile' || isProfileKey(entry?.connectionKey);
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
      // A real channel connection is preferred over the pilot's synthetic
      // profile row, whatever their order (review #648, giro 2): the real
      // row's key is a route readSyncState knows and its account is the
      // mailbox that route sends from, so «Da» and the route agree. The
      // synthetic row only stands in when it is the sole active one.
      const active = matchConnections(channel, list).filter((entry) => entry.status === 'active');
      const live = active.find((entry) => !isSyntheticRow(entry)) ?? active[0] ?? null;
      // The channel connection wins (it carries the connectionKey the send
      // queues on); the profile Gmail mailbox only fills the gap, with no
      // key — the server still needs its own email connection to send.
      const gmailLinked = channel === 'email' && live === null && gmailSender !== null;
      // Voce eaa84ccafc53: the pilot now merges the profile mailbox into the
      // connections as an active email row (`profile:gmail`). Its account is
      // the mailbox the «Da» row names; without one the profile Gmail still
      // fills it. A connection key is never a sender: a `profile:` handle
      // (any case) or the row's own key posing as an account counts as
      // missing.
      const liveAccount = channel === 'email' && live !== null && typeof live.account === 'string'
        && live.account.trim() !== '' && !isProfileKey(live.account)
        && live.account.trim() !== String(live.connectionKey ?? '').trim()
        ? live.account.trim() : null;
      const sender = liveAccount ?? (gmailLinked ? gmailSender : null);
      // The synthetic profile row is no channel connection: its key is not
      // a route the send queues on, so it is never sent (the server derives
      // the route from the space's own mailbox).
      const synthetic = live !== null && isSyntheticRow(live);
      // «Connected» implies a sender for Email: a linked row that names no
      // valid mailbox reads off with its Connettori link, never an enabled
      // channel with an empty «Da».
      const linked = live !== null || gmailLinked;
      return Object.freeze({
        channel,
        label: ownLabel(CHANNEL_LABELS, channel) ?? channel,
        recipient,
        linked,
        connected: linked && (channel !== 'email' || sender !== null),
        connectionKey: live !== null && !synthetic && typeof live.connectionKey === 'string'
          && live.connectionKey !== '' ? live.connectionKey : null,
        sender,
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
    const numbers = Array.isArray(extra.numbers) ? extra.numbers : [];
    // Voce 105563eea902: voice-aware «Chiama» — the number is dialed from
    // the CRM only through a linked voice connection (the call then enters
    // the scheda cronologia through POST /api/customer-hub/calls); without
    // one the card says so and falls back to `tel:`, never logging a call
    // the CRM never placed. A hostile value stays text in the title: the
    // href is built only from the fallback branch below, never here.
    // Dan 11/11: «Chiama» is always there. With one known number it calls
    // as before; with none, or with several, it asks which number in a
    // window, saves a new one on the contact, then calls.
    const call = tile('Chiama', 'telefono');
    call.setAttribute('type', 'button');
    call.setAttribute('data-action', 'call-customer');
    call.setAttribute('title', phone !== null ? `Chiama ${phone}` : 'Chiama: scegli o scrivi il numero');
    call.addEventListener('click', () => {
      if (phone !== null && numbers.length <= 1) openCallPanel(box, card, navCtx, phone);
      else openNumberWindow(box, card, navCtx, numbers);
    });
    row.appendChild(call);
    // A number just saved from the number window: the call starts on the
    // re-read card, with the number the server now holds.
    if (pendingCallAfterSave !== null) {
      const wanted = pendingCallAfterSave;
      pendingCallAfterSave = null;
      // Another customer took the screen meanwhile: no call there.
      const same = wanted.key === `${navCtx.resource}/${navCtx.id}`;
      const held = phone === null ? null : phone.replace(/[\s\-().]/g, '');
      if (same && held === wanted.number) openCallPanel(box, card, navCtx, phone);
      else if (same && phone !== null) {
        // The card still dials another number: never call one the
        // operator did not choose.
        toast(`Numero salvato, ma la scheda chiama ancora ${phone}: la chiamata non parte. Riprova da «Chiama».`, true);
      } else if (same) toast('Numero salvato, ma la scheda non lo mostra ancora: riprova tra poco.', true);
    }
    // Voce 2f2d22f2: the prototype names its channels — «WhatsApp» and
    // «Email» open the same composer with their channel preselected
    // (backlog:e9b4fc2f: no mailto: anywhere, Invia sends through the
    // outbox worker). A channel tile stays honest: it opens the composer
    // even when its own channel is off, and the composer says so there.
    const writable = composerChannelsFor(card, null).filter((entry) => entry.recipient !== null);
    if (writable.length === 0) {
      row.appendChild(el('span', 'bo-scheda-disabled', 'nessun canale scrivibile'));
    } else {
      for (const channel of ['whatsapp', 'email']) {
        const label = channel === 'whatsapp' ? 'WhatsApp' : 'Email';
        const channelTile = tile(label, 'messaggio');
        channelTile.setAttribute('type', 'button');
        channelTile.setAttribute('data-action', channel === 'whatsapp' ? 'compose-whatsapp' : 'compose-email');
        channelTile.setAttribute('title', `Scrivi al cliente su ${label}`);
        channelTile.addEventListener('click', () => {
          openComposer(card, navCtx, channel);
        });
        row.appendChild(channelTile);
      }
    }
  /**
   * «Chiama» without a number, or with several (Dan 11/11): the number
   * window asks which one. A number not yet held on the card is saved
   * through `POST /api/customer-hub/phone` (the server validates E.164 and
   * refuses a number held beside another customer, 409, in Italian), then
   * the card re-reads and the usual «Chiama» flow starts on the number the
   * server holds — the CRM call route dials only that one.
   */
  function openNumberWindow(box, card, navCtx, numbers) {
    closeSchedaWindows();
    openCallNumberPanel({
      doc,
      host: mount,
      customer: typeof card?.name === 'string' ? card.name : null,
      numbers,
      choose: async (number, held) => {
        if (held) {
          openCallPanel(box, card, navCtx, number);
          return null;
        }
        try {
          await client.request('/api/customer-hub/phone', {
            method: 'POST',
            body: JSON.stringify({ resource: navCtx.resource, id: navCtx.id, phone: number }),
          });
        } catch (error) {
          return phoneRefusalText(error);
        }
        toast('Numero salvato');
        // The window closes before the re-read, so it never survives it.
        const open = mount.querySelector('div[data-phone="open"]');
        if (open && open.parentNode) open.parentNode.removeChild(open);
        // Review #776 (P2): another customer took the screen while the
        // number was saving — never repaint this one over it, never call.
        const key = `${navCtx.resource}/${navCtx.id}`;
        if (shownKey !== key) return null;
        // Review #776 (P1): the call starts on the number the operator
        // chose, and only once the re-read card holds that very number.
        pendingCallAfterSave = { key, number };
        await renderCard(navCtx.resource, navCtx.id);
        return null;
      },
    });
  }
  /** The windows over the scheda: one at a time (Scrivi keeps its draft). */
  function closeSchedaWindows(keep = null) {
    for (const attr of ['data-composer', 'data-offer-panel', 'data-appointment-panel', 'data-phone']) {
      if (attr === keep) continue;
      const open = mount.querySelector(`div[${attr}="open"]`);
      if (open && open.parentNode) open.parentNode.removeChild(open);
    }
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
    save.addEventListener('click', () => uiBusy(save, 'Registro…', async () => {
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
    }));
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

  // Voce 2f2d22f2: the quick-action tile names its channel — the composer
  // opens with that channel preselected when it is usable, and falls back
  // to the first usable channel when it is not (never a dead selection).
  function openComposer(card, navCtx, preferChannel = null) {
    const generation = (composerGeneration += 1);
    closeSchedaWindows('data-composer');
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
        buildComposerForm(panel, card, navCtx, spaceId, Array.isArray(sync?.connectors) ? sync.connectors : [], profile, preferChannel);
      },
      (error) => {
        if (generation !== composerGeneration) return;
        if (wait.parentNode === panel) panel.removeChild(wait);
        if (isNotComposedFailure(error)) {
          buildComposerForm(panel, card, navCtx, spaceId, [], profile, preferChannel);
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
   * prompt } → { corta, lunga, diretta, subject? } (backlog:01289e73): the
   * server drafts three labeled wordings from the customer's own history
   * through the space LLM gate and never sends. The member picks one of
   * the three — Corta, Lunga or Diretta — and it lands in the message
   * field, editable. The three stay on screen until the send or the close
   * (production 10/11): another pick refills the field with no new call,
   * after an inline «Sostituire il testo modificato?» if the member edited
   * it; Rigenera asks three new ones. The previous text can be restored
   * once with «Annulla»;
   * Invia stays the person's click. A single-text answer from a pilot
   * before the three-version cure still fills the field at once. AI off
   * (503 LLM_SPACE_DISABLED / LLM_SECRET_UNAVAILABLE) or a pilot without
   * the route (404/405) turns the row into one honest line, never a dead
   * button.
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
    // The three versions live in their own row, so a pick or a message in
    // `line` never wipes them (production 10/11: after «Diretta» the other
    // two were gone and only Rigenera — a new AI call — brought them back).
    const choice = el('div', 'bo-composer-ai-picks');
    const field = el('div', 'bo-composer-ai-field');
    field.appendChild(mark);
    field.appendChild(prompt);
    field.appendChild(go);
    row.appendChild(field);
    row.appendChild(choice);
    row.appendChild(line);
    // The wording the AI last put in the field: a different field value
    // means the member edited it by hand.
    /** @type {string|null} */
    let filled = null;
    /** @type {any[]} */
    let pickButtons = [];
    // The line as it was before an open «Sostituire…?» confirmation, taken
    // once (Muse P2 on #737): a second pick while one is open updates it in
    // place, and «Tieni il mio» always brings back the draft line.
    /** @type {any[]|null} */
    let beforeConfirm = null;
    const markPicked = (kind) => {
      for (const node of pickButtons) node.setAttribute('aria-pressed', node.getAttribute('data-version') === kind ? 'true' : 'false');
    };
    let busy = false;
    // A draft the pilot still held after the read-back (504 BO_DRAFT_PENDING)
    // lives in composerAiPending, outside this row (review #664): the next
    // Genera with the same words and channel — even after ✕ and Scrivi —
    // reads that request back instead of asking the AI again.
    // The latest Genera (a newer one supersedes a read-back) and the key of
    // the queued draft being read back, if any.
    let drafting = 0;
    /** @type {string|null} */
    let reading = null;
    const pendingKey = (words, picked) => `${spaceId ?? ''}:${navCtx?.resource ?? ''}:${navCtx?.id ?? ''}:${picked}:${words}`;
    // The person's own text before the first AI draft (review #599 P2): kept
    // with the shared per-customer draft, so Annulla survives ✕/Esc and a
    // reopen, and restores the subject too.
    const off = (sentence) => {
      while (row.firstChild) row.removeChild(row.firstChild);
      row.setAttribute('data-off', 'true');
      row.appendChild(el('p', 'bo-composer-ai-off', sentence));
    };
    const say = (sentence, undo = false) => {
      beforeConfirm = null;
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
          filled = null;
          markPicked(null);
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
    // No channel to write on: the one way forward is Connettori.
    const sayConnect = () => {
      say('');
      line.appendChild(link('#/connettori', 'Collega un canale per scrivere a questo cliente', 'composer-connectors'));
    };
    // The line under an AI draft: reread it, and Annulla when there is a
    // text of the person's own to go back to.
    const sayDrafted = () => {
      const kept = baseline();
      say('Bozza dell’AI: rileggila e modificala prima di inviare.', kept !== null && (kept.text.trim() !== '' || kept.subject.trim() !== ''));
    };
    async function generate() {
      const words = prompt.value.trim().slice(0, COMPOSER_PROMPT_MAX);
      const picked = channel();
      // Review #664: during the minute of read-back a Genera with other
      // words supersedes the queued read (its request stays for the next
      // Genera with those words); the same words keep the read going. While
      // the POST itself is in flight Genera stays off, as before.
      if (busy && (reading === null || reading === pendingKey(words, picked))) return;
      if (words === '') {
        say('Scrivi cosa vuoi dire al cliente, poi Genera.');
        return;
      }
      if (picked === null) {
        // backlog:bd9ae1482194 (verifica 11/11): with nothing to pick, the
        // line says what to do. Scrivi only opens for a customer with an
        // address, so «no channel to pick» always means the customer's
        // channels are not linked (or not usable) yet: Connettori.
        sayConnect();
        return;
      }
      const mine = ++drafting;
      const gone = () => stale() || mine !== drafting;
      reading = null;
      busy = true;
      go.setAttribute('disabled', 'disabled');
      go.textContent = 'Scrivo…';
      say('');
      try {
        // Production 07/11 (same shape as the calendar phrase): a queued
        // draft answers 504 *_PENDING with a requestId; it is read back on
        // the same path every 3 s for about a minute, never asked again.
        const key = pendingKey(words, picked);
        let requestId = composerAiPending.get(key) ?? null;
        composerAiPending.delete(key);
        let answer = null;
        if (requestId === null) {
          try {
            answer = await client.request('/api/customer-hub/messages/draft', {
              method: 'POST',
              body: JSON.stringify({ spaceId, contactId: navCtx.id, channel: picked, prompt: words }),
            });
          } catch (error) {
            requestId = pendingRequestId(error, 'BO_DRAFT_PENDING');
            if (requestId === null) throw error;
          }
        }
        if (requestId !== null) {
          if (gone()) {
            composerAiPending.set(key, requestId);
            return;
          }
          say('Scrivo ancora… la bozza arriva tra poco.');
          // Genera comes back on during the read-back, so other words can
          // supersede it (review #664).
          reading = key;
          go.removeAttribute?.('disabled');
          go.textContent = 'Genera';
          const read = await readBackPending(client, '/api/customer-hub/messages/draft', requestId, {
            expectedCode: 'BO_DRAFT_PENDING',
            spaceId: spaceId ?? null,
            wait, everyMs: 3000, rounds: 20, stale: gone,
          });
          if (mine === drafting) reading = null;
          if (read.stale) {
            // Closed while reading back: the request stays for the next Genera.
            composerAiPending.set(key, requestId);
            return;
          }
          if (read.error) throw read.error;
          if (read.pending) {
            composerAiPending.set(key, read.requestId);
            console.warn('[bo] bozza AI ancora in coda', { requestId: read.requestId, spaceId: spaceId ?? null });
            say('L’AI sta impiegando più del previsto: premi di nuovo Genera per riprendere la stessa bozza.');
            return;
          }
          answer = read.answer;
        }
        // Review #599 P2: the composer may have been closed or reopened while
        // the AI wrote. A stale answer never touches a detached form nor the
        // shared per-customer draft; a superseded one never overwrites the
        // newer draft (review #664).
        if (gone()) return;
        // Three labeled wordings the member chooses from (backlog:01289e73):
        // the pilot's own labels (`corta`, `lunga`, `diretta`), one
        // vocabulary for the same choice on every surface.
        const kinds = [['corta', 'Corta'], ['lunga', 'Lunga'], ['diretta', 'Diretta']];
        const versions = [];
        for (const [kind, label] of kinds) {
          const wording = typeof answer?.[kind] === 'string' ? answer[kind].trim() : '';
          if (wording !== '') versions.push({ kind, label, text: wording.slice(0, 2000) });
        }
        const title = typeof answer?.subject === 'string' ? answer.subject.trim() : '';
        // Regenerating keeps the person's original, never a previous AI draft.
        const fill = (picked, kind = null) => {
          // Muse #718 P2: read the live subject at pick time — a channel
          // switch between the answer and the pick replaces the input.
          const subjectField = subject();
          if (baseline() === null) setBaseline({ text: text.value, subject: subjectField !== null ? subjectField.value : '' });
          text.value = picked;
          filled = picked;
          markPicked(kind);
          if (subjectField !== null && title !== '' && subjectField.value.trim() === '') subjectField.value = title.slice(0, 256);
          changed();
          // A pick during a Rigenera in flight leaves Genera's own label alone.
          if (!busy) go.textContent = 'Rigenera';
          sayDrafted();
          if (typeof text.focus === 'function') text.focus();
        };
        if (versions.length === kinds.length) {
          while (choice.firstChild) choice.removeChild(choice.firstChild);
          pickButtons = [];
          choice.appendChild(el('span', undefined, 'Scegli la versione da usare:'));
          for (const version of versions) {
            const pick = el('button', 'bo-composer-ai-pick', '');
            pick.setAttribute('type', 'button');
            pick.setAttribute('data-action', 'composer-ai-pick');
            pick.setAttribute('data-version', version.kind);
            pick.setAttribute('aria-pressed', 'false');
            // Voce 1ca42058: every version reads before the pick — the full
            // wording on hover plus a visible excerpt under the label, so the
            // member sees what each version holds without picking it first.
            pick.setAttribute('title', version.text);
            pick.appendChild(el('span', 'bo-composer-ai-pick-label', version.label));
            // P3 on #859: truncate on code points, never a UTF-16 slice that
            // can split a surrogate pair (emoji) and paint U+FFFD.
            const chars = Array.from(version.text);
            const excerpt = chars.length > 120 ? `${chars.slice(0, 120).join('')}…` : version.text;
            pick.appendChild(el('span', 'bo-composer-ai-preview', excerpt));
            // Only a closed or reopened composer retires the versions: a
            // Rigenera in flight leaves them working until the new three.
            pick.addEventListener('click', () => {
              if (stale()) return;
              if (filled === null || text.value === filled) {
                fill(version.text, version.kind);
                return;
              }
              // Hand edits never go in silence: ask inline, never a browser dialog.
              if (beforeConfirm === null) beforeConfirm = Array.from(line.childNodes ?? []);
              const before = beforeConfirm;
              while (line.firstChild) line.removeChild(line.firstChild);
              line.textContent = '';
              line.appendChild(el('span', undefined, `Sostituire il testo modificato con la versione ${version.label}? `));
              const replace = el('button', 'bo-composer-ai-undo', 'Sostituisci');
              replace.setAttribute('type', 'button');
              replace.setAttribute('data-action', 'composer-ai-replace');
              replace.addEventListener('click', () => { if (!stale()) fill(version.text, version.kind); });
              const keep = el('button', 'bo-composer-ai-undo', 'Tieni il mio');
              keep.setAttribute('type', 'button');
              keep.setAttribute('data-action', 'composer-ai-keep');
              keep.addEventListener('click', () => {
                beforeConfirm = null;
                while (line.firstChild) line.removeChild(line.firstChild);
                line.textContent = '';
                for (const node of before) line.appendChild(node);
              });
              line.appendChild(replace);
              line.appendChild(el('span', undefined, ' · '));
              line.appendChild(keep);
            });
            choice.appendChild(pick);
            pickButtons.push(pick);
          }
          // Voce 1ca42058 (Dan 13/11): Genera fills the field at once with
          // the first version, marked as picked, with the «Bozza dell'AI»
          // line — the member reads a draft right away instead of an empty
          // field. A new set after a pick keeps the earlier wording instead,
          // none of the new three selected yet.
          // P1 on #859: `filled` is per-row, but the person's original
          // (`baseline()`) survives ✕/Esc in the shared draft — after a
          // reopen a Rigenera must not overwrite hand edits in silence.
          // The first fill happens only when no AI draft exists yet.
          if (filled === null && baseline() === null && versions.length > 0) fill(versions[0].text, versions[0].kind);
          else if (filled !== null || baseline() !== null) sayDrafted();
          return;
        }
        // A single-text answer from a pilot before the three-version cure
        // still fills the field at once, never a dead choice.
        const drafted = typeof answer?.body === 'string' ? answer.body.trim() : '';
        if (drafted === '') {
          say('L’AI non ha scritto niente: prova a dirlo in un altro modo.');
          return;
        }
        while (choice.firstChild) choice.removeChild(choice.firstChild);
        pickButtons = [];
        // Same P1 on #859 as the three-version path: after ✕/Esc and a
        // reopen, a legacy single-text answer must not overwrite hand edits
        // in silence either.
        if (filled === null && baseline() === null) fill(drafted.slice(0, 2000));
        else sayDrafted();
      } catch (error) {
        if (gone()) return;
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
        if (mine !== drafting) return;
        busy = false;
        reading = null;
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


  function buildComposerForm(panel, card, navCtx, spaceId, connections, profile, preferChannel = null) {
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
    // Voce 59def6cb805d (C22): the prototype's channel note beside Invia.
    const channelHint = el('span', 'bo-composer-hint', '');
    // Voce 59def6cb805d (C21): the placeholder names the customer by first
    // name and the chosen channel, like the prototype.
    const firstName = typeof card?.name === 'string' ? (card.name.trim().split(/\s+/)[0] ?? '') : '';
    const sendLabel = () => (selected !== null ? `Invia su ${selected.label}` : 'Invia');
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
      text.setAttribute('placeholder', firstName !== ''
        ? `Scrivi a ${firstName} su ${entry.label}…`
        : `Scrivi su ${entry.label}…`);
      if (send.getAttribute('aria-busy') !== 'true') send.textContent = sendLabel();
      channelHint.textContent = `parte da ${entry.label} · resta anche lì`;
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
    // Voce 2f2d22f2: the tile's channel wins over the first-usable default —
    // but only when it is usable (a recipient and a connection). Otherwise
    // the honest default stays, never a disabled selection.
    if (typeof preferChannel === 'string' && preferChannel !== '') {
      const preferred = radios.find((row) => row.entry.channel === preferChannel
        && row.entry.recipient !== null && row.entry.connected === true);
      if (preferred) select(preferred.entry);
    }
    // backlog:bd9ae1482194: the space links none of the channels the
    // composer writes on (no active row, no profile Gmail). Production
    // 6b886ee: the customer has addresses, so the per-channel «canale non
    // collegato» line used to win — with nothing linked at all the one line
    // is the way to Connettori.
    const spaceUnlinked = !channels.some((entry) => entry.linked === true);
    if (spaceUnlinked) {
      offLine.appendChild(link('#/connettori', 'Collega un canale per scrivere a questo cliente', 'composer-connectors'));
    } else if (offLinked.length > 0) {
      offLine.appendChild(el('span', undefined, `${offLinked.join(', ')}: canale non collegato · `));
      offLine.appendChild(link('#/connettori', 'Collega in Connettori', 'composer-connectors'));
    }
    body.appendChild(el('p', 'bo-composer-label bo-composer-reply-on', 'Rispondi su'));
    body.appendChild(list);
    if (offLine.firstChild) body.appendChild(offLine);
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
    foot.appendChild(channelHint);
    foot.appendChild(limitHint);
    panel.appendChild(body);
    panel.appendChild(foot);
    if (selected !== null) select(selected);
    else {
      send.setAttribute('disabled', 'disabled');
      // backlog:bd9ae1482194: the space has no channel at all, or only
      // channels this customer cannot be reached on.
      toLine.textContent = spaceUnlinked ? 'Nessun canale collegato' : 'Nessun canale collegato per questo cliente';
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
      send.textContent = on ? 'Invio…' : sendLabel();
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
        // The re-read below keeps open windows through the in-place swap
        // (#612); the sent message's own window closes first, as it always
        // did, so the sent text never stays under a live Invia.
        composerGeneration += 1;
        if (panel.parentNode) panel.parentNode.removeChild(panel);
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
    // Voce 714433c2: «Nuova offerta» and «Nuovo appuntamento» start with
    // this customer already chosen, in a window over the scheda; without a
    // named record they open their screens unpicked instead of inventing a
    // customer.
    const pick = customerPickFor(navCtx, card);
    // Voce c2793930850a: the creation voices are tiles like Chiama and
    // Scrivi — the 2x2 grid below stays equal, no bare button overflows it.
    const offer = tile('Offerta', 'offerta');
    offer.setAttribute('type', 'button');
    offer.setAttribute('data-action', 'new-offer');
    // Dan 06/11: the offer is written where the customer is — a window
    // over the scheda like «Scrivi», never a jump to another page. Only one
    // window at a time: the composer steps aside (its draft is kept).
    offer.addEventListener('click', () => {
      if (pick === null) {
        navigate('#/modules/opportunity/new');
        return;
      }
      closeSchedaWindows('data-offer-panel');
      openOfferPanel({
        doc,
        host: mount,
        client,
        issueKey: () => submissions.issueKey(),
        card,
        navCtx,
        company: pick.company,
        spaceId: activeSpaceId(),
        toast,
        // backlog:2a214b66fe12: the new offer shows at once, then only the
        // profile (where the offer section reads) is read again.
        onCreated: (created) => {
          void refreshParts(navCtx.resource, navCtx.id, ['profile'], (loaded) => withOpportunity(loaded, created));
        },
      });
    });
    row.appendChild(offer);
    const appointment = tile('Appuntamento', 'appuntamento');
    appointment.setAttribute('type', 'button');
    appointment.setAttribute('data-action', 'new-appointment');
    // Dan 11/11: the appointment is booked where the customer is — a
    // window over the scheda like «Nuova offerta», never a jump to the
    // Calendario. Without a named record the Calendario opens unpicked.
    appointment.addEventListener('click', () => {
      if (pick === null) {
        navigate('#/calendario');
        return;
      }
      closeSchedaWindows('data-appointment-panel');
      openAppointmentPanel({
        doc,
        host: mount,
        client,
        issueKey: () => submissions.issueKey(),
        customer: { resource: pick.resource, id: pick.id, name: pick.name },
        spaceId: activeSpaceId(),
        toast,
        // Review #776 (P2): only while this customer is still on screen.
        onBooked: () => {
          // backlog:2a214b66fe12: the booking reads in the cronologia
          // («Prossimo appuntamento»): only the cronologia is read again.
          if (shownKey === `${navCtx.resource}/${navCtx.id}`) void refreshParts(navCtx.resource, navCtx.id, ['timeline']);
        },
      });
    });
    row.appendChild(appointment);
    // Voce 2f2d22f2: the prototype's sixth tile — the same AI voice as
    // Dettagli (voce d525f4aa48b2): the BO-F0-04 bar with this customer
    // already in the context. Without a named record there is no context
    // to open, so the tile stays out like the creation tiles' windows do.
    if (typeof navCtx?.resource === 'string' && navCtx.resource !== ''
      && typeof navCtx?.id === 'string' && navCtx.id !== '') {
      const ask = tile("✦ Chiedi all'AI", 'ai');
      ask.setAttribute('type', 'button');
      ask.setAttribute('data-action', 'quick-ask-ai');
      ask.setAttribute('title', 'Chiedi all\u2019assistente con questo cliente nel contesto (⌘K)');
      ask.addEventListener('click', () => {
        const name = typeof card?.name === 'string' && card.name.trim() !== '' ? card.name.trim() : 'senza nome';
        if (onAskAi) onAskAi('scheda-cliente', `Cliente ${name} (${navCtx.resource}/${navCtx.id})`, { resource: navCtx.resource, id: navCtx.id });
        else toast('Apri la barra AI (⌘K) e descrivi cosa vuoi fare per questo cliente.');
      });
      row.appendChild(ask);
    }
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
    const directions = observedDirections(timeline);
    /** @type {Array<{ node: any, system: string, both: boolean }>} */
    const syncLines = [];
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
      // Voce 59def6cb805d (C10): the prototype's sync line, from what the
      // passages on this channel prove — both directions seen reads
      // «↔ sincronizzato», received only «← in entrata», sent only
      // «→ in uscita». A channel with no directed passage says nothing.
      // Review #650 (P2): the directions come from the entries page, so on
      // a truncated read a single direction is not exhaustive — the other
      // may sit on a later page. Both seen is proven either way; one seen
      // names the partial list, the same honesty standard as the count.
      const seen = directions.get(system);
      const partial = merged.complete !== true ? ' (elenco parziale)' : '';
      // backlog:e381c48581fa: both directions seen prove traffic, not a
      // sync. «↔ sincronizzato» needs the channel linked in the space (the
      // shared `channelState`); until that is known the line says what was
      // seen, and a channel known unlinked says so.
      const sync = seen?.in && seen?.out ? '↔ in entrata e in uscita'
        : seen?.in ? `← in entrata${partial}` : seen?.out ? `→ in uscita${partial}` : null;
      if (sync) {
        const node = el('span', 'bo-scheda-identity-sync', sync);
        line.appendChild(node);
        syncLines.push({ node, system, both: Boolean(seen?.in && seen?.out) });
      }
      box.appendChild(line);
    }
    if (syncLines.length > 0) {
      void readSpaceChannels().then((space) => {
        if (space === null) return;
        for (const entry of syncLines) {
          const linked = channelState(cardCountedChannel(entry.system), space).state === 'collegato';
          if (linked && entry.both) entry.node.textContent = '↔ sincronizzato';
          // «non collegato» only when known (review #819 P2): with the
          // profile unread a Profilo link cannot be ruled out, so the line
          // keeps the traffic it saw and claims nothing more.
          else if (!linked && space.profileRead) entry.node.textContent = `${entry.node.textContent} · canale non collegato`;
        }
      });
    }
    // Voce 785428ec3de0: a customer with no union reads nothing here — no
    // technical line, no lone «scheda principale» row. The union block shows
    // only when several schede are linked as the same person.
    const members = cluster.linked === true && Array.isArray(cluster.members) ? cluster.members : [];
    if (cluster.linked === true) {
      box.appendChild(el('p', 'bo-muted',
        `${members.length} ${members.length === 1 ? 'scheda' : 'schede'} della stessa persona`));
    }
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
    if (shownCompanyName(card)) fact('Azienda', shownCompanyName(card));
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
    // Voce ebde30a307f2: moduli order/commercial-contract/subscription non
    // composti → la riga non compare (statusMicrocopy null); a moduli
    // composti ma illeggibili resta il messaggio temporaneo.
    const microcopy = statusMicrocopy(card, profile);
    if (microcopy !== null) box.appendChild(el('p', 'bo-muted', microcopy));
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
      if (pendingDrafts && pendingDrafts.details) {
        const typed = pendingDrafts.details;
        renderDetailsForm(box, card, contact, editCtx, restore);
        for (const name of Object.keys(typed)) {
          const input = box.querySelector(`input[name="${name}"]`);
          if (input) input.value = typed[name];
        }
        return;
      }
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
      // What the form opened with: a re-read keeps only what differs from it.
      input.setAttribute('data-initial', value);
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
    // Production 07/11: one Salva sent PATCH /contacts/<id> twice. The
    // guard is the view's, not this form's: a second handler, a second form
    // on the same contact (a re-render that raced) or a double tap all find
    // the PATCH already in flight and send nothing.
    const flightKey = `PATCH contact ${contact.id}`;
    let busy = false;
    const doSave = () => uiBusy(save, 'Salvo…', async () => {
      if (busy || detailsInFlight.has(flightKey)) return;
      busy = true;
      detailsInFlight.add(flightKey);
      save.disabled = true;
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
        detailsInFlight.delete(flightKey);
        if (typeof restore === 'function') restore();
        // backlog:2a214b66fe12: the new name and email show at once; then
        // only the card and the profile are read again.
        const typed = { firstName: firstInput.value, lastName: lastInput.value, email: emailInput.value };
        const refreshed = refreshParts(editCtx.resource, editCtx.id, ['card', 'profile'],
          (loaded) => withContactDetails(loaded, typed));
        toast('Dati salvati');
        await refreshed;
      } catch (err) {
        const refusal = detailsRefusalText(err);
        error.textContent = refusal;
        toast(refusal, true);
      } finally {
        detailsInFlight.delete(flightKey);
        busy = false;
        save.disabled = false;
      }
    });
    const doCancel = async () => {
      if (typeof restore === 'function') {
        restore();
        return;
      }
      // Nothing was written: the scheda comes back from what it shows.
      await repaintShown(editCtx.resource, editCtx.id);
    };
    save.addEventListener('click', doSave);
    cancel.addEventListener('click', doCancel);
    // backlog:82235e46e3e9: Invio saves and Esc cancels, from any field. A
    // save in flight is not cancelled under it: Esc waits for the answer.
    for (const input of [firstInput, lastInput, emailInput]) {
      input.addEventListener('keydown', (event) => {
        if (event?.isComposing) return;
        if (event?.key === 'Enter') {
          event.preventDefault?.();
          void doSave();
        } else if (event?.key === 'Escape' && !busy) {
          event.preventDefault?.();
          void doCancel();
        }
      });
    }
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
    const openAdd = (draft = null) => {
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
      if (draft !== null) {
        for (const [name, value] of Object.entries(draft)) {
          const input = form.wrap.querySelector?.(`[name="${name}"]`);
          if (input) {
            input.value = value;
            // The type select shows the options field for «Scelta».
            if (typeof input.dispatchEvent === 'function' && typeof Event === 'function') input.dispatchEvent(new Event('change'));
            else input.dispatch?.('change');
          }
        }
      }
    };
    add.addEventListener('click', () => openAdd());
    box.appendChild(add);
    // Review Muse #835 (P2): what was being typed comes back after a repaint.
    const kept = pendingDrafts;
    if (kept?.fieldAdd) openAdd(kept.fieldAdd);
    const editingDef = kept?.field ? ctx.defs.find((def) => def?.key === kept.field.key) : null;
    if (editingDef) renderFieldForm(box, ctx, editingDef, kept.field.value);
    return true;
  }

  /** In-place edit of one custom-field value: Salva rewrites the single row. */
  function renderFieldForm(box, ctx, def, draft = undefined) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.setAttribute('data-editing-field', String(def?.key ?? ''));
    const classes = String(box.getAttribute('class') ?? '');
    if (!classes.split(/\s+/).includes('bo-campo-editing')) box.setAttribute('class', `${classes} bo-campo-editing`.trim());
    box.appendChild(el('h4', undefined, 'Campi personalizzati'));
    const rows = Array.isArray(ctx.values) ? ctx.values : [];
    const current = rows.find((row) => row?.key === def?.key)?.value ?? null;
    const entry = fieldControl(el, def, draft !== undefined ? draft : current);
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
    save.addEventListener('click', () => uiBusy(save, 'Salvo…', async () => {
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
    }));
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
      refresh.addEventListener('click', () => uiBusy(refresh, 'Aggiorno…', async () => {
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
      }));
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

  function timelineBox(box, timeline, noteCtx, profile = null, pipelines = []) {
    // Voce 59def6cb805d (C14): the prototype names this section, not the
    // record kind behind it.
    box.appendChild(el('h4', undefined, 'Tutti i contatti'));
    // backlog:5346ab531538: a cancelled appointment reads in the cronologia
    // as its own row, under «Tutti» only (it has no channel), at the moment
    // it was cancelled — the slot left the calendar grid, not the history.
    const entries = [
      ...collapseDuplicatePassages(Array.isArray(timeline?.entries?.items) ? timeline.entries.items : []),
      ...cancelledAppointmentEntries(timeline),
    ];
    const channels = [...new Set(entries.map((item) => String(item?.channel ?? '')).filter((channel) => channel !== ''))];
    // Dan 06/11: the notes get their own chip — «Note · N» — and, once
    // there, one chip per writer («da dan», «dal team»).
    const notes = entries.filter((item) => item?.entry === 'note');
    // backlog:82235e46e3e9: a provider id the roster names is a writer too.
    const noteAuthor = (item) => {
      const id = typeof item?.teamAuthorId === 'string' ? item.teamAuthorId.trim() : '';
      return id !== '' && (rosterName(id) !== null || isHumanHandle(id)) ? id : '';
    };
    const authors = [...new Set(notes.map(noteAuthor))];
    // Review #612 round 3: a filter kept through a re-read may name a channel
    // (or a note writer) the fresh cronologia no longer has. It falls back to
    // «Tutti», like a new scheda, instead of a chip-less false empty state.
    const filterGone = channelFilter === 'note'
      ? notes.length === 0
      : channelFilter !== 'all' && !channels.includes(channelFilter);
    if (filterGone) {
      channelFilter = 'all';
      noteAuthorFilter = null;
      timelineShown = TIMELINE_PAGE;
    } else if (noteAuthorFilter !== null && !authors.includes(noteAuthorFilter)) {
      noteAuthorFilter = null;
      timelineShown = TIMELINE_PAGE;
    }
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
        timelineShown = TIMELINE_PAGE;
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
          const label = author === '' ? 'dal team' : `da ${writerName(author) ?? 'un membro del team'}`;
          const node = chip(label, `note:${author}`, noteAuthorFilter === author, () => {
            noteAuthorFilter = noteAuthorFilter === author ? null : author;
            timelineShown = TIMELINE_PAGE;
            drawChips();
            drawList();
          });
          node.setAttribute('data-author', author === '' ? 'team' : author);
          byAuthor.appendChild(node);
        }
        chips.appendChild(byAuthor);
      }
    };
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
    // backlog:82235e46e3e9: «Tutti» also tells the commercial story — each
    // offer when it was created, and the stage moves of the offer the
    // scheda shows (the same history «Storia stati» reads), signed by name.
    const companyName = typeof profile?.identity?.company?.name === 'string' && profile.identity.company.name !== ''
      ? profile.identity.company.name : null;
    const offers = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : [];
    const offerEvents = offers
      .filter((row) => typeof row?.id === 'string' && Number.isFinite(Date.parse(String(row?.createdAt ?? ''))))
      .map((row) => ({
        entry: 'offer-created', id: `offerta:${row.id}`, occurredAt: row.createdAt,
        title: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : 'offerta',
        who: writerName(row.createdBy ?? row.actorId) ?? null,
      }));
    let stageEvents = [];
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : [];
    const shownOffer = quotes[0] ?? offers[0] ?? null;
    const historyId = historyTarget(shownOffer, quotes.length > 0);
    const historyName = offers.find((row) => row?.id === historyId)?.name ?? null;
    const drawList = () => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const events = channelFilter === 'all' ? [...offerEvents, ...stageEvents] : [];
      // Voce 714433c2: operator notes are channel-less, so they read under
      // `Tutti` only — a channel filter shows that channel's passages alone.
      // Dan 06/11: newest first, a page at a time — 42 e-mails used to make
      // a 5.600px page. «Mostra precedenti» opens the next page below.
      const filtered = [...entries, ...events].filter((item) => {
        if (channelFilter === 'all') return true;
        if (channelFilter === 'note') return item?.entry === 'note' && (noteAuthorFilter === null || noteAuthor(item) === noteAuthorFilter);
        return String(item?.channel ?? '') === channelFilter;
      });
      const ordered = [...filtered].sort((a, b) => (Date.parse(String(b?.occurredAt ?? '')) || 0) - (Date.parse(String(a?.occurredAt ?? '')) || 0));
      const visible = ordered.slice(0, timelineShown);
      if (filtered.length === 0) {
        // Voce 59def6cb805d (C27): the exact empty state of the prototype,
        // never a technical sentence.
        if (channelFilter === 'note') {
          list.appendChild(el('p', 'bo-scheda-empty-title', 'Nessuna nota qui'));
          list.appendChild(el('p', 'bo-muted', 'Scrivi una nota qui sotto: resta nella cronologia del cliente.'));
          return;
        }
        // backlog:82235e46e3e9: the field below writes a note, not a
        // message: the empty state names the right tool for each.
        if (channelFilter === 'all') {
          list.appendChild(el('p', 'bo-scheda-empty-title', 'Ancora nessun contatto'));
          list.appendChild(el('p', 'bo-muted', 'Scrivi al cliente con «Scrivi», oppure aggiungi una nota qui sotto.'));
          return;
        }
        list.appendChild(el('p', 'bo-scheda-empty-title', 'Nessun messaggio su questo canale'));
        list.appendChild(el('p', 'bo-muted', 'Prova un altro canale, oppure scrivi al cliente con «Scrivi».'));
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
        if (item?.entry === 'appointment-cancelled') {
          row.setAttribute('class', 'bo-scheda-entry bo-scheda-entry-note bo-scheda-entry-cancelled');
          const mark = el('span', 'bo-scheda-chan bo-tile-cancelled', '×');
          mark.setAttribute('aria-hidden', 'true');
          row.appendChild(mark);
          const paper = el('div', 'bo-scheda-note-paper');
          paper.appendChild(el('p', 'bo-scheda-entry-head', item.title));
          if (item.reason) paper.appendChild(el('p', 'bo-scheda-note-body', `Motivo: ${item.reason}`));
          row.appendChild(paper);
          list.appendChild(row);
          continue;
        }
        if (item?.entry === 'offer-created' || item?.entry === 'stage-moved') {
          // backlog:82235e46e3e9: an offer or a stage move in the
          // cronologia — a system line with its own mark, never a bubble.
          const when = timeParts(item?.occurredAt);
          const head = item.entry === 'offer-created' ? 'Offerta creata' : 'Cambio di stato';
          const by = typeof item.who === 'string' && item.who !== '' ? ` · da ${item.who}` : '';
          row.setAttribute('class', 'bo-scheda-entry bo-scheda-entry-event');
          const mark = el('span', 'bo-scheda-chan bo-tile-event', item.entry === 'offer-created' ? '€' : '→');
          mark.setAttribute('aria-hidden', 'true');
          row.appendChild(mark);
          const paper = el('div', 'bo-scheda-event-paper');
          paper.appendChild(el('p', 'bo-scheda-entry-head', when ? `${head}${by} · ${when}` : `${head}${by}`));
          paper.appendChild(el('p', 'bo-scheda-event-body', item.text ?? item.title ?? ''));
          row.appendChild(paper);
          list.appendChild(row);
          continue;
        }
        if (item?.entry === 'note') {
          // Voce 714433c2: the operator note. No channel badge and no sync
          // line — it is a statement about the customer, not a passage.
          // The writer reads when the row names a human handle, like the
          // outbound passages above; markup in the body stays text.
          // Dan 06/11: «ho aggiunto una nota ma non si vede» — the note
          // reads as a note at a glance: its own mark and a paper tone.
          const when = timeParts(item?.occurredAt);
          // backlog:82235e46e3e9: signed with the writer's name from the
          // team roster, never «dal team» for a known operator.
          const writer = writerName(item?.teamAuthorId);
          const author = writer !== null ? `da ${writer}` : 'dal team';
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
        const directionRaw = String(item?.direction ?? '');
        const isOutbound = directionRaw === 'outbound';
        const isInbound = directionRaw === 'inbound';
        // Dan 07/11: «inviato e ricevuto sarebbe più chiaro a destra e
        // sinistra, come una conversazione». Received passages sit on the
        // left, the team's on the right, each in its own bubble; the channel
        // badge stays on the outer edge so the filter chips still read. A
        // passage with no recorded direction is never guessed: it sits in
        // the middle, neutral, and says nothing about who wrote it.
        const side = isOutbound ? 'out' : isInbound ? 'in' : 'none';
        row.setAttribute('class', `bo-scheda-entry bo-scheda-entry-${side}`);
        row.setAttribute('data-direction', side);
        row.appendChild(el('span', `bo-scheda-chan bo-tile-${known ? channelKey : 'other'}`, known ? CARD_CHANNEL_MARKS[channelKey] : '·'));
        const bubble = el('div', 'bo-scheda-bubble');
        // The side already says the direction: the head names channel,
        // person and hour once (it used to repeat the channel three times).
        const who = isOutbound
          ? (writerName(item?.teamAuthorId) ?? 'il team')
          : (typeof item?.remoteHandle === 'string' && item.remoteHandle.trim() !== ''
            ? item.remoteHandle.trim()
            // Review #626 giro 2: a received passage without a handle still
            // names its direction for sighted readers, like main did.
            : (isInbound ? 'ricevuto' : null));
        // Voce 59def6cb805d (C17): the day already heads the group, so the
        // card shows the hour only (`<hh:mm>`).
        const when = timeParts(item?.occurredAt);
        const entryHead = el('p', 'bo-scheda-entry-head');
        // The side is visual only: a screen reader hears the direction as
        // the first word of the bubble (review #626).
        if (side !== 'none') entryHead.appendChild(el('span', 'sr-only', isOutbound ? 'Inviato. ' : 'Ricevuto. '));
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
            [isOutbound ? 'chiamata in uscita' : isInbound ? 'chiamata in entrata' : 'chiamata', dur, outcome].filter(Boolean).join(' · ')));
        } else {
          // Dan 10/11, like Gmail: the line reads «Oggetto — testo pulito»,
          // bounded like every preview; «Mostra tutto» opens the whole body,
          // always clean. Never an empty line: «(nessun testo)» unless an
          // attachment is what the passage carries.
          const line = passagePreview(item);
          const full = passageFullText(item);
          const hasAttachment = item?.attachment != null && typeof item.attachment === 'object';
          if (line !== '' || !hasAttachment) {
            const shown = line !== '' ? line : PASSAGE_NO_TEXT;
            const bodyNode = el('p', 'bo-scheda-entry-body', shown);
            bubble.appendChild(bodyNode);
            if (full !== '' && full !== shown) {
              bodyNode.setAttribute('data-folded', 'true');
              const more = el('button', 'bo-scheda-entry-more', 'Mostra tutto');
              more.setAttribute('type', 'button');
              more.setAttribute('data-action', 'entry-expand');
              more.addEventListener('click', () => {
                const folded = bodyNode.getAttribute('data-folded') === 'true';
                bodyNode.setAttribute('data-folded', folded ? 'false' : 'true');
                bodyNode.textContent = folded ? full : shown;
                more.textContent = folded ? 'Mostra meno' : 'Mostra tutto';
              });
              bubble.appendChild(more);
            }
          }
        }
        const attachment = attachmentNode(item?.attachment);
        if (attachment) bubble.appendChild(attachment);
        // The delivery state reads only where it says something: under the
        // team's messages (inviato, consegnato, letto, non consegnato) and
        // under a received one only when it is not the plain «ricevuto».
        const syncKey = String(item?.sync ?? '').trim().toLowerCase();
        const plainReceived = isInbound && syncKey === 'received';
        if (item?.entry !== 'call' && outcome && !plainReceived) {
          const state = el('p', 'bo-scheda-sync', outcome);
          state.setAttribute('data-sync', syncKey);
          bubble.appendChild(state);
        }
        // Voce 97cba17cbb8c (VALIDAZIONE A4): un invio fallito resta
        // visibile con il motivo italiano e Riprova. Riprova riusa la
        // stessa rotta del composer (un tasto nuovo, mai un doppio invio:
        // la chiave del messaggio è fresca a ogni tocco).
        if (item?.entry === 'message' && isOutbound && syncKey === 'failed') {
          const reason = el('p', 'bo-scheda-failed-reason', `Non consegnato: ${failedSendReason(item?.errorCode)}`);
          reason.setAttribute('data-failed-reason', String(item?.errorCode ?? ''));
          bubble.appendChild(reason);
          const body = typeof item?.body === 'string' ? item.body : '';
          const channel = typeof item?.channel === 'string' ? item.channel : '';
          if (body !== '' && channel !== '') {
            const retry = el('button', 'bo-scheda-retry', 'Riprova');
            retry.setAttribute('type', 'button');
            retry.setAttribute('data-action', 'message-retry');
            retry.addEventListener('click', () => uiBusy(retry, 'Invio…', async () => {
              retry.setAttribute('disabled', '');
              try {
                const spaceId = activeSpaceId();
                await client.request('/api/customer-hub/messages', {
                  method: 'POST',
                  body: JSON.stringify({
                    spaceId,
                    resource: noteCtx?.resource,
                    id: noteCtx?.id,
                    channel,
                    text: body,
                    messageKey: freshMessageKey(),
                  }),
                });
                toast('Messaggio in consegna');
                await renderCard(noteCtx?.resource, noteCtx?.id);
              } catch (error) {
                toast(humanReadError(error, { failed: 'Messaggio non inviato. Riprova più tardi.' }), true);
                retry.removeAttribute('disabled');
              }
            }));
            bubble.appendChild(retry);
          }
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
          timelineShown += TIMELINE_PAGE;
          drawList();
        });
        list.appendChild(older);
      }
    };
    drawChips();
    box.appendChild(chips);
    drawList();
    box.appendChild(list);
    if (typeof historyId === 'string' && historyId !== '') {
      void readHistory(historyId).then(({ items, people }) => {
        const owner = offers.find((row) => row?.id === historyId)?.owner ?? null;
        const rows = [];
        for (const entry of Array.isArray(items) ? items : []) {
          const move = stageMoveOf(entry);
          if (move === null || !Number.isFinite(Date.parse(String(entry?.createdAt ?? '')))) continue;
          const words = stageMoveLabels(pipelines, move);
          const what = words === null ? 'stato cambiato' : `da ${words.from} a ${words.to}`;
          rows.push({
            entry: 'stage-moved', id: `stato:${String(entry?.id ?? rows.length)}`, occurredAt: entry.createdAt,
            text: historyName ? `${historyName}: ${what}` : what,
            who: auditActorLabel(entry, [owner, companyName], people),
          });
        }
        if (rows.length === 0 || list.parentNode == null) return;
        stageEvents = rows;
        drawList();
      }, () => {});
    }
    // Voce 714433c2: "Aggiungi nota" — the operator statement that reads
    // back in the cronologia above. Plain text only, like the work views; it
    // emails nobody and notifies nobody. A refused save keeps the text with
    // the server's Italian error, and a saved note re-reads the card so the
    // row is the server's row, never an optimistic copy.
    if (noteCtx && typeof noteCtx.resource === 'string' && typeof noteCtx.id === 'string') {
      const noteForm = el('div', 'bo-scheda-note-form');
      // backlog:82235e46e3e9: a note can hold more lines — Invio adds it,
      // Maiusc+Invio goes to a new line, like a chat.
      const noteInput = el('textarea', 'bo-scheda-note-input');
      noteInput.setAttribute('name', 'noteBody');
      noteInput.setAttribute('rows', '1');
      noteInput.setAttribute('aria-label', 'Nota da aggiungere alla cronologia del cliente');
      noteInput.setAttribute('placeholder', 'Scrivi una nota (massimo 1000 caratteri)');
      if (pendingDrafts && typeof pendingDrafts.note === 'string') noteInput.value = pendingDrafts.note;
      const noteButton = el('button', undefined, 'Aggiungi nota');
      noteButton.setAttribute('type', 'button');
      noteButton.setAttribute('data-action', 'add-note');
      const noteError = el('small', 'field-error', '');
      const addNote = () => uiBusy(noteButton, 'Salvo…', async () => {
        // Review #793 (P2): the guard is the view's, not this form's — a
        // repaint while the note is saving (the roster arriving) rebuilds
        // the form, and its Invio must not post the same note again.
        if (noteSaving) return;
        if (String(noteInput.value ?? '').trim() === '') {
          noteError.textContent = 'Scrivi la nota prima di aggiungerla.';
          return;
        }
        if (String(noteInput.value).trim().length > NOTE_MAX) {
          noteError.textContent = NOTE_TOO_LONG;
          return;
        }
        noteSaving = true;
        noteError.textContent = '';
        try {
          const written = noteInput.value;
          const saved = await client.request('/api/customer-hub/notes', {
            method: 'POST',
            body: JSON.stringify({ resource: noteCtx.resource, id: noteCtx.id, body: written }),
          });
          noteInput.value = '';
          // backlog:2a214b66fe12: the note is in the cronologia the moment
          // the toast says so; then only the cronologia is read again.
          const refreshed = refreshParts(noteCtx.resource, noteCtx.id, ['timeline'],
            (loaded) => withNote(loaded, saved, written));
          toast('Nota aggiunta');
          mount.querySelector('[name="noteBody"]')?.focus?.();
          await refreshed;
        } catch (error) {
          const said = noteRefusalText(error);
          noteError.textContent = said;
          toast(said, true);
        } finally {
          noteSaving = false;
        }
      });
      noteButton.addEventListener('click', addNote);
      noteInput.addEventListener('keydown', (event) => {
        if (event?.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault?.();
        void addNote();
      });
      noteForm.appendChild(noteInput);
      noteForm.appendChild(noteButton);
      noteForm.appendChild(noteError);
      noteForm.appendChild(el('p', 'bo-muted',
        'Invio aggiunge la nota, Maiusc+Invio va a capo. Non viene inviata a nessuno.'));
      box.appendChild(noteForm);
    }
  }

  function nextSteps(box, profile, profileError = null, stepCtx = null) {
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
      // Voce 59def6cb805d (C24): the prototype's circular check before each
      // step. It completes the real work task through the work-task
      // `complete` action (the same path Oggi uses), then re-reads the card:
      // the list is the server's, never an optimistic copy. Without an id or
      // a card context the step stays plain text.
      const taskId = typeof task?.id === 'string' && task.id !== '' ? task.id : null;
      if (taskId === null || !stepCtx || typeof stepCtx.resource !== 'string' || typeof stepCtx.id !== 'string') {
        box.appendChild(el('p', 'bo-scheda-step', name));
        continue;
      }
      const row = el('div', 'bo-scheda-step bo-scheda-step-row');
      const check = el('button', 'bo-scheda-step-check', '');
      check.setAttribute('type', 'button');
      check.setAttribute('data-action', 'complete-step');
      check.setAttribute('aria-label', `Segna come fatto: ${name}`);
      check.setAttribute('title', 'Segna come fatto');
      let busy = false;
      check.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        check.setAttribute('aria-busy', 'true');
        try {
          await client.request(`/api/modules/work-task/records/${encodeURIComponent(taskId)}/actions/complete`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          toast(`Fatto: ${name}`);
          await renderCard(stepCtx.resource, stepCtx.id);
        } catch (error) {
          toast(humanReadError(error, { failed: 'Passo non aggiornato. Riprova più tardi.' }), true);
          busy = false;
          check.setAttribute('aria-busy', 'false');
        }
      });
      row.appendChild(check);
      row.appendChild(el('span', undefined, name));
      box.appendChild(row);
    }
    return true;
  }

  function offer(box, profile, offerCtx, profileError = null, pipelines = []) {
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
    // Voce 1a066ddfe42a: uncomposed offer packages hide the whole block.
    // Voce 2f2d22f2: the card shows an offer only when there is one — a
    // readable-but-empty commercial page hides the whole block too, instead
    // of reading «Nessuna offerta firmata».
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : null;
    const opportunities = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : null;
    if (quotes === null && opportunities === null) return false;
    const fromQuote = (quotes ?? []).length > 0;
    const first = fromQuote ? quotes[0] : ((opportunities ?? [])[0] ?? null);
    if (!first) {
      // No linked offer: when BOTH commercial sections were readable (even
      // empty) the customer plainly has none, and the card stays hidden —
      // the scheda reads an offer only when one exists. An empty
      // opportunities read never proves there are no quotes when the quotes
      // read itself failed — the unavailable reason reads instead, never a
      // confirmed absence.
      if (quotes !== null && opportunities !== null) return false;
      box.appendChild(el('h4', undefined, 'Offerta'));
      // The unavailable reason stays in the API response and the logs, never
      // on screen: production reasons are English system phrases, and the
      // scheda reads only fixed Italian (voce 1a066ddf).
      box.appendChild(el('p', 'bo-muted', 'offerte non disponibili'));
      return true;
    }
    box.appendChild(el('h4', undefined, 'Offerta'));
    const rawName = fromQuote ? (first?.opportunityName ?? first?.name) : first?.name;
    const name = typeof rawName === 'string' && rawName !== '' ? rawName : 'offerta';
    // Backlog a551982c06eb: the state is the offer's stage, as the Pipeline
    // board and the offer detail say it (offerStageLabel). A quote's own
    // status is its approval («approvata» meant the price was cleared, not
    // the sale): it reads only for a quote with no readable opportunity,
    // and in full on #/quotes/<id>, where the line links.
    const offerStatus = shownOfferState(first, fromQuote, opportunities, pipelines);
    // Name and state read as one line for assistive tech and tests («nome · stato»); on screen the state is the prototype's pill.
    const line = el('p', 'bo-scheda-offer');
    line.appendChild(el('span', 'bo-scheda-offer-name', name));
    if (offerStatus) {
      line.appendChild(el('span', 'bo-scheda-sep', ' · '));
      line.appendChild(el('span', 'bo-scheda-offer-state', offerStatus));
    }
    // backlog:a2ea75f705fd: the offer line opens the offer page
    // (#/offerte/<opportunity id>) — stato, valore, preventivi e storia in
    // one place — for a quote row (its offer) and an offer row alike. Only
    // a quote that names no offer keeps its own detail (#/quotes/<id>).
    const offerId = fromQuote
      ? (typeof first?.opportunityId === 'string' && first.opportunityId !== '' ? first.opportunityId : null)
      : (typeof first?.id === 'string' && first.id !== '' ? first.id : null);
    const quoteOnly = offerId === null && fromQuote && typeof first?.id === 'string' && first.id !== '' ? first.id : null;
    const offerHref = offerId !== null
      ? `#/offerte/${encodeURIComponent(offerId)}`
      : (quoteOnly !== null ? `#/quotes/${encodeURIComponent(quoteOnly)}` : null);
    // Voce 59def6cb805d (C25): the prototype's big amount, read from the
    // server total the profile carries — never summed here. No figure (a
    // recurring quote, a record without a value, an empty draft) shows none.
    const amount = Number.isSafeInteger(first?.amountCents) && first.amountCents > 0
      && typeof first?.currency === 'string' && first.currency !== ''
      ? el('p', 'bo-scheda-offer-amount', formatAmount(first.amountCents, first.currency)) : null;
    if (offerHref === null) {
      box.appendChild(line);
      if (amount) box.appendChild(amount);
    } else {
      const link = el('a', 'bo-scheda-offer-link');
      link.setAttribute('href', offerHref);
      link.appendChild(line);
      if (amount) link.appendChild(amount);
      box.appendChild(link);
    }
    // Voce 714433c2: «Cambia stato» — the stato shown above changes from a
    // menu. The menu moves the shown opportunity through the governed
    // `request-opportunity-stage-change` workflow (POST
    // /api/opportunities/:id/stage), never a direct write: a renewal moving
    // to proposal past the approval threshold lands in «in attesa di
    // approvazione» with a toast saying so, like the pipeline board. The
    // menu acts on exactly the stato the line shows: since backlog
    // a551982c06eb that is the offer's stage even on a quote line, so the
    // menu acts on the quote's opportunity (the quote's own approval
    // changes from the quotes screen). A refused
    // move keeps the menu with the server's Italian error, and a completed
    // move re-reads the card so the line is the server's state, never an
    // optimistic copy. The header Cliente/Contatto pill stays derived (see
    // customer-status.js): this menu does not touch it.
    // Backlog 1e939a362c7c: every offer has the menu — a quote line acts on
    // its opportunity, a placed offer moves through its pipeline (see
    // offerStageMenu).
    const stageMenu = offerCtx && typeof offerCtx.resource === 'string' && typeof offerCtx.id === 'string'
      ? offerStageMenu(first, fromQuote, opportunities, pipelines) : null;
    if (stageMenu) {
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
      const stageStatus = el('small', 'bo-muted', '');
      stageStatus.setAttribute('role', 'status');
      let stageBusy = false;
      const failed = 'Stato non aggiornato. Riprova più tardi.';
      /** One move: the pipeline's move-stage action or the governed core workflow. */
      const move = async (voice, reason = null) => {
        if (stageBusy) return;
        stageBusy = true;
        stageError.textContent = '';
        stageStatus.textContent = '';
        try {
          if (stageMenu.kind === 'pipeline') {
            const input = { toStage: voice.key, fromStage: stageMenu.current };
            if (reason) input.reason = reason;
            await client.request(
              `/api/modules/${encodeURIComponent(stageMenu.pipeline.module)}/records/${encodeURIComponent(stageMenu.id)}/actions/move-stage`,
              { method: 'POST', body: JSON.stringify(input) },
            );
            close();
            // backlog:2a214b66fe12: the pill moves the moment the toast
            // says so; then only card and profile are read again.
            historyReads.delete(stageMenu.id);
            const refreshed = refreshParts(offerCtx.resource, offerCtx.id, ['card', 'profile'],
              (loaded) => withOfferStage(loaded, stageMenu.id, 'pipeline', voice.key));
            toast(`Spostata in ${voice.label}.`);
            await refreshed;
          } else {
            const result = await client.request(
              `/api/opportunities/${encodeURIComponent(stageMenu.id)}/stage`,
              { method: 'POST', body: JSON.stringify({ targetStage: voice.key }) },
            );
            close();
            // The stage route returns the workflow envelope
            // { runId, status, output }: the approval gate reads in
            // output.outcome, never in a top-level outcome. A move waiting
            // for approval did not happen yet: nothing moves on screen.
            const waiting = result?.output?.outcome === 'approval_required';
            historyReads.delete(stageMenu.id);
            const refreshed = refreshParts(offerCtx.resource, offerCtx.id, ['card', 'profile'],
              waiting ? null : (loaded) => withOfferStage(loaded, stageMenu.id, 'core', voice.key));
            toast(waiting
              ? 'Stato aggiornato: serve un\u2019approvazione'
              : 'Stato aggiornato');
            await refreshed;
          }
        } catch (error) {
          // Review #683: a move the server still holds (the pilot queue) is
          // not a failure — it reads neutral, like «Non ancora confermato»
          // on the board, never as an error.
          if (error?.code === 'BO_CRM_PENDING') {
            close();
            const pending = 'Non ancora confermato: ricarica la scheda tra poco.';
            stageStatus.textContent = pending;
            toast(pending);
            return;
          }
          const text = humanReadError(error, { failed });
          stageError.textContent = text;
          toast(text, true);
        } finally {
          stageBusy = false;
        }
      };
      // A pipeline won/lost stage asks the board's own Conferma (shared
      // component, never a native confirm()): the question names the offer,
      // a lost stage needs the reason, and only Conferma posts.
      const confirmPanel = createStageConfirm(doc);
      let confirmVoice = null;
      const offerName = name;
      confirmPanel.yes.addEventListener('click', () => {
        if (!confirmVoice) return;
        const answer = readStageConfirm(confirmPanel, confirmVoice);
        if (!answer.ok) return;
        void uiBusy(confirmPanel.yes, 'Sposto…', () => move(confirmVoice, answer.reason ?? null));
      });
      confirmPanel.no.addEventListener('click', () => {
        confirmVoice = null;
        confirmPanel.box.setAttribute('class', 'card-confirm hidden');
      });
      for (const voiceDef of stageMenu.voices) {
        const voice = el('button', undefined, voiceDef.label);
        voice.setAttribute('type', 'button');
        voice.setAttribute('role', 'menuitem');
        voice.setAttribute('data-stage', voiceDef.key);
        voice.addEventListener('click', () => {
          if (stageMenu.kind === 'pipeline' && stageNeedsConfirm(voiceDef)) {
            confirmVoice = voiceDef;
            close();
            showStageConfirm(confirmPanel, offerName, voiceDef);
            return;
          }
          void uiBusy(voice, 'Sposto…', () => move(voiceDef));
        });
        menu.appendChild(voice);
      }
      wrap.appendChild(button);
      wrap.appendChild(menu);
      wrap.appendChild(confirmPanel.box);
      wrap.appendChild(stageStatus);
      wrap.appendChild(stageError);
      box.appendChild(wrap);
    }
    paintStateHistory(box, historyTarget(first, fromQuote), profile, pipelines);
    return true;
  }

  /**
   * Backlog c1649d1d: «Storia stati» — the state moves of the shown offer
   * (who, from which stage to which, when), read from the same audit trail
   * the offer detail paints. The trail is decoration: it fills after the
   * card, an unreadable trail reads one honest line (and logs its cause,
   * never its payload), and an offer with no move yet reads none. A move
   * whose side has no label reads the generic Italian line, like the
   * detail — never a raw key, and never a false-empty history when the
   * pipelines are unavailable.
   */

  /** Log a decoration-read failure with its cause, never its payload. */
  function logHistoryFailure(error, area = 'scheda-stati') {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[bo] offerta non leggibile', {
        area,
        code: error?.code ?? null,
        name: typeof error?.name === 'string' ? error.name : null,
        spaceId: activeSpaceId(),
        status: Number(error?.status ?? 0) || null,
      });
    }
  }
  function historyTarget(first, fromQuote) {
    if (!first || typeof first !== 'object') return null;
    if (fromQuote) {
      return typeof first.opportunityId === 'string' && first.opportunityId !== '' ? first.opportunityId : null;
    }
    return typeof first.id === 'string' && first.id !== '' ? first.id : null;
  }

  function paintStateHistory(box, targetId, profile, pipelines) {
    if (typeof targetId !== 'string' || targetId === '') return;
    const owner = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items.find((candidate) => candidate?.id === targetId)?.owner ?? null
      : null;
    const companyName = typeof profile?.identity?.company?.name === 'string'
      && profile.identity.company.name !== '' ? profile.identity.company.name : null;
    box.appendChild(el('p', 'bo-scheda-offer-history-title', 'Storia stati'));
    const loading = el('p', 'bo-muted', 'Caricamento…');
    box.appendChild(loading);
    const fill = (items, people = []) => {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      const rows = [];
      for (const entry of Array.isArray(items) ? items : []) {
        const move = stageMoveOf(entry);
        if (move === null) continue;
        const words = stageMoveLabels(pipelines, move);
        const who = auditActorLabel(entry, [owner, companyName], people);
        const when = italianDateTime(entry?.createdAt) ?? '—';
        if (words === null) {
          // Review giro 1 (P2): the audit holds a move but no side has a
          // label (pipelines unavailable, unknown keys). Like the detail,
          // the row reads the generic Italian line — never a raw key, and
          // never a false «no moves» message for moves that exist.
          // Backlog 169cd4bc988c: one word for every move, like the offer page.
          rows.push(`Cambio di stato · da ${who} · ${when}`);
        } else {
          rows.push(`da ${words.from} a ${words.to} · da ${who} · ${when}`);
        }
        if (rows.length >= 5) break;
      }
      if (rows.length === 0) {
        box.appendChild(el('p', 'bo-muted', 'Ancora nessun cambio di stato.'));
        return;
      }
      for (const text of rows) {
        box.appendChild(el('p', 'bo-scheda-offer-history', text));
      }
    };
    // backlog:e52c5e0dd49f (review Muse #750 giro 2, famiglia F5): the team
    // roster names the actors, like the offer detail — a team subject reads
    // its profile name, never «utente». A roster read that fails logs its
    // sanitized cause (P1 on this PR: an unavailable roster must stay
    // distinguishable from an empty one) and leaves the record names only,
    // never a new failure line.
    const historyRead = readHistory(targetId);
    void historyRead.then(
      ({ items, people }) => fill(items, people),
      (error) => {
        // Review giro 1 (P2): the rejection cause reaches on-call, like the
        // detail does — area, code, name, space and status only, never
        // payload or PII.
        if (!loggedHistoryFailures.has(historyRead)) {
          loggedHistoryFailures.add(historyRead);
          logHistoryFailure(error);
        }
        if (loading.parentNode) loading.textContent = 'Storia stati non leggibile.';
      },
    );
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
    // Voce 59def6cb805d (C26): the prototype card — a title, then
    // `<giorno> · <orari>`. The title is the booked service (its listino key
    // made readable) with the team member when the handle reads as a name;
    // the row names the long Rome day. No place and no Google sync line:
    // the booking records neither, so none is written.
    const service = serviceTitle(next?.serviceKey);
    const member = teamName(next?.teamMemberId);
    box.appendChild(el('p', 'bo-scheda-appt-title', member ? `${service} · con ${member}` : service));
    const day = dayParts(next?.startsAt);
    const startTime = timeParts(next?.startsAt);
    const hours = endTime && endTime !== startTime ? `${startTime}–${endTime}` : startTime;
    const when = day && sameDay
      ? `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${hours}`
      : (endTime && endTime !== startTime ? `${start} – ${dateTimeParts(next?.endsAt)}` : start);
    box.appendChild(el('p', 'bo-scheda-appt', when));
  }

  /**
   * backlog:5346ab531538 — the cancelled appointments of the customer as
   * cronologia rows: «Appuntamento annullato · Lezione prova · 10 nov
   * 10:00», at the instant of the cancellation (the slot's start when the
   * row records none), with the reason the operator gave. Never an id.
   * @param {any} timeline
   */
  function cancelledAppointmentEntries(timeline) {
    const items = Array.isArray(timeline?.appointments?.items) ? timeline.appointments.items : [];
    return items
      .filter((item) => String(item?.status ?? '') === 'cancelled')
      .map((item) => {
        const slot = [shortDayParts(item?.startsAt), timeParts(item?.startsAt)].filter(Boolean).join(' ');
        const reason = typeof item?.cancelReason === 'string' ? readableText(item.cancelReason) : '';
        return {
          id: `appointment-cancelled:${String(item?.id ?? '')}`,
          entry: 'appointment-cancelled',
          occurredAt: typeof item?.decidedAt === 'string' && item.decidedAt !== '' ? item.decidedAt : item?.startsAt,
          title: ['Appuntamento annullato', serviceTitle(item?.serviceKey), slot].filter(Boolean).join(' · '),
          reason: reason !== '' ? reason : null,
        };
      });
  }

  /** A listino key made readable («lezione-prova» → «Lezione prova»), never the raw slug. */
  function serviceTitle(serviceKey) {
    const words = typeof serviceKey === 'string' ? serviceKey.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return words === '' ? 'Appuntamento' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
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

  function callsBox(box, calls, timeline = null) {
    // BO-F1-08, ref "05 Scheda cliente": signals (budget/tempi/interesse/
    // dubbi) with their transcript source, and the openable transcript.
    box.appendChild(el('h4', undefined, 'Chiamate'));
    const items = Array.isArray(calls?.calls) ? calls.calls : [];
    // backlog:619b477c0464: one source for the calls. A call the cronologia
    // shows (a missed one has no recording) is a call here too — never
    // «nessuna chiamata» beside «chiamata in entrata · persa».
    const logged = items.length === 0 && Array.isArray(timeline?.entries?.items)
      ? timeline.entries.items.filter((entry) => entry?.entry === 'call')
      : [];
    if (logged.length > 0) {
      const [last, ...before] = logged;
      const when = dateParts(last?.occurredAt);
      const direction = last?.direction === 'outbound' ? 'in uscita' : last?.direction === 'inbound' ? 'in entrata' : null;
      const outcome = typeof last?.sync === 'string' && last.sync !== '' ? syncLabel(last.sync).toLowerCase() : null;
      box.appendChild(el('p', 'bo-scheda-call-head',
        ['ultima chiamata', direction, when, outcome].filter(Boolean).join(' · ')));
      box.appendChild(el('p', 'bo-muted', 'nessuna registrazione per questa chiamata'));
      if (before.length > 0) box.appendChild(el('p', 'bo-muted', `+ ${before.length} chiamate precedenti`));
      return;
    }
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
      box.appendChild(el('p', 'bo-muted', `+ ${plural(older.length, 'chiamata precedente', 'chiamate precedenti')}`));
    }
  }

  // Voce 908f2eb9bbfb: a section that fails shows its own error and leaves
  // the rest of the scheda. Only the card read failing fails the whole
  // scheda — it carries the name, and without a name there is no card.
  const readError = (box, error, failed) => {
    box.appendChild(el('p', 'field-error', humanReadError(error, { failed })));
  };

  /**
   * Puts the new scheda on screen in one step. A re-read of the scheda already
   * shown (after Invia, a note, an edit) keeps the old one up while it loads
   * and swaps in the same tick: no blank flash, the page and the side columns
   * keep their scroll, the conversation keeps its filter and its open pages.
   */
  function show(node, key, sides = []) {
    const page = doc.scrollingElement ?? null;
    const pageTop = key === shownKey && page ? page.scrollTop : null;
    const sideTops = key === shownKey ? shownSides.map((side) => side.scrollTop ?? 0) : [];
    // Review #612 round 2: the windows that hang off the view (Scrivi, the
    // offer panel) stay open through a re-read of the same customer, with
    // their text and focus; only the scheda itself is swapped.
    const isWindow = (child) => typeof child?.getAttribute === 'function'
      && ['data-composer', 'data-offer-panel', 'data-appointment-panel', 'data-phone']
        .some((attr) => child.getAttribute(attr) === 'open');
    const kept = key !== null && key === shownKey ? Array.from(mount.childNodes ?? []).filter(isWindow) : [];
    for (const child of Array.from(mount.childNodes ?? [])) {
      if (!kept.includes(child)) mount.removeChild(child);
    }
    if (kept.length > 0 && typeof mount.insertBefore === 'function') mount.insertBefore(node, kept[0]);
    else mount.appendChild(node);
    sides.forEach((side, index) => {
      if (sideTops[index]) side.scrollTop = sideTops[index];
    });
    if (pageTop !== null && page.scrollTop !== pageTop) page.scrollTop = pageTop;
    shownKey = key;
    shownSides = sides;
  }

  // Two renders racing (a route plus a re-read after a save) must not both
  // land: only the newest paints, so the scheda never holds two Dettagli
  // forms whose Salva would both write.
  let cardRenderToken = 0;
  /** A first read of a customer paints its sections as they land (backlog:1a96094db71d). */
  let progressive = false;

  async function renderCard(resource, id) {
    const key = `${resource}/${id}`;
    const renderToken = ++cardRenderToken;
    // A section re-read that starts while this full read is in flight is
    // newer for its part: the full answer never paints over it.
    // Review #787 (P2): a section re-read already in flight is older than
    // this full read: it never paints over it.
    for (const part of Object.keys(partSeq)) partSeq[part] += 1;
    const startSeq = { ...partSeq };
    historyReads.clear();
    rosterRead = null;
    if (key !== shownKey) {
      // Another customer: clear at once, never leave the previous one up.
      // Backlog 608aa14d554c: the clear also removed the router's loading
      // line, so a direct link stayed blank for the whole read (5.8 s on
      // production). backlog:1a96094db71d: a loading line alone still left
      // 5-12 s of nothing to read — the scheda's structure shows at once
      // (paintPartial below) and each section fills as its own read lands.
      while (mount.firstChild) mount.removeChild(mount.firstChild);
      shownKey = null;
      progressive = true;
      shownSides = [];
      retainedDrafts = null;
      channelFilter = 'all';
      noteAuthorFilter = null;
      timelineShown = TIMELINE_PAGE;
      // Voce 2f2d22f2 review #722: the router repaints «Clienti» on entry,
      // so the dedup must forget the previous name — a different customer
      // with the same name re-narrows the crumb instead of staying silent.
      resetTitle();
    }
    const firstVisit = progressive;
    progressive = false;
    if (firstVisit) heldFailures = { token: renderToken, drops: [] };
    try {
      await finishRender(key, resource, id, renderToken, startSeq, firstVisit);
    } finally {
      releaseHeldFailures(renderToken);
    }
  }

  /**
   * The reads of renderCard and the paint of what they answered.
   * @param {string} key @param {string} resource @param {string} id
   * @param {number} renderToken @param {Record<string, number>} startSeq
   * @param {boolean} firstVisit
   */
  async function finishRender(key, resource, id, renderToken, startSeq, firstVisit) {
    // Voce 908f2eb9bbfb, review round 2: the load itself must never throw
    // out of here — a synchronous throw (a throwing spaceId thunk, a hostile
    // id) used to blank the scheda with neither the card nor the error panel.
    let loaded;
    // A partial paint is a courtesy: if it ever throws, the scheda waits for
    // the full answer like before instead of failing the read.
    let partials = firstVisit;
    const partialPaint = (partial, pending) => {
      if (!partials || renderToken !== cardRenderToken || pending.size === 0) return;
      try {
        paintPartial(key, resource, id, partial, pending);
      } catch (error) {
        // Review Muse #835 (P2): the cause reaches on-call — name, code and
        // the space only, never a value — so a stalled progressive load is
        // never mistaken for slow reads.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] scheda parziale non disegnata', {
            area: 'scheda-parziale',
            code: /** @type {any} */ (error)?.code ?? null,
            name: typeof /** @type {any} */ (error)?.name === 'string' ? /** @type {any} */ (error).name : null,
            spaceId: activeSpaceId(),
          });
        }
        partials = false;
      }
    };
    partialPaint(null, PART_NAMES_PENDING());
    try {
      loaded = await load(resource, id, firstVisit ? partialPaint : null);
    } catch (error) {
      loaded = { card: null, cardError: error };
    }
    // A newer render started while this one loaded: it owns the screen.
    if (renderToken !== cardRenderToken) return;
    if (loaded.cardError) {
      emitTitle(null);
      const panel = el('div', 'bo-scheda-error');
      panel.appendChild(el('h3', undefined, 'Scheda non disponibile'));
      panel.appendChild(el('p', 'bo-muted', humanReadError(loaded.cardError, {
        failed: 'La scheda non si è potuta leggere. Riprova più tardi.',
      })));
      // Review #612 round 3: a failed re-read of the scheda already shown
      // keeps its windows (a half-written Scrivi), filter, pages and scroll;
      // only a first read that fails starts from nothing.
      if (key === shownKey) retainedDrafts = readDrafts(mount) ?? retainedDrafts;
      show(panel, key === shownKey ? key : null);
      return;
    }
    if (lastShown !== null && lastShown.key === key) {
      for (const part of Object.keys(partSeq)) {
        if (partSeq[part] !== startSeq[part]) {
          loaded = { ...loaded, [part]: lastShown.loaded[part], [`${part}Error`]: lastShown.loaded[`${part}Error`] };
        }
      }
    }
    lastShown = { key, resource, id, loaded };
    paint(key, resource, id, loaded);
    markRead(resource, id, loaded.timeline);
  }

  /**
   * C13: the re-read behind `Aggiorna` — the same enriched route the load
   * uses, with the same honest 404. Anything else still rejects, so the
   * button toasts the Italian retry instead of inventing rows.
   * @param {string} key @param {string} resource @param {string} id
   */
  function enrichmentReloader(key, resource, id) {
    const enrichedPath = `/api/customer-data/enriched/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    return () => client.request(enrichedPath).catch((error) => {
      if (error && error.status === 404) return null;
      throw error;
    }).then((fresh) => {
      // Review #787 (P2): what Aggiorna read is what the scheda now shows —
      // a later repaint after a write keeps it, never the older copy.
      if (lastShown !== null && lastShown.key === key) {
        lastShown = { ...lastShown, loaded: { ...lastShown.loaded, enrichment: fresh, enrichmentError: null } };
      }
      return fresh;
    });
  }

  /**
   * Builds the scheda from what was read (renderCard) or from what the
   * scheda already shows plus one write (refreshParts): the typing in
   * progress, the open windows, the filters and the scroll stay.
   */
  function paint(key, resource, id, loaded) {
    void readRoster();
    const {
      card, timeline, timelineError, profile, profileError,
      enrichment, enrichmentError, calls, callsError,
      fieldDefs, fieldDefsError, fieldValues, fieldValuesError, pipelines,
    } = loaded;
    const reloadEnrichment = enrichmentReloader(key, resource, id);
    pendingDrafts = key === shownKey ? readDrafts(mount) : null;
    if (key === shownKey && retainedDrafts !== null) {
      pendingDrafts = { ...retainedDrafts, ...(pendingDrafts ?? {}) };
    }
    retainedDrafts = null;
    emitTitle(card?.name ?? null);
    try {
      buildAndShow(key, resource, id, {
        card, timeline, timelineError, profile, profileError,
        enrichment, enrichmentError, calls, callsError,
        fieldDefs, fieldDefsError, fieldValues, fieldValuesError, reloadEnrichment, pipelines,
      });
    } finally {
      pendingDrafts = null;
    }
  }

  /** The «Storia stati» reads by offer id, shared by the repaints of one read. @type {Map<string, Promise<any>>} */
  const historyReads = new Map();
  /**
   * The offer's stage history with the roster that names its actors —
   * «Storia stati» and the cronologia share one read (backlog:2a214b66fe12:
   * a repaint after a note or a Dettagli save reuses it; a full re-read or a
   * stage move reads it again).
   * @param {string} targetId
   */
  function readHistory(targetId) {
    let read = historyReads.get(targetId);
    if (read === undefined) {
      const auditPath = `/api/audit?entityType=opportunity&entityId=${encodeURIComponent(targetId)}&limit=100`;
      read = readRoster().then((people) => client.request(auditPath).then((answer) => ({ items: answer?.items, people })));
      historyReads.set(targetId, read);
      // A failed read is not kept: the next paint asks again (after the
      // sections of a first read have landed, backlog:1a96094db71d).
      read.catch(() => holdOrDrop(() => { if (historyReads.get(targetId) === read) historyReads.delete(targetId); }));
    }
    return read;
  }

  /**
   * backlog:82235e46e3e9: the space roster names who wrote a note or a
   * message — a provider id (`google|…`) reads its person's name, never
   * «dal team». Read once per full read of the scheda and shared with
   * «Storia stati»; when it answers, the scheda repaints from what it shows.
   * @type {Promise<Array<any>> | null}
   */
  let rosterRead = null;
  /**
   * backlog:1a96094db71d: while a first read paints its sections as they
   * land, a failed roster or «Storia stati» read stays failed until the
   * last part is in — the partial paints never ask (and log) it again.
   * @type {{ token: number, drops: Array<() => void> } | null}
   */
  let heldFailures = null;
  /** @param {() => void} drop */
  function holdOrDrop(drop) {
    if (heldFailures === null) drop();
    else heldFailures.drops.push(drop);
  }
  /** @param {number} token */
  function releaseHeldFailures(token) {
    if (heldFailures === null || heldFailures.token !== token) return;
    const { drops } = heldFailures;
    heldFailures = null;
    for (const drop of drops) drop();
  }
  /** Each failed «Storia stati» read is logged once, however many paints show it. */
  const loggedHistoryFailures = new WeakSet();
  /** A note being saved, view-wide (review #793): one POST per note. */
  let noteSaving = false;
  /** @type {Array<any> | null} */
  let rosterPeople = null;
  function readRoster() {
    if (rosterRead === null) {
      const read = client.request('/api/spine/memberships').then(
        (team) => teamPeople(Array.isArray(team?.items) ? team.items : []),
        (error) => {
          logHistoryFailure(error, 'scheda-stati-roster');
          holdOrDrop(() => { if (rosterRead === read) rosterRead = null; });
          return [];
        },
      );
      rosterRead = read;
      void read.then((people) => {
        if (rosterRead !== read || people.length === 0) return;
        const first = rosterPeople === null;
        rosterPeople = people;
        // Names arrive after the first paint: paint once more, no read.
        if (first && lastShown !== null && lastShown.key === shownKey) {
          paint(lastShown.key, lastShown.resource, lastShown.id, lastShown.loaded);
        }
      });
    }
    return rosterRead;
  }
  /** The roster name of a team subject, or null. @param {string} id */
  function rosterName(id) {
    // The same person lookup as «Storia stati» (subject or person key).
    const person = rosterPeople === null ? null : personOf(id, rosterPeople);
    return person !== null && typeof person.name === 'string' && person.name.trim() !== '' ? person.label : null;
  }
  /** Who wrote a note or a message: the roster name, else the readable handle, else null. @param {unknown} id */
  function writerName(id) {
    if (typeof id !== 'string' || id.trim() === '') return null;
    return rosterName(id.trim()) ?? teamName(id);
  }

  /**
   * backlog:1a96094db71d — the scheda while its reads land: the structure
   * at once (header, the three columns, every section card with grey bars),
   * then each section the moment its own read is back. A card read that
   * fails waits for the end, where the error panel takes the screen as
   * before; a section never shows a value it has not read.
   * @param {string} key @param {string} resource @param {string} id
   * @param {any} partial what has landed, or null for nothing yet
   * @param {Set<string> | null} pending the reads still in flight, null for all
   */
  function paintPartial(key, resource, id, partial, pending) {
    const waiting = pending ?? PART_NAMES_PENDING();
    if (partial?.cardError) return;
    if (partial?.card) emitTitle(partial.card.name ?? null);
    pendingDrafts = key === shownKey ? readDrafts(mount) : null;
    try {
      buildAndShow(key, resource, id, {
        ...(partial ?? {}),
        reloadEnrichment: enrichmentReloader(key, resource, id),
        pipelines: partial?.pipelines ?? [],
        pending: waiting,
      });
    } finally {
      pendingDrafts = null;
    }
  }

  /** A section card still waiting for its read: its title and grey bars. @param {any} box @param {string} title */
  function skeletonSection(box, title) {
    box.setAttribute('aria-busy', 'true');
    box.setAttribute('data-loading', 'true');
    box.appendChild(el('h4', undefined, title));
    for (const width of ['80%', '62%', '70%']) box.appendChild(uiSkeleton(doc, { width, block: true }));
    return true;
  }

  /** What the scheda on screen was built from (backlog:2a214b66fe12). */
  /** @type {{key: string, resource: string, id: string, loaded: any} | null} */
  let lastShown = null;
  /** One counter per part: only the newest re-read of a part paints. */
  const partSeq = { card: 0, timeline: 0, profile: 0 };

  /**
   * backlog:2a214b66fe12 — after a write the scheda changes at once and
   * re-reads only what the write touched. `patch` applies the write to what
   * is on screen (the same moment the toast says it), then the named parts
   * are read again — one or two reads instead of the eight of a full
   * re-read — and the server's answer replaces the local copy. A failed
   * re-read keeps the screen as it is: the write itself went through. With
   * nothing on screen for this customer it falls back to the full re-read.
   * @param {string} resource @param {string} id
   * @param {Array<'card' | 'timeline' | 'profile'>} parts
   * @param {((loaded: any) => any) | null} [patch]
   */
  async function refreshParts(resource, id, parts, patch = null) {
    const key = `${resource}/${id}`;
    if (lastShown === null || lastShown.key !== key || shownKey !== key) {
      await renderCard(resource, id);
      return;
    }
    if (typeof patch === 'function') {
      lastShown = { ...lastShown, loaded: patch(lastShown.loaded) };
      paint(key, resource, id, lastShown.loaded);
    }
    const asked = parts.map((part) => ({ part, seq: ++partSeq[part] }));
    const encoded = `${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const answers = await Promise.all(asked.map(({ part }) => PART_READS[part](encoded)));
    if (lastShown === null || lastShown.key !== key || shownKey !== key) return;
    let loaded = lastShown.loaded;
    let changed = false;
    asked.forEach(({ part, seq }, index) => {
      if (seq !== partSeq[part]) return;
      const answer = part === 'card' ? answers[index] : nullOn404(answers[index]);
      if (answer.error) {
        // Review #787 (P2): the write went through, the screen keeps it;
        // the failed re-read is logged with its cause, never its payload.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          const error = answer.error;
          console.error('[bo] scheda non riletta', {
            area: `scheda-${part}`,
            code: error?.code ?? null,
            name: typeof error?.name === 'string' ? error.name : null,
            spaceId: activeSpaceId(),
            status: Number(error?.status ?? 0) || null,
          });
        }
        return;
      }
      loaded = { ...loaded, [part]: answer.value, [`${part}Error`]: null };
      changed = true;
    });
    if (!changed) return;
    lastShown = { ...lastShown, loaded };
    paint(key, resource, id, loaded);
  }

  /** The scheda again from what it shows, with no read (Annulla of a form). */
  function repaintShown(resource, id) {
    const key = `${resource}/${id}`;
    if (lastShown === null || lastShown.key !== key || shownKey !== key) return renderCard(resource, id);
    paint(key, resource, id, lastShown.loaded);
    return Promise.resolve();
  }

  function buildAndShow(key, resource, id, {
    card, timeline, timelineError, profile, profileError,
    enrichment, enrichmentError, calls, callsError,
    fieldDefs, fieldDefsError, fieldValues, fieldValuesError, reloadEnrichment, pipelines,
    pending = null,
  }) {
    const panel = el('div', 'bo-scheda');
    if (pending !== null && pending.size > 0) {
      panel.setAttribute('aria-busy', 'true');
      panel.setAttribute('data-loading', 'true');
    }
    // backlog:1a96094db71d: a part still in flight paints its section as a
    // skeleton (the same card, its title, grey bars), never an empty claim.
    const waits = (...parts) => pending !== null && parts.some((part) => pending.has(part));
    if (waits('card')) {
      const head = el('div', 'bo-scheda-head');
      head.setAttribute('data-loading', 'true');
      head.setAttribute('aria-busy', 'true');
      head.appendChild(uiSkeleton(doc, { width: '40%', block: true }));
      head.appendChild(uiSkeleton(doc, { width: '22%', block: true }));
      panel.appendChild(head);
    } else {
      header(panel, card, resource, id);
    }
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
    const skeleton = (col, cls, title) => section(col, cls, skeletonSection, title);
    if (waits('card', 'profile', 'timeline')) skeleton(left, '', 'Azioni rapide');
    else {
      section(left, '', quickActions, card, {
        resource, id, contactCompanyId: profile?.identity?.contact?.companyId ?? null,
      }, { numbers: schedaNumbers(card, profile, timeline) });
    }
    if (waits('profile', 'timeline')) skeleton(left, '', 'Identità collegate');
    else section(left, '', linkedIdentities, profile, timeline, profileError, timelineError);
    if (waits('card', 'profile')) skeleton(left, '', 'Dettagli');
    else section(left, '', details, card, profile, { resource, id }, profileError);
    // Custom fields (backlog:434cc39a): a failed defs/values read hides the
    // section, never the scheda — like enrichment above.
    if (waits('fieldDefs', 'fieldValues')) {
      // No skeleton: the section may well hide itself once read.
    } else if (!fieldDefsError && !fieldValuesError) {
      section(left, '', customFields, { defs: fieldDefs, values: fieldValues, resource, id });
    }
    if (waits('enrichment')) skeleton(left, '', "Arricchito dall'AI");
    else section(left, '', enriched, enrichment, reloadEnrichment, enrichmentError);
    // Voce 908f2eb9bbfb (AC-3): the cronologia paints from the timeline read
    // alone — timelineBox only takes optional extras from the profile
    // (company name, offers, quotes, all null-safe), so a slow profile never
    // holds the entries hostage.
    if (waits('timeline')) {
      skeleton(center, 'bo-scheda-card-timeline', 'Tutti i contatti');
    } else if (timelineError) {
      section(center, 'bo-scheda-card-timeline', (box) => {
        box.appendChild(el('h4', undefined, 'Tutti i contatti'));
        readError(box, timelineError, 'La cronologia non si è potuta leggere. Riprova più tardi.');
      });
    } else {
      section(center, 'bo-scheda-card-timeline', timelineBox, timeline, { resource, id }, profile, pipelines);
    }
    if (waits('calls')) {
      skeleton(right, 'bo-scheda-ai', '✦ Riepilogo AI');
      skeleton(right, '', 'Chiamate');
    } else if (callsError) {
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
      section(right, '', callsBox, calls, timeline);
    }
    if (waits('profile')) skeleton(right, '', 'Prossimi passi');
    else section(right, '', nextSteps, profile, profileError, { resource, id });
    if (waits('profile', 'pipelines')) skeleton(right, 'bo-scheda-card-offer', 'Offerta');
    else section(right, 'bo-scheda-card-offer', offer, profile, { resource, id }, profileError, pipelines);
    if (waits('timeline')) skeleton(right, 'bo-scheda-card-appt', 'Prossimo appuntamento');
    else section(right, 'bo-scheda-card-appt', nextAppointment, timeline, timelineError);
    grid.appendChild(left);
    grid.appendChild(center);
    grid.appendChild(right);
    panel.appendChild(grid);
    show(panel, key, [left, right]);
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

  /**
   * Drops a pending card read (voce 2f2d22f2, review #722): the card reads
   * before its first paint, so a late response must not repaint a screen
   * the operator already left — and must not retitle its breadcrumb either.
   * The shell calls this on every route that is not the card; the render
   * token already covers overlapping card reads, never navigation. Leaving
   * also forgets the narrowed name: on re-entry the router repaints plain
   * «Clienti» and the fresh read narrows it again instead of staying silent
   * behind the once-per-name dedup.
   */
  function invalidate() {
    cardRenderToken += 1;
    resetTitle();
  }

  return { renderCard, invalidate };
}
