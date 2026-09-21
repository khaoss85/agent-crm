# Objection bank

The fifteen hardest things a sceptical developer says, and the answer in the project's own
words. Every answer points at a file or a runnable command — an objection answered with an
assertion is an objection that comes back.

**Rule:** if a new objection is raised publicly and has no entry here, write the entry within
72 hours, and if answering it honestly requires a file that does not exist, write the file
first. `../strategy/GO_TO_MARKET.md` tracks the evidence and feedback loop.

---

### 1. "So the guardrail is an unauthenticated header check on one hardcoded threshold."

In local-development mode, actor assertions are not authentication. The framework
also has enforced authorization, memberships and one tenant per instance; a
production deployment supplies a verifier and startup fails without it. The named
renewal refusal and the commercial discount refusal prove particular human-actor
boundaries, not authentication of every deployment (`tests/workflow.test.js`,
`tests/commercial-e2e.test.js`, `tests/spine-route-authorization.test.js`).

### 2. "Why not just use an existing open-source CRM?"

If you want a CRM your team can log into next week, or ready-made SSO, or a
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

### 4. "The test count is a vanity number."

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

CRM decisions follow deterministic policies and human approval boundaries. A
coding agent builds against those contracts; any application-specific AI
integration must preserve them. This is a framework for authoring a CRM, not an
autonomous seller or an assurance that no selected provider ever calls a model.

### 6. "Can I deploy this?"

You can compose a self-host deployment, but must supply its identity verifier and
prove its operating setup. The framework's authorization, dedicated PostgreSQL
and self-host operations contracts are not a general production-readiness
attestation. An asserted local actor header is not authenticated identity. Check
the installed version and deployment guide before exposing the application;
`app inspect` describes source, not a live environment (`L-01`, `L-02`).

### 7. "Where are the integrations?"

There are none. Every provider — enrichment, catalog, signature, notification — is an offline
fixture (`L-05`, `C-09`). A complete commercial spine with no connectors is the right order to
build in and the wrong order to sell in, which is why it is stated here rather than discovered
in week two. Provider contracts exist and are stable; adapters do not.

### 8. "'Own the CRM it builds' — owned how?"

The published `npm create accordo` scaffolder vendors framework source into your
project (`L-08`). You keep and operate that source. Upgrades mean reviewed merges,
not bumping a framework library dependency. The dated npm release and current
main are distinct artifacts; see `../strategy/DISTRIBUTION_SUBMISSIONS.md`.

### 9. "Why SQLite? That's not serious."

The synchronous application factory uses Node's built-in SQLite; the async
factory also supports dedicated-database PostgreSQL with the pinned driver
`pg@8.23.0`. Framework authorization and instance tenancy are enforced. A
deployment supplies authentication; shared-row tenancy and general production
readiness are not implied. Check the installed release: the historical npm
scaffolder may predate newer source capabilities (`L-02`, `C-17`).
<!-- truth: spine.postgresql.implemented=implemented -->
<!-- truth: spine.authorization.enforced=enforced -->
<!-- truth: spine.authentication.framework_verifier=absent -->

### 10. "Every framework says its generated code is readable."

Then read it. `npm run crm -- module create examples/modules/partner.module.json` prints the
generated service, migration and tests without writing anything — code generation is dry-run
until you pass `--apply` (`C-18`). Judge the output before installing anything.

### 11. "What happens when you abandon this?"

You keep the Node application, its vendored framework source and a SQLite file any client can
open. No hosted Accordo runtime remains underneath it. That is a design constraint, not a
maintenance exemption: deleting the copied framework breaks the application. The uncomfortable
half is that you also own operating it: supplying a trusted identity verifier,
starting self-host workers explicitly, and implementing any real provider adapters
your application needs. The durable job contract does not operate a managed service.

### 12. "Show me the benchmark."

There isn't one yet (`L-03`). The protocol is written and published in
`docs/strategy/CRM_BUILD_BENCHMARK.md`; it has not been executed, so there is no success rate.
A claimed CRM build success rate needs its own benchmark receipt; tool-selection observations are a different instrument. The proposed publication commitment includes full transcripts and failures and must be approved before the run; no commitment is made here on the owner's behalf.

The editions separate local and deployed proof. G5 and G6 need a verified
deployment and its harness; framework RBAC and tenancy do not supply those
receipts. Edition L scores G1–G4 locally, while Edition D retains its deployment
gates. SABR and time to first working CRM cannot be quoted from Edition L.
The full list of sentences a result does and does not
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
