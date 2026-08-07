# Delivery change, deliverables and acceptance (Milestone 14b2)

M14b1 recorded what a delivery project **consumed**. M14b2 records what changed
about it, what it **produced**, and whether anyone said the work was done.

**None of it is commercial, and none of it is authentication.** No Quote, Order,
Contract or Subscription is created or altered; no amendment exists; no invoice,
payment or billing eligibility is produced; no customer is authenticated and no
legal signature is claimed.

## What ships

```text
delivery-change-request       proposed → approved | rejected | pending_commercial_followup
delivery-plan-revision        immutable, versioned: the replan an approval produced
delivery-commercial-change    pending_commercial_followup → resolved_externally | withdrawn
delivery-deliverable          planned → completed, gated on execution state
delivery-acceptance-request   immutable: what was submitted, and when
delivery-acceptance-evidence  immutable: what a human recorded a customer as saying
```

Seven actions, on the records they belong to:

```text
delivery-project.propose-change-request
delivery-change-request.decide-change-request
delivery-commercial-change.resolve-commercial-change
delivery-work-package.plan-deliverable
delivery-deliverable.complete-deliverable
delivery-milestone.request-acceptance
delivery-acceptance-request.record-acceptance
```

Two new capabilities, additive — `delivery-obligations@1`, `delivery-economics@1`
and the whole M13/M14a/M14b1 surface are untouched:

```text
delivery-change-management@1   read-only change requests, revisions and candidates
delivery-acceptance-evidence@1 read-only deliverables, requests and recorded evidence
```

## The commercial boundary, which is the whole risk

A change that costs money must never reach the signed commercial record. So it
does not: approving a `commercial_change_required` request raises an **immutable
candidate** and moves the request to `pending_commercial_followup` — a state a
human can see, not an implicit hop.

A future Commercial Amendment milestone consumes the candidate through the
declared capability, in the package that owns commercial truth. The e2e suite
fingerprints every quote, order, contract and subscription row before and after
and asserts the bytes are identical.

### …and the handoff has an end

A raised candidate blocks acceptance over the scope it touches, so a candidate
nobody can close would block that scope **forever**: the change request's
`pending_commercial_followup` is terminal, and managed storage has no public
write path. `resolve-commercial-change` is the way out — a human records what
the commercial follow-up concluded **elsewhere**:

| Outcome | Meaning |
|---|---|
| `resolved_externally` | somebody settled the commercial question outside this application |
| `withdrawn` | nobody is pursuing it |

Recording an outcome **amends nothing**. It creates and alters no Quote, Order,
Contract, Contract Version or Subscription, recognizes no amount and sends
nothing; the result says `amended: false` the way a completed deliverable says
`accepted: false`. It is recorded once, by a user actor, with a stated reason —
and the starter asserts the commercial rows are byte-identical after it, not
only before.

This is deliberately **not** the Commercial Amendment milestone. It records that
somebody else answered the question; it does not answer it.

## Acceptance is evidence, not authentication

The strongest claim this milestone makes is:

> a **user actor** recorded that a customer accepted or rejected.

It is **not** an authenticated customer action, not a legal signature, not a
verified identity, and not authorization to bill. There is no customer portal
and nothing is sent anywhere. Real customer actors need the Production Spine.

Completing a deliverable says the work finished. It does **not** say anyone
accepted it — two different facts with two different authors, and conflating
them is how a framework accidentally claims a customer signed off.

## Rejection semantics, decided rather than assumed

A rejected acceptance **preserves execution history**. It is recorded, and
replanning requires a new change request. Completed work packages and
deliverables are never destructively reopened, because rewriting M14a execution
evidence would stop M14b1 economics snapshots reproducing — and a snapshot taken
on Tuesday must still reproduce on Wednesday.

## The acceptance scope is frozen

An acceptance request stores **the exact scope it submitted** — the milestone,
every deliverable with its completion evidence, and the customer reference as it
read then — plus a SHA-256 `scopeFingerprint`. Every reader uses the stored copy.

The fingerprint covers **the body of work only**: the project, the milestone and
every deliverable in it. It excludes the request's own timestamp and key,
because it identifies *what* was accepted rather than *when it was asked* — and
it excludes `customerRef` for the same reason with more force. That field is an
unverified operator label; folding it in would make the settled-scope rule below
bypassable by retyping the customer's name, so a rejected scope re-asked as
"Acme" instead of "ACME" would count as a new question over identical work. The
label is still frozen and stored, because it is part of the testimony. It just
cannot buy a second answer.

Rebuilding that scope later from the current deliverable set would silently
re-point old testimony at new work: a deliverable added afterwards would appear
to have been accepted by a customer who never saw it. So it is never rebuilt,
and the Admin says so on screen.

Three rules follow, and each is enforced rather than documented:

| Rule | What happens |
|---|---|
| a **pending** request freezes its milestone | planning a deliverable on it is `409 DELIVERY_ACCEPTANCE_SCOPE_FROZEN` |
| a scope already **accepted or rejected** is settled | asking again is `409 DELIVERY_ACCEPTANCE_SCOPE_SETTLED`, naming the outcome |
| acceptance evidence binds to the **fingerprint**, not just the request id | evidence cannot follow a request whose scope moved, because none can |

Replanning changes the deliverables, so it changes the fingerprint — which is
how a genuinely new question becomes askable after a rejection, and an unchanged
one does not. Note what that requires: a plan revision alone does **not** change
the fingerprint, because it does not touch the deliverables. Real new work does.
A deliverable is also never removed or re-pointed, so a milestone's scope only
ever grows.

## Commercially disputed scope is never quietly acceptable

`request-acceptance` refuses while an unresolved commercial-change **candidate**
touches the scope being submitted (`409 DELIVERY_COMMERCIAL_CHANGE_UNRESOLVED`,
naming both the change requests and the candidates). A change that names this
milestone, or a work package behind the deliverables in scope, counts. A change
that names **nothing** is project-wide and counts too: the safe reading of "we
have not decided what this project includes" is that it covers this milestone as
well.

The rule reads the *candidate*, not the change request, and that is the whole
difference between a gate and a trap. The change request's
`pending_commercial_followup` is terminal, so reading it would have made the
refusal permanent — one approved project-wide commercial change would have
stopped every milestone in that project ever recording acceptance again.

## When each thing is allowed

```text
propose a change        delivery-project in_progress
decide a change         delivery-change-request proposed — exactly once
resolve a candidate     delivery-commercial-change pending_commercial_followup —
                        exactly once, and it amends nothing
plan a deliverable      the milestone has no pending acceptance request
complete a deliverable  its work package completed (server-authoritative)
request acceptance      every deliverable on the milestone completed ·
                        no other request pending on it ·
                        this scope not already settled ·
                        no unresolved commercial change touching it
record acceptance       delivery-acceptance-request pending
```

## Evidence is immutable

Every record is `writable: "managed"`: no public create, update or delete
through the service, HTTP, the SDK, the Admin or MCP. A correction is a new
record. A retry under a reused key answers from the stored row only once it has
proved it is the same call — divergent bytes are `409 DELIVERY_EVIDENCE_CONFLICT`
naming the fields that differ.

## Not modeled — stated, not implied

Invoicing, payment, billing eligibility, contract amendment, Quote/Order/Contract
mutation, legal acceptance, authenticated customer identity, customer portal,
external send or notification, e-signature, resource scheduling, capacity,
document or binary storage, SLA, Service, entitlements.

The schema says so in `notModeled`, and the capability descriptions say so where
another package would read them.

## Evidence

`tests/delivery-change-acceptance-e2e.test.js` (the paths),
`tests/delivery-change-acceptance-evidence.test.js` (fault injection on every
write, two-connection races, exact reads past 500 rows, exact audit/event/trace
counts, the scope freeze, hostile input),
`tests/delivery-change-acceptance-integration.test.js` (AX1, AX2, upgrade,
detach), `tests/admin-delivery-change.test.js` (the Admin section),
`docs/ADMIN_SMOKE.md` (18 real-Chromium checks),
`packages/delivery/src/change-acceptance.js`,
`docs/plans/milestone-14b2-delivery-change-acceptance.md`.
