# Accordo repository coverage crosswalk

The portable desired-state catalog is not a repository claim ledger. Phase D must map evidence to the four statuses defined by `docs/QUALITY_GATES.md`:

- `not supported` — default when the job is not proven.
- `partially supported` — a real slice works and the missing boundary is named.
- `technically supported` — primitives exist but the job is not proven end to end.
- `validated end to end` — a merged test drives the complete job and the row cites it.

`NOT_ASSESSED` in the portable catalog means no repository assessment has been made. `PRODUCTION_READY` is a separate readiness concept and never promotes a JTBD repository status.
