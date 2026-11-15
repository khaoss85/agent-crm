// @ts-check

import { el } from './admin-ui.js'; // BO-F6-02: the single component library.
import { customerOf } from './admin-pipeline.js';

// backlog:be99004b06e4 — ⌘K finds before it asks. Typing in the top bar
// lists the matching /bo pages, customers and offers at once, from local
// data (the shell's own voices) and from reads the /bo already makes (the
// Clienti list with `q`, the Pipeline offers read). The AI stays one
// explicit row at the bottom, «Chiedi all'assistente: …», never the default
// path for a name. Model: Linear / Attio command palette.
//
// Conventions follow admin-shell.js: the row builders are pure and
// DOM-free; the menu renders with createElement + textContent only, so a
// hostile customer or offer name stays inert text.

/** Remote groups (customers, offers) start from this many characters. */
export const COMMAND_MIN_CHARS = 2;
/** Rows per group, like Linear: a short list, never a page of results. */
export const COMMAND_GROUP_LIMIT = 5;
/** Wait after the last keystroke before reading customers. */
export const COMMAND_DEBOUNCE_MS = 180;
/** The offers read is reused while the menu stays in use. */
export const COMMAND_OFFERS_TTL_MS = 60_000;
/** The agents read is reused while the menu stays in use. */
export const COMMAND_AGENTS_TTL_MS = 60_000;

const RECORD_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const RESOURCE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Lowercase, accents off, spaces collapsed: «Attività» matches «attivita».
 * @param {unknown} value
 */
export function foldText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * 3 = the label starts with the query, 2 = a word does, 1 = it appears
 * inside, 0 = no match.
 * @param {unknown} label
 * @param {string} folded the folded query
 */
export function matchRank(label, folded) {
  const text = foldText(label);
  if (folded === '' || text === '') return 0;
  if (text.startsWith(folded)) return 3;
  if (text.split(' ').some((word) => word.startsWith(folded))) return 2;
  return text.includes(folded) ? 1 : 0;
}

/** @param {unknown} value */
function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ');
}

/**
 * A customer row from the Clienti list read (`/api/customer-data/customers`),
 * or null when the row cannot link to its scheda.
 * @param {any} item
 */
export function customerCommand(item) {
  if (!item || !RESOURCE_RE.test(String(item.resource ?? '')) || !RECORD_RE.test(String(item.id ?? ''))) return null;
  const company = cleanLabel(item.company?.name);
  return {
    kind: 'customer',
    label: cleanLabel(item.name) || 'Cliente senza nome',
    sub: company || cleanLabel(item.email),
    href: `#/customer-card/${encodeURIComponent(item.resource)}/${encodeURIComponent(item.id)}`,
  };
}

/**
 * An offer row from the Pipeline offers read (`/api/opportunities`), or null.
 * @param {any} item
 */
export function offerCommand(item) {
  if (!item || !RECORD_RE.test(String(item.id ?? ''))) return null;
  return {
    kind: 'offer',
    label: cleanLabel(item.name) || 'Offerta senza nome',
    // backlog:0a980182918f: the customer as the Pipeline card names it —
    // the contact, else the company, never the «Senza azienda» placeholder.
    sub: cleanLabel(customerOf(item) ?? ''),
    href: `#/offerte/${encodeURIComponent(item.id)}`,
  };
}

/**
 * An agent of the space as a palette row: «@Nome», with the mention text
 * choosing it writes back into the bar. Rows without a name or without a
 * source key never suggest (admin-agenti.js findMentionedAgent reads the
 * same two fields), a cap never hides one — the assistant names it.
 * @param {any} item
 */
export function agentCommand(item) {
  if (!item || typeof item !== 'object') return null;
  const name = cleanLabel(item.name);
  const sourceKey = typeof item.sourceKey === 'string' ? item.sourceKey.trim() : '';
  if (name === '' || sourceKey === '') return null;
  return {
    kind: 'agent',
    label: `@${name}`,
    sub: cleanLabel(item.role),
    href: '',
    text: `@${name} `,
  };
}

/**
 * The space's agents for a «@» query (backlog:fd1c564a21d9): the same
 * teammate-agent module read the Agenti screen makes, so the bar suggests
 * an agent whenever the screen itself could list one — never gated on the
 * navigation voice. A 404 reads as «not composed» (null, like no agents),
 * any other failure is thrown so the bar names the failed read.
 * MEM_ACC_REUSE: no new record, the packages/agents managed module.
 * @param {(path: string) => Promise<any>} request
 * @param {unknown} spaceId
 * @returns {Promise<Array<any> | null>}
 */
export async function readCommandAgents(request, spaceId) {
  const id = typeof spaceId === 'string' ? spaceId.trim() : '';
  if (id === '') return null;
  const params = new URLSearchParams({ limit: '201' });
  params.set('filter.spaceId', id);
  try {
    const answer = await request(`/api/modules/teammate-agent/records?${params.toString()}`);
    return Array.isArray(answer?.items) ? answer.items : [];
  } catch (error) {
    const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
    if (record.status === 404 || record.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/**
 * The palette rows for one query, in display order: Pagine, Clienti,
 * Offerte, then the explicit ask row. A query starting with «@» talks to an
 * agent (admin-assistant.js): the space's matching agents first (backlog
 * 1f7cb20d3c30 — the hand-written agent suggests like the catalogue ones),
 * then the ask row, which hands the whole line to the assistant.
 * @param {{ query: unknown, pages?: Array<{ label: string, href: string, sub?: string }>, customers?: Array<any> | null, offers?: Array<any> | null, agents?: Array<any> | null }} input
 * @returns {Array<{ kind: string, group: string, label: string, sub: string, href: string, text?: string }>}
 */
export function buildCommandRows({ query, pages = [], customers = null, offers = null, agents = null }) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return [];
  const ask = { kind: 'ask', group: '', label: `Chiedi all’assistente: «${text}»`, sub: '', href: '', text };
  if (text.startsWith('@')) {
    const folded = foldText(text.slice(1));
    const ranked = [];
    const seen = new Set();
    for (const item of Array.isArray(agents) ? agents : []) {
      const row = agentCommand(item);
      if (row === null || seen.has(row.label)) continue;
      seen.add(row.label);
      // A bare «@» lists the team; longer words filter by name.
      const rank = folded === '' ? 3 : matchRank(row.label.slice(1), folded);
      if (rank > 0) ranked.push({ row, rank });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    const rows = [];
    for (const { row } of ranked.slice(0, COMMAND_GROUP_LIMIT)) {
      rows.push({ ...row, group: 'Agenti' });
    }
    rows.push(ask);
    return rows;
  }
  const folded = foldText(text);
  /** @type {Array<{ kind: string, group: string, label: string, sub: string, href: string }>} */
  const rows = [];
  const seen = new Set();
  const ranked = pages
    .map((page) => ({ page, rank: matchRank(page?.label, folded) }))
    .filter((entry) => entry.rank > 0 && typeof entry.page.href === 'string' && entry.page.href.startsWith('#/'))
    .sort((a, b) => b.rank - a.rank);
  for (const { page } of ranked) {
    if (seen.has(page.label)) continue;
    seen.add(page.label);
    rows.push({ kind: 'page', group: 'Pagine', label: page.label, sub: page.sub ?? '', href: page.href });
    if (rows.length >= COMMAND_GROUP_LIMIT) break;
  }
  if (folded.length >= COMMAND_MIN_CHARS) {
    let count = 0;
    for (const item of Array.isArray(customers) ? customers : []) {
      const row = customerCommand(item);
      if (row === null) continue;
      rows.push({ ...row, group: 'Clienti' });
      count += 1;
      if (count >= COMMAND_GROUP_LIMIT) break;
    }
    const offerRows = (Array.isArray(offers) ? offers : [])
      .map((item) => {
        const row = offerCommand(item);
        if (row === null) return null;
        const rank = Math.max(matchRank(item.name, folded), matchRank(item.contactName, folded),
          // The real company only: «senza» never matches every offer.
          matchRank(customerOf({ companyName: item.companyName }), folded));
        return rank > 0 ? { row, rank } : null;
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => /** @type {any} */ (b).rank - /** @type {any} */ (a).rank)
      .slice(0, COMMAND_GROUP_LIMIT);
    for (const entry of offerRows) rows.push({ .../** @type {any} */ (entry).row, group: 'Offerte' });
  }
  rows.push(ask);
  return rows;
}

/**
 * The ⌘K results menu under the top-bar input. One controller lives for the
 * shell; `attach` binds it to the input each time the top bar re-renders,
 * keeping what was typed.
 *
 * @param {{
 *   doc: any,
 *   pages: () => Array<{ label: string, href: string, sub?: string }>,
 *   search?: { customers?: (query: string) => Promise<Array<any> | null>, offers?: () => Promise<Array<any> | null>, agents?: () => Promise<Array<any> | null> } | null,
 *   navigate: (href: string) => void,
 *   ask: (text: string) => void,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   cancel?: (handle: any) => void,
 *   now?: () => number,
 * }} options
 */
export function createCommandMenu({
  doc, pages, search = null, navigate, ask,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  now = () => Date.now(),
}) {
  const state = {
    query: '',
    open: false,
    active: 0,
    /** @type {Array<any> | null} */
    customers: null,
    customersFor: '',
    customersLoading: false,
    /** @type {Array<any> | null} */
    offers: null,
    offersAt: 0,
    offersLoading: false,
    offersStartedAt: 0,
    enterWaited: false,
    // Review #779: a read that failed is not «no match» — the list says so.
    customersFailed: false,
    offersFailed: false,
    // backlog:1f7cb20d3c30: the @ rows read the space's agents, same rules.
    /** @type {Array<any> | null} */
    agents: null,
    agentsAt: 0,
    agentsLoading: false,
    agentsStartedAt: 0,
    agentsFailed: false,
    // Review #779 P1: the Enter that already chose a row also ends the
    // form submit that may follow it — one action per Enter.
    consumed: false,
  };
  /** @type {any} */
  let input = null;
  /** @type {any} */
  let list = null;
  /** @type {any} */
  let timer = null;
  let token = 0;
  let offersToken = 0;
  let agentsToken = 0;

  /**
   * Review #779 P2: a failed read is logged (which read, status and code —
   * never the typed words or a record) and shown as its own state.
   * @param {string} read
   * @param {unknown} error
   */
  function logFailure(read, error) {
    const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[bo] ricerca ⌘K: lettura ${read} non riuscita`, {
        name: typeof record.name === 'string' ? record.name : null,
        status: typeof record.status === 'number' ? record.status : null,
        code: typeof record.code === 'string' ? record.code : null,
      });
    }
  }

  function rows() {
    const fresh = state.customersFor === state.query.trim() ? state.customers : null;
    return buildCommandRows({ query: state.query, pages: pages(), customers: fresh, offers: state.offers, agents: state.agents });
  }

  function setExpanded(open) {
    if (input !== null) input.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function render() {
    if (list === null) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    const current = rows();
    const shown = state.open && current.length > 0;
    list.classList.toggle('hidden', !shown);
    setExpanded(shown);
    if (!shown) {
      if (input !== null) input.removeAttribute('aria-activedescendant');
      return;
    }
    if (state.active >= current.length) state.active = current.length - 1;
    if (state.active < 0) state.active = 0;
    let group = '';
    current.forEach((row, index) => {
      if (row.kind === 'ask') {
        const remote = state.query.trim().length >= COMMAND_MIN_CHARS && !state.query.trim().startsWith('@');
        const atQuery = state.query.trim().startsWith('@');
        if (atQuery && state.agentsLoading) {
          list.appendChild(el(doc, 'p', 'bo-cmdk-status', 'Cerco gli agenti…'));
        } else if (atQuery && state.agentsFailed) {
          list.appendChild(el(doc, 'p', 'bo-cmdk-status bo-cmdk-failed', 'Non riesco a leggere gli agenti adesso: premi Invio per chiedere comunque all’assistente.'));
        } else if (remote && (state.customersLoading || state.offersLoading)) {
          list.appendChild(el(doc, 'p', 'bo-cmdk-status', 'Cerco tra clienti e offerte…'));
        } else if (remote && (state.customersFailed || state.offersFailed)) {
          const what = state.customersFailed && state.offersFailed
            ? 'clienti e offerte'
            : (state.customersFailed ? 'i clienti' : 'le offerte');
          list.appendChild(el(doc, 'p', 'bo-cmdk-status bo-cmdk-failed', `Non riesco a leggere ${what} adesso: riprova tra poco.`));
        } else if (remote && current.length === 1) {
          list.appendChild(el(doc, 'p', 'bo-cmdk-status', 'Nessun cliente, offerta o pagina con queste parole.'));
        }
      } else if (row.group !== group) {
        group = row.group;
        list.appendChild(el(doc, 'p', 'bo-cmdk-group', group));
      }
      const node = row.kind === 'ask'
        ? el(doc, 'button', 'bo-cmdk-row bo-cmdk-ask')
        : row.kind === 'agent'
          ? el(doc, 'button', 'bo-cmdk-row bo-cmdk-agent')
          : el(doc, 'a', 'bo-cmdk-row');
      node.setAttribute('role', 'option');
      node.setAttribute('id', `bo-cmdk-opt-${index}`);
      node.setAttribute('data-kind', row.kind);
      node.setAttribute('aria-selected', index === state.active ? 'true' : 'false');
      if (row.kind === 'ask') {
        node.setAttribute('type', 'button');
        node.setAttribute('tabindex', '-1');
        node.appendChild(el(doc, 'span', 'bo-cmdk-spark', '✦'));
      } else if (row.kind === 'agent') {
        node.setAttribute('type', 'button');
        node.setAttribute('tabindex', '-1');
      } else {
        node.setAttribute('href', row.href);
      }
      node.appendChild(el(doc, 'span', 'bo-cmdk-label', row.label));
      if (row.sub !== '') node.appendChild(el(doc, 'span', 'bo-cmdk-sub', row.sub));
      // The input keeps the focus: the row acts on click, never steals it.
      node.addEventListener('mousedown', (event) => {
        if (typeof event?.preventDefault === 'function') event.preventDefault();
      });
      node.addEventListener('click', (event) => {
        if (typeof event?.preventDefault === 'function') event.preventDefault();
        choose(row);
      });
      list.appendChild(node);
    });
    if (input !== null) input.setAttribute('aria-activedescendant', `bo-cmdk-opt-${state.active}`);
  }

  function reset() {
    state.query = '';
    state.open = false;
    state.active = 0;
    token += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    state.customersLoading = false;
    state.customersFailed = false;
    // Review #779 P1: an offers read still in flight never keeps the group
    // locked: its answer is dropped and the next query reads again.
    offersToken += 1;
    state.offersLoading = false;
    // backlog:1f7cb20d3c30: same for the agents read — a late answer never
    // lands in the next menu use.
    agentsToken += 1;
    state.agentsLoading = false;
    state.enterWaited = false;
    if (input !== null) input.value = '';
    render();
  }

  /**
   * An agent row completes the @mention in the bar and keeps the list open:
   * the operator adds the instruction, then Enter hands the whole line to
   * the assistant (backlog:1f7cb20d3c30). The selection parks on the ask
   * row, so the next Enter asks instead of completing again.
   * @param {{ kind: string, href: string, text?: string }} row
   */
  function fillMention(row) {
    const mention = typeof row.text === 'string' && row.text !== '' ? row.text : `${String(row.label ?? '').trim()} `;
    if (input !== null) input.value = mention;
    state.query = mention;
    state.open = mention.trim() !== '';
    state.customersFailed = false;
    state.active = Math.max(rows().length - 1, 0);
    render();
  }

  /** @param {{ kind: string, href: string, text?: string }} row */
  function choose(row) {
    if (row.kind === 'ask') {
      const text = String(row.text ?? '');
      reset();
      ask(text);
      return;
    }
    if (row.kind === 'agent') {
      fillMention(row);
      return;
    }
    reset();
    navigate(row.href);
  }

  async function loadOffers() {
    if (typeof search?.offers !== 'function') return;
    // A read in flight is reused — unless it hangs past the TTL, then a
    // fresh one replaces it (its late answer is dropped by the token).
    if (state.offersLoading && now() - state.offersStartedAt < COMMAND_OFFERS_TTL_MS) return;
    if (!state.offersLoading && state.offers !== null && now() - state.offersAt < COMMAND_OFFERS_TTL_MS) return;
    const mine = (offersToken += 1);
    state.offersLoading = true;
    state.offersStartedAt = now();
    render();
    let items = null;
    let failed = false;
    try {
      items = await search.offers();
    } catch (error) {
      failed = true;
      logFailure('offerte', error);
    }
    if (mine !== offersToken) return;
    state.offersLoading = false;
    state.offersFailed = failed;
    state.offers = Array.isArray(items) ? items : null;
    // A failure is retried at the next keystroke, never cached for a minute.
    state.offersAt = failed ? 0 : now();
    render();
  }

  /**
   * The space's agents for a «@» query (backlog:1f7cb20d3c30): read once
   * per menu use like the offers read, dropped on a newer menu generation.
   */
  async function loadAgents() {
    if (typeof search?.agents !== 'function') return;
    if (state.agentsLoading && now() - state.agentsStartedAt < COMMAND_AGENTS_TTL_MS) return;
    if (!state.agentsLoading && state.agents !== null && now() - state.agentsAt < COMMAND_AGENTS_TTL_MS) return;
    const mine = (agentsToken += 1);
    state.agentsLoading = true;
    state.agentsStartedAt = now();
    render();
    let items = null;
    let failed = false;
    try {
      items = await search.agents();
    } catch (error) {
      failed = true;
      logFailure('agenti', error);
    }
    if (mine !== agentsToken) return;
    state.agentsLoading = false;
    state.agentsFailed = failed;
    state.agents = Array.isArray(items) ? items : null;
    state.agentsAt = failed ? 0 : now();
    render();
  }

  async function loadCustomers(query) {
    const mine = (token += 1);
    let items = null;
    let failed = false;
    try {
      items = await /** @type {any} */ (search).customers(query);
    } catch (error) {
      failed = true;
      logFailure('clienti', error);
    }
    // A newer query (or a closed menu) wins: a slow answer never lands
    // under words the operator already changed.
    if (mine !== token) return;
    state.customersLoading = false;
    state.customersFailed = failed;
    state.customers = Array.isArray(items) ? items : null;
    state.customersFor = query;
    render();
  }

  function onInput() {
    state.query = typeof input?.value === 'string' ? input.value : '';
    state.open = state.query.trim() !== '';
    state.active = 0;
    state.enterWaited = false;
    state.customersFailed = false;
    if (timer !== null) cancel(timer);
    timer = null;
    const query = state.query.trim();
    const remote = query.length >= COMMAND_MIN_CHARS && !query.startsWith('@');
    const atQuery = query.startsWith('@');
    if (remote && typeof search?.customers === 'function') {
      state.customersLoading = true;
      token += 1;
      timer = schedule(() => {
        timer = null;
        void loadCustomers(query);
      }, COMMAND_DEBOUNCE_MS);
    } else {
      token += 1;
      state.customersLoading = false;
    }
    if (remote) void loadOffers();
    // backlog:1f7cb20d3c30: «@» never searches customers or offers — it
    // reads the space's agents, so the new agent suggests like the catalogue.
    if (atQuery) void loadAgents();
    render();
  }

  function move(step) {
    const count = rows().length;
    if (count === 0) return;
    state.active = (state.active + step + count) % count;
    render();
  }

  /**
   * Enter, from a key or from the form submit (mobile «Vai», assistive
   * tech, requestSubmit): the selected row, or the explicit ask row. Same
   * wait rule while the reads run. Returns whether it acted or waited.
   */
  function submitActive() {
    const current = rows();
    if (current.length === 0) return false;
    // Still reading customers and offers (2-4 s in production): Enter
    // waits for them instead of sending a name to the AI. The list stays
    // open on «Cerco…» and the first result arrives selected. A second
    // Enter asks: a read that hangs never locks the AI row away. A «@»
    // query waits only for the agents read, never for customers/offers.
    const atQuery = state.query.trim().startsWith('@');
    const waiting = atQuery ? state.agentsLoading : (state.customersLoading || state.offersLoading);
    if (!state.enterWaited && waiting
      && current.every((row) => row.kind === 'ask')) {
      state.enterWaited = true;
      state.open = true;
      render();
      return true;
    }
    choose(state.open ? current[Math.min(state.active, current.length - 1)] : current[current.length - 1]);
    return true;
  }

  function onKeydown(event) {
    const key = event?.key;
    state.consumed = false;
    const prevent = () => { if (typeof event?.preventDefault === 'function') event.preventDefault(); };
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!state.open && state.query.trim() !== '') state.open = true;
      prevent();
      move(key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (key === 'Enter') {
      if (rows().length === 0) return;
      prevent();
      submitActive();
      // The submit that may still follow this keydown is the same Enter.
      state.consumed = true;
      return;
    }
    if (key === 'Escape' && state.open) {
      // Close the list and keep the words; the browser must not also clear
      // the search field, and nothing behind the bar closes on this Esc.
      prevent();
      if (typeof event?.stopPropagation === 'function') event.stopPropagation();
      state.open = false;
      render();
    }
  }

  return {
    /**
     * Bind to the top bar's (re-rendered) form and input.
     * @param {any} form
     * @param {any} field
     */
    attach(form, field) {
      const hadFocus = input !== null && doc?.activeElement === input;
      input = field;
      input.value = state.query;
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', 'bo-cmdk-list');
      input.addEventListener('input', onInput);
      input.addEventListener('keydown', onKeydown);
      list = el(doc, 'div', 'bo-cmdk ui-add-menu hidden');
      list.setAttribute('id', 'bo-cmdk-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Risultati');
      form.appendChild(list);
      render();
      if (hadFocus && typeof input.focus === 'function') input.focus();
    },
    /**
     * The top-bar form submit (review #779 P1): the same action as Enter,
     * once. Returns false when there is nothing typed, so the shell keeps
     * its empty-bar behaviour (opening the assistant).
     */
    submit() {
      if (state.consumed) {
        state.consumed = false;
        return true;
      }
      return submitActive();
    },
    /**
     * A space switch (review #779 P1): what was read belongs to the space
     * left behind — drop it, words included, and close the list.
     */
    invalidate() {
      state.customers = null;
      state.customersFor = '';
      state.offers = null;
      state.offersAt = 0;
      state.offersFailed = false;
      // backlog:1f7cb20d3c30: the agents belong to the space left behind —
      // drop them and their generation so a late answer never lands here.
      state.agents = null;
      state.agentsAt = 0;
      state.agentsFailed = false;
      agentsToken += 1;
      reset();
    },
    /** ⌘K: back to the bar, with the list of what was typed. */
    focus() {
      if (input === null) return;
      if (typeof input.focus === 'function') input.focus();
      if (state.query.trim() !== '') {
        state.open = true;
        render();
      }
    },
    /** A click outside the bar closes the list. @param {any} target */
    closeUnlessInside(target, form) {
      if (!state.open || (form && typeof form.contains === 'function' && form.contains(target))) return;
      state.open = false;
      render();
    },
    getState() {
      return { open: state.open, query: state.query, active: state.active, rows: rows().map((row) => ({ kind: row.kind, label: row.label, href: row.href })) };
    },
  };
}
