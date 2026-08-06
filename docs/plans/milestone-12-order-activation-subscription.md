# ExecPlan — Milestone 12: Contract & Subscription Activation

**Status: implemented.** Delivered as the first domain package under ADR-018.
Guide: `docs/CONTRACT_ACTIVATION.md`. Decision: ADR-018 + its Milestone 12
addendum in `DECISIONS.md`. This file records what was planned, what shipped,
and where the two differ.

Context: `docs/strategy/CONTRACT_SUBSCRIPTION_RENEWAL.md` (the domain),
ADR-018 (where the code lives), `docs/strategy/PLATFORM_CAPABILITIES.md`
(which guarantees it reuses), `docs/strategy/EXECUTION_ROADMAP.md` (sequence).

## Outcome

```text
immutable Order (M11)
→ plan-activation (read-only)
→ explicit, versioned classification of every Order Component
→ human resolution of anything the policy refused to guess
→ activate-contract  →  CommercialContract + ContractVersion + ContractLines
                        + Subscription + SubscriptionLines
                        + pending Delivery/Service Obligations
   in one transaction, with idempotency, concurrency safety, audit and trace
```

One human decision turns a signed commercial fact into a live commercial
state, and every number in that state is traceable to the Order that was
signed.

## Architecture chosen (unchanged from the draft)

**An optional domain package on shared runtime capabilities.** Not generated
modules alone (activation semantics would be copied into every starter and
diverge), and not `packages/core/src/subscription-*.js` (directly against
ADR-018's core budget rule, and it would make subscriptions non-optional).

The milestone was therefore also the *test* of ADR-018: could a whole domain be
built without adding a domain concept to core? It could, and it needed exactly
two generic runtime additions — the domain registry seam and a strict `boolean`
action input type. Both are recorded in the ADR-018 addendum; neither names a
domain.

## What shipped, and how it differs from the draft

| Draft | Shipped | Why |
|---|---|---|
| package named `subscription` | `packages/contracts/` | the aggregate is the contract; the subscription is one of its consequences |
| `subscription-term` module | term fields on the contract and its version | a term with no scheduler is state, not an entity; an entity would imply a lifecycle that does not exist |
| `entitlement` module | **dropped** | entitlements belong to Service (M15); modelling them here would have been an unused abstraction |
| "only recurring components become subscription lines" | an explicit versioned **Order Activation Policy** with five outcomes | recurrence is not a classification: annual support recurs but is a service obligation; a recurring API charge may create no obligation at all |
| one action `order.activate` | `order.plan-activation` + `order.activate-contract` | an agent must be able to prepare the decision without being able to commit it |
| term computed by a term policy | three calendar dates supplied by the human, validated | inventing a term from a policy is a business rule no framework should guess; the dates are the human's decision |
| — (not in the draft) | `ambiguous` blocks activation until a human overrides with a reason | the alternative is guessing on a signed commercial commitment |

The draft's four open questions, answered by the implementation: (1) two
generic runtime capabilities were needed, and they are an ADR addendum rather
than a core patch; (2) one subscription per contract, with the schema shaped
for several; (3) classification lives in a versioned policy, not in the catalog
fixture; (4) activation is an explicit human step.

## Records

All read-only publicly, every field managed, created only by the activation
action.

| Module | Notes |
|---|---|
| `contract-activation` | the audited run: actor, time, source order, policy version and fingerprint, per-component decisions |
| `commercial-contract` | one per activated Order; `contract:order:<orderId>` (DB-unique) |
| `contract-version` | immutable; version 1 at activation; copied grouped totals |
| `contract-line` | one per Order Component, with classification evidence and override provenance |
| `subscription` | one per contract in v1; created only when something recurs |
| `subscription-line` | one per component classified `subscription` |
| `delivery-obligation` | `pending_handover` — recorded, never executed |
| `service-obligation` | `pending_activation` — recorded, never activated |

## Guarantees proven

1. **Idempotent activation** — repeated, concurrent in one app, concurrent across two connections, and after a restart: exactly one contract, one subscription, one line set. Identity is DB-enforced, not check-then-write.
2. **Copy, never recompute** — every amount comes from the Order snapshot; deactivating offers, rewriting live prices and publishing a new catalog revision change nothing.
3. **Order immutability** — the Order and its rows are unchanged after activation; only its managed `contractId` / `activatedAt` link is set.
4. **Complete provenance** — every contract and subscription line names its order line, order component, offer revision, product version and the policy version that classified it.
5. **Classification is explicit** — five outcomes, a reason on every line, both the policy decision and the human override retained; a one-time charge can never become a subscription line.
6. **Ambiguity blocks** — activation refuses until a human decides, with a bounded non-blank reason, as a user actor.
7. **Human-only activation** — an agent actor is `403 HUMAN_APPROVAL_REQUIRED`, in the action and in the Admin.
8. **Atomicity** — fault injection at every write rolls the whole activation back; the retry produces exactly one complete activation.
9. **Read-only surface** — all eight modules expose only `get`/`list`.
10. **Exact reads past the list bound** — indexed lookups by order, contract and subscription id proven beyond 500 records.
11. **Audit/event/trace exactness** — asserted counts; planning writes none of the three's business records; a refused activation records an honest failed trace.
12. **Domain optionality** — the same project without the package boots identically, and a source scan proves `packages/core` never names a contracts concept.

## Explicitly out of scope

Billing, invoicing, payment, usage rating, proration, ramps, minimum
commitments, tax, FX, revenue recognition, MRR/ARR/TCV; the renewal scheduler
(needs `JOBS_AND_OUTBOX.md` — without it nothing can fire on a future date);
amendments, seat changes, cancellation, refunds; Delivery Project execution
(M13/M14), Service Contracts, entitlements and SLA (M15); real tenant and user
permissions.

M12 is activation. Renewal and delivery are what M12 makes *possible*, not what
it delivers.

## Definition of done

Met: implementation, contract and e2e suites, Admin view and its tests, the
starter driving the whole path, browser smoke, documentation and this plan.
Still to run per `docs/QUALITY_GATES.md` §5: adversarial review
(`.claude/skills/adversarial-review/`), fixes with regression tests, and human
merge. JTBD rows move only with linked evidence; MRR/ARR/TCV and renewal stay
**not supported**.
