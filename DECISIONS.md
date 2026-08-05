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

Lifecycle state is protected at the **service boundary, not the UI**. A manifest field may declare `"writable": "managed"` (default `"public"`) with an optional `"default"`: public `create` takes the declared default and never input, public `update` ignores it, and either one rejects a managed field present in the input with a field-tied `VALIDATION_ERROR`. The generated service's `applyManaged(id, patch, ctx)` is the single privileged write path — in-process only, never routed over HTTP, reached by `execute` through `ctx.managed`. A caller therefore cannot set a lead's status to `qualified` through generic CRUD, whatever client they use. Idempotency is the action's own responsibility, expressed in data rather than framework magic: the Lead starter gives its follow-up Task a **unique** `sourceKey` (`qualify:<leadId>`), so a repeated or concurrent qualify cannot produce a duplicate. Action metadata (`generatedModules[].actions`) is an **additive** extension of `generatedResourceContract: 1` — an older client simply ignores it — and exposes no source, so the contract version is not bumped.

## ADR-012 — Domain events are held in a transaction-scoped outbox until commit

**Status:** accepted

An action spanning several module services must be atomic, and its domain events must never be observable before that atomicity is settled. Two real gaps were found in the existing runtime before choosing: `WorkflowEngine` runs steps sequentially with manual compensation and **no outer transaction**, and generated services `emit` **after each mutation's savepoint releases** — so a subscriber could observe a half-applied multi-step action. Both are fixed without a queue, a broker or a new dependency.

`runRecordAction` runs an action's business writes inside a single `database.transactionAsync` (`BEGIN IMMEDIATE`); generated-service `SAVEPOINT`s nest inside it, so **all writes commit or none do** — verified: rolling back the outer transaction undoes the inner savepoints. Wrapping that transaction, `EventBus.buffered` installs a **transaction-scoped outbox** backed by `node:async_hooks` `AsyncLocalStorage` (standard library, correct under concurrent requests). `emit` checks the async-local store: inside a buffered scope the event is queued; outside one it dispatches immediately, so all existing behavior is unchanged and the change is backward compatible. Events are dispatched only after the commit, dropped on rollback or on a throw, and flushed via `outbox.exit()` so a handler that itself emits dispatches immediately rather than re-queueing into a closed transaction and vanishing. Concurrent actions never share a queue.

The **workflow trace is written outside the business transaction**, after it resolves. This is deliberate: a failed action must still leave a trace (the diagnostic record is the point), and writing it inside would either roll the trace back with the failure or leak partial business state into it. The consequence is accepted and documented — a trace row is not transactional with the business writes it describes.
