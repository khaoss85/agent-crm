import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_MANIFESTS, DOMAIN_MANIFESTS, LIFECYCLE_MANIFESTS, SIGNATURE_MANIFESTS,
  activatedContract, boot,
} from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The ADR-019 upgrade, on data that predates signed terms.
 *
 * A shipped project has contracts activated under the single operational
 * `termsSource`, three term-free record families and no term tables at all.
 * Adopting signed terms is: apply the revision-2 contracts manifests (an
 * enum-widen table REBUILD — SQLite cannot alter a CHECK) and apply the three
 * new term manifests. Nothing else. The rows written before the upgrade must
 * come through byte-identical, still classified `signed: false`, and the same
 * database must then carry a NEW signed-term journey end to end.
 *
 * Phase 2 runs in a child process: the composition and generated modules
 * changed on disk, and an in-process re-boot would silently reuse the cached
 * modules of phase 1.
 */

const TERM_MANIFESTS = ['quote-term.module.json', 'quote-version-term.module.json'];

const CHECK = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[2];
const state = JSON.parse(process.argv[3]);
const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
const { signedOrder } = await import(pathToFileURL(join(root, 'tests-helper.mjs')).href);
const app = createAccordoApp({ dbPath: join(root, 'data', 'terms-upgrade.sqlite'), clock: () => '2026-09-15T10:00:00.000Z' });
const actor = { type: 'user', id: 'upgrade' };
const out = {};
try {
  // The pre-upgrade contract, byte for byte.
  const contract = app.modules.get('commercial-contract').service.get(state.contractId);
  out.before = {
    termsSource: contract.termsSource,
    termDays: contract.termDays,
    termEndDate: contract.termEndDate,
    termsReason: contract.termsReason,
  };
  const lifecycle = app.domains.capability({ consumer: 'lifecycle', capability: 'contract-lifecycle-source', version: 2, context: { modules: app.modules } });
  const evidence = lifecycle.termEvidence(contract.id);
  out.beforeSigned = evidence.term.signed;

  // A NEW signed-term journey on the upgraded database.
  const { order, versionId } = await signedOrder(root, app, {
    name: 'Post Upgrade Signed', offers: ['fixture:offer:enterprise'],
    term: { effectiveDate: '2026-10-01', termStartDate: '2026-10-01', termEndDate: '2027-09-30', autoRenew: true, renewalNoticeDays: 30 },
  });
  out.orderTerm = app.modules.get('order-term').service.listWhere({ orderId: order.id })[0]?.termEndDate ?? null;
  const activated = await app.runAction({
    module: 'order', action: 'activate-contract', recordId: order.id,
    input: { policy: 'b2b-saas-order-activation', policyVersion: 1 },
    actor,
  });
  out.newSource = activated.result.contract.termsSource;
  out.newSigned = lifecycle.termEvidence(activated.result.contract.id).term.signed;
  out.versionTermExists = app.modules.get('quote-version-term').service.listWhere({ versionId }).length === 1;
} finally { app.close(); }
console.log('__RESULT__' + JSON.stringify(out));
`;

test('a pre-terms database adopts signed terms: enum widened, tables added, history untouched', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-terms-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'tests', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'tests-helper.mjs'), "export { signedOrder } from './tests/helpers/contracts-project.js';\n");
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    "import { createSignatureDomain } from '../../signature/src/index.js';",
    "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    "import { b2bSaasOrderActivationV1 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
    "import { createLifecyclePackage } from '../../lifecycle/src/index.js';",
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),',
    '  createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),',
    '  createLifecyclePackage(),',
    '];', '',
  ].join('\n'));

  const apply = (manifestPath) => {
    const result = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `apply ${manifestPath}: ${result.stderr}`);
  };

  // ---- rewind the three evolved manifests to the shape M12 shipped ----
  const evolvedByPath = new Map();
  for (const name of ['commercial-contract', 'contract-version', 'contract-activation']) {
    const manifestPath = join(root, 'packages/contracts/modules', `${name}.module.json`);
    const evolved = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(evolved.revision, 2, `${name} ships at revision 2`);
    evolvedByPath.set(manifestPath, evolved);
    const original = JSON.parse(JSON.stringify(evolved));
    delete original.revision;
    for (const field of original.fields) {
      if (field.name === 'termsSource') field.values = ['post-signature-operational-activation'];
    }
    writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
  }

  // ---- the pre-terms project: no term manifests, single-value enum ----
  for (const manifest of COMMERCIAL_MANIFESTS.filter((name) => !TERM_MANIFESTS.includes(name))) {
    apply(join(root, 'packages/commercial/modules', manifest));
  }
  for (const manifest of SIGNATURE_MANIFESTS.filter((name) => name !== 'order-term.module.json')) {
    apply(join(root, 'packages/signature/modules', manifest));
  }
  for (const manifest of DOMAIN_MANIFESTS) apply(join(root, 'packages/contracts/modules', manifest));
  for (const manifest of LIFECYCLE_MANIFESTS) apply(join(root, 'packages/lifecycle/modules', manifest));

  const context = await boot(root, join(root, 'data', 'terms-upgrade.sqlite'));
  const { contract } = await activatedContract(root, context.app, { name: 'Pre Terms Deal' });
  assert.equal(contract.termsSource, 'post-signature-operational-activation');
  await context.close();

  // ---- the upgrade: evolved manifests (enum-widen REBUILD) + new tables ----
  for (const [manifestPath, evolved] of evolvedByPath) {
    writeFileSync(manifestPath, `${JSON.stringify(evolved, null, 2)}\n`);
    apply(manifestPath); // refused outright if the change is undeclared
  }
  for (const manifest of TERM_MANIFESTS) apply(join(root, 'packages/commercial/modules', manifest));
  apply(join(root, 'packages/signature/modules', 'order-term.module.json'));

  writeFileSync(join(root, 'upgrade-check.mjs'), CHECK);
  const checked = spawnSync(process.execPath,
    ['--no-warnings', join(root, 'upgrade-check.mjs'), root, JSON.stringify({ contractId: contract.id })],
    { encoding: 'utf8' });
  assert.equal(checked.status, 0, `the upgraded project does not boot: ${checked.stderr}`);
  const report = JSON.parse(checked.stdout.trim().split('\n').filter((line) => line.startsWith('__RESULT__')).pop().slice('__RESULT__'.length));

  assert.deepEqual(report.before, {
    termsSource: contract.termsSource,
    termDays: contract.termDays,
    termEndDate: contract.termEndDate,
    termsReason: contract.termsReason,
  }, 'the pre-upgrade contract reads back byte-identical after the enum-widen rebuild');
  assert.equal(report.beforeSigned, false, 'history keeps its honest operational classification');
  assert.equal(report.versionTermExists, true);
  assert.equal(report.orderTerm, '2027-09-30', 'the upgraded database carries a NEW signed term end to end');
  assert.equal(report.newSource, 'signed-order-terms');
  assert.equal(report.newSigned, true);
});
