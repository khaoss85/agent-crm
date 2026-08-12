# The coding-agent DX North Star

**Status: canonical decision rule.** This document does not describe a feature.
It describes how this repository decides whether a new agent-facing primitive
should exist at all, and it is the document a reviewer cites when the answer is
no.

Its sibling, `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`, describes the *product*
experience a user should get. This one describes the *engineering discipline*
that keeps that experience from being buried under the machinery built to
deliver it.

---

## The North Star

> **Goal-first outside, rigorous inside.**

The user states a business goal. The rails are selected by the workflow, not
hand-orchestrated by the user. Every rail may be rigorous, deterministic and
opinionated *inside* — that is what makes the result trustworthy — but none of
that rigour may leak outward as a step the user has to perform, sequence or
remember.

A user who has to know that `app inspect` comes before `solution check`, which
comes before `package scaffold`, has been handed our implementation as their
workflow. That is the failure this North Star exists to prevent.

---

## The story the rails tell

One shape, so a reader can hold the whole surface at once:

```text
GOAL
  → SEE       what exists                        App Inspect (AX1)
  → PLAN      what to build                      Solution Plan (AX2)
  → BUILD     a conforming start, then the work  Package Scaffold (DX3) + the agent
  → CHECK     inconsistencies, and the rules     Project Doctor (DX1) + Package Conformance (DX4)
  → PROVE     that it works                      Quality Gates + Project Verify (DX5)
              which business jobs it earns        Scenario Evidence (DX6, two scenarios); DX10 is future

Refactor-only:
  → PRESERVE  freeze behaviour before changing it   LA0 Characterization
```

**It is a story, not a sequence a user performs.** A user gives a goal;
`solve-business-goal` chooses the minimum rails internally, and a pure refactor
takes PRESERVE and may skip PLAN. This is the goal-first rule applied to the
rails themselves: if a user ever has to know that SEE precedes PLAN, the story
has leaked out as a workflow, and that is the failure this document exists to
prevent.

The worked example is checked in rather than described:
`docs/evidence/lead-intelligence-extraction.md`.

Roadmap and category framing that follow from this:
`docs/strategy/CUSTOMER_REVENUE_OS_ROADMAP.md`.

## The complexity budget

> **New internal complexity is justified only if it reduces perceived
> user/agent complexity, or measurably improves reliability or evidence.**

This is a permanent rule, not a phase. It is deliberately asymmetric: internal
complexity is *allowed to grow*, and it has grown — a package contract, a
conformance kit, a characterization harness. Each was justified by something
that became simpler or provable on the outside. None was justified by being
interesting.

### The eight questions

Every new agent-facing command, tool, contract or namespace must answer all
eight, in the PR that introduces it:

1. **Which concrete agent failure mode does it prevent?** Name the failure, not
   the capability. "Agents invent an architecture that already exists" is a
   failure mode; "discovery" is not.
2. **Why are existing primitives insufficient?** Show the attempt. If an
   existing command *almost* does it, extending it usually beats adding one.
3. **Does it overlap semantically with an existing tool?** Two commands that
   answer nearly the same question are worse than one that answers it
   completely — the agent now has to choose, and will choose wrong.
4. **Can it remain deferred or on-demand?** Most things can. A namespace that
   only matters while authoring a package should not occupy the surface of every
   session.
5. **Does it preserve Claude / Codex / Gemini portability?** If the behaviour
   lives anywhere but a CLI, a JSON contract, the Package Contract, canonical
   Skill semantics or the Quality Gates, the answer is no.
6. **What machine-readable evidence proves its value?** An exit code, a
   contract-versioned document, a fingerprint, a measured number. "It feels
   better" is not evidence.
7. **Does horizontal impact update the Compatibility Backfill and the Legacy
   Alignment Matrix?** A capability every domain could use, recorded for one
   domain only, is a fork.
8. **Does the end-user goal flow become simpler, not more manual?** If the
   answer is "the agent now has one more thing to run", the primitive has failed
   question 1.

A primitive that cannot answer these is not blocked forever. It is blocked until
somebody can name the failure it prevents.

---

## The rails, and what is real

Every entry below is either **implemented** and verifiable by a command, or
**future** and marked as such. Nothing in between.

| Rail | What it answers | Status |
|---|---|---|
| **Project Bootstrap** | give me a project to work in, from nothing | **implemented and deterministically packaged, not published** — `create-accordo <dir> --apply` scaffolds from a checkout; the assembled candidate packs, installs offline and runs end to end; `npm create accordo` still reaches an empty name reservation and installs nothing |
| **AX1 — application discovery** | what is this application already? | **implemented** — `crm app inspect --json` |
| **AX2 — Solution Plan** | is this plan valid, and still compatible? | **implemented** — `crm solution inspect\|validate\|check` |
| **DX1 — Project Doctor** | what is inconsistent or stale before I edit? | **implemented** — `crm project doctor --json` |
| **DX3 — Package Scaffold** | give me an empty package that already conforms | **implemented** — `crm package scaffold` |
| **DX4 — Package Conformance** | does this package satisfy the framework contract? | **implemented** — `crm package test --json` |
| **Quality Gates** | what must a change prove before it merges? | **implemented** — `docs/QUALITY_GATES.md` |
| **LA0 — legacy characterization** | does a refactor preserve behaviour? | **implemented** — `tests/characterization/`, `npm run characterize:intelligence` |
| DX2 — Skill mirror sync | do the harness mirrors agree, and stay agreeing? | **future, and now a reconciliation** — the mirrors currently agree (12/12, doctor `passed`) because they were aligned by hand on main. Project Doctor detects disagreement and by design never writes: no canonical source, no sync command, no CI drift gate, no adapter generation |
| **DX5 — Project Verify** | can I prove this project is healthy enough to hand back? | **implemented** — `crm project verify --json`. Four things are test-pinned rather than described: project-health orchestration behind a blocking doctor preflight; conformance actually **executed** for every composed package with local source, first-party or customer-authored, so one non-conforming package fails the run; the doctor's plan verdicts carried verbatim, with a declared-**required** stale plan failing and a declared-**current** one warning; and **dirty-mutation detection** from a before/after pair of worktree samples, which never resets, stashes or cleans. PROVE stays partial: DX10 does not exist |
| **DX6 — Scenario Runner** | which JTBD rows does this checkout actually earn, and which does it not? | **implemented, with two consumers** — `crm scenario run <scenario> --json`, `scenarioRunContract: 2`. Two checked-in scenarios run two checked-in journeys: a sales funnel on the wall clock over a six-package composition, and a service case → SLA evaluation → escalation story on an **injected, stepped clock** over a two-package one. The second consumer is what makes the contract a contract rather than a shape fitted to the first, and it changed three things: journey evidence gained stated **facts** beside counts, the report now publishes **which clock** produced the evidence, and limitations gained a **scope** so a journey declares its own. Coverage is still *claimed*, not discovered, and PROVE stays partial: DX10 does not exist |
| DX9 — Context Pack | what does an agent need to know, compactly? | **future** |
| DX10 — Implementation Evidence | is the plan actually finished? | **future** |
| DX13 — MCP parity | the same contracts as tools | **future** — policy in `docs/architecture/AGENT_TOOL_SURFACE.md` |

---

## Failure-mode mapping

The rails exist because of specific, observed ways coding agents get CRM work
wrong. Each row names the failure first.

| Agent failure mode | The rail | Status |
|---|---|---|
| inventing an architecture that already exists in the project | AX1 discovery, AX2 plan, the package/module/action/policy hierarchy | implemented |
| building a second package that duplicates an installed domain | AX1 discovery + Solution Plan citation | implemented |
| working from a plan written against an application that has since moved | `crm solution check` → `PLAN_STALE` | implemented |
| producing a package the framework will not accept | DX3 scaffold (start conforming) + DX4 conformance (prove it) | implemented |
| editing a project whose composition, module state, plans, Skills or links are already broken | DX1 Project Doctor | implemented |
| refactoring a domain and silently changing what it decides | LA0 characterization | implemented |
| drowning in tools, then picking the wrong one | Agent Tool Surface: tiered, deferred, searchable namespaces | policy implemented, tools future |
| mutating a project while claiming to inspect it | read/write separation, dry-run defaults, explicit `--apply`, human approval boundaries | implemented |
| non-reproducible answers that cannot be diffed or trusted | deterministic contracts, canonical JSON, fingerprints, stable exit codes | implemented |
| claiming a checkout supports a business job because a test filename sits next to that row in a Markdown table, with no way to state what a run did *not* establish | DX6 Scenario Runner | implemented, two consumers |
| shipping a generic contract validated by exactly one consumer, so its accidental assumptions read as principles | a second, deliberately unlike consumer — `examples/scenarios/service-sla-escalation.scenario.json` | implemented for DX6; unaddressed for every other contract |
| reporting a plan complete while work is missing | DX10 Implementation Evidence | **future** |
| exhausting context on a project it cannot summarize | DX9 Context Pack | **future** |

---

## Portability

The target is **Claude Code, Codex, Gemini and generic AGENTS-compatible
agents** — through deterministic contracts, never model-specific hidden logic.

Core behaviour belongs in exactly five places:

```text
the CLI                 a command, arguments, and an exit code
JSON contracts          contract-versioned, canonically ordered, fingerprinted
the Package Contract    definePackage, capabilities, policies, resources
canonical Skill semantics   one meaning, mirrored per harness
the Quality Gates       what a change must prove
```

Harness adapters stay **thin**. A `.claude/` file and its `.agents/` mirror carry
the same semantics; if one of them starts carrying behaviour the other cannot,
the behaviour is in the wrong place. `crm project doctor` grades the two ways
mirrors can disagree differently, for exactly this reason: two copies of one
skill whose *contents* diverge is `skills.mirror-drift`, a **failure**, because
each harness is now being told something different; a skill that exists under
one mirror only is `skills.mirror-coverage`, a **warning**, because one harness
is merely uninformed. Neither check edits source — reconciliation is DX2.

The practical test: *could a different agent, given only the CLI and the JSON,
do this correctly?* If not, it is not portable, whatever the docs say.

---

## What this document is not

- Not a roadmap. `EXECUTION_ROADMAP.md` and `CODER_TOOLING_ROADMAP.md` sequence
  work; this decides whether work should exist.
- Not permission to build any future rail listed above.
- Not marketing. Positioning claims live in
  `GTM_TECHNICAL_EVIDENCE_HANDOFF.md`, which is bounded by evidence and by an
  explicit list of things not to claim.

## Related

`docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md` (the product experience) ·
`docs/architecture/AGENT_TOOL_SURFACE.md` (tool tiers and namespaces) ·
`docs/CODER_TOOLING_ROADMAP.md` · `docs/QUALITY_GATES.md` ·
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` (the Compatibility Backfill Rule) ·
`AGENTS.md` (the DX Simplicity Gate, which links here)
