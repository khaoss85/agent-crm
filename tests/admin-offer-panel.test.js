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

function fakeClient({ draft = null, create = null, catalog = CATALOG, profile = { member: { name: 'Elena Rinaldi' } } } = {}) {
  const calls = [];
  return {
    calls,
    drafts: () => calls.filter((call) => call.path === '/api/customer-hub/offers/draft'),
    creates: () => calls.filter((call) => call.path === '/api/opportunities'),
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
  assert.equal(input(panel, 'value').value, '350.00');
  chip(panel, 'pt1').dispatch('click');
  const qty = panel.findAll('input').find((node) => node.getAttribute('aria-label') === 'Quantità per PT singola');
  qty.value = '3';
  qty.dispatch('input');
  assert.equal(input(panel, 'value').value, '470.00', '350 + 3 × 40');
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
  assert.equal(input(panel, 'value').value, '320.00', 'the AI value wins over the chip total');
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

test('euroToCents reads plain euro amounts only', () => {
  assert.equal(euroToCents('350'), 35000);
  assert.equal(euroToCents('350,5'), 35050);
  assert.equal(euroToCents(' 12.30 '), 1230);
  assert.equal(euroToCents('1.250,00'), null);
  assert.equal(euroToCents('-5'), null);
  assert.equal(euroToCents(''), null);
});
