// @ts-check
/**
 * Backoffice BO-F6-05 — `npm run bo:shots` (backlog:5acdfd87bbd0).
 *
 * What it must prove:
 * - one PNG per screen at 1440px and at 390px, none empty (the full run
 *   counts the files and checks every width and byte floor);
 * - the run works fully offline (loopback only) and exits 0 with a skip
 *   message where no runnable Chromium exists;
 * - the screen registry is exactly the twelve delivered /bo screens plus the
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
  USAGE,
  chromiumRuns,
  findChromium,
  harnessHtml,
  parseArgs,
  readPngSize,
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
  'componenti',
];

test('the screen registry is the twelve delivered screens plus the componenti catalog', () => {
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
