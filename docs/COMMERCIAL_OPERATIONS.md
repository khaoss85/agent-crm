# Commercial Operations (Milestone 10, ADR-016)

Catalog, quotes and discount approval over the B2B starter — local development
slice. **Signature and Order are Milestone 11 and are not implemented here**;
no taxes, currency conversion, usage/tiered pricing, proration, ramps, bundles,
PDFs, payment or billing.

## The flow

```text
define/sync catalog     provider call OUTSIDE the transaction → immutable products, versions, price books, entries
→ create Quote          one opportunity, one price book, one currency
→ add lines             server-priced from the catalog; basis-point discounts
→ submit                immutable Quote Version + version lines
→ evaluate policy       versioned discount policy → auto_approve | approval_required | reject
→ approve/reject        human user actor only; one decision per version
→ revise                rejected → draft → submit version 2
→ inspect               versions / approval / audit / trace
```

```js
await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });      // or POST /api/catalog/sync

const quotes = client.module('quote');
const { result } = await client.request(
  `/api/modules/opportunity/records/${opportunityId}/actions/create-quote`,
  { method: 'POST', body: JSON.stringify({ priceBookId }) },
);
await quotes.action(result.quote.id, 'add-line', { priceBookEntryId, quantity: 10, discountBps: 500, expectedRevision: 1 });
await quotes.action(result.quote.id, 'submit',   { policy: 'standard-sales-discount', version: 1, expectedRevision: 2 });
await quotes.action(result.quote.id, 'approve',  {});   // requires actor.type === 'user'
```

The Admin adds a **Quotes** view (`#/quotes`, `#/quotes/<id>`) for browsing a
price book, editing draft lines, submitting and deciding — every amount is
server-calculated and every mutation is the same server action.

## Records (all read-only publicly)

`product`, `product-version`, `price-book`, `price-book-entry`,
`catalog-sync-run`, `quote`, `quote-line`, `quote-version`,
`quote-version-line`, `quote-approval` — capabilities `get`/`list` only. No
public create or update exists on any of them: records are produced solely by
catalog sync and the quote actions through the trusted in-process
`createManaged`/`applyManaged` path, so no client can forge a price, a total or
a version. Correctness reads use exact `listWhere`/`countWhere` over
manifest-declared indexes, never a paged scan.

## Money and discounts

Amounts are **safe integers in 1/100 currency units**, two decimals — the
ADR-014 contract, deliberately not ISO-4217 exponents. Currencies are uppercase
`[A-Z]{3}`; a quote binds one price book and one currency and there is **no
conversion**. Discounts are **integer basis points** 0–10000 (`1000` = 10.00%).

Rounding, exactly:

```text
lineSubtotal = listUnit × quantity                    (overflow-checked)
lineDiscount = trunc(lineSubtotal × bps ÷ 10000)      (never rounds up)
lineTotal    = lineSubtotal − lineDiscount            (authoritative)
netUnit      = trunc(listUnit × (10000 − bps) ÷ 10000) (informational)
effectiveDiscountBps = trunc(discountTotal × 10000 ÷ subtotal)
```

`netUnit × quantity` may differ from `lineTotal` by sub-cent truncation — the
line total is the number that counts. Any overflow is a refusal, never a
silently wrong number.

## Catalog identity and immutability

A **Product** is stable identity; a **ProductVersion** is an immutable
commercial description; a **PriceBookEntry** is an immutable priced revision.
Sync fingerprints each product's and entry's commercial data: unchanged →
nothing written (no fake audits/events); changed → a **new version/revision**
with the prior entry revision deactivated. Quoted evidence is never rewritten
by later catalog movement, and a superseded entry cannot be added to a new
draft (`409 ENTRY_INACTIVE`). Provider failures are stable
`PROVIDER_FAILED` / `PROVIDER_TIMEOUT` / `PROVIDER_INVALID` with **no partial
catalog state** and an honest failed trace. Provider-managed products missing
from a payload deactivate only under the provider's declared
`config.deactivateMissing`.

Future provider packages may target Stripe Products/Prices, Zuora, ERP or
custom CPQ APIs. **No real adapter or credential ships in this milestone** —
the starter's deterministic fixture provider proves the contract offline.

## Discount policy and approval

Policies are code-first, versioned definitions with declared JSON-safe
`config` (thresholds live there, never in closures — the config is part of the
declared-definition fingerprint, so changing a threshold without publishing a
new version stops the boot). `evaluate` gets a deep-frozen context and returns
**synchronously** `auto_approve | approval_required | reject` with bounded
reason/approval-key/matched-rule metadata. The decision, policy name, version
and fingerprint are stored on the Quote Version, so historical quotes stay
explainable after a v2 ships.

`auto_approve` approves with **no approval record**; `approval_required`
creates exactly one approval per version and parks the quote in
`pending_approval`; `reject` marks it rejected with the policy reason.

**The human boundary:** only `actor.type === 'user'` may approve or reject — an
agent actor is refused `403 HUMAN_APPROVAL_REQUIRED`. `requiredApprovalKey`
(e.g. `sales-manager`) is a **label**, not enforced security: real
Sales-Manager/Finance role enforcement requires the Production Spine
(authentication, tenancy, RBAC — `docs/strategy/EXECUTION_ROADMAP.md` Phase 6).

## Lifecycle

```text
draft ──add/update/remove line──▶ draft ──submit──▶ pending_approval ──approve──▶ approved (terminal in M10)
                                                  └─reject──▶ rejected ──revise──▶ draft ──submit──▶ version 2
```

Every rule is server-enforced (`fromStates`), not UI-enforced. Draft edits are
optimistic-concurrency guarded by `expectedRevision` (`409 STALE_REVISION`);
version numbers are DB-monotonic so concurrent submits produce exactly one
version; one decision per version (`409 ALREADY_DECIDED`).

## Evidence

`tests/commercial-contract.test.js`, `tests/commercial-e2e.test.js`,
`tests/admin-quotes.test.js`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`docs/plans/milestone-10-commercial-operations.md`. Agent instructions:
`.claude/skills/build-commercial-operations/SKILL.md` (this file is the
Codex-readable mirror).
