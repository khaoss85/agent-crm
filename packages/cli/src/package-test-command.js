// @ts-check

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PACKAGE_CONTRACT } from '../../core/index.js';
import { SUPPORTED_PACKAGE_CONTRACTS } from '../../core/src/package-contract-versions.js';
import { canonicalJson, inspectionFingerprint } from '../../core/src/solution-plan.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { runReportingChild } from './child-report.js';
import { sortChecks, check } from './package-test-checks.js';
import {
  applyManifests, buildProbeProject, packageManifests, resolvePackageLocation,
  writeComposition, writeCompositionWithout,
} from './package-test-project.js';
import { safeMessage } from './safe-text.js';

/**
 * `crm package test <package-directory> [--json] [--root <dir>]` — DX4.
 *
 * It answers exactly one question:
 *
 * > **Does this package satisfy the framework's generic package contract and
 * > integration invariants?**
 *
 * It does **not** answer whether the domain logic is right. A package can pass
 * every check here and still compute the wrong number, promise the wrong thing
 * or model the wrong process. Those are the package's own tests, and this
 * command says so in its own output rather than leaving a reader to assume.
 *
 * Three commands, three different questions, no overlap:
 *
 * ```text
 * crm package validate   is this declaration structurally valid?
 * crm package inspect    what does this package declare, own and need?
 * crm package test       does it hold up when a real application composes it?
 * ```
 *
 * **Trusted source, isolated execution, not a sandbox.** Reading a code-first
 * package means importing it, and this command additionally *boots* an
 * application carrying it. Every boot happens in a child process against a
 * throwaway copy of the project, so a package that mutates a global, patches a
 * built-in, never returns or floods a stream cannot damage the process the
 * operator invoked or the project they are standing in. The child still holds
 * this user's authority: it is isolation, not a filesystem, network or OS
 * sandbox. Point this command only at a package you would be willing to boot.
 */

export const PACKAGE_CONFORMANCE_CONTRACT = 1;

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const BOOT_PROBE = join(BIN, 'accordo-package-boot.js');
const PLAN_PROBE = join(BIN, 'accordo-package-plan.js');

/** Everything this command cannot answer, stated once, by code. */
const LIMITATIONS = Object.freeze([
  ['DOMAIN_CORRECTNESS_NOT_PROVEN', 'this command proves framework conformance only. Whether the package computes, decides or promises the right thing is what its own tests are for, and nothing here is evidence about it'],
  ['PACKAGE_SOURCE_TRUSTED', 'the harness does not intentionally mutate the caller project. Package source is trusted and executes with the operator’s authority. Process isolation protects the invoking process from crashes, global-state changes and hangs; it is not a filesystem, network or OS sandbox'],
  ['PROCESS_ISOLATION_BOUNDED', 'every import and every boot runs in its own process group and a timeout stops that group, so an ordinary child a package spawns is stopped with it. A package that deliberately detaches a process into a new group outlives the run; tracking descendants is not attempted and would not be a sandbox either'],
  ['SCRATCH_PROJECT_ONLY', 'the harness writes only inside a temporary copy of the project and removes it afterwards. It never opens the caller’s database. It cannot prevent package code from writing wherever the operator can write — including the caller’s project — because that code runs with the operator’s authority'],
  ['UNDECLARED_OWNER_COMPOSED_LOCALLY', 'when an action targets a record another package owns, that owner is located in THIS project and composed so the rest of the report can be produced. A consumer whose project lacks that package would not get the same result, which is why an undeclared owner is reported as a failure rather than rescued'],
  ['ACTION_EXECUTION_NOT_ATTEMPTED', 'no declared action is executed. Driving one needs records only the domain knows how to create, so audit, trace, event and transaction behaviour are the package’s own tests to prove'],
  ['STATE_TRANSITIONS_NOT_DRIVEN', 'declared fromStates are published, never exercised: a generic probe has no record in any of those states'],
  ['POLICY_BEHAVIOUR_NOT_EVALUATED', 'a declared policy is checked for identity, declared config and a fingerprint. What it decides is domain behaviour and is not evaluated'],
  ['PROVIDER_HEALTH_UNKNOWN', 'no external provider is contacted, authenticated or health-checked'],
  ['SECRETS_NOT_INSPECTED', 'no secret, credential, token or environment value is read'],
  ['DATA_NOT_INSPECTED', 'the caller’s configured database is never opened. The scratch database is created empty and destroyed with the scratch project'],
  ['UPGRADE_NOT_EXERCISED', 'module evolution needs two manifests one revision apart. A package ships one manifest per record, so a data-bearing upgrade is domain evidence and is not attempted here'],
]);

/** Which categories a caller may rely on being present, in report order. */
const CATEGORIES = Object.freeze(['declaration', 'boundary', 'composition', 'modules', 'lifecycle', 'inspection']);

/**
 * @param {{packagePath: string, rootDir?: string, json?: boolean, timeoutMs?: number, capture?: boolean}} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function packageTestCommand({
  packagePath, rootDir = process.cwd(), json = false, timeoutMs, capture = false,
}) {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  /** @type {any} */
  let built = null;
  try {
    const report = await run({ packagePath, root, timeoutMs, hold: (value) => { built = value; } });
    if (!capture) {
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
    }
    return { exitCode: report.ok ? 0 : 1, report };
  } catch (error) {
    // A package or a project that cannot be read at all is a different outcome
    // from one that does not conform, and it gets its own exit code.
    process.stderr.write(`${safeMessage(error, [root])}\n`);
    return { exitCode: 2, report: null };
  } finally {
    try { built?.cleanup?.(); } catch { /* a scratch that never existed needs no cleanup */ }
  }
}

/** @param {{packagePath: string, root: string, timeoutMs?: number, hold: (value: any) => void}} params */
async function run({ packagePath, root, timeoutMs, hold }) {
  const location = resolvePackageLocation({ packagePath, rootDir: root });

  // The scratch copy is built FIRST, from filesystem facts alone, so that the
  // package is imported from the copy rather than from the caller's own tree.
  // Package code runs at import; a package that writes next to its own source
  // would otherwise write into the caller's repository. That is not a sandbox —
  // an absolute path still reaches anywhere the operator can — but it removes
  // the one place the harness itself was pointing the package at.
  const built = buildProbeProject({ rootDir: root, location });
  hold(built);
  const scratchPackageDir = join(built.scratchRoot, ...location.relativeDir.split('/'));

  // Everything that imports the package happens in a child process. The parent
  // never loads package code: a module body that calls `process.exit`, hangs or
  // floods a stream must not be able to take the process the operator invoked.
  const planned = await runReportingChild({
    loader: PLAN_PROBE,
    args: ['--root', built.scratchRoot, '--package', scratchPackageDir],
    ...(timeoutMs ? { timeoutMs } : {}),
    hints: {
      timeout: 'reading the package definition, and stopped its process group. A package whose module body does not return on import will do this.',
      size: 'A package publishing very large metadata() will do this.',
      empty: 'The package produced no definition report.',
    },
  });
  if (!planned.report || planned.report.read !== true) {
    throw new Error(planned.report?.error ?? planned.diagnostic?.trim() ?? 'the package could not be read');
  }
  const plan = planned.report;
  const name = plan.package.name;
  const declaration = { published: {
    resources: plan.package.resources, actions: plan.package.actions,
    requires: plan.package.requires, provides: plan.package.provides,
  } };

  /** @type {any[]} */
  const checks = [...plan.checks];
  /** @type {any[]} */
  const problems = [...plan.problems];
  const prerequisites = plan.prerequisites;
  const missingProviders = plan.missingProviders;
  const impliedPrerequisites = plan.impliedPrerequisites;
  const projectRecords = plan.projectRecords;
  if (projectRecords.missing.length > 0) {
    problems.push({
      code: 'RECORD_MANIFEST_ABSENT',
      message: `this project declares no module manifest for ${projectRecords.missing.join(', ')}, which a composed package acts on`,
    });
  }

  // A package whose provider is not in this project cannot be composed at all;
  // every boot-dependent check is skipped honestly rather than faked.
  if (missingProviders.length > 0) {
    problems.push({
      code: 'DEPENDENCY_PROVIDER_ABSENT',
      message: `this project has no package providing ${missingProviders.sort().join(', ')}`,
    });
    for (const [id, category] of [
      ['modules.applied', 'modules'], ['modules.migrations', 'modules'], ['modules.resource-coverage', 'modules'],
      ['lifecycle.attach', 'lifecycle'], ['lifecycle.actions-registered', 'lifecycle'],
      ['lifecycle.capabilities-resolve', 'lifecycle'], ['lifecycle.detach', 'lifecycle'],
      ['inspection.valid', 'inspection'], ['inspection.package-row', 'inspection'],
      ['inspection.capabilities', 'inspection'],
    ]) {
      checks.push(check(id, category, 'skipped', 'the declared provider package is absent from this project', 'DEPENDENCY_PROVIDER_ABSENT', 'composition'));
    }
    return envelope({ root, location, name, definition: plan.package, declaration, checks, problems, scratch: null });
  }

  // ---- the scratch project ----
  const applied = applyManifests({
    scratchRoot: built.scratchRoot,
    rootDir: built.scratchRoot,
    order: [...prerequisites.map((entry) => entry.relativeDir), location.relativeDir],
    projectManifests: projectRecords.manifests,
  });
  built.applied = applied;
  const composed = [
    ...prerequisites.map((provider) => ({
      name: provider.name, relativeDir: provider.relativeDir,
      exportName: provider.exportName, isFactory: provider.isFactory,
    })),
    { name, relativeDir: location.relativeDir, exportName: plan.package.exportName, isFactory: plan.package.isFactory },
  ];

  const manifests = packageManifests(location.dir);
  const failedApplies = built.applied.filter((entry) => !entry.ok);
  const mine = built.applied.filter((entry) => entry.manifest.startsWith(`${location.relativeDir}/`));
  checks.push(check('modules.applied', 'modules',
    manifests.length === 0 ? 'not_applicable' : failedApplies.length === 0 ? 'passed' : 'failed',
    manifests.length === 0
      ? 'the package ships no module manifest'
      : `${mine.filter((entry) => entry.ok).length}/${mine.length} of this package's manifests applied${failedApplies.length ? `; refused: ${failedApplies.map((entry) => entry.manifest).sort().join(', ')}` : ''}`,
    manifests.length === 0 ? 'NO_MANIFESTS_DECLARED' : undefined, 'module-factory'));

  // The composition file is the only file this command authors, and it is
  // written after the manifests are applied so the boot sees both.
  writeComposition(built.scratchRoot, composed);

  // ---- attach: a real application boots carrying this package ----
  const attach = await bootProbe(built.scratchRoot, name, timeoutMs, root);
  const booted = attach.report?.booted === true;
  checks.push(check('lifecycle.attach', 'lifecycle', booted ? 'passed' : 'failed',
    booted
      ? `an application composing ${[...(attach.report.composedPackages ?? [])].join(', ')} started`
      : `the application refused to start: ${safeMessage(attach.report?.error ?? attach.diagnostic ?? 'no report', [built.scratchRoot, root])}`,
    undefined, 'application-boot'));

  if (booted) {
    const registered = new Set(attach.report.registeredActions ?? []);
    const declaredActions = declaration.published.actions;
    const unregistered = declaredActions.filter((entry) => !registered.has(entry)).sort();
    checks.push(check('lifecycle.actions-registered', 'lifecycle',
      declaredActions.length === 0 ? 'not_applicable' : unregistered.length === 0 ? 'passed' : 'failed',
      declaredActions.length === 0
        ? 'the package declares no action'
        : unregistered.length === 0
          ? `all ${declaredActions.length} declared action(s) are registered on a real generated module`
          : `declared but not registered: ${unregistered.join(', ')}`,
      declaredActions.length === 0 ? 'NO_ACTIONS_DECLARED' : undefined, 'application-boot'));

    const capabilityRows = attach.report.capabilities ?? [];
    const failedCapabilities = capabilityRows.filter((row) => row.status !== 'resolved');
    checks.push(check('lifecycle.capabilities-resolve', 'lifecycle',
      capabilityRows.length === 0 ? 'not_applicable' : failedCapabilities.length === 0 ? 'passed' : 'failed',
      capabilityRows.length === 0
        ? 'the package declares no dependency to open'
        : failedCapabilities.length === 0
          ? `all ${capabilityRows.length} declared dependency(ies) opened at runtime`
          : failedCapabilities.map((row) => `${row.requirement}: ${safeMessage(row.detail ?? row.status, [built.scratchRoot, root])}`).sort().join('; '),
      capabilityRows.length === 0 ? 'NO_DEPENDENCIES_DECLARED' : undefined, 'application-boot'));
  } else {
    for (const id of ['lifecycle.actions-registered', 'lifecycle.capabilities-resolve']) {
      checks.push(check(id, 'lifecycle', 'skipped', 'the application did not start', 'ATTACH_FAILED', 'application-boot'));
    }
  }

  // ---- AX1 agrees with the declaration, on the same composed project ----
  const inspected = await inspectApplicationCommand({ rootDir: built.scratchRoot, capture: true, ...(timeoutMs ? { timeoutMs } : {}) });
  const ax1 = inspected.report;
  checks.push(check('inspection.valid', 'inspection', ax1?.valid === true ? 'passed' : 'failed',
    ax1 ? `crm app inspect reports ${ax1.problems.length} problem(s)` : 'the project could not be inspected',
    undefined, 'app-inspect'));

  const row = (ax1?.packages ?? []).find((entry) => entry.name === name) ?? null;
  const agrees = row
    && JSON.stringify([...row.resources].sort()) === JSON.stringify(declaration.published.resources)
    && JSON.stringify([...row.actions].sort()) === JSON.stringify(declaration.published.actions)
    && JSON.stringify(row.requires.map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort())
      === JSON.stringify(declaration.published.requires)
    && JSON.stringify(row.provides.map((entry) => `${entry.name}@${entry.version}`).sort())
      === JSON.stringify(declaration.published.provides);
  checks.push(check('inspection.package-row', 'inspection', agrees ? 'passed' : 'failed',
    row
      ? (agrees
        ? 'the inspection report and the declaration describe the same package'
        : 'the inspection report and the declaration disagree about resources, actions, requires or provides')
      : 'the package does not appear in the inspection report',
    undefined, 'app-inspect'));

  const offered = declaration.published.provides;
  const capabilityStatus = (ax1?.capabilities ?? [])
    .filter((entry) => offered.includes(`${entry.name}@${entry.version}`)
      || declaration.published.requires.some((requirement) => requirement.endsWith(`/${entry.name}@${entry.version}`)));
  const unresolved = capabilityStatus.filter((entry) => entry.status !== 'resolved');
  checks.push(check('inspection.capabilities', 'inspection',
    capabilityStatus.length === 0 ? 'not_applicable' : unresolved.length === 0 ? 'passed' : 'failed',
    capabilityStatus.length === 0
      ? 'the package neither offers nor requires a capability'
      : unresolved.length === 0
        ? `${capabilityStatus.length} capability edge(s) resolved`
        : unresolved.map((entry) => `${entry.name}@${entry.version}: ${entry.status}`).sort().join(', '),
    capabilityStatus.length === 0 ? 'NO_CAPABILITY_EDGES' : undefined, 'app-inspect'));

  // ---- the records the package owns, as the applied project holds them ----
  const owned = (ax1?.modules ?? []).filter((entry) => entry.owner === name);
  const declaredResources = declaration.published.resources;
  const missingModules = declaredResources.filter((resource) => !owned.some((entry) => entry.name === resource)).sort();
  checks.push(check('modules.resource-coverage', 'modules',
    declaredResources.length === 0 ? 'not_applicable' : missingModules.length === 0 ? 'passed' : 'failed',
    declaredResources.length === 0
      ? 'the package owns no record'
      : missingModules.length === 0
        ? `all ${declaredResources.length} declared record(s) exist and are owned by this package`
        : `declared but not owned by an applied module: ${missingModules.join(', ')}`,
    declaredResources.length === 0 ? 'NO_RESOURCES_DECLARED' : undefined, 'app-inspect'));

  const withMigrations = owned.filter((entry) => Array.isArray(entry.migrations) && entry.migrations.length > 0);
  const badState = owned.filter((entry) => entry.stateFile !== 'valid' && entry.stateFile !== 'reconstructed');
  const migrationNames = withMigrations.flatMap((entry) => entry.migrations.map((migration) => migration.name));
  const duplicateMigrations = migrationNames.filter((value, index) => migrationNames.indexOf(value) !== index);
  checks.push(check('modules.migrations', 'modules',
    owned.length === 0 ? 'not_applicable'
      : badState.length === 0 && duplicateMigrations.length === 0 && withMigrations.length === owned.length
        ? 'passed' : 'failed',
    owned.length === 0
      ? 'the package owns no record'
      : badState.length > 0
        ? `module state unreadable for: ${badState.map((entry) => entry.name).sort().join(', ')}`
        : duplicateMigrations.length > 0
          ? `duplicate migration name(s): ${[...new Set(duplicateMigrations)].sort().join(', ')}`
          : `${migrationNames.length} migration(s) across ${owned.length} record(s), each with a checksum and a valid state file`,
    owned.length === 0 ? 'NO_RESOURCES_DECLARED' : undefined, 'module-factory'));

  // ---- detach: the surface leaves with the package, in a fresh process ----
  writeCompositionWithout(built.scratchRoot, composed, name);
  const detached = await bootProbe(built.scratchRoot, name, timeoutMs, root);
  const detachedOk = detached.report?.booted === true;
  const surfaceGone = detachedOk
    && !(detached.report.composedPackages ?? []).includes(name)
    && declaration.published.actions.every((entry) => !(detached.report.registeredActions ?? []).includes(entry));
  checks.push(check('lifecycle.detach', 'lifecycle', surfaceGone ? 'passed' : 'failed',
    detachedOk
      ? (surfaceGone
        ? 'an application composed without the package starts, and none of its actions remain registered'
        : 'the package was removed from the composition but part of its surface is still registered')
      : `an application without the package refused to start: ${safeMessage(detached.report?.error ?? detached.diagnostic ?? 'no report', [built.scratchRoot, root])}`,
    undefined, 'application-boot'));
  // Restore the composition so a caller inspecting the scratch during a
  // debugging session sees what was actually tested.
  writeComposition(built.scratchRoot, composed);

  checks.push(check('lifecycle.detach-rows', 'lifecycle', 'not_applicable',
    'whether a detached package leaves its rows behind is a data question; this command creates an empty scratch database and destroys it',
    'DETACH_ROW_PRESERVATION_NOT_GENERIC', 'application-boot'));

  return envelope({
    root, location, name, definition: plan.package, declaration, checks, problems,
    scratch: {
      applied: built.applied.length,
      packages: composed.map((entry) => entry.name).sort(),
      impliedPrerequisites,
      undeclaredRecordOwners: plan.undeclaredRecordOwners ?? [],
      projectRecords: projectRecords.manifests.map((entry) => entry.name),
    },
    inspectionFingerprint: ax1?.applicationInspectionContract ? fingerprintOf(ax1) : null,
  });
}

/** One boot of the scratch project, isolated and bounded like every other. */
function bootProbe(scratchRoot, packageName, timeoutMs, root) {
  return runReportingChild({
    loader: BOOT_PROBE,
    args: ['--root', scratchRoot, '--db', join(scratchRoot, 'data', 'package-test.sqlite'), '--package', packageName],
    ...(timeoutMs ? { timeoutMs } : {}),
    hints: {
      timeout: 'booting an application composed with this package, and stopped its process group. A package whose module body does not return on import will do this.',
      size: 'A package publishing very large metadata() will do this.',
      empty: 'The application produced no report.',
    },
  }).then((outcome) => ({ ...outcome, root }));
}

/** AX1's own digest of the composed scratch project, as citable evidence. */
function fingerprintOf(report) {
  try {
    return inspectionFingerprint(report);
  } catch {
    // A digest is evidence, not a verdict: a report AX2 cannot fingerprint must
    // not stop the conformance report being produced.
    return null;
  }
}

/** The stable machine-readable document. */
function envelope({ root, location, name, definition, declaration, checks, problems, scratch, inspectionFingerprint = null }) {
  const ordered = sortChecks(checks);
  const failed = ordered.filter((entry) => entry.status === 'failed');
  const facts = {
    packageConformanceContract: PACKAGE_CONFORMANCE_CONTRACT,
    package: {
      name,
      version: definition?.version ?? null,
      packageContract: definition?.packageContract ?? null,
      supportedPackageContract: SUPPORTED_PACKAGE_CONTRACT,
      acceptedPackageContracts: [...SUPPORTED_PACKAGE_CONTRACTS],
      resources: declaration.published.resources,
      actions: declaration.published.actions,
      requires: declaration.published.requires,
      provides: declaration.published.provides,
    },
    checks: ordered.map((entry) => ({ id: entry.id, status: entry.status })),
    problems: problems.map((entry) => entry.code).sort(),
  };
  return {
    packageConformanceContract: PACKAGE_CONFORMANCE_CONTRACT,
    command: 'package:test',
    ok: failed.length === 0,
    // Deliberately relative: this JSON is written for agents and pasted into
    // issues, and an absolute path carries the operator's machine layout.
    path: location.relativeDir,
    package: facts.package,
    categories: [...CATEGORIES],
    counts: countBy(ordered),
    checks: ordered,
    problems: [...problems].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
    scratch: scratch
      ? {
        composed: scratch.packages,
        manifestsApplied: scratch.applied,
        // Packages the contract gave this one no way to declare, discovered
        // from the records its actions target and composed so it could boot.
        impliedPrerequisites: scratch.impliedPrerequisites ?? [],
        // Owners this project happened to contain and the package never
        // declared. A consumer without them would not get this result.
        undeclaredRecordOwners: scratch.undeclaredRecordOwners ?? [],
        // Records the composition needed that no package owns — a project's own
        // manifests, applied so a package action had something to target.
        projectRecords: scratch.projectRecords ?? [],
        database: 'created empty in a temporary copy and destroyed with it',
      }
      : {
        composed: [], manifestsApplied: 0, impliedPrerequisites: [],
        undeclaredRecordOwners: [], projectRecords: [],
        database: 'never created: the package could not be composed',
      },
    inspectionFingerprint,
    // The digest of the conformance facts themselves — stable across runs,
    // processes and working directories. `path` is deliberately excluded: it is
    // relative to where the caller stood.
    fingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex'),
  };
}

function countBy(checks) {
  const counts = { passed: 0, failed: 0, skipped: 0, not_applicable: 0 };
  for (const entry of checks) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}

/**
 * The human view. Same facts, same order, no interpretation the JSON does not
 * already carry. It is a convenience; `--json` is the contract.
 * @param {any} report
 */
function renderText(report) {
  const lines = [];
  const heading = (text) => lines.push('', text, '─'.repeat(text.length));
  lines.push(`Accordo package conformance (contract ${report.packageConformanceContract})`);
  lines.push(`Package: ${report.package.name}@${report.package.version} (packageContract ${report.package.packageContract})`);
  lines.push(`Path: ${report.path}`);
  lines.push(report.ok ? 'Conformance: every check passed' : `Conformance: ${report.counts.failed} check(s) failed`);
  lines.push(`Checks: ${report.counts.passed} passed · ${report.counts.failed} failed · ${report.counts.skipped} skipped · ${report.counts.not_applicable} not applicable`);

  for (const category of report.categories) {
    const rows = report.checks.filter((entry) => entry.category === category);
    if (rows.length === 0) continue;
    heading(`${category} (${rows.length})`);
    for (const entry of rows) {
      lines.push(`  [${entry.status}] ${entry.id}${entry.reason ? ` (${entry.reason})` : ''}`);
      lines.push(`      ${entry.evidence}`);
    }
  }

  if (report.problems.length) {
    heading(`Problems (${report.problems.length})`);
    for (const problem of report.problems) lines.push(`  [${problem.code}] ${problem.message}`);
  }

  heading(`Limitations (${report.limitations.length})`);
  for (const limitation of report.limitations) lines.push(`  [${limitation.code}] ${limitation.message}`);

  lines.push('', 'Run with --json for the machine-readable report — this view is a convenience, not the contract.');
  return lines.join('\n');
}
