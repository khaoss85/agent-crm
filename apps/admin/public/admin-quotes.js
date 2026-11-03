// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { formatAmount, humanReadError } from './admin-core.js';
import { renderActivation } from './admin-contracts.js';
import { bindAdminMutations } from './admin-submission.js';

/**
 * Quote builder Admin (ADR-016), built on the ADR-009 override seam: a small
 * focused view because generic action forms cannot browse a catalog. Rules
 * unchanged from the rest of the Admin: every value renders as text (never
 * HTML), the server is authoritative for every amount, controls disable while
 * a request is in flight (no double submit), and a render token discards
 * stale responses. The Admin lists at most {@link LIST_LIMIT} records per
 * collection and says so — a display bound, never a correctness bound.
 */

const LIST_LIMIT = 200;

/**
 * The commercial schema block, wherever the composition publishes it: the
 * ambient top-level key before the extraction, the package's own contribution
 * under `domains` after it. The contents are the contract; the location is the
 * seam's business.
 * @param {any} schema
 */
function commercialBlock(schema) {
  return schema?.commercial ?? schema?.domains?.commercial;
}

/**
 * The signature schema block, same seam rule as the commercial one above: the
 * ambient top-level key before the Signature extraction, the package's own
 * contribution under `domains` after it.
 * @param {any} schema
 */
function signatureBlock(schema) {
  return schema?.signature ?? schema?.domains?.signature;
}

/** Server-generated evidence blobs; malformed data degrades to empty, never throws. */
function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
const parseTotals = (text) => {
  const totals = parseJson(text, {});
  return {
    oneTimeTotal: totals.oneTimeTotal ?? null,
    recurringTotals: Array.isArray(totals.recurringTotals) ? totals.recurringTotals : [],
    vatRateBps: totals.vatRateBps ?? null,
    vat: totals.vat ?? null,
  };
};
const parseBreakdown = (text) => {
  const breakdown = parseJson(text, {});
  return Array.isArray(breakdown.components) ? breakdown.components : [];
};

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createQuoteView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  let renderToken = 0;

  const el = elFor(doc); // BO-F6-02: shared element builder.
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };
  const money = (cents, currency) => formatAmount(cents, currency);
  /** Frozen VAT text for one group, or '' when the totals predate VAT. */
  const vatText = (vatEntry, currency, rateBps) => {
    if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000
      || !Number.isSafeInteger(vatEntry?.vatAmountCents)
      || !Number.isSafeInteger(vatEntry?.grossAmountCents)) {
      return '';
    }
    const label = rateBps % 100 === 0 ? String(rateBps / 100) : (rateBps / 100).toFixed(2).replace('.', ',');
    return ` · IVA ${label}% ${money(vatEntry.vatAmountCents, currency)} · totale ${money(vatEntry.grossAmountCents, currency)}`;
  };

  /** Italian label of a quote status; unknown states stay an em dash. */
  const quoteStatusLabel = (status) => {
    if (status === 'draft') return 'Bozza';
    if (status === 'pending_approval') return 'In attesa di approvazione';
    if (status === 'approved') return 'Approvato';
    if (status === 'rejected') return 'Rifiutato';
    return '—';
  };

  /** Italian label of a version policy decision; unknown decisions stay an em dash. */
  const policyDecisionLabel = (decision) => {
    if (decision === 'approval_required') return 'Richiede approvazione';
    if (decision === 'auto_approve') return 'Approvazione automatica';
    return quoteStatusLabel(decision);
  };

  /** Italian label of a pricing model; unknown models stay an em dash. */
  const pricingModelLabel = (model) => {
    if (model === 'flat_fee') return 'quota fissa';
    if (model === 'per_unit') return 'a unità';
    if (model === 'volume') return 'a volume';
    if (model === 'graduated' || model === 'tiered') return 'a scaglioni';
    return '—';
  };

  /** Italian label of a commercial period: month, year, week, day. */
  const periodLabel = (count, interval) => {
    const n = Number(count) || 0;
    const one = n === 1;
    if (interval === 'month') return one ? 'mese' : 'mesi';
    if (interval === 'year') return one ? 'anno' : 'anni';
    if (interval === 'week') return one ? 'settimana' : 'settimane';
    if (interval === 'day') return one ? 'giorno' : 'giorni';
    return String(interval ?? '—');
  };

  async function fetchRows(module, filter) {
    const result = await client.request(`/api/modules/${module}/records?limit=${LIST_LIMIT}`);
    const rows = (result.items ?? []).filter(filter ?? (() => true));
    return { rows, truncated: (result.items ?? []).length >= LIST_LIMIT };
  }

  /**
   * Voce cf340b571e98: «← <name>» back to the scheda the offer tile links
   * from. Resolved quote → opportunity → contact (else company), reading the
   * same contact/company name the scheda header shows. Best-effort: any
   * missing or unreadable step yields null, never a failed detail — righe,
   * totale, stato and storia render with or without the way back. Returns
   * the link together with the opportunity name for the Italian heading.
   * @param {any} quote
   */
  async function resolveCardBackLink(quote) {
    const opportunityId = typeof quote?.opportunityId === 'string' && quote.opportunityId !== '' ? quote.opportunityId : null;
    if (opportunityId === null) return { back: null, opportunityName: null };
    let opportunity;
    try {
      opportunity = await client.request(`/api/modules/opportunity/records/${encodeURIComponent(opportunityId)}`);
    } catch {
      return { back: null, opportunityName: null };
    }
    const opportunityName = typeof opportunity?.name === 'string' && opportunity.name.trim() !== '' ? opportunity.name : null;
    const contactId = typeof opportunity?.contactId === 'string' && opportunity.contactId !== '' ? opportunity.contactId : null;
    const companyId = typeof opportunity?.companyId === 'string' && opportunity.companyId !== '' ? opportunity.companyId : null;
    const resource = contactId !== null ? 'contact' : (companyId !== null ? 'company' : null);
    const subjectId = contactId ?? companyId;
    if (resource === null || subjectId === null) return { back: null, opportunityName };
    const rawName = contactId !== null ? opportunity?.contactName : opportunity?.companyName;
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : null;
    if (name === null) return { back: null, opportunityName };
    const back = el('a', 'quote-back');
    back.setAttribute('href', `#/customer-card/${resource}/${encodeURIComponent(subjectId)}`);
    // Text only: a hostile customer name stays inert text inside the link.
    back.textContent = `← ${name}`;
    return { back, opportunityName };
  }

  async function renderQuoteList() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('h2', 'panel-title', 'Preventivi'));
    const status = el('p', 'muted', 'Caricamento…');
    mount.appendChild(status);
    let schema;
    let quotes;
    let books;
    try {
      schema = await client.request('/api/schema');
      quotes = await fetchRows('quote');
      books = await fetchRows('price-book', (book) => book.active === true);
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = humanReadError(error, { failed: 'Preventivi non leggibili. Riprova più tardi.' });
      return;
    }
    if (token !== renderToken) return;
    if (!commercialBlock(schema)) {
      status.textContent = 'La gestione commerciale non è attiva in questo progetto.';
      return;
    }
    status.textContent = quotes.truncated
      ? `Mostro solo i primi ${LIST_LIMIT} preventivi.`
      : `${quotes.rows.length} preventiv${quotes.rows.length === 1 ? 'o' : 'i'}.`;

    // Create form: opportunity id + active price book → the server action.
    const form = el('div', 'quote-create');
    form.appendChild(el('h3', undefined, 'Nuovo preventivo'));
    const opportunityInput = el('input');
    opportunityInput.setAttribute('name', 'opportunityId');
    opportunityInput.setAttribute('placeholder', 'ID offerta');
    const bookSelect = el('select');
    bookSelect.setAttribute('name', 'priceBookId');
    for (const book of books.rows) {
      const option = el('option', undefined, `${book.name} (${book.currency})`);
      option.setAttribute('value', book.id);
      bookSelect.appendChild(option);
      if (bookSelect.value === undefined || bookSelect.value === '') bookSelect.value = book.id;
    }
    const createButton = el('button', undefined, 'Crea preventivo');
    const createError = el('small', 'field-error', '');
    createButton.addEventListener('click', async () => {
      const opportunityId = String(opportunityInput.value ?? '').trim();
      if (!opportunityId) {
        createError.textContent = 'Scegli l’offerta per cui creare il preventivo.';
        return;
      }
      createButton.disabled = true;
      try {
        const created = await client.request(
          `/api/modules/opportunity/records/${encodeURIComponent(opportunityId)}/actions/create-quote`,
          { method: 'POST', body: JSON.stringify({ priceBookId: bookSelect.value }) },
        );
        navigate(`#/quotes/${created.result.quote.id}`);
      } catch (error) {
        createError.textContent = error?.message ?? 'Creazione non riuscita';
      } finally {
        createButton.disabled = false;
      }
    });
    form.appendChild(opportunityInput);
    form.appendChild(bookSelect);
    form.appendChild(createButton);
    form.appendChild(createError);
    mount.appendChild(form);

    const list = el('div', 'quote-list');
    for (const quote of quotes.rows) {
      const row = el('div', 'quote-row');
      row.setAttribute('data-quote', quote.id);
      const quoteTotals = parseTotals(quote.totalsJson);
      const recurringSummary = quoteTotals.recurringTotals
        .map((group) => `${money(group.netAmountCents, quote.currency)} ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`)
        .join(' + ') || 'nessuna ricorrenza';
      const link = el('a', undefined,
        `Preventivo · ${quoteStatusLabel(quote.status)} · una tantum ${money(quoteTotals.oneTimeTotal?.netAmountCents ?? 0, quote.currency)} · ${recurringSummary}`);
      link.setAttribute('href', `#/quotes/${quote.id}`);
      row.appendChild(link);
      list.appendChild(row);
    }
    mount.appendChild(list);
  }

  async function renderQuoteDetail(quoteId) {
    const token = ++renderToken;
    clear();
    const heading = el('h2', 'panel-title', 'Preventivo');
    mount.appendChild(heading);
    const status = el('p', 'muted', 'Caricamento…');
    mount.appendChild(status);
    let schema;
    let quote;
    let lines;
    let entries;
    let versions;
    try {
      schema = await client.request('/api/schema');
      quote = await client.request(`/api/modules/quote/records/${encodeURIComponent(quoteId)}`);
      lines = (await fetchRows('quote-line', (line) => line.quoteId === quote.id && line.removed === false)).rows
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      entries = (await fetchRows('offer', (offer) => offer.priceBookId === quote.priceBookId && offer.active === true && offer.quoteEligible === true)).rows;
      versions = (await fetchRows('quote-version', (version) => version.quoteId === quote.id)).rows
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = humanReadError(error, { failed: 'Preventivo non leggibile. Riprova più tardi.' });
      return;
    }
    if (token !== renderToken) return;
    status.textContent = '';

    // Voce cf340b571e98: the way back to the scheda paints above the heading.
    // Heading and status already paint as the loading indicator, so they move
    // below the link with remove-then-append (a move in both the real DOM
    // and the test double, never a copy).
    const { back, opportunityName } = await resolveCardBackLink(quote);
    if (token !== renderToken) return;
    if (opportunityName !== null) heading.textContent = `Preventivo · ${opportunityName}`;
    if (back !== null) {
      mount.removeChild(heading);
      mount.removeChild(status);
      mount.appendChild(back);
      mount.appendChild(heading);
      mount.appendChild(status);
    }

    const summary = el('div', 'quote-summary');
    summary.setAttribute('data-status', quote.status);
    for (const [label, value] of [
      ['Stato', quoteStatusLabel(quote.status)],
      ['Valuta', quote.currency],
      ['Revisione bozza', quote.draftRevision],
    ]) {
      const row = el('p', 'quote-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, value ?? '—'));
      summary.appendChild(row);
    }
    mount.appendChild(summary);

    // Grouped totals: the one-time group and each recurring period are shown
    // SEPARATELY — unlike periods are never summed, and no ARR/MRR/TCV is
    // derived (contract term and normalization are not modeled).
    const totals = parseTotals(quote.totalsJson);
    const totalsPanel = el('div', 'quote-totals');
    totalsPanel.setAttribute('data-recurring-groups', String(totals.recurringTotals.length));
    totalsPanel.appendChild(el('h3', undefined, 'Totali per periodo commerciale'));
    const totalRow = (label, group, vatEntry) => {
      const row = el('p', 'quote-total-row');
      row.setAttribute('data-total', label);
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined,
        `${money(group.netAmountCents, group.currency ?? quote.currency)} netto (listino ${money(group.listAmountCents, group.currency ?? quote.currency)}, sconto ${money(group.discountAmountCents, group.currency ?? quote.currency)})${vatText(vatEntry, group.currency ?? quote.currency, totals.vatRateBps)}`));
      totalsPanel.appendChild(row);
    };
    if (totals.oneTimeTotal) totalRow('Una tantum', totals.oneTimeTotal, totals.vat?.oneTime ?? null);
    totals.recurringTotals.forEach((group, index) => {
      totalRow(`Ricorrente ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`, group, totals.vat?.recurring?.[index] ?? null);
    });
    if (!totals.oneTimeTotal && totals.recurringTotals.length === 0) {
      totalsPanel.appendChild(el('p', 'empty', 'Ancora nessuna riga.'));
    }
    totalsPanel.appendChild(el('p', 'muted', 'Tutti gli importi sono calcolati dal server (centesimi, due decimali). I periodi non si sommano mai in un unico totale e non si ricava nessuna cifra annualizzata o di contratto (la durata del contratto non è modellata).'));
    mount.appendChild(totalsPanel);

    const errorLine = el('small', 'field-error', '');
    mount.appendChild(errorLine);
    const busy = [];
    const withBusy = async (fn) => {
      for (const control of busy) control.disabled = true;
      errorLine.textContent = '';
      try {
        await fn();
        await renderQuoteDetail(quoteId); // re-render from server state
      } catch (error) {
        errorLine.textContent = error?.message ?? 'Richiesta non riuscita';
        for (const control of busy) control.disabled = false;
      }
    };
    const act = (action, input) =>
      client.request(`/api/modules/quote/records/${encodeURIComponent(quoteId)}/actions/${action}`, {
        method: 'POST',
        body: JSON.stringify(input),
      });

    // Draft lines with controlled edit/remove.
    const linesPanel = el('div', 'quote-lines');
    linesPanel.appendChild(el('h3', undefined, `Righe (${lines.length})`));
    for (const line of lines) {
      const row = el('div', 'quote-line');
      row.setAttribute('data-line', line.id);
      row.appendChild(el('span', 'quote-line-head',
        `${line.sku} · ${line.offerName} (rev. ${line.offerRevision}) · quantità ${line.quantity} · sconto ${((line.discountBps ?? 0) / 100).toFixed(2).replace('.', ',')}% · netto ${money(line.netAmountCents, quote.currency)}`));
      // Every price component of the offer, with its tier breakdown.
      const breakdown = parseBreakdown(line.breakdownJson);
      const componentList = el('div', 'quote-components');
      for (const component of breakdown) {
        const recurrence = component.chargeType === 'one_time'
          ? 'una tantum'
          : `ogni ${component.intervalCount} ${periodLabel(component.intervalCount, component.interval)}`;
        const componentRow = el('p', 'quote-component');
        componentRow.setAttribute('data-component', component.componentId ?? component.componentKey ?? '');
        componentRow.textContent =
          `${component.label ?? component.componentKey} · ${pricingModelLabel(component.pricingModel)} · ${recurrence} · listino ${money(component.listAmountCents, quote.currency)} · netto ${money(component.netAmountCents, quote.currency)}`;
        componentList.appendChild(componentRow);
        for (const band of component.tierBreakdown ?? []) {
          const bandRow = el('p', 'quote-tier');
          bandRow.textContent =
            `fascia ${band.position}: ${band.from}–${band.to ?? '∞'} · ${band.quantity} × ${money(band.unitAmountCents, quote.currency)}${band.flatAmountCents ? ` + ${money(band.flatAmountCents, quote.currency)} quota fissa` : ''} = ${money(band.amountCents, quote.currency)}`;
          componentList.appendChild(bandRow);
        }
      }
      row.appendChild(componentList);
      if (quote.status === 'draft') {
        const quantityInput = el('input');
        quantityInput.setAttribute('type', 'number');
        quantityInput.value = String(line.quantity);
        const discountInput = el('input');
        discountInput.setAttribute('type', 'number');
        discountInput.value = String(line.discountBps);
        discountInput.setAttribute('title', 'Sconto in punti base: 1000 = 10,00%');
        const updateButton = el('button', undefined, 'Aggiorna');
        const removeButton = el('button', undefined, 'Rimuovi');
        busy.push(updateButton, removeButton);
        updateButton.addEventListener('click', () => withBusy(() => act('update-line', {
          lineId: line.id,
          quantity: Number(quantityInput.value),
          discountBps: Number(discountInput.value),
          expectedRevision: quote.draftRevision,
        })));
        removeButton.addEventListener('click', () => withBusy(() => act('remove-line', {
          lineId: line.id,
          expectedRevision: quote.draftRevision,
        })));
        row.appendChild(quantityInput);
        row.appendChild(discountInput);
        row.appendChild(updateButton);
        row.appendChild(removeButton);
        row.__update = () => withBusy(() => act('update-line', { lineId: line.id, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
        row.__quantity = quantityInput;
        row.__discount = discountInput;
      }
      linesPanel.appendChild(row);
    }
    mount.appendChild(linesPanel);

    if (quote.status === 'draft') {
      const addPanel = el('div', 'quote-add-line');
      addPanel.appendChild(el('h3', undefined, 'Aggiungi riga'));
      const entrySelect = el('select');
      for (const entry of entries) {
        const option = el('option', undefined, `${entry.name} — ${entry.componentCount} component(s)`);
        option.setAttribute('value', entry.id);
        entrySelect.appendChild(option);
        if (entrySelect.value === undefined || entrySelect.value === '') entrySelect.value = entry.id;
      }
      if (entries.length === 0) addPanel.appendChild(el('p', 'empty', 'Nessuna offerta aggiungibile in questo listino.'));
      const quantityInput = el('input');
      quantityInput.setAttribute('type', 'number');
      quantityInput.value = '1';
      const discountInput = el('input');
      discountInput.setAttribute('type', 'number');
      discountInput.value = '0';
      const hint = el('small', 'muted', 'La quantità vale per le componenti a unità e a scaglioni; le quote fisse si addebitano una volta. Sconto in punti base (intero 0–10000): 1000 = 10,00%.');
      const addButton = el('button', undefined, 'Aggiungi riga');
      busy.push(addButton);
      addButton.addEventListener('click', () => withBusy(() => act('add-line', {
        offerId: entrySelect.value,
        quantity: Number(quantityInput.value),
        discountBps: Number(discountInput.value),
        expectedRevision: quote.draftRevision,
      })));
      addPanel.appendChild(entrySelect);
      addPanel.appendChild(quantityInput);
      addPanel.appendChild(discountInput);
      addPanel.appendChild(hint);
      addPanel.appendChild(addButton);
      addPanel.__add = () => withBusy(() => act('add-line', { offerId: entrySelect.value, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
      addPanel.__entry = entrySelect;
      addPanel.__quantity = quantityInput;
      addPanel.__discountBps = discountInput;
      mount.appendChild(addPanel);

      const submitPanel = el('div', 'quote-submit');
      submitPanel.appendChild(el('h3', undefined, 'Invia per l’approvazione'));
      const policySelect = el('select');
      for (const policy of commercialBlock(schema)?.discountPolicies ?? []) {
        const option = el('option', undefined, `${policy.label} (v${policy.version})`);
        option.setAttribute('value', `${policy.name}@${policy.version}`);
        policySelect.appendChild(option);
        if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
      }
      const submitButton = el('button', undefined, 'Invia');
      busy.push(submitButton);
      submitButton.addEventListener('click', () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      }));
      submitPanel.appendChild(policySelect);
      submitPanel.appendChild(submitButton);
      submitPanel.__submit = () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      });
      mount.appendChild(submitPanel);
    }

    if (quote.status === 'pending_approval') {
      const decidePanel = el('div', 'quote-decide');
      decidePanel.appendChild(el('h3', undefined, 'In attesa di approvazione'));
      decidePanel.appendChild(el('p', 'muted', 'Le decisioni sono prese come utente Admin locale; i ruoli veri arrivano con il Production Spine.'));
      const reasonInput = el('input');
      reasonInput.setAttribute('placeholder', 'Motivo della decisione (obbligatorio per rifiutare)');
      const approveButton = el('button', undefined, 'Approva');
      const rejectButton = el('button', undefined, 'Rifiuta');
      busy.push(approveButton, rejectButton);
      approveButton.addEventListener('click', () => withBusy(() => act('approve', reasonInput.value ? { reason: reasonInput.value } : {})));
      rejectButton.addEventListener('click', () => withBusy(() => act('reject', { reason: reasonInput.value })));
      decidePanel.appendChild(reasonInput);
      decidePanel.appendChild(approveButton);
      decidePanel.appendChild(rejectButton);
      decidePanel.__approve = () => withBusy(() => act('approve', {}));
      decidePanel.__reject = () => withBusy(() => act('reject', { reason: reasonInput.value }));
      decidePanel.__reason = reasonInput;
      mount.appendChild(decidePanel);
    }

    if (quote.status === 'rejected') {
      const revisePanel = el('div', 'quote-revise');
      const reviseButton = el('button', undefined, 'Rivedi (torna in bozza)');
      busy.push(reviseButton);
      reviseButton.addEventListener('click', () => withBusy(() => act('revise', {})));
      revisePanel.appendChild(reviseButton);
      revisePanel.__revise = () => withBusy(() => act('revise', {}));
      mount.appendChild(revisePanel);
    }

    if (quote.status === 'approved') {
      mount.appendChild(el('p', 'quote-approved', 'Approvato — il contenuto commerciale di questo preventivo è in sola lettura.'));
      await renderSignature({ quote, schema, mount, el, client, withBusy, busy, money, quoteStatusLabel, periodLabel });
    }

    const versionsPanel = el('div', 'quote-versions');
    versionsPanel.appendChild(el('h3', undefined, `Versioni (${versions.length})`));
    for (const version of versions) {
      const row = el('div', 'quote-version-row');
      row.setAttribute('data-version', version.id);
      const versionTotals = parseTotals(version.totalsJson);
      const periods = [
        `una tantum ${money(versionTotals.oneTimeTotal?.netAmountCents ?? 0, version.currency)}${vatText(versionTotals.vat?.oneTime ?? null, version.currency, versionTotals.vatRateBps)}`,
        ...versionTotals.recurringTotals.map((group, index) => `${money(group.netAmountCents, version.currency)} ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}${vatText(versionTotals.vat?.recurring?.[index] ?? null, version.currency, versionTotals.vatRateBps)}`),
      ].join(' · ');
      const link = el('a', undefined,
        `Versione ${version.versionNumber} · ${policyDecisionLabel(version.policyDecision)} · ${periods}`);
      link.setAttribute('href', `#/modules/quote-version/${version.id}`);
      row.appendChild(link);
      if (version.decisionReason) row.appendChild(el('span', 'muted', ` — ${version.decisionReason}`));
      versionsPanel.appendChild(row);
    }
    mount.appendChild(versionsPanel);
  }

  /**
   * Signature and Order section (ADR-017), shown only on an approved quote.
   * Everything here is read-only evidence except the single Request signature
   * control, which is an explicit human action with its caveat stated in the
   * UI. No payment, invoice or delivery control exists.
   */
  async function renderSignature({ quote, schema, mount, el, client, withBusy, busy, money, quoteStatusLabel, periodLabel }) {
    const envelopeStatusLabel = (status) => {
      if (status === 'sent') return 'Inviata';
      if (status === 'completed') return 'Completata';
      if (status === 'declined') return 'Rifiutata';
      if (status === 'voided') return 'Annullata';
      return '—';
    };
    const signerStatusLabel = (status) => {
      if (status === 'signed') return 'firmato';
      if (status === 'pending') return 'in attesa';
      if (status === 'declined') return 'rifiutato';
      return '—';
    };
    const orderStatusLabel = (status) => {
      if (status === 'accepted') return 'Accettato';
      if (status === 'pending') return 'In attesa';
      if (status === 'cancelled') return 'Annullato';
      return '—';
    };
    const panel = el('div', 'quote-signature');
    panel.appendChild(el('h3', undefined, 'Firma'));
    mount.appendChild(panel);
    if (!signatureBlock(schema)) {
      panel.appendChild(el('p', 'muted', 'La firma non è attiva in questo progetto.'));
      return;
    }
    let envelopes;
    let signers;
    let artifacts;
    let orders;
    let orderTotals;
    try {
      envelopes = (await fetchRows('signature-envelope', (row) => row.quoteId === quote.id)).rows;
      signers = (await fetchRows('signature-signer')).rows;
      artifacts = (await fetchRows('signed-artifact', (row) => row.quoteId === quote.id)).rows;
      orders = (await fetchRows('order', (row) => row.quoteId === quote.id)).rows;
      orderTotals = (await fetchRows('order-total')).rows;
    } catch (error) {
      panel.appendChild(el('p', 'field-error', humanReadError(error, { failed: 'Stato della firma non leggibile. Riprova più tardi.' })));
      return;
    }
    const envelope = envelopes[0] ?? null;

    if (!envelope) {
      const form = el('div', 'signature-request');
      form.appendChild(el('p', 'muted', 'L’invio per la firma è un effetto esterno reale: serve un utente umano. Questo è un confine di attore umano, non un controllo di ruoli commerciali o legali — i ruoli veri arrivano con il Production Spine.'));
      const providerSelect = el('select');
      for (const provider of (signatureBlock(schema).providers ?? [])) {
        const option = el('option', undefined, `${provider.label} (v${provider.version})`);
        option.setAttribute('value', `${provider.name}@${provider.version}`);
        providerSelect.appendChild(option);
        if (providerSelect.value === undefined || providerSelect.value === '') providerSelect.value = `${provider.name}@${provider.version}`;
      }
      const nameInput = el('input');
      nameInput.setAttribute('name', 'signerName');
      nameInput.setAttribute('placeholder', 'Nome del firmatario');
      const emailInput = el('input');
      emailInput.setAttribute('name', 'signerEmail');
      emailInput.setAttribute('placeholder', 'Email del firmatario');
      const roleInput = el('input');
      roleInput.setAttribute('name', 'signerRole');
      roleInput.setAttribute('placeholder', 'Ruolo (facoltativo)');
      const requestButton = el('button', undefined, 'Richiedi firma');
      busy.push(requestButton);
      const request = () => withBusy(() => {
        const [provider, version] = String(providerSelect.value).split('@');
        return client.request(`/api/modules/quote/records/${encodeURIComponent(quote.id)}/actions/request-signature`, {
          method: 'POST',
          body: JSON.stringify({
            quoteVersionId: quote.currentVersionId,
            provider,
            providerVersion: Number(version),
            signers: [{ name: nameInput.value, email: emailInput.value, role: roleInput.value || undefined, order: 1 }],
          }),
        });
      });
      requestButton.addEventListener('click', request);
      for (const control of [providerSelect, nameInput, emailInput, roleInput, requestButton]) form.appendChild(control);
      form.appendChild(el('small', 'muted', 'Tutti i firmatari devono firmare; l’ordine dichiarato è registrato, non imposto in sequenza. Nessuna garanzia sull’identità dei firmatari.'));
      form.__request = request;
      form.__name = nameInput;
      form.__email = emailInput;
      panel.appendChild(form);
      return;
    }

    const state = el('div', 'signature-envelope');
    state.setAttribute('data-envelope', envelope.id);
    state.setAttribute('data-status', envelope.status);
    for (const [label, value] of [
      ['Stato', envelopeStatusLabel(envelope.status)],
      ['Fornitore', `${envelope.provider} v${envelope.providerVersion}`],
      ['Busta del fornitore', envelope.providerEnvelopeId ?? '—'],
      ['Impronta del documento', envelope.documentHash],
      ['Formato del documento', envelope.documentFormat],
    ]) {
      const row = el('p', 'signature-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, String(value ?? '—')));
      state.appendChild(row);
    }
    // Uncertainty is stated, never smoothed over: whether the provider has the
    // envelope is a different fact from whether the local phase failed.
    const TERMINAL = ['completed', 'declined', 'voided'];
    if (envelope.failureCode) {
      const outcome = envelope.failureCode === 'PROVIDER_ENVELOPE_ABSENT'
        ? 'Il fornitore non ha questa busta: non è mai stata accettata. Questa versione non si può inviare di nuovo in questa fase — la richiesta di firma è chiusa.'
        : envelope.providerEnvelopeId
          ? 'Il fornitore HA accettato questa busta; solo il passo locale dopo è fallito. Riconcilia per riprendere l’esito.'
          : 'Non si sa se il fornitore ha accettato questa busta. Riconcilia per scoprirlo — mai chiedere una seconda firma.';
      state.appendChild(el('p', 'signature-failure', `La fase ${envelope.failurePhase} non è riuscita (${envelope.failureCode}). ${outcome}`));
    }
    if (!TERMINAL.includes(envelope.status)) {
      const reconcileButton = el('button', undefined, 'Riconcilia con il fornitore');
      busy.push(reconcileButton);
      const reconcile = () => withBusy(() => client.request(`/api/signature/envelopes/${encodeURIComponent(envelope.id)}/reconcile`, { method: 'POST', body: '{}' }));
      reconcileButton.addEventListener('click', reconcile);
      state.appendChild(reconcileButton);
      state.__reconcile = reconcile;
    }
    panel.appendChild(state);

    const signerList = el('div', 'signature-signers');
    for (const signer of signers.filter((row) => row.envelopeId === envelope.id).sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))) {
      const row = el('p', 'signature-signer');
      row.setAttribute('data-signer', signer.signerKey);
      row.textContent = `${signer.signingOrder}. ${signer.name} <${signer.email}> · ${signer.role} · ${signerStatusLabel(signer.status)}`;
      signerList.appendChild(row);
    }
    panel.appendChild(signerList);

    const artifact = artifacts[0] ?? null;
    if (artifact) {
      const evidence = el('div', 'signed-artifact');
      evidence.setAttribute('data-artifact', artifact.id);
      evidence.appendChild(el('h4', undefined, 'Prova del documento firmato'));
      for (const [label, value] of [
        ['Artefatto del fornitore', artifact.providerArtifactId ?? '—'],
        ['Impronta del documento', artifact.documentHash],
        ['Impronta dell’artefatto', artifact.artifactHash ?? '—'],
        ['Tipo', artifact.mimeType ?? '—'],
        ['Completato il', artifact.completedAt ?? '—'],
        ['Riferimento', artifact.storageRef ?? '—'],
      ]) {
        const row = el('p', 'artifact-fact');
        row.appendChild(el('strong', undefined, `${label}: `));
        row.appendChild(el('span', undefined, String(value ?? '—')));
        evidence.appendChild(row);
      }
      evidence.appendChild(el('p', 'muted', 'I byte dell’artefatto restano dal fornitore: qui si registrano impronte, metadati e un riferimento. Nessuna garanzia di conservazione a lungo termine, e non è una firma legalmente qualificata.'));
      panel.appendChild(evidence);
    }

    const order = orders[0] ?? null;
    if (order) {
      const orderPanel = el('div', 'quote-order');
      orderPanel.setAttribute('data-order', order.id);
      orderPanel.appendChild(el('h3', undefined, 'Ordine'));
      const idRow = el('p', 'order-fact');
      idRow.appendChild(el('strong', undefined, 'Ordine: '));
      idRow.appendChild(el('span', undefined, `Ordine · ${orderStatusLabel(order.status)} · accettato il ${order.acceptedAt ?? '—'}`));
      orderPanel.appendChild(idRow);
      for (const total of orderTotals.filter((row) => row.orderId === order.id)) {
        const row = el('p', 'order-total');
        row.setAttribute('data-total', total.kind === 'one_time' ? 'Una tantum' : `Ricorrente ogni ${total.intervalCount} ${periodLabel(total.intervalCount, total.interval)}`);
        row.textContent = total.kind === 'one_time'
          ? `Una tantum: ${money(total.netAmountCents, total.currency)} netto`
          : `Ricorrente ogni ${total.intervalCount} ${periodLabel(total.intervalCount, total.interval)}: ${money(total.netAmountCents, total.currency)} netto`;
        orderPanel.appendChild(row);
      }
      orderPanel.appendChild(el('p', 'muted', 'Le cifre dell’ordine sono copiate dalla versione firmata e mai ricalcolate dal catalogo attuale. I periodi non si sommano mai e non si ricava nessuna cifra annualizzata o di contratto. In questa fase non esiste nessuno stato di fatturazione, fattura, pagamento o evasione.'));
      panel.appendChild(orderPanel);
      // Contract activation (Milestone 12) lives in the optional contracts
      // domain package: it renders only when the server publishes that domain.
      // It is a sibling section, never nested inside the order evidence —
      // that block stays free of controls.
      await renderActivation({ order, schema, mount, el, client, fetchRows, money, withBusy, busy });
    }
  }

  return { renderQuoteList, renderQuoteDetail };
}
