# Go to market

Operating plan reconciled 2026-09-07; positioning and copy extended 2026-09-09.
Durable positioning belongs to [MASTER_PLAN.md](MASTER_PLAN.md) and
[CATEGORY.md](CATEGORY.md); implementation and measurement authority is
`../PROJECT_STATUS.md`, `../repository-truth.json` and `../../site/claims.json`.
Distribution receipts live in `DISTRIBUTION_SUBMISSIONS.md`. Earlier launch waves
are history, not a queue to repeat. The
[September competitive research](AGENTIC_CRM_RESEARCH_2026_09.md) informs the
message, not the implementation status.

## The objective

Help technical teams and agencies build a bespoke B2B CRM with governed quotes
and human approvals, then demonstrate that they can finish the task. Lead with
**Build the customer and revenue system your business actually runs.** Keep the
framework promise: **Describe your sales process to your coding agent; own the
CRM it builds.** Ownership means vendored source and reviewable changes; upgrades
require a merge, not a framework dependency version bump.

Lead the first demonstration with one customer process: brief → project → quote
above threshold → human approval → inspectable audit. Explain the wider product
vision through customer context, prepared work and commercial continuity, but do
not turn that vision into a claim that all those capabilities ship together.
Do not promise an autonomous salesperson, a generally available hosted CRM
account, SSO, billing or a universal agent build success rate.

## Message architecture

The order is **outcome → mechanism → proof → boundary → next action**. The proof
should be a business journey the audience can inspect, not a wall of internal
module names. Safety supports the value; it is not the whole value proposition.

| Layer | Canonical message | Usage |
|---|---|---|
| Main outcome | **Build the customer and revenue system your business actually runs.** | Primary headline; preserve across the framework narrative |
| Category | **The open-source custom CRM framework for coding agents.** | Explain what the visitor can actually evaluate |
| Product principle | **Built by agents. Run by your rules.** | Supporting line with the framework descriptor, not a standalone claim of unattended agents |
| Ownership | **Your process becomes software you can review and own.** | Source-vendoring route, with maintenance and upgrade boundary nearby |
| Proof-led differentiator | **Your agent can write the CRM. It can't approve the discount.** | The bounded approval demonstration; retain its identity/authority limitations |
| Managed-product vision | **Customer context. Prepared work. Decisions that stay yours.** | Only inside a clearly labeled vision section until that complete journey is proven |

### Ready-to-use framework copy — English

**Headline**

> Build the customer and revenue system your business actually runs.

**Subheading**

> Accordo is the open-source custom CRM framework for coding agents. Turn your
> commercial process into reviewable application code, with explicit workflows,
> commercial rules and human approval boundaries.

**Supporting line**

> Built by agents. Run by your rules.

**Primary CTA:** Explore the framework.
**Proof CTA:** See the quote approval flow.
**Ownership explanation:** Your application source is yours to review and
maintain. Upstream improvements require reviewed source merges, not automatic
upgrades.

Use a source-linked walkthrough beside this copy. The current installation and
production limits must stay visible; a docs merge does not update an npm artifact
or certify a deployed service. The approval example demonstrates its selected
workflow, not immunity from an adversary with code or administrator access.

### Ready-to-use framework copy — Italian

**Headline**

> Il tuo processo commerciale, trasformato in software.

**Subheading**

> Accordo è il framework CRM open source per i coding agent. Parti da come
> lavora la tua azienda e costruisci un'applicazione con codice verificabile,
> workflow espliciti e regole commerciali sotto il tuo controllo.

**Supporting line**

> Costruito dagli agenti. Guidato dalle tue regole.

**Primary CTA:** Esplora il framework.
**Proof CTA:** Guarda il flusso di approvazione di un'offerta.
**Ownership explanation:** Il codice dell'applicazione resta tuo da verificare
ed evolvere. Gli aggiornamenti richiedono integrazioni del sorgente da rivedere,
non avvengono automaticamente.

The Italian copy has exactly the same release and identity boundaries as the
English copy; translating a sentence must not strengthen its promise.

### Managed-product vision — usable only with the vision label

**English**

> **Your next decision, with the work already prepared.**
>
> We're building a CRM workbench that brings customer context, prepared actions
> and explicit commercial rules into one place. Agents handle preparation and
> permitted execution; your team stays in control of consequential decisions.
> Every completed case should show what happened and the evidence behind it.

**Italian**

> **La prossima decisione, con il lavoro già preparato.**
>
> Stiamo costruendo un CRM che riunisce contesto cliente, azioni preparate e
> regole commerciali esplicite. Gli agenti preparano il lavoro ed eseguono ciò
> che è autorizzato. Il tuo team mantiene il controllo delle decisioni importanti,
> con un risultato e le sue prove da verificare.

This is product direction, not signup copy or a feature announcement. Do not
remove “we're building” / “stiamo costruendo” or advertise immediate availability
until the relevant managed release earns the complete claim. A polished design
reference, source module or controlled simulation is not that evidence.

## Original campaign lines and their proof gates

The lines below are Accordo's own wording, informed by customer benefits in the
research. They are not attributed competitor quotations. “Release-gated” means
**not licensed for present-tense product advertising yet by this document**.
No editorial label below changes a JTBD coverage status.

| Original line | Customer benefit | Publication scope and necessary proof |
|---|---|---|
| **Your process. Your software. Your rules.** | Business fit and control | Framework positioning with a real source/approval walkthrough and ownership limits. Not a guarantee of arbitrary managed customization. |
| **Keep the context. Skip the reconstruction.** | Understand the customer without piecing everything together | Release-gated: real authorized sources, freshness, conflict handling and a useful customer view; not merely a bounded import or a table. |
| **Describe the job. Review the work.** | Delegate an outcome instead of configuring every step | Release-gated for runtime work: actual trigger, substantive model-produced artifact, clear provenance, scoped execution and stop behavior. Templates cannot be presented as AI output. |
| **Make the decision, not another to-do list.** | A prepared next action instead of extra admin | Release-gated: an ordinary user completes a prioritized case with artifact, policy and consequence visible; no reconstruction of operator states. |
| **The rule is explicit. The outcome is inspectable.** | Understand why an action was allowed and what happened | Use only with the demonstrated workflow and applicable authenticated authority; identify whether evidence establishes an internal write or an external effect. |
| **From customer signal to a result you can verify.** | A commercial process that reaches a real outcome | Release-gated: source → preparation → policy → decision if required → execution → reconciliation. Provider acknowledgement and the relevant business receipt, not a simulated send or booking. |
| **Start with a process. Keep the freedom to change it.** | Useful adoption without losing control | Framework narrative needs an explicit customization/maintenance boundary. Managed migration and exit claims need reconciled import, restore/rollback and destination behavior proofs. |

Do not package every line into one hero. Choose the audience's job, one benefit
and one proof. Keep the main headline stable; vary the supporting angle rather
than inventing a new category for every channel.

### One narrative for a product conversation

**Problem:** customer work becomes fragmented when the process, context and
execution live in different places.

**Proposition:** build the system around the commercial process, then progressively
bring context and governed agent work into that same system.

**Mechanism:** reviewable application code, explicit commercial rules and optional
managed operation; agents prepare, permitted actions execute, required human
decisions remain human, outcomes are reconciled.

**Proof today:** use the source-linked bounded quote/approval journey and state
its release and provider limitations. Do not substitute private pilot receipts
for public availability.

**Vision:** a workbench of prepared customer decisions across the commercial
lifecycle, earned one complete job at a time.

**Next action:** inspect or reproduce the documented framework journey. A
managed-pilot conversation, external campaign or general signup launch requires
its own approved, available path.

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
