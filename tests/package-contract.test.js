import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PackageRegistry, definePackage, validatePackageDefinition } from '../packages/core/index.js';
import { createCommercialDomain } from '../packages/commercial/src/index.js';
import { createSignatureDomain } from '../packages/signature/src/index.js';
import { createContractsDomain } from '../packages/contracts/src/index.js';
import { createDeliveryPackage } from '../packages/delivery/src/index.js';
import { createLifecyclePackage } from '../packages/lifecycle/src/index.js';
import { createPartnerScorecardPackage } from '../examples/custom-packages/partner-scorecard/src/index.js';
import { b2bSaasOrderActivationV1 } from '../examples/starters/b2b-lead-qualification/contracts.js';
import { b2bDeliveryHandoverV1 } from '../examples/starters/b2b-lead-qualification/delivery.js';
import { assertPackageConforms } from './helpers/package-conformance.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args) => spawnSync(
  process.execPath,
  ['--no-warnings', join(repoRoot, 'packages/cli/bin/accordo.js'), ...args],
  { encoding: 'utf8', cwd: repoRoot },
);

/**
 * The public domain-package contract (ADR-018 addendum 3): what every package
 * must declare, what the registry refuses, and the proof that a first-party
 * package and a customer-authored one attach through the identical path.
 */

const refuses = (fn, pattern) => assert.throws(fn, (error) => pattern.test(error.message), pattern.source);
const pkg = (over = {}) => ({
  packageContract: 1, name: 'p', version: 1, label: 'P', resources: [], actions: [], policies: [], ...over,
});

test('the package contract is bounded and fails closed', () => {
  // Identity.
  for (const name of ['', 'P', '1p', 'has space', 'has_underscore', null, 42, undefined]) {
    refuses(() => validatePackageDefinition(pkg({ name })), /name must match|must be an object/);
  }
  refuses(() => validatePackageDefinition(pkg({ packageContract: 2 })), /packageContract must be 1/);
  refuses(() => validatePackageDefinition(pkg({ packageContract: '1' })), /packageContract must be 1/);
  refuses(() => validatePackageDefinition(pkg({ version: 0 })), /version must be a positive integer/);
  refuses(() => validatePackageDefinition(pkg({ version: 1.5 })), /version must be a positive integer/);
  refuses(() => validatePackageDefinition(pkg({ label: '' })), /label must be a non-empty string/);
  refuses(() => validatePackageDefinition(pkg({ description: 'x'.repeat(500) })), /description must be a string/);
  refuses(() => validatePackageDefinition(null), /must be an object/);
  refuses(() => validatePackageDefinition([]), /must be an object|name must match/);

  // Resources.
  refuses(() => validatePackageDefinition(pkg({ resources: 'x' })), /resources must be an array/);
  refuses(() => validatePackageDefinition(pkg({ resources: ['Bad Name'] })), /resource names must match/);
  refuses(() => validatePackageDefinition(pkg({ resources: ['a', 'a'] })), /duplicate resource/);

  // Dependencies.
  refuses(() => validatePackageDefinition(pkg({ requires: [{}] })), /requires\[\]\.package must match/);
  refuses(() => validatePackageDefinition(pkg({ requires: [{ package: 'c', capability: 'Bad' }] })), /requires\[\]\.capability must match/);
  refuses(() => validatePackageDefinition(pkg({ requires: [{ package: 'c', capability: 'x', version: 0 }] })), /requires\[\]\.version/);
  refuses(() => validatePackageDefinition(pkg({ requires: [{ package: 'p', capability: 'x', version: 1 }] })), /cannot require a capability from itself/);
  refuses(
    () => validatePackageDefinition(pkg({ requires: [{ package: 'c', capability: 'x', version: 1 }, { package: 'c', capability: 'x', version: 1 }] })),
    /duplicate requirement/,
  );

  // Capabilities.
  refuses(() => validatePackageDefinition(pkg({ capabilities: [{ name: 'x', version: 1 }] })), /must declare create\(\)/);
  refuses(() => validatePackageDefinition(pkg({ capabilities: [{ name: 'Bad', version: 1, create: () => ({}) }] })), /capability name must match/);
  refuses(
    () => validatePackageDefinition(pkg({ capabilities: [{ name: 'x', version: 1, create: () => ({}) }, { name: 'x', version: 1, create: () => ({}) }] })),
    /duplicate capability/,
  );

  // definePackage is the same validator, so a malformed package fails where it
  // is written rather than at boot.
  refuses(() => definePackage(pkg({ name: 'Bad' })), /name must match/);
  assert.equal(definePackage(pkg()).name, 'p');
});

test('the registry refuses collisions, missing dependencies and cycles', () => {
  refuses(
    () => new PackageRegistry({ packages: [pkg({ resources: ['thing'] }), pkg({ name: 'q', resources: ['thing'] })] }),
    /Resource collision/,
  );
  refuses(
    () => new PackageRegistry({
      packages: [
        pkg({ capabilities: [{ name: 'cap', version: 1, create: () => ({}) }] }),
        pkg({ name: 'q', capabilities: [{ name: 'cap', version: 1, create: () => ({}) }] }),
      ],
    }),
    /Capability collision/,
  );
  refuses(
    () => new PackageRegistry({ packages: [pkg({ requires: [{ package: 'missing', capability: 'cap', version: 1 }] })] }),
    /requires package "missing", which is not registered/,
  );
  refuses(
    () => new PackageRegistry({
      packages: [
        pkg({ name: 'provider', capabilities: [{ name: 'cap', version: 1, create: () => ({}) }] }),
        pkg({ name: 'consumer', requires: [{ package: 'provider', capability: 'cap', version: 2 }] }),
      ],
    }),
    /capability cap@2, which it does not offer \(offers: cap@1\)/,
  );
  // Cycles are startup failures, with the path named.
  refuses(
    () => new PackageRegistry({
      packages: [
        pkg({ name: 'a', requires: [{ package: 'b', capability: 'cb', version: 1 }], capabilities: [{ name: 'ca', version: 1, create: () => ({}) }] }),
        pkg({ name: 'b', requires: [{ package: 'a', capability: 'ca', version: 1 }], capabilities: [{ name: 'cb', version: 1, create: () => ({}) }] }),
      ],
    }),
    /Cyclic package dependency/,
  );

  // A capability may be opened only by a package that declared it.
  const registry = new PackageRegistry({
    packages: [
      pkg({ name: 'provider', capabilities: [{ name: 'cap', version: 1, create: ({ token }) => ({ token }) }] }),
      pkg({ name: 'consumer', requires: [{ package: 'provider', capability: 'cap', version: 1 }] }),
    ],
  });
  assert.deepEqual(registry.capability({ consumer: 'consumer', capability: 'cap', version: 1, context: { token: 7 } }), { token: 7 });
  assert.throws(
    () => registry.capability({ consumer: 'provider', capability: 'cap', version: 1 }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
  );
  assert.throws(
    () => registry.capability({ consumer: '__proto__', capability: 'cap', version: 1 }),
    (error) => error.status === 404,
  );
  // A capability that returns nothing usable is a package defect, not a null.
  const broken = new PackageRegistry({
    packages: [
      pkg({ name: 'provider', capabilities: [{ name: 'cap', version: 1, create: () => null }] }),
      pkg({ name: 'consumer', requires: [{ package: 'provider', capability: 'cap', version: 1 }] }),
    ],
  });
  assert.throws(
    () => broken.capability({ consumer: 'consumer', capability: 'cap', version: 1 }),
    (error) => error.code === 'CAPABILITY_INVALID',
  );
});

test('the first-party contracts package conforms', () => {
  assertPackageConforms({
    definition: createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),
    dir: join(repoRoot, 'packages/contracts'),
    expected: {
      // Version 6: signed commercial terms — `termsSource` widened with
      // `signed-order-terms` (manifest revision 2 on three records),
      // `activate-contract`'s term inputs conditionally required and refused
      // outright on an order carrying a signed term snapshot
      // (`SIGNED_TERMS_AUTHORITATIVE`). (Version 5 was the declared
      // `signature/signature-orders@1` requirement; version 4 the
      // `contract-lifecycle-source@2` move.) Resources, offered capabilities
      // and `packageContract: 1` are untouched by 6.
      name: 'contracts',
      version: 6,
      resources: [
        'commercial-contract', 'contract-version', 'contract-line', 'contract-activation',
        'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
      ],
      actions: ['order.activate-contract', 'order.plan-activation'],
      // The Signature & Order extraction moved ownership of `order` — the
      // record both actions target — into the signature package, so the
      // record-level dependency that always existed is now declarable, and
      // declared. The reads themselves did not move.
      requires: ['signature/signature-orders@1'],
      provides: ['contract-lifecycle-source@2', 'delivery-obligations@1', 'service-obligations@1'],
    },
    // Contracts must reach none of the packages that consume it.
    forbiddenImports: [/from '[^']*delivery\//, /from '[^']*\/service\//, /from '[^']*\/lifecycle\//],
  });
});

test('the first-party delivery package conforms and depends only through a capability', () => {
  assertPackageConforms({
    definition: createDeliveryPackage({ policies: [b2bDeliveryHandoverV1] }),
    dir: join(repoRoot, 'packages/delivery'),
    expected: {
      // Version 4: M14a added the execution transitions, M14b1 the economics
      // evidence and M14b2 change, deliverables and acceptance — additively
      // every time, and without touching packageContract: 1 once.
      name: 'delivery',
      version: 4,
      resources: [
        'delivery-project', 'delivery-work-package', 'delivery-milestone',
        'delivery-partner-engagement', 'delivery-handover-run',
        'delivery-time-entry', 'delivery-expense-entry',
        'delivery-economic-plan', 'delivery-economic-plan-line', 'delivery-economic-snapshot',
        'delivery-change-request', 'delivery-plan-revision', 'delivery-commercial-change',
        'delivery-deliverable', 'delivery-acceptance-request', 'delivery-acceptance-evidence',
      ],
      actions: [
        'commercial-contract.create-delivery-handover',
        'commercial-contract.plan-delivery-handover',
        'delivery-milestone.complete-milestone',
        'delivery-milestone.start-milestone',
        'delivery-project.complete-delivery-project',
        'delivery-project.start-delivery-project',
        'delivery-work-package.block-work-package',
        'delivery-work-package.complete-work-package',
        'delivery-project.preview-delivery-economics',
        'delivery-project.publish-economic-plan',
        'delivery-project.snapshot-delivery-economics',
        'delivery-work-package.record-delivery-expense',
        'delivery-work-package.record-delivery-time',
        'delivery-work-package.resume-work-package',
        'delivery-work-package.start-work-package',
        'delivery-project.propose-change-request',
        'delivery-change-request.decide-change-request',
        'delivery-work-package.plan-deliverable',
        'delivery-deliverable.complete-deliverable',
        'delivery-milestone.request-acceptance',
        'delivery-acceptance-request.record-acceptance',
        'delivery-commercial-change.resolve-commercial-change',
      ],
      requires: ['contracts/delivery-obligations@1'],
      provides: [
        'delivery-economics@1',
        'delivery-change-management@1',
        'delivery-acceptance-evidence@1',
      ],
    },
    forbiddenImports: [/from '[^']*contracts\//],
  });
});

test('the first-party lifecycle package conforms and consumes without offering', () => {
  // M16a shipped without this. Every other first-party package answers the
  // conformance questions here, and a package that quietly stops conforming has
  // to fail somewhere.
  assertPackageConforms({
    definition: createLifecyclePackage(),
    dir: join(repoRoot, 'packages/lifecycle'),
    expected: {
      name: 'lifecycle',
      version: 1,
      resources: ['renewal-decision', 'commercial-followup'],
      // Exactly what ships. `record-expansion-intent` and `record-successor`
      // were described in the plan and never built; expansion and contraction
      // are intents on the follow-up, and no successor is modelled at all.
      actions: [
        'commercial-contract.plan-renewal',
        'commercial-contract.record-renewal-decision',
        'commercial-contract.request-commercial-followup',
        'commercial-followup.resolve-commercial-followup',
      ],
      requires: ['contracts/contract-lifecycle-source@2'],
      provides: [],
    },
    // It reaches Contracts only through the declared capability, and never
    // through the sibling packages that consume the same host record.
    forbiddenImports: [/from '[^']*contracts\//, /from '[^']*delivery\//, /from '[^']*\/service\//],
  });
});

test('a customer-authored package conforms through the identical contract', () => {
  assertPackageConforms({
    definition: createPartnerScorecardPackage(),
    dir: join(repoRoot, 'examples/custom-packages/partner-scorecard'),
    expected: {
      name: 'partner-scorecard',
      version: 1,
      resources: ['partner-scorecard'],
      actions: ['delivery-partner-engagement.rate-partner'],
      requires: [],
      provides: [],
    },
  });

  // The example is authored entirely against the public surface: it imports
  // `packages/core/index.js` and nothing else from the framework.
  const source = readFileSync(join(repoRoot, 'examples/custom-packages/partner-scorecard/src/index.js'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['../../../../packages/core/index.js']);

  // …and the packages compose together without any of them knowing the
  // others exist beyond a declared capability. The chain is longer since the
  // Signature & Order extraction: contracts declares `signature-orders@1`
  // (its actions target the `order` record signature now owns), and signature
  // declares the two commercial capabilities — so the smallest composition
  // that carries partner-scorecard's whole dependency graph is these five.
  const registry = new PackageRegistry({
    packages: [
      createCommercialDomain(),
      createSignatureDomain(),
      createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),
      createDeliveryPackage({ policies: [b2bDeliveryHandoverV1] }),
      createPartnerScorecardPackage(),
    ],
  });
  assert.deepEqual([...registry.names()], ['commercial', 'signature', 'contracts', 'delivery', 'partner-scorecard']);
  assert.deepEqual(Object.keys(registry.metadata()), ['commercial', 'contracts', 'delivery', 'partner-scorecard', 'signature'],
    'metadata is published in name order, whatever the registration order was');
  assert.equal(registry.actions().length, 34, 'M14b2 added seven change and acceptance actions on top of M14b1\'s five; the extracted commercial (8) and signature (1) actions now arrive by composition');
  assert.equal(registry.resources().length, 51, 'signed commercial terms added quote-term, quote-version-term and order-term');
});

test('the kernel never depends on a package, in either direction', () => {
  const kernelDir = join(repoRoot, 'packages/core/src');
  for (const name of readdirSync(kernelDir)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(join(kernelDir, name), 'utf8');
    for (const specifier of [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('node:'),
        `packages/core/src/${name} imports ${specifier}`,
      );
    }
    // …and it never names a domain concept either.
    assert.equal(
      /\b(commercial-contract|delivery-project|work-package|partner-scorecard|subscription-line)\b/.test(source),
      false,
      `packages/core/src/${name} names a domain concept`,
    );
  }
  // The public surface re-exports only from the kernel's own source. Only
  // `export … from` lines count: the file's doc comment shows a package's own
  // import path, which is the opposite direction.
  const publicSurface = readFileSync(join(repoRoot, 'packages/core/index.js'), 'utf8');
  for (const specifier of [...publicSurface.matchAll(/^\s*(?:export|import)[^;]*?from '([^']+)';/gm)].map((match) => match[1])) {
    assert.ok(specifier.startsWith('./src/'), `the public surface re-exports ${specifier}`);
  }
});

test('the package CLI validates, inspects and refuses, read-only', () => {
  const parsed = (result) => JSON.parse(result.stdout);

  const delivery = cli('package', 'validate', 'packages/delivery');
  assert.equal(delivery.status, 0, delivery.stderr);
  assert.equal(parsed(delivery).ok, true);
  assert.deepEqual(parsed(delivery).packages[0].requires, ['contracts/delivery-obligations@1']);
  assert.deepEqual(parsed(delivery).privateImports, []);

  const custom = cli('package', 'validate', 'examples/custom-packages/partner-scorecard');
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(parsed(custom).packages[0].name, 'partner-scorecard');

  // inspect adds the function-free metadata the schema would publish.
  const inspected = cli('package', 'inspect', 'packages/contracts');
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = parsed(inspected);
  assert.equal(report.command, 'package:inspect');
  assert.equal(report.metadata.contracts.contractsContract, 1);
  assert.equal(JSON.stringify(report.metadata).includes('function'), false);
  // Deterministic: two runs on the same tree produce the same bytes.
  assert.equal(cli('package', 'inspect', 'packages/contracts').stdout, inspected.stdout);

  // Failures are non-zero with a useful reason, and never a stack.
  const missing = cli('package', 'validate', 'packages/does-not-exist');
  assert.notEqual(missing.status, 0);
  const notAPackage = cli('package', 'validate', 'packages/cli');
  assert.notEqual(notAPackage.status, 0);
  assert.match(notAPackage.stderr, /No package entry point/);

  // Paths containing spaces work, because customer repositories have them.
  const spaced = join(mkdtempSync(join(tmpdir(), 'pkg cli ')), 'my package');
  try {
    for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
      cpSync(join(repoRoot, entry), join(spaced, entry), { recursive: true });
    }
    const spacedResult = spawnSync(
      process.execPath,
      ['--no-warnings', join(spaced, 'packages/cli/bin/accordo.js'), 'package', 'validate', join(spaced, 'packages/delivery')],
      { encoding: 'utf8', cwd: spaced },
    );
    assert.equal(spacedResult.status, 0, spacedResult.stderr);
    assert.equal(JSON.parse(spacedResult.stdout).ok, true);
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

/**
 * Adversarial review of PR #17. Each case below failed before the fix it names,
 * and each attack is the *accidental* one: the shape a package author reaches
 * for without meaning to cross a boundary.
 */

test('the registry keeps its own state private and hands out no executable definition', () => {
  const registry = new PackageRegistry({
    packages: [
      pkg({ name: 'provider', capabilities: [{ name: 'cap', version: 1, create: () => ({ private: 'data' }) }] }),
      pkg({ name: 'consumer' }),
    ],
  });

  // A package action is handed this registry. Reaching a capability it did not
  // declare must not merely be refused on the polite path: the definition it
  // would need must not be reachable at all.
  const summary = registry.get('provider');
  assert.equal(summary.capabilities, undefined, 'get() must not return capability factories');
  assert.equal(typeof summary.metadata, 'undefined', 'get() must not return functions');
  assert.deepEqual(summary.provides, [{ name: 'cap', version: 1 }]);
  assert.ok(Object.isFrozen(summary), 'the summary is frozen');

  // The registry's own indexes are not a public mutation surface. `resources()`
  // and `names()` are read-only views; there is no Map to write through.
  for (const property of ['packages', 'policies', 'capabilities']) {
    assert.equal(registry[property], undefined, `${property} must not be a public Map`);
  }
  assert.ok(!(registry.resources instanceof Map), 'resources must not be a public Map');
  assert.ok(Object.isFrozen(registry.resources()), 'the resource view is frozen');
  assert.ok(Object.isFrozen(registry.names()), 'the name view is frozen');
  assert.throws(
    () => registry.capability({ consumer: 'consumer', capability: 'cap', version: 1 }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
  );
  // …and self-granting the declaration through the returned summary changes nothing.
  try { summary.requires.push({ package: 'provider', capability: 'cap', version: 1 }); } catch { /* frozen */ }
  assert.throws(
    () => registry.capability({ consumer: 'consumer', capability: 'cap', version: 1 }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
  );
});

test('a package cannot rewrite its own published graph through metadata()', () => {
  const reserved = ['packageContract', 'version', 'resources', 'requires', 'provides', 'actions', 'policies'];
  for (const key of reserved) {
    const registry = new PackageRegistry({
      packages: [pkg({ name: 'liar', metadata: () => ({ [key]: 'forged' }) })],
    });
    refuses(() => registry.metadata(), new RegExp(`metadata\\(\\) may not redeclare "${key}"`));
  }

  // Metadata is published to every client: it must be plain, function-free data.
  const withFunction = new PackageRegistry({ packages: [pkg({ name: 'fn', metadata: () => ({ hostile: () => 1 }) })] });
  refuses(() => withFunction.metadata(), /metadata\(\) must be function-free/);
  const nested = new PackageRegistry({ packages: [pkg({ name: 'deep', metadata: () => ({ a: { b: [{ c: () => 1 }] } }) })] });
  refuses(() => nested.metadata(), /metadata\(\) must be function-free/);

  // The honest case still publishes both the declared block and the computed graph.
  const good = new PackageRegistry({
    packages: [pkg({ name: 'honest', resources: ['a-record'], metadata: () => ({ notModeled: ['nothing'] }) })],
  });
  const published = good.metadata().honest;
  assert.deepEqual(published.resources, ['a-record'], 'the registry owns the graph');
  assert.deepEqual(published.notModeled, ['nothing'], 'the package owns its own block');
});

test('a package name is bounded like every other stored identity', () => {
  refuses(() => validatePackageDefinition(pkg({ name: 'a'.repeat(65) })), /name must be at most 64/);
  assert.equal(validatePackageDefinition(pkg({ name: 'a'.repeat(64) })).name.length, 64);
});
