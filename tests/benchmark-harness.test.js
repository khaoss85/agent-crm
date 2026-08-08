// @ts-check

/**
 * The two halves of the benchmark harness that a human drives: preparing a run, and recording what
 * the human did during it.
 *
 * Both are small, and both are the only thing standing between a published number and a number
 * nobody can reproduce. So the tests here are mostly about the refusals — the cases where the
 * right behaviour is to produce nothing at all.
 *
 * `prepare` shells out to git, so these tests build a real throwaway repository rather than
 * stubbing it. A fake git would prove the fake works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareRun, parseArgs, frameworkRevision, RUN_RECORD_CONTRACT } from '../benchmarks/harness/prepare.js';
import { appendEntry, readRecord, summarise, REASON_MAX } from '../benchmarks/harness/record.js';
import { scoreRun } from '../benchmarks/harness/score.js';

/**
 * A real git repository with one commit, so `git rev-parse` and `git status` mean something, plus
 * a runs directory *outside* it — which is where runs have to live, and which prepare enforces.
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-bench-repo-'));
  const runs = mkdtempSync(join(tmpdir(), 'accordo-bench-runs-'));
  const git = (/** @type {string[]} */ args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git(['init', '--quiet']);
  git(['config', 'user.email', 'benchmark@example.test']);
  git(['config', 'user.name', 'Benchmark']);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return { root, runs, git, cleanup: () => [root, runs].forEach((path) => rmSync(path, { recursive: true, force: true })) };
}

/** @param {{root: string, runs: string}} repo */
const options = (repo, extra = {}) => ({
  promptId: 'P02',
  runDir: join(repo.runs, 'one'),
  agentProduct: 'test-agent',
  modelVersion: 'test-model',
  attempt: 1,
  allowDirty: false,
  repoRoot: repo.root,
  ...extra,
});

test('a prepared run carries the provenance a published number needs', (t) => {
  const repo = makeRepo();
  const { root } = repo;
  t.after(repo.cleanup);

  const { record, runDir, briefPath, projectDir } = prepareRun(options(repo));

  assert.equal(record.runRecordContract, RUN_RECORD_CONTRACT);
  assert.equal(record.promptId, 'P02');
  assert.equal(record.edition, 'L');
  assert.equal(record.gateSet, 'G1-G4');
  assert.equal(record.agentProduct, 'test-agent');
  assert.equal(record.modelVersion, 'test-model');
  assert.equal(record.treeDirty, false);
  assert.deepEqual(record.interventions, []);
  assert.deepEqual(record.approvals, []);
  assert.match(record.note, /operator-attested/, 'the record states G1 is attested, so no reader has to infer it');
  assert.match(record.note, /G5 and G6/, 'and states the Edition D blocker in the run itself');

  // The id is derived from prompt, commit and attempt, so two operators name the same run the same.
  const { sha } = frameworkRevision(root);
  assert.equal(record.runId, `P02-${sha}-1`);

  assert.ok(existsSync(join(runDir, 'run.json')));
  assert.ok(existsSync(projectDir), 'the agent needs somewhere to build');

  const brief = readFileSync(briefPath, 'utf8');
  assert.match(brief, /€25,000/, 'the brief is written verbatim');
  assert.doesNotMatch(
    brief.split('---')[0],
    /boundary tests/,
    'the expected-output hint must not be above the fold, where it would be pasted with the brief',
  );
});

test('prepare refuses a dirty tree, and --allow-dirty records the run as unreproducible', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  writeFileSync(join(repo.root, 'uncommitted.txt'), 'changed\n');

  assert.throws(
    () => prepareRun(options(repo)),
    /uncommitted changes/,
    'a SHA that does not describe the tree is worse than no run',
  );

  const { record } = prepareRun(options(repo, { allowDirty: true, runDir: join(repo.runs, 'dirty') }));
  assert.equal(record.treeDirty, true, 'the escape hatch must leave a mark the report carries');
});

test('prepare refuses everything a comparison needs and cannot recover', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);

  assert.throws(() => prepareRun(options(repo, { agentProduct: undefined })), /--agent and --model are required/);
  assert.throws(() => prepareRun(options(repo, { modelVersion: undefined })), /--agent and --model are required/);
  assert.throws(() => prepareRun(options(repo, { promptId: 'P99' })), /unknown prompt "P99"/);
  assert.throws(() => prepareRun(options(repo, { promptId: 'P99' })), /P01/, 'the refusal lists the ids that do exist');
  assert.throws(() => prepareRun(options(repo, { attempt: 0 })), /--attempt must be an integer/);
  assert.throws(() => prepareRun(options(repo, { promptId: undefined })), /usage:/);
});

test('prepare refuses to put a run inside the framework checkout', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);

  for (const inside of [join(repo.root, 'runs', 'one'), join(repo.root, 'a', '..', 'b'), repo.root]) {
    assert.throws(
      () => prepareRun(options(repo, { runDir: inside })),
      /inside the framework checkout/,
      `${inside} should have been refused`,
    );
  }
  // And the refusal creates nothing on the way out.
  assert.equal(existsSync(join(repo.root, 'runs')), false);
});

test('prepare never writes into a directory that already holds a run', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);

  const first = prepareRun(options(repo));
  assert.throws(
    () => prepareRun(options(repo)),
    /already exists and is not empty/,
    'two attempts in one directory score as neither',
  );
  // The first run is untouched by the refusal.
  assert.equal(readRecord(first.runDir).runId, first.record.runId);
});

test('the argument parser keeps flags and positionals apart, and rejects a flag with no value', () => {
  const parsed = parseArgs(['P02', '/tmp/run', '--agent', 'claude-code', '--model', 'opus', '--attempt', '3', '--allow-dirty']);
  assert.equal(parsed.promptId, 'P02');
  assert.equal(parsed.runDir, '/tmp/run');
  assert.equal(parsed.agentProduct, 'claude-code');
  assert.equal(parsed.modelVersion, 'opus');
  assert.equal(parsed.attempt, 3);
  assert.equal(parsed.allowDirty, true);

  assert.throws(() => parseArgs(['P02', '/tmp/run', '--agent']), /--agent needs a value/);
  assert.throws(() => parseArgs(['P02', '/tmp/run', '--agent', '--model']), /--agent needs a value/);
});

test('recording an intervention costs G1, and recording an approval costs nothing', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const { runDir } = prepareRun(options(repo));

  const clock = () => '2026-08-08T09:00:00.000Z';

  appendEntry(runDir, 'approval', 'granted the permission prompt for npm install', clock);
  assert.equal(scoreRun(runDir).gates.find((/** @type {any} */ g) => g.id === 'G1').outcome, 'pass');

  const { entry } = appendEntry(runDir, 'intervention', 'fixed the migration by hand', clock);
  assert.equal(entry.at, '2026-08-08T09:00:00.000Z');

  const g1 = scoreRun(runDir).gates.find((/** @type {any} */ gate) => gate.id === 'G1');
  assert.equal(g1.outcome, 'fail');
  assert.equal(g1.earned, 0);
  assert.match(g1.why, /fixed the migration by hand/, 'the score names the intervention that cost the points');

  const record = readRecord(runDir);
  assert.equal(record.approvals.length, 1, 'approvals are recorded, and are not interventions');
  assert.equal(record.interventions.length, 1);
  assert.match(summarise(record), /G1 failed/);
});

test('the record is append-only: a second entry never displaces the first', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const { runDir } = prepareRun(options(repo));

  appendEntry(runDir, 'intervention', 'first', () => '2026-08-08T09:00:00.000Z');
  appendEntry(runDir, 'intervention', 'second', () => '2026-08-08T10:00:00.000Z');

  const record = readRecord(runDir);
  assert.deepEqual(record.interventions.map((/** @type {any} */ item) => item.reason), ['first', 'second']);
});

test('record refuses an entry that is not evidence', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const { runDir } = prepareRun(options(repo));

  assert.throws(() => appendEntry(runDir, 'fix', 'something'), /unknown kind "fix"/);
  assert.throws(() => appendEntry(runDir, undefined, 'something'), /unknown kind/);
  assert.throws(() => appendEntry(runDir, 'intervention', '   '), /a reason is required/);
  assert.throws(() => appendEntry(runDir, 'intervention', 'x'.repeat(REASON_MAX + 1)), /the limit is 500/);
  assert.throws(() => appendEntry(runDir, 'intervention', 'log\u0000dump'), /control characters/);

  // A refused entry writes nothing at all.
  assert.deepEqual(readRecord(runDir).interventions, []);
});

test('record refuses a broken record rather than overwriting the only copy', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'accordo-bench-'));
  const broken = mkdtempSync(join(tmpdir(), 'accordo-bench-'));
  const foreign = mkdtempSync(join(tmpdir(), 'accordo-bench-'));
  t.after(() => [empty, broken, foreign].forEach((path) => rmSync(path, { recursive: true, force: true })));

  assert.throws(() => readRecord(empty), /no run.json/);
  assert.throws(() => readRecord(empty), /prepare\.js/, 'the refusal says how to get one');

  writeFileSync(join(broken, 'run.json'), '{ not json');
  assert.throws(() => appendEntry(broken, 'intervention', 'anything'), /will not be overwritten/);
  assert.equal(readFileSync(join(broken, 'run.json'), 'utf8'), '{ not json', 'the broken file is left exactly as it was');

  writeFileSync(join(foreign, 'run.json'), JSON.stringify({ runId: 'hand-written' }));
  assert.throws(() => appendEntry(foreign, 'approval', 'anything'), /not written by prepare\.js/);
});

test('a prepared run scores end to end, and an empty project fails rather than asking a question', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const { runDir } = prepareRun(options(repo));

  const result = scoreRun(runDir);
  assert.equal(result.promptId, 'P02');
  assert.equal(result.gates.find((/** @type {any} */ gate) => gate.id === 'G1').outcome, 'pass');
  assert.equal(result.gates.find((/** @type {any} */ gate) => gate.id === 'G2').outcome, 'fail');
  assert.equal(result.gates.find((/** @type {any} */ gate) => gate.id === 'G4').outcome, 'fail');
  assert.equal(result.points, 25, 'an untouched run directory earns G1 alone');
  assert.equal(result.promptPassed, false);
});

test('the CLIs refuse from the command line with a non-zero exit, not a stack trace', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const runDir = join(repo.runs, 'cli');

  const missingIdentity = spawnSync(
    process.execPath,
    ['--no-warnings', join(process.cwd(), 'benchmarks/harness/prepare.js'), 'P02', runDir, '--repo', repo.root],
    { encoding: 'utf8' },
  );
  assert.equal(missingIdentity.status, 2);
  assert.match(missingIdentity.stderr, /--agent and --model are required/);
  assert.doesNotMatch(missingIdentity.stderr, /at Object|at Module/, 'a refusal is a message, not a stack');
  assert.equal(existsSync(runDir), false, 'a refused prepare leaves no directory behind');

  const prepared = spawnSync(
    process.execPath,
    ['--no-warnings', join(process.cwd(), 'benchmarks/harness/prepare.js'), 'P02', runDir,
      '--agent', 'cli-agent', '--model', 'cli-model', '--repo', repo.root],
    { encoding: 'utf8' },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stderr, /Paste brief\.md verbatim/);

  const recorded = spawnSync(
    process.execPath,
    ['--no-warnings', join(process.cwd(), 'benchmarks/harness/record.js'), runDir, 'intervention', 'edited a file by hand'],
    { encoding: 'utf8' },
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stderr, /G1 is now failed/, 'the cost is stated when it is paid, not at scoring time');

  const rejected = spawnSync(
    process.execPath,
    ['--no-warnings', join(process.cwd(), 'benchmarks/harness/record.js'), runDir, 'oops', 'anything'],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /unknown kind "oops"/);
});

test('every prompt in the set can be prepared', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);

  const prompts = JSON.parse(readFileSync(join(process.cwd(), 'benchmarks/harness/prompts.json'), 'utf8')).prompts;
  assert.ok(prompts.length >= 22, 'the protocol set is 22 prompts');

  for (const prompt of prompts) {
    const runDir = join(repo.runs, prompt.id);
    const { record } = prepareRun(options(repo, { promptId: prompt.id, runDir }));
    assert.equal(record.promptId, prompt.id);
    assert.ok(record.category, `${prompt.id} must carry its category into the record`);
    assert.match(readFileSync(join(runDir, 'brief.md'), 'utf8'), /Paste the paragraph above verbatim/);
  }
});
