// @ts-check

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PackageRegistry, validatePackageDefinition } from '../../packages/core/index.js';

/**
 * The reusable **package conformance** checks.
 *
 * Every domain package answers the same questions, whether it is first-party
 * or written by a customer for their own repository. This helper asks them
 * once so each package's own suite does not re-implement — and so a package
 * that quietly stops conforming fails somewhere.
 *
 * It is deliberately domain-agnostic: it knows nothing about contracts,
 * delivery or scorecards, and it must stay that way. If a check here needs a
 * domain concept, it belongs in that package's own tests.
 */

const PRIVATE_IMPORT_RE = /from\s+'[^']*core\/src\/[^']*'/;
const SOURCE_RE = /\.m?js$/;

/** Every JavaScript file under a package directory. */
export function packageSources(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_RE.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @param {{
 *   definition: any,
 *   dir: string,
 *   expected: {name: string, version: number, resources: string[], actions?: string[], requires?: string[], provides?: string[]},
 *   forbiddenImports?: RegExp[],
 * }} spec
 */
export function assertPackageConforms({ definition, dir, expected, forbiddenImports = [] }) {
  // ---- identity and contract ----
  validatePackageDefinition(definition);
  assert.equal(definition.packageContract, 1, 'declares the contract version it was written against');
  assert.equal(definition.name, expected.name);
  assert.equal(definition.version, expected.version);
  assert.ok(typeof definition.label === 'string' && definition.label.length > 0, 'has a human label');

  // ---- what it owns ----
  assert.deepEqual([...(definition.resources ?? [])].sort(), [...expected.resources].sort(), 'declares exactly the resources it owns');
  if (expected.actions) {
    assert.deepEqual(
      (definition.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
      [...expected.actions].sort(),
    );
  }
  assert.deepEqual(
    (definition.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort(),
    [...(expected.requires ?? [])].sort(),
    'declares every cross-package dependency',
  );
  assert.deepEqual(
    (definition.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
    [...(expected.provides ?? [])].sort(),
    'declares every capability it offers',
  );

  // ---- schema metadata is data, never behaviour ----
  const registry = new PackageRegistry({ packages: [{ ...definition, requires: [] }] });
  const metadata = registry.metadata()[definition.name];
  assert.equal(typeof metadata, 'object');
  assert.equal(JSON.stringify(metadata).includes('function'), false, 'metadata is function-free');
  assert.deepEqual(
    JSON.parse(JSON.stringify(registry.metadata())),
    JSON.parse(JSON.stringify(new PackageRegistry({ packages: [{ ...definition, requires: [] }] }).metadata())),
    'metadata is deterministic',
  );
  for (const policy of metadata.policies ?? []) {
    assert.match(policy.fingerprint, /^[0-9a-f]{64}$/, `${policy.name} is fingerprinted`);
  }

  // ---- public imports only ----
  const sources = packageSources(dir);
  assert.ok(sources.length > 0, 'the package has source');
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    assert.equal(PRIVATE_IMPORT_RE.test(source), false, `${file} imports a private kernel path`);
    for (const pattern of forbiddenImports) {
      assert.equal(pattern.test(source), false, `${file} matches a forbidden import ${pattern}`);
    }
    // No dynamic composition: a package is static, checked-in source.
    assert.equal(/\beval\s*\(/.test(source), false, `${file} uses eval`);
    assert.equal(/\bnew Function\s*\(/.test(source), false, `${file} builds a function from text`);
    assert.equal(/await import\(/.test(source), false, `${file} imports dynamically`);
  }

  // ---- registration rules the composition enforces ----
  assert.throws(
    () => new PackageRegistry({ packages: [{ ...definition, requires: [] }, { ...definition, requires: [] }] }),
    /Duplicate domain package name/,
    'the same package cannot be registered twice',
  );
  if ((definition.resources ?? []).length > 0) {
    assert.throws(
      () => new PackageRegistry({
        packages: [
          { ...definition, requires: [] },
          { packageContract: 1, name: 'other-package', version: 1, resources: [definition.resources[0]] },
        ],
      }),
      /Resource collision/,
      'two packages cannot claim one resource',
    );
  }
  for (const entry of definition.requires ?? []) {
    assert.throws(
      () => new PackageRegistry({ packages: [definition] }),
      new RegExp(`requires package "${entry.package}"`),
      'an unmet dependency stops registration',
    );
    break;
  }
  return { metadata, sources };
}

/** @param {string} dir */
export function packageExists(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
