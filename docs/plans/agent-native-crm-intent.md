# Agent-native CRM framework intent

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcome and Follow-up` current while the work proceeds.

This plan follows `.agent/PLANS.md`.

## Goal and User-visible Outcome

Accordo already has an evidence-backed concept page whose internal intent is “a
framework a coding agent uses to build a CRM,” but its public title is “Why CRM
is the narrowest true label.” Live searches for agent-native and custom CRM
frameworks surface operational CRM products and general-purpose agent frameworks,
not Accordo. After this change, the existing page has one explicit search identity:
an agent-native CRM framework that a coding agent builds with. The page must still
say, in the same first-contact surface, that this is not a hosted AI CRM, runtime
copilot, autonomous salesperson, or production-ready application.

The observable result is a rendered
`concepts/customer-and-revenue-os.html` whose title, description, canonical,
breadcrumb, concept index and `llms.txt` entry agree. No duplicate URL is added.

## Current Repository Context

This branch is stacked on PR #55 (`agent/intent-discovery-metadata`), which in
turn follows the Customer Hub, Smart CRM and CDP + CRM intent stack. The relevant
source is `site/concepts.json`; `scripts/site-pages.js` renders it into the concept
page, concept index, sitemap and agent retrieval surfaces. `tests/site-pages.test.js`
checks the content contract and `tests/site-seo.test.js` checks the crawler-facing
identity. `site/claims.json` is the only authority for product claims.

This is copy and retrieval metadata, not product capability. It changes no CRM
state, service, workflow, package, command, tool or schema. It therefore does not
trigger the Compatibility Backfill Rule or ADR-018.

## Milestones

1. Reframe the existing concept entry with a precise `metaTitle`, intent,
   description and opening section. Keep all capabilities attached to claim ids and
   keep the deployment, benchmark and runtime boundaries explicit.
2. Add focused regressions proving there is exactly one canonical search identity,
   that people and coding agents can both reach it, and that the page does not widen
   “agent-native” into a hosted or autonomous runtime claim.
3. Update `TASKS.md`, render the page in Chromium, run focused gates, full
   verification, application inspection, project doctor and adversarial review.
4. Publish a stacked review-ready PR. Do not merge or deploy it; the earlier stack
   must merge in order first.

## Validation

From the repository root:

    npm run site:build
    node --test tests/site-pages.test.js tests/site-seo.test.js
    npm run gtm:check
    npm run verify
    npm run crm -- app inspect --json
    npm run crm -- project doctor --json

Acceptance requires the built page title to be unique and under the site limit,
its canonical to remain the existing URL, its description to state both the
coding-agent use case and the deterministic-runtime boundary, and its breadcrumb,
concept index and `llms.txt` entry to use the same public title. The suite must
remain green and no page may claim indexing, ranking, recommendation or a measured
agent advantage.

## Progress

- [x] (2026-08-09) Verify local `main`, `origin/main`, open GTM PRs, npm and live
  search results.
- [x] (2026-08-09) Identify the existing concept URL as the correct canonical;
  adding a second keyword page would create semantic overlap.
- [x] (2026-08-09) Reframe the checked concept, add regressions and expose it in
  the generated compact and full `llms.txt` surfaces.
- [x] (2026-08-09) Render and adversarially review the page; focused tests pass
  28/28, `gtm:check` passes, and the full suite passes 787/787.
- [ ] Run clean-clone verification and publish the stacked PR.

## Surprises & Discoveries

- Live search results for “open source CRM framework” are dominated by working CRM
  products such as Frappe CRM and developer frameworks such as Atomic CRM; a query
  combining agent-native and CRM surfaces general-purpose agent frameworks and
  agent-operated CRM products. Accordo does not appear.
- The missing semantic surface is not actually a missing URL. The existing
  `customer-and-revenue-os` entry already carries the exact internal intent, but
  the crawler-facing title describes an internal category argument instead.
- The site build put the concept in the sitemap and index, but the hand-curated
  `llms.txt` overview omitted it. The generator now requires the canonical entry
  and fails closed if it disappears.
- Adding Gemini to the previous phrase “coding agents use to generate” would have
  implied successful builds that the unrun benchmark cannot prove. The overview
  now says only what is checked: first-contact instructions exist for the three
  coding-agent surfaces.

## Decision Log

- Decision: improve the existing canonical instead of creating
  `/concepts/agent-native-crm-framework.html`.
  Rationale: both pages would answer the same question. One complete answer is
  easier for a person, crawler and coding agent to identify than two pages competing
  for the same intent.
- Decision: define “agent-native” as an authoring interface, not runtime AI.
  Rationale: the evidence proves source inspection, bounded tools, deterministic
  workflows and tested human boundaries. It does not prove an autonomous runtime,
  a hosted product or recommendation prevalence.

## Idempotence and Recovery

All changes are checked JSON, Markdown and tests. The site build is deterministic
and rewrites ignored `site/dist`. If any claim cannot resolve to the ledger, remove
the sentence rather than inventing evidence. The branch can be discarded without
touching the earlier PRs or the user's dirty `.codex/config.toml` on `main`.

## Outcome and Follow-up

Not complete yet. After review, the source still needs the regular merge order
`#44 → #53 → #54 → #55 → this PR` and a successful site deployment before the
page is public. Search indexing and unaided recommendation are measured outcomes,
not acceptance criteria a source change can claim.
