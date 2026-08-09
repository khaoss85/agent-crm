# Project status

The single operational snapshot of the repository. Volatile facts — merged
milestone, main SHA, test count, open PRs, next task — live **here and nowhere
else**; `docs/strategy/MASTER_PLAN.md` holds the stable vision and links to
this file.

> **Update this file in the same PR as every milestone merge.** A status file
> that lags is worse than no status file.

Generated: **2026-08-09**.

## Snapshot

| Fact | Value |
|---|---|
| Latest merged milestone | **DX4 — Package Conformance Kit** (`crm package test`), on top of **M15 — Service operations** and its package-scoped Service Admin, on top of **M14b2 — Delivery change, deliverables and acceptance** and the Agent Tool Surface / Legacy Alignment strategy docs, on top of **AX2 — Machine-readable Solution Plans**, **M14b1 — Delivery economics**, **AX1 — Deterministic application inspection**, **M14a — Delivery execution** (ADR-019 addendum 1), **Module Evolution v1** (ADR-019) and **M13** (ADR-018 + addenda 1–4) |
| Main SHA at generation | `845cd3d` (merge of PR #30 / DX1; PR #29 / DX3 merged as `05fafbd`) |
| Tests on clean main | **555 passing, 0 failing** (`npm run verify` from a fresh clone of `845cd3d`) |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | 37/37 in real Chromium on the M14a branch, plus 22 further checks for the M14b2 section as its pre-merge gate, both run manually — **not in CI** |
| CI | `verify` ×2 + GitGuardian green |
| Open PRs | **Go-to-market** (`claude/go-to-market-strategy-gkr4bz`): `origin/main` merged in on 2026-08-09. The claims ledger and its gate, the generated public site with SEO/AEO surfaces, every distribution manifest, the launch packet, the Edition L benchmark harness (ADR-024), the falsification kit and the surface budget. Open and unmerged. |
| npm | `accordo@0.0.1` and `create-accordo@0.0.1` published as **empty name reservations** on 2026-08-09 — confirmed against the registry, not assumed. Neither installs anything. The `@accordo` scope is **unclaimed** (`@accordo/mcp` and `@accordo/core` return 404), which is why `site/brand.json` records `npm.status: names-reserved` and the MCP-registry submission stays blocked. **This row describes the registry and nothing in it has changed.** |
| Project bootstrap | **`create-accordo` is real source and has a verified publication candidate**: `projectBootstrapContract: 1` creates the project; `packageAssemblyContract: 1` creates a bounded package directory while the source manifest stays private. The package test proves byte-identical packs, offline tarball installation and the installed bin through generated inspect, doctor, tests and smoke. The manual OIDC workflow stages only reviewed `main`; final approval remains human. **The published placeholder is untouched**, so `npm create accordo` still installs nothing and no provenance receipt exists yet. Plans: `docs/plans/project-bootstrap-installability.md`, `docs/plans/npm-create-accordo-publication.md`. |

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

## Next planned development

1. **LA0 — Legacy Characterization Harness** — implemented on an open PR,
   unmerged: `legacyCharacterizationContract: 1`, a checked-in baseline of Lead
   Intelligence's externally observable behaviour, and twelve mutations proving
   the suite can fail (`docs/plans/la0-legacy-characterization.md`). **No legacy
   domain extraction has begun**, and the Accordo public-brand and GTM work is a
   separate track that is neither merged nor approved here.
2. Then, in the order `docs/architecture/EXTRACTION_PREPARATION.md` recommends:
   resolve LA0's **two defect candidates**, the mechanical **neutral-helper
   move**, the two **architecture ADRs** (`app.intelligence` and the definition
   registry, both a human's), then the **Lead Intelligence extraction** and its
   review, then **DX2** and last **M16 Analytics Studio** — `EXECUTION_ROADMAP.md`.

Two parallel tracks run alongside and are not gated by domain progress: the
**platform track** (domain package boundary, PostgreSQL,
auth/tenancy/RBAC, Jobs & durable outbox, Integration Runtime, Data Governance,
Design-to-CRM, Cloud), the **Marketing & Growth track** (MK0–MK7 — design only;
`MARKETING_GROWTH_OPERATIONS.md`) and the cross-cutting **Agent Experience
track** (AX0–AX5 — AX0 is a strategy and a Skill, AX1 and AX2 are merged (AX2
is a machine-readable plan *contract* — not a planner and not a runtime) and
AX3–AX5 are not implemented; `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`). Sequencing and dependencies are in
`EXECUTION_ROADMAP.md`.

## Known platform limitations (not blockers, but not forgotten)

| Limitation | Consequence today | Tracked |
|---|---|---|
| The generated Admin renders **every** action a module declares and does not filter by the record's current state | a delivery record offers buttons its state cannot take; the server refuses them with a `409` naming the allowed moves, and the schema already publishes per-action `from`/`to` metadata a client can filter on | `TASKS.md` → Future platform items |
| JTBD and quality-gate evidence live in Markdown | no machine can aggregate them; a coding agent must read prose | `TASKS.md` |
| Source-only view of module evolution | the checked-in revision and migration list are knowable; what a particular database applied is not | `TASKS.md` |

## Production blockers

Everything below must land before the framework is safe for multi-user or
public use. None of it is started.

| Blocker | Consequence today |
|---|---|
| No authentication | the HTTP server is local-development-only; actor headers are not identity |
| No tenancy | no data boundary between customers |
| No RBAC | approval keys are labels; only actor *type* is enforced |
| No PostgreSQL adapter | SQLite only |
| No durable outbox | post-commit event delivery dies with the process |
| No scheduler | no renewal triggers, SLA timers, reminders or unattended follow-up |
| No secret management | no real provider credential can be handled safely |
| Browser E2E outside CI | UI regressions are caught manually |
| No real provider adapters | every provider is an offline fixture |

## Implemented versus documentation-only

**Implemented (merged):** module manifest and factory; module evolution and
adoption; generated API/SDK/Admin; references; actions; core adapters;
pipelines; Lead Intelligence; Commercial Operations; Signature and Order;
Contract activation and subscriptions; the public domain-package contract, the
delivery handover and delivery execution; deterministic application inspection
(AX1); delivery economics (M14b1); delivery change, deliverables and acceptance
evidence (M14b2); machine-readable Solution Plans (AX2); the project bootstrap
(`create-accordo`, source only — nothing is published); MCP server; CLI.

**Documentation only (no code):** renewal, billing and everything downstream of
activation; Service; Analytics Studio; Integration Runtime; Jobs & durable outbox;
Data Governance; Design-to-CRM; Accordo Cloud; a **published** npm package
(the bootstrap exists in source; the registry names are empty reservations);
PostgreSQL; auth/tenancy/RBAC; Marketing & Growth (MK0–MK7); the Agent
Experience track beyond AX0; benchmark execution.

## Keeping this file honest

- Update it in the milestone merge PR, not afterwards.
- Every number must come from a clean-clone run, not from memory.
- If a fact is stale, delete it rather than guess.
- **Future automation (not built, and deliberately not written in this PR):** a
  `npm run status` command could regenerate the snapshot table from `git
  rev-parse`, the test reporter's summary and the GitHub API, and CI could fail
  a milestone PR whose status block does not match. That is a small tool with
  real value — it is listed here so it is not forgotten, and it is out of scope
  for a documentation-only gate.
