// @ts-check
/**
 * Backoffice BO-F6-05 — `npm run bo:shots` (backlog:5acdfd87bbd0).
 *
 * What it must prove:
 * - one PNG per screen at 1440px and at 390px, none empty (the full run
 *   counts the files and checks every width and byte floor);
 * - the run works fully offline (loopback only); where no runnable Chromium
 *   exists, even with --no-sandbox, the command fails loudly (exit 1) and
 *   says why instead of skipping in silence (backlog:cd0ad69b);
 * - the screen registry is exactly the fourteen delivered /bo screens plus the
 *   componenti catalog, and
 *   every harness page serves its real view module.
 *
 * The full render runs wherever Chromium runs, with or without the sandbox
 * (the flags probe below retries once with --no-sandbox): elsewhere the
 * render tests skip and the failure-path test below still proves the loud
 * exit.
 */

import test from 'node:test';
import { CONNECTOR_CATALOG } from '../apps/admin/public/admin-connectors.js';
import { formatMinor } from '../packages/analytics/src/dashboard.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BO_SCREENS,
  SCREENS,
  SHELL_SCREENS,
  SHOT_MAX_ATTEMPTS,
  USAGE,
  assertProbe,
  checkShotSize,
  chromiumFlags,
  chromiumRuns,
  findChromium,
  harnessHtml,
  parseArgs,
  readPngSize,
  readProbe,
  reportingBundleRows,
  reportingModelFor,
  reportingMonthLabel,
  reportingShiftMonth,
  shotFloor,
} from '../scripts/bo-shots.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const publicDir = join(root, 'apps', 'admin', 'public');

const EXPECTED_SCREENS = [
  'login',
  'oggi',
  'clienti',
  'cliente',
  'import',
  'pipeline',
  'calendario',
  'sequenze',
  'agenti',
  'reporting',
  'nuovo-modulo',
  'personalizzazione',
  'catalogo',
  'stato-sync',
  'profilo',
  'spazi-accessi',
  'connettori',
  'componenti',
];

test('the screen registry is the fourteen delivered screens plus the componenti catalog', () => {
  assert.deepEqual([...BO_SCREENS], EXPECTED_SCREENS);
});

test('every harness module parses (top-level await included)', () => {
  for (const name of BO_SCREENS) {
    if (name === 'login') continue;
    const page = harnessHtml(name, publicDir);
    const code = page.split('<script type="module">')[1].split('</script>')[0];
    assert.ok(code.includes('document.title'), `${name}: the harness finishes with a ready marker`);
    const dir = mkdtempSync(join(tmpdir(), 'bo-shots-parse-'));
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, code);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(checked.status, 0, `${name}: harness module parses (${(checked.stderr ?? '').slice(-300)})`);
  }
  {
    const login = harnessHtml('login', publicDir);
    const modules = login.split('<script type="module">').slice(1)
      .map((part) => part.split('</script>')[0]);
    assert.equal(modules.length, 2, 'login serves its enhancement plus the harness probe');
    for (const [index, code] of modules.entries()) {
      const dir = mkdtempSync(join(tmpdir(), 'bo-shots-parse-login-'));
      const file = join(dir, `login-${index}.mjs`);
      writeFileSync(file, code);
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(checked.status, 0, `login module ${index} parses (${(checked.stderr ?? '').slice(-300)})`);
    }
  }
  assert.throws(() => harnessHtml('nope', publicDir), /no harness for screen/);
});

test('every harness page serves its real module or the real login markup', () => {
  assert.ok(existsSync(join(publicDir, 'login.html')), 'login.html ships with the /bo assets');
  const byName = new Map(SCREENS.map((screen) => [screen.name, screen]));
  for (const name of BO_SCREENS) {
    const page = harnessHtml(name, publicDir);
    if (name === 'login') {
      assert.ok(page.includes('login-magic'), 'login serves the real login form');
      assert.ok(page.includes('Ogni conversazione'), 'login keeps its story panel');
      assert.ok(page.includes('./login.js'), 'login keeps the #408 enhancement wiring');
      assert.ok(/id="probe" hidden/.test(page), 'login carries a hidden probe');
      assert.ok(!page.includes('document.body'), 'the login probe reads its mounts, not the whole page');
      continue;
    }
    const screen = byName.get(name);
    assert.ok(screen?.module, `${name} maps to a view module`);
    assert.ok(existsSync(join(publicDir, screen.module)), `${name}: ${screen.module} ships with the /bo assets`);
    assert.ok(page.includes('/styles.css'), `${name}: the real stylesheet`);
    assert.ok(page.includes(`./${screen.module}`), `${name}: the page drives the real ${screen.module}`);
    // The ready marker the run waits for is uniform: a renamed harness that
    // keeps its old title would fail the browser run only on CI.
    assert.equal(screen.ready, `${name}-ready`, `${name}: the ready marker matches the screen`);
    assert.ok(page.includes(`document.title = '${name}-ready'`), `${name}: the harness sets its marker`);
  }
});

test('harness pages photograph the full /bo shell with a hidden probe', () => {
  for (const name of BO_SCREENS) {
    if (name === 'login') continue;
    const page = harnessHtml(name, publicDir);
    assert.ok(page.includes('id="boSidebar"'), `${name}: the sidebar ships in the photographed page`);
    assert.ok(page.includes('id="boTopbar"'), `${name}: the topbar ships in the photographed page`);
    assert.ok(page.includes('./admin-shell.js'), `${name}: the page drives the real admin-shell.js`);
    assert.ok(page.includes('createShellView'), `${name}: the shell renders through createShellView`);
    assert.ok(page.includes(`getElementById('view-module')`), `${name}: the view mounts where the /bo app mounts it`);
    assert.ok(!page.includes(`getElementById('mount')`), `${name}: no bare harness mount is left`);
    assert.ok(/id="probe" hidden/.test(page), `${name}: the probe stays out of the photograph`);
  }
});

test('the clienti harness names counted pills and one label-only fallback', () => {
  // backlog:22d4dd0f, C10: the next render paints counted pills for the
  // views the demo server knows, and the bare label for rinnovi, whose
  // dependency reads as unavailable — both states the P2 asks to see.
  const page = harnessHtml('clienti', publicDir);
  for (const view of [
    "{ id: 'tutti', label: 'Tutti', count: 3 }",
    "{ id: 'ricontattare-oggi', label: 'Da ricontattare oggi', count: 1 }",
    "{ id: 'nuovi-lead', label: 'Nuovi lead', count: 1 }",
    "{ id: 'clienti-attivi', label: 'Clienti attivi', count: 1 }",
    "{ id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni' }",
  ]) {
    assert.ok(page.includes(view), `the demo names ${view}`);
  }
  assert.ok(page.includes('button[role="tab"]'), 'the probe reads the pill tabs');
  // backlog:22d4dd0f, C16: the demo row carries a message excerpt, so the
  // next render paints sigla + anteprima + «canale · quando» like the prototype.
  assert.ok(page.includes('lastContactText'), 'the demo row carries an excerpt');
});

test('every screen photographs with its shell identity from the /bo router', () => {
  // Mirrors apps/admin/public/app.js `shellScreenFor`: the same sidebar
  // voice is highlighted and the same path is crumbed as in the app.
  assert.deepEqual(SHELL_SCREENS, {
    oggi: { id: 'oggi', label: 'Oggi' },
    clienti: { id: 'clienti', label: 'Clienti' },
    cliente: { id: 'clienti', label: 'Clienti' },
    import: { id: 'clienti', label: 'Importa clienti' },
    pipeline: { id: 'pipeline', label: 'Pipeline' },
    calendario: { id: 'calendario', label: 'Calendario' },
    sequenze: { id: 'sequenze', label: 'Sequenze' },
    agenti: { id: 'agenti', label: 'Agenti' },
    reporting: { id: 'reporting', label: 'Reporting' },
    'nuovo-modulo': { id: 'nuovo-modulo', label: 'Nuovo modulo' },
    personalizzazione: { id: 'impostazioni', label: 'Personalizzazione' },
    catalogo: { id: 'impostazioni', label: 'Catalogo prodotti' },
    'stato-sync': { id: 'impostazioni', label: 'Stato sync', ai: 'stato-sync' },
    'spazi-accessi': { id: 'impostazioni', label: 'Spazi e accessi' },
    profilo: { id: 'impostazioni', label: 'Profilo' },
    connettori: { id: 'impostazioni', label: 'Connettori' },
    componenti: { id: '', label: 'Componenti' },
  });
  for (const name of BO_SCREENS) {
    if (name === 'login') continue;
    const page = harnessHtml(name, publicDir);
    const shell = SHELL_SCREENS[name];
    assert.ok(page.includes(`activeScreenId: "${shell.id}"`), `${name}: the shell highlights ${shell.id || 'no voice'}`);
    assert.ok(page.includes(`screenLabel: "${shell.label}"`), `${name}: the topbar crumbs ${shell.label}`);
  }
});

test('parseArgs defaults outside the repo and filters one screen', () => {
  const defaults = parseArgs([], { root: '/repo' });
  assert.equal(defaults.help, false);
  assert.equal(defaults.screen, null);
  assert.equal(defaults.out, resolve('/repo', '..', 'bo-shots'));
  assert.ok(!defaults.out.startsWith('/repo/'), 'the default output stays outside the repo');
  const one = parseArgs(['--out', '/tmp/x', '--screen', 'oggi'], { root: '/repo' });
  assert.equal(one.out, '/tmp/x');
  assert.equal(one.screen, 'oggi');
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs refuses unknown screens and flags', () => {
  assert.throws(() => parseArgs(['--screen', 'nope']), /unknown screen/);
  assert.throws(() => parseArgs(['--screen']), /needs one of/);
  assert.throws(() => parseArgs(['--out']), /needs a directory/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('parseArgs reads --period and --theme (backlog:c0726d0f6d13)', () => {
  const defaults = parseArgs([], { root: '/repo' });
  assert.equal(defaults.period, null);
  assert.equal(defaults.theme, 'light');
  const asked = parseArgs(['--screen', 'reporting', '--period', '2026-10', '--theme', 'dark'], { root: '/repo' });
  assert.equal(asked.period, '2026-10');
  assert.equal(asked.theme, 'dark');
  assert.throws(() => parseArgs(['--period', '2026-13']), /--period needs YYYY-MM/);
  assert.throws(() => parseArgs(['--period']), /--period needs YYYY-MM/);
  assert.throws(() => parseArgs(['--period', 'ottobre']), /--period needs YYYY-MM/);
  assert.throws(() => parseArgs(['--theme', 'sepia']), /--theme needs light or dark/);
  assert.throws(() => parseArgs(['--theme']), /--theme needs light or dark/);
});

test('the reporting harness photographs the asked month (backlog:c0726d0f6d13)', () => {
  const page = harnessHtml('reporting', publicDir, { period: '2026-10' });
  assert.ok(page.includes('"period":"2026-10"'), 'the harness model answers October');
  assert.ok(page.includes('"periodLabel":"ottobre 2026"'), 'the harness labels October');
  const other = harnessHtml('reporting', publicDir, { period: '2026-11' });
  assert.ok(other.includes('"period":"2026-11"'), 'the harness model answers November');
  assert.ok(other.includes('"periodLabel":"novembre 2026"'), 'the harness labels November');
});

test('below-floor shots are retaken once, never lowered (backlog:418b90704674)', () => {
  // One retry only: the first shot plus exactly one retake, then the run
  // fails naming the screen. The floors themselves never move down.
  assert.equal(SHOT_MAX_ATTEMPTS, 2, 'first shot plus exactly one retry');
  assert.equal(shotFloor('desktop'), 20000, 'the desktop floor stays at 20000 bytes');
  assert.equal(shotFloor('phone'), 10000, 'the phone floor stays at 10000 bytes');
  assert.throws(() => shotFloor('tablet'), /no byte floor/, 'unknown viewports have no floor');
});

test('checkShotSize gates existence and dimensions, never the floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bo-shots-size-'));
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const length = Buffer.alloc(4);
  const kind = Buffer.from('IHDR', 'ascii');
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(1440, 0);
  dimensions.writeUInt32BE(1800, 4);
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.concat([header, length, kind, dimensions]));
  const shot = checkShotSize(file, 'oggi', 'desktop', { width: 1440, height: 1800 });
  assert.equal(shot.width, 1440);
  assert.equal(shot.height, 1800);
  // A wrong size is deterministic from --window-size, never a paint race:
  // it throws at once and names the screen, without consuming the retake.
  assert.throws(
    () => checkShotSize(file, 'oggi', 'phone', { width: 390, height: 1600 }),
    /oggi phone: the PNG is 1440x1800, expected 390x1600/,
  );
  assert.throws(
    () => checkShotSize(join(dir, 'missing.png'), 'oggi', 'desktop', { width: 1440, height: 1800 }),
    /oggi desktop: .* without writing the screenshot/,
  );
});

test('the reporting demo follows the asked period (backlog:06d4b855fac4)', () => {
  // Like the real server (formatMonth(query.period)): period, labels, the
  // monthly window, the channel weeks and the CSV name follow the period
  // the screen asks for, never a fixed October.
  assert.equal(reportingMonthLabel('2026-10'), 'ottobre 2026');
  assert.equal(reportingMonthLabel('2026-11'), 'novembre 2026');
  assert.equal(reportingShiftMonth('2026-11', -1), '2026-10');
  assert.equal(reportingShiftMonth('2026-01', -1), '2025-12');
  const october = reportingModelFor('2026-10');
  assert.equal(october.period, '2026-10');
  assert.equal(october.periodLabel, 'ottobre 2026');
  assert.ok(
    october.kpis.some((kpi) => kpi.id === 'won-period' && kpi.label === 'Vinte in ottobre 2026'),
    'the won card names October',
  );
  assert.deepEqual(october.monthly.map((entry) => entry.month), ['2026-09', '2026-10']);
  assert.equal(october.monthly.at(-1).label, 'ottobre 2026');
  assert.equal(october.csv.filename, 'reporting-2026-10.csv');
  assert.ok(october.csv.content.startsWith('reporting;2026-10;'), 'the CSV names October');
  const november = reportingModelFor('2026-11');
  assert.equal(november.period, '2026-11');
  assert.equal(november.periodLabel, 'novembre 2026');
  assert.ok(
    november.kpis.some((kpi) => kpi.id === 'won-period' && kpi.label === 'Vinte in novembre 2026'),
    'the won card names November with November asked',
  );
  assert.deepEqual(november.monthly.map((entry) => entry.month), ['2026-10', '2026-11']);
  assert.equal(november.csv.filename, 'reporting-2026-11.csv');
  // The four Monday-start weeks opening the asked month (1 Nov 2026 is a
  // Sunday, so the first week starts Mon 26 Oct), never the fixed October set.
  assert.deepEqual(november.channels.weeks.map((week) => week.week), [
    '2026-10-26',
    '2026-11-02',
    '2026-11-09',
    '2026-11-16',
  ]);
  assert.deepEqual(october.channels.weeks.map((week) => week.week), [
    '2026-09-28',
    '2026-10-05',
    '2026-10-12',
    '2026-10-19',
  ]);
  // An invalid period falls back to the fixture's own month, never garbage.
  assert.equal(reportingModelFor('nope').period, '2026-10');
  // The bundle summary rows follow the same month as the cards.
  assert.deepEqual(reportingBundleRows('2026-11'), [
    { id: 'r1', metric: 'chiamate', period: '2026-11', value: 20, unit: 'call' },
  ]);
});

test('the reporting demo uses one money scale with totals that add up (backlog:6e927ba9dd16)', () => {
  // Cards, funnel, monthly, forecast, team and CSV all read minor cents on
  // the same scale: open stages add up to the open-value KPI, won to the
  // won-period KPI, the team splits both, and the forecast closes on won.
  const model = reportingModelFor('2026-10');
  const kpi = (id) => model.kpis.find((entry) => entry.id === id);
  const openStages = model.funnel.filter((entry) => entry.stage !== 'won');
  const openMinor = openStages.reduce((sum, entry) => sum + entry.minor, 0);
  const openCount = openStages.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(formatMinor(openMinor, 'EUR'), kpi('open-value').display);
  assert.equal(formatMinor(openMinor, 'EUR'), kpi('open-count').sub);
  assert.equal(openCount, Number(kpi('open-count').display));
  const won = model.funnel.find((entry) => entry.stage === 'won');
  assert.equal(formatMinor(won.minor, 'EUR'), kpi('won-period').display);
  assert.equal(model.forecast.closedMinor, won.minor);
  assert.equal(model.team.reduce((sum, entry) => sum + entry.openMinor, 0), openMinor);
  assert.equal(model.team.reduce((sum, entry) => sum + entry.openCount, 0), openCount);
  assert.equal(model.team.reduce((sum, entry) => sum + entry.wonMinor, 0), won.minor);
  assert.equal(model.monthly.at(-1).wonMinor, won.minor);
  const csvRows = model.csv.content.trim().split('\n').slice(1).map((line) => line.split(';'));
  assert.equal(csvRows.reduce((sum, row) => sum + Number(row[1]), 0), openCount);
  assert.equal(csvRows.reduce((sum, row) => sum + Number(row[2]), 0), openMinor);
});

test('the reporting harness answers the current period end to end', async () => {
  // The fixture the page serves is built for the same currentPeriod() the
  // screen asks for, so the painted month and the card labels coincide.
  const { currentPeriod } = await import('../apps/admin/public/admin-reporting.js');
  const asked = currentPeriod();
  const page = harnessHtml('reporting', publicDir);
  assert.ok(
    page.includes(`"period":"${asked}"`),
    `the harness model answers the asked period (${asked})`,
  );
  assert.ok(
    page.includes(`"periodLabel":"${reportingMonthLabel(asked)}"`),
    'the harness model labels the asked month',
  );
});

test('readPngSize reads dimensions and refuses non-PNG output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bo-shots-unit-'));
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const length = Buffer.alloc(4);
  const kind = Buffer.from('IHDR', 'ascii');
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(1440, 0);
  dimensions.writeUInt32BE(1800, 4);
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.concat([header, length, kind, dimensions]));
  assert.deepEqual(readPngSize(file), { bytes: 24, width: 1440, height: 1800 });
  const bad = join(dir, 'empty.png');
  writeFileSync(bad, Buffer.alloc(0));
  assert.throws(() => readPngSize(bad), /not a PNG/);
  const text = join(dir, 'page.html');
  writeFileSync(text, '<html></html>');
  assert.throws(() => readPngSize(text), /not a PNG/);
});

test('calendario expects are dynamic-only: static chrome alone must fail them', () => {
  // Regression for review P2 (scripts/bo-shots.js:491): the empty week still
  // serves the static 'Mostra settimana' button and the manual-form
  // placeholder '...per il taglio', so expects built from those substrings
  // pass on a painted-but-empty grid. Every calendario expect must be a
  // string the static page can never contain: a painted event marker. Since
  // fetta 4 the customer link lives in the detail card (painted only after a
  // block click), the painted proof is the Rome time range of a held event.
  const calendario = SCREENS.find((screen) => screen.name === 'calendario');
  assert.ok(calendario, 'the calendario screen exists');
  assert.ok(!calendario.expect.includes('Mostra settimana'), 'the static button is not an expect');
  assert.ok(calendario.expect.includes('18:00–18:30'), 'a painted Rome time range is expected');
  assert.ok(calendario.expect.includes('cal-event'), 'a painted event marker is expected');
});

test('connettori expects are dynamic-only: static chrome alone must fail them', () => {
  // Same rule as calendario above: the empty connectors screen still
  // serves the shell chrome, so expects built from those substrings pass
  // on an unpainted grid.
  // Every connettori expect must be a string only the painted rows contain.
  const screen = SCREENS.find((entry) => entry.name === 'connettori');
  assert.ok(screen, 'the connettori screen exists');
  assert.ok(screen.expect.includes('Canali'), 'the painted Canali card is expected');
  assert.ok(screen.expect.includes('Da collegare'), 'a painted status pill is expected');
  assert.ok(screen.expect.includes('Tocca la riga per il dettaglio'), 'the painted card lede is expected');
  const shell = readFileSync(join(publicDir, 'admin-shell.js'), 'utf8');
  for (const expected of screen.expect) {
    assert.ok(!shell.includes(expected), `the static shell chrome must not contain ${JSON.stringify(expected)}`);
  }
});

test('every harness probe carries the fields the review gate asserts', () => {
  // Regression for review P2 (scripts/bo-shots.js:1026): renderScreen must
  // parse #probe and assert the same invariants the *-shots tests assert,
  // so each fixture has to record them. Static string checks only.
  const probes = new Map([
    ['login', ['magic:', 'email:', 'google:', 'story:', 'noValidate:']],
    ['import', ['back:', 'title:', 'crumb:', 'drop:', 'rows:']],
    ['calendario', ['days:', 'events:', 'lede:', 'filled:']],
    ['sequenze', ['rows:', 'names:', 'detail:', 'steps:']],
    ['agenti', ['agents:', 'dafare:', 'catalog:', 'disabled:', 'talk:']],
    ['catalogo', ['table:', 'stripe:', 'rules:']],
    ['spazi-accessi', ['spaces:', 'members:', 'switches:', 'master:', 'masterAbove', 'stats:', 'apri:']],
    ['connettori', ['rows:', 'badges:', 'openers:', 'flows:']],
  ]);
  for (const [name, fields] of probes) {
    const page = harnessHtml(name, publicDir);
    for (const field of fields) {
      assert.ok(page.includes(field), `${name}: the probe records ${field}`);
    }
  }
});

test('harness probes read the painted mounts, never the whole page', () => {
  // Regression for the Codex P2 on #366: document.body.textContent includes
  // the harness's own inline module script (fixture JSON plus the match
  // patterns), so body-wide counts reject healthy renders (oggi counted 7
  // tasks instead of 2 on CI). Every probe must scope to #view-module.
  for (const screen of SCREENS) {
    if (!screen.module) continue;
    const page = harnessHtml(screen.name, publicDir);
    assert.ok(
      !page.includes('document.body'),
      `${screen.name}: the probe reads #view-module, not the whole page`,
    );
  }
});

test('readProbe parses the hidden probe div from a dump-dom stdout', () => {
  const html = '<html><body><div id="probe" hidden="">{&quot;days&quot;:7,&quot;events&quot;:[&quot;taglio&quot;]}</div></body></html>';
  assert.deepEqual(readProbe(html, 'calendario'), { days: 7, events: ['taglio'] });
  const bare = '<html><body><div id="probe">{"rows":2}</div></body></html>';
  assert.deepEqual(readProbe(bare, 'sequenze'), { rows: 2 });
  assert.throws(() => readProbe('<html><body>no probe here</body></html>', 'calendario'), /probe is missing/);
  assert.throws(() => readProbe('<div id="probe" hidden="">nope</div>', 'calendario'), /not valid JSON/);
  assert.throws(() => readProbe('<div id="probe" hidden="">[1,2]</div>', 'calendario'), /not valid JSON/);
});

test('assertProbe accepts the filled demo probes and rejects unknown screens', () => {
  assert.doesNotThrow(() => assertProbe('login', {
    magic: true, email: 1, google: 1, story: 1, noValidate: true,
  }));
  assert.throws(() => assertProbe('login', {}), /magic-link form/);
  assert.throws(() => assertProbe('login', {
    magic: true, email: 1, google: 1, story: 1, noValidate: false,
  }), /did not install/);
  assert.doesNotThrow(() => assertProbe('oggi', { recap: true, tasks: 2 }));
  assert.doesNotThrow(() => assertProbe('clienti', {
    rows: 3,
    pills: ['Tutti 3', 'Da ricontattare oggi 1', 'Nuovi lead 1', 'Clienti attivi 1', 'Rinnovi entro 30 giorni'],
  }));
  assert.throws(() => assertProbe('clienti', { rows: 3, pills: ['Tutti'] }), /pills/);
  assert.throws(() => assertProbe('clienti', { rows: 3 }), /pills/);
  assert.doesNotThrow(() => assertProbe('cliente', { name: true }));
  assert.doesNotThrow(() => assertProbe('pipeline', { deals: 5 }));
  assert.doesNotThrow(() => assertProbe('calendario', {
    days: 5, events: ['taglio', 'barba'], lede: 'La settimana del team · 19 – 23 ott 2026', filled: 'marco|2026-10-22|09:00',
    proposals: 2, ghosts: 1, outside: 1,
  }));
  assert.doesNotThrow(() => assertProbe('sequenze', {
    rows: 2, names: ['Bentornato in palestra', 'Promemoria appuntamento'],
    detail: 'Bentornato in palestra', steps: 2, firstDay: 'Subito',
    firstChannel: 'WhatsApp · Ciao, ci manchi', confirm: 'Avviare questa sequenza?',
  }));
  assert.doesNotThrow(() => assertProbe('reporting', { kpis: 3 }));
  assert.doesNotThrow(() => assertProbe('personalizzazione', { hero: true, sections: 2, connected: 2, toConnect: 7 }));
  assert.throws(() => assertProbe('personalizzazione', { hero: true, sections: 2, connected: 0, toConnect: 9 }), /connected/);
  assert.doesNotThrow(() => assertProbe('catalogo', {
    table: '…Pacchetto 10 lezioni…', stripe: 'Collegato a Stripe', rules: 'auto 10%',
  }));
  const channels = CONNECTOR_CATALOG.length;
  assert.doesNotThrow(() => assertProbe('connettori', {
    rows: channels, badges: channels, openers: channels, flows: channels, unavailable: 0,
  }));
  // A channel with no adapter pills «Non disponibile qui» and offers no Collega.
  assert.doesNotThrow(() => assertProbe('connettori', {
    rows: channels, badges: channels, openers: channels, flows: channels - 1, unavailable: 1,
  }));
  assert.throws(() => assertProbe('connettori', {
    rows: channels, badges: channels, openers: channels, flows: channels - 1, unavailable: 0,
  }), /Collega buttons/);
  assert.doesNotThrow(() => assertProbe('stato-sync', { ok: true }));
  assert.doesNotThrow(() => assertProbe('spazi-accessi', {
    spaces: 3,
    here: 'Stai lavorando qui',
    members: 2,
    avatars: 2,
    pills: 2,
    switches: 6,
    master: 1,
    masterAbove: true,
    stats: ['2 canali · 2 persone · 3 clienti'],
    apri: 1,
  }));
  assert.throws(() => assertProbe('spazi-accessi', {
    spaces: 3,
    here: 'Stai lavorando qui',
    members: 2,
    avatars: 2,
    pills: 2,
    switches: 6,
    master: 1,
    masterAbove: true,
    stats: [],
    apri: 1,
  }), /stats/);
  assert.throws(() => assertProbe('spazi-accessi', {
    spaces: 3,
    here: 'Stai lavorando qui',
    members: 2,
    avatars: 2,
    pills: 2,
    switches: 6,
    master: 1,
    masterAbove: true,
    stats: ['2 canali · 2 persone · 3 clienti'],
    apri: 0,
  }), /Apri/);
  // backlog:2c3156a4: five switches without the master, or a master not
  // above the five, never pass.
  const spazi = {
    spaces: 3, here: 'Stai lavorando qui', members: 2, avatars: 2, pills: 2,
    switches: 6, master: 1, masterAbove: true,
    stats: ['2 canali · 2 persone · 3 clienti'], apri: 1,
  };
  // backlog:9d06eb1e174b: a statistic on the card of a space that is not
  // open means its connectors were read — never.
  assert.throws(() => assertProbe('spazi-accessi', { ...spazi, stats: [...spazi.stats, ...spazi.stats] }), /expected one/);
  assert.throws(() => assertProbe('spazi-accessi', { ...spazi, switches: 5 }), /expected 6/);
  assert.throws(() => assertProbe('spazi-accessi', { ...spazi, master: 0 }), /master AI switches/);
  assert.throws(() => assertProbe('spazi-accessi', { ...spazi, masterAbove: false }), /not above the five/);
  assert.doesNotThrow(() => assertProbe('componenti', { sections: 4, controls: 12 }));
  assert.throws(() => assertProbe('nope', {}), /no probe assertion/);
  assert.throws(() => assertProbe('oggi', null), /not a JSON object/);
});

test('assertProbe fails an empty render the substring expects would pass', () => {
  // The empty week still serves the static chrome: the 'Mostra settimana'
  // button, the manual-form placeholder holding 'taglio', and the ready
  // title. Substring checks pass on it; the probe gate must not.
  const emptyWeek = [
    '<title>calendario-ready</title>',
    '<button>Mostra settimana</button>',
    '<input name="phrase" placeholder="«giovedì alle 18 con Marco per il taglio»">',
    '<div id="probe" hidden="">{&quot;days&quot;:0,&quot;events&quot;:[],&quot;lede&quot;:null,&quot;filled&quot;:&quot;||&quot;}</div>',
  ].join('');
  assert.ok(emptyWeek.includes('Mostra settimana') && emptyWeek.includes('taglio'));
  assert.throws(() => assertProbe('calendario', readProbe(emptyWeek, 'calendario')), /day columns/);
  assert.throws(() => assertProbe('sequenze', { rows: 0, names: [], detail: null, steps: 0 }), /rows/);
  assert.throws(() => assertProbe('pipeline', { deals: 1 }), /deals/);
  assert.throws(
    () => assertProbe('catalogo', { table: 'Pacchetto 10 lezioni', stripe: null, rules: null }),
    /Stripe state/,
  );
  assert.throws(() => assertProbe('spazi-accessi', { spaces: 3, members: 0, switches: 6, master: 1, masterAbove: true }), /members/);
  assert.throws(() => assertProbe('connettori', { rows: 0, badges: 0, openers: 0, flows: 0 }), /channel rows/);
  assert.throws(() => assertProbe('import', { back: 0, title: false, crumb: false, drop: 0, rows: 0 }), /back links/);
});

test('without a runnable Chromium the command fails loudly, never skips silently', () => {
  // A non-executable file stands in for a missing or unrunnable Chromium:
  // findChromium returns it (it exists), both probes reject it, and the
  // command must exit non-zero and say why: missing PNGs must never look
  // like a pass (backlog:cd0ad69b).
  const dir = mkdtempSync(join(tmpdir(), 'bo-shots-nochromium-'));
  const inert = join(dir, 'not-a-browser');
  writeFileSync(inert, 'this file is not a browser\n');
  const out = join(dir, 'out');
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: root,
    env: { ...process.env, CHROMIUM_BIN: inert, HOME: mkdtempSync(join(tmpdir(), 'bo-shots-nohome-')) },
  });
  assert.notEqual(run.status, 0, `no runnable Chromium is a failure, never a silent skip (stdout: ${(run.stdout ?? '').slice(-300)})`);
  assert.ok(String(run.stderr ?? '').includes('no runnable Chromium'), 'the failure says why');
  assert.ok(!existsSync(out) || readdirSync(out).filter((name) => name.endsWith('.png')).length === 0, 'no PNGs on a failure');
});

test('a Chromium that only runs with --no-sandbox is used, not skipped (backlog:cd0ad69b)', () => {
  // Repro for the Ubuntu server: Chromium dies with "No usable sandbox"
  // without the flag but paints fine with it. The old plain probe called
  // that "no runnable Chromium" and the command exited 0 with a skip; the
  // flags probe must retry with --no-sandbox and the command must get past
  // the gate instead of reporting "no runnable Chromium".
  const dir = mkdtempSync(join(tmpdir(), 'bo-shots-sandbox-'));
  const fake = join(dir, 'fake-chromium');
  writeFileSync(fake, [
    '#!/bin/sh',
    '# Fake Chromium with the sandbox-less-server shape: without --no-sandbox',
    '# every launch dies like the Ubuntu zygote failure; with the flag the',
    '# --dump-dom probe returns a page.',
    'sandbox=0',
    'dumpdom=0',
    'for arg in "$@"; do',
    '  case "$arg" in --no-sandbox) sandbox=1;; --dump-dom) dumpdom=1;; esac',
    'done',
    'if [ "$sandbox" = "0" ]; then',
    "  echo '[FATAL:zygote_host_impl_linux.cc] No usable sandbox!' >&2",
    '  exit 1',
    'fi',
    'if [ "$dumpdom" = "1" ]; then',
    "  printf '<html><head></head><body></body></html>\\n'",
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  assert.equal(chromiumRuns(fake), false, 'the plain probe still rejects the sandbox death (that was the old skip)');
  assert.deepEqual(chromiumFlags(fake), ['--no-sandbox'], 'the flags probe retries without the sandbox');
  assert.deepEqual(chromiumFlags(null), null, 'a missing binary has no flags');
  assert.deepEqual(chromiumFlags(join(dir, 'does-not-exist')), null, 'a missing path has no flags');
  // The command itself must get past the runnable gate with this binary: it
  // cannot paint PNGs (the fake writes none), but it must fail at the render
  // stage, never with "no runnable Chromium".
  const out = join(dir, 'out');
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out, '--screen', 'login'], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: root,
    env: { ...process.env, CHROMIUM_BIN: fake, HOME: mkdtempSync(join(tmpdir(), 'bo-shots-fakehome-')) },
  });
  assert.notEqual(run.status, 0, 'the fake cannot paint, so the run still fails');
  assert.ok(!String(run.stderr ?? '').includes('no runnable Chromium'), 'but it tried with --no-sandbox instead of gating out');
});

const CHROMIUM = findChromium();
const SHOTS_SKIP = chromiumFlags(CHROMIUM) !== null
  ? false
  : 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN); the Mac CI runner produces the PNGs';

test('bo:shots renders one filled PNG per screen at 1440px and 390px', { skip: SHOTS_SKIP }, () => {
  const out = mkdtempSync(join(tmpdir(), 'bo-shots-full-'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out], {
    encoding: 'utf8',
    timeout: 1_500_000,
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `the full run exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
  const pngs = readdirSync(out).filter((name) => name.endsWith('.png')).sort();
  assert.equal(pngs.length, EXPECTED_SCREENS.length * 2, `one PNG per screen per width (${pngs.length} files)`);
  for (const name of EXPECTED_SCREENS) {
    for (const [width, height, floor] of [[1440, 1800, 20000], [390, 1600, 10000]]) {
      const shot = readPngSize(join(out, `${name}-${width}x${height}.png`));
      assert.equal(shot.width, width, `${name} renders at ${width}px`);
      assert.equal(shot.height, height, `${name} renders at ${height}px`);
      assert.ok(shot.bytes >= floor, `${name} at ${width}px paints real pixels (${shot.bytes} bytes)`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.shots.length, EXPECTED_SCREENS.length * 2, 'the manifest lists every PNG');
});

test('bo:shots --screen renders only that screen', { skip: SHOTS_SKIP }, () => {
  const out = mkdtempSync(join(tmpdir(), 'bo-shots-one-'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out, '--screen', 'login'], {
    encoding: 'utf8',
    timeout: 600_000,
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `a single screen exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
  const pngs = readdirSync(out).filter((name) => name.endsWith('.png')).sort();
  assert.deepEqual(pngs, ['login-1440x1800.png', 'login-390x1600.png']);
  assert.ok(USAGE.includes('bo:shots'), 'the usage names the command');
});

test('bo:shots profiles the production composition: appointments, interactions, accordo-sales', () => {
  // backlog:1ef6dd76 (OWNER_ANSWER): the production pilot publishes
  // appointments and interactions beside the five reference domains and opts
  // into accordo-sales per space. The photographed pages fake the same
  // surfaces: DECISION (to be confirmed): the default
  // `packages/domains/generated/index.js` is deliberately UNCHANGED — adding
  // the two packages there alone stops the default application at startup
  // (`action "interaction-message.advance": target module
  // "interaction-message" is not a generated module`), because their seven
  // record modules are not staged in `packages/modules/generated/index.js`.
  // Staging them changes the reference composition for every consumer and
  // needs the module factory plus migrations: follow-up, not this shot.
  const oggi = harnessHtml('oggi', publicDir);
  for (const name of ['work', 'appointments', 'channels', 'interactions']) {
    assert.ok(oggi.includes(`${name}: {}`) || oggi.includes(`${name}:{}`), `the oggi profile publishes ${name} like production`);
  }
  const source = readFileSync(join(root, 'packages', 'pipelines', 'generated', 'index.js'), 'utf8');
  assert.ok(/generatedPipelines = \[\]/.test(source), 'accordo-sales stays opt-in per space, never a local default');
});

test('bo:shots photographs the production pipeline, not a demo invention', () => {
  // The pipeline harness embeds the code-first accordo-sales definition the
  // pilot opts into, and the demo deals ride its real stage keys.
  const page = harnessHtml('pipeline', publicDir);
  assert.ok(page.includes('"name":"accordo-sales"'), 'the photographed pipeline is accordo-sales');
  assert.ok(page.includes('richiesta-info'), 'the photographed stages are the production keys');
  assert.ok(page.includes("'Proposta'") || page.includes('Proposta'), 'the photographed board names a production stage');
  const pipeline = SCREENS.find((screen) => screen.name === 'pipeline');
  assert.ok(pipeline.expect.includes('Proposta'), 'the render gate watches a production stage label');
});

// backlog:d30d17880f63: the Linux CI runner's Playwright layout
// (chrome-headless-shell-linux64) — missed before, so every browser proof
// on that runner skipped as «no runnable Chromium».
test('findChromium finds the Linux Playwright headless shell, as on the CI runner', () => {
  const home = mkdtempSync(join(tmpdir(), 'bo-shots-home-'));
  const dir = join(home, '.cache', 'ms-playwright', 'chromium_headless_shell-1248', 'chrome-headless-shell-linux64');
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, 'chrome-headless-shell');
  writeFileSync(binary, '');
  assert.equal(findChromium({ env: {}, home, system: [] }), binary);
  assert.equal(findChromium({ env: { CHROMIUM_BIN: binary }, home: join(home, 'none'), system: [] }), binary, 'CHROMIUM_BIN still wins');
  assert.equal(findChromium({ env: {}, home: join(home, 'none'), system: [] }), null);
});
