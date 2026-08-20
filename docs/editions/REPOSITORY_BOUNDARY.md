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

Classified from the real tree, not from memory. Re-validated against `aa1359f`
after Production Spine v1 merged. **97 paths classified** (a trailing `/` denotes
a directory counted as one path).

| Classification | Count |
|---|---:|
| `KEEP_PUBLIC` | 47 |
| `MOVE_PRIVATE` | 35 |
| `PUBLIC_REDACTED_REPLACEMENT` | 5 |
| `SPLIT_PUBLIC_PRIVATE` | 5 |
| `HISTORICAL_ALREADY_PUBLIC` | 5 |
| **Total** | **97** |

The first pass enumerated the paths where the public/private call is *arguable* —
marketing, strategy, the site, the Cloud designs — and silently omitted the ones
where it is not. That is the same shape as the defect this whole boundary exists
to avoid: an inventory that **reads** complete because nothing in it is wrong.
The five entries below close it by naming the remainder as whole-directory or
whole-class rules, so the migration manifest and any future
`public-surface-check` allowlist have an instruction for **every** path rather
than for the interesting ones.

**Re-validation against `aa1359f`.** Four non-code paths appeared since the first
pass — `docs/plans/benchmark-judgement-gates.md`,
`docs/plans/production-spine-v1.md`,
`docs/transcripts/2026-08-19-tour-and-falsify.txt` and
`site/blog/build-a-custom-crm-with-claude-code-day-30.md`. All four fall under
directory-level entries, so none changes a classification. No path classified in
the first pass was deleted or renamed.

### `KEEP_PUBLIC` (42)

`README.md` · `PRODUCT.md` · `ARCHITECTURE.md` · `AGENTS.md` · `CLAUDE.md` ·
`GEMINI.md` · `CONTRIBUTING.md` · `SECURITY.md` · `DECISIONS.md` · `LICENSE` ·
`TASKS.md` · `docs/PROJECT_STATUS.md` · `skills/` · `api/mcp.js` ·
`site/claims.json` · `site/assets/llms.txt` · `site/assets/llms-full.txt` ·
`docs/benchmarks/jobs.json` · the rail-selection benchmark's frozen protocol
document under `docs/benchmarks/` (named in the benchmark's own source rather
than here — see the note below) ·
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

**The counting convention**, because these subtotals were wrong once: a
directory with a trailing `/` counts as one path; a brace expansion counts as
the files it names, so `social-preview.{svg,png}` is two; and a path
cross-referenced from another classification is counted there, not twice.

**GTM strategy and research (7):** `GO_TO_MARKET` is listed above under
`PUBLIC_REDACTED_REPLACEMENT` and counted there, not here;
`COMPETITOR_MAP` · `MEDUSA_PLAYBOOK` · `AGENT_DISCOVERY` ·
`AGENT_RECOMMENDATION` · `ORGANIC_GROWTH` · `DISTRIBUTION_SUBMISSIONS` ·
`BRAND_REQUIREMENTS` under `docs/strategy/`.

**Launch, content and sales enablement (13):** `docs/marketing/LAUNCH_PACKET` ·
`FOUNDER_CHECKLIST` · `CONTENT_PILLARS` · `CONTENT_PRODUCTION` ·
`GITHUB_LISTING` · `AWESOME_LIST_SUBMISSIONS` · `PENDING_HUMAN_SUBMISSION` ·
`DESIGN_BRIEF` · `NAME_VERIFICATION` · `OBJECTIONS` · `SITE_ARCHITECTURE` ·
`DEPLOYMENT` · `drafts/`.

**Marketing-site implementation (15):** `site/templates/` · `site/partials/` ·
`site/blog/` · `site/shell.html` · `site/brand.json` · `site/compare.json` ·
`site/answers.json` · `site/concepts.json` · `site/glossary.json` ·
`site/tools.json` · `site/capabilities.json` · `site/assets/styles.css` ·
`site/assets/mark.svg` · `site/assets/social-preview.{svg,png}`.

### `KEEP_PUBLIC`, by whole-class rule (5 entries)

These were omitted from the first enumeration. They are public, and none of them
is a close call:

- **`docs/*.md` — framework product documentation (32 files).** `ACTIONS` ·
  `ADMIN` · `API` · `MODULE_FACTORY` · `MODULE_MANIFEST` · `PACKAGE_AUTHORING` ·
  `QUALITY_GATES` · `SCENARIO_EVIDENCE` · `SOLUTION_PLAN` · the six domain guides
  and the rest. Someone who clones only the public repository must be able to run
  and extend the product; these are how. `PROJECT_STATUS.md` is listed separately
  above.
- **`docs/plans/` — 55 dated ExecPlans.** Historical engineering records,
  including the ones whose milestone was cut or reworked. They preserve what was
  true when written and are never rewritten.
- **`docs/jtbd/`** — the JTBD index README supporting the public matrix.
- **`docs/editions/`** — these five documents. The boundary between the editions
  is itself public; a private boundary document would be an odd thing to ask
  contributors to respect.
- **Root and site config the public repository needs to run:** `.mcp.json` ·
  `gemini-extension.json` · `package-lock.json` · `site/.gitignore` ·
  `site/.used-claims.json`. The last two follow the site split rather than
  travelling on their own.

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
the rail-selection panel record dated `2026-08-13` under `docs/benchmarks/` ·
`docs/transcripts/` · `benchmarks/`.

Published records of what was measured, what was withdrawn and what was retracted
— including results that are unflattering. They stay public, they are never
rewritten, and **no migration step may describe them as removed.**

**Why two of these are described rather than named.** The rail-selection
benchmark measures whether an agent picks the right rail for a question, and it
enforces that its fixtures — copies of this repository — contain none of its own
answer sheet. Two of its document *filenames* are themselves scored markers, so
writing them here would leak the answer into every fixture and invalidate the
runs; the isolation gate catches it, and caught it on this branch. They are
identified by role and date instead. This is the one place in the boundary
documents where a path is deliberately not spelled out, and the reason is a
merged gate rather than a preference.

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

**Inbound links that must be rewritten in the same step**, re-measured against
`aa1359f`. **The counting rule, because it decided the number:** a reference is
any occurrence of the private document's filename in a file that stays public —
a Markdown link, a bare backticked path, or a prose citation alike. A reader
told "the specification is in `X.md`" is left just as stranded as one who clicks
a dead link, so the narrower "only Markdown links count" rule would have
under-reported this table twice.

**Five** private-designated documents are referenced from files that stay
public, across **16 distinct files** — not the three documents and 8 files the
first pass counted, and not the 12 the second pass counted:

| Private-designated document | Referenced from files that stay public |
|---|---|
| `MASTER_PLAN.md` | `README.md` · `ROADMAP.md` · `PRODUCT.md` · `AGENTS.md` · `CONTRIBUTING.md` · `DECISIONS.md` · `docs/PROJECT_STATUS.md` · `packages/docs-mcp/README.md` · `docs/plans/first-gtm-article.md` · `docs/plans/mcp-registry-remote-entry.md` — **10 files** |
| `GO_TO_MARKET.md` | `README.md` · `site/claims.json` · `docs/marketing/CORRECTIONS.md` · `docs/plans/gtm-smart-crm-intent.md` · `docs/plans/gtm-customer-hub-intent.md` — **5 files** |
| `CATEGORY.md` | `PRODUCT.md` · `DECISIONS.md` · `site/claims.json` · `docs/plans/first-gtm-article.md` — **4 files** |
| `CLOUD_JTBD.md` | `docs/benchmarks/CRM_JTBD_MATRIX.md` — **1 file** |
| `AGENT_CRM_CLOUD.md` | `docs/RENAME_SURFACE.md` — **1 file** |

The last two rows correct a claim the previous pass made in this section: that
the Cloud design documents carry no link debt. They do. `CRM_JTBD_MATRIX.md` is
`KEEP_PUBLIC` and tells its reader that the fifteen Cloud operator jobs are
"specified in `CLOUD_JTBD.md`" — so the public matrix would point at a document
the reader cannot open, which is precisely the failure §4 exists to prevent. Its
replacement is the public `MANAGED_CLOUD_EDITION.md` scope section, and the
matrix row must be repointed in migration step 5. `RENAME_SURFACE.md` is the
weaker case and still a real one: it is a dated rename record that discusses
`AGENT_CRM_CLOUD.md` *as a filename*, so it takes the historical-record rule
below rather than a repoint.

Three of those sources need a rule rather than an edit, because rewriting them
would falsify a record:

- **`DECISIONS.md`** — an accepted ADR citing the document that motivated it.
  The citation is historical and stays; migration step 5 appends a note that the
  target moved private, rather than editing the ADR body.
- **`docs/marketing/CORRECTIONS.md` and `docs/plans/*`** — dated records that
  preserve what was true when written. Same rule: the link is annotated as
  pointing at a now-private document, never silently repointed.
- **`site/claims.json`** — a claim's `docs` evidence array. The evidence must
  move to the public replacement, because a claims ledger that cites an
  unopenable path is exactly the failure the ledger exists to prevent.

Links from files that are themselves `MOVE_PRIVATE` (`docs/marketing/LAUNCH_PACKET.md`,
`PENDING_HUMAN_SUBMISSION.md`, `CONTENT_PILLARS.md`, `site/concepts.json`,
`site/glossary.json`) travel with their source and need no public replacement.

Every other public link into `docs/strategy/` — `CRM_BUILD_BENCHMARK`,
`RECOMMENDATION_MAP`, `DATA_GOVERNANCE`, `CODING_AGENT_DX_NORTH_STAR`,
`EXECUTION_ROADMAP` — points at a document that stays public, and needs no
rewrite.

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
- **Spine v1** — identity, authorization, one-tenant-per-instance *(merged,
  ADR-038)*
- **Spine v2** — PostgreSQL per-tenant storage, and shared-database row-level
  tenancy, which v1 deliberately did not attempt
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

> **This roadmap lives here, not in `ROADMAP.md`.** The original reason was that
> `ROADMAP.md` was being edited concurrently on the Production Spine v1 branch, so
> folding the three tracks in would have conflicted with a file another agent
> owned. **That reason expired when Spine v1 merged in PR #98**, and `ROADMAP.md`
> is nobody's open branch now. What remains is the ordinary one: `ROADMAP.md` is a
> `SPLIT_PUBLIC_PRIVATE` path whose commercial-sequencing half moves private, so
> folding the tracks in *before* that split would write private sequencing into a
> public file and then have to unpick it. Migration step 5 still folds it in,
> after the split. This note names the constraint that expired rather than
> quietly dropping it, so the next reader can tell a live reason from a spent one.
