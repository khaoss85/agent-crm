# Production Spine v2 M2F — recoverable cross-plane Spine audit

This ExecPlan follows `.agent/PLANS.md`. It owns two bounded M2 requirements:
M2-07's recoverable Organization/Membership audit and M2-01's
`spine-store.js` storage-seam closure. It does not own M2E contract graphs, the
rest of M2F's deployment loader and entry points, PostgreSQL, leases, a general
outbox, shared-database tenancy, Spine v3 or Spine v4.

## Goal and user-visible outcome

An Organization or Membership mutation must not tell its caller that it rolled
back when the control row actually committed and only the separate tenant audit
write failed. The control mutation and an immutable audit intent commit in one
control transaction. Immediate delivery writes exactly one audit event when the
current application owns the destination. A failure leaves visible pending
evidence and returns the committed entity with the additive receipt:

```text
auditDelivery: {
  status: "committed_with_pending_audit",
  intentId: <opaque deterministic id>,
  code: <bounded stable code>
}
```

Successful delivery preserves the released Organization and Membership key
sets exactly. Explicit reconciliation is tenant-scoped, bounded per pass,
restart-safe, independently reports each failure and publishes the exact total
still pending.

## Current repository context and reproduced failure

The slice started from `9a4a5c1d449e7baf8c5c328fa0f459d223fe351f`
after M2D. `packages/core/src/spine-store.js` wrote Organizations and
Memberships to the control database, then called the data-plane audit object.
The files cannot share a transaction. A probe made the audit insert throw during
`bootstrapOwner` and observed all three at once:

```text
control membership: active
matching data audit rows: 0
caller result: thrown sentinel error
```

That is a false rollback over committed authorization state. The same file also
owned the remaining Spine SQL directly. Its Organization and Membership
statements all fit Storage Contract v1's existing insert/select/count/update,
equality/null/membership predicates, ordering, bounded limits and affected-row
result. No statement vocabulary needs to grow.

The implementing files are:

- `packages/core/src/database.js`: globally append-only data v6 and control v7
  migrations, plus core migration-name identity checks;
- `packages/core/src/audit.js`: private exact audit insertion while the public
  audit method continues to own id and time;
- `packages/core/src/spine-store.js`: mutation/intention atomicity, tenant-bound
  recovery and zero raw-driver reach;
- `packages/core/src/spine-store-storage-adapter.js`: the deep-internal
  compatibility adapter for the released direct-SQLite v1 input;
- `packages/app/src/create-app.js` and `packages/app/src/spine.js`: marker/binding
  startup wiring and the bounded application recovery surface;
- `tests/spine-v2-m2f-cross-plane-audit.test.js`: failure-first executable
  evidence.

## Milestones and progress

- [x] Reproduce committed control state, zero data audit and false refusal.
- [x] Characterize exact successful return shapes and released v1 dependency
  shapes, including direct `DatabaseSync` input.
- [x] Append global data v6/control v7 without renumbering v1-v5, and refuse a
  recorded core migration version under the wrong immutable name.
- [x] Mint/verify a persistent data marker before Organization resolution and
  bind it with a one-transition control CAS.
- [x] Put all authorization/state/concurrency reads, the mutation and its audit
  intent inside one `BEGIN IMMEDIATE` control transaction for all four writers.
- [x] Add private exact-id audit delivery and explicit bounded reconciliation.
- [x] Remove raw-driver reach from `spine-store.js` without growing the storage
  statement vocabulary.
- [x] Exercise restart, races, lock ordering, marker mismatch, divergent
  evidence, migration adoption, unsafe revisions and credential-free errors.
- [x] Make truly fresh two-process startup converge under a bounded migrator
  retry, close both handles on every post-open composition refusal, and reject
  swapped migration-plane identities without rejecting v1-v5 control adoption.
- [x] Pin the additive audit-intent options contract and preserve negative-limit
  behavior of the released v1 Organization/Membership lists behind the seam.
- [x] Reconcile DECISIONS, Legacy Alignment Matrix, TASKS, PROJECT_STATUS and
  Repository Truth.
- [x] Run focused compatibility suites and the full repository gate; isolate
  every failure against the starting `origin/main`.
- [ ] Complete independent red-team and one broad exact-head Codex review;
  commit and push without opening a PR.

## Decision log

### Marker first, nullable shared binding second

The data file mints a random opaque `dataPlaneId` beside its canonical tenant
slug before the control mapping is claimed. Mapping-first adoption was rejected:
two different files for the same slug copied the same reserved id and became
indistinguishable.

The control row is keyed by tenant slug and may start with `data_plane_id NULL`.
That lets an already-supported shared control plane create Organization B and
commit B's intent while app A keeps serving only A. The first application
configured for B mints its own marker and CASes NULL to that id. A second
physical file has a different marker and loses stably. The intent foreign key
references the slug only; it never relies on SQLite's nullable composite-FK
semantics.

This is **first-configured-file-wins**, not attested provisioning. A copied data
file carries the same marker, and M2 has no lease, clone promotion or external
resource identity. Those are M4 concerns and are not claimed here.

Unknown production tenants without explicit provisioning refuse before marker
or mapping creation. An existing Organization created from another instance can
still receive mutations: its absent binding is atomically inserted as NULL with
the mutation and intent, preserving the control-plane provisioning behavior.

### Intent identity names a mutation, not its payload

The deterministic identity tuple is:

```text
contract + destination tenant slug + entity type + entity id + mutation revision
```

`UNIQUE(entity_type, entity_id, mutation_revision)` makes that identity explicit.
The canonical payload has a separate fingerprint. Changed actor/action/data/time
under the same revision therefore refuses as `SPINE_AUDIT_INTENT_DIVERGENT`
instead of creating a second plausible audit. Revisions are positive safe
integers in code and schema.

### Delivery order is short control, committed data, short control

Delivery never holds a control lock while opening the data plane:

```text
short control transaction: reverify intent + binding eligibility
release control
own data transaction: reverify marker + put exact audit + COMMIT
short control transaction: reverify intent + binding + delivered CAS
```

The data audit must commit independently before `delivered_at` can move. A crash
after the audit but before the terminal CAS leaves the control intent pending;
retry sees the same exact audit and closes it. Holding control across data was
rejected because another process can acquire those databases in the opposite
order. Joining a caller transaction was also rejected: an outer rollback could
erase the audit after the control intent had been marked delivered. Mutation and
reconciliation refuse namedly when either relevant handle already has a caller-
owned transaction.

### Mutation reads belong inside the mutation transaction

Grant, suspend and bootstrap previously performed some authorization/state reads
before their write. Under two processes that permitted stale authorization,
double bootstrap or conflicting administrator decisions. On the recovery path,
organization lookup, membership lookup, administrator count, authorization,
mutation and intent creation now run in the same `BEGIN IMMEDIATE`. The public
v1 path preserves its released error precedence and non-atomic audit behavior.

### Public v1 stays public; recovery primitives stay internal

`createSpineStore({database,audit?,now?})` still accepts the framework database
wrapper or the direct SQLite driver and returns only `organizations` and
`memberships`. `AuditLog.record()` still ignores a caller-supplied id/time. The
recoverable store and exact audit put are deep-internal imports and are not
re-exported by `packages/core/index.js`.

The application adds one frozen `spine.auditIntents` surface with contract 1,
`listPending()` and `reconcile()`. Pending entries expose only intent id,
action, entity type/id and creation time; no payload, actor, tenant id, binding,
locator or credential. `describe()` publishes only the contract number.

### Recovery is bounded and per-intent, not a job system

Each pass attempts at most 100 ordered pending intents for the current bound
tenant. One poisoned item is reported and the next still runs. The returned
`pending` value comes from a separate exact count, so a page of 100 cannot claim
that only 100 exist. Intents are immutable except for one pending-to-delivered
transition and cannot be deleted. There are no leases, timers, background
workers, retry policy, compaction or arbitrary messages.

`listPending()` and `reconcile()` accept only a non-proxy plain options object
whose sole optional field is an integer `limit` from 1 through 100. Absence means
100; coercion, clamping, accessors and ignored unknown keys were rejected because
this is a public recovery boundary. Refusals name only the contract failure,
never the input, payload, path or credential-shaped value.

### Startup owns handles and migration-plane identity

The application factory owns both database handles until it returns the app, so
any binding or later composition refusal closes every handle while preserving
the original error. The migrator uses bounded startup-only retry and, after it
owns `BEGIN IMMEDIATE`, re-reads the ledger row before applying either a core or
module migration. Two processes starting on a genuinely fresh root therefore
converge instead of racing the immutable ledger; a persistent lock refuses as
`CORE_DATABASE_STARTUP_BUSY`. Business mutations are never retried by this
mechanism.

Every known global core migration row is name-validated before the selected
family runs. A v6 data-marked file cannot boot as control, and a v5/v7
control-marked file cannot boot as data. The explicit compatibility exception is
the released combined v1-v5 prefix: it may be adopted as control, retaining its
dormant CRM tables, while the application proves separation through distinct
files and dedicated runtime handles. This is plane-family identity, not resource
attestation, clone detection or an M4 lease.

The Storage Contract vocabulary did not grow. For released v1 list methods, a
negative numeric limit is represented by omitting the statement limit (SQLite's
historical unbounded behavior); zero and `NaN` retain their old defaults and
positive values retain their caps.

## Validation

The focused suite executes, rather than infers, these boundaries:

```text
before mutation                         -> no mutation, intent or audit
after control commit / before audit     -> committed entity + pending receipt
after data audit / before delivered     -> one audit + pending; retry closes
caller-owned data/control transaction   -> named refusal, never false delivery
NULL destination                        -> no-op for this instance, exact pending
two files / same slug CAS race          -> one winner, stable loser
same physical file / two processes      -> one marker and one mapping
fresh root / two cold processes         -> bounded migration convergence, no raw SQLite
persistent startup lock                 -> CORE_DATABASE_STARTUP_BUSY, handle closed
known wrong-name / swapped plane        -> fail closed before selected migrations
legacy combined v1-v5 control adoption  -> dormant CRM preserved, runtime handles separate
audit-intent option/type/limit errors    -> stable bounded credential-free refusal
v1 negative list limits                 -> unbounded compatibility through omitted limit
post-binding composition refusal        -> both database handles closed, cause preserved
marker before CAS crash                 -> same-file retry reuses marker
CAS before audit crash                  -> restart-visible pending intent
marker mismatch                         -> refuse and leave pending
divergent intent or audit               -> refuse and leave pending
poisoned oldest intent                  -> later valid intent still delivers
more than one page pending              -> bounded attempt, exact total count
two-process bootstrap                   -> exactly one owner and one audit
legacy v5 A+B control database          -> upgrade, NULL bind, B recovery
```

Commands:

```bash
node --test tests/spine-v2-m2f-cross-plane-audit.test.js
node --test tests/production-spine.test.js tests/spine-tenancy-truth.test.js \
  tests/spine-route-authorization.test.js
npm run repo:truth -- --check
npm run gtm:check
npm run crm -- project doctor --json
npm run verify
```

Expected of this slice: its focused and compatibility commands pass;
successful mutations retain exact key sets; failure receipts contain only
bounded codes; every recovery fault remains pending; the two-plane races
complete without cross-claim or duplicate audit; and the raw-token mutation
proves the structural guard can fail. A full repository gate is also run so any
failure can be attributed rather than omitted.

The branch-owned tests and structural gates pass. On this macOS checkout,
`npm run verify` still exits 1 for two independent failures reproduced
unchanged on starting `origin/main`: the M0 CLI receipt resolves the `/var`
temporary-directory alias to `/private/var`, and the shell-classifier corpus
produces no non-taken guarded-write witness. Neither test or implementation was
changed in this causal slice. Running with a canonical `TMPDIR` removes the
first environment alias; the second remains an inherited corpus failure.

## Progress log

- 2026-08-28: reproduced the false rollback and characterized successful v1
  shapes before changing production code.
- 2026-08-28: discarded mapping-first reserved-id adoption after a two-file
  probe proved both files acquired the same identity.
- 2026-08-28: changed to marker-first plus nullable binding/CAS and proved
  distinct-file race, same-file convergence and M1-era upgrade.
- 2026-08-28: discarded control-lock-across-data delivery after lock-inversion
  review; implemented and tested the short-control/data/short-control sequence.
- 2026-08-28: moved all grant/suspend/bootstrap reads inside `BEGIN IMMEDIATE`
  after a two-process bootstrap probe exposed the stale-read boundary.
- 2026-08-28: focused implementation and compatibility suites are green. The
  first repository-wide run exposed and repaired this slice's stale global
  migration expectation and all three characterization source fingerprints
  that own `create-app.js`. The two remaining full-run failures reproduce on
  starting `origin/main`; independent review remains.

## Outcome and follow-up

Implementation and branch-owned validation are complete on the working branch;
independent review remains before publication, and the two inherited full-suite
failures above remain explicit. This slice may claim bounded, explicit SQLite
recovery for Spine Organization/Membership audit and closure of
`spine-store.js` over Storage Contract v1. It may not claim external resource
attestation, clone safety, a durable general outbox, PostgreSQL, production
readiness, shared-database tenancy or completion of the rest of M2F.
