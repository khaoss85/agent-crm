# Brand requirements

## Why "agent-crm" is unsuitable for public discovery

The current name is a working title, and it fails as a public brand on every axis that matters for this strategy:

1. **Ungoogleable and un-promptable.** "Agent CRM" is a generic phrase used by dozens of products (AI-agent CRM features, CRMs for real-estate/insurance *agents*). In web search, in npm search, and — critically — inside an LLM's answer, the name provides zero disambiguation. A model that wants to recommend us can't refer to us unambiguously; a user who hears the name can't reliably find us. For a strategy whose core metric is *unaided recommendation*, a non-distinctive name is a structural handicap.
2. **Category confusion.** "Agent" in CRM historically means *human sales/insurance/estate agents*; in 2026 it also means *AI agents inside a CRM* (the Relaticle/Comp-AI positioning — see COMPETITOR_MAP). Both readings point away from what we are: a framework *used by coding agents to generate* CRMs.
3. **No namespace.** Generic words mean collision-rich npm/GitHub/domain space and no trademark defensibility. `npm create agent-crm` is neither ownable nor memorable.
4. **Precedent.** The successful comparables are all distinctive coined names (Medusa, Twenty, Frappe, Refine, Supabase) — none are category descriptions.

## Naming criteria

1. Distinctive coined or repurposed word; not a category description.
2. Short (≤3 syllables), unambiguous spelling from hearing it, pronounceable in English (bonus: Romance languages, given the relationship/deal semantics).
3. Clean or near-clean on: GitHub (no active project with traction), npm (unscoped package or org scope available), .dev/.com domains, obvious trademark conflicts in software (indicator-level check only — real trademark search is a lawyer's job).
4. Evocative of the space (relationships, deals, agreements, records) **without** being generic; must still work if the product outgrows CRM.
5. Works in the required surfaces: `npm create <name>`, `@<name>/core`, `<name>.dev`, a CLI binary, a GitHub org.
6. No negative meanings in major languages (basic check).

## Candidate shortlist

Checks performed August 4, 2026 from this environment: npm registry lookups (`registry.npmjs.org/<name>` — 404 = name free), GitHub repo-name searches via API, DNS resolution as a weak domain signal (RDAP was not reachable through this environment's proxy — **domain findings are indicative, not authoritative; re-verify with a registrar before deciding**). Trademark notes are obvious-indicator level only.

### 1. Pactio (from *pactum/pactio*, Latin: an agreement)

- npm: **free** (404). GitHub: only tiny inactive repos (largest match 0–5 stars; a Python "unbreakable contracts in Django" repo with 0 stars). Domain: `pactio.dev` does not resolve (likely free); `pactio.com` resolves (taken).
- Trademark indicators: a UK legal-tech company "Pactio" (legal ops AI) exists in search results — same broad software space, **real conflict risk to investigate before use**.
- Pronunciation: PAK-tee-oh — easy. Memorability: high. Relevance: deals/agreements/pacts — exactly the CRM semantic core (deterministic *agreements* is on-brand). Not generic.

### 2. Relato (Italian/Spanish-rooted; "relation/account of events")

- npm: **free** (404). GitHub: 8 name matches, all unrelated and small (a Ruby bibliographic project "Relaton" is adjacent-spelled but distinct). Domain: `relato.dev` **resolves — taken**; `relato.com` taken.
- Trademark indicators: no dominant software product found under this exact name; common word in Spanish/Portuguese ("story"), which weakens ownability in those markets.
- Pronunciation: reh-LAH-toh — easy. Memorability: good. Relevance: *relationship* root is the CRM word. Domain situation is the weak point.

### 3. Accordo (Italian: "agreement"; also a musical chord)

- npm: **free** (404). GitHub: essentially clean (one 7-star music-ML notebook "accordo.ai"). Domain: `accordo.dev` does not resolve (likely free); `accordo.com` DNS timeout — **unverified, assume contested**.
- Trademark indicators: "Accordo Group" was an IT asset-management consultancy (acquired years ago); low but nonzero software-adjacent history. A music app "Accordo" may exist.
- Pronunciation: ah-KOR-doh — easy, warm. Memorability: high. Relevance: agreements/deals; "accord" reads in English too. Strong candidate.

### 4. Vinculo (Spanish *vínculo*: "bond/link")

- npm: **free** (404). GitHub: clean (one unrelated 9-star Brazilian data repo). Domain: `vinculo.dev` does not resolve (likely free); `vinculo.com` ENODATA — ambiguous, **verify with registrar**.
- Trademark indicators: nothing dominant found in software.
- Pronunciation: VIN-koo-loh — three syllables, slightly harder for English speakers (accent-mark spelling variants: vínculo vs vinculo). Memorability: medium-high. Relevance: bonds/links between people and companies — precisely CRM's object graph.

### Checked and rejected

- **Trato** (Spanish: "deal") — npm name **taken** (200). Rejected on criterion 3.
- **Cordia**, **Stipula**, **Tessera** — npm names **taken** (200). Rejected.
- Mythology names (Medusa-style: Hermes/Mercury etc. for commerce) — the commerce god namespace is saturated in software; no clean candidate found worth listing.

## Recommendation posture (no decision made here)

Ranked by overall cleanliness: **Accordo** (cleanest collision profile, strong semantics, easy pronunciation), **Pactio** (best npm/GitHub position but a live legal-tech namesake to clear first), **Vinculo** (clean but weakest English pronunciation), **Relato** (blocked on domains).

Before any choice, a human must:

1. Re-verify domains with a registrar (this environment could not reach RDAP; DNS non-resolution is not proof of availability).
2. Commission a real trademark screen (at minimum EUIPO + USPTO classes 9/42) for the finalists — especially Pactio vs the legal-tech company.
3. Say the names aloud to five people and ask them to spell them (the cheapest naming test that catches the most failures).
4. Register defensively on selection: GitHub org, npm org scope *and* unscoped package, .dev + .com (or an accepted alternative TLD), social handles.

**Per the task rules, no rename is performed and no name is chosen in this document.** The repository keeps `agent-crm` as its working title until a human decides.
