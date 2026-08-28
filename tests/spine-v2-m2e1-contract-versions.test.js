import test from 'node:test';
import assert from 'node:assert/strict';

import * as publicKernel from '../packages/core/index.js';
import { PackageRegistry, definePackage } from '../packages/core/index.js';
import { actionMetadata } from '../packages/core/src/action-registry.js';
import { resolvePackageComposition } from '../packages/core/src/package-composition.js';

const capability = (name, contract) => ({
  name,
  version: 1,
  ...(contract === undefined ? {} : { capabilityContract: contract }),
  create: () => ({}),
});

const action = (contract) => ({
  module: 'probe-record',
  name: 'run-probe',
  actionContract: contract,
  execute: async () => ({}),
});

const operation = (contract) => ({
  name: 'run-probe',
  operationContract: contract,
  create: () => async () => ({}),
});

const pkg = (name, contract, overrides = {}) => ({
  packageContract: contract,
  name,
  version: 1,
  label: name,
  actions: [],
  operations: [],
  capabilities: [],
  ...overrides,
});

test('capabilityContract absence resolves to v1 before any downstream consumer observes it', () => {
  const absent = pkg('absent-provider', 1, { capabilities: [capability('absent-cap')] });
  const explicit = pkg('explicit-provider', 1, { capabilities: [capability('explicit-cap', 1)] });
  const resolved = resolvePackageComposition([absent, explicit]);

  assert.deepEqual(resolved.problems, []);
  assert.equal(Object.hasOwn(absent.capabilities[0], 'capabilityContract'), false,
    'the v1 source declaration remains backward-compatible');
  assert.equal(resolved.packages.get('absent-provider').capabilities[0].capabilityContract, 1);
  assert.equal(resolved.packages.get('explicit-provider').capabilities[0].capabilityContract, 1);

  const registry = new PackageRegistry({ packages: [absent, explicit] });
  assert.equal(registry.get('absent-provider').provides[0].capabilityContract, 1);
  assert.equal(registry.metadata()['absent-provider'].provides[0].capabilityContract, 1);
});

test('a uniform v2 graph is accepted and every published contract version is truthful', () => {
  const declaredAction = action(2);
  const declared = definePackage(pkg('async-provider', 2, {
    actions: [declaredAction],
    operations: [operation(2)],
    capabilities: [capability('async-cap', 2)],
  }));
  const resolved = resolvePackageComposition([declared]);
  assert.deepEqual(resolved.problems, []);

  const registry = new PackageRegistry({ packages: [declared] });
  assert.deepEqual(registry.get('async-provider'), {
    name: 'async-provider',
    version: 1,
    packageContract: 2,
    label: 'async-provider',
    resources: [],
    requires: [],
    provides: [{ name: 'async-cap', version: 1, capabilityContract: 2 }],
    actions: ['probe-record.run-probe'],
    operations: [{ name: 'run-probe', operationContract: 2 }],
  });
  const metadata = registry.metadata()['async-provider'];
  assert.equal(metadata.packageContract, 2);
  assert.equal(metadata.provides[0].capabilityContract, 2);
  assert.equal(metadata.operations[0].operationContract, 2);
  assert.equal(registry.report().packageContract, 2);
  assert.equal(registry.report().packages[0].packageContract, 2);
  assert.equal(actionMetadata(declaredAction).actionContract, 2);
});

test('every individually valid sync-v1/async-v2 mixture is refused at composition', () => {
  const cases = [
    ['v1 package with v2 action', pkg('probe', 1, { actions: [action(2)] })],
    ['v2 package with v1 action', pkg('probe', 2, { actions: [action(1)] })],
    ['v1 package with v2 operation', pkg('probe', 1, { operations: [operation(2)] })],
    ['v2 package with v1 operation', pkg('probe', 2, { operations: [operation(1)] })],
    ['v1 package with v2 capability', pkg('probe', 1, { capabilities: [capability('cap', 2)] })],
    ['v2 package with v1 capability', pkg('probe', 2, { capabilities: [capability('cap', 1)] })],
  ];
  for (const [label, definition] of cases) {
    const resolved = resolvePackageComposition([definition]);
    assert.equal(resolved.problems[0]?.code, 'PACKAGE_ASYNC_CONTRACT_REQUIRED', label);
    assert.throws(
      () => new PackageRegistry({ packages: [definition] }),
      (error) => error.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
      label,
    );
  }

  const disconnected = resolvePackageComposition([pkg('sync-package', 1), pkg('async-package', 2)]);
  assert.equal(disconnected.problems[0]?.code, 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.match(disconnected.problems[0].message, /separate application graphs/);
});

test('a v2 package requiring a v1 capability fails with the ratified stable refusal', () => {
  const provider = pkg('sync-provider', 1, { capabilities: [capability('facts')] });
  const consumer = pkg('async-consumer', 2, {
    requires: [{ package: 'sync-provider', capability: 'facts', version: 1 }],
  });
  const resolved = resolvePackageComposition([provider, consumer]);
  assert.equal(resolved.problems[0].code, 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.equal(resolved.problems[0].package, 'async-consumer');
  assert.equal(resolved.problems[0].capability, 'facts@1');
  assert.match(resolved.problems[0].message, /capabilityContract 1/);
  assert.throws(
    () => new PackageRegistry({ packages: [provider, consumer] }),
    (error) => error.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED'
      && error.status === 400
      && error.details?.capabilityContract === 1,
  );
});

test('capability contract typo detection names contract fields without rejecting ordinary metadata', () => {
  assert.doesNotThrow(() => definePackage(pkg('metadata-ok', 1, {
    capabilities: [{
      ...capability('facts'),
      contractor: 'example',
      contractNotes: 'ordinary metadata',
      capabilityContractor: 'ordinary metadata too',
    }],
  })));

  for (const key of ['capabilitiesContract', 'capability_contract', 'capabilityContractVersion']) {
    assert.throws(
      () => definePackage(pkg('typo-provider', 1, {
        capabilities: [{ ...capability('facts'), [key]: 2 }],
      })),
      new RegExp(`declares "${key}"; did you mean capabilityContract`),
    );
  }
});

test('accepted-version sets and capability defaults stay private to the kernel', () => {
  for (const name of [
    'SUPPORTED_PACKAGE_CONTRACTS',
    'SUPPORTED_OPERATION_CONTRACTS',
    'SUPPORTED_CAPABILITY_CONTRACTS',
    'DEFAULT_CAPABILITY_CONTRACT',
  ]) {
    assert.equal(Object.hasOwn(publicKernel, name), false, `${name} is not a package-authoring API`);
  }
  assert.equal(publicKernel.SUPPORTED_PACKAGE_CONTRACT, 1,
    'the existing public scalar remains the contract emitted by v1 scaffolding');
});
