import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * **The one file the Commercial extraction edits.**
 *
 * LA0-Commercial exists to prove that moving Commercial Operations out of the
 * kernel changes no externally observable behaviour. That proof is only worth
 * anything if the *same* cases and the *same* baseline run on both sides of
 * the move — so everything that knows where Commercial currently lives is
 * concentrated here, and nothing else in `tests/characterization/commercial-*`
 * mentions `packages/core/src` at all.
 *
 * After the extraction, `wireCommercial` writes a composition import instead
 * of an action-registry import and a fixed definition slot, and the source
 * specifiers below point into the package. Every case file, every assertion
 * and the checked-in baseline's asserted values stay identical. If they have
 * to change, the extraction changed behaviour, which is exactly the thing this
 * harness is here to refuse.
 *
 * **It moves nothing.** LA0-Commercial does not extract, does not split the
 * money module, does not replace `app.commercial` and adds no seam. It only
 * writes down what is true today.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The record modules Commercial Operations owns today. */
export const COMMERCIAL_MODULES = Object.freeze([
  'product.module.json',
  'product-version.module.json',
  'price-book.module.json',
  'offer.module.json',
  'price-component.module.json',
  'price-tier.module.json',
  'catalog-sync-run.module.json',
  'quote.module.json',
  'quote-line.module.json',
  'quote-version.module.json',
  'quote-version-line.module.json',
  'quote-version-component.module.json',
  'quote-version-total.module.json',
  'quote-approval.module.json',
]);

/** The fixed clock every case runs against: a characterization may not drift with the wall clock. */
export const FIXED_NOW = '2026-01-01T00:00:00.000Z';

/**
 * How Commercial Operations is attached to a project **today**: one
 * composition entry in `packages/domains/generated/index.js`, which is how
 * every optional domain package is attached. Before the extraction this was an
 * action-registry import plus the fixed project-owned
 * `packages/commercial/generated` slot; `ATTACHMENT` records which shape
 * produced a baseline so a comparison across the move is never silently
 * comparing two different things.
 */
export const ATTACHMENT = 'composed-domain-package';

/**
 * **Every path that knows where Commercial Operations lives today, in one
 * place.** After the move these specifiers point into the package,
 * `wireCommercial` writes a composition import, and nothing else in the
 * commercial characterization changes.
 */
export const COMMERCIAL_SOURCE = Object.freeze({
  money: '../../packages/commercial/src/money.js',
  registry: '../../packages/commercial/src/registry.js',
  actions: '../../packages/commercial/src/actions.js',
  catalogSync: '../../packages/commercial/src/catalog-sync.js',
  entry: '../../packages/commercial/src/index.js',
  /** Where the record manifests live, relative to a copied project root. */
  manifestsDir: 'packages/commercial/modules',
  /** Patterns for the architecture-evidence cases, kept in the seam. */
  greps: Object.freeze([
    'app.commercial',
    'commercial/src/registry.js', 'commercial/src/actions.js', 'commercial/src/money.js', 'commercial/src/catalog-sync.js',
    'commercial/generated',
  ]),
});

/**
 * **Where the published schema block lives.**
 *
 * The cases read this through the seam rather than by path — the exact lesson
 * the Intelligence extraction learned in its Stage 0: a hard-coded location
 * inside a contractual observation cannot tell an ownership *move* from a
 * genuine *loss* of the definitions. The location is the seam's business and
 * the contents are the contract. A block that is nowhere returns `undefined`,
 * the contractual observations go red, and losing the definitions stays loud.
 *
 * @param {any} schema the `/api/schema` document
 */
export function commercialSchemaBlock(schema) {
  return schema?.commercial ?? schema?.domains?.commercial;
}

/** Where the block was actually found, recorded as evidence rather than asserted. */
export function commercialSchemaLocation(schema) {
  if (schema?.commercial) return 'schema.commercial';
  if (schema?.domains?.commercial) return 'schema.domains.commercial';
  return null;
}

/** The pricing arithmetic, loaded from wherever it currently lives. */
export async function loadPricing() {
  return import(COMMERCIAL_SOURCE.money);
}

/** The registry helpers, loaded from wherever they currently live. */
export async function loadRegistry() {
  return import(COMMERCIAL_SOURCE.registry);
}

/**
 * Behaviour-bearing source: every file whose content decides what Commercial
 * Operations does, and therefore what this baseline observes. A change to any
 * of them stales the baseline and forces a deliberate, reviewed regeneration.
 */
export const BEHAVIOUR_BEARING_SOURCE = Object.freeze([
  'packages/commercial/src/index.js',
  'packages/commercial/src/actions.js',
  'packages/commercial/src/money.js',
  'packages/commercial/src/registry.js',
  'packages/commercial/src/catalog-sync.js',
  'packages/commercial/src/capability.js',
  // Signed commercial terms: digest-owned, deliberately NOT in
  // COMMERCIAL_MODULES - the baseline application's applied-manifest set is
  // part of the frozen shape, and a baseline project without the term
  // records proves exactly the pre-terms behaviour the asserted values pin.
  'packages/commercial/src/terms.js',
  'packages/commercial/modules/quote-term.module.json',
  'packages/commercial/modules/quote-version-term.module.json',
  'packages/core/src/money.js',
  'packages/core/src/definition-fingerprint.js',
  'packages/core/src/timeout.js',
  'packages/core/src/action-runtime.js',
  'packages/app/src/create-app.js',
  'apps/server/src/http-server.js',
  'packages/sdk/src/index.js',
  'apps/admin/public/admin-quotes.js',
  'examples/starters/b2b-lead-qualification/commercial.js',
  ...COMMERCIAL_MODULES.map((manifest) => `packages/commercial/modules/${manifest}`),
]);

/**
 * The guard that stops the list above rotting: enumerate the files a *future*
 * Commercial change would plausibly land in, so a new `commercial-*.js` in the
 * kernel or a package source file cannot silently fall outside digest
 * ownership.
 *
 * @param {string} rootDir
 */
export function unownedCommercialSource(rootDir) {
  const owned = new Set(BEHAVIOUR_BEARING_SOURCE);
  const found = [];
  for (const name of readdirSync(join(rootDir, 'packages/core/src'))) {
    if (/commercial|catalog/i.test(name)) found.push(`packages/core/src/${name}`);
  }
  const packageSrc = join(rootDir, 'packages/commercial/src');
  if (existsSync(packageSrc)) {
    for (const name of readdirSync(packageSrc)) {
      if (/\.(mjs|js)$/.test(name)) found.push(`packages/commercial/src/${name}`);
    }
  }
  const packageModules = join(rootDir, 'packages/commercial/modules');
  if (existsSync(packageModules)) {
    for (const name of readdirSync(packageModules)) {
      if (name.endsWith('.module.json')) found.push(`packages/commercial/modules/${name}`);
    }
  }
  return found.filter((path) => !owned.has(path)).sort();
}

/**
 * Auxiliary deterministic catalog providers, written as literal source into the
 * project's checked-in definition registry. The harness owns these strings: the
 * definitions are fingerprinted from exactly this source, so the fingerprints
 * frozen in the baseline stay stable for as long as these strings do — across
 * the extraction included.
 */
const AUX_PROVIDERS_SOURCE = `
/** LA0 auxiliary provider: USD book, an inactive book, and cross-book offers. */
export const la0AuxCatalogProvider = {
  name: 'la0-aux-catalog',
  version: 1,
  label: 'LA0 auxiliary catalog (deterministic)',
  config: { source: 'la0-aux' },
  async fetchCatalog(input) {
    const variant = typeof input?.variant === 'string' ? input.variant : 'base';
    if (variant === 'hostile') {
      return {
        priceBooks: [{ sourceKey: 'la0:pb:hostile', name: 'Hostile ' + String.fromCharCode(9) + '<b>Book</b>', currency: 'EUR', active: true }],
        products: [{
          sourceKey: 'la0:product:hostile',
          sku: 'HOSTILE', name: '<script>alert(1)</script> \${process.env.HOME} "quoted" \\u2028line',
          description: 'a'.repeat(500), category: 'x', active: true,
          __proto__polluted: true,
        }],
        offers: [{
          sourceKey: 'la0:offer:hostile', priceBookSourceKey: 'la0:pb:hostile', productSourceKey: 'la0:product:hostile',
          name: 'Hostile offer \\'; DROP TABLE offer; --', active: true,
          components: [{ sourceKey: 'hostile-flat', label: 'Flat with control ' + String.fromCharCode(1) + ' char', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100 }],
        }],
      };
    }
    if (variant === 'oversized') {
      return {
        priceBooks: [{ sourceKey: 'la0:pb:oversized', name: 'x'.repeat(201), currency: 'EUR', active: true }],
        products: [], offers: [],
      };
    }
    if (variant === 'big') {
      const products = [];
      for (let index = 0; index < 520; index += 1) {
        products.push({
          sourceKey: 'la0:product:bulk-' + String(index).padStart(3, '0'),
          sku: 'BULK-' + String(index).padStart(3, '0'),
          name: 'Bulk product ' + index,
          description: null, category: 'bulk', active: true,
        });
      }
      return { sourceRef: 'la0:big', priceBooks: [{ sourceKey: 'la0:pb:bulk', name: 'Bulk EUR', currency: 'EUR', active: true }], products, offers: [] };
    }
    // base: a USD book, an inactive EUR book, and a USD offer for
    // cross-price-book refusals.
    return {
      sourceRef: 'la0:base',
      priceBooks: [
        { sourceKey: 'la0:pb:usd', name: 'LA0 USD', currency: 'USD', active: true },
        { sourceKey: 'la0:pb:dormant', name: 'LA0 dormant', currency: 'EUR', active: false },
      ],
      products: [
        { sourceKey: 'la0:product:usd-widget', sku: 'USD-WIDGET', name: 'USD widget', description: 'Priced in USD.', category: 'aux', active: true },
      ],
      offers: [
        {
          sourceKey: 'la0:offer:usd-widget', priceBookSourceKey: 'la0:pb:usd', productSourceKey: 'la0:product:usd-widget',
          name: 'USD widget offer', active: true,
          components: [{ sourceKey: 'usd-flat', label: 'USD flat fee', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 12345 }],
        },
      ],
    };
  },
};

/** LA0 auxiliary provider: declared deactivateMissing, two payload generations. */
export const la0DeactivatingCatalogProvider = {
  name: 'la0-deactivating-catalog',
  version: 1,
  label: 'LA0 deactivating catalog (deterministic)',
  config: { source: 'la0-deactivating', deactivateMissing: true },
  async fetchCatalog(input) {
    const generation = input?.generation === 'second' ? 'second' : 'first';
    const products = [
      { sourceKey: 'la0:product:keeper', sku: 'KEEPER', name: 'Kept product', description: null, category: 'aux', active: true },
    ];
    if (generation === 'first') {
      products.push({ sourceKey: 'la0:product:goner', sku: 'GONER', name: 'Disappearing product', description: null, category: 'aux', active: true });
    }
    return { sourceRef: 'la0:deactivating:' + generation, priceBooks: [{ sourceKey: 'la0:pb:deactivating', name: 'Deactivating EUR', currency: 'EUR', active: true }], products, offers: [] };
  },
};
`;

/**
 * @param {string} root
 * Wire Commercial Operations the way a project attaches it **today**: the
 * framework quote actions registered through the project's action registry and
 * the declared definitions in the fixed `packages/commercial/generated` slot.
 */
export function wireCommercial(root) {
  const starter = '../../../examples/starters/b2b-lead-qualification';
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    '// The quote actions arrive with the commercial package composition below.',
    'export const generatedActions = [];',
    '',
  ].join('\n'));
  // One composition entry — the whole attachment. The eight actions arrive
  // with the package rather than being registered by the project, which is the
  // difference between a domain the project wires and a domain it composes.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    `import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '${starter}/commercial.js';`,
    AUX_PROVIDERS_SOURCE,
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider, la0AuxCatalogProvider, la0DeactivatingCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '];',
    '',
  ].join('\n'));
}

/** @param {string} root @param {string[]} args */
export function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * A throwaway project with Commercial Operations attached, built by the real
 * module factory and the real CLI — not by hand-written fixtures, because a
 * characterization of hand-written fixtures characterizes the fixtures.
 *
 * @param {import('node:test').TestContext} t
 * @param {{name?: string}} [options]
 */
export function characterizationProject(t, { name = 'accordo-la0-commercial-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const manifests = join(root, COMMERCIAL_SOURCE.manifestsDir);
  for (const manifest of COMMERCIAL_MODULES) {
    const applied = cli(root, ['module', 'create', join(manifests, manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  wireCommercial(root);
  return root;
}

/**
 * Boot the project the way a consumer does: a real application, a real HTTP
 * server and the real SDK. Characterizing through the public surface is the
 * point — an in-process call would prove the internals still work after a move
 * that changed what a consumer sees.
 *
 * @param {string} root @param {string} dbPath @param {Record<string, unknown>} [options]
 */
export async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, clock: () => FIXED_NOW, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AccordoClient({ baseUrl, actor: { type: 'user', id: 'la0-commercial' } });
  const agentClient = new AccordoClient({ baseUrl, actor: { type: 'agent', id: 'la0-agent' } });
  return {
    app,
    client,
    agentClient,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()),
  };
}
