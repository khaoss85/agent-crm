// @ts-check

/**
 * Backoffice BO-F5-02 Reporting (backlog:c3e66b36ddb7) — dashboard screen.
 *
 * Drives the real view code with the repo's fake DOM: filters refetch with
 * periodo/persona parameters (ricalcolo, never a client-side slice), the
 * forecast renders the heuristic badge, the proposal reveals with zero
 * requests (it cannot reassign by itself), and hostile owner keys stay text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORTING_CURRENCY,
  barWidth,
  createReportingView,
  currentPeriod,
  dashboardPath,
  formatMoney,
  periodOptions,
} from '../apps/admin/public/admin-reporting.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const MODEL = {
  period: '2026-10',
  periodLabel: 'ottobre 2026',
  owner: null,
  currency: 'EUR',
  currencies: { shown: 'EUR', others: ['USD'] },
  generatedAt: '2026-10-22T20:00:00.000Z',
  metrics: { modelVersion: 1 },
  truncated: false,
  kpis: [
    { id: 'open-value', label: 'Valore pipeline aperto', display: '26.000,00 €', sub: '6 preventivi aperti' },
    { id: 'open-count', label: 'Preventivi aperti', display: '6', sub: '26.000,00 €' },
    { id: 'won-period', label: 'Vinte in ottobre 2026', display: '14.000,00 €', sub: '2 chiusure' },
    { id: 'win-rate', label: 'Tasso di chiusura', display: '67%', sub: '2 vinte, 1 perse' },
    { id: 'closing-period', label: 'In chiusura in ottobre 2026', display: '14.000,00 €', sub: '2 preventivi' },
  ],
  funnel: [
    { stage: 'qualification', label: 'Qualifica', count: 3, minor: 14500 },
    { stage: 'negotiation', label: 'Trattativa', count: 2, minor: 10000 },
    { stage: 'won', label: 'Vinte', count: 2, minor: 14000 },
  ],
  valueByStage: [
    { stage: 'qualification', label: 'Qualifica', count: 3, minor: 14500 },
    { stage: 'negotiation', label: 'Trattativa', count: 2, minor: 10000 },
  ],
  monthly: [
    { month: '2026-09', label: 'settembre 2026', openCount: 1, expectedMinor: 2500, wonCount: 0, wonMinor: 0 },
    { month: '2026-10', label: 'ottobre 2026', openCount: 2, expectedMinor: 14000, wonCount: 2, wonMinor: 14000 },
  ],
  team: [
    { owner: 'alice', openCount: 4, openMinor: 22000, wonCount: 1, wonMinor: 9000, lostCount: 1, winRate: 0.5, winRateDisplay: '50%' },
    { owner: 'bob', openCount: 2, openMinor: 4000, wonCount: 1, wonMinor: 5000, lostCount: 0, winRate: 1, winRateDisplay: '100%' },
  ],
  owners: ['alice', 'bob'],
  forecast: {
    currency: 'EUR', closedMinor: 14000, probableMinor: 9333, bestMinor: 14000, targetMinor: 2000000,
    heuristic: true, label: 'Stima euristica',
    method: 'Le probabili usano il tasso di chiusura storico (vinte su vinte + perse); non è una promessa.',
    note: 'Obiettivo 2.000.000,00 € dal bundle reporting.',
  },
  insights: [
    { id: 'redistribute', text: 'alice tiene molto aperto con il tasso più basso: propone di spostare i lead senza data a bob.' },
  ],
  proposal: {
    title: 'Proposta di ridistribuzione lead',
    moves: [{ from: 'alice', to: 'bob', count: 1, reason: '1 preventivi senza data, tasso 50% contro 100%' }],
    note: 'La proposta non sposta nulla da sola: la riassegnazione resta dell\u2019operatore.',
  },
  csv: { filename: 'reporting-2026-10.csv', content: 'reporting;2026-10;tutti;EUR\nalice;4;22000;1;9000;1;50%\n' },
};

const BUNDLE_ROWS = [{ id: 'r1', metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' }];

/**
 * @param {{dashboard?: any, requests?: string[], downloads?: any[], logLines?: any[]}} [options]
 */
function harness(options = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const requests = options.requests ?? [];
  const downloads = options.downloads ?? [];
  const logLines = options.logLines ?? [];
  const dashboard = options.dashboard ?? MODEL;
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        requests.push(path);
        if (path.includes('/api/reporting/dashboard')) {
          if (dashboard instanceof Error) throw dashboard;
          return dashboard;
        }
        return { items: BUNDLE_ROWS };
      },
    },
    navigate: () => {},
    log: (message, cause) => logLines.push([message, cause]),
    download: (input) => downloads.push(input),
  });
  return { doc, mount, view, requests, downloads, logLines };
}

const tick = async (times = 5) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('period options, dashboard path and bar widths are pure and pinned', () => {
  const options = periodOptions('2026-10-15T00:00:00.000Z');
  assert.deepEqual(options.map((option) => option.value), ['2026-08', '2026-09', '2026-10']);
  assert.ok(options.every((option) => option.label.endsWith('2026')));
  assert.equal(currentPeriod('2026-10-15T10:00:00.000Z'), '2026-10');
  assert.equal(REPORTING_CURRENCY, 'EUR');
  assert.equal(dashboardPath({ period: '2026-10', owner: null }), '/api/reporting/dashboard?period=2026-10&currency=EUR');
  assert.equal(
    dashboardPath({ period: '2026-10', owner: 'maria rossi' }),
    '/api/reporting/dashboard?period=2026-10&currency=EUR&owner=maria+rossi',
  );
  assert.equal(barWidth(50, 100), '50%');
  assert.equal(barWidth(200, 100), '100%');
  assert.equal(barWidth(0, 0), '0%');
  assert.equal(barWidth(5, 0), '0%');
  assert.equal(barWidth(-3, 100), '0%');
  assert.equal(formatMoney(26000, 'EUR'), '260,00 €');
  assert.equal(formatMoney(0, 'USD'), '0,00 USD');
  assert.equal(formatMoney(1.5, 'EUR'), 'n.d.');
  assert.equal(formatMoney(NaN), 'n.d.');
});

test('dashboard renders 5 KPIs, 4 charts, forecast badge, team and insights', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('class') === 'metric').length, 5);
  const text = [
    ...mount.findAll('span'), ...mount.findAll('p'), ...mount.findAll('h3'), ...mount.findAll('td'),
  ].map((node) => node.textContent).join(' | ');
  assert.match(text, /Valore pipeline aperto/);
  assert.match(text, /26\.000,00 €/);
  assert.match(text, /Preventivi/);
  assert.match(text, /Valore per fase/);
  assert.match(text, /Chiusure attese per mese/);
  assert.match(text, /Vendite per persona/);
  assert.match(text, /Stima euristica/);
  assert.match(text, /non è una promessa/);
  assert.match(text, /Team e vendite/);
  assert.match(text, /Cosa noto/);
  assert.ok(mount.findAll('td').map((node) => node.textContent).includes('alice'));
});

test('periodo/persona filters refetch the registry (ricalcolo)', async () => {
  const { mount, view, requests } = harness();
  await view.renderReporting();
  const first = requests.filter((path) => path.includes('/api/reporting/dashboard'));
  assert.equal(first.length, 1);
  assert.match(first[0], /period=/);
  const bob = mount.findAll('button').find((node) => node.textContent === 'bob');
  assert.ok(bob, 'the persona pill renders from the model owners');
  bob.dispatch('click', {});
  await tick();
  const second = requests.filter((path) => path.includes('/api/reporting/dashboard'));
  assert.equal(second.length, 2, 'a persona change refetches instead of slicing cached rows');
  assert.match(second[1], /owner=bob/);
  const oldest = mount.findAll('button').find((node) => node.textContent === periodOptions()[0].label);
  assert.ok(oldest, 'three period pills render');
  oldest.dispatch('click', {});
  await tick();
  const third = requests.filter((path) => path.includes('/api/reporting/dashboard'));
  assert.equal(third.length, 3);
  assert.match(third[2], new RegExp(`period=${periodOptions()[0].value}`));
});

test('the proposal reveals with zero requests: it proposes, never reassigns', async () => {
  const { mount, view, requests } = harness();
  await view.renderReporting();
  const before = requests.length;
  const propose = mount.findAll('button').find((node) => node.textContent === 'Proponi ridistribuzione dei lead');
  assert.ok(propose);
  propose.dispatch('click', {});
  await tick();
  assert.equal(requests.length, before, 'revealing the proposal performs no request');
  const text = [...mount.findAll('li'), ...mount.findAll('p')].map((node) => node.textContent).join(' | ');
  assert.match(text, /1 lead da alice a bob/);
  assert.match(text, /non sposta nulla da sola/);
  propose.dispatch('click', {});
  await tick();
  assert.equal(requests.length, before, 'a second click still performs no request');
  assert.equal(
    mount.findAll('li').filter((node) => /lead da alice a bob/.test(node.textContent)).length,
    1,
    'a second click reveals nothing twice',
  );
});

test('without a proposal the button says so honestly, still with zero requests', async () => {
  const { mount, view, requests } = harness({ dashboard: { ...MODEL, proposal: null, insights: [] } });
  await view.renderReporting();
  const before = requests.length;
  const propose = mount.findAll('button').find((node) => node.textContent === 'Proponi ridistribuzione dei lead');
  assert.ok(propose);
  propose.dispatch('click', {});
  await tick();
  assert.equal(requests.length, before);
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.match(text, /Nessuna ridistribuzione da proporre/);
});

test('Esporta CSV downloads the exact model bytes', async () => {
  const { mount, view, downloads } = harness();
  await view.renderReporting();
  const csv = mount.findAll('button').find((node) => node.textContent === 'Esporta CSV');
  assert.ok(csv);
  csv.dispatch('click', {});
  await tick();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'reporting-2026-10.csv');
  assert.ok(downloads[0].content.includes('alice;4;22000;1;9000;1;50%'));
});

test('hostile owner keys render as text, never markup', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { mount, view } = harness({
    dashboard: {
      ...MODEL,
      owners: [hostile],
      team: [{ owner: hostile, openCount: 1, openMinor: 100, wonCount: 0, wonMinor: 0, lostCount: 0, winRate: null, winRateDisplay: 'n.d.' }],
    },
  });
  await view.renderReporting();
  const cells = mount.findAll('td').map((node) => node.textContent);
  assert.ok(cells.includes(hostile), 'the hostile key is visible as text');
  const buttons = mount.findAll('button').map((node) => node.textContent);
  assert.ok(buttons.includes(hostile), 'the hostile pill is visible as text');
});

test('a failed dashboard read is an error state with a log line, bundle still renders', async () => {
  const failure = Object.assign(new Error('boom'), { status: 500 });
  const { mount, view, logLines } = harness({ dashboard: failure });
  await view.renderReporting();
  const text = [...mount.findAll('div'), ...mount.findAll('p')].map((node) => node.textContent).join(' | ');
  assert.match(text, /Andamento non disponibile/);
  assert.ok(logLines.some(([message]) => message === 'reporting dashboard request failed'));
  assert.ok(mount.findAll('td').map((node) => node.textContent).includes('chiamate'), 'bundle rows still render');
});

test('an unreadable dashboard payload is an error state, never a blank screen', async () => {
  const { mount, view, logLines } = harness({ dashboard: { hello: 'world' } });
  await view.renderReporting();
  const text = [...mount.findAll('div'), ...mount.findAll('p')].map((node) => node.textContent).join(' | ');
  assert.match(text, /risposta illeggibile/);
  assert.ok(logLines.some(([message]) => message === 'reporting dashboard request failed'));
});
