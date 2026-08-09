# CDP + CRM intent: profile layer beside process layer

## Goal and user-visible outcome

Own the positive search and coding-agent intent `CDP + CRM` without turning
Accordo into a customer data platform. The generated site will publish one
concept page that answers how the two layers divide responsibility, plus one
direct answer page for retrieval surfaces. A reader must learn, above the fold,
that a CDP owns ingestion, identity resolution and audiences; Accordo owns a
custom deterministic commercial process; and no bridge between them ships
today.

The work is complete when:

- `concepts/cdp-plus-crm.html` is emitted, indexed and linked from the concepts
  pillar, the existing CDP comparison and the agent-facing `llms` surface;
- `answers/how-to-pair-a-cdp-with-a-crm-framework.html` gives the same bounded answer
  in a compact retrievable form;
- the page includes a semantic two-layer responsibility map that remains clear
  on mobile and with hostile authored content;
- the public strategy stops describing the already-built CDP comparison as
  “not started”; and
- the normal site, GTM and repository quality gates pass.

This does not claim an integration, ingestion, identity resolution,
segmentation, consent, production readiness or support for real customer data.

## Current repository context

This branch is stacked on `agent/smart-crm-intent` at
`fd776c452e625fbc7be01bcf1f8bf3602349d272`. It must therefore merge after PR
#44 (Customer Hub) and PR #53 (Smart CRM), using regular merge commits.

The site is generated from structured sources:

- `site/concepts.json` owns concept pages;
- `site/answers.json` owns short direct-answer pages;
- `scripts/site-clusters.js` validates and renders concept content;
- `scripts/generate-llms.js` chooses the compact task-time retrieval surface;
- `scripts/site-check.js` and `scripts/gtm-check.js` enforce public-claim and
  distribution contracts;
- `tests/site-pages.test.js` and `tests/site-seo.test.js` hold rendering,
  linkage, hostile-input and metadata behaviour.

The existing `compare/vs-a-customer-data-platform.html` is intentionally a
negative category boundary. It already says the two products are different
layers, but its title and intent send a CDP-only buyer away. There is no direct
answer for `CDP + CRM`, so a coding agent cannot retrieve the positive
composition without reading a long comparison page.

Baseline on the branch point:

- `npm install && npm run verify && npm run smoke` — 777 tests pass, smoke is
  green;
- `npm run crm -- app inspect --json` — `valid: true`, no `problems`, eleven
  explicit limitations including source-only inspection, provider health
  unknown and the absent production spine.

## Approaches considered

### 1. Retitle the existing CDP comparison

Rejected. Its job is disqualification: if the user needs ingestion, identity
resolution and segmentation, Accordo is the wrong answer. Turning it into a
positive composition page weakens the honest comparison and creates a page
whose first and second halves disagree.

### 2. Add only a short answer

Rejected as insufficient. It improves `answers.json` retrieval, but provides no
dedicated canonical URL, structured concept metadata or explanatory surface for
the high-value compound query. It also leaves the site's visual explanation of
the boundary buried in prose.

### 3. Add a concept spoke plus a short answer — chosen

The concept page owns the architecture query and links to the existing
comparison for the CDP-only decision. The answer page is the compact retrieval
form. Both cite the same claims and limitations, so they cannot drift into two
product positions.

The concept renderer gains one optional `responsibilityMap` block. It is a
closed content contract with exactly two layers. Each layer states what it owns
and what it does not own; a bridge caption states whether the layers connect in
Accordo today. It is not a generic card grid: the two-column relationship is the
argument of this page, collapses to a labelled sequence on mobile, and every
authored field is escaped and bounded.

## Design direction

Keep the existing Accordo palette, typography and shell. The site already has a
recognisable technical/editorial language; a new palette or illustration would
fragment it.

The signature element is the responsibility map:

```text
PROFILE LAYER                 PROCESS LAYER
CDP                           Accordo
owns: ingest/profile/audience owns: action/policy/audit
does not own: CRM decision    does not own: identity/audience
             └── application-owned bridge; not included ──┘
```

The content, not decoration, creates the distinction. On a narrow viewport the
two layers stack, while the bridge remains a sentence rather than a connector
line that could imply an existing integration. Reduced-motion behaviour is
unchanged because the component introduces no motion.

## DX Simplicity Gate

The concrete failure is a coding agent recommending this framework as a CDP, or
assuming a connector exists because a two-system diagram draws one. Existing
primitives were tried and are insufficient: `recordChain` is reserved for an
ordered chain of records the framework owns, while `refusalProof` is an executed
request/actor/result receipt. Reusing either would encode the wrong semantics.

`responsibilityMap` is optional and appears only on a page whose argument needs
it. It adds no command, tool, namespace or session-time choice. Its value is
machine-readable and testable: exactly two layers, exactly three owned
responsibilities each, one non-responsibility each, a mandatory bridge sentence,
closed keys, bounded single-line text and escaped output. The end-user flow gets
simpler because one retrieved page answers the compound query without requiring
the agent to reconcile the negative comparison with a generic CRM page. The
Compatibility Backfill row records every domain as `not_applicable`: this is a
site content contract, not a runtime capability a domain must adopt.

## Milestones

1. Add the ExecPlan and record the baseline.
2. Add and validate the closed `responsibilityMap` contract, renderer and
   responsive styles.
3. Add the concept and direct-answer entries, connect related pages, and add the
   concept to the compact `llms` surface.
4. Add focused rendering, schema, hostile-input, internal-link and SEO tests;
   update strategy, architecture counts, Compatibility Backfill and `TASKS.md`.
5. Run focused checks, `npm run gtm:check`, full `npm run verify`, smoke,
   browser screenshots, adversarial review and clean-clone verification.
6. Publish a stacked draft PR, bind evidence to its functional commit, wait for
   CI, and mark it ready only when every final-head check is green.

## Validation

Expected commands:

```text
node --test tests/site-pages.test.js tests/site-seo.test.js
npm run site:build
npm run gtm:check
npm run verify
npm run smoke
npm run site:shots
```

The generated page must contain one canonical URL, one `BreadcrumbList` JSON-LD block,
the exact two responsibility labels, a visible absent-bridge statement, the
existing limitation language and resolved internal links. Hostile text in every
new authored field must render as inert text. Missing, blank, multiline,
oversized or unknown `responsibilityMap` fields must fail the build.

## Progress log

- 2026-08-09 — branch created from reviewed Smart CRM head; baseline 777/777,
  smoke green, inspection valid with no problems and eleven limitations.
- 2026-08-09 — selected the concept-plus-answer approach after confirming that
  only the negative CDP comparison exists in concepts, answers and `llms.txt`.
- 2026-08-09 — implemented the concept, direct answer, closed responsibility-map
  contract, responsive renderer, task-time link and strategy/status updates.
- 2026-08-09 — focused site/SEO suite passed 25/25; `npm run gtm:check` passed
  with 3,141 characters of `llms-full.txt` headroom; full verify passed 780/780
  and smoke passed.
- 2026-08-09 — inspected 1270px and 390px Chromium renders. The two layers are
  legible without color, stack without clipping and retain the absent-bridge
  sentence. The standard screenshot harness remains part of the final gate.
- 2026-08-09 — adversarial review confirmed two low documentation findings:
  this plan named a `WebPage` JSON-LD block the template never emits, and
  `SITE_ARCHITECTURE.md` still said 68 generated job pages while the build emits
  60. Both were reproduced from the built artifact, corrected and regression-held.
- 2026-08-09 — the final reviewed functional commit is `a2888ed`. A clean
  worktree at that exact SHA passed 781/781 and smoke; C-20 is remeasured against
  that SHA rather than against the later ledger-only commit.
- 2026-08-09 — pushed the reviewed stack through ledger commit `e611d96` and
  re-cloned it from GitHub. Fresh install, full verify, smoke and the B2B Lead
  Qualification starter all exited 0. The same clone produced all four standard
  browser artifacts plus 1270×4200 and 390×5200 CDP + CRM page captures.
- 2026-08-09 — GitHub checks on plan-close head `c77ee6e` passed (`verify` twice,
  `public-claims` twice and GitGuardian), with zero review threads and a clean,
  mergeable stack. PR #54 was marked ready for human review.

## Decision log

- Keep the existing CDP comparison intact. Capturing a compound intent is not a
  reason to soften the category refusal.
- Reuse the site's visual tokens. The page-specific risk is semantic ambiguity,
  so the deliberate design move is a responsibility map rather than a new skin.
- Name the connector “application-owned bridge” and say it is not included.
  “Integration seam” would imply a framework primitive that does not exist.
- Do not name or rank a CDP vendor. The dated competitor source contains no CDP
  research, and this page does not need a vendor claim to answer the query.

## Outcome and follow-up

The compound intent is implemented in draft PR #54. A crawler or coding agent
can retrieve the canonical concept page, a direct answer, the existing CDP
comparison's related link and both `llms` variants. The page assigns profile and
audience work to a CDP and named actions, versioned policy, audit and trace to
the CRM process layer. It states above the essay that no connector, importer,
integration runtime, production spine or real-customer-data path ships.

The adversarial review found two low documentation defects and no remaining
applicable defect:

1. this plan asked for a `WebPage` JSON-LD block even though the template's
   contract emits `BreadcrumbList`; a runnable parse returned exactly that one
   type, the plan was corrected and the SEO test now holds the exact shape;
2. `SITE_ARCHITECTURE.md` said 68 generated job pages while the build emitted
   60; the document was corrected and a regression now derives jobs, answers,
   concepts and total-page counts from the built artifact.

Hostile markup, blank, multiline, oversized, unknown and prototype-shaped
responsibility-map input fail closed or render inert. Existing entries build
unchanged, every internal link resolves, metadata/canonical/sitemap checks pass,
the layer map is readable at desktop and mobile widths, and the retrieval
surface remains below budget. Runtime mutation, state-machine, transaction,
idempotency, concurrency, exact-query, provider, replay, immutable-record and
audit-count attacks are not applicable: this PR changes no CRM runtime path.

C-20 is measured at the reviewed functional commit `a2888ed`: 781 passing and
0 failing. The following `e611d96` commit changes only the ledger and its derived
public copy. Final clean-clone install, verify, smoke, starter and browser gates
are green. No JTBD status changed; the page links both validated and unsupported
rows without promoting any of them.

PR #54 is ready for human review. Merge order is #44 → #53 → #54 with regular
merge commits, followed by site deployment. Until those actions happen, this
work is repository-ready and not publicly discoverable at its canonical URL.
