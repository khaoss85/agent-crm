# Milestone 5 — reference fields end to end

## Goal and user-visible outcome

A generated record can belong to another generated record through a safe many-to-one reference:

```text
Partner
  └── Partner contact (partnerId → partner)
```

A user creates Partners, creates Partner Contacts linked to them, sees the relationship, and changes the linked Partner — no module-specific service or UI code.

## Current repository context

- **Manifest (Milestone 1)** already has `reference` fields: `references` names the target **table** (e.g. `partners`), optional `onDelete` (`restrict`/`cascade`/`set_null`, default `restrict`). Validation rejects SQLite-keyword targets and `set_null`+`required`.
- **Migration generation** already emits `REFERENCES <table>(id) ON DELETE <action>` + an index for reference fields — deterministic, keyword-safe.
- **Factory** currently **rejects** reference fields in `module create`.
- **Generated service** is constructed with `{database, audit, events}`; mutations run in a SAVEPOINT with audit inside and events after release.
- **Registry** is Map-backed; generated module definitions carry `kind: 'generated'`, `capabilities`, `fields` metadata, but **not** `table`.
- **create-app** registers generated modules by calling `createModule({database, audit, events})`.

Keeping the Milestone 1 syntax (`references` = target table) is required; no second syntax is introduced. The task's `targetModule` concept is the *module name*, which the framework derives from the target table via installed-module metadata.

## Approaches compared (required)

1. **Foreign key only.** The DB rejects a bad reference. *Cons*: the error is a raw SQLite failure, not a field-tied validation error; no target-capability check; poor agent/UX feedback. Insufficient alone (kept as defense-in-depth).
2. **Generated services import target services directly.** A generated module's source imports another's. *Cons*: static import cycles between generated modules (partner↔contact), fragile ordering, breaks the "regenerate one module" property. Rejected.
3. **Application-level reference resolver over service boundaries (chosen).** A small resolver, built per app instance, maps a target **table** to the installed generated module in the registry and validates via its `service.get`. Injected into every generated module as a `references` dependency. Resolution is **lazy at request time**, so all modules are registered by then — no import cycles, synchronous, per-instance (no global mutable state). Later, an explicit adapter can register a core module as a reference target without changing this contract.

Chosen: **3** — smallest safe design, useful errors, no cross-module SQL, no ORM/graph engine. Recorded as **ADR-010**.

## Reference resolution contract (ADR-010)

`packages/core/src/reference-resolver.js`: `createReferenceResolver(registry)` → `{ assertTarget(targetTable, id, fieldName) }`.

- `id` must be a non-empty string matching the project id shape; else `ValidationError` tied to `fieldName`.
- Finds the **generated** module whose `table === targetTable` in the registry; fails closed if none, if not generated, or if it lacks the `get` capability / `service.get`.
- Calls `service.get(id)`; `NotFoundError` → `ValidationError` (`fieldName`, `value`) "references a `<table>` record that does not exist". No cross-module SQL; no method other than `get`.
- No mutation, audit or event happens on the target during validation (it is a read).

## Manifest & target types

- Syntax: existing `reference` field with `references` = target table (canonical `^[a-z][a-z0-9_]*$`), `required`/`unique`, optional `onDelete`.
- **Generated-to-generated: supported (mandatory).** The target module must be installed and valid at plan time.
- **Generated-to-core: rejected this milestone** with a clear message (path 2 of the spec). Core tables are never silently treated as generated targets. A future explicit adapter is the extension point.
- **Optional self-reference: supported** (target table = own table) — the first record leaves it null, then may point at any existing record including itself.
- **Required self-reference: rejected at plan time** — its first record would be unseedable (nested/deferred writes are out of scope).
- **Cross-module cycles: not constructible via the CLI** — a reference requires its target installed first, so a mutual A↔B cycle is a chicken-and-egg the framework does not build; the resolver would tolerate one if present, but support is not claimed for a graph the CLI cannot create.
- Missing target module at plan time → actionable error before any file write.

## Plan / apply behavior

`module plan`/`create` for a reference-bearing manifest:
- resolves each `references` table to an installed generated module (via `scanExistingModules`); records `targetModule` (name), `targetTable`, `targetDisplayField` (derived), required/optional in the plan output;
- rejects: unknown target table, core-table target, target lacking `get`;
- self-reference allowed (the module being planned counts as installed for its own table);
- all Milestone 2 guarantees preserved: read-only plan, dry-run default, atomic apply with full rollback, deterministic/idempotent, collision checks, no partial state.

## Database & migration

- Reuses Milestone 1 generation: required reference → `NOT NULL … REFERENCES <table>(id) ON DELETE RESTRICT`; optional → nullable. `RESTRICT` is the documented default (no delete exists yet; **no cascade**).
- `PRAGMA foreign_keys = ON` is already set; a defense-in-depth test proves the DB rejects a bad id even if service validation were bypassed.
- Named-migration checksum/drift, deterministic output, fresh + existing-DB upgrade all preserved.

## Generated service semantics

- Constructor gains `references`. For each reference field, create/update validate **before** the mutation savepoint via `this.references.assertTarget(targetTable, value, field)` — so a bad target yields a `ValidationError` and **no INSERT/UPDATE, no audit, no event**.
- Required reference: non-blank string + target exists. Optional: omitted → not set; explicit `null` → cleared (stored NULL); provided → validated. Type-aware update diff (null clear detected).
- Stored/audited/evented value is the **id string only** — no denormalized target object, no joins, no inverse collections.
- Parameterized SQL, immutable-field protection, unknown-field policy: unchanged.

## API / SDK

- The generic `/api/modules/:module/records` routes and `client.module(name)` work unchanged: a reference is just an id string in the payload.
- Missing target → 400 `VALIDATION_ERROR` with `details.field`; no target internals leak. No nested resources, no target expansion.

## Schema & contract version

- Reference field metadata gains (additive, under **contract 1**): `type:'reference'`, `references` (table), `targetModule` (name), `targetKey:'id'`, `targetDisplayField`, `required`, `unique`, `targetKind:'generated'`.
- **Decision: stay on `generatedResourceContract: 1`** — the change is additive field metadata; an older Admin that doesn't know `reference` renders it via the text fallback (a raw id field), which is safe and still functional. Bumping the version would needlessly lock out compatible clients. Documented in ADR-010.
- Schema stays deterministic, sorted, machine-readable, no local paths; malformed target metadata degrades safely (field omitted / text fallback).

## Admin

- Reference field → accessible `select`, options loaded via `client.module(targetModule).list()` (safe limit 100), labelled with the target's `displayTitle`; value submitted is the id.
- Required → non-selectable placeholder; optional → "None" (submits documented `null`). Edit preselects the current target; if the current target is **not** in the first page, it is fetched by id and injected so the value is never silently lost. Missing/invalid target degrades to the raw id, never a crash.
- Labels render as `textContent`; per-field option lists isolated; stale option requests guarded; double-submit intact; keyboard/label a11y intact. Large target sets → searchable control is a documented later milestone.
- List/detail: show the resolved target label with the id preserved, target lookups deduplicated within a render (one fetch per distinct target, not per cell), raw-id fallback if unresolved.

## Display-title convention

Reuse `displayTitle`: first required string field, else id. Exposed as `targetDisplayField` in metadata. Tested with duplicate/missing/hostile/long labels and current-target-outside-initial-list.

## Security

Target module names come only from validated canonical metadata; table→module resolution scans the Map-backed registry (no prototype lookup, no dynamic import/eval); ids `encodeURIComponent`-ed in paths; no SQL interpolation; errors never leak SQL/paths/stack/registry. Tested with `__proto__`/`<script>`/`${…}`/encoded separators in ids, labels and metadata.

## Milestones

- [x] ExecPlan (this document).
- [x] `reference-resolver.js` + ADR-010.
- [x] Factory: allow references, plan dependency metadata, generate reference validation; add `table`/`references`/reference field metadata to the definition.
- [x] create-app: build + inject the resolver.
- [x] Admin: reference select control + label resolution.
- [x] Tests: manifest/plan/migration/FK/runtime/optional-clear/no-audit-on-fail/schema/API/SDK/Admin/restart/determinism.
- [x] Docs (manifest, factory, API, SDK, Admin, README, JTBD) + ADR-010.
- [x] `npm run verify` + `npm run smoke` green.

## Adversarial review (post-merge-of-#6) decision log

- **Required self-reference rejected at plan time**: it is unsatisfiable (the first record's required target cannot exist yet). Optional self-reference is supported and proven (root with null parent → may self-point). Cross-module cycles are not constructible via the CLI (target must be installed first); documented, not claimed as supported.
- **Resolver no longer swallows unexpected errors**: only `NOT_FOUND`/404 from the target `get` becomes a missing-target validation error; anything else propagates, so future permission/unexpected faults are not masked.
- **Admin honesty + bounds**: the reference selector shows a "first 100" truncation notice when the target list is capped; list-label resolution bounds by-id fallback fetches to 25 per column (raw id beyond), deduplicated by distinct id, with zero per-cell fetches when ids repeat.
- **Verified**: reverse migration-name order on a fresh DB (SQLite forward-reference at CREATE, FK enforced at insert); `PRAGMA foreign_key_list` shows the real FK (`partners.id`, `RESTRICT`); unique reference → 409; real-Chromium reference smoke (4 checks).

## Explicitly deferred

Many-to-many, inverse collections, polymorphic, nested writes, cascade/delete, relationship search/autocomplete, graphs, rollups, generated-to-core references (until an explicit adapter), clickable relationship navigation (optional), searchable large target sets.
