// @ts-check

import { formatMinorUnits } from './admin-core.js';

/**
 * Product catalog Admin (BO-F2-05 "11 Catalogo prodotti"): the backoffice
 * product table over `GET /api/catalog/products` — one row per product with
 * its source, active flag and current prices, plus the "connect Stripe"
 * invite the summary answers. Rules unchanged from the rest of the Admin:
 * every value renders as text (never HTML), the server is authoritative for
 * every amount, provider-sourced prices render read-only text (no inputs at
 * all — the write path refuses them with PROVIDER_PRICE_READONLY), and a
 * render token discards stale responses.
 */

const LIST_LIMIT = 200;

/**
 * The commercial schema block, wherever the composition publishes it: the
 * ambient top-level key before the extraction, the package's own contribution
 * under `domains` after it. Shared with the shell nav so the link and the
 * view gate on the same block.
 * @param {any} schema
 */
export function commercialBlock(schema) {
  return schema?.commercial ?? schema?.domains?.commercial;
}

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createCatalogView(deps) {
  const { doc, mount } = deps;
  const { client } = deps;
  let renderToken = 0;

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };
  const money = (cents, currency) => (typeof cents === 'number' ? formatMinorUnits(cents, currency) : '—');

  /** Quantity-tier labels ("etichette sconto quantità"): bounded ranges read as text. */
  function tierLabel(tier, currency) {
    const amount = money(tier.unitAmountCents ?? tier.flatAmountCents, currency);
    if (tier.upTo === null || tier.upTo === undefined) return `oltre: ${amount}`;
    return `fino a ${tier.upTo}: ${amount}`;
  }

  function priceLine(component, currency) {
    const base = component.pricingModel === 'flat_fee'
      ? money(component.flatAmountCents, currency)
      : money(component.unitAmountCents, currency);
    const per = component.pricingModel === 'per_unit' || component.pricingModel === 'flat_fee' ? '' : ` (${component.pricingModel})`;
    const every = component.interval ? ` / ${component.interval}` : '';
    const schedule = Array.isArray(component.tiers) && component.tiers.length > 0
      ? ` — ${component.tiers.map((tier) => tierLabel(tier, currency)).join(' · ')}`
      : '';
    return `${component.label ?? 'Prezzo'}: ${base}${per}${every}${schedule}`;
  }

  /**
   * Render the product table. Filters mirror the read's own vocabulary
   * (category exact, active flag, source name); empty values read unfiltered.
   */
  async function renderTable({ category = '', active = '', source = '' } = {}) {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('h2', 'panel-title', 'Catalogo prodotti'));
    const status = el('p', 'muted', 'Caricamento catalogo…');
    mount.appendChild(status);
    const params = new URLSearchParams();
    if (typeof category === 'string' && category.trim() !== '') params.set('category', category.trim());
    if (active === 'true' || active === 'false') params.set('active', active);
    if (typeof source === 'string' && source.trim() !== '') params.set('source', source.trim());
    params.set('limit', String(LIST_LIMIT));
    const query = params.toString();
    let schema;
    let table;
    try {
      schema = await client.request('/api/schema');
      table = await client.request(`/api/catalog/products${query ? `?${query}` : ''}`);
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = `Catalogo non leggibile: ${error?.message ?? 'richiesta fallita'}`;
      return;
    }
    if (token !== renderToken) return;
    if (!commercialBlock(schema) || !table || !Array.isArray(table.products)) {
      status.textContent = 'Il catalogo non è attivo in questo progetto.';
      return;
    }
    const summary = table.summary ?? {};
    if (summary.stripeConnected !== true) {
      const invite = el('p', 'catalog-invite', 'Stripe non è collegato: i prezzi si gestiscono a mano. Collega Stripe per importare il listino come fonte dei prezzi.');
      mount.appendChild(invite);
    }
    const shown = table.products.length;
    status.textContent = shown >= LIST_LIMIT
      ? `Mostrati i primi ${LIST_LIMIT} prodotti.`
      : `${shown} prodotto/i.`;

    const filters = el('div', 'catalog-filters');
    const categoryInput = el('input');
    categoryInput.setAttribute('name', 'category');
    categoryInput.setAttribute('aria-label', 'Filtra per categoria');
    categoryInput.setAttribute('placeholder', 'Categoria');
    categoryInput.value = typeof category === 'string' ? category : '';
    const activeSelect = el('select');
    activeSelect.setAttribute('name', 'active');
    activeSelect.setAttribute('aria-label', 'Filtra per stato');
    for (const [value, text] of [['', 'Tutti'], ['true', 'Attivi'], ['false', 'Non attivi']]) {
      const option = el('option', undefined, text);
      option.setAttribute('value', value);
      activeSelect.appendChild(option);
    }
    activeSelect.value = active === 'true' || active === 'false' ? active : '';
    const sourceInput = el('input');
    sourceInput.setAttribute('name', 'source');
    sourceInput.setAttribute('aria-label', 'Filtra per fonte');
    sourceInput.setAttribute('placeholder', 'Fonte (manual o nome provider)');
    sourceInput.value = typeof source === 'string' ? source : '';
    const applyButton = el('button', undefined, 'Filtra');
    const filterError = el('small', 'field-error', '');
    applyButton.addEventListener('click', async () => {
      applyButton.disabled = true;
      try {
        await renderTable({ category: categoryInput.value, active: activeSelect.value, source: sourceInput.value });
      } catch (error) {
        filterError.textContent = error?.message ?? 'Filtro fallito';
      } finally {
        applyButton.disabled = false;
      }
    });
    filters.appendChild(categoryInput);
    filters.appendChild(activeSelect);
    filters.appendChild(sourceInput);
    filters.appendChild(applyButton);
    filters.appendChild(filterError);
    mount.appendChild(filters);

    const list = el('div', 'catalog-list');
    for (const product of table.products) {
      const row = el('div', 'catalog-row');
      if (product.productId !== undefined) row.setAttribute('data-product', String(product.productId));
      const head = el('h3', undefined, `${product.name ?? 'Senza nome'} — ${product.sku ?? '—'}`);
      row.appendChild(head);
      const meta = el('p', 'catalog-meta');
      const state = product.active === true ? 'attivo' : 'non attivo';
      meta.textContent = `Fonte: ${product.source ?? '—'} · ${state}`
        + (product.category ? ` · ${product.category}` : '');
      row.appendChild(meta);
      if (product.priceReadOnly === true) {
        row.appendChild(el('p', 'catalog-readonly', 'Prezzi di fonte — sola lettura: si cambiano alla fonte e si sincronizzano.'));
      }
      const offers = Array.isArray(product.offers) ? product.offers : [];
      if (offers.length === 0) {
        row.appendChild(el('p', 'catalog-empty', 'Nessuna offerta.'));
      }
      for (const offer of offers) {
        const offerBox = el('div', 'catalog-offer');
        const offerState = offer.active === true ? '' : ' (non attiva)';
        offerBox.appendChild(el('p', 'catalog-offer-name', `${offer.name ?? 'Offerta'}${offerState}`));
        if (offer.quoteEligible === false) {
          offerBox.appendChild(el('p', 'catalog-ineligible', `Non quotabile: ${offer.unsupportedReason ?? 'modello non supportato'}`));
        }
        const components = Array.isArray(offer.components) ? offer.components : [];
        for (const component of components) {
          offerBox.appendChild(el('p', 'catalog-price', priceLine(component, offer.currency ?? undefined)));
        }
        row.appendChild(offerBox);
      }
      list.appendChild(row);
    }
    mount.appendChild(list);
  }

  return { renderTable };
}
