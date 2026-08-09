# ExecPlan — M16a Renewal & Expansion Operations

## The scope decision, made against the live architecture

The roadmap said **Amendments / Renewal / Expansion**. Three options were
compared before any code:

| Option | Verdict |
|---|---|
| **A — full amendment execution now** | **blocked.** A real amendment changes what was agreed: a new signed instrument, re-priced lines, a new order. Pricing lives in Commercial and signature lives in Signature; **both are still `needs_extraction` in `packages/core/src`**, offer no capability, and cannot be reached by a package without a private import — which the Package Contract refuses. Building amendment execution now means either a kernel back-door or a second pricing engine. |
| **B — renewal/expansion planning + governed commercial handoff** | **chosen.** Everything it needs already exists as evidence: the contract, its version, its lines, the subscription and its lines, and the term with its declared provenance. It produces decisions and a governed handoff, and stops exactly where the blocked domains begin. |
| **C — wait entirely** | rejected. The evidence and the human decisions are useful on their own, and waiting would leave the most common commercial question — *what is coming up for renewal, and what do we do about it* — unanswerable while the framework already holds the answer. |

**The split is therefore explicit:**

- **M16a — Renewal & Expansion Operations** (this plan): term-boundary
  evidence, a read-only renewal plan, human renewal/non-renewal decisions,
  expansion/contraction intent, a governed commercial follow-up, and a
  human-recorded successor link.
- **M16b — Commercial Amendment Execution**: deferred until Commercial and
  Signature are extracted or expose capabilities. Recorded in the roadmap so
  the deferral is a decision rather than an omission.

## Architecture

**A new package-native domain, `packages/lifecycle/`.** Named for what it is —
the operational lifecycle *after* activation — rather than `renewals`, because
non-renewal, expansion and contraction all live here and none of them is a
renewal.

**It consumes a declared capability and imports nothing.** Contracts today
offers `delivery-obligations@1` and `service-obligations@1`; neither exposes
term or line evidence. So Contracts gains a **minimal, read-only**
`contract-lifecycle-source@1`: the contract's identity, its term with
provenance, its current version, its lines and its subscription lines — and no
write path of any kind. No kernel lifecycle code, no private import.

## The truth problem this milestone must not create

M12 recorded activation terms as **operational metadata**, and
`termsSource` / `termsReason` exist precisely because **those dates may never
have been signed**. This package therefore:

- always carries `termsSource` alongside any date it reports;
- calls them **term evidence**, never "signed renewal terms";
- says `non-renewal intent recorded`, never "cancelled" or "churned";
- says `renewal decision recorded`, never "renewed" — nothing is renewed until
  a signed successor exists, and only a human may record that it does.

## Surface

| Action | Writes | Actor |
|---|---|---|
| `plan-renewal` | **nothing** — a read-only computation returning evidence, boundaries and gaps | any |
| `record-renewal-decision` | immutable decision evidence | **user** |
| `record-expansion-intent` | immutable expansion/contraction intent | **user** |
| `request-commercial-followup` | immutable handoff candidate | **user** |
| `resolve-commercial-followup` | terminal transition with a reason | **user** |
| `record-successor` | immutable successor link, validated to exist | **user** |

The follow-up state model has an exit, learned from Delivery's handover:
`pending_commercial_followup → resolved_externally | withdrawn`, each requiring
a human reason. No dead-end terminal state.

## What it must never do

End a contract · cancel a subscription · stop a service · recognize churn ·
mutate any signed record · create a Quote, Order or Contract · send anything ·
invoice anything · compute ARR/MRR/TCV without compatible term evidence · apply
FX · synthesize a successor.

## Evidence required

Package conformance (DX4) · AX1 visibility and AX2 citability · absence /
detach / reattach with rows preserved · exact reads past the 500 bound ·
atomicity, idempotency and concurrency on every write with fault injection ·
exact audit, event and trace counts · truthful event names
(`renewal-decision.recorded`, `commercial-followup.requested|resolved`,
`successor.recorded` — and none of `contract.renewed`, `customer.churned`,
`subscription.cancelled`, `invoice.created`).
