# Pending human submission

Everything an agent has prepared and **must not** send, create or register, and the person-only
decision that clears each one. `docs/strategy/MASTER_PLAN.md` §10.4 reserves every external
submission and account creation to a human; this file is the checklist that turns that rule
into something you can work through in an afternoon.

Nothing here is blocked on more engineering. It is blocked on you.

## The five decisions

| # | Decision | What it unblocks | Notes before you decide |
|---|---|---|---|
| 1 | **Public name** | npm scope and the `create-*` package, GitHub organisation, domain, both plugin marketplaces, the MCP registry namespace, every listing — effectively the whole install-time discovery layer | Shortlist and cleanliness checks are in `docs/strategy/BRAND_REQUIREMENTS.md`: Accordo (cleanest), Pactio (best npm/GitHub position but a live UK legal-tech namesake), Vinculo, Relato (domains taken). DNS non-resolution is **not** proof of availability — re-verify with a registrar, and commission a real EUIPO + USPTO class 9/42 screen. Then set `site/brand.json` and rebuild |
| 2 | **Final licence confirmation** | The permissive-core claim, which is load-bearing in every comparison; the Vercel checklist; every listing's licence field | MIT is the repository licence today; keeping it is still an explicit ADR-gated decision |
| 3 | **Repository visibility** | Every `{{brand.repository}}` link, the "read the test" call to action, both self-hosted marketplaces, and the whole slow-burn retrieval channel | Follows the name — a public repository under the working title teaches the wrong one |
| 4 | **Telemetry policy** | The generated-projects and successful-deployments metrics | No collection code should ship before the policy exists; shipping it presumes the decision |
| 5 | **Every public claim and the launch timing** | `docs/marketing/LAUNCH_PACKET.md` | Includes the pre-commitment to publish the benchmark result whatever it says. An agent must not make that commitment on your behalf |

## Prepared and waiting

| Artifact | Where | Action when unblocked | Blocked by |
|---|---|---|---|
| Claude Code plugin + self-hosted marketplace | `.claude-plugin/` | Push public, then `/plugin marketplace add <owner>/<repo>` works with no third-party approval | 1, 3, and skill portability (below) |
| Anthropic community marketplace listing | same manifests | Submit via the Console form | 1, 3 |
| Codex plugin + marketplace | `.codex-plugin/`, `.agents/plugins/marketplace.json` | Same, self-hosted — skill parity is now 11/11 and held by `tests/skill-parity.test.js` | 1, 3 |
| MCP registry entry | `server.json` | `mcp-publisher` under the `io.github.<owner>` namespace | 1, plus an actually-published npm package |
| npm packages | root `package.json` is `private: true`; no per-package manifests exist | Publish with provenance | 1, 2 |
| GitHub repository metadata | `docs/marketing/GITHUB_LISTING.md` | Apply description, topics and social preview | 1, 3 |
| Landing page and evidence page | `site/dist/` | Register a domain, remove the `noindex` tag in the same change that sets the name | 1, 2, 3 |
| Show HN packet | `docs/marketing/LAUNCH_PACKET.md` §2 | Post it | 1, 3, 5 |
| Product Hunt packet | `docs/marketing/LAUNCH_PACKET.md` §3 | Post it, once, on the benchmark edition | 1, 3, 5, and a benchmark result |
| skills.sh | nothing to build — that tool already walks `.claude/skills` and `.agents/skills` | Nothing, once public | 1, 3 |

## Not blocked on you — blocked on us

Recorded here so the queue above is honestly *only* five decisions.

| Gap | Why it blocks a listing | Where it is tracked |
|---|---|---|
| **Skill portability.** Ten of eleven skills instruct the agent to read repository-internal paths, so installed into an unrelated project they load, announce themselves and do nothing useful | A marketplace install is one moment of attention and a no-op listing spends it permanently | `npm run distribution:check` reports it; it fails outright once a name is chosen |
| **No hosted Docs MCP** | Rules out the Anthropic Connectors Directory and the OpenAI plugin directory. Both want a hosted MCP server, and the right one to submit is a **documentation** MCP — it serves docs, not customer records, so it needs none of the CRM's auth or tenancy. These are the only two reviewed directories reachable before the production spine, and treating them as spine-blocked closes them for no reason | `docs/strategy/AGENT_DISCOVERY.md`, Phase 8 |
| **No production spine** | Rules out Vercel templates, deploy buttons and any hosted demo — all of them assert deployability | `docs/PROJECT_STATUS.md` production blockers |
| **Benchmark unexecuted** | Rules out the strongest version of the launch story | `docs/strategy/CRM_BUILD_BENCHMARK.md` |

## The rule that does not bend

An agent may prepare a submission. An agent may not submit a prepared submission, create an
account, register a namespace, or make a public commitment. If a future session finds this file
and is tempted to be helpful, the answer is no.
