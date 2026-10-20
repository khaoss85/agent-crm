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
 * Serving (see `scripts/admin-shots-harness.js`). Each side gets its own
 * loopback server rooted at its frozen tree, so the absolute asset URLs the
 * app ships (`/styles.css`, `/app.js`) resolve to that side's bytes. The
 * servers stub the Admin read APIs with deterministic rows, so every captured
 * screen renders real `.badge` nodes. Before comparing, the script proves the
 * proof is not vacuous and exits 1 with no fixtures when any check fails:
 * each side must have served its own `/styles.css` with 200 and the expected
 * bytes (plus `/app.js` and `/index.html` with 200), every captured screen
 * must render at least one `.badge` node, and the rendered badge classes must
 * cover every state-colour group of the working-tree stylesheet.
 *
 * Requires a Chromium binary (shared discovery in
 * `scripts/admin-shots-harness.js`: full browsers first, then the Playwright
 * locations `scripts/site-shots.js` uses). Unlike site-shots — a publishing
 * convenience that skips silently — this is a proof tool: with no Chromium
 * it exits 2 instead of writing a vacuous proof. Run it where a browser
 * exists (CI images with Playwright browsers, a maintainer Mac):
 * `npm run admin:shots`.
 */

import { spawnSync } from 'node:child_process';
import { spawnGit } from './git-env.js';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffPng } from './admin-png-diff.js';
import {
  STUB_VERSION,
  chromiumCaptureFlags,
  countBadgeNodes,
  findChromium,
  isHeadlessShell,
  snipDom,
  startRootServer,
  stateBadgeGroups,
  stripAuthority,
  summarizeServed,
} from './admin-shots-harness.js';

const root = process.cwd();
const ADMIN = join(root, 'apps/admin/public');
const FIXTURES = join(root, 'tests', 'fixtures', 'admin-shots');

/** Existing screens that paint badges, at one fixed desktop frame each. */
const ROUTES = [
  { route: '#/', file: 'dashboard.png', width: 1280, height: 800 },
  { route: '#/work', file: 'work.png', width: 1280, height: 800 },
];

/** @param {string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Render one URL to a PNG screenshot plus its serialized DOM (after the
 * app's own fetches settle). Either artifact missing is a capture failure.
 * @param {string} binary chromium binary
 * @param {string} url
 * @param {{ width: number, height: number }} frame
 * @param {string} shotPath where to write the screenshot
 * @param {string} profileDir fresh Chromium profile (never the user's own:
 * without it a running desktop Chrome can swallow the request and exit
 * without writing any screenshot)
 * @returns {{ dom: string, domBytes: number, elapsedMs: number } | { error: string }}
 */
function capture(binary, url, frame, shotPath, profileDir) {
  // Flag order is fixed by the shared harness (proxy bypass and Chromium's
  // own render timeout included); the fresh per-capture profile is appended
  // by the caller.
  const flags = [...chromiumCaptureFlags(binary), `--user-data-dir=${profileDir}`];
  const startedAt = Date.now();
  const shot = spawnSync(
    binary,
    [...flags, `--screenshot=${shotPath}`, `--window-size=${frame.width},${frame.height}`, url],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (!existsSync(shotPath)) {
    // The runner is the only machine with a browser: report WHY Chromium
    // produced nothing (spawn error/exit status/signal/stderr tail) instead
    // of a bare sentence, so the next CI log names the cause directly.
    const spawnErr = /** @type {NodeJS.ErrnoException | undefined} */ (shot.error);
    const spawnError = spawnErr ? ` spawn=${spawnErr.code ?? spawnErr.message}` : '';
    const signal = shot.signal ? ` signal=${shot.signal}` : '';
    const status = shot.status !== null && shot.status !== undefined ? ` exit=${shot.status}` : '';
    const stderr = typeof shot.stderr === 'string' ? shot.stderr.trim().split('\n').slice(-5).join(' | ') : '';
    return { error: `chromium wrote no screenshot (${binary.split('/').pop()}${spawnError}${status}${signal}${stderr ? ` stderr: ${stderr}` : ' no stderr'})` };
  }
  const dom = spawnSync(binary, [...flags, '--dump-dom', url], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (typeof dom.stdout !== 'string' || !dom.stdout.includes('<html')) {
    return { error: 'chromium produced no serialized DOM' };
  }
  return { dom: dom.stdout, domBytes: Buffer.byteLength(dom.stdout), elapsedMs: Date.now() - startedAt };
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
  console.log(`admin-shots: renderer ${binary} (headless-shell: ${isHeadlessShell(binary)})`);
  const headCss = readFileSync(join(ADMIN, 'styles.css'), 'utf8');
  let baseCss;
  let baseRef;
  if (!beforeArg || beforeArg === 'origin/main') {
    baseRef = 'origin/main';
    const shown = spawnGit(['show', 'origin/main:apps/admin/public/styles.css'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    if (shown.status !== 0) {
      console.error('admin-shots: cannot read the base stylesheet — is origin/main fetched?');
      process.exit(1);
    }
    baseCss = shown.stdout;
  } else if (beforeArg === 'strip-authority') {
    baseRef = 'strip-authority';
    try {
      baseCss = stripAuthority(headCss);
    } catch (error) {
      console.error(`admin-shots: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    baseRef = beforeArg;
    const shown = spawnGit(['show', `${beforeArg}:apps/admin/public/styles.css`], {
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
  const stateGroups = stateBadgeGroups(headCss);
  if (stateGroups.length === 0) {
    console.error('admin-shots: no state badge groups parsed from the working-tree stylesheet.');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'admin-shots-'));
  const beforeDir = join(scratch, 'before');
  const afterDir = join(scratch, 'after');
  cpSync(ADMIN, beforeDir, { recursive: true });
  cpSync(ADMIN, afterDir, { recursive: true });
  writeFileSync(join(beforeDir, 'styles.css'), baseCss);

  /** @type {{ side: string, server: import('node:http').Server, log: { method: string, path: string, status: number, bytes: number }[], port: number, css: string }[]} */
  const sides = [
    { side: 'before', server: null, log: [], port: 0, css: baseCss },
    { side: 'after', server: null, log: [], port: 0, css: headCss },
  ].map((entry) => ({
    ...entry,
    server: startRootServer(entry.side === 'before' ? beforeDir : afterDir, { log: entry.log }),
  }));
  for (const entry of sides) {
    await new Promise((resolve) => entry.server.listen(0, '127.0.0.1', resolve));
    const address = entry.server.address();
    entry.port = typeof address === 'object' && address ? address.port : 0;
  }

  /** @type {{ route: string, file: string, width: number, height: number, diffPixels: number, badgeNodesBefore: number, badgeNodesAfter: number }[]} */
  const compared = [];
  /** Union of rendered badge state classes across every capture. */
  const renderedStates = new Set();
  let failed = false;
  let failureReason = '';
  /** @param {string} reason */
  const fail = (reason) => {
    console.error(`  ✗ ${reason}`);
    failed = true;
    if (!failureReason) failureReason = reason;
  };
  try {
    for (const target of ROUTES) {
      /** @type {Record<string, Buffer>} */
      const shots = {};
      /** @type {Record<string, number>} */
      const badgeCounts = {};
      /** @type {Record<string, { domBytes: number, elapsedMs: number, domHead: string }>} */
      const captureDiag = {};
      for (const entry of sides) {
        const output = join(scratch, `${entry.side}-${target.file}`);
        const url =
          `http://127.0.0.1:${entry.port}/index.html` + (target.route === '#/' ? '' : target.route);
        const profile = join(scratch, `profile-${entry.side}-${target.file}`);
        const result = capture(binary, url, target, output, profile);
        if ('error' in result) {
          fail(`${entry.side}/${target.file}: ${result.error}`);
          break;
        }
        shots[entry.side] = readFileSync(output);
        const counted = countBadgeNodes(result.dom);
        badgeCounts[entry.side] = counted.total;
        captureDiag[entry.side] = {
          domBytes: result.domBytes,
          elapsedMs: result.elapsedMs,
          domHead: snipDom(result.dom),
        };
        for (const state of counted.states) renderedStates.add(state);
      }
      if (failed || !shots.before || !shots.after) {
        failed = true;
        break;
      }
      if (badgeCounts.before < 1 || badgeCounts.after < 1) {
        fail(
          `${target.route}: rendered no badge nodes ` +
            `(before ${badgeCounts.before}, after ${badgeCounts.after}) — ` +
            'the diff could not detect a badge regression',
        );
        // Name the cause in the log: whether each side's app shell, CSS and
        // stubbed APIs answered, how large the dumped DOM was, and what its
        // head holds — the difference between "the browser never ran the
        // app" and "the app rendered no badges".
        for (const entry of sides) {
          const diag = captureDiag[entry.side];
          console.error(`    ${entry.side}: dump-dom ${diag?.domBytes ?? 0}b in ${diag?.elapsedMs ?? 0}ms`);
          for (const line of summarizeServed(entry.log)) console.error(`    ${entry.side} served: ${line}`);
          console.error(`    ${entry.side} DOM head: ${diag?.domHead ?? '(none)'}`);
        }
        break;
      }
      let verdict;
      try {
        verdict = diffPng(shots.before, shots.after);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fail(`${target.route}: cannot decode screenshots (${reason})`);
        break;
      }
      console.log(
        `  ${verdict.equal ? '✓' : '✗'} ${target.route} → ${target.file}: ` +
          `${verdict.reason} (before ${verdict.left.width}×${verdict.left.height}, ` +
          `badges before ${badgeCounts.before}/after ${badgeCounts.after})`,
      );
      if (!verdict.equal) {
        fail(
          `${target.route}: ${verdict.diffPixels} differing pixels, first at ` +
            `(${verdict.firstDiff?.x}, ${verdict.firstDiff?.y})`,
        );
        break;
      }
      compared.push({ ...target, diffPixels: 0, badgeNodesBefore: badgeCounts.before, badgeNodesAfter: badgeCounts.after });
      // Keep the passing pair for the fixture write below.
      writeFileSync(join(scratch, `keep-before-${target.file}`), shots.before);
      writeFileSync(join(scratch, `keep-after-${target.file}`), shots.after);
    }

    if (!failed) {
      // The proof is only as good as its setup: each side must have served
      // its OWN stylesheet (200, expected bytes) plus the app shell, and the
      // rendered badges must cover every state-colour group.
      for (const entry of sides) {
        const cssHits = entry.log.filter((item) => item.path === '/styles.css' && item.status === 200);
        if (cssHits.length === 0) {
          fail(`${entry.side}: /styles.css was never fetched with 200 — the diff compared unstyled markup`);
          break;
        }
        const expectedBytes = Buffer.byteLength(entry.css);
        if (!cssHits.some((item) => item.bytes === expectedBytes)) {
          fail(`${entry.side}: /styles.css bytes never matched this side's stylesheet — the diff compared the wrong CSS`);
          break;
        }
        for (const asset of ['/app.js', '/index.html']) {
          if (!entry.log.some((item) => item.path === asset && item.status === 200)) {
            fail(`${entry.side}: ${asset} was never fetched with 200 — the app did not boot from this side's tree`);
            break;
          }
        }
        if (failed) break;
      }
    }

    /** @type {string[]} */
    let uncoveredGroups = [];
    if (!failed) {
      uncoveredGroups = stateGroups
        .filter((group) => !group.some((state) => renderedStates.has(state)))
        .map((group) => group.join('|'));
      if (uncoveredGroups.length > 0) {
        fail(
          `rendered badges never cover state group(s) ${uncoveredGroups.join(', ')} — ` +
            'a restyle of those pairs would move no pixel in this proof',
        );
      }
    }
  } finally {
    for (const entry of sides) entry.server.close();
  }

  if (failed) {
    rmSync(scratch, { recursive: true, force: true });
    console.error(`admin-shots: ${failureReason} — no fixtures written.`);
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
    backend: 'stubbed-api',
    stubVersion: STUB_VERSION,
    baseRef,
    baseStylesSha: sha256(baseCss),
    headStylesSha: sha256(headCss),
    capturedAt: new Date().toISOString(),
    renderer: binary.split('/').pop(),
    command: `npm run admin:shots${beforeArg ? ` -- --before=${beforeArg}` : ''}`,
    stateGroupsCovered: stateGroups.length,
    screens: compared.map(({ route, file, width, height, badgeNodesBefore, badgeNodesAfter }) => ({
      route,
      file,
      width,
      height,
      badgeNodesBefore,
      badgeNodesAfter,
    })),
  };
  writeFileSync(join(FIXTURES, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${compared.length} screen(s) identical; fixtures in tests/fixtures/admin-shots/.`);
}

await main();
