---
name: build-commercial-operations
description: Add or extend Commercial Operations in an Agent CRM project - catalog providers, products and price books, quotes with server-priced lines, immutable quote versions, and versioned discount policies with human approval. Use for catalog/quote/discount/CPQ work. Do not use for CRUD module changes (create-crm-module) or lead scoring/routing (build-lead-intelligence).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-016) and `docs/COMMERCIAL_OPERATIONS.md` first.

## Integrate a catalog provider

1. Define it code-first: `{ name, version, label, config, async fetchCatalog(input, ctx) }` returning `{ sourceRef?, priceBooks[], products[], entries[] }` with canonical `sourceKey`s, uppercase `[A-Z]{3}` currencies, safe-integer `unitAmountCents`, `pricingMode: 'one_time'|'recurring'` (+ `recurringInterval` when recurring). Out-of-contract output is refused (`PROVIDER_INVALID`) — never loosen the normalizer.
2. Register it in `packages/commercial/generated/index.js` (static import, like actions/pipelines/intelligence).
3. The provider is called **outside** the write transaction under a bounded timeout. Never add DB writes to a provider.
4. Sync is idempotent by source key + declared source fingerprint: unchanged data must produce no writes/audits/events; changed data must create a **new** product version or entry revision, never an in-place edit. Historical and quoted evidence is immutable.
5. Test failure paths with a deterministic fixture (outage → `PROVIDER_FAILED`, hang → `PROVIDER_TIMEOUT`, bad shapes → `PROVIDER_INVALID`): no partial catalog, honest failed trace.
6. Real Stripe/Zuora/ERP adapters need human-approved credentials and are out of scope until then.

## Build a price book and quote flow

1. Storage modules are **read-only publicly** (every field `writable: "managed"` → capabilities `get`/`list`, no public create/update). Never add a public write path to a commercial record; use the trusted `createManaged`/`applyManaged` from action code.
2. Every price and total is **server-derived** from catalog data. A client may send `priceBookEntryId`, `quantity` and `discountBps` — never an amount.
3. Use `computeLineAmounts`/`computeQuoteTotals` from `packages/core/src/commercial-money.js`. Do not hand-roll money arithmetic and never use floating-point percentages: discounts are integer basis points, `lineTotal = subtotal − trunc(subtotal × bps ÷ 10000)`.
4. Guard draft edits with `expectedRevision` (optimistic concurrency) and gate every action with `fromStates`. A quote binds one price book and one currency; a mismatched or inactive entry is refused.
5. Never delete records: soft-remove draft lines.

## Create a discount policy version

1. `{ name, version, label, config, evaluate(context) }` — `evaluate` gets a deep-frozen context (totals, `maxLineDiscountBps`, `effectiveDiscountBps`, lines, opportunity evidence, actor, frozen `config`) and must return **synchronously** `{ decision: 'auto_approve'|'approval_required'|'reject', reason?, requiredApprovalKey?, matchedRule? }`. Promises, network calls, LLM calls and DB writes are forbidden.
2. **Declare every threshold in `config`.** The fingerprint is a *declared-definition* fingerprint: closure-held values are invisible to it. A closure threshold changes silently — put it in `config`.
3. **Never edit a registered version.** Changing rules or config = a NEW version registered alongside the old (the persisted fingerprint check stops the app). Rollback = publish a new version derived from an earlier one.
4. Test both branches end to end: a low discount auto-approves with no approval record; a high discount creates exactly one approval and parks the quote in `pending_approval`.

## Human approval boundary

Only `actor.type === 'user'` may approve or reject (agent actors get `403 HUMAN_APPROVAL_REQUIRED`), one decision per version, decision + quote lifecycle committed atomically. `requiredApprovalKey` is a **label** — never claim Sales-Manager or Finance role enforcement before the Production Spine (auth, tenancy, RBAC).

## Do not implement here

Signature, envelopes, signed artifacts, Orders, taxes, currency conversion, ISO exponent handling, usage/tiered pricing, proration, ramps, bundles, quote PDFs, payment, billing — Signature and Order are Milestone 11; the rest is later CPQ work.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
