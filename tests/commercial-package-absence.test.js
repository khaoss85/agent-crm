import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Commercial Operations is now optional, and "optional" is a claim that has to
 * be paid for rather than asserted: remove the composition entry and look at
 * what is left — including the rows, which must survive, because a customer
 * who removes a package has not asked anybody to delete their catalog or their
 * signed quote history.
 *
 * **Each phase runs in its own process** — a composition change is a restart,
 * and an in-process re-boot would silently reuse the cached composition module
 * (the artifact the Intelligence absence test caught first).
 */

const MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
];

const COMPOSITION = 'packages/domains/generated/index.js';
const STARTER = '../../../examples/starters/b2b-lead-qualification';

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function compose(root, withCommercial) {
  writeFileSync(join(root, COMPOSITION), withCommercial ? [
    '// @ts-check',
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    'import { fixtureSaasCatalogProvider, standardSalesDiscountV1 }',
    `  from '${STARTER}/commercial.js';`,
    'export const generatedDomains = [createCommercialDomain({',
    '  catalogProviders: [fixtureSaasCatalogProvider],',
    '  discountPolicies: [standardSalesDiscountV1],',
    '})];',
    '',
  ].join('\n') : ['// @ts-check', 'export const generatedDomains = [];', ''].join('\n'));
}

/** Run one phase in a fresh process and return whatever it reported. */
function phase(root, dbPath, body) {
  const script = join(root, `phase-${Math.abs(hash(body))}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    'const actor = { type: "user", id: "absence" };',
    'const out = {};',
    'try {',
    body,
    '} finally { app.close(); }',
    'console.log("__RESULT__" + JSON.stringify(out));',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `phase produced no result (exit ${run.status}):\nSTDOUT: ${run.stdout}\nSTDERR: ${run.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/** @param {string} value */
function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-commercial-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    'export const generatedActions = [];',
    '',
  ].join('\n'));
  return root;
}

test('the commercial domain is genuinely optional: composed, absent, reattached — with the rows intact', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'absence.sqlite');

  // ---- composed: catalog syncs, a quote prices, submits and decides
  compose(root, true);
  const composed = phase(root, dbPath, `
    const sync = await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    out.synced = sync.ok === true;
    const company = await app.services.companies.create({ name: 'Absence Co' }, { actor });
    const opportunity = await app.services.opportunities.create({
      companyId: company.id, name: 'Absence deal', type: 'new_business',
      valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'absence',
    }, { actor });
    out.opportunityId = opportunity.id;
    const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
    const created = await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
      input: { priceBookId: book.id }, actor });
    out.quoteId = created.result.quote.id;
    const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
    await app.runAction({ module: 'quote', action: 'add-line', recordId: out.quoteId,
      input: { offerId: offer.id, quantity: 30 }, actor });
    const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: out.quoteId,
      input: { policy: 'standard-sales-discount', version: 1 }, actor });
    out.decision = submitted.result.version.decision;
    out.oneTimeNet = submitted.result.version.totals.oneTimeTotal.netAmountCents;
    out.schemaHasDomain = Boolean(app.domains.metadata().commercial);
    out.quotes = app.database.raw.prepare('SELECT COUNT(*) AS n FROM quotes').get().n;
    out.offers = app.database.raw.prepare('SELECT COUNT(*) AS n FROM offers').get().n;
  `);
  assert.equal(composed.synced, true, 'the composed domain syncs its catalog');
  assert.equal(composed.decision, 'auto_approve');
  assert.equal(composed.schemaHasDomain, true, 'and publishes its schema contribution');
  assert.equal(composed.quotes, 1);

  // ---- absent: one line removed from the composition, nothing else
  compose(root, false);
  const absent = phase(root, dbPath, `
    const quoteId = ${JSON.stringify(composed.quoteId)};
    out.syncCatalog = typeof app.syncCatalog;
    const made = await app.services.companies.create({ name: 'Still works' }, { actor });
    out.coreStillWorks = Boolean(made.id);
    out.action = await app.runAction({ module: 'quote', action: 'submit', recordId: quoteId,
      input: { policy: 'standard-sales-discount', version: 1 }, actor })
      .then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status }));
    out.createQuote = await app.runAction({ module: 'opportunity', action: 'create-quote',
      recordId: ${JSON.stringify(composed.opportunityId)}, input: { priceBookId: 'any' }, actor })
      .then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status }));
    out.schemaHasDomain = Boolean(app.domains.metadata().commercial);
    out.ambientField = app.commercial === undefined ? 'gone' : 'present';
    out.quotes = app.database.raw.prepare('SELECT COUNT(*) AS n FROM quotes').get().n;
    out.offers = app.database.raw.prepare('SELECT COUNT(*) AS n FROM offers').get().n;
    out.versions = app.database.raw.prepare('SELECT COUNT(*) AS n FROM quote_versions').get().n;
    out.quoteRowReadable = app.modules.get('quote').service.get(quoteId).status;
  `);
  assert.equal(absent.syncCatalog, 'undefined', 'app.syncCatalog is absent — the route answers its honest 404');
  assert.equal(absent.coreStillWorks, true, 'core CRM still works with no Commercial composed');
  assert.equal(absent.action.ok, false, 'the quote action is not silently available');
  assert.equal(absent.action.status, 404, 'and its absence is a 404, not a crash');
  assert.equal(absent.createQuote.status, 404, 'create-quote too');
  assert.equal(absent.schemaHasDomain, false, 'no schema contribution');
  assert.equal(absent.ambientField, 'gone', 'and no ambient field either — gone for good, not defaulted');
  // The ROWS stay. Removing a package is not a data migration.
  assert.equal(absent.quotes, composed.quotes, 'the quote written while composed is still on disk');
  assert.equal(absent.offers, composed.offers, 'and so is the whole catalog');
  assert.equal(absent.versions, 1, 'and the immutable version evidence');
  assert.equal(absent.quoteRowReadable, 'approved', 'readable through the record modules the project still applies');

  // ---- reattached: surface and data both come back
  compose(root, true);
  const back = phase(root, dbPath, `
    out.quote = app.modules.get('quote').service.get(${JSON.stringify(composed.quoteId)}).status;
    const versions = app.modules.get('quote-version').service.listWhere({ quoteId: ${JSON.stringify(composed.quoteId)} });
    out.historicalNet = versions[0].oneTimeNetCents;
    const sync = await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    out.resyncWrites = sync.counts.productsCreated + sync.counts.offersCreated + sync.counts.versionsCreated;
    out.schemaHasDomain = Boolean(app.domains.metadata().commercial);
  `);
  assert.equal(back.quote, 'approved', 'the historical quote is readable again');
  assert.equal(back.historicalNet, composed.oneTimeNet, 'and its evidence is byte-for-byte the version that was signed off');
  assert.equal(back.resyncWrites, 0, 'reattaching re-syncs idempotently against the surviving rows');
  assert.equal(back.schemaHasDomain, true, 'the schema contribution is back');
});

test('the kernel carries no Commercial source, and the one recorded residue is an attachment, not a bridge', () => {
  const kernel = join(repoRoot, 'packages/core/src');
  assert.deepEqual(readdirSync(kernel).filter((name) => /commercial|catalog/i.test(name)), [],
    'packages/core must contain no Commercial file');

  assert.doesNotMatch(readFileSync(join(kernel, 'action-runtime.js'), 'utf8'), /commercial/i,
    'the action runtime must not inject an ambient domain key, not even a defaulted one');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'apps/server/src/http-server.js'), 'utf8'), /app\.commercial/,
    'the HTTP server must not publish an ambient block for it');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'packages/cli/src/app-inspect.js'), 'utf8'), /commercial/i,
    'AX1 must discover the package rather than keep a fixed slot');

  // The B7 residue is GONE (ADR-032): the factory no longer looks the package
  // up by name at all. `app.syncCatalog` is the package's own declared
  // operation alias, attached generically by the composition — no static
  // import, no kernel-side construction, and no domain name in create-app.
  const factory = readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8');
  assert.doesNotMatch(factory, /from '[^']*commercial[^']*'/, 'no static import of any Commercial file');
  assert.doesNotMatch(factory, /CommercialRegistries|createCatalogSync\(/, 'no kernel-side construction of the domain');
  assert.doesNotMatch(factory, /commercial/i, 'no domain-named lookup survives the operations seam');
  assert.match(factory, /composePackageOperations/, 'operations are attached generically through the ADR-032 seam');
});
