---
name: adversarial-review
description: Adversarially review an Agent CRM milestone PR before it merges - verify live PR state, attack the implementation across the standing review categories, fix defects in-place, re-verify from a clean clone and report by severity. Use for milestone review, pre-merge review or "review PR N" tasks. Do not use for building a feature (see the build-* skills) or for debugging a single failing run (debug-crm-run).
---

Read `AGENTS.md`, `docs/QUALITY_GATES.md`, the PR's ExecPlan under `docs/plans/`, the ADRs it touches, and the JTBD rows it claims. Those four are the contract you are reviewing *against* — the PR body is a claim, not evidence.

## 1. Verify live state before reading code

Never trust the task description's summary of the PR. Establish, from the API and from git:

- head SHA and commit count; base is the **latest** main (`git merge-base` equals the base SHA);
- every check green, zero unresolved review threads, no conflicts;
- the diff is this milestone only — list any file that is not, and justify or flag it;
- nothing tracked that must never be: `.env`, databases, logs, build output, browser profiles, webhook captures, signed artifacts, generated starter output, `node_modules`;
- the specific fixes the description claims are actually present in the diff.

Then run `npm install && npm run verify && npm run smoke` from a **clean clone**, plus the starter from an empty project and the browser smoke where supported. Do this before reviewing, so a pre-existing failure is not attributed to the PR.

## 2. Attack it

Work the categories in `docs/QUALITY_GATES.md` §2. For each, write the concrete attack for *this* milestone, then run it. The rules that make a review real:

- **Confirm before fixing.** A suspicion is a hypothesis; prove it with a runnable probe (a script under the scratchpad, or a failing test) before changing code.
- **Attack the guarantee, not the happy path.** The happy path passes — that is why the PR exists. Ask what a hostile provider, a duplicated webhook, a killed process, a second connection or a renamed record does to the invariant.
- **Prefer the unrecoverable failure.** A defect that permanently destroys or blocks evidence outranks one that merely errors.
- **Read the claims adversarially too.** A doc sentence that overstates a guarantee is a defect of the same kind as a missing check.

Attacks that repeatedly find real defects here:

1. Kill the process between two phases of an external operation and try to recover.
2. Make the provider answer with an already-terminal state, an unexpected state, or another tenant's object behind the same idempotency key.
3. Change a *mutable* record that a supposedly immutable rebuild depends on.
4. Deliver the same event id with different bytes; deliver an event whose processing failed; deliver one out of order and after a terminal state.
5. Inject a failure after every single write in a multi-record commit, then retry.
6. Race two connections and two app instances on one database.
7. Query past the paged list bound and check the correctness path is indexed.
8. Send prototype-shaped keys, markup and oversized strings through every field, payload and route segment.
9. Delete or deactivate the source data an immutable snapshot came from, then read the snapshot.
10. Count audits, events and trace spans exactly — including for a replay, which must add none.

## 3. Fix in-place

- Fix on the same branch, with a regression test per defect, and conventional commits that name the defect rather than the file.
- Correct the tests that asserted the *old, wrong* behavior — and say so in the report; a test that encoded a defect is part of the defect.
- Keep the milestone's scope: fix what the review found, do not start the next milestone.
- Update the ADR (an **addendum** is usually right), the guide, the ExecPlan, the skill and the JTBD rows so the documentation matches the corrected behavior.
- Re-run the full verification from a clean clone afterwards, then update the PR description and leave the PR **open**.

## 4. Report

Report by severity, and be specific enough that a reader can re-run each finding:

1. Live state: PR URL, base, head, commits, checks, threads, hygiene.
2. Findings by severity (critical / high / medium / low), each with the failure it causes and how it was confirmed.
3. Fixes with their commit SHAs, including any test that asserted the old behavior.
4. One short section per applicable review category, saying what was attacked and what held.
5. Verification: clean-clone `verify`/`smoke` numbers, starter, browser smoke, CI.
6. JTBD corrections and the exact evidence for each.
7. Remaining limitations, stated plainly.
8. Whether the PR is safe to merge — and the human decisions still required.

Do not merge. Do not weaken a test to make a finding disappear. If a defect cannot be fixed inside the milestone's scope, say so, keep the PR open and name the follow-up.
