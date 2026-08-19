# Launch packet

Copy for the two launch channels, written now so that it is written carefully rather
than under launch-day pressure, and **deliberately not fired**.

> **Gate.** Nothing in this file may be posted until every item in
> `docs/marketing/PENDING_HUMAN_SUBMISSION.md` is cleared by a person. An agent prepares
> a submission; an agent never submits one (`docs/strategy/MASTER_PLAN.md` §10.4).

Every product statement below resolves to an id in `site/claims.json`. Ids are cited
inline in square brackets so the check in `scripts/site-check.js` can verify that a claim
promised to the launch surface actually appears here, and so a reviewer can trace any
sentence to the test behind it. Strip the bracketed ids before posting; keep the sentences.

---

## 1. Why this is not ready to fire

| Blocker | Consequence for the launch |
|---|---|
| No public name | Every channel asks for a product name and a URL. The working title is documented as unusable (`docs/strategy/BRAND_REQUIREMENTS.md`) |
| Repository not public | The primary call to action is "read the test". A 404 is a worse first impression than silence |
| Benchmark not run [L-03] | The strongest version of this story is a scoreboard with failures in it. Without a number, the launch is an announcement, and announcements about frameworks with no users do not travel |
| No production spine [L-01] | The first comment on any thread will be "can I deploy it". The answer is no, and it needs to be *our* sentence, not a commenter's discovery |

**Recommended order:** repository public → Show HN on the engineering story → benchmark
executed and published → Product Hunt, once, on the benchmark edition. Product Hunt is a
single-use asset; spending it before there is a number wastes it on a traffic spike that
converts nobody in this audience.

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
> - **There is no authentication, no tenancy and no RBAC.** The server is local-development-only
>   and an actor header is an assertion, not an identity. So the refusal above holds against an
>   honest agent, not against anyone with network access. The framework reports this itself:
>   `crm app inspect --json` returns `productionPosture: "local development only…"`. [L-01]
> - **The deterministic policy is proven on one built-in object and one value threshold.** There
>   is no general policy engine over arbitrary custom objects yet. If your reaction to the
>   headline is "so it's a hardcoded if-statement with a test on it" — that is a fair reading of
>   today's scope, and it is why the claim is worded narrowly. [C-03]
> - **I have not run the build benchmark.** The protocol is written and published; there is no
>   success rate, and I would rather post this without one than with a number I made up. [L-03]
> - **Every provider is an offline fixture.** No DocuSign, no Stripe, no real enrichment source.
>   A complete commercial spine with no connectors — the right order to build it in and the
>   wrong order to sell it in. [C-06]
> - **"Own the CRM it builds" means vendored source today**, not a versioned dependency. A
>   verified `create-accordo@0.1.0` publication candidate exists, but there is no published
>   create-command yet: the live npm name is still an empty `0.0.1` placeholder. Either way,
>   upgrading means merging source rather than bumping a version. [L-08]
> - **Do not put real customer data in it.** No auth, no tenancy, no export, no erasure path — so
>   you could not service a data-subject access or deletion request. If you are in the EU that is
>   disqualifying today, and it should be. (What does hold: lead scoring is deterministic,
>   versioned and explainable, not a model's judgement about a person.) [L-09]
> - **It is a framework, not a product.** There is nothing to sign up for. [L-07]
>
> If you want to judge it in a minute rather than read about it: clone and run `npm run tour`.
> There is nothing to install. It composes the whole application from manifests —
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
> third-party runtime dependencies, so it is Node 22 and a checkout [C-17]; and one command
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
| "So the guardrail is an unauthenticated header check on one threshold." | Yes, today. The actor is asserted, not authenticated, and the policy is proven on the built-in renewal object with a single value threshold. Both limits are in the ledger next to the claim, and the production spine is the next platform milestone. What the test buys you now is that the boundary cannot be quietly deleted by the agent that is writing the rest of the code. |
| "Why not just use Twenty?" | If you want a CRM your team can log into next week, or SSO, or a hosted option, use Twenty — it is more finished and has the release train to prove it. The difference that survives is where the agent's output runs: theirs writes extensions into Twenty's runtime, this writes an application that runs without us. Our own competitor map says narrative convergence is the standing risk, and it is in the repository. |
| "Agent-generated code in the part of the system that touches money — no thanks." | That is the correct instinct and it is why the money-touching parts are not what the agent improvises. Pricing is server-side, quote versions and orders are immutable, discount policy is versioned, and approval is deferred to a person by policy. The agent composes those primitives; it does not invent them per project. |
| The test count as a quality claim | A test count measures effort, not correctness. The useful artifact is `docs/QUALITY_GATES.md` §2 — the sixteen adversarial categories every milestone is attacked with before it merges, including transaction fault injection, two-connection concurrency, replay, and hostile input. Read that and judge the tests by it. |
| "Is this just a wrapper around an LLM?" | There is no model in the runtime at all. The framework is deterministic code; the agent is the thing that writes against it, at development time. Nothing calls a model at request time. |
| "Why SQLite?" | Because the production spine is not built, and shipping PostgreSQL support before auth and tenancy would imply a deployability that does not exist. It is a real limitation, listed as one. |
| "This is a solution looking for a problem." | Possibly. The honest test is the jobs-to-be-done matrix in the repository, where "not supported" is the default status and seventeen core jobs are tracked with evidence. Five are still marked not supported. If the ones you need are in that column, this is not for you yet. |
| "Show me it working." | `npm run verify` then `npm run demo`, no install step and no third-party dependencies. The demo is asserted by `scripts/smoke.js` on every push, so if it does not do what I said, CI is lying. |

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
> a merged test refuses to let it make the human's approval decision. Local-development only.

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
