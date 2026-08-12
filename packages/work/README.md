# `work` — tasks and activity evidence

Two records, three human actions and one declared capability.

| | |
|---|---|
| Owns | `work-task`, `work-activity` |
| Requires | **nothing** |
| Offers | `follow-up@1` |
| Actions | `work-task.complete`, `work-task.cancel`, `work-task.add-note` |
| Policies | none |
| ADR | ADR-030 · ExecPlan `docs/plans/activity-task-operations.md` · guide `docs/WORK_TASKS.md` |

## What it is

A **Task** is a unit of human follow-up work arising from a business event. An
**Activity** is an append-only, user-facing entry on a subject's timeline. A
domain action that has just decided something opens a follow-up **inside its own
transaction**, and the work appears in one queue with one lifecycle instead of in
a new table per domain.

## What it is not

Stated here, in `metadata().notModeled`, and asserted as absent by the tests:

> no scheduler · no reminders · no due-date alerts · no recurring or repeating
> work · no calendar sync · no meetings or calls · no email, SMS, WhatsApp or
> chat · no notifications · **no assignment, ownership, workload or capacity** ·
> no RBAC · no subtasks, dependencies or projects · no attachments · **no
> unified cross-domain timeline** · no job queue · no delayed workflows.

Nothing in this package runs on a timer, sends anything, or tells anybody. A task
is only ever moved by a person.

## Enable it

```bash
npm run crm -- module create packages/work/modules/work-task.module.json --apply
npm run crm -- module create packages/work/modules/work-activity.module.json --apply
```

```js
// packages/domains/generated/index.js
import { createWorkPackage } from '../../work/src/index.js';

export const generatedDomains = [
  createWorkPackage(),
  // a consuming package opts in explicitly:
  createLifecyclePackage({ followUp: true }),
  createServicePackage({ policies: [...], followUp: true }),
];
```

Removing the `createWorkPackage()` line removes the actions, the capability and
the schema block. **It leaves every row**: the framework never drops your tables.

## The Task lifecycle

An explicit transition table, published in the schema and in `app inspect`:

```text
open  →  completed        work.complete   (human actor)
open  →  cancelled        work.cancel     (human actor, reason required)
completed → nothing
cancelled → nothing
```

- **`open → completed` is direct.** An `in_progress` state would change no read,
  no action and no refusal, so it would be a label that also forces a rule nobody
  asked for.
- **There is no reopen.** A repeated business round is a new task under a new
  source key. Un-completing work would need a second lifecycle this package does
  not have, and a `409 INVALID_STATE` naming the allowed moves is the honest
  answer instead.
- **`dueAt` is evidence only.** No clock changes a status. A task past its due
  date is still `open`, and stays open until a person moves it.

## The Activity vocabulary

Closed, four entries: `task_created`, `task_completed`, `task_cancelled`, `note`.

The first three are written in the same transaction as the transition they
describe. A `note` is the one place free text enters — bounded, control-character
free, rendered as text and **sent nowhere**.

**Activity is not the audit log.** Audit and trace stay the technical record of
every write; this is the curated user-facing one. Nothing projects one into the
other, and nothing could: the event bus dispatches after commit (ADR-012), so a
projection would either escape the originating transaction or need Jobs/Outbox,
which does not exist.

## The subject envelope

```text
subjectResource      "lead", "service-escalation", "commercial-followup"…
subjectId            the record id
subjectOwner         "host" | "package"
subjectOwnerPackage  the owning package, when subjectOwner is "package"
subjectLabel         a display snapshot, taken once, never refreshed
sourcePackage        who created the task ("host" for a host action)
sourceAction         which action
```

`subjectOwner` keeps the Package Contract's distinction between a
**host/project-owned** record (a Lead: it belongs to the project) and a **foreign
package-owned** one (a `service-escalation`: it disappears with Service).

**`SUBJECT_REFERENCE_NOT_ENFORCED`.** SQLite cannot enforce a foreign key whose
target table varies per row, and this package does not pretend it can. What makes
the envelope trustworthy is *who wrote it*: the domain action that owns the source
record, running on that record, in the transaction that is about to commit.
Nothing stops that record being deleted afterwards, and a task whose subject is
gone still reads as a task. Work reports the envelope as recorded; it never
claims the subject still exists.

## `follow-up@1`

```js
requires: [{ package: 'work', capability: 'follow-up', version: 1 }],
```

```js
const work = domains.capability({
  consumer: 'my-package',
  capability: 'follow-up',
  version: 1,
  context: { modules, actor, now },   // YOUR runtime handles
});

const { task, activity, replayed } = await work.createFollowUp({
  sourceKey: `my-package-thing:${record.id}`,   // business identity, never a clock
  title: 'Something a person must do',
  dueAt: null,                                   // evidence only, and optional
  subject: { resource: 'my-record', id: record.id, owner: 'package', ownerPackage: 'my-package' },
  source: { package: 'my-package', action: 'my-action' },
});

work.findBySourceKey('my-package-thing:123');    // exact read, or null
```

Because the capability is created with **your** `modules` handle, both rows are
written inside **your** transaction. If your action fails afterwards, the task
and its activity roll back with your own writes — and that is *checked*: a call
that cannot prove an open transaction on the same connection is refused `500
WORK_TRANSACTION_REQUIRED` before the first write, so no half pair can exist
(ADR-030 addendum 1).

`source.package` is bound to the consumer identity the registry resolved, not
read from your request body: asserting a different one is `403
WORK_SOURCE_PACKAGE_MISMATCH`. It is a narrowing, not authentication — see
`metadata().capability.bindingLimitation`.

### Idempotency

- **Same key, same payload** → the existing task and its creation activity,
  `replayed: true`. That is the lost-response retry, and it is safe however many
  times it happens.
- **Same key, any different semantic field** → `409 WORK_FOLLOW_UP_CONFLICT`,
  `details.conflictingFields` naming each one. The semantic identity is `title`,
  `dueAt`, `subjectResource`, `subjectId`, `subjectOwner`, `subjectOwnerPackage`,
  `sourcePackage` and `sourceAction`. Recorded work is never silently
  overwritten, and it is never handed to a different package under the same key.
- **Same key, only a different `subject.label`** → replayed. The label is the one
  field the contract declares a non-authoritative display snapshot, and the
  stored one is not refreshed.
- **A new business round** → a new key, and a new task. Repeated work is never
  collapsed.
- **There is no clock heuristic on a key.** An earlier cut refused any ISO
  instant and any run of 13+ digits, which also refused 13-digit customer
  numbers, provider event ids, 16-digit order numbers and business events whose
  scheduled instant is genuinely their identity. A generic capability cannot tell
  a moving key from a stable one by looking at it. **You** own a stable business
  identity — derive it from a committed record id, never from `now()`, and prove
  it with your own retry test, as every consumer here does in
  `tests/work-source-key-stability.test.js`.
- **An impossible `dueAt` is refused**, never rolled over: `2027-02-30` is a `400`
  rather than a row quietly stored as 2027-03-02.
- **`MANUAL_NOTES_ARE_NOT_IDEMPOTENT`** — a note carries no key, because two
  identical notes are two statements.

### The host application is not a package

`PackageRegistry.capability({ consumer })` resolves `consumer` against
**registered packages**. A host action in project source — the starter's
`qualify` — is not one, and cannot declare a requirement. Rather than weaken the
declaration check, which is the entire value of the seam, the project composes
the package's exported creator directly, exactly as
`packages/domains/generated/index.js` composes the package itself:

```js
import { createFollowUp } from '../../../../packages/work/src/index.js';
await createFollowUp({ modules, actor, now }, { /* the same request */ });
```

It is the same code the capability closes over. One implementation, two callers,
no fallback. Published as `HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES`.

## Human-actor boundary

`complete`, `cancel` and `add-note` require `actor.type === 'user'`; an agent
actor is refused `403 HUMAN_APPROVAL_REQUIRED`. **This is not RBAC, not
authentication and not secure assignment** — a local caller sets its own actor
header. What it buys is that an agent cannot silently close somebody's work.

Automatic creation through `follow-up@1` does **not** require a human actor: the
consuming action's own boundary already decided that, and re-deciding it here
would make Work an authorization layer, which it is not.

## Migrating the bespoke Lead Task

The B2B starter used to ship its own `task` module (table `tasks`, a **required**
`leadId` reference, `status` in `open`/`done`, every field publicly writable). It
is gone, replaced rather than evolved: Module Evolution is additive and
forward-only, so a required reference to `leads` cannot be relaxed into a generic
subject.

**The old table is never touched.** Nothing here issues DDL against `tasks`, an
existing database still opens, and every historical row is still readable.
`packages/work/src/legacy-tasks.js` adopts them forward:

```js
import { migrateLegacyTasks } from './packages/work/src/legacy-tasks.js';

migrateLegacyTasks({ database: app.database, modules: app.modules, actor, now });                 // dry-run plan
migrateLegacyTasks({ database: app.database, modules: app.modules, actor, now }, { apply: true }); // writes
```

Dry-run by default, idempotent (`legacy-task:<id>`), `done → completed`, `leadId
→ subject { resource: 'lead', owner: 'host' }`, and a row whose status it cannot
map is **refused and named** rather than guessed. A migrated `done` task carries
no completion actor or instant, because the legacy row recorded neither.

## Related

`docs/WORK_TASKS.md` · `docs/plans/activity-task-operations.md` · ADR-030 ·
`docs/PACKAGE_AUTHORING.md` · `docs/ACTIONS.md`
