import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { NUMBER_FORMAT_HINT } from '../apps/admin/public/admin-call-number.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Scheda cliente, composer da «WhatsApp» su cliente senza telefono
 * (backlog:7eb7dc663bbd, prova del Mac del 17/11 sul live).
 *
 * What it must prove: on a customer without a phone number the composer
 * says WhatsApp is missing because the customer has no number, with a way
 * to add one. «Aggiungi un numero» opens the number window in save mode —
 * it saves through POST /api/customer-hub/phone and re-reads the card,
 * never starting a call. With a number held the line is gone.
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

const CONNECTORS = {
  connectors: [
    { channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' },
    { channel: 'whatsapp', status: 'active', connectionKey: 'wa-1' },
  ],
};

function stubClient({ card = CARD_NO_PHONE } = {}) {
  const state = { card };
  const posts = [];
  return {
    state,
    posts,
    async request(path, opts = {}) {
      enforceAdminWriteGate(path, opts);
      if (opts.method === 'POST' && path === '/api/customer-hub/phone') {
        const body = JSON.parse(opts.body);
        posts.push({ path, body });
        if (!/^\+[1-9]\d{6,14}$/.test(body.phone ?? '')) {
          throw Object.assign(new Error('bad phone'), { status: 400 });
        }
        state.card = { ...state.card, phone: { available: true, value: body.phone, system: 'phone', reason: null } };
        return { outcome: 'linked', system: 'phone', externalId: body.phone };
      }
      if (path.startsWith('/api/connectors')) return CONNECTORS;
      if (path.startsWith('/api/customer-hub/card/')) return state.card;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

async function openComposerVia(client, action) {
  const toasts = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, spaceId: 'presti', toast: (message) => toasts.push(message),
  }).renderCard('contact', 'c1');
  const write = mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
  assert.ok(write, `a ${action} action exists`);
  write.dispatch('click');
  await flush();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(panel, 'the composer panel opens');
  return { mount, panel, toasts };
}

async function openComposerNoPhone(client) {
  const opened = await openComposerVia(client, 'compose-email');
  // Without a phone only the Email tile opens the composer — the WhatsApp
  // tile needs a recipient. The missing-number line must read there.
  assert.equal(opened.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-whatsapp'), undefined,
    'no WhatsApp tile without a number');
  return opened;
}

test('7eb7dc663bbd: the composer names the missing number with a way to add it', async () => {
  const { panel } = await openComposerNoPhone(stubClient());
  const text = panel.textContent;
  assert.ok(text.includes('WhatsApp manca perché il cliente non ha un numero'),
    'the composer says why WhatsApp is missing');
  const add = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-add-phone');
  assert.ok(add, 'a way to add the number sits in the line');
  assert.equal(add.textContent, 'Aggiungi un numero');
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const whatsapp = radios.find((node) => node.getAttribute('value') === 'whatsapp');
  assert.ok(whatsapp, 'the WhatsApp channel row exists');
  assert.equal(whatsapp.getAttribute('disabled'), 'disabled', 'WhatsApp stays switched off without a number');
});

test('7eb7dc663bbd: Aggiungi un numero saves on the scheda and never calls', async () => {
  const client = stubClient();
  const { mount, panel, toasts } = await openComposerNoPhone(client);
  panel.findAll('textarea')[0].value = 'Ciao Guido, ti scrivo qui';
  panel.findAll('textarea')[0].dispatch('input');
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-add-phone').dispatch('click');
  await flush();
  const win = mount.findAll('div').find((node) => node.getAttribute('data-phone') === 'open');
  assert.ok(win, 'the number window opens');
  assert.ok(win.textContent.includes('Aggiungi un numero'), 'the window saves, never calls');
  assert.ok(!win.textContent.includes('Poi apro il telefono'), 'no call sentence in save mode');
  const go = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-number');
  assert.ok(go, 'a save confirm, not Chiama');
  assert.equal(go.textContent, 'Salva numero');
  assert.equal(mount.findAll('button').find((node) => node.getAttribute('data-action') === 'call-with-number'), undefined,
    'no Chiama confirm in save mode');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'call-number').value = '333 123 4567';
  await go.listeners.click[0]();
  await flush();
  assert.equal(client.posts.length, 1, 'exactly one save');
  assert.deepEqual(
    { resource: client.posts[0].body.resource, id: client.posts[0].body.id, phone: client.posts[0].body.phone },
    { resource: 'contact', id: 'c1', phone: '+393331234567' },
    'the Italian number is saved in the international form',
  );
  assert.ok(toasts.includes('Numero salvato'), 'the operator reads the save');
  assert.equal(mount.findAll('div').find((node) => node.getAttribute('data-phone') === 'open'), undefined,
    'the number window closes');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'compose-whatsapp'),
    'the re-read card offers WhatsApp now');
  assert.ok(!mount.textContent.includes('Nessun connettore voce collegato'), 'no call starts from the composer line');
  assert.equal(mount.findAll('a').filter((node) => node.getAttribute('data-action') === 'call-fallback').length, 0,
    'no dialer fallback either');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-email').dispatch('click');
  await flush();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(reopened, 'the composer reopens after the save');
  assert.equal(reopened.findAll('textarea')[0].value, 'Ciao Guido, ti scrivo qui',
    'the typed draft survives the number window');
  assert.ok(!reopened.textContent.includes('manca perché il cliente non ha un numero'),
    'the re-read card holds the number: the line is gone');
});

test('7eb7dc663bbd: with a number held the line is gone', async () => {
  const client = stubClient({
    card: {
      ...CARD_NO_PHONE,
      phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
    },
  });
  const { panel } = await openComposerVia(client, 'compose-whatsapp');
  assert.ok(!panel.textContent.includes('manca perché il cliente non ha un numero'),
    'no missing-number line when the customer has one');
  assert.equal(panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-add-phone'), undefined,
    'no add-number button when the customer has one');
});

test('7eb7dc663bbd: an empty or malformed number never posts and says how to save', async () => {
  const client = stubClient();
  const { mount, panel } = await openComposerNoPhone(client);
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-add-phone').dispatch('click');
  await flush();
  const field = mount.findAll('input').find((node) => node.getAttribute('name') === 'call-number');
  const go = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-number');
  const errorOf = () => mount.findAll('div')
    .find((node) => node.getAttribute('data-phone') === 'open')
    ?.findAll('p')?.find((node) => node.getAttribute('class') === 'field-error');
  field.value = '';
  await go.listeners.click[0]();
  await flush(2);
  assert.equal(errorOf()?.textContent, 'Scrivi il numero prima di salvarlo.');
  field.value = 'non un numero';
  await go.listeners.click[0]();
  await flush(2);
  assert.equal(errorOf()?.textContent, NUMBER_FORMAT_HINT);
  assert.equal(client.posts.length, 0, 'nothing posted for a bad number');
});
