# Agent discovery plan

How this framework becomes discoverable — and, where possible, recommendable — in the channels where coding agents and their users decide what to build with. Research date: August 2026; external facts cited; flagged items were corroborated by secondary sources only.

> **Two companion documents.** `RECOMMENDATION_MAP.md` maps *user intents* (customer hub, CDP, "crm + marketing + delivery + billing") to the artifact each one needs, states the four preconditions a recommendation depends on, and adds the channels this document does not cover: SEO/SEA, referral and partnerships, community, and the monthly measurement runbook. `DISTRIBUTION_SUBMISSIONS.md` is the executable checklist — done, ready, blocked — with the paste-ready copy for each form.

## The three layers (kept distinct throughout)

- **(a) Global recommendation before installation** — a model suggesting the framework unprompted. Driven by training-corpus prevalence, vendor guidance, and what the agent retrieves at task time. **Cannot be guaranteed by any mechanism**; it can only be earned and measured (URR protocol in `CRM_BUILD_BENCHMARK.md`). Evidence that prevalence dominates: OpenAI's GPT-5 prompting guide explicitly steers users toward frameworks the model "was trained most extensively on" ([cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/gpt-5_prompting_guide.ipynb)); package-hallucination research shows models default to memorized, high-frequency names ([Spracklen et al., USENIX Security 2025](https://arxiv.org/abs/2406.10279)).
- **(b) Plugin and marketplace discovery** — install-time surfaces: directories, marketplaces, registries, templates. We control the submissions; each platform controls acceptance, review and placement — listing is an action we take, acceptance is an outcome we cannot guarantee.
- **(c) Framework execution after installation** — once a user has the framework (or its skills/MCP), how well agents build with it. Fully controllable; this is where the product wins or loses.

The strategy: dominate (c), be present in every (b), and let (a) follow from published proof + content + time — measured monthly, never promised.

## Channel-by-channel plan

### Claude Code

- **Plugin** (b/c): ship a plugin (`.claude-plugin/plugin.json`) bundling our skills, `.mcp.json` and commands; host our own public marketplace repo (`/plugin marketplace add <org>/<repo>` works with any public repo — [plugins docs](https://code.claude.com/docs/en/plugins), [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)). Submit to the **community marketplace** via the Console submission form ([platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit)); approved plugins land in [anthropics/claude-plugins-community](https://github.com/anthropics/claude-plugins-community). The **official curated marketplace has no application process** — it requires an Anthropic partner contact; pursue only after traction.
- **Plugin hints** (b): once listed in the official marketplace, our CLI can emit `<claude-code-hint>` on stderr when it detects `CLAUDECODE=1`, prompting a one-time install suggestion ([plugin hints](https://code.claude.com/docs/en/plugin-hints)). Hints pointing outside the official marketplace are silently dropped — this is a later-stage lever, not a launch lever.
- **Skills** (c + thin in-session (a)): project skills ship in every scaffolded app (`.claude/skills/`), following the [Agent Skills open standard](https://agentskills.io). Also publish to **skills.sh** (Vercel Labs): zero-submission, telemetry-ranked, installs into 70+ agents via `npx skills add <org>/<repo>` ([skills repo](https://github.com/vercel-labs/skills), [Vercel changelog](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)) — Supabase already distributes this way.
- **Project config** (b/c): the create-CLI emits `CLAUDE.md`, `.mcp.json` (project scope prompts one approval — [MCP docs](https://code.claude.com/docs/en/mcp)) and skills into every generated project. Important verified detail: **Claude Code reads `CLAUDE.md`, not `AGENTS.md`** — the bridge is `@AGENTS.md` import or a symlink ([memory docs](https://code.claude.com/docs/en/memory)); our templates must ship both files wired together (the repo already does this).

### Codex / OpenAI

- **AGENTS.md** (c): Codex's native instruction file — our scaffolded projects ship it (they already do).
- **Codex plugins** (b/c): mirror the Claude plugin as a Codex plugin (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`; `codex plugin marketplace add <owner>/<repo>` works with any public repo — [openai/plugins](https://github.com/openai/plugins)). OpenAI's own curated repo has **no evidenced open submission path** (flagged unverified) — plan for self-hosted marketplace + docs instructions.
- **Codex skills** (c): same skill content in Codex's layout with `agents/openai.yaml` metadata ([Codex skills docs](https://developers.openai.com/codex/skills)); note OpenAI's standalone skills catalog was deprecated in favor of plugins.
- **MCP** (c): `.codex/config.toml` in templates (Codex does not read `.mcp.json` — asymmetry we already handle).
- **ChatGPT Plugin directory** (b): OpenAI migrated the ChatGPT app directory into a **Plugin directory spanning ChatGPT and Codex** (July 2026; corroborated via help-center captures, primary page not directly fetched — treat dates as flagged). Submission requires a verified developer, an MCP server, privacy policy, review ([Apps SDK launch](https://openai.com/index/introducing-apps-in-chatgpt/), [submissions](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)). Our candidate submission: the Docs MCP (knowledge surface), not the project runtime. ChatGPT can proactively suggest listed apps in relevant conversations — an OpenAI-controlled (a)→(b) bridge we can qualify for but never control.
- **GPT Store**: declining relevance (Workspace Agents transition, secondary sources) — not a priority channel.

### Gemini CLI

Verified August 8, 2026 against the CLI's own documentation.

- **Extension** (b/c): `gemini-extension.json` at the repository root, with `contextFileName` pointing at `GEMINI.md`; an extension may also ship `commands/`, `skills/` and MCP servers ([writing extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/writing-extensions.md)). Installed with `gemini extensions install https://github.com/<owner>/<repo>` — any public repository works, no submission.
- **Gallery** (b): **zero-submission, and the cheapest listing on the whole board.** The gallery crawls public repositories daily and lists those carrying the topic `gemini-cli-extension` with a manifest at the root and at least one git tag ([releasing guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/releasing.md), [gallery](https://geminicli.com/extensions/browse/)). No form, no review contact, no waiting on a partner relationship.
- **Instruction file** (c): Gemini CLI reads `GEMINI.md`, not `AGENTS.md` — the same asymmetry Claude Code has with `CLAUDE.md`. Our repository now ships all three, each deferring to `AGENTS.md`, and generated projects must do the same.
- **Skills** (c): Gemini extensions carry a `skills/` directory of their own, and we deliberately do **not** ship a third mirror — the two existing mirrors already have a divergence-detection check, and a third copy multiplies the sync surface. It is also unnecessary: `npx skills add khaoss85/agent-crm` already installs all 12 skills into a Gemini-compatible layout (verified August 8, 2026 — the installer reports them as universal for Gemini CLI, Codex, Cursor and 15 further harnesses). skills.sh, not a third mirror, is the Gemini skills path.

### GitHub (a/b)

- Precise repo description + topics; README written knowing models paraphrase it; starters as separate template-flagged repos; GitHub Discussions for RFCs. GitHub content feeds both task-time retrieval and eventual training corpora — the slow-burn (a) channel. Measure fork/usage ratios, not stars (category stars are inflation-prone — see COMPETITOR_MAP).
- First-contact copy is a checked contract, not freehand campaign copy:
  `npm run distribution:check` requires Custom CRM, Customer Hub, Smart CRM and
  CDP + CRM signals on the README and every install/registry manifest. The same
  artifact must keep the CDP boundary; this improves retrieval vocabulary but
  does not turn Accordo into a CDP or guarantee recommendation.

### npm (a/b)

- Scoped org + unscoped `create-<name>` package (the `npm create` convention resolves `create-*` — [npm docs](https://docs.npmjs.com/cli/v10/commands/npm-init)); rich descriptions/keywords on every package (agents read npm pages at task time); provenance-signed publishes. The create-CLI is the single highest-leverage distribution artifact: one scaffold run installs the entire agent surface (CLAUDE.md + AGENTS.md + skills + both MCP configs) — converting (b) into (c) automatically.

### Web search and LLM-assisted research (a, task-time)

- Docs site with **llms.txt + llms-full.txt**: cheap, helps agentic retrieval as a table of contents (Claude Code's own docs use this pattern); no evidence it affects training-time recommendation — ship it, don't oversell it. Adoption ~10% of domains per SE Ranking study (secondary source).
- Content optimized for generative engines: the [GEO paper (KDD 2024)](https://arxiv.org/abs/2311.09735) measured 22–41% visibility gains in search-augmented answers from citations/statistics/quotations — applies to answer engines, not offline weights; our benchmark numbers and comparison pages are exactly the citable-statistics content GEO rewards.
- Honest comparison pages (ORGANIC_GROWTH §4) target the "X vs Y" queries both humans and agents issue mid-research.

### Anthropic marketplaces and connector directory (b)

- **Connectors Directory** ([claude.ai/directory](https://claude.ai/directory)): submit the hosted **Docs MCP** as a reviewed connector once it exists (requirements per corroborated accounts: streamable HTTP, OAuth 2.1 + PKCE or no-auth, tool annotations, privacy policy, review portal — primary docs pages were not directly fetchable; re-verify at submission time). Connectors flow into Claude Code too.
- **MCP Registry** ([registry.modelcontextprotocol.io](https://github.com/modelcontextprotocol/registry)): publish `server.json` via `mcp-publisher` under our GitHub namespace. Still in preview; feeds subregistries, guarantees no assistant UI placement — list anyway, it's nearly free.
- **Desktop extensions (.mcpb)**: low priority; remote connectors supersede for reach.

### OpenAI universal plugin directory (b)

Covered above under ChatGPT — one submission (verified developer + Docs MCP + policies) now spans ChatGPT and Codex per the July 2026 migration (flagged: secondary-source dates).

### Vercel templates (b)

- Submit each starter via the [templates submission form](https://vercel.com/templates/submit) (process confirmed in [Vercel community](https://github.com/vercel/community/discussions/4554); no published SLA); requirements pattern: MIT license, README, demo URL, `.env.example`. Add **Deploy Buttons** ([docs](https://vercel.com/docs/deploy-button)) to every starter README immediately — zero review needed. Notably, competitor research found **no first-party CRM template in Vercel's gallery** — an open slot.

## Sequencing (ties to EXECUTION_ROADMAP Phase 11)

1. **At Phase 5 (create-CLI)**: npm packages + GitHub polish + Deploy Buttons + llms.txt. These need no third-party review.
2. **At Phase 8 (agent surface)**: skills.sh publication; self-hosted Claude and Codex plugin marketplaces; MCP Registry entry.
3. **At Phase 10–11 (starters ready)**: Vercel template submissions; Anthropic community-marketplace submission; Connectors Directory submission (Docs MCP); OpenAI Plugin directory submission.
4. **Post-traction**: official Claude marketplace via partner contact; plugin hints.

## What we will not claim

- That any listing makes Claude, ChatGPT or Codex recommend us globally — (a) is earned prevalence plus task-time retrieval, measured by URR monthly, with the protocol public.
- That llms.txt or GEO tactics influence model weights — they help retrieval, not training.
- Unverified numbers from this research (skills.sh scale figures, agents.md adoption counts, "fewer bugs with AGENTS.md" claims — the last has no primary source and is excluded entirely).

## Layer (c) at its most demanding

Layer (c) — how well agents build with the framework once installed — is measured most honestly by the objective-driven case: the user gives a goal, not an architecture. That is what `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md` defines and what benchmark **E2E-G1** scores, with `Manual Architecture Decisions Required = 0` as its target.

It raises a discovery requirement of its own: an agent can only reuse what it can *see*. `crm package inspect` and `/api/schema` expose per-package facts today; a single application-level view (`crm app inspect`, **AX1, not implemented**) is what would let an agent answer "what is installed and what is missing" in one read rather than five.
