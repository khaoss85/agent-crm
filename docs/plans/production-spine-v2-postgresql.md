# Production Spine v2 — PostgreSQL per-tenant storage

## Goal and user-visible outcome

Add a production PostgreSQL data-plane adapter without changing Accordo's
current tenancy model: one running application instance is bound to one tenant
and one isolated data plane. A project can select SQLite for local and existing
deployments or PostgreSQL for a production deployment, while module services,
actions, workflows, audit and trace retain the same externally observable
behaviour.

This plan deliberately does **not** implement shared-database row tenancy,
Cloud C0, authentication, durable jobs, secrets, backups or observability.
PostgreSQL is not permission to claim general production readiness. The
framework still authenticates nobody; a deployment adapter still supplies the
verified identity described by ADR-038.
<!-- truth: spine.authentication.framework_verifier=absent -->
<!-- truth: spine.tenant.isolation.mode=one_tenant_per_instance -->
<!-- truth: spine.postgresql.implemented=absent -->

## Current repository context

The plan starts from merged closeout main `9c8565f`. The current measurement
ledger describes ancestor `5a9b7fb`; its measured result and test-tree identity
remain owned exclusively by `site/claims.json` and are not repeated here.

The current storage boundary has two distinct layers:

- `packages/core/src/tenant-storage.js` binds one tenant to one SQLite data-plane
  path and one separate control-plane path. The application receives no
  `databasePathFor` method, so a second tenant is unreachable through its
  binding.
- `packages/app/src/create-app.js` consumes that binding and creates a data-plane
  and control-plane database through `packages/core/src/database.js`.
- `packages/core/src/database.js` is not yet a portable adapter contract. Its
  public JSDoc shape wraps `node:sqlite`, exposes `raw: DatabaseSync`, and module
  services issue synchronous SQLite statements through `database.raw.prepare()`.
  More than fifty package/application/test files depend on that shape. Calling
  it an existing swappable adapter would overstate what the code proves.
- Data-plane and control-plane migrations are already separated, and generated
  module/package migrations join the data plane at composition time. That
  separation is reusable; their SQLite SQL text is not automatically portable.
- ADR-038 says row-level PostgreSQL tenancy belongs to Spine v2, while the
  ratified mission chooses the narrower current deployment model: PostgreSQL
  **per tenant**, one tenant per instance, with shared-database tenancy deferred
  unless economics justify it. Implementation must amend ADR-038 and the
  execution roadmap explicitly rather than leaving those two authorities in
  conflict.

Before implementation, re-read `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md`,
`docs/strategy/MASTER_PLAN.md`, `docs/PROJECT_STATUS.md`, ADR-038,
`docs/QUALITY_GATES.md`, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, and
the files above. Run the smallest relevant source/composition checks; do not
infer runtime database health from `app inspect`, which is source-only.

## Approaches considered

### A. Translate SQL strings at the PostgreSQL boundary

Keep every service synchronous and rewrite SQLite syntax/placeholders in an
adapter. Rejected. PostgreSQL drivers are asynchronous, transaction affinity
matters, and a SQL-text translator would make correctness depend on an
incomplete parser. It would appear cheap only by hiding the largest risks.

### B. Make the entire application asynchronous in one change

Replace `DatabaseSync`, convert every service and every caller to promises, and
land PostgreSQL simultaneously. Rejected as a single causal changeset. It mixes
a framework-wide control-flow refactor, query portability, migration
portability and a new production dependency; a failure could not be localized
or rolled back safely.

### C. Characterize, extract a narrow async storage contract, migrate two real
consumers, then add PostgreSQL

Chosen. First freeze externally observable SQLite behaviour. Introduce the
smallest contract that two unlike consumers actually need (one core module and
one generated/package module), prove it over SQLite, then migrate the remaining
consumers in bounded groups. Only after the application no longer exposes
SQLite driver semantics does the PostgreSQL implementation join the same
conformance suite. This applies the two-consumer rule before declaring a
generic seam and keeps each milestone runnable.

The contract is not a query builder and not an ORM. Its candidate operations are
bounded prepared execution/query methods over a small dialect-neutral statement
object, transaction scoping, migration application and close. A statement owns
canonical SQL intent plus ordered parameters; each adapter renders its own
placeholders and the few explicitly supported syntax differences. Service code
must not pass SQLite SQL (`?`, SQLite-only functions or pragmas) through the
portable boundary, and the PostgreSQL adapter must not guess by translating an
arbitrary SQL string. Exact names, supported clauses and normalized result
shapes are frozen only after the first two consumers demonstrate them; raw
driver handles and dialect SQL never cross the contract. If the two consumers
need materially different query shapes, add only those shapes and prove refusal
of an unsupported one rather than growing a general query language.

## Milestones

### M0 — Freeze the branch point and the observable contract

1. Run a clean Node 22.16.0 baseline: `npm run verify`, `npm run smoke`,
   `npm run repo:truth -- --check`, `npm run gtm:check`, and `npm run site:check`.
2. Add characterization that drives the public API/SDK and named workflows over
   SQLite for CRUD, managed-action refusal, audit/event/trace exactness,
   transaction rollback, restart persistence, migration adoption and two-
   connection contention.
3. Characterize the in-process API separately: synchronous
   `createAccordoApp()`, immediate access to `app.modules`, synchronous service
   reads/writes, the starter installer and every checked example that reads a
   return value without `await`. This is a shipped consumer contract, not an
   implementation detail hidden behind HTTP.
4. Characterize every executable composition entry point: `npm start`/`serve`,
   `crm db:migrate` and the project MCP stdio server. Record startup success,
   migration completion, bounded JSON/stdout and clean shutdown for SQLite;
   record the current stable refusal when PostgreSQL is requested before the
   async path exists. A direct factory test is not evidence that an operator can
   boot the selected adapter.
5. Record normalized receipts that contain domain objects and stable error
   codes, never driver messages, paths, timing or database-specific metadata.
6. Freeze the released core migration identities before editing migration SQL:
   version, name, source checksum and the schema shape observed after each
   supported legacy upgrade point. These pinned baseline constants, reviewed in
   M0, are the only authority a later checksum-ledger backfill may trust.

Exit: the existing SQLite application remains byte-compatible at its public
surfaces and the characterization fails when a storage-visible invariant moves.

### M1 — Extract the storage contract with two consumers

1. Define a versioned internal storage contract in `packages/core` because it is
   a reusable runtime capability consumed by every domain, not domain-specific
   behaviour. State the ADR-018 justification in the PR and ADR.
2. Implement that contract over SQLite without changing schema or behaviour.
3. Migrate two materially different consumers first: the handwritten Company
   module and one generated/package-owned resource with migrations, exact reads,
   audit and an action. The Company slice includes its dependency closure — at
   minimum Contact and Opportunity creation and every workflow/action that calls
   Company synchronously — or an explicit adapter facade that retains the old
   call semantics. Tests must prove a missing Company still refuses before any
   dependent write and produces no unhandled rejection or raw constraint error.
   Do not declare the seam generic until both consumers pass.
4. Introduce a versioned asynchronous composition entry point for portable
   storage (provisionally `createAccordoAppAsync`). Existing
   `createAccordoApp()` remains the synchronous SQLite contract and refuses a
   PostgreSQL configuration rather than returning a promise conditionally. The
   two factories may share composition descriptions and registries, but a
   caller never has to inspect an option to learn whether startup is async.
   Clear the DX Simplicity Gate before accepting that name or surface:
   - **failure prevented:** an agent treats a conditionally promise-returning
     `createAccordoApp()` as an application, or forgets to await PostgreSQL
     startup, and proceeds with an uninitialised security boundary;
   - **why extension is insufficient:** PostgreSQL connection and migrations
     cannot complete synchronously, while changing the existing factory to
     always return a promise breaks every characterized SQLite caller;
   - **overlap bound:** the old factory is the compatibility-only SQLite
     contract; the new factory is the only portable composition contract, not
     a second way to do the same PostgreSQL job;
   - **portable evidence:** publish a versioned application-composition contract
     in code and assert its startup/result shape over both adapters, including
     type-level or executable proof that PostgreSQL cannot be selected through
     the synchronous factory;
   - **simpler goal flow:** a production caller has one unconditional `await`
     path, never a storage-dependent return type. If implementation cannot show
     that net simplification, keep the surface deferred and redesign the seam.
5. Remove direct `raw` access from those consumers and add a guard that prevents
   it from returning.
6. Exercise the first two consumers against both adapter renderers before a
   PostgreSQL connection exists: assert byte-exact SQLite/PostgreSQL rendering,
   parameter order, null/boolean/time/integer normalization, identifier
   allowlisting and refusal of raw SQL. Integer normalization retains the
   repository's JavaScript safe-integer contract: PostgreSQL renders persisted
   integer and monetary-cent fields as 64-bit `BIGINT`, binds safe integers
   without precision loss and converts returned driver strings to `number` only
   after a canonical decimal and `Number.isSafeInteger` check. An out-of-range
   database value fails with a stable bounded code rather than rounding. This is
   the executable proof that ordinary runtime
   queries—not only migrations—have a portable representation.
   Treat identifiers as UTF-8 bytes under PostgreSQL's 63-byte limit. Render
   physical table/column/index/constraint names through one deterministic map:
   unchanged when safe, otherwise a bounded prefix plus collision-resistant
   digest recorded in migration intent/state. Validate the complete rendered
   namespace before bootstrap and never rely on server truncation or `IF NOT
   EXISTS`. Long, multibyte and same-prefix legacy names must map distinctly and
   stably or fail with a precise pre-connect diagnostic; SQLite history stays
   byte-identical.

Exit: both consumers pass the same contract and characterization tests while
all untouched consumers continue on the compatibility path.

### M2 — Complete the SQLite-side extraction

1. Move remaining core modules, generated services, package services, audit,
   trace, workflows, the Spine store and migration bookkeeping in reviewable
   groups. Treat the Spine store as a dependency closure: its membership writes
   use the control plane and its audit evidence currently uses the tenant data
   plane, so changing either handle without the caller is forbidden.
2. Convert service/application control flow on the new async composition path;
   preserve route and SDK response shapes. Keep the characterized synchronous
   SQLite factory and its service methods valid for existing in-process callers,
   starters and examples. Any later retirement is a separately versioned
   deprecation, not an incidental consequence of PostgreSQL.
   Version package/action semantics before exposing async services:
   `packageContract: 2` and `actionContract: 2` require actions and capability
   consumers to await every service/context operation. Contract 1 retains its
   synchronous SQLite semantics and is refused during PostgreSQL composition
   with `PACKAGE_ASYNC_CONTRACT_REQUIRED` before migration or provider setup;
   it is never handed Promise-shaped services. Migrate bundled packages
   explicitly and keep an unchanged legacy custom-package fixture green on
   SQLite and fail-closed on PostgreSQL. Clear the DX Gate: the failure prevented
   is a Promise used as a domain value; synchronous v1 cannot represent an async
   driver; v2 is the single portable contract; inspection publishes the version
   as evidence; and authors gain one unconditional `await` rule across adapters.
3. Delete the compatibility path only after a repository guard proves no
   business consumer reaches `DatabaseSync`, `.raw.prepare()` or `.raw.exec()`.
4. Keep the provisioning-side tenant resolver separate from the application
   binding; the application handle still cannot name a second tenant.
5. Make cross-plane Spine writes explicitly recoverable rather than pretending
   two independent databases share an atomic transaction. In the same control-
   plane transaction as a membership/organization mutation, persist a bounded,
   immutable audit intent with a deterministic idempotency key. Finalization
   copies that evidence to the tenant audit log and marks the intent delivered;
   a failed finalization leaves visible pending evidence, never an unaudited
   mutation or an unhandled rejection. Retry/restart reconciliation is explicit
   and idempotent, and a caller response states committed-with-pending-audit
   rather than returning a false rollback. This is bounded recovery for a
   security write, not the general durable jobs/outbox promised by Spine v3.
6. Replace storage details on every public/in-process surface with a bounded
   descriptor such as `{adapter, available}`. In particular, `app.database`,
   `app.tenantBinding`, `app.doctor()`, `serve`, `db:migrate`, startup logs and
   CLI JSON must never expose a PostgreSQL URL, host, database, user, password or
   driver error. The compatibility SQLite surface may retain its documented
   path where existing callers require it; the portable contract never does.
7. Migrate `serve`, `crm db:migrate` and MCP stdio composition onto the
   unconditional async factory when PostgreSQL is selected, while retaining the
   characterized synchronous SQLite path. Each entry point must await startup
   and migrations before accepting a request or writing a success response,
   propagate a stable bounded startup failure, and close the selected adapter on
   signal/error. Add end-to-end child-process tests for both adapters; calling
   `createAccordoAppAsync` directly is not sufficient evidence.
8. Define one shared, versioned deployment-storage configuration loader used by
   the factory, CLI and MCP rather than inventing flags independently. The
   candidate contract is a path to a permission-restricted JSON document with a
   closed `{contract, adapter, connection, spine, identityVerifier}` envelope;
   `connection` is
   consumed only by the adapter and never returned, while `spine` resolves the
   canonical tenant through ADR-038's existing binding. Existing `--db` remains
   SQLite-only. Supplying both surfaces, an unknown adapter/key, inline
   credential CLI argument, missing/unreadable config, or PostgreSQL without a
   resolved spine/tenant binding fails before a connection is opened. Explicit
   CLI config takes precedence over a single documented environment path; there
   is no precedence between PostgreSQL and `--db` because that combination is a
   refusal. MCP uses the same loader and rules.
   Before reading bytes, the loader uses a no-follow open/stat discipline and
   requires a regular file owned by the effective process identity with no
   group/other permission bits; symlinks, ownership mismatch, `0640`/`0644` and
   post-open identity changes fail with one stable pre-parse code. On a platform
   where ownership/mode cannot be proved, production config-file loading refuses
   rather than assuming secrecy; a future platform secret adapter needs its own
   contract. Fixtures cover every refusal and prove diagnostics contain neither
   the path nor file bytes.
   Clear the DX Simplicity Gate before naming the surface:
   - **failure prevented:** three executables invent different adapter/tenant
     selection and accidentally boot PostgreSQL unbound or print a credential;
   - **existing primitive insufficient:** `--db` is a public SQLite path and
     cannot safely carry a structured spine binding or secret connection input;
   - **overlap bound:** one loader/contract selects deployment storage for every
     executable; `--db` is retained only for SQLite compatibility;
   - **portable evidence:** publish a versioned closed-schema parser and a
     cross-entry-point matrix proving identical selection, precedence and stable
   refusal codes with sentinel credentials absent from output;
   - **simpler goal flow:** an operator supplies one configuration path to any
   executable, never a command-specific set of adapter flags. If this cannot
   be demonstrated, redesign rather than adding the surface.
   `identityVerifier` is a checked repository-relative ESM provider reference,
   not executable code or a credential in JSON. The shared loader resolves its
   real path inside the project root (rejecting absolute, escaping and symlink-
   escaping paths), imports it before database connection, and requires one
   named factory with a versioned data-only provider contract. The factory
   receives only its bounded provider configuration and returns ADR-038's
   verifier function; it reads credentials through the deployment environment
   or secret manager, never through CLI arguments or public results. Production
   mode requires this reference; local mode refuses a configured production
   verifier rather than silently changing trust. Factory, `serve`, MCP and any
   HTTP entry point use the same resolver. Add fixture providers for success,
   malformed export, throw/reject, escaping path and credential-sentinel tests,
   and prove no listener/database handle exists before verifier resolution. Run
   provider initialization under one documented bounded startup deadline with
   an abort signal where the provider supports it; always clear the timer,
   abandon/ignore late settlement and return a stable verifier-timeout code.
   A hanging fixture must make each child process exit nonzero within the bound
   with no open listener/database and no credential in diagnostics.

Exit: SQLite passes the full suite through the portable contract, and the raw
SQLite driver is private to the SQLite adapter. Both the legacy synchronous
SQLite composition and the new async SQLite composition pass their respective
characterization suites.

### M3 — Add PostgreSQL migrations and adapter

1. Add one production PostgreSQL driver only after recording in `DECISIONS.md`
   why it removes more complexity than a home-grown wire protocol. Pin and audit
   it; never wrap an import in `try/catch`.
2. Represent migration intent in an authoritative form that renders explicit
   SQLite and PostgreSQL SQL. Map every manifest/core integer—including every
   cents field—to PostgreSQL `BIGINT`, not 32-bit `INTEGER`, while retaining each
   domain validator's narrower bounds. Do not translate arbitrary SQL at runtime.
3. Version generated `module.state.json` additively. Preserve every v1
   `{name, checksum, sql}` SQLite migration byte-for-byte; never regenerate or
   reinterpret that applied history. For a legacy evolved module, derive and
   check in a separately named PostgreSQL **bootstrap** from the state's
   normalized current manifest for use only on an empty PostgreSQL data plane,
   plus dialect-specific entries for every later evolution. The bootstrap has
   its own checksum and provenance pointing at the v1 state fingerprint; it is
   not recorded as the old revisions having run on PostgreSQL. Refuse a
   non-empty data plane or a state whose current manifest cannot produce the
   bootstrap. Extend the existing module-evolution authority to perform this
   explicit backfill; if that requires a new flag/surface, clear the DX Gate
   rather than adding a side-door script.
   A generated registry entry that predates `module.state.json` is a separate
   supported legacy input, not an empty state: before PostgreSQL startup, adopt
   its checked SQLite migration through the existing module-evolution authority,
   verify the generated source and observed SQLite schema against the adopted
   revision, and check in the resulting state plus PostgreSQL bootstrap. Runtime
   startup must refuse `LEGACY_MODULE_STATE_REQUIRED`; it must never silently
   synthesize or write source state during deployment. Provide a fixture for
   this exact pre-state registry shape and prove adoption is deterministic,
   preserves its original SQLite bytes/checksum and produces the same current
   schema as a natively stateful module.
4. Preserve append-only name/checksum semantics. An applied migration whose
   authoritative intent changes must fail closed on both adapters. Upgrade the
   legacy core `schema_migrations(version, name, applied_at)` ledger through a
   versioned migration: accept/backfill only an exact version+name tuple from
   M0's pinned released baseline **and** a matching observed schema shape, and
   write the pinned checksum rather than hashing whatever source happens to ship
   in the upgrade. An unknown tuple, missing object or divergent schema refuses
   startup. Migrations first applied under the new ledger record and validate
   their checksum normally.
5. Implement prepared parameter binding, result normalization, nested
   savepoints, transaction connection affinity, rollback, conflict mapping and
   deterministic close over PostgreSQL. Preserve SQLite's serialized-write
   observable semantics with an explicit PostgreSQL rule: state-changing
   actions/workflows lock the authoritative record (`SELECT … FOR UPDATE`) or
   use a versioned compare-and-swap inside the outer transaction before
   evaluating/committing a transition. A serialization/deadlock loser receives
   one bounded retry only where the whole operation is replay-safe; otherwise it
   returns a stable conflict and produces no audit, event or trace claiming a
   transition. Never retry a provider side effect implicitly. Set adapter-owned
   per-transaction `lock_timeout` and `statement_timeout` locally (never rely on
   server/account defaults); normalize either expiry to stable bounded storage
   codes, roll back, and clear transaction-local state with the connection. Run
   every business-write outer transaction at PostgreSQL `SERIALIZABLE`, so
   predicates spanning multiple rows retain SQLite's single-writer behavior.
   Normalize serialization failures and retry only when the complete effect plan
   proves no external operation occurred; a per-record lock alone is never the
   portability guarantee. Each retry attempt owns fresh transaction-local event
   and trace-step buffers nested inside the attempt, not one buffer around the
   retry loop. A serialization rollback discards them before another callback is
   entered; only the committed attempt promotes events for post-commit dispatch
   and steps into the one final trace. Audit rows remain inside the rolled-back
   database transaction. Configure client-side connection and pool-acquisition
   deadlines separately from server deadlines. On expiry cancel/destroy the
   pending client, release pool bookkeeping, clear timers/sockets and return a
   stable unavailable/timeout code.
6. Bind a PostgreSQL data plane by opaque connection configuration, not by a
   filesystem path. Never return a credential, URL, host or database name in
   the application object, tenant binding, doctor output, CLI/stdout, startup
   logs, schema metadata, audit, trace or an error. Add sentinel credentials to
   the conformance fixture and scan every returned object and captured
   stdout/stderr/audit/trace payload for both the full URI and each component.
7. Persist a singleton tenant-binding marker inside each PostgreSQL data plane.
   PostgreSQL composition is invalid without a successfully resolved ADR-038
   spine binding and canonical tenant; there is no synthetic or unbound
   PostgreSQL mode. First provisioning claims an empty database for exactly one canonical tenant
   in the same locked transaction that establishes the migration ledger; every
   later boot compares the configured binding with that marker before any
   domain handle is exposed. A mismatch fails startup with a stable code that
   echoes neither tenant id nor connection detail. The marker is storage
   enforcement metadata, not a row-tenancy filter and not caller-writable data.
8. Own one fixed, versioned PostgreSQL schema name in the adapter and schema-
   qualify the tenant marker, migration ledgers and every domain/audit/trace
   object. Refuse or override connection-level `search_path`; it is never an
   isolation input. Provisioning locks and claims the fixed qualified marker
   before any other qualified object is inspected or created. The conformance
   suite must connect two tenants to the same database with deliberately
   divergent `search_path` options and prove the second binding still reaches
   the same marker and refuses before migrations or domain access. It must also
   change `search_path` between restarts and prove no object becomes hidden or
   newly reachable.

Exit: a PostgreSQL instance can boot, migrate and run the two-consumer slice;
SQLite remains green.

### M4 — PostgreSQL conformance and tenant isolation proof

1. Run the same storage conformance suite against SQLite and PostgreSQL.
2. Run the full technical suite against both adapters, not two hand-selected
   smoke paths.
3. Start from a stateVersion-1 fixture with at least two evolved generated
   module revisions. Prove its SQLite migration bytes/checksums never move,
   its PostgreSQL bootstrap creates the current schema on an empty database,
   later dialect migrations apply in order, restart is idempotent, and a
   non-empty/adversarial target is refused rather than adopted.
   Repeat the proof from a pre-state generated registry entry: PostgreSQL boot
   refuses until the explicit checked-in adoption/backfill has run, then the
   empty PostgreSQL bootstrap and later evolution behave identically.
4. Prove two tenant bindings use distinct PostgreSQL databases/data planes. A
   subject from tenant B receives the existing 404-before-403 cross-tenant
   refusal and cannot read tenant A's domain, audit or trace rows.
5. Deliberately configure tenant B with tenant A's already-claimed PostgreSQL
   database and prove boot is refused before migrations, modules, audit or
   request handling can touch it. Race two first boots for different tenants
   against one empty database and prove exactly one claim wins; the loser gets
   the same bounded refusal and no mixed schema or rows.
6. Prove an application binding still has no operation that can select another
   tenant. No `organization_id` filter is introduced and no shared database is
   claimed.
7. Test migration restart, concurrent migration startup, transaction rollback,
   two-connection races, exact reads beyond page bounds, hostile input and
   normalized constraint/conflict errors on PostgreSQL. Persist and read the
   monetary boundaries already accepted by the repository, including delivery's
   1,000,000,000,000-cent value and a generic safe-integer boundary fixture;
   assert byte-equivalent JSON/domain-object numbers on SQLite and PostgreSQL.
   Inject `BIGINT` values beyond JavaScript's safe range directly and prove the
   read refuses instead of rounding or leaking a driver string.
   Race two different terminal actions against the same pre-state record and
   prove at most one commits; the loser has a stable conflict/refusal and writes
   no contradictory audit/event/trace evidence. Repeat around an external
   operation and prove no automatic retry duplicates its provider call.
   Hold the authoritative row lock past the configured deadline and prove the
   contender returns the normalized timeout/conflict within a bounded interval,
   rolls back, and writes no audit/event/trace evidence; then release the holder
   and prove the pooled connection has no leaked timeout/transaction state.
   Race two distinct leads for the final slot of a capacity-one routing target;
   exactly one assignment commits and the serialization loser writes no audit
   or event and no successful-transition span, while the existing action runtime
   retains exactly one failed diagnostic trace with only the normalized conflict
   code. Point startup at a black-hole authentication endpoint and
   exhaust a size-one pool with a held client; connection and acquisition each
   refuse within their own bounds, clean pending resources, and allow process
   shutdown/recovery.
   Force one replay-safe action to reach commit with an emitted event/trace step,
   inject a serialization failure, then let its second attempt commit. Assert
   exactly one audit row, one dispatched event and one successful-attempt step;
   no event or trace step from the rolled-back attempt survives.
8. Fault-inject every point between a control-plane authorization mutation, its
   local audit intent and tenant-audit finalization. Prove the mutation plus
   intent are atomic, pending evidence survives restart, reconciliation records
   exactly one audit row, divergent replay is refused, and no success response
   claims a rollback that did not occur.
9. Upgrade a real legacy core database whose ledger has no checksum and prove
   only M0's pinned baseline is backfilled. Change a historical name, schema
   object and current source independently; each must refuse rather than bless
   the checkout's bytes as history.

Exit: PostgreSQL per-tenant storage is executable evidence rather than a
configuration claim, and SQLite/PostgreSQL differences cannot escape the
adapter contract.

### M5 — Truth, documentation and adversarial review

1. Amend ADR-038 and `docs/strategy/EXECUTION_ROADMAP.md`: Spine v2 is
   PostgreSQL per-tenant storage; shared-database row tenancy is deferred to a
   separately justified economic/scale decision.
2. Update `PRODUCT.md`, `ARCHITECTURE.md`, `TASKS.md`, `docs/PROJECT_STATUS.md`,
   application inspection limitations, bootstrap/starter copy and the
   Repository Truth authorities in the same PR. Regenerate
   `docs/repository-truth.json`.
3. Add the horizontal storage-contract row to
   `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, recording every existing
   domain as `aligned | partial | deferred | not_applicable | needs_extraction`
   with one-line reasons. Do not refactor a domain opportunistically to make a
   cell green.
4. Keep JTBD coverage conservative until a merged end-to-end scenario proves a
   named job. PostgreSQL conformance alone promotes no row.
5. Use the `adversarial-review` skill. Fix every technical P1/P2/P3 with a
   regression, rerun from a clean clone against both adapters, and request a
   fresh exact-head review.

Exit: exact-head GitHub CI and the relevant deployment check are green, truth
and public limitations agree, and no review thread remains technically open.

## Success evidence

The implementation PR is complete only with machine-readable receipts for:

- one contract suite, unchanged, passing against SQLite and PostgreSQL;
- full application verification against both adapters;
- deterministic migration/checksum equivalence and restart;
- safe legacy core-ledger backfill from pinned release identities, never from
  mutable current source;
- rollback after each significant write and correct savepoint nesting;
- two-connection conflict behavior with no raw driver error;
- one-tenant-per-instance isolation across domain, audit and trace reads;
- persistent data-plane ownership: an aliased database and a conflicting
  first-boot race both fail closed before the application receives a handle;
- adapter-owned schema qualification: divergent or changed `search_path` values
  cannot create a second marker, hide a ledger or redirect a domain query;
- recoverable cross-plane Spine audit: every committed authorization mutation
  has atomic local evidence and converges idempotently to exactly one tenant
  audit row;
- no credential or storage locator in public schema, errors, audit or trace;
- no credential or storage locator in the application object, tenant binding,
  doctor, CLI/stdout or startup diagnostics;
- pre-state generated modules require explicit deterministic adoption and then
  pass the same PostgreSQL bootstrap/evolution suite as stateful modules;
- ordinary service statements use the dialect-neutral runtime-query contract;
  raw SQLite SQL is rejected at the portable boundary and both renderers retain
  parameter order and normalized results;
- PostgreSQL `BIGINT` preserves accepted integer/cents values as safe JavaScript
  numbers at the existing domain boundaries and refuses unsafe stored values;
- package/action contract v2 makes async service semantics explicit across both
  adapters; legacy contract-1 packages remain synchronous on SQLite and refuse
  before PostgreSQL startup;
- long or multibyte logical identifiers map deterministically to collision-free
  PostgreSQL physical names or fail before bootstrap;
- the SQLite characterization unchanged from M0;
- the synchronous SQLite in-process API and starter remain valid, while the
  async factory has one unconditional startup/service contract on both adapters;
- `npm start`/`serve`, `crm db:migrate` and MCP stdio boot PostgreSQL through the
  awaited async composition path, refuse before serving on failed startup, and
  retain their characterized SQLite behavior;
- one closed deployment-storage config selects adapter plus spine binding
  identically for factory/CLI/MCP, is mutually exclusive with SQLite `--db`, and
  PostgreSQL always refuses without a resolved canonical tenant;
- production executables resolve one checked, repository-contained verifier
  provider contract before database/listener startup; malformed or escaping
  providers fail closed without leaking their configuration;
- verifier-provider initialization and PostgreSQL lock/statement waits have
  adapter-owned deadlines; hanging/held resources fail with stable codes, clean
  timers/transactions and no mutation evidence;
- competing same-record transitions preserve serialized behavior: one outcome
  commits, and no losing/retried path emits contradictory evidence or repeats an
  external side effect;
- serializable outer writes preserve cross-record predicates, including two
  leads racing for one routing-capacity slot;
- serialization retries use attempt-local event and trace buffers; rollback
  discards the first attempt and only committed evidence is promoted;
- a serialization loser retains one normalized failed trace for diagnosis while
  writing no audit/event/success evidence;
- connection establishment and pool acquisition own client-side deadlines and
  release their timers, sockets and slots on bounded refusal;
- repository truth, GTM, site, smoke and clean-clone quality gates green.

The implementation PR must document how PostgreSQL was supplied to CI (service
container, pinned version, readiness probe and database lifecycle). A skipped
PostgreSQL suite is a failure, not a green result.

## Rollback

Until M3, rollback is a normal code revert because SQLite remains authoritative
and no PostgreSQL data is promised. From M3 onward migrations are forward-only:
rollback means deploy the last compatible application while retaining the
database, never edit or delete an applied migration. Before any production
cutover, rehearse export/restore into a fresh per-tenant database and record the
receipt. There is no automatic SQLite↔PostgreSQL live-data migration in this
milestone; such a migration needs its own plan, idempotency contract and rollback
evidence.

## Validation

During implementation, run the smallest gate that answers the current question;
the final clean-clone pass includes:

```bash
npm run verify
npm run smoke
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run crm -- project verify --json
```

Add the adapter-conformance and PostgreSQL project-verification commands to
`package.json` only if they clear the DX Simplicity Gate. Prefer internal test
scripts invoked by existing `verify`/`project verify` authorities over a new
agent-facing rail.

## Progress log

- 2026-08-23: governance closeout verified on live GitHub. PR #111 merged as
  `51b276b`; Vercel provenance restoration merged in PR #112 as `8ca790a`;
  post-governance truth merged in PR #113 as `240ffd4`.
- 2026-08-23: exact-main CI exposed a temporary-git fixture race. PR #114
  disabled fixture-local automatic Git maintenance and merged as `5a9b7fb`;
  production provenance behavior was unchanged.
- 2026-08-23: final measurement PR #115 merged as `9c8565f`, measuring source
  `5a9b7fb`; exact-head GitHub CI, Vercel and Codex review were green.
- 2026-08-23: inspected ADR-038, the tenant binding, database composition,
  migration planes, raw SQLite consumers, quality gates and legacy-alignment
  rule. Plan written; implementation has not started.
- 2026-08-23: exact-head review identified three remaining implementation-plan
  gaps: runtime query portability, credential-bearing in-process/CLI surfaces,
  and generated registries predating `module.state.json`. The plan now gives
  each a fail-closed contract and executable regression fixture.
- 2026-08-23: fresh exact-head review found that direct factory coverage left
  the shipped CLI and MCP executables on synchronous-only composition. Their
  awaited PostgreSQL startup, migration, refusal and shutdown paths are now
  explicit M0/M2 characterization and exit evidence.
- 2026-08-23: a second exact-head review attacked PostgreSQL `search_path` as an
  alias around the singleton marker. The adapter now owns and qualifies one
  fixed schema, and the isolation proof includes divergent and drifting paths.
- 2026-08-23: exact-head review exposed PostgreSQL's 32-bit `INTEGER` as narrower
  than existing monetary contracts. Integer/cents columns now require `BIGINT`,
  checked safe-number normalization and cross-adapter persisted boundaries.
- 2026-08-23: the next review closed three planning ambiguities: all executables
  now share one versioned storage-config selection contract, PostgreSQL has no
  unbound/synthetic-tenant mode, and same-record transitions require locking or
  compare-and-swap with side-effect-safe conflict semantics.
- 2026-08-23: exact-head review proved a data-only spine binding could not supply
  ADR-038's required verifier function. The shared deployment contract now names
  a checked repository-contained verifier provider with fail-before-connect
  resolution and executable child-process evidence.
- 2026-08-23: the next review attacked non-settling verifier initialization and
  an indefinitely held PostgreSQL row lock. Both now require explicit local
  deadlines, cleanup/late-settlement behavior and hanging-resource regressions.
- 2026-08-23: exact-head review expanded portability to third-party package
  contracts, cross-record predicates, pre-session waits and PostgreSQL's 63-byte
  identifier limit. Versioned async contracts, serializable writes, client-side
  deadlines and deterministic physical-name mapping now cover those boundaries.
- 2026-08-23: review bound current Spine claims to executable truth facts,
  required deployment-config ownership/mode checks before parsing secrets, and
  preserved the action runtime's failed trace for serialization losers.
- 2026-08-23: fresh review found that a transaction retry could reuse the outer
  event/trace buffers and publish rolled-back attempt evidence. Buffers are now
  attempt-local with an injected commit-conflict-then-success regression.

## Decision log

- **Tenancy stays one tenant per instance/data plane.** The mission's ratified
  target narrows the older roadmap sentence that bundled PostgreSQL with
  shared-database row tenancy. The implementation ADR must reconcile it.
- **No fake adapter seam.** `AccordoDatabase` currently exposes `DatabaseSync`;
  the plan calls it SQLite infrastructure, not a portable contract.
- **Async portability is extracted before PostgreSQL.** This avoids a SQL
  translator and prevents one unreviewable all-repository conversion.
- **Two consumers before generalization.** One handwritten module and one
  generated/package consumer must shape the contract.
- **No data-migration promise.** Adapter conformance and moving an existing
  tenant's live data are separate correctness problems.
- **Portable queries are structured, not translated.** Adapters render a
  bounded statement contract; neither service code nor the PostgreSQL adapter
  smuggles arbitrary SQLite SQL through the seam.
- **Legacy source adoption is explicit and checked in.** PostgreSQL startup
  never mutates a pre-state generated module or guesses its history.
- **Opaque means absent from surfaces.** A PostgreSQL locator is configuration
  input only, never an application/doctor/CLI result or diagnostic.
- **A database binding cannot depend on `search_path`.** Every storage object is
  addressed through the adapter-owned qualified schema, so configuration cannot
  manufacture an apparent second singleton inside the same database.
- **A portable integer is a JavaScript safe integer.** PostgreSQL storage uses
  `BIGINT`; adapter reads convert only canonical in-range values and never round
  or expose driver-specific strings.
- **PostgreSQL selection is one deployment contract.** Factory, CLI and MCP
  consume the same closed config; legacy `--db` remains SQLite-only and cannot
  be combined with it.
- **Verifier code is a provider, not JSON.** The deployment document references
  one repository-contained versioned factory; every executable resolves it
  before opening storage or a listener, and credentials stay in the deployment
  environment/secret manager.
- **PostgreSQL is always tenant-bound.** Absence or failure of the ADR-038 spine
  binding refuses startup before connection/provisioning.
- **State transitions serialize at the record boundary.** Lock/CAS conflicts do
  not become two successful transitions, two evidence trails or a repeated
  provider call.
- **Every external wait used for startup or serialization is bounded.** Verifier
  initialization and PostgreSQL lock/statement waits own deadlines and cleanup;
  timeout is a stable refusal, never an indefinitely pending process.
- **Legacy package code never receives async services accidentally.** Contract 1
  remains SQLite/synchronous; PostgreSQL requires explicit v2 async package and
  action contracts.
- **Write portability includes predicates.** PostgreSQL business writes are
  serializable, with retries forbidden after external effects.
- **Logical identifiers are not physical identifiers.** One recorded renderer
  maps names within PostgreSQL byte limits and proves namespace uniqueness before
  DDL runs.
- **A secret-bearing file must prove its local secrecy before parsing.** Regular
  file, owner and permission checks fail closed; unsupported platforms do not
  silently assume an equivalent guarantee.
- **Conflict evidence is diagnostic, not business evidence.** Serialization
  losers emit one failed normalized trace and no audit, event or success span.
- **A retry is a new evidence attempt.** Events and trace steps from a rolled-
  back attempt are discarded; only the committed attempt can be promoted.

## Outcome and follow-up

The closeout baseline is ready for Spine v2 planning, and this branch contains
the executable work package. Implementation is intentionally not started.
Spine v3 jobs/outbox/scheduler; Spine v4 secrets/backups/observability; Truth
Contract v2 generated `productionPosture`; `commercial-quotes@1` deprecation;
real browser automation; DX6 observation of ADR-032 operations; remote package
install/update/uninstall/registry; Customer Data Operations v2; Interactions;
Billing; Marketing/Analytics; DX9; DX13; and a real Codex/Gemini comparative
benchmark remain separate follow-ups.

Private Cloud and the public-to-private repository migration remain blocked on
human creation/access for `accordo-platform`. This plan creates no private
repository and starts no Cloud C0 work. Vercel account/project scope remains a
separate operational follow-up even though the builds themselves are green.
