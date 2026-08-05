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
