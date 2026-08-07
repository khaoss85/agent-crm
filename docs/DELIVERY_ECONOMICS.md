# Delivery economics (Milestone 14b1, the delivery domain package)

M13 planned a delivery project. M14a let a human run it. M14b1 records **what
it consumed** — time and expenses, as immutable evidence — and computes a
reproducible **delivery contribution estimate** against a versioned plan.

**These are operational delivery-management estimates.** Nothing here
recognizes revenue, implies an invoice amount, computes an accounting or gross
margin, claims a profit, pays anybody, or converts a currency.

## The split, stated

M14b as scoped also covered change requests, deliverables and customer
acceptance. That is four models with four different invariants, and it is not
one reviewable PR. **M14b1 is economics; M14b2 is change, deliverables and
acceptance**, and M14b2 is recorded in `TASKS.md` and the roadmap with its
scope intact. It is deferred, not dropped.

## What ships

```text
delivery-cost-policy         versioned, fingerprinted: what an hour costs
delivery-time-entry          immutable: minutes, rate snapshot, server-computed cost
delivery-expense-entry       immutable: amount, category, vendor reference
delivery-economic-plan       one immutable version per publish
delivery-economic-plan-line  the items a plan total is derived from
delivery-economic-snapshot   a reproducible grouped computation
```

Five actions, on the records they belong to:

```text
delivery-work-package.record-delivery-time
delivery-work-package.record-delivery-expense
delivery-project.publish-economic-plan
delivery-project.snapshot-delivery-economics
delivery-project.preview-delivery-economics    read-only; an agent may call it
```

One new capability, additive — `delivery-obligations@1` and the whole M14a
surface are untouched:

```text
delivery-economics@1    read-only grouped economics for one delivery project
```

## Four rules decide everything

**Evidence is immutable.** Every record is `writable: "managed"`, so there is
no public create, update or delete anywhere — not through the service, HTTP,
the SDK, the Admin or MCP. A correction is a new entry, because a snapshot
computed on Tuesday must still be reproducible on Wednesday.

**The server computes money.** A caller supplies minutes; the cost policy
supplies the rate; the action multiplies and rounds. A client-supplied
`costCents`, `ratePerHourCents` or `currency` is not authoritative — it is not
even an input, and a test proves a forged one is ignored.

**Currencies are never mixed.** There is no FX in this framework, so every
total is grouped by currency and a group is a complete answer for that currency
alone. There is no grand total, deliberately.

**Recording is a human decision.** `record-delivery-time`,
`record-delivery-expense`, `publish-economic-plan` and
`snapshot-delivery-economics` each require `actor.type === 'user'`; an agent is
refused `403 HUMAN_APPROVAL_REQUIRED` and may call only the read-only preview.
That is a **human-actor boundary, not RBAC** — real roles need the Production
Spine.

## Money and rounding, stated once

ADR-014 unchanged: integer minor units, safe integers, uppercase three-letter
currency shape, no FX. The repository's 1/100-unit, two-decimal convention
holds; no ISO-4217 exponent is claimed.

```text
cost = roundHalfUp(ratePerHourCents × minutes / 60)
```

Computed in integers throughout — the product is checked before the division,
so an absurd input is refused rather than rounded into something plausible.
The rule is published in the schema, stored on every snapshot, and pinned by
tests at 1, 30, 60 and 61 minutes, at an exact half-cent tie, at zero, and at
the safe-integer boundary.

## Vocabulary, fixed

| Used | Never used |
|---|---|
| commercial delivery input | recognized revenue |
| planned delivery cost | budget (in the accounting sense) |
| actual delivery cost | cost of goods sold |
| delivery contribution estimate | gross margin · accounting margin · profit |
| variance to plan | forecast variance |

## The commercial input

It comes **only** from the immutable work-package snapshot M13 copied from the
M12 delivery obligation. No live catalog read, no quote draft, no re-pricing,
and no client-supplied value. An obligation with no deterministic amount is
reported as unavailable evidence rather than invented.

## The cost policy

A versioned, fingerprinted definition owned by the delivery package: a category
and a contributor type map to a rate per hour in a currency. Deterministic and
synchronous over deep-frozen input, with no clock, network, database or
randomness. The rates live in `config`, so they are inside the
declared-definition fingerprint (ADR-015) — a rate is versioned as strictly as
the code, and changing one means publishing a new version.

A policy returning a rate in a different currency from the work it costs is
refused: there is no conversion to fall back on.

It is **not payroll and not employee identity**: a contributor reference is an
opaque operational label, nothing reads an HR system, and no salary is claimed.

## When consumption may be recorded

```text
delivery-project        in_progress
delivery-work-package   in_progress or blocked
```

A blocked work package still consumes time — someone is waiting on it. A
completed one does not, and a project that has not started or has closed
accepts nothing.

## Not modeled — stated, not implied

Invoicing, payment, tax, FX, accounting, revenue recognition, gross or
accounting margin, profit, payroll, employee identity, resource scheduling,
capacity, partner payout, billing eligibility, receipt or document storage,
reimbursement — and, deferred to M14b2: change requests, deliverables and
customer acceptance.

The schema says so in `notModeled`, and the Admin says so on screen.

## Evidence

`tests/delivery-economics-e2e.test.js`, `packages/delivery/src/economics.js`,
`packages/delivery/src/cost-policy.js`,
`packages/delivery/src/economics-actions.js`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`docs/plans/milestone-14b-delivery-economics-change-acceptance.md`. Agent
instructions: `.claude/skills/build-delivery-handover/SKILL.md`.
