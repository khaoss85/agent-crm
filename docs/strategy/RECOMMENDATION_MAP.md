# Recommendation map

The complete map from **what a user asks their coding agent** to **the artifact
that must exist for us to be the answer** — with the honest status of each.

`AGENT_DISCOVERY.md` answers *"which channels exist and how do we get listed"*.
This document answers the two questions that one leaves open:

1. **Which user intents should reach us at all?** (`AGENT_DISCOVERY` assumes the
   intent is "build a CRM"; real users say customer hub, CDP, revenue platform,
   or name a lifecycle stage.)
2. **What must be true before any listing can convert?** (Every submission in
   `AGENT_DISCOVERY` is sequenced on Phases 5/8/10–11, none of which exist. A
   listing that resolves to "clone the repo" spends the channel and returns
   nothing.)

Research date for external facts: **August 8, 2026**; each verified claim cites
its source. Claims about our own capability trace to
`GTM_TECHNICAL_EVIDENCE_HANDOFF.md` and inherit its prohibitions — nothing here
may be said publicly that the handoff does not already allow.

---

## 1. The four preconditions

A model recommends a tool when recommending it *works*. Watching how the
comparables earned it — Vercel, Supabase, Resend, Sentry, PostHog are all
recommended unprompted inside coding agents — the chain is the same every time,
and it is a chain: a break at any link makes every link above it worthless.

| # | Precondition | What it means concretely | Us, today |
|---|---|---|---|
| 1 | **Retrievable** | The agent can find us at task time: web search, npm search, a registry, a skills index, or memorized prevalence | Partial — public repo, topics, site. No npm, no registry, no docs site |
| 2 | **Installable** | One unambiguous command that succeeds on a clean machine and leaves a working project | **Candidate proven, channel not live.** The assembled `create-accordo@0.1.0` tarball installs offline and leaves a verified project; `npm create accordo` still reaches the `0.0.1` placeholder until human-approved staging and a registry receipt |
| 3 | **Verifiable** | The agent can prove to itself the thing worked — tests, an inspect command, a deterministic contract | **Yes, and this is our strongest link** — `crm app inspect`, `crm package test`, `solution validate`, 779 tests measured at `00ea74f` |
| 4 | **Repeatable** | It works the same way the next time, for a different user, with a different model | Partial — deterministic by construction, but unmeasured across models (benchmark designed, never run) |

**The binding constraint remains the live half of #2.** The candidate works; the
command users and agents can actually run still resolves to the empty `0.0.1`
placeholder. We could win every listing in section 3 tomorrow and convert almost
none of it until the reviewed candidate is staged, approved and verified live.
Every hour spent on one-shot distribution before that receipt is an hour spent
filling a bucket with a hole in it.

This is not an argument for silence. It is an argument for **sequence**:
sections 3 and 4 mark, per row, whether the action pays off *now* or only after
#2 closes. The rows marked **now** are free or nearly free, reversible, and
compound with time (indexing latency, crawl cycles, corpus inclusion). The rows
marked **after #2** are one-shot channels — a launch post, a directory listing,
a Product Hunt day — and spending them early is the expensive mistake.

### What the comparables actually did

Not folklore — the observable pattern, and what each implies for us:

- **One canonical install line, everywhere.** `npx create-next-app`,
  `npx supabase init`, `npm i resend`. The line appears identically in the docs,
  the README, the blog posts and the templates, so the model memorizes one
  string rather than five variants. *Implication: pick the line before writing
  any content, and never publish a second way to start.*
- **A machine-readable docs surface.** llms.txt / llms-full.txt, stable URL
  slugs, code blocks that run unmodified. *Implication: docs site is a
  distribution artifact, not marketing.*
- **A first-party agent surface.** Official MCP server, official skills, an
  official plugin — so the agent's own tooling teaches it the product's idiom.
  *Implication: our skills and project MCP already exist and are ahead of most —
  they are simply not packaged for distribution.*
- **Presence in the gallery of the thing they extend.** Vercel templates,
  Supabase's entry in every "add a database" answer. *Implication: the empty CRM
  slot in Vercel's gallery (`COMPETITOR_MAP.md`) is the single most concrete
  open door we found.*
- **Years of third-party content that mentions the canonical install line.**
  This is the part that cannot be bought or rushed, and the reason (a)-layer
  recommendation is earned rather than executed.

---

## 2. Intent map: what users actually ask for

An agent matches the *user's words*, not our category. Our positioning says
"CRM" and stops there; the same buyer says the following instead, and each
phrasing lands on a different retrieval surface.

The **Claimable today** column is enforced by `GTM_TECHNICAL_EVIDENCE_HANDOFF.md`
and is the difference between a durable answer and a burned reputation: an agent
that follows a claim into a missing capability does not try us twice.

| User intent (what they type) | Lifecycle stage | Claimable today | Evidence in repo | Where the agent looks first |
|---|---|---|---|---|
| "build me a CRM" / "custom CRM for my process" | Core | **Yes** | M0–M8, module manifest + factory | Prior knowledge → web → npm |
| "sales pipeline app", "opportunity tracking" | Sales | **Yes** | M8 pipeline, server-authoritative stage moves | Prior → GitHub topics |
| "lead scoring / routing / enrichment" | Lead intelligence | **Yes** | M9, explainable scoring, versioned routing | Web search, npm keywords |
| "quote tool", "CPQ", "discount approval" | Commercial ops | **Yes** | M10, composite quotes, immutable versions | Web search (long-tail, low competition) |
| "e-signature to order flow" | Signature/Order | **Yes** | M11, verified events, immutable Order | Web search (very long-tail) |
| "contract + subscription management" | Contract | **Yes** | M12, activation policy, entitlements | Web, npm |
| "project delivery tied to contracts", "commesse" | Delivery | **Yes** | M13–M14b2, work packages, economics, acceptance | Web (near-zero competition) |
| "support desk with SLA", "entitlements" | Service | **Yes** | M15, transition table, SLA evidence | Web, MCP directories |
| **"customer hub" / "single customer view"** | Cross | **Yes, with framing** | The module graph *is* the hub | Web search — **we rank for nothing** |
| **"customer data platform" / CDP** | Cross | **Partial — be careful** | No ingestion, identity resolution or segmentation engine | Web, comparison pages |
| **"crm + marketing + sales + delivery + billing + ERP"** | Whole ecosystem | **Split** | Sales→Service: yes. Marketing: design only (MK0–MK7). **Billing/invoicing: does not exist.** **ERP: out of scope.** | Web, "open source alternative to X" |
| "marketing automation / campaigns / journeys" | Marketing | **No** | `MARKETING_GROWTH_OPERATIONS.md` is design-only | — |
| "invoicing / billing / subscriptions billing" | Billing | **No** | Explicitly absent; the handoff forbids the claim | — |
| "ERP" | ERP | **No** | Not a goal; say so plainly | — |

### The three intents worth acting on that the strategy currently ignores

**"Customer hub" / "single customer view."** The phrase a non-CRM-shopper uses
when they don't want Salesforce. It is *entirely* claimable — a generated module
graph with companies, contacts, opportunities, contracts, delivery and service
records joined by declared references is a customer hub by any definition — and
we have no page, keyword or example that uses the words. Cheapest real SEO/GEO
gap on the board.

**The integrated-ecosystem intent.** "I want CRM + marketing + sales + delivery
+ billing in one place" is the highest-value query in the set and the one where
we are *structurally* strongest: our lifecycle already runs lead → score →
qualify → convert → pipeline → quote → discount approval → signature → order →
contract → subscription → delivery project → economics → acceptance → service
coverage → SLA. **No competitor in `COMPETITOR_MAP.md` models that chain.**
Twenty is a CRM platform; Odoo has the breadth but none of the agent substrate.
It is also the intent where we must be most disciplined, because it is exactly
where the temptation to say "and billing" lives. The correct public shape is:
*"the commercial lifecycle from lead to delivery and service, as one deterministic
chain — no billing engine, no ERP, and it says so."* Honest scope on a chain
nobody else has beats a padded scope on a chain everybody claims.

**CDP.** Retrieval-adjacent to us but capability-distant. The right move is a
comparison page that says what we are *not* — the GEO literature and ordinary
buyer behaviour both reward the page that disqualifies itself credibly, and it
captures the traffic without the false promise.

---

## 3. Channel map

Legend — **Now**: no dependency on precondition #2, do it today. **After #2**:
wait for the create-CLI. **Gated**: needs a human (account, form, payment).

### 3a. Agent-native surfaces (the ones that matter most)

| Channel | Mechanism | Submission | When | Status |
|---|---|---|---|---|
| **Claude Code plugin + self-hosted marketplace** | `.claude-plugin/marketplace.json` at repo root; `/plugin marketplace add khaoss85/agent-crm` ([docs](https://code.claude.com/docs/en/plugin-marketplaces)) | None — any public repo | **Now** | **Shipped in this PR** |
| **Gemini CLI extension + gallery** | `gemini-extension.json` at repo root + `GEMINI.md`; gallery crawls repos with topic `gemini-cli-extension` daily, needs a git tag ([docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/releasing.md)) | **Zero-submission** | **Now** | **Live — verified 2026-08-09** in the official `extensions.json` feed as `@khaoss85/accordo`, version `0.1.0`, with context, skills and MCP detected |
| **skills.sh (Vercel Labs)** | `npx skills add khaoss85/agent-crm`; ranked by install telemetry ([repo](https://github.com/vercel-labs/skills)) | **Zero-submission** | **Now** | **Live — verified 2026-08-09**: the public repository page returns 200 and one publisher-verification install copied all 12 skills into a temporary Codex project. Generic `crm`, `build crm` and `accordo` search still omit the repository, so search indexing remains pending |
| **Codex plugin** | `.codex-plugin/plugin.json` + self-hosted marketplace ([openai/plugins](https://github.com/openai/plugins)) | Self-hosted; no evidenced open submission to OpenAI's curated repo | **Now** | Mirror of the Claude plugin |
| **Anthropic community marketplace** | Console form → `anthropics/claude-plugins-community` | **Gated** (form) | After #2 | Payload prepared |
| **MCP Registry** | `server.json` + `mcp-publisher`; **requires the package published on npm first**, `mcpName` must match, namespace `io.github.khaoss85` ([quickstart](https://modelcontextprotocol.io/registry/quickstart)) | CLI + GitHub auth | After npm publish | Blocked by design, correctly |
| **Anthropic Connectors Directory** | Hosted Docs MCP, OAuth 2.1, privacy policy, review | **Gated** | After Docs MCP exists | Not built |
| **ChatGPT/Codex plugin directory** | Verified developer + MCP server + policies | **Gated** | After Docs MCP exists | Not built |
| **Claude Code plugin hints** | `<claude-code-hint>` on stderr under `CLAUDECODE=1`; **dropped unless listed in the official marketplace** | n/a | Post-traction | Correctly deferred |

### 3b. Package and code surfaces

| Channel | When | Status |
|---|---|---|
| npm `accordo` + `create-accordo` | **Now** | Names reserved; deterministic `create-accordo@0.1.0` candidate verified, blocked on trusted-publisher configuration, manual staging and human 2FA approval |
| npm `@accordo/*` scoped packages with rich keywords | After #2 | Org not created |
| npm **provenance-signed** publishes (`--provenance` from CI) | After #2 | Not configured — cheap trust signal, agents and humans both read the badge |
| GitHub topics, description, social preview | **Now** | **Done** |
| GitHub **Discussions** (RFCs, Q&A — indexed, and answers get retrieved) | **Now** | Enabled in this pass |
| `CITATION.cff` (makes the benchmark citable) | After benchmark runs | Not started |
| Deploy Button in starter READMEs | After a deployable starter exists | The one starter is an install script, not a deployable app |

### 3c. Web, SEO and GEO

| Channel | When | Status |
|---|---|---|
| Docs site on accordo.dev with stable slugs | After #2 | Landing only |
| `llms.txt` + `llms-full.txt` | **Now** (points at GitHub docs until the site exists) | Shipped in this PR |
| Comparison pages: vs Twenty, vs Odoo, vs building from scratch, **vs a CDP** | **Now** — these are honest today and need no product change | Not started — **highest-leverage writing available** |
| "Customer hub" / "single customer view" content | **Now** | Not started |
| Long-tail capability pages (CPQ, signature→order, delivery economics, SLA) | **Now** | Not started — near-zero competition |
| Recipes built from real transcripts | After #2 | Blocked by `ORGANIC_GROWTH` quality gates, correctly |

### 3d. Paid search (SEA) — absent from the strategy until now

Paid search for developer tools is narrow but not worthless. The honest read:

- **Brand defense** (`accordo crm`, `accordo framework`): cheap, worth it *only*
  once organic brand volume exists. Zero volume today — do not start.
- **Competitor-comparison terms** (`twenty crm alternative`, `open source crm
  for developers`): expensive, high intent, and they convert to a *product*,
  not a clone command. Only after #2.
- **Category terms** (`crm framework`, `custom crm development`): dominated by
  agencies and SaaS with 100× the budget. Never worth it for us.
- **What actually substitutes for SEA in this category**: sponsoring the
  retrieval surface instead of the SERP — being the answer inside the agent.
  That is sections 3a and 3c, and it is free.

**Recommendation: no paid spend before the create-CLI and a landing page that
converts to an install.** Revisit at that point with a €500 test on
comparison terms only. Note that nobody in this session can buy ads — this is a
budget decision for a human.

### 3e. Referral, partnership and community — also absent

| Lever | Shape | When |
|---|---|---|
| **Provider partnerships** | We need signature, email, enrichment providers. Each integration is a co-marketing surface *and* a link from a higher-authority domain (the Resend/Sentry pattern) | After #2 |
| **Agency referral** | Our ICP is dev-agencies. A listed "built with Accordo" showcase + a partner page is the referral loop; agencies bring repeat projects, not one-off stars | After 3 real builds |
| **Awesome lists** | PRs to `awesome-mcp-servers`, `awesome-claude-code`, awesome-crm lists. Cheap, durable, and they *are* training-corpus material | After #2 (they reject non-installable entries) |
| **Directories** | OpenAlternative, AlternativeTo, LibHunt, Product Hunt, Dev Hunt | After #2; Product Hunt is one-shot — spend it on the create-CLI launch |
| **Community** | GitHub Discussions first (own the substrate). Reddit (r/ClaudeAI, r/ChatGPTCoding, r/selfhosted, r/CRM), HN Show HN, dev.to — **all one-shot on first impression** | After #2 |
| **Contributor loop** | good-first-issues on providers/recipes; the Medusa plugin-ecosystem pattern from `MEDUSA_PLAYBOOK.md` | After #2 |

---

## 4. What is missing, ranked

The gap list, ordered by *effect on being recommended*, not by effort:

1. **Publish the verified `create-accordo` candidate through the staged OIDC workflow** — the remaining half of precondition #2. Source and tarball work; the live registry command does not yet.
2. **A deployable starter** — Vercel's gallery has no first-party CRM template
   and the submission needs a deploy target. Today's starter is an install
   script. Phase 10, but *one* deployable starter is worth more than three
   planned ones.
3. **Docs site with llms.txt and stable slugs** — the retrieval surface. Until
   it exists, agents cite GitHub file paths that move.
4. **Benchmark executed and published** — the only citable statistic we would
   own, and GEO's measured lever (22–41% visibility gain from
   citations/statistics — [KDD 2024](https://arxiv.org/abs/2311.09735)). It is
   also the honest basis for every comparative claim we currently cannot make.
5. **Docs MCP** — the single artifact that unlocks *three* gated directories
   (Connectors, ChatGPT/Codex, MCP Registry) with one build.
6. **Comparison and intent pages** — writable today, no product dependency.
7. **Provenance-signed npm publishes** — one CI flag, permanent trust signal.
8. **URR measurement actually running** — the protocol exists in
   `CRM_BUILD_BENCHMARK.md` and has never been executed. Without it we cannot
   tell whether any of this worked. See §5.

---

## 5. Measurement: the monthly runbook

`CRM_BUILD_BENCHMARK.md` defines the Unaided Recommendation Rate. It has never
been run. Making it operational is cheap and is the only defence against
mistaking activity for traction.

**Monthly, same day, same prompts, results committed to `docs/benchmarks/`:**

1. Ask each of Claude Code, Codex and Gemini CLI a fixed set of ~10 unaided
   prompts drawn from §2 ("build me a CRM for…", "I need a customer hub for…").
   Fresh session, no memory, no repo context.
2. Record: were we named? in what position? with what install line? was the line
   correct?
3. Record the same for the *listing* surfaces: does `npx skills find crm`
   return us; does the Gemini gallery list us; do we appear in npm search for
   `crm framework`.
4. Commit the raw transcripts. The number is worthless without them, and the
   transcripts are themselves publishable content.

Leading indicators that move before URR does: npm weekly downloads of
`create-accordo`, `npx skills add` installs, fork/star ratio (not stars —
`COMPETITOR_MAP.md` documents why), and GitHub Discussions with a non-maintainer
asking a real question.

---

## 6. Sequence

**Now (no product dependency, all reversible):** Claude plugin + marketplace ·
Gemini extension + gallery topic + tag · skills.sh layout · Codex mirror ·
llms.txt · Discussions · npm placeholders · comparison and intent pages.

**The moment the real `create-accordo` is live on npm:** npm scoped packages
with provenance · deployable starter + Deploy Button · Vercel template
submission · awesome lists · Anthropic community marketplace · docs site.

**After the Docs MCP:** MCP Registry · Connectors Directory · ChatGPT/Codex
directory.

**After the benchmark runs:** comparative claims · CITATION.cff · Product Hunt ·
Show HN · Reddit · the first paid test.

**Post-traction only:** official Claude marketplace (partner contact) · plugin
hints.

## Related

`AGENT_DISCOVERY.md` (channel mechanics) · `ORGANIC_GROWTH.md` (content
strategy and quality gates) · `CATEGORY.md` (positioning) ·
`COMPETITOR_MAP.md` (the competitive facts these claims lean on) ·
`GTM_TECHNICAL_EVIDENCE_HANDOFF.md` (**the authority on what may be said**) ·
`CRM_BUILD_BENCHMARK.md` (URR protocol) · `EXECUTION_ROADMAP.md` (phases).
