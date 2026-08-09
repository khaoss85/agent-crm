// @ts-check

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAD_TIMEOUT_MS, runReportingChild } from './child-report.js';

/**
 * `crm app inspect [--json] [--root <dir>]` — the CLI face of AX1.
 *
 * The work happens in a child process (`bin/accordo-inspect.js`) because
 * inspection imports the project's checked-in composition, and a code-first
 * definition's module body runs on import. Isolating it means a package that
 * mutates a global, patches a built-in, changes the working directory, sets an
 * environment variable or never returns cannot damage or hang the process the
 * operator invoked. It is **isolation, not a sandbox**: the child holds this
 * user's authority, and the report says so in `limitations`.
 *
 * Three details make that isolation actually hold, each of which failed in an
 * earlier draft and was found by attacking it:
 *
 * - **the report does not travel on stdout.** A package is entitled to
 *   `console.log` during import, and that lands on the child's stdout. Sharing
 *   that stream meant one logging package made the whole application
 *   uninspectable. The report comes back on **file descriptor 3**; the child's
 *   stdout and stderr are package noise, forwarded to *this* process's stderr
 *   where they cannot corrupt the document.
 * - **the child leads its own process group**, so a timeout stops the group
 *   rather than only the process we started: an ordinary child a package
 *   spawned goes with it, where before it was left running. A package that
 *   *deliberately* detaches a process into a new group still outlives the
 *   inspection — reaching it would mean tracking descendants, which is neither
 *   attempted nor a sandbox. The report says so (`PROCESS_ISOLATION_BOUNDED`).
 * - **every stream is bounded**, so a package with enormous metadata fails as
 *   an explained size refusal instead of as a mysterious timeout.
 *
 * Exit codes are the contract, so an agent or a CI job can act on them without
 * parsing prose:
 *
 * ```text
 * 0   the composition is valid
 * 1   the composition has problems — the complete report is still printed
 * 2   the project could not be read at all
 * ```
 *
 * A report is printed whenever the project loads. Stopping at the first fault
 * would send the reader back to the guessing this command exists to end.
 */

const LOADER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'accordo-inspect.js');

/**
 * @param {{rootDir: string, json?: boolean, timeoutMs?: number, capture?: boolean}} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function inspectApplicationCommand({ rootDir, json = false, timeoutMs = LOAD_TIMEOUT_MS, capture = false }) {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  if (!existsSync(root)) {
    process.stderr.write(`Not a directory: ${rootDir}\n`);
    return { exitCode: 2, report: null };
  }

  const outcome = await load(root, timeoutMs);
  if (outcome.noise) {
    // Labelled, so a reader knows this came from their own packages and not
    // from the inspector, and truncated, so one chatty package cannot bury the
    // answer.
    process.stderr.write(`--- output from the project's own source during load ---\n${outcome.noise}`);
  }
  if (outcome.diagnostic) process.stderr.write(outcome.diagnostic);
  if (outcome.report === null) return { exitCode: 2, report: null };

  // A caller that wants the report as data — `crm solution check` — gets it
  // without a line on stdout: that stream belongs to whatever *it* is printing.
  if (!capture) {
    process.stdout.write(json ? `${JSON.stringify(outcome.report, null, 2)}\n` : `${renderText(outcome.report)}\n`);
  }
  return { exitCode: outcome.report.valid ? 0 : 1, report: outcome.report };
}

/**
 * Run the loader under the shared bounded-child reader. The bounds, the fd-3
 * report channel and the process-group kill live in `child-report.js` so
 * `crm package test` uses the same isolation rather than a second copy of it.
 *
 * @param {string} root @param {number} timeoutMs
 * @returns {Promise<{report: any, noise: string, diagnostic: string}>}
 */
function load(root, timeoutMs) {
  return runReportingChild({
    loader: LOADER,
    args: ['--root', root],
    timeoutMs,
    hints: {
      timeout: 'loading the project composition, and stopped its process group. A package whose module body does not return on import will do this.',
      size: 'A package publishing very large metadata() will do this.',
      empty: 'The project composition could not be read; no report was produced.',
    },
  });
}

/**
 * The human view. Same facts, same order, no interpretation the JSON does not
 * already carry — a reader comparing the two must never find a third claim.
 * It is a convenience; `--json` is the stable contract.
 * @param {any} report
 */
function renderText(report) {
  const lines = [];
  const heading = (text) => lines.push('', text, '─'.repeat(text.length));

  lines.push(`Accordo application inspection (contract ${report.applicationInspectionContract})`);
  lines.push(report.valid ? 'Composition: valid' : `Composition: ${report.problems.length} problem(s)`);
  lines.push(`Project: ${report.application.name ?? '(unnamed)'}`);
  lines.push(`Posture: ${report.application.productionPosture}`);

  heading(`Packages (${report.packages.length})`);
  if (report.packages.length === 0) lines.push('  none composed');
  for (const pkg of report.packages) {
    lines.push(`  ${pkg.name}@${pkg.version} (packageContract ${pkg.packageContract}) — ${pkg.label}`);
    if (pkg.requires.length) {
      lines.push(`    requires  ${pkg.requires.map((r) => `${r.package}/${r.capability}@${r.version}`).join(', ')}`);
    }
    if (pkg.provides.length) lines.push(`    provides  ${pkg.provides.map((p) => `${p.name}@${p.version}`).join(', ')}`);
    if (pkg.resources.length) lines.push(`    resources ${pkg.resources.join(', ')}`);
  }

  heading(`Capabilities (${report.capabilities.length})`);
  if (report.capabilities.length === 0) lines.push('  none declared');
  for (const entry of report.capabilities) {
    lines.push(`  ${entry.name}@${entry.version}  ${entry.status}  provider=${entry.provider ?? '(none)'}  consumers=${entry.consumers.join(', ') || '(none)'}`);
  }

  heading(`Records (${report.modules.length})`);
  for (const module of report.modules) {
    const revision = module.revision === null ? '' : `  revision ${module.revision}`;
    lines.push(`  ${module.name}  [${module.kind}${module.owner ? ` · ${module.owner}` : ''}]${revision}  ${module.capabilities.join('/')}`);
  }

  heading(`Actions (${report.actions.length})`);
  for (const action of report.actions) {
    const states = action.fromStates ? `  from ${action.fromStates.join('|')}` : '  (declares no state restriction)';
    lines.push(`  ${action.module}.${action.name}${states}`);
  }

  heading(`Policies (${report.policies.length})`);
  for (const policy of report.policies) {
    lines.push(`  ${policy.owner}/${policy.kind}/${policy.name}@${policy.version}  ${policy.fingerprint.slice(0, 12)}…`);
  }

  heading(`Providers (${report.providers.length})`);
  for (const provider of report.providers) {
    lines.push(`  ${provider.registry}/${provider.kind}/${provider.name}@${provider.version}${provider.fixture ? '  (fixture)' : ''}`);
  }

  if (report.problems.length) {
    heading(`Problems (${report.problems.length})`);
    for (const problem of report.problems) lines.push(`  [${problem.code}] ${problem.message}`);
  }

  heading(`Limitations (${report.limitations.length})`);
  for (const limitation of report.limitations) lines.push(`  [${limitation.code}] ${limitation.message}`);

  heading('Evidence');
  lines.push(`  ${report.evidence.status} — ${report.evidence.note}`);
  for (const key of ['qualityGatesPath', 'jtbdMatrixPath', 'projectStatusPath']) {
    lines.push(`  ${key}: ${report.evidence[key]}`);
  }

  lines.push('', 'Run with --json for the machine-readable report — this view is a convenience, not the contract.');
  return lines.join('\n');
}
