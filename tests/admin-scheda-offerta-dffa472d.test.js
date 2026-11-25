import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:dffa472d6baa — the scheda «Invia offerta» line (offer, shareSend)
 * keeps two pre-existing defects reported by Muse on #1157, both red here
 * before the cure:
 *
 * (1) the catch branch updates the status line without the shown-scheda
 * guard, so an error landing after a navigation writes onto a detached
 * line — unlike the success branch, which checks shownKey/space/mount;
 * (2) the preparation assigns `draft.text = message`, wiping a draft the
 * operator already typed in the same composer — the cure merges with
 * mergeHandoffIntoDraft (admin-composer-handoff.js, as #1156 does), which
 * keeps the typed text and appends the message after a blank line, never
 * duplicating it.
 */

const ORIGIN = 'https://spazio.example';
const TOKEN = 'd'.repeat(64);
const URL = `${ORIGIN}/q/${TOKEN}`;
const EXPIRES = '2026-12-01T10:00:00.000Z';

const cardOf = (id, name) => ({
  customerCardContract: 1,
  subject: { resource: 'contact', id },
  name,
  company: null,
  phone: { available: false, value: null },
  email: `${id}@esempio.invalid`,
  socials: [],
  status: { value: 'contatto' },
});

const timelineOf = (id) => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: 0, truncated: false, items: [] },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

const quoteOf = (id, name) => ({
  id,
  status: 'approved',
  opportunityName: name,
  currency: 'EUR',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
});

const profileOf = (id) => ({
  customerProfileContract: 1,
  subject: { resource: 'contact', id },
  canonicalIdentity: { linked: false, members: [] },
  identity: { contact: { id } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [quoteOf(id === 'c1' ? 'q1' : 'q2', id === 'c1' ? 'Cucina per Giulia' : 'Sala per Sara')],
  },
});

/**
 * The share-link POST waits for `release()`, then either mints the link or
 * fails — a slow or broken network on purpose.
 */
function gatedShareClient({ fail = false } = {}) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let mints = 0;
  const posts = [];
  return {
    release,
    posts,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path.endsWith('/actions/share-link') && method === 'POST') {
        posts.push(path);
        await gate;
        if (fail) throw Object.assign(new Error('rete giù'), { status: 502 });
        mints += 1;
        return mints === 1
          ? { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } }
          : { result: { alreadyExisted: true, token: null, share: { expiresAt: EXPIRES } } };
      }
      if (path.startsWith('/api/customer-hub/card/')) {
        const id = path.split('/').pop();
        return cardOf(id, id === 'c1' ? 'Giulia Verdi' : 'Sara Blu');
      }
      if (path.startsWith('/api/customer-hub/timeline/')) return timelineOf(path.split('/').pop());
      if (path.startsWith('/api/customer-data/profile/')) return profileOf(path.split('/').pop());
      if (path === '/api/connectors') {
        return {
          connectors: [
            { channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' },
          ],
        };
      }
      if (path === '/api/profile') throw Object.assign(new Error('no profile'), { status: 404 });
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/customer-hub/messages')) return { items: [] };
      throw Object.assign(new Error(`Not Found: ${path}`), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const classes = (node) => String(node?.getAttribute('class') ?? '').split(/\s+/);
const shareWrap = (mount) => mount.findAll('div').find((node) => classes(node).includes('bo-scheda-share'));
const byAction = (root, action) => root.findAll('button').find((node) => node.getAttribute('data-action') === action);
const shareLineOf = (wrap) => wrap?.findAll('p').find((node) => classes(node).includes('offer-share-line')) ?? null;
const composer = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');

async function openView({ fail = false } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const client = gatedShareClient({ fail });
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti', origin: ORIGIN,
    toast: (text) => toasts.push(text), wait: () => Promise.resolve(),
  });
  return { doc, mount, toasts, client, view };
}

const countOf = (text, needle) => String(text ?? '').split(needle).length - 1;

test('dffa472d6baa (1): a preparation error after a scheda change writes nothing', async () => {
  const { mount, toasts, client, view } = await openView({ fail: true });
  await view.renderCard('contact', 'c1');
  await flush();
  const press = byAction(mount, 'scheda-share-link');
  assert.ok(press, 'customer A offers «Invia offerta»');
  press.dispatch('click');
  await flush(3);
  assert.equal(client.posts.length, 1, 'the share POST is in flight');
  const oldLine = shareLineOf(shareWrap(mount));
  assert.ok(oldLine, 'A has its own status line');
  assert.equal(oldLine.textContent, 'Creo il link…', 'press time writes on the shown scheda');

  // The operator navigates to customer B before the answer.
  await view.renderCard('contact', 'c2');
  await flush();
  const newWrap = shareWrap(mount);
  assert.ok(newWrap, 'customer B paints its own share line');

  client.release();
  await flush();
  assert.equal(oldLine.textContent, 'Creo il link…',
    'the error never lands on the detached line (red before the cure: «Link non creato…»)');
  const newLine = shareLineOf(newWrap);
  assert.ok(!String(newLine?.textContent ?? '').includes('Link non creato'),
    'nothing of A failure on the new scheda, as in the success branch');
  assert.deepEqual(toasts, [], 'no toast leaks the old scheda failure onto the new one');
});

test('dffa472d6baa (2b): open composer keeps typed text and takes the message after it', async () => {
  const { mount, view, client } = await openView();
  await view.renderCard('contact', 'c1');
  await flush();
  byAction(mount, 'compose-email').dispatch('click');
  await flush();
  const panel = composer(mount);
  assert.ok(panel, 'the composer is open before «Invia offerta»');
  const area = panel.findAll('textarea')[0];
  area.value = 'Ciao Giulia, ti mando i dettagli.';
  area.dispatch('input');
  await flush();

  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  client.release();
  await flush();
  const text = String(composer(mount).findAll('textarea')[0]?.value ?? '');
  assert.ok(text.startsWith('Ciao Giulia, ti mando i dettagli.'),
    'the typed text stays first (red before the cure: replaced by the message)');
  assert.ok(text.includes(URL), 'the ready message lands after the typed text');
  assert.ok(text.indexOf('Ciao Giulia') < text.indexOf(URL), 'typed first, message after');
  assert.equal(countOf(text, URL), 1, 'never duplicated');

  // Close and reopen: the stored draft kept the same merge.
  byAction(composer(mount), 'composer-close').dispatch('click');
  await flush();
  byAction(mount, 'compose-email').dispatch('click');
  await flush();
  const reopened = String(composer(mount).findAll('textarea')[0]?.value ?? '');
  assert.ok(reopened.startsWith('Ciao Giulia, ti mando i dettagli.') && reopened.includes(URL),
    'the merged draft survives a reopen');
  assert.equal(countOf(reopened, URL), 1, 'still once after reopen');

  // A second press reuses the link without duplicating the message.
  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  const again = String(composer(mount).findAll('textarea')[0]?.value ?? '');
  assert.equal(countOf(again, URL), 1, 'a second press never duplicates the message');
});

test('dffa472d6baa (2c): a stored draft with typed text is merged, not replaced', async () => {
  const { mount, view, client } = await openView();
  await view.renderCard('contact', 'c1');
  await flush();
  byAction(mount, 'compose-email').dispatch('click');
  await flush();
  const area = composer(mount).findAll('textarea')[0];
  area.value = 'Ciao Giulia, ci sentiamo domani.';
  area.dispatch('input');
  await flush();
  byAction(composer(mount), 'composer-close').dispatch('click');
  await flush();
  assert.ok(!composer(mount), 'the composer is closed, the draft is stored');

  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush(3);
  client.release();
  await flush();
  const panel = composer(mount);
  assert.ok(panel, 'the press opens the composer with the message');
  const text = String(panel.findAll('textarea')[0]?.value ?? '');
  assert.ok(text.startsWith('Ciao Giulia, ci sentiamo domani.'),
    'the stored typed text stays (red before the cure: draft.text replaced)');
  assert.ok(text.includes(URL), 'the message lands after it');
  assert.equal(countOf(text, URL), 1, 'never duplicated');
});
