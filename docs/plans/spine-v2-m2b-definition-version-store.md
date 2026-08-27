# Production Spine v2 M2B — the definition-version store

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to the four registry consumers that persist immutable definition/version
fingerprints into `definition_versions`. PostgreSQL, M2C, the Work
transaction-context seam, the workflow engine, the action runtime,
shared-database tenancy, and new public or agent-facing surfaces are explicitly
out of scope.

## Purpose

Remove four duplicated copies of the same raw SQLite persist-or-verify loop.
Commercial, Signature, Intelligence, and the package registry each opened
`database.transaction(...)`, prepared the same two raw statements, and repeated
the same ADR-015 immutability check. One internal core primitive now owns that
loop behind Storage Contract v1, so the four consumers keep their public shape
and their exact refusal text while no longer reaching the raw driver.

No public, agent-facing, MCP, REST or CLI surface changes. `persistFingerprints(database)`
keeps its signature on all four consumers, startup stays synchronous, and no
statement vocabulary is added to `packages/core/src/storage-contract.js`.

## Progress

- [ ] Baseline the registry suites before mutation.
- [ ] Add the internal definition-version store on Storage Contract v1.
- [ ] Migrate Commercial, Signature, Intelligence, and the package registry.
- [ ] Prove exact behaviour preservation per registry family.
- [ ] Add a structural no-raw-driver guard for the declared M2B slice.
- [ ] Reconcile truth, the M2A inventory, and the alignment matrix.
- [ ] Complete exact-head CI and Vercel gates.

## Current repository context

Storage Contract v1 is implemented by `packages/core/src/storage-contract.js`
and rendered for SQLite by `packages/core/src/database.js`. M2A moved Approval,
Contact, Opportunity, and Work's legacy-task reader behind it. Before M2B, four
registries still prepared raw statements against `definition_versions`:

- `packages/commercial/src/registry.js` — `CommercialRegistries.persistFingerprints`
- `packages/signature/src/registry.js` — `SignatureRegistries.persistFingerprints`
- `packages/intelligence/src/registry.js` — `IntelligenceRegistries.persistFingerprints`
- `packages/core/src/package-registry.js` — `PackageRegistry.persistFingerprints`

`definition_versions` is core migration v4 (`id, type, name, version,
fingerprint, registered_at`, `UNIQUE(type, name, version)`), and ADR-015 owns its
semantics: same identity plus same fingerprint is a no-op, same identity plus a
changed fingerprint stops the boot.

## Milestones

1. **Baseline.** Run the registry, package-contract, and characterization suites
   without changing source, so behaviour preservation is measured against a
   recorded starting point.
2. **Add the store.** One internal core primitive on Storage Contract v1, with
   fail-closed batch validation and injectable id/clock sources. The repository
   remains runnable and the store's own suite is green.
3. **Migrate the four consumers.** Replace each raw loop with a store call,
   family by family, keeping each family's suites green as it moves.
4. **Prove and guard.** Per-family insert, restart, drift, rollback, concurrency,
   metadata, and no-raw-message proofs, plus a structural guard scoped to exactly
   the four migrated files.
5. **Reconcile truth.** Regenerate Repository Truth, correct the M2A inventory
   rows that named these files as later M2 work, and update the alignment matrix.

## Raw-driver inventory

Re-derived by grep over `packages/` at this head, not copied from earlier prose.

| Classification | Path / consumer | Reason and disposition | Evidence owner |
|---|---|---|---|
| `M2B_CURRENT_SLICE` | `packages/commercial/src/registry.js` — catalog providers, discount policies | Raw persist-or-verify loop; migrate to the shared store. | `tests/commercial-contract.test.js`, `tests/commercial-e2e.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/signature/src/registry.js` — signature providers | Raw persist-or-verify loop with a hard-coded type string; migrate to the shared store, parameterising the type through the entry. | `tests/signature-contract.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/intelligence/src/registry.js` — enrichment providers, scoring models, routing policies | Raw persist-or-verify loop; migrate to the shared store. | `tests/intelligence-contract.test.js`, `tests/lead-intelligence-e2e.test.js`, M2B guard |
| `M2B_CURRENT_SLICE` | `packages/core/src/package-registry.js` — `domain-policy:<domain>:<kind>` | Raw persist-or-verify loop; migrate to the shared store. | `tests/contracts-registry-review.test.js`, M2B guard |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/database.js`, `packages/core/src/core-adapters.js`, `packages/core/src/spine-store.js` | SQLite adapter/compatibility internals own `DatabaseSync`, PRAGMAs, rendering, and raw-driver closure. | M0/M1 storage suites |
| `LATER_M2_CORE` | `packages/core/src/action-runtime.js` | Action-runtime persistence and trace remain a separate later-M2 slice. | action/trace suites |
| `LATER_M2_PACKAGE` | `packages/workflows/src/engine.js` | Workflow-run persistence is a separate runtime with joins and trace semantics. | workflow tests |
| `LATER_M2_PACKAGE` | `packages/work/src/follow-up.js#requireCallerTransaction` | Work's capability reads the raw driver's transaction flag to prove the caller's transaction; unchanged by M2B, so Work stays `partial`. | Work capability fault/concurrency suites |
| `MIGRATION_SOURCE_ALLOWED` | `packages/core/src/module-evolution.js` | Names the adapter-owned foreign-key migration check in explanatory source; it opens no driver. | module-evolution tests |
| `CHARACTERIZATION_ONLY` | fixtures and temporary-project harnesses under `tests/characterization/` | Direct SQLite setup is preserved test evidence, not production reachability. | characterization suites |
| `TEST_ONLY` | remaining occurrences under `tests/` | Fault injection, physical-schema assertions, and adapter tests intentionally exercise SQLite directly. | owning test files |

## Decisions

_(recorded during implementation)_

## Validation

Run these commands under Node 22.16.0:

```bash
node --test tests/spine-v2-m2b-definition-version-store.test.js
node --test tests/commercial-contract.test.js tests/intelligence-contract.test.js \
  tests/signature-contract.test.js tests/contracts-registry-review.test.js \
  tests/package-contract.test.js
node --test tests/commercial-e2e.test.js tests/lead-intelligence-e2e.test.js \
  tests/intelligence-pre-extraction-upgrade.test.js tests/signature-order-e2e.test.js
node --test tests/spine-v2-m0-characterization.test.js \
  tests/spine-v2-m1-storage-contract.test.js tests/work-legacy-task-migration.test.js
npm run repo:truth
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run smoke
git diff --check
npm run verify
```

## Progress log

- **2026-08-27:** Created this plan before touching source, and recorded the
  bounded slice and the later-M2 consumers.

## Outcome and follow-up

_(recorded at completion)_
