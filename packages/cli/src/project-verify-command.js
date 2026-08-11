// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson } from '../../core/index.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { projectDoctorCommand } from './project-doctor-command.js';
import { discoverCandidatePackages, projectKind, resolveComposedPackages } from './project-doctor-checks.js';

/**
 * `crm project verify [--json] [--root <dir>]` — DX5.
 *
 * > **Can you prove this project is healthy enough to hand back after a
 * > coding-agent change?**
 *
 * DX1 answers *what is inconsistent in the source*, cheaply, before you edit.
 * This is the expensive counterpart: it **runs the evidence** and reports which
 * authority refused.
 *
 * ```text
 * crm project doctor    source coherence, read-only, sub-second   DX1
 * crm project verify    orchestrated evidence, minutes            DX5
 * ```
 *
 * **It is an orchestrator, not a task runner.** Every check delegates to
 * something that already decides — the doctor, AX1, Solution Plan binding,
 * package conformance, the project's own *declared* scripts. DX5 owns the
 * sequencing, the evidence and the refusal shape, and nothing else. A
 * user-supplied list of shell commands was rejected during design: it would
 * make two projects' reports share a schema and nothing else.
 *
 * **It never guesses a command.** A project that declares no test script gets
 * `not_applicable` with a reason, not a hopeful `npm test`.
 *
 * **PROVE is still partial.** Scenario evidence is a separate command
 * (`crm scenario run`, DX6) that this one deliberately does not invoke, and
 * implementation evidence (DX10) does not exist. The report says so in its own
 * limitations rather than letting a green exit code imply completeness.
 */

export const PROJECT_VERIFICATION_CONTRACT = 1;

/** Categories, in report order. Every check belongs to exactly one. */
export const CATEGORIES = Object.freeze(['structure', 'application', 'plans', 'packages', 'suite', 'worktree']);

/** Every status a check may carry. Closed vocabulary. */
export const STATUSES = Object.freeze(['passed', 'failed', 'warning', 'skipped', 'not_applicable']);

/** How long any single delegated command may run before its group is stopped. */
export const STEP_TIMEOUT_MS = 15 * 60_000;
/** How much of a child's output is retained. Beyond this the tail is dropped. */
export const MAX_CAPTURED_OUTPUT = 64 * 1024;
/** How much of a captured stream reaches the report as a summary. */
export const MAX_SUMMARY = 400;

/**
 * The scripts DX5 will run **if the project declares them**, and the check each
 * one produces. The names are the framework's own conventions; a project that
 * uses different ones simply reports `not_applicable`.
 */
const DECLARED_SCRIPTS = Object.freeze([
  { script: 'verify', code: 'suite.verify', required: true },
  { script: 'smoke', code: 'suite.smoke', required: false },
]);

/**
 * What this command does not prove. Published with every report, because a
 * green exit code that quietly means less than a reader assumes is the failure
 * mode this whole family of commands exists to avoid.
 */
const LIMITATIONS = Object.freeze([
  {
    code: 'BROWSER_EVIDENCE_NOT_AUTOMATED',
    message: 'no browser is driven and no rendered page is checked. Nothing here is evidence about the Admin as a user sees it, and `crm scenario run` does not drive one either',
  },
  {
    code: 'SCENARIO_EVIDENCE_NOT_RUN',
    message: 'no business scenario is executed end to end. A passing suite is not the same as "this works for the customer\'s process" — that is `crm scenario run <scenario> --json`, which is a separate command and is not run from here',
  },
  {
    code: 'IMPLEMENTATION_EVIDENCE_NOT_MAPPED',
    message: 'nothing here maps a plan\'s requirements to the code that implements them, so a green report never means a plan is finished. That is DX10',
  },
  {
    code: 'PROJECT_COMMANDS_TRUSTED',
    message: 'declared project scripts are checked-in source and run with the operator\'s authority. Child isolation bounds a hang and captures output; it is not a filesystem, network or OS sandbox',
  },
  {
    code: 'PROVIDER_HEALTH_UNKNOWN',
    message: 'no external provider is contacted, authenticated or health-checked',
  },
  {
    code: 'PRODUCTION_READINESS_NOT_ASSESSED',
    message: 'there is no auth, tenancy or RBAC in this framework, and nothing here assesses deployment, capacity or operational readiness',
  },
]);

/**
 * @param {{code: string, category: string, status: string, authority: string,
 *   required?: boolean, evidence?: string, reason?: string|null, durationMs?: number}} entry
 */
export function check(entry) {
  if (!CATEGORIES.includes(entry.category)) throw new Error(`unknown category: ${entry.category}`);
  if (!STATUSES.includes(entry.status)) throw new Error(`unknown status: ${entry.status}`);
  return {
    code: entry.code,
    category: entry.category,
    status: entry.status,
    authority: entry.authority,
    required: entry.required ?? false,
    evidence: entry.evidence ?? '',
    reason: entry.reason ?? null,
    // Diagnostic only. Deliberately excluded from the semantic fingerprint:
    // a report that changes because the machine was busy is not comparable.
    durationMs: entry.durationMs ?? null,
  };
}

/**
 * Run one command in its own process group, bounded in time and output.
 *
 * The process group matters: a test suite that spawns a server and leaks it
 * would otherwise outlive the step and hold the run open. Output is capped so a
 * package that floods stdout cannot exhaust memory — and, because the report is
 * built from structured fields rather than from the log, cannot corrupt the
 * JSON document either.
 *
 * @param {{command: string, args: string[], cwd: string, timeoutMs?: number}} options
 */
export function runStep({ command, args, cwd, timeoutMs = STEP_TIMEOUT_MS }) {
  return new Promise((resolveStep) => {
    const started = Date.now();
    let out = '';
    let truncated = false;
    let settled = false;
    /** @type {any} */
    let child;
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveStep({ ok: false, code: null, signal: null, output: '', timedOut: false, truncated: false, durationMs: 0, spawnError: String(/** @type {any} */ (error).message) });
      return;
    }
    const absorb = (chunk) => {
      if (out.length >= MAX_CAPTURED_OUTPUT) { truncated = true; return; }
      out += chunk.toString();
      if (out.length > MAX_CAPTURED_OUTPUT) { out = out.slice(0, MAX_CAPTURED_OUTPUT); truncated = true; }
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);

    const stopGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopGroup();
      resolveStep({ ok: false, code: null, signal: 'SIGKILL', output: out, timedOut: true, truncated, durationMs: Date.now() - started, spawnError: null });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStep({ ok: false, code: null, signal: null, output: out, timedOut: false, truncated, durationMs: Date.now() - started, spawnError: String(error.message) });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStep({ ok: code === 0, code, signal, output: out, timedOut: false, truncated, durationMs: Date.now() - started, spawnError: null });
    });
  });
}

/**
 * A bounded, safe one-line summary of a failed step.
 *
 * Never the whole log: a megabyte of output in a JSON report is not a
 * diagnostic, it is a denial of service on the reader. Absolute paths are
 * relativized so the report does not carry the machine that produced it.
 *
 * @param {string} output @param {string} rootDir
 */
export function summarize(output, rootDir) {
  const lines = String(output).split('\n').map((line) => line.trim()).filter(Boolean);
  // The last lines are where a runner puts its verdict.
  const tail = lines.slice(-6).join(' | ');
  return redact(tail, rootDir).slice(0, MAX_SUMMARY);
}

/**
 * Remove this machine from a string: the project root becomes `.`, any other
 * absolute path is replaced, and anything shaped like an assignment to a
 * secret-ish name is dropped rather than echoed.
 *
 * @param {string} text @param {string} rootDir
 */
export function redact(text, rootDir) {
  let out = String(text).split(rootDir).join('.');
  // Only genuinely ABSOLUTE paths are replaced. A project-relative path is the
  // most useful part of a reason — "./packages/core/src/thing.js" tells a
  // reviewer where to look — so the lookbehind keeps `./a/b` intact while still
  // removing `/usr/lib/...` and any other machine location.
  out = out.replace(/(?<![\w.])(?:\/[\w.@-]+){2,}/g, '<path>');
  out = out.replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=<redacted>');
  return out;
}

/** Which npm scripts the project declares. Never guessed. */
export function declaredScripts(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return new Set(Object.keys(scripts));
  } catch {
    return new Set();
  }
}

/** Tracked source files that differ from HEAD, or null when this is not a git checkout. */
export function trackedChanges(rootDir, run = defaultGit) {
  const result = run(rootDir);
  if (result === null) return null;
  return result.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

/** @param {string} rootDir */
function defaultGit(rootDir) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir, encoding: 'utf8' });
  if (inside.status !== 0) return null;
  const changed = spawnSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: rootDir, encoding: 'utf8' });
  if (changed.status !== 0) return null;
  return changed.stdout ?? '';
}

/**
 * @param {{rootDir?: string, json?: boolean, out?: (text: string) => void,
 *   inspect?: Function, doctor?: Function, step?: Function, git?: Function}} [options]
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function projectVerifyCommand(options = {}) {
  const {
    json = false, out = (text) => process.stdout.write(text),
    inspect = inspectApplicationCommand, doctor = projectDoctorCommand,
    step = runStep, git = defaultGit,
  } = options;
  const rootDir = resolve(options.rootDir ?? process.cwd());

  if (!existsSync(rootDir) || projectKind(rootDir) === 'unknown') {
    return { exitCode: 2, report: null };
  }

  /** @type {any[]} */
  const checks = [];
  /** @type {any[]} */
  const problems = [];
  /** @type {any[]} */
  const evidence = [];

  // ---- 1. structural preflight -------------------------------------------
  // A project whose source the doctor refuses is not worth a fifteen-minute
  // suite: the failure is already known and cheaper to read. Warnings are
  // carried forward rather than blocking, because a mirror-coverage warning is
  // not a reason to refuse to verify.
  const doctorResult = await doctor({ rootDir, json: true, capture: true });
  const doctorReport = doctorResult.report;
  if (doctorResult.exitCode === 2 || !doctorReport) {
    return { exitCode: 2, report: null };
  }
  const doctorFailed = (doctorReport.checks ?? []).filter((entry) => entry.status === 'failed');
  const doctorWarned = (doctorReport.checks ?? []).filter((entry) => entry.status === 'warning');
  checks.push(check({
    code: 'structure.doctor',
    category: 'structure',
    status: doctorFailed.length === 0 ? 'passed' : 'failed',
    authority: 'project-doctor',
    required: true,
    evidence: `crm project doctor: ${doctorFailed.length} failure(s), ${doctorWarned.length} warning(s)`,
    reason: doctorFailed.length === 0 ? null : doctorFailed.map((entry) => entry.id).sort().join(', '),
  }));
  for (const warned of doctorWarned) {
    checks.push(check({
      code: `structure.carried.${warned.id}`,
      category: 'structure',
      status: 'warning',
      authority: 'project-doctor',
      evidence: 'carried from project doctor; not a verification failure',
      reason: warned.reason ?? null,
    }));
  }
  evidence.push({ kind: 'doctor', status: doctorReport.status, fingerprint: doctorReport.fingerprint ?? null });

  const blocked = doctorFailed.length > 0;
  if (blocked) {
    problems.push({
      code: 'PREFLIGHT_FAILED',
      message: 'project doctor reports a structural failure. Verification is not attempted: the cheaper authority already refused, and running a suite over a broken project produces a second, less useful failure',
    });
  }

  // ---- 2. application ------------------------------------------------------
  let inspectionFingerprint = null;
  if (blocked) {
    checks.push(check({
      code: 'application.inspect', category: 'application', status: 'skipped',
      authority: 'app-inspect', required: true, evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
    }));
  } else {
    const inspected = await inspect({ rootDir, json: true, capture: true });
    const report = inspected.report;
    inspectionFingerprint = report?.inspectionFingerprint ?? null;
    const problemCount = (report?.problems ?? []).length;
    checks.push(check({
      code: 'application.inspect',
      category: 'application',
      status: report && inspected.exitCode === 0 && problemCount === 0 ? 'passed' : 'failed',
      authority: 'app-inspect',
      required: true,
      evidence: report ? `${(report.packages ?? []).length} package(s), ${problemCount} problem(s)` : 'no report',
      reason: problemCount === 0 ? null : (report.problems ?? []).map((p) => p.code).sort().join(', '),
    }));
    evidence.push({ kind: 'inspection', fingerprint: inspectionFingerprint });
  }

  // ---- 3. solution plans ---------------------------------------------------
  // DX1 already decides which plans a project declares as current; a historical
  // or design-only plan going stale is a fact, not a fault, and re-deciding
  // that here would be a second opinion nobody asked for.
  const planChecks = (doctorReport.checks ?? []).filter((entry) => entry.id?.startsWith('plans.'));
  const gradedPlans = planChecks.filter((entry) => entry.status === 'failed' || entry.status === 'passed');
  checks.push(check({
    code: 'plans.current',
    category: 'plans',
    status: gradedPlans.length === 0 ? 'not_applicable'
      : gradedPlans.every((entry) => entry.status === 'passed') ? 'passed' : 'failed',
    authority: 'solution-plan',
    required: true,
    evidence: gradedPlans.length === 0
      ? 'this project declares no plan as current'
      : `${gradedPlans.length} declared-current plan(s) graded`,
    reason: gradedPlans.length === 0 ? 'NO_CURRENT_PLANS_DECLARED'
      : gradedPlans.filter((e) => e.status === 'failed').map((e) => e.id).sort().join(', ') || null,
  }));

  // ---- 4. package conformance ---------------------------------------------
  // Composed packages only. A project-owned core module is not a package and
  // must never be graded as one.
  const composedNames = doctorReport.project?.packagesComposed ?? [];
  const { resolved } = resolveComposedPackages({ rootDir, composed: composedNames });
  const candidates = discoverCandidatePackages(rootDir).map((entry) => entry.path);
  const conformanceTargets = resolved.map((entry) => entry.path).filter((path) => existsSync(join(rootDir, path)));

  if (blocked) {
    checks.push(check({
      code: 'packages.conformance', category: 'packages', status: 'skipped', authority: 'package-conformance',
      required: true, evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
    }));
  } else if (conformanceTargets.length === 0) {
    checks.push(check({
      code: 'packages.conformance', category: 'packages', status: 'not_applicable', authority: 'package-conformance',
      required: true,
      evidence: composedNames.length === 0
        ? 'this project composes no package'
        : `${composedNames.length} composed package(s), none with local source in this project`,
      reason: composedNames.length === 0 ? 'NO_PACKAGES_COMPOSED' : 'NO_LOCAL_PACKAGE_SOURCE',
    }));
  } else {
    for (const path of conformanceTargets) {
      const result = await step({
        command: process.execPath,
        args: ['--no-warnings', join(rootDir, 'packages/cli/bin/accordo.js'), 'package', 'test', path, '--json', '--root', rootDir],
        cwd: rootDir,
      });
      checks.push(check({
        code: `packages.conformance.${path}`,
        category: 'packages',
        status: result.ok ? 'passed' : 'failed',
        authority: 'package-conformance',
        required: true,
        evidence: `crm package test ${path}`,
        reason: result.ok ? null : stepReason(result, rootDir),
        durationMs: result.durationMs,
      }));
    }
  }
  if (candidates.length > conformanceTargets.length) {
    evidence.push({
      kind: 'packages',
      composed: [...composedNames].sort(),
      uncomposedCandidates: candidates.filter((path) => !conformanceTargets.includes(path)).sort(),
      note: 'an uncomposed package is inventory, not a verification target',
    });
  }

  // ---- 5. the project's own declared suites --------------------------------
  const scripts = declaredScripts(rootDir);
  for (const { script, code, required } of DECLARED_SCRIPTS) {
    if (!scripts.has(script)) {
      checks.push(check({
        code, category: 'suite', status: 'not_applicable', authority: 'project-script', required,
        evidence: `this project declares no "${script}" script`, reason: 'SCRIPT_NOT_DECLARED',
      }));
      continue;
    }
    if (blocked) {
      checks.push(check({
        code, category: 'suite', status: 'skipped', authority: 'project-script', required,
        evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
      }));
      continue;
    }
    const result = await step({ command: 'npm', args: ['run', script, '--silent'], cwd: rootDir });
    checks.push(check({
      code,
      category: 'suite',
      status: result.ok ? 'passed' : 'failed',
      authority: 'project-script',
      required,
      evidence: `npm run ${script}`,
      reason: result.ok ? null : stepReason(result, rootDir),
      durationMs: result.durationMs,
    }));
  }

  // ---- 6. the worktree this command promised not to change -----------------
  const changed = trackedChanges(rootDir, git);
  if (changed === null) {
    checks.push(check({
      code: 'worktree.clean', category: 'worktree', status: 'not_applicable', authority: 'git',
      evidence: 'not a git checkout, so "changed since HEAD" has no meaning here', reason: 'NOT_A_GIT_CHECKOUT',
    }));
  } else if (changed.length === 0) {
    checks.push(check({
      code: 'worktree.clean', category: 'worktree', status: 'passed', authority: 'git',
      evidence: 'no tracked source changed while verifying',
    }));
  } else {
    // Reported, never repaired. A verification command that silently resets the
    // thing it is verifying is worse than one that tells you.
    checks.push(check({
      code: 'worktree.clean', category: 'worktree', status: 'warning', authority: 'git',
      evidence: `${changed.length} tracked file(s) differ from HEAD after verifying`,
      reason: changed.slice(0, 10).join(', '),
    }));
    problems.push({
      code: 'WORKTREE_DIRTY_AFTER_VERIFY',
      message: 'tracked source differs from HEAD after the run. Verification does not intentionally edit source, so either a suite writes into the project or the tree was already dirty. Nothing was reset, stashed or hidden',
    });
  }

  const counts = tally(checks);
  const requiredFailed = checks.some((entry) => entry.required && entry.status === 'failed');
  const status = requiredFailed ? 'failed' : counts.warning > 0 ? 'warning' : 'passed';

  const report = {
    projectVerificationContract: PROJECT_VERIFICATION_CONTRACT,
    command: 'project:verify',
    project: {
      kind: projectKind(rootDir),
      packagesComposed: [...composedNames].sort(),
      declaredScripts: [...scripts].filter((name) => DECLARED_SCRIPTS.some((s) => s.script === name)).sort(),
    },
    inspectionFingerprint,
    status,
    counts,
    checks: sortChecks(checks),
    problems: problems.sort((a, b) => (a.code < b.code ? -1 : 1)),
    limitations: [...LIMITATIONS],
    evidence,
    fingerprint: '',
  };
  report.fingerprint = semanticFingerprint(report);

  if (json) out(`${JSON.stringify(report, null, 2)}\n`);
  else out(render(report));

  return { exitCode: status === 'failed' ? 1 : 0, report };
}

/** @param {any} result @param {string} rootDir */
function stepReason(result, rootDir) {
  if (result.spawnError) return `could not start: ${redact(result.spawnError, rootDir)}`;
  if (result.timedOut) return `timed out after ${STEP_TIMEOUT_MS}ms; its process group was stopped`;
  const summary = summarize(result.output, rootDir);
  return `exit ${result.code}${summary ? `: ${summary}` : ''}${result.truncated ? ' [output truncated]' : ''}`;
}

/** @param {any[]} checks */
function tally(checks) {
  const counts = { passed: 0, failed: 0, warning: 0, skipped: 0, not_applicable: 0 };
  for (const entry of checks) counts[entry.status] += 1;
  return counts;
}

/** @param {any[]} checks */
export function sortChecks(checks) {
  return [...checks].sort((a, b) => {
    const byCategory = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    return byCategory !== 0 ? byCategory : (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  });
}

/**
 * The semantic fingerprint: what the run *decided*, never how long it took or
 * where it ran. Two runs of an unchanged project must produce the same value
 * from different directories on different machines.
 *
 * @param {any} report
 */
export function semanticFingerprint(report) {
  const semantic = {
    projectVerificationContract: report.projectVerificationContract,
    status: report.status,
    inspectionFingerprint: report.inspectionFingerprint,
    project: report.project,
    checks: report.checks.map((entry) => ({
      code: entry.code, category: entry.category, status: entry.status,
      authority: entry.authority, required: entry.required,
    })),
    problems: report.problems.map((entry) => entry.code),
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

/** @param {any} report */
function render(report) {
  const lines = [];
  lines.push(`Accordo project verify (contract ${report.projectVerificationContract})`);
  lines.push(`status: ${report.status}`);
  lines.push('');
  for (const category of CATEGORIES) {
    const rows = report.checks.filter((entry) => entry.category === category);
    if (rows.length === 0) continue;
    lines.push(`${category}:`);
    for (const row of rows) {
      const mark = { passed: 'ok', failed: 'FAIL', warning: 'warn', skipped: 'skip', not_applicable: '-' }[row.status];
      lines.push(`  ${mark.padEnd(5)} ${row.code}${row.reason ? ` — ${row.reason}` : ''}`);
    }
    lines.push('');
  }
  if (report.problems.length > 0) {
    lines.push('problems:');
    for (const problem of report.problems) lines.push(`  ${problem.code}: ${problem.message}`);
    lines.push('');
  }
  lines.push('not proven here:');
  for (const limit of report.limitations) lines.push(`  ${limit.code}`);
  lines.push('');
  return lines.join('\n');
}
