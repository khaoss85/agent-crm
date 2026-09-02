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


## Three findings from an independent review, and what each one changed

None of the three was in the files the branch touches. All three were found by
reading the *consumers* — who produces a selection, who calls
`persistFingerprints`, who writes to the ledger — rather than the diff.

**A. The deployment channel could not describe this composition.** The only
producer of `deployment.selection` is `loadDeploymentStorage`, whose envelope is
a closed key set that knew neither `access` nor `pinnedBindingUuid`, and which
required `controlPlane` and parsed it unconditionally. So a document with
`access: "read-only"` was refused with `DEPLOYMENT_STORAGE_ENVELOPE_INVALID`
before composition began, and the reader existed only for the test harness.

This section had already claimed the opposite, in the paragraph warning about
exactly this failure. The check that had been run was that the *factory routes*
a read-only selection — which is a different fact from a document being able to
reach it, and the difference is the whole finding.

The corollary was worse than the finding: `pinnedBindingUuid` was described in
the truth limitation as "available to a reader as an optional configured pin",
and no supported deployment could configure it. **The gap the pin was introduced
to pay was unpaid everywhere except in tests.**

**B. A reader could not compose any graph carrying a package.**
`persistFingerprints` opens a transaction unconditionally — including in
persist-or-verify mode when every fingerprint already matches and there is
nothing to write — so read-only storage refused it during graph assembly. Every
test here composed the empty kernel graph, where the loop returns before its
first statement.

The fix asks the storage what it is rather than threading a flag through every
`persistFingerprints` signature. Absence is tolerated deliberately: a definition
the database has never seen has no rows under it to misread. A definition
registered under a *different* fingerprint still refuses.

**C. The skew check ran in one direction, and the open one was the likelier.**
It verified that every migration the reader renders is in the ledger. It did not
refuse a ledger carrying *more*. But the writer is what migrates, so the database
sits at the worker's ref and the web follows: DB at N+1, reader at N. This
repository's own core set contains `ALTER TABLE … ADD COLUMN` and
`ALTER COLUMN … DROP NOT NULL` on `write_outcomes` — a column whose meaning
moved under a reader that never learned it had.

Core is now checked both ways. Module migrations deliberately are not: a worker
that composes timers and a web that does not are a supported pair, and tables
the reader never names cannot be misread by code that never mentions them. The
asymmetry is pinned by a test so it cannot be tidied into symmetry.

**D. A definition the database knows at another version fell between both
cases.** The lookup keys on `(type, name, version)`, so a row registered at a
different version is not a match — no fingerprint to compare — and is not
"never seen" either, because the database knows that definition perfectly well.

It is the only one of the three states this mode creates. A writer cannot
produce it: a writer inserts, and code and database agree from then on. The
reader is the one composition that can run a definition version the database has
never registered — precisely because absence was made tolerable.

What it looks like when it bites: a policy moves from v1 to v2, the web is
redeployed and the worker is not. Rows written under v1 are read back through v2
logic — a total nobody ever wrote and the worker would not reproduce — with
`health()` answering ready, no error and no audit row, because an audit row
would be a write.

Closed by selecting on `(type, name)` and refusing when rows exist but none at
the rendered version. The tolerated case is untouched: nothing registered under
that identity is a different composition, and there are no rows beneath a
definition nobody ever registered. It is the same third term already written for
module migrations, which this level was missing.

**E. The wiring from a document to the reader's arguments was covered by
nothing.** Discarding `pinnedBindingUuid` on the document branch left the whole
suite green — measured, not argued. The harness tests take the other side of
every ternary in that block; the document test dies at a connection that by
construction never succeeds; and `pinnedBindingUuid` and `tenantId` are both
read only *after* that connection. So the two values a reader needs from an
operator's document reached it through a line no test exercised.

This is the corollary of A refusing to close. A said the document could not
describe the composition; fixing that made the description possible and left
untested whether the description *arrives*. The pin is precisely the term the
limitation says a reader carries in place of the cross-check it cannot perform,
so a pin that silently fails to arrive removes the payment and keeps the claim.

Closed by extracting the mapping into an exported function and asserting what a
document turns into — no database, no TLS. Wiring, not composition, which is the
level the defect lives at.

**What the five have in common** is worth more than the fixes. Each was a
property asserted about a seam by someone who had verified the seam's own side
of it. The reviewer found all three by asking who is on the *other* side — and
none of them would have been found by looking harder at the diff.
