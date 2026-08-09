# Hosted Docs MCP (ExecPlan)

## 1. Goal and user-visible outcome

Turn the existing read-only `packages/docs-mcp` server into a public remote MCP
endpoint without creating a second documentation authority. A compatible client
must be able to POST to `/api/mcp`, list the same three read-only tools exposed
over stdio, call them, and receive the same evidence-and-limitation pairs.

The endpoint is a documentation surface only. It opens no CRM database, holds no
customer record, authenticates no user, changes no CRM state and proves nothing
about the deployability of an Accordo application. A Vercel preview can prove the
transport and bundle. Promoting the endpoint to `accordo.dev` and submitting it
to any directory remain human infrastructure/publication decisions.

## 2. Current repository context

- `packages/docs-mcp/src/server.js` owns the protocol behavior and already
  supports MCP `2026-07-28`, `2025-11-25`, `2025-06-18` and `2024-11-05` request
  shapes. It is transport-independent.
- `packages/docs-mcp/src/stdio.js` is the only transport today.
- `packages/docs-mcp` is already structurally read-only: its tests reject any
  import path to the CRM runtime/database and require every capability/job to
  carry its limitation.
- `vercel.json` deploys the generated static site at `accordo.dev`; there is no
  Function today. The corpus is discovered through filesystem reads, so Vercel
  file tracing alone is not sufficient evidence that Markdown and JSON ledgers
  reach the runtime bundle.
- `docs/strategy/RECOMMENDATION_MAP.md` and
  `docs/marketing/PENDING_HUMAN_SUBMISSION.md` name a hosted Docs MCP as the
  missing prerequisite for reviewed Anthropic/OpenAI discovery surfaces.
- Current `origin/main` is `77d7719`; the clean branch-point gate passed 772/772
  tests and smoke on 2026-08-09.

Authoritative current protocol facts checked on 2026-08-09:

- MCP Streamable HTTP `2026-07-28` is stateless: one JSON-RPC message per POST,
  no protocol session and no GET stream. It requires `MCP-Protocol-Version`,
  `Mcp-Method`, and for named calls `Mcp-Name`, with header/body equality.
- An invalid present `Origin` must be refused with 403. A request with no Origin
  is valid for server-to-server clients.
- Claude Code recommends HTTP for remote MCP servers and treats SSE as legacy.
- Standalone Vercel projects can expose `api/*.js` Web handlers on Node/Fluid
  Compute, and `functions.includeFiles` explicitly includes runtime-read files.

## 3. Approaches compared

### A. Publish and host a new SDK-based MCP package

Rejected. It adds a production dependency and a second protocol implementation
around a server whose protocol contract already works. The perceived user flow
does not become simpler, while the two transports can drift on tool schemas,
claim pairing and protocol versions.

### B. Run the existing stdio binary behind a persistent HTTP proxy

Rejected. It needs a process manager, framing bridge, session ownership and
deployment separate from the existing site. Vercel Functions are request-based;
keeping a subprocess alive would fight the platform and create state the modern
protocol deliberately removed.

### C. Add one stateless HTTP adapter to the existing server (chosen)

Add a pure Web `Request -> Response` adapter under `packages/docs-mcp`, then a
one-file Vercel entry point under `api/`. The adapter validates HTTP envelope,
protocol headers, origin, media types and body bounds, then calls the same
`createDocsMcpServer().handle()` used by stdio. `vercel.json` includes only the
documentation corpus and ledgers required at runtime. Unit tests call the Web
handler directly; a local Vercel bundle/preview test proves file inclusion and
the public-shape POST.

This is the smallest change that closes the real failure: a coding agent can see
that a Docs MCP exists in source but cannot connect to it remotely.

## 4. DX Simplicity Gate

- **Concrete failure mode prevented:** an agent or directory is given a remote
  MCP URL that either 404s or starts without the documentation corpus, so tool
  discovery fails after the user has opted in.
- **Why existing primitives are insufficient:** stdio requires a local checkout
  and child process; static `llms.txt` is retrievable prose but cannot expose
  MCP tool discovery/calls. Extending the existing server is sufficient; no new
  command, tool name or namespace is added.
- **Semantic overlap:** zero. HTTP and stdio are transports over the same server
  and identical tool/resource registries.
- **On demand:** the Function runs only when `/api/mcp` is called and scales to
  zero. No every-session command is introduced.
- **Portability:** behavior lives in the MCP HTTP contract and the checked
  Vercel config, not a Claude/OpenAI-specific harness.
- **Machine-readable evidence:** HTTP statuses, JSON-RPC errors, exact protocol
  headers, bundle file inventory and a live preview receipt.
- **Horizontal compatibility:** this is a documentation/distribution transport,
  not a domain runtime capability. Every domain is `not_applicable`; the Legacy
  Alignment Matrix will record that explicitly rather than silently omitting the
  assessment.
- **Simpler goal flow:** one URL replaces cloning the repository and launching a
  local stdio process for framework discovery.

## 5. Contract and security design

`createDocsMcpHttpHandler({ rootDir?, allowedOrigins? })` accepts a Web
`Request` and returns a Web `Response`.

- `POST` only. `GET`, `DELETE` and other methods return 405 with `Allow: POST`.
- Request body maximum: 1 MiB, checked before and after read.
- `Content-Type` must be `application/json`.
- `Accept` must contain both `application/json` and `text/event-stream` for the
  modern protocol. The server still returns JSON because its operations do not
  emit progress or server requests.
- A present Origin is accepted only when it is HTTPS and is the public Accordo
  origin or a declared directory/client origin. Absent Origin is accepted for
  server-to-server MCP clients; `null`, malformed, HTTP and unknown origins are
  refused.
- For modern requests the protocol/method/name headers are required, decoded if
  they use the MCP base64 sentinel, and compared exactly to the body. Mismatch is
  HTTP 400 with JSON-RPC `HeaderMismatch` (`-32020`).
- Legacy initialize/handshake traffic remains accepted without the modern
  mirrored headers, because `createDocsMcpServer` already negotiates it. No
  session id is minted; this read-only server needs no state between calls.
- JSON-RPC notifications that produce no response return 202 with an empty body.
- Method-not-found responses map to HTTP 404 as required by the modern transport;
  other valid JSON-RPC errors remain HTTP 200 unless the transport itself failed.
- Responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a
  restrictive CORS policy for declared origins, and no credential allowance.
- Logging is limited to normalized request method/status/duration and never logs
  the body, query, document excerpt or client metadata.

## 6. Milestones

1. Add this plan and freeze the HTTP envelope in focused tests.
2. Implement the transport-neutral Web handler and export it from
   `packages/docs-mcp/src/index.js`.
3. Add the `api/mcp.js` Vercel entry point and assemble the documentation,
   claim and jobs files into one deterministic runtime corpus included through
   `vercel.json`.
4. Document the remote URL/configuration and update GTM/status/task truth without
   claiming a production endpoint before one exists.
5. Run focused hostile-input/protocol tests, all GTM gates, full verification and
   smoke.
6. Run the adversarial-review skill, fix findings with regressions, then verify
   from a fresh clone and a Vercel preview. A human decides production promotion
   and directory submission.

## 7. Validation

```bash
node --test tests/docs-mcp-http.test.js tests/docs-mcp.test.js
npm run gtm:check
npm run verify
npm run smoke
vercel build
```

The focused suite must prove modern and legacy requests, tool list and tool call,
notification 202, exact header/body matching, base64 header decoding, Origin
refusal, media-type/Accept/body bounds, malformed JSON, unsupported method and
no CRM/database import. A preview receipt must POST an initialize/discovery and
at least one `tools/call` through the deployed URL and see the same limitation
pairing as the in-process server.

## 8. Progress log

- 2026-08-09: repository and remote aligned at `77d7719`; clean baseline passed
  772/772 and smoke with zero npm vulnerabilities.
- 2026-08-09: current MCP, Claude Code and Vercel Function/file-bundling docs
  re-verified; chose a stateless adapter over a proxy or second SDK server.
- 2026-08-09: the first `vercel build` rejected an array-valued `includeFiles`;
  a brace glob then built but selected none of the runtime-read files. Replaced
  it with a fingerprinted single-directory runtime corpus assembled from
  `createDocCorpus`; the bundle receipt, not build exit 0, is the acceptance
  test.
- 2026-08-09: focused transport/corpus suites passed 31/31. Two consecutive
  assemblies produced 97 source files, 1,278,989 bytes and fingerprint
  `4bdf0806448ea3c586f05bd224303296d8c6b682b13738b89b672dfd55cfb796`;
  architecture, claims and jobs were present and every `docs/plans/**` path was
  absent.
- 2026-08-09: Vercel build recorded all 97 files plus the manifest in the
  Function's `filePathMap`. Preview deployment
  `dpl_45SVwb1RxNepcqB28xt6Gjn2WWwQ` became `READY` at
  `accordo-iz1qorcbv-khaoss85s-projects.vercel.app`; Vercel reported the
  deployed Function as 548.52 KB.
- 2026-08-09: live preview receipts returned 200 for legacy `initialize`,
  modern `tools/list` and modern `tools/call(get_capability, C-01)`. The list
  contained exactly `search_docs`, `get_capability` and `check_job`, all with
  `readOnlyHint: true`; C-01 returned one claim, its limitation and four test
  references. Responses were `no-store`, minted no session and exposed no
  production alias.
- 2026-08-09: the privacy surface was rendered in a real Chromium browser and
  revised to put its three operating boundaries in the site's required
  above-the-fold `boundary-block`; it adds no CSS or visual language of its own.
- 2026-08-09: `npm run gtm:check`, `npm run verify` (780/780) and
  `npm run smoke` passed. A final full run remains part of clean-clone review
  after the PR head is fixed.

## 9. Decision log

| Question | Decision | Reason |
|---|---|---|
| Separate remote server implementation? | No | One tool/claim authority must serve both transports |
| Session state? | None | Modern MCP is stateless and these tools need no cross-call state |
| SSE response? | Supported in Accept, not emitted | Every current operation resolves in one JSON response |
| Authentication? | No auth for this first read-only public docs surface | It holds no customer/private data; auth would strangle discovery. Reassess if a non-public resource appears |
| Runtime? | Vercel Node/Fluid Compute | Full filesystem compatibility and existing deployment; Edge adds no benefit |
| New dependency? | None | Web Request/Response and the current server are sufficient |

## 10. Outcome and follow-up

Implementation and preview validation are complete on the working branch. The
remaining engineering gates are full repository verification, the required
live-PR adversarial review, clean-clone verification and CI. The preview is
deployment-protected and deliberately has no production alias; it is evidence
for the transport and corpus, not a public install URL. A human must still merge
the reviewed PR, approve the privacy/infrastructure commitment, promote a tested
build to `accordo.dev`, repeat `tools/list` and `tools/call` against that alias,
and submit the endpoint to any Anthropic/OpenAI review flow.
