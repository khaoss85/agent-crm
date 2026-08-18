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
| AX1 | `accordo app inspect [--json]` | what has this project actually composed — packages, the resolved capability graph, records and revisions, actions, policies, providers, and eleven machine-readable limitations |
| AX2 | `accordo solution inspect\|validate\|check` | what are you going to do about it, and on what evidence — a bounded plan contract, bound to a real AX1 report |
| — | `crm package validate\|inspect <dir>` | one package in isolation, through the validator the application runs at startup |
| — | `crm module plan\|create\|validate\|migration` | the module factory: a manifest becomes a complete runnable record, dry-run unless `--apply` |
| — | `GET /api/schema` | the same picture from a running server, function-free |
| — | the MCP server | the same operations over MCP, code-generating actions dry-run by default |
| **DX1** | `accordo project doctor --json` (`docs/plans/dx1-project-doctor.md`) | is this *project* internally consistent — composition, module-state and migration drift, generated-source drift, package dependencies, Skills, docs and hygiene? Distinct from `app inspect`, which describes a valid composition rather than diagnosing a broken checkout. It makes **no runtime or provider-health claim** unless a future explicit mode adds one |
| **DX3** | `crm package scaffold <name>` (`docs/plans/dx3-package-scaffold.md`) | a deterministic, conforming skeleton: two files, an identity and five empty declarations, whose output passes DX4 with no manual edit. Dry-run by default, `--apply` to write, never an overwrite, never a silent rename. It generates **no** domain semantics, composes nothing, opens no database and installs nothing. Waiting for Service was right: the shape it bakes in is the empty one, which is the only shape four packages agreed on |
| **DX4** | `crm package test <path> --json` (`docs/plans/dx4-package-conformance-kit.md`) | conformance: declaration, boundaries, composition refusals, module manifests and migration identity, attach and detach against a real boot, and agreement with `app inspect`. It makes ADR-018's seam self-enforcing. Action execution, policy behaviour, state transitions and data-bearing upgrade stay out by design and are reported as named limitations, not as passes |
| **LA0** | Legacy Characterization Harness (`docs/plans/la0-legacy-characterization.md`) | **the extraction gate.** Freeze a domain's externally observable behaviour before the move, replay it after, and require every captured value to be identical: routes, SDK, `/api/schema`, Admin-visible behaviour, actions and workflows, audit/events/trace, migrations and data, restart, >500 exact reads, hostile input, AX1 and AX2. For Lead Intelligence it must additionally reproduce enrichment snapshots, signals, the score *and its model version and declared-definition fingerprint*, routing and capacity, assignments, lifecycle gating, provider fingerprints and target-set evidence. `crm package test` cannot answer this — it says so itself under `DOMAIN_CORRECTNESS_NOT_PROVEN` — and without LA0 the only proof available is "the existing tests still pass", which is exactly the proof that misses a boundary violation. Design: `docs/architecture/EXTRACTION_PREPARATION.md` |
| **DX5** | `accordo project verify --json` (`docs/plans/dx5-project-verify.md`) | machine-readable orchestration of the authorities that already decide: the doctor as a blocking preflight, AX1, the doctor's own plan verdicts, **package conformance executed for every composed package with local source**, and the project's **declared** verify and smoke scripts — part of the evidence AX1 publishes as `not_aggregated`. It samples the worktree before and after so it can say which paths *the run itself* changed, and it repairs none of them. A declared script whose entry point is not in the project is `not_applicable` with the missing file named, never a loader error reported as a suite failure. It says in its own limitations that it runs no business scenario and maps no plan to its implementation |
| **DX6** | `accordo scenario run <scenario> --json` (`docs/plans/dx6-scenario-runner.md`, `docs/SCENARIO_EVIDENCE.md`) | which JTBD rows a checkout actually earns, from linked evidence rather than prose. A **checked-in declarative scenario** names a journey by id from a frozen registry in the runner's own source — it can carry no command, and a document with any problem starts nothing — then observations from a closed vocabulary are answered by the journey's own receipt and by AX1 over what it composed, and claims resolve against `docs/benchmarks/jobs.json`. It **promotes nothing**: the claim vocabulary is deliberately not the four-value JTBD status vocabulary, the index is read-only, and every report records that a person still decides. The honest negative — the counted, sectioned, fully enumerated set of rows the run did **not** establish — is a first-class field. Coverage is *claimed*, not discovered, and it drives no browser; both are published limitation codes. **Two consumers ship**, and the second is what makes the contract a contract rather than a shape fitted to the first: a service case → SLA evaluation → escalation story, on an **injected, stepped clock**, over a two-package composition. Serving it changed three things — journey evidence gained stated **facts** beside numeric counts (a count cannot say whether the SLA said the right thing), the report now publishes **which clock** produced the evidence (an SLA state is a function of the clock and of nothing else), and limitations gained a **scope** so a journey declares its own instead of every run carrying every disclaimer. The report contract moved to 2; the document contract stayed at 1, because every v1 scenario still validates (`docs/plans/dx6-second-scenario.md`) |
| **DX10** | `accordo solution verify <plan.json> --evidence <evidence.json> --json` (`docs/plans/dx10-implementation-evidence.md`, `docs/IMPLEMENTATION_EVIDENCE.md`) | for every requirement in a checked-in SolutionPlan, what implementation evidence proves it is implemented, partial or blocked — and what is still unproven. It closes `goal → plan → code → Project Verify / Scenario Evidence → requirement-level proof`. A **requirement** is a plan step or an acceptance check, addressed by an identifier **derived** from the plan (`step:<stepId>`, `check:<32 hex of the statement>`), which adds nothing to `solutionPlanContract: 1` and moves no plan's fingerprint. A checked-in `implementationEvidenceContract: 1` document declares **where to look** and has **no status field anywhere**: the verifier obtains current facts from AX1, the plan binding, Project Verify, Package Conformance and each explicitly referenced scenario, and decides. The evidence vocabulary is closed, and the sufficiency matrix is the point — **`file exists` never satisfies a behavioural requirement, and neither does `the action is declared`**; a purely structural one needs no scenario. **Manual evidence is accepted and can never be proof**: it resolves to `unverified` and forbids exit 0 on its own. There is **no write mode, no `--fix`, no generation command and no `test` evidence kind** — no authority publishes which tests ran, so a test name would be a claim dressed as a citation. A declared category may only **raise** the authority a requirement needs, never lower it: an acceptance check is untyped in `solutionPlanContract: 1`, so it is graded at a behavioural floor. Two checked-in evidence documents ship against two real plans, and **both exit 1**, which is the true state of both plans; one further labelled **verifier fixture** exits 0 in about six seconds so the exit-0 arm is exercised end to end without any product claim |

## Not built, with identifiers so they can be referenced

**Nothing below is implemented, and nothing below ships in a delivery
milestone.** Each is named so a plan, an ADR or a PR can point at it without
re-describing it. Seven rungs that were once in this section — DX1, DX3, DX4,
LA0, DX5, DX6 and DX10 — have shipped and moved up into **Shipped**; a rung
appears in exactly one of the two sections, never both.

### Skill portability

| | Tool | What it answers |
|---|---|---|
| **DX2** | Skill portability: `crm agent skills sync\|check` | one canonical semantic source per skill plus deterministic adapters for Claude Code, Codex, Gemini and generic AGENTS-compatible agents, with a drift check in `verify`. **The portable mirrors and the distribution exist; the mechanism does not.** `GEMINI.md` and `gemini-extension.json` are checked in, the `.claude/` and `.agents/` copies are byte-identical, each skill declares a `requires` block (`tier: repository \| generated-project \| any-project`, the surfaces it reads and what it `degradesTo`), `skills/` is the published subset that holds no `tier: repository` skill, and `scripts/distribution-check.js` and `tests/skill-parity.test.js` enforce both. What is missing is DX2 itself: there is no canonical source the mirrors are generated **from**, no sync command, no adapter generation and no CI drift gate. Project Doctor detects a disagreement and by design never writes one away. The mirrors agree today because people aligned them by hand |

### The first extraction

| | Tool | Why it waits |
|---|---|---|
| **—** | first existing-domain extraction pilot | one of Intelligence / Commercial / Signature moved out of core, once DX4 can prove the result still conforms. The per-domain status that decides the candidate is `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, which records **Lead Intelligence** as the working hypothesis and the evidence that must exist before it is chosen |

### Before an AX3 public benchmark

| | Tool | What it answers |
|---|---|---|
| **DX9** | `crm context pack --plan plan.json --json` | the smallest deterministic context an agent needs, derived from AX1, AX2, the relevant package docs and Skills, schema and action contracts and the Quality Gates. Token-budgeted, deterministic, source-path references only — **no secrets, no PII, no data rows, no arbitrary source bodies**, fingerprinted for staleness, and **advisory only, never authorization** |

**An external review isolated exactly four rungs as the gap between the
architecture's score and the experience's** — DX9 Context Pack, DX10 Implementation
Evidence, DX5/DX6 Project Verify and Scenario Runner, and the Legacy Alignment
pass. **Three of the four are now closed**: DX5, DX6 and DX10 are built and sit
under Shipped. DX9 and the Legacy Alignment pass remain open. **PROVE is still
partial, and DX10 is no longer the reason** — the rung exists; no checked-in
plan in this repository is fully machine-verifiable, so nothing exits 0 yet, and
the condition is now machine-checkable rather than rhetorical.
The review also named the risk that comes with building them: every one of these
commands is justified, and a person building with this framework must not have to
know any of them exists. `solve-business-goal` decides which rungs a goal needs;
the user states the goal. That is enforced, not just intended —
`scripts/surface-check.js` budgets the surface an agent has to understand and
fails the build when it grows (`docs/strategy/EXTERNAL_REVIEW.md`).

**AX3 depends on DX5, DX6, DX9 and DX10**, not the other way round. A benchmark
whose evidence is prose is a benchmark nobody can check.

One AX3 instrument exists and is a **pilot, not a public benchmark**:
`docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md` observes whether a coding agent given
a job-shaped prompt selects the right rail, in the right order, without premature
mutation. It adds no command, tool, runtime or routing layer, and it publishes nothing —
its first run is recorded in `docs/benchmarks/TOOL_SELECTION_PILOT_2026-08-13.md`, where
two of three arms were unavailable and no rate was derived. That run's sharpest
observation — sessions that load the instructions and then wander through generic
repository search without selecting any rail — is answered, as guidance and nothing
else, by the "Selecting an Accordo rail" section in `CLAUDE.md` and `AGENTS.md`.
Whether guidance moves selection is a question the instrument answers by re-running
the same frozen cells rather than by prose; `docs/PROJECT_STATUS.md` tracks the
second panel until its record merges.

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
Built, in the order they landed:
  DX4 Package Conformance
  DX3 Package Scaffold
  DX1 Project Doctor
  LA0 Legacy Characterization Harness                        the extraction gate
  DX5 Project Verify
  DX6 Scenario Runner                                        two consumers
  DX10 Implementation Evidence                               two plan consumers

Now:
  M14b2, M15 Service and M16a renewal & expansion are all merged.
  The default product task is the first unchecked item in TASKS.md.

Next, and unbuilt:
  DX2 Skill sync/check                                       mirrors exist; no mechanism
  the controlled Legacy Domain Alignment Pass — one domain, one PR

Before AX3, and unbuilt:
  DX9 Context Pack
```

PROVE is **still partial** with DX5, DX6 and DX10 built, and the reason has
changed rather than gone away. A plan's requirements are now mapped to
machine-checkable evidence, and the first honest answer that mapping produced is
that the one plan this repository declares current is **not implemented** — two
requirements blocked, one manual, one partial. That is the rung working. What
keeps PROVE partial is that no checked-in plan exits 0, a manual requirement
stays unverified whatever else passes, coverage is still *claimed* rather than
discovered, and no browser, provider, deployment or live system is observed
anywhere. DX6 also stays a separate command from DX5: each scenario composes a
whole application, so folding them into Project Verify would make it silently
multi-minute. DX5 keeps publishing `SCENARIO_EVIDENCE_NOT_RUN`, and its
`IMPLEMENTATION_EVIDENCE_NOT_MAPPED` limitation now names the command that maps
it — DX10 runs DX5, never the other way round.

Toolkit work does not displace domain work. A developer toolkit for a framework
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
`docs/SCENARIO_EVIDENCE.md`, `docs/IMPLEMENTATION_EVIDENCE.md`,
`docs/AGENT_HARNESS_COMPATIBILITY.md`, `docs/PACKAGE_AUTHORING.md`,
`docs/MODULE_FACTORY.md`, `docs/MCP.md`,
`docs/architecture/AGENT_TOOL_SURFACE.md`,
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md` (the AX section).
