# Go to market

Current operating plan, reconciled 2026-09-07. Durable positioning belongs to
`MASTER_PLAN.md` and `CATEGORY.md`; implementation and measurement authority is
`../PROJECT_STATUS.md`, `../repository-truth.json` and `../../site/claims.json`.
Distribution receipts live in `DISTRIBUTION_SUBMISSIONS.md`. Earlier launch waves
are history, not a queue to repeat.

## The objective

Help technical teams and agencies build a bespoke B2B CRM with governed quotes
and human approvals, then demonstrate that they can finish the task. Keep the
public promise: **Describe your sales process to your coding agent; own the CRM
it builds.** Ownership means vendored source and reviewable changes; upgrades
require a merge, not a framework dependency version bump.

Lead with one customer process: brief → project → quote above threshold → human
approval → inspectable audit. Other domains are useful supporting detail, not
separate launch categories. Do not promise an autonomous salesperson, a hosted
CRM account, SSO, billing or a universal agent build success rate.

## What is already done

| Work | Evidence and remaining boundary |
|---|---|
| Brand, MIT licence, public repository, domain and GitHub metadata | `../../site/brand.json`, ADR-023; no naming or visibility blocker remains |
| Public site, intent pages, comparisons, articles, demo and retrieval documents | `../../site/`, README demo, generated `llms` assets; publication is not qualified traffic or adoption |
| npm scaffolder | `create-accordo@0.1.0` published 2026-08-19; see distribution receipt. This dated release does not establish that later main capabilities are distributed |
| Agent distribution and Docs MCP | Plugin manifests, published skills, live read-only endpoint, active MCP Registry and Glama listing; fresh host installation remains a separate verification |
| Claims ledger, tour, falsification kit and CI checks | `../../site/claims.json`, `npm run tour`, `npm run falsify`, `npm run gtm:check`, `npm run repo:truth -- --check`; green checks need semantic review of claims and limitations |
| Awesome-list submissions | Four sent on 2026-08-26; two open and two closed at the 2026-09-07 audit. None has verified acceptance in that audit |
| Build benchmark preparation | `CRM_BUILD_BENCHMARK.md`, `../benchmarks/PILOT_PROTOCOL.md`, `../../benchmarks/harness/`; harness availability is not a completed build benchmark |

## Release alignment before promotion

Treat four surfaces independently: framework source, installed npm package,
published site and private managed pilot. A successful repository check proves
none of the other three. The 2026-09-07 audit found current main documentation
beside an older npm payload; keep the version boundary visible until a newly
published package has an installation receipt.

| Priority | Owner | Concrete output | Completion evidence |
|---|---|---|---|
| P0 | Engineering + editorial integrator | Reconcile ledger, README, FAQ, comparisons, technical handoff and generated MCP/llms content with executable authorities | Independent semantic review plus claims/truth checks on the final commit |
| P0 | Release owner | Stage the current scaffolder and document its included source identity and limitations | Packed package installed in an empty directory, generated project checks, provenance; live registry receipt after staged publication approval |
| P0 | Release owner | Align site, package and release notes | Production `version.json`, installed version/source identity and advertised flows agree; old measurements stay dated until remeasured |
| P1 | Engineering | Refresh public measurement on an environment where the suite completes | `node scripts/measure-suite.js --apply`; commit generated record, never hand-edit a SHA or count |
| P1 | Editorial owner | One release narrative explaining customer-visible outcomes and operational boundaries | Every sentence tied to a claim and test; no private pilot result promoted to public Cloud availability |

Technical scope and the limitation beside each capability are maintained in
`GTM_TECHNICAL_EVIDENCE_HANDOFF.md`. Inspect the published payload rather than
assuming it matches main. Install receipts are engineering evidence, not external
adoption evidence.

## Prove the first use case

Prepare three clean sessions against the same released artifact and frozen brief.
Use the existing build benchmark protocol and its edition gates; first confirm
that its preconditions are met. Have pilot users perform the selected B2B journey
and retain failures, interventions and transcripts as well as successes. Recruiting
or contacting participants requires an explicit owner instruction.

Record per session: framework/package identity, agent and model, brief, completed
acceptance checks, elapsed time, manual interventions, blockers, and evidence of
the quote approval refusal and successful human decision. Commit a result artifact
under `../benchmarks/` only after the sessions exist. Publish only the metrics the
chosen edition licenses: a local Edition L result does not license a deployed
Successful Agent Build Rate or Time to First Working CRM claim.

The observation-only tool-selection panels answer whether an agent selects a
framework command. They are not CRM build benchmarks, comparisons or adoption
results. The build rate remains unmeasured until its own protocol is executed.
<!-- truth: benchmark.build_rate.measured=not_measured -->
<!-- truth: benchmark.tool_selection.comparative=false -->

## Turn evidence into distribution

After the released path works, prepare one demo and one transcript-grounded
article for the same use case. Refresh directory copy and review feedback on the
two open submissions. Closed submissions need a reason/acceptance check before
any proposed retry; do not create duplicates. Product Hunt stays gated on the
chosen build benchmark result and owner launch approval. Show HN, syndication,
community posts and direct outreach require an explicit publishing instruction.

Review weekly: qualified visits → documented successful project creation → first
completed business journey → repeat use. Downloads, clones and crawler hits are
reach indicators, not users or customers. Record denominators, time window and
collection method. Until a telemetry policy is approved, use consented pilot
records and existing aggregate sources rather than adding collection code.

## Close old backlog items explicitly

Tour, falsification kit, bootstrap, `llms` generation, MIT and repository opening
are complete foundations and should not return as new work. The old proposed
`launch-ready.js`, `content-check.js` and `site/readiness.json` filenames were not
delivered as named; use the existing claims/truth/verification gates and the
release receipt checklist above, and add automation only for a demonstrated gap.
`SECURITY.md` is the current security posture; a formal threat-model artifact and
a community code of conduct remain separate optional governance work, not claims
that the launch already has them. Trademark clearance, telemetry policy and
external commitments are tracked in `../marketing/PENDING_HUMAN_SUBMISSION.md`.
