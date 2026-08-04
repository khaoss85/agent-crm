# ExecPlans

An ExecPlan is a self-contained, living implementation plan for a feature that spans multiple files or introduces a material design decision.

Each plan must contain:

1. **Goal and user-visible outcome**.
2. **Current repository context** with exact files and concepts.
3. **Milestones** that each leave the repository runnable.
4. **Validation** with commands and expected behavior.
5. **Progress log** updated while implementing.
6. **Decision log** for ambiguities resolved during work.
7. **Outcome and follow-up** after implementation.

The implementing agent proceeds through milestones without asking for routine confirmation, keeps the plan current and runs `npm run verify` before completion.
