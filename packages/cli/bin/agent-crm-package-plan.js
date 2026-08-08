#!/usr/bin/env node
// @ts-check

import { writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The isolated reader for `crm package test`.
 *
 * Everything that has to **import** a package happens here: reading its
 * definition, running the checks that only need the definition, and working out
 * which other packages and records have to be composed for it to boot.
 *
 * It is a separate process because the parent must survive the package. A
 * module body that calls `process.exit`, never returns, or floods a stream
 * would otherwise take the operator's terminal — and the whole point of
 * `package test` is that it does not. That failure mode is not hypothetical: an
 * early draft of this command read the definition in-process and a fixture
 * package calling `process.exit(7)` killed the test runner that was checking it.
 *
 * The report goes to **file descriptor 3**; stdout and stderr belong to the
 * package. **Isolation, not a sandbox:** this child holds the user's authority.
 */

const REPORT_FD = 3;

/** @param {string} text */
function writeReport(text) {
  try {
    writeSync(REPORT_FD, text);
  } catch (error) {
    process.stderr.write(
      'This reader writes its report to file descriptor 3, which is not open. '
        + 'Run `crm package test` instead of invoking it directly.\n',
    );
    throw error;
  }
}

const argOf = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
};
const rootDir = argOf('--root') ?? process.cwd();
const packageDir = argOf('--package');

try {
  const [{ loadDefinitions }, checks, project] = await Promise.all([
    import('../src/package-commands.js'),
    import('../src/package-test-checks.js'),
    import('../src/package-test-project.js'),
  ]);

  const found = await loadDefinitions(join(packageDir, 'src', 'index.js'));
  if (found.length !== 1) {
    throw new Error(
      `A package directory must export exactly one package definition; this one exports ${found.length} (${found.map((entry) => entry.export).sort().join(', ')})`,
    );
  }
  const { export: exportName, definition } = found[0];
  const isFactory = /^create[A-Za-z0-9]*(Package|Domain)$/.test(exportName);
  const name = typeof definition?.name === 'string' ? definition.name : '(unnamed)';

  const declaration = checks.runDeclarationChecks({ definition, dir: packageDir, rootDir });
  const refusal = checks.runRefusalChecks({ definition });

  // ---- everything that has to be composed for this package to boot ----
  const prerequisites = [];
  const missingProviders = [];
  const impliedPrerequisites = [];
  const seen = new Set([name]);

  const locate = async (packageName) => {
    const dir = join(rootDir, 'packages', String(packageName));
    let located;
    try {
      located = await loadDefinitions(join(dir, 'src', 'index.js'));
    } catch {
      return null;
    }
    if (located.length !== 1) return null;
    return {
      name: String(located[0].definition?.name ?? packageName),
      relativeDir: project.posix(join('packages', String(packageName))),
      topSegment: 'packages',
      exportName: located[0].export,
      isFactory: /^create[A-Za-z0-9]*(Package|Domain)$/.test(located[0].export),
      definition: located[0].definition,
    };
  };

  const frontier = [{ definition, resources: declaration.published.resources, origin: name }];
  while (frontier.length > 0) {
    const current = frontier.shift();
    for (const entry of current.definition?.requires ?? []) {
      if (seen.has(String(entry.package))) continue;
      seen.add(String(entry.package));
      const located = await locate(entry.package);
      if (!located) {
        missingProviders.push(`${entry.package}/${entry.capability}@${entry.version}`);
        continue;
      }
      prerequisites.push(located);
      frontier.push({ definition: located.definition, resources: located.definition?.resources ?? [], origin: located.name });
    }
    const foreign = [...new Set((current.definition?.actions ?? [])
      .map((action) => action?.module)
      .filter((module) => typeof module === 'string' && !(current.resources ?? []).includes(module)))];
    const owners = (await project.findRecordOwners({ rootDir, records: foreign, load: loadDefinitions }))
      .filter((owner) => !seen.has(owner.name));
    for (const owner of owners) {
      seen.add(owner.name);
      prerequisites.push(owner);
      if (current.origin === name) impliedPrerequisites.push({ package: owner.name, records: owner.records });
      frontier.push({ definition: owner.definition, resources: owner.definition?.resources ?? [], origin: owner.name });
    }
  }
  prerequisites.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  impliedPrerequisites.sort((a, b) => (a.package < b.package ? -1 : 1));

  const composition = checks.runCompositionChecks({
    definition, providers: prerequisites.map((entry) => entry.definition),
  });

  // An action targeting a record another package owns is not a contract
  // violation — `requires` is a capability edge and cannot express record-level
  // coupling — so the verdict turns on whether the owner is visible in the
  // graph at all:
  //
  //   owned by this package            → passed
  //   owned by a DECLARED dependency   → passed, and the coupling is named
  //   owned by nobody this declares    → the seam gap, reported as such
  const declaredPackages = new Set((definition?.requires ?? []).map((entry) => String(entry?.package)));
  const ownedHere = new Set(declaration.published.resources);
  const foreign = [...new Set((definition?.actions ?? [])
    .map((action) => action?.module)
    .filter((module) => typeof module === 'string' && !ownedHere.has(module)))].sort();
  const ownerOf = new Map();
  for (const entry of prerequisites) {
    for (const resource of entry.definition?.resources ?? []) ownerOf.set(resource, entry.name);
  }
  const undeclared = foreign.filter((record) => !declaredPackages.has(ownerOf.get(record) ?? ''));
  const targetCheck = foreign.length === 0
    ? checks.check('declaration.action-targets', 'declaration', 'passed',
      'every declared action targets a record this package owns')
    : undeclared.length === 0
      ? checks.check('declaration.action-targets', 'declaration', 'passed',
        `acts on record(s) owned by declared dependency(ies): ${foreign.map((record) => `${record} (${ownerOf.get(record)})`).join(', ')}. `
        + 'The coupling is record-level, which `requires` cannot express, but the owning package is declared.')
      : checks.check('declaration.action-targets', 'declaration', 'not_applicable',
        `acts on record(s) no declared dependency owns: ${undeclared.map((record) => `${record} (${ownerOf.get(record) ?? 'owner unknown'})`).join(', ')}. `
        + 'The package contract cannot express record-level coupling, so this is a gap in the seam rather than a defect in the package. '
        + 'The owning package is composed as an implied prerequisite.',
        'UNDECLARED_RECORD_COUPLING');

  // Records the composition needs that no package owns: a project's own
  // manifests, plus everything their foreign keys reference.
  const ownedByPackages = new Set([
    ...declaration.published.resources,
    ...prerequisites.flatMap((entry) => entry.definition?.resources ?? []),
  ]);
  const targeted = [definition, ...prerequisites.map((entry) => entry.definition)]
    .flatMap((entry) => (entry?.actions ?? []).map((action) => action?.module))
    .filter((module) => typeof module === 'string' && !ownedByPackages.has(module));
  const projectRecords = project.closeManifestSet({
    index: project.indexModuleManifests(rootDir),
    records: [...new Set(targeted)],
    provided: ownedByPackages,
  });

  writeReport(`${JSON.stringify({
    read: true,
    package: {
      name,
      version: definition?.version ?? null,
      packageContract: definition?.packageContract ?? null,
      exportName,
      isFactory,
      ...declaration.published,
    },
    checks: [...declaration.checks, targetCheck, ...refusal, ...composition.checks],
    problems: [...declaration.problems, ...composition.problems],
    prerequisites: prerequisites.map((entry) => ({
      name: entry.name, relativeDir: entry.relativeDir, topSegment: entry.topSegment,
      exportName: entry.exportName, isFactory: entry.isFactory,
    })),
    missingProviders: missingProviders.sort(),
    impliedPrerequisites,
    projectRecords: {
      manifests: projectRecords.manifests.map((entry) => ({ name: entry.name, path: entry.path })),
      missing: projectRecords.missing,
    },
  })}\n`);
  process.exitCode = 0;
} catch (error) {
  writeReport(`${JSON.stringify({
    read: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 2;
}
