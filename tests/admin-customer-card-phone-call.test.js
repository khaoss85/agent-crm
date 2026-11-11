import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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

function stubClient({ card = CARD_NO_PHONE, timeline = null, connectors = [], connectorsError = null, onPost = null } = {}) {
  const state = { card, timeline, connectors };
  const posts = [];
  return {
    state,
    posts,
    async request(path, opts = {}) {
      enforceAdminWriteGate(path, opts);
      if (path.startsWith('/api/customer-hub/timeline/')) {
        if (state.timeline === null) throw Object.assign(new Error('Not Found'), { status: 404 });
        return state.timeline;
      }
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
  assert.ok(button(mount, 'call-customer'), '03a6535a7110: Chiama exists even without a number');
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
  assert.ok(refusedMount.textContent.includes('Questo numero è già collegato a un altro cliente'),
    'the refusal reads its Italian reason, never the code or the English message');
  assert.ok(!refusedMount.textContent.includes('held'), 'no English server text on screen');
});

/**
 * Pilot #426: POST /bo/api/customer-hub/phone answers 400/404/409 with an
 * Italian sentence. The panel reads that sentence (production 07/11 it
 * always said «Numero non salvato…»), keeps the typed number, and keeps the
 * generic retry line for anything else.
 */
const refusedWith = async (failure, typed = '+393331234567') => {
  const client = stubClient({ onPost: { phone: () => { throw failure; } } });
  const mount = await renderCard(client);
  button(mount, 'add-phone').listeners.click[0]();
  const input = mount.findAll('input')[0];
  input.value = typed;
  await button(mount, 'save-phone').listeners.click[0]();
  const error = mount.findAll('p').find((node) => node.getAttribute('class') === 'field-error');
  return { client, mount, input, error };
};

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

test('Aggiungi telefono: a 409 shows the server reason and keeps the typed number', async () => {
  const { error, input, client } = await refusedWith(
    failure(409, 'PHONE_ALREADY_HELD', 'Questo numero è già collegato a un altro cliente'));
  assert.equal(client.posts.length, 1);
  assert.equal(error.textContent, 'Questo numero è già collegato a un altro cliente');
  assert.equal(input.value, '+393331234567', 'the typed number stays for the correction');
});

test('Aggiungi telefono: a 400 shows the server format hint', async () => {
  const message = 'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567';
  const { error, input } = await refusedWith(failure(400, 'VALIDATION_ERROR', message), '333 12');
  assert.equal(error.textContent, message);
  assert.equal(input.value, '333 12', 'the typed number stays for the correction');
});

test('Aggiungi telefono: a 404 says the customer is gone; an English or generic message reads our Italian', async () => {
  const gone = await refusedWith(failure(404, 'PHONE_SUBJECT_NOT_FOUND', 'Il cliente non è più in questo spazio: ricarica la scheda'));
  assert.equal(gone.error.textContent, 'Il cliente non è più in questo spazio: ricarica la scheda');
  const english = await refusedWith(failure(400, 'VALIDATION_ERROR', 'phone must be E.164'));
  assert.equal(english.error.textContent,
    'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567');
  const generic = await refusedWith(failure(400, 'BO_CRM_BODY_REFUSED', 'Scrittura del pannello rifiutata'));
  assert.equal(generic.error.textContent,
    'Numero non valido: scrivilo in formato internazionale, per esempio +393331234567');
});

test('Aggiungi telefono: unknown and 5xx failures keep the generic retry line', async () => {
  const down = await refusedWith(failure(503, 'BO_BRIDGE_NOT_CONFIGURED', 'Scrittura del pannello rifiutata'));
  assert.equal(down.error.textContent, 'Numero non salvato. Riprova più tardi.');
  const network = await refusedWith(new Error('Failed to fetch'));
  assert.equal(network.error.textContent, 'Numero non salvato. Riprova più tardi.');
  assert.equal(network.input.value, '+393331234567');
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

/**
 * Voce 03a6535a7110 (Dan 11/11): «Chiama» senza numero salvato apre un
 * pannello che chiede il numero — sceglie tra i numeri noti del contatto o
 * ne inserisce uno nuovo (salvato sul contatto), poi avvia la chiamata. Con
 * più numeri chiede quale usare; con un solo numero chiama subito; mai un
 * clic che non fa niente o un errore generico.
 */
const TIMELINE_TWO_NUMBERS = {
  conversations: { items: [{ channel: 'whatsapp', peer: '+393331111111' }] },
  entries: { items: [{ channel: 'sms', remoteHandle: '+393332222222' }] },
};

const TIMELINE_ONE_NUMBER = {
  conversations: { items: [{ channel: 'whatsapp', peer: '+393331111111' }] },
  entries: { items: [] },
};

const chooseButtons = (mount) => mount.findAll('button')
  .filter((node) => node.getAttribute('data-action') === 'choose-call-number');

test('03a6535a7110: Chiama without a saved number asks for the number, saves it, then calls', async () => {
  const client = stubClient({ connectors: [VOICE] });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  assert.ok(mount.textContent.includes('Nessun numero salvato'),
    'the panel says no number is held instead of doing nothing');
  const input = mount.findAll('input')[0];
  assert.ok(input, 'the panel asks for a number');
  input.value = '+393339998888';
  await button(mount, 'save-call-number').listeners.click[0]();
  await flush();
  const phonePosts = client.posts.filter((post) => post.path === '/api/customer-hub/phone');
  assert.equal(phonePosts.length, 1, 'the new number is saved on the contact first');
  assert.equal(phonePosts[0].body.phone, '+393339998888');
  assert.ok(button(mount, 'log-call'), 'then the call starts: the outcome form opens');
});

test('03a6535a7110: Chiama with several known numbers asks which one to use', async () => {
  const client = stubClient({ card: CARD_WITH_PHONE, timeline: TIMELINE_TWO_NUMBERS });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  const choices = chooseButtons(mount);
  assert.ok(choices.length >= 2, `the panel lists the known numbers (saw ${choices.length})`);
  assert.ok(mount.textContent.includes('Scegli quale numero chiamare.'));
  const picked = choices.find((node) => node.textContent.includes('+393331111111'));
  assert.ok(picked, 'the observed WhatsApp number is offered');
  picked.listeners.click[0]();
  await flush();
  const fallback = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'call-fallback');
  assert.ok(fallback, 'picking a number starts the call (device dialer without a voice link)');
  assert.ok(String(fallback.getAttribute('href')).includes('+393331111111'),
    'the call starts on the picked number');
  assert.ok(!client.posts.some((post) => post.path === '/api/customer-hub/calls'),
    'choosing never logs a call the CRM never placed');
});

test('03a6535a7110: Chiama with a single known number calls at once, no chooser', async () => {
  const client = stubClient({ timeline: TIMELINE_ONE_NUMBER, connectors: [VOICE] });
  const mount = await renderCard(client);
  button(mount, 'call-customer').listeners.click[0]();
  await flush();
  assert.equal(chooseButtons(mount).length, 0, 'no chooser for a single number');
  assert.ok(button(mount, 'log-call'), 'the call starts at once: the outcome form opens');
});

test('03a6535a7110: an empty number in the Chiama panel never posts, a refused one reads Italian', async () => {
  const emptyClient = stubClient();
  const emptyMount = await renderCard(emptyClient);
  button(emptyMount, 'call-customer').listeners.click[0]();
  await button(emptyMount, 'save-call-number').listeners.click[0]();
  assert.equal(emptyClient.posts.length, 0, 'nothing is sent without a number');
  assert.ok(emptyMount.textContent.includes('Scrivi il numero prima di chiamare.'));

  const refused = stubClient({
    onPost: { phone: () => { throw Object.assign(new Error('held'), { status: 409, code: 'PHONE_ALREADY_HELD' }); } },
  });
  const refusedMount = await renderCard(refused);
  button(refusedMount, 'call-customer').listeners.click[0]();
  refusedMount.findAll('input')[0].value = '+393331234567';
  await button(refusedMount, 'save-call-number').listeners.click[0]();
  assert.ok(refusedMount.textContent.includes('Questo numero è già collegato a un altro cliente'),
    'the refusal reads its Italian reason, never a generic error');
  assert.equal(button(refusedMount, 'log-call'), null, 'no call starts on a refused save');
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
