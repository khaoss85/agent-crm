# Read-only composition — design before code

A private managed pilot needs a Web Admin a human can log into. The Admin must
be able to *see* — a customer, a scheduled review, an action's result — and it
must not be able to write. Not "does not write today": must not be able to.

This plan states what that composition is, and, more importantly, what makes
each constraint structural rather than disciplined.

## The six constraints, and where each one is enforced

The owner stated six. They are not six rules in one place; they land in three
different layers, and saying which is which is the point of this document.

| # | Constraint | Enforced by |
|---|---|---|
| 1 | must not acquire or renew the writer lease | **no control-plane credential exists in the process** |
| 2 | must not run migrations | **the migration code is not in the function that runs** |
| 3 | must not start workers | construction starts nothing (already true); the facade omits the handles |
| 4 | must not expose write capability | omitted facade keys |
| 5 | a genuinely read-only DB credential where the provider allows | PostgreSQL grants — *a separate layer, measured separately* |
| 6 | refuse every mutation before the first SQL | typed refusal in the storage seam, before statement rendering |

Constraints 1 and 2 are the two that matter most, and both are answered the
same way: **by absence, not by a guard.**

### Why a separate bootstrap and not a flag

`bootstrapPostgresqlApplication` is one long try block in which DDL,
attestation writes, binding claims, lease acquisition and audit rows
interleave. A `readOnly: true` flag would mean skipping eight write sites
behind conditionals — a path held open by discipline, which is the exact
defect class this campaign has spent two weeks finding. Twice the defect was
a contract nobody could reach; once it was a renewal nobody called.

`bootstrapPostgresqlReader` cannot run a migration because the code that runs
migrations is not in it.

### Why the reader receives no control endpoint

`ensureWriterLeaseTable` runs during the control plane's bootstrap: **the lease
table lives in the control plane.** A composition handed only a `data`
endpoint holds no credential that can reach it.

So constraint 1 is not a rule the code follows. It is a sentence the process
cannot express. It also means no control-plane credential sits in the web
process at all, which is the smaller blast radius independently of the lease.

## What skipping the control plane costs, and how each cost is paid

Two things are genuinely lost. Both are paid for, because neither is theoretical.

**1. The cross-check between the control mapping and the data marker.** The
writer compares `mapping.dataPlaneId` against `marker.dataPlaneId` and refuses
on disagreement. A reader cannot: it sees only the marker. A reader aimed at a
*superseded* data plane carrying the right tenant slug would serve stale truth
and look healthy.

Paid the way #171 paid the same shape: an **optional** `pinnedBindingUuid`,
compared configured-against-observed at boot, refusing on mismatch. The
deployment already knows the value — `backupEvidence.bindingUuid` is in the
receipt. Unpinned, the gap is declared, not silently absent.

The lesson #171 established, applied again: it was not the observation that had
to move, it was the other term of the comparison.

**2. Version skew.** This one is not gold-plating, and the pilot proves it: web
and worker are pinned to *different refs* today (`pilot-eef1a1c`,
`worker-8ca8b35`). A reader whose code renders migration set N against a
database at N−1 misreads silently — the columns it names may not exist, or
worse, may mean something else.

The writer's protection is attestation-then-DDL. The reader's analog must be a
**read**: select the migration ledger, verify every migration this code renders
is present with a matching checksum, refuse otherwise. It is the same question
attestation asks, asked without the authority to answer it by writing.

## The storage seam

`writerGuard` is the wrong seam to reuse. It is applied uniformly to all four
entry points — `runTransaction`, `execute`, `maybeOne`, `many` — because
holding the lease is required even to *read*. The reader's policy is
asymmetric: reads unguarded, writes refused. Uniform is exactly what it is not.

Wrapping the storage object from outside is also wrong: it is frozen,
registered as the durable-job storage owner, and carries contract keys a
wrapper would drift from.

So: a first-class mode on `createPostgresqlStorage` that refuses `execute` and
`transaction`, and leaves `maybeOne` and `many` alone.

**Constraint 6 is satisfied literally.** The refusal is raised before
`render()`, so no SQL string is ever built, let alone sent. And the seam is not
invented for this: `executeOn` already calls
`requireStorageMethodKind('execute', statement, STORAGE_WRITE_KINDS)`. The
framework already classifies statements into reads and writes. The read-only
mode composes with a boundary that exists.

**The measured fact that makes wholesale refusal correct:** the four kernel
modules read through bare `maybeOne`/`many` (`storageMaybeOne`, `storageMany`)
and reach `transaction` only through `storageMutate`, which is the write path.
No read path opens a transaction. Had one, refusing `transaction` wholesale
would have broken reads and this design would need a `BEGIN READ ONLY` variant.
It was checked, not assumed.

## The facade — two different sentences, two treatments

The owner's constraint 4 and constraint 6 are not the same instruction, and
collapsing them would produce a worse composition.

The first draft of this section drew the line in the wrong place, and a real
consumer moved it. It said: omit `leaseRenewer`, `productionOperations`,
`reconcileWrite` and `acknowledgeWrite`; refuse `runAction`. That is the same
rule applied to one key and not to the other two — the framework's own HTTP
surface calls `reconcileWrite` and `acknowledgeWrite` **without asking whether
they exist**, so omitting them produces a `TypeError` at the call site, which
is exactly the accident the `runAction` decision was made to avoid.

The rule, in the form that survived contact:

- **A key already conditional in the ordinary facade stays absent.**
  `leaseRenewer` and `productionOperations` are absent from an ordinary
  application that composes no operations, so absence is already what that
  shape means — and there is no lease here to renew.
- **A key always present refuses, typed.** `runAction`, `reconcileWrite` and
  `acknowledgeWrite`. A caller who reaches for one gets a boundary rather than
  a crash.

Module services keep their write methods on their objects. That is deliberate:
the storage refusal is what backstops them, and a caller who finds
`companies.create` and calls it gets a typed refusal instead of a
`TypeError` — which is the difference between a boundary and an accident.

## Two layers, not two alternatives

The owner was explicit, and it corrects an inclination this plan would
otherwise have had: **the read-only PostgreSQL role is not an alternative to
the framework's read-only mode.** They are complementary.

The framework layer stops the process from *trying*. The database layer would
refuse *even if it tried*. One protects against a programming error; the other
against an error of reasoning about what the code actually does. This campaign
has produced both kinds, which is the argument.

Render's API does not offer the second layer — `POST /postgres/{id}/credentials`
creates a user that *becomes the database's new default user*, which is a
substitution and not a restricted role. The SQL route (`CREATE ROLE` +
`GRANT SELECT` from an owner connection inside the network) is being measured
separately, with a `NOLOGIN` role that is dropped after the measurement, so the
mechanism is proved without minting a credential that can authenticate.

Whatever that measurement returns, it does not change this plan. The two layers
are independent by construction, which is the owner's point.

## Declared, not silent

**The reader leaves no startup audit row.** It cannot: recording one is a write,
and writes are the thing being removed. A writer application's startup is
visible in the audit table; a reader's is not. Stated here rather than
discovered later.

## What must be provable

- A refused mutation issues **zero** statements — asserted against a spy pool,
  for `execute` and for `transaction` separately. "Refused" and "refused before
  any SQL" are different claims and only the second is the constraint.
- Composing the reader writes nothing: no lease row, no audit row, ledger
  unchanged — a before/after snapshot, not an inspection of intent.
- A marker whose tenant slug differs refuses.
- A pinned binding uuid that does not match the marker refuses.
- A database missing one migration this code renders refuses.
- **The inertness twin:** a writer application behaves identically with the
  reader code present. This is the property V3C established one level down and
  the one this repository keeps having to re-prove.

## Reachability — the failure this plan is most likely to repeat

Twice in this campaign a contract was written and left unreachable from any
supported composition, once by me. So it is a requirement and not a nicety:

**the reader must be composable through the deployment selection channel**, not
only through test-harness options. The pilot's web service composes through
`deployment.selection`; decision 6's browser acceptance sits on this exact
composition. A reader reachable only from tests would pass every test in this
plan and serve nothing.

`isCompletePostgres` currently demands an `identityVerifier`, and
`looksLikePostgres` without one throws `PORTABLE_POSTGRESQL_BINDING_REQUIRED`.
The reader does not attest, so it should not need a verifier — the carve must
be deliberate and stated, not incidental.
