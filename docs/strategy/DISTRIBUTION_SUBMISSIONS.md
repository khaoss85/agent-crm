# Distribution submissions runbook

Dated receipt register, reconciled 2026-09-07. `GO_TO_MARKET.md` owns priorities;
`../marketing/PENDING_HUMAN_SUBMISSION.md` owns decisions. A listing, a prepared
submission, a sent submission and acceptance are different states. Recheck the
linked authority before an action; this register does not itself authorize one.

## Verified public distribution

| Surface | Evidence at the 2026-09-07 audit | Boundary / next action |
|---|---|---|
| Repository, MIT, domain and metadata | `../../site/brand.json`, [GitHub](https://github.com/khaoss85/agent-crm), [site](https://accordo.dev) | Foundation complete; no visibility blocker |
| npm scaffolder | `create-accordo@0.1.0`, published 2026-08-19, staging run 32224731197; [registry metadata](https://registry.npmjs.org/create-accordo/latest) | Tarball predates current PostgreSQL/production operations. Prepare current candidate and prove its installed flow before claiming distribution parity |
| Docs MCP | [Live endpoint](https://accordo.dev/api/mcp), `tools/list` returns `search_docs`, `get_capability`, `check_job` | Read-only public documentation; protocol success is not answer correctness |
| Official MCP Registry | Active since 2026-08-19 for `io.github.khaoss85/agent-crm`; `server.json` points to the remote endpoint | Published, not awaiting first submission; re-read registry identity after an update |
| Glama | [Listing](https://glama.ai/mcp/servers/khaoss85/agent-crm) and [connector](https://glama.ai/mcp/connectors/io.github.khaoss85/agent-crm) public | No account blocker for the existing listing; discovery does not establish who submitted it |
| Site and discovery documents | `version.json` matched audited main; sitemap URLs reachable; `llms` assets published | Reachability is not semantic accuracy, search rank or conversion |
| Agent manifests and skills | `npm run distribution:check`, Claude/Codex/Gemini manifests and published subset | Fresh host installation was not repeated in the audit; repository-only skills must remain excluded |

`npm create accordo` vendors source; it does not install the framework as an npm
library. Keep the live version distinct from a locally assembled candidate.
The `accordo` npm organization reservation was verified on 2026-08-19 via the
registry organization endpoint and is a completed historical receipt; the scope
was deliberately empty. Do not reserve it again. ADR-034 keeps Project MCP
inside the application it composes; the hosted Docs MCP needs no server npm package.

## Awesome-list follow-up

All four entries were sent 2026-08-26. The audit checked the following states on
2026-09-07; copy and original submission context live in
`../marketing/AWESOME_LIST_SUBMISSIONS.md`.

| Submission | Audited state | Next action |
|---|---|---|
| [MCP servers #12938](https://github.com/punkpeye/awesome-mcp-servers/pull/12938) | OPEN | Monitor maintainer feedback |
| [Claude skills #1173](https://github.com/travisvn/awesome-claude-skills/pull/1173) | OPEN | Monitor maintainer feedback |
| [Open-source CRM #4](https://github.com/sneg55/awesome-open-source-crm/pull/4) | CLOSED, not merged | Read closure rationale before proposing any retry |
| [Claude Code #2637](https://github.com/hesreallyhim/awesome-claude-code/issues/2637) | CLOSED; acceptance unverified | Verify destination acceptance and closure rationale; human recommendation rule still applies |

The latter two current README files did not contain Accordo during the audit.
That does not establish a rejection reason or exclude another publication path.
No new submission or outreach was sent by this reconciliation.

## Historical receipts not freshly revalidated

Smithery listing and scan, skills.sh installation, Gemini gallery feed, DEV and
Hashnode syndication were recorded in August. Refresh those receipts before a new
campaign relies on them. GitHub social-preview upload and Bing sitemap submission
were maintainer-reported. A reported dashboard action is not an independent check.
The site contains articles and the README references a demo; that is not evidence
of a sustained editorial cadence or external user success.

## Release procedure

1. Assemble through `stage-create-accordo.yml` / the repository publication
   procedure; the publishable directory contains the vendored framework payload.
2. Check candidate source identity, package contents and a fresh generated project.
3. Stage the verified version through trusted publishing. Where npm requires
   maintainer approval, supply the reviewed candidate and receipts for that step.
4. Read the live registry metadata, download the published tarball and repeat the
   advertised install path. Only then record a newly published version as live.
5. Verify the site deployment identity and copy against that installed version;
   preserve a clear version boundary if source capabilities are newer.

The existing `publish-mcp-registry.yml` validates manifests, schema and live
read-only tools before a registry write. Use it for an authorized update, not to
repeat the already completed initial publication.

## Remaining channels and copy

Anthropic and OpenAI directory forms remain external review work. Vercel templates
need a verified deployable starter and demo. Product Hunt remains gated on a build
benchmark result and owner launch decision. Paid acquisition should follow a
measured successful journey and conversion funnel. Channel preparation creates
no permission to send or spend.

**Short description:** The open-source framework coding agents use to build custom CRMs.

**Expanded description:** Describe a commercial process to a coding agent and
build a CRM as reviewable source you own, with deterministic workflows, human
approval boundaries, audit and trace. Framework storage supports SQLite and
dedicated-database PostgreSQL; self-host operations require explicit application
setup and a deployment-supplied identity verifier. Check the installed version's
scope. No billing service, managed Cloud availability or build success rate is
implied. Evidence and exact limitations: `GTM_TECHNICAL_EVIDENCE_HANDOFF.md`.
<!-- truth: spine.postgresql.implemented=implemented -->
<!-- truth: spine.authentication.framework_verifier=absent -->
<!-- truth: billing.implemented=absent -->
