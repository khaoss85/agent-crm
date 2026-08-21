# JTBD catalogue v1.1 normalization

Catalogue v1.1 ratifies `L3 => human_approval_required = true`. The correction proposal reviewed every affected record's role, job, trigger, desired outcome, risk and sensitive-data declaration. All contradictory rows explicitly intended no approval and were LOW or MEDIUM risk, so they move from L3 (acts after approval) to L2 (recommends or prepares). No approval boolean was blindly flipped and no HIGH-risk row was downgraded.

`quality/correction-log-v1.1.json` records every old/new decision and both checksums. `catalog/supersessions.json` keeps retired ids resolvable; v1.1 retires none. `quality/dispositions-v1.1.json` gives every mechanically proved v1.0 finding a disposition. Decisions that require product meaning remain explicitly deferred for human review rather than receiving a guessed rewrite.

The desired catalogue, coverage overlay and roadmap ownership overlay remain separate. Catalogue wording or autonomy changes do not promote coverage. Roadmap assignment does not promote coverage. The five positive coverage rows remain partial and retain their executable evidence and limitations.

Every desired job now has an explicit public roadmap assignment containing disposition, pillar, edition, track, milestone/epic and dependencies. Assignments use coherent slices rather than per-job milestones. No priority, business value, competitive rationale or commercial sequencing appears in the public overlay.

## Evidence preservation

The v1.1 correction changes an autonomy boundary, not the job wording, trigger or desired outcome. Existing positive evidence is not transplanted to a different job; the five assessed rows retain their wording and remain partially supported. Any future material wording change must be re-assessed or marked `NOT_ASSESSED` before evidence can follow it.

## Human review boundary

This branch is deliberately open and unmerged. Product review still decides the deferred semantic findings and the private prioritisation overlay. It starts none of the roadmap slices it names.
