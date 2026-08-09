<!--
docs/QUALITY_GATES.md §1 is the full list. This template is the short form.
A milestone PR additionally needs the adversarial review (§2) before it merges.
-->

## What this changes

<!-- One paragraph. What behaviour is different after this merges? -->

## Evidence

<!--
Every claim above must trace to a merged test. Name them.
"a capability and its limitation are stated in the same breath" — AGENTS.md
-->

| Claim | Test |
|---|---|
|  |  |

**Limitations this change does not remove:**

<!-- What a reader might reasonably assume now works, and still does not. -->

## Checklist

- [ ] `npm run verify` passes from a clean clone
- [ ] `npm run smoke` passes
- [ ] `npm run gtm:check` passes if any public claim, README line or site copy changed
- [ ] Tests cover the happy path **and** the policy boundary
- [ ] No mutation outside a module service or named workflow
- [ ] Trace and audit are visible for new behaviour, and counts are asserted rather than presence
- [ ] Docs, ADR and the relevant agent skill move in this PR, not a follow-up
- [ ] `docs/benchmarks/CRM_JTBD_MATRIX.md` updated conservatively — a row moves only for what the merged tests prove
- [ ] `docs/PROJECT_STATUS.md` updated if this is a milestone merge
- [ ] No secrets, databases, build output or `node_modules` in the diff

## Decisions

<!-- Any change to a shared contract (runtime, registry, HTTP envelope, manifest) needs an ADR. Link it, or state that none applies. -->
