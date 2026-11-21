import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 6740cea450b7 («Nuova offerta › Compila manualmente», prova del Mac
 * del 17/11 sul live): tre difetti nella schermata di creazione offerta.
 * (1) il segnaposto «es. 250.00» usa il punto decimale, in italiano è
 * «es. 250,00»; (2) lo stesso cliente compare due volte nel menu Cliente;
 * (3) le caselle dei prodotti sono staccate dalle loro etichette. Il test
 * rende osservabile ogni criterio: fallisce sul codice prima della cura,
 * passa dopo.
 */

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function stubClient({ companies, products }) {
  return {
    async request(path) {
      if (path.startsWith('/api/companies')) return { items: companies };
      if (path.startsWith('/api/contacts')) return { items: [] };
      if (path.startsWith('/api/catalog/products')) {
        if (products === null) {
          const error = new Error('no catalog in this space');
          error.status = 404;
          throw error;
        }
        return { products };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

async function renderOfferForm({ companies, products }) {
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc,
    mount,
    client: stubClient({ companies, products }),
    navigate: () => {},
    storage: memoryStorage(),
  });
  const form = await admin.renderNew('opportunity');
  return { doc, mount, form };
}

const PRICED_OFFER = {
  offerId: 'off-10-ingressi',
  name: '10 ingressi',
  active: true,
  currency: 'EUR',
  components: [{ pricingModel: 'flat_fee', flatAmountCents: 25000 }],
};

test('6740cea450b7: il segnaposto del Valore usa la virgola decimale', async () => {
  const { mount } = await renderOfferForm({
    companies: [{ id: 'c1', name: 'Palestra Esempio' }],
    products: null,
  });
  const valueInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'value');
  assert.ok(valueInput, 'the Valore field exists');
  assert.equal(valueInput.getAttribute('placeholder'), 'es. 250,00');
});

test('6740cea450b7: il messaggio di errore del Valore usa la virgola decimale', async () => {
  const { mount, form } = await renderOfferForm({
    companies: [{ id: 'c1', name: 'Palestra Esempio' }],
    products: null,
  });
  form.__inputs.company.value = 'c1';
  form.__inputs.title.value = 'Pacchetto 10 ingressi';
  form.__inputs.owner.value = 'Guido';
  form.__inputs.value.value = 'tanto';
  await form.__submit({ preventDefault() {} });
  const shown = mount.findAll('small')
    .map((node) => node.textContent)
    .find((text) => text.includes('es.'));
  assert.ok(shown, 'a value error naming the example is shown');
  assert.ok(shown.includes('250,00'), `the error uses the comma: «${shown}»`);
  assert.ok(!shown.includes('250.00'), `no dotted decimal remains: «${shown}»`);
});

test('6740cea450b7: ogni cliente compare una sola volta nel menu', async () => {
  const { mount } = await renderOfferForm({
    companies: [
      { id: 'c9', name: 'esempio.invalid' },
      { id: 'c9', name: 'esempio.invalid' },
    ],
    products: null,
  });
  const companySelect = mount.findAll('select').find((node) => node.getAttribute('name') === 'company');
  assert.ok(companySelect, 'the Cliente menu exists');
  const dupes = companySelect.childNodes.filter((node) => node.getAttribute('value') === 'c9');
  assert.equal(dupes.length, 1, 'the same customer is listed once');
});

test('6740cea450b7: le caselle dei prodotti sono attaccate alle etichette', async () => {
  const { mount } = await renderOfferForm({
    companies: [{ id: 'c1', name: 'Palestra Esempio' }],
    products: [{ name: 'Pacchetto', offers: [PRICED_OFFER] },
    ],
  });
  const boxes = mount.findAll('input').filter((node) => node.getAttribute('type') === 'checkbox');
  assert.ok(boxes.length > 0, 'at least one product checkbox is shown');
  for (const box of boxes) {
    assert.equal(box.parentNode?.tagName, 'LABEL', 'the checkbox lives inside its label');
    assert.ok(
      String(box.parentNode?.textContent ?? '').includes('10 ingressi'),
      'the label names the offer beside its box',
    );
  }
});
