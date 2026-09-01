# Architectural decisions

## ADR-001 — Standard-library-first proof of concept

**Status:** accepted

The first vertical slice uses Node.js built-ins, including `node:http`, `node:test` and `node:sqlite`. This keeps setup immediate for Codex/Claude and makes the framework mechanics visible. A production adapter may later replace SQLite without changing module service contracts.

### ADR-001 addendum — Production Spine v2 M3B pins `pg@8.23.0`

**Status:** accepted (implementation pin). The protocol-versus-driver rationale
for adopting a production PostgreSQL client is M3A's DECISIONS.md prose.

This is the first third-party runtime dependency. The pin is exact `8.23.0`,
with no `pg-native` and no floating range. The import is a static
`import pg from 'pg'` inside `packages/core/src/postgresql-storage.js` and is
never wrapped in `try/catch`. SQLite remains Node `node:sqlite` and does not
load `pg`. There is no ORM, no query builder and no SQLite-to-PostgreSQL
translator.

Limitation: applications that select PostgreSQL carry this driver.
`createAccordoAppAsync()` composes a dedicated-database PostgreSQL application;
`createAccordoApp()` stays SQLite-only. This is not shared-database tenancy and
not a production-readiness claim.
<!-- truth: spine.postgresql.implemented=implemented -->

## ADR-002 — Services and workflows own mutations

**Status:** accepted

API, Admin, CLI and MCP may only mutate CRM state through module services or workflows. This makes validation, trace, audit and approval consistent across every interface.

## ADR-003 — Human approval is deterministic policy

**Status:** accepted

Moving a renewal worth at least €50,000 to Proposal creates an approval request and moves it to Approval Pending. An AI model may explain or recommend, but it does not override this policy.

## ADR-004 — MCP scaffolding defaults to dry-run

**Status:** accepted

The module scaffolding tool returns a file plan unless the caller explicitly passes `apply: true`. This reduces accidental repository writes from an AI client.

## ADR-005 — Compatible MCP surface

**Status:** accepted

The stdio server supports the established `initialize` lifecycle and the newer `server/discover` request, with tools/resources/prompts shared across both surfaces.

## ADR-006 — Module manifests generate migrations, not runtime behavior

**Status:** accepted

A declarative module manifest (`docs/MODULE_MANIFEST.md`) is the single source for a new module's table DDL. `validateModuleManifest` aggregates every problem into one precise error, and `generateModuleMigration` is a pure function: the same manifest always produces byte-identical SQL, with all conventions (automatic `id`/`created_at`/`updated_at`, snake_case columns, naive plural table names) documented rather than implicit. Manifests do not become a low-code runtime: services, policies and workflows remain handwritten explicit code, and the CLI surface is dry-run by default — writing requires `--out` and overwriting requires `--force`, consistent with ADR-004.

## ADR-007 — Generated modules register through a checked-in registry and name-keyed migrations

**Status:** accepted

`module:create --apply` generates complete modules and registers them through `packages/modules/generated/index.js`, a checked-in registry with static imports that is regenerated from the `module.manifest.json` copies found under `packages/modules/*/`, sorted by module name. `createAgentCrmApp` stays synchronous and reviewable — no filesystem discovery, dynamic loading or runtime eval. Generated migrations are tracked by **name plus a SHA-256 checksum of their SQL** in a dedicated `module_migrations` table rather than extending the integer-versioned core `MIGRATIONS`: adding modules in any order never renumbers migrations that already ran, duplicate identities are rejected, and an applied migration whose SQL later changes fails loudly instead of being silently treated as applied — applied migrations are immutable. Apply is atomic (staged temp files, full rollback on failure) and never overwrites existing files; reference fields are rejected by the factory until cross-module validation can be generated with the same integrity as handwritten modules.

## ADR-008 — Generated modules are served through one uniform resource contract

**Status:** accepted

Generated modules are exposed over HTTP through a single reviewed route family — `GET /api/modules/:module`, `GET|POST /api/modules/:module/records`, `GET|PATCH /api/modules/:module/records/:id` — and through `client.module(name)` in the SDK, instead of generating per-module route and SDK files that would duplicate and drift. The exposure boundary is static and explicit: only modules whose checked-in definition declares `kind: 'generated'` with an explicit `capabilities` list are served; handwritten core modules keep their dedicated endpoints and are never exposed generically. The adapter calls only the four declared operations with `{actor}` — no method introspection, no eval, no dynamic imports, no direct SQLite access — so validation, transactions, audit and domain events stay in the generated service. The generic surface validates `limit` strictly (400 on anything but an integer within the service maximum). The HTTP server remains a local development surface until authentication, tenancy and roles exist.

Exposure is decided by a single shared validator (`packages/core/src/generated-module-contract.js`), applied both at startup (fail closed: a corrupted registry entry stops the app) and per request (fail closed: a non-conforming definition is 404). It checks name shape, exact `kind`, `manifestVersion`, that every declared capability maps to an actual service function, and field-metadata shape; the `ModuleRegistry` is `Map`-backed, so lookups can never resolve `__proto__`/`constructor` to inherited properties. This is a framework contract against accidental, stale or hand-edited entries — **not** a sandbox against malicious source-code changes, which are outside the threat model since repository code is trusted and executed. The public contract is versioned: `/api/schema` returns `generatedResourceContract: 1`. Generated source embeds all manifest-controlled strings via `JSON.stringify`, so hostile descriptions or enum values cannot inject code. The canonical `limit` syntax on this surface is a single base-10 integer in [1, 500]; the generated service remains the final validation boundary when called outside HTTP.

### ADR-008 addendum 2 — a collection read may be narrowed on the server, by an index-backed equality filter

**Status:** accepted, from the pre-merge review of PR #70 (CHROMIUM-70 check 26 /
REVIEW-70). **This changes the shared HTTP envelope for every generated module**
and is recorded here rather than slipped in under a package milestone.

**What went wrong.** `GET /api/modules/:module/records` accepted `limit` and
nothing else. A client that needed one parent's rows therefore had to ask for the
newest N rows of the **whole table** and filter them itself. The real-browser
matrix found what that costs: in a project with 132 activity rows, a work task
whose two activity rows were the two oldest rendered **"Nothing recorded yet."** —
directly above a notice reading *"Showing at most 100 entries. A display bound of
this screen, never a bound on what exists."* Both statements were false at once,
and the second is the dangerous kind of false, because it reads as a disclosure
of exactly the thing it is getting wrong. The stubbed DOM suite could not catch
it: its fixture was smaller than the bound.

**Decision.** The collection read gains `filter.<field>=<value>`, and the grammar
is deliberately tiny:

- **Index-backed fields only.** A module publishes `filterableFields` — its
  indexed and unique fields plus `id` — in its metadata and at
  `GET /api/modules/:module`. Nothing else is filterable, so a routed filter can
  never become a table scan.
- **Equality on one scalar**, at most 200 characters, never repeated, at most
  four filters combined. There is no `IN`, no range, no `OR`, no full-text or
  substring match, no join across modules, no ordering control and no offset.
  This narrows a page; it is not a query language, and making it one would be a
  different decision. Accepted on exactly those terms and no wider: the human
  decision approving this addendum named range, `OR`, full text, join and
  arbitrary sort as explicitly **not** authorised by it.
- **The page is still a page.** `limit` keeps its 1–500 bound and its
  `created_at DESC, id` ordering. A filtered read is still a *display* read.
- **Refusal over a silent wrong answer.** Every violation is a `400`. A module
  generated before this addendum publishes no `filterableFields`, and a filter
  against it is refused rather than answered **unfiltered** — which would be the
  same false-completeness bug one layer down.
- **`listWhere` stays in-process and unrouted**, as
  `packages/cli/src/module-factory.js` has always said. It is unbounded and
  complete, and a correctness decision must still never be made from an HTTP
  page. That separation is the reason this addendum adds a filter to `list`
  rather than routing `listWhere`.

**Consequences.** `generatedResourceContract` stays `1`: the parameter and the
`filterableFields` metadata key are both additive, an older client never sends a
filter, and an older Admin ignores the new key. The SDK and the MCP surface are
**not** changed by this addendum — they keep the unfiltered collection read, and
extending them is a separate decision. A project holding modules generated before
this change keeps working unchanged; it gains filtering only when those modules
are regenerated with `accordo module create --apply`.

## ADR-009 — Generated modules render through one schema-driven Admin with an override seam

**Status:** accepted

Generated modules appear in the existing zero-build Admin through a single generic, schema-driven renderer rather than per-module generated page files (which would duplicate and drift). Navigation and views are built from `GET /api/schema` (`generatedModules`), gated on `generatedResourceContract === 1`; an unsupported future contract degrades gracefully and never breaks the dashboard. All schema metadata and record values are inserted with DOM APIs (`textContent`/`setAttribute`/`.value`), never `innerHTML`, so hostile manifest or record strings are inert text — the one reliable XSS defense given untrusted input. UI actions appear only for capabilities a module declares; handwritten core modules keep their dedicated dashboard and are never exposed through the generated-module screen. The renderer is small, readable vanilla JS the developer owns, with a documented (currently empty) override seam for future per-module customization — no new frontend framework, no build step, no no-code runtime. Admin mutations carry the framework's human identity, actor type `user` id `admin-ui` (there is no separate `human` type; the approval workflow requires `actor.type === 'user'`) — a declared audit identity, not authentication. The Admin remains local-development-only until authentication, tenancy and RBAC exist.

## ADR-010 — Reference fields resolve through an application-level resolver

**Status:** accepted

Generated-to-generated many-to-one references (Milestone 5) are validated at runtime through a small application-level reference resolver (`packages/core/src/reference-resolver.js`) that maps a reference field's target **table** to the installed generated module in the registry and validates via that module's `service.get` — never a direct cross-module SQL query and never a static import between generated modules. The resolver is built per application instance and resolves lazily at request time, so a module may reference a peer registered later, itself, or in a cycle, with no import-ordering problem and no global mutable state. Generated modules receive it as a `references` dependency; a bad target raises a field-tied `ValidationError` before the mutation savepoint, so no write, audit or event occurs. The SQLite foreign key (from Milestone 1 generation, `ON DELETE RESTRICT`, no cascade) is retained as defense in depth. The reference manifest syntax is unchanged from Milestone 1 (`references` = target table); the framework derives the target module name from installed-module metadata. Generated-to-core references are rejected this milestone (core tables are never treated as generated targets); an explicit adapter is the future extension point. **Self-reference and cycle semantics (precise):** an *optional* self-reference is supported (the first record leaves it null, then may point at any existing record including itself); a *required* self-reference is **rejected at plan time** because its first record is unseedable without nested writes (out of scope). Cross-module cycles are **not constructible** through the CLI — a reference requires its target module to be installed first, so a mutual A↔B cycle is a chicken-and-egg that the framework (which does not alter an existing module's schema) cannot build; the resolver would tolerate such a graph if present, but the framework does not claim cycle support it cannot construct. The resolver only converts a genuine `NOT_FOUND` from the target's `get` into a missing-target validation error; any other target-service failure propagates untouched, so a future permission/unexpected error is never masked as "missing target". Reference field metadata (`targetModule`, `targetKey`, `targetDisplayField`, `targetKind`) is an **additive** extension of `generatedResourceContract: 1` — an older Admin that does not know the `reference` field type renders it via its text fallback (a raw id field), which is safe and still functional, so the contract version is not bumped.

## ADR-011 — CRM actions are code-first definitions over one generic surface

**Status:** accepted

Lifecycle operations that are more than a field edit — qualify a lead, close an opportunity — are modeled as **code-first record actions**: plain checked-in JavaScript objects (`packages/actions/generated/index.js`) carrying `{module, name, actionContract, input, fromStates, execute}`. Three approaches were compared: per-product endpoints (fast, but duplicates route/SDK/Admin per process and bakes product logic into the framework), a declarative workflow/action DSL (a generic low-code engine — explicitly against the framework philosophy), and this one. Actions are exposed through a single reviewed route, `POST /api/modules/:module/records/:id/actions/:action`, plus `client.module(name).action(id, actionName, input)` and generic Admin buttons rendered from metadata — no per-action route, SDK or page files that would duplicate and drift, and no interpreter over a config format. `execute` is ordinary readable source the developer owns; the framework supplies only the transaction, event and trace envelope.

Definitions are validated at startup and **fail closed**, consistent with ADR-008: canonical `module`/`name` (`^[a-z][a-z0-9-]*$`), unique `{module, name}` identity, `actionContract === 1`, a target module that exists and is generated, supported input types (`string`/`timestamp`/`enum`) and an `execute` function. One malformed definition stops the app rather than exposing a partially working action. The registry is `Map`-backed, so `__proto__`/`constructor` never resolve to inherited properties. Like ADR-008 this is a contract against accidental, stale or hand-edited entries — **not** a sandbox against malicious source edits, which remain outside the threat model.

Lifecycle state is protected at the **service boundary, not the UI**. A manifest field may declare `"writable": "managed"` (default `"public"`) with an optional `"default"`: public `create` takes the declared default and never input, public `update` ignores it, and either one rejects a managed field present in the input with a field-tied `VALIDATION_ERROR`. The generated service's `applyManaged(id, patch, ctx)` is the single privileged write path — in-process only, never routed over HTTP, reached by `execute` through `ctx.managed`. A caller therefore cannot set a lead's status to `qualified` through generic CRUD, whatever client they use. Idempotency is the action's own responsibility, expressed in data rather than framework magic: the Lead starter gives its follow-up Task a **unique** `sourceKey` (`qualify:<leadId>`), so a repeated or concurrent qualify cannot produce a duplicate. The `sourceKey` is deliberately a *public* field — a squatting write through CRUD can only block a qualification (a visible 409 on a trusted local surface), never forge one; making it managed would force a second write path through the action for no security gain. Action metadata (`generatedModules[].actions`) is an **additive** extension of `generatedResourceContract: 1` — an older client simply ignores it — and exposes no source, so the contract version is not bumped.

Structurally unusable managed combinations are rejected at **manifest validation** rather than generating a module that cannot work: `managed + required` needs a `default` (public create cannot supply the value, so every create would violate `NOT NULL`); `managed + unique` cannot carry a `default` (every create would insert the same value; the second would always fail); a `default` requires `writable: "managed"` (the factory applies defaults only to managed fields — accepting one on a public field would silently never apply it). Clearing a **required** managed field to null through `applyManaged` is a field-tied validation error, not a SQL crash. `module plan` lists managed fields explicitly (`managedFields`) so the write policy is reviewable before applying.

## ADR-012 — Domain events are held in a transaction-scoped in-process buffer until commit

**Status:** accepted

An action spanning several module services must be atomic, and its domain events must never be observable before that atomicity is settled. Two real gaps were found in the existing runtime before choosing: `WorkflowEngine` runs steps sequentially with manual compensation and **no outer transaction**, and generated services `emit` **after each mutation's savepoint releases** — so a subscriber could observe a half-applied multi-step action. Both are fixed without a queue, a broker or a new dependency.

`runRecordAction` runs an action's business writes inside a single `database.transactionAsync` (`BEGIN IMMEDIATE`); generated-service `SAVEPOINT`s nest inside it, so **all writes commit or none do** — verified: rolling back the outer transaction undoes the inner savepoints. Wrapping that transaction, `EventBus.buffered` installs a **transaction-scoped outbox** backed by `node:async_hooks` `AsyncLocalStorage` (standard library, correct under concurrent requests). `emit` checks the async-local store: inside a buffered scope the event is queued; outside one it dispatches immediately, so all existing behavior is unchanged and the change is backward compatible. Events are dispatched only after the commit, dropped on rollback or on a throw, and flushed via `outbox.exit()` so a handler that itself emits dispatches immediately rather than re-queueing into a closed transaction and vanishing. Concurrent actions never share a queue.

**Named precisely: this is a transaction-scoped *in-process* event buffer, not a durable transactional outbox.** Events live only in memory until the flush; a process crash after the database commit but before the flush loses delivery. In-process subscribers (the notification provider, tests) are the intended consumers. A persistent outbox is required before these events can back remote integrations, and none is claimed.

**Post-commit dispatch failure policy.** Once the database transaction has committed, a failing subscriber must not turn the action into a reported failure — the caller would retry (or compensate) a change that already succeeded. The flush therefore dispatches every queued event even when a handler fails (a failing handler stops only its own event's remaining handlers; later events still dispatch), collects the errors, and the action runtime records them as a failed `events.dispatch` span on a **completed** run plus a stderr log. The HTTP/SDK response stays a success. Nested buffered scopes are rejected fail-closed (an inner flush would make events visible while the outer transaction is still open), and the database layer equally rejects a nested outer transaction with a clear error — so actions cannot invoke actions, by contract.

**Concurrency across connections.** Within one connection, `BEGIN IMMEDIATE` serializes writers. Across separate connections on the same SQLite file, the loser of the write lock surfaces as a stable retryable `409 CONFLICT` ("database is busy with a concurrent write") — the busy error is normalized in the transaction helpers, never leaked as a raw `SQLITE_BUSY` 500. Rollback failures never mask the primary error.

The **workflow trace is written outside the business transaction**, after it resolves, and **best-effort**: a trace-write failure (e.g. a concurrent writer briefly holds the lock) is logged, never thrown, so it cannot mask the action's real outcome. This is deliberate: a failed action must still leave a trace (the diagnostic record is the point), and writing it inside would either roll the trace back with the failure or leak partial business state into it. The consequences are accepted and documented — a trace row is not transactional with the business writes it describes, and span statuses reflect execution progress: on a failed run, spans recorded before the failure describe work whose writes were rolled back; the run-level status is authoritative.

## ADR-013 — Lead conversion runs through declared core-module adapters

**Status:** accepted

Converting a qualified Lead into Company + Contact + Opportunity crosses the boundary between generated modules and the handwritten core CRM. Three approaches were compared: calling core services directly from action code (no declared surface — any method becomes reachable and the ADR-008 boundary erodes), generating duplicate starter Company/Contact/Opportunity modules (forks the core CRM objects; the approval workflow and policy would not apply to the duplicates), and **explicit static adapters — chosen**. `packages/core/src/core-adapters.js` exposes a frozen, per-app-instance registry with five declared capabilities: `findCompaniesByNormalizedName`, `findContactByEmail`, `createCompany`, `createContact`, `createOpportunity`. Writes go through the real module services, so validation, audit and domain events are preserved and buffered exactly like every other write inside the action's transaction; reused records get **no** fake create audit or event. Normalized-match reads live in the adapter — never in action code and never in SQL (SQLite's `LOWER()` is ASCII-only, so normalization is JavaScript: Unicode NFC, trim, whitespace collapsed, lowercase). Nothing is exposed over HTTP, added to the SDK, or discoverable by introspection. No orchestration DSL.

**Reuse is deterministic and exact, never fuzzy.** Company: 0 normalized matches → create, 1 → reuse, >1 → `409 AMBIGUOUS_COMPANY` — the framework refuses to guess. Contact: the core schema's globally-unique lowercased email is the key; a match under the resolved company is reused, a match under a *different* company is `409 CONTACT_COMPANY_MISMATCH` (silently re-parenting a contact would corrupt another account). Conversion state lives on the Lead as a fourth lifecycle value (`converted`, so the ordinary `fromStates` guard makes re-conversion a stable 409) plus four managed link fields written in **one** `applyManaged` call — partial links cannot exist, and CRUD cannot write any of them. The links are plain managed strings, not `reference` fields, because generated-to-core references remain rejected (ADR-010) until an explicit reference adapter exists.

**Boundaries made explicit by the adversarial review.** (1) The public Opportunity surface can set a `sourceKey` — deliberately, mirroring ADR-011's public Task `sourceKey`: on this trusted local surface a squatted key can only *block* a conversion with a visible 409, never forge one, because the Lead's managed links — not the key — are the authoritative conversion record; a key-shaped string on an unrelated opportunity proves nothing. (2) Company lookup is a complete O(n) scan of the companies table normalized in JavaScript — correctness never depends on a list page (proven with matches beyond 250 rows); this is a documented local-development bound, not a scalable index. (3) The Lead's conversion links are managed **strings**, not SQL foreign keys: the guarantee is action-level (the ids were produced/reused in the same committed transaction), record deletion is currently unsupported anywhere in the framework, and no FK claim is made. (4) A *qualified* lead already carrying any conversion field is treated as corrupt and refused (`409 CONVERSION_STATE_CORRUPT`) — the action never overwrites evidence of out-of-band writes. (5) An older Admin that predates the `integer` input type renders it as a text field; the server rejects the resulting string with a field-tied 400, so the fallback is safe and the action contract version stays 1. Input metadata may carry a bounded free-text `hint`, rendered strictly as text — used to make integer-minor-unit money unmistakable (`500000` means `5,000.00`).

**Idempotency is enforced in the database, not just the state guard.** Core migration v2 — the first use of the versioned core migration path since Milestone 0 — adds `opportunities.source_key` with a partial UNIQUE index (`WHERE source_key IS NOT NULL`): existing rows and ordinary opportunities are untouched, while a second conversion Opportunity for the same Lead (`lead-conversion:<leadId>`) is impossible even if the state guard were bypassed. Money remains **integer minor units** (`valueCents`): the action input contract gains an `integer` type accepting JSON safe integers only — numeric strings, fractions, NaN/Infinity and unsafe magnitudes are 400s — and the Admin renders it as a number control that posts a JSON number. Concurrency inherits the M6 posture: same-connection writers serialize on `BEGIN IMMEDIATE` (the loser's re-read fails `fromStates`), cross-connection losers get the retryable `409 CONFLICT`, and two different Leads converting into the same company name serialize into one create plus one reuse — never a duplicate Company.

## ADR-014 — Pipelines are code-first definitions; actions may target explicitly eligible core modules

**Status:** accepted

Configurable Opportunity pipelines (Milestone 8) compared four shapes: the existing hard-coded stage enum (cannot express a brief's sales process — kept, untouched, for the legacy renewal-approval slice), runtime CRUD Pipeline/Stage records (business-editable but no longer reviewable source; the eventual evolution target, not the smallest step), a **deterministic code-first pipeline definition registry (chosen)**, and a fully general staged-resource contract (premature before a second consumer; the chosen contract is shaped to grow into it — a pipeline declares its target `module`, nothing in the runtime reads "opportunity"). Definitions live in `packages/pipelines/generated/index.js` (empty in this repository; the starter registers one), validated fail-closed at startup: `pipelineContract: 1`, canonical names, unique stage keys and integer orders, exactly one open `defaultStage`, stage types `open|won|lost` with at most one won and one lost, integer probabilities 0–100 (won 100, lost 0), bounded labels, an existing staged-eligible target module, **one pipeline per module**. `/api/schema` exposes `pipelineContract: 1` + ordered, function-free `pipelines` metadata (additive; older clients ignore it). Probabilities are display metadata — **no forecasting claim**.

**Pipeline state is server-managed core-module state.** Core migration v3 adds five nullable columns (`pipeline_key`, `pipeline_stage`, `stage_entered_at`, `closed_at`, `close_reason`): legacy rows and pipeline-less projects stay valid with NULLs. `OpportunityService.create` rejects these fields in input exactly like generated managed fields; the only write path is the service's in-process `applyManaged` (audit + event + savepoint), used by conversion (via the `enterOpportunityPipeline` adapter — the declared default stage, atomically with the conversion transaction; with no pipeline installed the documented default is legacy null state, never an invented stage) and by the generic **`move-stage`** action (`buildMoveStageAction`, framework-provided, starter-registered). Transitions this milestone: open→open, open→won, open→lost; same-stage moves are a visible `409 SAME_STAGE`; terminal stages refuse (`409 TERMINAL_STAGE`, no reopen); `fromStage` is an optimistic-concurrency check (`409 STALE_STAGE`); lost requires a bounded reason; a record whose stage no longer belongs to its pipeline refuses (`409 PIPELINE_STATE_CORRUPT`) rather than guessing. Concurrency inherits M6/M7 posture (serialized writers, retryable cross-connection `409 CONFLICT`, one audit/event per transition), proven across independent connections.

**Boundaries made explicit by the adversarial review.** (1) **Staged eligibility means pipeline-state storage.** A pipeline may target only a module that actually stores pipeline state — today the action-eligible core modules (opportunity, via migration v3). A generated module has no pipeline columns, so a pipeline targeting one would boot cleanly yet be permanently unusable (nothing could ever enter it); startup now rejects it fail-closed. Manifest-declared pipeline state for generated modules is named future work — the contract layer itself (validation, registry, metadata) is module-generic and unit-tested with non-opportunity fixtures. (2) **Stage keys are persistent identifiers; labels are presentation.** Renaming or removing a key does not remap stored records: a record whose stored key leaves the definition refuses to move (`PIPELINE_STATE_CORRUPT`) and the board lists it in an explicit "Off-definition" section — never silently hidden or misclassified; the key change requires an explicit data migration, which the framework deliberately does not automate. Default-stage changes affect only new entries. No definition fingerprint is added yet — drift is surfaced, not versioned. (3) **Coherence is enforced in the transition**, not assumed: open targets explicitly clear `closedAt`/`closeReason` (repairing out-of-band corruption on the next legitimate move), won never stores a lost reason (a reason on a non-lost target is deliberately ignored), and terminal entry always stamps `closedAt` via the injectable clock. (4) **Concurrency mechanism, named precisely:** the fromStage comparison and the managed update run inside the `BEGIN IMMEDIATE` writer transaction — under SQLite's single-writer model this is equivalent to a conditional write; cross-connection losers surface the M6 retryable `409 CONFLICT`, in-transaction losers `409 STALE_STAGE`. (5) **Board honesty:** the board loads a fixed limit (200) and discloses truncation; records not on the pipeline are excluded with a visible count; there is no auto-enrollment when a pipeline is introduced later — existing records keep null pipeline state and explicit enrollment tooling is deferred. (6) **Money display contract:** all stored amounts are defined as 1/100 currency units rendered with two decimals — deliberately not universal ISO-4217 minor-unit support (JPY/KWD exponents are not modeled); a per-currency exponent map waits for a real brief.

**Actions on core modules are explicitly eligible, never implicit.** The generic action route serves exposable generated modules plus handwritten core modules that (a) appear in the app's explicit `ACTION_ELIGIBLE_CORE_MODULES` declaration and (b) have at least one action registered in checked-in source — registration is the eligibility declaration. Core CRUD stays on its dedicated routes; the generic records surface still never serves core modules (ADR-008 unchanged). Schema advertises these actions under `coreModuleActions`, separate from `generatedModules[].actions`. The Admin board renders purely from pipeline metadata (columns in stage order, badge-text type distinction, per-currency totals via the deterministic `formatMinorUnits` — currencies are never summed together), and the accessible per-card "Move to" control posts the same server action with `fromStage`; there is no drag-and-drop path and the server remains authoritative against stale boards.

## ADR-015 — Lead Intelligence runs on bounded code-first contracts with persisted version fingerprints

**Status:** accepted

Lead Intelligence v1 (Milestone 9) — enrichment, explainable scoring, deterministic routing — compared three shapes: hardcoding the logic inside Lead actions (fast but unversioned, unreproducible and per-project incompatible), a universal declarative policy/rules DSL (a low-code engine, explicitly against ADR-006/011), and **bounded code-first registries and contracts (chosen)**. Enrichment providers, scoring models, routing policies and routing targets are plain checked-in definitions (`packages/intelligence/generated/index.js`, empty in-repo; a project/starter writes it) validated fail-closed at startup in Map-backed per-app registries (`packages/core/src/intelligence-registry.js`) — canonical names, positive integer versions, bounded labels, real handlers, unique identities, at most one fallback target, ISO-shaped country/language codes, function-free schema metadata. No visual editor, no interpreter over config.

**Git history alone is not runtime policy versioning.** Every scoring-model and routing-policy version carries a deterministic SHA-256 **fingerprint** of its canonicalized source (sorted keys, handlers via `toString()`). Core migration v4 adds `definition_versions`; startup inserts-or-verifies each `{type, name, version, fingerprint}`: re-registering the same source is a no-op, while a registered version whose source changed **stops the app** — definitions are immutable once registered, and rollback means publishing a NEW version derived from an earlier definition, never editing history. Every ScoreRun/RoutingRun additionally stores the name, version and fingerprint it executed under, plus stable references to its inputs (snapshot id, signal count + id-set fingerprint), so historical decisions stay identifiable and reproducible across rollbacks, restarts and databases.

**External-style calls never hold the write transaction.** The action contract gains an optional `prepare(ctx)` phase (additive to `actionContract: 1`): it runs before the event buffer and the `BEGIN IMMEDIATE` transaction, with a read-oriented ctx (a preview record, validated input, registries — no `managed`), and its return value reaches `execute` as `ctx.prepared`. The enrich action calls the provider there under a bounded timeout, validates and normalizes the result (bounded strings, ISO country/language shapes, integer confidence — anything else is a stable `PROVIDER_INVALID`; outages are `PROVIDER_FAILED`, timeouts `PROVIDER_TIMEOUT`), and `execute` re-reads authoritatively inside the transaction: a concurrent winner's snapshot is reused and the prepared result discarded with an honest trace step. Provider failures persist nothing (failed snapshots are deliberately not stored in v1) and leave an honest failed trace.

**Intelligence records are immutable through public CRUD by construction.** Snapshots, signals, score runs, contributions, routing runs and assignments are starter-generated modules whose every field is `writable: "managed"`: public create can only make an empty row, public update has no public fields to touch (a structural no-op), and the only data write path is the in-process `applyManaged` used by the framework actions (`packages/core/src/intelligence-actions.js`: `buildEnrichAction`, `buildRecordSignalAction`, `buildScoreAction`, `buildRouteAction` — module-parameterized like ADR-014's move-stage). Lead links (`enrichmentSnapshotId`, `score`, `scoreRunId`, `assignedTargetId`, `routingRunId`, timestamps) are managed fields updated atomically with their run records. Deterministic source keys make repeats explicit: snapshot `enrich:<leadId>:<provider>@<version>:<seq>` and signal keys are DB-unique — duplicates are stable 409s, refreshes are new snapshot versions, historical records are never overwritten. Reads that gather a lead's records are bounded list-and-filter scans (limit 500) — the ADR-013 documented local posture, not an index.

**Deterministic decisions, named semantics.** Scoring evaluates every rule in declared order against frozen inputs (an expired snapshot is not a valid input; a throwing or non-boolean rule is a `SCORING_RULE_INVALID` failure — models must be total), persists one contribution per rule and clamps to declared bounds. Routing: an already-assigned lead is a stable `409 ALREADY_ASSIGNED` (explicit reroute is deferred), an unscored lead `409 LEAD_NOT_SCORED`; current load is the count of leads assigned to each target computed in-transaction; eligibility is active + score band + capacity; ties break by the documented ranking (priority desc → load asc → key asc), never randomness; a policy declining everything falls back to the single declared fallback target with a recorded reason, else `409 NO_ELIGIBLE_TARGET`. Concurrency inherits the M6–M8 posture (serialized same-connection writers, retryable cross-connection `409 CONFLICT`, DB-unique keys) — exactly one final assignment, proven across connections.

**The RBAC boundary is stated, not faked.** Routing targets are trusted application identifiers, not authenticated users. No manual-override action ships: real Sales-Manager reassignment authorization requires the Production Spine (authentication, tenancy, roles enforced in services). The assignment record already carries `source`/`previousAssignmentId`/`reason` so a future override lands as data; the JTBD stays not supported until then, and no live-availability/calendar claim is made.

**Boundaries made explicit by the adversarial review.** (1) **The prepare phase is enforced read-oriented, not just documented:** its `modules` is a per-module read-only view (get/list/listWhere/countWhere — no create, update, createManaged or applyManaged is reachable through any ctx property), and the returned value is normalized to plain JSON-safe data and deep-frozen before reaching `execute` (functions, symbols, bigints, non-plain objects, non-finite numbers and cycles are rejected; `__proto__`-style keys are dropped). Timeout policy, named precisely: the provider promise is raced against a bounded timer, the losing promise is explicitly observed so a late rejection is never unhandled, and late settlement is *abandoned*, not cancelled — no AbortSignal is claimed, and nothing settled late can persist because persistence happens only in `execute` from the already-returned prepared value. (2) **All-managed record modules are read-only publicly by construction:** the factory generates them with capabilities `['get','list']` and NO public create/update at all — HTTP POST/PATCH fail closed (404 capability gating, ADR-008), the Admin shows no Create/Edit, empty rows cannot be created by any client, and the only write path is the generated in-process `createManaged`/`applyManaged` pair (one audit + one event per record). (3) **The fingerprint is a *declared-definition* fingerprint:** it captures a definition's own source and its declared `config` (now part of the contract and passed frozen into every evaluation) — a handler closing over a mutable outer variable or an out-of-file helper is NOT captured (`toString()` serializes identifiers, not values; closure analysis is deliberately not attempted), so shipped thresholds and tunables MUST live in `config` or as literals; unsupported values (Date, Map, Set, RegExp, class instances, BigInt, symbols, non-finite numbers, undefined, cycles) fail fingerprinting loudly. Enrichment providers get the same persisted protection as models and policies, and every snapshot stores the provider fingerprint it was produced under — code-version integrity, distinct from remote-provider reproducibility, which no fixture can promise for real external services. Registration runs in one `BEGIN IMMEDIATE` transaction: all-or-nothing, and concurrent boots serialize instead of racing to a raw UNIQUE error. (4) **No correctness read is page-bounded:** generated services expose exact `listWhere`/`countWhere` (declared-field equality/IN, complete, prepared statements) backed by manifest-declared `index` columns — latest-snapshot, sequence, signal-set and load reads are exact beyond any row count (proven at 520 signals). (5) **Capacity means ACTIVE workload:** current load is the exact indexed count of leads in `new`/`qualified` assigned to a target — converting or disqualifying a lead releases its slot (proven), and the capacity check shares the routing transaction, so a two-connection race for the last slot never oversubscribes a target. (6) **Routing decisions carry their own evidence:** every RoutingRun stores the policy fingerprint AND the declared target-set fingerprint, plus one route-evaluation record per candidate target (eligible or not, exact reason, load, capacity, priority) — target-data drift between runs is explicitly versioned per run rather than boot-failing, because target data legitimately changes; every ScoreRun additionally stores a fingerprint of the mutable lead fields it read (values are fingerprinted, not copied — LI-09 stays partial). (7) **Lifecycle is server-gated:** enrich/score/record-signal run only from `new`/`qualified`, route only from `new` — converted and disqualified leads are outside the intelligence lifecycle regardless of client, and the Admin hides the actions via the advertised fromStates.

## ADR-016 — Commercial Operations runs on bounded primitives, immutable versions and versioned discount policy

**Status:** accepted

Commercial Operations v1 (Milestone 10) — catalog, quotes, discount approval — compared three shapes: **generic generated modules plus actions only** (prices and totals would be client-writable and quoted evidence mutable — the anti-bypass and immutability requirements are structurally unreachable), a **monolithic handwritten CPQ core** (maximum control, but it duplicates the validation, savepoints, audit, events, read-only capabilities, exact queries and indexes the factory already generates, and forks the storage conventions the rest of the framework proves), and **bounded commercial primitives on the hardened M9 machinery (chosen)**. Storage is ten starter-generated **read-only all-managed modules** (ADR-015 pattern: capabilities `['get','list']`, no public create/update at all, trusted `createManaged`/`applyManaged`, exact `listWhere`/`countWhere` over manifest-declared indexes). Behavior is framework-owned code-first source: `commercial-registry.js` (catalog providers + versioned discount policies on the ADR-015 declared-definition fingerprint mechanism), `catalog-sync.js`, `commercial-money.js` and `commercial-actions.js`. **No pricing-expression language, no CPQ/rules DSL.** Company and Opportunity are referenced, never duplicated; `create-quote` is an action on the action-eligible core Opportunity module (ADR-014 precedent). Signature and Order are Milestone 11 and are deliberately absent — the immutable Quote Version is exactly the artifact they will consume.

**Catalog identity is stable; commercial evidence is immutable.** A **Product** carries stable identity (source kind internal/provider, provider, external id, DB-unique source key, active, current version link); a **ProductVersion** is an immutable commercial description; a **PriceBook** is a named list in exactly one immutable currency; an **Offer (rate plan)** is the sellable package bound to one ProductVersion, carrying one or more **PriceComponents** with their **Tier** schedules. Changing commercial data never rewrites history: sync computes a declared **source fingerprint** per product and per **whole offer** (name, eligibility, every component and every tier), and a change creates a **new version / new offer revision** with fresh immutable component and tier rows, deactivating the prior revision — a quote's frozen evidence is untouched by later catalog movement, and re-adding a superseded revision is refused (`409 OFFER_INACTIVE`). `syncCatalog` follows the ADR-015 external-call discipline: `fetchCatalog` runs **outside** any transaction under a bounded timeout with late settlement abandoned (never cancelled — no AbortSignal claim), the payload is validated into the contract (bounded strings, safe integers, canonical currencies, unique source keys; anything else is a stable `PROVIDER_INVALID`), and reconciliation runs in one `BEGIN IMMEDIATE` transaction with a `CatalogSyncRun` recording provider identity, fingerprint and counts. Identical input re-syncs are **idempotent** — unchanged identities produce no writes, audits or events. Provider-managed products absent from a payload are deactivated **only** under the provider's declared `config.deactivateMissing`. No provider secrets or raw payloads are stored. Future provider packages may target Stripe Products/Prices, Zuora, ERP or custom CPQ APIs; **no real adapter or credential ships in M10** — a deterministic fixture provider proves the contract.

**The pricing model is composite, not one flat price per product (corrected in the adversarial review).** The original model — one sellable `PriceBookEntry` carrying a single unit price — could not express a real offer, and would have forced provider catalogs to be flattened. The corrected shape is `Product → ProductVersion → Offer → PriceComponent(s) → Tier(s)`. A component declares `chargeType` (`one_time` | `recurring`), `pricingModel` (`flat_fee` | `per_unit` | `volume` | `graduated`), `interval`/`intervalCount` for recurring charges, amounts, an ordered tier schedule for tiered models, and provider provenance (provider, version, external product/offer/price ids, `sourcePricingModel`, source fingerprint). One Offer can therefore mix a one-time setup fee, a recurring monthly platform fee and recurring volume-tiered seats, and **one quote line selects one Offer and a quantity**.

**Quantity semantics are explicit, never silent:** `flat_fee` is charged ONCE per line (line quantity never multiplies it), `per_unit` multiplies by quantity, `volume` prices the entire quantity at the single tier the quantity reaches (plus that tier's flat amount once), and `graduated` prices each band independently (plus each receiving band's flat amount once). Tier schedules are validated fail-closed: non-empty for tiered models, forbidden for non-tiered ones, strictly increasing inclusive `upTo` bounds with implicit lower bounds (so the schedule is gap-free and overlap-free by construction), exactly one open-ended final tier, non-negative safe-integer amounts, at most 50 tiers, quantities within the supported range. Every calculation returns a deterministic **tier breakdown** that sums to the component total.

**Provider semantics are preserved, and unsupported models fail closed.** The normalized model maps Stripe one_time/recurring and `tiers_mode` volume/graduated, and Zuora one-time/recurring charges with Volume and Tiered/Cumulative pricing, onto the same four models while keeping the provider's own model name and external ids. Models the framework does not implement — metered usage, overage, proration, ramps, minimum commitments, attribute-based/dynamic pricing, tax-inclusive computation, FX, custom formulas — are **never approximated as flat prices**: the offer persists with `quoteEligible: false` and a bounded `unsupportedReason`, no component rows are invented for it, and quoting it is a stable `409 OFFER_NOT_QUOTE_ELIGIBLE`. No real Stripe/Zuora adapter or credential ships; a deterministic fixture provider proves the contract offline, and full Stripe/Zuora support is explicitly not claimed.

**Totals are grouped by commercial period; there is no grand total.** A quote and every quote version persist one **one-time** total plus one total per `(currency, interval, intervalCount)`. Unlike periods are never summed, and **ARR/MRR/TCV are deliberately not derived** because contract term and normalization policy are not modeled. Discount policy (v1, documented): a line's basis-point discount applies **uniformly to every component of that line, after tier/list calculation**; each component retains list, discount and net amounts, and the policy evaluates the complete grouped totals plus the component mix.

**A submitted Quote Version snapshots everything needed to reproduce the commercial decision**: the offer identity and revision, product version, every component definition (charge type, pricing model, recurrence, amounts), the complete tier schedule, the calculated tier breakdown, quantity, list/discount/net per component, provider provenance, and one grouped-total row per period. A later catalog sync — including tier-boundary and price changes — leaves every existing Quote Version byte-identical, while new drafts price from the new active revision (both proven).

**Money and discounts are safe-integer arithmetic with a documented rounding policy.** Amounts remain ADR-014's contract: safe integers in 1/100 currency units, two decimals, deliberately **not** ISO-4217 exponents. Currencies are uppercase `[A-Z]{3}`; a Quote binds one Price Book and one currency, and there is **no conversion** — a mismatched entry is `409 CURRENCY_MISMATCH`. Discounts are integer **basis points** 0–10000 (no floating-point percentages). Rounding, exactly: each component's list amount is computed per its pricing model with integer arithmetic only; `componentDiscount = trunc(componentList × bps ÷ 10000)` (truncating, so a discount never rounds up); `componentNet = componentList − componentDiscount` is **authoritative**; line and grouped totals are checked sums of component amounts. Every multiplication and sum is overflow-checked — a result outside the safe range is a refusal, never a silently wrong number. **The server derives every price and total from catalog data; a client cannot submit a unit price or a total through any surface.**

**Quote lifecycle is server-authoritative and version history is immutable.** `draft → pending_approval → approved | rejected`, with `revise` reopening a rejected quote and `approved` terminal in M10. Draft edits (`add-line`/`update-line`/`remove-line`, soft removal — the framework has no safe general delete) are gated to `draft` by `fromStates`, validate that the offer revision is active, quote-eligible, complete, belongs to the quote's Price Book and matches its currency (a line re-prices only from its **pinned** offer revision, so a later catalog revision never silently re-prices an existing draft), and each successful edit recalculates totals and increments `draftRevision`; an optional `expectedRevision` gives optimistic concurrency (`409 STALE_REVISION`), so concurrent editors cannot lose updates. `submit` freezes an immutable **QuoteVersion** plus **QuoteVersionLines** (product, version, SKU, entry id + revision, quantity, list/net unit, discount bps, subtotal/discount/total, pricing mode/interval) whose number is DB-monotonic through a unique `qv:<quote>:<n>` key — concurrent submits produce exactly one version. Fault injection at any step rolls the whole submission back: no partial version, no orphan approval, the quote unchanged.

**Discount policy is versioned, explainable and deterministic; approval is human.** A code-first `defineDiscountPolicy`-shaped definition carries `{name, version, label, config, evaluate}` on the ADR-015 mechanism: declared JSON-safe config is fingerprinted (thresholds live there, never in closures), drift under a registered version stops the boot, rollback is a new version. `evaluate` receives a deep-frozen context (quote identity, totals, max-line and effective discount bps, line summaries, opportunity evidence where readable, actor, frozen config) and must return **synchronously** one of `auto_approve | approval_required | reject` with bounded reason/approval-key/matched-rule metadata; Promises and out-of-contract results are refused. The decision, policy name, version and fingerprint are stored **on the Quote Version**, so a historical quote stays explainable after policy v2 ships. `auto_approve` approves the quote with **no fake approval record**; `approval_required` creates exactly one `quote-approval` (DB-unique per version) and parks the quote in `pending_approval`; `reject` marks the quote rejected with the policy's reason. `approve`/`reject` actions enforce the framework's human boundary — **only `actor.type === 'user'` may decide; an agent actor is refused `403 HUMAN_APPROVAL_REQUIRED`** — with one decision per version (a second is `409 ALREADY_DECIDED`), the decision and the quote lifecycle committing atomically, and concurrent decisions resolving to one winner. The core Approval module is renewal/opportunity-shaped (its table requires an opportunity FK), so quotes use a dedicated approval record rather than bending that schema; generalizing the approval domain is future work. **`requiredApprovalKey` is a label, not enforced security: real Sales-Manager/Finance role enforcement requires the Production Spine (authentication, tenancy, RBAC), and nothing here claims otherwise.**

## ADR-017 — External signature runs on a bounded provider contract, a persisted state machine and explicit reconciliation

**Status:** accepted (Milestone 11).

**Context.** Milestone 10 ends with an immutable, approved Quote Version. Turning that into a signed commitment requires something the framework has never done: a **remote side effect whose outcome the local database cannot commit atomically with**. A signature provider may accept a request and the local write may then fail; a webhook may arrive twice, out of order, or never; a process may restart mid-flight. Three shapes were compared: (1) a direct provider call inside a normal transactional action — one code path, but it holds the SQLite write lock open across a network round trip and, worse, invites the lie that local and remote state commit together; (2) a generic external-workflow/side-effect DSL — maximum flexibility, an entire framework of its own, hard to make fail-closed, exercised by one provider; (3) **a bounded signature provider contract plus a persisted envelope/event state machine with explicit reconciliation (chosen)**.

**The external-operation contract.** The action runtime gains exactly one new shape, not a DSL: an action may declare `externalOperation: 1` with `intent` (inside transaction A), `external` (outside every transaction, under a bounded timeout, late settlement abandoned), `finalize` (inside transaction B) and `compensate` (its own transaction, only when a later phase failed). Values crossing a phase boundary are normalized to plain JSON-safe data and deep-frozen, and the `external` context carries **no database, no module registry and no managed-write access** — action code declares phases, it never gains transaction control. The same runner (`packages/core/src/external-operation.js`) drives the app-level signature operations, so all of them produce one trace run whose spans distinguish local intent, the provider call and local finalization, with events buffered per transaction and dispatched only after that transaction commits (ADR-012). **No atomicity between the local database and a remote provider is claimed anywhere**; the state machine plus reconciliation is the recovery story, and it is explicit.

**Provider integrity is not service behavior.** A signature provider is a code-first `{name, version, label, config, createEnvelope, getEnvelope, verifyEvent, getSignedArtifact}` definition on the ADR-015 declared-definition mechanism: Map-backed per-app registry, fail-closed validation, canonical fingerprint over source plus declared JSON-safe config, persisted in `definition_versions` so editing a registered version stops the next boot. That fingerprint proves **provider code and configuration integrity — never the remote service's behavior**, which is why every provider result is re-validated into a bounded normalized contract (`PROVIDER_INVALID`) before it can touch local state, and why a provider may never assert the local-only `preparing`/`failed` states. Only a deterministic offline fixture provider ships: **no DocuSign, Adobe Sign or Dropbox Sign integration exists or is claimed.**

**The envelope state machine is monotonic and server-authoritative.** States are `preparing → sent → delivered → completed | declined | voided`, plus `failed`. A transition applies only when its target ranks strictly higher than the current state, and `completed`, `declined` and `voided` are terminal: a duplicate, late or contradictory provider event is recorded in the inbox and **ignored**, never applied. `failed` is the one recoverable non-terminal state — it means the *local* side failed while the provider may or may not hold an envelope — and the single documented policy is *never silently retry, always reconcile*. There is **exactly one envelope per Quote Version, ever**, enforced by the DB-unique source key `env:quote-version:<id>`, which is also the deterministic provider idempotency key: a repeated request is `409 ENVELOPE_EXISTS` and can never create a second provider envelope. Signer semantics in v1 are narrow and stated: all signers required, 1–5 signers, the declared order recorded but not sequentially gated, no conditional routing, and **no signer identity assurance beyond the provider's own evidence**.

**Events are verified before anything is trusted.** Provider events arrive on a dedicated route, `POST /api/signature/providers/:provider/events`, with the **raw body preserved** (re-serialized JSON would not reproduce what the provider signed) and bounded to 64 KiB; the provider is selected canonically from the path. Verification — constant-time HMAC comparison plus a bounded timestamp/replay window in the shipped fixture — runs **before any state mutation**, and a failure is a stable `401 SIGNATURE_INVALID` that never echoes the payload, the signature or the key. Accepted events land in an append-only inbox whose provider event id is DB-unique, so a replay is idempotent and answers identically; an event for an unknown envelope is **quarantined as evidence** rather than silently discarded. The fixture verification key is declared test-only in checked-in source: **this is not production webhook security**, and real secret management is Production Spine work.

**Completion is one atomic commitment.** A verified `completed` transition creates, in a single transaction, the signer completion evidence, the `signed-artifact` record (hashes, provider artifact reference and metadata — the bytes stay with the provider, and long-term object-storage durability is not claimed) and exactly **one immutable Order** with its lines, components, tier schedules, band breakdowns and grouped totals, all **copied from the approved Quote Version snapshot and never re-read from the live catalog**. The document package that was signed is rebuilt from that snapshot and must hash identically, so a snapshot that moved is a refusal (`DOCUMENT_HASH_MISMATCH`) rather than a mis-signed order. Artifact metadata that needs a provider call is fetched in the `external` phase, before the transaction opens. `order:quote-version:<id>` is DB-unique, so duplicate webhooks, concurrent webhooks and a webhook racing a reconcile can only ever produce one Order. Orders carry **no fulfillment, billing, payment or invoice state**, no ARR/MRR/TCV, and no amendment path — those are later milestones.

**Reconciliation is explicit, never scheduled.** `app.reconcileSignature({envelopeId})` (and `POST /api/signature/envelopes/:id/reconcile`) queries the provider outside every transaction, by provider envelope id when known and otherwise by the deterministic idempotency key — which is exactly how a provider success whose local finalization failed is recovered — then applies the same monotonic transition and the same atomic completion. It never duplicates events, artifacts or orders, and it is honest when the provider genuinely holds nothing (`absent-at-provider`). **No background scheduler ships in this milestone:** recovery is always an explicit, audited operation.

**The human boundary applies to sending.** Requesting a signature is a real external side effect, so only `actor.type === 'user'` may perform it; an agent actor is refused `403 HUMAN_APPROVAL_REQUIRED`. An agent may prepare the quote, the version and the signer inputs — a human must send. As with ADR-016's approval keys, this is a **human-actor boundary, not Sales/Legal role enforcement**: real roles require the Production Spine (authentication, tenancy, RBAC).

### ADR-017 addendum (Milestone 11 adversarial review)

The review found two defects that could each destroy an Order permanently, and four weaker guarantees than the ADR claimed. All are fixed in-place; the contract below is what M11 actually implements.

**A terminal answer from `createEnvelope` is completion, not a status.** A provider may answer an idempotent create with an already-`completed` envelope (an instant signature, or a replayed key). Persisting that status alone left a terminal envelope with no artifact and no Order — and because terminal states never transition again, reconciliation could never repair it. Finalization now routes **every** provider state through the same `applyProviderState` path that a webhook uses, and the artifact metadata a completion needs is fetched in the `external` phase, before any transaction opens.

**The signed package is rebuilt from snapshots, never from live CRM rows.** The document hash was recomputed at completion from the live Company/Contact/Opportunity records, so a customer rename — or a party row that simply became unreadable — permanently blocked completion with `DOCUMENT_HASH_MISMATCH`. The commercial parties are now snapshotted **once**, at request time, stored on the envelope, and are the only party source the package ever uses. The Order carries `customerName`/`customerEmail` from that same snapshot, so it renders its customer without depending on live CRM data.

**The hash covers the exact bytes that are sent.** Canonicalization is now a single deterministic serializer (`canonicalJson`: keys sorted by code unit, array order preserved, no whitespace); the SHA-256 is taken over those exact bytes, and **those same bytes** are what the provider receives. Ordering never uses `localeCompare`, which would make the hash depend on the host's ICU data. The canonical bytes are stored on the envelope and copied onto the signed artifact, so the signed evidence is readable and re-verifiable without the catalog, the quote or the provider.

**An idempotency key is a lookup, not an identity.** Before a provider envelope is adopted — at creation and at reconciliation — it must agree with the local intent on the document hash and the signer set, and on the provider envelope id when one is already known. A disagreement is `409 PROVIDER_ENVELOPE_MISMATCH` and nothing is bound. A provider that echoes neither field simply cannot be checked on it; that weaker guarantee is stated rather than assumed away.

**Transitions come from an explicit table, not a rank.** `completed`, `declined` and `voided` are branching outcomes, not points on a scale: a numeric rank makes `completed → declined` and `declined → completed` look equal. The allowed-transition table is now the contract, is published in `/api/schema`, and is asserted pair by pair.

**Replay scope is provider + event id + payload fingerprint.** The verified bytes are fingerprinted onto the inbox row. The same id with the same bytes is a stable duplicate; the same id with **different** bytes is `409 EVENT_ID_CONFLICT` rather than an acknowledged replay. An inbox row whose *processing* failed stays `processed: false` and a redelivery **resumes** it — a failed completion is retryable, never stranded behind its own duplicate check.

**Quarantine is recoverable, not a silent loss.** An event that arrives before the envelope knows its provider id is quarantined as evidence; once the provider id becomes known, matching quarantined rows are linked to the envelope, and reconciliation produces the artifact and the Order that event announced.

**Webhook bytes stay bytes.** The raw body travels as a `Buffer` from the socket to verification: decoding to a UTF-8 string first would replace invalid bytes and verify something the provider never signed. Verification is over `timestamp || rawBody` with a constant-time comparison of equal-length buffers, a ±300 s window whose boundary is inclusive, and a 64 KiB bound.

**`artifactHash` is provider-reported.** Accordo does not download or hash the artifact bytes and verifies no signature cryptographically. The schema says so, the guide says so, and the Admin says so.

**One limitation is retained deliberately and stated everywhere:** there is exactly one signature envelope per Quote Version, **ever**. A quote version whose envelope failed — including one the provider never received (`PROVIDER_ENVELOPE_ABSENT`, distinguished from an unknown outcome) — cannot be re-sent in M11; reconciliation is the only recovery path, and no resend framework exists. The Admin states which of the three cases applies rather than implying the provider's state is known when it is not.

## ADR-018 — The core runtime is a platform; domain behavior belongs in domain packages

**Status:** accepted (Platform Alignment Gate, after Milestone 11).

**Context.** Eleven milestones put an increasing amount of *domain* behavior inside `packages/core/src`: `intelligence-registry.js`, `intelligence-actions.js`, `commercial-registry.js`, `commercial-money.js`, `catalog-sync.js`, `commercial-actions.js`, `signature-registry.js` and `signature-operations.js` sit next to genuinely generic machinery like `database.js`, `audit.js`, `event-bus.js`, `module-manifest.js`, `action-runtime.js` and `external-operation.js`. Each addition was individually reasonable — the runtime pieces they needed did not exist yet — but the trend has one ending: a core that every project must adopt whole, where lead scoring, pricing and signature semantics are framework concerns. The next three domains (Contract/Subscription, Delivery, Service) would triple it.

**Decision.** The core is a **platform runtime**, not a CRM. Domain behavior belongs in optional domain packages built on the runtime's contracts.

**The core runtime may own** module and runtime contracts; the deterministic database boundary; transactions and savepoints; audit; trace; the event-buffer/outbox contract; the action and workflow runtimes; the external-operation runtime; provider and definition registries (the *mechanism*, not any particular provider kind); policy-version and fingerprint helpers; the module factory; the schema contract; plugin and capability contracts; and the generic HTTP, SDK and Admin adapters.

**Domain packages own** Lead Intelligence, Commercial Operations, Signature/Documents, Contract/Subscription, Delivery, Service and Analytics — their records, their policies, their provider kinds and their actions.

A provisional package shape, deliberately **not** a naming decision (the public name is still an open human decision, `MASTER_PLAN.md` §10):

```text
@<brand>/runtime        database, transactions, audit, trace, events, registries
@<brand>/framework      module factory, manifest, generated API/SDK/Admin adapters
@<brand>/intelligence   enrichment, scoring, routing
@<brand>/commercial     catalog, pricing, quotes, discount policy
@<brand>/signature      envelopes, verified events, signed artifacts, orders
@<brand>/subscription   contracts, subscriptions, terms, entitlements, renewal
@<brand>/delivery       projects, milestones, work packages, acceptance
@<brand>/service        service contracts, SLA, support cases
@<brand>/analytics      semantic metrics, reports, dashboards
```

**The core budget rule.** *New domain-specific business behavior is not added to `packages/core` unless it is first proven to be a reusable runtime capability.* "Proven" means at least two domains need it, or it is one of the responsibilities listed above. A PR that adds a domain concept to core must say in its description which runtime capability it is and why the domain package cannot own it. This rule is a review gate, not a lint.

**Staged extraction, never a big-bang refactor.** Existing M9–M11 files stay exactly where they are; this ADR moves nothing:

1. **New domains start outside core.** Milestone 12 onward builds domain packages against runtime contracts from day one.
2. **Shared capability contracts are introduced where a second consumer proves the need** (`docs/strategy/PLATFORM_CAPABILITIES.md`), not speculatively.
3. **Existing domain code moves only through behavior-preserving PRs** — one domain at a time, import paths and public behavior unchanged, the full suite green before and after.
4. **Compatibility is maintained** with golden tests: the same starter, the same manifests, the same HTTP/SDK responses, the same audit/event/trace shapes.

An extraction PR that changes behavior is not an extraction PR.

**Plugin ownership.** A third-party package must be able to add domain modules, provider kinds, actions and policies **without patching core**: it registers through the same checked-in `generated/index.js` registries the first-party domains use, and it is bound by the same capability contract. If a plugin needs a core change to work, that is a missing runtime capability and belongs in this ADR's list — not in the plugin.

**Consequences.** Domain packages become optional: a project that only wants Lead Intelligence should not carry pricing or signature code. The core gains a stable, testable surface. Extraction costs several careful PRs, and until they land the tree keeps the current shape — which is exactly why this ADR is written before the next domain rather than after it.

### ADR-018 addendum — the domain seam, proven by Milestone 12

**Status:** accepted (Milestone 12, the first domain built outside core).

Milestone 12 was the test the ADR asked for: build a whole domain — contracts,
subscriptions and obligations — in `packages/contracts/` without adding a
domain concept to core. It needed exactly **two** generic runtime additions,
both of which pass the core budget rule because they name no domain:

**1. A domain registry seam (`packages/core/src/domain-registry.js`).**
*Superseded by addendum 3: the file is now
`packages/core/src/package-registry.js` and the field is `packageContract`.
The paragraph below records what Milestone 12 shipped.* A
domain package hands the application a plain declaration —
`{name, domainContract: 1, label, actions[], policies[{kind, definition}],
metadata()}` — and the runtime does what it already does for every other
registry: validates the shape, refuses duplicates, computes the ADR-015
declared-definition fingerprint of each policy, persists it in
`definition_versions` under `domain-policy:<domain>:<kind>`, registers the
actions, resolves policies by explicit `(domain, kind, name, version)` from a
Map, and publishes function-free metadata under `/api/schema` → `domains`.
The word "contract", "subscription" and "obligation" appears nowhere in
`packages/core`; a test scans the core sources to keep it that way. Removing
the single static import in `packages/domains/generated/index.js` removes the
domain, and the kernel boots byte-identically without it.

**2. A strict `boolean` action input type.** The action runtime had `string`,
`timestamp`, `enum`, `integer` and `json`; a boolean had to travel as JSON,
which is a modelling accident rather than a decision. The new type accepts
`true`/`false` only — never `"true"`, `1` or `"yes"` — so a term flag cannot be
set by a string that happens to look truthy.

**Nothing else was needed**, and that is the finding: the module factory,
managed writes, the record-action runtime, transactions, audit, events and
trace carried a full domain unchanged. The seam is generic by construction —
the next domain package (Delivery, Service) registers through the same
`DomainRegistries` without a further core change, and a third-party package
uses the identical path, as ADR-018's plugin-ownership clause requires.

**What the seam deliberately does not do.** It does not sequence domains, share
state between them, let one domain override another's action, or give a domain
privileged database access: a domain package writes exclusively through the
same managed record services every other action uses.

### ADR-018 addendum 2 — what the Milestone 12 adversarial review corrected

**Status:** accepted (adversarial review of PR #16, before merge).

Three defects in the first M12 implementation were domain-model defects rather
than bugs, and all three are the same mistake: **claiming more than the
evidence supports.**

**1. A term recorded after signature is not a signed term.** The signed
document package (ADR-017) contains priced lines, parties and signers — and no
term, renewal clause or notice period. The first implementation collected
`effectiveDate`, `termStartDate`, `termEndDate`, `autoRenew` and
`renewalNoticeDays` at activation and stored them as "the contract term",
which reads as though the customer had signed them.

The honest bounded correction, chosen over adding pre-signature terms (that is
a Quote/Document feature, not a review fix): the values are **operational
activation metadata**. Every record that stores them also stores
`termsSource: "post-signature-operational-activation"` and a required human
`termsReason`; the plan payload, `/api/schema`, the Admin form and the guide
all say the term is not part of the signed agreement; and JTBD CS-01 is
narrowed to operational activation rather than claiming a signed commercial
agreement end to end.

*The follow-up this defers, deliberately:* a pre-signature commercial-term
snapshot (Quote Version → document package → Order → Contract, with equality
validated at activation) is the correct long-term answer. It changes what is
signed, so it belongs to a Quote/Signature milestone with its own review.

**2. Classification has two dimensions, not one.** The first implementation
gave each Order Component exactly one label from
`subscription | delivery | service | other`. Annual premium support is a
recurring commercial commitment **and** a future service obligation; one label
had to drop one of them, and it dropped the subscription line — silently
removing real recurring money from the Subscription.

Classification is now two independent axes:

```js
{ commercialActivation: 'subscription' | 'non_subscription' | 'ambiguous',
  obligations: ['delivery'] | ['service'] | ['delivery','service'] | [] | 'ambiguous',
  reason }
```

Every component still becomes exactly one Contract Line. A component may
create a Subscription Line *and* an obligation, one, or neither. Either axis
may be `ambiguous`, which blocks activation until a human resolves **that
axis** with its own reason; overrides are therefore dimension-specific, and
both the policy's answer and the human's are stored per axis. The vocabulary
stays bounded — two enums and a two-element set, not a rule DSL.

**3. Nothing is `active` before it starts.** A future-dated term produced a
contract and subscription with status `active`. They are now `scheduled` until
the business date reaches `termStartDate`, and the schema, the Admin and the
guide state plainly that **nothing transitions them** — there is no scheduler.
A term that already ended is refused (`TERM_ALREADY_ENDED`) rather than
recorded as active history.

Deciding this needed a business date, so the runtime gained one more generic
capability: **an injectable application clock** (`createAgentCrmApp({ clock })`,
threaded through the action and external-operation runtimes). It names no
domain, it makes every time-dependent action reproducible in tests, and it is
the third and last addition M12 asked of the kernel.

**Also corrected:** a renewal notice period without `autoRenew` is refused
rather than stored as a clause that can never apply.

### ADR-018 addendum 3 — the public domain-package contract

**Status:** accepted (Milestone 13, the second package and the first customer-authored one).

ADR-018 said domain behavior belongs in optional packages. Milestone 12 proved
one package could exist outside the kernel. This addendum makes the seam a
**public contract**: the way a customer's own package attaches is the way the
first-party packages attach, and there is no second, privileged mechanism.

**The contract.** A package exports one static definition:

```js
definePackage({
  packageContract: 1,        // the contract it is written against
  name: 'delivery',          // canonical, unique, Map-keyed
  version: 1,                // the package's own version
  label, description,
  resources: [...],          // the record modules it owns
  requires: [{ package, capability, version }],
  capabilities: [{ name, version, description, create(ctx) }],
  actions: [...], policies: [{kind, definition}],
  metadata(),                // function-free, additive schema block
})
```

Validated fail-closed at startup: an unsupported contract version, a
non-canonical or prototype-shaped name, a duplicate package or policy identity,
a resource or capability two packages both claim, a missing or mis-versioned
dependency, a self-dependency and a dependency cycle all stop the application
with the offending edge named.

**Capabilities are the only cross-package reach.** A capability is created per
call with the **caller's** runtime handles, so it reads and writes inside the
caller's transaction while the provider keeps its services and tables private —
that is what makes a cross-package commit atomic without sharing a database
handle. A package that did not *declare* the requirement is refused even when
the capability exists: the dependency graph in the definition is the truth, not
a comment. Deep-importing another package's source is never allowed.

**A public kernel surface.** `packages/core/index.js` is what a package may
import: the package contract, the error types, the ADR-015 fingerprint helpers,
the money helpers and bounds, and the shared validators. Everything under
`packages/core/src/*` is private and may change without notice. The CLI and the
conformance helper both fail a package that reaches into it, and M12 was
migrated to the public surface in the same PR that introduced it.

**Static composition, deliberately.** Packages are checked-in source registered
by one import in `packages/domains/generated/index.js`. No dynamic import, no
`eval`, no remote install, no signing, no marketplace, no hot loading. The
security model is "you can read the source in your own repository", and adding
distribution would replace it with a different, larger problem.

**What this addendum defers, with the reason.** A `crm package new` scaffold
waits until Delivery and Service have settled the file shape — generating the
wrong skeleton into every customer repository is harder to undo than writing
four files. A package registry, publication and updates are a distribution
problem with their own threat model, and authoring does not need them.

**Consequences.** Two first-party packages and one customer-authored example
now attach through the identical contract, and `tests/custom-package-e2e.test.js`
fingerprints every kernel file before and after to prove the customer path
needs no kernel change. The extraction of M9–M11 stays deferred until a third
independent package (Service, M15) has exercised the contract.


### ADR-018 addendum 4 — what the package contract enforces, exactly

**Status:** accepted (adversarial review of Milestone 13 / PR #17).

Addendum 3 said capabilities are the only cross-package reach and that the
declaration "is the truth, not a comment". The review proved that was true only
of the polite path. Four corrections, each with a regression test:

1. **The registry's state is private.** `packages`, `policies`, `capabilities`
   and `resources` were public mutable `Map`s on the object handed to every
   package action. A package could add a capability, rewrite another package's
   `requires` and then open anything. They are now `#private`, with
   `size`, `names()` and `resources()` as frozen read-only views.

2. **`get()` returns a summary, not a definition.** It used to return the
   definition — including `capabilities[].create`. Reaching a capability you did
   not declare took one property access. It now returns a frozen public summary
   with no function on it.

3. **A capability opens only from the package the declaration named.** The
   open-time check matched on capability name and version alone; it now also
   requires `offered.package` to equal the declared `package`.

4. **`metadata()` may not restate the composition.** The declared block was
   spread *last*, so a package could publish `requires: []`, its own
   `version`, or an empty `policies` list — and `/api/schema` would disagree
   with `package inspect` silently. Reserved keys are now refused, and the
   block must be plain, function-free data (the "function-free" claim had never
   been enforced).

Two boundaries are now stated rather than implied, because they cannot be
enforced in-process and pretending otherwise is the more dangerous error:

- **The consumer identity is self-asserted.** `capability({consumer, …})` trusts
  the name. A package that deliberately impersonates another consumer is a
  trusted-source problem. Binding the identity at dispatch time is a runtime
  change, not a package-contract change, and is deferred with this written down.
- **`crm package validate|inspect` executes the package it reads.** A code-first
  definition is read by importing it. The commands themselves touch no file,
  database or network, but the package's module body runs with full authority.
  The guide now says so instead of calling them read-only.

The private-import rule was also quote-sensitive — `from "…/core/src/…"` with
double quotes passed both the CLI and the conformance helper. It now matches any
quote style and `import()`/`require()` as well.


### ADR-018 addendum 7 — the storage seam earns core ownership from two unlike consumers

Production Spine v2 M1 adds `storageContract: 1` to core as reusable runtime
machinery, not Sales or Work behavior. The proof is deliberately two-sided: the
handwritten Company service needs asynchronous mutation with synchronous exact
and paged compatibility reads, while the package-owned generated Work resources
need generated migrations, structural filters/counts, savepoint-scoped audit
mutations and managed actions. The same closed statement vocabulary serves both.

The vocabulary is insert, select/count and predicate-bound update, with equality,
null and non-empty membership predicates plus deterministic ordering and a
positive limit. Identifiers are allowlisted. Arbitrary SQL, placeholder strings,
PRAGMA, delete and unsupported predicates fail with
`STORAGE_STATEMENT_UNSUPPORTED`; the adapter never translates SQLite SQL.
SQLite alone implements the contract in M1. Its synchronous facade preserves the
released v1 exact-read surface, while mutation callers may use the asynchronous
methods. Savepoints and outer transactions remain explicit. No public command,
factory or package contract is added, so the DX surface does not grow.

Contact and Opportunity retain their existing persistence temporarily, but their
Company dependency crosses the migrated synchronous exact-read facade. A missing
Company therefore still refuses before either dependent write. M2 owns the rest
of the SQLite extraction; this addendum must not be read as repository-wide raw
driver removal or as PostgreSQL support.


### ADR-018 addendum 8 — proving the caller's transaction is core machinery, from four consumers

Production Spine v2 M2D removes the last business-consumer raw-driver reach.
`packages/work/src/follow-up.js` read the SQLite driver's `isTransaction` flag
off the module service's database handle: one boolean, bought by a business
package holding the driver, and with it every table in the application. It
survived three milestones because it was spelled with optional chaining, which a
plain token scan for the property does not see.

**Four consumers, not one.** Applying the two-consumer rule found three more
capabilities promising the same atomicity in their own doc comments with nothing
checking it, and each was measured — not reasoned about — committing a partial
write outside a transaction: `delivery-obligations@1.markHandedOver` left an
obligation marked handed over to a delivery project that would never exist and
permanently un-handoverable; `service-obligations@1.markActivated` did the same
through a different status column; and
`contracts-successor-activation@1.executeSuccession` committed a successor
commercial agreement with no lineage row, so nothing on disk said which
agreement it replaced. The primitive is core machinery because four unlike
consumers need it, and all four are migrated onto it here.

**The mechanism.** The database wrapper mints one opaque witness — a frozen
empty object — per outer transaction, beside the flag that already tracked one,
and drops it in the same `finally`. Membership lives in a module-private
`WeakSet` with no exported mutator, bound to the storage handle it was minted
for, so a boolean, a bare object, a frozen empty object of exactly the right
shape, or a genuine witness from another handle are all refused.
`proveCallerTransaction` **pulls** it from the handle the write will land on
rather than accepting one from a caller, and first compares the handles of the
services that must commit together: two services on two connections break
atomicity even inside a transaction, because they are inside two different ones.
The mint function is deliberately not public — a package that could mint could
manufacture the proof it is subject to.

**Ownership, and the two ways the mint is kept out of reach.** The witness is
published into the async context that opened the transaction, so the proof
answers "did *this* flow open it" rather than only "is one open". An earlier cut
proved only the latter, and the gap was real: flow A opens `transactionAsync`
and awaits, flow B writes inside A's transaction and loses those writes to A's
rollback. Measured both before and after; B is now refused
`NOT_TRANSACTION_OWNER`, with the cause and the fix in the message.

That makes the mint load-bearing in a way it was not before — a package that can
mint can manufacture ownership — so it is closed by **exhaustion rather than by
analysis**. `claimTransactionMinter()` yields the capability once; the database
wrapper takes it at module load, and every later caller is refused whatever
import spelling it used. Static analysis of import specifiers could never have
done this: a computed specifier walks past it, which is why the previous cut
could only document the hole. Minting, publishing into the async context and
clearing are also one indivisible operation, so no caller ever holds a witness
it could use elsewhere.

**The false refusal this buys.** Async context is lost by a callback that leaves
the transaction and is invoked later. Such a caller is refused with the boundary
named and `AsyncResource.bind` offered, rather than being told there is no
transaction while one is plainly open. The boundaries that carry context and the
one that does not are measured, not assumed.

**The assumptions that remain, and the obligation they place on M3.** The
same-handle half still assumes one connection per application instance, and the
registries are module-private, so one loaded core module instance per process.
`NESTED_TRANSACTION` is no longer load-bearing for ownership — it was what made
the gap unreachable, and the gap is closed. The
ratified PostgreSQL plan introduces connection pooling and transaction
connection affinity. **A pooled adapter must open the ownership scope around the
pooled client's work, on a connection-affine handle** — the object compared by
identity must be the pooled client bound to the active transaction, never a
pool-level facade shared across clients. This is an obligation on that milestone, not a property it inherits: an
implementation that mints at pool level would leave all four consumers silently
proving nothing, with no test failing. Recorded here rather than only in
`docs/plans/spine-v2-m2d-transaction-context.md` because that is where the
implementer will look.

### ADR-018 addendum 9 — contract v2 is a uniform package graph

Production Spine v2 M2E-1 makes the package execution contracts explicit before
an async factory can expose Promise-shaped services. Package, action, operation
and capability declarations accept the enumerated versions 1 and 2. Version 1
retains the synchronous SQLite meaning; version 2 means the consumer awaits the
corresponding execution seam. A composition may use either graph, never both:
an internal mismatch, a mixed dependency edge, or disconnected v1/v2 packages
refuse startup with `PACKAGE_ASYNC_CONTRACT_REQUIRED`.

Capability declarations gain `capabilityContract`; absence means 1 and is
normalized before any registry, schema or inspection consumer sees it. This is
the authoritative composition value. Returned capability interfaces may echo
it, but M2E-2 owns verification because composition deliberately does not invoke
factories. The old `contract-lifecycle-source@2` returned
`capabilityContract: 2` synchronously. That number was read nowhere, asserted by
no test, and the commit that introduced it explained the *domain capability*
version rather than execution semantics. It is corrected atomically to
capability contract 1; the capability's domain version remains 2.

Existing singular constants remain the v1 values emitted by scaffolding. The
accepted sets and capability default stay private to core: package authors
declare one version and do not negotiate one through a public constant. The
bundled packages remain v1 in this addendum; dual v1/v2 graphs remain a later
compatibility slice, and retiring v1 remains a separate compatibility decision.

### ADR-018 addendum 10 — public portable factory defaults to explicit empty contract-2

Production Spine v2 M2E-3 publishes `createAccordoAppAsync()` as the portable
SQLite composition contract. `createAccordoApp()` remains the characterized
synchronous factory and never returns a Promise. The two factories share no
object graph: the async path composes over 2A/2B and does not wrap, redact or
`Promise.resolve` the v1 application.

The default selected graph is an explicit `{ packageContract: 2, packages: [],
actions: [], modules: [] }`. Empty generated registries still carry no version,
so they are not read as v2. Kernel Company, Contact, Opportunity and Approval
compose on that graph. A caller-supplied selected graph still goes through
preflight: v1 and mixed graphs refuse with `PACKAGE_ASYNC_CONTRACT_REQUIRED`
before SQLite opens. The customer-authored contract-1 fixture stays
sync-compatible and fail-closed on the portable path.

PostgreSQL-shaped options refuse with `STORAGE_ADAPTER_UNAVAILABLE` before any
opener or path is created; diagnostics carry no credential.
<!-- truth: spine.postgresql.implemented=absent -->
Dual-plane Spine, identity-verifier, deployment-storage and the private
lifecycle test seams are `PORTABLE_OPTION_UNSUPPORTED` rather than silently
dropped. Default `accordo serve` and bundled package dual definitions are not
this addendum.

### ADR-018 addendum 11 — M2 public storage posture, health boundary and raw-driver exit

Production Spine v2 M2 closes on SQLite through the portable contract.

**Decision: production `GET /health` is not `app.doctor()`.** The unauthenticated
route returns only `{ ok, ready, storage: { adapter, available } }`. It does not
run request identity, read tenant services, CRM modules or business tables.
Local-development spine identity can bootstrap memberships and write audit; a
liveness probe must not. Lease-driven readiness remains M4.

**Decision: Admin counts are a separate authenticated read.** `GET /api/admin/metrics`
uses existing `records.read` and Storage Contract `kind: 'count'`. Missing
permission yields a bounded unavailable metrics state; the rest of the dashboard
still renders. No new permission and no public metrics platform. In-process
`app.doctor().counts` and the v1 `--db` `doctor.database` path stay.

**Decision: portable/document-selected public output is `{ adapter, available }`.**
`describeDeploymentStorage()` remains the named shape. `/api/schema` publishes
the same descriptor and never a filesystem path. Local `--db` MCP `crm_doctor`
may keep the v1 path; document-selected MCP projects `storage`.

**Decision: `createCoreAdapters` is application logic, not adapter-internal.**
Company-name and contact-email lookups use `database.storage.sync`. The raw
SQLite driver stays private to `packages/core/src/database.js`. A token-scan
guard over production `packages/` and `apps/` is a spelling guard, not semantic
unreachability.

**Decision: dual bundled v1/v2 package graphs are later compatibility work.**
M2-23 is proved by a representative public `createAccordoAppAsync()` child
process over kernel CRM plus a uniform v2 selected graph. Full dual graphs are
required before default `accordo serve` migrates to the async factory and before
bundled packages can compose on PostgreSQL. They are not completed here.
<!-- truth: spine.postgresql.implemented=absent -->

That later-compatibility slice is ADR-018 addendum 12.

### ADR-018 addendum 12 — dual bundled v1/v2 package graphs

Production Spine v2 M3P keeps two explicit graphs on every bundled domain
package. `createX()` remains the synchronous contract-1 object selected by
`createAccordoApp()` / SQLite compatibility. `createXV2()` /
`createX({ packageContract: 2 })` returns a distinct contract-2 object
selected by portable async composition. Shared pure policy and metadata are
reused; promise-returning execute/create wrappers are generated by
`selectPackageGraph` and never enter the v1 registry.

A mixed graph still refuses `PACKAGE_ASYNC_CONTRACT_REQUIRED` before useful
work. `createAccordoApp()` refuses every contract-2 package in
`generatedDomains` before `PackageRegistry`, so a uniform v2 list cannot
register on the synchronous factory. `crm package test` stays on `createX()`
/ contract 1. `selectPackageGraph(v2, 1)` is refused rather than cloning
async seams onto a fake v1 object. The public async factory's default empty
contract-2 graph stays empty; callers pass a uniform bundled v2 selected
graph explicitly. Default `accordo serve`, PostgreSQL application composition,
and retiring v1 remain later work.
<!-- truth: spine.postgresql.implemented=absent -->

Plan: `docs/plans/spine-v2-m2-final-posture.md`.

## ADR-019 — Safe generated-module evolution through explicit revisions and append-only named migrations

**Status:** accepted (Module Evolution v1).

A generated module could not grow. Its migration is `CREATE TABLE IF NOT EXISTS`,
so re-applying an edited manifest leaves the existing table alone; its enum
values are a SQL `CHECK` baked into that table, and SQLite has no `ALTER` for a
constraint. A record that gains a lifecycle after it ships had no upgrade path,
and the re-apply did not even fail quietly — it failed on an index for a column
the table never gained.

**Decision.**

1. **Applied migrations are immutable.** Never edited, never regenerated from a
   newer manifest, never renumbered. The runner's SHA-256 drift check stays
   exactly as strict as it was, and the create migration keeps its original
   identity forever.
2. **A schema change produces a new named migration**, appended to an ordered
   list the module exports as `migrations[]`. The registry carries the list; a
   lone `migration` from a project generated before this contract still boots.
3. **The manifest carries an explicit `revision`**, a positive integer
   defaulting to 1 for every manifest written before this ADR. It increases by
   exactly one per schema change. A changed schema at an unchanged revision, an
   unchanged schema at a bumped revision, a skipped revision and a decrease are
   each a named refusal.
4. **The previous definition lives in a checked-in state artifact**,
   `packages/modules/<name>/module.state.json`: the last generated *normalized*
   manifest, its canonical schema fingerprint, and the full migration history
   with SQL. It contains no executable code, no absolute path and no
   environment. A hand-edited state file is refused — its fingerprint and its
   per-migration checksums must match what they describe.
5. **No correctness decision relies on introspecting SQLite.** The schema knows
   a column is `TEXT` with a `CHECK`; it does not know the field was declared an
   enum, which `writable` mode it has, or whether an index was declared. It also
   makes the answer depend on which database you point at. Introspection may
   verify; it is never the semantic source.
6. **v1 supports a deliberately narrow set**: add an optional field, widen an
   enum, add a non-unique index. Everything that could lose or reinterpret
   stored data — removing or renaming a field, changing a type, narrowing an
   enum, adding a required or unique field, changing `unique`, changing a
   reference target — is refused **before any file or database write**, naming
   the field and the reason.
7. **Package-owned modules use the identical mechanism.** Nothing in it knows
   whether a module belongs to a package.
8. **A rebuild is refused while another table holds a foreign key into this
   one.** Widening an enum on a referenced table is a design decision, not an
   automatic migration. The refusal names the blocking reference.
9. **A fresh database and an upgraded one converge.** Same columns, same
   constraints, same indexes — asserted, not assumed.

**Consequences.** Enum values are now bounded (printable, at most 64
characters): they are interpolated into a `CHECK` and re-emitted by every
rebuild that constraint survives, and an unbounded value reached the schema — a
NUL byte produced DDL SQLite cannot parse. All 148 existing values already
comply. Referential integrity is verified inside every module migration's
transaction, so a migration that leaves a dangling reference rolls back rather
than being recorded as applied.

**Corrections from the adversarial review.** Three defects were found and fixed
before merge, each confirmed with a runnable probe first:

- a **table rename** was accepted and produced `ALTER TABLE <new-name>` against
  a table that was never created — every boot after that migration failed with
  "no such table". It is now refused by name;
- a **removed index declaration** was silently ignored on the `alter` path and
  silently applied on the `rebuild` path, so one manifest change had two
  outcomes. It is now one change, applied either way;
- a change to **`writable` or `default`** — real API, schema and Admin
  behaviour with no storage change — was impossible: the fingerprint demanded a
  revision, then generation refused it as pointless. It is now a first-class
  `metadata` strategy that advances the revision, regenerates the source and
  emits no migration.

The runner's integrity check was also **scoped to violations the migration
introduced**, by comparing before and after. An unscoped whole-database check
blocked innocent migrations on inherited violations, leaving such a database
permanently unupgradable.

Verified rather than assumed: a `reference` column added by `ALTER TABLE ADD
COLUMN` **is** enforced — `PRAGMA foreign_key_list` records it and a dangling
value is refused — so reference addition needs no rebuild.

**This is not an ORM, and not a general schema-diff tool.** There is no data
transformation, no default backfill, no arbitrary SQL hook, no field split or
merge, no table rename and no dependent-table migration. It is a narrow additive
upgrade path, and it says no to everything else.

### ADR-019 Addendum 1 — Adoption: what happens to modules generated before this ADR

Found while building M14a, on a project built with the M13 merge commit's own
CLI and then upgraded in place.

Point 4 above put the previous definition in `module.state.json`. Every module
generated before this ADR has no such file, and the factory read that as "never
generated": it planned every file as a `create`, and the apply refused with
"Module files already exist … refusing to overwrite". So the one case module
evolution exists for — a shipped record that gains a lifecycle — was the one
case it could not serve. Every pre-ADR-019 module was frozen at revision 1.

Point 2 said a lone `migration` from a project generated before this contract
still boots. It did, until anything was applied: applying any module regenerates
the shared registry for **every** installed module, and the regenerated file
named-imported the `<camel>Migrations` array that older modules do not export,
so one upgrade stopped the whole application from loading.

**Decision.** A module with a manifest and generated source but no state file is
**adopted**: its revision 1 is reconstructed from what is on disk, and evolution
proceeds normally from there. Adoption verifies rather than assumes — the
manifest is accepted as the previous definition only if regenerating its create
migration reproduces the migration the module actually generated, name and every
SQL line, so the checksum recorded in every existing database stays valid. The
apply writes the state file, so a module is adopted at most once.

It refuses, rather than guessing, three cases: a manifest edited without being
applied (the next evolution would diff against a schema no database ran), a
missing `src/migration.js` (what ran is then unknown), and a module already past
revision 1 whose state file was lost (revisions 2… cannot be reconstructed from
the current manifest — version control is the answer).

The generated registry now reads a module's migrations through a namespace
import that accepts either shape, so upgrading the framework never requires
regenerating modules that did not change.

Adoption is generic. It names no domain, and nothing in it knows that Delivery
was the milestone that needed it first.

### ADR-019 Addendum 2 — Additive stateVersion 2 and PostgreSQL bootstrap

Spine v2 M3A. v1 `{name, checksum, sql}` SQLite history stays the authority for
every database that already ran it. Writes emit `stateVersion: 2` with a
`postgres.bootstrap` generated from the **current** normalized manifest, used
only on an empty PostgreSQL data plane, with its own checksum and provenance
pointing at the v1-style state fingerprint. Later dialect-specific evolutions
append under `postgres.evolutions`. Reads still accept v1.

A generated registry entry that predates `module.state.json` remains a
supported legacy input. Adoption is an explicit source-authoring step through
the existing module-evolution authority (`module create --apply`, or
`adoptLegacyModuleState` for fixtures). Runtime PostgreSQL composition refuses
`LEGACY_MODULE_STATE_REQUIRED` until that state is checked in. It never
synthesizes or writes source state during deployment. A non-empty data plane
and a bootstrap the current manifest cannot reproduce also refuse.

No new CLI command. The existing apply is the authoring write.

## ADR-020 — A Solution Plan is a bounded document contract, never an executable one

**Status:** accepted (AX2).

AX1 gave a project one deterministic answer to *what has this application
composed*. The next question an agent must answer — *what are you going to do
about it, and on what evidence* — had no shape at all. The
`solve-business-goal` Skill asked for a Solution Plan with sixteen named parts,
and every agent wrote it differently: different section names, different order,
different words for "we do not know". A human could not diff two of them, a
second agent could not read one, and nothing could tell whether the application
a plan was written against was still the application in front of the reader.

The obvious answer — a workflow or DAG format with typed steps and effects —
was rejected, and the reason is the whole decision. A format expressive enough
to describe execution invites a runtime, and the first runtime that reads a plan
is one source edit away from applying it. The framework already refuses an
expression language over money for the same reason; a plan that can carry
commands is the same mistake wearing a different name.

**Decision.**

1. **A plan is a document with a contract**, `solutionPlanContract: 1`, carrying
   its own `revision` and a SHA-256 `fingerprint` over canonical bytes — keys
   sorted at every depth — so two plans that say the same thing hash the same
   and a silent edit cannot hide.
2. **It cannot carry executable content.** A step names a decision type and the
   seam it uses. A shell command, a command substitution, a chained invocation,
   a remote address or a script tag anywhere in the document is refused
   (`PLAN_EXECUTABLE_CONTENT`). This is enforced by the validator, not stated as
   a convention.
3. **Every classification a reader acts on is a closed vocabulary**: six
   decision types mapped to the repository's own decision hierarchy, six
   evidence categories, eleven approval codes, and a fixed problem-code list.
   An unknown value is refused; an invented evidence category is refused; a
   *missing* evidence category is a problem too, because an omitted gap is a
   claim.
4. **Rung 5 is not a step.** `propose-kernel-capability` exists as a decision
   type so a plan can state it, and is refused in `steps[]`
   (`PLAN_DECISION_NOT_A_STEP`). Patching the kernel to make a solution fit is
   precisely what the hierarchy exists to prevent, and a format that lets a plan
   schedule it as work has conceded the point.
5. **Derived claims cite their evidence.** Every derived metric, inference and
   recommendation names the ids it follows from, and every citation must
   resolve — forward or backward, because order in the file does not decide
   validity.
6. **A plan is bound to a real AX1 report.** `accordo solution check` re-runs the
   inspection and reports `PLAN_STALE` naming the specific difference — a
   package version, a capability that stopped resolving, a record revision — and
   `CAPABILITY_NOT_AVAILABLE` for a step that needs something this application
   does not have. A plan whose premises have changed is not a plan.
7. **Exit codes mirror AX1's**: `0` valid, `1` problems with the complete list
   still printed, `2` unreadable. `validate` reads no project at all, so a plan
   can be checked in CI, in review, or against a repository that is not the one
   it targets.
8. **Approval is a human-actor boundary, not RBAC**, and every plan carries that
   limitation along with `PLAN_NOT_EXECUTED`, `EVIDENCE_NOT_VERIFIED` and
   `BINDING_IS_SOURCE_ONLY`, whether or not its author wrote them.

**Consequences.** The framework gains no planner and no runtime, and gains no
ability to act on a plan. It gains the ability to say, mechanically, that a plan
is well-formed, honestly cited, correctly scoped against the decision hierarchy,
and current against the application it claims to describe. Producing a plan
remains the agent's job; checking one is now the framework's.

This is a document contract in `packages/core`, reachable from the CLI. It
knows no domain: nothing in it mentions leads, contracts, delivery or any
record this repository ships.

### ADR-020 addendum 1 — the composition binding is derived, and citations have a direction

The adversarial review of PR #24 found two places where the contract looked
stronger than it was.

**A `compositionFingerprint` the author typed.** The plan carried a free-text
field in a slot that reads as cryptographic evidence of the application it was
written against — the shipped example held the string
`example-only-not-a-real-composition`. A label that looks like a hash is worse
than no hash: a reader trusts it, and it proves nothing.

It is replaced by `inspectionFingerprint`, a SHA-256 over the canonical AX1
report, derived by `inspectionFingerprint(report)` and recomputed by
`accordo solution check` from the live project. `validate` refuses anything that is
not a 64-character hex digest, so a label cannot occupy the slot at all, and
`check --json` publishes the live value so an author can record it honestly.

It covers package identities and versions, capability requires/provides and
resolution, resources, declared action metadata, policy and provider identities
with their ADR-015 fingerprints, record revisions and migration checksums, and
the problems and limitations that bound what may be planned. It excludes labels,
descriptions, hints, routes, absolute paths, timestamps, config values, database
state and runtime status.

What it is: a **drift detector** over the whole composition, catching changes no
plan's own evidence lists mention. What it is **not**, stated in the same
breath: proof of authorship, authorization or correctness.

**Citations that resolved but had no direction.** Any evidence entry could cite
any other, so an observed fact could rest on a recommendation, a recommendation
could rest entirely on unavailable evidence, and two entries could cite each
other. Each is a way to launder a conclusion into looking like a premise, and
the validator accepted all three.

Citations now follow a table that is a DAG over categories — facts, assumptions
and unavailable evidence cite nothing; derived metrics cite facts and
assumptions; inferences add derived metrics; recommendations add inferences — so
the graph is **acyclic by construction** rather than by a traversal somebody has
to maintain. A citation list is a set, and a repeated id is refused rather than
deduplicated.

**Two smaller corrections in the same review.** Unknown keys are refused at
every level rather than ignored (`PLAN_FIELD_UNKNOWN`): silently dropping a key
means the plan claims something its reader never sees, and the fingerprint —
computed over the *normalized* document — would not cover it. And a decision at
rung 3 or above must record every lower rung as inspected, with a reason per
rung and the capability gap; the first draft accepted a `create-package`
decision from an author who never looked at rung 1, which is precisely how a
domain that already exists gets duplicated.

## ADR-021 — An extracted domain reaches its consumers through a declared capability, never an ambient field

**Status:** accepted. Not implemented — this decides the contract, not the
schedule. Measurement: `docs/architecture/EXTRACTION_PREPARATION.md` (Blocker 2)
and the LA0 observation `architecture.app-intelligence-consumers`. Target shape:
`docs/architecture/INTELLIGENCE_PACKAGE_TARGET.md`.

Lead Intelligence publishes its registries as `app.intelligence`, a field on the
application object that the action runtime injects into every action's context.
It predates the domain package seam (ADR-018) by four milestones and it works.
It is also the single reason Intelligence cannot become a package without
deciding something first: ADR-018's whole claim is that a dependency you cannot
see is a dependency you cannot reason about, and an ambient field is a
dependency nobody declares.

**Ambient (status quo)** costs nothing and is a permanent exception to ADR-018:
the package's interface stays reachable without declaring it, so `requires`
stops being the whole truth, and a custom package could never obtain the same
privilege — contradicting the equality `docs/PACKAGE_AUTHORING.md` §14 promises
between first-party and customer packages.

**A generic named-service registry** — packages register services, the runtime
resolves them into the context by name — is **rejected**. It is a new generic
seam with one consumer, which this repository's own rule refuses, and it does
not buy the property it costs: an action would still reach a package it never
declared, which is ambient access under a new name. It becomes reconsiderable
only when two real packages need runtime resolution that capabilities cannot
express; one imagined case is not evidence.

**Decision: a declared capability.** Intelligence offers `intelligence@1`; a
consumer declares it in `requires` and opens it with `domains.capability(...)`,
exactly as Delivery opens Contract Activation's `delivery-obligations@1` today.

1. **Identity and version.** The capability is `intelligence@1`. Its version is
   the capability's own, independent of the package version, and moves under
   ADR-018's additive rule: new members are a minor concern, a removed or
   narrowed member is a new major. The four registries reachable through it —
   enrichment providers, scoring models, routing policies, routing targets —
   are the members, and each keeps the accessor names it has today.
2. **Runtime resolution.** Resolution happens at composition time, not at call
   time. The package registry already refuses a composition whose declared
   `requires` does not resolve, so a missing capability is a startup failure
   naming the consumer, not an `undefined` discovered inside an action.
3. **Package absence.** A project that has not composed Intelligence has no
   provider for `intelligence@1`. If nothing requires it, the project boots and
   the domain is simply absent. If something requires it, the registry refuses
   at startup and says which package asked. Absence is never a silent
   `undefined`.
4. **Action-context access.** Actions reach it through the capability they
   declare, not through an ambient context key. The measurement is what makes
   this cheap: the ambient key is handed to every action and read by **no**
   action outside Intelligence's own four, which move into the package anyway.
5. **AX1 representation.** The dependency becomes an edge `accordo app inspect`
   reports, a Solution Plan can cite and bind, and `crm package test` enforces.
   The fixed `intelligence` composition slot is retired in favour of ordinary
   package discovery; see `INTELLIGENCE_PACKAGE_TARGET.md`.
6. **Custom-package parity.** A customer package obtains `intelligence@1` by
   declaring it, with no privilege a first-party package has and it lacks. This
   is the property the ambient field cannot offer at all, and the reason the
   decision is not merely tidiness.
7. **Compatibility bridge.** During the migration the package offers the
   capability **while** `app.intelligence` still exists, and both work. The
   bridge is explicitly temporary and must not survive the final head of the
   extraction: a legacy fallback left in place is the ambient field wearing a
   deprecation notice.
8. **Removal gate for `app.intelligence`.** The field may be removed only when
   all four hold: no source file reads it, proved by the code-level scanner
   rather than a substring search; `/api/schema` publishes the block as the
   package's own contribution; the LA0 baseline shows no asserted observation
   moved; and the compatibility bridge is deleted in the same change that
   removes the field.

**Consequences.** The framework gains no mechanism. The last invisible
dependency in the oldest domain becomes visible, and the rule that first-party
packages get no privilege a customer package cannot have stops having an
exception. The cost is a migration whose every step shows up in a diff, which
is the point rather than a drawback.

## ADR-022 — Extracted definition kinds reuse existing contracts; routing targets are declared configuration; no new registry seam

**Status:** accepted. Not implemented. Measurement:
`docs/architecture/EXTRACTION_PREPARATION.md` (Blocker 3) and the LA0
observation `architecture.definition-registry-slot`.

`packages/intelligence/generated/index.js` is a checked-in, project-owned file
where a project declares enrichment providers, scoring models, routing policies
and routing targets. AX1 reads it as one of a fixed set of composition slots. If
Intelligence becomes a package, that file is a *project* file describing a
*package's* definition kinds, and no generic seam covers it.

The temptation is to build one. The measurement argues against it: **two**
runtime dependants (`packages/app/src/create-app.js`, which constructs the
registries, and `packages/cli/src/app-inspect.js`, which holds the fixed slot),
and three of the four definition kinds already have a contract that fits.

**Decision.** Express the extracted definitions with the contracts that already
exist, and add no generic package-contributed definition-registry seam.

1. **Enrichment providers use the provider contract.** Unchanged in shape,
   already inspected by AX1 and enforced by DX4.
2. **Scoring models and routing policies use `policies`.** Already versioned,
   already fingerprinted (ADR-015), already the shape Commercial Operations
   ships for discount policies. Identity, version, fingerprint and declared
   `config` are preserved exactly; a definition whose fingerprint moved is a
   behaviour change, and LA0 fails on it.
3. **Routing targets are declared configuration of the routing capability**,
   not a new definition kind and not a managed resource. This was the open
   question in the proposed version; it is closed on evidence, inventoried
   below.
4. **No generic definition-registry seam.** If, after Intelligence is extracted,
   a *second* package needs a project-owned registry the existing contracts
   cannot express, that is the evidence a generic seam requires — and it will be
   a better seam for having two real cases instead of one imagined one.

### Why routing targets are configuration and not a resource

The human rule is that static, source-defined routing configuration belongs to
routing-policy configuration, and independently mutable operational data
belongs in a package-owned managed resource. Which one a routing target is was
settled by reading the runtime, not by preference:

| Question | What the code says |
|---|---|
| How is a target defined? | declared in checked-in source and validated at startup — `key`, `label`, `kind`, `active`, `countries`, `languages`, `skills`, `capacity`, `priority`, `scoreMin/scoreMax` |
| Is it mutable at runtime? | **no.** The registry Map is populated once at construction from the declared definitions. There is no register, create, update or delete path |
| Does it have a table or a module manifest? | **no.** It is not a record; there is no migration, no row and no revision |
| Can it be queried or edited through the API? | **no.** No route, no module, no CRUD. It is published read-only as schema metadata |
| What does `capacity` mean? | a declared **ceiling**, not a counter. The mutable half — `currentLoad` — is computed at decision time by an exact indexed count of active leads, so the number that changes lives on Lead records, not on the target |
| Is it versioned? | not per target. The **set** is fingerprinted and that fingerprint is recorded on every RoutingRun, so drift is already visible and explainable |

Nothing about a target is independently mutable, so the managed-resource
branch of the rule does not apply. It is source-defined configuration that the
routing capability reads, and it stays that — carried as the package's declared
configuration, **keeping the existing separate target-set fingerprint** so no
recorded routing decision changes meaning.

**When this would be revisited.** If a customer needs targets that operations
can change without a deploy — a rep toggling their own availability, a queue
opened for a week — that is a genuinely different requirement, and it is the
managed-resource branch. It is a new capability with its own evidence, not a
reinterpretation of this one, and it does not become a generic registry seam
either.

**Consequences.** No new seam, no new versioning story, no new answer needed for
"what if two packages claim one definition kind", and no new AX1 representation
to design. Every recorded routing decision keeps the fingerprints that make it
explainable.

## ADR-023 — MIT is confirmed as the licence, before any distribution manifest asserts it

**Decision.** The framework ships under MIT, confirmed rather than assumed. `site/brand.json`
moves `license.status` to `confirmed`, which is what `scripts/distribution-check.js` reads before
it will let a plugin manifest, a marketplace entry or a registry record state a licence to a
third party.

**Why it needed an ADR at all.** MIT has been the repository's licence since Milestone 0, so
nothing about the file changes. What changes is the *kind of statement* being made.
`docs/strategy/MASTER_PLAN.md` §10.2 reserved the final confirmation as an explicit human
decision, and three distribution manifests already carry a `license` field. A licence in a
manifest is an assertion to a marketplace and to everyone who installs from it — not a
description of the working tree — so the check refuses to let an unconfirmed one out. Choosing
the public name is what made that refusal binding, because it is the point at which publication
stops being hypothetical.

**Why MIT and not a source-available or copyleft licence.** The positioning depends on it.
`docs/strategy/CATEGORY.md` differentiates structurally, not rhetorically, on ownership: the
customer's application must run without us, with no share-alike obligation reaching their
product and no enterprise-gated files in the tree. A copyleft core would make the central claim —
*"if the vendor disappears tomorrow you keep an application you own"* — materially weaker than
the alternative it is drawn against, and a source-available licence would make it false. The
licence is load-bearing for the strategy, which is exactly why it could not be left implicit.

**What this does not decide.** Nothing about a future managed offering, and nothing about the
licence of anything a customer generates — generated code belongs to the customer under whatever
terms they choose, which is the point of generating it.

## ADR-024 — The build benchmark splits into a runnable Edition L and a blocked Edition D, scored in points

**Status:** accepted.

**Context.** `docs/strategy/CRM_BUILD_BENCHMARK.md` defines six gates, of which
two — G5 (deployed smoke check) and G6 (trace/audit inspectable on a deployed
instance) — require a public deployment. This framework has no authentication,
tenancy or RBAC, and `accordo app inspect` reports `productionPosture: "local
development only"`. Running G5 and G6 honestly would mean exposing an
unauthenticated CRM on the public internet in order to earn 25 points, which is
not a benchmark result — it is a security incident with a score attached.

So the benchmark as written could not be run, and the pressure was to run four of
the six gates and publish the number. That is the decision this ADR exists to
refuse.

**Decision.**

1. **Two named editions, and the names are published together.** Edition L is
   G1–G4, scored locally today by `benchmarks/harness/score.js`. Edition D is
   G5–G6, **blocked on the Production Spine**. Every scored run carries
   `editionD: { outcome: "BLOCKED_NO_PRODUCTION_SPINE" }` with the reason in
   full. G5 and G6 are not run, not estimated, and never quietly dropped — a
   report that omitted them would read exactly like a report that passed them.
2. **Points out of 75, never a percentage, and never renormalised.** The four
   local gates keep their protocol weights (25 / 15 / 25 / 10). Renormalising to
   100 yields 33.3 / 20 / 33.3 / 13.3 — a rounding convention nobody remembers
   attached to a figure that reads like a success rate. A point total out of a
   stated maximum cannot be mistaken for one. It also means the result never has
   to slip past the published-percentage guard in `scripts/site-check.js`;
   routing around that guard would weaken it in spirit even where the regex would
   not have noticed.
3. **Three outcomes per gate, and only one of them earns.** `pass`, `fail` or
   `needs-operator`. A gate the instrument cannot judge is never a pass, and a run
   with any `needs-operator` gate is `scoreable: false` and enters no aggregate.
   The alternative — treating an unjudgeable gate as a pass to keep runs
   scoreable — manufactures exactly the number nobody can defend.
4. **The per-prompt verdict is binary and stays separate from the point total.**
   All four gates must pass. A run scoring 65 of 75 that misses G3 is a **failed
   prompt**, and the two figures are never substituted for one another.
5. **G1 is read from an append-only operator record, not measured.** Whether a
   human edited a file is witnessed only by the operator, so `benchmarks/harness/record.js`
   writes interventions and approvals as they happen — an intervention costs G1's
   25 points and the tool says so at the moment of recording, not at scoring time.
   Zero interventions passes, one or more fails, and **no record at all is
   `needs-operator`**, not a free 25 points. Making G1 permanently unjudgeable
   would reproduce, one layer down, the exact structural zero that Edition L
   exists to remove — and it would do it quietly.
6. **SABR and TTFW are Edition D metrics and may not be computed from Edition L.**
   SABR counts *fully successful* prompts against six gates; with two unrunnable,
   an Edition-L SABR is not a smaller SABR but a different metric wearing the same
   name. TTFW is measured to a deployed smoke check that does not exist. Edition L
   publishes a **prompt-pass count over a stated denominator** and nothing else.

**Provenance is enforced at preparation, not asked for at publication.**
`benchmarks/harness/prepare.js` refuses a run with no `--agent` and `--model`
(a default would silently pool results from different models), refuses a dirty
tree unless `--allow-dirty` stamps `treeDirty: true` into the record, refuses a
run directory inside the framework checkout (which would dirty the very tree the
run's SHA claims to describe), and refuses to write into a directory that already
holds a run. The run id is derived — `<promptId>-<sha>-<attempt>` — so two
operators on two machines name the same run the same thing.

**What would retire this ADR.** Edition D becomes runnable when the Production
Spine lands: authentication, tenancy and RBAC, at which point `app inspect` stops
reporting `local development only`. At that point G5 and G6 are run, the six-gate
protocol is whole again, SABR and TTFW recover their definitions, and the edition
split is retired rather than reinterpreted. Nothing about Edition L's scoring is
changed retroactively; old runs keep saying what they said.

**What this does not decide.** Nothing about the comparison arms (Twenty, Frappe,
from-scratch), which need the same instrument pointed at a different subject and
have their own reinterpretation problem for G1–G4 over a configured product. And
nothing about publication: which sentences an Edition L result licenses is
`docs/marketing/BENCHMARK_PUBLICATION.md`, deliberately a separate document with
a separate gate.

## ADR-025 — Host the existing Docs MCP through one stateless HTTP adapter

**Status:** accepted for implementation. Production promotion and directory
submission remain human decisions.

**Context.** `packages/docs-mcp` already owns three read-only tools and the
structural rule that no capability or CRM-job status leaves without its
limitation. It runs only over stdio, which means a stranger must clone the
repository and launch a child process before an agent can query it. The reviewed
Anthropic/OpenAI discovery surfaces require a remote MCP endpoint, while the
project MCP cannot be hosted safely before authentication, tenancy and RBAC.

**Decision.** Add a Web `Request -> Response` adapter around
`createDocsMcpServer`, deployed as a Node/Fluid Compute Vercel Function beside
the existing static site. It is stateless, adds no tool and no dependency, and
uses the same server instance contract as stdio. Modern MCP routing headers,
Origin, content negotiation and request size are validated at the HTTP boundary;
the body remains the source of truth. Runtime-read Markdown and ledgers are
explicitly included in the Function bundle and ExecPlans explicitly excluded.

No-auth is deliberate for this public, read-only surface. It contains only
bytes already public on the site/repository, opens no database, calls no provider
and persists no request. Authentication would reduce discoverability without
protecting a non-public resource. Adding any private resource, persistence,
telemetry or write tool reopens this decision and requires authorization before
deployment.

**Rejected:** a second SDK-based server, because its tool/claim contract could
drift; and a persistent proxy around the stdio process, because it introduces
process/session state that modern MCP removed and does not fit request-based
Functions.

**Consequences.** One remote URL can serve Claude, OpenAI and any conforming MCP
client without broadening the CRM production claim. Vercel becomes a hosting
subprocessor for ordinary HTTP/function metadata, stated on the public privacy
page. A preview proves code and bundle; only a human may promote the endpoint or
submit it to a directory.

**Adversarial-review addendum (2026-08-09).** The canonical build may replace
only its own ignored generated directory. A caller-selected assembler output
must not exist, nor may its staging sibling, so a test/helper invocation cannot
erase an occupied external directory. HTTP content negotiation counts a media
type only when its quality is greater than zero; `text/event-stream;q=0` is a
406, not permission to return a response the client refused. Regression tests
hold both boundaries and also exercise the post-read body-size check against a
lying `Content-Length`.
## ADR-026 — The npm bootstrap is assembled from declared source and staged through trusted publishing

**Status:** accepted.

**Context.** `packages/create-accordo` can create a runnable project from this
repository, but npm packages cannot include files outside their package root.
Publishing that directory directly would therefore ship a working executable
beside no framework source; the command would load and then correctly refuse
with `FRAMEWORK_SOURCE_UNAVAILABLE`. Adding a `files` array does not cross the
package-root boundary. Checking a second copy of the framework into the package
would solve the tarball and create a permanent source-drift problem.

**Decision.** The checked-in `packages/create-accordo/package.json` remains
`private: true`. A maintainer-only, dry-run-by-default assembler creates a new
publication directory from two explicit inputs: the bootstrap package files and
the same declared framework inventory the bootstrap already fingerprints. The
framework is placed under `framework/`; installed code checks that bundled
location before retaining the repository-ancestor fallback. The assembler
reports a versioned contract and a content fingerprint, refuses a non-empty
target, canonicalizes parent symlinks before enforcing the outside-source
boundary, writes through a unique staging directory and commits with one rename.
No generated framework copy is checked in.

The publication manifest is generated from an allow-list, not inherited by
spreading the private development manifest. It has no dependencies or install
scripts, carries the exact public repository URL required by npm provenance,
and exposes only the `create-accordo` bin. Every allow-listed input must be a
regular file; the assembler refuses symlinks rather than following them into a
signed tarball. Tests pack the assembled directory
twice, require byte-identical archives, install one into an empty npm project,
run the installed bin and run the resulting project's inspect, doctor, tests
and smoke. A tarball that merely contains plausible paths is not evidence.

**Release boundary.** Source never publishes directly. A manually triggered
GitHub Actions workflow on a GitHub-hosted runner assembles and re-verifies the
candidate, then uses npm trusted publishing through OIDC. It stages rather than
publishes the version: CI may prepare a release, but a maintainer reviews and
approves the staged package with 2FA before it becomes public. No long-lived npm
write token is stored. Every action in that release workflow is pinned to a full
commit SHA because it shares the OIDC trust boundary. Trusted-publisher
configuration on npm must name the
exact workflow and allow staged publication; repository source cannot prove
that external setting, so it remains a published limitation until a live
receipt exists.

**Why this is not another user-facing command.** The failure being prevented is
a maintainer publishing an incomplete tarball, not a coding agent lacking a
project operation. The assembler is absent from generated projects, skills,
MCP and the `accordo` CLI. End users still learn exactly one install line after
the registry version is verified.

**Consequences.** The repository can prove a publishable artifact before the
registry changes, while `site/brand.json` continues to say `names-reserved` and
public copy continues to refuse `npm create accordo`. The eventual registry
receipt, not a merge or a green pack test, is what authorizes changing that
status. The generated application remains local-only, SQLite-only and without
authentication, tenancy or RBAC; packaging changes none of those boundaries.

## ADR-027 — A public number is measured into one provenance-checked record, never typed into copy

**Status:** accepted.

**Context.** `site/claims.json` publishes a `measuredAgainst` block — a commit, a date,
a test count — and `scripts/site-check.js` is the gate that decides whether the public
surfaces may stand. Two things about that arrangement were not holding.

The first was provenance. The gate asked `git cat-file -e <sha>^{commit}`: *does an
object with this id exist here*. That answers the wrong question twice over. A commit
pushed to an unrelated branch exists in the same object store, so a measurement taken on
a line of development the shipping code does not descend from passed. And under
`actions/checkout`'s default `fetch-depth: 1`, no commit but `HEAD` has been fetched, so
every honest historical measurement failed with *"is not a commit in this repository"* —
about a commit that plainly is one. Three open pull requests were red for that reason and
none of them had done anything wrong.

The second was the count itself. An exact number appeared in stable public copy: the
`C-20` claim sentence, two README lines, two published answers, a concepts page, and two
marketing documents. Every one of them was a copy of a number that moves on every merge,
and the gate that was supposed to bind them checked two of the eight. They drifted anyway
— 373, 411, 701 and 793 were all being asserted in the same tree.

**Decision.**

1. **Ancestry, not existence.** `scripts/measurement.js` separates three outcomes with
   three messages: the SHA is *missing* from this repository; the SHA *exists but is not
   an ancestor* of HEAD, which is refused because object existence is not provenance; or
   the SHA is a genuine ancestor whose *recorded facts do not match the tree it names*.

2. **Fail closed when the checkout cannot know.** A shallow clone cannot tell "that
   commit was never here" from "the connecting history was not fetched", and a tree with
   no `.git` cannot tell anything. Both report *history unavailable* and fail, rather than
   passing quietly the way the old code did when `git` returned nothing. The
   `public-claims` CI job therefore checks out with `fetch-depth: 0`; a targeted fetch of
   the single SHA would not do, because `merge-base --is-ancestor` needs the commits
   between the two, not the named one.

3. **The record carries a fingerprint of what it measured.** `measuredAgainst` gains
   `testFiles` and `testsTree` — the count of `*.test.js` files and the git tree id of
   `tests/` at that commit. Both are checked against the commit. This is what gives the
   third outcome teeth: the cheapest way to make a stale ledger go green is to move the
   SHA forward and leave the numbers alone, and that now fails. `claimsContract` moves to
   `2` because those two fields are required.

4. **One number, measured, never typed.** An exact test count may appear only in
   `measuredAgainst`, and reaches a page through the `{{measured.tests}}` token that
   `scripts/site-build.js` resolves — the same rule the brand name already lives under.
   Copy that cannot carry a token states what the verification gate proves instead of how
   many tests it ran. `scripts/site-check.js` fails on a literal count anywhere in the
   README, the ledger's own prose, the site's JSON sources, the templates or
   `docs/marketing/`. `node scripts/measure-suite.js --apply` writes the record from a
   real run on a clean tree, so the number is never hand-entered.

**Why not keep the count in stable copy and couple it harder (the status quo).** That was
the status quo, and it made every merge that adds a test an eight-file edit whose only
enforcement was on two of the eight. Coupling copies is not how copies stop drifting.

**Why not generate the count into every surface.** Generation works where a build step
already runs — the site templates and `llms.txt` do exactly this, and they keep their
number. It does not reach a README, a marketing document or `/answers.json` served raw to
a machine, and adding a build step to those to publish a number that measures effort
rather than correctness buys the reader nothing. Those surfaces say what the gate proves.

**What this does not decide.** Nothing about *whether* to publish a count at all: the
number remains on the landing page and in the evidence page, resolved from the record. And
nothing about re-measuring on every merge — a record that names its own ancestor commit
and proves it is truthful when the suite has since moved, so drift is reported as a note
rather than failing the build. What would be untruthful is a *sentence* quoting a stale
number as current, and that is now impossible to write.

### ADR-027 addendum 1 — the same rule, turned on the repository's own status file

**Status:** accepted.

**Context.** ADR-027 stopped a *public* number drifting and left the *internal* one
alone. `docs/PROJECT_STATUS.md` kept a `Main SHA at generation` row and a
`Tests on clean main` row — a second measurement of the fact the ledger already owned,
hand-typed, in the one file `AGENTS.md` §12 orders every agent to read for what is true
today. A test pinned both literals in place, so the only way to update the document was
to update the test, and across four milestones nobody did. The most-trusted document in
the repository was also its most confidently wrong one.

Then the failure ADR-027 was written to close happened anyway, one level up. A branch
re-measured `site/claims.json` honestly; the merge that brought it to `main` resolved the
`measuredAgainst` conflict in favour of `main`'s older block. The re-measurement was
destroyed by a merge rather than by an edit, and the ledger ran a whole wave behind the
suite with every gate green. Nothing was broken: the recorded commit really was an
ancestor, and its recorded facts really did match the tree it named. Provenance was
intact. What was missing was any *second party* to the fact — anything else in the
repository that had to agree with it.

**Decision.**

1. **The status file cites; it does not measure.** `docs/PROJECT_STATUS.md` states no test
   count at all, and carries exactly one `Measured at` row repeating
   `site/claims.json` `measuredAgainst.sha`. `inspectStatusMeasurement`
   (`scripts/measurement.js`) fails the build when the two strings differ, when the row is
   missing, or when there is more than one of it.

2. **The loose-count scan covers `docs/`.** ADR-027 §4 scanned the README, the ledger's
   own prose, the site's JSON sources, the templates and `docs/marketing/`. It now scans
   every document under `docs/`, plus `AGENTS.md` and `TASKS.md`, minus one short named
   list — `DATED_HISTORY` — of documents whose numbers are *stamps* rather than *claims*:
   `docs/plans/` (an ExecPlan records what a run measured, at a commit it names),
   `docs/RENAME_SURFACE.md` (a dated experiment's observed result) and the two strategy
   documents that open with "Written against `HEAD` on <date> with N tests passing".
   Rewriting those would be falsifying history to satisfy a linter. The list is short on
   purpose: a new document is scanned by default, and adding to it is a reviewable edit
   with an argument attached.

3. **Two false positives had to be fixed before the widening was possible.** `\b` matches
   inside a hyphenated identifier and after a currency symbol, so "the ADR-018 test for
   what core owns" read as a count of 18 and "a €500 test on conversion" as a count of 500.
   A measured count is never written immediately after a hyphen or a currency symbol, so
   both prefixes are excluded. Each is pinned by a fixture in
   `tests/repository-truth.test.js`, because a gate nobody has watched fail is a gate
   nobody should trust.

4. **No second mechanism, and no new command.** Both rules live in
   `scripts/measurement.js` beside the provenance check and run inside
   `npm run gtm:check`. There is no `accordo status`, no new namespace, and nothing added
   to `npm run surface:check`'s budget. Neither rule reads prose: one compares two literal
   strings, the other matches a numeric pattern. A status file can be wrong in every other
   row and still pass — documentation truthfulness stays a human review category
   (`docs/QUALITY_GATES.md` §2 and §6).

**Why not regenerate `PROJECT_STATUS.md` from `git` and the GitHub API.** Because the
honest half of that file is prose a generator cannot write — which limitation is closed,
what a receipt actually describes, why a row is stale — and a generator that emits the
easy rows encourages a reader to trust the hard ones. The tool is still worth building and
is still recorded as deferred in `docs/PROJECT_STATUS.md` → "Future automation". This
addendum takes only the part that is a mechanical fact: two strings that must be equal.

**Why not fail the build when the test corpus moves after a measurement.** That would
block every pull request that adds a test until it re-ran an eleven-minute suite, and the
existing behaviour is already correct: a record that names its own ancestor commit is
truthful even when the suite has since moved, so the drift is a note. What must not exist
is a *sentence* quoting a stale number as current — and after this addendum there is
nowhere under `docs/` left to write one.

**What this does not decide.** Nothing about the *rest* of `PROJECT_STATUS.md`. The merged
milestone, the open-PR row and the CI row are still reconciled by a person — the final
integrator of a wave, under `docs/QUALITY_GATES.md` §1.11 — and a robust mechanical check
on them would need a source of truth this repository does not have offline. That residual
is named in `docs/QUALITY_GATES.md` §6 rather than left implicit.

## ADR-028 — Calendar-date validation is a core runtime primitive; a capability whose answers change shape gets a new version

**Status:** accepted.

**Context.** Two things surfaced in the M16a post-merge audit, and they are the same
thing seen twice: a rule that is *stated in more than one place* eventually disagrees
with itself, and a rule that is *implied* eventually answers a question nobody asked it.

The first was calendar dates. A commercial term boundary, a delivery window, a coverage
start and a renewal `asOf` are all `YYYY-MM-DD`, and none of them is an instant.
`Date.parse('2027-02-30T00:00:00.000Z')` does not fail — JavaScript rolls it to March 2 —
so shape alone accepts days that never existed. The round-trip rule that refuses them was
correct, and had been independently re-implemented in **four** packages: `contracts`,
`delivery`, `service` and `lifecycle`. Where a package applied it partially, the damage
was not cosmetic: M16a stored an `asOfDate` naming a day nobody could have decided
anything on, beside a `daysToBoundary` measured from a *different* day, and against a real
database two contradicting decisions persisted for the same real day under two keys —
defeating that package's own "one decision per contract per date" promise.

The second was term provenance. `contract-lifecycle-source@1` answered `signed` from a
classification map and returned `false` for any `termsSource` the map did not name. That
is safe for one odd row and unsafe as a rule: the day M12 gains a source nobody has
classified, every contract carrying it is reported as unsigned — silently, permanently,
by a package that never considered the question, in a different file from the one that
changed.

**Decision.**

1. **`packages/core/src/validation.js` owns the calendar-date rule.** `isCalendarDate`,
   `requireCalendarDate` and `calendarDaysBetween` sit beside the validators the kernel's
   own services already use. Under ADR-018 this is a *runtime capability*, not domain
   behaviour: it carries no domain vocabulary, decides no commercial question, and four
   independent re-implementations are the proof of reuse that ADR-018 asks for.
   `packages/contracts/src/dates.js` re-exports it, so M12's public surface does not move.

2. **One day has exactly one spelling.** Date-time strings, whitespace-padded dates,
   single-digit months and expanded or signed years are refused, not normalized. A key
   built from a date is only trustworthy if the same day cannot arrive under two byte
   sequences and stop colliding.

3. **Derived provenance fails closed, and is versioned when it changes.**
   `contract-lifecycle-source` moves to `@2` (and `contracts` to `version: 4`). It reads
   the `termsSource` enum off the live module contract and **refuses to open** while any
   declared value is unclassified, rather than answering for it; and it reports
   `signed: null` with `signedBasis: 'UNCLASSIFIED_TERM_SOURCE'` for a *stored* value
   outside that enum, because an absent decision is not the same fact as a decided
   `false`. The classification map can carry `true`, so a genuinely signed source needs no
   breaking change. Both are observable changes to what a consumer is told, so the version
   moved with them.

**Why not leave the date rule duplicated.** Four copies that agree today is the state
every drift starts from, and this one had already drifted: the copy in `lifecycle` was
shape-only when the milestone merged. The cost of the duplication was not the lines, it
was that no reader could tell which copy was authoritative.

**Why not enforce exhaustive classification with a test alone.** A test was already
written and it is kept. But the manifest and the map live in the same package and in
different files, and the failure a test catches on CI is precisely the failure that would
otherwise be *answered* — wrongly, silently, confidently — in production. The runtime
refusal is a local invariant a single PR can always satisfy, because both halves are
owned by `packages/contracts`.

**What this does not decide.** `delivery` and `service` still carry their own copies of
the identical round-trip rule. They are recorded as `partial` in
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` under the Compatibility Backfill Rule:
declaring the gap is required, closing it is sequenced work and not something a
defect-fix PR does on the way past. Nothing here changes what a term *means*, and nothing
here makes a signed renewal term exist — M12 still records operational activation
metadata, and M16a still reports it as such.

## ADR-029 — A contract is not a contract until a second consumer has used it, and a consumer-specific bound belongs where the consumer is declared

**Status:** accepted.

**Context.** DX6 shipped `scenarioRunContract: 1` with exactly one scenario:
`lead-to-won`, a sales funnel over the checked-in B2B starter. Its own PR body
recorded the single-consumer limitation, and that was honest — but a contract
validated by one consumer is not a validated contract. It is a shape fitted to
that consumer, wearing a version number, and the parts of it that are accidents
of the first consumer are indistinguishable from the parts that are principles.

Writing a second, deliberately unlike consumer —
`examples/scenarios/service-sla-escalation.scenario.json` over
`examples/journeys/service-sla-escalation/journey.mjs` — separated them in three
places, and each one had read as a principle:

1. **"Journey evidence is numeric."** `journeyMetrics` took the receipt's numeric
   keys and its comment gave the reason: prose in the evidence would move the
   fingerprint every time somebody improved a sentence. True, and it silently
   fixed the *type* of every future answer. A sales funnel is countable in every
   part that matters — three leads, one won. A support process is not:
   `slaEvaluations: 2` is equally true of a run that recorded the wrong answer
   twice, and what the business is judged on is *which state* — `at_risk` versus
   `breached` — and *whether* anything was notified.
2. **"A report does not need to say what time it is."** Nothing in the funnel is
   a function of the current instant, so the omission cost nothing and was
   invisible. An SLA state is a function of the clock and of nothing else:
   `evaluateSla()` reads `now()` and exposes no `at` parameter. A report saying
   `firstResponseState: breached` without saying which clock produced it is not
   evidence; it is a number with a story attached.
3. **"Limitations are global."** With one journey every limitation was true of
   every run, so a single list was correct by coincidence. With two, half of any
   merged list is false of whichever run a reader has in front of them — "no
   business-hours calendar" means nothing for a lead funnel, "no external
   enrichment provider" means nothing for a support case — and an obviously
   irrelevant disclaimer teaches a reader to skip the ones that are not.

**Decision.**

1. **The observation vocabulary gains `journey.fact`**, and journey evidence has
   two channels: `journey.count` for how many, `journey.fact` for which. A fact
   is a boolean or a single lower-case token of at most 64 characters, so the
   original rule holds — a prose summary has spaces, capitals and length and is
   excluded by construction rather than by a maintained denylist — while the
   state names the domains already use are admitted. It changes nothing about
   the three-layer refusal: the kind is a closed-vocabulary entry with a closed
   argument grammar, and a command in a fact value is refused twice, by the
   grammar and by `EXECUTABLE_SHAPES`.

2. **A consumer-specific bound is declared where the consumer is declared.** The
   journey's **clock** and the journey's **own limitations** live in the frozen
   registry in the runner's source, and are published in the report. They are
   deliberately not scenario fields. A document that could choose the instant
   could choose the instant at which the breach disappears; a document that could
   write its own limitations could write a shorter list. Both are cases of the
   same rule: **the thing being measured does not get to declare the bounds of
   the measurement.** Limitations therefore carry a `scope` — `global` for what
   is true of every run, `journey` for what the journey declares — and a journey
   may add to what a run does not prove, never subtract.

3. **The report contract moves to 2; the document contract stays at 1.** Every
   v1 scenario still validates, because a vocabulary gained an entry rather than
   changing one. The report gained fields and every fingerprint moved with them,
   and a consumer diffing fingerprints across that boundary is told rather than
   left to discover it.

**Why not a `requires` block on the scenario.** Service needs the `contracts`
package and `contracts/service-obligations@1`. It states that as
`package.composed` and `capability.available` *observations that must pass*,
answered by AX1 and failing closed. A prerequisites block would say the same
thing a second way — which the DX Simplicity Gate refuses on its own — and worse:
a precondition invites "skip if unmet", which converts a failure into silence.

**Why not a record-graph query.** "The escalation cites the SLA evaluation it
rests on" is a link between two records. The journey — trusted, checked-in
source — asserts it and publishes one boolean. A traversal syntax over records is
exactly the slope `docs/CODER_TOOLING_ROADMAP.md` refuses when it says a format
that can describe execution invites a runtime.

**Why not a negation operator.** "Nobody was notified" is published as
`escalationNotified = false` and observed as `false`. An `absent:` or `not:`
operator would let a run earn safety evidence by never attempting the operation;
the service journey attempts every refusal it reports.

**What this does not decide.** It says nothing about the *other* contracts in
this repository that have exactly one consumer today. The rule is stated here so
that a future contract's second consumer is treated as validation work rather
than as an increment, but no other contract is audited by this ADR. Coverage
remains *claimed* rather than discovered (`COVERAGE_IS_CLAIMED_NOT_DISCOVERED`),
two scenarios are not broad coverage, and PROVE stays partial because DX10 does
not exist.

## ADR-030 — Follow-up work is a package-native domain with an opaque subject envelope, and Activity is curated evidence rather than a projection of the audit log

**Status:** accepted.

**Context.** `TASKS.md` carried one unfinished item from Milestone 6: *"Add
Activity and a first-class Task module with a general automatic follow-up
workflow."* What existed was a bespoke slice — the B2B starter's own `task`
module, table `tasks`, with `title`, `status` in `open`/`done`, `dueAt`, a
**required** `leadId` reference and a unique `sourceKey`, every field publicly
writable — created inside `lead.qualify`.

Three things were wrong with it, and only the third is about code:

1. **The subject was a Lead, structurally.** A task that cannot exist without a
   `leadId` cannot be a follow-up on a contract, a support case or anything else.
   The next domain that needed one would have written a second table.
2. **It was not evidence.** `POST /api/modules/task/records` could forge a
   follow-up with any `sourceKey`, and `PATCH` could rewrite the key the runtime
   had written. There was no boundary at all.
3. **`open`/`done` is not a lifecycle.** No transition table, no cancellation, no
   actor, no record of who closed it or when.

The failure mode this ADR is really about is the first one: *silent divergence of
one concept across domains*. It had already started, and the second occurrence
would not have been compatible with the first.

**Decision.**

1. **A package, not core.** `packages/work` — `work@1` — owns `work-task` and
   `work-activity`, three human actions and one declared capability. ADR-018
   admits domain behaviour into `packages/core` only when it is a *runtime
   capability the kernel needs*, and the kernel needs no notion of a task: the
   module registry, action runtime, audit, trace and event bus all work today
   without one. **`packages/core` is unchanged by this milestone**, which is the
   mechanical form of that argument. The counter-argument — "two domains consume
   it" — is exactly what ADR-018 refuses; Contracts is consumed by three packages
   and is still a package.

   Named `work` after comparing the alternatives against the surface actually
   built: `tasks` and `activities` each describe half of it; `engagement` would
   promise a channel that does not exist; `work-management` would promise
   planning, capacity and scheduling, and would collide semantically with
   Delivery's shipped work packages and milestones.

2. **The subject is an opaque envelope, and the limitation is published.**
   `subjectResource`, `subjectId`, `subjectOwner` (`host` | `package`),
   `subjectOwnerPackage`, an optional `subjectLabel` display snapshot, plus
   `sourcePackage` and `sourceAction`. SQLite cannot enforce a foreign key whose
   target table varies per row, and this package does not pretend it can
   (`SUBJECT_REFERENCE_NOT_ENFORCED`). What makes the envelope trustworthy is
   **who wrote it**: the domain action that owns the source record, running on
   that record, inside the transaction that is about to commit. There is no
   generic resolver and no service locator — a resolver would be justified only
   if two real consumers needed identical resolution behaviour, and neither does.
   `subjectOwner` preserves the Package Contract's distinction between a
   host/project-owned record dependency and a foreign package-owned one.

3. **An explicit transition table, and no reopen.** `open → completed`,
   `open → cancelled`, both terminal. `open → completed` is direct because an
   `in_progress` state would change no read, no action and no refusal in this
   milestone — a state that changes nothing is decoration, and decoration in a
   state machine is a future migration. Reopening is not "un-completing": it
   needs a second lifecycle, and the honest answer for a repeated business round
   is a new task under a new source key, which the idempotency rule already
   supports.

4. **`dueAt` is evidence only.** No clock-driven state change, no overdue
   mutation, no timer, no scheduler. A read-only `due`/`overdue` may be computed
   at an **injected** instant and never writes. Proven by stepping an injected
   clock a year past a due date and re-reading the row byte-identical.

5. **Activity is curated user-facing evidence, not a projection of audit.** A
   closed four-entry vocabulary — `task_created`, `task_completed`,
   `task_cancelled`, `note` — written **inside the transaction of the action that
   caused it**. Audit and trace remain the exhaustive technical record; Activity
   is the semantic one a person reads. **There is no asynchronous projection
   engine, and there could not be one here:** the event bus dispatches after
   commit (ADR-012), so a projection would either escape the originating
   transaction or need Jobs/Outbox, which does not exist.

6. **One creator, reached two ways, with the asymmetry stated.** Consuming
   *packages* open `work/follow-up@1` through `domains.capability(...)`, which is
   created with the caller's `modules` handle and therefore writes inside the
   caller's transaction. The **host application cannot**:
   `PackageRegistry.capability({ consumer })` resolves `consumer` against
   registered packages, and a host action in project source is not one. Relaxing
   that check was rejected — the declaration check is the entire value of the
   seam, and weakening it for convenience would make every future
   `CAPABILITY_NOT_DECLARED` a suggestion. Instead the project composes the
   package's exported `createFollowUp` directly, exactly as
   `packages/domains/generated/index.js` composes the package itself. It is the
   same code the capability closes over: one implementation, two callers, no
   fallback (`HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES`).

7. **Consumers opt in; `requires` stays hard.** `createLifecyclePackage({
   followUp: true })` and `createServicePackage({ …, followUp: true })` add the
   declared requirement. Declaring it unconditionally would stop every existing
   composition booting until it also composed `work` — a silent break for every
   shipped database. Opting in is explicit, and a project that opts in *without*
   composing `work` is refused **at startup** with the unmet edge named, never at
   runtime inside a transaction. `work` requires nothing, so no composition of
   these packages can cycle.

8. **No versioned policy in v1, by decision.** A policy earns its fingerprint
   when two consumers share a rule. These three share none: Lead qualification
   wants a person's name and a caller-supplied due date; Lifecycle wants an
   intent and no date at all; Service wants an escalation level and, again, no
   date. A workflow DSL is refused outright. If a third
   consumer arrives needing a shared rule it becomes a code-first, synchronous,
   deterministic, fingerprinted policy with its identity on the record — the same
   contract every other policy here uses — and not before.

9. **Idempotency is the caller's business identity, and a clock in a key is
   refused at the boundary.** Same key and same payload replays the existing task
   and its creation activity; a divergent payload is `409
   WORK_FOLLOW_UP_CONFLICT` naming the fields; a new business round uses a new
   key. A key containing an ISO-8601 instant or a 13-digit epoch is **refused**
   rather than accepted and later discovered as duplicate rows — this is the M16a
   defect (ADR-028), turned from a review finding into a validator.

10. **The bespoke slice is migrated forward, and the old table is never
    touched.** Adoption was attempted first: Module Evolution (ADR-019) is
    additive and forward-only, so a required `REFERENCES leads(id)` cannot be
    relaxed into a generic subject. `tasks` is therefore not renamed, not altered
    and not dropped — an existing starter database still opens and every
    historical row is still readable — and `packages/work/src/legacy-tasks.js`
    adopts rows forward: dry-run by default, idempotent on `legacy-task:<id>`,
    `done → completed`, `leadId → subject { resource: 'lead', owner: 'host' }`,
    and a row it cannot map is **refused and named** rather than guessed. It is a
    function, not a command, so it adds nothing to the agent surface budget.

**Consequences.**

- One Task model, one Activity model, one queue, one lifecycle, for every domain
  that wants follow-up work — instead of a table per domain.
- Two packages now carry an optional dependency they did not have. A composition
  that does not opt in is byte-identical to before.
- Work becomes a package every future domain may depend on, so its version
  discipline matters: `follow-up@1` is frozen on two *package* consumers plus the
  host path — ADR-029's rule, since the host path cannot validate the capability
  itself — and a change in what it *answers* is a new version, per ADR-029.
- The starter's `task` module is gone. Every test that pinned its shape moved to
  the new records; the list is in `docs/plans/activity-task-operations.md` §1.

**What this does not decide.** It says nothing about a scheduler, reminders,
calendar sync, notifications, assignment, RBAC, recurring work, attachments or a
unified cross-domain timeline — all of which stay **not supported**, are listed
in `metadata().notModeled`, and are asserted as absent by the suite. It does not
migrate Service's `support-case-activity`, which stays domain-specific, and it
does not unify Delivery's history. It claims **no `M`-number**: `M16` is
Analytics Studio (planned) and taking `M17` would assert a position in a sequence
this horizontal capability does not have.

### ADR-030 addendum 1 — what the adversarial review changed, and what it corrected in this record

**Status:** accepted, from the pre-merge review of PR #70 (REVIEW-70). Each item
below was confirmed with a runnable probe against a real composed application
*before* anything was changed, and each is now held by a regression test.

1. **The transactional guarantee is verified, not assumed.** Decision 6 above
   says the capability writes inside the caller's transaction. It did — when the
   caller happened to be in one. Called outside a transaction, each managed write
   commits on its own `SAVEPOINT`, so injecting a fault into the Activity write
   left a **committed Task with no Activity**: the half pair this ADR says the
   package never produces. `createFollowUp` now checks the module service's own
   connection before the first write and refuses `500
   WORK_TRANSACTION_REQUIRED` when no transaction is open. Fail-closed by
   construction: there is no way to opt out of the check.

2. **Semantic identity is the whole stored fact, not four fields of it.**
   Decision 9's replay comparison read `title`, `dueAt`, `subjectResource` and
   `subjectId` only. So one source key could be replayed with a different
   **subject owner**, **owning package**, **source package** or **source
   action** and be answered "already done" while the row said something else —
   a Service escalation could reuse a Lifecycle key and be handed Lifecycle's
   task, with Lifecycle's provenance, as its own. All eight semantic fields are
   compared and each divergent one is named in the 409. **`subjectLabel` is
   deliberately excluded** and is the *only* exclusion: the contract already
   states it is a display snapshot taken at creation and never refreshed, so a
   replay whose only difference is a renamed subject describes the same work and
   is honoured — the stored snapshot is not rewritten.

3. **Provenance is bound at capability resolution, and the limit of that is
   stated.** `source.package` was free caller text: any declared consumer could
   store any other package's name as the origin of work it opened, and the row
   read as authoritative forever. `PackageRegistry.capability()` already
   resolves and verifies the consumer against that package's own `requires`, so
   it now passes that identity to the provider — generically, knowing nothing
   about Work — and Work binds it: a request asserting anything else is refused
   `403 WORK_SOURCE_PACKAGE_MISMATCH`, and a direct host caller may assert only
   `host`. **This is not authentication and is not claimed to be.** The registry
   cannot tell which package's code is executing (ADR-018 addendum 4: the
   consumer name is asserted by the caller), so the floor moves from "any package
   name a caller types" to "a package that also declared this capability". That
   is a real narrowing, not a boundary, and it is published as
   `metadata().capability.bindingLimitation`. `source.action` and
   `subject.ownerPackage` stay caller-asserted, because the registry knows
   neither which action is calling nor who owns a subject that may belong to a
   third package.

4. **An impossible `dueAt` is refused, not rolled over.** `optionalIsoDate` is
   `Date.parse` underneath, which does not validate a calendar day: `2027-02-30`
   was stored as `2027-03-02` and `2027-04-31` as `2027-05-01`, silently, as
   evidence, with nothing on the row saying the date had been invented. This is
   precisely the class ADR-028 added `isCalendarDate` for, shipped again. Work
   validates the calendar-day part of any ISO form it is given against that same
   round-trip authority and refuses `400` otherwise. (The wider question — that
   `optionalIsoDate` itself accepts impossible days for *every* caller in the
   framework — is a real finding beyond this milestone's scope and is named as a
   follow-up rather than fixed here.)

5. **Actor identity is the kernel's, byte for byte.** Work normalized its own
   actor and truncated the id to 200 characters. Truncation of an identity is
   not a bound, it is a **merge**: two distinct people sharing a 200-character
   prefix became one string on the Task and on every Activity, while the audit
   row written by the same transaction carried the full id — two records of one
   write disagreeing about who did it, both looking authoritative. `normalizeActor`
   is now exported from the public kernel surface and Work calls it, so there is
   nothing left to drift.

6. **The clock heuristic in a source key is removed.** Decision 9 refused any
   ISO instant and any run of 13 or more digits. That is not a property of a
   moving key, only of some strings that resemble one, and it refused real
   business identities: 13-digit customer numbers, provider event ids, 16-digit
   order numbers, and business events whose *scheduled* instant is deliberately
   part of their identity and is stable under every retry. A **generic**
   capability cannot infer a caller's business identity from a regex, and
   carrying M16a's one-domain bug fix forward as a universal restriction was the
   wrong trade. Work now refuses only what it can actually judge — structurally
   invalid syntax and unbounded length. The guarantee moved to where the identity
   is: every consumer derives its key from a committed record id, and
   `tests/work-source-key-stability.test.js` runs each one at two clock instants
   and asserts the key does not move.

7. **Two smaller corrections.** A unique-constraint race was recognised from the
   error *message* (`/already exists|unique constraint/i`), so any other 409
   whose sentence contained those words could be answered with a replay; it now
   matches the kernel's typed `ConflictError` and explicitly excludes a transient
   busy conflict. And the timeline comparator used `localeCompare` with no locale
   argument, making a repository-deterministic order depend on the host's ICU
   collation, the Node ICU build and `LANG` — ICU is not code-point order, it
   treats `-` and `_` as variable punctuation and orders case the other way
   round, so two readers of the same rows could see two lists. It is code-point
   lexical now.

8. **The legacy adoption is atomic as well as idempotent.** Decision 10 promised
   idempotence and delivered it, but adopted row by row: a run killed halfway
   left a database neither in the old shape nor the new, with a reported
   `adopted` count nobody could trust. The whole adoption now runs in one
   transaction.

**Correction to decision 1.** That decision states "**`packages/core` is
unchanged by this milestone**" as the mechanical form of the no-core-Work-engine
argument. That is no longer literally true and this record must not keep saying
it is. `packages/core` now carries exactly two changes, both **generic** and
neither naming Work or any package:

- `PackageRegistry.capability()` passes the consumer identity it has already
  resolved to the provider's `create(context)`, overwriting any `consumer` a
  caller put in the context;
- `normalizeActor` / `SYSTEM_ACTOR` are exported from the public kernel surface,
  because a package that cannot reach the canonical actor authority will write
  its own and drift from the audit log beside it.

The substantive claim of decision 1 stands unchanged: there is **no Work engine
in the kernel**, no record, action, capability, table or name belonging to this
domain anywhere in `packages/core`, and removing `packages/work` still removes
the domain entirely.

**What the review did not change.** The three architectural positions this ADR
takes all survived the attacks: a **package-native Work domain** (the kernel
still needs no notion of a task, and the two core changes above are capability
plumbing and an actor helper, neither of which is Work); an **opaque subject
envelope** (the alternative is a generic resolver no second consumer needs, and
the unenforceable-foreign-key limitation is published rather than papered over);
and **curated Activity rather than an audit projection** (the event bus still
dispatches after commit, so a projection would still either escape the
originating transaction or need a Jobs/Outbox that does not exist).

## ADR-031 — Requirement identity is derived from the plan, and an evidence document may point at proof but never declare it

**Status:** accepted.

**Context.** DX5 proves a project is healthy. DX6 proves which business jobs a
checkout earns. AX2 proves a plan is a valid document still true of an
application. None of them can answer the question a coding agent is actually
asked at the end of a piece of work — *is the plan finished* — and this
repository has a worked demonstration of the gap rather than a hypothetical one:
`examples/solution-plans/lead-to-won.plan.json` is the one plan `package.json`
declares **current**, `accordo solution check` exits 0 on it, `accordo project doctor`
grades it `passed`, `accordo project verify` is green, both scenarios pass, and four
of its six requirements are not implemented. Every authority in the repository is
satisfied and the plan is not built.

Closing that needs two things this repository did not have, and each is a
decision rather than a mechanism.

**The first: a requirement needs an identity, and one of the two kinds has none.**
A plan already carries stable, unique, duplicate-refused ids for
`decisions[].id`, `steps[].id` and every `evidence.<category>[].id`, plus a
plan-wide `fingerprint` and a derived `application.inspectionFingerprint`.
`acceptance.checks[]` is an array of **bare strings**. So the inventory is one
gap, not a missing identity model, and the temptation was to fill it by widening
the contract.

Two options, compared rather than assumed:

| | Explicit — accept `{id, statement}` in `acceptance.checks[]` | Derived — content-address the statement |
|---|---|---|
| change to `solutionPlanContract: 1` | a new accepted shape, new validation, a new normalized form | **none at all** |
| plans already checked in | keep working, gain no id, need editing to get one | **addressable immediately, unedited** |
| plan fingerprints | a new shape means new plans hash differently from old ones for the same words | **not one byte moves** |
| migration | every historical plan eventually rewritten, or two forms forever | **none needed** |
| rewording a criterion | the id survives, and the evidence silently survives with it | the id changes, and the evidence must be re-examined |
| reordering the list | survives | survives — content-addressed, not positional |

**Decision 1. Requirement identity is derived, and adds nothing to the Solution
Plan contract.** A requirement is a plan **step** or an **acceptance check**.
A step reuses the id its author already wrote — `step:<stepId>` — because
minting a second name for a thing that already has one is how a repository ends
up with two identifier systems. An acceptance check is
`check:<first 12 hex of sha256 over its statement>`. `planRequirements()` lives
in `packages/core/src/solution-plan.js` beside the plan it describes, is
published by `solution inspect|validate|check --json` **outside** the `plan`
object so no fingerprint moves, and is pinned by a test asserting that every
checked-in plan still hashes to the value in its own file.

The one real cost is accepted deliberately: **rewording an acceptance criterion
changes its requirement id**, so evidence recorded against the old wording reads
as unevidenced rather than carrying over to a criterion nobody re-examined. Two
identical statements in one plan collide, and the collision is refused
(`PLAN_REQUIREMENT_DUPLICATE`) rather than resolved — one requirement must not
stand for two.

An **artifact is not a requirement**, and neither is a JTBD row. `artifacts[]`
names a place a step intends to produce a file; treating a declared path as a
requirement is "the file exists, therefore it is done" wearing a contract, which
is the inference this rung exists to refuse. A JTBD row is DX6's unit and a
person's decision under `docs/QUALITY_GATES.md` §3.

**The second: who gets to say a requirement is met.** Three shapes were
considered.

*Source and git heuristics* — match changed paths against the plan's declared
artifacts, match test filenames against requirement text. **Rejected as a
complete solution**: an empty file at the declared path scores identically to a
working one, a rename scores zero while the behaviour is present, and a test
*file* existing says nothing about whether that test ran. It survives as one
evidence kind, content-hashed, with a hard rule attached.

*An agent-authored checklist* — a status per requirement with a prose
justification. **Rejected**: it reproduces the self-report, which is the failure
mode. A green checklist written by the agent that wrote the code, read by
nobody holding independent facts, is indistinguishable from an honest one.

**Decision 2. A checked-in evidence document declares *where to look*; a
deterministic verifier decides *what is true*, from authorities that ran in the
same invocation.** `implementationEvidenceContract: 1` has **no status field
anywhere**. A requirement carries a category and a list of pointers. The only
shapes an author may add are **downgrades** — `blocked` and `partial`, each with
a mandatory reason, mutually exclusive, and unable to raise a status. An author
may always say "this is less proven than it looks"; no author may say "this is
more proven than the evidence shows". The document, like a Solution Plan and a
scenario, is function-free by contract and refuses executable content through
the same exported `EXECUTABLE_SHAPES`.

Four consequences worth stating, because each was a live alternative:

1. **There is no `test` evidence kind.** A test name is exactly the arbitrary
   string the contract refuses: no authority here publishes which tests ran, so
   citing one would be a claim dressed as a citation. `project.verification` on
   `suite.verify` says the true, weaker thing.
2. **There are no evidence-to-evidence citations.** An entry names an authority
   and a fact, so a conclusion is not expressible as a premise and there is no
   graph to keep acyclic. AX2 needed a citation DAG because its entries derive
   from each other; recreating one here would be complexity with no failure
   behind it.
3. **Manual evidence is accepted and can never be proof.** A manual-only
   requirement is `unverified`, forces a non-zero exit on its own, and publishes
   `MANUAL_EVIDENCE_IS_NOT_PROOF`. Refusing it outright would make the browser
   requirement *vanish* from the document, and a gap that is stated is part of
   the deliverable while a gap that is omitted is a claim.
4. **A step's decision type is a floor on its category, and the floor is what
   the sufficiency rule is applied against** — not merely reported. A
   `configure` step declared `structural` is graded as behavioural, because a
   violation that still grades the weaker claim lets the label decide the
   outcome. **The behavioural rule itself is keyed on the observation's kind,
   read from DX6's report.** `file exists` never satisfies a behavioural requirement, and neither
   does `action.present` — "the action is declared" is not "the application does
   this". An author cannot relabel one as the other, because the kind does not
   come from the document. Symmetrically, a purely structural requirement needs
   no scenario: a record either is in the composition or is not, and requiring a
   run to prove a schema would be the mirror error.

**Decision 3. A plan's composition binding may be answered by a scenario, and it
is derived rather than declared.** AX2's `inspectionFingerprint` names the
application a plan was written against. In a project that is the project; in a
*framework* repository whose root composes no domain package, the application a
plan describes is the one a starter composes, and the only authority that
produces that digest is DX6, which publishes it as
`composition.compositionFingerprint`. So `solution verify` resolves the pinned
digest against the authorities that actually ran — AX1 at the root first, then
exactly one explicitly referenced scenario — and names which one answered. When
the binding is a scenario, an `application.fact` reference is **refused**: the
only full AX1 report in hand describes a different application, and answering a
question with the wrong application's facts is the failure the rule prevents.

**Exit 0 is forbidden while manual evidence remains required**, and a partial
plan is never "verified with warnings": `partial`, `blocked`, `unevidenced`,
`stale` and `unverified` each force exit 1 on their own.

**What this does not decide.** It does not promote PROVE. DX10 exists and no
checked-in plan in this repository is fully machine-verifiable, so nothing here
exits 0 today; promoting the story because the command exists is the move this
rung was built to stop. The condition is now machine-checkable rather than
rhetorical: a checked-in, declared-current plan whose `solution verify` exits 0.
It also decides nothing about MCP — `docs/architecture/AGENT_TOOL_SURFACE.md`
maps `solution.verify` under the deferred Solution namespace as policy, and DX13
remains unbuilt.

### Addendum 1 — what the adversarial review changed

The review (`.claude/skills/adversarial-review/SKILL.md`) found that four of
this ADR's own guarantees were properties of a *reader* rather than of the
contract, and one bound was argued from the wrong threat model. Each is
corrected here rather than restated as a limitation, because a limitation
paragraph that describes a hole is not a fix.

**1. A declared category could choose the authority. Now it can only raise it.**
The first cut let an evidence author declare an acceptance check's category, and
that category selected the sufficiency rule. So a behavioural criterion labelled
`structural`, cited with `source.artifact`, `action.present` or
`package.composed`, reported **verified** with nothing having run — and the
shipped limitation `REQUIREMENT_CATEGORY_IS_DECLARED` documented exactly that
rather than closing it.

The invariant is now stated as an invariant: **an author must never be able to
raise a requirement's verification status by choosing a weaker category.** A
requirement the plan does not *authoritatively* type falls to
`UNTYPED_CATEGORY_FLOOR`, which is `behavioural`, and needs an authority that
ran. That is every acceptance check under `solutionPlanContract: 1`, and also
any step whose decision type does not resolve — the plan is authoritative only
where it actually says something, and an unrecognised decision type says
nothing. A declared category is still read and still published, and it may only
move the grade in one direction: it may require *more* proof
(`CATEGORY_STRENGTH`), or it may downgrade the result, which is what declaring
`manual` does. The rule is a pure total function in core,
`effectiveRequirementCategory()`, and the report publishes `category` and
`enforcedCategory` side by side so nothing an author wrote is hidden.

The cost is real and is not hidden: an acceptance criterion that is genuinely
about project health — "the full verification suite passes from a clean clone" —
can no longer be *verified* by citing `project.verification`, because nothing in
`solutionPlanContract: 1` distinguishes that criterion from a behavioural one.
It grades `unevidenced` with a reason, and `lead-to-won`'s only verified
requirement was exactly that one. A false negative by construction is preferred
to the false positive an author-chosen category produces.

**The future option, recorded rather than taken.** The way to recover a typed
criterion is a plan contract in which `acceptance.checks[]` carries its own
type, at `solutionPlanContract: 2`. That is deliberately **not** done here:
widening a frozen contract so a verifier goes greener is the move this rung
exists to refuse, and it needs a migration story for every checked-in plan.
`ACCEPTANCE_CHECKS_ARE_UNTYPED` publishes the gap in the meantime.

**2. The requirement id was 48 bits. It is now 128.** `check:<12 hex>` was
argued from birthday chance among the ~200 rows one plan may carry. That is the
wrong threat model: the wording of an acceptance check is authored by a coding
agent, and an agent that can propose wording can search wording. The bound that
matters is a **chosen** collision — landing a new criterion on an id that
another criterion's evidence already names, which makes an unevidenced criterion
resolve against evidence written for a different one. At 48 bits that is ~2^48
hashes: hours on one commodity GPU, days on a CPU. It is an afternoon, not a
theoretical bound. At 32 hex = 128 bits the chosen-target search is ~2^128, the
bound SHA-256's own second-preimage resistance rests on, and the birthday search
is ~2^64. Nothing outside this repository consumes these identifiers yet, so
this was the cheapest moment the change will ever have.

**This was measured, not estimated.** The parallel adversarial probe built the
attack rather than bounding it, and at 48 bits it constructed **three collisions
between grammatical, Accordo-style acceptance criteria in 103 seconds on one
core**. The hole was reachable in under two minutes by anyone who controls the
wording of an acceptance check, who could then land a new criterion on an
existing requirement's id and inherit its evidence. The widening was not
precautionary, and a measured attack cost is the number to cite. Both properties that
made the derivation worth having are unchanged: rewording a criterion changes
its id, and two identical criteria still collide and are still refused.

**3. "Function-free by contract" was true of the file and not of the API.**
`validateImplementationEvidence` is exported core API and is not restricted to
the `JSON.parse` path the CLI uses. Given a live object it read fields directly,
so a getter on `blocked` or `category` was author-supplied code that the
validator *ran* — in a contract whose whole claim is that it runs nothing an
author wrote. A `Proxy` was worse: a field was consulted twice, once by
`Object.keys` for enumerability and once for its value, so the document that
passed validation and the document that was fingerprinted need not have been the
same document.

`toPlainData()` now converts a document to plain data once, before any field is
read for meaning. It refuses an accessor rather than invoking it; refuses a
non-plain prototype, which takes `Date`, `Map`, `Set`, `RegExp`, a class
instance and an object whose fields come from its prototype chain with it;
refuses a symbol key, a function, a symbol, a `BigInt` and a non-finite number;
refuses a cycle with a path rather than overflowing; and takes one snapshot of
every own descriptor so every value is read exactly once. It lives in
`packages/core/src/solution-plan.js` beside `EXECUTABLE_SHAPES` and
`canonicalJson` — the module the plan, scenario and evidence contracts already
share — so it is one more shared refusal rather than a third JSON contract.
The plan and scenario validators have the same exposure on the same public-API
path and are deliberately left alone: retrofitting two frozen contracts is a
separate change.

**4. The executable-text scan was described as the boundary. It is not.** It is
a regex over English, and measured in both directions it misses `perl`, `ruby`,
`make`, `docker`, `powershell`, `cmd.exe`, `kubectl`, `source`, `.` and a bidi
override, while refusing ordinary acceptance prose — "`npm run verify` does not
cover it", a URL in a sentence, "must render as `${amount}` text", "`rm -rf` is
never run here". Those are the exact sentences a blocked or manual requirement
needs, and pushing an author towards a vaguer reason is the worse outcome: a
shell-shaped reason is inert, a vague one hides a gap.

What makes the document safe to read is its **shape** — no command, script,
effect, env or path-to-execute field exists at any level, unknown keys are
refused, and nothing in this repository executes a string that came out of one.
The scan stays as defence in depth on **pointer** fields and no longer applies
to the three free-prose fields or to an author's limitation message; bounds and
the control-character refusal still apply everywhere. Its measured limits are
published as `EXECUTABLE_TEXT_SCAN_IS_NOT_A_PARSER`. The shared
`EXECUTABLE_SHAPES` vocabulary is **not** changed, because it is frozen into two
merged contracts.

**5. A broken authority was reported as a business decision.** `grade()` applied
the document's `blocked` downgrade before it asked whether the authorities that
requirement depends on had run. So a requirement whose scenario produced no
report was published as `blocked` carrying the author's business reason, when
the true answer was that the machine did not run. A reader acts on those
differently: one is a plan, the other is a re-run. The report now keeps three
answers apart, and this is a contract rule rather than a convention:

```text
blocked        the business requirement is blocked; an author said so, with a reason
unverifiable   an authority did not run; this says nothing about the work at all
exit 2         the document is invalid, and carries no requirement rows to misread
```

`unverifiable` outranks every author-written downgrade, and the author's claim
survives beside it as `declaredDowngrade` rather than as the verdict. Relatedly,
only a document that could not be normalized *at all* used to stop before the
fan-out; one that merely carried an unknown key normalized to something and then
ran AX1, every referenced scenario and up to thirteen minutes of `project
verify` against a document already known to be invalid. An invalid plan or
evidence document now runs nothing.

**6. A requirement could be verified from a run of a different application.** A
scenario observation was looked up by scenario id and read out of the report
without ever asking which application that scenario had composed. So a
behavioural requirement of a plan bound to application A was `verified` by an
observation from a scenario that composed application B — every observation
passing, the code present, the `expects` string matching, and none of it about
the application the plan was written against. An observation is now refused with
`EVIDENCE_COMPOSITION_MISMATCH` unless the scenario's published
`compositionFingerprint` equals the composition the plan is bound to. **One
requirement, one application identity.**

This lands on this ADR's own shipped evidence, and the honest outcome is kept
rather than papered over: `lead-to-won.plan.json` binds to the repository root,
which composes no domain package, while `scenario:lead-to-won` composes a
starter into a directory of its own. Its starter-installation criterion was
being verified across two application identities and is now refused. The
citations are kept so the gap is machine-visible, and the document declares
`NO_SCENARIO_COMPOSES_THIS_APPLICATION` — the same treatment
`govern-delivery-change` already gets for having no evidence document at all.

**7. The exit-0 arm had never run through the real command.** Every exit-0
assertion injected its delegates. `examples/solution-plans/verifier-fixture-exit-zero.plan.json`
and its evidence document are a **verifier fixture**: four requirements, every
one graded behavioural at the untyped floor, every one answered by a runtime
observation the shipped service scenario already publishes. It binds through
`scenario:service-sla-escalation`, runs AX1 once and one scenario once, never
touches `project verify`, and reaches exit 0 with an empty problems list in
about six seconds. It is labelled a fixture in its file name and in both
documents' limitations, and it claims no product coverage and no JTBD row.
**Neither real plan was weakened**: both still exit 1, which is the true state
of both.

**What the addendum does not change.** No status field appears anywhere in
`implementationEvidenceContract: 1`. There is still no `test` evidence kind
(B16: no authority publishes which tests ran, so a test name would be a claim
dressed as a citation, and it may only be reopened under a later contract
version if such an authority appears). There is still no evidence-to-evidence
citation, no write mode, no `--fix`, and `promotion.performed` is `false` on
every report. `solutionPlanContract: 1` is untouched. PROVE is still partial,
and the fixture does not move it: the condition remains a checked-in,
**declared-current** plan whose `solution verify` exits 0, and the fixture is
neither declared-current nor a product claim.

### Addendum 2 — what the second review pass changed

The parallel adversarial probe re-ran against the post-fix head. It confirmed
two things addendum 1 had left open, and found one thing addendum 1 had wrong.

**Confirmed.** `blocked` short-circuiting cannot skip the category floor: the
floor is computed before the short-circuit, so `EVIDENCE_CATEGORY_BELOW_FLOOR`
still fires and `enforcedCategory` is still published on a blocked row, and a
fully-blocked plan yields `verified: 0` and exit 1. And the execution cost is
bounded rather than weaponisable: whether to run `project verify` is a single
boolean, so forty `project.verification` citations cost exactly one suite run,
and a document naming one scenario over the cap fails closed at **zero**
authority executions. High amplification ratio, fixed ceiling.

**Wrong, and now fixed: a delegate that rewrote an *already-dirty* file was
invisible.** `compareWorktree()` compared `git status --porcelain` status codes
per path. That is strictly better than comparing paths alone — it is what
catches a file the operator had modified and a delegate then deleted — but a
path that is ` M` before the run and ` M` after reads as unchanged *whatever
happened to its bytes*:

```text
clean before:  changedByVerification ["src.js"]   VERIFICATION_DIRTIED_WORKTREE   exit 1
dirty before:  changedByVerification []           no problem                      exit 0
```

So the rule this contract states — pre-existing changes are context, changes
caused *during* verification are failures — held for a created file and for the
first modification of a clean one, and **failed for the second modification of
an already-dirty one**. That is the likeliest shape in the only situation that
matters: a coding agent working in a tree it has already touched. It could not
forge a statement about a requirement, so it was never a merge blocker; it made
a stated guarantee false, which under this repository's own rule is a defect of
the same kind as a missing check.

Each dirty path now carries a **content mark** beside its status — the SHA-256
of its bytes, or an explicit non-digest marker (`absent`, `outside`,
`nonfile:…`, `big:<size>:<mtime>`, `unreadable`). The mark never enters the
report or any fingerprint; it exists only to be compared with itself one moment
later. It is bounded at 8 MB per file and 128 MB per run, above which a path
degrades to size-and-modification-time — an ordinary rewrite still moves both,
and a same-size same-mtime rewrite of an oversized file is the residual.
Published as `WORKTREE_CONTENT_SAMPLING_IS_BOUNDED`.

**Two limits named rather than built**, deliberately, because each is a
semantics change and this milestone has had enough of those:

- `NO_TIME_BOUND_OF_ITS_OWN` — this command sets no timeout, deadline or
  cancellation of its own. Every child it causes is spawned by `project verify`
  or `scenario run`, which bound their own children in time, output and process
  group, so the isolation is **inherited rather than absent** — but a delegate
  that never returns hangs this command with it, and there is no watchdog here.
- `AUTHORITY_REFUSAL_UNDER_A_DOWNGRADE_IS_NOT_RESTATED` — the `unverifiable`
  status catches *authority did not run*. It does not catch *authority ran and
  refused*: with `EVIDENCE_OBSERVATION_FAILED`, `EVIDENCE_OBSERVATION_MOVED` or
  `EVIDENCE_SOURCE_HASH_MISMATCH` under an author's `blocked` or `partial`, the
  row's status and reason are the author's, and the machine's verdict survives
  in `problems[]` and on the evidence entry. It is the same substitution one
  step further out. It can never raise a status or reach exit 0. Extending
  `unverifiable` to cover it is deferred to a later contract version.

`implementationEvidenceVocabulary()` also gains the `executableContent` honesty
entry that `solutionPlanVocabulary()` already published — what the scan is
applied to, what it is not applied to, that it is **not** the boundary, what the
boundary actually is, and its measured misses and false positives.

## ADR-032 — Packages may contribute bounded application operations without owning arbitrary HTTP routes

**Status:** accepted. **Implementation deferred by design**: this ADR lands
alone, and the seam is built in the Signature extraction PR, where both real
consumers exercise it in one reviewable change (Rollout, below). Per ADR-029,
a contract is not a contract until a second consumer has used it — so nothing
here ships mechanism ahead of its second consumer.

**Context.** Two extractions measured the same gap from opposite sides, and
recorded it instead of solving it ad hoc.

The Commercial extraction (merged `6cf4c85`; B7 evidence in
`docs/plans/extract-commercial-operations-package.md` §B7) moved catalog sync
into `packages/commercial` but could not move its *attachment*: the operation's
identity is a **provider**, not a CRM record id, so the generic
`/api/modules/:module/records/:id/actions/:action` surface cannot carry it
without minting a synthetic anchor record — a schema and API change a
behaviour-preserving refactor may not make. The package therefore exposes
`createCatalogSyncOperation(runtime)` and `packages/app/src/create-app.js`
attaches `app.syncCatalog` with **one domain-named lookup**, honestly commented
as seam residue. It works, it is detach-safe, and it is exactly the shape this
repository refuses at scale: a dependency the composition file does not
declare, wired by name in framework source.

The Signature characterization (`docs/plans/la0-signature-order-characterization.md`,
merged `a5a71dd`; §6 and §1.5) measured the second case. `app.reconcileSignature` is **nearly a declared action already**: it
addresses an existing record by id, takes no raw body, uses the ordinary actor
path, and its runtime shape is precisely an `externalOperation: 1` sequence.
Two things stop it: envelope records are read-only managed modules whose
action-eligibility would be a public-surface change, and the operation lives on
the app object, not the action registry. `app.ingestSignatureEvent` shares the
non-record identity problem — `(provider, providerEventId)`, where the target
envelope may not exist locally at all — and both operations call
`runExternalOperation` directly, **which is not public kernel API**: an
extracted Signature package could reach the external-operation contract for an
*action* (the kernel runs it), but not for its two app-level operations. That
export gap is part of this seam's motivation, and this ADR closes it with a
bounded injected context rather than a raw public export.

Two measured consumers, one shape: **a package needs to own an
application-scoped operation — provider-addressed, transaction-disciplined,
traced, audited — without the kernel naming the domain and without the package
registering routes.** That meets the two-real-consumers bar
(`TWO_CONSUMERS_JUSTIFY_DESIGN`, recorded in the Commercial B7) that this
repository requires before any generic seam is designed.

**What this seam is NOT — non-goals, stated as bluntly as the mandate states
them.** This ADR does not create: generic raw HTTP routes; arbitrary
path/method registration; Express-style middleware; arbitrary command
execution; MCP tool auto-generation; a webhook framework; a scheduler or job
system; RBAC/auth. A package that needs any of those has a missing decision,
not a missing mechanism.

**The Signature raw-body webhook stays explicit and special — it is not this
seam.** The Signature characterization's §6 measured four structural properties that
separate `POST /api/signature/providers/:provider/events` from everything an
operation contract can generalize:

1. **Identity** — addressed by `(provider, providerEventId)`, and the target
   envelope may not exist locally (quarantine is contractual);
2. **Bytes** — verification must see the exact bytes the provider signed;
   the action pipeline's decode/validate/sanitize would verify a different
   document and silently replace invalid UTF-8;
3. **Actor** — the caller is unauthenticated by design and authenticated by
   HMAC; the route synthesizes `{ type: 'system', id: 'signature:<provider>' }`
   itself and never trusts headers for it;
4. **Refusal shape** — a verification failure is a stable 401 that echoes
   neither payload, signature nor key, not a validation envelope that reflects
   input back.

Catalog sync shares only the first property, so a generic raw-body route seam
still has exactly **one** consumer and is not designed here. The webhook route
remains a hand-written, enumerated, kernel-reviewed endpoint in `apps/server`;
what changes is only what it delegates *to*.

**Decision: the package contract gains a declared, bounded `operations` list,
and the kernel gains one generic operation runtime.** Reuse over invention, in
order: `PackageRegistry`/`resolvePackageComposition` validate and
collision-check the declarations; canonical input validation is the action
runtime's `validateActionInput` shapes; transaction discipline for
provider-backed operations is the existing External Operation contract
(ADR-017); events go through the ADR-012 transaction-scoped buffer; audit
stays the managed-write path inside the operation's own module services; traces
are the same `workflow_runs`/`trace_spans` rows every run surface already
reads. Core owns generic dispatch, validation, bounding and refusal mechanics.
Packages own every domain behaviour. **No domain name appears in
`packages/core` — the domain names live in the package's own declaration.**

The V1 contract, smallest shape both consumers justify:

```js
definePackage({
  // ...existing fields...
  operations: [{
    operationContract: 1,
    name: 'sync-catalog',            // NAME_RE, unique per package
    label: 'Synchronize catalog',
    description: '…',                 // bounded, like every declared identity
    appMethod: 'syncCatalog',         // optional compatibility alias (below)
    input: [ /* validateActionInput field shapes, reused verbatim */ ],
    create(runtime) { return async (params) => { /* domain behaviour */ }; },
  }],
})
```

`create(runtime)` is called once at composition, exactly as
`createCatalogSyncOperation` is today, and receives a **bounded operation
context** — not the raw kernel:

- `database` and `modules` — the same handles the operation code holds today;
- `events` — the buffered bus, so domain events stay invisible until commit;
- `config` — the bounded, JSON-safe slice the application passes
  (`catalogTimeoutMs`, `signatureTimeoutMs`: the two knobs that exist);
- `runExternal` — the External Operation sequencer, injected so a package
  operation gets intent/external/finalize/compensate discipline **without
  `runExternalOperation` becoming public API**. This closes the Signature
  export gap the narrow way: the contract travels with the seam, the module
  stays private, and no third path to it exists;
- `trace` — a bounded trace writer (below).

**The trace decision, closing the review's recorded Low.** Both consumers
demonstrably write traces: catalog sync writes its own `catalog.sync` run with
steps, best-effort in a `finally`; the Signature operations get theirs through
`runExternalOperation`. So the question "does package operation code need a
bounded trace context injected by the runtime" is answered by measurement:
**yes, for both.** The injected `trace` accepts the same run shape `writeTrace`
persists today and adds the bounds the raw export never had: JSON-safe input
and output (the `sanitizeJsonSafe` discipline), size-bounded step lists and
messages, best-effort semantics stated in the contract rather than re-invented
per caller. Operation run names are package-declared, not kernel-derived —
`catalog.sync` is frozen in the LA0-Commercial baseline as a
consumer-visible value, and a namespace rule that renamed it would be a
behaviour change wearing a tidiness costume; new operations should name runs
`<package>.<operation>`, and existing names are grandfathered explicitly.
The public `writeTrace`/`normalizeError` exports on `packages/core/index.js`
**remain**: they are published API with a shipped consumer, and removing them
when the consumer migrates would be surface narrowing for no behavioural gain.
The residual is documented here, honestly: once Commercial's operation takes
the injected `trace`, the raw export has no in-repo package caller and stays
public anyway. That is the whole cost, and it is cheaper than a breaking
cleanup.

**Adapter exposure is decided per adapter, deliberately — V1 exposes only what
current behaviour requires.** No operation is auto-exposed anywhere.

| Adapter | V1 | Why |
|---|---|---|
| App method | **yes, by declared alias** | `app.syncCatalog`, `app.ingestSignatureEvent`, `app.reconcileSignature` are today's consumer-visible surface (starter, journeys, tests, LA0 baselines). The alias is declared by the package (`appMethod`), attached **generically** by the composition, `NAME_RE`-bounded, collision-checked, and refused if it would shadow an existing application key. The domain-named lookup in `create-app` is deleted; the name moves to the declaration, where names belong |
| HTTP | **yes, enumerated kernel-owned routes only** | `POST /api/catalog/sync`, `POST /api/signature/envelopes/:id/reconcile` and the raw-body webhook stay hand-written in `apps/server`, byte-identical in behaviour, delegating to the composed operation instead of named app wiring — each already answers an honest 404 when the owning package is absent. **No package-declared path or method exists in V1**; that is the arbitrary-route non-goal |
| SDK | **no new surface** | the SDK reaches the existing routes; nothing changes |
| CLI | **no** | no current consumer; deferred until one is measured |
| Admin | **no** | no operation UI exists today; the quote screens stay as they are |
| AX1 `app inspect` | **yes, additive** | declared operations appear in the package report, and detach removes them — the matrix's detach/reattach discipline applied to operations |
| `/api/schema` | **yes, additive** | operation names published in the package's `domains` block, function-free, alongside the `eventEndpoint` string Signature's metadata already carries |
| MCP | **no** | DX13 owns tool exposure; auto-generation is a named non-goal |

**Rollout — and the written boundary on what the implementation may add to
core.** This ADR merges alone. The seam is implemented in the **Signature
extraction PR**, where both consumers exercise it in the same change:
Commercial's `syncCatalog` migrates onto the declared operation (LA0-Commercial
must replay with zero asserted observations moved — the attachment is
`pre_extraction_evidence`, the behaviour is contract), and Signature's two
operations compose through it. Under this ADR, that PR's core-side diff is
authorized to contain **exactly**:

1. the optional `operations` field on `packageContract: 1` — additive
   validation in `package-registry.js`/`package-composition.js` (identity,
   `NAME_RE`, per-package uniqueness, alias collision/shadow refusal); no
   contract version bump, because absent means absent;
2. one generic operation-runtime module in `packages/core/src/` that builds the
   bounded context (`database`, `modules`, buffered `events`, bounded `config`,
   injected `runExternal`, bounded `trace`) — zero domain vocabulary;
3. `packages/app/src/create-app.js`: generic composition of declared operations
   and generic alias attachment, **replacing** the named Commercial lookup and
   the named Signature wiring;
4. `apps/server`: the three enumerated routes delegating to composed
   operations, behaviour byte-identical, the webhook keeping its raw-body,
   header-allowlist, synthesized-actor and non-echoing-401 semantics exactly as
   frozen in the Signature baseline;
5. AX1 and `/api/schema` additive publication of declared operations.

Nothing else. A need that exceeds this list is a new decision, not an
interpretation of this one. The Compatibility Backfill row for the seam is
written by the implementation PR (the capability lands there, and the rule
binds the PR that lands it); the DX Simplicity Gate answers travel in that PR's
body, seeded by the two ExecPlans' measurements. Both LA0 baselines are the
acceptance harness: an asserted observation that moves fails the migration,
whatever the seam's tests say.

**Consequences.** The last domain-named residue in the application factory
becomes a declared, inspectable, detach-safe edge, and AX2 can cite what a
composition can *do* at application scope, not only which records it owns. The
webhook stays special on measured grounds rather than by habit, which keeps
the raw-byte trust boundary reviewable in one place. The cost is one more
declared list on the package contract and one more generic runtime module —
paid only when the PR that pays it also retires two hand-wired attachments and
closes a private-API gap without widening the public surface.

### ADR-032 implementation addendum — applicationOperations v1 as shipped

**Status:** accepted (implementation record; the direction above is unchanged).
Written by the Signature extraction PR on a reviewer decision: *do not ship an
unused generic extension point.*

The ADR's bounded-context specification names six keys. The implementation
audited each against the only authority a v1 contract has — the two real,
shipped consumers (Commercial's catalog sync; Signature's ingest/reconcile) —
and shipped **exactly the keys they use**:

| Key | catalog sync | signature ops | v1 verdict |
|---|---|---|---|
| `database` | uses | uses | ships |
| `modules` | uses | uses | ships |
| `events` | uses | uses | ships |
| `config` | uses (`catalogTimeoutMs`) | uses (`signatureTimeoutMs`) | ships |
| `runExternal` | — | **requires** (the ADR-017 export-gap closure) | ships |
| `trace` | — | — | **not shipped in v1** |

The trace paragraph above answered "do both consumers write traces" — yes —
but writing traces is not consuming an injected writer: catalog sync persists
its `catalog.sync` run through the public `writeTrace` export it already
imports, and the Signature operations get their runs from
`runExternalOperation` itself. An injected bounded writer therefore had zero
consumers on the day it would have shipped, and a generic extension point with
zero consumers is exactly what this repository refuses to ship. Tracing stays
internal to the existing runtime/external-operation machinery.

The v1 context key set is **closed**: `{config, database, events, modules,
runExternal}`, frozen, asserted key-exact by
`tests/package-operations-seam.test.js`. An operation receives only the
documented capabilities; any additional field is non-contractual, and a
handler must not probe for undocumented ones.

> **Amended by ADR-037 (Customer Data Foundation v1): the set is now six keys.**
> `core` — the ADR-013 adapters a record action already receives as `ctx.core`
> — joined the context because a real consumer proved it necessary, which is
> the only ground this addendum accepts. The measurement, re-run independently
> at review: the core `contact` module service exposes **no filtered read at
> all** (`get` and `list` only, no `listWhere`) and `list` hard-caps at **500**
> rows, so matching an imported row's email through `modules` is not merely
> expensive — past 500 contacts it cannot find the record, which is a
> correctness bug; and matching through `database` means a package writing raw
> SQL against core's tables and re-implementing `normalizeEmail`, a second
> normalization authority that can drift from the first (the failure mode
> ADR-036 closed for term fingerprints). "Worse" therefore meant *incorrect*,
> not *more code*. The addition changes no power: `core` is a frozen,
> enumerated six-method adapter (`findContactByEmail`,
> `findCompaniesByNormalizedName`, `createCompany`, `createContact`,
> `createOpportunity`, `enterOpportunityPipeline`) that reaches no action
> registry, workflow engine, provider registry, package registry or capability
> resolver. `trace` remains **not shipped**, for the reason below, and the
> key-exact test still asserts its absence. The rule stands unchanged: a key
> is added when a consumer proves it necessary, never in advance. The bounded trace writer remains
the accepted *direction* — it is added under this ADR, with its bounds as
specified above, when the first real consumer migrates onto it (the natural
candidate: `catalog.sync` adopting the bounded writer in place of its raw
`writeTrace` call). That future change is an implementation step of this ADR,
not a new decision. The public `writeTrace`/`normalizeError` exports remain
published API, exactly as the ADR records; the raw-byte webhook remains the
explicit kernel adapter, untouched.

## ADR-033 — A commercial term is signed only when the signed document carries it, and provenance never collapses

**Status:** accepted. **Milestone:** signed commercial terms (M16b prerequisite).
**Plan:** `docs/plans/signed-commercial-terms-v1.md`.

### Context

M12 recorded every contract term as post-signature operational metadata,
honestly: the canonical document package (ADR-017) carried priced lines,
parties and signers — no term. M16b amendment execution needs the opposite
capability: terms the customer actually signed, carried with provenance that a
consumer can trust without re-deriving it. Relabeling operational terms
(rejected Option A) would make `termsSource` lie about history; deferring
(Option C) was unnecessary because the term is representable without touching
any existing row shape.

The three LA0 baselines freeze every surface a naive design would use: the
`quote`, `quote-version` and `order` family row shapes are asserted whole, the
quote/opportunity action name lists are asserted, and every existing commercial
action's input contract — `submit` included — is asserted field for field. The
design that satisfies both the milestone and the freeze is **new sibling
records plus behavior at existing gates**.

### Decision

1. **The term travels as an immutable snapshot chain.** `quote-term` is a
   public-writable DRAFT (one per quote, binding nothing). `quote.submit`
   validates it — canonical calendar round-trip, inclusive `termEndDate`,
   bounded lengths, notice-requires-autoRenew — and freezes `quote-version-term`
   (write-once, same transaction as the version). The canonical document gains
   a `terms` section **only when the snapshot exists**; the `documentHash`
   covers it; `documentContract` stays 1 because an optional additive key is
   not a new shape, and a termless version canonicalizes to byte-identical
   bytes. Verified completion — whose rebuild now includes the term — copies it
   onto the Order as `order-term` (write-once, same transaction, stamped with
   the `documentHash` it belongs to).
2. **Activation consumes, never re-types.** An order carrying a term snapshot
   refuses every manual term input (`409 SIGNED_TERMS_AUTHORITATIVE`) and
   copies the snapshot verbatim as `termsSource: "signed-order-terms"`, with a
   fixed provenance sentence instead of a collected `termsReason` — the
   signature is the reason. An order without one runs the M12 operational path
   input for input. `plan-activation` states which case applies before any
   record exists.
3. **Provenance is derived in one place and never collapses.**
   `TERM_SOURCE_SIGNED` classifies the new source `true`; the runtime
   exhaustiveness gate (ADR of M16a's capability) already refuses to open
   `contract-lifecycle-source@2` for an unclassified source, so shipping the
   enum without the classification is impossible. The capability's provenance
   sentence derives from the same map as its `signed` flag. Admin renders
   exactly one of three provenances: signed snapshot / post-signature
   operational / absent-unknown.
4. **History is never rewritten.** Existing orders have no `order-term` row and
   stay operational or absent-unknown forever; the ADR-019 enum widen is a
   declared revision-2 rebuild proven on populated tables; no backfill exists,
   silent or otherwise.
5. **Versioning follows the established doctrine.** `commercial-quotes@1` and
   `signature-orders@1` gain one additive read each (`versionTerm`,
   `orderTerm`) and keep their versions: the M16a precedent bumps a capability
   when existing answers change shape, and none do. The package versions move
   instead — commercial 2, signature 2, contracts 6 — because a package version
   describes its composition contract.

### Not modeled, deliberately

Termination and non-renewal clauses (no document this repository produces
carries them; inventing signed semantics for unsigned clauses is what this ADR
exists to prevent), billing, tax, payment terms, revenue recognition, usage
commitments, and any scheduler: `autoRenew`/`renewalNoticeDays` remain
recorded-only on both provenances. Nothing here is a legal-assurance claim;
the signature-provider limitation of ADR-017 is unchanged.

## ADR-034 — The registry entry is the remote documentation server; the project MCP is not publishable as a package

**Status:** accepted. Registry submission remains a human decision.

**Context.** `server.json` promised the MCP Registry an npm package,
`@accordo/mcp`, carrying the project MCP server over stdio with a `CRM_DB_PATH`
environment variable. It was never published; the entry pointed at a 404, and
every runbook carried "publish `@accordo/mcp`" as the next step. Reading that
step closely is what produced this ADR, because executing it would have shipped
a defect rather than a package.

`packages/mcp/src/stdio.js` builds its application through `createAccordoApp`,
and `packages/app/src/create-app.js` composes that application from *static
imports* of the generated indexes — `modules/generated`, `domains/generated`,
`actions/generated`, `pipelines/generated`. Those files are written by code
generation inside the customer's own project. A package published from this
repository necessarily carries its own copies, holding the framework's set and
not the customer's.

Pointed at a customer database through `CRM_DB_PATH`, such a package would open
their data while composing a different module set: it would answer questions
about a CRM that is not theirs, and carry the wrong migration list to a
populated database. A tool that reports confidently about the wrong application
is the precise failure the inspection rails exist to prevent
(`docs/APPLICATION_INSPECTION.md`).

It is also unnecessary. A project scaffolded by `create-accordo` already vendors
`packages/mcp/bin/server.js`, composed against its own generated indexes — the
correct project MCP server for a project is the one inside it, and it works
today.

**Decision.** The registry entry describes the read-only documentation server
already deployed under ADR-025. `server.json` carries one `remotes` entry of
type `streamable-http` for `https://accordo.dev/api/mcp` and **no `packages`
array**, which the registry schema permits for remote-only servers. The
documentation server is genuinely standalone: its corpus is deterministic and
bundled, it opens no database, and its own tests reject any import path into the
CRM runtime.

`scripts/distribution-check.js` validates the remote entry — transport type,
absolute HTTPS URL, and agreement with the domain recorded in `site/brand.json`
— so the registry artifact cannot drift from the site the way a hand-maintained
URL would.

The registry also caps `description` at 100 characters, which was found by
validating against the live API rather than by reading a schema: the entry this
repository had carried for weeks was ~440 characters and would have been
refused with HTTP 422 at publish time. That cap collides with the
intent-discovery gate, which requires every first-contact surface to carry four
intent signals and the CDP boundary — impossible in 100 characters. The registry
entry therefore leaves that gate and gets a narrower contract of its own
(`validateRegistryDescription`): stay inside the limit, name the domain, and
never claim the CRM work a read-only documentation server cannot do. The full
vocabulary lives where there is room, and `websiteUrl` sends a reader there.

**Consequences.** The MCP Registry submission is unblocked and needs no npm
artifact; only the human `mcp-publisher` step remains. The `@accordo` scope
stays empty, and should: it is claimed (checked against the registry's org
endpoint, which returns 200 with no packages while a nonexistent org returns
404) and reserved for a package that is correct standalone, which the project
server is not. Glama's npm ingestion path stays unavailable for the same reason;
its repository path is unaffected. ADR-025's boundary is unchanged — no
authentication, tenancy or RBAC exists, so the project MCP stays local, and
hosting it remains out of the question rather than merely undone.

**Rejected:** publishing `@accordo/mcp` as a thin wrapper that imports the
project's own framework from the working directory, because an npm package whose
behaviour depends on undeclared files in the caller's tree is a worse contract
than no package; and renaming the registry entry away from
`io.github.khaoss85/agent-crm`, because the namespace is what the repository
owns and a stable name outlives a description.

## ADR-035 — A renewal produces a successor agreement from signed evidence, and history is never rewritten

**Status:** accepted. **Milestone:** M16b amendment execution.
**Plan:** `docs/plans/m16b-amendment-execution.md`.

### Context

M16a recorded renewal *intent* and stopped: pricing lived in Commercial and
signature in Signature, both still inside `packages/core` with no capability to
reach them, so amendment execution would have needed a private import the
package seam refuses. Both were extracted afterwards, and ADR-033 supplied the
missing fact — a commercial term the customer actually signed, carried with
provenance a consumer can trust without re-deriving it. The deferral is
therefore dischargeable, and this ADR discharges it.

The dangerous shape is obvious and had to be refused: relabelling an existing
Contract's term and lines as "amended" would make a row that names
`documentHash` H disagree, permanently and silently, with the document it cites.
Two further shapes were compared in the plan. Amending in place is that lie;
adding a second `contract-version` to the same Contract is the same lie with an
extra indirection, because the term lives on the contract row and
`subscription.contractId` is UNIQUE, so the successor could carry neither its
own term nor its own subscription.

### Decision

1. **A renewal or amendment produces a successor *agreement*, not an edit.** The
   successor is an ordinary M12 activation of its own signed Order — its own
   `documentHash`, its own term, its own Contract, version, lines, Subscription
   and obligations — written by the **same** `writeActivation()` that
   `order.activate-contract` uses, plus one immutable `contract-succession` row
   naming what it replaces. M16b issues no `UPDATE` against any pre-existing
   contract, version, line, subscription or obligation row, and the successor
   needs no new vocabulary: every M12/M13/M15 consumer already reads it.
2. **One execution per source, enforced by the database.**
   `contract-succession.sourceContractId`, `.successorContractId`,
   `.successorOrderId` and `.executionRef` are each UNIQUE, on top of M12's
   UNIQUE `commercial-contract.orderId` and `contract-activation.orderId`. There
   is no in-process lock and no read-then-write window: the losing connection's
   whole transaction rolls back and it receives a stable code, never driver
   text. "No split lineage" is a schema fact rather than a discipline.
3. **A successor term is claimed as signed only when it was signed.** Execution
   refuses an Order carrying no `order-term` snapshot — the ADR-033 chain —
   with `409 SUCCESSOR_TERMS_NOT_SIGNED`. Post-signature operational dates are
   never promoted, and a source contract whose `termsSource` nobody classified
   (`signed: null`) refuses too, rather than being reported either way. This is
   the milestone's core invariant and it is proven by test, not asserted here.
4. **Plan and execute are different things, and the plan authorises nothing.**
   `commercial-contract.plan-amendment` writes no record, no audit entry and no
   domain event. `amendment-run.execute-amendment` is human-only and recomputes
   the signature evidence, the signed term, the customer coherence, the delta,
   the classification, the term continuity and every refusal **inside its own
   transaction**. A run recorded as `ready` is an observation with a timestamp,
   not a licence: the suite proves a stale `ready` is refused after the evidence
   moves underneath it.
5. **The classification is derived by the package that owns the evidence.**
   Contracts computes the line delta (matched on `offerLogicalKey|componentKey`)
   and derives `renewal | expansion | contraction | mixed | commercial_change`
   from it. Lifecycle — the orchestrator — never computes or supplies a label,
   because a label handed across the boundary is a client-provided
   classification. `planSuccession()` and `executeSuccession()` call one
   derivation, so a plan and an execution cannot disagree. A narrower label is
   claimed only when the evidence supports exactly one reading; a price movement
   with no quantity movement is deliberately `commercial_change`, because
   nothing about it expanded.
6. **Term continuity is recorded, and blocks only when incoherent.** Measured
   against the source's inclusive end date: `contiguous`, `gap`, `overlap`,
   `unknown`. A mid-term amendment overlaps and a lapse-then-re-signing gaps —
   refusing either would force somebody to falsify dates to record their own
   history. Only a successor term starting **before** the source term started is
   refused (`SUCCESSOR_TERM_PRECEDES_SOURCE`).
7. **The cycle is a governed run with a closed state table.** `planned →
   awaiting_signed_order | ready → executed`, and `abandoned` from any
   non-terminal state; both terminals have empty transition rows and never
   regress. `awaiting_signed_order` exists because "this order has not been
   signed yet" is a wait, while "this order belongs to a different customer" is
   a wrong pairing that waiting never fixes — the second is refused at attach
   rather than parked. **No row in that table has a clock input.** A new round
   may follow an abandoned one (`amendment-run:<contractId>:<round>`, UNIQUE);
   a round that executed closes the agreement to further rounds permanently,
   because the next round belongs to the successor.
8. **One new capability, sized by its one consumer.**
   `contracts-successor-activation@1` is offered by Contracts and required by
   Lifecycle: plan, execute, and three frozen lineage reads. It is the only
   capability in Contracts that writes, and it grants no storage handle.
   Contracts moves to `version: 7` and Lifecycle to `version: 2`, because new
   records, a new offered capability and a new required edge are all changes to
   a composition contract. `contract-lifecycle-source@2`, `delivery-obligations@1`
   and `service-obligations@1` answer byte-identically and keep their versions.

### Not modeled, deliberately

Billing, invoicing, payment, tax, usage rating, proration, revenue recognition,
MRR/ARR/TCV, FX, any scheduler, automatic or clock-driven renewal, renewal
notice delivery, customer notification of any kind, RBAC or role enforcement,
cancellation, price computation and any live catalog read. `autoRenew` and
`renewalNoticeDays` remain recorded-only on both provenances: nothing fires on
them, and no notice is ever sent. Succeeding an agreement is **not** cancelling
it, and the vocabulary reflects that — this milestone records "successor
agreement executed", never "renewed", "amended", "cancelled" or "churned".
ADR-017's signature-provider limitation is unchanged, and nothing here is a
legal-assurance claim about the instrument that was signed.

## ADR-036 — A stored fingerprint nobody recomputes is a decoration; and when a package version moves versus a capability version

**Status:** accepted. **Plan:** `docs/plans/signed-term-integrity-verifier.md`.
Closes the Medium finding (M-1) of the M16b independent review.

### Context

ADR-033 made a commercial term signed evidence: the quote version freezes a
snapshot, the canonical document embeds it, the `documentHash` covers it, and
verified completion copies it onto the Order. Every snapshot carries a canonical
`termsFingerprint`. **Nothing ever recomputed it.**

The M16b review proved the consequence: a direct-SQL mutation of `order_terms`
that leaves `document_hash` intact propagates through activation,
`contract-lifecycle-source`, M16b succession and Admin as a *signed* term. The
public surface was never the hole — every write path to these managed records is
closed, and both records are HTTP-404 for POST/PATCH/DELETE. The hole was
**evidence integrity**: a fingerprint that is stored and never checked proves
nothing, and the honest name for it is a decoration.

### Decision — the verifier, and where the authority lives

Term-fingerprint semantics belong to **Commercial**, which owns
`quote-version-term` and the canonical tuple. The verifier lives there
(`packages/commercial/src/verify-terms.js`) and is reached only through a
declared capability. **No other package recomputes a fingerprint**, and nothing
moved into `packages/core`: this is domain semantics, not runtime mechanics.

An `order-term` is a *copy*, so verification is three questions, all
Commercial's:

1. **self-consistency** — do the row's own values still hash to the fingerprint
   it carries?
2. **linkage** — are those values the ones the authoritative `quote-version-term`
   froze for the version the row names?
3. **the signed document** — are they the values inside the canonical document
   the customer actually signed?

A forgery satisfies (1) by recomputing over its own lie, and (2) catches that
one. But (1) and (2) both compare a row to another row, and the threat this
verifier models is a writer that can rewrite rows: rewriting the order copy
**and** the version snapshot together, recomputing both fingerprints, satisfies
(1) and (2) about a term nobody signed, and the same writer can INSERT a
consistent pair for an order whose signed document carried no term at all,
manufacturing signed evidence from nothing. Both were reachable, and both are
why (3) exists.

The canonical document is the anchor the first two questions cannot be: it is
what the customer signed, its bytes are stored on the envelope, and its hash is
the `documentHash` the order, envelope and artifact must already agree on — so
satisfying (3) means forging the document and every hash that covers it, not
one more row. A caller that cannot produce the signed document is refused
(`TERMS_DOCUMENT_UNAVAILABLE`) rather than silently given the weaker guarantee;
Contracts supplies it from the envelope it already holds and has already
hash-checked, so Commercial keeps the comparison and no package gains an edge.

All three are required. Refusals are `TERMS_FINGERPRINT_MISMATCH`,
`TERMS_SNAPSHOT_DIVERGED`, `TERMS_SNAPSHOT_AMBIGUOUS`,
`TERMS_NOT_IN_SIGNED_DOCUMENT` and `TERMS_DOCUMENT_UNAVAILABLE`, and they name
**ids and field names only** — echoing the planted value would put
attacker-controlled text into an operator's console.

Verification happens before a consumer may describe terms as signed: Signature
verifies the version snapshot **before the document is canonicalized and
hashed**, so a corrupt term never reaches a provider call; Contracts verifies the
order snapshot inside `loadActivationSource`, the single read that activation,
`contract-lifecycle-source` and both M16b succession paths already share.
`tests/signed-terms-consumption-guard.test.js` fails when a new file consumes
signed-term evidence without either verifying or being listed with its reason —
the omission was a class, so the guard is structural rather than remembered.

### Decision — package version versus capability version

The blanket "additive reads never need a bump" is **not** doctrine, and is
retired here.

A **package version** moves when its *composition contract* moves: the
requires/provides graph, the resource/action/operation surface composition
relies on, or startup/absence behaviour. A **capability version** moves when its
shape changes and a consumer relies on it, **a new method becomes required for
correctness**, or a **stronger semantic guarantee** is introduced. No bump is
acceptable only for optional metadata, or a field declared additive and ignored
by existing consumers, with no new consumer requirement and no stronger
guarantee. *A test file changing is never a reason to bump anything.*

Applied here: the verifier is required for correctness and carries a stronger
guarantee, so it ships as **`commercial-quotes@2`**. `@1` remains offered,
byte-identical, for any consumer that has not migrated — the registry keys
offered capabilities `name@version` (`package-composition.js`), so both compose
side by side, verified by reading the registry rather than assumed. Commercial,
Signature and Contracts move a package version because each one's composition
contract genuinely moved (a new offered capability; a new required capability).
Lifecycle does not: it consumes succession, and nothing in its own composition
contract changed.

### Recorded invariants (M16b, restated so they are citable)

- **Linear successor, v1.** One executed successor per source cycle; no
  branching successor graph; an abandoned round may be replaced; an executed
  successor may itself become the source of a later cycle; historical source
  records are never rewritten. This is a **v1 business invariant**, not a
  universal law — a future milestone may model branching, and would say so.
- **No signed-term backfill, ever.** A record without a snapshot stays unsigned,
  operational, or absent-unknown. Signed provenance is never inferred from
  later operational dates, and no migration invents one.

### Compatibility — an intentional tightening

No snapshot → unchanged historical behaviour. Valid snapshot → **byte-identical**
outcome (all three LA0 baselines replay unmoved). Invalid snapshot → **fails
closed**, where it previously passed silently. That last line is a deliberate
behaviour change and the whole point of the ADR.

## ADR-037 — The customer foundation links and projects existing records; it never becomes a second copy of them

**Status:** accepted. **Milestone:** Customer Data Foundation v1.
**Plan:** `docs/plans/customer-data-foundation-v1.md`.

### Context

Accordo can price, sign, activate, deliver, service and renew a customer, but
it had no trustworthy answer to "who is this customer, where did that record
come from, and is it the same person as that other record". Every package
carries its own slice — Company and Contact in the host, party snapshots frozen
on Orders and Contracts, subjects on Work tasks — and nothing tied them
together or recorded provenance.

The obvious shape is a master customer table that every package points at. That
shape is wrong here, and the inventory says why: `contacts.email` is already
`NOT NULL UNIQUE` in the core schema, nine packages already reference
`companyId`/`contactId`, and the customer columns on `order` and
`commercial-contract` are **immutable party snapshots frozen at signature** —
evidence of what was signed, not the current truth about a person. A master
table would duplicate mutable truth, fight the existing uniqueness rule and
require a cascade rewrite across every package that already resolves those ids.

### Decision

**Existing business records remain the source records. The foundation adds four
things beside them: identity, provenance, lineage and projection.**

1. **Package-native, named `customer-data`.** Not core: customer identity,
   dedupe policy and data-quality semantics are domain behaviour, and
   `duplicate-candidate` fails the ADR-018 test for what core may own. Optional
   like every other package — remove the composition line and the application
   keeps working, with every row still on disk.
2. **No master customer record.** Six records, none of which copies a business
   record: an import run, its per-row receipts, external identities, duplicate
   candidates, canonical links and data-quality issues. Every reference to a
   record another package owns uses the **ADR-030 subject envelope**
   (`subjectResource`/`subjectId`/`subjectOwner`/`subjectOwnerPackage`), so
   this package takes no foreign key on, and stores no copy of, anybody else's
   table.
3. **Matching is deterministic and explainable, and never guesses.** Exact
   external identity, then exact normalized email, then exact company name
   **and** exact domain. Ambiguity is a first-class answer: the row resolves
   `unresolved`, a duplicate candidate is recorded with the rule and evidence
   that produced it, and no rule breaks a tie. There is no fuzzy comparison, no
   score, no threshold and no ML.
4. **Canonical identity is a LOGICAL link, decided by a human.** Linking writes
   cluster membership; it deletes no row, rewrites no field, touches no other
   package and cascades nowhere. Every linked record still exists and still
   resolves, and the profile follows the cluster. Physical consolidation is
   deliberately deferred to a named **Customer Data Operations v2** track,
   together with global search, saved views, bulk actions, export at scale and
   any retention or erasure workflow.
5. **The profile is a projection, not a table.** It reads across whatever
   packages are composed and stores nothing. A package that is not composed
   reads **`available: false` with a reason** — never `[]` and never `0`,
   because an empty list from an uninstalled package is a lie in the place a
   reader is most likely to believe it. The profile states that it is **not** a
   complete cross-channel timeline, because marketing, analytics and external
   events are not represented.
6. **Import: preview writes nothing, apply re-proves everything.** Preview
   returns the receipts it would write and leaves the database byte-identical.
   Apply recomputes the resolution inside its own transaction — a preview is
   never an authorisation. The idempotency key is derived from the system, the
   mapping fingerprint and the sorted row digests, so a retry of the same
   payload returns the same run and a clock never enters it. Acceptance is an
   explicit choice; under the default partial mode every rejected row carries a
   receipt and `accepted + rejected + skipped === rows` is asserted rather than
   assumed.

### The one seam change: `core` joins the ADR-032 operation context

The bounded application-operation context gains a sixth key, `core` — the
ADR-013 adapters a **record action already receives** as `ctx.core`. It was
added because a real consumer proved it necessary and both alternatives were
measured and worse: the core module services cap `list()` at 500 with no email
filter, so matching through `modules` becomes a correctness bug the moment a
project has more contacts than that; and matching through `database` means a
package writing raw SQL against core's tables and re-implementing core's own
normalization. The rule the addition follows is the rule ADR-036 recorded: a
key is added when a consumer proves it necessary, never in advance.
`normalizeEmail` and `normalizeCompanyName` are published from `packages/core`
for the same reason — so a package that *stores* a normalized form uses the
identical rule the adapters *match* with.

### Security and governance

PII-capable data is involved. No raw source payload, credential or secret is
stored anywhere — external identity keeps the identifier and its provenance and
nothing else. Input is bounded (rows, fields, lengths) and control-safe using
**the repository's existing strictest PII string policy**, the signer class from
`packages/signature/src/operations.js`, reused rather than reinvented and proven
identical code point by code point. Every human identity decision is audited
with its actor and reason. Retention is limited to what the records above hold,
and **erasure versus immutable evidence is explicitly unresolved and
legal-policy dependent**: a signed Order's party snapshot is evidence of what
was signed, and this milestone does not decide whether or how that may ever be
removed. The Production Spine does not exist, so a human actor is an audit
identity and not role enforcement, and the profile and Admin both say so.

### Not modeled, deliberately

A CDP, a warehouse or lakehouse, real-time activation, a probabilistic identity
graph, ML entity resolution, arbitrary ETL, global full-text search, a consent
platform, GDPR or any legal assurance, retention and erasure workflows, and a
cross-channel timeline. **This is not a shipped CDP and is not described as one
anywhere.**

### Evidence, and what the evidence could not reach

The fourth checked-in journey and scenario, `customer-identity-governance`,
composes **the customer-data package and nothing else** — which is not a
convenience: with no other package present, the profile's `available: false` is
an *observed* fact rather than a rendering detail, and it is the strongest form
this decision's fifth point can take. The journey earns its safety facts by
attempting them: it drives a genuinely ambiguous row and publishes that no tie
was broken, attempts an agent actor, an out-of-candidate canonical record and a
reasonless decision, and searches every text column of every table in the
database for a field the mapping does not know.

Three JTBD rows move to *partially supported* on stated readings — DO-01 (no
CSV: bounded JSON rows), DO-02 (import only, nothing fuzzy), DO-03 (logical
link, no physical merge) — and DG-04, DO-07 and DO-08 are guarded in the matrix
against inheriting anything from them.

**One thing the evidence could not reach, recorded rather than hidden.** This
package's principal surface is three ADR-032 *application operations*, and the
DX6 observation vocabulary has no `operation.present`: it can observe a package,
a resource, a module, an action, a capability and a policy, but not a declared
operation. The scenario therefore proves the operations *work* through
`journey.fact` and proves the package's *shape* through its resources, policy
and record actions. Widening a closed vocabulary is a framework change and was
deliberately left outside this milestone; `docs/SCENARIO_EVIDENCE.md` records
the gap, and the second package to declare an operation is when it should be
closed.

### Review amendment — a read that decides something is never a display page

Raised in independent review of the implementing PR, fixed in it, and recorded
here because it revises how the fifth point above must be read.

The generated record service offers two reads and they are not
interchangeable. `list()` is a bounded **display** page: it clamps whatever
limit it is given into `1..500` and returns the newest rows first.
`listWhere()`/`countWhere()` are the complete exact-match correctness queries
(ADR-015), and the generated source says so beside them. This package asked
`list({ limit: 1000 })` in nine places and believed the answer. The bound is
not exotic — 250 decided duplicate pairs write 500 canonical-link rows — and
past it, measured on a real application:

- the profile reported `linked: false`, *"no canonical identity decision has
  been recorded for this record; it stands for itself"*, for a record a human
  **had** linked; and
- `ALREADY_IN_CANONICAL_CLUSTER` — the guard whose stated job is to refuse a
  decision that would "silently rewrite an earlier one" — stopped firing, so
  one record became canonical of one cluster and alias of another.

So: **every read in this package that decides something is complete by
construction**, through one helper that says why. A cluster read from a page is
a cluster that loses members as the table grows, and a guard that stops firing
at scale is not a guard.

The same review found the fifth point held in only one direction. `available:
false` was scrupulous, but a *composed* package whose record declares no
reference this projection can follow reported `count: 0` — which reads as "this
customer has none", and was false: a quote names an **opportunity**, not a
company. Absence is therefore honest in both directions now. The profile
follows the opportunity reference (a record it has already resolved for this
customer, not a guess); a section it genuinely cannot reach reads `available:
false` with that reason rather than a zero; and every readable section publishes
`countIsComplete`, so a number taken from a bounded page is reported as a floor
instead of a total.


## ADR-038 — The framework authenticates nobody, and owns every decision that follows

**Status:** accepted. **Milestone:** Production Spine v1.
**Plan:** `docs/plans/production-spine-v1.md`.

### Context

The repository holds customer identities, external identifiers, canonical
links, signed commercial terms, contracts, subscriptions, delivery, service and
work records — real PII-capable data — behind a runtime with no authentication,
no tenancy and no authorization. Three facts made that concrete rather than
rhetorical:

1. `normalizeActor()` returned `SYSTEM_ACTOR` — the most privileged identity in
   the framework — for `null`, a string, or an unknown `type`. **The safest
   input produced the strongest identity.**
2. `actorFromRequest()` read `x-actor-type` and `x-actor-id` and, when they were
   absent, invented `{type: 'user', id: 'api-user'}`. Any caller was any user,
   and a missing header produced a valid-*looking* one.
3. No record, table, service or action carried a tenant at all.

Every "a human decided" in this codebase meant *an actor object said so*.

### Decision

**The framework authenticates nobody. It owns everything after that.**

A deployment adapter verifies the request and supplies a bounded, versioned
identity context. The framework owns the contract, the tenant selection,
membership, the authorization decision, the audit evidence and a fail-closed
boundary. Four options were compared:

- **A — trust the headers, add role strings.** Rejected: authorization over an
  unauthenticated identity is decoration that makes the audit log *more*
  confident and no more true.
- **B — passwords, sessions and credentials in core.** Rejected for v1: it makes
  the framework an identity provider, which is a security scope of its own.
- **C — verified identity adapter + framework authorization boundary.**
  **Chosen.** The framework never learns a secret, and the one thing it must own
  — the decision — it owns completely.
- **D — a provider-specific auth package.** Rejected as a kernel dependency. No
  vendor name appears in `packages/core`, and a reference adapter may live
  outside it later.

### The four identity kinds, which never blur

`verified-user` · `system` (bounded authority: a webhook may reconcile, it may
never approve a discount) · `asserted-local` (accepted only in explicit
local-development mode) · `anonymous` (authorizes nothing, and is the one kind
with no subject, because inventing one would be the same fail-open this ADR
removes).

**No token, credential or secret enters the contract, the audit log, the trace
or an error message.** The contract carries a *fingerprint* of the claims the
adapter accepted, so a decision can be tied to its evidence without the
evidence being stored.

### An Accordo Organization is not a CRM Company

A **Company** is a customer recorded *inside* one tenant's data. An
**Organization** is the tenant — a customer of the software. The distinction is
in the table names (`spine_organizations`), the store, the schema block, the
Admin and this ADR, because blurring it would make "grant someone access to a
Company" sound reasonable, and from there one tenant's customer list leaks into
another tenant's authorization model.

### Permissions, and why not the two obvious shapes

Eleven **bounded semantic permissions** bundled into roles. A fixed role enum is
immediately inflexible; one permission per method looks rigorous, produces
hundreds of unreadable keys, and ends with everyone granted all of them. `owner`
is an explicit list rather than "all permissions", so adding a permission later
cannot silently widen an existing role.

`requiredApprovalKey` values stay **descriptive labels**. Promoting them into
enforced permissions would change the meaning of records already written.

Membership administration carries two non-negotiable rules: **nobody grants a
permission they do not hold** (otherwise `admin.memberships.manage` is silently
equivalent to all of them), and **the last active administrator cannot demote or
suspend themselves** (not to protect them, but to stop an organization becoming
permanently unadministrable).

### The mode is explicit, and production fails startup

Two modes, no default. The mode is **never inferred** from localhost,
`NODE_ENV`, an interface address or a missing config: a proxy, a container
network or a misread `X-Forwarded-For` all make a production request look local.
An unset mode is an error, because "I forgot to configure it" and "I meant the
permissive one" must not be the same input. Production **fails startup** without
an identity verifier and a tenant strategy — a refused boot is investigated, a
refused request at 3am is retried.

Local-development mode keeps today's developer experience through a **real
membership row** an operator can list and revoke, not an invisible branch inside
the authorizer. An assertion is never promoted to a verification.

### Tenancy: the honest choice, and what it is not

Row-level tenancy — an `organization_id` on every mutable table — is the right
long-term answer and was **not** attempted here: **86+ tables** (76 module
manifests plus 10 core), a backfill of every shipped database, every unique
constraint reworked and every correctness path rescoped. A half-migrated version
of that is worse than none, because it *looks* isolated.

v1 *declares* a **versioned TenantStorage boundary: one database per tenant.**
Two tenants would not cross-read because they would not be in the same database,
not because a `WHERE` clause was remembered. A tenant id is untrusted input on a
filesystem path, so traversal, absolute paths, NUL, uppercase and over-length are
refused and the resolved path is proven to be inside the root anyway.

**This is explicitly not shared-database multi-tenancy, and nothing in this
repository may describe it as such.** Row-level tenancy in PostgreSQL is Spine
v2.

#### Amendment 1 — the boundary shipped unwired (review finding F-2)

The paragraph above described a boundary that shipped **declared and not
delivered**. `createTenantStorage` was defined, validated a tenant id and
resolved one file per tenant; nothing called it. `tenantStrategy` was checked
for presence at startup and then never used. The authorizer answered *"may this
subject do this?"* and never *"does this row belong to this subject's tenant?"*,
so a single application holding two organizations held both in one database.

Measured, against a production-mode application with a verifier configured and
two bootstrapped organizations: the owner of A creates a company; the owner of B
requests `GET /api/companies` and receives **200 with A's record in it**; B's
write appears in A's list; and B reads `GET /api/audit` and receives rows
authored by A's owner. The control plane held — B's owner pointed at A was
`403 MEMBERSHIP_MISSING`.

#### Amendment 2 — closed by binding, not by filtering

A human decided the model, and it is enforced rather than documented:

> **one running Accordo application instance ↔ one authoritative tenant data
> plane ↔ one tenant storage binding**

**Shared-database row-level tenancy is explicitly rejected as the fix.** It is a
later slice across 86+ tables, and it is not required by the deployment model
this product is entering, which provisions one isolated instance and database
per tenant. **Multiple CRM tenants inside one application are not supported**,
and that is the enforcement rather than a limitation: a configuration that would
need it is refused at startup.

**What "wired" means here.** A spine-composed application takes its CRM database
from the binding and refuses an explicit `dbPath` beside it, because two answers
to *"where does this tenant's data live"* is the exact shape the defect had.
`bindTenantStorage()` resolves one tenant and returns an object that carries
`dataPlanePath` and `controlPlanePath` and **exposes no `databasePathFor` at
all** — a second tenant is not refused by a check somebody could forget, it is
unreachable through the handle the application holds. There is no branch in
which a bound application can reach the unscoped shared database, because no
such handle is ever constructed.

**Two runtime planes and two files; fresh schemas are disjoint.** Control-plane
migrations (organizations, memberships) and data-plane migrations (CRM) are
separate lists. A fresh tenant database has no membership table and a fresh
control database has no CRM table, so a write that crossed the boundary raises
`no such table` rather than quietly succeeding. The released v1-v5 combined
database remains adoptable as the control file and may retain dormant CRM tables:
the enforced claim there is that CRM services never receive or use the control
handle, not that adoption deletes historical data. The combined list remains the
default, so every composition without a spine is unchanged.

**The tenant is never inferred** — not from localhost, `NODE_ENV`, the listening
interface, the first membership, the first Organization row, a header, a body or
a claim the framework did not bind itself. The strongest temptation is *"there is
only one organization, so use it"*, and it is wrong because it makes provisioning
order a security control: an instance booting before its organization exists, or
after a control plane creates a second, would silently change whose data it
serves.

**A verified identity that names no tenant is refused**, not assumed to mean the
bound one. Assuming would mean a token minted for tenant A is honoured by tenant
B's instance — the cross-instance replay that one-tenant-per-instance exists to
prevent. Requiring the identity to state its tenant, and requiring equality with
the binding, is what makes "each tenant has its own instance" a boundary rather
than a deployment convention.

**The order of refusal is deliberate.** *401* for a caller who presented nothing
— a statement about the request, not about what exists here, so it discloses
nothing and stays useful. Then *404* for any tenant but the bound one, because a
403 would confirm that the organization exists and that this instance knows
about it, and across a tenant boundary that confirmation is the disclosure; the
refusal echoes no id and no slug. Then *403* inside the bound tenant, where the
distinction is about the caller rather than about the data. **Membership is
necessary and not sufficient**: a membership in another organization is refused
before any permission is considered.

**The refusal matrix**, all at startup, all with stable codes and none carrying a
filesystem path or a configured value: `SPINE_VERIFIER_REQUIRED` ·
`SPINE_TENANT_STRATEGY_REQUIRED` · `SPINE_LOCAL_TENANT_REQUIRED` ·
`SPINE_BOUND_TENANT_REQUIRED` · `SPINE_BOUND_TENANT_INVALID` ·
`SPINE_TENANT_STORAGE_ROOT_REQUIRED` · `SPINE_MULTIPLE_DATA_PLANE_BINDINGS` ·
`SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE` · `SPINE_BOUND_TENANT_UNKNOWN` ·
`SPINE_LOCAL_MODE_REMOTE_BIND` · `TENANT_PLANES_COLLIDE`. Not echoing the value
matters most on `SPINE_BOUND_TENANT_INVALID`, whose input is attacker-chosen on
precisely the path where an attacker-chosen string reached a path resolver.

**Local-development mode may only listen on loopback.** That mode accepts
asserted identities, so anyone who can reach the socket can claim to be anyone;
an omitted host means every interface, which is the worst case rather than the
safe one, so it is refused too.

#### Amendment 3 — the actor boundary fails closed

`normalizeActor` returned `SYSTEM_ACTOR` — the strongest identity in the
framework — for `null`, a string, an unknown `type` and any malformed object.
A review argued it was unreachable from any public adapter, and that was true
*because of two properties nothing tested*: `actor` happened to be spread last
in two request handlers, and `identityToActor` happened to be total. A boundary
that holds by coincidence holds until somebody writes `{ actor, ...body }`.

So it was measured rather than argued. Instrumented, the fallback fired **three
times across the whole suite**, every one an e2e fixture passing
`{type: 'human', id: 'e2e'}` — an unknown type laundered into root. Nothing
depended on it.

Now: a malformed actor becomes the **least-privileged** identity; prototype
-inherited `type`/`id` do not count, because an actor found on a prototype is
one somebody arranged to be found; `SYSTEM_ACTOR` is reachable only through
`trustedSystemActor(reason)`, so grepping that name is a complete audit of where
the framework claims its own authority; and request payloads have
server-controlled keys **stripped** rather than overridden, so the property no
longer depends on the order of an object spread anywhere.

#### Amendment 4 — a control mutation and its tenant audit cannot share a transaction

Organization and Membership mutations live in the shared control plane; their
security audit lives in the bound tenant data plane. Production Spine v1 wrote
the control row first and then called the audit sink. If the second write failed,
the caller received an error even though the authorization state had committed.
Measured on `bootstrapOwner`: the membership was active, the data audit count
was zero and the caller saw the injected failure. That is a false rollback over
committed security state.

**Decision: bounded immutable audit intent, not a claim of cross-database
atomicity and not a general outbox.** Each of the four writers — Organization
create and Membership bootstrap/grant/suspend — performs every state,
authorization and concurrency read, the mutation and one audit intent inside a
single `BEGIN IMMEDIATE` control transaction. Intent identity is the canonical
tenant slug plus entity type/id and positive safe mutation revision. Its payload
fingerprint is separate, so changed evidence under the same revision refuses
rather than minting a second plausible audit.

The destination has two persistent parts. The tenant data file mints an opaque
random marker `{tenant slug, dataPlaneId}` first. The control mapping is keyed by
slug and may begin with a NULL id when another Organization is provisioned in
the shared control plane; the first application configured for that tenant CASes
NULL to its own marker id. A different physical file mints a different id and
loses stably. This is **first-configured-file-wins**, not resource attestation:
a copied file carries the marker, and leases, clone promotion and external
resource identity remain later M4 work.

Delivery order is load-bearing and never holds both SQLite write locks:

```text
short control eligibility transaction
→ independently committed exact data-audit transaction
→ short control pending-to-delivered CAS
```

A crash after the data commit leaves the intent pending; retry verifies the same
exact audit and closes it. A caller-owned transaction on either plane refuses
namedly, because joining it could mark an audit delivered before the caller
rolls the data write back. A poisoned pending intent is reported independently
and cannot starve later work; each pass is bounded while its `pending` count is
exact.

Compatibility is explicit. The public
`createSpineStore({database,audit?,now?})` still accepts the framework wrapper or
direct SQLite input, returns only Organizations/Memberships and keeps its v1
error precedence and successful result shapes. Public `AuditLog.record()` still
owns id and time. Exact insertion and the recoverable store are deep-internal,
unexported factories. On delivery failure only, the committed entity gains a
bounded `committed_with_pending_audit` receipt; ordinary success stays
byte-shape compatible. The application exposes one tenant-scoped, frozen
`auditIntents` contract for bounded listing and explicit reconciliation. It is
not a lease, retry worker, scheduler, arbitrary message queue or deletion API.

Both methods accept only a non-proxy plain options object with the optional
integer `limit` in `1..100`; invalid shapes and accessor properties refuse with
stable credential-free codes. The public v1 Organization/Membership list
behavior is unchanged behind the closed storage seam: a negative numeric limit
means SQLite's historical unbounded listing, while zero or `NaN` selects the
released default.

Startup owns every SQLite handle until it returns the application. A failure at
any later composition step closes both handles without replacing the original
error. Migration startup rechecks each ledger row only after acquiring its
bounded write lock, so two cold processes converge; a persistent lock becomes
`CORE_DATABASE_STARTUP_BUSY`, never a raw SQLite error. Every known core
migration row is name-validated regardless of the selected plane, and data-only
or control-marked files used for the opposite plane refuse as
`CORE_DATABASE_PLANE_MISMATCH`. This identity is a migration-family boundary,
not M4 resource attestation.

#### Amendment 5 — one closed deployment-storage loader, PostgreSQL refused before connect

Three executables selecting storage independently is how a deployment boots
PostgreSQL unbound or prints a credential. `--db` cannot carry a spine binding
or a secret connection, so it stays SQLite compatibility only.

**Decision: one versioned loader over a closed JSON envelope**, with exact keys
`{contract, adapter, connection, controlPlane, spine, identityVerifier}`. Extra
keys refuse. The document is opened with no-follow / owner-only / no group-or-
other bits, and every pre-parse failure shares `DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED`.
PostgreSQL production TLS is a parser field: plaintext, `sslmode=disable|allow|prefer`,
verification-disabled settings and a missing production TLS block refuse as
`DEPLOYMENT_STORAGE_TLS_REFUSED` without opening a socket. A valid PostgreSQL
document then refuses as `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED` before any
connection; M3 owns the driver. Config and `--db` together refuse as
`DEPLOYMENT_STORAGE_DB_CONFLICT`. Diagnostics carry no path, file bytes or
credential.

The loader is an internal runtime capability in `packages/core/src/deployment-storage.js`
and is not published on the domain-package kernel. Factory, CLI and MCP do not
call it in the PR that introduces the parser; wiring those surfaces is a later
M2F slice. `identityVerifier` is parsed as an opaque relative path; ESM
resolution is Amendment 6 / M2-22. Replacing every public locator with `{adapter, available}`
is the remainder of M2-08.

Plan: `docs/plans/spine-v2-m2f-deployment-storage.md`.

#### Amendment 6 — FIFO/TOCTOU-safe open and identityVerifier pre-connect

A config path that is a FIFO hangs `openSync` without `O_NONBLOCK`. A
stat-then-read on the path, rather than on the opened fd, is a TOCTOU: the
bytes parsed can belong to a different inode than the metadata just checked.

**Decision: one internal trusted-file helper** opens with
`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (refusing when a flag is unavailable),
`fstat`s that fd, requires a regular owner-only file, reads from the same
descriptor, and refuses if inode/dev/uid/mode/size change. The deployment-storage
loader and the identity-verifier resolver share it.

**Decision: a sibling pre-connect resolver**, not an async parser.
`loadDeploymentStorage` stays the synchronous closed-envelope function.
`packages/core/src/identity-verifier.js` resolves the repository-relative ESM
reference before any database connection or listener exists. The module
namespace is closed (`identityVerifierContract`, `identityVerifierTrust`,
`createIdentityVerifier`); the factory receives only `{ mode, signal }`; the
returned operations are exactly the v2 five. Discover/attest names are wrapped
to `IDENTITY_VERIFIER_OPERATION_UNSUPPORTED` and never call through. The whole
pipeline — realpath, trusted open, `import()`, factory — runs under
`IDENTITY_VERIFIER_INIT_TIMEOUT_MS`. Hang fixtures (factory and top-level
`await`) are proved in a child process that exits inside the bound. Diagnostics
carry no path, file bytes or credential.

Neither module is published on `packages/core/index.js`. Factory, CLI and MCP
still do not import them. Live discover/attest is M3.

Plan: `docs/plans/spine-v2-m2f-verifier-preconnect.md`.

#### Amendment 7 — CLI/serve/MCP consume the shared pre-connect loader

The loader and verifier resolver were published unwired so a parser defect could
not become a production boot defect. The consumers now exist.

**Decision: every application executable calls `prepareDeploymentPreconnect`.**
The ratified flag is `--deployment-storage`; the env is
`ACCORDO_DEPLOYMENT_STORAGE`; `--db` stays SQLite-only and refuses when combined
with the document. No executable invents `--adapter`, `--pg-url` or a second
envelope parser. `createAccordoApp` does not import the loader.

**Decision: PostgreSQL documents refuse at the loader before composition.**
`APP_COMMANDS` is exported as the canonical authority. Each entry is classified;
`serve` is `READ_ONLY_SUPPORTED` once an adapter exists, and every other
application command is `STABLE_REFUSAL_ON_POSTGRESQL`. At M2 the loader code
`DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED` fires first because there is no
driver.

**Decision: document-selected public output is `{ adapter, available }`.**
SQLite `--db` path disclosure remains where M0 ratified it. Replacing
`app.doctor().database` is the remainder of M2-08.

**Decision: production MCP (`ACCORDO_MODE=production`) does not load the
document, compose, connect or migrate.** Allowlisted resources are checked
source only. Data-bearing tools, traces, doctor, runtime prompts and scaffolding
refuse `MCP_PRODUCTION_SURFACE_UNAVAILABLE`. Local `--db` MCP is unchanged.

**Decision: a SQLite document selects `connection.path` as the historical
combined database path after the verifier passes.** The envelope tenant is
`{ id }` and is not a full ADR-038 binding (`storageRoot` is still required
there). This PR does not invent a storage root from a locator.

Plan: `docs/plans/spine-v2-m2f-entry-wiring.md`.

#### Amendment 8 — Spine v2 M3A: dialect migration intent, checksum ledger, driver pin

PostgreSQL storage is still unimplemented. This amendment records the
authoritative migration shape M3B will execute, without adding a driver or
claiming the application runs on PostgreSQL.
<!-- truth: spine.postgresql.implemented=absent -->

**Decision: migration intent is an explicit structure, not a SQL translator.**
Core schema is described under `packages/core/src/core-schema-intent.js` and
rendered per dialect. SQLite render is byte-identical to the released
`DATA_PLANE_MIGRATIONS` / `CONTROL_PLANE_MIGRATIONS` strings, which stay the
SQLite migrator’s input. PostgreSQL SQL is authored from the same structure:
persisted integers and cents are `BIGINT`, booleans `BOOLEAN`, timestamps
`TIMESTAMPTZ`, tables in schema `accordo`, identifiers quoted through the
physical-name map. Arbitrary SQLite SQL is never parsed at runtime.

**Decision: physical names are mapped before DDL.** PostgreSQL identifiers are
capped at 63 bytes. Safe `[a-z][a-z0-9_]*` names at or under that length stay
unchanged; otherwise a bounded prefix plus a collision-resistant digest is
recorded. The complete namespace is validated before DDL. Server truncation is
not a strategy.

**Decision: `schema_migrations` grows a checksum through version 8.** Every
plane receives `schema_migrations_checksum` once. Backfill writes the **pinned**
released checksums (M0 v1–v5 plus the subsequently released v6–v7 identities),
never `hash(current source)`. An unknown `(version, name)`, a missing object or
a divergent schema fails closed. New migrations record `hash(sql)` normally.
Existing SQLite files with exact M0 identity still boot.

**Decision: the production PostgreSQL driver is `pg` exactly 8.23.0,
PostgreSQL server major 16, no `pg-native`.** Agreed with M3B. A home-grown
wire protocol would duplicate TLS, auth, prepared statements, COPY, error
fields and cancellation; `pg` is the audited client. Pin exact, never float
latest, never `try/catch` the import. This PR does **not** add the npm
dependency. SQLite remains Node built-in.

Plan: `docs/plans/spine-v2-m3a-postgresql-migration-intent.md`.


### The spine is opt-in, and its absence is loud

`createAccordoApp({ spine })` turns it on. An application composed without it
behaves exactly as before — and `/api/schema` publishes that in the same field,
rather than omitting it. A reader who has to infer the absence of a security
boundary from a missing key will eventually infer wrong.

### What versioned, and what deliberately did not (ADR-036 doctrine)

**Two framework contracts bumped; no package did.** Under the doctrine a
contract version moves when a required shape or a semantic guarantee changes,
and both moved twice over:

- **`spineContract` 1 → 2.** The published block replaced
  `tenantStrategyDeclared` and `crmDataPlaneEnforced: false` with a bound tenant
  and enforced isolation. A consumer reading the v1 shape would draw the
  *opposite* conclusion about the same deployment, which is exactly what a
  version exists to signal — a silent change here is a reader believing a stale
  answer about a security boundary.
- **`tenantStorageContract` 1 → 2.** v1 offered an unbound resolver and promised
  isolation it did not deliver; v2 offers a binding with no way to name a second
  tenant, and enforces it.

**No domain package moved**, and that restraint is deliberate: none of their
declarations, requires or capability shapes changed. Bumping every package
because the framework grew a boundary would be version noise that teaches
readers to ignore versions.

Otherwise: the runtime now authorizes what packages already declared, which is a
runtime change rather than a contract one
— and bumping every package because the framework grew a boundary would be
version noise that teaches readers to ignore versions.

Two additive contract fields were introduced instead, both backward-compatible
and both framework-enforced:

- **`requiredPermission` on a record action.** An action that declares nothing
  requires `records.write`, the honest floor for a mutation. When an action's
  required permission becomes contractual — when a consumer relies on it — that
  is the point to version the action contract deliberately, not before.
- **`headers` on the SDK client.** Without it the SDK could not present a
  verified identity at all and every call against an authorizing server
  returned 401. The client forwards what a caller hands it and stores no
  credential of its own.

### What may be claimed, and what may not

**May be claimed.** Spine v1 supports a controlled real pilot: **one
organization per deployed instance**, verified users, server-authoritative
permissions, and an isolated tenant database enforced by the storage binding
rather than by a filter.

**May not be claimed**, and is not claimed anywhere in this repository:

- multiple organizations inside one application,
- shared-database multi-tenancy or row-level tenancy of any kind,
- PostgreSQL — it is not implemented,
- durable jobs, an outbox or a scheduler,
- secret management, backups, restore or any recovery SLA,
- general production readiness, or any SOC2 or GDPR posture.

Those remain Spine v2, v3 and v4 in `ROADMAP.md` with explicit ownership rather
than scattered through limitation strings.

---

## ADR-039 — Product claims are generated from executable authorities and cited by stable fact id

**Status:** accepted. **Milestone:** Repository Truth Contract v1.
**Plan:** `docs/plans/repository-truth-contract-v1.md`.
**Reference:** `docs/REPOSITORY_TRUTH.md`, `scripts/repo-truth.js`,
`docs/repository-truth.json`, `tests/repository-truth-contract.test.js`.

### Context

Production Spine v1 (ADR-038) changed what the runtime does. The documents that
describe the runtime did not change with it, and **every gate passed anyway**.
Twice, measurably, in the two days before this ADR was written:

1. `crm app inspect` published `productionPosture: "no authentication, tenancy
   or RBAC exists"` in the **same report** whose `PRODUCTION_SPINE_ABSENT`
   message described identity, tenancy and authorization. Fixed in PR #101.
2. The `tenant-isolation-and-authorization` scenario published
   `TENANT_ISOLATION_NOT_ENFORCED` and *"the framework does NOT enforce it"*
   **after** ADR-038 Amendment 2 closed that gap by binding. Fixed in PR #102 —
   found by a person reading the file, not by a gate.

The shape of the failure, which is the whole design driver:

```text
code implemented Production Spine v1
  → schema/runtime truth changed
  → PROJECT_STATUS / JTBD / claims / scenario limitation metadata stayed
    MUTUALLY CONSISTENT but stale
  → every existing gate passed
```

> **Existing gates check consistency *between* documents. These documents were
> consistently wrong *together*.**

`scripts/measurement.js` compares `docs/PROJECT_STATUS.md`'s `Measured at` row
against `site/claims.json` — two documents. `scripts/site-check.js` matches a
numeric pattern. `scripts/generate-jobs.js` regenerates one index from one
Markdown source. **None of the three has any tie to what the code does**, so all
three stayed green while the code moved out from under the prose. ADR-027 solved
the same problem for *one number* by making it measured rather than typed; this
ADR generalises that discipline from a count to a claim.

### Decision

**A product claim in a current document is bound to a fact generated from an
executable authority, and cited by a stable fact id.**

`docs/repository-truth.json` (`repositoryTruthContract: 1`) is generated by
`scripts/repo-truth.js` from source, receipt and measurement authorities.
Current documents cite `<factId>=<value>`; `npm run repo:truth -- --check` fails
when the committed document is not a fresh generation, when a citation resolves
to nothing, when a cited value is not the one the authority now produces, or
when a bound document names a machine code no source declares.

Four options were compared:

- **A — more grep rules over prose.** *Rejected as the primary design.* It
  misses reworded falsehoods: instance 2 above is exactly what a phrase-matching
  rule misses, and it makes truth depend on phrasing. One bounded lexical rule
  survives from it deliberately (below), and it is a rule about **identifiers**,
  never wording.
- **B — one hand-maintained status JSON.** *Insufficient alone.* A human can
  update it independently of the code, which is the failure itself: it would
  have been updated in the same pass that left the scenario metadata stale.
- **C — generated executable product facts, cited by stable fact id.**
  **Chosen.** The authorities that produce the facts are the same objects the
  application runs on, so a fact cannot be updated without changing the code, and
  a claim cannot survive the code it describes.
- **D — an LLM semantic reviewer as a deterministic merge gate.** *Rejected.* A
  merge gate must be reproducible byte-for-byte offline, and a model is neither.
  It may return later as a **non-blocking** reviewer; never as the gate.

### The rule the whole contract turns on

> **A fact never silently defaults from a missing authority, and `false` is
> never inferred from absence unless the contract defines that meaning.**

- An unreadable **source** authority is `TRUTH_AUTHORITY_UNAVAILABLE` and refuses
  the whole document. Nothing is written.
- An unverifiable **receipt or measurement** authority refuses *its own* facts
  and fails the run, while the source facts still stand — because collapsing the
  document over a shallow clone would stop the citation and machine-code rules
  running in the one job that runs on every push.
- Two authorities that disagree are `TRUTH_AUTHORITIES_CONTRADICT`, and **neither
  answer is published**: a fact already built is withdrawn rather than left
  standing beside a problem nobody reading `facts[]` would see.
- Where absence *is* the meaning, the contract names the rule — **declared
  absence** (a list the source declares as not modelled: `SPINE_NOT_MODELED`,
  `TENANT_LIMITATIONS`, the frozen journey registry's limitation codes) and the
  **namespace probe** (a product area is `absent` when no resource, action,
  capability or policy in a reference composition that resolved cleanly carries
  any declared prefix). `not_measured` is a statement *about measurement*, never
  a claim that the thing measured is false.

### The three kinds of authority, kept apart and labelled

**Source-derived** — recomputed from checked-in source every run, so *stale* is
not a state they can be in. **Receipt-derived** — verified, never trusted: the
frozen benchmark aggregate's own `protocolFingerprint`, `instrumentFingerprint`
and `baseSha` must equal the protocol's, or nothing is read from it.
**Measurement-derived** — the measured ledger plus what git can prove about it:
ancestry of the recorded commit, and `tests/` at that commit versus at `HEAD`.
Every fact names exactly one authority, and no fact blends kinds.

### The one lexical rule kept from the rejected option A

Every `SCREAMING_SNAKE` identifier in a bound surface must exist in the
vocabulary **harvested from source**, be a repository file's basename, or be an
angle-bracketed metavariable. It is kept because it matches identifiers rather
than wording, and because the vocabulary is harvested rather than hand-listed:
nothing needs maintaining, and a code deleted from the code fails every document
still naming it. That is instance 2 written as a rule — and it binds
`docs/PROJECT_STATUS.md`, `TASKS.md` and every scenario document with **no
marker at all**, which is why none of them was edited.

`RETIRED_CODES` closes the other half: a code this repository deliberately
removed goes on being *discussed* — in an ADR, in a review note, in this
paragraph — and a lexical harvest cannot tell discussion from declaration, so
retired codes are subtracted from the vocabulary wherever they appear. A bound
document may still name one by declaring `<!-- truth: retired-code CODE — why -->`
in that file, which costs a reviewable edit with an argument attached. Shaped
like `DATED_HISTORY` in `scripts/measurement.js`, for the same reason.

### What is bound, and what is deliberately not

Bound: `README.md`, `PRODUCT.md`, `AGENTS.md`, `CLAUDE.md`, `TASKS.md`,
`docs/PROJECT_STATUS.md`, `docs/CODER_TOOLING_ROADMAP.md`,
`docs/QUALITY_GATES.md`, `docs/REPOSITORY_TRUTH.md`,
`docs/strategy/EXECUTION_ROADMAP.md`, `docs/benchmarks/CRM_JTBD_MATRIX.md`,
`docs/benchmarks/jobs.json`, `site/claims.json`, `site/assets/llms.txt`,
`site/assets/llms-full.txt` and every `examples/scenarios/*.scenario.json`.

Excluded **by path rule, never by heuristic**: `DECISIONS.md` — this ADR
included — `docs/plans/**`, `benchmarks/**`, `docs/transcripts/**`,
`site/blog/**`, `docs/editions/**`, and everything in `scripts/measurement.js`'s
`DATED_HISTORY`. A dated ADR, an ExecPlan, a benchmark receipt and a blog post
preserve what was true when they were written, and rewriting them to satisfy a
checker would be falsifying history.

### What this is not

`repo:truth` is a **repository-maintenance script**, not an Accordo rail, not a
product command and not part of the agent surface budget. It appears in no Skill
and in no generated project: a generated project has no claims ledger, no JTBD
matrix and no status file. It rewrites no prose, calls no model, publishes
nothing, deploys nothing and changes no product code.

It is **standalone in v1** — not in `npm run verify`, not in `npm run gtm:check`
— for one measured reason: its measurement checks need full git history, the
`public-claims` CI job has `fetch-depth: 0` but the `verify` job deliberately
does not, and wiring a fail-closed history check into a shallow job would turn a
truth gate into a flake. The half that needs no history **is** covered by
`verify`, through `tests/repository-truth-contract.test.js`, which asserts the
refusal rather than skipping when history is absent — and which passes in both a
full and a shallow checkout. Promoting `repo:truth` into `gtm:check` is v2 work
and needs the job given full history first.

### One product-source change, and why it is not a domain concept in core

`packages/app/src/spine.js`'s `notModeled` array is hoisted to an exported
`SPINE_NOT_MODELED` constant and spread into `describe()` unchanged. Zero
behaviour change. It was previously readable only by booting a spine — a mode, a
verifier, a tenant binding and two database files, to learn what the framework
says it does not do — which made it prose to every reader outside the running
application. Hoisted, it is a **declaration**, and a declaration is what a
declared-absence fact is allowed to read.

### What v1 does not cover

No JTBD row is a fact and none will be: 149 rows are moved by a person reading
merged tests (`docs/QUALITY_GATES.md` §3), and a generator that owned them would
be promoting rows. `docs/editions/**` is unbound in v1. No scenario receipt is an
authority — `scenario run` writes nothing into the project, so this repository
checks none in. No `solution verify` evidence document is an authority: they
describe *other* applications' compositions, so their
`applicationInspectionFingerprint` cannot be checked against this repository.
Package facts describe a named **reference composition** of the nine checked-in
packages, because `packages/domains/generated/index.js` is empty here and
`app inspect` on the repository root reports zero packages. Measurement facts are
generated and provenance-checked but **not cited** by any document, because a
citation would resolve differently in a shallow clone. Citations are opt-in: a
sentence that carries none is not checked, and this contract cannot discover
which sentences ought to have one. Every one of these is published in the
document's own `limitations[]`, by code, so a reader acts on the boundary rather
than discovering it.

#### Amendment 1 — the gate shipped unwired, and three rules had holes (review findings)

The paragraph above — "It is **standalone in v1** … Promoting `repo:truth` into
`gtm:check` is v2 work and needs the job given full history first" — described a
gate that ran **nowhere**. No CI job invoked `repo:truth -- --check`; the whole
contract, citations and machine-code vocabulary included, was enforced only by
whoever remembered to type the command. That reproduces the failure this ADR
opens with: both recorded instances were found by a person and not by a gate,
which is only an argument if a gate exists. The stated blocker did not exist
either — `gtm:check` runs in exactly one job, `public-claims`, and that job is
already checked out with `fetch-depth: 0`, as the same paragraph says two
sentences earlier.

`repo:truth -- --check` now runs as its own step in `public-claims`, on every
push and every pull request. A separate step rather than a member of `gtm:check`,
because `gtm:check` is also run locally in a clone that may be shallow; folding
the two together is the v2 question. It costs about half a second, and it was
confirmed green on a simulated pull-request merge commit as well as on the branch
tip.

The contract also closed only **one** of the two failures this ADR opens by
naming. Instance 1 was `app inspect` publishing `productionPosture: "no
authentication, tenancy or RBAC exists"` — a hand-written English string in
`packages/cli/src/app-inspect.js`, in none of the twenty bound surfaces and
covered by no fact. Restoring that exact sentence in a clean clone left
`repo:truth -- --check` green. The sentence is the one every agent reads to learn
what this framework is, so it is now a bound surface carrying seven citations,
and the citation grammar gained a third comment character (`// truth: id=value`,
applied to a bound `.js` file only, so a fenced example in a document stays an
example). That is the whole extent of source binding: a product claim written as
a string, cited deliberately, one file at a time. This contract does not scan
source for sentences and cannot discover which strings are claims.

Five rules were narrower than they read, and are fixed with the mutation that
must fail each one:

- **A declared-absence fact could outlive the code.** `SPINE_NOT_MODELED` is a
  hand-maintained list of English strings, and a regex over it only ever answers
  "does the list still say this". Deleting the sentence refused the fact; *building*
  the thing and leaving the sentence standing moved nothing, so
  `spine.durable_jobs.implemented` and `spine.secrets_backups.implemented` were the
  two facts in this document that a claim could survive — Option B wearing Option C's
  clothes. Each now carries a second authority derived from the code, a namespace
  probe over the reference composition on the same two-authorities-must-agree rule as
  `billing.implemented`; `spine.postgresql.implemented` already had one in the
  manifest's production dependencies.

- **Angle brackets hid any machine code.** `findUnknownCodes` stripped
  `<[A-Z][A-Z0-9_]*>` from every line before looking, so
  `<TENANT_ISOLATION_NOT_ENFORCED>` passed `--check` in `README.md` and in
  `site/assets/llms.txt`, where angle brackets render literally to the agent
  reading it. That disarmed the one lexical rule this ADR keeps — the rule
  written because that exact code survived its own fix — and broke
  `RETIRED_CODES`'s stated promise to hold "wherever the mention appears". The
  exemption bought nothing: `ERROR_CODE`, the only metavariable any bound surface
  uses, is declared in source and was already in the harvested vocabulary, which
  is why the test that claimed to prove the exemption passed with the strip
  removed. The strip is gone; the exemptions are the vocabulary and repository
  basenames, and nothing else.
- **The JSON citation grammar was wider than the one published.** Any quoted
  `word=word` on any line of a bound JSON file was read as a citation, so
  `"note": "mode=production"` in `site/claims.json` produced `TRUTH_FACT_UNKNOWN`
  for a string that was never one. The parser now reads `facts` arrays out of the
  parsed JSON, which is what §6.1 and `docs/REPOSITORY_TRUTH.md` always said.
- **The stale message blamed the wrong thing.** A comment-only edit to an
  authority source moves `sourceSha` and nothing else, and the run correctly
  failed — reporting "the evidence, the authority list or a limitation did",
  naming three things that had not moved. In a contract about documents that
  state what is no longer true, its own diagnostic may not.

**The suite itself was flaky, and CI proved it rather than a person guessing.**
`82976f1` ran `verify` twice, on two runners, at one commit: 1527/1527 pass on
one, 1526/1527 on the other. The single failure was not an assertion — it was
the `t.after` of a fixture test, `ENOTEMPTY: rmdir '<fixture>/.git'`, after every
assertion in that test had already passed. A gate whose own suite is red on one
runner and green on another is a gate people re-run instead of read, which is
the habit this ADR exists to break, reproduced inside its own tests. Throwaway
directories now remove with `maxRetries`/`retryDelay` and, failing that, leave a
note on stderr rather than failing a run whose assertions all passed; no
assertion was touched. Every git call in the file also runs with `gc.auto=0` and
`maintenance.auto=false`, on the hypothesis that a detached auto-gc is the
writer — a hypothesis, because the race did not reproduce locally in 75 rounds
under three concurrent workers, and it is named as one rather than asserted.

Two published inventories disagreed with their contents and are corrected:
`docs/REPOSITORY_TRUTH.md` listed ten of the eleven `limitations[]` codes,
dropping `CODE_VOCABULARY_INCLUDES_COMMENTS`, and `README.md`'s "Where it stops"
claimed "Every boundary below carries a machine-checked citation" over twelve
bullets of which three carry none. A twelfth limitation,
`NUMERIC_CLAIMS_NOT_BOUND`, is added: no fact in this contract is a count that
any document cites, so every number in a bound sentence — test counts, module,
package, resource and action counts — is outside it, and a reader should not
infer otherwise from a citation standing next to one. A test now asserts that the
document's codes and the explainer's table are the same set.

#### Amendment 2 — binding the posture sentence did not close instance 1, and the `.js` allowlist was not path-scoped

Amendment 1 says the posture sentence "is now a bound surface carrying seven
citations", after recording that restoring the false posture in a clean clone had
left `--check` green. Read together, those two sentences claim the first of the
two failures this ADR opens by naming is closed. **It was not, and the mutation
says so:** pasting `"no authentication, tenancy or RBAC exists"` back into
`productionPosture` and touching nothing else exits **0**. A citation binds a
**value** — reversing `spine.authorization.enforced=enforced` to `=absent` fails,
and that is the entire content of what those lines prove. They say nothing about
the sentence beneath them, which is what `WORDING_IS_NOT_GENERATED` had already
said and what the amendment then wrote past.

Generating the sentence from its own facts is the real answer and stays **v2**.
What closes the recorded case now is `RETIRED_CLAIMS`, the exact counterpart of
`RETIRED_CODES`: a short list holding the one retired claim across every bound
surface, matched on collapsed whitespace and folded case, each entry a reviewable
edit with an argument attached, and a `truth: retired-claim <claim> — why`
declaration for a surface that names it as history. In a `.js` surface that
declaration reaches **comment lines only** — file-scoped, it excused the
published string as readily as the paragraph explaining it, and the mutation went
straight back to passing. A rewording that preserves the bounded meaning still
passes; the boundary is published as `POSTURE_PROSE_NOT_GENERATED`, because this
holds the falsehood that *is* in the record and not the set of all falsehoods.
The sentence also asserted the identity-contract seam and the absence of
shared-database tenancy while citing nothing for either; it carries nine
citations now.

**The `.js` grammar was bounded by a literal list and by nothing else.**
`BOUND_SURFACES` is frozen, so no code path in the script can traverse — but a
symlink at `packages/cli/src/app-inspect.js` is followed. Pointed outside the
repository it made *that* file's `// truth:` lines the ones the gate read; pointed
at a citation-free file it dropped the posture's citations from 95 to 88 and left
`--check` green with the falsehood standing in the target. An allowlist a symlink
can redirect is not an allowlist, so every bound surface and every authority
source is now checked to be repository-relative, free of any `..` segment, and
reachable without traversing a symlink at any component, a parent directory
included — `TRUTH_SURFACE_UNSAFE`, refused rather than skipped. Two smaller holes
in the same grammar: a string literal quoting `// truth: id=value` inside the
bound surface *became* a citation (own-line comments only now), and
`// truth: id -> value` matched no pattern and was silently not one
(`TRUTH_CITATION_MALFORMED`, a code declared since v1 and never emitted until
now).

**The cleanup compromise was half of one.** Amendment 1 records the retry-and-warn
half. Warning is the right answer to a transient race and the wrong answer to a
permanent leak, which it made invisible — the same shape as a stale document
nothing checks, inside the suite that exists to catch that shape. The run now owns
one `mkdtemp` scratch root, every fixture is created inside it, a cleanup that
cannot finish registers what it left, and after every test in the file the gate
retries once and then fails deterministically on a directory or a program still
inside that root. It deletes nothing outside the root, kills nothing, and names
residue by **class** rather than by absolute path, because a CI log is
machine-facing and public. Two runs in flight cannot reach each other's
directories, and that is driven by a probe rather than argued: swapping the sweep
for a `/tmp` glob makes the probe fail, which is what makes its passing evidence.

**The detached auto-gc explanation is unchanged and stays a hypothesis.** It did
not reproduce locally in 75 rounds under three concurrent workers. The gate
reports what is left behind, never why.

`NUMERIC_CLAIMS_NOT_BOUND` was itself inaccurate, which in this ADR is not a
small thing. `spine.identity.contract=1` is a cited integer, so `docs/QUALITY_GATES.md`
§6.1's "no number is checked" was false; and typed *test* counts are not
unchecked but held by `findLooseTestCounts` inside `gtm:check`, so naming them
first among the things "outside this contract" read as the opposite of the case.
Both are corrected. Binding numbers remains v2: requiring one to carry a fact
means classifying a load-bearing current count against a date, an ADR number, a
currency example, a receipt's raw count and a digit inside a code fence, and
`findLooseTestCounts` needed two hand-tuned negative lookbehinds to survive
widening from `site/` to `docs/` for a single noun.

## ADR-041 — Durable work is a tenant-bound data-plane contract with fenced claims and explicit workers

**Date:** 2026-08-31
**Status:** accepted

### Decision

Accordo has one versioned durable-job contract on the tenant data plane. A job
persists a named handler identity and canonical JSON-safe payload, never source
code or a command. Every row carries the already-bound application tenant,
schedule intent plus instant, bounded attempt policy, persisted recovery policy,
idempotency root, claim generation and
claim fingerprint, plus nullable execution-start time for the active generation. Omitted schedules persist as `immediate`, so the same
idempotency root joins across clock drift without collapsing into an explicitly
scheduled request. Every completion is compare-and-set on tenant, worker,
generation, fingerprint and unexpired lease.

Every mutation requires an explicit validated actor. The existing
`AuditLog.record(event, handle)` writes one closed `durable_job.*` event on the
same callback-scoped SQLite or affine PostgreSQL transaction as the job row.
Audit data contains transition state, claim generation and a bounded error code
where applicable; it never copies payload, idempotency root, outcome reference
or handler input. An explicitly constructed worker additionally requires a
system actor and has no fallback identity.

Immediately before a registered handler is invoked, the worker compare-and-sets
`execution_started_at` under tenant, worker, claim fingerprint, generation and
live lease, then records `durable_job.execution_started` in that same
transaction. Expiry can therefore recover an unstarted claim without consuming
another attempt. Under V3A's default `terminal_unknown` recovery policy, expiry
after execution start becomes
`JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED`; the claim is cleared, the start
timestamp remains durable terminal evidence, and no worker invokes it again.
This is deliberately conservative: a crash after the CAS and before the
JavaScript call is also reconciliation-required. It is not exactly-once
execution or delivery.

PostgreSQL claims one due row inside the existing connection-affine transaction
with `FOR UPDATE SKIP LOCKED`. SQLite claims inside its existing
`BEGIN IMMEDIATE` single-writer transaction. This is local SQLite compatibility,
not a claim that SQLite supports multi-node workers.

Construction starts nothing. A worker has explicit `start`, bounded `poll`,
`drain`, `stop` and `close`; application composition does not gain a hidden
timer in this slice. If shutdown wins after claim but before handler invocation,
an owner-fenced release preserves the incremented claim generation while
returning the execution attempt, so repeated drains cannot exhaust untouched
work or falsely classify an external operation as already attempted. Timer poll
failures remain visible as one ratified bounded code in worker status and clear
only after a successful poll. `close` becomes terminal and clears its wake timer
even when draining an in-flight persistence failure rejects. The worker retries
only two closed transient handler codes with bounded injected backoff. Unknown,
validation, authorization and policy failures collapse to framework-owned
terminal codes. An expired `external-operation-v2` claim with no durable
execution-start evidence is reclaimed on the same attempt and may invoke once.
Once execution start is durable, expiry or an unknown handler outcome is never
replayed under that default: the stable idempotency root remains its external
operation identity and the job becomes reconciliation-required. ADR-041's V3B
addendum later introduces one persisted opt-in for locally reconcilable outbox
effects; it does not change this provider-safe default.

### Context

Spine v2 can persist business state and recover uncertain write outcomes, but a
future timestamp or process restart still loses in-memory follow-up work. A
naive queue beside the application transaction would also recreate the exact
process-death gap Spine v3 must close. V3A therefore needs a primitive later
V3B/V3C work can enqueue through the caller's existing transaction.

The data plane is deliberate. Jobs act on tenant CRM state and must share its
commit boundary. The required `tenant_id` is transition authority and evidence
inside one tenant-bound instance; it does not introduce shared-database row
tenancy or a tenant switcher.

### Alternatives rejected

1. **Expand the generic Storage Contract DSL with inequalities, row locks and
   returning clauses.** Rejected because one consumer would substantially widen
   the public structured-SQL vocabulary and imply dialect equivalence where none
   exists.
2. **Give the queue a second SQLite connection or PostgreSQL pool.** Rejected
   because it would escape writer-lease authority and could not atomically join
   the business transaction.
3. **Use an in-process timer and reconstruct jobs at startup.** Rejected because
   process death between commit and reconstruction loses work, and two workers
   have no durable ownership fence.

### Consequences and limits

- A caller can enqueue through an existing transaction; rollback leaves no job.
- Transactional enqueue accepts only the live callback-scoped handle owned by
  the current async flow. A root handle or a callback handle retained after
  commit/rollback is refused before it can write.
- Active claims cannot be stolen. An expired unstarted claim gains a new
  generation without consuming another attempt; an expired started claim is
  terminal reconciliation evidence regardless of remaining attempt budget.
- A pre-handler release is fenced by tenant, worker, claim fingerprint,
  generation and live lease, and does not consume the execution-attempt budget.
- Pre-execution terminal codes require absent execution-start evidence, while
  execution/retry completion requires present evidence; neither phase can
  falsely terminate the other through the direct store seam.
- Worker status exposes only the last bounded poll error code, never raw storage
  error text or details; a later successful poll clears it.
- Claim, execution-start, success, failure, and release require a system actor;
  enqueue, cancel, and reschedule retain explicit operator/agent authority. This
  prevents an ordinary caller from fabricating worker execution evidence.
- Cancel and reschedule apply only before a claim. A handler that outlives its
  lease is terminalized by recovery and its late completion is fenced; internal
  business handlers therefore still require their own idempotent outcome identity.
- Explicit reschedule changes the persisted caller-visible schedule intent to
  `scheduled`; retry backoff changes the next instant without rewriting the
  original caller intent.
- A job transition and its audit event commit or roll back together. A fenced
  transition writes neither; reads require no actor and write no audit event.
- Canonical payload traversal reads own data descriptors recursively for both
  objects and arrays. Accessors are refused without invocation; proxy/trap and
  other hostile inspection failures collapse to `DURABLE_JOB_PAYLOAD_INVALID`
  with no cause, details or caller-controlled serialization. Array length is
  conservatively bounded from the payload byte budget before allocation.
- Job input, handler identity, and mutation actor context are likewise inspected
  through own data descriptors before any field read. Hostile injected backoff
  behavior terminalizes as `JOB_BACKOFF_INVALID` without retaining its error.
- Store failure codes, handler-derived codes, and worker status codes use closed
  allowlists. Arbitrary uppercase caller text never enters a job, audit event,
  or worker status as an error code.
- V3A is infrastructure only. It adds no cron grammar, recurrence policy,
  outbox, timer consumer, provider adapter, operator command, public app facade,
  Cloud queue, production-readiness claim or JTBD promotion. Those boundaries
  remain for V3B, V3C and the integration campaign.

### V3B addendum — committed effect intents are dispatched through exact durable jobs

The existing PostgreSQL `write_outcomes.event_intents_json` remains the sole
effect-intent authority. The transaction that inserts an outcome also enqueues
one deterministic V3A job for each applicable closed effect family on the same
affine storage handle: internal event promotion, and external-operation receipt
continuation only when that receipt durably records that the operation declared
a finalize phase. Provider-only operations record the closed false value and
create no poison continuation. A legacy receipt with no declaration retains
`unknown`, creates bounded reconciliation evidence, and never infers callback
authority. Replaying a known receipt under the opposite declaration refuses as
a divergent contract. The job carries only contract, run, phase and
source-fingerprint identity. Event/domain/provider payloads, idempotency keys,
actors, credentials and secret references remain in neither job nor job audit.
Rollback therefore leaves no dispatchable identity; commit followed by process
death leaves a pending one. A committed event outcome from before V3B is
recovered by deterministically backfilling that same identity on explicit
replay. Historical receipt continuation is backfilled only with committed
declaration authority; an ambiguous legacy receipt requires explicit operator
reconciliation.

Internal events are dispatched from the committed outcome. A subscriber failure
does not starve later stored intents: every valid intent is attempted, failures
are collapsed to one bounded retryable result, and `events_promoted` is
compare-and-set only when the complete pass succeeds. The
old mark-before-dispatch path is gone. Transport is **at least once**: when a
later subscriber fails, a retry may repeat an earlier subscriber. Concurrent
workers cannot own the same claim. V3B effect jobs persist the closed
`reconcilable_at_least_once` recovery policy: expiry after durable execution
start advances attempt and generation, clears the old execution fence, and may
invoke the same effect identity again until `maxAttempts`. That closes the
zero-delivery crash window and honestly permits duplicates after partial
delivery. Exhaustion is visible terminal evidence and late completion remains
fenced. Every existing/generic job defaults to `terminal_unknown`; in
particular external-operation-v2 provider work is never replayed by this
policy. No intent is silently deleted and no exactly-once delivery claim is
made.

The external continuation handler accepts only a registered local-finalize
operation. It reloads the committed intent and receipt, returns successfully if
finalize already exists, and otherwise requires the callback to prove a
committed finalize outcome before the job succeeds. Provider `call` and
`reconcile` handles never enter this runtime, so recovering a receipt cannot
implicitly replay an external side effect. This is a continuation fence, not a
managed integration service or a general event platform.

Construction still starts no worker. SQLite keeps its immediate in-process
event compatibility and gains no durable-outbox or multi-node claim. The
authoritative security audit path is not migrated into effect dispatch, and
V3B adds no timer consumer, CLI/MCP/operator surface, Cloud backend,
production-readiness claim or JTBD promotion.

**One published absence becomes ambiguous here, and the integration campaign
owns it.** `spine.durable_jobs.implemented` is `absent`, declared by the entry
`durable jobs, outbox or scheduler (Spine v3)` in `SPINE_NOT_MODELED`
(`packages/app/src/spine.js`). The intended reading — no Spine surface, no
autostarted worker, no operator command — stays true after V3B, and this
addendum states each of those absences directly. The literal reading, that the
framework has no outbox at all, does not: from this milestone the default
PostgreSQL write path enqueues an effect row for every committed write that
carries event intents, which is the first production consumer of the durable
job store. This delta deliberately leaves the authority string untouched,
because rewriting it reclassifies the fact and moves every surface bound to it.
The integration PR must either disambiguate that entry or reclassify the fact,
together with the dependent surfaces — not as a documentation follow-up.

---

## ADR-040 — Runtime secrets are named references resolved before use, never deployment values

**Status:** accepted. **Milestone:** Production Spine v4A.
**Plan:** `docs/plans/spine-v4a-secrets-provider.md`.

### Context

Production Spine v2 kept PostgreSQL credentials out of public descriptors and
diagnostics, but deployment contract 1 still carried each password inline in
the trusted JSON document. Identity verifier modules had no credential boundary
at all. Those are two current consumers of one safety capability, so a bounded
runtime contract is justified without becoming a managed secret service.

### Decision

`secretProviderContract: 1` is an internal provider-neutral contract over one
closed operation: `resolveSecret(reference, context)`. A reference is a bounded
identifier, never a value. Context is allowlisted to contract, mode, purpose,
tenant id and an abort signal; initial purposes are identity-verifier and the
PostgreSQL control/data passwords. Provider definitions are closed
`{contract,name,trust,resolveSecret}` objects. Provider configuration and secret
references are not declared-definition fingerprints.

Providers return mutable bytes (a `Uint8Array`, or the framework convenience
`SecretMaterial`), not a string or an arbitrary result. The resolver copies and
zeros that provider-owned buffer, then transfers its bytes into one opaque single-use
`SecretLease`; disposal, successful use and an unrefed bounded expiry zero
mutable storage. String,
primitive and JSON coercion refuse, and Node inspection prints only `redacted`.
The lease also owns the plaintext callback boundary: any synchronous throw or
asynchronous rejection from a consumer is replaced with the framework-minted
`SECRET_CONSUMER_FAILED` error without retaining the consumer's message, code,
details, cause or stack. Mutable bytes are zeroed before the callback runs.
This is limited lifetime where JavaScript permits it, not a claim that a
plaintext string handed to a required third-party API can later be zeroed.

Resolution and production-provider initialization have bounded deadlines and an
abort signal. Losing promises are observed. Material settling after timeout is
disposed; late rejection cannot become unhandled. The trusted module descriptor
has an idempotent outer owner and the deadline closes it even when a top-level
module import never settles. Provider text, hostile
results, paths, references and values collapse to stable credential-free
errors. Runtime semantics never catch a secret failure and continue without it.

Deployment-storage contract 2 replaces PostgreSQL `password` with
`passwordSecret`. The deployment parser applies the resolver's exact bounded
reference grammar before provider import, verifier construction or database
work, and requires an explicit `secretProvider`: `environment` only
in local-development mode, or a trusted repository-relative `module` in
production. Contract-1 SQLite and `--db` compatibility remain. PostgreSQL
contract 1 refuses in every mode with
`DEPLOYMENT_STORAGE_SECRET_REFERENCE_REQUIRED`; it cannot silently retain the
inline-password path after this boundary exists.

`prepareDeploymentPreconnect()` resolves the secret provider first, gives the
same resolver to the identity-verifier factory, and completes both before
application composition can open a database or listener. PostgreSQL control and
data pools receive `pg` password callbacks that resolve distinct references and
consume one lease per connection; the pool endpoint contains no reference
property. TLS validation, attestation, tenant binding and writer-lease ordering
are unchanged.

Built-ins stop at an explicit local-development environment provider and a
deterministic fixture. Production is an interface/plugin boundary only: no
Vault, AWS, GCP or managed Accordo provider ships, and production never falls
back to environment lookup. The resolver is not a domain-package API, CLI/MCP
surface or health/schema field. Repository Truth publishes only the bounded
self-host contract as implemented and separately keeps managed secret custody,
backup/restore and observability absent. No audit, trace, job, backup or
telemetry consumer receives a lease, reference or value.

### Rejected alternatives

- Redacting errors while keeping inline passwords leaves values in a long-lived
  parsed object.
- Direct `process.env` reads in each consumer create divergent contracts and a
  silent production fallback.
- Raw string returns make accidental serialization indistinguishable from
  intentional consumption and prevent best-effort late disposal.
- A vendor SDK or managed store adds a service and lifecycle this milestone
  neither needs nor owns.

---

## ADR-042 — Restore imports bytes only behind independent identity, authority and receipt fences

**Status:** accepted. **Milestone:** Production Spine v4B.
**Plan:** `docs/plans/spine-v4b-backup-restore.md`.

The public core provides a provider-neutral PostgreSQL-only backup contract; the
built-in provider uses PostgreSQL 16 `pg_dump`, `pg_restore` and `psql`, and
refuses when any of the three is absent or reports another major. Create returns
independent SHA-256 identities for the artifact and canonical manifest bytes;
the caller must retain both. Verify and restore compare the bundle against both
identities, so a coherent replacement or altered manifest authority metadata
does not become authority.

Restore accepts no ambient target, and it does not import through a connection
`pg_restore` opens for itself, because holding a lock on one backend never
proved that a second tool reached the same one — behind a proxy or a failover
the coordinator could fence A while the archive landed in B. `pg_restore` runs
with an empty environment and only renders the archive to local SQL. A single
`psql` session then applies it inside one transaction: it takes a
transaction-level child lock, refuses unless the coordinator's session-level
witness lock is still held by someone else, applies the rendered SQL, re-checks
the restored authority and writes non-secret evidence of it, and only then
commits. A child that reached elsewhere acquires the witness, and refuses before
any DDL. That fence proves same cluster and same database rather than literally
the same backend; every divergence it cannot distinguish — replica, failover,
pooled connection, a coordinator that died — resolves toward refusal. Normal
startup takes the same child lock, so a child that outlives its coordinator
still fences bootstrap. The coordinator holds an exclusive advisory lock across
the whole operation, enumerates database-local emptiness before admitting the
child, and re-verifies artifact bytes and restored binding/migration identity on
the connection that holds the lock.
The connection carries a non-secret resource fingerprint supplied by deployment
authority; expected intent and the durable receipt bind it, so replaying a
successful operation against a second endpoint refuses before target access.
The target must be empty; normal startup attestation remains the only path to
writer authority, and a physical clone is never promoted or rebound here.

A restore also carries a stable caller operation id and verified actor through
a caller-owned control-plane seam. That seam must durably append the attempt
outside the target before target access and idempotently append exactly one
closed outcome for the same operation/bundle/target identity. A seam asked for an
outcome that diverges from one it already closed is a caller defect: the core
records the first closed outcome and never depends on a second being accepted.
Success and possible partial mutation are recorded while the target lock remains
held. A terminal
replay never touches the target again. This core interface cannot prove an
arbitrary caller persisted its receipt; public operator composition must supply
the durable append-only implementation before exposing restore.

Connection transport is explicit. Plaintext is accepted only when declared for
a loopback development/test endpoint. Remote operation requires `verify-full`,
a trusted CA and verified logical hostname. Each affine operation pins the
trusted CA bytes into one private owner-only file consumed by both Node probes
and native libpq, then removes it before settlement.
Credentials and database locators live only in a bounded allowlisted child
environment, never argv, manifests, receipts or errors. Native tools run in a
separate process group; timeout or output overflow kills and observes the group
before settlement.

This is a bounded self-host contract, not managed artifact custody, scheduling,
retention, PITR, clone promotion, an operator UI/CLI, or a recoverability SLA.
SQLite is explicitly unsupported.

The five closed construction symbols are intentionally exported from
`packages/core/index.js`. Self-host runtime composition and the future private
Cloud adapter are two concrete consumers of the same manifest and restore
fences; forcing either to deep-import private source or recreate those fences
would fail the DX Simplicity Gate. No storage handle, locator, generic process
runner, custody service or operator command enters the public surface.

## ADR-043 — Telemetry exports a closed vocabulary, never a filtered payload

**Status:** accepted. **Milestone:** Production Spine v4C.
**Plan:** `docs/plans/spine-v4c-observability-export.md`.

The public core provides one closed, versioned contract for handing bounded
operational evidence to an observability system the deployment already runs.
It is not an observability backend: nothing here stores, aggregates, queries,
retains or displays anything, and no managed observability service is claimed.
The security audit remains the database authority — a telemetry failure can
never rewrite business truth, and no signal replaces an audit write.

The leak fence is the shape of what may be said, not a filter over what a
caller passed. A signal name must be in a frozen registry; an attribute key
must be declared for that signal; an attribute value must be a member of a
kernel-enumerated closed set, a `boundedFailureCode`-charset code, a
registration identifier, a bounded integer or a boolean. Attributes are flat,
so no nested structure exists for a payload to travel in, and a record that
fails any of those checks is refused whole and counted, never silently
repaired. Rejecting a record rather than stripping the offending key is
deliberate: stripping hides the producer defect that put it there.

The envelope and its attributes are copied into data-only snapshots before any
check runs, so a value is read exactly once. Validating one read and exporting
another is the whole of the bug this closes: an accessor could satisfy the
allowlist and then return free text, a nested object, or an exception thrown
out of the public sink from a read that sat outside every `try`. Reading once
is what prevents the leak; refusing accessors outright is the stricter policy
layered on top, because no legitimate producer passes one.

No record identifier is exportable in v1 — not the tenant id or any
fingerprint, not the job, run or worker id, not the idempotency root or the
outcome reference. Tenant identity is leak material in this repository by
precedent (ADR-041's bounded diagnostics exist because a driver message
carries tenant ids), caller-chosen bounded text stays domain data however
short, and a job id is a durable key into tenant-scoped rows that the audit
log already correlates behind authorization while telemetry has none. The
stated consequence is that v1 telemetry is aggregate-shaped rather than
per-record traceable; correlation requires a later, deliberately authorized
contract version rather than a widened attribute list.

Two limits inside that fence are narrower than "no identifier is exportable"
and are stated rather than left to be discovered. A job `kind` and `handler`
name are chosen by whoever enqueued the work — `enqueue` bounds them to the
identifier charset and checks no membership against the handler registry — so a
caller who names a job after a uuid, a tenant slug or a dotted email localpart
sees exactly that exported. Every attribute the kernel itself fills stays
closed. Narrowing this by refusing uuid-shaped or address-shaped values would
be a denylist, which is the thing this ADR refuses; closing it properly means
checking registry membership at the seam, and that is a v2 contract change.

Failure is best effort and bounded, stated exactly. An emission returns a
boolean and never throws; no producer awaits one. Delivery is tracked in a
bounded in-flight set rather than a growing queue, so backpressure is a counted
drop with no batch to lose and no timer to schedule. **That drop is not
necessarily transient**, and "backpressure" invites the wrong reading: nothing
evicts an in-flight entry, so once `maxInFlight` emissions hang, every later
signal drops for the life of the process, `inFlight` never returns to zero and
every `close()` reports a timeout. It stays bounded and never crashes, as
promised — but a permanently wedged exporter permanently silences telemetry
instead of degrading it. Evicting would need a timer per emission, which is the
timer-free property this sink is built on, so v1 declares the behaviour rather
than buying it back. Flush and close each have
a deadline built on the same race-and-clear shape as the V3A worker drain, so a
hung exporter cannot hang application shutdown and no timer is leaked. Close is
memoized: the exporter is closed at most once, and a later emission is a
counted drop, not an exception raised into a shutdown path.

`requireTelemetrySink` catches the composition error, not an adversary. A
shape check is not a security barrier: a hostile composer already controls the
process, so it is outside the threat model. A legitimate decorator that wraps a
sink and forwards its six operations passes the check, and it is right that it
passes — it forwards to a real sink. What makes the residual case non-fatal is
not the discriminator but the thenable swallow in `report()`; saying where the
defence is *not* without saying where it *is* would leave a reader who defeats
the shape check concluding there is none.

Lifecycle is application-owned. Constructing a sink starts no timer, socket or
process, and the default async application factory gains no telemetry option in
v4C. **Not because there is nothing there to instrument** — an earlier draft of
this ADR said that and it was false: `createAccordoAppAsync` reaches
`startPostgresqlLifecycle`, which calls `bootstrapPostgresqlApplication`, and
that is the readiness producer. The reason is that giving the factory a
telemetry option is a lifecycle decision — who constructs the sink, who owns
its shutdown order relative to the data plane — and v4C deliberately leaves it
to the composition that will own it rather than inventing an owner here.

The measured consequence, stated because it is a real limit rather than a
detail: `startPostgresqlLifecycle` forwards a closed option list that does not
include `telemetry`, so `accordo.postgresql.readiness` and
`accordo.postgresql.writer_lease_remaining_ms` are **unreachable from every
supported composition** in v4C. Only a direct call to
`bootstrapPostgresqlApplication` emits them, which is what the hosted test
does. They are implemented and proven, and no application can turn them on
yet.

**OpenTelemetry and OTLP are not implemented and not claimed.** They would add
a large dependency tree against the rule that a production dependency must
remove more complexity than it adds, and bring a global provider, context
propagation and shutdown lifecycle of their own. The exporter shape is kept
adapter-compatible — five operations, flat string-keyed attributes, bounded
scalars — so an OTLP adapter can be written outside the kernel later without a
contract change. `telemetryVocabulary().openTelemetry` is `false` so a reader
of generated truth cannot infer support that does not exist.

The eight construction symbols are exported from `packages/core/index.js` for
the reason ADR-042's are: self-host composition and a future Cloud control
plane are two concrete consumers of the same allowlist, and forcing either to
deep-import private source or rebuild the redaction fence would fail the DX
Simplicity Gate. No storage handle, locator, event bus or operator command
enters the public surface, and this adds no agent-facing command, tool or
namespace at all.
