import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ASSERTED, CLASSIFICATIONS, LEGACY_CHARACTERIZATION_CONTRACT, SURFACES, digest, normalizeIds,
} from './characterization-contract.mjs';

/**
 * **The one file a Signature & Order extraction edits.**
 *
 * The Signature LA0 baseline proves that moving Signature & Order out of the
 * kernel changes no externally observable behaviour. That proof only holds if
 * the same cases and the same baseline run on both sides of the move, so every
 * path that knows where Signature currently lives is concentrated here.
 * Nothing else under `tests/characterization/signature-*` mentions
 * `packages/core/src` at all.
 *
 * **It moves nothing.** This harness performs no extraction, moves no helper,
 * moves no route and adds no seam. It writes down what is true today.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The Signature-specific observation categories. */
export const SIGNATURE_CATEGORIES = Object.freeze([
  'provider-contract', 'document', 'signers', 'envelope-lifecycle', 'webhook',
  'completion-order', 'reconciliation', 'external-operation', 'races-restart',
  'audit-events-trace', 'hostile-input', 'schema-metadata', 'architecture', 'scale',
]);

/**
 * One Signature observation. Same discipline as the shared contract —
 * classifications, empty-observation refusal, defect notes — with the
 * Signature category vocabulary. The shared `observation()` is not reused
 * because its category list is Lead Intelligence's, and this harness may not
 * edit shared files.
 */
export function sigObservation({ id, category, classification, surface, observed, note = null, allowEmpty = false }) {
  if (!SIGNATURE_CATEGORIES.includes(category)) throw new Error(`signature characterization: unknown category "${category}" for ${id}`);
  if (!CLASSIFICATIONS.includes(classification)) throw new Error(`signature characterization: unknown classification "${classification}" for ${id}`);
  if (!SURFACES.includes(surface)) throw new Error(`signature characterization: unknown surface "${surface}" for ${id}`);
  if (classification === 'defect_candidate' && !note) {
    throw new Error(`signature characterization: ${id} is a defect candidate with no explanation — the note IS the finding`);
  }
  if (ASSERTED.includes(classification) && isEmpty(observed) && !allowEmpty) {
    throw new Error(
      `signature characterization: ${id} observed nothing (${JSON.stringify(observed)}). `
      + 'A case that observes nothing asserts nothing. Fix the read, or pass allowEmpty with a note saying why empty is the answer.',
    );
  }
  if (allowEmpty && !note) throw new Error(`signature characterization: ${id} allows an empty observation without saying why`);
  return { id, category, classification, surface, observed, note };
}

/** @param {unknown} value */
function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Everything this baseline promises *not* to cover — Signature's own list,
 * declared rather than discovered later.
 */
export const SIGNATURE_LIMITATIONS = Object.freeze([
  ['DETERMINISTIC_FIXTURES_ONLY', 'the only provider is the checked-in deterministic fixture. Nothing here characterizes a real signature service\'s latency, error shapes, artifact formats or webhook cadence — no DocuSign/Adobe Sign/Dropbox Sign behaviour is frozen because none exists'],
  ['INCIDENTAL_NOT_ASSERTED', 'observations classified incidental are recorded and not compared. Row ordering nobody specified and internal id shapes are free to change'],
  ['DEFECTS_NOT_FROZEN', 'observations classified defect_candidate are reproduced and documented but never asserted as must-stay'],
  ['NOT_A_PERFORMANCE_BASELINE', 'no timing is captured. An extraction that preserves every value and doubles the latency passes this suite'],
  ['CONCURRENCY_ONLY_WHERE_OBSERVABLE', 'races are characterized only where the current implementation exposes a deterministic outcome (one order, one winner). Interleavings without a deterministic observable are not claimed safe by absence of a case'],
  ['WALL_CLOCK_FIELDS_MASKED', 'ingest/reconcile timestamps (receivedAt, sentAt, failedAt, …) come from the wall clock — createSignatureOperations does not receive the injected app clock — so they are asserted by presence, not value. completedAt/acceptedAt come from the deterministic fixture event and are asserted by value'],
  ['ADMIN_DATA_NOT_PIXELS', 'the Admin surface is characterized as the data its reads return (records, capabilities, refusal statuses), not as rendered DOM. Browser behaviour is the repository-wide manual gap QUALITY_GATES §4 records'],
  ['ARTIFACT_BYTES_NOT_STORED', 'artifactHash is provider-reported and the artifact bytes are never downloaded or hashed locally; this baseline freezes exactly that weaker guarantee and no stronger one'],
  ['SINGLE_ATTACHMENT_SHAPE', 'the baseline records how Signature was attached when generated. Comparing baselines generated under different attachment shapes compares two different applications; the contract carries the shape so that cannot happen silently'],
]);

/**
 * @param {{observations: any[], source: Record<string, string>}} input
 */
export function buildSignatureBaseline({ observations, source }) {
  const sorted = [...observations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set();
  for (const entry of sorted) {
    if (seen.has(entry.id)) throw new Error(`signature characterization: duplicate observation id "${entry.id}"`);
    seen.add(entry.id);
  }
  const baseline = {
    legacyCharacterizationContract: LEGACY_CHARACTERIZATION_CONTRACT,
    domain: 'signature-order',
    attachment: ATTACHMENT,
    source,
    counts: CLASSIFICATIONS.reduce((totals, classification) => ({
      ...totals,
      [classification]: sorted.filter((entry) => entry.classification === classification).length,
    }), {}),
    observations: sorted,
    limitations: SIGNATURE_LIMITATIONS.map(([code, message]) => ({ code, message })),
  };
  baseline.fingerprint = digest(sorted
    .filter((entry) => ASSERTED.includes(entry.classification))
    .map((entry) => ({ id: entry.id, classification: entry.classification, observed: entry.observed })));
  return baseline;
}

/**
 * How Signature & Order is attached to a project **today**: one composition
 * entry in `packages/domains/generated/index.js` (`createSignatureDomain`).
 * The `request-signature` action and the two application operations arrive
 * with the package (ADR-032); the webhook/reconcile routes stay kernel-owned,
 * delegating to the composed operations. Before the extraction this was a
 * kernel action import plus the fixed provider slot — `ATTACHMENT` records
 * which shape produced a baseline so a comparison across the move is never
 * silently comparing two different applications.
 */
export const ATTACHMENT = 'composed-domain-package';

/**
 * **Every path that knows where Signature & Order lives today, in one place.**
 * After an extraction these specifiers point into the package, `wireSignature`
 * writes a composition import, and nothing else under
 * `tests/characterization/signature-*` changes.
 */
export const SIGNATURE_SOURCE = Object.freeze({
  operations: '../../packages/signature/src/operations.js',
  registry: '../../packages/signature/src/registry.js',
  /** Patterns for the architecture-evidence cases, kept in the seam. */
  greps: Object.freeze([
    'signature-operations.js', 'signature-registry.js', 'signature/generated',
    '/api/signature/', 'ingestSignatureEvent', 'reconcileSignature',
  ]),
});

/**
 * The neutral external-operation runner, loaded from where it lives today.
 * Assessed neutral (see the ExecPlan §1.5): it is the kernel's generic
 * intent/external/finalize/compensate contract, imported by the action
 * runtime for ANY `externalOperation: 1` action. It is expected to STAY in
 * `packages/core` across a Signature extraction — a separate constant so the
 * domain and the helper can move independently.
 */
export const NEUTRAL_EXTERNAL_OPERATION_SOURCE = '../../packages/core/src/external-operation.js';

/** The Commercial wiring the journeys need to produce an approved quote. */
export const COMMERCIAL_WIRING = Object.freeze({
  domain: '../../commercial/src/index.js',
  starter: '../../../examples/starters/b2b-lead-qualification/commercial.js',
});

/** Where the composed signature package and its fixture provider live. */
export const SIGNATURE_WIRING = Object.freeze({
  domain: '../../signature/src/index.js',
  starter: '../../../examples/starters/b2b-lead-qualification/signature.js',
});

/** Load the Signature internals through the seam. */
export async function loadSignatureInternals() {
  const operations = await import(SIGNATURE_SOURCE.operations);
  const registry = await import(SIGNATURE_SOURCE.registry);
  const externalOperation = await import(NEUTRAL_EXTERNAL_OPERATION_SOURCE);
  return { operations, registry, externalOperation };
}

/** Where the published schema block lives — the location is the seam's business. */
export function signatureSchemaBlock(schema) {
  return schema?.signature ?? schema?.domains?.signature?.metadata ?? schema?.domains?.signature;
}

export function signatureSchemaLocation(schema) {
  if (schema?.signature) return 'schema.signature';
  if (schema?.domains?.signature?.metadata) return 'schema.domains.signature.metadata';
  if (schema?.domains?.signature) return 'schema.domains.signature';
  return null;
}

/**
 * The record manifests the signed-order journey needs, applied in order. The
 * quote/catalog family moved to `packages/commercial/modules/` with the
 * Commercial extraction (#79); the signature/order family stays with the
 * starter. Each entry is `[directory, name]` relative to the project root.
 */
export const SIGNATURE_MANIFESTS = Object.freeze([
  ...[
    'product.module.json', 'product-version.module.json', 'price-book.module.json',
    'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
    'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
    'quote-version.module.json', 'quote-version-line.module.json',
    'quote-version-component.module.json', 'quote-version-total.module.json',
    'quote-approval.module.json',
  ].map((name) => Object.freeze(['packages/commercial/modules', name])),
  ...[
    'signature-envelope.module.json', 'signature-signer.module.json',
    'signature-event.module.json', 'signed-artifact.module.json',
    'order.module.json', 'order-line.module.json', 'order-component.module.json',
    'order-tier.module.json', 'order-total.module.json',
  ].map((name) => Object.freeze(['packages/signature/modules', name])),
]);

/** The fixed clock. Wall-clock leakage is handled by `stable()` masking. */
export const FIXED_NOW = '2026-08-10T00:00:00.000Z';

/** The deterministic timestamp the fixture provider stamps on completion. */
export const FIXTURE_COMPLETED_AT = '2026-08-05T12:00:00.000Z';

/**
 * Behaviour-bearing source: every file whose content decides what Signature &
 * Order does, and therefore what this baseline observes. The Commercial files
 * are here deliberately: the snapshot an Order copies and the totals a
 * document package hashes are computed by Commercial code, so a change there
 * changes what this baseline sees and must stale it.
 */
export const BEHAVIOUR_BEARING_SOURCE = Object.freeze([
  'packages/signature/src/index.js',
  'packages/signature/src/operations.js',
  'packages/signature/src/registry.js',
  'packages/core/src/external-operation.js',
  'packages/core/src/operation-runtime.js',
  'packages/core/src/action-runtime.js',
  'packages/core/src/definition-fingerprint.js',
  'packages/core/src/money.js',
  'packages/commercial/src/index.js',
  'packages/commercial/src/actions.js',
  'packages/commercial/src/registry.js',
  'packages/commercial/src/money.js',
  'packages/commercial/src/catalog-sync.js',
  'packages/commercial/src/capability.js',
  'packages/app/src/create-app.js',
  'apps/server/src/http-server.js',
  'packages/sdk/src/index.js',
  'examples/starters/b2b-lead-qualification/signature.js',
  'examples/starters/b2b-lead-qualification/commercial.js',
  ...SIGNATURE_MANIFESTS.map(([dir, name]) => `${dir}/${name}`),
]);

/**
 * The guard that stops the list above rotting: any kernel file whose name says
 * Signature (or the external-operation runner), and any starter manifest in
 * the signature/order/quote families, must be owned by the digest.
 */
export function unownedSignatureSource(rootDir) {
  const owned = new Set(BEHAVIOUR_BEARING_SOURCE);
  const found = [];
  for (const name of readdirSync(join(rootDir, 'packages/core/src'))) {
    if (/signature|external-operation|operation-runtime/i.test(name)) found.push(`packages/core/src/${name}`);
  }
  for (const name of readdirSync(join(rootDir, 'packages/signature/src'))) {
    if (/\.(mjs|js)$/.test(name)) found.push(`packages/signature/src/${name}`);
  }
  for (const name of readdirSync(join(rootDir, 'packages/signature/modules'))) {
    if (name.endsWith('.module.json')) found.push(`packages/signature/modules/${name}`);
  }
  const starter = 'examples/starters/b2b-lead-qualification';
  for (const name of readdirSync(join(rootDir, starter))) {
    if (/^(signature|signed|order|quote)[^/]*\.module\.json$/.test(name)) found.push(`${starter}/${name}`);
  }
  // The quote/catalog family the signed document snapshots moved to the
  // commercial package with #79; every manifest there feeds this baseline.
  for (const name of readdirSync(join(rootDir, 'packages/commercial/modules'))) {
    if (name.endsWith('.module.json')) found.push(`packages/commercial/modules/${name}`);
  }
  return found.filter((path) => !owned.has(path)).sort();
}

/**
 * Wire Signature the way a project does today: both domains arrive as
 * composed packages, and the action, providers and application operations
 * travel with them. No fixed slot remains for either.
 */
export function wireSignature(root) {
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    '// Quote actions arrive with the commercial package, request-signature',
    '// with the signature package - both composed below.',
    'export const generatedActions = [];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    `import { createCommercialDomain } from '${COMMERCIAL_WIRING.domain}';`,
    `import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '${COMMERCIAL_WIRING.starter}';`,
    `import { createSignatureDomain } from '${SIGNATURE_WIRING.domain}';`,
    `import { fixtureSignatureProvider } from '${SIGNATURE_WIRING.starter}';`,
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),',
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
 * A throwaway project with Signature & Order attached, built by the real
 * module factory and the real CLI.
 */
export function characterizationProject(t, { name = 'accordo-sig-la0-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const [dir, manifest] of SIGNATURE_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, dir, manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  wireSignature(root);
  return root;
}

/**
 * The transport rule from the M12+ suites: server and client share one event
 * loop that this suite blocks for long synchronous stretches, so the client
 * retires every connection with its response instead of keeping a pool the
 * stalled loop cannot keep coherent.
 */
function unpooledFetch(input, init = {}) {
  return fetch(input, { ...init, headers: { ...init.headers, connection: 'close' } });
}

/** Boot the project the way a consumer does: real app, real server, real SDK. */
export async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, clock: () => FIXED_NOW, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    baseUrl,
    client: new AccordoClient({ baseUrl, actor: { type: 'user', id: 'sig-la0' }, fetchImpl: unpooledFetch }),
    agentClient: new AccordoClient({ baseUrl, actor: { type: 'agent', id: 'sig-la0-bot' }, fetchImpl: unpooledFetch }),
    close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()),
  };
}

/** The fixture provider module of a given project copy (per-root state). */
export async function loadFixture(root) {
  return import(pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/signature.js')).href);
}

/** The repository's own fixture module, for pure (no-project) cases. */
export async function loadRepoFixture() {
  return import('../../examples/starters/b2b-lead-qualification/signature.js');
}

/**
 * Fields whose value is wall-clock time (see WALL_CLOCK_FIELDS_MASKED):
 * asserted by presence. `completedAt`/`acceptedAt`/`decidedAt`/`occurredAt`
 * are NOT here — they carry the deterministic fixture timestamp and are
 * asserted by value.
 */
const WALL_CLOCK_FIELDS = new Set([
  'createdAt', 'updatedAt', 'requestedAt', 'receivedAt', 'sentAt',
  'deliveredAt', 'declinedAt', 'voidedAt', 'failedAt', 'startedAt', 'finishedAt',
]);

/** Provider-derived opaque tokens: env_<hex24>, art_<hex16>, and 64-hex hashes. */
const PROVIDER_TOKEN_RES = [/env_[0-9a-f]{24}/g, /art_[0-9a-f]{16}/g, /\b[0-9a-f]{64}\b/g];

/**
 * A record with volatile identity normalized so the shape and the
 * relationships are asserted and the minted values are not:
 *
 * - wall-clock fields become `<present>`/null;
 * - UUIDs, provider envelope/artifact ids and 64-hex digests become
 *   positional tokens — the SAME id or hash always maps to the SAME token
 *   within one observation, so a cross-wired reference is a difference.
 *
 * Definition fingerprints are 64-hex too and are tokenized *inside record
 * dumps*; their exact values are asserted separately, raw, by the
 * schema-metadata fingerprint observations. The dump keeps the relationship
 * (`envelope.providerFingerprint === schema fingerprint` is its own case).
 */
export function stable(value, mapping = new Map()) {
  const tokenize = (text) => {
    let out = text;
    for (const re of PROVIDER_TOKEN_RES) {
      out = out.replace(re, (match) => {
        const key = `tok:${match.toLowerCase()}`;
        if (!mapping.has(key)) mapping.set(key, `<h:${mapping.size + 1}>`);
        return mapping.get(key);
      });
    }
    return out;
  };
  const walk = (input) => {
    if (typeof input === 'string') return tokenize(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const out = {};
      for (const key of Object.keys(input).sort()) {
        if (WALL_CLOCK_FIELDS.has(key)) {
          out[key] = input[key] === null || input[key] === undefined ? null : '<present>';
        } else {
          out[key] = walk(input[key]);
        }
      }
      return out;
    }
    return input;
  };
  // UUID tokens first (shared mapping), then provider tokens over the result.
  return walk(normalizeIds(value, mapping));
}

/** All records normalized through ONE mapping, so cross-record links survive. */
export function stableAll(records) {
  const mapping = new Map();
  return records.map((record) => stable(record, mapping));
}

/**
 * Drive an approved quote: catalog sync → quote → line(s) → submit (→ approve
 * when the policy asks). Deterministic fixture offers; unique names/emails per
 * deal to keep source keys distinct.
 */
export async function approvedQuote(app, { name, discountBps = 500, offers = ['fixture:offer:enterprise'], quantity = 20 }) {
  const actor = { type: 'user', id: 'sig-la0' };
  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const company = await app.services.companies.create({ name: `${name} SpA` }, { actor });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Maria', lastName: 'Bianchi', email: `${slug}@example.com` },
    { actor },
  );
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name, type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'sig-la0' },
    { actor },
  );
  const quote = (await app.runAction({ module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor })).result.quote;
  for (const key of offers) {
    await app.runAction({ module: 'quote', action: 'add-line', recordId: quote.id, input: { offerId: offerOf(key).id, quantity, discountBps }, actor });
  }
  const submitted = await app.runAction({ module: 'quote', action: 'submit', recordId: quote.id, input: { policy: 'standard-sales-discount', version: 1 }, actor });
  if (submitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor });
  }
  return {
    quote: app.modules.get('quote').service.get(quote.id),
    versionId: submitted.result.version.id,
    decision: submitted.result.version.decision,
    company, contact, opportunity,
  };
}

/** The standard single-signer list. */
export const signerList = (email) => [{ name: 'Maria Bianchi', email, role: 'customer', order: 1 }];
