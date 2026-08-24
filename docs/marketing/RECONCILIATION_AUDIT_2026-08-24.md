# Product truth and public-surface reconciliation audit — 2026-08-24

Inspected repository HEAD: `82371d28509e3c8c7e8c857a30cf68d671f95563`. GitHub showed open PR #119 (`feat(spine): begin M1 SQLite storage contract slice`, head `ba9710fa…`) against that commit; it is parallel runtime work and none of its unmerged claims are predicted here. Recent merged PRs #117–118 establish the Production Spine v2 M0 characterization and measurement baseline.

| Surface | Finding | Class | Resolution |
|---|---|---|---|
| Live accordo.dev homepage | Served the retired composite “no authentication, tenancy or RBAC exists” while current truth separates an absent framework verifier, enforced authorization and one-tenant-per-instance isolation | STALE_NEGATIVE, DEPLOYMENT_DRIFT | Removed current literals, added stale-negative gate, and added source-SHA `version.json` |
| Live deployment | No public artifact identified the source commit; headers alone could not establish the Vercel branch or production alias | DEPLOYMENT_DRIFT | Build now emits provenance; account branch/alias remains a named human check |
| `MASTER_PLAN.md` | Repeated chosen-name, confirmed-license, milestone and distribution facts as pending/current state | ROADMAP_DRIFT, STALE_NEGATIVE | Reduced current-state section to stable architecture and delegated volatility to status/truth authorities |
| `GO_TO_MARKET.md` | Mixed dated launch preparation, already-published distribution, old blocker language and current operations | POSITIONING_DRIFT, DISTRIBUTION_DRIFT | Current website and architecture no longer source state from it; volatile state is explicitly delegated and current operating sections are evidence-led |
| Category comparison | Described ownership as a normal framework dependency | POSITIONING_DRIFT | Corrected to vendored source and merge-based upgrades |
| Homepage | Led with rails, exit codes, counts and falsification before explaining the product | UX_INFORMATION_ARCHITECTURE_DRIFT | Rebuilt as human product narrative with progressive proof |
| Global navigation | Retrieval taxonomy was the buyer navigation | UX_INFORMATION_ARCHITECTURE_DRIFT | Replaced with Product/Solutions/How it works/Developers/For AI agents/Resources; kept retrieval URLs |
| JTBD public surface | Full evidence catalogue was the dominant human route | JTBD_DRIFT | Added four outcome-led solution groups while retaining the desired/evidence distinction |
| Benchmarks | Engineering suite measurement was visually adjacent to product value; no coherent buyer-question layer | BENCHMARK_DRIFT | Added proof page and benchmark contract; no new numeric result published |
| Agent discovery | Strong llms/tools corpus lacked one canonical selection and execution page | SEO_AEO_DRIFT | Added `/for-ai-agents.html` with recommendation/refusal criteria, real commands and copyable prompt |
| SEO/AEO | Human strategic pages and intent-led internal links were absent | SEO_AEO_DRIFT | Added canonical strategic pages, metadata, sitemap inclusion and machine alternatives |

No stale positive numeric benchmark was found in the public site: the benchmark remains unexecuted where the canonical protocol says so. The major stale positive pattern was older GTM distribution prose; it is not used as a runtime authority. Historical ADRs and dated records remain historical and were not rewritten.

## Parallel implementation reconciliation

Final integration compared PR #120 (`a4c27ed…`) and PR #121 (`8a04f80…`) rather than merging either mechanically. PR #120 supplies the canonical human IA and proof/benchmark documentation. PR #121 contributes generated canonical-HTML-to-Markdown peers, llms discovery, richer provenance and broader regression protection. The final branch resolves every review thread from both PRs; only it should merge.
