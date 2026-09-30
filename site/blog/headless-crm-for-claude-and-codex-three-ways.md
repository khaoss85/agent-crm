---
title: Headless CRM for Claude and Codex, three ways
date: 2026-09-30
claims: [C-01, C-04, C-14, C-16, C-18]
transcript: docs/strategy/COMPETITOR_MAP.md
editor: Aetha Editorial
summary: Headless CRM for Claude means three different bets — a CLI, MCP tools against a fixed app, or generated code you own. What each one is, and which question picks it.
---

"Headless CRM for Claude" currently means three different bets, and most confusion in the threads comes from comparing one against another without naming them. Here they are, with the question that picks each.

Vendor facts below come from `docs/strategy/COMPETITOR_MAP.md`, researched August 4, 2026 with a re-check pass on August 20, 2026. Per-entry dates say which pass each fact comes from. We refresh comparison content on a 90-day clock.

## Bet 1: a CLI the agent shells out to

One public repo literally carries the sentence "the headless CRM for Claude and Codex" (map, August 20, 2026): 114 stars, 428 commits, an a16z-speedrun backing claim in its own description — and two awkward facts recorded in the same row. It declares no licence at all (no root LICENSE file, no licence field in package.json, checked August 20), and its public repo froze in June 2026 on a commit pointing at a monorepo nobody outside can see, so its real velocity is unobservable. Its architectural stance is the interesting part: it rejects MCP on context-economics grounds and ships a CLI plus SDK instead. Pick this bet if you want "Claude runs my existing pipeline" with minimal context burn — after checking the licence situation yourself, because unlicensed source is not open source.

## Bet 2: MCP tools against a fixed app

Relaticle (re-checked August 20, 2026) advertises 32 MCP tools: agents operate the CRM — read, update, create — inside a fixed Laravel app they cannot reshape. HubSpot's remote MCP server is in public beta since May 2026 ([developer changelog](https://developers.hubspot.com/changelog/mcp-server-beta), re-verified September 30, 2026): Cursor and Claude interacting with hosted CRM data. Salesforce announced the platform-scale version of this shape at TDX 2026 — capability reachable by API, MCP tool and CLI without a browser, aimed at coding agents by name. The announcement is recorded; every tool count attached to it comes from search-index excerpts only, so no count appears here. Pick this bet if the CRM already exists and the job is operating it. See [Accordo vs Relaticle](https://accordo.dev/compare/vs-relaticle.html) for the fixed-app caveat in full.

## Bet 3: generated code you own

The third bet inverts the relationship: instead of the agent operating a fixed CRM through tools, the agent generates the CRM as reviewable code in your repository. That is this framework. A module manifest becomes migrations, services, REST resources and Admin screens (C-01); one command tells an agent what the application actually is, read from checked-in source (C-14); a project MCP server exposes context plus narrow write tools, with code generation and state destruction dry-run unless an explicit apply flag passes (C-18); the agent cannot approve on the human's behalf, asserted by a test (C-04); every mutation leaves an audit event and a step-level trace (C-16). Pick this bet if the sentence you want true is "Claude builds me the CRM and I own the repo" — and read [what an agent-built CRM is](https://accordo.dev/glossary/what-is-an-agent-built-crm.html) plus [the approval boundary in Q/A form](https://accordo.dev/answers/can-an-agent-approve-a-deal-or-discount.html) first.

Ownership here means vendored source rather than a dependency to bump (L-08): the scaffolder copies framework source into your project. The standing boundaries apply throughout: a framework for developers, not a hosted product (L-07), and no authentication ships (L-01). [Every claim and every limitation](https://accordo.dev/evidence.html) is on one page.
