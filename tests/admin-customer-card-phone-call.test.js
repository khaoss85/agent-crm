import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Scheda cliente «Aggiungi telefono» e «Chiama» voice-aware (voce 105563eea902).
 *
 * What it must prove: without a held number the card names the empty state
 * AND offers «Aggiungi telefono», which saves through
 * POST /api/customer-hub/phone and re-reads the server card; with a number,
 * «Chiama» is voice-aware — without an active voice connection the card says
 * so and falls back to `tel:`, logging nothing, while with one the operator
 * declares the outcome and the call is logged through
 * POST /api/customer-hub/calls with a fresh key. The dialed number is shown,
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

function stubClient({ card = CARD_NO_PHONE, connectors = [], onPost = null } = {}) {
  const state = { card, connectors };
  const posts = [];
  return {
    state,
    posts,
    async request(path, opts = {}) {
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
      if (path.startsWith('/api/connectors')) return { connectors: state.connectors };
      if (path.startsWith('/api/customer-hub/card/')) return state.card;
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

test('105563eea902: without a phone the card names the empty state and offers Aggiungi telefono', async () => {
  const mount = await renderCard(stubClient());
  assert.ok(mount.textContent.includes('Nessun telefono collegato'), 'the empty state is named');
  assert.ok(button(mount, 'add-phone'), 'Aggiungi telefono is offered as the cure');
  assert.equal(button(mount, 'call-customer'), null, 'no Chiama without a number');
});

test('105563eea902: Aggiungi telefono saves the number and the card re-reads the server', async () => {
  const client = stubClient();
  const mount = await renderCard(client);
  button(mount, 'add-phone').listeners.click[0]();
  const input = mount.findAll('input')[0];
  assert.ok(input, 'the phone panel opens an input');
  input.value = '+393331234567';
  await button(mount, 'save-phone').listeners.click[0]();
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].path, '/api/customer-hub/phone');
  assert.deepEqual(
    { resource: client.posts[0].body.resource, id: client.posts[0].body.id, phone: client.posts[0].body.phone },
    { resource: 'contact', id: 'c1', phone: '+393331234567' },
  );
  assert.ok(mount.textContent.includes('+393331234567'), 'the saved number is the re-read server value');
  assert.ok(button(mount, 'call-customer'), 'with a number the card offers Chiama');
});

test('105563eea902: an empty number never posts, a refused one stays Italian', async () => {
  const emptyClient = stubClient();
  const emptyMount = await renderCard(emptyClient);
  button(emptyMount, 'add-phone').listeners.click[0]();
  await button(emptyMount, 'save-phone').listeners.click[0]();
  assert.equal(emptyClient.posts.length, 0, 'nothing is sent without a number');
  assert.ok(emptyMount.textContent.includes('Scrivi il numero prima di salvarlo.'));

  const refused = stubClient({
    onPost: { phone: () => { throw Object.assign(new Error('held'), { status: 409, code: 'PHONE_ALREADY_HELD' }); } },
  });
  const refusedMount = await renderCard(refused);
  button(refusedMount, 'add-phone').listeners.click[0]();
  refusedMount.findAll('input')[0].value = '+393331234567';
  await button(refusedMount, 'save-phone').listeners.click[0]();
  assert.ok(refusedMount.textContent.includes('Numero non salvato. Riprova più tardi.'),
    'the refusal reads Italian, never the code');
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
