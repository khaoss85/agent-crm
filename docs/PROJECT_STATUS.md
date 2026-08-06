# Project status

The single operational snapshot of the repository. Volatile facts — merged
milestone, main SHA, test count, open PRs, next task — live **here and nowhere
else**; `docs/strategy/MASTER_PLAN.md` holds the stable vision and links to
this file.

> **Update this file in the same PR as every milestone merge.** A status file
> that lags is worse than no status file.

Generated: **2026-08-06**.

## Snapshot

| Fact | Value |
|---|---|
| Latest merged milestone | **M11 — Signature + Immutable Order** (ADR-017 + review addendum) |
| Main SHA at generation | `ade6c6683b402d353fd119ea1656d30cce495c95` (merge of PR #14) |
| Tests on clean main | **216 passing, 0 failing** (`npm run verify` from a fresh clone) |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | 26/26 in real Chromium, run manually — **not in CI** |
| CI | `verify` ×2 + GitGuardian green |
| Open PRs | `docs: add the platform alignment gate` (this PR — documentation only) |

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
```

Framework underneath: module manifest + generated migrations (M1), module
factory (M2), one generated resource contract over API/SDK (M3), generated
Admin (M4), generated-to-generated references (M5), code-first action runtime
(M6), core adapters (M7), pipeline registry (M8), declared-definition
fingerprints + prepare phase (M9), external-operation runtime (M11).

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
| — | Platform alignment gate (this PR): core-vs-domain boundary | ADR-018 |

## Next planned development

1. **Platform alignment gate** — this PR: documentation, ADR-018 and the
   adversarial-review skill. No runtime change.
2. **M12 — Order Activation & Subscription v1** — design drafted in
   `docs/plans/milestone-12-order-activation-subscription.md`; not implemented.
3. Then M13 Delivery Handover, M14 Delivery Economics & Acceptance,
   M15 Service Operations, M16 Analytics Studio — `EXECUTION_ROADMAP.md`.

A parallel platform track (domain package boundary, create-project CLI,
PostgreSQL, auth/tenancy/RBAC, Jobs & durable outbox, Integration Runtime, Data
Governance, Design-to-CRM, Cloud) runs alongside; sequencing and dependencies
are in `EXECUTION_ROADMAP.md`.

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

**Implemented (merged):** module manifest and factory; generated API/SDK/Admin;
references; actions; core adapters; pipelines; Lead Intelligence; Commercial
Operations; Signature and Order; MCP server; CLI.

**Documentation only (no code):** Contract/Subscription/Renewal; Delivery;
Service; Analytics Studio; Integration Runtime; Jobs & durable outbox; Data
Governance; Design-to-CRM; Agent CRM Cloud; create-project CLI; PostgreSQL;
auth/tenancy/RBAC; benchmark execution.

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
