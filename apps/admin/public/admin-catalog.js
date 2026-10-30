// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { formatAmount, humanReadError } from './admin-core.js';
import { createSubmissionController } from './admin-submission.js';
import { settingsTabs } from './admin-shell.js';

/**
 * Product catalog Admin (BO-F2-05 "11 Catalogo prodotti", BO-F2-04 rules):
 * the backoffice product table over `GET /api/catalog/products` — one row
 * per product with its source, active flag and current prices — plus the
 * Stripe connection state for this space, the enforced price rules read
 * from the schema, a confirm-gated "Aggiungi prodotto" creation over the
 * existing `POST /api/catalog/products` route, and confirm-gated edits of
 * prices and flags over the existing `POST /api/catalog/...` routes (no new
 * backend surface).
 * Rules unchanged from the rest of the Admin: every value renders as text
 * (never HTML), the server is authoritative for every amount,
 * Stripe-sourced prices render read-only text (no inputs at all — the write
 * path refuses them with PROVIDER_PRICE_READONLY), a render token discards
 * stale responses, and every mutation goes through the shared submission
 * controller (idempotency key per user submission).
 * Every row not bound to Stripe — manual or imported — offers Modifica
 * prezzi and Attiva/Disattiva: the first operator edit takes an imported
 * row over into manual management (the confirm says so), so a later sync
 * never rewrites it; Stripe rows stay read-only and the page says so.
 * Removing a product outright (Togli) has no backend operation yet and is
 * not offered here — deactivation archives it from quoting instead.
 *
 * DECISION (to be confirmed): the discount bands themselves (auto-approve,
 * owner max) stay composition config evaluated by the package — changing
 * them from the browser would bypass the definition-version drift gate, so
 * this view shows the live bands and leaves manual prices and product flags
 * (what the rules evaluate) editable with confirmation. A runtime band
 * editor is a separate backend voice, not this screen.
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

function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * Basis points to a short percent label: 1000 -> "10%", 250 -> "2.5%".
 * Anything non-numeric reads null so the caller falls back to honest text.
 * @param {unknown} bps
 */
export function bpsLabel(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0) return null;
  const text = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}

/**
 * Parse a euro amount typed by the operator ("12,50" or "12.50") into
 * integer cents. Fail-closed: anything that is not a non-negative amount
 * with at most two decimals reads null and the form refuses to send.
 * @param {unknown} raw
 */
export function parseEuroToCents(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void, submissions?: any, storage?: any}} deps */
export function createCatalogView(deps) {
  const { doc, mount } = deps;
  const { client } = deps;
  const submissions = deps.submissions ?? createSubmissionController({
    storage: deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? memoryStorage() : globalThis.localStorage),
    transport: (path, options) => client.request(path, {
      method: options.method,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
      idempotencyKey: options.idempotencyKey,
      headers: { ...(options.headers ?? {}), 'Idempotency-Key': options.idempotencyKey },
    }),
  });
  let renderToken = 0;

  const el = elFor(doc); // BO-F6-02: shared element builder.
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };
  const go = typeof deps.navigate === 'function'
    ? deps.navigate
    : (hash) => { if (globalThis.location) globalThis.location.hash = hash; };
  const SOURCE_LABELS = { manual: 'Manuale' };
  const sourceLabel = (source) => SOURCE_LABELS[source] ?? (String(source ?? '').toLowerCase().includes('stripe') ? 'Stripe' : String(source ?? '—'));
  const INTERVAL_LABELS = { day: 'giorno', week: 'settimana', month: 'mese', year: 'anno' };
  // Keys are the contract's PRICING_MODELS (packages/core/src/money.js); flat_fee and per_unit need no marker.
  const PRICING_MODEL_LABELS = { graduated: 'a scaglioni', volume: 'a volume' };
  const INTERVAL_PLURALS = { day: 'giorni', week: 'settimane', month: 'mesi', year: 'anni' };
  const money = (cents, currency) => (typeof cents === 'number' ? formatAmount(cents, currency) : '—');

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
    // Stripe's interval and pricing model are machine words: the screen says them in Italian, and an unknown one is left out rather than shown raw.
    const model = PRICING_MODEL_LABELS[component.pricingModel];
    const per = model ? ` (${model})` : '';
    const interval = INTERVAL_LABELS[component.interval];
    const count = Number.isInteger(component.intervalCount) && component.intervalCount > 1 ? component.intervalCount : 1;
    const every = !interval ? '' : count === 1 ? ` / ${interval}` : ` / ogni ${count} ${INTERVAL_PLURALS[component.interval]}`;
    const schedule = Array.isArray(component.tiers) && component.tiers.length > 0
      ? ` — ${component.tiers.map((tier) => tierLabel(tier, currency)).join(' · ')}`
      : '';
    return `${component.label ?? 'Prezzo'}: ${base}${per}${every}${schedule}`;
  }

  /**
   * The Stripe connection state for this space, in both states: connected
   * names the provider so the operator sees what "collegato" means, with a
   * confirm-gated re-sync over the existing sync route; disconnected keeps
   * the honest manual-management invite.
   * @param {any} summary
   */
  /**
   * Stripe connection state from the catalog summary. The server publishes
   * `stripeConnected` (packages/commercial/src/manual-catalog.js); a summary
   * without the flag falls back to the same by-provider derivation, so the
   * rows and the Stripe block never disagree about it.
   * @param {any} summary
   */
  function stripeIsConnected(summary) {
    if (summary && typeof summary.stripeConnected === 'boolean') return summary.stripeConnected;
    const providers = summary && typeof summary === 'object' && summary.byProvider
      && typeof summary.byProvider === 'object' ? summary.byProvider : {};
    return Object.keys(providers).some((name) => name.toLowerCase().includes('stripe'));
  }

  function renderStripeBlock(summary) {
    const box = el('div', 'catalog-stripe');
    box.appendChild(el('span', 'catalog-stripe-badge', 'S'));
    const text = el('div', 'catalog-stripe-text');
    box.appendChild(text);
    const byProvider = summary && typeof summary === 'object' && summary.byProvider
      && typeof summary.byProvider === 'object' ? summary.byProvider : {};
    const connected = stripeIsConnected(summary)
      ? Object.keys(byProvider).filter((name) => name.toLowerCase().includes('stripe'))
      : [];
    if (connected.length === 0) {
      box.setAttribute('data-state', 'manual');
      text.appendChild(el('strong', 'catalog-stripe-title', 'Stripe non collegato'));
      text.appendChild(el('p', 'catalog-invite', 'Stripe non è collegato: i prezzi si gestiscono a mano. Collega Stripe per importare il listino come fonte dei prezzi.'));
      return box;
    }
    text.appendChild(el('strong', 'catalog-stripe-title', 'Collegato a Stripe'));
    const counted = connected.map((name) => Number(byProvider[name]?.products ?? byProvider[name] ?? NaN)).filter(Number.isFinite);
    const total = counted.reduce((a, b) => a + b, 0);
    const imported = counted.length > 0 ? `${total} ${total === 1 ? 'prodotto importato' : 'prodotti importati'} da Stripe · ` : '';
    text.appendChild(el('p', 'catalog-stripe-ok', `${imported}prezzi di fonte in sola lettura: si cambiano su Stripe e si sincronizzano.`));
    const actions = el('div', 'catalog-stripe-actions');
    box.appendChild(actions);
    for (const provider of connected) {
      const syncButton = el('button', 'catalog-sync', 'Sincronizza');
      syncButton.setAttribute('data-provider', provider);
      syncButton.setAttribute('title', `Sincronizza i prodotti da Stripe (${provider})`);
      const confirmBox = el('div', 'catalog-confirm');
      const confirmError = el('p', 'field-error', '');
      syncButton.addEventListener('click', () => {
        while (confirmBox.firstChild) confirmBox.removeChild(confirmBox.firstChild);
        confirmBox.appendChild(el('p', undefined, 'Sincronizzare i prodotti da Stripe? Le offerte di fonte si aggiornano, quelle manuali restano.'));
        const yes = el('button', undefined, 'Conferma');
        const no = el('button', undefined, 'Annulla');
        no.addEventListener('click', () => {
          while (confirmBox.firstChild) confirmBox.removeChild(confirmBox.firstChild);
        });
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            await submissions.submit({ path: '/api/catalog/sync', method: 'POST', body: { provider } });
            await renderTable();
          } catch (error) {
            confirmError.textContent = error?.message ?? 'Sincronizzazione fallita';
          } finally {
            yes.disabled = false;
          }
        });
        confirmBox.appendChild(yes);
        confirmBox.appendChild(no);
        confirmBox.appendChild(confirmError);
      });
      actions.appendChild(syncButton);
      actions.appendChild(confirmBox);
    }
    return box;
  }

  /**
   * The enforced price rules (BO-F2-04), read from the schema: policy
   * identities with their live bands when the composition publishes them.
   * @param {any} schema
   */
  function renderRulesBlock(schema) {
    const box = el('div', 'catalog-rules');
    box.appendChild(el('h3', undefined, 'Regole di prezzo'));
    box.appendChild(el('p', 'muted', 'Valgono in tutte le offerte. Le regole bloccano anche l\u2019AI.'));
    const policies = commercialBlock(schema)?.discountPolicies;
    const list = Array.isArray(policies) ? policies : [];
    if (list.length === 0) {
      box.appendChild(el('p', 'catalog-empty', 'Nessuna regola di prezzo pubblicata dallo schema.'));
      return box;
    }
    for (const policy of list) {
      const item = el('div', 'catalog-rule');
      const name = policy?.name ?? '?';
      const version = policy?.version ?? '?';
      item.setAttribute('data-policy', `${name}@${version}`);
      const config = policy?.config;
      const auto = config && typeof config === 'object' ? bpsLabel(config.autoApproveMaxBps) : null;
      const ownerMax = config && typeof config === 'object' ? bpsLabel(config.ownerApprovalMaxBps) : null;
      if (auto !== null && ownerMax !== null) {
        const key = typeof config.approvalKey === 'string' && config.approvalKey !== '' ? config.approvalKey : 'owner';
        const who = key === 'owner' || key === 'titolare' ? 'della titolare' : `di ${key}`;
        item.appendChild(el('p', 'catalog-rule-bands', `Sconti approvati da soli fino al ${auto}; oltre serve l\u2019ok ${who} fino al ${ownerMax}; oltre, rifiutati.`));
      } else {
        item.appendChild(el('p', 'catalog-rule-bands', 'Fasce non pubblicate dallo schema.'));
      }
      box.appendChild(item);
    }
    return box;
  }

  /**
   * Confirm-gated active toggle for one operator-managed product over the
   * existing `POST /api/catalog/products/:id/active` route. On an imported
   * row the confirm names the takeover, so the operator knows the row
   * leaves its import source for manual management.
   * @param {any} product
   */
  function renderActiveToggle(product) {
    const target = product.active !== true;
    const imported = product.source !== 'manual';
    const button = el('button', `catalog-toggle catalog-switch${product.active === true ? ' on' : ''}`, target ? 'Attiva' : 'Disattiva');
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', product.active === true ? 'true' : 'false');
    const confirmBox = el('div', 'catalog-confirm');
    const confirmError = el('p', 'field-error', '');
    button.addEventListener('click', () => {
      while (confirmBox.firstChild) confirmBox.removeChild(confirmBox.firstChild);
      confirmBox.appendChild(el('p', undefined, target
        ? `Attivare ${product.name ?? product.productId}? Le offerte correnti si riattivano.`
        : `Disattivare ${product.name ?? product.productId}? Le offerte correnti si disattivano.`));
      if (imported) {
        confirmBox.appendChild(el('p', 'catalog-takeover-note', 'La riga importata passa alla gestione manuale: non seguirà più la fonte di importazione.'));
      }
      const yes = el('button', undefined, 'Conferma');
      const no = el('button', undefined, 'Annulla');
      no.addEventListener('click', () => {
        while (confirmBox.firstChild) confirmBox.removeChild(confirmBox.firstChild);
      });
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await submissions.submit({
            path: `/api/catalog/products/${encodeURIComponent(product.productId)}/active`,
            method: 'POST',
            body: { active: target },
          });
          await renderTable();
        } catch (error) {
          confirmError.textContent = error?.message ?? 'Modifica fallita';
        } finally {
          yes.disabled = false;
        }
      });
      confirmBox.appendChild(yes);
      confirmBox.appendChild(no);
      confirmBox.appendChild(confirmError);
    });
    const wrap = el('div', 'catalog-toggle-wrap');
    wrap.appendChild(button);
    wrap.appendChild(confirmBox);
    return wrap;
  }

  /**
   * Whether a manual product's prices can round-trip through set-prices:
   * every offer needs its row id, every component its declared key.
   * @param {any} product
   */
  function priceEditBlockers(product) {
    const offers = Array.isArray(product.offers) ? product.offers : [];
    if (offers.length === 0) return 'il prodotto non ha offerte da modificare.';
    for (const offer of offers) {
      if (typeof offer.offerId !== 'string' || offer.offerId === '') return 'manca l\u2019id di un\u2019offerta: rileggi il catalogo.';
      for (const component of Array.isArray(offer.components) ? offer.components : []) {
        if (typeof component.key !== 'string' || component.key === '') {
          return 'manca la chiave di un componente: rileggi il catalogo.';
        }
      }
    }
    return null;
  }

  /**
   * Confirm-gated price edit for one operator-managed product over the
   * existing `POST /api/catalog/products/:id/prices` route: Modifica ->
   * edit amounts -> Rivedi (old→new summary) -> Conferma. Tiers keep their
   * schedule with edited amounts; the server re-validates everything
   * fail-closed. On an imported row the first confirmation takes the row
   * over into manual management (the form says so).
   * @param {any} product
   */
  function renderPriceEditor(product) {
    const wrap = el('div', 'catalog-edit-wrap');
    const blocker = priceEditBlockers(product);
    if (blocker !== null) {
      wrap.appendChild(el('p', 'catalog-empty', `Prezzi non modificabili da qui: ${blocker}`));
      return wrap;
    }
    const openButton = el('button', 'catalog-edit', 'Modifica prezzi');
    const formBox = el('div', 'catalog-edit-form');
    const formError = el('p', 'field-error', '');
    openButton.addEventListener('click', () => {
      while (formBox.firstChild) formBox.removeChild(formBox.firstChild);
      /** @type {Array<{component: any, offer: any, inputs: Array<{kind: string, tierIndex: number, side: string, input: any}>}>} */
      const editors = [];
      for (const offer of product.offers) {
        formBox.appendChild(el('p', 'catalog-offer-name', offer.name ?? 'Offerta'));
        for (const component of offer.components) {
          const inputs = [];
          const pushAmount = (kind, tierIndex, cents, side) => {
            const label = kind === 'tier'
              ? `${component.label ?? 'Prezzo'} — fascia ${tierIndex + 1}`
              : (component.label ?? 'Prezzo');
            formBox.appendChild(el('label', 'catalog-amount-label', label));
            const input = el('input');
            input.setAttribute('type', 'text');
            input.setAttribute('inputmode', 'decimal');
            input.setAttribute('aria-label', label);
            input.value = typeof cents === 'number' ? (cents / 100).toFixed(2) : '';
            formBox.appendChild(input);
            inputs.push({ kind, tierIndex, side, input });
          };
          if (component.pricingModel === 'flat_fee') pushAmount('flat', -1, component.flatAmountCents, 'flat');
          else if (component.pricingModel === 'per_unit') pushAmount('unit', -1, component.unitAmountCents, 'unit');
          else {
            for (const [tierIndex, tier] of (component.tiers ?? []).entries()) {
              // The edited side is the side the schedule prices on, so the
              // round-trip never moves an amount from flat to unit or back.
              const side = tier.unitAmountCents === null || tier.unitAmountCents === undefined ? 'flat' : 'unit';
              pushAmount('tier', tierIndex, tier.unitAmountCents ?? tier.flatAmountCents, side);
            }
          }
          editors.push({ component, offer, inputs });
        }
      }
      const reviewButton = el('button', undefined, 'Rivedi');
      reviewButton.addEventListener('click', () => {
        formError.textContent = '';
        /** @type {Array<{editor: any, entry: any, cents: number}>} */
        const parsed = [];
        for (const editor of editors) {
          for (const entry of editor.inputs) {
            const cents = parseEuroToCents(entry.input.value);
            if (cents === null) {
              formError.textContent = 'Ogni importo deve essere un numero non negativo con al massimo due decimali.';
              return;
            }
            parsed.push({ editor, entry, cents });
          }
        }
        while (formBox.firstChild) formBox.removeChild(formBox.firstChild);
        const review = el('div', 'catalog-review');
        review.appendChild(el('p', undefined, `Confermi i nuovi prezzi di ${product.name ?? product.productId}?`));
        const changes = [];
        for (const { editor, entry, cents } of parsed) {
          const oldCents = entry.kind === 'flat' ? editor.component.flatAmountCents
            : entry.kind === 'unit' ? editor.component.unitAmountCents
              : (editor.component.tiers?.[entry.tierIndex]?.unitAmountCents
                ?? editor.component.tiers?.[entry.tierIndex]?.flatAmountCents);
          const currency = editor.offer.currency ?? undefined;
          changes.push(`${editor.component.label ?? 'Prezzo'}: ${money(oldCents, currency)} → ${money(cents, currency)}`);
        }
        // Unchanged amounts confirm as a no-op summary, never a blind write.
        const changed = parsed.some(({ editor, entry, cents }) => {
          const oldCents = entry.kind === 'flat' ? editor.component.flatAmountCents
            : entry.kind === 'unit' ? editor.component.unitAmountCents
              : (editor.component.tiers?.[entry.tierIndex]?.unitAmountCents
                ?? editor.component.tiers?.[entry.tierIndex]?.flatAmountCents);
          return oldCents !== cents;
        });
        for (const line of changes) review.appendChild(el('p', 'catalog-change', line));
        if (!changed) review.appendChild(el('p', 'catalog-empty', 'Nessuna modifica: confermare non scrive nulla.'));
        const yes = el('button', undefined, 'Conferma');
        const no = el('button', undefined, 'Annulla');
        no.addEventListener('click', async () => { await renderTable(); });
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            const offers = product.offers.map((offer) => ({
              name: offer.name,
              active: offer.active,
              components: offer.components.map((component) => {
                const take = (kind, tierIndex, fallback) => {
                  const found = parsed.find((candidate) => candidate.editor.component === component
                    && candidate.entry.kind === kind && candidate.entry.tierIndex === tierIndex);
                  return found ? found.cents : fallback;
                };
                return {
                  key: component.key,
                  label: component.label,
                  chargeType: component.chargeType,
                  pricingModel: component.pricingModel,
                  interval: component.interval ?? null,
                  intervalCount: component.intervalCount ?? null,
                  unitAmountCents: component.pricingModel === 'per_unit' ? take('unit', -1, component.unitAmountCents) : null,
                  flatAmountCents: component.pricingModel === 'flat_fee' ? take('flat', -1, component.flatAmountCents) : null,
                  externalPriceId: component.externalPriceId ?? null,
                  tiers: Array.isArray(component.tiers) ? component.tiers.map((tier, tierIndex) => {
                    const side = tier.unitAmountCents === null || tier.unitAmountCents === undefined ? 'flat' : 'unit';
                    const edited = take('tier', tierIndex, side === 'flat' ? tier.flatAmountCents : tier.unitAmountCents);
                    return {
                      upTo: tier.upTo ?? null,
                      unitAmountCents: side === 'flat' ? tier.unitAmountCents ?? null : edited,
                      flatAmountCents: side === 'flat' ? edited : tier.flatAmountCents ?? null,
                    };
                  }) : [],
                };
              }),
            }));
            await submissions.submit({
              path: `/api/catalog/products/${encodeURIComponent(product.productId)}/prices`,
              method: 'POST',
              body: { offerIds: product.offers.map((offer) => offer.offerId), offers },
            });
            await renderTable();
          } catch (error) {
            formError.textContent = error?.message ?? 'Modifica fallita';
            review.appendChild(formError);
          } finally {
            yes.disabled = false;
          }
        });
        review.appendChild(yes);
        review.appendChild(no);
        formBox.appendChild(review);
      });
      formBox.appendChild(reviewButton);
      formBox.appendChild(formError);
    });
    wrap.appendChild(openButton);
    if (product.source !== 'manual') {
      wrap.appendChild(el('p', 'catalog-takeover-note', 'Prezzi importati: alla prima modifica la riga passa alla gestione manuale.'));
    }
    wrap.appendChild(formBox);
    return wrap;
  }

  /**
   * Confirm-gated product creation over the existing
   * `POST /api/catalog/products` route: Aggiungi prodotto -> fill the five
   * backoffice fields (name, code, category, price, unit) plus the currency
   * the write path requires -> Rivedi -> Conferma. The price becomes the
   * single one-time flat component of a new manual product; the server
   * re-validates everything fail-closed. The form stays manual-only in
   * shape: provider rows are never created here, so Stripe keeps nothing
   * to read here either.
   */
  function renderCreateForm() {
    const wrap = el('div', 'catalog-create-wrap');
    const openButton = el('button', 'catalog-create', 'Aggiungi prodotto');
    const formBox = el('div', 'catalog-create-form');
    const formError = el('p', 'field-error', '');
    openButton.addEventListener('click', () => {
      while (formBox.firstChild) formBox.removeChild(formBox.firstChild);
      /** @type {Record<string, any>} */
      const fields = {};
      const addField = (name, label, options = {}) => {
        formBox.appendChild(el('label', 'catalog-create-label', label));
        const input = el('input');
        input.setAttribute('name', name);
        input.setAttribute('aria-label', label);
        if (options.placeholder) input.setAttribute('placeholder', options.placeholder);
        if (options.inputmode) input.setAttribute('inputmode', options.inputmode);
        input.value = options.value ?? '';
        formBox.appendChild(input);
        fields[name] = input;
      };
      addField('name', 'Nome', { placeholder: 'Pacchetto 10 lezioni' });
      addField('sku', 'Codice', { placeholder: 'PACCHETTO-10' });
      addField('category', 'Categoria', { placeholder: 'pacchetti' });
      addField('price', 'Prezzo', { placeholder: '99,00', inputmode: 'decimal' });
      addField('unit', 'Unità', { placeholder: 'ingressi' });
      addField('currency', 'Valuta', { value: 'EUR' });
      const reviewButton = el('button', undefined, 'Rivedi');
      reviewButton.addEventListener('click', () => {
        formError.textContent = '';
        const name = fields.name.value.trim();
        const sku = fields.sku.value.trim();
        const category = fields.category.value.trim();
        const cents = parseEuroToCents(fields.price.value);
        const unit = fields.unit.value.trim();
        const currency = fields.currency.value.trim();
        if (name === '' || sku === '') {
          formError.textContent = 'Nome e codice sono obbligatori.';
          return;
        }
        if (cents === null) {
          formError.textContent = 'Il prezzo deve essere un numero non negativo con al massimo due decimali.';
          return;
        }
        if (!/^[A-Z]{3}$/.test(currency)) {
          formError.textContent = 'La valuta sono tre lettere maiuscole, per esempio EUR.';
          return;
        }
        while (formBox.firstChild) formBox.removeChild(formBox.firstChild);
        const review = el('div', 'catalog-review');
        review.appendChild(el('p', undefined, `Creare ${name} (${sku}) a ${money(cents, currency)}?`));
        if (category !== '') review.appendChild(el('p', 'catalog-change', `Categoria: ${category}`));
        review.appendChild(el('p', 'catalog-change', `Unità: ${unit === '' ? '—' : unit}`));
        const yes = el('button', undefined, 'Conferma');
        const no = el('button', undefined, 'Annulla');
        no.addEventListener('click', async () => { await renderTable(); });
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            await submissions.submit({
              path: '/api/catalog/products',
              method: 'POST',
              body: {
                sku,
                name,
                category: category === '' ? null : category,
                currency,
                unit: unit === '' ? null : unit,
                components: [{
                  key: 'prezzo',
                  label: 'Prezzo',
                  chargeType: 'one_time',
                  pricingModel: 'flat_fee',
                  unitAmountCents: null,
                  flatAmountCents: cents,
                  externalPriceId: null,
                  tiers: [],
                }],
              },
            });
            await renderTable();
          } catch (error) {
            formError.textContent = error?.message ?? 'Creazione fallita';
            review.appendChild(formError);
          } finally {
            yes.disabled = false;
          }
        });
        review.appendChild(yes);
        review.appendChild(no);
        formBox.appendChild(review);
      });
      formBox.appendChild(reviewButton);
      formBox.appendChild(formError);
    });
    wrap.appendChild(openButton);
    wrap.appendChild(formBox);
    return wrap;
  }

  /**
   * The prototype's search filters the visible rows by product name and
   * code (spec catalogo.md C9/C21): the read vocabulary has no search
   * param, so the match runs client-side over the loaded page, like the
   * category chips derivation below. Anything but non-empty text reads
   * unfiltered.
   * @param {any} product
   * @param {unknown} query
   */
  function matchesSearch(product, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (q === '') return true;
    const hay = [product?.name, product?.sku]
      .filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase());
    return hay.some((text) => text.includes(q));
  }

  /**
   * Render the product table. Filters mirror the read's own vocabulary
   * (category exact, active flag, source name); the search field filters
   * the loaded page client-side by name and code. Empty values read
   * unfiltered.
   */
  async function renderTable({ category = '', active = '', source = '', search = '' } = {}) {
    const token = ++renderToken;
    clear();
    mount.appendChild(settingsTabs(doc, { activeId: 'catalogo', navigate: go }));
    const page = el('div', 'catalog-page');
    mount.appendChild(page);
    const top = el('div', 'catalog-top');
    top.appendChild(el('h2', 'panel-title', 'Catalogo prodotti'));
    top.appendChild(el('p', 'catalog-lede', 'Prodotti e servizi che usi nelle offerte. Prezzi, unità e sconti si applicano da soli quando aggiungi una voce.'));
    page.appendChild(top);
    const status = el('p', 'muted catalog-status', 'Caricamento catalogo…');
    page.appendChild(status);
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
      status.textContent = humanReadError(error, {
        failed: 'Il catalogo non si è potuto leggere. Riprova più tardi.',
      });
      return;
    }
    if (token !== renderToken) return;
    if (!commercialBlock(schema) || !table || !Array.isArray(table.products)) {
      status.textContent = 'Il catalogo non è attivo in questo progetto.';
      return;
    }
    const summary = table.summary ?? {};
    page.appendChild(renderStripeBlock(summary));
    page.appendChild(renderCreateForm());
    const loaded = table.products;

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
    sourceInput.setAttribute('placeholder', 'Fonte');
    sourceInput.value = typeof source === 'string' ? source : '';
    const applyButton = el('button', undefined, 'Filtra');
    const filterError = el('small', 'field-error', '');
    // The prototype's search (spec catalogo.md C9): exact placeholder,
    // live client-side match on name and code, never a server param.
    const searchInput = el('input', 'catalog-search');
    searchInput.setAttribute('type', 'search');
    searchInput.setAttribute('name', 'search');
    searchInput.setAttribute('aria-label', 'Cerca prodotto o codice');
    searchInput.setAttribute('placeholder', 'Cerca prodotto o codice');
    searchInput.value = typeof search === 'string' ? search : '';
    const readSearch = () => searchInput.value ?? '';
    const repaint = () => { paintList(readSearch()); };
    searchInput.addEventListener('input', repaint);
    searchInput.addEventListener('search', repaint);
    applyButton.addEventListener('click', async () => {
      applyButton.disabled = true;
      try {
        await renderTable({ category: categoryInput.value, active: activeSelect.value, source: sourceInput.value, search: readSearch() });
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
    filters.appendChild(searchInput);
    filters.appendChild(filterError);
    // Category chips from the read itself, like the prototype's tabs.
    const counts = new Map();
    for (const product of table.products) {
      const key = typeof product.category === 'string' && product.category !== '' ? product.category : null;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const bar = el('div', 'catalog-bar');
    const chips = el('div', 'catalog-chips');
    const chip = (label, value, count) => {
      const button = el('button', `catalog-chip${(category ?? '') === value ? ' active' : ''}`, label);
      if (count !== null) button.appendChild(el('span', 'catalog-chip-count', String(count)));
      button.addEventListener('click', () => { void renderTable({ category: value, active, source, search: readSearch() }); });
      chips.appendChild(button);
    };
    chip('Tutti', '', category ? null : table.products.length);
    for (const [key, count] of counts) chip(key, key, count);
    bar.appendChild(chips);
    bar.appendChild(filters);
    page.appendChild(bar);

    const list = el('div', 'catalog-list');
    const buildRow = (product) => {
      const row = el('div', 'catalog-row');
      if (product.productId !== undefined) row.setAttribute('data-product', String(product.productId));
      const cell = el('div', 'catalog-cell-name');
      cell.appendChild(el('h3', undefined, product.name ?? 'Senza nome'));
      cell.appendChild(el('p', 'catalog-sku', product.sku ?? '—'));
      row.appendChild(cell);
      row.appendChild(el('p', 'catalog-category', product.category ?? '—'));
      const priceCell = el('div', 'catalog-cell-price');
      row.appendChild(priceCell);
      const meta = el('p', 'catalog-meta');
      meta.appendChild(el('span', `catalog-source catalog-source-${product.source === 'manual' ? 'manual' : 'provider'}`, sourceLabel(product.source)));
      row.appendChild(meta);
      const switchCell = el('div', 'catalog-cell-switch');
      switchCell.appendChild(el('span', 'catalog-active-state', product.active === true ? 'Attivo' : 'Non attivo'));
      row.appendChild(switchCell);
      // Only Stripe-bound rows stay read-only: the write path refuses them
      // with PROVIDER_PRICE_READONLY. Imported rows from any other source
      // are operator-managed (the first edit takes them over), so the
      // "change it on Stripe" note names Stripe rows only — and only while
      // a Stripe source is actually connected, so no row promises a Stripe
      // edit that has nowhere to go. Row identity uses the same derivation
      // the server guard uses, so the two never disagree about a row.
      const stripeRow = String(product.source ?? '').toLowerCase().includes('stripe');
      const manageable = !stripeRow && typeof product.productId === 'string' && product.productId !== '';
      if (stripeRow && stripeIsConnected(summary)) {
        priceCell.appendChild(el('p', 'catalog-readonly', 'Sola lettura: si cambia su Stripe.'));
      }
      const offers = Array.isArray(product.offers) ? product.offers : [];
      if (offers.length === 0) {
        priceCell.appendChild(el('p', 'catalog-empty', 'Nessuna offerta.'));
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
        priceCell.appendChild(offerBox);
      }
      if (manageable) {
        priceCell.appendChild(renderPriceEditor(product));
        switchCell.appendChild(renderActiveToggle(product));
      }
      return row;
    };
    // Search repaints the rows in place (no refetch, focus stays in the
    // field); a search with no match is a gentle note with an action
    // (spec catalogo.md C19), never a blank table or a technical text.
    const paintList = (query) => {
      const q = String(query ?? '').trim();
      const rows = loaded.filter((product) => matchesSearch(product, query));
      while (list.firstChild) list.removeChild(list.firstChild);
      const head = el('div', 'catalog-thead');
      for (const label of ['Prodotto', 'Categoria', 'Prezzo', 'Fonte', 'Attivo']) head.appendChild(el('span', undefined, label));
      list.appendChild(head);
      if (rows.length === 0 && q !== '') {
        const empty = el('div', 'catalog-no-results');
        empty.appendChild(el('p', undefined, `Nessun risultato per «${q}». Prova con un altro nome o codice.`));
        const clearSearch = el('button', 'catalog-clear-search', 'Cancella ricerca');
        clearSearch.addEventListener('click', () => {
          searchInput.value = '';
          paintList('');
        });
        empty.appendChild(clearSearch);
        list.appendChild(empty);
      } else {
        for (const product of rows) list.appendChild(buildRow(product));
      }
      const n = rows.length;
      status.textContent = q !== ''
        ? `${n} ${n === 1 ? 'risultato' : 'risultati'} per «${q}».`
        : (loaded.length >= LIST_LIMIT
          ? `Mostrati i primi ${LIST_LIMIT} prodotti.`
          : `${loaded.length} ${loaded.length === 1 ? 'prodotto' : 'prodotti'}.`);
    };
    page.appendChild(list);
    paintList(search);
    page.appendChild(renderRulesBlock(schema));
  }

  return { renderTable };
}
