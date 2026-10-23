// @ts-check

/**
 * Repin the checked-in verifier fixture (`verifier-fixture-exit-zero`) to the
 * live composition.
 *
 *   node scripts/repin-verifier-fixture.js                       recompute the three pins and rewrite the two files
 *   node scripts/repin-verifier-fixture.js --check                fail when the checked-in pins drifted (the PR fast gate)
 *   node scripts/repin-verifier-fixture.js --root <dir>           run the authorities against another checkout
 *   node scripts/repin-verifier-fixture.js --plan <path> --evidence <path>
 *     read and write copies instead of the checked-in files (tests)
 *
 * ## The failure this exists to close
 *
 * `tests/solution-verify.test.js` keeps one fixture at exit 0 through the
 * real command: a real plan, a real evidence document, the real AX1 report
 * and a real scenario run. The plan and the evidence pin the composition they
 * were written against (`plan.application.inspectionFingerprint`,
 * `evidence.applicationInspectionFingerprint`, `evidence.planFingerprint`),
 * and every change to the composed application — a new package, a new
 * action, a record that gained a field — moves the live composition. Three
 * times (#255, #320, #334) the fixture went red on main the night after such
 * a change, because the verify job runs only on main and the fix was a
 * hand-edit of three fingerprints. The pins stay — checked-in evidence of a
 * composition nobody inspected proves nothing — but refreshing them is this
 * command, and the PR fast gate fails `--check` instead of main failing at
 * night.
 *
 * What it does: runs the scenario the fixture is bound to
 * (`service-sla-escalation`) through `scenarioRunCommand`, takes the
 * composition fingerprint the run itself reports, pins the plan to it,
 * recomputes the plan fingerprint with `fingerprintPlan` exactly as the
 * verifier does, and pins the evidence to both. It refuses (exit 2, nothing
 * written) when the scenario produces no composition, or when the repinned
 * plan would be invalid: a repin that cannot be verified is not a repin.
 *
 * Not an Accordo rail, not a product command, not part of the surface
 * budget. It never leaves this repository. It writes only the two fixture
 * files (or the `--plan`/`--evidence` copies), calls no model, publishes
 * nothing and changes no product code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scenarioRunCommand } from '../packages/cli/src/scenario-run-command.js';
import { fingerprintPlan, validateSolutionPlan } from '../packages/core/src/solution-plan.js';
import { validateImplementationEvidence } from '../packages/core/src/implementation-evidence.js';

export const REPIN_VERIFIER_FIXTURE_CONTRACT = 1;

/** The scenario the fixture is bound to (`report.binding.boundTo`). */
export const VERIFIER_FIXTURE_SCENARIO = 'service-sla-escalation';

/** The checked-in documents, relative to the repository root. */
export const VERIFIER_FIXTURE_PLAN = 'examples/solution-plans/verifier-fixture-exit-zero.plan.json';
export const VERIFIER_FIXTURE_EVIDENCE = 'examples/implementation-evidence/verifier-fixture-exit-zero.evidence.json';

const sink = () => {};

/**
 * @param {{rootDir?: string, planPath?: string, evidencePath?: string, check?: boolean,
 *   scenario?: Function, out?: (text: string) => void, err?: (text: string) => void}} options
 * @returns {Promise<{exitCode: number, compositionFingerprint: string|null, drifted: string[], wrote: string[]}>}
 */
export async function repinVerifierFixture({
  rootDir = process.cwd(),
  planPath = VERIFIER_FIXTURE_PLAN,
  evidencePath = VERIFIER_FIXTURE_EVIDENCE,
  check = false,
  scenario = scenarioRunCommand,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  const root = resolve(rootDir);
  // Absolute paths point at copies (the tests); relative paths resolve under
  // the root the authorities run against.
  const planFile = isAbsolute(planPath) ? planPath : join(root, planPath);
  const evidenceFile = isAbsolute(evidencePath) ? evidencePath : join(root, evidencePath);
  let planRaw;
  let evidenceRaw;
  try {
    planRaw = JSON.parse(readFileSync(planFile, 'utf8'));
    evidenceRaw = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  } catch (error) {
    err(`repin-verifier-fixture: cannot read the fixture documents: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2, compositionFingerprint: null, drifted: [], wrote: [] };
  }

  // The authority, not an assertion: the composition the scenario composes
  // right now, reported by the run itself.
  const result = await scenario({ scenarioRef: VERIFIER_FIXTURE_SCENARIO, rootDir: root, json: true, out: sink, err: sink, env: process.env });
  const compositionFingerprint = result?.report?.composition?.compositionFingerprint ?? null;
  if (typeof compositionFingerprint !== 'string' || compositionFingerprint === '') {
    err(`repin-verifier-fixture: the scenario "${VERIFIER_FIXTURE_SCENARIO}" produced no composition, so nothing was repinned.\n`);
    return { exitCode: 2, compositionFingerprint: null, drifted: [], wrote: [] };
  }

  const repinnedPlan = {
    ...planRaw,
    application: { ...planRaw.application, inspectionFingerprint: compositionFingerprint },
  };
  const planResult = validateSolutionPlan(repinnedPlan);
  if (!planResult.valid) {
    err(`repin-verifier-fixture: the repinned plan is invalid, so nothing was repinned: ${planResult.problems.map((problem) => problem.message).join('; ')}\n`);
    return { exitCode: 2, compositionFingerprint, drifted: [], wrote: [] };
  }
  const planFingerprint = fingerprintPlan(planResult.plan);
  const repinnedEvidence = {
    ...evidenceRaw,
    applicationInspectionFingerprint: compositionFingerprint,
    planFingerprint,
  };
  const evidenceResult = validateImplementationEvidence(repinnedEvidence);
  if (!evidenceResult.valid) {
    err(`repin-verifier-fixture: the repinned evidence is invalid, so nothing was repinned: ${evidenceResult.problems.map((problem) => problem.message).join('; ')}\n`);
    return { exitCode: 2, compositionFingerprint, drifted: [], wrote: [] };
  }

  /** @type {string[]} */
  const drifted = [];
  if (planRaw?.application?.inspectionFingerprint !== compositionFingerprint) drifted.push(`${planPath}#application.inspectionFingerprint`);
  if (evidenceRaw?.applicationInspectionFingerprint !== compositionFingerprint) drifted.push(`${evidencePath}#applicationInspectionFingerprint`);
  if (evidenceRaw?.planFingerprint !== planFingerprint) drifted.push(`${evidencePath}#planFingerprint`);

  if (check) {
    if (drifted.length === 0) {
      out(`repin-verifier-fixture --check: the fixture pins the live composition ${compositionFingerprint.slice(0, 16)}….\n`);
      return { exitCode: 0, compositionFingerprint, drifted, wrote: [] };
    }
    err(`repin-verifier-fixture --check: the fixture drifted from the live composition ${compositionFingerprint.slice(0, 16)}…:\n`);
    for (const field of drifted) err(`  drifted ${field}\n`);
    err(`Run \`npm run repin:verifier-fixture\` and commit the two fixture files.\n`);
    return { exitCode: 1, compositionFingerprint, drifted, wrote: [] };
  }

  if (drifted.length === 0) {
    out(`repin-verifier-fixture: already current at ${compositionFingerprint.slice(0, 16)}…; nothing written.\n`);
    return { exitCode: 0, compositionFingerprint, drifted, wrote: [] };
  }
  writeFileSync(planFile, `${JSON.stringify(repinnedPlan, null, 2)}\n`);
  writeFileSync(evidenceFile, `${JSON.stringify(repinnedEvidence, null, 2)}\n`);
  out(`repin-verifier-fixture: repinned to ${compositionFingerprint.slice(0, 16)}… (${drifted.length} field(s) in ${planPath}, ${evidencePath}).\n`);
  return { exitCode: 0, compositionFingerprint, drifted, wrote: [planPath, evidencePath] };
}

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    root: flagValue(argv, '--root'),
    plan: flagValue(argv, '--plan'),
    evidence: flagValue(argv, '--evidence'),
  };
}

/** @param {string[]} argv */
function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/repin-verifier-fixture.js [--check] [--root <dir>] [--plan <path>] [--evidence <path>]\n');
    process.exit(0);
  }
  const args = parseArgs(argv);
  if ((args.root !== null && args.root === '') || (args.plan !== null && args.plan === '') || (args.evidence !== null && args.evidence === '')) {
    process.stderr.write('repin-verifier-fixture: a flag value is missing.\n');
    process.exit(2);
  }
  const result = await repinVerifierFixture({
    ...(args.root !== null ? { rootDir: args.root } : {}),
    ...(args.plan !== null ? { planPath: args.plan } : {}),
    ...(args.evidence !== null ? { evidencePath: args.evidence } : {}),
    check: args.check,
  });
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`repin-verifier-fixture: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
