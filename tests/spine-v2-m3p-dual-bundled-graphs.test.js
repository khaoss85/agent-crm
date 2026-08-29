import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

import { createAccordoApp, createAccordoAppAsync } from '../packages/app/src/index.js';
import {
  PackageRegistry,
  definePackage,
  describePackageGraphContracts,
  refuseAsyncPackagesOnSynchronousFactory,
  selectPackageGraph,
  validatePackageDefinition,
} from '../packages/core/index.js';
import { inspectPackageCommand } from '../packages/cli/src/package-commands.js';
import { runDeclarationChecks, runCompositionChecks } from '../packages/cli/src/package-test-checks.js';
import { assertPackageConforms } from './helpers/package-conformance.js';
import { createWorkPackage, createWorkPackageV2 } from '../packages/work/src/index.js';
import { createCommercialDomain, createCommercialDomainV2 } from '../packages/commercial/src/index.js';
import { createContractsDomain, createContractsDomainV2 } from '../packages/contracts/src/index.js';
import { createCustomerDataPackage, createCustomerDataPackageV2 } from '../packages/customer-data/src/index.js';
import { createDeliveryPackage, createDeliveryPackageV2 } from '../packages/delivery/src/index.js';
import { createIntelligenceDomain, createIntelligenceDomainV2 } from '../packages/intelligence/src/index.js';
import { createLifecyclePackage, createLifecyclePackageV2 } from '../packages/lifecycle/src/index.js';
import { createServicePackage, createServicePackageV2 } from '../packages/service/src/index.js';
import { createSignatureDomain, createSignatureDomainV2 } from '../packages/signature/src/index.js';
import { createPartnerScorecardPackage } from '../examples/custom-packages/partner-scorecard/src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const BUNDLED = Object.freeze([
  ['work', createWorkPackage, createWorkPackageV2, 'packages/work'],
  ['commercial', createCommercialDomain, createCommercialDomainV2, 'packages/commercial'],
  ['contracts', createContractsDomain, createContractsDomainV2, 'packages/contracts'],
  ['customer-data', createCustomerDataPackage, createCustomerDataPackageV2, 'packages/customer-data'],
  ['delivery', createDeliveryPackage, createDeliveryPackageV2, 'packages/delivery'],
  ['intelligence', createIntelligenceDomain, createIntelligenceDomainV2, 'packages/intelligence'],
  ['lifecycle', createLifecyclePackage, createLifecyclePackageV2, 'packages/lifecycle'],
  ['service', createServicePackage, createServicePackageV2, 'packages/service'],
  ['signature', createSignatureDomain, createSignatureDomainV2, 'packages/signature'],
]);

function isAsyncContract(error) {
  return error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400;
}

function assertUniformGraph(definition, contract) {
  const summary = describePackageGraphContracts(definition);
  assert.equal(summary.packageContract, contract, `${definition.name} packageContract`);
  assert.equal(summary.actionContract, contract, `${definition.name} actionContract`);
  assert.equal(summary.operationContract, contract, `${definition.name} operationContract`);
  assert.equal(summary.capabilityContract, contract, `${definition.name} capabilityContract`);
  for (const action of definition.actions ?? []) {
    assert.equal(action.actionContract, contract, `${action.module}.${action.name}`);
  }
  for (const operation of definition.operations ?? []) {
    assert.equal(operation.operationContract, contract, operation.name);
  }
  for (const capability of definition.capabilities ?? []) {
    assert.equal(capability.capabilityContract ?? 1, contract, capability.name);
  }
}

function bundledV2Graph() {
  return [
    createWorkPackageV2(),
    createIntelligenceDomainV2(),
    createCustomerDataPackageV2(),
    createCommercialDomainV2(),
    createSignatureDomainV2(),
    createContractsDomainV2(),
    createDeliveryPackageV2(),
    createServicePackageV2(),
    createLifecyclePackageV2(),
  ];
}

function selectedModulesFor(packages) {
  return [...new Set(packages.flatMap((pkg) => [
    ...(pkg.resources ?? []),
    ...(pkg.actions ?? []).map((action) => action.module),
  ]))].filter((name) => typeof name === 'string').sort();
}

test('selectPackageGraph preserves v1 identity and wraps only the v2 seams', async () => {
  const execute = function execute() { return { ok: true }; };
  const create = function create() { return { ping: () => 'pong' }; };
  const v1 = definePackage({
    packageContract: 1,
    name: 'graph-probe',
    version: 1,
    label: 'Graph probe',
    actions: [{
      module: 'probe-record',
      name: 'run-probe',
      actionContract: 1,
      execute,
    }],
    operations: [{
      name: 'run-probe',
      operationContract: 1,
      create: () => () => ({ ran: true }),
    }],
    capabilities: [{ name: 'probe-cap', version: 1, create }],
  });

  assert.strictEqual(selectPackageGraph(v1, 1), v1);
  assert.strictEqual(v1.actions[0].execute, execute);
  assert.equal(types.isAsyncFunction(v1.actions[0].execute), false);
  assert.equal(types.isAsyncFunction(v1.capabilities[0].create), false);

  const v2 = selectPackageGraph(v1, 2);
  assert.notEqual(v2, v1);
  assertUniformGraph(v2, 2);
  assert.notEqual(v2.actions[0].execute, execute);
  assert.equal(types.isAsyncFunction(v2.actions[0].execute), true);
  assert.equal(types.isAsyncFunction(v1.actions[0].execute), false);
  assert.equal(types.isAsyncFunction(v2.capabilities[0].create), true);
  assert.equal(types.isAsyncFunction(v1.capabilities[0].create), false);
  assert.equal(types.isAsyncFunction(v2.operations[0].create), false);

  const settled = await v2.actions[0].execute();
  assert.deepEqual(settled, { ok: true });
  const iface = await v2.capabilities[0].create();
  assert.equal(iface.ping(), 'pong');
});

test('every bundled package exports a v1 graph and a distinct v2 graph', () => {
  for (const [name, createV1, createV2, dir] of BUNDLED) {
    const v1 = createV1();
    const v2 = createV2();
    assert.equal(v1.name, name);
    assert.equal(v2.name, name);
    assert.notEqual(v1, v2);
    assertUniformGraph(v1, 1);
    assertUniformGraph(v2, 2);
    assertPackageConforms({
      definition: v1,
      dir: join(repoRoot, dir),
      expected: {
        name: v1.name,
        version: v1.version,
        packageContract: 1,
        resources: [...(v1.resources ?? [])],
        actions: (v1.actions ?? []).map((action) => `${action.module}.${action.name}`),
        requires: (v1.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`),
        provides: (v1.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`),
      },
    });
    assertPackageConforms({
      definition: v2,
      dir: join(repoRoot, dir),
      expected: {
        name: v2.name,
        version: v2.version,
        packageContract: 2,
        resources: [...(v2.resources ?? [])],
        actions: (v2.actions ?? []).map((action) => `${action.module}.${action.name}`),
        requires: (v2.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`),
        provides: (v2.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`),
      },
    });

    const declarationV1 = runDeclarationChecks({ definition: v1, dir: join(repoRoot, dir) });
    const declarationV2 = runDeclarationChecks({ definition: v2, dir: join(repoRoot, dir) });
    assert.equal(declarationV1.problems.length, 0, `${name} v1 declaration`);
    assert.equal(declarationV2.problems.length, 0, `${name} v2 declaration`);
    assert.match(declarationV1.checks.find((entry) => entry.id === 'declaration.contract').evidence, /packageContract 1/);
    assert.match(declarationV2.checks.find((entry) => entry.id === 'declaration.contract').evidence, /packageContract 2/);

    const v1Action = v1.actions?.[0];
    const v2Action = v2.actions?.[0];
    if (v1Action && v2Action) {
      assert.notEqual(v1Action.execute ?? v1Action.intent, v2Action.execute ?? v2Action.intent);
      if (typeof v1Action.execute === 'function' && !types.isAsyncFunction(v1Action.execute)) {
        assert.equal(types.isAsyncFunction(v2Action.execute), true);
      }
    }
    const v1Capability = v1.capabilities?.[0];
    const v2Capability = v2.capabilities?.[0];
    if (v1Capability && v2Capability) {
      assert.notEqual(v1Capability.create, v2Capability.create);
      if (!types.isAsyncFunction(v1Capability.create)) {
        assert.equal(types.isAsyncFunction(v2Capability.create), true);
      }
    }
  }
});

test('mixed v1/v2 bundled graphs refuse PACKAGE_ASYNC_CONTRACT_REQUIRED before useful work', () => {
  assert.throws(
    () => new PackageRegistry({ packages: [createWorkPackage(), createCommercialDomainV2()] }),
    isAsyncContract,
  );
  assert.throws(
    () => new PackageRegistry({ packages: [createCommercialDomain(), createSignatureDomainV2()] }),
    isAsyncContract,
  );
  assert.throws(
    () => new PackageRegistry({
      packages: [createWorkPackageV2(), createCommercialDomain()],
    }),
    isAsyncContract,
  );

  const mixedMember = definePackage({
    packageContract: 2,
    name: 'mixed-member',
    version: 1,
    label: 'Mixed member',
    actions: [{
      module: 'probe-record',
      name: 'run-probe',
      actionContract: 1,
      execute: () => ({}),
    }],
  });
  assert.throws(
    () => new PackageRegistry({ packages: [mixedMember] }),
    isAsyncContract,
  );
});

test('createAccordoApp stays synchronous and does not import bundled v2 graphs', () => {
  const v1Source = readFileSync(new URL('../packages/app/src/create-app.js', import.meta.url), 'utf8');
  assert.match(v1Source, /^export function createAccordoApp/m);
  assert.equal(/export async function createAccordoApp/.test(v1Source), false);
  assert.equal(/createWorkPackageV2|createCommercialDomainV2|packageContract:\s*2/.test(v1Source), false);
  assert.equal(/refuseAsyncPackagesOnSynchronousFactory/.test(v1Source), false);

  const asyncSource = readFileSync(new URL('../packages/app/src/create-app-async.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*create-app\.js['"]/.test(asyncSource), false);
  assert.equal(/Promise\.resolve\s*\(/.test(asyncSource), false);
  assert.equal(/generatedDomains/.test(asyncSource), false);

  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.equal(typeof app.then, 'undefined');
    assert.deepEqual(app.domains.names(), []);
    assert.deepEqual(app.services.companies.list(), []);
  } finally {
    app.close();
  }

  assert.throws(
    () => refuseAsyncPackagesOnSynchronousFactory([createWorkPackageV2()]),
    isAsyncContract,
  );
  assert.doesNotThrow(() => refuseAsyncPackagesOnSynchronousFactory([createWorkPackage()]));
});

test('legacy custom v1 package stays green on sync SQLite and fail-closed on portable v2', async () => {
  const custom = createPartnerScorecardPackage();
  assert.equal(custom.packageContract, 1);
  validatePackageDefinition(custom);

  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.deepEqual(app.services.companies.list(), []);
  } finally {
    app.close();
  }

  await assert.rejects(
    () => createAccordoAppAsync({
      selected: { packageContract: 2, packages: [custom], actions: [], modules: [] },
      dbPath: join(repoRoot, 'data', 'm3p-never-created.sqlite'),
    }),
    isAsyncContract,
  );
});

test('createAccordoAppAsync boots kernel plus a uniform bundled v2 graph on SQLite', async (t) => {
  const packages = bundledV2Graph();
  const registry = new PackageRegistry({ packages });
  assert.equal(registry.report().packageContract, 2);
  for (const name of packages.map((pkg) => pkg.name)) {
    assert.equal(registry.get(name).packageContract, 2);
  }

  const composition = runCompositionChecks({
    definition: packages.find((pkg) => pkg.name === 'delivery'),
    providers: packages.filter((pkg) => pkg.name !== 'delivery'),
  });
  assert.equal(composition.problems.length, 0, composition.problems.map((problem) => problem.message).join('; '));

  const app = await createAccordoAppAsync({
    dbPath: ':memory:',
    selected: {
      packageContract: 2,
      packages,
      actions: [],
      modules: selectedModulesFor(packages),
    },
  });
  t.after(() => app.close());
  assert.equal(app.packageContract, 2);
  assert.deepEqual([...app.domains.names()].sort(), [...packages.map((pkg) => pkg.name)].sort());
  assert.equal(app.domains.get('work').packageContract, 2);
  assert.equal(app.domains.get('commercial').packageContract, 2);
  assert.equal(app.modules.get('company').name, 'company');
  const actor = { type: 'system', id: 'm3p' };
  const company = await app.services.companies.create({ name: 'M3P Co' }, { actor });
  assert.equal(app.services.companies.get(company.id).name, 'M3P Co');
});

test('package inspect reports the exact selected v1 graph and the exported v2 companion', async () => {
  const work = await inspectPackageCommand({ packagePath: join(repoRoot, 'packages/work') });
  assert.equal(work.ok, true);
  assert.equal(work.packages[0].packageContract, 1);
  assert.equal(work.selectedGraph.packageContract, 1);
  assert.equal(work.selectedGraph.actionContract, 1);
  assert.equal(work.selectedGraph.capabilityContract, 1);
  assert.deepEqual(
    work.graphs.map((graph) => graph.packageContract).sort(),
    [1, 2],
  );
  const v2 = work.graphs.find((graph) => graph.packageContract === 2);
  assert.equal(v2.export, 'createWorkPackageV2');
  assert.equal(v2.actionContract, 2);
  assert.equal(v2.capabilityContract, 2);

  const custom = await inspectPackageCommand({
    packagePath: join(repoRoot, 'examples/custom-packages/partner-scorecard'),
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.packages[0].packageContract, 1);
  assert.deepEqual(custom.graphs.map((graph) => graph.packageContract), [1]);
});
