import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Backlog 28511aa43cc7: composer «Email» su cliente senza numero — la
 * riga del numero mancante e la riga dei canali sono due righe di stato
 * separate, e «Annulla» nella finestra del numero riporta al composer
 * con il testo digitato.
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

// No channel linked in the space: Email has an address but no link, so the
// composer shows both the missing-number line and the channels line.
const UNLINKED = { connectors: [] };

function stubClient() {
  return {
    async request(path, opts = {}) {
      enforceAdminWriteGate(path, opts);
      if (path.startsWith('/api/connectors')) return UNLINKED;
      if (path.startsWith('/api/customer-hub/card/')) return CARD_NO_PHONE;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

async function openComposer() {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client: stubClient(), spaceId: 'presti', toast: () => {} })
    .renderCard('contact', 'c1');
  await flush();
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-email').dispatch('click');
  await flush();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(panel, 'the composer panel opens');
  return { mount, panel };
}

const statusLines = (panel) => panel.findAll('p')
  .filter((node) => String(node.getAttribute('class') ?? '').includes('bo-composer-off'));

test('28511aa43cc7: numero mancante e canali sono due righe di stato separate', async () => {
  const { panel } = await openComposer();
  const lines = statusLines(panel);
  assert.equal(lines.length, 2, 'two separate status lines');
  assert.ok(lines[0].textContent.includes('manca perché il cliente non ha un numero'),
    'the first line names the missing number');
  assert.ok(lines[0].findAll('button').some((node) => node.getAttribute('data-action') === 'composer-add-phone'),
    'the add-number button sits in the missing-number line');
  assert.ok(!lines[0].textContent.includes('Collega'), 'the missing-number line carries no channel link');
  assert.ok(lines[1].textContent.includes('Collega un canale per scrivere a questo cliente'),
    'the second line is the channels line');
  assert.ok(!lines[1].textContent.includes('manca perché'), 'the channels line repeats no missing-number sentence');
  assert.notEqual(lines[0], lines[1], 'the lines are different nodes');
});

test('28511aa43cc7: Annulla nella finestra del numero riporta al composer con il testo', async () => {
  const { mount, panel } = await openComposer();
  panel.findAll('textarea')[0].value = 'Ciao Guido, ti scrivo qui';
  panel.findAll('textarea')[0].dispatch('input');
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-add-phone').dispatch('click');
  await flush();
  assert.ok(mount.findAll('div').find((node) => node.getAttribute('data-phone') === 'open'),
    'the number window opens');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-phone').dispatch('click');
  await flush();
  const back = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(back, 'Annulla brings the composer back');
  assert.equal(back.findAll('textarea')[0].value, 'Ciao Guido, ti scrivo qui',
    'the typed text survives Annulla');
  assert.equal(mount.findAll('div').find((node) => node.getAttribute('data-phone') === 'open'), undefined,
    'the number window is gone');
});
