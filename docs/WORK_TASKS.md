# Work: tasks and activity evidence

**Work v1 (ADR-030), the `work` package.** Follow-up work a person must do, and
an append-only record of what happened to it — one model every domain shares
instead of a bespoke task table per domain.

- Package: [`packages/work`](../packages/work/README.md)
- ExecPlan: [`docs/plans/activity-task-operations.md`](plans/activity-task-operations.md)
- ADR: **ADR-030** in `DECISIONS.md`

## What it is, in one paragraph

A **Task** is a unit of human follow-up work arising from a business event, held
against an opaque *subject envelope* rather than a foreign key. An **Activity**
is an append-only, user-facing entry on that subject's timeline, from a closed
four-entry vocabulary. A domain action that has just decided something opens a
follow-up **inside its own transaction**, through one declared capability.

## What it is not

Nothing here runs on a timer, sends anything, or tells anybody. A task is only
ever moved by a person. Every one of these is published in the package's own
`metadata().notModeled`, stated on the Admin screen, and asserted as absent by
`tests/work-operations-e2e.test.js`:

| Absent | Absent | Absent |
|---|---|---|
| scheduler | reminders | due-date alerts |
| recurring or repeating work | calendar sync | meetings and calls |
| email · SMS · WhatsApp · chat | notifications | assignment and ownership |
| workload or capacity | RBAC | subtasks and dependencies |
| projects | attachments and file storage | a unified cross-domain timeline |
| a job queue | delayed workflows | |

There is **no assignee field at all**. "Who does this" is not a question this
package can answer, and nothing in it should ever be described as secure
assignment.

## The records

### `work-task`

Every field is `writable: "managed"`, so the module is generated read-only:
capabilities `["get", "list"]`, no public `create`, no public `update`, `POST`
and `PATCH` fail closed on every route even with an empty body. A task exists
only through the package's actions or its follow-up capability.

```text
sourceKey            the caller's business identity, unique
title                what a person has to do
status               open | completed | cancelled
dueAt                evidence only — see below
subjectResource      "lead", "service-escalation", "commercial-followup"…
subjectId            the record id
subjectOwner         host | package
subjectOwnerPackage  the owning package when subjectOwner is "package"
subjectLabel         a display snapshot, taken once, never refreshed
sourcePackage        who opened it ("host" for a host action)
sourceAction         which action
openedByType/ById/At who opened it, and when
completedBy/At       set only by `complete`
cancelledBy/At       set only by `cancel`
closingReason        the note or reason the closing action carried
```

### `work-activity`

Also entirely managed, also read-only in public, and **append-only in the strict
sense**: no action in this package updates or deletes one.

```text
sourceKey            deterministic for a lifecycle entry; null for a note
kind                 task_created | task_completed | task_cancelled | note
subjectResource/Id   the subject this entry is on
taskId               the task it describes
body                 the note text, or null
occurredAt           the business instant
actorType/actorId    who
sourcePackage/Action which action wrote it
```

## Audit versus Activity

They are different evidence, for different readers, and the package keeps them
apart by construction.

| | Audit / trace | Activity |
|---|---|---|
| Reader | an engineer or an agent reconstructing what the system did | a user reading what happened on a record |
| Vocabulary | open — every module write, every action run | **closed**: four kinds |
| Completeness | exhaustive | curated; most writes produce none |
| Written by | the kernel, automatically | a Work action or the capability, explicitly |
| Free text | no | only in a `note` |

**There is no asynchronous projection engine, and there could not be one here.**
The event bus dispatches *after* commit (ADR-012), so a projection would either
write outside the originating transaction or need Jobs/Outbox, which does not
exist. Every Activity row is written inside the transaction of the action that
caused it.

## The transition table

```text
open       → completed        work-task.complete   human actor
open       → cancelled        work-task.cancel     human actor, reason required
completed  → nothing
cancelled  → nothing
```

Published in `/api/schema` and in `crm app inspect --json` through each action's
`fromStates` / `toState`. It is a table, not a rank: every move out of a terminal
state is a `409 INVALID_STATE` naming the state the record is in.

**`open → completed` is direct, deliberately.** An `in_progress` state would
change no read, no action and no refusal in this version, so it would be a label
that also forces a rule nobody has asked for.

**There is no reopen.** A repeated business round is a new task under a new
source key. Un-completing work needs a second lifecycle — who reopened, why, is
this the same work, does the original completion evidence survive — and inventing
one so the verb existed would be worse than refusing.

**`dueAt` is evidence only.** No clock changes a status; a task past its due date
is still `open`. A read-only `due`/`overdue` may be computed at an injected
instant and never writes.

## The subject envelope

SQLite cannot enforce a foreign key whose target table varies per row, and this
package does not pretend it can (`SUBJECT_REFERENCE_NOT_ENFORCED`).

What makes the envelope trustworthy is **who wrote it**: the domain action that
owns the source record, running on that record, in the transaction that is about
to commit. Nothing stops that record being deleted afterwards, and a task whose
subject is gone still reads as a task. Work reports the envelope as recorded; it
never claims the subject still exists.

`subjectOwner` keeps the Package Contract's distinction
(`docs/PACKAGE_AUTHORING.md` §4) between a **host/project-owned** record
dependency — a Lead belongs to the project — and a **foreign package-owned** one
— a `commercial-followup` disappears with Lifecycle.

There is deliberately **no generic resolver and no service locator**. One would
be justified if two real consumers needed identical resolution behaviour; neither
does.

## `follow-up@1`

```js
requires: [{ package: 'work', capability: 'follow-up', version: 1 }],
```

```js
const work = domains.capability({
  consumer: 'my-package', capability: 'follow-up', version: 1,
  context: { modules, actor, now },
});
const { task, activity, replayed } = await work.createFollowUp({
  sourceKey: `my-thing:${record.id}`,
  title: 'Something a person must do',
  dueAt: null,
  subject: { resource: 'my-record', id: record.id, owner: 'package', ownerPackage: 'my-package' },
  source: { package: 'my-package', action: 'my-action' },
});
```

The capability is created with **your** `modules` handle, so both rows are
written inside **your** transaction: if your action fails afterwards, the task
and its activity roll back with your own writes. It returns a frozen object with
two methods and hands out no service, table or query handle.

That guarantee is **verified, not assumed**. Called with no transaction open —
from a script, from a `prepare` phase, from a consumer that forgot — each managed
write would commit on its own savepoint and a fault between them would leave a
task with no activity. So a call that cannot prove an open transaction on the
same connection is refused `500 WORK_TRANSACTION_REQUIRED` before the first
write. There is no way to opt out of the check (ADR-030 addendum 1).

`source.package` is **not** taken from your request body. The registry hands the
consumer identity it resolved — against your own declared `requires` — to this
capability, and that is what is stored; a request asserting a different package
is refused `403 WORK_SOURCE_PACKAGE_MISMATCH`. This is a narrowing, not
authentication: the registry cannot tell which package's *code* is running, so it
raises the floor from "any package name" to "a package that also declared this
capability" and says so in `metadata().capability.bindingLimitation`.
`source.action` and `subject.ownerPackage` are still yours to assert.

### Idempotency

| Case | Answer |
|---|---|
| same key, same payload | the existing task and its creation activity, `replayed: true` |
| same key, any different semantic field | `409 WORK_FOLLOW_UP_CONFLICT`, `details.conflictingFields` naming each one |
| same key, only a different `subject.label` | replayed — the label is a documented display snapshot, and the stored one is not rewritten |
| a new business round | a new key, and a new task — repeated work is never collapsed |
| an impossible `dueAt` (`2027-02-30`) | `400` — refused, never rolled over to the next real day |
| a manual note | `MANUAL_NOTES_ARE_NOT_IDEMPOTENT` — two identical notes are two statements |

The **semantic identity** is `title`, `dueAt`, `subjectResource`, `subjectId`,
`subjectOwner`, `subjectOwnerPackage`, `sourcePackage` and `sourceAction` — every
stored fact except `subjectLabel`, which is the one field the contract declares
non-authoritative.

**There is no clock heuristic on a source key.** An earlier cut refused any ISO
instant and any run of 13+ digits; that refused 13-digit customer numbers,
provider event ids, 16-digit order numbers and business events whose scheduled
instant is genuinely part of their identity. A generic capability cannot tell a
moving key from a stable one by looking at it, so it does not try: **you** own a
stable business identity, derive it from a committed record id, and prove it with
your own retry test.

### The host application is not a package

`PackageRegistry.capability({ consumer })` resolves `consumer` against registered
packages, and a host action in project source is not one. Relaxing that check was
rejected: the declaration check is the entire value of the seam. Instead the
project composes the package's exported creator directly, exactly as
`packages/domains/generated/index.js` composes the package itself —

```js
import { createFollowUp } from '../../../../packages/work/src/index.js';
await createFollowUp({ modules, actor, now }, { /* the same request */ });
```

— which is the same code the capability closes over. Published as
`HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES`.

## Who uses it today

| Consumer | Business event | Reached through | Key |
|---|---|---|---|
| **Lead qualification** (host, `examples/starters/b2b-lead-qualification/actions/qualify.js`) | a lead was qualified | the exported creator | `lead-qualified:<leadId>` |
| **Lifecycle** `request-commercial-followup` (`followUp: true`) | Commercial was asked to pick something up | `work/follow-up@1` | `lifecycle-commercial-followup:<followupId>` |
| **Service** `record-escalation` (`followUp: true`) | a human escalated a support case | `work/follow-up@1` | `service-escalation:<escalationId>` |

Nothing creates a follow-up where the business event does not actually imply
human work: routing a lead, scoring one, syncing a catalog and activating a
contract create **no** task.

Both package consumers are **opt-in**, because `requires` is hard and every
existing composition must keep booting unchanged. A project that opts in without
composing `work` is refused **at startup** with the unmet edge named.

## Human-actor boundary

`complete`, `cancel` and `add-note` require `actor.type === 'user'`; an agent is
refused `403 HUMAN_APPROVAL_REQUIRED`. **Not RBAC, not authentication, not secure
assignment** — a local caller sets its own actor header. What it buys is that an
agent cannot silently close somebody's work.

Automatic creation through `follow-up@1` does not require a human actor: the
consuming action's own boundary already decided that, and re-deciding it here
would make Work an authorization layer, which it is not.

## Admin

`#/work` renders only while `/api/schema` publishes `domains.work`: a queue split
into open and closed, a detail view with immutable source and subject evidence,
the subject's Activity timeline oldest-first, and a manual note form. Complete
and Cancel render **only for an open task**, because the server would refuse them
otherwise. Every limit above is on the screen.

## Migrating the bespoke Lead Task

The starter used to ship its own `task` module. It is gone; the table it wrote is
**never touched**, and `packages/work/src/legacy-tasks.js` adopts rows forward —
dry-run by default, idempotent, `done → completed`, and a row it cannot map is
refused and named. See the package README for the call, and
`tests/work-legacy-task-migration.test.js` for the proof that an old-shape
database still opens.

## Related

`docs/PACKAGE_AUTHORING.md` · `docs/ACTIONS.md` · `docs/MODULE_MANIFEST.md` ·
`docs/SERVICE_OPERATIONS.md` · `packages/lifecycle/README.md` ·
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`
