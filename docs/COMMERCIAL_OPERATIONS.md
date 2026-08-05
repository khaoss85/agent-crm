# Commercial Operations (Milestone 10, ADR-016)

Catalog, quotes and discount approval over the B2B starter — local development
slice. **Signature and Order are Milestone 11 and are not implemented here**; no
taxes, currency conversion, metered usage, overage, proration, ramps, minimum
commitments, attribute-based pricing, PDFs, payment or billing. Volume and
graduated tiering ARE supported.

## The flow

```text
define/sync catalog     provider call OUTSIDE the transaction → immutable products, versions, price books, offers, components, tiers
→ create Quote          one opportunity, one price book, one currency
→ add lines             one Offer + a quantity; every component server-priced; basis-point discounts
→ submit                immutable Quote Version + version lines + per-component evidence + grouped totals
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
await quotes.action(result.quote.id, 'add-line', { offerId, quantity: 10, discountBps: 500, expectedRevision: 1 });
await quotes.action(result.quote.id, 'submit',   { policy: 'standard-sales-discount', version: 1, expectedRevision: 2 });
await quotes.action(result.quote.id, 'approve',  {});   // requires actor.type === 'user'
```

The Admin adds a **Quotes** view (`#/quotes`, `#/quotes/<id>`) for browsing a
price book, editing draft lines, submitting and deciding — every amount is
server-calculated and every mutation is the same server action.

## The pricing model

```text
Product → ProductVersion → Offer (rate plan) → PriceComponent(s) → Tier(s)
```

An **Offer** is the sellable package; it may carry several **PriceComponents**
mixing one-time and recurring charges. Each component declares:

```text
chargeType     one_time | recurring
pricingModel   flat_fee | per_unit | volume | graduated
interval       month | year        (null for one_time)
intervalCount  positive integer    (null for one_time)
tiers          ordered schedule    (volume/graduated only)
provenance     provider, providerVersion, externalProductId,
               externalOfferId, externalPriceId, sourcePricingModel,
               sourceFingerprint
```

A tier carries `upTo` (inclusive upper bound; `null` on the single final
open-ended tier), `unitAmountCents` and an explicit optional `flatAmountCents`.
Schedules must be strictly increasing and end open-ended, so they are gap-free
and overlap-free by construction.

Example composite offer — **one quote line, one quantity**:

```text
Enterprise Plan
  1. Setup and migration   one_time  + flat_fee   EUR 5,000.00
  2. Platform fee          recurring + flat_fee   EUR 2,000.00 / month
  3. Seats                 recurring + volume     1–20: EUR 50.00, 21–100: EUR 40.00, 101+: EUR 30.00 per seat/month
```

### Quantity semantics (explicit, never silent)

| Model | Line quantity behavior |
|---|---|
| `flat_fee` | charged **once** per line — quantity never multiplies it |
| `per_unit` | `unitAmount × quantity` |
| `volume` | the tier the **total** quantity reaches prices the **entire** quantity (+ that tier's flat amount once) |
| `graduated` | each band prices the quantity inside it (+ each receiving band's flat amount once) |

At 30 seats the example above bills setup once (not 30×), the platform fee
once per month, and 30 × EUR 40.00 for seats (the whole quantity at the
reached tier).

### Provider mapping

| Provider model | Normalized |
|---|---|
| Stripe one-time price | `one_time` |
| Stripe recurring price | `recurring` + interval/intervalCount |
| Stripe `tiers_mode: volume` | `volume` |
| Stripe `tiers_mode: graduated` | `graduated` |
| Zuora one-time charge | `one_time` |
| Zuora recurring charge | `recurring` |
| Zuora Volume Pricing | `volume` |
| Zuora Tiered/Cumulative Pricing | `graduated` |
| Stripe metered / Zuora usage | **unsupported** → `quoteEligible: false` |

`sourcePricingModel` and the external ids keep provider provenance intact.
**No real Stripe/Zuora/ERP adapter or credential ships** — a deterministic
fixture provider proves the contract offline, and full Stripe or Zuora support
is not claimed.

### Unsupported models fail closed

Metered usage, overage, proration, ramp deals, minimum commitments,
attribute-based/dynamic pricing, tax-inclusive computation, FX and custom
provider formulas are **never approximated as flat prices**. The offer is
stored with `quoteEligible: false` and a bounded `unsupportedReason`, no
component rows are invented for it, and quoting it is a stable
`409 OFFER_NOT_QUOTE_ELIGIBLE`.

## Records (all read-only publicly)

`product`, `product-version`, `price-book`, `offer`, `price-component`,
`price-tier`, `catalog-sync-run`, `quote`, `quote-line`, `quote-version`,
`quote-version-line`, `quote-version-component`, `quote-version-total`,
`quote-approval` — capabilities `get`/`list` only. No
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
componentList     = per pricing model (integer arithmetic, overflow-checked)
componentDiscount = trunc(componentList × bps ÷ 10000)   (never rounds up)
componentNet      = componentList − componentDiscount    (authoritative)
line/group totals = checked sums of component amounts
```

The line's basis-point discount applies **uniformly to every component of that
line, after tier/list calculation**; each component keeps its own list,
discount and net amounts. Any overflow is a refusal, never a silently wrong
number.

### Totals are grouped — there is no grand total

A quote and every quote version persist **one one-time total plus one total per
`(currency, interval, intervalCount)`**:

```json
{
  "oneTimeTotal": { "currency": "EUR", "netAmountCents": 500000 },
  "recurringTotals": [
    { "currency": "EUR", "interval": "month", "intervalCount": 1, "netAmountCents": 280000 },
    { "currency": "EUR", "interval": "year",  "intervalCount": 1, "netAmountCents": 1000000 }
  ]
}
```

Unlike periods are never summed. **ARR, MRR and TCV are deliberately not
derived** — contract term and normalization policy are not modeled.

## Catalog identity and immutability

A **Product** is stable identity; a **ProductVersion** is an immutable
commercial description; an **Offer is versioned as a whole** — its name,
eligibility, every component and every tier are fingerprinted together, so any
pricing change creates a **new immutable offer revision** with fresh component
and tier rows while the prior revision is deactivated. Unchanged data writes
nothing (no fake audits/events). Quoted evidence is never rewritten by later
catalog movement, and a superseded revision cannot be added to a new draft
(`409 OFFER_INACTIVE`). A draft line always re-prices from its **pinned** offer
revision. Provider failures are stable
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

## What a Quote Version snapshots

Everything needed to reproduce the commercial decision after any catalog
change: offer identity + revision, product version, every component definition
(charge type, pricing model, recurrence, amounts), the complete tier schedule,
the calculated tier breakdown, quantity, list/discount/net per component,
provider provenance, and one grouped-total row per period. Proven: a provider
tier-boundary and price change creates new offer revisions while every existing
Quote Version stays byte-identical, and new drafts price at the new revision.

## Evidence

`tests/commercial-contract.test.js`, `tests/commercial-e2e.test.js`,
`tests/admin-quotes.test.js`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`docs/plans/milestone-10-commercial-operations.md`. Agent instructions:
`.claude/skills/build-commercial-operations/SKILL.md` (this file is the
Codex-readable mirror).
