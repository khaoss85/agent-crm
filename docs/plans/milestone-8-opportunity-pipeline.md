# Milestone 8 — configurable Opportunity pipelines

## Goal and user-visible outcome

```text
Opportunity created in an initial stage
→ visible in a pipeline board
→ moved through stages
→ marked won or lost
→ transition audit / events / trace
```

Primary JTBD: *"Manage a sales Opportunity through a configurable sequence of
stages."* Pipeline state and movement only — no forecasting, no reporting, no
runtime stage editor.

## Approaches compared (required)

1. **Hard-coded Opportunity stage enum.** Already exists (the Milestone 0
   `stage` column and its fixed transition table). It cannot express a
   brief-specific sales process, which is the whole JTBD. Kept for the legacy
   approval slice, rejected as the configurable surface.
2. **Runtime CRUD Pipeline/Stage records.** Business-admin-editable pipelines
   as database rows. Maximum flexibility, but stage definitions stop being
   reviewable source (against the code-first philosophy), validation moves to
   runtime mutation paths, and every consumer must handle half-edited
   pipelines. This is the eventual evolution target, not the smallest step.
3. **Deterministic code-first pipeline definition registry (chosen).** A
   checked-in `packages/pipelines/generated/index.js` mirroring the action
   registry (ADR-011): validated fail-closed at startup, readable and
   versioned in source, generatable by an agent from a brief, exposed as
   deterministic schema metadata.
4. **A generic staged-resource contract for arbitrary modules.** The right
   long-term shape, but generalizing before a second consumer exists invents
   abstraction without evidence. The chosen contract is *deliberately built to
   generalize* — a pipeline declares its target `module`, the runtime works
   through the generic action surface, and nothing reads "opportunity"
   specifically except the starter definition — without claiming a proven
   generic contract yet.

Chosen: **3**, shaped so **4** can emerge later. Recorded as **ADR-014**
(pipeline contract + actions on explicitly eligible core modules).

## Pipeline definition contract (`pipelineContract: 1`)

```js
{
  pipelineContract: 1,
  name: 'b2b-sales',            // ^[a-z][a-z0-9-]*$
  label: 'B2B Sales',
  module: 'opportunity',        // must exist and be staged-eligible
  defaultStage: 'discovery',    // must be an open stage
  stages: [
    { key: 'discovery',   label: 'Discovery',   order: 10, type: 'open', probability: 10 },
    { key: 'demo',        label: 'Demo',        order: 20, type: 'open', probability: 30 },
    { key: 'proposal',    label: 'Proposal',    order: 30, type: 'open', probability: 60 },
    { key: 'negotiation', label: 'Negotiation', order: 40, type: 'open', probability: 80 },
    { key: 'won',  label: 'Won',  order: 50, type: 'won',  probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
}
```

Validation (fail closed at startup, Map-backed registry): contract version 1;
canonical pipeline name and stage keys; unique stage keys; unique integer
orders (stages sorted by order deterministically); exactly one `defaultStage`,
which must exist and be `open`; stage types only `open|won|lost`; at least one
open stage; at most one won and one lost stage; integer probability 0–100 with
won = 100 and lost = 0; labels bounded strings (≤ 80 chars), safely
serialized; target module exists **and is explicitly staged-eligible**; **at
most one pipeline per module** (determinism — multi-pipeline routing is future
work); no eval, no dynamic import, metadata never exposes executable code.

## Opportunity pipeline state (managed)

Core migration **v3** adds nullable columns to `opportunities`:
`pipeline_key`, `pipeline_stage`, `stage_entered_at`, `closed_at`,
`close_reason`. Nullable because pre-pipeline opportunities (and projects with
no pipeline installed) remain valid: `pipelineKey: null` means "not on a
board".

These five fields are **server-managed**: `OpportunityService.create` rejects
them in input (field-tied 400, same policy as generated managed fields), no
public update path exists, and the only write path is the service's new
in-process `applyManaged(id, patch, ctx)` — mirroring the generated-module
boundary (audit + event, savepoint-safe, validated against the registry).
They render read-only in the Admin and appear in schema metadata.

**Legacy coexistence (documented):** the Milestone-0 `stage` column, its fixed
transition table and the renewal-approval workflow are untouched — that fixed
lifecycle is what the approval policy is written against. Pipeline state is a
parallel, configurable surface; unifying them is deliberate future work, not
silently attempted here.

## Actions on an explicitly eligible core module (ADR-014)

`move-stage` must target the handwritten Opportunity module, but the action
surface (ADR-011) served only generated modules. Extension, fail-closed:
`createAgentCrmApp` declares `ACTION_ELIGIBLE_CORE_MODULES = ['opportunity']`;
the action registry accepts actions whose module is generated **or** in that
explicit list; the HTTP action route resolves such a core module **only for
actions** — core CRUD stays on its dedicated routes and is still never exposed
through the generic records surface. Eligibility is an explicit app-level
declaration, not introspection.

## The `move-stage` action

Framework-provided generic factory (`buildMoveStageAction({ module })` in
`packages/core/src/pipeline-actions.js`), registered by the starter:

```js
await client.module('opportunity').action(id, 'move-stage', {
  toStage: 'proposal',
  fromStage: 'demo',   // optional optimistic-concurrency check
  reason: '…',         // required when the target stage type is 'lost'
});
```

Server-authoritative rules (all in `execute`, since stage sets are
pipeline-defined and richer than `fromStates`):

- record exists; a pipeline is registered for the module; the record is ON
  that pipeline (`pipelineKey` matches) with a stage that belongs to it —
  anything else is a stable 409 (`NO_PIPELINE` / `PIPELINE_STATE_CORRUPT`);
- `fromStage`, when supplied, must equal the current stage → else
  `409 STALE_STAGE` (optimistic concurrency);
- target stage must exist in the same pipeline (400 otherwise);
- same-stage moves are rejected (`409 SAME_STAGE`) — explicitly not a silent
  no-op, so a stale double-submit is visible;
- allowed transitions this milestone: **open → open, open → won, open →
  lost**; any move out of `won`/`lost` is `409 TERMINAL_STAGE`; no reopen;
- `reason` (bounded string) is **required** for moves to the lost stage,
  recorded in `closeReason`; ignored otherwise (400 if supplied blank on lost);
- atomically via `applyManaged`: `pipelineStage`, `stageEnteredAt = now()`;
  entering won/lost sets `closedAt = now()`; open targets keep
  `closedAt`/`closeReason` null (reopen unsupported, so "clearing" never
  happens in practice — documented).

One managed-update audit + one `opportunity.updated` event per successful
move; repeated/stale moves are 409s with zero audit/event. Trace records the
pipeline key, from → to, and the normalized failure code on refusal.

## Conversion enters the default stage

`lead.convert` calls a new adapter capability
`enterOpportunityPipeline(opportunityId, context)` inside the same outer
transaction: if a pipeline targets `opportunity`, the new Opportunity gets
`pipelineKey` + declared `defaultStage` + `stageEnteredAt` atomically with its
creation — a converted lead can never produce a half-initialized board card.
If **no pipeline is installed**, the documented deterministic default is the
pre-M8 behavior: the opportunity is created with null pipeline state (legacy
mode) — no stage is invented. Repo-default apps (empty pipeline registry) keep
all M7 behavior byte-for-byte.

## Schema, API, SDK

`/api/schema` gains `pipelineContract: 1` and `pipelines: [{ name, label,
module, defaultStage, movePath, stages: [{ key, label, order, type,
probability }] }]` — deterministic, ordered by stage order, additive (old
clients ignore it). Opportunity list/get responses expose the five pipeline
fields. The generic action route and `client.module('opportunity').action()`
carry the move — no Opportunity-specific HTTP route.

## Admin board

`#/pipelines/<name>` (hash router), nav entry per registered pipeline.
Columns in stage order; open/won/lost distinguished by badge text (`Won ✓`,
`Lost ✕`) plus style, never color alone; cards show name, company label/id,
`formatMoney(valueCents, currency)` (deterministic grouping + 2 decimals —
never browser locale), current stage; per-column record count and
**per-currency** totals (currencies never summed together); every value
rendered as text; loading/empty/error/retry/unsupported-contract states;
stale-render token guard; move control = accessible `Move to [stage ▼] +
Move` per card using the same server action with `fromStage` optimistic
check (no drag-and-drop — the accessible control is the path).

## Concurrency

Same board, two writers, same `fromStage`, different targets → the outer
`BEGIN IMMEDIATE` serializes; the loser's `fromStage` check fails →
`409 STALE_STAGE`; cross-connection losers get the M6 retryable
`409 CONFLICT`; never raw SQLITE errors; exactly one transition audit/event;
restart preserves the final stage. Proven with two independent app instances
on one file database.

## Starter evolution

The B2B starter ships `pipeline.js` (the `b2b-sales` definition above),
registers it plus `buildMoveStageAction({ module: 'opportunity' })`, and
`install.mjs` proves: capture → qualify → convert → **Opportunity in
Discovery** → Demo → Proposal → Negotiation → one Won and one Lost. Clean
temp project, offline, path-with-spaces safe, no repo pollution, no demo
records in the default app.

## Milestones

- [x] ExecPlan (this document).
- [x] Pipeline contract + registry (core) with fail-closed validation.
- [x] Core migration v3 + OpportunityService managed pipeline state.
- [x] Core-module action eligibility (ADR-014) + `buildMoveStageAction`.
- [x] Adapter `enterOpportunityPipeline` + conversion default stage.
- [x] Schema `pipelines` metadata; SDK unchanged.
- [x] Admin pipeline board + nav + money formatting.
- [x] Starter pipeline + extended install proof.
- [x] Tests: contract validation, bypass matrix, transition rules, stale/terminal/same-stage, cross-connection concurrency, conversion default stage, no-pipeline legacy mode, second pipeline fixture (different stage set), migration v3 upgrade, board rendering + XSS, money formatting, restart.
- [x] Docs: ADR-014, ACTIONS/API/ADMIN, JTBD matrix (narrow), TASKS.md.
- [x] verify + smoke + starter + Chromium; PR open and unmerged.

## Fixed in the adversarial review (same PR)

1. **Dead pipelines on generated modules.** A pipeline targeting a generated
   module registered cleanly and booted — but was permanently unusable (no
   pipeline-state columns exist; every move is NO_PIPELINE; nothing can enter
   it). Probed live, then fixed: staged eligibility is now restricted to
   modules that store pipeline state (the action-eligible core modules);
   startup rejects the rest fail-closed with a precise message.
2. **Board silently hid drifted records.** A record whose stored stage key
   left the definition was counted in the header but shown in no column. The
   board now renders an explicit "Off-definition" section with the stored key
   and migration guidance, header counts reflect placed records only, and
   truncation (200-record load) plus excluded off-pipeline records are
   disclosed.
3. **Open-target moves kept corrupt terminal fields.** The patch now
   explicitly clears closedAt/closeReason on open targets, so coherence is
   enforced rather than assumed; won ignores a supplied reason (tested).
4. **Currency decimals were implicitly universal.** formatMinorUnits now
   documents the 1/100-units two-decimals contract as deliberately non-ISO
   (JPY/KWD tested under the stated limitation).
5. **New regression coverage:** legacy-stage/pipeline coexistence without
   cross-talk (M0 workflow never writes pipeline state; moves never touch the
   legacy column), conversion+pipeline-entry single-transaction fault
   injection, definition-drift refusal with untouched stored keys,
   no-terminal-stage pipelines (legal, open→open only), and the
   startup rejection of generated-module pipelines.

## Explicitly deferred

Runtime stage editor, arbitrary transition DSL, reopen, pipeline approval
rules, forecasting/weighted claims, quotas, dashboards beyond the board, saved
views, filters/search, stage-duration analytics, products/quotes, task engine,
reminders, email/calendar, durable outbox, OpenAPI, MCP mutation tools,
PostgreSQL, auth/tenancy/RBAC, Cloud code, remote exposure, telemetry,
rename/license/publication.
