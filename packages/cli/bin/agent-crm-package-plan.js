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

  // Where an action's target record comes from decides whether the package is
  // honestly declared, and the three cases are genuinely different:
  //
  //   owned by this package             → nothing to declare
  //   owned by NO package               → a record of the HOST APPLICATION. Every
  //                                       package here acts on `order`; a project
  //                                       supplies it from its own manifest, and
  //                                       depending on it is ordinary
  //   owned by a DECLARED dependency    → the coupling is record-level, which
  //                                       `requires` cannot express, but the
  //                                       relationship is visible in the graph
  //   owned by an UNDECLARED package    → a FAILURE. The package cannot be given
  //                                       to anyone whose project lacks that
  //                                       package, and nothing in its declaration
  //                                       says so. This command must not rescue
  //                                       it by composing an owner it happened to
  //                                       find in this repository and then call
  //                                       the package conforming
  const declaredPackages = new Set((definition?.requires ?? []).map((entry) => String(entry?.package)));
  const ownedHere = new Set(declaration.published.resources);
  const foreign = [...new Set((definition?.actions ?? [])
    .map((action) => action?.module)
    .filter((module) => typeof module === 'string' && !ownedHere.has(module)))].sort();
  const ownerOf = new Map();
  for (const entry of prerequisites) {
    for (const resource of entry.definition?.resources ?? []) ownerOf.set(resource, entry.name);
  }
  const hostRecords = foreign.filter((record) => !ownerOf.has(record));
  const declaredForeign = foreign.filter((record) => declaredPackages.has(ownerOf.get(record) ?? ''));
  const undeclared = foreign.filter((record) => ownerOf.has(record) && !declaredPackages.has(ownerOf.get(record)));

  const describeSet = (records) => records.map((record) => `${record}${ownerOf.has(record) ? ` (${ownerOf.get(record)})` : ''}`).join(', ');
  let targetCheck;
  if (undeclared.length > 0) {
    // Name the capabilities the owner does offer, so the author can see whether
    // a correct dependency exists to declare or whether this is a seam gap.
    const offers = [...new Set(undeclared.map((record) => ownerOf.get(record)))].sort().map((owner) => {
      const entry = prerequisites.find((candidate) => candidate.name === owner);
      const capabilities = (entry?.definition?.capabilities ?? [])
        .map((capability) => `${capability.name}@${capability.version}`).sort();
      return `${owner} offers ${capabilities.length > 0 ? capabilities.join(', ') : 'no capability at all'}`;
    });
    targetCheck = checks.check('declaration.action-targets', 'declaration', 'failed',
      `acts on record(s) owned by a package it does not declare: ${describeSet(undeclared)}. `
      + 'This package cannot be composed into a project that lacks that package, and nothing in its declaration says so. '
      + `Declare a capability of the owning package in \`requires\` — ${offers.join('; ')}. `
      + 'If no capability of the owner expresses this relationship, the package contract cannot currently declare it, '
      + 'and the package is partial rather than conforming.',
      'UNDECLARED_PACKAGE_RECORD_DEPENDENCY', 'composition');
  } else if (declaredForeign.length > 0) {
    targetCheck = checks.check('declaration.action-targets', 'declaration', 'passed',
      `acts on record(s) owned by declared dependency(ies): ${describeSet(declaredForeign)}`
      + (hostRecords.length > 0 ? `; and on host-application record(s): ${hostRecords.join(', ')}` : '')
      + '. The coupling is record-level, which `requires` cannot express, but every owning package is declared.',
      undefined, 'composition');
  } else if (hostRecords.length > 0) {
    targetCheck = checks.check('declaration.action-targets', 'declaration', 'passed',
      `acts on host-application record(s) no package owns: ${hostRecords.join(', ')}. `
      + 'A project supplies these from its own manifests; depending on them is ordinary and needs no declaration.',
      undefined, 'composition');
  } else {
    targetCheck = checks.check('declaration.action-targets', 'declaration', 'passed',
      'every declared action targets a record this package owns', undefined, 'composition');
  }

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
    checks: [...declaration.checks, targetCheck, ...composition.checks],
    problems: [...declaration.problems, ...composition.problems],
    prerequisites: prerequisites.map((entry) => ({
      name: entry.name, relativeDir: entry.relativeDir, topSegment: entry.topSegment,
      exportName: entry.exportName, isFactory: entry.isFactory,
    })),
    missingProviders: missingProviders.sort(),
    impliedPrerequisites,
    undeclaredRecordOwners: [...new Set(undeclared.map((record) => ownerOf.get(record)))].sort(),
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
