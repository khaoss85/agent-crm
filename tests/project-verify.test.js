import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES, PROJECT_VERIFICATION_CONTRACT, STATUSES, VERIFY_DEPTH_ENV, check, declaredScripts,
  projectVerifyCommand, redact, runStep, semanticFingerprint, summarize,
} from '../packages/cli/src/project-verify-command.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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
