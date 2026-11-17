// @ts-check
/**
 * backlog:a1f2db873cf3 — the assistant panel never covers the ⌘K bar.
 * Production 07/11 (Mac session): the open panel is a full-height fixed
 * right rail (top 0, z-index above the sticky topbar), so it hides the ⌘K
 * input that sits at the top-right of the bar. The real shell (sidebar +
 * topbar with the ⌘K bar) and the real panel render inside a real Chromium,
 * once at a desktop viewport and once on a phone viewport: with the panel
 * open, the panel's top edge must sit at or below the bar's bottom edge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_WRITE_GATE_BROWSER_PRELUDE, enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
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

function chromiumFlags(binary) {
  if (!binary) return null;
  const probe = (extra) => {
    try {
      const out = spawnSync(binary, ['--headless', '--disable-gpu', '--dump-dom', ...extra, 'about:blank'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      return out.status === 0 && String(out.stdout ?? '').includes('<html');
    } catch {
      return false;
    }
  };
  if (probe([])) return [];
  if (probe(['--no-sandbox'])) return ['--no-sandbox'];
  return null;
}

const CHROMIUM = findChromium();
const CHROMIUM_FLAGS = chromiumFlags(CHROMIUM);
const ROOM_SKIP = CHROMIUM_FLAGS === null ? 'Chromium binary missing or unrunnable here (set CHROMIUM_BIN)' : false;

const PUBLIC_DIR = fileURLToPath(new URL('../apps/admin/public/', import.meta.url));

const FIXTURE_SCRIPT = `
${ADMIN_WRITE_GATE_BROWSER_PRELUDE}
import { buildShellNav as buildHarnessShellNav, createShellView } from './admin-shell.js';
import { createAssistantPanel } from './admin-assistant.js';
const shellView = createShellView({
  doc: document,
  sidebar: document.getElementById('boSidebar'),
  topbar: document.getElementById('boTopbar'),
  spaces: [{ id: 'locale', name: 'Studio Aurora', initials: 'SA' }],
  user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
  screenId: 'oggi',
  screenLabel: 'Oggi',
  navigate: () => {},
  notify: () => {},
  onLogout: () => {},
  onPickSpace: () => {},
  win: null,
});
shellView.update({
  items: buildHarnessShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customerDataAvailable: true,
    sequencesAvailable: true,
  }),
  activeScreenId: 'oggi',
  aiScreenId: null,
  screenLabel: 'Oggi',
  clientCount: 3,
  clientCountExact: true,
  fixCount: 2,
});
const panelClient = {
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    throw new Error('no such module (' + path + ')');
  },
};
const panel = createAssistantPanel({ doc: document, mount: document.getElementById('boAssistant'), client: panelClient, navigate: () => {}, notify: () => {} });
await panel.open('oggi');
const bar = document.querySelector('.bo-topbar');
const panelEl = document.querySelector('#boAssistant .bo-assistant');
const round = (rect) => ({ top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) });
const probe = bar && panelEl
  ? { bar: round(bar.getBoundingClientRect()), panel: round(panelEl.getBoundingClientRect()) }
  : { bar: null, panel: null };
document.getElementById('probe').textContent = JSON.stringify(probe);
document.title = 'panel-room-ready';
`;

function harnessHtml() {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><main class="bo-shell">`
    + `<aside class="bo-sidebar" id="boSidebar" aria-label="Navigazione backoffice"></aside>`
    + `<div class="bo-main"><div class="bo-topbar" id="boTopbar"></div>`
    + `<section id="view-module" aria-live="polite"><h1>Oggi</h1></section></div></main>`
    + `<aside class="bo-assistant-slot" id="boAssistant" aria-label="Assistente AI"></aside>`
    + `<div id="probe" hidden></div>`
    + `<script type="module">${FIXTURE_SCRIPT}</script></body></html>`;
}

function runChromium(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROMIUM, [...CHROMIUM_FLAGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function measureRoom({ width, height }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://room.test');
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(harnessHtml());
      return;
    }
    const file = join(PUBLIC_DIR, url.pathname.slice(1));
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
  assert.ok(address && typeof address === 'object', 'the room server listens');
  const page = `http://127.0.0.1:${address.port}/harness.html`;
  const served = await fetch(page).then((response) => response.text());
  assert.ok(served.includes('admin-assistant.js'), 'the harness serves the real panel module');
  const out = join(tmpdir(), `assistente-room-${width}x${height}.png`);
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
    const dom = await runChromium([
      '--headless', '--dump-dom',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      page,
    ], 120000);
    assert.equal(dom.status, 0, 'the probe run exits 0');
    assert.ok(dom.stdout.includes('<title>panel-room-ready</title>'), 'the harness module ran to completion in the page');
    const probeHtml = dom.stdout.match(/<div id="probe"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
    const probe = JSON.parse(probeHtml.replace(/&quot;/g, '"'));
    const bytes = readFileSync(out);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the shot is a PNG');
    return { probe, png: out, bytes: bytes.length };
  } finally {
    server.close();
  }
}

function assertRoom(probe) {
  assert.ok(probe.bar && probe.panel, 'the bar and the open panel both paint');
  assert.ok(
    probe.bar.width > 0 && probe.panel.width > 0 && probe.panel.height > 0,
    'both are visible, the panel with a real size',
  );
  assert.ok(
    Math.abs(probe.panel.top - probe.bar.bottom) <= 1,
    `the open panel starts right below the topbar (bar bottom ${probe.bar.bottom}, panel top ${probe.panel.top})`,
  );
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the open assistant panel never covers the cmdk bar at ${viewport.width}px`, { skip: ROOM_SKIP }, async () => {
    const { probe, png, bytes } = await measureRoom(viewport);
    assertRoom(probe);
    console.log(`panel room ${viewport.width}px: bar.bottom=${probe.bar.bottom} panel.top=${probe.panel.top} PNG ${png} (${bytes} bytes)`);
  });
}
