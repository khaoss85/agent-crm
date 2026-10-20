// @ts-check
/**
 * BO-F0-01 — evidence lock for the Admin visual proof.
 *
 * `npm run admin:shots` (a browser machine: the executor sandbox cannot run
 * one) writes `tests/fixtures/admin-shots/`: before/after PNGs per screen and
 * a manifest naming the base/head stylesheet shas, the renderer and the
 * command. This test locks that evidence to the code it proves:
 *
 * - the manifest's head sha is the sha256 of the working-tree stylesheet, so
 *   stale fixtures from an older styles.css fail instead of passing;
 * - the base sha is recomputed the same way the script builds it
 *   (`strip-authority` filter, or `git show <ref>` through the isolated
 *   helper), so a hand-edited fixture fails;
 * - every screen pair decodes and pixel-diffs to zero through the same
 *   comparator the script uses.
 *
 * With no fixtures on disk the proof has not been captured yet: the test
 * skips and says how to capture it. A skip is the honest interim state, not
 * a green proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { diffPng, decodePng } from '../scripts/admin-png-diff.js';
import { spawnGit } from './helpers/isolated-git.js';

const root = join(import.meta.dirname, '..');
const FIXTURES = join(root, 'tests', 'fixtures', 'admin-shots');
const MANIFEST = join(FIXTURES, 'manifest.json');
const ADMIN_CSS = join(root, 'apps/admin/public/styles.css');

const fixturesPresent = existsSync(MANIFEST);

/** @param {string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

test('admin before/after fixtures match the stylesheets they prove', { skip: !fixturesPresent
  && 'no fixtures yet: on a browser machine run npm run admin:shots -- --before=strip-authority' }, () => {
  const headCss = readFileSync(ADMIN_CSS, 'utf8');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.version, 1, 'manifest version 1');
  assert.equal(manifest.backend, 'static-nobackend', 'fixtures come from the static-nobackend capture');
  assert.ok(typeof manifest.renderer === 'string' && manifest.renderer.length > 0, 'renderer is named');
  assert.ok(Array.isArray(manifest.screens) && manifest.screens.length > 0, 'screens are listed');
  assert.equal(
    manifest.headStylesSha,
    sha256(headCss),
    'head fixtures prove the current stylesheet, not an older one',
  );

  let baseCss;
  if (manifest.baseRef === 'strip-authority') {
    baseCss = headCss
      .split('\n')
      .filter((line) => !/^\s*\.badge\[data-authority="[^"]+"\] \{[^}]*\}\s*$/.test(line))
      .join('\n');
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

  for (const screen of manifest.screens) {
    for (const side of ['before', 'after']) {
      const file = join(FIXTURES, side, screen.file);
      assert.ok(existsSync(file), `${side}/${screen.file} is captured`);
    }
    const before = readFileSync(join(FIXTURES, 'before', screen.file));
    const after = readFileSync(join(FIXTURES, 'after', screen.file));
    const verdict = diffPng(before, after);
    assert.equal(verdict.equal, true, `${screen.route}: ${verdict.diffPixels} differing pixels`);
    assert.equal(verdict.diffPixels, 0, `${screen.route} must be pixel-identical`);
    const decoded = decodePng(after);
    assert.equal(decoded.width, screen.width, `${screen.file} width matches the manifest`);
    assert.equal(decoded.height, screen.height, `${screen.file} height matches the manifest`);
  }
});
