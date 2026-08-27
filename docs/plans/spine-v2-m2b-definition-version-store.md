# Production Spine v2 M2B — the definition-version store

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to the four registry consumers that persist immutable definition/version
fingerprints into `definition_versions`. PostgreSQL, M2C, the Work
transaction-context seam, the workflow engine, the action runtime,
shared-database tenancy, and new public or agent-facing surfaces are explicitly
out of scope.

## Purpose

Remove four duplicated copies of the same raw SQLite persist-or-verify loop.
Commercial, Signature, Intelligence, and the package registry each opened
`database.transaction(...)`, prepared the same two raw statements, and repeated
the same ADR-015 immutability check. One internal core primitive now owns that
loop behind Storage Contract v1, so the four consumers keep their public shape
and their exact refusal text while no longer reaching the raw driver.

No public, agent-facing, MCP, REST or CLI surface changes. `persistFingerprints(database)`
keeps its signature on all four consumers, startup stays synchronous, and no
statement vocabulary is added to `packages/core/src/storage-contract.js`.

## Progress

- [x] Baseline the registry suites before mutation.
- [x] Add the internal definition-version store on Storage Contract v1.
- [x] Migrate Commercial, Signature, Intelligence, and the package registry.
- [x] Prove exact behaviour preservation per registry family.
- [x] Add a structural no-raw-driver guard for the declared M2B slice.
- [x] Reconcile truth, the M2A inventory, and the alignment matrix.
- [ ] Complete exact-head CI and Vercel gates.

## Current repository context

Storage Contract v1 is implemented by `packages/core/src/storage-contract.js`
and rendered for SQLite by `packages/core/src/database.js`. M2A moved Approval,
Contact, Opportunity, and Work's legacy-task reader behind it. Before M2B, four
registries still prepared raw statements against `definition_versions`:

- `packages/commercial/src/registry.js` — `CommercialRegistries.persistFingerprints`
- `packages/signature/src/registry.js` — `SignatureRegistries.persistFingerprints`
- `packages/intelligence/src/registry.js` — `IntelligenceRegistries.persistFingerprints`
- `packages/core/src/package-registry.js` — `PackageRegistry.persistFingerprints`

`definition_versions` is core migration v4 (`id, type, name, version,
fingerprint, registered_at`, `UNIQUE(type, name, version)`), and ADR-015 owns its
semantics: same identity plus same fingerprint is a no-op, same identity plus a
changed fingerprint stops the boot.

## Milestones

1. **Baseline.** Run the registry, package-contract, and characterization suites
   without changing source, so behaviour preservation is measured against a
   recorded starting point.
2. **Add the store.** One internal core primitive on Storage Contract v1, with
   fail-closed batch validation and injectable id/clock sources. The repository
   remains runnable and the store's own suite is green.
3. **Migrate the four consumers.** Replace each raw loop with a store call,
   family by family, keeping each family's suites green as it moves.
4. **Prove and guard.** Per-family insert, restart, drift, rollback, concurrency,
   metadata, and no-raw-message proofs, plus a structural guard scoped to exactly
   the four migrated files.
5. **Reconcile truth.** Regenerate Repository Truth, correct the M2A inventory
   rows that named these files as later M2 work, and update the alignment matrix.

## Raw-driver inventory

Re-derived at this head, not copied from earlier prose. **The scan pattern
matters:** the token scan M2A introduced looks for `database.raw`, and misses
optional-chained access — `packages/work/src/follow-up.js` reaches the driver as
`tasks?.database?.raw`, which a plain `database\.raw` scan does not surface. The
inventory below uses a pattern that catches both spellings, which is why Work
appears in it at all.

```bash
grep -rnE "database\s*\??\.\s*raw|\??\.\s*raw\s*\??\.\s*(prepare|exec)\s*\(|DatabaseSync" \
  packages/ scripts/ apps/ --include='*.js'
```

| Classification | Path / consumer | Occurrences | Reason and disposition | Evidence owner |
|---|---|---|---|---|
| `M2B_CURRENT_SLICE` | `packages/commercial/src/registry.js` — catalog providers, discount policies | 2 → **0** | Raw persist-or-verify loop, moved to the shared store. | `tests/commercial-contract.test.js`, `tests/commercial-e2e.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/signature/src/registry.js` — signature providers | 2 → **0** | Raw persist-or-verify loop with a hard-coded type string, moved to the shared store; the type parameterises through the entry. | `tests/signature-contract.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/intelligence/src/registry.js` — enrichment providers, scoring models, routing policies | 2 → **0** | Raw persist-or-verify loop, moved to the shared store. | `tests/intelligence-contract.test.js`, `tests/lead-intelligence-e2e.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/core/src/package-registry.js` — `domain-policy:<domain>:<kind>` | 2 → **0** | Raw persist-or-verify loop, moved to the shared store. | `tests/contracts-registry-review.test.js`, M2B guard |
| `LATER_M2_PACKAGE` | `packages/workflows/src/engine.js` | 9 | Workflow-run persistence is a separate runtime with joins and trace semantics. Untouched by M2B. | workflow tests |
| `LATER_M2_CORE` | `packages/core/src/action-runtime.js` | 2 | Action-runtime persistence and trace remain a separate later-M2 slice. Untouched by M2B. | action/trace suites |
| `LATER_M2_PACKAGE` | `packages/work/src/follow-up.js#requireCallerTransaction` | 1, written `tasks?.database?.raw` | Work's capability reads the driver's `isTransaction` flag to prove the caller's transaction. **Work remains `partial`, and its residue is reachable only through optional chaining, which the plain-token scan does not surface.** Untouched by M2B. | Work capability fault/concurrency suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/database.js` | 3 | The SQLite adapter owns `DatabaseSync`, the PRAGMAs, rendering, and the raw-driver closure. | M0/M1 storage suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/core-adapters.js` | 2 | Core adapter/compatibility internals. | M0/M1 storage suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/spine-store.js` | 1 | Control-plane store internals (`database.raw ?? database`). | Spine suites |
| `AUTHORITY_PROBE_ALLOWED` | `scripts/repo-truth.js` | 5 | The Repository Truth storage authority opens isolated in-memory databases to execute its own probes. It is a repository-maintenance script, not application runtime. | `npm run repo:truth -- --check` |
| `PROSE_NOT_A_CONSUMER` | `packages/create-accordo/src/project-bootstrap.js` (3), `packages/create-accordo/src/project-files.js` (1), `packages/cli/src/app-inspect.js` (1) | — | The token `node:sqlite` appears inside declared limitations and reported metadata strings. No driver is opened, and none of these matches the raw-driver pattern above. | bootstrap and inspect suites |
| `CHARACTERIZATION_ONLY` | fixtures and temporary-project harnesses under `tests/characterization/` | — | Direct SQLite setup is preserved test evidence, not production reachability. | characterization suites |
| `TEST_ONLY` | remaining occurrences under `tests/` | — | Fault injection, physical-schema assertions, and adapter tests intentionally exercise SQLite directly. | owning test files |

After M2B the pattern above returns **nothing** under `packages/commercial`,
`packages/signature`, `packages/intelligence`, or in
`packages/core/src/package-registry.js`. **PostgreSQL remains absent: the only
adapter is SQLite.**

## Decisions

- **One store, not a repository.** `createDefinitionVersionStore(database, {clock, newId})`
  returns a frozen `{persist(entries)}` and nothing else. No `where` builder, no
  table parameter, no raw escape hatch: it persists definition versions or it
  persists nothing. Widening it later would have to be a deliberate act, not a
  convenience.
- **The entry shape is closed at four fields.** `{type, name, version, fingerprint}`.
  `id` and `registered_at` are the store's, so no caller can choose a row's
  identity or backdate a registration, and an extra key — `config`, `evaluate`,
  `id` — is refused rather than dropped. Silently dropping it would make a
  request to persist an executable definition look as if it had succeeded.
- **No new statement vocabulary.** The whole loop is one `select` and one
  `insert` from the existing M1 vocabulary. `packages/core/src/storage-contract.js`
  is untouched.
- **`storage.sync.transaction` is the same wrapper.** The adapter hands
  `createSqliteStorage` the very function `database.transaction` exposes, so
  `NESTED_TRANSACTION` refusal and the retryable `CONFLICT` a busy database
  produces are preserved without re-implementing either. A test pins the nesting
  refusal so that identity cannot quietly become two functions.
- **The read stays inside the transaction, before its own write.** That is what
  makes an identity repeated inside one batch verify against what the batch just
  wrote, instead of hitting a UNIQUE violation whose message would be the
  driver's. The behaviour is not new; keeping the loop shape is what preserves it.
- **The batch is validated before `BEGIN IMMEDIATE`.** A malformed identity is a
  startup-time defect, and it should never be the reason a transaction has to
  roll back. A test asserts the transaction is never opened for a bad batch.
- **The two early returns stayed at their call sites.** Signature and the package
  registry returned before opening a transaction on an empty registry; Commercial
  and Intelligence did not. Moving that decision into the store would have changed
  one pair or the other, so the store always opens the transaction and the two
  call sites keep their guard. Exact preservation beat symmetry.
- **Injectable clock and id, defaulting to today's behaviour.** `resolveClock`
  from `packages/core/src/time.js` is the existing convention, and it refuses a
  non-canonical instant; the default is `nowIso` and `randomUUID`, which is what
  all four registries used. The clock is called per row, as before.
- **No new Repository Truth fact and no new authority probe.** `--check` reports
  that no fact moved and no conclusion changed: only `sourceSha`, because
  `packages/core/src/package-registry.js` and `packages/core/index.js` are
  authority sources. `AUTHORITY_SOURCES` is defined as *the exact files the facts
  are read from*, and no fact is read from the store, so adding it there would
  make `sourceSha` answer a question it does not answer. The store's behaviour is
  proven by the suites that execute it, not by a generator.
- **Published as a kernel export, rather than attached to the database handle.**
  The alternative considered was hanging the store off `createDatabase(...)` —
  `database.definitionVersions.persist(...)` — which would have added no export
  at all. Rejected: it widens the handle every consumer already holds into a
  place where the next primitive is also "just one more property", and it makes
  a startup-identity concern a property of the connection. The published export
  keeps the store addressable exactly where the repository's own rule says a
  package must look. Three of the four consumers live outside `packages/core`,
  and §10 of `docs/PACKAGE_AUTHORING.md` plus AGENTS.md §9 forbid deep imports,
  so *some* public path was required; `packages/core/index.js` is the only
  sanctioned one. Nothing agent-facing moves — no MCP tool, CLI command, HTTP
  route or skill — and `surface:check` budgets exactly those and stayed green.
  The framework also ships no published library (`accordo@0.0.1` is an empty
  name reservation), so `packages/core/index.js` has no external consumer and no
  external compatibility surface exists to break.
- **`docs/PACKAGE_AUTHORING.md` §10 is updated in this PR.** §10 enumerated the
  public surface in prose, and a new export makes that sentence an incomplete
  statement about what the framework exposes — the exact class of claim ADR-039
  binds, and one no test catches, because nothing enumerates the core export
  surface mechanically. Worth recording: the enumeration was **already** stale
  before M2B. It named five groups; `packages/core/index.js` carries thirteen,
  omitting the clock, bounded outbound calls, run traces, the actor authority,
  identity normalization, the Solution Plan and evidence contracts, and the whole
  Production Spine v1 block. Adding the store to a list that drifts silently
  would repeat the failure, so §10 now names the file as the authoritative list
  and gives the enumeration as orientation. Retro-fixing the other eight
  omissions as durable prose is not M2B's to do; naming the file as the authority
  is what stops the next one.
- **The falsification mutation follows the rule; it is not deleted.**
  `scripts/falsify.js` aimed `definition-version-immutability` at the drift check
  in `packages/intelligence/src/registry.js`, a line M2B removed. `tests/falsify.test.js`
  caught it — a mutation that aims at nothing "keeps printing reassurance it has
  not earned" — so the mutation now targets the same check in its new home,
  `packages/core/src/definition-version-store.js`. Neutralising it there removes
  the rule for **all four** registries at once, which makes it a stronger target
  than it was, and `tests/intelligence-contract.test.js` still kills it:
  `node scripts/falsify.js` reports 5 caught, 0 survived, 0 stale.
- **The three characterization baselines were regenerated, and the diff is the
  proof.** `commercial`, `intelligence` and `signature` each freeze a hash of
  every behaviour-bearing source file, so three of them moved. Regenerating is
  what the harness itself instructs, but the receipt is *what* moved: the entire
  diff across the three baselines is **four source-hash lines and nothing else**.
  No observation, asserted value or classification changed. Three independent
  harnesses replayed each domain's externally observable behaviour and found it
  byte-identical, which is the strongest available evidence that this refactor is
  boundary-preserving. No characterization receipt was weakened to make anything
  pass.
- **The closed entry shape is checked with `Reflect.ownKeys`, not `Object.keys`.**
  Review found the "closed shape" was not closed: `Object.keys` sees only
  enumerable string keys, so a field hidden behind
  `Object.defineProperty(…, {enumerable: false})` or held under a symbol reached
  `BEGIN IMMEDIATE` instead of being refused before it. The check now uses
  `Reflect.ownKeys` and also requires a genuine `Object.prototype` prototype —
  the same test the storage contract's own `closed()` applies — so a class
  instance and a null-prototype bag carrying the four fields are refused too.
- **An injected id generator is validated on what it returns, and ids are minted
  before the transaction.** `newId` was checked only for being a function, so a
  generator returning `null`, a number or the same id twice sent that value into
  `storage.execute` and left the adapter's `PRIMARY KEY` to decide — a refusal
  arriving far too late, in the driver's words, contradicting both this
  milestone's fail-closed claim and its explicit "no raw driver message becomes
  public" requirement. `resolveIdSource` now mirrors `resolveClock` in
  `packages/core/src/time.js`: it validates the *returned value* on every call.
  The two refusals differ deliberately — a non-function is construction-time
  misuse and raises `TypeError` exactly as `resolveClock` does, while a bad
  value is on its way to a write and raises `ValidationError` so it carries the
  framework's stable code like every other refusal here.
  **Ids are minted for the whole batch before `BEGIN IMMEDIATE`**, and checked
  for self-collision there, so a broken generator is refused without a
  transaction to roll back — the same guarantee the rest of the validation
  gives, and stronger than a partial insert rolled back. The cost is one
  discarded id per entry that verifies rather than inserts: free for a UUID
  source, and it buys something better than tidiness, because a broken generator
  now fails *every* boot rather than only the boot that happens to have
  something new to write.
- **Closing the shape has two halves, and the first review fix only did one.**
  `Reflect.ownKeys` refuses keys nobody named. It does not ensure the keys that
  *were* named are present on the object: a polluted `Object.prototype` supplies
  a missing `fingerprint` (or `type`, `name`, `version`) through the chain, with
  no unsupported own key to find and a prototype that genuinely is
  `Object.prototype`, so the entry validated and persisted an inherited value.
  Every named field is now required to be an own property via `Object.hasOwn`.
  This is an established concern in this repository rather than a clever edge
  case — `tests/commercial-contract.test.js` already refuses `__proto__`,
  `constructor` and `prototype` as lookup names. The regression pollutes all
  four fields in turn with valid-looking values, asserts the refusal happens
  before any transaction opens, and restores `Object.prototype` in a `finally`
  so the pollution cannot leak into another suite in the same process.
- **The guard's *claim* was narrowed, not only its pattern widened.** Review
  found `database['raw']` and `const { raw } = database` both restored driver
  reachability while the scan stayed green, and the test called its examples
  "every spelling". Both halves were wrong. The pattern set now covers bracket
  access and destructuring as well as optional chaining, each watched failing by
  construction — but more importantly the test no longer claims what a token
  scan cannot deliver. It is named *the four migrated files carry no known
  spelling of direct driver access*, and a third test **asserts the limitation**
  by pinning escapes the scan does not catch (`d['r' + 'aw']`, a computed key,
  `Reflect.get`). No regex establishes unreachability; a guard named for a
  guarantee it cannot give is the reassurance this repository's own falsification
  kit exists to refuse.
- **The seam re-prepares; no statement cache is introduced.** Each registry used
  to prepare the SELECT and the INSERT once and run them N times.
  `createSqliteStorage` calls `raw.prepare(sql)` on every `execute`/`maybeOne`,
  so the store re-prepares per statement. For a bounded set registered once at
  startup that is the right trade, and adding a cache would be a performance
  change nobody asked for inside a behaviour-preserving refactor. Recorded here
  so it is a decision rather than something a reviewer discovers.
- **The guard covers optional chaining, and was watched failing.** M2A's token
  scan looks for `database.raw`; `packages/work/src/follow-up.js` reaches the
  driver as `tasks?.database?.raw` and walks straight past it. The M2B guard's
  alternation catches both spellings, and a second test asserts it refuses each
  escape — `database?.raw.prepare(`, `database?.raw?.prepare(`, `?.database?.raw`,
  `.raw.exec(`, `DatabaseSync` — while still allowing `database.storage.sync` and
  `rawBody`. It was also verified by construction: each escape was temporarily
  written into `packages/commercial/src/registry.js` and the guard failed on all
  four, then the file was restored. **Follow-on work, deliberately not in this
  PR:** M2A's own guard in `tests/work-legacy-task-migration.test.js` still
  carries the un-hardened pattern and deserves the same treatment; widening this
  PR to retrofit another milestone's guard would enlarge a bounded slice.
- **`tests/contracts-registry-review.test.js` keeps its fault injection.** It
  intercepts `database.raw.prepare` and matched `sql.startsWith('INSERT INTO
  definition_versions')`. The adapter quotes identifiers — `renderSqliteStatement`
  emits `INSERT INTO "definition_versions" (…)` — so that prefix stops matching
  once the insert routes through the seam, and the injected fault silently stops
  firing while the rollback assertion goes on passing without testing anything.
  Verified rather than assumed: with the original prefix the suite fails 4/5,
  and with `/^INSERT INTO "?definition_versions\b/` it passes 5/5, matching the
  quoted and unquoted spellings while rejecting `"definition_versions_other"`.
  **The rollback assertion and the counted-inserts check are byte-for-byte
  unchanged** — only the interception predicate moved. The independent
  all-or-nothing proof in the M2B suite needs no monkey-patching at all: it
  counts the insert that reached the adapter before the refusal.

## The injected-input surface, swept

Six review findings in a row were the same shape — *the store trusts something
it should validate* — so rather than answer a seventh one at a time, the whole
surface was walked at once. Each value the store accepts or produces was probed
with a failing test first; **five of six probes failed, and each failure was a
real gap.**

| Input | Was | Now |
|---|---|---|
| a generated id colliding with a row already in the table, or one repeated across two `persist` calls | reached the `PRIMARY KEY`, so the caller read SQLite's words | refused as `an id that is already registered`, by an existence check **inside** the transaction |
| `entries` itself | `[...entries]` raised a bare `TypeError: … is not iterable`, naming no contract | refused as `must be iterable` |
| an enormous or runaway batch | unbounded — an accidental infinite generator was an out-of-memory crash | capped at `MAX_BATCH` (10,000), refused as `Too many definition versions` |
| `type`, `name`, `fingerprint` length | unbounded, in a stored row *and* in a refusal a person reads at boot | capped at `MAX_IDENTITY` (200) |
| `type`, `name`, `fingerprint` contents | any character, including the control characters used for log-splitting and terminal escapes | control characters refused |
| `version` | `Number.isInteger`, so past 2^53 two different versions read back as one | `Number.isSafeInteger` |
| the `clock` return value | already validated on every call by `resolveClock` | unchanged; a test now pins that the refusal lands **before** `BEGIN IMMEDIATE`, like the rest |

**Why the id check is inside the transaction when everything else is outside.**
It reads the table, and only under `BEGIN IMMEDIATE` does the write lock
guarantee no other connection slips a row in between that read and the insert.
The asymmetry is deliberate and commented in the source, so it does not read as
an oversight. Timestamps are now minted alongside ids before the transaction,
for the same reason ids are.

**Judged acceptable, recorded so they are decisions and not omissions:**

- **A generator that throws mid-iteration** propagates the caller's own error.
  That happens while collecting the batch, before the transaction opens, so
  nothing is persisted and no driver message is involved. Wrapping a caller's
  own exception would hide where it came from.
- **`fingerprint` is not required to be 64 hex characters.** The store is
  generic: `computeDefinitionFingerprint` produces that shape, but a caller may
  legitimately use another digest, and hard-coding SHA-256's width would put a
  domain assumption in the kernel. Length and control characters are bounded,
  which is what protects the row and the message.
- **Infrastructure failures still surface as driver errors** — a full disk, a
  corrupt file. Those are not malformed input, and the store has nothing truer
  to say about them than the driver does.
- **`MAX_BATCH` and `MAX_IDENTITY` are new refusals**, so a composition beyond
  them would now fail. Both sit orders of magnitude above anything real: the
  longest `type` in this repository is `domain-policy:<domain>:<kind>` over a
  64-character package name, and no application registers ten thousand
  definition versions at startup.

## Known limitation, carried forward deliberately

**Definition-version registration has no actor context and no audit event.**
Review flagged this against AGENTS.md:153 — *"Flag any mutation without actor
context and audit event"* — and the rule applies: the store inserts into
`definition_versions` with neither. The gap is real and it is named here so the
next milestone inherits it as work rather than rediscovering it as a surprise.

Three facts bound its scope, each verified rather than asserted:

1. **It is not an M2B regression.** None of the four registries took an actor or
   emitted an audit event for this write before M2B —
   `git show e1ff9a0:<each registry>` greps clean for `actor`/`audit` in the
   persist path (signature's single hit is a `humanApproval` metadata string
   about `request-signature`, not this write). M2B preserves that behaviour
   exactly, and the three characterization harnesses independently confirm the
   observable behaviour is byte-identical.
2. **Publishing the store creates no new mutation capability.**
   `packages/app/src/create-app.js:197,204` hands every package the **full**
   `database` handle, and `createDatabase` returns `{raw, storage, path, plane,
   close, transaction, transactionAsync}` — so `.raw` was already in every
   package's hands. Any package could already write anything to any table,
   `definition_versions` included, with no actor and no audit. The store is
   strictly **narrower** than what was already reachable: four validated fields,
   one table, fail-closed, inside one transaction.
3. **Closing it is milestone work, not a refactor's tail.** Adding actor and
   audit would introduce a new startup-write behaviour across four packages,
   invalidate the byte-identical behaviour proof this milestone rests on, and
   decide by side effect a question that deserves deciding on purpose — whether
   every definition-version registration earns an audit row, and who the actor is
   at boot, before any actor exists.

The limitation is stated beside the store's description in
`docs/PACKAGE_AUTHORING.md` §10, because that is where a package author reads
about it, together with the instruction not to treat it as a general persistence
precedent.

## Validation

Run these commands under Node 22.16.0:

```bash
node --test tests/spine-v2-m2b-definition-version-store.test.js
node --test tests/commercial-contract.test.js tests/intelligence-contract.test.js \
  tests/signature-contract.test.js tests/contracts-registry-review.test.js \
  tests/package-contract.test.js
node --test tests/commercial-e2e.test.js tests/lead-intelligence-e2e.test.js \
  tests/intelligence-pre-extraction-upgrade.test.js tests/signature-order-e2e.test.js
node --test tests/spine-v2-m0-characterization.test.js \
  tests/spine-v2-m1-storage-contract.test.js tests/work-legacy-task-migration.test.js
node --test tests/characterization/*.test.js tests/falsify.test.js
node scripts/falsify.js
npm run repo:truth
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run smoke
git diff --check
npm run verify
```

## Progress log

- **2026-08-27:** Created this plan before touching source, and recorded the
  bounded slice and the later-M2 consumers.
- **2026-08-27:** Baselined the registry, package-contract, characterization and
  package-absence suites at `e1ff9a0`. One pre-existing darwin-only failure in
  `tests/spine-v2-m0-characterization.test.js` (`/private/var` vs `/var` tmpdir
  realpath) was recorded and left alone: it is unrelated to this milestone and
  does not reproduce on CI's Linux runner.
- **2026-08-27:** Added `packages/core/src/definition-version-store.js`, exported
  it from the kernel surface, and migrated all four consumers. The registry
  suites and the package end-to-end suites stayed green without being edited.
- **2026-08-27:** Added `tests/spine-v2-m2b-definition-version-store.test.js`:
  the structural guard, the store's own fail-closed and injection proofs, and a
  five-test block replayed for each of the four registry families. Mutating the
  refusal text failed four tests and removing batch validation failed five, so
  the suite refuses the regressions it claims to.
- **2026-08-27:** Reconciled the M2A inventory rows, the alignment matrix, the
  status snapshot and the task ledger, and regenerated Repository Truth.
- **2026-08-27:** Merged `origin/main` after the post-M2A measurement landed,
  resolving four `docs/PROJECT_STATUS.md` passages: the milestone row (the only
  true conflict), the next-work item, the implemented paragraph and `Open PRs`.
  `docs/repository-truth.json` was taken from main wholesale and regenerated
  rather than hand-merged; `site/claims.json` and `Measured at` were left alone,
  and `measurement.test_tree_current` correctly flipped to `false`.
- **2026-08-27:** Codex review at the merged head raised two P2s, both real and
  both fixed with regressions written first: the closed entry shape was not
  closed against non-enumerable or symbol keys, and the structural guard claimed
  more than a token scan can prove.
- **2026-08-27:** A sixth finding — a generated id colliding across calls or
  with an existing row — prompted a sweep of the whole injected-input surface
  rather than a seventh single fix. Five of six probes failed; all five are
  fixed in one push and the surface is tabled above, together with what was
  judged acceptable and why.
- **2026-08-27:** A fifth finding: the injected `newId` was validated only as a
  function, not on what it returned. Fixed by mirroring `resolveClock`, with ids
  minted pre-transaction so a malformed or self-colliding generator is refused
  before `BEGIN IMMEDIATE`. The regression asserts each refusal carries the
  framework's own error and leaks no driver message — writing it surfaced that
  the store's first duplicate-id message contained the word "unique" and tripped
  the test's own leak check, which is the check doing its job.
- **2026-08-27:** Review raised a P1 for the missing actor and audit event.
  Verified all three bounding facts before ruling: no registry carried either
  before M2B, `create-app.js` already hands every package the full `database`
  handle including `.raw`, and the store is strictly narrower than what that
  handle already allowed. Recorded as a named limitation here and in
  `docs/PACKAGE_AUTHORING.md` §10 rather than implemented, because closing it
  would stop M2B being a refactor.
- **2026-08-27:** A third P2 on the next head: the entry shape was still open to
  prototype pollution, because refusing unnamed keys says nothing about whether
  the named ones are own properties. Fixed with `Object.hasOwn` for all four
  fields, regression first, `Object.prototype` restored in a `finally`.
- **2026-08-27:** CI `verify` failed on the pushed head and caught two things
  the targeted suites could not: the falsification mutation had stopped aiming at
  anything, and the three characterization baselines were stale. Both are
  regressions this PR caused. Re-aimed the mutation at the store and regenerated
  the baselines; the whole baseline diff is four source-hash lines with zero
  observation changes. This is the reason a milestone runs `npm run verify` and
  not only the suites it thinks it touched.
- **2026-08-27:** Integrator review raised that `docs/PACKAGE_AUTHORING.md` §10
  enumerates the public kernel surface and no longer described it. Updated §10,
  and recorded both the rejected `database.definitionVersions` alternative and
  the pre-existing staleness of that enumeration.
- **2026-08-27:** Hardened the M2B guard after review raised that optional
  chaining evades the inherited token scan. Proved it by construction — four
  escapes written into a migrated file, guard failing on each, file restored —
  and re-derived the raw-driver inventory with the widened pattern across
  `packages/`, `scripts/` and `apps/`, which is what put `scripts/repo-truth.js`
  and Work's optional-chained residue into the table.

## Outcome and follow-up

The four declared registries no longer reach the raw SQLite driver, and the loop
they shared exists once. Public behaviour is unchanged: `persistFingerprints(database)`
keeps its signature, `createAccordoApp()` stays synchronous, Storage Contract v1
is untouched, and the ADR-015 refusal is byte-identical — a test asserts the whole
message, per family, rather than matching a fragment of it.

Explicitly still open, and deliberately so: `packages/workflows/src/engine.js` and
`packages/core/src/action-runtime.js` remain later-M2 raw consumers;
`packages/work/src/follow-up.js#requireCallerTransaction` still reads the driver's
transaction flag through optional chaining, so Work stays `partial` — and that
residue is invisible to a plain `database\.raw` scan, which is why the M2B guard
catches the optional-chained spelling and why M2A's guard is named above as
follow-on work; the adapter internals in
`packages/core/src/database.js`, `core-adapters.js` and `spine-store.js` own the
driver by design. PostgreSQL remains absent.
