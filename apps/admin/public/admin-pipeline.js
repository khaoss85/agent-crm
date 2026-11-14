// @ts-check

// Pipeline board (ADR-014) for BO-F2-01, restyled to the BO-F6-10 prototype
// (specs/pipeline.md, fetta 1: intestazione e riepilogo). Rendered entirely
// from /api/schema `pipelines` metadata plus the target module's list
// endpoint — no per-pipeline code. Page chrome follows the spec's fixed
// Italian texts (`Pipeline` / `Offerte`); stage labels, counts and totals
// stay data-driven. Every value is inserted through textContent/setAttribute,
// never innerHTML, so hostile stage labels or record names are inert text.
//
// Views: Kanban columns plus a Lista table over the same filtered records.
// Search plus the Referente, Creata and Stati pills filter both views
// client-side; "Azzera filtri" resets them. Apri opens the offer panel over
// the board (Dan 11/11) — the card never expands in place. The
// summary (count + per-currency totals) and the forecast always describe the
// filtered set. The forecast is a declared heuristic — won and paid at face
// value plus 60% of the open ones — labeled as a stima, never a commitment.
//
// C4/C5 forecast: `✦ Previsione di <mese>` over the filtered set — won and
// paid record values at face value plus 60% of the open ones, per currency
// (currencies are never summed). The risk line names the owner or customer of
// the highest-value open offer. A stima, never a commitment.
// Cards move through the same server `move-stage` action as the Move button,
// including drag-and-drop onto a column: the drop posts { toStage, fromStage }
// with the actor audited server-side (the action runtime records it). A move
// to a won or lost stage — from Sposta or a drop — never posts straight:
// it reveals the card's Conferma panel (Persa adds the mandatory reason
// input) and only Conferma posts. The Lista rows are read-only; moves
// happen on Kanban cards. Apri opens a side panel over the board (the
// composer window of the scheda): offer, customer, value, stage, Cambia
// fase and the links to the scheda cliente and the full offer page
// (#/offerte/<id>, where importo, chiusura and referente are edited through
// PATCH). Closing it (×, Esc, a click outside) never re-renders the board,
// so the scroll stays where it was.
//
// Drag placeholder (Dan 11/11): while a card flies, the column under the
// pointer shows a dashed slot as tall as the card, at the top — where the
// card really lands: the list reads `updated_at desc` and a move bumps it.
// There is no stored position yet, so the source column offers no slot (a
// reorder would not survive a reload). On drop the card moves into the slot
// at once and waits there (aria-busy); a failure puts it back where it was
// with the reason. Esc or a release outside a column only fires dragend,
// which removes the slot: nothing moves.
//
// BO-F6-10 fetta Lista (backlog:31bed527): testi esatti C7/C16/C21, intestazioni
// C19 nell'ordine del prototipo, pill di stato con pallino e percentuale di
// probabilità C20, `Azzera filtri` solo a filtri attivi C11, ganci di stile
// `drop-target`/`dragging` per il trascinamento C18 (il tratteggio visivo è CSS).

import { formatAmount, humanReadError, italianDay, logWriteFailure, wakeWaitText } from './admin-core.js';
import { bindAdminMutations } from './admin-submission.js';
import { offerCustomer, offerStageLabel, personLabel, teamPeople, upperFirst } from './admin-labels.js';

const BOARD_LIMIT = 200;
const OFF_PIPELINE_LISTED = 50;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, class?: string, attrs?: Record<string, string>}} [options]
 */
import { el, uiAddOption, uiBusy, uiButton, uiIcon } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * backlog:48993bed7294 (review lead #896): the forecast's declared rule, the
 * same constants as packages/analytics/src/dashboard.js (this view ships as a
 * static file, so it names them instead of importing them).
 */
const FORECAST_MIN_DECIDED = 5;
const FORECAST_FALLBACK_RATE = 0.6;

/**
 * Italian month names for the `✦ Previsione di <mese>` title (C4). A static
 * list keeps the title deterministic without ICU locale data.
 */
const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

const ROME_DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * Rome calendar day (YYYY-MM-DD) of a stored day or instant, null when
 * absent/unparseable or an impossible day («2026-99-99», «2026-02-30»):
 * the same day the screen prints with italianDay (review #761), never the
 * UTC day. One rule with the sort key: it delegates to romeDayKey.
 * @param {unknown} value
 */
function romeDayOf(value) {
  return romeDayKey(value);
}

/**
 * Review #789: the sort key of a date column is the same Rome day the cell
 * shows (italianDay's rule: a bare YYYY-MM-DD is that day, an instant is its
 * day in Europe/Rome), as YYYY-MM-DD so it sorts as text. Null when absent.
 * @param {unknown} value
 */
export function romeDayKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const time = Date.parse(bareDay ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(time)) return null;
  const day = ROME_DAY_KEY.format(new Date(time));
  // A bare day must exist: V8 rolls «2026-02-30» over to 2 March, so the
  // day must read back unchanged (review #761 P1: fail closed).
  return bareDay && day !== value ? null : day;
}

/** Day (YYYY-MM-DD) of an ISO timestamp, or null when absent/unparseable. */
function dayOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * BO-F6-10 C8: whether a record created at `createdAt` falls in the last
 * `days` Rome calendar days: today and the `days - 1` days before it, on the
 * same Rome day the Creata column shows. Fail closed on an unreadable day.
 * @param {unknown} createdAt @param {number} days @param {Date} [now]
 */
export function createdWithin(createdAt, days, now = new Date()) {
  const day = romeDayOf(createdAt);
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? ROME_DAY_KEY.format(now) : null;
  if (!days || day === null || today === null) return false;
  const [year, month, date] = today.split('-').map(Number);
  const cutoff = new Date(Date.UTC(year, month - 1, date - days + 1)).toISOString().slice(0, 10);
  return day >= cutoff;
}

/**
 * Two-letter initials of the referente name for the card badge, like the
 * prototype (C15): the badge shows the initials, the accessible title the
 * full name. Same word rule as `initialsOf` in admin-clienti.js (first
 * letter of the first two lettered words, `·` when none), kept local like
 * the other views — no cross-view import for a presentation mark.
 */
function ownerInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.slice(0, 2).map((word) => (word.match(/\p{L}/u)?.[0] ?? '').toUpperCase()).join('') || '·';
}

/**
 * The customer an offer is for, as the scheda names it (backlog:fb47ab99b6ee):
 * the contact, else the company — never a placeholder company standing in
 * for a contact. Null when the offer names nobody.
 * @param {Record<string, any>} record
 */
export function customerOf(record) {
  const contact = typeof record?.contactName === 'string' ? record.contactName.trim() : '';
  if (contact !== '') return contact;
  const company = typeof record?.companyName === 'string' ? record.companyName.trim() : '';
  // «Senza azienda» is the scheda's placeholder company, not a customer —
  // in any case or spacing, the same normalization as the scheda's
  // shownCompanyName (NFC, collapsed spaces, lower case; review #789, #799).
  const placeholder = company.normalize('NFC').replace(/\s+/gu, ' ').toLowerCase() === 'senza azienda';
  return company !== '' && !placeholder ? company : null;
}

/**
 * @param {Record<string, any>} record
 * @param {{q: string, owner: string, stage: string, created: string}} filters
 */
function matchesFilters(record, filters) {
  if (filters.owner && record.owner !== filters.owner) return false;
  if (filters.stage && record.pipelineStage !== filters.stage) return false;
  if (filters.q) {
    const haystack = [record.name, record.companyName, record.contactName]
      .filter((part) => typeof part === 'string' && part)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) return false;
  }
  // BO-F6-10 C8: the `Creata` pill filters by creation recency. A record
  // without a parseable creation day never matches an active interval
  // (fail closed, like every other filter here); an unknown interval value
  // matches nothing rather than silently lifting the filter.
  if (filters.created) {
    const days = filters.created === '7d' ? 7 : filters.created === '30d' ? 30 : 0;
    if (!createdWithin(record.createdAt, days)) return false;
  }
  return true;
}

/**
 * `Creata` intervals (C8): the prototype filters by creation recency —
 * `Sempre`, then recent days. DECISION (to be confirmed): the recent
 * buckets are 7 and 30 days; the expected-close range inputs are gone
 * with the raw controls (no prototype shape for them).
 */
const CREATED_OPTIONS = [
  { value: '', label: 'Sempre' },
  { value: '7d', label: 'Ultimi 7 giorni' },
  { value: '30d', label: 'Ultimi 30 giorni' },
];

/** How long a stage move may stay in flight before the card says it is not confirmed yet. */
export const MOVE_PENDING_MS = 15000;
/** backlog:2f72000d4a4d: how long the «Annulla» toast stays at least (the shell pauses it under the pointer). */
export const UNDO_TOAST_MS = 10000;
/** backlog:3d811389bb4c: after this long a move still being written says so on its card. */
export const MOVE_SLOW_MS = 3000;
/** d3910a25dbc0: the pause before the single retry of a write that met another one. */
export const MOVE_RETRY_MS = 250;
const MOVE_SLOW = 'Ancora un momento: il salvataggio è lento.';
/** backlog:fd0adcded1c3: the same signal for a board read past MOVE_SLOW_MS. */
const LOAD_SLOW = 'Ancora un momento: il caricamento è lento.';

/**
 * 67a3116f4f65 (pilot #562): the place code of a move-stage receipt when the
 * stage was saved but the place was not — 'refused' or 'unavailable' — else
 * null. The pilot answers { saved: { …row, placement }, spaceId }, which
 * the /bo write client unwraps to the row (unwrapBoWriteAnswer); both shapes
 * are read. The core's own move-stage writes stage and place together and
 * carries no such code.
 * @param {unknown} answer
 */
export function placementNotSaved(answer) {
  const record = answer !== null && typeof answer === 'object' ? /** @type {any} */ (answer) : {};
  const row = record.saved !== null && typeof record.saved === 'object' ? record.saved : record;
  const code = row?.placement;
  return code === 'refused' || code === 'unavailable' ? code : null;
}

/** d3910a25dbc0: the server's «two writes met» answer (PostgreSQL 40001/40P01 → 409 CONFLICT, transient). */
export function isTransientConflict(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  return record.code === 'CONFLICT' && (record.status === 409 || record.status === undefined)
    && record.details !== null && typeof record.details === 'object' && record.details.transient === true;
}
/**
 * backlog:4eceae80a5ca — a move another write beat (409: CONFLICT,
 * STALE_STAGE, STALE_POSITION): the server already holds the winner's
 * move, so the board is read again instead of putting the card back where
 * it started.
 * @param {unknown} error
 */
export function lostToAnotherWrite(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  // Exactly these three 409s (review Muse #883): SAME_STAGE, TERMINAL_STAGE
  // and every other refusal keep the instant put-back with their line.
  return record.status === 409 && ['CONFLICT', 'STALE_STAGE', 'STALE_POSITION'].includes(record.code);
}
const MOVE_IN_FLIGHT = 'Spostamento in corso…';
/** The card's own controls: a press on one never opens the offer panel. */
const CARD_CONTROLS = 'button, a, select, input, textarea, label, .card-confirm';
const MOVE_UNCONFIRMED = 'Non ancora confermato';

/**
 * Voce 96e7b579 + backlog 1e939a362c7c: the Conferma panel for a won/lost
 * move, shared by the board card and the scheda «Cambia stato» menu —
 * never a native confirm(). The question names the offer and the target
 * label; a lost stage shows the mandatory reason input.
 * @param {any} doc
 */
export function createStageConfirm(doc) {
  const box = el(doc, 'div', { class: 'card-confirm hidden' });
  const question = el(doc, 'p', { class: 'confirm-question' });
  const reason = el(doc, 'input', {
    class: 'hidden',
    attrs: { type: 'text', placeholder: 'Motivo (obbligatorio per la perdita)', 'aria-label': 'Motivo di chiusura' },
  });
  const yes = el(doc, 'button', { class: 'small primary', text: 'Conferma', attrs: { type: 'button' } });
  const no = el(doc, 'button', { class: 'small secondary', text: 'Annulla', attrs: { type: 'button' } });
  const error = el(doc, 'small', { class: 'field-error hidden' });
  box.appendChild(question);
  box.appendChild(reason);
  box.appendChild(yes);
  box.appendChild(no);
  box.appendChild(error);
  return { box, question, reason, yes, no, error };
}

/** Whether a move onto this stage asks Conferma first (won and lost, like the board). */
export function stageNeedsConfirm(stage) {
  return stage?.type === 'won' || stage?.type === 'lost';
}

/**
 * Show the Conferma panel for `target` on the offer named `name`.
 * @param {ReturnType<typeof createStageConfirm>} panel
 * @param {string} name @param {{ key: string, label?: string, type?: string }} target
 */
export function showStageConfirm(panel, name, target) {
  const label = target.label ?? target.key;
  panel.question.textContent = target.type === 'lost'
    ? `Segnare «${name}» come ${label}? Scrivi il motivo della perdita, poi premi Conferma.`
    : `Segnare «${name}» come ${label}?`;
  panel.reason.value = '';
  panel.reason.setAttribute('class', target.type === 'lost' ? '' : 'hidden');
  panel.error.textContent = '';
  panel.error.setAttribute('class', 'field-error hidden');
  panel.box.setAttribute('class', 'card-confirm');
  if (typeof panel.reason.focus === 'function' && target.type === 'lost') panel.reason.focus();
}

/**
 * The reason a Conferma posts, or null after naming what is missing: a lost
 * move without a reason never posts.
 * @param {ReturnType<typeof createStageConfirm>} panel
 * @param {{ type?: string } | undefined} target
 * @returns {{ ok: true, reason: string | undefined } | { ok: false }}
 */
export function readStageConfirm(panel, target) {
  if (target?.type !== 'lost') return { ok: true, reason: undefined };
  const reason = String(panel.reason.value ?? '').trim();
  if (reason) return { ok: true, reason };
  panel.error.textContent = 'Scrivi il motivo della perdita, poi premi Conferma.';
  panel.error.setAttribute('class', 'field-error');
  return { ok: false };
}

/**
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean, options?: {action?: {label: string, run: () => void}}) => void, navigate?: (hash: string) => void, onAskAi?: (screenId: string, description: string) => void, wait?: (ms: number) => Promise<void>}} deps
 */
export function createPipelineBoard(deps) {
  const { doc, mount } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const rawToast = deps.toast ?? (() => {});
  // backlog:85630aa14a4f: the shell's way to take the Pipeline's toast down
  // (a failed move says so on its card, once — never also in a toast).
  const hideToast = typeof deps.hideToast === 'function' ? deps.hideToast : () => {};
  /** The offer whose move spoke last in the toast, or null. */
  let toastOwner = null;
  const toast = (...args) => { toastOwner = null; rawToast(...args); };
  /** A toast that belongs to one offer's move. */
  const moveToast = (id, ...args) => { rawToast(...args); toastOwner = id; };
  // The pending pause of a queued stage move (production 07/11: on the
  // pilot a move rides the operation queue and the card sat aria-busy for
  // minutes with no word). Injectable like the composer's send wait, so
  // tests run it without real time.
  // The default timer never holds a Node process open (unref is a no-op
  // name in the browser, where setTimeout answers a number).
  const wait = typeof deps.wait === 'function'
    ? deps.wait
    : (ms) => new Promise((resolve) => {
      const timer = /** @type {any} */ (setTimeout(resolve, ms));
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

  /** d3910a25dbc0: the short pause before the one retry of a met write (injectable for tests). */
  const retryPause = typeof deps.retryWait === 'function'
    ? () => deps.retryWait(MOVE_RETRY_MS)
    : () => new Promise((resolve) => {
      const timer = /** @type {any} */ (setTimeout(resolve, MOVE_RETRY_MS));
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

  /** Guard against stale async responses overwriting a newer board. */
  let renderToken = 0;

  /** Toolbar + view state; records are cached so filtering never refetches. */
  const state = { view: 'kanban', q: '', owner: '', stage: '', created: '' };
  /** Lista sort (backlog:fb47ab99b6ee): the clicked header and its direction; null = server order. */
  const listSort = { key: /** @type {string | null} */ (null), dir: /** @type {'asc' | 'desc'} */ ('asc') };
  /** @type {{pipeline: any, pipelines: Array<Record<string, any>>, records: Array<Record<string, any>>}} */
  let cached = { pipeline: null, pipelines: [], records: [] };
  /** The team as people (famiglia F5): names the referente, never its id. */
  let people = [];
  /** @param {unknown} owner */
  const ownerText = (owner) => personLabel(owner, people) ?? 'Membro del team';
  /** Name of the pipeline the current filter state belongs to. A filter set
   * on pipeline A must never silently empty pipeline B after a switch. */
  let filteredPipeline = null;
  /** Record id → live card controls (reason reveal on drops to lost). */
  const cardNodes = new Map();
  /** Record id → pending won/lost move awaiting Conferma. */
  const pendingConfirm = new Map();

  /** Live stage columns of the current render: drop and dragend sweep their
   * drop-target hook, so a cancelled drag never leaves a column marked. */
  const columnNodes = [];
  /** Clear the C18 drop-target hook from every live column. */
  function unmarkDropTargets() {
    for (const column of columnNodes) toggleHook(column, 'drop-target', false);
  }

  /**
   * The card in flight (Dan 11/11): its id, source stage and height, set on
   * dragstart and dropped on dragend. Null while nothing is dragged (or a
   * drag comes from outside the board): columns then behave as before.
   * @type {{ id: string, fromStage: string, height: number } | null}
   */
  let drag = null;
  /** Record id → its card's Apri button, where closing the panel hands focus back. */
  const openButtons = new Map();
  /**
   * backlog:07d29c0d1b06: each column's count and per-currency totals, kept
   * with the records they describe, so a card that moves before the server
   * answers (a drop, an Annulla) takes its count and value along — and a
   * failure brings both back together.
   * @type {Map<string, { records: Array<Record<string, any>>, count: any, totals: any }>}
   */
  const columnSummaries = new Map();

  /** Repaint one column's count and totals from its records. */
  function paintColumnSummary(stageKey) {
    const summary = columnSummaries.get(stageKey);
    if (!summary) return;
    summary.count.textContent = String(summary.records.length);
    while (summary.totals.firstChild) summary.totals.removeChild(summary.totals.firstChild);
    /** @type {Map<string, number>} */
    const totals = new Map();
    for (const record of summary.records) {
      if (!Number.isSafeInteger(record.valueCents)) continue;
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.valueCents);
    }
    for (const [currency, total] of [...totals.entries()].sort()) {
      summary.totals.appendChild(el(doc, 'p', { class: 'stage-total', text: formatAmount(total, currency) }));
    }
  }

  /**
   * Where a seated card waits for the server: record id → its column on
   * screen, which a fresh read (the truth) or a settled move clears. While a
   * move is in flight the record still names the old stage, so the «Sposta
   * in» menu reads this, not the record (backlog:85630aa14a4f).
   * @type {Map<string, string>}
   */
  const seatedStages = new Map();

  /**
   * Rebuild one seated card's «Sposta in» menu on its column on screen: the
   * column the card is in is no choice, the one it left is back. The person's
   * pending choice survives when it is still a choice.
   * @param {string} id @param {string} stageKey
   */
  function syncMoveSelect(id, stageKey) {
    const controls = cardNodes.get(id);
    const pipeline = cached.pipeline;
    if (!controls || !pipeline || !controls.select) return;
    const keep = controls.select.value;
    const select = controls.select;
    while (select.firstChild) select.removeChild(select.firstChild);
    let first = '';
    for (const target of pipeline.stages) {
      if (target.key === stageKey) continue;
      if (!first) first = target.key;
      select.appendChild(el(doc, 'option', { text: target.label, attrs: { value: target.key } }));
    }
    const kept = pipeline.stages.some((target) => target.key === keep && target.key !== stageKey);
    select.value = kept ? keep : first;
  }

  /**
   * Move one card on screen, before the server answers: the card to the top
   * of the target column and its record from one column's count and totals
   * to the other's. Returns `undo` that puts card and numbers back together,
   * or null when the card is not on the board (a filter hides it).
   * @param {string} id @param {string} fromStage @param {string} toStage
   */
  function placeCardNow(id, fromStage, toStage, placement = null) {
    const card = cardElements.get(id) ?? null;
    const from = columnSummaries.get(fromStage);
    const to = columnSummaries.get(toStage);
    const target = columnOfStage(toStage);
    if (!card || !card.parentNode || !from || !to || !target || typeof target.insertBefore !== 'function') return null;
    const record = from.records.find((candidate) => String(candidate.id) === id);
    if (!record) return null;
    const home = { parent: card.parentNode, next: card.nextSibling ?? null };
    // 67a3116f4f65: the card lands right after `afterId`, or first.
    const afterCard = placement?.afterId ? cardElements.get(placement.afterId) ?? null : null;
    let reference;
    if (afterCard && afterCard.parentNode === target) {
      reference = afterCard.nextSibling ?? null;
      if (reference === card) reference = card.nextSibling ?? null;
    } else {
      reference = cardsIn(target).find((node) => node !== card) ?? slotAnchors.get(target) ?? null;
      if (reference && reference.parentNode !== target) reference = null;
    }
    target.insertBefore(card, reference);
    const at = from.records.indexOf(record);
    from.records.splice(at, 1);
    const afterIndex = placement?.afterId ? to.records.findIndex((candidate) => String(candidate.id) === placement.afterId) : -1;
    to.records.splice(afterIndex + 1, 0, record);
    paintColumnSummary(fromStage);
    if (toStage !== fromStage) paintColumnSummary(toStage);
    syncEmptyLine(target);
    syncEmptyLine(home.parent);
    // backlog:85630aa14a4f: the menu follows the card, not the pending write.
    seatedStages.set(id, toStage);
    syncMoveSelect(id, toStage);
    return () => {
      if (typeof home.parent.insertBefore === 'function') {
        home.parent.insertBefore(card, home.next && home.next.parentNode === home.parent && home.next !== card ? home.next : null);
      }
      const back = to.records.indexOf(record);
      if (back >= 0) to.records.splice(back, 1);
      from.records.splice(Math.min(at, from.records.length), 0, record);
      paintColumnSummary(fromStage);
      if (toStage !== fromStage) paintColumnSummary(toStage);
      syncEmptyLine(home.parent);
      syncEmptyLine(target);
      seatedStages.set(id, fromStage);
      syncMoveSelect(id, fromStage);
    };
  }

  /**
   * backlog:fd0adcded1c3: «Trascina qui un'offerta» only on a column with
   * no card — gone the moment a card lands there (not after the save), back
   * when its last card leaves.
   */
  function syncEmptyLine(column) {
    if (!column || !column.childNodes || typeof column.getAttribute !== 'function' || column.getAttribute('data-stage') === null) return;
    const line = [...column.childNodes].find((node) => typeof node.getAttribute === 'function' && node.getAttribute('data-empty-line') === 'true') ?? null;
    if (cardsIn(column).length) {
      if (line) line.setAttribute('class', 'empty hidden');
      return;
    }
    if (line) {
      line.setAttribute('class', 'empty');
      return;
    }
    const fresh = emptyLine();
    column.appendChild(fresh);
    const anchor = slotAnchors.get(column);
    if (!anchor || anchor.parentNode !== column) slotAnchors.set(column, fresh);
  }
  /** The line of a column with no card. */
  function emptyLine() {
    return el(doc, 'p', { class: 'empty', text: "Trascina qui un'offerta", attrs: { 'data-empty-line': 'true' } });
  }

  /** Record id → its card node, for every card on the board (open or closed). */
  const cardElements = new Map();
  /** The live column of a stage, or null. */
  function columnOfStage(stageKey) {
    return columnNodes.find((node) => node.getAttribute('data-stage') === stageKey) ?? null;
  }
  /** The cards of a column in screen order (never the slot, never the empty line). */
  function cardsIn(column) {
    const children = column?.childNodes ? [...column.childNodes] : [];
    return children.filter((node) => typeof node.getAttribute === 'function'
      && node.getAttribute('data-record') !== null
      && String(node.getAttribute('class') ?? '').split(/\s+/).includes('pipeline-card'));
  }
  /** Where a card sits in its column: the card before it, or first. */
  function placementOf(id) {
    const card = cardElements.get(id) ?? null;
    if (!card || !card.parentNode) return { afterId: null };
    const cards = cardsIn(card.parentNode);
    const at = cards.indexOf(card);
    return { afterId: at > 0 ? String(cards[at - 1].getAttribute('data-record')) : null };
  }
  /** Whether this board stores a card's place in its column (the opportunity module). */
  const positionsOf = (pipeline) => pipeline?.module === 'opportunity';
  /** The last placement the slot showed: its column and the card it follows. */
  let slotPlacement = null;

  /** Column → the node the slot sits before: the first card, or the empty line. */
  const slotAnchors = new Map();
  /** The dashed placeholder, one for the whole board, built on first use. */
  let slot = null;
  function dropSlot() {
    if (!slot) {
      slot = el(doc, 'div', { class: 'pipeline-drop-slot', attrs: { 'aria-hidden': 'true', 'data-drop-slot': 'true' } });
    }
    return slot;
  }
  /**
   * Seat the placeholder where the card would land, as tall as the dragged
   * card. 67a3116f4f65: between two cards, under the pointer — the first
   * card whose middle is below it; with no measure (or no positions on this
   * board) on top, like before. Remembers the card it follows for the drop.
   */
  function showSlot(column, clientY = null, positions = true) {
    const node = dropSlot();
    const height = drag && drag.height > 0 ? Math.round(drag.height) : 0;
    if (height > 0) node.setAttribute('style', `height: ${height}px`);
    else node.removeAttribute('style');
    const cards = cardsIn(column).filter((card) => card.getAttribute('data-record') !== drag?.id);
    let index = 0;
    if (positions && Number.isFinite(clientY)) {
      index = cards.length;
      for (const [at, card] of cards.entries()) {
        const box = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
        if (!box || !Number.isFinite(box.top) || !Number.isFinite(box.height)) { index = 0; break; }
        if (clientY < box.top + box.height / 2) { index = at; break; }
      }
    }
    const before = index < cards.length ? cards[index] : null;
    const reference = before
      ?? (cards.length ? cards[cards.length - 1].nextSibling ?? null : slotAnchors.get(column) ?? null);
    slotPlacement = {
      stage: column.getAttribute('data-stage'),
      afterId: index > 0 ? String(cards[index - 1].getAttribute('data-record')) : null,
    };
    if (node.parentNode === column && node.nextSibling === reference) return;
    column.insertBefore(node, reference && reference.parentNode === column ? reference : null);
  }
  /** Take the placeholder off the board (idempotent: drop and dragend both call it). */
  function hideSlot() {
    if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
  }

  function clear() {
    // The offer panel stays over the board while it reloads (Dan 11/11).
    const keep = drawer ? drawer.node : null;
    for (const child of [...mount.childNodes]) {
      if (child !== keep) mount.removeChild(child);
    }
  }

  /**
   * backlog:3d811389bb4c: while the board loads, a skeleton of columns and
   * cards — the shape of what is coming, like Trello — never a bare
   * «Caricamento…». The words stay for a screen reader (role=status).
   */
  function showSkeleton() {
    clear();
    const panel = el(doc, 'section', {
      class: 'panel panel-wide pipeline-board-panel pipeline-skeleton',
      attrs: { 'aria-busy': 'true', 'data-skeleton': 'board' },
    });
    const status = el(doc, 'p', { class: 'sr-only', text: 'Caricamento…', attrs: { role: 'status' } });
    panel.appendChild(status);
    const board = el(doc, 'div', { class: 'pipeline-board', attrs: { 'aria-hidden': 'true' } });
    for (const cards of [3, 2, 2, 1]) {
      const column = el(doc, 'div', { class: 'pipeline-column pipeline-skeleton-column' });
      column.appendChild(el(doc, 'div', { class: 'pipeline-skeleton-bar' }));
      for (let index = 0; index < cards; index += 1) column.appendChild(el(doc, 'div', { class: 'pipeline-skeleton-card' }));
      board.appendChild(column);
    }
    panel.appendChild(board);
    mount.appendChild(panel);
    return { panel, status };
  }

  /** @param {string} message @param {{retry?: () => void}} [options] */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { class: 'panel' });
    box.appendChild(el(doc, 'p', { class: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { class: 'small secondary', text: 'Riprova' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  /**
   * Review #774 (P2): one lock per offer, shared by the card (Sposta, drop)
   * and the Apri panel, and kept across re-renders and panel reopenings.
   * 'flight' while the request runs; 'queued' once the server answered
   * BO_CRM_PENDING, until the next board read says where the card is.
   * @type {Map<string, 'flight' | 'queued'>}
   */
  const moveLocks = new Map();

  /**
   * The views of one offer that show a move: its card and, when open on the
   * same offer, the panel. Each answers start / unconfirmed / fail.
   * @param {string} id
   */
  function moveViewsOf(id) {
    const views = [];
    const card = cardNodes.get(id)?.view;
    if (card) views.push(card);
    if (drawer && drawer.recordId === id && drawer.moveView) views.push(drawer.moveView);
    return views;
  }

  /**
   * Run one stage move for every entry point (review #774, P2): the lock,
   * «Spostamento in corso…», a slow signal after MOVE_SLOW_MS, the bounded
   * «Non ancora confermato» + Riprova once MOVE_PENDING_MS goes by, the toast,
   * and the quiet board re-read. A queued move (BO_CRM_PENDING) stays locked:
   * only a board read (Riprova) releases it, never a second POST.
   *
   * backlog:3d811389bb4c: the card is seated in its new column first (drop,
   * Sposta, Cambia fase alike), and only then the toast speaks — the
   * message never runs ahead of the card. backlog:fd0adcded1c3: while the
   * write runs it says «Spostamento in …»; «Spostata in …» only after the
   * server's yes. «Annulla» puts card and message back at once, whatever the
   * write is still doing (see undoMove).
   * @param {{ undo?: boolean, done?: string | null, seated?: boolean, quietToast?: boolean }} [options]
   * @returns {Promise<{ moved?: true, pending?: true, busy?: true, failed?: true, undone?: true, message?: string }>}
   */
  async function runMove(pipeline, recordId, fromStage, toStage, reason, { undo = true, done = null, seated = false, quietToast = false, placement = null } = {}) {
    const id = String(recordId);
    if (moveLocks.has(id)) return { busy: true };
    moveLocks.set(id, 'flight');
    const reorder = toStage === fromStage;
    // Where the card was, for «Annulla» (67a3116f4f65): the card before it, or first.
    const origin = placementOf(id);
    // The card and its column numbers move first; `restore` brings both back.
    let restore = seated ? null : placeCardNow(id, fromStage, toStage, placement);
    for (const view of moveViewsOf(id)) view.start();
    const working = (key) => {
      const type = pipeline.stages.find((candidate) => candidate.key === key)?.type;
      return type === 'open' || type === 'renewal';
    };
    // A reorder inside a column can always go back; a stage move only
    // between working stages (a won or lost offer never reopens).
    const undoable = undo && (reorder || (working(fromStage) && working(toStage)));
    /** Set by «Annulla»: the card is already back; this move only finishes its write. */
    const intent = { undone: false };
    /** @type {(outcome: any) => void} */
    let settle = () => {};
    const outcomeOf = new Promise((resolve) => { settle = resolve; });
    /** The «Annulla» toast options — reused when a later toast replaces the first one. */
    function undoOptions() {
      return undoable ? {
        action: {
          label: 'Annulla',
          run: () => {
            intent.undone = true;
            // Card, numbers and message go back together, now — on the
            // board as it is (a re-read may have replaced the card node),
            // to the very place the card left (67a3116f4f65).
            restore = null;
            placeCardNow(id, toStage, fromStage, positionsOf(pipeline) ? origin : null);
            void undoMove(pipeline, id, fromStage, toStage, outcomeOf, positionsOf(pipeline) ? origin : null, placement);
          },
        },
        duration: UNDO_TOAST_MS,
      } : undefined;
    }
    // backlog:fd0adcded1c3: while the write runs the toast only says what is
    // happening — «Spostata in …» waits for the server's yes, so a failure
    // never follows a message that said the opposite. «Annulla» is there
    // from the first moment, as before.
    if (!quietToast) {
      const where = stageLabel(pipeline, toStage);
      moveToast(id, reorder ? `Aggiornamento dell'ordine in ${where}…` : `Spostamento in ${where}…`, false, undoOptions());
    }
    let settled = false;
    void wait(MOVE_SLOW_MS).then(() => {
      if (!settled && moveLocks.get(id) === 'flight') for (const view of moveViewsOf(id)) view.slow?.();
    });
    void wait(MOVE_PENDING_MS).then(() => {
      if (!settled && moveLocks.get(id) === 'flight') for (const view of moveViewsOf(id)) view.unconfirmed();
    });
    try {
      let answer;
      try {
        answer = await postMove(pipeline, id, fromStage, toStage, reason, placement);
      } catch (error) {
        // d3910a25dbc0: two moves in one column met on the server
        // (PostgreSQL SERIALIZABLE answers 409 CONFLICT, transient): one
        // quiet retry, then the person hears it in plain words.
        if (!isTransientConflict(error)) throw error;
        await retryPause();
        answer = await postMove(pipeline, id, fromStage, toStage, reason, placement);
      }
      // 67a3116f4f65 (pilot #562): the stage is saved but the place is not —
      // the receipt says so ('refused': the column changed in between;
      // 'unavailable': this space cannot store places). Never a silent
      // «saved»: after the re-read below the card sits on top, and we say so.
      const unplaced = placement !== null ? placementNotSaved(answer) : null;
      settled = true;
      moveLocks.delete(id);
      seatedStages.delete(id);
      // An undone move does not repaint its landing: the reverse write is
      // next, and the board re-reads after it.
      if (!intent.undone) await renderBoard(pipeline.name, { quiet: true }); // re-render: server state is the truth
      // Review Muse #852 (P2): «Annulla» may land while that re-read is in
      // flight — its repaint just put the card back on the landing column.
      // The undo wins: card and numbers go back to the place they left,
      // and only then does the reverse write follow (undoMove).
      if (intent.undone) placeCardNow(id, toStage, fromStage, positionsOf(pipeline) ? origin : null);
      if (!intent.undone && !quietToast) {
        const where = stageLabel(pipeline, toStage);
        // The server said yes: now, and only now, «Spostata in …». «Annulla»
        // stays: the write stands, so it can still go back.
        if (unplaced === null) moveToast(id, done ?? (reorder ? `Ordine aggiornato in ${where}.` : `Spostata in ${where}.`), false, undoOptions());
        else {
          moveToast(id, unplaced === 'refused'
            ? `Spostata in ${where}, ma la colonna era cambiata: la card è in cima.`
            : `Spostata in ${where}, ma qui il posto nella colonna non si salva: la card è in cima.`, false, undoOptions());
        }
      }
      settle({ moved: true });
      return { moved: true, ...(intent.undone ? { undone: true } : {}) };
    } catch (error) {
      settled = true;
      if (isMovePending(error)) {
        // Still queued on the server: the outcome is unknown, never
        // «non riuscito». The move stays locked (review #657): only
        // Riprova, a board re-read, is offered — a second POST would
        // queue a duplicate or meet a stale-stage refusal.
        console.warn('[bo] spostamento in attesa', { code: error?.code ?? 'UNKNOWN', status: error?.status ?? null });
        moveLocks.set(id, 'queued');
        const views = moveViewsOf(id);
        for (const view of views) view.unconfirmed();
        // A card no view shows (filtered out) still says where it stands.
        if (!views.length && !intent.undone) toast(`${MOVE_UNCONFIRMED}: ricarica la pipeline tra poco.`, true);
        settle({ pending: true });
        return { pending: true };
      }
      moveLocks.delete(id);
      seatedStages.delete(id);
      const message = moveFailureText(error);
      const lost = lostToAnotherWrite(error);
      if (lost) {
        // Review Muse #852 (P2): the column changed under this drop. On the
        // pilot the stage write may already have landed before the place was
        // refused (two writes, not one): never guess by putting the card
        // back — the fresh board says where it is. STALE_STAGE (backlog
        // 1541408e8144): someone else moved the card meanwhile, so the card
        // the person sees is stale the same way — the re-read tells the truth.
        // backlog:4eceae80a5ca: the same for a lost CONFLICT.
        restore = null;
        await renderBoard(pipeline.name, { quiet: true });
      } else if (restore) {
        restore();
        restore = null;
      }
      // backlog:85630aa14a4f: «Riprova» sends the same move again — same
      // column, same place, a new request — for a failure that may pass
      // (the server or the network); never after a refusal that would only
      // repeat. An «Annulla» write (quietToast) is retried by nobody.
      const resend = !quietToast && moveMayPassAgain(error)
        ? () => runMove(pipeline, id, fromStage, toStage, reason, { undo, done, placement })
        : null;
      // Lost to another write (STALE_STAGE, …): the fresh board above holds
      // the card where it belongs, so the card carries no message and no
      // Riprova — the move is superseded. Every other failure sits on the
      // card (and on the open panel), with Riprova when it may pass.
      const views = lost ? [] : moveViewsOf(id);
      for (const view of views) view.fail(message, resend);
      // One message, never two: shown on the card, the toast that said
      // «Spostamento in …» goes away; with no card to show it (a filter,
      // a superseded move) the toast says it, with the same Riprova. An
      // «Annulla» already put the card where the person wanted it.
      if (!intent.undone && !quietToast) {
        if (views.length) {
          if (toastOwner === id) { hideToast(); toastOwner = null; }
        } else {
          moveToast(id, message, true, resend ? { action: { label: 'Riprova', run: () => { void resend(); } } } : undefined);
        }
      }
      const waking = wakeWaitText(error) !== null;
      settle({ failed: true, message, waking });
      return { failed: true, message, waking };
    }
  }

  /**
   * «Annulla» (review Muse #799, P2; backlog:3d811389bb4c): card, column
   * numbers and «Riportata in …» are already back when this runs (runMove's
   * action did it at the click). Here the server follows: once the first
   * write lands, the reverse write runs; every outcome that disagrees with
   * the screen says so and puts the card where the server has it.
   */
  async function undoMove(pipeline, id, fromStage, toStage, outcomeOf, origin = null, landed = null) {
    toast(toStage === fromStage ? 'Ordine ripristinato.' : `Riportata in ${stageLabel(pipeline, fromStage)}.`);
    const first = await outcomeOf;
    if (first?.failed) return; // the first move never landed: the card is right where it is
    if (first?.pending) {
      // Review Muse #809: a move the server still holds cannot be undone yet
      // — never a silent drop of the undo: say so; the card shows where the
      // queued move will land, the board re-read (Riprova) tells the truth.
      placeCardNow(id, fromStage, toStage, landed);
      toast(`${MOVE_UNCONFIRMED}: lo spostamento è ancora in coda, non posso annullarlo adesso. Ricarica la pipeline tra poco e riprova.`, true);
      return;
    }
    if (!first?.moved) return;
    const back = await runMove(pipeline, id, toStage, fromStage, undefined, {
      undo: false, seated: true, quietToast: true, placement: origin,
    });
    if (back.failed || back.busy) {
      // The server kept the card where the first move put it: card and
      // column numbers go back there together, and the toast says what
      // happened in plain words (backlog:3d811389bb4c).
      placeCardNow(id, fromStage, toStage, landed);
      if (back.busy) {
        toast('Questa offerta si sta già spostando: riprova tra poco.', true);
      } else {
        const resta = `Non sono riuscito a riportarla in ${stageLabel(pipeline, fromStage)}: resta in ${stageLabel(pipeline, toStage)}.`;
        toast(back.waking ? `${resta} Il servizio si sta avviando: riprova tra qualche secondo.` : resta, true);
      }
    }
    // Review Muse #809: a queued undo is announced whether or not its card is on screen.
    if (back.pending) toast(`${MOVE_UNCONFIRMED}: ricarica la pipeline tra poco.`, true);
  }

  /** POST one move-stage transition — shared by the Move button and drops. */
  async function postMove(pipeline, recordId, fromStage, toStage, reason, placement = null) {
    const input = { toStage, fromStage };
    if (reason) input.reason = reason;
    // 67a3116f4f65: the place in the column rides the same write.
    if (placement && positionsOf(pipeline)) {
      if (placement.afterId) input.afterId = placement.afterId;
      else input.first = true;
    }
    const path = `/api/modules/${encodeURIComponent(pipeline.module)}/records/${encodeURIComponent(recordId)}/actions/move-stage`;
    try {
      // The answer is the receipt: the pilot says there whether the place was saved.
      return await client.request(path, { method: 'POST', body: JSON.stringify(input) });
    } catch (error) {
      // The failure log names the request (backlog:2f72000d4a4d) even when
      // the client did not stamp it.
      if (error !== null && typeof error === 'object' && Object.isExtensible(error)) {
        if (typeof error.method !== 'string') error.method = 'POST';
        if (typeof error.path !== 'string') error.path = path;
      }
      throw error;
    }
  }

  /**
   * Drop handler for a column: same server action as the Move button, with
   * the actor audited server-side. Same-stage drops are ignored (the server
   * would 409 SAME_STAGE); drops onto a won or lost stage never post
   * directly — they reveal the card's Conferma panel (with the mandatory
   * reason input for lost), like the Sposta button.
   *
   * Dan 11/11: with the column at hand, a direct move seats the card where
   * the placeholder was (the top of the column) before the write answers,
   * marked as waiting; a failure puts it back in its old place and says why.
   */
  async function handleDrop(pipeline, toStage, payload, column = null) {
    // The slot only previews: whatever happens next, it leaves the board.
    const shown = slot && slot.parentNode === column && slotPlacement?.stage === toStage ? slotPlacement : null;
    hideSlot();
    slotPlacement = null;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const recordId = typeof parsed?.id === 'string' ? parsed.id : null;
    const fromStage = typeof parsed?.fromStage === 'string' ? parsed.fromStage : null;
    if (!recordId || !fromStage) return;
    const positions = positionsOf(pipeline);
    // 67a3116f4f65: the place the slot showed (first, or after a card).
    const placement = positions ? { afterId: shown?.afterId ?? null } : null;
    if (toStage === fromStage) {
      // A drop back where the card already is changes nothing: no write, no message.
      if (!positions || placementOf(recordId).afterId === placement.afterId) return;
    }
    const record = cached.records.find((candidate) => candidate.id === recordId);
    if (!record || record.pipelineStage !== fromStage) {
      toast('Questa card è cambiata nel frattempo — la pagina si aggiorna.', true);
      await renderBoard(pipeline.name);
      return;
    }
    const target = pipeline.stages.find((stage) => stage.key === toStage);
    if (!target) return;
    const source = pipeline.stages.find((stage) => stage.key === fromStage);
    if (toStage !== fromStage && source && source.type !== 'open' && source.type !== 'renewal') {
      // A refused drop says why instead of bouncing in silence.
      toast(`Un'offerta chiusa non cambia più fase: resta in ${stageLabel(pipeline, fromStage)}.`, true);
      return;
    }
    if (toStage !== fromStage && stageNeedsConfirm(target)) {
      // Review Muse #852 (P2): the place the slot showed rides Conferma too.
      const revealed = revealConfirm(pipeline, record, fromStage, toStage, placement);
      if (!revealed) {
        toast(target.type === 'lost'
          ? 'Per la perdita serve un motivo — apri prima la card.'
          : 'Per la vittoria serve conferma — apri prima la card.', true);
      }
      return;
    }
    // Review #657: a drop rides the card's own move — the same lock,
    // «Spostamento in corso…» and pending «Non ancora confermato» + Riprova
    // as Sposta. runMove seats the card and its numbers where the slot was,
    // then speaks (backlog:3d811389bb4c), and brings both back on a failure.
    await runMove(pipeline, recordId, fromStage, toStage, undefined, { placement });
  }

  /**
   * @param {string | null} pipelineName null for the bare #/pipeline link
   *   (backlog 2a075e2d9250): the first composed pipeline, the same rule
   *   as the sidebar voice (buildShellNav).
   * @param {{ quiet?: boolean }} [options] quiet: the re-read after a move —
   *   the board stays on screen (the moved card already sits in its new place)
   *   instead of «Caricamento…» for the seconds the read takes (giro UX 11/11:
   *   on the pilot a read takes 2,5-4 s).
   */
  async function renderBoard(pipelineName, { quiet = false } = {}) {
    const token = ++renderToken;
    // A panel the router took off the page (the view was left) never comes
    // back on its own: only a reload of this same board keeps it.
    // Review #774 (P2): `mount` is the shell's gated handle (a Proxy), never
    // the parent node itself — ask it whether it holds the panel.
    if (drawer && !mount.contains(drawer.node)) closeOfferDrawer({ refocus: false });
    if (!quiet || !mount.firstChild) {
      const skeleton = showSkeleton();
      // backlog:fd0adcded1c3: a read still running after MOVE_SLOW_MS says
      // so in words, like a slow move does on its card — never only the
      // skeleton for seconds.
      void wait(MOVE_SLOW_MS).then(() => {
        if (token !== renderToken || !mount.contains(skeleton.panel)) return;
        skeleton.status.textContent = LOAD_SLOW;
        skeleton.status.setAttribute('class', 'pipeline-skeleton-slow');
      });
    }
    let pipeline;
    let records;
    let composed = [];
    try {
      const schema = await client.request('/api/schema');
      if (schema?.pipelineContract !== 1) {
        showMessage('Questo pannello va aggiornato per mostrare le pipeline.');
        return;
      }
      composed = Array.isArray(schema.pipelines) ? schema.pipelines : [];
      pipeline = pipelineName === null || pipelineName === undefined
        ? composed.find((candidate) => typeof candidate?.name === 'string' && /^[a-z][a-z0-9-]*$/.test(candidate.name))
        : composed.find((candidate) => candidate.name === pipelineName);
      if (!pipeline) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] pipeline non composta', { pipelineName });
        }
        showMessage('Nessuna pipeline da mostrare in questo spazio.');
        return;
      }
      // The board currently supports the core opportunity module's list
      // endpoint; a generated staged module would use its records route.
      const listPath = pipeline.module === 'opportunity'
        // 67a3116f4f65: the board order — position, then newest first.
        ? `/api/opportunities?limit=${BOARD_LIMIT}&order=board`
        : `/api/modules/${encodeURIComponent(pipeline.module)}/records?limit=${BOARD_LIMIT}`;
      records = (await client.request(listPath)).items ?? [];
      try {
        const team = await client.request('/api/spine/memberships');
        people = teamPeople(Array.isArray(team?.items) ? team.items : []);
      } catch (error) {
        // The board renders without names: the referente reads as the
        // operator typed it or «Membro del team», never a slug.
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] team non leggibile', { code: error?.code ?? null });
        }
        people = [];
      }
    } catch (error) {
      if (token !== renderToken) return;
      showMessage(humanReadError(error, { failed: 'La pipeline non si è potuta leggere. Riprova più tardi.' }), { retry: () => renderBoard(pipelineName) });
      return;
    }
    if (token !== renderToken) return;
    // An offer panel of another board never survives a switch.
    if (drawer && drawer.pipelineName !== pipeline.name) closeOfferDrawer({ refocus: false });
    if (filteredPipeline !== pipeline.name) {
      // New pipeline: drop the previous board's filters so a stage, owner
      // or creation interval from pipeline A cannot silently empty pipeline B.
      filteredPipeline = pipeline.name;
      state.q = '';
      state.owner = '';
      state.stage = '';
      state.created = '';
      // Review #789: the Lista sort is part of the board's view state too.
      listSort.key = null;
      listSort.dir = 'asc';
    }
    cached = { pipeline, pipelines: composed, records };
    // A fresh read is the truth a queued move waited for: it releases it.
    for (const [id, lock] of [...moveLocks]) if (lock === 'queued') moveLocks.delete(id);
    // The records name the true stages again: no seated column survives.
    seatedStages.clear();
    // A fresh server read may have moved the records: a pending Conferma
    // from the previous read is stale, never replayed onto the new truth.
    pendingConfirm.clear();
    return renderAll(token);
  }

  function renderAll(token) {
    const { pipeline, pipelines, records } = cached;
    clear();
    cardNodes.clear();
    cardElements.clear();
    columnNodes.length = 0;
    slotAnchors.clear();
    columnSummaries.clear();
    openButtons.clear();

    const onBoard = records.filter((record) => record.pipelineKey === pipeline.name);
    const stageKeys = new Set(pipeline.stages.map((stage) => stage.key));
    // Records whose stored stage key no longer belongs to the definition
    // (definition drift / out-of-band writes) are shown explicitly, never
    // silently hidden or misclassified into a column.
    const offDefinition = onBoard.filter((record) => !stageKeys.has(record.pipelineStage));
    const placed = onBoard.filter((record) => stageKeys.has(record.pipelineStage));
    const offPipeline = records.length - onBoard.length;
    // Backlog 13f43804: the board reads at most BOARD_LIMIT records, so when
    // the read is truncated the counts below are lower bounds.
    const truncated = records.length >= BOARD_LIMIT;
    const visible = placed.filter((record) => matchesFilters(record, state));

    const panel = el(doc, 'section', { class: 'panel panel-wide pipeline-board-panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    // BO-F6-10 C1/C2: fixed page chrome from the spec. The pipeline label
    // is not painted: the /bo voice is the offers board, and the nav already
    // names the routed pipeline. Unknown pipelines show a friendly line in
    // renderBoard (the name aids diagnosis in the console only).
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Pipeline' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Offerte' }));
    titleBox.appendChild(el(doc, 'p', {
      class: 'lede',
      text: "Apri una card per vedere com'è composta e costruire l'offerta. Trascinala per cambiarne lo stato.",
    }));
    heading.appendChild(titleBox);
    // Backlog 339ca222: the green `Nuova offerta` button sits top-right on
    // the title row, like the other /bo primary buttons (Clienti
    // `Aggiungi cliente`, Calendario `Nuovo appuntamento`). The violet
    // forecast leaves the title row and moves to its own row below, so the
    // row holds the title on the left and exactly one primary action on
    // the right. DECISION (to be confirmed): the forecast keeps its card
    // dress and full content, only its position changes.
    const actions = el(doc, 'div', { class: 'pipeline-actions', attrs: { 'data-pipeline-actions': 'title' } });
    actions.appendChild(renderNewOfferMenu(pipeline));
    heading.appendChild(actions);
    panel.appendChild(heading);
    // Supervisor design pass (backlog 339ca222): forecast below the title
    // row, full width, over the filtered set — unchanged content.
    panel.appendChild(renderForecast(pipeline, visible));
    // Honest bounds: the board loads at most BOARD_LIMIT records, and records
    // not on this pipeline are excluded by documented behavior, not hidden.
    if (records.length >= BOARD_LIMIT) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `Mostro solo i primi ${BOARD_LIMIT} record — gli altri non sono in questa vista.`,
      }));
    }
    if (offPipeline > 0 || composedPipelineNames(pipelines).length > 1) {
      titleBox.appendChild(renderPipelineSwitch(pipelines, records, pipeline.name, offPipeline, truncated));
    }
    const tools = renderToolbar(pipeline, onBoard);
    tools.appendChild(renderSummary(pipeline, visible));
    panel.appendChild(tools);

    if (state.view === 'lista') {
      panel.appendChild(renderList(pipeline, visible));
    } else {
      // Backlog 339ca222: the board rides a positioned wrap so the phone
      // fade cue (CSS) can overlay the scroll edge without scrolling away.
      const scroller = el(doc, 'div', { class: 'pipeline-board-wrap', attrs: { 'data-board': 'scroll' } });
      const board = el(doc, 'div', { class: 'pipeline-board' });
      for (const stage of pipeline.stages) {
        board.appendChild(renderColumn(pipeline, stage, visible.filter((record) => record.pipelineStage === stage.key), token));
      }
      scroller.appendChild(board);
      panel.appendChild(scroller);
      syncScrollCue(scroller, board);
      board.addEventListener('scroll', () => syncScrollCue(scroller, board));
    }

    if (offDefinition.length) {
      const drift = el(doc, 'div', { class: 'pipeline-drift', attrs: { 'data-drift': String(offDefinition.length) } });
      drift.appendChild(el(doc, 'h3', { text: `Fuori definizione (${offDefinition.length})` }));
      drift.appendChild(el(doc, 'p', {
        class: 'hint',
        text: 'Questi record hanno una fase che non è più nella definizione della pipeline. Le chiavi di fase sono identificativi stabili: rinominarne o toglierne una richiede una migrazione dati esplicita.',
      }));
      for (const record of offDefinition) {
        const row = el(doc, 'p', { class: 'drift-record' });
        row.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
        row.appendChild(el(doc, 'span', { text: ` — fase registrata: ${String(record.pipelineStage)}` }));
        drift.appendChild(row);
      }
      panel.appendChild(drift);
    }
    mount.appendChild(panel);
    // The offer panel lives over the board: a re-render (a filter, a move)
    // brings it back with the fresh record, or closes it when the offer
    // left the board.
    if (drawer) {
      const fresh = records.find((candidate) => String(candidate.id) === drawer.recordId);
      if (!fresh || fresh.pipelineKey !== pipeline.name) closeOfferDrawer({ refocus: false });
      else {
        if (!mount.contains(drawer.node)) mount.appendChild(drawer.node);
        if (drawer.paintedFrom !== fresh) paintOfferDrawer(pipeline, fresh);
        // The fresh board starts unscrolled: the open card's column (maybe
        // a new one, after Cambia fase) comes out from under the panel again.
        keepOpenColumnInView();
        // backlog:85630aa14a4f: the fresh cards need the open mark too.
        markOpenCard();
      }
    }
    return panel;
  }

  /** The board that holds room for the offer panel, if any. */
  let roomBoard = null;
  /** Space kept between the open card's column and the panel. */
  const OFFER_ROOM_GAP = 16;
  /**
   * backlog:fd0adcded1c3 (seguito di 23f92c6a72ea): beside the board (above
   * 700 px) the offer panel covered the open card's own column — at 1024
   * Proposta, at 1280 Pagato — and the board could not scroll it out. Now
   * the board keeps its column widths, gains room at its end as wide as the
   * panel, and scrolls just enough to set the column left of the panel.
   * The full-width sheet (≤700 px) covers the board by design: nothing here.
   */
  function keepOpenColumnInView() {
    if (!drawer) return;
    const card = cardElements.get(drawer.recordId) ?? null;
    const column = card?.parentNode ?? null;
    const board = column?.parentNode ?? null;
    const measurable = (node) => node && typeof node.getBoundingClientRect === 'function';
    if (!measurable(column) || !measurable(board) || !measurable(drawer.node)) return;
    const sheet = drawer.node.getBoundingClientRect();
    const frame = board.getBoundingClientRect();
    if (![sheet.left, sheet.width, frame.left, frame.right].every(Number.isFinite) || sheet.width <= 0) return;
    if (sheet.left <= frame.left + OFFER_ROOM_GAP) { freeOfferRoom(); return; }
    const covered = frame.right - sheet.left + OFFER_ROOM_GAP;
    if (covered > 0 && roomBoard !== board) {
      freeOfferRoom();
      const width = column.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) {
        board.setAttribute('style', `--pipeline-column-width: ${Math.round(width)}px; --pipeline-offer-room: ${Math.ceil(covered)}px`);
        board.setAttribute('data-offer-room', 'true');
        roomBoard = board;
      }
    }
    const box = column.getBoundingClientRect();
    if (![box.left, box.right].every(Number.isFinite)) return;
    const limit = sheet.left - OFFER_ROOM_GAP;
    let shift = 0;
    if (box.right > limit) shift = Math.min(box.right - limit, box.left - frame.left);
    else if (box.left < frame.left) shift = box.left - frame.left;
    if (shift !== 0) board.scrollLeft = Math.max(0, Number(board.scrollLeft ?? 0) + shift);
  }
  /** Give the board back its own width once the panel closes. */
  function freeOfferRoom() {
    if (!roomBoard) return;
    roomBoard.removeAttribute('data-offer-room');
    roomBoard.removeAttribute('style');
    roomBoard = null;
  }

  /**
   * Hide the phone fade cue once the board is scrolled to its end: the
   * wrap carries `data-ateend="true"` and the CSS overlay fades out. Any
   * unreadable scroll metric fails closed to "not at end" (cue stays).
   * @param {{setAttribute: (name: string, value: string) => void}} scroller
   * @param {{scrollLeft?: unknown, scrollWidth?: unknown, clientWidth?: unknown}} board
   */
  function syncScrollCue(scroller, board) {
    const left = Number(board?.scrollLeft ?? 0);
    const width = Number(board?.scrollWidth ?? NaN);
    const seen = Number(board?.clientWidth ?? NaN);
    const atEnd = Number.isFinite(width) && Number.isFinite(seen)
      && (width - seen <= 4 || left >= width - seen - 4);
    scroller.setAttribute('data-ateend', atEnd ? 'true' : 'false');
  }

  /**
   * `Nuova offerta` menu button (C3, moved top-right by backlog 339ca222):
   * the green button on the title row, opening the prototype's two voices.
   * The buttons are the
   * shared `ui-add-option` voices (MEM_ACC_REUSE: same pattern as the
   * Clienti add menu and the shell `+ Nuovo` menu), positioned by the
   * generic `ui-conn-addwrap` / `ui-conn-addmenu` pair — no screen CSS.
   * Both voices do real work: `Crea con l'AI` opens the BO-F0-04
   * assistant on the pipeline screen (or says where the AI bar is when
   * the shell offers no entry), `Compila manualmente` navigates to the
   * governed module create form. Nothing is previewed or written here.
   */
  function renderNewOfferMenu(pipeline) {
    const wrap = el(doc, 'div', { class: 'ui-conn-addwrap', attrs: { 'data-newoffer': 'menu' } });
    const button = uiButton(doc, {
      variant: 'cta',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-action': 'new-offer' },
    });
    button.appendChild(el(doc, 'span', { text: 'Nuova offerta' }));
    button.appendChild(uiIcon(doc, 'chevron'));
    const menu = el(doc, 'div', { class: 'ui-add-menu ui-conn-addmenu hidden', attrs: { role: 'menu' } });
    const isHidden = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
    const sync = () => button.setAttribute('aria-expanded', isHidden() ? 'false' : 'true');
    const close = () => {
      menu.setAttribute('class', 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    };
    button.addEventListener('click', () => {
      menu.setAttribute('class', isHidden() ? 'ui-add-menu ui-conn-addmenu' : 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    });
    const closeOnEscape = (event) => {
      if (event?.key === 'Escape') close();
    };
    button.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    const aiVoice = uiAddOption(doc, {
      kind: 'ai', title: "Crea con l'AI", line: 'Es. «cucina per Giulia, 27.500 €»',
      attrs: { 'data-voice': 'ai' },
    });
    aiVoice.addEventListener('click', () => {
      close();
      if (typeof deps.onAskAi === 'function') {
        deps.onAskAi('pipeline', 'Voglio creare un\u2019offerta: ti incollo i dettagli.');
      } else {
        toast('Apri la barra AI (⌘K) e descrivi l\u2019offerta che vuoi creare.');
      }
    });
    const manualVoice = uiAddOption(doc, {
      kind: 'manual', title: 'Compila manualmente', line: 'Titolo, cliente, valore e scadenza',
      attrs: { 'data-voice': 'manual' },
    });
    manualVoice.addEventListener('click', () => {
      close();
      if (typeof deps.navigate === 'function') {
        deps.navigate(`#/modules/${encodeURIComponent(pipeline.module)}/new`);
      } else {
        toast('La creazione manuale non è disponibile da qui.');
      }
    });
    menu.appendChild(aiVoice);
    menu.appendChild(manualVoice);
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  /**
   * One voice of a filter pill menu (C8): the shared `ui-add-option` shape
   * (tile + bold title, no new classes — the dress stays in styles.css),
   * with a ✓ tile on the active option like the prototype's check mark.
   * The title travels through textContent only, so hostile owner or stage
   * names stay inert text.
   */
  function filterVoice(key, { value, title, active, onPick }) {
    const node = doc.createElement('button');
    node.setAttribute('class', 'ui-add-option');
    node.setAttribute('type', 'button');
    node.setAttribute('role', 'menuitemradio');
    node.setAttribute('aria-checked', active ? 'true' : 'false');
    node.setAttribute('data-menu-voice', key);
    node.setAttribute('data-value', value);
    const tile = doc.createElement('span');
    tile.setAttribute('class', 'ui-add-tile');
    tile.setAttribute('aria-hidden', 'true');
    tile.textContent = active ? '✓' : '';
    node.appendChild(tile);
    const words = doc.createElement('span');
    words.setAttribute('class', 'ui-add-words');
    const name = doc.createElement('span');
    name.setAttribute('class', 'ui-add-title');
    name.textContent = String(title);
    words.appendChild(name);
    node.appendChild(words);
    node.addEventListener('click', () => onPick(value));
    return node;
  }

  /**
   * Prototype filter pill (C8): `Referente Tutti` — a menu-button with the
   * grey label and the bold value, opening the shared `ui-add-menu` voice
   * list. Same wrap/menu pair as `Nuova offerta` (MEM_ACC_REUSE: no screen
   * CSS, no raw browser select or date input). A non-default value marks
   * the pill with the established `active` hook, like `ui-seg`.
   */
  function renderFilterMenu({ key, label, valueText, filterLabel, current, voices, onPick }) {
    const wrap = el(doc, 'div', { class: 'ui-conn-addwrap', attrs: { 'data-filtermenu': key } });
    const button = uiButton(doc, {
      variant: 'secondary',
      attrs: {
        type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        'aria-label': filterLabel,
      },
    });
    if (current !== '') button.setAttribute('class', `${button.getAttribute('class')} active`);
    button.appendChild(el(doc, 'span', { text: `${label} ` }));
    button.appendChild(el(doc, 'strong', { text: valueText }));
    button.appendChild(uiIcon(doc, 'chevron'));
    const menu = el(doc, 'div', { class: 'ui-add-menu ui-conn-addmenu hidden', attrs: { role: 'menu' } });
    const isHidden = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
    const sync = () => button.setAttribute('aria-expanded', isHidden() ? 'false' : 'true');
    button.addEventListener('click', () => {
      menu.setAttribute('class', isHidden() ? 'ui-add-menu ui-conn-addmenu' : 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    });
    const closeOnEscape = (event) => {
      if (event?.key === 'Escape') {
        menu.setAttribute('class', 'ui-add-menu ui-conn-addmenu hidden');
        sync();
      }
    };
    button.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    for (const voice of voices) {
      menu.appendChild(filterVoice(key, {
        value: voice.value,
        title: voice.title,
        active: voice.value === current,
        onPick: (picked) => {
          onPick(picked);
          renderAll(renderToken);
        },
      }));
    }
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  /** View toggle + search + Referente/Creata/Stati pills + Azzera filtri. */
  function renderToolbar(pipeline, onBoard) {
    const toolbar = el(doc, 'div', { class: 'pipeline-toolbar', attrs: { 'data-toolbar': 'pipeline' } });

    for (const view of ['kanban', 'lista']) {
      const button = el(doc, 'button', {
        class: `small ${state.view === view ? 'primary' : 'secondary'}`,
        text: view === 'kanban' ? 'Kanban' : 'Lista',
        attrs: { type: 'button', 'data-view': view, 'aria-pressed': String(state.view === view) },
      });
      button.addEventListener('click', () => {
        state.view = view;
        renderAll(renderToken);
      });
      toolbar.appendChild(button);
    }

    const search = el(doc, 'input', {
      attrs: {
        type: 'search', placeholder: 'Cerca offerta o cliente',
        'aria-label': 'Cerca offerta o cliente', 'data-filter': 'q', value: state.q,
      },
    });
    search.value = state.q;
    search.addEventListener('input', () => {
      state.q = String(search.value ?? '');
      const cursor = typeof search.selectionStart === 'number' ? search.selectionStart : search.value.length;
      renderAll(renderToken);
      // The toolbar is rebuilt on every keystroke: hand focus back to the
      // new search input so typing is not interrupted after one character.
      // mount is a real Element in production (no findAll — that exists only
      // on the fake-dom test double), so query the real DOM API with a guard.
      const next = typeof mount.querySelector === 'function'
        ? mount.querySelector('input[data-filter="q"]')
        : null;
      if (next) {
        if (typeof next.focus === 'function') next.focus();
        try {
          if (typeof next.setSelectionRange === 'function') next.setSelectionRange(cursor, cursor);
        } catch {
          // Non-text inputs or test doubles: caret restore is best-effort.
        }
      }
    });
    toolbar.appendChild(search);

    // BO-F6-10 C8: the three prototype pills — `Referente Tutti`,
    // `Creata Sempre`, `Stati Tutti` — with the check on the active voice.
    const owners = [...new Set(onBoard.map((record) => record.owner).filter((owner) => typeof owner === 'string' && owner))].sort();
    toolbar.appendChild(renderFilterMenu({
      key: 'owner',
      label: 'Referente',
      valueText: state.owner ? ownerText(state.owner) : 'Tutti',
      filterLabel: 'Filtra per referente',
      current: state.owner,
      voices: [{ value: '', title: 'Tutti' }, ...owners.map((owner) => ({ value: owner, title: ownerText(owner) }))],
      onPick: (picked) => { state.owner = picked; },
    }));
    toolbar.appendChild(renderFilterMenu({
      key: 'created',
      label: 'Creata',
      valueText: (CREATED_OPTIONS.find((option) => option.value === state.created) ?? CREATED_OPTIONS[0]).label,
      filterLabel: 'Filtra per data di creazione',
      current: state.created,
      voices: CREATED_OPTIONS.map((option) => ({ value: option.value, title: option.label })),
      onPick: (picked) => { state.created = picked; },
    }));
    toolbar.appendChild(renderFilterMenu({
      key: 'stage',
      label: 'Stati',
      valueText: pipeline.stages.find((stage) => stage.key === state.stage)?.label
        ?? pipeline.stages.find((stage) => stage.key === state.stage)?.key
        ?? 'Tutti',
      filterLabel: 'Filtra per stato',
      current: state.stage,
      voices: [{ value: '', title: 'Tutti' }, ...pipeline.stages.map((stage) => ({ value: stage.key, title: stage.label ?? stage.key }))],
      onPick: (picked) => { state.stage = picked; },
    }));

    // BO-F6-10 C11: `Azzera filtri` exists only while a filter or search is
    // active, so the toolbar never offers a no-op reset.
    if (state.q || state.owner || state.stage || state.created) {
      const reset = el(doc, 'button', {
        class: 'small secondary', text: 'Azzera filtri',
        attrs: { type: 'button', 'data-action': 'clear-filters' },
      });
      reset.addEventListener('click', () => {
        state.q = '';
        state.owner = '';
        state.stage = '';
        state.created = '';
        renderAll(renderToken);
      });
      toolbar.appendChild(reset);
    }

    return toolbar;
  }

  /**
   * Canonical composed-pipeline names, sorted: the only values the switch
   * offers, so an out-of-band record key can never become a route.
   * @param {Array<Record<string, any>>} pipelines
   */
  function composedPipelineNames(pipelines) {
    return (Array.isArray(pipelines) ? pipelines : [])
      .filter((candidate) => typeof candidate?.name === 'string' && /^[a-z][a-z0-9-]*$/.test(candidate.name))
      .map((candidate) => candidate.name)
      .sort();
  }

  /**
   * Pipeline switch (backlog:1cb4cc48, review accordo-muse-review on #727):
   * records of other pipelines are excluded by documented behavior, never
   * silently hidden. The count still names how many offers live on the other
   * boards (renderOffPipeline, one click per offer to its #/offerte page),
   * and when the space composes more than one pipeline a selector offers
   * every composed pipeline — each one renders a real board, one choice away.
   * A key the schema does not compose (unknown, keyless, or outside the route
   * grammar) never becomes a pipeline choice or a #/pipelines link: the
   * destination would not render (renderBoard resolves against `composed`
   * only). Those offers stay reachable through the disclosure list. Choices
   * come from the schema, never from the truncated record read, so a
   * BOARD_LIMIT read cannot make them partial; the lower-bound wording
   * («almeno N») lives on the counts (backlog 13f43804). Every value renders
   * as text, never HTML.
   * DECISION (to be confirmed): with a single composed pipeline and only
   * unresolvable off-board offers there is no one-choice selector — the
   * disclosure list is the actionable path to the offer pages.
   * @param {Array<Record<string, any>>} pipelines
   * @param {Array<Record<string, any>>} records
   * @param {string} pipelineName
   * @param {number} offPipeline
   * @param {boolean} truncated whether the read hit BOARD_LIMIT (counts are lower bounds)
   */
  function renderPipelineSwitch(pipelines, records, pipelineName, offPipeline, truncated) {
    const box = el(doc, 'div', { class: 'hint pipeline-switch' });
    if (offPipeline > 0) {
      box.appendChild(renderOffPipeline(pipelines, records, pipelineName, offPipeline, truncated));
    }
    const composed = composedPipelineNames(pipelines);
    if (composed.length > 1) {
      const selectId = 'pipeline-switch';
      box.appendChild(el(doc, 'label', { text: 'Pipeline: ', attrs: { for: selectId } }));
      const select = el(doc, 'select', { attrs: { id: selectId } });
      for (const name of composed) {
        const defined = pipelines.find((candidate) => candidate?.name === name);
        const label = typeof defined?.label === 'string' && defined.label !== '' ? defined.label : name;
        select.appendChild(el(doc, 'option', { text: label, attrs: { value: name } }));
      }
      select.value = pipelineName;
      select.addEventListener('change', () => {
        const next = select.value;
        if (typeof next === 'string' && next !== '' && next !== pipelineName) {
          if (typeof deps.navigate === 'function') deps.navigate(`#/pipelines/${next}`);
        }
      });
      box.appendChild(select);
    }
    return box;
  }

  /**
   * Backlog 1e939a362c7c: «N offerte di altre pipeline» opens those offers.
   * The count is a button that unfolds them in place — each one a link to
   * its offer page (#/offerte/<id>) with its stage in the same words as the
   * scheda (offerStageLabel) — so an offer placed on another board, or on
   * none, is one click away and never only a number.
   * Backlog 13f43804: the board reads at most BOARD_LIMIT records, so when
   * the read is truncated both counts below are lower bounds and say so
   * («almeno N»): the true totals can only be higher.
   * @param {Array<Record<string, any>>} pipelines
   * @param {Array<Record<string, any>>} records
   * @param {string} pipelineName
   * @param {number} offPipeline
   * @param {boolean} truncated whether the read hit BOARD_LIMIT
   */
  function renderOffPipeline(pipelines, records, pipelineName, offPipeline, truncated) {
    const wrap = el(doc, 'span', { class: 'pipeline-off' });
    const one = offPipeline === 1;
    const toggle = el(doc, 'button', {
      class: 'link-button',
      text: `${truncated ? 'almeno ' : ''}${offPipeline} offert${one ? 'a' : 'e'} di ${one ? "un'altra" : 'altre'} pipeline`,
      attrs: { type: 'button', 'data-action': 'show-off-pipeline', 'aria-expanded': 'false' },
    });
    const list = el(doc, 'ul', { class: 'pipeline-off-list hidden', attrs: { 'data-off-pipeline': 'list' } });
    const others = records.filter((record) => record.pipelineKey !== pipelineName).slice(0, OFF_PIPELINE_LISTED);
    for (const record of others) {
      // Backlog 169cd4bc988c: one row per offer in the /bo dress — its name
      // opens its page, then who it is for (never «Senza azienda») and its
      // stato capitalised («Proposta», never the bare «proposta»).
      const item = el(doc, 'li', { class: 'pipeline-off-item' });
      const id = typeof record?.id === 'string' && record.id !== '' ? record.id : null;
      const name = typeof record?.name === 'string' && record.name.trim() !== '' ? record.name : 'Offerta senza nome';
      if (id === null) {
        item.appendChild(el(doc, 'span', { class: 'pipeline-off-name', text: name }));
      } else {
        item.appendChild(el(doc, 'a', { class: 'pipeline-off-name', text: name, attrs: { href: `#/offerte/${encodeURIComponent(id)}` } }));
      }
      const customer = offerCustomer(record);
      const stage = upperFirst(offerStageLabel(pipelines, record));
      const facts = [customer?.name ?? null, stage].filter((part) => typeof part === 'string' && part !== '');
      if (facts.length > 0) item.appendChild(el(doc, 'span', { class: 'pipeline-off-meta', text: ` · ${facts.join(' · ')}` }));
      list.appendChild(item);
    }
    if (offPipeline > others.length) {
      list.appendChild(el(doc, 'li', {
        class: 'muted',
        text: `e ${truncated ? 'almeno ' : ''}altre ${offPipeline - others.length}`,
      }));
    }
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      list.setAttribute('class', open ? 'pipeline-off-list hidden' : 'pipeline-off-list');
    });
    wrap.appendChild(toggle);
    wrap.appendChild(el(doc, 'span', { text: '. ' }));
    wrap.appendChild(list);
    return wrap;
  }

  /**
   * Count + per-currency open value over the filtered set (currencies never
   * summed). backlog:48993bed7294 (verifica 13/11: «9 offerte · 1.126 €»
   * summed a lost offer too): the amount is the value still open — won,
   * paid and lost offers are counted, never summed — and it says so.
   */
  function renderSummary(pipeline, visible) {
    const summary = el(doc, 'p', { class: 'pipeline-summary', attrs: { 'data-summary': String(visible.length) } });
    const openKeys = new Set(pipeline.stages.filter((stage) => stage.type === 'open' || stage.type === 'renewal').map((stage) => stage.key));
    const totals = new Map();
    for (const record of visible) {
      if (!Number.isSafeInteger(record.valueCents) || !openKeys.has(record.pipelineStage)) continue;
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.valueCents);
    }
    // BO-F6-10 C9: `<n> offerte · valore aperto <totale>`, updated by every filter/search.
    const parts = [`${visible.length} offert${visible.length === 1 ? 'a' : 'e'}`];
    const sorted = [...totals.entries()].sort();
    for (const [index, [currency, total]] of sorted.entries()) {
      parts.push(`${index === 0 ? 'valore aperto ' : ''}${formatAmount(total, currency)}`);
    }
    summary.textContent = parts.join(' · ');
    return summary;
  }

  /**
   * Forecast over the filtered set (C4/C5). backlog:48993bed7294 (verifica
   * 13/11: «Previsione di novembre 605,60 €» here, «Vinte in novembre
   * 0,00 €» in Reporting): one rule with the Reporting forecast — the offers
   * won or paid that closed this month (`closedAt`, the expected date only
   * when it is missing), plus the historical close rate (won and paid over
   * won, paid and lost) of the open ones expected this month or without a
   * date. Per currency — currencies are never summed. The month is the UTC
   * one, like the Reporting period. The risk line names the owner or
   * customer of the highest-value open offer. Labeled as a stima, never a
   * commitment. Class hooks (`pipeline-forecast`, `forecast-total`) are
   * unchanged: the supervisor owns the visual dress (ANSWER 28/10).
   */
  function renderForecast(pipeline, visible) {
    const period = new Date().toISOString().slice(0, 7);
    const box = el(doc, 'div', { class: 'pipeline-forecast', attrs: { 'data-forecast': 'estimate' } });
    box.appendChild(el(doc, 'h3', { text: `✦ Previsione di ${MONTHS_IT[Number(period.slice(5, 7)) - 1]}` }));
    const closedKeys = new Set(
      pipeline.stages.filter((stage) => stage.type === 'won' || stage.type === 'paid').map((stage) => stage.key),
    );
    const lostKeys = new Set(pipeline.stages.filter((stage) => stage.type === 'lost').map((stage) => stage.key));
    const openKeys = new Set(pipeline.stages.filter((stage) => stage.type === 'open' || stage.type === 'renewal').map((stage) => stage.key));
    const monthOf = (value) => (typeof value === 'string' && /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : null);
    const closed = new Map();
    const waiting = new Map();
    const openCurrencies = new Set();
    let wonCount = 0;
    let lostCount = 0;
    let riskiest = null;
    for (const record of visible) {
      if (closedKeys.has(record.pipelineStage)) wonCount += 1;
      else if (lostKeys.has(record.pipelineStage)) lostCount += 1;
      if (!Number.isSafeInteger(record.valueCents)) continue;
      if (closedKeys.has(record.pipelineStage)) {
        if ((monthOf(record.closedAt) ?? monthOf(record.expectedCloseDate)) === period) {
          closed.set(record.currency, (closed.get(record.currency) ?? 0) + record.valueCents);
        }
      } else if (openKeys.has(record.pipelineStage)) {
        const expected = monthOf(record.expectedCloseDate);
        if (expected === null || expected === period) {
          waiting.set(record.currency, (waiting.get(record.currency) ?? 0) + record.valueCents);
        }
        openCurrencies.add(record.currency);
        if (!riskiest || record.valueCents > riskiest.valueCents) riskiest = record;
      }
    }
    // Review lead #896: below FORECAST_MIN_DECIDED decided offers the
    // historical rate is noise; the declared fallback is used and said —
    // the same rule and the same numbers as packages/analytics/src/dashboard.js.
    const decided = wonCount + lostCount;
    const steady = decided >= FORECAST_MIN_DECIDED;
    const rate = steady ? wonCount / decided : FORECAST_FALLBACK_RATE;
    const total = new Map();
    for (const [currency, amount] of closed.entries()) {
      total.set(currency, (total.get(currency) ?? 0) + amount);
    }
    for (const [currency, amount] of waiting.entries()) {
      total.set(currency, (total.get(currency) ?? 0) + Math.round(amount * rate));
    }
    if (!total.size) {
      box.appendChild(el(doc, 'p', { class: 'hint', text: 'Nessuna offerta da stimare — non un impegno.' }));
      return box;
    }
    for (const [currency, amount] of [...total.entries()].sort()) {
      box.appendChild(el(doc, 'p', { class: 'forecast-total', text: formatAmount(amount, currency) }));
    }
    box.appendChild(el(doc, 'p', {
      class: 'hint',
      text: `Chiuse nel mese, più il ${steady
        ? `${Math.round(rate * 100)}% (tasso di chiusura storico)`
        : `${Math.round(FORECAST_FALLBACK_RATE * 100)}% (stima: poche offerte chiuse, ${decided} su almeno ${FORECAST_MIN_DECIDED})`} delle aperte attese nel mese o senza data. Sulle offerte in vista — stima, non un impegno.`,
    }));
    // No global ranking across currencies: raw cents are not comparable
    // without exchange rates, so the risk line shows only when every valued
    // open offer shares one currency (Codex P2 on #467).
    const riskName = openCurrencies.size === 1 && typeof riskiest?.owner === 'string' && riskiest.owner
      ? ownerText(riskiest.owner)
      : openCurrencies.size === 1 && customerName(riskiest)
        ? customerName(riskiest)
        : null;
    if (riskName) {
      box.appendChild(el(doc, 'p', { class: 'hint', text: `Il rischio più alto è ${riskName}.` }));
    }
    return box;
  }

  /**
   * Read-only Lista table over the same filtered records (moves stay on Kanban).
   * Headers follow the prototype order (BO-F6-10 C19) plus Cliente
   * (backlog:fb47ab99b6ee); every row shows the state pill with its dot, the
   * value, the stage probability, the expected close, the creation day and the
   * referente by the person's name (BO-F6-10 C20). Dates read «11 nov 2026».
   * Each header sorts the list (click again to reverse), like a spreadsheet;
   * the sort lives in the view and survives filters. Values are set through
   * textContent/setAttribute only, never innerHTML.
   */
  function renderList(pipeline, visible) {
    const wrap = el(doc, 'div', { class: 'pipeline-list', attrs: { 'data-listview': 'records' } });
    const table = el(doc, 'table', { class: 'pipeline-table' });
    const head = el(doc, 'thead');
    const headRow = el(doc, 'tr');
    const stageOf = new Map(pipeline.stages.map((stage) => [stage.key, stage]));
    const stageRank = new Map(pipeline.stages.map((stage, index) => [stage.key, index]));
    const columns = listColumns(stageOf, stageRank);
    for (const column of columns) {
      const active = listSort.key === column.key;
      const th = el(doc, 'th', {
        attrs: { 'aria-sort': active ? (listSort.dir === 'asc' ? 'ascending' : 'descending') : 'none', 'data-sort-key': column.key },
      });
      const button = el(doc, 'button', {
        class: 'pipeline-sort',
        text: column.label,
        attrs: { type: 'button', 'data-action': 'sort-list', 'data-sort': column.key },
      });
      button.addEventListener('click', () => {
        if (listSort.key === column.key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
        else {
          listSort.key = column.key;
          listSort.dir = 'asc';
        }
        renderAll(renderToken);
      });
      th.appendChild(button);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el(doc, 'tbody');
    // Dan 06/11: a row of the Lista opens the offer like Apri on the Kanban
    // card — the name is the link (keyboard, new tab), the whole row clicks.
    const detailed = pipeline.module === 'opportunity';
    for (const record of sortedForList(visible, columns)) {
      const stage = stageOf.get(record.pipelineStage);
      const row = el(doc, 'tr', { attrs: { 'data-record': String(record.id) } });
      const name = String(record.name ?? record.id);
      if (detailed) {
        const href = `#/offerte/${encodeURIComponent(String(record.id))}`;
        const cell = el(doc, 'td');
        cell.appendChild(el(doc, 'a', {
          class: 'pipeline-row-link',
          text: name,
          attrs: { href, 'data-action': 'open-offer' },
        }));
        row.appendChild(cell);
        row.setAttribute('data-openable', 'true');
        row.addEventListener('click', (event) => {
          // The link navigates on its own; a click elsewhere on the row
          // follows it, never a selection drag or a modified click.
          if (event?.target?.closest?.('a')) return;
          if (event?.metaKey || event?.ctrlKey || event?.shiftKey) return;
          // Review #614: a click that ends a text selection (copying a
          // name or a value) stays on the list; the name link still opens.
          const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
          if (selection && selection.isCollapsed === false && String(selection) !== '') return;
          if (typeof deps.navigate === 'function') deps.navigate(href);
        });
      } else {
        row.appendChild(el(doc, 'td', { text: name }));
      }
      row.appendChild(el(doc, 'td', { text: customerOf(record) ?? '—' }));
      const stateCell = el(doc, 'td');
      stateCell.appendChild(renderStagePill(stage, record.pipelineStage));
      row.appendChild(stateCell);
      row.appendChild(el(doc, 'td', { text: formatAmount(record.valueCents, record.currency) }));
      row.appendChild(el(doc, 'td', { text: probabilityText(stage) }));
      row.appendChild(el(doc, 'td', { text: italianDay(record.expectedCloseDate) ?? '—' }));
      row.appendChild(el(doc, 'td', { text: italianDay(record.createdAt) ?? '—' }));
      row.appendChild(el(doc, 'td', { text: typeof record.owner === 'string' && record.owner ? ownerText(record.owner) : '—' }));
      body.appendChild(row);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    if (!visible.length) {
      wrap.appendChild(el(doc, 'p', { class: 'empty', text: 'Nessuna offerta con questi filtri.' }));
    }
    return wrap;
  }

  /**
   * The Lista columns: label, sort key and the value each one sorts by
   * (null sorts last whatever the direction, like a spreadsheet's blanks).
   * @param {Map<string, any>} stageOf @param {Map<string, number>} stageRank
   */
  function listColumns(stageOf, stageRank) {
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim().toLocaleLowerCase('it') : null);
    return [
      { key: 'name', label: 'Offerta', value: (record) => text(record.name) },
      { key: 'customer', label: 'Cliente', value: (record) => text(customerOf(record)) },
      { key: 'stage', label: 'Stato', value: (record) => stageRank.get(record.pipelineStage) ?? null },
      { key: 'value', label: 'Valore', value: (record) => (Number.isSafeInteger(record.valueCents) ? record.valueCents : null) },
      { key: 'probability', label: 'Probabilità', value: (record) => stageProbability(stageOf.get(record.pipelineStage)) },
      { key: 'close', label: 'Chiusura', value: (record) => romeDayKey(record.expectedCloseDate) },
      { key: 'created', label: 'Creata', value: (record) => romeDayKey(record.createdAt) },
      {
        key: 'owner', label: 'Referente',
        value: (record) => (typeof record.owner === 'string' && record.owner ? text(ownerText(record.owner)) : null),
      },
    ];
  }

  /** The visible records in the chosen Lista order; the server order without a sort. */
  function sortedForList(visible, columns) {
    const column = columns.find((candidate) => candidate.key === listSort.key);
    if (!column) return visible;
    const sign = listSort.dir === 'desc' ? -1 : 1;
    return visible
      .map((record, index) => ({ record, index, value: column.value(record) }))
      .sort((left, right) => {
        if (left.value === null && right.value === null) return left.index - right.index;
        if (left.value === null) return 1;
        if (right.value === null) return -1;
        const order = typeof left.value === 'number' && typeof right.value === 'number'
          ? left.value - right.value
          : String(left.value).localeCompare(String(right.value), 'it');
        return order === 0 ? left.index - right.index : sign * order;
      })
      .map((entry) => entry.record);
  }

  /** State pill with its dot (BO-F6-10 C12/C20): the dot color is CSS, the hook is markup. */
  function renderStagePill(stage, stageKey) {
    const pill = el(doc, 'span', { class: 'pill' });
    pill.appendChild(el(doc, 'span', { class: `stage-dot type-${stage?.type ?? 'unknown'}` }));
    pill.appendChild(el(doc, 'span', { text: stage?.label ?? String(stageKey) }));
    return pill;
  }

  /** A stage's probability when it is a real percentage (0-100), else null: one rule for the cell and its sort. */
  function stageProbability(stage) {
    const probability = stage?.probability;
    return typeof probability === 'number' && probability >= 0 && probability <= 100 ? probability : null;
  }

  /** Stage probability as `NN%`, or an em dash when the stage is unknown. */
  function probabilityText(stage) {
    const probability = stageProbability(stage);
    return probability === null ? '—' : `${probability}%`;
  }

  /**
   * BO-F6-10 C25: the board never paints technical text — no stage keys, no
   * error codes (`SAME_STAGE`), no raw server messages. The technical detail
   * goes to the console only; the DOM gets a friendly Italian line.
   */
  function stageLabel(pipeline, key) {
    // Backlog a551982c06eb: the same words as the scheda and the offer detail.
    return offerStageLabel([pipeline], { pipelineKey: pipeline.name, pipelineStage: key }) ?? key;
  }

  /** A move the server still holds: the queue answered BO_CRM_PENDING. A bare 504 is a failure, not a queue. */
  function isMovePending(error) {
    const record = error !== null && typeof error === 'object' ? error : {};
    return record.code === 'BO_CRM_PENDING';
  }

  function moveFailureText(error) {
    const record = error !== null && typeof error === 'object' ? error : {};
    const code = typeof record.code === 'string' ? record.code : '';
    const field = record.details && typeof record.details.field === 'string' ? record.details.field : '';
    const message = typeof record.message === 'string' ? record.message : '';
    // The shared /bo write-failure line (admin-core, #808).
    logWriteFailure(error);
    // backlog:3d811389bb4c: a waking workspace (503 «Spazio di lavoro in
    // avvio») is a wait, said in plain words — never «Riprova più tardi».
    const wake = wakeWaitText(error);
    if (wake !== null) return wake;
    if (code === 'SAME_STAGE') return 'Questa offerta è già in questo stato.';
    if (code === 'TERMINAL_STAGE') return "Un'offerta chiusa non cambia più fase.";
    if (code === 'STALE_STAGE') return "Questa offerta è stata spostata altrove nel frattempo: la pipeline si aggiorna.";
    // Review Muse #893 (P2): a lost write offers no Riprova, so its words never ask for one.
    if (code === 'STALE_POSITION') return 'La colonna è cambiata nel frattempo: la pipeline si aggiorna.';
    if (isTransientConflict(error)) return 'Questa offerta è stata spostata nel frattempo: la pipeline si aggiorna.';
    if (field === 'reason' || /reason is required/i.test(message)) return "Per segnare un'offerta come persa serve il motivo.";
    // backlog:85630aa14a4f: the words match the Riprova next to them.
    return 'Spostamento non riuscito.';
  }

  /**
   * backlog:85630aa14a4f: a move failure that may pass if sent again — the
   * server or the network failed (5xx, 408, 429, no answer). A refusal
   * (SAME_STAGE, TERMINAL_STAGE, a missing reason, a stale 409) would only
   * repeat itself.
   */
  function moveMayPassAgain(error) {
    if (lostToAnotherWrite(error) || isMovePending(error)) return false;
    const status = Number(error?.status);
    if (!Number.isFinite(status) || status === 0) return true;
    return status >= 500 || status === 408 || status === 429;
  }

  /** Toggle one hook class on a node without touching its other classes. */
  function toggleHook(node, hook, on) {
    const current = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const next = on ? [...new Set([...current, hook])] : current.filter((cls) => cls !== hook);
    node.setAttribute('class', next.join(' '));
  }

  /**
   * One stage column: badge-distinguished type (never color alone), count,
   * per-currency totals (currencies are never summed together), cards.
   * Open and terminal columns alike accept drops — the shared handler posts
   * the same move-stage action; drops onto lost reveal the reason input.
   */
  function renderColumn(pipeline, stage, records, token) {
    const column = el(doc, 'div', { class: `pipeline-column type-${stage.type}`, attrs: { 'data-stage': stage.key } });
    const header = el(doc, 'div', { class: 'pipeline-column-header' });
    const badge = stage.type === 'won' ? 'Vinta ✓' : stage.type === 'lost' ? 'Persa ✕' : 'Aperta';
    // BO-F6-10 C12: state dot hook beside the name; the color itself is CSS.
    header.appendChild(el(doc, 'span', { class: `stage-dot type-${stage.type}` }));
    header.appendChild(el(doc, 'h3', { text: stage.label }));
    header.appendChild(el(doc, 'span', { class: `stage-type stage-${stage.type}`, text: badge }));
    const count = el(doc, 'span', { class: 'stage-count', text: String(records.length), attrs: { 'data-count': stage.key } });
    header.appendChild(count);
    column.appendChild(header);

    // Per-currency totals — deliberately one line per currency — in a box
    // the column repaints when a card moves before the server answers.
    const totalsBox = el(doc, 'div', { class: 'stage-totals', attrs: { 'data-totals': stage.key } });
    column.appendChild(totalsBox);
    columnSummaries.set(stage.key, { records: [...records], count, totals: totalsBox });
    paintColumnSummary(stage.key);

    // BO-F6-10 C18: the drop target is marked while a card hovers it, so CSS
    // can paint the dashed outline; the dragged card is attenuated the same way.
    columnNodes.push(column);
    column.addEventListener('dragover', (event) => {
      // Dan 11/11: without stored positions the source column takes no drop
      // — a reorder would not survive a reload. Without preventDefault the
      // browser shows «not allowed» and a release there moves nothing.
      // 67a3116f4f65: on a board that stores positions the source column
      // takes the drop too — a reorder now survives a reload.
      if (drag && drag.fromStage === stage.key && !positionsOf(pipeline)) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      toggleHook(column, 'drop-target', true);
      if (drag) showSlot(column, Number(event?.clientY), positionsOf(pipeline));
    });
    column.addEventListener('dragleave', (event) => {
      // Entering a child card still hovers this column: only a true exit
      // unmarks it, otherwise the marker flickers while crossing children.
      if (event?.relatedTarget && column.contains(event.relatedTarget)) return;
      toggleHook(column, 'drop-target', false);
      if (slot && slot.parentNode === column) hideSlot();
    });
    column.addEventListener('drop', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      unmarkDropTargets();
      const payload = event?.dataTransfer?.getData?.('text/plain') ?? '';
      void handleDrop(pipeline, stage.key, payload, column);
    });
    // Test hook: drive a drop without a real DataTransfer.
    column.__drop = (payload) => handleDrop(pipeline, stage.key, payload, column);

    if (!records.length) {
      const empty = emptyLine();
      column.appendChild(empty);
      slotAnchors.set(column, empty);
      return column;
    }
    for (const [index, record] of records.entries()) {
      const card = renderCard(pipeline, stage, record, token);
      if (index === 0) slotAnchors.set(column, card);
      column.appendChild(card);
    }
    return column;
  }

  /** One card: safe minimal summary plus the accessible move control; draggable. */
  function renderCard(pipeline, stage, record, token) {
    const card = el(doc, 'div', {
      class: 'pipeline-card',
      attrs: { 'data-record': String(record.id), draggable: 'true' },
    });
    cardElements.set(String(record.id), card);
    card.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
    // backlog:7b2203e69826: the customer the offer is for — the contact,
    // else the company — never «Senza azienda».
    card.appendChild(el(doc, 'p', { class: 'card-company', text: customerName(record) ?? '—' }));
    card.appendChild(el(doc, 'p', { class: 'card-value', text: formatAmount(record.valueCents, record.currency) }));
    // BO-F6-10 C15: the referente badge shows the initials; the accessible
    // title carries the full name. Class hook unchanged (supervisor owns CSS).
    if (typeof record.owner === 'string' && record.owner) {
      // backlog:7b2203e69826: the initials name the person — on hover and
      // for a screen reader («Referente: Guido Presti»).
      const who = `Referente: ${ownerText(record.owner)}`;
      card.appendChild(el(doc, 'p', {
        class: 'card-owner',
        text: ownerInitials(ownerText(record.owner)),
        attrs: { title: who, 'aria-label': who },
      }));
    }
    // BO-F6-10 C13: the close line follows the spec pattern `chiusura <data>`.
    const closeDay = italianDay(record.expectedCloseDate);
    if (closeDay) {
      card.appendChild(el(doc, 'p', { class: 'card-close', text: `chiusura ${closeDay}` }));
    }
    if (stage.type === 'lost' && record.closeReason) {
      card.appendChild(el(doc, 'p', { class: 'card-reason', text: String(record.closeReason) }));
    }
    card.addEventListener('dragstart', (event) => {
      // A card whose move is still being written stays put.
      if (card.getAttribute('aria-busy') === 'true') {
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        return;
      }
      event?.dataTransfer?.setData?.('text/plain', JSON.stringify({ id: record.id, fromStage: stage.key }));
      if (event?.dataTransfer && 'effectAllowed' in event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      const box = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
      const height = Number(box?.height ?? card.offsetHeight ?? 0);
      drag = { id: String(record.id), fromStage: stage.key, height: Number.isFinite(height) ? height : 0 };
      toggleHook(card, 'dragging', true);
    });
    card.addEventListener('dragend', () => {
      // Drop, Esc or a release outside a column: the slot and the marks go.
      drag = null;
      hideSlot();
      toggleHook(card, 'dragging', false);
      unmarkDropTargets();
    });

    // Dan 11/11: Apri opens the offer panel over the board — the card never
    // expands in place and the board stays where it was. Only the
    // opportunity board offers it: a generated staged module has its own
    // record screen behind its rows.
    const detailed = pipeline.module === 'opportunity';
    if (detailed) {
      const open = el(doc, 'button', {
        class: 'small secondary',
        text: 'Apri',
        attrs: { type: 'button', 'data-action': 'open-offer', 'aria-haspopup': 'dialog' },
      });
      openButtons.set(String(record.id), open);
      const go = () => openOfferDrawer(pipeline, String(record.id), open);
      open.addEventListener('click', go);
      card.appendChild(open);
      card.__open = go; // test hook
      // backlog:7b2203e69826: the whole card opens the panel, like a Trello
      // card; its own controls (Apri, Sposta, Conferma, Riprova) keep their
      // click, and a click that ends a text selection stays on the board.
      card.setAttribute('data-openable', 'true');
      // backlog:85630aa14a4f (verifica 14/11): a press that starts on one of
      // the card's own controls never opens the panel, even when the click
      // lands on the card itself — the press may move the layout under the
      // pointer (Riprova pressed, then the click arrived on the card).
      let pressedControl = false;
      card.addEventListener('pointerdown', (event) => {
        const target = event?.target ?? null;
        pressedControl = Boolean(target && typeof target.closest === 'function' && target.closest(CARD_CONTROLS));
      });
      card.addEventListener('click', (event) => {
        const fromControl = pressedControl;
        pressedControl = false;
        if (fromControl) return;
        const target = event?.target ?? null;
        if (target && typeof target.closest === 'function'
          && target.closest(CARD_CONTROLS)) return;
        const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
        if (selection && selection.isCollapsed === false && String(selection) !== '') return;
        go();
      });
    }

    // Terminal stages have no move control (server enforces it regardless).
    if (stage.type !== 'open') return card;

    const controls = el(doc, 'div', { class: 'card-move' });
    const selectId = `move-${record.id}`;
    const label = el(doc, 'label', { text: 'Sposta in', attrs: { for: selectId } });
    const select = el(doc, 'select', { attrs: { id: selectId } });
    // backlog:85630aa14a4f: a card repainted while its move is in flight
    // (a filter, a reopened panel) offers the column on screen, not the one
    // the record still names until the server answers.
    const seated = seatedStages.get(String(record.id));
    const menuStage = moveLocks.has(String(record.id)) && typeof seated === 'string' ? seated : stage.key;
    for (const target of pipeline.stages) {
      if (target.key === menuStage) continue;
      select.appendChild(el(doc, 'option', { text: target.label, attrs: { value: target.key } }));
    }
    const moveButton = el(doc, 'button', { class: 'small primary', text: 'Sposta', attrs: { type: 'button' } });
    const errorNode = el(doc, 'small', { class: 'field-error hidden' });
    // The card's own status line while a move is in flight: «Spostamento in
    // corso…», then «Non ancora confermato» with Riprova once the pending
    // read times out. Riprova re-reads the board — never a second POST: a
    // move that landed meanwhile would only answer a stale-stage refusal.
    const statusNode = el(doc, 'small', { class: 'card-status hidden', attrs: { role: 'status', 'aria-live': 'polite' } });
    const retryButton = el(doc, 'button', { class: 'small secondary hidden', text: 'Riprova', attrs: { type: 'button', 'data-action': 'move-retry' } });
    /** backlog:85630aa14a4f: after a failure, the same move again; while unconfirmed, a board read. */
    let resendMove = null;
    retryButton.addEventListener('click', (event) => {
      // The click is Riprova's alone: it never reaches the card (which opens the panel).
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      const again = resendMove;
      if (again) void uiBusy(retryButton, 'Riprovo…', () => again());
      else void renderBoard(pipeline.name);
    });
    const showStatus = (text, retry) => {
      statusNode.textContent = text;
      statusNode.setAttribute('class', text ? 'card-status' : 'card-status hidden');
      retryButton.setAttribute('class', retry ? 'small secondary' : 'small secondary hidden');
    };

    // Voce 96e7b579: Vinta and Persa never post straight from Sposta or a
    // drop. They reveal the Conferma panel — the question names the offer
    // and the target label, Persa adds the mandatory reason input — and
    // only Conferma posts the same move-stage action. Moves between open
    // stages keep the direct post.
    const confirmPanel = createStageConfirm(doc);
    const {
      box: confirmBox, question: confirmQuestion, reason: confirmReason,
      yes: confirmYes, no: confirmNo, error: confirmError,
    } = confirmPanel;

    const id = String(record.id);
    /** Dan 11/11: the card itself shows the wait, wherever the move began. */
    const markCardBusy = (on) => {
      card.setAttribute('aria-busy', on ? 'true' : 'false');
      moveButton.disabled = on;
      moveButton.setAttribute('aria-busy', on ? 'true' : 'false');
      confirmYes.disabled = on;
    };
    const cardView = {
      start() {
        resendMove = null;
        markCardBusy(true);
        errorNode.textContent = '';
        errorNode.setAttribute('class', 'field-error hidden');
        confirmError.textContent = '';
        confirmError.setAttribute('class', 'field-error hidden');
        showStatus(MOVE_IN_FLIGHT, false);
      },
      // backlog:85630aa14a4f: the wait stays said while it lasts — the slow
      // note joins «Spostamento in corso…», never replaces it.
      slow() { showStatus(`${MOVE_IN_FLIGHT} ${MOVE_SLOW}`, false); },
      unconfirmed() { resendMove = null; showStatus(MOVE_UNCONFIRMED, true); },
      fail(message, resend = null) {
        markCardBusy(false);
        // backlog:85630aa14a4f: Riprova sends the same move again, when it
        // may pass; a refusal shows its line alone.
        resendMove = resend;
        showStatus('', resend !== null);
        errorNode.textContent = message;
        errorNode.setAttribute('class', 'field-error');
      },
    };
    // A card painted while its offer still has a move running (a filter, a
    // reopened panel) shows the same wait and stays locked.
    const lock = moveLocks.get(id);
    if (lock) {
      markCardBusy(true);
      showStatus(lock === 'queued' ? MOVE_UNCONFIRMED : MOVE_IN_FLIGHT, lock === 'queued');
    }
    /**
     * @returns {Promise<{ moved?: true, pending?: true, busy?: true, failed?: true, message?: string }>}
     */
    const doPost = (toStage, reason, placement = null) => runMove(pipeline, record.id, stage.key, toStage, reason, { placement });
    const confirm = async () => {
      const pending = pendingConfirm.get(String(record.id));
      if (!pending) return;
      const target = pipeline.stages.find((candidate) => candidate.key === pending.toStage);
      const answer = readStageConfirm(confirmPanel, target);
      if (!answer.ok) return;
      await doPost(pending.toStage, answer.reason, pending.placement ?? null);
    };
    const cancelConfirm = () => {
      pendingConfirm.delete(String(record.id));
      confirmBox.setAttribute('class', 'card-confirm hidden');
      select.value = stage.key;
      renderAll(renderToken);
    };
    const submit = async () => {
      if (moveLocks.has(id)) return;
      errorNode.textContent = '';
      errorNode.setAttribute('class', 'field-error hidden');
      const toStage = select.value;
      const target = pipeline.stages.find((candidate) => candidate.key === toStage);
      if (target && stageNeedsConfirm(target)) {
        revealConfirm(pipeline, record, stage.key, toStage);
        return;
      }
      await doPost(toStage, undefined);
    };
    moveButton.addEventListener('click', submit);
    confirmYes.addEventListener('click', confirm);
    confirmNo.addEventListener('click', cancelConfirm);
    controls.appendChild(label);
    controls.appendChild(select);
    controls.appendChild(moveButton);
    card.appendChild(controls);
    // Dan 11/11: the wait, the failure and Riprova sit on the card itself,
    // outside the keyboard-only «Sposta in» row (visually hidden to the
    // mouse), so a dropped card shows them too.
    card.appendChild(errorNode);
    card.appendChild(statusNode);
    card.appendChild(retryButton);
    card.appendChild(confirmBox);
    cardNodes.set(String(record.id), {
      card, select, errorNode, confirmPanel, confirmBox, confirmQuestion, confirmReason, confirmYes, confirmNo, confirmError,
      view: cardView,
      move: (toStage) => doPost(toStage, undefined),
    });
    card.__move = submit; // test hook
    card.__select = select;
    card.__reason = confirmReason;
    card.__confirm = confirm;
    card.__cancelConfirm = cancelConfirm;
    return card;
  }

  /**
   * Voce 96e7b579: reveal the Conferma panel for a won/lost move — shared
   * by the Sposta button and drops onto won/lost columns. The question
   * names the offer and the target label; Persa shows the mandatory reason
   * input. Answers false when the card has no live controls (a terminal
   * card), so the caller can say so honestly instead of posting blind.
   * @param {any} pipeline @param {Record<string, any>} record
   * @param {string} fromStage @param {string} toStage
   */
  function revealConfirm(pipeline, record, fromStage, toStage, placement = null) {
    const controls = cardNodes.get(String(record.id));
    if (!controls) return false;
    const target = pipeline.stages.find((candidate) => candidate.key === toStage);
    if (!target) return false;
    pendingConfirm.set(String(record.id), { fromStage, toStage, placement });
    controls.select.value = toStage;
    showStageConfirm(controls.confirmPanel, String(record.name ?? record.id), target);
    return true;
  }

  /**
   * The open offer panel (Dan 11/11): the composer window of the scheda
   * (`bo-scheda-composer`, dark head, ✕) over the board. One at a time.
   * @type {null | { node: any, body: any, title: any, close: any, recordId: string, pipelineName: string, opener: any, paintedFrom: any, moveView?: any, detach: () => void }}
   */
  let drawer = null;

  /** Scheda cliente of the offer: the contact when named, else its company. */
  function customerHref(record) {
    const contactId = typeof record?.contactId === 'string' && record.contactId !== '' ? record.contactId : null;
    if (contactId) return `#/customer-card/contact/${encodeURIComponent(contactId)}`;
    const companyId = typeof record?.companyId === 'string' && record.companyId !== '' ? record.companyId : null;
    return companyId ? `#/customer-card/company/${encodeURIComponent(companyId)}` : null;
  }

  /** The customer's name as the scheda shows it: the contact, else the company. */
  function customerName(record) {
    // One rule with the Lista (review Muse #799): customerOf.
    return customerOf(record);
  }


  /**
   * Apri on a card: the offer panel over the board. Opening never
   * re-renders the board, closing never does either, so the scroll stays.
   * @param {any} pipeline @param {string} recordId @param {any} opener
   */
  function openOfferDrawer(pipeline, recordId, opener) {
    const record = cached.records.find((candidate) => String(candidate.id) === recordId);
    if (!record) return;
    closeOfferDrawer({ refocus: false });
    const node = el(doc, 'div', {
      class: 'bo-scheda-composer bo-pipeline-offer',
      attrs: { role: 'dialog', 'aria-modal': 'false', 'data-offer-drawer': recordId },
    });
    const head = el(doc, 'div', { class: 'bo-composer-head' });
    const title = el(doc, 'h4', { class: 'bo-composer-title' });
    head.appendChild(title);
    const close = el(doc, 'button', {
      class: 'bo-composer-icon',
      text: '✕',
      attrs: { type: 'button', 'aria-label': 'Chiudi', 'data-action': 'offer-drawer-close' },
    });
    // backlog:85630aa14a4f: focus goes back to Apri only for a keyboard
    // close (Enter on × has detail 0, a mouse click does not) — a mouse
    // close must not light the keyboard-only «Sposta in» row through
    // :focus-within.
    // backlog:85630aa14a4f: a mouse × hands focus back to the open card too,
    // with no focus ring (the keyboard-only «Sposta in» row stays hidden).
    close.addEventListener('click', (event) => closeOfferDrawer({ refocus: event?.detail === 0 ? true : 'pointer' }));
    head.appendChild(close);
    node.appendChild(head);
    const body = el(doc, 'div', { class: 'bo-composer-body bo-pipeline-offer-body' });
    node.appendChild(body);

    const onKey = (event) => {
      if (event?.key !== 'Escape' || !drawer || drawer.node !== node) return;
      // Esc inside an open Conferma or a select is still a close: the panel
      // is the only layer the pipeline opens over the board.
      closeOfferDrawer({ refocus: true });
    };
    const onPointer = (event) => {
      if (!drawer || drawer.node !== node) return;
      // A panel the router took off the page only lets go of its listeners.
      if (!node.parentNode) { closeOfferDrawer({ refocus: false }); return; }
      const target = event?.target ?? null;
      if (target && node.contains(target)) return;
      // backlog:85630aa14a4f: a click on empty board gives focus back to the
      // card; a click on a field or a button keeps it there.
      closeOfferDrawer({ refocus: 'outside' });
    };
    node.addEventListener('keydown', onKey);
    const docListens = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
    // pointerdown, not click: the click that opened the panel has already
    // gone by, so it can never close it on the way up.
    if (docListens) {
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('pointerdown', onPointer);
    }
    drawer = {
      node, body, recordId, pipelineName: pipeline.name, opener, paintedFrom: null,
      title, close,
      detach: () => {
        if (docListens) {
          doc.removeEventListener('keydown', onKey);
          doc.removeEventListener('pointerdown', onPointer);
        }
      },
    };
    paintOfferDrawer(pipeline, record);
    mount.appendChild(node);
    // backlog:85630aa14a4f: where the board was before the panel moved it —
    // closing brings it back, at 1024 px like at 1280.
    const openCard = cardElements.get(recordId) ?? null;
    const openBoard = openCard?.parentNode?.parentNode ?? null;
    drawer.savedScroll = openBoard ? Number(openBoard.scrollLeft ?? 0) : null;
    keepOpenColumnInView();
    markOpenCard();
    if (typeof close.focus === 'function') close.focus();
    node.__close = () => closeOfferDrawer({ refocus: true }); // test hook
  }

  /** The open offer's card carries the mark (style hook + aria-current). */
  function markOpenCard() {
    for (const [id, card] of cardElements) {
      const open = drawer !== null && id === drawer.recordId;
      toggleHook(card, 'is-open', open);
      if (open) card.setAttribute('aria-current', 'true');
      else if (typeof card.removeAttribute === 'function') card.removeAttribute('aria-current');
    }
  }

  /**
   * Close the offer panel; with `refocus`, focus goes back to the open
   * card's Apri — true: the keyboard closed it; 'pointer': a mouse ×, the
   * page does not scroll; 'outside': a press outside, only if focus landed
   * nowhere.
   * @param {{ refocus: boolean | 'pointer' | 'outside' }} options
   */
  function closeOfferDrawer({ refocus }) {
    if (!drawer) return;
    const { node, opener, recordId, detach, savedScroll } = drawer;
    drawer = null;
    detach();
    if (node.parentNode) node.parentNode.removeChild(node);
    freeOfferRoom();
    // backlog:85630aa14a4f: the board goes back to where it was before the
    // panel moved it; the open mark leaves with the panel.
    markOpenCard();
    const card = cardElements.get(recordId) ?? null;
    const boardEl = card?.parentNode?.parentNode ?? null;
    if (typeof savedScroll === 'number' && Number.isFinite(savedScroll) && boardEl) {
      boardEl.scrollLeft = savedScroll;
    }
    if (!refocus) return;
    const live = opener && mount.contains(opener) ? opener : openButtons.get(recordId) ?? null;
    if (!live || typeof live.focus !== 'function') return;
    if (refocus === true) { live.focus(); return; }
    // The mouse closed it: focus goes back and the page does not jump; after
    // a mouse click the browser's own :focus-visible shows no ring (review
    // Muse #893: no non-standard option).
    const quiet = () => live.focus({ preventScroll: true });
    if (refocus === 'pointer') { quiet(); return; }
    // A press outside: the browser moves focus after this pointerdown (to
    // the field or button pressed, else nowhere). Only when it landed
    // nowhere does the open card take it back.
    void wait(0).then(() => {
      const active = doc.activeElement ?? null;
      if ((active === null || active === doc.body) && mount.contains(live)) quiet();
    });
  }

  /**
   * The panel's content from one record: who, how much, which stage, the
   * stage change (open stages only, the same move-stage action and Conferma
   * as the card) and the way to the scheda cliente and the full offer.
   * @param {any} pipeline @param {Record<string, any>} record
   */
  function paintOfferDrawer(pipeline, record) {
    if (!drawer) return;
    const { body, title, node } = drawer;
    drawer.paintedFrom = record;
    // A closed stage paints no Cambia fase: no stale move view either.
    drawer.moveView = null;
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : 'Offerta senza nome';
    const customer = customerName(record);
    title.textContent = name;
    if (customer) title.appendChild(el(doc, 'span', { class: 'bo-composer-to-name', text: ` · ${customer}` }));
    node.setAttribute('aria-label', `Offerta ${name}`);
    while (body.firstChild) body.removeChild(body.firstChild);

    const stage = pipeline.stages.find((candidate) => candidate.key === record.pipelineStage);
    const facts = el(doc, 'div', { class: 'offer-facts' });
    for (const [label, value] of [
      ['Cliente', customer ?? '—'],
      ['Valore', Number.isSafeInteger(record.valueCents) ? formatAmount(record.valueCents, record.currency) : '—'],
      ['Fase', stageLabel(pipeline, record.pipelineStage)],
      ['Chiusura prevista', dayOf(record.expectedCloseDate) ?? '—'],
      ['Referente', typeof record.owner === 'string' && record.owner ? ownerText(record.owner) : '—'],
    ]) {
      const cell = el(doc, 'p', { class: 'offer-fact' });
      cell.appendChild(el(doc, 'span', { class: 'offer-fact-label', text: label }));
      cell.appendChild(el(doc, 'span', { class: 'offer-fact-value', text: value }));
      facts.appendChild(cell);
    }
    body.appendChild(facts);

    if (stage && stage.type === 'open') body.appendChild(drawerStageChange(pipeline, record, stage));

    const links = el(doc, 'div', { class: 'bo-pipeline-offer-links' });
    const href = customerHref(record);
    if (href) {
      links.appendChild(el(doc, 'a', {
        class: 'ui-btn ui-btn-primary ui-btn-small',
        text: 'Apri scheda cliente',
        attrs: { href, 'data-action': 'open-customer-card' },
      }));
    }
    links.appendChild(el(doc, 'a', {
      class: 'ui-btn ui-btn-secondary ui-btn-small',
      text: 'Vedi tutta l’offerta',
      attrs: { href: `#/offerte/${encodeURIComponent(String(record.id))}`, 'data-action': 'open-offer-page' },
    }));
    body.appendChild(links);
  }

  /** «Cambia fase» in the panel: the card's move, with its Conferma for won and lost. */
  function drawerStageChange(pipeline, record, stage) {
    const box = el(doc, 'div', { class: 'bo-pipeline-offer-move', attrs: { 'data-drawer-move': 'true' } });
    const selectId = `drawer-move-${record.id}`;
    box.appendChild(el(doc, 'label', { text: 'Cambia fase', attrs: { for: selectId } }));
    const row = el(doc, 'div', { class: 'bo-pipeline-offer-move-row' });
    // backlog:2f72000d4a4d: the menu starts on the offer's own stage (marked
    // «attuale»), never on the first stage of the pipeline; Sposta waits
    // until another stage is chosen.
    const select = el(doc, 'select', { attrs: { id: selectId } });
    for (const target of pipeline.stages) {
      const current = target.key === stage.key;
      const option = el(doc, 'option', {
        text: current ? `${target.label ?? target.key} (attuale)` : (target.label ?? target.key),
        attrs: { value: target.key },
      });
      if (current) option.setAttribute('selected', 'selected');
      select.appendChild(option);
    }
    select.value = stage.key;
    const go = el(doc, 'button', { class: 'small primary', text: 'Sposta', attrs: { type: 'button', 'data-action': 'drawer-move' } });
    const syncGo = () => {
      if (moveLocks.has(String(record.id))) return;
      go.disabled = select.value === stage.key;
    };
    select.addEventListener('change', syncGo);
    syncGo();
    row.appendChild(select);
    row.appendChild(go);
    box.appendChild(row);
    const status = el(doc, 'small', { class: 'card-status hidden', attrs: { role: 'status', 'aria-live': 'polite' } });
    const error = el(doc, 'small', { class: 'field-error hidden', attrs: { role: 'alert' } });
    box.appendChild(status);
    box.appendChild(error);
    const confirmPanel = createStageConfirm(doc);
    box.appendChild(confirmPanel.box);
    const retry = el(doc, 'button', {
      class: 'small secondary hidden', text: 'Riprova', attrs: { type: 'button', 'data-action': 'drawer-move-retry' },
    });
    // backlog:85630aa14a4f: after a failure Riprova sends the same move
    // again; while unconfirmed it re-reads the board, never a second POST
    // (review #657).
    let resendMove = null;
    retry.addEventListener('click', (event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      const again = resendMove;
      if (again) void uiBusy(retry, 'Riprovo…', () => again());
      else void renderBoard(pipeline.name);
    });
    box.appendChild(retry);
    let pending = null;
    const id = String(record.id);
    const say = (node, text) => {
      node.textContent = text;
      const base = node === status ? 'card-status' : 'field-error';
      node.setAttribute('class', text ? base : `${base} hidden`);
    };
    const lockControls = (on) => {
      go.disabled = on || select.value === stage.key;
      go.setAttribute('aria-busy', on ? 'true' : 'false');
      confirmPanel.yes.disabled = on;
    };
    // Review #774 (P2): the panel shows the same move as the card — one lock
    // per offer, the bounded «Non ancora confermato» with Riprova.
    drawer.moveView = {
      start() {
        resendMove = null;
        lockControls(true);
        say(error, '');
        say(status, MOVE_IN_FLIGHT);
        retry.setAttribute('class', 'small secondary hidden');
      },
      // backlog:85630aa14a4f: the wait stays said while it lasts.
      slow() { say(status, `${MOVE_IN_FLIGHT} ${MOVE_SLOW}`); },
      unconfirmed() {
        resendMove = null;
        say(status, MOVE_UNCONFIRMED);
        retry.setAttribute('class', 'small secondary');
      },
      fail(message, resend = null) {
        lockControls(false);
        say(status, '');
        // backlog:85630aa14a4f: Riprova in the panel too, when the move may pass.
        resendMove = resend;
        retry.setAttribute('class', resend ? 'small secondary' : 'small secondary hidden');
        say(error, message);
      },
    };
    const lock = moveLocks.get(id);
    if (lock) {
      lockControls(true);
      say(status, lock === 'queued' ? MOVE_UNCONFIRMED : MOVE_IN_FLIGHT);
      if (lock === 'queued') retry.setAttribute('class', 'small secondary');
    }
    const post = async (toStage, reason) => {
      const outcome = await runMove(pipeline, record.id, record.pipelineStage, toStage, reason);
      // The board re-read repaints this panel; focus, whose button the
      // repaint replaced, lands on its ✕.
      if (outcome.moved && drawer && typeof drawer.close?.focus === 'function') drawer.close.focus();
    };
    go.addEventListener('click', () => {
      if (moveLocks.has(id)) return;
      const toStage = select.value;
      if (toStage === stage.key) return; // the current stage is where it is
      const target = pipeline.stages.find((candidate) => candidate.key === toStage);
      if (!target) return;
      if (stageNeedsConfirm(target)) {
        pending = target;
        showStageConfirm(confirmPanel, String(record.name ?? 'questa offerta'), target);
        return;
      }
      void post(toStage, undefined);
    });
    confirmPanel.yes.addEventListener('click', () => {
      if (!pending) return;
      const answer = readStageConfirm(confirmPanel, pending);
      if (!answer.ok) return;
      void post(pending.key, answer.reason);
    });
    confirmPanel.no.addEventListener('click', () => {
      pending = null;
      confirmPanel.box.setAttribute('class', 'card-confirm hidden');
    });
    return box;
  }

  return { renderBoard };
}
