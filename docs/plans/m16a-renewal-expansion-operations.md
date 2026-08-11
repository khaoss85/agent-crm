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
`contract-lifecycle-source@2`: the contract's identity, its term with
provenance, its current version, its lines and its subscription lines — and no
write path of any kind. No kernel lifecycle code, no private import.

The capability moved to `@2` in the post-merge audit. At `@1` it answered
`signed: false` for any `termsSource` its classification map did not name — safe
for one odd row, unsafe as a rule, because the day M12 gains a source nobody has
classified every contract carrying it is reported as unsigned by a package that
never considered the question. At `@2` it reads the declared enum off the live
module contract and **refuses to open** while any value is unclassified, and
reports `signed: null` with `signedBasis: 'UNCLASSIFIED_TERM_SOURCE'` for a
stored value outside that enum. Both are observable changes to what a consumer
is told, so the version moved with them and `contracts` went to `version: 4`.

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

### Business identity, and the retry that used to be punished

Both records are keyed deterministically, from the ask and never from the clock:
`renewal-decision:<contractId>:<asOf>` — the identity is (contract, calendar
date) — and `commercial-followup:<contractId>:<intent>:<round>`, whose round
number advances only when the previous round reaches a terminal state.

The post-merge audit found that a deterministic key was only half the story. A
client whose *response* was lost retried the identical ask and got a `409`, so
from where it stood the work had never happened and there was no path back to
the record it had just created. Both writes now **replay**: an identical repeat
returns the existing record unchanged, and a repeat that differs is refused
`409` naming the diverging fields in `details.conflictingFields` — recorded
intent is never silently overwritten. Only the caller's own inputs are compared,
so a derived field moving elsewhere cannot turn a safe retry into a spurious
conflict. Legitimate repeated future work is never collapsed: the round number
still advances once the previous ask is `resolved_externally` or `withdrawn`.

### Calendar dates

`asOf` is validated by the framework's one round-trip calendar-date authority,
now in `packages/core/src/validation.js`. Shape alone is not the check:
`2027-02-30` matches `YYYY-MM-DD` and JavaScript rolls it to March 2, so a
record would store a date nobody could have decided on beside a `daysToBoundary`
measured from a different day — and against a real database two contradicting
decisions would both persist for the same real day, defeating this package's own
"one decision per contract per date" promise. Date-time strings,
whitespace-padded dates and expanded years are refused for the same reason: one
day must have exactly one spelling, or the key built from it identifies nothing.

### Money evidence

The baseline is grouped by currency, charge type, interval **and interval
count** — M12 spells quarterly as `month x 3`, and grouping on `interval` alone
folded quarterly into monthly and overstated the baseline threefold, silently.
The scalar summary on a follow-up is recorded only where the baseline collapses
to exactly one kind of money; the grouped evidence (`baselineGroupsJson`,
`baselineGroupCount`) is recorded always, because a mixed baseline previously
stored three nulls and lost its money evidence exactly when there was most of
it. No total is computed across recurrence or currency, and there is no FX.

## What it must never do

End a contract · cancel a subscription · stop a service · recognize churn ·
mutate any signed record · create a Quote, Order or Contract · send anything ·
invoice anything · compute ARR/MRR/TCV without compatible term evidence · apply
FX · synthesize a successor.

## Evidence

Package conformance (DX4) · AX1 visibility and AX2 citability · absence /
detach / reattach with rows preserved, **in separate processes** · exact reads
past the 500 bound *where correctness uses a collection query* · atomicity,
idempotent replay, divergent refusal and two-connection concurrency on every
write, with fault injection on all three · restart with old data · exact audit,
event and trace counts · truthful event names.

**Stated N/A, with the reason.** Reads past the 500-row page bound are *not*
tested on primary-key paths — `termEvidence`, `service.get` and every
`sourceKey` lookup are exact single-row reads with no page bound to exceed, so
seeding 500 rows in front of them would test the fixture and nothing else. The
bound is proven on the three paths where correctness genuinely depends on a
collection query: the baseline, the `decisionId` check and the pending-follow-up
guard.

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
