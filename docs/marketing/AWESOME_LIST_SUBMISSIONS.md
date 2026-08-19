# Awesome-list submissions, prepared

Two lists, two different mechanisms, and neither is a PR an agent can open from
this repository. Everything below is written out so submitting is copy, paste,
send — and so the wording is reviewed here rather than typed into a form at
speed. `MASTER_PLAN.md` §10.4 stands: an agent prepares, a person submits.

Both entries became honest only after `create-accordo@0.1.0` went live and the
MCP Registry entry was published. These lists reject things that cannot be
installed and used, and until 2026-08-19 that rejection would have been correct.

---

## 1. punkpeye/awesome-mcp-servers — a pull request

**Status: ready to send.**

### The entry

Category **Developer Tools**. The file's CONTRIBUTING asks for alphabetical
order within a category; the file itself does not keep it, and recent additions
sit at the top of each section. Follow the file, not the instruction: add this
as the **first line under `### 💻 Developer Tools`**.

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

**Status: eligible from 2026-08-21. Do not send before then.**

Its CONTRIBUTING is explicit — *"ALL RECOMMENDATIONS MUST BE MADE USING THE WEB
UI ISSUE FORM TEMPLATE… Do not open a PR"* — and the acceptance rule is a
resource **at least 14 days old** measured from the first commit on the default
branch, **or** 100+ stars.

First commit on `main`: **2026-08-07**. That is 14 days on **2026-08-21**. The
repository has 2 stars, so the age rule is the one that applies. Sending it
early spends the submission on a bot rejection; the list also says only one
resource may be recommended at a time, so there is no second shot to waste.

Open the form: **Issues → New issue → "Recommend a resource"** on
`hesreallyhim/awesome-claude-code`.

| Field | Value |
|---|---|
| Display Name | `Accordo` |
| Category | `Skills` |
| Link | `https://github.com/khaoss85/agent-crm` |
| Author Name | `Aetha` |
| Author Link | `https://github.com/khaoss85` |

**Description** — one line, no emoji, a description rather than a pitch, which
is what that CONTRIBUTING asks for:

```
Open-source CRM framework distributed as a Claude Code plugin with twelve skills for building CRM modules, deterministic workflows and domain packages; policy-gated approvals are enforced by merged tests rather than prompt instructions.
```

**Checklist**: tick the first five. Leave the sixth unchecked — it is a trap
that marks the submitter as not having read the form.

---

## What was checked before writing this

- The MCP entry's facts against the live endpoint: three tools, all read-only.
- Repository age against the awesome-claude-code rule, from
  `git log --reverse` rather than from the GitHub creation date, because the
  rule names the first commit and the two differ here (created 2026-08-04,
  first commit 2026-08-07).
- Both lists' CONTRIBUTING files, fetched rather than remembered — which is how
  the "no PR" rule on the second list surfaced.
