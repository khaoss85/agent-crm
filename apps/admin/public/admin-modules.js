// @ts-check

// DOM views for generated modules. Every value coming from schema metadata or
// records is inserted through textContent / setAttribute / .value — never
// innerHTML — so hostile manifest or record strings are inert data, never HTML.

import {
  SUPPORTED_ADMIN_CONTRACT,
  fieldControl,
  editableFields,
  managedFields,
  buildCreatePayload,
  buildUpdatePayload,
  apiErrorToFormErrors,
  displayTitle,
  formatAmount,
  humanizeLabel,
  hasCapability,
  humanReadError,
  isNotComposedFailure,
  isUnsupportedContractFailure,
} from './admin-core.js';
import { createSubmissionController } from './admin-submission.js';
import { takePendingCustomerPick } from './admin-prefill.js';

function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const LIST_LIMIT = 100;
const REFERENCE_OPTION_LIMIT = 100;
// Bound the by-id fallback fetches for unresolved reference labels in a list,
// so a page of records pointing at many off-page targets cannot fan out into
// an unbounded request storm. Beyond this, the raw id is shown.
const REFERENCE_LABEL_FETCH_BUDGET = 25;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, class?: string, attrs?: Record<string, string>}} [options]
 */
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * A view controller for the generated-module screens. Injecting `doc`, `client`
 * and `nav` keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate: (hash: string) => void, toast?: (message: string, error?: boolean) => void}} deps
 */
/**
 * Voce 96e7b579: catalog pricing rules for Nuova offerta. Only active
 * offers in one currency, with plain flat/per-unit components and no
 * tiers, are tickable — tiered or exotic offers paint as text and stay
 * manual. Amounts are integer cents, quantities positive integers.
 * @param {any} offer
 */
function isPricedOffer(offer) {
  if (offer === null || typeof offer !== 'object') return false;
  if (offer.active !== true) return false;
  if (typeof offer.currency !== 'string' || offer.currency === '') return false;
  if (!Array.isArray(offer.components) || offer.components.length === 0) return false;
  return offer.components.every((component) => {
    if (component === null || typeof component !== 'object') return false;
    if (Array.isArray(component.tiers) && component.tiers.length > 0) return false;
    if (component.pricingModel === 'flat_fee') return Number.isSafeInteger(component.flatAmountCents);
    if (component.pricingModel === 'per_unit') return Number.isSafeInteger(component.unitAmountCents);
    return false;
  });
}

/** @param {any} component @param {string} currency */
function componentPriceText(component, currency) {
  if (component.pricingModel === 'flat_fee') return formatAmount(component.flatAmountCents, currency);
  return `${formatAmount(component.unitAmountCents, currency)} cad.`;
}

/** @param {{components: Array<any>, currency: string}} offer */
function offerPriceText(offer) {
  return offer.components.map((component) => componentPriceText(component, offer.currency)).join(' + ');
}

/**
 * Total the ticked offers: flat fees count once, per-unit prices
 * multiply by the row quantity. Null when nothing is ticked; a named
 * error when the selection cannot total honestly.
 * @param {Array<Record<string, any>>} picks
 */
function selectedProductTotal(picks) {
  const chosen = picks.filter((pickRow) => pickRow.checkbox?.checked === true);
  if (chosen.length === 0) return null;
  const currencies = new Set(chosen.map((pickRow) => String(pickRow.offer.currency ?? '').toUpperCase()));
  if (currencies.size > 1) return { error: 'mixed' };
  let total = 0;
  for (const pickRow of chosen) {
    const rawQty = pickRow.qtyInput === null ? '1' : String(pickRow.qtyInput.value ?? '1').trim();
    const qty = /^\d+$/.test(rawQty) ? Number(rawQty) : NaN;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1000000) return { error: 'qty' };
    for (const component of pickRow.offer.components) {
      if (component.pricingModel === 'flat_fee') total += component.flatAmountCents;
      else total += component.unitAmountCents * qty;
    }
    if (!Number.isSafeInteger(total)) return { error: 'qty' };
  }
  return { total, currency: [...currencies][0] };
}

export function createModuleAdmin(deps) {
  const { doc, mount, client, navigate } = deps;
  const toast = deps.toast ?? (() => {});
  const submissions = deps.submissions ?? createSubmissionController({
    storage: deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? memoryStorage() : globalThis.localStorage),
    transport: (path, options) => client.request(path, {
      method: options.method,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
      idempotencyKey: options.idempotencyKey,
      headers: { ...(options.headers ?? {}), 'Idempotency-Key': options.idempotencyKey },
    }),
  });

  /** Guard against stale async responses overwriting a newer view. */
  let renderToken = 0;

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { class: 'panel' });
    box.appendChild(el(doc, 'p', { class: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { class: 'small secondary', text: 'Retry' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  async function fetchSchemaModule(moduleName) {
    const schema = await client.request('/api/schema');
    if (schema?.generatedResourceContract !== SUPPORTED_ADMIN_CONTRACT) {
      throw Object.assign(new Error('This Admin needs an update to render generated modules.'), {
        code: 'UNSUPPORTED_CONTRACT',
      });
    }
    const meta = (schema.generatedModules ?? []).find((module) => module.name === moduleName);
    if (!meta) throw Object.assign(new Error(`Module not found: ${moduleName}`), { status: 404 });
    return meta;
  }

  // ---- List -------------------------------------------------------------

  async function renderList(moduleName) {
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    let records;
    try {
      meta = await fetchSchemaModule(moduleName);
      records = hasCapability(meta, 'list')
        ? (await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records?limit=${LIST_LIMIT}`)).items
        : [];
    } catch (error) {
      if (token !== renderToken) return;
      const failed = humanReadError(error, { failed: 'The list could not be loaded. Try again later.' });
      const needsUpdate = isUnsupportedContractFailure(error);
      showMessage(needsUpdate ? 'This module needs an update before it can list records.' : failed, {
        retry: needsUpdate ? undefined : () => renderList(moduleName),
      });
      return;
    }
    if (token !== renderToken) return;

    // Resolve reference labels for the columns, deduplicated per distinct
    // target id (never one request per cell), with a raw-id fallback.
    const columnFields = meta.fields.slice(0, 6);
    const referenceLabels = await resolveReferenceLabels(columnFields, records, token);
    if (token !== renderToken) return;
    clear();

    const panel = el(doc, 'section', { class: 'panel panel-wide' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Generated module' }));
    titleBox.appendChild(el(doc, 'h2', { text: humanizeLabel(meta.name) }));
    if (meta.description) titleBox.appendChild(el(doc, 'p', { class: 'lede', text: meta.description }));
    heading.appendChild(titleBox);
    if (hasCapability(meta, 'create')) {
      const create = el(doc, 'button', { class: 'primary', text: 'Create' });
      create.setAttribute('data-action', 'create');
      create.addEventListener('click', () => navigate(`#/modules/${meta.name}/new`));
      heading.appendChild(create);
    }
    panel.appendChild(heading);

    const columns = columnFields;
    if (!records.length) {
      panel.appendChild(el(doc, 'div', { class: 'empty', text: 'No records yet.' }));
    } else {
      const wrap = el(doc, 'div', { class: 'table-wrap' });
      const table = el(doc, 'table');
      const thead = el(doc, 'thead');
      const headRow = el(doc, 'tr');
      for (const field of columns) headRow.appendChild(el(doc, 'th', { text: humanizeLabel(field.name) }));
      headRow.appendChild(el(doc, 'th', { text: 'Created' }));
      headRow.appendChild(el(doc, 'th', { attrs: { 'aria-label': 'Open' } }));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el(doc, 'tbody');
      for (const record of records) {
        const row = el(doc, 'tr');
        for (const field of columns) {
          const value = record[field.name];
          const text = field.type === 'reference' && value != null
            ? referenceLabels.get(`${field.name}:${value}`) ?? String(value)
            : cellText(value);
          row.appendChild(el(doc, 'td', { text }));
        }
        row.appendChild(el(doc, 'td', { text: record.createdAt ? String(record.createdAt) : '—' }));
        const openCell = el(doc, 'td');
        if (hasCapability(meta, 'get')) {
          const open = el(doc, 'button', { class: 'small secondary', text: 'Open' });
          open.addEventListener('click', () => navigate(`#/modules/${meta.name}/${encodeURIComponent(record.id)}`));
          openCell.appendChild(open);
        }
        row.appendChild(openCell);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      panel.appendChild(wrap);
    }
    mount.appendChild(panel);
    return panel;
  }

  // ---- Create form ------------------------------------------------------

  /**
   * Voce 714433c2 + 96e7b579: the «Nuova offerta» creation screen. The
   * opportunity module is not an exposable generated module (no generic
   * create form exists for it), so this view renders the governed create
   * directly: the customer stashed by the scheda («Nuova offerta») is
   * taken once here — read and cleared — and filed as
   * companyId/contactId, while the operator types titolo, valore,
   * scadenza and referente. Without a stash the operator chooses the
   * cliente here, from the company and contact lists — never a typed id,
   * never an invented customer. Either way the operator may tick
   * prodotti dal catalogo: the ticked offers total into the Valore field.
   * Ids never reach the screen; the server stays authoritative and refuses
   * a stale pick (unknown company or a contact outside its company). On
   * success the board lists the new offer (`#/pipelines/accordo-sales`,
   * packages/pipelines/accordo-sales.js).
   */
  async function renderOpportunityNew() {
    const store = deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage);
    const pick = takePendingCustomerPick(store, 'offer');
    clear();
    const fixedCompanyId = pick !== null && pick.resource === 'company'
      ? pick.id
      : (pick?.company?.id ?? null);
    const fixedContactId = pick !== null && pick.resource === 'contact' ? pick.id : null;
    const companyName = pick !== null && pick.resource === 'company'
      ? pick.name
      : (pick?.company?.name ?? null);

    const panel = el(doc, 'section', { class: 'panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Offerta' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Nuova offerta' }));
    heading.appendChild(titleBox);
    const back = el(doc, 'button', { class: 'small secondary', text: 'Torna alle offerte' });
    back.addEventListener('click', () => navigate('#/pipelines/accordo-sales'));
    heading.appendChild(back);
    panel.appendChild(heading);

    // Without a stash the customer is chosen here, from the server lists.
    // A failed company read retries instead of offering an empty choice;
    // with no companies at all the screen says so instead of inventing one.
    /** @type {Array<Record<string, any>> | null} */
    let companies = null;
    if (fixedCompanyId === null) {
      try {
        companies = (await client.request('/api/companies?limit=100')).items ?? [];
      } catch (error) {
        panel.appendChild(el(doc, 'p', {
          class: 'empty',
          text: 'I clienti non si sono caricati. Riprova più tardi.',
        }));
        const retry = el(doc, 'button', { class: 'small secondary', text: 'Riprova' });
        retry.addEventListener('click', () => renderOpportunityNew());
        panel.appendChild(retry);
        mount.appendChild(panel);
        return panel;
      }
      if (companies.length === 0) {
        panel.appendChild(el(doc, 'p', {
          class: 'empty',
          text: 'Non c\u2019è ancora nessun cliente: crealo prima dalla sezione Clienti.',
        }));
        mount.appendChild(panel);
        return panel;
      }
    } else {
      panel.appendChild(el(doc, 'p', {
        class: 'lede',
        text: companyName !== null && fixedContactId !== null && pick !== null && pick.name !== companyName
          ? `Cliente: ${pick.name} · Azienda: ${companyName}`
          : `Azienda: ${companyName ?? pick?.name ?? ''}`,
      }));
    }

    // Prodotti dal catalogo: a failed read degrades to the manual value,
    // never to a blocked screen. A 404 (no commercial package composed)
    // is the ordinary no-catalog space, stated once as a hint.
    /** @type {any} */
    let catalog = null;
    let catalogNote = null;
    try {
      catalog = await client.request('/api/catalog/products?active=true');
    } catch (error) {
      catalogNote = error?.status === 404
        ? 'Nessun catalogo in questo spazio: scrivi il valore a mano.'
        : 'Il catalogo non si è caricato: scrivi il valore a mano.';
    }

    const form = el(doc, 'form', { class: 'record-form' });
    form.setAttribute('novalidate', 'novalidate');
    const generalError = el(doc, 'p', { class: 'form-error hidden', attrs: { role: 'alert' } });
    form.appendChild(generalError);

    /** @type {Record<string, any>} */
    const inputs = {};
    /** @type {Record<string, any>} */
    const fieldErrors = {};
    const addField = (name, label, { type = 'text', placeholder = '', required = false } = {}) => {
      const row = el(doc, 'div', { class: 'field-row' });
      const inputId = `field-opportunity-${name}`;
      const labelNode = el(doc, 'label', { text: label, attrs: { for: inputId } });
      if (required) labelNode.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      row.appendChild(labelNode);
      const input = el(doc, 'input', { attrs: { id: inputId, name, type, placeholder } });
      if (required) input.setAttribute('required', 'required');
      input.setAttribute('aria-describedby', `${inputId}-error`);
      row.appendChild(input);
      const errorNode = el(doc, 'small', { class: 'field-error hidden', attrs: { id: `${inputId}-error` } });
      row.appendChild(errorNode);
      form.appendChild(row);
      inputs[name] = input;
      fieldErrors[name] = errorNode;
    };
    addField('title', 'Titolo', { placeholder: 'es. Pacchetto 10 ingressi', required: true });
    addField('value', 'Valore EUR', { placeholder: 'es. 250.00', required: true });
    addField('expiry', 'Scadenza', { type: 'date' });
    addField('owner', 'Referente', { placeholder: 'Chi la segue', required: true });

    // Voce 96e7b579: the cliente pickers, only without a scheda stash.
    // Companies and contacts come from the server lists; the contact list
    // follows the chosen company, and the server re-checks the pair.
    /** @type {any} */
    let companySelect = null;
    /** @type {any} */
    let contactSelect = null;
    /** @type {any} */
    let contactHint = null;
    if (fixedCompanyId === null) {
      const customerRow = el(doc, 'div', { class: 'field-row' });
      const companyId = 'field-opportunity-company';
      customerRow.appendChild(el(doc, 'label', { text: 'Cliente (azienda)', attrs: { for: companyId } }));
      companySelect = el(doc, 'select', { attrs: { id: companyId, name: 'company' } });
      for (const company of companies) {
        if (company?.id === undefined || company?.id === null) continue;
        companySelect.appendChild(el(doc, 'option', {
          text: typeof company.name === 'string' && company.name !== '' ? company.name : String(company.id),
          attrs: { value: String(company.id) },
        }));
      }
      customerRow.appendChild(companySelect);
      const contactRow = el(doc, 'div', { class: 'field-row' });
      const contactId = 'field-opportunity-contact';
      contactRow.appendChild(el(doc, 'label', { text: 'Referente (facoltativo)', attrs: { for: contactId } }));
      contactSelect = el(doc, 'select', { attrs: { id: contactId, name: 'contact' } });
      contactSelect.appendChild(el(doc, 'option', { text: 'Nessun referente specifico', attrs: { value: '' } }));
      contactRow.appendChild(contactSelect);
      contactHint = el(doc, 'small', { class: 'field-error hidden' });
      contactRow.appendChild(contactHint);
      form.appendChild(customerRow);
      form.appendChild(contactRow);
      inputs.company = companySelect;
      inputs.contact = contactSelect;

      const reloadContacts = async () => {
        const chosen = String(companySelect.value ?? '');
        contactHint.textContent = '';
        contactHint.setAttribute('class', 'field-error hidden');
        while (contactSelect.firstChild) contactSelect.removeChild(contactSelect.firstChild);
        contactSelect.appendChild(el(doc, 'option', { text: 'Nessun referente specifico', attrs: { value: '' } }));
        if (chosen === '') return;
        let contacts = null;
        try {
          contacts = (await client.request(`/api/contacts?companyId=${encodeURIComponent(chosen)}&limit=100`)).items ?? [];
        } catch {
          contactHint.textContent = 'I referenti non si sono caricati: prosegui senza referente o riprova.';
          contactHint.setAttribute('class', 'field-error');
          return;
        }
        for (const contact of contacts) {
          if (contact?.id === undefined || contact?.id === null) continue;
          const label = [contact.firstName, contact.lastName].filter((part) => typeof part === 'string' && part !== '').join(' ')
            || contact.email || String(contact.id);
          contactSelect.appendChild(el(doc, 'option', { text: label, attrs: { value: String(contact.id) } }));
        }
      };
      companySelect.addEventListener('change', reloadContacts);
      await reloadContacts();
    }

    // Voce 96e7b579: prodotti dal catalogo. A ticked offer prices the
    // Valore field through «Usa il totale»: flat fees count once, per-unit
    // prices multiply by the row quantity. Only active offers in one
    // currency with plain flat/per-unit components are tickable; tiered or
    // multi-component offers paint their price as text — the operator
    // types the value by hand for those. The choice totals into Valore;
    // nothing is written until Crea offerta.
    /** @type {Array<Record<string, any>>} */
    const productPicks = [];
    /** @type {any} */
    let totalLine = null;
    if (catalog !== null) {
      const products = Array.isArray(catalog.products) ? catalog.products : [];
      const section = el(doc, 'div', { class: 'catalog-picks' });
      section.appendChild(el(doc, 'h3', { text: 'Prodotti dal catalogo (facoltativo)' }));
      let tickable = 0;
      for (const product of products) {
        const offers = Array.isArray(product?.offers) ? product.offers : [];
        for (const offer of offers) {
          if (!isPricedOffer(offer)) {
            if (offer?.active === true) {
              section.appendChild(el(doc, 'p', {
                class: 'hint',
                text: `${product?.name ?? 'Prodotto'} · ${offer?.name ?? 'offerta'}: prezzo a scaglioni — scrivi il valore a mano.`,
              }));
            }
            continue;
          }
          tickable += 1;
          const row = el(doc, 'div', { class: 'catalog-pick' });
          const checkbox = el(doc, 'input', { attrs: { type: 'checkbox', name: `product-${offer.offerId}` } });
          checkbox.setAttribute('aria-label', `Aggiungi ${offer.name}`);
          row.appendChild(checkbox);
          const needsQty = offer.components.some((component) => component.pricingModel === 'per_unit');
          /** @type {any} */
          let qtyInput = null;
          if (needsQty) {
            qtyInput = el(doc, 'input', { attrs: { type: 'number', name: `qty-${offer.offerId}`, value: '1' } });
            qtyInput.setAttribute('aria-label', `Quantità per ${offer.name}`);
          }
          row.appendChild(el(doc, 'span', {
            text: `${product?.name ?? 'Prodotto'} · ${offer.name} — ${offerPriceText(offer)}${needsQty ? ' × ' : ''}`,
          }));
          if (qtyInput !== null) row.appendChild(qtyInput);
          section.appendChild(row);
          productPicks.push({ offer, checkbox, qtyInput });
        }
      }
      if (tickable === 0) {
        section.appendChild(el(doc, 'p', {
          class: 'hint',
          text: 'Nessun prezzo semplice nel catalogo: scrivi il valore a mano.',
        }));
      } else {
        totalLine = el(doc, 'p', { class: 'catalog-total', text: 'Totale prodotti: nessun prodotto scelto.' });
        section.appendChild(totalLine);
        const useTotal = el(doc, 'button', {
          class: 'small secondary', text: 'Usa il totale', attrs: { type: 'button', 'data-action': 'use-product-total' },
        });
        const refreshTotal = () => {
          const total = selectedProductTotal(productPicks);
          if (total === null) {
            totalLine.textContent = 'Totale prodotti: nessun prodotto scelto.';
          } else if (total.error === 'mixed') {
            totalLine.textContent = 'I prodotti scelti hanno valute diverse: scegline in un\u2019unica valuta.';
          } else if (total.error === 'qty') {
            totalLine.textContent = 'Una quantit\u00e0 non \u00e8 valida: scrivi un intero da 1 in su.';
          } else {
            totalLine.textContent = `Totale prodotti: ${formatAmount(total.total, total.currency)}`;
          }
        };
        for (const pickRow of productPicks) {
          pickRow.checkbox.addEventListener('change', refreshTotal);
          if (pickRow.qtyInput !== null) pickRow.qtyInput.addEventListener('input', refreshTotal);
        }
        useTotal.addEventListener('click', () => {
          const total = selectedProductTotal(productPicks);
          if (total === null || total.error !== undefined) {
            refreshTotal();
            return;
          }
          inputs.value.value = (total.total / 100).toFixed(2);
          refreshTotal();
        });
        section.appendChild(useTotal);
        form.__useTotal = () => useTotal.dispatch('click');
      }
      form.appendChild(section);
      form.__productPicks = productPicks;
    } else if (catalogNote !== null) {
      form.appendChild(el(doc, 'p', { class: 'hint', text: catalogNote }));
    }

    const submit = el(doc, 'button', { class: 'primary', text: 'Crea offerta', attrs: { type: 'submit' } });
    form.appendChild(submit);
    panel.appendChild(form);

    let inFlight = false;
    function setBusy(busy) {
      inFlight = busy;
      submit.disabled = busy;
      submit.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function clearErrors() {
      generalError.textContent = '';
      generalError.setAttribute('class', 'form-error hidden');
      for (const node of Object.values(fieldErrors)) {
        node.textContent = '';
        node.setAttribute('class', 'field-error hidden');
      }
    }
    function showErrors(fieldMap = {}, general) {
      clearErrors();
      if (general) {
        generalError.textContent = general;
        generalError.setAttribute('class', 'form-error');
      }
      for (const [name, message] of Object.entries(fieldMap)) {
        if (fieldErrors[name]) {
          fieldErrors[name].textContent = message;
          fieldErrors[name].setAttribute('class', 'field-error');
        } else if (!general) {
          generalError.textContent = message;
          generalError.setAttribute('class', 'form-error');
        }
      }
    }
    /** Euro text to integer cents, or null when not a plain non-negative amount. */
    function parseEuroToCents(raw) {
      const text = String(raw ?? '').trim().replace(',', '.');
      if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
      const cents = Math.round(Number(text) * 100);
      return Number.isSafeInteger(cents) ? cents : null;
    }

    async function handleSubmit(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (inFlight) return;
      clearErrors();
      const companyId = fixedCompanyId ?? String(companySelect?.value ?? '');
      if (companyId === '') {
        showErrors({}, 'Scegli il cliente: senza azienda l\u2019offerta non si pu\u00f2 creare.');
        return;
      }
      const contactId = fixedContactId
        ?? (contactSelect !== null && String(contactSelect.value ?? '') !== '' ? String(contactSelect.value) : null);
      // The products price the value but never dictate it silently: the
      // currency follows a single-currency selection, a mixed selection
      // refuses, and a hand-typed value keeps EUR unless products say so.
      const chosenOffers = productPicks.filter((pickRow) => pickRow.checkbox.checked);
      const chosenCurrencies = new Set(chosenOffers.map((pickRow) => String(pickRow.offer.currency ?? '').toUpperCase()));
      if (chosenCurrencies.size > 1) {
        showErrors({}, 'I prodotti scelti hanno valute diverse: scegline in un\u2019unica valuta.');
        return;
      }
      const title = String(inputs.title.value ?? '').trim();
      const owner = String(inputs.owner.value ?? '').trim();
      const cents = parseEuroToCents(inputs.value.value);
      const expiry = String(inputs.expiry.value ?? '').trim();
      /** @type {Record<string, string>} */
      const failures = {};
      if (title === '') failures.title = 'Il titolo è obbligatorio.';
      if (cents === null) failures.value = 'Il valore è obbligatorio, in euro (es. 250.00).';
      if (owner === '') failures.owner = 'Il referente è obbligatorio.';
      if (expiry !== '' && Number.isNaN(Date.parse(expiry))) failures.expiry = 'La scadenza non è una data valida.';
      if (Object.keys(failures).length > 0) {
        showErrors(failures);
        return;
      }
      setBusy(true);
      try {
        const created = await client.request('/api/opportunities', {
          method: 'POST',
          body: JSON.stringify({
            companyId,
            ...(contactId !== null ? { contactId } : {}),
            name: title,
            valueCents: cents,
            currency: chosenCurrencies.size === 1 ? [...chosenCurrencies][0] : 'EUR',
            ...(expiry !== '' ? { expectedCloseDate: expiry } : {}),
            owner,
          }),
        });
        toast('Offerta creata');
        navigate('#/pipelines/accordo-sales');
        return created;
      } catch (error) {
        setBusy(false);
        showErrors({}, humanReadError(error, { failed: 'Offerta non creata. Riprova più tardi.' }));
        return null;
      }
    }
    form.addEventListener('submit', handleSubmit);
    form.__submit = handleSubmit;
    form.__inputs = inputs;

    mount.appendChild(panel);
    return form;
  }

  async function renderNew(moduleName) {
    if (moduleName === 'opportunity') return renderOpportunityNew();
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    try {
      meta = await fetchSchemaModule(moduleName);
    } catch (error) {
      if (token !== renderToken) return;
      const failed = humanReadError(error, { failed: 'The form could not be loaded. Try again later.' });
      const needsUpdate = isUnsupportedContractFailure(error);
      showMessage(needsUpdate ? 'This module needs an update before it can show the form.' : failed, {
        retry: needsUpdate ? undefined : () => renderNew(moduleName),
      });
      return;
    }
    if (token !== renderToken) return;
    if (!hasCapability(meta, 'create')) {
      showMessage('This module cannot create records.');
      return;
    }
    const fields = editableFields(meta);
    const form = buildForm(meta, fields, {}, async (raw, setBusy, showErrors) => {
      const { payload, errors } = buildCreatePayload(fields, raw);
      if (Object.keys(errors).length) return showErrors(errors);
      setBusy(true);
      try {
        const created = await submissions.submit({
          path: `/api/modules/${encodeURIComponent(moduleName)}/records`,
          method: 'POST',
          body: payload,
          key: form.__submissionKey ?? (form.__submissionKey = submissions.issueKey()),
        });
        form.__submissionKey = undefined;
        toast(`${humanizeLabel(meta.name)} created.`);
        navigate(`#/modules/${meta.name}/${encodeURIComponent(created.id)}`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Create', token });
    clear();
    mount.appendChild(form);
    await form.__populateReferences(token);
    return form;
  }

  // ---- Detail / edit ----------------------------------------------------

  async function renderDetail(moduleName, id) {
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    let record;
    try {
      meta = await fetchSchemaModule(moduleName);
      record = await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records/${encodeURIComponent(id)}`);
    } catch (error) {
      if (token !== renderToken) return;
      const failed = humanReadError(error, { failed: 'The record could not be loaded. Try again later.' });
      const notFound = isNotComposedFailure(error);
      const needsUpdate = isUnsupportedContractFailure(error);
      if (needsUpdate) {
        showMessage('This module needs an update before it can show this record.');
        return;
      }
      showMessage(notFound ? 'Record not found.' : failed, {
        retry: notFound ? undefined : () => renderDetail(moduleName, id),
      });
      return;
    }
    if (token !== renderToken) return;
    const fields = editableFields(meta);
    const canUpdate = hasCapability(meta, 'update');
    const form = buildForm(meta, fields, record, async (raw, setBusy, showErrors) => {
      const { payload, errors } = buildUpdatePayload(meta.fields, raw, record);
      if (Object.keys(errors).length) return showErrors(errors);
      if (Object.keys(payload).length === 0) {
        toast('Nothing to update.');
        return;
      }
      setBusy(true);
      try {
        record = await submissions.submit({
          path: `/api/modules/${encodeURIComponent(moduleName)}/records/${encodeURIComponent(id)}`,
          method: 'PATCH',
          body: payload,
          key: form.__submissionKey ?? (form.__submissionKey = submissions.issueKey()),
        });
        form.__submissionKey = undefined;
        setBusy(false);
        toast(`${humanizeLabel(meta.name)} saved.`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Save', readOnly: !canUpdate, immutable: record, title: displayTitle(record, meta.fields), token });
    clear();
    mount.appendChild(form);
    const actionsPanel = buildActionsPanel(meta, record, id, token);
    if (actionsPanel) mount.appendChild(actionsPanel);
    await form.__populateReferences(token);
    return form;
  }

  /**
   * Whether an action is offered for a record, from the action's declared
   * `fromStates` against the record's state field. An action with no
   * `fromStates` (null) is always available.
   *
   * @param {{fromStates?: string[] | null, stateField?: string}} action @param {Record<string, any>} record
   */
  function actionApplies(action, record) {
    if (!Array.isArray(action.fromStates)) return true;
    const stateField = typeof action.stateField === 'string' ? action.stateField : 'status';
    return action.fromStates.includes(record[stateField]);
  }

  /**
   * Generic action controls for a record detail (ADR-011), built purely from
   * `meta.actions` — no per-module code. A read-only summary shows the current
   * value of every workflow-managed field (e.g. status), then one button per
   * action valid for the record's current state. Actions with input reveal a
   * small form built from the action's input schema; actions without input run
   * on click. On success the detail is re-rendered so state and buttons update.
   *
   * @param {any} meta @param {Record<string, any>} record @param {string} id @param {number} token
   */
  function buildActionsPanel(meta, record, id, token) {
    const managed = managedFields(meta);
    const actions = Array.isArray(meta.actions) ? meta.actions : [];
    if (!managed.length && !actions.length) return null;

    const panel = el(doc, 'section', { class: 'panel actions-panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Lifecycle' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Actions' }));
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    if (managed.length) {
      const dl = el(doc, 'dl', { class: 'managed' });
      for (const field of managed) {
        dl.appendChild(el(doc, 'dt', { text: humanizeLabel(field.name) }));
        const value = record[field.name];
        dl.appendChild(el(doc, 'dd', {
          text: value === null || value === undefined || value === '' ? '—' : String(value),
          attrs: { 'data-managed-field': field.name },
        }));
      }
      panel.appendChild(dl);
    }

    const panelError = el(doc, 'p', { class: 'form-error hidden', attrs: { role: 'alert' } });
    panel.appendChild(panelError);

    const applicable = actions.filter((action) => actionApplies(action, record));
    if (!applicable.length) {
      panel.appendChild(el(doc, 'p', { class: 'empty', text: 'No actions available for this record.' }));
    } else {
      for (const action of applicable) {
        panel.appendChild(buildActionRow(meta, action, id, panelError));
      }
    }
    // Test/programmatic hooks.
    panel.__actions = applicable.map((action) => action.name);
    panel.__runAction = (name, values) => {
      const action = applicable.find((candidate) => candidate.name === name);
      if (!action) throw new Error(`action not applicable: ${name}`);
      return submitAction(meta, action, id, values ?? {}, () => {}, panelError);
    };
    return panel;
  }

  /**
   * One action's controls: a trigger button, plus (for actions with input) an
   * inline form revealed on click. Double-submit guarded; input errors and the
   * general error render as text.
   *
   * @param {any} meta @param {any} action @param {string} id @param {any} panelError
   */
  function buildActionRow(meta, action, id, panelError) {
    const row = el(doc, 'div', { class: 'action-row', attrs: { 'data-action': action.name } });
    const trigger = el(doc, 'button', {
      class: 'primary action-trigger',
      text: action.label ?? action.name,
      attrs: { type: 'button', 'data-action-trigger': action.name },
    });
    row.appendChild(trigger);
    if (action.description) row.appendChild(el(doc, 'small', { class: 'hint', text: action.description }));

    const inputs = Array.isArray(action.input) ? action.input : [];
    let busy = false;
    const setBusy = (value) => {
      busy = value;
      trigger.disabled = value;
      trigger.setAttribute('aria-busy', value ? 'true' : 'false');
    };

    if (!inputs.length) {
      trigger.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        await submitAction(meta, action, id, {}, setBusy, panelError);
      });
      return row;
    }

    // Actions with input: reveal a small form on click.
    const form = el(doc, 'form', { class: 'action-form hidden' });
    form.setAttribute('novalidate', 'novalidate');
    /** @type {Record<string, any>} */
    const fieldInputs = {};
    /** @type {Record<string, any>} */
    const fieldErrors = {};
    for (const field of inputs) {
      const fieldRow = el(doc, 'div', { class: 'field-row' });
      const inputId = `action-${meta.name}-${action.name}-${field.name}`;
      const label = el(doc, 'label', { text: humanizeLabel(field.name), attrs: { for: inputId } });
      if (field.required) label.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      fieldRow.appendChild(label);
      let input;
      if (field.type === 'enum') {
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: field.required ? 'Select…' : '(none)', attrs: { value: '' } }));
        for (const value of Array.isArray(field.values) ? field.values : []) {
          input.appendChild(el(doc, 'option', { text: value, attrs: { value } }));
        }
      } else if (field.type === 'integer') {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'number', step: '1' } });
      } else {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'text' } });
        if (field.type === 'timestamp') input.setAttribute('placeholder', 'YYYY-MM-DDTHH:MM:SSZ');
      }
      if (field.required) input.setAttribute('required', 'required');
      const errorNode = el(doc, 'small', { class: 'field-error hidden', attrs: { id: `${inputId}-error` } });
      input.setAttribute('aria-describedby', `${inputId}-error`);
      fieldRow.appendChild(input);
      // Declared hint first (action metadata, rendered as text), then the
      // built-in timestamp format hint.
      if (typeof field.hint === 'string' && field.hint) {
        fieldRow.appendChild(el(doc, 'small', { class: 'hint', text: field.hint }));
      }
      if (field.type === 'timestamp') {
        fieldRow.appendChild(el(doc, 'small', { class: 'hint', text: 'ISO-8601 UTC, e.g. 2026-08-10T09:00:00Z' }));
      }
      fieldRow.appendChild(errorNode);
      form.appendChild(fieldRow);
      fieldInputs[field.name] = input;
      fieldErrors[field.name] = errorNode;
    }
    const runButton = el(doc, 'button', { class: 'primary', text: 'Run', attrs: { type: 'submit' } });
    form.appendChild(runButton);
    row.appendChild(form);

    const clearFieldErrors = () => {
      for (const node of Object.values(fieldErrors)) {
        node.textContent = '';
        node.setAttribute('class', 'field-error hidden');
      }
    };
    const showFieldErrors = (fields = {}) => {
      clearFieldErrors();
      for (const [name, message] of Object.entries(fields)) {
        if (fieldErrors[name]) {
          fieldErrors[name].textContent = message;
          fieldErrors[name].setAttribute('class', 'field-error');
        }
      }
    };

    trigger.addEventListener('click', () => {
      const hidden = form.getAttribute('class').includes('hidden');
      form.setAttribute('class', hidden ? 'action-form' : 'action-form hidden');
    });

    async function handleRun(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (busy) return;
      clearFieldErrors();
      /** @type {Record<string, unknown>} */
      const values = {};
      /** @type {Record<string, string>} */
      const clientErrors = {};
      for (const field of inputs) {
        const raw = fieldInputs[field.name].value;
        const text = raw === undefined || raw === null ? '' : String(raw).trim();
        if (text === '') {
          if (field.required) clientErrors[field.name] = `${humanizeLabel(field.name)} is required`;
          continue;
        }
        if (field.type === 'integer') {
          // The server accepts JSON integers only, so parse here; a fast
          // client-side message beats a round trip (server stays authoritative).
          if (!/^-?\d+$/.test(text)) {
            clientErrors[field.name] = `${humanizeLabel(field.name)} must be a whole number`;
            continue;
          }
          values[field.name] = Number(text);
          continue;
        }
        values[field.name] = text;
      }
      if (Object.keys(clientErrors).length) return showFieldErrors(clientErrors);
      setBusy(true);
      await submitAction(meta, action, id, values, setBusy, panelError, showFieldErrors);
    }
    form.addEventListener('submit', handleRun);
    form.__run = handleRun;
    form.__inputs = fieldInputs;
    return row;
  }

  /**
   * POST an action to the server and, on success, re-render the detail so the
   * new state and available actions are reflected. On failure, restore the
   * button and surface field/general errors as text.
   *
   * @param {any} meta @param {any} action @param {string} id
   * @param {Record<string, unknown>} values @param {(busy: boolean) => void} setBusy
   * @param {any} panelError @param {(fields: Record<string, string>) => void} [showFieldErrors]
   */
  async function submitAction(meta, action, id, values, setBusy, panelError, showFieldErrors) {
    panelError.textContent = '';
    panelError.setAttribute('class', 'form-error hidden');
    try {
      await submissions.submit({
        path: `/api/modules/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(action.name)}`,
        method: 'POST',
        body: values,
      });
      toast(`${action.label ?? action.name} done.`);
      await renderDetail(meta.name, id);
    } catch (error) {
      setBusy(false);
      const mapped = apiErrorToFormErrors(error);
      if (showFieldErrors && mapped.fields && Object.keys(mapped.fields).length) showFieldErrors(mapped.fields);
      panelError.textContent = mapped.general;
      panelError.setAttribute('class', 'form-error');
    }
  }

  /**
   * Build a form node from field descriptors. `onSubmit(raw, setBusy, showErrors)`.
   */
  function buildForm(meta, fields, initial, onSubmit, options = {}) {
    const panel = el(doc, 'section', { class: 'panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: humanizeLabel(meta.name) }));
    titleBox.appendChild(el(doc, 'h2', { text: options.title ?? `New ${humanizeLabel(meta.name).toLowerCase()}` }));
    heading.appendChild(titleBox);
    const back = el(doc, 'button', { class: 'small secondary', text: 'Back to list' });
    back.addEventListener('click', () => navigate(`#/modules/${meta.name}`));
    heading.appendChild(back);
    panel.appendChild(heading);

    const form = el(doc, 'form', { class: 'record-form' });
    form.setAttribute('novalidate', 'novalidate');
    const generalError = el(doc, 'p', { class: 'form-error hidden', attrs: { role: 'alert' } });
    form.appendChild(generalError);

    /** @type {Record<string, any>} */
    const inputs = {};
    /** @type {Record<string, any>} */
    const fieldErrors = {};
    /** @type {Array<{input: any, control: any, currentValue: string, hint: any}>} */
    const referencePopulations = [];

    for (const field of fields) {
      const control = fieldControl(field);
      const row = el(doc, 'div', { class: 'field-row' });
      const inputId = `field-${meta.name}-${field.name}`;
      const label = el(doc, 'label', { text: control.label, attrs: { for: inputId } });
      if (control.required) label.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      row.appendChild(label);

      let input;
      let referenceHint = null;
      if (control.control === 'reference') {
        // Empty select now; options are loaded asynchronously (guarded by the
        // render token) from the target module, with the current value ensured.
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: control.required ? 'Select…' : 'None', attrs: { value: '' } }));
        // Honest truncation notice, revealed only if the target list is capped.
        referenceHint = el(doc, 'small', { class: 'hint hidden', text: 'Showing the first 100; searchable selection is a later milestone.' });
        const currentValue = initial[field.name] != null ? String(initial[field.name]) : '';
        referencePopulations.push({ input, control, currentValue, hint: referenceHint });
      } else if (control.control === 'select') {
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: control.required ? 'Select…' : '(none)', attrs: { value: '' } }));
        for (const option of control.options) {
          input.appendChild(el(doc, 'option', { text: option, attrs: { value: option } }));
        }
        if (initial[field.name] != null) input.value = String(initial[field.name]);
      } else if (control.control === 'checkbox') {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'checkbox' } });
        if (initial[field.name] === true) input.setAttribute('checked', 'checked');
        input.checked = initial[field.name] === true;
      } else {
        const type = control.control === 'number' ? 'number' : control.control === 'email' ? 'email' : 'text';
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type } });
        if (control.control === 'number') input.setAttribute('step', '1');
        if (initial[field.name] != null) input.value = String(initial[field.name]);
      }
      if (control.required) input.setAttribute('required', 'required');
      if (control.unique) row.appendChild(el(doc, 'small', { class: 'hint', text: 'Must be unique' }));
      const errorNode = el(doc, 'small', { class: 'field-error hidden', attrs: { id: `${inputId}-error` } });
      input.setAttribute('aria-describedby', `${inputId}-error`);
      row.appendChild(input);
      if (referenceHint) row.appendChild(referenceHint);
      row.appendChild(errorNode);
      form.appendChild(row);
      inputs[field.name] = input;
      fieldErrors[field.name] = errorNode;
    }

    if (options.immutable) {
      const meta2 = el(doc, 'dl', { class: 'immutable' });
      for (const key of ['id', 'createdAt', 'updatedAt']) {
        if (options.immutable[key] === undefined) continue;
        meta2.appendChild(el(doc, 'dt', { text: humanizeLabel(key) }));
        meta2.appendChild(el(doc, 'dd', { text: String(options.immutable[key]) }));
      }
      form.appendChild(meta2);
    }

    const submit = el(doc, 'button', { class: 'primary', text: options.submitLabel ?? 'Save', attrs: { type: 'submit' } });
    if (options.readOnly) {
      submit.setAttribute('disabled', 'disabled');
      submit.disabled = true;
      form.appendChild(el(doc, 'p', { class: 'empty', text: 'This module is read-only.' }));
    }
    form.appendChild(submit);

    let inFlight = false;
    function setBusy(busy) {
      inFlight = busy;
      submit.disabled = busy || options.readOnly === true;
      submit.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function clearErrors() {
      generalError.textContent = '';
      generalError.setAttribute('class', 'form-error hidden');
      for (const node of Object.values(fieldErrors)) {
        node.textContent = '';
        node.setAttribute('class', 'field-error hidden');
      }
    }
    function showErrors(fieldMap = {}, general) {
      clearErrors();
      if (general) {
        generalError.textContent = general;
        generalError.setAttribute('class', 'form-error');
      }
      for (const [name, message] of Object.entries(fieldMap)) {
        if (fieldErrors[name]) {
          fieldErrors[name].textContent = message;
          fieldErrors[name].setAttribute('class', 'field-error');
        } else if (!general) {
          generalError.textContent = message;
          generalError.setAttribute('class', 'form-error');
        }
      }
    }

    function readRaw() {
      /** @type {Record<string, unknown>} */
      const raw = {};
      for (const [name, input] of Object.entries(inputs)) {
        raw[name] = input.getAttribute && input.getAttribute('type') === 'checkbox' ? input.checked === true : input.value;
      }
      return raw;
    }

    async function handleSubmit(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (options.readOnly) return;
      if (inFlight && form.__pending) return form.__pending;
      clearErrors();
      form.__pending = onSubmit(readRaw(), setBusy, showErrors);
      try {
        await form.__pending;
      } finally {
        form.__pending = null;
      }
    }
    form.addEventListener('submit', handleSubmit);
    // Expose for tests / programmatic submit without a real submit event.
    form.__submit = handleSubmit;
    form.__inputs = inputs;
    form.__populateReferences = (token) =>
      Promise.all(referencePopulations.map((ref) => populateReference(ref, token, options.token)));

    return form;
  }

  /**
   * Build an id→label map for reference columns, fetching each target module's
   * list once and resolving only the ids present, deduplicated. Missing ids get
   * a single by-id fetch; anything unresolved falls back to the raw id.
   *
   * @param {Array<any>} columnFields @param {Array<any>} records @param {number} token
   * @returns {Promise<Map<string, string>>}
   */
  async function resolveReferenceLabels(columnFields, records, token) {
    const labels = new Map();
    const referenceCols = columnFields.filter((field) => field.type === 'reference' && field.targetModule);
    for (const field of referenceCols) {
      const ids = new Set();
      for (const record of records) {
        const value = record[field.name];
        if (value != null && value !== '') ids.add(String(value));
      }
      if (ids.size === 0) continue;
      let items = [];
      try {
        // One list call per reference column resolves every id on the first page.
        const response = await client.request(`/api/modules/${encodeURIComponent(field.targetModule)}/records?limit=${REFERENCE_OPTION_LIMIT}`);
        items = Array.isArray(response.items) ? response.items : [];
      } catch {
        items = [];
      }
      if (token !== renderToken) return labels;
      const displayField = typeof field.targetDisplayField === 'string' ? field.targetDisplayField : 'id';
      for (const record of items) {
        const id = record && record.id != null ? String(record.id) : '';
        if (!ids.has(id)) continue;
        const labelValue = record[displayField];
        labels.set(`${field.name}:${id}`, labelValue == null || labelValue === '' ? id : String(labelValue));
      }
      // Ids not on the first page: one targeted fetch each, up to a bounded
      // budget so a page pointing at many off-page targets cannot fan out
      // without limit; beyond the budget the raw id is shown.
      let budget = REFERENCE_LABEL_FETCH_BUDGET;
      for (const id of ids) {
        if (labels.has(`${field.name}:${id}`)) continue;
        if (budget <= 0) {
          labels.set(`${field.name}:${id}`, id);
          continue;
        }
        budget -= 1;
        try {
          const record = await client.request(
            `/api/modules/${encodeURIComponent(field.targetModule)}/records/${encodeURIComponent(id)}`,
          );
          if (token !== renderToken) return labels;
          const labelValue = record[displayField];
          labels.set(`${field.name}:${id}`, labelValue == null || labelValue === '' ? id : String(labelValue));
        } catch {
          labels.set(`${field.name}:${id}`, id);
        }
      }
    }
    return labels;
  }

  /**
   * Load target options for one reference select, ensuring the current value is
   * always present even if it is not on the first page. Guarded by the render
   * token so a stale form's options never land in a newer view.
   *
   * @param {{input: any, control: any, currentValue: string}} ref
   * @param {number} token
   */
  async function populateReference(ref, token) {
    const { input, control, currentValue, hint } = ref;
    if (!control.targetModule) return; // malformed metadata: leave placeholder only
    let items = [];
    try {
      const response = await client.request(`/api/modules/${encodeURIComponent(control.targetModule)}/records?limit=${REFERENCE_OPTION_LIMIT}`);
      items = Array.isArray(response.items) ? response.items : [];
    } catch {
      // Target list unavailable: keep the placeholder; the raw id (if any) is
      // still ensured below so the current value is never silently lost.
      items = [];
    }
    if (token !== renderToken) return; // a newer render owns the view now
    // Honest notice: if the target list is capped, the selection is truncated.
    if (hint && items.length >= REFERENCE_OPTION_LIMIT) hint.setAttribute('class', 'hint');
    const seen = new Set();
    const addOption = (record) => {
      const id = record && record.id != null ? String(record.id) : '';
      if (id === '' || seen.has(id)) return;
      seen.add(id);
      const labelValue = record[control.targetDisplayField];
      const label = labelValue == null || labelValue === '' ? id : String(labelValue);
      input.appendChild(el(doc, 'option', { text: label, attrs: { value: id } })); // safe: textContent
    };
    for (const record of items) addOption(record);
    // Ensure the current value is selectable even if it is not on the first page.
    if (currentValue && !seen.has(currentValue)) {
      try {
        const record = await client.request(
          `/api/modules/${encodeURIComponent(control.targetModule)}/records/${encodeURIComponent(currentValue)}`,
        );
        if (token !== renderToken) return;
        addOption(record);
      } catch {
        if (token !== renderToken) return;
        addOption({ id: currentValue }); // fall back to the raw id, never lose it
      }
    }
    if (currentValue) input.value = currentValue;
  }

  return { renderList, renderNew, renderDetail };
}

/** @param {unknown} value */
function cellText(value) {
  if (value === null || value === undefined) return '—';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return String(value);
}
