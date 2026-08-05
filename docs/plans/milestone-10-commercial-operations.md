# Milestone 10 — Commercial Operations v1: catalog, quotes, discount approval

Target brief:

> "Build a quote from a managed product catalog. Prices come from a selected Price Book. Sales may request line discounts, but discounts above the configured threshold require human approval. Every submitted version must preserve the products, prices, discounts, totals and policy version used."

```text
Opportunity
→ create Quote against one Price Book (one currency)
→ add Products as controlled Quote Lines (server-priced)
→ request basis-point discounts
→ deterministic safe-integer totals
→ submit an immutable Quote Version (+ immutable version lines)
→ evaluate a versioned Discount Policy (declared-definition fingerprint)
→ auto-approve, reject, or create a human approval request
→ user actor approves/rejects atomically
→ rejected → revise → edit → submit version 2
→ complete commercial history preserved
```

Strategy context: `docs/strategy/REVENUE_OPERATIONS.md` §2, `EXECUTION_ROADMAP.md` M10. **Signature and Order are Milestone 11 and are not implemented here.** No taxes, currency conversion, usage/tiered pricing, proration, ramps, bundles, PDFs, payment or billing.

## Approaches compared

1. **Generic generated modules + actions only.** Products/quotes as plain public-CRUD modules with a few actions. Fails the brief structurally: prices and totals would be client-writable, quoted evidence mutable, catalog identity unmanaged — the anti-bypass and immutability requirements are unreachable without the managed/read-only machinery anyway.
2. **A monolithic handwritten CPQ core.** New core services + core migrations for eight record types. Maximum control, but duplicates everything the factory already generates (validation, savepoints, audit, events, read-only capabilities, exact queries, indexes), grows the handwritten core by thousands of lines, and forks the storage conventions the rest of the framework proves. Rejected as the *largest* architecture, not the smallest.
3. **Bounded commercial primitives on the hardened M9 machinery (chosen).** Record storage = starter-generated **read-only all-managed modules** (the M9 review pattern: capabilities `['get','list']`, no public create/update, trusted `createManaged`/`applyManaged` only, exact `listWhere`/`countWhere` + manifest indexes). Behavior = framework-owned code-first pieces: a **catalog provider** and **discount policy** contract on the M9 declared-definition fingerprint mechanism (`packages/core/src/commercial-registry.js`), a transactional **catalog sync** with the provider call outside the write transaction (`packages/core/src/catalog-sync.js`), and **quote lifecycle action builders** (`packages/core/src/commercial-actions.js`) registered by the starter like move-stage/enrich. No pricing-expression language, no CPQ DSL; Company/Opportunity are referenced, never duplicated. The M11 signature/order flow will consume the immutable Quote Version without redesign.

## Record model (starter manifests, all read-only public)

| Module | Purpose | Key fields |
|---|---|---|
| `product` | stable product identity | sourceKind internal/provider, provider, externalId, sourceKey (unique), active, currentVersionId |
| `product-version` | immutable commercial description | productId (idx), version, sku, name, description, category, provider/providerVersion/providerFingerprint, sourceFingerprint, effectiveAt, sourceKey (unique `pv:<product>:<n>`) |
| `price-book` | named price list, one currency | name, currency, sourceKind, provider, active, sourceKey (unique) |
| `price-book-entry` | immutable price revision | priceBookId (idx), logicalKey (idx), revision, productId, productVersionId, unitAmountCents, currency, pricingMode one_time/recurring, recurringInterval month/year, active, sourceFingerprint, sourceKey (unique `<logicalKey>:<rev>`) |
| `catalog-sync-run` | one sync execution | provider identity/fingerprint, sourceRef, counts (productsCreated, versionsCreated, entriesCreated, entriesRevised, unchanged, deactivated), startedAt/completedAt, status |
| `quote` | draft + lifecycle state | opportunityId (idx), priceBookId, currency, status draft/pending_approval/approved/rejected (default draft), draftRevision, currentVersionId/Number, currentApprovalId, subtotal/discount/total cents |
| `quote-line` | controlled draft line | quoteId (idx), priceBookEntryId, productId/productVersionId, sku/name snapshots, quantity, discountBps, listUnitAmountCents, netUnitAmountCents, lineSubtotal/Discount/Total cents, pricingMode/interval, removed, position |
| `quote-version` | immutable submitted snapshot | quoteId (idx), versionNumber, sourceKey (unique `qv:<quote>:<n>` — DB-enforced monotonic), opportunityId, priceBookId, currency, draftRevisionUsed, totals, maxLineDiscountBps, effectiveDiscountBps, policy/policyVersion/policyFingerprint, policyDecision, decisionReason, requiredApprovalKey, approvalId, submittedAt/By |
| `quote-version-line` | immutable line snapshot | versionId (idx), product/version/sku/name, entry id + revision, quantity, list/net unit, subtotal/discount/total, pricingMode/interval, position |
| `quote-approval` | one human decision per version | quoteId (idx), quoteVersionId, sourceKey (unique `qa:<versionId>`), policy identity/fingerprint, discount evidence, requiredApprovalKey, status pending/approved/rejected (default pending), reason, decisionReason, requestedBy/At, decidedBy/At |

Approval note: the core Approval domain is renewal/opportunity-specific (its table has a NOT NULL opportunity FK); rather than migrating it, `quote-approval` is a dedicated read-only record + `approve`/`reject` actions enforcing the **same human-actor boundary** (`actor.type === 'user'`, agent actors rejected) the core workflow proves. A generalized approval domain is future work; `requiredApprovalKey` is a **label**, not enforced security — real Sales-Manager/Finance roles need the Production Spine.

## Money and discounts (documented contract)

Amounts are safe integers in 1/100 currency units (ADR-014's non-ISO contract, unchanged). Currencies are uppercase `[A-Z]{3}`; a Quote uses exactly one Price Book and one currency; no conversion. Discounts are integer basis points 0–10000. Rounding policy, exact: `lineSubtotal = listUnitAmount × quantity` (checked safe-integer multiply, quantity 1–1,000,000), `lineDiscount = trunc(lineSubtotal × discountBps ÷ 10000)` — integer division truncating toward zero on non-negative values, so the discount never rounds up — and `lineTotal = lineSubtotal − lineDiscount` is **authoritative**; `netUnitAmount = trunc(listUnitAmount × (10000 − bps) ÷ 10000)` is stored as informational per-unit rounding. Quote totals are checked sums over active lines; `effectiveDiscountBps = trunc(discountTotal × 10000 ÷ subtotal)`. Every price and total is server-derived; clients never submit amounts.

## Catalog sync semantics

`app.syncCatalog({provider, input?, actor})` (+ `POST /api/catalog/sync` on the local-dev server): validate provider → `fetchCatalog` OUTSIDE any transaction under the M9 timeout/late-settlement discipline → validate + normalize (bounded strings, safe integers, canonical currency, unique source keys) → one `BEGIN IMMEDIATE` transaction reconciling by DB-unique source keys: new identities created; changed commercial data creates a **new immutable Product Version / Price Book Entry revision** (change detected by source fingerprint); unchanged identities produce **no** writes/audits/events; provider-managed deactivation only under the provider's declared `deactivateMissing` config; a CatalogSyncRun records identity, counts and trace; partial failure rolls back everything. Same-input re-sync is idempotent; concurrent syncs serialize on the write lock with unique-key backstops. Historical versions/revisions and quoted evidence are never overwritten. Internal (non-provider) catalog data follows the same createManaged path via a code-first internal source definition in the starter.

## Quote lifecycle

`opportunity.create-quote` (opportunity is action-eligible core) validates the Price Book and stamps the Quote's currency. Draft editing via `quote.add-line` / `update-line` / `remove-line` (soft remove): draft-only (fromStates), entry must be active + in the quote's Price Book + currency-matched, snapshots and amounts computed server-side, every change recalculates totals and increments `draftRevision`; optional `expectedRevision` gives optimistic concurrency (`409 STALE_REVISION`). `quote.submit` (draft, ≥1 active line): snapshots version + lines immutably (version number DB-monotonic via unique key), evaluates the declared discount policy (frozen context/config, synchronous bounded result `auto_approve|approval_required|reject`), then atomically: auto_approve → `approved` (no fake approval record); approval_required → `quote-approval` (pending) + `pending_approval`; reject → `rejected` with the reason. `quote.approve`/`quote.reject` (pending_approval only): **user actors only** (agent → 403), decision + quote update + audit + events in one transaction, one decision per version (unique approval key + status check), repeats → stable 409. `quote.revise` (rejected only) → back to draft with lines intact; next submit is version n+1; approved is terminal in M10. Concurrent submits/decisions: one winner via revision checks + DB uniqueness; losers get stable 409s.

## Out of scope (deliberate)

Signature, envelopes, signed artifacts, Order/Order Lines, taxes, FX, ISO exponents, usage/tiered pricing, proration, ramps, bundles, PDF, payment, billing, real Stripe/Zuora/ERP adapters or credentials (future provider packages documented only), secure role enforcement, auth/tenancy/RBAC, Delivery/Service, Analytics, PostgreSQL, Cloud, remote MCP, telemetry.

## Verification plan

`tests/commercial-contract.test.js` (provider/policy validation + fingerprints, money/discount arithmetic matrix incl. overflow/unsafe/fraction/string, policy-result validation) and `tests/commercial-e2e.test.js` (temp-project: sync/idempotency/change-versioning, full quote flow over HTTP/SDK, auto-approve + human approval + agent-actor rejection + reject/revise/version-2, immutability + CRUD bypass matrix, stale revisions, concurrent submit/decision, provider failure/timeout with no partial catalog, policy drift stops boot, restart). Starter `install.mjs` extended with the deterministic SaaS catalog and both approval paths. Admin: a focused Quote view over the override seam + fake-DOM tests + Chromium step.

## Fixed in the adversarial review

(to be filled by the M10 review)
