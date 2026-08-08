# Edition L pilot protocol

How one operator runs one benchmark prompt, end to end, and what they are allowed
to do while it runs. The scoring rules are in `docs/strategy/CRM_BUILD_BENCHMARK.md`
and ADR-022; this file is the runbook.

A pilot is a small, honest run — a handful of prompts, one agent product, one
model — done before any public edition, to find out whether the instrument
measures anything. It is not a marketing exercise, and a pilot that produces bad
numbers has succeeded at its job.

## Before you start

Three things are true or you do not have a run:

1. **The tree is committed.** `prepare` refuses a dirty tree, because the SHA it
   stamps would name a commit whose contents the agent never saw. `--allow-dirty`
   exists, records `treeDirty: true`, and marks the run as unreproducible in every
   report that quotes it.
2. **Run directories live outside the framework checkout.** `prepare` refuses
   otherwise. A run built inside the repository dirties the tree its own SHA
   describes, and the agent ends up composing *on top of* the framework instead of
   *from* it — which `app inspect` would then happily report.
3. **You know which agent and which model.** Both are required flags. A run with
   no agent identity cannot be compared to anything, and a default would pool
   results from different models into one number.

## The five steps

```bash
# 1. Prepare. Writes run.json, brief.md and an empty project/ directory.
npm run bench:prepare -- P02 ~/benchruns/P02-1 --agent claude-code --model <model-id> --attempt 1

# 2. Hand the agent brief.md, verbatim, in a clean session. Nothing else.

# 3. Record what you do, as you do it — not from memory afterwards.
npm run bench:record -- ~/benchruns/P02-1 approval     "granted the permission prompt for npm install"
npm run bench:record -- ~/benchruns/P02-1 intervention "fixed the migration by hand"

# 4. Score.
npm run bench:score -- ~/benchruns/P02-1

# 5. Keep the whole directory. The transcript, run.json and project/ are the result.
```

Exit codes: `score` exits 0 only when every gate reached a verdict. A non-zero
exit means at least one gate is `needs-operator` — the run is not scoreable and
belongs in no aggregate.

## Intervention or approval — the distinction that costs 25 points

The protocol's line, restated because it is easy to blur at the moment it matters:

| You did this | It is | Cost |
|---|---|---|
| Edited any file by hand | **intervention** | G1, all 25 points |
| Ran a fix command the agent did not ask for | **intervention** | G1 |
| Restarted a wedged session | **intervention** | G1 |
| Corrected a wrong schema after the fact | **intervention** | G1 |
| Answered a clarifying question | approval | none |
| Granted a permission prompt | approval | none |
| Pasted a credential into a secret store | approval | none |
| Said "yes, deploy" | approval | none |

G1 is all-or-nothing, so the **first** intervention costs all of it. `record.js`
says so when you record it, which is the only useful moment to learn it.

Two rules that make the record worth reading:

- **Record it when it happens.** Reconstructing interventions from a transcript at
  the end is where runs quietly become passes.
- **The record is append-only.** There is no flag that removes an entry, because
  the only reason to want one is to improve a score after the fact. If you
  mis-classified something, add a second entry saying so.

## What an operator may not do

- **Do not rewrite the brief.** Paste `brief.md` verbatim. A retyped, trimmed or
  "clarified" prompt measures the operator.
- **Do not show the agent the expected-output note.** It sits below the fold in
  `brief.md` on purpose. Showing it measures how well the agent follows a hint,
  not how well it reads a business problem.
- **Do not hint, steer or retry a failing run under the same run id.** A retry is
  `--attempt 2`, with its own directory and its own record. The protocol runs each
  prompt three times and reports the matrix, not the best of three.
- **Do not delete a bad run.** Every attempt is logged, failures included. A
  benchmark whose failures were tidied away measures tidiness.

## What the score will and will not tell you

- **G1** is operator-attested — read from your record, not measured. Every report
  says so; so must you.
- **G2** reports what was composed and then stops. Whether the composition matches
  the brief is a judgement the scorer explicitly does not make, and it returns
  `needs-operator` for it. That is not a gap to be patched with a heuristic.
- **G3** is the gate that bites: a green suite that never asserts at the stated
  boundary fails, because a rule with no test at its edge is a rule nobody checked.
  A prompt that states no numeric boundary returns `needs-operator`.
- **G4** is the only fully objective gate: the project's own suite, exit 0 or not.
- **G5 and G6** are not run. Not estimated, not omitted — reported as blocked.

A pilot's most useful output is usually the `needs-operator` count. It tells you
how much of the benchmark is currently a human reading a transcript, which is the
honest size of the instrument.

## Recording the pilot

Keep, per run: `run.json`, `brief.md`, `project/`, the full agent transcript, and
the scorer's JSON output. Publish nothing from them until
`docs/marketing/BENCHMARK_PUBLICATION.md` says which sentences the result
licenses — the numbers are not self-explaining, and the two most tempting
sentences about them are both false.
