# GTM — the Smart CRM intent page (ExecPlan)

## Goal and user-visible outcome

Publish one evidence-bound concept page for the search and coding-agent intent
"smart CRM". The page must make Accordo's actual distinction legible: a coding
agent may compose the CRM, while deterministic policies, explicit human approval,
audit and trace govern the commercial mutations proven by the repository. It must
not imply that Accordo is a hosted AI assistant, an autonomous seller, or that no
model can run anywhere at runtime.

The page is complete when `/concepts/smart-crm.html` is emitted, indexed, linked
from the Concepts pillar and retrieval surfaces, visually checked at desktop and
mobile widths, and every capability sentence resolves to an existing ledger claim,
test or limitation.

## Current repository context

This work is stacked on `claude/gtm-customer-hub-intent` at `a836fbc`, because that
branch already adds the sixth concept page and the semantic `recordChain` content
contract. The live PR for that base is #44; this branch must target it rather than
duplicate its changes against `main`.

Relevant authorities and implementation files:

- `docs/strategy/GO_TO_MARKET.md` and
  `docs/strategy/RECOMMENDATION_MAP.md` refuse the generic "AI CRM" category but
  allow agent-built CRM positioning when the deterministic boundary is explicit.
- `site/answers.json` refuses the repository-wide statement that an LLM never
  decides anything at runtime because the ledger does not prove that universal.
- `site/concepts.json` owns intent-shaped architecture arguments. The existing
  `the-refusal-boundary` and `deterministic-by-construction` pages contain the
  narrower evidence this page may compose.
- `scripts/site-clusters.js` validates and renders structured concept content;
  `tests/site-pages.test.js` and `tests/site-seo.test.js` hold its public contract.
- `site/assets/styles.css` supplies the existing paper, ink, accent and warning
  visual language. No new dependency or design system is needed.

Baseline receipt: after `npm run site:build`, the focused Customer Hub, internal
link, head, structured-data and sitemap tests pass 5/5. The first attempted filtered
test command omitted the required site build and failed only because `site/dist`
did not exist; the corrected command is the baseline used here.

## Design and implementation decision

Three expressions were compared:

1. Prose only. Rejected: the key boundary would be another marketing paragraph and
   the real refusal would be buried below the hero.
2. Reuse `recordChain`. Rejected: that contract is reserved for ordered owned
   records. An approval refusal is not a record sequence.
3. Add an optional typed `refusalProof` block to the cluster content contract.
   Chosen: it renders the exact tested request, asserted actor and 403 result as
   semantic text after the mandatory boundary and before the essay sections.

The visual direction stays inside the existing site: system sans for explanation,
mono for the executable receipt, paper/surface/ink/accent/warning tokens, no
gradient, AI icon or decorative flow chart. The signature element is the real
`403 HUMAN_APPROVAL_REQUIRED`. The component is optional and on-demand, so pages
without a meaningful refusal do not acquire another empty marketing pattern.

This is an agent-facing public content contract. The DX Simplicity Gate is cleared
because it prevents one concrete failure: a coding agent recommending Accordo as an
autonomous runtime AI CRM. Existing prose cannot provide machine-validated shape or
ordering. The new object is not a command or namespace, carries its own validation,
and makes the end-user answer shorter: one receipt establishes the boundary. Because
the surface is horizontal, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` will record
the status of existing domains without refactoring any of them.

## Milestones

### 1. Contract and content

Add and validate `refusalProof` with a small fixed schema, escape every authored
field, include its strings in the forbidden-vocabulary scan, and render it after
`boundaryBlock()` and before any section. Add the Smart CRM concept using only
existing claims and limitations.

Repository remains runnable when `npm run site:build` emits the new page and focused
page tests pass.

### 2. Retrieval, strategy and documentation alignment

Document the content contract and design intent, update the GTM recommendation and
content-production state from "uncovered" to the exact prepared artifact, update the
legacy alignment matrix and `TASKS.md`, and regenerate checked retrieval artifacts if
their generator requires it. Do not promote the refused universal runtime-AI answer.

Repository remains runnable when `npm run gtm:check`, site checks and documentation
tests pass.

### 3. Visual and full verification

Build the site, capture desktop and mobile screenshots with the repository browser
workflow, inspect the actual images, then run `npm run verify`. Update the claims
measurement only from a committed code SHA and a clean measured run, following the
repository's ledger convention.

### 4. Publication and independent review

Commit intentionally, push the branch and open a stacked PR against
`claude/gtm-customer-hub-intent`. Use the required adversarial-review skill on the
live PR, fix every actionable finding, verify from a clean clone, and wait for CI.
Do not merge the PR or promote production; those remain human gates.

## Validation commands and expected behavior

- `npm run site:build` — emits `concepts/smart-crm.html` and increments the generated
  page count by one.
- Focused `node --test` over site page and SEO suites — asserts boundary/proof order,
  exact receipt, escaping, canonical, metadata, sitemap and internal links.
- `npm run gtm:check` — all GTM content and ledger contracts pass.
- `npm run site:shots` — produces non-placeholder desktop and mobile images from a
  headless browser; both are inspected rather than accepted from exit status alone.
- `npm run verify` — the repository-wide definition of done passes.
- The same focused and full commands pass from a clean clone of the final PR head.

## Progress log

- 2026-08-09: verified `main`, `origin/main` and live PR #44/#51/#52 state; preserved
  the user's dirty `.codex/config.toml` on `main`.
- 2026-08-09: re-read the strategy, recommendation, site architecture and existing
  Smart CRM/CDP boundaries; verified that the broad no-runtime-LLM claim remains
  unsupported and must not be revived.
- 2026-08-09: selected the typed refusal receipt after comparing prose and
  `recordChain`; ran the corrected 5/5 focused baseline on the stacked worktree.
- 2026-08-09: implemented the closed request/actor/result receipt, the bounded
  Smart CRM page, task-time `llms.txt` link and strategy/docs alignment. Focused
  site, contract and SEO tests pass 8/8; `site:check`, `gtm:check`, distribution
  and surface gates pass.
- 2026-08-09: inspected 1270px desktop and 390px mobile Chromium renders. The
  first mobile render exposed a horizontally clipped request; the component now
  wraps long receipt lines, and the second render shows the full route and result.
- 2026-08-09: adversarial review confirmed one low-severity fail-closed defect:
  the new receipt accepted a whitespace-only result despite calling its shape
  closed. The same seam also had no bound or one-line rule. The contract now
  rejects blank, multiline, oversized and unknown fields, and the hostile-input
  test exercises escaping in all five authored fields.
- 2026-08-09: documentation-truthfulness review confirmed one medium finding:
  the receipt printed an HTTP POST while the commercial suite asserted the same
  actor/status/code through a direct runtime call. The existing end-to-end test
  now sends the approval through the SDK with an agent actor, exercising the
  exact generated HTTP route, actor headers and normalized 403 shown on the page.

## Decision log

- Target the Customer Hub branch, not `main`, so the new page is a small additive PR
  over the concept infrastructure it relies on.
- Treat "Smart CRM" as an intent concept, not a capability. The page adds no domain
  and no claim.
- Use the discounted-quote refusal only in its proven scope. State alongside it that
  actor identity is asserted, not authenticated, and that no RBAC exists.
- Keep the existing rejected answer about global runtime model behavior rejected.

## Outcome and follow-up

Implemented and independently reviewed in stacked PR
[#53](https://github.com/khaoss85/agent-crm/pull/53), targeting the Customer Hub
branch from PR #44. The reviewed artifact head is `b5d5a5d`; this plan-only closeout
commit follows it. The functional review fix is `eb6f167`, and the claims ledger is
bound to that SHA: `npm run verify` reports **777 passing, 0 failing**.

The review found and fixed two defects:

- **Medium — the displayed HTTP receipt was composed from two proofs.** The quote
  refusal was asserted through a direct runtime call while the page printed the
  generated POST route. The commercial end-to-end test now sends the approval via
  an SDK client with `actor.type: agent`, exercising the route, actor headers and
  normalized 403 as one event.
- **Low — the new content contract did not fail closed.** A whitespace-only result,
  multiline receipt, oversized field or unknown key could pass validation. All
  five fields are now closed, bounded and single-line, and hostile markup is
  escaped in every position.

Clean clone `/tmp/accordo-smart-clean.zZ0RrR` passed `npm install`, `npm run verify`
(777/777) and `npm run smoke`. A project scaffolded into the empty directory
`/tmp/accordo-smart-starter.rnUcqm/project` reported valid from `app inspect`,
passed `project doctor`, its own 3/3 tests and its own smoke. Real Chromium produced
the repository's four standard screenshot artifacts; the Smart CRM page was also
inspected at 1270 px and 390 px from
`/tmp/accordo-smart-clean-{desktop,mobile}.png`. All live GitHub checks passed and
there were zero review threads.

The PR is safe to merge **after PR #44**, using a regular merge. A human still has
to merge the stack and allow the normal site deployment. Nothing in this work
publishes to npm, submits to a directory, promotes production or spends a one-shot
launch channel.
