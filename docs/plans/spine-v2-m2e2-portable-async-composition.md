# Production Spine v2 M2E-2 — portable async composition

This ExecPlan follows `.agent/PLANS.md`. It is a living implementation record
for M2E-2 only. M2E-1's version vocabulary is merged; M2E-3's dual bundled
graphs are not. PostgreSQL, deployment-storage loading, production MCP/CLI,
cross-plane recovery and package migration remain outside this plan.

## Goal and user-visible outcome

Build the one unconditional asynchronous composition path that a portable
SQLite/PostgreSQL application will eventually use, while keeping the released
SQLite factory exactly synchronous. M2E-2 is split so that lifecycle and
ownership can be reviewed before the much larger application graph is moved:

- **2A — contract, preflight and SQLite lifecycle.** A selected graph is proved
  uniformly async-v2 before a database, migration, provider or listener can be
  reached. A source-private SQLite lifecycle then owns open, post-open startup
  and idempotent close, preserving the original failure if cleanup also fails.
- **2B — private graph and portable facade.** Compose the real service graph
  directly over 2A's owned handles and return one frozen, lexical, allowlisted
  facade. It is never a spread, wrapper or redaction of the v1 app.
- **2C — HTTP and security awaits.** Await every v2 action, operation,
  capability and security decision; verify capability entry/interface echoes;
  and make the eventual server path await startup before listening.

The user-visible factory is intentionally **not** exported by 2A. The checked-in
default graph is still v1, so a public `createAccordoAppAsync()` would be a
surface whose default invocation can only refuse. M2E-3 makes the default graph
usable by adding explicit dual definitions. Until then 2A is internal machinery,
not a placeholder API.

## Current repository context

Baseline: `6f7808ed8d833384a41c8831f76bc8dc602f2950`, the merged M2E-1 head.

- `packages/app/src/create-app.js` is the released synchronous factory. It opens
  SQLite synchronously, composes the v1 object graph and returns it immediately.
  `packages/app/src/index.js` exports only `createAccordoApp`.
- `packages/core/src/package-composition.js` validates package/action/operation/
  capability contract agreement and reports mixed graphs with
  `PACKAGE_ASYNC_CONTRACT_REQUIRED`. A uniform v1 graph remains valid there,
  because composition is also the authority for the released sync path.
- `packages/core/src/database.js` creates SQLite and exposes one storage handle
  whose `transactionAsync` ownership witness is bound to that exact connection.
  A future pooled adapter must preserve that connection affinity; a pool-level
  facade cannot inherit it by assertion.
- `packages/domains/generated/index.js` and
  `packages/actions/generated/index.js` are the checked-in selected graph and
  are empty in this framework repository. Their absence does not mean async-v2:
  the application inspection still publishes `packageContract: 1`.
- `createAccordoApp({dbPath: ':memory:'})` exposes SQLite handles at the top
  level and throughout nested audit/service/workflow/module objects. That graph
  is a compatibility surface and must not be copied then redacted.
- ADR-018 addendum 9 defines a uniform graph: v1 means synchronous SQLite; v2
  means every consumer awaits. M2E-1 deliberately left instantiation-time echo
  verification and Promise-shaped-v1 refusal to this plan.

Repository inspection at the baseline is `valid: true`, `problems: []`, with
zero selected packages/actions/providers. Its limitations remain binding:
source inspection opens no database, proves no provider health and reports no
runtime state.

## Design and boundaries

### The selected graph is explicit and private

2A introduces a source-private selected-graph record with an explicit
`packageContract`, package declarations, top-level actions and the module names
those actions may target. The explicit graph contract is necessary for the
empty-graph case; inferring v2 from an empty array would be the same
absence-means-support error M2E-1 removed from capability declarations.

Preflight is pure and runs once. It:

1. rejects a selected contract other than 2 with the existing stable
   `PACKAGE_ASYNC_CONTRACT_REQUIRED` identity;
2. resolves the package graph through the M2E-1 composition authority and
   propagates its bounded first material problem;
3. requires every accepted package and top-level action to agree with selected
   contract 2, while ordinary malformed declarations retain their existing
   validation identities;
4. returns frozen list containers and accepted facts while retaining exact
   executable package/action identities — no object spread, clone, Proxy or
   mutation.

The preflight token is lexical input to lifecycle startup. Code after it does
not re-read a mutable declaration to decide which contract was accepted.

### The SQLite lifecycle is real ownership, not an async wrapper

2A must not implement either of these rejected shapes:

```js
Promise.resolve(createAccordoApp(options))
async () => redactOrWrap(createAccordoApp(options))
```

The source-private lifecycle opens its own SQLite adapter only after preflight,
passes the exact connection-affine storage handle to post-open assembly, and
owns that adapter until close. Post-open assembly is an internal callback seam
for 2B's real graph builder, not a public extension point. It pays for itself by
closing the demonstrated failure window: if assembly throws after open, 2A
closes the adapter before rethrowing the original error. A cleanup failure is
reported separately and never replaces the primary startup cause.

Successful startup returns an internal lifecycle receipt, not an application
facade. `close()` is unconditional async and idempotent: the first call owns one
close promise and every later call returns that same settlement. Signal/error
paths can therefore race without double-closing SQLite or manufacturing a new
failure. No listener, provider or timer is installed by 2A.

The two concrete imminent consumers are:

1. **2B's private graph assembler**, which receives the accepted graph and exact
   storage handle and produces the portable facade;
2. **2C's awaited server/security startup**, which owns the lifecycle receipt
   until the server closes and must settle it on startup failure or signal.

There is also a demonstrated correctness failure — an exception after open can
leak a handle — so this internal seam meets ADR-029 even before both consumers
merge.

### v1 is preserved, not adapted

`createAccordoApp()` and its export file are outside 2A source edits. Its return
must remain non-thenable, its service reads immediately usable, its nested
object/handle identity unchanged and its option-independent return type stable.
Promise-returning writes already accepted by v1 are not the prohibited shape;
the prohibited shape is a Promise used where a v1 consumer expects a domain
value.

2B will build a second **private** graph from shared lower-level constructors.
It will never derive from the v1 app object. The portable facade is a frozen
object literal whose keys are allowlisted at its lexical construction site.
Whole-object-graph tests will walk own properties, prototypes, Maps/Sets and
accessors without invoking arbitrary user code and prove no database, raw
driver, service-private database field, binding path or credential is reachable.
A top-level descriptor is not sufficient evidence.

### Transaction affinity and async execution

SQLite's async transaction method remains bound to the exact storage handle
that owns its connection and witness. 2A hands that identity forward rather
than reconstructing a facade around it. 2B/2C must await every contract-2
service/context/dependency operation and verify a returned capability
interface's optional `capabilityContract` echo against the accepted declaration.
The M3 PostgreSQL adapter must bind the same identity to a checked-out client,
never to the pool.

## Milestones

### 2A — contract, preflight and lifecycle (this PR)

1. [x] Add this complete plan before source changes.
2. [x] Add failing-first tests for v1-only, mixed and uniform-v2 selected graphs.
   Refusal must happen before a SQLite path/directory, migration, opener spy,
   provider spy or listener can move.
3. [x] Add the source-private preflight and lifecycle. Do not export it from
   `packages/app/src/index.js` or `packages/core/index.js`.
4. [x] Prove a real v2 SQLite child process can open, transact through the storage
   seam, read its committed result and close. A direct in-process call alone is
   insufficient.
5. [x] Fault post-open assembly and close independently. Prove owned cleanup runs
   once, close is idempotent, and cleanup never masks the startup cause.
6. [x] Re-run sync factory characterization: exact public export, non-thenable
   return, immediate reads and existing application suites.

Exit: lifecycle/preflight are usable only by source-private imports; no second
public factory exists, no v1 app object is wrapped, and all 2A tests/gates pass.

### 2B — private graph and portable facade (this PR)

1. [x] Extract/share lower-level constructors without making the v1 app the input.
2. [x] Compose modules, packages, actions, operations, audit, workflow and
   provider state directly over 2A's lifecycle.
3. [x] Return a frozen lexical allowlist facade plus bounded storage descriptor.
4. [x] Add the adversarial whole-object-graph leak test covering every nested v1
   leak found by the M2F audit.
5. [x] Keep the factory source-private while the default selected graph remains v1.

Exit: a private uniform-v2 SQLite graph works end to end and exposes no storage
handle through its portable facade.

### 2C — HTTP/security awaits and entry-point proof (this PR)

1. [x] Await every contract-2 action, operation, capability and authorization path;
   refuse Promise-shaped v1 values at their first observable execution seam.
2. [x] Verify capability declaration/interface contract echoes at instantiation.
3. [x] Make the selected SQLite server path await full startup before listening and
   close lifecycle ownership on startup failure. Close is one shared promise.
4. [x] Preserve route/SDK response envelopes and add child-process entry-point
   evidence. Do not absorb M2F CLI/MCP or change default `accordo serve`.

Exit: HTTP/security behavior is portable and awaited. Public factory promotion
still waits for M2E-3's usable default v2 graph.

## Validation

2A runs at least:

```text
node --test tests/spine-v2-m2e2-async-lifecycle.test.js
node --test tests/spine-v2-m2e1-contract-versions.test.js
node --test tests/core-adapters.test.js tests/workflow.test.js tests/generated-api.test.js
node scripts/falsify.js
node --test tests/spine-v2-m2-requirement-map.test.js
npm run check
npm run surface:check
npm run repo:truth && npm run repo:truth -- --check
git diff --check
npm run verify
```

Required observations:

- v1/mixed portable selection: exact stable refusal, no path, opener, provider
  or listener side effect;
- uniform v2: child process opens SQLite, completes an async transaction, reads
  the row, closes and exits zero;
- post-open failure: close once, original cause preserved;
- success close: repeated calls share one settlement and close once;
- v1 factory: same export, non-thenable result, immediate synchronous reads;
- public surface: no `createAccordoAppAsync` export and no accepted-version
  constant leaked.

2B runs at least:

```text
node --test tests/spine-v2-m2e2-portable-facade.test.js
node --test tests/spine-v2-m2e2-async-lifecycle.test.js
node --test tests/spine-v2-m2e1-contract-versions.test.js
node --test tests/core-adapters.test.js tests/workflow.test.js tests/generated-api.test.js
node scripts/falsify.js
npm run check
npm run surface:check
npm run repo:truth -- --check
git diff --check
npm run verify
```

Required observations:

- public surface: still only `createAccordoApp`; no `createAccordoAppAsync` and
  no `startPortableSqliteApp` export;
- portable factory source does not import or call the v1 factory;
- v1/mixed selection still refuses before any opener, path, provider or
  listener moves;
- uniform v2: frozen lexical-allowlist facade, bounded `{adapter, available}`
  descriptor, kernel write/audit/workflow plus selected package action and
  operation;
- whole-object-graph leak walk: no database, raw driver, storage handle,
  binding path or credential reachable, including the nested M2F v1 sites;
- the same walker is not vacuous against `createAccordoApp()`;
- child process composes, writes through a service, reads audit, closes once;
- close is async, idempotent and shares one settlement.

2C runs at least:

```text
node --test tests/spine-v2-m2e2-portable-http.test.js
node --test tests/spine-v2-m2e2-portable-facade.test.js
node --test tests/spine-v2-m2e2-async-lifecycle.test.js
node --test tests/spine-v2-m2e1-contract-versions.test.js
node --test tests/http-envelope.test.js tests/spine-route-authorization.test.js
node --test tests/core-adapters.test.js tests/workflow.test.js tests/generated-api.test.js
npm run check
npm run surface:check
npm run repo:truth -- --check
git diff --check
npm run verify
```

Required observations:

- public surface: still only `createAccordoApp`; no `createAccordoAppAsync`,
  `startPortableSqliteApp` or `startPortableHttpServer` export;
- portable HTTP source does not import or call the v1 factory;
- v1/mixed selection still refuses before any opener, provider or listener;
- listener spy is zero until composition, security start, identity-verifier
  assembly, package startup hooks and capability-echo verification settle;
- hanging async security provider never binds a listener;
- rejecting identity verifier / package `start` hook close owned resources and
  never listen;
- thenable capability interface treated as a domain value is refused before
  listen;
- HTTP body `{ items: Promise }` is refused with
  `PACKAGE_ASYNC_CONTRACT_REQUIRED` rather than JSON.stringified as `{}`;
- startup failure plus cleanup failure preserves the original cause via 2A
  `attachCleanupError`;
- capability declaration/interface contract echoes are verified before
  `/health` is reachable;
- portable HTTP awaits service create, record action and operation execution;
- v1 `createAccordoApp()` HTTP envelopes stay 201/200 domain objects;
- child process starts portable HTTP, writes through a route, reads audit,
  closes once;
- default `accordo serve` still constructs the synchronous factory.

## Progress log

- **2026-08-28:** Created a new causal branch from merged M2E-1 head
  `6f7808ed8d833384a41c8831f76bc8dc602f2950`. Read the ratified M2 section,
  ADR-018 addenda 7–9, the package-authoring contract, current application
  inspection and the v1 factory/database sources. Chose a source-private 2A
  because the checked-in graph remains v1 and a public factory whose default
  always refuses fails the DX Simplicity Gate.
- **2026-08-28:** Added `packages/app/src/async-lifecycle.js` (not exported) and
  `tests/spine-v2-m2e2-async-lifecycle.test.js`. Preflight reads the selected
  contract once, delegates package problems to M2E-1 composition, and opens
  SQLite only after a uniform v2 graph is accepted. Close is one shared
  promise; assembly failure closes the adapter without replacing the cause.
- **2026-08-28:** Node 22.16 CI rejected `using` in the 2A tests; cleanup now
  uses `t.after`. Frozen/sealed/non-extensible startup errors stay the
  rejection when close also throws, with a bounded console report instead of a
  TypeError. The Compatibility Backfill Rule records M2E-2A as private
  lifecycle, not a complete portable factory.
- **2026-08-28:** 2B from merged `c37f349`. Added source-private
  `packages/app/src/portable-app.js` and
  `tests/spine-v2-m2e2-portable-facade.test.js`. The portable factory assembles
  kernel modules, selected packages/actions/operations, audit, workflow and
  providers over 2A's storage handle and returns one frozen lexical-allowlist
  facade plus `{adapter: 'sqlite', available: true}`. The leak walk covers own
  properties, prototypes, Maps/Sets and accessor descriptors without invoking
  getters or methods. `packages/app/src/create-app.js` is not an input.
- **2026-08-29:** 2C from merged `bf5bd6e` (PR #143). Added source-private
  `packages/app/src/portable-http.js` (`startPortableHttpServer`) and
  `tests/spine-v2-m2e2-portable-http.test.js`. Security/identity/authorization
  assembly, package `start` hooks and capability-contract echoes settle before
  `listen`. `createHttpServer` awaits identity verification, authorization and
  service/action/operation results, and refuses a thenable standing in for a
  domain value at the dispatcher. Startup failure closes owned resources via
  2A `attachCleanupError` and never binds a listener. Default `accordo serve`
  is unchanged. There is still no public `createAccordoAppAsync`. Commercial,
  Intelligence and Signature characterization observations are unchanged; only
  the `apps/server/src/http-server.js` source digest moved because handlers now
  await identity, authorization and service/action/operation results.

## Decision log

- **No public factory in 2A.** The two immediate consumers are internal 2B and
  2C. M2E-3, not this lifecycle PR, makes the default graph callable.
- **Explicit contract on the selected graph.** Empty arrays carry no version;
  absence cannot mean v2.
- **Idempotent async close.** Server signal/error paths can converge on one
  close promise. Stable refusal on a second call would turn ordinary cleanup
  races into application failures.
- **Exact executable identities.** Freeze list containers and accepted facts;
  never spread, proxy, bind or clone packages/actions/capabilities.
- **No v1 app wrapper.** Shared lower-level assembly is allowed in 2B;
  transforming the released app after construction is not.
- **No transaction facade reconstruction.** The lifecycle passes the exact
  connection-affine storage handle. PostgreSQL must later bind the equivalent
  handle to one checked-out client.
- **Lexical facade, not dynamic aliases.** v1 attaches `appMethod` keys onto
  the returned object after construction. 2B's keys are listed at the freeze
  site; selected operations are reached through `operations.run(name)`, never
  as extra own properties. 2C may map those names onto HTTP without widening
  the in-process allowlist.
- **Portable core adapters over storage.** v1 `createCoreAdapters` still reads
  `database.raw`. The portable path reimplements the same declared capabilities
  through Storage Contract v1 so the facade never holds a driver.
- **No Spine in 2B.** 2A owns one SQLite adapter. Control-plane/tenant binding
  composition stays with 2C/M2F coordination, not this facade.
- **Source-private HTTP entry, not default serve.** 2C owns
  `startPortableHttpServer`. Wiring it to `accordo serve` while the bundled
  graph is v1 would be a public factory whose default invocation can only
  refuse. M2F owns deployment-storage/CLI selection; this slice does not
  absorb that scope.
- **Thenable-as-domain-value is refused, not awaited-away, when it is the
  value.** Contract 2 settles a Promise of an interface. A thenable that
  already carries `capabilityContract` (the thenable trap) and an HTTP
  `{ items: Promise }` envelope are refused with
  `PACKAGE_ASYNC_CONTRACT_REQUIRED` at the first observable seam.
- **HTTP `appMethod` aliases stay off the 2B facade.** 2C attaches them on an
  HTTP-only adapter so enumerated routes (`syncCatalog`, …) work without
  widening the in-process allowlist.

## Outcome and follow-up

2A is source-private preflight/lifecycle evidence. 2B is the source-private
portable graph/facade over that lifecycle: kernel Company/Contact/Opportunity/
Approval plus a selected uniform-v2 package graph, frozen allowlist, bounded
storage descriptor, and a whole-object-graph leak test. 2C is the
source-private awaited HTTP/security entry over that facade: composition,
security, package startup and capability echoes settle before listen; HTTP
handlers await service/action/operation/capability execution; a thenable is
never a domain value at the dispatcher. It does not compose generated project
modules, bundled v1 domains, dual-plane Spine, or change default serve.
M2E-3 published `createAccordoAppAsync()` over an explicit empty contract-2
kernel graph (`docs/plans/spine-v2-m2e3-public-async-factory.md`). Dual bundled
v1/v2 package definitions remain later compatibility work.
