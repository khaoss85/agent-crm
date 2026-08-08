# Organic growth engine

Growth built only on real product assets: working code, reproducible builds, honest benchmarks. No paid acquisition, no inflated claims, no content that a maintainer wouldn't stake the project's reputation on. The engine's core loop:

```text
Ship capability → prove it (benchmark/starter) → document it as a recipe
      → publish where developers and agents look → measure (SABR/URR/traffic)
      → feed gaps back into the roadmap
```

Every stage is executable by Claude Code or Codex; every public output passes human quality gates.

## 1. Documentation recipes

Recipes are the atomic content unit: one business outcome, built end-to-end, verified by CI.

- Format: goal → brief (the actual prompt) → what the agent generates → the deterministic policy encoded → verify output → deploy → inspect trace. Every recipe ends with the full working repo state.
- Initial set (maps to benchmark categories): approval thresholds, renewal follow-ups, proposal→project handoff, partner tiers, donor thank-yous, stalled-onboarding escalation.
- **Recipes are tested**: each recipe is a fixture in CI — the repo state it describes must pass `npm run verify`. A recipe that rots gets flagged by the build, not by an embarrassed reader.
- Each recipe page carries machine-readable front-matter (brief, modules, workflows) so agents consuming docs (or the Docs MCP) can retrieve it precisely; the docs site ships llms.txt.

## 2. Starter repositories

The three starters from EXECUTION_ROADMAP Phase 10 (sales+approvals, agency, partner/channel), plus micro-starters extracted from popular recipes when demand shows up in issues/discussions.

- Each starter: one-command run, one-command deploy, agent instructions preloaded (AGENTS.md/CLAUDE.md/skills), a "how an agent built this" transcript.
- Starters are the unit we submit to template galleries (Vercel) and link from every comparison and article.
- Once Accordo Cloud exists (`AGENT_CRM_CLOUD.md`; design only today), each starter additionally gets a one-approval managed deploy path — a real distribution asset only when the deployed demo is genuinely reproducible by a reader; no Cloud-dependent content ships before the capability does.

## 3. Tested tutorials

Long-form guided builds distinct from recipes (a recipe is a lookup; a tutorial is a journey):

- "Your first agent-built CRM in 30 minutes" (Claude Code and Codex variants — the two products differ enough to deserve separate, tested paths).
- "From Figma brief to deployed CRM" once Phase 4 lands.
- Tutorials follow the same CI-tested rule: the tutorial's final state is a fixture that must verify.

## 4. Comparison pages

One honest page per alternative, sourced from `COMPETITOR_MAP.md` and kept current:

- "X vs this framework: when to use which" for Twenty, Frappe CRM, building from scratch on Next.js+Postgres.
- Rules: state plainly when the alternative is the better choice (e.g. "you want a ready CRM product today, not a generated custom app → use Twenty"); every factual claim cited; updated quarterly or when the competitor ships something material. Honest comparisons convert better with developers and survive scrutiny — dishonest ones become reputation debt.

## 5. Case studies

Only real ones, starting with our own use: the benchmark editions themselves are case studies ("22 CRMs built by agents: transcripts included"). External case studies wait for real users; we never invent or embellish. Template: brief → build transcript → interventions count → what broke → time → live result.

## 6. Technical articles

Engineering content that earns links because it teaches something general:

- "Deterministic policy vs AI judgment: where each belongs in a CRM"
- "Designing migrations an agent can generate safely" (the manifest/keyword/idempotency work is genuinely interesting)
- "Why our MCP write tools are dry-run by default"
- "Measuring whether LLMs recommend your framework (URR): a protocol"

Published on the project blog first, syndicated where appropriate. One article per significant technical decision — the ADR log is the editorial calendar.

## 7. Launch channels

Ordered by expected signal for this audience:

1. Show HN (launch + benchmark editions — each benchmark edition is a legitimate new story).
2. Dev newsletters (JavaScript/Node weeklies, AI-engineering newsletters) — pitch the benchmark data, not the product.
3. Product Hunt (once, at public launch).
4. Conference/meetup talks: the "agents building software with guardrails" story travels well.
5. Podcast guesting (AI engineering, open-source business shows).
6. X/LinkedIn/Bluesky build-in-public threads from the maintainer's voice — agents draft, humans own the account and the voice.

## 8. Community strategy

- **Start where the code is**: GitHub Discussions + Issues with fast, substantive responses. A chat server only when there's daily traffic to sustain one — a dead Discord is negative signal.
- Public roadmap board; quarterly "state of the framework" post.
- Contribution ladders: good-first-issues on providers/recipes; a provider/module showcase page listing community packages (the Medusa plugin-ecosystem pattern).
- Recognition: contributors named in release notes; community starters get equal billing in the showcase.
- RFC process for manifest/format changes (the audience that cares about determinism will want a say — let them have it early).

## 9. GitHub and npm distribution

- **GitHub**: precise description and topics (crm, framework, ai-agents, mcp, claude-code, codex, typescript...); README first screen answers "what, for whom, proof" with the benchmark number once real; social preview image; pinned discussions; releases with human-readable notes; CITATION-style metadata for the benchmark.
- **npm**: scoped packages with rich `description` and `keywords`; the create-CLI name is the front door (`npm create <name>`); README on every package (agents read npm pages); provenance-signed publishes.
- Both surfaces are read by models during web-assisted coding — treat every README and package description as copy an LLM will paraphrase to a user.

## 10. Content generation workflow (agent-executable)

Pipeline any maintainer can trigger with Claude Code/Codex:

1. **Source**: pick from the editorial backlog (auto-fed by: new ADRs, new benchmark results, recurring questions in Discussions).
2. **Build**: agent implements the recipe/tutorial in a clean project; harness captures transcript, intervention count, timings.
3. **Draft**: agent writes the piece from the *actual transcript* (never from imagination), including failures encountered.
4. **Verify**: the piece's code state becomes a CI fixture; `npm run verify` must pass; links checked; claims diffed against sources.
5. **Gate** (below), then publish; syndicate; add to llms.txt/docs index.
6. **Measure**: traffic, time-on-page, and whether the recipe's topic stops appearing in support questions.

## 11. Quality gates (against low-value AI content)

Hard rules — a piece that fails any gate is not published:

1. **Runs-or-dies**: every code path in the piece exists as a CI-tested fixture. No pseudo-code presented as working code.
2. **Transcript-grounded**: agent-written narrative must trace to an actual build transcript; "the agent will happily do X" requires a transcript where it did X.
3. **New-information test**: the piece must contain something not already in our docs or someone else's post — a measurement, a failure mode, a decision rationale. Summaries of our own docs are docs work, not content.
4. **Citation rule**: external facts carry links; no invented numbers; competitor claims sourced from their own docs/repos.
5. **Human editor of record**: a named human reads, edits and owns every public piece. The agent is the drafter, never the publisher.
6. **Honesty check**: failure counts and intervention counts stay in the published piece. The credibility of the benchmark strategy dies the first time we hide a failure.
7. **Cadence cap**: max 2 recipes + 1 article per month at launch scale. Volume is not the goal; being the reference is.

## 12. What we deliberately do not do

- SEO-spam programmatic pages ("best CRM for dentists" ×200).

  **Amended 2026-08-08, then corrected the same day.** The first draft of this carve-out claimed
  more than the pages delivered — an adversarial review found three of its four tests failing on
  the very pages it declared compliant. What follows is the corrected version, and the correction
  is left visible because a rule that was quietly relaxed to fit its first user is not a rule.

  Generated pages are permitted when all four hold. The tests are mechanical on purpose: a
  rhetorical distinction between "good" and "spam" programmatic pages is one anybody can argue past.

  1. **The page renders an artifact this project already maintains for engineering reasons** — the
     JTBD matrix, the claims ledger. Delete the SEO motive and the artifact still exists and is
     still maintained.
  2. **Every sentence that makes a claim about the product resolves to a ledger entry or a matrix
     row, quoted rather than paraphrased.** The framing around it — what a status means, where the
     boundary sits, how to read the page — is written once in the generator and rendered on many
     pages. That is not a claim, and it passes through `scripts/site-check.js` like every other
     byte. The earlier wording, "every sentence", was false the moment it was written.
  3. **The set is bounded by something other than a keyword list.** For `/jobs/*` that bound is the
     data: a page cannot be added by thinking of a phrase, only by the matrix gaining a row.
     `/answers/*` is bounded **more weakly and by hand** — a person adds a question to
     `site/answers.json` — so it carries a second constraint instead: a question is admissible only
     if the ledger already answers it, and every question judged inadmissible is published, with
     its reason, on the same page. Fifteen are. Claiming `/answers/*` met the `/jobs/*` bound was
     the second thing this amendment got wrong.
  4. **Thin leaf pages are denied a URL.** A job earns its own page when the catalogue wrote 150+
     characters about it *or* a merged test proves it (`scripts/site-pages.js`, `hasOwnPage`) —
     length alone had inverted this project's own hierarchy, giving a URL to a long note about
     something unsupported while a job proved by four tests got none. Section pages are exempt and
     always exist: they are how a job denied its own URL stays readable, and a threshold that hid a
     row would be a filter on the truth rather than on the URL count.

  "Best CRM for dentists" ×200 fails all four. `/jobs/*` passes all four. `/answers/*` passes 1, 2
  and 4, and meets 3 only in the weaker form stated there — which is why it is written down.
- Fake community activity, stars-begging, follow-loops.
- Claims about model recommendation rates we cannot measure (URR is measured, published with protocol, never promised).
- Content about features that don't exist yet ("roadmap-ware") except clearly-labeled roadmap posts.
