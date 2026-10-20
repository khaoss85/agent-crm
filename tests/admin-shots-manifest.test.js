// @ts-check
/**
 * BO-F0-01 — evidence lock for the Admin visual proof.
 *
 * `npm run admin:shots` (a browser machine: the executor sandbox cannot run
 * one) writes `tests/fixtures/admin-shots/`: before/after PNGs per screen,
 * the serialized DOM each badge count was taken from (`dom/`), and a
 * manifest naming the base/head stylesheet shas, the renderer and the
 * command. This test locks that evidence to the code it proves:
 *
 * - the manifest's head sha is the sha256 of the working-tree stylesheet, so
 *   stale fixtures from an older styles.css fail instead of passing;
 * - the base sha is recomputed the same way the script builds it
 *   (`strip-authority` filter, or `git show <ref>` through the isolated
 *   helper), so a hand-edited fixture fails;
 * - every screen pair decodes and pixel-diffs to zero through the same
 *   comparator the script uses;
 * - badge counts are RECOMPUTED from the committed DOM fixtures (never
 *   trusted from the manifest) and must equal the manifest numbers, with at
 *   least one badge per screen/side and full state-colour-group coverage;
 * - every PNG is non-vacuous: a minimum file size plus a minimum count of
 *   distinct RGB triples, so two identical blank captures fail;
 * - no committed DOM contains `data-authority`, so the rendered proof that
 *   no existing screen can match the authority rules holds on pixels, not
 *   on source scans.
 *
 * With no fixtures on disk the proof has not been captured yet: the test
 * skips and says how to capture it. A skip is the honest interim state, not
 * a green proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { diffPng, decodePng } from '../scripts/admin-png-diff.js';
import {
  STUB_VERSION,
  countBadgeNodes,
  countDistinctRgb,
  stateBadgeGroups,
  stripAuthority,
} from '../scripts/admin-shots-harness.js';
import { spawnGit } from './helpers/isolated-git.js';

const root = join(import.meta.dirname, '..');
const FIXTURES = join(root, 'tests', 'fixtures', 'admin-shots');
const MANIFEST = join(FIXTURES, 'manifest.json');
const DOM_DIR = join(FIXTURES, 'dom');
const ADMIN_CSS = join(root, 'apps/admin/public/styles.css');

/** Minimum PNG file size in bytes: real 1280x800 captures are ~130KB, a blank one ~5KB. */
const MIN_PNG_BYTES = 32_000;
/** Minimum distinct RGB triples in a real Admin capture (measured 2000+; a blank capture has a handful). */
const MIN_DISTINCT_RGB = 100;

const fixturesPresent = existsSync(MANIFEST);

/** @param {string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

test('admin before/after fixtures match the stylesheets they prove', { skip: !fixturesPresent
  && 'no fixtures yet: on a browser machine run npm run admin:shots -- --before=strip-authority' }, () => {
  const headCss = readFileSync(ADMIN_CSS, 'utf8');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.version, 2, 'manifest version 2 (per-run proof with committed DOM fixtures)');
  assert.equal(manifest.backend, 'stubbed-api', 'fixtures come from the stubbed-API capture');
  assert.equal(manifest.stubVersion, STUB_VERSION, 'fixtures come from the current stub rows');
  assert.ok(typeof manifest.renderer === 'string' && manifest.renderer.length > 0, 'renderer is named');
  assert.ok(Array.isArray(manifest.screens) && manifest.screens.length > 0, 'screens are listed');
  assert.equal(
    manifest.stateGroupsCovered,
    stateBadgeGroups(headCss).length,
    'the capture covered every state-colour group of the current stylesheet',
  );
  assert.equal(
    manifest.headStylesSha,
    sha256(headCss),
    'head fixtures prove the current stylesheet, not an older one',
  );

  let baseCss;
  if (manifest.baseRef === 'strip-authority') {
    baseCss = stripAuthority(headCss);
  } else {
    const shown = spawnGit(['show', `${manifest.baseRef}:apps/admin/public/styles.css`]);
    assert.equal(shown.status, 0, `base ref ${manifest.baseRef} must resolve`);
    baseCss = shown.stdout;
  }
  assert.equal(
    manifest.baseStylesSha,
    sha256(baseCss),
    'base fixtures prove the declared base stylesheet',
  );

  const renderedStates = new Set();
  for (const screen of manifest.screens) {
    // Badge counts are recomputed from the committed DOM fixtures — the
    // manifest's numbers are claims, the DOM files are the evidence.
    for (const side of ['before', 'after']) {
      const domKey = side === 'before' ? 'domBefore' : 'domAfter';
      const shaKey = side === 'before' ? 'domShaBefore' : 'domShaAfter';
      const countKey = side === 'before' ? 'badgeNodesBefore' : 'badgeNodesAfter';
      assert.ok(typeof screen[domKey] === 'string' && screen[domKey].length > 0, `${screen.route}: ${side} names its DOM fixture`);
      assert.ok(!screen[domKey].includes('/') && !screen[domKey].includes('\\'), `${screen.route}: DOM fixture stays in dom/`);
      const domFile = join(DOM_DIR, screen[domKey]);
      assert.ok(existsSync(domFile), `${side}/${screen[domKey]} is committed`);
      const dom = readFileSync(domFile, 'utf8');
      assert.equal(sha256(dom), screen[shaKey], `${side}/${screen[domKey]} is the DOM the capture counted`);
      assert.ok(!dom.includes('data-authority'), `${side}/${screen[domKey]} renders no authority element: the before/after identity holds on pixels, not on source scans`);
      const recomputed = countBadgeNodes(dom);
      assert.equal(
        recomputed.total,
        screen[countKey],
        `${screen.route} ${side}: manifest claims ${screen[countKey]} badges, the committed DOM has ${recomputed.total}`,
      );
      assert.ok(
        Number.isInteger(screen[countKey]) && screen[countKey] >= 1,
        `${screen.route}: ${side} rendered badges, not an empty shell`,
      );
      for (const state of recomputed.states) renderedStates.add(state);
    }
    for (const side of ['before', 'after']) {
      const file = join(FIXTURES, side, screen.file);
      assert.ok(existsSync(file), `${side}/${screen.file} is captured`);
      // Non-vacuity on the pixels themselves: a blank or shell-only capture
      // is small and nearly monochrome, a real Admin screen is neither.
      assert.ok(
        statSync(file).size >= MIN_PNG_BYTES,
        `${side}/${screen.file} is ${statSync(file).size}b: too small for a rendered screen`,
      );
      const decoded = decodePng(readFileSync(file));
      assert.equal(decoded.width, screen.width, `${screen.file} width matches the manifest`);
      assert.equal(decoded.height, screen.height, `${screen.file} height matches the manifest`);
      assert.ok(
        countDistinctRgb(decoded.pixels) >= MIN_DISTINCT_RGB,
        `${side}/${screen.file} shows fewer than ${MIN_DISTINCT_RGB} colours: not a rendered screen`,
      );
    }
    const before = readFileSync(join(FIXTURES, 'before', screen.file));
    const after = readFileSync(join(FIXTURES, 'after', screen.file));
    const verdict = diffPng(before, after);
    assert.equal(verdict.equal, true, `${screen.route}: ${verdict.diffPixels} differing pixels`);
    assert.equal(verdict.diffPixels, 0, `${screen.route} must be pixel-identical`);
  }
  // Coverage is recomputed from the committed DOMs, not from the manifest's
  // self-reported stateGroupsCovered number above (that number is checked
  // against the current stylesheet, the union below against the fixtures).
  const uncovered = stateBadgeGroups(headCss)
    .filter((group) => !group.some((state) => renderedStates.has(state)))
    .map((group) => group.join('|'));
  assert.deepEqual(uncovered, [], `committed DOMs must cover every state-colour group, missing: ${uncovered.join(', ')}`);
});
