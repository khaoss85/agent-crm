import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { OFFER_SHARE_LIVE_LINK_LOST } from '../apps/admin/public/admin-offer-panel.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:7fa422415232 — review Muse #905 (P1) repro: the scheda «Invia
 * offerta» share has no stale-render guard, so a slow share-link answer
 * writes the old quote bearer into the newly shown customer's composer
 * (cross-customer link leak). Red before the cure: after navigating from
 * customer A to customer B while the POST is in flight, B's open composer
 * holds A's private URL. Green after: B's composer stays clean, the link
 * stays staged on A's draft, and reopening A shows it.
 */

const ORIGIN = 'https://spazio.example';
const TOKEN = 'b'.repeat(64);
const URL = `${ORIGIN}/q/${TOKEN}`;
const EXPIRES = '2026-12-01T10:00:00.000Z';

const cardOf = (id, name) => ({
  customerCardContract: 1,
  subject: { resource: 'contact', id },
  name,
  company: { id: 'co1', name: 'Palestra Esempio' },
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

const approvedQuote = (overrides = {}) => ({
  id: 'q1',
  status: 'approved',
  opportunityName: 'Cucina per Giulia',
  currency: 'EUR',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
  ...overrides,
});

const profileOf = (id, quoteOverrides = {}) => ({
  customerProfileContract: 1,
  subject: { resource: 'contact', id },
  canonicalIdentity: { linked: false, members: [] },
  identity: { contact: { id } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: {
    available: true,
    count: id === 'c1' ? 1 : 0,
    countIsComplete: true,
    truncated: false,
    items: id === 'c1' ? [approvedQuote(quoteOverrides)] : [],
  },
});

/** The share-link POST waits for `release()` — a slow network on purpose. */
function slowShareClient() {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const posts = [];
  return {
    release,
    posts,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
        posts.push(JSON.parse(options.body ?? '{}'));
        await gate;
        return { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } };
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

const shareButton = (mount) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === 'scheda-share-link');
const composeButton = (mount) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === 'compose-email');
const composerPanel = (mount) => mount.findAll('div')
  .find((node) => node.getAttribute('data-composer') === 'open');

test('7fa422415232: a slow share answer never lands in the next customer composer', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const client = slowShareClient();
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti', origin: ORIGIN,
    toast: (text) => toasts.push(text),
    wait: () => Promise.resolve(),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  const press = shareButton(mount);
  assert.ok(press, 'customer A offers «Invia offerta» on its approved quote');
  press.dispatch('click');
  await flush(3);
  assert.equal(client.posts.length, 1, 'the share POST is in flight');

  // The operator navigates to customer B and opens Scrivi before the answer.
  await view.renderCard('contact', 'c2');
  await flush();
  assert.ok(!shareButton(mount), 'customer B has no offer to share');
  const write = composeButton(mount);
  assert.ok(write, 'customer B can still open its composer');
  write.dispatch('click');
  await flush();
  const panel = composerPanel(mount);
  assert.ok(panel, 'B composer is open while the share answer is still missing');

  client.release();
  await flush();
  const area = panel.findAll('textarea')[0];
  assert.ok(area, 'B composer keeps its text field');
  assert.ok(!String(area.value ?? '').includes(TOKEN), 'A bearer never lands in B composer (red before the cure)');
  assert.ok(!mount.textContent.includes(URL), 'no trace of A link on B screen');

  // Nothing is lost: back on A the minted link is staged, not sent.
  await view.renderCard('contact', 'c1');
  await flush();
  const back = mount.findAll('a').find((node) => node.getAttribute('href') === URL);
  assert.ok(back, 'the link stayed staged for A (kept by quote, reused on reopen)');
  assert.ok(mount.textContent.includes('Link già pronto, da inviare'), 'A reuses it on reopen, in the offer page words (backlog:19adbbb982ef)');
});

/**
 * backlog:e5de90ac5daf — NON PASSA in produzione 25/11: with a live link
 * minted in another session the server answers alreadyExisted with no token
 * (quote-share never resends the bearer), and the scheda pointed at the
 * offer page while the offer page showed no link either. Red before the
 * cure: the scheda reads «aprilo dalla pagina offerta» with no way there.
 * Green after: the single status line reads the same words as the offer
 * page and links «pagina offerta» to the offer page — no toast.
 */
function deadEndShareClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
        return { result: { alreadyExisted: true, token: null, share: { expiresAt: EXPIRES } } };
      }
      if (path.startsWith('/api/customer-hub/card/')) {
        const id = path.split('/').pop();
        return cardOf(id, id === 'c1' ? 'Giulia Verdi' : 'Sara Blu');
      }
      if (path.startsWith('/api/customer-hub/timeline/')) return timelineOf(path.split('/').pop());
      if (path.startsWith('/api/customer-data/profile/')) return profileOf(path.split('/').pop(), { opportunityId: 'off1' });
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

test('e5de90ac5daf: a live link minted elsewhere names «Crea un nuovo link» and links the offer page, with no toast', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client: deadEndShareClient(), spaceId: 'presti', origin: ORIGIN,
    toast: (text) => toasts.push(text),
    wait: () => Promise.resolve(),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  const press = shareButton(mount);
  assert.ok(press, 'the approved quote still offers «Invia offerta»');
  press.dispatch('click');
  await flush();
  const lines = mount.findAll('p')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('offer-share-line'));
  assert.equal(lines.length, 1, 'one status line, never two notices');
  assert.equal(lines[0].textContent, OFFER_SHARE_LIVE_LINK_LOST, 'the scheda reads the same words as the offer page');
  const open = lines[0].findAll('a')
    .find((node) => String(node.getAttribute('href') ?? '').startsWith('#/offerte/off1'));
  assert.ok(open, '«pagina offerta» links the offer page, where «Crea un nuovo link» mints a fresh one');
  assert.deepStrictEqual(toasts, [], 'no toast: the line is the one notice');
});
