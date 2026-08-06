# Platform alignment gate

A short architecture and roadmap checkpoint taken **after Milestone 11 merged
and before Delivery, Service and further domain code is written**. It adds no
runtime feature, moves no runtime file and changes no product decision. Its
only job is to make the next years of domain work land on a platform instead of
inside one growing core.

## Why it exists

Eleven milestones proved a large vertical. The risk now is not that the vertical
is wrong — it is that the *next* vertical is built the same way as the last one:

- domain-specific behavior accumulating in `packages/core` until the core is a
  monolith that every project must take whole;
- the same capability implemented three times (handwritten core module,
  generated module, future plugin) with three different guarantees;
- Delivery being built directly on top of an immutable Order, with the missing
  Contract / Subscription / Renewal layer improvised inside it;
- each new provider re-inventing retries, reconciliation, scheduling and
  durable delivery, because no shared integration runtime exists;
- Data Governance and Design-to-CRM quietly dropping out of the vision because
  no milestone owns them;
- roadmap and status documents drifting until nobody trusts them;
- the adversarial-review discipline living only inside very long one-off
  prompts, so its rigor depends on whoever writes the next prompt.

## What is already proven (merged, on `main`)

The end-to-end path below runs in the repository today, with tests, a starter
and a browser smoke:

```text
Lead capture
→ enrichment snapshot · explainable versioned scoring · deterministic routing + assignment   (M9, ADR-015)
→ qualification / disqualification                                                            (M6, ADR-011/012)
→ conversion into Company + Contact + Opportunity                                             (M7, ADR-013)
→ configurable Opportunity pipeline with a server-authoritative move-stage action             (M8, ADR-014)
→ catalog sync into immutable products, offers, price components and tiers                    (M10, ADR-016)
→ composite quote: one-time + recurring, flat / per-unit / volume / graduated, grouped totals  (M10)
→ immutable Quote Version + versioned discount policy + human approval                        (M10)
→ signature envelope, verified provider events, signed-artifact evidence                       (M11, ADR-017)
→ exactly one immutable Order with lines, components, tier schedules and grouped totals        (M11)
```

Underneath it: a declarative module manifest and generated migrations (M1), a
module factory (M2), one generated resource contract over API/SDK (M3), a
generated Admin (M4), generated-to-generated references (M5), a code-first
action runtime with atomic execution, post-commit events and trace (M6), and a
bounded external-operation runtime for remote side effects (M11).

**Nothing beyond that list is implemented.** Anything this gate describes as a
track, a primitive or a milestone is design only until a merged PR says
otherwise, and `docs/PROJECT_STATUS.md` is the file that says so.

## What is not production-ready

| Area | Today |
|---|---|
| Storage | SQLite (`node:sqlite`) only; no PostgreSQL adapter |
| Runtime scope | local development only — the HTTP server is not safe to expose |
| Authentication | none; `x-actor-type` / `x-actor-id` headers are **not** authentication |
| Tenancy | none; no tenant column, boundary or isolation test |
| Authorization | none; approval keys are labels, not RBAC |
| Durable delivery | none; the event buffer is in-process (AsyncLocalStorage) and dies with the process |
| Scheduling | none; no timers, no recurring jobs, no background workers |
| Secrets | none; the only provider key in the repository is a declared test-only fixture value |
| Browser tests | run manually against a real Chromium; **not in CI** |
| External providers | none; every provider that ships is a deterministic offline fixture |
| Cloud | design only (`AGENT_CRM_CLOUD.md`); no control plane, no deployment code |

**Public multi-user use is gated by the Production Spine** — authentication, tenancy, RBAC, PostgreSQL, secrets and backups (`EXECUTION_ROADMAP.md` Phase 6). Until it lands, the HTTP server is a local-development surface, actor headers are a declared identity rather than an authenticated one, and no document, milestone or JTBD row may claim a real external, role-scoped or multi-tenant user.

## What this gate must leave behind

1. **Core-versus-domain boundaries** — ADR-018 in `DECISIONS.md`.
2. **A bounded capability model** shared by handwritten, generated, domain and
   plugin modules — `PLATFORM_CAPABILITIES.md`.
3. **A corrected post-Order roadmap** with Contract/Subscription inserted
   before Delivery — `EXECUTION_ROADMAP.md`, `CONTRACT_SUBSCRIPTION_RENEWAL.md`.
4. **An explicit integration-runtime track** — `INTEGRATION_RUNTIME.md` and
   `JOBS_AND_OUTBOX.md`.
5. **An explicit data-governance track** — `DATA_GOVERNANCE.md`.
6. **Design-to-CRM restored as a first-class track** — `DESIGN_TO_CRM.md`.
7. **Cloud operator jobs** written as JTBDs — `CLOUD_JTBD.md`.
8. **Permanent quality gates** and a reusable review skill —
   `docs/QUALITY_GATES.md`, `.claude/skills/adversarial-review/`.
9. **One current project-status source** — `docs/PROJECT_STATUS.md`.

## What this gate deliberately does not do

- It does not move `packages/core/src/{intelligence,commercial,signature}-*.js`
  anywhere. Extraction is staged and behavior-preserving, and it happens in
  later PRs (ADR-018).
- It does not implement Delivery, Subscription, Service, Analytics, auth,
  tenancy, PostgreSQL, jobs, outbox or Cloud.
- It does not choose a public name, a license, a pricing model or a telemetry
  policy. Those remain human decisions (`MASTER_PLAN.md` §10).
- It does not change a single line of runtime JavaScript, a migration or any
  package metadata.
