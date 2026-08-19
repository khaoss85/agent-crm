import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_MANIFESTS, POLICY, SIGNATURE_MANIFESTS, boot, signedOrder,
} from './helpers/contracts-project.js';

/**
 * **A shipped M16a project adopts M16b over live rows — and detaches again.**
 *
 * Every other M16b suite composes a project where the two new manifests were
 * applied to an *empty* database, which proves they parse. It does not prove
 * that a project already carrying activated contracts, renewal decisions and
 * commercial follow-ups can adopt amendment execution without losing anything,
 * and it does not prove the two new tables survive the package being removed.
 * A record that only works on a fresh database is not an evolution, and a
 * package that takes its data with it is not detachable.
 *
 * The post-upgrade halves run in **fresh processes**: Node caches ESM modules by
 * URL, so re-booting in this one would keep the pre-upgrade composition file and
 * the pre-upgrade generated services, and prove nothing.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];
const ACTOR = { type: 'user', id: 'e2e' };

const SOURCE_TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};
const SUCCESSOR_TERM = {
  effectiveDate: '2027-09-01', termStartDate: '2027-09-01', termEndDate: '2028-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};

/**
 * The M16a-era manifests: no `contract-succession`.
 *
 * `amendment-run` is applied in the pre-upgrade phase too, and deliberately: an
 * action's target module must exist for the application to boot, so a project
 * that pulls the M16b code **must** apply that manifest before composing the
 * package. That ordering rule is not a gap this test papers over — it is the
 * framework's existing behaviour, and the second test below proves the other
 * half of it by leaving `contract-succession` unapplied and showing the refusal
 * is a sentence naming the file rather than a crash three calls deeper.
 *
 * What this test therefore proves is the part that is actually at risk: adding
 * the lineage record to a database that already holds activated contracts,
 * recorded renewal intent and an open commercial follow-up loses none of it,
 * and rewrites none of it when a successor is then executed.
 */
const M16A_CONTRACTS = [
  'contract-activation.module.json', 'commercial-contract.module.json',
  'contract-version.module.json', 'contract-line.module.json',
  'subscription.module.json', 'subscription-line.module.json',
  'delivery-obligation.module.json', 'service-obligation.module.json',
];
const M16A_LIFECYCLE = ['renewal-decision.module.json', 'commercial-followup.module.json'];

/** The boot helper, re-exported inside the throwaway project for the children. */
const HELPER = "export { boot } from './tests/helpers/contracts-project.js';\n";

/** Child 1: the M16b surface exists and works over rows a previous process wrote. */
const UPGRADE_CHECK = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { boot } = await import(pathToFileURL(join(root, 'tests-helper.mjs')).href);
const state = JSON.parse(readFileSync(join(root, 'probe-state.json'), 'utf8'));
const context = await boot(root, join(root, 'data', 'upgrade.sqlite'));
const actor = { type: 'user', id: 'e2e' };
try {
  const app = context.app;
  const decisionsBefore = app.modules.get('renewal-decision').service.listWhere({ contractId: state.contractId });
  const followupsBefore = app.modules.get('commercial-followup').service.listWhere({ contractId: state.contractId });
  const contractBefore = app.modules.get('commercial-contract').service.get(state.contractId);

  const run = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: state.contractId,
    input: { reason: 'renewal after upgrade', decisionId: state.decisionId }, actor,
  })).result;
  await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: run.id,
    input: { successorOrderId: state.successorOrderId, policy: '${POLICY.policy}', policyVersion: ${POLICY.policyVersion} }, actor,
  });
  const executed = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id,
    input: { policy: '${POLICY.policy}', policyVersion: ${POLICY.policyVersion} }, actor,
  })).result;

  console.log(JSON.stringify({
    decisionsPreserved: decisionsBefore.length,
    followupsPreserved: followupsBefore.length,
    decisionRow: decisionsBefore[0] ?? null,
    followupRow: followupsBefore[0] ?? null,
    contractBefore,
    contractAfter: app.modules.get('commercial-contract').service.get(state.contractId),
    successionId: executed.succession.id,
    successorContractId: executed.successorContractId,
    classification: executed.classification,
  }));
} finally { await context.close(); }
`;

/** Child 2: lifecycle is detached; its rows and the lineage row must outlive it. */
const DETACH_CHECK = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { boot } = await import(pathToFileURL(join(root, 'tests-helper.mjs')).href);
const state = JSON.parse(readFileSync(join(root, 'probe-state.json'), 'utf8'));
const context = await boot(root, join(root, 'data', 'upgrade.sqlite'));
try {
  const app = context.app;
  const runs = app.modules.get('amendment-run').service.list({ limit: 100 });
  const successions = app.modules.get('contract-succession').service.list({ limit: 100 });
  let actionExists = true;
  try {
    await app.runAction({
      module: 'commercial-contract', action: 'plan-amendment', recordId: state.contractId,
      input: {}, actor: { type: 'user', id: 'e2e' },
    });
  } catch (error) {
    actionExists = !/not found|unknown action/i.test(String(error.message));
  }
  console.log(JSON.stringify({
    packages: [...app.domains.names()],
    runsPreserved: runs.length,
    successionsPreserved: successions.length,
    successionRow: successions[0] ?? null,
    lifecycleActionStillRegistered: actionExists,
  }));
} finally { await context.close(); }
`;

function composition(root, { withLifecycle }) {
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    "import { createSignatureDomain } from '../../signature/src/index.js';",
    "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
    ...(withLifecycle ? ["import { createLifecyclePackage } from '../../lifecycle/src/index.js';"] : []),
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),',
    '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
    ...(withLifecycle ? ['  createLifecyclePackage(),'] : []),
    '];', '',
  ].join('\n'));
}

function child(script, root) {
  const result = spawnSync(process.execPath, ['--no-warnings', join(root, script), root], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('a shipped M16a project adopts M16b over live rows, and the lineage outlives a detach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m16b-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'tests', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'tests-helper.mjs'), HELPER);
  writeFileSync(join(root, 'upgrade-check.mjs'), UPGRADE_CHECK);
  writeFileSync(join(root, 'detach-check.mjs'), DETACH_CHECK);

  const apply = (manifestPath) => {
    const result = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `apply ${manifestPath}: ${result.stderr}`);
  };

  // ---- a genuine pre-M16b project: M16a manifests only ----
  for (const manifest of COMMERCIAL_MANIFESTS) apply(join(root, 'packages/commercial/modules', manifest));
  for (const manifest of SIGNATURE_MANIFESTS) apply(join(root, 'packages/signature/modules', manifest));
  for (const manifest of M16A_CONTRACTS) apply(join(root, 'packages/contracts/modules', manifest));
  for (const manifest of M16A_LIFECYCLE) apply(join(root, 'packages/lifecycle/modules', manifest));
  apply(join(root, 'packages/lifecycle/modules/amendment-run.module.json'));
  composition(root, { withLifecycle: true });

  const context = await boot(root, join(root, 'data', 'upgrade.sqlite'));
  const source = await signedOrder(root, context.app, { name: 'Legacy M16a', offers: OFFERS, term: SOURCE_TERM });
  await context.app.runAction({
    module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR,
  });
  const contract = context.app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];

  // Real M16a evidence: an intent decision and an open commercial follow-up.
  const decision = (await context.app.runAction({
    module: 'commercial-contract', action: 'record-renewal-decision', recordId: contract.id,
    input: { decision: 'pursue_renewal', reason: 'the customer wants to continue', asOf: '2026-09-15' }, actor: ACTOR,
  })).result;
  await context.app.runAction({
    module: 'commercial-contract', action: 'request-commercial-followup', recordId: contract.id,
    input: { intent: 'renewal', summary: 'prepare the renewal quote', decisionId: decision.id }, actor: ACTOR,
  });

  // …and the successor Order the upgraded project will execute against.
  const successor = await signedOrder(root, context.app, {
    name: 'Legacy M16a Renewal', offers: OFFERS, term: SUCCESSOR_TERM,
    company: source.company, contact: source.contact,
    quantities: { 'fixture:offer:enterprise': 30 },
  });

  // The lineage record genuinely does not exist yet, and no round was ever
  // opened in this phase — this is an M16a project's data, not a seeded one.
  assert.throws(() => context.app.modules.get('contract-succession'), /not found/i);
  assert.equal(context.app.modules.get('amendment-run').service.list({ limit: 10 }).length, 0);
  const decisionsBefore = context.app.modules.get('renewal-decision').service.listWhere({ contractId: contract.id });
  const followupsBefore = context.app.modules.get('commercial-followup').service.listWhere({ contractId: contract.id });
  const contractBefore = context.app.modules.get('commercial-contract').service.get(contract.id);
  assert.equal(decisionsBefore.length, 1);
  assert.equal(followupsBefore.length, 1);
  await context.close();

  writeFileSync(join(root, 'probe-state.json'), JSON.stringify({
    contractId: contract.id, decisionId: decision.id, successorOrderId: successor.order.id,
  }));

  // ---- adopt M16b: the lineage record, applied over populated tables ----
  apply(join(root, 'packages/contracts/modules/contract-succession.module.json'));

  const upgraded = child('upgrade-check.mjs', root);
  assert.equal(upgraded.decisionsPreserved, 1, 'the M16a decision survived the upgrade');
  assert.equal(upgraded.followupsPreserved, 1, 'and so did the open follow-up');
  assert.deepEqual(upgraded.decisionRow, decisionsBefore[0], 'byte-for-byte, not merely present');
  assert.deepEqual(upgraded.followupRow, followupsBefore[0]);
  assert.deepEqual(upgraded.contractBefore, contractBefore, 'the activated contract is untouched by the upgrade');
  assert.deepEqual(upgraded.contractAfter, contractBefore,
    'and untouched by the execution: a successor rewrites nothing behind it');
  assert.ok(upgraded.successionId, 'the upgraded project executed a real successor');
  assert.equal(upgraded.classification, 'expansion');

  // ---- detach lifecycle: the rows must outlive the package ----
  composition(root, { withLifecycle: false });
  const detached = child('detach-check.mjs', root);
  assert.equal(detached.packages.includes('lifecycle'), false, 'the package really is gone');
  assert.equal(detached.packages.includes('contracts'), true, 'and everything else still composes');
  assert.equal(detached.runsPreserved, 1, 'the amendment run outlived the package that wrote it');
  assert.equal(detached.successionsPreserved, 1, 'and so did the lineage row, which contracts owns');
  assert.equal(detached.successionRow.successorContractId, upgraded.successorContractId);
  assert.equal(detached.lifecycleActionStillRegistered, false,
    'the actions left with the package; only the evidence stayed');

  // ---- reattach: the evidence is still there, and still readable ----
  composition(root, { withLifecycle: true });
  const reattached = child('detach-check.mjs', root);
  assert.equal(reattached.packages.includes('lifecycle'), true);
  assert.equal(reattached.runsPreserved, 1);
  assert.equal(reattached.successionsPreserved, 1);
  assert.deepEqual(reattached.successionRow, detached.successionRow, 'byte-identical across detach and reattach');
});

test('a project that composes M16b without applying its lineage record is refused with a sentence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m16b-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const apply = (manifestPath) => {
    const result = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `apply ${manifestPath}: ${result.stderr}`);
  };
  for (const manifest of COMMERCIAL_MANIFESTS) apply(join(root, 'packages/commercial/modules', manifest));
  for (const manifest of SIGNATURE_MANIFESTS) apply(join(root, 'packages/signature/modules', manifest));
  for (const manifest of M16A_CONTRACTS) apply(join(root, 'packages/contracts/modules', manifest));
  for (const manifest of M16A_LIFECYCLE) apply(join(root, 'packages/lifecycle/modules', manifest));
  // The run record IS applied; the lineage record deliberately is not.
  apply(join(root, 'packages/lifecycle/modules/amendment-run.module.json'));
  composition(root, { withLifecycle: true });

  const context = await boot(root, join(root, 'data', 'missing.sqlite'));
  t.after(() => context.close());
  const source = await signedOrder(root, context.app, { name: 'Missing Lineage', offers: OFFERS, term: SOURCE_TERM });
  await context.app.runAction({
    module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR,
  });
  const contract = context.app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];

  // The application still boots, and every M16a action still works: the gap is
  // scoped to the one capability that needs the record.
  const planned = await context.app.runAction({
    module: 'commercial-contract', action: 'plan-renewal', recordId: contract.id,
    input: { asOf: '2026-09-15' }, actor: ACTOR,
  });
  assert.equal(planned.result.lifecyclePlanContract, 1, 'M16a is unaffected by the missing M16b record');

  await assert.rejects(
    () => context.app.runAction({
      module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
      input: { reason: 'renewal' }, actor: ACTOR,
    }),
    (error) => {
      assert.equal(error.code, 'CONTRACT_STORAGE_INVALID');
      assert.match(error.message, /contract-succession/, 'the refusal names the record that is missing');
      assert.match(error.message, /Apply packages\/contracts\/modules\/contract-succession\.module\.json/,
        'and says what to do about it, rather than failing three calls deeper');
      return true;
    },
  );
});
