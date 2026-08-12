# ExecPlan — Work v1: first-class Tasks, Activity and reusable follow-up creation

**Status:** implemented on `claude/activity-task-operations`, base `7bd8070`.
**Closes:** the `TASKS.md` item *"Add Activity and a first-class Task module with
a general automatic follow-up workflow."*
**ADR:** ADR-030 in `DECISIONS.md`.
**Package:** `packages/work` — `work@1`, offering `follow-up@1`.

## 0. What this milestone is called, and what it is not

It claims **no `M`-number**. `M16` in `docs/strategy/EXECUTION_ROADMAP.md` is
Analytics Studio v1 (planned, unbuilt), `M16a` is merged and `M16b` is deferred.
Taking `M17` would assert a position in a sequence this work does not have: it is
a horizontal capability that several domains consume, not the next rung of the
commercial ladder. It is referred to as **Work v1** throughout.

**This milestone is not:** a scheduler · reminders · calendar sync · email, SMS
or WhatsApp · notifications · authenticated or secure assignment · RBAC · a
project-management suite · a universal event bus · a replacement for audit or
trace · a migration of every existing domain-specific activity record.

Every one of those is published as a limitation by the package itself
(`metadata().notModeled`), stated in `packages/work/README.md` and
`docs/WORK_TASKS.md`, and asserted as absent by
`tests/work-operations-evidence.test.js`.

## 1. The bespoke slice being replaced

`TASKS.md` recorded the item as *partially explored*. What actually existed:

| Where | What |
|---|---|
| `examples/starters/b2b-lead-qualification/task.module.json` | module `task`, table `tasks`; `title`, `status` (`open`/`done`), `dueAt`, `leadId` (**required** reference to `leads`), `sourceKey` (unique) — every field publicly writable |
| `examples/starters/b2b-lead-qualification/actions/qualify.js` | created exactly one Task with `sourceKey = qualify:<leadId>` through `modules.get('task').service.create` |
| `examples/starters/b2b-lead-qualification/install.mjs` | applied the manifest, asserted the one-task guarantee, published `tasks: <count>` as journey evidence |
| `examples/scenarios/lead-to-won.scenario.json` | `module.present: task` and `journey.count tasks == 2` |
| `docs/benchmarks/CRM_JTBD_MATRIX.md` | JTBD-07 and JTBD-CM-04 *partially supported* on that one Task; JTBD-CM-03 and JTBD-DO-08 *not supported* for want of an Activity model |
| tests | `lead-qualification-e2e`, `action-runtime-semantics`, `lead-conversion-e2e`, `opportunity-pipeline-e2e`, `lead-intelligence-e2e`, `intelligence-package-absence`, `intelligence-capability-consumer`, `intelligence-pre-extraction-upgrade`, `app-inspect`, `scenario-run`, `characterization/intelligence-harness.mjs` |

Its three defects, and they are the reason a reusable capability is not a
refactor of it:

1. **The subject is `leadId`, required.** A Task that cannot exist without a Lead
   cannot be a follow-up on a contract, a support case or anything else.
2. **Every field is publicly writable.** `POST /api/modules/task/records` could
   forge a follow-up with any `sourceKey`, and `PATCH` could rewrite the
   `sourceKey` of one the runtime created. There was no evidence boundary.
3. **`status` is `open`/`done` with no transition table**, no cancellation, no
   actor on the transition and no record of who did it or when.

## 2. Options compared

### Option A — Activity and Task directly in `packages/core`

**Rejected.** ADR-018 admits domain behaviour into core only when it is a
*runtime capability* the kernel itself needs. Nothing in the kernel needs a task:
the module registry, action runtime, audit, trace and event bus all work today
with no notion of one, and a project that wants none must be able to have none.
The counter-argument — "two domains consume it, so it is shared" — is exactly the
argument ADR-018 exists to refuse: *a capability used by two domains is not a
reason to move a business model into core*. Contracts is consumed by Delivery,
Service and Lifecycle and is still a package.

One thing genuinely does belong to the kernel and is already there: the
capability seam itself (`PackageRegistry.capability`).

**Corrected by REVIEW-70 (ADR-030 addendum 1).** This section originally claimed
`packages/core` was untouched and pointed at an empty `git diff --stat` as the
mechanical form of the ADR-018 argument. The review found two things the kernel
genuinely owed a package, and `packages/core` now carries exactly two changes,
both **generic** — neither names Work or any other package:

- `PackageRegistry.capability()` hands the consumer identity it has already
  resolved to the provider's `create(context)`, so a provider that records
  provenance binds the name the registry proved instead of one the caller
  retypes in a payload;
- `normalizeActor` / `SYSTEM_ACTOR` are exported from the public kernel surface,
  because a package that cannot reach the canonical actor authority writes its
  own and drifts from the audit row beside it — which is exactly what happened.

The substantive claim is unchanged and is the one that matters: there is **no
Work engine in the kernel** — no record, action, capability, table or name
belonging to this domain anywhere in `packages/core` — and deleting
`packages/work` still deletes the domain.

### Option B — a package-native domain (**chosen**)

A package owns two records, a bounded state machine, three human actions and one
declared capability; it composes with one static import, detaches leaving rows,
and is discovered by AX1 like every other package.

**Name.** The candidates, against the surface actually built:

| Name | Verdict |
|---|---|
| `tasks` | describes half the package. Activity is not a task, and a package named for one of its two records misfiles the other |
| `activities` | the mirror failure — and in the CRM vocabulary "Activities" means tasks *plus calendar events*, which is precisely the thing this milestone does not build |
| `engagement` | implies outreach: emails, calls, sequences, touchpoints. None exists, and the name would promise a channel |
| `work-management` | implies planning, scheduling, capacity and dependencies — a project-management suite. Delivery already owns work packages and milestones, so the name would also collide semantically with a shipped domain |
| **`work`** | **chosen.** The bounded v1 surface is *human work arising from a business event, and the evidence of what happened to it*. `work` is the smallest noun that covers both records without implying a third thing |

`work` is broad enough to need bounding, and it is bounded in the three places a
reader looks: the package `label` ("Work items and activity evidence"), its
`description`, and `metadata().notModeled`. The scope word in the PR title is
`work` for the same reason.

### Option C — a generic work engine in core with package-owned records

**Rejected, and the test for it is written down so a later milestone can apply
it.** This would be right if two consumers needed *identical runtime behaviour*
that the kernel had to arbitrate — a queue, a scheduler, a lease, a retry. They
do not: every consumer calls one function inside its own transaction and stores a
row. There is no runtime primitive here, only a domain model with an interface.
If Jobs/Outbox (`docs/strategy/JOBS_AND_OUTBOX.md`) is ever built, *that* is the
runtime primitive, and it will not be a task.

## 3. Audit versus Activity

They are different evidence with different readers, and Work v1 keeps them apart
by construction:

| | Audit / trace | Activity |
|---|---|---|
| Reader | an engineer or an agent reconstructing what the system did | a user reading what happened on a record |
| Vocabulary | open — every module write, every action run | **closed**: `task_created`, `task_completed`, `task_cancelled`, `note` |
| Completeness | exhaustive; every write is there | curated; most writes produce none |
| Written by | the kernel, automatically | a Work action or the `follow-up@1` capability, explicitly |
| Contains free text | no | yes, and only in a `note` |

**No asynchronous projection engine.** There is no subscriber that turns audit
rows or domain events into Activity, and there is deliberately no way to build
one here: the event bus dispatches *after* commit (ADR-012), so a projection
would either write outside the originating transaction or need Jobs/Outbox, which
does not exist. Every Activity row is written **inside the transaction of the
action that caused it** — the same transaction as the Task it describes.

Activity is therefore *additive* to audit and never a replacement: the audit
trail for a completed task still has its `work-task.updated` row, and the test
suite asserts audit counts independently of Activity counts.

## 4. The DX Simplicity Gate, answered

1. **The agent failure mode it prevents.** Today an agent asked for "a follow-up
   when X happens" writes a bespoke task table per domain — the repository
   contains one such table, with a required `leadId`, publicly writable, with no
   transition table. The second one would not be compatible with the first, and
   the third would not be compatible with either. The failure is *silent
   divergence of the same concept across domains*, and it had already started.
2. **Existing primitives, tried first.** The module factory gives records; the
   action runtime gives atomicity; the capability seam gives a cross-package
   call. All three are reused unchanged — this milestone adds no primitive. What
   none of them supplies is a *shared model*: `create-crm-module` produces a new
   table each time it is asked, which is the divergence above. The extension
   attempted and rejected is in §6: reusing the existing `task` module by
   evolution (ADR-019), which cannot relax a required reference field.
3. **Semantic overlap, minimised.** No new CLI command, no new MCP tool, no new
   namespace, no new document contract. `npm run surface:check` is unchanged.
   The only new agent-facing surface is one capability name, `follow-up@1`,
   discovered through `crm app inspect --json` like every other capability.
4. **Deferred / on-demand.** The package is optional. An application that never
   composes it boots identically, and `tests/work-package-absence.test.js`
   proves it in a separate process.
5. **Portability.** Everything is in the Package Contract and in checked-in
   source: a declared capability, declared resources, declared actions, a schema
   metadata block. Nothing lives in harness-specific logic.
6. **Machine-readable evidence.** `crm package test packages/work --json` exits
   0; `crm app inspect --json` reports the package, its resources, its actions
   and the resolved `work/follow-up@1` edges; the schema block publishes the
   transition table and the Activity vocabulary; `crm scenario run
   examples/scenarios/lead-to-won.scenario.json --json` publishes the observed
   counts.
7. **Horizontal ⇒ Compatibility Backfill Rule.** A follow-up capability is
   something every domain could consume, so
   `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` gains a Work backfill section
   classifying Core CRM/Lead, Pipeline, Lead Intelligence, Commercial Operations,
   Signature & Order, Contract Activation, Delivery, Service, Lifecycle and the
   custom-package fixture. Declaring the gap is the requirement; closing it is
   not, and no legacy domain is refactored here.
8. **The end-user goal flow gets simpler.** Before: "when a renewal follow-up is
   requested, somebody should pick it up" had no representation at all, and
   adding one meant a new table. After: the domain action that already runs adds
   one call inside its own transaction and the work appears in one queue with one
   lifecycle. Nothing new is *run* by a human or an agent.

## 5. Package boundary

- imports `packages/core/index.js` only; no private import from Intelligence,
  Lifecycle, Service, Delivery or Contracts (enforced by `crm package validate`,
  `crm package test` and `tests/helpers/package-conformance.js`);
- declares `resources: ['work-task', 'work-activity']` and **no host record** —
  Lead, contracts and support cases are subjects, never owned;
- `requires: []` — Work depends on nothing, so no consumer can create a cycle;
- the app boots without it; detaching removes the surface and **leaves rows**;
  reattaching restores them;
- AX1 discovers it; DX4 conformance passes; `project doctor` and `project verify`
  stay honest;
- **no new package HTTP-route seam**: the Admin section and every action use the
  existing generic `/api/modules/<module>/records/<id>/actions/<action>` route.

## 6. Migrating the existing Task slice — one Task, not two

**Adoption was attempted first and does not work.** `task`/`tasks` carries
`leadId` as a `required` `reference` to `leads`. Module Evolution (ADR-019) is
additive and forward-only: it adds fields, enum values and indexes. It cannot
drop a column, cannot make a required column optional, and — by design — cannot
rewrite a `REFERENCES leads(id)` constraint. A generic subject cannot live in a
column that must name a lead, so adoption would mean either keeping every task
attached to a lead (the defect) or a destructive migration (refused).

**So: an explicit forward migration, and the old table is never touched.**

- `work-task` / `work_tasks` and `work-activity` / `work_activities` are new
  tables owned by the package.
- **`tasks` is not renamed, not altered and not dropped.** Nothing in this
  milestone issues DDL against it. An existing starter database opens, and every
  historical row is still readable —
  `tests/work-legacy-task-migration.test.js` opens a database built by the *old*
  starter shape and proves exactly that.
- `packages/work/src/legacy-tasks.js` exports `migrateLegacyTasks(...)`: a
  read-only `SELECT` over `tasks` and a managed write per row through the
  `work-task` service, inside one transaction, keyed
  `legacy-task:<id>` so a second run adopts nothing twice. It is a function, not
  a command: it adds nothing to the surface budget, and a project calls it once
  from its own code. `status: 'done'` maps to `completed`; `leadId` becomes
  `subject { resource: 'lead', id, owner: 'host' }`.
- The starter stops applying `task.module.json` and the manifest is **deleted**,
  because leaving it would ship two Task records — the thing this milestone
  exists to stop.

Every test that pinned the bespoke shape is listed in §1 and each is migrated to
the new module; the list is repeated in the PR body.

## 7. The subject model

SQLite cannot enforce a foreign key whose target table varies per row, and Work
does not pretend it can. The record carries an **opaque subject envelope**:

```
subjectResource     the resource/module identity, e.g. "lead", "commercial-followup"
subjectId           the record id
subjectOwner        "host" | "package"
subjectOwnerPackage the owning package when subjectOwner is "package", else null
subjectLabel        an optional display snapshot, immutable, may go stale
sourcePackage       the package whose action created the task ("host" for a host action)
sourceAction        the action name
```

`subjectOwner` preserves the Package Contract's distinction (§4 of
`docs/PACKAGE_AUTHORING.md`) between a **host/project-owned** record dependency
(a Lead) and a **foreign package-owned** one (a `commercial-followup`). A reader
of the row can tell whether the subject disappears with a package or with the
project.

**Who proves the subject exists.** The domain action that owns the source record
does: it is running *on* that record, inside a transaction, having already read
it. The capability is reachable only from inside such an action, and it never
resolves a subject itself. There is deliberately **no generic resolver and no
service locator**: a resolver would be justified only if two real consumers
needed identical resolution behaviour, and neither does.

**The honest limitation**, published as `SUBJECT_REFERENCE_NOT_ENFORCED`: nothing
in the database prevents a subject row from being deleted afterwards, and a task
whose subject is gone still reads as a task. Work reports the envelope as
recorded; it never claims the subject still exists.

## 8. Task and Activity

### The transition table

```
open       → completed
open       → cancelled
completed  → (terminal)
cancelled  → (terminal)
```

An explicit table, published in the schema block and in `app inspect` through the
actions' `fromStates`/`toState` metadata — never rank logic.

**`open → completed` directly is valid, deliberately.** An `in_progress` state
was considered and rejected: no consumer, no action and no read in this milestone
would behave differently in it, so it would be a label that also forces a rule
nobody has asked for (must completion pass through it?). A state that changes
nothing is decoration, and decoration in a state machine is a future migration.

**No reopen in v1.** Reopening is not "un-completing": it needs a second
lifecycle (who reopened, why, is this the same work or new work, does the
original completion evidence survive), and the honest answer for a repeated
business round is *a new task under a new source key*, which the idempotency rule
in §10 already supports. `completed` and `cancelled` are terminal and the runtime
refuses every move out of them with a `409` naming the allowed moves.

### `dueAt` is evidence only

No clock-driven state change, no automatic overdue mutation, no timer, no
scheduler. `dueAt` is a recorded intent. The Admin and the read model can compute
a read-only `due` / `overdue` **at an injected instant**, and that computation
never writes: a task that is past its `dueAt` is still `open`, and the only thing
that changes its status is a human action. Published as `DUE_AT_IS_EVIDENCE_ONLY`
and asserted by stepping the injected clock past `dueAt` and re-reading the row
byte-identical.

### Activity

Append-only. Four kinds and no more:

```
task_created      written with the task, in the same transaction
task_completed    written with the completion, in the same transaction
task_cancelled    written with the cancellation, in the same transaction
note              a human wrote a line of safe text
```

No provider payload, no attachment, no email body, no chat message; the only free
text is a `note` body, bounded and control-character-free. Activity is never
updated and never deleted by any action in the package.

## 9. Write paths

- **Manual actions require `actor.type === 'user'`** — `complete-task`,
  `cancel-task`, `add-note`. This is a **human-actor boundary, not RBAC and not
  authentication**: a local caller sets its own actor header, and the package
  says so in its metadata. It is never described as secure assignment; there is
  no assignee field at all.
- **`follow-up@1`** is the only automatic path. It is opened through
  `domains.capability(...)` from inside a consuming package's action, so it runs
  on the caller's `modules` handle and therefore **inside the caller's
  transaction**. If the caller's transaction rolls back, the Task and its
  Activity roll back with it — proven, not asserted.
- **No public HTTP route reaches the capability.** The only routes Work adds are
  the generic module read routes and the three action routes, all of which go
  through the ordinary action runtime with its actor, audit and trace.
- **No generic mutable service object, and no hidden fallback.** The capability
  returns a frozen object with two methods; there is no second implementation of
  follow-up creation anywhere in the repository, and a consumer that has not
  declared the requirement is refused with `CAPABILITY_NOT_DECLARED`.

### The one honest asymmetry: the host application is not a package

`PackageRegistry.capability({ consumer })` resolves `consumer` against
**registered packages**. The starter's `qualify` is a *host* action in project
source, so it cannot declare a requirement and cannot open `follow-up@1`. Two
ways out were considered:

- **relax the registry** so an undeclared host consumer is admitted — rejected.
  The declaration check is the whole value of the seam, and weakening it for a
  convenience would make every future `CAPABILITY_NOT_DECLARED` a suggestion;
- **the project composes the package's exported creator directly** — chosen.
  `packages/domains/generated/index.js` already imports package source by hand;
  this is the same trust level and the same file's discipline. The starter's
  `qualify` imports `createFollowUp` from `packages/work/src/index.js` and calls
  it with its own `modules` handle, inside its own action transaction.

It is the **same function** the capability's `create()` closes over — one
implementation, two callers, no fallback and no divergence. It is recorded here,
in ADR-030 and in the package README as
`HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES`, and
`tests/work-operations-evidence.test.js` asserts that an undeclared *package*
consumer is still refused.

## 10. Policy and idempotency

**No versioned policy in v1, and that is a decision, not an omission.** A policy
earns its fingerprint when consumers need to share a rule. These three do not:
Lead qualification wants "Follow up with <name>" due at a caller-supplied instant,
Lifecycle wants "<intent> follow-up" with no due date at all, and Service wants
"Handle <level> escalation on case <n>" — also with no date. There is no shared
threshold, no branch and nothing to version. A workflow DSL is refused outright.
If a consumer arrives needing a shared rule, it becomes a code-first,
synchronous, deterministic, fingerprinted policy with its identity stored on the
record — the same contract every other policy in this repository uses — and not
before.

**Idempotency.** The caller supplies `sourceKey`, which must carry true business
identity:

| Consumer | Key |
|---|---|
| Lead qualification | `lead-qualified:<leadId>` |
| Lifecycle commercial follow-up | `lifecycle-commercial-followup:<followupId>` |
| Service escalation | `service-escalation:<escalationId>` |

Neither contains `now()`: each is derived from a **committed record id**.

**Corrected by REVIEW-70 (ADR-030 addendum 1).** This plan originally enforced
that with a validator refusing any ISO-8601 instant or any run of 13+ digits in a
key. That regex is gone. It is not a property of a moving key, only of some
strings that resemble one, and it refused real business identities: 13-digit
customer numbers, provider event ids, 16-digit order numbers, and business events
whose *scheduled* instant is deliberately part of their identity and is stable
under every retry. Carrying M16a's one-domain bug fix forward as a universal
restriction on a **generic** capability was the wrong trade.

The guarantee now lives where the identity does. Work refuses only what it can
actually judge — structurally invalid syntax and unbounded length — and each of
the three keys above is proven stable under retry at two different clock instants
in `tests/work-source-key-stability.test.js`.

- **same key + same payload** → the existing task and its creation activity are
  returned, `replayed: true`, no second row, no second audit event. This is the
  lost-response retry, and it is tested as one.
- **same key + divergent payload** → `409 WORK_FOLLOW_UP_CONFLICT` **naming the
  fields that differ** in `details.conflictingFields`. Recorded work is never
  silently overwritten. The comparison is the **whole** semantic identity —
  `title`, `dueAt`, `subjectResource`, `subjectId`, `subjectOwner`,
  `subjectOwnerPackage`, `sourcePackage`, `sourceAction`. REVIEW-70 found it
  reading only the first four, so a key could be replayed under a different
  subject owner or a different source package and be answered "already done"
  while the row said otherwise. `subjectLabel` is the one deliberate exclusion:
  the contract declares it a display snapshot, so a replay that differs only by a
  renamed subject is honoured and the stored snapshot is not rewritten.
- **a new business round** creates a new task under an explicit new identity —
  Lifecycle's key contains the follow-up record's id, and a second round is a
  second follow-up record, so genuinely repeated work is never collapsed.

## 11. Robustness

- **Fault injection after every significant write** — after the task insert,
  after the activity insert, after the caller's own managed write, and after the
  audit write: no partial Task/Activity pair, no fake success audit, an honest
  failed trace, and a safe retry that produces exactly one complete result.
- **The transaction the pair depends on is verified** (REVIEW-70). Every claim
  above holds *inside* a transaction, and outside one none of them did: each
  managed write commits on its own savepoint, so a fault between the two left a
  committed Task with no Activity. Confirmed by injecting exactly that fault with
  no transaction open. `createFollowUp` now proves an open transaction on the
  module service's own connection before the first write and refuses `500
  WORK_TRANSACTION_REQUIRED` otherwise — the fault-injection claims are therefore
  claims about the only state the package can now be called in.
- **Two-connection races** — two applications on one database file, both
  qualifying the same lead and both requesting the same follow-up: one winner,
  the loser replays the winner's row, and no raw SQLite text reaches a client.
- **Whole-caller rollback** — a consuming action that fails *after* the follow-up
  is created rolls back the task and the activity with its own writes. Proven by
  injecting the failure into the consuming action, not into Work.

**Exact reads.** Correctness reads use `listWhere` / `countWhere`, never a paged
list, and are proven past 500 rows where a collection decides the answer:

| Read | Exact? |
|---|---|
| `sourceKey` uniqueness on follow-up creation | **yes** — proven past 500 rows |
| the subject timeline (`subjectResource` + `subjectId`) | **yes** — proven past 500 rows |
| the second consumer's per-subject uniqueness | **yes** — proven past 500 rows |
| loading a task by id for an action | **N/A** — a primary-key lookup. A 500-row test would prove nothing about an indexed unique read and is deliberately not written |
| open-task limit | **N/A** — Work v1 has no open-task limit. Adding one to make a collection read exist would be inventing a rule to test |

## 12. Consumers

**Consumer 1 — Lead qualification** (host action, project source). Qualifying a
lead opens exactly one follow-up on that lead. This is the migration of the
bespoke slice: same business event, same one-task guarantee, now with a subject
envelope, a transition table, an Activity row and a read-only public record.

**Consumer 2 — Lifecycle `request-commercial-followup`** (package, through
`follow-up@1`). Recording a commercial follow-up request *is* an ask for a human
in Commercial to do something; M16a already calls it "a governed handoff" and
gave it a terminal state so it would not become "a queue of things nobody can
close". A task is exactly the missing half of that. Materially different from
Lead qualification in every axis that matters: a different package, a
package-owned subject rather than a host-owned one, no `dueAt` at all, a key
derived from a *record* rather than from the subject, and a caller whose own
transaction already spans two other writes.

**Consumer 3 — Service `record-escalation`** (package, through `follow-up@1`),
and it is here because of **ADR-029**, not for symmetry. That ADR's rule is that
*a contract validated by one consumer is a shape fitted to that consumer wearing
a version number*, and Lead qualification cannot validate `follow-up@1` — it
reaches the same creator through the host path, because the host is not a
package. So the capability itself would have had exactly one consumer. Service
is the second: a different package, a different subject resource, a caller whose
own transaction already spans an escalation row and a case-activity row, and a
caller-supplied `escalationKey` rather than a derived id. M15's escalation was
always honest that it "routes to nobody and pages nobody" — what it could never
say is who was going to *do* something about it, and this is that and nothing
more. The `routed: false, notified: false` in its result is still true and still
asserted.

Why not the fourth, stated so the choice is visible:

- **Delivery commercial follow-up** — M14b2's `delivery-commercial-change` is
  already resolved through Lifecycle's handoff shape; consuming it too would
  create two tasks for one human ask. Recorded as `deferred` in the Legacy
  Alignment backfill, with M16b named.
- Nothing consumes it where the business event does not actually imply human
  work: routing a lead, scoring one, syncing a catalog and activating a contract
  all create **no** task.

**No cycle.** `work` has `requires: []`. Lifecycle requires `contracts` and now
optionally `work`; Service requires `contracts` and now optionally `work`; `work`
requires neither, and nothing it does can reach back into either. The declaration
is *opt-in* (`createLifecyclePackage({ followUp: true })`,
`createServicePackage({ …, followUp: true })`) so every existing composition —
including every shipped starter database's application — boots unchanged, and a
project that opts in without composing `work` is refused **at startup** with the
unmet edge named, not at runtime inside a transaction.

## 13. Admin

A package-scoped section at `#/work`, rendering only while `/api/schema`
publishes `domains.work`:

- a **queue** of open tasks and a **detail** view;
- immutable **source and subject evidence** — resource, id, owner, owning
  package, the display snapshot with its staleness stated, source package and
  source action;
- the **Activity timeline** for the task's subject, oldest first;
- a **manual note** form, safe text only;
- **state-aware controls**: Complete and Cancel render only for an `open` task,
  because the server would refuse them otherwise. (This is the package-scoped
  exception the "Generic Admin action availability" future item already allows;
  **no generic Admin action-filtering refactor** is attempted.)
- loading, empty, error and retry states; every control disables while its
  request is in flight; the route is refresh-safe and direct-link-safe; the list
  bound is disclosed as a display bound.
- visible honest limits, rendered from the package's own `notModeled`: no
  reminders, no scheduler, no automatic notification, no secure assignment or
  RBAC, no calendar sync, no attachments.

## 14. Evidence surfaces

- **Scenario (DX6).** No new scenario document and **no change to the generic
  scenario contract**. `examples/scenarios/lead-to-won.scenario.json` is updated
  in place — `module.present: work-task` and the same `journey.count tasks`
  metric — because a second document would be a second name for one journey's
  evidence. Adding new scenario vocabulary would need its own DX Simplicity Gate
  justification and is not attempted.
- **JTBD.** Exactly two rows change status, and both only as far as the merged
  tests reach: **JTBD-07** and **JTBD-CM-04** stay *partially supported* with
  their wording narrowed to the new evidence and the word *schedule* explicitly
  still unsupported, and **JTBD-DO-08** moves *not supported → partially
  supported* for a **subject** timeline that is stated in the same breath to be
  **not unified**. **JTBD-CM-03 stays not supported**: a note is not a logged
  call, and its wording now says so rather than being promoted. Scheduler,
  reminders, calendar, email, secure assignment, workload, recurring work and
  attachments stay **not supported**, and no Communications row unrelated to this
  evidence is promoted.
- **Legacy Alignment.** A Work backfill section classifying every built domain
  and the custom-package fixture, and explicitly recording that Service's
  `support-case-activity` **stays domain-specific**, that Delivery history is
  **not unified**, and that Marketing task/journey work remains **unimplemented**.

## 15. Verification

Clean clone: `npm install`, `npm run verify`, `npm run smoke`, `npm run
gtm:check`, `crm project doctor --json`, `crm project verify --json`, `crm
package test packages/work --json`. Plus starter upgrade, old-Task-data
compatibility, absence/detach/reattach in separate processes, all three consumers,
two-connection races, the fault matrix, hostile input, the exact-read proofs, a
real-Chromium Admin smoke, links, Skill mirrors and no tracked artifacts. Node
`22.16.0` (`.nvmrc`).
