import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { NUMBER_FORMAT_HINT, dialableNumber, knownNumbers } from '../apps/admin/public/admin-call-number.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Scheda cliente «Chiama» voice-aware (voce 105563eea902) and «Chiama»
 * without a number (Dan 11/11).
 *
 * What it must prove: «Chiama» is always offered. Without a held number,
 * or with several known numbers, it opens the number window, which saves a
 * new number through POST /api/customer-hub/phone and re-reads the server
 * card before calling; with one number «Chiama» is voice-aware — without an
 * active voice connection the card says so and falls back to `tel:`,
 * logging nothing, while with one the operator declares the outcome and the
 * call is logged through POST /api/customer-hub/calls with a fresh key. The
 * dialed number is shown,
 * never sent; hostile server text stays text.
 */

const CARD_NO_PHONE = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: false, value: null, reason: 'no phone-bearing identity held' },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto', reason: 'no signed business in the composed packages' },
};

const CARD_WITH_PHONE = {
  ...CARD_NO_PHONE,
  phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
};

const VOICE = { channel: 'voice', status: 'active', connectionKey: 'voice:presti:1' };

function stubClient({ card = CARD_NO_PHONE, connectors = [], connectorsError = null, onPost = null, profile = null } = {}) {
  const state = { card, connectors };
  const posts = [];
  return {
    state,
    posts,
    async request(path, opts = {}) {
      enforceAdminWriteGate(path, opts);
      if (opts.method === 'POST' && path === '/api/customer-hub/phone') {
        const body = JSON.parse(opts.body);
        posts.push({ path, body });
        if (typeof onPost?.phone === 'function') return onPost.phone(body);
        if (!/^\+[1-9]\d{6,14}$/.test(body.phone ?? '')) {
          throw Object.assign(new Error('bad phone'), { status: 400 });
        }
        state.card = { ...state.card, phone: { available: true, value: body.phone, system: 'phone', reason: null } };
        return { outcome: 'linked', system: 'phone', externalId: body.phone };
      }
      if (opts.method === 'POST' && path === '/api/customer-hub/calls') {
        const body = JSON.parse(opts.body);
        posts.push({ path, body });
        if (typeof onPost?.call === 'function') return onPost.call(body);
        return { id: 'call-1', replayed: false, ...body };
      }
      if (path.startsWith('/api/connectors')) {
        if (connectorsError) throw connectorsError;
        return { connectors: state.connectors };
      }
      if (path.startsWith('/api/customer-hub/card/')) return state.card;
      if (profile !== null && path.startsWith('/api/customer-data/profile/')) return profile;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const renderCard = async (client, spaceId = 'presti') => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId }).renderCard('contact', 'c1');
  return mount;
};

const button = (mount, action) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === action) ?? null;

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

// Dan 11/11: «Chiama» is always offered. Without a number it opens the
// number window (same frame as Scrivi and Nuova offerta), which saves the
// number through POST /api/customer-hub/phone and then starts the usual
// Chiama flow on the re-read card. The old «Aggiungi telefono» tile is gone.
const phoneWindow = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-phone') === 'open') ?? null;
const numberField = (mount) => mount.findAll('input').find((node) => node.getAttribute('name') === 'call-number') ?? null;
const windowError = (mount) => phoneWindow(mount)?.findAll('p').find((node) => node.getAttribute('class') === 'field-error') ?? null;

test('Dan 11/11: without a phone Chiama is offered and opens the number window, never a dead tile', async () => {
  const client = stubClient();
  const mount = await renderCard(client);
  const call = button(mount, 'call-customer');
  assert.ok(call, 'Chiama is offered without a number');
  assert.equal(button(mount, 'add-phone'), null, 'no separate Aggiungi telefono tile');
  const grid = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-actions');
  assert.ok(!grid.textContent.includes('Nessun telefono collegato'), 'no dead «no phone» label in the grid');
  assert.equal(grid.findAll('span').filter((node) => node.getAttribute('class') === 'bo-scheda-disabled'
    && node.textContent.includes('telefono')).length, 0, 'no disabled phone label among the tiles');
  call.listeners.click[0]();
  const win = phoneWindow(mount);
  assert.ok(win, 'the number window opens');
  assert.equal(win.getAttribute('role'), 'dialog');
  assert.ok(win.findAll('div').some((node) => node.getAttribute('class') === 'bo-composer-head'),
    'the window has the scheda window head like Scrivi and Nuova offerta');
  assert.ok(win.textContent.includes('Guido Presti'), 'the head names the customer');
  assert.ok(numberField(mount), 'a field for the new number');
  assert.equal(client.posts.length, 0, 'opening the window writes nothing');
});

test('Dan 11/11: a new number is saved on the contact, then the call starts on the re-read card', async () => {
  const client = stubClient({ connectors: [] });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  numberField(mount).value = '333 123 4567';
  await button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].path, '/api/customer-hub/phone');
  assert.deepEqual(
    { resource: client.posts[0].body.resource, id: client.posts[0].body.id, phone: client.posts[0].body.phone },
    { resource: 'contact', id: 'c1', phone: '+393331234567' },
    'the Italian number is saved in the international form',
  );
  assert.equal(phoneWindow(mount), null, 'the number window closes');
  assert.ok(mount.textContent.includes('Nessun connettore voce collegato'), 'the usual Chiama flow starts');
  const fallback = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'call-fallback');
  assert.ok(String(fallback?.getAttribute('href')).startsWith('tel:+393331234567'), 'it calls the saved number');
  assert.equal(button(mount, 'call-customer').getAttribute('title'), 'Chiama +393331234567',
    'the card now holds the server number');
});

test('Dan 11/11: a number saved while another customer takes the screen never calls on that one', async () => {
  const base = stubClient({ connectors: [] });
  let gate = null;
  let openGate = () => {};
  const client = {
    ...base,
    async request(path, opts = {}) {
      if (path === '/api/customer-hub/card/contact/c2') {
        return { ...CARD_NO_PHONE, subject: { resource: 'contact', id: 'c2' }, name: 'Altra Persona' };
      }
      if (gate !== null && path === '/api/customer-hub/card/contact/c1') await gate;
      return base.request(path, opts);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({ doc, mount, client, spaceId: 'presti', toast: (text) => toasts.push(text) });
  await view.renderCard('contact', 'c1');
  button(mount, 'call-customer').listeners.click[0]();
  numberField(mount).value = '+393331234567';
  // The re-read of c1 after the save waits; meanwhile c2 takes the screen.
  gate = new Promise((resolve) => { openGate = resolve; });
  const saving = button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  assert.equal(base.posts.length, 1, 'the number is saved on c1');
  await view.renderCard('contact', 'c2');
  openGate();
  await saving;
  await flush();
  assert.ok(mount.textContent.includes('Altra Persona'), 'the other customer is on screen');
  assert.ok(!mount.textContent.includes('Nessun connettore voce collegato'), 'no call panel opens on the other customer');
  assert.ok(!mount.findAll('a').some((node) => node.getAttribute('data-action') === 'call-fallback'));
  assert.ok(!toasts.some((text) => text.includes('non lo mostra ancora')), 'no stray notice either');
});

test('Dan 11/11: an empty or malformed number never posts and says why in plain words', async () => {
  const client = stubClient();
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await button(mount, 'call-with-number').listeners.click[0]();
  assert.equal(windowError(mount).textContent, 'Scrivi il numero prima di chiamare.');
  for (const typed of ['333 12', 'abc', '+0 12345678', '393331234567']) {
    numberField(mount).value = typed;
    await button(mount, 'call-with-number').listeners.click[0]();
    assert.equal(windowError(mount).textContent, NUMBER_FORMAT_HINT, `«${typed}» is refused before any request`);
    assert.equal(numberField(mount).value, typed, 'the typed number stays for the correction');
  }
  assert.equal(client.posts.length, 0, 'nothing is sent');
  // Enter in the field submits like the button.
  numberField(mount).value = '+39 02 1234 567';
  numberField(mount).dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(client.posts[0]?.body.phone, '+39021234567', 'Enter saves the valid number');
});

test('Dan 11/11: Annulla and Escape close the number window with no effect', async () => {
  const client = stubClient();
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  numberField(mount).value = '+393331234567';
  button(mount, 'cancel-phone').listeners.click[0]();
  assert.equal(phoneWindow(mount), null, 'Annulla closes it');
  button(mount, 'call-customer').listeners.click[0]();
  phoneWindow(mount).dispatch('keydown', { key: 'Escape' });
  assert.equal(phoneWindow(mount), null, 'Escape closes it');
  assert.equal(client.posts.length, 0, 'nothing is saved');
});

test('Dan 11/11: while the number is saved the button waits («Salvo…») and a second click sends nothing', async () => {
  let release;
  const client = stubClient({
    onPost: {
      phone: (body) => new Promise((resolve) => {
        release = () => resolve({ outcome: 'linked', system: 'phone', externalId: body.phone });
      }),
    },
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  numberField(mount).value = '+393331234567';
  const go = button(mount, 'call-with-number');
  const first = go.listeners.click[0]();
  assert.equal(go.textContent, 'Salvo…');
  assert.equal(go.getAttribute('disabled'), 'disabled');
  assert.equal(go.getAttribute('aria-busy'), 'true');
  await go.listeners.click[0]();
  assert.equal(client.posts.length, 1, 'one save only');
  release();
  await first;
});

test('Dan 11/11: with several known numbers Chiama asks which one; the held one calls without saving', async () => {
  const client = stubClient({
    card: CARD_WITH_PHONE,
    connectors: [],
    profile: {
      externalIdentities: [
        { system: 'phone', externalId: '+393331234567' },
        { system: 'whatsapp', externalId: '+39 345 765 4321' },
        { system: 'instagram', externalId: 'guido.presti' },
        { system: 'sms', externalId: 'CRM-1' },
      ],
    },
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  const win = phoneWindow(mount);
  assert.ok(win, 'two numbers: the window asks which one');
  const choices = win.findAll('label').map((node) => node.getAttribute('data-number'));
  assert.deepEqual(choices, ['+393331234567', '+393457654321', 'altro'],
    'the held number first, the WhatsApp one, then «Un altro numero» — never a handle that does not dial');
  assert.ok(win.textContent.includes('+393457654321 · WhatsApp'));
  assert.equal(win.findAll('label')[0].getAttribute('data-selected'), 'true', 'the held number is preselected');
  assert.equal(numberField(mount).getAttribute('hidden'), 'hidden', 'the new-number field waits for «Un altro numero»');
  await button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  assert.equal(client.posts.length, 0, 'the held number is called without a write');
  assert.equal(phoneWindow(mount), null);
  assert.ok(mount.findAll('a').some((node) => String(node.getAttribute('href')).startsWith('tel:+393331234567')));
});

test('Dan 11/11: picking another known number saves it on the contact before calling', async () => {
  const client = stubClient({
    card: CARD_WITH_PHONE,
    connectors: [],
    profile: { externalIdentities: [{ system: 'whatsapp', externalId: '+393457654321' }] },
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  const other = phoneWindow(mount).findAll('label').find((node) => node.getAttribute('data-number') === '+393457654321');
  other.findAll('input')[0].dispatch('change');
  assert.equal(other.getAttribute('data-selected'), 'true');
  await button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].body.phone, '+393457654321');
  assert.ok(mount.findAll('a').some((node) => String(node.getAttribute('href')).startsWith('tel:+393457654321')),
    'the call starts on the number the card now holds');
});

test('Dan 11/11: «Un altro numero» shows the field; a single held number still calls at once', async () => {
  const several = stubClient({
    card: CARD_WITH_PHONE,
    profile: { externalIdentities: [{ system: 'whatsapp', externalId: '+393457654321' }] },
  });
  const mount = await renderCard(several);
  button(mount, 'call-customer').listeners.click[0]();
  const other = phoneWindow(mount).findAll('label').find((node) => node.getAttribute('data-number') === 'altro');
  other.findAll('input')[0].dispatch('change');
  assert.equal(numberField(mount).getAttribute('hidden'), null, 'the field shows');

  const single = stubClient({ card: CARD_WITH_PHONE, connectors: [] });
  const singleMount = await renderCard(single);
  button(singleMount, 'call-customer').listeners.click[0]();
  await flush();
  assert.equal(phoneWindow(singleMount), null, 'one number: no question');
  assert.ok(singleMount.textContent.includes('Nessun connettore voce collegato'), 'the call flow starts as before');
});

/**
 * Pilot #426: POST /bo/api/customer-hub/phone answers 400/404/409 with an
 * Italian sentence. The window reads that sentence, keeps the typed
 * number, and keeps the generic retry line for anything else.
 */
const refusedWith = async (failure, typed = '+393331234567') => {
  const client = stubClient({ onPost: { phone: () => { throw failure; } } });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  const input = numberField(mount);
  input.value = typed;
  await button(mount, 'call-with-number').listeners.click[0]();
  return { client, mount, input, error: windowError(mount) };
};

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

test('Chiama senza numero: a 409 shows the server reason and keeps the typed number', async () => {
  const { error, input, client, mount } = await refusedWith(
    failure(409, 'PHONE_ALREADY_HELD', 'Questo numero è già collegato a un altro cliente'));
  assert.equal(client.posts.length, 1);
  assert.equal(error.textContent, 'Questo numero è già collegato a un altro cliente');
  assert.equal(input.value, '+393331234567', 'the typed number stays for the correction');
  assert.ok(phoneWindow(mount), 'the window stays open');
  assert.equal(button(mount, 'call-with-number').getAttribute('disabled'), null, 'the button is usable again');
  assert.equal(button(mount, 'call-with-number').textContent, 'Chiama');
});

test('Chiama senza numero: a 400 shows the server format hint', async () => {
  const message = 'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567';
  const { error } = await refusedWith(failure(400, 'VALIDATION_ERROR', message));
  assert.equal(error.textContent, message);
});

test('Chiama senza numero: a 404 says the customer is gone; an English or generic message reads our Italian', async () => {
  const gone = await refusedWith(failure(404, 'PHONE_SUBJECT_NOT_FOUND', 'Il cliente non è più in questo spazio: ricarica la scheda'));
  assert.equal(gone.error.textContent, 'Il cliente non è più in questo spazio: ricarica la scheda');
  const english = await refusedWith(failure(400, 'VALIDATION_ERROR', 'phone must be E.164'));
  assert.equal(english.error.textContent,
    'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567');
  const generic = await refusedWith(failure(400, 'BO_CRM_BODY_REFUSED', 'Scrittura del pannello rifiutata'));
  assert.equal(generic.error.textContent,
    'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567');
});

test('Chiama senza numero: unknown and 5xx failures keep the generic retry line', async () => {
  const down = await refusedWith(failure(503, 'BO_BRIDGE_NOT_CONFIGURED', 'Scrittura del pannello rifiutata'));
  assert.equal(down.error.textContent, 'Numero non salvato. Riprova più tardi.');
  const network = await refusedWith(new Error('Failed to fetch'));
  assert.equal(network.error.textContent, 'Numero non salvato. Riprova più tardi.');
  assert.equal(network.input.value, '+393331234567');
});

test('dialableNumber: international and Italian forms, nothing guessed', () => {
  assert.equal(dialableNumber('+39 333 123 4567'), '+393331234567');
  assert.equal(dialableNumber('0039 333-123-4567'), '+393331234567');
  assert.equal(dialableNumber('333 1234567'), '+393331234567');
  assert.equal(dialableNumber('(02) 1234.567'), '+39021234567');
  assert.equal(dialableNumber('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['', '12', '333 12', 'abc', '+0123456789', '393331234567', null, undefined]) {
    assert.equal(dialableNumber(bad), null, String(bad));
  }
});

test('knownNumbers: held first, deduplicated on the dialable form, non-phone systems ignored', () => {
  const numbers = knownNumbers({
    held: '+393331234567',
    identities: [{ system: 'whatsapp', externalId: '+39 333 123 4567' }, { system: 'email', externalId: '+393330000000' }],
    observed: [{ system: 'sms', externalId: '3457654321' }, { system: 'voice', externalId: null }],
  });
  assert.deepEqual(numbers, [
    { number: '+393331234567', held: true, systems: ['WhatsApp'] },
    { number: '+393457654321', held: false, systems: ['SMS'] },
  ]);
});

test('105563eea902: without a linked voice Chiama says so and falls back to tel:, logging nothing', async () => {
  const client = stubClient({ card: CARD_WITH_PHONE, connectors: [] });
  const mount = await renderCard(client);
  const call = button(mount, 'call-customer');
  assert.ok(call, 'Chiama exists with a number');
  assert.equal(mount.findAll('a').filter((node) => String(node.getAttribute('href') ?? '').startsWith('tel:')).length, 0,
    'no device-dial link before the voice check');
  call.listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Nessun connettore voce collegato'),
    'the card says the CRM cannot place the call');
  const fallback = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'call-fallback');
  assert.ok(fallback, 'the device dialer is offered instead');
  assert.ok(String(fallback.getAttribute('href')).startsWith('tel:+393331234567'));
  assert.ok(!client.posts.some((post) => post.path === '/api/customer-hub/calls'),
    'no call the CRM never placed is logged');
});

test('105563eea902: with a linked voice the operator declares the outcome and the call is logged', async () => {
  const client = stubClient({ card: CARD_WITH_PHONE, connectors: [VOICE] });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  const save = button(mount, 'log-call');
  assert.ok(save, 'the outcome form is offered with a linked voice');
  const outcome = mount.findAll('select')[0];
  outcome.value = 'completed';
  mount.findAll('input')[0].value = '62';
  await save.listeners.click[0]();
  const logged = client.posts.filter((post) => post.path === '/api/customer-hub/calls');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].body.outcome, 'completed');
  assert.equal(logged[0].body.durationSec, 62);
  assert.equal(logged[0].body.spaceId, 'presti');
  assert.ok(typeof logged[0].body.callKey === 'string' && logged[0].body.callKey !== '',
    'one fresh key per call');
  assert.ok(!('to' in logged[0].body), 'the dialed number is never sent: the server re-derives it');
  assert.ok(mount.textContent.includes('Chiamata registrata') || button(mount, 'call-customer'),
    'the save either toasts or re-reads the card');
});

test('105563eea902: a voice entry without a connectionKey is not callable: tel: fallback, no form', async () => {
  const client = stubClient({
    card: CARD_WITH_PHONE,
    connectors: [{ channel: 'voice', status: 'active', connectionKey: '' }],
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Nessun connettore voce collegato'),
    'an empty connectionKey reads as no linked voice, like the route 409');
  assert.equal(button(mount, 'log-call'), null, 'no outcome form is offered when the route would refuse it');
  assert.ok(mount.findAll('a').some((node) => node.getAttribute('data-action') === 'call-fallback'),
    'the device dialer is offered instead');
  assert.ok(!client.posts.some((post) => post.path === '/api/customer-hub/calls'),
    'no call the CRM never placed is logged');
});

test('105563eea902: when the connectors read fails (404 not composed) Chiama still offers tel: with an honest notice', async () => {
  const notComposed = Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
  const client = stubClient({ card: CARD_WITH_PHONE, connectorsError: notComposed });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('La chiamata dal CRM non è disponibile qui: chiama dal telefono.'),
    'the panel names the honest fallback instead of only a retry error');
  const fallback = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'call-fallback');
  assert.ok(fallback, 'the device dialer is offered even when the connectors read fails');
  assert.ok(String(fallback.getAttribute('href')).startsWith('tel:+393331234567'));
  assert.equal(button(mount, 'log-call'), null, 'no CRM-logged form is offered when the connectors cannot be read');
  assert.ok(!client.posts.some((post) => post.path === '/api/customer-hub/calls'),
    'no call the CRM never placed is logged');
});

test('105563eea902: with any other connectors-read failure Chiama still offers tel:', async () => {
  const client = stubClient({
    card: CARD_WITH_PHONE,
    connectorsError: Object.assign(new Error('boom'), { status: 500 }),
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.ok(mount.findAll('a').some((node) => node.getAttribute('data-action') === 'call-fallback'),
    'the device dialer is offered on any read failure, not only 404');
  assert.equal(button(mount, 'log-call'), null, 'no CRM-logged form without a voice check');
});

test('105563eea902: without an active space Chiama still offers tel: next to the choose-a-space notice', async () => {
  const client = stubClient({ card: CARD_WITH_PHONE, connectors: [VOICE] });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId: null }).renderCard('contact', 'c1');
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Scegli uno spazio per chiamare dal CRM.'),
    'the space notice stays');
  const fallback = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'call-fallback');
  assert.ok(fallback, 'dialing needs no space: the tel: link is offered anyway');
  assert.ok(String(fallback.getAttribute('href')).startsWith('tel:+393331234567'));
  assert.equal(button(mount, 'log-call'), null, 'only the CRM-logged form is gated on a space');
  assert.ok(!client.posts.some((post) => post.path === '/api/customer-hub/calls'),
    'no call the CRM never placed is logged');
});

test('105563eea902: Fallita sends its errorCode, other outcomes send none, an empty code never posts', async () => {
  const failed = stubClient({ card: CARD_WITH_PHONE, connectors: [VOICE] });
  const failedMount = await renderCard(failed);
  failedMount.findAll('button').find((node) => node.getAttribute('data-action') === 'call-customer')
    .listeners.click[0]();
  await flush();
  const outcome = failedMount.findAll('select')[0];
  assert.equal(failedMount.findAll('input').filter((node) => node.getAttribute('id') === 'call-error-code').length, 0,
    'no code field until Fallita is picked');
  outcome.value = 'failed';
  outcome.listeners.change[0]();
  const code = failedMount.findAll('input').find((node) => node.getAttribute('id') === 'call-error-code');
  assert.ok(code, 'picking Fallita shows the error-code field');
  code.value = 'LINE_BUSY';
  await button(failedMount, 'log-call').listeners.click[0]();
  const logged = failed.posts.filter((post) => post.path === '/api/customer-hub/calls');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].body.outcome, 'failed');
  assert.equal(logged[0].body.errorCode, 'LINE_BUSY', 'Fallita carries the code validateCallRequest requires');

  const empty = stubClient({ card: CARD_WITH_PHONE, connectors: [VOICE] });
  const emptyMount = await renderCard(empty);
  emptyMount.findAll('button').find((node) => node.getAttribute('data-action') === 'call-customer')
    .listeners.click[0]();
  await flush();
  const emptyOutcome = emptyMount.findAll('select')[0];
  emptyOutcome.value = 'failed';
  emptyOutcome.listeners.change[0]();
  await button(emptyMount, 'log-call').listeners.click[0]();
  assert.equal(empty.posts.filter((post) => post.path === '/api/customer-hub/calls').length, 0,
    'Fallita without a code never posts');
  assert.ok(emptyMount.textContent.includes('Indica il codice di errore'),
    'the missing code reads Italian');

  const completed = stubClient({ card: CARD_WITH_PHONE, connectors: [VOICE] });
  const completedMount = await renderCard(completed);
  completedMount.findAll('button').find((node) => node.getAttribute('data-action') === 'call-customer')
    .listeners.click[0]();
  await flush();
  const completedOutcome = completedMount.findAll('select')[0];
  completedOutcome.value = 'completed';
  completedOutcome.listeners.change[0]();
  completedMount.findAll('input')[0].value = '62';
  await button(completedMount, 'log-call').listeners.click[0]();
  const done = completed.posts.filter((post) => post.path === '/api/customer-hub/calls');
  assert.equal(done.length, 1);
  assert.ok(!('errorCode' in done[0].body), 'a completed call sends no errorCode');
});

test('105563eea902: a hostile held value stays text, never markup', async () => {
  const nasty = '"><img src=x onerror=alert(1)>';
  const client = stubClient({
    card: { ...CARD_WITH_PHONE, phone: { available: true, value: nasty, system: 'phone', reason: null } },
    connectors: [VOICE],
  });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes(nasty), 'the value reads as text');
  assert.equal(mount.findAll('img').length, 0, 'no markup is built from the value');
});

// Review #776 (P1): the call starts only on the number the operator chose.
// When the re-read card still dials another number, nothing is called and
// the operator is told which number the scheda holds.
test('review #776: a chosen number the card does not hold after the save is never called', async () => {
  const client = stubClient({
    card: CARD_WITH_PHONE,
    connectors: [],
    profile: { externalIdentities: [{ system: 'whatsapp', externalId: '+393457654321' }] },
    // The server keeps showing the first number (a refreshed sighting).
    onPost: { phone: (body) => ({ outcome: 'refreshed', system: 'phone', externalId: body.phone }) },
  });
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  await createCustomerCardView({ doc, mount, client, spaceId: 'presti', toast: (text, error) => toasts.push([text, error === true]) })
    .renderCard('contact', 'c1');
  button(mount, 'call-customer').listeners.click[0]();
  phoneWindow(mount).findAll('label').find((node) => node.getAttribute('data-number') === '+393457654321')
    .findAll('input')[0].dispatch('change');
  await button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  assert.equal(client.posts[0]?.body.phone, '+393457654321', 'the chosen number is saved');
  assert.ok(!mount.findAll('a').some((node) => node.getAttribute('data-action') === 'call-fallback'), 'no call starts');
  assert.ok(!mount.textContent.includes('Nessun connettore voce collegato'), 'no call panel opens');
  assert.ok(toasts.some(([text, error]) => error && text.includes('la scheda chiama ancora +393331234567')), JSON.stringify(toasts));
});

// Review #776 (P2): leaving the scheda while the number is saving never
// repaints it over the next customer, and never opens a call there.
test('review #776: another customer opened during the save keeps the screen', async () => {
  const base = stubClient({ connectors: [] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [];
  const client = {
    ...base,
    async request(path, opts = {}) {
      if (opts.method === 'POST' && path === '/api/customer-hub/phone') {
        const answer = base.request(path, opts);
        await gate;
        return answer;
      }
      reads.push(path);
      if (path === '/api/customer-hub/card/contact/c2') {
        return { ...CARD_NO_PHONE, subject: { resource: 'contact', id: 'c2' }, name: 'Altra Persona' };
      }
      return base.request(path, opts);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({ doc, mount, client, spaceId: 'presti' });
  await view.renderCard('contact', 'c1');
  button(mount, 'call-customer').listeners.click[0]();
  numberField(mount).value = '+393331234567';
  const saving = button(mount, 'call-with-number').listeners.click[0]();
  await flush();
  await view.renderCard('contact', 'c2');
  reads.length = 0;
  release();
  await saving;
  await flush();
  assert.ok(mount.textContent.includes('Altra Persona'), 'the other customer stays on screen');
  assert.ok(!reads.some((path) => path.includes('/card/contact/c1')), 'the first customer is not read again');
  assert.ok(!mount.textContent.includes('Nessun connettore voce collegato'), 'no call panel there');
});
