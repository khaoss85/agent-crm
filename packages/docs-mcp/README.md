# Docs MCP server

A read-only MCP server that answers questions **about this framework** — its
documentation, its proven capabilities and the limitation that bounds each one,
and whether a given CRM job is supported.

It is a second, separate server from `packages/mcp`. That one opens a project's
CRM database and exposes narrow write tools. This one opens no database, holds no
customer record and can write nothing, which is why it is the only server here
that is safe to run in a stranger's context or to host.

## What it serves

**Resources**

| URI | What it is |
| --- | --- |
| `docs://index` | Every document served, plus what is excluded and why. |
| `docs://claims` | `site/claims.json` — capabilities bound to the tests that prove them, each paired with its limitation. |
| `docs://jobs` | `docs/benchmarks/jobs.json` — ~149 CRM jobs with a four-value status. Degrades to `{"available": false}` when the generated file is absent. |
| `docs://<path>` | Every `*.md` at the repository root and under `docs/`, addressed by its repository-relative path — `docs://ARCHITECTURE.md`, `docs://docs/MODULE_FACTORY.md`. |

Document URIs mirror repository-relative paths exactly, because the claims ledger
and the jobs index cite evidence by that path. An agent holding
`docs/MODULE_FACTORY.md` can address the resource without a lookup table.

**Tools** — all read-only, all returning JSON.

- `search_docs(query, limit?)` — keyword search across the corpus. Every term must
  appear on the same line. Returns path, nearest heading, line number and an
  excerpt. A linear scan, no index, no dependency: at roughly a megabyte of
  Markdown an index would only be a second copy of the truth that can go stale.
- `get_capability(id? | topic?, limit?)` — resolve a capability from the claims
  ledger by id (`C-01`), by standing-limitation id (`L-01`), or by free-text topic.
  Returns the claim, the evidence paths that prove it, and the limitation that
  bounds it, together.
- `check_job(query, limit?)` — "can this framework do X?" against the jobs index.
  Returns matching jobs with status (`not supported` / `partially supported` /
  `technically supported` / `validated end to end`), their evidence, and an
  explicit `not supported` answer when that is the truth.

## The rule this server is built around

**No tool returns a capability claim without the paired limitation.**

Not as a convention — structurally. There is exactly one function that builds a
capability answer (`toCapability`), and it throws if the limitation is missing or
trivial. Every tool response is then swept by `assertLimitationsPresent` before it
leaves. A future tool cannot accidentally return a bare claim, because it has no
way to construct one.

The same rule applies to job statuses, because a status *is* a capability claim.
Where the ledger has a limitation bound to that JTBD id, that one is used;
otherwise the status states its own boundary. `validated end to end` never travels
alone.

## What it deliberately cannot do

- **Open a database.** No SQLite adapter, no application factory, no module
  service is imported anywhere in this package. A test asserts the import graph,
  not just the intention.
- **Write anything.** No write tool, no filesystem write call, no dry-run flag to
  forget to set. Every tool is annotated `readOnlyHint: true` and the annotation
  is enforced.
- **Read outside the documentation root.** Every readable thing is enumerated
  ahead of time and addressed through a `Map`, so an unlisted path has no name to
  be asked for; and every path joined to the root passes `resolveWithinRoot`,
  which rejects absolute paths, null bytes and anything resolving outside.
- **Serve ExecPlans.** `docs/plans/` is excluded. A plan describes work that is
  *intended*; an agent that reads one as a capability was misled by us, not by
  itself. `docs://index` says so rather than silently omitting them.
- **Answer a question no job covers.** When the query matches nothing well enough,
  `check_job` answers `unknown` and says the job was never assessed — which is not
  the same as a job that works. It does not round a near-miss up to a status.
- **Report anything about a running system.** No runtime state, no authorization
  state, no deployment. It reads checked-in source and says so.

Standing limitations of the framework itself (no authentication, no tenancy, no
RBAC; SQLite only; the build benchmark has not been run) ride along on every
capability and job response as `frameworkLimitations`.

## Running it

```
node packages/docs-mcp/bin/server.js
```

stdio transport, newline-delimited JSON-RPC, same framing and error shape as
`packages/mcp`. stdout carries JSON-RPC only; diagnostics go to stderr.

Client configuration:

```json
{
  "mcpServers": {
    "accordo-docs": {
      "command": "node",
      "args": ["packages/docs-mcp/bin/server.js"]
    }
  }
}
```

There is no environment variable to set and no database path to supply. The server
resolves its documentation root from its own location.

An `npm run docs:mcp` script would be the natural entry point; adding it is the
integrator's change, since this package does not edit `package.json`.

## Hosting and directory submission are human decisions

This server is *prepared* for the Anthropic Connectors Directory and equivalent
listings — it serves documentation rather than customer records, so it needs none
of the CRM's auth or tenancy, and it can be reviewed without a production spine.

Nothing here submits it anywhere. The public name is undecided
(`docs/strategy/BRAND_REQUIREMENTS.md`), nothing is published to a registry, and
every external submission is a human decision
(`docs/strategy/MASTER_PLAN.md` §10.4, `docs/marketing/PENDING_HUMAN_SUBMISSION.md`).
Before any listing, re-measure `site/claims.json`'s `measuredAgainst` block: a
ledger measured against a stale commit is a ledger that lies, and this server
serves it to strangers.

## Tests

`tests/docs-mcp.test.js` — the server starts over stdio and lists its tools; every
tool is read-only and the import graph reaches no database; search returns a known
heading and is deterministic; a capability cannot be constructed without its
limitation; every claim in the ledger and every job in a broad sweep is served
with one; an unknown id is refused; the jobs index degrades with a message when
absent; and null bytes, oversized strings, `__proto__`, markup and
`../../etc/passwd` are all inert.
