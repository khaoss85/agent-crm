// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, customerHint, customerMatchReason } from '../apps/admin/public/admin-calendario.js';
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

function stubClient({ catalog = CATALOG, customers = [] } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco', email: 'marco@example.com' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return catalog;
      // The framework on its own serves no bookable list (#805): the menu
      // falls back to the catalog singles.
      if (path === '/api/appointments/services') throw Object.assign(notFound(), { status: 404 });
      if (path.startsWith('/api/customer-data/customers')) return { items: customers, complete: true };
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
  // Review #790 (Muse P2): back on the placeholder, the price empties too.
  service.value = '';
  service.dispatch('change');
  assert.equal(byName(mount, 'price').value, '', 'no price for a service nobody chose any more');
  assert.equal(byName(mount, 'serviceKey').value, '');
});

test('form: a listino with one bookable service preselects it, like the scheda window', async () => {
  const { mount } = await openCalendar({ catalog: ONE_SERVICE });
  openManual(mount);
  assert.equal(byName(mount, 'serviceKey').value, 'taglio');
  assert.equal(byName(mount, 'price').value, '45.00');
});

test('form: Esc closes it and drops the typed values — the next opening proposes a day and time', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const fill = (name, value) => {
    const node = byName(mount, name);
    node.value = value;
    node.dispatch('input');
  };
  // A day away from the default proposal, so the reopen proves the reset.
  fill('date', '2026-10-24');
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
  // backlog:134f3ed7 — every opening proposes a day and a time (tomorrow
  // 09:30–10:00 here, now is 2026-10-21); the typed values never survive.
  assert.equal(byName(mount, 'date').value, '2026-10-22', 'the next opening proposes tomorrow');
  assert.equal(byName(mount, 'start').value, '09:30', 'the next opening proposes 09:30');
  assert.equal(byName(mount, 'end').value, '10:00', 'the next opening proposes 10:00');
  for (const name of ['price', 'notes']) {
    assert.equal(byName(mount, name).value, '', `${name} starts empty`);
  }
  assert.equal(byName(mount, 'serviceKey').value, '', 'the service starts unchosen');
});

test('form: × closes it and drops the typed day too, and focus goes back to «Nuovo appuntamento»', async () => {
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
  // backlog:134f3ed7 — every opening proposes a day and a time (tomorrow
  // 09:30 here); the typed 2026-10-23 never survives.
  assert.equal(byName(mount, 'date').value, '2026-10-22', 'the next opening proposes tomorrow');
  assert.equal(byName(mount, 'start').value, '09:30', 'the next opening proposes 09:30');
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
  // backlog:134f3ed7 — the old 11:00 slot never comes back; the manual
  // opening proposes tomorrow 09:30 instead of an empty form.
  assert.equal(byName(mount, 'start').value, '09:30', 'the old slot never comes back');
  assert.equal(byName(mount, 'date').value, '2026-10-22', 'the next opening proposes tomorrow');
});

// backlog:3582d91635cb: homonyms in the customer suggestions read apart.
test('form: two customers with the same name show a partial email or phone, a single one shows none', async () => {
  const customers = [
    { resource: 'contact', id: 'c1', name: 'Ada Rossi', email: 'ada.rossi@example.com', phone: null, company: null },
    { resource: 'contact', id: 'c2', name: 'Ada Rossi', email: null, phone: { value: '+393331234567', system: 'whatsapp' }, company: null },
    { resource: 'contact', id: 'c3', name: 'Bea Neri', email: 'bea@example.com', phone: null, company: null },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient({ customers }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'Ad';
  search.dispatch('input');
  await settle();
  const results = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');
  const labels = results.findAll('button').map((node) => node.textContent);
  assert.ok(labels.includes('Ada Rossi · ad…@example.com'), labels.join(' | '));
  assert.ok(labels.includes('Ada Rossi · tel. …4567'), labels.join(' | '));
  assert.ok(labels.includes('Bea Neri'), 'a name nobody shares carries no hint');
  assert.ok(!labels.some((text) => text.includes('ada.rossi@') || text.includes('3331234567')), 'never the whole address or number');
  // The pick still books the customer by id, with the bare name.
  results.findAll('button').find((node) => node.textContent.endsWith('tel. …4567')).dispatch('click');
  assert.ok(mount.findAll('p').some((node) => node.getAttribute('data-role') === 'customer-pick' && node.textContent === 'Ada Rossi'), 'the pick names the customer');
});

// backlog:f6b9d189 (production: «anna» listed Massimiliano Magrini with no
// visible reason — the match sat on his company, a field the form never
// shows): the suggestions keep only matches on the name, the email or the
// held phone, and a non-name match prints its field beside the name.
test('form: «anna» drops the company-only match and explains the rest', async () => {
  const customers = [
    {
      resource: 'contact', id: 'c-magrini', name: 'Massimiliano Magrini', email: 'massimiliano.magrini@example.it',
      phone: null, company: { name: 'Pizzeria Anna' }, searchMatch: ['company'],
    },
    {
      resource: 'contact', id: 'c-anna', name: 'Anna Bianchi', email: 'anna@example.it',
      phone: null, company: null, searchMatch: ['name', 'email'],
    },
    {
      resource: 'contact', id: 'c-mario', name: 'Mario Rossi', email: 'mario.rossi@example.it',
      phone: null, company: null, searchMatch: ['email'],
    },
    {
      resource: 'contact', id: 'c-ada', name: 'Ada Rossi', email: null,
      phone: { value: '+393331234567', system: 'whatsapp' }, company: null, searchMatch: ['phone'],
    },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient({ customers }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'anna';
  search.dispatch('input');
  await settle();
  const results = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');
  const labels = results.findAll('button').map((node) => node.textContent);
  assert.ok(!labels.some((text) => text.includes('Magrini')), `no company-only match: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Anna Bianchi'), `the name match stays bare: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Mario Rossi · ma…@example.it'), `the email match shows its field: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Ada Rossi · tel. …4567'), `the phone match shows its field: ${labels.join(' | ')}`);
  assert.ok(!labels.some((text) => text.includes('mario.rossi@') || text.includes('3331234567')), 'never the whole address or number');
});

test('form: only company matches read as no match, in plain words', async () => {
  const customers = [
    {
      resource: 'contact', id: 'c-magrini', name: 'Massimiliano Magrini', email: 'massimiliano.magrini@example.it',
      phone: null, company: { name: 'Pizzeria Anna' }, searchMatch: ['company'],
    },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient({ customers }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'anna';
  search.dispatch('input');
  await settle();
  const results = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');
  assert.equal(results.findAll('button').length, 0, 'nothing without a visible correspondence');
  assert.ok(results.textContent.includes('Nessun cliente corrisponde'), 'the empty match says so in plain words');
});

// Review #985 P2: a channel-only query reaches the form with an empty
// reason (the match sits on the channel, never on text) — the row already
// passed the channel filter, so it stays listed instead of reading as no
// match with a try-another-name empty state.
test('form: a channel-only query keeps the channel members listed', async () => {
  const customers = [
    {
      resource: 'contact', id: 'c-wa', name: 'Ada Rossi', email: null,
      phone: null, company: null, searchMatch: [],
    },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient({ customers }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'whatsapp';
  search.dispatch('input');
  await settle();
  const results = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');
  assert.equal(results.findAll('button').length, 1, 'the channel member stays listed');
  assert.ok(!results.textContent.includes('Prova con un altro nome'), 'no name-oriented empty state for a channel query');
});

test('form: customerMatchReason prints only the matched email or phone', () => {
  assert.equal(customerMatchReason({ email: 'mario.rossi@example.it' }, ['email']), 'ma…@example.it');
  assert.equal(customerMatchReason({ phone: { value: '+39 333 123 4567' } }, ['phone']), 'tel. …4567');
  assert.equal(customerMatchReason({ name: 'Ada Rossi' }, ['name']), null, 'a name match needs no reason');
  assert.equal(customerMatchReason({ company: { name: 'Pizzeria Anna' } }, ['company']), null, 'the company is never a reason in the form');
  assert.equal(customerMatchReason({ email: 'mario.rossi@example.it' }, null), null, 'no reason, no explanation');
});

test('form: customerHint prefers a partial email, then the phone, then the company', () => {
  assert.equal(customerHint({ email: 'ada@example.com' }), 'ad…@example.com');
  assert.equal(customerHint({ email: 'a@example.com' }), 'a…@example.com');
  assert.equal(customerHint({ email: null, phone: { value: '+39 333 123 4567' } }), 'tel. …4567');
  assert.equal(customerHint({ email: '', phone: null, company: { name: 'Palestra Uno' } }), 'Palestra Uno');
  assert.equal(customerHint({ email: 'rotta@', phone: { value: '12' } }), null);
});

// backlog:134f3ed7 (review giro 1 P2): closeManual() dropped the typed
// values but kept the typed marks, so the reopened form read its proposed
// date (tomorrow) as «written» and raised «Hai del testo non salvato».
test('form: a date typed then dropped by Esc is not unsaved text on reopen', async () => {
  const { hasUnsavedWork, resetVersionWatchState } = await import('../apps/admin/public/admin-version.js');
  resetVersionWatchState();
  const emptyPage = { querySelectorAll: () => [] };
  const { mount } = await openCalendar();
  openManual(mount);
  const date = byName(mount, 'date');
  date.value = '2026-10-24';
  date.dispatch('input');
  formPops(mount)[0].dispatch('keydown', { key: 'Escape' });
  assert.equal(isOpen(formPops(mount)[0]), false, 'Esc closes the form');
  openManual(mount);
  assert.equal(byName(mount, 'date').value, '2026-10-22', 'the next opening proposes tomorrow');
  assert.equal(hasUnsavedWork(emptyPage), false, 'the proposed date is nobody’s unsaved text');
  resetVersionWatchState();
});

// backlog:3582d91635cb (verifier return 1, 2026-11-13): the 2-char cure reads
// «pr…@example.com» for both «Prova Doppione 09/11» — red before, green now.
test('form: two «Prova Doppione 09/11» sharing the first email characters read apart in the suggestions', async () => {
  const customers = [
    { resource: 'contact', id: 'd1', name: 'Prova Doppione 09/11', email: 'prova.doppione.a@example.com', phone: null, company: null },
    { resource: 'contact', id: 'd2', name: 'Prova Doppione 09/11', email: 'prova.doppione.b@example.com', phone: null, company: null },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient({ customers }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'Doppione';
  search.dispatch('input');
  await settle();
  const results = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');
  const labels = results.findAll('button').map((node) => node.textContent);
  assert.equal(labels.length, 2, labels.join(' | '));
  assert.notEqual(labels[0], labels[1], `the two homonyms read apart: ${labels.join(' | ')}`);
  assert.ok(!labels.some((text) => text.includes('prova.doppione.a@') || text.includes('prova.doppione.b@')), `never the whole address: ${labels.join(' | ')}`);
});

test('form: customerHint stretches the prefix only past what a sibling homonym shares', () => {
  const first = { name: 'Prova Doppione 09/11', email: 'prova.doppione.a@example.com' };
  const second = { name: 'Prova Doppione 09/11', email: 'prova.doppione.b@example.com' };
  const hintFirst = customerHint(first, [first, second]);
  const hintSecond = customerHint(second, [first, second]);
  assert.ok(hintFirst !== null && hintSecond !== null, 'both homonyms carry a hint');
  assert.notEqual(hintFirst, hintSecond, `${hintFirst} vs ${hintSecond}`);
  const other = { name: 'Prova Doppione 09/11', email: 'guido@example.com' };
  assert.equal(customerHint(first, [first, other]), 'pr…@example.com', 'an unrelated address keeps the short prefix');
  const twin = { name: 'Prova Doppione 09/11', email: 'prova.doppione.a@example.com', phone: '+39 333 111 2222' };
  const same = { name: 'Prova Doppione 09/11', email: 'prova.doppione.a@example.com', phone: '+39 333 999 8888' };
  assert.equal(customerHint(twin, [twin, same]), 'tel. …2222', 'the very same address falls back to the phone');
});

// backlog:3582d91635cb (review P2 giro-3, 2026-11-13): homonyms show one
// distinguishing hint, not every signal joined.
test('form: customerHint returns one fallback hint for homonyms, never joined parts', () => {
  const first = {
    name: 'Mario Rossi', email: 'mario.rossi1@example.com',
    phone: '+39 333 111 2222', company: { name: 'Acme' },
  };
  const second = {
    name: 'Mario Rossi', email: 'mario.rossi2@example.com',
    phone: '+39 333 999 8888', company: { name: 'Beta' },
  };
  const hint = customerHint(first, [first, second]);
  assert.ok(hint !== null && !hint.includes(' · '), `a single hint, got: ${hint}`);
  assert.ok(hint.includes('@example.com'), `the email wins the fallback, got: ${hint}`);
  assert.ok(!hint.includes('2222') && !hint.includes('Acme'), `no phone or company joined, got: ${hint}`);
});

// backlog:3582d91635cb (review P2 giro-3, 2026-11-13): same local part on a
// different domain already reads apart through the domain.
test('form: customerHint keeps the short prefix when only the domain tells homonyms apart', () => {
  const first = { name: 'Mario Rossi', email: 'mario@example.com' };
  const second = { name: 'Mario Rossi', email: 'mario@other.com' };
  assert.equal(customerHint(first, [first, second]), 'ma…@example.com');
  assert.equal(customerHint(second, [first, second]), 'ma…@other.com');
});

// backlog:b0788e62ace6: the «Cliente» label stays once a customer is picked.
test('form: the picked customer keeps its «Cliente» label, the search field too', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const storage = new Map();
  const store = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  store.setItem('accordo.bo.customer-pick.appointment', JSON.stringify({ resource: 'contact', id: 'c1', name: 'Guido Presti' }));
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: stubClient(), storage: store, now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  const field = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-field');
  assert.ok(field, 'the picked customer sits in a labelled field');
  assert.equal(field.getAttribute('role'), 'group');
  const label = field.findAll('span').find((node) => node.getAttribute('id') === field.getAttribute('aria-labelledby'));
  assert.equal(label?.textContent, 'Cliente', 'the group is named «Cliente»');
  assert.equal(field.findAll('p').find((node) => node.getAttribute('data-role') === 'customer-pick')?.textContent, 'Guido Presti');
  assert.ok(field.findAll('button').some((node) => node.textContent === 'Cambia cliente'), '«Cambia cliente» sits in the same field');
  // «Cambia cliente» brings back the search field, still labelled.
  field.findAll('button').find((node) => node.textContent === 'Cambia cliente').dispatch('click');
  await settle();
  const search = byName(mount, 'customerSearch');
  let node = search;
  while (node && node.tagName !== 'LABEL') node = node.parentNode;
  assert.equal(node?.findAll('span').find((span) => (span.getAttribute('class') ?? '').includes('cal-field-label'))?.textContent, 'Cliente');
});
