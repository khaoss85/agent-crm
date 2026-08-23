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

Generated: **2026-08-23**.

## Snapshot

| Fact | Value |
|---|---|
| Latest merged milestone | **Production Spine v2 M0 characterization**, merged by PR #117 as `d1174fe`. M0 freezes the released SQLite migration identities and complete physical schema after every v1–v5 prefix, the existing synchronous and mixed Promise public contracts, executable CLI/MCP behavior, and the legacy `--db` SQLite-path ambiguity. It adds no PostgreSQL adapter or M1 storage seam; the next bounded implementation milestone is M1. |
| Measured at | `d1174fe` — the commit `site/claims.json` `measuredAgainst` names. This row repeats the ledger and measures nothing. |
| Tests | Measured, never typed. `npm run verify` is green on a clean tree at the commit above; **how many** tests that was lives in `site/claims.json` `measuredAgainst` and in no other file (ADR-027). |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | Real-Chromium checks remain manual and are **not in CI** — no workflow launches a browser, and `npm run smoke` is an in-process application smoke (`docs/ADMIN_SMOKE.md`). The Work v1 section has a **30-check** block, all passing, driven twice at `184e543`; it covers that section only and re-runs none of the earlier blocks. PR #58's desktop and mobile receipts still describe `ef8487a`, and nothing since has re-run them. |
| CI | The latest completed integration run concluded `success` on both jobs, `verify` and `public-claims`, at its own exact head. This row records that a run passed; it does not claim any particular commit is still the head. GitHub Actions holds the current answer. |
| Open PRs | **PR #99 — the OSS / managed-Cloud repository boundary — is open and deliberately unmerged**, awaiting a human decision. It is a design, five new documents under `docs/editions/` and nothing else: no file moved, none deleted, no private repository created, no licence changed. Merged this wave, in order: PR #95 (Customer Data Foundation v1, `2d74503`), PR #98 (**Production Spine v1**, `e30216c`) and the truth pass that carries this row. **Production Spine v1 is merged, and the sentence this row used to carry — "there is still no authentication, tenancy or role enforcement" — is retired**: tenancy and authorization now exist and are enforced. What does not exist is authentication. The framework authenticates nobody and ships no verifier, so "a human decided" still means an actor object said so — an actor now bounded by a fail-closed contract, a membership and a permission, and trustworthy exactly as far as the adapter a deployment supplies. |
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

1. The default product task remains the first unchecked item in `TASKS.md`:
   first-class Activity and Task modules with a reusable automatic follow-up
   workflow. No GTM branch silently changes that product order.
2. Before any remote CRM write surface, add tenant and role boundaries; the
   authenticated Streamable HTTP project MCP and PostgreSQL adapter remain
   separate platform work. The production Docs MCP is read-only framework
   documentation and does not satisfy any of those production gates.
3. The GTM stack and production promotion are complete. The active distribution
   task is to configure the `create-accordo` trusted publisher on npm for
   `khaoss85/agent-crm`, `stage-create-accordo.yml`, environment `npm-stage` and
   stage-only permission; then rerun, inspect and approve with human 2FA.
   Registry and marketplace claims remain blocked until a real receipt exists.

Two parallel tracks run alongside and are not gated by domain progress: the
**platform track** (domain package boundary, PostgreSQL,
authentication, Jobs & durable outbox, Integration Runtime, Data Governance,
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
| JTBD and quality-gate evidence live in Markdown | **partly closed.** `crm scenario run <scenario> --json` (DX6) maps real business journeys onto the JTBD index and publishes both what each run established and the counted list of rows it did **not**. **Two** scenarios and two journeys now ship over two different compositions — a sales funnel on the wall clock and a service SLA/escalation story on an injected, stepped clock — which is what turned the contract from one fitted to a single consumer into one with two (`scenarioRunContract: 2`). Still open: coverage is *claimed* rather than discovered, quality-gate status is still prose, and nothing promotes a row — a person does, on merged tests | `docs/SCENARIO_EVIDENCE.md`, `docs/plans/dx6-second-scenario.md`, `TASKS.md` |
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
pipelines; Lead Intelligence, Commercial Operations and Signature & Order —
all three now **package-native** (`packages/{intelligence,commercial,signature}`),
so every former legacy domain composes optionally and detaches without deleting
rows; Contract activation and subscriptions (contracts package **version 5**,
carrying its declared `signature/signature-orders@1` requirement); the public domain-package contract, the
delivery handover and delivery execution; deterministic application inspection
(AX1); delivery economics (M14b1); delivery change, deliverables and acceptance
evidence (M14b2); machine-readable Solution Plans (AX2); **Service operations
(M15)**; **renewal & expansion operations (M16a) — recorded intent and a
hand-off, nothing that renews, cancels, signs, prices or schedules**; the coding-agent
DX rungs **DX1, DX3, DX4, DX5, DX6, DX10 and LA0**; the project bootstrap
(`create-accordo`, source only — nothing is published); MCP server; CLI.

**Documentation only (no code):** billing, invoicing, revenue recognition and
everything else downstream of activation; renewal *execution* and amendment
(M16b — M16a records the intent and stops; the Signature extraction leaves it
architecturally **unblocked** — Commercial and Signature are reachable through
declared capabilities — and still entirely unimplemented); Analytics Studio; Integration Runtime;
Jobs & durable outbox; Data Governance; Design-to-CRM; Accordo Cloud; a
published **framework library** on npm (the create package is live; the framework
itself is vendored by it, never installed); PostgreSQL; authentication; Marketing & Growth (MK0–MK7);
the Agent Experience track beyond AX2 — except the AX3 benchmark, which
exists and has run (observation only: no product surface, no published
number, `comparative: false`); DX2 and DX9.

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
