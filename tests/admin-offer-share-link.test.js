import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { offerShareMessage, offerSharePath, offerShareUrl } from '../apps/admin/public/admin-offer-panel.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:7fa422415232 — VERIFIER_BACK repro: the /bo had no point that uses
 * the quote `share-link` action (supervisor 2026-11-07: NON PASSA nel /bo).
 * On the code before the cure this file is red — the builders do not exist
 * and no «Invia offerta» button paints — and green after it: the offer page
 * mints the public link through `share-link`, shows the ready Italian
 * message, writes «Offerta inviata» in the cronologia, and a second press
 * reuses the same URL instead of minting a new one.
 */

const ORIGIN = 'https://spazio.example';
const TOKEN = 'a'.repeat(64);
const URL = `${ORIGIN}/q/${TOKEN}`;
const EXPIRES = '2026-12-01T10:00:00.000Z';

test('7fa422415232: share builders carry only the token path, never an id or a price', () => {
  assert.equal(offerSharePath(TOKEN), `/q/${TOKEN}`);
  assert.equal(offerSharePath('short'), null, 'not a token, no path');
  assert.equal(offerSharePath(null), null);
  assert.equal(offerShareUrl(ORIGIN, TOKEN), URL);
  assert.equal(offerShareUrl('', TOKEN), null, 'no origin, no URL');
  assert.equal(offerShareUrl(ORIGIN, 'short'), null);
  const message = offerShareMessage({ offerName: 'Cucina per Giulia', url: URL, expiresAt: EXPIRES });
  assert.ok(message.includes('Cucina per Giulia'), 'names the offer');
  assert.ok(message.includes(URL), 'the URL stays whole and tappable');
  assert.ok(message.includes('1 dic'), 'the expiry reads in Italian, never raw ISO');
  assert.ok(!message.includes('q1'), 'never a raw record id');
  assert.ok(!/\\d{4}-\\d{2}-\\d{2}T/.test(message), 'never a raw timestamp');
  const nameless = offerShareMessage({ url: URL });
  assert.ok(nameless.includes('la tua offerta'), 'works without a name');
  assert.equal(offerShareMessage({}), null, 'without a URL there is nothing to send');
});

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
      { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
    ],
  }],
};

const RECORD = {
  id: 'off1',
  name: 'Cucina per Giulia',
  contactName: 'Giulia Verdi',
  contactId: 'c1',
  companyName: null,
  companyId: null,
  pipelineKey: 'b2b-sales',
  pipelineStage: 'discovery',
  stage: 'discovery',
  valueCents: 2750000,
  currency: 'EUR',
  expectedCloseDate: '2026-11-20',
  createdAt: '2026-10-02T09:15:00.000Z',
  updatedAt: '2026-10-28T18:40:00.000Z',
  owner: 'maria',
};

const approvedQuote = (overrides = {}) => ({
  id: 'q1',
  opportunityId: 'off1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'approved',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
  ...overrides,
});

const flushAll = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Stub where the first share-link mint returns a token and later ones reuse. */
function shareClient({ quotes }) {
  const calls = [];
  let mints = 0;
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null, key: options.idempotencyKey ?? null });
      if (path === '/api/schema') return SCHEMA;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && method === 'GET') return { ...RECORD };
      if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
        mints += 1;
        if (mints === 1) return { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } };
        return { result: { alreadyExisted: true, token: null, share: { expiresAt: EXPIRES } } };
      }
      if (path.startsWith('/api/modules/quote/records')) return { items: quotes };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

async function openOfferPage({ quotes }) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = shareClient({ quotes });
  const toasts = [];
  const view = createOfferDetail({
    doc, mount, client, origin: ORIGIN,
    toast: (text, error = false) => toasts.push({ text, error }),
    navigate: () => {},
  });
  await view.renderOfferDetail('off1');
  await flushAll();
  return { mount, client, toasts };
}

const shareButton = (mount) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === 'offer-share-link');

test('7fa422415232: «Invia offerta» mints the public link and reuses it on second press', async () => {
  const { mount, client, toasts } = await openOfferPage({ quotes: [approvedQuote()] });
  const button = shareButton(mount);
  assert.ok(button, 'the approved quote offers «Invia offerta» (red before the cure: no such button)');
  assert.equal(button.textContent, 'Invia offerta');
  button.dispatch('click');
  await flushAll();
  const posts = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/modules/quote/records/q1/actions/share-link');
  assert.equal(posts.length, 1, 'one press mints through the share-link action');
  assert.ok(posts[0].key, 'the mint rides the submission controller key');
  assert.ok(mount.textContent.includes(URL), 'the ready message shows the link');
  assert.ok(mount.textContent.includes('Offerta inviata'), 'an «Offerta inviata» row lands in the cronologia');
  const open = mount.findAll('a').find((node) => node.getAttribute('href') === URL);
  assert.ok(open, 'the history row links the public URL');
  assert.ok(!/[^/]a{64}/.test(mount.textContent.replace(URL, '')), 'the raw token never leaks outside its URL');

  shareButton(mount).dispatch('click');
  await flushAll();
  const reposts = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/modules/quote/records/q1/actions/share-link');
  assert.equal(reposts.length, 2, 'the second press asks the server again');
  const urls = mount.findAll('a')
    .filter((node) => String(node.getAttribute('href') ?? '').startsWith(`${ORIGIN}/q/`))
    .map((node) => node.getAttribute('href'));
  assert.ok(urls.length > 0, 'links still on screen');
  assert.ok(urls.every((href) => href === URL), 'the second press reuses the same URL, never a new one');
  assert.ok(toasts.some((toast) => /stesso/.test(toast.text)), 'the operator is told it is the same link');
});

test('7fa422415232: a draft quote has no share button — only an approved version shares', async () => {
  const { mount } = await openOfferPage({ quotes: [approvedQuote({ status: 'draft' })] });
  assert.equal(shareButton(mount), undefined, 'no dead button on a draft');
});
