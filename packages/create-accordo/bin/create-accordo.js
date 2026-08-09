#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';
import { applyProjectBootstrap, planProjectBootstrap } from '../src/project-bootstrap.js';

/**
 * The executable `npm create accordo <directory>` would run.
 *
 * ```text
 * create-accordo <directory> [--name <project-name>] [--apply] [--json]
 * ```
 *
 * Dry-run is the default. `--apply` is the only thing that writes, and it
 * writes only inside the target directory.
 *
 * **Exit codes are the contract**, so an agent or a CI job can act on them
 * without parsing prose. A full report is printed in every case, including both
 * refusals — stopping at the first fault would send the reader back to guessing.
 *
 * ```text
 * 0   the plan is clean, or --apply wrote the project
 * 1   refused because of the request      (bad name, non-empty target, …)
 * 2   refused because of the environment  (no framework source, no target given)
 * ```
 */

/**
 * Problem codes that mean "this machine cannot answer", as opposed to "you
 * asked for something I must refuse". They are the ones a caller cannot fix by
 * changing an argument.
 */
const ENVIRONMENT_CODES = new Set([
  'TARGET_MISSING',
  'FRAMEWORK_SOURCE_UNAVAILABLE',
  'FRAMEWORK_SOURCE_INCOMPLETE',
  'SOURCE_NOT_READABLE',
  'BOOTSTRAP_NOT_WRITTEN',
]);

const USAGE = `create-accordo — create a new Accordo CRM project

  create-accordo <directory> [options]

  --name <project-name>   the npm package name for the new project
                          (default: the target directory's own name)
  --apply                 write the project. Without it, nothing is written.
  --json                  the machine-readable report — this is the contract
  --help                  this message

It copies a checkout of the Accordo framework into an empty directory. It
reaches no network, installs nothing, opens no database and composes no domain
package. The result is local-development software: no authentication, no
tenancy, no RBAC, SQLite only.
`;

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{directory: string|null, name: string|null, apply: boolean, json: boolean, help: boolean, error: string|null}} */
  const parsed = { directory: null, name: null, apply: false, json: false, help: false, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { parsed.help = true; continue; }
    if (argument === '--apply') { parsed.apply = true; continue; }
    if (argument === '--json') { parsed.json = true; continue; }
    if (argument === '--name') {
      const value = argv[index + 1];
      // An unknown flag is refused rather than ignored, and so is a `--name`
      // whose value is the next flag: silently adopting `--apply` as a project
      // name is exactly the guess this command must not make.
      if (value === undefined || value.startsWith('--')) { parsed.error = '--name needs a value'; return parsed; }
      parsed.name = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--name=')) { parsed.name = argument.slice('--name='.length); continue; }
    if (argument.startsWith('-')) { parsed.error = `unknown option: ${argument.slice(0, 40)}`; return parsed; }
    if (parsed.directory !== null) { parsed.error = 'only one target directory may be given'; return parsed; }
    parsed.directory = argument;
  }
  return parsed;
}

/** @param {any} report */
export function exitCodeFor(report) {
  if (report.ok) return 0;
  return report.problems.some((problem) => ENVIRONMENT_CODES.has(problem.code)) ? 2 : 1;
}

/**
 * The human view. Same facts, same order, no interpretation the JSON does not
 * already carry. It is a convenience; `--json` is the stable contract.
 * @param {any} report
 */
export function render(report) {
  const lines = [];
  lines.push(`Accordo project bootstrap (contract ${report.projectBootstrapContract})`);
  lines.push(`Mode:    ${report.mode} — ${report.modeReason}`);
  lines.push(`Project: ${report.project.name ?? '(unnamed)'} in ${report.project.directory || '(no directory given)'}`);
  lines.push(`Posture: ${report.project.productionPosture}`);

  // The refusal comes first when there is one. An earlier draft printed the
  // inventory and the file list above it, so a reader whose bootstrap had just
  // been refused saw ten files it "would create" before being told why none of
  // them exists.
  if (report.problems.length > 0) {
    lines.push('', 'Refused — nothing was written');
    for (const problem of report.problems) lines.push(`  [${problem.code}] ${problem.message}`);
  }

  if (report.source.resolved) {
    lines.push('', `Framework source: ${report.source.files} files, ${Math.round(report.source.bytes / 1024)} KiB, copied from this checkout`);
    for (const entry of report.source.manifest) lines.push(`  ${entry.path.padEnd(18)} ${entry.why}`);
  } else {
    lines.push('', 'Framework source: not found');
  }

  if (report.files.length > 0) {
    const heading = report.mode === 'applied' ? 'Generated files' : 'Files it would generate';
    lines.push('', `${heading} (${report.files.length})`);
    for (const file of report.files) lines.push(`  create  ${file.relativePath} (${file.bytes} bytes)`);
  }

  if (report.problems.length === 0 && report.mode === 'plan') {
    lines.push('', 'Nothing was written. Re-run with --apply to create the project.');
  } else if (report.mode === 'applied') {
    lines.push('', 'Next');
    for (const step of report.nextSteps) lines.push(`  ${step}`);
  }

  lines.push('', 'What this project is not');
  for (const limitation of report.limitations) lines.push(`  [${limitation.code}] ${limitation.message}`);
  lines.push('', 'Run with --json for the machine-readable report — this view is a convenience, not the contract.');
  return lines.join('\n');
}

/** @param {string[]} argv */
export function runCreateAccordo(argv) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const report = parsed.apply
    ? applyProjectBootstrap({ directory: parsed.directory, name: parsed.name ?? undefined })
    : planProjectBootstrap({ directory: parsed.directory, name: parsed.name ?? undefined }).report;

  process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  return exitCodeFor(report);
}

// Guarded so the argument parser, the exit-code mapping and the text renderer
// can be unit-tested by importing this file, which is also the only way to
// prove the three of them agree with the executable that ships.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runCreateAccordo(process.argv.slice(2));
}
