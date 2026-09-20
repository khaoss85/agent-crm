import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PackageRegistry } from '../packages/core/index.js';
import { createMarketingDomain, MARKETING_RESOURCES } from '../packages/marketing/src/index.js';
import { assertPackageConforms } from './helpers/package-conformance.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(repoRoot, 'packages/marketing');
const modulesDir = join(packageDir, 'modules');

const STANDARD_POLICY = { name: 'standard-proposal', version: 1, label: 'Standard proposal', config: {} };

/**
 * MK1 ships as a first-class domain package: the same conformance every
 * domain answers, the same manifest validity the starter demands, and the
 * same fail-closed startup on a malformed policy.
 */

test('the marketing package conforms to the domain package contract', () => {
  const definition = createMarketingDomain({ proposalPolicies: [STANDARD_POLICY] });
  assertPackageConforms({
    definition,
    dir: packageDir,
    expected: {
      name: 'marketing',
      version: 1,
      resources: [...MARKETING_RESOURCES],
      actions: ['campaign-proposal.approve', 'campaign-proposal.propose', 'campaign-proposal.revise', 'funnel-definition.observe', 'funnel-drop-insight.prepare-proposal'],
      provides: ['marketing-proposals@1'],
    },
    // Belt and braces on top of the package's own no-external-effect suite:
    // a network primitive in package source fails conformance too.
    forbiddenImports: [/from\s+['"]node:(https?|net|dgram|tls|dns)['"]/, /\bfetch\s*\(/, /child_process/],
  });
});

test('every marketing manifest validates through the same command the starter uses', () => {
  const manifests = readdirSync(modulesDir).filter((file) => file.endsWith('.module.json')).sort();
  assert.deepEqual(manifests, [
    'campaign-proposal.module.json',
    'campaign-version.module.json',
    'funnel-definition.module.json',
    'funnel-drop-insight.module.json',
    'funnel-run.module.json',
  ]);
  for (const manifest of manifests) {
    const run = spawnSync(
      process.execPath,
      ['--no-warnings', join(repoRoot, 'packages/cli/bin/accordo.js'), 'module', 'validate', join(modulesDir, manifest)],
      { encoding: 'utf8', cwd: repoRoot },
    );
    assert.equal(run.status, 0, `${manifest} validates: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /"ok": true/, manifest);
  }
});

test('a malformed proposal policy stops the package instead of serving half a gate', () => {
  assert.throws(
    () => createMarketingDomain({ proposalPolicies: [{ name: 'Bad Name', version: 1 }] }),
    /name must match/,
  );
  assert.throws(
    () => createMarketingDomain({
      proposalPolicies: [STANDARD_POLICY, { ...STANDARD_POLICY }],
    }),
    /Duplicate proposal policy identity/,
  );
  assert.throws(
    () => createMarketingDomain({
      proposalPolicies: [{ ...STANDARD_POLICY, config: { allowedChannels: ['pigeon'] } }],
    }),
    /allowedChannels/,
  );
});

test('policy metadata is function-free, deterministic and fingerprinted', () => {
  const first = createMarketingDomain({ proposalPolicies: [STANDARD_POLICY] });
  const second = createMarketingDomain({ proposalPolicies: [{ ...STANDARD_POLICY }] });
  const registry = new PackageRegistry({ packages: [{ ...first, requires: [] }] });
  const metadata = registry.metadata().marketing;
  assert.equal(typeof metadata, 'object');
  assert.equal(JSON.stringify(metadata).includes('function'), false);
  assert.match(metadata.proposalPolicies[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(new PackageRegistry({ packages: [{ ...second, requires: [] }] }).metadata().marketing)),
    JSON.parse(JSON.stringify(metadata)),
  );
});

test('the package reaches no other package and offers no operation', () => {
  const definition = createMarketingDomain({ proposalPolicies: [STANDARD_POLICY] });
  assert.deepEqual(definition.requires ?? [], []);
  assert.deepEqual(definition.operations ?? [], []);
});


test('proposal evidence waits for async storage and never converts infrastructure errors into absence', async () => {
  const pkg = createMarketingDomain();
  const create = pkg.capabilities[0].create;
  const capability = create({ modules: { get: () => ({ service: {
    get: async id => ({ id, title: 'Evidence' }),
    listWhere: async () => [{ id: 'v2', versionNumber: 2 }, { id: 'v1', versionNumber: 1 }],
  } }) } });
  assert.equal((await capability.proposal('p')).id, 'p');
  assert.equal((await capability.insight('i')).id, 'i');
  assert.deepEqual((await capability.proposalVersions('p')).map(row => row.id), ['v1', 'v2']);
  for (const async of [false, true]) {
    const unavailable = create({ modules: { get: () => ({ service: {
      get: async ? () => Promise.reject(new Error('storage unavailable')) : () => { throw new Error('storage unavailable'); },
    } }) } });
    if (async) await assert.rejects(() => unavailable.proposal('p'), /storage unavailable/);
    else assert.throws(() => unavailable.proposal('p'), /storage unavailable/);
  }
});
