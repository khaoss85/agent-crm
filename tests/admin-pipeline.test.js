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
  assert.deepEqual(badges, ['Open', 'Open', 'Won ✓', 'Lost ✕']);

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
  const heading = mount.findAll('h2')[0];
  assert.equal(heading.textContent, hostile, 'label is inert text');
  assert.equal(heading.childNodes.length, 0, 'no elements parsed out of the hostile label');
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
  assert.ok(mount.textContent.includes('needs an update'));

  const boardMissing = createPipelineBoard({ doc, mount, client: stubClient([]) });
  await boardMissing.renderBoard('ghost-pipeline');
  assert.ok(mount.textContent.includes('Pipeline not found'));
});

test('pipeline routes parse canonically; hostile routes are invalid', () => {
  assert.deepEqual(parseModuleRoute('#/pipelines/b2b-sales'), { view: 'pipeline', pipelineName: 'b2b-sales' });
  for (const bad of ['#/pipelines/__proto__', '#/pipelines/B2B', '#/pipelines/a%2Fb', '#/pipelines/', '#/pipelines/a/b', '#/pipelines/%zz']) {
    assert.equal(parseModuleRoute(bad).view, 'invalid', `expected invalid for ${bad}`);
  }
  assert.equal(parseModuleRoute('#/modules/lead').view, 'list', 'module routes unchanged');
});
