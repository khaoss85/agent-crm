# Spine v3C — first real timer consumers

This ExecPlan is a living document. Progress, decisions, validation receipts, and review corrections are updated while implementation changes.

## Goal and bounded outcome

Give the durable job store two real consumers, so scheduling stops being infrastructure with no caller. Both are timers over semantics this repository already has, and both stop exactly where a human decision begins.

1. **A follow-up that is due later.** A caller schedules follow-up work for a future instant instead of opening it now. When a worker executes the timer, it opens the follow-up task through the existing named operation — an ask for a human, which is what a follow-up has always been.
2. **Contract renewal came within notice.** A commercial contract approaching its term gets a scheduled job that opens a renewal decision in the `undecided` state, which is an ask, not an answer.

This slice adds no cron syntax, no recurrence engine, no email or calendar delivery, no operator surface, no autostarted worker, no Cloud service, and no JTBD promotion.

## The constraint this slice is built around

`tests/work-operations-e2e.test.js` pins a deliberate property: **nothing runs on a clock**. Stepping an injected clock a year past `dueAt` leaves the task row byte-identical and records no overdue activity. That test describes an application with no worker, and it stays true — a scheduled job that nobody executes changes nothing.

V3C adds the other half of the same contract, which nothing states today: when a caller explicitly starts a worker, exactly the declared effect happens, exactly once. Both halves are tested. The existing test is not weakened — it observes a task that already exists, and no timer in this slice touches an existing task at all.

## Where a timer belongs, and why not in a domain package

Two sentences in the checked-in packages decide this slice, and both were written deliberately:

- `work`: *"It schedules nothing, reminds nobody and assigns to nobody"*, and `requires: []` — *"Work is consumed, never a consumer."*
- `lifecycle`: *"Cancels nothing, schedules nothing, prices nothing and notifies nobody."*

They are not obstacles to route around. They are a division of labour the repository has held across four slices: **a domain owns what is asked; the spine owns when.** A follow-up is an ask, a renewal decision is an ask, and neither package has ever known what time it is.

A timer is therefore the composition of the two, and it belongs where both are visible: the application that composes a domain package, the job store and a worker. That is also where the campaign puts operational runtime — `app.operations.startWorkers()` is composition, not a package.

Three alternatives were considered and rejected:

1. **Add scheduling to `work`.** It contradicts both of that package's sentences at once, and turns a package that is only ever consumed into a consumer of the job store. The claim would have to be rewritten to stay true, and it is true today for a reason.
2. **Raise `lifecycle` to v3 with scheduling inside it.** Honest, and the package has moved a version for less. But it puts *when* inside a domain and breaks the symmetry the spine was built on; the next domain that wants a timer would copy it.
3. **A new package that owns timers.** That is the broad new domain this campaign forbids, and it would own semantics — what a follow-up is, what a renewal means — that already have owners.

The chosen shape leaves every package sentence literally true: `lifecycle` still schedules nothing. The *application* schedules an ask, and `lifecycle` owns the ask once it exists.

## Chosen design

Each consumer is a named V3A handler under its own job kind, registered by the caller who composes it, in the shape `registerTransactionalOutboxHandlers` already established: the composition passes `domains`, `modules` and the database, and the handler reaches a domain only through `domains.capability(...)` — the same seam `lifecycle` uses to open `work/follow-up@1`. No package imports another, and nothing self-registers: no handler is reachable without an explicitly started worker.

The intent record is a composition module, supplied through `moduleMigrations`, which are keyed by name rather than by version — so it adds no core migration and moves no frozen migration expectation.

**Enqueue is atomic with the domain mutation.** A follow-up timer is created in the same transaction as the task that carries `dueAt`; a rollback therefore leaves neither. This reuses the V3B seam rather than adding a second enqueue path.

**The ask is a record; the job carries only a reference to it.** A scheduled follow-up is persisted as a domain record — title, dueAt, subject, source — written in the same transaction as its job. The job payload keeps the shape V3B established: contract version, record id, fingerprint, and no domain content at all. Four things follow, and each is why this shape was chosen over putting the fields in the payload:

- The payload-free discipline V3B pins stays intact. Domain content in a job payload is the first step of exactly the slide those tests exist to stop.
- Cancelling and rescheduling become ordinary mutations on a visible record, and a timer that fires against a cancelled or changed one refuses on a fingerprint mismatch — the `loadSource` shape V3B already uses.
- What is scheduled is visible on a domain surface. A job payload is not.
- The follow-up's source key derives from the record id, so idempotency holds by construction: a retried call schedules one timer, and a replayed timer opens one task.

**Recovery policy is chosen, not defaulted.** Both consumers write only to the database that owns the job, in the same transaction as the job's terminal transition, so a lost acknowledgement is reconcilable rather than terminally unknown.

**System authority is named once per consumer.** Opening a follow-up and opening a renewal decision on a schedule are framework acts, so each uses one `trustedSystemActor` with a stated reason. `tests/actor-fails-closed.test.js` pins the exact list of such call sites precisely so that adding one is a deliberate, reviewed act; this slice updates that list and says why here.

## The human boundary, stated as behaviour

The boundary is not new policy: the Work package already draws it. `createFollowUp` accepts a non-human actor, because opening work to be done asks a person to decide something. `complete`, `cancel` and `add-note` call `requireHumanActor`, because they *are* the deciding. A timer therefore inherits exactly the authority it should have, and a test proves it holds:

- The follow-up timer opens a task. It never completes, cancels, annotates or reschedules one: those remain the human decisions `work-operations-e2e` already proves an agent is refused.
- The renewal timer opens a decision in `undecided`. It never writes `pursue_renewal` or `not_renewing`, and a test proves the handler cannot: the recommendation is the whole of its authority.
- Neither consumer sends anything. Delivery is not claimed.

## Evidence required before merge

- Domain mutation and scheduled job commit atomically; a rolled-back mutation leaves no job, and no task appears before its instant.
- A future job survives a full storage close and reopen, and is still due at the instant it was scheduled for.
- Due execution calls the named handler with a verified system operation context, and the effect is linked to the job, the audit trail and the task or contract it came from.
- Two workers racing one due job, and a worker restarted mid-execution, produce one business result — proved against PostgreSQL under contention, not asserted.
- Cancelling or rescheduling a timer works, and a cancelled timer never runs.
- A human-required outcome stays pending a human: the renewal decision remains `undecided` until a person moves it.
- The existing "nothing runs on a clock" property still holds with a job scheduled and no worker started: no task, no activity, nothing.
- The timer cannot close what it opens: completing, cancelling or annotating from the timer's own authority is refused.

## Sequencing

The scheduled follow-up is built and proved first, in full. The renewal review follows on the same seams. If only the first lands, this document says so and the slice merges with that scope stated rather than with two half consumers.

## Open question this slice may have to answer

`TASKS.md` carries a deferral from V3B: the published absence `durable jobs, outbox or scheduler (Spine v3)` reads two ways now that the default write path enqueues effects, and the integration PR was to disambiguate it. A domain timer is the first thing a person would call a *scheduler*, so V3C may be where that stops being deferrable. Decide it deliberately when the first consumer lands, rather than discovering it in a review.

## Progress

Started from `2c8bc33`, the merge of V4B, with V3A/V3B and V4A/V4B on main and CI green there.

**Design complete, implementation not started.** The design above was reached by exploring three constraints in sequence, each of which invalidated the shape before it: the closed activity vocabulary (so a timer records no overdue entry), the payload-free discipline (so the ask is a record and the job carries a reference), and the two package claims quoted above (so the timer composes rather than joins a domain). Writing any of it as code before those were known would have produced a slice that had to be taken apart in review.
