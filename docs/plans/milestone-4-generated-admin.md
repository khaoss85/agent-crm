# Milestone 4 — automatic Admin UI for generated modules

## Goal and user-visible outcome

After a module is applied, a human opens the existing Admin and can list, create, view and edit its records — with no module-specific page code.

```text
manifest → module create --apply → start app → module appears in Admin → list → create → open → edit
```

First validated JTBD: *manage a custom CRM business object end to end* (see `docs/benchmarks/CRM_JTBD_MATRIX.md`).

## Current Admin architecture (inspected)

- `apps/admin/public/` is a **zero-build, dependency-free** vanilla-JS single page: `index.html` + `app.js` (ES module) + `styles.css`. Served statically by `apps/server/src/http-server.js`.
- No router: `app.js` renders one dashboard on load and talks to core endpoints via `fetch`.
- Rendering uses `innerHTML` with a hand-rolled `escapeHtml`. That is fragile for hostile generated metadata/record values, so the new views must not extend it.
- Actor headers are hard-coded (`x-actor-type: user`, `x-actor-id: admin-demo`).

## Approaches compared (required)

**A. Generate dedicated page/component files per module.** Every apply emits Admin files.
*Cons*: N copies of identical UI that drift; another mutation target in the atomic apply; nothing in default CRUD is module-specific. Rejected.

**B. One schema-driven generic Admin for every module.** A single renderer reads `/api/schema` and builds views.
*Pros*: zero per-module code, no drift, new modules appear automatically. *Cons*: no place for future per-module customization.

**C. Hybrid (chosen).** A generic default renderer for every valid generated module, plus a documented, checked-in override hook (`window.AgentCrmAdmin.overrides[<module>]`, empty by default) where a developer can later replace a default view without touching the renderer. This gives the immediate Medusa-like default now and a customization seam later, matching the framework's "generated but ownable" principle. No per-module files are generated in this milestone; the override map ships empty.

Chosen: **C**. No new frontend framework, no build step, no no-code runtime — the renderer is small, readable vanilla JS. Recorded as ADR-009 because the Admin extension contract (contract version gate + override hook) is material.

## Architecture

Three new files under `apps/admin/public/`, all dependency-free ES modules:

1. `admin-core.js` — **pure, no DOM**: `humanizeLabel`, `fieldControl`, `buildCreatePayload`, `buildUpdatePayload`, `apiErrorToFormErrors`, `selectGeneratedModules(schema)` (contract-version gate + validity filter + deterministic sort), `displayTitle`, `SUPPORTED_ADMIN_CONTRACT = 1`. Unit-tested under `node:test` with no browser.
2. `admin-modules.js` — **DOM view**: builds every node via `document.createElement` + `textContent`/`setAttribute`/`.value`; **never** `innerHTML` with data. Functions return the root node and capture interactive elements in closures (no `querySelector` on data). Talks to the server through the SDK-shaped `fetch` client already in `app.js`.
3. `app.js` — gains a minimal hash router (`#/` dashboard, `#/modules/:module`, `#/modules/:module/new`, `#/modules/:module/:id`) and a "Generated modules" nav populated from the schema. The existing dashboard becomes the `#/` view, unchanged.

Testability without a browser: the view functions accept an injected `document` and `fetch`. Tests pass a small faithful **fake document** (createElement/textContent/setAttribute/classList/append/value/addEventListener) plus a **real `node:http` server and real `fetch`**, so the data path and safe-DOM construction are exercised for real. Real-Chromium execution stays out of CI (Playwright is not a project dependency and CI has no browser); a one-off real-browser smoke was run manually during review (16 checks incl. XSS-as-text) and `docs/ADMIN_SMOKE.md` is the reproducible checklist.

## Routes (hash-based, matching a zero-build SPA)

```text
#/                          → existing dashboard
#/modules/:module           → collection/list
#/modules/:module/new       → create form
#/modules/:module/:id       → detail/edit
```

## Navigation and discovery

- A "Generated modules" nav section, populated from `/api/schema.generatedModules`, gated on `generatedResourceContract === SUPPORTED_ADMIN_CONTRACT` (unsupported future version → the section shows a clear "Admin needs an update" note, the rest of the Admin keeps working).
- Deterministic sort by module name; Partner/Supplier never hard-coded. Invalid/unsupported definitions never appear. A schema-load failure shows an error with retry and does not break the dashboard.

## Field → control mapping

| type | control |
|---|---|
| string / email / timestamp | text input (email/date input hints where safe) |
| integer | `number` input, `step=1`; non-integers never submitted |
| boolean | checkbox → strict `true`/`false` |
| enum | `select` populated from metadata `values` (manifest order) |

Required marked visibly; optional blanks omitted from the payload; immutable fields (`id`, `createdAt`, `updatedAt`) never editable; unique fields get a non-blocking hint; server stays authoritative; double-submit prevented (button disabled + in-flight guard).

## Display conventions (documented, no manifest changes)

- Module label = `humanizeLabel(name)`; field label = `humanizeLabel(field.name)`.
- Field/enum order follows schema order. Display title = first required string field, else `id`.
- Generated/immutable fields render after user fields.
- `humanizeLabel`: `companyName → "Company name"`, `company_name → "Company name"`, `URLValue → "URL value"` — one shared tested function.

## Security (hostile metadata is data, not HTML)

Every module name, description, label, enum value and record value is inserted via `textContent`/`setAttribute`/`.value` — never `innerHTML`. Route params are `encodeURIComponent`-ed; `__proto__`/`constructor` never resolve (server is Map-backed and 404s; the client also guards). Server error `details` render as text. Tested with `<script>`, `<img onerror>`, backticks, `${…}`, quotes, newlines, long text.

## Actor / audit / events

Admin mutations go through the same `fetch` client with `x-actor-type: user`, `x-actor-id: admin-ui` (in this framework the human identity is actor type `user`; there is no `human` type) — a **declared identity for audit, not authentication** (documented; local caller can spoof; remote exposure stays prohibited until auth/tenancy/RBAC). Mutations never bypass the API/generated-service boundary. Tests assert exactly one audit + one event per create/update, none on failed validation/conflict, none on reads.

## Milestones

- [x] ExecPlan (this document).
- [x] `admin-core.js` pure helpers + unit tests.
- [x] `admin-modules.js` DOM views + nav + router in `app.js`.
- [x] Integration tests (fake document + real server) for Partner and Supplier.
- [x] `docs/ADMIN.md`, flow docs, README, JTBD matrix, ADR-009, skills.
- [x] `npm run verify` + `npm run smoke` green.

## Progress log

- Inspected the zero-build Admin; chose DOM-API rendering to avoid the existing innerHTML fragility for hostile data.
- Implemented core helpers, DOM views, hash router, nav, tests and docs.
- Final validation green from a clean worktree; two-module + restart proof passing.

## Decision log

- Hybrid renderer + empty override map: immediate default UI now, customization seam later, no generated Admin files.
- DOM-API rendering (not innerHTML) for all generated data — the one reliable XSS defense given untrusted manifest/record strings.
- Fake-document integration tests + real server instead of a browser dependency: keeps zero-dependency/CI-green; real-browser validation documented as a manual gap.
- Admin contract version gate (`SUPPORTED_ADMIN_CONTRACT`) so a future schema bump fails gracefully instead of mis-rendering.

## Explicitly deferred

Figma ingestion, theming, dashboards, kanban, delete, search, filters, pagination, bulk actions, reference-field UI, attachments, auth/tenancy/RBAC, remote exposure, real-browser CI. See out-of-scope list in the task.

## Adversarial review (post-merge-of-#5) decision log

- **Router hardening**: hash parsing moved into a pure, total `parseModuleRoute` in `admin-core.js` and unit-tested against malformed/encoded/dangerous inputs. Previously `decodeURIComponent` ran outside the render try/catch, so `#/modules/%zz` threw a `URIError` and broke routing; now malformed encoding, internal empty segments, encoded slashes, dot-segments and non-canonical names resolve to an explicit `invalid` view (or a safe `list`/404 for syntactically valid but unknown names). The active-nav link is selected by comparing the hrefs we built, never by constructing a `querySelector` from route input.
- **Capability gating tested end to end**: a module without `create` shows no Create action; without `update` the detail view is read-only (submit disabled). 
- **Stale render**: proven with controlled out-of-order promises (older list resolves after a newer one; newest view wins).
- **Real-browser validation path**: Path B (no CI browser) — DOM integration tests remain the CI proof; Playwright stays out of the project. A one-off real-Chromium smoke (16 checks) was run manually during review and passed, including the XSS-as-text assertion; `docs/ADMIN_SMOKE.md` is the reproducible manual checklist. The milestone is not claimed as browser-tested in CI.
