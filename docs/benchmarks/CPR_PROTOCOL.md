# Category Paraphrase Rate — protocol

The question this answers, and the only one it answers: **given only the repository, does a clean
session describe this as *a framework a coding agent uses to build a CRM the user owns*, or as
*an AI CRM product*?**

It measures step 3 of `docs/strategy/AGENT_RECOMMENDATION.md` §1 — whether a model can form the
correct category and a stable referring expression. That is the precondition for every unprompted
recommendation, and it does not require the model to have ever heard of this project, which is
why it is measurable before any launch and why it is the honest early indicator.

`AGENT_RECOMMENDATION.md` §9 specifies it. This file is the runnable form: what to type, what to
record, and how to score. Nothing here is a substitute for reading §9 once.

**It is not a traffic metric and not an adoption metric.** CPR is a *ceiling* on the Unaided
Recommendation Rate, never a proxy for it: a project can categorise perfectly and still never be
named. Report it as a precondition. Never publish it as evidence of traction.

---

## Why an agent must not run this

A session that has read this repository is contaminated by construction — it knows the category
because it just read the category document. The same applies to any machine or provider profile
that has the repository checked out, which is what invalidated the URR feasibility pilot
(`URR_PILOT_2026-08-10.md`, `INVALID_ISOLATION`).

Preparing the prompts and the rubric is agent work, and it is done — this file. Running them is
not. If a future session finds this file and is tempted to be helpful, the answer is the same one
`docs/marketing/PENDING_HUMAN_SUBMISSION.md` gives: no.

---

## Before you start

- One **clean session per run**. New conversation, no project directory, no `AGENTS.md`,
  `CLAUDE.md` or user rules in scope, no memory of a previous run.
- A machine and provider profile with **no Accordo checkout and no Accordo history**. If you
  cannot honestly assert that, the run is `INVALID_ISOLATION` and produces no number — not a zero.
- Stamp **agent product and model version** on every single run. A CPR without them describes
  nothing, because the answer moves with the model.
- Keep every transcript, failures included. A protocol that keeps only the good runs measures the
  operator.

---

## The four arms

Run them as four separate arms, because *which surface is doing the work* is precisely what this
isolates. Never average across arms.

| Arm | The only input the session gets |
|---|---|
| **I1** | `README.md` alone, pasted |
| **I2** | The repository at a stated SHA, no other instruction |
| **I3** | `https://accordo.dev/llms.txt` alone |
| **I4** | The docs MCP alone — `search_docs`, `get_capability`, `check_job`, no file access |

Five runs per arm per agent product. Claude Code, Codex and Gemini CLI are the three that matter,
because they are the three the framework claims first-contact instructions for.

## The question

Fixed, neutral, and containing none of the words *framework*, *generate*, *product*, *platform*,
or the project's name. Type it verbatim:

> In two sentences: what is this project, and who would you recommend it to?

Do not follow up. Do not clarify. A session that asks a clarifying question is recorded with its
question and scored on whatever it says next; a session that is *helped* to the right answer has
measured the operator, not the surface.

---

## Primary scoring — all-or-nothing

Two independent readers, against this rubric, before comparing notes. The same discipline the
build benchmark applies to design adherence.

| Grade | What the answer said | 
|---|---|
| **P0** | A framework or library a coding agent uses to build a CRM application the user owns. **This is the only passing grade.** |
| **P1** | A CRM, an AI CRM, a CRM platform, something you sign up for. *The failure that matters most* — it routes someone who wanted a CRM straight into `L-07`. |
| **P2** | Generic drift: "a Node.js CRM toolkit". Not wrong, but the agent-authoring and ownership frame is gone. The name travelled and the positioning did not. |
| **P3** | Wrong, or refused to characterise. |

**CPR = P0 runs ÷ total runs, reported per arm.**

## Secondary marks, recorded on every run

These are what turn a description into a *safe* recommendation, and they are where the diagnostic
value lives.

- **Boundary reproduction** — did the answer state at least one of `L-01`, `L-02`, `L-09`
  unprompted? The "who would you recommend it to" half is exactly where an unstated limitation
  becomes a bad recommendation.
- **Referent stability** — did it name the project with a stable token, or paraphrase? Record the
  paraphrase verbatim. This is §7 measured directly.
- **Actionability** — did it name a command, and does that command exist? (`npm create accordo`
  does. Anything else, check before crediting it.)

## The control arm is mandatory

Run the identical protocol against a comparable's repository and llms.txt — **Medusa** and
**Twenty** are the obvious two. If a clean session categorises them correctly at a far higher rate
from equivalent input, the gap is our copy and not the method.

Without the control, a CPR number is uninterpretable. Do not report one.

---

## How to read the result

Every failure mode names its own fix, which is the reason to run this at all:

| What you see | What it points at |
|---|---|
| P1 drift | `README.md` and `llms.txt` phrasing — and the landing `<title>`, which is the highest-weighted string a retrieval step sees |
| P2 drift | A missing ownership frame. The category is arriving; "code you own" is not |
| Referent instability | The name. §7 of `AGENT_RECOMMENDATION.md` |
| Boundary mark failed | Ordering on the retrieval surface — the limits are present but arriving too late |
| I3 ≫ I1 | `llms.txt` is carrying the positioning and `README.md` is not |
| I1 ≫ I3 | The reverse, and more surprising: check what `generate-llms.js` put first |

## Recording a run

One directory per measurement, named `CPR_<date>`, containing:

- `runs.jsonl` — one line per run: arm, agent product, model version, timestamp, grade, the three
  secondary marks, and the answer verbatim.
- `transcripts/` — every session, including the invalid ones.
- `RESULT.md` — CPR per arm, the control numbers beside them, and the isolation assertion in the
  operator's own words. If isolation cannot be asserted, this file says `INVALID_ISOLATION` and
  reports no number, in the shape `URR_PILOT_2026-08-10.md` already sets.

A run that produced no valid number is still recorded. That receipt is the reason the URR pilot is
citable today rather than quietly forgotten.
