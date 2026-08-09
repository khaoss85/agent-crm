# GTM Release Integration (ExecPlan)

## 1. Goal and user-visible outcome

Produce one reviewable release-integration branch that combines the checked
agent-intent stack, the hosted read-only Docs MCP candidate and the verified
`create-accordo` npm candidate without losing claims, limitations or current
distribution status in merge conflicts.

The result is source readiness only. It does not merge the underlying pull
requests, promote a Vercel deployment, publish an npm package, submit a directory
listing or claim that any of those public actions happened.

## 2. Current repository context

- `origin/main` is `77d7719351f659b01986aedc04eec8d45aed8aab`.
- The intent stack is PRs #44, #53, #54, #55, #56 and #57. This branch starts at
  the reviewed head of #57 (`a769fe5`), which already contains the full stack.
- PR #52 (`origin/agent/hosted-docs-mcp`) adds the stateless read-only Docs MCP,
  its Vercel Function, runtime corpus and privacy page. Its reviewed preview is
  protected and `READY`; `accordo.dev/api/mcp` and `/privacy.html` still return
  404, so production promotion remains a human action.
- PR #51 (`origin/agent/npm-create-package`) adds the staged, isolated and tested
  `create-accordo` publish candidate. It does not publish the package.
- All three lines began from the same old `main` and edit `README.md`, generated
  retrieval assets, claims and GTM truth. Merge simulations prove that every
  plausible direct order has content conflicts. Resolving them during the final
  human merge would bypass the normal evidence gates.

## 3. Milestones

1. Record this plan and a clean integration baseline on top of #57.
2. Merge #52 with a merge commit. Resolve conflicts by preserving the complete
   intent vocabulary and adding the reviewed Docs MCP status and limitations.
   Regenerate derived site assets instead of hand-combining generated output.
3. Merge #51 with a merge commit. Preserve the combined intent and Docs MCP
   truth while applying the newer npm-candidate status and limitations.
4. Re-run focused MCP, packaging, public-claims and site gates, then full
   verification, smoke, source-only application inspection and project doctor.
5. Open a draft PR based on #57, run the required adversarial review, fix every
   finding with evidence, re-verify from a clean clone and record the outcome.

## 4. Validation

```bash
node --test tests/docs-mcp-http.test.js tests/docs-mcp.test.js
node --test tests/create-accordo-package.test.js tests/project-bootstrap.test.js
npm run gtm:check
npm run verify
npm run smoke
npm run crm -- app inspect --json
npm run crm -- project doctor --json
```

Expected behavior:

- all existing agent-intent checks remain green;
- the Docs MCP still exposes exactly its three read-only tools and retains every
  privacy/runtime boundary;
- the publish candidate still builds and bootstraps in isolation while public
  npm status remains unpublished;
- generated retrieval files match their source ledgers;
- `app inspect` is valid with zero problems, and all reported limitations are
  read before making any release claim;
- no public endpoint, package or directory status is promoted by the integration.

## 5. Progress log

- 2026-08-10: fetched `origin`; `main` remains `77d7719` and the user's only
  local change remains `.codex/config.toml`.
- 2026-08-10: inspected PR #52 and its Vercel preview
  `dpl_GEiEzhgijkKkFsaWFwcgemUC4tF9`: preview `READY`, Function 549.01 KB.
  Anonymous production checks returned 404 for both `/api/mcp` and
  `/privacy.html`, confirming that source readiness has not been confused with
  public promotion.
- 2026-08-10: simulated intent-first, platform-first and Docs-MCP-first merge
  orders in disposable worktrees. Every order conflicted across public truth and
  generated retrieval surfaces; intent → #52 → #51 is selected because #52 has
  the smaller first conflict set and #51 then supplies the newest npm status.
- 2026-08-10: merged the reviewed #52 ancestry at `2d90326`, then #51 at
  `3c388bd`. Their independent `ADR-025` assignments collided; the integrated
  sequence keeps Docs MCP as ADR-025 and renumbers npm packaging to ADR-026.
- 2026-08-10: focused Docs MCP tests passed 32/32, packaging/bootstrap passed
  36/36, and `gtm:check`, smoke, source inspection and project doctor passed.
  The first full integration run caught the stale 112-page design inventory
  after the privacy page made the built total 113. The corrected functional tree
  at `93c5bd5` passed 804/804 and was recorded in the public ledger.
- 2026-08-10: opened draft PR #58 on the exact reviewed #57 head. Live review
  found zero threads or tracked artifacts and confirmed the merge-base, but
  identified two medium documentation failures: `PROJECT_STATUS.md` still
  described `845cd3d`/555 tests/obsolete PRs, and three release instructions
  still required separate #51/#52 merges even though #58 incorporates them.
  The fixes add an integration regression for ADR uniqueness, release sequencing
  and the volatile snapshot.
- 2026-08-10: fixed both medium findings at functional commit `0b2ce10`. Focused
  Docs MCP tests passed 32/32, packaging/bootstrap passed 36/36, `gtm:check`
  passed and the full suite passed 807/807. The public evidence ledger was then
  regenerated and committed at `14d0ab8` without changing runtime behavior.
- 2026-08-10: verified exact remote head `14d0ab8` from a fresh clone: dependency
  install reported zero vulnerabilities, project doctor passed, full verification
  passed 807/807, smoke passed and the complete B2B starter flow exited zero.
  Site shot generation produced the social, hero, landing and evidence images.
  The privacy page was inspected on desktop and through Chrome device emulation
  at 360 px; the viewport and document widths were both 360 px, with the
  pre-launch boundary visible above the fold and no horizontal overflow.
- 2026-08-10: one duplicate GitHub verification run failed 806/807 when the
  existing local-HTTP stress test `delivery-change-acceptance-evidence.test.js`
  received `ECONNRESET`; the parallel run on the same SHA passed. The failed job
  was rerun as Actions run `31340206812`, attempt 2, and passed 807/807 plus
  smoke rather than masking the transient with a product-code change. Both
  remote `verify` jobs, both `public-claims` jobs and GitGuardian are green on
  the reviewed head.

## 6. Decision log

| Question | Decision | Reason |
|---|---|---|
| Resolve conflicts in the maintainer's final merge? | No | Public claims and generated retrieval files require tested semantic resolution, not an ad-hoc web merge |
| Flatten or cherry-pick #51/#52? | No | Merge commits preserve reviewed ancestry and make the integration provenance inspectable |
| Integration base? | Reviewed #57 head | It contains the complete ordered intent stack and the strict URR measurement contract |
| Merge #51 or #52 first? | #52, then #51 | Hosted discovery truth lands first; the newer npm candidate truth lands last |
| Both source branches use ADR-025? | Keep Docs MCP at ADR-025; npm becomes ADR-026 | A merged decision sequence cannot contain two authorities with one identifier |
| Promote or publish as part of this plan? | No | Those are separate human public/infrastructure commitments |

## 7. Outcome and follow-up

Draft PR #58 now contains both reviewed release candidates with their ancestry
preserved. Its functional commit is `0b2ce10c13bf93b2431ee75fac5ccd2bcfbe296a`;
the reviewed evidence head is `14d0ab8c0e158ffcfaf7a2b09c282accaa6b1ad1`.
The adversarial review found no critical or high defects and fixed two medium
documentation defects: stale repository status and obsolete instructions to
merge #51/#52 separately. The final clean-clone receipt is 807/807 plus green
smoke, doctor, starter and desktop/mobile browser checks.

This outcome is safe to hand to a maintainer only as a draft source-integration
candidate. The human sequence remains: review and regular-merge the dependency
stack through #57, rebase or retarget #58 if GitHub requires it, regular-merge
#58, then separately decide whether to promote the hosted Docs MCP, publish the
npm package and submit directory listings. None of those public actions has
happened here, and production readiness is not assessed by this plan.
