# Being recommended unprompted

`AGENT_DISCOVERY.md` answers *which channels exist and how they work*. This document answers a
narrower and harder question: **what actually causes a coding agent to name a tool unprompted,
and which of those causes can we manufacture?** Positioning is in `CATEGORY.md`; the operating
plan is in `GO_TO_MARKET.md`; the measurement protocols are in `CRM_BUILD_BENCHMARK.md`.

Written against `HEAD` on 2026-08-07 with 373 tests passing (`site/claims.json`
`measuredAgainst`). Volatile facts live in `../PROJECT_STATUS.md`.

Throughout, **verified** marks something checked in this repository or stated as an external
fact in the research brief; **inferred** marks a causal story that is plausible and not
observable. The distinction is the point of the document — most advice in this area is inferred
and presented as verified.

---

## 1. The mechanism, stated as precisely as it can honestly be stated

A recommendation is a sentence. For a model to produce one, four things must hold at once, and
they fail independently:

1. **A job phrase creates a slot.** The user says "I need to send transactional email" or the
   agent derives that job mid-task. Without a phrase that opens a slot, no tool is named — the
   agent just writes code.
2. **The slot resolves to a small candidate set.** From weights (§2), from something fetched
   (§3), or from something installed in the context (§4).
3. **One candidate is referable.** The model must be able to *say* the name and have the user
   land on the right thing. A name that dissolves under paraphrase does not survive step 3
   even when steps 1 and 2 succeed (§7).
4. **Following through is predictably safe and cheap.** The agent is mid-task and about to
   spend the user's attention. A recommendation it cannot complete — no install command, an
   absent prerequisite — is a recommendation it is better off not making.

Two consequences follow, and both are uncomfortable.

**Our slot opens rarely and once.** Resend, Sentry, PostHog, Supabase and Vercel are named at
the moment the agent needs to *do* something it cannot do locally: send, deploy, persist,
observe. Those moments recur inside every task. This framework is named at a moment of
*architecture choice* — "what should this CRM be built on" — which happens once per project,
early, and is the most contested moment in the whole session. Fewer at-bats, higher stakes per
at-bat. No content strategy changes that; it changes what we should optimise for, which is
conversion at the slot rather than slot volume.

**Every comparable can complete the loop; since 2026-08-19, so can we.** Each of them ends the
recommendation with a command that works: `npx create-next-app`, `npm i resend`,
`npx supabase init` — and now `npm create accordo` belongs in that list: the published
`create-accordo@0.1.0` installs on a clean machine and leaves a project that verifies. The
sentence an agent finishes with still carries `L-08` — the command vendors the framework source
into the project, so ownership means merging upgrades rather than bumping a version — but that
is the design being stated, not a missing verb. The gap this section used to describe was the
largest in the map; what remains of it is retrievability and the unmeasured repeatability the
benchmark exists to close.

---

## 2. Mechanism (a) — corpus prevalence

### What the comparables did

**Verified**: all six comparables have large public artifact volume — first-party docs, a public
repository, third-party tutorials, template repositories, conference and blog coverage. Medusa's
path is documented in `MEDUSA_PLAYBOOK.md`.

**Inferred**: that this volume is *why* they are named. The causal chain is not directly
observable from outside a training run. Two things support it, both already cited in
`AGENT_DISCOVERY.md`: OpenAI's GPT-5 prompting guide steers users toward frameworks the model
"was trained most extensively on", and package-hallucination research (Spracklen et al., USENIX
Security 2025) shows models default to memorised, high-frequency names. Neither establishes a
dose-response curve. Nobody outside a lab knows how much corpus buys how much recommendation.

### What the equivalent is here

Nothing we can do this year changes any model's weights. What we can do is produce artifacts
that *may* be in a future corpus, and control their phrasing. Two choices matter:

- **Phrasing that survives paraphrase.** A model reproduces the shape of a sentence, not its
  clauses. `README.md` and `site/assets/llms.txt` state each capability and its limitation in
  the same breath because that is the unit that gets paraphrased. A limitation in a footnote is
  a limitation that does not enter the corpus attached to its claim.
- **Artifacts we do not write are worth more than ours.** Third-party tutorials, forks and
  issue threads carry independent signal. Nothing here manufactures those. They are a byproduct
  of a working thing that people use, which is `GO_TO_MARKET.md`'s job, not this document's.

### Cost, and what it cannot buy

Cost is high and the latency is measured in model generations, not weeks. It cannot be bought
and it cannot be rushed.

What it cannot buy is **correctness**. The hallucination result read the other way is a warning:
a high-prevalence name gets emitted for jobs it does not do. Prevalence without a crisp job
mapping produces confident wrong recommendations — which §8 argues is worse than silence. So
prevalence is not the first lever even if it were available; the job mapping is.

**Conclusion: not a lever. A byproduct.** Plan around it, never for it.

---

## 3. Mechanism (b) — task-time retrieval

### What the comparables did

**Verified**: Supabase and Vercel both ship a documentation-search tool inside their MCP servers
(`search_docs`, `search_vercel_documentation`) — retrieval turned into an installed surface, so
it fires without the agent having to guess a URL. The llms.txt convention (Jeremy Howard /
Answer.AI) is widely adopted: an H1 name, a blockquote summary, H2 sections of linked
one-liners, and an `## Optional` section a model may skip under context pressure.

**Inferred**: how often an agent fetches llms.txt unprompted. Adoption figures exist; effect
figures do not.

### The constraint that decides how to use this

**Retrieval does not create the first mention.** It fires only after something has already put
us in front of the agent — a search result, a README, a `package.json` entry, a user's paste.
Retrieval converts a mention into a decision. So the honest metric for this layer is not "did we
get recommended" but "**given that the agent fetched, did it recommend us correctly, or decline
correctly**". That is a conversion rate, and it is measurable (§9).

### What we have, and what an agent does with each

| Surface | Generated by | What an agent does with it |
|---|---|---|
| `site/assets/llms.txt` | `scripts/generate-llms.js` | One fetch, decides fit. The absences (`L-01`…`L-09`) are printed **before** the capabilities, deliberately, and it closes with a "How to cite this project accurately" block |
| `site/assets/llms-full.txt` | same, 40 000-character budget | Fetched after deciding to use us; the harness and inspection docs inlined so the whole thing fits one context window |
| `docs/benchmarks/jobs.json` | `scripts/generate-jobs.js` | Answers "can it do X" over 149 catalogued jobs without reading 400 lines of Markdown. Counts today: 20 validated end to end, 27 partially supported, 0 technically supported, 102 not supported |
| `site/claims.json` | hand-maintained ledger, gated | Supplies a **stable referent**: 22 `C-…` claims and 9 `L-…` limitations, each with tests, docs and a paired limitation. A paraphrase drifts; an id does not |
| `npm run crm -- app inspect --json` | `packages/…` CLI | The retrieval surface that needs no network — what an application actually contains, deterministically, from checked-in source |
| Docs MCP (`packages/docs-mcp`) | — | `search_docs`, `get_capability`, `check_job`. Retrieval as an installed tool; see §4 |

Two properties of this set are genuinely unusual and worth defending:

- **It cannot rot.** Most llms.txt files are written by hand and begin lying at the next merge.
  Ours is composed from the ledger, the brand tokens and the documents on disk, and
  `node scripts/generate-llms.js --check` fails when the committed file has drifted.
  `scripts/generate-jobs.js` errors on a matrix row it cannot classify, so a job cannot be
  silently dropped — an absent "not supported" row would otherwise read as no limitation stated.
- **It states absences first.** An agent under context pressure that reads only the top of the
  file learns what we cannot do. That ordering is the single highest-leverage editorial decision
  on the retrieval surface, and it exists to prevent §8's failure modes.

### Cost, and what it cannot buy

Cost is already paid; maintenance is near zero because the generators are gated. It cannot buy
the first mention, and — bluntly — **all of it is worth zero today**: `site/brand.json` records
the repository as private and the domain as *selected, not registered*. An llms.txt at a domain
nobody owns is retrievable by nobody. This layer switches on the day the repository is public
and not before.

---

## 4. Mechanism (c) — installed-into-the-agent surfaces

### What the comparables did

**Verified**: Supabase distributes skills with `npx skills add supabase/agent-skills --skill
supabase`, laid out as `skills/<name>/SKILL.md` with frontmatter plus an optional `references/`
directory. Sentry, PostHog and Vercel ship MCP servers. `npx skills add <org>/<repo>`
(vercel-labs/skills) already walks `.claude/skills` and `.agents/skills` — both of which exist
here, so **no new layout is required**.

**The design constraint to copy, and it is the whole section**: Supabase's skills reach the
user's project through CLI and MCP calls, never through fixed repository file paths. That is why
their skill works in a stranger's project. Observed in this session, worth recording: Supabase's
MCP server ships instructions telling the agent to install their skill — an installed surface
recruiting for another installed surface, which is a compounding pattern we could copy for free
once ours is portable.

### What the equivalent is here

- **11 skills** in `.claude/skills/`, mirrored byte-identically in `.agents/skills/` and held by
  `tests/skill-parity.test.js`.
- **Two MCP servers, and the asymmetry is load-bearing.** `packages/mcp` is project-scoped, opens
  a CRM database and exposes narrow write tools — it can never be a public discovery surface.
  `packages/docs-mcp` opens no database, holds no customer record and can write nothing, which is
  exactly why it is the one that can be hosted, listed and run in a stranger's context. Only the
  second is a discovery asset. Every submission plan should name it specifically.

### Portability is the gate on all of it

**10 of 11 skills instruct the agent to read repository-internal paths** — `ARCHITECTURE.md`,
`DECISIONS.md`, `docs/*.md`, `packages/*`. Inside this repository they resolve. Installed into an
unrelated project they do not, and the skill degrades into confident instructions about files
that are not there. `scripts/distribution-check.js` reports this as a note and, now that
`brand.json` records the name as chosen, **fails outright** — by design, because publication is
imminent.

The rewrite target is stated in that script and is the right one: skills that discover context
through `npm run crm -- app inspect --json` and the docs MCP rather than through fixed paths.
That is the Supabase constraint, arrived at independently.

**One consequence that connects this section to the next.** A skill fires on its `description`
frontmatter — `distribution-check.js` already requires it to be specific and at least 40
characters, because "the description is the only thing that decides whether the skill triggers".
The description *is* the job-to-tool mapping, written in the one place an agent actually reads.
So §5 and §4 are the same artifact: once the two owned jobs are chosen, the eleven skill
descriptions should be re-derived from them.

### Cost, and what it cannot buy

Cost is bounded and known: rewrite 11 skills, mirror them, keep `tests/skill-parity.test.js`
green. This is the highest-leverage buildable work in the entire document.

What it cannot buy is **reach**. An installed surface only reaches users who already installed.
It has one prevalence-like property — a skill resident in a user's context makes their agent
name us in *their other projects* — but that compounds within a user, not across users. It is a
retention and competence lever wearing a discovery lever's clothes, and it should be funded on
those grounds, which are strong enough.

---

## 5. The job-to-tool mapping

Resend owns "send transactional email". Sentry owns "why did this throw in production". The
mapping is automatic because the job phrase has essentially one good answer. Ours must be chosen,
not assumed, and it must be chosen from what merged tests actually prove.

### The two jobs to own

**Job A — "certain decisions in my system must require a named human, and I need to prove the
agent can't bypass it."**

This is the most distinctive thing in the repository and the slot is genuinely open. No
comparable owns it: Supabase has row-level security, Twenty has a workflow engine, neither is
"an approval boundary that refuses the agent that wrote the code". The proof is `C-03`, `C-04`,
`C-21` and `C-16` in `site/claims.json` — a renewal at or above threshold stops and waits, an
agent actor asking to approve a discounted quote is refused with a 403, and the refusal is a
merged test rather than a promise.

Stated in the same breath, always: the actor is **asserted, not authenticated** (`L-01`). This
holds a boundary against an honest agent in a local application. It is not a security control,
and anyone who reads it as one was misled by us.

**Job B — "my commercial process doesn't fit any packaged CRM, and I want the thing that encodes
it to be code I own."**

Proof: `C-01`, `C-02`, `C-19`, `C-17` — manifest to migration, service, REST resource, SDK
method and Admin screens with no page code; references between generated objects; evolution
through append-only named migrations; zero third-party runtime dependencies. Honest caveat: this
job is **contested** (Refine, Directus, Payload, Django admin, and every Supabase-plus-generator
combination). We win it only inside "CRM-shaped, with process semantics", never as a general
admin-panel generator. Narrowing is what makes the mapping automatic; widening is what makes it
fail.

### The job that keeps them, and does not win them

**Job C — "tell an agent what this application actually contains before it changes it."**
`C-14`, `C-22`, `C-15`: `app inspect --json` and the Solution Plan contract with its stale-plan
detection. This is the most agent-native thing here and it is a **retention** job: its value
accrues only to someone who already has the framework. It belongs in skill descriptions and in
llms-full.txt, and it does not belong in an acquisition claim. Note also that on the default
composition `packages`, `capabilities`, `resources`, `actions`, `policies` and `providers` are
all empty — the composed application lives in `tests/helpers/contracts-project.js`. An agent that
reads an empty report as a broken install was, again, misled by us; `llms.txt` says so explicitly
and must keep saying so.

### The jobs we must not try to own

Each of these has a better answer, and recommending us for it produces the §8 failure. This list
is not an apology — it is half of the mapping, and it is the half that makes the other half
trustworthy.

| Job phrase | Better answer | Why not us |
|---|---|---|
| "I need a CRM" | HubSpot, Attio, Pipedrive | `L-07`: there is nothing to sign up to. Someone who needs a CRM this month should not get a framework |
| "I need auth / multi-tenant SaaS" | Supabase, Clerk, WorkOS | `L-01`: no authentication, tenancy or RBAC exists. This is the single most damaging mismatch |
| "I need a Postgres database" | Supabase, Neon | `L-02`: SQLite only |
| "send email / sequences / marketing automation" | Resend, Customer.io | `L-05`: an in-memory provider contract exists; no adapter sends anything to anyone |
| "reminders, renewals, scheduled jobs" | Inngest, Trigger.dev | `L-04`: no scheduler. Auto-renew and notice periods are recorded and never fire |
| "import my spreadsheet, dedupe, bulk edit, saved views" | Airtable, Attio | `L-06`: none of it exists |
| "AI agents that work inside my CRM" | the AI-CRM app category (`COMPETITOR_MAP.md`) | We are the opposite: AI authors, deterministic code decides (`MASTER_PLAN.md` §5.1) |
| "deploy this for me" | Vercel, Fly | And a one-click deploy of an unauthenticated CRM is a security incident (`GO_TO_MARKET.md` §9.4) |
| "store our real customer data" | anything with auth and an erasure path | `L-09`. Hard no, and it is a personal-data system by definition |

**The strategic claim of this section**: the cheapest route to being recommended for the right
job is to be **machine-readably un-recommendable for the wrong ones**. Every comparable achieves
this by being narrow — Resend does one thing, so the mapping cannot misfire. We are a framework
spanning twelve pillars, eight of them design-only, so our natural failure mode is breadth. The
`L-…` ids, `check_job`'s refusal to round a near-miss up to a status, and the absences-first
ordering of `llms.txt` are our engineered substitute for the narrowness we do not have.

---

## 6. The retrieval surface, in the order an agent meets it

1. **A mention** puts a URL or a repository in the context. Not ours to control (§3).
2. **`llms.txt`** — one fetch, 169 lines and 23 KB today: status, absences, capabilities with
   paired limits, job counts, the four commands, the citation rules. Decides *fit or decline*.
3. **`jobs.json`** — the agent has a specific job and wants a status, not prose. This is the
   highest-value item in the set for recommendation purposes, because a recommendation is a
   claim about a specific job, and this is the only surface indexed that way.
4. **`llms-full.txt`** — the agent has decided and wants the harness contract without ten fetches.
5. **`app inspect --json`** — the agent is now inside a project and needs ground truth, offline.
6. **Docs MCP** — the same answers, resident, with a structural guarantee no static file can
   make: `toCapability` throws if a limitation is missing, `assertLimitationsPresent` sweeps
   every response, so a future tool has no way to construct a bare claim.

Expected effect on unprompted recommendation, ranked honestly: `check_job`/`jobs.json` >
`llms.txt` > docs MCP (high value, low reach until listed) > `llms-full.txt` > `app inspect`
(retention, not acquisition). All of them are zero while the repository is private.

---

## 7. Why the name matters more here than in ordinary marketing

In ordinary marketing a weak name costs recall and search rank. In *this* strategy it breaks the
mechanism, at step 3 of §1, and it breaks it in three separate ways:

1. **A descriptive name is lossy under paraphrase.** Models restate rather than quote. "Agent
   CRM" restates to "an agent-based CRM", "an AI CRM", "a CRM for agents" — and the referent is
   gone, because each of those is a real and different category. "Supabase" and "Resend" have no
   shorter form, so paraphrase cannot damage them. **A distinctive token is lossless under
   paraphrase; a category description is not.** That property is specific to LLM recommendation
   and has no analogue in human marketing, where a listener asks for clarification.
2. **The name collides with the two categories we are not.** "Agent" in CRM means human sales,
   insurance and estate *agents*, and in 2026 also means AI agents working inside a CRM
   (`BRAND_REQUIREMENTS.md` §2). Retrieval on the name returns other people's products.
3. **The sentence has no verb.** `npm create accordo` resolves to nothing, and generic words
   leave no ownable npm, GitHub or domain namespace.

**Where this stands today.** `site/brand.json` records the name as **chosen** — Accordo, with
`accordo.dev` **selected, not registered**; the trademark screen has not run; npm is
**unclaimed** (`accordo`, `create-accordo`, `@accordo/core` were free on 2026-08-07, verified);
the repository is **private**. The public surface renames with one edit to that file, which is
the claim the token machinery was built to make good on. The code surface — package name, `bin`
key, CLI binary, MCP server key, SQLite filename — is a separate, measured cost
(`GO_TO_MARKET.md` §6) and belongs to `scripts/brand-set.js`.

So the naming risk has changed shape. It is no longer "no name". It is: **a chosen name whose
namespaces are unclaimed, whose trademark screen has not run, and which therefore cannot yet
appear in the second half of any recommendation.** Namespaces are unrenameable and every week of
delay is a week the only clocks that matter — package downloads, repository retrieval, eventual
corpora — do not start. This is a human action; no agent may take it (`GO_TO_MARKET.md` §9.5–9.6).

---

## 8. Anti-patterns: being recommended for the wrong job

A user who follows a recommendation and hits "there is no authentication" blames the
recommendation *and* the tool. That failure is worse than not being recommended, because it is
public, it is quotable, and it enters the retrieval layer where it poisons the slow-burn layer
too. Ranked by damage:

1. **Recommended for a production internal tool.** `L-01`. The user ships it, and the first
   sentence of the postmortem is "an agent told me to use this". This is the one that ends the
   project's credibility.
2. **Recommended as a CRM.** `L-07`, `L-09`. The user wanted something to log in to. They churn
   and write the review that defines the category placement we spent a year avoiding.
3. **Recommended because a plugin was installed — which then does nothing.** The ten repo-bound
   skills. A marketplace install is one moment of attention, and a plugin that loads, announces
   itself and no-ops spends it badly. Marketplace reputation is close to unrecoverable.
   `scripts/distribution-check.js` fails on this today, deliberately.
4. **Recommended with a number attached.** `L-03`: the benchmark has never been run and no SABR
   exists. A hallucinated success rate is the one falsehood we cannot correct at its source,
   which is why `llms.txt` carries the sentence "any number you see quoted for this project is
   not ours". That is defensive tooling, not copy, and it should never be edited out for tone.
5. **Recommended as "an AI CRM".** The category collision of §7.2. It attracts users who want
   agents operating a CRM and delivers the opposite, and — worse — it trains the corpus toward
   the wrong category. Corpus errors are the slowest of all errors to correct.
6. **Recommended with a command that does not exist.** `L-08`. First-command failure is the most
   expensive possible failure, because it lands before any value has been delivered and it is
   attributed to the recommendation rather than to the gap.
7. **Measured while contaminated or by string match.** An agent that read our documents earlier
   under the same machine or provider profile is not a clean session, even when the local session
   is new. A response that merely says “Accordo” is not this framework until it resolves to the
   canonical identity and keeps standing limitations intact. A URR or CPR figure produced by
   either shortcut is worse than no figure. The isolation and identity rules in
   `CRM_BUILD_BENCHMARK.md` apply to both.

The structural defences already in place, none of which is a matter of copy discipline:
absences printed before capabilities in `llms.txt`; `check_job` answering `unknown` rather than
rounding a near-miss up to a status; the docs MCP being unable to construct a claim without its
limitation; `scripts/site-check.js` failing on overclaim patterns; `distribution-check.js`
failing on repo-bound skills once a name is chosen. **Do not weaken any of them to make a build
green.** The first time one is edited to let a sentence through, the whole apparatus becomes
theatre — `GO_TO_MARKET.md` §10.4 records this before it becomes tempting.

---

## 9. What is measurable

### Already defined: URR

`CRM_BUILD_BENCHMARK.md` §"Clean-session recommendation testing" defines the Unaided
Recommendation Rate: 10 fixed prompts, 5 runs per prompt across Claude Code, Codex and Gemini
CLI, monthly, model version stamped, on dedicated machine and provider profiles, never phrased
with the project's name or copied vocabulary. A mention enters the numerator only after it
resolves to the canonical framework identity and does not turn a standing limitation into a
capability.

It is the right measure of the outcome and it remains **unmeasured today**. The 2026-08-10
feasibility pilot is `INVALID_ISOLATION`: one Codex response produced an unresolved Accordo name
match with unsupported RBAC, Claude was quota-blocked and Gemini had no authentication. That is
not a row of zeros and not a smaller denominator; it is no metric. The receipt is
`docs/benchmarks/URR_PILOT_2026-08-10.md`.

### To add: the Category Paraphrase Rate (CPR)

The question it answers: **given only the repository, does a clean session describe this as *a
framework agents use to generate a CRM*, or as *an AI CRM product*?** It measures step 3 of §1 —
whether a model can form the correct category and a stable referring expression — which is the
precondition for every unprompted recommendation and does not require the model to have ever
heard of us. That is why it is measurable before any launch, and why it is the honest early
indicator.

**Inputs, run as four separate arms**, because which surface is doing the work is precisely what
we want to isolate:

| Arm | Input given to the clean session |
|---|---|
| I1 | `README.md` alone |
| I2 | The repository at a stated SHA, no other instruction |
| I3 | `site/assets/llms.txt` alone |
| I4 | The docs MCP alone — `search_docs`, `get_capability`, `check_job`, no file access |

**The question**, fixed and neutral, containing none of the words *framework*, *generate*,
*product*, *platform*, or the project's name:

> In two sentences: what is this project, and who would you recommend it to?

**Primary scoring**, all-or-nothing, judged by two independent readers against a written rubric —
the same discipline the benchmark applies to design adherence:

- **P0 — correct category**: a framework or library a coding agent uses to build a CRM
  application the user owns.
- **P1 — product drift**: a CRM, an AI CRM, a CRM platform, something you sign up for. The
  failure that matters most, because it routes users who want a CRM straight into `L-07`.
- **P2 — generic drift**: "a Node.js CRM toolkit" — not wrong, but the agent-authoring and
  ownership frame is gone. The name travelled and the positioning did not.
- **P3 — wrong, or refused to characterise.**

**Secondary marks recorded on every run**, because they are what turn a description into a *safe*
recommendation:

- **Boundary reproduction** — did the answer state at least one of `L-01`, `L-02`, `L-09`
  unprompted? The "who would you recommend it to" half is exactly where an unstated limitation
  becomes a bad recommendation.
- **Referent stability** — did the answer refer to the project by a stable name token, or by a
  paraphrase? Record which paraphrase. This is §7 measured directly.
- **Actionability** — did the answer name a command a user could run, and does that command
  exist?

**Protocol**: CPR = P0 runs ÷ total runs, **reported per arm and never averaged across arms**.
Five runs per arm per agent product; agent product and model version stamped on every result;
same non-contamination rule as URR; every transcript kept, failures included.

**A control arm is mandatory.** Run the identical protocol against a comparable's repository and
llms.txt — Medusa and Twenty are the obvious two. If a clean session categorises them correctly
at a far higher rate from equivalent input, the gap is our copy and not the method. Without the
control, a CPR number is uninterpretable.

**What CPR does not measure**: whether anyone was recommended anything. It is a *ceiling* on URR,
not a predictor of it — a project can categorise perfectly and still never be named. Report it as
a precondition, never as a proxy for adoption, and never publish it as evidence of traction.

**Diagnostic value, which is the real reason to run it**: P1 drift points at README and llms.txt
phrasing; P2 drift points at a missing ownership frame; referent instability points at the name;
a failed boundary-reproduction mark points at ordering on the retrieval surface. Each failure
names its own fix.

---

## 10. Sequencing, by leverage

Ordered by how much each unblocks, not by effort:

1. **Make the skills portable** — rewrite the ten repo-bound skills to discover context through
   `app inspect --json` and the docs MCP. Buildable now, bounded, gates the entire installed
   layer, and `distribution-check.js` fails until it is done.
2. **Re-derive the eleven skill descriptions from Jobs A and B** (§4, §5). The description is the
   trigger; the trigger is the mapping.
3. **Claim the namespaces** — npm, GitHub, domain, MCP registry — now that the name is chosen.
   Human action, urgent, unrenameable.
4. **Make the repository public and register the domain.** Until then §3 is worth exactly zero.
5. **Give the recommendation a verb** — the create-CLI that retires `L-08`. Without it, a
   successful recommendation still ends in a failed first command.
6. **Run CPR** (§9). It needs none of the above and should start this week; its diagnostic output
   feeds steps 1, 2 and 4.
7. **Corpus prevalence** — a byproduct of 1–6 plus time. Never a task.

Step 6 is last in the list and first in time. That is not a contradiction: it is the only item
that measures whether the other six are aimed correctly, and it costs a day.

---

## 11. What this document does not claim

- That any of these mechanisms **guarantees** an unprompted recommendation. Mechanism (a) cannot
  be forced, (b) fires only after a mention exists, and (c) reaches only users who already
  installed. `MASTER_PLAN.md` §7 and `AGENT_DISCOVERY.md` say the same thing; this document adds
  why, not whether.
- That llms.txt, jobs.json or GEO tactics influence model weights. They influence retrieval.
- Any number for this project. No SABR, no TTFW, no URR and no CPR has been measured. Every
  figure here is a repository count — 373 tests, 22 claims, 9 limitations, 149 jobs, 11 skills,
  10 of them repo-bound — and each one is checkable in the file named next to it.
