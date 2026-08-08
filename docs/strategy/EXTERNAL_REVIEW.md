# External review — fitness for serious agent-driven building

An outside assessment of how well this framework serves a coding agent (Claude Code,
Codex, Gemini CLI) doing real work rather than a demo. Recorded here because the
most useful thing in it is not the praise; it is one risk and four gaps, and both
are easy to lose track of.

**Not our words.** The assessment is a reviewer's, kept as given. What this
repository adds is the mechanism at the end.

## The scores, as given

| Area | Score |
|---|---|
| Comprehensibility for a coding agent | 9/10 |
| Safety / fail-closed | 9/10 |
| Determinism and verifiability | 9.5/10 |
| Tool and context handling | 9/10 |
| Ease of extension | 9/10 |
| **"Give me the goal and do it all" today** | **7.5/10** |
| Target once the remaining roadmap pieces land | 9+/10 |

Architecture close to 9/10; end-to-end experience today around 7.5–8. The gap
between those two numbers is the whole finding.

## What the reviewer thought was working

The framework does not ask the model to be good. It builds rails that can be
checked. The path a goal now takes:

```text
goal → AX1 what exists? → AX2 what must be built? → project doctor
     → package scaffold → package conformance → domain tests
     → characterization (did a refactor preserve behaviour?)
     → implementation evidence (was it actually all done?)
```

Against the failure modes a coding agent normally has, the reviewer mapped a
specific countermeasure to each: inventing architecture (AX1 + AX2 + the
configure→extend→provider→custom→kernel ladder), duplicating what exists (package
and capability discovery), inventing a capability (AX1 fail-closed), declaring
completion that has not happened (JTBD evidence, and ImplementationEvidence when
it lands), a package that works only where it was generated (package conformance),
an incoherent project (doctor), a refactor that changes behaviour
(characterization), tool overload (namespaces and a deferred surface), risky
actions (read/write separation and human approval), and a model asserting
certainty it does not have (the facts / assumptions / inference / unavailable
vocabulary).

The distinctive part, in the reviewer's framing: *the framework does not try to
replace the coding agent — it builds an environment where the agent has much less
freedom to be wrong and much more ability to prove what it did.*

## The risk that matters

Not that an agent will make a mess of the code. Close to the opposite:

> You could build so much infrastructure to help Claude that the Claude experience
> becomes too complex.

`inspect`, `doctor`, `solution`, `scaffold`, `validate`, `package test`,
characterization, quality gates, skills, JTBD — every one is justified, and **a
person building with this must not have to know any of them.** The experience
cannot become "first run AX1, then AX2, then Doctor, then scaffold, then
validate". It has to stay "build me a CRM that does X", with
`solve-business-goal` deciding internally which rungs this particular goal needs.

The principle the reviewer drew out, which is the one worth keeping:

> **Internal complexity may grow. Perceived complexity must fall.**

Two secondary risks were assessed and found already handled: context overload
(the tool-surface policy in `docs/architecture/AGENT_TOOL_SURFACE.md` — a hundred
internal capabilities must not become a hundred tools) and overfitting to Claude
Code (the load-bearing parts — JSON contracts, the CLI, the package contract, AX1,
AX2, conformance, doctor, scaffold, quality gates, evidence — are all
machine-readable, so Claude, Codex and Gemini are harnesses over one protocol
rather than three divergent integrations).

## The mechanism this repository added in response

A principle in a strategy document erodes one reasonable addition at a time. So
it is a number: `scripts/surface-check.js`, run by `npm run gtm:check` in CI and
on the deploy.

| Measure | Today | Ceiling |
|---|---:|---:|
| Goal entry points | 1 | 1 |
| Skills | 11 | 12 |
| Always-on MCP tools | 9 | 10 |
| Distinct commands named across all skills | 8 | 10 |

Every ceiling carries the argument for where it sits, and raising one is an edit
to that file with the argument attached. The check also refuses a skill whose
description never says what it is *not* for — the description is the only thing a
harness matches on, so a skill without a routing clause competes with the front
door. Two skills were missing one when the budget was first run.

`tests/surface-budget.test.js` proves the budget bites: a second goal-shaped
skill fails it, a skill with no routing clause fails it, growing past the skill
ceiling fails it, and — the case that is easy to forget — *losing* the front door
fails it too, because a goal-shaped request matching nothing is the same failure
as one matching two things.

## The four gaps between 7.5 and 9

In the reviewer's order. Each is already on the roadmap; this is the argument for
why these four and not others.

1. **Context Pack (DX9)** — the agent reads only what this goal needs, instead of
   everything that might matter.
2. **Implementation Evidence (DX10)** — automatically demonstrate which parts of a
   Solution Plan were actually built, so "done" stops being a claim.
3. **Project Verify / Scenario Runner (DX5, DX6)** — one final machine-readable
   proof rather than a sequence a human assembles.
4. **Legacy Alignment** — Lead Intelligence, Commercial Operations and Signature &
   Order behave like modern packages, so the ladder has no exceptions
   (`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`).

With those, the reviewer's expected experience is: *"build me Lead → Won with
attribution and a campaign to recover the drop"*, and the agent discovers, plans,
picks packages, creates the missing one, implements, verifies, corrects and
reports — without the person ever learning what package conformance is.

## The standing recommendation

> Do not add new abstractions without demonstrated need.

Recorded here so that the next addition has to argue against it. The surface
budget is the enforcement; this sentence is the reason.
