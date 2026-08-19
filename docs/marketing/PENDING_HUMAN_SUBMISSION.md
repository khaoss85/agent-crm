# Pending human submission

Everything an agent has prepared and **must not** send, create or register, and the person-only
decision that clears each one. `docs/strategy/MASTER_PLAN.md` §10.4 reserves every external
submission and account creation to a human; this file is the checklist that turns that rule
into something you can work through in an afternoon.

Nothing here is blocked on more engineering. It is blocked on you.

## The five decisions — three down, two to go

| # | Decision | What it unblocks | Notes before you decide |
|---|---|---|---|
| 1 | ~~Public name~~ — **DECIDED 2026-08-07: Accordo** | — | Applied to the whole tree by `scripts/brand-set.js --apply`: 389 occurrences across 139 files, the suite still passing. **`accordo.dev` is registered.** Two follow-ups remain and are yours: the trademark screen (EUIPO + USPTO, classes 9 and 42) has not been run and is the only thing that can still force a second rename; and `accordo`, `create-accordo` and `@accordo` were free on npm this morning but are still unclaimed — namespaces are first-come and unrenameable |
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
| Smithery | production Docs MCP | **Live:** `https://smithery.ai/servers/khaoss85/accordo` returns 200. Release `492a5b41-2548-4184-843a-c4bd67d8c54c` scanned `accordo-docs@0.1.0`, three tools and 99 resources; the missing trigger method is an explicit non-capability, not a failed tool scan | — |
| Glama | Docs MCP repository/package | Connect the repository or a published `@accordo/mcp` artifact, then inspect the generated listing before making it public | Glama account plus a dedicated deployable artifact; no listing receipt exists yet |
| npm `create-accordo@0.1.0` | `.github/workflows/stage-create-accordo.yml` assembles the only publishable directory | **Live, 2026-08-19.** The verified candidate was staged from `main` through OIDC trusted publishing (run 32224731197, provenance in the Sigstore transparency log) and approved by the maintainer with 2FA; the registry receipt was then verified from an agent environment — `npm view create-accordo@0.1.0` returns the CI shasum `69c2bc86…` and `latest` resolves to `0.1.0`, and a clean-directory `npm create accordo` scaffolded a project whose `app inspect` answered. `site/brand.json` flipped to `published` in the same change, per the rule that only the live receipt authorizes it | — (the `@accordo` organization remains a separate web-only step for later scoped packages) |
| GitHub repository metadata | `docs/marketing/GITHUB_LISTING.md` | **Done.** Description and 20 topics applied, release `v0.1.0` exists, the Gemini CLI gallery feed lists `@khaoss85/accordo`, and the refreshed 2560×1280 social preview was uploaded by the maintainer on 2026-08-11 — generated by `npm run site:shots` from the measured ledger, so its count is resolved rather than typed. The upload itself is unverifiable from an agent environment: GitHub exposes no API for the setting, and the network policy denies `repository-images.githubusercontent.com`, so the artwork is recorded as maintainer-reported rather than independently inspected | — |
| Landing page, intent pages and Docs MCP | `site/dist/`, `api/mcp.js` | **Live.** Vercel deployment `dpl_CBayrtYNTRmyZzDPgWoZ3LUGoeDK` is `READY` and aliased to `accordo.dev`; anonymous checks returned 200 for the landing, privacy, Customer Hub, Smart CRM, CDP + CRM, sitemap and `llms.txt`, while `tools/list` returned exactly three read-only, non-destructive tools | — |
| Show HN packet | `docs/marketing/LAUNCH_PACKET.md` §2 | Post it | 1, 3, 5 |
| Product Hunt packet | `docs/marketing/LAUNCH_PACKET.md` §3 | Post it, once, on the benchmark edition | 1, 3, 5, and a benchmark result |
| skills.sh | nothing to build — that tool already walks `.claude/skills` and `.agents/skills` | **Live.** The public repository page returns 200 and `npx skills add khaoss85/agent-crm --agent codex --skill '*'` copied all 12 skills in a publisher-verification run on 2026-08-09. Generic search indexing remains pending | — |

## Not blocked on you — blocked on us

Recorded here so the queue above is honestly *only* five decisions.

| Gap | Why it blocks a listing | Where it is tracked |
|---|---|---|
| **Docs MCP directory review** | Production promotion and Smithery publication are complete. Anthropic and OpenAI still require authenticated account/form submissions; the server serves public docs, imports no CRM runtime and uses no auth only while that boundary holds | `docs/plans/hosted-docs-mcp.md`, `docs/strategy/AGENT_DISCOVERY.md`, Phase 8 |
| **No production spine** | Rules out Vercel templates, deploy buttons and any hosted demo — all of them assert deployability | `docs/PROJECT_STATUS.md` production blockers |
| **Benchmark unexecuted** | Rules out the strongest version of the launch story | `docs/strategy/CRM_BUILD_BENCHMARK.md` |

## The rule that does not bend

An agent may prepare a submission. An agent may not submit a prepared submission, create an
account, register a namespace, or make a public commitment. If a future session finds this file
and is tempted to be helpful, the answer is no.
