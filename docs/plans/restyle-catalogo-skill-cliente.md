# Restyle: catalogo skill dello spazio cliente

## Goal and user-visible outcome
Personalizzazione must not offer coding-agent instructions as business automations. Hide skills whose existing prerequisites require a repository/project coding environment from the owner catalog, including I tuoi, without altering their stored activation or the public catalog API. If no business skill is available, say so plainly and link to Agenti. Remove the developer publishing promotion from the owner catalog.

## Context and decision
`apps/admin/public/admin-personalizzazione.js` joins the API catalog and space activation rows. `packages/space-permissions/src/composition.js` currently lists coding skills with `requires.tier` repository, generated-project or any-project. These are instructions, not runtime agents. No business skills will be invented or relabelled as working automations.

Alternatives: hide a list of names (brittle, misses future coding skills); change the server catalog contract with an audience field (unnecessary cross-lane API work); filter on the existing project prerequisite metadata (chosen, bounded UI fix). The direct skill-detail page and skill service remain separate work.

## Design
Reuse the existing ink/paper surface and green action color, vendored typography and compact empty-state component. Keep one left-aligned explanation and one secondary route to the already-existing Agenti page. No new visual tokens, loading animation or decorative cards. On a genuinely empty business catalog, suppress the toolbar rather than offer filters and an Add action that cannot add a skill. At 1440 and 390 px the same text and navigation must remain legible.

## Milestones and validation
1. Preserve baseline: focused existing Personalizzazione suite is green at origin/main 15cd430.
2. Add regression coverage with the actual shipped catalog: coding skills hidden in both views even when activated; business entries still searchable; packages unaffected; empty state routes to Agenti without writes.
3. Implement the UI filter and empty state; run focused suite, syntax checks and npm run verify. Verify desktop/mobile render using real catalog metadata.
4. Commit and open a Mac-owned Restyle PR, with design approval and production verification still pending.

## Progress
- 2026-11-20: resumed existing clean agent-crm-restyle-pers worktree on new branch restyle/catalogo-skill-cliente; original branch retained. Baseline focused suite passed.

## Outcome and follow-up
In progress. No live state, activation rows, settings or catalog API mutations. AI recommendations and runtime business skill delivery are outside this UI correction.
- Claim verified in the canonical server ledger: owner-claim:0e9f723da891:20261120T13012, Mac. No dispatch for this id.
- Added behavior tests with the shipped catalog. Each new regression failed on the baseline, then passed on the candidate. Existing focused tests remain green.
- Candidate rendered in real headless Chromium at 1440 and 390 CSS px using the shipped catalog: the empty state and Agenti action are present; no horizontal overflow. Screenshots inspected in the handoff evidence folder. These are synthetic local fixtures, not production receipts.
- Full `npm run verify` is running. The customer-card layout family f32824784d04 fails; its files and harness are unchanged. The same failures reproduced with the baseline Personalizzazione source loaded through a Node hook, without modifying the worktree. This is not a green full-suite claim.
