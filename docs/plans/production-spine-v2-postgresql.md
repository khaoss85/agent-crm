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
   Version every nested package execution seam before exposing async services:
   `packageContract: 2`, `actionContract: 2`, `operationContract: 2` and
   `capabilityContract: 2` require actions, operations and capability consumers
   to await every service/context/dependency operation. Contract 1 variants retain their
   synchronous SQLite semantics and is refused during PostgreSQL composition
   with `PACKAGE_ASYNC_CONTRACT_REQUIRED` before migration or provider setup;
   it is never handed Promise-shaped services. Migrate bundled packages
   explicitly and keep an unchanged legacy custom-package fixture green on
   SQLite and fail-closed on PostgreSQL. Package validation rejects any mixed
   graph (for example package/action v2 exposing capability/operation v1) and
   declared capability requirements select an explicit async-capable version
   before application startup. Clear the DX Gate: the failure prevented
   is a Promise used as a domain value; synchronous v1 cannot represent an async
   driver; v2 is the single portable contract; inspection publishes the version
   as evidence; and authors gain one unconditional `await` rule across adapters.
   Bundled packages ship explicit dual definitions during compatibility: their
   existing v1 synchronous package/action/operation/capability graph remains
   selected by `createAccordoApp()`/SQLite, while async composition selects v2.
   Shared pure policy/metadata may be reused, but a promise-returning v2 function
   never enters the synchronous registry. Run every bundled composition, starter
   and package conformance fixture through the sync factory after migration,
   alongside v2; retiring v1 is a separate deprecation.
3. Delete the compatibility path only after a repository guard proves no
   business consumer reaches `DatabaseSync`, `.raw.prepare()` or `.raw.exec()`.
4. Keep the provisioning-side tenant resolver separate from the application
   binding; the application handle still cannot name a second tenant.
5. Make cross-plane Spine writes explicitly recoverable rather than pretending
   two independent databases share an atomic transaction. In the same control-
   plane transaction as a membership/organization mutation, persist a bounded,
   immutable audit intent with a deterministic idempotency key and canonical
   destination tenant binding. Finalization claims only intents matching the
   current instance binding, re-verifies that tenant against the data-plane
   marker inside delivery, and refuses without marking delivery on mismatch.
   Two instances sharing one control plane must prove neither can claim, copy or
   complete the other's pending intent. Finalization
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
7. Migrate `serve` and MCP stdio composition onto the
   unconditional async factory when PostgreSQL is selected, while retaining the
   characterized synchronous SQLite path. Each entry point must await startup
   and migrations before accepting a request or writing a success response,
   propagate a stable bounded startup failure, and close the selected adapter on
   signal/error. Add end-to-end child-process tests for both adapters; calling
   `createAccordoAppAsync` directly is not sufficient evidence.
   Production startup migrations run only after the deployment verifier provider
   returns a bounded, verified workload/startup system identity with an explicit
   `schema:migrate` permission, claims fingerprint and reason. That identity is
   carried into immutable migration audit evidence together with adapter,
   migration names/checksums and the deployment idempotency root; it is never
   synthesized from config presence. Missing/refused startup attestation or
   permission makes startup fail before DDL. The provider contract and child-
   process fixtures cover valid attestation, missing permission, replay and audit
   exactness. The unauthenticated `crm db:migrate` command remains a stable
   PostgreSQL refusal; SQLite compatibility is unchanged.
   Verifier provider contract v2 returns two non-interchangeable operations:
   `verifyRequest(evidence)` for request identities and
   `attestControlStartup(challenge)` and `attestDataStartup(challenge)` for ordered workload identity. The runtime supplies
   single-use challenges bound to repository fingerprint, tenant, the relevant
   plane attestation, requested permission and migration-set fingerprint; the provider
   returns a bounded verified-system identity plus evidence fingerprint/expiry
   or refusal. Request evidence cannot satisfy startup attestation. Missing
   method, replay/staleness, wrong tenant/migration set and refused permission all
   fail before DDL in provider and child-process fixtures.
   PostgreSQL applies each transactional DDL unit, its name/checksum ledger row
   and immutable migration audit row in the same data-plane transaction. Audit
   carries the verified startup claims/reason and challenge/migration-set
   fingerprints, never credentials. A dialect operation that cannot participate
   is unsupported until an explicit durable pre-DDL intent/reconciliation
   contract exists. Fault injection before/after every DDL, ledger and audit
   write proves restart yields either none of the unit or schema+ledger+audit
   together exactly once.
   Control-plane bootstrap runs first, before any organization, lease, binding or
   audit-intent read. It uses the same verified startup attestation bound to the
   control-plane resource identity and control migration-set fingerprint, then
   acquires a PostgreSQL advisory bootstrap lock that exists independently of
   application tables. Inside one control-plane transaction it creates/evolves
   the control schema, writes its checksum ledger and inserts the immutable
   startup audit row (including actor/reason/resource/migration fingerprints).
   Concurrent starters serialize on that lock and revalidate after acquisition.
   Fault injection at every DDL/ledger/audit boundary proves all-or-none restart;
   only after this succeeds may data-plane attestation, lease or migration begin.
   Production MCP stdio remains static-context-only in this milestone: its transport has
   no per-request verifier evidence, and existing write tools use asserted local
   actors. Do not invent identity headers inside JSON-RPC. At production
   discovery allowlists only non-sensitive checked source context. Omit or
   refuse every tenant-data read (`crm_list_*`, trace/audit/debug), every prompt
   that can reveal runtime data, and every code/filesystem mutation including
   scaffolding even when it defaults dry-run. Legacy calls return one stable
   pre-service `MCP_PRODUCTION_SURFACE_UNAVAILABLE` refusal. Prove every current
   data-bearing or code-generating tool/resource/prompt is unreachable before
   service/workflow/filesystem access with zero audit/event/trace/source change.
   A future authenticated remote
   MCP is a separate DX/identity contract and must clear the DX Gate; this plan
   does not claim it.
8. Define one shared, versioned deployment-storage configuration loader used by
   the factory, CLI and MCP rather than inventing flags independently. The
   candidate contract is a path to a permission-restricted JSON document with a
   closed `{contract, adapter, connection, controlPlane, spine,
   identityVerifier}` envelope. One checked repository-contained verifier
   provider owns request verification and v2 startup attestation; no additional
   identity-provider namespace is added. First `attestControlStartup` receives
   only the opaque control challenge and proves workload plus control resource;
   control bootstrap then completes. Next `attestDataStartup` is bound to the
   first attestation fingerprint and receives the opaque data challenge, proving
   the data resource before any data-plane DDL/lease. Either phase can refuse and
   neither can be replayed/substituted for the other. Startup rejects identical ids and endpoint
   aliases; schema names, URLs and credentials are not identities. Fixtures cover
   malformed/escaping/hanging providers, missing attestations, identical URLs,
   aliases and genuinely separate databases.
   `connection` is
   consumed only by the adapter and never returned, while `spine` resolves the
   canonical tenant through ADR-038's existing binding. Existing `--db` remains
   SQLite-only. Supplying both surfaces, an unknown adapter/key, inline
   credential CLI argument, missing/unreadable config, or PostgreSQL without a
   resolved spine/tenant binding fails before a connection is opened. Explicit
   CLI config takes precedence over a single documented environment path; there
   is no precedence between PostgreSQL and `--db` because that combination is a
   refusal. MCP uses the same loader and rules.
   PostgreSQL production connections require authenticated TLS as part of this
   closed contract: encryption on, certificate-chain verification against an
   explicit deployment trust source, and hostname verification for the selected
   endpoint. Plaintext, `sslmode=disable|allow|prefer`, verification-disabled
   settings, embedded trust material in public output, downgrade, expired or
   untrusted certificates and hostname mismatch all fail before tenant claim or
   migration. No permissive production default exists; a loopback-only test
   exception is explicit test harness state and cannot enter a deployment
   document. Integration fixtures prove trusted-CA success and every refusal
   against real TLS endpoints, with credentials absent from diagnostics.
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
   receives only its bounded provider configuration and returns the v2
   `{verifyRequest, attestControlStartup, attestDataStartup}` operations defined above; it reads credentials through the deployment environment
   or secret manager, never through CLI arguments or public results. Production
   mode requires this reference; local mode refuses a configured production
   verifier rather than silently changing trust. Factory, `serve`, MCP and any
   HTTP entry point use the same resolver. Add fixture providers for success,
   malformed export, throw/reject, escaping path and credential-sentinel tests,
   and prove no listener/database handle exists before verifier resolution. Run
   the entire resolution pipeline—realpath checks, dynamic module evaluation
   and provider factory initialization—under one documented bounded startup deadline with
   an abort signal where the provider supports it; always clear the timer,
   abandon/ignore late settlement and return a stable verifier-timeout code.
   A hanging fixture must make each child process exit nonzero within the bound
   with no open listener/database and no credential in diagnostics. Include a
   provider whose top-level `await` never settles, not only a hanging factory.

Exit: SQLite passes the full suite through the portable contract, and the raw
SQLite driver is private to the SQLite adapter. Both the legacy synchronous
SQLite composition and the new async SQLite composition pass their respective
characterization suites.

#### Production binding and idempotency details

- The closed deployment envelope also carries a `controlPlane` connection. A
  production PostgreSQL deployment requires one genuinely shared PostgreSQL
  control plane under the same authenticated-TLS and secret rules, with its own
  adapter-owned schema. Local SQLite control planes are dev/compatibility only.
  Organization/membership state, provisioning leases, tenant→binding UUIDs and
  pending audit intents live in that shared authority. Two instances with
  isolated filesystems must converge on it; production startup with independent
  local control planes refuses.
- Every PostgreSQL write receives a caller-known idempotency key before work:
  HTTP uses canonical `Idempotency-Key`, the SDK uses a closed
  `{idempotencyKey}` option that forwards it, and direct service/action/workflow
  calls use a versioned operation context. Keys use bounded canonical ASCII and
  are required on PostgreSQL; response, error and reconciliation envelopes echo
  them. SQLite legacy calls remain compatible when omitted. This public contract
  must clear the DX Gate: it prevents unknowable ambiguous retries, replaces no
  existing usable primitive, is one transport concept across all surfaces, and
  exposes machine-readable reconciliation evidence.
- Verified provider webhooks are the bounded exception to caller header
  transport. Only after signature/provider verification succeeds, the webhook
  adapter derives the root outcome identity from the closed provider name,
  canonical event id and payload fingerprint already used for divergent-replay
  defense. Unverified bytes never choose a key. Lost-COMMIT, identical delivery
  and same-event/different-payload fixtures traverse the real signature webhook
  route and converge/refuse under the same outcome contract.
- An outcome durably records compare-and-set promotion state for its trace and
  event intents. Sequential or concurrent identical-key reconciliation returns
  the stored response after one live promotion; it cannot dispatch the intents
  again. The separately stated crash-during-external-dispatch limitation remains.
  Tests lose responses through HTTP, SDK, action, workflow and direct service,
  then replay sequentially/concurrently and assert exactly one row, audit,
  completed trace and live event promotion.
- Keys carry a validated issuance bucket inside their canonical format. The
  contract publishes a bounded replay/reconciliation window longer than every
  supported client retry/offline recovery interval. During that window a full
  outcome may compact to a minimal immutable tombstone containing scope/request/
  terminal fingerprints, promotion state and the normalized canonical response
  (or a stable immutable result locator plus the exact renderer needed to rebuild
  that response), so matching replay returns the same contract-shaped result and
  remains
  idempotent and divergent replay still refuses. After the window, the key is
  structurally expired and is always refused before mutation; only then may its
  tombstone be deleted/archived. Reissuing the same random portion with a newer
  bucket is a different key and cannot address the old outcome. Boundary tests
  cover byte-equivalent response replay before compaction, after tombstoning, at
  expiry and after deletion.
  On first acceptance the server compares the bucket to its injected UTC clock:
  no older than the replay window plus a documented client-skew allowance and no
  farther in the future than that allowance. Both are contract constants;
  out-of-window keys refuse before mutation and allocate no outcome. Tests hit
  both exact boundaries and one unit beyond with the injected clock.
- M4 races one tenant against two databases from instances with isolated local
  filesystems and the shared control plane; one lease/binding wins. Starting the
  same topology with independent/local control planes is a production refusal.
- Clones are fenced, not trusted because they copied the same marker. There is no
  automatic writer transfer on lease expiry: expiry makes the tenant unavailable.
  Every outer write registers an in-flight intent under the current shared
  control-plane lease before opening its data transaction and closes it only
  after commit/rollback is known. Normal renewal cannot change generation while
  an intent exists. Restore/rebind is offline: stop writers, revoke the old data-
  plane credential/network route, verify the old server has no application
  sessions or prepared/in-flight transactions, drain/resolve every intent, then
  increment generation and update only the selected clone marker. Transfer
  blocks/refuses if a transaction is paused between lease proof and data commit;
  it never times out into a second writer. M4 pauses at exactly that boundary,
  proves handoff cannot advance, drains the commit, and then promotes the clone;
  the revoked original cannot accept another connection or write. This fail-
  closed offline protocol is the boundary of per-tenant Spine v2; transparent
  automatic failover would require a stronger coordinator and is not claimed.
  Before either original or clone receives a write handle, a deployment-supplied
  data-plane identity provider must attest a non-clonable external resource
  identity (for example a platform-signed database resource id) and binding
  generation; the shared control plane leases that attested identity, not the
  marker copied inside the database. The provider contract is versioned,
  credential-free in outputs and fail-closed when the deployment cannot prove an
  external identity. A physical/logical clone with a different attested resource
  id therefore conflicts before writes; two endpoints claiming the same
  attestation are probed concurrently and refused as ambiguous. Portable
  deployments without such an authority may run one process only and cannot
  claim clone/failover safety. M4 uses a fixture identity authority to start the
  original and clone concurrently and proves one pre-write lease winner.

##### Admin submission keys

- The Admin creates one root key at the user-submission boundary, before calling
  either direct `api()` or generated-module `moduleClient.request()`. The form or
  action controller—not the low-level request helper—owns it. A deliberate click,
  approval decision, stage change, demo request or generated-resource mutation
  creates a new key; transport code never invents a replacement.
- The controller retains that key with the immutable normalized request
  fingerprint while the submission is pending or its outcome is unknown. A
  retry caused by timeout, lost response or an explicit “check/retry” control
  reuses the key and the exact request. It is discarded only after a proved
  terminal response or cancellation proved to precede dispatch. Browser reload
  recovery uses the durable mechanism below.
- The first submit disables the control synchronously. A double-click or Enter+
  click joins the same pending promise and therefore sends at most the same key/
  fingerprint; it never becomes a second deliberate submission. After terminal
  completion, a new deliberate submit receives a new key. Reusing a retained key
  with changed fields is refused client-side and remains a server-side divergent-
  replay refusal.
- Unknown submissions are never discarded on page teardown. The Admin persists
  their key, issued-at value, route/scope and request fingerprint in origin-bound
  durable browser storage (no credentials or response/domain payload), restores
  them across tab/browser restart, and reconciles them before enabling an
  equivalent new submission. The server exposes an authenticated, tenant-bound
  pending-outcome lookup for the verified user so a cleared/replaced browser can
  rediscover unresolved submission metadata without learning another subject's
  keys. Only a proved committed/rolled-back/cancelled-before-dispatch terminal
  outcome removes the browser entry only after client acknowledgement. Server
  terminal submission metadata remains discoverable by tenant, verified subject,
  operation scope and request fingerprint for the full replay window—even when
  the key itself was lost with browser storage—and is compacted only under the
  expiry/tombstone rule. A replacement browser first queries this scope and
  acknowledges/reconciles the retained terminal outcome before enabling a new
  equivalent submission.
- Both Admin transports accept a required submission context and forward the
  same canonical `Idempotency-Key`; raw mutation calls without that context fail
  before `fetch`. Real-Chromium PostgreSQL coverage drives an Opportunity stage
  change, approval decision, generated-module create/update, lost-response
  reconciliation, double submission and changed-payload replay. It asserts exact
  domain/audit/event/final-trace counts and one key per logical submission.

##### Root and child keys for fan-out

- A logical request owns one caller-known root key and one parent outcome. Every
  nested write derives a child key from the root context, a closed semantic
  operation scope and a stable child identity. The derivation is a versioned
  runtime contract; its cryptographic encoding is an implementation detail until
  two consumers shape it, but it must be deterministic, domain-separated and
  collision-tested. A child outcome stores its parent/root fingerprint so it
  cannot be replayed under another request.
- Stable child identity is a semantic id supplied by the workflow/operation
  plan—record id, declared step id plus stable business key, or a checked stable
  ordinal from an immutable canonical input array. It is never object/map/set
  iteration order, database return order, clock, randomness or retry count. Two
  same-type siblings therefore have distinct declared identities while a full
  replay derives byte-identical child keys.
- Dynamic fan-out first materializes and fingerprints a canonical child plan,
  sorts it by its unique semantic identity, refuses duplicates, and only then
  executes. Adding/removing/reordering children under the same root changes the
  parent request fingerprint and is a divergent replay, not a partial extension.
- M4 fixtures cover `/api/demo/seed` (Company, Contact, two Opportunity
  siblings), lost response plus full replay, an unknown commit on one child, a
  dynamic workflow fan-out and changed fan-out under the same root. Every replay
  converges to exactly one parent result and one set of domain rows, audits,
  events and final traces; sibling writes never share a key.
  The production HTTP demo routes themselves are stable refusals because their
  shipped implementation replaces the verified requester with hard-coded demo
  actors. The fan-out fixture invokes the internal operation only with an
  explicit verified operation context propagated unchanged to every child
  outcome/audit; no production route may discard or substitute that subject.

##### Application CLI PostgreSQL matrix

The implementation reads the canonical `APP_COMMANDS` export/authority rather
than duplicating an unchecked list. PostgreSQL selection is always explicit and
never falls back to `--db`/SQLite.

| Command | PostgreSQL classification | Required behavior |
|---|---|---|
| `serve` | `READ_ONLY_SUPPORTED` at startup; hosted HTTP mutations use their transport keys | Async composition, await readiness, then listen; bounded signal/error close. |
| `db:migrate` | `STABLE_REFUSAL_ON_POSTGRESQL` | Refuse `CLI_VERIFIED_OPERATOR_REQUIRED`; migration uses the application startup authority after a deployment adapter supplies verified system/operator context, not this unauthenticated CLI. |
| `seed` | `STABLE_REFUSAL_ON_POSTGRESQL` | Refuse `CLI_VERIFIED_OPERATOR_REQUIRED` before composition/write; current CLI has no verified operator transport and hard-coded actors are not identity. |
| `demo` | `STABLE_REFUSAL_ON_POSTGRESQL` | Refuse `CLI_VERIFIED_OPERATOR_REQUIRED`; demonstrations cannot bypass production authorization. |
| `doctor` | `STABLE_REFUSAL_ON_POSTGRESQL` | Refuse `CLI_VERIFIED_OPERATOR_REQUIRED`; current doctor reads tenant record, workflow and audit counts. Source-only `project doctor` remains `NOT_APPLICATION_BOUND`. |
| `workflow:list` | `READ_ONLY_SUPPORTED` | Async composition, deterministic result and clean close. |
| `trace:list` | `STABLE_REFUSAL_ON_POSTGRESQL` | Refuse `CLI_VERIFIED_OPERATOR_REQUIRED`; local config access is not authorization to tenant traces. |

Non-application CLI commands remain `NOT_APPLICATION_BOUND` and do not load the
deployment-storage configuration. No current `APP_COMMANDS` entry is silently
unsupported; if implementation cannot satisfy one, it must add a documented
`STABLE_REFUSAL_ON_POSTGRESQL` row and regression before code lands rather than
falling back. Child-process coverage enumerates the live canonical set and fails
if an unclassified command appears. It runs every command on SQLite, every
supported command on PostgreSQL, every declared refusal, missing/malformed key
cases, lost-response replay for mutators, no-SQLite-fallback sentinels,
credential-output scans and pool/client/timer shutdown checks.

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
   stable unavailable/timeout code. Wrap every query/execute on an established
   client in its own client-side deadline as well: a mid-query network stall
   destroys (never returns) that client, releases pool bookkeeping/timers and
   returns a stable unknown-or-timeout result even when the server cannot deliver
   its statement cancellation. A subsequent acquisition must prove pool recovery.
   Treat connection loss during `COMMIT` as `COMMIT_OUTCOME_UNKNOWN`, never a
   normal rollback and never an automatic callback retry. Every PostgreSQL write
   entry point carries a caller-visible idempotency key (or a runtime-generated
   key returned before execution where the protocol permits it); the same
   transaction stores a unique bounded outcome record with deterministic record
   IDs, normalized response, event intents and deterministic successful-trace
   intent/run metadata. The unique key is scoped to canonical tenant, verified
   subject fingerprint, operation/action, target and contract version and binds
   a canonical fingerprint of the complete normalized request. Reusing it with
   any divergent scope or bytes fails closed and reveals neither prior response
   nor subject. After reconnect, reconciliation
   looks up that key: a committed outcome returns its canonical response and
   promotes its events once in the live recovery path; absence authorizes one
   retry with the same IDs/key; inability to prove either remains unknown and
   refuses further mutation. This is bounded transaction recovery, not a claim
   Raw caller keys are tenant-local inputs: the runtime namespaces/digests them
   with the canonical tenant before data-plane lookup. Reuse under another tenant
   is permitted as an independent outcome and reveals nothing about the first;
   changed subject/operation/target/version/payload within the same tenant is the
   divergent replay refusal. No global cross-tenant key registry is introduced.
   of a general durable outbox: a process death during external event dispatch
   can still omit or duplicate event delivery until Spine v3, and that limitation is
   published. Clear the DX Gate for the idempotency input: it prevents a user
   retry from duplicating an ambiguously committed write; no existing request
   identity survives reconnect; one key applies uniformly to API/SDK/action
   writes; response/error contracts expose the key and stable status as evidence;
   and retry becomes one reconciliation call rather than manual record hunting.
   `COMMIT_OUTCOME_UNKNOWN` is not recorded as an ordinary failed action trace.
   The runtime writes one deterministic pending trace/run identity (or defers the
   terminal insert) and reconciliation finalizes that same primary-keyed run to
   completed or failed with one span set; it never inserts a second contradictory
   run. Pending is a recovery state, not success evidence, and remains visible
   until the outcome is proved.
   External-operation phases use a stricter v2 contract. Intent and finalize each
   have their own durable phase key/outcome; the provider call receives a stable
   provider idempotency key and the provider must implement read-only reconcile
   by that key. PostgreSQL composition refuses legacy `externalOperation: 1` or
   any provider without both idempotency and reconciliation. After an unknown
   intent commit, inspect the intent ledger before any provider call. After the
   provider returns but finalize commit is unknown/absent, reconcile the provider
   receipt and compare its provider, tenant/account scope, operation kind,
   idempotency key, canonical request fingerprint and remote-object identity to
   the immutable local intent. Missing/mismatched fields refuse as
   `PROVIDER_RECEIPT_MISMATCH` before finalize, with no hostile value echoed.
   Only an exact receipt resumes finalize—never replay the provider. A provider whose
   state cannot be proved leaves the operation pending for explicit recovery.
   This versioned external-operation/provider contract must clear the DX Gate and
   is bounded to the existing three-phase runtime, not a general job system.
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
   Persist the inverse authority in the shared control plane: each data plane
   owns a random immutable public binding UUID (never a locator), and first claim
   records `{canonicalTenant, bindingUuid}` under an exclusive provisioning lease
   before exposing an application handle. Startup requires marker and mapping to
   agree. Two databases racing for one tenant yield one winner; normal startup
   never overwrites the mapping. The verified startup identity flows into the
   first-claim transaction and immutable audit with tenant, binding UUID, both
   resource ids, generation and reason. Compensating cleanup is a separately
   audited outcome tied to the same claim/idempotency identity; it cannot silently
   delete the mapping. Fault tests assert exact claim/cleanup audit counts.
   Restore/rebind is an explicit offline human
   operation with expected old/new UUIDs, exclusive tenant downtime, a backup/
   restore receipt and immutable audit. Specify compensating cleanup when either
   side of first claim fails; do not pretend cross-database atomicity.
   Introduce a portable `TENANT_BINDING_CONTRACT = 2` rather than overloading
   v1's filesystem shape. V2 publishes only `{contract, adapter, tenantBound,
   controlPlaneAdapter, dataPlaneIsolation}` with closed vocabularies and no
   path/connection locator; PostgreSQL uses it, and SQLite may implement it on
   the async path. The synchronous SQLite factory and exported v1 binding retain
   `root`, `dataPlanePath` and `controlPlanePath` byte-for-byte for compatibility.
   `spine.describe()`, application schema/inspection and Repository Truth derive
   enforcement from the v2 discriminated descriptor, never from the presence of
   a path. Contract-shape, v1 compatibility and false filesystem-claim tests are
   required, and the horizontal binding contract is recorded in the Legacy
   Alignment Matrix.
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
   Race the same tenant against two distinct empty PostgreSQL databases and prove
   the control-plane UUID mapping permits exactly one binding; the loser cannot
   migrate or accept writes. Exercise restore/rebind plus wrong-expected-UUID,
   concurrent-startup and partial-first-claim failure/cleanup cases.
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
   rolls back, writes no audit/event/success span, and retains exactly one failed
   diagnostic trace containing only the normalized timeout/conflict; then release the holder
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
   Drop the client connection after PostgreSQL applies `COMMIT` but before its
   acknowledgement. Reconcile with the same idempotency key and prove exactly
   one domain record, audit row and successful trace; the live recovery dispatches
   one event, while the documented process-death dispatch limitation remains
   explicit. Repeat with a pre-commit drop (ledger absent) and prove the same
   deterministic IDs/key authorize one safe retry, never a second record.
   Repeat reconciliation in a fresh process and reconstruct exactly one
   successful trace from the committed trace intent before returning success.
   Replay the same key with a changed verified subject, operation, target and
   payload independently inside one tenant; each receives the bounded divergent-
   replay refusal. Reuse the raw key in another tenant and prove an independent
   namespaced outcome with no read/suppression/disclosure across planes. Black-hole
   an established client mid-query and prove the per-operation deadline destroys
   it, releases the slot and allows a fresh pooled query to succeed.
   At the intent and finalize COMMIT boundaries of a real three-phase external
   operation, inject both pre-commit and post-commit connection loss. Assert the
   provider is called exactly once with one idempotency key, reconciliation reads
   its receipt, only finalize is resumed, and the operation converges without a
   second side effect. Return another tenant/operation/object receipt for the
   correct lookup key and prove intent matching refuses before finalize without
   provider replay. An unprovable provider stays pending. For ordinary unknown
   commit recovery, assert exactly one run id exists throughout: pending becomes
   the final completed/failed trace with no contradictory failure row.
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
- authoritative control-plane tenant→binding UUID prevents one tenant from
  claiming two data planes; restore/rebind is explicit, offline and audited;
- adapter-owned schema qualification: divergent or changed `search_path` values
  cannot create a second marker, hide a ledger or redirect a domain query;
- recoverable cross-plane Spine audit: every committed authorization mutation
  has atomic local evidence and converges idempotently to exactly one tenant
  audit row;
- pending audit intents are tenant-bound; another instance sharing the control
  plane cannot claim or deliver them into its data plane;
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
- package/action/operation/capability contract v2 makes async service semantics
  explicit across both adapters; mixed or legacy-v1 graphs remain synchronous
  on SQLite and refuse before PostgreSQL startup;
- every bundled package retains an explicit v1 synchronous definition for the
  legacy factory while async composition selects its v2 graph;
- long or multibyte logical identifiers map deterministically to collision-free
  PostgreSQL physical names or fail before bootstrap;
- the SQLite characterization unchanged from M0;
- the synchronous SQLite in-process API and starter remain valid, while the
  async factory has one unconditional startup/service contract on both adapters;
- `npm start`/`serve` and MCP stdio boot PostgreSQL through the
  awaited async composition path, refuse before serving on failed startup, and
  retain their characterized SQLite behavior;
- one closed deployment-storage config selects adapter plus spine binding
  identically for factory/CLI/MCP, is mutually exclusive with SQLite `--db`, and
  PostgreSQL always refuses without a resolved canonical tenant;
- production executables resolve one checked, repository-contained verifier
  provider contract before database/listener startup; malformed or escaping
  providers fail closed without leaking their configuration;
- production MCP stdio exposes only static non-sensitive checked context until
  a per-request verified-identity transport exists; tenant-data, trace/debug and
  code/filesystem surfaces refuse before their authorities;
- tenant binding contract v2 describes SQLite/PostgreSQL isolation without a
  locator, while synchronous SQLite retains its v1 filesystem shape;
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
- ambiguous commit acknowledgement is reconciled by a unique idempotency/outcome
  record and deterministic IDs; it is never mislabeled rollback or blindly retried;
- outcome keys bind tenant, verified subject, operation, target, version and
  canonical request bytes; divergent replay cannot observe or suppress history;
- committed trace intent lets a fresh-process reconciliation reconstruct exactly
  one successful trace before reporting an ambiguously acknowledged success;
- unknown commits retain one pending run identity that reconciliation finalizes;
  no contradictory failed/completed trace pair is inserted;
- external-operation v2 reconciles durable intent/finalize phases and an
  idempotent provider receipt; it never replays a provider after unknown finalize;
- a serialization loser retains one normalized failed trace for diagnosis while
  writing no audit/event/success evidence;
- connection establishment and pool acquisition own client-side deadlines and
  release their timers, sockets and slots on bounded refusal;
- every established-client query/execute owns a client-side deadline and destroys
  a black-holed client so the pool can recover;
- production PostgreSQL requires encrypted, certificate- and hostname-verified
  TLS; plaintext, downgrade and unverifiable endpoints fail before storage use;
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
- 2026-08-23: review closed the remaining executable/binding edges: production
  MCP writes fail before services instead of using asserted actors, tenant
  binding v2 is portable and discriminated, and the verifier deadline covers
  module evaluation including non-settling top-level `await`.
- 2026-08-23: fresh review narrowed production stdio to static non-sensitive
  context, tenant-bound pending-audit reconciliation, and one retained failed
  diagnostic trace after lock timeout.
- 2026-08-23: exact-head review added a fail-closed authenticated-TLS policy for
  PostgreSQL, including real trusted-CA, plaintext, downgrade, chain and hostname
  fixtures before tenant claim.
- 2026-08-23: review extended async versioning through operations/capabilities
  and added bounded idempotency/outcome reconciliation for lost COMMIT
  acknowledgements without claiming the still-deferred general durable outbox.
- 2026-08-23: the next review bound idempotency outcomes to request/identity
  fingerprints, persisted trace intent for fresh-process recovery, and added a
  client-side deadline for mid-query network stalls.
- 2026-08-23: review separated external-operation phase recovery from ordinary
  transaction replay and required one pending trace identity through unknown-
  commit reconciliation, preventing duplicate providers and contradictory runs.
- 2026-08-23: review closed inverse tenant split-brain with a control-plane
  tenant→binding UUID and required dual v1/v2 bundled definitions so synchronous
  SQLite composition remains executable compatibility evidence.

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
  remains SQLite/synchronous; PostgreSQL requires an all-v2 async package,
  action, operation and capability graph.
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
- **Unknown commit is a third state.** A durable idempotency/outcome record and
  deterministic IDs decide reconciliation; neither rollback nor blind replay is
  inferred from a lost acknowledgement.
- **Unknown commit owns one pending trace.** Reconciliation finalizes that run;
  it never appends a contradictory terminal trace.
- **An external provider is never a transaction callback retry.** Phase ledgers,
  provider idempotency and read-only reconciliation resume finalize without
  repeating an irreversible call; unsupported v1 providers refuse PostgreSQL.
- **Idempotency is request-bound, not key-truthiness.** Tenant, verified subject,
  operation, target, version and canonical payload must all match; committed
  trace intent survives the process that lost the acknowledgement.
- **Production stdio is not an authentication transport.** It stays static-
  context-only; tenant data, trace/debug and source mutation all refuse. Remote
  authenticated MCP requires a separate verified-request contract.
- **Binding evidence is discriminated, not inferred from paths.** V2 describes
  the adapter/isolation without locators; legacy synchronous SQLite keeps v1.
- **Tenant and data plane bind in both directions.** The database marker blocks
  two tenants per plane; the control-plane UUID mapping blocks two planes per
  tenant. Rebinding is offline, expected-value checked and audited.
- **Bundled compatibility is executable.** V1 synchronous definitions remain
  selected by `createAccordoApp()`; v2 promises never leak through that registry.
- **Production database transport is authenticated.** Encryption without chain
  and hostname verification is not sufficient and cannot be configured as a
  permissive fallback.

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
