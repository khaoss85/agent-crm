# Objection bank

The fifteen hardest things a sceptical developer says, and the answer in the project's own
words. Every answer points at a file or a runnable command — an objection answered with an
assertion is an objection that comes back.

**Rule:** if a new objection is raised publicly and has no entry here, write the entry within
72 hours, and if answering it honestly requires a file that does not exist, write the file
first. `GO_TO_MARKET.md` §7 tracks objection recurrence as a metric for exactly this reason.

---

### 1. "So the guardrail is an unauthenticated header check on one hardcoded threshold."

Today, yes — and both halves are in the ledger next to the claim rather than discovered by you.
The actor is asserted, not authenticated (`L-01`), and the deterministic policy is proven on the
built-in renewal object with one value threshold (`C-03`). What the test buys right now is that
the boundary cannot be quietly deleted by the agent writing the rest of the code
(`tests/workflow.test.js`, "approval workflow rejects an agent pretending to make the human
decision"). What it does not buy is protection from anyone with network access. The production
spine is the next platform milestone, and until it lands the honest scope is: this holds against
an honest agent, not an attacker.

### 2. "Why not just use an existing open-source CRM?"

If you want a CRM your team can log into next week, or SSO, or role-based access now, or a
hosted option — use one. They are more finished than this and have the release trains to prove
it. The difference that survives is where the agent's output runs: their agent writes extensions
into their runtime; this one writes an application that runs without us. Delete the vendor and
run `npm test` — that is the whole comparison. `docs/strategy/COMPETITOR_MAP.md` carries the
sourcing and names where the alternative wins.

### 3. "Agent-generated code in the part of the system that touches money. No."

Correct instinct, and it is why those parts are not what the agent improvises. Pricing is
server-side, quote versions and orders are immutable, discount policy is versioned and
fingerprinted, approval is deferred to a person by policy, and every mutation leaves an audit
event and a step-level trace (`C-08`, `C-09`, `C-16`). The agent composes primitives that were
reviewed once; it does not reinvent them per project. That is the actual pitch — the agent is
constrained, not trusted.

### 4. "788 tests is a vanity number."

It is. A test count measures effort, not correctness, and the ledger says so in `C-20`'s own
limitation. The useful artifact is `docs/QUALITY_GATES.md` §2 — the sixteen adversarial
categories every milestone is attacked with before merging: transaction fault injection after
every significant write, two-connection concurrency, idempotency with semantic-mismatch
fail-closed, replay and reconciliation, exact queries beyond page bounds, immutability proven by
mutating the source, and hostile input across every provider, payload, field and route. Judge
the tests by that list, not by the count.

Better still, do not take either on trust: `npm run falsify` removes five of the rules those
tests defend — the human-actor guard on approvals, the approval threshold's boundary, webhook
signature verification, policy-version immutability, and the rule that a fully managed module
generates no public write — and reports which named test caught each one, in about two seconds
(`docs/FALSIFY.md`, `C-23`). Anything that survives is printed as a gap rather than omitted.
One already did, on the first run, and the missing test is in the same diff as the tool.

### 5. "Is this just a wrapper around an LLM?"

There is no model in the runtime. Nothing calls a model at request time. The framework is
deterministic code; the agent is what writes against it, at development time. If every AI vendor
vanished tomorrow, your generated application would still run and still enforce its rules.

### 6. "Can I deploy this?"

No. There is no authentication, no tenancy and no RBAC, and an actor header is not an identity
(`L-01`). The framework reports this itself — `npm run crm -- app inspect --json` returns
`productionPosture: "local development only…"`. Do not expose the HTTP API to a network. This is
the single biggest reason not to adopt it yet, and it is why there is no deploy button, no
hosted demo and no template-gallery listing: those all assert deployability.

### 7. "Where are the integrations?"

There are none. Every provider — enrichment, catalog, signature, notification — is an offline
fixture (`L-05`, `C-09`). A complete commercial spine with no connectors is the right order to
build in and the wrong order to sell in, which is why it is stated here rather than discovered
in week two. Provider contracts exist and are stable; adapters do not.

### 8. "'Own the CRM it builds' — owned how?"

By copying source into your project today, not by installing a dependency (`L-08`). There is no
create-command and no published package, so upgrading means merging rather than bumping a
version. That is real ownership with worse ergonomics than the roadmap describes, and the gap is
named rather than blurred.

### 9. "Why SQLite? That's not serious."

Because the production spine is not built, and shipping a PostgreSQL adapter before auth and
tenancy would imply a deployability that does not exist (`L-02`). Persistence is Node's built-in
SQLite, which is also why there are no third-party runtime dependencies at all (`C-17`).

### 10. "Every framework says its generated code is readable."

Then read it. `npm run crm -- module create examples/modules/partner.module.json` prints the
generated service, migration and tests without writing anything — code generation is dry-run
until you pass `--apply` (`C-18`). Judge the output before installing anything.

### 11. "What happens when you abandon this?"

You keep a Node application in your repository with no third-party runtime dependencies and a
SQLite file any client can open. That is a design constraint, not a reassurance: the framework
is a dependency you could delete and still ship. The uncomfortable half is that you would also
keep the missing pieces — no auth, no scheduler, no integrations — and would be building those
yourself.

### 12. "Show me the benchmark."

There isn't one yet (`L-03`). The protocol is written and published in
`docs/strategy/CRM_BUILD_BENCHMARK.md`; it has not been executed, so there is no success rate.
Any percentage you see attributed to this project is fabricated. When it runs, the number and
the full transcripts — including the failures — get published together, and that commitment is
made before the run rather than after seeing the result.

Worth knowing before you ask for the number: **two of the six gates cannot be run at
all.** G5 and G6 score a deployed instance, and this framework has no authentication,
tenancy or RBAC — running them would mean putting an unauthenticated CRM on the public
internet to earn points. So the benchmark is split into Edition L (G1–G4, scoreable
locally, reported as points out of 75) and Edition D (G5–G6, blocked on the Production
Spine), and every scored run carries that blocker in its own output rather than dropping
it (ADR-024). SABR and "time to first working CRM" are Edition D metrics and will not be
quoted from Edition L runs, because with two gates unrunnable they would be different
metrics wearing the same names. The full list of sentences a result does and does not
license is `docs/marketing/BENCHMARK_PUBLICATION.md`, written before there was a result
to be tempted by.

### 13. "This is a solution looking for a problem."

Possibly. The honest test is `docs/benchmarks/CRM_JTBD_MATRIX.md`, where *not supported* is the
default status and a row moves only when an automated test proves the whole job. Five of the
seventeen core jobs are still in that column — including onboarding, churn, upsell, integrations
and permissions. If the jobs you need are there, this is not for you yet, and no amount of
positioning changes that.

### 14. "Your AGENTS.md is longer than most projects' documentation. Isn't that a smell?"

It is a bet. The claim being made is that a coding agent needs the same thing a new senior
engineer needs — the rules, the boundaries and the reasons — and that writing them down is
cheaper than re-explaining them per session. Whether it works is exactly what the build
benchmark is designed to measure, which is also why no claim is made about it yet.

### 15. "Why should I trust a claims ledger you wrote about yourself?"

You shouldn't trust it; you should check it. Every entry in `site/claims.json` names the test
files behind it, the paths are verified to exist before the site will build, and the claim
cannot be written into a page except by reference. Clone it and run `npm run verify` — if a
claim on the site is not supported by a test, that is a bug, and
`.github/ISSUE_TEMPLATE/claim-not-supported.md` exists specifically so you can file it. The
mechanism is checkable; that is the only kind of trust being asked for.
