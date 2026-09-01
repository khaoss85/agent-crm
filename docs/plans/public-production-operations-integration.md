# Public production operations — integration

This ExecPlan is a living document. Progress, decisions, validation receipts, and review corrections are updated while implementation changes.

Written and committed before any code, which is the pattern that saved V3C from three cascading design reversals: each of its constraints was found by exploring, and each invalidated the shape before it.

## What this slice is, stated so it cannot drift

It **composes six existing contracts**. It invents no runtime. If a line of new lifecycle logic appears instead of composition, the slice is being written wrong:

- V3A durable job store, registry, worker
- V3B transactional outbox and its handlers
- V3C scheduled ask timers
- V4A secret provider
- V4B backup/verify/restore
- V4C telemetry sink and exporters

All six are already public from `packages/core/index.js` — V3C published the operating surface precisely because a timer nobody can run is not a contract.

## The lifecycle shape is already decided by constraints, not by preference

- **No autostart.** Three documents forbid it and V3C's whole design rests on it. `createAccordoAppAsync` gains no worker, no sink, no timer.
- **The composition cannot declare actions** (V3C established this), so operations are a constructed object, not registered actions.
- Therefore: the factory may *construct* an operations handle, but **constructing starts nothing** — the same semantics `createDurableJobWorker` already has, where construction claims no work and starts no timers.

The property to preserve, and to test: **an application built with operations available but never started behaves byte-identically to one that has none.** This is the twin of V3C's "nothing runs on a clock", one level up, and it is the first time a factory knows workers exist.

Names are **not** decided here. The campaign lists `startWorkers()/drain()/stop()/status()` as conceptual, and this repo forbids accepting names automatically; read the conventions from precedent when writing.

## Operational posture — the precedent is `sink.status()`

V4C already answers "what is the bounded shape of a status object": frozen, counters and booleans, no identifiers. The posture is that form one level up, and **inherits V4C's exclusion**: no tenant id, no job id, no fingerprint, no caller-controlled text. Enums, booleans and counts only.

Content, per the campaign: storage; writer lease and readiness; jobs worker running or stopped; bounded outbox backlog counts; backup capability; whether an exporter is configured. Never credentials, locators, domain payloads or unrestricted diagnostics.

## Bounded shutdown, and the honesty V4C already had to find

`drain()` and `stop()` must state what happens to a worker that does not finish inside its deadline. The precedent is V4C's L1: an exporter that hangs poisons the sink permanently, and the resolution accepted was to **declare it** rather than build eviction. **"It is declared" is a legitimate answer; "it hangs" is not.**

## Truth reconciliation — most of it is already done

V3C and V4C did the hard part: the umbrella fact is retired, six facts stand with their own probes and scoping codes, and every surface that cited the retired id moved.

What remains for this slice:
1. `docs/PROJECT_STATUS.md` lines 114, 123 and 182 — they name the observability export as pending, which V4C's merge falsifies. Line 147 (the *backend* blocker) stays true and must not be touched: interface is not backend.
2. Any new fact for the lifecycle itself — which would need its own scoping code, the fourth of the series.

The `productionPosture` sentence was closed in V4C: all six contracts in the positives, "durable jobs" replaced in the absences by *who runs them for you*, the outbox citation added, and the same correction in the roadmap.

## Roadmap continuity (§8.5)

The classification already exists in `roadmap-continuity.md`. This slice carries it into the documents, including the correction it establishes: **this campaign does not complete Phase 6** — remote-safe MCP is still open, shared-database tenancy is deliberately deferred, and "done means the whole phase, not v1". The success stop may be reported only in the narrow sense its own words allow.

## Open question to answer in the PR, not before

Does `app.operations` count as an agent-facing surface? If yes, `CODING_AGENT_DX_NORTH_STAR`'s eight questions must be answered **in the PR that introduces it**, and `npm run surface:check` applies. Prevised as a section; not resolved at a desk.

## Gates this slice will certainly touch

`app-inspect.js` (bound surface) → characterization. `repo:truth` if a fact moves. `gtm:check` and `site:check` if published prose moves. The alignment matrix: an explicit operations lifecycle is a horizontal capability, so a row per domain, in the same PR.

## A follow-up this campaign earned the right to file

`scripts/repo-truth.js` already names the fix for the failure that bit this campaign twice: *"Generating the sentence from its facts is the real answer and is named as v2."* It is named in a comment and recorded nowhere as pending work.

The evidence this campaign produced for it, which is what a TASKS entry should carry:

- **V3C** updated four `truth:` citation lines above `productionPosture` and left the sentence below saying the opposite. The gate stayed green, because citations bind values and say nothing about the prose underneath — the failure the comment three files away describes, committed by someone who had just read it.
- **V4C** shipped a positive fact that **no surface cited at all**, where its two predecessors were cited by three and two surfaces. Nothing could catch it: there is no gate on facts nobody cites.

Both were found by a person re-reading, not by a tool. A generated sentence would have caught the first and made the second impossible.

Worth stating plainly in the entry: attention would not have prevented either. Updating four citation lines and not re-reading the sentence beneath them is a movement of the hand, not a decision.

## One small thing to carry into this slice

`tests/spine-v4c-observability-export.test.js` explains its sentinel choice in a comment that quotes the very form which triggers the scanner (`postgres://u:hunter2@h/db`). That comment is why the finding count went from one to two: the fix added a second detection. It lands on main harmless — the check does not gate merges here — but it is a live trigger for future PRs that touch the file.

Reword the comment to describe the shape without spelling it out. It is a two-line change and belongs wherever the next commit touches that area, not in a PR of its own.

## Why this campaign's reviews found what they found

Held back during V4C so as not to move an head a merge was waiting on, and recorded here instead.

**Why two viewpoints found what neither could alone.** On the fourth surface of M4, the reviewer had the right question without the complete map of surfaces; the author had the map without the question. Two incompletenesses of different kinds, neither of which more attention cures — they are cured only by being brought into contact. That is the structural reason every serious defect in this campaign came out of a meeting between two points of view, and not out of anyone looking harder.

**A stale message is not only friction.** The sixth case surfaced because a Lead message reported as missing something already done: instead of answering "it is done, look at the commit" — true, and comfortable — the author re-read, and found the fix was half a fix. It happened twice in this campaign that someone else's out-of-date correction caused a re-read of something considered closed. Worth writing down, because it suggests a misaligned message is not purely waste: it forces a re-read, and sometimes nothing else does.
