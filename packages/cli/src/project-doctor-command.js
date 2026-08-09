// @ts-check

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { bindSolutionPlan, canonicalJson, inspectionFingerprint, parseSolutionPlan } from '../../core/index.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import {
  check, compositionChecks, declaredPlans, discoverCandidatePackages, discoverDocs, discoverPlans,
  docsChecks, hygieneChecks, moduleChecks, packageChecks, planChecks, projectKind,
  resolveComposedPackages, skillChecks, sortChecks,
} from './project-doctor-checks.js';

/**
 * `crm project doctor [--json] [--root <dir>]` — DX1.
 *
 * It answers exactly one question:
 *
 * > **What is structurally inconsistent or stale in this project, before I edit
 * > it or pay for a full verification run?**
 *
 * Five commands, five different questions, and the boundaries are the point:
 *
 * ```text
 * crm app inspect       what is composed?
 * crm project doctor    what is inconsistent or stale in the source?
 * crm package test      does one package satisfy the framework contract?
 * crm solution check    is this plan still compatible with the application?
 * npm run verify        does everything actually work?          (the expensive one)
 * ```
 *
 * **This is not `verify`.** It runs no test, boots no application against a
 * database, and proves nothing about behaviour. The moment it starts doing that
 * it becomes a slower `verify` that people stop running, and the fast check
 * they wanted before touching the repository is gone. DX5 is where an expensive
 * battery belongs.
 *
 * **It is also not `crm doctor`.** That command boots the application, opens
 * the database and reports runtime counts. This one reads source, opens
 * nothing, and works on a project that will not boot — which is precisely when
 * you need it.
 *
 * **Read-only, and isolated where it must execute.** Every check in
 * `project-doctor-checks.js` reads text, JSON or `git ls-files`. The single
 * exception is composition health, which needs the project's checked-in
 * composition imported — and that is delegated to AX1, whose isolated child
 * process already exists for exactly this reason. It is **isolation, not a
 * sandbox**: the child holds this user's authority.
 *
 * That AX1 report is loaded **once** and reused: by the composition checks, by
 * every Solution Plan binding, and for the `inspectionFingerprint` this
 * document carries. `crm solution check` loads its own report per invocation,
 * which is correct for a single plan and would be the wrong shape here.
 */

export const PROJECT_DOCTOR_CONTRACT = 1;

/** The categories, in report order. Every check belongs to exactly one. */
export const CATEGORIES = Object.freeze(['composition', 'packages', 'modules', 'plans', 'skills', 'docs', 'hygiene']);

/**
 * How long the one composition load may take before this command gives up.
 *
 * Deliberately **not** AX1's own 60 s. That bound is right for `app inspect`,
 * where waiting a minute for a real answer beats no answer. It is wrong here:
 * the entire proposition of this command is that it costs ~150 ms and you run
 * it before touching anything, and a composition that hangs would have made it
 * cost a silent minute. Measured before the fix: 60.0 s.
 *
 * Ten seconds is ~65x the observed load on this repository, so a genuinely
 * large composition still answers, and a hang is reported as a hang.
 */
export const COMPOSITION_TIMEOUT_MS = 10_000;

/**
 * What this command cannot prove, stated by code rather than left to a reader's
 * optimism. Each one is a real question somebody will assume was answered.
 */
const LIMITATIONS = Object.freeze([
  ['DOMAIN_CORRECTNESS_NOT_PROVEN', 'nothing here executes an action, evaluates a policy or drives a state transition. A project can be perfectly consistent and compute the wrong number. That is what your own tests are for'],
  ['NOT_A_SUBSTITUTE_FOR_VERIFY', 'no test is run. A green doctor means the source is self-consistent, not that the software works — run `npm run verify` for that'],
  ['DATABASE_NOT_INSPECTED', 'no database is opened. Nothing here says which migrations have been applied to any database, or whether its rows are consistent with the current schema'],
  ['PROVIDER_HEALTH_UNKNOWN', 'no network call is made. A configured provider may be unreachable, unauthorised or returning nonsense, and this command would not know'],
  ['SECRETS_NOT_INSPECTED', 'no environment variable or file content is read for secrets. The hygiene check asks git which paths are tracked; it never opens them'],
  ['PRODUCTION_READINESS_NOT_ASSESSED', 'there is no auth, tenancy or RBAC in this framework, so no report from it can be a production-readiness statement'],
  ['PACKAGE_CONFORMANCE_NOT_RUN', 'packages are checked for the source-boundary rule only. Full conformance means composing and booting each package, which is `crm package test <path>` and is deliberately not run here'],
  ['DISCOVERY_IS_BY_CONVENTION', 'Solution Plans, skills and documentation are found in documented locations only. Something kept elsewhere is not seen, and its absence from this report is not a statement that it is fine'],
  ['UNCOMPOSED_PACKAGES_NOT_CLASSIFIED', 'the packages graded here are the ones the application actually composed, located through the composition file. A directory under packages/ that the composition does not reference is not classified at all: telling kernel code from an unreferenced domain package would mean executing it, and guessing produced a false failure once already. Customer packages under examples/custom-packages are advisory only'],
  ['PLAN_CURRENCY_IS_DECLARED', 'a Solution Plan is graded against this composition only when package.json declares it under agentCrm.solutionPlans. An undeclared plan that no longer binds is reported with its evidence at not_applicable, because a checked-in historical example is documentation rather than a claim about the application today'],
  ['GENERATED_SOURCE_DRIFT_LIMITED', 'generated-source drift is reported only where a checked-in generator contract proves it — module state files and their recorded migration checksums. A hand-edited generated service is not detected by fuzzy comparison, because a fuzzy comparison that cries wolf is a check people learn to ignore'],
  ['NO_MUTATION', 'this command changes nothing. Every finding carries the existing command that would fix it, and there is no --fix'],
]);

/**
 * @param {{rootDir: string, json?: boolean, capture?: boolean,
 *   inspect?: typeof inspectApplicationCommand}} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function projectDoctorCommand({ rootDir, json = false, capture = false, inspect = inspectApplicationCommand } = {}) {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  if (!existsSync(root)) {
    if (!capture) process.stderr.write(`Not a directory: ${rootDir}\n`);
    return { exitCode: 2, report: null };
  }

  // A directory that is not an Accordo project at all is exit 2, not a
  // composition failure. Telling somebody their empty folder has an
  // inconsistent composition is the kind of answer that teaches a reader to
  // distrust every other row in the report.
  const kind = projectKind(root);
  if (kind === 'unknown') {
    if (!capture) {
      process.stderr.write(
        `Not an Accordo project: ${rootDir}\n`
        + 'Expected a package.json, or the packages/ tree of the framework repository.\n',
      );
    }
    return { exitCode: 2, report: null };
  }

  // One load, reused everywhere. A doctor that imported the composition once
  // per plan would be slower than the verification it exists to run before.
  let inspection = null;
  let inspectionFailure = null;
  try {
    const result = await inspect({ rootDir: root, json: true, capture: true, timeoutMs: COMPOSITION_TIMEOUT_MS });
    inspection = result.report;
    if (!inspection) {
      inspectionFailure = `the project composition could not be read within ${COMPOSITION_TIMEOUT_MS / 1000}s `
        + '(it may import something that never returns) — run `crm app inspect --json`, which waits longer';
    }
  } catch (error) {
    inspectionFailure = error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'the composition could not be read';
  }

  const composedNames = (inspection?.packages ?? []).map((entry) => entry.name).filter((name) => typeof name === 'string');
  const { resolved: composed, unresolved } = resolveComposedPackages({ rootDir: root, composed: composedNames });
  const candidates = discoverCandidatePackages(root);
  const plans = discoverPlans(root);
  const declared = declaredPlans(root);
  const docs = discoverDocs(root);

  const checks = sortChecks([
    ...compositionChecks({ report: inspection, failure: inspectionFailure }),
    ...packageChecks({ rootDir: root, composed, candidates, unresolved }),
    ...moduleChecks({ rootDir: root }),
    ...planChecks({ rootDir: root, report: inspection, plans, declared, parse: parseSolutionPlan, bind: bindSolutionPlan }),
    ...skillChecks({ rootDir: root }),
    ...docsChecks({ rootDir: root, docs }),
    ...hygieneChecks({ rootDir: root }),
  ]);

  const counts = {
    passed: checks.filter((entry) => entry.status === 'passed').length,
    warning: checks.filter((entry) => entry.status === 'warning').length,
    failed: checks.filter((entry) => entry.status === 'failed').length,
    not_applicable: checks.filter((entry) => entry.status === 'not_applicable').length,
  };
  const status = counts.failed > 0 ? 'failed' : counts.warning > 0 ? 'warning' : 'passed';

  // `problems` is the compact view: every failure, nothing else. It is what a
  // future Context Pack would carry, so it is kept small and stable on purpose.
  const problems = checks
    .filter((entry) => entry.status === 'failed')
    .map((entry) => ({
      code: entry.id, subject: entry.subject, authority: entry.authority,
      evidence: entry.reason, remediation: entry.remediation,
    }));

  const report = {
    projectDoctorContract: PROJECT_DOCTOR_CONTRACT,
    command: 'project:doctor',
    ok: counts.failed === 0,
    status,
    project: {
      // Never the absolute path: this document is written for agents and pasted
      // into issues, and the operator's home directory is not diagnostic.
      kind,
      // Three states, not two. An earlier draft said `readable` whenever AX1
      // answered at all — which it does even for a composition file that throws
      // on import, because reporting that failure *is* AX1 working. The field
      // then said "readable" about a project that could not load, which is the
      // exact misreading a doctor exists to prevent.
      composition: !inspection ? 'unreadable'
        : (inspection.problems ?? []).length === 0 ? 'valid' : 'invalid',
      packagesComposed: composed.map((entry) => entry.path),
      candidatePackages: candidates.map((entry) => entry.path),
      solutionPlansDiscovered: plans.map((entry) => entry.path),
      documentsScanned: docs.length,
    },
    // The AX1 report this run was computed against. Two doctor reports carrying
    // different fingerprints were looking at different applications, and a
    // reader comparing them needs to know that before comparing anything else.
    inspectionFingerprint: inspection ? inspectionFingerprint(inspection) : null,
    categories: CATEGORIES,
    counts,
    checks,
    problems,
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
    evidence: {
      composition: 'crm app inspect --json, loaded once in an isolated child process',
      modules: 'readModuleState (ADR-019): the same authority the module factory evolves from',
      packages: 'the private-import rule shared with crm package validate and crm package test',
      plans: 'bindSolutionPlan (AX2), bound to the single inspection above',
      hygiene: 'git ls-files; no file content is read',
    },
  };
  report.fingerprint = createHash('sha256').update(canonicalJson({
    projectDoctorContract: report.projectDoctorContract,
    status: report.status,
    checks: report.checks,
  })).digest('hex');

  if (!capture) console.log(json ? JSON.stringify(report, null, 2) : renderDoctor(report));
  return { exitCode: counts.failed === 0 ? 0 : 1, report };
}

/** The human view. `--json` is the contract; this is a convenience. */
export function renderDoctor(report) {
  const lines = [];
  lines.push(`Accordo project doctor (contract ${report.projectDoctorContract})`);
  lines.push(`Project: ${report.project.kind} — composition ${report.project.composition}`);
  lines.push(`Status:  ${report.status}  (${report.counts.passed} passed, ${report.counts.warning} warning, ${report.counts.failed} failed, ${report.counts.not_applicable} n/a)`);

  for (const category of report.categories) {
    const rows = report.checks.filter((entry) => entry.category === category);
    if (rows.length === 0) continue;
    lines.push('', category);
    for (const row of rows) {
      const subject = row.subject ? ` ${row.subject}` : '';
      const reason = row.reason ? ` — ${row.reason}` : row.status === 'not_applicable' && row.reason ? ` — ${row.reason}` : '';
      lines.push(`  ${row.status.padEnd(14)} ${row.id}${subject}${reason}`);
    }
  }

  if (report.problems.length > 0) {
    lines.push('', 'What to do');
    for (const problem of report.problems) {
      lines.push(`  [${problem.code}] ${problem.evidence ?? ''}`);
      if (problem.remediation) lines.push(`      ${problem.remediation}`);
    }
  }

  lines.push('', 'What this does not prove');
  for (const limitation of report.limitations) lines.push(`  [${limitation.code}] ${limitation.message}`);
  lines.push('', 'Run with --json for the machine-readable report — this view is a convenience, not the contract.');
  return lines.join('\n');
}

export { check };
