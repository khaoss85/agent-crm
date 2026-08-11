import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, MAX_CAPTURED_OUTPUT, MAX_NESTED_DEPTH, MAX_NESTED_NODES, MAX_NESTED_TEXT,
  PROJECT_VERIFICATION_CONTRACT, STATUSES, VERIFY_DEPTH_ENV, boundNested, check, declaredScripts,
  missingScriptTargets, projectVerifyCommand, redact, runStep, semanticFingerprint, summarize,
} from '../packages/cli/src/project-verify-command.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * A deterministic baseline for the recursion marker.
 *
 * `projectVerifyCommand` reads `ACCORDO_PROJECT_VERIFY_DEPTH` from the ambient
 * environment, and this suite exercises that command directly — so running
 * `accordo project verify` **on this repository** set the marker on the child
 * that runs `npm run verify`, every test here saw itself as nested, and fourteen
 * of them failed. The command was working exactly as designed; the tests were
 * reading the environment of whoever invoked them. A unit test that cannot be
 * run from inside the command it tests is not a property of the command.
 *
 * The recursion tests set the marker deliberately and restore it themselves.
 */
delete process.env[VERIFY_DEPTH_ENV];

/**
 * DX5 answers "can you prove this project is healthy enough to hand back?", so
 * the tests are about what the report *refuses* to claim as much as what it
 * proves. The expensive delegates — the doctor, AX1, the project's own suites —
 * are injected here: this file is about DX5's orchestration and refusal shape,
 * and re-running a four-minute suite inside a unit test would prove nothing
 * except patience.
 */

/** A minimal project skeleton DX5 recognizes. */
function project(t, { scripts = { verify: 'exit 0', smoke: 'exit 0' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dx5-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/domains/generated'), { recursive: true });
  mkdirSync(join(root, 'packages/cli/bin'), { recursive: true });
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.scripts = scripts;
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');
  return root;
}

/** A doctor stub. */
const doctorOk = (extra = {}) => async () => ({
  exitCode: 0,
  report: {
    status: 'passed', fingerprint: 'doctor-fp',
    project: { packagesComposed: [] },
    checks: [], ...extra,
  },
});
const inspectOk = async () => ({
  exitCode: 0,
  report: { inspectionFingerprint: 'inspect-fp', packages: [], problems: [] },
});
/** A step stub that always succeeds, recording what it was asked to run. */
function recordingStep(calls, result = { ok: true, code: 0, output: '', durationMs: 5, truncated: false, timedOut: false, spawnError: null }) {
  return async (options) => { calls.push(options); return result; };
}
const noGit = () => null;
const cleanGit = () => '';

test('a healthy project verifies, and says what it did not prove', async (t) => {
  const root = project(t);
  const calls = [];
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(calls), git: cleanGit,
  });

  assert.equal(exitCode, 0);
  assert.equal(report.status, 'passed');
  assert.equal(report.projectVerificationContract, PROJECT_VERIFICATION_CONTRACT);
  assert.equal(report.inspectionFingerprint, 'inspect-fp');
  // The declared scripts ran; nothing else did.
  assert.deepEqual(calls.map((c) => c.args.join(' ')).sort(), ['run smoke --silent', 'run verify --silent']);

  // The point of the whole command: a green result still names its own gaps.
  const codes = report.limitations.map((l) => l.code);
  for (const required of ['BROWSER_EVIDENCE_NOT_AUTOMATED', 'SCENARIO_EVIDENCE_NOT_RUN', 'IMPLEMENTATION_EVIDENCE_NOT_MAPPED']) {
    assert.ok(codes.includes(required), `${required} must be published even on a pass`);
  }
});

test('a doctor failure blocks verification instead of producing a second, worse failure', async (t) => {
  const root = project(t);
  const calls = [];
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ checks: [{ id: 'modules.state', status: 'failed', reason: 'hand-edited' }] }),
    inspect: inspectOk,
    step: recordingStep(calls),
    git: cleanGit,
  });

  assert.equal(exitCode, 1);
  assert.equal(report.status, 'failed');
  assert.equal(calls.length, 0, 'no expensive step runs after a structural failure');
  assert.ok(report.problems.some((p) => p.code === 'PREFLIGHT_FAILED'));
  const byCode = Object.fromEntries(report.checks.map((c) => [c.code, c]));
  assert.equal(byCode['structure.doctor'].status, 'failed');
  assert.equal(byCode['suite.verify'].status, 'skipped', 'a skipped suite is not a passed suite');
  assert.equal(byCode['suite.verify'].reason, 'PREFLIGHT_FAILED');
  assert.equal(byCode['application.inspect'].status, 'skipped');
});

test('a doctor warning is carried, not promoted into a failure', async (t) => {
  const root = project(t);
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ checks: [{ id: 'skills.mirror-coverage', status: 'warning', reason: '6 skill(s) in one mirror only' }] }),
    inspect: inspectOk, step: recordingStep([]), git: cleanGit,
  });
  assert.equal(exitCode, 0, 'a warning must not fail verification');
  assert.equal(report.status, 'warning');
  const carried = report.checks.find((c) => c.code === 'structure.carried.skills.mirror-coverage');
  assert.equal(carried.status, 'warning');
  assert.match(carried.evidence, /carried from project doctor/);
});

test('an undeclared script is not applicable, and is never guessed', async (t) => {
  const root = project(t, { scripts: { build: 'exit 0' } });
  const calls = [];
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(calls), git: cleanGit,
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 0, 'DX5 must not invent npm test');
  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'not_applicable');
  assert.equal(verify.reason, 'SCRIPT_NOT_DECLARED');
  assert.deepEqual(report.project.declaredScripts, []);
});

test('a failing suite fails the run, with a bounded reason and no log dump', async (t) => {
  const root = project(t);
  const flood = `${'x'.repeat(500_000)}\nAssertionError: expected 1 to equal 2`;
  const step = async () => ({ ok: false, code: 1, output: flood, durationMs: 10, truncated: true, timedOut: false, spawnError: null });
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step, git: cleanGit,
  });
  assert.equal(exitCode, 1);
  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'failed');
  assert.ok(verify.reason.length < 600, 'the reason is a diagnostic, not the log');
  assert.match(verify.reason, /exit 1/);
  assert.match(verify.reason, /output truncated/);
  assert.ok(JSON.stringify(report).length < 100_000, 'a log flood must not reach the report');
});

test('a timed-out step is reported as stopped, not as a mysterious failure', async (t) => {
  const root = project(t);
  const step = async () => ({ ok: false, code: null, output: '', durationMs: 900_000, truncated: false, timedOut: true, spawnError: null });
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step, git: cleanGit,
  });
  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'failed');
  assert.match(verify.reason, /timed out/);
  assert.match(verify.reason, /process group was stopped/);
});

test('the report is deterministic across directories, and duration never moves it', async (t) => {
  const rootA = project(t);
  const rootB = project(t);
  const fast = recordingStep([], { ok: true, code: 0, output: '', durationMs: 1, truncated: false, timedOut: false, spawnError: null });
  const slow = recordingStep([], { ok: true, code: 0, output: '', durationMs: 987_654, truncated: false, timedOut: false, spawnError: null });
  const a = await projectVerifyCommand({ rootDir: rootA, doctor: doctorOk(), inspect: inspectOk, step: fast, git: cleanGit });
  const b = await projectVerifyCommand({ rootDir: rootB, doctor: doctorOk(), inspect: inspectOk, step: slow, git: cleanGit });

  assert.equal(a.report.fingerprint, b.report.fingerprint,
    'two identical projects verified in different directories at different speeds decide the same thing');
  // And the durations really did differ, so the equality above means something.
  const aDur = a.report.checks.find((c) => c.code === 'suite.verify').durationMs;
  const bDur = b.report.checks.find((c) => c.code === 'suite.verify').durationMs;
  assert.notEqual(aDur, bDur);
});

test('a status change moves the fingerprint', async (t) => {
  const root = project(t);
  const pass = await projectVerifyCommand({ rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]), git: cleanGit });
  const failStep = async () => ({ ok: false, code: 1, output: 'boom', durationMs: 1, truncated: false, timedOut: false, spawnError: null });
  const fail = await projectVerifyCommand({ rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: failStep, git: cleanGit });
  assert.notEqual(pass.report.fingerprint, fail.report.fingerprint);
});

/**
 * The worktree is sampled twice, so a git stub is a *script* of samples: what
 * the tree looked like before the run, then after it.
 */
function gitSamples(...samples) {
  let call = 0;
  return () => samples[Math.min(call++, samples.length - 1)];
}

test('a worktree the run itself dirtied is reported and never repaired', async (t) => {
  const root = project(t);
  const dirtiedByTheRun = gitSamples('', 'packages/core/src/schema.js\ndata/scratch.json\n');
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]), git: dirtiedByTheRun,
  });
  assert.equal(exitCode, 0, 'a dirty tree is a warning a human must see, not a hard failure');
  assert.equal(report.status, 'warning');
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'warning');
  assert.match(worktree.reason, /schema\.js/);
  assert.ok(report.problems.some((p) => p.code === 'WORKTREE_DIRTY_AFTER_VERIFY'));
  assert.match(report.problems.find((p) => p.code === 'WORKTREE_DIRTY_AFTER_VERIFY').message,
    /Nothing was reset, stashed or hidden/);
});

/**
 * REGRESSION — a pre-existing dirty tree was accused of being dirtied by the
 * run. DX5 sampled the worktree only *after* verifying, so the state a coding
 * agent normally hands over in (uncommitted edits) was indistinguishable from a
 * suite writing into source. The whole check exists to catch the second, and it
 * fired on every instance of the first.
 */
test('a tree that was already dirty before the run is not blamed on the run', async (t) => {
  const root = project(t);
  const alreadyDirty = 'packages/core/src/schema.js\n';
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]),
    git: gitSamples(alreadyDirty, alreadyDirty),
  });
  assert.equal(exitCode, 0);
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'passed', 'verification changed nothing, so it is not accused of doing so');
  assert.equal(worktree.reason, 'DIRTY_BEFORE_VERIFY', 'but the reader is still told the tree was not clean');
  assert.equal(report.status, 'passed');
  assert.ok(!report.problems.some((p) => p.code === 'WORKTREE_DIRTY_AFTER_VERIFY'));
  // The two sets are published, so "who dirtied this" is machine-answerable.
  const evidence = report.evidence.find((e) => e.kind === 'worktree');
  assert.deepEqual(evidence.dirtyBeforeVerify, ['packages/core/src/schema.js']);
  assert.deepEqual(evidence.changedByVerify, []);
});

/**
 * REGRESSION — only paths the run introduced are blamed. With a single
 * post-run sample, a tree with one operator edit and one suite-written file
 * reported both, and a reader had no way to tell which was which.
 */
test('when a run dirties an already-dirty tree, only the new path is blamed', async (t) => {
  const root = project(t);
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]),
    git: gitSamples('src/edited-by-the-operator.js\n', 'src/edited-by-the-operator.js\nsrc/written-by-the-suite.js\n'),
  });
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'warning');
  assert.equal(worktree.reason, 'src/written-by-the-suite.js', 'the operator\'s own edit is not evidence against the run');
  const evidence = report.evidence.find((e) => e.kind === 'worktree');
  assert.deepEqual(evidence.changedByVerify, ['src/written-by-the-suite.js']);
});

/**
 * REGRESSION — the "nothing was reset, stashed or hidden" promise had no
 * detector. `git diff --name-only HEAD` after the fact cannot see that a
 * delegate threw away an operator's uncommitted work: the tree simply looks
 * clean, which read as a pass.
 */
test('a delegate that discards uncommitted work is caught, not read as a clean pass', async (t) => {
  const root = project(t);
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]),
    git: gitSamples('src/precious.js\n', ''),
  });
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'warning', 'a tree that got *cleaner* during a verification is not a pass');
  assert.ok(report.problems.some((p) => p.code === 'WORKTREE_REPAIRED_BY_VERIFY'));
  assert.match(report.problems.find((p) => p.code === 'WORKTREE_REPAIRED_BY_VERIFY').message,
    /discarded uncommitted work/);
  assert.deepEqual(report.evidence.find((e) => e.kind === 'worktree').revertedByVerify, ['src/precious.js']);
});

test('a project that is not a git checkout is not applicable, never a failure', async (t) => {
  const root = project(t);
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]), git: noGit,
  });
  assert.equal(exitCode, 0);
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'not_applicable');
  assert.equal(worktree.reason, 'NOT_A_GIT_CHECKOUT');
});

test('an unreadable project exits 2 without a report', async () => {
  const missing = await projectVerifyCommand({ rootDir: '/nope-not-here-dx5' });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.report, null);
});

test('an unreadable doctor makes the whole run exit 2, not a green pass', async (t) => {
  const root = project(t);
  const broken = async () => ({ exitCode: 2, report: null });
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: broken, inspect: inspectOk, step: recordingStep([]), git: cleanGit,
  });
  assert.equal(exitCode, 2, 'infrastructure that cannot answer is not evidence that nothing is wrong');
  assert.equal(report, null);
});

test('an application with problems fails, naming the codes', async (t) => {
  const root = project(t);
  const inspectBad = async () => ({
    exitCode: 1,
    report: { inspectionFingerprint: 'fp', packages: [], problems: [{ code: 'CAPABILITY_UNRESOLVED' }, { code: 'PACKAGE_INVALID' }] },
  });
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectBad, step: recordingStep([]), git: cleanGit,
  });
  assert.equal(exitCode, 1);
  const app = report.checks.find((c) => c.code === 'application.inspect');
  assert.equal(app.status, 'failed');
  assert.equal(app.reason, 'CAPABILITY_UNRESOLVED, PACKAGE_INVALID');
});

test('the machine-readable contract is stable and its vocabulary is closed', async (t) => {
  const root = project(t);
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]), git: cleanGit,
  });
  assert.deepEqual(Object.keys(report).sort(), [
    'checks', 'command', 'counts', 'evidence', 'fingerprint', 'inspectionFingerprint',
    'limitations', 'problems', 'project', 'projectVerificationContract', 'status',
  ]);
  for (const entry of report.checks) {
    assert.ok(STATUSES.includes(entry.status), `${entry.status} is not a declared status`);
    assert.ok(CATEGORIES.includes(entry.category), `${entry.category} is not a declared category`);
    assert.deepEqual(Object.keys(entry).sort(),
      ['authority', 'category', 'code', 'durationMs', 'evidence', 'reason', 'required', 'status']);
  }
  assert.ok(['passed', 'warning', 'failed'].includes(report.status));
  // An unknown category or status is a programming error, refused at build time.
  assert.throws(() => check({ code: 'x', category: 'nope', status: 'passed', authority: 'a' }), /unknown category/);
  assert.throws(() => check({ code: 'x', category: 'suite', status: 'maybe', authority: 'a' }), /unknown status/);
});

test('no absolute path or secret-shaped value reaches the report', async (t) => {
  const root = project(t);
  const leaky = async () => ({
    ok: false, code: 1, durationMs: 1, truncated: false, timedOut: false, spawnError: null,
    output: `failed in ${root}/packages/core/src/thing.js\nAPI_TOKEN=super-secret-value\nat /usr/lib/node_modules/x/y.js`,
  });
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: leaky, git: cleanGit,
  });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /super-secret-value/, 'a secret-shaped assignment is redacted');
  assert.ok(!text.includes(root), 'the project root is never echoed as an absolute path');
  assert.doesNotMatch(text, /\/usr\/lib\/node_modules/);
});

test('redact and summarize are bounded on their own', () => {
  assert.match(redact('DATABASE_PASSWORD=hunter2 rest', '/x'), /DATABASE_PASSWORD=<redacted>/);
  // A project-relative path must SURVIVE: it is the useful half of a reason.
  assert.equal(redact('/x/a/b', '/x'), './a/b');
  // An absolute path that is not the project root must not.
  assert.equal(redact('at /usr/lib/node_modules/x/y.js', '/x'), 'at <path>');
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  assert.ok(summarize(long, '/x').length <= 400);
});

test('runStep really bounds a hang, and stops the process group', async () => {
  // The one place the real child-process path is exercised: a script that never
  // returns must be stopped rather than waited for.
  const started = Date.now();
  const result = await runStep({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000); console.log("started")'],
    cwd: process.cwd(),
    timeoutMs: 1200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 20_000, 'the timeout must actually fire');
});

/**
 * REGRESSION — the step settled on `close`, which is the *streams* closing, not
 * the process exiting. Any suite that leaves a background process behind — a
 * dev server, a watcher, a leaked worker — has a grandchild holding the
 * inherited stdout pipe open, so `close` never came and the step burned its
 * whole fifteen-minute timeout before reporting a **false** timeout failure for
 * a suite that had already exited 0. `child-report.js` documents finding and
 * fixing exactly this in AX1; DX5 forked the pattern without the fix.
 */
test('a suite that exits 0 but leaks a background process is not a false timeout', async () => {
  const started = Date.now();
  const result = await runStep({
    command: process.execPath,
    args: ['-e', `
      const { spawn } = require('node:child_process');
      // A grandchild that inherits the pipes and outlives its parent.
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      console.log('SUITE PASSED');
      process.exit(0);`],
    cwd: process.cwd(),
    timeoutMs: 8000,
  });
  assert.equal(result.ok, true, 'the suite exited 0; the leaked grandchild is not the suite\'s verdict');
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /SUITE PASSED/, 'what it wrote before exiting is still captured');
  assert.ok(Date.now() - started < 6000, 'and it settled on exit rather than waiting out the timeout');
});

/**
 * REGRESSION — output was decoded with `chunk.toString()` per `data` event, so
 * a multi-byte character split across two chunks became two U+FFFD replacement
 * characters. Mojibake in a failure reason is a worse diagnostic than none.
 */
test('a multi-byte character split across two chunks is not corrupted', async () => {
  const result = await runStep({
    command: process.execPath,
    // "café" with the two bytes of "é" written in separate flushes.
    args: ['-e', `
      process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));
      setTimeout(() => { process.stdout.write(Buffer.from([0xa9])); process.exit(0); }, 120);`],
    cwd: process.cwd(),
    timeoutMs: 8000,
  });
  assert.equal(result.output, 'café');
  assert.ok(!result.output.includes('�'), 'no replacement characters');
});

/** REGRESSION — a signal-killed child reported "exit null", hiding the signal. */
test('a step killed by a signal names the signal instead of reporting "exit null"', async (t) => {
  const root = project(t);
  const killed = async () => ({
    ok: false, code: null, signal: 'SIGKILL', output: 'running tests', durationMs: 5,
    truncated: false, timedOut: false, spawnError: null,
  });
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: killed, git: cleanGit,
  });
  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'failed');
  assert.match(verify.reason, /killed by SIGKILL/, 'an OOM-killed suite must not read like a garbage exit code');
  assert.doesNotMatch(verify.reason, /exit null/);
});

/** REGRESSION — a *passing* step whose output was truncated said so nowhere. */
test('truncation is disclosed even when the step passed', async (t) => {
  const root = project(t);
  const chatty = async () => ({
    ok: true, code: 0, signal: null, output: 'x', durationMs: 5,
    truncated: true, timedOut: false, spawnError: null,
  });
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: chatty, git: cleanGit,
  });
  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'passed');
  assert.match(verify.evidence, /output truncated/, 'a pass built on a truncated log says so');
});

/**
 * REGRESSION — nothing stopped a project's declared `verify` script from
 * calling `accordo project verify`. Because DX5 runs both `verify` and `smoke`,
 * the process tree *doubled* at every level: a probe measured 30 script
 * invocations from one command before an externally-imposed depth cap, and the
 * outer report still said `passed`. There was no env marker, no depth counter
 * and no ancestry check anywhere in the command.
 */
test('a project whose verify script re-enters project verify is refused, not recursed', async (t) => {
  const root = project(t);
  const calls = [];

  // The outer run marks every child, so a nested run can recognise itself.
  const outer = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(calls), git: cleanGit,
  });
  assert.equal(outer.report.checks.find((c) => c.code === 'suite.verify').status, 'passed');
  for (const call of calls) {
    assert.equal(call.env[VERIFY_DEPTH_ENV], '1', 'every child carries the depth marker');
  }

  // A nested run — what the child would see — refuses the declared scripts.
  const previous = process.env[VERIFY_DEPTH_ENV];
  process.env[VERIFY_DEPTH_ENV] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[VERIFY_DEPTH_ENV];
    else process.env[VERIFY_DEPTH_ENV] = previous;
  });
  const nestedCalls = [];
  const nested = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(nestedCalls), git: cleanGit,
  });
  assert.equal(nestedCalls.length, 0, 'a nested run spawns no declared script, so the recursion terminates');
  assert.equal(nested.exitCode, 1, 'and it never reports the recursion as a pass');
  const verify = nested.report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'failed');
  assert.equal(verify.reason, 'RECURSIVE_VERIFY_REFUSED');
  assert.ok(nested.report.problems.some((p) => p.code === 'RECURSIVE_VERIFY_REFUSED'));
});

/**
 * REGRESSION — `redact` folded case, so `KEY` matched inside ordinary words and
 * `\s*[=:]\s*\S+` ate the token after them. `foreign key: constraint "fk_x"
 * violated` was published as `foreign key=<redacted> violated`: the redactor
 * destroying the one identifier the reader needed.
 */
test('redact does not eat ordinary prose that merely contains a secret-ish word', () => {
  for (const survives of [
    'error: foreign key: constraint "fk_order_contract" violated',
    'FAIL: primary key: id must be unique',
    'cache key: user-42 not found',
    'ok 12 - donkey: renders',
  ]) {
    assert.equal(redact(survives, '/x'), survives, `${survives} is a diagnostic, not a credential`);
  }
  // And every genuinely secret-shaped name is still removed.
  for (const [input, expected] of [
    ['API_TOKEN=super-secret', 'API_TOKEN=<redacted>'],
    ['DATABASE_PASSWORD=hunter2', 'DATABASE_PASSWORD=<redacted>'],
    ['apiKey: "sk-live-9999"', 'apiKey=<redacted>'],
    ['accessToken=eyJhbGciOi', 'accessToken=<redacted>'],
    ['password: hunter2', 'password=<redacted>'],
  ]) {
    assert.equal(redact(input, '/x'), expected);
  }
});

/**
 * REGRESSION — the path rule matched only `[\w.@-]` segments, so an absolute
 * path stopped being redacted at its first unusual character and published the
 * rest. `/home/José/app` leaked the operator's name out of the one function
 * whose entire job is to stop that.
 */
test('an absolute path with unusual characters is fully redacted', () => {
  assert.equal(redact('at /opt/tool+1.2/lib/run.js', '/x'), 'at <path>');
  assert.equal(redact('at /tmp/build~1/out.js', '/x'), 'at <path>');
  assert.equal(redact('at /home/José/app/index.js', '/x'), 'at <path>');
  // The lookbehind still protects the useful half of a reason.
  assert.equal(redact('./packages/core/src/thing.js', '/x'), './packages/core/src/thing.js');
});

/**
 * REGRESSION — a project that declared a current plan which had since gone
 * stale was told it declares no current plan.
 *
 * DX1 grades plans in four states: `passed` binds, `failed` is malformed or a
 * declared-*required* plan that no longer binds, `warning` is a declared-
 * *current* plan that no longer binds, `not_applicable` is undeclared. DX5 kept
 * only `passed` and `failed` — dropping exactly the declared-current ones — so
 * the single-stale-current-plan case fell into the "nothing was graded" branch
 * and published `NO_CURRENT_PLANS_DECLARED`. The check denied the condition it
 * exists to surface, and called the *required* plans it did grade
 * "declared-current".
 */
test('a declared-current plan that has gone stale is not reported as no plan at all', async (t) => {
  const root = project(t);
  const withPlan = (status) => doctorOk({
    checks: [{ id: 'plans.docs-renewals-plan-json', status, reason: 'the plan no longer binds to this composition' }],
  });
  const run = async (status) => {
    const { report } = await projectVerifyCommand({
      rootDir: root, doctor: withPlan(status), inspect: inspectOk, step: recordingStep([]), git: cleanGit,
    });
    return report.checks.find((c) => c.code === 'plans.current');
  };

  // DX1 says `warning` for a declared-CURRENT plan that no longer binds.
  const stale = await run('warning');
  assert.equal(stale.status, 'warning', 'DX1 called it a warning, so DX5 does too — it does not re-decide');
  assert.notEqual(stale.reason, 'NO_CURRENT_PLANS_DECLARED');
  assert.equal(stale.reason, 'plans.docs-renewals-plan-json', 'and it names the plan');
  assert.match(stale.evidence, /declared-current and no longer binding/);

  // DX1 says `failed` for a declared-REQUIRED plan that no longer binds.
  assert.equal((await run('failed')).status, 'failed');
  // DX1 says `not_applicable` for a plan nobody declared: graded by nobody.
  const undeclared = await run('not_applicable');
  assert.equal(undeclared.status, 'not_applicable');
  assert.equal(undeclared.reason, 'NO_DECLARED_PLANS');
});

/**
 * REGRESSION — package conformance never ran on any project that composes
 * anything.
 *
 * Project Doctor reads composed package *names* from AX1, locates each through
 * the composition file, and publishes the resolved *paths* as
 * `project.packagesComposed`. DX5 read those paths and fed them back into
 * `resolveComposedPackages`, which selects by directory basename — so
 * `packages/contracts` was compared against `contracts` and matched nothing.
 * The intersection was empty for every real project, and this required check
 * reported `not_applicable` claiming "none with local source in this project"
 * about packages whose source was sitting right there. A `not_applicable`
 * required check does not fail a run, so the whole stage was invisible.
 *
 * It looked healthy on this repository only because Accordo's own default
 * composition is deliberately empty, which reports `NO_PACKAGES_COMPOSED`.
 */
test('every composed package is conformance-tested, first-party or customer-authored', async (t) => {
  const composed = [
    'examples/custom-packages/partner-scorecard',
    'packages/contracts',
    'packages/zzz-acme-widgets',
  ];
  const root = project(t);
  for (const path of composed) mkdirSync(join(root, path, 'src'), { recursive: true });
  // A composed package whose source directory is missing is not a target.
  const declared = [...composed, 'packages/ghost'];

  const calls = [];
  const { report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ project: { packagesComposed: declared } }),
    inspect: inspectOk,
    step: recordingStep(calls),
    git: cleanGit,
  });

  const conformance = report.checks.filter((c) => c.code.startsWith('packages.conformance'));
  assert.deepEqual(
    conformance.map((c) => c.code).sort(),
    composed.map((p) => `packages.conformance.${p}`).sort(),
    'a customer-authored package is selected on exactly the same rule as a first-party one, and a composed package with no source directory is not selected at all',
  );
  for (const entry of conformance) assert.equal(entry.status, 'passed');

  const tested = calls.filter((c) => c.args.includes('test')).map((c) => c.args[c.args.indexOf('test') + 1]).sort();
  assert.deepEqual(tested, [...composed].sort(), 'and each one was really spawned');
  // No hard-coded name and no first-party allowlist: the list is the project's.
  assert.deepEqual(report.project.packagesComposed, [...declared].sort());
});

test('declaredScripts reads package.json and never throws on a broken one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dx5-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{ not json');
  assert.deepEqual([...declaredScripts(root)], [], 'a malformed package.json declares nothing, and does not crash the run');
});

test('the semantic fingerprint ignores evidence noise but not decisions', () => {
  const base = {
    projectVerificationContract: 1, status: 'passed', inspectionFingerprint: 'fp',
    project: { kind: 'framework', packagesComposed: [], declaredScripts: [] },
    checks: [{ code: 'a', category: 'suite', status: 'passed', authority: 'x', required: true, durationMs: 1, evidence: 'ran', reason: null }],
    problems: [],
  };
  const noisy = {
    ...base,
    checks: [{ ...base.checks[0], durationMs: 999, evidence: 'ran somewhere else' }],
  };
  assert.equal(semanticFingerprint(base), semanticFingerprint(noisy));
  const decided = { ...base, checks: [{ ...base.checks[0], status: 'failed' }] };
  assert.notEqual(semanticFingerprint(base), semanticFingerprint(decided));
});

// ---------------------------------------------------------------------------
// Wave 2A hardening. Each test below pins a defect that was reproduced on main
// (09fedf4) with a probe before the fix was written.
// ---------------------------------------------------------------------------

/**
 * REGRESSION — the composed-package stage could not fail.
 *
 * Selecting nothing made `packages.conformance` a `not_applicable` required
 * check, and a `not_applicable` required check never fails a run. So the proof
 * that selection is real is not that the checks appear: it is that **one
 * non-conforming package turns the whole verification red**.
 */
test('one non-conforming composed package fails the verification', async (t) => {
  const root = project(t);
  const composed = ['packages/contracts', 'packages/zzz-acme-widgets'];
  for (const path of composed) mkdirSync(join(root, path, 'src'), { recursive: true });

  const failing = 'packages/zzz-acme-widgets';
  const step = async (options) => {
    const target = options.args[options.args.indexOf('test') + 1];
    return target === failing
      ? { ok: false, code: 1, signal: null, output: 'modules.applied 0/7\n', durationMs: 4, truncated: false, timedOut: false, spawnError: null }
      : { ok: true, code: 0, signal: null, output: '', durationMs: 4, truncated: false, timedOut: false, spawnError: null };
  };

  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ project: { packagesComposed: composed } }),
    inspect: inspectOk,
    step,
    git: cleanGit,
  });

  assert.equal(exitCode, 1, 'a composed package that does not conform makes the run fail');
  assert.equal(report.status, 'failed');
  const bad = report.checks.find((c) => c.code === `packages.conformance.${failing}`);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.required, true);
  assert.match(bad.reason, /modules\.applied 0\/7/, 'and the package authority\'s own verdict survives into the reason');
  assert.equal(report.checks.find((c) => c.code === 'packages.conformance.packages/contracts').status, 'passed',
    'its neighbour is graded on its own evidence, not tarred with it');
});

/**
 * REGRESSION — the uncomposed-package inventory disappeared exactly when it had
 * something to say. It was emitted on `candidates.length > targets.length`, a
 * comparison of two *counts* drawn from different sets: a project with two
 * candidates of which one is composed, plus four composed first-party packages,
 * has 2 candidates and 5 targets, so the inventory was silently dropped and the
 * genuinely uncomposed package was never named. It is a set difference.
 */
test('an uncomposed candidate stays inventory even when composed packages outnumber candidates', async (t) => {
  const root = project(t);
  const firstParty = ['packages/contracts', 'packages/delivery', 'packages/lifecycle', 'packages/service'];
  const composedCandidate = 'examples/custom-packages/partner-scorecard';
  const uncomposed = 'examples/custom-packages/acme-territories';
  for (const path of [...firstParty, composedCandidate, uncomposed]) {
    mkdirSync(join(root, path, 'src'), { recursive: true });
    writeFileSync(join(root, path, 'src', 'index.js'), 'export const x = 1;\n');
  }
  const composed = [...firstParty, composedCandidate];

  const { report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ project: { packagesComposed: composed } }),
    inspect: inspectOk,
    step: recordingStep([]),
    git: cleanGit,
  });

  const inventory = report.evidence.find((e) => e.kind === 'packages');
  assert.ok(inventory, 'five targets and two candidates still leaves one uncomposed package to name');
  assert.deepEqual(inventory.uncomposedCandidates, [uncomposed]);
  assert.equal(inventory.note, 'an uncomposed package is inventory, not a verification target');
  assert.ok(
    !report.checks.some((c) => c.code === `packages.conformance.${uncomposed}`),
    'and inventory is not graded: an uncomposed package is not a verification target',
  );
});

/**
 * The selection rule is the doctor's resolved path list and existence on disk.
 * There is no allowlist: a package with an invented name, under a directory
 * nobody has ever seen, is graded exactly like `packages/contracts`.
 */
test('composed-package selection consults no name allowlist', async (t) => {
  const root = project(t);
  const invented = ['vendor/qux-9/pkg', 'packages/\u00e7a-marche', 'examples/custom-packages/zzz'];
  for (const path of invented) mkdirSync(join(root, path, 'src'), { recursive: true });

  const calls = [];
  const { report } = await projectVerifyCommand({
    rootDir: root,
    doctor: doctorOk({ project: { packagesComposed: invented } }),
    inspect: inspectOk,
    step: recordingStep(calls),
    git: cleanGit,
  });
  assert.deepEqual(
    report.checks.filter((c) => c.code.startsWith('packages.conformance.')).map((c) => c.code).sort(),
    invented.map((p) => `packages.conformance.${p}`).sort(),
  );
  assert.equal(calls.length, invented.length + 2, 'each package really spawned, plus verify and smoke');
});

/**
 * REGRESSION — DX1's four plan verdicts, carried verbatim, with wording that
 * matches the verdict. The evidence line called every graded plan
 * "declared-current", including the *required* ones, so a reader could not tell
 * a required plan that no longer binds from a current one — the difference
 * between a failure and a warning.
 */
test('every plan verdict is carried verbatim, and named for what it is', async (t) => {
  const root = project(t);
  const run = async (checks) => {
    const { report } = await projectVerifyCommand({
      rootDir: root, doctor: doctorOk({ checks }), inspect: inspectOk, step: recordingStep([]), git: cleanGit,
    });
    return report.checks.find((c) => c.code === 'plans.current');
  };

  // A declared-REQUIRED plan that no longer binds: DX1 says failed, with the
  // binding problems it found attached.
  const required = await run([{
    id: 'plans.docs-required-plan-json', status: 'failed',
    evidence: { declaration: 'required', problems: ['PLAN_STALE'] },
    reason: 'the plan no longer binds to this composition',
  }]);
  assert.equal(required.status, 'failed');
  assert.match(required.evidence, /1 declared-required and no longer binding/);
  assert.doesNotMatch(required.evidence, /declared-current/, 'a required plan is never described as current');

  // A declared-CURRENT plan that no longer binds: DX1 says warning.
  const current = await run([{
    id: 'plans.docs-current-plan-json', status: 'warning',
    evidence: { declaration: 'current', problems: ['PLAN_STALE'] },
    reason: 'the plan no longer binds to this composition',
  }]);
  assert.equal(current.status, 'warning');
  assert.match(current.evidence, /1 declared-current and no longer binding/);

  // A MALFORMED plan: DX1 says failed and has no binding problems to attach,
  // because it could not parse the file at all.
  const malformed = await run([{
    id: 'plans.docs-broken-plan-json', status: 'failed',
    evidence: { declaration: 'undeclared' }, reason: 'Unexpected token }',
  }]);
  assert.equal(malformed.status, 'failed', 'broken source is broken source; nobody has to declare it');
  assert.match(malformed.evidence, /1 malformed/);
  assert.doesNotMatch(malformed.evidence, /no longer binding/);

  // A HISTORICAL, undeclared plan: a fact, not a fault.
  const historical = await run([{
    id: 'plans.docs-m14b2-plan-json', status: 'not_applicable',
    evidence: { declaration: 'undeclared', problems: ['PLAN_STALE'] },
    reason: 'PLAN_NOT_DECLARED_CURRENT — it no longer binds to this composition, which for an undeclared plan is a fact rather than a fault',
  }]);
  assert.equal(historical.status, 'not_applicable');
  assert.equal(historical.reason, 'NO_DECLARED_PLANS');
  assert.match(historical.evidence, /1 plan\(s\) found, none declared current or required/);
  assert.doesNotMatch(historical.evidence, /declares no plan as current/);

  // And a project with no plan files at all is a different sentence again.
  const none = await run([{ id: 'plans.current', status: 'not_applicable', reason: 'NO_SOLUTION_PLANS_FOUND' }]);
  assert.equal(none.status, 'not_applicable');
  assert.equal(none.reason, 'NO_SOLUTION_PLANS_FOUND');
  assert.equal(none.evidence, 'this project has no solution plan at all');

  // Mixed: the worst verdict wins, and every kind is still counted by name.
  const mixed = await run([
    { id: 'plans.a-plan-json', status: 'failed', evidence: { declaration: 'required', problems: ['PLAN_STALE'] } },
    { id: 'plans.b-plan-json', status: 'warning', evidence: { declaration: 'current', problems: ['PLAN_STALE'] } },
    { id: 'plans.c-plan-json', status: 'failed', evidence: { declaration: 'current' } },
    { id: 'plans.d-plan-json', status: 'passed', evidence: { declaration: 'current', problems: [] } },
  ]);
  assert.equal(mixed.status, 'failed');
  assert.match(mixed.evidence, /4 plan\(s\) graded/);
  assert.match(mixed.evidence, /1 declared-required and no longer binding/);
  assert.match(mixed.evidence, /1 declared-current and no longer binding/);
  assert.match(mixed.evidence, /1 malformed/);
});

/**
 * All seven worktree transitions, in one place, because the interesting
 * property is the *difference* between two samples and a table is the only
 * honest way to read it.
 *
 * `defaultGit` samples `XY<TAB>path`, so a path present in both samples with a
 * different status is the run's doing too: a file the operator had modified and
 * a delegate then deleted keeps its path and was otherwise invisible.
 */
test('all seven worktree transitions are attributed to the right party', async (t) => {
  const root = project(t);
  const transitions = [
    {
      name: 'clean to clean',
      before: '', after: '',
      status: 'passed', reason: null, caused: [], reverted: [], problems: [],
    },
    {
      name: 'dirty to the same dirty',
      before: ' M src/a.js\n', after: ' M src/a.js\n',
      status: 'passed', reason: 'DIRTY_BEFORE_VERIFY', caused: [], reverted: [], problems: [],
    },
    {
      name: 'dirty to an additional tracked change',
      before: ' M src/a.js\n', after: ' M src/a.js\n M src/b.js\n',
      status: 'warning', caused: ['src/b.js'], reverted: [], problems: ['WORKTREE_DIRTY_AFTER_VERIFY'],
    },
    {
      name: 'dirty to a new untracked file',
      before: ' M src/a.js\n', after: ' M src/a.js\n?? data/scratch.db\n',
      status: 'warning', caused: ['data/scratch.db'], reverted: [], problems: ['WORKTREE_DIRTY_AFTER_VERIFY'],
    },
    {
      name: 'clean to a tracked modification',
      before: '', after: ' M src/a.js\n',
      status: 'warning', caused: ['src/a.js'], reverted: [], problems: ['WORKTREE_DIRTY_AFTER_VERIFY'],
    },
    {
      name: 'clean to a tracked deletion',
      before: '', after: ' D src/a.js\n',
      status: 'warning', caused: ['src/a.js'], reverted: [], problems: ['WORKTREE_DIRTY_AFTER_VERIFY'],
    },
    {
      name: 'clean to an untracked leak',
      before: '', after: '?? coverage/lcov.info\n',
      status: 'warning', caused: ['coverage/lcov.info'], reverted: [], problems: ['WORKTREE_DIRTY_AFTER_VERIFY'],
    },
  ];

  for (const transition of transitions) {
    const tab = (sample) => sample.replace(/^(..) /gm, '$1\t');
    const { report } = await projectVerifyCommand({
      rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]),
      git: gitSamples(tab(transition.before), tab(transition.after)),
    });
    const worktree = report.checks.find((c) => c.code === 'worktree.clean');
    assert.equal(worktree.status, transition.status, transition.name);
    if (transition.reason !== undefined) assert.equal(worktree.reason, transition.reason, transition.name);
    const evidence = report.evidence.find((e) => e.kind === 'worktree');
    assert.deepEqual(evidence.changedByVerify, transition.caused, transition.name);
    assert.deepEqual(evidence.revertedByVerify, transition.reverted, transition.name);
    assert.deepEqual(
      report.problems.map((p) => p.code).filter((code) => code.startsWith('WORKTREE_')),
      transition.problems, transition.name,
    );
    // Whatever happened, nothing was repaired: the command runs no git that writes.
    assert.match(
      JSON.stringify(report),
      /Nothing was reset, stashed or hidden|never resets, stashes or cleans|nothing changed while verifying|verification changed none of them/,
      transition.name,
    );
  }
});

/**
 * REGRESSION — a path in both samples was assumed unchanged. A file the
 * operator had modified and a delegate then *deleted* kept its path in both,
 * so the run reported "verification changed none of them" about a deletion it
 * had caused.
 */
test('a pre-existing modification that the run turns into a deletion is still the run\'s doing', async (t) => {
  const root = project(t);
  const { report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep([]),
    git: gitSamples(' M\tsrc/precious.js\n', ' D\tsrc/precious.js\n'),
  });
  const worktree = report.checks.find((c) => c.code === 'worktree.clean');
  assert.equal(worktree.status, 'warning');
  assert.deepEqual(report.evidence.find((e) => e.kind === 'worktree').changedByVerify, ['src/precious.js']);
  assert.ok(report.problems.some((p) => p.code === 'WORKTREE_DIRTY_AFTER_VERIFY'));
});

/**
 * Process completion, attacked. Every case here is a real shape a project's
 * suite produces, and each one settles on the child's **exit** rather than on
 * its streams closing.
 *
 * The residual limitation is published rather than papered over: a *detached*
 * grandchild leaves its own process group, so stopping the group does not reach
 * it and it outlives the step. That is `PROJECT_COMMANDS_TRUSTED` — bounded
 * isolation, not a sandbox — and the test asserts the honest outcome (the step
 * still settles promptly and truthfully) rather than a containment claim this
 * command cannot make.
 */
test('a step settles on process exit under every leak shape', async () => {
  const node = (source) => ({ command: process.execPath, args: ['-e', source], cwd: process.cwd(), timeoutMs: 20_000 });

  // 1. an ordinary child.
  const plain = await runStep(node('process.stdout.write("done\\n")'));
  assert.equal(plain.ok, true);
  assert.equal(plain.timedOut, false);
  assert.match(plain.output, /done/);

  // 2. an ordinary grandchild that outlives the parent and inherits its pipes.
  const grandchild = await runStep(node(`
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'inherit' }).unref();
    process.stdout.write('parent-exiting\\n');
    process.exit(0);
  `));
  assert.equal(grandchild.ok, true, 'a leaked grandchild does not fail the step');
  assert.equal(grandchild.timedOut, false, 'and above all does not burn the timeout');
  assert.ok(grandchild.durationMs < 15_000, `settled in ${grandchild.durationMs}ms`);

  // 3. a DETACHED grandchild, in its own process group, which the group kill
  //    cannot reach. It still must not hold the step open.
  const detached = await runStep(node(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'inherit' });
    child.unref();
    process.stdout.write('detached\\n');
  `));
  assert.equal(detached.ok, true);
  assert.equal(detached.timedOut, false);
  assert.ok(detached.durationMs < 15_000, `settled in ${detached.durationMs}ms`);

  // 4. a grandchild that explicitly holds the stdout pipe open forever.
  const held = await runStep(node(`
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: ['ignore', 1, 2] }).unref();
    process.stdout.write('holder-started\\n');
    process.exit(0);
  `));
  assert.equal(held.ok, true, 'an inherited pipe that never closes is not this command\'s problem');
  assert.equal(held.timedOut, false);
  assert.ok(held.durationMs < 15_000, `settled in ${held.durationMs}ms`);

  // 5. a genuine hang is still a timeout, and the group is stopped.
  const hung = await runStep({ ...node('setInterval(()=>{},1000)'), timeoutMs: 400 });
  assert.equal(hung.ok, false);
  assert.equal(hung.timedOut, true);
  assert.equal(hung.signal, 'SIGKILL');

  // 6. a log flood is bounded, disclosed, and does not become the report.
  const flood = await runStep(node('for (let i=0;i<200000;i++) process.stdout.write("noise-".repeat(8) + "\\n");'));
  assert.equal(flood.truncated, true, 'a package that floods stdout is truncated, not memorised');
  assert.ok(flood.output.length <= MAX_CAPTURED_OUTPUT, `${flood.output.length} bytes retained`);

  // 7. output written immediately before exit is still collected: the drain
  //    window exists for exactly this, and losing it would lose the diagnostic.
  const lastWords = await runStep(node('process.stdout.write("the final line\\n"); process.exit(3);'));
  assert.equal(lastWords.ok, false);
  assert.equal(lastWords.code, 3);
  assert.match(lastWords.output, /the final line/, 'what the process wrote before exiting survives the drain');

  // 8. a command that cannot start is a spawn error, not a silent pass.
  const missing = await runStep({ command: 'accordo-no-such-binary-9d3f', args: [], cwd: process.cwd(), timeoutMs: 5_000 });
  assert.equal(missing.ok, false);
  assert.ok(missing.spawnError, 'the reason names the start failure');
});

/**
 * REGRESSION — a value taken from a delegated report went straight into the
 * report and into `canonicalJson`, which recurses with no cycle guard and no
 * depth bound. A malformed nested report therefore did not produce a bad
 * report: it produced `RangeError: Maximum call stack size exceeded` and **no
 * report at all**. Probed on main: both a cyclic and a 200,000-deep value crash
 * `semanticFingerprint` outright.
 */
test('a malformed nested report is bounded, not allowed to generate unbounded work', async (t) => {
  // The bound itself.
  const cyclic = { packagesComposed: [] };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => JSON.stringify(boundNested(cyclic)), 'a cycle is cut at the depth bound');

  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 100_000; i += 1) { cursor.next = {}; cursor = cursor.next; }
  const flattened = boundNested(deep);
  let levels = 0;
  for (let cur = flattened; cur && cur.next; cur = cur.next) levels += 1;
  assert.ok(levels < MAX_NESTED_DEPTH, `cut to ${levels} levels`);

  const wide = boundNested(Array.from({ length: 10_000 }, (_, i) => i));
  assert.ok(wide.length <= MAX_NESTED_NODES, `${wide.length} nodes kept`);

  assert.equal(boundNested('x'.repeat(5_000)).length, MAX_NESTED_TEXT + '… [truncated]'.length);
  assert.equal(boundNested(() => 1), null, 'a function is not evidence');
  assert.equal(boundNested(Number.NaN), null, 'and a non-finite number would refuse to canonicalize');
  const hostile = { get boom() { throw new Error('no'); }, safe: 1 };
  assert.deepEqual(boundNested(hostile), { safe: 1 }, 'a throwing getter is skipped, not fatal');

  // And end to end: a doctor whose report is hostile still yields a report.
  const root = project(t);
  const cyclicReport = { status: 'passed', fingerprint: 'fp', project: { packagesComposed: [] }, checks: [] };
  cyclicReport.project.self = cyclicReport.project;
  cyclicReport.project.packagesComposed.push('packages/contracts', 42, null, '/absolute/not/relative');
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });

  const { report } = await projectVerifyCommand({
    rootDir: root,
    doctor: async () => ({ exitCode: 0, report: cyclicReport }),
    inspect: inspectOk,
    step: recordingStep([]),
    git: cleanGit,
  });
  assert.ok(report, 'a hostile delegated report still produces a report');
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/, 'and the fingerprint is still computable');
  assert.deepEqual(report.project.packagesComposed, ['packages/contracts'],
    'a non-string and an absolute path are not repository-relative package paths');
});

/**
 * REGRESSION — the depth marker is what makes the refusal deterministic, and it
 * must increment rather than being merely present, so the code is stable
 * whatever depth a run is discovered at.
 */
test('the recursion refusal is deterministic at any depth, and carries a stable code', async (t) => {
  const root = project(t);
  const previous = process.env[VERIFY_DEPTH_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[VERIFY_DEPTH_ENV];
    else process.env[VERIFY_DEPTH_ENV] = previous;
  });

  for (const [marker, expectRefusal] of [[undefined, false], ['0', false], ['1', true], ['7', true], ['not-a-number', false]]) {
    if (marker === undefined) delete process.env[VERIFY_DEPTH_ENV];
    else process.env[VERIFY_DEPTH_ENV] = marker;
    const calls = [];
    const { exitCode, report } = await projectVerifyCommand({
      rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(calls), git: cleanGit,
    });
    const verify = report.checks.find((c) => c.code === 'suite.verify');
    if (expectRefusal) {
      assert.equal(verify.status, 'failed', `marker ${marker}`);
      assert.equal(verify.reason, 'RECURSIVE_VERIFY_REFUSED', `marker ${marker}`);
      assert.equal(exitCode, 1, `marker ${marker}`);
      assert.equal(calls.length, 0, `marker ${marker}: nothing is spawned, so the recursion terminates`);
    } else {
      assert.equal(verify.status, 'passed', `marker ${marker}`);
      const depths = new Set(calls.map((call) => call.env[VERIFY_DEPTH_ENV]));
      assert.deepEqual([...depths], [String(Number.parseInt(marker ?? '0', 10) || 0) === '0' ? '1' : '1'],
        `marker ${marker}: every child is marked one deeper`);
    }
  }
});

/**
 * REGRESSION, and the tour contract.
 *
 * `scripts/tour.js` says the project it leaves behind "proves nothing the test
 * suite does not already prove — it makes what is proven visible", and README
 * frames `--keep` as leaving the project *to explore*. It is a read-only
 * inspection demo, not a runnable artifact. The defect is therefore that its
 * generated `package.json` declares scripts it has no `scripts/` directory to
 * satisfy: `npm run verify` exits 1 with `MODULE_NOT_FOUND` from inside Node's
 * loader, which DX5 reported as a *suite failure* — a fact about a suite that
 * was never there.
 */
test('a declared script whose entry point is absent is not applicable, and says so loudly', async (t) => {
  const root = project(t, {
    scripts: {
      verify: 'npm run check && npm test',
      check: 'node scripts/check.js',
      test: 'node --no-warnings --test --test-reporter=spec',
      smoke: 'node --no-warnings scripts/smoke.js',
    },
  });
  const calls = [];
  const { exitCode, report } = await projectVerifyCommand({
    rootDir: root, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(calls), git: cleanGit,
  });

  const verify = report.checks.find((c) => c.code === 'suite.verify');
  assert.equal(verify.status, 'not_applicable', 'it is not a suite failure: the suite was never there');
  assert.equal(verify.reason, 'SCRIPT_TARGET_MISSING');
  assert.match(verify.evidence, /scripts\/check\.js/, 'and the absent entry point is named');
  assert.equal(report.checks.find((c) => c.code === 'suite.smoke').reason, 'SCRIPT_TARGET_MISSING');
  assert.equal(calls.length, 0, 'nothing was run, and nothing was guessed or substituted');
  assert.ok(
    report.problems.some((p) => p.code === 'DECLARED_SCRIPT_TARGET_MISSING'),
    'not_applicable is not silence: a package.json that declares what it cannot satisfy is a named problem',
  );
  assert.equal(exitCode, 0, 'though it is the project\'s defect to fix, not a verification failure to invent');

  // And a project whose targets are present is run exactly as before: the
  // analysis never invents a reason to skip.
  const healthy = project(t, { scripts: { verify: 'npm run check && npm test', check: 'node scripts/check.js', test: 'node --test' } });
  mkdirSync(join(healthy, 'scripts'), { recursive: true });
  writeFileSync(join(healthy, 'scripts/check.js'), '\n');
  const ran = [];
  const second = await projectVerifyCommand({
    rootDir: healthy, doctor: doctorOk(), inspect: inspectOk, step: recordingStep(ran), git: cleanGit,
  });
  assert.equal(second.report.checks.find((c) => c.code === 'suite.verify').status, 'passed');
  assert.ok(ran.some((call) => call.args.includes('verify')));
});

test('missingScriptTargets follows npm chains, ignores flags, and never guesses', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dx5-targets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/present.js'), '\n');

  const scripts = {
    chain: 'npm run a && npm run b',
    a: 'node scripts/present.js',
    b: 'node scripts/absent.js',
    flagsOnly: 'node --no-warnings --test --test-reporter=spec',
    aliased: 'npm test',
    test: 'node scripts/absent.js',
    notNode: 'tsc --noEmit && eslint .',
    inline: 'node -e "console.log(1)"',
    absolute: 'node /opt/tool/run.js',
    selfReferential: 'npm run selfReferential',
    piped: 'node scripts/absent.js | tee out.log',
  };
  const targets = (script) => missingScriptTargets({ rootDir: root, script, scripts });

  assert.deepEqual(targets('chain'), ['scripts/absent.js'], 'an npm chain is followed, and only the absent half is named');
  assert.deepEqual(targets('a'), []);
  assert.deepEqual(targets('flagsOnly'), [], 'a script that names no file names no missing file');
  assert.deepEqual(targets('aliased'), ['scripts/absent.js'], 'npm test is followed like npm run test');
  assert.deepEqual(targets('notNode'), [], 'a command this does not understand is left alone, never guessed at');
  assert.deepEqual(targets('inline'), [], 'an inline program has no entry file');
  assert.deepEqual(targets('absolute'), [], 'an absolute path is somebody else\'s machine, not this project');
  assert.deepEqual(targets('selfReferential'), [], 'a cyclic script chain terminates');
  assert.deepEqual(targets('piped'), ['scripts/absent.js']);
  assert.deepEqual(targets('nope'), [], 'an undeclared script has nothing to resolve');
});

/**
 * REGRESSION — redaction, attacked.
 *
 * Two gaps were confirmed on main: a Windows absolute path contains no forward
 * slash, so `C:\Users\alice\...` and `\\fileserver\team\...` passed through
 * untouched by a function whose stated job is removing absolute machine paths;
 * and the POSIX rule matched from the *second* slash of `//`, so
 * `https://example.com/a/b/c` was published as `https:/<path>` — a URL
 * destroyed to protect nothing.
 */
test('redaction removes every absolute machine path and keeps what is useful', () => {
  const root = '/home/user/proj';
  const removed = [
    ['C:\\Users\\alice\\secrets\\app.js failed', '<path> failed'],
    ['C:/Users/bob/app.js', '<path>'],
    ['at \\\\fileserver\\team\\build\\out.log', 'at <path>'],
    // A home or temp root leaks the operator's identity in its tail, and a
    // space in a path is legal: `/home/jose gonzalez/app/x.js` published
    // `gonzalez/app/x.js` under the old rule.
    ['/home/jose gonzalez/app/x.js', '<path>'],
    ['/Users/Jane Doe/Library/app.js', '<path>'],
    ['/var/folders/zz/T/accordo-tour-9/pkg', '<path>'],
    ['/usr/lib/node_modules/x/y.js', '<path>'],
    ['file:///home/u/x/y.js', 'file://<path>'],
    // A symlink is reported by git and by Node as two absolute paths.
    ["ELOOP: /tmp/link/a -> /opt/real/target/a", 'ELOOP: <path> -> <path>'],
  ];
  for (const [input, expected] of removed) assert.equal(redact(input, root), expected, input);

  const kept = [
    'https://example.com/a/b/c',
    'see https://docs.accordo.dev/guides/verify/plans for detail',
    './packages/core/src/thing.js',
    'packages/core/src/thing.js:12:3',
    'AssertionError: expected 3 to equal 4',
    'ok 12 - donkey: renders',
  ];
  for (const input of kept) assert.equal(redact(input, root), input, input);

  // The project root still becomes `.`, so the useful half of every path in a
  // real reason survives.
  assert.equal(redact('/home/user/proj/packages/core/x.js', root), './packages/core/x.js');
  // And prose after a path is prose, not path.
  assert.equal(redact('/tmp/a/b failed to load', root), '<path> failed to load');
  // Environment values keep the name and lose the value.
  // A URL survives, but a DSN's credentials do not: no name-shaped rule catches
  // them, because the variable is called DATABASE_URL.
  assert.equal(redact('env: DATABASE_URL=postgres://u:hunter2@h/db', root), 'env: DATABASE_URL=postgres://<redacted>@h/db');
  assert.equal(redact('env: DATABASE_PASSWORD=hunter2 HOME=/home/u/x', root), 'env: DATABASE_PASSWORD=<redacted> HOME=<path>');
  // A hostile diagnostic that ships the redactor's own markers is inert text.
  assert.equal(redact('<path> <redacted> /etc/shadow/x', root), '<path> <redacted> <path>');
});

/**
 * REGRESSION — the reason for a failed step was the last six lines of the log,
 * whatever they were. A delegate that reports in JSON ends in closing braces
 * and a suite whose fixtures print ends in fixture noise, so a real run against
 * a composed project published
 * `exit 1: ], | "database": "created empty in a temporary copy" | },` as the
 * reason a package failed conformance — the one field a reader looks at,
 * carrying nothing.
 */
test('a failure reason is the verdict in the log, not whatever happened to be last', () => {
  const jsonReport = [
    '{', '  "checks": [',
    '    { "id": "modules.applied", "status": "failed", "evidence": "0/8 of this package\'s manifests applied; refused: packages/contracts/modules/contract-line.module.json" }',
    '  ],', '  "database": "created empty in a temporary copy and destroyed with it"', '}',
  ].join('\n');
  const summary = summarize(jsonReport, '/x');
  assert.match(summary, /modules\.applied/, 'the authority\'s own verdict is what a reader needs');
  assert.doesNotMatch(summary, /created empty in a temporary copy/, 'and not the boilerplate that happened to be last');

  const noisyTail = [
    'AssertionError: expected 1 to equal 2',
    'fixture noise line 156', 'fixture noise line 157', 'fixture noise line 158',
    'fixture noise line 159', 'fixture noise line 160', 'fixture noise line 161',
  ].join('\n');
  assert.match(summarize(noisyTail, '/x'), /AssertionError/);

  // A passing test whose NAME contains a verdict word is not a verdict. The
  // first version of this rule published
  // `✔ a hostile name cannot smuggle content into the generated source` as the
  // reason a suite failed.
  const specReport = [
    '✔ a hostile name cannot smuggle content into the generated source (81ms)',
    '✔ a package that fails conformance is refused (4ms)',
    '✖ the ledger states the counts the tour produced (12ms)',
    'ℹ tests 906', 'ℹ pass 905', 'ℹ fail 1',
  ].join('\n');
  const chosen = summarize(specReport, '/x');
  assert.match(chosen, /✖ the ledger states/, 'the failing line is the verdict');
  assert.doesNotMatch(chosen, /hostile name/, 'and a passing test that merely says "cannot" is not');

  // With no verdict-shaped line at all, the tail is still the best guess.
  const featureless = Array.from({ length: 20 }, (_, i) => `step ${i} done`).join('\n');
  assert.match(summarize(featureless, '/x'), /step 19 done/);
  // And it stays bounded either way.
  assert.ok(summarize(Array.from({ length: 4000 }, () => 'a failure occurred here').join('\n'), '/x').length <= 400);
});
