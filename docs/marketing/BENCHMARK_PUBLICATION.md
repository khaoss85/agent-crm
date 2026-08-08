# Publishing a benchmark result

What may be said in public about an Edition L run, and what may not. This is a
gate, not guidance: a sentence that is not permitted here does not go on a site, a
README, a post, a deck or a reply.

The rules exist because benchmark numbers are the easiest thing in this repository
to state truthfully and mislead with. Every refusal below is a sentence that would
be *technically defensible* and would still leave the reader with a false belief.

## The five-part minimum

No figure is published alone. Every published Edition L result carries all five,
in the same place the number appears — not in a footnote, not one click away:

1. **The edition.** "Edition L (G1–G4)". A number with no edition reads as the
   whole benchmark.
2. **The Edition D status.** G5 and G6 blocked on the Production Spine: no
   authentication, tenancy or RBAC exists, so a deployed instance cannot honestly
   be scored. Not run, not estimated.
3. **The G1 attestation.** G1 is operator-attested, read from the run's
   intervention record rather than measured. Twenty-five of the seventy-five
   points rest on an operator's honesty, and the reader is told which twenty-five.
4. **The provenance.** Framework SHA, agent product, model version, date. Model
   versions change results; an unstamped result is a rumour.
5. **The denominator.** How many prompts were attempted, how many runs each, and
   how many runs were unscoreable.

## Permitted

- "**52 of 75 points**, Edition L (G1–G4), at `<sha>`, `<agent>` / `<model>`."
- "**4 of 6 prompts passed all four local gates**" — a count over a stated
  denominator.
- "**G3 failed on 3 of 6 prompts**: the suite was green and never asserted at the
  stated boundary." Naming which gate failed and why is the most useful thing a
  result can say.
- "**2 runs were unscoreable**" — with the gate that returned `needs-operator`.
- "**G5 and G6 are blocked**, so no deployed behaviour has been measured."
- "This is a pilot. The instrument has been run on `<n>` prompts and nothing more."

## Refused

| Sentence | Why it is refused |
|---|---|
| "87% on the CRM build benchmark" | Edition L reports points, never a percentage. A percentage reads as a success rate, which this is not. See ADR-022. |
| "SABR of 0.67" | SABR counts *fully successful* prompts against six gates. With two unrunnable, an Edition-L SABR is a different metric wearing the same name. |
| "Time to first working CRM: 12 minutes" | TTFW is measured brief → deployed smoke green. There is no deploy. Wall-clock to a green local suite is a different quantity and needs a different name. |
| "Passed the CRM build benchmark" | The benchmark is six gates. Four of them passing is Edition L, and the sentence must say so. |
| "65 of 75 — nearly a pass" | The per-prompt verdict is binary and separate from the point total. 65/75 missing G3 is a **failed prompt**. |
| "Scores better than \<competitor\>" | The comparison arms have not been run. G1–G4 also need reinterpreting over a configured product, and that reinterpretation does not exist yet. |
| "Built with zero human intervention" | True only of a specific run, and G1 is attested rather than measured. Say "the operator recorded no interventions" and name the run. |
| Any figure that silently drops unscoreable runs | A denominator chosen after seeing the results is not a denominator. |
| Any figure with no framework SHA | Unreproducible, and therefore not a result. |

## Before an Edition L number goes anywhere public

1. The run was prepared by `benchmarks/harness/prepare.js` — not assembled by
   hand. Provenance is enforced at preparation; a hand-built `run.json` has none.
2. `treeDirty` is `false` on every run in the figure, or the figure says which
   runs were unreproducible.
3. `scoreable` is `true` on every run in the figure, or the unscoreable runs are
   reported with their `needs-operator` gate.
4. The transcripts are published alongside. A benchmark whose transcripts are not
   public is a claim, not a measurement.
5. The claim is entered in `site/claims.json` with its evidence and its paired
   limitation, like every other public sentence, and `npm run gtm:check` passes.

## Why there is no automated gate on this file yet

`scripts/site-check.js` refuses published percentages by pattern, which catches
the first row of the table above and nothing else. The remaining refusals are
about *meaning* — "SABR" is a legitimate word that becomes false in a particular
context — and a regex that tried would either miss them or block honest sentences.

So this is a human gate, and the honest thing is to say so rather than to imply a
check exists. It becomes mechanical when there are results to check: a published
figure will have to name its run ids, and those ids resolve to records that carry
`edition`, `treeDirty` and `scoreable` — at which point the five-part minimum can
be verified rather than trusted. Until then, one reviewer reads this file against
the sentence before it ships.
