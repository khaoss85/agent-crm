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

Strategy context: `docs/strategy/REVENUE_OPERATIONS.md` §2, `EXECUTION_ROADMAP.md` M10. **Signature and Order are Milestone 11 and are not implemented here.** No taxes, currency conversion, metered usage, overage, proration, ramps, minimum commitments, attribute-based pricing, PDFs, payment or billing. Volume and graduated tiering ARE supported (corrected in the adversarial review — see the correction section).

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
| `offer` | sellable rate plan, versioned as a whole | logicalKey (idx), revision, sourceKey (unique `<logicalKey>:<rev>`), priceBookId (idx), productId (idx), productVersionId, name, currency, active, quoteEligible, unsupportedReason, provider provenance, componentCount, sourceFingerprint |
| `price-component` | immutable price component of an offer | offerId (idx), sourceKey (unique), componentKey, label, position, chargeType one_time/recurring, pricingModel flat_fee/per_unit/volume/graduated, interval month/year, intervalCount, unitAmountCents, flatAmountCents, currency, provider, externalPriceId, sourcePricingModel, tierCount |
| `price-tier` | immutable tier band | componentId (idx), sourceKey (unique), position, upToQuantity (null = open-ended), unitAmountCents, flatAmountCents |
| `catalog-sync-run` | one sync execution | provider identity/fingerprint, sourceRef, counts (productsCreated, versionsCreated, entriesCreated, entriesRevised, unchanged, deactivated), startedAt/completedAt, status |
| `quote` | draft + lifecycle state | opportunityId (idx), priceBookId, currency, status draft/pending_approval/approved/rejected (default draft), draftRevision, currentVersionId/Number, currentApprovalId, totalsJson (grouped), oneTimeNetCents, recurringGroupCount |
| `quote-line` | controlled draft line | quoteId (idx), offerId + offerLogicalKey/offerRevision/offerName (pinned), productId/productVersionId, sku, quantity, discountBps, componentCount, breakdownJson (server-calculated component + tier breakdown), list/discount/net amounts, removed, position |
| `quote-version` | immutable submitted snapshot | quoteId (idx), versionNumber, sourceKey (unique `qv:<quote>:<n>` — DB-enforced monotonic), opportunityId, priceBookId, currency, draftRevisionUsed, totals, maxLineDiscountBps, effectiveDiscountBps, policy/policyVersion/policyFingerprint, policyDecision, decisionReason, requiredApprovalKey, approvalId, submittedAt/By |
| `quote-version-line` | immutable line snapshot | versionId (idx), offer id/logicalKey/revision/name, product/version/sku, quantity, discountBps, componentCount, list/discount/net amounts, position |
| `quote-version-component` | immutable per-component evidence | versionId (idx), versionLineId (idx), componentId/Key, label, chargeType, pricingModel, interval/intervalCount, quantity, unit/flat amounts, tiersJson (schedule snapshot), tierBreakdownJson, list/discount/net amounts, provider provenance |
| `quote-version-total` | immutable grouped total | versionId (idx), kind one_time/recurring, currency, interval, intervalCount, list/discount/net amounts |
| `quote-approval` | one human decision per version | quoteId (idx), quoteVersionId, sourceKey (unique `qa:<versionId>`), policy identity/fingerprint, discount evidence, requiredApprovalKey, status pending/approved/rejected (default pending), reason, decisionReason, requestedBy/At, decidedBy/At |

Approval note: the core Approval domain is renewal/opportunity-specific (its table has a NOT NULL opportunity FK); rather than migrating it, `quote-approval` is a dedicated read-only record + `approve`/`reject` actions enforcing the **same human-actor boundary** (`actor.type === 'user'`, agent actors rejected) the core workflow proves. A generalized approval domain is future work; `requiredApprovalKey` is a **label**, not enforced security — real Sales-Manager/Finance roles need the Production Spine.

## Money and discounts (documented contract)

Amounts are safe integers in 1/100 currency units (ADR-014's non-ISO contract, unchanged). Currencies are uppercase `[A-Z]{3}`; a Quote uses exactly one Price Book and one currency; no conversion. Discounts are integer basis points 0–10000. Rounding policy, exact: each component's list amount is computed per its pricing model with integer arithmetic only (flat once; per-unit × quantity; volume = reached tier × whole quantity + that tier's flat once; graduated = each band + each receiving band's flat once); `componentDiscount = trunc(componentList × bps ÷ 10000)` truncating, so a discount never rounds up; `componentNet = componentList − componentDiscount` is **authoritative**; line and grouped totals are checked sums. Totals are grouped as one one-time total plus one per `(currency, interval, intervalCount)` — unlike periods are never summed and ARR/MRR/TCV are not derived. Every price and total is server-derived; clients never submit amounts, tiers or totals.

## Catalog sync semantics

`app.syncCatalog({provider, input?, actor})` (+ `POST /api/catalog/sync` on the local-dev server): validate provider → `fetchCatalog` OUTSIDE any transaction under the M9 timeout/late-settlement discipline → validate + normalize (bounded strings, safe integers, canonical currency, unique source keys) → one `BEGIN IMMEDIATE` transaction reconciling by DB-unique source keys: new identities created; changed commercial data creates a **new immutable Product Version / whole-Offer revision with fresh component and tier rows** (change detected by declared source fingerprint); unchanged identities produce **no** writes/audits/events; provider-managed deactivation only under the provider's declared `deactivateMissing` config; a CatalogSyncRun records identity, counts and trace; partial failure rolls back everything. Same-input re-sync is idempotent; concurrent syncs serialize on the write lock with unique-key backstops. Historical versions/revisions and quoted evidence are never overwritten. Internal (non-provider) catalog data follows the same createManaged path via a code-first internal source definition in the starter.

## Quote lifecycle

`opportunity.create-quote` (opportunity is action-eligible core) validates the Price Book and stamps the Quote's currency. Draft editing via `quote.add-line` / `update-line` / `remove-line` (soft remove): draft-only (fromStates), entry must be active + in the quote's Price Book + currency-matched, snapshots and amounts computed server-side, every change recalculates totals and increments `draftRevision`; optional `expectedRevision` gives optimistic concurrency (`409 STALE_REVISION`). `quote.submit` (draft, ≥1 active line): snapshots version + lines immutably (version number DB-monotonic via unique key), evaluates the declared discount policy (frozen context/config, synchronous bounded result `auto_approve|approval_required|reject`), then atomically: auto_approve → `approved` (no fake approval record); approval_required → `quote-approval` (pending) + `pending_approval`; reject → `rejected` with the reason. `quote.approve`/`quote.reject` (pending_approval only): **user actors only** (agent → 403), decision + quote update + audit + events in one transaction, one decision per version (unique approval key + status check), repeats → stable 409. `quote.revise` (rejected only) → back to draft with lines intact; next submit is version n+1; approved is terminal in M10. Concurrent submits/decisions: one winner via revision checks + DB uniqueness; losers get stable 409s.

## Out of scope (deliberate)

Signature, envelopes, signed artifacts, Order/Order Lines, taxes, FX, ISO exponents, metered/usage-based rating, overage, proration, ramps, minimum commitments, attribute-based pricing, bundles, PDF, payment, billing, real Stripe/Zuora/ERP adapters or credentials (future provider packages documented only), secure role enforcement, auth/tenancy/RBAC, Delivery/Service, Analytics, PostgreSQL, Cloud, remote MCP, telemetry.

## Verification plan

`tests/commercial-contract.test.js` (provider/policy validation + fingerprints, money/discount arithmetic matrix incl. overflow/unsafe/fraction/string, policy-result validation) and `tests/commercial-e2e.test.js` (temp-project: sync/idempotency/change-versioning, full quote flow over HTTP/SDK, auto-approve + human approval + agent-actor rejection + reject/revise/version-2, immutability + CRUD bypass matrix, stale revisions, concurrent submit/decision, provider failure/timeout with no partial catalog, policy drift stops boot, restart). Starter `install.mjs` extended with the deterministic SaaS catalog and both approval paths. Admin: a focused Quote view over the override seam + fake-DOM tests + Chromium step.

## Corrected in the adversarial review

**The pricing model was wrong and was rebuilt (mandatory product correction).** The original plan modelled one sellable `PriceBookEntry` with a single unit price plus `pricingMode one_time|recurring` — it could not express a real offer (setup fee + monthly platform fee + tiered seats), and would have forced Stripe/Zuora catalogs to be flattened into one price. Corrected shape:

```text
Product → ProductVersion → Offer (rate plan) → PriceComponent(s) → Tier(s)
```

1. **Composite offers** — `price-book-entry` is replaced by `offer` + `price-component` + `price-tier`. A component declares chargeType (`one_time`/`recurring`), pricingModel (`flat_fee`/`per_unit`/`volume`/`graduated`), interval/intervalCount, amounts, an ordered tier schedule and provider provenance (external product/offer/price ids, `sourcePricingModel`). One quote line selects one Offer + a quantity.
2. **Tier engine** — `computeComponentAmount` implements volume (whole quantity at the reached tier) and graduated (each band priced) with a deterministic tier breakdown; schedules validate strictly increasing inclusive `upTo`, exactly one open-ended final tier, non-negative safe integers, ≤50 tiers. Boundary behavior is tested at 1/10/11/20/100/101.
3. **Quantity semantics** — flat fees are charged ONCE per line (never multiplied by quantity); per-unit multiplies; tiered models use the schedule. Documented in the ADR, the guide, the schema and the Admin.
4. **Grouped totals** — quotes and versions persist one one-time total plus one per `(currency, interval, intervalCount)`. Unlike periods are never summed; ARR/MRR/TCV are deliberately not derived.
5. **Unsupported models fail closed** — metered/usage and friends persist as `quoteEligible: false` + `unsupportedReason` with **no component rows invented**, and quoting is `409 OFFER_NOT_QUOTE_ELIGIBLE`.
6. **Offer-level versioning** — an offer is fingerprinted as a whole (name, eligibility, every component and tier); any change creates a new immutable revision with fresh component/tier rows and deactivates the prior one. Draft lines re-price only from their pinned revision.
7. **Richer version evidence** — `quote-version-component` (component definition + tier schedule + tier breakdown + provenance) and `quote-version-total` (per-period groups) join `quote-version-line`, so a historical decision is reproducible after any catalog change (proven: a tier-boundary + price change leaves the version byte-identical while new drafts price at the new revision).
8. **Product identity hardening** — a provider changing a product's `externalId` under the same source key is a `409 SYNC_CONFLICT` rather than a silent re-parent; duplicate external product ids in one payload are `PROVIDER_INVALID`.
9. **Admin** — the quote builder now browses quote-eligible offers, shows each component with its recurrence and tier bands, and displays grouped period totals with the no-grand-total disclosure.
