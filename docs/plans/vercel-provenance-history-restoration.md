# Vercel provenance history restoration

## Goal and user-visible outcome
Make a Vercel preview pass the existing public-claims provenance gate only when
the checkout can prove that the ledger's measured commit is an ancestor of the
build commit. A successful `git fetch` alone is never reported as restoration.

## Current repository context
`vercel.json` runs `scripts/vercel-unshallow.js` before `site:check`. The helper
currently exits zero after the first successful fetch without re-reading git
state. `site/claims.json` is the sole measurement ledger and `site:check` remains
the authoritative fail-closed consumer.

## Approaches considered
1. Relax `site:check` in Vercel: rejected because it turns an unprovable public
   claim into a deployment success.
2. Trust `git fetch`'s exit status: rejected because the observed preview did
   exactly that while remaining shallow and unable to resolve the measured SHA.
3. Read the ledger and inspect shallow state while verifying object existence and ancestry after
   every bounded fetch strategy: chosen because it encodes the actual invariant,
   retains portability, and provides deterministic diagnostics.

## Milestones
1. Make the helper read the current ledger and expose a testable orchestration
   function without adding an agent-facing command.
2. Verify the three provenance probes before initial or fetched success,
   and continue to fallbacks after a zero-exit fetch with an unmet post-condition.
3. Add real temporary-repository coverage plus deterministic failure-strategy
   coverage, then run repository and deployment gates.

## Validation
`node --test tests/vercel-unshallow.test.js`; `npm run site:check`;
`npm run gtm:check`; `npm run verify`; `npm run smoke`; exact-head GitHub and
Vercel checks.

## Progress log
- 2026-08-22: confirmed the deployed helper trusted fetch exit status while the
  following gate still observed a shallow checkout; implementation started from
  merged PR #111 main.
- 2026-08-22: implemented ledger-derived post-condition checks and fallback
  iteration; eight focused regressions pass, including real temporary-repository
  histories. Local site, GTM, syntax and Node 22 smoke gates pass.
- 2026-08-22: exact-head review exposed that a bounded deepen can leave the
  shallow marker while making the measured ancestry provable. The invariant now
  inspects that marker but accepts the same object-and-ancestry proof as
  `site:check`; a seventh regression locks the bounded-history case.
- 2026-08-22: fresh exact-head review reproduced a measurement more than 256
  commits behind the shallow boundary. The ineffective abbreviated-SHA and plain
  fetches were replaced with one maximum-depth recovery; a real 271-commit
  repository regression proves the old bound is crossed.
- 2026-08-22: the first post-merge main run exposed a fixture-only race: creating
  271 commits crossed Git's automatic maintenance threshold, and the detached
  process could still own `.git/objects` when `node:test` cleaned the temporary
  repository. The fixture now disables automatic gc and maintenance so its
  lifecycle is deterministic; production restoration behavior is unchanged.

## Decision log
- A non-git checkout is now a failure: this build helper has no truthful success
  state outside git.
- The GitHub URL is derived only from Vercel's repository identity variables;
  the measured SHA always comes from `site/claims.json`.

## Outcome and follow-up
Exact-head CI, review and Vercel preview evidence passed before merge. The
post-merge fixture race above is tracked as a technical closeout rather than
mistaken for a provenance failure. Account/project-scope questions remain a
separate follow-up if a technically valid build is green but the intended
production alias is not.
