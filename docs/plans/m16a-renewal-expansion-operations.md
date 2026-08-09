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
  expansion/contraction intent carried as the *intent* of a governed commercial
  follow-up, and that follow-up's terminal resolution.
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
  a signed successor exists, and M16a can neither create one nor record that one
  does.

## Surface

Four actions ship, and these are all of them:

| Action | Writes | Actor |
|---|---|---|
| `plan-renewal` | **nothing** — a read-only computation returning evidence, boundaries and gaps | any |
| `record-renewal-decision` | immutable decision evidence | **user** |
| `request-commercial-followup` | immutable handoff candidate | **user** |
| `resolve-commercial-followup` | terminal transition with a reason | **user** |

**Two actions this plan originally listed were not built, and the plan was
wrong to keep describing them** (corrected by the post-merge audit):

- `record-expansion-intent` — expansion and contraction are two of the five
  `intent` values on `request-commercial-followup`, not a separate record. There
  is no second intent action and no second intent table.
- `record-successor` — **nothing in M16a records a successor.** There is no
  successor field, table or action. Linking a contract to the one that replaces
  it needs a successor to exist first, which needs M16b.

The follow-up state model has an exit, learned from Delivery's handover:
`pending_commercial_followup → resolved_externally | withdrawn`, each requiring
a human reason. No dead-end terminal state.

Both records are keyed deterministically, from state and never from the clock:
`renewal-decision:<contractId>:<asOf>` — one decision per contract per day, and
a second one that day is a 409 rather than an overwrite — and
`commercial-followup:<contractId>:<intent>:<round>`, whose round number lets
resolved work come round again while an open follow-up of the same intent is
still refused.

## What it must never do

End a contract · cancel a subscription · stop a service · recognize churn ·
mutate any signed record · create a Quote, Order or Contract · send anything ·
invoice anything · compute ARR/MRR/TCV without compatible term evidence · apply
FX · synthesize a successor.

## Evidence

Package conformance (DX4) · AX1 visibility and AX2 citability · absence /
detach / reattach with rows preserved · exact reads past the 500 bound ·
atomicity, idempotency and concurrency on every write with fault injection ·
exact audit, event and trace counts · truthful event names.

**Where it lives.** `tests/lifecycle-renewal-operations.test.js` holds the
arithmetic, the wording and the capability boundary;
`tests/lifecycle-renewal-operations-e2e.test.js` holds everything above that is
a claim about a *running* application, against a real composed one; and
`tests/package-contract.test.js` holds the DX4 conformance case. The e2e file
was added by the post-merge audit: as merged, M16a's only tests ran the
package's exported functions against hand-written module maps, so none of the
evidence listed above had actually been produced.

**Event names.** The two records are generated read-only modules, so the
runtime emits the generated names — `renewal-decision.created`,
`commercial-followup.created` and `commercial-followup.updated` — and the
audit log records the same three. An earlier draft of this plan promised
`renewal-decision.recorded`, `commercial-followup.requested|resolved` and
`successor.recorded`; **none of those names is emitted anywhere**, and the last
one names an action that does not exist. What matters is what the names may
never claim, and that holds: `contract.renewed`, `customer.churned`,
`subscription.cancelled` and `invoice.created` appear nowhere in this
milestone, and the e2e suite asserts their absence by name.
