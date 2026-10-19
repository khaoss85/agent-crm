// @ts-check

/**
 * Framework-neutrality guard (backlog:4c63c9dc): the framework ships no
 * customer name. `packages/` must not name one; `tests/` fixtures may
 * (the single declared exception).
 *
 * A repo-wide guard (see REPO_WIDE_GUARDS in
 * `scripts/ci-touched-tests.js`): its verdict depends on repository files
 * it never relatively imports, so it runs on every non-empty diff. The
 * walk itself lives in `scripts/framework-neutrality.js` (reused by the
 * CLI there, never copied); this file holds the verdict and the proof
 * that the matcher fires.
 *
 * When this test fails, the fix is never to widen an allow-list. It is
 * to answer, in the PR: does `packages/` need this customer name? It
 * does not — rename to the neutral wording (the linked space mailbox,
 * `projects/example/...`) and keep the name in the test fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanClientNameViolations } from '../scripts/framework-neutrality.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('no customer name in packages/', () => {
  const violations = scanClientNameViolations(join(repoRoot, 'packages'));
  assert.deepEqual(
    violations,
    [],
    `customer name(s) in packages/: ${violations.map((v) => `${v.file}:${v.line}`).join(', ')}`,
  );
});

test('the guard fires on the known customer spellings', () => {
  const root = mkdtempSync(join(tmpdir(), 'neutrality-'));
  try {
    mkdirSync(join(root, 'channels', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'channels', 'src', 'gmail.js'),
      ' * The Presti Group mailbox on the shared channel base.\n'
      + "  subscription = 'projects/presti/subscriptions/accordo-gmail',\n",
    );
    mkdirSync(join(root, 'core', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'core', 'src', 'schema-migrations-ledger.js'),
      ' * recorded by presti-group) and the widened one\n'
      + 'const binding = resolvePrestiGroup();\n',
    );
    const violations = scanClientNameViolations(root);
    assert.equal(violations.length, 4, JSON.stringify(violations));
    assert.ok(
      violations.every((violation) => violation.client === 'Presti Group'),
      JSON.stringify(violations),
    );
    const locations = violations.map((violation) => `${violation.file}:${violation.line}`);
    assert.ok(locations.some((location) => location.endsWith('gmail.js:1')), locations.join(', '));
    assert.ok(locations.some((location) => location.endsWith('gmail.js:2')), locations.join(', '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the guard stays quiet on neutral wording and lookalike Italian words', () => {
  const root = mkdtempSync(join(tmpdir(), 'neutrality-'));
  try {
    mkdirSync(join(root, 'channels', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'channels', 'src', 'gmail.js'),
      " * The space's linked mailbox on the shared channel base.\n"
      + "  subscription = 'projects/example/subscriptions/accordo-gmail',\n"
      + ' * recorded by the first production database.\n'
      + ' * Le prestazioni del pacchetto e il prestito restano neutrali.\n'
      + ' * prestigio and prestigious name no customer.\n',
    );
    assert.deepEqual(scanClientNameViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
