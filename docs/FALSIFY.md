# Falsify

```bash
node scripts/falsify.js          # the fast set — a couple of seconds
node scripts/falsify.js --all    # including the mutation whose only witness is a slow e2e
node scripts/falsify.js --json
```

A test count tells you how much was written. It does not tell you what would have
to go wrong for a test to stay green, and that is the question a sceptical reader
is actually asking. `falsify` answers it by breaking things on purpose.

Each mutation removes exactly one rule this project makes in public, runs the
suite that is supposed to defend it, and reports **which named test caught it**.
Nothing is left in the working tree: every edit is restored in a `finally` and the
restoration is verified byte-for-byte.

## What it does to your checkout, and why it is safe

- It edits real source files in place, one at a time, and restores them.
- It **refuses to start** if any target file has uncommitted changes. So even a
  killed process leaves damage that `git checkout -- <file>` undoes completely.
- If a restore ever fails it throws immediately, naming the file and the command
  that fixes it, rather than letting the run scroll it away.

A scratch copy of the tree would avoid the edit entirely and cost a full copy per
run. The git precondition buys the same assurance for the price of one
`git status`.

## Three outcomes, two of which are failures

| Outcome | Meaning |
|---|---|
| `caught` | the suite went red, and the report names the test that did it |
| `survived` | the suite stayed green with the rule removed — **a gap in the tests** |
| `stale` | the code the mutation aims at is gone, so it proved nothing |

`stale` is a failure on purpose. A falsification kit that quietly stops aiming at
anything is worse than not having one, because it goes on printing reassurance.
The run exits non-zero on either.

Baselines are measured, not assumed: every target suite runs unmutated first. A
suite that is already red would make every mutation look caught, which is the one
way this tool could lie in the flattering direction.

## The mutations

| id | Rule removed | What that would mean | Defended by |
|---|---|---|---|
| `approval-actor-guard` | a commercial approval decision requires a human actor | an agent records the human decision as if it were the human | `tests/workflow.test.js` |
| `approval-threshold-boundary` | a renewal *exactly at* the threshold requires approval | a deal worth precisely the threshold slips through unapproved | `tests/workflow.test.js` |
| `webhook-signature-verification` | a signature webhook is rejected unless its HMAC verifies | anyone who can reach the endpoint forges a signed-contract event | `tests/signature-contract.test.js` |
| `definition-version-immutability` | a registered policy version cannot be edited in place | a scoring model or discount policy changes behaviour while keeping its version, so every historical decision citing that version now cites something else | `tests/intelligence-contract.test.js` |
| `managed-fields-public-write` | a module whose every field is managed generates no public create or update | generic CRUD writes fields only a trusted action is allowed to set | `tests/module-factory.test.js` |
| `delivery-cost-rounding` (`--all`) | delivery cost rounds half-up in integers, per the published rule | every cost silently rounds down, so a snapshot disagrees with the rule the API publishes beside it | `tests/delivery-economics-e2e.test.js` |

The default run skips `delivery-cost-rounding` because its only witness takes
about a minute, and **it prints what it skipped** rather than quietly narrowing
the set.

## What it already found

`managed-fields-public-write` **survived** the first time it ran. Removing the
read-only rule from the module factory left `tests/module-factory.test.js` green;
only the end-to-end suites — which boot a whole application — noticed. A rule
about generated output should fail in the test that reads the generated output, so
`tests/module-factory.test.js` gained a direct assertion: a fully managed module
generates no public `create` or `update` and publishes only `get`/`list`, and a
module with one public field still publishes `create`.

That is the kit working. The interesting output of a falsification run is not the
row of ticks.

## What it does not do

- **It is not a mutation-testing tool.** It does not generate mutations, sample
  them, or compute a mutation score. Six hand-written mutations aimed at six
  claims is a different instrument from a coverage metric, and a percentage
  derived from it would mean nothing.
- **It does not prove the rules are correct** — only that they are *held by a
  test*. A wrong rule, faithfully defended, passes every mutation here.
- **It covers six rules, not the ledger.** `site/claims.json` carries 22
  claims. The `claims` field on each mutation names which ones it defends; the
  rest rest on their own evidence and are not falsified by this command.
