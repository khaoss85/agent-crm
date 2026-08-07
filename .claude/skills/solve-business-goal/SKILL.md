---
name: solve-business-goal
description: Turn a business objective into a working Agent CRM solution - discover installed packages, capabilities and providers, analyse the gap, choose or create packages, produce a Solution Plan, build checked-in source, verify it and report evidence. Use when the user states a goal ("track and optimize our funnel", "we need to manage renewals") rather than a technical change. Do not use for a single custom object (create-crm-module), one lifecycle step (create-crm-workflow), a named milestone (the build-* skills) or a pre-merge review (adversarial-review).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js", "examples/solution-plans/lead-to-won.plan.json"]
  repositorySurface: ["docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md", "docs/PROJECT_STATUS.md", "docs/benchmarks/CRM_JTBD_MATRIX.md", "docs/PACKAGE_AUTHORING.md", "docs/SOLUTION_PLAN.md", "docs/APPLICATION_INSPECTION.md"]
  degradesTo: "`crm app inspect --json` for what exists and `crm solution validate|check` for whether the plan is sound against it; both read the project, not a document"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

**Background, where they exist:** `docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`, `docs/PROJECT_STATUS.md`, `docs/benchmarks/CRM_JTBD_MATRIX.md` and `docs/PACKAGE_AUTHORING.md`, with the worked example in `docs/strategy/OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE.md`. They are the deeper source for the steps below, not a prerequisite for them — the steps stand on their own.

This workflow is usable **today**, including where capabilities are missing — because reporting a gap honestly is part of the deliverable, not a failure of it.

## 1. Restate the goal before touching anything

1. Restate the business outcome in one sentence and confirm it.
2. Name the **primary metric**. A goal with no metric cannot be verified in step 8 — ask for one rather than inventing it.
3. Name the scope, the constraints and the sensitive-action boundaries.

## 2. Discover what actually exists

Read, do not assume — and read whichever of these the project actually has: `AGENTS.md` · `docs/PROJECT_STATUS.md` · `docs/QUALITY_GATES.md` · the JTBD matrix · `docs/PACKAGE_AUTHORING.md` · the composition file `packages/domains/generated/index.js` · each package's README. In a project built from this framework most of those are absent; the report below is then the whole of your discovery, and a document you cannot open is never a document you may summarise.

**Start here — the command from *Orient yourself first*, re-read now with the goal in mind:**

```bash
npm run crm -- app inspect --json    # installed packages, the resolved capability
                                     # graph, records and their revisions, actions,
                                     # policies, providers, problems, limitations
```

Read it in this order, and do not skip a step:

1. `valid` — is the composition sound at all?
2. `problems[]` — every missing capability, version mismatch, collision and cycle, each with a code. Fix or report these before planning anything on top of them.
3. `limitations[]` — what the report **cannot** know. Each has a machine-readable code; treat every one as a hard boundary on what you may claim.
4. `packages[]`, `capabilities[]`, `resources[]`, `actions[]` — what you may build on.

Exit codes are the contract: `0` valid · `1` problems (the full report is still printed) · `2` the project could not be read.

Then, where you need per-package or runtime detail:

```bash
npm run crm -- package inspect <package-dir>    # one package in isolation
```

```text
GET /api/schema     # the same picture from a running server
```

Guide, where the project carries it: `docs/APPLICATION_INSPECTION.md`. The report's own `limitations[]` state the same boundaries without it.

**What `app inspect` does not tell you, and you must not infer:**

- whether any **database** has applied a migration, holds data, or holds *good* data — it reads source only;
- whether a **provider** is configured, authenticated or reachable. A provider entry means a definition was composed in source, nothing more. Never infer credentials;
- any **runtime authorization**. There is no auth, tenancy or RBAC in this framework, so no role is enforced anywhere;
- **JTBD or quality-gate status.** `evidence.status` is `not_aggregated` and carries paths, not claims. Read the documents yourself.

Verify the reliability of source **data** separately: `app inspect` says a record exists, never that its rows are complete, deduplicated or correct. Count the nulls yourself.

The JTBD matrix is the repository's own honest statement of what is supported. Treat a row marked `not supported` as authoritative over your intuition.

## 3. Assess the gap in writing

Produce: capability coverage, package reuse, missing capabilities, **data-quality gaps**, provider gaps, hard dependencies, approval requirements and risks. Count the nulls before quoting a rate — a metric computed over mostly-missing data is misleading, and saying so is your job.

## 4. Design: reuse, then extend, never patch the kernel

1. **Prefer an existing official or custom package.** Duplicating a domain that already exists is the most common failure here.
2. **Create a custom package** when nothing provides what you need — `definePackage`, declared resources, declared capability dependencies, versioned policies, function-free metadata (`docs/PACKAGE_AUTHORING.md`).
3. **Never patch the kernel.** If you need something the runtime lacks, that is a missing *generic* runtime capability: raise it as an ADR discussion, do not reach into `packages/core/src`.
4. A record that must gain a field or a status **evolves** — bump its manifest `revision` (ADR-019, `docs/MODULE_EVOLUTION.md`). Do not model a second parallel record to work around the schema.
5. A decision that varies by business is a **versioned, fingerprinted policy**, not a hardcoded branch.

## 5. Produce a Solution Plan before writing code

The plan is a **checked file with a contract**, not prose with headings — `solutionPlanContract: 1`. The validator below is the contract; `docs/SOLUTION_PLAN.md` and the canonical example `examples/solution-plans/lead-to-won.plan.json` are background where the project carries them.

```bash
npm run crm -- solution validate <plan.json>   # the contract alone; reads no project
npm run crm -- solution check    <plan.json>   # validate, then bind to this project's app inspect report
```

Write the plan, record the `app inspect` report you read in step 2 into `application`, and run `check` before writing any code. Fix every problem it reports. Re-run it before the review: a plan bound to a composition that has since moved reports `PLAN_STALE`, and a stale plan is not a plan.

What the contract makes non-negotiable, and why each one is there:

- **six decision types**, one per rung of the hierarchy below — `configure`, `extend`, `evolve`, `provider`, `create-package`, `propose-kernel-capability`. Say which rungs you tried in `rungsTried`.
- **`propose-kernel-capability` may never appear in `steps[]`.** Rung 5 is a proposal you write. Putting it in steps is refused (`PLAN_DECISION_NOT_A_STEP`) because patching the kernel to make a solution fit is exactly what the hierarchy exists to prevent.
- **six evidence categories and no others**, and every derived metric, inference and recommendation must cite what it follows from. A missing category is a problem too — an omitted gap is a claim.
- **approval codes are a closed set.** A `provider` step must carry `install_or_configure_provider`; the validator adds the requirement rather than trusting you to remember it.
- **citations point one way.** A fact and an assumption cite nothing; a derived metric cites facts and assumptions; an inference adds derived metrics; a recommendation adds inferences. Unavailable evidence is never a source. The graph is acyclic by construction, so you cannot cite a conclusion as a premise even by accident.
- **rung 3 and above must show their work.** `provider`, `create-package` and `propose-kernel-capability` each require every lower rung in `rungsTried`, a reason per rung in `rejectedRungs`, and the capability `gap`. Skipping the inspection is how a domain that already exists gets duplicated.
- **the composition fingerprint is derived, not written.** Record the `inspectionFingerprint` that `solution check --json` reports. It is a drift detector, not proof of anything — but it is not a label you compose either, and a free-text value is refused.
- **unknown keys are refused.** If the contract has no field for what you want to say, say it in the fields that exist rather than inventing one.
- **a plan carries no command.** A step names a decision and the seam it uses. Anything that looks like something to run — a shell command, a URL to fetch, a substitution, a script tag — is refused (`PLAN_EXECUTABLE_CONTENT`). That filter is defense in depth; the real boundary is that the shape has no field anything reads as an instruction. Nothing executes a plan, here or anywhere in this framework.

The plan is what the human reviews. Code that arrives before the plan cannot be reviewed as a solution — only as a diff.

## 6. Distinguish implemented from planned, every time

State clearly which parts of the solution exist, which are in an open PR, and which are roadmap only. **Never present Marketing, Analytics Studio, attribution, durable automation or Cloud capabilities as available.** If the goal needs one of them, say what can be built now, what cannot, and what the missing piece blocks.

## 7. Define the user's experience, not just the data

Which Admin views, what each shows, what a reader can conclude from it, and where the limitations are stated **on the screen** — a data-quality panel next to a conversion rate is part of the deliverable.

## 8. Define acceptance before building

Quality Gates · `crm package validate` · unit, integration and E2E tests · a clean-clone run · the browser smoke where available · and the exact JTBD row the solution claims to move, with the evidence that would justify it. A row moves only with linked evidence; "the data model exists" is not "the job is done".

## 9. Ask for approval only at sensitive boundaries

Proceed without asking for analysis, proposals, generation, previews and tests. Require a human for: publishing to production · sending any external communication · activating a journey · changing a live audience · using sensitive data · launching ads · creating or increasing spend · installing or configuring a provider · changing secrets · auto-applying an experiment winner · anything irreversible or destructive.

Real approval **roles** need the Production Spine. Until then this is a human-actor boundary, not RBAC — never describe it as secure.

## The decision hierarchy — try each rung before the next

```text
1. configure an existing package        a policy version, a config value, a view
2. extend through a declared seam       an action, a policy, a record on a package that owns the domain
3. add or configure a provider          when the gap is an integration, not a model
4. create a custom package              when no installed package owns the domain
5. propose a kernel capability          ONLY with generic, multi-domain evidence, as an ADR discussion
```

Say which rungs you tried. Rung 5 is a proposal you write, never a step you take inside a solution.

## Evidence-first output, in this order

```text
Observed facts        what the data says, with the query and its version
Derived metrics       what was computed, and how
Assumptions           what was taken as true without evidence
Inferences            what follows from facts plus assumptions
Recommendations       what to do, traceable to the rows above
Unavailable evidence  what could not be checked, and why
```

No attribution model is causal truth. Where a valid control group exists, report **lift** as the better answer than attribution.

## After the build

```text
observe → diagnose → recommend → propose next version
```

**No silent operational change.** A recommendation is a proposal; applying it is a new plan, a new approval where required, and a new version.

## 10. Finish with evidence, not code

Report: what was built, how it works, the assumptions, the limitations, the Admin views, the tests and their results, the JTBD rows moved and why, and the approvals still outstanding. Run the adversarial review (`docs/QUALITY_GATES.md` §5) before any merge.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).

## Never

Invent a command, a provider, a package or a capability that does not exist · claim an unimplemented capability is available · move a JTBD row without linked evidence · patch the kernel to make a solution fit · send, publish or spend without an explicit human approval · describe any of this as sandboxed or authenticated.
