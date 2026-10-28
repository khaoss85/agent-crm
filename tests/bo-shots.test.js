// @ts-check
/**
 * Backoffice BO-F6-05 — `npm run bo:shots` (backlog:5acdfd87bbd0).
 *
 * What it must prove:
 * - one PNG per screen at 1440px and at 390px, none empty (the full run
 *   counts the files and checks every width and byte floor);
 * - the run works fully offline (loopback only) and exits 0 with a skip
 *   message where no runnable Chromium exists;
 * - the screen registry is exactly the thirteen delivered /bo screens plus the
 *   componenti catalog, and
 *   every harness page serves its real view module.
 *
 * The full render runs only where Chromium actually runs (the probe below
 * is the same one the `*-shots` tests use): elsewhere those tests skip and
 * the skip-path test below still proves the clean exit.
 */

import test from 'node:test';
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
  USAGE,
  assertProbe,
  chromiumRuns,
  findChromium,
  harnessHtml,
  parseArgs,
  readPngSize,
  readProbe,
} from '../scripts/bo-shots.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const publicDir = join(root, 'apps', 'admin', 'public');

const EXPECTED_SCREENS = [
  'login',
  'oggi',
  'clienti',
  'cliente',
  'pipeline',
  'calendario',
  'sequenze',
  'reporting',
  'personalizzazione',
  'catalogo',
  'stato-sync',
  'spazi-accessi',
  'connettori',
  'componenti',
];

test('the screen registry is the thirteen delivered screens plus the componenti catalog', () => {
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

test('every screen photographs with its shell identity from the /bo router', () => {
  // Mirrors apps/admin/public/app.js `shellScreenFor`: the same sidebar
  // voice is highlighted and the same path is crumbed as in the app.
  assert.deepEqual(SHELL_SCREENS, {
    oggi: { id: 'oggi', label: 'Oggi' },
    clienti: { id: 'clienti', label: 'Clienti' },
    cliente: { id: 'clienti', label: 'Clienti' },
    pipeline: { id: 'pipeline', label: 'Pipeline' },
    calendario: { id: 'calendario', label: 'Calendario' },
    sequenze: { id: 'sequenze', label: 'Sequenze' },
    reporting: { id: 'reporting', label: 'Reporting' },
    personalizzazione: { id: 'impostazioni', label: 'Personalizzazione' },
    catalogo: { id: '', label: 'Catalogo prodotti' },
    'stato-sync': { id: 'impostazioni', label: 'Stato sync', ai: 'stato-sync' },
    'spazi-accessi': { id: 'impostazioni', label: 'Spazi e accessi' },
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
  // serves the shell chrome and the space picker, so expects built from
  // those substrings pass on an unpainted grid.
  // Every connettori expect must be a string only the painted rows contain.
  const screen = SCREENS.find((entry) => entry.name === 'connettori');
  assert.ok(screen, 'the connettori screen exists');
  assert.ok(screen.expect.includes('Collega in 3 passi'), 'a painted guided-flow button is expected');
  assert.ok(screen.expect.includes('Cosa succede quando colleghi:'), 'a painted connect preview is expected');
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
    ['calendario', ['days:', 'events:', 'lede:', 'filled:']],
    ['sequenze', ['rows:', 'names:', 'detail:', 'steps:']],
    ['catalogo', ['table:', 'stripe:', 'rules:']],
    ['spazi-accessi', ['spaces:', 'members:', 'switches:']],
    ['connettori', ['rows:', 'previews:', 'flows:']],
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
  assert.doesNotThrow(() => assertProbe('login', {}));
  assert.doesNotThrow(() => assertProbe('oggi', { recap: true, tasks: 2 }));
  assert.doesNotThrow(() => assertProbe('clienti', { rows: 3 }));
  assert.doesNotThrow(() => assertProbe('cliente', { name: true }));
  assert.doesNotThrow(() => assertProbe('pipeline', { deals: 5 }));
  assert.doesNotThrow(() => assertProbe('calendario', {
    days: 5, events: ['taglio', 'barba'], lede: 'La settimana del team · 19 – 23 ott 2026', filled: 'marco|2026-10-22|09:00',
    proposals: 2, ghosts: 2,
  }));
  assert.doesNotThrow(() => assertProbe('sequenze', {
    rows: 2, names: ['Bentornato in palestra', 'Promemoria appuntamento'],
    detail: 'Bentornato in palestra', steps: 2, firstDay: 'Giorno 0 · parte subito',
    firstChannel: 'WhatsApp', confirm: 'Attivare questa sequenza?',
  }));
  assert.doesNotThrow(() => assertProbe('reporting', { kpis: 3 }));
  assert.doesNotThrow(() => assertProbe('personalizzazione', { hero: true, sections: 2, connected: 2, toConnect: 7 }));
  assert.throws(() => assertProbe('personalizzazione', { hero: true, sections: 2, connected: 0, toConnect: 9 }), /connected/);
  assert.doesNotThrow(() => assertProbe('catalogo', {
    table: '…Pacchetto 10 lezioni…', stripe: 'Collegato a Stripe', rules: 'auto 10%',
  }));
  assert.doesNotThrow(() => assertProbe('connettori', { rows: 8, previews: 8, flows: 8 }));
  assert.doesNotThrow(() => assertProbe('stato-sync', { ok: true }));
  assert.doesNotThrow(() => assertProbe('spazi-accessi', {
    spaces: 2, here: 'Stai lavorando qui', members: 2, avatars: 2, pills: 2, switches: 5,
  }));
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
  assert.throws(() => assertProbe('spazi-accessi', { spaces: 2, members: 0, switches: 5 }), /members/);
  assert.throws(() => assertProbe('connettori', { rows: 0, previews: 0, flows: 0 }), /channel rows/);
});

test('without a runnable Chromium the command skips cleanly with exit 0', () => {
  // A non-executable file stands in for a missing or unrunnable Chromium:
  // findChromium returns it (it exists), the runnable probe rejects it, and
  // the command must exit 0 with a skip message instead of failing the gate.
  const dir = mkdtempSync(join(tmpdir(), 'bo-shots-skip-'));
  const inert = join(dir, 'not-a-browser');
  writeFileSync(inert, 'this file is not a browser\n');
  const out = join(dir, 'out');
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'bo-shots.js'), '--out', out], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: root,
    env: { ...process.env, CHROMIUM_BIN: inert, HOME: mkdtempSync(join(tmpdir(), 'bo-shots-nohome-')) },
  });
  assert.equal(run.status, 0, `a missing Chromium is a skip, not a failure (stderr: ${(run.stderr ?? '').slice(-300)})`);
  assert.ok(String(run.stdout ?? '').includes('Skipping bo:shots'), 'the skip says why');
  assert.ok(!existsSync(out) || readdirSync(out).filter((name) => name.endsWith('.png')).length === 0, 'no PNGs on a skip');
});

const CHROMIUM = findChromium();
const SHOTS_SKIP = chromiumRuns(CHROMIUM)
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
