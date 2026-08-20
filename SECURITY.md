# Security

## The posture, stated plainly

This framework is **local-development-only** and has no production security spine. That is
not a caveat at the bottom of a page; it is the first thing to know:

- **There is no authentication.** No login, no tokens, no sessions.
- **There is no tenancy.** No workspace, organisation or row-level isolation exists.
- **There is no RBAC.** No roles, no permissions, no per-record authorization.
- **An actor header is an assertion, not an identity.** The HTTP API accepts whatever actor
  a client claims to be. Audit records that assertion faithfully — which makes it useful
  for reconstructing what a process did, and useless as proof of who did it.
- **MCP and CLI run with the authority of the process that starts them.** Reading a
  code-first package means importing it, so package code executes with that authority.
  Nothing is sandboxed, and `crm app inspect` reports this as a limitation in its own output.

The framework's own inspection command states the same thing in machine-readable form:

```bash
npm run crm -- app inspect --json | jq '.application.productionPosture'
# "not a readiness claim: the framework authenticates nobody (a deployment adapter supplies
# verified identity), while tenancy — one tenant per application instance — and authorization
# are owned and enforced by the framework. SQLite only; ..."
```

**Do not expose the HTTP API to a network.** Building the production spine — authentication,
tenancy, RBAC, PostgreSQL — is a tracked platform milestone, not an oversight, and until it
lands there is no configuration of this software that is safe to expose.

## What is in scope for a report

Given the above, the interesting reports are the ones that hold *even in local development*,
because they represent broken invariants rather than missing infrastructure:

- A write that bypasses a module service or named workflow and reaches a table directly.
- A mutation that leaves no audit event, or leaves one when the transaction rolled back.
- A public CRUD, HTTP, SDK, MCP or Admin path that sets a field only an action may set.
- An approval that can be granted by an agent-supplied actor rather than deferred to a human.
- An immutable record — a quote version, an order, a contract version, a cost plan — that
  can be rewritten by later movement in its source.
- Hostile input (`__proto__`, `constructor`, markup, template syntax, null bytes, oversized
  strings) that causes prototype pollution, unsafe HTML, route confusion or SQL interpolation.
- A secret, credential, payload or filesystem path leaking into an error, a trace, an audit
  event or the `/api/schema` output.
- Anything in a generated project that a reader would reasonably assume is safe and is not.

These map to the adversarial-review categories in
[`docs/QUALITY_GATES.md`](docs/QUALITY_GATES.md), which is the same list we attack our own
milestones with before merging them.

## What is out of scope

Reports that reduce to "there is no authentication" or "the API is unauthenticated" —
that is documented above, in the README, in the JTBD matrix as JTBD-15, and in the
framework's own inspection output. It is a known gap with a milestone, not a finding.

## Reporting

Open a GitHub security advisory on the repository (**Security → Report a vulnerability**),
which keeps the report private until a fix exists. If that is unavailable to you, open a
regular issue **without** exploit details and ask for a private channel.

Please include what a maintainer needs to reproduce it: the commit, the smallest sequence
that shows the problem, and the trace if a workflow or action is involved
(`npm run crm -- trace <runId>`).

## Response

This is a pre-launch project maintained without an on-call rotation, and promising a
response window we cannot hold would be its own kind of security theatre. What we will do:
acknowledge that a report was received, say whether we consider it in scope, and fix
in-scope findings with a test that fails without the fix — because a security fix with no
regression test is a fix that comes back.

## Supply chain

The framework has **no third-party runtime dependencies**: `package.json` declares none, and
persistence, HTTP and testing all use Node built-ins. This is a deliberate constraint
(`AGENTS.md`: a production dependency must remove more complexity than it adds, with the
reason recorded in `DECISIONS.md`). It removes a large class of supply-chain exposure from
the framework itself. It says nothing about what you add on top of it, or about your own
generated application's dependencies.
