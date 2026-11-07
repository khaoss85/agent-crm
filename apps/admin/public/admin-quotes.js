// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { formatAmount, humanReadError, italianDay } from './admin-core.js';
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
/**
 * The policy reason the server writes speaks basis points («sconto massimo
 * 0bps entro il limite 1000bps»): the owner reads percentages.
 * @param {unknown} reason
 */
export function percentReason(reason) {
  return String(reason ?? '').replace(/(\d+)\s?bps\b/g, (_, bps) =>
    `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',')}%`);
}

export function createQuoteView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  /** The space the quote is issued by (Dan 06/11: a quote is a little personal). */
  const spaceName = () => {
    try {
      const name = typeof deps.spaceName === 'function' ? deps.spaceName() : deps.spaceName;
      return typeof name === 'string' ? name.trim() : '';
    } catch {
      return '';
    }
  };
  const { client } = bindAdminMutations(deps.client, deps);
  let renderToken = 0;

  const el = elFor(doc); // BO-F6-02: shared element builder.
  /** A small labelled field: the label names the input (never a bare «1» / «0»). */
  const labelled = (text, input) => {
    const field = el('label', 'quote-field');
    field.appendChild(el('span', 'quote-field-label', text));
    field.appendChild(input);
    return field;
  };
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
    if (opportunityId === null) return { back: null, opportunityName: null, customerName: null };
    let opportunity;
    try {
      opportunity = await client.request(`/api/modules/opportunity/records/${encodeURIComponent(opportunityId)}`);
    } catch {
      return { back: null, opportunityName: null, customerName: null };
    }
    const opportunityName = typeof opportunity?.name === 'string' && opportunity.name.trim() !== '' ? opportunity.name : null;
    const contactId = typeof opportunity?.contactId === 'string' && opportunity.contactId !== '' ? opportunity.contactId : null;
    const companyId = typeof opportunity?.companyId === 'string' && opportunity.companyId !== '' ? opportunity.companyId : null;
    const resource = contactId !== null ? 'contact' : (companyId !== null ? 'company' : null);
    const subjectId = contactId ?? companyId;
    if (resource === null || subjectId === null) return { back: null, opportunityName, customerName: null };
    const rawName = contactId !== null ? opportunity?.contactName : opportunity?.companyName;
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : null;
    if (name === null) return { back: null, opportunityName, customerName: null };
    const back = el('a', 'quote-back');
    back.setAttribute('href', `#/customer-card/${resource}/${encodeURIComponent(subjectId)}`);
    // Text only: a hostile customer name stays inert text inside the link.
    back.textContent = `← ${name}`;
    return { back, opportunityName, customerName: name };
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
    const { back, opportunityName, customerName } = await resolveCardBackLink(quote);
    if (token !== renderToken) return;
    if (opportunityName !== null) heading.textContent = `Preventivo · ${opportunityName}`;
    if (back !== null) {
      mount.removeChild(heading);
      mount.removeChild(status);
      mount.appendChild(back);
      mount.appendChild(heading);
      mount.appendChild(status);
    }

    // Design (Dan 06/11): the quote reads as a small, tidy document — the
    // issuing space, who it is for, what it includes and what it costs — with
    // the workflow (approval, signature, history) in a side column.
    const totals = parseTotals(quote.totalsJson);
    const page = el('div', 'bo-quote');
    page.setAttribute('data-status', quote.status);
    const sheet = el('article', 'bo-quote-sheet');
    const side = el('aside', 'bo-quote-side');
    page.appendChild(sheet);
    page.appendChild(side);
    const hero = el('header', 'bo-quote-hero');
    const heroWords = el('div', 'bo-quote-hero-words');
    const issuer = spaceName();
    heroWords.appendChild(el('p', 'bo-quote-kicker', issuer !== '' ? `Preventivo · ${issuer}` : 'Preventivo'));
    mount.removeChild(heading);
    heading.setAttribute('class', 'bo-quote-title');
    heading.textContent = opportunityName ?? 'Preventivo';
    heroWords.appendChild(heading);
    const meta = el('p', 'bo-quote-meta');
    if (customerName !== null) meta.appendChild(el('span', 'bo-quote-for', `Per ${customerName}`));
    if (versions.length > 0) meta.appendChild(el('span', 'bo-quote-version', `Versione ${versions[0].versionNumber}`));
    meta.appendChild(el('span', `quote-status quote-status-${quote.status}`, quoteStatusLabel(quote.status) ?? '—'));
    heroWords.appendChild(meta);
    hero.appendChild(heroWords);
    const heroTotal = el('div', 'bo-quote-hero-total');
    const lead = totals.oneTimeTotal ?? totals.recurringTotals[0] ?? null;
    if (lead !== null) {
      heroTotal.appendChild(el('span', 'bo-quote-amount', money(lead.netAmountCents, lead.currency ?? quote.currency)));
      heroTotal.appendChild(el('span', 'bo-quote-amount-note', totals.oneTimeTotal
        ? 'una tantum, netto'
        : `ogni ${lead.intervalCount} ${periodLabel(lead.intervalCount, lead.interval)}, netto`));
      if (totals.oneTimeTotal && totals.recurringTotals.length > 0) {
        const next = totals.recurringTotals[0];
        heroTotal.appendChild(el('span', 'bo-quote-amount-note', `+ ${money(next.netAmountCents, next.currency ?? quote.currency)} ogni ${next.intervalCount} ${periodLabel(next.intervalCount, next.interval)}`));
      }
    }
    hero.appendChild(heroTotal);
    sheet.appendChild(hero);
    mount.removeChild(status);
    mount.appendChild(page);
    sheet.appendChild(status);


    // Grouped totals: the one-time group and each recurring period are shown
    // SEPARATELY — unlike periods are never summed, and no ARR/MRR/TCV is
    // derived (contract term and normalization are not modeled).
    const totalsPanel = el('div', 'quote-totals');
    totalsPanel.setAttribute('data-recurring-groups', String(totals.recurringTotals.length));
    totalsPanel.appendChild(el('h3', undefined, 'Totale'));
    const totalRow = (label, group, vatEntry) => {
      const row = el('p', 'quote-total-row');
      row.setAttribute('data-total', label);
      row.appendChild(el('span', 'quote-total-label', `${label}: `));
      const currency = group.currency ?? quote.currency;
      // List price and discount only when a discount exists: «sconto 0 €»
      // told the owner nothing.
      const discounted = Number(group.discountAmountCents ?? 0) > 0
        ? ` (listino ${money(group.listAmountCents, currency)}, sconto ${money(group.discountAmountCents, currency)})`
        : '';
      const value = el('span', 'quote-total-value');
      value.appendChild(el('strong', undefined, money(group.netAmountCents, currency)));
      value.appendChild(el('span', 'quote-total-detail', ` netto${discounted}${vatText(vatEntry, currency, totals.vatRateBps)}`));
      row.appendChild(value);
      totalsPanel.appendChild(row);
    };
    if (totals.oneTimeTotal) totalRow('Una tantum', totals.oneTimeTotal, totals.vat?.oneTime ?? null);
    totals.recurringTotals.forEach((group, index) => {
      totalRow(`Ricorrente ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`, group, totals.vat?.recurring?.[index] ?? null);
    });
    if (!totals.oneTimeTotal && totals.recurringTotals.length === 0) {
      totalsPanel.appendChild(el('p', 'empty', 'Ancora nessuna riga.'));
    }
    totalsPanel.appendChild(el('p', 'quote-totals-note', 'Una tantum e importi ricorrenti restano separati: non si sommano tra loro.'));

    const errorLine = el('small', 'field-error', '');
    side.appendChild(errorLine);
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
    linesPanel.appendChild(el('h3', undefined, lines.length === 1 ? 'Cosa include' : `Cosa include · ${lines.length} voci`));
    if (lines.length === 0) linesPanel.appendChild(el('p', 'quote-lines-empty', 'Ancora nessuna voce in questo preventivo.'));
    for (const line of lines) {
      const row = el('div', 'quote-line');
      row.setAttribute('data-line', line.id);
      // The owner reads the package, the quantity, a discount only when one
      // applies, and the net: SKU and offer revision stay in the records.
      const lineDiscount = (line.discountBps ?? 0) > 0
        ? ` · sconto ${((line.discountBps ?? 0) / 100).toFixed(2).replace('.', ',')}%`
        : '';
      const head = el('span', 'quote-line-head');
      head.appendChild(el('span', 'quote-line-name', line.offerName));
      head.appendChild(el('span', 'quote-line-meta', `Quantità ${line.quantity}${lineDiscount}`));
      head.appendChild(el('span', 'quote-line-amount', money(line.netAmountCents, quote.currency)));
      row.appendChild(head);
      // The price components only for a composite offer or a tiered one: a
      // single fixed price repeated the line above word for word.
      const breakdown = parseBreakdown(line.breakdownJson);
      const componentList = el('div', 'quote-components');
      if (breakdown.length <= 1 && !(breakdown[0]?.tierBreakdown ?? []).length) componentList.setAttribute('hidden', '');
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
        const edit = el('div', 'quote-line-edit');
        edit.appendChild(labelled('Quantità', quantityInput));
        edit.appendChild(labelled('Sconto (punti base)', discountInput));
        edit.appendChild(updateButton);
        edit.appendChild(removeButton);
        row.appendChild(edit);
        row.__update = () => withBusy(() => act('update-line', { lineId: line.id, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
        row.__quantity = quantityInput;
        row.__discount = discountInput;
      }
      linesPanel.appendChild(row);
    }
    sheet.appendChild(linesPanel);
    sheet.appendChild(totalsPanel);

    if (quote.status === 'draft') {
      const addPanel = el('div', 'quote-add-line');
      addPanel.appendChild(el('h3', undefined, 'Aggiungi riga'));
      const entrySelect = el('select');
      for (const entry of entries) {
        const count = Number(entry.componentCount) || 0;
        const option = el('option', undefined, count > 1 ? `${entry.name} — ${count} componenti` : entry.name);
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
      addPanel.appendChild(labelled('Pacchetto', entrySelect));
      addPanel.appendChild(labelled('Quantità', quantityInput));
      addPanel.appendChild(labelled('Sconto (punti base)', discountInput));
      addPanel.appendChild(hint);
      addPanel.appendChild(addButton);
      addPanel.__add = () => withBusy(() => act('add-line', { offerId: entrySelect.value, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
      addPanel.__entry = entrySelect;
      addPanel.__quantity = quantityInput;
      addPanel.__discountBps = discountInput;
      side.appendChild(addPanel);

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
      submitPanel.appendChild(labelled('Regola di sconto', policySelect));
      submitPanel.appendChild(submitButton);
      submitPanel.__submit = () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      });
      side.appendChild(submitPanel);
    }

    if (quote.status === 'pending_approval') {
      const decidePanel = el('div', 'quote-decide');
      decidePanel.appendChild(el('h3', undefined, 'In attesa di approvazione'));
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
      side.appendChild(decidePanel);
    }

    if (quote.status === 'rejected') {
      const revisePanel = el('div', 'quote-revise');
      const reviseButton = el('button', undefined, 'Rivedi (torna in bozza)');
      busy.push(reviseButton);
      reviseButton.addEventListener('click', () => withBusy(() => act('revise', {})));
      revisePanel.appendChild(reviseButton);
      revisePanel.__revise = () => withBusy(() => act('revise', {}));
      side.appendChild(revisePanel);
    }

    if (quote.status === 'approved') {
      side.appendChild(el('p', 'quote-approved', 'Approvato: righe e prezzi sono in sola lettura.'));
      await renderSignature({ quote, schema, mount: side, el, client, withBusy, busy, money, quoteStatusLabel, periodLabel });
    }

    const versionsPanel = el('div', 'quote-versions');
    versionsPanel.appendChild(el('h3', undefined, 'Storico'));
    if (versions.length === 0) {
      versionsPanel.appendChild(el('p', 'quote-versions-empty', 'Ancora nessuna versione: nasce quando il preventivo va in approvazione.'));
    }
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
      if (version.decisionReason) row.appendChild(el('span', 'muted', ` — ${percentReason(version.decisionReason)}`));
      versionsPanel.appendChild(row);
    }
    side.appendChild(versionsPanel);
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
      if (status === 'failed') return 'Non riuscita';
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
      form.appendChild(el('p', 'muted', 'Il preventivo parte davvero verso il firmatario: controlla nome ed email prima di inviarlo.'));
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
    // Voce ef92f728: the owner reads the state and who handles the signature.
    // Provider ids, hashes and formats are evidence for audits, not words for
    // the owner: they stay on the node as data attributes, never as text.
    state.setAttribute('data-provider-envelope', String(envelope.providerEnvelopeId ?? ''));
    state.setAttribute('data-document-hash', String(envelope.documentHash ?? ''));
    state.setAttribute('data-document-format', String(envelope.documentFormat ?? ''));
    const providerLabel = (signatureBlock(schema).providers ?? [])
      .find((provider) => provider?.name === envelope.provider)?.label;
    for (const [label, value] of [
      ['Stato', envelopeStatusLabel(envelope.status)],
      ['Servizio di firma', typeof providerLabel === 'string' && providerLabel !== '' ? providerLabel : 'servizio esterno'],
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
      // Phase and code are for the log, never for the owner (backlog:9da124e5).
      state.setAttribute('data-failure-code', String(envelope.failureCode));
      state.setAttribute('data-failure-phase', String(envelope.failurePhase ?? ''));
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[bo] firma non riuscita', { phase: envelope.failurePhase ?? null, code: envelope.failureCode });
      }
      state.appendChild(el('p', 'signature-failure', `L’invio per la firma non è andato a buon fine. ${outcome}`));
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
      const role = typeof signer.role === 'string' && signer.role.trim() !== '' ? ` · ${signer.role}` : '';
      row.textContent = `${signer.signingOrder}. ${signer.name} · ${signer.email}${role} · ${signerStatusLabel(signer.status)}`;
      signerList.appendChild(row);
    }
    panel.appendChild(signerList);

    const artifact = artifacts[0] ?? null;
    if (artifact) {
      const evidence = el('div', 'signed-artifact');
      evidence.setAttribute('data-artifact', artifact.id);
      // Voce ef92f728: ids, hashes and the storage reference stay on the node
      // as evidence; the owner reads when the document was signed.
      evidence.setAttribute('data-provider-artifact', String(artifact.providerArtifactId ?? ''));
      evidence.setAttribute('data-document-hash', String(artifact.documentHash ?? ''));
      evidence.setAttribute('data-artifact-hash', String(artifact.artifactHash ?? ''));
      evidence.setAttribute('data-storage-ref', String(artifact.storageRef ?? ''));
      evidence.appendChild(el('h4', undefined, 'Documento firmato'));
      for (const [label, value] of [
        ['Firmato il', italianDay(artifact.completedAt) ?? '—'],
      ]) {
        const row = el('p', 'artifact-fact');
        row.appendChild(el('strong', undefined, `${label}: `));
        row.appendChild(el('span', undefined, String(value ?? '—')));
        evidence.appendChild(row);
      }
      evidence.appendChild(el('p', 'muted', 'Il documento firmato resta presso il servizio di firma: qui ne teniamo traccia. Nessuna garanzia di conservazione a lungo termine, e non è una firma legalmente qualificata.'));
      panel.appendChild(evidence);
    }

    const order = orders[0] ?? null;
    if (order) {
      const orderPanel = el('div', 'quote-order');
      orderPanel.setAttribute('data-order', order.id);
      orderPanel.appendChild(el('h3', undefined, 'Ordine'));
      const idRow = el('p', 'order-fact');
      idRow.appendChild(el('strong', undefined, 'Stato: '));
      idRow.appendChild(el('span', undefined, `${orderStatusLabel(order.status)} · accettato il ${italianDay(order.acceptedAt) ?? '—'}`));
      orderPanel.appendChild(idRow);
      for (const total of orderTotals.filter((row) => row.orderId === order.id)) {
        const row = el('p', 'order-total');
        row.setAttribute('data-total', total.kind === 'one_time' ? 'Una tantum' : `Ricorrente ogni ${total.intervalCount} ${periodLabel(total.intervalCount, total.interval)}`);
        row.textContent = total.kind === 'one_time'
          ? `Una tantum: ${money(total.netAmountCents, total.currency)} netto`
          : `Ricorrente ogni ${total.intervalCount} ${periodLabel(total.intervalCount, total.interval)}: ${money(total.netAmountCents, total.currency)} netto`;
        orderPanel.appendChild(row);
      }
      orderPanel.appendChild(el('p', 'muted', 'Gli importi dell’ordine sono quelli della versione firmata, mai ricalcolati dal listino attuale. Una tantum e importi ricorrenti restano separati.'));
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
