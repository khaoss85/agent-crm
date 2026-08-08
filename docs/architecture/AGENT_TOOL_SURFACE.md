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
| **U — Unverified** | believed, from a secondary source, and **not** an official fact. Never quote it as one |
| **B — Framework inference** | what follows *for this repository* from the facts in A. Reasoning, not vendor policy |
| **C — Proposed policy** | what this repository should do. **Not implemented, not decided** |

Section **U** exists because deleting a weak claim and silently keeping the
policy it inspired is worse than labelling it. Nothing in B or C may lean on U.

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

---

## U — Unverified: Codex, secondary sources only

**Nothing in this section is an official fact, and none of it may be quoted as
one.** It is kept, rather than deleted, so a future reader knows what was
believed and exactly how weak the evidence was.

**Verification attempts, 2026-08-07, all failed from this environment:**

| Attempted | Result |
|---|---|
| `https://developers.openai.com/codex/mcp` | blocked by this environment's network egress proxy |
| `https://raw.githubusercontent.com/openai/codex/main/docs/mcp.md` | 404 |
| `https://raw.githubusercontent.com/openai/codex/main/docs/advanced.md` | 404 |
| `https://raw.githubusercontent.com/openai/codex/main/README.md` | fetched; no MCP or configuration content |
| `openai/codex` → `docs/config.md`, via raw and via the blob view | fetched; the string `mcp_servers` was not found in what came back |

What remains is search-engine summaries of the first-party pages, plus public
issues in the `openai/codex` repository. Treated as **claims**, not facts:

| Claim | Source class |
|---|---|
| MCP servers are configured in TOML under an `[mcp_servers]` table, in `~/.codex/config.toml`, with per-project `.codex/config.toml` for trusted projects | summary of a first-party page, not read directly |
| `codex mcp add <name> --env K=V -- <command>` adds a stdio server | summary of a first-party page |
| Codex can itself run as an MCP server (`codex mcp-server`) | summary of a first-party page |
| Codex reads an MCP server's `instructions` field, advising that the first 512 characters be self-contained | summary only — the number is **not** verified and nothing here depends on it |
| a streamable-HTTP server uses a `url` key, behind `experimental_use_rmcp_client` | repository issues — the weakest class |
| keys such as `startup_timeout_sec`, `tool_timeout_sec`, `bearer_token_env_var` | repository issues |
| `AGENTS.md` is the instruction file Codex reads | independently true of this repository, which ships one |
| a stated tool-count cap | **not found.** Absence of evidence, not evidence of absence |

**No policy in section C depends on any of the above**, and in particular no
rule anywhere in this repository depends on an unverified numeric threshold. The
one Codex-shaped fact this repository does rely on — that `AGENTS.md` is read —
is verified by the repository's own use of it, not by this table.

**Before anything is built against Codex**, re-run the table above from an
environment that can reach `developers.openai.com`, and move whatever verifies
into section A with its retrieval date.

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
- For Codex no cap was found either — but from **secondary sources only** (section U), so it is recorded as "not found", never as "none exists".

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

### C.0 The shape of the surface, before any tool exists

Nine commitments, in the order they constrain a design. They are **policy**, not
implementation, and none of them is a guarantee about a model's behavior.

| | Commitment |
|---|---|
| 1 | **CLI-first.** The CLI is the contract; any tool surface mirrors it. A harness with no MCP loses convenience, never capability |
| 2 | **A capability is not a tool.** `delivery-change-management@1` exists so *packages* can read each other. Exposing it as a tool would publish an internal seam as a public verb |
| 3 | **A package is not a tool.** Adding a package must not add tools. Otherwise the surface grows with the domain model, which is exactly backwards |
| 4 | **Tools are job-oriented.** A tool answers a question somebody actually has — "what is this application", "is this plan still true" — not "call this method" |
| 5 | **A small always-on discovery and solution surface.** Enough to find everything else. The design target is **3–5 always-on families**; a target, not a promise |
| 6 | **Domain namespaces are deferred and searchable**, not resident. Compact namespaces are a design target too |
| 7 | **Read is separated from mutation** at the surface, not only in the docs. A read tool that can write is a write tool |
| 8 | **The allow-list is dynamic**, derived from the goal, the plan and the actual composition — never a static union of everything installed |
| 9 | **Sensitive mutation requires human approval**, per call, never a blanket allow |

Three things this repository will not claim about that surface:

- **No flat MCP surface** that exposes every package method as a tool. Point 3
  is the whole reason.
- **No Project MCP exists.** DX13 is unbuilt. Describing its shape is not
  describing a product.
- **Remote mutation stays gated by the Production Spine.** Without auth, tenancy
  and RBAC there is nobody to authorize a remote write, so the gate is an
  absence of meaning rather than a missing feature.

**On multiple providers of one capability.** Capability providers in this
repository are **singleton**: one package provides `delivery-obligations@1`, and
the registry resolves one edge. Nothing in the current package graph supports two
packages competing to provide the same capability, and no document here should
imply otherwise. A future world with several interchangeable channel or provider
implementations needs an explicit provider **registry with instances** — a
design that does not exist — or it stays future work. A tool surface must not be
designed as if that already resolved.

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
| `package_inspect` | T0 | `crm package inspect` — shipped as a CLI today |
| `package_scaffold` | T0 / **T2** | DX3 `crm package scaffold` — shipped as a CLI today. **T0 as a plan, T2 with `--apply`** |
| `package_test` | **T1** | DX4 `crm package test` — shipped as a CLI today |
| `explain` | T0 | DX8, not built |
| `doctor` | T0 | DX1, not built |
| `change_inspect` | T0 | DX7, not built |
| `context_pack` | T0 | DX9, not built — advisory only, never authorization |
| `verify` | T1 | DX5, not built |
| `scenario` | T1 | DX6, not built |
| `trace_query` | T1 | DX16 — **Production-Spine gated** |

`package_test` is the one **T1** entry that is already built, and the tier is the
point: it is read-only about the caller's project — it writes nothing there and
opens no database — but it copies the project, applies module manifests into
that copy and **boots an application twice**. Unlike every T0 entry it consumes
real time and real disk, and it runs the package's own code. A blanket allow on
something that executes checked-in source is a different decision from a blanket
allow on something that reads it, so the tiers differ even though neither
mutates the project.

`package_scaffold` is the one entry whose tier **depends on its arguments**, and
that is the argument for keeping the two modes one tool rather than splitting
them. Without `--apply` it is a pure planner: it writes nothing, opens nothing
and reads only the target directory, so it is T0 for the same reason
`package_inspect` is. With `--apply` it creates files in the caller's own
repository, which is a T2 mutation no matter how small. The mapping that follows
is: **the tool defaults to the plan**, `apply` is an explicit boolean the caller
must set, and a host that grants the namespace broadly is granting the planner,
not the writer. That mirrors `crm_scaffold_module`, the one existing MCP tool
with the same shape, whose server instructions already say *code scaffolding is
dry-run unless apply is explicitly true*.

Its refusals are part of the contract an agent depends on: an occupied target,
an invalid name and a path that leaves the project are all refused with a code
and exit 1, and the plan carries a `fingerprint` so a caller can tell "the same
scaffold" from "a different one". Nothing about it is remote — there is no
registry, install or publish — so it needs no Production-Spine gate.

The `package` namespace stays **deferred and searchable** rather than
always-loaded: four commands that only matter while somebody is authoring a
package should not occupy the surface of every session. `app_inspect` remains
the tool an agent reaches for first.

Two properties this table is designed to have. Most of the surface is **T0**,
which is what makes it safe to expose broadly and cheap to keep correct. And
every entry is a **mirror of a stable CLI contract**, not a second implementation
— an MCP tool that reimplements a CLI is a second thing to keep true.

**Remote mutation stays Production-Spine and human-approval work**, exactly as
the roadmap says. That is not a scheduling statement: there is no auth, tenancy
or RBAC, so there is no one to authorize a remote write.

### C.2b A domain namespace, worked through on Service (M15)

Nothing below exists. **No MCP tool is implemented for the Service package, and
none is proposed for this milestone.** This section exists because M15 is the
first package whose actions a reader would plausibly want as tools, and the
useful moment to decide the *shape* of a domain namespace is before anybody
writes one.

A domain namespace mirrors the package's own action names, one to one, so there
is nothing to keep true twice:

| Proposed tool | Tier | Mirrors the action |
|---|---|---|
| `service.plan_activation` | T0 | `commercial-contract.plan-service-activation` |
| `service.activate` | T2 | `commercial-contract.activate-service` |
| `service.create_case` | T2 | `service-entitlement.record-service-case` |
| `service.transition_case` | T2 | `support-case.transition-case` |
| `service.evaluate_sla` | T0 read / T2 record | `support-case.preview-sla` / `record-sla-evaluation` |
| `service.record_escalation` | T2 | `support-case.record-escalation` |

Three rules fall out of the tiering, and they are the point of the table:

- only **`service.plan_activation`** and the read half of
  **`service.evaluate_sla`** are T0. Both are read-only in the package itself,
  both already refuse to write, and both are open to an agent actor today.
- everything else is **T2 — bounded write**, which under §C.1 means explicit
  per-call approval and never a blanket allow. That is not a policy invented
  here: the package already refuses an agent actor on all six writes with
  `403 HUMAN_APPROVAL_REQUIRED`, so a T2 tool that carried an agent identity
  would simply be refused by the server. The tier records *why* the tool must
  carry a human's identity, not a bot's.
- there is deliberately **no `service.end_coverage`, no `service.close_case` and
  no `service.record_activity`** in the proposed surface. Ending a coverage and
  closing a case are the two irreversible-looking moves in the domain, and
  recording activity is the one an agent could use to manufacture history. They
  stay human, in the Admin or the CLI, until there is somebody to authorize
  them.

The same shape would apply to Delivery and Contracts. It is written down once,
here, rather than three times in three packages.

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
