import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 6740cea450b7, seguito di khaoss85/agent-crm#1098 (messa live, prova
 * del Mac del 20/11 sul live f574fb4): la virgola decimale va, restano tre
 * punti dell'owner answer 20/11 12:3xZ. (1) «esempio.invalid» compare due
 * volte nel menu Cliente: e un dominio di prova, va escluso dal menu.
 * (2) Le caselle dei prodotti stanno su una riga loro invece che accanto
 * all'etichetta. (3) Il cliente «Prova verifica 40 NoteInvio» non si trova
 * nel menu: menu e referenti sono ordinati per nome cosi un nome con un
 * numero sta in posizione prevedibile. Ogni test qui e rosso sul codice
 * prima della cura e verde dopo.
 */

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function stubClient({ companies, contactsByCompany, products }) {
  return {
    async request(path) {
      if (path.startsWith('/api/companies')) return { items: companies };
      if (path.startsWith('/api/contacts')) {
        const found = String(path).match(/[?&]companyId=([^&]*)/);
        const companyId = found ? decodeURIComponent(found[1]) : '';
        return { items: (contactsByCompany ?? {})[companyId] ?? [] };
      }
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

async function renderOfferForm({ companies, contactsByCompany, products }) {
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc,
    mount,
    client: stubClient({ companies, contactsByCompany, products }),
    navigate: () => {},
    storage: memoryStorage(),
  });
  const form = await admin.renderNew('opportunity');
  return { doc, mount, form };
}

function companyOptions(mount) {
  const companySelect = mount.findAll('select').find((node) => node.getAttribute('name') === 'company');
  assert.ok(companySelect, 'the Cliente menu exists');
  return companySelect.childNodes.map((node) => ({
    value: node.getAttribute('value'),
    text: node.textContent,
  }));
}

const PRICED_OFFER = {
  offerId: 'off-10-ingressi',
  name: '10 ingressi',
  active: true,
  currency: 'EUR',
  components: [{ pricingModel: 'flat_fee', flatAmountCents: 25000 }],
};

test('6740cea450b7/segue-1098: i domini di prova non compaiono nel menu Cliente', async () => {
  const { mount } = await renderOfferForm({
    // Caso live del 20/11: due righe «esempio.invalid» con id diversi.
    companies: [
      { id: '64c17e8a-1111', name: 'esempio.invalid' },
      { id: 'b2b1494c-2222', name: 'esempio.invalid' },
      { id: 'c-presti', name: 'Presti Group' },
    ],
    contactsByCompany: {},
    products: null,
  });
  const options = companyOptions(mount);
  assert.deepEqual(options.map((option) => option.text), ['Presti Group']);
});

test('6740cea450b7/segue-1098: lo stesso nome visibile compare una sola volta', async () => {
  const { mount } = await renderOfferForm({
    companies: [
      { id: 'id-a', name: 'Presti Group' },
      { id: 'id-b', name: 'presti group' },
    ],
    contactsByCompany: {},
    products: null,
  });
  const options = companyOptions(mount);
  assert.equal(options.length, 1, 'one row for one visible name');
  assert.equal(options[0].text, 'Presti Group');
});

test('6740cea450b7/segue-1098: il menu Cliente e ordinato per nome', async () => {
  const { mount } = await renderOfferForm({
    companies: [
      { id: 'c-z', name: 'Zeta Srl' },
      { id: 'c-o', name: 'Officina 40' },
      { id: 'c-a', name: 'Alfa Snc' },
    ],
    contactsByCompany: {},
    products: null,
  });
  const options = companyOptions(mount);
  assert.deepEqual(options.map((option) => option.text), ['Alfa Snc', 'Officina 40', 'Zeta Srl']);
});

test('6740cea450b7/segue-1098: la casella sta accanto al testo, non su una riga sua', async () => {
  const { mount } = await renderOfferForm({
    companies: [{ id: 'c1', name: 'Palestra Esempio' }],
    contactsByCompany: {},
    products: [{ name: 'Pacchetto', offers: [PRICED_OFFER] }],
  });
  const boxes = mount.findAll('input').filter((node) => node.getAttribute('type') === 'checkbox');
  assert.ok(boxes.length > 0, 'at least one product checkbox is shown');
  for (const box of boxes) {
    assert.equal(box.parentNode?.tagName, 'LABEL', 'the checkbox lives inside its label');
    const labelStyle = String(box.parentNode?.getAttribute('style') ?? '');
    assert.ok(
      labelStyle.includes('inline-flex') || labelStyle.includes('inline flex') || labelStyle.replace(/\s+/g, '').includes('display:flex'),
      `the label keeps box and text on one row: «${labelStyle}»`,
    );
    const boxStyle = String(box.getAttribute('style') ?? '').replace(/\s+/g, '');
    assert.ok(
      boxStyle.includes('width:auto') || boxStyle.includes('flex:none'),
      `the checkbox keeps its natural width: «${box.getAttribute('style') ?? ''}»`,
    );
  }
});

test('6740cea450b7/segue-1098: un referente con numero nel nome si trova in lista', async () => {
  const { mount, form } = await renderOfferForm({
    companies: [{ id: 'c1', name: 'Presti Group' }],
    contactsByCompany: {
      c1: [
        { id: 'k-z', firstName: 'Zeno', lastName: 'Rossi', email: 'zeno@esempio.it' },
        { id: 'k-40', firstName: 'Prova verifica 40 NoteInvio', lastName: '', email: 'prova40@esempio.it' },
        { id: 'k-m', firstName: 'Marco', lastName: 'Bianchi', email: 'marco@esempio.it' },
      ],
    },
    products: null,
  });
  form.__inputs.company.value = 'c1';
  const companySelect = mount.findAll('select').find((node) => node.getAttribute('name') === 'company');
  assert.ok(companySelect, 'the Cliente menu exists');
  companySelect.dispatch('change');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const contactSelect = mount.findAll('select').find((node) => node.getAttribute('name') === 'contact');
  assert.ok(contactSelect, 'the Referente list exists');
  const labels = contactSelect.childNodes.map((node) => node.textContent);
  assert.ok(
    labels.some((label) => label.includes('Prova verifica 40 NoteInvio')),
    `the numbered contact is listed: «${labels.join(' | ')}»`,
  );
  assert.deepEqual(labels, [
    'Nessun referente specifico',
    'Marco Bianchi',
    'Prova verifica 40 NoteInvio',
    'Zeno Rossi',
  ]);
});
