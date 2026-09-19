# Analytics

First increment of the Analytics Studio workstream (M16): declared pipeline
metrics on M8 opportunity data plus the safe report compiler, with fixture
correctness tests.

## Contents

- `src/semantic-model.js` — the pipeline semantic model: business field names
  mapped to physical `opportunities` columns. The only place analytics may
  learn physical schema.
- `src/metric-definitions.js` — the declared metric registry. This increment
  ships one metric: `pipeline_value_by_stage` (sums in integer 1/100 currency
  units, partitioned by currency, grouped by stage).
- `src/compiler.js` — `compileReport` turns `{ metric, dimensions, filters,
  limit }` over declared names into a closed storage descriptor with a row
  bound; `runReport` executes it and applies the declared aggregation in code.
  Unknown names, undeclared filters and over-cap limits throw
  `ValidationError` before storage is touched.
- `src/index.js` — public re-exports.

## What this increment does not do

Dashboards, reports versioning, role-aware rows, metrics beyond the pipeline
— see `docs/strategy/ANALYTICS_STUDIO.md` for the full workstream. Behavior
proof: `tests/analytics-pipeline-metrics.test.js`.
