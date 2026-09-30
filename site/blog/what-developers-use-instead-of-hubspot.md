---
title: What developers use instead of HubSpot
date: 2026-09-30
claims: [C-01, C-03, C-04, C-16, C-17, C-21]
transcript: docs/strategy/COMPETITOR_MAP.md
editor: Aetha Editorial
summary: A buyer-vs-builder fork: take the SaaS platform when nobody writes code, generate owned code when a dev is on the team — with the exact things the framework path still lacks.
---

Whether developers should use anything instead of HubSpot depends on whether anyone on the team writes code. If not, stop here and take the platform — this article argues you into it, not out of it. If yes, there is a third path besides paying per seat forever or building from nothing: have a coding agent generate the CRM as code you own.

Vendor facts below come from `docs/strategy/COMPETITOR_MAP.md` (HubSpot row researched August 18, 2026 from search-index excerpts of the vendor's own pages) plus one fact re-verified today: HubSpot's remote MCP server is in public beta since May 2026 ([developer changelog](https://developers.hubspot.com/changelog/mcp-server-beta), read 2026-09-30), letting AI clients such as Cursor and Claude interact with HubSpot data. No pricing figures appear here — nothing quoted, nothing to go stale. Licence descriptions are factual summaries, not legal advice. We refresh comparison content on a 90-day clock.

## Take HubSpot if nobody writes code

HubSpot is a vendor-hosted SaaS CRM ("Smart CRM" in their docs) with a free tools tier (map, August 18, 2026). If your team will never open a repository, that sentence ends the evaluation: configured software with support beats a framework your team cannot operate, every time. The MCP beta above also means "our AI assistant updates the CRM" is a supported path without building anything.

## Take the builder path if a dev is on the team

The builder path exists for one situation: a commercial process unusual enough that configuration keeps bending it out of shape, plus someone to own the result. That is what this framework is: a coding agent generates a bespoke CRM as reviewable, owned code — a module manifest becomes a migration, a service, a REST resource, an SDK method and Admin screens (C-01) — with deterministic commercial policy (C-03), an approval refusal a non-human actor cannot cross, asserted by a test (C-04), the same refusal where the money is, with a 403 and code HUMAN_APPROVAL_REQUIRED (C-21), and an audit event plus step-level trace on every mutation (C-16). SQLite is built in; PostgreSQL needs one pinned driver (C-17).

Read [what day 30 of that build looks like](https://accordo.dev/blog/build-a-custom-crm-with-claude-code-day-30.html) before deciding — it is about the four things that go wrong, not the demo that goes right — and [whether an agent may approve on your behalf](https://accordo.dev/answers/can-an-agent-approve-a-deal-or-discount.html) for the boundary in Q/A form.

## What the builder path still lacks, exactly

This is where evaluations usually die, so here it is up front. No hosted CRM and no account exist — the output is an application in your repository, not a product you sign up for (L-07). No authentication ships; the deployment supplies the verifier (L-01). No email, calendar or marketing integrations ship (L-05) — a HubSpot team lives in those, so count the cost honestly. Nothing bills: no invoices, payments, tax or revenue recognition (L-10). If any line on that list is load-bearing for you this quarter, take the platform and revisit later.

[Every claim and every limitation](https://accordo.dev/evidence.html) is on one page, and so are [the questions this project refuses to answer](https://accordo.dev/answers.html#limits).
