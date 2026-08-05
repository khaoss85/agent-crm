---
name: build-commercial-operations
description: Add or extend Commercial Operations in an Agent CRM project - catalog providers, products and price books, quotes with server-priced lines, immutable quote versions, and versioned discount policies with human approval. Use for catalog/quote/discount/CPQ work. Do not use for CRUD module changes (create-crm-module) or lead scoring/routing (build-lead-intelligence).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-016) and `docs/COMMERCIAL_OPERATIONS.md` first.

## Integrate a catalog provider

1. Define it code-first: `{ name, version, label, config, async fetchCatalog(input, ctx) }` returning `{ sourceRef?, priceBooks[], products[], offers[] }`. An **offer** is the sellable package: `{ sourceKey, priceBookSourceKey, productSourceKey, name, active, externalOfferId?, components[] }`. A **component** is `{ sourceKey, label, chargeType: 'one_time'|'recurring', pricingModel: 'flat_fee'|'per_unit'|'volume'|'graduated', interval?, intervalCount?, unitAmountCents? (per_unit), flatAmountCents? (flat_fee), tiers? (volume/graduated), externalPriceId?, sourcePricingModel? }`. Tiers are ordered `{ upTo (inclusive, null on the final open-ended tier), unitAmountCents, flatAmountCents? }`. Out-of-contract output is refused (`PROVIDER_INVALID`) — never loosen the normalizer.
2. **Never flatten a provider model.** Map Stripe one_time/recurring and `tiers_mode` volume/graduated, and Zuora one-time/recurring with Volume and Tiered/Cumulative pricing, onto the four supported models and keep `sourcePricingModel` + external ids. For anything unsupported (metered usage, overage, proration, ramps, minimums, attribute-based pricing), mark the component `unsupportedModel: '<name>'` — the offer persists `quoteEligible: false` with a reason and is refused for quoting. Approximating it as a flat price is a defect.
3. Register it in `packages/commercial/generated/index.js` (static import, like actions/pipelines/intelligence).
4. The provider is called **outside** the write transaction under a bounded timeout. Never add DB writes to a provider.
5. Sync is idempotent by source key + declared source fingerprint: unchanged data must produce no writes/audits/events; changed data must create a **new** product version or **whole-offer revision** (with fresh component and tier rows), never an in-place edit. Historical and quoted evidence is immutable.
6. Test failure paths with a deterministic fixture (outage → `PROVIDER_FAILED`, hang → `PROVIDER_TIMEOUT`, bad shapes → `PROVIDER_INVALID`): no partial catalog, honest failed trace.
7. Real Stripe/Zuora/ERP adapters need human-approved credentials and are out of scope until then; do not claim full Stripe or Zuora support.

## Build a price book and quote flow

1. Storage modules are **read-only publicly** (every field `writable: "managed"` → capabilities `get`/`list`, no public create/update). Never add a public write path to a commercial record; use the trusted `createManaged`/`applyManaged` from action code.
2. Every price and total is **server-derived** from catalog data. A client may send `offerId`, `quantity` and `discountBps` — never an amount, a tier or a total.
3. Use `computeComponentAmount`/`computeLineBreakdown`/`groupComponentTotals` from `packages/core/src/commercial-money.js`. Do not hand-roll money arithmetic and never use floating-point percentages. Respect quantity semantics: **flat fees are charged once per line**, per-unit multiplies, volume prices the whole quantity at the reached tier, graduated prices each band.
4. **Never combine unlike periods.** Persist and display the one-time total plus one total per `(currency, interval, intervalCount)`. Do not derive ARR/MRR/TCV — contract term is not modeled.
5. Guard draft edits with `expectedRevision` (optimistic concurrency) and gate every action with `fromStates`. A quote binds one price book and one currency; a mismatched, inactive, incomplete or quote-ineligible offer is refused. A draft line re-prices only from its pinned offer revision.
6. Never delete records: soft-remove draft lines.

## Create a discount policy version

1. `{ name, version, label, config, evaluate(context) }` — `evaluate` gets a deep-frozen context (totals, `maxLineDiscountBps`, `effectiveDiscountBps`, lines, opportunity evidence, actor, frozen `config`) and must return **synchronously** `{ decision: 'auto_approve'|'approval_required'|'reject', reason?, requiredApprovalKey?, matchedRule? }`. Promises, network calls, LLM calls and DB writes are forbidden.
2. **Declare every threshold in `config`.** The fingerprint is a *declared-definition* fingerprint: closure-held values are invisible to it. A closure threshold changes silently — put it in `config`.
3. **Never edit a registered version.** Changing rules or config = a NEW version registered alongside the old (the persisted fingerprint check stops the app). Rollback = publish a new version derived from an earlier one.
4. Test both branches end to end: a low discount auto-approves with no approval record; a high discount creates exactly one approval and parks the quote in `pending_approval`.

## Human approval boundary

Only `actor.type === 'user'` may approve or reject (agent actors get `403 HUMAN_APPROVAL_REQUIRED`), one decision per version, decision + quote lifecycle committed atomically. `requiredApprovalKey` is a **label** — never claim Sales-Manager or Finance role enforcement before the Production Spine (auth, tenancy, RBAC).

## Do not implement here

Signature, envelopes, signed artifacts, Orders, taxes, currency conversion, ISO exponent handling, metered usage, overage, proration, ramps, minimum commitments, attribute-based pricing, quote PDFs, payment, billing — Signature and Order are Milestone 11; the rest is later CPQ work. Volume and graduated tiering ARE supported (M10); usage-based rating is not.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
