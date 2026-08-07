# ExecPlan — Milestone 14: Delivery Execution, Economics & Customer Acceptance

**Status: split. M14a (delivery execution) is implemented; M14b is not
started.** Extends `packages/delivery` (M13). Guide:
[`packages/delivery/README.md`](../../packages/delivery/README.md) and
[`docs/DELIVERY_HANDOVER.md`](../DELIVERY_HANDOVER.md). Decisions: ADR-018
addenda 3–4 (the package contract this extends), ADR-019 and its addendum 1
(how the M13 records were allowed to grow at all).

Context: `docs/strategy/DELIVERY_SERVICE.md` (the domain),
`docs/PACKAGE_AUTHORING.md`, and Milestone 13, which produced the planned
project this milestone executes against.

## The split, and why

M14 as scoped covered execution, economics, change requests and acceptance —
four domains with four different invariants. It is delivered in two milestones
so each ships coherent:

| | Scope | Status |
|---|---|---|
| **M14a — Delivery execution** | the revision-2 evolution of the three M13 records, explicit transition tables, and the eight human-driven transition actions | **implemented, this PR** |
| **M14b — Economics, change requests, deliverables and acceptance** | time and expense evidence, the versioned economics plan and snapshot, governed change requests, deliverables and acceptance evidence | **not started** |

M14b's domain code is **not in this branch**. It is preserved on
`claude/m14b-economics-change-acceptance-preserved` so nothing is lost, and the
review that produced this plan removed it from the PR: unwired source in a diff
reads as a capability, and M14a must claim none it does not have.

Acceptance states are deliberately **absent from the manifests**, for the same
reason `blocked` is now reachable: declaring a state nothing can move a record
to is a capability claim without a capability.

## What M14a is, in one sentence

M13 **planned** a delivery project. M14a lets a human **run** it — start it,
start, block, resume and complete its work packages, start and complete its
milestones, and close it when all of them are done — without pretending to be
an accounting system, a billing system, a partner portal, a resource-planning
suite, a signature system or a scheduler.

## Three architectures compared

**1. Generic editable CRUD records for state, time, cost, change and
acceptance.** Fastest: a few module manifests and the generated Admin. It is
also wrong in a way that cannot be patched later. Execution state is a decision
with an author; an editable `status` column makes "who decided this" mean
"whoever saved the row last", and the same argument applies with more force to
time, expense and acceptance evidence. **Rejected.**

**2. Put delivery execution and economics in the kernel.** Every project would
carry execution states, time entries and acceptance whether it delivers
anything or not — directly against ADR-018's core budget rule, and against the
M13 evidence that a domain does not need a kernel concept to work. It would
also put "what is a block" and "what is acceptance" where no customer can
replace them, and those are exactly the decisions a customer's business
disagrees with. **Rejected.**

**3. Bounded Delivery-package actions over read-only managed records
(chosen).** Everything lands in `packages/delivery`: explicit transition tables
as data, and transitions performed only by actions that require a human actor.
The kernel learns nothing about delivery. The package contract is the same
`packageContract: 1` merged in PR #17, extended by adding actions rather than
changing the contract.

**What option 3 explicitly is not:** a universal workflow or project-management
DSL. There is no rule engine, no scheduling solver and no generic state-machine
language. The transitions are a small explicit table, reviewable in a diff.

## What M14a ships

**Revision 2 of the three M13 record manifests**, through the generic module
evolution path (ADR-019) — widened status enums plus `startedAt`,
`completedAt`, `executionNote`, and on work packages `blockedAt`, `blockedBy`
and `blockedReason`. No Delivery-specific code entered the kernel to make this
work; the one kernel change is **adoption** (ADR-019 addendum 1), which is
generic and names no domain.

**Execution states**, with explicit allowed-transition tables and no
numeric-rank branching:

```text
delivery-project        pending_kickoff → in_progress → completed
delivery-work-package   planned → in_progress ⇄ blocked, in_progress → completed
delivery-milestone      planned → in_progress → completed
```

**Eight transition actions** — `start-delivery-project`,
`complete-delivery-project`, `start-work-package`, `block-work-package`,
`resume-work-package`, `complete-work-package`, `start-milestone`,
`complete-milestone` — each requiring a user actor, each accepting an optional
`expectedState` whose mismatch is a refusal rather than a silent overwrite.

## Scope decisions worth naming

| Question | Decision |
|---|---|
| Is every declared state reachable? | **Yes, and it is checked.** Each action declares the states it applies to and the state it produces; the package publishes that map, and the suite asserts against the shipped action list that no declared state is unreachable and no declared edge is unwalked |
| Can work reopen? | **No.** `completed` is terminal in M14a. Reopen is a design decision with its own invariants; an untested reopen path is worse than none |
| What closes a project? | Every work package and every milestone being `completed`, counted with exact indexed reads. A blocked work package holds the project open |
| What does a block record? | A **required** reason, who blocked it and when. Resuming clears those three fields — they describe the block a record is under *now* — and every block that ever held stays in the audit log |
| Is `actor.type === 'user'` authorization? | **No.** It is a human-actor boundary: it says a person did this, not that the person was allowed to. Delivery Manager RBAC does not exist, and the schema says so on the wire |
| Does anything move on a clock? | **No.** There is no scheduler in this framework, so no state changes without an actor |

## Guarantees proven

1. **Reachability is a property, not a comment** — derived from the shipped
   action list and the published tables, in both directions.
2. **Execution state is managed** — no public create or update can set it,
   through service, HTTP, SDK, Admin or MCP; the refusal is the route not
   existing.
3. **Human-only** — an agent actor is refused `403 HUMAN_APPROVAL_REQUIRED`,
   and the refusal changes nothing.
4. **Optimistic concurrency** — a stale `expectedState` is a stable `409`.
5. **The hierarchy holds** — work moves only under a running project, and a
   project closes only over completed work.
6. **Free text is bounded** — 500 characters, no control characters, DEL,
   U+2028 or U+2029; tab, newline and carriage return are ordinary text.
7. **Hostile input stays inert data** — markup, template and SQL fragments are
   stored verbatim as text and pollute no prototype.
8. **The kernel is untouched by Delivery** — no delivery file under
   `packages/core/src`, no kernel import of delivery, and `packageContract: 1`
   unchanged.
9. **An M13 project upgrades** — proven on a project built with the M13 merge
   commit's own CLI and upgraded in place: the r2 manifests apply, the
   evolution migrations run, the original create-migration checksums are
   unchanged, and the widened enum reaches the table.

## Explicitly out of scope

Time tracking, expenses, cost, margin, economics snapshots, change requests,
deliverables, customer acceptance, billing, invoicing, payment, revenue
recognition, accounting, FX, tax, partner portal or access, partner invoices,
revenue share, commission, resource scheduling and capacity, payroll, file or
receipt storage, legally qualified acceptance, service contracts, entitlements,
SLA, support cases, customer success, renewal, a scheduler or durable outbox,
auth/tenancy/RBAC, PostgreSQL, Cloud, Marketing runtime, Analytics Studio,
Design-to-CRM ingestion, extraction of M9–M11, and any package marketplace or
publication.

## Known limitations

- The generated Admin lists every action a module declares and does not filter
  by the record's current state, so all eight buttons appear on every delivery
  record. An inapplicable one is refused by the server with a `409` naming the
  allowed moves. The schema publishes the per-action `from`/`to` map a client
  needs to filter; using it is an Admin improvement, not an M14a change.
- `blockedReason`, `blockedAt` and `blockedBy` describe the current block only.
  The history of blocks lives in the audit log, not in a queryable record.

## Definition of done

The states, actions and manifest revisions above; the extended e2e suite; the
package README, the module-evolution guide, ADR-019 addendum 1, the ExecPlan
and the status file; `npm run verify` and `npm run smoke` from a clean clone,
the starter, and the Chromium smoke. Then per `docs/QUALITY_GATES.md` §5: the
adversarial review, then a human merge. **The M14a PR is left open.**
