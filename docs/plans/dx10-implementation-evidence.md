# DX10 — Implementation Evidence

**Status:** implemented.
**Command:** `accordo solution verify <plan.json> --evidence <evidence.json> [--json] [--root dir]`
**Contracts:** `implementationEvidenceContract: 1` (checked in), `solutionVerificationContract: 1` (the report).
**ADR:** DECISIONS.md ADR-030.
**Guide:** `docs/IMPLEMENTATION_EVIDENCE.md`.

## 1. Goal and user-visible outcome

> **For every requirement in this checked-in SolutionPlan, what implementation
> evidence proves it is implemented, partial or blocked — and what is still
> unproven?**

It closes the last hop of the rail story:

```text
goal → SolutionPlan (AX2) → code → Project Verify (DX5) / Scenario Evidence (DX6)
                                 → requirement-level proof                DX10
```

The user-visible outcome is one command and one exit code. Exit `0` means every
required requirement of that plan is machine-verified against an authority that
ran in this invocation. Exit `1` means the plan is readable and something is
incomplete, stale, partial, blocked or manual. Exit `2` means nothing could be
read at all.

**What it must not do**, restated so a later change has to argue with it:

- it does not write or execute a SolutionPlan, and does not modify source;
- it never infers completion from file existence;
- it never lets an agent self-report "done" — a declared status string is not
  accepted anywhere in either contract;
- it runs no command a document names;
- it is not a planner and not a workflow engine;
- it promotes no JTBD row;
- it claims no production, browser or live-system proof.

## 2. The DX Simplicity Gate — the eight questions

**1. Which concrete agent failure mode does it prevent?**
*An agent reports a plan complete while work is missing.* Concretely, in this
repository today: `examples/solution-plans/lead-to-won.plan.json` is the one
plan `package.json` declares **current**, `crm solution check` exits 0 on it,
`crm project doctor` grades it `passed`, `crm project verify` is green and both
scenarios pass — and four of its six requirements are not implemented. Every
existing authority is satisfied and the plan is not built. That gap is the
failure mode, and nothing in the repository could name it before this command.

**2. Why are existing primitives insufficient?** Each was tried first:

| Primitive | What it answers | Why it cannot answer DX10 |
|---|---|---|
| **DX5 `project verify`** | *is this project healthy enough to hand back?* | Project health, not requirement coverage. It aggregates the doctor, AX1, package conformance and the declared suites. It grades **plans** only through DX1's verdict — "does this plan still bind to this composition" — which is a statement about the plan's *premises*, never about its *implementation*. It says so itself: `IMPLEMENTATION_EVIDENCE_NOT_MAPPED`, "nothing here maps a plan's requirements to the code that implements them, so a green report never means a plan is finished. That is DX10." Extending it was the first thing attempted and is refused in §4. |
| **DX6 `scenario run`** | *which JTBD rows does this checkout earn?* | Selected scenarios, not every requirement. Its unit is a **claimed JTBD row**, resolved against `docs/benchmarks/jobs.json`, and it publishes `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` precisely because it cannot enumerate what a run did *not* touch beyond the index. A plan's requirements are not JTBD rows: `lead-to-won` claims two rows and has six requirements, and the two rows say nothing about four of them. DX6 also never reads a plan except to check that it is a valid *document* (`plan.valid` calls `validate`, not `check`). |
| **AX2 `solution check`** | *is this plan valid and still compatible?* | It validates the plan and binds it to a composition. Both are statements about the **document and its premises**. A plan can be valid, current, fingerprint-matched and entirely unbuilt — which is exactly the state `lead-to-won` is in. AX2 owns the plan; it has no vocabulary for the code that satisfies it, and giving it one would make `check` mean two different things behind one verb. |
| **DX1 `project doctor`** | *what is stale before I edit?* | Sub-second, source-coherence only. It runs nothing and so can evidence nothing behavioural. |

**3. Does it overlap semantically with an existing tool?** The nearest neighbour
is `solution check`, and the distinction is kept sharp in one sentence that
appears in the help text, the guide and the report:

```text
solution check    is this plan valid, and still true of this application?   the plan
solution verify   does this evidence satisfy this plan's requirements?      the implementation
```

It is one verb under an existing namespace, not a new namespace and not one
command per evidence kind. A `solution verify-source`, `solution verify-scenario`
family was rejected on this question alone: an agent would have to know which to
run, and would run the cheap one.

**4. Can it remain deferred or on-demand?** Yes, and it is. It appears in **no**
`SKILL.md`. `scripts/surface-check.js` measures the commands the skills name and
that number is at its stated ceiling of 11; DX5 and DX6 are absent from the
skills for the same reason. The rung is reached through `solve-business-goal`'s
prose about proving a solution, not by adding a twelfth command to the routing
table. Nothing about this command needs to be resident in a session.

**5. Does it preserve Claude / Codex / Gemini portability?** Yes. All of it is a
CLI command, two versioned JSON contracts, stable problem codes and stable exit
codes. No harness-specific logic, no MCP implementation in this PR.

**6. What machine-readable evidence proves its value?** A three-value exit code;
`solutionVerificationContract: 1` with a canonical semantic `fingerprint`; a
per-requirement status from a closed vocabulary; the fingerprint of every
authoritative run it used; and two checked-in evidence documents against two real
plans whose reports are byte-stable across runs and directories.

**7. Does horizontal impact update the Compatibility Backfill and the Legacy
Alignment Matrix?** DX10 is a **read-only agent surface over existing
authorities**, not a capability a domain implements: no domain package gains or
loses anything, and there is no per-domain status to record. A row is added to
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` stating exactly that, so the
absence is declared rather than assumed.

**8. Does the end-user goal flow become simpler, not more manual?** Yes. The user
states a goal. `solve-business-goal` already produces a plan and already has to
answer "is it done"; today that answer is prose an agent writes about itself.
After DX10 it is one command with an exit code, and the *agent* runs it. The end
user runs nothing new.

## 3. Current repository context

Files and facts this plan depends on, with the exact identities:

- `packages/core/src/solution-plan.js` — `solutionPlanContract: 1`. Stable ids
  exist for `decisions[].id`, `steps[].id` and every `evidence.*[].id`.
  `acceptance.checks[]` is an array of **bare strings with no identifier**.
  `acceptance.artifacts[]` are keyed by a unique repo-relative `path`.
  `fingerprintPlan()` hashes the whole normalized document; `inspectionFingerprint()`
  derives a composition digest from an AX1 report; `bindSolutionPlan()` produces
  `PLAN_STALE` / `CAPABILITY_NOT_AVAILABLE`.
- `packages/cli/src/project-verify-command.js` — `projectVerificationContract: 1`.
  Stable check codes: `structure.doctor`, `structure.carried.<id>`,
  `application.inspect`, `plans.current`, `packages.conformance`,
  `packages.conformance.<path>`, `suite.verify`, `suite.smoke`, `worktree.clean`.
  Statuses `passed|failed|warning|skipped|not_applicable`. Semantic `fingerprint`.
  Worktree sampled before/after; `WORKTREE_DIRTY_AFTER_VERIFY` names only paths
  that were **clean before the run**.
- `packages/cli/src/scenario-run-command.js` — `scenarioRunContract: 2`.
  Observation codes are `<stepId>.<NN>`, each with `kind`, `status`, `expected`,
  `actual`. The report publishes `composition.compositionFingerprint`, which is
  the **same digest AX2 pins in a plan**.
- `packages/cli/src/project-doctor-checks.js` — `declaredPlans()` reads
  `package.json` → `agentCrm.solutionPlans.{current,required}`. This repository
  declares exactly one current plan.
- `examples/solution-plans/` — three checked-in plans; `examples/scenarios/` —
  two checked-in scenarios, each citing one plan by path.

### The measured starting state (Node 22.16.0, commit `7bd8070`)

```text
app inspect (repo root)     valid, 0 packages, 4 core modules, fingerprint 649add63…
project doctor              passed
solution check lead-to-won                          valid, current            exit 0
solution check activate-support-and-manage-cases    PLAN_STALE ×N             exit 1
solution check govern-delivery-change               PLAN_STALE ×N             exit 1
scenario run service-sla-escalation   passed, 5.6 s, composition 4c203a89…
scenario run lead-to-won              passed, 9.1 s, composition 04e3bd98…
```

The load-bearing discovery is in the last three lines. **The composition digest
the service plan pins — `4c203a89…` — is exactly the digest the service scenario
publishes.** The service plan is not rotten; it was written against a *project*
composition, and this repository is the framework, which composes no domain
package at all. Repinning it to the repo root would delete its two packages, its
four capabilities and its four records and leave a plan that says "in an
application that composes nothing, activate service coverage" — which would also
still fail, on `CAPABILITY_NOT_AVAILABLE`. **Repinning is not available here, and
faking it would be the exact dishonesty this rung exists to prevent.** §7 says
what DX10 does instead.

## 4. Approaches compared

### A. Source and git heuristics — **rejected as a complete solution**

Walk the diff since the plan's revision, match changed paths against
`acceptance.artifacts[].path`, match test filenames against requirement text,
call a requirement satisfied when its artifact exists.

Rejected because **a file matching a name is not proof.** An empty file at the
declared path scores identically to a working one; a renamed file scores zero
while the behaviour is present; and a test *file* existing says nothing about
whether that test ran, passed, or asserts the requirement. It also silently
rewards the one thing the repository already refuses — inferring capability from
structure. Source artifacts survive from this approach as *one* evidence kind,
content-hashed, and with a hard rule attached: **never sole proof of behaviour.**

### B. An agent-authored requirement checklist — **rejected**

The plan gains a `status` per requirement, or a sibling document records
`implemented | partial | blocked` per requirement with a prose justification.

Rejected because it **reproduces the self-report**, which is failure mode 1. The
document would be written by the same agent that wrote the code, read by nobody
with independent facts, and a green checklist would be indistinguishable from an
honest one. A status string that a reader must trust is not evidence; it is a
claim with a schema.

### C. A checked-in evidence map plus a deterministic verifier — **chosen**

The document declares **where to look**. The verifier obtains **what is true**
from authorities that already decide, in this invocation:

```text
the document says      "requirement R is evidenced by DX6 observation sla-boundary.02
                        expecting `journey.fact fact=firstResponseStateAtDueInstant is=at_risk`"
the verifier obtains    the current AX1 report, the current solution check binding,
                        the current project verify receipt, the current scenario report
the verifier decides    R is verified / partial / blocked / unevidenced / stale / unverified
```

The document is **function-free**: it carries no command, script, environment
variable or shell content, unknown keys are refused, every string and list is
bounded, and it has a canonical fingerprint. Crucially **the document cannot
declare that its own evidence passed** — there is no status field anywhere in
`implementationEvidenceContract: 1`, only pointers, a category, and an optional
*downgrade* (`blocked` / `partial`) that can never raise a status.

### D. Fold it into `project verify` — **rejected**

Considered because DX5 already orchestrates. Rejected on DX5's own published
argument: it would make the cheap-to-reason-about health command silently
plan-dependent and multi-minute, it would need a way to choose *which* plan, and
two answers behind one exit code is the overlap question 3 forbids. DX5 keeps
publishing `IMPLEMENTATION_EVIDENCE_NOT_MAPPED`; the message now names the
command that maps it.

## 5. Requirement identity — the inventory first

**The existing identity model, in full**, before adding anything:

| Thing | Stable id today | Shape |
|---|---|---|
| decision | **yes** — `decisions[].id` | author-given identifier, unique, refused on duplicate |
| step | **yes** — `steps[].id` | author-given identifier, unique |
| evidence entry | **yes** — `evidence.<category>[].id` | author-given, unique across all six categories |
| acceptance check | **no** | a bare string in `acceptance.checks[]` |
| acceptance artifact | natural key — `path` | unique repo-relative path, refused on duplicate |
| JTBD row | external — `jobs.json` | not the plan's identity |
| the plan | **yes** — `fingerprint` | SHA-256 over the canonical normalized document |
| the composition | **yes** — `application.inspectionFingerprint` | SHA-256 over canonical AX1 facts |

So exactly one of the two things DX10 needs to address lacks an identifier.

**A requirement is a step or an acceptance check.** A step is the work; an
acceptance check is the criterion. Artifacts are deliberately **not**
requirements — treating a declared file path as a requirement is approach A
wearing a contract, and it is the single most direct route to "the file exists,
therefore it is done". JTBD rows are not requirements either: they are DX6's
unit, a person owns their status, and DX10 promotes nothing.

### Explicit ids versus derived ids

| | Explicit — widen `acceptance.checks[]` to accept `{id, statement}` | Derived — content-address the statement |
|---|---|---|
| AX2 contract change | yes: a new accepted shape, new validation, new normalization | **none** |
| Existing plans | keep working (strings still accepted), but gain no id | **every existing plan is addressable immediately** |
| Plan fingerprints | unchanged for old plans, new shape for new ones | **unchanged everywhere** |
| Rewording a check | id survives — and the evidence silently survives with it | id changes — **the evidence must be re-examined**, which is correct |
| Reordering checks | id survives | id survives (content-addressed, not positional) |
| Failure mode | an author gives two checks the same id, or forgets one | a genuinely duplicated statement collides — refused, see below |

**Chosen: derived, content-addressed.** `requirementId` is
`step:<stepId>` for a step and `check:<first 12 hex of sha256(statement)>` for an
acceptance check. It is the smallest possible additive change because it adds
**nothing** to `solutionPlanContract: 1` — not a field, not a shape, not a
validation rule, and not a byte of any plan fingerprint. Every plan already
checked in, and every plan checked in before this PR, is addressable the moment
this ships, with no migration and no rewrite. That answers "do not rewrite every
historical plan without a migration strategy" by needing no migration at all.

The cost is deliberate: **rewording an acceptance criterion changes its
requirement id**, so the evidence that pointed at the old wording becomes
`unevidenced` rather than silently carrying over to a criterion nobody
re-examined. That is the behaviour we want. Two identical statements in one plan
collide, and the derivation refuses that as `PLAN_REQUIREMENT_DUPLICATE` rather
than letting one requirement stand for two.

The derivation lives in `packages/core/src/solution-plan.js` next to the plan it
describes — one authority, exported as `planRequirements(plan)` — and is
published by `solution inspect|validate|check --json` under a top-level
`requirements` key, **outside** the `plan` object so no fingerprint moves. There
is no second identifier system: `step:` reuses the id the author already wrote.

## 6. The two contracts

### `implementationEvidenceContract: 1` — checked in, function-free

```jsonc
{
  "implementationEvidenceContract": 1,
  "plan": "examples/solution-plans/lead-to-won.plan.json",   // repo-relative, safe
  "planFingerprint": "<64 hex>",
  "applicationInspectionFingerprint": "<64 hex>",
  "requirements": [
    {
      "requirementId": "check:2f0a…",
      "category": "project-health",
      "evidence": [ { "kind": "project.verification", "check": "suite.verify", "expect": "passed" } ],
      "partial": { "reason": "…" },      // optional, downgrade only
      "blocked": { "reason": "…" }       // optional, downgrade only
    }
  ],
  "limitations": [ { "code": "…", "message": "…" } ]
}
```

- **No status field, anywhere.** Status is derived from evidence.
- `partial` and `blocked` are **downgrades**: they can lower a requirement's
  derived status and can never raise it. Both require a non-empty `reason`;
  `{"blocked": {}}` is `EVIDENCE_BLOCKED_REASON_MISSING`. They are mutually
  exclusive.
- Unknown keys are refused at every level. Every string and list is bounded.
  Every string goes through the **same exported `EXECUTABLE_SHAPES`** the plan
  and scenario validators use — one refusal, one place to fix it.
- `fingerprint` is a SHA-256 over the canonical normalized document, keys sorted
  at every depth, excluding the fingerprint itself.
- A requirement id may appear once. Evidence refs are unique within a
  requirement. **There are no evidence-to-evidence citations in v1**: an evidence
  entry names an authority and a fact, and nothing else, so there is no graph to
  keep acyclic and AX2's citation DAG is not recreated. References resolve in
  exactly one direction — evidence → authority — and a conclusion cannot be its
  own premise because a conclusion is never expressible as evidence.

### `solutionVerificationContract: 1` — the report

Answers, in this order: which requirements are **proven, partial, blocked,
unevidenced, stale, unverified**; which authoritative runs were used and their
fingerprints; and what remains unproven.

```text
exit 0   every required requirement is machine-verified in this invocation
exit 1   readable, but incomplete, stale, partial, blocked, or manual-only
exit 2   the plan or the evidence document could not be read, or an authority
         could not be run at all
```

**Exit 0 is forbidden while any requirement is `unverified`** — the status a
manual-only requirement gets. A partial plan is never "verified with warnings":
`partial`, `blocked`, `unevidenced`, `stale` and `unverified` all force exit 1,
and the report's own `status` is `incomplete`, never `passed`.

## 7. What the plan binds to, and why a scenario may answer it

AX2's `inspectionFingerprint` names the **application** a plan was written
against. In a *project* that is the project itself. In this repository — a
framework whose root composes no domain package — the application a plan
describes is the one a starter composes, and the only authority that produces it
is DX6, which publishes it as `composition.compositionFingerprint`.

So `solution verify` resolves the binding against the authorities that ran in
**this** invocation, and names which one answered:

1. AX1 at the project root, via `solution check`. If the digests match, the
   binding is `project` and `bindSolutionPlan()` grades packages, capabilities,
   records and step capabilities in full.
2. Otherwise, each **explicitly referenced** scenario's published composition
   digest. If exactly one matches, the binding is `scenario:<id>`.
3. Otherwise `PLAN_NOT_CURRENT`: every requirement is `stale`, exit 1.

When the binding is a scenario, `application.fact` evidence is **refused** with
`EVIDENCE_AUTHORITY_NOT_AVAILABLE`, because the only full AX1 report in hand
describes a *different* composition. Requirements about that composition must
cite scenario observations, which is where the fact was actually observed. This
is the rule that keeps DX10 from quietly answering a question with the wrong
application's facts.

## 8. The closed evidence vocabulary

| Kind | Authority | What it names | Never |
|---|---|---|---|
| `application.fact` | AX1 (`solution check`'s report) | `package.composed`, `capability.available`, `module.present`, `action.present`, `policy.present`, `resource.present` — the **same names DX6 uses**, not a second vocabulary | answerable when the plan binds through a scenario |
| `source.artifact` | the repository | repo-relative path + `sha256` of the current bytes | **sole proof of behaviour, ever** |
| `project.verification` | DX5 | a stable check code + the status expected | invented; an unknown code fails |
| `package.conformance` | DX5's `packages.conformance.<path>` | a composed package path | a pass when the package was not graded |
| `scenario.observation` | DX6 | scenario id + observation code + the exact `expected` string | a pass when the observation is missing, failed, or its `expected` string moved |
| `manual` | a human | a bounded description of what a person checked | machine proof — see below |

**Manual evidence is accepted in v1**, and it can never count as proof. A
requirement whose evidence is manual-only is `unverified`, forces exit 1, and
puts `MANUAL_EVIDENCE_IS_NOT_PROOF` in the report's limitations. Accepting it is
the lesser evil: refusing it means the browser requirement simply *vanishes* from
the document, and this repository's own doctrine is that a gap which is stated is
part of the deliverable while a gap that is omitted is a claim.

**There is deliberately no `test` evidence kind.** A test *name* would be
exactly the arbitrary string the brief refuses, and DX5's receipt does not
enumerate which tests ran — it reports that `npm run verify` exited 0. Until an
authority publishes per-test results, citing a test name would be a claim
dressed as a citation. `project.verification` on `suite.verify` says the true,
weaker thing: the declared suite ran and passed in this invocation.

## 9. The sufficiency matrix

Categories are declared in the evidence document from a closed set; the
**required authority is not**, and neither is the outcome.

| Category | Satisfied by | Explicitly insufficient | Authority and rationale |
|---|---|---|---|
| `structural` | ≥1 fact-authority ref: `application.fact`, `package.conformance`, or a `scenario.observation` whose **kind is a composition kind** | `source.artifact` alone | a record, action, policy or resource either is in the composition or is not, and AX1 decides that from source. **No scenario is required for a purely structural requirement.** |
| `behavioural` | ≥1 `scenario.observation` whose **kind is a runtime kind** — `journey.completed`, `journey.count`, `journey.fact` | everything else, alone or together: `source.artifact`, `application.fact`, `action.present`, `package.composed` | only a run can evidence what the application *does*. `file exists` must never satisfy a behavioural requirement, and neither may `the action is declared` |
| `project-health` | ≥1 `project.verification` | anything else alone | DX5 is the health authority; nothing else runs the suite |
| `package-architecture` | ≥1 `package.conformance`, or an `application.fact` about a package or capability | `source.artifact` alone | DX4/DX5 conformance and AX1's resolved capability graph are the seam's authorities |
| `manual` | `manual` only | — | there is no automation; it resolves to `unverified` and is published as a limitation |

The observation **kind** is taken from the DX6 report, not from the document, so
an author cannot relabel `action.present` as behavioural evidence. `source.artifact`
is never sufficient on its own for any category — it is corroboration that the
named file is the one that was verified, and its hash is what makes the evidence
go stale when the file moves.

A **floor** is applied where the plan itself carries the information: a step
whose decision type is `configure`, `extend`, `provider` or `create-package`
changes what the application does, so declaring it `structural` is refused
(`EVIDENCE_CATEGORY_BELOW_FLOOR`). A step whose decision is `evolve` has a floor
of `structural`. Acceptance checks carry no floor — the plan says nothing about
their nature — so their category is declared, recorded verbatim in the report,
and bounded by the published limitation `REQUIREMENT_CATEGORY_IS_DECLARED`.

## 10. Staleness, integrity and execution

**Evidence stales when:** the plan fingerprint moves; the bound composition digest
moves; a cited capability, action, module, policy or resource disappears; a cited
source file's content hash changes; a cited DX5 check's status differs from the
expectation; a cited scenario observation is missing, failed or its `expected`
string moved; or a policy/provider version moves — the last inside AX1's own
composition digest, since a policy's declared-definition fingerprint is part of it.

**Cosmetic, path-independent facts stay stable** by inheritance: AX1's digest
already excludes labels, descriptions, hints, routes, absolute paths, timestamps,
config values and runtime status, and DX5's and DX6's fingerprints are *semantic*
— they exclude duration and machine layout. Two runs from different directories
produce byte-identical reports.

**A previously verified report cannot be replayed.** Nothing is cached and no
prior report is read. Every fact in the report comes from an authority that ran
in this invocation, and the report records each authority's fingerprint so a
reader can tell two runs apart.

**Execution budget, per invocation:** AX1 once (inside `solution check`),
`solution check` once, `project verify` **at most once and only if** at least one
`project.verification` or `package.conformance` reference exists, and each
**explicitly referenced** scenario exactly once. No arbitrary project command, no
command from a document, and `ACCORDO_SOLUTION_VERIFY_DEPTH` refuses a recursive
`solution verify` the way DX5 refuses a recursive `project verify`. Output and
time are bounded; canonical JSON goes to stdout and nothing else does; no secret,
absolute path or stack reaches the report.

**Trusted-source posture, not a sandbox.** The scenarios and suites this command
delegates to are checked-in repository source running with the operator's
authority. Child processes are bounded in time, output and process group. That is
isolation. It is published as `VERIFICATION_SOURCE_TRUSTED`, and no sandbox is
claimed.

**Dirty state** reuses DX5's hardened semantics verbatim, by importing them rather
than copying: the worktree is sampled before and after, files already modified
beforehand are **context**, files that become dirty *during* verification are a
failure, files silently reverted are a failure, and nothing is ever reset,
stashed or cleaned. The evidence document is routinely an uncommitted file under
active work; it is dirty *before* the run and is therefore classified as context,
which is pinned by a test rather than assumed.

## 11. Milestones

1. **`planRequirements()` in core** + vocabulary publication + tests. Repository
   stays runnable; no fingerprint moves.
2. **`implementationEvidenceContract: 1`** in `packages/core/src/implementation-evidence.js`
   — parse, validate, normalize, fingerprint, bounds, refusals + tests.
3. **`solution verify`** in `packages/cli/src/solution-verify-command.js` +
   wiring in `commands.js` and the help text.
4. **Two checked-in evidence documents** against the two real plans, and the
   report shape shaken out against both before the contract is frozen.
5. **The mutation matrix**, twelve mutations per plan, each reverted and proven
   by re-running to an identical report.
6. **Docs, ADR-030, roadmap, North Star, Tool Surface, JTBD evidence**, and the
   full verification sweep.

## 12. Validation

```bash
npm install && npm run verify && npm run smoke && npm run gtm:check
npm run crm -- project doctor --json
npm run crm -- project verify --json
npm run crm -- scenario run lead-to-won --json
npm run crm -- scenario run service-sla-escalation --json
npm run crm -- solution verify examples/solution-plans/lead-to-won.plan.json \
  --evidence examples/implementation-evidence/lead-to-won.evidence.json --json
npm run crm -- solution verify examples/solution-plans/activate-support-and-manage-cases.plan.json \
  --evidence examples/implementation-evidence/activate-support-and-manage-cases.evidence.json --json
```

Expected: both `solution verify` invocations exit **1** and say precisely why —
that is the true state of both plans, and a green exit here would be the defect.
Everything else exits 0.

## 13. Decision log

- **Requirement id is derived, not declared.** §5. No AX2 contract change, no
  fingerprint movement, no migration, and rewording a criterion correctly
  invalidates its evidence.
- **Artifacts and JTBD rows are not requirements.** §5.
- **No status field in the evidence document.** §6. `partial`/`blocked` are
  downgrades with a mandatory reason.
- **No evidence-to-evidence citations in v1.** §6. AX2's DAG is not recreated.
- **No `test` evidence kind.** §8. No authority publishes per-test results.
- **Manual evidence is accepted and can never be proof.** §8.
- **A scenario may answer the plan's composition binding.** §7. It is the only
  honest way to verify a plan written against a project composition from a
  framework repository, and it is derived, never declared.
- **The behavioural rule is keyed on the observation's *kind*, taken from the DX6
  report.** §9. An author cannot relabel a composition fact as behaviour.
- **`solution verify` is absent from every SKILL.md.** §2 question 4.
- **No MCP implementation here.** The Tool Surface maps `solution.verify` under
  the deferred Solution namespace as policy; DX13 remains unbuilt.

## 14. Progress log

- Read AGENTS.md, the Quality Gates, AX1/AX2, DX5, DX6, the roadmap, the North
  Star, the Tool Surface and ADR-029. Inventoried the plan identity model.
- Measured the starting state on Node 22.16.0 at `7bd8070` (§3), which produced
  the composition-binding discovery in §7.
- Milestones 1–6 implemented.
- **The mutation matrix, run against both real plans**, each mutation applied to
  the real checkout and reverted from an in-memory snapshot, with the revert
  proven by re-running to a byte-identical report rather than by `git status`:

| Mutation | Plan | Code | Where it landed |
|---|---|---|---|
| baseline | service | — | 6 verified, 4 partial, exit 1 |
| delete a required capability (`service-obligations` renamed in `packages/contracts/src/service-capability.js`) | service | `PLAN_NOT_CURRENT`, `EVIDENCE_OBSERVATION_FAILED` | the journey refused; no authority reproduced the pinned composition, so every requirement is `stale` |
| change an action identity (`record-escalation` → `record-escalation-v2`) | service | `PLAN_NOT_CURRENT`, `EVIDENCE_OBSERVATION_FAILED` | as above |
| remove a source file | service | `EVIDENCE_SOURCE_ABSENT` | `step:step.record-sla-and-escalation` only |
| change a source hash | service | `EVIDENCE_SOURCE_HASH_MISMATCH` | exactly the four requirements citing a source artifact |
| make a scenario observation fail (`now > due` → `now >= due`) | service | `PLAN_NOT_CURRENT`, `EVIDENCE_OBSERVATION_FAILED` | the journey asserts the boundary itself, so it refused rather than publishing a wrong fact — a stronger refusal than one failed observation |
| move an observation's meaning (`escalationRouted` expectation flipped in the scenario document) | service | `EVIDENCE_OBSERVATION_MOVED` | `check:905912f60da4` only; the code still exists and no longer means the same thing |
| change the plan fingerprint | service | `EVIDENCE_PLAN_FINGERPRINT_STALE` | all ten `stale` |
| stale the composition | service | `PLAN_NOT_CURRENT`, `EVIDENCE_INSPECTION_STALE`, `EVIDENCE_PLAN_FINGERPRINT_STALE` | all ten `stale` |
| cite an unknown observation | service | `EVIDENCE_REFERENCE_UNRESOLVED` | `step:step.manage-cases` only |
| map a behavioural requirement only to file existence | service | `EVIDENCE_STRUCTURAL_ONLY` | `step:step.manage-cases` only |
| mark blocked with no reason | service | `EVIDENCE_BLOCKED_REASON_MISSING` | `step:step.manage-cases` only |
| omit a requirement | service | `EVIDENCE_REQUIREMENT_MISSING` | `step:step.manage-cases` only |

  Two of the three journey-breaking mutations produce the same semantic
  fingerprint, and that is the truthful answer rather than a gap: in each case
  the journey — the authority — refused, so DX6 published no composition and no
  requirement could be proven. Per-requirement precision for a *single* failed
  observation is pinned in `tests/solution-verify.test.js` instead, where the
  delegate is injected.

  The lead matrix covers the DX5-shaped mutations the service plan cannot reach.
  Every requirement of that plan which is machine-checkable rests on DX5, and a
  real `project verify` on this repository takes eleven to thirteen minutes — so
  fourteen mutations would be three hours of re-running one suite to learn
  nothing about DX10. The **real receipt** from an unmutated
  `crm project verify --json` run in this checkout is injected instead; the
  end-to-end path that really spawns DX5 is proven by the unmutated run, which
  did.

| Mutation | Code | Where it landed |
|---|---|---|
| baseline | — | 1 verified, 1 partial, 3 blocked, 1 unverified, exit 1 |
| delete a required capability (cite one this composition lacks) | `EVIDENCE_FACT_ABSENT` | `check:f3c222d2bfe2` only |
| change an action identity | `EVIDENCE_FACT_ABSENT` | `check:f3c222d2bfe2` only |
| remove a source file | `EVIDENCE_SOURCE_ABSENT` | `check:f3c222d2bfe2` only |
| change a source hash | `EVIDENCE_SOURCE_HASH_MISMATCH` | `check:f3c222d2bfe2` only |
| make Project Verify fail (expect a status the receipt does not have) | `EVIDENCE_CHECK_UNEXPECTED_STATUS` | `check:af9d6ee5ccc4` only |
| cite an unknown check code | `EVIDENCE_REFERENCE_UNRESOLVED` | `check:af9d6ee5ccc4` only |
| cite a package nothing graded for conformance | `EVIDENCE_REFERENCE_UNRESOLVED` | `check:af9d6ee5ccc4` only — a package this project does not compose has no pass to cite |
| make a scenario observation fail (`capture.02` demands 9999 leads) | `EVIDENCE_OBSERVATION_MOVED` | `check:94439cfe3fe3` only. The `expects` pin fires *before* the run does: editing the scenario changed what the code means, and that is caught without waiting to see it fail |
| change the plan fingerprint | `EVIDENCE_PLAN_FINGERPRINT_STALE` | all six `stale` |
| stale the composition | `PLAN_NOT_CURRENT`, `EVIDENCE_INSPECTION_STALE`, `EVIDENCE_PLAN_FINGERPRINT_STALE`, `EVIDENCE_AUTHORITY_UNAVAILABLE` | all six `stale`, and the application fact becomes unanswerable because the binding is gone |
| map a behavioural requirement only to file existence (with a hash that **matches**) | `EVIDENCE_STRUCTURAL_ONLY` | `check:94439cfe3fe3` only — the reference resolved, and it is still not proof |
| mark blocked with no reason | `EVIDENCE_BLOCKED_REASON_MISSING` | `step:step.publish-dwell-view` only |
| omit a requirement | `EVIDENCE_REQUIREMENT_MISSING` | `check:af9d6ee5ccc4` only |

  Every one of the fourteen produced a **distinct** report fingerprint, and
  reverting all of them re-ran to the baseline fingerprint byte for byte.

- **Resilience**: a path with spaces, `LANG=tr_TR.UTF-8` and
  `TZ=Pacific/Kiritimati` produce a **byte-identical** report to the repository
  root. A symlinked plan path, an absolute path outside the project and
  `--root /` are each refused with exit 2 before anything runs. A journey
  flooding stdout leaves stdout as pure canonical JSON and degrades the affected
  requirements to `unevidenced` — never to a pass. `ACCORDO_SOLUTION_VERIFY_DEPTH`
  refuses a recursive invocation with no report at all.

## 14b. Measured cost

| Invocation | Time | Report |
|---|---|---|
| service plan (two scenario runs' worth of authorities: AX1 + one scenario) | seconds | ~31 KB of JSON including the published vocabulary, ~24 KB without it |
| lead plan (AX1 + one scenario + a real `project verify`, which runs this repository's own suite and smoke) | ~10–11 minutes on an idle machine, longer under contention | ~28 KB with the vocabulary, ~21 KB without |

The cost is the suite's, not the command's, and it is declared rather than
hidden: a document that references no DX5 check never runs DX5.

## 15. Outcome and follow-up

Shipped: two contracts, one command, two checked-in evidence documents, the
mutation matrix, the guide, ADR-030 and the canonical doc updates.

**PROVE stays partial, and DX10 moves to Shipped.** The rung exists; the claim
does not follow from it. No checked-in plan in this repository is fully
machine-verifiable today: `lead-to-won` has a manual browser requirement, a
genuinely blocked one and two that are simply not built; the service plan has
requirements the shipped scenario only partly observes. Promoting PROVE because
the command exists is precisely the move DX10 was built to stop. The condition
under which PROVE could move is now stated and machine-checkable: a checked-in,
declared-current plan whose `solution verify` exits **0**.

Follow-up, none of it blocking: a per-test authority would allow a `test`
evidence kind; a browser authority would allow `manual` to shrink; DX9 and DX13
remain unbuilt.
