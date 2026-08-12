# Implementation evidence

`crm solution verify <plan.json> --evidence <evidence.json> [--json] [--root dir]` — **DX10**.

> **For every requirement in this checked-in SolutionPlan, what implementation
> evidence proves it is implemented, partial or blocked — and what is still
> unproven?**

Every other rung stops one step short of that question:

```text
crm app inspect      what is composed?                             source facts
crm solution check   is this plan valid, and still true?           a document
crm project doctor   what is stale in the source?                  cheap
crm project verify   can we PROVE the project is healthy?          project health
crm scenario run     which business jobs does this checkout earn?  claimed rows
crm solution verify  does this evidence satisfy this plan?         this
```

`project verify` said so itself, in its own limitations, before this existed:
*nothing here maps a plan's requirements to the code that implements them, so a
green report never means a plan is finished.* This closes that gap, and only
that gap.

## Keep the two verbs apart

```text
solution check    is this PLAN valid, and still true of this application?
solution verify   does this IMPLEMENTATION satisfy the plan's requirements?
```

`check` can pass on a plan nobody has built a line of. That is not a defect in
`check` — a plan's validity is a fact about the document — and it is exactly the
state this repository's one declared-current plan is in today.

## What it is not

**It is not a plan runtime.** It writes no plan, executes no plan and modifies
no source. There is **no write mode, no `--fix` and no generation command**, in
v1 or in the design. **It promotes no JTBD row** — that stays a person's
decision under `docs/QUALITY_GATES.md` §3. It runs **no command a document
names**: there is no command, script, environment variable or effect field
anywhere in either contract, and no code path from a document value to an
invocation.

And it never infers completion from a file existing. That inference has its own
refusal, its own problem code and its own test.

## The evidence document

`implementationEvidenceContract: 1`, checked in beside the plan it describes.

```jsonc
{
  "implementationEvidenceContract": 1,
  "plan": "examples/solution-plans/lead-to-won.plan.json",
  "planFingerprint": "8f3cbd96…",
  "applicationInspectionFingerprint": "649add63…",
  "requirements": [
    {
      "requirementId": "check:af9d6ee5ccc4",
      "category": "project-health",
      "evidence": [
        { "kind": "project.verification", "check": "suite.verify", "expect": "passed" }
      ]
    }
  ],
  "limitations": [{ "code": "…", "message": "…" }]
}
```

**There is no status field, anywhere.** A requirement carries a category and a
list of places to look. The verifier obtains the current facts from authorities
that ran in the same invocation and decides the status. An agent writing this
document about its own work can point at the wrong evidence; it cannot declare
the outcome, and that asymmetry is the whole design.

The two shapes an author *may* add are **downgrades**:

```jsonc
"blocked": { "reason": "…" }     // this requirement cannot be evidenced here, and why
"partial": { "reason": "…" }     // some of this criterion is observed and some is not
```

Each needs a non-empty reason — `{"blocked": {}}` is
`EVIDENCE_BLOCKED_REASON_MISSING`, because a downgrade with no reason is a
requirement abandoned quietly. They are mutually exclusive, and **neither can
raise a status.** An author may always say "this is less proven than it looks";
no author may say "this is more proven than the evidence shows".

Unknown keys are refused at every level, every string and list is bounded, and
every string goes through **the same exported `EXECUTABLE_SHAPES`** the Solution
Plan and the scenario contract use — one refusal, one place to fix it. The
document has a canonical `fingerprint`: keys sorted at every depth, so two
documents that say the same thing hash the same and a silent edit cannot hide.

## Requirement identity, derived rather than declared

A **requirement** is a plan **step** or an **acceptance check**.

```text
step:<stepId>        the id its author already wrote in the plan
check:<12 hex>       the first 12 hex of sha256 over the acceptance-check statement
```

`acceptance.checks[]` is an array of bare strings with no identifier, and adding
one would have been a change to `solutionPlanContract: 1`: new validation, a new
normalized shape, and a fingerprint meaning one thing for new plans and another
for old ones. Deriving adds **nothing** to that contract — not a field, not a
rule, not a byte of any plan's fingerprint — and every plan already checked in
became addressable the moment DX10 shipped, with **no migration and no
rewrite**. ADR-031 records the comparison.

The cost is deliberate and is the behaviour we want: **rewording an acceptance
criterion changes its requirement id**, so evidence recorded against the old
wording reads as `unevidenced` rather than silently carrying over to a criterion
nobody re-examined. Reordering the list changes nothing, because the id is
content-addressed rather than positional. Two identical statements in one plan
collide, and the collision is refused (`PLAN_REQUIREMENT_DUPLICATE`) — one
requirement must not stand for two.

Two things that look like candidates are deliberately **not** requirements:

- **an acceptance artifact.** `artifacts[]` names a *place* a step intends to
  produce a file. Treating a declared path as a requirement is "the file exists,
  therefore it is done" wearing a contract.
- **a JTBD row.** It is DX6's unit, and only a person moves its status.

Read the ids from `crm solution check <plan.json> --json` → `requirements`. They
are published **outside** the `plan` object precisely so no plan's fingerprint
moves.

## The closed evidence vocabulary

| Kind | Authority | Arguments | Refuses |
|---|---|---|---|
| `application.fact` | AX1 | `fact` (one of `action.present`, `capability.available`, `module.present`, `package.composed`, `policy.present`, `resource.present` — the **same names DX6 uses**), `name`, optional `version` | a fact that is absent, or any fact at all when the plan binds through a scenario |
| `source.artifact` | the repository | repo-relative `path`, `sha256` | an absent file, a moved hash, a path that escapes the project — and **it is never sole proof of anything** |
| `project.verification` | DX5 | a stable `check` code, the `expect`ed status | an unknown check code; a status that differs |
| `package.conformance` | DX5 | a composed package `path` | a package that was not graded — there is no pass to cite |
| `scenario.observation` | DX6 | `scenario` id, `observation` code, the exact `expects` string | a missing or failed observation, and an observation whose `expected` string moved |
| `manual` | a person | `describes` | counting as proof, ever |

**There is no `test` evidence kind.** A test *name* is exactly the arbitrary
string this contract refuses: no authority here publishes which tests ran, so
citing one would be a claim dressed as a citation. `project.verification` on
`suite.verify` says the true, weaker thing — the project's declared suite ran
and passed in this invocation.

**There is no evidence-to-evidence citation.** An entry names an authority and a
fact, so there is no graph to keep acyclic, and a conclusion is not expressible
as a premise at all. AX2 needed a citation DAG because its entries derive from
each other; recreating one here would be complexity with no failure behind it.

### Manual evidence, and why it is accepted

A requirement whose category is `manual` and which carries manual evidence is
**`unverified`**. It can never be `verified`, and it forces a non-zero exit **on
its own**, whatever else passes. A manual note added *beside* real machine
evidence under any other category is **context**: it is recorded and never
resolved, and it neither satisfies the requirement nor sinks it. Manual evidence
*alone* under a non-manual category satisfies nothing, and the report says so.
It is accepted into the contract for one reason: refusing it means the browser
requirement simply *vanishes* from the document, and this repository's rule is
that a gap which is stated is part of the deliverable while a gap that is
omitted is a claim. Every report carries `MANUAL_EVIDENCE_IS_NOT_PROOF`, and a
report with one carries `MANUAL_EVIDENCE_REMAINS_REQUIRED` as well.

## The sufficiency matrix

The category is declared; **which authority satisfies it is not**, and an author
cannot widen it.

| Category | Satisfied by | Insufficient, however much of it | Why that authority |
|---|---|---|---|
| `structural` | `application.fact`, `package.conformance`, or a scenario observation whose **kind is a composition kind** | `source.artifact` alone | a record, action, policy, resource, package or capability either is in the composition or is not, and AX1 reads that from source. **No scenario is required for a purely structural requirement** |
| `behavioural` | a scenario observation whose **kind is a runtime kind** — `journey.completed`, `journey.count`, `journey.fact` | everything else: a file existing, a package being composed, **an action being declared** | only a run can evidence what the application *does*; AX1 by construction cannot see one |
| `project-health` | `project.verification` | anything else | DX5 runs the declared suites; nothing else does |
| `package-architecture` | `package.conformance`, or an `application.fact` about a package or capability | `source.artifact` alone | DX4/DX5 grade the seam; AX1 publishes the resolved capability graph |
| `manual` | nothing | — | resolves to `unverified` |

The observation **kind** is read from DX6's report, never from the evidence
document. That is what stops an author relabelling `action.present` — "the
action is declared" — as evidence that the application does anything.

Where the plan itself carries the information, a **floor** applies and the
declared category cannot go under it: a step whose decision type is `configure`,
`extend`, `provider` or `create-package` changes what the application does, so
`structural` is refused (`EVIDENCE_CATEGORY_BELOW_FLOOR`) **and the requirement
is graded against the floor rather than the label** — reporting the violation
while still grading the weaker claim would let the label decide the outcome,
which is the one thing a declared category must never do. A step whose decision
is `evolve` has a floor of `structural`. Acceptance checks carry no floor — the
plan says nothing about the nature of a criterion — so their category is
declared, recorded verbatim in the report, and bounded by the published
limitation `REQUIREMENT_CATEGORY_IS_DECLARED`.

## What the plan is bound to, and why a scenario may answer it

AX2's `inspectionFingerprint` names the **application** a plan was written
against. In a project that is the project. In a *framework* repository — one
whose root composes no domain package at all — the application a plan describes
is the one a starter composes, and the only authority that produces that digest
is DX6, which publishes it as `composition.compositionFingerprint`.

So the binding is resolved against the authorities that actually ran, and the
report names which one answered:

| Order | Authority | `binding.boundTo` |
|---|---|---|
| 1 | AX1 at the project root; `bindSolutionPlan` then grades packages, capabilities, records and step capabilities in full | `project` |
| 2 | exactly one **explicitly referenced** scenario whose composition digest matches | `scenario:<id>` |
| 3 | nothing produced it | `null` → `PLAN_NOT_CURRENT`, every requirement `stale`, exit 1 |

It is **derived, never declared**: an evidence document cannot nominate a
composition, only reference a scenario that composes one. When the binding is a
scenario, `application.fact` evidence is refused with
`EVIDENCE_AUTHORITY_UNAVAILABLE` — the only full AX1 report in hand describes a
*different* application, and answering a question with the wrong application's
facts is the failure this rule exists to prevent. Facts about that composition
must be cited where they were observed.

## The report

`solutionVerificationContract: 1`, canonically ordered, with a semantic
`fingerprint`.

```text
requirementId   status       meaning
──────────────  ───────────  ────────────────────────────────────────────────
                verified     every reference resolved and the category is satisfied
                partial      the evidence holds; the author states what it does not cover
                blocked      the author states why it cannot be evidenced here
                unevidenced  no evidence, a reference that did not resolve, or an
                             insufficient one for the category
                unverified   manual evidence only
                stale        the plan, its composition or its fingerprint moved
```

```text
exit 0   every required requirement is machine-verified in this invocation
exit 1   readable, but incomplete, stale, partial, blocked or manual
exit 2   a document could not be read, or an authority could not run at all
```

**Exit 0 is forbidden while any requirement is `unverified`.** A partial plan is
never "verified with warnings": `partial`, `blocked`, `unevidenced`, `stale` and
`unverified` all force exit 1, and the report's own status is `incomplete`,
never `passed`.

The report also publishes `unproven[]` as a first-class field — the honest
negative, not something a reader reconstructs — `authorities[]` with the
fingerprint of every run that answered, `binding`, `worktree`, `promotion`
(always `performed: false`) and `limitations`.

## Staleness and integrity

Evidence stales when the plan fingerprint moves; when the bound composition
digest moves; when a cited capability, action, module, policy or resource
disappears; when a cited source file's content hash changes; when a cited DX5
check's status differs from the expectation; when a cited scenario observation
is missing, failed or its `expected` string moved; or when a policy or provider
version moves — the last inside AX1's own composition digest, because a policy's
declared-definition fingerprint is part of it.

Cosmetic, path-independent facts stay stable by inheritance: AX1's digest
already excludes labels, descriptions, hints, routes, absolute paths,
timestamps, config values and runtime status, and DX5's and DX6's fingerprints
are semantic — they exclude duration and machine layout. Two runs of an
unchanged checkout produce byte-identical reports from different directories.

**A previously verified report cannot be replayed.** Nothing is cached and no
prior report is read. Every fact comes from an authority that ran in this
invocation.

## What one invocation runs

```text
app inspect                       once
solution check (the binding)      derived from that one report, not a second run
project verify                    at most once, and only if something references it
scenario run <id>                 once per **explicitly referenced** scenario, at most 8
```

No arbitrary project command, none from a document, and
`ACCORDO_SOLUTION_VERIFY_DEPTH` refuses a recursive `solution verify` the way
DX5 refuses a recursive `project verify`. Output and time are bounded; canonical
JSON goes to stdout and nothing else does; no secret, absolute path or stack
reaches the report.

**Cost, honestly:** a document referencing nothing but scenarios costs seconds.
A document referencing `suite.verify` costs whatever the project's own suite
costs, because DX5 runs it — minutes, in this repository. That is the price of
the check being real.

**Trusted-source posture, not a sandbox.** Everything this command delegates to
is checked-in repository source running with the operator's authority. Child
processes are bounded in time, output and process group. That is isolation, and
`VERIFICATION_SOURCE_TRUSTED` says so on every report.

## Dirty state

DX5's semantics, imported rather than copied. The worktree is sampled before and
after; a file already modified beforehand is **context**; a file that becomes
dirty *during* verification is `VERIFICATION_DIRTIED_WORKTREE`; a file silently
reverted is `VERIFICATION_REPAIRED_WORKTREE`; and nothing is ever reset, stashed
or cleaned.

**The evidence document is routinely an uncommitted file under active work.** It
is dirty before the run, so it lands in `dirtyBeforeVerification` and never in
`changedByVerification`. That distinction is the entire reason both samples
exist, and it is pinned by a test rather than assumed.

## Two worked consumers

Both ship, both are real, and **both exit 1** — which is the truthful state of
both plans.

```console
$ npm run crm -- solution verify examples/solution-plans/activate-support-and-manage-cases.plan.json \
    --evidence examples/implementation-evidence/activate-support-and-manage-cases.evidence.json --json
```

The service plan targets the application the b2b starter composes, not this
repository, so it binds through `scenario:service-sla-escalation` — the run that
composes exactly that application. Six of its ten requirements are `verified`
from runtime observations on an injected, stepped clock; four are `partial`,
each naming the part of its criterion the run does not observe.

```console
$ npm run crm -- solution verify examples/solution-plans/lead-to-won.plan.json \
    --evidence examples/implementation-evidence/lead-to-won.evidence.json --json
```

The lead plan is the one this repository declares **current**. It binds to the
project. **One** requirement is `verified` — the full suite passes, evidenced by
DX5's `suite.verify` check. One is `partial`: the starter journey composes into
a temporary directory of its own, which is not evidence that a person installing
it into their own empty project gets the same result. One is `unverified`,
because a person has to read a screen. And **three are `blocked`**: two describe
work that is simply not built, and the third is blocked on a premise that does
not hold — the opportunity record carries no manifest revision in this
composition at all, so there is no revision to bump through the module factory.

That second report is the point of the whole rung. `solution check` exits 0 on
that plan, `project doctor` grades it `passed`, `project verify` is green and
both scenarios pass — and five of its six requirements are not proven. Nothing
in this repository could name that before.

## PROVE is still partial

DX10 exists; the claim does not follow from it. **No checked-in plan in this
repository is fully machine-verifiable today**, so nothing here exits 0, and
promoting PROVE because the command exists is precisely the move DX10 was built
to stop. The condition is now stated and machine-checkable: PROVE moves when a
checked-in, declared-current plan's `solution verify` exits **0**.

Four things stay outside this rung whatever its exit code says: **no automatic
plan authoring**, **no browser evidence in CI**, **no production-deployment
proof**, **no external or live-system proof** — and a manual requirement stays
unverified. Nothing here is a claim of autonomous completion.

## Adding an evidence document

1. `npm run crm -- solution check <plan.json> --json` and read `requirements`.
2. Write `<name>.evidence.json` covering **every** requirement — one the document
   omits is reported as `EVIDENCE_REQUIREMENT_MISSING`, not skipped.
3. Pick a category per requirement, and evidence that satisfies it. If nothing
   can, say `blocked` with a reason.
4. `npm run crm -- solution verify <plan.json> --evidence <evidence.json> --json`.
5. Read `unproven[]` first. It is the list of things somebody still has to do.

No code changes. A new evidence *kind* would need one, deliberately: that is the
boundary that keeps a document from naming a new thing to trust.

## Related

`DECISIONS.md` ADR-031 (derived requirement identity, and why the evidence
document cannot declare a status) · `docs/SOLUTION_PLAN.md` (AX2) ·
`docs/APPLICATION_INSPECTION.md` (AX1) · `docs/QUALITY_GATES.md` ·
`docs/SCENARIO_EVIDENCE.md` (DX6) · `docs/CODER_TOOLING_ROADMAP.md` ·
`docs/plans/dx10-implementation-evidence.md` (the ExecPlan, with the eight DX
Simplicity Gate answers) · `docs/architecture/AGENT_TOOL_SURFACE.md` ·
`packages/core/src/implementation-evidence.js` ·
`packages/cli/src/solution-verify-command.js` ·
`tests/implementation-evidence.test.js` · `tests/solution-verify.test.js` ·
`examples/implementation-evidence/`.
