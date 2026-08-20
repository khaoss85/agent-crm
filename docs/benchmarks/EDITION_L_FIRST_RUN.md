# Edition L — how to run the first cell

The build benchmark has never been run. This is the procedure for the first
cell, written so that the result is worth keeping if it goes well and worth
keeping if it goes badly.

It takes about twenty minutes of attention, most of it waiting.

## Who can run it, and why it is not an agent

Edition L has **no automated driver**. `ARM_ADAPTERS` exists in the
tool-selection harness, not this one: `prepare.js` writes a brief, a person
pastes it into their agent, and the person records what happened. That is not a
missing feature. Two of the four gates are attestations — G1 asks whether a
human edited a file, G2 asks whether the composed model answers the brief — and
an attestation is worth what the witness is worth.

So the run cannot be driven from a session inside this repository. Such a
session has `CLAUDE.md`, `AGENTS.md` and twelve skills already loaded, and it
would be measuring itself with an instrument it can edit, in the repository
under measurement. The number would be worthless, and publishing it would be
worse than having none.

**The operator is a person. The agent under test is that person's own agent,
started clean.**

## What one cell is, and is not

One cell is: one prompt, one attempt, one agent product, one model. It produces
a score out of 75, a binary prompt verdict, and receipts.

It is **not** a Successful Agent Build Rate. SABR is fully successful prompts
divided by prompts attempted, per framework version × agent product × model
version, with each prompt run three times and counted successful at ≥2/3. One
cell is one thirty-something of the smallest honest denominator, and quoting a
percentage from it would be the exact failure this whole instrument exists to
prevent (L-03).

What one cell is genuinely good for: finding out whether the harness survives
contact with a real run, and producing the first receipt anyone outside this
project can check.

## Procedure

### 1. Prepare the run (from this repository, clean tree)

```bash
node benchmarks/harness/prepare.js P02 ~/bench/P02-a1 \
  --agent claude-code --model "<the exact model string your agent reports>"
```

`P02` is the right first prompt: a basic sales CRM plus one rule — deals above
€25,000 need the founder's approval. It is standard difficulty and it exercises
the boundary the framework's whole positioning rests on.

A dirty tree is refused, because a framework SHA over a modified tree names a
commit whose contents were not what the agent saw.

### 2. Scaffold the project the way a stranger would

```bash
cd ~/bench/P02-a1/project
npm create accordo@0.1.0 -- . --apply
```

From the **published package**, not from a checkout of this repository. That is
what a real user gets, and it keeps the local tree out of the measurement.

### 3. Run the agent, clean

Open a **new** agent session with `~/bench/P02-a1/project` as its working
directory. Not a session that has this repository open, and not one continued
from other work.

Paste `~/bench/P02-a1/brief.md`'s brief paragraph **verbatim and nothing else**.
The expected-output note in that file is a reviewer's aid; showing it to the
agent measures how well it follows a hint rather than how well it reads a
business problem.

Then leave it alone. Answering its questions is fine and costs nothing. Doing
its work is an intervention and costs all 25 points of G1 — the gate is
all-or-nothing, so the first one costs the lot.

### 4. Record what happened, as it happens

```bash
node benchmarks/harness/record.js ~/bench/P02-a1 approval     "granted file-write permission"
node benchmarks/harness/record.js ~/bench/P02-a1 intervention "fixed the migration by hand"
```

Record at the moment, not from memory afterwards. The record is append-only:
there is no flag that removes an entry, because the only reason to want one is
to improve a score after the fact.

### 5. Score it

```bash
node benchmarks/harness/score.js ~/bench/P02-a1
```

G1 and G3 and G4 decide themselves. G2 will come back `needs-operator`, because
whether the composed domain model answers the brief is a judgement the scorer
refuses to make.

### 6. Judge G2, and say why

Read what it built. Then:

```bash
node benchmarks/harness/record.js ~/bench/P02-a1 verdict pass \
  "Company, Contact and Deal exist with the stages the brief names, and the approval object is the founder's, not a status flag."
```

Or `fail`, with the same specificity. The verdict records the composition it
judged, so if the project changes afterwards it goes stale rather than
travelling to a different application.

A verdict cannot rescue a mechanical failure: if the project composed nothing,
G2 already failed and no reason will move it.

### 7. Commit the receipts — all of them

`run.json`, the score output, and the transcript, into
`benchmarks/build/<runId>/`. Including the parts that went badly. The
tool-selection panel published its 52 unrun cells and the run that hit its turn
cap, and that is the only reason its receipts are worth reading.

## What to publish afterwards

Method, receipts, and what broke. No figure, no rate, no comparison — the same
discipline the tool-selection panel used when it reported `comparative: false`
and said so about itself.

If the first cell shows the harness itself is wrong, that is a good outcome and
it is publishable as it stands. It is also the more likely one: this is the
first time the thing has been pointed at a real agent.

## What would make a rate possible

Not this. A rate needs the prompt set rather than one prompt, three attempts
each, and more than one agent product — and today two of the three are blocked
outside this project: Codex returns 401 and Gemini has no auth method
available. The protocol's own bar is stricter still: results publish only when
every planned session has valid isolation and identity receipts.

Worth naming so nobody plans around a number that is several orders of
magnitude of work away.
