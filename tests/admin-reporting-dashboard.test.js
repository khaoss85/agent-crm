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
  FORECAST_LEGEND,
  REPORTING_BADGES,
  REPORTING_CODE_FILES,
  REPORTING_CODE_LEDE,
  REPORTING_CURRENCY,
  REPORTING_PROMPT_TEXT,
  barWidth,
  createReportingView,
  currentPeriod,
  dashboardPath,
  forecastStatus,
  formatMoney,
  isDashboardPayload,
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
    { owner: 'alice', openCount: 2, openMinor: 14000, wonCount: 1, wonMinor: 9000, lostCount: 1, winRate: 0.5, winRateDisplay: '50%' },
    { owner: 'bob', openCount: 0, openMinor: 0, wonCount: 1, wonMinor: 5000, lostCount: 0, winRate: 1, winRateDisplay: '100%' },
  ],
  owners: ['alice', 'bob'],
  forecast: {
    currency: 'EUR', closedMinor: 14000, probableMinor: 9333, bestMinor: 14000, targetMinor: 2000000,
    heuristic: true, label: 'Stima euristica',
    method: 'Le probabili usano il tasso di chiusura storico (vinte su vinte + perse); non è una promessa.',
    note: 'Obiettivo 2.000.000,00 € dal bundle reporting.',
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

test('header shows the bundle badges under the title (C2)', async () => {
  const { mount, view } = harness();
  await view.renderReporting();
  const badges = mount.findAll('span').map((node) => node.textContent);
  assert.deepEqual(REPORTING_BADGES, [
    'reporting@1.2.0',
    'Bundle separato dal kernel',
    'Generato dal tuo agente di coding · 3 giorni fa',
  ]);
  for (const badge of REPORTING_BADGES) {
    assert.ok(badges.includes(badge), `badge renders: ${badge}`);
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
  assert.match(text, /28 nel periodo/, 'C6: <n> nel periodo');
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

test('an empty channel breakdown renders title, zero and empty bars, never blank (C20)', async () => {
  const { mount, view } = harness({
    dashboard: { ...MODEL, channels: { weeks: [], channels: [], total: 0, undated: 0 } },
  });
  await view.renderReporting();
  const text = [
    ...mount.findAll('h3'), ...mount.findAll('p'), ...mount.findAll('span'),
  ].map((node) => node.textContent).join(' | ');
  assert.match(text, /Nuovi clienti per canale/);
  assert.match(text, /0 nel periodo/);
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
    `✦ Ti mancano ${formatMoney(1976667, 'EUR')} per l\u2019obiettivo`,
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
        note: 'Obiettivo non impostato: aggiungi una riga obiettivo nel bundle reporting.',
      },
    },
  });
  await noTarget.view.renderReporting();
  const bare = noTarget.mount.findAll('p').map((node) => node.textContent).join(' | ');
  assert.ok(!bare.includes('Sei in linea'), 'no target: no status line invented');
  assert.ok(!bare.includes('Ti mancano'), 'no target: no gap invented');
  assert.ok(bare.includes('Obiettivo non impostato'), 'the missing-obiettivo note still renders');
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
