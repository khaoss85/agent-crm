# Public production operations — the one measurement

Taken once, on `main` at `fe1c655`, after the integration merged. The campaign
asks for one exact measurement rather than one per slice, so this is the whole
of it, including the parts that could not be taken here and why.

## What was measured

| Authority | Result |
|---|---|
| `npm run smoke` | passed — 2 workflow runs, 7 audit events over a composed app |
| `npm run repo:truth -- --check` | passed — **55 facts, 122 citations, 21 bound surfaces** |
| `npm run gtm:check` | passed, carrying `site:check`, `generate-llms --check`, `distribution:check`, `surface:check` |
| `npm run site:check` | passed — **24 claims and 11 limitations, every one with evidence on disk** |
| `npm run crm -- project verify --json` | exit 0, fingerprint `87354acdbfde9c5ec1ceb906742d9a05f455745fc9d8484e238e5a1ad65aa709`, worktree clean before and after |
| `git diff --check` | clean |
| CI on `main` | green at `fe1c655` |

## What was not measured here, and why

`scripts/measure-suite.js` refuses to record numbers from a suite that failed,
and `npm test` fails on this machine, for a reason that is this machine's rather
than the repository's. It was run and reported
`npm run verify exited 1 with 2 failing`, and a completed full run named both:
**2211 tests, 2144 passing, 2 failing.** Both are macOS artefacts, and CI passes
both at the same commit.
**1. `tests/spine-v2-m0-characterization.test.js` — `M0 records
PostgreSQL-shaped --db input as legacy SQLite path semantics`.** Certain, and
the diff says it outright: expected `/var/folders/…`, got
`/private/var/folders/…`. On macOS `/var` is a symlink to `/private/var`, so
`os.tmpdir()` and a resolved path disagree by a prefix. On Linux they do not.
The characterization baseline records the Linux form.

**2. `tests/agent-tool-selection-prompts.test.js` — `the shell classifier agrees
with bash over the whole cross-product`.** Fails its `guardedWrites > 0`
self-check at every commit tried, including `origin/main` with nothing applied.
The corpus is a pure cross-product of hardcoded constants — no repository read,
no randomness — and the failing criterion depends on running real `bash` and
observing real filesystem writes. The lead, not confirmed: `bash` here is
3.2.57, CI runs Linux bash 5.x, and the oracle's axes include an empty `for`
list, a `trap`, a backgrounded group and a pipeline.

Both are filed in `TASKS.md`. Neither is a defect in the repository, and neither
is caused by this campaign.

So the published claim record is left exactly as it is. That is not a
workaround: `site:check` passes against it, which is the gate that decides
whether the record still describes the repository. Re-recording the numbers is
work for a machine whose suite is green, and it is not blocking anything.

## What the campaign still does not claim

Restated here because measurement is where claims get inflated.

This does not complete Phase 6. The v4 remainder also names remote-safe MCP,
which is open, and shared-database tenancy stays deliberately deferred. Coverage
is unchanged at **five evidence-backed `partially supported` rows out of 600**;
no infrastructure milestone promotes a business JTBD by itself. Managed secret
custody, managed backup custody and an observability backend remain absent — an
export contract is an interface, and an interface is not a backend. Accordo
Cloud C0 has not started. Its blocking human action was taken at the close of
this campaign — `khaoss85/accordo-platform` now exists, private and empty, on
the owner's explicit authorisation — which removes one precondition and none of
the others.

## Two corrections this measurement records about itself

**A claim reached `main` that was false.** The integration PR carried a `TASKS`
entry saying `verify` could not be green on `main` because of the shell
classifier. CI passes that file; the failure is one machine's. The commit that
fixed it locally was written after the branch was pushed and never made it in.
Fixed here.

**A red build next to a suspicious change is not evidence.** CI on `main` went
red at the v4C merge on `destroyed black-hole client does not poison the pool`,
its parent was green, and v4C had touched `postgresql-bootstrap.js` exactly
where a pool is built. Every part of that story pointed one way and it was
wrong: re-running the same commit passed, and the test passes locally against
PostgreSQL 16 on a branch carrying v4C. It was flaky. The plausible explanation
arrived first, cost nothing to believe, and two runs to disprove.
