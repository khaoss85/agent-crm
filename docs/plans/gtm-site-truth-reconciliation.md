# Product truth and public-site reconciliation

## Goal and user-visible outcome

Make accordo.dev a human-first product website while preserving its retrieval and engineering-evidence corpus. Separate durable Product Truth from generated Repository Truth, derive solution stories from the JTBD catalogue, publish benchmark methodology without manufacturing results, and make deployment provenance observable.

## Current repository context

- `site/brand.json` and the site JSON catalogues feed `scripts/site-build.js`, `scripts/site-pages.js`, and `scripts/site-clusters.js`.
- `site/templates/index.html` is retrieval-led and exposes implementation mechanics before the product is understood.
- `site/claims.json` and `docs/repository-truth.json` are implementation authorities; strategy documents currently repeat some volatile state.
- `docs/jtbd/` separates desired jobs, roadmap ownership, and evidence coverage. `benchmarks/` contains protocols and recorded engineering evidence.
- Production currently serves an older generated page containing the retired “no authentication, tenancy or RBAC” composite limitation and exposes no source SHA.

## Milestones

1. Audit live/source/strategy/JTBD/benchmark/distribution truth and record classified contradictions.
2. Introduce canonical Product Truth, human solution groups, and benchmark definitions; add validation that preserves the desired/implemented/proven distinction.
3. Rebuild the homepage, navigation, product, solutions, how-it-works, developers, agents, and proof journeys from the structured authorities while retaining retrieval URLs.
4. Reconcile strategy/marketing authorities, generated Markdown/llms, SEO metadata, and deployment provenance.
5. Build, visually inspect desktop/mobile representative pages, run all gates, update this plan, commit, and open a pull request.

## Validation

- `npm run verify`
- `npm run gtm:check`
- `npm run site:check`
- `npm run repo:truth -- --check`
- `node scripts/generate-llms.js --check`
- `npm run smoke`
- `python docs/jtbd/tools/verify_catalog.py`
- `node scripts/jtbd-gate.js --json`
- `npm run site:shots`

Expected: all repository gates pass; generated HTML/Markdown and machine assets agree; screenshots show no mobile overflow or navigation/accessibility defect.

## Progress log

- 2026-08-24: Inspected HEAD `82371d2`, GitHub PR state, recent merges, and live accordo.dev. Confirmed open Production Spine v2 M1 PR #119 is parallel runtime work and must not be predicted.
- 2026-08-24: Confirmed live homepage still contains a stale composite tenancy/RBAC negative despite repository truth reporting enforced authorization and one-tenant-per-instance isolation.
- 2026-08-24: Rebuilt the human journey, added product/solution/developer/agent/proof pages, retained retrieval clusters, and added deployment provenance plus stale-negative regression checks.
- 2026-08-24: Reconciled stable strategy, ownership language, site architecture, benchmark discipline and launch/deployment documentation; recorded the classified audit.
- 2026-08-24: Site, GTM, repository-truth, llms, JTBD and smoke checks pass. Desktop and mobile Chromium captures were inspected for hierarchy, overflow and navigation. The complete suite was rerun on the repository-required Node version; see Outcome for the remaining runner limitation.

## Decision log

- Product Truth will describe the durable target product and ownership model without claiming implementation; Repository Truth remains the sole authority for current proof and limitations.
- Keep static Node/HTML/CSS architecture and existing retrieval URLs. Add human-intent routes rather than replacing the knowledge graph.
- Treat PR #119 as unmerged: current public truth remains SQLite and does not claim PostgreSQL work from the open branch.

## Outcome and follow-up

The repository-controlled scope is complete. Product Truth now drives the human story and Repository Truth remains progressive, commit-bound proof. Desired JTBD, current coverage and benchmark result contracts stay separate. A deployed SHA is observable at `/version.json`, so production drift is detectable without Vercel credentials.

Human-only: an account holder must confirm or change the Vercel production branch and alias, deploy this commit, and compare the served `/version.json` SHA with merged main. Trademark clearance and external distribution submissions retain their existing human governance.

## Final integration addendum — 2026-08-24

The final integrator inspected live main `82371d28509e3c8c7e8c857a30cf68d671f95563`, PR #120 head `a4c27ed35600157fe4369aa90483faca1279112d`, and PR #121 head `8a04f8035a5a4eb5164bfb676442ba6c57fbf09b`. PR #120 remains the human-product baseline: dedicated solution pages, Developers, Resources, Product Proof, benchmark architecture, deployment guide, reconciliation audit and focused SEO tests. From PR #121 the integration ports generated strategic Markdown, HTML Markdown alternates, llms discovery, richer deployment provenance, the broader stale-negative scan and stronger outcome/ownership copy where it improves the baseline without collapsing the IA.

Review findings resolved in this integration:

1. deployment commit provenance comes only from `git rev-parse HEAD`; inherited `SOURCE_SHA` and `VERCEL_GIT_COMMIT_SHA` cannot override the checkout, and only a no-Git `NODE_ENV=test` fixture accepts a dedicated full-SHA injection;
2. the delivery/service solution now resolves through service-specific claim C-24 and its service operation suites rather than delivery-economics C-12;
3. the Developers mutation guarantee resolves through C-16 and carries its asserted-actor/non-attestation limitation;
4. How It Works separates `project verify` technical health from `scenario run lead-to-won` business-journey evidence;
5. `site:check` calls the shared strategic-surface inspector and fails on a missing Markdown output, missing/misdirected alternate, wrong HTML canonical, or missing Markdown backlink; the regression test deletes an output and observes the failure.

Tests that required the old homepage to carry registry-version and tour-count literals were corrected: volatile distribution state remains in `site/brand.json`, and composition counts remain in evidence-bearing surfaces rather than buyer-first hero copy. The integration also fixed the pre-existing broken ownership concept link exposed by the full internal-link test.

### Visual acceptance record

Chromium 140 reviewed the exact generated output at desktop and mobile widths for Home, Product, Solutions, Service Operations, How It Works, Product Proof, For AI Agents and Developers. The first pass found the desktop hero pushed its CTAs below the reference fold and the lifecycle rail hid its final stages; the integration reduced hero scale/padding and replaced horizontal clipping with a complete responsive grid. Final browser probes report `scrollWidth === innerWidth` on every reviewed page at 1270px and on Home at 390px. Keyboard traversal reaches the visible skip link first and the mobile `summary` menu with a visible focus outline. The final Vercel preview deployed successfully but is protected by Vercel SSO in this environment; account-level preview access remains a human boundary, while the reviewed bytes are the same `site:check` output the deployment built.
