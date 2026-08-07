# Coder tooling roadmap

The surfaces a coding agent uses to understand, plan and change an Agent CRM
project — what exists, what is next, and what is deliberately refused.

This is a roadmap, not a claim. Everything under **Shipped** has merged tests
behind it; everything below that is not available and must never be described as
if it were.

## Shipped

| | Surface | What it answers |
|---|---|---|
| AX1 | `crm app inspect [--json]` | what has this project actually composed — packages, the resolved capability graph, records and revisions, actions, policies, providers, and eleven machine-readable limitations |
| AX2 | `crm solution inspect\|validate\|check` | what are you going to do about it, and on what evidence — a bounded plan contract, bound to a real AX1 report |
| — | `crm package validate\|inspect <dir>` | one package in isolation, through the validator the application runs at startup |
| — | `crm module plan\|create\|validate\|migration` | the module factory: a manifest becomes a complete runnable record, dry-run unless `--apply` |
| — | `GET /api/schema` | the same picture from a running server, function-free |
| — | the MCP server | the same operations over MCP, code-generating actions dry-run by default |

## Next, in the order the gaps actually bite

**1. Machine-readable evidence aggregation.** AX1 publishes
`evidence.status: "not_aggregated"` and three paths, because JTBD status and
quality-gate results are prose. An agent that must judge "is this job actually
done" reads three documents and guesses. The fix is a contract over the JTBD
matrix and the gate results, with the same determinism discipline — and it is
the single highest-value remaining gap, because every other surface already
refuses to guess and this one forces the reader to.

**2. Declarative state metadata on package actions.** The delivery package
restricts its actions to specific record states imperatively, so `/api/schema`
and AX1 report `fromStates: null` — accurate about the declaration, but it means
an agent cannot see the restriction without reading package metadata. Moving the
packages to declarative `fromStates`/`stateField` would make one field answer it
everywhere.

**3. A plan-to-diff reviewer.** Given a plan and a diff, report which steps the
diff implements, which it exceeds, and which it silently skipped. This is a
*checker*, not an executor: it reads two things and reports, and it is the
natural next AX surface because AX2 already made one of the two machine-readable.

**4. Data-quality reporting.** `app inspect` says a record exists, never that
its rows are complete or deduplicated. Counting the nulls is currently the
agent's job with no tool for it, and a metric computed over mostly-missing data
is the most common way a confident wrong answer gets produced here.

**5. A conformance suite for a custom package.** `package validate` checks the
contract; nothing checks that a package's *behaviour* holds the invariants the
official ones do (immutable evidence, human-actor boundaries, exact reads past
the page bound). A runnable suite a package author points at their own package
would make ADR-018's seam self-enforcing.

## Deliberately refused

Each of these is refused for a reason, not a schedule:

| | Why |
|---|---|
| a built-in LLM or planner | the framework must stay verifiable and offline; who writes a plan is not the framework's business |
| an agent runtime or orchestrator | a format that can describe execution invites a runtime, and the first runtime that reads a plan is one edit away from applying it |
| automatic source modification from a plan | a plan is reviewed; a diff is reviewed; conflating them removes the review |
| executable commands as trusted plan content | see above, and enforced by the validator rather than documented |
| remote package or provider installation | nothing here reaches the network, and no official package needs to |
| production deploy | there is no auth, tenancy or RBAC — the Production Spine gates this |
| database or runtime-health inspection | AX1 is source-only by design; a tool that sometimes opens a database is a tool nobody can reason about |
| sandboxing package code | **repository source is trusted.** Isolation is real; a sandbox is not attempted and would not be honest to claim |

## Hard dependencies

Several otherwise-obvious surfaces are blocked on the **Production Spine**
(auth, tenancy, RBAC), not on effort: anything that reports *authorization*,
anything that acts as a customer, and anything that deploys. Until it exists,
every approval in this framework is a human-actor boundary and is described as
one.

## Evidence

`docs/APPLICATION_INSPECTION.md`, `docs/SOLUTION_PLAN.md`,
`docs/AGENT_HARNESS_COMPATIBILITY.md`, `docs/PACKAGE_AUTHORING.md`,
`docs/MODULE_FACTORY.md`, `docs/MCP.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md` (the AX section).
