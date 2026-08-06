# Analytics Studio

**Status: product strategy and roadmap only. Nothing in this document is implemented.** No semantic model, metric definition, dataset, report, dashboard, widget, saved view or query compiler exists in the repository today (the Admin dashboard shows raw counts only; JTBD-13 is *partially supported* on that basis and nothing more). This document defines the analytics workstream so the roadmap can sequence it (`EXECUTION_ROADMAP.md`, milestone M15).

**Goal:** Claude Code and Codex can create trustworthy reports and dashboards from business language — "show win rate by month and average discount by segment" — **without ever generating arbitrary unsafe SQL**. The agent composes approved semantic definitions; the framework compiles them safely; the customer owns the resulting definitions as code.

---

## 1. Primitives

- **MetricDefinition** — a named, deterministic, explainable calculation ("win rate = won opportunities ÷ closed opportunities, by close date") referencing modules/fields through the semantic layer, never raw tables;
- **DimensionDefinition** — the axes metrics break down by (stage, owner, territory, segment, month);
- **Dataset** — a declared, bounded slice of CRM data a semantic model reads;
- **SemanticModel** — the map from business names to physical storage: which module fields mean "amount", "closed", "stage entered" — the single place physical schema knowledge lives;
- **Report** — a query composition: metrics × dimensions × filters, with a deterministic result contract;
- **Dashboard / Widget** — arranged, parameterized report views;
- **SavedView** — a persisted filter/sort/column configuration on list surfaces;
- **ReportVersion / DashboardVersion** — immutable published versions with rollback (rollback publishes a new version from an earlier definition — the same rule as every policy in this repository; Git history alone is not runtime versioning).

All definitions are **code-first, deterministic and validated fail-closed at startup** (the ADR-014 registry pattern): reviewable source the customer owns, published as runtime versions.

## 2. Safe query compilation

The safety core of the workstream:

1. Reports reference **approved MetricDefinitions and DimensionDefinitions only**. There is no public surface where an agent submits free-form SQL.
2. The framework **compiles** a report into parameterized queries against the declared Dataset — bounded columns, bounded joins, bounded row limits, no string interpolation of user or agent input.
3. **Permissions apply at the service/query boundary**, not in the UI: tenant filters and role visibility are injected by the compiler for every query once the Production Spine exists. A role-aware dashboard is the *same* dashboard definition with rows the viewer may not see already absent from every result.
4. Every metric result is **explainable**: the compiled query, the definition version and the input parameters are inspectable, so "why does this number say 42?" always has a mechanical answer.
5. Agent diagnosis of a broken metric happens through this same surface — read definitions, run bounded compiled queries, compare fixtures — never through raw database access.

**Honest limits:** role-aware results cannot be validated before authentication, tenancy and RBAC exist (Production Spine, Phase 6); until then compilation safety and metric correctness are testable, permission enforcement is design only. Analytics reads production-shaped data; at local-development scale SQLite is fine, and large-scale analytical performance is explicitly not a claim of v1.

## 3. Versioning, rollback and correctness

- Publishing a Report/Dashboard version is an explicit act; runs and rendered dashboards record the version that produced them.
- Rollback = publish a new version from an earlier definition; history is never rewritten.
- **Metric correctness tests are first-class deliverables:** every shipped MetricDefinition comes with a fixture dataset and a known-correct expected result, run in `npm run verify` — the same runs-or-dies discipline as every other framework claim. A metric without a correctness test does not ship.

## 4. Agent-generated dashboards

Agents build analytics the way they build modules: from a business brief to checked-in definitions through Agent Skills (`build-revenue-dashboard`, `build-delivery-margin-dashboard` — `EXECUTION_ROADMAP.md`, skills roster). The dashboard an agent generates is configuration/code in the customer's repository — reviewable, versioned, portable — not an opaque hosted artifact. What prevents unsafe agent SQL is structural, not behavioral: the public analytics surface **cannot execute** anything but compiled semantic queries.

## 5. Example metrics across the workstreams

| Domain | Example metrics |
|---|---|
| Lead intelligence | lead volume by source; score distribution; enrichment coverage |
| Routing | time to assignment; routing acceptance rate; override rate by manager |
| Sales pipeline | Lead→Opportunity conversion; pipeline value by stage (per currency); win rate; stage-duration |
| Discounts & signatures | average discount by segment; approval turnaround; Quote→Signed conversion |
| Delivery | milestone progress vs plan; delivery margin forecast vs actual; partner cost share |
| SLA | SLA attainment; time-to-first-response; escalation rate |
| Renewal & upsell | renewal rate; upsell pipeline from service signals; contracts at risk |

Each becomes a tested MetricDefinition when its underlying primitives exist — pipeline metrics first (M8 data exists today), the rest as M9–M14 land. Money metrics are per-currency by contract; currencies are never summed together (ADR-014).

## 6. Dependencies, sequencing, approvals

- **Depends on data existing:** Analytics Studio v1 (M15) closes the workstream sequence because its value grows with each preceding milestone — but the semantic layer and pipeline metrics need nothing beyond M8 and could be built earlier if a brief demands it; M15's position is pragmatic, not a hard dependency chain.
- **Production Spine** gates role-aware dashboards and any remote/customer-facing analytics.
- **Human approvals:** publishing dashboards to real business users once the Spine exists; any export/embedding that exposes data externally.
- **Agents execute:** semantic models, metric definitions with correctness tests, reports, dashboards, skills, starter evidence.

JTBD tracking: `docs/benchmarks/CRM_JTBD_MATRIX.md` (Analytics section — everything starts **not supported**). Benchmark integration: analytics gates appear inside the Revenue Operations and Delivery & Service E2E scenarios in `CRM_BUILD_BENCHMARK.md` (planned, not implemented).

## Marketing MK7 is hard-blocked on this document

Funnel definitions, drop insights, campaign results and every attribution model compile from **semantic metrics and dimensions** through the safe query compiler defined here. **No arbitrary agent-generated production SQL** — an agent composes declared metrics; the studio compiles them. That boundary is not a preference for the Marketing track, it is the condition of it existing at all.

MK7 additionally needs an identity and touchpoint model that does not exist today; multi-touch attribution without one is arithmetic on guesses. See `EXPERIMENTATION_ATTRIBUTION.md` §4.
