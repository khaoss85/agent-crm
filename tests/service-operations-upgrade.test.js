import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMERCIAL_MANIFESTS, DOMAIN_MANIFESTS, SERVICE_MANIFESTS, STARTER_MANIFESTS, activatedContract, boot } from './helpers/contracts-project.js';

/**
 * The ADR-019 upgrade, on data that predates it.
 *
 * M15 takes `service-obligation` to revision 2, gaining `coverageRef`,
 * `activatedAt` and an `activated` status. Every other suite composes a project
 * where revision 2 was applied to an **empty** table, which proves the manifest
 * parses — not that a shipped M12 project can adopt M15 without losing
 * anything. An evolution that only works on a fresh database is not an
 * evolution.
 *
 * So this builds a genuine pre-M15 project at revision 1, drives the real
 * commercial journey until the table carries real obligations, evolves it, and
 * checks the rows survived byte-for-byte before letting M15 consume them.
 *
 * The post-upgrade half runs in a **fresh process**: Node caches ESM modules by
 * URL, so re-booting in this one would keep the pre-upgrade generated service
 * and the pre-upgrade composition file, and prove nothing.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];

const CHECK = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { boot } = await import(pathToFileURL(join(root, 'tests-helper.mjs')).href);
const { contractId } = JSON.parse(readFileSync(join(root, 'probe-state.json'), 'utf8'));
const context = await boot(root, join(root, 'data', 'upgrade.sqlite'));
try {
  const service = context.app.modules.get('service-obligation').service;
  const after = service.listWhere({ contractId });
  const activated = await context.client.module('commercial-contract').action(contractId, 'activate-service', {
    coverageKey: 'after-upgrade', customerRef: 'customer:legacy', startDate: '2026-09-01',
  });
  const consumed = service.listWhere({ contractId, status: 'activated' });
  console.log(JSON.stringify({
    rows: after,
    columns: Object.keys(after[0] ?? {}),
    entitlements: activated.result.entitlements.length,
    coverageId: activated.result.serviceCoverage.id,
    consumed: consumed.map((row) => ({ id: row.id, coverageRef: row.coverageRef, activatedAt: row.activatedAt })),
  }));
} finally { await context.close(); }
`;

/** The boot helper, re-exported inside the throwaway project for the child. */
const HELPER = `
export { boot } from './tests/helpers/contracts-project.js';
`;

function composition(root, { withService }) {
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    "import { buildRequestSignatureAction } from '../../core/src/signature-operations.js';",
    '// The quote actions arrive with the commercial package composition below.',
    'export const generatedActions = [buildRequestSignatureAction()];', '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/signature/generated/index.js'), [
    "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
    'export const generatedSignatureProviders = [fixtureSignatureProvider];', '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
    ...(withService ? [
      "import { createServicePackage } from '../../service/src/index.js';",
      "import { b2bServiceActivationV1, b2bServiceActivationPremiumOnlyV1 } from '../../../examples/starters/b2b-lead-qualification/service.js';",
    ] : []),
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
    ...(withService ? ['  createServicePackage({ policies: [b2bServiceActivationV1, b2bServiceActivationPremiumOnlyV1] }),'] : []),
    '];', '',
  ].join('\n'));
}

test('a shipped M12 project adopts M15 without losing a single obligation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'tests', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'tests-helper.mjs'), HELPER);
  writeFileSync(join(root, 'upgrade-check.mjs'), CHECK);

  const apply = (manifestPath) => {
    const result = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `apply ${manifestPath}: ${result.stderr}`);
    return result;
  };

  // ---- rewind the one evolved manifest to the shape M12 shipped ----
  const manifestPath = join(root, 'packages/contracts/modules/service-obligation.module.json');
  const evolved = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(evolved.revision, 2, 'the shipped manifest is at revision 2');
  const original = JSON.parse(JSON.stringify(evolved));
  delete original.revision;
  original.fields = original.fields.filter((field) => !['coverageRef', 'activatedAt'].includes(field.name));
  for (const field of original.fields) {
    if (field.name === 'status') field.values = ['pending_activation'];
  }
  writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);

  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of COMMERCIAL_MANIFESTS) apply(join(root, 'packages/commercial/modules', manifest));
  for (const manifest of STARTER_MANIFESTS) apply(join(starter, manifest));
  for (const manifest of DOMAIN_MANIFESTS) apply(join(root, 'packages/contracts/modules', manifest));
  composition(root, { withService: false });

  const context = await boot(root, join(root, 'data', 'upgrade.sqlite'));
  const { contract } = await activatedContract(root, context.app, { name: 'Legacy M12', offers: OFFERS });
  const before = context.app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
  assert.ok(before.length >= 1, 'the M12 project raised real service obligations');
  assert.equal(before.every((row) => row.status === 'pending_activation'), true);
  assert.equal(Object.hasOwn(before[0], 'coverageRef'), false, 'revision 1 has no coverageRef');
  assert.equal(Object.hasOwn(before[0], 'activatedAt'), false, 'and no activatedAt');
  await context.close();

  // ---- evolve, then compose the Service package on top ----
  writeFileSync(manifestPath, `${JSON.stringify(evolved, null, 2)}\n`);
  apply(manifestPath); // refused outright if the revision or the change is not declared
  for (const manifest of SERVICE_MANIFESTS) apply(join(root, 'packages/service/modules', manifest));
  composition(root, { withService: true });
  writeFileSync(join(root, 'probe-state.json'), JSON.stringify({ contractId: contract.id }));

  const checked = spawnSync(process.execPath, ['--no-warnings', join(root, 'upgrade-check.mjs'), root],
    { encoding: 'utf8' });
  assert.equal(checked.status, 0, `the upgraded project does not boot: ${checked.stderr}`);
  const report = JSON.parse(checked.stdout.trim().split('\n').pop());

  // 1 · nothing was lost, and nothing was rewritten.
  assert.equal(report.rows.length, before.length, 'every obligation survived the evolution');
  for (const row of before) {
    const now = report.rows.find((entry) => entry.id === row.id);
    assert.ok(now, `obligation ${row.id} survived`);
    for (const [field, value] of Object.entries(row)) {
      if (field === 'updatedAt') continue; // a migration may restamp; the payload may not change
      assert.equal(String(now[field]), String(value), `${field} was rewritten by the migration`);
    }
  }

  // 2 · the new columns exist and are empty, never guessed.
  assert.ok(report.columns.includes('coverageRef'));
  assert.ok(report.columns.includes('activatedAt'));
  assert.equal(report.rows[0].coverageRef, null, 'an obligation nobody activated has no coverage');
  assert.equal(report.rows[0].activatedAt, null);

  // 3 · and M15 consumes data that predates it, widening the enum on the way.
  assert.equal(report.entitlements, before.length, 'each pending obligation became an entitlement');
  assert.equal(report.consumed.length, before.length);
  assert.equal(report.consumed[0].coverageRef, report.coverageId, 'the obligation points at the coverage that consumed it');
  assert.ok(report.consumed[0].activatedAt, 'and carries when that happened');
});
