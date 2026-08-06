# ExecPlan (draft) — Milestone 12: Order Activation & Subscription v1

**Status: design only. Nothing is implemented.** This plan is written at the
Platform Alignment Gate so the next implementation task starts from a decided
architecture instead of an empty file. It is ready to be executed *after* the
alignment PR is reviewed and merged.

Context: `CONTRACT_SUBSCRIPTION_RENEWAL.md` (the domain), ADR-018 (where the
code lives), `PLATFORM_CAPABILITIES.md` (which guarantees it reuses),
`EXECUTION_ROADMAP.md` (M12 in sequence).

## Outcome

```text
immutable Order (M11)
→ activate CommercialContract
→ create Subscription
→ create SubscriptionLines from the recurring Order Components
→ create the initial SubscriptionTerm
→ create basic Entitlements
→ preserve complete source links
   with idempotency, concurrency safety, audit and trace
```

One command turns a signed commercial fact into a live commercial state, and
every number in that state is traceable to the Order that was signed.

## Three architectures compared

**1. Generated modules only.** Declare `commercial-contract`, `subscription`,
`subscription-line`, `subscription-term` and `entitlement` as read-only managed
manifests in the starter, and drive them from an action registered on `order`.
Cheapest, uses only proven capabilities — and it puts the activation semantics
(what maps to what, what idempotency means, what an amendment is) into starter
code that every project would copy and diverge from. Fine for a prototype,
wrong for a domain that must behave identically everywhere. **Rejected as the
whole answer**, though the storage modules genuinely are generated manifests.

**2. A monolithic subscription core.** Put the primitives and the activation
logic into `packages/core/src/subscription-*.js`, next to the commercial and
signature files. Consistent with how M9–M11 were built — and directly against
ADR-018's core budget rule, adopted precisely to stop this. It would also make
subscriptions non-optional for projects that only want lead management.
**Rejected.**

**3. An optional domain package on shared capabilities (chosen).** A
`subscription` domain package owning its manifests, its activation action, its
policies and its skill, built on the runtime contracts the core already
exposes: read-only evidence modules, managed fields, the record-action runtime,
immutable artifacts, deterministic source keys, audit/event/trace. It is the
**first package built under ADR-018** and therefore also the test of whether
the runtime contracts are genuinely sufficient — if M12 cannot be built without
touching core, that is a finding about the runtime, and it belongs in ADR-018's
capability list rather than being smuggled into core.

## Intended slice

**Records** (all read-only publicly, every field managed):

| Module | Notes |
|---|---|
| `commercial-contract` | one per activated Order; `sourceKey = contract:order:<orderId>` (DB-unique) |
| `contract-version` | immutable; version 1 at activation |
| `subscription` | one per contract in v1; multiple later |
| `subscription-line` | one per **recurring** Order Component, with its full provenance chain |
| `subscription-term` | start, end, duration, auto-renew flag, notice period |
| `entitlement` | derived from declared component→entitlement mapping |
| `activation` | the audited event: who, when, from which Order, with which policy version |

**Action:** `order.activate` — an ordinary record action (no external call, so
**no** external-operation contract needed), gated `fromStates` on the Order's
terminal `accepted` status, requiring a human user actor for the activation
decision, and idempotent on `contract:order:<orderId>`.

**Term policy:** a code-first versioned definition (the ADR-015 mechanism)
computing the initial term from declared inputs — never a hardcoded twelve
months, and never a client-supplied date.

**Entitlement mapping:** declared per offer/component in the catalog fixture,
resolved from the **Order snapshot**, never from the live catalog.

## Guarantees to prove

1. **Idempotent activation** — N invocations produce exactly one contract, one subscription and one line set.
2. **Copy, never recompute** — every amount comes from the Order snapshot; a catalog change afterwards alters nothing.
3. **Order immutability** — the Order and its rows are byte-identical after activation; only a managed link is added.
4. **Complete provenance** — every subscription line names its order line, order component, quote version, offer revision and product version.
5. **Only recurring components become lines** — one-time components are recorded as future delivery scope and are never billed as recurring.
6. **Read-only surface** — all seven modules 404 on `POST`/`PATCH`.
7. **Concurrency** — two activations in parallel, and two app instances, produce one result.
8. **Fault injection** — a failure at any write rolls the whole activation back, and the retry produces exactly one complete activation.
9. **Exact reads** — indexed lookups by order id, contract id and subscription id, proven past the list bound.
10. **Audit/event/trace exactness** — asserted counts, and a repeat activation adds none.

## Explicitly deferred

Invoicing, billing runs, payment, usage rating, proration, tax, FX, revenue
recognition, dunning; the **renewal scheduler** (needs `JOBS_AND_OUTBOX.md` —
without it nothing can fire on a future date); cancellation and refunds;
amendments beyond recording the initial state; MRR/ARR/TCV (they need a term
policy *and* a stated normalization policy — see
`CONTRACT_SUBSCRIPTION_RENEWAL.md`); the Delivery Project (M13); real tenant and
user permissions.

M12 is activation. Renewal is what M12 makes *possible*, not what it delivers.

## Open questions for the implementation task

1. Does the domain package need any runtime capability that does not exist? If yes, it is an ADR-018 addendum, not a core patch.
2. One subscription per contract in v1, or several from the start? (Leaning: one, with the schema shaped for several.)
3. Where does the component→entitlement mapping live — catalog fixture, offer metadata, or a separate versioned policy? (Leaning: a versioned policy, so it is explainable after it changes.)
4. Is activation automatic on Order creation, or an explicit human step? (Leaning: explicit, consistent with every other consequential transition in the framework.)

## Definition of done

The M12 PR is complete only after the sequence in `docs/QUALITY_GATES.md` §5:
implementation → adversarial review (`.claude/skills/adversarial-review/`) →
fixes with regression tests → clean-clone verification → CI green → human merge.
JTBD rows CS-01, CS-02 and CS-10 may move only with linked evidence; CS-05
(MRR/ARR/TCV) and CS-06/07 (renewal) stay **not supported**.
