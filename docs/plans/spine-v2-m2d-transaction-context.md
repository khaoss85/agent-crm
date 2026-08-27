# Production Spine v2 M2D — the caller-owned transaction context

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to the consumers that must prove they are inside a caller-owned outer
transaction before writing a set of rows that is only correct as a set.
PostgreSQL, shared-database tenancy, the workflow engine, the action runtime,
the kernel's own driver use, and new public or agent-facing surfaces are
explicitly out of scope.

## Purpose

Remove the last business-consumer raw-driver reach in the repository, and fix
the defect that looking for its second consumer uncovered.

`packages/work/src/follow-up.js` read the SQLite driver's `isTransaction` flag
off the module service's database handle — one boolean, bought by a business
package holding the raw driver, and with it `exec`, `prepare` and every table in
the application. It survived M2A, M2B and M2C because it was spelled with
optional chaining, which a plain `database.raw` token scan does not see.

Looking for a second consumer found **three more capabilities** making the same
atomicity promise in their own doc comments with nothing checking it. All three
were measured committing partial writes outside a transaction. They are fixed
here, through one shared primitive, because a contract published from a single
consumer is the thing this repository's selection rule exists to prevent — and
because shipping three proven partial-commit paths in the milestone that names
that defect class would be indefensible.

No public, agent-facing, MCP, REST or CLI surface changes. Both
`WORK_TRANSACTION_REQUIRED` messages are preserved byte-for-byte with their
trigger semantics intact, `createAccordoApp()` stays synchronous, and no
statement vocabulary is added to `packages/core/src/storage-contract.js`.

## Progress

- [x] Search every production site that must prove caller-owned transactional context.
- [x] Falsify that search with planted synthetic matches before reporting any negative.
- [x] Measure the defect on each candidate consumer rather than reasoning about it.
- [x] Add the opaque transaction witness on Storage Contract v1.
- [x] Migrate Work off the driver, preserving both refusal messages exactly.
- [x] Migrate the three proven contracts writers onto the same contract.
- [x] Prove the five negative evidences and the three measured partial commits.
- [x] Add a structural no-raw-driver guard for the declared M2D slice, each spelling watched failing.
- [x] Reconcile repository truth.
- [ ] Complete exact-head CI and review gates.

## Current repository context

Storage Contract v1 is implemented by `packages/core/src/storage-contract.js`
and rendered for SQLite by `packages/core/src/database.js`. M2A moved Approval,
Contact, Opportunity and Work's legacy-task reader behind it; M2B moved the four
definition-version registries. Before M2D, one business consumer still reached
the driver:

```
packages/work/src/follow-up.js#requireCallerTransaction
  tasks?.database?.raw   → raw.isTransaction
```

Every generated module service writes inside
`this.database.storage.sync.savepoint(...)`
(`packages/cli/src/module-factory.js`), deliberately, so that a service nests
safely inside an enclosing transaction. **Outside one, that SAVEPOINT is itself
the transaction and `RELEASE` commits it.** That single fact is the whole defect
class this milestone is about.

## The consumer search, and the two-consumer rule

The selection rule was explicit: publish a shared contract only if a **second
real production consumer** needs this exact primitive — prove that writes are
executing on the same storage handle inside the active caller-owned outer
transaction, without exposing the driver.

### Verdict: four consumers

There are exactly four write-capable capability entry points in the repository.
One checked; three made the identical promise with nothing checking it.

| Site | Writes | Checked before M2D |
|---|---|---|
| `packages/work/src/follow-up.js:366` `createFollowUp` | Task + creation Activity | yes, via the driver |
| `packages/contracts/src/capabilities.js:133` `markHandedOver` | N obligation rows in a loop | **no** |
| `packages/contracts/src/service-capability.js:127` `markActivated` | N obligation rows in a loop | **no** |
| `packages/contracts/src/succession.js:784` `executeSuccession` | contract, version, lines, subscription, subscription lines, obligations, activation, lineage | **no** |

The structural reason all four qualify, rather than three of them merely
happening to sit inside an action today: `PackageRegistry.capability()`
(`packages/core/src/package-registry.js:456`) passes the **caller's** `context`
straight through to `create()`. A capability cannot assume its caller is inside
an action envelope. That is precisely the argument `follow-up.js` already made
for itself — "from a script, from a `prepare` phase, from a future consumer that
forgot" — and it applies verbatim to the other three.

### Rejected candidates, and why

A list of only positives is not a search.

- **Structurally inside the action envelope** — `runRecordAction` wraps every
  `execute` in `database.transactionAsync`
  (`packages/core/src/action-runtime.js:208`), so these merely *happen to be*
  inside one and cannot be reached another way: Work's `complete`/`cancel`/
  `add-note`, `packages/delivery/src/handover.js:507`,
  `packages/service/src/actions.js:193`, `packages/lifecycle/src/amendment.js:532`,
  `packages/lifecycle/src/index.js:623`, `packages/service/src/actions.js:629`,
  `packages/contracts/src/activation.js:499`, and both example custom packages.
  These are the *callers* of the four consumers, not consumers themselves.
  (`complete` and `cancel` nonetheless take the check — see Decisions §6.)
- **Opens its own transaction** — a site that opens one is not a consumer:
  `packages/core/src/action-runtime.js:208`,
  `packages/core/src/external-operation.js:110`,
  `packages/commercial/src/catalog-sync.js:298`,
  `packages/customer-data/src/operations.js:130`,
  `packages/work/src/legacy-tasks.js:137`,
  `packages/workflows/src/decide-opportunity-approval.js:38`,
  `packages/workflows/src/request-opportunity-stage-change.js:41`,
  `packages/core/src/definition-version-store.js:267`,
  `packages/intelligence/src/registry.js:325`, and
  `packages/signature/src/operations.js` via the injected `runExternal`
  sequencer.
- **Savepoint units, not consumers** — they are the thing an outer transaction
  contains: `packages/cli/src/module-factory.js:680`,
  `packages/modules/company/src/company-service.js:27`,
  `packages/modules/opportunity/src/opportunity-service.js:94`.
- **Deliberately non-transactional** — these *reject* the primitive rather than
  need it: `packages/workflows/src/engine.js` (a running run must be visible
  while it runs; multi-step atomicity is handled by compensation) and
  `writeTrace` (`packages/core/src/action-runtime.js:496`), explicitly
  best-effort and outside the business transaction so a trace failure never
  masks the real outcome.
- **Kernel, single-row or read-only** — `packages/core/src/audit.js:28`,
  `packages/core/src/spine-store.js:50` (control plane, a separate database
  file), `packages/core/src/core-adapters.js:66/84` (reads only), and
  `scripts/repo-truth.js` (repository maintenance, opens its own throwaway
  in-memory databases).
- **Read-only capabilities**, each opened and checked: `commercial-quotes@1`/`@2`,
  `commercial-quote-binding@1` (returns frozen *data* describing a write path and
  performs none), `signature-orders@1`, `customer-identity`, `intelligence`,
  `contract-lifecycle-source@2`, `service-coverage@1`, `service-case-management@1`,
  `service-sla-evidence@1`, `delivery-economics@1`,
  `delivery-change-management@1`, `delivery-acceptance-evidence@1`.

### How the search was falsified

Two findings, both of which would have produced a wrong answer if left
unchecked.

**1. The raw-reach inventory needed two greps, not one.** Five synthetic
spellings were planted in a package file and the primary grep run against them:

| planted | `\.raw\b|\[.raw.\]|isTransaction|DatabaseSync` |
|---|---|
| `someDb?.raw?.isTransaction` | found |
| `someDb['raw'].prepare('x')` | found |
| `new DatabaseSync(':memory:')` | found |
| `const { raw: plantC } = someDb;` | **MISSED** |
| `const { raw } = someDb;` | **MISSED** |

A second grep (`{ *raw *[,}]` / `, *raw *}` / `{ *raw *:`) was required and found
both. The reported inventory is the union of the two. No production file uses
the destructured spelling; `packages/cli/src/scenario-document.js:250`
(`return { raw, problems }`) is a scenario-parse result, unrelated to the driver.

**2. A capability-by-capability read wrongly cleared two real writers.**
`packages/contracts/src/index.js:112` introduces the obligation capabilities
under a comment describing a *sibling* as read-only, and both files read as
query surfaces for their first 130 lines. They were found only by counting
`createManaged|applyManaged` per file and following the two files with a
non-zero count. A skim would have reported them read-only.

The sweep covers `packages`, `examples`, `tests`, `apps`, `api`, `scripts`,
`site`, `benchmarks`, `design` and `skills`, with plain directory pathspecs and
a quoted `--include="*.js"` — never a `**` glob, which is how a previous
milestone got an empty pathspec reported as an absence.

## The defect, measured

Reasoning was not accepted as evidence for any of the three. Each was run.

**`markHandedOver`** — per-id validation happens *inside* the loop, after prior
ids have already been written:

```
PROBE: pending delivery obligations = 3
outside-transaction: obligation[0].status=handed_over handoverRef=probe-outside-transaction
inside-transaction:  obligation.status=pending_handover handoverRef=null
```

Called outside a transaction with `[validPendingId, foreignId]`, it **refuses
and still leaves a committed row**: an obligation marked `handed_over`, carrying
a `handoverRef` to a delivery project that will never exist, on a contract whose
caller was told the handover failed. That obligation can never be handed over
again — `OBLIGATION_ALREADY_HANDED_OVER` is terminal.

**`markActivated`** — the same defect wearing a different status column:

```
outside-transaction: status=activated coverageRef=probe-outside-transaction
inside-transaction:  status=pending_activation coverageRef=null
```

**`executeSuccession`** — with a fault injected between `writeActivation` and the
lineage row, which is the seam a caller's transaction is supposed to bind:

```
outside-transaction: contracts=2 (was 1) lineage rows=0
inside-transaction:  contracts=3 (was 3 before the faulted run)
```

A committed successor commercial agreement with **no lineage row** — nothing on
disk saying which agreement it replaced. `translateRace`
(`packages/contracts/src/succession.js`) states that a lost race "rolls back
whole"; that was true only inside a caller-owned transaction, and nothing
checked there was one.

In all three, the inside-transaction control rolls back whole, from a clean
second fixture rather than a re-run of the first — a re-run would have been
refused early by the first run's own effects and would have proved nothing.

## Decisions

### 1. An opaque witness, minted by the storage boundary

`packages/core/src/transaction-witness.js` holds a module-private `WeakSet` of
witnesses it minted and a `WeakMap` binding each to the storage handle it was
minted for. A witness is `Object.freeze({})` — no fields, so there is nothing to
observe, copy or reconstruct.

`mintTransactionWitness` is called by `createDatabase`'s `begin()` and by nothing
else, and is deliberately **not** re-exported from `packages/core/index.js`. A
package that could mint could manufacture the proof it is subject to.

### 2. The witness's lifetime is the transaction's lifetime

It is minted beside `inOuterTransaction = true` and dropped beside
`inOuterTransaction = false` in the same two `finally` blocks, so there is no
second piece of state that could drift from the first. It is minted only *after*
`BEGIN IMMEDIATE` has actually succeeded.

`createSqliteStorage` gained a fourth parameter — a **reader** for that slot,
published as `storage.activeTransaction()`. There is no mutator on the storage
object, so a package holding `database.storage` can ask the question and never
answer it. Omitted (as `scripts/repo-truth.js` constructs it) the reader
defaults to `() => null`: a handle assembled without the wrapper cannot prove a
transaction and says so, which is the fail-closed direction.

### 3. Pull, not push — and the assumption it rests on

`proveCallerTransaction` **pulls** the witness from the handle that will do the
writing rather than accepting one from the caller. A caller therefore cannot
satisfy it by holding some other transaction's token, because its token is never
consulted. Pull was chosen over push because it changes zero consumer call
sites, and because under today's invariants it proves exactly as much.

> **NAMED ASSUMPTION.** "An outer transaction is open on this handle" is
> equivalent to "the caller's transaction" **only** while all three of these
> hold:
>
> 1. **One connection per application instance.** `createDatabase` opens one
>    `DatabaseSync` and every module service receives that same object
>    (`packages/app/src/create-app.js:166`).
> 2. **Nested outer transactions are refused.** `begin()` raises
>    `NESTED_TRANSACTION` (`packages/core/src/database.js`), so a transaction
>    open on the handle cannot belong to an inner scope the caller does not own.
> 3. **One loaded core module instance per process.** The witness registry is a
>    module-private `WeakSet`; two copies of `packages/core` in one process do
>    not share it.
>
> **What breaks it, and what M3 must therefore provide.** The ratified
> PostgreSQL plan (`docs/plans/production-spine-v2-postgresql.md`) introduces
> connection pooling and, in its own words, "transaction connection affinity"
> (§707). The moment a storage handle can span or outlive connections, invariant
> 1 fails and "open on this handle" stops meaning "the caller's transaction".
>
> Pull remains correct under pooling **if and only if** the PostgreSQL adapter
> mints its witness on a *connection-affine* handle — that is, the object
> `proveCallerTransaction` compares by identity must be the pooled client bound
> to the active transaction, not a pool-level facade shared across clients.
> **This is an obligation on M3, not a property M3 inherits.** An M3
> implementation that mints at pool level would leave every consumer in this
> milestone silently proving nothing, with no test failing.
>
> Invariant 3 is why a mixed composition fails closed with
> `TRANSACTION_PROOF.FORGED_WITNESS` in `details.proof`. That is safe but
> unobvious, and it is the sentence a developer hitting it in a test harness
> needs first.

### 4. The same-handle half, which nothing was checking

`proveCallerTransaction` takes the **set** of services whose writes must commit
together and compares their storage handles by identity *before* looking for a
transaction. Two services on two connections break atomicity even when each is
inside a transaction, because they are inside two different ones. `createFollowUp`
resolved `tasks` and `activities` independently and nothing proved they shared a
connection; `executeSuccession` passes all nine services it writes through.

### 5. Each consumer owns its own sentences

The core module returns a `TRANSACTION_PROOF` outcome and publishes no message.
Work maps it onto `WORK_TRANSACTION_REQUIRED`, contracts onto
`CONTRACT_TRANSACTION_REQUIRED`. Both Work messages are preserved byte-for-byte
with their trigger semantics intact:

| before (driver) | after (witness) | message |
|---|---|---|
| `raw` present, `isTransaction === false` | `NO_TRANSACTION` | "must be called inside the caller's transaction…" |
| no `raw`, or `isTransaction` not a boolean | `NO_STORAGE`, `SPLIT_STORAGE`, `NO_WITNESS_API`, `FORGED_WITNESS` | "cannot prove it is running inside the caller's transaction…" |

The outcome is additionally carried in `details.proof` on the **"cannot prove"**
refusal only — the one message four outcomes share. `NO_TRANSACTION` has a
message of its own, needs no disambiguator, and keeps the original error shape
exactly. That detail is additive, and it is the only reason a mixed composition
(invariant 3 above) is diagnosable at all.

### 6. `complete` and `cancel` take the check too

They write the task transition and its closing activity — the same atomic pair
`createFollowUp` writes. They are envelope-bound today and the check can never
fire in production, which is exactly why it is asserted rather than assumed: an
`execute` invoked with a hand-built context would otherwise commit the transition
and lose the timeline entry. `add-note` writes one row and is not a set, so it
does not take the check.

### 7. Refusal precedence is unchanged for every valid caller

The proof is inserted *after* the existing input validations and *immediately
before* the first write, at all four sites. Every current 400/409 for bad input
is reachable exactly as before; the only reachable behaviour that changes is the
path measured above.

### 8. Three tests moved off a mixed composition

`work-operations-e2e`, `work-provenance-and-actor` and `work-source-key-stability`
booted an application from a throwaway project copy and then drove it with
`createFollowUp` imported from *this* checkout — two framework instances, which
no deployment can produce. They now load the package source the application
actually composed. The two sources are byte-identical (`project()` copies this
checkout), so no coverage is lost and the tests exercise the composed code, which
is strictly more correct.

## Validation

- `tests/spine-v2-m2d-transaction-context.test.js` — the milestone's own suite.
  - The five negative evidences: outside a transaction refuses **before the
    first write** (proven with a write spy, not by inspection afterwards); a
    different database handle refuses; a split pair across two handles refuses;
    a finished transaction refuses; and no forgery is accepted — a boolean, a
    number, a string, a bare object, a frozen empty object of exactly the right
    shape, an object dressed as the old driver flag, a function, an array, and a
    **genuine witness presented by a different handle**.
  - A fault injected between the Task and the Activity rolls both back, in the
    real composed application.
  - One test per measured partial commit: refuses outside a transaction and
    commits nothing; still rolls back whole inside one; and the legitimate path
    is untouched.
  - The witness lifetime, across both commit and rollback.
  - **The two halves of unforgeability, both asserted.** `mintTransactionWitness`
    and `isActiveTransactionWitness` are absent from `packages/core/index.js`,
    **and** `importsPrivateKernelPath` refuses the exact specifier a package
    would have to write to reach the mint directly
    (`packages/cli/src/package-commands.js`). Either half alone is worth
    nothing: a public mint makes the `WeakSet` decorative, and a private mint
    with no import rule is one line away from public.
- Structural guard over the six-file M2D slice, covering `database.raw`,
  `database?.raw`, `.raw.prepare(`, `?.raw?.exec(`, `database['raw']`,
  `database?.['raw']`, `const { raw } = database`, renamed and multi-name
  destructuring, and `DatabaseSync`. **Fourteen spellings, each watched failing**
  — planted into `packages/work/src/follow-up.js` one at a time, the file scan
  run, the failure observed, the file restored (14/14, none missed). The guard is
  a token scan over raw source, comments included; it is named for that and a
  test pins three escapes it cannot catch, so no reader mistakes it for a proof
  of unreachability.
- `npm run verify` on the exact head.

## Known limitations, stated rather than papered over

- **The guard is a token scan.** `d['r' + 'aw']` defeats it, and chasing that is
  a losing game rather than a stricter guard. It catches regression by editing,
  which is how the driver actually comes back.
- **This is not authentication.** The witness proves a transaction is open on a
  handle. It says nothing about who opened it or what they may do. The security
  model remains trusted checked-in source (ADR-018 addendum 4).
- **The kernel still reaches the driver, deliberately.**
  `packages/workflows/src/engine.js`, `packages/core/src/action-runtime.js`,
  `packages/core/src/core-adapters.js` and `packages/core/src/spine-store.js` are
  out of scope, and the M2D guard makes no claim about them.
- **Two copies of core in one process fail closed.** See the named assumption,
  invariant 3.

## Outcome and follow-up

After this milestone no business or package consumer reaches raw SQLite. The
follow-up that belongs to M3 rather than here is recorded as an obligation in
the named assumption above: a pooled adapter must mint per-transaction witnesses
on a connection-affine handle, or the proof silently stops proving anything.
