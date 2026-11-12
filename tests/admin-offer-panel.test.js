import test from 'node:test';
import assert from 'node:assert/strict';
import { openOfferPanel, euroToCents } from '../apps/admin/public/admin-offer-panel.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * «Nuova offerta» from the scheda (Dan 06/11): a window over the page like
 * «Scrivi», an AI row that fills the fields from one sentence, catalog chips
 * whose total prices the offer, and one governed create per window.
 */

const CATALOG = {
  products: [
    {
      name: 'Personal Training',
      offers: [
        { offerId: 'pt10', name: 'Pacchetto 10 PT', active: true, currency: 'EUR', components: [{ pricingModel: 'flat_fee', flatAmountCents: 35000 }] },
        { offerId: 'pt1', name: 'PT singola', active: true, currency: 'EUR', components: [{ pricingModel: 'per_unit', unitAmountCents: 4000 }] },
        { offerId: 'tier', name: 'A scaglioni', active: true, currency: 'EUR', components: [{ pricingModel: 'per_unit', unitAmountCents: 1, tiers: [{}] }] },
      ],
    },
    { name: 'Lezione di prova', offers: [{ offerId: 'prova', name: 'Lezione di prova', active: true, currency: 'EUR', components: [{ pricingModel: 'flat_fee', flatAmountCents: 1500 }] }] },
  ],
};

// The price book of each catalog offer, as the offer record carries it.
const BOOKS = { pt10: 'pb-eur', pt1: 'pb-eur', prova: 'pb-eur' };

function fakeClient({ draft = null, create = null, catalog = CATALOG, profile = { member: { name: 'Elena Rinaldi' } }, books = BOOKS, quoteFail = null } = {}) {
  const calls = [];
  let quotes = 0;
  return {
    calls,
    drafts: () => calls.filter((call) => call.path === '/api/customer-hub/offers/draft'),
    creates: () => calls.filter((call) => call.path === '/api/opportunities'),
    quotes: () => calls.filter((call) => call.path.endsWith('/actions/create-quote')),
    lines: () => calls.filter((call) => call.path.endsWith('/actions/add-line')),
    async request(path, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null, key: options.idempotencyKey ?? null });
      if (path === '/api/catalog/products?active=true') {
        if (catalog instanceof Error) throw catalog;
        return catalog;
      }
      if (path === '/api/profile') return profile;
      if (path === '/api/customer-hub/offers/draft') {
        if (draft instanceof Error) throw draft;
        return typeof draft === 'function' ? draft() : draft;
      }
      if (path === '/api/opportunities') {
        if (typeof create === 'function') return create(calls.filter((call) => call.path === path).length);
        return { id: 'o1' };
      }
      const offer = /^\/api\/modules\/offer\/records\/([^/?]+)$/.exec(path);
      if (offer && method === 'GET') return { id: offer[1], priceBookId: books[decodeURIComponent(offer[1])] ?? null };
      const failWith = typeof quoteFail === 'function'
        ? quoteFail({ path, n: calls.filter((call) => call.path === path).length })
        : null;
      if (failWith) throw failWith;
      if (/^\/api\/modules\/opportunity\/records\/[^/]+\/actions\/create-quote$/.test(path)) {
        if (quoteFail === 'create-quote') throw Object.assign(new Error('refused'), { status: 409, code: 'PRICE_BOOK_INACTIVE' });
        quotes += 1;
        return { ok: true, result: { quote: { id: `q${quotes}`, draftRevision: 1 } } };
      }
      const line = /^\/api\/modules\/quote\/records\/([^/]+)\/actions\/add-line$/.exec(path);
      if (line) {
        if (quoteFail === 'add-line') throw Object.assign(new Error('gateway'), { status: 502 });
        const before = calls.filter((call) => call.path === path).length;
        return { ok: true, result: { quote: { id: line[1], draftRevision: 1 + before } } };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(options = {}) {
  const doc = createFakeDocument();
  const host = createMount();
  const client = options.client ?? fakeClient();
  const toasts = [];
  const created = [];
  let keys = 0;
  const panel = openOfferPanel({
    doc,
    host,
    client,
    issueKey: () => `key-${(keys += 1)}`,
    card: { name: 'Guido Presti' },
    navCtx: { resource: 'contact', id: 'c1' },
    company: options.company === undefined ? { id: 'co1', name: 'Palestra Esempio' } : options.company,
    spaceId: options.spaceId === undefined ? 'presti' : options.spaceId,
    toast: (text) => toasts.push(text),
    onCreated: (answer) => created.push(answer),
  });
  await flush();
  return { host, panel, client, toasts, created };
}

const byAction = (node, action) => node.findAll('button').find((button) => button.getAttribute('data-action') === action);
const input = (panel, name) => panel.findAll('input').find((node) => node.getAttribute('name') === `offer-${name}`);
const chip = (panel, id) => panel.findAll('button').find((node) => node.getAttribute('data-catalog-offer') === id);
const aiInput = (panel) => panel.findAll('input').find((node) => String(node.getAttribute('class') ?? '').includes('bo-composer-ai-input'));

test('the offer window opens over the scheda with the customer, the AI row and the four facts', async () => {
  const { host, panel } = await open();
  assert.equal(panel.parentNode, host, 'it hangs off the view, like the composer');
  assert.equal(panel.getAttribute('data-offer-panel'), 'open');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.match(panel.textContent, /Nuova offerta · Guido Presti/);
  assert.ok(aiInput(panel), 'the AI row is there');
  for (const name of ['title', 'value', 'expiry', 'owner']) assert.ok(input(panel, name), `${name} field`);
  assert.equal(input(panel, 'owner').value, 'Elena Rinaldi', 'the referente defaults to the person writing');
  assert.match(panel.textContent, /Non viene inviata al cliente/);
});

test('catalog chips price the offer until a value is typed; tiered offers stay out', async () => {
  const { panel } = await open();
  assert.ok(chip(panel, 'pt10') && chip(panel, 'pt1') && chip(panel, 'prova'));
  assert.equal(chip(panel, 'tier'), undefined, 'a tiered price is never a chip');
  chip(panel, 'pt10').dispatch('click');
  assert.equal(chip(panel, 'pt10').getAttribute('aria-pressed'), 'true');
  assert.equal(input(panel, 'value').value, '350,00');
  chip(panel, 'pt1').dispatch('click');
  const qty = panel.findAll('input').find((node) => node.getAttribute('aria-label') === 'Quantità per PT singola');
  qty.value = '3';
  qty.dispatch('input');
  assert.equal(input(panel, 'value').value, '470,00', '350 + 3 × 40');
  assert.match(panel.textContent, /Totale prodotti 470/);
  input(panel, 'value').value = '400';
  input(panel, 'value').dispatch('input');
  chip(panel, 'prova').dispatch('click');
  assert.equal(input(panel, 'value').value, '400', 'a typed value is never overwritten by the total');
});

test('Compila fills the fields from one sentence, never creates, and Annulla puts them back', async () => {
  const client = fakeClient({ draft: { title: 'Pacchetto 10 PT', valueCents: 32000, currency: 'EUR', expectedCloseDate: '2026-11-30', catalogOfferIds: ['pt10'] } });
  const { panel } = await open({ client });
  input(panel, 'title').value = 'Bozza mia';
  aiInput(panel).value = '10 PT scontato a 320, valido fino a fine mese';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  assert.deepEqual(client.drafts()[0].body, { spaceId: 'presti', resource: 'contact', id: 'c1', prompt: '10 PT scontato a 320, valido fino a fine mese' });
  assert.equal(input(panel, 'title').value, 'Pacchetto 10 PT');
  assert.equal(input(panel, 'value').value, '320,00', 'the AI value wins over the chip total');
  assert.equal(input(panel, 'expiry').value, '2026-11-30');
  assert.equal(chip(panel, 'pt10').getAttribute('aria-pressed'), 'true', 'the named catalog offer is chosen');
  assert.equal(byAction(panel, 'offer-ai-fill').textContent, 'Ricompila');
  assert.match(panel.textContent, /controlla i campi prima di creare/);
  assert.equal(client.creates().length, 0, 'the AI never creates the offer');

  byAction(panel, 'offer-ai-undo').dispatch('click');
  assert.equal(input(panel, 'title').value, 'Bozza mia');
  assert.equal(input(panel, 'value').value, '');
  assert.equal(input(panel, 'expiry').value, '');
  assert.equal(chip(panel, 'pt10').getAttribute('aria-pressed'), 'false');
});

test('an empty sentence asks for words and sends nothing', async () => {
  const client = fakeClient({ draft: { title: 'x' } });
  const { panel } = await open({ client });
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  assert.equal(client.drafts().length, 0);
  assert.match(panel.textContent, /Descrivi l’offerta in una frase/);
});

test('AI off, no key or no route turns the row into one honest line and the fields stay', async () => {
  const cases = [
    [Object.assign(new Error('off'), { status: 503, code: 'LLM_SPACE_DISABLED' }), /non è attiva in questo spazio/],
    [Object.assign(new Error('key'), { status: 503, code: 'LLM_SECRET_UNAVAILABLE' }), /non è ancora configurata/],
    [Object.assign(new Error('Not Found'), { status: 404 }), /non è ancora disponibile qui/],
  ];
  for (const [error, sentence] of cases) {
    const { panel } = await open({ client: fakeClient({ draft: error }) });
    aiInput(panel).value = 'scrivi tu';
    const logged = [];
    const realError = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      byAction(panel, 'offer-ai-fill').dispatch('click');
      await flush();
    } finally {
      console.error = realError;
    }
    assert.equal(logged.length, 1, 'one line for the operator');
    assert.deepEqual(Object.keys(logged[0][1]).sort(), ['code', 'spaceId', 'status']);
    assert.ok(!JSON.stringify(logged).includes('scrivi tu'), 'the prompt never reaches the log');
    assert.match(panel.textContent, sentence);
    assert.equal(byAction(panel, 'offer-ai-fill'), undefined, 'no dead Compila stays');
    assert.ok(input(panel, 'title'), 'the fields stay for writing by hand');
    assert.ok(!panel.textContent.includes('LLM_'), 'no code on screen');
  }
});

test('without a space the AI row is not offered, the form still works', async () => {
  const { panel } = await open({ spaceId: null });
  assert.equal(aiInput(panel), undefined);
  assert.ok(input(panel, 'title'));
});

test('Crea offerta files one offer under the company with the contact, then closes and re-reads', async () => {
  const { host, panel, client, toasts, created } = await open();
  input(panel, 'title').value = 'Pacchetto 10 PT';
  input(panel, 'value').value = '350,5';
  input(panel, 'expiry').value = '2026-11-30';
  byAction(panel, 'offer-create').dispatch('click');
  byAction(panel, 'offer-create').dispatch('click');
  await flush();
  assert.equal(client.creates().length, 1, 'a double click files one offer');
  assert.deepEqual(client.creates()[0].body, {
    companyId: 'co1', contactId: 'c1', name: 'Pacchetto 10 PT', valueCents: 35050,
    currency: 'EUR', expectedCloseDate: '2026-11-30', owner: 'Elena Rinaldi',
  });
  assert.equal(client.creates()[0].key, 'key-1', 'the window owns its submission key');
  assert.equal(panel.parentNode, null, 'the window closes');
  assert.ok(!host.findAll('div').some((node) => node.getAttribute('data-offer-panel') === 'open'));
  assert.deepEqual(toasts, ['Offerta creata']);
  assert.equal(created.length, 1, 'the scheda re-reads to show the new offer');
});

test('an uncertain failure keeps the key for the retry; a refusal frees it', async () => {
  const outcomes = [
    () => { throw Object.assign(new Error('gateway'), { status: 502 }); },
    () => { throw Object.assign(new Error('bad'), { status: 400, code: 'VALIDATION_ERROR' }); },
    () => ({ id: 'o1' }),
  ];
  const client = fakeClient({ create: (n) => outcomes[n - 1]() });
  const { panel } = await open({ client });
  input(panel, 'title').value = 'Offerta';
  input(panel, 'value').value = '10';
  byAction(panel, 'offer-create').dispatch('click');
  await flush();
  assert.match(panel.textContent, /non verrà creata due volte/);
  byAction(panel, 'offer-create').dispatch('click');
  await flush();
  byAction(panel, 'offer-create').dispatch('click');
  await flush();
  assert.deepEqual(client.creates().map((call) => call.key), ['key-1', 'key-1', 'key-2'],
    'the 502 retry reuses the key, the corrected offer after a 400 gets a new one');
});

test('missing facts read in Italian next to their field and nothing is sent', async () => {
  const client = fakeClient({ profile: {} });
  const { panel } = await open({ client });
  byAction(panel, 'offer-create').dispatch('click');
  await flush();
  assert.equal(client.creates().length, 0);
  assert.match(panel.textContent, /Scrivi il titolo\./);
  assert.match(panel.textContent, /Scrivi il valore in euro/);
  assert.match(panel.textContent, /Scrivi chi la segue\./);
});

test('without a company the window says what to do and offers no form', async () => {
  const { panel, client } = await open({ company: null });
  assert.match(panel.textContent, /deve avere un’azienda/);
  assert.equal(input(panel, 'title'), undefined);
  assert.equal(client.calls.length, 0, 'nothing is read for a form that cannot be sent');
});

test('✕ closes the window; a hostile name stays text', async () => {
  const doc = createFakeDocument();
  const host = createMount();
  const panel = openOfferPanel({
    doc, host, client: fakeClient(), issueKey: () => 'k', card: { name: '<img src=x onerror=alert(1)>' },
    navCtx: { resource: 'contact', id: 'c1' }, company: { id: 'co1', name: 'X' }, spaceId: 'presti',
  });
  assert.match(panel.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(panel.findAll('img').length, 0);
  byAction(panel, 'offer-close').dispatch('click');
  assert.equal(panel.parentNode, null);
});

test('euroToCents reads plain and Italian euro amounts only', () => {
  assert.equal(euroToCents('350'), 35000);
  assert.equal(euroToCents('350,5'), 35050);
  assert.equal(euroToCents(' 12.30 '), 1230);
  assert.equal(euroToCents('1.250,00'), 125000, 'the Italian form the field shows reads back');
  assert.equal(euroToCents('1.250'), null, 'a dotted thousand without a comma stays ambiguous');
  assert.equal(euroToCents('-5'), null);
  assert.equal(euroToCents(''), null);
});

// Review #616 (P1): the AI value keeps the currency the AI drafted it in.
test('review #616: an AI value in USD files the offer in USD; EUR chips chosen before never relabel it', async () => {
  const client = fakeClient({ draft: { title: 'Pacchetto US', valueCents: 32000, currency: 'usd' } });
  const { panel } = await open({ client });
  aiInput(panel).value = 'pacchetto a 320 dollari';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  assert.match(panel.textContent, /Valore \(USD\)/, 'the value names its currency');
  await panel.__submit();
  assert.equal(client.creates()[0].body.currency, 'USD', 'never EUR by default over the AI currency');
  assert.equal(client.creates()[0].body.valueCents, 32000);

  const second = fakeClient({ draft: { title: 'Pacchetto', valueCents: 32000, currency: 'USD' } });
  const other = await open({ client: second });
  chip(other.panel, 'pt10').dispatch('click');
  aiInput(other.panel).value = 'pacchetto a 320';
  byAction(other.panel, 'offer-ai-fill').dispatch('click');
  await flush();
  await other.panel.__submit();
  // Review #616 round 3: USD 320 under EUR chips is a mismatch, said and
  // never filed as EUR 320.
  assert.equal(second.creates().length, 0, 'nothing is filed under the wrong currency');
  assert.match(other.panel.textContent, /Il valore è in USD, i prodotti scelti in EUR/);
});

// Review #616 round 3 (P1): EUR chips pressed after an AI value in USD.
test('review #616 round 3: an AI USD value is never filed as EUR after an EUR chip is pressed', async () => {
  const client = fakeClient({ draft: { title: 'Pacchetto US', valueCents: 32000, currency: 'USD' } });
  const { panel } = await open({ client });
  aiInput(panel).value = 'pacchetto a 320 dollari';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  chip(panel, 'pt10').dispatch('click');
  assert.equal(input(panel, 'value').value, '320,00', 'the AI value stays');
  await panel.__submit();
  assert.equal(client.creates().length, 0, 'USD 320 is never filed as EUR 320');
  assert.match(panel.textContent, /Il valore è in USD, i prodotti scelti in EUR/);

  // Emptying the value lets the chips price it, in their own currency.
  input(panel, 'value').value = '';
  input(panel, 'value').dispatch('input');
  assert.equal(input(panel, 'value').value, '350,00');
  assert.match(panel.textContent, /Valore \(€\)/);
  await panel.__submit();
  assert.equal(client.creates().length, 1);
  assert.equal(client.creates()[0].body.currency, 'EUR');
  assert.equal(client.creates()[0].body.valueCents, 35000);
});

// Review #616 round 3 (P2): Crea offerta waits for the AI's catalog choice.
test('review #616 round 3: Crea offerta waits while the AI-chosen offers wait for the catalog', async () => {
  let release;
  const held = new Promise((resolve) => { release = () => resolve(CATALOG); });
  const client = fakeClient({ catalog: held, draft: { title: 'Pacchetto 10 PT', catalogOfferIds: ['pt10'] } });
  const { panel } = await open({ client });
  input(panel, 'owner').value = 'Elena';
  aiInput(panel).value = 'il pacchetto da 10';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  assert.equal(byAction(panel, 'offer-create').getAttribute('disabled'), 'disabled', 'Crea offerta waits');
  assert.match(panel.textContent, /aspetto il catalogo/);
  await panel.__submit();
  assert.equal(client.creates().length, 0, 'nothing is filed before the selection settles');

  release();
  await flush();
  assert.equal(byAction(panel, 'offer-create').getAttribute('disabled'), null, 'Crea offerta is back');
  assert.match(panel.textContent, /Compilata dall’AI: controlla i campi/);
  await panel.__submit();
  assert.equal(client.creates().length, 1);
  assert.equal(client.creates()[0].body.valueCents, 35000, 'priced by the chip the AI chose');
});

test('review #616: Annulla after an AI currency puts the euro back', async () => {
  const client = fakeClient({ draft: { valueCents: 32000, currency: 'USD' } });
  const { panel } = await open({ client });
  aiInput(panel).value = '320 dollari';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  byAction(panel, 'offer-ai-undo').dispatch('click');
  assert.match(panel.textContent, /Valore \(€\)/);
  input(panel, 'title').value = 'A mano';
  input(panel, 'value').value = '100';
  await panel.__submit();
  assert.equal(client.creates()[0].body.currency, 'EUR');
});

// Review #616 (P2): Compila answering before the catalog never loses the
// offers the AI chose.
test('review #616: AI-chosen offers wait for a slow catalog, then are pressed and priced', async () => {
  let release;
  const held = new Promise((resolve) => { release = () => resolve(CATALOG); });
  const client = fakeClient({ catalog: held, draft: { title: 'Pacchetto 10 PT', catalogOfferIds: ['pt10'] } });
  const { panel } = await open({ client });
  assert.equal(chip(panel, 'pt10'), undefined, 'the catalog is still loading');
  aiInput(panel).value = 'il pacchetto da 10';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  release();
  await flush();
  assert.equal(chip(panel, 'pt10').getAttribute('aria-pressed'), 'true', 'the AI choice lands once the chips exist');
  assert.equal(input(panel, 'value').value, '350,00', 'and prices the offer');
});

test('review #616: AI-chosen offers the catalog does not have are said, never claimed as filled', async () => {
  const client = fakeClient({ draft: { catalogOfferIds: ['ghost'] } });
  const { panel } = await open({ client });
  input(panel, 'value').value = '200';
  input(panel, 'value').dispatch('input');
  aiInput(panel).value = 'il prodotto fantasma';
  byAction(panel, 'offer-ai-fill').dispatch('click');
  await flush();
  assert.doesNotMatch(panel.textContent, /Compilata dall’AI: controlla/);
  assert.match(panel.textContent, /non ha trovato cosa compilare/);
  chip(panel, 'prova').dispatch('click');
  assert.equal(input(panel, 'value').value, '200', 'the typed value is still the person’s');
});

// Review #616 (P3): an undefined company blocks like null.
test('review #616: a customer whose company is undefined gets the honest block, no form', async () => {
  const doc = createFakeDocument();
  const host = createMount();
  const panel = openOfferPanel({
    doc, host, client: fakeClient(), issueKey: () => 'k', card: { name: 'Guido' },
    navCtx: { resource: 'contact', id: 'c1' }, company: undefined, spaceId: 'presti',
  });
  assert.match(panel.textContent, /deve avere un’azienda/);
  assert.equal(panel.findAll('input').length, 0);
});

// Review #616 round 4 (P1): a create that fails after the window was
// closed is logged and told as a toast, never swallowed.
test('review #616 round 4: a create failing after the window closed is logged and toasted', async () => {
  let fail;
  const pending = new Promise((_resolve, reject) => { fail = () => reject(Object.assign(new Error('bad gateway'), { status: 502, code: 'UPSTREAM' })); });
  const client = fakeClient({ create: () => pending });
  const { panel, toasts, created } = await open({ client });
  input(panel, 'title').value = 'Pacchetto 10 PT';
  input(panel, 'value').value = '350';
  const submitting = panel.__submit();
  byAction(panel, 'offer-close').dispatch('click');
  assert.equal(panel.parentNode, null, 'the window is closed while the create is in flight');

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    fail();
    await submitting;
  } finally {
    console.error = original;
  }
  assert.deepEqual(toasts, ['Offerta non creata: riapri «Nuova offerta» e riprova.'], 'the person learns it was not filed');
  assert.equal(created.length, 0);
  assert.equal(logged.length, 1, 'the failure is logged');
  assert.equal(logged[0][0], '[bo] offerta non creata');
  assert.deepEqual(logged[0][1], { code: 'UPSTREAM', status: 502, spaceId: 'presti' });
  assert.ok(!JSON.stringify(logged).includes('Pacchetto'), 'never the offer itself');
});

// Review #616 round 5 (P1): an invalid per-unit quantity blocks Crea
// offerta, like the total line already says, instead of filing the value
// left from before.
test('review #616 round 5: an invalid quantity blocks Crea offerta with the quantity sentence', async () => {
  const client = fakeClient();
  const { panel } = await open({ client });
  input(panel, 'title').value = 'PT singole';
  chip(panel, 'pt1').dispatch('click');
  assert.equal(input(panel, 'value').value, '40,00');
  const qty = panel.findAll('input').find((node) => node.getAttribute('aria-label') === 'Quantità per PT singola');
  for (const bad of ['0', '', '1.5']) {
    qty.value = bad;
    qty.dispatch('input');
    await panel.__submit();
    assert.equal(client.creates().length, 0, `quantity «${bad}» files nothing`);
    assert.match(panel.textContent, /Una quantità non è valida: scrivi un intero da 1 in su\./);
  }
  qty.value = '3';
  qty.dispatch('input');
  await panel.__submit();
  assert.equal(client.creates().length, 1);
  assert.equal(client.creates()[0].body.valueCents, 12000, '3 × 40');
});

// Backlog 0c9a27bb9ac0 (giro UX 11/11, punti 16-17): the products chosen in
// «Nuova offerta» become the quote of the offer, the title follows them,
// the amounts read in Italian and the placeholder reads as a hint.
test('backlog 0c9a27bb9ac0: the chosen products become the quote lines, priced by the server', async () => {
  const client = fakeClient();
  const { panel, toasts, created } = await open({ client });
  chip(panel, 'pt10').dispatch('click');
  chip(panel, 'pt1').dispatch('click');
  const qty = panel.findAll('input').find((node) => node.getAttribute('aria-label') === 'Quantità per PT singola');
  qty.value = '3';
  qty.dispatch('input');
  byAction(panel, 'offer-create').dispatch('click');
  await flush(12);
  assert.equal(client.creates().length, 1, 'one offer');
  const offerReads = client.calls.filter((call) => call.path.startsWith('/api/modules/offer/records/'));
  assert.deepEqual(offerReads.map((call) => call.path), ['/api/modules/offer/records/pt10', '/api/modules/offer/records/pt1'],
    'the price book is read from each offer record, never guessed');
  assert.equal(client.quotes().length, 1, 'one quote for one price book');
  assert.equal(client.quotes()[0].path, '/api/modules/opportunity/records/o1/actions/create-quote', 'on the new offer');
  assert.deepEqual(client.quotes()[0].body, { priceBookId: 'pb-eur' });
  assert.deepEqual(client.lines().map((call) => call.body), [
    { offerId: 'pt10', quantity: 1, expectedRevision: 1 },
    { offerId: 'pt1', quantity: 3, expectedRevision: 2 },
  ], 'only offer and quantity travel: the server prices each line');
  assert.ok(client.lines().every((call) => call.path === '/api/modules/quote/records/q1/actions/add-line'));
  const keys = [client.creates()[0].key, client.quotes()[0].key, ...client.lines().map((call) => call.key)];
  assert.equal(new Set(keys).size, keys.length, 'every write owns its own submission key');
  assert.ok(keys.every((key) => typeof key === 'string' && key !== ''));
  assert.equal(panel.parentNode, null, 'the window closes');
  assert.deepEqual(toasts, ['Offerta e preventivo creati']);
  assert.equal(created.length, 1, 'the scheda re-reads');
});

test('backlog 0c9a27bb9ac0: without products no quote is opened', async () => {
  const client = fakeClient();
  const { panel, toasts } = await open({ client });
  input(panel, 'title').value = 'Consulenza';
  input(panel, 'value').value = '100';
  byAction(panel, 'offer-create').dispatch('click');
  await flush(12);
  assert.equal(client.quotes().length, 0);
  assert.equal(client.lines().length, 0);
  assert.deepEqual(toasts, ['Offerta creata']);
});

test('backlog 0c9a27bb9ac0: products from two price books file two quotes, never a mismatched line', async () => {
  const client = fakeClient({ books: { pt10: 'pb-a', prova: 'pb-b' } });
  const { panel } = await open({ client });
  chip(panel, 'pt10').dispatch('click');
  chip(panel, 'prova').dispatch('click');
  await panel.__submit();
  await flush(12);
  assert.deepEqual(client.quotes().map((call) => call.body.priceBookId), ['pb-a', 'pb-b']);
  assert.deepEqual(client.lines().map((call) => [call.path.split('/')[5], call.body.offerId]), [['q1', 'pt10'], ['q2', 'prova']]);
});

function openWith(client) {
  const toasts = [];
  const created = [];
  const doc = createFakeDocument();
  const host = createMount();
  let keys = 0;
  const panel = openOfferPanel({
    doc, host, client, issueKey: () => `key-${(keys += 1)}`, card: { name: 'Guido Presti' },
    navCtx: { resource: 'contact', id: 'c1' }, company: { id: 'co1', name: 'X' }, spaceId: 'presti',
    toast: (text, error = false) => toasts.push({ text, error }),
    onCreated: (answer) => created.push(answer),
  });
  return { panel, toasts, created };
}

async function quietly(fn) {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return logged;
}

test('review #786: a refused quote keeps the window, the offer is never filed twice, Riprova completes it', async () => {
  let refuse = true;
  const client = fakeClient({ quoteFail: ({ path }) => (refuse && path.endsWith('/create-quote')
    ? Object.assign(new Error('refused'), { status: 409, code: 'PRICE_BOOK_INACTIVE' }) : null) });
  const { panel, toasts, created } = openWith(client);
  await flush();
  chip(panel, 'pt10').dispatch('click');
  const logged = await quietly(async () => { await panel.__submit(); await flush(12); });
  assert.equal(client.creates().length, 1);
  assert.notEqual(panel.parentNode, null, 'the window stays: the quote is still to do');
  assert.match(panel.textContent, /Offerta creata, ma il preventivo non si è salvato: riprova, oppure completalo dalla pagina dell’offerta\./);
  assert.equal(byAction(panel, 'offer-create').textContent, 'Riprova il preventivo');
  assert.equal(input(panel, 'title').getAttribute('disabled'), 'disabled', 'the filed offer keeps its fields');
  assert.equal(chip(panel, 'pt10').getAttribute('disabled'), 'disabled', 'and its products');
  const line = logged.find((args) => args[0] === '[bo] preventivo dell’offerta non creato');
  assert.deepEqual(Object.keys(line[1]).sort(), ['code', 'spaceId', 'status']);
  assert.deepEqual(toasts, []);
  refuse = false;
  await panel.__submit();
  await flush(12);
  assert.equal(client.creates().length, 1, 'Riprova never files the offer again');
  const quoteKeys = client.quotes().map((call) => call.key);
  assert.equal(quoteKeys.length, 2);
  assert.notEqual(quoteKeys[0], quoteKeys[1], 'a refusal created nothing: the retry is a new write');
  assert.equal(client.lines().length, 1);
  assert.equal(panel.parentNode, null);
  assert.deepEqual(toasts, [{ text: 'Offerta e preventivo creati', error: false }]);
  assert.equal(created.length, 1);
});

test('review #786: an uncertain answer is retried on the same key, never a second quote or line', async () => {
  for (const [label, fail] of [
    ['gateway on add-line', ({ path, n }) => (path.endsWith('/add-line') && n === 1 ? Object.assign(new Error('gateway'), { status: 502 }) : null)],
    ['queued create-quote', ({ path, n }) => (path.endsWith('/create-quote') && n === 1 ? Object.assign(new Error('queued'), { code: 'BO_CRM_PENDING', status: 504 }) : null)],
  ]) {
    const client = fakeClient({ quoteFail: fail });
    const { panel, toasts } = openWith(client);
    await flush();
    chip(panel, 'pt10').dispatch('click');
    await quietly(async () => { await panel.__submit(); await flush(12); });
    assert.match(panel.textContent, /Il preventivo non ha ancora risposto: premi «Riprova il preventivo», non ne verrà creato un secondo\./, label);
    assert.doesNotMatch(panel.textContent, /Crea preventivo/, `${label}: never an invitation to open another quote`);
    await panel.__submit();
    await flush(12);
    const step = label.includes('add-line') ? client.lines() : client.quotes();
    assert.equal(step.length, 2, label);
    assert.equal(step[0].key, step[1].key, `${label}: the same key replays the same write`);
    assert.deepEqual(step[0].body, step[1].body, `${label}: with the same body`);
    if (label.includes('add-line')) assert.equal(client.quotes().length, 1, 'the quote that answered is not opened again');
    assert.deepEqual(toasts, [{ text: 'Offerta e preventivo creati', error: false }], label);
  }
});

test('review #786: closing an incomplete quote says what is left — and an uncertain one never says «Crea preventivo»', async () => {
  const cases = [
    ['uncertain', ({ path }) => (path.endsWith('/create-quote') ? Object.assign(new Error('gateway'), { status: 502 }) : null),
      { text: 'Offerta creata. Il preventivo potrebbe essere già salvato: apri l’offerta e controlla prima di crearne un altro.', error: false }],
    ['refused, no quote', ({ path }) => (path.endsWith('/create-quote') ? Object.assign(new Error('refused'), { status: 409 }) : null),
      { text: 'Offerta creata, ma il preventivo non si è salvato: apri l’offerta e premi «Crea preventivo».', error: true }],
    ['refused line, quote opened', ({ path }) => (path.endsWith('/add-line') ? Object.assign(new Error('refused'), { status: 409 }) : null),
      { text: 'Offerta creata, ma il preventivo è incompleto: apri l’offerta, poi il preventivo, e aggiungi le righe.', error: true }],
  ];
  for (const [label, fail, toast] of cases) {
    const client = fakeClient({ quoteFail: fail });
    const { panel, toasts, created } = openWith(client);
    await flush();
    chip(panel, 'pt10').dispatch('click');
    await quietly(async () => { await panel.__submit(); await flush(12); });
    assert.deepEqual(toasts, [], `${label}: nothing said while the window shows it`);
    byAction(panel, 'offer-close').dispatch('click');
    assert.equal(panel.parentNode, null);
    assert.deepEqual(toasts, [toast], label);
    assert.equal(created.length, 1, `${label}: the scheda re-reads the new offer`);
  }
});

test('review #786: the quote files the quantities validated at Crea offerta, never a later edit', async () => {
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const client = fakeClient({ create: () => held.then(() => ({ id: 'o1' })) });
  const { panel } = openWith(client);
  await flush();
  chip(panel, 'pt1').dispatch('click');
  const qty = panel.findAll('input').find((node) => node.getAttribute('aria-label') === 'Quantità per PT singola');
  qty.value = '2';
  qty.dispatch('input');
  const pending = panel.__submit();
  await flush();
  assert.equal(qty.getAttribute('disabled'), 'disabled', 'the quantity is locked while the offer is filed');
  assert.equal(chip(panel, 'pt1').getAttribute('disabled'), 'disabled');
  qty.value = '20';
  qty.dispatch('input');
  release();
  await pending;
  await flush(12);
  assert.equal(client.creates()[0].body.valueCents, 8000);
  assert.deepEqual(client.lines().map((call) => call.body.quantity), [2], 'the line is the snapshot');
});

test('backlog 0c9a27bb9ac0: the chosen product writes the title; a typed title is never overwritten', async () => {
  const { panel } = await open();
  chip(panel, 'pt10').dispatch('click');
  assert.equal(input(panel, 'title').value, 'Pacchetto 10 PT', 'one product names the offer');
  chip(panel, 'prova').dispatch('click');
  assert.equal(input(panel, 'title').value, 'Pacchetto 10 PT e un altro prodotto');
  chip(panel, 'pt1').dispatch('click');
  assert.equal(input(panel, 'title').value, 'Pacchetto 10 PT e altri 2 prodotti');
  chip(panel, 'pt1').dispatch('click');
  chip(panel, 'prova').dispatch('click');
  chip(panel, 'pt10').dispatch('click');
  assert.equal(input(panel, 'title').value, '', 'no product, no title of theirs left behind');
  input(panel, 'title').value = 'Pacchetto estate';
  chip(panel, 'pt10').dispatch('click');
  assert.equal(input(panel, 'title').value, 'Pacchetto estate', 'what the person typed stays');
});

test('backlog 0c9a27bb9ac0: amounts read in Italian — «15,00», «1.250,00» — and file the right cents', async () => {
  const big = { products: [{ name: 'Annuale', offers: [{ offerId: 'year', name: 'Abbonamento annuale', active: true, currency: 'EUR', components: [{ pricingModel: 'flat_fee', flatAmountCents: 125000 }] }] }, ...CATALOG.products] };
  const client = fakeClient({ catalog: big, books: { ...BOOKS, year: 'pb-eur' } });
  const { panel } = await open({ client });
  assert.equal(input(panel, 'value').getAttribute('placeholder'), '350,00');
  chip(panel, 'prova').dispatch('click');
  assert.equal(input(panel, 'value').value, '15,00', 'never «15.00»');
  chip(panel, 'prova').dispatch('click');
  chip(panel, 'year').dispatch('click');
  assert.equal(input(panel, 'value').value, '1.250,00');
  await panel.__submit();
  assert.equal(client.creates()[0].body.valueCents, 125000);
  const other = await open();
  input(other.panel, 'title').value = 'X';
  input(other.panel, 'value').value = 'abc';
  await other.panel.__submit();
  assert.match(other.panel.textContent, /Scrivi il valore in euro, es\. 350,00\./);
});

test('backlog 0c9a27bb9ac0: the field placeholder is a light hint, not a value', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const rule = /\.bo-scheda-composer \.bo-offer-input::placeholder\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the offer fields own a placeholder rule');
  const opacity = /opacity:\s*([0-9.]+)/.exec(rule[1]);
  assert.ok(opacity && Number(opacity[1]) <= 0.6, 'lighter than a typed value (var(--dim) alone reads as ink)');
});
