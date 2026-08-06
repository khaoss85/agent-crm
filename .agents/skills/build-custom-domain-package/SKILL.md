---
name: build-custom-domain-package
description: Create or extend a domain package in an Agent CRM repository - a bounded domain with its own resources, actions, policies, capabilities and schema metadata, registered statically and removable without touching the kernel. Use for "add a custom package", package contract, package dependency/capability, package validation or new-domain work, including customer-specific packages. Do not use for a single custom object (create-crm-module) or one lifecycle step on an existing record (create-crm-workflow).
---

Read `docs/PACKAGE_AUTHORING.md` first, then `DECISIONS.md` (ADR-018 and its addenda). The reference packages are `examples/custom-packages/partner-scorecard` (smallest, customer-authored), `packages/delivery` (depends on another package) and `packages/contracts` (offers a capability).

## Decide whether it is a package at all

1. One object with fields and CRUD → **module factory**, not a package. One lifecycle step on an existing record → **an action**. One versioned rule → **a policy**. Say so and do that instead; a package for a single object is overhead with no boundary.
2. A package is justified only when it owns several related resources, invariants across them, the actions that enforce those invariants, its own evidence records, and a real install/remove boundary.
3. Never create a package to hold shared helpers or to work around a kernel limitation.

## Author it against the public contract

1. Declare identity: `packageContract: 1`, a canonical `name` (`^[a-z][a-z0-9-]*$`), a positive integer `version`, a bounded `label` and `description`.
2. Declare `resources` — the record modules you own. Two packages claiming one resource is a startup failure, and declaring them is what makes that detectable.
3. Import **only** from `packages/core/index.js`. Anything under `packages/core/src/*` is private; `package validate` fails a package that reaches into it. If something you need is not exported, that is a missing public export or a missing runtime capability — raise it, do not deep-import.
4. Records are ordinary manifests applied by the module factory. Evidence records are `"writable": "managed"` throughout, so they are `get`/`list` publicly and exist only through your actions.
5. Actions are ordinary action definitions: same runtime, transaction, audit, events and trace. Versioned decisions go in policies with declared JSON-safe `config` so the ADR-015 fingerprint covers them; handlers stay deterministic, synchronous and total.
6. `metadata()` returns plain data only — no function, credential or path. Include a `notModeled` list: the limits are part of the contract.

## Cross-package dependencies

1. Reach another package **only** through a declared capability: `requires: [{package, capability, version}]`, opened with `domains.capability({consumer, capability, version, context: {modules, actor, now}})`.
2. Pass your own runtime handles as the context, so the capability participates in **your** transaction. That is what makes a cross-package commit atomic without sharing a database handle.
3. Offer the smallest interface that does the job — methods, never a service, table or query handle. Version it; a new shape is a new version.
4. Never deep-import another package's source. An undeclared reach is refused at runtime and a cycle is refused at startup, but the rule is the design, not the guardrail.

## Register, validate, prove

1. Registration is one static import in `packages/domains/generated/index.js`. No dynamic import, no `eval`, no remote install, no marketplace, no hot loading.
2. Run `npm run crm -- package validate <dir>` and `package inspect <dir>` — read-only, same validator as startup, non-zero exit on any problem.
3. Prove optionality: the same project without your package boots and behaves identically, and removing the import leaves the data alone.
4. Reuse `tests/helpers/package-conformance.js`, then add an end-to-end test that drives your action over the real HTTP/SDK path in a clean project.
5. Ship a README: what it owns, what it needs, how to enable it, what it deliberately does not do.

## Claims discipline

Update `docs/benchmarks/CRM_JTBD_MATRIX.md` conservatively — a row moves only with linked evidence, and a data model is not a completed job. Never describe a stored reference as access, permission or an account.

## Do not implement here

A package registry, npm publication, remote install, auto-update, cryptographic signing, a marketplace, hot loading, a scaffold generator (deferred until Delivery and Service settle the file shape), or any kernel patch.

Finish with `npm run verify`, the starter (`node examples/starters/b2b-lead-qualification/install.mjs`) and `docs/QUALITY_GATES.md`; leave the PR open for adversarial review.
