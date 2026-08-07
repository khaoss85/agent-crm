# Machine-readable Solution Plans (AX2)

AX1 answers *what has this project actually composed*. This answers the next
question — **what are you going to do about it, and on what evidence** — in a
shape a second reader can check rather than interpret.

```bash
npm run crm -- solution inspect  <plan.json>          # the normalized document
npm run crm -- solution validate <plan.json>          # the contract alone; reads no project
npm run crm -- solution check    <plan.json>          # validate, then bind to this project's AX1 report
```

The canonical example is
[`examples/solution-plans/lead-to-won.plan.json`](../examples/solution-plans/lead-to-won.plan.json).

## What it is not

**It is not a planner and not a runtime.** There is no built-in LLM, no agent
orchestrator, and nothing here executes a plan, writes source, installs a
package, configures a provider, starts a server or deploys anything. AX2 defines
a document, checks one, and binds it to a real inspection. Who writes the plan
and who carries it out are both outside this contract.

A plan also **cannot carry executable content**, and that holds at two levels
worth separating:

- **by contract.** There is no command, script or effect field anywhere in the
  shape, unknown keys are refused rather than ignored, and there is no code path
  from a step to an invocation. This is the actual boundary.
- **by text filtering.** Free text is additionally matched against shell
  commands, substitutions, chaining, remote addresses and script tags
  (`PLAN_EXECUTABLE_CONTENT`). This is **defense in depth, not a security
  sandbox**: it is deliberately conservative and refuses some legitimate prose,
  and it will miss a sufficiently encoded payload. Neither outcome changes the
  guarantee, because nothing reads these fields as instructions.

## Why it exists

`solve-business-goal` §5 has always asked for a Solution Plan with sixteen named
parts, and every agent writes it differently: different section names, different
order, different words for "we do not know". A human cannot diff two of them, a
second agent cannot read one, and nothing can check whether the application a
plan was written against is still the application in front of you.

## The contract

`solutionPlanContract: 1`. The top-level shape is stable and every list is
sorted by identity:

```json
{
  "solutionPlanContract": 1,
  "revision": 1,
  "fingerprint": "…",
  "goal": {}, "metric": {}, "application": {},
  "evidence": {}, "decisions": [], "steps": [],
  "approvals": [], "acceptance": {}, "limitations": [], "problems": []
}
```

`revision` is the plan's own generation. `fingerprint` is a SHA-256 over the
canonical bytes of everything except `fingerprint` itself — keys sorted at every
depth — so two plans that say the same thing hash the same, key order and
whitespace change nothing, and a silent edit cannot hide.

## Six decision types, and nothing else

The repository already has a decision hierarchy. AX2 makes each rung a value, so
a plan cannot blur "we configured something" into "we wrote a package":

| Type | Rung | What it means |
|---|---|---|
| `configure` | 1 | a policy version, a config value or a view on an installed package |
| `extend` | 2 | an action, a policy or a record through a package's declared seam |
| `evolve` | 2 | a record gains a field or a state: bump its manifest revision (ADR-019) |
| `provider` | 3 | add or configure a provider — the gap is an integration, not a model |
| `create-package` | 4 | no installed package owns this domain |
| `propose-kernel-capability` | 5 | a generic runtime gap, raised as an ADR discussion |

`propose-kernel-capability` is in the list so a plan can **state** it, and the
validator refuses it in `steps[]` — rung 5 is a proposal you write, never a step
you take. That refusal is `PLAN_DECISION_NOT_A_STEP`, and it exists because
patching the kernel to make a solution fit is the failure this hierarchy was
written to prevent.

## Evidence, in six categories and no others

```text
observedFacts        what the data says, with the query and its version
derivedMetrics       what was computed, and how
assumptions          what was taken as true without evidence
inferences           what follows from facts plus assumptions
recommendations      what to do, traceable to the rows above
unavailableEvidence  what could not be checked, and why
```

The set is closed **in both directions**: an invented category is refused, and a
missing one is a problem. A gap that is stated is part of the deliverable; a gap
that is omitted is a claim.

### Citations point one way

Resolving a citation is not enough — a citation has a *direction*, and the
direction is what stops a conclusion from being laundered into a premise:

| A… | may cite | because |
|---|---|---|
| `observedFact` | nothing | it carries a `source`, not a derivation |
| `assumption` | nothing | it is taken as true *without* evidence, by definition |
| `unavailableEvidence` | nothing | it carries a `reason`, and is never proof |
| `derivedMetric` | observed facts, assumptions | a number comes from inputs, not from conclusions |
| `inference` | observed facts, derived metrics, assumptions | |
| `recommendation` | observed facts, derived metrics, assumptions, inferences | |

The table is a DAG over categories, so the citation graph is **acyclic by
construction**: two entries citing each other, or an entry citing itself, cannot
be expressed. A wrong-direction edge is `PLAN_CITATION_DIRECTION`; an unknown id
is `PLAN_CITATION_UNRESOLVED`.

Every derived metric, inference and recommendation must cite at least one id,
and citations resolve forward or backward — order in the file does not decide
whether a plan is valid. A citation list is a **set**: repeating an id is
refused rather than deduplicated, because it does not make one source into
several.

## Bound to a real application, or stale

A plan records the AX1 report it was written against as a **derived**
`inspectionFingerprint` — a 64-character hex digest computed from the canonical
AX1 report. `validate` refuses anything that is not that shape, so a free-text
label can no longer sit in a slot that reads as cryptographic evidence, and
`check` recomputes it from the live report and compares.

What it is: a **drift detector** over the whole composition — it catches a
policy version, an action that disappeared or a migration checksum that moved,
none of which a plan's own evidence lists mention. What it is **not**: proof of
authorship, authorization or correctness. Obtaining one honestly means running
the tooling against a real project, which is exactly what makes it evidence of
drift; `crm solution check --json` publishes the live value so an author can
record it.

It covers package identities and versions, capability requires/provides and
resolution, resources, declared action metadata, policy and provider identities
with their declared-definition fingerprints, record revisions and migration
checksums, and the problems and limitations that bound what may be planned. It
excludes every label, description, hint and route, plus absolute paths,
timestamps, config values, database state and runtime status.

Alongside it, the plan lists the packages, capabilities and records it actually
depends on, so `check` can name *what* moved rather than only that something
did:

| Difference | Reported as |
|---|---|
| the composition digest moved | `PLAN_STALE` on `inspectionFingerprint`, with both values |
| a package is gone, or at another version | `PLAN_STALE` naming both versions |
| a capability is gone, or stopped resolving | `PLAN_STALE` naming both statuses |
| a record moved to another revision | `PLAN_STALE` citing ADR-019 |
| a record declares no revision at all | `PLAN_STALE` — it is a core record, not an ADR-019 managed module, so a plan must not pin it |
| a step needs a capability that is missing or unresolved | `CAPABILITY_NOT_AVAILABLE` |

A plan whose premises have changed is not a plan, and reading one as if it were
is how an agent confidently builds on a capability the application no longer
has.

## Approvals: a closed vocabulary

`solve-business-goal` §9 lists the sensitive boundaries in prose. Here they are
codes, so a plan cannot invent a softer word for "spend money":

```text
activate_journey · auto_apply_experiment_winner · change_live_audience
change_secrets · create_or_increase_spend · external_communication
install_or_configure_provider · irreversible_or_destructive · launch_ads
publish_production · sensitive_data
```

A `provider` step **must** carry `install_or_configure_provider`, on the step
and in the plan's approval register; the validator adds the requirement rather
than trusting the author to remember it (`PLAN_APPROVAL_MISSING`).

This is a **human-actor boundary, not RBAC.** Every plan carries that limitation
whether or not its author wrote it, along with three others:

| Code | Meaning |
|---|---|
| `PLAN_NOT_EXECUTED` | a document, not a runtime — nothing here runs, installs, deploys or modifies source |
| `APPROVAL_NOT_RBAC` | no auth, tenancy or RBAC exists, so no role is enforced anywhere |
| `EVIDENCE_NOT_VERIFIED` | an observed fact is checked for shape and citation, never for truth |
| `BINDING_IS_SOURCE_ONLY` | the bound report is AX1: source-only, and says nothing about a database, a provider's health or what is deployed |

## Exit codes

```text
0   the plan is valid (and, for `check`, current)
1   the plan has problems — the complete problem list is still printed
2   the plan or the project could not be read at all
```

`inspect` reports the document without judging it, so it exits `0` even for a
plan with problems — and prints them anyway. `validate` reads **no project at
all**, so it runs in CI, in review, or against a repository that is not the one
the plan targets.

## Rung 3 and above must show their work

`provider`, `create-package` and `propose-kernel-capability` all mean "nothing
installed can do this". The hierarchy only works if that claim is *evidenced*,
so a decision at rung 3 or higher must record every lower rung in `rungsTried`,
a reason per rung in `rejectedRungs`, and the capability `gap` no installed
package fills. Anything missing is `PLAN_RUNGS_NOT_INSPECTED`.

Rungs 1 and 2 carry no such burden: configuring or extending what already exists
needs no essay.

A `provider` decision also adds `PROVIDER_STATUS_UNKNOWN` to the plan's
limitations, whatever its author wrote. A provider has five distinguishable
states — composed in source, configured, holding credentials, reachable,
authorized — and AX1 can evidence exactly the first.

## Artifacts name a place, never content

`acceptance.artifacts[]` says what a plan intends to produce: a closed `kind`
(`admin-view`, `document`, `migration`, `module`, `package`, `policy`,
`provider-config`, `test`), a repository-relative `path`, and a description.
An absolute path, a `..` escape, a path claimed twice, or any field carrying
file content is refused — an artifact holding source is the executable-content
boundary in a different costume.

## Bounds

A plan is at most 1 MiB, a text field 2 000 characters, an identifier 120, a
list 200 entries and a citation list 50. Every bound is a refusal, never a
truncation: a plan silently cut to 200 decisions reads as a complete plan.
Unknown keys are refused at every level (`PLAN_FIELD_UNKNOWN`): silently
dropping one means the plan claims something the reader never sees, and the
fingerprint — computed over the normalized document — would not cover it.

## Using it as an agent

1. Run `app inspect --json` and read `valid`, `problems`, `limitations` in that
   order.
2. Write the plan, recording that report in `application`.
3. Run `solution check`. Fix every problem before writing any code.
4. Cite the package and capability behind each step. Report a missing capability
   as missing.
5. Re-run `solution check` before the review. A stale plan is not a plan.

## Evidence

`tests/solution-plan.test.js`, `packages/core/src/solution-plan.js`,
`packages/cli/src/solution-command.js`,
`examples/solution-plans/lead-to-won.plan.json`,
`docs/plans/ax2-machine-readable-solution-plans.md`. Agent instructions:
`.claude/skills/solve-business-goal/SKILL.md` and its `.agents/` mirror.
