// @ts-check
/**
 * Shared harness behind the Admin visual-baseline proof (BO-F0-01 AC-3).
 *
 * `scripts/admin-shots.js` serves two frozen copies of `apps/admin/public`
 * (before/after stylesheets) and screenshots them with real Chromium;
 * `tests/admin-shots-harness.test.js` unit-tests this module with no browser.
 * `tests/admin-shots-manifest.test.js` locks the captured fixtures.
 *
 * Two facts keep the proof from being vacuous (both were review findings on
 * the first harness, which served one /before|after mount with an empty
 * backend):
 *
 * 1. Each side is served at the DOCUMENT ROOT of its own loopback server, so
 *    the absolute asset URLs the app ships (`/styles.css`, `/app.js`) resolve
 *    to that side's frozen tree. The capture asserts every side answered its
 *    own `/styles.css` with 200 and the expected bytes before comparing.
 * 2. The servers stub the Admin read APIs with deterministic rows, so every
 *    captured screen renders real `.badge` nodes covering each state-colour
 *    group. The capture fails when a screen renders no badge, or when the
 *    rendered badge classes stop covering a state group.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, extname, sep } from 'node:path';

/** Bump when the stub rows below change shape; recorded in the manifest. */
export const STUB_VERSION = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Deterministic Admin read-model for the capture. Rows are plausible Admin
 * content (a renewal, a trial, two approvals, two traced runs, three work
 * tasks) chosen so the rendered `.badge` classes span every state-colour
 * group in `styles.css`: `approval_pending` (pending pair), `rejected`
 * (human pair), `proposal` (agent pair), `completed` (accent pair) and
 * `failed` (danger pair). The work queue adds the honest `open` /
 * `completed` / `cancelled` task states.
 * @param {string} pathname request path without the query string
 * @returns {{ status: number, contentType: string, body: string } | null}
 */
export function stubResponse(pathname) {
  switch (pathname) {
    case '/health':
      return json({ ok: true });
    case '/api/admin/metrics':
      return json({
        counts: { companies: 2, opportunities: 3, pendingApprovals: 2, workflowRuns: 2 },
      });
    case '/api/opportunities':
      return json({
        items: [
          {
            id: 'opp-1',
            name: 'Alba Fitness renewal',
            type: 'renewal',
            companyName: 'Alba Fitness',
            valueCents: 52000,
            currency: 'EUR',
            owner: 'guido',
            stage: 'proposal',
          },
          {
            id: 'opp-2',
            name: 'Beta Gym trial',
            type: 'new_business',
            companyName: 'Beta Gym',
            valueCents: 8000,
            currency: 'EUR',
            owner: 'maria',
            stage: 'qualification',
          },
        ],
      });
    case '/api/approvals':
      return json({
        items: [
          {
            id: 'appr-1',
            opportunityId: 'opp-1',
            opportunityName: 'Alba Fitness renewal',
            companyName: 'Alba Fitness',
            valueCents: 52000,
            currency: 'EUR',
            status: 'approval_pending',
            reason: 'Renewals above €50k need a human decision.',
          },
          {
            id: 'appr-2',
            opportunityId: 'opp-2',
            opportunityName: 'Beta Gym trial',
            companyName: 'Beta Gym',
            valueCents: 8000,
            currency: 'EUR',
            status: 'rejected',
            reason: 'Duplicate request.',
          },
        ],
      });
    case '/api/traces':
      return json({
        items: [
          {
            id: 'trace-1',
            workflowName: 'Renewal approval',
            startedAt: '2026-10-19T09:00:00.000Z',
            status: 'completed',
          },
          {
            id: 'trace-2',
            workflowName: 'Trial follow-up',
            startedAt: '2026-10-19T10:30:00.000Z',
            status: 'failed',
          },
        ],
      });
    case '/api/write-outcomes':
      return json({ items: [] });
    case '/api/schema':
      return json({
        domains: {
          work: {
            limitation: 'Tasks are records only: nothing reminds, assigns or sends.',
            notModeled: ['assignees', 'reminders', 'notifications'],
          },
        },
      });
    case '/api/modules/work-task/records':
      return json({
        items: [
          {
            id: 'task-1',
            title: 'Call Alba Fitness about the renewal',
            status: 'open',
            subjectResource: 'company',
            subjectId: 'alba-fitness',
            subjectLabel: 'Alba Fitness',
            openedById: 'guido',
            dueAt: '2026-10-24',
          },
          {
            id: 'task-2',
            title: 'Send the trial summary to Beta Gym',
            status: 'completed',
            subjectResource: 'company',
            subjectId: 'beta-gym',
            subjectLabel: 'Beta Gym',
            openedById: 'maria',
            dueAt: '2026-10-18',
          },
          {
            id: 'task-3',
            title: 'Archive the duplicate request',
            status: 'cancelled',
            subjectResource: 'company',
            subjectId: 'beta-gym',
            subjectLabel: 'Beta Gym',
            openedById: 'guido',
            dueAt: '2026-10-17',
          },
        ],
      });
    default:
      return null;
  }
}

/** @param {unknown} value */
function json(value) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) };
}

/**
 * Serve one frozen Admin tree at the document root, with the stubbed read
 * APIs above. Anything else answers 404 with an empty body — the honest
 * answer for a static capture with no framework server. Every request is
 * appended to `log` as `{ method, path, status, bytes }` so the capture can
 * prove which bytes each side actually served.
 * @param {string} dir frozen copy of apps/admin/public
 * @param {{ log?: { method: string, path: string, status: number, bytes: number }[] }} options
 */
export function startRootServer(dir, { log = [] } = {}) {
  const server = createServer((request, response) => {
    /** @param {number} status */
    const empty = (status) => {
      log.push({ method: request.method ?? 'GET', path: safePath(request.url), status, bytes: 0 });
      response.writeHead(status);
      response.end();
    };
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      empty(404);
      return;
    }
    const stub = stubResponse(pathname);
    if (stub) {
      const bytes = Buffer.byteLength(stub.body);
      log.push({ method: request.method ?? 'GET', path: pathname, status: stub.status, bytes });
      response.writeHead(stub.status, { 'content-type': stub.contentType });
      response.end(stub.body);
      return;
    }
    let file;
    try {
      file = join(dir, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    } catch {
      empty(404);
      return;
    }
    if (!file.startsWith(dir + sep)) {
      empty(404);
      return;
    }
    let isFile = false;
    try {
      isFile = existsSync(file) && statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      empty(404);
      return;
    }
    const body = readFileSync(file);
    log.push({ method: request.method ?? 'GET', path: pathname, status: 200, bytes: body.length });
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  });
  return server;
}

/** @param {string | undefined} url */
function safePath(url) {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '(unparseable)';
  }
}

/**
 * The working-tree stylesheet with the six `.badge[data-authority]` rules
 * removed: the exact F0-01 delta once the change is merged and main has moved
 * on. Shared by the capture script and the manifest test so the two can never
 * disagree on what "before" means.
 * @param {string} css
 */
export function stripAuthority(css) {
  const lines = css.split('\n');
  const kept = lines.filter((line) => !/^\s*\.badge\[data-authority="[^"]+"\] \{[^}]*\}\s*$/.test(line));
  if (lines.length - kept.length !== 6) {
    throw new Error(`expected to strip exactly 6 authority-badge rules, found ${lines.length - kept.length}`);
  }
  return kept.join('\n');
}

/**
 * State-colour groups from a stylesheet: each `.badge.<class>, ...` rule
 * (attribute variants such as `[data-authority]` excluded) becomes one group
 * of class names sharing a colour pair. The capture requires the rendered
 * badges to cover every group, so a silent restyle of any pair would move
 * pixels in the proof.
 * @param {string} css
 * @returns {string[][]}
 */
export function stateBadgeGroups(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const groups = [];
  for (const match of noComments.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const selector = match[1].trim();
    if (!selector.includes('.badge') || selector.includes('[')) continue;
    const classes = [...selector.matchAll(/\.badge\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    if (classes.length === 0) continue;
    groups.push(classes);
  }
  return groups;
}

/**
 * Whether a Chromium binary is already headless by definition (Playwright's
 * headless shell) and must NOT receive `--headless=new`. Matches both shell
 * spellings: the legacy `headless_shell` (also the Playwright download-dir
 * prefix `chromium_headless_shell-*`) and the current
 * `chrome-headless-shell` binary name, so a bare CHROMIUM_BIN pointing at
 * the hyphenated binary is not misdetected as a full browser.
 * @param {string} binary
 */
export function isHeadlessShell(binary) {
  return /headless[-_]shell/.test(binary);
}

/**
 * Locate a Chromium binary for the capture. Full browsers come first:
 * Playwright's macOS `chrome-headless-shell` renders nothing on the
 * maintainer Mac (exit 143, no screenshot, no stderr — CI run 39465652065),
 * while the installed Google Chrome screenshots with `--headless=new`.
 * Otherwise the same discovery as `scripts/site-shots.js` (CHROMIUM_BIN
 * override, then the Playwright cache locations), so Linux CI behaviour is
 * unchanged.
 * @param {{ env?: typeof process.env, exists?: (path: string) => boolean, home?: string, readdir?: (dir: string) => string[] }} [deps]
 * @returns {string | null}
 */
export function findChromium({ env = process.env, exists = existsSync, home = homedir(), readdir = readdirSync } = {}) {
  const candidates = [
    env.CHROMIUM_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    '/opt/pw-browsers/chromium/chrome-linux/headless_shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  const bases = [
    '/opt/pw-browsers',
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const base of bases) {
    let entries = [];
    try {
      entries = readdir(base);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      for (const suffix of [
        ['chrome-linux', 'headless_shell'],
        ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
      ]) {
        const path = join(base, entry, ...suffix);
        if (exists(path)) return path;
      }
    }
  }
  return null;
}

/**
 * Chromium flags for the Admin visual-baseline capture (BO-F0-01 AC-3).
 * Shared by `scripts/admin-shots.js` and its runner diagnostics so the two
 * can never disagree on how the proof renders. Two flags exist because the
 * self-hosted Mac runner is not a maintainer laptop:
 * - `--no-proxy-server`: neither proxy env vars nor the system proxy may
 *   touch the loopback capture servers; the captured pages are fully
 *   self-contained (no external fonts, scripts or pixels).
 * - `--timeout=30000`: bound Chromium's own render wait even if the virtual
 *   time budget stalls (CI run 39487589615: full Chrome produced no
 *   screenshot within the 60 s spawn bound). A page still unrendered after
 *   30 s fails closed through the badge gate, with the cause in the log.
 * `--user-data-dir` is NOT here: each capture gets a fresh profile so a
 * lingering Chromium from an earlier capture can never swallow the next
 * screenshot request and exit without writing.
 * @param {string} binary chromium binary
 */
export function chromiumCaptureFlags(binary) {
  return [
    ...(isHeadlessShell(binary) ? [] : ['--headless=new']),
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--virtual-time-budget=5000',
    '--timeout=30000',
    '--force-device-scale-factor=1',
  ];
}

/**
 * Count rendered badge nodes in serialized DOM: elements whose class list
 * contains the `badge` token.
 * @param {string} dom serialized document (e.g. Chromium --dump-dom)
 * @returns {{ total: number, states: string[] }}
 */
export function countBadgeNodes(dom) {
  let total = 0;
  const states = new Set();
  for (const match of String(dom).matchAll(/class="([^"]*)"/g)) {
    const tokens = match[1].split(/\s+/).filter(Boolean);
    if (!tokens.includes('badge')) continue;
    total += 1;
    for (const token of tokens) {
      if (token !== 'badge') states.add(token);
    }
  }
  return { total, states: [...states].sort() };
}

/**
 * Render one captured side's request log as log lines (`METHOD path status
 * bytes`), in arrival order. Printed by the capture script when a side
 * fails its badge gate, so the CI log names whether the app shell, the
 * stylesheet or the stubbed APIs never answered — the difference between
 * "the browser never ran the app" and "the app rendered no badges".
 * @param {{ method: string, path: string, status: number, bytes: number }[]} log
 * @returns {string[]}
 */
export function summarizeServed(log) {
  return (Array.isArray(log) ? log : []).map(
    (item) => `${item.method ?? 'GET'} ${item.path} ${item.status} ${item.bytes}b`,
  );
}

/**
 * Collapse a serialized DOM to a single log line for failure diagnostics:
 * whitespace runs become one space, the ends are trimmed, overlong
 * documents are cut with an explicit marker. Never throws on odd input.
 * @param {unknown} dom
 * @param {number} [max]
 */
export function snipDom(dom, max = 1200) {
  const flat = String(dom ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…(+${flat.length - max} chars)`;
}
