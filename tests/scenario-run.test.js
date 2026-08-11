import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_OUTCOMES, JOBS_PATH, LIMITATIONS, OBSERVATION_STATUSES, SCENARIO_RUN_CONTRACT,
  indexComposition, loadJobsIndex, planValid, resolveScenarioArgument, scenarioRunCommand,
} from '../packages/cli/src/scenario-run-command.js';
import { JOURNEYS, RECURSION_ENV, journeyMetrics, parseTrailingJson, runJourney } from '../packages/cli/src/scenario-journey.js';
import { safeMessage } from '../packages/cli/src/safe-text.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * DX6 answers "which JTBD rows does this checkout actually earn, and which does
 * it not?". These tests are about the mapping and the refusals; the expensive
 * delegate — a real journey that composes a whole application — is injected in
 * all but one test, which runs the real thing end to end.
 *
 * Six defects shipped in DX5 (child settled on stream close, selection that
 * silently matched nothing, no recursion guard, a worktree check that could not
 * tell what caused a change, a redactor wrong in both directions, and silent
 * truncation with corrupted UTF-8 and `exit null`). Each has a regression test
 * here, marked as such.
 */

// --- fixtures -----------------------------------------------------------------

const scenario = (overrides = {}) => ({
  scenarioContract: 1,
  id: 'sample',
  title: 'A sample scenario',
  summary: 'One business process, observed.',
  journey: 'b2b-lead-qualification',
  steps: [
    { id: 'compose', narrative: 'the journey runs', observe: [{ kind: 'journey.completed' }] },
    {
      id: 'capture',
      narrative: 'leads are captured',
      observe: [
        { kind: 'module.present', module: 'lead' },
        { kind: 'journey.count', metric: 'leads', atLeast: 3 },
      ],
    },
  ],
  claims: [{ job: 'JTBD-04', steps: ['compose', 'capture'], note: 'narrow' }],
  ...overrides,
});

/** A project skeleton holding one scenario document. */
function project(t, document = scenario(), { name = 'sample' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dx6-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, `${name}.scenario.json`), JSON.stringify(document, null, 2));
  return root;
}

const receipt = { ok: true, leads: 7, tasks: 2, companies: 1, summary: 'prose a person reads' };

/** A journey stub that succeeds, recording what it was asked to run. */
function recordingJourney(calls, result = {}) {
  return async (options) => {
    calls.push(options);
    return {
      ok: true, code: 0, signal: null, receipt, output: '', truncated: false,
      timedOut: false, spawnError: null, durationMs: 5, ...result,
    };
  };
}

const inspectOk = async () => ({
  exitCode: 0,
  report: {
    applicationInspectionContract: 1,
    valid: true,
    application: { packageContract: 1, composition: ['a.js'] },
    packages: [{ name: 'intelligence', version: 1, packageContract: 1, resources: [], actions: [], policies: [], requires: [], provides: [] }],
    capabilities: [{ name: 'intelligence', version: 1, provider: 'intelligence', status: 'resolved', consumers: [] }],
    resources: [{ resource: 'enrichment-snapshot', package: 'intelligence' }],
    modules: [{ name: 'lead' }, { name: 'task' }],
    actions: [{ module: 'lead', name: 'qualify' }],
    policies: [{ owner: 'intelligence', kind: 'scoring-model', name: 'b2b-fit', version: 1 }],
    providers: [],
    problems: [],
  },
});

/** A JTBD index stub: three rows, so "not established" is a real number. */
const jobsOk = () => ({
  ok: true,
  reason: null,
  contract: 1,
  fingerprint: 'jobs-fp',
  statusVocabulary: ['not supported', 'partially supported', 'technically supported', 'validated end to end'],
  jobs: new Map([
    ['JTBD-04', { id: 'JTBD-04', title: 'Capture a lead', section: 'CRM', status: 'validated end to end', tests: ['tests/lead-qualification-e2e.test.js'] }],
    ['JTBD-05', { id: 'JTBD-05', title: 'Qualify a lead', section: 'CRM', status: 'validated end to end', tests: [] }],
    ['JTBD-MK-01', { id: 'JTBD-MK-01', title: 'Plan a campaign', section: 'Marketing', status: 'not supported', tests: [] }],
  ]),
});

const run = (root, options = {}) => scenarioRunCommand({
  scenarioRef: join(root, 'sample.scenario.json'),
  rootDir: root,
  out: () => {},
  err: () => {},
  inspect: inspectOk,
  jobs: jobsOk,
  ...options,
});

// --- the happy path, and the mapping nobody has today -------------------------

test('a scenario that runs earns the rows it claims, and says which it did not', async (t) => {
  const root = project(t);
  const calls = [];
  const { exitCode, report } = await run(root, { journey: recordingJourney(calls) });

  assert.equal(exitCode, 0);
  assert.equal(report.status, 'passed');
  assert.equal(report.scenarioRunContract, SCENARIO_RUN_CONTRACT);
  assert.equal(calls.length, 1, 'exactly one journey ran');
  assert.equal(calls[0].installer, JOURNEYS['b2b-lead-qualification'].installer);

  // The positive: the claim resolved against the index and is established.
  assert.deepEqual(report.jtbd.established, ['JTBD-04']);
  const claim = report.jtbd.claims[0];
  assert.equal(claim.outcome, 'established');
  assert.equal(claim.recordedStatus, 'validated end to end');
  assert.deepEqual(claim.evidence, ['capture.01', 'capture.02', 'compose.01']);

  // The negative, which is the whole point: counted, enumerated, sectioned.
  assert.equal(report.jtbd.notEstablished.count, 2);
  assert.deepEqual(report.jtbd.notEstablished.jobs, ['JTBD-05', 'JTBD-MK-01']);
  assert.deepEqual(report.jtbd.notEstablished.bySection, [{ section: 'CRM', count: 1 }, { section: 'Marketing', count: 1 }]);
  assert.deepEqual(report.counts.jobs, { total: 3, established: 1, notEstablished: 2 });
});

test('a passing run still publishes what it does not prove, and promotes nothing', async (t) => {
  const root = project(t);
  const { report } = await run(root, { journey: recordingJourney([]) });

  const codes = report.limitations.map((limitation) => limitation.code);
  for (const required of [
    'SCENARIO_IS_NOT_PROMOTION', 'COVERAGE_IS_CLAIMED_NOT_DISCOVERED', 'NEGATIVE_EVIDENCE_IS_SILENCE',
    'EVIDENCE_IS_ONE_COMPOSITION', 'JOURNEY_SOURCE_TRUSTED', 'BROWSER_EVIDENCE_NOT_AUTOMATED',
    'NO_PROVIDER_CONTACTED', 'PRODUCTION_READINESS_NOT_ASSESSED',
  ]) {
    assert.ok(codes.includes(required), `${required} must be published even on a pass`);
  }
  assert.deepEqual(codes, LIMITATIONS.map((limitation) => limitation.code));

  assert.equal(report.promotion.performed, false);
  assert.equal(report.promotion.authority, 'human');
  assert.deepEqual(report.promotion.wrote, []);
  assert.match(report.promotion.rule, /QUALITY_GATES/);

  // The claim vocabulary is deliberately NOT the JTBD status vocabulary, so the
  // two can never be read as the same thing.
  for (const outcome of CLAIM_OUTCOMES) {
    assert.ok(!report.jtbd.statusVocabulary.includes(outcome), `${outcome} must not be a JTBD status`);
  }
});

test('the report carries no duration, timestamp, temporary path or machine layout', async (t) => {
  const root = project(t);
  const { report } = await run(root, { journey: recordingJourney([]) });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(root), 'the scratch project root must not travel');
  assert.ok(!serialized.includes(tmpdir()), 'no temporary path may travel');
  assert.ok(!/durationMs|elapsed|startedAt|timestamp/i.test(serialized), 'no time may travel');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(serialized), 'no ISO timestamp may travel');
  // Prose from the journey's receipt is excluded: a better sentence must not
  // change the evidence.
  assert.ok(!serialized.includes('prose a person reads'));
  assert.deepEqual(report.journey.metrics, { companies: 1, leads: 7, tasks: 2 });
});

test('two runs of an unchanged checkout produce byte-identical documents', async (t) => {
  const root = project(t);
  const first = await run(root, { journey: recordingJourney([]) });
  const second = await run(root, { journey: recordingJourney([]) });
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
  assert.equal(first.report.fingerprint, second.report.fingerprint);
});

test('the fingerprint moves when the run decided something different', async (t) => {
  const root = project(t);
  const base = await run(root, { journey: recordingJourney([]) });
  const fewer = await run(root, {
    journey: recordingJourney([], { receipt: { ...receipt, leads: 1 } }),
  });
  assert.notEqual(fewer.report.fingerprint, base.report.fingerprint);
  assert.equal(fewer.report.status, 'failed');
});

// --- the negative-evidence path ------------------------------------------------

test('a journey that does not complete establishes nothing, and says why', async (t) => {
  const root = project(t);
  const failing = async () => ({
    ok: false, code: 1, signal: null, receipt: null,
    output: 'AssertionError: qualified lead opened no task\n', truncated: false,
    timedOut: false, spawnError: null, durationMs: 5,
  });
  const { exitCode, report } = await run(root, { journey: failing });

  assert.equal(exitCode, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.journey.completed, false);
  assert.deepEqual(report.jtbd.established, []);
  assert.equal(report.jtbd.claims[0].outcome, 'not_established');
  // Everything downstream of the journey is skipped, never quietly passed.
  assert.deepEqual(report.observations.filter((o) => o.code !== 'compose.01').map((o) => o.status), ['skipped', 'skipped']);
  assert.equal(report.observations.find((o) => o.code === 'compose.01').status, 'failed');
  const problem = report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_FAILED');
  assert.ok(problem);
  assert.match(problem.message, /exit 1/);
  assert.match(problem.message, /opened no task/);
  // And the negative set covers every row, including the one it claimed.
  assert.equal(report.jtbd.notEstablished.count, 3);
});

test('an observation that fails fails its claim, and only its claim', async (t) => {
  const root = project(t, scenario({
    steps: [
      { id: 'compose', narrative: 'the journey runs', observe: [{ kind: 'journey.completed' }] },
      { id: 'capture', narrative: 'leads', observe: [{ kind: 'journey.count', metric: 'leads', atLeast: 99 }] },
    ],
    claims: [
      { job: 'JTBD-04', steps: ['capture'], note: 'a' },
      { job: 'JTBD-05', steps: ['compose'], note: 'b' },
    ],
  }));
  const { exitCode, report } = await run(root, { journey: recordingJourney([]) });

  assert.equal(exitCode, 1);
  assert.deepEqual(report.jtbd.established, ['JTBD-05']);
  const failed = report.jtbd.claims.find((claim) => claim.job === 'JTBD-04');
  assert.equal(failed.outcome, 'not_established');
  assert.match(failed.reason, /capture failed/);
  const observation = report.observations.find((entry) => entry.code === 'capture.01');
  assert.equal(observation.status, 'failed');
  assert.equal(observation.actual, 'leads = 7');
});

test('a metric the journey never reported fails loudly instead of passing vacuously', async (t) => {
  // DX5 regression: a required check reported not_applicable because nothing
  // matched. A check with nothing to check must never be a pass.
  const root = project(t, scenario({
    steps: [{ id: 'compose', narrative: 'n', observe: [{ kind: 'journey.count', metric: 'invoices', atLeast: 1 }] }],
    claims: [{ job: 'JTBD-04', steps: ['compose'], note: 'n' }],
  }));
  const { exitCode, report } = await run(root, { journey: recordingJourney([]) });
  assert.equal(exitCode, 1);
  const observation = report.observations[0];
  assert.equal(observation.status, 'failed');
  assert.equal(observation.actual, 'not reported');
  assert.match(observation.reason, /no numeric metric "invoices"/);
});

test('a claim for a row the index does not have is unresolved and fails closed', async (t) => {
  const root = project(t, scenario({ claims: [{ job: 'JTBD-ZZ-99', steps: ['compose'], note: 'n' }] }));
  const { exitCode, report } = await run(root, { journey: recordingJourney([]) });

  assert.equal(exitCode, 1);
  assert.equal(report.jtbd.claims[0].outcome, 'unresolved');
  assert.equal(report.jtbd.claims[0].recordedStatus, null);
  assert.ok(report.problems.some((problem) => problem.code === 'SCENARIO_JOB_UNKNOWN'));
});

test('an unreadable JTBD index leaves every claim unresolved rather than inventing rows', async (t) => {
  const root = project(t);
  const { exitCode, report } = await run(root, {
    journey: recordingJourney([]),
    jobs: () => ({ ok: false, reason: `${JOBS_PATH} is not in this project`, jobs: new Map(), fingerprint: null, contract: null, statusVocabulary: [] }),
  });
  assert.equal(exitCode, 1);
  assert.equal(report.jtbd.claims[0].outcome, 'unresolved');
  assert.equal(report.jtbd.notEstablished.count, 0, 'an empty index cannot enumerate a negative');
  assert.ok(report.problems.some((problem) => problem.code === 'SCENARIO_JOBS_INDEX_UNREADABLE'));
});

test('a composition that cannot be inspected skips composition observations, never passes them', async (t) => {
  const root = project(t);
  const { exitCode, report } = await run(root, {
    journey: recordingJourney([]),
    inspect: async () => ({ exitCode: 2, report: null }),
  });
  assert.equal(exitCode, 1);
  assert.equal(report.composition.inspected, false);
  const observation = report.observations.find((entry) => entry.kind === 'module.present');
  assert.equal(observation.status, 'skipped');
  assert.equal(observation.reason, 'SCENARIO_COMPOSITION_UNREADABLE');
  assert.ok(report.problems.some((problem) => problem.code === 'SCENARIO_COMPOSITION_UNREADABLE'));
});

// --- refusals: a bad document never starts a journey ---------------------------

test('a document carrying a command is refused, and NO journey is started', async (t) => {
  const calls = [];
  for (const bad of [
    { run: 'npm test' },
    { summary: 'first run npm run verify' },
    { title: '<script>alert(1)</script>' },
  ]) {
    const root = project(t, scenario(bad));
    const { exitCode, report } = await run(root, { journey: recordingJourney(calls) });
    assert.equal(exitCode, 1, JSON.stringify(bad));
    assert.equal(report.status, 'failed');
    assert.equal(report.journey.exit.started, false, 'a refused document must start nothing');
    assert.ok(report.observations.every((entry) => entry.status === 'skipped' && entry.reason === 'SCENARIO_REFUSED'));
  }
  assert.deepEqual(calls, [], 'not one journey may run for a refused document');
});

test('a journey the runner does not know is refused, and the known ones are named', async (t) => {
  const calls = [];
  const root = project(t, scenario({ journey: 'something-else' }));
  const { exitCode, report } = await run(root, { journey: recordingJourney(calls) });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  const problem = report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_UNKNOWN');
  assert.ok(problem);
  assert.match(problem.message, /b2b-lead-qualification/);
  assert.match(problem.message, /never name a path or a command/);
});

test('an unreadable, oversized or missing document is exit 2, and distinguishable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dx6-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = await scenarioRunCommand({ scenarioRef: 'nope', rootDir: root, out: () => {}, err: () => {} });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.report, null);

  writeFileSync(join(root, 'broken.scenario.json'), 'not json {');
  const broken = await scenarioRunCommand({ scenarioRef: join(root, 'broken.scenario.json'), rootDir: root, out: () => {}, err: () => {} });
  assert.equal(broken.exitCode, 2);

  writeFileSync(join(root, 'huge.scenario.json'), JSON.stringify({ scenarioContract: 1, pad: 'x'.repeat(70_000) }));
  const huge = await scenarioRunCommand({ scenarioRef: join(root, 'huge.scenario.json'), rootDir: root, out: () => {}, err: () => {} });
  assert.equal(huge.exitCode, 2);
});

test('a bare id resolves inside examples/scenarios and can never traverse', () => {
  assert.deepEqual(resolveScenarioArgument('lead-to-won', '/p'),
    { path: '/p/examples/scenarios/lead-to-won.scenario.json', relative: 'examples/scenarios/lead-to-won.scenario.json', problem: null });
  // Anything with a separator stops being a bare id and becomes an explicit path.
  assert.equal(resolveScenarioArgument('../../etc/passwd', '/p').relative, null);
  assert.ok(resolveScenarioArgument('a b', '/p').problem);
  assert.ok(resolveScenarioArgument('', '/p').problem);
  assert.ok(resolveScenarioArgument(undefined, '/p').problem);
});

// --- DX5 defect 3: recursion ----------------------------------------------------

test('a run that is already inside a run refuses, and executes nothing', async (t) => {
  const root = project(t);
  const calls = [];
  const { exitCode, report } = await run(root, {
    journey: recordingJourney(calls),
    env: { [RECURSION_ENV]: '1' },
  });
  assert.equal(exitCode, 2);
  assert.equal(report, null);
  assert.deepEqual(calls, []);
});

test('the journey child is told it is inside a run, so a nested one refuses', async (t) => {
  const root = project(t);
  const calls = [];
  await run(root, { journey: recordingJourney(calls), env: { PATH: '/usr/bin' } });
  // The runner passes its env through; the child runner is what sets the guard,
  // and runJourney is the single place that spawns.
  assert.equal(calls[0].env.PATH, '/usr/bin');
  const source = readFileSync(new URL('../packages/cli/src/scenario-journey.js', import.meta.url), 'utf8');
  assert.match(source, /\[RECURSION_ENV\]: '1'/);
});

// --- DX5 defect 4: it writes nothing to the project ------------------------------

test('a run writes nothing into the project it reports on', async (t) => {
  const root = project(t);
  const before = readdirSync(root).sort();
  const beforeJobs = statSync(join(repoRoot, 'docs/benchmarks/jobs.json')).mtimeMs;
  await run(root, { journey: recordingJourney([]) });
  assert.deepEqual(readdirSync(root).sort(), before, 'nothing may appear in the project');
  assert.equal(statSync(join(repoRoot, 'docs/benchmarks/jobs.json')).mtimeMs, beforeJobs,
    'the JTBD index is read-only to this command');
});

test('the scratch project the journey composed is removed', async (t) => {
  const root = project(t);
  let scratch = null;
  await run(root, {
    journey: async (options) => {
      scratch = options.projectDir;
      writeFileSync(join(options.projectDir, 'evidence.txt'), 'x');
      return { ok: true, code: 0, signal: null, receipt, output: '', truncated: false, timedOut: false, spawnError: null, durationMs: 1 };
    },
  });
  assert.ok(scratch, 'the journey was given a directory');
  assert.equal(statSync(scratch, { throwIfNoEntry: false }), undefined, 'the scratch project must be removed');
});

// --- DX5 defect 5: redaction, tested in both directions ---------------------------

test('a failure reason keeps its diagnostic and still loses this machine', async (t) => {
  const root = project(t);
  const { report } = await run(root, {
    journey: async () => ({
      ok: false, code: 1, signal: null, receipt: null, truncated: false, timedOut: false, spawnError: null, durationMs: 1,
      output: 'Error: FOREIGN KEY constraint failed: foreign key: fk_quote_version\n',
    }),
  });
  const problem = report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_FAILED');
  // Under-redaction of a diagnostic is a defect: the reason must stay useful.
  assert.match(problem.message, /foreign key: fk_quote_version/);

  const withPath = await run(root, {
    journey: async () => ({
      ok: false, code: 1, signal: null, receipt: null, truncated: false, timedOut: false, spawnError: null, durationMs: 1,
      output: 'Error at /home/José/app/packages/core/thing.js line 4\n',
    }),
  });
  const pathProblem = withPath.report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_FAILED');
  // Over-redaction the other way is also a defect: an unusual path must still go.
  assert.ok(!pathProblem.message.includes('José'), pathProblem.message);
  assert.match(pathProblem.message, /<path>/);
  // The scrubber is the shared one, not a home-grown second copy.
  assert.equal(safeMessage(new Error('/home/José/app/x.js broke'), repoRoot), '<path> broke');
  assert.equal(safeMessage(new Error('foreign key: fk_x'), repoRoot), 'foreign key: fk_x');
});

// --- DX5 defect 6: truncation, UTF-8, and a signal-killed child --------------------

test('a signal-killed journey reports its signal, never "exit null"', async (t) => {
  const root = project(t);
  const { report } = await run(root, {
    journey: async () => ({
      ok: false, code: null, signal: 'SIGKILL', receipt: null, output: '', truncated: false,
      timedOut: false, spawnError: null, durationMs: 1,
    }),
  });
  const problem = report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_FAILED');
  assert.match(problem.message, /killed by SIGKILL/);
  assert.ok(!problem.message.includes('exit null'));
  assert.deepEqual(report.journey.exit, { code: null, signal: 'SIGKILL', timedOut: false, truncated: false, started: true });
});

test('truncation is stated in the report rather than happening silently', async (t) => {
  const root = project(t);
  const { report } = await run(root, {
    journey: async () => ({
      ok: false, code: 1, signal: null, receipt: null, output: 'boom\n', truncated: true,
      timedOut: false, spawnError: null, durationMs: 1,
    }),
  });
  assert.equal(report.journey.exit.truncated, true);
  assert.match(report.problems.find((entry) => entry.code === 'SCENARIO_JOURNEY_FAILED').message, /output truncated/);
});

// --- the child runner itself, against real processes -------------------------------

/** Write a throwaway journey script and run it through the real child runner. */
async function journeyScript(t, body, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dx6-child-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'journey.mjs'), body);
  return runJourney({ rootDir: root, installer: 'journey.mjs', projectDir: root, ...options });
}

test('DX5 defect 1: the child settles on exit, even when a grandchild holds the pipes', async (t) => {
  const started = Date.now();
  const result = await journeyScript(t, `
    import { spawn } from 'node:child_process';
    // A grandchild that inherits these pipes and outlives us. Settling on stream
    // 'close' would wait for it; settling on 'exit' does not.
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit' }).unref();
    console.log(JSON.stringify({ ok: true, leads: 3 }));
  `, { timeoutMs: 30_000 });

  assert.equal(result.ok, true, 'a journey that exits 0 must not be reported as a failure');
  assert.deepEqual(result.receipt, { ok: true, leads: 3 });
  assert.ok(Date.now() - started < 3_500, `settled in ${Date.now() - started}ms, so it did not wait for the grandchild`);
});

test('DX5 defect 6: output is bounded, truncation is flagged, and UTF-8 survives chunking', async (t) => {
  const maxOutput = 16 * 1024;
  const result = await journeyScript(t, `
    // Multi-byte characters, written in pieces so they straddle chunk
    // boundaries — and a single write far larger than the whole budget, which
    // the first draft of the reader dropped entirely instead of bounding.
    const line = 'é'.repeat(4096) + '\\n';
    for (let i = 0; i < 40; i += 1) process.stdout.write(line);
    console.log(JSON.stringify({ ok: true }));
  `, { maxOutput, timeoutMs: 30_000 });

  assert.equal(result.truncated, true, 'the bound must be reported, not applied silently');
  assert.ok(!result.output.includes('�'), 'no character may be corrupted across a chunk boundary');
  assert.ok(result.output.includes('é'), 'a bounded read keeps what fits; it does not discard everything');
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= maxOutput,
    `kept ${Buffer.byteLength(result.output, 'utf8')} bytes, budget ${maxOutput}`);
});

test('a single write larger than the whole budget still leaves a bounded prefix', async (t) => {
  const result = await journeyScript(t, `
    process.stdout.write('é'.repeat(200000));
  `, { maxOutput: 1024, timeoutMs: 30_000 });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length > 0, 'output that vanishes is worse than output that is bounded');
  assert.ok(!result.output.includes('�'));
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= 1024);
});

test('a journey killed by a signal reports the signal, and a timeout stops its group', async (t) => {
  const killed = await journeyScript(t, 'process.kill(process.pid, "SIGKILL");', { timeoutMs: 30_000 });
  assert.equal(killed.ok, false);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(killed.code, null);

  const hung = await journeyScript(t, 'setInterval(() => {}, 1000);', { timeoutMs: 1_000 });
  assert.equal(hung.ok, false);
  assert.equal(hung.timedOut, true);
});

test('a journey whose installer is not in the project is a stated failure, not a crash', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dx6-child-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runJourney({ rootDir: root, installer: 'nowhere/install.mjs', projectDir: root });
  assert.equal(result.ok, false);
  assert.match(result.spawnError, /not in this project/);
});

test('a receipt is the last balanced JSON document, and only numbers become evidence', () => {
  assert.deepEqual(parseTrailingJson('noise\nmore noise\n{"ok":true,"leads":3}'), { ok: true, leads: 3 });
  assert.equal(parseTrailingJson('no json here'), null);
  assert.equal(parseTrailingJson('[1,2,3]'), null, 'a receipt is an object');
  assert.deepEqual(journeyMetrics({ leads: 3, summary: 'prose', ok: true, nested: { a: 1 }, nan: NaN }), { leads: 3 });
  assert.deepEqual(journeyMetrics(JSON.parse('{"__proto__":1,"leads":2}')), { leads: 2 });
});

// --- DX5 defect 2: never recompute what an authority already resolved --------------

test('composition facts are taken verbatim from the AX1 report', async () => {
  const { report } = await inspectOk();
  const index = indexComposition(report);
  assert.deepEqual([...index.packages], ['intelligence']);
  assert.deepEqual([...index.resources], ['enrichment-snapshot']);
  assert.deepEqual([...index.modules], ['lead', 'task']);
  assert.deepEqual([...index.actions], ['lead.qualify']);
  assert.deepEqual(index.capabilities, [{ name: 'intelligence', version: 1, status: 'resolved' }]);
  assert.deepEqual(index.policies, [{ name: 'b2b-fit', version: 1, kind: 'scoring-model' }]);
  // An empty report yields empty sets, never a match.
  const empty = indexComposition(null);
  assert.equal(empty.packages.size, 0);
  assert.equal(empty.capabilities.length, 0);
});

test('a declared but unresolved capability fails rather than counting as available', async (t) => {
  const root = project(t, scenario({
    steps: [{ id: 'compose', narrative: 'n', observe: [{ kind: 'capability.available', capability: 'intelligence', version: 1 }] }],
    claims: [{ job: 'JTBD-04', steps: ['compose'], note: 'n' }],
  }));
  const unresolved = async () => {
    const { report } = await inspectOk();
    report.capabilities = [{ name: 'intelligence', version: 1, provider: 'intelligence', status: 'unresolved', consumers: [] }];
    return { exitCode: 0, report };
  };
  const { exitCode, report } = await run(root, { journey: recordingJourney([]), inspect: unresolved });
  assert.equal(exitCode, 1);
  assert.equal(report.observations[0].status, 'failed');
  assert.equal(report.observations[0].actual, 'unresolved');
});

// --- the real JTBD index -------------------------------------------------------------

test('the real JTBD index loads through its own contract, and is never rewritten', () => {
  const index = loadJobsIndex(repoRoot);
  assert.equal(index.ok, true);
  assert.equal(index.contract, 1);
  assert.ok(index.jobs.size > 100, `expected the full index, got ${index.jobs.size}`);
  assert.equal(index.fingerprint.length, 64);
  // The vocabulary comes from the index, not from this command.
  const published = JSON.parse(readFileSync(join(repoRoot, 'docs/benchmarks/jobs.json'), 'utf8'));
  assert.deepEqual(index.statusVocabulary, published.statusVocabulary);
  for (const outcome of OBSERVATION_STATUSES) {
    assert.ok(!index.statusVocabulary.includes(outcome));
  }
});

test('a project without a JTBD index is reported, not invented', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dx6-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = loadJobsIndex(root);
  assert.equal(index.ok, false);
  assert.equal(index.jobs.size, 0);
  assert.match(index.reason, /not in this project/);
});

// --- one real run, end to end ----------------------------------------------------------

test('the shipped scenario runs for real, and earns exactly what it claims', { timeout: 600_000 }, async () => {
  const { exitCode, report } = await scenarioRunCommand({
    scenarioRef: 'lead-to-won', rootDir: repoRoot, out: () => {}, err: () => {},
  });

  assert.equal(exitCode, 0, `the shipped scenario must pass: ${JSON.stringify(report?.problems)}`);
  assert.equal(report.status, 'passed');
  assert.equal(report.journey.completed, true);
  assert.equal(report.composition.valid, true);
  assert.equal(report.composition.compositionFingerprint.length, 64);

  // Every claim resolved against the real index, and every one is established.
  assert.equal(report.counts.claims.unresolved, 0);
  assert.equal(report.counts.claims.not_established, 0);
  assert.ok(report.jtbd.established.length >= 10, 'the journey earns a real slice of the matrix');

  // The honest negative is the larger number, and it is enumerated.
  assert.equal(report.jtbd.notEstablished.count, report.counts.jobs.total - report.jtbd.established.length);
  assert.ok(report.jtbd.notEstablished.count > report.jtbd.established.length,
    'a scenario that earns a dozen rows and cannot speak to a hundred must say so');
  assert.equal(report.jtbd.notEstablished.jobs.length, report.jtbd.notEstablished.count);

  // A row recorded as partially supported stays partially supported: DX6 reports
  // evidence and never promotes.
  const partial = report.jtbd.claims.find((claim) => claim.recordedStatus === 'partially supported');
  assert.ok(partial, 'the scenario deliberately claims a partially-supported row');
  assert.equal(partial.outcome, 'established');
  assert.equal(report.promotion.performed, false);

  const published = JSON.parse(readFileSync(join(repoRoot, 'docs/benchmarks/jobs.json'), 'utf8'));
  const status = new Map(published.jobs.map((job) => [job.id, job.status]));
  assert.equal(status.get(partial.job), 'partially supported', 'the index must be untouched by the run');
});

// --- the project boundary is canonical, not lexical ---------------------------

test('a cited plan that is a symlink out of the project is refused', (t) => {
  // The guard was `resolve(root, cited).startsWith(root + sep)` — a string
  // comparison, which a symlink walks straight through. `safeRelativePath`
  // cannot catch it either: `docs/plans/x.json` has no `..`, no absolute prefix
  // and no scheme. It is a perfectly well-formed relative path that reads
  // somewhere else. ADR-026 already requires canonicalization before this
  // boundary is enforced; this asserts the scenario runner obeys the same rule.
  const outside = mkdtempSync(join(tmpdir(), 'accordo-scenario-outside-'));
  const root = mkdtempSync(join(tmpdir(), 'accordo-scenario-root-'));
  t.after(() => {
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const secret = join(outside, 'outside.plan.json');
  writeFileSync(secret, JSON.stringify({ solutionPlanContract: 1, id: 'outside', goal: 'not this project' }));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  symlinkSync(secret, join(root, 'docs', 'plans', 'escape.json'));

  const base = { step: 'plan', index: 0, kind: 'plan.valid' };
  const result = planValid(base, { kind: 'plan.valid', plan: 'docs/plans/escape.json' }, root);

  assert.equal(result.status, 'failed');
  assert.equal(result.actual, 'refused');
  assert.match(result.reason, /outside the project/);
  assert.doesNotMatch(JSON.stringify(result), /not this project/, 'nothing from outside the project may reach the report');
});

test('a cited plan reached through a symlink that stays inside the project is still read', (t) => {
  // The fix must refuse the escape, not every link. A link to a file under the
  // same root is inside the boundary and has to keep working, or the rule
  // becomes "no symlinks", which is a different and larger claim.
  const root = mkdtempSync(join(tmpdir(), 'accordo-scenario-inside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'examples'), { recursive: true });
  const real = join(root, 'examples', 'real.plan.json');
  writeFileSync(real, JSON.stringify({ solutionPlanContract: 1, id: 'inside', goal: 'x' }));
  symlinkSync(real, join(root, 'docs', 'plans', 'inside.json'));

  const base = { step: 'plan', index: 0, kind: 'plan.valid' };
  const result = planValid(base, { kind: 'plan.valid', plan: 'docs/plans/inside.json' }, root);

  assert.notEqual(result.actual, 'refused', `an in-project link must not be refused: ${result.reason}`);
});
