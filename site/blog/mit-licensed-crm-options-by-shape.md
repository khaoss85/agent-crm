---
title: MIT-licensed CRM options, by shape
date: 2026-09-30
claims: [C-01, C-03, C-04, C-16, C-17]
transcript: docs/strategy/COMPETITOR_MAP.md
editor: Aetha Editorial
summary: Most well-known open-source CRMs are AGPL-family. The MIT options differ by shape — fixed app, template, or framework — and the shape matters more than the licence.
---

Most well-known open-source CRMs are AGPL-family, which is fine for self-hosting your own instance and a problem the day you want to embed the thing, resell on top of it, or keep derivatives private. The MIT-licenced options exist, but they differ by shape — and the shape matters more than the licence.

The vendor facts below come from one place: `docs/strategy/COMPETITOR_MAP.md`, researched August 4, 2026 with a re-check pass on August 20, 2026. Per-entry dates say which pass each fact comes from. Licence descriptions are factual summaries, not legal advice. We refresh comparison content on a 90-day clock.

## The AGPL landscape, as researched

- **Twenty** (re-checked 2026-08-20, 55.2k stars): AGPLv3 core with a "Twenty Application Exception" for apps built on published APIs, MIT for SDK and UI packages, and commercial terms for files marked Enterprise. The review re-read the LICENSE file on that date. Native MCP confirmed for Cloud workspaces; self-host parity unverified there, so unverified here. Our full write-up is [Accordo vs Twenty](https://accordo.dev/compare/vs-twenty.html).
- **Relaticle** (re-checked 2026-08-20): AGPL-3.0, Laravel and Filament, advertising 32 MCP tools in its repo description. Agents operate the CRM through MCP but cannot reshape it — customization is runtime configuration inside a fixed app — with solo-maintainer scale recorded alongside. See [Accordo vs Relaticle](https://accordo.dev/compare/vs-relaticle.html).
- **Frappe CRM** (2026-08-04): AGPL app on the MIT-licensed Frappe framework, DocType metadata model, managed cloud, ERPNext ecosystem. See [Accordo vs Frappe CRM](https://accordo.dev/compare/vs-frappe-crm.html).
- **EspoCRM and SuiteCRM** (2026-08-04, not re-verified): AGPL, legacy PHP, 3.2k and 5.6k stars that day. See [Accordo vs EspoCRM and SuiteCRM](https://accordo.dev/compare/vs-espocrm-and-suitecrm.html).
- **Odoo CRM** (2026-08-04, not re-verified): LGPL community plus proprietary Enterprise, with AI features Enterprise-only per secondary sources. See [Accordo vs Odoo](https://accordo.dev/compare/vs-odoo.html).

## The MIT options, by shape

**A fixed app: Comp AI's CRM** (re-checked 2026-08-20): MIT, 8.7k stars, 211 commits, single-tenant by explicit design, Vercel-coupled, no MCP package. The August re-check is blunt that the old "thesis demo" verdict no longer holds: it ships working authentication, a durable scheduler, and live providers — things this framework does not ship, stated plainly. If you want an agentic CRM to run rather than code to own, that is the MIT app. See [Accordo vs Comp AI CRM](https://accordo.dev/compare/vs-comp-ai-crm.html).

**A template: Atomic CRM** (2026-08-04): MIT, React Admin plus Supabase distributed through a component registry — copied into your repo, genuinely yours. Templates carry no workflow engine, no policy or approval, and no audit, which is precisely the machinery a CRM accumulates after the screens are done. See [Accordo vs templates and starters](https://accordo.dev/compare/vs-atomic-crm-and-supabase-starters.html).

**A framework: Accordo.** MIT since Milestone 0 (`LICENSE`, `package.json`, `site/brand.json` under ADR-023): a coding agent generates a bespoke CRM as reviewable, owned code. A module manifest becomes a migration, a service, a REST resource, an SDK method and Admin screens (C-01). Commercial policy is deterministic code: a renewal at or above the threshold stops and waits for a named human (C-03), the agent cannot approve on the human's behalf, asserted by a test (C-04), and every mutation leaves an audit event and a step-level trace (C-16). SQLite is Node's built-in adapter; PostgreSQL needs one pinned driver (C-17).

## Shape first, licence second

Get the shape wrong and the licence will not save you: a template when you needed approvals, a fixed app when you needed your own schema, a framework when you needed something running this afternoon. Get the shape right under MIT and no vendor runtime can ever re-tier you.

The boundary travels with the recommendation: this is a framework for developers, not a hosted product (L-07), and no authentication ships, so a deployment supplies the verifier (L-01). [Every claim and every limitation](https://accordo.dev/evidence.html) is on one page, and so are [the questions this project refuses to answer](https://accordo.dev/answers.html#limits).
