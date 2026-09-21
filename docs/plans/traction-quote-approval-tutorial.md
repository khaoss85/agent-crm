# Quote approval tutorial

## Goal and context

Make one client brief reproducible from an empty directory: a discounted B2B quote must wait for a user decision, with the result visible in persisted evidence. Use the existing scaffolder, commercial manifests, fixture catalog, policy and SDK/HTTP services at source baseline `3b51b97`. No runtime, domain behavior or coverage promotion.

## Decisions

Considered wrapping the full starter (too many unrelated journeys), copying an end-to-end test as a tutorial (test harness hides setup), and a small recipe using the scaffolder plus only commercial composition (chosen). The recipe checks its results and preserves a local project for inspection. It is a deterministic replay with simulated actors, not a coding-agent build, authenticated human approval or benchmark. Current source is used explicitly; npm publication is independent.

## Milestones and validation

1. Add brief and runnable recipe. Run into an empty directory; assert price, pending state, agent refusal without business mutation, user decision, frozen snapshot, linked audit and traces.
2. Add transcript and article grounded in that actual run, with downloadable assets and a specific CTA.
3. Verify generated project, focused existing commercial test and site gates. Repeat into an independent empty directory and check occupied-target refusal. Integrator owns full final verification and shared site integration.

## Progress

- Read current authorities and existing commercial end-to-end journey. New recipe paths agreed with integrator.
- Added recipe, downloadable brief, actual transcript and article. Initial module ordering failure fixed using the existing dependency order. Generated empty-composition assertion updated to require commercial; both findings disclosed.
- Final recipe ran successfully into independent empty directories. Generated project verification passed. Occupied target refused without changing its database. Existing commercial end-to-end tests passed. Site-page checks initially found root-absolute recipe links; changed them to relative links. The documented page inventory must be refreshed by the integrator for the added article.
- Site build passes; local site check reports only literal brand strings in the preserved transcript. Integrator supplied an exact-path exemption in its shared checker (`cd1bd11`), retaining other claim scans. Final integrated site/full verification belongs to the integrator.

## Outcome and follow-up

Implemented and focused validation complete. Artifacts and command receipts are in the local traction execution handoff. No database or generated project is committed. Independent integrator review, final CI and publication remain with the release owner. The tutorial deliberately uses source checkout, not an unpublished npm payload.
