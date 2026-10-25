// @ts-check
/**
 * Backoffice BO-F1-03 — Stato sync in a real browser (backlog:63af493dea0a).
 *
 * The headless Chromium shell loads a harness page that renders the real
 * `admin-sync.js` view (desktop 1280px and phone 390px, ok and attention
 * states), captures a PNG per combination and dumps the DOM. The test then
 * proves the content is on screen, the phone width has no page-level sideways
 * scroll, and every PNG is a real render rather than a blank page.
 *
 * The Chromium lookup mirrors scripts/site-shots.js (same candidate paths):
 * where no binary exists the tests skip with the reason instead of failing,
 * because shots are evidence, not a build gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'apps', 'admin', 'public');

/** Same lookup as scripts/site-shots.js `findChromium`. */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    '/opt/pw-browsers/chromium/chrome-linux/headless_shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const bases = [
    '/opt/pw-browsers',
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
        ['chrome-linux', 'headless_shell'],
        ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
      ]) {
        const path = join(base, entry, ...suffix);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

const BINARY = findChromium();
const SKIP = BINARY ? false : 'no Chromium binary found (same lookup as scripts/site-shots.js)';

const inboxOf = (over = {}) => ({
  received: 14, applied: 12, quarantined: 0, ignored: 1, duplicate: 1, pending: 0,
  lastReceivedAt: '2026-10-25T11:30:00.000Z', ...over,
});

const entryOf = (over = {}) => ({
  connectionKey: 'wa-1',
  channel: 'whatsapp',
  account: '+39 333 1234567',
  adapter: 'whatsapp',
  adapterVersion: 1,
  status: 'active',
  importable: true,
  sync: null,
  inbox: inboxOf(),
  outbox: { openDeadLetters: 0, lastFailedAt: null },
  direction: 'both',
  health: 'ok',
  needsFix: 0,
  ...over,
});

const FIXTURES = {
  ok: {
    spaceId: 'prova',
    connections: [
      entryOf(),
      entryOf({ connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio' }),
    ],
    feed: [
      { direction: 'in', connectionKey: 'wa-1', channel: 'whatsapp', at: '2026-10-25T11:30:00.000Z', kind: 'applied' },
      { direction: 'in', connectionKey: 'ig-1', channel: 'instagram', at: '2026-10-25T11:00:00.000Z', kind: 'duplicate' },
    ],
    needsFix: 0,
    lastActivityAt: '2026-10-25T11:30:00.000Z',
  },
  fix: {
    spaceId: 'prova',
    connections: [
      entryOf({ status: 'suspended', health: 'down' }),
      entryOf({
        connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio',
        inbox: inboxOf({ quarantined: 2 }), health: 'attention', needsFix: 2,
      }),
    ],
    feed: [
      { direction: 'in', connectionKey: 'ig-1', channel: 'instagram', at: '2026-10-25T11:30:00.000Z', kind: 'quarantined' },
    ],
    needsFix: 2,
    lastActivityAt: '2026-10-25T11:30:00.000Z',
  },
};

function harnessHtml(state) {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
<title>Stato sync ${state}</title>
</head>
<body>
<div class="shell"><div id="mount"></div></div>
<script type="module">
import { createSyncView } from '/admin-sync.js';
const activity = ${JSON.stringify(FIXTURES[state])};
const client = {
  async request(path, options = {}) {
    if (String(options.method ?? 'GET').toUpperCase() !== 'GET') return { pulled: 1 };
    if (path === '/api/schema') return { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };
    if (path.startsWith('/api/connectors/activity')) return activity;
    throw new Error('unexpected ' + path);
  },
};
const storage = { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} };
const view = createSyncView({ doc: document, mount: document.getElementById('mount'), client, storage, navigate: () => {}, toast: () => {} });
await view.render();
document.documentElement.dataset.syncReady = 'yes';
document.documentElement.dataset.overflow =
  document.documentElement.scrollWidth <= document.documentElement.clientWidth ? 'ok' : 'overflow';
</script>
</body>
</html>`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/__harness.html') {
      const state = url.searchParams.get('state') === 'fix' ? 'fix' : 'ok';
      response.writeHead(200, MIME['.html']);
      response.end(harnessHtml(state));
      return;
    }
    const file = join(PUBLIC, decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) {
      response.writeHead(404);
      response.end('no');
      return;
    }
    response.writeHead(200, MIME[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const execFileAsync = promisify(execFile);

/**
 * Run one headless Chromium call without blocking the fixture server on
 * this loop: the server must keep answering while Chromium loads the
 * harness page, so a synchronous wait would deadlock the render and time
 * the whole gate out. Returns the same { status, stderr } shape as before.
 */
async function runChromium(binary, args, maxBuffer = 1024 * 1024) {
  try {
    const { stderr } = await execFileAsync(binary, args, { encoding: 'utf8', timeout: 120000, maxBuffer });
    return { status: 0, stderr: typeof stderr === 'string' ? stderr : '' };
  } catch (error) {
    const status = typeof error?.code === 'number' ? error.code : 1;
    const stderr = typeof error?.stderr === 'string' && error.stderr !== ''
      ? error.stderr
      : String(error?.message ?? error);
    return { status, stderr };
  }
}

function shot(binary, url, width, png) {
  return runChromium(binary, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${width},900`,
    '--virtual-time-budget=15000',
    `--screenshot=${png}`,
    url,
  ]);
}

function dom(binary, url, width) {
  return runChromium(binary, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--window-size=${width},900`,
    '--virtual-time-budget=15000',
    '--dump-dom',
    url,
  ], 16 * 1024 * 1024);
}

test('Stato sync renders in a real browser with PNG evidence', { skip: SKIP, timeout: 300000 }, async (t) => {
  const server = await startServer();
  const shots = mkdtempSync(join(tmpdir(), 'bo-sync-'));
  try {
    const port = server.address().port;
    for (const state of ['ok', 'fix']) {
      for (const width of [1280, 390]) {
        const url = `http://127.0.0.1:${port}/__harness.html?state=${state}`;
        const png = join(shots, `stato-sync-${state}-${width}.png`);
        await t.test(`screenshot ${state} at ${width}px`, async () => {
          const rendered = await shot(BINARY, url, width, png);
          assert.equal(rendered.status, 0, `headless shell failed: ${rendered.stderr}`);
          assert.ok(existsSync(png), 'the PNG was captured');
          // A real render of this screen is tens of kilobytes; a blank page
          // would be an order of magnitude smaller.
          assert.ok(statSync(png).size > 15000, `the PNG is a real render (${statSync(png).size} bytes)`);
          const dumped = await dom(BINARY, url, width);
          assert.equal(dumped.status, 0, `dump-dom failed: ${dumped.stderr}`);
          const html = dumped.stdout;
          assert.ok(html.includes('data-sync-ready="yes"'), 'the view finished rendering');
          assert.ok(html.includes('Stato sync'), 'the screen title is on screen');
          assert.ok(html.includes('bo-sync-table'), 'the channel table is on screen');
          if (state === 'ok') {
            assert.ok(html.includes('Tutto a posto'), 'the ok indicator is on screen');
            assert.ok(html.includes('Niente da sistemare'), 'the empty fix list is on screen');
          } else {
            assert.ok(html.includes('da sistemare'), 'the fix indicator is on screen');
            assert.ok(html.includes('Riattiva da Connettori'), 'the broken channel says what to do');
            assert.ok(html.includes('Sincronizza ora'), 'the pull button is on screen');
          }
          if (width === 390) {
            assert.ok(html.includes('data-overflow="ok"'), 'no page-level sideways scroll under 700px');
          }
        });
      }
    }
    writeFileSync(join(shots, 'README.txt'), `Stato sync browser evidence (backlog:63af493dea0a), ${new Date().toISOString()}\n`);
    console.log(`Stato sync PNGs: ${shots}`);
  } finally {
    server.close();
  }
});
