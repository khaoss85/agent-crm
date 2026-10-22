// @ts-check

/**
 * Backoffice BO-F2-07 (backlog:029a1418a53e): product import with drafts.
 * "Importa con l'AI" from a PDF/Excel/photo — or typed by hand — creates
 * DRAFT product-import-row records the operator confirms or rejects one by
 * one; the import never writes a product itself.
 *
 * The four acceptance criteria: 1-2 and the missing-handover half of 3 run
 * against the real full-app composition; the AI paths with a handover run
 * against the commercial domain composed with the real llm package
 * (domainHarness, same seam-carrying module services the llm and channel
 * harnesses use) — the app composition's codegen module services carry no
 * llm spend/audit seams yet, so an AI call there cannot run (framework
 * follow-up, named in the PR body).
 * 1. the import persists drafts, writing no product record (manual start
 *    leaves the product table empty);
 * 2. confirmation is row by row through the manual catalog (one product
 *    per confirmed row, replay on double confirm, typed refusals after
 *    the decision, the import closes with the last decision);
 * 3. without an LLM key the AI import stays off with a named code (dry-run
 *    and missing-handover both refuse) while the manual import works;
 * 4. with a key the AI extraction lands drafts the operator confirms.
 *
 * The oracle for the product write is the manual catalog itself
 * (`listCatalogProducts`): the test never re-states the write rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createCommercialDomain } from '../packages/commercial/src/index.js';
import {
  FIXTURE_LLM_SECRET,
  createFixtureLlmAdapter,
  createLlmPackage,
} from '../packages/llm/src/index.js';
import {
  MAX_DOCUMENT_CHARS,
  PRODUCT_IMPORT_AI_UNAVAILABLE,
  PRODUCT_IMPORT_DOCUMENT_TOO_LARGE,
  extractProductDrafts,
  normalizeManualRows,
} from '../packages/commercial/src/product-import.js';
import { COMMERCIAL_MANIFESTS } from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const ACTOR = { type: 'user', id: 'product-import-test' };

const IMPORT_MANIFESTS = ['product-import.module.json', 'product-import-row.module.json'];

const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error && typeof error === 'object' ? error.code : null;
  }
  return null;
};

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

function applyManifests(root, dir, list) {
  for (const manifest of list) {
    const result = cli(root, ['module', 'create', join(root, dir, manifest), '--apply']);
    assert.equal(result.status, 0, `apply ${manifest}: ${result.stderr}`);
  }
}

const validAnswer = (items) => ({ text: JSON.stringify(items) });

test('extract: valid items land, bad items refuse with typed codes, never invented rows', async () => {
  const complete = async () => validAnswer([
    { sku: 'YOGA-10', name: 'Pacchetto 10 lezioni', description: 'Dieci ingressi.', category: 'pacchetti', amountCents: 9900 },
    { sku: 'PROVA', name: 'Lezione di prova', amountCents: 1000 },
    { sku: '', name: 'Senza codice', amountCents: 100 },
    { sku: 'NOPRICE', name: 'Senza prezzo', amountCents: -5 },
    { sku: 'NONAME', name: '   ', amountCents: 100 },
    { sku: 'YOGA-10', name: 'Duplicato stesso documento', amountCents: 9900 },
  ]);
  const result = await extractProductDrafts({ documentText: 'Listino: YOGA-10 ...', complete, maxDrafts: 10 });
  assert.equal(result.status, 'ok');
  assert.equal(result.drafts.length, 3, 'the three valid rows land, including the repeated sku (confirmation dedupes nothing)');
  assert.equal(result.drafts[0].sku, 'YOGA-10');
  assert.equal(result.drafts[0].amountCents, 9900);
  assert.equal(result.drafts[1].description, null, 'absent optionals stay null, never empty strings');
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['PRODUCT_IMPORT_SKU_MISSING', 'PRODUCT_IMPORT_AMOUNT_INVALID', 'PRODUCT_IMPORT_NAME_MISSING'],
    'each bad item refuses with its typed code',
  );
  const overLimit = await extractProductDrafts({
    documentText: 'Listino: A B C',
    complete: async () => validAnswer([
      { sku: 'A', name: 'Uno', amountCents: 100 },
      { sku: 'B', name: 'Due', amountCents: 200 },
      { sku: 'C', name: 'Tre', amountCents: 300 },
    ]),
    maxDrafts: 2,
  });
  assert.equal(overLimit.drafts.length, 2, 'the cap holds');
  assert.deepEqual(overLimit.refused.map(({ code }) => code), ['PRODUCT_IMPORT_OVER_LIMIT']);
});

test('extract: without a key the AI stays off — never fixture-hallucinated drafts', async () => {
  for (const complete of [null, undefined]) {
    const result = await extractProductDrafts({ documentText: 'Listino: YOGA-10 ...', complete });
    assert.equal(result.status, 'llm-disabled', 'no model, no drafts');
    assert.deepEqual(result.drafts, []);
  }
  const disabled = new Error('AI is not enabled for this space: no text was sent anywhere');
  disabled.code = 'LLM_SPACE_DISABLED';
  const off = await extractProductDrafts({
    documentText: 'Listino: YOGA-10 ...',
    complete: async () => { throw disabled; },
  });
  assert.equal(off.status, 'llm-disabled', 'a disabled space maps to the off state');
  assert.deepEqual(off.drafts, []);
  const dry = await extractProductDrafts({
    documentText: 'Listino: YOGA-10 ...',
    complete: async () => ({ text: JSON.stringify([{ sku: 'YOGA-10', name: 'Pacchetto', amountCents: 9900 }]), dryRun: true }),
  });
  assert.equal(dry.status, 'llm-disabled', 'a dry-run without a key never becomes drafts');
  assert.deepEqual(dry.drafts, [], 'the fixture answer is not parsed');
});

test('extract: unusable model answers refuse instead of inventing rows', async () => {
  assert.equal(
    await codeOf(() => extractProductDrafts({ documentText: 'Listino', complete: async () => ({ text: 'ecco i prodotti...' }) })),
    'PRODUCT_IMPORT_AI_DRAFT_UNUSABLE',
    'non-JSON refuses',
  );
  assert.equal(
    await codeOf(() => extractProductDrafts({ documentText: '   ', complete: async () => validAnswer([]) })),
    'VALIDATION_ERROR',
    'an empty document refuses before any model call',
  );
});

test('manual rows validate through the same rule as the AI path', () => {
  const rows = normalizeManualRows([
    { sku: 'YOGA-10', name: ' Pacchetto 10 lezioni ', amountCents: 9900 },
    { sku: 'FREE', name: 'Lezione di prova', amountCents: 0 },
  ]);
  assert.equal(rows[0].name, 'Pacchetto 10 lezioni', 'text trims');
  assert.equal(rows[1].amountCents, 0, 'a free item is a valid draft');
  assert.throws(() => normalizeManualRows([]), /non-empty array/);
  assert.throws(() => normalizeManualRows([{ sku: 'X', name: 'Y' }]), /amountCents/);
});

/**
 * Build an isolated project with the commercial package composed (manual
 * only): the full backoffice path for the manual import — drafts persist,
 * confirmation writes through the manual catalog, the import itself never
 * writes a product.
 */
function importProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-product-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyManifests(root, 'packages/commercial/modules', [...COMMERCIAL_MANIFESTS, ...IMPORT_MANIFESTS]);
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders: [] }),',
    '];',
    '',
  ].join('\n'));
  return root;
}

function loadManifest(pkg, file) {
  return JSON.parse(readFileSync(join(here, '..', 'packages', pkg, 'modules', file), 'utf8'));
}

const DOMAIN_MODULE_FILES = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  ...IMPORT_MANIFESTS,
];
const DOMAIN_LLM_FILES = ['llm-usage-day.module.json', 'llm-call-audit.module.json'];

/** The real llm package over the fixture adapter: `key` wires the test secret. */
function harnessLlm({ key }) {
  const fixture = createFixtureLlmAdapter();
  if (key) {
    fixture.api.answer(JSON.stringify([
      { sku: 'AI-1', name: 'Prodotto dal documento', description: 'Letto dal PDF.', category: 'corsi', amountCents: 4900 },
      { sku: 'AI-2', name: 'Secondo prodotto', amountCents: 1900 },
    ]));
  }
  return createLlmPackage({
    adapters: [fixture.definition],
    spaces: { prova: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
    ...(key
      ? { secretRef: 'secret://prova/llm', resolveSecret: async () => FIXTURE_LLM_SECRET }
      : {}),
  });
}

/**
 * Domain harness for the AI paths: the commercial domain composed with the
 * real llm package over seam-carrying module services
 * (createRecordModuleFromManifest, like the llm and channel harnesses).
 * The full-app composition stays manual-only: its codegen module services
 * carry no llm spend/audit seams, so an AI call there cannot run yet
 * (framework follow-up, named in the PR) — the AI contract is proven here,
 * through the real llm operations and the sanctioned fixture adapter.
 */
function domainHarness(t, llm) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close?.());
  const manifests = [
    ...DOMAIN_MODULE_FILES.map((file) => loadManifest('commercial', file)),
    ...DOMAIN_LLM_FILES.map((file) => loadManifest('llm', file)),
  ];
  for (const manifest of manifests) {
    for (const { sql } of recordModuleMigrations([{ name: manifest.name, manifest }])) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const manifest of manifests) {
    const built = createRecordModuleFromManifest(manifest, { database, audit, events, references: {} });
    modules.set(manifest.name, { service: built.service });
  }
  const domain = createCommercialDomain({ catalogProviders: [], llm });
  const byName = Object.fromEntries(domain.operations.map((entry) => [entry.name, entry]));
  return { byName, runtime: { database, modules, events }, modules };
}

const callOp = (harness, name, input, actor) => harness.byName[name].create(harness.runtime)(input, actor);

async function bootApp(t, root) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  return app;
}

const MANUAL_ROWS = [
  { sku: 'YOGA-10', name: 'Pacchetto 10 lezioni', description: 'Dieci ingressi.', category: 'pacchetti', amountCents: 9900 },
  { sku: 'PROVA', name: 'Lezione di prova', amountCents: 1000 },
];

test('manual import stores drafts and writes no product until a row is confirmed', async (t) => {
  const app = await bootApp(t, importProject(t));
  const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS, currency: 'EUR' }, ACTOR);
  assert.equal(started.import.sourceKind, 'manual');
  assert.equal(started.import.status, 'open');
  assert.equal(started.drafts.length, 2, 'both rows persist as drafts');
  assert.ok(started.drafts.every((row) => row.status === 'pending'), 'drafts wait for confirmation');
  assert.deepEqual(started.refused, []);
  const table = await app.listCatalogProducts({});
  assert.equal(table.products.length, 0, 'the import writes no product itself');
  const read = await app.readProductImport({ importId: started.import.id });
  assert.deepEqual(read.counts, { pending: 2, confirmed: 0, rejected: 0 });
  assert.equal(read.rows[0].rowIndex, 0, 'rows read back in order');
});

test('confirm writes one product per row through the manual catalog, row by row', async (t) => {
  const app = await bootApp(t, importProject(t));
  const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS, currency: 'EUR' }, ACTOR);
  const [first, second] = started.drafts;
  const confirmed = await app.confirmProductImportRow({ importId: started.import.id, rowId: first.id }, ACTOR);
  assert.equal(confirmed.row.status, 'confirmed');
  assert.ok(confirmed.product.id, 'the confirmed row names its product');
  assert.equal(confirmed.replay, false);
  assert.equal(confirmed.import.status, 'open', 'one pending row keeps the import open');
  const table = await app.listCatalogProducts({});
  assert.equal(table.products.length, 1, 'exactly one product for one confirmation');
  assert.equal(table.products[0].sku, 'YOGA-10');
  assert.equal(table.products[0].offers[0].components[0].flatAmountCents, 9900, 'the price travels from the draft');
  const again = await app.confirmProductImportRow({ importId: started.import.id, rowId: first.id }, ACTOR);
  assert.equal(again.replay, true, 'confirming twice replays the first product');
  assert.deepEqual(again.product, confirmed.product, 'the replay carries the full product, never an id stub');
  assert.equal((await app.listCatalogProducts({})).products.length, 1, 'no duplicate product');
  const rejected = await app.rejectProductImportRow({ importId: started.import.id, rowId: second.id }, ACTOR);
  assert.equal(rejected.row.status, 'rejected');
  assert.equal(rejected.import.status, 'closed', 'the last decision closes the import');
  assert.equal((await app.listCatalogProducts({})).products.length, 1, 'a rejection writes nothing');
  const read = await app.readProductImport({ importId: started.import.id });
  assert.deepEqual(read.counts, { pending: 0, confirmed: 1, rejected: 1 });
});

test('decided rows and closed imports refuse with typed codes', async (t) => {
  const app = await bootApp(t, importProject(t));
  const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR' }, ACTOR);
  const [only] = started.drafts;
  await app.rejectProductImportRow({ importId: started.import.id, rowId: only.id }, ACTOR);
  assert.equal(
    await codeOf(() => app.confirmProductImportRow({ importId: started.import.id, rowId: only.id }, ACTOR)),
    'PRODUCT_IMPORT_ROW_DECIDED',
    'a rejected row never confirms',
  );
  assert.equal(
    await codeOf(() => app.confirmProductImportRow({ importId: started.import.id, rowId: 'row-that-does-not-exist' }, ACTOR)),
    'NOT_FOUND',
    'an unknown row is not found, never confirmed',
  );
  assert.equal(
    await codeOf(() => app.startProductImport({ source: 'manual', rows: [], currency: 'EUR' }, ACTOR)),
    'VALIDATION_ERROR',
    'an import with no valid draft refuses instead of storing an empty run',
  );
});

test('without an llm handover the AI import stays off while the manual one works', async (t) => {
  const app = await bootApp(t, importProject(t));
  assert.equal(
    await codeOf(() => app.startProductImport({
      source: 'ai', documentText: 'Listino: YOGA-10 ...', documentRef: 'listino.pdf', currency: 'EUR', spaceId: 'prova',
    }, ACTOR)),
    PRODUCT_IMPORT_AI_UNAVAILABLE,
    'the AI source refuses with its named code',
  );
  assert.equal((await app.modules.get('product-import').service.listWhere({})).length, 0, 'the refused AI import stores nothing');
  const manual = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR' }, ACTOR);
  assert.equal(manual.drafts.length, 1, 'the manual path keeps working');
});

test('with a key the AI extraction lands drafts the operator confirms', async (t) => {
  const harness = domainHarness(t, harnessLlm({ key: true }));
  const started = await callOp(harness, 'start-product-import', {
    source: 'ai', documentText: 'Listino palestra: AI-1 ...', documentRef: 'listino.pdf', currency: 'EUR', spaceId: 'prova',
  }, ACTOR);
  assert.equal(started.import.sourceKind, 'ai');
  assert.equal(started.import.documentRef, 'listino.pdf', 'the opaque reference travels, never the provider text');
  assert.equal(started.drafts.length, 2, 'the extracted rows land as drafts');
  assert.equal(started.drafts[0].sku, 'AI-1');
  assert.equal((await callOp(harness, 'list-catalog-products', {}, ACTOR)).products.length, 0, 'the AI import writes no product itself');
  const confirmed = await callOp(harness, 'confirm-product-import-row', { importId: started.import.id, rowId: started.drafts[0].id }, ACTOR);
  assert.equal(confirmed.row.status, 'confirmed');
  assert.equal((await callOp(harness, 'list-catalog-products', {}, ACTOR)).products[0].sku, 'AI-1');
});

test('with the handover but no key the AI import stays off: the dry-run never becomes drafts', async (t) => {
  const harness = domainHarness(t, harnessLlm({ key: false }));
  assert.equal(
    await codeOf(() => callOp(harness, 'start-product-import', {
      source: 'ai', documentText: 'Listino: YOGA-10 ...', documentRef: 'listino.pdf', currency: 'EUR', spaceId: 'prova',
    }, ACTOR)),
    PRODUCT_IMPORT_AI_UNAVAILABLE,
    'the dry-run without a key refuses with the AI-off code',
  );
  assert.equal((await harness.modules.get('product-import').service.listWhere({})).length, 0, 'the dry-run stores nothing');
});

test('oversize documents refuse instead of silently dropping their tail', async () => {
  const big = `Listino: ${'YOGA-10 '.repeat(9000)}`;
  assert.ok(big.length > MAX_DOCUMENT_CHARS, 'the fixture really exceeds the bound');
  assert.equal(
    await codeOf(() => extractProductDrafts({ documentText: big, complete: async () => validAnswer([]) })),
    PRODUCT_IMPORT_DOCUMENT_TOO_LARGE,
    'the oversize document refuses with its named code',
  );
});

test('an oversize AI import stores nothing', async (t) => {
  const app = await bootApp(t, importProject(t));
  const big = `Listino: ${'YOGA-10 '.repeat(9000)}`;
  assert.equal(
    await codeOf(() => app.startProductImport({
      source: 'ai', documentText: big, documentRef: 'listino.pdf', currency: 'EUR', spaceId: 'prova',
    }, ACTOR)),
    PRODUCT_IMPORT_DOCUMENT_TOO_LARGE,
    'the oversize import refuses before anything is stored',
  );
  assert.equal((await app.modules.get('product-import').service.listWhere({})).length, 0, 'the refused import stores nothing');
});

test('the AI source requires a space slug at the commercial boundary', async (t) => {
  const app = await bootApp(t, importProject(t));
  const base = { source: 'ai', documentText: 'Listino: YOGA-10 ...', documentRef: 'listino.pdf', currency: 'EUR' };
  for (const spaceId of [undefined, '', 'Prova', 'not a slug!', 'x'.repeat(64)]) {
    const input = spaceId === undefined ? { ...base } : { ...base, spaceId };
    let field = null;
    let code = null;
    try {
      await app.startProductImport(input, ACTOR);
    } catch (error) {
      code = error && typeof error === 'object' ? error.code : null;
      const details = error && typeof error === 'object' ? error.details : null;
      field = details && typeof details === 'object' ? details.field : null;
    }
    assert.equal(code, 'VALIDATION_ERROR', `spaceId ${JSON.stringify(spaceId)} refuses`);
    assert.equal(field, 'spaceId', `spaceId ${JSON.stringify(spaceId)} names the field`);
  }
  assert.equal((await app.modules.get('product-import').service.listWhere({})).length, 0, 'the refused AI imports store nothing');
});

test('concurrent confirms write exactly one product', async (t) => {
  const app = await bootApp(t, importProject(t));
  const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR' }, ACTOR);
  const [only] = started.drafts;
  const args = { importId: started.import.id, rowId: only.id };
  // The per-row slot serializes the two confirms on one connection: the
  // first wins, the second replays it. Across connections the conditional
  // claim below refuses the loser with PRODUCT_IMPORT_ROW_DECIDED instead
  // of writing a second product.
  const outcomes = await Promise.all([
    app.confirmProductImportRow(args, ACTOR),
    app.confirmProductImportRow(args, ACTOR),
  ]);
  const fresh = outcomes.filter((result) => result.replay === false);
  const replays = outcomes.filter((result) => result.replay === true);
  assert.equal(fresh.length, 1, 'one confirm writes the product');
  assert.equal(replays.length, 1, 'the racing confirm replays it');
  assert.equal(replays[0].product.id, fresh[0].product.id, 'same product, no duplicate');
  assert.equal((await app.listCatalogProducts({})).products.length, 1, 'exactly one product for one row');
});

test('a confirm racing a reject decides the row exactly once', async (t) => {
  for (const first of ['confirm', 'reject']) {
    const app = await bootApp(t, importProject(t));
    const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR' }, ACTOR);
    const [only] = started.drafts;
    const args = { importId: started.import.id, rowId: only.id };
    const run = (kind) => (kind === 'confirm'
      ? app.confirmProductImportRow(args, ACTOR)
      : app.rejectProductImportRow(args, ACTOR));
    const second = first === 'confirm' ? 'reject' : 'confirm';
    const settled = await Promise.allSettled([run(first), run(second)]);
    assert.equal(settled[0].status, 'fulfilled', `the first decision (${first}) wins`);
    assert.equal(settled[1].status, 'rejected', `the racing ${second} loses`);
    assert.equal(
      settled[1].reason?.code, 'PRODUCT_IMPORT_ROW_DECIDED',
      `the racing ${second} refuses with the decided code, never overwriting the winner`,
    );
    const expectedProducts = first === 'confirm' ? 1 : 0;
    assert.equal(
      (await app.listCatalogProducts({})).products.length, expectedProducts,
      `the loser writes nothing: ${expectedProducts} product(s) when ${first} wins`,
    );
    const read = await app.readProductImport({ importId: started.import.id });
    assert.deepEqual(
      read.counts,
      first === 'confirm' ? { pending: 0, confirmed: 1, rejected: 0 } : { pending: 0, confirmed: 0, rejected: 1 },
      `the row lands decided exactly once when ${first} wins`,
    );
  }
});

test('once decided, every second decision refuses: the full decision table', async (t) => {
  const cases = [
    { first: 'confirm', second: 'confirm', outcome: 'replay' },
    { first: 'confirm', second: 'reject', outcome: 'PRODUCT_IMPORT_ROW_DECIDED' },
    { first: 'reject', second: 'confirm', outcome: 'PRODUCT_IMPORT_ROW_DECIDED' },
    { first: 'reject', second: 'reject', outcome: 'PRODUCT_IMPORT_ROW_DECIDED' },
  ];
  for (const { first, second, outcome } of cases) {
    const app = await bootApp(t, importProject(t));
    const started = await app.startProductImport({ source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR' }, ACTOR);
    const [only] = started.drafts;
    const args = { importId: started.import.id, rowId: only.id };
    const deciding = first === 'confirm'
      ? await app.confirmProductImportRow(args, ACTOR)
      : await app.rejectProductImportRow(args, ACTOR);
    assert.equal(deciding.row.status, first === 'confirm' ? 'confirmed' : 'rejected');
    if (outcome === 'replay') {
      const again = await app.confirmProductImportRow(args, ACTOR);
      assert.equal(again.replay, true, 'confirm after confirm replays');
      assert.deepEqual(again.product, deciding.product, 'the replay matches the first product in full');
    } else {
      const code = second === 'confirm'
        ? await codeOf(() => app.confirmProductImportRow(args, ACTOR))
        : await codeOf(() => app.rejectProductImportRow(args, ACTOR));
      assert.equal(code, outcome, `${first} then ${second} refuses`);
    }
    assert.equal(
      (await app.listCatalogProducts({})).products.length, first === 'confirm' ? 1 : 0,
      `${first} then ${second}: exactly the winner's products exist`,
    );
  }
});

test('a refused confirm writes nothing and leaves the row pending', async (t) => {
  const app = await bootApp(t, importProject(t));
  const other = await app.createManualProduct({
    sku: 'USD-1', name: 'Prodotto in dollari', currency: 'USD',
    components: [{ key: 'price', label: 'Prezzo', chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100 }],
  }, ACTOR);
  const started = await app.startProductImport({
    source: 'manual', rows: MANUAL_ROWS.slice(0, 1), currency: 'EUR', priceBookId: other.priceBook.id,
  }, ACTOR);
  const [only] = started.drafts;
  assert.equal(
    await codeOf(() => app.confirmProductImportRow({ importId: started.import.id, rowId: only.id }, ACTOR)),
    'CURRENCY_MISMATCH',
    'the product write fails inside the confirm transaction',
  );
  assert.equal((await app.listCatalogProducts({})).products.length, 1, 'no orphan product: only the dollar one exists');
  const read = await app.readProductImport({ importId: started.import.id });
  assert.deepEqual(read.counts, { pending: 1, confirmed: 0, rejected: 0 }, 'the row stays pending for a retry');
});
