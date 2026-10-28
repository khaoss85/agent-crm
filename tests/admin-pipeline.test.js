import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The pipeline board renders purely from schema `pipelines` metadata plus the
 * target module's list — these tests drive the view against a stub client so
 * ordering, counts, per-currency totals, badges, move posting and XSS safety
 * are asserted precisely. The full HTTP path is covered by
 * tests/opportunity-pipeline-e2e.test.js.
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
  stages: [
    { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
};

function record(id, stage, extra = {}) {
  return {
    id,
    name: `Deal ${id}`,
    companyName: 'Acme',
    valueCents: 100_000,
    currency: 'EUR',
    pipelineKey: 'b2b-sales',
    pipelineStage: stage,
    ...extra,
  };
}

function stubClient(records, { failMove } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (options.method === 'POST') {
        if (failMove) throw Object.assign(new Error(failMove.message), failMove);
        return { ok: true };
      }
      return { items: records };
    },
  };
}

test('board renders columns in stage order with counts, badges and per-currency totals', async () => {
  const records = [
    record('a', 'discovery'),
    record('b', 'discovery', { valueCents: 50_000 }),
    record('c', 'demo', { currency: 'USD', valueCents: 2_500 }),
    record('d', 'won'),
    record('e', 'lost', { closeReason: 'No budget' }),
    { ...record('x', 'discovery'), pipelineKey: 'other' }, // not on this board
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');

  const columns = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').includes('pipeline-column ') || (node.getAttribute('class') ?? '').startsWith('pipeline-column'));
  const stageOrder = columns.map((column) => column.getAttribute('data-stage')).filter(Boolean);
  assert.deepEqual(stageOrder, ['discovery', 'demo', 'won', 'lost'], 'deterministic stage order');

  // Counts per column (the off-board record is excluded).
  const countOf = (stage) => mount.findAll('span').find((n) => n.getAttribute('data-count') === stage).textContent;
  assert.equal(countOf('discovery'), '2');
  assert.equal(countOf('demo'), '1');
  assert.equal(countOf('won'), '1');

  // Badges distinguish types with text, not color alone.
  const badges = mount.findAll('span').filter((n) => (n.getAttribute('class') ?? '').includes('stage-type')).map((n) => n.textContent);
  assert.deepEqual(badges, ['Aperta', 'Aperta', 'Vinta ✓', 'Persa ✕']);

  // Per-currency totals: EUR and USD never summed together.
  const totals = mount.findAll('p').filter((n) => (n.getAttribute('class') ?? '') === 'stage-total').map((n) => n.textContent);
  assert.ok(totals.includes('EUR 1,500.00'), `discovery EUR total (${totals.join(' | ')})`);
  assert.ok(totals.includes('USD 25.00'), 'demo USD total stays separate');

  // Lost card shows its reason; terminal cards have no move control.
  const lostCard = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'e');
  assert.ok(lostCard.textContent.includes('No budget'));
  assert.equal(lostCard.findAll('select').length, 0, 'no move control on terminal cards');
});

test('moving a card posts the same server action with the optimistic fromStage', async () => {
  const records = [record('a', 'discovery')];
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(records);
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');

  const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  card.__select.value = 'demo';
  await card.__move();

  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/opportunity/records/a/actions/move-stage');
  assert.deepEqual(JSON.parse(post.body), { toStage: 'demo', fromStage: 'discovery' });
});

test('a failed move restores the control and shows the server message as text', async () => {
  const records = [record('a', 'discovery')];
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(records, {
    failMove: { message: 'Stale move: expected "discovery"', status: 409, code: 'STALE_STAGE' },
  });
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');

  const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  card.__select.value = 'demo';
  await card.__move();
  const error = card.findAll('small').find((n) => (n.getAttribute('class') ?? '') === 'field-error');
  assert.match(error.textContent, /Stale move/);
});

test('drifted records are shown in an explicit off-definition section, never hidden', async () => {
  const records = [
    record('a', 'discovery'),
    record('b', 'renamed-away'),           // stage key no longer in the definition
    record('c', 'demo'),
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');

  const drift = mount.findAll('div').find((n) => n.getAttribute('data-drift') !== null);
  assert.ok(drift, 'an off-definition section exists');
  assert.equal(drift.getAttribute('data-drift'), '1');
  assert.ok(drift.textContent.includes('Deal b'));
  assert.ok(drift.textContent.includes('renamed-away'), 'the stored stage key is shown verbatim');
  assert.ok(drift.textContent.includes('migrazione dati esplicita'), 'the migration guidance is shown');
  // The drifted record is not silently counted into any stage column.
  const countOf = (stage) => mount.findAll('span').find((n) => n.getAttribute('data-count') === stage).textContent;
  assert.equal(countOf('discovery'), '1');
  assert.equal(countOf('demo'), '1');
});

test('the board discloses truncation and excluded off-pipeline records', async () => {
  // Exactly BOARD_LIMIT (200) records triggers the truncation notice.
  const many = Array.from({ length: 199 }, (_, i) => record(`r${i}`, 'discovery'));
  many.push({ ...record('other', 'discovery'), pipelineKey: 'another-pipeline' });
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(many) });
  await board.renderBoard('b2b-sales');
  assert.ok(mount.textContent.includes('Mostro solo i primi 200 record'), 'truncation disclosed');
  assert.ok(mount.textContent.includes('1 record non in questa pipeline (non mostrato)'), 'exclusion disclosed');
});

test('hostile stage labels and record values render as inert text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      if (path === '/api/schema') {
        return {
          pipelineContract: 1,
          pipelines: [{
            ...PIPELINE,
            label: hostile,
            stages: PIPELINE.stages.map((stage) => ({ ...stage, label: hostile })),
          }],
        };
      }
      if (options.method === 'POST') return { ok: true };
      return { items: [record('a', 'discovery', { name: hostile, companyName: hostile })] };
    },
  };
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');
  // BO-F6-10 C1: page chrome is fixed spec text, never pipeline data — the
  // hostile pipeline label must not reach the heading.
  const heading = mount.findAll('h2')[0];
  assert.equal(heading.textContent, 'Offerte', 'the title is fixed spec text');
  for (const chrome of [...mount.findAll('h2'), ...mount.findAll('p').filter((node) => ['kicker', 'lede'].includes(node.getAttribute('class')))]) {
    assert.ok(!chrome.textContent.includes(hostile), 'pipeline data never reaches the page chrome');
  }
  const hostileHeader = mount.findAll('h3').find((node) => node.textContent === hostile);
  assert.ok(hostileHeader, 'the hostile stage label paints as a column header');
  assert.equal(hostileHeader.childNodes.length, 0, 'no elements parsed out of the hostile label');
  const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  assert.ok(card.textContent.includes(hostile));
});

test('unsupported contract and unknown pipeline fail gracefully', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const boardOld = createPipelineBoard({
    doc, mount,
    client: { async request() { return { pipelineContract: 99, pipelines: [] }; } },
  });
  await boardOld.renderBoard('b2b-sales');
  assert.ok(mount.textContent.includes('va aggiornato'));

  const boardMissing = createPipelineBoard({ doc, mount, client: stubClient([]) });
  await boardMissing.renderBoard('ghost-pipeline');
  assert.ok(mount.textContent.includes('Pipeline non trovata'));
});

function filterInput(mount, name) {
  return mount.findAll('input').find((node) => node.getAttribute('data-filter') === name)
    ?? mount.findAll('select').find((node) => node.getAttribute('data-filter') === name);
}

function boardRecords() {
  return [
    record('a', 'discovery', { owner: 'alice', expectedCloseDate: '2026-11-01T00:00:00.000Z', contactName: 'Anna' }),
    record('b', 'discovery', { valueCents: 50_000, owner: 'bob', expectedCloseDate: '2026-12-15T00:00:00.000Z' }),
    record('c', 'demo', { currency: 'USD', valueCents: 2_500, owner: 'alice', expectedCloseDate: '2026-10-20T00:00:00.000Z' }),
    record('d', 'won', { owner: 'alice', expectedCloseDate: '2026-09-01T00:00:00.000Z' }),
    record('e', 'lost', { owner: 'bob', closeReason: 'No budget' }),
  ];
}

function summaryText(mount) {
  return mount.findAll('p').find((node) => node.getAttribute('data-summary') !== null).textContent;
}

function forecastBox(mount) {
  return mount.findAll('div').find((node) => node.getAttribute('data-forecast') === 'estimate');
}

test('Lista view renders the same filtered records as a read-only table', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const listaButton = mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista');
  assert.ok(listaButton, 'a Lista toggle exists');
  listaButton.dispatch('click');
  const list = mount.findAll('div').find((node) => node.getAttribute('data-listview') === 'records');
  assert.ok(list, 'the Lista table replaces the Kanban columns');
  const rows = list.findAll('tr').filter((row) => row.getAttribute('data-record') !== null);
  assert.equal(rows.length, 5, 'all placed records are listed');
  assert.ok(rows[0].textContent.includes('Discovery'), 'stage renders as its label');
  assert.ok(rows[0].textContent.includes('alice'), 'referente is visible');
  assert.ok(rows[0].textContent.includes('2026-11-01'), 'expected close renders as a day');

  const kanbanButton = mount.findAll('button').find((node) => node.getAttribute('data-view') === 'kanban');
  kanbanButton.dispatch('click');
  assert.ok(mount.findAll('div').some((node) => (node.getAttribute('class') ?? '').includes('pipeline-column')),
    'Kanban columns come back');
});

test('search, Referente, Stato and close-date filters narrow both views', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');
  assert.match(summaryText(mount), /5 offerte/);

  const search = filterInput(mount, 'q');
  search.value = 'acme';
  search.dispatch('input');
  assert.match(summaryText(mount), /5 offerte/, 'every fixture record matches its company');

  search.value = 'anna';
  search.dispatch('input');
  assert.match(summaryText(mount), /1 offerta/, 'contact-name search narrows to one card');
  search.value = '';
  search.dispatch('input');

  const owner = filterInput(mount, 'owner');
  owner.value = 'bob';
  owner.dispatch('change');
  assert.match(summaryText(mount), /2 offerte/, 'Referente filter keeps only bob’s cards');

  const stage = filterInput(mount, 'stage');
  stage.value = 'discovery';
  stage.dispatch('change');
  assert.match(summaryText(mount), /1 offerta/, 'Stato filter intersects with Referente');

  const from = filterInput(mount, 'closeFrom');
  from.value = '2026-12-01';
  from.dispatch('change');
  assert.match(summaryText(mount), /1 offerta/, 'close-from keeps the December card');
  const to = filterInput(mount, 'closeTo');
  to.value = '2026-12-31';
  to.dispatch('change');
  assert.match(summaryText(mount), /1 offerta/, 'close-to still matches December');
  to.value = '2026-12-01';
  to.dispatch('change');
  assert.match(summaryText(mount), /0 offerte/, 'a range excluding every date empties the board');
});

test('Azzera filtri resets search and every filter', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  filterInput(mount, 'q').value = 'anna';
  filterInput(mount, 'q').dispatch('input');
  filterInput(mount, 'owner').value = 'alice';
  filterInput(mount, 'owner').dispatch('change');
  assert.match(summaryText(mount), /1 offerta/);

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'clear-filters').dispatch('click');
  assert.match(summaryText(mount), /5 offerte/, 'every offer is back');
  assert.equal(filterInput(mount, 'q').value, '');
  assert.equal(filterInput(mount, 'owner').value, '');
  assert.equal(filterInput(mount, 'stage').value, '');
});

test('summary totals the filtered set per currency without mixing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const owner = filterInput(mount, 'owner');
  owner.value = 'alice';
  owner.dispatch('change');
  const text = summaryText(mount);
  assert.match(text, /3 offerte/);
  assert.ok(text.includes('EUR 2,000.00'), `alice EUR total (${text})`);
  assert.ok(text.includes('USD 25.00'), `alice USD total stays separate (${text})`);
});

test('forecast is labeled as a stima and weights open stages by probability', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const box = forecastBox(mount);
  assert.ok(box, 'a forecast section exists');
  assert.match(box.textContent, /stima/i, 'the forecast is labeled as an estimate');
  assert.match(box.textContent, /non un impegno/i, 'no guaranteed outcome is promised');
  // discovery 100_000 @10% = 10_000 plus 50_000 @10% = 5_000 → EUR 150.00;
  // demo USD 2_500 @30% = 750 → USD 7.50; won/lost stages never forecast.
  assert.ok(box.textContent.includes('EUR 150.00'), `EUR weighted total (${box.textContent})`);
  assert.ok(box.textContent.includes('USD 7.50'), `USD weighted total (${box.textContent})`);
});

test('dropping a card posts the same move-stage action as the Move button', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const client = stubClient(boardRecords());
  const board = createPipelineBoard({ doc, mount, client, toast: (message) => toasts.push(message) });
  await board.renderBoard('b2b-sales');

  const card = mount.findAll('div').find((node) => node.getAttribute('data-record') === 'a');
  assert.equal(card.getAttribute('draggable'), 'true', 'cards are draggable');
  const demoColumn = mount.findAll('div').find((node) => node.getAttribute('data-stage') === 'demo');
  await demoColumn.__drop(JSON.stringify({ id: 'a', fromStage: 'discovery' }));

  const post = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(post.path, '/api/modules/opportunity/records/a/actions/move-stage');
  assert.deepEqual(JSON.parse(post.body), { toStage: 'demo', fromStage: 'discovery' });
  assert.ok(toasts.some((message) => message.includes('Spostata in demo')), 'success is toasted');
});

test('same-stage drops post nothing; drops onto lost ask for a reason first', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(boardRecords());
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');

  const postsBefore = client.calls.filter((call) => call.method === 'POST').length;
  const discoveryColumn = mount.findAll('div').find((node) => node.getAttribute('data-stage') === 'discovery');
  await discoveryColumn.__drop(JSON.stringify({ id: 'a', fromStage: 'discovery' }));
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, postsBefore, 'no stale same-stage move');

  const lostColumn = mount.findAll('div').find((node) => node.getAttribute('data-stage') === 'lost');
  await lostColumn.__drop(JSON.stringify({ id: 'a', fromStage: 'discovery' }));
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, postsBefore, 'no move posted without a reason');
  const card = mount.findAll('div').find((node) => node.getAttribute('data-record') === 'a');
  assert.equal(card.__reason.getAttribute('class'), '', 'the reason input is revealed');
  assert.match(card.findAll('small')[0].textContent, /motivo della perdita/i);
});

test('hostile owner names render as inert option text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const doc = createFakeDocument();
  const mount = createMount();
  const records = [record('a', 'discovery', { owner: hostile })];
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');
  const option = filterInput(mount, 'owner').findAll('option').find((node) => node.textContent === hostile);
  assert.ok(option, 'the hostile owner is offered as plain text');
  assert.equal(option.childNodes.length, 0, 'no elements parsed out of the hostile owner');
});

test('search typing restores focus through the real-DOM query API only', async () => {
  const doc = createFakeDocument();
  const rawCreate = doc.createElement;
  const focused = [];
  doc.createElement = (tag) => {
    const node = rawCreate(tag);
    if (String(tag).toLowerCase() === 'input') {
      node.focus = () => { focused.push(node); };
      node.setSelectionRange = (start, end) => { node.__selection = [start, end]; };
    }
    return node;
  };
  const mount = createMount();
  // The test-double-only API is hidden: production code must never call it
  // (a real Element has no findAll — typing broke in production while the
  // suite stayed green because the fake provided it).
  mount.findAll = undefined;
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const search = mount.querySelector('input[data-filter="q"]');
  assert.ok(search, 'the search input is reachable through querySelector');
  search.value = 'anna';
  search.dispatch('input');

  const current = mount.querySelector('input[data-filter="q"]');
  assert.equal(focused.length, 1, 'focus is handed back after the toolbar rebuild');
  assert.equal(focused[0], current, 'focus lands on the rebuilt search input');
  assert.deepEqual(current.__selection, [4, 4], 'the caret is restored at the end of the typed text');
  assert.equal(current.value, 'anna', 'the typed text survives the rebuild');
  const summary = mount.querySelector('.pipeline-summary');
  assert.match(summary.textContent, /1 offerta/, 'the filter narrows to the matching card');
});

test('switching pipelines resets the previous board’s filters', async () => {
  const pipelineB = {
    ...PIPELINE,
    name: 'b2b-enterprise',
    label: 'B2B Enterprise',
    stages: [
      { key: 'qualify', label: 'Qualify', order: 10, type: 'open', probability: 20 },
      { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    ],
  };
  const records = [
    record('a', 'discovery', { owner: 'alice', pipelineKey: 'b2b-sales' }),
    { ...record('z', 'qualify', { owner: 'bob' }), pipelineKey: 'b2b-enterprise' },
  ];
  const client = {
    calls: [],
    async request(path, options = {}) {
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE, pipelineB] };
      if (options.method === 'POST') return { ok: true };
      return { items: records };
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');

  filterInput(mount, 'owner').value = 'alice';
  filterInput(mount, 'owner').dispatch('change');
  filterInput(mount, 'stage').value = 'discovery';
  filterInput(mount, 'stage').dispatch('change');
  assert.match(summaryText(mount), /1 offerta/, 'board A is filtered to one card');

  await board.renderBoard('b2b-enterprise');
  assert.match(summaryText(mount), /1 offerta/, 'board B shows its own healthy record');
  assert.ok(
    mount.findAll('div').some((node) => node.getAttribute('data-stage') === 'qualify'),
    'board B columns are rendered',
  );
  assert.equal(filterInput(mount, 'q').value, '', 'search does not leak across pipelines');
  assert.equal(filterInput(mount, 'owner').value, '', 'Referente does not leak across pipelines');
  assert.equal(filterInput(mount, 'stage').value, '', 'Stato does not leak across pipelines');
  const enterpriseCard = mount.findAll('div').find((node) => node.getAttribute('data-record') === 'z');
  assert.ok(enterpriseCard, 'the enterprise card is visible, not silently filtered out');
});

test('pipeline routes parse canonically; hostile routes are invalid', () => {
  assert.deepEqual(parseModuleRoute('#/pipelines/b2b-sales'), { view: 'pipeline', pipelineName: 'b2b-sales' });
  for (const bad of ['#/pipelines/__proto__', '#/pipelines/B2B', '#/pipelines/a%2Fb', '#/pipelines/', '#/pipelines/a/b', '#/pipelines/%zz']) {
    assert.equal(parseModuleRoute(bad).view, 'invalid', `expected invalid for ${bad}`);
  }
  assert.equal(parseModuleRoute('#/modules/lead').view, 'list', 'module routes unchanged');
});

test('header follows the BO-F6-10 spec: kicker, title, description, offers summary (C1, C2, C9)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const kicker = mount.findAll('p').find((node) => node.getAttribute('class') === 'kicker');
  assert.equal(kicker?.textContent, 'Pipeline', 'C1: sovratitolo');
  // C1: sovratitolo, titolo e descrizione nell'ordine corretto.
  const siblings = kicker.parentNode.childNodes.filter((node) => typeof node.tagName === 'string');
  assert.deepEqual(
    siblings.slice(0, 3).map((node) => `${node.tagName}:${node.textContent}`),
    [
      'P:Pipeline',
      'H2:Offerte',
      'P:Apri una card per vedere com\u0027\u00e8 composta e costruire l\u0027offerta. Trascinala per cambiarne lo stato.',
    ],
    'C1/C2: kicker, title and description in order',
  );

  // C9: `<n> offerte · <totale>`, aggiornato da filtri e ricerca.
  assert.match(summaryText(mount), /^5 offerte · /, 'summary pattern with count first');
  filterInput(mount, 'owner').value = 'alice';
  filterInput(mount, 'owner').dispatch('change');
  assert.match(summaryText(mount), /^3 offerte · /, 'the summary follows the filter');
  filterInput(mount, 'owner').value = '';
  filterInput(mount, 'owner').dispatch('change');
  assert.match(summaryText(mount), /^5 offerte · /, 'clearing the filter restores the full count');
});

test('the pipeline board renders no raw control', async () => {
  // BO-F6-10 acceptance: nessun button/select/input senza le classi del
  // sistema visivo nella schermata. Every control reaches the DOM through
  // the shared `el` library, which normalizes legacy classes onto `ui-*`.
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');
  // Lista view too: its rows and the rebuilt toolbar stay normalized.
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');

  const raw = [];
  const walk = (node) => {
    const tag = String(node.tagName ?? '').toLowerCase();
    if (['button', 'select', 'input', 'textarea'].includes(tag)) {
      const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) {
        raw.push(`${tag}[${classes.join('.')}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(mount);
  assert.deepEqual(raw, [], 'every pipeline control carries a ui-* system class');
});

test('pipeline chrome renders no shipped English string (backlog:8dc57f67)', async () => {
  // Production accordo-sales stages already carry Italian labels; the board
  // chrome around them must be Italian too. Every string the supervisor saw
  // in English on the production Pipeline page is banned from the render.
  const ITALIAN = {
    pipelineContract: 1,
    name: 'vendita',
    label: 'Vendita',
    module: 'opportunity',
    defaultStage: 'richiesta',
    movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
    stages: [
      { key: 'richiesta', label: 'Richiesta', order: 10, type: 'open', probability: 10 },
      { key: 'attesa', label: 'Attesa', order: 20, type: 'open', probability: 30 },
      { key: 'vinta', label: 'Vinta', order: 50, type: 'won', probability: 100 },
      { key: 'persa', label: 'Persa', order: 60, type: 'lost', probability: 0 },
    ],
  };
  const records = [
    { id: 'a', name: 'Offerta A', companyName: 'Rossi', currency: 'EUR', pipelineKey: 'vendita', pipelineStage: 'richiesta' },
    { id: 'b', name: 'Offerta B', companyName: 'Bianchi', currency: 'EUR', pipelineKey: 'vendita', pipelineStage: 'svincolata' },
    { id: 'c', name: 'Offerta C', companyName: 'Verdi', currency: 'EUR', pipelineKey: 'altra', pipelineStage: 'richiesta' },
  ];
  const toasts = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [ITALIAN] };
      if (options.method === 'POST') return { ok: true };
      return { items: records };
    },
  };
  const board = createPipelineBoard({ doc, mount, client, toast: (message) => toasts.push(message) });
  await board.renderBoard('vendita');

  const BANNED = [
    'not on this pipeline',
    'Search name, company, contact',
    'Search records',
    'All referenti',
    'All stati',
    'No open value to forecast',
    'No records',
    'not a commitment',
    'Heuristic estimate',
    'Forecast',
    'Moving to Lost',
    'reason for Lost',
    'Move to',
    'Move failed',
    'Moved to',
    'That card moved meanwhile',
    'Enter a reason',
    'Expected close',
    'This Admin needs an update',
    'needs an update to render pipelines',
    'Pipeline not found',
    'Showing the first',
    'not on this board view',
    'Off-definition',
    'stored stage',
    'persistent identifiers',
    'Loading…',
    'Close reason',
    'Reason (required for Lost)',
    'Retry',
    'Open',
    'Won',
    'Lost',
  ];

  /** Painted text: rendered copy plus the attributes a customer reads. */
  const painted = () => {
    const seen = [mount.textContent, ...toasts];
    const walkAttrs = (node) => {
      if (typeof node.getAttribute === 'function') {
        for (const attr of ['placeholder', 'aria-label']) {
          const value = node.getAttribute(attr);
          if (value) seen.push(value);
        }
      }
      for (const child of node.childNodes ?? []) walkAttrs(child);
    };
    walkAttrs(mount);
    return seen.join('\n');
  };
  const assertNoEnglish = (where) => {
    const text = painted();
    for (const banned of BANNED) {
      assert.ok(!text.includes(banned), `${where}: no «${banned}» renders`);
    }
  };

  // Kanban: badges, filters, forecast, exclusion, drift and the move control.
  const badges = mount.findAll('span').filter((n) => (n.getAttribute('class') ?? '').includes('stage-type')).map((n) => n.textContent);
  assert.deepEqual(badges, ['Aperta', 'Aperta', 'Vinta ✓', 'Persa ✕'], 'column badges are Italian');
  assertNoEnglish('kanban');
  for (const italian of [
    'Tutti i referenti',
    'Tutti gli stati',
    'Cerca nome, azienda, contatto',
    'Previsione · stima',
    'Nessun valore aperto da stimare',
    'non un impegno',
    'Nessun record.',
    '1 record non in questa pipeline (non mostrato).',
    'Fuori definizione (1)',
    'fase registrata: svincolata',
    'Sposta in',
    'Sposta',
    'Motivo (obbligatorio per la perdita)',
    '1 offerta',
  ]) {
    assert.ok(painted().includes(italian), `kanban shows «${italian}»`);
  }

  // Move toast and the lost-reason reveal are customer-facing too.
  const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  card.__select.value = 'attesa';
  await card.__move();
  assert.ok(toasts.some((message) => message.includes('Spostata in attesa.')), 'move success is toasted in Italian');
  assertNoEnglish('after move');
  const lostColumn = mount.findAll('div').find((n) => n.getAttribute('data-stage') === 'persa');
  await lostColumn.__drop(JSON.stringify({ id: 'a', fromStage: 'attesa' }));
  const fresh = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  assert.equal(fresh.__reason.getAttribute('class'), '', 'the reason input is revealed');
  assert.match(fresh.findAll('small')[0].textContent, /motivo della perdita/, 'the reason prompt is Italian');
  assertNoEnglish('after lost reveal');

  // Lista: headers and the empty-filter message.
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');
  assert.ok(painted().includes('Chiusura prevista'), 'lista header is Italian');
  assert.ok(painted().includes('Valore'), 'lista header is Italian');
  assertNoEnglish('lista');
  const search = mount.findAll('input').find((node) => node.getAttribute('data-filter') === 'q');
  search.value = 'zzz';
  search.dispatch('input');
  assert.ok(painted().includes('Nessun record corrisponde ai filtri attivi.'), 'empty lista is Italian');
  assertNoEnglish('lista filtered');
});
});
