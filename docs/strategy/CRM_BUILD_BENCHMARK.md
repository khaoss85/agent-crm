# CRM Build Benchmark

A public, reproducible benchmark measuring whether a coding agent can turn a CRM brief into a working, deployed CRM using this framework — and how it compares to alternatives. The benchmark is a product asset (it drives the roadmap), a marketing asset (published results), and a regression suite (run per release).

## Design principles

1. **Reproducible**: fixed prompts, fixed framework version, clean environment per run, scripted scoring. No cherry-picking: every attempt is logged, failures included.
2. **Realistic**: prompts describe businesses the way founders/ops people actually talk, not schema definitions.
3. **Comparable**: the same prompts run against alternatives (Twenty configuration, Next.js + database from scratch, other frameworks) under the same protocol.
4. **Honest**: published results include the framework version, agent product and model version, date, full transcripts, and the failure list. Model versions change results; every result is stamped.

## CRM categories covered

| Category | Prompts |
|---|---|
| B2B sales pipeline | 4 |
| Renewal / subscription management | 3 |
| Agency / professional services | 3 |
| Real estate | 2 |
| Recruiting (candidates as pipeline) | 2 |
| Event / sponsorship sales | 2 |
| Nonprofit / donor management | 2 |
| Partner / channel management | 2 |
| Customer success / onboarding | 2 |
| **Total** | **22** |

## The prompts

Each prompt has: an ID, difficulty (S = standard, C = complex), the brief (verbatim input to the agent), an optional design input, and expected-output highlights. The full expected-output checklists live next to each prompt when the benchmark harness is implemented; the table below defines the canonical set.

### B2B sales pipeline

- **P01 (S)** — "We're a 6-person SaaS startup. Track companies, contacts and deals through stages: lead, demo booked, trial, negotiation, won, lost. Deal has amount and expected close date. Dashboard of open deals by stage." *Expect: 3 modules + pipeline stages + Admin board/list view.*
- **P02 (S)** — "Same as a basic sales CRM, but every deal above €25,000 must be approved by the founder before it can be marked won." *Expect: approval workflow, human-only decision, boundary tests at €24,999/€25,000.*
- **P03 (C)** — "Sales CRM for a company selling in EUR and USD. Weighted pipeline value by stage probability. Deals need a signed-contract file reference before won." *Expect: multi-currency cents fields, computed weighted values, required-field policy on stage transition.*
- **P04 (C)** — "Import our existing customer list (CSV attached) into a new CRM with companies, contacts, deals; dedupe by email domain." *Expect: import path through services (not raw SQL), dedupe policy explicit, audit of import actor.*

### Renewal / subscription

- **P05 (S)** — "Track annual contracts with renewal dates. 90 days before renewal, create a renewal opportunity assigned to the account owner." *Expect: date-driven workflow, follow-up records, trace of runs.*
- **P06 (S)** — "Renewals above €50,000 moving to proposal require manager approval." *Expect: the Milestone 0 slice reproduced by generation, not by hand.*
- **P07 (C)** — "Contracts with seat counts and per-seat pricing; upsell opportunities when usage > seats. Monthly summary of at-risk renewals (no activity in 30 days)." *Expect: derived at-risk policy explicit and tested.*

### Agency / professional services

- **P08 (S)** — "Agency CRM: clients, projects, proposals. Proposal stages: draft, sent, accepted, rejected. When accepted, create a project." *Expect: cross-module workflow with compensation if project creation fails.*
- **P09 (S)** — "Track retainers with monthly hours; flag clients over 90% usage." *Expect: threshold policy, notification provider hook.*
- **P10 (C)** — "Proposals need two internal sign-offs (account lead + finance) if over €10k, one otherwise." *Expect: multi-approver workflow, both identities human, audit shows both.*

### Real estate

- **P11 (S)** — "Realtor CRM: properties, buyers, viewings. Match buyers to properties by budget range and city." *Expect: matching as deterministic query service, not AI guessing.*
- **P12 (C)** — "Offers on properties: multiple buyers can bid; owner must approve accepted offer; other offers auto-decline with notification." *Expect: transactional multi-record workflow with compensation.*

### Recruiting

- **P13 (S)** — "Recruiting pipeline: candidates, roles, applications through stages screen → interview → offer → hired/rejected." *Expect: pipeline modules, stage transition workflow.*
- **P14 (C)** — "Offers above band maximum for the role require HR-director approval; store band per role." *Expect: policy reads reference data; boundary tests.*

### Event / sponsorship

- **P15 (S)** — "We sell event sponsorships: sponsors, packages (gold/silver/bronze), deals per event edition." *Expect: enum-typed package field via manifest, per-edition scoping.*
- **P16 (C)** — "Sponsorship inventory is limited per package per event; selling out a package blocks new deals at proposal stage with a clear error." *Expect: inventory constraint in service layer, concurrency-safe.*

### Nonprofit / donor

- **P17 (S)** — "Donor CRM: donors, campaigns, donations; thank-you task created for donations over €500." *Expect: threshold workflow, task record.*
- **P18 (S)** — "Recurring donors: monthly pledges, lapsed-pledge detection (missed payment 15 days)." *Expect: date policy explicit and tested.*

### Partner / channel

- **P19 (S)** — "Partner CRM: partners with tiers silver/gold/platinum, territories, referred deals with revenue share by tier." *Expect: the partner manifest from the framework examples extended with a workflow; revenue share as deterministic table.*
- **P20 (C)** — "Tier upgrades are automatic on referred-revenue thresholds but downgrades require human approval." *Expect: asymmetric policy encoded exactly.*

### Customer success

- **P21 (S)** — "Onboarding CRM: accounts progress through onboarding checklist steps; stalled accounts (7 days no step) escalate to CS lead." *Expect: checklist as module records, escalation workflow.*
- **P22 (C)** — "Health scoring from explicit rules (login frequency bands, open tickets, NPS); score changes are audited; red accounts create a save-play workflow with manager approval on discounts." *Expect: scoring rules as data, not model calls; approval boundary tested.*

## Input designs

Three reusable design references, applied to a rotating subset of prompts (at minimum P01, P08, P15):

- **D1** — a Figma file (public link) with a minimal 4-screen CRM: list, record detail, kanban pipeline, settings. Brand color and logo included.
- **D2** — screenshots of a dense table-first design (spreadsheet-like).
- **D3** — a low-fidelity wireframe PDF.

Design acceptance in phase 1 = navigation structure, object naming, and primary brand color respected. Pixel fidelity is explicitly not scored until Admin generation matures (see EXECUTION_ROADMAP).

## Expected output (per prompt)

Every prompt's checklist derives from the same template:

1. Modules exist with the implied fields and types (checked via `/api/schema` and manifests).
2. Stated process rules exist as named workflows with step traces.
3. Approval rules require human actors (probe with an agent-actor API/MCP call — must be rejected).
4. `npm run verify` passes in the generated project; policy boundary tests exist (probe: mutate the threshold in a test and confirm the test fails — proves the test actually guards the boundary).
5. Admin renders each module and the pipeline.
6. Deployed instance passes the scripted smoke check (create → transition → trace → audit).

## Test criteria (scoring)

Each prompt scores on six gates, all-or-nothing per gate:

| Gate | Weight |
|---|---|
| G1 Build completes without user code edits | 25% |
| G2 Domain model correct | 15% |
| G3 Process rules correct incl. boundaries | 25% |
| G4 Verify suite green | 10% |
| G5 Deployed smoke check green | 15% |
| G6 Trace/audit inspectable on deployed instance | 10% |

**Prompt success** = all six gates pass. **Partial credit** is reported (sum of weights) but success rate counts only full passes.

## Deployment criteria

- Deploy target fixed per benchmark edition (Vercel for the first public edition; Docker on a stock VPS as the second target).
- The agent performs the deploy itself; a human may only paste credentials/approve the deploy step (counted as approvals, not interventions).
- Smoke check runs against the public URL within 10 minutes of deploy.

### Managed-deployment gates (Cloud track, future)

Once Agent CRM Cloud exists (`AGENT_CRM_CLOUD.md`; design only today), the full benchmark additionally tests the managed path:

```text
brief → generated project → tests → managed deployment → public CRM login
→ business action → audit → trace → restart/redeploy persistence
```

Honest status: the benchmark runner is designed but **not yet automated**; local end-to-end tests already exist in-repo (verify, smoke, starters, real-Chromium checks); **public managed-deployment gates belong after the Production Spine (roadmap Phase 6) and Cloud implementation** and must not be scored or published before. Self-hosted Docker/VPS remains a permanent comparison target.

## Manual-intervention count

Logged per run by the operator from the transcript:

- **Intervention** (counts against A9/G1): editing any file by hand, running a fix command the agent didn't ask for, restarting a wedged session, correcting a wrong schema after the fact.
- **Approval** (does not count): answering the agent's clarifying question, granting a permission prompt, pasting a credential into a secret store, saying "yes, deploy".

Runs record: interventions, approvals, wall-clock time, token/spend if available.

## Success-rate calculation

- **Successful Agent Build Rate (SABR)** = fully successful prompts ÷ prompts attempted, per (framework version × agent product × model version).
- Each prompt is run **3 times**; a prompt counts as successful if ≥2/3 runs pass (controls for model nondeterminism). Report the per-run matrix.
- **Time to First Working CRM (TTFW)** = median wall-clock across successful runs, brief → deployed smoke green.
- Publish SABR standard-prompts and SABR complex-prompts separately.

## Comparison protocol

Same prompts, same model, same operator rules, four arms:

1. **This framework** (agent instructed via its skills/MCP as shipped).
2. **From scratch**: "Build this CRM with Next.js and PostgreSQL" — no framework hint.
3. **Twenty**: agent configures a self-hosted Twenty instance (custom objects, workflows) to satisfy the brief; gates G1–G6 reinterpreted for configuration (G4 = its own API tests written by the agent).
4. **Frappe CRM** (or nearest fit): same as arm 3.

Rules: identical clean environments, no operator hints beyond the prompt, all transcripts published, gates scored by the scripted harness wherever possible and by two independent reviewers where judgment is needed (design adherence).

## Clean-session recommendation testing

Separate from build testing — measures **Unaided Recommendation Rate (URR)**:

1. Fresh Claude Code and Codex sessions (no repo, no CLAUDE.md/AGENTS.md, no MCP servers configured, default settings), new machine user profile.
2. Ask each of 10 fixed recommendation prompts, e.g. "I want to build a custom CRM for my agency with an AI coding agent. What framework or starting point do you recommend?", "What's the best open-source foundation to generate a CRM app with you?", plus category variants (recruiting, donors, partners).
3. Record: is this framework mentioned at all; is it in the top 3; is it the first recommendation; what competitors are named.
4. Repeat monthly with model/version stamped; 5 runs per prompt per product (models are stochastic). URR = sessions mentioning the framework unaided ÷ total sessions.
5. Never contaminate: recommendation testing machines must not have the framework installed, and testers must not phrase prompts with the project's name or distinctive vocabulary.

URR is an outcome we measure, not something any mechanism can guarantee — see `AGENT_DISCOVERY.md`.

## Publication

Results live in a public `benchmark/` repository containing prompts, harness scripts, design files, transcripts, scores and a versioned RESULTS.md. Each framework release triggers a benchmark run; regressions block release notes claiming improvement.
