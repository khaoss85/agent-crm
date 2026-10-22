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
 */

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
  assert.ok(/non si avvia e non serve/.test(steps.proof), 'verify is the proof, never a simulation');
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
    client: { request: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } },
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
      client: { request: async () => failure.fail() },
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
    client: { request: async () => { throw Object.assign(new Error('not found'), { status: 404, code: 'MODULE_NOT_FOUND' }); } },
    navigate: () => {},
    log: (message, cause) => logged.push([message, cause]),
  });
  await view.renderReporting();
  const text = [...mount.findAll('p'), ...mount.findAll('div')].map((node) => node.textContent).join(' ');
  assert.match(text, /non composto/, 'the 404 names the missing bundle instead of faking rows');
  assert.deepEqual(logged, [], 'a 404 is expected setup state, not a logged error');
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
      request: async () => {
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
    onAskAi: (screenId) => asked.push(screenId),
  });
  view.renderNuovoModulo();
  const headings = mount.findAll('h3').map((node) => node.textContent);
  assert.ok(headings.includes('Crea con l’AI'), `the AI option is there, got ${JSON.stringify(headings)}`);
  assert.ok(headings.includes('Crea manuale'), `the manual option is there, got ${JSON.stringify(headings)}`);
  const titles = mount.findAll('h2').map((node) => node.textContent);
  assert.ok(titles.some((title) => /Sviluppa per Accordo|fuori dal processo condiviso/.test(title ?? '')),
    `the Sviluppa card is there, got ${JSON.stringify(titles)}`);
  const code = mount.findAll('code').map((node) => node.textContent).join('\n');
  assert.match(code, /bundle create .* --created-by ai --apply/, 'the manual path shows the real create command');
  assert.match(code, /bundle verify /, 'the manual path shows the real verify command');
  assert.match(code, /bundle install /, 'the manual path shows the real install command');
  const ask = mount.findAll('button').find((node) => node.textContent === 'Chiedi all’assistente');
  assert.ok(ask, 'the AI option has its forward button');
  ask.dispatch('click', {});
  assert.deepEqual(asked, ['nuovo-modulo'], 'the description flow forwards to the assistant panel screen');
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
  assert.match(answer.lines.join(' '), /bundle verify/, 'the guide names the installability proof');
  assert.match(answer.lines.join(' '), /mai nel kernel|non esiste/, 'the guide refuses simulation');
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
