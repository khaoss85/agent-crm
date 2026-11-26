// @ts-check

/**
 * Backoffice BO-F5-02 Reporting (backlog:c3e66b36ddb7) — dashboard screen.
 *
 * Drives the real view code with the repo's fake DOM: filters refetch with
 * periodo/persona parameters (ricalcolo, never a client-side slice), the
 * forecast renders the stima line, the proposal reveals with zero
 * requests (it cannot reassign by itself), and hostile owner keys stay text.
 */

import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  FORECAST_LEGEND,
  channelsSummary,
  channelWeekTotals,
  hasSummaryData,
  isAiSummaryLines,
  summaryPath,
  REPORTING_CODE_FILES,
  REPORTING_CODE_LEDE,
  REPORTING_CURRENCY,
  REPORTING_PROMPT_TEXT,
  barWidth,
  createReportingView,
  currentPeriod,
  dashboardPath,
  downloadCsv,
  forecastStatus,
  isDashboardPayload,
  ownerSigla,
  periodOptions,
} from '../apps/admin/public/admin-reporting.js';
import { formatAmount } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { METRIC_DEFINITIONS } from '../packages/analytics/src/index.js';
import { dashboardSpecs } from '../packages/analytics/src/dashboard.js';

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
    { id: 'open-value', label: 'Valore pipeline aperto', display: '26.000 €', sub: '6 preventivi aperti' },
    { id: 'open-count', label: 'Preventivi aperti', display: '6', sub: '26.000 €' },
    { id: 'won-period', label: 'Vinte in ottobre 2026', display: '14.000 €', sub: '2 chiusure' },
    { id: 'win-rate', label: 'Tasso di chiusura', display: '67%', sub: '2 vinte, 1 persa' },
    { id: 'closing-period', label: 'In chiusura in ottobre 2026', display: '14.000 €', sub: '2 preventivi' },
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
    { owner: 'alice', openCount: 2, openMinor: 14000, wonCount: 1, wonMinor: 9000, lostCount: 1, winRate: 0.5, winRateDisplay: '50%' },
    { owner: 'bob', openCount: 0, openMinor: 0, wonCount: 1, wonMinor: 5000, lostCount: 0, winRate: 1, winRateDisplay: '100%' },
  ],
  owners: ['alice', 'bob'],
  forecast: {
    currency: 'EUR', closedMinor: 14000, probableMinor: 9333, bestMinor: 14000, targetMinor: 2000000,
    heuristic: true, label: 'Stima',
    method: 'Le probabili usano il tasso di chiusura storico (vinte su vinte + perse); non è una promessa.',
    note: 'Obiettivo 20.000 €.',
  },
  channels: {
    weeks: [
      { week: '2026-09-28', label: '28 set' },
      { week: '2026-10-05', label: '5 ott' },
      { week: '2026-10-12', label: '12 ott' },
      { week: '2026-10-19', label: '19 ott' },
    ],
    channels: [
      { channel: 'instagram', total: 18, weeks: [4, 5, 6, 3] },
      { channel: 'whatsapp', total: 10, weeks: [2, 3, 3, 2] },
    ],
    total: 28,
    undated: 0,
  },
  insights: [
    { id: 'redistribute', text: 'alice tiene molto aperto con il tasso più basso: propone di spostare i lead senza data a bob.' },
  ],
  proposal: {
    title: 'Proposta di ridistribuzione lead',
    moves: [{ from: 'alice', to: 'bob', count: 1, reason: '1 preventivi senza data, tasso 50% contro 100%' }],
    note: 'La proposta non sposta nulla da sola: la riassegnazione resta dell\u2019operatore.',
  },
  csv: { filename: 'reporting-2026-10.csv', content: 'reporting;2026-10;tutti;EUR\nalice;2;14000;1;9000;1;50%\n' },
};

const BUNDLE_ROWS = [{ id: 'r1', metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' }];

/**
 * @param {{dashboard?: any, requests?: string[], downloads?: any[], copies?: any[], logLines?: any[]}} [options]
 */
function harness(options = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const requests = options.requests ?? [];
  const downloads = options.downloads ?? [];
  const copies = options.copies ?? null;
  const logLines = options.logLines ?? [];
  const dashboard = options.dashboard ?? MODEL;
  // backlog:766e9cf9469e: the AI summary answer for /api/reporting/summary —
  // by default the AI is off ({ lines: null }), so the header keeps the
  // computed fallback like production with the AI disabled.
  const summary = options.summary ?? { lines: null, reason: 'ai-disabled' };
  const view = createReportingView({
    doc,
    mount,
    ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
    client: {
      request: async (path, options = {}) => {
        enforceAdminWriteGate(path, options);
        requests.push(path);
        if (path.includes('/api/reporting/summary')) {
          if (summary instanceof Error) throw summary;
          return summary;
        }
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
    // A clipboard spy only when the test asks for one: otherwise the view
    // keeps its production default (false without a real clipboard).
    ...(copies === null ? {} : { copy: async (input) => { copies.push(input); return true; } }),
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
  assert.equal(formatAmount(26000, 'EUR'), '260 €');
  assert.equal(formatAmount(0, 'USD'), '0 USD');
  assert.equal(formatAmount(1.5, 'EUR'), '—');
  assert.equal(formatAmount(NaN), '—');
});

test('dashboard renders 5 KPIs, 4 charts, forecast badge, team and insights', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('class') === 'metric').length, 5);
  const text = [
    ...mount.findAll('span'), ...mount.findAll('p'), ...mount.findAll('h3'), ...mount.findAll('td'),
  ].map((node) => node.textContent).join(' | ');
  assert.match(text, /Valore pipeline aperto/);
  assert.match(text, /26\.000 €/);
  assert.match(text, /Preventivi/);
  assert.match(text, /Valore per fase/);
  assert.match(text, /Chiusure attese per mese/);
  assert.match(text, /Vendite per persona/);
  assert.match(text, /✦ Stima:/);
  assert.match(text, /non è una promessa/);
  assert.match(text, /Team e vendite/);
  assert.match(text, /Cosa noto/);
  assert.ok(mount.findAll('td').map((node) => node.textContent).includes('Alice'));
});

test('ownerSigla renders person initials, never a guess', () => {
  assert.equal(ownerSigla('bob'), 'B');
  assert.equal(ownerSigla('Maria Rossi'), 'MR');
  assert.equal(ownerSigla('marco de lucchi'), 'MD', 'only the first two words');
  assert.equal(ownerSigla('  sara  '), 'S', 'surrounding spaces are not initials');
  assert.equal(ownerSigla(''), '·', 'no name: neutral dot');
  assert.equal(ownerSigla('   '), '·', 'blank: neutral dot');
  assert.equal(ownerSigla(null), '·', 'non-string: neutral dot');
  assert.equal(ownerSigla(42), '·', 'non-string: neutral dot');
});

test('periodo/persona filters refetch the registry (ricalcolo)', async () => {
  const { mount, view, requests } = harness();
  await view.renderReporting();
  const first = requests.filter((path) => path.includes('/api/reporting/dashboard'));
  assert.equal(first.length, 1);
  assert.match(first[0], /period=/);
  const bob = mount.findAll('button').find((node) => node.getAttribute('data-owner') === 'bob');
  assert.ok(bob, 'the persona filter renders from the model owners');
  assert.equal(bob.textContent, 'B', 'the persona filter shows the owner sigla, not the name');
  assert.equal(bob.getAttribute('title'), 'Bob', 'the full name stays on the title');
  assert.equal(bob.getAttribute('aria-label'), 'Bob', 'the accessible name is the full owner, not the sigla');
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

test('same-sigla owners keep distinct accessible names', async () => {
  const { mount, view } = harness({
    dashboard: { ...MODEL, owners: ['Maria Rossi', 'Marco Rossi'] },
  });
  await view.renderReporting();
  const buttons = mount.findAll('button').filter((node) => node.textContent === 'MR');
  assert.equal(buttons.length, 2, 'both owners render as MR sigle');
  const labels = buttons.map((node) => node.getAttribute('aria-label')).sort();
  assert.deepEqual(labels, ['Marco Rossi', 'Maria Rossi'], 'screen readers hear two distinct owners');
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

test('526e1bf4bd28: the header carries no label row, only what the period brought', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const spans = mount.findAll('span').map((node) => node.textContent);
  for (const label of ['Clienti, preventivi e vendite', 'Si toglie senza rompere niente', 'Fatto dal tuo agente di coding']) {
    assert.ok(!spans.includes(label), `no technical label under the title: ${label}`);
  }
  const lines = mount.findAll('p').map((node) => node.textContent);
  assert.ok(lines.includes('28 nuovi clienti in 4 settimane, soprattutto da Instagram.'),
    'the header says how many and from where');
  assert.ok(lines.some((line) => /^Settimana del 19 ott: \d+, quella prima: \d+ \((in crescita|in calo|stabile)\)\.$/.test(line)),
    'the second line compares the last two weeks');
});

test('526e1bf4bd28: channelsSummary reads the breakdown and stays silent on an empty one', () => {
  assert.equal(channelsSummary({ weeks: [], channels: [], total: 0, undated: 0 }), null);
  assert.equal(channelsSummary(null), null);
  assert.deepEqual(channelsSummary({
    weeks: [{ week: '2026-10-05', label: '5 ott' }],
    channels: [{ channel: 'phone', total: 1, weeks: [1] }],
    total: 1,
    undated: 0,
  }), ['1 nuovo cliente in una settimana, soprattutto da Telefono.']);
  assert.deepEqual(channelsSummary({
    weeks: [{ week: '2026-10-05', label: '5 ott' }, { week: '2026-10-12', label: '12 ott' }],
    channels: [{ channel: 'whatsapp', total: 5, weeks: [4, 1] }, { channel: 'email', total: 2, weeks: [0, 2] }],
    total: 7,
    undated: 0,
  }), ['7 nuovi clienti in 2 settimane, soprattutto da WhatsApp.', 'Settimana del 12 ott: 3, quella prima: 4 (in calo).']);
});

test('526e1bf4bd28: every bar segment carries value and channel, and a floor height', async () => {
  const { mount, view } = harness({
    dashboard: {
      ...MODEL,
      channels: {
        weeks: [{ week: '2026-10-05', label: '5 ott' }, { week: '2026-10-12', label: '12 ott' }],
        channels: [{ channel: 'whatsapp', total: 41, weeks: [1, 40] }, { channel: 'phone', total: 2, weeks: [2, 0] }],
        total: 43,
        undated: 0,
      },
    },
  });
  await view.renderReporting();
  const segments = mount.findAll('div').filter((node) => String(node.getAttribute('class') ?? '') === 'bo-rep-week-seg');
  assert.equal(segments.length, 3, 'one segment per channel with a count in the week');
  assert.deepEqual(segments.map((node) => node.getAttribute('data-tip')).sort(), ['Telefono 2', 'WhatsApp 1', 'WhatsApp 40']);
  for (const segment of segments) {
    assert.equal(segment.getAttribute('title'), segment.getAttribute('data-tip'), 'the native title stays as fallback');
    assert.equal(segment.getAttribute('tabindex'), '0', 'the tooltip is reachable from the keyboard');
    const height = Number(/height:(\d+)px/.exec(segment.getAttribute('style'))?.[1]);
    assert.ok(height >= 14, `a small value stays readable (${segment.getAttribute('data-tip')}: ${height}px)`);
  }
});

test('code card documents the module with files, prompt and CSV (C17)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const text = [...mount.findAll('p'), ...mount.findAll('li'), ...mount.findAll('code')]
    .map((node) => node.textContent)
    .join(' | ');
  assert.match(text, /Questo modulo è codice tuo/);
  assert.ok(text.includes(REPORTING_CODE_LEDE), 'the fixed lede renders');
  for (const file of REPORTING_CODE_FILES) {
    assert.ok(text.includes(file), `code card lists ${file}`);
  }
  assert.ok(text.includes(REPORTING_PROMPT_TEXT), 'the starter prompt renders as text');
  const buttons = mount.findAll('button').map((node) => node.textContent);
  assert.ok(buttons.includes('Copia il prompt'), 'copy button renders');
  assert.ok(buttons.includes('Esporta CSV'), 'CSV download moved into the code card');
});

test('Copia il prompt copies the exact starter bytes and confirms', async () => {
  const copies = [];
  const { mount, view } = harness({ copies });
  await view.renderReporting();
  const copyButton = mount.findAll('button').find((node) => node.textContent === 'Copia il prompt');
  assert.ok(copyButton, 'copy button renders');
  copyButton.dispatch('click', {});
  await tick(10);
  assert.equal(copies.length, 1, 'one clipboard write');
  assert.equal(copies[0].text, REPORTING_PROMPT_TEXT, 'the exact starter bytes');
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.match(text, /Prompt copiato negli appunti/, 'confirmation renders');
  copyButton.dispatch('click', {});
  await tick(10);
  assert.equal(copies.length, 1, 'a second click copies nothing twice');
});

test('without a clipboard the copy button says so honestly', async () => {
  const { doc, mount, view, logLines } = harness();
  assert.equal(doc.defaultView ?? null, null, 'the fake DOM carries no clipboard');
  await view.renderReporting();
  const copyButton = mount.findAll('button').find((node) => node.textContent === 'Copia il prompt');
  assert.ok(copyButton, 'copy button renders');
  copyButton.dispatch('click', {});
  await tick(10);
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.match(text, /Appunti non disponibili/, 'honest fallback, never a silent no-op');
  assert.ok(!logLines.some(([message]) => message === 'reporting copy to clipboard failed'),
    'a missing clipboard is not a failure: no log line');
});

test('a denied clipboard logs a sanitized cause and still falls back', async () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError', code: null });
  const { doc, mount, view, logLines } = harness();
  doc.defaultView = { navigator: { clipboard: { writeText: async () => { throw denied; } } } };
  await view.renderReporting();
  const copyButton = mount.findAll('button').find((node) => node.textContent === 'Copia il prompt');
  assert.ok(copyButton, 'copy button renders');
  copyButton.dispatch('click', {});
  await tick(10);
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.match(text, /Appunti non disponibili/, 'the operator still gets the manual path');
  const logged = logLines.filter(([message]) => message === 'reporting copy to clipboard failed');
  assert.equal(logged.length, 1, 'one diagnostic log line');
  assert.equal(logged[0][1]?.name, 'NotAllowedError', 'the cause names the failure');
  assert.ok(!JSON.stringify(logged[0][1] ?? {}).includes(REPORTING_PROMPT_TEXT),
    'the cause never carries the clipboard contents');
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
  assert.ok(downloads[0].content.includes('alice;2;14000;1;9000;1;50%'));
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
  const buttons = mount.findAll('button');
  assert.ok(buttons.every((node) => node.textContent !== hostile), 'no button renders the hostile key as its label');
  const hostileButton = buttons.find((node) => node.getAttribute('data-owner') === hostile);
  assert.ok(hostileButton, 'the hostile owner still gets its sigla filter');
  assert.equal(hostileButton.textContent, '<S', 'the sigla is two inert characters from the first two words');
  assert.equal(hostileButton.getAttribute('title'), hostile, 'the full key stays in the title attribute, never markup');
  const images = mount.findAll('img');
  assert.equal(images.length, 0, 'the hostile key creates no element');
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

test('a partial dashboard 200 is unreadable too: kpis alone never render', async () => {
  // Regression: the guard used to check only kpis, so a 200 with kpis but
  // no funnel crashed the renderer into a blank screen.
  const partial = { kpis: MODEL.kpis, truncated: false };
  const { mount, view, logLines } = harness({ dashboard: partial });
  await view.renderReporting();
  const text = [...mount.findAll('div'), ...mount.findAll('p')].map((node) => node.textContent).join(' | ');
  assert.match(text, /risposta illeggibile/);
  assert.ok(logLines.some(([message]) => message === 'reporting dashboard request failed'));
});

test('isDashboardPayload requires every rendered list and the csv bytes', () => {
  assert.equal(isDashboardPayload(null), false);
  assert.equal(isDashboardPayload({ hello: 'world' }), false);
  assert.equal(isDashboardPayload({ ...MODEL }), true);
  for (const key of ['kpis', 'funnel', 'valueByStage', 'monthly', 'team', 'owners', 'insights']) {
    const { [key]: _dropped, ...rest } = MODEL;
    assert.equal(isDashboardPayload(rest), false, `${key} is required`);
  }
  const { channels: _channels, ...noChannels } = MODEL;
  assert.equal(isDashboardPayload(noChannels), false, 'channels is required');
  assert.equal(
    isDashboardPayload({ ...MODEL, channels: { weeks: [], channels: [], total: 'many' } }),
    false,
    'a non-integer channel total is unreadable',
  );
  assert.equal(isDashboardPayload({ ...MODEL, csv: { filename: 'x.csv' } }), false);
});

test('the channel card renders title, period total, week totals and legend (C6, C7)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const text = [
    ...mount.findAll('h3'), ...mount.findAll('p'), ...mount.findAll('span'),
  ].map((node) => node.textContent).join(' | ');
  assert.match(text, /Nuovi clienti per canale/, 'C6: card title');
  // backlog:48993bed7294: the total says what it counts and over which weeks.
  assert.match(text, /28 primi contatti da un canale nelle 4 settimane dal 28 set al 25 ott · ogni cliente conta una volta, nel canale del primo contatto/, 'C6: what the total counts');
  assert.match(text, /Instagram 18/, 'C7: legend <nome canale> <n>');
  assert.match(text, /WhatsApp 10/, 'C7: legend <nome canale> <n>');
  for (const label of ['28 set', '5 ott', '12 ott', '19 ott']) {
    assert.match(text, new RegExp(label), `week axis shows ${label}`);
  }
});

test('an unknown channel renders under its raw name, never invented', async () => {
  const { mount, view } = harness({
    dashboard: {
      ...MODEL,
      channels: {
        weeks: [{ week: '2026-10-05', label: '5 ott' }],
        channels: [{ channel: 'carrier-pigeon', total: 2, weeks: [2] }],
        total: 2,
        undated: 0,
      },
    },
  });
  await view.renderReporting();
  const text = [...mount.findAll('span')].map((node) => node.textContent).join(' | ');
  assert.match(text, /carrier-pigeon 2/);
});

test('an empty channel breakdown says what to do, never blank and never a row of zeros (C20, 526e1bf4bd28)', async () => {
  const { mount, view } = harness({
    dashboard: { ...MODEL, channels: { weeks: [{ week: '2026-10-05', label: '5 ott' }], channels: [], total: 0, undated: 0 } },
  });
  await view.renderReporting();
  const text = [
    ...mount.findAll('h3'), ...mount.findAll('p'), ...mount.findAll('span'),
  ].map((node) => node.textContent).join(' | ');
  assert.match(text, /Nuovi clienti per canale/);
  assert.match(text, /0 primi contatti da un canale/);
  assert.match(text, /Ancora nessun nuovo cliente in queste settimane\./);
  const add = mount.findAll('a').find((node) => node.textContent === 'Aggiungi un cliente');
  assert.equal(add?.getAttribute('href'), '#/clienti/nuovo', 'the empty state opens the creation form, not the list');
  assert.equal(mount.findAll('div').filter((node) => String(node.getAttribute('class') ?? '') === 'bo-rep-week').length, 0,
    'no empty bars and no zero totals');
});

test('526e1bf4bd28: header summary and card share one emptiness rule and one weekly total', async () => {
  const twoWeeks = [{ week: '2026-10-05', label: '5 ott' }, { week: '2026-10-12', label: '12 ott' }];
  // Customers counted but none inside the weeks shown: no summary, empty card.
  const outside = { total: 5, undated: 0, weeks: twoWeeks, channels: [{ channel: 'instagram', total: 5, weeks: [0, 0] }] };
  assert.equal(channelsSummary(outside), null);
  {
    const { mount, view } = harness({ dashboard: { ...MODEL, channels: outside } });
    await view.renderReporting();
    const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
    assert.match(text, /Ancora nessun nuovo cliente in queste settimane\./);
    assert.doesNotMatch(text, /nuovi clienti in 2 settimane/, 'the header says nothing the card does not draw');
  }
  // Non-integer weekly values count as zero in both places.
  const fractional = { total: 3, undated: 0, weeks: twoWeeks, channels: [{ channel: 'whatsapp', total: 3, weeks: [1.5, 2] }] };
  assert.deepEqual(channelWeekTotals(fractional), [0, 2]);
  assert.match(channelsSummary(fractional)[1], /Settimana del 12 ott: 2, quella prima: 0 \(in crescita\)\./);
  {
    const { mount, view } = harness({ dashboard: { ...MODEL, channels: fractional } });
    await view.renderReporting();
    const totals = mount.findAll('span').filter((node) => String(node.getAttribute('class') ?? '') === 'bo-rep-week-total').map((node) => node.textContent);
    assert.deepEqual(totals, ['0', '2'], 'bars show the same weekly totals as the header');
  }
});

test('forecastStatus is on track at and past the obiettivo, honest below it (C13)', () => {
  assert.deepEqual(FORECAST_LEGEND, ['Chiuse', 'Probabili', 'Se chiudi tutto']);
  assert.equal(
    forecastStatus({ closedMinor: 14000, probableMinor: 9333, targetMinor: 20000 }, 'EUR'),
    '✦ Sei in linea con l\u2019obiettivo',
    'reached beats the target: the prototype exact wording',
  );
  assert.equal(
    forecastStatus({ closedMinor: 10000, probableMinor: 10000, targetMinor: 20000 }, 'EUR'),
    '✦ Sei in linea con l\u2019obiettivo',
    'exactly on target counts as on track',
  );
  assert.equal(
    forecastStatus({ closedMinor: 14000, probableMinor: 9333, targetMinor: 2000000 }, 'EUR'),
    `✦ Ti mancano ${formatAmount(1976667, 'EUR')} per l\u2019obiettivo`,
    'below target names the honest gap in Italian money',
  );
  assert.equal(forecastStatus({ closedMinor: 0, probableMinor: 0, targetMinor: 0 }, 'EUR'),
    '✦ Sei in linea con l\u2019obiettivo', 'a zero target with nothing reached is on track');
  assert.equal(forecastStatus({ closedMinor: 14000, probableMinor: 9333, targetMinor: null }, 'EUR'), null,
    'no target: no line, the note already says the obiettivo is missing');
  assert.equal(forecastStatus(null, 'EUR'), null, 'no forecast: no line');
  assert.equal(forecastStatus({ closedMinor: 1.5, probableMinor: 0, targetMinor: 10 }, 'EUR'), null,
    'non-integer amounts: no line, never a guess');
  assert.equal(forecastStatus({ closedMinor: 5, probableMinor: 5, targetMinor: -1 }, 'EUR'), null,
    'a negative target is unreadable: no line');
});

test('forecast renders the legend and the on-track status (C13)', async () => {
  const onTrack = {
    ...MODEL,
    forecast: { ...MODEL.forecast, closedMinor: 14000, probableMinor: 9333, targetMinor: 20000 },
  };
  const { mount, view } = harness({ dashboard: onTrack });
  await view.renderReporting();
  const spans = mount.findAll('span').map((node) => node.textContent);
  for (const label of FORECAST_LEGEND) {
    assert.ok(spans.includes(label), `legend shows ${label}`);
  }
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(text.includes('✦ Sei in linea con l\u2019obiettivo'), 'on-track status renders');
});

test('forecast renders the honest gap below target and nothing without one (C13)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(text.includes('✦ Ti mancano'), 'below target the gap renders');
  assert.ok(text.includes('per l\u2019obiettivo'), 'the gap names the obiettivo in plain Italian');
  const noTarget = harness({
    dashboard: {
      ...MODEL,
      forecast: {
        ...MODEL.forecast,
        targetMinor: null,
        note: 'Obiettivo non impostato: aggiungi una riga obiettivo nel report.',
      },
    },
  });
  await noTarget.view.renderReporting();
  const bare = noTarget.mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(!bare.includes('Sei in linea'), 'no target: no status line invented');
  assert.ok(!bare.includes('Ti mancano'), 'no target: no gap invented');
  assert.ok(bare.includes('Obiettivo non impostato'), 'the missing-obiettivo note still renders');
});

test('obiettivo 20.000 € renders as 20.000 € with the honest gap (backlog:1ce3a1f0)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(text.includes(`Obiettivo ${formatAmount(2000000, 'EUR')}`), 'the obiettivo shows euros, never cents');
  assert.ok(!text.includes('2.000.000'), 'cents are never shown as euros');
  assert.ok(
    text.includes(`✦ Ti mancano ${formatAmount(2000000 - 14000 - 9333, 'EUR')} per l\u2019obiettivo`),
    'the gap is target minus reached, in Italian money',
  );
});

test('reporting dashboard speaks user words: no bundle/kernel/euristica/version (backlog:1ce3a1f0)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  // User-facing dashboard texts only: badges, titles, subtitles, totals,
  // ledes, lists and buttons. The developer commands (`pre code`) keep
  // their exact CLI spelling (`bundle create …`) and are out of scope.
  const text = [
    ...mount.findAll('h1'), ...mount.findAll('h2'), ...mount.findAll('h3'),
    ...mount.findAll('p'), ...mount.findAll('li'), ...mount.findAll('span'),
    ...mount.findAll('td'), ...mount.findAll('th'), ...mount.findAll('button'),
  ].map((node) => node.textContent).join(' | ');
  assert.ok(!/bundle/i.test(text), 'no «bundle» on the screen');
  assert.ok(!/kernel/i.test(text), 'no «kernel» on the screen');
  assert.ok(!/euristica/i.test(text), 'no «euristica» on the screen');
  assert.ok(!/@\d+\.\d+\.\d+/.test(text), 'no version code on the screen');
});

test('accents are correct on the reporting screen (backlog:1ce3a1f0)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const text = [...mount.findAll('p'), ...mount.findAll('li')]
    .map((node) => node.textContent).join(' | ');
  assert.ok(text.includes('non è una promessa'), 'the stima method keeps its accent');
  assert.ok(text.includes('dell\u2019operatore'), 'the proposal note keeps its accent');
  assert.ok(!text.includes('non e una promessa'), 'no unaccented «e» for «è»');
  assert.ok(!/all operatore/.test(text), 'no unaccented «all» for «all’»');
});

test('forecast legend dots never touch their labels (backlog:1ce3a1f0)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const legends = mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-rep-legend'));
  assert.equal(legends.length, 1, 'one forecast legend row');
  const dots = [];
  const walk = (node) => {
    if (String(node.tagName ?? '').toLowerCase() === 'span'
      && String(node.getAttribute('style') ?? '').includes('margin-right:6px')) {
      dots.push(String(node.getAttribute('style') ?? ''));
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(legends[0]);
  assert.equal(dots.length, FORECAST_LEGEND.length, 'every legend dot stands off its label');
  for (const swatch of ['background:var(--accord);', 'opacity:0.45', 'repeating-linear-gradient']) {
    assert.ok(dots.some((style) => style.includes(swatch)), `legend swatch matches the bar: ${swatch}`);
  }
});

test('reporting renders no button, select, input or textarea outside the visual system', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
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
  assert.deepEqual(raw, [], 'every control carries a ui-* system class');
});

// Voce 19c2e22a64a1 (4): the dashboard grid carries the prototype six-column
// layout classes — channels wide beside the funnel, three charts per row,
// the forecast full width, the team beside the insights. A mis-tagged grid
// fails here, by direct panel reference (never lastChild).
test('the dashboard grid carries the six-column layout classes', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const grid = mount.findAll('div')
    .find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-rep-grid'));
  assert.ok(grid, 'the dashboard paints the grid');
  const layout = grid.childNodes
    .map((node) => String(node.className ?? '').split(/\s+/).filter((cls) => cls.startsWith('bo-rep-')));
  assert.deepEqual(layout, [
    ['bo-rep-wide'],
    ['bo-rep-narrow'],
    ['bo-rep-third'],
    ['bo-rep-third'],
    ['bo-rep-third'],
    ['bo-rep-full'],
    ['bo-rep-wide'],
    ['bo-rep-narrow'],
    ['bo-rep-narrow'],
  ], 'channels wide, three thirds, forecast full, team wide beside insights');
});

// backlog:c3e66b36ddb7 — Reporting like prototype 09, on registry data only.

const classesOf = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const byClass = (mount, tag, cls) => mount.findAll(tag).filter((node) => classesOf(node).includes(cls));

test('c3e66b36ddb7: every number comes from the declared analytics registry, read through one route', async () => {
  // The dashboard compiles only declared registry entries…
  const specs = dashboardSpecs({ period: '2026-10', owner: null, currency: 'EUR' });
  for (const spec of Object.values(specs)) {
    assert.ok(Object.hasOwn(METRIC_DEFINITIONS, spec.metric), `${spec.metric} is a declared registry metric`);
  }
  // …and the screen reads numbers from nowhere else: the dashboard route
  // (registry) and the operator's own report rows, never another query.
  // backlog:766e9cf9469e: the summary route rewrites the same dashboard
  // numbers through the model — a read-only rewrite, never new numbers.
  const { view, requests } = harness();
  await view.renderReporting();
  const sources = new Set(requests.map((path) => path.split('?')[0]));
  // The team roster only names the people (famiglia F5): it carries no number.
  assert.deepEqual([...sources].sort(), ['/api/modules/reporting/records', '/api/reporting/dashboard', '/api/reporting/summary', '/api/spine/memberships']);
});

test('c3e66b36ddb7: filters sit beside the title — one active period, Tutti and the person sigle', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const [header] = byClass(mount, 'div', 'bo-rep-header');
  assert.ok(header, 'the header row renders');
  const [filters] = byClass(header, 'div', 'bo-rep-filters');
  assert.ok(filters, 'the filters live in the header, beside the title');
  const segments = filters.findAll('button').filter((node) => classesOf(node).includes('ui-seg'));
  assert.equal(segments.length, 3, 'three period options in a segmented control');
  assert.equal(segments.filter((node) => classesOf(node).includes('active')).length, 1, 'one period active at a time');
  const people = filters.findAll('button').filter((node) => classesOf(node).includes('bo-rep-person'));
  assert.deepEqual(people.map((node) => node.textContent), ['Tutti', 'A', 'B']);
  assert.equal(people[0].getAttribute('aria-pressed'), 'true', 'Tutti is the active persona by default');
});

test('c3e66b36ddb7: the funnel lists each stage with n · amount over a full bar, never an invented percentage', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const [funnel] = byClass(mount, 'section', 'bo-preventivi');
  assert.ok(funnel);
  const steps = byClass(funnel, 'div', 'bo-rep-step-line').map((node) => node.textContent);
  const eur = (minor) => formatAmount(minor, 'EUR');
  assert.deepEqual(steps, [`Qualifica3 · ${eur(14500)}`, `Trattativa2 · ${eur(10000)}`, `Vinte2 · ${eur(14000)}`]);
  assert.ok(!/%/.test(funnel.textContent), 'stage counts are a snapshot: no conversion percentage is claimed');
});

test('c3e66b36ddb7: the forecast names its goal in the head, carries amounts in the legend and stays labelled as an estimate', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const forecast = mount.findAll('div').find((node) => classesOf(node).includes('pipeline-forecast'));
  const head = byClass(forecast, 'div', 'bo-rep-head')[0];
  assert.equal(head.textContent, `Previsione di ottobre 2026Obiettivo ${formatAmount(2000000, 'EUR')}`);
  const amounts = byClass(forecast, 'strong', 'bo-rep-amount').map((node) => node.textContent);
  assert.deepEqual(amounts, [formatAmount(14000, 'EUR'), `+${formatAmount(9333, 'EUR')}`, `+${formatAmount(14000, 'EUR')}`]);
  assert.match(forecast.textContent, /✦ Stima: .*non è una promessa/, 'the heuristic is labelled, never a promise');
  assert.equal((forecast.textContent.match(/Obiettivo/g) ?? []).length, 1, 'the goal is said once, in the head');
});

test('c3e66b36ddb7: «Cosa noto» is the violet card and still only proposes', async () => {
  const { mount, view, requests } = harness();
  await view.renderReporting();
  const [card] = byClass(mount, 'section', 'bo-cosa-noto');
  assert.ok(card, 'the insights wear the AI card');
  assert.deepEqual(byClass(card, 'p', 'bo-cosa-noto-item').map((node) => node.textContent), ['Alice tiene molto aperto con il tasso più basso: propone di spostare i lead senza data a Bob.']);
  const before = requests.length;
  card.findAll('button')[0].dispatch('click', {});
  await tick();
  assert.equal(requests.length, before, 'the proposal never writes: no request leaves the screen');
  assert.match(card.textContent, /non sposta nulla da sola/);
});

test('c3e66b36ddb7: the code card shows the module tree and Esporta CSV confirms the download', async () => {
  const { mount, view, downloads } = harness();
  await view.renderReporting();
  const [card] = byClass(mount, 'section', 'bo-codice');
  const [tree] = byClass(card, 'pre', 'bo-codice-tree');
  assert.deepEqual(tree.findAll('code').map((node) => node.textContent.trim()), [...REPORTING_CODE_FILES]);
  const csv = card.findAll('button').find((node) => node.textContent === 'Esporta CSV');
  csv.dispatch('click', {});
  await tick();
  assert.equal(downloads.length, 1);
  assert.match(card.textContent, /CSV scaricato: reporting-2026-10\.csv\./);
  csv.dispatch('click', {});
  await tick();
  assert.equal(downloads.length, 2, 'a second click downloads again');
  assert.equal((card.textContent.match(/CSV scaricato/g) ?? []).length, 1, 'the confirmation shows once');
});

test('c3e66b36ddb7: the browser download joins the page for the click, then leaves it', () => {
  const doc = createFakeDocument();
  const body = createMount();
  const seen = [];
  const anchors = [];
  const fakeDoc = {
    ...doc,
    body,
    createElement: (tag) => {
      const node = doc.createElement(tag);
      node.click = () => seen.push({ attached: node.parentNode === body, href: node.getAttribute('href'), name: node.getAttribute('download') });
      anchors.push(node);
      return node;
    },
  };
  downloadCsv({ doc: /** @type {any} */ (fakeDoc), filename: 'reporting-2026-10.csv', content: 'a;b\n' });
  assert.equal(seen.length, 1, 'the link is clicked once');
  assert.equal(seen[0].attached, true, 'the link is in the page when clicked (Firefox ignores detached links)');
  assert.equal(seen[0].name, 'reporting-2026-10.csv');
  assert.ok(String(seen[0].href).startsWith('blob:'), 'the CSV travels as a blob URL');
  assert.equal(body.childNodes.includes(anchors[0]), false, 'the link leaves the page right after');
});

test('c3e66b36ddb7: the loading state speaks Italian', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = createReportingView({
    doc,
    mount,
    client: { request: async () => { await gate; return { items: [] }; } },
    navigate: () => {},
    log: () => {},
  });
  const pending = view.renderReporting();
  assert.equal(mount.textContent, 'Sto preparando il report…');
  release();
  await pending;
});

// backlog:48993bed7294 (verifica 13/11): the «senza referente» row and the
// columns' meaning on the team table.
test('48993bed7294: offers without a referente read «Senza referente», never «Membro del team»', async () => {
  const { withPersonNames, channelsLede } = await import('../apps/admin/public/admin-reporting.js');
  const named = withPersonNames({
    owners: ['alice'],
    team: [{ owner: 'alice', openCount: 3, openMinor: 38000 }, { owner: '', openCount: 2, openMinor: 2500 }],
    insights: [],
  }, []);
  assert.deepEqual(named.team.map((entry) => entry.owner).slice(1), ['Senza referente']);
  assert.equal(channelsLede({ total: 1, weeks: [{ week: '2026-10-26' }, { week: '2026-11-02' }, { week: '2026-11-09' }, { week: '2026-11-16' }] }),
    '1 primo contatto da un canale nelle 4 settimane dal 26 ott al 22 nov · ogni cliente conta una volta, nel canale del primo contatto');
});

// backlog:02e4b848 (verifica 19/11: il sottotitolo di novembre dice «al 22 nov»,
// tre giorni dopo oggi): con il tetto del server il sottotitolo si ferma a oggi.
test('02e4b848: il sottotitolo del mese in corso non nomina giorni futuri', async () => {
  const { channelsLede } = await import('../apps/admin/public/admin-reporting.js');
  assert.equal(channelsLede({
    total: 8,
    weeks: [{ week: '2026-10-26' }, { week: '2026-11-02' }, { week: '2026-11-09' }, { week: '2026-11-16' }],
    end: '2026-11-19',
  }),
  '8 primi contatti da un canale nelle 4 settimane dal 26 ott al 19 nov · ogni cliente conta una volta, nel canale del primo contatto');
  // Un tetto illeggibile o fuori dalle settimane mostrate: la domenica dell'ultima settimana, come prima.
  assert.equal(channelsLede({
    total: 7,
    weeks: [
      { week: '2026-09-28' }, { week: '2026-10-05' }, { week: '2026-10-12' },
      { week: '2026-10-19' }, { week: '2026-10-26' },
    ],
    end: 'non-una-data',
  }),
  '7 primi contatti da un canale nelle 5 settimane dal 28 set al 1 nov · ogni cliente conta una volta, nel canale del primo contatto');
});

// backlog:ed6bae5e5c0d (verifica indipendente 18/11: la colonna conta le
// offerte aperte ma le chiama preventivi): l'intestazione dice «Offerte
// aperte», ciò che conta davvero, e la riga mostra vinte e tasso del periodo.
test('ed6bae5e5c0d: the team column reads «Offerte aperte», won and rate stay period-based', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const heads = mount.findAll('th').map((node) => node.textContent);
  assert.ok(heads.includes('Offerte aperte'), `the column names what it counts, got: ${heads.join(' | ')}`);
  assert.ok(!heads.includes('Preventivi'), 'no bare «Preventivi» header stays ambiguous');
  assert.ok(!heads.includes('Preventivi aperti'), 'open offers are not called preventivi');
  const cells = mount.findAll('td').map((node) => node.textContent);
  // MODEL: alice 2 open, 1 won (9000 minor = 90 €) and 1 lost in the period → 50%.
  assert.ok(cells.includes('2'), 'alice open count renders');
  assert.ok(cells.includes('1 (90 €)'), `alice won count renders, got: ${cells.join(' | ')}`);
  assert.ok(cells.includes('50%'), 'alice period rate renders');
});

// 35c3c897d696: a malformed first or last week reads the count only, never throws.
test('channelsLede with a malformed week never throws', async () => {
  const { channelsLede } = await import('../apps/admin/public/admin-reporting.js');
  assert.equal(
    channelsLede({ total: 3, weeks: [{ week: '2026-10-26' }, { week: 'non-una-data' }] }),
    '3 primi contatti da un canale',
  );
  assert.equal(
    channelsLede({ total: 1, weeks: [{ week: 'nope' }, { week: '2026-11-02' }] }),
    '1 primo contatto da un canale',
  );
  assert.equal(channelsLede({ total: 0, weeks: [] }), '0 primi contatti da un canale');
});

test('restyle 54b9a2a2706f: il valore aperto si legge «€ + USD», mai nascosto dietro «Solo EUR mostrati»', async () => {
  const kpis = MODEL.kpis.map((kpi) => (kpi.id === 'open-value'
    ? { ...kpi, also: { display: '30 USD', count: 1 } }
    : kpi));
  const { mount, view } = harness({ dashboard: { ...MODEL, kpis } });
  await view.renderReporting();
  const strong = mount.findAll('strong').map((node) => node.textContent);
  assert.ok(strong.includes('26.000 € + 30 USD'), strong.join(' | '));
  assert.ok(strong.includes('14.000 €'), 'a card without other currencies stays as it is');
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(!text.includes('Solo EUR mostrati'), text);
  assert.ok(text.includes('Valore aperto e vinte contano anche USD'), text);
});

test('review Muse #1108: il conteggio segue il valore — «· 1 in altre valute»', async () => {
  const kpis = MODEL.kpis.map((kpi) => (kpi.id === 'open-value' ? { ...kpi, also: { display: '30 USD', count: 1 } } : kpi));
  const { mount, view } = harness({ dashboard: { ...MODEL, kpis } });
  await view.renderReporting();
  const spans = mount.findAll('span').map((node) => node.textContent);
  assert.ok(spans.includes('6 preventivi aperti · 1 in altre valute'), spans.join(' | '));
});

/**
 * backlog:766e9cf9469e: the two lines at the top of the Reporting screen,
 * written by the AI from the period's own numbers. The header first paints
 * the computed fallback of 526e1bf4bd28, then replaces it only with an
 * answer of exactly two lines; with the AI off, failing or empty the
 * fallback stays and the header never shows an error.
 */

const summaryHostOf = (mount) => mount.findAll('div')
  .find((node) => node.getAttribute('class') === 'bo-rep-summary');

const summaryLinesOf = (mount) => (summaryHostOf(mount)?.childNodes ?? [])
  .map((node) => node.textContent);

test('766e9cf9469e: summaryPath pins the periodo/persona recalculation contract', () => {
  assert.equal(summaryPath({ period: '2026-10', owner: null }), '/api/reporting/summary?period=2026-10');
  assert.equal(
    summaryPath({ period: '2026-10', owner: 'maria rossi' }),
    '/api/reporting/summary?period=2026-10&owner=maria+rossi',
  );
  assert.equal(
    summaryPath({ period: '2026-10', owner: null, spaceId: 'presti' }),
    '/api/reporting/summary?period=2026-10&spaceId=presti',
    'the space rides the request so the model spends on the active space',
  );
});

test('766e9cf9469e: the summary request carries the shell active space', async () => {
  const { view, requests } = harness({ spaceId: () => 'presti' });
  await view.renderReporting();
  await tick();
  const summaryRequests = requests.filter((path) => path.includes('/api/reporting/summary'));
  assert.equal(summaryRequests.length, 1);
  assert.match(summaryRequests[0], /spaceId=presti/);
});

test('766e9cf9469e: only exactly two non-empty lines may replace the fallback', () => {
  assert.equal(isAiSummaryLines(['Prima riga con 28 clienti.', 'Seconda riga con 5 contro 9.']), true);
  assert.equal(isAiSummaryLines(null), false, 'AI off: the fallback stays');
  assert.equal(isAiSummaryLines({ lines: ['a', 'b'] }), false, 'a wrapped payload never replaces');
  assert.equal(isAiSummaryLines(['Solo una riga.']), false);
  assert.equal(isAiSummaryLines(['  ', 'Seconda riga.']), false, 'a blank line never paints');
  assert.equal(isAiSummaryLines(['a', 'b', 'c']), false);
  assert.equal(isAiSummaryLines('due righe'), false, 'an error page never paints');
});

test('766e9cf9469e: with the AI on the header shows its two lines on the period', async () => {
  const ai = ['Il periodo ha portato 28 nuovi clienti, soprattutto da Instagram.', 'Ultima settimana 5 contro 9 di quella prima, in calo.'];
  const { mount, view, requests } = harness({ summary: { lines: ai, reason: 'ai' } });
  await view.renderReporting();
  await tick();
  assert.deepEqual(summaryLinesOf(mount), ai, 'the AI lines replace the computed fallback');
  const summaryRequests = requests.filter((path) => path.includes('/api/reporting/summary'));
  assert.equal(summaryRequests.length, 1);
  assert.match(summaryRequests[0], /period=20\d\d-\d\d/);
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.doesNotMatch(text, /nuovi clienti in 4 settimane/, 'the fallback lines are replaced, not doubled');
});

test('766e9cf9469e: with the AI off, failing or empty the computed fallback stays with no error', async () => {
  for (const [name, summary] of [
    ['off', { lines: null, reason: 'ai-disabled' }],
    ['empty period', { lines: null, reason: 'empty' }],
    ['unparseable', { lines: null, reason: 'unparseable' }],
    ['network failure', new Error('boom')],
  ]) {
    const { mount, view } = harness({ summary });
    await view.renderReporting();
    await tick();
    const lines = summaryLinesOf(mount);
    assert.ok(lines.includes('28 nuovi clienti in 4 settimane, soprattutto da Instagram.'),
      `${name}: the computed fallback stays`);
    const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
    assert.doesNotMatch(text, /non disponibile|riprova|errore/i, `${name}: no error text in the header`);
  }
});

// Review Muse rev-agent-crm-1163-abb9b6b317dc (P2, backlog:766e9cf9469e):
// a rejected summary request is never silent — name/status/code go to the
// injected log — while resolved fallbacks (off/empty/unparseable) stay
// silent. The header keeps the computed fallback in every case.
test('766e9cf9469e: a failing summary request logs, resolved fallbacks stay silent', async () => {
  for (const [name, summary, logged] of [
    ['off', { lines: null, reason: 'ai-disabled' }, false],
    ['empty period', { lines: null, reason: 'empty' }, false],
    ['unparseable', { lines: null, reason: 'unparseable' }, false],
    ['network failure', new Error('boom'), true],
  ]) {
    const { mount, view, logLines } = harness({ summary });
    await view.renderReporting();
    await tick();
    const lines = summaryLinesOf(mount);
    assert.ok(lines.includes('28 nuovi clienti in 4 settimane, soprattutto da Instagram.'),
      `${name}: the computed fallback stays`);
    assert.equal(
      logLines.some(([message]) => message === 'reporting summary request failed'),
      logged,
      `${name}: the failure is ${logged ? 'logged' : 'silent'}`,
    );
  }
});

test('766e9cf9469e: periodo/persona change refetches the two lines', async () => {
  const first = ['Prima risposta con 28 clienti.', 'Confronto con 5 contro 9.'];
  const second = ['Seconda risposta con 7 clienti.', 'Confronto con 3 contro 4.'];
  const answers = [first, second];
  const doc = createFakeDocument();
  const mount = createMount();
  const requests = [];
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path, options = {}) => {
        enforceAdminWriteGate(path, options);
        requests.push(path);
        if (path.includes('/api/reporting/summary')) return { lines: answers.shift() ?? first, reason: 'ai' };
        if (path.includes('/api/reporting/dashboard')) return MODEL;
        return { items: BUNDLE_ROWS };
      },
    },
    navigate: () => {},
    log: () => {},
  });
  await view.renderReporting();
  await tick();
  assert.deepEqual(summaryLinesOf(mount), first);
  const people = mount.findAll('button').find((node) => node.getAttribute('data-owner') === 'bob');
  assert.ok(people, 'the persona filter renders');
  people.dispatch('click', {});
  await tick(10);
  const summaryRequests = requests.filter((path) => path.includes('/api/reporting/summary'));
  assert.equal(summaryRequests.length, 2, 'a persona change refetches the lines');
  assert.match(summaryRequests[1], /owner=bob/);
  assert.deepEqual(summaryLinesOf(mount), second, 'the header shows the new period lines');
});

test('766e9cf9469e: hasSummaryData mirrors the server no-data rule', () => {
  assert.equal(hasSummaryData(MODEL), true, 'the month with customers and movement asks');
  assert.equal(
    hasSummaryData({ channels: { total: 0 }, team: [{ owner: 'alice', openCount: 0, wonCount: 1, lostCount: 0 }] }),
    true,
    'a won movement alone still asks',
  );
  assert.equal(hasSummaryData({ channels: { total: 0 }, team: [] }), false, 'no customers, no movement: nothing to rewrite');
  assert.equal(hasSummaryData({ channels: { total: 0 }, team: [{ owner: 'alice' }] }), false, 'unreadable counts read as no data');
  assert.equal(hasSummaryData({}), false);
  assert.equal(hasSummaryData(null), false);
});

test('766e9cf9469e: an empty period sends no summary request at all', async () => {
  const empty = {
    ...MODEL,
    team: [],
    owners: [],
    channels: { weeks: [], channels: [], total: 0, undated: 0 },
  };
  const { mount, view, requests } = harness({ dashboard: empty });
  await view.renderReporting();
  await tick();
  assert.ok(!requests.some((path) => path.includes('/api/reporting/summary')),
    'empty period: the screen never asks the model');
  const text = mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.doesNotMatch(text, /non disponibile|riprova|errore/i, 'no error text for an empty period');
});
