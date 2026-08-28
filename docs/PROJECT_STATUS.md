# Project status

The single operational snapshot of the repository. Volatile facts — merged
milestone, the commit the public numbers were measured at, open PRs, next task —
live **here and nowhere else**; `docs/strategy/MASTER_PLAN.md` holds the stable
vision and links to this file.

> **Update this file in the same PR as every milestone merge.** A status file
> that lags is worse than no status file.

**This file measures nothing of its own, and states no test count.** The count
is measured, never typed: it lives in `site/claims.json` under `measuredAgainst`,
written by `node scripts/measure-suite.js --apply` from a real green run on a
clean tree (ADR-027, `scripts/measure-suite.js`). The `Measured at` row below
*cites* that record's commit, and `npm run gtm:check` fails when the two
disagree. That binding exists because they did disagree, silently: a branch
re-measured the ledger, a merge resolved the conflict in favour of the older
side, and every gate stayed green while the published numbers ran a wave behind
the suite. This file used to own a second SHA and a second count of its own, and
a test pinned both in place — which is how a status file becomes the most
confidently wrong document in a repository.

Generated: **2026-08-28**.

## Snapshot

| Fact | Value |
|---|---|
| Latest merged milestone | **Production Spine v2 M2F cross-plane audit recovery and Spine-store closure**, alongside M2E-1's contract-v2 composition vocabulary. Core accepts uniform contract-1 and contract-2 package graphs, normalizes omitted capability contracts to synchronous v1, publishes the resolved values and refuses mixed package/action/operation/capability graphs before startup. Every bundled package and `createAccordoApp()` remain on the characterized synchronous v1 path; M2E-2 owns the portable async factory and M2E-3 owns dual bundled graphs. The internal storage contract exists; the handwritten Company slice and the current generated-service template use it for the characterized shapes. <!-- truth: spine.storage.contract=1 --><!-- truth: spine.storage.company_runtime=implemented --><!-- truth: spine.storage.generated_runtime=implemented --> M2A migrated Approval, Contact, Opportunity and Work's legacy-task reader; Work's legacy migration no longer reaches the raw driver. <!-- truth: spine.storage.work_legacy_raw=absent --> M2B consolidated the four definition-version stores, M2C moved workflow-run and trace-span persistence behind one execution-run store, M2D replaced the final business/package driver's transaction-state read with an opaque caller-owned witness, and this bounded M2F slice moved Organization/Membership persistence onto the seam. Their cross-plane security audit now commits an immutable tenant-bound intent with the control mutation and finalizes in the fixed short-control → committed-data → short-control-CAS order; failure returns committed-with-pending evidence rather than a false rollback. No application-runtime business or Spine-store consumer in `packages/` reaches the raw driver; only SQLite adapter internals remain. None of M2A–M2F adds a PostgreSQL adapter. <!-- truth: spine.postgresql.implemented=absent --> |
| Measured at | `27cc663` — the commit `site/claims.json` `measuredAgainst` names. This row repeats the ledger and measures nothing. |
| Tests | Measured, never typed. `npm run verify` is green on a clean tree at the commit above; **how many** tests that was lives in `site/claims.json` `measuredAgainst` and in no other file (ADR-027). |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | Real-Chromium checks remain manual and are **not in CI** — no workflow launches a browser, and `npm run smoke` is an in-process application smoke (`docs/ADMIN_SMOKE.md`). The Work v1 section has a **30-check** block, all passing, driven twice at `184e543`; it covers that section only and re-runs none of the earlier blocks. PR #58's desktop and mobile receipts still describe `ef8487a`, and nothing since has re-run them. |
| CI | The latest completed integration run concluded `success` on both jobs, `verify` and `public-claims`, at its own exact head. This row records that a run passed; it does not claim any particular commit is still the head. GitHub Actions holds the current answer. |
| Open PRs | GitHub's live PR list is authoritative. The bounded M2C evidence follow-up is complete in PR #139 and M2E-1 is merged in PR #140; M2E-2/M2E-3 and the remaining M2F deployment/configuration slices remain active infrastructure work, and this status does not infer their current PR numbers. PR #134 is unrelated strategic-roadmap work and is not part of the infrastructure campaign. No measurement runs until M2 is complete; `Measured at` and `site/claims.json` therefore still name `27cc663`, and `measurement.test_tree_current` correctly reads `false`. |
| Public discovery | GitHub About and all 20 intent topics are live. Smithery `khaoss85/accordo` returns 200 and exposes the three production Docs MCP tools. The GitHub social preview is live and **stale**: it was rendered from a much older measurement and its replacement still needs a manual Settings upload, which is a human step no branch can take. |
| npm | **`create-accordo@0.1.0` is live since 2026-08-19** — staged from CI through OIDC trusted publishing (run 32224731197, Sigstore provenance), approved by the maintainer with 2FA, and confirmed against the registry: the published shasum matches the CI assembly, `latest` resolves to `0.1.0`, and a clean-directory `npm create accordo` scaffolds a verifying project. `accordo@0.0.1` remains an **empty name reservation by design** (no framework library). The `@accordo` organization exists since 2026-08-19 and its scope is **deliberately empty**: `@accordo/mcp` was investigated and refused, because the project MCP server composes from the generated indexes of the tree it runs in and a published copy would answer about the wrong application (ADR-034). The MCP-registry submission is no longer blocked by it — `server.json` registers the remote documentation endpoint instead. `site/brand.json` records `npm.status: published`. |
| Project bootstrap | **`create-accordo` is real source and its publication is live**: `projectBootstrapContract: 1` creates the project; `packageAssemblyContract: 1` creates the bounded publishable directory while the source manifest stays `private: true` — publication never lowered that wall, because what npm published is the assembly, which strips `private`. The staged path proved itself the hard way: one dispatch died `E401` (a `registry-url` placeholder token preempting OIDC), the next `ENEEDAUTH` (no matching trusted-publisher config), and run `32224731197` staged clean once the publisher allowed `npm stage publish`. Plans: `docs/plans/project-bootstrap-installability.md`, `docs/plans/npm-create-accordo-publication.md`. |

## Completed functional path

```text
Lead capture
→ enrichment · explainable scoring · deterministic routing + assignment      M9
→ qualify / disqualify                                                        M6
→ convert into Company + Contact + Opportunity                                M7
→ Opportunity pipeline with a server-authoritative move-stage action          M8
→ catalog sync: products, versions, offers, price components, tiers           M10
→ composite quote (one-time + recurring; flat/per-unit/volume/graduated)      M10
→ immutable Quote Version + versioned discount policy + human approval        M10
→ signature envelope → verified events → signed-artifact evidence             M11
→ exactly one immutable Order (lines, components, tiers, grouped totals)      M11
→ plan activation, classify every component explicitly, resolve ambiguity     M12
→ Commercial Contract + immutable version + lines, Subscription + lines,      M12
  pending delivery and service obligations                                    M12
→ plan the delivery handover, decide who delivers what                        M13
→ Delivery Project + work packages + milestones + optional partner,           M13
  with the obligations marked handed over                                     M13
→ run the project: start, block with a stated reason, resume, complete;       M14a
  close it only over completed work packages and milestones                   M14a
→ record what it consumed: time and expense evidence, a versioned cost plan,  M14b1
  a reproducible contribution estimate grouped by currency                    M14b1
→ govern what changed: a change request decided once, an immutable plan       M14b2
  revision, or a commercial candidate that raises and stops                   M14b2
→ record what it produced and what a human says a customer accepted, over a   M14b2
  frozen, fingerprinted scope — evidence, never a billing trigger             M14b2
```

Every step above is merged.

Framework underneath: module manifest + generated migrations (M1), module
factory (M2), one generated resource contract over API/SDK (M3), generated
Admin (M4), generated-to-generated references (M5), code-first action runtime
(M6), core adapters (M7), pipeline registry (M8), declared-definition
fingerprints + prepare phase (M9), external-operation runtime (M11), optional
domain packages on a generic seam (M12), and a public domain-package contract
with declared capabilities, a validation CLI and a customer-authoring path (M13).

## Merged milestones and their ADRs

| Milestone | Outcome | ADRs |
|---|---|---|
| M0 | Vertical slice: Company/Contact/Opportunity/Approval, renewal workflow, API, Admin, CLI, MCP, trace, audit | ADR-001…005 |
| M1–M2 | Declarative manifest, generated migrations, module factory | ADR-006, ADR-007 |
| M3–M4 | One generated resource contract; generated Admin | ADR-008, ADR-009 |
| M5 | Generated-to-generated references | ADR-010 |
| M6 | Code-first record actions, atomic execution, post-commit events, trace | ADR-011, ADR-012 |
| M7 | Lead conversion through declared core adapters | ADR-013 |
| M8 | Code-first Opportunity pipelines + Admin board | ADR-014 |
| M9 | Lead Intelligence: enrichment, versioned scoring, routing | ADR-015 |
| M10 | Commercial Operations: composite catalog, quotes, discount policy, approval | ADR-016 |
| M11 | Signature + immutable Order, external-operation runtime | ADR-017 (+ addendum) |
| — | Platform alignment gate: core-vs-domain boundary | ADR-018 |
| M12 | Contract & Subscription activation — the first domain package outside core | ADR-018 addenda 1–2 |
| M13 | Delivery handover + the public package contract and custom-package authoring | ADR-018 addenda 3–4 |
| — | Module Evolution v1: revisions, a checked-in state file and append-only migrations | ADR-019 |
| M14a | Delivery execution: eight human-driven transitions, block evidence, a hierarchy gate | ADR-019 addendum 1 |
| AX1 | Deterministic application inspection: `crm app inspect`, source-only and read-only | — |
| M14b1 | Delivery economics: cost policy, append-only time and expense evidence, versioned plan, reproducible contribution estimate | ADR-014, ADR-016 |
| AX2 | Machine-readable Solution Plans: `crm solution inspect\|validate\|check`, bound to an `app inspect` report | ADR-020 |
| M14b2 | Delivery change, deliverables and acceptance | ADR-014, ADR-019 |
| M15 | Service operations: coverage, entitlements, a five-state support case, elapsed-time SLA evidence, escalation | ADR-018 |
| DX4 | Package Conformance Kit: `crm package test`, generic, composed and booted, never special-cased by name | ADR-018 |
| DX3 | Package Scaffold: `crm package scaffold`, a two-file empty-but-conforming package, dry-run by default | ADR-018 |
| DX1 | Project Doctor: `crm project doctor`, deterministic source diagnostics in ~155 ms, every finding naming an existing authority | ADR-018, ADR-019, ADR-020 |
| LA0 | Legacy Characterization Harness: a domain's externally observable behaviour frozen, replayed and required to be identical — the extraction gate | — |
| M16a | Renewal & expansion operations: the fourth domain package, the second to consume another through a declared capability. It records intent and hands off — it renews, cancels, signs, prices, invoices and schedules nothing | ADR-028 |
| DX5 | Project Verify: `crm project verify --json`, the authorities that already decide, orchestrated behind a blocking doctor preflight, with conformance executed for every composed package and dirty-mutation detection that never cleans | — |
| DX6 | Scenario Evidence: `crm scenario run <scenario> --json`, `scenarioRunContract: 2`. Two checked-in scenarios over two compositions and two clocks; it promotes no JTBD row and publishes the counted list of rows a run did **not** establish | ADR-029 |

## Next planned development

1. **Production Spine v2 M2 is under way: M2A, M2B, M2C, M2D, M2E-1 and the
   bounded M2F cross-plane-audit slice are merged; M2E-2/M2E-3 and the rest of
   M2F remain.** Its
   causal boundary is the remaining SQLite extraction
   and compatibility work named by the merged ExecPlans and Legacy Alignment Matrix.
   M2A extracted the Approval, Contact and Opportunity compatibility services
   and Work's legacy-task reader. <!-- truth: spine.storage.work_legacy_raw=absent -->
   M2B extracted the four definition-version registries behind one internal core
   store, M2C extracted the workflow engine and the action runtime's trace
   writer behind an execution-run store on the same seam, and M2D moved Work and
   Contracts' multi-write transaction proof behind an opaque caller-owned
   witness. The first M2F slice closes `spine-store.js` over the seam and makes
   Organization/Membership cross-plane audit explicitly recoverable without
   claiming a general outbox. Its startup boundary validates migration-plane
   identity, converges boundedly on a fresh-file race and closes every handle on
   a refused composition; legacy v1-v5 control adoption preserves dormant CRM
   tables while runtime handles remain separate. M2E-1 makes both contract
   vocabularies expressible and refuses mixed graphs; M2E-2 owns portable async
   composition and M2E-3 owns dual v1/v2 package graphs. The remaining M2F work owns deployment-storage
   configuration and bounded entry-point surfaces.
2. M2 must preserve the M0/M1 public contracts and must not be confused with the
   later production PostgreSQL adapter milestone. Cloud C0 and shared-database
   row tenancy remain outside this sequence.

The GTM stack and production promotion are complete; they are not queued work.
The independent longer-horizon tracks remain the private/public repository
migration, Spine v3 jobs/outbox/scheduler, Spine v4 secrets/backups/observability,
Customer Data Operations v2, Interactions, Billing, Marketing/Analytics, DX9,
DX13 and a real comparative benchmark once both harnesses exist.

## Known platform limitations (not blockers, but not forgotten)

| Limitation | Consequence today | Tracked |
|---|---|---|
| The generated Admin renders **every** action a module declares and does not filter by the record's current state | a delivery record offers buttons its state cannot take; the server refuses them with a `409` naming the allowed moves, and the schema already publishes per-action `from`/`to` metadata a client can filter on | `TASKS.md` → Future platform items |
| JTBD and quality-gate evidence live in Markdown | **partly closed.** `crm scenario run <scenario> --json` (DX6) maps real business journeys onto the JTBD index and publishes both what each run established and the counted list of rows it did **not**. **Two** scenarios and two journeys now ship over two different compositions — a sales funnel on the wall clock and a service SLA/escalation story on an injected, stepped clock — which is what turned the contract from one fitted to a single consumer into one with two (`scenarioRunContract: 2`). Still open: coverage is *claimed* rather than discovered, quality-gate status is still prose, and nothing promotes a row — a person does, on merged tests | `docs/SCENARIO_EVIDENCE.md`, `docs/plans/dx6-second-scenario.md`, `TASKS.md` |
| Source-only view of module evolution | the checked-in revision and migration list are knowable; what a particular database applied is not | `TASKS.md` |

## Production blockers

The framework now enforces one tenant per application instance and membership-
based permissions, but it deliberately authenticates nobody. These remaining
boundaries prevent a production PostgreSQL deployment from being claimed:

| Blocker | Consequence today |
|---|---|
| No deployment authentication verifier | identity is only as trustworthy as the deployment adapter; the framework ships no verifier |
| No PostgreSQL adapter | runtime storage remains SQLite-only; M0 is characterization and M1 is a SQLite seam |
| No durable outbox or scheduler | post-commit delivery, renewal triggers, SLA timers and unattended work do not survive process loss |
| No secret, backup or production-observability system | real provider credentials and recoverability cannot be operated safely |
| Browser E2E remains outside CI | current Chromium receipts are manual and Admin regressions are not browser-gated on every push |
| No real provider adapters | provider behavior remains offline fixture behavior |

## Implemented versus documentation-only

**Implemented (merged):** manifest/factory/evolution; generated API, SDK and
Admin; references, actions, workflows, pipelines, audit and trace; the optional
Lead Intelligence, Commercial, Signature, Contracts, Delivery, Service and Work
packages; contract activation plus governed renewal and amendment execution;
Production Spine v1 one-instance/one-tenant binding and membership permissions;
the checked SEE/PLAN/BUILD/CHECK/PROVE rails; CLI and MCP; and the live
`create-accordo@0.1.0` bootstrap package. Production Spine v2 M0 is executable
characterization only; M1 added the internal SQLite storage contract, M2A
migrated the named compatibility consumers onto it, M2B moved the
definition-version registries behind one internal store on the same seam, M2C
moved workflow-run and trace-span persistence behind another, and M2D removed
the last business/package raw-driver reach by proving caller-owned transaction
context through the structured storage handle. The bounded M2F audit slice then
moved Spine Organization/Membership persistence behind that seam and added
immutable tenant-bound intent/reconciliation for the one demonstrated
cross-plane security failure; it is not the later general jobs/outbox system.
M2E-1 separately made uniform contract-1 and contract-2 package graphs
expressible and refused mixed graphs while leaving the bundled packages and
the synchronous application factory on v1.
<!-- truth: spine.storage.contract=1 -->
None of them adds PostgreSQL storage, and the seam stays SQLite-only rather than
portable.

**Not implemented:** the PostgreSQL production adapter and later Spine v2
milestones; deployment authentication; billing, invoicing and revenue
recognition; Interactions; Marketing/Analytics; remote package registry
install/update/uninstall; durable jobs/outbox/scheduler; secrets, backups and
production observability; shared-database row tenancy; and Cloud C0. The AX3
benchmark remains observation-only (`comparative: false`), not a product
capability or published performance claim. The framework library itself is not
an npm package: the live create package vendors the framework into a project.

## Keeping this file honest

- Update it in the milestone merge PR, not afterwards.
- Every number must come from a clean-clone run, not from memory.
- If a fact is stale, delete it rather than guess.
- **The `Measured at` row is checked, not trusted.** `npm run gtm:check` fails
  when its SHA is not the one in `site/claims.json` `measuredAgainst`, and fails
  again if any document under `docs/` types a test count instead of citing the
  ledger. That is the whole of the automation: two literal comparisons, no
  natural-language inference and no new command
  (`scripts/measurement.js`, `tests/repository-truth.test.js`).
- **Future automation (not built, and deliberately not written in this PR):** a
  `npm run status` command could regenerate the snapshot table from `git
  rev-parse`, the test reporter's summary and the GitHub API, and CI could fail
  a milestone PR whose status block does not match. That is a small tool with
  real value — it is listed here so it is not forgotten, and it is out of scope
  for a documentation-only gate.
