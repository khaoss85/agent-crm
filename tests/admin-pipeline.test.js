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

function stubClient(records, { failMove, pipelines } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: pipelines ?? [PIPELINE] };
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
  assert.ok(totals.includes('1.500 €'), `discovery EUR total (${totals.join(' | ')})`);
  assert.ok(totals.includes('25 USD'), 'demo USD total stays separate');

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

test('a failed move restores the control and shows a friendly line, never the server message (C25)', async () => {
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
  assert.ok(error.textContent.includes('Riprova più tardi'), `friendly retry line (${error.textContent})`);
  assert.ok(!error.textContent.includes('Stale move'), 'no raw server message in the DOM');
  assert.ok(!error.textContent.includes('STALE_STAGE'), 'no error code in the DOM');
  assert.equal(card.findAll('select').length, 1, 'the move control is restored');
});

test('move toasts name the stage label and failures stay friendly (C25)', async () => {
  const stages = [
    { key: 'richiesta', label: 'Richiesta', order: 10, type: 'open', probability: 10 },
    { key: 'attesa', label: 'In attesa di risposta', order: 20, type: 'open', probability: 30 },
    { key: 'persa', label: 'Persa', order: 30, type: 'lost', probability: 0 },
  ];
  const pipeline = { ...PIPELINE, name: 'vendita', label: 'Vendita', defaultStage: 'richiesta', stages };
  const rendering = async (failMove) => {
    const doc = createFakeDocument();
    const mount = createMount();
    const toasts = [];
    const calls = [];
    const client = {
      calls,
      async request(path, options = {}) {
        calls.push({ path, method: options.method ?? 'GET', body: options.body });
        if (path === '/api/schema') return { pipelineContract: 1, pipelines: [pipeline] };
        if (options.method === 'POST') {
          if (failMove) throw Object.assign(new Error(failMove.message), failMove);
          return { ok: true };
        }
        return { items: [{ id: 'a', name: 'Offerta A', companyName: 'Rossi', valueCents: 100_000, currency: 'EUR', pipelineKey: 'vendita', pipelineStage: 'richiesta' }] };
      },
    };
    const board = createPipelineBoard({ doc, mount, client, toast: (message) => toasts.push(String(message)) });
    await board.renderBoard('vendita');
    return { doc, mount, toasts, client };
  };

  // Success: the toast names the Italian label, never the stage key.
  {
    const { mount, toasts } = await rendering(null);
    const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
    card.__select.value = 'attesa';
    await card.__move();
    assert.ok(toasts.some((message) => message.includes('Spostata in In attesa di risposta.')), `toast names the label (${toasts.join(' | ')})`);
    assert.ok(!toasts.some((message) => message.includes('Spostata in attesa.')), 'no stage key in the toast');
  }

  // SAME_STAGE: already-there line, no code.
  {
    const { mount, toasts } = await rendering({ message: 'same stage', status: 409, code: 'SAME_STAGE' });
    const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
    card.__select.value = 'attesa';
    await card.__move();
    const error = card.findAll('small').find((n) => (n.getAttribute('class') ?? '') === 'field-error');
    assert.ok(error.textContent.includes('già in questo stato'), `already-there line (${error.textContent})`);
    assert.ok(!error.textContent.includes('SAME_STAGE'), 'no code in the DOM');
    assert.ok(!toasts.some((message) => message.includes('SAME_STAGE')), 'no code in toasts');
  }

  // Missing reason for a lost move: motivo line, no field name.
  {
    const { mount } = await rendering({ message: 'reason is required when moving to the lost stage', status: 400, code: 'VALIDATION', details: { field: 'reason' } });
    const card = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
    card.__select.value = 'persa';
    await card.__move();
    const error = card.findAll('small').find((n) => (n.getAttribute('class') ?? '') === 'field-error');
    assert.ok(error.textContent.includes('motivo'), `motivo line (${error.textContent})`);
    assert.ok(!error.textContent.includes('reason is required'), 'no raw message in the DOM');
  }

  // Unknown pipeline: friendly line, the routed name stays out of the DOM.
  {
    const doc = createFakeDocument();
    const mount = createMount();
    const board = createPipelineBoard({ doc, mount, client: stubClient([]) });
    await board.renderBoard('ghost-pipeline');
    assert.ok(mount.textContent.includes('Nessuna pipeline da mostrare in questo spazio.'), 'friendly missing-pipeline line');
    assert.ok(!mount.textContent.includes('ghost-pipeline'), 'no routed name in the DOM');
  }
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
  assert.ok(mount.textContent.includes("1 offerta di un'altra pipeline."), 'exclusion disclosed in correct Italian');
  const link = mount.findAll('a').find((node) => node.getAttribute('href') === '#/pipelines/another-pipeline');
  assert.ok(link, 'the other pipeline links to its own board');
  assert.equal(link.textContent, 'Vedi another-pipeline');
});

test('the off-pipeline disclosure uses the Italian plural for several records', async () => {
  const records = [
    record('a', 'discovery'),
    { ...record('x', 'discovery'), pipelineKey: 'other' },
    { ...record('y', 'discovery'), pipelineKey: 'other' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');
  assert.ok(mount.textContent.includes('2 offerte di altre pipeline.'), 'plural exclusion disclosed in correct Italian');
  const link = mount.findAll('a').find((node) => node.getAttribute('href') === '#/pipelines/other');
  assert.ok(link, 'the other pipeline links to its own board');
  assert.equal(link.textContent, 'Vedi other');
});

test('with several composed pipelines the board shows a selector instead of the note', async () => {
  const SECOND = {
    pipelineContract: 1,
    name: 'upsell',
    label: 'Upsell',
    module: 'opportunity',
    defaultStage: 'idea',
    stages: [
      { key: 'idea', label: 'Idea', order: 10, type: 'open', probability: 10 },
      { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    ],
  };
  const records = [
    record('a', 'discovery'),
    { ...record('x', 'idea'), pipelineKey: 'upsell' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient(records, { pipelines: [PIPELINE, SECOND] }),
    navigate: (hash) => navigated.push(hash),
  });
  await board.renderBoard('b2b-sales');
  assert.ok(!mount.textContent.includes('non mostrata'), 'no "non mostrata" line with a selector');
  assert.ok(mount.textContent.includes("1 offerta di un'altra pipeline."), 'the count still names the other-board offer');
  const selects = mount.findAll('select').filter((node) => node.getAttribute('id') === 'pipeline-switch');
  assert.equal(selects.length, 1, 'one pipeline selector');
  const labels = selects[0].childNodes.map((option) => option.textContent);
  assert.deepEqual(labels, ['B2B Sales', 'Upsell'], 'one choice per composed pipeline, labeled');
  assert.equal(selects[0].value, 'b2b-sales', 'the current pipeline is selected');
  selects[0].value = 'upsell';
  selects[0].dispatch('change');
  assert.deepEqual(navigated, ['#/pipelines/upsell'], 'choosing a pipeline navigates to its board');
});

test('the selector lists every composed pipeline even when nothing is off-board', async () => {
  const SECOND = { ...PIPELINE, name: 'upsell', label: 'Upsell' };
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient([record('a', 'discovery')], { pipelines: [PIPELINE, SECOND] }),
  });
  await board.renderBoard('b2b-sales');
  assert.equal(mount.findAll('select').filter((node) => node.getAttribute('id') === 'pipeline-switch').length, 1, 'the selector is there with no off-board offer');
  assert.ok(!mount.textContent.includes('offerta di'), 'no exclusion count when everything is on board');
});

test('a hostile pipeline label renders as inert text in the selector', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const EVIL = { ...PIPELINE, name: 'evil', label: hostile };
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient([record('a', 'discovery')], { pipelines: [PIPELINE, EVIL] }),
  });
  await board.renderBoard('b2b-sales');
  const options = mount.findAll('select').filter((node) => node.getAttribute('id') === 'pipeline-switch')[0].childNodes;
  assert.equal(options[1].textContent, hostile, 'the hostile label is text, never markup');
  assert.equal(options[1].childNodes.length, 0, 'no element smuggled through the label');
});

test('with a single composed pipeline there is no selector, only the disclosure', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient([record('a', 'discovery')]) });
  await board.renderBoard('b2b-sales');
  assert.equal(mount.findAll('select').filter((node) => node.getAttribute('id') === 'pipeline-switch').length, 0, 'no selector for a single pipeline');
});

test('the summary counts the shown cards, never the off-pipeline offers', async () => {
  const records = [
    record('a', 'discovery'),
    record('b', 'demo'),
    { ...record('x', 'discovery'), pipelineKey: 'other' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');
  assert.match(summaryText(mount), /2 offerte/, 'the count names the shown cards only');
  assert.ok(!summaryText(mount).includes('3'), 'off-pipeline offers never enter the count');
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
  assert.ok(mount.textContent.includes('Nessuna pipeline da mostrare in questo spazio.'));
  assert.ok(!mount.textContent.includes('ghost-pipeline'), 'the routed name stays out of the DOM');
});

function filterInput(mount, name) {
  return mount.findAll('input').find((node) => node.getAttribute('data-filter') === name);
}

function daysAgo(days) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)).toISOString();
}

/** The pill button of a filter menu (`Referente`, `Creata`, `Stati`). */
function filterPill(mount, key) {
  const menu = mount.findAll('div').find((node) => node.getAttribute('data-filtermenu') === key);
  return menu.findAll('button').find((node) => node.getAttribute('aria-haspopup') === 'menu');
}

/** Click a voice of a filter menu; the board re-renders synchronously. */
function pickVoice(mount, key, value) {
  const menu = mount.findAll('div').find((node) => node.getAttribute('data-filtermenu') === key);
  menu.findAll('button')
    .find((node) => node.getAttribute('data-menu-voice') === key && node.getAttribute('data-value') === value)
    .dispatch('click');
}

function boardRecords() {
  return [
    record('a', 'discovery', { owner: 'alice', expectedCloseDate: '2026-11-01T00:00:00.000Z', contactName: 'Anna', createdAt: daysAgo(2) }),
    record('b', 'discovery', { valueCents: 50_000, owner: 'bob', expectedCloseDate: '2026-12-15T00:00:00.000Z', createdAt: daysAgo(10) }),
    record('c', 'demo', { currency: 'USD', valueCents: 2_500, owner: 'alice', expectedCloseDate: '2026-10-20T00:00:00.000Z', createdAt: daysAgo(40) }),
    record('d', 'won', { owner: 'alice', expectedCloseDate: '2026-09-01T00:00:00.000Z', createdAt: daysAgo(5) }),
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

test('search and the Referente, Creata, Stati pills narrow both views (C8)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');
  assert.match(summaryText(mount), /5 offerte/);
  // C8: the pills carry the prototype labels with the default values.
  assert.ok(filterPill(mount, 'owner').textContent.includes('Referente Tutti'));
  assert.ok(filterPill(mount, 'created').textContent.includes('Creata Sempre'));
  assert.ok(filterPill(mount, 'stage').textContent.includes('Stati Tutti'));

  const search = filterInput(mount, 'q');
  search.value = 'acme';
  search.dispatch('input');
  assert.match(summaryText(mount), /5 offerte/, 'every fixture record matches its company');

  search.value = 'anna';
  search.dispatch('input');
  assert.match(summaryText(mount), /1 offerta/, 'contact-name search narrows to one card');
  search.value = '';
  search.dispatch('input');

  pickVoice(mount, 'owner', 'bob');
  assert.match(summaryText(mount), /2 offerte/, 'Referente pill keeps only bob’s cards');
  assert.ok(filterPill(mount, 'owner').textContent.includes('Referente bob'), 'the pill names the active referente');

  pickVoice(mount, 'stage', 'discovery');
  assert.match(summaryText(mount), /1 offerta/, 'Stati pill intersects with Referente');

  // The Creata pill replaces the raw close-date bounds: creation recency.
  pickVoice(mount, 'owner', '');
  pickVoice(mount, 'stage', '');
  pickVoice(mount, 'created', '7d');
  assert.match(summaryText(mount), /2 offerte/, 'Ultimi 7 giorni keeps the two recent cards');
  pickVoice(mount, 'created', '30d');
  assert.match(summaryText(mount), /3 offerte/, 'Ultimi 30 giorni adds the ten-day-old card');
  assert.ok(filterPill(mount, 'created').textContent.includes('Ultimi 30 giorni'));
  pickVoice(mount, 'created', '');
  assert.match(summaryText(mount), /5 offerte/, 'Sempre restores the full board');
});

test('Azzera filtri resets search and every pill', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  filterInput(mount, 'q').value = 'anna';
  filterInput(mount, 'q').dispatch('input');
  pickVoice(mount, 'owner', 'alice');
  assert.match(summaryText(mount), /1 offerta/);

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'clear-filters').dispatch('click');
  assert.match(summaryText(mount), /5 offerte/, 'every offer is back');
  assert.equal(filterInput(mount, 'q').value, '');
  assert.ok(filterPill(mount, 'owner').textContent.includes('Referente Tutti'));
  assert.ok(filterPill(mount, 'created').textContent.includes('Creata Sempre'));
  assert.ok(filterPill(mount, 'stage').textContent.includes('Stati Tutti'));
});

test('summary totals the filtered set per currency without mixing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  pickVoice(mount, 'owner', 'alice');
  const text = summaryText(mount);
  assert.match(text, /3 offerte/);
  assert.ok(text.includes('2.000 €'), `alice EUR total (${text})`);
  assert.ok(text.includes('25 USD'), `alice USD total stays separate (${text})`);
});

test('forecast shows the month title, won plus 60% of open, and the risk name (C4/C5)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const box = forecastBox(mount);
  assert.ok(box, 'a forecast section exists');
  const months = [
    'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
  ];
  assert.ok(
    box.textContent.includes(`✦ Previsione di ${months[new Date().getMonth()]}`),
    `the title names the current month (${box.textContent})`,
  );
  // EUR: won 100_000 at face value + 60% of open (100_000 + 50_000) = 190_000;
  // USD: 60% of the 2_500 open demo = 1_500; lost stages never forecast.
  assert.ok(box.textContent.includes('1.900 €'), `EUR forecast total (${box.textContent})`);
  assert.ok(box.textContent.includes('15 USD'), `USD forecast total stays separate (${box.textContent})`);
  assert.ok(
    !box.textContent.includes('Il rischio più alto'),
    `no global risk ranking across currencies (Codex P2 on #467) (${box.textContent})`,
  );
  assert.match(box.textContent, /non un impegno/i, 'no guaranteed outcome is promised');
});

test('forecast names the highest-value open offer when one currency is in play', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient([
      record('a', 'discovery', { owner: 'alice' }),
      record('b', 'demo', { valueCents: 50_000, owner: 'bob' }),
    ]),
  });
  await board.renderBoard('b2b-sales');

  const box = forecastBox(mount);
  assert.ok(box, 'a forecast section exists');
  assert.ok(
    box.textContent.includes('Il rischio più alto è alice.'),
    `the risk names the owner of the highest-value open offer (${box.textContent})`,
  );
});

test('forecast with closed offers but no open ones shows totals and no risk line', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient([record('d', 'won'), record('e', 'lost', { closeReason: 'No budget' })]),
  });
  await board.renderBoard('b2b-sales');

  const box = forecastBox(mount);
  assert.ok(box, 'a forecast section exists');
  assert.ok(box.textContent.includes('1.000 €'), `won value at face value (${box.textContent})`);
  assert.ok(!box.textContent.includes('Il rischio più alto'), 'no risk line without open offers');
});

test('forecast with no valued offers stays honest and technical-text free', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({
    doc,
    mount,
    client: stubClient([record('a', 'discovery', { valueCents: undefined })]),
  });
  await board.renderBoard('b2b-sales');

  const box = forecastBox(mount);
  assert.ok(box, 'a forecast section exists');
  assert.ok(box.textContent.includes('Nessuna offerta da stimare'), `empty state (${box.textContent})`);
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
  assert.ok(toasts.some((message) => message.includes('Spostata in Demo.')), 'success is toasted with the stage label');
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
  const menu = mount.findAll('div').find((node) => node.getAttribute('data-filtermenu') === 'owner');
  const voice = menu.findAll('button').find((node) => node.getAttribute('data-value') === hostile);
  assert.ok(voice, 'the hostile owner is offered as plain text');
  const title = voice.findAll('span').find((node) => (node.getAttribute('class') ?? '').includes('ui-add-title'));
  assert.equal(title.textContent, hostile, 'the hostile owner is the voice title');
  assert.equal(title.childNodes.length, 0, 'no elements parsed out of the hostile owner');
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

  pickVoice(mount, 'owner', 'alice');
  pickVoice(mount, 'stage', 'discovery');
  assert.match(summaryText(mount), /1 offerta/, 'board A is filtered to one card');

  await board.renderBoard('b2b-enterprise');
  assert.match(summaryText(mount), /1 offerta/, 'board B shows its own healthy record');
  assert.ok(
    mount.findAll('div').some((node) => node.getAttribute('data-stage') === 'qualify'),
    'board B columns are rendered',
  );
  assert.equal(filterInput(mount, 'q').value, '', 'search does not leak across pipelines');
  assert.ok(filterPill(mount, 'owner').textContent.includes('Referente Tutti'), 'Referente does not leak across pipelines');
  assert.ok(filterPill(mount, 'stage').textContent.includes('Stati Tutti'), 'Stato does not leak across pipelines');
  assert.ok(filterPill(mount, 'created').textContent.includes('Creata Sempre'), 'Creata does not leak across pipelines');
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
  pickVoice(mount, 'owner', 'alice');
  assert.match(summaryText(mount), /^3 offerte · /, 'the summary follows the filter');
  pickVoice(mount, 'owner', '');
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
    'Referente Tutti',
    'Creata Sempre',
    'Stati Tutti',
    'Ultimi 7 giorni',
    'Ultimi 30 giorni',
    'Cerca offerta o cliente',
    '✦ Previsione di ',
    'Nessuna offerta da stimare',
    'non un impegno',
    "Trascina qui un'offerta",
    "1 offerta di un'altra pipeline.",
    'Vedi altra',
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
  assert.ok(toasts.some((message) => message.includes('Spostata in Attesa.')), 'move success is toasted in Italian with the stage label');
  assertNoEnglish('after move');
  const lostColumn = mount.findAll('div').find((n) => n.getAttribute('data-stage') === 'persa');
  await lostColumn.__drop(JSON.stringify({ id: 'a', fromStage: 'richiesta' }));
  const fresh = mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
  assert.equal(fresh.__reason.getAttribute('class'), '', 'the reason input is revealed');
  assert.match(fresh.findAll('small')[0].textContent, /motivo della perdita/, 'the reason prompt is Italian');
  assertNoEnglish('after lost reveal');

  // Lista: headers and the empty-filter message.
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');
  assert.ok(painted().includes('Chiusura'), 'lista header is Italian');
  assert.ok(painted().includes('Valore'), 'lista header is Italian');
  assertNoEnglish('lista');
  const search = mount.findAll('input').find((node) => node.getAttribute('data-filter') === 'q');
  search.value = 'zzz';
  search.dispatch('input');
  assert.ok(painted().includes('Nessuna offerta con questi filtri.'), 'empty lista is Italian');
  assertNoEnglish('lista filtered');
});

test('pipeline lista follows the prototype: headers order, pill, probability, dates (C19, C20, C21)', async () => {
  // BO-F6-10 fetta Lista (backlog:31bed527): intestazioni nell'ordine esatto,
  // pill di stato con pallino, percentuale di probabilità, giorni di chiusura
  // e creazione, referente; messaggio di lista vuota in italiano esatto.
  const records = [
    record('a', 'discovery', {
      name: 'Cucina per Giulia',
      companyName: 'Rossi',
      owner: 'maria',
      valueCents: 27500_00,
      currency: 'EUR',
      expectedCloseDate: '2026-11-20T00:00:00.000Z',
      createdAt: '2026-10-02T09:30:00.000Z',
    }),
    record('b', 'demo', {
      owner: 'giulia',
      expectedCloseDate: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-10-03T10:00:00.000Z',
    }),
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');

  // C19: headers in the prototype order.
  const list = mount.findAll('div').find((node) => node.getAttribute('data-listview') === 'records');
  const headers = list.findAll('th').map((node) => node.textContent);
  assert.deepEqual(
    headers,
    ['Offerta', 'Stato', 'Valore', 'Probabilità', 'Chiusura', 'Creata', 'Referente'],
    'C19: lista headers follow the prototype order',
  );

  // C20: one row carries the state pill with its dot, value, probability,
  // close day, creation day and referente.
  const row = list.findAll('tr').find((node) => node.getAttribute('data-record') === 'a');
  const cells = row.findAll('td');
  assert.equal(cells.length, 7, 'one cell per header');
  assert.ok(cells[0].textContent.includes('Cucina per Giulia'), 'offerta shows the record title');
  assert.ok(cells[1].textContent.includes('Discovery'), 'stato shows the stage label');
  assert.ok(
    cells[1].findAll('span').some((node) => (node.getAttribute('class') ?? '').includes('stage-dot')),
    'stato pill carries its dot hook',
  );
  assert.ok(cells[2].textContent.includes('27.500') || cells[2].textContent.includes('27,500'), `valore shows the amount (${cells[2].textContent})`);
  assert.equal(cells[3].textContent, '10%', 'probabilità shows the discovery stage probability');
  assert.equal(cells[4].textContent, '2026-11-20', 'chiusura shows the expected close day');
  assert.equal(cells[5].textContent, '2026-10-02', 'creata shows the creation day');
  assert.ok(cells[6].textContent.includes('maria'), 'referente shows the owner');

  // C21: an empty filter shows the exact prototype message.
  const search = mount.findAll('input').find((node) => node.getAttribute('data-filter') === 'q');
  search.value = 'zzz-niente';
  search.dispatch('input');
  const emptied = mount.findAll('div').find((node) => node.getAttribute('data-listview') === 'records');
  assert.ok(
    emptied.textContent.includes('Nessuna offerta con questi filtri.'),
    'C21: empty lista message is the prototype text',
  );
});

test('empty kanban columns invite a drop and columns mark the hovered target (C12, C16, C18)', async () => {
  // BO-F6-10 (backlog:31bed527): ogni colonna ha il pallino (gancio markup,
  // colore in CSS), le colonne vuote invitano al trascinamento e la colonna
  // di destinazione si marca durante il passaggio.
  const records = [record('a', 'discovery', { owner: 'maria' })];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');

  const columns = mount.findAll('div').filter((node) => node.getAttribute('data-stage') !== null);
  assert.ok(columns.length > 0, 'stage columns render');
  for (const column of columns) {
    assert.ok(
      column.findAll('span').some((node) => (node.getAttribute('class') ?? '').includes('stage-dot')),
      'C12: every column header carries the state dot hook',
    );
  }
  const demoColumn = columns.find((node) => node.getAttribute('data-stage') === 'demo');
  assert.ok(demoColumn.textContent.includes("Trascina qui un'offerta"), "C16: empty columns invite a drop");

  // C18: dragover marks the target, dragleave/drop unmark it.
  demoColumn.dispatch('dragover', { preventDefault() {} });
  assert.ok(
    String(demoColumn.getAttribute('class')).split(/\s+/).includes('drop-target'),
    'C18: the hovered column is marked for the dashed outline',
  );
  demoColumn.dispatch('dragleave');
  assert.ok(
    !String(demoColumn.getAttribute('class')).split(/\s+/).includes('drop-target'),
    'leaving the column unmarks it',
  );

  // Review finding on khaoss85/agent-crm#411 (P2): dragleave fires while the
  // pointer moves onto a child card — the pointer still hovers the column,
  // so the mark must stay instead of flickering.
  const marked = (node) => String(node.getAttribute('class')).split(/\s+/).includes('drop-target');
  const liveColumn = columns.find((node) => node.getAttribute('data-stage') === 'discovery');
  const liveCard = liveColumn.findAll('div').find((node) => node.getAttribute('data-record') === 'a');
  liveColumn.dispatch('dragover', { preventDefault() {} });
  liveColumn.dispatch('dragleave', { relatedTarget: liveCard });
  assert.ok(marked(liveColumn), 'moving onto a child card keeps the column marked');
  liveColumn.dispatch('dragleave', { relatedTarget: null });
  assert.ok(!marked(liveColumn), 'leaving the column for good unmarks it');

  // C18: the dragged card is attenuated while it flies.
  const card = mount.findAll('div').find((node) => node.getAttribute('data-record') === 'a');
  card.dispatch('dragstart', { dataTransfer: { setData() {} } });
  assert.ok(
    String(card.getAttribute('class')).split(/\s+/).includes('dragging'),
    'C18: the dragged card is marked while it flies',
  );

  // Review finding on khaoss85/agent-crm#411 (P2): cancelling the drag must
  // not leave a column marked — dragend sweeps every hovered column.
  demoColumn.dispatch('dragover', { preventDefault() {} });
  liveColumn.dispatch('dragover', { preventDefault() {} });
  card.dispatch('dragend');
  assert.ok(
    !String(card.getAttribute('class')).split(/\s+/).includes('dragging'),
    'dropping the card unmarks it',
  );
  assert.ok(!marked(demoColumn) && !marked(liveColumn), 'dragend unmarks every column');
});

test('Azzera filtri appears only while a filter or search is active (C11)', async () => {
  // BO-F6-10 C11 (backlog:31bed527): la voce di reset non offre un no-op.
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(boardRecords()) });
  await board.renderBoard('b2b-sales');

  const resetButton = () => mount.findAll('button').find((node) => node.getAttribute('data-action') === 'clear-filters');
  assert.equal(resetButton(), undefined, 'no reset offered on the unfiltered board');

  pickVoice(mount, 'owner', 'bob');
  assert.ok(resetButton(), 'a filter makes the reset appear');
  assert.match(summaryText(mount), /2 offerte/);

  resetButton().dispatch('click');
  assert.match(summaryText(mount), /5 offerte/, 'reset restores the full board');
  assert.equal(resetButton(), undefined, 'reset disappears once filters are clear');
});

test('kanban cards follow the prototype: chiusura label and referente initials badge (C13, C15)', async () => {
  // BO-F6-10 (backlog:31bed527): la card mostra l'etichetta `chiusura <data>`
  // e il badge del referente con le iniziali; il nome intero resta nel
  // titolo accessibile. Nessun controllo nuovo, solo testo.
  const records = [
    record('a', 'discovery', {
      name: 'Cucina per Giulia',
      companyName: 'Rossi',
      owner: 'Maria Rossi',
      expectedCloseDate: '2026-11-20T00:00:00.000Z',
    }),
    record('b', 'demo', { owner: 'maria', expectedCloseDate: '2026-12-01T00:00:00.000Z' }),
    record('c', 'demo', { owner: 'pluto' }),
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient(records) });
  await board.renderBoard('b2b-sales');

  const ownerOf = (id) => mount.findAll('p')
    .filter((n) => (n.getAttribute('class') ?? '') === 'card-owner')
    .find((n) => n.textContent === ({ a: 'MR', b: 'M', c: 'P' })[id]);
  const cardA = ownerOf('a');
  assert.ok(cardA, 'card a shows the referente initials');
  assert.equal(cardA.getAttribute('title'), 'Maria Rossi', 'the badge title names the referente');
  assert.equal(ownerOf('b').getAttribute('title'), 'maria', 'single-word names keep their title');
  assert.equal(ownerOf('c').textContent, 'P', 'single-word names badge the first letter');

  const closeOf = (id) => mount.findAll('div')
    .find((n) => n.getAttribute('data-record') === id)
    .findAll('p').find((n) => (n.getAttribute('class') ?? '') === 'card-close');
  assert.equal(closeOf('a')?.textContent, 'chiusura 2026-11-20', 'C13: close line follows `chiusura <data>`');
  assert.equal(closeOf('b')?.textContent, 'chiusura 2026-12-01', 'C13: close line on every dated card');
  assert.equal(closeOf('c'), undefined, 'cards without a close date show no close line');
});

function newOfferMenu(mount) {
  return mount.findAll('div').find((node) => node.getAttribute('data-newoffer') === 'menu');
}

function newOfferButton(menu) {
  return menu.findAll('button').find((node) => node.getAttribute('data-action') === 'new-offer');
}

function newOfferVoices(menu) {
  return menu.findAll('button').filter((node) => node.getAttribute('data-voice') !== null);
}

test('Nuova offerta button sits under the description with the two prototype voices (C3)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: stubClient([record('a', 'discovery')]) });
  await board.renderBoard('b2b-sales');

  const menu = newOfferMenu(mount);
  assert.ok(menu, 'a Nuova offerta menu exists');
  const button = newOfferButton(menu);
  assert.ok(button.textContent.includes('Nuova offerta'), 'the green button is labelled');
  assert.ok((button.getAttribute('class') ?? '').includes('ui-btn-cta'), 'the button uses the green cta variant');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false', 'the menu starts closed');
  const panel = menu.findAll('div').find((node) => (node.getAttribute('class') ?? '').includes('ui-add-menu'));
  assert.ok(panel, 'the voices live in the shared add menu');
  assert.ok((panel.getAttribute('class') ?? '').split(/\s+/).includes('hidden'), 'the menu starts hidden');

  button.dispatch('click');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the button opens the menu');
  assert.ok(!(panel.getAttribute('class') ?? '').split(/\s+/).includes('hidden'), 'the menu is visible');

  const voices = newOfferVoices(menu);
  assert.equal(voices.length, 2, 'exactly the two prototype voices');
  const ai = voices.find((voice) => voice.getAttribute('data-voice') === 'ai');
  const manual = voices.find((voice) => voice.getAttribute('data-voice') === 'manual');
  assert.ok(ai.textContent.includes("Crea con l'AI"), 'AI voice title');
  assert.ok(ai.textContent.includes('Es. «cucina per Giulia, 27.500 €»'), 'AI voice example');
  assert.ok(manual.textContent.includes('Compila manualmente'), 'manual voice title');
  assert.ok(manual.textContent.includes('Titolo, cliente, valore e scadenza'), 'manual voice line');

  // Escape closes the menu; a second Escape while closed stays closed.
  panel.dispatch('keydown', { key: 'Escape' });
  assert.ok((panel.getAttribute('class') ?? '').split(/\s+/).includes('hidden'), 'Escape closes the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test("Crea con l'AI opens the assistant on the pipeline screen (C3)", async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const asked = [];
  const board = createPipelineBoard({
    doc, mount, client: stubClient([record('a', 'discovery')]),
    onAskAi: (screenId, description) => { asked.push({ screenId, description }); },
  });
  await board.renderBoard('b2b-sales');

  const menu = newOfferMenu(mount);
  newOfferButton(menu).dispatch('click');
  newOfferVoices(menu).find((voice) => voice.getAttribute('data-voice') === 'ai').dispatch('click');
  assert.equal(asked.length, 1, 'the assistant opens once');
  assert.equal(asked[0].screenId, 'pipeline', 'on the pipeline screen');
  assert.ok(typeof asked[0].description === 'string' && asked[0].description.length > 0, 'with a description');
  const panel = menu.findAll('div').find((node) => (node.getAttribute('class') ?? '').includes('ui-add-menu'));
  assert.ok((panel.getAttribute('class') ?? '').split(/\s+/).includes('hidden'), 'picking a voice closes the menu');
});

test('Compila manualmente navigates to the governed create form (C3)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const board = createPipelineBoard({
    doc, mount, client: stubClient([record('a', 'discovery')]),
    navigate: (hash) => { navigated.push(hash); },
  });
  await board.renderBoard('b2b-sales');

  const menu = newOfferMenu(mount);
  newOfferButton(menu).dispatch('click');
  newOfferVoices(menu).find((voice) => voice.getAttribute('data-voice') === 'manual').dispatch('click');
  assert.deepEqual(navigated, ['#/modules/opportunity/new'], 'the module create form, not a local write');
});

test('Nuova offerta voices stay honest without shell seams (C3)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const board = createPipelineBoard({
    doc, mount, client: stubClient([record('a', 'discovery')]),
    toast: (message) => { toasts.push(String(message)); },
  });
  await board.renderBoard('b2b-sales');

  const menu = newOfferMenu(mount);
  newOfferButton(menu).dispatch('click');
  newOfferVoices(menu).find((voice) => voice.getAttribute('data-voice') === 'ai').dispatch('click');
  assert.ok(toasts.some((message) => message.includes('⌘K')), 'AI voice names the AI bar instead of faking it');
  newOfferButton(menu).dispatch('click');
  newOfferVoices(menu).find((voice) => voice.getAttribute('data-voice') === 'manual').dispatch('click');
  assert.ok(toasts.some((message) => message.includes('manuale')), 'manual voice says it cannot create instead of writing');
});
