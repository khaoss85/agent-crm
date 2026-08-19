import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The two capabilities Commercial Operations OFFERS — `commercial-quotes@1` and
 * `commercial-quote-binding@1` — are the whole reason another package can read a
 * quote's immutable evidence or declare the one bounded write onto it. The
 * Signature extraction is built to consume `commercial-quotes@1`, so the shape
 * that capability returns IS a contract another milestone depends on.
 *
 * `crm package test` exercises the capabilities a package *requires* (Commercial
 * requires none); it never opens the capabilities a package *offers*. So without
 * this test the offered read authority — every column a consumer copies without
 * interpreting — ships with no behavioural coverage at all. This test opens both
 * capabilities through the **real** package registry (declaration check,
 * provider-identity check, registry-proven consumer injection) and freezes the
 * evidence shape the Signature consumption inventory (§1.2) relies on.
 *
 * Each phase runs in a fresh process, as the absence test does, because a
 * composition change is a restart.
 */

const MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json',
];
const STARTER = '../../../examples/starters/b2b-lead-qualification';

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * Compose Commercial plus a tiny probe consumer package that DECLARES the two
 * requirements, so the capabilities are opened exactly as a real consumer opens
 * them — through `app.domains.capability`, not by calling `create()` directly.
 */
function compose(root) {
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    `import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '${STARTER}/commercial.js';`,
    "import { definePackage } from '../../core/index.js';",
    'const probeConsumer = definePackage({',
    "  packageContract: 1, name: 'capability-probe', version: 1, label: 'Capability probe',",
    "  description: 'A do-nothing consumer that declares the Commercial capabilities so a test can open them through the registry.',",
    '  resources: [], actions: [], policies: [], capabilities: [],',
    '  requires: [',
    "    { package: 'commercial', capability: 'commercial-quotes', version: 1 },",
    "    { package: 'commercial', capability: 'commercial-quote-binding', version: 1 },",
    '  ],',
    '});',
    'export const generatedDomains = [',
    '  createCommercialDomain({ catalogProviders: [fixtureSaasCatalogProvider], discountPolicies: [standardSalesDiscountV1] }),',
    '  probeConsumer,',
    '];',
    '',
  ].join('\n'));
}

function phase(root, dbPath, body) {
  const script = join(root, `capphase-${Math.abs(hash(body))}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    'const actor = { type: "user", id: "capprobe" };',
    'const out = {};',
    'try {',
    body,
    '} catch (error) { out.__error = { message: String(error.message), code: error.code ?? null }; } finally { app.close(); }',
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
  const root = mkdtempSync(join(tmpdir(), 'accordo-commercial-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  compose(root);
  return root;
}

test('commercial-quotes@1 returns the immutable evidence shape a consumer copies without interpreting', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'cap.sqlite');

  const built = phase(root, dbPath, `
    await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    const company = await app.services.companies.create({ name: 'Cap Co' }, { actor });
    const opp = await app.services.opportunities.create({
      companyId: company.id, name: 'Cap deal', type: 'new_business',
      valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'capprobe',
    }, { actor });
    const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
    const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opp.id, input: { priceBookId: book.id }, actor })).result.quote;
    for (const key of ['fixture:offer:enterprise', 'fixture:offer:api-monthly', 'fixture:offer:support-annual']) {
      const offer = app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
      if (offer) await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offer.id, quantity: 30, discountBps: 500 }, actor });
    }
    const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
    if (submitted.result.version.decision === 'approval_required') {
      await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor });
    }
    out.quoteId = quote.id;
    out.versionId = submitted.result.version.id;

    // Open the capability the way a consumer does: through the registry, with a
    // consumer that declared the requirement.
    const cap = app.domains.capability({ consumer: 'capability-probe', capability: 'commercial-quotes', version: 1, context: { modules: app.modules } });
    out.interface = Object.keys(cap).sort();

    const q = cap.quote(out.quoteId);
    out.lifecycle = { status: q.status, currentVersionIsSignable: q.currentVersionId === out.versionId };

    const v = cap.version(out.versionId);
    out.policyEvidence = {
      policy: v.policy, policyVersion: v.policyVersion,
      fingerprint64: typeof v.policyFingerprint === 'string' && /^[0-9a-f]{64}$/.test(v.policyFingerprint),
      policyDecision: v.policyDecision,
    };

    const lines = cap.versionLines(out.versionId);
    out.lines = lines.map((l) => ({
      hasCents: Number.isSafeInteger(l.netAmountCents) && Number.isSafeInteger(l.listAmountCents),
      hasOfferRevision: 'offerRevision' in l, hasSku: 'sku' in l, position: l.position,
    }));
    out.linesPositionOrdered = lines.every((l, i) => i === 0 || lines[i - 1].position <= l.position);

    const comps = cap.versionComponents(out.versionId);
    out.components = comps.map((c) => ({
      hasTiersJsonString: typeof c.tiersJson === 'string',
      hasTierBreakdownString: typeof c.tierBreakdownJson === 'string',
      pricingModel: c.pricingModel,
    }));
    // The tier encodings must be parseable JSON — the exact shape Signature copies.
    out.tiersParse = comps.every((c) => { try { JSON.parse(c.tiersJson); JSON.parse(c.tierBreakdownJson); return true; } catch { return false; } });

    const totals = cap.versionTotals(out.versionId);
    out.totals = totals.map((tt) => ({ kind: tt.kind, interval: tt.interval, hasNet: 'netAmountCents' in tt }));

    out.policies = cap.policies().map((p) => ({ name: p.name, version: p.version, fingerprint64: /^[0-9a-f]{64}$/.test(p.fingerprint) }));

    // Immutability: a returned row is frozen and mutating it neither succeeds
    // nor touches storage. Baseline against the capability's OWN read, since the
    // stored net (oneTimeNetCents) is the field a consumer relies on.
    const netBefore = v.oneTimeNetCents;
    out.hasNet = Number.isSafeInteger(netBefore);
    let mutationThrew = false;
    try { v.oneTimeNetCents = -1; } catch { mutationThrew = true; }
    out.frozen = { versionFrozen: Object.isFrozen(v), linesFrozen: Object.isFrozen(lines), mutationRejected: mutationThrew || v.oneTimeNetCents !== -1 };
    out.storageUnchanged = cap.version(out.versionId).oneTimeNetCents === netBefore;
  `);

  assert.equal(built.__error, undefined, `phase errored: ${JSON.stringify(built.__error)}`);
  assert.deepEqual(built.interface, ['capabilityContract', 'policies', 'quote', 'version', 'versionComponents', 'versionLines', 'versionTerm', 'versionTotals']);
  assert.equal(built.lifecycle.status, 'approved');
  assert.equal(built.lifecycle.currentVersionIsSignable, true, 'the capability names the one signable version');
  assert.equal(built.policyEvidence.policy, 'standard-sales-discount');
  assert.equal(built.policyEvidence.fingerprint64, true, 'the discount-policy fingerprint travels verbatim — 64 hex chars');
  assert.ok(built.policyEvidence.policyDecision, 'the version carries its policy decision');
  assert.equal(built.hasNet, true, 'the version carries its one-time net in integer cents');
  assert.ok(built.lines.length >= 1, 'a submitted version has at least one line (completeness)');
  assert.ok(built.lines.every((l) => l.hasCents && l.hasOfferRevision && l.hasSku), 'every line carries the cents/offer/sku columns Signature copies');
  assert.equal(built.linesPositionOrdered, true, 'lines are position-ordered');
  assert.ok(built.components.every((c) => c.hasTiersJsonString && c.hasTierBreakdownString), 'components carry the tiersJson / tierBreakdownJson encodings verbatim');
  assert.equal(built.tiersParse, true, 'the tier encodings are the parseable JSON strings a consumer copies without interpreting');
  assert.ok(built.totals.length >= 1, 'a submitted version has at least one grouped total (completeness)');
  assert.ok(built.policies.every((p) => p.fingerprint64), 'declared policy identities carry their fingerprints');
  assert.equal(built.frozen.versionFrozen, true, 'the returned version row is frozen');
  assert.equal(built.frozen.linesFrozen, true, 'the returned line array is frozen');
  assert.equal(built.frozen.mutationRejected, true, 'a consumer cannot mutate the evidence it is handed');
  assert.equal(built.storageUnchanged, true, 'and a mutation attempt never reached storage');
});

test('the capability registry refuses an undeclared consumer and proves the consumer identity itself', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'cap-guard.sqlite');

  const guard = phase(root, dbPath, `
    // A consumer that did NOT declare the requirement is refused, even though
    // the capability exists — the dependency graph is the truth, not a comment.
    out.undeclared = (() => {
      try { app.domains.capability({ consumer: 'commercial', capability: 'commercial-quotes', version: 1, context: { modules: app.modules } }); return 'opened'; }
      catch (error) { return error.code; }
    })();

    // commercial-quote-binding@1: exactly the three managed linkage fields, and
    // the registry injects the consumer identity it proved (a caller cannot
    // spoof a different one through the context).
    const bind = app.domains.capability({ consumer: 'capability-probe', capability: 'commercial-quote-binding', version: 1, context: { consumer: 'spoofed' } });
    out.bindingFields = bind.fields;
    out.bindingConsumer = bind.contract.consumer;
    out.bindingFrozen = Object.isFrozen(bind);
  `);

  assert.equal(guard.__error, undefined, `phase errored: ${JSON.stringify(guard.__error)}`);
  assert.equal(guard.undeclared, 'CAPABILITY_NOT_DECLARED', 'an undeclared reach across the boundary is refused');
  assert.deepEqual(guard.bindingFields, ['signatureEnvelopeId', 'signatureStatus', 'orderId'],
    'the binding capability names exactly the three managed linkage fields');
  assert.equal(guard.bindingConsumer, 'capability-probe',
    'the registry-proven consumer identity wins over a spoofed one in the context');
  assert.equal(guard.bindingFrozen, true, 'the binding interface is frozen data, not a live write handle');
});
