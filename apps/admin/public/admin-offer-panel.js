// «Nuova offerta» from the scheda cliente, in a window over the page
// (Dan 06/11): the offer is written where the customer is, like «Scrivi».
// The same frame as the composer — a dark head with the purpose and the
// customer, minimize and close — with an AI row that fills the fields from
// one sentence, the four commercial facts, and the catalog as chips whose
// total prices the offer until the person types a value by hand.
//
// Writes go through the view's bound client (bindAdminMutations), with one
// submission key per window: a double click, a retry after an uncertain
// failure or Enter+click file one offer, never two. The server stays
// authoritative on the customer pair and refuses a stale pick.
//
// The AI row calls `POST /api/customer-hub/offers/draft`
// { spaceId, resource, id, prompt } and expects
// { title?, valueCents?, currency?, expectedCloseDate?, catalogOfferIds? }.
// It never creates anything: Crea offerta stays the person's click. Without
// the route, a space without AI or without a key, the row turns into one
// honest line and the fields stay for writing by hand.

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { formatAmount, humanReadError, isNotComposedFailure } from './admin-core.js';
import { isPricedOffer, offerPriceText, selectedProductTotal } from './admin-modules.js';

export const OFFER_PROMPT_MAX = 500;
export const OFFER_DRAFT_PATH = '/api/customer-hub/offers/draft';

/** Euro text («250», «250,5», «1.250,00» is refused) to integer cents, or null. */
export function euroToCents(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Integer cents to the field's text («350.00»). */
function centsToField(cents) {
  return (cents / 100).toFixed(2);
}

/** A YYYY-MM-DD day from an ISO date or day, or '' when there is none. */
function dayOf(raw) {
  const text = String(raw ?? '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : '';
}

/**
 * Opens (or brings back) the offer window over the scheda.
 *
 * @param {{
 *   doc: any, host: any, client: any, issueKey: () => string,
 *   card: any, navCtx: {resource: string, id: string},
 *   company: {id: string, name: string} | null,
 *   spaceId: string | null, toast?: (text: string) => void,
 *   onCreated?: (created: any) => void,
 * }} deps
 */
export function openOfferPanel(deps) {
  const { doc, host, client, card, navCtx, company } = deps;
  const toast = typeof deps.toast === 'function' ? deps.toast : () => {};
  const el = elFor(doc);
  const old = host.querySelector('div[data-offer-panel="open"]');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const panel = el('div', 'bo-scheda-composer bo-offer-panel');
  panel.setAttribute('data-offer-panel', 'open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Nuova offerta');
  host.appendChild(panel);
  const gone = () => panel.parentNode == null;

  const head = el('div', 'bo-composer-head');
  const customer = typeof card?.name === 'string' ? card.name.trim() : '';
  const title = el('h4', 'bo-composer-title', 'Nuova offerta');
  if (customer !== '') title.appendChild(el('span', 'bo-composer-to-name', ` · ${customer}`));
  head.appendChild(title);
  const minimize = el('button', 'bo-composer-icon', '–');
  minimize.setAttribute('type', 'button');
  minimize.setAttribute('aria-label', 'Riduci');
  minimize.setAttribute('data-action', 'offer-minimize');
  minimize.addEventListener('click', () => {
    if (panel.getAttribute('data-minimized') === 'true') panel.removeAttribute('data-minimized');
    else panel.setAttribute('data-minimized', 'true');
  });
  const close = el('button', 'bo-composer-icon', '✕');
  close.setAttribute('type', 'button');
  close.setAttribute('aria-label', 'Chiudi');
  close.setAttribute('data-action', 'offer-close');
  const shut = () => { if (panel.parentNode) panel.parentNode.removeChild(panel); };
  close.addEventListener('click', shut);
  panel.addEventListener('keydown', (event) => {
    if (event?.key === 'Escape') shut();
  });
  head.appendChild(minimize);
  head.appendChild(close);
  panel.appendChild(head);

  const body = el('div', 'bo-composer-body bo-offer-body');
  panel.appendChild(body);

  // The offer files under a company: without one the window says so and
  // offers no form that the server would refuse.
  if (company === null) {
    body.appendChild(el('p', 'bo-offer-blocked',
      'Per creare un’offerta il cliente deve avere un’azienda: aggiungila in Dettagli, poi riprova.'));
    return panel;
  }

  // ---- AI row --------------------------------------------------------
  const ai = el('div', 'bo-composer-ai');
  const aiField = el('div', 'bo-composer-ai-field');
  const mark = el('span', 'bo-composer-ai-mark', '✦');
  mark.setAttribute('aria-hidden', 'true');
  const prompt = el('input', 'bo-composer-ai-input');
  prompt.setAttribute('type', 'text');
  prompt.setAttribute('aria-label', 'Descrivi l’offerta all’AI');
  prompt.setAttribute('placeholder', 'Descrivi l’offerta: «10 lezioni PT a 350 €, valida fino a fine mese»');
  prompt.setAttribute('maxlength', String(OFFER_PROMPT_MAX));
  const go = el('button', 'bo-composer-ai-go', 'Compila');
  go.setAttribute('type', 'button');
  go.setAttribute('data-action', 'offer-ai-fill');
  aiField.appendChild(mark);
  aiField.appendChild(prompt);
  aiField.appendChild(go);
  ai.appendChild(aiField);
  const aiLine = el('p', 'bo-composer-ai-line', '');
  aiLine.setAttribute('aria-live', 'polite');
  ai.appendChild(aiLine);
  if (deps.spaceId !== null) body.appendChild(ai);

  // ---- Fields --------------------------------------------------------
  const generalError = el('p', 'field-error', '');
  generalError.setAttribute('role', 'alert');
  const fields = el('div', 'bo-offer-fields');
  /** @type {Record<string, any>} */
  const inputs = {};
  /** @type {Record<string, any>} */
  const errors = {};
  const field = (name, label, { type = 'text', placeholder = '', wide = false, inputmode = null } = {}) => {
    const wrap = el('label', `bo-offer-field${wide ? ' bo-offer-field-wide' : ''}`);
    wrap.appendChild(el('span', 'bo-offer-label', label));
    const input = el('input', 'bo-offer-input');
    input.setAttribute('type', type);
    input.setAttribute('name', `offer-${name}`);
    if (placeholder) input.setAttribute('placeholder', placeholder);
    if (inputmode) input.setAttribute('inputmode', inputmode);
    wrap.appendChild(input);
    const error = el('small', 'field-error', '');
    wrap.appendChild(error);
    fields.appendChild(wrap);
    inputs[name] = input;
    errors[name] = error;
    return input;
  };
  field('title', 'Titolo', { placeholder: 'Pacchetto 10 lezioni', wide: true });
  field('value', 'Valore (€)', { placeholder: '350.00', inputmode: 'decimal' });
  field('expiry', 'Scadenza', { type: 'date' });
  field('owner', 'Referente', { placeholder: 'Chi la segue', wide: true });
  body.appendChild(fields);

  // The value follows the catalog total until the person types one.
  let valueTyped = false;
  inputs.value.addEventListener('input', () => { valueTyped = String(inputs.value.value ?? '').trim() !== ''; });

  // ---- Catalog chips -------------------------------------------------
  const catalogBox = el('div', 'bo-offer-catalog');
  catalogBox.appendChild(el('p', 'bo-offer-catalog-title', 'Dal catalogo'));
  const chips = el('div', 'bo-offer-chips');
  catalogBox.appendChild(chips);
  const totalLine = el('p', 'bo-offer-total', '');
  catalogBox.appendChild(totalLine);
  // Hidden until the catalog answers with at least one priced offer.
  catalogBox.setAttribute('data-empty', 'true');
  body.appendChild(catalogBox);
  /** @type {Array<{offer: any, checkbox: {checked: boolean}, qtyInput: any, chip: any, wrap: any}>} */
  const picks = [];
  const refreshTotal = () => {
    const total = selectedProductTotal(picks);
    if (total === null) {
      totalLine.textContent = '';
      return;
    }
    if (total.error === 'mixed') {
      totalLine.textContent = 'Valute diverse: scegli prodotti in un’unica valuta.';
      return;
    }
    if (total.error === 'qty') {
      totalLine.textContent = 'Una quantità non è valida: scrivi un intero da 1 in su.';
      return;
    }
    totalLine.textContent = `Totale prodotti ${formatAmount(total.total, total.currency)}`;
    if (!valueTyped) inputs.value.value = centsToField(total.total);
  };
  const choose = (pick, on) => {
    pick.checkbox.checked = on;
    pick.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    pick.wrap.setAttribute('data-on', on ? 'true' : 'false');
    refreshTotal();
  };
  const paintCatalog = (catalog) => {
    const products = Array.isArray(catalog?.products) ? catalog.products : [];
    for (const product of products) {
      for (const offer of Array.isArray(product?.offers) ? product.offers : []) {
        if (!isPricedOffer(offer)) continue;
        const name = typeof offer.name === 'string' && offer.name.trim() !== '' ? offer.name.trim() : String(product?.name ?? 'Prodotto');
        const chip = el('button', 'bo-offer-chip', '');
        chip.setAttribute('type', 'button');
        chip.setAttribute('aria-pressed', 'false');
        chip.setAttribute('data-catalog-offer', String(offer.offerId ?? ''));
        chip.appendChild(el('span', 'bo-offer-chip-name', name));
        chip.appendChild(el('span', 'bo-offer-chip-price', offerPriceText(offer)));
        const perUnit = offer.components.some((component) => component.pricingModel === 'per_unit');
        let qtyInput = null;
        if (perUnit) {
          qtyInput = el('input', 'bo-offer-qty');
          qtyInput.setAttribute('type', 'number');
          qtyInput.setAttribute('min', '1');
          qtyInput.setAttribute('aria-label', `Quantità per ${name}`);
          qtyInput.value = '1';
          qtyInput.addEventListener('input', refreshTotal);
        }
        // The quantity sits next to its chip and shows only once chosen.
        const wrap = el('span', 'bo-offer-pick');
        wrap.setAttribute('data-on', 'false');
        wrap.appendChild(chip);
        if (qtyInput !== null) wrap.appendChild(qtyInput);
        const pick = { offer, checkbox: { checked: false }, qtyInput, chip, wrap };
        chip.addEventListener('click', () => choose(pick, !pick.checkbox.checked));
        chips.appendChild(wrap);
        picks.push(pick);
      }
    }
    catalogBox.setAttribute('data-empty', picks.length > 0 ? 'false' : 'true');
  };
  client.request('/api/catalog/products?active=true').then(
    (catalog) => { if (!gone()) paintCatalog(catalog); },
    () => { /* no catalog, or not readable: the value is typed by hand */ },
  );

  // The referente defaults to the person writing the offer.
  client.request('/api/profile').then(
    (profile) => {
      const name = typeof profile?.member?.name === 'string' ? profile.member.name.trim() : '';
      if (!gone() && name !== '' && String(inputs.owner.value ?? '').trim() === '') inputs.owner.value = name;
    },
    () => {},
  );

  body.appendChild(generalError);

  // ---- AI fill -------------------------------------------------------
  /** @type {null | {title: string, value: string, expiry: string, picks: boolean[], valueTyped: boolean}} */
  let before = null;
  let aiBusy = false;
  const say = (sentence, undo = false) => {
    while (aiLine.firstChild) aiLine.removeChild(aiLine.firstChild);
    aiLine.textContent = '';
    if (sentence === '') return;
    aiLine.appendChild(el('span', undefined, sentence));
    if (!undo) return;
    const back = el('button', 'bo-composer-ai-undo', 'Annulla');
    back.setAttribute('type', 'button');
    back.setAttribute('data-action', 'offer-ai-undo');
    back.addEventListener('click', () => {
      if (before === null) return;
      inputs.title.value = before.title;
      inputs.value.value = before.value;
      inputs.expiry.value = before.expiry;
      valueTyped = before.valueTyped;
      picks.forEach((pick, index) => choose(pick, before?.picks[index] === true));
      if (!before.valueTyped) inputs.value.value = before.value;
      before = null;
      go.textContent = 'Compila';
      say('Campi di prima ripristinati.');
    });
    aiLine.appendChild(el('span', undefined, ' · '));
    aiLine.appendChild(back);
  };
  const aiOff = (sentence) => {
    while (ai.firstChild) ai.removeChild(ai.firstChild);
    ai.setAttribute('data-off', 'true');
    ai.appendChild(el('p', 'bo-composer-ai-off', sentence));
  };
  async function fill() {
    if (aiBusy) return;
    const words = String(prompt.value ?? '').trim().slice(0, OFFER_PROMPT_MAX);
    if (words === '') {
      say('Descrivi l’offerta in una frase, poi Compila.');
      return;
    }
    aiBusy = true;
    go.setAttribute('disabled', 'disabled');
    go.textContent = 'Compilo…';
    say('');
    try {
      const answer = await client.request(OFFER_DRAFT_PATH, {
        method: 'POST',
        body: JSON.stringify({ spaceId: deps.spaceId, resource: navCtx.resource, id: navCtx.id, prompt: words }),
      });
      if (gone()) return;
      const draftTitle = typeof answer?.title === 'string' ? answer.title.trim().slice(0, 200) : '';
      const cents = Number.isSafeInteger(answer?.valueCents) && answer.valueCents >= 0 ? answer.valueCents : null;
      const day = dayOf(answer?.expectedCloseDate);
      const wanted = new Set(Array.isArray(answer?.catalogOfferIds) ? answer.catalogOfferIds.map(String) : []);
      if (draftTitle === '' && cents === null && day === '' && wanted.size === 0) {
        say('L’AI non ha trovato cosa compilare: prova a dirlo in un altro modo.');
        return;
      }
      if (before === null) {
        before = {
          title: String(inputs.title.value ?? ''),
          value: String(inputs.value.value ?? ''),
          expiry: String(inputs.expiry.value ?? ''),
          picks: picks.map((pick) => pick.checkbox.checked),
          valueTyped,
        };
      }
      if (draftTitle !== '') inputs.title.value = draftTitle;
      if (day !== '') inputs.expiry.value = day;
      if (wanted.size > 0) {
        valueTyped = false;
        for (const pick of picks) choose(pick, wanted.has(String(pick.offer.offerId)));
      }
      if (cents !== null) {
        inputs.value.value = centsToField(cents);
        valueTyped = true;
      }
      go.textContent = 'Ricompila';
      say('Compilata dall’AI: controlla i campi prima di creare.', true);
    } catch (error) {
      if (gone()) return;
      const code = error?.code ?? null;
      const status = error?.status ?? null;
      const off = code === 'LLM_SPACE_DISABLED' || code === 'LLM_SECRET_UNAVAILABLE'
        || status === 404 || status === 405 || isNotComposedFailure(error);
      // Like the composer: the operator sees why the row went quiet, never the prompt.
      if (off && typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[bo] AI spenta nel pannello offerta', { code, status: typeof status === 'number' ? status : null, spaceId: deps.spaceId ?? null });
      }
      if (code === 'LLM_SPACE_DISABLED') aiOff('L’AI non è attiva in questo spazio: compila i campi qui sotto.');
      else if (code === 'LLM_SECRET_UNAVAILABLE') aiOff('L’AI non è ancora configurata: compila i campi qui sotto.');
      else if (status === 404 || status === 405 || isNotComposedFailure(error)) {
        aiOff('La compilazione con l’AI non è ancora disponibile qui: compila i campi qui sotto.');
      } else if (status === 400) say('Richiesta non valida: scrivila più breve e con parole tue.');
      else say(humanReadError(error, { failed: 'L’AI non ha risposto. Riprova tra poco.' }));
    } finally {
      aiBusy = false;
      if (go.parentNode) {
        go.removeAttribute('disabled');
        if (go.textContent === 'Compilo…') go.textContent = before === null ? 'Compila' : 'Ricompila';
      }
    }
  }
  go.addEventListener('click', fill);
  prompt.addEventListener('keydown', (event) => {
    if (event?.key === 'Enter') {
      event.preventDefault?.();
      fill();
    }
  });

  // ---- Create --------------------------------------------------------
  const foot = el('div', 'bo-composer-foot');
  const create = el('button', 'primary', 'Crea offerta');
  create.setAttribute('type', 'button');
  create.setAttribute('data-action', 'offer-create');
  foot.appendChild(create);
  foot.appendChild(el('span', 'bo-composer-limit', 'Non viene inviata al cliente'));
  panel.appendChild(foot);

  const clearErrors = () => {
    generalError.textContent = '';
    for (const node of Object.values(errors)) node.textContent = '';
  };
  // One key per window: a retry or a double click files the same offer.
  let submissionKey = null;
  let creating = false;
  async function submit() {
    if (creating) return;
    clearErrors();
    const name = String(inputs.title.value ?? '').trim();
    const cents = euroToCents(inputs.value.value);
    const expiry = String(inputs.expiry.value ?? '').trim();
    const owner = String(inputs.owner.value ?? '').trim();
    const chosen = picks.filter((pick) => pick.checkbox.checked);
    const currencies = new Set(chosen.map((pick) => String(pick.offer.currency ?? '').toUpperCase()));
    let bad = false;
    if (name === '') { errors.title.textContent = 'Scrivi il titolo.'; bad = true; }
    if (cents === null) { errors.value.textContent = 'Scrivi il valore in euro, es. 350.00.'; bad = true; }
    if (owner === '') { errors.owner.textContent = 'Scrivi chi la segue.'; bad = true; }
    if (expiry !== '' && Number.isNaN(Date.parse(expiry))) { errors.expiry.textContent = 'La data non è valida.'; bad = true; }
    if (currencies.size > 1) { generalError.textContent = 'I prodotti scelti hanno valute diverse.'; bad = true; }
    if (bad) return;
    creating = true;
    create.setAttribute('disabled', 'disabled');
    create.setAttribute('aria-busy', 'true');
    create.textContent = 'Creo…';
    if (submissionKey === null) submissionKey = deps.issueKey();
    try {
      const created = await client.request('/api/opportunities', {
        method: 'POST',
        idempotencyKey: submissionKey,
        body: JSON.stringify({
          companyId: company.id,
          ...(navCtx.resource === 'contact' ? { contactId: navCtx.id } : {}),
          name,
          valueCents: cents,
          currency: currencies.size === 1 ? [...currencies][0] : 'EUR',
          ...(expiry !== '' ? { expectedCloseDate: expiry } : {}),
          owner,
        }),
      });
      submissionKey = null;
      shut();
      toast('Offerta creata');
      if (typeof deps.onCreated === 'function') deps.onCreated(created);
    } catch (error) {
      if (gone()) return;
      // A definitive refusal frees the key: the corrected offer is a new one.
      const status = typeof error?.status === 'number' ? error.status : 0;
      if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) submissionKey = null;
      generalError.textContent = humanReadError(error, { failed: 'Offerta non creata. Riprova tra poco: non verrà creata due volte.' });
    } finally {
      creating = false;
      if (!gone()) {
        create.removeAttribute('disabled');
        create.setAttribute('aria-busy', 'false');
        create.textContent = 'Crea offerta';
      }
    }
  }
  create.addEventListener('click', submit);
  panel.__submit = submit; // test hook

  if (deps.spaceId !== null && typeof prompt.focus === 'function') prompt.focus();
  else if (typeof inputs.title.focus === 'function') inputs.title.focus();
  return panel;
}
