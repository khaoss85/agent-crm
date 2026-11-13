// @ts-check

// Offer detail (backlog:ef92f728): the deal page behind the pipeline card's
// `Apri` button. Reads the rendered opportunity record (never an expanded
// card): referente, fase, valore, chiusura prevista, creazione, ultima
// modifica, autore di creazione, preventivi collegati con le loro righe e la
// cronologia dagli eventi di audit. Every value renders as text (never HTML,
// never a technical id in visible text) and amounts use the Italian screen
// form from admin-core. The server stays the truth: Modifica PATCHes the
// same three commercial facts as the old card editor through
// `/api/opportunities/:id`.

import { elFor, uiBusy, uiSelect, uiSkeleton } from './admin-ui.js';
import { formatAmount, humanReadError, humanWriteError, italianDay } from './admin-core.js';
import { centsToField, euroToCents } from './admin-offer-panel.js';
import { auditActorLabel, offerCustomer, priceBookLabel, offerStageLabel, personLabel, personOf, stageMoveLabels, stageMoveOf, teamPeople, upperFirst } from './admin-labels.js';
import { offerStageMenu } from './admin-customer-card.js';
import { createStageConfirm, readStageConfirm, showStageConfirm, stageNeedsConfirm } from './admin-pipeline.js';
import { bindAdminMutations } from './admin-submission.js';

/** Day (YYYY-MM-DD) of an ISO timestamp, or null when absent/unparseable. */
function dayOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}


/** Italian label of an audit action; unknown actions stay a generic line. */
function auditActionLabel(action) {
  if (action === 'opportunity.created') return 'Creata';
  if (action === 'opportunity.updated') return 'Offerta aggiornata';
  if (action === 'opportunity.stage_changed') return 'Cambio di stato';
  return 'Variazione registrata';
}

/**
 * Backlog c1649d1d: the history line of one audit entry — who, from which
 * stage to which, when. A state move reads `da <from> a <to>` in the
 * operator's Italian; a side without a label falls back to the generic
 * line, never a raw key. Anything that is not a move keeps the action label
 * with the actor. Backlog 169cd4bc988c: one word for every move, the one
 * the «Cambia stato» button uses — «Cambio di stato», never «di fase» —
 * and states read capitalised («Proposta»).
 */
function historyLine(entry, schema, record, people = []) {
  const when = italianDay(entry?.createdAt) ?? '—';
  const who = actorLabel(entry, record, people);
  const move = stageMoveOf(entry);
  const words = move === null ? null : stageMoveLabels(schema?.pipelines, move);
  if (move !== null && words !== null) {
    return { when, what: `Cambio di stato · da ${upperFirst(words.from)} a ${upperFirst(words.to)} · da ${who}` };
  }
  return { when, what: `${auditActionLabel(entry?.action)} · da ${who}` };
}

/** Italian label of a quote status; unknown states stay an em dash. */
function quoteStatusLabel(status) {
  if (status === 'draft') return 'Bozza';
  if (status === 'pending_approval') return 'In attesa di approvazione';
  if (status === 'approved') return 'Approvato';
  if (status === 'rejected') return 'Rifiutato';
  return '—';
}

/**
 * Italian label of a version policy decision. Same contract as the quote
 * screen (admin-quotes.js): approval flavours first, quote states as the
 * fallback, an em dash for anything unknown.
 */
function policyDecisionLabel(decision) {
  if (decision === 'approval_required') return 'Richiede approvazione';
  if (decision === 'auto_approve') return 'Approvazione automatica';
  return quoteStatusLabel(decision);
}

/**
 * Italian label of a commercial period. Same contract as the quote screen
 * (admin-quotes.js): month, year, week, day with singular and plural.
 */
function periodLabel(count, interval) {
  const n = Number(count) || 0;
  const one = n === 1;
  if (interval === 'month') return one ? 'mese' : 'mesi';
  if (interval === 'year') return one ? 'anno' : 'anni';
  if (interval === 'week') return one ? 'settimana' : 'settimane';
  if (interval === 'day') return one ? 'giorno' : 'giorni';
  return String(interval ?? '—');
}

/**
 * Display page bound, same as the other admin screens: a collection read
 * never claims completeness past this many rows without saying so.
 */
const LIST_LIMIT = 200;

/**
 * Backlog 8dc6d4a456e1: the audit trail is read through this cap; a page
 * that fills it is truncated, and nothing is derived from a partial page.
 */
const AUDIT_LIMIT = 100;

/**
 * Display name of an audit actor: the shared vocabulary in admin-labels.js
 * (backlog c1649d1d), corroborated by this deal's human display values (the
 * referente, the contact or the company the deal stores).
 */
function actorLabel(entry, record, people = []) {
  // A team member reads their profile name (famiglia F5): the roster first,
  // then the deal's own display values — never a slug like «coach-guido».
  const owner = personLabel(record?.owner, people);
  const actor = typeof entry?.actorId === 'string' ? entry.actorId.trim() : '';
  if (entry?.actorType !== 'system' && owner !== null && actor !== '' && actor === record?.owner) return owner;
  return auditActorLabel(entry, [owner, record?.contactName, record?.companyName], people);
}

/**
 * backlog:a2ea75f705fd: the quote the offer page opens first — the newest
 * one by creation, else the last row read — or null without quotes.
 * @param {Array<any>} rows
 */
function latestQuote(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.id === 'string' && row.id !== '');
  if (list.length === 0) return null;
  return [...list].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))).at(-1) ?? null;
}

/** The commercial schema block (same seam as the quote screen). */
function commercialBlock(schema) {
  return schema?.commercial ?? schema?.domains?.commercial;
}

/**
 * Backlog 169cd4bc988c: «← Pipeline» goes back to the board the offer sits
 * on; an offer outside any composed pipeline goes to the first board.
 * @param {any} schema @param {any} record
 */
function pipelineHref(schema, record) {
  const key = typeof record?.pipelineKey === 'string' ? record.pipelineKey : '';
  const composed = Array.isArray(schema?.pipelines) && schema.pipelines.some((pipeline) => pipeline?.name === key);
  return composed && /^[a-z][a-z0-9-]*$/.test(key) ? `#/pipelines/${key}` : '#/pipeline';
}

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void, toast?: (text: string, error?: boolean) => void}} deps */
export function createOfferDetail(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client, submissions } = bindAdminMutations(deps.client, deps);
  const toast = typeof deps.toast === 'function' ? deps.toast : () => {};

  const el = elFor(doc);
  let renderToken = 0;
  /** Record id with the edit form open. */
  let editing = false;

  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };

  const money = (cents, currency) => formatAmount(cents, currency);

  /**
   * Italian label of the record's stage, or an em dash. Backlog
   * a551982c06eb: the same words as the scheda and the Pipeline board
   * (offerStageLabel in admin-labels.js).
   */
  function stageLabel(schema, record) {
    return upperFirst(offerStageLabel(schema?.pipelines, record)) ?? '—';
  }

  /**
   * One linked collection, read server-side by its indexed parent key so a
   * workspace with more than a page of records still finds this parent's
   * rows. The bound stays disclosed: callers show the notice when hit.
   */
  async function fetchLinked(module, field, id) {
    const result = await client.request(
      `/api/modules/${module}/records?limit=${LIST_LIMIT}&filter.${field}=${encodeURIComponent(String(id))}`,
    );
    const rows = Array.isArray(result?.items) ? result.items : [];
    return { rows, truncated: rows.length >= LIST_LIMIT };
  }

  /** Log a decoration-read failure with its cause, never its payload. */
  function logReadFailure(area, error) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[bo] offerta non leggibile', { area, code: error?.code ?? null });
    }
  }

  /** @param {string} offerId */
  /**
   * The offer the pipeline card opened. The record read comes first; when
   * it answers not found, the same list the Pipeline board paints from
   * (`/api/opportunities`) is the fallback — production 03/11: the shared
   * space answered the record read 404 for a card the board had just shown,
   * and the detail said «Offerta non trovata».
   * @param {string} id
   */
  async function readOffer(id) {
    // backlog:a2ea75f705fd: the offer is a core record — its own route
    // (`/api/opportunities/:id`), never the generic records surface, which
    // never serves core modules and answered 404 on every open (pilota
    // 12/11, twice per page).
    try {
      return await client.request(`/api/opportunities/${encodeURIComponent(id)}`);
    } catch (error) {
      const status = Number(/** @type {any} */ (error)?.status ?? 0);
      if (status !== 404) throw error;
      const list = await client.request('/api/opportunities?limit=200');
      const found = Array.isArray(list?.items) ? list.items.find((item) => String(item?.id ?? '') === id) : null;
      if (found) return found;
      // A link that names the offer by one of its quotes (the scheda's
      // offer line used to): the quote names its offer, and the page opens
      // that offer instead of «Offerta non trovata».
      const viaQuote = await quoteOffer(id);
      if (viaQuote === null) throw error;
      return viaQuote;
    }
  }

  /** The offer behind a quote id, or null when the id is no quote of an offer. @param {string} id */
  async function quoteOffer(id) {
    let quote;
    try {
      quote = await client.request(`/api/modules/quote/records/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
    const opportunityId = typeof quote?.opportunityId === 'string' && quote.opportunityId !== '' ? quote.opportunityId : null;
    if (opportunityId === null || opportunityId === id) return null;
    try {
      return await client.request(`/api/opportunities/${encodeURIComponent(opportunityId)}`);
    } catch {
      return null;
    }
  }

  /**
   * backlog:d8175e1c3495: the offer page skeleton — the same frame the page
   * paints (sheet with the hero and the facts strip, the quotes card, the
   * history card) with grey bars where values arrive. Busy for assistive
   * tech, with one spoken line; the real paint replaces it whole.
   */
  function offerSkeleton() {
    const page = el('div', 'bo-offer bo-offer-skeleton');
    page.setAttribute('aria-busy', 'true');
    page.setAttribute('data-offer-skeleton', 'true');
    const spoken = el('p', 'sr-only', 'Carico l’offerta…');
    spoken.setAttribute('role', 'status');
    page.appendChild(spoken);
    const sheet = el('article', 'bo-offer-sheet');
    const hero = el('header', 'bo-offer-hero');
    const words = el('div', 'bo-offer-hero-words');
    words.appendChild(el('p', 'kicker', 'Offerta'));
    words.appendChild(uiSkeleton(doc, { width: '55%', block: true }));
    words.appendChild(uiSkeleton(doc, { width: '30%', block: true }));
    hero.appendChild(words);
    const value = el('div', 'bo-offer-value');
    value.appendChild(uiSkeleton(doc, { width: '8em', block: true }));
    hero.appendChild(value);
    sheet.appendChild(hero);
    const facts = el('div', 'offer-facts');
    for (const label of ['Referente', 'Stato', 'Chiusura prevista', 'Creata da', 'Creata il', 'Ultima modifica']) {
      const cell = el('p', 'offer-fact');
      cell.appendChild(el('span', 'offer-fact-label', label));
      cell.appendChild(uiSkeleton(doc, { width: '70%', block: true }));
      facts.appendChild(cell);
    }
    sheet.appendChild(facts);
    page.appendChild(sheet);
    for (const [cls, title] of [['offer-quotes', 'Preventivo'], ['offer-history', 'Cronologia']]) {
      const card = el('div', cls);
      card.appendChild(el('h3', undefined, title));
      for (const width of ['72%', '54%']) card.appendChild(uiSkeleton(doc, { width, block: true }));
      page.appendChild(card);
    }
    return page;
  }

  async function renderOfferDetail(offerId) {
    const token = ++renderToken;
    editing = false;
    clear();
    // backlog:d8175e1c3495: the page's own shape shows at once — the sheet,
    // the facts, the quotes and the history as grey bars — never a lone
    // «Caricamento…»; the wait is announced once, to assistive tech.
    mount.appendChild(offerSkeleton());
    let schema;
    let record;
    let quotes;
    let auditItems;
    let auditUnreadable = false;
    let auditTruncated = false;
    /** @type {Array<any>} */
    let people = [];
    try {
      // backlog:d8175e1c3495 (pilota 12/11: «Caricamento…» up to 6,6 s):
      // the reads that do not depend on each other leave together — the
      // schema with the offer, then the quotes, the history and the team
      // with each other — instead of one after the other.
      const schemaRead = client.request('/api/schema');
      schemaRead.catch(() => {});
      [schema, record] = await Promise.all([schemaRead, readOffer(offerId)]);
      const quotesRead = fetchLinked('quote', 'opportunityId', record.id);
      quotesRead.catch(() => {});
      const auditRead = client.request(
        `/api/audit?entityType=opportunity&entityId=${encodeURIComponent(record.id)}&limit=${AUDIT_LIMIT}`,
      ).then(
        (audit) => ({ items: Array.isArray(audit?.items) ? audit.items : [], unreadable: false }),
        // Backlog 8dc6d4a456e1: a page that fills the cap is truncated —
        // the trail order is newest first, so the creation event may sit
        // past it and the author must not be read from a partial page.
        (error) => {
          // The audit trail is decoration: facts, quotes and lines render
          // without it rather than failing the whole detail. An unreadable
          // trail is not an empty one: it gets its own line and a log cause.
          logReadFailure('audit', error);
          return { items: [], unreadable: true };
        },
      );
      // The team names the referente and the authors by their profile
      // name (backlog:ddf7f416ad22); without it the deal still renders.
      const teamRead = client.request('/api/spine/memberships').then(
        (team) => teamPeople(Array.isArray(team?.items) ? team.items : []),
        (error) => {
          logReadFailure('team', error);
          return [];
        },
      );
      const [readQuotes, audit, team] = await Promise.all([quotesRead, auditRead, teamRead]);
      quotes = readQuotes;
      auditItems = audit.items;
      auditUnreadable = audit.unreadable;
      auditTruncated = auditItems.length >= AUDIT_LIMIT;
      people = team;
    } catch (error) {
      if (token !== renderToken) return;
      clear();
      mount.appendChild(el('p', 'muted', humanReadError(error, { failed: 'Offerta non trovata o non leggibile. Riprova più tardi.' })));
      return;
    }
    if (token !== renderToken || !record || typeof record !== 'object') return;
    clear();

    const customer = offerCustomer(record);

    // Design (Dan 06/11): the deal reads like the quote — a card with who it
    // is for, the stage and the value up front, the facts in one strip, the
    // quotes as cards and the history as a timeline.
    const page = el('div', 'bo-offer');
    // Backlog 169cd4bc988c: never a dead end — the way back to the board.
    const back = el('a', 'quote-back', '← Pipeline');
    back.setAttribute('href', pipelineHref(schema, record));
    back.setAttribute('data-action', 'offer-back');
    page.appendChild(back);
    const sheet = el('article', 'bo-offer-sheet');
    page.appendChild(sheet);
    const hero = el('header', 'bo-offer-hero');
    const words = el('div', 'bo-offer-hero-words');
    words.appendChild(el('p', 'kicker', 'Offerta'));
    words.appendChild(el('h2', 'bo-offer-title', String(record.name ?? 'Offerta')));
    const meta = el('p', 'bo-offer-meta');
    if (customer !== null) {
      // The customer opens their scheda; text only, a hostile name stays inert.
      const forLine = el('span', 'bo-offer-for', 'Per ');
      if (customer.href !== null) {
        const link = el('a', 'bo-offer-customer', customer.name);
        link.setAttribute('href', customer.href);
        forLine.appendChild(link);
      } else {
        forLine.appendChild(el('span', undefined, customer.name));
      }
      meta.appendChild(forLine);
    }
    meta.appendChild(el('span', 'bo-offer-stage', stageLabel(schema, record)));
    words.appendChild(meta);
    hero.appendChild(words);
    const valueBox = el('div', 'bo-offer-value');
    valueBox.appendChild(el('span', 'bo-offer-amount', money(record.valueCents, record.currency)));
    const close = italianDay(record.expectedCloseDate);
    valueBox.appendChild(el('span', 'bo-offer-amount-note', close !== null ? `chiusura prevista ${close}` : 'valore dell’offerta'));
    hero.appendChild(valueBox);
    sheet.appendChild(hero);

    // Who created the deal: the actor of its creation event, read through the
    // same rule as the history (never a technical id); no event — or a
    // truncated page that may hide it — a dash.
    const createdEvent = !auditTruncated
      ? (auditItems.find((entry) => entry?.action === 'opportunity.created') ?? null)
      : null;
    const facts = el('div', 'offer-facts');
    for (const [label, value] of [
      ['Referente', personLabel(record.owner, people) ?? '—'],
      ['Stato', stageLabel(schema, record)],
      ['Chiusura prevista', close ?? '—'],
      ['Creata da', createdEvent !== null ? actorLabel(createdEvent, record, people) : '—'],
      ['Creata il', italianDay(record.createdAt) ?? '—'],
      ['Ultima modifica', italianDay(record.updatedAt) ?? '—'],
    ]) {
      const cell = el('p', 'offer-fact');
      cell.appendChild(el('span', 'offer-fact-label', label));
      cell.appendChild(el('span', 'offer-fact-value', value ?? '—'));
      facts.appendChild(cell);
    }
    sheet.appendChild(facts);

    // The three editable commercial facts (same PATCH contract as the
    // pipeline card editor): importo, chiusura, referente. Backlog
    // 169cd4bc988c: beside them, «Cambia stato» on the same writes as the
    // board and the scheda.
    const actions = el('div', 'bo-offer-actions');
    sheet.appendChild(actions);
    paintStageMenu(actions, page, schema, record, offerId, token);
    const editWrap = el('div', 'offer-edit');
    actions.appendChild(editWrap);
    paintEdit(editWrap, record, offerId, token, people);
    mount.appendChild(page);

    const quotesPanel = el('div', 'offer-quotes');
    const quotesHead = el('div', 'offer-quotes-head');
    quotesHead.appendChild(el('h3', undefined, quotes.rows.length > 1 ? `Preventivi · ${quotes.rows.length}` : 'Preventivo'));
    quotesPanel.appendChild(quotesHead);
    if (quotes.rows.length === 0) {
      quotesPanel.appendChild(el('p', 'empty', 'Ancora nessun preventivo per questa offerta.'));
    }
    if (commercialBlock(schema)) paintCreateQuote(quotesHead, quotesPanel, record, token, latestQuote(quotes.rows));
    if (quotes.truncated) {
      quotesPanel.appendChild(el('p', 'muted', `Mostro solo i primi ${LIST_LIMIT} preventivi.`));
    }
    // backlog:d8175e1c3495: every quote reads its lines and versions at the
    // same time; the cards still paint in the order the quotes were read.
    const quoteCards = await Promise.all(quotes.rows.map((quote) => paintQuote(quote, token, record)));
    if (token !== renderToken) return;
    for (const card of quoteCards) quotesPanel.appendChild(card);
    page.appendChild(quotesPanel);

    const historyPanel = el('div', 'offer-history');
    historyPanel.appendChild(el('h3', undefined, 'Cronologia'));
    if (auditUnreadable) {
      historyPanel.appendChild(el('p', 'field-error', 'Cronologia non leggibile. Riprova più tardi.'));
    } else if (auditItems.length === 0) {
      historyPanel.appendChild(el('p', 'empty', 'Ancora nessun evento registrato per questa offerta.'));
    } else if (auditTruncated) {
      historyPanel.appendChild(el('p', 'muted', `Mostro solo gli ultimi ${AUDIT_LIMIT} eventi.`));
    }
    for (const entry of auditItems) {
      const line = historyLine(entry, schema, record, people);
      const row = el('p', 'history-event');
      row.appendChild(el('span', 'history-when', line.when));
      row.appendChild(el('span', 'history-what', line.what));
      historyPanel.appendChild(row);
    }
    page.appendChild(historyPanel);
  }

  /**
   * Backlog 169cd4bc988c: the referente is picked from the team — one
   * option per person under their profile name, never free text. The stored
   * id is kept when it belongs to that person; an id the team does not know
   * stays the first option, so Salva never remaps it in silence. Without a
   * readable team the field stays a text field and the form still works.
   * @param {string} current @param {Array<any>} people @param {string} inputId
   */
  function ownerControl(current, people, inputId) {
    if (people.length === 0) {
      const input = el('input');
      input.setAttribute('type', 'text');
      input.value = current;
      return { node: input, control: input };
    }
    const mine = personOf(current, people);
    const options = [];
    if (current === '') options.push({ value: '', label: 'Scegli una persona…' });
    else if (mine === null) options.push({ value: current, label: personLabel(current, people) ?? 'Referente attuale' });
    for (const person of people) {
      const value = mine === person ? current : String(person.subjects[0] ?? '');
      if (value !== '') options.push({ value, label: person.label });
    }
    const node = uiSelect(doc, { name: 'owner', value: current, options });
    const control = node.querySelector('select');
    control.setAttribute('id', inputId);
    control.value = current;
    return { node, control };
  }

  /** Edit form (or its opener) for the three commercial facts. */
  function paintEdit(wrap, record, offerId, token, people = []) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const id = String(record.id);
    if (!editing) {
      const edit = el('button', 'offer-edit-open', 'Modifica');
      edit.setAttribute('type', 'button');
      const startEdit = () => {
        editing = true;
        paintEdit(wrap, record, offerId, token, people);
      };
      edit.addEventListener('click', startEdit);
      wrap.appendChild(edit);
      wrap.__edit = startEdit;
      return;
    }

    const form = el('form', 'offer-edit-form');
    const errorNode = el('small', 'field-error hidden', '');
    form.appendChild(errorNode);
    /** @type {Record<string, any>} */
    const inputs = {};
    const addField = (name, label, { type = 'text', value = '' } = {}) => {
      const fieldRow = el('div', 'field-row');
      const inputId = `offer-${id}-${name}`;
      const labelNode = el('label', undefined, label);
      labelNode.setAttribute('for', inputId);
      fieldRow.appendChild(labelNode);
      if (name === 'owner') {
        const { node, control } = ownerControl(value, people, inputId);
        control.setAttribute('name', name);
        fieldRow.appendChild(node);
        form.appendChild(fieldRow);
        inputs[name] = control;
        return;
      }
      const input = el('input');
      input.setAttribute('id', inputId);
      input.setAttribute('name', name);
      input.setAttribute('type', type);
      input.value = value;
      fieldRow.appendChild(input);
      form.appendChild(fieldRow);
      inputs[name] = input;
    };
    // Backlog 169cd4bc988c: the amount reads in Italian («27.500,00»).
    addField('value', 'Valore EUR', {
      value: Number.isSafeInteger(record.valueCents) && record.valueCents >= 0 ? centsToField(record.valueCents) : '',
    });
    addField('expiry', 'Chiusura', { type: 'date', value: dayOf(record.expectedCloseDate) ?? '' });
    addField('owner', 'Referente', { value: typeof record.owner === 'string' ? record.owner : '' });

    let busy = false;
    const save = async (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (busy) return;
      const cents = euroToCents(inputs.value.value);
      const owner = String(inputs.owner.value ?? '').trim();
      const expiry = String(inputs.expiry.value ?? '').trim();
      /** @type {Record<string, string>} */
      const failures = {};
      if (cents === null) failures.value = 'Il valore è obbligatorio, in euro (es. 250,00).';
      if (owner === '') failures.owner = 'Il referente è obbligatorio.';
      if (expiry !== '' && Number.isNaN(Date.parse(expiry))) failures.expiry = 'La scadenza non è una data valida.';
      if (Object.keys(failures).length > 0) {
        errorNode.textContent = Object.values(failures)[0];
        errorNode.setAttribute('class', 'field-error');
        return;
      }
      busy = true;
      try {
        await client.request(
          `/api/opportunities/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify({ valueCents: cents, expectedCloseDate: expiry === '' ? null : expiry, owner }) },
        );
        editing = false;
        await renderOfferDetail(offerId);
      } catch (error) {
        busy = false;
        errorNode.textContent = humanReadError(error, { failed: 'Modifica non riuscita. Riprova più tardi.' });
        errorNode.setAttribute('class', 'field-error');
      }
    };
    const cancelEdit = () => {
      editing = false;
      paintEdit(wrap, record, offerId, token, people);
    };
    // cta-loading: «Salvo…» on Salva; the submit never reloads the page, even on a second press.
    form.addEventListener('submit', (event) => { event?.preventDefault?.(); void uiBusy(saveButton, 'Salvo…', () => save(event)); });
    const saveButton = el('button', undefined, 'Salva');
    saveButton.setAttribute('type', 'submit');
    const cancelButton = el('button', undefined, 'Annulla');
    cancelButton.setAttribute('type', 'button');
    cancelButton.addEventListener('click', cancelEdit);
    form.appendChild(saveButton);
    form.appendChild(cancelButton);
    wrap.appendChild(form);
    wrap.__save = save;
    wrap.__cancelEdit = cancelEdit;
    wrap.__editInputs = inputs;
    wrap.__editError = errorNode;
  }

  /**
   * Backlog 169cd4bc988c: «Cambia stato» on the offer page — the same menu
   * as the scheda (offerStageMenu) and the same writes: a placed offer posts
   * its pipeline's `move-stage`, an offer outside any pipeline the governed
   * core workflow. Won and lost ask the board's own Conferma (a lost move
   * needs its reason). Esc or a click elsewhere closes the menu; a refused
   * move keeps the server's Italian error on screen; a move the server still
   * holds reads neutral; a completed move re-reads the page.
   * Review #786: an answer that lands after the page changed (another
   * offer opened) never toasts, re-reads or navigates.
   * @param {any} box @param {any} page @param {any} schema @param {any} record @param {string} offerId @param {number} token
   */
  function paintStageMenu(box, page, schema, record, offerId, token) {
    const stageMenu = offerStageMenu(record, false, null, schema?.pipelines);
    if (stageMenu === null) return;
    const wrap = el('div', 'bo-offer-stage-menu');
    const button = el('button', 'secondary', 'Cambia stato');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('data-action', 'change-offer-stage');
    const menu = el('div', 'bo-offer-stage-voices hidden');
    menu.setAttribute('role', 'menu');
    const isClosed = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
    const setOpen = (open) => {
      menu.setAttribute('class', open ? 'bo-offer-stage-voices' : 'bo-offer-stage-voices hidden');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const close = (refocus = false) => {
      if (isClosed()) return;
      setOpen(false);
      if (refocus && typeof button.focus === 'function') button.focus();
    };
    button.addEventListener('click', () => setOpen(isClosed()));
    const onKey = (event) => {
      if (event?.key !== 'Escape') return;
      event.preventDefault?.();
      close(true);
    };
    button.addEventListener('keydown', onKey);
    menu.addEventListener('keydown', onKey);
    page.addEventListener('click', (event) => {
      const target = event?.target ?? null;
      if (target !== null && typeof wrap.contains === 'function' && wrap.contains(target)) return;
      close();
    });
    const stageError = el('small', 'field-error', '');
    stageError.setAttribute('role', 'alert');
    const stageStatus = el('small', 'bo-muted', '');
    stageStatus.setAttribute('role', 'status');
    let busy = false;
    const move = async (voice, reason = null) => {
      if (busy) return;
      busy = true;
      stageError.textContent = '';
      stageStatus.textContent = '';
      button.setAttribute('aria-busy', 'true');
      try {
        if (stageMenu.kind === 'pipeline') {
          const input = { toStage: voice.key, fromStage: stageMenu.current };
          if (reason) input.reason = reason;
          await client.request(
            `/api/modules/${encodeURIComponent(stageMenu.pipeline.module)}/records/${encodeURIComponent(stageMenu.id)}/actions/move-stage`,
            { method: 'POST', body: JSON.stringify(input) },
          );
          if (token !== renderToken) return;
          close();
          toast(`Spostata in ${upperFirst(voice.label)}.`);
        } else {
          const result = await client.request(
            `/api/opportunities/${encodeURIComponent(stageMenu.id)}/stage`,
            { method: 'POST', body: JSON.stringify({ targetStage: voice.key }) },
          );
          if (token !== renderToken) return;
          close();
          toast(result?.output?.outcome === 'approval_required'
            ? 'Stato aggiornato: serve un\u2019approvazione'
            : 'Stato aggiornato');
        }
        await renderOfferDetail(offerId);
      } catch (error) {
        if (token !== renderToken) return;
        if (error?.code === 'BO_CRM_PENDING') {
          close();
          stageStatus.textContent = 'Non ancora confermato: ricarica la pagina tra poco.';
          return;
        }
        const text = humanWriteError(error, { failed: 'Stato non aggiornato. Riprova più tardi.' });
        stageError.textContent = text;
        toast(text, true);
      } finally {
        busy = false;
        button.setAttribute('aria-busy', 'false');
      }
    };
    const confirmPanel = createStageConfirm(doc);
    let confirmVoice = null;
    const offerName = String(record.name ?? 'Offerta');
    confirmPanel.yes.addEventListener('click', () => {
      if (!confirmVoice) return;
      const answer = readStageConfirm(confirmPanel, confirmVoice);
      if (!answer.ok) return;
      void move(confirmVoice, answer.reason ?? null);
    });
    confirmPanel.no.addEventListener('click', () => {
      confirmVoice = null;
      confirmPanel.box.setAttribute('class', 'card-confirm hidden');
    });
    for (const voiceDef of stageMenu.voices) {
      const label = upperFirst(voiceDef.label) ?? voiceDef.key;
      const voice = el('button', 'bo-offer-stage-voice', label);
      voice.setAttribute('type', 'button');
      voice.setAttribute('role', 'menuitem');
      voice.setAttribute('data-stage', voiceDef.key);
      // Review #786: won and lost ask Conferma on every offer. A core move
      // (outside any pipeline) asks it too; its governed workflow records
      // no closing reason, so its Conferma asks none — never a reason that
      // would be collected and then dropped.
      const coreClosing = stageMenu.kind === 'core' && (voiceDef.key === 'won' || voiceDef.key === 'lost');
      voice.addEventListener('click', () => {
        if ((stageMenu.kind === 'pipeline' && stageNeedsConfirm(voiceDef)) || coreClosing) {
          confirmVoice = coreClosing ? { ...voiceDef, type: 'core' } : voiceDef;
          close();
          showStageConfirm(confirmPanel, offerName, { ...confirmVoice, label });
          return;
        }
        void move(voiceDef);
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

  /**
   * Backlog 169cd4bc988c: «Crea preventivo» on the offer — the same
   * `create-quote` action as the quotes screen, on an active price book
   * (the one in the offer's currency first). One book is one button; more
   * books are a menu beside it; none is one honest line, never a dead
   * button. The new quote opens where its lines are added.
   * @param {any} head @param {any} panel @param {any} record @param {number} token
   */
  /** The main action beside an existing quote: open it. @param {{id: string}} quote */
  function openQuoteLink(quote) {
    const open = el('a', 'ui-btn ui-btn-primary offer-quote-open-main', 'Apri il preventivo');
    open.setAttribute('href', `#/quotes/${encodeURIComponent(quote.id)}`);
    open.setAttribute('data-action', 'offer-open-quote');
    return open;
  }

  function paintCreateQuote(head, panel, record, token, existing = null) {
    const line = el('p', 'bo-muted offer-quote-create-line', '');
    line.setAttribute('role', 'status');
    void client.request(`/api/modules/price-book/records?limit=${LIST_LIMIT}`).then((answer) => {
      if (token !== renderToken) return;
      const books = (Array.isArray(answer?.items) ? answer.items : [])
        .filter((book) => book?.active === true && typeof book?.id === 'string' && book.id !== '')
        .sort((a, b) => Number(b.currency === record.currency) - Number(a.currency === record.currency));
      if (books.length === 0) {
        if (existing !== null) {
          head.appendChild(openQuoteLink(existing));
          return;
        }
        line.textContent = 'Per creare un preventivo serve un listino attivo nel Catalogo.';
        panel.appendChild(line);
        return;
      }
      const bar = el('div', 'offer-quote-create');
      let pickBook = () => books[0].id;
      if (books.length > 1) {
        const node = uiSelect(doc, {
          name: 'priceBookId',
          value: books[0].id,
          options: books.map((book) => ({ value: book.id, label: priceBookLabel(book) })),
        });
        const select = node.querySelector('select');
        select.setAttribute('aria-label', 'Listino del preventivo');
        select.value = books[0].id;
        pickBook = () => String(select.value ?? books[0].id);
        bar.appendChild(node);
      }
      // backlog:a2ea75f705fd: with a quote already there, the main action
      // opens it; a new quote stays possible, as the quiet second choice.
      if (existing !== null) bar.appendChild(openQuoteLink(existing));
      const create = el('button', existing !== null ? 'secondary' : 'primary', existing !== null ? 'Nuovo preventivo' : 'Crea preventivo');
      create.setAttribute('type', 'button');
      create.setAttribute('data-action', 'offer-create-quote');
      let busy = false;
      // One key per quote being created: a retry after an uncertain failure
      // never opens a second quote; a refusal or another book frees it.
      /** @type {null | {key: string, book: string}} */
      let pending = null;
      const offerId = String(record.id);
      create.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const book = pickBook();
        if (pending === null || pending.book !== book) pending = { key: submissions.issueKey(), book };
        create.setAttribute('disabled', 'disabled');
        create.setAttribute('aria-busy', 'true');
        line.textContent = '';
        try {
          const created = await client.request(
            `/api/modules/opportunity/records/${encodeURIComponent(offerId)}/actions/create-quote`,
            { method: 'POST', idempotencyKey: pending.key, body: JSON.stringify({ priceBookId: book }) },
          );
          pending = null;
          // Review #786: the page changed meanwhile — never pull the person
          // away from the offer they opened since.
          if (token !== renderToken) return;
          const quoteId = created?.result?.quote?.id;
          if (typeof quoteId !== 'string' || quoteId === '') throw new Error('quote without id');
          toast('Preventivo creato: aggiungi le righe.');
          navigate(`#/quotes/${encodeURIComponent(quoteId)}`);
        } catch (error) {
          const status = typeof error?.status === 'number' ? error.status : 0;
          if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) pending = null;
          if (token !== renderToken) return;
          line.setAttribute('class', 'field-error offer-quote-create-line');
          line.textContent = humanWriteError(error, { failed: 'Preventivo non creato. Riprova più tardi: non ne verrà creato un secondo.' });
        } finally {
          busy = false;
          create.removeAttribute('disabled');
          create.setAttribute('aria-busy', 'false');
        }
      });
      bar.appendChild(create);
      head.appendChild(bar);
      panel.appendChild(line);
    }, (error) => {
      if (token !== renderToken) return;
      logReadFailure('price-books', error);
      line.textContent = 'Listini non leggibili: crea il preventivo più tardi.';
      panel.appendChild(line);
    });
  }

  /**
   * One linked quote: stato, totali per periodo, righe e versioni. Periods
   * are never combined: the one-time group paints only when it carries a
   * value, and each recurring group paints with its own period, mirroring
   * the quote screen's `Totali per periodo commerciale`.
   */
  async function paintQuote(quote, token, record) {
    const panel = el('div', 'offer-quote');
    panel.setAttribute('data-quote', quote.id);
    const totals = parseTotals(quote.totalsJson);
    const head = el('div', 'offer-quote-head');
    head.appendChild(el('span', `quote-status quote-status-${quote.status}`, quoteStatusLabel(quote.status)));
    head.appendChild(el('h4', 'offer-quote-total', quoteTotalSummary(totals, quote.currency)));
    const link = el('a', 'offer-quote-open', 'Apri il preventivo');
    link.setAttribute('href', `#/quotes/${encodeURIComponent(quote.id)}`);
    head.appendChild(link);
    panel.appendChild(head);

    let lines = [];
    let versions = [];
    let partial = false;
    try {
      const [fetchedLines, fetchedVersions] = await Promise.all([
        fetchLinked('quote-line', 'quoteId', quote.id),
        fetchLinked('quote-version', 'quoteId', quote.id),
      ]);
      lines = fetchedLines.rows
        .filter((line) => line?.removed === false)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      versions = fetchedVersions.rows
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
      partial = fetchedLines.truncated || fetchedVersions.truncated;
    } catch (error) {
      logReadFailure('lines-versions', error);
      panel.appendChild(el('p', 'field-error', 'Righe e versioni non leggibili. Riprova più tardi.'));
      return panel;
    }
    if (token !== renderToken) return panel;

    if (partial) {
      panel.appendChild(el('p', 'muted', `Mostro solo i primi ${LIST_LIMIT} elementi per elenco.`));
    }
    if (lines.length === 0) panel.appendChild(el('p', 'empty', 'Ancora nessuna voce in questo preventivo.'));
    for (const line of lines) {
      // Package, quantity, a discount only when one applies, amount on the
      // right: SKU and offer revision stay in the records.
      const row = el('p', 'quote-line');
      const discount = (line.discountBps ?? 0) > 0
        ? ` · sconto ${((line.discountBps ?? 0) / 100).toFixed(2).replace('.', ',')}%`
        : '';
      row.appendChild(el('span', 'quote-line-name', String(line.offerName ?? '—')));
      row.appendChild(el('span', 'quote-line-meta', `Quantità ${line.quantity ?? '—'}${discount}`));
      row.appendChild(el('span', 'quote-line-amount', money(line.netAmountCents, quote.currency)));
      panel.appendChild(row);
    }
    if (versions.length === 0) panel.appendChild(el('p', 'quote-version quote-version-empty', 'Ancora nessuna versione: nasce quando il preventivo va in approvazione.'));
    for (const version of versions) {
      const versionTotals = parseTotals(version.totalsJson);
      const policy = policyTag(version);
      panel.appendChild(el('p', 'quote-version',
        `Versione ${version.versionNumber ?? '—'} · ${policyDecisionLabel(version.policyDecision)}${policy ? ` · ${policy}` : ''} · ${quoteTotalSummary(versionTotals, version.currency ?? quote.currency)}`));
    }
    return panel;
  }

  return { renderOfferDetail };
}

/** Server-generated totals; malformed data degrades to empty, never throws. */
function parseTotals(text) {
  let totals = {};
  try {
    totals = typeof text === 'string' && text !== '' ? (JSON.parse(text) ?? {}) : {};
  } catch {
    totals = {};
  }
  return {
    oneTimeTotal: totals.oneTimeTotal ?? null,
    recurringTotals: Array.isArray(totals.recurringTotals) ? totals.recurringTotals : [],
  };
}

/**
 * A totals group carries a value only when its net is a nonzero integer:
 * the server always persists a zero-valued one-time group, even for
 * subscription-only quotes, so truthiness alone would paint `0 €`.
 */
function groupHasValue(group) {
  return Number.isSafeInteger(group?.netAmountCents) && group.netAmountCents !== 0;
}

/**
 * Header summary of a linked quote: the one-time group only when it carries
 * a value, then each valued recurring group with its own period. Periods
 * are never summed; with no valued group the header stays an em dash.
 */
function quoteTotalSummary(totals, currency) {
  const parts = [];
  if (groupHasValue(totals.oneTimeTotal)) {
    parts.push(`una tantum ${formatAmount(totals.oneTimeTotal.netAmountCents, currency)}`);
  }
  for (const group of totals.recurringTotals) {
    if (!groupHasValue(group)) continue;
    parts.push(`${formatAmount(group.netAmountCents, currency)} ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/**
 * Backlog 8dc6d4a456e1: the frozen version names the discount policy that
 * decided it (`name@version` from the version record), never nothing.
 */
function policyTag(version) {
  return typeof version?.policy === 'string' && version.policy !== '' && Number.isSafeInteger(version?.policyVersion)
    ? `${version.policy}@${version.policyVersion}`
    : null;
}
