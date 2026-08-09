# Architectural decisions

## ADR-001 — Standard-library-first proof of concept

**Status:** accepted

The first vertical slice uses Node.js built-ins, including `node:http`, `node:test` and `node:sqlite`. This keeps setup immediate for Codex/Claude and makes the framework mechanics visible. A production adapter may later replace SQLite without changing module service contracts.

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
6. **A plan is bound to a real AX1 report.** `crm solution check` re-runs the
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
`crm solution check` from the live project. `validate` refuses anything that is
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
5. **AX1 representation.** The dependency becomes an edge `crm app inspect`
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
tenancy or RBAC, and `crm app inspect` reports `productionPosture: "local
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
