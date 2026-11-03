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
import { formatAmount, humanReadError } from './admin-core.js';
import { parseEuroToCents } from './admin-catalog.js';
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

/** UUID shape: never painted as a name, it is a technical id, not a person. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display name of an audit actor; empty actors stay an em dash. */
function actorLabel(entry) {
  if (entry?.actorType === 'system') return 'sistema';
  if (typeof entry?.actorId === 'string' && entry.actorId.trim() !== '') {
    return UUID_SHAPE.test(entry.actorId.trim()) ? 'utente' : entry.actorId;
  }
  return '—';
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

  /** Italian label of the record's pipeline stage, or an em dash. */
  function stageLabel(schema, record) {
    const pipelines = Array.isArray(schema?.pipelines) ? schema.pipelines : [];
    const key = record.pipelineStage ?? record.stage;
    for (const pipeline of pipelines) {
      const stage = (pipeline?.stages ?? []).find((candidate) => candidate?.key === key);
      if (stage) return stage.label ?? '—';
    }
    return '—';
  }

  /** @param {string} offerId */
  async function renderOfferDetail(offerId) {
    const token = ++renderToken;
    editing = false;
    clear();
    const status = el('p', 'muted', 'Caricamento…');
    mount.appendChild(status);
    let schema;
    let record;
    let quotes;
    let auditItems;
    try {
      schema = await client.request('/api/schema');
      record = await client.request(`/api/modules/opportunity/records/${encodeURIComponent(offerId)}`);
      const quoteRows = await client.request('/api/modules/quote/records?limit=200');
      quotes = (quoteRows.items ?? []).filter((quote) => quote?.opportunityId === record.id);
      try {
        const audit = await client.request(
          `/api/audit?entityType=opportunity&entityId=${encodeURIComponent(record.id)}&limit=100`,
        );
        auditItems = Array.isArray(audit?.items) ? audit.items : [];
      } catch {
        // The audit trail is decoration: facts, quotes and lines render
        // without it rather than failing the whole detail.
        auditItems = [];
      }
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = humanReadError(error, { failed: 'Offerta non trovata o non leggibile. Riprova più tardi.' });
      return;
    }
    if (token !== renderToken || !record || typeof record !== 'object') return;
    clear();

    const customer = typeof record.contactName === 'string' && record.contactName !== ''
      ? record.contactName
      : (typeof record.companyName === 'string' && record.companyName !== '' ? record.companyName : null);

    mount.appendChild(el('p', 'kicker', 'Offerta'));
    mount.appendChild(el('h2', undefined, String(record.name ?? 'Offerta')));
    if (customer) mount.appendChild(el('p', 'lede', customer));

    const created = [...auditItems].reverse().find((entry) => entry?.action === 'opportunity.created') ?? null;

    const facts = el('div', 'offer-facts');
    for (const [label, value] of [
      ['Referente', typeof record.owner === 'string' && record.owner !== '' ? record.owner : '—'],
      ['Fase', stageLabel(schema, record)],
      ['Valore', money(record.valueCents, record.currency)],
      ['Chiusura prevista', dayOf(record.expectedCloseDate) ?? '—'],
      ['Creata il', dayOf(record.createdAt) ?? '—'],
      ['Ultima modifica', dayOf(record.updatedAt) ?? '—'],
      ['Creata da', created ? actorLabel(created) : '—'],
    ]) {
      const row = el('p', 'offer-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, value ?? '—'));
      facts.appendChild(row);
    }
    mount.appendChild(facts);

    // The three editable commercial facts (same PATCH contract as the
    // pipeline card editor): importo, chiusura, referente.
    const editWrap = el('div', 'offer-edit');
    mount.appendChild(editWrap);
    paintEdit(editWrap, record, offerId, token);

    const quotesPanel = el('div', 'offer-quotes');
    quotesPanel.appendChild(el('h3', undefined, `Preventivi (${quotes.length})`));
    if (quotes.length === 0) {
      quotesPanel.appendChild(el('p', 'empty', 'Ancora nessun preventivo per questa offerta.'));
    }
    for (const quote of quotes) {
      quotesPanel.appendChild(await paintQuote(quote, token, record));
      if (token !== renderToken) return;
    }
    mount.appendChild(quotesPanel);

    const historyPanel = el('div', 'offer-history');
    historyPanel.appendChild(el('h3', undefined, `Cronologia (${auditItems.length})`));
    if (auditItems.length === 0) {
      historyPanel.appendChild(el('p', 'empty', 'Ancora nessun evento registrato per questa offerta.'));
    }
    for (const entry of auditItems) {
      const row = el('p', 'history-event');
      row.appendChild(el('span', undefined, `${dayOf(entry?.createdAt) ?? '—'} · ${auditActionLabel(entry?.action)} · ${actorLabel(entry)}`));
      historyPanel.appendChild(row);
    }
    mount.appendChild(historyPanel);
  }

  /** Edit form (or its opener) for the three commercial facts. */
  function paintEdit(wrap, record, offerId, token) {
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    const id = String(record.id);
    if (!editing) {
      const edit = el('button', undefined, 'Modifica');
      edit.setAttribute('type', 'button');
      const startEdit = () => {
        editing = true;
        paintEdit(wrap, record, offerId, token);
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
    addField('owner', 'Referente', { value: typeof record.owner === 'string' ? record.owner : '' });

    let busy = false;
    const save = async (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (busy) return;
      const cents = parseEuroToCents(inputs.value.value);
      const owner = String(inputs.owner.value ?? '').trim();
      const expiry = String(inputs.expiry.value ?? '').trim();
      /** @type {Record<string, string>} */
      const failures = {};
      if (cents === null) failures.value = "Il valore è obbligatorio, in euro (es. 250.00).";
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
      paintEdit(wrap, record, offerId, token);
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

  /** One linked quote: stato, totale, righe e versioni (la sua cronologia). */
  async function paintQuote(quote, token, record) {
    const panel = el('div', 'offer-quote');
    panel.setAttribute('data-quote', quote.id);
    const totals = parseTotals(quote.totalsJson);
    const total = totals.oneTimeTotal
      ? money(totals.oneTimeTotal.netAmountCents, quote.currency)
      : (totals.recurringTotals[0] ? money(totals.recurringTotals[0].netAmountCents, quote.currency) : '—');
    panel.appendChild(el('h4', undefined, `Preventivo · ${quoteStatusLabel(quote.status)} · ${total}`));
    const link = el('a', undefined, 'Apri il preventivo');
    link.setAttribute('href', `#/quotes/${encodeURIComponent(quote.id)}`);
    panel.appendChild(link);

    let lines = [];
    let versions = [];
    try {
      const lineRows = await client.request('/api/modules/quote-line/records?limit=200');
      lines = (lineRows.items ?? [])
        .filter((line) => line?.quoteId === quote.id && line?.removed === false)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const versionRows = await client.request('/api/modules/quote-version/records?limit=200');
      versions = (versionRows.items ?? [])
        .filter((version) => version?.quoteId === quote.id)
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
    } catch {
      panel.appendChild(el('p', 'field-error', 'Righe e versioni non leggibili. Riprova più tardi.'));
      return panel;
    }
    if (token !== renderToken) return panel;

    panel.appendChild(el('h5', undefined, `Righe (${lines.length})`));
    if (lines.length === 0) panel.appendChild(el('p', 'empty', 'Ancora nessuna riga in questo preventivo.'));
    for (const line of lines) {
      panel.appendChild(el('p', 'quote-line',
        `${line.sku ?? '—'} · ${line.offerName ?? '—'} · quantità ${line.quantity ?? '—'} · sconto ${((line.discountBps ?? 0) / 100).toFixed(2).replace('.', ',')}% · netto ${money(line.netAmountCents, quote.currency)}`));
    }
    panel.appendChild(el('h5', undefined, `Versioni (${versions.length})`));
    if (versions.length === 0) panel.appendChild(el('p', 'empty', 'Ancora nessuna versione per questo preventivo.'));
    for (const version of versions) {
      panel.appendChild(el('p', 'quote-version',
        `Versione ${version.versionNumber ?? '—'} · ${quoteStatusLabel(version.policyDecision)} · ${money(versionTotalsNet(version), version.currency ?? quote.currency)}`));
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

/** Net of one frozen version: one-time first, then the first recurring group. */
function versionTotalsNet(version) {
  let totals = {};
  try {
    totals = typeof version?.totalsJson === 'string' && version.totalsJson !== '' ? (JSON.parse(version.totalsJson) ?? {}) : {};
  } catch {
    totals = {};
  }
  if (totals.oneTimeTotal) return totals.oneTimeTotal.netAmountCents ?? 0;
  if (Array.isArray(totals.recurringTotals) && totals.recurringTotals[0]) {
    return totals.recurringTotals[0].netAmountCents ?? 0;
  }
  return 0;
}
