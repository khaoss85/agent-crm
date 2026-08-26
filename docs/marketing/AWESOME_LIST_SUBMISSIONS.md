# Awesome-list submissions, prepared

Four lists, three different mechanisms, and not one of them is a PR an agent can
open from this repository. Everything below is written out so submitting is copy,
paste, send — and so the wording is reviewed here rather than typed into a form
at speed. `MASTER_PLAN.md` §10.4 stands: an agent prepares, a person submits.

The first two entries became honest only after `create-accordo@0.1.0` went live
and the MCP Registry entry was published. These lists reject things that cannot
be installed and used, and until 2026-08-19 that rejection would have been
correct.

**Two independent reasons the sending step is not agent work**, and they are
worth separating because only one of them is ours:

- Ours: `MASTER_PLAN.md` §10.4 and `PENDING_HUMAN_SUBMISSION.md`.
- Theirs: `hesreallyhim/awesome-claude-code` CONTRIBUTING, verbatim — *"Although
  resources themselves may be partially or entirely written by a coding agent,
  resource recommendations must be created by human beings."* A submission from
  an agent violates the destination's own rule, whatever ours says.

A third reason is merely mechanical and should not be mistaken for either: an
agent session is bound to this repository, and its proxy refuses write access to
every GitHub path outside it (`POST /repos/…/forks` → 403, *"Write access to
this GitHub API path is not permitted through this proxy"*). A maintainer PAT
with full scope was tried against the same call and returned the identical 403 —
the block is on the path, not on the identity — and `gh` is not installed. That
is a fact about the sandbox, not a policy, and it would not license sending if
it were lifted.

## Running the three PR submissions

`scripts/submit-awesome-lists.sh` does lists 1, 3 and 4 in one command from a
machine with `gh` logged in. Dry run by default, `--apply` to send — the same
posture the framework's own code generation takes.

```bash
./scripts/submit-awesome-lists.sh            # prints every patch, changes nothing
./scripts/submit-awesome-lists.sh --apply    # forks, branches, pushes, opens the PRs
```

It refuses to guess: each list's insertion point is a fixed anchor read out of
that README on 2026-08-26, and a list that has since reorganised is **skipped
with its anchor printed** rather than patched somewhere plausible. A misplaced
entry is worse than no entry — it reads as carelessness on the one surface where
carelessness is the whole objection.

List 2 is deliberately not in it, for the reason above. It is a browser tab.

---

## 1. punkpeye/awesome-mcp-servers — a pull request

**Status: SENT 2026-08-26** — [punkpeye/awesome-mcp-servers#12938](https://github.com/punkpeye/awesome-mcp-servers/pull/12938), open, +1/−0.

### The entry

Category **Developer Tools**. The file's CONTRIBUTING asks for alphabetical
order within a category; the file itself does not keep it, and recent additions
sit at the top of each section. Follow the file, not the instruction: add this
as the **first line under the Developer Tools heading**, with no blank line
after it — entries there run contiguously.

The heading carries an inline anchor, so the literal text to match is
`### 💻 <a name="developer-tools"></a>Developer Tools`, not `### 💻 Developer
Tools`. Searching for the latter finds nothing.

```markdown
- [khaoss85/agent-crm](https://github.com/khaoss85/agent-crm) 🎖️ 📇 ☁️ - Read-only documentation server for Accordo, an open-source CRM framework that coding agents build with. Three tools over the published corpus: `search_docs`, `get_capability` — which returns every capability together with the limitation that bounds it — and `check_job` over a CRM jobs matrix whose default status is "not supported". Opens no database and holds no customer record. Endpoint: `https://accordo.dev/api/mcp`; also runs over stdio from a checkout.
```

Legend symbols, each chosen against the README's own definitions: 🎖️ official
implementation (this is the project's own server), 📇 JavaScript codebase, ☁️
cloud service (it is a hosted endpoint, not a local process).

No Glama badge: the other entries' badges point at Glama listings, and Accordo
has none yet. A badge for a listing that does not exist renders as a broken
image and misstates the project's reach.

### How to send it

```bash
# fork through the GitHub UI first, then:
git clone https://github.com/<your-user>/awesome-mcp-servers && cd awesome-mcp-servers
git checkout -b add-accordo-docs-mcp
# add the line above as the first entry under "### 💻 Developer Tools"
git commit -am "Add Accordo docs MCP server"
git push -u origin add-accordo-docs-mcp
```

**PR title**

```
Add Accordo docs MCP server (Developer Tools)
```

**PR body**

```markdown
Adds the Accordo documentation MCP server under Developer Tools.

- Repository: https://github.com/khaoss85/agent-crm (MIT)
- Endpoint: https://accordo.dev/api/mcp (Streamable HTTP, no auth, read-only)
- Also in the official MCP Registry as `io.github.khaoss85/agent-crm`

Three read-only tools over the project's published documentation corpus.
`get_capability` returns a capability together with the limitation that bounds
it — the server has no way to return one without the other — and `check_job`
answers over a jobs matrix whose default status is "not supported". The server
opens no database, imports no CRM runtime and persists no request; its own
tests reject any import path into the runtime.

Checked before submitting: both links resolve, and `tools/list` against the
endpoint returns exactly `search_docs`, `get_capability` and `check_job`, each
with `readOnlyHint: true`.
```

---

## 2. hesreallyhim/awesome-claude-code — an issue form, not a PR

**Status: SENT 2026-08-26** — [hesreallyhim/awesome-claude-code#2637](https://github.com/hesreallyhim/awesome-claude-code/issues/2637), submitted by the maintainer through the web issue form (its CONTRIBUTING requires a human), prefilled from this file. The bot validated it (`validation-passed`); the category landed as "Agent Orchestration" rather than "Skills" via the dropdown.

Its CONTRIBUTING is explicit — *"ALL RECOMMENDATIONS MUST BE MADE USING THE WEB
UI ISSUE FORM TEMPLATE, OR YOU RISK BEING RESTRICTED FROM INTERACTING WITH THIS
REPOSITORY TEMPORARILY"* — and the acceptance rule is a resource *"at least 14
days old (14 days since first commit on default branch)"*, **or** at least 100
stars.

First commit on `main`: **2026-08-04** (`7b0d2e6`, "Initial commit"). That is 14
days on **2026-08-18**, which has passed. The repository has 2 stars, so the age
rule is the one that carried it.

> An earlier revision of this file said 2026-08-07 and derived 2026-08-21. That
> was read from a single-branch shallow clone whose history did not reach the
> first commit. Re-measured on a full 893-commit clone with
> `git log --reverse --format='%H %ad' --date=short main`. The list is 53k stars
> and the rule is bot-enforced; a date this file gets wrong is a date the bot
> gets right, and the list allows only one recommendation at a time, so there is
> no second shot to spend on an arithmetic error.

Open the form: **Issues → New issue → "Recommend a resource"** on
`hesreallyhim/awesome-claude-code`.

| Field | Value |
|---|---|
| Display Name | `Accordo` |
| Category | `Skills` |
| Link | `https://github.com/khaoss85/agent-crm` |
| Author Name | `Aetha` |
| Author Link | `https://github.com/khaoss85` |

**Description** — the form's own guidance is *"1-3 sentences. Descriptive, not
promotional. Don't address the reader. (10-500 characters.)"*, and CONTRIBUTING
adds *"Resource descriptions should be written as _descriptions_ - not a sales
pitch."* This is one sentence, 236 characters, no emoji, second person absent:

```
Open-source CRM framework distributed as a Claude Code plugin with eleven skills for building CRM modules, deterministic workflows and domain packages; policy-gated approvals are enforced by merged tests rather than prompt instructions.
```

> **Eleven, not twelve.** `.claude/skills/` holds twelve directories, but
> `plugin.json` publishes `"skills": "./skills/"`, and `skills/` holds eleven.
> `adversarial-review` is a maintainer skill for this repository's own merge
> gate and is deliberately not in the installed bundle. The number a submitter
> writes has to be the number a reader counts after `/plugin install`, which is
> eleven. Re-check with `ls skills/ | wc -l` before sending, not against memory.

**Checklist**: tick the first five. Leave the sixth unchecked — its label is
*"Do not check the following box - leave it unchecked. By checking this box, I
admit that I am not reading any of these statements."*

The third box reads *"This resource is specific to Claude Code."* Tick it
honestly: the submitted resource is the plugin — a `plugin.json`, a
`marketplace.json` and eleven `SKILL.md` files — and that is Claude Code
specific. The framework underneath is not, and the description does not claim
it is.

---

## 3. travisvn/awesome-claude-skills — a pull request

**Status: SENT 2026-08-26** — [travisvn/awesome-claude-skills#1173](https://github.com/travisvn/awesome-claude-skills/pull/1173), open, +5/−0. 14.8k stars, 1.9k forks; the largest list in this
family by an order of magnitude, and the only additional one whose reach is
worth the review time. Its CONTRIBUTING states no age or star gate, so the only
question is fit, and the fit is direct: eleven installable `SKILL.md` files.

Section: **Community Skills → Collections & Libraries** — a collection is what
this is, and filing eleven skills under *Individual Skills* would be wrong.

That section is a **bulleted list with sub-bullets, not a table.** An earlier
revision of this file prepared a table row for it, which would have rendered as
a stray pipe-delimited line in the middle of a list. Read out of the file on
2026-08-26; the shape below is `obra/superpowers`', "Installation:" line and all:

```markdown
- **[Accordo](https://github.com/khaoss85/agent-crm)** - Eleven skills for building a custom CRM as code you own: modules, deterministic workflows, domain packages, commercial operations, contract activation, delivery and service
  - Commercial policy is generated as code and proven by tests in the project's merge gate, so a rule the agent is asked to bypass fails a test rather than a prompt
  - Ships a local project MCP; code generation stays dry-run until `--apply`
  - Installation: `/plugin marketplace add khaoss85/agent-crm` then `/plugin install accordo`
```

**PR title**

```
Add Accordo (eleven CRM-building skills) to Community Skills
```

**PR body**

```markdown
Adds Accordo under Community Skills → Collections & Libraries.

- Repository: https://github.com/khaoss85/agent-crm (MIT)
- Install: `/plugin marketplace add khaoss85/agent-crm` then `/plugin install accordo`
- Skills: eleven, each a `SKILL.md` with YAML frontmatter under `skills/`

The skills build CRM modules, deterministic workflows and domain packages
against an open-source framework in the same repository. Approval rules are
generated as code and proven by tests that run in the project's merge gate, so
a policy the agent is asked to bypass fails a test rather than a prompt.

Actively maintained: commits on the default branch this week.
```

Nothing to check against a star threshold here, but do re-read the *Community
Skills* headings before opening the PR — that README reorganises as it grows,
and its own note says the section *"will be broken down into categories once
there are enough community skills available"*.

---

## 4. sneg55/awesome-open-source-crm — a pull request

**Status: SENT 2026-08-26** — [sneg55/awesome-open-source-crm#4](https://github.com/sneg55/awesome-open-source-crm/pull/4), open, +1/−0. 13 stars, 5 commits. Its retrieval
value today is close to nothing. It is here for one reason: it is the only list
found with a section headed **CRM Frameworks** — *"Platforms and frameworks for
building custom CRM solutions"* — which is precisely and unusually the category
this project has to be read as. A correct entry in the right category on a small
list is still a correct entry; it costs ten minutes and it cannot mislead.

Its four criteria, each checked rather than assumed: open source (MIT), commits
within twelve months (this week), working software (`npm create accordo` is
live on npm), CRM-related (the section is literally CRM frameworks).

Entry, in the file's own `Name | Description | Stack | Stars` table format. Its
house style is one short clause per row — *"No-code/low-code platform for CRM
workflows"* — so this matches that length rather than the longer MCP entry:

```markdown
| [Accordo](https://github.com/khaoss85/agent-crm) | Framework for building a custom CRM as code with a coding agent, with deterministic policy and audit; not a deployable CRM — it ships no authentication | Node.js | ![GitHub stars](https://img.shields.io/github/stars/khaoss85/agent-crm?style=flat-square) |
```

The clause after the semicolon is not modesty, it is the whole reason this entry
is safe on a list whose other rows are products a reader can deploy tonight. If
the row has to get shorter, cut the first half.

---

## Lists assessed and deliberately not submitted

Recorded because "we looked and chose not to" is a different fact from "we did
not look", and only the first one survives being asked about later.

| List | Why not |
|---|---|
| **awesome-selfhosted/awesome-selfhosted** | Its inclusion rule is *"Free Software network services and web applications which can be hosted on your own server(s)."* Accordo is neither: it ships no authentication and states it is not deployable. An entry here would be an overclaim of exactly the shape `L-01` exists to prevent — and it would land in front of readers looking to deploy something tonight. |
| **modelcontextprotocol/servers** | Not a community list. Its README is *"a collection of reference implementations"* maintained by the MCP steering group, and it routes community servers to the MCP Registry — where `io.github.khaoss85/agent-crm` already is. Nothing to submit. |
| **ComposioHQ/awesome-claude-skills** | Self-describes as 1000+ entries. A list that accepts everything confers no signal on anything, and being in it does not make a retrieval step more likely to name us. Costs review time, returns nothing. |
| **karanb192/awesome-claude-skills** | 498 stars, PRs welcome, criteria met — a genuine fit, just a smaller one than §3. Hold it as a second wave: submit §3 first, and if the entry lands, the same body transfers here almost verbatim. Sending both at once spends twice the attention on one announcement. |
| **General open-source CRM roundups** (webkul, daily.dev, crm.org, marmelab) | Editorial articles, not lists with a submission mechanism. They are also product comparisons — Twenty, SuiteCRM, EspoCRM — so an entry would force the `P1` framing (*"an AI CRM"*) that `docs/benchmarks/CPR_PROTOCOL.md` names as the failure that matters most. Outreach to these is a different play with a different brief; it is not an awesome-list submission and it does not belong in this file. |

---

## What was checked before writing this

Every fact below was fetched or measured in the session that wrote it, not
recalled. The two errors this file carried until 2026-08-25 were both
recall-shaped, which is the argument for the discipline rather than for trusting
the outcome of it.

- The MCP entry's facts against the live endpoint: three tools, all read-only.
- Repository age against the awesome-claude-code rule, from `git log --reverse`
  on a **full** clone rather than from the GitHub creation date, because the rule
  names the first commit. Created and first-committed are both 2026-08-04; the
  earlier claim that they differed was an artefact of a shallow clone.
- The published skill count from `skills/`, not `.claude/skills/`, because the
  first is what `plugin.json` ships and the second is what this repository
  develops.
- All four lists' CONTRIBUTING and issue-form files, fetched rather than
  remembered — which is how the "no PR" rule, the exact six checklist labels and
  the 500-character description cap on list 2 surfaced.
- Star and fork counts read off each repository page on 2026-08-25, and used
  only to order the queue.

## What could not be done here, and why

Preparing is agent work and it is finished. Sending is not, for three reasons
that are independent of each other — the destination's rule, this project's
rule, and the sandbox — and all three are stated at the top of this file.
`docs/marketing/PENDING_HUMAN_SUBMISSION.md` is the queue; these four entries
are copy-paste-ready in it.
