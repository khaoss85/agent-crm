---
name: solve-business-goal
description: Turn a business objective into a working Agent CRM solution - discover installed packages, capabilities and providers, analyse the gap, choose or create packages, produce a Solution Plan, build checked-in source, verify it and report evidence. Use when the user states a goal ("track and optimize our funnel", "we need to manage renewals") rather than a technical change. Do not use for a single custom object (create-crm-module), one lifecycle step (create-crm-workflow), a named milestone (the build-* skills) or a pre-merge review (adversarial-review).
---

Read `docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`, `docs/PROJECT_STATUS.md`, `docs/benchmarks/CRM_JTBD_MATRIX.md` and `docs/PACKAGE_AUTHORING.md` first. The worked example is `docs/strategy/OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE.md`.

This workflow is usable **today**, including where capabilities are missing — because reporting a gap honestly is part of the deliverable, not a failure of it.

## 1. Restate the goal before touching anything

1. Restate the business outcome in one sentence and confirm it.
2. Name the **primary metric**. A goal with no metric cannot be verified in step 8 — ask for one rather than inventing it.
3. Name the scope, the constraints and the sensitive-action boundaries.

## 2. Discover what actually exists

Read, do not assume: `AGENTS.md` · `docs/PROJECT_STATUS.md` · `docs/QUALITY_GATES.md` · the JTBD matrix · `docs/PACKAGE_AUTHORING.md` · the composition file `packages/domains/generated/index.js` · each package's README.

Then inspect the running system:

```bash
npm run crm -- package inspect <package-dir>    # identity, resources, actions,
                                                # policies, requires/provides
```

```text
GET /api/schema     # modules, actions, and every registered package's block
```

`npm run crm -- app inspect` does **not** exist. Do not call it, and do not tell the user it exists — assemble the picture from the surfaces above.

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

Machine-readable plus a prose companion: goal, primary metric, assumptions, installed packages, reused capabilities, missing capabilities, packages to create, providers to configure, data model, events and tracking, policies, Admin experience, analytics, tests, approval gates, known limitations, execution order.

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
