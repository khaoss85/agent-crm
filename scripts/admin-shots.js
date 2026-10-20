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
 * proof is not vacuous and exits 1 with no fixtures when any check fails.
 * The checks run per Chromium invocation on its OWN request-log slice (never
 * the union log): the screenshot run and the --dump-dom run must each have
 * served this side's `/styles.css` with 200 and the expected bytes (plus
 * `/app.js` and `/index.html` with 200), and both runs must show identical
 * stub-API traffic — otherwise the compared PNGs and the counted DOM could
 * describe different renders. Every captured screen must render at least one
 * `.badge` node, and the rendered badge classes must cover every
 * state-colour group of the working-tree stylesheet. The counted DOM of
 * every screen/side is committed under `tests/fixtures/admin-shots/dom/`
 * and the manifest test recomputes badge counts, coverage, PNG richness and
 * the rendered no-authority proof from those files.
 *
 * Requires a Chromium binary (shared discovery in
 * `scripts/admin-shots-harness.js`: full browsers first, then the Playwright
 * locations `scripts/site-shots.js` uses). Unlike site-shots — a publishing
 * convenience that skips silently — this is a proof tool: with no Chromium
 * it exits 2 instead of writing a vacuous proof. Run it where a browser
 * exists (CI images with Playwright browsers, a maintainer Mac):
 * `npm run admin:shots`.
 */

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
  apiFingerprint,
  chromiumCaptureFlags,
  countBadgeNodes,
  findChromium,
  isHeadlessShell,
  runProcess,
  sideProofError,
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
 *
 * Two Chromium invocations per capture (screenshot, then --dump-dom), and
 * each invocation proves itself: the shared request `log` is sliced around
 * each run, and the screenshot run's OWN slice must show this side's assets
 * with 200 — a union log cannot tell which run fetched what, so a blank
 * screenshot run could otherwise hide behind a good DOM run (review finding
 * on head b8fce9e1). The two slices must also carry identical stub-API
 * traffic, so both renderings provably saw the same server responses.
 *
 * Async on purpose: the loopback servers live in this same process, so a
 * synchronous spawn would starve them — Chromium's requests would never be
 * answered and every capture would dump an empty document (CI run
 * 39497667414). The awaits below keep the servers answering while Chromium
 * renders.
 * @param {string} binary chromium binary
 * @param {string} url
 * @param {{ width: number, height: number }} frame
 * @param {string} shotPath where to write the screenshot
 * @param {string} profileDir fresh Chromium profile (never the user's own:
 * without it a running desktop Chrome can swallow the request and exit
 * without writing any screenshot)
 * @param {{ method: string, path: string, status: number, bytes: number }[]} log the side's shared request log
 * @returns {Promise<{ dom: string, domBytes: number, elapsedMs: number, shotServed: { method: string, path: string, status: number, bytes: number }[], domServed: { method: string, path: string, status: number, bytes: number }[] } | { error: string }>}
 */
async function capture(binary, url, frame, shotPath, profileDir, log) {
  // Flag order is fixed by the shared harness (proxy bypass and Chromium's
  // own render timeout included); the fresh per-capture profile is appended
  // by the caller.
  const flags = [...chromiumCaptureFlags(binary), `--user-data-dir=${profileDir}`];
  const startedAt = Date.now();
  const shotMark = log.length;
  const shot = await runProcess(
    binary,
    [...flags, `--screenshot=${shotPath}`, `--window-size=${frame.width},${frame.height}`, url],
    { timeoutMs: 60_000 },
  );
  if (shot.timedOut) {
    return { error: `chromium screenshot timed out after 60s (${binary.split('/').pop()})` };
  }
  if (!existsSync(shotPath)) {
    // The runner is the only machine with a browser: report WHY Chromium
    // produced nothing (spawn error/exit status/signal/stderr tail) instead
    // of a bare sentence, so the next CI log names the cause directly.
    const spawnError = shot.error
      ? ` spawn=${/** @type {NodeJS.ErrnoException} */ (shot.error).code ?? /** @type {Error} */ (shot.error).message}`
      : '';
    const signal = shot.signal ? ` signal=${shot.signal}` : '';
    const status = shot.status !== null && shot.status !== undefined ? ` exit=${shot.status}` : '';
    const stderr = typeof shot.stderr === 'string' ? shot.stderr.trim().split('\n').slice(-5).join(' | ') : '';
    return { error: `chromium wrote no screenshot (${binary.split('/').pop()}${spawnError}${status}${signal}${stderr ? ` stderr: ${stderr}` : ' no stderr'})` };
  }
  const shotServed = log.slice(shotMark);
  const domMark = log.length;
  const dom = await runProcess(binary, [...flags, '--dump-dom', url], {
    timeoutMs: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const domServed = log.slice(domMark);
  if (dom.timedOut) {
    return { error: 'chromium --dump-dom timed out after 60s' };
  }
  if (typeof dom.stdout !== 'string' || !dom.stdout.includes('<html')) {
    return { error: 'chromium produced no serialized DOM' };
  }
  return { dom: dom.stdout, domBytes: Buffer.byteLength(dom.stdout), elapsedMs: Date.now() - startedAt, shotServed, domServed };
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

  /** @type {{ route: string, file: string, width: number, height: number, diffPixels: number, badgeNodesBefore: number, badgeNodesAfter: number, domBefore: string, domAfter: string, domShaBefore: string, domShaAfter: string }[]} */
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
        const result = await capture(binary, url, target, output, profile, entry.log);
        if ('error' in result) {
          fail(`${entry.side}/${target.file}: ${result.error}`);
          break;
        }
        // Each invocation proves itself on its OWN log slice: the screenshot
        // run must have rendered this side's tree (its stylesheet bytes, app
        // shell, boot script), not an empty shell the later DOM run covers.
        const cssBytes = Buffer.byteLength(entry.css);
        for (const [run, served] of [['screenshot', result.shotServed], ['dump-dom', result.domServed]]) {
          const proofError = sideProofError(served, { side: entry.side, cssBytes });
          if (proofError) {
            fail(`${entry.side}/${target.file}: ${run} run: ${proofError}`);
            break;
          }
        }
        if (failed) break;
        // Both renderings must have seen identical stub-API responses: same
        // paths, same bytes. Otherwise the PNG and the counted DOM describe
        // different renders and neither proves the other.
        const shotApi = apiFingerprint(result.shotServed);
        const domApi = apiFingerprint(result.domServed);
        if (shotApi.length === 0 || domApi.length === 0 || shotApi.join('\n') !== domApi.join('\n')) {
          fail(
            `${entry.side}/${target.file}: screenshot and DOM runs saw different API traffic ` +
              `(shot [${shotApi.join(', ')}] vs dom [${domApi.join(', ')}]) — the counted DOM may not describe the compared pixels`,
          );
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
        // Persist the exact DOM the badge gate counted: the manifest test
        // recomputes from these files instead of trusting the manifest.
        writeFileSync(join(scratch, `dom-${entry.side}-${target.file}.html`), result.dom);
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
      const domBase = target.file.replace(/\.png$/, '.html');
      compared.push({
        ...target,
        diffPixels: 0,
        badgeNodesBefore: badgeCounts.before,
        badgeNodesAfter: badgeCounts.after,
        domBefore: `before-${domBase}`,
        domAfter: `after-${domBase}`,
        domShaBefore: sha256(readFileSync(join(scratch, `dom-before-${target.file}.html`), 'utf8')),
        domShaAfter: sha256(readFileSync(join(scratch, `dom-after-${target.file}.html`), 'utf8')),
      });
      // Keep the passing pair for the fixture write below.
      writeFileSync(join(scratch, `keep-before-${target.file}`), shots.before);
      writeFileSync(join(scratch, `keep-after-${target.file}`), shots.after);
    }

    // Per-run asset proof and API-traffic equality already ran per capture
    // above (on each invocation's own log slice, not the union log). What
    // remains is the coverage gate: the rendered badges must span every
    // state-colour group, or a restyle of a pair moves no pixel in the proof.

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
  mkdirSync(join(FIXTURES, 'dom'), { recursive: true });
  for (const target of compared) {
    cpSync(join(scratch, `keep-before-${target.file}`), join(FIXTURES, 'before', target.file));
    cpSync(join(scratch, `keep-after-${target.file}`), join(FIXTURES, 'after', target.file));
    cpSync(join(scratch, `dom-before-${target.file}.html`), join(FIXTURES, 'dom', target.domBefore));
    cpSync(join(scratch, `dom-after-${target.file}.html`), join(FIXTURES, 'dom', target.domAfter));
  }
  const manifest = {
    version: 2,
    backend: 'stubbed-api',
    stubVersion: STUB_VERSION,
    baseRef,
    baseStylesSha: sha256(baseCss),
    headStylesSha: sha256(headCss),
    capturedAt: new Date().toISOString(),
    renderer: binary.split('/').pop(),
    command: `npm run admin:shots${beforeArg ? ` -- --before=${beforeArg}` : ''}`,
    stateGroupsCovered: stateGroups.length,
    screens: compared.map(({ route, file, width, height, badgeNodesBefore, badgeNodesAfter, domBefore, domAfter, domShaBefore, domShaAfter }) => ({
      route,
      file,
      width,
      height,
      badgeNodesBefore,
      badgeNodesAfter,
      domBefore,
      domAfter,
      domShaBefore,
      domShaAfter,
    })),
  };
  writeFileSync(join(FIXTURES, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${compared.length} screen(s) identical; fixtures in tests/fixtures/admin-shots/.`);
}

await main();
