# Rename surface

The complete inventory of where the working title lives, grouped by what breaks when it moves.
`scripts/brand-set.js` executes this inventory; the two are meant to be read together, and the
script prints the same groups with the same counts.

```bash
node scripts/brand-set.js <name> [--slug <slug>] [--apply]
```

## What is actually there

The working title appears in five casings, and each one is a different kind of surface:

| Token | Rewritten | What it is |
| --- | ---: | --- |
| `agent-crm` | 152 | npm package name, bin key, two binary filenames, plugin name, MCP server keys, SQLite filename, npm scope |
| `AgentCrm` | 141 | exported identifiers — `createAgentCrmApp` (112), `AgentCrmClient` (35), `AgentCrmDatabase` (3), `AgentCrmAdmin` (1) |
| `Agent CRM` | 75 | display name in prose, including 20 skill descriptions |
| `AGENT_CRM_` | 8 | environment-variable prefix |
| `agent_crm` | 3 | MCP server key in the Codex TOML and Codex plugin configs |

**127 files, 379 occurrences rewritten**, plus 2 file renames and 5 `brand.json` token edits.
A further 45 occurrences are held back on purpose and named in [Held back](#held-back).

Counted with `grep -rIo`, excluding `node_modules`, `.git` and `site/dist`, against `ccdf828`.
The script recomputes all of it on every run — these numbers are a measurement of the tree on
2026-08-07, not a contract. Run the dry run to get today's.

## Groups by blast radius

| Group | Files | Occurrences | What a wrong value costs |
| --- | ---: | ---: | --- |
| cosmetic | 25 | 49 | nothing until someone reads it |
| public-surface | 1 | 5 token edits | nothing — it is one file |
| distribution | 26 | 39 | unrenameable once published |
| code | 76 | 291 | breaks existing checkouts and installed configs |

Plus 2 file renames, in the code group.

### cosmetic — 25 files, 49 occurrences

Prose. `ARCHITECTURE.md`, `PRODUCT.md`, `README.md`, `TASKS.md`, 19 documents under `docs/`, the
starter README, `packages/docs-mcp/README.md`, and two `<title>`-class strings in
`apps/admin/public/index.html`. Wrong here is embarrassing, not breaking, and it is the only group
where a missed occurrence has no consumer.

### public-surface — 1 file, 5 token edits

`site/brand.json`, and nothing else. This is not an estimate: the only match for any name token
anywhere under `site/` or `docs/marketing/` is the GitHub URL in `brand.json`, which is
[held back](#held-back). Every template, partial and marketing document reads the tokens, so the
entire public surface moves in one edit — exactly what `brand.json`'s own `$comment` promises, and
now mechanically verified rather than asserted.

The script writes five fields: `name.status` → `"chosen"`, `name.value`, `name.slug`, `npm.scope`
→ `@<slug>`, `npm.createCommand` → `npm create <slug>`. The last two are pure derivations of the
slug and would otherwise be left contradicting it. `name.note` is human rationale and is not
touched; `domain.value` is a registration, not a derivation, and is not touched either.

This group is already ahead of the others: the founder's decision landed in `brand.json` on
2026-08-07 and nowhere else. The site says one name and the code says another until the rename runs.

### distribution — 26 files, 39 occurrences

**Unrenameable once published.** Nothing here has been published, which is the only reason this
group is still cheap.

- `.claude-plugin/plugin.json` — `name: "agent-crm"` namespaces every skill as `agent-crm:<skill>`.
  Eleven skills carry that prefix into a user's context; renaming after install breaks each of them.
- `.claude-plugin/marketplace.json` — `agent-crm-marketplace` plus the plugin entry name.
- `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` — the same name, and
  `scripts/distribution-check.js` fails the build if the four disagree.
- `gemini-extension.json` — extension name and MCP server key.
- `server.json` — `@agent-crm/mcp`, the npm identifier submitted to the MCP registry. Its `name`
  field is the registry namespace and is [held back](#held-back).
- 20 `SKILL.md` files — 10 skills × 2 mirrors, each with `Agent CRM` in the `description`. The
  description is the only thing that decides whether a skill triggers. `.claude/skills` and
  `.agents/skills` must stay byte-identical (`tests/skill-parity.test.js`), so both mirrors take
  the same edit in the same run.

The npm names (`<slug>`, `create-<slug>`, `@<slug>`) belong to this group too and exist only as
tokens here — registering them is a human action the script refuses to take.

### code — 76 files, 291 occurrences, 2 renames

**Breaks existing checkouts and any config a user has already installed.**

- `package.json` (9) — `name`, the `bin` key `agent-crm`, and seven scripts naming
  `packages/cli/bin/agent-crm.js`. `package-lock.json` (4) mirrors all of it.
- `packages/cli/bin/agent-crm.js` and `packages/cli/bin/agent-crm-inspect.js` — **file renames.**
  The script moves them with `git mv`, falling back to `renameSync` outside a work tree.
- MCP server keys in four harness configs: `.mcp.json` and `.claude-plugin/mcp.json`
  (`agent-crm`), `.codex/config.toml` and `.codex-plugin/mcp.json` (`agent_crm`). A user who has
  already copied one of these into their own project keeps the old key; no rename in this
  repository reaches it.
- Database filename: `data/agent-crm.sqlite`, the `CRM_DB_PATH` default in
  `packages/core/src/database.js`, `.env.example`, and the three MCP configs. The file is
  gitignored, so an existing local database is silently not found after the rename until it is
  moved or `CRM_DB_PATH` is set.
- Exported identifiers across 41 files: `createAgentCrmApp` from `packages/app`, `AgentCrmClient`
  from `packages/sdk`, `AgentCrmDatabase`, `AgentCrmAdmin`. `packages/cli/src/module-factory.js`
  emits `createAgentCrmApp` into generated projects, so the templates and the tests asserting on
  their output move together or not at all.
- Environment variables `AGENT_CRM_KEEP_ROOT` and `AGENT_CRM_FIXTURE_SIGNATURE_STORE` (8).
- 34 test files, which is why the rename is verifiable at all.

## Held back

45 occurrences the script deliberately leaves alone, in two categories. Each is printed in every
run, so nothing is skipped silently.

**Deferred — correct today, and gated on something outside this repository (29 occurrences).**

- `github.com/<owner>/agent-crm` across six files including `site/brand.json`, and `server.json`'s
  `name: "io.github.khaoss85/agent-crm"` (14 together). Those URLs resolve to a repository that
  exists under that name, and the MCP registry verifies the namespace against that same
  repository. Both follow a human renaming the GitHub repository rather than leading it.
- `AGENT_CRM_CLOUD.md` (15 across 8 documents) — a document filename other documents link to.
  Renaming it is a separate reviewed change; the script rewrites the prose inside that document
  but not its name.

**Excluded — rewriting them would destroy their meaning (16 occurrences).**

- `scripts/brand-set.js` — holds the working title as a historical constant. Rewriting it erases
  the mapping a second run needs if the trademark screen comes back badly.
- `docs/strategy/BRAND_REQUIREMENTS.md` — argues why the working title is unsuitable. Its quotes
  are the evidence.
- `docs/marketing/NAME_VERIFICATION.md` — the naming research and the candidates that lost.
- `DECISIONS.md` and `docs/plans/` — ADR and merged-ExecPlan history. A record states what was
  true when it was written; retroactively editing it is falsification, not a rename.
- This file.

## How the command behaves

Dry-run by default, matching the module factory and the MCP scaffolding tools: code-generating and
destructive actions are dry-run until an explicit `--apply`.

It refuses to run when:

- the name is not kebab-case, 2–32 characters, starting with a letter — it becomes an npm package
  name, a bin key, a filename and a plugin namespace, so a name that is not an identifier is not a
  name (the refusal suggests the kebab form of what was typed);
- the name collides with one of the 16 marketplace names reserved by Anthropic, or implies an
  official source — the same list `scripts/distribution-check.js` enforces;
- the name is the working title;
- `--apply` is passed and `git status --porcelain` is non-empty. It rewrites over a hundred files
  and renames two; a rename that cannot be reverted with one `git checkout .` is a rename that
  should not start.

It never contacts the network and registers nothing. Its only child process is `git`
(`status`, `mv`). Every run ends by printing what a human must still do: register the npm names,
the GitHub org and repository, the domain; run the trademark screen; confirm the licence; make the
directory submissions; move the local SQLite file; re-run `npm run verify` and `npm run gtm:check`.

Re-running with a different name works: the old tokens are the union of the working title and
whatever `brand.json` currently records, so the second rename finds what the first one wrote.

## Verification

Measured on branch `claude/go-to-market-strategy-gkr4bz` at `ccdf828`.

- Two consecutive dry runs produce byte-identical output; the working tree is unchanged after both.
- Every refusal path exercised, each exiting 1.
- `--apply` run in a clean clone of `ccdf828`: 125 files written (the clone predates the
  uncommitted files the working-tree dry run also counts), 2 renames, `brand.json` updated. Guards
  held — the GitHub URLs, the registry namespace and every `AGENT_CRM_CLOUD.md` reference survived;
  the leftover matches are exactly the held-back set.
- `npm run verify` on that renamed clone: **388 tests, 387 pass, 1 fail** — identical to the same
  command on an unrenamed clone of the same commit. The one failure is a pre-existing
  `skill-parity` mismatch on `adversarial-review/SKILL.md`, in flight from other work and unrelated
  to naming. The rename introduces no regression.
- `npm run crm -- app inspect --json` on the renamed clone reports `"name": "accordo"`, `valid: true`.
- `npm run gtm:check` fails identically before and after, on two blockers that a chosen name makes
  binding rather than the rename causing: the bundled skills are still repo-bound, and the licence
  is still `provisional`. Both are named in the post-run checklist.
