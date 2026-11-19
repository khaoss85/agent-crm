// @ts-check

/**
 * A5 offerta via link (backlog:a3b394dd): the three acceptance criteria,
 * each proven against the real composition with an in-process app.
 *
 * 1. double acceptance stays one acceptance (idempotent accept-link);
 * 2. the accepted price is the frozen version price even when the catalog
 *    reprices afterwards (accept reads version rows only, never the live
 *    catalog);
 * 3. an expired link answers «offerta scaduta» and never accepts, without
 *    leaking names, prices or rows.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { type: 'user', id: 'quote-share-link-test' };
// The customer holds no account: possession of the token is the credential.
const PUBLIC = { type: 'public', id: 'link-holder' };

const COMMERCIAL_MANIFESTS = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
  'quote-version.module.json', 'quote-version-line.module.json',
  'quote-version-component.module.json', 'quote-version-total.module.json',
  'quote-approval.module.json', 'quote-share.module.json',
];

function applyManifests(root) {
  for (const manifest of COMMERCIAL_MANIFESTS) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', join(root, 'packages/commercial/modules', manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(result.status, 0, `apply ${manifest}: ${result.stderr}`);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(
    join(root, 'packages/domains/generated/index.js'),
    [
      '// @ts-check',
      "import { createCommercialDomain } from '../../commercial/src/index.js';",
      "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      'export const generatedDomains = [',
      '  createCommercialDomain({',
      '    catalogProviders: [fixtureSaasCatalogProvider],',
      '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
      '  }),',
      '];',
      '',
    ].join('\n'),
  );
}

let appliedTemplate = null;
function appliedTemplateRoot() {
  if (!appliedTemplate) {
    appliedTemplate = mkdtempSync(join(tmpdir(), 'accordo-quote-share-template-'));
    for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
      cpSync(join(repoRoot, entry), join(appliedTemplate, entry), { recursive: true });
    }
    applyManifests(appliedTemplate);
  }
  return appliedTemplate;
}
after(() => {
  if (appliedTemplate) rmSync(appliedTemplate, { recursive: true, force: true });
  appliedTemplate = null;
});

/**
 * One composition for the whole file: every test builds its own quote,
 * company and link on it (unique `LINK-*` skus), so rows never meet across
 * tests while the nine boots become one. The trace test (A5-0) still proves
 * its own case: absence of any raw Bearer [REDACTED] every `quote.*` run and presence
 * of its own token hash.
 */
let sharedBooted = null;
async function sharedApp() {
  if (!sharedBooted) {
    const root = mkdtempSync(join(tmpdir(), 'accordo-quote-share-'));
    cpSync(appliedTemplateRoot(), root, { recursive: true });
    const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
    sharedBooted = { root, app: createAccordoApp({ dbPath: ':memory:' }) };
  }
  return sharedBooted.app;
}
after(() => {
  if (sharedBooted) {
    sharedBooted.app.close();
    rmSync(sharedBooted.root, { recursive: true, force: true });
    sharedBooted = null;
  }
});

const COMPONENT = (flatAmountCents) => ({
  key: 'pacchetto',
  label: 'Prezzo del pacchetto',
  chargeType: 'one_time',
  pricingModel: 'flat_fee',
  flatAmountCents,
});

/** An approved quote over a manual product priced at `cents`. */
async function approvedQuote(app, { sku, cents }) {
  const created = await app.createManualProduct({
    sku, name: `Prodotto ${sku}`, currency: 'EUR', components: [COMPONENT(cents)],
  }, ACTOR);
  const company = await app.services.companies.create({ name: `Co ${sku}` }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: `Deal ${sku}`, type: 'new_business', valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'seed' },
    { actor: ACTOR },
  );
  const opportunityId = opportunity.id;
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
    input: { priceBookId: created.priceBook.id }, actor: ACTOR,
  })).result.quote;
  await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: created.offers[0].id, quantity: 1 }, actor: ACTOR,
  });
  const submitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }
  const record = await app.modules.get('quote').service.get(quote.id);
  assert.equal(record.status, 'approved');
  return { quote: record, opportunityId, product: created.product, offerId: created.offers[0].id };
}

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message) };
  }
}

const hashOf = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

test('A5-1: accepting twice from the link stays one acceptance', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-1', cents: 10000 });
  const shared = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  // The raw bearer travels exactly once, top-level: never inside the share.
  const token = shared.result.token;
  assert.match(token, /^[0-9a-f]{64}$/, 'the token is unguessable');
  assert.ok(!('token' in shared.result.share), 'the share summary carries no bearer');

  const first = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(first.result.accepted, true, 'the first accept lands without a login');
  assert.equal(first.result.offer.oneTimeNetCents, 10000, 'the accepted price is the sent one');
  assert.ok(!('token' in first.result.share), 'the accept result carries no bearer');
  const acceptedAt = first.result.acceptedAt;

  const second = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(second.result.alreadyAccepted, true, 'the second accept answers already accepted');
  assert.equal(second.result.acceptedAt, acceptedAt, 'the acceptance instant never moves');
  assert.equal(second.result.offer.oneTimeNetCents, 10000, 'the price still answers, unchanged');

  const shares = app.modules.get('quote-share').service;
  const rows = shares.listWhere({ tokenHash: hashOf(token) });
  assert.equal(rows.length, 1, 'the row is found by its hash');
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].acceptCount, 1, 'exactly one acceptance is recorded');
  assert.ok(!('token' in rows[0]), 'the stored row holds no raw bearer');
  assert.equal(rows[0].tokenHash, hashOf(token), 'the stored hash matches the bearer');

  // The bearer is gone from the row: the plaintext lookup finds nothing.
  assert.equal(shares.listWhere({ tokenHash: token }).length, 0);

  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'accepted');
  assert.equal(info.result.message, 'già accettata');
});

test('A5-1b: the acceptance proof survives the link expiry', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-1B', cents: 10000 });
  const { token } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  })).result;
  const first = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(first.result.accepted, true);

  // Time passes: the link expires AFTER the acceptance.
  const shares = app.modules.get('quote-share').service;
  const shareId = shares.listWhere({ tokenHash: hashOf(token) })[0].id;
  await shares.applyManaged(shareId, { expiresAt: '2000-01-01T00:00:00.000Z' }, { actor: ACTOR });

  const again = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(again.result.alreadyAccepted, true, 'an accepted-then-expired link still accepts idempotently');
  assert.equal(again.result.acceptedAt, first.result.acceptedAt, 'the acceptance instant never moves');
  assert.equal(again.result.offer.oneTimeNetCents, 10000, 'the frozen price still answers');

  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'accepted');
  assert.equal(info.result.message, 'già accettata');
  assert.equal(info.result.offer.oneTimeNetCents, 10000, 'link-info still proves the frozen price');

  const row = shares.listWhere({ tokenHash: hashOf(token) })[0];
  assert.equal(row.acceptCount, 1, 'the expired reopen wrote nothing');
});

test('A5-2: the accepted price is the frozen send price after a catalog reprice', async (t) => {
  const app = await sharedApp();
  const { quote, product, offerId } = await approvedQuote(app, { sku: 'LINK-2', cents: 10000 });
  const { token } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  })).result;

  // The catalog moves AFTER the send: revision 2 doubles the price.
  await app.setManualPrices({
    productId: product.id,
    offerIds: [offerId],
    offers: [{ name: 'Prodotto LINK-2', components: [COMPONENT(20000)] }],
  }, ACTOR);
  // Scoped by product id: the shared composition holds every test's product.
  const live = (await app.listCatalogProducts({})).products.find((row) => row.productId === product.id)?.offers[0];
  assert.ok(live, 'the repriced product is still listed');
  assert.equal(live.components[0].flatAmountCents, 20000, 'the live catalog really moved');

  const accepted = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.offer.oneTimeNetCents, 10000, 'the link still accepts the frozen send price');
  assert.equal(accepted.result.offer.lines[0].netAmountCents, 10000);
  const versionTotals = app.modules.get('quote-version-total').service.listWhere({ versionId: accepted.result.offer.versionId });
  assert.equal(versionTotals[0].netAmountCents, 10000, 'the version rows never moved');
});

test('A5-3: an expired link shows «offerta scaduta» and never accepts', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-3', cents: 10000 });
  const shared = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: { expiresInDays: 1 }, actor: ACTOR,
  });
  const { token } = shared.result;
  // Time passes: the link expires without any other change.
  const shares = app.modules.get('quote-share').service;
  const shareId = shares.listWhere({ tokenHash: hashOf(token) })[0].id;
  await shares.applyManaged(shareId, { expiresAt: '2000-01-01T00:00:00.000Z' }, { actor: ACTOR });

  const denied = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  }));
  assert.equal(denied.ok, false, 'an expired link never accepts');
  assert.equal(denied.code, 'QUOTE_LINK_EXPIRED');
  assert.equal(denied.status, 410);
  assert.equal(denied.message, 'offerta scaduta');
  assert.doesNotMatch(denied.message, /\d{4,}/, 'the refusal carries no price');

  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'expired');
  assert.equal(info.result.message, 'offerta scaduta');
  assert.ok(!('offer' in info.result), 'an expired link leaks no rows');

  const unknown = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: '0'.repeat(64) }, actor: PUBLIC,
  }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'QUOTE_LINK_INVALID');
  assert.equal(unknown.message, 'link non valido o scaduto');

  const row = shares.listWhere({ tokenHash: hashOf(token) })[0];
  assert.equal(row.status, 'active', 'the refused accept wrote nothing');
  assert.equal(row.acceptCount, 0);
});

test('A5-0: the link bearer never rests in workflow_runs or trace_spans', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-0', cents: 10000 });
  const shared = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const token = shared.result.token;
  assert.match(token, /^[0-9a-f]{64}$/, 'the token is unguessable');
  await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  // A refused accept persists its trace too: the attempted bearer is hashed there as well.
  const wrong = '0'.repeat(64);
  const denied = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: wrong }, actor: PUBLIC,
  }));
  assert.equal(denied.ok, false);

  const runs = app.database.raw.prepare(
    "SELECT workflow_name, input_json, output_json FROM workflow_runs WHERE workflow_name LIKE 'quote.%'",
  ).all();
  assert.ok(runs.length >= 4, 'every link action left its trace');
  for (const run of runs) {
    for (const column of [run.input_json, run.output_json]) {
      if (column === null || column === undefined) continue;
      assert.ok(!String(column).includes(token), `${run.workflow_name} trace holds no raw bearer`);
      assert.ok(!String(column).includes(wrong), `${run.workflow_name} trace holds no attempted bearer`);
    }
  }
  const spans = app.database.raw.prepare('SELECT output_json FROM trace_spans').all();
  assert.ok(spans.length > 0, 'spans were recorded');
  for (const span of spans) {
    if (span.output_json === null || span.output_json === undefined) continue;
    assert.ok(!String(span.output_json).includes(token), 'no span holds the raw bearer');
  }
  // The lookup form is what the traces hold: the hash still correlates trace to row.
  const traced = runs.map((run) => `${run.input_json ?? ''}${run.output_json ?? ''}`).join('\n');
  assert.ok(traced.includes(hashOf(token)), 'the traces hold the token hash, never the bearer');
});

test('A5-1c: re-sharing an accepted version mints no second link', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-1C', cents: 10000 });
  const { token } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  })).result;
  const first = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(first.result.accepted, true);

  const again = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.alreadyExisted, true, 'the accepted version is reused, never re-minted');
  assert.equal(again.result.token, null, 'no second bearer leaves the server');
  assert.equal(again.result.share.status, 'accepted', 'the receipt names the terminal state');

  const shares = app.modules.get('quote-share').service;
  const rows = shares.listWhere({ quoteVersionId: first.result.offer.versionId });
  assert.equal(rows.length, 1, 'one row per version, even after the re-share');
  assert.equal(rows[0].acceptCount, 1, 'no second acceptance was recorded');

  const retry = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(retry.result.alreadyAccepted, true, 'the original link still answers already accepted');
  assert.equal(retry.result.acceptedAt, first.result.acceptedAt, 'the acceptance instant never moves');
});

test('A5-matrix: every stored link state answers every link operation the same way', async (t) => {
  // One table holds every case the review rounds named — idempotent accept,
  // accepted-before-expiry, re-share after accept, expired refusal, unknown
  // token — so a later cure cannot fix one case by breaking another.
  const app = await sharedApp();
  const first = await approvedQuote(app, { sku: 'LINK-M1', cents: 10000 });
  const second = await approvedQuote(app, { sku: 'LINK-M2', cents: 5000 });

  const token = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: first.quote.id, input: {}, actor: ACTOR,
  })).result.token;
  const acceptedAt = (await app.runAction({
    module: 'quote', action: 'accept-link', recordId: first.quote.id, input: { token }, actor: PUBLIC,
  })).result.acceptedAt;

  const token2 = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: second.quote.id, input: {}, actor: ACTOR,
  })).result.token;

  const shares = app.modules.get('quote-share').service;
  const expire = (bearer) => {
    const row = shares.listWhere({ tokenHash: hashOf(bearer) })[0];
    assert.ok(row, 'the bearer resolves to a row before expiring it');
    return shares.applyManaged(row.id, { expiresAt: '2000-01-01T00:00:00.000Z' }, { actor: ACTOR });
  };

  const link = (recordId, action, input, actor) =>
    refusal(app.runAction({ module: 'quote', action, recordId, input, actor }));
  const unknown = 'f'.repeat(64);
  /** @type {Array<{ name: string, run: () => Promise<any>, check: (out: any) => void }>} */
  const cases = [
    {
      name: 'accepted + share-link reuses the receipt, mints nothing',
      run: () => link(first.quote.id, 'share-link', {}, ACTOR),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyExisted, true);
        assert.equal(out.value.result.token, null);
        assert.equal(out.value.result.share.status, 'accepted');
      },
    },
    {
      name: 'accepted + accept-link answers already accepted',
      run: () => link(first.quote.id, 'accept-link', { token }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyAccepted, true);
        assert.equal(out.value.result.acceptedAt, acceptedAt);
        assert.equal(out.value.result.offer.oneTimeNetCents, 10000);
      },
    },
    {
      name: 'accepted + link-info proves the frozen price',
      run: () => link(first.quote.id, 'link-info', { token }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.status, 'accepted');
        assert.equal(out.value.result.offer.oneTimeNetCents, 10000);
      },
    },
    {
      name: 'live + share-link reuses the live link',
      run: () => link(second.quote.id, 'share-link', {}, ACTOR),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyExisted, true);
        assert.equal(out.value.result.token, null);
        assert.equal(out.value.result.share.status, 'active');
      },
    },
    {
      name: 'live + link-info shows the frozen offer',
      run: () => link(second.quote.id, 'link-info', { token: token2 }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.status, 'active');
        assert.equal(out.value.result.offer.oneTimeNetCents, 5000);
      },
    },
  ];
  for (const c of cases) {
    try {
      c.check(await c.run());
    } catch (error) {
      error.message = `[${c.name}] ${error.message}`;
      throw error;
    }
  }

  // Time passes: both links expire — the accepted proof must survive, the
  // live link must refuse, and the accepted version still mints nothing.
  await expire(token);
  await expire(token2);
  /** @type {Array<{ name: string, run: () => Promise<any>, check: (out: any) => void }>} */
  const afterExpiry = [
    {
      name: 'accepted+expired + accept-link still answers already accepted',
      run: () => link(first.quote.id, 'accept-link', { token }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyAccepted, true);
        assert.equal(out.value.result.acceptedAt, acceptedAt);
        assert.equal(out.value.result.offer.oneTimeNetCents, 10000);
      },
    },
    {
      name: 'accepted+expired + link-info still proves the acceptance',
      run: () => link(first.quote.id, 'link-info', { token }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.status, 'accepted');
        assert.equal(out.value.result.offer.oneTimeNetCents, 10000);
      },
    },
    {
      name: 'accepted+expired + share-link still mints nothing',
      run: () => link(first.quote.id, 'share-link', {}, ACTOR),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyExisted, true);
        assert.equal(out.value.result.token, null);
        assert.equal(out.value.result.share.status, 'accepted');
      },
    },
    {
      name: 'expired + share-link mints a fresh bearer (no live, no accepted)',
      run: () => link(second.quote.id, 'share-link', {}, ACTOR),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.alreadyExisted, false);
        assert.match(out.value.result.token, /^[0-9a-f]{64}$/);
        assert.notEqual(out.value.result.token, token2);
      },
    },
    {
      name: 'expired + accept-link refuses «offerta scaduta»',
      run: () => link(second.quote.id, 'accept-link', { token: token2 }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, false);
        assert.equal(out.code, 'QUOTE_LINK_EXPIRED');
        assert.equal(out.message, 'offerta scaduta');
      },
    },
    {
      name: 'expired + link-info shows «offerta scaduta», no offer',
      run: () => link(second.quote.id, 'link-info', { token: token2 }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, true);
        assert.equal(out.value.result.status, 'expired');
        assert.equal(out.value.result.message, 'offerta scaduta');
        assert.ok(!('offer' in out.value.result));
      },
    },
    {
      name: 'unknown + accept-link refuses «link non valido o scaduto»',
      run: () => link(first.quote.id, 'accept-link', { token: unknown }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, false);
        assert.equal(out.code, 'QUOTE_LINK_INVALID');
        assert.equal(out.message, 'link non valido o scaduto');
      },
    },
    {
      name: 'unknown + link-info refuses «link non valido o scaduto»',
      run: () => link(first.quote.id, 'link-info', { token: unknown }, PUBLIC),
      check: (out) => {
        assert.equal(out.ok, false);
        assert.equal(out.code, 'QUOTE_LINK_INVALID');
      },
    },
  ];
  for (const c of afterExpiry) {
    try {
      c.check(await c.run());
    } catch (error) {
      error.message = `[${c.name}] ${error.message}`;
      throw error;
    }
  }

  assert.equal(shares.listWhere({ quoteId: first.quote.id }).length, 1, 'the accepted version was never re-minted');
  assert.equal(shares.listWhere({ quoteId: first.quote.id })[0].acceptCount, 1);
});

test('re-sharing a live link returns no bearer', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-R', cents: 10000 });
  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.match(first.result.token, /^[0-9a-f]{64}$/);
  const second = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(second.result.alreadyExisted, true, 'the live link is reused, not minted twice');
  assert.equal(second.result.token, null, 'the hash cannot give the bearer back: resend the original link');
  assert.deepEqual(second.result.share, first.result.share);
});

test('sharing stays a human act on an approved quote only', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-4', cents: 5000 });
  const refused = await refusal(app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: PUBLIC,
  }));
  assert.equal(refused.ok, false, 'no login-free share');
  assert.equal(refused.code, 'HUMAN_ACTOR_REQUIRED');

  const created = await app.createManualProduct({
    sku: 'LINK-DRAFT', name: 'Bozza', currency: 'EUR', components: [COMPONENT(1000)],
  }, ACTOR);
  const company = await app.services.companies.create({ name: 'Co draft' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Deal draft', type: 'new_business', valueCents: 1000, currency: 'EUR', stage: 'discovery', owner: 'seed' },
    { actor: ACTOR },
  );
  const draft = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id,
    input: { priceBookId: created.priceBook.id }, actor: ACTOR,
  })).result.quote;
  const draftShare = await refusal(app.runAction({
    module: 'quote', action: 'share-link', recordId: draft.id, input: {}, actor: ACTOR,
  }));
  assert.equal(draftShare.ok, false, 'a draft carries no sendable price');
});

test('A5-4: a lost first answer regenerates — the old token dies, the new one opens the frozen price', async (t) => {
  const app = await sharedApp();
  const { quote, product, offerId } = await approvedQuote(app, { sku: 'LINK-4R', cents: 10000 });
  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const lost = first.result.token;
  assert.match(lost, /^[0-9a-f]{64}$/, 'the first answer carried a bearer');

  // The operator never saw it: regenerate revokes the live link and mints one bearer.
  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.alreadyExisted, false);
  assert.equal(again.result.regenerated, true, 'the live link was revoked and replaced');
  const token = again.result.token;
  assert.match(token, /^[0-9a-f]{64}$/, 'the fresh bearer is unguessable');
  assert.notEqual(token, lost, 'the fresh bearer differs from the lost one');
  assert.ok(!('token' in again.result.share), 'the share summary carries no bearer');

  // The lost bearer is dead: it answers «link non valido o scaduto», never the offer.
  const deadAccept = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: lost }, actor: PUBLIC,
  }));
  assert.equal(deadAccept.ok, false);
  assert.equal(deadAccept.code, 'QUOTE_LINK_INVALID');
  assert.equal(deadAccept.status, 404);
  assert.equal(deadAccept.message, 'link non valido o scaduto');
  const deadInfo = await refusal(app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token: lost }, actor: PUBLIC,
  }));
  assert.equal(deadInfo.ok, false);
  assert.equal(deadInfo.code, 'QUOTE_LINK_INVALID');

  // The catalog moves AFTER the regenerate: the new link still opens the frozen send price.
  await app.setManualPrices({
    productId: product.id,
    offerIds: [offerId],
    offers: [{ name: 'Prodotto LINK-4R', components: [COMPONENT(20000)] }],
  }, ACTOR);
  const accepted = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(accepted.result.accepted, true, 'the fresh link accepts without a login');
  assert.equal(accepted.result.offer.oneTimeNetCents, 10000, 'the price is the frozen send price');
  assert.equal(accepted.result.offer.lines[0].netAmountCents, 10000);

  const shares = app.modules.get('quote-share').service;
  const rows = shares.listWhere({ quoteId: quote.id, quoteVersionId: first.result.share.quoteVersionId });
  assert.equal(rows.length, 1, 'one row per version: the bearer rotated, no second row was minted');
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].tokenHash, hashOf(token), 'the row holds the fresh hash, never the bearer');
});

test('A5-4e: a bearer revoked between the accept read and its commit cannot steal the rotated row', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-4E', cents: 10000 });
  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const lost = first.result.token;
  assert.match(lost, /^[0-9a-f]{64}$/, 'the first answer carried a bearer');

  // The rotation the pending accept is about to lose against: a fresh
  // bearer the operator holds, committed mid-accept.
  const fresh = hashOf(`${lost}:fresh`);
  const freshHash = hashOf(fresh);

  const shares = app.modules.get('quote-share').service;
  const shareTable = shares.manifest.table;
  const tokenHashCol = shares.manifest.fields.find((field) => field?.name === 'tokenHash')?.column;
  assert.equal(typeof tokenHashCol, 'string', 'the test pins the same mapped hash column as the claim');
  const shareId = shares.listWhere({ tokenHash: hashOf(lost) })[0].id;

  // Stage the supervisor's race: the rotation commits after the accept
  // read its bearer but before the accept claim writes. The raw handle is
  // the same connection the claim writes through, so the staged write is
  // visible to the claim — no nested action, no second connection,
  // deterministic on every run. The first UPDATE on the share row inside
  // this window is the accept claim (reads before it are all SELECTs).
  const raw = app.database.raw;
  const origPrepare = raw.prepare.bind(raw);
  let staged = false;
  raw.prepare = (sql, ...rest) => {
    if (!staged && typeof sql === 'string' && sql.startsWith('UPDATE "') && sql.includes(`"${shareTable}"`)) {
      staged = true;
      origPrepare(`UPDATE "${shareTable}" SET ${tokenHashCol} = ? WHERE id = ?`).run(freshHash, shareId);
    }
    return origPrepare(sql, ...rest);
  };
  let dead;
  try {
    dead = await refusal(app.runAction({
      module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: lost }, actor: PUBLIC,
    }));
  } finally {
    raw.prepare = origPrepare;
  }
  assert.equal(staged, true, 'the rotation really landed between the accept read and its commit');
  assert.equal(dead.ok, false, 'the revoked bearer never accepts the row it lost');
  assert.equal(dead.code, 'QUOTE_LINK_INVALID');
  assert.equal(dead.status, 404);

  // The refused claim wrote nothing: the row is still live, never accepted.
  const current = await shares.get(shareId);
  assert.equal(current.status, 'active', 'the refused accept left the live row alone');
  assert.equal(current.acceptCount, 0, 'the refused accept recorded no acceptance');

  // The operator recovers through the real chain: regenerate revokes and
  // the fresh bearer opens the frozen send price.
  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.regenerated, true);
  const recovered = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: again.result.token }, actor: PUBLIC,
  });
  assert.equal(recovered.result.accepted, true, 'the fresh bearer accepts without a login');
  assert.equal(recovered.result.offer.oneTimeNetCents, 10000, 'the price is the frozen send price');
});

test('A5-4b: an accepted link is never revoked nor regenerated — the receipt stays', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-4B', cents: 10000 });
  const { token } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  })).result;
  const first = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(first.result.accepted, true);

  const refused = await refusal(app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  }));
  assert.equal(refused.ok, false, 'regenerating an accepted link refuses');
  assert.equal(refused.code, 'QUOTE_LINK_ALREADY_ACCEPTED');
  assert.equal(refused.status, 409);

  // Nothing moved: the receipt answers exactly as before.
  const shares = app.modules.get('quote-share').service;
  const rows = shares.listWhere({ tokenHash: hashOf(token) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].acceptCount, 1, 'the refused regenerate wrote nothing');
  const retry = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(retry.result.alreadyAccepted, true, 'the original link still answers already accepted');
  assert.equal(retry.result.acceptedAt, first.result.acceptedAt, 'the acceptance instant never moves');
  const info = await app.runAction({
    module: 'quote', action: 'link-info', recordId: quote.id, input: { token }, actor: PUBLIC,
  });
  assert.equal(info.result.status, 'accepted');
});

test('A5-4c: regenerating an expired link mints a fresh bearer and the old hash dies', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-4C', cents: 10000 });
  const { token: stale } = (await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: { expiresInDays: 1 }, actor: ACTOR,
  })).result;
  const shares = app.modules.get('quote-share').service;
  const shareId = shares.listWhere({ tokenHash: hashOf(stale) })[0].id;
  await shares.applyManaged(shareId, { expiresAt: '2000-01-01T00:00:00.000Z' }, { actor: ACTOR });

  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.alreadyExisted, false);
  assert.match(again.result.token, /^[0-9a-f]{64}$/);
  assert.notEqual(again.result.token, stale);
  const accepted = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: again.result.token }, actor: PUBLIC,
  });
  assert.equal(accepted.result.accepted, true, 'the fresh link accepts');
  assert.equal(accepted.result.offer.oneTimeNetCents, 10000);
});

test('A5-4d: the regenerate trace holds the token hash, never the bearer', async (t) => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-4D', cents: 10000 });
  await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  const token = again.result.token;
  assert.match(token, /^[0-9a-f]{64}$/);

  const runs = app.database.raw.prepare(
    "SELECT workflow_name, input_json, output_json FROM workflow_runs WHERE workflow_name = 'quote.regenerate-link'",
  ).all();
  assert.ok(runs.length >= 1, 'the regenerate left its trace');
  for (const run of runs) {
    for (const column of [run.input_json, run.output_json]) {
      if (column === null || column === undefined) continue;
      assert.ok(!String(column).includes(token), 'no regenerate trace holds the raw bearer');
    }
  }
  const traced = runs.map((run) => `${run.input_json ?? ''}${run.output_json ?? ''}`).join('\n');
  assert.ok(traced.includes(hashOf(token)), 'the trace holds the token hash, never the bearer');
});

test('bf1bc20a: every link creation writes its cronologia row, a reuse writes none', async (t) => {
  const app = await sharedApp();
  const { quote, opportunityId } = await approvedQuote(app, { sku: 'LINK-HIST', cents: 10000 });
  // Only the link rows: the opportunity creation writes its own `created`
  // row first. Sorted so equal instants never flake.
  const actions = () => app.audit
    .list({ entityType: 'opportunity', entityId: opportunityId })
    .map((row) => row.action)
    .filter((action) => action === 'opportunity.quote_link_shared' || action === 'opportunity.quote_link_regenerated')
    .sort();

  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.match(first.result.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(actions(), ['opportunity.quote_link_shared'], 'the mint writes one cronologia row');
  const minted = app.audit.list({ entityType: 'opportunity', entityId: opportunityId })[0];
  assert.equal(minted.data.quoteId, quote.id, 'the row names the quote');
  assert.ok(!JSON.stringify(minted.data).includes(first.result.token), 'the row carries no bearer');

  const second = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(second.result.alreadyExisted, true);
  assert.equal(second.result.token, null);
  assert.deepEqual(actions(), ['opportunity.quote_link_shared'], 'a reuse writes no second row');

  // The operator lost the first answer: regenerate revokes and replaces.
  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.regenerated, true);
  assert.match(again.result.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    actions(),
    ['opportunity.quote_link_regenerated', 'opportunity.quote_link_shared'],
    'the regenerate writes its own cronologia row',
  );

  const dead = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: first.result.token }, actor: PUBLIC,
  }));
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'QUOTE_LINK_INVALID', 'the old link opens no more');
  const opened = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: again.result.token }, actor: PUBLIC,
  });
  assert.equal(opened.result.accepted, true, 'the new link works');
});

test('bf1bc20a: a quote without an opportunity still mints — the row lands in the quote history (arbitrato #995 giro 3)', async () => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-NOOPP', cents: 10000 });
  // A legacy/manual/stub quote shape: approved and versioned, but naming no
  // offer — opportunityId is optional in the module, so the link must still
  // be created and its row lands on the quote audit instead.
  await app.modules.get('quote').service.applyManaged(quote.id, { opportunityId: null }, { actor: ACTOR });
  const shares = app.modules.get('quote-share').service;
  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.match(first.result.token, /^[0-9a-f]{64}$/, 'the link is created without an offer');
  const live = await shares.listWhere({ quoteId: quote.id });
  assert.equal(live.length, 1, 'exactly one live bearer');
  const minted = app.audit
    .list({ entityType: 'quote', entityId: quote.id })
    .filter((row) => row.action === 'quote.quote_link_shared' && row.data?.quoteId === quote.id);
  assert.equal(minted.length, 1, 'the mint writes its row in the quote history');
  assert.equal(minted[0].data.shareId, live[0].id, 'the row names the live share');
  assert.ok(!JSON.stringify(minted[0].data).includes(first.result.token), 'the row carries no bearer');

  // The operator lost the first answer: regenerate revokes and replaces,
  // and the old token dies at once — also without an offer.
  const again = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(again.result.regenerated, true);
  assert.match(again.result.token, /^[0-9a-f]{64}$/);
  const dead = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: first.result.token }, actor: PUBLIC,
  }));
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'QUOTE_LINK_INVALID', 'the old link opens no more');
  const opened = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: again.result.token }, actor: PUBLIC,
  });
  assert.equal(opened.result.accepted, true, 'the new link works');
  const regens = app.audit
    .list({ entityType: 'quote', entityId: quote.id })
    .filter((row) => row.action === 'quote.quote_link_regenerated' && row.data?.quoteId === quote.id);
  assert.equal(regens.length, 1, 'the regenerate writes its own row in the quote history');
});

test('bf1bc20a: a live link stays reachable when the quote names no offer — reuse needs no history target (review #995 P1 giro 2)', async () => {
  const app = await sharedApp();
  const { quote } = await approvedQuote(app, { sku: 'LINK-NOOPP-LIVE', cents: 10000 });
  const first = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.match(first.result.token, /^[0-9a-f]{64}$/);
  // A legacy/manual quote shape: approved and live, but naming no offer.
  await app.modules.get('quote').service.applyManaged(quote.id, { opportunityId: null }, { actor: ACTOR });
  const shares = app.modules.get('quote-share').service;
  const resurfaced = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(resurfaced.result.alreadyExisted, true, 'the live link is resurfaced, not refused');
  assert.equal(resurfaced.result.token, null, 'a reuse never reissues the bearer');
  assert.equal((await shares.listWhere({ quoteId: quote.id })).length, 1, 'still one live row, no second mint');
  // Rotating without an offer still rotates: the row lands in the quote
  // history, the old bearer dies at once, and the new one opens.
  const rotated = await app.runAction({
    module: 'quote', action: 'regenerate-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(rotated.result.regenerated, true, 'the rotation lands without an offer');
  assert.match(rotated.result.token, /^[0-9a-f]{64}$/);
  const dead = await refusal(app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: first.result.token }, actor: PUBLIC,
  }));
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'QUOTE_LINK_INVALID', 'the rotated bearer opens no more');
  const opened = await app.runAction({
    module: 'quote', action: 'accept-link', recordId: quote.id, input: { token: rotated.result.token }, actor: PUBLIC,
  });
  assert.equal(opened.result.accepted, true, 'the rotated link opens');
});

test('bf1bc20a: a mint whose history row write fails leaves no live bearer — the mint rolls back with its row (review #995 P1 giro 2)', async () => {
  const app = await sharedApp();
  const { quote, opportunityId } = await approvedQuote(app, { sku: 'LINK-LOSTROW', cents: 10000 });
  const shares = app.modules.get('quote-share').service;
  // The giro-2 review reads the mint and its cronologia row as two commits
  // and asks for atomicity: the action runtime already runs the whole
  // execute inside one database transaction (packages/core/src/
  // action-runtime.js: transactionAsync wraps definition.execute), so a
  // failing row write rolls the mint back too. Only the opportunity
  // history row fails here: the share insert (entityType quote-share)
  // passes through untouched.
  const audit = shares.audit;
  const originalRecord = audit.record.bind(audit);
  let failOnce = true;
  audit.record = (event, handle) => {
    if (failOnce && event?.entityType === 'opportunity') {
      failOnce = false;
      throw new Error('audit down');
    }
    return originalRecord(event, handle);
  };
  let lost;
  try {
    lost = await refusal(app.runAction({
      module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
    }));
  } finally {
    delete audit.record;
  }
  assert.equal(lost.ok, false, 'the mint without its row answers an error, never a bare link');
  assert.deepEqual(
    await shares.listWhere({ quoteId: quote.id }),
    [],
    'no bearer is left live without its cronologia row: the rollback takes the mint with it',
  );

  // The next press mints fresh — with its row this time — instead of
  // reusing a row-less bearer that can never exist.
  const retry = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(retry.result.alreadyExisted, false, 'nothing to reuse: the failed mint left nothing behind');
  assert.match(retry.result.token, /^[0-9a-f]{64}$/);
  const liveAfter = await shares.listWhere({ quoteId: quote.id });
  assert.equal(liveAfter.length, 1, 'the retry left exactly one live bearer');
  const rows = app.audit
    .list({ entityType: 'opportunity', entityId: opportunityId })
    .filter((row) => (row.action === 'opportunity.quote_link_shared' || row.action === 'opportunity.quote_link_regenerated')
      && row.data?.shareId === liveAfter[0].id);
  assert.equal(rows.length, 1, 'the retry minted with its cronologia row');
  assert.equal(rows[0].data.backfilled, undefined, 'a first-write row is not marked backfilled');
});

test('bf1bc20a: a pre-feature live bearer with no row gains its row on reuse — marked backfilled (review #995 P1 giro 2)', async () => {
  const app = await sharedApp();
  const { quote, opportunityId } = await approvedQuote(app, { sku: 'LINK-LEGACY', cents: 10000 });
  const shares = app.modules.get('quote-share').service;
  // A bearer minted before the cronologia row existed: live, but with no
  // opportunity.quote_link_* row anywhere — the shape the live incident
  // left behind.
  const legacy = await shares.createManaged({
    quoteId: quote.id,
    quoteVersionId: quote.currentVersionId,
    versionNumber: quote.currentVersionNumber,
    tokenHash: createHash('sha256').update('legacy-bearer', 'utf8').digest('hex'),
    status: 'active',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    acceptCount: 0,
    createdBy: 'legacy-seed',
  }, { actor: ACTOR });
  const before = app.audit
    .list({ entityType: 'opportunity', entityId: opportunityId })
    .filter((row) => row.action === 'opportunity.quote_link_shared' || row.action === 'opportunity.quote_link_regenerated');
  assert.equal(before.length, 0, 'the legacy bearer starts with no cronologia row');

  const resurfaced = await app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor: ACTOR,
  });
  assert.equal(resurfaced.result.alreadyExisted, true, 'the legacy bearer is resurfaced, not refused');
  assert.equal(resurfaced.result.token, null);
  const rows = app.audit
    .list({ entityType: 'opportunity', entityId: opportunityId })
    .filter((row) => (row.action === 'opportunity.quote_link_shared' || row.action === 'opportunity.quote_link_regenerated')
      && row.data?.shareId === legacy.id);
  assert.equal(rows.length, 1, 'the reuse healed the missing cronologia row');
  assert.equal(rows[0].data.backfilled, true, 'the healed row says it is healed');
});
