# Content production, per channel

`CONTENT_PILLARS.md` says **what** we write and in what order. `ORGANIC_GROWTH.md`
says what a piece must survive before it ships. This file answers the third
question, the one neither of them answers: **for each channel, what is the unit of
work, who can make it, how often, and what has to be true first.**

It is a production plan, not a promise. Every row is either running, unblocked, or
names its blocker.

---

## 1. The one thing to understand before reading the table

There are two kinds of channel here and they behave in opposite ways.

**Compounding channels** get more valuable the earlier they start and cost almost
nothing to be wrong in. Indexing latency, crawl cycles and corpus inclusion mean a
page published today is worth more in six months than the same page published in
six months. Publish into these continuously.

**One-shot channels** — a Show HN, a Product Hunt day, a launch post, a subreddit
introduction — spend a first impression that does not come back. They convert
attention into installs, and today an install ends at `git clone`. Spending them
now converts a scarce asset into nothing.

So the production plan is deliberately lopsided: **write constantly into the
compounding channels, and hold every one-shot channel until `create-accordo`
scaffolds a real project.** That single precondition (`RECOMMENDATION_MAP.md` §1,
precondition #2) gates more of this table than any other fact.

---

## 2. The channel table

Effort is per unit, for an agent drafting with a human editor of record. **Who**
is who must be in the loop, not who does the typing.

| Channel | Unit of work | Cadence | Effort | Who | Status |
|---|---|---|---|---|---|
| **Repository surface** (README, docs, ledger, `llms.txt`) | one change | with every merge | ~0 | agent | **Running.** Already gated by `npm run gtm:check` |
| **`llms.txt` / `llms-full.txt` / `answers.json` / `jobs.json`** | regenerate | with every merge | ~0 | agent | **Running.** Generated, drift-checked |
| **Long-tail capability and intent pages** (CPQ, signature→order, delivery economics, SLA, customer hub, Smart CRM, CDP + CRM) | one page | 2 / month | 2–3 h | agent drafts, human edits | **Running in checked source.** Customer Hub, Smart CRM and CDP + CRM are prepared as evidence-bound concept pages; public discovery follows their PR stack and deploy |
| **Comparison pages** (vs Twenty, vs Odoo, vs a CDP, vs building from scratch) | one page + 90-day refresh | 1 / month until 4 exist | 3–4 h | agent drafts, human verifies every competitor claim | **Running.** Four checked pages exist; named-competitor facts remain on the 90-day verification cadence |
| **Recipes** (transcript-grounded walkthroughs) | one recipe | 2 / month | 3–4 h + a real build | agent builds, human owns the transcript | Blocked on having real transcripts to ground them |
| **Articles** (the four pillars) | one article | 1 / month | 6–8 h | agent drafts, human is editor of record | Month 1 unblocked; months 5–6 gated on the benchmark run |
| **GitHub Discussions** | one answered question | as they arrive | 20–40 min | human answers, agent drafts | **Running.** Enabled; indexed, and answers get retrieved |
| **Agent-surface manifests** (Claude plugin, Codex, Gemini extension, skills.sh) | one manifest change | on change only | ~0 | agent | **Shipped.** Zero-submission; they are inventory, not content |
| **npm package metadata** (description, keywords, README) | one publish | per release | 30 min | human (`npm login`) | Names reserved; the real packages need precondition #2 |
| **Benchmark results + transcripts** | one run, committed whatever it says | monthly once started | 1 day / run | **human operator required** | Harness ready, never run. This is the one number we would own |
| **URR measurement** (does an agent name us unprompted) | one measurement round | monthly | 2 h | human runs clean sessions | Protocol written, never run |
| **Maintainer social** (X, LinkedIn, Bluesky) | one post | 2–3 / week when there is something true to say | 15 min | **human voice, always** | Not started. Agent drafts; the human owns the account |
| **Newsletters / guest posts** | one pitch | opportunistic | 2 h | human | Pitch the data, never the product. After the benchmark |
| **Show HN · Product Hunt · Reddit · awesome lists · Vercel templates** | one launch | **once** | 1 day + prep | human | **Held.** One-shot. All gated on precondition #2 |
| **Paid search** | one campaign | — | budget | human | **Do not start.** No brand volume, nothing to convert to |

---

## 3. What one month actually looks like, unblocked today

Nothing in this month depends on a product change. It is the plan that runs while
the create-CLI is being built, not instead of it.

| Week | Output | Channel |
|---|---|---|
| 1 | 2 capability pages + 1 comparison page | site (compounding) |
| 2 | 1 article (pillar P1) + Discussions answers | site + GitHub |
| 3 | 2 capability pages + comparison refresh | site |
| 4 | 1 URR measurement round, committed | `docs/benchmarks/` |

Steady state: **~6 indexed pages and one measurement per month**, all compounding,
none spending a one-shot. Social posts sit on top of that as a distribution layer
for pieces that already exist — never as content in their own right.

---

## 4. The two production bottlenecks, named

Everything above is drafted by an agent. Two things are not, and pretending
otherwise is how this plan fails:

1. **The human editor of record.** Gate 5 in `ORGANIC_GROWTH.md` — a named person
   reads, edits and owns every published piece. At two recipes plus one article per
   month that is real hours, and it is the actual ceiling on cadence. If the editor
   has four hours a month, the cadence is four hours a month's worth of pieces, and
   the calendar is wrong rather than the editor.
2. **Real transcripts.** Recipes and pillar P2 are transcript-grounded by rule.
   Nothing can be written from a build that did not happen, and the benchmark
   harness is the cheapest way to produce transcripts worth writing from — which
   makes running it a *content* dependency as well as an evidence one.

---

## 5. What must never be produced

Restated here because a production plan is where the pressure to violate them
arrives. The full list is `ORGANIC_GROWTH.md` §12 and the "Never say" block in
`DISTRIBUTION_SUBMISSIONS.md` §4.

- No content about anything not merged — the create-CLI, cloud, marketing runtime,
  Analytics Studio, billing, ERP.
- No benchmark number until a run exists. Not a range, not an estimate, not a
  placeholder in a mockup.
- No recipe from a build that did not happen.
- No comparison claim not traceable to the competitor's own docs, carrying a
  `verifiedOn` date.
- Nothing an agent could follow into a capability that is not there. That is the
  one failure mode this whole strategy cannot recover from: an agent that follows a
  claim into a missing capability does not try us twice.

## Related

`CONTENT_PILLARS.md` (what to write) · `ORGANIC_GROWTH.md` (the gates) ·
`docs/strategy/RECOMMENDATION_MAP.md` (channels and preconditions) ·
`docs/strategy/DISTRIBUTION_SUBMISSIONS.md` (submissions and approved copy) ·
`docs/strategy/GTM_TECHNICAL_EVIDENCE_HANDOFF.md` (**what may be said at all**)
