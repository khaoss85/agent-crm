# Record actions

A **record action** is a lifecycle operation on one record that is more than a
field edit: qualify a lead, close an opportunity, approve a renewal. Actions are
ordinary checked-in JavaScript — the framework supplies the transaction, event
and trace envelope around them, not an interpreter over a config format.

See ADR-011 (the action contract) and ADR-012 (the event outbox) in
`DECISIONS.md` for why it is built this way.

## Defining an action

An action is a plain object registered in `packages/actions/generated/index.js`:

```js
export const qualifyLead = {
  module: 'lead',                 // target generated module
  name: 'qualify',                // canonical: ^[a-z][a-z0-9-]*$
  label: 'Qualify lead',          // shown on the Admin button
  description: 'Mark the lead qualified and open the first follow-up task.',
  actionContract: 1,
  stateField: 'status',           // record field holding lifecycle state (default: 'status')
  fromStates: ['new'],            // states the action is allowed from; omit for "always"
  input: [{ name: 'dueAt', type: 'timestamp', required: true }],
  async execute({ record, input, actor, modules, managed, now }) {
    const lead = await managed(record.id, { status: 'qualified', qualifiedAt: now() });
    const task = await modules.get('task').service.create({ /* … */ }, { actor });
    return { lead: { id: lead.id, status: lead.status }, task: { id: task.id } };
  },
};
```

Input field types are `string`, `timestamp`, `enum` (which requires
`values`) and `integer`.

- **Timestamps** use one canonical form: a UTC ISO-8601 instant
  `YYYY-MM-DDTHH:MM:SS(.mmm)?Z`. Offsets (`+02:00`), date-only forms and
  space-separated datetimes are rejected — one canonical form avoids
  server-local-time ambiguity. The calendar date must be real: JavaScript's
  `Date` would silently roll `2026-02-30` into March 2, so the parsed value is
  round-tripped and must reproduce the input exactly.
- **Strings** are trimmed of outer whitespace (inner whitespace preserved) and
  bounded at 10 000 characters; the HTTP body limit (1 MB) bounds the request
  as a whole. Blank and missing are treated the same: a required field that is
  absent, `null`, `''` **or whitespace-only** is a `400`.
- **Integers** accept JSON safe integers only — numeric strings, fractions,
  `NaN`/`Infinity` and unsafe magnitudes are `400`s — so money stays integer
  minor units (`valueCents`) end to end. Zero is a value, not "missing". Sign
  policy (e.g. non-negative) belongs to the action's own validation. The Admin
  renders integer inputs as number controls and posts JSON numbers.

### The `execute` context

| Key | What it is |
| --- | --- |
| `record` | The target record, already loaded and state-checked. |
| `input` | The validated, normalized input (trimmed strings, ISO-normalized timestamps). |
| `actor` | The calling identity, to be passed through to every service call. |
| `managed(id, patch)` | The **only** way to write workflow-managed fields (below). |
| `modules` | The module registry — `modules.get('task').service` for cross-module writes. |
| `services` | The handwritten core services (companies, contacts, opportunities, approvals). |
| `core` | Declared adapters over the handwritten core CRM modules (ADR-013): `findCompaniesByNormalizedName`, `findContactByEmail`, `createCompany`, `createContact`, `createOpportunity`. The only sanctioned way for an action to create or reuse core records — writes go through the real services, so audit and events are preserved. |
| `database`, `config` | Escape hatches; prefer services so validation and audit are preserved. |
| `now()` | The framework clock (ISO-8601 UTC). Use it for timestamps like `qualifiedAt` so time is injectable and consistent with the rest of the framework. |
| `step(name, output)` | Record an extra named span in the workflow trace. |

## What the runtime guarantees

- **Atomic.** Every business write runs inside one outer transaction; the
  generated services' savepoints nest inside it. If anything throws, all of it
  rolls back — no partial state, no audit, no events.
- **Events after commit.** Events emitted during `execute` are held in a
  **transaction-scoped in-process buffer** and dispatched only once the
  transaction commits (ADR-012). A subscriber never observes a half-applied
  action. This is *not* a durable outbox: a process crash after the commit but
  before the flush loses delivery — do not rely on these events for remote
  integrations.
- **A post-commit subscriber failure is not a business failure.** Once the
  transaction has committed, a throwing subscriber cannot turn the action into
  an error (the caller would retry a change that already succeeded). The flush
  dispatches every queued event even when a handler fails — a failing handler
  stops only its own event's remaining handlers — and the failures are recorded
  as a failed `events.dispatch` span on the (completed) run, plus a stderr log.
- **Always traced, best-effort.** A workflow run and its spans are written
  after the transaction resolves, success or failure — so a failed action still
  leaves a diagnostic record; the *validated input* (including e.g. a
  disqualification reason) is recorded in the trace for debuggability. The
  trace is deliberately *not* transactional with the business writes: a
  trace-write failure is logged, never thrown, and on a failed run the spans
  recorded before the failure describe execution progress whose writes were
  rolled back — the run-level status is authoritative.
- **No nesting.** An action cannot invoke another action (and no second outer
  transaction can start inside one): both the event buffer and the database
  layer reject nesting with a clear error. Compose module services inside one
  `execute` instead.
- **Fail closed at startup.** A malformed definition stops the app rather than
  exposing a half-working action.

Note what the runtime does **not** do: it does not retry, schedule, compensate
or deduplicate. Idempotency is the action's own job, expressed in data — see
below.

## Managed fields: no CRUD bypass

An action that owns a lifecycle needs that state to be unreachable through
generic CRUD. Declare the field `managed` in the manifest:

```json
{ "name": "status", "type": "enum", "values": ["new", "qualified", "disqualified"],
  "writable": "managed", "default": "new" }
```

Then, at the **service boundary** — not merely hidden in the Admin:

- `create` sets it from `default` and never from input; `update` ignores it;
- either one **rejects** the field if it appears in the input, with a field-tied
  `VALIDATION_ERROR`;
- the generated service's `applyManaged(id, patch, ctx)` is the single
  privileged write path. It is in-process only, never routed over HTTP, and
  reachable from `execute` as `ctx.managed`. Passing `null` clears an
  *optional* managed field; clearing a *required* one is a field-tied
  validation error, not a SQL crash. It validates only managed fields —
  public fields in the patch are unknown keys and are ignored, exactly like
  unknown input elsewhere.

`applyManaged` is trusted in-process code, deliberately callable outside an
action (the same trust level as any service method — repository source is the
trust boundary, per ADR-008's threat model). What it can never do is travel
over a public surface: it is not a generated-resource capability, not routed,
not in the SDK, and not exposed via MCP.

So `PATCH /api/modules/lead/records/:id` with `{"status": "qualified"}` is a
`400` from any client. The Admin additionally renders managed fields read-only,
but that is presentation, not the enforcement.

## Idempotency and concurrency

The framework does not deduplicate for you. Express it in data instead — the
Lead starter gives its follow-up Task a **unique** `sourceKey` of
`qualify:<leadId>`:

- a **repeat** qualify is rejected by `fromStates` (the lead is no longer `new`)
  with a `409`, and the unique key blocks it at the data layer even if the state
  guard were removed;
- two **concurrent** qualifies resolve to exactly one success and exactly one
  Task; the loser gets a `409` — within one server via `BEGIN IMMEDIATE`
  serialization plus the state guard, and across separate connections/processes
  on the same SQLite file via the write lock: the loser surfaces a stable
  retryable `409 CONFLICT` ("database is busy with a concurrent write"), never
  a raw `SQLITE_BUSY` error.

`sourceKey` is deliberately a *public* Task field: a squatting CRUD write can
only block a qualification with a visible `409` on a trusted local surface,
never forge one, and keeping it public avoids a second privileged write path.

## Calling an action

**HTTP** — `POST /api/modules/:module/records/:id/actions/:action`:

```bash
curl -X POST http://localhost:4000/api/modules/lead/records/$ID/actions/qualify \
  -H 'content-type: application/json' \
  -H 'x-actor-type: user' -H 'x-actor-id: alessandra' \
  -d '{"dueAt":"2026-08-12T09:00:00Z"}'
```

```json
{ "ok": true, "module": "lead", "action": "qualify", "recordId": "…",
  "runId": "…", "result": { "lead": { "status": "qualified" }, "task": { "id": "…" } } }
```

**SDK** — `client.module(name).action(id, actionName, input)`:

```js
await client.module('lead').action(leadId, 'qualify', { dueAt: '2026-08-12T09:00:00Z' });
```

**In process** — `app.runAction({ module, action, recordId, input, actor })`.
All three share one implementation.

### Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Bad or missing input, or a managed field sent through CRUD. `details.field` names it. |
| `404` | `NOT_FOUND` | Unknown module, unknown action, or unknown record. |
| `409` | `INVALID_STATE` | The record's state is not in the action's `fromStates`. |

Failures carry `details.workflowRunId`, so the trace for a failed attempt is
retrievable via `GET /api/traces/:id`.

## In the Admin

The record detail renders one button per action valid for the record's current
state, built entirely from the schema's `actions` metadata — there is no
per-module page. Actions with input reveal a small form; on success the detail
re-renders so the new state and the newly valid actions appear together.

## Worked example

`examples/starters/b2b-lead-qualification/` is a complete, runnable example:
two manifests, three actions (qualify, disqualify, and `convert` — which
creates or deterministically reuses a Company and Contact and opens exactly
one Opportunity through the `ctx.core` adapters, ADR-013), and an
`install.mjs` that builds a clean throwaway project and verifies every
guarantee above.
