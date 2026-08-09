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
| Anthropic community marketplace listing | same manifests | Submit via the Console form | 1, 3 |
| Codex plugin + marketplace | `.codex-plugin/`, `.agents/plugins/marketplace.json` | Same, self-hosted — skill parity is 12/12 mirrored, 11 published, held by `tests/skill-parity.test.js` | — |
| MCP registry entry | `server.json` | `mcp-publisher` under the `io.github.<owner>` namespace | `@accordo/mcp` is still unpublished — the scope returns 404, so the registry entry would resolve to nothing |
| npm packages | root `package.json` is `private: true`; `packages/create-accordo/package.json` exists and is `private: true` | **Names reserved 2026-08-09**: `accordo@0.0.1` and `create-accordo@0.0.1` are published placeholders that install nothing — verified against the registry, and unchanged since. **The precondition is now met**: `create-accordo` scaffolds a real project from a checkout (`tests/project-bootstrap.test.js`), so the blocker is distribution rather than capability. Still to do, and all of it is yours: create the `@accordo` **organization** (web-only, no CLI); remove `private` from `packages/create-accordo/package.json` and give it a `files` array covering the framework source it copies, or the published tarball reports `FRAMEWORK_SOURCE_UNAVAILABLE`; flip `site/brand.json` → `npm.status` in the same commit (`scripts/distribution-check.js` fails while the two disagree); publish with `--provenance`. Until you do, no document may say `npm create accordo` creates a project | — |
| GitHub repository metadata | `docs/marketing/GITHUB_LISTING.md` | Description and 14 topics **applied**. Remaining and yours: upload `site/assets/social-preview.png` under Settings → Social preview (GitHub exposes no API for it), and cut `git tag v0.1.0` so the Gemini CLI gallery crawler lists the extension | — |
| Landing page and evidence page | `site/dist/` | **Unblocked.** Domain registered, repository public, `noindex` and `X-Robots-Tag` both removed. Remaining: point `accordo.dev` DNS at the Vercel project and deploy from `main` after this branch merges | — |
| Show HN packet | `docs/marketing/LAUNCH_PACKET.md` §2 | Post it | 1, 3, 5 |
| Product Hunt packet | `docs/marketing/LAUNCH_PACKET.md` §3 | Post it, once, on the benchmark edition | 1, 3, 5, and a benchmark result |
| skills.sh | nothing to build — that tool already walks `.claude/skills` and `.agents/skills` | **Live.** `npx skills add khaoss85/agent-crm` verified working 2026-08-08 | — |

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
