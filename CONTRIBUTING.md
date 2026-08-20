# Contributing

Thank you for looking. This project has an unusual amount of written-down process for its size,
and it is worth two minutes to understand why: most of the code here is written by coding agents,
and a rule an agent cannot read is a rule that does not exist. `AGENTS.md` is the contract, and
this file is the human-facing summary of it.

## The most useful contribution

**Tell us a public claim is not true.** This project's positioning rests on every claim tracing to
a merged test, and `.github/ISSUE_TEMPLATE/claim-not-supported.md` exists specifically so you can
file that. Quote the claim, say what the code actually does, and we will either remove the claim
or add the test — and record it in `docs/marketing/CORRECTIONS.md` either way.

After that, in rough order of value: a failing test for a bug, a provider adapter, a recipe, a
domain package.

## Before you write code

```bash
npm run verify   # syntax check + the full test suite; no install step, no dependencies
npm run smoke    # the approval slice, end to end
```

Node 22.16 or newer. There are no third-party runtime dependencies, and adding one is a decision
that needs recording in `DECISIONS.md` with a reason it removes more complexity than it adds.

Read `PRODUCT.md` for what this is, `ARCHITECTURE.md` for how it fits together, and the relevant
skill under `.claude/skills/` for the kind of change you are making. For anything spanning more
than one file, write an ExecPlan under `docs/plans/` first — comparing at least three approaches
and saying why the chosen one wins.

## The rules that do not bend

These are not style preferences. A change that breaks one of them will be asked to change.

1. **All CRM mutations go through a module service or a named workflow.** No API, MCP, CLI or
   Admin code touches a table directly.
2. **Every write keeps validation, actor identity, audit and trace.** Assert audit and event
   *counts*, not their presence — a replay that produces a second event is the bug.
3. **Commercial policy stays deterministic.** AI may recommend; it may not silently decide, and
   it may never make the decision a policy defers to a human.
4. **Code-generating and destructive operations are dry-run by default.** Writes need an explicit
   `--apply`.
5. **Money is integer cents with an ISO 4217 code.** Never a float. Currencies are never summed.
6. **Domain behaviour does not go into `packages/core`** unless it is first proven to be a
   reusable runtime capability, with the justification stated (ADR-018).
7. **A capability and its limitation are stated in the same breath**, in code comments, docs,
   the JTBD matrix, the PR body and anything public.

## What a reviewable change looks like

`docs/QUALITY_GATES.md` is the full list; the short version:

- Tests cover the happy path **and** the policy boundary — the interesting test is the one that
  proves the refusal, not the one that proves the success.
- Documentation, the ADR and the relevant agent skill move in the same PR as the code, not a
  follow-up.
- `docs/benchmarks/CRM_JTBD_MATRIX.md` is updated **conservatively**: a row moves only for what
  the merged tests prove, and *not supported* is the default.
- If any public claim, README line or site copy changed, `npm run gtm:check` passes.
- No secrets, databases, build output or `node_modules` in the diff.

The pull request template carries this as a checklist, including an evidence table — "which test
proves this" is the question review always asks, so the template asks it first.

## Reviews are adversarial, and it is not personal

Every milestone is attacked before it merges across the sixteen categories in
`docs/QUALITY_GATES.md` §2 — transaction fault injection after every significant write,
two-connection concurrency, idempotency that fails closed on a semantic mismatch, replay,
immutability proven by mutating the source, hostile input across every payload and route. Expect
your change to be probed that way. It is the same treatment the maintainers' own work gets, and
it is why the claims on the front page can be as specific as they are.

## Security

Do not open a public issue for a vulnerability. `SECURITY.md` has the process, and reads the
project's security posture honestly first — no authentication ships, so
"the API is unauthenticated" is documented rather than a finding.

## Licence and provenance

The repository is MIT today; a final confirmation before public launch is an open decision
(`docs/strategy/MASTER_PLAN.md` §10). There is no CLA or DCO requirement yet — which means that
decision has not been made rather than that it has been made permissively. If you are
contributing on behalf of an employer, say so in the PR, and expect a policy to appear before
the repository takes many more contributions.

## A note for coding agents

Read `AGENTS.md` first; it overrides anything here. Use `npm run crm -- app inspect --json` to
learn what an application actually contains rather than assembling it from source and prose. Do
not submit anything anywhere, create accounts, or register namespaces — see
`docs/marketing/PENDING_HUMAN_SUBMISSION.md`.
