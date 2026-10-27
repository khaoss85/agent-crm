// @ts-check
/**
 * Browser proof for BO-F6-03 (backlog:5feaea014dca): with a real session the
 * shell shows the session's space, role, name and email, and Oggi greets
 * with the same name — never the development identity. The harness serves
 * the real `admin-shell.js`, `admin-session.js`, `admin-oggi.js` and
 * `styles.css` in a real Chromium, once at a desktop viewport (1440 px) and
 * once on a phone (390 px). Each run writes a PNG of the screen and asserts,
 * from inside the page, the session strings and the absence of the
 * development strings. The session profile bytes are embedded exactly as the
 * mount injects them (`injectSessionProfile`), so the read path is the
 * production one. Demo names only, like the other shell tests: no customer
 * names anywhere near this public repo.
 *
 * Where no Chromium exists the test skips with its reason instead of faking
 * a pass (same rule as the other *-shots tests) — except on CI, where the
 * proof is required: without a usable Chromium the browser tests fail
 * instead of skipping, so the visual claim can never pass unproven where
 * the merge gate runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function readDirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const bases = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const base of bases) {
    for (const entry of readDirSafe(base)) {
      for (const suffix of [
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        ['chrome-linux', 'headless_shell'],
      ]) {
        const path = join(base, entry, ...suffix);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

/**
 * A binary that exists but cannot launch here (the seat sandbox denies
 * Chromium's Mach bootstrap — the sibling *-shots tests fail the same way,
 * proven with admin-spazi-accessi-shots as control) is the same as a
 * missing binary: skip with the reason instead of failing on the
 * environment. The CI Mac runner launches it and runs the proof there.
 */
function usableChromium() {
  const binary = findChromium();
  if (!binary) return null;
  try {
    const probe = spawnSync(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'about:blank'], {
      timeout: 20000, encoding: 'utf8',
    });
    if (probe.error || probe.status !== 0 || !String(probe.stdout ?? '').includes('<html')) return null;
    return binary;
  } catch {
    return null;
  }
}

const CHROMIUM = usableChromium();

// Skip only where the proof cannot run AND nobody gates on it: on CI
// (GitHub Actions sets CI=true) a missing Chromium fails the browser tests
// below instead of skipping them. The gate then sees red, never a silent
// pass — the class the P2 on #360 named.
const SKIP_BROWSER = CHROMIUM
  ? false
  : (process.env.CI ? false : 'no usable Chromium here (set CHROMIUM_BIN)');

// The session profile, serialized exactly as the mount injects it: JSON with
// `<` escaped, so the bytes the shell reads here are the production bytes.
const SESSION_PROFILE = {
  space: { id: 'aurora', name: 'Studio Aurora' },
  role: 'owner',
  name: 'Elena Rinaldi',
  email: 'elena@studioaurora.it',
  logoutUrl: '/w/aurora/auth/logout',
};
const SESSION_JSON = JSON.stringify(SESSION_PROFILE).replace(/</g, '\\u003c');

// NOTE: FIXTURE_SCRIPT is a template literal, so every backslash inside it
// is processed twice — once here, once in the page. A join on newline must
// read '\\n' here (runtime '\n'): a single backslash puts a raw newline
// inside a quoted string of the in-page module and it never executes.
const FIXTURE_SCRIPT = `
import { createShellView } from './admin-shell.js';
import { readSessionProfile } from './admin-session.js';
import { createOggiView } from './admin-oggi.js';
// Any throw still finishes the harness with its cause in the probe, so a CI
// failure names the in-page error instead of only "module did not finish".
const finishHarness = (probe) => {
  document.getElementById('probe').textContent = JSON.stringify(probe);
  document.title = 'shell-identity-ready';
};
try {
const profile = readSessionProfile(document);
const view = createShellView({
  doc: document,
  sidebar: document.getElementById('boSidebar'),
  topbar: document.getElementById('boTopbar'),
  spaces: profile ? [profile.space] : [],
  user: profile ? { name: profile.name, email: profile.email, role: profile.role } : {},
  navigate: () => {},
  notify: () => {},
  onLogout: () => {},
});
const oggi = createOggiView({
  doc: document,
  mount: document.getElementById('view-module'),
  client: { request: async () => { throw new Error('no-backend-in-shot'); } },
  navigate: () => {},
});
await oggi.render({
  spaceName: profile ? profile.space.name : '',
  userName: profile ? profile.name : '',
  links: [],
  now: new Date(2026, 9, 19, 9),
});
// Rendered text only: document.body.textContent would also include this
// very module script (which names the development strings it probes for),
// so read the three mounts the shell paints into instead.
const renderedText = ['boSidebar', 'boTopbar', 'view-module']
  .map((id) => document.getElementById(id))
  .map((mount) => (mount && typeof mount.textContent === 'string' ? mount.textContent : ''))
  .join('\\n');
const probe = {
  profileRead: profile !== null,
  showsSpace: renderedText.includes('Studio Aurora'),
  showsRole: renderedText.includes('Titolare'),
  showsName: renderedText.includes('Elena Rinaldi'),
  showsEmail: renderedText.includes('elena@studioaurora.it'),
  noDevSpace: !renderedText.includes('Spazio locale'),
  noDevUser: !renderedText.includes('Operatore locale'),
  noDevEmail: !renderedText.includes('sviluppo locale'),
  crumb: document.querySelector('.bo-crumb') ? document.querySelector('.bo-crumb').textContent : null,
  greeting: document.querySelector('#view-module h1, #view-module h2') ? document.querySelector('#view-module h1, #view-module h2').textContent : null,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
};
finishHarness(probe);
} catch (error) {
  finishHarness({ moduleError: error instanceof Error ? error.name + ': ' + error.message : String(error) });
}
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css">`
    + `<script id="bo-session" type="application/json">${SESSION_JSON}</script>`
    + `</head>`
    + `<body><main class="shell bo-shell">`
    + `<aside class="bo-sidebar" id="boSidebar" aria-label="Navigazione backoffice"></aside>`
    + `<div class="bo-main"><div class="bo-topbar" id="boTopbar"></div>`
    + `<section id="view-module" aria-live="polite"></section>`
    + `</div></main><div id="probe"></div>`
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
}

/** @param {string} file */
function pngSize(file) {
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 8, 'the shot is not empty');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the shot is a PNG');
  return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function runChromium(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROMIUM, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`chromium timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runBrowser({ width, height }) {
  const dir = new URL('../apps/admin/public/', import.meta.url);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml());
      return;
    }
    const file = join(dir.pathname, url.pathname.slice(1));
    if (url.pathname.endsWith('.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(file, 'utf8'));
      return;
    }
    if (url.pathname.endsWith('.css')) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end(readFileSync(file, 'utf8'));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the shot server listens');
  const port = address.port;
  const page = `http://127.0.0.1:${port}/harness.html`;
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-shell.js'), 'the harness serves the real shell module');
  const out = join(mkdirTmp(), `shell-identity-${width}x${height}.png`);
  try {
    const run = await runChromium([
      '--headless',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      '--hide-scrollbars',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(run.status, 0, `chromium exits 0 (stderr: ${(run.stderr ?? '').slice(-500)})`);
    // One probe run per viewport, like the sibling *-shots tests: the
    // module marks itself done on every path (success or its in-page
    // error, via finishHarness), so a missing marker with a dump
    // byte-identical to the unexecuted harness means the module never
    // started — the stderr tail then names the cause.
    const probeRun = await runChromium([
      '--headless', '--dump-dom',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(probeRun.status, 0, `the probe run exits 0 (stderr: ${(probeRun.stderr ?? '').slice(-500)})`);
    const dom = probeRun.stdout;
    const probeReady = dom.includes('<title>shell-identity-ready</title>');
    return { out, dom, probeReady, probeStderr: probeRun.stderr ?? '' };
  } finally {
    server.close();
  }
}

function mkdirTmp() {
  const dir = join(tmpdir(), 'accordo-shell-identity-shots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} html */
function readProbe(html) {
  const probeHtml = html.match(/<div id="probe">(.*?)<\/div>/)?.[1] ?? '';
  return JSON.parse(probeHtml.replace(/&quot;/g, '"'));
}

function assertIdentityProbe(probe) {
  assert.equal(probe.moduleError ?? null, null, `the harness module throws nothing (${probe.moduleError ?? 'ok'})`);
  assert.equal(probe.profileRead, true, 'the shell reads the injected session profile');
  assert.equal(probe.showsSpace, true, 'the session space shows');
  assert.equal(probe.showsRole, true, 'the session role shows as Titolare');
  assert.equal(probe.showsName, true, 'the session name shows');
  assert.equal(probe.showsEmail, true, 'the session email shows');
  assert.equal(probe.noDevSpace, true, 'no "Spazio locale" with a real session');
  assert.equal(probe.noDevUser, true, 'no "Operatore locale" with a real session');
  assert.equal(probe.noDevEmail, true, 'no "sviluppo locale" with a real session');
  assert.match(probe.crumb ?? '', /Studio Aurora \/ Oggi/, 'the crumb names the session space');
  assert.match(probe.greeting ?? '', /Elena Rinaldi/, 'Oggi greets with the session name');
}

test('the harness module parses (top-level await included)', () => {
  // Like the bo-shots guard: the inline module is a template string the
  // syntax check of this file cannot see — extract and node --check it, so
  // a fixture edit can never silently stop executing in the page.
  const dir = mkdtempSync(join(tmpdir(), 'accordo-shell-identity-fixture-'));
  const file = join(dir, 'fixture.mjs');
  writeFileSync(file, FIXTURE_SCRIPT);
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 60000 });
  assert.equal(checked.status, 0, `the harness module parses (${(checked.stderr ?? '').slice(-300)})`);
});

test('the session shell renders in a real browser: desktop 1440 PNG', { skip: SKIP_BROWSER }, async () => {
  assert.ok(CHROMIUM, 'the gate proves the shell in a real browser: no usable Chromium, no pass (set CHROMIUM_BIN)');
  const { out, dom, probeReady, probeStderr } = await runBrowser({ width: 1440, height: 900 });
  assert.ok(probeReady, `the harness module ran to completion in the page (dump ${dom.length} chars, head: ${dom.slice(0, 160)}; stderr: ${(probeStderr ?? '').slice(-500)})`);
  const probe = readProbe(dom);
  assertIdentityProbe(probe);
  const shot = pngSize(out);
  assert.equal(shot.width, 1440, 'the PNG is the desktop viewport');
  assert.ok(shot.bytes > 30000, `the screen paints real pixels (${shot.bytes} bytes)`);
  writeFileSync(join(mkdirTmp(), 'shell-identity-desktop-probe.json'), JSON.stringify({ probe, shot }, null, 2));
  console.log(`shell-identity desktop PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});

test('the session shell renders in a real browser: phone 390 PNG without sideways scroll', { skip: SKIP_BROWSER }, async () => {
  assert.ok(CHROMIUM, 'the gate proves the shell in a real browser: no usable Chromium, no pass (set CHROMIUM_BIN)');
  const { out, dom, probeReady, probeStderr } = await runBrowser({ width: 390, height: 844 });
  assert.ok(probeReady, `the harness module ran to completion in the page (dump ${dom.length} chars, head: ${dom.slice(0, 160)}; stderr: ${(probeStderr ?? '').slice(-500)})`);
  const probe = readProbe(dom);
  assertIdentityProbe(probe);
  assert.ok(probe.scrollWidth <= probe.innerWidth, `nothing paints sideways under 700px (${probe.scrollWidth} > ${probe.innerWidth})`);
  const shot = pngSize(out);
  assert.equal(shot.width, 390, 'the PNG is the phone viewport');
  assert.ok(shot.bytes > 20000, `the screen paints real pixels (${shot.bytes} bytes)`);
  writeFileSync(join(mkdirTmp(), 'shell-identity-phone-probe.json'), JSON.stringify({ probe, shot }, null, 2));
  console.log(`shell-identity phone PNG: ${out} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
});
