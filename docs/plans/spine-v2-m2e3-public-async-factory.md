# Production Spine v2 M2E-3 — public portable async factory

This ExecPlan follows `.agent/PLANS.md`. It is a living implementation record
for M2E-3 only. M2E-2's private lifecycle, facade and awaited HTTP path are
merged. Dual bundled v1/v2 package graphs, default `accordo serve` migration,
deployment-storage wiring, dual-plane Spine and PostgreSQL remain outside this
plan.

## Goal and user-visible outcome

Publish one public asynchronous factory, `createAccordoAppAsync()`, that a
portable SQLite caller can `await` unconditionally. The factory:

- composes a real checked-in uniform v2 graph;
- provides useful kernel CRM behaviour rather than only refusing;
- returns the frozen 2B lexical-allowlist facade plus `{adapter, available}`;
- never wraps, redacts or `Promise.resolve`s `createAccordoApp()`;
- owns SQLite lifecycle and one shared close promise;
- leaves `createAccordoApp()` exactly synchronous and non-thenable;
- keeps PostgreSQL explicitly unavailable.
  <!-- truth: spine.postgresql.implemented=absent -->

The default selected graph is an **explicit** `packageContract: 2` with empty
package, action and module lists. Kernel Company, Contact, Opportunity and
Approval compose over that graph. The factory must not silently select bundled
or generated v1 packages as v2.

## Current repository context

Baseline: `de12e3d`, merged main including M2E-2B (#143), M2E-2C (#146) and the
M2F verifier pre-connect (#145).

- `packages/app/src/index.js` exports only `createAccordoApp`.
- `packages/app/src/create-app.js` remains the released synchronous factory.
  Its return is non-thenable, exposes `database` / nested handles, and selects
  `packages/domains/generated/index.js` plus `packages/actions/generated/index.js`.
  Those generated registries are empty in this framework repository and still
  publish inspection `packageContract: 1`.
- `packages/app/src/portable-app.js` `startPortableSqliteApp` already composes
  kernel CRM over 2A's owned storage handle and returns the leak-free facade.
  It requires an explicit selected graph; empty arrays carry no version.
- `packages/app/src/portable-http.js` `startPortableHttpServer` remains
  source-private. Default `accordo serve` still constructs the v1 factory.
- Every bundled domain package and the customer-authored partner-scorecard
  fixture remain `packageContract: 1`. Mixed graphs already refuse with
  `PACKAGE_ASYNC_CONTRACT_REQUIRED`.
- A public factory whose default invocation can only refuse still fails the
  DX Simplicity Gate. Kernel CRM over an explicit empty contract-2 graph is
  useful and honest, so this slice publishes the factory rather than withholding
  it for dual bundled definitions.

Repository inspection remains source-only: it opens no database, proves no
provider health and reports no runtime state.

## Approaches considered

### A. Wrap `createAccordoApp()` in `Promise.resolve` or an async redaction

Rejected. It would make the v1 object graph look portable, keep leaking
storage handles, and teach callers that the two factories are the same
application with a different return type.

### B. Withhold `createAccordoAppAsync` until every bundled package has a dual v2 graph

Rejected for this slice. Dual definitions are real later work, but they are
not the remaining prerequisite that prevents a useful public factory: kernel
Company/Contact/Opportunity/Approval already run on the portable path. A
factory that exists only to refuse would fail the DX Simplicity Gate.

### C. Publish `createAccordoAppAsync` over an explicit empty contract-2 graph

Chosen. The default selected graph states `packageContract: 2` and empty
lists in one lexical object. Callers who pass a selected graph still go
through 2A preflight, so v1 and mixed graphs refuse before SQLite opens.
Legacy custom packages stay on `createAccordoApp()` and fail closed on the
portable path. Dual bundled graphs remain deferred and named.

## Design and boundaries

### Distinct factories, one return type each

`createAccordoApp()` stays a synchronous function in `create-app.js`. This
slice does not edit that file. `createAccordoAppAsync()` lives in a new
module, imports `startPortableSqliteApp`, and never imports the v1 factory.
A caller never inspects an option to learn whether startup is async.

### Explicit default graph

```js
{
  packageContract: 2,
  packages: [],
  actions: [],
  modules: [],
}
```

Absence cannot mean v2. Generated domain/action registries are not read.
Passing `selected` is allowed so a uniform v2 graph can be composed; a v1
or mixed graph is refused with `PACKAGE_ASYNC_CONTRACT_REQUIRED`.

### Closed unavailable options

PostgreSQL-shaped options (`adapter`, connection URL/object, control-plane
endpoint) refuse with `STORAGE_ADAPTER_UNAVAILABLE` before any opener, path
or listener moves. Diagnostics never echo a credential. Dual-plane Spine,
identity-verifier, deployment-storage and the 2A test seams (`openDatabase`,
`listen`) refuse with `PORTABLE_OPTION_UNSUPPORTED` rather than being ignored.

### Lifecycle and close

The public factory owns the 2A lifecycle: preflight, open, post-open assembly
and one shared close promise. Successful return is the frozen 2B facade.

### HTTP and serve

This slice does not export `startPortableHttpServer` and does not change
default `accordo serve`. Portable HTTP/security awaits remain 2C's
source-private path. Package `start` hooks and capability-echo verification
run there; the default empty graph has none.

## DX Simplicity Gate

- **Failure prevented:** an agent wraps the v1 factory in `Promise.resolve`,
  treats a conditionally thenable `createAccordoApp()` as an application, or
  gets a public async factory whose default can only refuse.
- **Existing primitive insufficient:** `createAccordoApp()` is the
  characterized synchronous SQLite contract; changing it to always return a
  Promise breaks every in-process caller. The private 2B factory is not a
  public composition contract.
- **Overlap bound:** v1 remains the compatibility SQLite factory; v2 is the
  only portable composition contract. Internals stay unexported.
- **On-demand:** callers who need the characterized v1 path keep using it.
- **Portable evidence:** `packageContract: 2`, bounded `{adapter, available}`,
  child-process composition, and stable refusal codes.
- **Simpler goal flow:** one unconditional `await createAccordoAppAsync()` for
  portable SQLite kernel CRM.

## Milestones

### Public factory over explicit empty contract-2 (this PR)

1. [x] Add this complete plan before source changes.
2. [x] Add `createAccordoAppAsync` in a new module that calls
   `startPortableSqliteApp` with the explicit default graph.
3. [x] Export it from `packages/app/src/index.js`. Do not export lifecycle,
   portable-app or portable-http symbols. Do not edit `create-app.js`.
4. [x] Prove v1 sync and v2 async paths are distinct; mixed graphs refuse;
   the partner-scorecard fixture stays sync-compatible and portable-fail-closed;
   no credential or raw storage leak; `createAccordoApp()` remains
   sync/non-thenable; PostgreSQL-shaped options refuse before any path is
   created.
5. [x] Record Compatibility Backfill, living plan, TASKS and ADR addendum.

Exit: a public `await createAccordoAppAsync()` composes kernel CRM over
SQLite, returns the bounded facade, and does not select bundled v1 packages.

## Validation

```text
node --test tests/spine-v2-m2e3-public-async-factory.test.js
node --test tests/spine-v2-m2e2-portable-http.test.js
node --test tests/spine-v2-m2e2-portable-facade.test.js
node --test tests/spine-v2-m2e2-async-lifecycle.test.js
node --test tests/spine-v2-m2e1-contract-versions.test.js
node --test tests/custom-package-e2e.test.js
node --test tests/core-adapters.test.js tests/workflow.test.js tests/generated-api.test.js
npm run check
npm run surface:check
npm run repo:truth -- --check
git diff --check
npm run verify
```

Required observations:

- public surface exports `createAccordoApp` and `createAccordoAppAsync` only;
  internals stay private; core does not export the async factory;
- async factory source does not import `create-app.js`, generated registries,
  `Promise.resolve(` wrapping, or a `createAccordoApp(` call;
- `createAccordoApp()` remains a non-async function whose return is
  non-thenable and immediately readable, including `database`;
- default async app has `packageContract: 2`, empty `domains.names()`, kernel
  company write/audit, bounded `{adapter:'sqlite', available:true}`, no
  `database`;
- v1/mixed selected graphs and the v1 partner-scorecard package refuse with
  `PACKAGE_ASYNC_CONTRACT_REQUIRED` before a missing parent directory is
  created;
- PostgreSQL-shaped options refuse with `STORAGE_ADAPTER_UNAVAILABLE` and no
  credential in message or details;
- whole-object-graph leak walk finds nothing on the public async app;
- child process imports the public export, writes, reads audit, closes once;
- close is async, idempotent and shares one settlement.

## Progress log

- **2026-08-29:** Branched from merged main `de12e3d`. Chose approach C:
  publish `createAccordoAppAsync` over an explicit empty contract-2 kernel
  graph rather than wrapping v1 or withholding the factory until dual bundled
  definitions exist.
- **2026-08-29:** Added `packages/app/src/create-app-async.js` and exported it
  from `packages/app/src/index.js`. Default selected graph is lexical
  `packageContract: 2` with empty lists. `create-app.js` is untouched.
  `tests/spine-v2-m2e3-public-async-factory.test.js` covers distinct v1/v2
  paths, mixed-graph refusal, partner-scorecard fail-closed, leak walk,
  PostgreSQL credential-free refusal and a child-process public import.

## Decision log

- **Publish, do not withhold.** Kernel CRM over explicit empty contract-2 is
  useful application behaviour. Dual bundled graphs remain deferred and named.
- **New module, not `create-app.js`.** Editing the v1 factory file is how a
  conditional Promise leaks into the characterized path.
- **Default graph is lexical and explicit.** Inferring v2 from empty generated
  registries would repeat M2E-1's absence-means-support error.
- **Refuse unhonoured options.** Silently dropping `spine`, a verifier or a
  PostgreSQL connection would look like a portable production factory.
- **Do not change default serve.** Wiring `accordo serve` while bundled
  packages remain v1 would make the operator path refuse or silently drop
  domains. M2F owns entry-point selection.

## Outcome and follow-up

`createAccordoAppAsync()` is a public portable SQLite factory. Its default
invocation composes kernel Company/Contact/Opportunity/Approval over an
explicit empty contract-2 graph, returns the frozen 2B facade plus
`{adapter:'sqlite', available:true}`, and owns one shared close promise. It
does not wrap the v1 factory, does not read generated v1 registries, and
refuses PostgreSQL-shaped options before any path is created.

Follow-up, not this PR:

- Dual bundled v1/v2 package graphs
- Default `accordo serve` on the async factory
- Dual-plane Spine / identity-verifier / deployment-storage on this path
- PostgreSQL adapter (M3)
