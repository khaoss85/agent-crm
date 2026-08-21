# Coverage status crosswalk

The **desired-state catalog** and the **Accordo repository truth contract** use different vocabularies on purpose. Do not overwrite the source catalog to make it match the current implementation.

## Repository truth vocabulary is authoritative for Phase D

When publishing or editing Accordo's repository-level JTBD coverage, use only the statuses defined in `docs/QUALITY_GATES.md`:

- `not supported`
- `partially supported`
- `technically supported`
- `validated end to end`

The catalog's embedded `coverage.status` (`NOT_ASSESSED`, `ABSENT`, `CONCEPT_ONLY`, `PARTIAL`, `FUNCTIONAL`, `PRODUCTION_READY`, `DEPRECATED`) is a portable assessment template from the design artifact. Every shipped record is initialized to `NOT_ASSESSED`; it is **not evidence about Accordo**.

## Safe interpretation

| Catalog template status | Repository overlay interpretation |
|---|---|
| `NOT_ASSESSED` | No positive claim. Repository default remains `not supported` until evidence is collected. |
| `ABSENT` | `not supported`, if the pinned-SHA audit proves absence. |
| `CONCEPT_ONLY` | Usually `partially supported` at most; prose/schema alone never proves support. |
| `PARTIAL` | `partially supported`, with the missing slice named. |
| `FUNCTIONAL` | Could be `technically supported` or `validated end to end`; choose only from merged evidence. |
| `PRODUCTION_READY` | Not a repository JTBD status. Track production-readiness gates separately. |
| `DEPRECATED` | Do not claim current support; record the deprecated implementation as evidence/limitation if useful. |

There is deliberately no automatic promotion mapping. The overlay status is derived from the pinned repository SHA, the smallest relevant Accordo rail, and merged tests/evidence.
