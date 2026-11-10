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

import { elFor } from './admin-ui.js';
import { formatAmount, humanReadError, italianDay } from './admin-core.js';
import { parseEuroToCents } from './admin-catalog.js';
import { offerStageLabel } from './admin-labels.js';
import { shownCompanyName } from './admin-customer-card.js';
import {
  fetchTeamRoster,
  isTechnicalHandle,
  paintOwnerName,
  resolveTeamName,
  resolveTeamSubject,
} from './admin-members.js';
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
  if (action === 'opportunity.stage_changed') return 'Cambio di fase';
  return 'Variazione registrata';
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
 * Display name of an audit actor (backlog:ddf7f416): nome e cognome, never
 * a technical id and never the generic `utente`. The system reads
 * `sistema`; a roster subject reads its member name; any other id paints
 * only when the record corroborates it as a human display value (the
 * painted referente, the contact or the company the deal stores). Anything
 * else misses (null) so the caller degrades honestly — the history omits
 * the author, the fact reads an em dash.
 */
function actorLabel(entry, record, roster) {
  if (entry?.actorType === 'system') return 'sistema';
  const id = typeof entry?.actorId === 'string' ? entry.actorId.trim() : '';
  if (id === '') return null;
  const team = resolveTeamName(id, roster);
  if (team !== null) return team;
  const known = [paintOwnerName(record?.owner, roster), record?.contactName, record?.companyName]
    .filter((value) => typeof value === 'string' && value !== '' && value !== '—');
  return known.includes(id) ? id : null;
}

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createOfferDetail(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);

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
    return offerStageLabel(schema?.pipelines, record) ?? '—';
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
    try {
      return await client.request(`/api/modules/opportunity/records/${encodeURIComponent(id)}`);
    } catch (error) {
      const status = Number(/** @type {any} */ (error)?.status ?? 0);
      if (status !== 404) throw error;
      const list = await client.request('/api/opportunities?limit=200');
      const found = Array.isArray(list?.items) ? list.items.find((item) => String(item?.id ?? '') === id) : null;
      if (!found) throw error;
      return found;
    }
  }

  async function renderOfferDetail(offerId) {
    const token = ++renderToken;
    editing = false;
    clear();
    const status = el('p', 'muted', 'Caricamento…');
    mount.appendChild(status);
    let schema;
    let record;
    let quotes;
    let roster;
    let auditItems;
    let auditUnreadable = false;
    try {
      schema = await client.request('/api/schema');
      record = await readOffer(offerId);
      // The team roster names the humans behind member handles
      // (backlog:ddf7f416). Best-effort like the audit trail: a refused or
      // unreadable list keeps the stored values, never a failed page.
      roster = await fetchTeamRoster(client);
      quotes = await fetchLinked('quote', 'opportunityId', record.id);
      try {
        const audit = await client.request(
          `/api/audit?entityType=opportunity&entityId=${encodeURIComponent(record.id)}&limit=100`,
        );
        auditItems = Array.isArray(audit?.items) ? audit.items : [];
      } catch (error) {
        // The audit trail is decoration: facts, quotes and lines render
        // without it rather than failing the whole detail. An unreadable
        // trail is not an empty one: it gets its own line and a log cause.
        logReadFailure('audit', error);
        auditItems = [];
        auditUnreadable = true;
      }
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = humanReadError(error, { failed: 'Offerta non trovata o non leggibile. Riprova più tardi.' });
      return;
    }
    if (token !== renderToken || !record || typeof record !== 'object') return;
    clear();

    // Who the deal is for (backlog:ddf7f416): the contact name first; the
    // reserved `Senza azienda` company is no customer, so it never paints
    // as `Per Senza azienda` (same rule as the scheda's shownCompanyName).
    const contact = typeof record.contactName === 'string' && record.contactName.trim() !== ''
      ? record.contactName.trim()
      : null;
    const customer = contact
      ?? shownCompanyName({ company: { name: record.companyName } });

    // Design (Dan 06/11): the deal reads like the quote — a card with who it
    // is for, the stage and the value up front, the facts in one strip, the
    // quotes as cards and the history as a timeline.
    const page = el('div', 'bo-offer');
    const sheet = el('article', 'bo-offer-sheet');
    page.appendChild(sheet);
    const hero = el('header', 'bo-offer-hero');
    const words = el('div', 'bo-offer-hero-words');
    words.appendChild(el('p', 'kicker', 'Offerta'));
    words.appendChild(el('h2', 'bo-offer-title', String(record.name ?? 'Offerta')));
    const meta = el('p', 'bo-offer-meta');
    if (customer) meta.appendChild(el('span', 'bo-offer-for', `Per ${customer}`));
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
    // same rule as the history (nome e cognome, never a technical id and
    // never `utente`); no event or no resolvable author, a dash.
    const createdEvent = auditItems.find((entry) => entry?.action === 'opportunity.created') ?? null;
    const createdBy = createdEvent !== null ? actorLabel(createdEvent, record, roster) : null;
    const facts = el('div', 'offer-facts');
    for (const [label, value] of [
      ['Referente', paintOwnerName(record.owner, roster)],
      ['Fase', stageLabel(schema, record)],
      ['Chiusura prevista', close ?? '—'],
      ['Creata da', createdBy ?? '—'],
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
    // pipeline card editor): importo, chiusura, referente.
    const editWrap = el('div', 'offer-edit');
    sheet.appendChild(editWrap);
    paintEdit(editWrap, record, offerId, token, roster);
    mount.appendChild(page);

    const quotesPanel = el('div', 'offer-quotes');
    quotesPanel.appendChild(el('h3', undefined, quotes.rows.length > 1 ? `Preventivi · ${quotes.rows.length}` : 'Preventivo'));
    if (quotes.rows.length === 0) {
      quotesPanel.appendChild(el('p', 'empty', 'Ancora nessun preventivo per questa offerta.'));
    }
    if (quotes.truncated) {
      quotesPanel.appendChild(el('p', 'muted', `Mostro solo i primi ${LIST_LIMIT} preventivi.`));
    }
    for (const quote of quotes.rows) {
      quotesPanel.appendChild(await paintQuote(quote, token, record));
      if (token !== renderToken) return;
    }
    page.appendChild(quotesPanel);

    const historyPanel = el('div', 'offer-history');
    historyPanel.appendChild(el('h3', undefined, 'Cronologia'));
    if (auditUnreadable) {
      historyPanel.appendChild(el('p', 'field-error', 'Cronologia non leggibile. Riprova più tardi.'));
    } else if (auditItems.length === 0) {
      historyPanel.appendChild(el('p', 'empty', 'Ancora nessun evento registrato per questa offerta.'));
    }
    for (const entry of auditItems) {
      const row = el('p', 'history-event');
      row.appendChild(el('span', 'history-when', italianDay(entry?.createdAt) ?? '—'));
      // An unresolvable author omits the `da …` tail: the row never claims
      // a technical id or the generic `utente` wrote it.
      const author = actorLabel(entry, record, roster);
      const what = author !== null ? `${auditActionLabel(entry?.action)} · da ${author}` : auditActionLabel(entry?.action);
      row.appendChild(el('span', 'history-what', what));
      historyPanel.appendChild(row);
    }
    page.appendChild(historyPanel);
  }

  /**
   * The single Referente field (backlog:ddf7f416): the members select when
   * the roster names anyone, else the one free-text field — never both.
   * Either way `inputs.owner` exposes `.value`, so the save flow is
   * unchanged. Options carry the stable roster subject as value and the
   * member name as title. The stored value preselects its member even
   * when it is a legacy name or handle (a legacy value resolves to its
   * subject, or stays choosable as a keep-option until the operator picks
   * a member).
   */
  function addOwnerField(form, inputs, id, make, current, roster) {
    const fieldRow = make('div', 'field-row');
    const inputId = `offer-${id}-owner`;
    const labelNode = make('label', undefined, 'Referente');
    labelNode.setAttribute('for', inputId);
    fieldRow.appendChild(labelNode);
    const labels = Array.isArray(roster?.labels) ? roster.labels : [];
    const bySubject = roster?.bySubject instanceof Map ? roster.bySubject : null;
    const stored = typeof current === 'string' ? current.trim() : '';
    if (labels.length === 0) {
      const input = make('input');
      input.setAttribute('id', inputId);
      input.setAttribute('name', 'owner');
      input.setAttribute('type', 'text');
      input.value = stored;
      fieldRow.appendChild(input);
      form.appendChild(fieldRow);
      inputs.owner = input;
      return;
    }
    const select = make('select', undefined, '');
    select.setAttribute('id', inputId);
    select.setAttribute('name', 'owner');
    select.setAttribute('required', 'required');
    const storedSubject = resolveTeamSubject(stored, roster);
    if (stored !== '' && storedSubject === null) {
      const keep = make('option', undefined, paintOwnerName(stored, roster));
      keep.setAttribute('value', stored);
      select.appendChild(keep);
    }
    const members = bySubject !== null
      ? [...bySubject].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'it'))
      : labels.map((name) => [name, name]);
    for (const [subject, name] of members) {
      const option = make('option', undefined, name);
      option.setAttribute('value', subject);
      select.appendChild(option);
    }
    select.value = storedSubject ?? stored;
    fieldRow.appendChild(select);
    form.appendChild(fieldRow);
    inputs.owner = select;
  }

  /** Edit form (or its opener) for the three commercial facts. */
  function paintEdit(wrap, record, offerId, token, roster) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const id = String(record.id);
    if (!editing) {
      const edit = el('button', 'offer-edit-open', 'Modifica');
      edit.setAttribute('type', 'button');
      const startEdit = () => {
        editing = true;
        paintEdit(wrap, record, offerId, token, roster);
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
      const input = el('input');
      input.setAttribute('id', inputId);
      input.setAttribute('name', name);
      input.setAttribute('type', type);
      input.value = value;
      fieldRow.appendChild(input);
      form.appendChild(fieldRow);
      inputs[name] = input;
    };
    addField('value', 'Valore EUR', {
      value: Number.isSafeInteger(record.valueCents) ? (record.valueCents / 100).toFixed(2) : '',
    });
    addField('expiry', 'Chiusura', { type: 'date', value: dayOf(record.expectedCloseDate) ?? '' });
    // The referente is the members select (backlog:ddf7f416): one field,
    // never free text plus a second select. Without a readable roster the
    // single free-text field stays, so operators who cannot list the team
    // can still correct the deal.
    addOwnerField(form, inputs, id, el, typeof record.owner === 'string' ? record.owner : '', roster);

    let busy = false;
    const save = async (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (busy) return;
      const cents = parseEuroToCents(inputs.value.value);
      const picked = String(inputs.owner.value ?? '').trim();
      // The same guard as the create form (backlog:ddf7f416 P2): the
      // record keeps the stable roster subject, and with a readable
      // roster every unresolved pick is refused — a plain stale handle
      // never survives an edit while create would refuse it.
      const rosterReadable = Array.isArray(roster?.labels) && roster.labels.length > 0;
      const owner = resolveTeamSubject(picked, roster) ?? picked;
      const expiry = String(inputs.expiry.value ?? '').trim();
      /** @type {Record<string, string>} */
      const failures = {};
      if (cents === null) failures.value = "Il valore è obbligatorio, in euro (es. 250.00).";
      if (owner === '') failures.owner = 'Il referente è obbligatorio.';
      else if (resolveTeamSubject(picked, roster) === null && (isTechnicalHandle(picked) || rosterReadable)) failures.owner = 'Scegli il referente tra i membri del team.';
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
      paintEdit(wrap, record, offerId, token, roster);
    };
    form.addEventListener('submit', save);
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
      const fetchedLines = await fetchLinked('quote-line', 'quoteId', quote.id);
      lines = fetchedLines.rows
        .filter((line) => line?.removed === false)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const fetchedVersions = await fetchLinked('quote-version', 'quoteId', quote.id);
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
      panel.appendChild(el('p', 'quote-version',
        `Versione ${version.versionNumber ?? '—'} · ${policyDecisionLabel(version.policyDecision)} · ${money(versionTotalsNet(version), version.currency ?? quote.currency)}`));
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

/** Net of one frozen version: valued one-time first, then valued recurring. */
function versionTotalsNet(version) {
  let totals = {};
  try {
    totals = typeof version?.totalsJson === 'string' && version.totalsJson !== '' ? (JSON.parse(version.totalsJson) ?? {}) : {};
  } catch {
    totals = {};
  }
  if (groupHasValue(totals.oneTimeTotal)) return totals.oneTimeTotal.netAmountCents;
  if (Array.isArray(totals.recurringTotals)) {
    const valued = totals.recurringTotals.find((group) => groupHasValue(group));
    if (valued) return valued.netAmountCents;
  }
  return 0;
}
