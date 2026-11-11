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

/**
 * Euro text to integer cents, or null. Reads the Italian form the field
 * shows («1.250,00», «350,5») and the plain one («350», «12.30»); a dotted
 * thousand without a comma («1.250») stays refused as ambiguous.
 */
export function euroToCents(raw) {
  let text = String(raw ?? '').trim();
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text)) text = text.replace(/\./g, '');
  text = text.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Integer cents to the field's text in the Italian form (backlog
 * 0c9a27bb9ac0: «15,00», «1.250,00», never «15.00»).
 */
export function centsToField(cents) {
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${whole},${String(cents % 100).padStart(2, '0')}`;
}

/** The quantity of one chosen chip: its own field for a per-unit price, else 1. */
function pickQuantity(pick) {
  if (pick.qtyInput === null) return 1;
  const raw = String(pick.qtyInput.value ?? '1').trim();
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/** The name a chip shows for one catalog offer. */
function pickName(pick) {
  return typeof pick.offer.name === 'string' && pick.offer.name.trim() !== '' ? pick.offer.name.trim() : String(pick.productName ?? 'Prodotto');
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
 *   spaceId: string | null, toast?: (text: string, error?: boolean) => void,
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
  // Review #616 (P3): any company without an id blocks, not only null.
  if (company == null || typeof company.id !== 'string' || company.id === '') {
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
  /** @type {Record<string, any>} */
  const labels = {};
  const field = (name, label, { type = 'text', placeholder = '', wide = false, inputmode = null } = {}) => {
    const wrap = el('label', `bo-offer-field${wide ? ' bo-offer-field-wide' : ''}`);
    const labelNode = el('span', 'bo-offer-label', label);
    wrap.appendChild(labelNode);
    labels[name] = labelNode;
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
  field('value', 'Valore (€)', { placeholder: '350,00', inputmode: 'decimal' });
  field('expiry', 'Scadenza', { type: 'date' });
  field('owner', 'Referente', { placeholder: 'Chi la segue', wide: true });
  body.appendChild(fields);

  // The value follows the catalog total until the person types one.
  let valueTyped = false;
  // Backlog 0c9a27bb9ac0: the title follows the chosen products while it is
  // empty or still the one they wrote; a title typed or drafted by the AI
  // is never overwritten.
  let autoTitle = '';
  const refreshTitle = () => {
    const current = String(inputs.title.value ?? '').trim();
    if (current !== '' && current !== autoTitle) return;
    const names = picks.filter((pick) => pick.checkbox.checked).map(pickName);
    const others = names.length - 1;
    const next = names.length === 0 ? ''
      : (others === 0 ? names[0] : `${names[0]} e ${others === 1 ? 'un altro prodotto' : `altri ${others} prodotti`}`);
    inputs.title.value = next;
    autoTitle = next;
  };
  // Review #616 (P1): the currency the AI drafted the value in. Chosen
  // catalog chips in one currency still decide; without them the AI's
  // currency files the offer, and only without either it is EUR.
  /** @type {string | null} */
  let draftCurrency = null;
  const setDraftCurrency = (code) => {
    draftCurrency = code;
    labels.value.textContent = code === null || code === 'EUR' ? 'Valore (€)' : `Valore (${code})`;
  };
  inputs.value.addEventListener('input', () => {
    valueTyped = String(inputs.value.value ?? '').trim() !== '';
    // An emptied value drops the AI currency and lets the chips price it.
    if (!valueTyped && draftCurrency !== null) {
      setDraftCurrency(null);
      refreshTotal();
    }
  });

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
  /** @type {Array<{offer: any, productName: unknown, checkbox: {checked: boolean}, qtyInput: any, chip: any, wrap: any}>} */
  const picks = [];
  // Review #616 (P2): Compila may answer before the catalog does. The
  // offers the AI chose wait here and are pressed once the chips exist.
  let catalogReady = false;
  /** @type {null | {ids: Set<string>, keepValue: boolean}} */
  let pendingWanted = null;
  /** Set once Crea offerta exists: disables it while pendingWanted waits. */
  let syncCreate = () => {};
  /** Presses the AI-chosen chips; answers how many matched the catalog. */
  const applyWanted = ({ ids, keepValue }) => {
    const matched = picks.filter((pick) => ids.has(String(pick.offer.offerId))).length;
    if (matched === 0) return 0;
    if (!keepValue) valueTyped = false;
    for (const pick of picks) choose(pick, ids.has(String(pick.offer.offerId)));
    return matched;
  };
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
    if (!valueTyped) {
      inputs.value.value = centsToField(total.total);
      // Review #616 round 3: this value is the chips' total, in their
      // currency; an earlier AI currency no longer describes it.
      setDraftCurrency(null);
    }
  };
  const choose = (pick, on) => {
    pick.checkbox.checked = on;
    pick.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    pick.wrap.setAttribute('data-on', on ? 'true' : 'false');
    refreshTotal();
    refreshTitle();
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
        const pick = { offer, productName: product?.name ?? null, checkbox: { checked: false }, qtyInput, chip, wrap };
        chip.addEventListener('click', () => choose(pick, !pick.checkbox.checked));
        chips.appendChild(wrap);
        picks.push(pick);
      }
    }
    catalogBox.setAttribute('data-empty', picks.length > 0 ? 'false' : 'true');
    catalogReady = true;
    if (pendingWanted !== null) {
      const wanted = pendingWanted;
      pendingWanted = null;
      syncCreate();
      if (applyWanted(wanted) === 0) say('I prodotti scelti dall’AI non sono nel catalogo: sceglili qui sotto se servono.', before !== null);
      else say('Compilata dall’AI: controlla i campi prima di creare.', before !== null);
    }
  };
  client.request('/api/catalog/products?active=true').then(
    (catalog) => { if (!gone()) paintCatalog(catalog); },
    () => {
      // No catalog, or not readable: the value is typed by hand, and the
      // products the AI chose cannot be pressed.
      catalogReady = true;
      if (pendingWanted !== null && !gone()) {
        pendingWanted = null;
        syncCreate();
        say('Il catalogo non si è potuto leggere: i prodotti scelti dall’AI vanno aggiunti a mano.', before !== null);
      }
    },
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
  /** @type {null | {title: string, value: string, expiry: string, picks: boolean[], valueTyped: boolean, currency: string | null}} */
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
      pendingWanted = null;
      syncCreate();
      setDraftCurrency(before.currency);
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
      const rawCurrency = typeof answer?.currency === 'string' ? answer.currency.trim().toUpperCase() : '';
      const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
      const unmatched = catalogReady && wanted.size > 0
        && !picks.some((pick) => wanted.has(String(pick.offer.offerId)));
      if (draftTitle === '' && cents === null && day === '' && (wanted.size === 0 || unmatched)) {
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
          currency: draftCurrency,
        };
      }
      if (draftTitle !== '') inputs.title.value = draftTitle;
      if (day !== '') inputs.expiry.value = day;
      pendingWanted = null;
      if (wanted.size > 0) {
        const ask = { ids: wanted, keepValue: cents !== null };
        if (catalogReady) applyWanted(ask);
        else pendingWanted = ask;
      }
      if (cents !== null) {
        inputs.value.value = centsToField(cents);
        valueTyped = true;
        setDraftCurrency(currency);
      }
      go.textContent = 'Ricompila';
      syncCreate();
      if (pendingWanted !== null) {
        say('Compilata dall’AI: aspetto il catalogo per i prodotti scelti…', true);
        return;
      }
      say(unmatched
        ? 'Compilata dall’AI, ma i prodotti scelti non sono nel catalogo: controlla i campi prima di creare.'
        : 'Compilata dall’AI: controlla i campi prima di creare.', true);
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

  /**
   * Backlog 0c9a27bb9ac0: the chosen products become the lines of the
   * offer's quote, through the commercial actions that already exist —
   * `create-quote` on the new offer, then `add-line` per product with its
   * quantity. The server prices every line from the catalog; the window
   * sends only the offer id and the quantity. A quote binds one price book,
   * read from the offer record (never guessed), so products from two books
   * file two quotes. Each write owns its own submission key.
   * @param {string} opportunityId
   * @param {Array<any>} chosen
   * @param {{opened: number}} progress how many quotes already exist, for the failure line
   */
  async function fileQuote(opportunityId, chosen, progress) {
    /** @type {Map<string, Array<any>>} */
    const byBook = new Map();
    for (const pick of chosen) {
      const offerId = String(pick.offer.offerId ?? '');
      const record = await client.request(`/api/modules/offer/records/${encodeURIComponent(offerId)}`);
      const book = typeof record?.priceBookId === 'string' && record.priceBookId !== '' ? record.priceBookId : null;
      if (book === null) throw Object.assign(new Error('offer without price book'), { code: 'OFFER_PRICE_BOOK_UNKNOWN' });
      byBook.set(book, [...(byBook.get(book) ?? []), pick]);
    }
    for (const [priceBookId, group] of byBook) {
      const opened = await client.request(
        `/api/modules/opportunity/records/${encodeURIComponent(opportunityId)}/actions/create-quote`,
        { method: 'POST', idempotencyKey: deps.issueKey(), body: JSON.stringify({ priceBookId }) },
      );
      const quote = opened?.result?.quote;
      if (typeof quote?.id !== 'string' || quote.id === '') throw Object.assign(new Error('quote without id'), { code: 'QUOTE_UNREADABLE' });
      progress.opened += 1;
      let revision = Number.isSafeInteger(quote.draftRevision) ? quote.draftRevision : null;
      for (const pick of group) {
        const added = await client.request(
          `/api/modules/quote/records/${encodeURIComponent(quote.id)}/actions/add-line`,
          {
            method: 'POST',
            idempotencyKey: deps.issueKey(),
            body: JSON.stringify({
              offerId: String(pick.offer.offerId ?? ''),
              quantity: pickQuantity(pick),
              ...(revision !== null ? { expectedRevision: revision } : {}),
            }),
          },
        );
        const next = added?.result?.quote?.draftRevision;
        revision = Number.isSafeInteger(next) ? next : null;
      }
    }
  }

  const clearErrors = () => {
    generalError.textContent = '';
    for (const node of Object.values(errors)) node.textContent = '';
  };
  // One key per window: a retry or a double click files the same offer.
  let submissionKey = null;
  let creating = false;
  async function submit() {
    if (creating) return;
    if (pendingWanted !== null) {
      generalError.textContent = 'Aspetto il catalogo per i prodotti scelti dall’AI, poi puoi creare.';
      return;
    }
    clearErrors();
    const name = String(inputs.title.value ?? '').trim();
    const cents = euroToCents(inputs.value.value);
    const expiry = String(inputs.expiry.value ?? '').trim();
    const owner = String(inputs.owner.value ?? '').trim();
    const chosen = picks.filter((pick) => pick.checkbox.checked);
    const currencies = new Set(chosen.map((pick) => String(pick.offer.currency ?? '').toUpperCase()));
    let bad = false;
    if (name === '') { errors.title.textContent = 'Scrivi il titolo.'; bad = true; }
    if (cents === null) { errors.value.textContent = 'Scrivi il valore in euro, es. 350,00.'; bad = true; }
    if (owner === '') { errors.owner.textContent = 'Scrivi chi la segue.'; bad = true; }
    if (expiry !== '' && Number.isNaN(Date.parse(expiry))) { errors.expiry.textContent = 'La data non è valida.'; bad = true; }
    // Review #616 round 5: the selection is re-checked here, not only in the
    // total line: an invalid quantity or mixed currencies never file the
    // value that was on screen before the selection went wrong.
    const selection = selectedProductTotal(picks);
    if (selection?.error === 'qty') { generalError.textContent = 'Una quantità non è valida: scrivi un intero da 1 in su.'; bad = true; }
    if (selection?.error === 'mixed' || currencies.size > 1) { generalError.textContent = 'I prodotti scelti hanno valute diverse.'; bad = true; }
    // Review #616 round 3 (P1): a value the AI drafted in one currency is
    // never filed under the chips' other currency.
    const chipCurrency = currencies.size === 1 ? [...currencies][0] : null;
    if (draftCurrency !== null && chipCurrency !== null && chipCurrency !== draftCurrency) {
      generalError.textContent = `Il valore è in ${draftCurrency}, i prodotti scelti in ${chipCurrency}: togli i prodotti, oppure svuota il valore e lo calcolano i prodotti.`;
      bad = true;
    }
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
          currency: currencies.size === 1 ? [...currencies][0] : (draftCurrency ?? 'EUR'),
          ...(expiry !== '' ? { expectedCloseDate: expiry } : {}),
          owner,
        }),
      });
      submissionKey = null;
      // The offer exists: its products become the quote lines. A quote that
      // fails never undoes the offer, and is said, never hidden.
      let quoteFailed = false;
      const progress = { opened: 0 };
      const createdId = typeof created?.id === 'string' && created.id !== '' ? created.id : null;
      if (chosen.length > 0) {
        if (!gone()) create.textContent = 'Creo il preventivo…';
        try {
          if (createdId === null) throw Object.assign(new Error('offer without id'), { code: 'OFFER_UNREADABLE' });
          await fileQuote(createdId, chosen, progress);
        } catch (error) {
          quoteFailed = true;
          if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[bo] preventivo dell’offerta non creato', {
              code: error?.code ?? null,
              status: typeof error?.status === 'number' ? error.status : null,
              spaceId: deps.spaceId ?? null,
            });
          }
        }
      }
      shut();
      // The scheda shows the offer first, so the toast never speaks ahead
      // of the screen (backlog:2a214b66fe12).
      if (typeof deps.onCreated === 'function') deps.onCreated(created);
      // A quote already opened is completed from its own page, never
      // opened twice: the line names the step that is left.
      if (quoteFailed && progress.opened > 0) toast('Offerta creata, ma il preventivo è incompleto: apri l’offerta, poi il preventivo, e aggiungi le righe.', true);
      else if (quoteFailed) toast('Offerta creata, ma il preventivo non si è salvato: apri l’offerta e premi «Crea preventivo».', true);
      else toast(chosen.length > 0 ? 'Offerta e preventivo creati' : 'Offerta creata');
    } catch (error) {
      // Review #616 round 4: a failed create is always logged (code, status
      // and space, never the offer) and, with the window already closed
      // (Escape, ✕, Scrivi), still told to the person as a toast.
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[bo] offerta non creata', {
          code: error?.code ?? null,
          status: typeof error?.status === 'number' ? error.status : null,
          spaceId: deps.spaceId ?? null,
        });
      }
      if (gone()) {
        toast('Offerta non creata: riapri «Nuova offerta» e riprova.', true);
        return;
      }
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
  // Review #616 round 3 (P2): while the AI's catalog choice waits for the
  // catalog, the filed value and currency are not settled yet.
  syncCreate = () => {
    if (creating || gone()) return;
    if (pendingWanted !== null) create.setAttribute('disabled', 'disabled');
    else create.removeAttribute('disabled');
  };
  panel.__submit = submit; // test hook

  if (deps.spaceId !== null && typeof prompt.focus === 'function') prompt.focus();
  else if (typeof inputs.title.focus === 'function') inputs.title.focus();
  return panel;
}
