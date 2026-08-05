# Milestone 3 — generated modules through HTTP API and SDK

## Goal and user-visible outcome

A generated module is usable the moment it is applied: discoverable through `GET /api/schema`, served through a uniform HTTP resource family, and consumable through `client.module(name)` in the SDK — with the same actor, validation, transaction, audit and event semantics the generated service already guarantees.

```js
const client = new AgentCrmClient({ baseUrl, actor: { type: 'agent', id: 'claude-code' } });
const partners = client.module('partner');
const created = await partners.create({ name: 'Acme Partners', tier: 'gold' });
await partners.get(created.id);
await partners.list({ limit: 50 });
await partners.update(created.id, { tier: 'platinum' });
```

## Current repository context

- `apps/server/src/http-server.js`: hand-written routes per core module; normalized error contract (`{error: {code, message, details}}` via `normalizeError`); actor from `x-actor-type`/`x-actor-id` headers; 1 MB body limit; lenient `parseLimit` for core endpoints.
- `apps/server/src/router.js`: literal-segment router; `:param` segments match `[^/]+` and are URL-decoded after matching, so encoded slashes cannot alter routing.
- `packages/sdk/src/client.js`: hand-written methods per core resource; errors carry `status` and `details` (not yet `code`).
- `packages/modules/generated/index.js`: static registry (ADR-007); module definitions from the factory currently carry `name`, `version`, `description`, `entities` and the service.
- `GET /api/schema` already returns `{schema, modules, workflows, providers}` where `modules` is `ModuleRegistry.list()` (definitions without services).

## Approaches compared (required)

**A. Generate dedicated route and SDK files per module.** Each apply emits `apps/server/src/routes/<name>.js` and `packages/sdk/src/<name>.js`.
*Pros*: fully owned, per-module customization point. *Cons*: N copies of identical boilerplate that drift from the framework contract; every server/SDK improvement needs regeneration of all modules; two more mutation targets in apply (larger atomic surface, more collision cases); nothing in the CRUD subset is module-specific — the generated *service* is already the ownership point for custom behavior.

**B. One uniform resource adapter over the static registry (chosen).** The server adds one route family `/api/modules/:module/…` that resolves the module in the `ModuleRegistry`, admits it **only** if its definition declares `kind: 'generated'` with explicit `capabilities`, and delegates to the generated service. The SDK adds one generic `client.module(name)`.
*Pros*: zero per-module boilerplate, no drift, new modules are exposed by the same reviewed code path, the exposure boundary is an explicit static declaration (not introspection). *Cons*: the HTTP layer is shared, so per-module HTTP customization needs a dedicated route — acceptable: custom behavior belongs in services and workflows per ARCHITECTURE.md, and a dedicated route can always be added by hand later.

Chosen: **B** — smallest architecture, deterministic, no duplicated generated code, no low-code runtime (the adapter calls four fixed, declared methods; no dynamic dispatch beyond the capability whitelist). Recorded as ADR-008 because the public resource contract is material.

## Public contract

```text
GET    /api/modules/:module              → module metadata
GET    /api/modules/:module/records      → { items } (strict integer limit)
POST   /api/modules/:module/records      → 201 created record
GET    /api/modules/:module/records/:id  → record
PATCH  /api/modules/:module/records/:id  → updated record
```

Non-pluralized, stable paths; deletion absent by design. Metadata returns name, description, `manifestVersion`, `kind`, `capabilities`, field metadata (type/required/unique/enum values), the implicit immutable fields (`id`, `createdAt`, `updatedAt`) and canonical path templates.

**Exposure boundary**: only modules whose definition statically declares `kind: 'generated'` + `capabilities` are served; anything else (core handwritten modules, unknown names) → 404 through the normalized error contract. The adapter never introspects method names, never evals, never touches SQLite, and always passes `{actor}` so audit/transaction/event semantics stay in the service.

**Strict limits on the generic surface**: a present `limit` must match `^\d+$`, be ≥ 1 and ≤ 500, else 400 with a useful message (unlike the lenient core `parseLimit`, which stays untouched for backward compatibility).

## Factory change

The generated `index.js` module definition gains `kind: 'generated'`, `manifestVersion`, `capabilities: ['create', 'get', 'list', 'update']` and a `fields` metadata array derived from the manifest. `entities` keeps its existing simple shape for backward compatibility. The registry contract is otherwise unchanged; the repository ships the registry empty, so no migration of existing generated modules is needed.

## Schema discovery

`GET /api/schema` keeps every existing key and adds `generatedModules`: `[{name, description, manifestVersion, capabilities, fields, paths}]`, derived from the registry — deterministic, no timestamps or machine paths. (`modules` already includes the enriched definitions automatically.) A full OpenAPI generator is out of scope; this contract is documented in `docs/API.md`.

## SDK

`client.module(name)` validates the name locally (non-empty string), returns a **frozen** resource object `{metadata, list, create, get, update}`; every path segment and query value is `encodeURIComponent`-ed; `list({limit})` requires an integer when provided (fail fast client-side; server still enforces). SDK errors now also carry `code` (from `body.error.code`) in addition to `status` and `details` — additive, backward compatible. No delete method; existing handwritten methods untouched.

## Security posture

The HTTP server remains a **local development surface**: no auth, tenancy or roles yet (README's Milestone 0 boundary still applies, restated in docs). No CORS is added. Unknown modules/records → 404; validation → 400; unique conflicts → 409; oversized bodies → 413; invalid JSON → 400; unexpected errors → normalized `APP_ERROR` without stack traces or SQL.

## End-to-end proof

From a clean temporary project copy: apply Partner and Supplier via the copy's CLI → boot the copy's app on a **file-backed** SQLite in the temp dir → start a real `node:http` server on an ephemeral port → via real `fetch` + the SDK: schema discovery (both modules with fields/capabilities), metadata endpoint, create/get/list/update, actor identity visible in audit, create/update events, all error cases (unknown module, Company through the generic surface, invalid limits: string/zero/negative/fractional/NaN/over-max, conflict 409, validation 400, missing record 404, invalid JSON 400), reads produce no audit — then close the app, reopen a second instance on the same database file and prove both modules and the created records are still served from checked-in generated state.

## Milestones

- [x] ExecPlan (this document).
- [x] Factory: enriched generated module definition (kind, capabilities, manifestVersion, fields).
- [x] Server: `/api/modules` resource family + schema extension.
- [x] SDK: `client.module(name)` + error `code`.
- [x] Tests: server contract tests + extended e2e with real server and SDK.
- [x] Docs (API, MODULE_FACTORY, README, skills) + ADR-008.
- [x] `npm run verify` + `npm run smoke` green.

## Progress log

- Read router/http-server/SDK; confirmed normalized error contract, actor headers, decode-after-match routing and lenient core `parseLimit`.
- Implemented adapter, factory metadata, SDK resource client, tests and docs.
- Final validation: verify and smoke green from a clean worktree.
- Adversarial review pass: centralized fail-closed exposure validator (startup + request), Map-backed registry immune to prototype pollution, contract version `generatedResourceContract: 1`, JSON.stringify for all manifest strings in generated source (injection-proof), canonical single base-10 limit with duplicate rejection, plain-object body enforcement, malformed-percent → safe 404, defensive SDK response parsing (non-JSON/empty/invalid preserved, network vs HTTP distinguishable), frozen actor and frozen resource client, concurrent-unique race proof.

## Decision log

- Uniform adapter (approach B) over per-module generated routes: boilerplate-free, drift-free, explicit static exposure boundary; per-module HTTP customization remains possible with hand-written dedicated routes.
- Strict limit validation on the new surface only; core endpoints keep their lenient behavior to avoid changing existing API semantics in this milestone.
- 404 (not 403) for non-exposed modules: the generic surface simply has no such resource; distinguishing "exists but handwritten" would leak module topology for no benefit.
- SDK gains `code` on errors as an additive change instead of a new error class hierarchy.

## Explicitly deferred

Admin UI generation, design ingestion, delete, filtering/search, pagination cursors, reference runtime support, OpenAPI, MCP record tools, PostgreSQL, auth/tenancy/RBAC, CORS, deployment, npm publication.
