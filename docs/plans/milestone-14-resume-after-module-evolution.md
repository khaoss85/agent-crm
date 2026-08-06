# Resuming Milestone 14 after Module Evolution v1 merges

**Read this before touching M14 again.** M14 was split: its generic half became
Module Evolution v1 (PR #19), and its Delivery half is preserved, unmerged and
untouched. Nothing was lost, and nothing about M14's design changed.

## Where everything is

| | |
|---|---|
| Preserved WIP branch | `claude/m14-wip-add289b-preserved` |
| Preserved SHA | **`add289b6e05cd7db52a29bdaa8e0be86873bb775`** |
| Do not | force-push, rewrite or delete it until M14 is merged |
| Generic half | `claude/platform-module-evolution-v1` → PR #19, **merged as `775713c39689229692dd9c85cd94ed7989390302`** |
| Main at the time of the split | `93381193acda75e57f994d9cf09e537ee77d93cc` |

The preserved branch has two commits on top of the old main:

```text
c2c4634  docs(plan): add the M14 delivery economics and acceptance ExecPlan
         └── docs/plans/milestone-14-delivery-economics-acceptance.md   M14 planning
         └── packages/delivery/src/execution-states.js                  M14 domain
         └── packages/delivery/src/cost-policy.js                       M14 domain
         └── packages/delivery/src/economics.js                         M14 domain

add289b  feat(core): add module manifest evolution …
         └── packages/core/src/module-evolution.js                      GENERIC → PR #19
         └── packages/core/src/module-manifest.js                       GENERIC → PR #19
         └── tests/module-evolution.test.js                             GENERIC → PR #19
```

## What moved into PR #19, and must not be re-added to M14

`packages/core/src/module-evolution.js` · the `revision` field and the bounded
enum values in `packages/core/src/module-manifest.js` ·
`tests/module-evolution.test.js` — plus everything PR #19 added afterwards:
the `module.state.json` contract, `migrations[]` in the factory and registry,
the `create-app` collection change, the `PRAGMA foreign_key_check` in the
migration runner, `tests/module-evolution-factory.test.js`,
`docs/MODULE_EVOLUTION.md`, ADR-019 and the `create-crm-module` skill updates.

**M14 must not duplicate any of it.** If M14 finds itself editing
`module-evolution.js`, the change belongs in a follow-up to PR #19, not in a
Delivery branch.

## M14-only work that remains

**Already written, on the preserved branch** (three files, unwired, no tests yet):

- `execution-states.js` — explicit transition tables, no rank branching, no
  reopen, no clock transition, acceptance separate from completion;
- `cost-policy.js` — versioned, fingerprinted, deterministic, refuses a
  cross-currency rate;
- `economics.js` — safe-integer arithmetic, strict per-currency grouping, never
  converts or sums across currencies.

**Not started:**

1. **Evolve the three M13 manifests to revision 2** — `delivery-project`
   (`pending_kickoff → active → completed`), `delivery-work-package`
   (`planned → active → completed`), `delivery-milestone`
   (`planned → active → completed → accepted | rejected`), each also gaining
   `startedAt` / `completedAt`. This is exactly what PR #19 unblocks; before it,
   the baked-in `CHECK` made these states unreachable on any existing database.
2. **Six evidence modules**: `delivery-economics-plan`, `delivery-time-entry`,
   `delivery-expense`, `delivery-economics-snapshot`, `delivery-change-request`,
   `delivery-acceptance` — all `writable: "managed"`, all append-only.
3. **Actions**: `start-delivery-project`, `start-work-package`,
   `complete-work-package`, `complete-milestone`, `plan-delivery-economics`,
   `record-time-entry`, `record-expense`, `calculate-delivery-economics`,
   `propose-change-request`, `decide-change-request`, `request-acceptance`,
   `record-acceptance-decision`.
4. **Two capabilities**: `delivery-projects@1` and `delivery-economics@1`,
   additive — `delivery-obligations@1` is untouched.
5. **Admin** delivery execution views with their caveats; **starter** extension;
   **tests**: fault injection after every write, two-connection concurrency,
   >500-row exact reads, the security matrix, exact audit/event/trace counts.
6. **Docs**: `docs/DELIVERY_ECONOMICS.md`, the delivery README, the
   `build-delivery-handover` skill mirrors, JTBD rows, `ADMIN_SMOKE.md`, and the
   Domain Package Migration learning notes.

## Exact resume sequence

```bash
# 1. PR #19 is merged (775713c) and fresh main verified green at 299 tests.
git fetch --all --prune
git checkout main && git reset --hard origin/main

# 2. Start the real M14 branch from the merged main.
git checkout -b claude/milestone-14-delivery-economics-acceptance

# 3. Take ONLY the Delivery half of the preserved work.
git checkout claude/m14-wip-add289b-preserved -- \
  docs/plans/milestone-14-delivery-economics-acceptance.md \
  packages/delivery/src/execution-states.js \
  packages/delivery/src/cost-policy.js \
  packages/delivery/src/economics.js

# 4. Confirm nothing generic came with it — this must print nothing.
git diff --cached --name-only | grep -E 'packages/core/|tests/module-evolution'
```

Cherry-picking `c2c4634` wholesale also works, since that commit is Delivery-only
— but the explicit `git checkout -- <paths>` above is safer, because it states
what is being taken.

**Do not** cherry-pick `add289b`: it is the generic commit, superseded by PR #19.

## Risks and likely conflicts

| Risk | Why, and what to do |
|---|---|
| `packages/delivery/src/index.js` | M14 must add its actions, capabilities and metadata to a file PR #19 never touched — no conflict, but the metadata block grows and its `notModeled` list must shrink honestly |
| The three M13 manifests | Editing them is the *point*, but each needs `"revision": 2` and exactly one step. The factory refuses a change without it |
| `module.state.json` for M13 modules | They have none: they predate PR #19. The first `--apply` after the merge writes it at revision 1; the evolution to revision 2 is the second apply. Do not hand-write the state file |
| `notModeled` in the delivery package metadata | It currently lists time tracking, cost, margin, change requests and customer acceptance. M14 implements several of those and **must remove exactly what it implements, and nothing more** |
| The starter | It asserts a full run summary string; extending the journey changes it, and the Chromium smoke count moves with it |
| ADR numbering | PR #19 took **ADR-019**. M14's addendum is ADR-018 addendum 5 or ADR-020, whichever the state of `DECISIONS.md` says at the time |

## Prerequisites before opening the M14 PR

1. PR #19 merged, fresh main green.
2. The three M13 manifests at revision 2, with their generated state files and
   `migrations[]` committed.
3. No file under `packages/core/` in the M14 diff — the kernel learns nothing
   about delivery.
4. `npm run verify`, `npm run smoke`, the starter twice (one path with spaces)
   and the Chromium smoke all green from a clean clone.
5. The M14 PR left **open and unmerged** for the adversarial review.
