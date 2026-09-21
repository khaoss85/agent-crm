# Launch packet

Copy for the two launch channels, written now so that it is written carefully rather
than under launch-day pressure, and **deliberately not fired**.

> **Gate.** Draft only. Refresh against the released package and current ledger,
> then obtain the owner's instruction for the specific post and benchmark
> commitment. Completed repository, domain and registry setup are not blockers.
> `PENDING_HUMAN_SUBMISSION.md` tracks remaining decisions.

Every product statement below resolves to an id in `site/claims.json`. Ids are cited
inline in square brackets so the check in `scripts/site-check.js` can verify that a claim
promised to the launch surface actually appears here, and so a reviewer can trace any
sentence to the test behind it. Strip the bracketed ids before posting; keep the sentences.

---

## 1. Why this is not ready to fire

| Prerequisite | Completion evidence |
|---|---|
| Release alignment | Package installed from the registry, advertised journey verified and site version checked |
| Benchmark result for Product Hunt [L-03] | Frozen edition, actual sessions, transcript and failure evidence; owner-approved publication |
| Deployment claims [L-01] | Named deployment with its own verifier, access checks and operational evidence |
| Owner launch instruction | Approved refreshed copy, channel and timing; trademark decision remains separate owner work |

Repository, domain, MIT, npm scaffolder and Docs MCP distribution are already
live. The next launch story should demonstrate one B2B quote-and-approval flow on
the released artifact. `../strategy/GO_TO_MARKET.md` owns the sequence.

---

## 2. Show HN

**Title** (Show HN titles work best plain and specific; ≤ 80 chars):

> Show HN: A CRM framework whose tests fail if the agent approves its own discount

Alternates, if the above reads as a gimmick to the poster:

> Show HN: An open-source framework coding agents use to build CRMs you own
> Show HN: We made the approval boundary a test instead of a prompt instruction

**Body** — Show HN posts do best as a link plus a first comment. The link is the
repository. The first comment is below, and it exists to say the damaging things
before a commenter gets to say them.

### 2.1 First comment (post immediately, from the maintainer account)

> I build CRM-shaped systems for a living and kept hitting the same wall: every packaged CRM
> makes you bend the process to the tool, and every from-scratch build re-derives validation,
> stage semantics, approvals and audit at the worst possible moment. So this is the third
> option — a framework a coding agent writes a CRM *with*, where the application ends up in
> your repository rather than inside someone's platform. [C-01]
>
> The part I actually want feedback on is the boundary. The agent writes the policy; it is not
> allowed to execute the decision the policy defers to a person. On renewals that is asserted by
> a test named "approval workflow rejects an agent pretending to make the human decision"
> (`tests/workflow.test.js`); on discounts, an agent actor calling `quote.approve` is refused
> with a 403 (`tests/commercial-e2e.test.js`, in the approval-boundary case). [C-04] [C-03] [C-21]
>
> Before anyone has to find these out for themselves, the things that will annoy you:
>
> - **Authentication is deployment-supplied.** The framework enforces authorization
>   and one tenant per instance, but local actor assertions are not authenticated
>   identity. A production deployment needs a trusted verifier and its own checks. [L-01]
> - **The deterministic policy is proven on one built-in object and one value threshold.** There
>   is no general policy engine over arbitrary custom objects yet. If your reaction to the
>   headline is "so it's a hardcoded if-statement with a test on it" — that is a fair reading of
>   today's scope, and it is why the claim is worded narrowly. [C-03]
> - **I have not run the build benchmark.** The protocol is written and published; there is no
>   success rate, and I would rather post this without one than with a number I made up. [L-03]
> - **Every provider is an offline fixture.** No DocuSign, no Stripe, no real enrichment source.
>   A complete commercial spine with no connectors — the right order to build it in and the
>   wrong order to sell it in. [C-06]
> - **"Own the CRM it builds" means vendored source**, not a versioned dependency.
>   `npm create accordo` (the published `create-accordo@0.1.0`) scaffolds the project by copying
>   the framework source into it. This dated release predates newer main capabilities; verify
>   the version being promoted. It installs a scaffolder, not a framework library —
>   so upgrading means merging source rather than bumping a version. [L-08]
> - **Customer data operations are bounded.** Import previews/apply, duplicate
>   candidates and human-governed identity linking exist in current source; they
>   do not provide a complete export/erasure or compliance program. Deployment
>   authentication and data-governance requirements need their own review. [L-09]
> - **It is a framework, not a product.** There is nothing to sign up for. [L-07]
>
> If you want to judge it in a minute rather than read about it: clone and run `npm run tour`.
> Install the checkout dependencies first. It composes the whole application from manifests —
> 76 modules, 71 resources, 64 actions, 7 policies, 1 providers — drives it end to
> end, and then prints the eleven things its own inspector says it cannot see. [C-22]
>
> If you would rather try to break it than read about it: `npm run falsify` removes five
> guarantees on purpose — the human-actor guard on approvals, the approval boundary, webhook
> signature verification, policy-version immutability, the no-public-write rule on managed
> modules — and reports which test caught each one, in about two seconds. Anything that
> survives is printed as a gap. It already found one, and the fix is in the diff. [C-23]
>
> What does work, and what I would like broken: every mutation goes through a module service or
> a named workflow and leaves an audit event and a step-level trace [C-16]; there are no
> ORM and no framework underneath: SQLite is Node built-in, PostgreSQL is one pinned
> `pg@8.23.0` driver, and it is Node 22 and a checkout [C-17]; and one command
> reports what an application actually contains, including a machine-readable list of what the
> inspector itself cannot see [C-14].
>
> Every claim on the site is generated from a ledger that names the tests behind it, and the
> build fails if a claim loses its evidence or its limitation. That is either the most useful
> thing here or an elaborate way to be wrong in public, and I would genuinely like to know which.

### 2.2 Reply bank

Pre-written because the first hour decides the thread. Each answer points at a file or a
command rather than an assertion.

| Objection | Reply |
|---|---|
| "So the guardrail is an unauthenticated header check on one threshold." | Local-development actors are asserted. Framework authorization and instance tenancy are enforced; production needs a deployment verifier. The named renewal and commercial refusal tests prove their own decision boundaries, not deployment authentication. |
| "Why not just use Twenty?" | If you want a CRM your team can log into next week, or SSO, or a hosted option, use Twenty — it is more finished and has the release train to prove it. The difference that survives is where the agent's output runs: theirs writes extensions into Twenty's runtime, this writes an application that runs without us. Our own competitor map says narrative convergence is the standing risk, and it is in the repository. |
| "Agent-generated code in the part of the system that touches money — no thanks." | That is the correct instinct and it is why the money-touching parts are not what the agent improvises. Pricing is server-side, quote versions and orders are immutable, discount policy is versioned, and approval is deferred to a person by policy. The agent composes those primitives; it does not invent them per project. |
| The test count as a quality claim | A test count measures effort, not correctness. The useful artifact is `docs/QUALITY_GATES.md` §2 — the sixteen adversarial categories every milestone is attacked with before it merges, including transaction fault injection, two-connection concurrency, replay, and hostile input. Read that and judge the tests by it. |
| "Is this just a wrapper around an LLM?" | CRM state changes follow deterministic policies and human approval boundaries. AI-assisted development does not authorize a model to override those decisions. |
| "Why SQLite?" | The synchronous factory uses SQLite; the async factory supports dedicated PostgreSQL. Check the installed release and supply a deployment verifier; neither adapter alone is a readiness claim. |
| "This is a solution looking for a problem." | Possibly. The honest test is the jobs-to-be-done matrix in the repository, where "not supported" is the default status and each job has a scoped coverage status and evidence. If the ones you need are in that column, this is not for you yet. |
| "Show me it working." | `npm run verify` then `npm run demo`. SQLite needs no extra driver; PostgreSQL is the one pinned `pg@8.23.0`. The demo is asserted by `scripts/smoke.js` on every push, so if it does not do what I said, CI is lying. |

---

## 3. Product Hunt

**Do not fire this before the benchmark has a published number.** Product Hunt is single-use
per product, its audience skews further from this ICP than Hacker News does, and a launch
without a result is a spike rather than a story. This packet exists so the asset is ready
the day it is worth spending.

Field limits verified against Product Hunt's current submission flow (August 2026):
tagline 60 characters, description ~260, up to three topics, thumbnail 240×240,
gallery images 1270×760 with at least two required.

| Field | Value | Count |
|---|---|---|
| Name | *(the chosen public name — `site/brand.json`)* | — |
| Tagline | `Your coding agent writes the CRM. A test stops it approving.` | 59 |
| Topics | Developer Tools · Open Source · Sales |  3 |

**Description** (≤ 260):

> An open-source framework Claude Code and Codex use to build a CRM as code you own —
> deterministic workflows, versioned policies, audit and trace. The agent writes the rules;
> a merged test refuses to let it make the human's approval decision. Authentication is deployment-supplied.

**Gallery** — generate with `npm run site:shots`, then crop to 1270×760:

1. The promise and the proof line (`site/dist/shots/hero.png`).
2. The refusal: the test name and the two renewal outcomes.
3. The claims ledger — every statement bound to its tests (`site/dist/shots/page-evidence.png`).
4. The limits section, unedited. **This slide stays in.** [L-01]
5. `crm app inspect --json`, showing `productionPosture` and the limitation codes. [C-14]

**Maker's first comment** — the same disclosure discipline as the Show HN comment, shortened.
Reuse §2.1's bullet list verbatim; the audience differs, the obligation does not.

---

## 4. Rules for whoever posts this

1. **Post the limitations before anyone asks.** They are the reason the rest is believable;
   held back, they become a gotcha instead of a credential.
2. **Never cite a number the benchmark has not produced.** [L-03]
3. **Answer in the project's own words.** Every reply above resolves to a file. If a new
   objection has no file behind it, write the file, then reply.
4. **If a claim here turns out to be wrong, correct it in public within a day** and either
   remove the claim or add the test. The correction log is the asset, not the claim.
5. **Do not argue about licensing rhetoric.** Structural differentiation survives scrutiny;
   disparagement invites it.
