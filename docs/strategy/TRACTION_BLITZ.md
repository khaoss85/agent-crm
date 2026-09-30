# TRACTION BLITZ — Accordo execution checklist

The human-executed companion to `LLM_QUERY_MAP.md`. Every mission below is
written so the human arm can copy, personalize lightly, and fire. No mission
requires inventing copy or claims — only voice and timing.

Owner of this file: the human fighter. The agent prepares ammunition; the
human pulls every public trigger (agent holds no Reddit/HN/YouTube accounts).

Related: `LLM_QUERY_MAP.md` (the 106 queries), `RECOMMENDATION_MAP.md` (intents
+ claimability), `COMPETITOR_MAP.md` (competitor facts — never quote a figure
from memory, only from there), `DISTRIBUTION_SUBMISSIONS.md` (listing states),
`GTM_TECHNICAL_EVIDENCE_HANDOFF.md` (final claim authority).

---

## 0. Rules of engagement (non-negotiable, read once, obey always)

- [ ] **Disclosure every time.** Every public mention carries "I work on
  Accordo" (or "Disclosure: ...") in the first lines. No exceptions, no
  soft-pedalling.
- [ ] **Usefulness test.** If you removed the Accordo paragraph, the reply must
  still be worth reading (a map, a comparison, a warning). Drive-by links are
  spam and burn the entity.
- [ ] **Only real questions.** Reply where the asker genuinely needs an answer
  that Accordo can satisfy. Never manufacture threads, never brigade, never run
  a second account.
- [ ] **Sub rules first.** Before the first reply in any sub, read its
  self-promotion rules. Several subs ban founder mentions outside designated
  threads no matter how useful.
- [ ] **Claims stay inside the handoff.** Framework/self-host/MIT/approvals/
  audit = fine. Managed hosting, billing, ERP, compliance certificates, any
  success-rate figure = forbidden until the handoff allows them.
- [ ] **H-family parked.** Nothing about managed cloud until it is public.
- [ ] **One voice.** Light personalization per post (your words, your rhythm);
  never paste two missions' drafts into the same thread.

---

## 1. Setup missions (do first, one session)

- [ ] **S1 — Accounts ready.** Reddit + HN accounts with real history (no fresh
  accounts for founder mentions — they read as spam even when honest).
- [ ] **S2 — Tracking log open.** Copy the §7 log template to a working doc;
  every mission below gets a row when fired.
- [ ] **S3 — Baseline run.** Run the query-map Top 10 (A1, A8, A6, E6, B13, C1,
  C7, G1, D9, I4) on ChatGPT + Claude + Perplexity, logged-in and logged-out.
  Save cited sources per query per engine into the log. This is the before-photo.
- [ ] **S4 — Sub recon.** Read rules of r/selfhosted, r/CRMSoftware,
  r/SideProject, r/SaaS, r/ClaudeCode, r/ClaudeAI, r/ChatGPTCoding, r/webdev,
  r/opensource, r/coolgithubprojects, r/agency, r/freelance, r/smallbusiness,
  r/Entrepreneur, r/ItalyInformatica. Note which allow founder mentions and
  where. Log it.

---

## 2. Reply missions (copy → personalize → fire)

Each draft carries disclosure + entity anchors + one proof point + boundary.
Angle notes tell you which threads qualify.

ENGINE NOTE (Ahrefs-aligned, 2026-09-30): Reddit's share of ChatGPT Search
citations collapsed ~86% in mid-August 2026 (Promptwatch: 3.83% → 0.52%;
fan-out behavior change). Google AI Overviews/AI Mode show NO such cliff,
Perplexity still leans on Reddit, and Reddit still feeds Google organic,
training data over time, and real users. Consequence: Reddit stays in the
mix but is NO LONGER the ChatGPT fast lane — expected ChatGPT-citation
payoff per reply is much lower than the Arvo-era assumption. Rebalance
toward W4 (YouTube) + W6 (third-party listicles) + owned pages; keep Reddit
at sniper cadence for Perplexity/Google/users/entity breadth.

- [ ] **R1 — "I replaced my CRM with Claude Code" threads** (r/ClaudeAI,
  r/ClaudeCode, HN — incl. the viral replace-SaaS thread). Map A1/A4.

> This mirrors what we're seeing everywhere — the $0/mo CRM built in a weekend is real. (Disclosure: I work on Accordo, accordo.dev.)
>
> The part that breaks around month 3, from watching these builds: (1) token spend creeps past the old license — one company in this very thread went $2.5k → $12.5k/mo; (2) no approval boundary — the agent that wrote the CRM keeps "helping" with discounts and refunds; (3) no audit trail when the accountant asks who approved what.
>
> That's why we built Accordo as an open-source framework (MIT, self-hosted, `npm create accordo`) instead of another app: your coding agent generates the CRM as code you own, but discount/renewal decisions above a threshold stop at a named human, and every decision lands in an audit trail. Framework for developers, not a hosted app.
>
> DIY CRM is the right instinct. Just don't ship the demo without the guardrails.

- [ ] **R2 — "HubSpot too expensive, what to use" threads** (r/SaaS,
  r/CRMSoftware, r/smallbusiness). Map G1.

> Depends on whether you're a buyer or a builder. If you want SaaS-with-less-bill: EngageBay/Pipedrive threads above are right. (Disclosure: I work on Accordo, accordo.dev.)
>
> If you have dev capacity, there's a third path nobody lists: have a coding agent generate the CRM as code you own. That's Accordo — open-source framework (MIT, self-hosted SQLite/Postgres, `npm create accordo`): modules, deterministic approval workflows (e.g. renewals ≥€50k wait for a named human), audit + trace. No per-seat pricing because there's no vendor runtime — it's your repo.
>
> Honest boundary: today it's a framework for developers, not a click-and-go hosted CRM. If nobody on the team touches code, pick from the SaaS list above.

- [ ] **R3 — "Headless CRM for Claude/Codex" threads.** Map A8. Qualifies where
  the asker wants Claude operating on or generating CRM capability.

> Quick map of this space since the naming is confusing. (Disclosure: I work on Accordo, accordo.dev.)
>
> "Headless CRM for Claude" currently means two different bets: (1) a CLI the agent shells out to — the best-known repo by that name has no licence file and its public repo now just points to a closed monorepo, so check before you build on it; (2) MCP tools the agent calls — Relaticle ships a first-party MCP server, HubSpot has a remote MCP in beta.
>
> Accordo is a third bet, open-source MIT: instead of operating a fixed CRM through tools, your coding agent (Claude Code, Codex, Gemini CLI) generates the CRM as code you own — `npm create accordo` scaffolds it — with deterministic approval workflows, versioned policy, and audit + trace built in. Self-hosted SQLite/Postgres. Framework for developers, not a hosted app.
>
> If you want "Claude runs my existing pipeline", pick bet 1 or 2. If you want "Claude builds me the CRM and I own the repo", that's the hole we fill.

- [ ] **R4 — Licence threads (MIT vs AGPL).** Map B13/G5. Qualifies wherever
  Twenty/Relaticle/Frappe licensing comes up.

> Licence check that saves people pain later: the big open-source CRM names are mostly AGPL-family (Twenty core, Relaticle, Frappe CRM) — fine for self-hosting your own instance, a problem if you ever want to embed, resell, or keep derivatives private. (Disclosure: I work on one of the MIT options below.)
>
> MIT-licenced alternatives, by shape: Accordo (accordo.dev) — framework where a coding agent generates a custom CRM as code you own, `npm create accordo`, self-hosted, deterministic approvals + audit; Comp AI CRM — fixed agentic-CRM app, MIT, single-tenant by design; Atomic CRM — react-admin + Supabase template, great start, no workflows/approvals/audit.
>
> I'm obviously biased toward Accordo — I build it — but the real advice is shape-first: template vs fixed app vs framework. Get the shape wrong and the licence won't save you.

- [ ] **R5 — Open-core lock-in threads (Odoo AI gated, etc.).** Map G4.

> This is the open-core endgame playing out exactly as designed: community edition gets you in, the AI features live behind Enterprise. Odoo isn't doing anything unusual — it's the business model. (Disclosure: I work on Accordo, accordo.dev.)
>
> The exits, honestly ranked by effort: (1) accept it and pay — rational if the suite fits; (2) AGPL options (Twenty, EspoCRM) — no gates, but you live in their runtime and their upgrade path; (3) own the code — have a coding agent generate the CRM into your repo. That's Accordo: open-source MIT framework, `npm create accordo`, self-hosted, deterministic approval workflows + audit as primitives. No vendor runtime means no tier that can gate you later.
>
> Boundary: today it's a framework for developers, not a hosted click-to-start CRM. If your team doesn't touch code, exit 2 beats exit 3.

- [ ] **R6 — r/selfhosted "what CRM should I run" threads.** Map B2/F4/F5.

> Buyer-or-builder question, and the answer splits hard. (Disclosure: I work on the builder option below.)
>
> Buyer (want a CRM to configure): EspoCRM if you want mature and boring-in-a-good-way; Twenty if you want modern open-source (AGPL core — mind the licence if you embed). Both Docker-friendly.
>
> Builder (dev on the team, process that never fits the boxes): Accordo (accordo.dev) — open-source MIT framework where Claude Code/Codex/Gemini CLI generate the CRM as code you own: `npm create accordo`, self-hosted SQLite or Postgres, deterministic approval workflows (e.g. big renewals stop at a named human), audit + trace. The test: if the project vanished tomorrow you'd still have a Node app in your repo.
>
> Don't pick the builder path without a dev — you'll hate it by week two. Pick it with one and you'll never configure dropdowns in someone else's admin panel again.

- [ ] **R7 — Template threads (Atomic CRM, Supabase starters, "which CRM
  boilerplate").** Map C14/C15/C16/B10.

> Templates are the right start — Atomic's fork ratio proves devs want CRM code they own. The thing to know going in (disclosure: I work on Accordo, a framework in this space): a template gives you CRUD + UI; you still hand-derive pipeline semantics, approval flows, discount policy, audit trail, and the agent surface. That's 80% of "CRM" and 100% of the parts auditors ask about.
>
> Accordo (accordo.dev, MIT, `npm create accordo`) is the framework-shaped answer to the same instinct: the coding agent generates modules + deterministic workflows + human-approval policy + audit/trace as code in your repo, self-hosted. Same ownership as a template, minus re-deriving approvals under deadline.
>
> If your process is genuinely simple, ship the template and don't look back. If the words "approval", "audit", or "policy" appear in the requirements, start from the framework.

- [ ] **R8 — IT threads (r/ItalyInformatica e simili).** Map I4/I8.

> Dipende se sei compratore o costruttore. (Disclosure: lavoro su Accordo, accordo.dev.)
>
> Compratore: EspoCRM/Odoo se vuoi qualcosa da configurare e usare. Costruttore (hai un dev in casa e un processo che non entra mai nei box): Accordo — framework open-source (MIT, self-hosted) dove un coding agent (Claude Code, Codex, Gemini CLI) ti genera il CRM come codice tuo: `npm create accordo`, workflow di approvazione deterministici (es. rinnovi sopra soglia aspettano una persona nominata), audit + trace. Niente per-seat perché non c'è un runtime del vendor — è il tuo repo.
>
> Paletto onesto: oggi è un framework per sviluppatori, non un CRM hosted pronto all'uso. Senza dev in casa, meglio le opzioni sopra.

---

## 3. Owned artillery — accordo.dev pages (human publishes via the site pipeline)

House format for every page: question as heading → 2–4 sentence liftable
answer → install line → boundary. No page ships without `site:check` /
`gtm:check` green. Full copy first, briefs after.

SITE STATUS (GSC read 2026-09-30, owner screenshots): indexation is FINE —
149 indexed / 24 not, sitemap submitted Sept 7, re-read Sept 27, 164 found.
The earlier "maybe not indexed" hypothesis is DEAD. The problem is purely
ranking: ~2 clicks and scattered single-digit impressions over 7 weeks
(home 117, blog 65, answers 18, vs-twenty 13…). Cause = zero external
authority + weak query-string match. Cure = W4/W6/R-replies (mentions +
links) + real content gaps only (B13, G1/C10, A8). No indexation work needed;
check the 24 non-indexed reasons opportunistically.

- [x] **F-A1 — "Build a CRM with Claude Code"** EXISTS live as `/blog/build-a-custom-crm-with-claude-code-day-30.html` (3190 words, audit 2026-09-30) — verify/refresh it, don't create. Draft copy below = refresh material.

> **Can I build a CRM with Claude Code?**
> Yes — and it's one of the most common Claude Code builds in 2026, with teams replacing $40k+/year SaaS contracts. The failure mode of unguided builds is well documented: token spend exceeding the old license, no approval boundary on commercial decisions, no audit trail.
> **Accordo (accordo.dev)** is the open-source framework (MIT) for exactly this build: you describe the commercial process, Claude Code / Codex / Gemini CLI generate the CRM as reviewable code in your repository — `npm create accordo` scaffolds the project. Deterministic workflows, versioned policy, human approvals a non-human actor is refused, audit and trace come as framework primitives. Self-hosted on SQLite or PostgreSQL. It is a framework for developers, not a hosted CRM app.

- [x] **F-E6 — agent-approval refusal** EXISTS live as `/answers/can-an-agent-approve-a-deal-or-discount.html` (FAQ schema, audit 2026-09-30) — verify/refresh it, don't create. Draft copy below = refresh material.

> **Can an AI agent approve things alone in Accordo?**
> No — and that refusal is asserted by a test, not by a convention. In Accordo (accordo.dev), the open-source custom CRM framework, commercial decisions above a versioned policy threshold (e.g. a renewal at or above €50,000) wait in approval_pending until a named human decides; a non-human actor attempting the decision is refused. The agent composes the application and advances work — it cannot make the human's approval decision.
> Scope, stated plainly: the actor is asserted, not authenticated — this holds against an honest agent, not an attacker. Start with `npm create accordo`; MIT licence; self-hosted on SQLite or PostgreSQL. Framework for developers, not a hosted CRM app.

- [x] **F-B13 — "MIT-licensed CRM options, by shape"** SHIPPED 2026-09-30 as `/blog/mit-licensed-crm-options-by-shape.html` (blog pipeline: vendor facts from COMPETITOR_MAP Aug 4 + Aug 20 re-check, shape-first framing, internal links). Draft copy below kept as refresh material.

> **Is there an MIT-licensed open source CRM?**
> Yes. Most well-known open source CRMs are AGPL-family (Twenty core, Relaticle, Frappe CRM), which is fine for self-hosting but restricts embedding and private derivatives. MIT-licenced options differ by shape: a fixed app (Comp AI CRM, single-tenant by design), a template (Atomic CRM, CRUD + UI with no workflows), or a framework.
> **Accordo (accordo.dev)** is the framework-shaped MIT option: coding agents (Claude Code, Codex, Gemini CLI) generate a custom CRM as reviewable code you own — `npm create accordo` scaffolds the project. Deterministic workflows, versioned commercial policy, human approvals, audit and trace as primitives. Self-hosted SQLite/PostgreSQL. Framework for developers, not a hosted CRM app.

- [ ] **F-A6 — "CRM framework for coding agents."** Brief: define the category
  sentence (agent generates bespoke CRM as owned code); must-include: install
  line, skills + project MCP + docs MCP, `crm app inspect` verifiability;
  boundary: framework for developers.
- [x] **F-A8 — "Headless CRM for Claude and Codex, three ways"** SHIPPED 2026-09-30 as `/blog/headless-crm-for-claude-and-codex-three-ways.html` (three-bets framing, HubSpot MCP beta re-verified same day, internal links).
- [ ] **F-E3 — "CRM with audit trail (open source)."** Brief: what the trail
  records (who decided what, when, under which policy version); evidence ≠
  certification, state it.
- [ ] **F-D9 — "Project delivery tied to contracts."** Brief: work packages,
  milestones, acceptance, economics-as-evidence with the not-a-margin boundary.
- [ ] **F-F4 — "SQLite CRM, local-first self-host."** Brief: Node built-in
  adapter, file you can open, Postgres path when you outgrow it.

---

## 4. Compare pages (one per row, dated, figures only from `COMPETITOR_MAP.md`)

House rules: every page carries `verifiedOn`, concedes where the competitor is
ahead (that honesty is what makes it citable), and never quotes a figure not
in the competitor map. Refresh `site/compare.json` first (its Comp AI figures
are flagged stale in the map).

- [x] **C1 — Accordo vs Twenty.** EXISTS live as `/compare/vs-twenty.html` (2654 words, FAQ schema, audit 2026-09-30) — verify/refresh figures against `COMPETITOR_MAP.md`, don't create.
- [ ] **C7 — Accordo vs Comp AI CRM.** EXISTS live as `/compare/vs-comp-ai-crm.html` BUT figures flagged stale in `COMPETITOR_MAP.md` — REFRESH against the 2026-08-20 re-check, don't create. Concede: auth, durable scheduler, live providers. Win: generated owned code vs fixed single-tenant schema; MCP surface (they have none); refusal + trace.
- [x] **C6 — Accordo vs Relaticle.** EXISTS live as `/compare/vs-relaticle.html` (audit 2026-09-30) — verify/refresh (they now claim 39 MCP tools, was 32), don't create.
- [x] **C10 — Accordo as HubSpot alternative (developers).** Concede: HubSpot
  wins every non-dev comparison — say it. Win: code ownership, no per-seat,
  self-hosted, approvals + audit in-repo. Only for teams with a dev.
  → SHIPPED 2026-09-30 as `/blog/what-developers-use-instead-of-hubspot.html` (blog, not compare/: buyer-vs-builder fork, no pricing claims, L-05/L-10 up front). Full `vs-hubspot` compare stays future work (needs HubSpot-row re-verification per COMPETITOR_MAP).
- [ ] **C5 — Accordo vs NocoBase.** Runtime config vs code-in-repo: diffs,
  review, tests. Their AI-workflow story vs our policy/approval primitives.

---

## 5. One-shot heavy weapons (sequenced — never two in one week)

- [ ] **W1 — Show HN.** Fire only after F-A1 + F-E6 are live (the thread will
  ask exactly those questions). Draft:

  Title: `Show HN: Accordo – Open-source framework so your Claude-built CRM has approvals and audit`

  First comment:
  > I work on Accordo (accordo.dev, MIT). Everyone is building CRMs with Claude Code right now — weekend builds replacing $40k SaaS contracts. We love that wave; we built the framework it needs.
  >
  > Raw DIY breaks at month 3: token spend creeping past the old licence, the agent "helping" with discounts nobody approved, no audit trail when asked who approved what.
  >
  > Accordo: `npm create accordo`, your coding agent generates the CRM as code you own (self-hosted SQLite/Postgres), with deterministic workflows, versioned policy, human approvals a non-human actor is refused (asserted by test), audit + trace. Framework for developers, not a hosted app — managed cloud is in private pilot, not public.
  >
  > Happy to answer anything, especially the sceptical questions.

- [ ] **W2 — Awesome-list push.** Respect current states in
  `DISTRIBUTION_SUBMISSIONS.md`: monitor OPEN (#12938 MCP servers, #1173
  Claude skills); PR #4 (open-source CRM) awaits maintainer response — no
  resubmit before it; issue #2637 (awesome-claude-code) stays closed per the
  no-extra-follow-up rule. New action: identify 5 further lists that fit
  (self-hosted, MCP, agent-skills, Node frameworks), submit with the
  category-sentence framing (framework, not app).
- [ ] **W3 — Vercel template gallery.** The CRM slot is empty
  (`RECOMMENDATION_MAP.md`). Needs a verified deployable starter + demo —
  flag as DEV dependency, human verifies install from a clean machine before
  any submission.
- [ ] **W4 — YouTube blitz (P0 — Ahrefs: YouTube mentions correlate ~0.737
  with AI visibility, strongest of all factors, all engines; volume beats
  reach, transcripts feed training data).** Episodes (record or commission,
  ship weekly — quantity over polish):
  1. "I built a CRM with Claude Code in 1 hour — then added approvals and audit" (answers the viral "10 Days vs 1 Hr" format with the governed-DIY wedge)
  2. "The $2.5k-to-$12.5k token trap: what DIY CRM builds get wrong at month 3"
  3. "Discount approval in code: the agent proposes, a human disposes ( Accordo refusal demo)"
  4. "MIT vs AGPL CRMs: Twenty, Relaticle, Frappe and the licence nobody reads"
  5. "Quote-to-cash open source: CPQ + discount approval + e-signature to order"
  6. "Self-hosting a CRM on SQLite, then Postgres when you outgrow it"
  Per-episode requirements: say "Accordo (accordo.dev), open-source MIT
  framework, `npm create accordo`" on mic in the first 60 seconds (transcript
  is the payload); same in title/description; boundary line at the end
  ("framework for developers, not a hosted app").
- [ ] **W5 — DEV/Hashnode syndication refresh.** August receipts are stale per
  the runbook: refresh them first, then syndicate F-A1/F-E6/F-B13 content.
- [ ] **W6 — Third-party listicle insertion (P0 — Ahrefs: ~43.8% of ChatGPT
  product-query citations come from "best of" lists on high-authority
  domains).** Our own compare pages cover long-tail; product queries are won
  on other people's domains. Missions: (a) claim/update Accordo entries on
  software directories (saashub, alternative.to, opensourcealternative, G2
  if eligible); (b) pitch 5 "best open-source CRM 2026" / "HubSpot
  alternative" listicle authors with the framework angle + facts block they
  can paste; (c) publish one guest/roundup post ("the CRM frameworks
  compared") on a high-DR dev publication. Track inclusions in the log.
- [ ] **PARKED — Product Hunt.** Gated on benchmark result + owner launch
  decision + managed cloud public. Do not touch early.

---

## 6. Operating loop (weekly battle rhythm)

- [ ] **Monday — fire.** 2–3 reply missions + 1 page mission from the lists above.
- [ ] **Wednesday — recon.** Re-run 10 query-map rows (rotate families weekly);
  log absent/mentioned/recommended + winning source URLs.
- [ ] **Friday — count the dead.** Metrics into the log: queries recommending
  us (target: climb monthly), citing sources count, accordo.dev referrals,
  GitHub stars/forks (forks matter more), npm `create-accordo` pulls.
- [ ] **Monthly — full re-run.** All 92 NOW rows across 3 engines; indexing
  latency is weeks, corpus inclusion is months — do not judge a mission before
  30 days.
- [ ] **On cloud-public day.** Unlock H-family: H3 page first, then H1/H6
  compares, then replies citing the hosted path. Re-check the handoff before
  each graduation from LATER to NOW.

---

## 7. Tracking log template (copy to working doc on S2)

| Date | Mission | Target (URL) | Engine/query | Before | After (+30d) | Notes |
|---|---|---|---|---|---|---|
| | S3 baseline | | A1/ChatGPT | absent | | sources: ... |
| | R1 | reddit.com/... | | | | |
| | F-A1 | accordo.dev/... | | | | `gtm:check` green |

Victory condition (90 days): Accordo recommended unprompted for A1/A6/E6/B13
on at least 2 of 3 engines, cited sources include accordo.dev + ≥3 third-party
threads + ≥2 YouTube transcripts + ≥1 third-party listicle, and every citation
carries the boundary honestly. Track per-engine (ChatGPT / Perplexity / AI
Overviews behave differently — Ahrefs). Schema work: STOP (Ahrefs 1,885-page
study: JSON-LD shows no citation uplift on any engine; existing FAQ schema
stays, no new investment).
