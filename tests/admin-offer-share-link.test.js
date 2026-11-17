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
 * message, never paints a mint as «Offerta inviata» inside the server-audit
 * cronologia (review Muse #905 P1), and a second press reuses the same URL
 * instead of minting a new one.
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
  assert.equal(offerShareUrl('http://spazio.example', TOKEN), 'http://spazio.example/q/' + TOKEN, 'http stays usable');
  assert.equal(offerShareUrl('https://spazio.example///', TOKEN), URL, 'trailing slashes never double the path slash');
  assert.equal(offerShareUrl('HTTPS://spazio.example', TOKEN), null, 'scheme match stays case-sensitive, as before the cure');
  assert.equal(offerShareUrl('ftp://spazio.example', TOKEN), null, 'only http(s) origins mint a URL');
  assert.equal(offerShareUrl(null, TOKEN), null, 'a missing origin is no URL, never a throw');
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

const TOKEN2 = 'b'.repeat(64);
const URL2 = `${ORIGIN}/q/${TOKEN2}`;

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
      if (path === '/api/modules/quote/records/q1/actions/regenerate-link' && method === 'POST') {
        return { result: { alreadyExisted: false, regenerated: true, token: TOKEN2, share: { expiresAt: EXPIRES } } };
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

const regenButton = (mount) => mount.findAll('button')
  .find((node) => String(node.getAttribute('data-action') ?? '').startsWith('offer-share-regenerate')
    && node.getAttribute('data-action') !== 'offer-share-regenerate-cancel');
const regenCancel = (mount) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === 'offer-share-regenerate-cancel');

const historyPanel = (mount) => mount.findAll('div')
  .find((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('offer-history'));
const shareBox = (mount) => mount.findAll('div')
  .find((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('offer-share'));

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
  assert.ok(shareBox(mount)?.textContent.includes('Link pronto, da inviare.'),
    'the mint state reads in the share box, outside the audit list');
  assert.ok(!mount.textContent.includes('Offerta inviata'),
    'a mint is never an «Offerta inviata» send (red before the review cure)');
  const history = historyPanel(mount);
  assert.ok(history, 'the server-audit cronologia still paints');
  assert.ok(!history.findAll('a').some((node) => node.getAttribute('href') === URL),
    'no minted link leaks into the cronologia');
  const open = mount.findAll('a').find((node) => node.getAttribute('href') === URL);
  assert.ok(open, 'the share box links the public URL');
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
  assert.ok(shareBox(mount)?.textContent.includes('Link già pronto, da inviare'),
    'a reuse reads as a mint, never as a send');
  assert.ok(!historyPanel(mount).textContent.includes('Offerta inviata'), 'still no fake send row after reuse');
  assert.ok(toasts.some((toast) => /stesso/.test(toast.text)), 'the operator is told it is the same link');
});

test('7fa422415232: a draft quote has no share button — only an approved version shares', async () => {
  const { mount } = await openOfferPage({ quotes: [approvedQuote({ status: 'draft' })] });
  assert.equal(shareButton(mount), undefined, 'no dead button on a draft');
});

test('bf1bc20a: a reuse without a visible token points at «Crea un nuovo link»', async () => {
  const { mount } = await openOfferPage({ quotes: [approvedQuote()] });
  shareButton(mount).dispatch('click');
  await flushAll();
  shareButton(mount).dispatch('click');
  await flushAll();
  assert.ok(mount.textContent.includes('Crea un nuovo link'),
    'the lost-token message names the way out, never a bare «cercalo nella cronologia»');
});

test('bf1bc20a: «Crea un nuovo link» arms, cancels, then revokes and mints one fresh link', async () => {
  const { mount, client, toasts } = await openOfferPage({ quotes: [approvedQuote()] });
  const button = regenButton(mount);
  assert.ok(button, 'the approved quote offers «Crea un nuovo link»');
  assert.equal(button.textContent, 'Crea un nuovo link');

  button.dispatch('click');
  await flushAll();
  assert.equal(regenButton(mount).textContent, 'Sì, crea un nuovo link', 'the first press arms, never mints');
  assert.ok(mount.textContent.includes('smetterà di funzionare'), 'the arm names what happens to the old link');
  assert.ok(regenCancel(mount), 'arming shows «Annulla»');
  assert.equal(
    client.calls.filter((call) => call.path.endsWith('/actions/regenerate-link')).length,
    0,
    'arming sends nothing',
  );

  regenCancel(mount).dispatch('click');
  await flushAll();
  assert.equal(regenButton(mount).textContent, 'Crea un nuovo link', '«Annulla» disarms');
  assert.equal(regenCancel(mount), undefined, 'the cancel goes away with the arm');
  assert.equal(
    client.calls.filter((call) => call.path.endsWith('/actions/regenerate-link')).length,
    0,
    'a cancelled arm sends nothing',
  );

  regenButton(mount).dispatch('click');
  await flushAll();
  regenButton(mount).dispatch('click');
  await flushAll();
  const regens = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/modules/quote/records/q1/actions/regenerate-link');
  assert.equal(regens.length, 1, 'one confirmed press mints one link through regenerate-link');
  assert.ok(regens[0].key, 'the regenerate rides the submission controller key');
  assert.ok(mount.textContent.includes(URL2), 'the fresh link shows on screen');
  assert.ok(shareBox(mount)?.textContent.includes('il vecchio non funziona più'),
    'the operator is told the old link is dead');
  assert.ok(toasts.some((toast) => /vecchio non funziona più/.test(toast.text)), 'toast says the same');
});

async function openOfferPageWith(request) {
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const client = {
    calls,
    request: (path, options = {}) => {
      calls.push({ path, method: String(options.method ?? 'GET').toUpperCase() });
      return request(path, options);
    },
  };
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

function baseStaticRequest(request) {
  return async (path, options = {}) => {
    enforceAdminWriteGate(path, options);
    const method = String(options.method ?? 'GET').toUpperCase();
    if (path === '/api/schema') return SCHEMA;
    if (/^\/api\/opportunities\/[^/?]+$/.test(path) && method === 'GET') return { ...RECORD };
    const answer = await request(path, { ...options, method });
    return answer;
  };
}

test('bf1bc20a: a share answer landing after regeneration never paints the revoked link (Codex #995 P2)', async () => {
  let releaseShare;
  const shareWait = new Promise((resolve) => { releaseShare = resolve; });
  const request = baseStaticRequest(async (path, { method }) => {
    if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
      await shareWait;
      return { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } };
    }
    if (path === '/api/modules/quote/records/q1/actions/regenerate-link' && method === 'POST') {
      return { result: { alreadyExisted: false, regenerated: true, token: TOKEN2, share: { expiresAt: EXPIRES } } };
    }
    if (path.startsWith('/api/modules/quote/records')) return { items: [approvedQuote()] };
    if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
    if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
    if (path.startsWith('/api/audit')) return { items: [] };
    return { items: [] };
  });
  const { mount } = await openOfferPageWith(request);
  shareButton(mount).dispatch('click');
  await flushAll(2);
  regenButton(mount).dispatch('click');
  await flushAll(2);
  regenButton(mount).dispatch('click');
  await flushAll();
  assert.ok(mount.textContent.includes(URL2), 'the regenerated link paints first');
  releaseShare();
  await flushAll();
  assert.ok(mount.textContent.includes(URL2), 'the regenerated link stays on screen');
  assert.ok(!mount.textContent.includes(URL), 'the late revoked mint never comes back on screen');
});

test('bf1bc20a: an uncertain regeneration forgets the cached link — the next press asks for a new one (Codex #995 P2)', async () => {
  let regens = 0;
  const request = baseStaticRequest(async (path, { method }) => {
    if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
      if (regens === 0) return { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } };
      return { result: { alreadyExisted: true, token: null, share: { expiresAt: EXPIRES } } };
    }
    if (path === '/api/modules/quote/records/q1/actions/regenerate-link' && method === 'POST') {
      regens += 1;
      throw new Error('socket hang up');
    }
    if (path.startsWith('/api/modules/quote/records')) return { items: [approvedQuote()] };
    if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
    if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
    if (path.startsWith('/api/audit')) return { items: [] };
    return { items: [] };
  });
  const { mount } = await openOfferPageWith(request);
  shareButton(mount).dispatch('click');
  await flushAll();
  assert.ok(mount.textContent.includes(URL), 'the first mint caches its link');
  regenButton(mount).dispatch('click');
  await flushAll();
  regenButton(mount).dispatch('click');
  await flushAll();
  shareButton(mount).dispatch('click');
  await flushAll();
  assert.ok(!mount.textContent.includes(URL), 'no revoked link is ever offered as ready');
  assert.ok(mount.textContent.includes('Crea un nuovo link'),
    'after an uncertain regeneration the operator is sent back to a fresh link');
});
