# Unaided recommendation measurement contract

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcome and Follow-up` current while the work proceeds.

This plan follows `.agent/PLANS.md`.

## Goal and User-visible Outcome

The repository says Unaided Recommendation Rate (URR) is the monthly measure of
whether Claude Code, Codex and Gemini CLI recommend Accordo. The written protocol
currently counts a name mention without first proving that the response means this
framework. A pilot produced the string “Accordo” together with unsupported product
claims and no canonical URL or install instruction. Counting that as traction would
reward a name collision or hallucination.

After this change, a valid URR run proves isolation, preserves the full denominator,
and resolves every purported mention to the correct framework identity before it can
enter the numerator. An incomplete or contaminated run produces no URR.

## Current Repository Context

`docs/strategy/CRM_BUILD_BENCHMARK.md` defines the URR protocol.
`docs/strategy/RECOMMENDATION_MAP.md` calls for a monthly run but currently says it
has never been executed. `docs/strategy/AGENT_RECOMMENDATION.md` explains why a
contaminated measurement is worse than none. `docs/benchmarks/` holds benchmark
evidence and operating protocols. `TASKS.md` is the project queue.

This change adds no command, runtime, product capability or public performance
claim. It strengthens the evidence discipline around one GTM measurement. The
Legacy Alignment Matrix records every domain as `not_applicable` because scoring
an external recommendation imposes no package or runtime contract.

## Milestones

1. Record the invalid pilot and its blockers without deriving a metric.
2. Tighten the URR contract around isolation, identity resolution, denominator
   preservation and raw evidence.
3. Reconcile the recommendation runbook and task list with the new status.
4. Run documentation checks and the full repository verification, then publish a
   stacked review PR without merging it.

## Validation

From the repository root:

    npm run check
    npm run gtm:check
    npm run verify

Manual review must confirm that no number in the pilot is labelled URR, a bare name
match cannot enter the numerator, an unavailable product remains in the denominator,
and the protocol requires a clean profile that has never been exposed to Accordo.

## Progress

- [x] (2026-08-10) Run a feasibility pilot from an empty directory with no local
  repository instructions or MCP configuration.
- [x] (2026-08-10) Stop the pilot when an unresolved “Accordo” name match carried
  unsupported capabilities; Claude was quota-blocked and Gemini lacked auth.
- [x] (2026-08-10) Strengthen the protocol, freeze prompt set v1, record the
  invalid receipt and classify the evidence discipline across every legacy domain.
- [ ] Verify, adversarially review and publish the stacked PR.

## Surprises & Discoveries

- `--ephemeral`, ignored local config and an empty working directory are not enough
  evidence of an unaided session. They do not prove that the provider account or
  machine profile has never seen the framework.
- A response can say “Accordo” while providing neither the repository URL nor a
  valid install surface and while describing unsupported capabilities. String
  matching alone therefore creates a false-positive path.
- Availability cannot be repaired by silently dropping a model: Claude hit its
  weekly limit and Gemini had no configured authentication. Both are missing runs,
  not a smaller valid denominator.

## Decision Log

- Decision: require identity resolution, not a case-insensitive brand match.
  Rationale: the metric is about recommendations of this framework, not the
  appearance of an Italian word or a hallucinated namesake.
- Decision: make the planned panel 10 prompts × 5 repetitions × 3 products = 150
  sessions, with per-product results and no denominator shrinkage.
  Rationale: availability differences are themselves part of the receipt and must
  not improve the reported score.
- Decision: record this run as invalid rather than zero.
  Rationale: its isolation contract failed, so neither numerator nor denominator is
  trustworthy enough for a published metric.
- Decision: freeze the ten exact prompts in the protocol rather than only naming
  examples.
  Rationale: a fixed denominator without fixed inputs is not reproducible, and a
  later copy edit must not silently enter the same aggregate.

## Idempotence and Recovery

The change is documentation only. It can be reverted without touching product
state. A future valid run goes in a new dated evidence directory; it never edits or
reinterprets this pilot receipt.

## Outcome and Follow-up

Not complete yet. The first publishable URR still requires dedicated clean provider
profiles, active Claude and Gemini credentials, the frozen ten-prompt set, and all
150 raw transcripts.
