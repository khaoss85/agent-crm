---
title: What our inspector refuses to tell you
date: 2026-08-18
claims: [C-13, C-14, C-15]
transcript: docs/transcripts/2026-08-18-app-inspect-limitations.json
editor: Aetha Editorial
summary: The application inspector emits its own blind spots as machine-readable limitation codes, in the same JSON as the capabilities. That is an affordance for agents, not a disclaimer for lawyers — and the difference is testable.
---

Most tools report what they found. Ours also reports what it cannot see — as structured data, in the same JSON document, with stable codes an agent can branch on.

Run `npm run crm -- app inspect --json` in this repository and the report describes the composed application from checked-in source: packages, capabilities, resources, actions, policies, providers, modules. Then, before the document ends, it lists eleven `limitations[]` entries. The run behind this article was made on 2026-08-18 and saved unedited at `docs/transcripts/2026-08-18-app-inspect-limitations.json`; every quote below is from that file.

Two things in that transcript are worth noticing before the limitations. First, `valid` is `true`. Second, the composition is nearly empty — four core modules, no packages, no actions, no providers — because the framework repository itself is not a composed product. The inspector does not pad the answer to look busier: an application that composes nothing is reported as an application that composes nothing, and it is still a valid one.

## The eleven refusals

The codes group naturally into what the inspector never opens, what it cannot know, and what it admits about itself.

**It never opens your database.** `DATABASE_NOT_INSPECTED` says it plainly: "the configured application database is never opened, so what a particular database has applied, holds or is missing is unknown." Its sibling `SECRETS_NOT_INSPECTED` adds that no secret, credential, token or environment value is read, and no provider is contacted. `DATA_QUALITY_UNKNOWN` closes the set — source-only inspection "can say which records exist, never whether their data is correct, complete or duplicated."

**It refuses to infer runtime state.** `RUNTIME_STATE_UNKNOWN` ("nothing here reports what is running, deployed or reachable"), `PROVIDER_HEALTH_UNKNOWN` (a registered provider definition means a provider was composed, "never that it is reachable, configured or operational") and `CI_EVIDENCE_NOT_INFERRED` (no CI, browser-smoke or benchmark result is read) all guard the same line: a source tree is evidence about source, and pretending otherwise is how a report becomes a rumor.

**It refuses to parse prose into claims.** `EVIDENCE_NOT_AGGREGATED` states that JTBD and quality-gate status "live in Markdown maintained by people; they are referenced by path and never parsed into structured claims." The report's `evidence` block carries the paths and a status of `not_aggregated` rather than a synthesized score.

**It names what does not exist anywhere.** the current posture separates three facts: the framework ships no authentication verifier, authorization is enforced, and isolation is one tenant per application instance rather than shared-database row tenancy. And `ADMIN_EXTENSIONS_UNSUPPORTED` makes a distinction most tools skip: `adminExtensions` is empty "for every project — not merely empty for this one." An empty array is ambiguous; this code removes the ambiguity in the direction least flattering to the framework.

**It confesses its own execution model.** The two remaining codes are about the inspector, not the application. `PACKAGE_SOURCE_TRUSTED`: reading a code-first package means importing it, so "package code runs with this process's authority. Nothing here is sandboxed." `PROCESS_ISOLATION_BOUNDED`: the load runs in its own process group under a timeout, so an ordinary spawned child is stopped with it — but a package that deliberately detaches a process into a new group outlives the inspection, and the message adds that tracking descendants is not attempted "and would not be a sandbox either."

That last pair is not modesty for its own sake. [`tests/app-inspect.test.js`](https://github.com/khaoss85/agent-crm/blob/main/tests/app-inspect.test.js) demonstrates a package that really does write to disk while being inspected — which is exactly why `PACKAGE_SOURCE_TRUSTED` is a published limitation rather than a footnote — and measures the detached-process case that `PROCESS_ISOLATION_BOUNDED` describes. The same suite pins the codes in place: the count of limitation entries is asserted, each code must appear in the human-readable view as well as the JSON, and a clean, fully valid composition still reports all eleven. Validity and self-knowledge are different questions, and the report answers both.

## Why codes, not a disclaimer

A disclaimer is written for a person with a lawyer's patience. These limitations are written for a consumer with none: a coding agent deciding what to build next.

An agent that reads this report learns what exists — and, from the same document, the exact boundary of what the report can testify to. The [adversarial-review skill](https://github.com/khaoss85/agent-crm/blob/main/.claude/skills/adversarial-review/SKILL.md) in this repository turns that into an instruction: read `valid`, then `problems[]`, then `limitations[]`, and treat every limitation as a hard boundary on what you may claim. An agent that ignores prose disclaimers — which is to say, every agent — cannot ignore a field in the JSON it is already parsing.

The design consequence shows up one layer above the inspector. A Solution Plan in this framework is a checked-in file validated against a real inspection, so a plan written against a composition that has since moved reports itself stale instead of being taken at its word ([`docs/SOLUTION_PLAN.md`](https://github.com/khaoss85/agent-crm/blob/main/docs/SOLUTION_PLAN.md)). That mechanism only works because the inspection says what it does not cover: a plan validator that believed the inspector knew about runtime state or database contents would approve plans the framework has no way to check.

There is a quieter benefit, too. When a tool enumerates its blind spots, the blind spots become reviewable. `ADMIN_EXTENSIONS_UNSUPPORTED` exists because someone had to decide whether an empty array meant "none here" or "none possible", and the decision is now a sentence in the output instead of tribal knowledge. If a future change gives packages an Admin seam, this code has to be removed in the same change — the limitation list is source code, and it drifts or holds with the rest of it.

## What this article cannot claim either

The same boundary applies here. The inspector is source-only and read-only; everything above describes what a checked-in tree declares, not whether any running system is healthy, and this article inherits every refusal it quotes. The transcript is the framework repository inspecting itself — a composed project built from the framework reports its own, larger composition, and its limitation list is the same eleven codes because the blind spots belong to the tool, not to the project.

The pattern travels beyond this codebase, and it costs almost nothing to adopt: when you build a tool for agents, return your blind spots as data. A capability list tells an agent what it can rely on. A limitation list tells it what it must go verify by other means — and the second list is the one that prevents the confident, wrong plan.
