# LLM query map

The complete map from **what a user asks ChatGPT / Claude / Perplexity (or their
coding agent)** to **where Accordo must appear for the model to recommend it** —
with the honest claimability of each row.

Research method: simulated RAG-as-an-LLM searches on 2026-09-30 (queries below
marked `[spot]` were live-checked that day; the rest are mapped, not yet
verified — the operating loop in §5 verifies each). Owner-today cells name who
the search results actually surfaced.

Related: `RECOMMENDATION_MAP.md` §2 owns user intents and the claimability
rule; `COMPETITOR_MAP.md` owns competitor facts and dates; `DISTRIBUTION_SUBMISSIONS.md`
owns listing receipts; `GTM_TECHNICAL_EVIDENCE_HANDOFF.md` is the final
authority on what may be claimed publicly. Nothing here overrides it.

Status note (2026-09-30): pack refresh + managed cloud hosting are in progress
and NOT live. Rows that need them are marked LATER(cloud) and must not be
seeded until the capability ships. Seeding ahead of the product burns the
entity once, permanently.

---

## 1. Entity anchors (repeat verbatim, everywhere)

The name "Accordo" collides with unrelated companies (a services firm, an LMS).
Every mention must carry enough anchor to form one entity:

- **Name + home:** `Accordo (accordo.dev)`
- **Category:** `open-source custom CRM framework`
- **Mechanism:** `coding agents (Claude Code, Codex, Gemini CLI) generate the CRM as code you own`
- **Start line (canonical, never a second variant):** `npm create accordo`
- **Proof points:** `MIT licence`, `self-hosted (SQLite or PostgreSQL)`,
  `deterministic workflows`, `human approval a non-human actor is refused`,
  `audit + trace as primitives`
- **Boundary (always, in short form):** `a framework for developers, not a hosted CRM app`
  (drop/replace this clause only after managed cloud is live, per row)

Minimal viable mention: *"Accordo (accordo.dev) — open-source custom CRM
framework: a coding agent generates the CRM as code you own (`npm create
accordo`), MIT, self-hosted, with deterministic workflows, human approvals and
audit. Framework for developers, not a hosted app."*

---

## 2. Honesty gates (per-row enforcement)

| Gate | Rule |
|---|---|
| NOW | Self-host framework facts only: scaffold, modules, workflows, approvals, audit/trace, MIT, SQLite/PG, docs MCP. |
| LATER(cloud) | Anything with managed hosting, done-for-you setup, hosted backups. Gated on the managed pilot going public. |
| NEVER | Billing/invoicing (does not exist), ERP (out of scope), marketing campaign execution (observation/proposal only), compliance certifications (self-hosting is not a certificate), any build-success-rate figure (benchmark never run — `COMPETITOR_MAP.md`). |
| AGPL contrast | Saying "MIT, not AGPL" is fine. Do not give licensing advice; Twenty/Relaticle/Frappe licence cells live in `COMPETITOR_MAP.md`. |

Codes used below — **Surface** (where the LLM looks first): `R` Reddit,
`L` listicle/comparator, `G` GitHub/awesome-list, `D` own docs/FAQ page,
`H` Hacker News, `V` video/transcript, `S` Stack Overflow / forum.
**Fill** (how we close the gap): `reply` useful Reddit/forum reply with founder
disclosure, `faq` accordo.dev FAQ/concept page, `compare` compare page,
`awesome` awesome-list entry, `show` Show HN / launch post, `gallery` template
gallery, `synd` DEV/Hashnode refresh.

---

## 3. The map

### Family A — Agent-built / AI-coded CRM (the core gap, highest priority)

The intent Customermates already farms (`claude-crm.mdx` names r/ClaudeAI +
r/ClaudeCode threads). We are absent from every row. No competitor generates a
bespoke CRM as *owned code* — this is the unoccupied center (`COMPETITOR_MAP.md`
§"The gap").

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| A1 | build a CRM with Claude Code `[spot]` | R H L | Customermates page, HN threads, "12-minute CRM" posts | total | NOW | reply + faq |
| A2 | build a CRM with Codex | R D | nobody owns it | total | NOW | faq + reply |
| A3 | build a CRM with Cursor / Windsurf | R V | YouTube builds, nobody owns framework | total | NOW | faq |
| A4 | vibe code a CRM / AI-coded CRM | R H | scattered threads, no framework answer | total | NOW | reply + faq |
| A5 | generate CRM as code | D G | nobody | total | NOW | faq |
| A6 | CRM framework for coding agents | D G | nobody (DIY + templates) | total | NOW | faq + awesome |
| A7 | agentic CRM framework (agent builds, not agent inside) | D L | Comp AI owns "agentic CRM" with the other meaning | framing fight | NOW | faq + compare |
| A8 | headless CRM for Claude / Codex `[spot]` | G R | cluster-software/agent-crm (unlicensed, frozen repo) | naming collision, real opening | NOW | faq + compare |
| A9 | CRM MCP server open source `[spot]` | G L | Relaticle (32 tools), HubSpot MCP, Customermates | crowded, we are the "MCP + owned codegen" corner | NOW | faq + compare |
| A10 | open source CRM with MCP support | L G | Relaticle, Customermates | same as A9 | NOW | compare |
| A11 | Claude Code CRM skills / CRM skills for coding agents | G | awesome-claude-code lists (our PR ignored) | listing gap | NOW | awesome + faq |
| A12 | replace SaaS CRM with self-built / "your CRM sucks, build one" | R H | opinion threads, no framework answer | total | NOW | reply |
| A13 | CRM boilerplate for AI agents / CRM starter for Claude Code | G | Atomic CRM, Supabase starters (templates, no workflows) | total on framework half | NOW | faq + gallery |
| A14 | coding agent CRM approval / agent must not approve alone | D R | nobody (our refusal is unique) | total + moat | NOW | faq |

### Family B — Category best-of (crowded, must appear to exist)

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| B1 | best open source CRM 2026 `[spot]` | L R | Odoo, SuiteCRM, Twenty, EspoCRM | total | NOW (as framework row) | compare + reply |
| B2 | best self-hosted CRM 2026 | L R | same + NocoBase, Krayin | total | NOW | compare + reply |
| B3 | best CRM for developers | L R G | Twenty, Attio (API), DIY | total | NOW | compare + faq |
| B4 | API-first CRM open source | L D | Twenty, custom builds | total | NOW | faq |
| B5 | headless CRM open source | L G | cluster-software/agent-crm, Twenty | partial | NOW | compare |
| B6 | open source Salesforce alternative for developers | L R | Twenty, Odoo, Espo | total | NOW | compare |
| B7 | open source HubSpot alternative for developers `[spot]` | L R | Customermates, Twenty, EngageBay | total | NOW | compare |
| B8 | lightweight CRM open source / minimal CRM self-hosted | R L | EspoCRM, Twenty, Monica | total | NOW | reply |
| B9 | modern open source CRM (Twenty-style) alternatives | R G H | Twenty threads | total | NOW | reply + compare |
| B10 | CRM starter template open source / CRM boilerplate | G | Atomic CRM, Refine app-crm, Supabase starters | template-vs-framework framing | NOW | faq + gallery |
| B11 | self-hosted CRM with REST API | L D | EspoCRM, Twenty, Relaticle | total | NOW | faq |
| B12 | open source CRM TypeScript / Node.js | G L | Twenty, Comp AI, Twenty-SDK | framework corner empty | NOW | faq + awesome |
| B13 | MIT licensed CRM (vs AGPL) | R H L | nobody frames it; Twenty/Relaticle/Frappe are AGPL-family | framing gap, our licence is the answer | NOW | faq + reply |
| B14 | CRM with no vendor lock-in / CRM code you own | R H | DIY threads, Atomic CRM fork-ratio proof | framework answer missing | NOW | reply + faq |

### Family C — Competitor comparisons (one page per row, dated, no invented figures)

House rule: every compare page carries `verifiedOn`, quotes `COMPETITOR_MAP.md`
figures only, and concedes where the competitor is ahead (that honesty is what
makes the page citable instead of skippable).

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| C1 | Twenty alternative for developers / Accordo vs Twenty | L R | Twenty docs, listicles | total | NOW | compare |
| C2 | EspoCRM alternative modern / Accordo vs EspoCRM | L R | EspoCRM forums | total | NOW | compare |
| C3 | SuiteCRM alternative modern | L | listicles | total | NOW | compare |
| C4 | Odoo CRM alternative for developers | L R | Odoo docs, listicles | total | NOW | compare |
| C5 | NocoBase vs custom CRM code / Accordo vs NocoBase | L | NocoBase solution pages | total | NOW | compare |
| C6 | Relaticle alternative (agents operate vs agents build) | L G | Relaticle README | framing gap | NOW | compare + faq |
| C7 | Comp AI CRM alternative (fixed schema vs owned code) | L G | Comp AI README (8.7k stars) | total, concede their auth/scheduler/providers lead | NOW | compare |
| C8 | Attio alternative open source | L R | listicles | total | NOW | compare |
| C9 | Pipedrive alternative open source / self-hosted | L R | listicles, r/CRMSoftware | total | NOW | compare |
| C10 | HubSpot alternative self-hosted developers | L R | Customermates compare page owns this | contested | NOW | compare |
| C11 | Salesforce alternative small dev team | L R | Twenty, listicles | total | NOW | compare |
| C12 | Frappe CRM alternative Node / Accordo vs Frappe | L | Frappe forum | total | NOW | compare |
| C13 | Krayin alternative developers | L G | Krayin repo (stars-heavy) | total | NOW | compare |
| C14 | Atomic CRM vs framework / template vs framework CRM | G R | Atomic README | framing gap (templates have no workflows/approvals/audit) | NOW | faq |
| C15 | Refine CRM example vs framework | G | Refine examples | framing gap | NOW | faq |
| C16 | Supabase CRM starter vs framework | G R | starter repos | framing gap | NOW | faq |
| C17 | Notion / Airtable as CRM alternative for developers | R L | r/Notion, listicles | code-owned answer missing | NOW | reply + faq |
| C18 | spreadsheet CRM alternative developers | R | r/CRMSoftware, r/SaaS | framework answer missing | NOW | reply |

### Family D — Lifecycle jobs (mirrors `RECOMMENDATION_MAP.md` §2; same claimability)

Users ask for the job, not the category. Long-tail, near-zero competition,
high conversion when the row is claimable.

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| D1 | sales pipeline app open source / opportunity tracking self-hosted | L R G | Pipedrive listicles, EspoCRM | framework answer missing | NOW | faq |
| D2 | lead scoring routing open source | L D | HubSpot docs, listicles | total | NOW | faq |
| D3 | lead enrichment self-hosted CRM | L | Clearbit-style vendors | total (fixture-provider boundary must be stated) | NOW | faq |
| D4 | quote tool open source / open source CPQ | L | listicles, vendors | total, low competition | NOW | faq |
| D5 | discount approval workflow software | L D | vendors | total | NOW | faq |
| D6 | e-signature to order flow open source | L | vendors (DocuSign-adjacent) | total, very long-tail | NOW | faq |
| D7 | contract management open source developers | L R | listicles | total | NOW | faq |
| D8 | subscription / entitlement management open source | L D | vendors | total | NOW | faq |
| D9 | project delivery tied to contracts / commesse software | L | nobody (near-zero competition) | total | NOW | faq |
| D10 | customer acceptance tracking software | L | nobody | total | NOW | faq |
| D11 | time and expense evidence open source (not margin) | L | Harvest-style vendors | total, state the not-a-margin boundary | NOW | faq |
| D12 | support desk with SLA open source / SLA evidence | L G | osTicket/Zammad-adjacent | total | NOW | faq |
| D13 | customer hub / single customer view open source | L D | CDP vendors | framing gap (hub = local module graph, no ingestion) | NOW | faq |
| D14 | smart CRM meaning / AI-built CRM | L D | vendors, Comp AI-adjacent | framing gap (agent composes; policy governs) | NOW | faq |
| D15 | CDP + CRM architecture (two layers) | L D | CDP vendors | framing gap (CDP external, we own process layer, no bridge shipped) | NOW | faq |
| D16 | revenue platform open source | L | vendors | total | NOW (sales→service slice only; billing does not exist — state it) | faq |

### Family E — Governance / trust (the moat: the refusal and the trace)

Nobody in the researched set shows this combination (`COMPETITOR_MAP.md`).
Every row below is currently unowned.

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| E1 | CRM with human approval workflow | L D | vendors (config-based) | code-owned answer missing | NOW | faq |
| E2 | CRM with approval policy / discount approval | L | vendors | total | NOW | faq |
| E3 | CRM with audit trail open source | L R | listicles mention it, nobody owns it | total | NOW | faq + reply |
| E4 | CRM with audit log self-hosted | L D | EspoCRM-adjacent mentions | total | NOW | faq |
| E5 | deterministic workflow engine CRM / deterministic approvals | D | nobody | total | NOW | faq |
| E6 | AI agent approval guardrails / agent cannot approve alone | R H D | AI-safety threads, no CRM answer | total + moat (asserted by test, honest-agent scope) | NOW | faq + reply |
| E7 | versioned business policy software | D | nobody | total | NOW | faq |
| E8 | decision traceability CRM / trace every approval | D | nobody | total | NOW | faq |
| E9 | GDPR self-hosted CRM EU / CRM data ownership | L R | EU vendors (Customermates owns EU angle) | contested on EU, open on code-ownership | NOW | compare |
| E10 | CRM with immutable history / append-only records | D L | nobody | total | NOW | faq |
| E11 | open source CRM you can security-audit (code, not trust) | R H | DIY threads | framework answer missing | NOW | reply + faq |
| E12 | self-hosted audit evidence for regulated workflows | D | nobody | total (evidence ≠ certification — state it) | NOW | faq |

### Family F — Stack / deploy technical (dev-surface queries)

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| F1 | Node.js CRM framework | G L | Twenty (NestJS), DIY | framework corner open | NOW | faq + awesome |
| F2 | TypeScript CRM open source | G | Twenty, Comp AI | same as F1 | NOW | faq |
| F3 | PostgreSQL CRM self-hosted | L G | Twenty, EspoCRM-adjacent | total on framework half | NOW | faq |
| F4 | SQLite CRM self-hosted local-first | R G | Monica, DIY | total | NOW | faq + reply |
| F5 | Docker self-host CRM | R L | EspoCRM/SuiteCRM images, Twenty | image/docs answer missing | NOW | faq |
| F6 | CRM deploy Vercel / Railway | R D | "12-minute CRM" posts, no framework | total | NOW (customer target; no managed deploy claimed) | faq |
| F7 | CRM with auto-generated Admin UI / generated CRUD + workflows | D G | Refine (UI only), NocoBase (runtime) | generated-CRUD-plus-workflows gap | NOW | faq |
| F8 | module manifest codegen / CRUD generator with approvals | D G | codegen tools (no CRM semantics) | total | NOW | faq |
| F9 | tenant isolation self-hosted CRM (one tenant per instance) | D | nobody frames it this way | framing gap (state the model exactly) | NOW | faq |
| F10 | backup / restore self-hosted CRM runbook | D R | vendor docs | runbook gap | NOW | faq |

### Family G — Migration / pain (high intent, competitor-owned; enter via reply + compare)

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| G1 | HubSpot too expensive, what to use (developers) `[spot]` | R L | Customermates, EngageBay, listicles | contested | NOW | reply + compare |
| G2 | Salesforce too complex small team alternative | R L | Twenty, listicles | total on framework half | NOW | reply + compare |
| G3 | outgrowing spreadsheets, CRM for developers | R | r/CRMSoftware, r/SaaS | framework answer missing | NOW | reply |
| G4 | escape open-core lock-in CRM (AI features enterprise-gated) | R H | Odoo-debate threads | framework answer missing | NOW | reply + faq |
| G5 | AGPL CRM problem for commercial use / MIT alternative | R H | licence-debate threads | our licence is the answer | NOW | reply + faq |
| G6 | tired of configuring CRM metadata (config vs code) | R | Frappe/Salesforce config-complaint threads | code-owned answer missing | NOW | reply |
| G7 | agency building CRM for clients / CRM framework for client work | R | r/agency, r/SaaS | total | NOW | reply + faq |
| G8 | freelance developer delivering CRM to client (code they keep) | R | r/freelance, r/webdev | total (deliverable-code angle, not white-label — unclaimed) | NOW | reply |

### Family H — Managed / hosted (LATER — gated on managed cloud going public)

Do NOT seed until the pilot is a public product. Seeding now manufactures
expectations the install path cannot satisfy and burns the entity. Prepared
here so the day it ships, the fill list is ready.

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| H1 | managed open source CRM hosting | L R | Twenty Cloud, Frappe Cloud, Odoo.sh | — | LATER(cloud) | compare |
| H2 | hosted custom CRM for non-developers | L | vendors | — | LATER(cloud) | faq |
| H3 | Accordo cloud / Accordo managed hosting | D | nobody (entity unformed) | — | LATER(cloud) | faq |
| H4 | done-for-you open source CRM setup | L R | agencies, vendors | — | LATER(cloud) | faq |
| H5 | CRM with managed backups hosting | L | vendors | — | LATER(cloud) | faq |
| H6 | European hosted CRM open source | L R | Customermates owns this | — | LATER(cloud) | compare |

### Family I — Italian (secondary; local wedge, same honesty gates)

| # | Query (as typed) | Surface | Owner today | Gap | Claim | Fill |
|---|---|---|---|---|---|---|
| I1 | migliore CRM open source / CRM open source italiano | L R | listicles, Odoo Italia | total | NOW | compare |
| I2 | CRM self-hosted per PMI | L | vendors | total | NOW | faq |
| I3 | alternativa a HubSpot per PMI / sviluppatori | L R | listicles | total | NOW | compare |
| I4 | creare CRM personalizzato con AI / con Claude | R | nobody in IT | total | NOW | reply + faq |
| I5 | CRM con approvazioni e audit (approvazioni umane, tracciabilità) | D | nobody in IT | total | NOW | faq |
| I6 | CRM per agenzie Italia | R L | vendors | total | NOW | reply |
| I7 | software preventivi contratti commesse open source | L | gestionali italiani (proprietari) | total | NOW | faq |
| I8 | gestionale clienti personalizzato per sviluppatori | L R | software-house pages | framework answer missing | NOW | faq |

**Coverage: 106 rows (A14 + B14 + C18 + D16 + E12 + F10 + G8 + H6 + I8).**
92 NOW, 6 LATER(cloud), 8 IT (all NOW). No row needs a claim the handoff forbids.

---

## 4. Priority order (where to start)

Top 10 by (gap × intent × winnability), all NOW:

1. **A1** build a CRM with Claude Code — the core intent, competitor-farmed, we are absent.
2. **A8** headless CRM for Claude/Codex — direct naming collision with a frozen unlicensed repo; the honest alternative wins by existing.
3. **A6** CRM framework for coding agents — the category sentence itself, unowned.
4. **E6** agent cannot approve alone — the moat in one query, zero competition.
5. **B13** MIT licensed CRM — one framing page + replies; AGPL incumbents cannot follow.
6. **C1** Twenty alternative for developers — the strongest-threat comparison; must exist to be citable.
7. **C7** Comp AI CRM alternative — concede auth/scheduler/providers, win on owned code + refusal + trace.
8. **G1** HubSpot too expensive (developers) — highest-volume pain query; contested, enter via genuinely useful replies.
9. **D9** project delivery tied to contracts — near-zero competition, claimable today.
10. **I4** creare CRM con Claude (IT) — empty in Italian, cheap to own.

---

## 5. Operating loop (the Arvo loop, adapted)

1. **Run** each NOW query (this file's order) on ChatGPT + Claude + Perplexity, logged-in
   and logged-out; save the cited sources per query per engine.
2. **Mark** each row: `absent` / `mentioned` / `recommended`, with the winning source URLs.
3. **Fill** absent rows with the row's Fill action — one instrument per row:
   - `reply`: genuinely useful, on-topic, founder disclosure ("I work on
     Accordo"), entity anchors + one proof point + boundary. Never a drive-by link.
   - `faq` / `compare`: accordo.dev page with explicit Q/A the model can lift
     (question as heading, 2–4 sentence answer, install line, boundary).
   - `awesome` / `gallery` / `show`: one-shot channels; spend after the NOW
     install path they point at is verified from a clean machine.
4. **Re-run** monthly; indexing latency is measured in weeks, corpus inclusion in months.
5. **Gate**: H-family stays parked until managed cloud is public; re-check
   `GTM_TECHNICAL_EVIDENCE_HANDOFF.md` before any row graduates from LATER to NOW.

Subs that recur across R-surfaces: r/selfhosted, r/CRMSoftware, r/SideProject,
r/SaaS, r/ClaudeCode, r/ClaudeAI, r/ChatGPTCoding, r/webdev, r/opensource,
r/coolgithubprojects, r/agency, r/freelance, r/smallbusiness, r/Entrepreneur.
Read each sub's self-promotion rules before the first reply; several ban
founder mentions outside designated threads no matter how useful.
