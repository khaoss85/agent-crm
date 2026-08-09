# Go to market

How this framework reaches the people who should use it, what is built, what is prepared but
unfired, and what is waiting on a human. Positioning and category are in `CATEGORY.md`;
channel mechanics are in `AGENT_DISCOVERY.md`; the content engine and its quality gates are in
`ORGANIC_GROWTH.md`. This document is the operating plan that sits on top of them.

Written against `HEAD` on 2026-08-07 with 373 tests passing. Volatile facts live in
`../PROJECT_STATUS.md`; this file holds the plan.

---

## 1. The bet

This project does not have a credibility problem or a quality problem. It has a **reachability
problem** and a **mechanism problem**.

- **Reachability**: no public name, no published package, no public repository. Nothing
  compounds, because none of the channels that accrue prevalence have started.
- **Mechanism**: the public promise is *"own the CRM it builds"*, and the only shipping install
  path copies this monorepo. That is real ownership and it is not the `npm create` plus
  versioned-dependency story the roadmap describes. The gap is now stated as `L-08` on every
  surface rather than papered over.

So the strategy is:

1. **Scope the promise to the mechanism that exists** — done, and enforced.
2. **Make honesty mechanical on every surface**, because verifiable restraint is the one asset
   a better-funded competitor cannot copy by writing a better headline.
3. **Build everything brand-token-driven**, so the pending name decision costs one edit.
4. **Find the truth about agent build success privately and first**, before spending a launch
   on a number nobody has measured.

The objective for the next ten weeks is not traffic. It is: **reduce the set of things blocking
launch to exactly the five human decisions in `MASTER_PLAN.md` §10 — and prove it with an exit
code.**

---

## 2. The UVP, in publishable form

### 2.0 The category, widened — "CRM" is the narrowest true label

The kernel knows nothing about a deal, a quote or a commessa. Those live in
optional packages, which means the same framework is the honest answer to a wider
set of *build-it* requests than "CRM" suggests: **quote-to-cash / CPQ**, **contract
and subscription lifecycle**, **delivery and professional services**, and the whole
chain as **revenue operations** — lead → sale → contract → delivery.

The internal framing is a **Customer & Revenue Operating System that a coding agent
builds on**, and the public sentence stays narrower than that on purpose: a
category claim is not evidence, and every one of those readings inherits the same
absences (no auth, no scheduler, no integrations, SQLite only).

Three constraints on widening, all binding:

1. **Every widened trigger must be a build request inside a coding agent.** "I need
   a CPQ" in general chat means buy one. The trigger is the phrase plus the surface,
   and that rule does not relax as the category widens.
2. **Service desk, ticketing and SLA are held back.** M15 Service is the next
   milestone and is not merged. Those rows are `not supported` in the catalogue and
   the positioning may not run ahead of them.
3. **The existing refusals stand.** "Smart CRM" / "AI CRM" is still the opposite of
   this model, "customer data platform" is still a different category, and "customer
   hub" is still only ours in the build-one reading (§9, `ORGANIC_GROWTH.md`).

The line that carries all of it: **it gives a coding agent a way to see, plan,
build, check and prove — instead of just generating code.** Each internal tool has
a plain-English name to match — see what exists, decide what to build, find what is
broken, create the right starting point, check it follows the rules, prove it works
— and a person building with this reads none of them.



### 2.1 The promise (unchanged, canonical)

> **Describe your sales process to your coding agent; own the CRM it builds.**

### 2.2 The sharper hero, for audiences who have seen agent-builder marketing before

> **Your agent can write the CRM. It can't approve the discount.**

Both are true and they do different jobs. The first states the category; the second states the
differentiator, and it is the one that survives a sceptical senior developer's first two
seconds. Use the promise where the reader arrived deliberately (README, docs, listings); use
the refusal where you are interrupting someone (Show HN, Product Hunt, comparison pages).

### 2.3 Subhead

> An open-source framework Claude Code and Codex use to build a CRM as code you own —
> deterministic workflows, versioned policies, audit and trace as primitives rather than
> features you bolt on. The agent writes the rules; a merged test refuses to let it make the
> human's approval decision.

### 2.4 The four proof points

Each resolves to a ledger id, and each ships with its limitation in the same block, at the same
type size. That rule is the credibility architecture — see §7.

1. **The refusal is a test, not a convention.** [C-04, C-03, C-21] · *Limit:* the actor is
   asserted, not authenticated, and the renewal policy is proven on one built-in object and one
   threshold.
   **Cite it correctly.** The named test — *"approval workflow rejects an agent pretending to
   make the human decision"* — is the **renewal** boundary (`tests/workflow.test.js`). The
   **discount** refusal is equally real but is asserted inside a composite test
   (`tests/commercial-e2e.test.js`: `quote.approve` with an agent actor rejects `403
   HUMAN_APPROVAL_REQUIRED`). A headline that says *discount* must cite that line, not the
   renewal test. **Move: extract it into a named test** so the strongest sentence we own cites a
   test name rather than a line number.
2. **The tool reports its own blind spots.** `crm app inspect --json` returns a machine-readable
   list of what it cannot see. [C-14] · *Limit:* source-only and read-only — **and today, run on
   the default composition, it returns six empty arrays.** Do not use this proof point in public
   until move 0.1 lands.
3. **The commercial spine runs end to end, and stops where the ledger says it stops** — lead
   capture through to a reproducible delivery contribution estimate. [C-06, C-08…C-12] ·
   *Limit:* every provider underneath is an offline fixture, and nothing bills, renews or fires
   on a schedule because there is no scheduler. Avoid the word *complete*: it is unfalsifiable
   and four ledger limitations contradict it.
4. **Nothing underneath you.** Zero third-party runtime dependencies. [C-17] · *Limit:* a
   property of the framework, not of what you add on top.

### 2.5 The disqualifier, placed before any capability claim

> Want an AI assistant inside your CRM? That is a different product category — go there.
> Want a working CRM your team logs into on Monday? Twenty or Frappe are more finished than
> this and have the release trains to prove it. Want no-code? This is a framework you and your
> coding agent write code with.
> Still here? Then you build the system, the commercial process is genuinely yours, and the code
> has to be in your repository when it is done.

### 2.6 Against configuring a platform

> **Use the platform instead if** you want a CRM your team can use next week, you need SSO or
> role-based access now, or you want a hosted option. All three are true of them and none is
> true of us today.
>
> **The difference that survives:** their agent writes extensions that run *inside their
> runtime*. Ours writes an application that runs *without us*.
>
> **The test:** *"if this project disappears tomorrow, what am I left with?"* Here: a Node
> application in your repository, no third-party runtime dependencies, and a SQLite file any
> client can open. With a platform, the answer is a runtime you must keep operating.
>
> Say it that way and not *"the framework is a dependency you could remove"* — today you get the
> code by copying it, not installing it, so upgrading means merging rather than bumping a
> version (`L-08`). That sentence was removed from the site for exactly this reason; it must not
> come back through a comparison page.

Sourcing, caveats and the places the alternative genuinely wins are maintained in
`COMPETITOR_MAP.md` and must be cited from it, never re-asserted from memory.

### 2.7 Against building from scratch

> **Use a starter instead if** your process is close to standard and you need auth and
> multi-user on day one. Those starters are more deployable than this is today.
>
> **What you pay for it:** you re-derive validation, stage semantics, approval policy, actor
> identity, immutability, audit and step-level trace yourself, on the deadline, in the part of
> the system that touches money.

### 2.8 The line promoted to public copy

> Configured CRMs are where customization goes to be tolerated; generated CRMs are where it
> goes to be owned.

---

## 3. What is built

| Asset | Where | State |
|---|---|---|
| Claims ledger — 22 capabilities, 9 limitations, each bound to tests and paired with its boundary | `site/claims.json` | ✅ |
| Brand tokens — name, domain, npm scope, licence, palette | `site/brand.json` | ✅ |
| Landing page and evidence page, built from the ledger, `noindex` | `site/templates/`, `npm run site:build` | ✅ |
| Claims gate — evidence exists, limitation present, three surfaces enforced, brand leaks, eleven overclaim patterns, ledger freshness | `scripts/site-check.js` | ✅ |
| Distribution manifests for Claude, Codex and the MCP registry, validated, unpublished | `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `server.json` | ✅ |
| Manifest gate — paths resolve, reserved names refused, names agree across manifests, skill frontmatter matches its directory, skill portability reported | `scripts/distribution-check.js` | ✅ |
| README rewritten against what the tests prove, with limits before capabilities | `README.md` | ✅ |
| Security posture stated rather than implied | `SECURITY.md` | ✅ |
| Social preview and page captures generated from the same ledger | `npm run site:shots` | ✅ |
| Launch packet — Show HN, Product Hunt, reply bank, gate | `docs/marketing/LAUNCH_PACKET.md` | ✅ prepared, unfired |
| The human decision queue | `docs/marketing/PENDING_HUMAN_SUBMISSION.md` | ✅ |
| GitHub listing pack | `docs/marketing/GITHUB_LISTING.md` | ✅ prepared |
| Objection bank | `docs/marketing/OBJECTIONS.md` | ✅ |
| Corrections log, seeded before the first public correction | `docs/marketing/CORRECTIONS.md` | ✅ |
| Content pillars and editorial calendar | `docs/marketing/CONTENT_PILLARS.md` | ✅ |
| Per-channel production plan — unit of work, cadence, effort, who, and the blocker where there is one | `docs/marketing/CONTENT_PRODUCTION.md` | ✅ |
| CI job holding public claims to the same standard as the code | `.github/workflows/ci.yml` → `public-claims` | ✅ |
| The tour — one command composing 70 modules, 6 packages, 41 resources, 56 actions, 7 policies and 5 providers, then printing every limitation code | `scripts/tour.js`, `npm run tour` | ✅ (0.1) |
| Skill portability contract — a `requires` block per skill (`tier`, surfaces, `degradesTo`) and a published subset that holds no repository-only skill, both gated | `docs/SKILL_PACKAGING.md`, `skills/`, `scripts/distribution-check.js` | ✅ (1.3) |
| `llms.txt` and `llms-full.txt` generated from the ledger, the docs and the job index, with a drift check | `scripts/generate-llms.js` | ✅ (1.10) |
| Rename inventory and executor — five casings, four blast-radius groups, held-back set, dry-run by default | `scripts/brand-set.js`, `docs/RENAME_SURFACE.md` | ✅ |
| Benchmark protocol amendment — Edition L (G1–G4) and Edition D (G5–G6, blocked), points out of 75, SABR and TTFW ruled out | `CRM_BUILD_BENCHMARK.md`, ADR-024 | ✅ (0.3) |
| Edition L harness — prepare, record, score, all three refusing rather than guessing | `benchmarks/harness/`, `npm run bench:*` | ✅ (0.4, harness only) |
| Pilot runbook and publication gate — how a run is driven, and which sentences a result licenses | `docs/benchmarks/PILOT_PROTOCOL.md`, `docs/marketing/BENCHMARK_PUBLICATION.md` | ✅ |
| Falsification kit — six mutations, three outcomes, refuses to run over uncommitted files, prints what it skipped | `scripts/falsify.js`, `docs/FALSIFY.md`, `npm run falsify` | ✅ (0.2) |
| **A pilot run** | `docs/benchmarks/PILOT_RESULTS.md` | ❌ needs a human operator and a clean agent session — see §8 |

---

## 4. What to build next, in order

Ordered by how much each one removes a reason not to launch. Every item names its artifact.

### Wave 0 — truth before persuasion

| # | Move | Artifact | Why it is first |
|---|---|---|---|
| 0.1 | **The tour.** Promote `tests/helpers/contracts-project.js` into a narrated one-command run over a composed example application, and freeze its `app inspect` output as a golden snapshot | `examples/apps/full-vertical/`, `scripts/tour.js`, `npm run tour` | `crm app inspect` on the default composition returns six empty arrays. The flagship command, run in the flagship repository, shows nothing — the entire product is invisible in the first sixty seconds, and the composed application already exists as a test fixture |
| 0.2 | **Falsification kit.** `npm run falsify` applies named mutations to a scratch copy — remove the agent-actor guard, cross the discount threshold, strip webhook signature verification, let generic CRUD write a managed field, mutate an issued Order line — and asserts the suite goes red for each, naming the test that caught it | `scripts/falsify.js`, `docs/FALSIFY.md` | Converts "trust our tests" into "disprove us in sixty seconds", and replaces the test count as the thing we point at |
| 0.3 | **Benchmark protocol amendment.** Define Edition L (gates G1–G4, scoreable today) and Edition D (G5–G6, behind the production spine), with the gate set named in every citation | `CRM_BUILD_BENCHMARK.md` | As specified, the benchmark cannot produce a number: G5 and G6 require a deployment the production spine gates. "Launch when the benchmark runs" is therefore an unbounded wait. **This is a positioning decision, not a build decision — see §8** |
| 0.4 | **Benchmark harness and a pilot**, results committed whatever they say, unpublished | `benchmarks/harness/`, `docs/benchmarks/PILOT_RESULTS.md` | Find out privately whether agents can actually build with this, before a launch depends on the answer |
| 0.5 | **Ejection proof, or accept `L-08` permanently.** An application in its own package that depends on the framework, verifies green, and documents what survives deleting the dependency | `examples/ejected/`, `tests/ejected-app-e2e.test.js` | The promise says "own"; today ownership means copying source. `L-08` is the honest interim, not the destination |

### Wave 1 — remove the remaining self-inflicted blockers

| # | Move | Artifact |
|---|---|---|
| 1.1 | Fold the claims gate into the local loop: `verify` = `check && test && gtm:check` | `package.json` |

| 1.3 | **Skill portability contract** — `requires` frontmatter per skill declaring the repository surface it needs, and a packaging document stating that today's honest target is this repository and projects built from it | `docs/SKILL_PACKAGING.md` |
| 1.4 | **Split the plugin** into skills-only (no MCP server) and full, so the safe half can list without carrying a server that resolves to nothing outside a checkout | `.claude-plugin/`, `.codex-plugin/` |
| 1.5 | **Regenerate `PROJECT_STATUS.md`** and automate it — it currently reports a stale SHA, 352 tests and AX2 as an open PR | `scripts/status.js` |
| 1.6 | **Loopback lock** — refuse a non-loopback bind without an explicit acknowledgement flag, and print the production posture on every `serve` | `packages/cli/`, a refusal test, a new ledger claim |
| 1.7 | **Production readiness ledger as a page** — per blocker: what breaks today, what you would have to build yourself, where it is tracked, and what you *can* legitimately do with this now | `site/readiness.json`, `site/templates/readiness.html` |
| 1.8 | **Threat model** — what the system defends against and what it explicitly does not | `docs/THREAT_MODEL.md` |
| 1.9 | **Content gate** — mechanise the six `ORGANIC_GROWTH` §11 gates: front-matter declaring claim ids, transcript path and named human editor; fail on a missing transcript, a missing editor, an unledgered number or any overclaim | `scripts/content-check.js` |
| 1.10 | **Generate `llms.txt` from the ledger and `app inspect`**, with a drift gate, so every capability entry emits its limitation as one unit | `scripts/generate-llms.js` |
| 1.11 | **Launch-readiness exit code** — §6 | `scripts/launch-ready.js` |
| 1.12 | `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and release notes drafted from `DECISIONS.md` so fourteen milestones of history are visible the day the repository goes public | repository root, `docs/marketing/releases/` |
| 1.13 | **npm shape without publishing** — workspaces and per-package manifests with rich descriptions and keywords, scope read from `brand.json`, `private: true` retained | `packages/*/package.json` |

### Wave 2 — human-gated unblocking

Name → registrar and trademark screen → one edit to `site/brand.json` → defensive namespace
registration → licence confirmation → repository public → npm publish → the submissions that do
not require a deployment. **Nothing in Wave 0 or Wave 1 depends on this.**

### Wave 3 — the first public story

Full Edition L run against the published protocol → human-approved publication with every
failure and transcript → Show HN on the benchmark rather than on the product → dev newsletters
pitched the data → Product Hunt, once.

The launch is a scoreboard with failures in it, not a product announcement.

**Standing rule for every move above.** A move that changes runtime behaviour — the loopback
lock, the ejection proof, the plugin split, the npm shape — opens with an ExecPlan under
`docs/plans/` and closes with a `DECISIONS.md` entry and `npm run verify`. Go-to-market work is
held to the milestone discipline in `AGENTS.md` and `docs/QUALITY_GATES.md`, not exempted from
it because the motivation is distribution.

### Wave 4 — post-spine only

Vercel templates, deploy buttons, Edition D of the benchmark, any hosted demo, the Connectors
Directory and the OpenAI plugin directory. All of them assert deployability.

---

## 5. Channel matrix

Layers per `AGENT_DISCOVERY.md`: **(a)** slow-burn model priors, **(b)** install-time
marketplaces and registries, **(c)** the in-session agent surface.

| Channel | Layer | Artifact required | State | Gate |
|---|---|---|---|---|
| GitHub repository | a/b | README, SECURITY, issue and PR templates, description, topics, social preview, release notes | Mostly built; `docs/marketing/GITHUB_LISTING.md` holds the metadata | Name, visibility |
| Self-hosted Claude marketplace | b | `.claude-plugin/marketplace.json` + plugin | **Live on merge.** Portability contract shipped: 11 of 12 skills published, `adversarial-review` held back as `tier: repository` | — |
| Self-hosted Codex marketplace | b | `.codex-plugin/`, `.agents/plugins/marketplace.json` | **Live on merge.** Mirror parity 12/12, held by `tests/skill-parity.test.js` | — |
| Gemini CLI extension + gallery | b | `gemini-extension.json` + `GEMINI.md` at the repository root, topic `gemini-cli-extension`, and one git tag | **Live.** The official gallery feed listed `@khaoss85/accordo` at version `0.1.0` on 2026-08-09 and detected its context, skills and MCP surfaces | — |
| Anthropic community marketplace | b | The same manifests, via the Console form | Ready | **Human submission**, and it should point at something installable first — the create-CLI |
| MCP registry | b | `server.json` + a published npm package | `server.json` ready; `@accordo/mcp` returns 404, so the entry would resolve to nothing | Publish `@accordo/mcp` → human |
| npm | a/b | Per-package manifests, rich keywords, provenance-signed publish | `accordo` and `create-accordo` **reserved** as empty 0.0.1 placeholders (2026-08-09); the `@accordo` scope is unclaimed and the real packages do not exist | The create-CLI, then an npm org (web-only) |
| `npm create <name>` | b/c | `packages/create/` | Does not exist | Name, Phase 5 |
| skills.sh | b/c | Nothing — it already walks `.claude/skills` and `.agents/skills` | **Live.** Public repository page and 12-skill Codex install verified 2026-08-09 | Generic search indexing: pending |
| llms.txt / retrieval | a | Generated from the ledger, with a drift gate | **Built** — `llms.txt`, `llms-full.txt`, `jobs.json`, `answers.json`, sitemap, robots and JSON-LD, all generated and drift-checked | Deploy |
| **In-session agent surface** | **c** | AGENTS.md, CLAUDE.md, skills ×2 harnesses, MCP config ×2, `app inspect`, harness compatibility | **Strongest layer** | **None — fully ours** |
| Show HN | launch | `LAUNCH_PACKET.md` §2 | Written | Human posts |
| Product Hunt | launch | `LAUNCH_PACKET.md` §3 | Written | Human posts, once, on the benchmark |
| Anthropic Connectors Directory, OpenAI plugin directory | b | A **hosted Docs MCP** — not the project runtime — plus an endpoint, an auth mode and a privacy policy | Does not exist | **`packages/docs-mcp` (Phase 8) + hosting + a privacy policy.** *Not* the production spine: a documentation MCP serves docs, not customer records, so it needs none of the CRM's auth, tenancy or RBAC. `AGENT_DISCOVERY.md` says this twice, and treating these as spine-blocked closes the only two reviewed directories reachable before Phase 6 |
| Vercel template gallery, deploy buttons, hosted demo | b | A template with a working deploy and a live demo URL | Cannot be met honestly | **Production spine** — these assert deployability |
| Discord / Slack | — | — | Deliberately not done | Reconsider at two consecutive months of 20+ substantive Discussions threads **and** a named human on call |

Dominate (c), be present in every (b), and let (a) follow from published proof plus time —
measured monthly, never promised.

---

## 6. "Launch-ready but unlaunched", defined as an exit code

Not a feeling. `node scripts/launch-ready.js` exits 0 when all of the following hold, and the
only remaining blockers are the five human decisions:

1. `npm run verify` exits 0 (including `gtm:check`).
2. `npm run smoke` exits 0.
3. `npm run tour` exits 0 from a fresh clone, in under five minutes.
4. `npm run falsify` exits 0 — every claimed refusal has a proven load-bearing mutation.
5. `claims.json` `measuredAgainst.sha` equals HEAD and its test count equals the last run.
6. Every claim declaring the `readme` surface appears in `README.md`; every `launch` claim
   appears in the launch packet. **Enforced today.**
7. Zero brand leaks across `site/**`, `docs/marketing/**` and built output. **Enforced today.**
   Deliberately *not* the whole repository: the working title is also the package name, the CLI
   binary and the database filename, so a repository-wide assertion could only ever be satisfied
   by renaming the codebase — and an assertion that cannot pass gets quietly weakened, which is
   the failure mode §10.4 warns about.
8. `npm run distribution:check` exits 0. **Enforced today.**
9. Skill parity is 11/11, asserted by `tests/skill-parity.test.js`. **Enforced today.**
10. The composed example's `app inspect` golden snapshot matches current output **and its
    `packages`, `capabilities`, `resources`, `actions`, `policies` and `providers` are all
    non-empty.** Equality alone is satisfied forever by a file of six empty arrays, which is
    exactly the state this assertion exists to end.
11. Either `examples/ejected/` verifies green, or `L-08` is in the ledger **and** the scope
    qualifier appears on every surface asserting the promise. **Currently satisfied by L-08.**
12. Edition L pilot results are present, or explicitly recorded as not-run with a reason.
13. `PENDING_HUMAN_SUBMISSION.md` enumerates exactly the five decisions and nothing else.

**Rename cost is measured, and it is not one file.** Assertion 7 above is scoped to
`site/**`, `docs/marketing/**` and built output — where the target genuinely is *one edit to
`site/brand.json`, zero hits for the old slug*. The working title is also the npm package name,
the `bin` key, the CLI binary filename, the `.mcp.json` server key (which every installed user
would have in their own config), the plugin name that namespaces every skill, the MCP registry
namespace, the SQLite filename and `.env.example`. Publishing "one file" and then shipping a
thirty-file rename commit is a self-inflicted credibility wound in the one repository that
cannot afford one. Write the inventory down (`docs/RENAME_SURFACE.md`) before the name is chosen,
and report two numbers: **public surface — 1 file; code surface — measured, and stated.**

---

## 7. Metrics

Guardrails carried forward from `EXECUTION_ROADMAP.md`: no metric is reported publicly without
its measurement protocol; URR is observed, never promised; telemetry ships only opt-in with a
human-approved policy.

### Pre-launch, measurable today

| Metric | Definition | Target |
|---|---|---|
| Launch-readiness exit code | `scripts/launch-ready.js` | 0 |
| Blocked-decision count | Human gates that are the sole remaining obstacle | 5 of 5 |
| Rename cost | Files changed to adopt the public name | 1 file, 0 hits |
| Cold time-to-wow | `git clone` → green tour receipt | under 5 minutes |
| Falsification coverage | Refusal properties with a proven load-bearing mutation ÷ refusal properties claimed | 100% |
| Ledger coverage | Assertive sentences resolving to a ledger id across README, built site and `docs/marketing` | 100% |
| Ledger freshness lag | Commits between HEAD and `measuredAgainst.sha` | 0 at publication |
| Agent-surface parity | `.agents/skills` ÷ `.claude/skills` | 11/11 — **reached, and held by a test** |
| Overclaim hits | Occurrences in built output | 0, permanently |
| SABR-local (Edition L) | Fully-passing prompts ÷ attempted on G1–G4, per framework SHA × agent × model, ≥2-of-3 runs | Internal; publication is a human decision |
| Manual interventions per run | Per the benchmark definition — an edit or unrequested fix counts; a clarifying answer does not | The number that actually predicts whether the promise is true |

### Post-launch

Roadmap metrics (SABR, TTFW, URR, plugin adoption, community integrations) apply as defined,
with three additions worth the effort:

- **Message-reproduction rate** — of clean sessions that describe the framework at all, the
  share reproducing the refusal boundary or the ownership frame rather than "an open-source
  CRM". Separates *the name travelled* from *the positioning travelled*.
- **Correction latency** — hours from a public claim being disproven to its removal or a test
  being added, with a public correction log. Under 24 hours.
- **Reveal-shock rate** — the share of first-time issues that are surprised discoveries of a
  documented limitation. Rising means the limits are buried, however honest the document is.

Measure forks, clones and unique cloners — **never stars**. `COMPETITOR_MAP.md` documents this
category's star counts as marketing-inflected.

---

## 8. The founder's decision queue

Ordered by how much each unblocks. The first should start **this week**: every week it slips is
a week the compounding channels do not start compounding.

| # | Decision | Blocks |
|---|---|---|
| 1 | **Public name**, after registrar re-verification and a real EUIPO + USPTO class 9/42 screen | The entire install-time layer. Run Accordo and Pactio in parallel; Pactio has a live legal-tech namesake, Relato's domains are taken |
| 2 | **Accept or reject the Edition L / Edition D benchmark split** | The whole launch timeline. Amending a published protocol is a positioning act, which is why it is yours |
| 3 | **Final licence confirmation** | The permissive-core claim, which is load-bearing in every comparison |
| 4 | **Repository visibility** | Every repository link and both self-hosted marketplaces |
| 5 | **Telemetry policy** | Two metrics. Can wait — but no collection code ships first |
| 6 | **Pre-commitment to publish the benchmark result whatever it says**, made publicly before the run | The credibility of the whole strategy on the day a number exists. An agent must not make this commitment on your behalf |
| 7 | **Named human editor of record** for every published piece | All content |
| 8 | **Security disclosure contact** | The repository going public |

---

## 9. Do not do

1. **Do not publish, cite, estimate or illustrate any SABR, TTFW, TTFD or success rate** —
   including as a mockup placeholder. `scripts/site-check.js` fails on the pattern. **Do not
   weaken the pattern to let copy through.** Treat that file as policy: changes to the overclaim
   list deserve the same discipline as a change to the approval boundary itself.
2. **Do not use** production-ready, enterprise-grade, secure by default, multi-tenant, SOC 2,
   zero-config, guaranteed, fully autonomous, trusted by, or anything implying deployability.
3. **Do not put the test count in a headline.** It is the most attackable sentence we own.
4. **Do not add a deploy button, a live demo or a Vercel template.** A one-click deploy of an
   unauthenticated CRM is a security incident wearing a marketing asset's clothes.
5. **Do not claim any namespace** — npm, GitHub org, MCP registry, domain, social handle — under
   the working title or an unchosen shortlist name. Namespaces are unrenameable.
6. **Do not let an agent submit anything, create an account or register anything.** "Preparing a
   submission" must never drift into "submitting a prepared submission".
7. **Do not deploy the landing page while the repository is private.** The hero call to action
   would 404. `README.md` is the pre-launch landing page.
8. **Do not put a limitation in a footnote, tooltip, accordion or "learn more" link.** Same
   block, same breath, same type size.
9. **Do not ship a comparison that hides where the alternative wins.** It takes the honest 95%
   of the page down with it.
10. **Do not name provider vendors as integrations.** Every provider is an offline fixture.
11. **Do not open a Discord.** A dead chat server is negative signal and unkillable once created.
12. **Do not write content about anything design-only** — Cloud, Analytics Studio, Marketing
    MK0–MK7, Data Governance, Integration Runtime, Jobs and Outbox, renewals firing, scheduling,
    the create-CLI — except as clearly labelled architecture or roadmap posts.
13. **Do not chase stars or announce dates** for the production spine, the create-CLI or the
    benchmark. **Generated pages** were banned outright here and are now allowed under the
    four-part mechanical test in `ORGANIC_GROWTH.md` §12 — which `/jobs/*` passes in full and
    `/answers/*` passes on three parts, meeting the fourth only in a weaker, stated form. Read the
    test there rather than the summary here; it was already corrected once after a review found it
    overclaiming.
14. **Do not attack a competitor's licensing rhetorically.** Structural differentiation survives
    scrutiny; disparagement invites it.
15. **Do not publish anything without a named human editor of record.**

---

## 10. The risks that actually matter

### 10.1 The promise's mechanism

Ownership today means copying source. Stated as `L-08`, on every surface, and it is the honest
interim rather than the destination. The permanent fix is the ejection proof (0.5) or the
create-project CLI. Until one exists, a hostile reader who finds `install.mjs` finds nothing we
have not already said — which is the entire point of saying it first.

### 10.2 The wedge is narrower than the headline

The refusal is genuinely differentiating, and its own limitation says the actor is asserted
rather than authenticated, on one built-in object with one threshold. On a public thread that
becomes: *"so your guardrail is an unauthenticated header check on one hardcoded threshold."* If
that lands before we have said it ourselves, the claims-discipline positioning inverts into the
overclaiming it was built to oppose. Mitigation: the limitation ships in the hero proof block at
the same type size, the Show HN first comment raises it pre-emptively, the objection bank answers
it in our own words, and the linter makes it structurally impossible to publish the capability
without the caveat.

### 10.3 Naming is a single point of failure with compounding cost

Prevalence accrues on package downloads, repository retrieval and eventual training corpora.
None of those clocks start until a name exists, while the strongest competitor ships weekly and
converges on our language. The structural danger is arriving at launch technically ahead and
commercially invisible. Every move in Waves 0–1 is name-blind and the rename is engineered to
one edit — but no plan removes the risk that the decision simply is not made.

### 10.4 The honesty gate is only as good as its willingness to fail a build

The first time someone edits the overclaim list to let a sentence through, the whole apparatus
becomes theatre. Recorded here before it is tempting.

### 10.5 A marketplace listing shipped before the skills are portable

Ten of eleven skills read repository-internal paths; installed elsewhere a plugin loads,
announces itself and does nothing useful. Marketplace reputation is close to unrecoverable, and
failed-install commentary is exactly what ends up in retrieval — poisoning the slow-burn layer
too. `npm run distribution:check` reports this today and fails outright once a name is chosen.
