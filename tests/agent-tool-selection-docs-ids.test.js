// @ts-check

/**
 * The milestone identifiers a prompt may not carry are read from the
 * repository — kept here as a fast standalone file so the fast gate can
 * always run it. The same check still lives in
 * tests/agent-tool-selection-prompts.test.js next to the slow benchmark
 * matrix (deliberately doubled until that file is split: see
 * REPO_WIDE_GUARD_EXCLUSIONS in scripts/ci-touched-tests.js). It scans
 * every `docs/*.md` for milestone identifiers and requires the
 * prompt-leak scanner to trip on each: a hand-typed list
 * would go stale the moment somebody adds a milestone, silently and in
 * the direction that makes the benchmark look better.
 *
 * A repo-wide guard (see REPO_WIDE_GUARDS in scripts/ci-touched-tests.js):
 * its verdict depends on docs files it never relatively imports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAccordoSurface } from '../benchmarks/tool-selection/surface.js';
import { scanPromptForSurfaceLeak } from '../benchmarks/tool-selection/prompt-matrix.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the milestone identifiers a prompt may not carry are read from the repository', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // What the repository actually calls its milestones, gathered independently of the
  // scanner's own source so the two can disagree.
  const inDocs = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.md')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(/\b(?:AX|DX|LA)\d{1,2}\b/g)) inDocs.add(match[0]);
    }
  };
  walk(join(REPO_ROOT, 'docs'));
  assert.ok(inDocs.size >= 20, 'this repository names a lot of milestones; a scan that found few is scanning the wrong thing');

  const missed = [...inDocs].filter((identifier) => (
    scanPromptForSurfaceLeak(`Please look at ${identifier} and tell me what it needs.`, surface).length === 0
  ));
  assert.deepEqual(
    missed, [],
    'a hand-typed list of milestone identifiers goes stale the moment somebody adds a milestone, '
    + 'silently and in the direction that makes the benchmark look better',
  );
});
