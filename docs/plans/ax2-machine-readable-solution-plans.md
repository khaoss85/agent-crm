# ExecPlan — AX2: Machine-readable Solution Plans

**Status: implemented, this PR (open, unmerged).** Adds
`packages/core/src/solution-plan.js` and the `crm solution` CLI commands.
Companion: AX1 (`docs/APPLICATION_INSPECTION.md`). Guide:
`docs/SOLUTION_PLAN.md`. Agent instructions:
`.claude/skills/solve-business-goal/SKILL.md` and its `.agents/` mirror.

## The gap AX1 left open

AX1 answers *what has this project actually composed*. It is deterministic,
machine-readable and complete about its own limits. What it cannot do is
answer the next question: **what are you going to do about it, and on what
evidence.**

Today the answer is prose. `solve-business-goal` §5 asks for a Solution Plan
with sixteen named parts, and every agent writes it differently — different
section names, different order, different words for "we do not know". A human
reviewing two plans cannot diff them; a second agent picking one up cannot read
it; and nothing can check whether the application the plan was written against
is still the application in front of you.

AX2 makes the plan a **document with a contract**, exactly as AX1 made the
inspection one.

## What this is not

It is not a planner. There is **no built-in LLM**, no agent runtime, no
orchestrator, and nothing here executes a plan, modifies source, installs a
package, configures a provider or deploys anything. AX2 defines a shape, checks
a plan against it, and binds it to a real AX1 report. Who writes the plan and
who carries it out are both outside this contract.

A plan also **cannot carry executable shell commands as trusted actions**. A
step names a decision type and the seam it uses; it never carries a command
that a reader is invited to run. That boundary is enforced by the validator,
not documented as a convention.

## Three designs compared

**1. A free-form template with required headings.** Cheapest, and it fails at
the thing that matters: nothing can check it. A heading is not a contract, and
"Assumptions" holding an inference is undetectable.

**2. A general workflow/DAG format with typed steps and effects.** Expressive
enough to describe execution — which is precisely the problem. A format that
can describe execution invites a runtime, and the first runtime that reads a
plan is one source edit away from applying it. **Rejected on the same ground
the kernel rejects an expression language over money.**

**3. A bounded declarative document, validated and bound to AX1 (chosen).** A
fixed contract version, a closed vocabulary for every classification a reader
acts on, an explicit evidence model, and a fingerprint tying it to the
composition it was written against. It describes intent and evidence; it cannot
describe execution.

## The contract

`solutionPlanContract: 1`. The top-level shape is stable and every list is
sorted by identity:

```json
{
  "solutionPlanContract": 1,
  "revision": 1,
  "fingerprint": "…",
  "goal": {},
  "metric": {},
  "application": {},
  "evidence": {},
  "decisions": [],
  "steps": [],
  "approvals": [],
  "acceptance": {},
  "limitations": [],
  "problems": []
}
```

`revision` is the plan's own generation, bumped by its author whenever anything
below it changes. `fingerprint` is derived from the canonical bytes of
everything except `fingerprint` and `problems`, so two plans that say the same
thing hash the same and a silent edit cannot hide.

## Six decision types, and nothing else

The repository already has a decision hierarchy —
`solve-business-goal` "try each rung before the next". AX2 makes each rung a
value, so a plan cannot blur "we configured something" into "we wrote a
package":

| Type | What it means | Rung |
|---|---|---|
| `configure` | a policy version, a config value or a view on an installed package | 1 |
| `extend` | an action, a policy or a record through a package's declared seam | 2 |
| `provider` | add or configure a provider — the gap is an integration, not a model | 3 |
| `evolve` | a record gains a field or a state: bump its manifest revision (ADR-019) | 2 |
| `create-package` | no installed package owns this domain (`definePackage`) | 4 |
| `propose-kernel-capability` | a generic runtime gap, raised as an ADR discussion | 5 |

`propose-kernel-capability` is deliberately in the list so a plan can *say*
it — and the validator refuses to let it appear in `steps`, because rung 5 is a
proposal you write, never a step you take.

## Evidence, in six categories and no others

The order is the order `solve-business-goal` already publishes, and the
validator enforces both the set and what may appear in each:

```text
observedFacts        what the data says, with the query and its version
derivedMetrics       what was computed, and how
assumptions          what was taken as true without evidence
inferences           what follows from facts plus assumptions
recommendations      what to do, traceable to the rows above
unavailableEvidence  what could not be checked, and why
```

Every `derivedMetric` and every `inference` cites the ids it derives from, and
the validator refuses a citation that does not resolve. An unavailable-evidence
entry carries a reason, never an empty slot: a gap that is stated is part of the
deliverable, and a gap that is omitted is a claim.

## Bound to a real application, or stale

A plan records the AX1 report it was written against:

```json
{ "applicationInspectionContract": 1,
  "compositionFingerprint": "…",
  "packages": [{ "name": "delivery", "version": 3 }],
  "capabilities": [{ "name": "delivery-economics", "version": 1, "status": "resolved" }] }
```

`crm solution check` re-runs AX1 and compares. A composition that has moved
since the plan was written produces `PLAN_STALE` with the specific difference —
a package version, a capability that stopped resolving, a record revision.
A plan whose premises have changed is not a plan, and reading one as if it were
is how an agent confidently builds on a capability the application no longer
has.

Every capability a step depends on must appear as `resolved` in the bound
report. A step citing a capability the application does not have is
`CAPABILITY_NOT_AVAILABLE`, not a TODO.

## Approvals: a closed vocabulary

`solve-business-goal` §9 lists the sensitive boundaries in prose. AX2 makes
them codes, so a plan cannot invent a softer word for "spend money":

```text
publish_production · external_communication · activate_journey
change_live_audience · sensitive_data · launch_ads
create_or_increase_spend · install_or_configure_provider · change_secrets
auto_apply_experiment_winner · irreversible_or_destructive
```

A step whose decision type is `provider` **must** carry
`install_or_configure_provider`; the validator adds the requirement rather than
trusting the author to remember it. Approval here is a **human-actor boundary,
not RBAC** — the plan says so in `limitations[]`, and the validator refuses a
plan that claims otherwise.

## The CLI

```bash
npm run crm -- solution inspect <plan.json>    # the normalized document, human or --json
npm run crm -- solution validate <plan.json>   # the contract alone; no project is read
npm run crm -- solution check <plan.json>      # validate, then bind against this project's AX1 report
```

Exit codes mirror AX1's, for the same reason — a reader must never mistake
"your plan is wrong" for "I could not read it":

```text
0   the plan is valid (and, for `check`, current)
1   the plan has problems — the complete problem list is still printed
2   the plan or the project could not be read at all
```

`validate` reads no project at all, so a plan can be checked in CI, in review,
or against a repository that is not the one it targets.

## Guarantees to prove

1. **Deterministic.** Two runs over the same plan produce byte-identical output;
   the fingerprint is stable across key order and whitespace.
2. **Closed vocabularies.** An unknown decision type, evidence category,
   approval code or problem code is refused, never passed through.
3. **No executable content.** A step carrying a command, a script, a shell
   fragment or a URL to fetch is refused.
4. **Citations resolve.** A derived metric or inference citing a missing id is a
   problem, not a warning.
5. **Staleness is detected.** Changing a package version, a capability status or
   a record revision after a plan is written produces `PLAN_STALE` naming the
   difference.
6. **Bounded.** Every string, list and nesting depth has a limit, and an
   oversized plan fails as a size refusal rather than a hang.
7. **Hostile input stays inert.** `__proto__`, `constructor`, markup, template
   syntax, null bytes and Unicode separators across every field.
8. **Rung 5 is not a step.** `propose-kernel-capability` in `steps[]` is refused.
9. **Provider steps carry the approval.** Omitting it is a problem.
10. **Nothing executes.** No test, and no code path, runs a plan.

## Not in this PR

A planner · an agent runtime or orchestrator · automatic source modification ·
package or provider installation · production deploy · database or
runtime-health inspection · Marketing runtime · Analytics Studio · Data
Operations · generic Admin action filtering · Service · PostgreSQL · Cloud ·
package extraction or refactoring · M14b2.

## What the adversarial review of PR #24 corrected

| Severity | Defect | Fix |
|---|---|---|
| High | `compositionFingerprint` was author-supplied free text in a slot that reads as cryptographic evidence — the shipped example held `example-only-not-a-real-composition` | replaced by `inspectionFingerprint`, derived from the canonical AX1 report, shape-refused at validate time and recomputed by `check` |
| High | citations resolved against any id, so a fact could cite a recommendation, a recommendation could rest on unavailable evidence, and two entries could cite each other | a citation-source table that is a DAG over categories; wrong-direction edges are `PLAN_CITATION_DIRECTION` and cycles cannot be expressed |
| Medium | unknown keys were silently ignored, so a claim could sit outside both the report and the fingerprint | refused at every level as `PLAN_FIELD_UNKNOWN` |
| Medium | rung 3+ decisions needed no evidence that lower rungs were inspected | `rungsTried`, `rejectedRungs` with a reason each, and `gap` are required at rung 3 and above (`PLAN_RUNGS_NOT_INSPECTED`) |
| Low | a provider decision could imply more than AX1 can evidence | `PROVIDER_STATUS_UNKNOWN` is added automatically, naming the five states and the one AX1 answers |
| Low | acceptance had no way to name intended outputs, so they leaked into prose | `acceptance.artifacts[]` with a closed `kind`, a repository-relative `path`, and no content field |
| Low | the executable-content rule was documented as if it were a boundary | the boundary is the *shape*; the text filter is published as defense in depth, with its false negatives demonstrated by a passing encoded payload |

The canonical example was rebuilt to bind to **this repository's own
composition**, so `crm solution check examples/solution-plans/lead-to-won.plan.json`
exits `0` here — and a test asserts it, which makes the example a tripwire: if
the repository's composition moves and nobody regenerates the plan, the suite
says so.
