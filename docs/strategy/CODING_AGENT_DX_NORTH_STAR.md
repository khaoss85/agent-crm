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
| **AX1 — application discovery** | what is this application already? | **implemented** — `crm app inspect --json` |
| **AX2 — Solution Plan** | is this plan valid, and still compatible? | **implemented** — `crm solution inspect\|validate\|check` |
| **DX1 — Project Doctor** | what is inconsistent or stale before I edit? | **implemented** — `crm project doctor --json` |
| **DX3 — Package Scaffold** | give me an empty package that already conforms | **implemented** — `crm package scaffold` |
| **DX4 — Package Conformance** | does this package satisfy the framework contract? | **implemented** — `crm package test --json` |
| **Quality Gates** | what must a change prove before it merges? | **implemented** — `docs/QUALITY_GATES.md` |
| **LA0 — legacy characterization** | does a refactor preserve behaviour? | **implemented** — `tests/characterization/`, `npm run characterize:intelligence` |
| DX2 — Skill mirror sync | do the harness mirrors agree? | **future** — the gap is real and reported today by Project Doctor as a warning |
| DX5 — Project Verify | does everything actually work? | **future** |
| DX6 — Scenario Runner | does it work for this business scenario? | **future** |
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
the behaviour is in the wrong place. `crm project doctor` reports mirror drift
as a failure for exactly this reason.

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
