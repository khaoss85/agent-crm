# Milestone 6 — code-first CRM actions + Lead Qualification starter

## Goal and user-visible outcome

A reusable, code-first **action** contract over the existing runtime, proven by a **Lead Qualification** starter that dogfoods the framework:

```text
Capture lead → qualify (atomically creates the next follow-up Task) | disqualify (requires a reason)
```

No Lead-specific page hardcoded into the generic Admin; the action UI is rendered from action metadata.

## Current runtime (inspected — do not assume atomicity)

- **WorkflowEngine** (`packages/workflows/src/engine.js`) runs steps sequentially, writing trace spans inline. It does **not** wrap steps in an outer DB transaction, and offers manual `compensate` — not true atomicity.
- **Generated services** run each mutation in its own `SAVEPOINT` and `await events.emit(...)` **after** the savepoint releases — i.e. events fire per-mutation, before any multi-step action completes.
- **Verified**: a `SAVEPOINT` nests correctly inside `database.transactionAsync` (`BEGIN IMMEDIATE`), and rolling back the outer transaction undoes the inner savepoints. This is the mechanism for cross-service atomicity.
- **EventBus** dispatches immediately on `emit`.

Two real gaps this milestone must fix: (1) **no outer transaction** across Lead-update + Task-create; (2) **events become visible before the outer commit**.

## Approaches compared (required)

1. **Lead-specific endpoints + Admin override only.** Fast, but not reusable, duplicates route/SDK/Admin per process, and bakes product logic into the framework. Rejected.
2. **Reusable code-first module-action registry over the existing runtime (chosen).** A checked-in action registry (mirroring the module registry, ADR-007), one generic HTTP route, one SDK method, generic Admin buttons from metadata, run through a small transaction-aware action runtime. Readable source per action, deterministic metadata, no per-action boilerplate, no low-code engine.
3. **Declarative workflow/action DSL.** A generic low-code engine — explicitly out of scope and against the framework philosophy. Rejected.

Chosen: **2**. Recorded as **ADR-011** (action contract) and **ADR-012** (transaction-aware event outbox), because both are material.

## Transaction-aware events (ADR-012)

`EventBus` gains an **outbox** using `node:async_hooks` `AsyncLocalStorage` (zero dependency, correct under concurrent requests). `emit` checks the async-local store: if an action outbox is active, the event is **queued**; otherwise it dispatches immediately (backward compatible). The action runtime runs the business writes inside `database.transactionAsync` **within** `events.buffered(async () => …)`; on commit it flushes the queued events (dispatch for real), on rollback it drops them. Result: **all business writes commit or none**, and **domain events are externally visible only after the outer commit**.

## Action runtime

`packages/core/src/action-runtime.js`: `runRecordAction({ database, events, registry, services, module, action, recordId, input, actor })`:

1. Resolve the action from the registry (canonical module+action, fail closed).
2. Validate `input` against the action's declared input schema (400 on failure) — before any write.
3. `await events.buffered(async () => await database.transactionAsync(async () => { result = await action.execute(ctx); }))` — the outer transaction; generated-service savepoints nest inside it; a thrown lifecycle/validation error rolls everything back (no writes, no audit).
4. After the transaction resolves, persist a **workflow trace** (run + spans) reflecting success/failure — written *outside* the business transaction so a failed action still records a trace safely, and no partial business state can leak into it.
5. On success, flush buffered events and return `{ ok, action, module, recordId, result, runId }`. On failure, drop events and throw a normalized error carrying the run id.

`ctx` exposes `{ record, input, actor, services, database, config, managed }` where `managed` is the privileged boundary to set workflow-managed fields (below). No arbitrary service method is exposed; `execute` is trusted checked-in source.

## Field write policy (managed fields)

The smallest safe lifecycle enforcement: a manifest field may declare `"writable": "managed"` (default `"public"`) and an optional `"default"`.

- **Public create/update** (CRUD, API, SDK, Admin edit): a managed field provided in input → `VALIDATION_ERROR`. On create, managed fields take their `default` (or null). Managed fields are therefore never settable through the generic surface.
- The generated service exposes an internal `applyManaged(id, patch, ctx)` that validates and writes **only** managed fields (with audit + event), used exclusively by action `execute` through `ctx.managed`. This is not exposed over HTTP; it is trusted in-process code, not a secret token.
- Lead's `status` (enum, default `new`), `qualifiedAt` (timestamp), `disqualificationReason` (string) are managed. `status` therefore cannot be set to `qualified` via CRUD — enforced at the service boundary, not hidden in the Admin.

## Action contract (ADR-011)

Checked-in registry `packages/actions/generated/index.js` (ships with the starter's actions when applied into a project; empty in this repo). Each action:

```js
{ module: 'lead', name: 'qualify', label: 'Qualify lead', description: '…',
  actionContract: 1, input: [{ name: 'dueAt', type: 'timestamp', required: true }],
  fromStates: ['new'], confirm: false, execute(ctx) { … } }
```

Validated at app startup, fail closed: canonical `module`/`name` (`^[a-z][a-z0-9-]*$`), unique `{module, action}`, `actionContract === 1`, target module exists and is generated, input types supported (`string`/`timestamp`/`enum`), `execute` is a function, deterministic registry order, no prototype/dynamic-import/eval. One malformed action stops the app (never partial exposure).

## Schema / HTTP / SDK

- **Schema**: `generatedModules[].actions` = `[{ name, label, description, actionContract, input, fromStates, confirm, path }]` — additive under `generatedResourceContract: 1` (an older client simply ignores `actions`); deterministic, no source/functions/paths/timestamps. Contract decision documented in ADR-011.
- **HTTP**: `POST /api/modules/:module/records/:id/actions/:action` — decode once, canonical validation, generated modules only (core 404), unknown action 404, object-only body, input 400 with field details, invalid transition **409** (stable `INVALID_STATE`), normalized errors, actor propagated, no direct DB write in the route (delegates to the runtime). All CRUD routes preserved.
- **SDK**: `client.module(m).action(id, name, input)` — safe encoding, object-only input, status/code/details preserved, immutable resource, no per-module regeneration.

## Admin

Generic action controls on the record detail from `actions` metadata: a button per action valid for the record's current state (`fromStates`), each opening an input form built from the action's `input` (reusing the safe form primitives), submitting to the action route, refreshing the record on success, double-submit-guarded, errors/labels as text, keyboard accessible. No Lead-specific page; uses the generic renderer (ADR-009 override seam untouched).

## Lead & Task manifests (starter)

- **lead**: `firstName`, `lastName`, `email`, `companyName`, `source` (enum), `status` (enum `new|qualified|disqualified`, managed, default `new`), `score` (integer, optional), `disqualificationReason` (string, managed), `qualifiedAt` (timestamp, managed).
- **task**: `title`, `status` (enum `open|done`, default via managed? kept public `open` at create by the action), `dueAt` (timestamp), `leadId` (reference → lead, required), `sourceKey` (string, **unique**) — the deterministic idempotency key (`qualify:<leadId>`) that prevents duplicate follow-up tasks under repeat/concurrent qualification. Not unique on `leadId`, so a lead may have many tasks later.

## Qualify / Disqualify semantics

- **qualify** (from `new` only): validate `dueAt`; set `status=qualified`, `qualifiedAt=now`, clear `disqualificationReason`; create exactly one Task (`open`, `dueAt`, deterministic title, `sourceKey=qualify:<leadId>`); atomic; one audit + one event per write, flushed post-commit; returns updated Lead + Task ids. Repeat → the Task `sourceKey` unique constraint yields a **409** with no extra Task/audit/event. Concurrent → exactly one success (the outer `BEGIN IMMEDIATE` serializes writers and the unique key blocks the second).
- **disqualify** (from `new` only): require non-blank `reason`; set `status=disqualified`, `disqualificationReason=reason`, clear `qualifiedAt`; **no Task**; atomic. Invalid transition (not `new`) → 409, no mutation. No reopen action (out of scope).

## Starter

`examples/starters/b2b-lead-qualification/`: `lead.module.json`, `task.module.json`, `actions/` (qualify/disqualify definitions), `README.md`, and a reproducible `install.mjs`/documented commands that build a clean temp project, apply both modules, register the actions, and run the e2e check. No demo records mixed into the default DB.

## Milestones

- [x] ExecPlan (this document).
- [x] EventBus outbox (ADR-012) + action runtime.
- [x] Factory managed-field write policy.
- [x] Action registry + contract validation (ADR-011).
- [x] Server route + SDK method + schema `actions`.
- [x] Admin generic action controls.
- [x] Lead Qualification starter + install/verify script.
- [x] Tests (unit + e2e: atomicity, repeat, concurrent, disqualify, CRUD-bypass, restart).
- [x] Docs (actions, starter, API, SDK, Admin, JTBD) + ADR-011/012.
- [x] `npm run verify` + `npm run smoke` green.

## Discovered during implementation

**A pre-existing HTTP bug, fixed here.** The response dispatcher read
`result?.status ?? 200` and `result?.body ?? result`, so a handler returning a
domain object that carries a `status` field had that value used as the HTTP
status code. It was unreachable only because no generated module had yet used a
field named `status`; the Lead module (`new|qualified|disqualified`) made
`GET /api/modules/lead/records/:id` fail with `Invalid status code: qualified`.
Handlers now return either a bare payload (served as 200) or an envelope tagged
with a module-private `Symbol` via `respond(status, body)`, so no domain object
can be mistaken for an envelope whatever its field names. Note this also made
the workflow-run routes safer: a run object carries `status: 'completed'` and
was previously safe only because it happened to be wrapped by hand.

**Concurrency, as measured rather than assumed.** Two concurrent qualifies
resolve to exactly one success and one `409`, with exactly one Task — the outer
`BEGIN IMMEDIATE` serializes the writers and the loser then fails its
`fromStates` check. The unique `sourceKey` is retained as defense in depth
rather than as the primary mechanism.

## Explicitly deferred

Lead conversion, Company/Contact/Opportunity, pipeline/stages, general task engine, reminders, reopen, workflow DSL, scheduling, retries, sagas, many-to-many, and everything in the task's out-of-scope list.
