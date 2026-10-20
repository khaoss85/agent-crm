// @ts-check
/**
 * Captures the Admin visual baseline for BO-F0-01: before/after PNGs of the
 * existing Admin screens, rendered by real Chromium from the real app.
 *
 * `after/` uses the working-tree `apps/admin/public/styles.css`. `before/` uses
 * `--before`: a git ref whose stylesheet is served instead (default
 * `origin/main`), or `strip-authority`, which serves the working-tree
 * stylesheet with the six `.badge[data-authority]` rules removed — the exact
 * F0-01 delta once the change is already merged and main has moved on. The two
 * copies are served from scratch directories; the worktree is never modified.
 * Every pair must be pixel-identical or the script exits 1 with no fixtures.
 *
 * Backend mode is `static-nobackend`: the app is served statically with no
 * framework server, so API calls answer 404 and the screens render their
 * deterministic unavailable/empty shells. That is the whole layout, type and
 * chrome surface; badge semantics for every state are pinned separately by
 * `tests/admin-authority-tokens.test.js`, which needs no browser.
 *
 * Requires a Chromium binary (same discovery as `scripts/site-shots.js`).
 * Unlike site-shots — a publishing convenience that skips silently — this is
 * a proof tool: with no Chromium it exits 2 instead of writing a vacuous
 * proof. Run it where a browser exists (CI images with Playwright browsers,
 * a maintainer Mac): `npm run admin:shots`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, extname } from 'node:path';
import { diffPng } from './admin-png-diff.js';

const root = process.cwd();
const ADMIN = join(root, 'apps/admin/public');
const FIXTURES = join(root, 'tests', 'fixtures', 'admin-shots');

/** Existing screens that paint badges, at one fixed desktop frame each. */
const ROUTES = [
  { route: '#/', file: 'dashboard.png', width: 1280, height: 800 },
  { route: '#/work', file: 'work.png', width: 1280, height: 800 },
];

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

/** @param {string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function findChromium() {
  // Mirrors scripts/site-shots.js: CHROMIUM_BIN first, then the Playwright
  // locations the CI images provide, then system browsers.
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
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

/**
 * Serve two frozen copies of the Admin app: /before/* (base stylesheet) and
 * /after/* (working-tree stylesheet). Unknown paths answer 404 with an empty
 * body — the honest static-nobackend response the app already handles.
 * @param {string} beforeDir
 * @param {string} afterDir
 */
function startStaticServer(beforeDir, afterDir) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/(before|after)(\/.*)?$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    const base = match[1] === 'before' ? beforeDir : afterDir;
    let file = join(base, decodeURIComponent(match[2] ?? '/'));
    if (url.pathname.endsWith('/')) file = join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  return server;
}

async function main() {
  const beforeArg = process.argv.find((arg) => arg.startsWith('--before='))?.slice('--before='.length);
  const binary = findChromium();
  if (!binary) {
    console.error(
      'admin-shots: no Chromium binary found (set CHROMIUM_BIN to override).\n' +
        'The before/after proof needs a real browser: run `npm run admin:shots` on a CI image ' +
        'with Playwright browsers or a maintainer Mac. Nothing was written.',
    );
    process.exit(2);
  }
  const headCss = readFileSync(join(ADMIN, 'styles.css'), 'utf8');
  let baseCss;
  let baseRef;
  if (!beforeArg || beforeArg === 'origin/main') {
    baseRef = 'origin/main';
    const shown = spawnSync('git', ['show', 'origin/main:apps/admin/public/styles.css'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (shown.status !== 0) {
      console.error('admin-shots: cannot read the base stylesheet — is origin/main fetched?');
      process.exit(1);
    }
    baseCss = shown.stdout;
  } else if (beforeArg === 'strip-authority') {
    baseRef = 'strip-authority';
    const lines = headCss.split('\n');
    const kept = lines.filter((line) => !/^\s*\.badge\[data-authority="[^"]+"\] \{[^}]*\}\s*$/.test(line));
    if (lines.length - kept.length !== 6) {
      console.error(
        `admin-shots: expected to strip exactly 6 authority-badge rules, found ${lines.length - kept.length}.`,
      );
      process.exit(1);
    }
    baseCss = kept.join('\n');
  } else {
    baseRef = beforeArg;
    const shown = spawnSync('git', ['show', `${beforeArg}:apps/admin/public/styles.css`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (shown.status !== 0) {
      console.error(`admin-shots: cannot read styles.css at ${beforeArg}.`);
      process.exit(1);
    }
    baseCss = shown.stdout;
  }
  if (baseCss === headCss) {
    console.error('admin-shots: base and working-tree stylesheets are identical — nothing to compare.');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'admin-shots-'));
  const beforeDir = join(scratch, 'before');
  const afterDir = join(scratch, 'after');
  cpSync(ADMIN, beforeDir, { recursive: true });
  cpSync(ADMIN, afterDir, { recursive: true });
  writeFileSync(join(beforeDir, 'styles.css'), baseCss);

  const server = startStaticServer(beforeDir, afterDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  /** @type {{ route: string, file: string, width: number, height: number, diffPixels: number }[]} */
  const compared = [];
  let failed = false;
  let noScreenshot = false;
  try {
    for (const target of ROUTES) {
      /** @type {Record<string, Buffer>} */
      const shots = {};
      for (const side of ['before', 'after']) {
        const output = join(scratch, `${side}-${target.file}`);
        const url =
          `http://127.0.0.1:${port}/${side}/index.html` +
          (target.route === '#/' ? '' : target.route);
        const result = spawnSync(
          binary,
          [
            ...(/headless_shell/.test(binary) ? [] : ['--headless=new']),
            '--no-sandbox',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--hide-scrollbars',
            '--virtual-time-budget=3000',
            '--force-device-scale-factor=1',
            `--screenshot=${output}`,
            `--window-size=${target.width},${target.height}`,
            url,
          ],
          { encoding: 'utf8', timeout: 60_000 },
        );
        void result;
        if (!existsSync(output)) {
          console.error(`  ✗ ${side}/${target.file}: chromium wrote no screenshot`);
          failed = true;
          noScreenshot = true;
          break;
        }
        shots[side] = readFileSync(output);
      }
      if (failed || !shots.before || !shots.after) {
        failed = true;
        break;
      }
      const verdict = diffPng(shots.before, shots.after);
      console.log(
        `  ${verdict.equal ? '✓' : '✗'} ${target.route} → ${target.file}: ` +
          `${verdict.reason} (before ${verdict.left.width}×${verdict.left.height})`,
      );
      if (!verdict.equal) {
        console.error(
          `    ${verdict.diffPixels} differing pixels, first at ` +
            `(${verdict.firstDiff?.x}, ${verdict.firstDiff?.y})`,
        );
        failed = true;
        break;
      }
      compared.push({ ...target, diffPixels: 0 });
      // Keep the passing pair for the fixture write below.
      writeFileSync(join(scratch, `keep-before-${target.file}`), shots.before);
      writeFileSync(join(scratch, `keep-after-${target.file}`), shots.after);
    }
  } finally {
    server.close();
  }

  if (failed) {
    rmSync(scratch, { recursive: true, force: true });
    console.error(
      noScreenshot
        ? 'admin-shots: capture failed — no fixtures written.'
        : 'admin-shots: before/after differ — no fixtures written.',
    );
    process.exit(1);
  }

  mkdirSync(join(FIXTURES, 'before'), { recursive: true });
  mkdirSync(join(FIXTURES, 'after'), { recursive: true });
  for (const target of compared) {
    cpSync(join(scratch, `keep-before-${target.file}`), join(FIXTURES, 'before', target.file));
    cpSync(join(scratch, `keep-after-${target.file}`), join(FIXTURES, 'after', target.file));
  }
  const manifest = {
    version: 1,
    backend: 'static-nobackend',
    baseRef,
    baseStylesSha: sha256(baseCss),
    headStylesSha: sha256(headCss),
    capturedAt: new Date().toISOString(),
    renderer: binary.split('/').pop(),
    command: 'npm run admin:shots',
    screens: compared.map(({ route, file, width, height }) => ({ route, file, width, height })),
  };
  writeFileSync(join(FIXTURES, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${compared.length} screen(s) identical; fixtures in tests/fixtures/admin-shots/.`);
}

await main();
