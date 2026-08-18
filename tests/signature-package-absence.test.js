import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Signature & Order is now optional, and "optional" is paid for rather than
 * asserted: remove the composition entry and look at what is left — including
 * the rows, because a customer who removes the package has not asked anybody
 * to delete their signed evidence or their Orders.
 *
 * **Each phase runs in its own process** — a composition change is a restart,
 * and an in-process re-boot would silently reuse the cached composition module.
 */

const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
];
const SIGNATURE_MANIFESTS = [
  'signature-envelope.module.json', 'signature-signer.module.json',
  'signature-event.module.json', 'signed-artifact.module.json',
  'order.module.json', 'order-line.module.json', 'order-component.module.json',
  'order-tier.module.json', 'order-total.module.json',
];

const COMPOSITION = 'packages/domains/generated/index.js';
const STARTER = '../../../examples/starters/b2b-lead-qualification';

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function compose(root, withSignature) {
  writeFileSync(join(root, COMPOSITION), [
    '// @ts-check',
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    `import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '${STARTER}/commercial.js';`,
    ...(withSignature ? [
      "import { createSignatureDomain } from '../../signature/src/index.js';",
      `import { fixtureSignatureProvider } from '${STARTER}/signature.js';`,
    ] : []),
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders: [fixtureSaasCatalogProvider], discountPolicies: [standardSalesDiscountV1] }),',
    ...(withSignature ? ['  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),'] : []),
    '];',
    '',
  ].join('\n'));
}

/** Run one phase in a fresh process and return whatever it reported. */
function phase(root, dbPath, body) {
  const script = join(root, `sig-phase-${Math.abs(hash(body))}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    "import { pathToFileURL } from 'node:url';",
    "import { join } from 'node:path';",
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

function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-signature-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of COMMERCIAL_MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply']).status, 0, manifest);
  }
  for (const manifest of SIGNATURE_MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/signature/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  return root;
}

test('the signature domain is genuinely optional: composed, absent, reattached — with the rows intact', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'absence.sqlite');

  // ---- composed: an approved quote signs and completes into an Order
  compose(root, true);
  const composed = phase(root, dbPath, `
    const { signatureFixture } = await import(pathToFileURL(join(${JSON.stringify(root)}, 'examples/starters/b2b-lead-qualification/signature.js')).href);
    signatureFixture.reset();
    await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    const company = await app.services.companies.create({ name: 'Absence Co' }, { actor });
    const opportunity = await app.services.opportunities.create({
      companyId: company.id, name: 'Absence deal', type: 'new_business',
      valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'absence',
    }, { actor });
    const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
    const created = await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
      input: { priceBookId: book.id }, actor });
    out.quoteId = created.result.quote.id;
    const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
    await app.runAction({ module: 'quote', action: 'add-line', recordId: out.quoteId,
      input: { offerId: offer.id, quantity: 30 }, actor });
    const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: out.quoteId,
      input: { policy: 'standard-sales-discount', version: 1 }, actor });
    out.versionId = submitted.result.version.id;
    await app.runAction({ module: 'quote', action: 'request-signature', recordId: out.quoteId,
      input: { quoteVersionId: out.versionId, provider: 'fixture-signature', providerVersion: 1,
        signers: [{ name: 'Maria Bianchi', email: 'absence@example.com', role: 'customer', order: 1 }] }, actor });
    const envelope = app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: out.versionId })[0];
    signatureFixture.markCompleted(envelope.idempotencyKey);
    const event = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_absence' });
    const ingested = await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });
    out.applied = ingested.applied === true;
    out.envelopeId = envelope.id;
    out.schemaHasDomain = Boolean(app.domains.metadata().signature);
    out.operationsAttached = typeof app.ingestSignatureEvent === 'function' && typeof app.reconcileSignature === 'function';
    out.orderNet = app.modules.get('order').service.listWhere({ quoteVersionId: out.versionId })[0].oneTimeNetCents;
    out.envelopes = app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_envelopes').get().n;
    out.orders = app.database.raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    out.events = app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_events').get().n;
  `);
  assert.equal(composed.applied, true, 'the composed domain completes a verified signature');
  assert.equal(composed.schemaHasDomain, true, 'and publishes its schema contribution');
  assert.equal(composed.orders, 1);

  // ---- absent: one composition line removed, nothing else
  compose(root, false);
  const absent = phase(root, dbPath, `
    out.ingest = typeof app.ingestSignatureEvent;
    out.reconcile = typeof app.reconcileSignature;
    out.syncCatalogStillThere = typeof app.syncCatalog;
    const made = await app.services.companies.create({ name: 'Still works' }, { actor });
    out.coreStillWorks = Boolean(made.id);
    out.requestAction = await app.runAction({ module: 'quote', action: 'request-signature', recordId: ${JSON.stringify('placeholder')},
      input: {}, actor }).then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status }));
    out.schemaHasDomain = Boolean(app.domains.metadata().signature);
    out.envelopes = app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_envelopes').get().n;
    out.orders = app.database.raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    out.events = app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_events').get().n;
    out.orderRowReadable = app.modules.get('order').service.list({ limit: 5 })[0].status;
  `);
  assert.equal(absent.ingest, 'undefined', 'app.ingestSignatureEvent is absent — the webhook route answers its honest 404');
  assert.equal(absent.reconcile, 'undefined', 'app.reconcileSignature too');
  assert.equal(absent.syncCatalogStillThere, 'function', 'the commercial package keeps its own operation — detach removed one domain, not the seam');
  assert.equal(absent.coreStillWorks, true);
  assert.equal(absent.requestAction.ok, false, 'the action is not silently available');
  assert.equal(absent.requestAction.status, 404, 'and its absence is a 404, not a crash');
  assert.equal(absent.schemaHasDomain, false, 'no schema contribution');
  // The ROWS stay. Removing a package is not a data migration.
  assert.equal(absent.envelopes, composed.envelopes, 'the envelope written while composed is still on disk');
  assert.equal(absent.orders, composed.orders, 'and the immutable Order');
  assert.equal(absent.events, composed.events, 'and the verified event inbox');
  assert.equal(absent.orderRowReadable, 'accepted', 'readable through the record modules the project still applies');

  // ---- absent, over HTTP: the three surfaces answer honest 404s
  compose(root, false);
  const http = phase(root, dbPath, `
    const { createHttpServer } = await import(pathToFileURL(join(${JSON.stringify(root)}, 'apps/server/src/index.js')).href);
    const server = createHttpServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (path, body, headers) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'absence', connection: 'close', ...headers },
      body,
    }).then((r) => r.status);
    out.webhook = await post('/api/signature/providers/fixture-signature/events', '{}', {});
    out.reconcile = await post('/api/signature/envelopes/anything/reconcile', '{}');
    const schema = await fetch(base + '/api/schema', { headers: { connection: 'close' } }).then((r) => r.json());
    out.ambient = schema.signature === undefined;
    out.domainsBlock = schema.domains?.signature === undefined;
    await new Promise((resolve) => server.close(resolve));
  `);
  assert.equal(http.webhook, 404, 'the webhook route answers 404 with the package absent');
  assert.equal(http.reconcile, 404, 'the reconcile route too');
  assert.equal(http.ambient, true, 'no ambient signature block');
  assert.equal(http.domainsBlock, true, 'and no domains contribution');

  // ---- reattached: surface and data both come back
  compose(root, true);
  const back = phase(root, dbPath, `
    out.envelope = app.modules.get('signature-envelope').service.get(${JSON.stringify(composed.envelopeId)}).status;
    out.orderNet = app.modules.get('order').service.listWhere({ quoteVersionId: ${JSON.stringify(composed.versionId)} })[0].oneTimeNetCents;
    const rec = await app.reconcileSignature({ envelopeId: ${JSON.stringify(composed.envelopeId)}, actor });
    out.reconcile = { applied: rec.applied, reason: rec.reason };
    out.schemaHasDomain = Boolean(app.domains.metadata().signature);
  `);
  assert.equal(back.envelope, 'completed', 'the historical envelope is readable again');
  assert.equal(back.orderNet, composed.orderNet, 'and the Order evidence is byte-for-byte what was signed');
  assert.deepEqual(back.reconcile, { applied: false, reason: 'terminal' }, 'reconciliation is a safe no-op on the surviving terminal envelope');
  assert.equal(back.schemaHasDomain, true, 'the schema contribution is back');
});

test('the kernel carries no Signature source, and both residues are retired by the operations seam', () => {
  const kernel = join(repoRoot, 'packages/core/src');
  assert.deepEqual(readdirSync(kernel).filter((name) => /signature/i.test(name)), [],
    'packages/core must contain no Signature file');
  assert.ok(readdirSync(kernel).includes('external-operation.js'),
    'the neutral external-operation runner STAYS in core — the recorded verdict, not an accident');

  assert.doesNotMatch(readFileSync(join(kernel, 'action-runtime.js'), 'utf8'), /signature/i,
    'the action runtime must not inject an ambient domain key, not even a defaulted one');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'apps/server/src/http-server.js'), 'utf8'), /app\.signature/,
    'the HTTP server must not publish an ambient block for it');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'packages/cli/src/app-inspect.js'), 'utf8'), /signature/i,
    'AX1 must discover the package rather than keep a fixed slot');

  // ADR-032: the factory names NO domain. Operations are composed and
  // attached generically; the webhook route stays kernel-owned but delegates
  // to the composed alias.
  const factory = readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8');
  assert.doesNotMatch(factory, /from '[^']*\/signature\/[^']*'/, 'no static import of any Signature file');
  assert.doesNotMatch(factory, /SignatureRegistries|createSignatureOperations|ingestSignatureEvent|reconcileSignature/,
    'no kernel-side construction or naming of the domain');
  assert.match(factory, /composePackageOperations/, 'operations attach generically through the ADR-032 seam');

  // The generic operation runtime knows no domain.
  const runtime = readFileSync(join(kernel, 'operation-runtime.js'), 'utf8');
  assert.doesNotMatch(runtime, /signature|commercial|catalog|quote|order|envelope/i,
    'the operation runtime carries zero domain vocabulary');
});
