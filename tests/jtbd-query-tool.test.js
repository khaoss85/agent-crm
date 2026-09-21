// @ts-check
/**
 * `docs/jtbd/tools/query_catalog.py`, and the three defects it shipped with.
 *
 * The tool is Python because it is the agent-facing slice tool and always was. This
 * repository's CI does not otherwise depend on a Python interpreter, so every case here
 * **skips** rather than fails when `python3` is absent — and says so, which is the difference
 * between a test that is not applicable and a test that quietly stopped testing.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'docs/jtbd/tools/query_catalog.py';

const python = (() => {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
})();

const run = (...args) => spawnSync(/** @type {string} */ (python), [TOOL, ...args], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});

const options = { skip: python ? false : 'python3 is not available in this environment' };

test('--json parses: the match count is on stderr, never in the payload', options, () => {
  const result = run('--id', 'ACC-JTBD-CRO-001', '--json');
  assert.equal(result.status, 0, result.stderr);
  // The original printed `# matches=N` on stdout unconditionally, so `--json | jq` failed
  // with "Extra data" on every single query, including this one.
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].jtbd_id, 'ACC-JTBD-CRO-001');
  assert.ok(result.stderr.includes('# matches=1'));
  assert.ok(!result.stdout.includes('# matches='));
});

test('--json with more than one match is one array, not concatenated objects', options, () => {
  const result = run('--persona', 'PER-EXEC-CRO', '--json');
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 20);
  assert.ok(parsed.every((record) => record.jtbd_id.startsWith('ACC-JTBD-CRO-')));
});

test('the catalogue is streamed, not read whole', options, () => {
  const source = spawnSync('grep', ['-n', 'read_text()', TOOL], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(source.status, 0, 'query_catalog.py must not read_text() the 4.6 MB catalogue');
  const streamed = spawnSync('grep', ['-c', 'for line in handle', TOOL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(streamed.status, 0);
});

test('the overlay filters answer from the overlays', options, () => {
  const result = run('--coverage-status', 'partially supported', '--json');
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.length > 0);
  for (const record of parsed) {
    assert.equal(record.coverage.status, 'partially supported');
    assert.ok(record.coverage.evidence.length > 0);
    assert.ok(record.coverage.limitations.length > 0);
  }
});

test('no commercial catalogue field is ever printed', options, () => {
  const result = run('--id', 'ACC-JTBD-DEAL-DESK-008', '--json');
  assert.equal(result.status, 0, result.stderr);
  const [record] = JSON.parse(result.stdout);
  // `roadmap` holds business_value_1_5 and friends; `competitive_benchmark` holds the
  // differentiation hypothesis. Both are commercial under REPOSITORY_BOUNDARY.md §3.
  assert.ok(!('roadmap' in record));
  assert.ok(!('competitive_benchmark' in record));
  assert.ok(!result.stdout.includes('business_value_1_5'));
  assert.ok(!result.stdout.includes('differentiation_hypothesis'));
});

test('an overlay filter without overlays says so instead of answering wrongly', options, () => {
  const result = spawnSync(/** @type {string} */ (python), ['-c', [
    'import importlib.util, pathlib, sys',
    'spec = importlib.util.spec_from_file_location("qc", "docs/jtbd/tools/query_catalog.py")',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'mod.COVERAGE = pathlib.Path("does/not/exist.jsonl")',
    'mod.ROADMAP = pathlib.Path("does/not/exist.jsonl")',
    'sys.exit(mod.main(["--pillar", "commercial"]))',
  ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes('jtbd-gate.js --write'));
});

test('--count and --limit bound the work', options, () => {
  const counted = run('--persona', 'PER-EXEC-CRO', '--count');
  assert.equal(counted.stdout.trim(), '20');
  const limited = run('--persona', 'PER-EXEC-CRO', '--limit', '3');
  assert.equal(limited.stdout.trim().split('\n').length, 3);
});
