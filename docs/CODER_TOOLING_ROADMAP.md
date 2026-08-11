# Coder tooling roadmap

The surfaces a coding agent uses to understand, plan and change an Accordo
project — what exists, what is next, and what is deliberately refused.

This is a roadmap, not a claim. Everything under **Shipped** has merged tests
behind it; everything below that is not available and must never be described as
if it were.

## Shipped

| | Surface | What it answers |
|---|---|---|
| — | `create-accordo <dir> [--apply] [--json]` | give me a project from nothing. It copies the framework into an empty directory and writes a project that boots with no install, reports `valid` from `app inspect` and exits 0 from `project doctor` (`projectBootstrapContract: 1`, `docs/plans/project-bootstrap-installability.md`). It reaches no network, composes no domain package and opens no database, and it is the one command that runs **before** the framework exists on disk — so it imports none of it. **It scaffolds from a checkout of this repository, and it is not published**: `npm create accordo` still reaches an empty name reservation and installs nothing, and nothing in this repository changes that |
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
| **DX1** | `crm project doctor --json` — **built** (`docs/plans/dx1-project-doctor.md`) | is this *project* internally consistent — composition, module-state and migration drift, generated-source drift, package dependencies, Skills, docs and hygiene? Distinct from `app inspect`, which describes a valid composition rather than diagnosing a broken checkout. It makes **no runtime or provider-health claim** unless a future explicit mode adds one |
| **DX2** | Skill portability: `crm agent skills sync\|check` | one canonical semantic source per skill plus deterministic adapters for Claude Code, Codex, Gemini and generic AGENTS-compatible agents, with a drift check in `verify`. `GEMINI.md` and `gemini-extension.json` now exist, and the `.claude/` and `.agents/` copies are byte-identical by hand rather than by generation. Each skill declares a `requires` block (`tier: repository \| generated-project \| any-project`, the surfaces it reads and what it `degradesTo`), and `skills/` is the published subset that holds no `tier: repository` skill; `scripts/distribution-check.js` and `tests/skill-parity.test.js` enforce both. That is the input DX2's adapters would consume, not DX2 itself |
### After M15 Service package learnings

| | Tool | Why it waits |
|---|---|---|
| **DX3** | `crm package scaffold <name>` — **built** (`docs/plans/dx3-package-scaffold.md`) | a deterministic, conforming skeleton: two files, an identity and five empty declarations, whose output passes DX4 with no manual edit. Dry-run by default, `--apply` to write, never an overwrite, never a silent rename. It generates **no** domain semantics, composes nothing, opens no database and installs nothing. Waiting for Service was right: the shape it bakes in is the empty one, which is the only shape four packages agreed on |
| **DX4** | `crm package test <path> --json` — **built** (`docs/plans/dx4-package-conformance-kit.md`) | conformance: declaration, boundaries, composition refusals, module manifests and migration identity, attach and detach against a real boot, and agreement with `app inspect`. It makes ADR-018's seam self-enforcing. Action execution, policy behaviour, state transitions and data-bearing upgrade stay out by design and are reported as named limitations, not as passes |
| **LA0** | Legacy Characterization Harness — **built** (`docs/plans/la0-legacy-characterization.md`) | **the extraction gate.** Freeze a domain's externally observable behaviour before the move, replay it after, and require every captured value to be identical: routes, SDK, `/api/schema`, Admin-visible behaviour, actions and workflows, audit/events/trace, migrations and data, restart, >500 exact reads, hostile input, AX1 and AX2. For Lead Intelligence it must additionally reproduce enrichment snapshots, signals, the score *and its model version and declared-definition fingerprint*, routing and capacity, assignments, lifecycle gating, provider fingerprints and target-set evidence. `crm package test` cannot answer this — it says so itself under `DOMAIN_CORRECTNESS_NOT_PROVEN` — and without LA0 the only proof available is "the existing tests still pass", which is exactly the proof that misses a boundary violation. Design: `docs/architecture/EXTRACTION_PREPARATION.md` |
| **—** | first existing-domain extraction pilot | one of Intelligence / Commercial / Signature moved out of core, once DX4 can prove the result still conforms. The per-domain status that decides the candidate is `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, which records **Lead Intelligence** as the working hypothesis and the evidence that must exist before it is chosen |

### Before an AX3 public benchmark

| | Tool | What it answers |
|---|---|---|
| **DX5** | `crm project verify --json` — **built** (`docs/plans/dx5-project-verify.md`) | machine-readable orchestration of the authorities that already decide: the doctor as a blocking preflight, AX1, the doctor's own plan verdicts, **package conformance executed for every composed package with local source**, and the project's **declared** verify and smoke scripts — part of the evidence AX1 publishes as `not_aggregated`. It samples the worktree before and after so it can say which paths *the run itself* changed, and it repairs none of them. A declared script whose entry point is not in the project is `not_applicable` with the missing file named, never a loader error reported as a suite failure. It says in its own limitations that it runs no business scenario and maps no plan to its implementation |
| **DX6** | `crm scenario run <scenario> --json` — **built** (`docs/plans/dx6-scenario-runner.md`, `docs/SCENARIO_EVIDENCE.md`) | which JTBD rows a checkout actually earns, from linked evidence rather than prose. A **checked-in declarative scenario** names a journey by id from a frozen registry in the runner's own source — it can carry no command, and a document with any problem starts nothing — then observations from a closed vocabulary are answered by the journey's own receipt and by AX1 over what it composed, and claims resolve against `docs/benchmarks/jobs.json`. It **promotes nothing**: the claim vocabulary is deliberately not the four-value JTBD status vocabulary, the index is read-only, and every report records that a person still decides. The honest negative — the counted, sectioned, fully enumerated set of rows the run did **not** establish — is a first-class field. Coverage is *claimed*, not discovered, and it drives no browser; both are published limitation codes |
| **DX9** | `crm context pack --plan plan.json --json` | the smallest deterministic context an agent needs, derived from AX1, AX2, the relevant package docs and Skills, schema and action contracts and the Quality Gates. Token-budgeted, deterministic, source-path references only — **no secrets, no PII, no data rows, no arbitrary source bodies**, fingerprinted for staleness, and **advisory only, never authorization** |
| **DX10** | `ImplementationEvidence` + `crm solution verify plan.json --json` | maps each SolutionPlan requirement to the package, module, action, provider, source files, tests, Admin/CLI evidence and JTBD evidence that satisfy it, marked `implemented \| partial \| blocked`. It closes `goal → plan → build → proof`, and stops an agent claiming a plan is complete while work is missing |

**An external review isolated exactly four of these as the gap between the
architecture's score and the experience's** — DX9 Context Pack, DX10 Implementation
Evidence, DX5/DX6 Project Verify and Scenario Runner, and the Legacy Alignment
pass. It also named the risk that comes with building them: every one of these
commands is justified, and a person building with this framework must not have to
know any of them exists. `solve-business-goal` decides which rungs a goal needs;
the user states the goal. That is enforced, not just intended —
`scripts/surface-check.js` budgets the surface an agent has to understand and
fails the build when it grows (`docs/strategy/EXTERNAL_REVIEW.md`).

**AX3 depends on DX5, DX6, DX9 and DX10**, not the other way round. A benchmark
whose evidence is prose is a benchmark nobody can check.

### Review and maintenance

| | Tool | What it answers |
|---|---|---|
| **DX7** | `crm change inspect --base main --json` | maps a diff to the packages, capabilities, modules, migrations, actions, tests, Quality Gates, JTBD rows and docs it touches |
| **DX8** | `crm explain <ERROR_CODE> --json` | every published problem code in one place: meaning, likely causes, retryability, safe diagnostics and the doc that covers it |
| **DX11** | `crm upgrade plan --json` | package and capability compatibility, the Module Evolution and migration work a version bump requires, and the tests that must pass |
| **DX12** | provider contract test kit | tracked with the Integration Runtime: config, timeout, late settlement, idempotency, webhook, rate limits, sandbox, secret hygiene and error shape |
| **DX13** | Project MCP parity | the stable CLI contracts mirrored as read surfaces — `app_inspect`, `solution_check`, `doctor`, `verify`, `scenario`, `change_inspect`, `explain`, `context_pack`, `trace_query`. **Remote mutation stays Production-Spine and human-approval work.** The exposure policy — nine commitments (CLI-first, a capability is not a tool, a package is not a tool, job-oriented tools, a small always-on surface, deferred namespaces, read separated from mutation, a dynamic allow-list, human approval for sensitive mutation), four tiers, and what may never become a tool at all — is written first in `docs/architecture/AGENT_TOOL_SURFACE.md`, which is strategy, not implementation |

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
  M14b2 merged; M15 Service on an open PR, awaiting adversarial review

Parallel / immediately after:
  DX1 Project Doctor
  DX2 Skill sync/check

Then:
  review the M15 learnings against the seam

After Service learning:
  DX4 Package Conformance                                    built
  DX3 Package Scaffold                                       built
  DX1 Project Doctor                                         built
  LA0 Legacy Characterization Harness                        built — the gate
  the controlled Legacy Domain Alignment Pass — one domain, one PR

Before AX3:
  DX5 Project Verify                                         built
  DX6 Scenario Runner                                        built
  DX9 Context Pack
  DX10 Plan-to-Implementation Evidence
```

PROVE is **still partial** with DX5 and DX6 built: DX10 does not exist, so
nothing maps a plan's requirements to the code that implements them, and no
green report means a plan is finished.

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
`docs/architecture/AGENT_TOOL_SURFACE.md`,
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md` (the AX section).
