// @ts-check

import { elFor, uiBusy, uiSkeleton } from './admin-ui.js'; // BO-F6-02: the single component library.
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

/**
 * backlog:a2ea75f705fd: a discount in basis points as the operator writes a
 * percentage — 750 → «7,5», 1000 → «10», 0 → «0». Never «punti base».
 * @param {unknown} bps
 */
export function bpsToPercentText(bps) {
  const value = Number.isSafeInteger(bps) ? /** @type {number} */ (bps) : 0;
  return (value / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
}

/**
 * A percentage typed by the operator («7,5», «10», «0,25») as integer basis
 * points, or null when it is not a number from 0 to 100 with at most two
 * decimals. Empty reads 0: no discount.
 * @param {unknown} text
 */
export function percentToBps(text) {
  const raw = String(text ?? '').trim().replace('%', '').trim().replace(',', '.');
  if (raw === '') return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
  const bps = Math.round(Number(raw) * 100);
  return bps >= 0 && bps <= 10000 ? bps : null;
}

/** The refusal a malformed discount reads, before anything is sent. */
const DISCOUNT_FORMAT_TEXT = 'Scrivi lo sconto in percentuale, da 0 a 100 (es. 10 o 7,5).';

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
  /**
   * Voce 47b89e19: every link on this screen stays in the hash router. A
   * bare `<a href="#/...">` resolves against the shell's `<base href>`
   * mount (admin-base.js), so opening a quote moved the path from `/bo`
   * to `/bo/` and reloaded the whole app (pilota 12/11). preventDefault
   * plus navigate() sets only the hash, like every other /bo screen.
   */
  const linkTo = (href, text, className) => {
    const anchor = el('a', className, text);
    anchor.setAttribute('href', href);
    anchor.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate(href);
    });
    return anchor;
  };
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
  // backlog:cf270ae1f808: lo spazio tra numero e simbolo resta con il numero:
  // il primo spazio di formatAmount diventa non separabile, solo qui.
  const money = (cents, currency) => formatAmount(cents, currency).replace(' ', ' ');
  /** A discount field in percent (backlog:a2ea75f705fd). @param {string} value */
  const percentInput = (value) => {
    const input = el('input');
    input.setAttribute('type', 'text');
    input.setAttribute('inputmode', 'decimal');
    input.value = value;
    return input;
  };
  /** Basis points from a percent field; a malformed value refuses before any write. */
  const discountFrom = (input) => {
    const bps = percentToBps(input.value);
    if (bps === null) throw new Error(DISCOUNT_FORMAT_TEXT);
    return bps;
  };
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

  /**
   * Backlog 8dc6d4a456e1: the server always persists a zero-valued one-time
   * group, even for subscription-only quotes, so truthiness alone would
   * paint `0 €`. A totals group carries a value only with a nonzero net.
   */
  const groupHasValue = (group) => Number.isSafeInteger(group?.netAmountCents) && group.netAmountCents !== 0;

  /**
   * Summary of the valued totals groups, never mixing periods; an em dash
   * when no group carries a value, like the offer header.
   */
  const quoteTotalSummary = (totals, currency) => {
    const parts = [];
    if (groupHasValue(totals.oneTimeTotal)) parts.push(`una tantum ${money(totals.oneTimeTotal.netAmountCents, currency)}`);
    for (const group of totals.recurringTotals) {
      if (!groupHasValue(group)) continue;
      parts.push(`${money(group.netAmountCents, currency)} ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`);
    }
    return parts.length > 0 ? parts.join(' · ') : '—';
  };

  /**
   * Backlog 8dc6d4a456e1: the frozen version names the discount policy that
   * decided it (`name@version` from the version record), never nothing.
   */
  const policyTag = (version) => (
    typeof version?.policy === 'string' && version.policy !== '' && Number.isSafeInteger(version?.policyVersion)
      ? `${version.policy}@${version.policyVersion}`
      : null
  );

  async function fetchRows(module, filter) {
    const result = await client.request(`/api/modules/${module}/records?limit=${LIST_LIMIT}`);
    const rows = (result.items ?? []).filter(filter ?? (() => true));
    return { rows, truncated: (result.items ?? []).length >= LIST_LIMIT };
  }

  /**
   * backlog:d56122ee2844: one parent's rows, read server-side by their indexed
   * key — the same fetchLinked the offer page uses (backlog:d8175e1c3495),
   * reused here instead of a second mechanism. The detail painted whole tables
   * (up to LIST_LIMIT rows each) and filtered them in the browser, so every
   * paint and every post-write re-read waited for scans it never showed.
   * The client-side predicate stays on top: the server narrows the page, the
   * page still decides what it shows.
   */
  async function fetchLinked(module, field, id) {
    const result = await client.request(
      `/api/modules/${module}/records?limit=${LIST_LIMIT}&filter.${field}=${encodeURIComponent(String(id))}`,
    );
    const rows = Array.isArray(result?.items) ? result.items : [];
    return { rows, truncated: rows.length >= LIST_LIMIT };
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
      // backlog:a2ea75f705fd: the core offer route — the generic records
      // surface never serves core modules and answered 404 here.
      opportunity = await client.request(`/api/opportunities/${encodeURIComponent(opportunityId)}`);
    } catch {
      return { back: null, opportunityName: null, customerName: null };
    }
    const opportunityName = typeof opportunity?.name === 'string' && opportunity.name.trim() !== '' ? opportunity.name : null;
    // backlog:a2ea75f705fd: the quote opens its offer page — stato, valore
    // and the other quotes live there. Voce 47b89e19: through the router,
    // never a bare anchor (see linkTo).
    const offer = linkTo(`#/offerte/${encodeURIComponent(opportunityId)}`, 'Apri l’offerta →', 'quote-offer-link');
    offer.setAttribute('data-action', 'quote-open-offer');
    const contactId = typeof opportunity?.contactId === 'string' && opportunity.contactId !== '' ? opportunity.contactId : null;
    const companyId = typeof opportunity?.companyId === 'string' && opportunity.companyId !== '' ? opportunity.companyId : null;
    const resource = contactId !== null ? 'contact' : (companyId !== null ? 'company' : null);
    const subjectId = contactId ?? companyId;
    if (resource === null || subjectId === null) return { back: null, offer, opportunityName, customerName: null };
    const rawName = contactId !== null ? opportunity?.contactName : opportunity?.companyName;
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : null;
    if (name === null) return { back: null, offer, opportunityName, customerName: null };
    const back = linkTo(`#/customer-card/${resource}/${encodeURIComponent(subjectId)}`, `← ${name}`, 'quote-back');
    return { back, offer, opportunityName, customerName: name };
  }

  async function renderQuoteList() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('h2', 'panel-title', 'Preventivi'));
    const status = el('p', 'muted', 'Caricamento…');
    mount.appendChild(status);
    let schema;
    let quotes;
    /** Best-effort offer names for the «offerta collegata» line, like readOffer's list fallback. */
    let offerNames = null;
    /** backlog:cf270ae1f808: the same payload also names the customer, so the
     * list shows cliente without another read. */
    let offerCustomers = null;
    try {
      // backlog:d56122ee2844: le tre letture partono insieme, come nella
      // pagina offerta — lo schema decide solo se usarne la risposta.
      const schemaRead = client.request('/api/schema');
      schemaRead.catch(() => {});
      const quotesRead = fetchRows('quote');
      quotesRead.catch(() => {});
      const offersRead = client.request(`/api/opportunities?limit=${LIST_LIMIT}`);
      offersRead.catch(() => {});
      schema = await schemaRead;
      quotes = await quotesRead;
      try {
        const offers = await offersRead;
        offerNames = new Map();
        offerCustomers = new Map();
        for (const offer of offers?.items ?? []) {
          if (offer !== null && typeof offer === 'object' && typeof offer.id === 'string' && offer.id !== '') {
            offerNames.set(offer.id, typeof offer.name === 'string' && offer.name.trim() !== '' ? offer.name : null);
            const who = typeof offer.contactName === 'string' && offer.contactName.trim() !== '' ? offer.contactName.trim()
              : (typeof offer.companyName === 'string' && offer.companyName.trim() !== '' ? offer.companyName.trim() : null);
            offerCustomers.set(offer.id, who);
          }
        }
      } catch {
        offerNames = null;
        offerCustomers = null;
      }
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

    // Voce 47b89e19: quotes are created from their offer page («Crea
    // preventivo» there, backlog 169cd4bc988c) — never by typing an id
    // here. No manual id field on this screen.
    const page = el('div', 'bo-offer');
    const panel = el('section', 'offer-quotes');
    panel.appendChild(el('h3', undefined, 'Tutti i preventivi'));
    panel.appendChild(el('p', 'bo-muted', 'I preventivi si creano dall’offerta: apri l’offerta e premi «Crea preventivo».'));
    if (offerNames === null) {
      panel.appendChild(el('p', 'bo-muted', 'Offerte collegate non leggibili adesso: righe, stato e importo restano.'));
    }
    for (const quote of quotes.rows) {
      // Same components as the offer page: stato pill, importo, offerta
      // collegata, and the open link through the router (see linkTo).
      const row = el('div', 'offer-quote');
      row.setAttribute('data-quote', quote.id);
      const head = el('div', 'offer-quote-head');
      head.appendChild(el('span', `quote-status quote-status-${quote.status}`, quoteStatusLabel(quote.status)));
      head.appendChild(el('h4', 'offer-quote-total',
        quoteTotalSummary(parseTotals(quote.totalsJson), quote.currency)));
      head.appendChild(linkTo(`#/quotes/${encodeURIComponent(quote.id)}`, 'Apri il preventivo', 'offer-quote-open'));
      row.appendChild(head);
      // backlog:cf270ae1f808: ogni riga dice cliente e data, oltre a stato
      // e importo — il cliente arriva dal carico delle offerte, la data dal
      // record; niente letture in più, niente date inventate.
      const opportunityId = typeof quote.opportunityId === 'string' && quote.opportunityId !== '' ? quote.opportunityId : null;
      const facts = [];
      const customer = opportunityId !== null && offerCustomers !== null ? offerCustomers.get(opportunityId) ?? null : null;
      if (typeof customer === 'string' && customer !== '') facts.push(`Cliente: ${customer}`);
      const when = italianDay(quote.createdAt);
      if (when !== null) facts.push(when);
      if (facts.length > 0) row.appendChild(el('p', 'bo-muted', facts.join(' · ')));
      if (opportunityId !== null && offerNames !== null) {
        const line = el('p', 'bo-muted');
        line.appendChild(el('span', undefined, 'Offerta: '));
        const name = offerNames.has(opportunityId) ? offerNames.get(opportunityId) : undefined;
        if (typeof name === 'string' && name !== '') {
          line.appendChild(linkTo(`#/offerte/${encodeURIComponent(opportunityId)}`,
            name, 'quote-offer-link'));
        } else {
          line.appendChild(el('span', undefined, 'Offerta non leggibile'));
        }
        row.appendChild(line);
      }
      panel.appendChild(row);
    }
    page.appendChild(panel);
    mount.appendChild(page);
  }

  /**
   * backlog:d56122ee2844 (cura d8175e1c3495 della pagina offerta, riusata):
   * la pagina mostra subito la sua struttura — testata, voci, totale,
   * colonna con aggiunta riga e storico — a barre grigie, occupata per le
   * tecnologie assistive con una sola frase; il contenuto vero la
   * sostituisce tutta, un errore la sostituisce con la frase onesta.
   */
  function quoteSkeleton() {
    const page = el('div', 'bo-quote bo-quote-skeleton');
    page.setAttribute('aria-busy', 'true');
    page.setAttribute('data-quote-skeleton', 'true');
    const spoken = el('p', 'sr-only', 'Carico il preventivo…');
    spoken.setAttribute('role', 'status');
    page.appendChild(spoken);
    const sheet = el('article', 'bo-quote-sheet');
    const hero = el('header', 'bo-quote-hero');
    const words = el('div', 'bo-quote-hero-words');
    words.appendChild(el('p', 'bo-quote-kicker', 'Preventivo'));
    words.appendChild(uiSkeleton(doc, { width: '55%', block: true }));
    words.appendChild(uiSkeleton(doc, { width: '30%', block: true }));
    hero.appendChild(words);
    const total = el('div', 'bo-quote-hero-total');
    total.appendChild(uiSkeleton(doc, { width: '8em', block: true }));
    hero.appendChild(total);
    sheet.appendChild(hero);
    const linesCard = el('div', 'quote-lines');
    linesCard.appendChild(el('h3', undefined, 'Cosa include'));
    for (const width of ['72%', '54%']) linesCard.appendChild(uiSkeleton(doc, { width, block: true }));
    sheet.appendChild(linesCard);
    const totalsCard = el('div', 'quote-totals');
    totalsCard.appendChild(el('h3', undefined, 'Totale'));
    totalsCard.appendChild(uiSkeleton(doc, { width: '64%', block: true }));
    sheet.appendChild(totalsCard);
    page.appendChild(sheet);
    const side = el('aside', 'bo-quote-side');
    for (const [cls, title] of [['quote-add-line', 'Aggiungi riga'], ['quote-versions', 'Storico']]) {
      const card = el('div', cls);
      card.appendChild(el('h3', undefined, title));
      for (const width of ['72%', '54%']) card.appendChild(uiSkeleton(doc, { width, block: true }));
      side.appendChild(card);
    }
    page.appendChild(side);
    return page;
  }

  async function renderQuoteDetail(quoteId, options = {}) {
    const token = ++renderToken;
    // backlog:d56122ee2844: dopo una scrittura la pagina resta visibile —
    // la vecchia pittura resta finché i nuovi dati non arrivano. L'ingresso
    // dal router mostra sempre lo scheletro: il router pre-dipinge la sua
    // riga «Carico …» sul mount, quindi i figli del mount non dicono mai se
    // è la prima pittura — solo le ri-letture dalla pagina (withBusy) tengono
    // la vecchia pittura, con keep: true. Mai più una pagina bianca.
    // Review muse giro 1 (P1): inferirlo da mount.childNodes.length teneva
    // la riga generica del router per tutta la lettura, senza scheletro.
    const keep = options !== null && typeof options === 'object' && options.keep === true;
    const firstPaint = keep ? mount.childNodes.length === 0 : true;
    if (firstPaint) {
      clear();
      const heading = el('h2', 'panel-title', 'Preventivo');
      mount.appendChild(heading);
      mount.appendChild(quoteSkeleton());
    }
    let schema;
    let quote;
    let lines;
    let entries;
    let versions;
    let backLinkResolved;
    try {
      // backlog:d56122ee2844 (come la pagina offerta d8175e1c3495): ogni
      // lettura parte insieme — schema e preventivo prima, poi righe,
      // pacchetti, versioni e rimando alla scheda insieme.
      const schemaRead = client.request('/api/schema');
      schemaRead.catch(() => {});
      const quoteRead = client.request(`/api/modules/quote/records/${encodeURIComponent(quoteId)}`);
      quoteRead.catch(() => {});
      schema = await schemaRead;
      quote = await quoteRead;
      // No price book on the quote means no offer can belong to it: the read
      // is skipped instead of sending the server a filter it cannot mean.
      const bookRead = typeof quote.priceBookId === 'string' && quote.priceBookId !== ''
        ? fetchLinked('offer', 'priceBookId', quote.priceBookId)
        : Promise.resolve({ rows: [], truncated: false });
      const restRead = Promise.all([
        fetchLinked('quote-line', 'quoteId', quote.id),
        bookRead,
        fetchLinked('quote-version', 'quoteId', quote.id),
        resolveCardBackLink(quote),
      ]);
      restRead.catch(() => {});
      const [lineAnswer, entryAnswer, versionAnswer, backLink] = await restRead;
      // The server narrowed the page; the predicates stay as a second layer.
      lines = lineAnswer.rows
        .filter((line) => line.quoteId === quote.id && line.removed === false)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      entries = entryAnswer.rows
        .filter((offer) => offer.priceBookId === quote.priceBookId && offer.active === true && offer.quoteEligible === true);
      versions = versionAnswer.rows
        .filter((version) => version.quoteId === quote.id)
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
      backLinkResolved = backLink;
    } catch (error) {
      if (token !== renderToken) return;
      // Review muse giro 1 (P1): dopo una navigazione il mount tiene la riga
      // «Carico …» del router, senza .field-error — restare in silenzio la
      // lasciava appesa per sempre. humanReadError registra già la causa con
      // stato/codice; qui la frase onesta si vede sempre: sulla riga del
      // dettaglio quando c'è una pittura riuscita, altrimenti al posto di
      // tutto, tenendo la testata come faceva main.
      const message = humanReadError(error, { failed: 'Preventivo non leggibile. Riprova più tardi.' });
      const errorLine = mount.querySelector ? mount.querySelector('.field-error') : null;
      if (keep && token === renderToken) {
        // Arbitrato giro 2 (P1): una rilettura keep:true fallita deve
        // segnalarlo al chiamante (withBusy) dopo aver disegnato l'errore,
        // altrimenti i controlli restano disattivati e la pagina è mezza
        // bloccata. Unica strada: disegna qui, rilancia sempre.
        if (errorLine) {
          errorLine.textContent = message;
        } else {
          clear();
          mount.appendChild(el('h2', 'panel-title', 'Preventivo'));
          mount.appendChild(el('p', 'muted', message));
        }
        throw error;
      }
      if (errorLine) {
        errorLine.textContent = message;
      } else {
        clear();
        mount.appendChild(el('h2', 'panel-title', 'Preventivo'));
        mount.appendChild(el('p', 'muted', message));
      }
      return;
    }
    if (token !== renderToken) return;
    clear();
    const heading = el('h2', 'panel-title', 'Preventivo');
    mount.appendChild(heading);
    const status = el('p', 'muted', '');
    mount.appendChild(status);

    // Voce cf340b571e98: the way back to the scheda paints above the heading.
    // Heading and status already paint as the loading indicator, so they move
    // below the link with remove-then-append (a move in both the real DOM
    // and the test double, never a copy). Il rimando è già arrivato con le
    // altre letture (backlog:d56122ee2844): qui si usa, non si rilegge.
    const { back, offer = null, opportunityName, customerName } = backLinkResolved;
    if (token !== renderToken) return;
    // backlog:cf270ae1f808: il titolo porta il cliente quando si conosce,
    // con il nome dell'offerta accanto quando si conosce anche quello —
    // due preventivi dello stesso cliente da offerte diverse non hanno mai
    // lo stesso titolo. Mai un «Preventivo» senza nome.
    const titleName = customerName !== null && opportunityName !== null
      ? `${customerName} — ${opportunityName}`
      : (customerName ?? opportunityName);
    if (titleName !== null) heading.textContent = `Preventivo · ${titleName}`;
    if (back !== null || offer !== null) {
      mount.removeChild(heading);
      mount.removeChild(status);
      if (back !== null) mount.appendChild(back);
      mount.appendChild(heading);
      if (offer !== null) mount.appendChild(offer);
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
    heading.textContent = titleName !== null ? `Preventivo · ${titleName}` : 'Preventivo';
    heroWords.appendChild(heading);
    const meta = el('p', 'bo-quote-meta');
    if (customerName !== null) meta.appendChild(el('span', 'bo-quote-for', `Per ${customerName}`));
    if (versions.length > 0) meta.appendChild(el('span', 'bo-quote-version', `Versione ${versions[0].versionNumber}`));
    meta.appendChild(el('span', `quote-status quote-status-${quote.status}`, quoteStatusLabel(quote.status) ?? '—'));
    heroWords.appendChild(meta);
    hero.appendChild(heroWords);
    const heroTotal = el('div', 'bo-quote-hero-total');
    const valuedOneTime = groupHasValue(totals.oneTimeTotal) ? totals.oneTimeTotal : null;
    const valuedRecurring = totals.recurringTotals.filter(groupHasValue);
    const lead = valuedOneTime ?? valuedRecurring[0] ?? null;
    if (lead !== null) {
      heroTotal.appendChild(el('span', 'bo-quote-amount', money(lead.netAmountCents, lead.currency ?? quote.currency)));
      heroTotal.appendChild(el('span', 'bo-quote-amount-note', valuedOneTime
        ? 'una tantum, netto'
        : `ogni ${lead.intervalCount} ${periodLabel(lead.intervalCount, lead.interval)}, netto`));
      if (valuedOneTime && valuedRecurring.length > 0) {
        const next = valuedRecurring[0];
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
    // The Totale panel names only valued groups, like the hero above: a
    // zero-valued group is an unpriced component, never a «0 €» row.
    if (valuedOneTime !== null) totalRow('Una tantum', valuedOneTime, totals.vat?.oneTime ?? null);
    totals.recurringTotals.forEach((group, index) => {
      if (!groupHasValue(group)) return;
      totalRow(`Ricorrente ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}`, group, totals.vat?.recurring?.[index] ?? null);
    });
    if (valuedOneTime === null && !totals.recurringTotals.some(groupHasValue)) {
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
        await renderQuoteDetail(quoteId, { keep: true }); // re-render from server state
      } catch (error) {
        // La rilettura keep:true fallita ha già scritto il messaggio onesto
        // in riga prima di rilanciare: non coprirlo con il testo grezzo.
        if (errorLine.textContent === '') errorLine.textContent = error?.message ?? 'Richiesta non riuscita';
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
        ? ` · sconto ${((line.discountBps ?? 0) / 100).toFixed(2).replace('.', ',')}%${Number.isSafeInteger(line.discountAmountCents) && line.discountAmountCents > 0 ? ` (−${money(line.discountAmountCents, quote.currency)})` : ''}`
        : '';
      // The price components only for a composite offer or a tiered one: a
      // single fixed price repeated the line above word for word.
      const breakdown = parseBreakdown(line.breakdownJson);
      // backlog:b9b7912320f8: una riga di sole quote fisse non ha una
      // quantità che cambia il prezzo (ADR-016: la quota fissa si addebita
      // una volta per riga) — si legge «Quota fissa», mai «Quantità 2».
      const flatOnly = breakdown.length > 0 && breakdown.every((component) =>
        component?.pricingModel === 'flat_fee' && (component.tierBreakdown ?? []).length === 0);
      const head = el('span', 'quote-line-head');
      head.appendChild(el('span', 'quote-line-name', line.offerName));
      head.appendChild(el('span', 'quote-line-meta', flatOnly ? `Quota fissa${lineDiscount}` : `Quantità ${line.quantity}${lineDiscount}`));
      head.appendChild(el('span', 'quote-line-amount', money(line.netAmountCents, quote.currency)));
      row.appendChild(head);
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
        // backlog:b9b7912320f8: la quantità di una quota fissa non si tocca:
        // il campo resta visibile ma bloccato, con la spiegazione.
        if (flatOnly) {
          quantityInput.disabled = true;
          quantityInput.setAttribute('title', 'Quota fissa: la quantità non cambia il prezzo');
        }
        const discountInput = percentInput(bpsToPercentText(line.discountBps ?? 0));
        const updateButton = el('button', undefined, 'Aggiorna');
        const removeButton = el('button', undefined, 'Rimuovi');
        busy.push(updateButton, removeButton);
        updateButton.addEventListener('click', () => uiBusy(updateButton, 'Aggiorno…', () => withBusy(() => act('update-line', {
          lineId: line.id,
          quantity: Number(quantityInput.value),
          discountBps: discountFrom(discountInput),
          expectedRevision: quote.draftRevision,
        }))));
        removeButton.addEventListener('click', () => uiBusy(removeButton, 'Rimuovo…', () => withBusy(() => act('remove-line', {
          lineId: line.id,
          expectedRevision: quote.draftRevision,
        }))));
        const edit = el('div', 'quote-line-edit');
        edit.appendChild(labelled('Quantità', quantityInput));
        if (flatOnly) edit.appendChild(el('small', 'muted', 'Quota fissa: la quantità non cambia il prezzo.'));
        edit.appendChild(labelled('Sconto (%)', discountInput));
        edit.appendChild(updateButton);
        edit.appendChild(removeButton);
        row.appendChild(edit);
        row.__update = () => withBusy(() => act('update-line', { lineId: line.id, quantity: Number(quantityInput.value), discountBps: discountFrom(discountInput), expectedRevision: quote.draftRevision }));
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
      const discountInput = percentInput('0');
      const hint = el('small', 'muted', 'La quantità vale per le componenti a unità e a scaglioni; le quote fisse si addebitano una volta. Lo sconto è in percentuale, es. 10 o 7,5.');
      const addButton = el('button', undefined, 'Aggiungi riga');
      busy.push(addButton);
      addButton.addEventListener('click', () => uiBusy(addButton, 'Aggiungo…', () => withBusy(() => act('add-line', {
        offerId: entrySelect.value,
        quantity: Number(quantityInput.value),
        discountBps: discountFrom(discountInput),
        expectedRevision: quote.draftRevision,
      }))));
      addPanel.appendChild(labelled('Pacchetto', entrySelect));
      addPanel.appendChild(labelled('Quantità', quantityInput));
      addPanel.appendChild(labelled('Sconto (%)', discountInput));
      addPanel.appendChild(hint);
      addPanel.appendChild(addButton);
      addPanel.__add = () => withBusy(() => act('add-line', { offerId: entrySelect.value, quantity: Number(quantityInput.value), discountBps: discountFrom(discountInput), expectedRevision: quote.draftRevision }));
      addPanel.__entry = entrySelect;
      addPanel.__quantity = quantityInput;
      addPanel.__discount = discountInput;
      side.appendChild(addPanel);

      const submitPanel = el('div', 'quote-submit');
      submitPanel.appendChild(el('h3', undefined, 'Invia per l’approvazione'));
      // backlog:a2ea75f705fd: the discount rule is a choice only when there
      // is one to make. One rule is simply applied; none means the send is
      // not available here, said once — never an empty menu.
      const policies = (commercialBlock(schema)?.discountPolicies ?? [])
        .filter((policy) => typeof policy?.name === 'string' && policy.name !== '' && Number.isSafeInteger(policy?.version));
      const policySelect = el('select');
      for (const policy of policies) {
        const option = el('option', undefined, `${policy.label ?? policy.name} (v${policy.version})`);
        option.setAttribute('value', `${policy.name}@${policy.version}`);
        policySelect.appendChild(option);
        if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
      }
      const submitButton = el('button', undefined, 'Invia');
      busy.push(submitButton);
      submitButton.addEventListener('click', () => uiBusy(submitButton, 'Invio…', () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      })));
      if (policies.length === 0) {
        submitPanel.appendChild(el('p', 'muted quote-submit-off', 'L’invio per l’approvazione non è ancora disponibile in questo spazio.'));
      } else {
        if (policies.length > 1) submitPanel.appendChild(labelled('Regola di sconto', policySelect));
        submitPanel.appendChild(submitButton);
      }
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
      approveButton.addEventListener('click', () => uiBusy(approveButton, 'Approvo…', () => withBusy(() => act('approve', reasonInput.value ? { reason: reasonInput.value } : {}))));
      rejectButton.addEventListener('click', () => uiBusy(rejectButton, 'Rifiuto…', () => withBusy(() => act('reject', { reason: reasonInput.value }))));
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
      reviseButton.addEventListener('click', () => uiBusy(reviseButton, 'Riapro…', () => withBusy(() => act('revise', {}))));
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
      const valuedParts = [];
      if (groupHasValue(versionTotals.oneTimeTotal)) {
        valuedParts.push(`una tantum ${money(versionTotals.oneTimeTotal.netAmountCents, version.currency)}${vatText(versionTotals.vat?.oneTime ?? null, version.currency, versionTotals.vatRateBps)}`);
      }
      versionTotals.recurringTotals.forEach((group, index) => {
        if (!groupHasValue(group)) return;
        valuedParts.push(`${money(group.netAmountCents, version.currency)} ogni ${group.intervalCount} ${periodLabel(group.intervalCount, group.interval)}${vatText(versionTotals.vat?.recurring?.[index] ?? null, version.currency, versionTotals.vatRateBps)}`);
      });
      const periods = valuedParts.length > 0 ? valuedParts.join(' · ') : '—';
      const policy = policyTag(version);
      const link = linkTo(`#/modules/quote-version/${encodeURIComponent(version.id)}`,
        `Versione ${version.versionNumber} · ${policyDecisionLabel(version.policyDecision)}${policy ? ` · ${policy}` : ''} · ${periods}`,
        'quote-version-open');
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
      // backlog:d56122ee2844: the evidence reads leave together, index-backed
      // (fetchLinked, like the offer page) — never five serial whole-table
      // scans. Signers and order totals follow only when there is something
      // to hang them on: without an envelope the request form below needs no
      // other read. Predicates stay as a second layer on each narrowed page.
      const [envelopeAnswer, artifactAnswer, orderAnswer] = await Promise.all([
        fetchLinked('signature-envelope', 'quoteId', quote.id),
        fetchLinked('signed-artifact', 'quoteId', quote.id),
        fetchLinked('order', 'quoteId', quote.id),
      ]);
      envelopes = envelopeAnswer.rows.filter((row) => row.quoteId === quote.id);
      artifacts = artifactAnswer.rows.filter((row) => row.quoteId === quote.id);
      orders = orderAnswer.rows.filter((row) => row.quoteId === quote.id);
      const filled = envelopes[0] ?? null;
      if (filled === null) {
        signers = [];
        orderTotals = [];
      } else {
        const signerRead = fetchLinked('signature-signer', 'envelopeId', filled.id);
        const totalReads = Promise.all(orders.map((row) => fetchLinked('order-total', 'orderId', row.id)));
        const [signerAnswer, totalAnswers] = await Promise.all([signerRead, totalReads]);
        signers = signerAnswer.rows.filter((row) => row.envelopeId === filled.id);
        orderTotals = totalAnswers.flatMap((answer, index) =>
          answer.rows.filter((row) => row.orderId === orders[index].id));
      }
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
      requestButton.addEventListener('click', () => uiBusy(requestButton, 'Invio…', request));
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
    state.setAttribute('data-signature-provider', String(envelope.provider ?? ''));
    state.setAttribute('data-signature-version', String(envelope.providerVersion ?? ''));
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
      reconcileButton.addEventListener('click', () => uiBusy(reconcileButton, 'Controllo…', reconcile));
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
