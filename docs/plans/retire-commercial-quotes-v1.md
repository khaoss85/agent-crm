# Retire the obsolete Commercial quote capability

## Goal and user-visible outcome

Retire `commercial-quotes@1` after all bundled consumers have migrated to
`commercial-quotes@2`. A project still requiring the retired version must fail
composition with the consumer and the offered replacement named. Existing v2
reads and signed-term verification must keep their behavior.

## Context and recovery boundary

Backlog `9cf73d5b6e09` authorized this retirement. The recovered implementation
is commit `1b695e8`: Commercial offers only v2, its package version moves to 4,
and Signature and Contracts already require v2. The original worktree is
preserved. Recovery happens in a sibling worktree from that commit, whose base
is main `ec1d55f`.

The targeted run reproduced a real integration omission: the checked-in
exit-zero verifier fixture still binds the service journey's old composition.
The journey now passes with a different fingerprint because it composes
Commercial as well as Signature, Contracts and Service. The verifier correctly
refuses the stale plan with `PLAN_NOT_CURRENT`.

## Decision log

Three alternatives were considered: retain the unused v1 offer indefinitely;
weaken the verifier's composition binding; or complete the retirement and
rebind its affected fixture from a real scenario run. The third preserves both
contracts. No fingerprint will be invented, and no product plan or coverage
claim will be promoted merely because a fixture passes.

The exported internal v1 read factory remains the implementation base of v2;
retirement changes what the package registry offers, not the byte-level read
behavior. Third-party consumers are not inventoried by this repository: a
remaining v1 requirement is intentionally incompatible and must migrate.

## Milestones and validation

1. Reproduce the fixture failure and run the service scenario unchanged.
2. Update the fixture's composition and plan fingerprints from those authorities;
   add the ADR retirement addendum and retain the original refusal regression.
3. Run targeted Commercial, Signature, integrity and verifier tests; run the full
   `npm run verify`, `npm run smoke` and the starter from a fresh clone.
4. Review the exact branch, open the PR, record remediation before merge, then
   obtain the Factory verifier's receipt against the merged commit.

The main baseline is independently checked in a fresh clone. Repository truth
is regenerated only if its authorities move. Test measurements stay in the
claims ledger; this plan carries no transcribed count.

## Progress

- Recovered the committed change without modifying its original worktree.
- `app inspect` is valid; `project doctor` reports no blocking problems.
- Reproduced `PLAN_NOT_CURRENT` in the real exit-zero fixture.
- The service scenario passes; its recorded composition is the rebinding source.
- Rebound the fixture and its implementation-evidence document from that run;
  its requirement-level proof now passes without weakening freshness checks.
- Adversarial review found stale v1 offers in the current alignment matrix and
  an overly broad description of a lexical tripwire. Updated the matrix,
  narrowed the description, and added a runtime inventory of the quote edges
  in both bundled package graphs. Both graphs compose with migrated consumers.
- Targeted Commercial and Signature characterization, signed-term consumption,
  solution verification and dual-graph tests pass. Full baseline and clean-clone
  branch verification are still pending.

## Outcome and follow-up

Pending final verification and independent release receipt. No registry package,
hosted deployment, external provider or live customer database is changed here.
