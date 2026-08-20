# Repository boundary, inventory and migration plan

**Status: design only. This phase moves nothing.** No private repository was
created, no file was moved or deleted, the site did not move, the licence did not
change, and no git history was rewritten. Everything below is a plan a human
executes later, in the order given.

## 1. Topology

Two repositories initially.

| Repository | Visibility | Contains |
|---|---|---|
| `accordo` | **public** | The framework, its interfaces, its docs, its evidence — the open-source edition |
| `accordo-platform` | **private** | The managed Cloud, the marketing site implementation, and internal GTM |

Sketch of the private layout:

```text
accordo-platform/
  apps/cloud-control-plane/     organizations, projects, environments
  apps/cloud-dashboard/         the operator UI
  apps/marketing-site/          the site implementation and its deployment
  packages/cloud-cli/           the authenticated Cloud CLI
  packages/cloud-mcp/           the authenticated Cloud MCP server
  packages/deployment-engine/   deploys, previews, domains, rollback
  packages/observability-backend/  log/metric/trace storage, search, alerts
  packages/cloud-billing/       metering, subscriptions, invoicing
  docs/internal/                operations, runbooks, architecture
  docs/gtm/                     pricing, competitive, launch, sales enablement
```

### Why two and not three

A third repository (separating GTM from Cloud) buys isolation that nothing needs
yet and costs a boundary every document has to be routed across. **Do not create
it initially.** Revisit when *any* of these becomes true:

- someone needs Cloud source access without GTM access, or the reverse — the
  first non-founder contributor usually forces this;
- GTM material acquires an external audience (an agency, a fractional CMO) that
  should not receive proprietary source;
- the Cloud repository grows its own release train and GTM churn starts
  dominating its history;
- a compliance or customer commitment requires demonstrating access separation.

Until then, one private repository with two top-level document trees and
directory-scoped access is sufficient and cheaper.

## 2. Inventory of the current public tree

Classified from the real tree at `947eb64`, not from memory. **92 paths
classified** (a trailing `/` denotes a directory counted as one path).

| Classification | Count |
|---|---:|
| `KEEP_PUBLIC` | 42 |
| `MOVE_PRIVATE` | 35 |
| `PUBLIC_REDACTED_REPLACEMENT` | 5 |
| `SPLIT_PUBLIC_PRIVATE` | 5 |
| `HISTORICAL_ALREADY_PUBLIC` | 5 |
| **Total** | **92** |

### `KEEP_PUBLIC` (42)

`README.md` · `PRODUCT.md` · `ARCHITECTURE.md` · `AGENTS.md` · `CLAUDE.md` ·
`GEMINI.md` · `CONTRIBUTING.md` · `SECURITY.md` · `DECISIONS.md` · `LICENSE` ·
`TASKS.md` · `docs/PROJECT_STATUS.md` · `skills/` · `api/mcp.js` ·
`site/claims.json` · `site/assets/llms.txt` · `site/assets/llms-full.txt` ·
`docs/benchmarks/jobs.json` · `docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md` ·
`docs/benchmarks/CRM_JTBD_MATRIX.md` · `docs/benchmarks/PILOT_PROTOCOL.md` ·
`docs/marketing/BENCHMARK_PUBLICATION.md` · and the product-design documents in
`docs/strategy/` that describe *what the framework does* rather than how it is
sold: `PLATFORM_CAPABILITIES` · `CODING_AGENT_DX_NORTH_STAR` · `DATA_GOVERNANCE` ·
`JOBS_AND_OUTBOX` · `INTEGRATION_RUNTIME` · `CONTRACT_SUBSCRIPTION_RENEWAL` ·
`REVENUE_OPERATIONS` · `DELIVERY_SERVICE` · `ANALYTICS_STUDIO` ·
`CAMPAIGNS_JOURNEYS` · `EXPERIMENTATION_ATTRIBUTION` ·
`MARKETING_GROWTH_OPERATIONS` · `DESIGN_TO_CRM` · `PLATFORM_ALIGNMENT_GATE` ·
`NORTH_STAR_EXPERIENCE` · `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE` ·
`OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE` · `RECOMMENDATION_MAP` · `CRM_BUILD_BENCHMARK` ·
`EXTERNAL_REVIEW`.

Three of these deserve their reason stated, because a commercial instinct would
move them:

- **`EXTERNAL_REVIEW.md`** is an outside assessment of the project's fitness,
  including where it falls short. It stays.
- **`CRM_BUILD_BENCHMARK.md`** and the benchmark protocols define a benchmark
  others can run *against us*. They stay.
- The `MARKETING_GROWTH_OPERATIONS` / `CAMPAIGNS_JOURNEYS` /
  `EXPERIMENTATION_ATTRIBUTION` documents are **product** designs for CRM domains
  a user would build, not our own marketing plans. The name collision is
  unfortunate; the content is public product design.

### `PUBLIC_REDACTED_REPLACEMENT` (5)

Each moves private **only after** its public replacement exists (§4).

| Path | Public replacement |
|---|---|
| `docs/strategy/MASTER_PLAN.md` | Public Now / Next / Later roadmap |
| `docs/strategy/GO_TO_MARKET.md` | Public adoption and contribution guide |
| `docs/strategy/CATEGORY.md` | Positioning paragraph in `PRODUCT.md` |
| `docs/strategy/AGENT_CRM_CLOUD.md` | `MANAGED_CLOUD_EDITION.md` + `CLOUD_INTEGRATION_CONTRACT.md` |
| `docs/strategy/CLOUD_JTBD.md` | The same two documents |

### `MOVE_PRIVATE` (35)

**GTM strategy and research (10):** `GO_TO_MARKET` is listed above;
`COMPETITOR_MAP` · `MEDUSA_PLAYBOOK` · `AGENT_DISCOVERY` ·
`AGENT_RECOMMENDATION` · `ORGANIC_GROWTH` · `DISTRIBUTION_SUBMISSIONS` ·
`BRAND_REQUIREMENTS` under `docs/strategy/`.

**Launch, content and sales enablement (12):** `docs/marketing/LAUNCH_PACKET` ·
`FOUNDER_CHECKLIST` · `CONTENT_PILLARS` · `CONTENT_PRODUCTION` ·
`GITHUB_LISTING` · `AWESOME_LIST_SUBMISSIONS` · `PENDING_HUMAN_SUBMISSION` ·
`DESIGN_BRIEF` · `NAME_VERIFICATION` · `OBJECTIONS` · `SITE_ARCHITECTURE` ·
`DEPLOYMENT` · `drafts/`.

**Marketing-site implementation (13):** `site/templates/` · `site/partials/` ·
`site/blog/` · `site/shell.html` · `site/brand.json` · `site/compare.json` ·
`site/answers.json` · `site/concepts.json` · `site/glossary.json` ·
`site/tools.json` · `site/capabilities.json` · `site/assets/styles.css` ·
`site/assets/mark.svg` · `site/assets/social-preview.{svg,png}`.

### `SPLIT_PUBLIC_PRIVATE` (5)

| Path | Public half | Private half |
|---|---|---|
| `ROADMAP.md` | The three-track roadmap (§6) | Sequencing tied to commercial timing |
| `vercel.json` | The docs-MCP function config the public repo still needs | Marketing-site build and deploy configuration |
| `docs/strategy/EXECUTION_ROADMAP.md` | Public engineering phases | GTM-coupled sequencing |
| `docs/strategy/CUSTOMER_REVENUE_OS_ROADMAP.md` | Capability gap analysis | The competitor-informed audit |
| `docs/strategy/GTM_TECHNICAL_EVIDENCE_HANDOFF.md` | The evidence index (already public evidence) | The handoff framing and its GTM use |

### `HISTORICAL_ALREADY_PUBLIC` (5)

`docs/marketing/CORRECTIONS.md` · `docs/benchmarks/URR_PILOT_2026-08-10.md` ·
`docs/benchmarks/TOOL_SELECTION_PILOT_2026-08-13.md` · `docs/transcripts/` ·
`benchmarks/`.

Published records of what was measured, what was withdrawn and what was retracted
— including results that are unflattering. They stay public, they are never
rewritten, and **no migration step may describe them as removed.**

## 3. The rule that decided the hard cases

> Move a document private because it is **commercial** — pricing, positioning,
> competitive research, launch mechanics, sales enablement.
> Never move a document private because it is **unflattering**.

`CORRECTIONS.md`, the pilot results, `EXTERNAL_REVIEW.md` and every
`NOT_ENFORCED` limitation are the second case. They are the reason anything else
this repository asserts is worth reading.

## 4. Public replacements, written before anything moves

No public file may link to a private path a reader cannot open. Each replacement
below is authored in the migration task, **before** step 6 removes its source:

1. **Public Now / Next / Later roadmap** — replaces `MASTER_PLAN.md` as the
   public entry point. Capability-level, no commercial timing, no financials.
2. **Adoption and contribution guide** — replaces `GO_TO_MARKET.md`: how to
   adopt, extend, contribute, and get a change reviewed.
3. **Positioning paragraph in `PRODUCT.md`** — replaces `CATEGORY.md`: what this
   is and what it is not, without competitive framing.
4. **`MANAGED_CLOUD_EDITION.md` + `CLOUD_INTEGRATION_CONTRACT.md`** — already
   written in this PR; they replace the Cloud design documents publicly.

**Inbound links that must be rewritten in the same step**, measured against the
tree rather than guessed. Exactly **three** private-designated documents are
currently linked from public files:

| Private-designated document | Linked from |
|---|---|
| `MASTER_PLAN.md` | `README.md`, `ROADMAP.md`, `PRODUCT.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/PROJECT_STATUS.md` — **6 files** |
| `GO_TO_MARKET.md` | `README.md` |
| `CATEGORY.md` | `PRODUCT.md` |

Every other public link into `docs/strategy/` — `CRM_BUILD_BENCHMARK`,
`RECOMMENDATION_MAP`, `DATA_GOVERNANCE`, `CODING_AGENT_DX_NORTH_STAR`,
`EXECUTION_ROADMAP` — points at a document that stays public, and needs no
rewrite. `AGENT_CRM_CLOUD.md` and `CLOUD_JTBD.md` are not linked from any public
entry-point file, so their replacement carries no link debt.

## 5. Migration manifest — the order a human executes

1. **Human creates `accordo-platform`** (private). No agent creates a repository.
2. **Copy** every `MOVE_PRIVATE` path and the private half of every `SPLIT` path
   into it, preserving history where practical (`git filter-repo` per subtree, or
   a plain copy with a provenance note when history is not worth the cost).
3. **Verify the private destination**: every copied file present, readable, and
   building where it builds. Nothing is removed from public until this passes.
4. **Add the public replacement documents** from §4 to the public repository.
5. **Update links and generators**: the inbound links measured in §4, plus
   `site:check`, the llms assets and the docs-MCP corpus.
6. **Remove the private-designated sources from public HEAD** — a normal commit,
   not a history rewrite.
7. **Add `public-surface-check`** to CI (specified in
   [`PUBLIC_ARTIFACT_POLICY.md`](PUBLIC_ARTIFACT_POLICY.md)).
8. **Verify** the site builds, the docs resolve, agent retrieval still answers,
   and `npm run verify` passes from a clean public clone.
9. **Never claim old public history was erased.** Everything published stays in
   the public history and may be read there. Public git history is **not**
   rewritten to hide non-secret strategy. Secrets, if ever found, follow the
   separate rotation-and-removal procedure in `SECURITY.md` — that procedure is
   about credentials, never about embarrassment.

## 6. The roadmap, in three tracks

### Public OSS
- **Spine v1** — identity, authorization, one-tenant-per-instance *(in review)*
- **Spine v2** — PostgreSQL per-tenant storage, and closing the CRM data-plane
  isolation gap v1 publishes as unenforced
- **Spine v3** — durable jobs, outbox, scheduler
- **Spine v4** — secret, backup, observability and self-host interfaces
- **Customer Data Operations** — search, saved views, bulk actions, physical
  merge, retention and erasure
- **The Billing domain**
- **Interactions, Marketing and Analytics packages**

### Private Cloud
- **C0** control plane — identity, organization, project, environment
- **C1** Git deploy, preview environments, domains
- **C2** managed database, secret custody, backup
- **C3** logs, metrics, traces, alerts
- **C4** the authenticated agent Cloud CLI and MCP
- **C5** usage metering, subscription, billing, support
- **C6** autoscaling, SLA, enterprise operations

### Private GTM
Website · pricing · packaging · launch · distribution · content · sales
enablement.

### Parallelism, stated explicitly

**Public Spine v2 and private Cloud C0 may proceed in parallel** once this
boundary is approved, on one condition: the Cloud consumes only public contracts.
C0 needs project and environment identity and the health contract — both public
and versioned (`CLOUD_INTEGRATION_CONTRACT.md`) — and needs nothing from Spine
v2's storage work. The moment C0 requires a change to framework internals, the
parallelism is broken and the change belongs on the public track first.

> **This roadmap lives here, not in `ROADMAP.md`, for one deliberate reason:**
> `ROADMAP.md` is concurrently being edited on the Production Spine v1 branch.
> Folding the three tracks into it now would create a merge conflict in a file
> another agent owns. Migration step 5 folds it in, once Spine v1 has landed.
