import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NUOVO_MODULO_ROUTE,
  REPORTING_LIMIT,
  REPORTING_ROUTE,
  bundleCommands,
  createReportingView,
  manualSteps,
  reportingSummary,
} from '../apps/admin/public/admin-reporting.js';
import { buildShellNav } from '../apps/admin/public/admin-shell.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { runSuggestion, suggestionsFor } from '../apps/admin/public/admin-assistant.js';
import { aiPlaceholder } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * BO-F5-01 (backlog:8691acfc): the Reporting screen reads the reference
 * bundle's live rows, "+ Nuovo modulo" offers the double option with the
 * 'Sviluppa per Accordo' card, and the AI option forwards to the assistant
 * panel — nothing is generated in the browser. These tests drive the real
 * view code with the dependency-free fake DOM, like every other admin view
 * test — no browser.
 *
 * BO-F5-02 added the pipeline dashboard above the bundle table (fetched
 * from /api/reporting/dashboard). These bundle-focused stubs answer that
 * path with an empty-but-valid model so each test below keeps proving only
 * its bundle contract; the dashboard itself is covered in
 * tests/admin-reporting-dashboard.test.js.
 */
function emptyDashboard() {
  return {
    period: '2026-10',
    periodLabel: 'ottobre 2026',
    owner: null,
    currency: 'EUR',
    currencies: { shown: 'EUR', others: [] },
    generatedAt: '2026-10-22T20:00:00.000Z',
    metrics: { modelVersion: 1 },
    truncated: false,
    kpis: [],
    funnel: [],
    valueByStage: [],
    monthly: [],
    team: [],
    owners: [],
    channels: { weeks: [], channels: [], total: 0, undated: 0 },
    forecast: {
      currency: 'EUR', closedMinor: 0, probableMinor: 0, bestMinor: 0, targetMinor: null,
      heuristic: true, label: 'Stima euristica', method: 'metodo', note: 'nota',
    },
    insights: [],
    proposal: null,
    csv: { filename: 'reporting.csv', content: 'x\n' },
  };
}

test('bundle commands are exact, versioned and never floating', () => {
  assert.equal(REPORTING_ROUTE, '#/reporting');
  assert.equal(NUOVO_MODULO_ROUTE, '#/nuovo-modulo');
  const commands = bundleCommands({ manifestPath: 'sonde.module.json', name: 'sonde', version: '0.1.0' });
  assert.match(commands.create, /bundle create sonde\.module\.json --name sonde --version 0\.1\.0 --created-by ai --apply/);
  assert.match(commands.verify, /bundle verify sonde@0\.1\.0/);
  assert.match(commands.install, /bundle install sonde@0\.1\.0/);
  const steps = manualSteps();
  assert.ok(steps.checklist.length >= 3, 'the manual path names what a manifest needs');
  assert.ok(steps.checklist.some((line) => /kernel/i.test(line)), 'the checklist refuses kernel tables');
  assert.ok(/si apre davvero/.test(steps.proof), 'verify is the proof, never a simulation');
  assert.ok(/non esiste/.test(steps.proof), 'a module that does not open does not exist');
  // P2 admin-reporting.js:119: a future caller threading user input into
  // createdBy renders a second shell command in the copy-pasteable text.
  // Only the CLI contract values pass; anything else throws, never
  // interpolates.
  assert.match(bundleCommands({ createdBy: 'manual' }).create, /--created-by manual/);
  assert.throws(() => bundleCommands({ createdBy: 'ai --apply; curl evil' }), /createdBy must be one of/);
  assert.throws(() => bundleCommands({ createdBy: '' }), /createdBy must be one of/);
});

test('reportingSummary groups by metric, newest period wins, hostile rows are skipped', () => {
  const summary = reportingSummary([
    { metric: 'chiamate', period: '2026-09', value: 12, unit: 'call' },
    { metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' },
    { metric: 'chiusure', period: '2026-10', value: 3 },
    null,
    'nope',
    { metric: '', period: '2026-10', value: 1 },
    { period: '2026-10', value: 1 },
  ]);
  assert.deepEqual(summary.map((entry) => entry.metric), ['chiamate', 'chiusure']);
  const chiamate = summary.find((entry) => entry.metric === 'chiamate');
  assert.equal(chiamate.periods, 2);
  assert.equal(chiamate.lastPeriod, '2026-10');
  assert.equal(chiamate.lastValue, '20');
  assert.deepEqual(reportingSummary(null), []);
  assert.deepEqual(reportingSummary('nope'), []);
});

test('reportingSummary keeps the newest row on equal periods, never the oldest', () => {
  // The service returns newest-first: on equal periods the FIRST row seen
  // wins. `>=` overwrote it with the older one (P2 admin-reporting.js:77).
  const summary = reportingSummary([
    { metric: 'chiusure', period: '2026-10', value: 5 },
    { metric: 'chiusure', period: '2026-10', value: 3 },
    { metric: 'chiusure', period: '2026-09', value: 1 },
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].lastPeriod, '2026-10');
  assert.equal(summary[0].lastValue, '5', 'the newest row on the tied period wins');
  assert.equal(summary[0].periods, 3);
});

test('reporting screen serves the bundle rows live, with the "+ Nuovo modulo" entry', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
        assert.match(path, /\/api\/modules\/reporting\/records/);
        return { items: [{ id: 'r1', metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' }] };
      },
    },
    navigate: (hash) => seen.push(hash),
  });
  await view.renderReporting();
  const text = mount.querySelector('section');
  assert.ok(text, 'the screen renders');
  const cells = mount.findAll('td').map((node) => node.textContent);
  assert.ok(cells.includes('chiamate'), `bundle rows are served, got ${JSON.stringify(cells)}`);
  assert.ok(cells.includes('20 call'), `values render with units, got ${JSON.stringify(cells)}`);
  const nuovo = mount.findAll('button').find((node) => node.textContent === '+ Nuovo modulo');
  assert.ok(nuovo, 'the "+ Nuovo modulo" entry is on the reporting screen');
  nuovo.dispatch('click', {});
  assert.deepEqual(seen, [NUOVO_MODULO_ROUTE]);
});

test('reporting screen without the bundle says so honestly, never blank', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    },
    navigate: (hash) => seen.push(hash),
  });
  await view.renderReporting();
  const empties = [...mount.findAll('p'), ...mount.findAll('div')].map((node) => node.textContent).join(' ');
  assert.match(empties, /non composto/, 'the screen names the missing bundle instead of faking rows');
  const nuovo = mount.findAll('button').find((node) => node.textContent === '+ Nuovo modulo');
  assert.ok(nuovo, 'the entry point stays even without the bundle');
  nuovo.dispatch('click', {});
  assert.deepEqual(seen, [NUOVO_MODULO_ROUTE]);
});

test('a 500 (or auth, or network) failure is an error state with a log line, never "not composed"', async () => {
  // P2 admin-reporting.js:177: every fetch error rendered as "not composed"
  // with no logging, so a 500/auth outage misdiagnosed as missing setup.
  // Only 404 (the server's fail-closed for an uncomposed module) is honest
  // "not composed"; anything else gets its own state and a cause log.
  for (const failure of [
    { label: 'server 500', fail: () => { throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' }); } },
    { label: 'auth 401', fail: () => { throw Object.assign(new Error('denied'), { status: 401, code: 'UNAUTHENTICATED' }); } },
    { label: 'network down', fail: () => { throw new TypeError('fetch failed'); } },
  ]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const logged = [];
    const view = createReportingView({
      doc,
      mount,
      client: {
        request: async (path) => {
          if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
          return failure.fail();
        },
      },
      navigate: () => {},
      log: (message, cause) => logged.push([message, cause]),
    });
    await view.renderReporting();
    const text = [...mount.findAll('p'), ...mount.findAll('div')].map((node) => node.textContent).join(' ');
    assert.match(text, /non disponibile/, `${failure.label}: the screen names the failure, got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /non composto/, `${failure.label}: a real failure is never the not-composed state`);
    assert.equal(logged.length, 1, `${failure.label}: the cause is logged once`);
    assert.equal(logged[0][0], 'reporting records request failed');
    const cause = logged[0][1];
    assert.ok(cause && typeof cause === 'object', `${failure.label}: the cause is a redacted object`);
    assert.ok(!('details' in cause) && !('message' in cause), `${failure.label}: no tokens or payloads in the log`);
  }
});

test('a 404 stays the honest not-composed state with no error log', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const logged = [];
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
        throw Object.assign(new Error('not found'), { status: 404, code: 'MODULE_NOT_FOUND' });
      },
    },
    navigate: () => {},
    log: (message, cause) => logged.push([message, cause]),
  });
  await view.renderReporting();
  const text = [...mount.findAll('p'), ...mount.findAll('div')].map((node) => node.textContent).join(' ');
  assert.match(text, /non composto/, 'the 404 names the missing bundle instead of faking rows');
  assert.deepEqual(logged, [], 'a 404 is expected setup state, not a logged error');
});

test('a 200 without an items array is a load error, never "not composed"', async () => {
  // P2 admin-reporting.js:180: a successful 200 with missing or non-array
  // items rendered as not-composed, sending the operator to create a bundle
  // that already exists. Only a real array (even empty) renders rows.
  for (const body of [{}, { items: null }, { items: 'x' }]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const logged = [];
    const view = createReportingView({
      doc,
      mount,
      client: {
        request: async (path) => {
          if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
          return body;
        },
      },
      navigate: () => {},
      log: (message, cause) => logged.push([message, cause]),
    });
    await view.renderReporting();
    const text = [...mount.findAll('p'), ...mount.findAll('div')].map((node) => node.textContent).join(' ');
    assert.match(text, /non disponibile/, `body ${JSON.stringify(body)}: the screen names the failure, got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /non composto/, `body ${JSON.stringify(body)}: a 200 without rows is never the not-composed state`);
    assert.equal(logged.length, 1, `body ${JSON.stringify(body)}: the cause is logged once`);
    assert.equal(logged[0][0], 'reporting records request failed');
    assert.deepEqual(logged[0][1], { name: 'Error', status: 200, code: null });
  }
});

test('renderNuovoModulo invalidates an in-flight renderReporting', async () => {
  // P2 admin-reporting.js:252: renderNuovoModulo never invalidated an
  // in-flight renderReporting, so a stale reporting response overwrote the
  // nuovo-modulo view after navigation.
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
        await gate;
        return { items: [{ metric: 'tardiva', period: '2026-10', value: 1 }] };
      },
    },
    navigate: () => {},
    onAskAi: () => {},
  });
  const pending = view.renderReporting();
  view.renderNuovoModulo();
  release();
  await pending;
  const headings = mount.findAll('h3').map((node) => node.textContent);
  assert.ok(headings.includes('Crea con l’AI'), `the nuovo-modulo screen stays, got ${JSON.stringify(headings)}`);
  const cells = mount.findAll('td').map((node) => node.textContent);
  assert.ok(!cells.includes('tardiva'), 'the stale reporting response never paints over the nuovo-modulo screen');
});

test('a stale reporting response never overwrites the newer view', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path) => {
        if (path.includes('/api/reporting/dashboard')) return emptyDashboard();
        calls += 1;
        if (calls === 1) await gate;
        return { items: [{ metric: 'tardiva', period: '2026-10', value: 1 }] };
      },
    },
    navigate: () => {},
  });
  const first = view.renderReporting();
  const second = view.renderReporting();
  release();
  await first;
  await second;
  const cells = mount.findAll('td').map((node) => node.textContent);
  assert.equal(cells.filter((cell) => cell === 'tardiva').length, 1, 'the stale response renders exactly once');
});

test('nuovo modulo shows the double option and the Sviluppa card, AI forwards to the panel', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const asked = [];
  const view = createReportingView({
    doc,
    mount,
    client: { request: async () => ({ items: [] }) },
    navigate: () => {},
    onAskAi: (screenId, description) => asked.push([screenId, description]),
  });
  view.renderNuovoModulo();
  const headings = mount.findAll('h3').map((node) => node.textContent);
  assert.ok(headings.includes('Crea con l’AI'), `the AI option is there, got ${JSON.stringify(headings)}`);
  assert.ok(headings.includes('Crea manuale'), `the manual option is there, got ${JSON.stringify(headings)}`);
  const titles = mount.findAll('h2').map((node) => node.textContent);
  assert.ok(titles.some((title) => /Sviluppa per Accordo|fuori dal processo condiviso/.test(title ?? '')),
    `the Sviluppa card is there, got ${JSON.stringify(titles)}`);
  const code = mount.findAll('code').map((node) => node.textContent).join('\n');
  assert.match(code, /bundle create .* --created-by manual --apply/, 'the manual path shows the real create command with manual provenance');
  assert.match(code, /bundle verify /, 'the manual path shows the real verify command');
  assert.match(code, /bundle install /, 'the manual path shows the real install command');
  const areas = mount.findAll('textarea');
  assert.equal(areas.length, 1, 'the AI option has its description field');
  const ask = mount.findAll('button').find((node) => node.textContent === 'Chiedi all’assistente');
  assert.ok(ask, 'the AI option has its forward button');
  // P2 admin-reporting.js:289: the typed description travels with the
  // handoff — only the screen id was forwarded, the text was dropped.
  areas[0].value = 'un modulo sonde per i KPI del pilota (etichetta + conteggio)';
  ask.dispatch('click', {});
  assert.deepEqual(asked, [['nuovo-modulo', 'un modulo sonde per i KPI del pilota (etichetta + conteggio)']],
    'the typed description reaches the assistant panel with the screen');
  // Hostile text travels as input text, never markup: the panel assigns it
  // to the input value, it is never rendered as HTML.
  areas[0].value = '<img src=x onerror=alert(1)>';
  ask.dispatch('click', {});
  assert.deepEqual(asked[1], ['nuovo-modulo', '<img src=x onerror=alert(1)>'], 'hostile text is forwarded verbatim as text');
});

test('reporting and nuovo-modulo routes resolve, deep paths are invalid', () => {
  assert.deepEqual(parseModuleRoute('#/reporting'), { view: 'reporting' });
  assert.deepEqual(parseModuleRoute('#/reporting/'), { view: 'reporting' });
  assert.deepEqual(parseModuleRoute('#/nuovo-modulo'), { view: 'nuovo-modulo' });
  assert.deepEqual(parseModuleRoute('#/nuovo-modulo/'), { view: 'nuovo-modulo' });
  for (const hash of ['#/reporting/x', '#/nuovo-modulo/ai', '#/reporting//']) {
    assert.equal(parseModuleRoute(hash).view, 'invalid', hash);
  }
});

test('assistant guides the AI bundle path with real steps and screen links', async () => {
  const options = suggestionsFor('nuovo-modulo');
  assert.ok(options.some((option) => option.id === 'bo05:nuovo-modulo:crea-ai'), 'the nuovo-modulo screen has its suggestion');
  assert.equal(aiPlaceholder('nuovo-modulo'), 'Descrivi: «un modulo sonde per i KPI del pilota»');
  // The guide reads no records, but the gate still wants a client shape.
  const answer = await runSuggestion({ request: async () => ({}) }, 'bo05:nuovo-modulo:crea-ai');
  assert.match(answer.lines.join(' '), /provato davvero|mostra un record/, 'the guide names the installability proof');
  assert.match(answer.lines.join(' '), /mai nel kernel|non esiste/, 'the guide refuses simulation');
  assert.ok(!answer.lines.join(' ').includes('bundle verify'), 'the guide never names the CLI command');
  const hrefs = answer.actions.filter((action) => action.kind === 'navigate').map((action) => action.href);
  assert.ok(hrefs.includes('#/nuovo-modulo'), 'the guide links back to the screen');
  assert.ok(hrefs.includes('#/reporting'), 'the guide links to reporting');
});

test('sidebar lists Reporting and Nuovo modulo under Moduli personalizzati', () => {
  const nav = buildShellNav();
  const byId = Object.fromEntries(nav.map((item) => [item.id, item]));
  assert.equal(byId.reporting.route, '#/reporting');
  assert.equal(byId.reporting.available, true);
  assert.equal(byId.reporting.story, 'BO-F5-01');
  assert.equal(byId['nuovo-modulo'].route, '#/nuovo-modulo');
  assert.equal(byId['nuovo-modulo'].available, true);
  assert.equal(byId['nuovo-modulo'].group, 'custom');
  assert.ok(REPORTING_LIMIT >= 1, 'the read page stays bounded');
});
