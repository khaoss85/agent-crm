# Corrections

Every public claim this project made and then had to withdraw or narrow, with the commit that
did it. Newest first.

A project that stakes its positioning on traceable claims needs somewhere to put the claims that
turned out not to be traceable. Created **before** the first public correction rather than after,
because a corrections page that appears the day after a mistake reads as damage control, and one
that predates it reads as the mechanism working.

**The rule:** a claim disproven in public is removed or narrowed within 24 hours, and the entry
lands here in the same commit. `docs/strategy/GO_TO_MARKET.md` §7 tracks correction latency as a
metric for exactly this reason. An entry is never edited to look better later.

---

### 2026-08-07 — "The framework is a dependency, like any library"

**Where:** the comparison table on the landing page (`site/templates/index.html`), asserting that
you could remove the framework the way you remove any npm dependency.

**Why it was wrong:** there is no create-project CLI and no published package. The only working
installer, `examples/starters/b2b-lead-qualification/install.mjs`, copies `packages/`, `apps/`
and `examples/` into the new project. That is real ownership of the resulting code, and it is not
a versioned dependency you can bump or drop — upgrading means merging.

**How it was found:** an adversarial review of the go-to-market plan, before anything was
published. The claim had been written as free prose in a comparison table rather than as a ledger
entry, which is why the claims gate did not catch it — a hole that has since been closed by
enforcing the `readme` and `launch` surfaces too.

**What changed:** the row now says *"you copy the source into your project; there is no
create-command and no published package yet"*; `L-08` entered the ledger; the FAQ answers
*"owned how, exactly?"* before a reader has to work it out; the README carries the same statement.
Commit `b761822`.

**Status:** the limitation stands. It is removed when an ejected application in its own package
verifies green, or when the create-project CLI ships — not before.

---

### 2026-08-07 — The discount refusal cited the renewal test

**Where:** the proposed headline *"Your agent can write the CRM. It can't approve the discount"*,
cited to `tests/workflow.test.js`.

**Why it was wrong:** that test asserts the **renewal** boundary. The discount refusal is real —
`tests/commercial-e2e.test.js` asserts that `quote.approve` with an agent actor is rejected with
`403 HUMAN_APPROVAL_REQUIRED` — but it lives inside a composite end-to-end test, so the citation
was pointing at the wrong file for the right claim.

**How it was found:** the same adversarial review, which checked the cited test rather than
trusting the citation.

**What changed:** `C-21` entered the ledger with the correct file and the exact assertion, and its
own limitation records that the proof is a line rather than a named test. Extracting a named test
is a tracked move in `docs/strategy/GO_TO_MARKET.md`.

**Status:** claim stands, citation corrected. It is a stronger claim once the named test exists.

---

## Entries this file will not contain

Typos, wording improvements, and changes that made a claim *more* precise without it having been
wrong. This is a log of things we said that were not true — diluting it with copy-editing would
make it useless as a signal, which is the only thing it is for.
