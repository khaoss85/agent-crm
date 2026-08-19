# MCP Registry entry — the remote Docs MCP, not a published project server (ExecPlan)

## 1. Goal and user-visible outcome

Make the MCP Registry submission possible and correct. Today `server.json`
promises the registry an npm package, `@accordo/mcp`, that does not exist and —
this plan's central finding — must not be created in the shape the file
describes. After this change the registry entry describes the read-only
documentation server already running at `https://accordo.dev/api/mcp`, which an
agent can reach without cloning anything, and the submission is blocked on
nothing but the human `mcp-publisher` step.

Publishing to the registry stays a human action (`MASTER_PLAN.md` §10.4). This
plan makes the artifact honest; it submits nothing.

## 2. Current repository context

- `server.json` names `io.github.khaoss85/agent-crm` and lists one package,
  `@accordo/mcp@0.1.0`, stdio transport, with a `CRM_DB_PATH` environment
  variable. Nothing has ever been published under it: `npm view @accordo/mcp`
  returns 404.
- The `@accordo` organization now exists. Checked here rather than assumed:
  `https://registry.npmjs.org/-/org/accordo/package` returns 200 with an empty
  object, while a nonexistent org returns 404. The scope is claimed and holds no
  public package.
- `packages/mcp` is the **project** MCP server: nine `crm_*` tools over stdio
  against a composed application.
- `packages/docs-mcp` is the **documentation** MCP server: three read-only tools
  (`search_docs`, `get_capability`, `check_job`) over a deterministic corpus. It
  opens no database and imports no CRM runtime, enforced by its own tests. It is
  live at `https://accordo.dev/api/mcp` (ADR-025) and listed on Smithery.
- `scripts/distribution-check.js` validates `server.json`'s name shape and, while
  the scope was unclaimed, printed a note that the referenced package was
  unpublished.

## 3. The finding that decides the shape

**The project MCP server cannot be published as a standalone package that
operates on a customer's project.**

`packages/mcp/src/stdio.js` builds its application with `createAccordoApp`, and
`packages/app/src/create-app.js` composes that application from *static imports*
of the generated indexes — `modules/generated/index.js`,
`domains/generated/index.js`, `actions/generated/index.js`,
`pipelines/generated/index.js`. Those files are written by code generation in
**the customer's own project**.

A published `@accordo/mcp` would necessarily carry its own copies of them, which
contain the framework's set and not the customer's. Run inside a customer
project with `CRM_DB_PATH` pointing at their database, it would open that
database while composing a different module set: it would answer questions about
a CRM that is not theirs, and its migration list would be the wrong one. That is
not a rough edge to document — it is a tool that reports confidently about the
wrong application, which is the exact failure this repository's inspection rails
exist to prevent (`docs/APPLICATION_INSPECTION.md`).

There is also no need for it. A project scaffolded by `create-accordo` already
vendors `packages/mcp/bin/server.js`, composed against its own generated
indexes. The correct project MCP server for a project is the one inside it, and
it works today.

**Therefore:** the registry entry describes the documentation server, which is
genuinely standalone — its corpus is deterministic and bundled, it holds no
customer state, and it is already deployed and verified. The MCP Registry
accepts a remote entry (`remotes[]`, `type: "streamable-http"`, `url`) with the
`packages` array omitted entirely, so no npm artifact is required for it.

## 4. Decision

1. `server.json` describes the hosted Docs MCP: same registry name
   (`io.github.khaoss85/agent-crm`, the namespace the repository owns), a
   description naming the three read-only tools, and a single `remotes` entry
   for `https://accordo.dev/api/mcp`. The `packages` array is removed.
2. `DECISIONS.md` records ADR-028 so the reasoning above outlives this plan —
   in particular so that a future session reading "publish `@accordo/mcp`" in an
   old note does not helpfully create it.
3. `scripts/distribution-check.js` validates the remote entry rather than a
   package reference: transport type, absolute HTTPS URL, and agreement with
   `site/brand.json`'s domain — the same rule that stops any other public
   surface from hardcoding a domain the ledger does not record.

## 5. What this does not do

- It publishes nothing to npm. The `@accordo` scope stays empty, and this plan
  argues it should stay empty until a package exists that is correct standalone.
- It does not submit to the MCP Registry: `mcp-publisher` authenticates as a
  GitHub identity, which is a human action.
- It does not host the project MCP. ADR-025's boundary is unchanged: no
  authentication, tenancy or RBAC exists, so the project server stays local.
- It changes no runtime behaviour of either MCP server. Both keep their tools,
  their transports and their tests.

## 5b. What validating against the live registry changed

Both facts below were found by running `mcp-publisher validate` against
`registry.modelcontextprotocol.io`, not by reading the schema — and the first one
means the entry as originally written could never have been published:

1. **`description` is capped at 100 characters.** The long-standing entry was
   ~440 and is refused with HTTP 422. The replacement is 81.
2. That cap is incompatible with the intent-discovery gate, which requires four
   intent signals plus the CDP boundary on every first-contact surface. The
   registry entry now has its own narrower contract instead
   (`validateRegistryDescription`), and the gate no longer asks it for what does
   not fit.

The endpoint itself was verified once network access allowed it: `tools/list`
returned exactly `search_docs`, `get_capability` and `check_job`, all with
`readOnlyHint: true`.

## 6. Verification

- `npm run gtm:check` — the distribution gate reads the new `server.json` shape.
- `node --test tests/distribution-intent.test.js tests/docs-mcp-http.test.js` —
  the registry copy and the endpoint contract still agree.
- `npm run verify` — the full suite, from a clean checkout of HEAD.
- `mcp-publisher validate server.json` against the live registry — the only
  check that speaks for the registry's own rules rather than for this
  repository's reading of them. It is the check that caught the 100-character
  cap.
- The live endpoint answered `tools/list` with exactly three read-only tools
  when checked directly on 2026-08-19. The tests still bind `server.json` only
  to the brand domain and to the presence of `api/mcp.js`: they prove the entry
  is internally consistent, never that the deployment is up, and a deployment
  can go down after any green build.

## 7. Outcome

Recorded on completion.
