import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { shellScreenFor } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:bfc070243427 — offer/quote page follow-up: no empty fields, the
 * sidebar stays highlighted on the preventivo, the two top links never
 * touch. Only the points that do not collide with other items' locked
 * contracts are covered here (the duplicate «Apri il preventivo», the raw
 * policy tag in the history and the «progetto» wording stay as the existing
 * tests lock them — see the item's report).
 */

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    ],
  }],
};

function stubClient(record) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return SCHEMA;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('bfc070243427: an offer without a close date paints no «Chiusura prevista» row', async () => {
  const record = {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: null,
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: stubClient(record) }).renderOfferDetail('off1');
  await flushAll();
  const text = mount.textContent;
  assert.ok(!text.includes('Chiusura prevista'), 'no empty close-date field is shown');
  assert.ok(!text.includes('chiusura prevista —'), 'no empty hero note either');
  assert.ok(text.includes('27.500 €'), 'the value still paints');
});

test('bfc070243427: the sidebar highlights Pipeline on the preventivo, like on the offer', () => {
  assert.deepEqual(shellScreenFor({ view: 'quote-detail' }), { id: 'pipeline', label: 'Preventivo' });
  assert.deepEqual(shellScreenFor({ view: 'offer-detail' }), { id: 'pipeline', label: 'Offerta' });
});

test('bfc070243427: the two top quote links are separated by the stylesheet', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.quote-back + .quote-offer-link'), 'an adjacent-sibling gap keeps «← cliente» and «Apri l’offerta» apart');
});

const OCCASION_QUOTE = (overrides = {}) => ({
  id: 'q1',
  opportunityId: 'off1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'draft',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
  ...overrides,
});

/** backlog:bfc070243427 — the stub behind the repro tests: one offer, its quotes, readable books. */
function reproClient({ record, quotes = [], audit = [], versions = [] } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      // The pilot composes the commercial block: the head carries the quote
      // actions, like on the live page the Mac checked.
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/modules/quote/records')) return { items: quotes };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: versions };
      if (path.startsWith('/api/modules/price-book/records')) {
        return { items: [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] };
      }
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/spine/memberships') return { items: [] };
      return { items: [] };
    },
  };
}

const countOccurrences = (text, needle) => String(text ?? '').split(needle).length - 1;

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (returns:1): the Mac saw
 * «Apri il preventivo» twice on one offer (the head action and the quote
 * card link). One quote already open means one action: the card of that
 * quote drops its own link. RED before the cure (2), GREEN after (1).
 */
test('bfc070243427 repro: a single-quote offer paints one «Apri il preventivo» action', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: null, createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [OCCASION_QUOTE()] }) }).renderOfferDetail('off1');
  await flushAll();
  assert.equal(countOccurrences(mount.textContent, 'Apri il preventivo'), 1, 'one quote on the page, one open action');
  const open = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-open-quote');
  assert.ok(open, 'the head keeps the main open action');
  assert.equal(open.getAttribute('href'), '#/quotes/q1/offerta/off1', 'it opens the quote with the offer as its origin');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17: from the quotes list the top
 * link went to the customer scheda instead of back to the list. The list
 * route names the origin (`#/quotes/<id>/lista`, like the offer page names
 * its scheda origin). RED before the cure (invalid route), GREEN after.
 */
test('bfc070243427 repro: #/quotes/<id>/lista routes to the detail with the list as origin', () => {
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/lista'),
    { view: 'quote-detail', quoteId: 'q1', from: 'quotes' },
    'the list origin rides the route',
  );
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1'),
    { view: 'quote-detail', quoteId: 'q1' },
    'a direct link keeps no origin',
  );
});

test('bfc070243427 repro: from the list the top link goes back to the list, not the customer', async () => {
  const record = OCCASION_QUOTE();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote/records')) return { items: [record] };
      if (path === '/api/opportunities/opp1') {
        return { id: 'opp1', name: 'Pacchetto 10 PT', contactName: 'Giulia Verdi', contactId: 'c1' };
      }
      if (path.startsWith('/api/opportunities')) return { items: [] };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: 'quotes' });
  await flushAll();
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a way back is painted');
  assert.equal(back.getAttribute('href'), '#/quotes', 'it goes back to the list it came from');
  assert.equal(back.textContent, '← Preventivi', 'it says the list, never the customer');
});

test('bfc070243427: inactive commercial functions speak plain words without «progetto»', () => {
  const src = readFileSync(new URL('../apps/admin/public/admin-quotes.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('non è attiva in questo progetto'), 'no «progetto» in inactive messages');
  assert.ok(src.includes('La parte commerciale non è attiva qui.'), 'commercial off message is plain');
  assert.ok(src.includes('La firma non è attiva qui. Per accenderla chiedi al titolare.'), 'signature off message says what to do');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (AC-1): the Mac saw
 * «CREATA DA —». An author the reads cannot name paints no row — like the
 * dateless «Chiusura prevista» — never an empty field. RED before (the row
 * paints «—»), GREEN after (no row). What the cure does not cover: naming
 * an existing-but-unresolved author stays with backlog:a2ea75f705fd and the
 * person-identifier family (backlog:91f4e2f0d650); once they name them, the
 * row paints again.
 */
test('bfc070243427 repro: an unknown author paints no «Creata da» row, never «—»', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [], audit: [] }) }).renderOfferDetail('off1');
  await flushAll();
  assert.ok(!mount.textContent.includes('Creata da'), 'no empty author field');
  assert.ok(mount.textContent.includes('Creata il'), 'the dated facts stay');
});

test('bfc070243427: the skeleton with a dateless offer skips «Chiusura prevista» instead of a vanishing bar', async () => {
  const record = {
    id: 'off1',
    name: 'Cucina per Giulia',
    contactName: 'Giulia Verdi',
    companyName: null,
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    valueCents: 2750000,
    currency: 'EUR',
    expectedCloseDate: null,
    createdAt: '2026-10-02T09:15:00.000Z',
    updatedAt: '2026-10-28T18:40:00.000Z',
    owner: 'maria',
  };
  const held = [];
  let releaseHeld = () => {};
  const gate = new Promise((resolve) => { releaseHeld = resolve; });
  const base = stubClient(record);
  const client = {
    request(path, options = {}) {
      if (path === '/api/schema' || path === '/api/spine/memberships' || path.startsWith('/api/modules/price-book/records')) {
        held.push(path);
        return gate.then(() => base.request(path, options));
      }
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll(12);
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the second skeleton (offer read, rest in flight) is on screen');
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the headline is already read');
  assert.ok(!mount.textContent.includes('Chiusura prevista'), 'no close-date row while the date is known to be missing');
  releaseHeld();
  await done;
  await flushAll();
  assert.ok(!mount.textContent.includes('Chiusura prevista'), 'the final paint has no close-date row either');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (OWNER_ANSWER 17/11):
 * «presti-sales-discount@2» a vista. The frozen version names the discount
 * rule in words, never the raw `name@version` id. RED before the cure (the
 * raw id paints), GREEN after.
 */
test('bfc070243427 repro: the frozen version names the rule in words, never the raw id', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const versions = [{
    id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'presti-sales-discount', policyVersion: 2,
    policyDecision: 'auto_approve', decisionReason: null, totalsJson: OCCASION_QUOTE().totalsJson, currency: 'EUR',
  }];
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [OCCASION_QUOTE()], versions }) }).renderOfferDetail('off1');
  await flushAll();
  assert.ok(!mount.textContent.includes('presti-sales-discount@2'), 'no raw rule id on screen');
  assert.ok(mount.textContent.includes('Presti sales discount'), 'the rule reads as words');
  assert.ok(!mount.textContent.includes('Presti sales discount (v2)'), 'no internal version on screen');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-17 (AC-1, cronologia): the Mac
 * saw «da —» in the history. An entry whose actor the reads cannot name
 * paints no «da —» tail — the fact stays, the empty author does not.
 * RED before the cure, GREEN after.
 */
test('bfc070243427 repro: a history entry with an unknown actor paints no «da —» tail', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const audit = [{
    action: 'opportunity.created', actorId: 'ghost-9', actorType: 'user', createdAt: '2026-10-02T09:15:00.000Z',
  }];
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [], audit }) }).renderOfferDetail('off1');
  await flushAll();
  assert.ok(!mount.textContent.includes('da —'), 'no empty author tail in the history');
  assert.ok(mount.textContent.includes('Creata'), 'the creation fact stays');
  assert.ok(!mount.textContent.includes('Creata da'), 'no empty author row in the facts either');
});

/**
 * backlog:bfc070243427 (acceptance «nessun campo vuoto»): an owner the reads
 * cannot name paints no «Referente —» row either — like «Creata da» above.
 * RED before the cure (the row paints «Referente —»), GREEN after. What the
 * cure does not cover: naming an existing-but-unresolved owner stays with
 * backlog:a2ea75f705fd and the person-identifier family (backlog:91f4e2f0d650).
 */
test('bfc070243427 repro: an unknown owner paints no «Referente» row, never «—»', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: null,
  };
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [], audit: [] }) }).renderOfferDetail('off1');
  await flushAll();
  assert.ok(!mount.textContent.includes('Referente'), 'no empty owner field');
  assert.ok(mount.textContent.includes('Stato'), 'the other facts stay');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-18 (returns:2, P2 review
 * rev-agent-crm-1018-af876cb07828): withBusy re-rendered the detail with
 * `{ keep: true }` only, dropping the list origin — after any successful
 * mutation «← Preventivi» flipped back to the customer scheda link.
 * RED before the cure (the way back flips), GREEN after (it stays).
 */
test('bfc070243427 repro: a quote mutation from the list keeps «← Preventivi»', async () => {
  const record = OCCASION_QUOTE({ draftRevision: 3 });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/q1/actions/')) return { ok: true, result: { quote: { ...record } } };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote-line/records')) {
        return { items: [{ id: 'l1', quoteId: 'q1', offerId: 'e1', offerName: 'Pacchetto', position: 1, removed: false, quantity: 1, discountBps: 0, breakdownJson: '[]', netAmountCents: 500000 }] };
      }
      if (path.startsWith('/api/modules/offer/records')) {
        return { items: [{ id: 'e1', priceBookId: 'pb1', name: 'Pacchetto', active: true, quoteEligible: true }] };
      }
      if (path === '/api/opportunities/off1') return { id: 'off1', name: 'Cucina', contactId: 'c1', contactName: 'Giulia Verdi' };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: 'quotes' });
  await flushAll();
  const wayBack = () => mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.equal(wayBack()?.getAttribute('href'), '#/quotes', 'from the list the way back is the list');
  assert.equal(wayBack()?.textContent, '← Preventivi', 'from the list the label is the list');
  const row = mount.findAll('div').find((node) => typeof node.__update === 'function');
  assert.ok(row, 'a draft line exposes its update hook');
  await row.__update();
  await flushAll();
  assert.equal(wayBack()?.getAttribute('href'), '#/quotes', 'a successful mutation keeps the list origin');
  assert.equal(wayBack()?.textContent, '← Preventivi', 'the label stays the list, never the customer');
});

/**
 * backlog:bfc070243427 (OWNER_ANSWER 18/11 punto b): a quote opened from
 * its offer must return to the offer. The route names the offer as the
 * origin (`#/quotes/<id>/offerta/<offer>`), like the list names its own
 * (`#/quotes/<id>/lista`) and the offer names the scheda. RED before the
 * cure (an invalid route), GREEN after.
 */
test('bfc070243427 repro: #/quotes/<id>/offerta/<offer> routes to the detail with the offer as origin', () => {
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/offerta/off1'),
    { view: 'quote-detail', quoteId: 'q1', from: { offer: 'off1' } },
    'the offer origin rides the route',
  );
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/offerta/'),
    { view: 'invalid' },
    'an empty offer origin is invalid, not a lookup',
  );
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/lista'),
    { view: 'quote-detail', quoteId: 'q1', from: 'quotes' },
    'the list origin still rides its own route',
  );
});

/**
 * backlog:bfc070243427 (OWNER_ANSWER 18/11 punto b): from the offer the
 * top link goes back to the offer, never to the customer scheda. RED
 * before the cure (the scheda link), GREEN after.
 */
test('bfc070243427 repro: from the offer the top link goes back to the offer, not the customer', async () => {
  const record = OCCASION_QUOTE({ draftRevision: 3 });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [] };
      if (path === '/api/opportunities/off1') return { id: 'off1', name: 'Cucina', contactId: 'c1', contactName: 'Giulia Verdi' };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: { offer: 'off1' } });
  await flushAll();
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a way back is painted');
  assert.equal(back.getAttribute('href'), '#/offerte/off1', 'it goes back to the offer it came from');
  assert.equal(back.textContent, '← Offerta', 'it says the offer, never the customer');
});

/**
 * backlog:bfc070243427 (OWNER_ANSWER 18/11 punto a): «Tutti i preventivi»
 * reads like the other two top links, with the same gap — never the
 * browser-default purple underline touching «Apri l’offerta». RED before
 * the cure (no rule for quote-list-link in styles.css), GREEN after.
 */
test('bfc070243427 repro: «Tutti i preventivi» reads like the other top links, with the same gap', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.quote-list-link'), 'the list exit has its own rule, never the browser default');
  assert.ok(css.includes('.quote-offer-link + .quote-list-link'), 'the same gap keeps it off «Apri l’offerta»');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-18 (returns:2, AC-4): the
 * skeleton painted six fact cells while the final page paints four, so the
 * Preventivo block jumped. The skeleton keeps the final's grid: a row the
 * final skips is skipped here with the same predicates on the data known
 * so far (an empty team and an empty trail resolve exactly like an unknown
 * name). RED before the cure (5 skeleton cells vs 4 final), GREEN after.
 */
test('bfc070243427 repro: the offer skeleton keeps the final facts grid, no jump', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: null, createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const held = [];
  let releaseHeld = () => {};
  const gate = new Promise((resolve) => { releaseHeld = resolve; });
  const base = stubClient(record);
  const client = {
    request(path, options = {}) {
      if (path === '/api/schema' || path === '/api/spine/memberships' || path.startsWith('/api/modules/price-book/records')) {
        held.push(path);
        return gate.then(() => base.request(path, options));
      }
      return base.request(path, options);
    },
  };
  const factLabels = () => mount.findAll('p')
    .filter((node) => (node.getAttribute('class') ?? '') === 'offer-fact')
    .map((cell) => cell.childNodes[0]?.textContent ?? '');
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll(12);
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the second skeleton (offer read, rest in flight) is on screen');
  const skeletonLabels = factLabels();
  assert.ok(!skeletonLabels.includes('Creata da'), 'the skeleton never holds a row the trail alone could fill');
  releaseHeld();
  await done;
  await flushAll();
  const finalLabels = factLabels();
  assert.deepEqual(skeletonLabels, finalLabels, 'skeleton and final paint the same facts grid');
  assert.ok(!finalLabels.includes('Chiusura prevista'), 'the dateless final still skips the close row');
});

/**
 * backlog:bfc070243427 (OWNER_ANSWER 18/11 punto c): the skeleton sheet
 * reserves the actions row too, so «Modifica» and «Cambia stato» do not
 * push the Preventivo block down when they paint. RED before the cure (no
 * actions placeholder in the skeleton), GREEN after.
 */
test('bfc070243427 repro: the offer skeleton reserves the actions row', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: null, createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const held = [];
  let releaseHeld = () => {};
  const gate = new Promise((resolve) => { releaseHeld = resolve; });
  const base = stubClient(record);
  const client = {
    request(path, options = {}) {
      if (path === '/api/schema' || path === '/api/spine/memberships' || path.startsWith('/api/modules/price-book/records')) {
        held.push(path);
        return gate.then(() => base.request(path, options));
      }
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll(12);
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the second skeleton is on screen');
  const actions = skeleton.childNodes
    .flatMap((node) => (node.getAttribute?.('class') ?? '') === 'bo-offer-sheet' ? node.childNodes : [])
    .filter((node) => (node.getAttribute?.('class') ?? '').split(/\s+/).includes('bo-offer-actions'));
  assert.equal(actions.length, 1, 'the skeleton sheet reserves the actions row');
  releaseHeld();
  await done;
  await flushAll();
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-19 (returns:3) + review muse
 * rev-agent-crm-1049-dc17b566 (3 P2): on every hard reload the Preventivo
 * block fell 81px (364/380px -> 445px, the «←» row missing), and the same
 * cure carried three blocking bugs. Every test below is RED on the code
 * before the cure and GREEN after it.
 */

const ALIAS_QUOTE = (overrides = {}) => OCCASION_QUOTE({ ...overrides });

/** One offer behind the quote-id alias, its quotes, a readable team and trail. */
function aliasClient({ record, quotes, team = [], audit = [] }) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path === '/api/opportunities/q9') throw Object.assign(new Error('Not Found'), { status: 404 });
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return { ...record };
      if (path.startsWith('/api/opportunities?')) return { items: [{ ...record }] };
      if (path === '/api/modules/quote/records/q9') return { ...ALIAS_QUOTE({ id: 'q9', opportunityId: 'off1' }) };
      if (path.startsWith('/api/modules/quote/records')) return { items: quotes };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/modules/price-book/records')) {
        return { items: [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] };
      }
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/spine/memberships') return { items: team };
      return { items: [] };
    },
  };
}

const hasClass = (node, name) => String(node.getAttribute?.('class') ?? '').split(/\s+/).includes(name);

/**
 * backlog:bfc070243427 review P2 (rev-agent-crm-1049-dc17b566): quote-origin
 * links used the raw route offerId, so the alias #/offerte/<quote id>
 * generated wrong #/quotes/<id>/offerta/<quote> hrefs. RED before the cure
 * (every href names q9 as the offer), GREEN after (all name off1).
 */
test('bfc070243427 repro: quote origins ride the resolved offer id, never the raw alias route', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const quotes = [
    ALIAS_QUOTE({ id: 'q-old', opportunityId: 'off1' }),
    ALIAS_QUOTE({ id: 'q-new', opportunityId: 'off1' }),
  ];
  const mount = createMount();
  await createOfferDetail({ doc: createFakeDocument(), mount, client: aliasClient({ record, quotes }) }).renderOfferDetail('q9');
  await flushAll();
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the alias still opens its offer');
  const hrefs = mount.findAll('a')
    .filter((node) => hasClass(node, 'offer-quote-open') || hasClass(node, 'offer-quote-open-main'))
    .map((node) => node.getAttribute('href'));
  assert.ok(hrefs.length >= 2, 'head and card actions are on screen');
  for (const href of hrefs) assert.ok(href.includes('/offerta/off1'), `the origin is the resolved offer: ${href}`);
  assert.ok(!hrefs.some((href) => href.includes('/offerta/q9')), 'no href names the quote as its own offer');
});

/**
 * backlog:bfc070243427 review P2 (rev-agent-crm-1049-dc17b566): a hand-typed
 * offer origin was honored when the quote's opportunity was missing,
 * inventing the exact back-link the page claims is impossible. RED before
 * (an «← Offerta» to the hand-typed deal), GREEN after (no invented link).
 */
test('bfc070243427 repro: a hand-typed offer origin is ignored when the quote names no offer', async () => {
  const record = OCCASION_QUOTE({ opportunityId: null });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: { offer: 'off-estranea' } });
  await flushAll();
  assert.ok(!mount.textContent.includes('← Offerta'), 'no invented way back to a hand-typed deal');
  const hrefs = mount.findAll('a').map((node) => String(node.getAttribute('href') ?? ''));
  assert.ok(!hrefs.some((href) => href.includes('off-estranea')), 'the hand-typed id lands in no link');
});

test('bfc070243427 repro: an unreadable offer never lends its back link to a hand-typed origin', async () => {
  const record = OCCASION_QUOTE({ opportunityId: 'off1' });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path === '/api/opportunities/off1') throw Object.assign(new Error('Server error'), { status: 500 });
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: { offer: 'off1' } });
  await flushAll();
  assert.ok(!mount.textContent.includes('← Offerta'), 'no way back to an offer the page could not read');
});

/**
 * backlog:bfc070243427 VERIFIER_BACK 2026-11-19 + review P2: the skeleton
 * used weaker predicates than the final (empty team, no trail), so a
 * team-resolved «Referente» and a trail-named «Creata da» appeared only in
 * the final paint — and the skeleton missed the «←» row and the
 * «Apri il preventivo» hold, dropping the Preventivo block 81px. RED before
 * the cure (fewer skeleton rows, no holds), GREEN after (same grid).
 * fake-dom has no layout: equal rows under the same classes mean equal
 * pixels under the same stylesheet; the live Mac measures the pixels.
 */
test('bfc070243427 repro: the skeleton holds the final frame — back row, facts grid and open action', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'user-12345',
  };
  const team = [{ subject: 'user-12345', displayName: 'Guido', email: 'guido@example.com' }];
  const audit = [{ action: 'opportunity.created', actorId: 'user-12345', actorType: 'user', createdAt: '2026-10-02T09:15:00.000Z' }];
  const held = [];
  let releaseHeld = () => {};
  const gate = new Promise((resolve) => { releaseHeld = resolve; });
  const base = aliasClient({ record, quotes: [ALIAS_QUOTE()], team, audit });
  const client = {
    request(path, options = {}) {
      if (path === '/api/schema') {
        held.push(path);
        return gate.then(() => base.request(path, options));
      }
      return base.request(path, options);
    },
  };
  const labelsOf = () => mount.findAll('p')
    .filter((node) => hasClass(node, 'offer-fact'))
    .map((cell) => cell.childNodes[0]?.textContent ?? '');
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll(12);
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the refined skeleton (team and trail landed, schema in flight) is on screen');
  const skeletonLabels = labelsOf();
  assert.ok(skeletonLabels.includes('Referente'), 'the team-resolved owner is held, not skipped');
  assert.ok(skeletonLabels.includes('Creata da'), 'the trail-named author is held, not skipped');
  const skeletonBack = skeleton.childNodes.find((node) => hasClass(node, 'quote-back'));
  assert.ok(skeletonBack, 'the skeleton reserves the way-back row with the final class');
  const skeletonHead = skeleton.childNodes
    .flatMap((node) => hasClass(node, 'offer-quotes') ? node.childNodes : [])
    .find((node) => hasClass(node, 'offer-quotes-head'));
  assert.ok(skeletonHead, 'the skeleton quotes card has its head');
  assert.ok(skeletonHead.childNodes.some((node) => hasClass(node, 'offer-quote-open-wait')), 'the skeleton reserves the open-action row');
  releaseHeld();
  await done;
  await flushAll();
  const finalLabels = labelsOf();
  assert.deepEqual(skeletonLabels, finalLabels, 'skeleton and final paint the same facts grid');
  const page = mount.childNodes.find((node) => hasClass(node, 'bo-offer') && node.getAttribute('data-offer-skeleton') !== 'true');
  assert.ok(page, 'the final page replaced the skeleton');
  assert.ok(page.childNodes.some((node) => hasClass(node, 'quote-back')), 'the final keeps the same way-back row');
  const finalHead = page.childNodes
    .flatMap((node) => hasClass(node, 'offer-quotes') ? node.childNodes : [])
    .find((node) => hasClass(node, 'offer-quotes-head'));
  assert.ok(finalHead.childNodes.some((node) => hasClass(node, 'offer-quote-open-main')), 'the final paints the reserved open action');
  assert.equal(finalHead.childNodes[0]?.textContent, 'Preventivo', 'the head title sits where the skeleton held it');
});

/**
 * backlog:bfc070243427 (seguito 19/11, punto 1): scheda → offer → quote →
 * «← Offerta» must return to the scheda-named offer, not to «← Pipeline».
 * The origin rides two levels: the quote route keeps the scheda.
 */
test('bfc070243427: the quote route keeps the scheda two levels deep', () => {
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/offerta/off1/cliente/contact/c1'),
    { view: 'quote-detail', quoteId: 'q1', from: { offer: 'off1', resource: 'contact', subjectId: 'c1' } },
    'the scheda origin rides the quote route',
  );
  assert.deepEqual(
    parseModuleRoute('#/quotes/q1/offerta/off1'),
    { view: 'quote-detail', quoteId: 'q1', from: { offer: 'off1' } },
    'the single level still parses',
  );
  assert.deepEqual(parseModuleRoute('#/quotes/q1/offerta/off1/cliente/c1'), { view: 'invalid' }, 'a short scheda suffix is invalid');
});

test('bfc070243427 repro: scheda → offer → quote → «← Offerta» returns to the scheda-named offer', async () => {
  const record = OCCASION_QUOTE({ draftRevision: 3 });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [] };
      if (path === '/api/opportunities/off1') return { id: 'off1', name: 'Cucina', contactId: 'c1', contactName: 'Giulia Verdi' };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client })
    .renderQuoteDetail('q1', { from: { offer: 'off1', resource: 'contact', subjectId: 'c1' } });
  await flushAll();
  const back = mount.findAll('a').find((node) => hasClass(node, 'quote-back'));
  assert.ok(back, 'a way back is painted');
  assert.equal(back.getAttribute('href'), '#/offerte/off1/cliente/contact/c1', 'it returns to the scheda-named offer');
  assert.equal(back.textContent, '← Offerta', 'it says the offer');
});

test('bfc070243427: the offer page carries its scheda origin into every quote href', async () => {
  const record = {
    id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
    pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
    expectedCloseDate: null, createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: reproClient({ record, quotes: [OCCASION_QUOTE()] }) });
  await view.renderOfferDetail('off1', { from: { resource: 'contact', subjectId: 'c1' } });
  await flushAll();
  const hrefs = mount.findAll('a')
    .filter((node) => hasClass(node, 'offer-quote-open') || hasClass(node, 'offer-quote-open-main'))
    .map((node) => node.getAttribute('href'));
  assert.ok(hrefs.length >= 1, 'an open action is on screen');
  for (const href of hrefs) assert.ok(href.endsWith('/offerta/off1/cliente/contact/c1'), `the scheda rides along: ${href}`);
});

/**
 * backlog:bfc070243427 (seguito 19/11, punto 2): from the offer «← Offerta»
 * and «Apri l’offerta →» land on the same address — one link, the way back.
 */
test('bfc070243427: from the offer a single «← Offerta» replaces the doubled top link', async () => {
  const record = OCCASION_QUOTE({ draftRevision: 3 });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { ...SCHEMA, commercial: {} };
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [] };
      if (path === '/api/opportunities/off1') return { id: 'off1', name: 'Cucina', contactId: 'c1', contactName: 'Giulia Verdi' };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1', { from: { offer: 'off1' } });
  await flushAll();
  const back = mount.findAll('a').find((node) => hasClass(node, 'quote-back'));
  assert.equal(back?.getAttribute('href'), '#/offerte/off1', 'the way back stays the offer');
  assert.equal(mount.findAll('a').filter((node) => hasClass(node, 'quote-offer-link')).length, 0, 'no second link to the same address');
  assert.ok(mount.findAll('a').some((node) => hasClass(node, 'quote-list-link')), 'the list exit stays');
});
