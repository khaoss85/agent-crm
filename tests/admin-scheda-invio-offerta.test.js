import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { offerShareShortLabel } from '../apps/admin/public/admin-offer-panel.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:19adbbb982ef — the scheda «Invia offerta» line reads like the offer
 * page (#1143). Red before the cure: the button had no main weight, the
 * ready link was a system «Apri il link» anchor, and a toast repeated the
 * status line. Green after: «Invia offerta» is the primary action, the link
 * is a short copyable pill with no raw URL in the text, one status line in
 * the offer page words, no toast, and the composer opens with the message.
 */

const ORIGIN = 'https://spazio.example';
const TOKEN = 'c'.repeat(64);
const URL = `${ORIGIN}/q/${TOKEN}`;
const EXPIRES = '2026-12-01T10:00:00.000Z';

const card = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Giulia Verdi',
  company: null,
  phone: { available: false, value: null },
  email: 'giulia@esempio.invalid',
  socials: [],
  status: { value: 'contatto' },
};

const profile = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: { contact: { id: 'c1' } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{
      id: 'q1', status: 'approved', opportunityName: 'Cucina per Giulia', currency: 'EUR',
      totalsJson: JSON.stringify({
        oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
        recurringTotals: [],
      }),
    }],
  },
};

function client() {
  let mints = 0;
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
        mints += 1;
        return mints === 1
          ? { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } }
          : { result: { alreadyExisted: true, token: null, share: { expiresAt: EXPIRES } } };
      }
      if (path.startsWith('/api/customer-hub/card/')) return card;
      if (path.startsWith('/api/customer-hub/timeline/')) {
        return {
          customerTimelineContract: 1, subject: { resource: 'contact', id: 'c1' },
          conversations: { available: true, count: 0, truncated: false, items: [] },
          entries: { available: true, count: 0, truncated: false, items: [] },
          appointments: { available: true, count: 0, truncated: false, items: [] },
        };
      }
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path.startsWith('/api/connectors')) {
        return { connectors: [{ channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' }] };
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

async function openScheda() {
  const doc = createFakeDocument();
  const copied = [];
  doc.defaultView = { navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } } };
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client: client(), spaceId: 'presti', origin: ORIGIN,
    toast: (text) => toasts.push(text), wait: () => Promise.resolve(),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, view, toasts, copied };
}

const classes = (node) => String(node?.getAttribute('class') ?? '').split(/\s+/);
const shareWrap = (mount) => mount.findAll('div').find((node) => classes(node).includes('bo-scheda-share'));
const byAction = (root, action) => root.findAll('button').find((node) => node.getAttribute('data-action') === action);
const statusLines = (root) => root.findAll('p').filter((node) => node.getAttribute('role') === 'status' && node.textContent.trim() !== '');
const composer = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');

test('19adbbb982ef: «Invia offerta» is the main action, the link a short pill, one status line, no toast', async () => {
  const { mount, toasts } = await openScheda();
  const wrap = shareWrap(mount);
  assert.ok(wrap, 'the approved quote paints the share line');
  const button = byAction(wrap, 'scheda-share-link');
  assert.equal(button.textContent, 'Invia offerta');
  assert.ok(classes(button).includes('primary'), 'the main action of the line (red before the cure)');
  assert.equal(statusLines(wrap).length, 0, 'nothing to say before the press');
  button.dispatch('click');
  await flush();
  const pill = wrap.findAll('span').find((node) => classes(node).includes('offer-share-pill'));
  assert.ok(pill, 'the ready link reads as a pill (red before the cure: a system «Apri il link»)');
  const open = pill.findAll('a')[0];
  assert.equal(open.getAttribute('href'), URL, 'the whole URL lives in the href');
  assert.equal(open.textContent, offerShareShortLabel(URL), 'the pill reads short');
  assert.ok(!wrap.textContent.includes(URL), 'no raw URL in the text');
  assert.ok(!wrap.textContent.includes('Apri il link'), 'no system link label');
  const lines = statusLines(wrap);
  assert.equal(lines.length, 1, 'one status line');
  assert.equal(lines[0].textContent, 'Link pronto, da inviare. Messaggio pronto nel composer: premi Invia.',
    'the offer page words');
  assert.deepEqual(toasts, [], 'no toast repeats the status line (red before the cure)');
  const panel = composer(mount);
  assert.ok(panel, 'the composer opens with the message, one press');
  const text = String(panel.findAll('textarea')[0]?.value ?? '');
  assert.ok(text.includes(URL) && text.includes('Cucina per Giulia'), 'the ready message is in the composer');
  const subject = panel.findAll('input').find((node) => classes(node).some((name) => name.includes('subject')));
  assert.equal(subject?.value, 'Offerta «Cucina per Giulia»', 'the email subject names the offer');
});

test('19adbbb982ef: «Copia link» copies the whole URL; a second press reuses it in the same words', async () => {
  const { mount, copied } = await openScheda();
  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  const copy = byAction(shareWrap(mount), 'offer-share-copy-link');
  assert.equal(copy.textContent, 'Copia link');
  copy.dispatch('click');
  await flush();
  assert.deepEqual(copied, [URL], 'the whole URL reaches the clipboard');
  assert.equal(copy.textContent, 'Copiato');
  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  const lines = statusLines(shareWrap(mount));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].textContent.startsWith('Link già pronto, da inviare: è lo stesso di prima.'), 'reuse in the offer page words');
});

test('19adbbb982ef: back on the scheda the ready link shows as the pill, never a system link', async () => {
  const { mount, view } = await openScheda();
  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  await view.renderCard('contact', 'c1');
  await flush();
  const wrap = shareWrap(mount);
  const pill = wrap.findAll('span').find((node) => classes(node).includes('offer-share-pill'));
  assert.equal(pill?.findAll('a')[0]?.getAttribute('href'), URL);
  assert.ok(!wrap.textContent.includes(URL), 'no raw URL in the text');
  assert.equal(statusLines(wrap).length, 1);
  assert.equal(statusLines(wrap)[0].textContent, 'Link già pronto, da inviare: il messaggio è nel composer.');
});

test('19adbbb982ef (review Muse #1157 P1): with the composer already open the subject shows and survives typing', async () => {
  const { mount } = await openScheda();
  // Email first: the composer is open, empty, before «Invia offerta».
  byAction(mount, 'compose-email').dispatch('click');
  await flush();
  const panel = composer(mount);
  assert.ok(panel, 'the composer is open before the press');
  byAction(shareWrap(mount), 'scheda-share-link').dispatch('click');
  await flush();
  const field = (root) => root.findAll('input').find((node) => classes(node).includes('bo-scheda-composer-subject'));
  assert.equal(field(composer(mount))?.value, 'Offerta «Cucina per Giulia»',
    'the open composer shows the offer subject (red before the cure: empty field)');
  // The operator types: the draft keeps what the fields show.
  const area = composer(mount).findAll('textarea')[0];
  area.value = `${area.value} A presto!`;
  area.dispatch('input');
  await flush();
  byAction(composer(mount), 'composer-close').dispatch('click');
  await flush();
  byAction(mount, 'compose-email').dispatch('click');
  await flush();
  assert.equal(field(composer(mount))?.value, 'Offerta «Cucina per Giulia»',
    'the subject survives the first keystroke and a reopen (red before the cure: wiped)');
  assert.ok(String(composer(mount).findAll('textarea')[0]?.value ?? '').endsWith('A presto!'), 'the typed text stays');
});
