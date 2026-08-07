// @ts-check

/**
 * Scores one Edition L benchmark run against gates G1–G4.
 *
 *   node benchmarks/harness/score.js <runDir>            JSON on stdout, summary on stderr
 *   node benchmarks/harness/score.js <runDir> --quiet    JSON only
 *
 * Three design decisions, each of which exists because the obvious alternative was wrong.
 *
 * **Points out of 75, never a percentage.** The four local gates carry their original protocol
 * weights — G1 25, G2 15, G3 25, G4 10 — and are not renormalised. Renormalising produces
 * 33.3/20/33.3/13.3, which does not sum to 100 and invites a rounding convention nobody will
 * remember. A point total is also not a success rate, so it cannot be mistaken for one, and it
 * does not need to slip past the published-percentage guard in scripts/site-check.js — routing
 * around that guard would weaken it in spirit even if the regex never noticed.
 *
 * **A gate that could not be checked is never a pass.** Each gate returns `pass`, `fail` or
 * `needs-operator`, and only `pass` earns points. `promptPassed` requires all four to pass,
 * because the protocol's per-prompt verdict is binary and independent of the point total: a run
 * scoring 65 of 75 that misses G3 is a failed prompt, and the two numbers must never be
 * substituted for one another.
 *
 * **G1 is an input, not a judgement.** It asks whether the agent finished without human code
 * edits, and the only witness is the operator. So it is read from the run's append-only
 * intervention record: zero interventions is a pass, one or more is a fail, and *no record at
 * all* is `needs-operator`. Making G1 permanently unjudgeable would reproduce, one layer down,
 * the exact structural zero that Edition L exists to remove — and it would do it quietly.
 *
 * G1 remains operator-attested, which is a real limit on what this instrument can prove. It is
 * stated in the output of every run rather than left for a reader to work out.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The four local gates and their protocol weights. They sum to 75 and are not renormalised. */
export const EDITION_L_GATES = Object.freeze([
  { id: 'G1', weight: 25, title: 'Build completes without user code edits' },
  { id: 'G2', weight: 15, title: 'Domain model correct' },
  { id: 'G3', weight: 25, title: 'Process rules correct including boundaries' },
  { id: 'G4', weight: 10, title: 'Verify suite green' },
]);

export const EDITION_L_TOTAL = EDITION_L_GATES.reduce((sum, gate) => sum + gate.weight, 0);

/** Gates that exist in the protocol and cannot be scored without a production spine. */
export const EDITION_D_GATES = Object.freeze([
  { id: 'G5', weight: 15, title: 'Deployed smoke check green' },
  { id: 'G6', weight: 10, title: 'Trace/audit inspectable on a deployed instance' },
]);

// Importable: the CLI runs only when this file is the entry point, so tests can call
// scoreRun() without the argument parser exiting the process out from under them.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const runDir = process.argv[2];
  const quiet = process.argv.includes('--quiet');

  if (!runDir || runDir.startsWith('--')) {
    process.stderr.write('usage: node benchmarks/harness/score.js <runDir> [--quiet]\n');
    process.exit(2);
  }
  if (!existsSync(runDir)) {
    process.stderr.write(`score: ${runDir} does not exist\n`);
    process.exit(2);
  }

  const result = scoreRun(runDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!quiet) {
    const say = (line = '') => process.stderr.write(`${line}\n`);
    say();
    say(`  Edition L — ${result.promptId ?? 'unknown prompt'}  (run ${result.runId ?? 'unrecorded'})`);
    say();
    for (const gate of result.gates) {
      const mark = gate.outcome === 'pass' ? '✓' : gate.outcome === 'fail' ? '✗' : '?';
      say(`  ${mark} ${gate.id}  ${String(gate.earned).padStart(2)}/${gate.weight}  ${gate.title}`);
      say(`       ${gate.why}`);
    }
    say();
    say(`  ${result.points} of ${EDITION_L_TOTAL} points · prompt ${result.promptPassed ? 'PASSED' : 'FAILED'}`);
    say(`  G5 and G6 not run: ${result.editionD.reason}`);
    say();
    say(`  ${result.attestation}`);
    say();
  }

  process.exit(result.scoreable ? 0 : 1);
}

/**
 * @param {string} directory
 */
export function scoreRun(directory) {
  const record = readRunRecord(directory);
  const projectDir = existsSync(join(directory, 'project')) ? join(directory, 'project') : directory;
  const prompt = findPrompt(record?.promptId);

  const gates = [
    gateOne(record),
    gateTwo(projectDir, prompt),
    gateThree(projectDir, prompt),
    gateFour(projectDir),
  ];

  const points = gates.reduce((sum, gate) => sum + gate.earned, 0);

  return {
    editionLContract: 1,
    edition: 'L',
    gateSet: 'G1-G4',
    runId: record?.runId ?? null,
    promptId: record?.promptId ?? null,
    frameworkSha: record?.frameworkSha ?? null,
    agentProduct: record?.agentProduct ?? null,
    modelVersion: record?.modelVersion ?? null,
    gates,
    points,
    pointsAvailable: EDITION_L_TOTAL,
    // Binary and deliberately separate from the point total.
    promptPassed: gates.every((gate) => gate.outcome === 'pass'),
    scoreable: gates.every((gate) => gate.outcome !== 'needs-operator'),
    editionD: {
      gates: EDITION_D_GATES.map((gate) => gate.id),
      outcome: 'BLOCKED_NO_PRODUCTION_SPINE',
      reason:
        'G5 and G6 require a public deployment. This framework has no authentication, tenancy or '
        + 'RBAC, and reports productionPosture "local development only". They are not run, not '
        + 'estimated, and never omitted from a report.',
    },
    attestation:
      'G1 is operator-attested: it is read from the run\'s intervention record, not measured. Any '
      + 'Edition L figure derived from these runs must say so in the same breath.',
  };
}

/** @param {string} directory */
function readRunRecord(directory) {
  const path = join(directory, 'run.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string | null | undefined} promptId */
function findPrompt(promptId) {
  const path = join(process.cwd(), 'benchmarks/harness/prompts.json');
  if (!promptId || !existsSync(path)) return null;
  const document = JSON.parse(readFileSync(path, 'utf8'));
  return document.prompts.find((/** @type {any} */ entry) => entry.id === promptId) ?? null;
}

/**
 * G1 — read from the record, because the operator is the only witness.
 * @param {any} record
 */
function gateOne(record) {
  const gate = { ...EDITION_L_GATES[0], outcome: 'needs-operator', earned: 0, why: '' };
  if (!record || !Array.isArray(record.interventions)) {
    gate.why = 'No run.json with an interventions array. Nothing attests to whether a human edited files.';
    return gate;
  }
  const count = record.interventions.length;
  if (count === 0) {
    gate.outcome = 'pass';
    gate.earned = gate.weight;
    gate.why = 'The record contains no interventions. Operator-attested, not measured.';
    return gate;
  }
  gate.outcome = 'fail';
  gate.why = `${count} intervention${count === 1 ? '' : 's'} recorded: `
    + record.interventions.map((/** @type {any} */ item) => item.reason ?? 'unstated').join('; ');
  return gate;
}

/**
 * G2 — what the composed application actually contains, read from the framework's own
 * inspection command. The prompt's expected-output highlight is prose written for a human
 * reviewer, so anything it asserts beyond "something was composed" is left to the operator.
 * @param {string} projectDir
 * @param {any} prompt
 */
function gateTwo(projectDir, prompt) {
  const gate = { ...EDITION_L_GATES[1], outcome: 'needs-operator', earned: 0, why: '' };
  const cli = findCli(projectDir);
  if (!cli) {
    gate.outcome = 'fail';
    gate.why = 'No CLI in the run project, so nothing was composed from the framework.';
    return gate;
  }

  const inspect = spawnSync(
    process.execPath,
    ['--no-warnings', cli, 'app', 'inspect', '--json', '--root', projectDir],
    { encoding: 'utf8', cwd: projectDir, timeout: 120_000 },
  );
  const report = parseTrailingJson(inspect.stdout ?? '');
  if (!report) {
    gate.outcome = 'fail';
    gate.why = `app inspect produced no parseable report (exit ${inspect.status}).`;
    return gate;
  }

  const counts = {
    modules: report.modules?.length ?? 0,
    resources: report.resources?.length ?? 0,
    actions: report.actions?.length ?? 0,
  };
  const composed = counts.modules + counts.resources + counts.actions;
  if (composed === 0) {
    gate.outcome = 'fail';
    gate.why = 'The composed application is empty: no modules, resources or actions.';
    return gate;
  }

  gate.why =
    `Composed ${counts.modules} modules, ${counts.resources} resources, ${counts.actions} actions. `
    + `Whether that matches the brief — "${prompt?.expect ?? 'no expectation on file'}" — is a `
    + 'judgement this scorer does not make.';
  return gate;
}

/**
 * G3 — the gate that bites. The protocol says "incl. boundaries", so a green suite that never
 * asserts at the stated boundary fails: a rule with no test at its edge is a rule nobody checked.
 * @param {string} projectDir
 * @param {any} prompt
 */
function gateThree(projectDir, prompt) {
  const gate = { ...EDITION_L_GATES[2], outcome: 'needs-operator', earned: 0, why: '' };
  if (!prompt) {
    gate.why = 'No prompt on file for this run, so no boundary is known to look for.';
    return gate;
  }

  const boundaries = boundaryTokens(`${prompt.brief} ${prompt.expect}`);
  if (boundaries.length === 0) {
    gate.why =
      'This prompt states no numeric boundary, so whether its process rules are correct is a '
      + 'judgement an operator has to make against the transcript.';
    return gate;
  }

  const tests = collectTests(projectDir);
  if (tests.length === 0) {
    gate.outcome = 'fail';
    gate.why = `The run project contains no test files, so the boundary (${boundaries.join(', ')}) is unasserted.`;
    return gate;
  }

  const corpus = tests.map((path) => readFileSync(path, 'utf8')).join('\n');
  const found = boundaries.filter((token) => corpus.includes(token));
  const missing = boundaries.filter((token) => !corpus.includes(token));

  if (missing.length > 0) {
    gate.outcome = 'fail';
    gate.why =
      `The prompt states a boundary at ${boundaries.join(' / ')} and no test asserts `
      + `${missing.join(' / ')}. A green suite that never tests the edge has not tested the rule.`;
    return gate;
  }

  gate.outcome = 'pass';
  gate.earned = gate.weight;
  gate.why = `Boundary values ${found.join(' / ')} appear in ${tests.length} test file(s).`;
  return gate;
}

/**
 * G4 — objective. The project's own suite, exit 0 or nothing.
 * @param {string} projectDir
 */
function gateFour(projectDir) {
  const gate = { ...EDITION_L_GATES[3], outcome: 'needs-operator', earned: 0, why: '' };
  if (!existsSync(join(projectDir, 'package.json'))) {
    gate.outcome = 'fail';
    gate.why = 'No package.json in the run project, so there is no suite to run.';
    return gate;
  }

  const run = spawnSync('npm', ['test', '--silent'], {
    encoding: 'utf8',
    cwd: projectDir,
    timeout: 900_000,
    env: { ...process.env, npm_config_yes: 'true' },
  });

  if (run.status === 0) {
    gate.outcome = 'pass';
    gate.earned = gate.weight;
    gate.why = 'The run project\'s own test suite exits 0.';
    return gate;
  }
  gate.outcome = 'fail';
  gate.why = `The run project's test suite exits ${run.status}.`;
  return gate;
}

/**
 * The cent values a test must name to have actually tested the edge.
 *
 * Every currency amount the prompt states is required, in integer cents, because this framework
 * stores money in cents — a test proving the €25,000 boundary says 2500000, not 25000.
 *
 * When the prompt states only *one* amount, the value one cent below it is required too:
 * asserting that €25,000 needs approval proves nothing on its own unless something just under it
 * does not. When the prompt already states both sides — P02's expected output names
 * €24,999/€25,000 — both are simply required, and no third phantom boundary is derived from the
 * lower one.
 *
 * @param {string} text
 * @returns {string[]} cent values, as strings, that must appear in the run's tests
 */
export function boundaryTokens(text) {
  /** @type {number[]} */
  const stated = [];
  for (const match of text.matchAll(/[€$£]\s?([\d][\d.,]*)\s*(k\b)?/gi)) {
    const raw = match[1].replace(/[.,](?=\d{3}\b)/g, '').replace(/,/g, '.');
    let amount = Number.parseFloat(raw);
    if (!Number.isFinite(amount)) continue;
    if (match[2]) amount *= 1000;
    stated.push(Math.round(amount * 100));
  }

  const unique = [...new Set(stated)];
  if (unique.length === 0) return [];
  if (unique.length === 1) return [String(unique[0]), String(unique[0] - 100)];
  return unique.map(String);
}

/** @param {string} projectDir */
function collectTests(projectDir) {
  /** @type {string[]} */
  const found = [];
  const skip = new Set(['node_modules', '.git', 'data', 'dist']);
  const walk = (/** @type {string} */ directory) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (skip.has(name)) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.test\.(js|mjs)$/.test(name)) found.push(path);
    }
  };
  walk(projectDir);
  return found;
}

/**
 * The CLI entry point, taken from the project's own `bin` declaration.
 *
 * Not the first file in packages/cli/bin: that directory holds more than one executable, and
 * picking alphabetically selected a helper that does not accept `app inspect` and exited 2 —
 * which the scorer then reported as "nothing was composed". Reading `bin` is also rename-proof,
 * which matters in a repository whose binary is named after the brand.
 *
 * @param {string} projectDir
 */
function findCli(projectDir) {
  const manifestPath = join(projectDir, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const declared = typeof bin === 'string' ? bin : Object.values(bin ?? {})[0];
      if (typeof declared === 'string') {
        const path = join(projectDir, declared.replace(/^\.\//, ''));
        if (existsSync(path)) return path;
      }
    } catch {
      // fall through to the directory scan
    }
  }

  const binDir = join(projectDir, 'packages', 'cli', 'bin');
  if (!existsSync(binDir)) return null;
  const candidates = readdirSync(binDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('-'))
    .map((entry) => join(binDir, entry.name));
  return candidates[0] ?? null;
}

/** @param {string} text */
function parseTrailingJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  for (const candidate of [text.slice(start === -1 ? text.indexOf('{') : start + 1), text]) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // next
    }
  }
  return null;
}
