import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageRegistry, definePackage } from '../packages/core/index.js';
import { createCommercialDomain } from '../packages/commercial/src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'tests/commercial-quotes-deprecation.test.js';

/**
 * The retirement of `commercial-quotes@1` (TASKS.md:209): every consumer has
 * moved to the integrity-verifying contract (`commercial-quotes@2`), so the
 * version-1 edge is unoffered. Two properties hold the retirement in place:
 *
 * 1. no in-repo consumer still declares or opens `commercial-quotes@1` — the
 *    set is enumerated from the repository, not assumed empty;
 * 2. a consumer still on v1 is refused at composition, with the consumer
 *    named — the registry's own `DEPENDENCY_UNSATISFIED` refusal, proved
 *    rather than remembered.
 */

/**
 * A version-1 consumer declares `capability: 'commercial-quotes', version: 1`
 * in its `requires`, or opens it through `domains.capability` with the same
 * pair. One marker covers both: the pair never appears for any other reason.
 * (`name: 'commercial-quotes'` with a separate `version: 1` is the capability
 * FACTORY `@2` still builds on — an implementation, not an offered contract,
 * so it is not a consumer and the marker does not match it.)
 */
const V1_CONSUMER = /capability:\s*'commercial-quotes'\s*,\s*version:\s*1(?!\d)/;

function sourceFiles(dir, { includeTests }) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'generated' || name === 'modules') continue;
      found.push(...sourceFiles(path, { includeTests }));
      continue;
    }
    if (!name.endsWith('.js')) continue;
    if (!includeTests && name.endsWith('.test.js')) continue;
    found.push(path);
  }
  return found;
}

/**
 * Every place a version-1 consumer could hide, discovered rather than listed:
 * each package's `src`, each app's runtime source, and the suite itself (the
 * last `@1` consumer was a test probe). Only this file is excluded — it names
 * the retired version in its own refusal proof below, and the exclusion is
 * this one path, not a widening allow-list.
 */
function consumerRoots() {
  const roots = [];
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    const src = join(repoRoot, 'packages', pkg, 'src');
    try { if (statSync(src).isDirectory()) roots.push({ dir: src, includeTests: false }); } catch { /* no src */ }
  }
  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    for (const sub of ['src', 'public']) {
      const dir = join(repoRoot, 'apps', app, sub);
      try { if (statSync(dir).isDirectory()) roots.push({ dir, includeTests: false }); } catch { /* absent */ }
    }
  }
  roots.push({ dir: join(repoRoot, 'tests'), includeTests: true });
  return roots;
}

test('no in-repo consumer still declares or opens commercial-quotes@1', () => {
  const holders = [];
  for (const { dir, includeTests } of consumerRoots()) {
    for (const path of sourceFiles(dir, { includeTests })) {
      const relative = path.slice(repoRoot.length).replace(/^\//, '');
      if (relative === SELF) continue;
      if (V1_CONSUMER.test(readFileSync(path, 'utf8'))) holders.push(relative);
    }
  }
  holders.sort();
  assert.deepEqual(holders, [],
    `commercial-quotes@1 is retired: ${holders.join(', ')} still declares or opens it — move it to commercial-quotes@2 first`);
});

test('a consumer still on v1 is refused at composition, with the consumer named', () => {
  const probe = definePackage({
    packageContract: 1, name: 'v1-probe', version: 1, label: 'V1 probe',
    description: 'A consumer that never left commercial-quotes@1, so the retirement must refuse it by name.',
    resources: [], actions: [], policies: [], capabilities: [],
    requires: [
      { package: 'commercial', capability: 'commercial-quotes', version: 1 },
    ],
  });
  assert.throws(
    () => new PackageRegistry({ packages: [createCommercialDomain(), probe] }),
    (error) => error instanceof Error
      && error.message.includes('Package "v1-probe" requires "commercial" capability commercial-quotes@1')
      && error.message.includes('commercial-quotes@2'),
    'a @1 requirement must be refused naming the consumer and the offered @2',
  );
});
