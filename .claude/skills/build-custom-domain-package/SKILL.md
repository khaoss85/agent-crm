---
name: build-custom-domain-package
description: Create or extend a domain package in an Accordo repository - a bounded domain with its own resources, actions, policies, capabilities and schema metadata, registered statically and removable without touching the kernel. Use for "add a custom package", package contract, package dependency/capability, package validation or new-domain work, including customer-specific packages. Do not use for a single custom object (create-crm-module) or one lifecycle step on an existing record (create-crm-workflow).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js", "packages/core/index.js", "examples/custom-packages/partner-scorecard"]
  repositorySurface: ["docs/PACKAGE_AUTHORING.md", "DECISIONS.md", "docs/QUALITY_GATES.md", "docs/benchmarks/CRM_JTBD_MATRIX.md"]
  degradesTo: "`crm package validate <dir>` and `crm package inspect <dir>` — the same validator startup runs — plus the composition reported by `crm app inspect --json`"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

The package contract itself is enforced by a command, not by a document: `npm run crm -- package validate <dir>` runs the same validator startup runs, and its problems are the authority on whether a package is well-formed.

**Background, where they exist:** `docs/PACKAGE_AUTHORING.md` and `DECISIONS.md` (ADR-018 and its addenda). The reference packages, where the project carries them, are `examples/custom-packages/partner-scorecard` (smallest, customer-authored), `packages/delivery` (depends on another package) and `packages/contracts` (offers a capability). They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## Decide whether it is a package at all

1. One object with fields and CRUD → **module factory**, not a package. One lifecycle step on an existing record → **an action**. One versioned rule → **a policy**. Say so and do that instead; a package for a single object is overhead with no boundary.
2. A package is justified only when it owns several related resources, invariants across them, the actions that enforce those invariants, its own evidence records, and a real install/remove boundary.
3. Never create a package to hold shared helpers or to work around a kernel limitation.

## Start from a scaffold

1. `npm run crm -- package scaffold <name>` prints a plan and writes nothing; `--apply` writes exactly two files, `src/index.js` and `README.md`, with an identity and five **empty** declarations. That output already passes `package validate`, `package inspect` and `package test` — start from it rather than from a copy of somebody else's domain.
2. It generates **no** record, action, policy, capability, provider, Admin section, Solution Plan or MCP tool, and that is deliberate. Do not treat the empty lists as something to be filled by pattern-matching another package: every entry you add is a decision about this business.
3. It composes nothing, opens no database and runs no migration. An occupied directory is refused, never overwritten; an invalid name is refused **with a suggestion**, never silently renamed — if you get `PACKAGE_NAME_INVALID`, ask for the canonical name explicitly rather than assuming the suggestion.
4. `--into <dir>` places the package outside `packages/`; `--json` gives you the plan, its per-file hashes and a `fingerprint`. Exit 0 planned or applied, exit 1 refused — so **read `modeReason`, not the exit code**, to know whether anything was written; an explicit `--dry-run` beats `--apply` and still exits 0.
5. A plan reserves nothing. `--apply` re-checks the target and answers `TARGET_CLAIMED` if another process got there first. An interrupted earlier run blocks nothing: its staging is reported as `staleStaging` for you to remove, never deleted automatically and never treated as a lock.
6. The scaffold cannot tell you the identity is unique in the application — it checks the target directory only. Compose the package, then run `crm app inspect --json`.

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
2. Walk the three commands in order; they answer three different questions and none of them substitutes for another:

```text
crm package scaffold <name>  an empty package that already conforms
crm package inspect <dir>    what does it declare, own, offer and need?
crm package validate <dir>   is that declaration structurally valid?
crm package test <dir>       does it hold up when a real application composes it?
npm test -- <your suite>     does it do the right thing?   ← only your tests answer this
npm run verify               does the whole project still hold?
```

3. `crm package test` (DX4) composes your package into a throwaway copy of the project and boots it twice — with it and without it. It proves the declaration, the boundaries, every composition refusal, module manifests and migration identity, attach and detach, and that `app inspect` describes the same package you declared. **Generic conformance is not domain correctness**: no action is executed, no policy is evaluated and no state transition is driven. Every such gap is a named limitation in the report, starting with `DOMAIN_CORRECTNESS_NOT_PROVEN`. Your business JTBDs still need package-specific tests.
4. All three commands **import** your package, and `test` also boots it, so your code runs with the CLI's authority. The harness does not intentionally mutate the caller project, and `test` imports your package from a throwaway copy rather than from your tree — but process isolation protects the invoking process from crashes, global-state changes and hangs, and is **not** a filesystem, network or OS sandbox. Never describe it as one.
5. **Do not patch the kernel to make a check pass.** A conformance failure is a statement about your package. If you are certain it is a statement about the framework instead, say so in the PR with the exact check id and evidence — and if it is a horizontal gap, it goes through the Compatibility Backfill Rule in `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, not through a local fix.
6. If your action targets a record another **package** owns, declare a capability of that package in `requires`. Without it, `package test` fails you with `UNDECLARED_PACKAGE_RECORD_DEPENDENCY` and names what the owner offers — because your package cannot be composed into any project that lacks the owner, and nothing in your declaration says so. Records **no** package owns are different: they belong to the host application, every package here acts on `order`, and depending on them needs no declaration. If no capability of the owner expresses what you do, that is a real seam gap: say so in the PR rather than working around it.
7. Prove optionality: the same project without your package boots and behaves identically, and removing the import leaves the data alone.
8. Reuse the shared package-conformance helper where the project ships one (`tests/helpers/package-conformance.js` in this repository); otherwise write the same assertions yourself. Then add an end-to-end test that drives your action over the real HTTP/SDK path in a clean project.
9. Ship a README: what it owns, what it needs, how to enable it, what it deliberately does not do.

## Claims discipline

Where the project carries a jobs matrix (`docs/benchmarks/CRM_JTBD_MATRIX.md` in this repository), update it conservatively — a row moves only with linked evidence, and a data model is not a completed job. Where it carries none, the rule still holds against whatever the project claims in its README and its package metadata. Never describe a stored reference as access, permission or an account.

## Do not implement here

A package registry, npm publication, remote install, auto-update, cryptographic signing, a marketplace, hot loading, or any kernel patch. The scaffold (DX3) exists and stops at an identity on purpose — do not extend it to generate domain semantics, to edit `packages/domains/generated/index.js`, or to run a migration. See `docs/plans/dx3-package-scaffold.md`.

Finish with `npm run verify`, the starter (`node examples/starters/b2b-lead-qualification/install.mjs`) and `docs/QUALITY_GATES.md`; leave the PR open for adversarial review.

## What the contract enforces, and what it does not (ADR-018 addendum 4)

1. The registry's indexes are private. `domains.get(name)` returns a **frozen public summary** — never a definition, never another package's `create()` or policy handlers. Do not look for a second route to an interface: there isn't one, and adding one is a kernel change.
2. A capability opens only for a consumer that declared it, from the package the declaration named. Declare the requirement; do not reach around it.
3. `metadata()` may add to your schema block but may **never restate** what the registry computes — `version`, `label`, `description`, `resources`, `requires`, `provides`, `actions`, `policies`. Those keys are refused at startup. It must return plain, function-free, JSON-safe data.
4. Package `name` is bounded (64 characters), lowercase-canonical, and Map-keyed.
5. Nothing here is a sandbox. `crm package validate` **imports and executes** your `src/index.js`; your actions and policies run in-process with full authority; and the consumer name passed when opening a capability is asserted by the caller. Never describe any of this as isolation.
