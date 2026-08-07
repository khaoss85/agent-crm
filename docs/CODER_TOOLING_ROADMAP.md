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

## Next, with identifiers so they can be referenced

Nothing below is implemented. Each is named so a plan, an ADR or a PR can point
at it without re-describing it.

### Near-term, after M14b2

| | Tool | What it answers |
|---|---|---|
| **DX1** | `crm doctor --json` | is this *project* internally consistent — manifests applied, state files present, generated registries matching source, composition file in step? Distinct from `app inspect`, which describes a valid composition rather than diagnosing a broken checkout |
| **DX7** | canonical Skill source + `skill sync\|check` | one semantic source per skill with thin adapters for Claude Code, Codex and Gemini, and a drift check in `verify`. Today the `.claude/` and `.agents/` copies are byte-identical by hand |

### After M15 Service package learnings

| | Tool | Why it waits |
|---|---|---|
| **DX2** | package scaffold | scaffolding a shape nobody has built three times bakes in the wrong shape |
| **DX8** | package conformance test kit | a runnable suite a package author points at their own package, asserting the invariants the official packages hold (immutable evidence, human-actor boundaries, exact reads past the page bound). It makes ADR-018's seam self-enforcing — and needs M15 to know which invariants are actually general |
| **DX9** | first existing-domain extraction pilot | one of Intelligence / Commercial / Signature moved out of core, once DX8 can prove the result still conforms |

### Before an AX3 public benchmark

| | Tool | What it answers |
|---|---|---|
| **DX3** | project verify report | one machine-readable document over the gates, suites and starters — the machine-readable evidence AX1 publishes as `not_aggregated` today |
| **DX4** | JTBD / scenario runner | which rows a checkout actually earns, from linked evidence rather than prose |
| **DX5** | benchmark runner | the scenarios end to end, reproducibly, for a public claim |

**AX3 depends on DX3 and DX4**, not the other way round. A benchmark whose
evidence is prose is a benchmark nobody can check.

### Review and maintenance

| | Tool | What it answers |
|---|---|---|
| **DX6** | change-impact inspector | given a diff, which packages, capabilities, records and JTBD rows it touches |
| **DX10** | stable error catalog / `crm explain <code>` | every published problem code in one place, with what to do about it |
| **DX11** | upgrade compatibility assistant | what a framework version bump requires of an existing project |
| **DX12** | release / semver tooling | what changed at each seam, and whether the version says so |
| **DX13** | Project MCP parity | the same operations over MCP as over the CLI, with the same dry-run defaults |

### Production and Cloud

All of these are hard-gated by the **Production Spine** (auth, tenancy, RBAC),
not by effort:

| | Tool |
|---|---|
| **DX14** | database and migration inspection |
| **DX15** | provider health |
| **DX16** | trace and audit query |
| **DX17** | deploy, logs, rollback |
| **DX18** | secret and authorization posture |

## Priority, stated once

```text
M14b2 runtime remains next
DX1 (doctor) and DX7 (Skill sync) may proceed in parallel — they block nothing
M15 Service package
then DX2 scaffold, DX8 conformance kit, DX9 extraction pilot
DX3 + DX4 before any AX3 benchmark
```

Toolkit work does not displace M14b2 or M15. A developer toolkit for a
framework whose domains are half-built optimizes the wrong thing.

## The gap that bites first

**Machine-readable evidence aggregation (DX3).** AX1 publishes
`evidence.status: "not_aggregated"` and three paths, because JTBD status and
quality-gate results are prose. Every other surface in this repository refuses
to guess; this one forces its reader to. It is the highest-value remaining item
and the precondition for both DX4 and AX3.

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
