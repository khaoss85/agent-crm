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
| Latest merged milestone | **M12 — Contract & Subscription Activation** (ADR-018 + addenda 1–2), the first domain package |
| Main SHA at generation | `97a37fe` (merge of PR #16) |
| Tests on clean main | **249 passing, 0 failing** (`npm run verify` from a fresh clone); **273 passing** on the open M13 branch (after the adversarial review) |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | 27/27 in real Chromium, run manually — **not in CI** |
| CI | `verify` ×2 + GitGuardian green |
| Open PRs | PR #17 `feat: add package-native delivery handover` (M13 — adversarially reviewed and corrected, awaiting human merge) |

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
```

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
| M13 | Delivery handover + the public package contract and custom-package authoring (open PR, not merged) | ADR-018 addendum 3 |

## Next planned development

1. **M13 — Delivery Handover + Custom Package Authoring v1** — this PR: the
   public domain-package contract with declared capabilities, the package
   validation CLI, the authoring guide and mirrored skill, a customer-authored
   conformance package, and the `packages/delivery` domain. Awaiting the
   adversarial review in `docs/QUALITY_GATES.md` §5 and a human merge.
2. Then M14 Delivery Economics & Acceptance, M15 Service Operations, then the
   **package contract review** and the first legacy extraction (one of
   Intelligence / Commercial / Signature), then M16 Analytics Studio —
   `EXECUTION_ROADMAP.md`.

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
Operations; Signature and Order; Contract activation and subscriptions; the
public domain-package contract and delivery handover (open PR); MCP server; CLI.

**Documentation only (no code):** renewal, billing and everything downstream of
activation; Delivery;
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
