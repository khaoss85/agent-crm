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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
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
