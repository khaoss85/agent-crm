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

**Nothing below is implemented, and nothing below ships in a delivery
milestone.** Each is named so a plan, an ADR or a PR can point at it without
re-describing it.

### Near-term, after M14b2

| | Tool | What it answers |
|---|---|---|
| **DX1** | `crm doctor --json` | is this *project* internally consistent — composition, module-state and migration drift, generated-source drift, package dependencies, Skills, docs and hygiene? Distinct from `app inspect`, which describes a valid composition rather than diagnosing a broken checkout. It makes **no runtime or provider-health claim** unless a future explicit mode adds one |
| **DX2** | Skill portability: `crm agent skills sync\|check` | one canonical semantic source per skill plus deterministic adapters for Claude Code, Codex, Gemini and generic AGENTS-compatible agents, with a drift check in `verify`. Today the `.claude/` and `.agents/` copies are byte-identical by hand, and no Gemini file exists — its conventions must be verified before one is written |

### After M15 Service package learnings

| | Tool | Why it waits |
|---|---|---|
| **DX3** | `crm package scaffold` | dry-run by default, explicit apply, a deterministic package skeleton, **no remote install**. Scaffolding a shape nobody has built three times bakes in the wrong shape |
| **DX4** | `crm package test <path> --json` | conformance: attach/detach, dependency and capability resolution, migrations and evolution, boundaries, audit and trace, exact reads, hostile input. It makes ADR-018's seam self-enforcing — and needs M15 to know which invariants are actually general |
| **—** | first existing-domain extraction pilot | one of Intelligence / Commercial / Signature moved out of core, once DX4 can prove the result still conforms |

### Before an AX3 public benchmark

| | Tool | What it answers |
|---|---|---|
| **DX5** | `crm project verify --json` | machine-readable orchestration of the existing verify, smoke, inspect, module-state, links, Skills and hygiene checks — the evidence AX1 publishes as `not_aggregated` today |
| **DX6** | `crm scenario run <scenario> --json` | which JTBD rows a checkout actually earns, from linked evidence rather than prose |
| **DX9** | `crm context pack --plan plan.json --json` | the smallest deterministic context an agent needs, derived from AX1, AX2, the relevant package docs and Skills, schema and action contracts and the Quality Gates. Token-budgeted, deterministic, source-path references only — **no secrets, no PII, no data rows, no arbitrary source bodies**, fingerprinted for staleness, and **advisory only, never authorization** |
| **DX10** | `ImplementationEvidence` + `crm solution verify plan.json --json` | maps each SolutionPlan requirement to the package, module, action, provider, source files, tests, Admin/CLI evidence and JTBD evidence that satisfy it, marked `implemented \| partial \| blocked`. It closes `goal → plan → build → proof`, and stops an agent claiming a plan is complete while work is missing |

**AX3 depends on DX5, DX6, DX9 and DX10**, not the other way round. A benchmark
whose evidence is prose is a benchmark nobody can check.

### Review and maintenance

| | Tool | What it answers |
|---|---|---|
| **DX7** | `crm change inspect --base main --json` | maps a diff to the packages, capabilities, modules, migrations, actions, tests, Quality Gates, JTBD rows and docs it touches |
| **DX8** | `crm explain <ERROR_CODE> --json` | every published problem code in one place: meaning, likely causes, retryability, safe diagnostics and the doc that covers it |
| **DX11** | `crm upgrade plan --json` | package and capability compatibility, the Module Evolution and migration work a version bump requires, and the tests that must pass |
| **DX12** | provider contract test kit | tracked with the Integration Runtime: config, timeout, late settlement, idempotency, webhook, rate limits, sandbox, secret hygiene and error shape |
| **DX13** | Project MCP parity | the stable CLI contracts mirrored as read surfaces — `app_inspect`, `solution_check`, `doctor`, `verify`, `scenario`, `change_inspect`, `explain`, `context_pack`, `trace_query`. **Remote mutation stays Production-Spine and human-approval work** |

DX7 and DX8 may land opportunistically as small platform slices; neither blocks
anything.

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
Now:
  complete + independently review M14b2

Parallel / immediately after:
  DX1 Project Doctor
  DX2 Skill sync/check

Then:
  M15 Service package

After Service learning:
  DX3 Package Scaffold
  DX4 Package Conformance
  first old-domain extraction pilot

Before AX3:
  DX5 Project Verify
  DX6 Scenario Runner
  DX9 Context Pack
  DX10 Plan-to-Implementation Evidence
```

Toolkit work does not displace M14b2 or M15. A developer toolkit for a framework
whose domains are half-built optimizes the wrong thing.

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
