# Intent discovery metadata

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` current while the work proceeds.

This plan follows `.agent/PLANS.md`.

## Purpose / Big Picture

Accordo's checked site source now answers Customer Hub, Smart CRM, and compound
CDP + CRM queries, but the shorter descriptions read by GitHub, Claude Code,
Codex, Gemini CLI, npm, skills directories, and the MCP registry still describe
only a custom CRM. After this change, those existing discovery surfaces use the
same bounded intent vocabulary. A coding agent can retrieve Accordo for the
three adjacent intents without being told that Accordo is a CDP: the metadata
must say that a CDP keeps ingestion, identity resolution, and segmentation while
Accordo owns the deterministic CRM process layer.

The observable proof is `npm run distribution:check`: it exits non-zero if a
discovery surface loses one of the three intent signals or the CDP boundary.

## Progress

- [x] (2026-08-09) Verify main, open PRs, npm, the public site, skills.sh, and
  the current manifest copy.
- [x] (2026-08-09) Confirm the gap: live channels and every manifest use only
  generic CRM copy; the three site routes are prepared but not deployed.
- [x] (2026-08-09) Update repository copy and distribution manifests without expanding the
  product claim.
- [x] (2026-08-09) Extend the existing distribution gate and add regression tests,
  including both defects confirmed during review.
- [x] (2026-08-09) Update strategy/status documentation and remeasure the checked surface.
- [x] (2026-08-09) Run focused checks, `npm run verify`, `npm run gtm:check`, and the required
  adversarial review from a clean clone.
- [x] (2026-08-09) Publish review-ready stacked PR #55 without merging it.

## Surprises & Discoveries

- Observation: `https://accordo.dev/` returns 200, while the Customer Hub,
  Smart CRM, and CDP + CRM routes return 404 until PRs #44, #53, and #54 merge.
  Evidence: live HTTP checks on 2026-08-09.
- Observation: `create-accordo@0.0.1` is a public placeholder whose description
  mentions only CRM; repository source is still private and unpublished.
  Evidence: `npm view create-accordo ... --json` and `site/brand.json`.
- Observation: skills.sh already returns a repository page and installs the
  skills, but generic search does not surface Accordo. This change can improve
  source vocabulary; it cannot promise ranking or recommendation.
- Finding (medium): serializing a complete manifest let an ignored field carry
  all intent phrases while the actual description and keywords had regressed.
  A disposable root-package mutation passed the first gate. Fixed by selecting
  only documented discovery fields and covered with ignored plus prototype-shaped
  fields in `tests/distribution-intent.test.js` (`3ab2c0d`).
- Finding (medium): the first CDP boundary regex accepted “not ingestion” even
  when the same sentence claimed Accordo owned identity resolution and
  segmentation. A runnable contradictory sentence returned zero failures. Fixed
  by requiring the complete canonical ownership boundary (`b0035d7`).
- Finding (medium): skills.sh was the one live channel observed missing generic
  search, but its indexed `solve-business-goal` frontmatter still described only
  generic business objectives. Plugin manifests cannot repair skill-index text.
  Fixed in all three byte-identical copies and added as the ninth checked
  first-contact surface (`1762f1c`).

## Decision Log

- Decision: extend existing manifests and `distribution:check`; do not add a
  new command, namespace, schema, or runtime capability.
  Rationale: the agent failure mode is retrieval mismatch. The existing gate is
  already the machine-readable contract for manifest drift, so another command
  would fail the DX Simplicity Gate.
- Decision: use the compound phrase `CDP + CRM` only with an explicit ownership
  boundary.
  Rationale: Accordo ships no ingestion, identity resolution, segmentation, or
  bridge runtime. Keyword reach without that boundary would turn adjacency into
  a false product claim.
- Decision: stack this change on PR #54 and leave all public mutation to the
  merge/deploy or named human-submission step.
  Rationale: the referenced intent pages and their claim evidence live in that
  stack; metadata must not precede the explanation it points to.
- Decision: validate only fields a real discovery surface reads.
  Rationale: unknown JSON can be syntactically valid while invisible to an
  installer or registry. `scripts/distribution-intent.js` now owns the explicit
  field selection; arbitrary metadata and prototype-shaped properties cannot
  count as public copy.

## Context and Orientation

The user-facing overview is `README.md`. Install-time descriptions live in
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and
`gemini-extension.json`. npm metadata lives in `package.json` and
`packages/create-accordo/package.json`; MCP Registry metadata lives in
`server.json`. `scripts/distribution-check.js` is the existing fail-closed gate.
The truthful intent definitions are in
`docs/strategy/RECOMMENDATION_MAP.md` and the corresponding checked site pages.

This is distribution copy, not a domain package or a product capability. It
does not touch CRM state, services, workflows, packages, or `packages/core`.

## Plan of Work

First, give the README a compact recommendation map that includes the limit in
the same paragraph as each adjacent intent. Correct its stale npm sentence while
there. Next, carry stable search phrases and the same CDP boundary into each
manifest using only fields already accepted by that manifest's schema. Then add
Gemini and npm manifests to the existing distribution inventory and validate
the intent contract across every discovery surface. Add an independent test that
reads the checked JSON and proves the vocabulary and boundary remain present.

Finally update the listing pack, recommendation map, GTM status, TASKS, and this
plan. Validate JSON, run the focused distribution and GTM gates, full verification,
application inspection, project doctor, and the repository's adversarial-review
procedure. Re-run from a clean clone of the exact reviewed commit before marking
the draft PR ready.

## Concrete Steps

From the repository root:

    npm run distribution:check
    node --test tests/distribution-intent.test.js
    npm run gtm:check
    npm run verify
    npm run crm -- app inspect --json
    npm run crm -- project doctor --json

For the negative receipt, in a disposable clean copy remove `cdp-plus-crm` from
one manifest and confirm `npm run distribution:check` exits 1 with the affected
surface named. Restore nothing in the working branch because the mutation occurs
only in that disposable copy.

## Validation and Acceptance

Acceptance requires all of the following:

1. README and every supported distribution surface retrieve for Customer Hub,
   Smart CRM, and CDP + CRM.
2. Every surface that mentions CDP also says Accordo is not the CDP or names the
   ingestion/identity/segmentation boundary.
3. `distribution:check` fails when one required signal is removed and passes on
   checked source.
4. No copy claims a connector, importer, sync runtime, identity resolution,
   segmentation, authentication, tenancy, RBAC, or production readiness.
5. `npm run verify` and `npm run gtm:check` pass, application inspection remains
   valid with its limitations read, project doctor is clean, and the required
   adversarial review has no unresolved finding.

## Idempotence and Recovery

All changes are checked source and can be rerun safely. Site and llms generators
remain deterministic. The negative gate test uses a disposable clone. If a
manifest schema rejects new copy, remove unsupported fields and retain the
intent in an existing description or keyword field; do not invent extensions.
Do not modify or merge the earlier PRs.

## Artifacts and Notes

Branch: `agent/intent-discovery-metadata`, based on PR #54 head
`a669e18c26721fd010b09473f9aa042b63c95665`.

Live receipts at plan start:

    main == origin/main == 77d7719351f659b01986aedc04eec8d45aed8aab
    PRs #44, #51, #52, #53, #54: OPEN, non-draft, CLEAN, checks green
    create-accordo latest: 0.0.1 placeholder
    accordo.dev/: 200
    three new concept routes: 404 pending merge/deploy

Review receipts:

    functional SHA: 1762f1c
    npm run verify: 785 passing, 0 failing
    npm run gtm:check: 112 pages; all four gates green
    claude plugin validate .: passed
    negative missing-signal mutation: exit 1, Gemini extension named
    hidden-field mutation before fix: exit 0; regression now refuses it
    contradictory CDP sentence before fix: zero failures; regression now refuses it
    app inspect: valid, zero problems, 11 limitations read
    project doctor: passed, zero warnings/failures, 149 documents
    clean clone at e4089dd after the skills.sh fix: fresh install, project
      doctor, 785-test verify, smoke, full B2B starter and four Chromium shots
      all green

## Interfaces and Dependencies

No production dependency and no new public command are introduced. The only
behavioral interface is the existing exit status of
`scripts/distribution-check.js`: zero means every checked manifest is valid and
intent-aligned; non-zero names every missing signal. Tests use only Node.js
built-ins, consistent with repository conventions.

## Outcomes & Retrospective

The existing distribution gate now binds nine first-contact surfaces to four
truthful retrieval intents using only the fields those surfaces actually read.
The implementation added no product capability and no extra step for an agent.
Three review findings were reproduced and fixed rather than documented away: hidden
metadata cannot satisfy public copy, a partial CDP disclaimer cannot coexist with
an identity or segmentation claim, and the live skills.sh index now carries the
same bounded intents. The remaining work is release sequencing,
not source work: human regular merges #44 → #53 → #54 → #55, deploy, then apply
the prepared GitHub metadata and publish the real npm package through its own
release gate. Generic indexing and unaided recommendation remain measured outcomes,
not promises.
