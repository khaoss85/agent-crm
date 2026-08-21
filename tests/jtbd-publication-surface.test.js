// @ts-check

/**
 * The JTBD catalogue's **publication surface**: the machine contract an agent or
 * a script depends on, as distinct from the catalogue's contents.
 *
 * Both properties asserted here were broken when the catalogue was first
 * published, and neither was caught by the catalogue's own verifier — because
 * `verify_catalog.py` validates the corpus against its manifest and has nothing
 * to say about whether the query tool's output parses or whether a document
 * points at a file that exists.
 *
 * 1. `--json` must emit exactly one JSON document and nothing else on stdout.
 *    The first version printed `# matches=N` after the JSON and printed
 *    concatenated objects for a multi-match query; either alone makes
 *    `json.loads` fail, which is the whole point of the flag.
 * 2. Every tool and catalogue path a *maintained* document names must exist.
 *    `docs/jtbd/README.md` on main once described seven files that had never
 *    been committed. `MASTER.md` is exempt and explicitly so: it is frozen by
 *    the manifest checksum, its four stale names are recorded in the README as
 *    NOT_IMPLEMENTED, and this test asserts that record is present rather than
 *    pretending the references are gone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.cwd();
const jtbd = join(repo, 'docs/jtbd');
const query = join(jtbd, 'tools/query_catalog.py');

const python = (args) => spawnSync('python3', [query, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('a single-result --json query is one parseable JSON array', () => {
  const run = python(['--id', 'ACC-JTBD-CRO-001', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(Array.isArray(parsed), '--json must always emit an array, so a caller never branches on result count');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].jtbd_id, 'ACC-JTBD-CRO-001');
});

test('a multi-result --json query is one array, not concatenated objects', () => {
  const run = python(['--role', 'Sales Manager', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length > 1, 'this role must match several jobs or the test proves nothing');
  for (const record of parsed) assert.equal(record.role, 'Sales Manager');
});

test('the match count goes to stderr, so stdout stays a JSON document', () => {
  const run = python(['--role', 'Sales Manager', '--json']);
  assert.match(run.stderr, /# matches=\d+/, 'the human count must still be emitted, just not on stdout');
  assert.ok(!run.stdout.includes('# matches='), 'a human trailer on stdout is what made --json unparseable');
});

test('a query that matches nothing is still valid JSON', () => {
  const run = python(['--id', 'ACC-JTBD-DOES-NOT-EXIST', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});

test('the reader streams rather than materialising the 4.6 MB corpus', () => {
  const source = readFileSync(query, 'utf8');
  assert.ok(!source.includes('read_text'), 'read_text() holds the whole corpus and a list of every line');
  assert.match(source, /def stream_records/, 'the streaming reader is the documented contract, not an implementation detail');
  assert.match(source, /for line in handle/, 'iterate the handle; do not splitlines() the file');
});

test('every tool and catalogue path a maintained document names exists', () => {
  // MASTER.md is excluded deliberately — see the NOT_IMPLEMENTED test below.
  const maintained = [
    'README.md',
    'AGENTS.md',
    'quality_report.md',
    'coverage/STATUS_CROSSWALK.md',
    'prompts/01_repo_coverage_audit.md',
    'prompts/02_gap_to_roadmap.md',
    'prompts/03_jtbd_to_spec.md',
    'prompts/04_competitor_benchmark.md',
    'prompts/05_simulate_lifecycle.md',
  ];
  const missing = [];
  for (const relative of maintained) {
    const full = join(jtbd, relative);
    if (!existsSync(full)) { missing.push(`${relative} (the document itself)`); continue; }
    const text = readFileSync(full, 'utf8');
    // A name introduced as absent is a record, not a reference to resolve. The
    // exemption is paragraph-scoped, not line-scoped: prose that explains why
    // four tools do not exist names them a sentence or two after the marker.
    const paragraphs = text.split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const exempt = /NOT_IMPLEMENTED|FUTURE:|do not exist|does not exist/.test(paragraph);
      if (exempt) continue;
      for (const [, named] of paragraph.matchAll(/`((?:tools|catalog|schemas|coverage)\/[A-Za-z0-9_.-]+)`/g)) {
        if (!existsSync(join(jtbd, named))) missing.push(`${relative} → ${named}`);
      }
    }
  }
  assert.deepEqual(missing, [], `a maintained document names a path that is not there:\n${missing.join('\n')}`);
});

test("MASTER.md's frozen stale names are recorded rather than quietly carried", () => {
  const master = readFileSync(join(jtbd, 'MASTER.md'), 'utf8');
  const stale = ['tools/validate_catalog.py', 'tools/init_coverage.py', 'tools/score_roadmap.py', 'data/jtbd.jsonl'];
  const present = stale.filter((name) => master.includes(name));
  assert.ok(present.length > 0, 'if MASTER.md no longer names these, delete this test and the README paragraph together');

  const readme = readFileSync(join(jtbd, 'README.md'), 'utf8');
  assert.match(readme, /NOT_IMPLEMENTED/, 'the README must say these names do not resolve');
  for (const name of present) {
    assert.ok(readme.includes(name), `README must name ${name} as absent — an unlisted stale reference is the defect this catalogue was published to close`);
  }
});

test('the catalogue is byte-identical to its manifest', () => {
  const run = spawnSync('python3', [join(jtbd, 'tools/verify_catalog.py')], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /VALIDATION_OK/);
  assert.match(run.stdout, /personas=30 capabilities=225 jtbd=600 e2e_scenarios=10/);
});
