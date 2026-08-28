# Production Spine v2 M2E-1 — contract versions in core

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to **core's declaration and validation of the four package-graph contracts**.
The async composition entry point (M2E-2), the migration of the nine bundled
packages to dual v1/v2 graphs (M2E-3), PostgreSQL, and any change to
`createAccordoApp()` are explicitly out of scope.

## Purpose

Teach core that a package graph can be v1 or v2, refuse a graph that mixes
them, and define `capabilityContract` for the first time. No package migrates
here and no async factory exists yet: M2E-1 makes the contracts *expressible
and checkable*, so M2E-2 has something to select on and M2E-3 has something to
migrate to.

`createAccordoApp()` is untouched and stays synchronous. Every bundled package
keeps `1` in every contract field, so the composed application at the end of
M2E-1 is the same application, validated by a checker that can now also see a
v2 graph and refuse a mixed one.

## Progress

- [x] Survey the four contract populations at the exact head. **(done, below)**
- [x] Resolve the `capabilityContract` contradiction against merged code.
- [x] Add the v2 vocabulary and mixed-graph refusal to core.
- [x] Prove with fixtures, not with migrated packages.
- [x] Record the alignment-matrix row and reconcile the M2 ownership index.
- [ ] Complete exact-head CI and review gates.

## Current repository context, surveyed at `b5501c8`

Counted rather than recalled. The count that matters is not the total but the
**asymmetry**: three contracts are enforced by exact equality against a
`SUPPORTED_*` constant, and the fourth is enforced nowhere.

| Contract | Entry-level declarations | Enforcement |
|---|---|---|
| `packageContract` | 10 | `package-registry.js:114`, exact `!== SUPPORTED_PACKAGE_CONTRACT` |
| `actionContract` | 56 | `action-registry.js:48`, exact `!== SUPPORTED_ACTION_CONTRACT` |
| `operationContract` | 6 | `package-registry.js:211`, exact `!== SUPPORTED_OPERATION_CONTRACT` |
| `capabilityContract` | **0** | none — and nothing to enforce |

**The last row is 0, not 13, and the difference is the whole design.** An earlier
draft of this table said 13, conflating two different things under one name.
Red-team caught it and a Node scan over `packages/` confirms the split
precisely: **13 occurrences, every one of them inside the object `create()`
returns, and none on a declaration.**

The other three are **declarations on the definition object**, which the
registry reads at registration. `capabilityContract` is a **payload field
produced after `create()` runs** — the registry never sees it and could not
enforce it if it wanted to. The repository's own characterization proves it in
two adjacent lines:

```js
Object.hasOwn(work.capabilities[0], 'capabilityContract')  // false — the ENTRY
const opened = work.capabilities[0].create({ … });          // the INTERFACE has it
```

**This makes M2E-1's job easier than the earlier draft assumed**: the
entry-level field is genuinely new, no capability declares one, so there is
nothing to migrate and no existing value to honour.

All three constants are `1` (`package-registry.js:54-55`, `action-registry.js:6`).
`resolvePackageComposition(list)` at `package-composition.js:55` is where the
graph is resolved and where a mixed graph becomes visible.

**Two adjacent constants are deliberately NOT in scope**, named here so nobody
assumes they moved: `SUPPORTED_PIPELINE_CONTRACT` (`pipeline-registry.js:5`) and
`SUPPORTED_MANIFEST_VERSION` (`module-manifest.js:26`). The ratified plan names
four contracts; pipelines and module manifests are not among them.

**`PACKAGE_ASYNC_CONTRACT_REQUIRED` does not exist.** One occurrence in the
whole tree — `docs/plans/production-spine-v2-postgresql.md:217`, the ratified
plan itself — and zero in source. M2E-1 therefore **creates** this code rather
than preserving it.

**That makes it a new public surface, with the consequences that carries.** A
stable refusal code is something a caller can match on, so it is public the
moment it ships and load-bearing forever after. Two things follow, planned
rather than discovered: M2E-1 takes its broad Codex review on that basis
whatever else it touches, and the name must clear the **DX Simplicity Gate**
below.

### The DX Simplicity Gate for `PACKAGE_ASYNC_CONTRACT_REQUIRED`

- **The failure mode it prevents, not the capability.** A Promise used as a
  domain value. A v1 package composed on the portable path receives
  promise-returning services and stores, compares or renders the Promise — a
  defect that surfaces far from its cause, as a record whose field is
  `[object Promise]` or a policy that silently takes the wrong branch.
- **Existing primitives are insufficient, and it was tried.** The nearest
  existing refusal is `PACKAGE_INVALID`, which reports a malformed declaration.
  This package is not malformed: it is valid, and valid *for the synchronous
  factory*. Reusing `PACKAGE_INVALID` would tell an author to fix a declaration
  that has nothing wrong with it.
- **Minimal semantic overlap.** No existing code answers "this graph is
  well-formed but not portable". The thirteen composition refusals all report
  structural defects — collision, cycle, missing dependency, unsatisfied
  requirement, invalid metadata.
- **Portability.** It lives in the composition result's structured `problems[]`
  exactly as the other thirteen do, so it reaches `app inspect`, the startup
  registry error and any consumer of `resolvePackageComposition` without
  harness-specific logic. The older `package validate` contract deliberately
  retains `problems: string[]`: it carries the same bounded reason, but not the
  AppError code/status/details. Adding structured problems there would be a
  separate agent-facing contract change, not a silent part of M2E-1.
- **Machine-readable evidence.** A problem code and a non-zero exit, which is
  what every other composition refusal already produces.
- **The name fits the family**, which is the reason to keep the ratified one
  rather than invent a better-sounding alternative. All thirteen existing codes
  are noun-first subject-then-problem: `PACKAGE_INVALID`, `PACKAGE_DUPLICATE`,
  `CAPABILITY_COLLISION`, `CAPABILITY_INVALID`, `CAPABILITY_NOT_DECLARED`,
  `CAPABILITY_PROVIDER_MISMATCH`, `DEPENDENCY_CYCLE`,
  `DEPENDENCY_MISSING_PACKAGE`, `DEPENDENCY_UNSATISFIED`,
  `RESOURCE_COLLISION`, `POLICY_DUPLICATE`, `OPERATION_ALIAS_COLLISION`,
  `DOMAIN_METADATA_INVALID`. `PACKAGE_ASYNC_CONTRACT_REQUIRED` is
  `PACKAGE` + the requirement it failed, and reads like its neighbours.
- **The goal flow gets simpler, not more manual.** An author composing a v1
  package on the portable path is told so at startup with the contract to
  raise, instead of debugging a Promise that reached a database column.

## The `capabilityContract` contradiction, and its resolution

The ratified plan says `capabilityContract: 2` means "capability consumers
await every service/context/dependency operation". Merged code disagrees:
`packages/contracts/src/lifecycle-capability.js:177` already returns
`capabilityContract: 2` on a **synchronous** capability. This is the campaign's
first `CONTRADICTION_REQUIRES_FIX`, and the integrator ratified **Option 4**.

**The field has no consistent merged meaning to preserve.** Four facts, each
verified at this head:

1. **Enforced nowhere.** Composition matches a requirement on
   `${capability}@${version}` (`package-composition.js:178`), never on this field.
2. **Absent entirely on one capability.** `work/follow-up@1` declares no
   `capabilityContract`, and `tests/spine-v2-m0-characterization.test.js:200`
   *pins that absence*.
3. **No test asserts `=== 2`.** One asserts `=== 1`; the rest filter the key out
   of interface lists.
4. **The single `2` is unexplained.** `git log -S` puts it in `c363be2`, a
   bug-fix commit that argues its `version` 1 to 2 bump at length under a
   heading "Why version 2" and never mentions `capabilityContract`.

**What is deliberately not claimed.** `commercial-quotes@2` carries
`capabilityContract: 1`, which refutes "the field tracks the capability's
version" but not a narrower reading — lifecycle v2 was breaking, commercial-quotes
v2 additive, so it could be an informal breaking-shape counter. One data point
each way and it cannot be disproved. **The resolution does not depend on
settling it**: under either reading the number is undocumented, unenforced, read
by nothing at runtime, pinned at `2` by no test, and unexplained in the commit
that set it. That is not merged semantics.

**Option 4, as approved, with its four conditions:**

- **Atomic.** The definition and the correction of the single stray `2` to `1`
  ship in the same PR. Shipping "2 means async" while a merged synchronous
  capability still declares `2` would leave a false claim in the tree, asserted
  to the very validator this milestone builds.
- **Behaviour-free, proved not asserted.** A test pins that composition resolves
  a requirement on `${capability}@${version}` and never on `capabilityContract`,
  so the edit provably changes no resolution. "Nothing reads it" is true today
  and silently false after someone adds a read.
- **The plan amendment argued in the open.** One recorded sentence in the
  ratified plan's decision log carrying the `c363be2` archaeology, so a later
  `git log -S` reads the change as a correction rather than vandalism. We do not
  silently rewrite the ratified plan to fit an implementation; we also do not
  pretend the plan is never wrong.
- **The homonym recorded.** `site/capabilities.json` has its own unrelated
  `capabilityContract` for the site capabilities *document*, read by
  `site-build.js`, `site-check.js` and `jtbd-gate.js`. Recorded as a
  grep-conflation hazard. **Not renamed** — that is site-gate scope.

**Absence means contract 1**, stated as a rule. M2E-1 migrates no package, so
mixed-graph validation must classify `work/follow-up@1` as v1 without editing
it. The M0 characterization pin stays true because it asserts the *absence*,
which does not move.

## The v1/v2 seam: a v1 capability required by a v2 graph

The integrator asked this be settled before source, because capabilities are
where v1 and v2 actually meet. Settling it surfaced a structural obstacle that
changes what M2E-1 has to build.

**The ratified answer is refusal.** The plan names this case in its own words —
*"Package validation rejects any mixed graph (for example package/action v2
exposing capability/operation v1)"* — so a v2 consumer of a v1 capability is
refused, at composition, not on first call.

**A warning, not a remark, because someone will try to "optimise" this later:
the refused direction is the runtime-*safe* one.** A v2 consumer awaits everything, and `await` on a
synchronous value is a no-op, so v2-consumes-v1 would in fact work. The
genuinely dangerous direction is the reverse — a v1 consumer of a v2 capability
receives a Promise and uses it as a domain value. Refusing both is the stricter
and simpler rule: one check, no reasoning about direction, and a half-migrated
graph is not a state worth shipping. M2E-3 migrates all nine bundled packages
together, so nothing needs the permissive direction.

**Do not narrow this refusal to the dangerous direction only.** It reads like an
obvious simplification and it is the wrong one: an asymmetric rule requires
every future reader to re-derive which direction is safe, and it legitimises the
half-migrated graph that the symmetric rule refuses outright. If it is ever
narrowed, that must be a deliberate decision with its own argument, not a
tidy-up.

**The obstacle, found by looking rather than assuming: composition cannot see
`capabilityContract` today.** A capability *declaration* is
`{name, version, description, create(context)}`. The `capabilityContract` field
is returned from **inside `create()`** — `lifecycle-capability.js:177` is inside
the object `create` returns — and `resolvePackageComposition` never calls
`create`; it matches requirements on `${entry.capability}@${entry.version}`
(`package-composition.js:178`) and stores the declaration.

So a mixed-graph check on the *current* shape could only fire at first
instantiation, which is precisely the "fires on first call" outcome to avoid.

**Therefore M2E-1 adds `capabilityContract` to the capability declaration**,
validated where `capabilities[]` entries are already validated in
`package-registry.js`, with absence meaning 1. **The precedent is in the same file, not an analogy.** The comment above that
validator explains why a frozen summary carries no function and no mutable
index: *"so the declaration stays the truth rather than a comment"*. That is the
same argument about the same object — a contract composition cannot read is a
comment, and the fix is the one `package-registry.js` already made for
capability summaries.

### The two `capabilityContract`s, and the relationship between them

Stated here rather than left to fall out, because deciding it now costs a
sentence and deciding it after M2E-3 costs a migration.

- **The entry field is the contract.** New in M2E-1, on the declaration,
  validated at registration, read by composition. Absence means 1.
- **The interface field echoes it.** The 13 existing ones stay. They are not
  vestigial and not a second contract: an interface that returns a
  `capabilityContract` is stating the contract it was built to, and it should
  agree with what its entry declared.
- **Verification belongs at instantiation, which is M2E-2's**, because that is
  the first moment both exist. Composition cannot call `create()`, so it cannot
  check the echo; M2E-2 can, and a disagreement there is exactly the
  Promise-as-domain-value failure the contract exists to prevent.

**Six tests pin the interface field** and constrain any change to it, even
though none is enforcement: `signature-orders-capability.test.js:40` asserts
`=== 1`, and `commercial-capabilities:183`, `delivery-handover-e2e:262`,
`lifecycle-renewal-operations:257` and `:465`, `service-operations-evidence:510`
pin it as a key of the returned interface.

**The three homonyms, recorded with an owner rather than as an observation.** A
reader who greps `capabilityContract` in this repository gets three different
answers, and this plan is the only place that says so:

1. `site/capabilities.json:2` — the **schema version of a site data file**,
   consumed by `scripts/site-build.js` and validated by `scripts/site-check.js`.
   Unrelated to packages entirely. Not renamed: site-gate scope. Recorded
   because a repo-wide inventory of the term hits it and has to work out that it
   does not belong — it cost a reviewer ten minutes.
2. The **interface field**, on what `create()` returns — 13 of these today.
3. The **entry field**, new in M2E-1, on the declaration.

(2) and (3) are reconciled by the echo rule above. **M2E-3 owns the question of
whether (2) survives at all**, since that is when packages actually gain v2
interfaces and the cost of removing it can be measured.

## A declared contract the runtime cannot verify at composition

A package may declare `capabilityContract: 2` while its `create()` still returns
synchronous functions. Composition cannot call `create()`, so the declaration is
a promise nothing checks at startup. Decided deliberately rather than left to
fall out:

**Composition trusts declarations. Instantiation verifies them.**

Trusting at composition is not a concession — it is exactly how the other three
contracts already work. Nothing verifies that a `packageContract: 1` package
actually behaves like one; the declaration is the author's statement and the
registry checks it is *a supported value*, not that it is *true*. Making
`capabilityContract` the one contract verified against behaviour would make it
the odd one out for no gain, since the check would still be impossible at the
moment composition runs.

And it is one rule with the deferral already recorded below: a Promise-shaped
service entering v1 execution is refused where the observation is possible,
which is at call time. Same principle, same milestone — **M2E-2 owns every check
that requires the thing to exist before it can be made.** M2E-1 asserting
otherwise would mean asserting something the code cannot yet see, which is the
failure this campaign keeps finding.

## Milestones

1. **Resolve and record.** The `capabilityContract` resolution above, the plan
   amendment, and the alignment-matrix row — before any validation code.
2. **Widen the vocabulary.** The existing singular `SUPPORTED_*` values remain
   `1`, because scaffolding interpolates them as the synchronous contract it
   emits. Private accepted-version sets admit 1 and 2, and each refusal names
   both accepted values. `capabilityContract` gains its first validation, with
   absence meaning 1. The accepted sets and default are not new package-author
   exports: declaration authors choose one version; they do not negotiate one.
3. **Make the capability contract declarable, then refuse a mixed graph.**
   `capabilityContract` moves onto the capability declaration so composition can
   read it at all; absence means 1. Then, in `resolvePackageComposition`, a graph
   whose package, action, operation and capability contracts do not agree is
   refused with a problem code naming the disagreement, at startup rather than
   at first instantiation. A v1 package in portable composition is refused with
   `PACKAGE_ASYNC_CONTRACT_REQUIRED`.
4. **Prove with fixtures.** v1-only, v2-only, and every mixed permutation, as
   checked-in fixtures rather than migrated packages. The nine bundled packages
   stay at 1 and the composed application stays identical.
5. **Reconcile.** Repository Truth, the alignment matrix, the task ledger.

## Decisions taken before any source

- **No package migrates in M2E-1.** Every bundled package keeps `1`. A v2 graph
  exists only as a fixture until M2E-3. This is what keeps M2E-1 provably
  behaviour-preserving for the shipped application.
- **Exact equality becomes set membership, not a range.** `>= 1` would silently
  accept a `3` nobody has defined. The supported set is enumerated.
- **Absent and explicit `1` must be indistinguishable everywhere downstream.**
  With absence defaulting to 1 and the set being `{1, 2}`, anything that can
  tell "absent" from "declared 1" leaks a third state the contract does not
  have. Stated as an invariant so a later `?? null` does not quietly create it.
- **An unrecognised capability-contract key on a capability entry is refused.** A
  default protects the *value* and not the *key*: `capabilitiesContract: 2` or
  `capabilityContractVersion: 2` would silently read as absent, mean 1, and
  compose a v2 capability as v1 — producing precisely the Promise-as-domain-value
  failure this contract exists to prevent. This is the discriminator M2C
  settled, applied in the other direction: refusing an unnamed key is justified
  exactly when accepting it would be **silently misread**, and a typo'd contract
  key is the clearest possible case. The check tokenizes the key and requires
  both `capability|capabilities` and `contract`; ordinary metadata such as
  `contractor`, `contractNotes` and `capabilityContractor` remains allowed.
- **A Promise-shaped service entering v1 execution is refused**, and the refusal
  belongs where v1 execution begins rather than at composition, because a
  service can only be observed to be Promise-shaped when it is called. Where
  exactly is a M2E-2 question; M2E-1 records that it is not answered here.
- **`createAccordoApp()` is not touched**, not even to add a parameter. One
  function must never conditionally return an app or a Promise; the portable
  path is a separate unconditional async factory in M2E-2.

### M2E-2 object-graph boundary discovered by the M2F audit

The synchronous factory exposes SQLite handles through more than its three
obvious top-level properties. The exact v1 graph also contains handles at
`app.audit.database`, `app.services.{companies,contacts,opportunities,approvals}.database`,
`app.workflows.database`, and
`app.modules.modules.<map entry>.service.database`. Keeping that v1 graph is a
compatibility requirement; returning it from the portable factory would make a
top-level `{adapter, available}` descriptor cosmetic while nested driver
handles remained reachable.

M2E-2 therefore owns an adversarial whole-object-graph leak test and a portable
facade/private-field boundary. A top-level descriptor alone is not acceptance
evidence. This finding changes no M2E-1 source and does not authorize an edit to
`create-app.js` in this slice.

## Compatibility Backfill Rule (AGENTS.md §14)

Contract versions are consumed by every package, which makes this about as
horizontal as the rule gets. **The alignment-matrix entry is planned here, not
taken as a review finding.**

The honest row for every domain at the end of M2E-1 is **`deferred`**, with the
reason that core can now express and check a v2 graph while no domain declares
one — M2E-3 is what changes that. Declaring the gap is required; closing it is
not, and closing it here would be exactly the silent backfill the matrix exists
to prevent.

## Validation

```bash
node --test tests/spine-v2-m2e1-contract-versions.test.js
node --test tests/package-contract.test.js tests/contracts-registry-review.test.js \
  tests/custom-package-e2e.test.js tests/action-contract.test.js
node --test tests/spine-v2-m0-characterization.test.js
node --test tests/characterization/*.test.js tests/falsify.test.js
node scripts/falsify.js
npm run repo:truth && npm run repo:truth -- --check
npm run gtm:check && npm run site:check && npm run smoke
git diff --check
npm run verify
```

## Progress log

- **2026-08-28:** The exact-head broad review found three material boundary
  failures. Package composition could dereference malformed actions before the
  runtime action registry validated them; plural and separated misspellings of
  `capabilityContract` could still normalize to v1; and mixed-graph diagnostics
  echoed unbounded action/capability identities. Composition now shares the
  action validator before dereference, the typo guard recognizes the normalized
  singular/plural contract token while preserving ordinary metadata, and
  diagnostic rendering is capped without inventing a declaration limit. The
  existing 64-character operation-name contract remains unchanged and is
  tested separately. `package validate` still returns its established
  `problems: string[]`; the plan now claims structured refusal identity only on
  the surfaces that actually preserve it.
- **2026-08-28:** Merged current `origin/main` regularly into the writer branch
  after M2D. Implemented private accepted-version sets, declaration-time
  capability normalization, uniform v1/v2 graph validation, the stable
  `PACKAGE_ASYNC_CONTRACT_REQUIRED` refusal, truthful registry/action/inspection
  metadata, and the Option 4 lifecycle correction. Fixture coverage now proves
  v1-only, v2-only, every internal mixed permutation, disconnected mixed
  packages, and the exact v2-consumer/v1-capability edge. No bundled package or
  synchronous factory moved.
- **2026-08-28:** M2F's independent audit found nested SQLite handle exposure in
  the v1 application object graph. Recorded it as an M2E-2 facade and
  adversarial-leak-test obligation; M2E-1 deliberately does not touch the app
  factory.

- **2026-08-28:** Red-team returned four confirmations and one material
  correction: the survey table conflated interface fields with entry
  declarations, making the `capabilityContract` row 0 rather than 13. That
  correction improved the design — with nothing declared there is nothing to
  migrate — and produced the entry/interface **echo** relationship, which
  resolves the third homonym instead of deferring it. Two further findings
  taken: an unrecognised contract-ish key on a capability entry is refused, and
  absent-versus-explicit-`1` is an invariant.
- **2026-08-28:** Created this plan before touching source. Surveyed the four
  contract populations at `b5501c8` rather than carrying counts from another
  head, and established two facts that changed the shape of the work:
  `PACKAGE_ASYNC_CONTRACT_REQUIRED` does not exist in source, so M2E-1 creates
  it; and three of the four contracts are enforced by exact equality while
  `capabilityContract` is enforced nowhere.

## Decision log

- **A count is not a measurement until you say what it counts**, and this plan
  got that wrong twice before a line of source existed.

  First, an early count of `capabilityContract` reported **five**, from a
  truncated output read as a complete answer. Re-counted: thirteen occurrences
  across nine files in six packages.

  Then the survey table in this document called those thirteen
  **declarations**. They are not. All thirteen sit inside the object `create()`
  returns; the entry-level count is **zero**. Red-team caught it and a Node scan
  classifying each occurrence confirmed 13 interface / 0 entry.

  The second error survived an independent verification, which is the part worth
  recording. The number was confirmed by counting **string occurrences** while
  the claim was about **declarations** — same number, different quantity, and a
  confirmation of the wrong measurement is worse than no confirmation, because
  it removes the doubt that would have found it sooner. Neither reader opened
  the two adjacent lines in `tests/spine-v2-m0-characterization.test.js` that
  prove it outright: `Object.hasOwn(entry, 'capabilityContract')` is false while
  the interface carries the field.

- **This plan reproduced the defect it was written to avoid, and the fix is not
  the interesting part.** The seam section already said the field lives on the
  interface — that was established while answering where a mixed-graph check
  could fire. The summary table three sections above still said "declarations".
  One document, one section right and one wrong, and the wrong one is the
  summary a reader meets first. That is precisely the stale-prose family M2C
  spent four review rounds removing, committed inside the plan meant to prevent
  it. A document is not consistent because its author knows the right answer
  somewhere in it.

- **Every number in this plan was produced at `b5501c8`**, and each one now says
  what it counts.

## Outcome and follow-up

M2E-1 makes both contract graphs expressible and makes mixed composition fail
at startup. Contract 1 remains the emitted/scaffolded synchronous contract;
contract 2 is accepted only as a uniform package/action/operation/capability
graph. Capability absence is normalized to 1 before registry, metadata or
inspection consumers see it. The existing lifecycle capability's synchronous
interface now says contract 1; its domain capability version remains 2.

No bundled package was migrated and `createAccordoApp()` was not touched.
M2E-2 owns the unconditional async factory, interface-echo verification and the
portable object-graph facade. M2E-3 owns dual bundled definitions and actual v2
package migration. Exact-head CI and the campaign's review/integration record
remain to be filled by the merge train.
