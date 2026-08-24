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
