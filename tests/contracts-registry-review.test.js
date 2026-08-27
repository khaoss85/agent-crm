import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PackageRegistry, validatePackageDefinition } from '../packages/core/index.js';
import { DOMAIN_MANIFESTS, DOMAIN_MODULES, POLICY, TERM, boot, project, signedOrder } from './helpers/contracts-project.js';

/**
 * Milestone 12 adversarial review, part two: the generic domain seam under
 * attack, the package boundary proven by dependency direction rather than
 * assertion, and the cross-link attacks on the signed source.
 */

const ACTIVATION = { ...TERM, termsReason: 'agreed after signature' };

const policy = (over = {}) => ({
  name: 'p', version: 1, config: {}, classifyComponent: () => ({ commercialActivation: 'non_subscription', obligations: [] }), ...over,
});
/** Boot the project in a child process: a restart, not a re-import. */
function bootInChild(root, dbPath) {
  return spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { createAccordoApp } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/app/src/index.js')).href)});
    createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} }).close();
  `], { encoding: 'utf8', cwd: root });
}

const domain = (over = {}) => ({
  name: 'd', packageContract: 1, version: 1, label: 'D', actions: [], policies: [], metadata: () => ({}), ...over,
});

test('the domain seam refuses everything malformed, fail-closed', () => {
  const refuses = (fn, pattern) => assert.throws(fn, (error) => pattern.test(error.message), pattern.source);

  // Identity.
  for (const name of ['', 'D', '1domain', 'has space', 'has_underscore', '__proto__x'.replace('x', ''), null, 42]) {
    refuses(() => validatePackageDefinition(domain({ name })), /name must match|must be an object/);
  }
  refuses(() => validatePackageDefinition(domain({ packageContract: 2 })), /packageContract/);
  refuses(() => validatePackageDefinition(domain({ packageContract: undefined })), /packageContract/);
  refuses(() => validatePackageDefinition(domain({ actions: 'nope' })), /actions must be an array/);
  refuses(() => validatePackageDefinition(domain({ policies: {} })), /policies must be an array/);
  refuses(() => validatePackageDefinition(null), /must be an object/);
  refuses(() => validatePackageDefinition([]), /must be an object|name must match/);

  // Prototype-shaped names never become registry keys.
  const registry = new PackageRegistry({ packages: [domain({ policies: [{ kind: 'k', definition: policy() }] })] });
  assert.equal(registry.has('__proto__'), false);
  assert.equal(registry.has('constructor'), false);
  assert.throws(() => registry.getPolicy('__proto__', 'k', 'p', 1), /Domain policy/);
  assert.throws(() => registry.getPolicy('d', 'k', 'toString', 1), /Domain policy/);
  assert.throws(() => registry.getPolicy('d', 'k', 'p', 2), /Domain policy/, 'a version is always explicit');
  assert.equal(Object.prototype.polluted, undefined);

  // Duplicate identities are startup failures, not last-one-wins.
  assert.throws(() => new PackageRegistry({ packages: [domain(), domain()] }), /Duplicate domain/);
  assert.throws(
    () => new PackageRegistry({ packages: [domain({ policies: [{ kind: 'k', definition: policy() }, { kind: 'k', definition: policy() }] })] }),
    /Duplicate policy identity/,
  );
  // Two different domains may carry the same policy name: identity is scoped.
  const scoped = new PackageRegistry({
    domains: [
      domain({ name: 'a', policies: [{ kind: 'k', definition: policy() }] }),
      domain({ name: 'b', policies: [{ kind: 'k', definition: policy() }] }),
    ],
  });
  // Identity is scoped per package; the registry publishes it, it does not
  // expose the Map (adversarial review of PR #17).
  assert.equal(scoped.metadata().a.policies.length, 1);
  assert.equal(scoped.metadata().b.policies.length, 1);
  assert.notEqual(scoped.getPolicy('a', 'k', 'p', 1), scoped.getPolicy('b', 'k', 'p', 1));

  // Metadata is deterministic, function-free and never introspected blindly.
  const meta = new PackageRegistry({
    domains: [
      domain({ name: 'b', metadata: () => ({ z: 1, a: 2 }) }),
      domain({ name: 'a', metadata: () => ({ nested: { fn: undefined } }) }),
    ],
  }).metadata();
  assert.deepEqual(Object.keys(meta), ['a', 'b'], 'domains are ordered deterministically');
  assert.equal(JSON.stringify(meta).includes('function'), false);
  assert.throws(
    () => new PackageRegistry({ packages: [domain({ metadata: () => 'nope' })] }).metadata(),
    /must return a plain object/,
  );
  // Two registries never share state.
  const first = new PackageRegistry({ packages: [domain()] });
  const second = new PackageRegistry({ packages: [] });
  assert.equal(first.has('d'), true);
  assert.equal(second.has('d'), false);
});

test('policy fingerprints are persisted, drift-checked and all-or-nothing', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'registry.sqlite');
  const context = await boot(root, dbPath);
  t.after(() => context.close());
  const { app } = context;

  const rows = app.database.raw
    .prepare("SELECT type, name, version, fingerprint FROM definition_versions WHERE type LIKE 'domain-policy:%' ORDER BY version")
    .all();
  assert.equal(rows.length, 2, 'both starter policy versions are registered');
  assert.equal(rows[0].type, 'domain-policy:contracts:order-activation-policy');
  assert.match(String(rows[0].fingerprint), /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].fingerprint, rows[1].fingerprint, 'two versions are two definitions');

  // Editing a registered version's config stops the next boot: publishing a
  // new version is the only way to change a decision.
  const policyFile = join(root, 'examples/starters/b2b-lead-qualification/contracts.js');
  const original = readFileSync(policyFile, 'utf8');
  writeFileSync(policyFile, original.replace(
    "'api-calls': { commercial: 'non_subscription', obligations: [] },",
    "'api-calls': { commercial: 'subscription', obligations: [] },",
  ));
  const drifted = bootInChild(root, dbPath);
  assert.notEqual(drifted.status, 0, 'a drifted policy version stops the next boot');
  assert.match(drifted.stderr, /source changed after registration/);
  assert.match(drifted.stderr, /publish a new version/);
  writeFileSync(policyFile, original);
  assert.equal(bootInChild(root, dbPath).status, 0, 'and the unedited definition boots again');

  // A registration that fails halfway leaves nothing behind: the whole set is
  // written in one transaction.
  const before = app.database.raw.prepare("SELECT COUNT(*) AS n FROM definition_versions WHERE type LIKE 'domain-policy:%'").get().n;
  const registry = new PackageRegistry({
    domains: [domain({
      name: 'partial',
      policies: [
        { kind: 'k', definition: policy({ name: 'first' }) },
        { kind: 'k', definition: policy({ name: 'second' }) },
      ],
    })],
  });
  const realPrepare = app.database.raw.prepare.bind(app.database.raw);
  let inserts = 0;
  app.database.raw.prepare = (sql) => {
    const statement = realPrepare(sql);
    // `renderSqliteStatement` quotes every identifier, so the statement the
    // driver receives is `INSERT INTO "definition_versions" (…)` and the old
    // `startsWith('INSERT INTO definition_versions')` no longer matches it —
    // which would leave this interception silently never firing and the
    // rollback assertion below passing without testing anything. The optional
    // opening quote covers both spellings; `\b` after the table name closes the
    // match whether the next character is `"` or `(`. Nothing else here moved:
    // the fault is still thrown on the second insert, and the assertions are
    // unchanged.
    if (!/^INSERT INTO "?definition_versions\b/.test(sql)) return statement;
    return {
      ...statement,
      run: (...args) => {
        inserts += 1;
        if (inserts > 1) throw new Error('injected failure');
        return statement.run(...args);
      },
    };
  };
  assert.throws(() => registry.persistFingerprints(app.database), /injected failure/);
  app.database.raw.prepare = realPrepare;
  assert.equal(
    app.database.raw.prepare("SELECT COUNT(*) AS n FROM definition_versions WHERE type LIKE 'domain-policy:%'").get().n,
    before,
    'a failed registration persists nothing at all',
  );

  // Two app instances registering the same definitions concurrently converge.
  const sibling = await boot(root, dbPath);
  t.after(() => sibling.close());
  assert.equal(
    sibling.app.database.raw.prepare("SELECT COUNT(*) AS n FROM definition_versions WHERE type LIKE 'domain-policy:%'").get().n,
    2,
    'a second app re-verifies rather than duplicating',
  );
});

test('the dependency direction is one-way, and the package is genuinely removable', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'boundary.sqlite');
  const context = await boot(root, dbPath);
  const { app } = context;
  const { order } = await signedOrder(root, app, { name: 'Boundary Deal' });
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { ...POLICY, ...ACTIVATION }, actor: { type: 'user', id: 'e2e' },
  });
  await context.close();

  // Static import graph: nothing the kernel or the app loads reaches the
  // package except the one generated registry file.
  const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  const kernelFiles = spawnSync('find', [join(root, 'packages/core/src'), '-name', '*.js'], { encoding: 'utf8' })
    .stdout.trim().split('\n');
  for (const file of kernelFiles) {
    for (const specifier of importsOf(file)) {
      assert.equal(specifier.includes('contracts/'), false, `${file} imports ${specifier}`);
      assert.equal(specifier.includes('domains/'), false, `${file} imports ${specifier}`);
    }
  }
  const appImports = importsOf(join(root, 'packages/app/src/create-app.js'));
  assert.equal(appImports.some((specifier) => specifier.includes('contracts/src')), false, 'the app never imports the package directly');
  assert.equal(appImports.filter((specifier) => specifier.includes('domains/generated')).length, 1, 'one composition point');

  // Disable the package on a database that ALREADY has its tables and rows:
  // the kernel boots, every earlier milestone works, and the domain surface is
  // simply absent. The data is not deleted behind the operator's back.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');
  // A fresh process is the only honest way to prove a module graph changed.
  const probe = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { createAccordoApp } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/app/src/index.js')).href)});
    const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });
    const out = {
      domains: app.domains.size,
      hasPlan: app.actions.listForModule('order').some((a) => a.name === 'plan-activation'),
      contracts: app.database.raw.prepare('SELECT COUNT(*) AS n FROM commercial_contracts').get().n,
      subscriptionLines: app.database.raw.prepare('SELECT COUNT(*) AS n FROM subscription_lines').get().n,
      orderLink: app.modules.get('order').service.get(${JSON.stringify(order.id)}).contractId !== null,
      signatureRows: app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_envelopes').get().n,
    };
    console.log(JSON.stringify(out));
    app.close();
  `], { encoding: 'utf8', cwd: root, input: '' });
  assert.equal(probe.status, 0, probe.stderr);
  const facts = JSON.parse(probe.stdout.trim().split('\n').at(-1));
  assert.equal(facts.domains, 0, 'no domain is registered');
  assert.equal(facts.hasPlan, false, 'and its actions are gone with it');
  assert.ok(facts.signatureRows >= 1, 'earlier milestones\' evidence is untouched — signature is a package now, and its rows outlive the composition');
  // The rows are still there: removing a package never deletes data.
  assert.equal(facts.contracts, 1, 'the package leaves, the data stays');
  assert.equal(facts.subscriptionLines, 3);
  assert.equal(facts.orderLink, true, 'the order keeps the link it was given');
});

test('cross-linked signature evidence never activates a contract', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'crosslink.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };

  const first = await signedOrder(root, app, { name: 'Cross A' });
  const second = await signedOrder(root, app, { name: 'Cross B' });
  const otherArtifact = app.modules.get('signed-artifact').service.listWhere({ envelopeId: second.envelope.id })[0];

  const orders = app.modules.get('order').service;
  const realGet = orders.get.bind(orders);
  const withOrder = (patch, run) => {
    orders.get = (id) => (id === first.order.id ? { ...realGet(id), ...patch } : realGet(id));
    return run().finally(() => { orders.get = realGet; });
  };
  const activate = () => app.runAction({
    module: 'order', action: 'activate-contract', recordId: first.order.id,
    input: { ...POLICY, ...ACTIVATION }, actor,
  });

  for (const [patch, code] of [
    // Another order's signed artifact.
    [{ signedArtifactId: otherArtifact.id }, 'SOURCE_INCOHERENT'],
    // Another quote version's envelope.
    [{ envelopeId: second.envelope.id }, 'SOURCE_INCOHERENT'],
    // A quote version that does not match the envelope.
    [{ quoteVersionId: second.versionId }, 'SOURCE_INCOHERENT'],
    // An order whose own hash no longer matches what was signed.
    [{ documentHash: 'a'.repeat(64) }, 'SOURCE_HASH_MISMATCH'],
    // A snapshot that lost its components.
    [{ lineCount: 0 }, 'SOURCE_INCOMPLETE'],
  ]) {
    await withOrder(patch, () => assert.rejects(activate, (error) => error.code === code, `${JSON.stringify(patch)} → ${code}`));
  }
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0, 'no cross-linked source produced a contract');

  // A declined envelope is terminal and never activates, even if an order row
  // somehow points at it.
  const declined = await signedOrder(root, app, { name: 'Cross C' });
  const envelopes = app.modules.get('signature-envelope').service;
  const realEnvelopeGet = envelopes.get.bind(envelopes);
  envelopes.get = (id) => (id === declined.envelope.id ? { ...realEnvelopeGet(id), status: 'declined' } : realEnvelopeGet(id));
  await assert.rejects(
    () => app.runAction({ module: 'order', action: 'activate-contract', recordId: declined.order.id, input: { ...POLICY, ...ACTIVATION }, actor }),
    (error) => error.code === 'ORDER_NOT_SIGNED',
  );
  envelopes.get = realEnvelopeGet;

  // The real order still activates: none of the above left damage behind.
  await activate();
  assert.equal(app.modules.get('commercial-contract').service.listWhere({ orderId: first.order.id }).length, 1);
});

test('every M12 collection is read exactly, past the paged list bound', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'exact.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };
  const { order } = await signedOrder(root, app, { name: 'Exact Deal' });
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id, input: { ...POLICY, ...ACTIVATION }, actor,
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  const subscription = app.modules.get('subscription').service.listWhere({ contractId: contract.id })[0];

  // Bulk noise in every collection the activation reads or reports.
  const bulk = {
    'contract-line': (index) => ({
      sourceKey: `contract-line:bulk:${index}`, contractId: `bulk-${index}`, contractVersionId: `bulkv-${index}`,
      orderId: `bulk-order-${index}`, orderComponentId: `bulk-component-${index}`, componentKey: 'bulk', label: 'Bulk',
      chargeType: 'recurring', currency: 'EUR', netAmountCents: 1, commercialActivation: 'non_subscription',
      obligationsJson: '[]', policyCommercialActivation: 'non_subscription', policyObligationsJson: '[]',
      commercialOverridden: false, obligationsOverridden: false, position: index,
    }),
    'subscription-line': (index) => ({
      sourceKey: `subscription-line:bulk:${index}`, subscriptionId: `bulk-sub-${index}`, contractId: `bulk-${index}`,
      contractLineId: `bulk-line-${index}`, orderComponentId: `bulk-component-${index}`, componentKey: 'bulk',
      chargeType: 'recurring', currency: 'EUR', netAmountCents: 1, status: 'active',
    }),
    'delivery-obligation': (index) => ({
      sourceKey: `delivery-obligation:bulk:${index}`, contractId: `bulk-${index}`, contractLineId: `bulk-line-${index}`,
      orderId: `bulk-order-${index}`, orderComponentId: `bulk-component-${index}`, status: 'pending_handover',
      componentKey: 'bulk', currency: 'EUR', netAmountCents: 1,
    }),
    'service-obligation': (index) => ({
      sourceKey: `service-obligation:bulk:${index}`, contractId: `bulk-${index}`, contractLineId: `bulk-line-${index}`,
      orderId: `bulk-order-${index}`, orderComponentId: `bulk-component-${index}`, status: 'pending_activation',
      componentKey: 'bulk', currency: 'EUR', netAmountCents: 1,
    }),
    'contract-activation': (index) => ({
      sourceKey: `activation:bulk:${index}`, orderId: `bulk-order-${index}`, status: 'completed',
      policy: 'p', policyVersion: 1, activatedBy: 'bulk', activatedAt: '2026-08-06T00:00:00.000Z',
    }),
  };
  for (const [module, row] of Object.entries(bulk)) {
    const service = app.modules.get(module).service;
    for (let index = 0; index < 520; index += 1) await service.createManaged(row(index), { actor });
  }

  // The paged list is bounded; every correctness path is an exact lookup.
  for (const module of DOMAIN_MODULES) {
    assert.ok(app.modules.get(module).service.list({ limit: 500 }).length <= 500, module);
  }
  assert.equal(app.modules.get('contract-line').service.countWhere({ contractId: contract.id }), 5);
  assert.equal(app.modules.get('subscription-line').service.countWhere({ subscriptionId: subscription.id }), 3);
  assert.equal(app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id }).length, 1);
  assert.equal(app.modules.get('service-obligation').service.listWhere({ contractId: contract.id }).length, 1);
  assert.equal(app.modules.get('contract-activation').service.listWhere({ orderId: order.id }).length, 1);
  assert.equal(app.modules.get('contract-line').service.listWhere({ orderComponentId: 'bulk-component-511' }).length, 1);

  // And a second activation attempt still finds the existing contract past the
  // bound rather than creating a duplicate.
  await assert.rejects(
    () => app.runAction({ module: 'order', action: 'activate-contract', recordId: order.id, input: { ...POLICY, ...ACTIVATION }, actor }),
    (error) => error.code === 'ORDER_ALREADY_ACTIVATED',
  );
});
