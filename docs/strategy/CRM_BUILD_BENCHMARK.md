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

### Editions: what can actually be scored today

The six gates above are the full benchmark, and the full benchmark cannot be run.
G5 and G6 need a public deployment; this framework has no authentication, tenancy
or RBAC and reports `productionPosture: "local development only"`. Running them
would mean exposing an unauthenticated CRM on the internet to earn 25 points.

Rather than quietly drop two gates and publish the remaining four as if they were
the whole thing, the benchmark splits into two named editions. **The split is the
honest part; erasing it would be the dishonest part.**

| Edition | Gates | Status | Instrument |
|---|---|---|---|
| **L** (local) | G1–G4 | runnable today | `benchmarks/harness/score.js` |
| **D** (deployed) | G5–G6 | **blocked on the Production Spine** | none, deliberately |

Four rules govern Edition L, and each exists because the obvious alternative is a
number that reads better than it is:

1. **Edition L reports points out of 75, never a percentage.** The four gates keep
   their original protocol weights — 25 / 15 / 25 / 10 — unrenormalised.
   Renormalising to 100 produces 33.3 / 20 / 33.3 / 13.3, which needs a rounding
   convention nobody will remember and, worse, yields a figure that looks like a
   success rate. A point total cannot be mistaken for one.
2. **A gate that could not be checked is never a pass.** Each gate returns `pass`,
   `fail` or `needs-operator`, and only `pass` earns points. A run with any
   `needs-operator` gate is `scoreable: false` and belongs in no aggregate.
3. **The per-prompt verdict is binary and separate from the point total.** An
   Edition L prompt passes only when all four gates pass. A run scoring 65 of 75
   that misses G3 is a failed prompt. The two numbers are never substituted for
   one another, and 65/75 is never described as "87%".
4. **Edition D is reported as blocked, never as absent.** Every scored run carries
   `editionD: { outcome: "BLOCKED_NO_PRODUCTION_SPINE" }`. G5 and G6 are not run,
   not estimated, and not omitted.

**G1 is operator-attested, not measured.** Whether a human edited a file is a fact
only the operator witnesses, so it is read from the run's append-only intervention
record: zero interventions passes, one or more fails, and *no record at all* is
`needs-operator` rather than a free 25 points. Every report says so in its own
`attestation` field, and any figure derived from these runs must repeat it.

ADR-022 records this decision and what would have to change to retire it.

## Deployment criteria

- Deploy target fixed per benchmark edition (Vercel for the first public edition; Docker on a stock VPS as the second target).
- The agent performs the deploy itself; a human may only paste credentials/approve the deploy step (counted as approvals, not interventions).
- Smoke check runs against the public URL within 10 minutes of deploy.

### Managed-deployment gates (Cloud track, future)

Once Accordo Cloud exists (`AGENT_CRM_CLOUD.md`; design only today), the full benchmark additionally tests the managed path:

```text
brief → generated project → tests → managed deployment → public CRM login
→ business action → audit → trace → restart/redeploy persistence
```

Honest status: the benchmark runner is designed but **not yet automated**; local end-to-end tests already exist in-repo (verify, smoke, starters, real-Chromium checks); **public managed-deployment gates belong after the Production Spine (roadmap Phase 6) and Cloud implementation** and must not be scored or published before. Self-hosted Docker/VPS remains a permanent comparison target.

## Future end-to-end scenarios (planned, not implemented)

Two composite scenarios extend the benchmark once the workstream milestones exist (`EXECUTION_ROADMAP.md` M9–M15; strategy in `REVENUE_OPERATIONS.md`, `DELIVERY_SERVICE.md`, `ANALYTICS_STUDIO.md`). **Status: planned.** They are not part of the current 22-prompt set, must not be scored or published before their primitives are implemented, and any gate involving real external users (partner/customer access, role-aware dashboards) is additionally gated by the Production Spine (Phase 6). The 22 existing prompts are unchanged.

### E2E-R1 — Revenue Operations end to end (planned)

```text
Landing page → Lead → enrichment → explainable scoring → versioned routing
→ sales assignment (language/country/capacity) → authorized manual override
→ qualification and conversion → Quote from synced catalog → discount approval
→ signature → Order → dashboard → rollback proof
```

Executable gates (all-or-nothing, each with scripted evidence):

| Gate | Evidence required |
|---|---|
| R1-G1 Enrichment snapshot | snapshot exists with raw source refs, normalized fields, provider identity, retrieval time, expiry |
| R1-G2 Reproducible score | replaying the recorded model version + inputs reproduces the score; per-rule contributions sum to it |
| R1-G3 Routing result + trace | RoutingRun records policy identity, version, inputs, rule matches, result, actor, timestamp |
| R1-G4 Authorized override | permitted manager reassignment succeeds with reason + history; unauthorized actor rejected at the service boundary |
| R1-G5 Correct Quote pricing | quote lines match price-book entries; totals deterministic, per currency, integer minor units |
| R1-G6 Discount approval | over-policy discount blocked until a human decision; agent-actor probe rejected; no PATCH bypass |
| R1-G7 Verified signature | unverified webhook mutates nothing; verified completion creates the immutable SignedArtifact |
| R1-G8 Order snapshot | Order preserves the signed commercial snapshot after a subsequent catalog change |
| R1-G9 Dashboard | metrics render from tested MetricDefinitions; no free-form SQL surface reachable |
| R1-G10 Rollback proof | policy rolled back by publishing a prior version; historical runs still reference the versions that produced them |
| R1-G11 Audit/trace | every mutation in the chain carries actor, audit and trace, inspectable end to end |

Failure criteria: any silent decision (a score without contributions, a route without a recorded version), any approval bypass, any mutated snapshot, any raw-SQL surface, any unverified webhook effect — each fails its gate outright; a failed gate fails the scenario.

### E2E-D1 — Delivery & Service end to end (planned)

A signed SaaS Order including migration, training and premium support; a third-party partner performs the migration.

```text
signed Order → Commessa → milestones and work packages
→ third-party partner assignment → access verification
→ cost and revenue-share tracking → Change Request → customer acceptance
→ billing milestone → Service Contract → SLA support case
```

Executable gates:

| Gate | Evidence required |
|---|---|
| D1-G1 Immutable order scope | project scope copied from the Order; later quote/catalog edits leave it byte-identical |
| D1-G2 Project creation | idempotent handover: one Commessa, milestones and work packages from order lines; double handover is a stable visible conflict |
| D1-G3 Partner engagement | engagement records role, scope, responsibilities, cost, revenue share, SLA, access scope, dates |
| D1-G4 Access boundary | partner actor reaches only assigned work; out-of-scope reads/writes rejected at the service boundary (real-user enforcement scored only post-Spine; pre-Spine runs may verify declared-actor boundaries and must say so) |
| D1-G5 Milestone/deliverable flow | milestones progress with audit; deliverables completable only through the governed flow |
| D1-G6 Budget vs actual margin | time/cost entries roll up to deterministic margin (integer minor units) matching a fixture |
| D1-G7 Change versioning | Change Request → impact → human approval → new scope version; prior scope preserved |
| D1-G8 Customer sign-off | acceptance recorded with actor and notes; rejection blocks milestone close |
| D1-G9 Billing eligibility | billing milestone unlocks only from accepted milestones; CRUD cannot set it |
| D1-G10 Service activation | ServiceContract + Entitlements + SLA active post go-live |
| D1-G11 SLA case handling | support case against the SLA: deterministic targets, escalation path, human decision points, full audit/trace |

Failure criteria: mutable order scope, duplicate projects, partner access beyond scope, float money math, acceptance or billing reachable through CRUD, silent approvals, or missing audit/trace on any step — each fails its gate; a failed gate fails the scenario.

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

### SABR and TTFW are Edition D metrics, and Edition D is blocked

Both definitions above are written against the full six-gate benchmark, and
neither survives the edition split:

- **SABR counts fully successful prompts.** With G5 and G6 unrunnable, no prompt
  can be fully successful, so SABR over Edition L runs is not a smaller SABR — it
  is a different metric wearing the same name. Edition L's aggregate is the
  **Edition L prompt-pass count**: how many of the attempted prompts passed all
  four local gates, reported as a count over a stated denominator, never as SABR
  and never as a percentage.
- **TTFW is measured brief → deployed smoke green.** There is no deploy, so there
  is no TTFW. Wall-clock to a green local suite is a different quantity; if it is
  ever published it gets its own name, not this one.

Neither name may appear on a public surface until Edition D runs. `scripts/site-check.js`
already refuses a published percentage; these two names are the same class of
claim and are held to the same rule by `docs/marketing/BENCHMARK_PUBLICATION.md`.

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

## Planned scenarios added at the Platform Alignment Gate

All **planned, none implemented**, and none may be published as a result until a merged milestone proves it. They exist so the benchmark grows with the roadmap instead of being retro-fitted to it.

| ID | Scenario | Proves | Depends on |
|---|---|---|---|
| E2E-C1 | **Order → Subscription activation** — sign a composite quote, activate the contract, and read subscription lines whose amounts and provenance match the Order exactly | that the Order really is a sufficient commercial source of truth | M12 |
| E2E-C2 | **Renewal scheduling** — a term nearing its end produces a renewal opportunity without anyone asking | that deferred work is durable | M12 + Jobs/outbox |
| E2E-D2 | **Delivery handover** — an activated contract becomes a delivery project whose scope is a frozen copy | that handover is idempotent and scope is immutable | M13 |
| E2E-P1 | **Partner access** — a partner sees only their engagement | a real access boundary, not a declared actor | M13 + Production Spine |
| E2E-G1 | **Data-governance request** — export everything about a subject, then erase them while signed commercial evidence survives and says what was retained | the hardest governance design | Data Governance track |
| E2E-X1 | **Design-to-CRM build** — brief + design reference → an on-brand, responsive, accessible Admin | the third North Star input | Design-to-CRM phases 1–4 |
| E2E-CL1 | **Cloud preview and deploy** — push a branch, get a preview, promote to production with a human approval, roll back | the managed runtime | Cloud + Production Spine |
| E2E-PL1 | **Plugin install** — install a third-party domain package, use its modules and actions, disable it cleanly, **with no core patch** | ADR-018's plugin promise | domain package boundary |
| E2E-SH1 | **Self-host export** — export a Cloud project and run it locally to a green smoke | no lock-in | Cloud export path |

## Test infrastructure the benchmark still needs

The benchmark cannot honestly score the scenarios above until these exist. All are listed as future gates in `docs/QUALITY_GATES.md` §4.

- **Browser E2E in CI** — today the 26-check Chromium smoke runs manually. This is the single largest coverage gap, and it blocks every UI-scored scenario.
- **PostgreSQL conformance** — the same suite green on both adapters, so a benchmark result is not SQLite-specific.
- **Property-based tests** for pricing arithmetic and state machines, alongside the current example-based matrices.
- **Provider sandbox contract tests** — the published kit from `INTEGRATION_RUNTIME.md`, run against real sandboxes only where credentials are explicitly supplied.
- **Durable job and outbox tests** — scheduling, leases, retries, dead-letter, replay.
- **Tenant and RBAC tests** — isolation and a permission matrix, without which no multi-user scenario can be scored.

## Publication

Results live in a public `benchmark/` repository containing prompts, harness scripts, design files, transcripts, scores and a versioned RESULTS.md. Each framework release triggers a benchmark run; regressions block release notes claiming improvement.

**What may be said about a result before that repository exists** — which sentences
are permitted, which are refused, and the minimum a published figure must carry
with it — is in `docs/marketing/BENCHMARK_PUBLICATION.md`. **Nothing from an
Edition L run is published without it.** How a run is actually driven, from
`prepare` to `score`, is in `docs/benchmarks/PILOT_PROTOCOL.md`.

## Marketing & Growth scenarios (planned — none implemented)

These five sit alongside the existing scenarios and are **not executed**. They exist so MK1–MK7 have a definition of done written before the code (`MARKETING_GROWTH_OPERATIONS.md`). Each names its evidence and its failure criteria, because a marketing benchmark that only checks "a thing was sent" measures nothing.

### E2E-M1 — Campaign Proposal (MK1)

```text
funnel data → drop insight → audience and exclusion plan → Campaign Proposal
→ content, landing and tracking proposal → human review
```

**No external send.** Evidence: a proposal stating objective, hypothesis, KPI, audience, exclusions, consent requirements, mode, channel, provider rationale, content plan, tracking plan, risks and required approvals; the funnel insight with its query version; the proposal versioned and immutable once reviewed. **Fails if** the proposal is assembled from fragments the reviewer must piece together, any provider is contacted, or any field the human approved can change without a new version.

### E2E-M2 — One-shot campaign (MK2)

```text
consent-safe audience snapshot → approved email content → provider fixture/sandbox send
→ delivery, click and conversion events → report
```

Evidence: a frozen audience snapshot with its definition fingerprint; every exclusion counted and explained by reason; a human actor required to send; delivery/bounce/unsubscribe ingested and attributed to the run; unsubscribe honoured across all campaigns. **Fails if** the send reads a live query instead of the snapshot, an exclusion is silent, an agent actor can send, or a replayed provider event double-counts.

### E2E-M3 — Journey experiment (MK3–MK5)

```text
trigger → durable journey → control and variants → multi-channel steps → exit goal → lift
```

Evidence: exactly-once step execution across a forced restart; enrolments pinned to the journey version they entered; deterministic, reproducible variant assignment; exposure recorded separately from assignment; an immutable result including "inconclusive". **Fails if** a restart drops or repeats a step, publishing a version mutates active enrolments, assignment is not reproducible from stored inputs, or the result is a live query that drifts.

### E2E-M4 — Paid acceleration (MK6)

```text
organic campaign under target → Ads proposal → human budget approval → provider launch
→ spend and result ingestion → recommendation
```

Evidence: budget in integer minor units; explicit human approval before any spend or launch; platform references stored as external references; ingested spend reconciled against approved budget; pause and budget-change surfaced as **proposals**. **Fails if** any spend, launch or material targeting change occurs without a recorded human approval, or an amount is a float.

### E2E-M5 — Closed-loop attribution (MK7)

```text
touchpoints → Lead → Opportunity → Quote/Order → attribution model → campaign ROI
```

Evidence: touchpoints linked through the identity model; at least two attribution models run over the same data with their assumptions and versions stored; control-group lift reported where a holdout exists; every metric compiled from semantic definitions. **Fails if** any query is agent-generated raw SQL, a model is presented as truth, an attribution run mutates after the fact, or ROI is claimed without a stated model version.

