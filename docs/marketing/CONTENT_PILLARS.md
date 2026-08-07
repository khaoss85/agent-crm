# Content pillars and editorial calendar

The organic-growth engine in `docs/strategy/ORGANIC_GROWTH.md` defines the loop and its six
quality gates. This file names what we write about, in what order, against which fixture.

**Cadence: two recipes and one article per month, capped** (`ORGANIC_GROWTH` §11.7). Volume is
not the goal; being the reference is. Every piece passes all six gates and carries a named human
editor of record — the agent drafts, a person publishes.

---

## The four pillars

| Pillar | What it owns | Why it earns attention |
|---|---|---|
| **P1 — The refusal surface** | What agents must *not* be allowed to do in software that touches money, and how to make that structural rather than instructional | Category-defining, and useful far outside CRM. This is the pillar that travels |
| **P2 — Building in public, transcript-grounded** | Recipes and builds with intervention counts and failure counts published | Only credible if the failures stay in. The moment one is quietly dropped, the pillar is worth nothing |
| **P3 — Ownership economics** | Licence shapes, lock-in, the disappearance test, honest comparisons | Captures the "X vs Y" queries that humans and agents both issue mid-research |
| **P4 — Determinism as engineering practice** | Versioned policies, fingerprints, immutability, append-only evidence, migrations an agent can generate safely | Teaches something general; reusable by anyone shipping agent-written code |

P1 is the wedge. If only one pillar gets attention, it is this one — it is the only one where
we have something to say that nobody else in the category is saying, and it is grounded in a
merged test rather than an opinion.

---

## Calendar

Months are ordinal, not calendar-locked: month 1 begins when the repository is public. Every
piece names the fixture it is written from, because a piece with no fixture cannot pass the
runs-or-dies gate.

| # | Article (one per month) | Recipes (two per month) | Pillar | Fixture |
|---|---|---|---|---|
| 1 | **"We wrote a test that fails when our own agent approves a discount"** — the refusal boundary, why a prompt instruction is not a boundary, and what the test actually asserts | "An approval threshold you can change without breaking the test that guards it"; "Lead capture to scored, routed, qualified lead from one manifest" | P1 | `tests/workflow.test.js`, `examples/starters/b2b-lead-qualification/` |
| 2 | **"The sixteen ways we try to break a milestone before it merges"** — the adversarial-review categories, with a real finding from each of three of them | "Won deal to delivery project, atomically, across a package boundary the kernel never learns about"; "Partner tiers with a deterministic revenue-share table" | P4 | `docs/QUALITY_GATES.md` §2, `tests/delivery-handover-e2e.test.js`, `examples/modules/partner.module.json` |
| 3 | **"What our inspector refuses to tell you"** — a tool that emits its own blind spots as machine-readable limitation codes, and why that is an agent affordance rather than a disclaimer | "Costing a delivery project from append-only evidence", including the case where a recurring obligation returns no estimate and says why; "A composite quote with volume and graduated tiers, priced on the server" | P1 + P4 | `tests/app-inspect.test.js`, `tests/delivery-economics-e2e.test.js`, `tests/commercial-e2e.test.js` |
| 4 | **"When to use a CRM platform instead of this"** — opens with where the alternative wins, carries a `verifiedOn` date, refreshed on a 90-day clock | "A customer-authored package that detaches without touching the kernel"; "Signature envelope to exactly one immutable Order, and what a replayed webhook does" | P3 | `docs/strategy/COMPETITOR_MAP.md`, `tests/custom-package-e2e.test.js`, `tests/signature-order-e2e.test.js` |
| 5 | **"We let coding agents build CRMs against a published protocol. Here is what broke."** — launch-gated and human-approved: the Edition L result with its gate set named, the full failure list, transcripts, agent product and model versions, in one post | The two strongest walkthroughs from the run | P2 | `benchmarks/harness/` |
| 6 | **"Measuring whether an LLM recommends your framework: the URR protocol, and our first number"** — with the month-1 public pre-commitment to publish it whatever it says | Two, chosen from whatever recurred most in Discussions | P2 + P3 | `CRM_BUILD_BENCHMARK.md` clean-session protocol |

**Standing work:** three comparison pages refreshed on a 90-day clock the linter enforces. A
comparison with a stale `verifiedOn` is worse than no comparison, because the competitor moved
and we are describing a product that no longer exists.

---

## What is held back, and why

The roadmap-ware rule (`ORGANIC_GROWTH` §12) bars content about things that do not exist. The
tempting violations, named so they stay named:

| Topic | Why it is held | The honest version, if we want it |
|---|---|---|
| Renewals firing, SLA timers, unattended follow-up | There is no scheduler (`L-04`) | *"The renewal policy is finished. Nothing fires it, and here is why we shipped it anyway"* — a good article, labelled an **architecture** post, not a capability post |
| Cloud, Analytics Studio, Marketing MK0–MK7, Data Governance, Integration Runtime | Design-only | A clearly labelled roadmap post, once, not a series |
| The create-project CLI and `npm create <name>` | Does not exist, and its name is the brand | Nothing until both are true |
| Any number from the build benchmark | Not executed (`L-03`) | Nothing. Not a range, not an estimate, not a placeholder in a mockup |
| Integration guides for named vendors | Every provider is an offline fixture | *"Designing a provider contract you can implement against before the vendor exists"* — P4, and true today |

---

## The gates, restated as a checklist

A draft that cannot tick all six does not get published, regardless of how good it reads.

1. **Runs-or-dies** — every code path exists as a CI-tested fixture. No pseudo-code presented as
   working code.
2. **Transcript-grounded** — narrative traces to an actual build transcript. "The agent will
   happily do X" requires a transcript where it did X.
3. **New information** — a measurement, a failure mode or a decision rationale that is not
   already in our docs or someone else's post. A summary of our own documentation is
   documentation work, not content.
4. **Citations** — external facts carry links; competitor claims come from their own docs or
   repositories; no invented numbers.
5. **Human editor of record** — a named person reads, edits and owns it.
6. **Honesty** — failure counts and intervention counts stay in. The credibility of the whole
   strategy dies the first time one is hidden.

Mechanising these is move 1.9 in `docs/strategy/GO_TO_MARKET.md`: front-matter declaring the
claim ids used, the transcript path and the editor, with `scripts/content-check.js` failing on a
missing transcript, a missing editor, an unledgered number, or any overclaim pattern. Until that
script exists, the gates are a human checklist and should be treated as one — which is a reason
to write the script early, not a reason to publish without checking.

---

## Distribution per piece

In descending order of expected signal for this audience:

1. The project blog, first — it is the canonical URL every other channel points at.
2. Show HN, for the pieces that are genuinely new information (months 1, 2, 5).
3. Developer newsletters — pitch the **data**, never the product.
4. Discussions, as the answer to the question that prompted the piece.
5. Maintainer accounts on X, LinkedIn and Bluesky, in the maintainer's voice. Agents draft;
   the human owns the account and the voice.

Add every published piece to `llms.txt` and the docs index in the same change. A piece that
answer engines cannot retrieve is a piece written for one week instead of two years.
