import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as publicKernel from '../packages/core/index.js';
import { PackageRegistry, definePackage, validatePackageDefinition } from '../packages/core/index.js';
import { validatePackageCommand } from '../packages/cli/src/package-commands.js';
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

test('mixed-graph diagnostics bound every unbounded hostile member identity without rejecting declarations', () => {
  const hostileName = `run-${'x'.repeat(200_000)}`;
  const cases = [
    ['action', { actions: [{ ...action(2), name: hostileName }] }],
    ['capability', { capabilities: [capability(hostileName, 2)] }],
  ];

  for (const [kind, members] of cases) {
    const definition = pkg(`bounded-${kind}`, 1, members);
    assert.doesNotThrow(() => validatePackageDefinition(definition),
      `${kind}: M2E-1 does not invent a new declaration length limit`);
    const resolved = resolvePackageComposition([definition]);
    const problem = resolved.problems[0];
    assert.equal(problem.code, 'PACKAGE_ASYNC_CONTRACT_REQUIRED', kind);
    assert.ok(problem.message.length < 1_000, `${kind} message length: ${problem.message.length}`);
    assert.ok(problem.error.details.member.length <= 161,
      `${kind} member length: ${problem.error.details.member.length}`);
    assert.equal(problem.message.includes(hostileName), false, kind);
    assert.equal(JSON.stringify(problem.error.details).includes(hostileName), false, kind);
    assert.match(problem.error.details.member, /…$/, kind);
  }
});

test('overlong operation identities are bounded by the existing declaration contract', () => {
  const hostileName = `run-${'x'.repeat(200_000)}`;
  const definition = pkg('bounded-operation', 1, {
    operations: [{ ...operation(2), name: hostileName }],
  });

  assert.throws(
    () => validatePackageDefinition(definition),
    /operation name must match .* and be at most 64 characters/,
    'the pre-M2E-1 operation identity limit remains in force',
  );
  const resolved = resolvePackageComposition([definition]);
  assert.equal(resolved.problems[0]?.code, 'PACKAGE_INVALID');
  assert.ok(resolved.problems[0].message.length < 1_000);
  assert.equal(resolved.problems[0].message.includes(hostileName), false);
});

test('package composition refuses malformed action entries before any consumer dereferences them', () => {
  const missingContract = action(1);
  delete missingContract.actionContract;
  const missingExecute = action(1);
  delete missingExecute.execute;
  const inherited = Object.assign(Object.create({ inherited: true }), action(1));
  const cases = [
    ['null entry', null, /plain object/],
    ['array entry', [], /plain object/],
    ['non-plain entry', inherited, /plain object/],
    ['hostile module', { ...action(1), module: 'Bad Module' }, /module must match/],
    ['hostile name', { ...action(1), name: 'Bad Name' }, /name must match/],
    ['missing contract', missingContract, /actionContract must be one of 1, 2/],
    ['unknown contract', action(3), /actionContract must be one of 1, 2/],
    ['missing execute', missingExecute, /execute must be a function/],
  ];

  for (const [label, entry, pattern] of cases) {
    const definition = pkg('bad-action-package', 1, { actions: [entry] });
    assert.throws(() => validatePackageDefinition(definition), pattern, label);
    const resolved = resolvePackageComposition([definition]);
    assert.equal(resolved.problems[0]?.code, 'PACKAGE_INVALID', label);
    assert.match(resolved.problems[0]?.message ?? '', pattern, label);
    assert.throws(() => new PackageRegistry({ packages: [definition] }), pattern, label);
  }
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

test('capability contract typo detection names contract fields without rejecting ordinary metadata', async () => {
  assert.doesNotThrow(() => definePackage(pkg('metadata-ok', 1, {
    capabilities: [{
      ...capability('facts'),
      contractor: 'example',
      contractNotes: 'ordinary metadata',
      capabilityContractor: 'ordinary metadata too',
    }],
  })));

  const hiddenAsyncInterface = async () => ({
    load: async () => 'a Promise a v1 caller must never receive by typo',
  });
  const hiddenPromise = hiddenAsyncInterface({});
  assert.ok(hiddenPromise instanceof Promise,
    'the hostile fixture executes the Promise-shaped interface the typo would hide');
  assert.equal(typeof (await hiddenPromise).load, 'function');

  for (const key of [
    'capabilitiesContract',
    'capability_contract',
    'capabilityContractVersion',
    'capabilityContracts',
    'capabilitiesContracts',
    'capability_contracts',
    'capabilities-contracts',
  ]) {
    const definition = pkg('typo-provider', 1, {
      capabilities: [{ name: 'facts', version: 1, [key]: 2, create: hiddenAsyncInterface }],
    });
    const consumer = pkg('typo-consumer', 1, {
      requires: [{ package: 'typo-provider', capability: 'facts', version: 1 }],
    });
    assert.throws(
      () => definePackage(definition),
      new RegExp(`declares "${key}"; did you mean capabilityContract`),
    );
    const resolved = resolvePackageComposition([definition, consumer]);
    assert.equal(resolved.problems[0]?.code, 'PACKAGE_INVALID', key);
    assert.match(resolved.problems[0]?.message ?? '', new RegExp(`declares "${key}"`));
    assert.throws(
      () => new PackageRegistry({ packages: [definition, consumer] }),
      new RegExp(`declares "${key}"`),
      key,
    );
  }
});

test('package validate keeps its legacy string problem shape while reporting the mixed-graph reason', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-m2e1-package-validate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/index.js'), `export const fixturePackage = {
  packageContract: 2,
  name: 'mixed-validate-fixture',
  version: 1,
  label: 'mixed validate fixture',
  resources: [],
  actions: [{
    module: 'fixture-record',
    name: 'run-fixture',
    actionContract: 1,
    execute: async () => ({}),
  }],
};
`);

  const report = await validatePackageCommand({ packagePath: dir });
  assert.equal(report.ok, false);
  assert.ok(report.problems.length > 0);
  assert.ok(report.problems.every((problem) => typeof problem === 'string'),
    'package validate keeps its established string[] problem contract');
  assert.match(report.problems[0], /sync-v1 and async-v2 contracts cannot share one package graph/);
});

test('package validate reports malformed actions through its bounded legacy problem shape', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-m2e1-package-action-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/index.js'), `export const fixturePackage = {
  packageContract: 1,
  name: 'malformed-action-fixture',
  version: 1,
  label: 'malformed action fixture',
  resources: [],
  actions: [null],
};
`);

  const report = await validatePackageCommand({ packagePath: dir });
  assert.equal(report.ok, false);
  assert.ok(report.problems.every((problem) => typeof problem === 'string'));
  assert.match(report.problems[0], /actions entry must be a plain object/);
  assert.equal(/TypeError|Cannot read properties/.test(JSON.stringify(report)), false,
    'a malformed declaration remains a contract refusal, never a dereference crash');
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
