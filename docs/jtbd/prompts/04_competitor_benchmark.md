# Prompt 04 — Evidence-based competitor benchmark

## Goal

Compare Accordo with selected products without relying on memory or vendor slogans.

## Inputs

- target competitors from `data/competitor_targets.json`;
- domains/capabilities from `data/capabilities.json`;
- assessed Accordo coverage on a target SHA;
- research date.

## Method

1. Use current primary sources where possible: official documentation, release notes, API docs, security docs and product trials.
2. Record exact date and source for every score.
3. Separate:
   - generally available;
   - beta/preview;
   - partner/add-on;
   - roadmap/announcement;
   - inferred but unverified.
4. Score 0–5 on:
   functional depth, time-to-value, autonomy, evidence, governance, extensibility, analytics and TCO.
5. Do not transfer a suite-level claim to every edition or module.
6. Compare equivalent jobs, not names.
7. Mark confidence and contradictions.
8. Complete `data/competitor_benchmark.template.csv`.
9. Produce:
   - parity gaps;
   - differentiators with proof;
   - capabilities better integrated than built;
   - claims that need a hands-on trial.

No score without dated evidence.
