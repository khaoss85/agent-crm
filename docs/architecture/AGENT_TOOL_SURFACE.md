# Agent tool surface

**Status: strategy and proposed policy. Nothing here is implemented.** No tool
runtime, MCP runtime or harness adapter changes in the PR that introduced this
document. It exists so the surface is designed before it is built, and so the
next person who builds it argues with a written position instead of inventing
one.

Companion documents: `docs/AGENT_HARNESS_COMPATIBILITY.md` (what a harness needs
to use AX1 and AX2 today), `docs/MCP.md` (the MCP server that actually ships),
`docs/CODER_TOOLING_ROADMAP.md` (the DX identifiers this references).

## How to read this document

Every claim below is in exactly one of three sections, and the section is the
claim's warranty:

| Section | Means |
|---|---|
| **A — Official facts** | stated by the vendor's own current documentation, quoted, with the URL and the date it was read |
| **B — Framework inference** | what follows *for this repository* from those facts. Reasoning, not vendor policy |
| **C — Proposed policy** | what this repository should do. **Not implemented, not decided** |

Mixing the three is how a strategy document becomes a false claim about
somebody else's product. If a fact below cannot be re-verified at its URL, treat
it as expired rather than as true.

---

## A — Official facts

All retrievals: **2026-08-07**, from this repository's network environment.

### A.1 Claude Code

Source: <https://code.claude.com/docs/en/mcp>, retrieved 2026-08-07.

| Fact | Exact wording where it matters |
|---|---|
| tool-count cap | *"Claude Code doesn't impose a fixed per-server tool cap; the practical limit is your context window budget."* |
| default loading | tool search is **on by default**: *"Only tool names and server instructions load at session start, so adding more MCP servers has minimal impact on your context window."* |
| threshold mode | `ENABLE_TOOL_SEARCH=auto` loads schemas *"upfront when they fit within 10% of the context window"* and defers the overflow. `auto:N` sets the percentage; `false` loads everything upfront |
| description budget | *"Claude Code truncates tool descriptions and server instructions at 2KB each."* Critical detail goes first |
| server instructions | with tool search on, they are what tells the model *when to search* for a server's tools — the doc compares their role to Skills |
| transports | stdio, HTTP (`streamable-http`), SSE (**deprecated**, "use HTTP servers instead"), WebSocket |
| scopes | `local` (default, this project, private), `project` (`.mcp.json`, shared with the team), `user` (all projects) |
| approval | project-scoped `.mcp.json` servers show as *"Pending approval"* until approved interactively, and a cloned repository *"can't approve its own servers"* — committed approval settings are ignored in an untrusted folder |
| tool naming | `mcp__<server>__<tool>`; plugin-bundled servers register as `plugin:<plugin>:<server>` |
| output bounds | a warning above **10,000 tokens** of MCP tool output, limited to **25,000 tokens** by default (`MAX_MCP_OUTPUT_TOKENS` raises the limit; the warning threshold is fixed) |
| model dependency | tool search *"requires a model that supports `tool_reference` blocks"* — the doc names Claude Sonnet 4.5, Haiku 4.5, Opus 4.5 and later, and lists hosting environments where it is unavailable |

### A.2 Gemini CLI

Source: <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>,
retrieved 2026-08-07.

| Fact | Detail |
|---|---|
| configuration | the `mcpServers` object in `settings.json` |
| transports | stdio (`command`), SSE (`url`), streamable HTTP (`httpUrl`) |
| tool filtering | `includeTools` (allow-list) and `excludeTools` (deny-list); **`excludeTools` takes precedence** |
| approval | per-server `trust: true` *"bypasses all tool call confirmations for this server"*; otherwise the user chooses "Proceed once", "Always allow this tool" or "Always allow this server" |
| tool naming | every MCP tool gets a fully qualified name `mcp_{serverName}_{toolName}`; the docs warn **not to use underscores in server names**, because the parser splits on the first underscore after `mcp_` |
| tool-count cap | **none stated** |

Context file: Gemini CLI reads a project-root **`GEMINI.md`** (and also accepts
`AGENT.md`) as persistent instructions. Retrieved 2026-08-07 via Google's Gemini
CLI documentation.

> **This does not authorize writing a Gemini Skill file.** `docs/AGENT_HARNESS_COMPATIBILITY.md`
> is right that a skill file in the wrong shape is worse than none, because it
> looks supported and silently never loads. A *context* file and a *skill* file
> are different mechanisms, and only the first is confirmed above. DX2 owns the
> verification.

### A.3 Codex

**Read this section's warranty first.** `developers.openai.com` — the first-party
documentation host — is **blocked by this environment's network egress proxy**,
so the facts below could not be fetched directly. They come from search-engine
summaries of those official pages plus the public `openai/codex` repository, on
2026-08-07. They are **second-hand and must be re-verified from an environment
with access** before any of them is built against.

| Claim | Confidence |
|---|---|
| MCP servers are configured in TOML under an `[mcp_servers]` table, in `~/.codex/config.toml`, with per-project `.codex/config.toml` for trusted projects | high — consistent across independent sources |
| `codex mcp add <name> --env K=V -- <command>` adds a stdio server | high |
| Codex can itself run as an MCP server (`codex mcp-server`), which is how the Agents SDK drives it | high |
| Codex reads an MCP server's `instructions` field as server-wide guidance, and advises keeping *"the first 512 characters self-contained"* | medium — quoted in a summary of the official page, not read directly |
| keys including `startup_timeout_sec`, `tool_timeout_sec` and `bearer_token_env_var` exist | **low** — sourced from repository issues, not documentation |
| `AGENTS.md` is the instruction file Codex reads | high — and independently true of this repository, which already ships one |
| a stated tool-count cap | **not found**; absence of evidence, not evidence of absence |

---

## B — Framework inference

### B.1 The tool-count question, answered without a myth

A specific number — most often "30 tools" — circulates as if it were a property
of every model. **This document does not make that claim, and no source above
supports it.** What the sources actually say:

- Claude Code states there is **no fixed per-server cap**, and that the binding
  constraint is the context budget — which its default deferred loading largely
  removes.
- Gemini CLI states **no cap**, and ships `includeTools`/`excludeTools` because
  operators want to narrow a surface for their own reasons.
- For Codex, no cap was found, from sources that could not be read directly.

The honest generalization is about **cost and confusion, not a ceiling**: a large
tool surface competes for context and for the model's attention, and near-duplicate
tools make a worse choice more likely. Any specific number is a property of one
harness, one model and one configuration, and belongs in a changelog with a date
— never in a design rule.

**Rule for this repository:** never write a numeric tool limit into a design
document or a contract. Design for *the smallest surface that answers the job*,
which is correct under every reading above, and cite a number only with its
source and retrieval date.

### B.2 What the harness facts actually change for us

1. **The CLI is the portable surface; MCP is an optimization.** Every fact above
   is about MCP. `docs/AGENT_HARNESS_COMPATIBILITY.md` establishes that AX1 and
   AX2 need only a shell, an exit code and JSON. That stays the floor: a harness
   with no MCP support must lose nothing but convenience.
2. **Server instructions carry more weight than tool descriptions.** Under
   deferred loading, the instructions field is what makes a tool findable at all,
   and Claude Code truncates it at 2KB. A server whose instructions are a feature
   list is invisible; one whose instructions say *when to reach for it* is not.
3. **Descriptions are a hard budget, not prose.** 2KB per description, first
   sentence load-bearing.
4. **Names are namespaced by the harness, differently.** `mcp__server__tool`
   versus `mcp_{server}_{tool}`. Underscores in a server name break Gemini's
   parser. A server name must therefore be short, lowercase and **underscore-free**
   — `agent-crm`, never `agent_crm`.
5. **Approval is the harness's, not ours.** Claude Code gates project-scoped
   servers behind interactive approval and refuses a cloned repository's own
   committed approvals; Gemini has per-server `trust`. A tool that is dangerous
   only because an operator clicked "always allow" is a tool we designed wrong.
6. **Output is bounded.** A tool that can return a whole inspection report will
   be truncated. Any read tool must have a bounded, paginated or summarized mode,
   and must say what it omitted.

### B.3 Read the shape of our own surface honestly

What ships today (`docs/MCP.md`): nine tools, five resources, two prompts, over
newline-delimited JSON-RPC on stdio. Of the nine, two are CRM writes
(`crm_create_opportunity`, `crm_request_stage_change`), one is a human decision
(`crm_decide_approval`), one is code-generating (`crm_scaffold_module`,
dry-run by default), and the rest are reads.

That surface predates AX1, AX2 and the package seam. It exposes a *sample*
domain — opportunities and approvals — rather than the framework's actual
contracts. An agent asking "what is this application, and what may I do to it"
gets a better answer today from `crm app inspect` than from any of the nine.

---

## C — Proposed policy

**Nothing in this section exists.** No tool listed here is implemented, and
listing one is not a commitment to build it.

### C.1 Four tiers, and the rule that assigns them

| Tier | Definition | Exposure |
|---|---|---|
| **T0 — Describe** | reads checked-in source; opens no database, contacts nothing | freely exposed, no approval needed |
| **T1 — Read state** | reads the configured database, read-only | exposed; bounded output; never returns a secret or a raw row |
| **T2 — Bounded write** | one declared action through a module service, with actor, validation, audit and trace | exposed only with explicit per-call approval, never with a blanket allow |
| **T3 — Generate or destroy** | writes source, applies a migration, deletes | **dry-run by default**, explicit apply, never auto-approved |

The rule: **a tool's tier is decided by what it can do, not by what it is
expected to do.** A read tool that can be pointed at an arbitrary path is T3.

### C.2 The surface this repository should offer, once DX13 exists

`docs/CODER_TOOLING_ROADMAP.md` already names this as **DX13 (Project MCP
parity)** and gates remote mutation on the Production Spine. Restated as a
surface rather than a list of commands:

| Proposed tool | Tier | Mirrors |
|---|---|---|
| `app_inspect` | T0 | AX1 — shipped as a CLI today |
| `solution_check` | T0 | AX2 — shipped as a CLI today |
| `explain` | T0 | DX8, not built |
| `doctor` | T0 | DX1, not built |
| `change_inspect` | T0 | DX7, not built |
| `context_pack` | T0 | DX9, not built — advisory only, never authorization |
| `verify` | T1 | DX5, not built |
| `scenario` | T1 | DX6, not built |
| `trace_query` | T1 | DX16 — **Production-Spine gated** |

Two properties this table is designed to have. Most of the surface is **T0**,
which is what makes it safe to expose broadly and cheap to keep correct. And
every entry is a **mirror of a stable CLI contract**, not a second implementation
— an MCP tool that reimplements a CLI is a second thing to keep true.

**Remote mutation stays Production-Spine and human-approval work**, exactly as
the roadmap says. That is not a scheduling statement: there is no auth, tenancy
or RBAC, so there is no one to authorize a remote write.

### C.3 The existing tools

The nine tools in `docs/MCP.md` are not deprecated by this document and nothing
here removes them. What this document proposes is that any future work on them
answers, per tool: which tier it is, which stable contract it mirrors, and
whether an agent would reach for it over `app inspect`. A tool that fails all
three is a candidate for removal — a decision for a human, in its own PR, with
its own review.

### C.4 What must never become a tool

- anything that **executes a Solution Plan**, or applies a diff derived from one;
- anything that runs a command string supplied by a model;
- anything that installs a package or a provider from the network;
- anything that deploys, or that reports authorization state, before the
  Production Spine exists;
- anything that returns a secret, a credential, a provider configuration or raw
  personal data;
- anything whose safe operation depends on the operator not having clicked
  "always allow".

These are the same refusals as `docs/CODER_TOOLING_ROADMAP.md`, restated at the
tool boundary because that is where somebody would be tempted.

### C.5 Cross-harness rule

One surface, adapted, never forked. A harness adapter may change **where a file
lives, how a server is registered and how a tool is named**. It must never
change **what a tool does, what it refuses or what it says** — the moment two
harnesses disagree on that, they are two products.

Skills follow the same rule and are tracked separately as **DX2**: one canonical
semantic source, deterministic adapters, a drift check in `verify`. Today the
`.claude/` and `.agents/` copies are byte-identical **by hand**, enforced by
`scripts/check.js`. No Gemini skill file exists, and none is written by guessing.

---

## Open questions, which are the honest output of this document

1. **Codex, first-hand.** Everything in A.3 needs re-verification from an
   environment that can reach `developers.openai.com`. Nothing should be built
   against it until then.
2. **Gemini skills.** A context file is confirmed; a *skill* mechanism is not.
   DX2 verifies it or the answer stays "not supported".
3. **Whether an MCP surface is wanted at all.** The CLI is portable, testable and
   already sufficient for AX1 and AX2. DX13's value is convenience and discovery;
   the cost is a second surface to keep true. That trade is a human decision.
4. **The fate of the nine existing tools** (C.3) — a human decision, in its own
   PR.

## Evidence

`docs/AGENT_HARNESS_COMPATIBILITY.md`, `docs/MCP.md`,
`docs/APPLICATION_INSPECTION.md`, `docs/SOLUTION_PLAN.md`,
`docs/CODER_TOOLING_ROADMAP.md`, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`.
The vendor sources are cited inline with their retrieval dates; this repository
holds no cached copy of any of them, deliberately.
