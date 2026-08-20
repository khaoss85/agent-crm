// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Every record the customer-data package owns. */
export const CUSTOMER_DATA_MANIFESTS = [
  'customer-import-run.module.json',
  'customer-import-row.module.json',
  'external-identity.module.json',
  'duplicate-candidate.module.json',
  'canonical-link.module.json',
  'data-quality-issue.module.json',
];

/** Commercial + signature + contracts, for the "profile spans packages" proof. */
export const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json', 'quote-term.module.json', 'quote-version-term.module.json',
];

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * A throwaway project composing customer-data, optionally with commercial so
 * the profile has a second package to read across.
 *
 * @param {{after: (fn: () => void) => void}} t
 * @param {{withCommercial?: boolean}} [options]
 */
export function project(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-customer-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }

  for (const manifest of CUSTOMER_DATA_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/customer-data/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  if (options.withCommercial) {
    for (const manifest of COMMERCIAL_MANIFESTS) {
      const applied = cli(root, ['module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply']);
      assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
    }
  }

  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    ...(options.withCommercial ? [
      "import { createCommercialDomain } from '../../commercial/src/index.js';",
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    ] : []),
    'export const generatedDomains = [',
    '  createCustomerDataPackage(),',
    ...(options.withCommercial
      ? ['  createCommercialDomain({ catalogProviders: [fixtureSaasCatalogProvider], discountPolicies: [standardSalesDiscountV1] }),']
      : []),
    '];',
    '',
  ].join('\n'));
  return root;
}

/** Boot the app (and an HTTP server when a client is wanted). */
export async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath, ...options });
  return {
    app,
    async close() { app.close(); },
  };
}

/** A bounded row set that exercises every outcome the import can produce. */
export const ROWS = Object.freeze({
  newContact: { externalId: 'CRM-1', email: 'ada@northwind.example', firstName: 'Ada', lastName: 'Byron', companyName: 'Northwind Ltd', domain: 'northwind.example' },
  sameContactAgain: { externalId: 'CRM-1', email: 'ada@northwind.example', firstName: 'Ada', lastName: 'Byron' },
  otherContact: { externalId: 'CRM-2', email: 'grace@northwind.example', firstName: 'Grace', lastName: 'Hopper', companyName: 'Northwind Ltd', domain: 'northwind.example' },
  invalidEmail: { externalId: 'CRM-3', email: 'not..an@address', firstName: 'Bad', lastName: 'Row' },
  noIdentity: { firstName: 'Nobody' },
});
