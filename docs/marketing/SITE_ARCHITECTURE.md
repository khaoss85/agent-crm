# Public site architecture

This is the contract for accordo.dev. `scripts/site-build.js` implements it and `scripts/site-check.js` enforces the claim, linking, indexing and stale-negative boundaries.

## 1. Two truth layers

**Product Truth** is durable: category, promise, audiences, jobs, target workflows, ownership, extension model and agent experience. It powers the homepage, product, solutions, how-it-works and recommendation journeys. It may describe the coherent product being built, but it never asserts that a target job is implemented.

**Repository Truth** is commit-bound: capabilities actually composed, executable evidence, limitations, benchmark results, distribution and deployment posture. `docs/repository-truth.json`, `site/claims.json`, the JTBD coverage overlay and benchmark result records power evidence surfaces. A capability sentence on a public product page resolves from the claims ledger; a desired JTBD never promotes itself.

Volatile facts do not belong in a product template. Authentication-verifier state, authorization, tenant isolation, storage, distribution, measurements and benchmark values are generated or ledger-bound. `scripts/site-check.js` rejects the retired composite that conflated authentication, tenancy and RBAC.

## 2. Four audience layers

| Layer | Primary journey | Surfaces |
|---|---|---|
| Human product experience | home → product/solution → how it works → proof → start | `/`, `/product.html`, `/solutions.html`, solution pages, `/developers.html` |
| Search and answer retrieval | intent → canonical topic → related concept → evidence → machine alternative | capability, concept, comparison, answer, job and glossary clusters |
| Coding-agent execution | discovery → canonical definition → agent guide → machine corpus → inspect/plan/build/prove | `/for-ai-agents.html`, `/llms.txt`, `/llms-full.txt`, `/tools.html`, Docs MCP |
| Engineering evidence | claim → capability → test/benchmark → limitation → repository SHA | `/proof.html`, `/evidence.html`, `/claims.json`, `/jobs.json`, `/version.json` |

Human navigation is intent-led: Product, Solutions, How it works, Developers, For AI agents, Resources and GitHub. Retrieval clusters remain crawlable and linked from Resources; existing URLs are retained.

## 3. Source and generation contract

- `site/brand.json`: entity, name, domain, licence, publication and ownership mechanism.
- `site/templates/`: durable human Product Truth; implementation claims must use `{{claim:*}}` or `{{limitation:*}}` tokens.
- `site/capabilities.json`, `tools.json`, `concepts.json`, `compare.json`, `glossary.json`, `answers.json`: evidence-bound retrieval authorities.
- `docs/jtbd/catalog/`: desired jobs. `docs/jtbd/coverage/`: current evidence conclusions. They are never interchangeable.
- `site/claims.json`: public implementation claims, evidence, limitations and measured SHA.
- `docs/benchmarks/` and `benchmarks/`: protocols, fixtures and results. No result is public without provenance.
- `scripts/site-build.js`: HTML, sitemap, robots, JSON artifacts, Markdown cluster mirrors and deployment `version.json`.
- `scripts/generate-llms.js`: machine summaries generated from the same authorities.

## 4. Linking, canonical and machine relationships

Every strategic page has one intent, unique title/description, one H1, absolute canonical URL, OpenGraph metadata and real initial HTML. Existing retrieval spokes link to their hubs and evidence. Product pages link progressively into proof rather than forcing evidence mechanics above the fold. `head.html` exposes llms, jobs, claims, RSS and deployment provenance alternatives. Markdown spokes are generated from the same JSON as HTML; duplicate manual copies are forbidden.

`.html` remains canonical because existing URLs and file-based screenshot checks depend on it. Clean URLs are not introduced. The sitemap is derived from emitted pages, internal links are checked against emitted output, and robots follow public repository status.

## 5. JTBD and benchmark chain

A human solution page must show: persona + trigger → desired outcome → target workflow → relevant capability → current evidence/limitation → benchmark only when available. Desired catalogue inclusion is research, not proof. Coverage may move only through the JTBD evidence gate.

Public numeric benchmarks require: measurement, buyer relevance, scenario/fixture, environment, source SHA, agent/model when relevant, baseline, date, method, limitations, reproduction command and evidence. Engineering, agent and product benchmarks are labelled separately; synthetic evidence is never a customer outcome. In the absence of equivalent measurements, comparisons cover process, architecture, responsibility, ownership and verification without invented competitor numbers.

## 6. Deployment freshness

Every build emits `/version.json` with `provenanceContract`, repository and exact source SHA. Vercel supplies `VERCEL_GIT_COMMIT_SHA`; local builds use HEAD. Comparing the deployed artifact with expected main makes source/deployment drift detectable without secrets. Production alias and branch configuration remain account-level state and require a human with Vercel access to verify or change.
