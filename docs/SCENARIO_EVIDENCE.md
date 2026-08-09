# Scenario evidence

`crm scenario run <scenario> [--json] [--root dir]` — **DX6**.

> **Which JTBD rows does this checkout actually earn — and which does it not?**

Job status in this repository lives in `docs/benchmarks/CRM_JTBD_MATRIX.md` and
its generated index `docs/benchmarks/jobs.json`. Both are maintained by people.
Nothing recomputed them, and nothing could tell you what a given run did **not**
establish — `docs/PROJECT_STATUS.md` lists that as a known limitation, and AX1
says it in its own report: `evidence.status` is `not_aggregated`, with a note
that the JTBD documents are referenced by path and never parsed.

This command closes that gap, and only that gap.

```text
crm app inspect      what is composed?                             source facts
crm solution check   is this plan still compatible?                a document
crm project doctor   what is stale in the source?                  cheap
crm project verify   can we PROVE the project is healthy?          expensive
crm scenario run     which business jobs does this checkout earn?  this
```

## What it is not

**It is not a second test runner.** It runs no suite, grades no package and
calls no doctor — that is `crm project verify`, and duplicating it would leave
two commands answering almost the same question. What it produces is the mapping
prose cannot give you: *this scenario ran, against this composition, these rows
it exercised with linked evidence, and these rows it did **not** establish.*

**It promotes nothing.** `docs/QUALITY_GATES.md` §3 gives the four-value JTBD
status vocabulary and puts the burden of proof on the higher value, decided by a
person reviewing merged tests. This command reports evidence. Its own per-claim
vocabulary — `established | not_established | unresolved` — is deliberately not
the JTBD vocabulary, so the two can never be read as the same thing, and every
report carries a `promotion` block recording that it performed none. `jobs.json`
and the matrix are opened read-only.

**The negative is the point.** A scenario that earns fifteen rows and cannot
speak to a hundred and thirty-four has to say so in its own output, so
`jtbd.notEstablished` is a counted, sectioned, fully enumerated list. "Not
established" means *this scenario said nothing about the row* — never that the
row is unsupported. The recorded status in the index is the only statement about
support.

## The scenario document

A scenario is a **checked-in declarative document**, not a script:
`examples/scenarios/<id>.scenario.json`. A bare id on the command line resolves
there; anything with a path separator is treated as an explicit path.

```json
{
  "scenarioContract": 1,
  "id": "lead-to-won",
  "title": "Lead to won, and everything the won deal sets in motion",
  "summary": "…",
  "journey": "b2b-lead-qualification",
  "steps": [
    {
      "id": "capture",
      "narrative": "Leads are captured into the starter's Lead record.",
      "observe": [
        { "kind": "module.present", "module": "lead" },
        { "kind": "journey.count", "metric": "leads", "atLeast": 3 }
      ]
    }
  ],
  "claims": [
    { "job": "JTBD-04", "steps": ["capture"], "note": "narrow wording…" }
  ]
}
```

- **`journey`** names, by id, the thing the runner executes. Ids resolve against
  a frozen registry in the runner's own source — today one entry, the checked-in
  B2B lead-qualification starter installer that CI already runs on every push.
  Reusing it means DX6 introduces no second, weaker authority on what the CRM
  does: the installer's in-process assertions stay the strong claim.
- **`steps`** are the business narrative, in order. Each declares observations.
- **`claims`** map JTBD ids, resolved against `jobs.json`, to the steps that are
  their evidence. A claim is `established` only when *every* observation in
  *every* cited step passed.

### How it refuses to carry a command

`docs/CODER_TOOLING_ROADMAP.md` refuses "executable commands as trusted plan
content" — *a format that can describe execution invites a runtime, and the
first runtime that reads a plan is one edit away from applying it* — and the
Solution Plan validator enforces that rather than documenting it. A scenario
refuses the same thing, in three independent layers:

1. **Shape.** No field in the contract could hold a command. Every object is
   checked against a closed key allow-list, so `{"run": "npm test"}` is refused
   as `SCENARIO_FIELD_UNKNOWN` *before its value is read*.
2. **Content.** Every string at every depth goes through `EXECUTABLE_SHAPES` —
   **the same exported constant the Solution Plan validator uses**, not a second
   copy that gets fixed once. A shell command, a command substitution, shell
   chaining, a remote address or a script tag is `SCENARIO_EXECUTABLE_CONTENT`.
3. **Path.** There is no code path from a document value to an invocation. The
   only thing the runner spawns is a journey selected by id from that frozen
   registry. A scenario cannot name a path, a script, an argument, an
   interpreter or an environment variable. The single field that names a file —
   a Solution Plan citation — is read and validated as a document, never
   executed, and is refused if it is absolute, contains `..`, uses a backslash
   or a URL scheme, or resolves outside the project.

**A document with any problem never starts a journey.** The refusal costs
nothing and happens first.

### The observation vocabulary

Closed, and owned by the runner rather than the document — the same discipline
`crm project verify` uses for declared scripts, where the project declares a
*name* and the framework owns the list.

| Kind | Authority | Answers |
|---|---|---|
| `journey.completed` | journey | the journey ran to completion and reported success |
| `journey.count` | journey | a numeric metric the journey reported (`atLeast` or `equals`, exactly one) |
| `package.composed` | `app inspect` | the composed application includes this domain package |
| `resource.present` | `app inspect` | a domain package in this composition owns this resource |
| `module.present` | `app inspect` | the composition has this record module (a project's own, or package-owned) |
| `action.present` | `app inspect` | the composition publishes this `module.action` |
| `capability.available` | `app inspect` | a declared cross-package capability **resolved** here (declared-but-unresolved fails) |
| `policy.present` | `app inspect` | a versioned policy this composition registered |
| `plan.valid` | Solution Plan | a checked-in plan this scenario is the evidence run for, read as a document |

Composition facts are taken **verbatim** from the AX1 report. Nothing an
upstream authority already resolved is recomputed here.

## The report

`scenarioRunContract: 1`, canonically ordered, with `scenario`, `status`,
`counts`, `journey`, `composition`, `steps`, `observations`, `jtbd`,
`promotion`, `problems`, `limitations` and a semantic `fingerprint`.

```text
exit 0   the scenario ran and every claim is established
exit 1   the scenario ran and something did not hold, or the document is
         invalid — in which case no journey was started
exit 2   the scenario document could not be read at all
```

**Deterministic and offline.** No duration, timestamp, temporary path, machine
layout or random value enters the report *at all* — not merely the fingerprint —
so two runs of an unchanged checkout produce byte-identical documents from
different working directories. Nothing reaches the network. Three fingerprints
travel with every report: the scenario document's own, the composition's
(`inspectionFingerprint`, shared with AX2), and the JTBD index's.

The journey composes a whole application in a temporary directory outside the
repository, which is removed afterwards. **Nothing is written into the project
being reported on**, which is why there is no worktree check to get wrong.

### Problem codes

`SCENARIO_UNREADABLE`, `SCENARIO_TOO_LARGE`, `SCENARIO_CONTRACT_UNSUPPORTED`,
`SCENARIO_FIELD_INVALID`, `SCENARIO_FIELD_UNKNOWN`,
`SCENARIO_EXECUTABLE_CONTENT`, `SCENARIO_VOCABULARY_UNKNOWN`,
`SCENARIO_DUPLICATE_ID`, `SCENARIO_CITATION_UNRESOLVED`, `SCENARIO_PATH_REFUSED`,
`SCENARIO_JOURNEY_UNKNOWN`, `SCENARIO_JOURNEY_FAILED`, `SCENARIO_JOB_UNKNOWN`,
`SCENARIO_JOBS_INDEX_UNREADABLE`, `SCENARIO_COMPOSITION_UNREADABLE`,
`SCENARIO_RECURSION_REFUSED`.

Everything fails closed. A claim whose job id is not in the index, a step id that
does not exist, a metric the journey never reported, a capability that is
declared but unresolved — each fails the run rather than passing by having
nothing to check.

### What it does not prove — published on every run

| Code | Means |
|---|---|
| `SCENARIO_IS_NOT_PROMOTION` | this changes no JTBD status and writes to no document |
| `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` | it checks the rows a scenario *claims*; it cannot discover which rows a journey happens to exercise |
| `NEGATIVE_EVIDENCE_IS_SILENCE` | a row under `notEstablished` means the scenario said nothing about it, never that it is unsupported |
| `EVIDENCE_IS_ONE_COMPOSITION` | the evidence is about the one application this journey composed |
| `JOURNEY_SOURCE_TRUSTED` | the journey is checked-in repository source running with the operator's authority. The child is bounded in time, output and process group — isolation, not a sandbox |
| `BROWSER_EVIDENCE_NOT_AUTOMATED` | no browser is driven; nothing here is evidence about the Admin as a user sees it |
| `NO_PROVIDER_CONTACTED` | offline by construction; every provider in the journey is a checked-in fixture |
| `PRODUCTION_READINESS_NOT_ASSESSED` | no auth, tenancy or RBAC exists, and nothing here assesses deployment or operational readiness |

## A worked run

```console
$ npm run crm -- scenario run lead-to-won --json
```

The shipped scenario runs the B2B starter journey and claims fifteen rows across
capture, qualification, conversion, pipeline, enrichment, scoring, routing,
quoting, discount approval, signature and order, contract activation, delivery
handover, custom-package authoring, cross-package capability and application
discovery. It reports **fifteen established** and **one hundred and thirty-four
not established**, sectioned.

One of the fifteen — `JTBD-CS-01`, contract activation — is recorded as
*partially supported*, and stays that way. The run shows the activation
happening; the row's missing part (a pre-signature term snapshot) is not
something a run can supply, and only a person may move a status.

## Adding a scenario

Write `examples/scenarios/<id>.scenario.json`, claim only rows the journey
genuinely exercises, and run it. No code changes. A *new journey* does need a
registry entry in `packages/cli/src/scenario-journey.js`, deliberately: that is
the boundary that keeps a document from naming something to run.

## Related

`docs/QUALITY_GATES.md` (§3, the status vocabulary and who may change it) ·
`docs/benchmarks/CRM_JTBD_MATRIX.md` · `docs/APPLICATION_INSPECTION.md` (AX1) ·
`docs/SOLUTION_PLAN.md` (AX2) · `docs/CODER_TOOLING_ROADMAP.md` ·
`docs/plans/dx6-scenario-runner.md` (the ExecPlan, with the eight DX Simplicity
Gate answers) · `tests/scenario-document.test.js` ·
`tests/scenario-run.test.js`.
