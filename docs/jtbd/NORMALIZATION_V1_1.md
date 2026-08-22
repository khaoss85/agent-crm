# JTBD catalogue v1.1 normalization

Catalogue v1.1 ratifies `L3 => human_approval_required = true`. The machine-readable approval-boundary review evaluates every affected record's canonical job, trigger, desired outcome, flow, pattern, outputs, acceptance criteria, risk and sensitive-data declaration. It retains L3 with approval where the semantics act on state, moves recommendation/preparation-only jobs to L2, and keeps ambiguous `ACC-JTBD-AE-012` in a conservative valid L3 + approval state while explicitly requesting human confirmation. The generated summary in that artifact is the only authority for classification counts.

`quality/correction-log-v1.1.json` records every old/new decision and both checksums. `catalog/supersessions.json` keeps retired ids resolvable; v1.1 retires none. `quality/dispositions-v1.1.json` gives every mechanically proved v1.0 finding a disposition with its concrete evidence, while `quality/semantic-review-packet-v1.1.json` groups the human queue by decision family and preserves its exceptions. Decisions that require product meaning remain explicitly deferred rather than receiving a guessed rewrite.

The desired catalogue, coverage overlay and roadmap ownership overlay remain separate. Catalogue wording or autonomy changes do not promote coverage. Roadmap assignment does not promote coverage. The five positive coverage rows remain partial and retain their executable evidence and limitations.

Every desired job now has an explicit public roadmap assignment containing disposition, pillar, edition, track, milestone/epic and dependencies. Assignments use coherent slices rather than per-job milestones. No priority, business value, competitive rationale or commercial sequencing appears in the public overlay.

`roadmap/assignment-audit-v1.1.json` checks every assignment against the registered pillar metadata and reports its distribution from the rows. It explicitly has no coverage effect. `quality/REVERSE_CAPABILITY_AUDIT.json` gives every orphan capability a reason tied to its name, definition and classification; it never creates a desired job to justify code.

## Evidence preservation

The v1.1 correction changes an autonomy boundary, not the job wording, trigger or desired outcome. Existing positive evidence is not transplanted to a different job; the five assessed rows retain their wording and remain partially supported. Any future material wording change must be re-assessed or marked `NOT_ASSESSED` before evidence can follow it.

## Human review boundary

The reported 264/16 proposal and `needs_human_confirmation` note were not found in reachable Git history or PR #108/#109 discussion; they remain integrator-handover context rather than repository evidence. The catalogue's DECIDE-pattern review independently approaches that split, but does not pretend to confirm the missing proposal. This branch is deliberately open and unmerged. Product review still decides `ACC-JTBD-AE-012`, the grouped deferred semantic families, and the private prioritisation overlay. It starts none of the roadmap slices it names.
