---
title: When to use a CRM platform instead of this
date: 2026-08-18
claims: [C-01, C-03, C-04, C-16, C-18]
transcript: docs/strategy/COMPETITOR_MAP.md
editor: Daniele Pelleri
summary: Most teams weighing this framework against a CRM platform should take the platform. A write-up of our competitor review, dated facts only, and the narrow case that remains.
---

Most teams comparing this framework to a CRM platform should take the platform. That is not modesty; it is the conclusion of our own competitor review, and this article is a write-up of that review rather than a rebuttal to it.

The facts below come from one place: `docs/strategy/COMPETITOR_MAP.md`, researched on August 4, 2026. Treat that date as this article's `verifiedOn`. Nothing from any other project was installed or run, GitHub figures are that day's rounded numbers, and licence descriptions are factual summaries, not legal advice. Where the review does not carry a fact, this article does not either. We refresh comparison content on a 90-day clock, because a stale comparison describes a product that no longer exists.

## Take a platform if you are buying, not building

The review is blunt about the market line: Odoo, EspoCRM and SuiteCRM own the self-host SMB *buyer*, and this project does not compete for that buyer directly. If your company wants a CRM that a sales team logs into this quarter — with import, search, email, saved views, reporting, an admin panel and someone to call — buy one. Every one of those is a working feature in the products above and an absence in this framework, recorded in our public ledger rather than left for you to discover: no authentication or tenancy, no import or export, no email or calendar integration, no scheduler, local SQLite persistence, and no hosted product to sign up for.

The same review notes you cannot responsibly put real customer data into this framework yet: there is no export and no erasure path, so a data-subject request cannot be serviced. For a buyer, that single line should end the evaluation.

## Take a platform if you want agent features on a working CRM today

The interesting competition is not the legacy suites; it is the platforms converging on agent-friendly language, and the honest reading of the review is that several of them are ahead of us on their chosen axis.

**Twenty** is the strongest of these — the review names it the top competitive threat. It records an MIT SDK, a `create-twenty-app` command, git-backed workspace configuration, a `CLAUDE.md` in the repository, in-product AI agents, and native MCP confirmed for cloud workspaces (self-host parity unverified there, so unverified here). If you want a working open-source CRM platform whose extension story is genuinely code-shaped, and a runtime and AGPL-plus-enterprise-gated licensing shape are acceptable, Twenty is the comparison to run first.

**Relaticle** ships the most agent-forward incumbent claim in the researched set: a first-party MCP server with 30 tools. Agents operate the CRM; the review's caveat is that they cannot reshape it — customization is runtime configuration inside a fixed app, with solo-maintainer risk recorded alongside. If "agents working inside my CRM this afternoon" is the requirement, that category exists and Relaticle defines it.

**Comp AI's CRM** inverts our thesis entirely: an autonomous background agent with a work queue, working inside the product. The review credits it with proving demand and with a genuinely novel evidence-and-sandbox design, and records in the same row why it reads as a thesis demo rather than infrastructure — a fixed schema, single tenant, and very few commits behind a large star count. The review's own warning applies to everyone in the category, us included: stars here are marketing-inflected; measure forks, usage and benchmarks instead.

**Frappe CRM** is the platform to take if admin-led customization is how your organisation works. Its DocType model — the most mature metadata-driven customization in the researched set — generates forms and APIs from metadata in a running system, and it comes with a managed cloud and the ERPNext ecosystem around it.

## The narrow case that remains

What none of the researched projects offers — and the review is explicit that this is a statement about the researched set, not proof the market is empty — is a permissively-licensed framework in the Node ecosystem where a coding agent generates a bespoke CRM as reviewable, owned code, with deterministic workflows, human-approval policy, audit and trace as primitives.

That is the case this framework exists for, and it is deliberately small. A module manifest becomes a migration, a service, a REST resource, an SDK method and Admin screens, with no page code. Commercial policy is deterministic code rather than a model's judgement: a renewal at or above the threshold stops and waits for a named human, and a test asserts that an agent cannot make that decision on the human's behalf — the boundary is a property of the system, not a promise in a README. Every mutation leaves an audit event and a step-level trace. The agent surface is deliberately cautious: anything that generates code or destroys state is dry-run unless you pass an explicit apply flag.

Choose this only if all of that describes your problem *and* you can supply what is missing: authentication, hosting, PostgreSQL, import, export, and the data-governance path real customer records require. The platforms above supply those things because they are products. This is not a product; it is a framework whose output is an application in your repository.

## What we refuse to claim

No speed or build-rate comparison appears here, in either direction, because our agent build benchmark is published but has not been run — any number you see quoted for this project is not ours. No feature matrix appears, because the review does not carry one. And this article expires: when the competitor map is re-researched, it gets re-read against the new facts, and rewritten where they moved.

If you read this far and the platform still sounds right, take the platform. The readers we want are the ones for whom it genuinely is not.
