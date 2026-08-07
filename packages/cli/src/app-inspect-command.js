// @ts-check

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `crm app inspect [--json] [--root <dir>]` — the CLI face of AX1.
 *
 * The work happens in a child process (`bin/agent-crm-inspect.js`) because
 * inspection imports the project's checked-in composition, and a code-first
 * definition's module body runs on import. Isolating it means a package that
 * mutates a global, patches a built-in or never returns cannot damage or hang
 * the process the operator invoked. It is **isolation, not a sandbox**: the
 * child holds this user's authority, and the report says so in `limitations`.
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

/** A hung import must not hang the operator's terminal. Generous, and finite. */
const LOAD_TIMEOUT_MS = 60_000;
/** A report is data, not a stream; a runaway one is a defect, not a document. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const LOADER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-crm-inspect.js');

/**
 * @param {{rootDir: string, json?: boolean, timeoutMs?: number}} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function inspectApplicationCommand({ rootDir, json = false, timeoutMs = LOAD_TIMEOUT_MS }) {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  if (!existsSync(root)) {
    process.stderr.write(`Not a directory: ${rootDir}\n`);
    return { exitCode: 2, report: null };
  }

  const result = spawnSync(process.execPath, ['--no-warnings', LOADER, '--root', root], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    // No stdin: an inspector never prompts, so a package that tries to read it
    // gets EOF instead of stalling a CI job forever.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // A timeout arrives as an ETIMEDOUT error on some platforms and as a bare
  // termination signal on others. Both mean the same thing, and reading only
  // one of them would report a hung load as an unreadable project.
  const timedOut = (result.error && /** @type {any} */ (result.error).code === 'ETIMEDOUT')
    || result.signal === 'SIGTERM';
  if (timedOut) {
    process.stderr.write(
      `Timed out after ${timeoutMs / 1000}s loading the project composition. `
        + 'A package whose module body does not return on import will do this.\n',
    );
    return { exitCode: 2, report: null };
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return { exitCode: 2, report: null };
  }

  const stdout = result.stdout ?? '';
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    // The loader failed before it could produce a document. Its stderr is the
    // diagnostic; stdout is not a report and is not printed as one.
    process.stderr.write(result.stderr || 'The project composition could not be read.\n');
    return { exitCode: 2, report: null };
  }
  if (result.stderr) process.stderr.write(result.stderr);

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
  return { exitCode: report.valid ? 0 : 1, report };
}

/**
 * The human view. Same facts, same order, no interpretation the JSON does not
 * already carry — a reader comparing the two must never find a third claim.
 * @param {any} report
 */
function renderText(report) {
  const lines = [];
  const heading = (text) => lines.push('', text, '─'.repeat(text.length));

  lines.push(`Agent CRM application inspection (contract ${report.applicationInspectionContract})`);
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
    const states = action.fromStates ? `  from ${action.fromStates.join('|')}` : '';
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

  lines.push('', 'Run with --json for the machine-readable report.');
  return lines.join('\n');
}
