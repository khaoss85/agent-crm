# Pending human submission

Everything an agent has prepared and **must not** send, create or register, and the person-only
decision that clears each one. `docs/strategy/MASTER_PLAN.md` §10.4 reserves every external
submission and account creation to a human; this file is the checklist that turns that rule
into something you can work through in an afternoon.

Nothing here is blocked on more engineering. It is blocked on you.

## The five decisions — three down, two to go

| # | Decision | What it unblocks | Notes before you decide |
|---|---|---|---|
| 1 | ~~Public name~~ — **DECIDED 2026-08-07: Accordo** | — | Applied to the whole tree by `scripts/brand-set.js --apply`: 389 occurrences across 139 files, 410 tests still passing. **`accordo.dev` is registered.** Two follow-ups remain and are yours: the trademark screen (EUIPO + USPTO, classes 9 and 42) has not been run and is the only thing that can still force a second rename; and `accordo`, `create-accordo` and `@accordo` were free on npm this morning but are still unclaimed — namespaces are first-come and unrenameable |
| 2 | ~~Final licence confirmation~~ — **DECIDED 2026-08-07: MIT, ADR-023** | — | `license.status` is `confirmed`, so a distribution manifest may now state it. The ADR records why the licence is load-bearing rather than incidental: a copyleft core would weaken the ownership claim the whole positioning rests on, and a source-available one would make it false |
| 3 | ~~Repository visibility~~ — **DONE 2026-08-08: public** | Every `{{brand.repository}}` link, the "read the test" call to action, both self-hosted marketplaces, `npx skills add`, and the whole slow-burn retrieval channel — all live | Confirmed against the GitHub API. `site/brand.json` records `repository.status: public`, which is the single field that turns indexing on; `scripts/site-check.js` refuses to let `vercel.json` and the ledger disagree about it. The repository is still named `agent-crm`; renaming it to `accordo` is optional and would break every existing link unless GitHub's redirect is relied on |
| 4 | **Telemetry policy** | The generated-projects and successful-deployments metrics | No collection code should ship before the policy exists; shipping it presumes the decision |
| 5 | **Every public claim and the launch timing** | `docs/marketing/LAUNCH_PACKET.md` | Includes the pre-commitment to publish the benchmark result whatever it says. An agent must not make that commitment on your behalf |

## Prepared and waiting

| Artifact | Where | Action when unblocked | Blocked by |
|---|---|---|---|
| Claude Code plugin + self-hosted marketplace | `.claude-plugin/` | **Live once this branch merges.** `/plugin marketplace add khaoss85/agent-crm` needs no third-party approval | — |
| DEV Community syndication | Canonical Accordo article + DEV article `4354255` | **Live.** DEV's public API returned the exact Accordo production URL as `canonical_url` on 2026-08-09 | — |
| Hashnode syndication | Canonical Accordo article | **Live:** `https://accordo.hashnode.dev/if-a-coding-agent-builds-your-crm-what-should-it-refuse-to-do`. Browser verification found the exact Accordo canonical, article links, OG image and a `text/markdown` `.md` variant. Plain HTTP clients from the verification environment received a Cloudflare 403, so crawler accessibility remains unverified rather than assumed | — |
| Anthropic community marketplace listing | same manifests | Submit via the Console form | 1, 3 |
| Codex plugin + marketplace | `.codex-plugin/`, `.agents/plugins/marketplace.json` | Same, self-hosted — skill parity is 12/12 mirrored, 11 published, held by `tests/skill-parity.test.js` | — |
| MCP registry entry | `server.json` | `mcp-publisher` under the `io.github.<owner>` namespace | `@accordo/mcp` is still unpublished — the scope returns 404, so the registry entry would resolve to nothing |
| npm `create-accordo@0.1.0` | source manifest stays `private: true`; `.github/workflows/stage-create-accordo.yml` assembles the only publishable directory | **Candidate verified, registry unchanged.** Two assemblies and npm tarballs are byte-identical; a clean offline install runs the installed bin and the generated project's inspect, doctor, tests and smoke. After PR #51 merges: configure npm trusted publishing for the exact workflow, dispatch it with `create-accordo@0.1.0`, inspect the staged package, then approve with 2FA. Only the live registry receipt authorizes changing `site/brand.json`; `npm create accordo` still reaches the empty `0.0.1` placeholder until then. The `@accordo` organization is a separate web-only step for later scoped packages | human merge, trusted-publisher configuration, staging and 2FA approval |
| GitHub repository metadata | `docs/marketing/GITHUB_LISTING.md` | Description and topics **applied**. Release `v0.1.0` exists and the Gemini CLI gallery feed lists `@khaoss85/accordo`. Remaining and yours: upload `site/assets/social-preview.png` under Settings → Social preview (GitHub exposes no API for it) | — |
| Landing page and evidence page | `site/dist/` | **Live.** Vercel deployment `dpl_EWhqaktN1ovZhLb31UY3UzqeizQa` is `READY` and aliased to `accordo.dev`; anonymous checks verified the canonical article, sitemap, robots, `llms.txt` and `llms-full.txt` | — |
| Show HN packet | `docs/marketing/LAUNCH_PACKET.md` §2 | Post it | 1, 3, 5 |
| Product Hunt packet | `docs/marketing/LAUNCH_PACKET.md` §3 | Post it, once, on the benchmark edition | 1, 3, 5, and a benchmark result |
| skills.sh | nothing to build — that tool already walks `.claude/skills` and `.agents/skills` | **Live.** The public repository page returns 200 and `npx skills add khaoss85/agent-crm --agent codex --skill '*'` copied all 12 skills in a publisher-verification run on 2026-08-09. Generic search indexing remains pending | — |

## Not blocked on you — blocked on us

Recorded here so the queue above is honestly *only* five decisions.

| Gap | Why it blocks a listing | Where it is tracked |
|---|---|---|
| **No hosted Docs MCP** | Rules out the Anthropic Connectors Directory and the OpenAI plugin directory. Both want a hosted MCP server, and the right one to submit is a **documentation** MCP — it serves docs, not customer records, so it needs none of the CRM's auth or tenancy. These are the only two reviewed directories reachable before the production spine, and treating them as spine-blocked closes them for no reason | `docs/strategy/AGENT_DISCOVERY.md`, Phase 8 |
| **No production spine** | Rules out Vercel templates, deploy buttons and any hosted demo — all of them assert deployability | `docs/PROJECT_STATUS.md` production blockers |
| **Benchmark unexecuted** | Rules out the strongest version of the launch story | `docs/strategy/CRM_BUILD_BENCHMARK.md` |

## The rule that does not bend

An agent may prepare a submission. An agent may not submit a prepared submission, create an
account, register a namespace, or make a public commitment. If a future session finds this file
and is tempted to be helpful, the answer is no.
