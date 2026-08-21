# Private repository migration — the executable manifest

The boundary is decided in [`REPOSITORY_BOUNDARY.md`](REPOSITORY_BOUNDARY.md).
This document is the **runbook**: what moves, where it lands, what has to exist
first, how each step is verified, and how each step is undone.

**Nothing here has been executed.** No private repository exists, no file has
been moved or deleted, no history has been rewritten. Every command below is
written to be read by a human, checked, and then run by that human.

Measured against `f30d0f7`. Every path in §3 was confirmed to exist in the tree
at that commit — **45 of 45 present, 0 missing**. A manifest that names a path
which is not there is worse than no manifest, because it is executed by someone
who assumes it was checked.

---

## 1. The site/public gate split — **ruled**

This section previously asked a blocking question. **A human has now answered
it**, and the answer is option C below. The reasoning is kept because the
alternatives are what make the ruling legible, but this is a decision, not an
open item.

### The governing constraint

> **The OSS repository must never depend on a private file to pass CI.**

Everything else in this section follows from that one sentence. It is also the
test that retires the contradiction the manifest originally found.

### The contradiction, as measured

**7 public scripts read paths classified `MOVE_PRIVATE`** —
`scripts/site-build.js` · `scripts/site-check.js` · `scripts/site-pages.js` ·
`scripts/site-clusters.js` · `scripts/generate-llms.js` ·
`scripts/distribution-check.js` · `scripts/brand-set.js` — and `scripts/` is
classified nowhere in the inventory. The boundary document classified content and
forgot the machinery that reads it.

```
npm run gtm:check          ← a PUBLIC gate
  └── npm run site:check
        └── npm run site:build   ← reads site/templates, site/partials,
                                    site/shell.html and six site/*.json files,
                                    all classified MOVE_PRIVATE
```

### The ruling

**Public OSS keeps — and remains responsible for verifying:** technical
documentation · self-host documentation · public API, package and agent
documentation · `site/claims.json` · `jobs.json` · `llms.txt` /
`llms-full.txt` · public evidence and limitations · the public high-level
roadmap · technical and retrieval pages. The public gate keeps: technical docs,
public current facts, retrieval assets, links, claims and evidence.

**Private `accordo-platform` owns:** the commercial marketing-site source, build
and deploy · pricing and packaging · GTM strategy · competitor research · launch
and sales material · private Cloud source. It carries **its own** marketing-site
build and deploy checks.

### The three options, and why C

| | What moves | What breaks | Verdict |
|---|---|---|---|
| **A. Inputs stay public** | only presentation | nothing public | The private site cannot render without reaching back into the public repo |
| **B. Everything site moves** | all `site/**` plus all 7 scripts | public `gtm:check`, `site:check`, `llms.txt` regeneration | **Violates the governing constraint** |
| **C. Split by purpose** | presentation and marketing content move; **claims, evidence and llms generation stay** | one script splits in two | **Ruled** |

`site-check.js` already does two separable jobs. Rules 1–3 and 6 — every claim
carries evidence that exists, every claim carries a limitation, every public
number traces to a measurement this checkout descends from — are *technical
evidence integrity*, and they are the reason the claims ledger is trustworthy.
Rules 4–5 — no template hardcodes a brand, no built page overclaims — are
*marketing-site* checks. The first set belongs to whoever owns the framework's
honesty; the second belongs to whoever owns the site.

Under C the public repository keeps `site/claims.json`, `site/jobs.json`,
`site/assets/llms.txt`, `site/assets/llms-full.txt`, `generate-llms.js`, and a
narrowed `claims-check` carrying rules 1–3 and 6. The private repository takes
the renderer, the templates, the brand and marketing JSON, the blog and the
deploy configuration, plus rules 4–5 as its own gate.

**This requires a code change (splitting `site-check.js`) that is out of scope
for a documentation phase.** It is migration step 0 and it lands in the public
repository *before* anything moves.

### Until `accordo-platform` exists

Do not delete or move the current site. Do not break any current public check.
The split is prepared here and executed later — that is the whole purpose of
this document.

---

## 2. Human prerequisites — none of this is an agent's to do

1. **Create `accordo-platform`** as a **private** repository. No agent creates a
   repository, and no agent is given the ability to.
2. **Grant access** to the humans and agents that need it. An agent working in
   the private repository needs its own scoped credential; the public agent
   credential must not gain private access as a side effect.
3. **Configure branch protection** on `accordo-platform`: required checks,
   no force-push to the default branch, and secret scanning enabled — the
   private repository is where credentials are most likely to end up, so it
   gets the stricter configuration, not the looser one.
4. ~~Decide §1~~ — **done.** The gate split is ruled in §1; nothing further is
   needed here.

Until 1–3 are done, steps 2 onward do not begin.

---

## 3. The path manifest

Columns: **destination** in `accordo-platform` · **public replacement** (what a
public reader gets instead) · **generators** that read the path · **history**
method · **removal order** (the step in §4 that removes it publicly).

Classification counts, from `REPOSITORY_BOUNDARY.md` §2:
`PUBLIC_REDACTED_REPLACEMENT` 5 · `MOVE_PRIVATE` 35 · `SPLIT_PUBLIC_PRIVATE` 5.
**45 paths, all verified present at `f30d0f7`.**

### 3.1 `PUBLIC_REDACTED_REPLACEMENT` (5) — replacement first, removal last

| Source | Destination | Public replacement | Generators | History | Removal |
|---|---|---|---|---|---|
| `docs/strategy/MASTER_PLAN.md` | `docs/internal/MASTER_PLAN.md` | Public Now/Next/Later `ROADMAP.md` | — | `filter-repo` subtree | 6 |
| `docs/strategy/GO_TO_MARKET.md` | `docs/gtm/GO_TO_MARKET.md` | Adoption & contribution guide | `site/claims.json` evidence | `filter-repo` subtree | 6 |
| `docs/strategy/CATEGORY.md` | `docs/gtm/CATEGORY.md` | Positioning paragraph in `PRODUCT.md` | `site/claims.json` evidence | `filter-repo` subtree | 6 |
| `docs/strategy/AGENT_CRM_CLOUD.md` | `docs/internal/cloud/DESIGN.md` | `MANAGED_CLOUD_EDITION.md` + `CLOUD_INTEGRATION_CONTRACT.md` | — | `filter-repo` subtree | 6 |
| `docs/strategy/CLOUD_JTBD.md` | `docs/internal/cloud/JTBD.md` | The same two documents | `docs/benchmarks/CRM_JTBD_MATRIX.md` cites it | `filter-repo` subtree | 6 |

### 3.2 `MOVE_PRIVATE` — GTM strategy and research (7)

`COMPETITOR_MAP` · `MEDUSA_PLAYBOOK` · `AGENT_DISCOVERY` ·
`AGENT_RECOMMENDATION` · `ORGANIC_GROWTH` · `DISTRIBUTION_SUBMISSIONS` ·
`BRAND_REQUIREMENTS`, all under `docs/strategy/`.

Destination `docs/gtm/`. No public replacement — these have no public audience.
History: one `filter-repo` pass over `docs/strategy/`. Removal: step 6.

**One dependency:** `BRAND_REQUIREMENTS.md` is cited by `site-check.js` rule 4
as the reason no template may hardcode a brand. Under §1 option C that rule
travels to the private gate, and the citation travels with it.

### 3.3 `MOVE_PRIVATE` — launch, content and sales enablement (13)

`docs/marketing/`: `LAUNCH_PACKET` · `FOUNDER_CHECKLIST` · `CONTENT_PILLARS` ·
`CONTENT_PRODUCTION` · `GITHUB_LISTING` · `AWESOME_LIST_SUBMISSIONS` ·
`PENDING_HUMAN_SUBMISSION` · `DESIGN_BRIEF` · `NAME_VERIFICATION` ·
`OBJECTIONS` · `SITE_ARCHITECTURE` · `DEPLOYMENT` · `drafts/`.

Destination `docs/gtm/marketing/`. History: one `filter-repo` pass over
`docs/marketing/` **excluding `CORRECTIONS.md`**, which is
`HISTORICAL_ALREADY_PUBLIC` and stays. Removal: step 6.

**`DESIGN_BRIEF.md` carries a public dependency:** its §4.3 quotes `npm run
tour` output, and `tests/tour-claim.test.js` fails when a document quotes a
count the tour did not produce. That test scans public documents; once the
brief is private the test no longer sees it, and the brief's numbers stop being
gate-checked. Record that in the private repository rather than discovering it
later.

### 3.4 `MOVE_PRIVATE` — marketing-site implementation (15)

`site/templates/` · `site/partials/` · `site/blog/` · `site/shell.html` ·
`site/brand.json` · `site/compare.json` · `site/answers.json` ·
`site/concepts.json` · `site/glossary.json` · `site/tools.json` ·
`site/capabilities.json` · `site/assets/styles.css` · `site/assets/mark.svg` ·
`site/assets/social-preview.svg` · `site/assets/social-preview.png`.

Destination `apps/marketing-site/`. **Blocked on §1.** Under option C,
`claims.json`, `jobs.json` and the llms assets do **not** appear in this list
and stay public. History: `filter-repo` over `site/` with the public paths
excluded. Removal: step 6.

### 3.5 `SPLIT_PUBLIC_PRIVATE` (5)

| Source | Public half stays | Private half → |
|---|---|---|
| `ROADMAP.md` | The three-track roadmap | `docs/internal/ROADMAP_COMMERCIAL.md` |
| `vercel.json` | docs-MCP function config | `apps/marketing-site/vercel.json` |
| `docs/strategy/EXECUTION_ROADMAP.md` | Public engineering phases | `docs/internal/EXECUTION_GTM.md` |
| `docs/strategy/CUSTOMER_REVENUE_OS_ROADMAP.md` | Capability gap analysis | `docs/gtm/COMPETITIVE_AUDIT.md` |
| `docs/strategy/GTM_TECHNICAL_EVIDENCE_HANDOFF.md` | The evidence index | `docs/gtm/EVIDENCE_HANDOFF.md` |

A split is **an edit to the public file plus a new private file**, never a move.
History for the private half is a copy with a provenance note naming the public
commit it was split from — `filter-repo` cannot split a file, and pretending
otherwise would produce a private history that misrepresents what happened.

### 3.6 `docs/jtbd/` — path-by-path final inventory

Re-inventoried against measured `main` at `5b3d23d` after the catalogue, quality, alignment and measurement merges. The inventory is generated from `git ls-tree`; every tracked path is classified below. **Nothing is moved or deleted by this PR.**

| Current path | Long-term disposition | Boundary reason |
|---|---|---|
| `docs/jtbd/AGENTS.md` | **KEEP_PUBLIC** | Agent evidence rules must remain beside the public verification surface. |
| `docs/jtbd/MASTER.md` | **SPLIT_PUBLIC_PRIVATE** | Keep a canonical public job projection; private owns the complete strategic portfolio. |
| `docs/jtbd/PORTFOLIO_ALIGNMENT.md` | **KEEP_PUBLIC** | Public contract separating desired state, coverage and ownership. |
| `docs/jtbd/PUBLIC_PRIVATE.json` | **KEEP_PUBLIC** | Executable classification remains public until migration is executed. |
| `docs/jtbd/PUBLIC_PRIVATE.md` | **KEEP_PUBLIC** | Public explanation of the edition boundary. |
| `docs/jtbd/README.md` | **KEEP_PUBLIC** | Public entry point and reference-resolution guidance. |
| `docs/jtbd/catalog/capabilities.json` | **SPLIT_PUBLIC_PRIVATE** | Public capability identifiers; private strategic annotations where present. |
| `docs/jtbd/catalog/e2e_scenarios.json` | **SPLIT_PUBLIC_PRIVATE** | Public acceptance boundaries; private competitive or sequencing context. |
| `docs/jtbd/catalog/jtbd.jsonl` | **SPLIT_PUBLIC_PRIVATE** | Public canonical job subset; private complete strategic desired portfolio. |
| `docs/jtbd/catalog/personas.json` | **SPLIT_PUBLIC_PRIVATE** | Public role taxonomy; private commercial segmentation where appropriate. |
| `docs/jtbd/coverage/MATRIX_CROSSWALK.md` | **KEEP_PUBLIC** | Public preservation map for historical positive coverage rows. |
| `docs/jtbd/coverage/STATUS_CROSSWALK.md` | **KEEP_PUBLIC** | Public status-vocabulary contract. |
| `docs/jtbd/coverage/assessments.json` | **KEEP_PUBLIC** | Executable evidence bindings remain inspectable. |
| `docs/jtbd/coverage/coverage.overlay.jsonl` | **KEEP_PUBLIC** | Conservative public coverage conclusions and limitations. |
| `docs/jtbd/coverage/matrix_crosswalk.json` | **KEEP_PUBLIC** | Machine crosswalk preserving historical evidence. |
| `docs/jtbd/manifest.json` | **SPLIT_PUBLIC_PRIVATE** | Public projection gets its own checksum; private source keeps independent provenance. |
| `docs/jtbd/prompts/01_repo_coverage_audit.md` | **KEEP_PUBLIC** | Public evidence-assessment workflow. |
| `docs/jtbd/prompts/02_gap_to_roadmap.md` | **MOVE_PRIVATE** | Priority and gap-to-roadmap analysis exposes strategy. |
| `docs/jtbd/prompts/03_jtbd_to_spec.md` | **MOVE_PRIVATE** | Internal specification generation over the complete strategic portfolio. |
| `docs/jtbd/prompts/04_competitor_benchmark.md` | **MOVE_PRIVATE** | Competitive analysis is commercial research. |
| `docs/jtbd/prompts/05_simulate_lifecycle.md` | **SPLIT_PUBLIC_PRIVATE** | Public validation workflow; private portfolio-wide strategic simulation. |
| `docs/jtbd/quality/SEMANTIC_QUALITY_FINDINGS.md` | **MOVE_PRIVATE** | Detailed portfolio defect and disposition analysis. |
| `docs/jtbd/quality/findings.json` | **MOVE_PRIVATE** | Machine quality/gap findings over the strategic portfolio. |
| `docs/jtbd/quality_report.md` | **SPLIT_PUBLIC_PRIVATE** | Public structural validity; private detailed semantic quality. |
| `docs/jtbd/roadmap/OWNERSHIP.md` | **SPLIT_PUBLIC_PRIVATE** | Public tracks/status/dependencies; private priority and commercial sequencing. |
| `docs/jtbd/roadmap/capability_pillars.json` | **KEEP_PUBLIC** | Public technical ownership taxonomy. |
| `docs/jtbd/roadmap/pillars.json` | **SPLIT_PUBLIC_PRIVATE** | Public pillar contracts; private priority and commercial sequencing fields. |
| `docs/jtbd/roadmap/roadmap.overlay.jsonl` | **SPLIT_PUBLIC_PRIVATE** | Public disposition/dependencies; private prioritisation and business rationale. |
| `docs/jtbd/schemas/coverage.schema.json` | **KEEP_PUBLIC** | Public verification contract. |
| `docs/jtbd/schemas/jtbd.schema.json` | **SPLIT_PUBLIC_PRIVATE** | Public projection schema and private full schema evolve independently. |
| `docs/jtbd/schemas/persona.schema.json` | **SPLIT_PUBLIC_PRIVATE** | Public role projection and private full taxonomy evolve independently. |
| `docs/jtbd/tools/audit_semantic_quality.py` | **MOVE_PRIVATE** | Operates on and exposes strategic quality analysis. |
| `docs/jtbd/tools/query_catalog.py` | **KEEP_PUBLIC** | Public subset/overlay query surface must remain independently usable. |
| `docs/jtbd/tools/verify_catalog.py` | **KEEP_PUBLIC** | Public subset verification must not depend on private files. |

The full catalogue is already public history. Migration never rewrites that history. A future public projection must be checked in, checksum-bound and verifiable using only public files; the private source must not become a dependency of public CI. Coverage remains public and evidence-bound. Roadmap assignment never promotes coverage.

### 3.7 What explicitly does not move

`docs/marketing/CORRECTIONS.md` · `docs/benchmarks/URR_PILOT_2026-08-10.md` ·
the rail-selection panel record dated `2026-08-13` · `docs/transcripts/` ·
`benchmarks/` · `EXTERNAL_REVIEW.md` · `docs/benchmarks/CRM_BUILD_BENCHMARK.md`
and the benchmark protocols · every published limitation and blind-spot code.

**No step in this manifest may move a document because it is unflattering.**
If a future editor believes one of these should move, that is a change to
`REPOSITORY_BOUNDARY.md` §3 requiring a stated reason, not a migration step.

---

## 4. The ordered runbook

Each step states its verification and its rollback. **A step whose verification
fails is rolled back, not pushed through.**

### Step 0 — split the site gate per the §1 ruling *(public repository)*

Implement the §1 ruling (option C): split `scripts/site-check.js` into a
public `claims-check` (rules 1–3, 6) and a site-only check (rules 4–5); point
`gtm:check` at the public half.

- **Verify:** `npm run verify`, `npm run gtm:check`, `npm run site:check` all
  green **before** anything moves.
- **Rollback:** revert the commit. Nothing has moved yet, so this is free — which
  is exactly why it is step 0.

### Step 1 — human creates `accordo-platform` *(private)*

Per §2. **Verify:** the repository exists, is private, branch protection is on,
and the intended humans can push. **Rollback:** delete it; nothing depends on it yet.

### Step 2 — copy private-designated paths, preserving history

```bash
# one pass per subtree, into a scratch clone — never against a working repo
git clone --no-local /path/to/agent-crm /tmp/mig-strategy
cd /tmp/mig-strategy
git filter-repo --path docs/strategy/ --path docs/marketing/ \
                --path-glob 'site/**' \
                --invert-paths --path docs/marketing/CORRECTIONS.md
# inspect, then add accordo-platform as a remote and push to a staging branch
```

Where history is not worth the cost, a plain copy with a provenance note naming
the source commit is acceptable and **must say so in the file**.

- **Verify:** every path in §3 present in the private repository, readable, and
  building where it builds. Count them; do not eyeball them.
- **Rollback:** delete the staging branch. The public repository is untouched.

### Step 3 — verify the private destination

Nothing is removed publicly until this passes. **Verify:** file count matches
§3, the private site builds, no file is empty or truncated.
**Rollback:** fix forward in private; public is still untouched.

### Step 4 — add the public replacement documents

The four replacements in `REPOSITORY_BOUNDARY.md` §4, authored and merged
publicly **before** step 6 removes their sources.

- **Verify:** each replacement exists, `site:check`/`claims-check` green.
- **Rollback:** revert; the originals are still public.

### Step 5 — update links and generators

The **16 public files referencing 5 private-designated documents**
(`REPOSITORY_BOUNDARY.md` §4). Three take a *rule* rather than an edit —
`DECISIONS.md`, `docs/marketing/CORRECTIONS.md`, `docs/plans/*` — because
rewriting a dated record to repoint a link falsifies it; they get an appended
note that the target moved private. `site/claims.json` repoints to the public
replacement, because a ledger citing an unopenable path is the failure the
ledger exists to prevent. `docs/benchmarks/CRM_JTBD_MATRIX.md` repoints its
Cloud-operator row to `MANAGED_CLOUD_EDITION.md`.

Then regenerate: `npm run site:build`, `node scripts/generate-llms.js`,
`node scripts/assemble-docs-mcp-runtime.js`.

- **Verify:** `npm run gtm:check`, `npm run site:check`, and no public file
  containing a path under `docs/strategy/` or `docs/marketing/` that no longer
  exists publicly.
- **Rollback:** revert; sources are still public, so nothing dangles.

### Step 6 — remove private-designated sources from public HEAD

A **normal commit**, not a history rewrite.

- **Verify:** `npm run verify`, `npm run gtm:check`, `npm run site:check`,
  `node packages/cli/bin/accordo.js project doctor --json`, and a clean clone
  that builds and passes.
- **Rollback:** `git revert` restores the files. This is the first irreversible-
  feeling step and it is not actually irreversible — which is the point of doing
  steps 2–5 first.

### Step 7 — add `public-surface-check`

Specified in [`PUBLIC_ARTIFACT_POLICY.md`](PUBLIC_ARTIFACT_POLICY.md). It can
only be added here: before step 6 it would fail on 40 still-public paths and on
the 16 referencing files, and a gate born disabled or born lying is worse than
no gate.

- **Verify:** the gate passes on the post-step-6 tree, and **fails** when a
  private-designated path is reintroduced — prove both, or it is not a gate.
- **Rollback:** remove the workflow step.

### Step 8 — verify the whole public surface

Site builds · docs resolve · agent retrieval answers · `npm run verify` from a
clean public clone · the docs-MCP corpus regenerates · `llms.txt` regenerates
**from public inputs alone** (the §1 acceptance test).

**Rollback:** revert steps 5–7 as a set.

### Step 9 — the commitment

**Never claim old public history was erased.** Everything published stays in the
public history and may be read there. Public git history is **not** rewritten to
hide non-secret strategy. Secrets, if ever found, follow the separate rotation
and removal procedure in `SECURITY.md` — that procedure is about credentials,
and never about embarrassment.

---

## 5. What this manifest does not cover

- **`scripts/` is unclassified.** §1 resolves it for the seven site scripts; the
  rest of `scripts/` has no instruction and needs one before step 7's allowlist
  can be written.
- **`docs/benchmarks/` is partly classified.** The rail-selection protocol and
  panel records are covered; a future benchmark document inherits no rule.
- **No dependency scan for `packages/`.** No package was found to read a
  private-designated path, but that was verified by grep over known paths, not by
  a build in a tree with those paths absent. Step 3 is where that becomes real.
- **The private repository's own CI is unspecified.** Out of scope here.
