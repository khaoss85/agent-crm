// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:6e6750ff8163 (giro UX 11/11, punto 27) — il form «Nuovo
 * appuntamento» del Calendario:
 * - ogni campo ha la sua etichetta (cliente, persona, servizio, prezzo,
 *   giorno, inizio, fine, note), non solo un segnaposto;
 * - nessun servizio preselezionato quando il listino ne ha più d'uno (il
 *   primo era un prodotto di prova);
 * - il form sta in un posto solo: il popover sopra la griglia, mai anche
 *   nella colonna di sinistra;
 * - × ed Esc lo chiudono e lo svuotano;
 * - «Compila manualmente» lo apre e mette il focus sul primo campo, senza
 *   scorrere fino alla colonna;
 * - il segnaposto del cliente è corto e non si taglia.
 */

const CATALOG = {
  products: [
    { active: true, sku: 'prova-verifica', name: 'Prova verifica 07/11 B prodotto', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100 }] }] },
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
  ],
};

const ONE_SERVICE = { products: [CATALOG.products[1]] };

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [{
      id: 'a1', status: 'booked', startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
      serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'calendario:marco:1:c1',
      subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
    }],
  }],
};

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function stubClient({ catalog = CATALOG } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco', email: 'marco@example.com' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return catalog;
      // The framework on its own serves no bookable list (#805): the menu
      // falls back to the catalog singles.
      if (path === '/api/appointments/services') throw Object.assign(notFound(), { status: 404 });
      if (path.startsWith('/api/customer-data/customers')) return { items: [], complete: true };
      if (path.startsWith('/api/customer-data/')) throw notFound();
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openCalendar(options = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient(options), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  return { doc, mount };
}

const formPops = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
const isOpen = (pop) => pop.getAttribute('hidden') === null && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden');
const byName = (mount, name) => mount.findAll('input').concat(mount.findAll('select')).find((node) => node.getAttribute('name') === name);

function openManual(mount) {
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  toggle.dispatch('click');
  const voice = mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente'));
  voice.dispatch('click');
}

test('form: one form only, in the popover over the grid, never in the rail', async () => {
  const { mount } = await openCalendar();
  assert.equal(formPops(mount).length, 1, 'one form popover');
  assert.equal(mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-manual')).length, 1, 'one form');
  const rail = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-rail'));
  assert.ok(!rail.findAll('div').some((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-manual')), 'the rail holds no form');
  const main = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-main'));
  assert.ok(main.contains(formPops(mount)[0]), 'the form sits over the grid');
  assert.equal(isOpen(formPops(mount)[0]), false, 'closed until asked');
  assert.equal(mount.findAll('input').filter((node) => node.getAttribute('name') === 'date').length, 1, 'one Giorno field in the page');
});

test('form: «Compila manualmente» opens it at the top of the grid and focuses the customer, no scroll', async () => {
  const { mount } = await openCalendar();
  let scrolled = 0;
  const search = byName(mount, 'customerSearch');
  search.scrollIntoView = () => { scrolled += 1; };
  openManual(mount);
  const pop = formPops(mount)[0];
  assert.ok(isOpen(pop), 'the form opens');
  assert.equal(pop.getAttribute('data-anchor'), 'grid');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.equal(byName(mount, 'customerSearch').__focused, true, 'focus on the customer field');
  assert.equal(scrolled, 0, 'never a scroll to the rail');
});

test('form: every field carries its visible label', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const pop = formPops(mount)[0];
  const labelOf = (name) => {
    const field = byName(pop, name);
    let node = field;
    while (node && node.tagName !== 'LABEL') node = node.parentNode;
    return node ? node.findAll('span').find((span) => (span.getAttribute('class') ?? '').includes('cal-field-label'))?.textContent : null;
  };
  assert.equal(labelOf('customerSearch'), 'Cliente');
  assert.equal(labelOf('teamMemberId'), 'Persona del team');
  assert.equal(labelOf('serviceKey'), 'Servizio');
  assert.equal(labelOf('price'), 'Prezzo (€)');
  assert.equal(labelOf('date'), 'Giorno');
  assert.equal(labelOf('start'), 'Inizio');
  assert.equal(labelOf('end'), 'Fine');
  assert.equal(labelOf('notes'), 'Note');
});

test('form: the customer placeholder is short, the label says the rest', async () => {
  const { mount } = await openCalendar();
  const placeholder = byName(mount, 'customerSearch').getAttribute('placeholder');
  assert.equal(placeholder, 'Cerca per nome…');
  assert.ok(placeholder.length <= 16, 'short enough for the 340 px popover');
});

test('form: no service preselected with two services, the price waits for the choice', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const service = byName(mount, 'serviceKey');
  assert.equal(service.tagName, 'SELECT');
  assert.equal(service.value, '', 'never the first catalog entry (a test product)');
  assert.equal(service.findAll('option')[0].textContent, 'Scegli il servizio');
  assert.equal(byName(mount, 'price').value, '', 'no price for a service nobody chose');
  service.value = 'taglio';
  service.dispatch('change');
  assert.equal(byName(mount, 'price').value, '45.00');
});

test('form: a listino with one bookable service preselects it, like the scheda window', async () => {
  const { mount } = await openCalendar({ catalog: ONE_SERVICE });
  openManual(mount);
  assert.equal(byName(mount, 'serviceKey').value, 'taglio');
  assert.equal(byName(mount, 'price').value, '45.00');
});

test('form: Esc closes it and empties it — the next opening starts clean', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const fill = (name, value) => {
    const node = byName(mount, name);
    node.value = value;
    node.dispatch('input');
  };
  fill('date', '2026-10-22');
  fill('start', '10:00');
  fill('end', '10:30');
  fill('price', '12.00');
  fill('notes', 'porta il certificato');
  const service = byName(mount, 'serviceKey');
  service.value = 'taglio';
  service.dispatch('change');
  formPops(mount)[0].dispatch('keydown', { key: 'Escape' });
  assert.equal(isOpen(formPops(mount)[0]), false, 'Esc closes the form');
  openManual(mount);
  for (const name of ['date', 'start', 'end', 'price', 'notes']) {
    assert.equal(byName(mount, name).value, '', `${name} starts empty`);
  }
  assert.equal(byName(mount, 'serviceKey').value, '', 'the service starts unchosen');
});

test('form: × closes it and empties it too, and focus goes back to «Nuovo appuntamento»', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const date = byName(mount, 'date');
  date.value = '2026-10-23';
  date.dispatch('input');
  formPops(mount)[0].findAll('button').find((node) => node.getAttribute('data-action') === 'manual-close').dispatch('click');
  assert.equal(isOpen(formPops(mount)[0]), false);
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  assert.equal(toggle.__focused, true, 'focus back on the button that opened it');
  openManual(mount);
  assert.equal(byName(mount, 'date').value, '');
});

test('form: a slot picked on the grid seats the same form beside it; Esc drops the slot too', async () => {
  const { mount } = await openCalendar();
  // The roster names Marco: his week loads on its own.
  const col = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'))[2];
  col.getBoundingClientRect = () => ({ top: 0, left: 0, right: 200, bottom: 360, height: 360, width: 200 });
  col.dispatch('pointerdown', { button: 0, clientY: 85, target: col, preventDefault() {} });
  col.dispatch('pointerup', { target: col });
  const pop = formPops(mount)[0];
  assert.ok(isOpen(pop));
  assert.equal(pop.getAttribute('data-anchor'), 'slot');
  assert.equal(formPops(mount).length, 1, 'still one form');
  assert.equal(byName(mount, 'start').value, '11:00');
  pop.dispatch('keydown', { key: 'Escape' });
  assert.equal(mount.findAll('div').find((node) => node.getAttribute('data-role') === 'slot-pick'), undefined, 'the pick leaves the grid');
  openManual(mount);
  assert.equal(byName(mount, 'start').value, '', 'the old slot never comes back');
  assert.equal(byName(mount, 'date').value, '');
});
