# Contract activation and subscriptions (Milestone 12, ADR-018 addendum)

Turning a signed immutable Order into a live commercial state: one Commercial
Contract, its immutable version, one Contract Line per Order Component, a
Subscription with its lines, and explicit **pending** delivery and service
obligations.

**Two limitations before anything else**, because both were found by the
adversarial review and both change what this milestone may claim:

1. **The term is not signed.** The signed document package carries priced
   lines, parties and signers — no term, no renewal clause, no notice period.
   Everything M12 records about dates is **operational activation metadata**
   (`termsSource: "post-signature-operational-activation"`), entered by a human
   after signature with a required reason. This is not a signed commercial
   agreement end to end, and nothing here says it is.
2. **Nothing is active before it starts, and nothing starts it.** A term
   beginning in the future produces a `scheduled` contract and subscription
   that stay scheduled forever: there is no scheduler in this framework.

**No billing exists.** No invoicing, payment, usage rating, proration, ramp,
tax, FX, revenue recognition, MRR/ARR/TCV, amendment, seat change, renewal,
cancellation, delivery execution, service activation, entitlement or SLA. A
Subscription here is a *commercial activation record* — what was sold as a
recurring right, per period, exactly as signed — and nothing consumes it yet.

This is also the first domain built **outside `packages/core`**: everything
below lives in `packages/contracts/` and is optional. Remove the single static
import in `packages/domains/generated/index.js` and the domain disappears —
the kernel, the API, the SDK and every earlier milestone behave identically.

## The flow

```text
signed immutable Order (M11)
→ plan-activation       read-only: what activation WOULD create. Writes nothing.
→ classify              an explicit, versioned policy decision per component
→ resolve ambiguity     a human override, with a reason — activation is blocked until then
→ activate-contract     ONE transaction: contract + version + lines + subscription
                        + subscription lines + delivery/service obligations
→ inspect               contract / version / lines / subscription / obligations / audit / trace
```

```js
// read-only; safe for an agent to prepare
const { plan } = (await client.module('order').action(orderId, 'plan-activation', {
  policy: 'b2b-saas-order-activation',
  policyVersion: 1,
})).result;

// the human decision (an agent actor is refused 403 HUMAN_APPROVAL_REQUIRED)
await client.module('order').action(orderId, 'activate-contract', {
  policy: 'b2b-saas-order-activation',
  policyVersion: 1,
  effectiveDate: '2026-09-01',
  termStartDate: '2026-09-01',
  termEndDate: '2027-08-31',      // inclusive
  autoRenew: true,                 // recorded only — no scheduler exists
  renewalNoticeDays: 30,           // recorded only
  classificationOverrides: [
    { orderComponentId, type: 'subscription', reason: 'storage is sold as a recurring right' },
  ],
});
```

The Admin adds a **Contract activation** section under an order
(`#/quotes/<id>`): plan, the classification of every component with its reason,
an ambiguity highlighted with an override editor, calendar term inputs, one
activation control — and after activation, evidence only.

## Recurrence is not a classification

The temptation is to say *recurring → subscription, one-time → delivery*. It is
wrong, and wrong in a way that silently mis-files real money:

It is also not **one** question. Each component answers two independent ones:

| Component | Recurrence | Recurring right? | Owes beyond the money |
|---|---|---|---|
| Platform fee | recurring monthly | subscription line | nothing |
| Seats | recurring monthly | subscription line | nothing |
| Premium support | recurring annual | **subscription line** | **service obligation** |
| Onboarding | one-time | no | delivery obligation |
| Data migration | one-time | no | delivery obligation |
| API capacity | recurring monthly | **no** | nothing |

Annual support is why the second axis exists: it is recurring money *and*
future service work. A single exclusive label has to drop one of them, and the
first implementation dropped the subscription line — removing real recurring
money from the Subscription. So the policy returns two answers:

| Axis | Values | Creates |
|---|---|---|
| `commercialActivation` | `subscription` | a Subscription Line (and the Subscription, if it is the first) |
| | `non_subscription` | nothing — a recorded decision that this is not a recurring right |
| | `ambiguous` | **nothing**: blocks activation until a human decides this axis |
| `obligations` | `['delivery']` | a Delivery Obligation, status `pending_handover` |
| | `['service']` | a Service Obligation, status `pending_activation` |
| | `['delivery','service']` | both |
| | `[]` | nothing — a recorded decision that nothing further is owed |
| | `'ambiguous'` | **nothing**: blocks activation until a human decides this axis |

Every order component still becomes **exactly one** Contract Line, whatever the
two answers are, and no obligation type is ever created twice for one
component.

`ambiguous` is not a failure mode to be smoothed over. A policy that cannot
place a component says so, and the framework refuses to guess on a signed
commercial commitment. Note the difference from `[]`: an empty obligations list
is a decision, `'ambiguous'` is the absence of one.

The one coherence rule the domain enforces regardless of policy or override: a
**subscription line must recur**. Overriding a one-time charge into a
subscription is `409 CLASSIFICATION_INCOHERENT` — a one-time fee is not a
recurring right, and recording it as one would put a false amount into every
future recurring figure.

## The Order Activation Policy

```js
export const b2bSaasOrderActivationV1 = defineOrderActivationPolicy({
  name: 'b2b-saas-order-activation',
  version: 1,
  label: 'B2B SaaS order activation',
  config: { componentKeys: { 'support-fee': { commercial: 'subscription', obligations: ['service'] } } },
  classifyComponent({ component, line, order, config }) {
    // deterministic, synchronous, total — no clock, no network, no database
    return {
      commercialActivation: 'subscription',
      obligations: ['service'],
      reason: 'annual support is a recurring right and a future service obligation',
    };
  },
});
```

- **Explicit identity only.** The policy decides from the component key, the
  SKU and the offer identity the Order already recorded — never from label text
  and never from recurrence alone.
- **Deep-frozen input.** The context is a structural clone of the Order
  snapshot, deep-frozen; a policy cannot mutate what it is classifying, and it
  never sees the live catalog.
- **`config` is inside the fingerprint** (ADR-015). Thresholds and mappings
  held in a closure would be invisible to the declared-definition fingerprint,
  so they belong in `config`.
- **Versions are published, never edited.** Registering a changed source or
  config for an existing version stops the next boot. `v2` is how a decision
  changes; `v1`'s historical activation still explains itself.
- **Failing closed.** A policy that returns a Promise, an unknown type, an
  unbounded reason or that throws is `500 ACTIVATION_POLICY_INVALID`, and
  nothing is activated.

## Human overrides

An override decides **one axis of one component**:

```js
{ orderComponentId, dimension: 'commercial', value: 'subscription', reason: '…' }
{ orderComponentId, dimension: 'obligations', value: ['service'], reason: '…' }
```

It needs a bounded, non-blank `reason`; it may not select the ambiguity it is
meant to resolve; it may not target a component of another order
(`409 OVERRIDE_COMPONENT_UNKNOWN`); it may not repeat the same component and
dimension twice; and it may not contain control characters — SQLite ends a text
value at the first NUL byte, so accepting one would persist an audit reason
shorter than what the human wrote.

The contract line keeps **both** answers on **both** axes:
`policyCommercialActivation` / `commercialActivation` /
`commercialOverridden` / `commercialOverrideReason`, and
`policyObligationsJson` / `obligationsJson` / `obligationsOverridden` /
`obligationsOverrideReason`, plus `overriddenBy`. An activation is explainable
years later without re-running anything.

## Plan versus activate

| | `plan-activation` | `activate-contract` |
|---|---|---|
| Writes | nothing — no domain record, no business audit, no event | everything, in one transaction |
| Actor | any (agents included) | `actor.type === "user"`; an agent is `403 HUMAN_APPROVAL_REQUIRED` |
| Ambiguity | reported | refused (`409 CLASSIFICATION_AMBIGUOUS`) |
| Trust in the caller | — | none: the plan is recomputed inside the transaction from the Order |
| Client input | — | policy identity, three term dates, the term's reason, two recorded flags, overrides. Never an amount, product, tier or hash |

The activation never accepts an amount, a product, a tier or a source hash from
the client. Everything commercial is copied from the Order snapshot. The only
client inputs are the policy identity, the three term dates and their reason,
two recorded renewal flags, and human overrides.

A plan is **not** an authorization token: activation recomputes everything from
the Order inside the transaction, so a plan that was activatable a minute ago
(because it carried preview overrides, or ran against another policy version)
does not make an activation succeed unless the same decisions are supplied
again.

## Activation state

```text
termStartDate in the future   → scheduled   (and stays scheduled: no scheduler)
business date inside the term → active
term already ended            → refused, TERM_ALREADY_ENDED
```

The business date comes from the application clock, which is injectable
(`createAgentCrmApp({ clock })`) so a run is reproducible. The activation
instant is a UTC timestamp; the term stays date-only.

## The term (operational metadata, not a signed term)

Calendar dates, `YYYY-MM-DD`, validated by round-trip so `2026-02-30` and
`2026-13-01` are refused rather than normalized into a different day. No time,
no timezone, no inference: a contract term is a calendar fact, and inferring a
timezone would silently move a boundary.

- `termStartDate >= effectiveDate`, `termEndDate >= termStartDate`
- **`termEndDate` is inclusive** — `2026-09-01 → 2027-08-31` is 365 days
- term length bounded (10 years), `renewalNoticeDays` bounded (0–365)
- `autoRenew` is a strict boolean; `"true"` and `1` are refused
- a notice period **requires** `autoRenew`: a notice against a renewal that
  cannot happen is a clause that can never apply, so it is refused
- auto-renew and the notice period are **recorded only** — there is no
  scheduler in this framework, so nothing fires on them
- `termsReason` is required, and `termsSource` is stored on the contract, its
  version and the activation run: the term's provenance travels with it

## Source validation

Activation refuses anything it cannot prove, each with a stable code:

| Code | Meaning |
|---|---|
| `ORDER_NOT_ACTIVATABLE` | the order is not `accepted` |
| `ORDER_NOT_SIGNED` | no signature evidence, or the envelope is not `completed` |
| `SOURCE_INCOHERENT` | envelope, artifact and order do not belong together |
| `SOURCE_HASH_MISMATCH` | the three disagree on the signed document hash |
| `SOURCE_INCOMPLETE` | the order snapshot is missing lines, components or totals |
| `ORDER_ALREADY_ACTIVATED` | a contract already exists for this order |
| `TERM_ALREADY_ENDED` | the operational term ended before this activation |

## Atomicity, idempotency and immutability

- **One transaction.** The activation run, contract, version, lines,
  subscription, subscription lines and obligations commit together or not at
  all; a failure at any write leaves no partial contract, and the retry
  produces exactly one complete activation.
- **Identity is enforced by the database**, not by a check-then-write:
  `contract:order:<orderId>`, `contract-version:<contractId>:1`,
  `subscription:contract:<contractId>`, `contract-line:<versionId>:<componentId>`.
  Two concurrent activations — in one app or across two connections — produce
  exactly one contract.
- **The Order is never modified**: activation only sets its managed
  `contractId` / `activatedAt` link.
- **The contract reads independently.** Deactivate every offer, rewrite live
  component prices, publish a new catalog revision, rename the customer: the
  contract and its lines do not move, because every value was copied from the
  Order and the customer name came from the Order's own party snapshot.

## Records

All eight are read-only publicly (`get`/`list`; no `create`, no `update`, no
`delete` through the API, SDK, MCP or Admin) and exist only through the
activation action.

| Module | Notes |
|---|---|
| `contract-activation` | the audited run: who, when, from which order, with which policy version and fingerprint |
| `commercial-contract` | one per activated order, `contract:order:<orderId>` |
| `contract-version` | immutable, version 1 at activation, carries the copied grouped totals |
| `contract-line` | one per Order Component, with its classification evidence |
| `subscription` | one per contract in v1, created only if something recurs |
| `subscription-line` | one per component classified `subscription` |
| `delivery-obligation` | `pending_handover` — a recorded obligation, nothing executes it |
| `service-obligation` | `pending_activation` — a recorded obligation, nothing activates it |

## The domain package boundary

```text
packages/contracts/
  src/index.js             createContractsDomain() — the domain declaration
  src/activation.js        plan-activation and activate-contract
  src/activation-policy.js the policy contract, classification, overrides
  src/dates.js             calendar dates and the term
  modules/*.module.json    the eight record manifests
packages/domains/generated/index.js   the one static import that enables it
```

The kernel gained one generic seam (`packages/core/src/domain-registry.js`), one
generic input type (`boolean`) and an injectable application clock; it contains
no contract, subscription or obligation concept, and a test scans the core
sources and the static import graph to prove it. Schema
metadata is published additively under `/api/schema` → `domains.contracts`,
including each policy's fingerprint and the explicit `notModeled` list.

## Not modeled — stated, not implied

Billing, invoicing, payment, usage rating, proration, ramps, minimum
commitments, tax, FX, revenue recognition, MRR/ARR/TCV, amendments, seat
changes, renewal (there is no scheduler), cancellation, delivery execution,
partner assignment, time and expense, margin, change requests, customer
acceptance, service contracts, entitlements, SLA and support cases.

The Admin says so on the screen, the schema says so in `notModeled`, and the
plan payload says so in its own `notModeled` list.

## Evidence

`tests/contracts-contract.test.js`, `tests/contracts-activation-e2e.test.js`,
`tests/admin-contracts.test.js`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`packages/contracts/README.md`,
`docs/plans/milestone-12-order-activation-subscription.md`. Agent
instructions: `.claude/skills/build-contract-activation/SKILL.md` (this file is
the Codex-readable mirror).
