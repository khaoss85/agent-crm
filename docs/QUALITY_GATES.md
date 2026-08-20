# Quality gates

The review discipline that produced Milestones 6–11 written down as repository
policy, so it stops depending on the length of a one-off prompt. Agents:
`.claude/skills/adversarial-review/SKILL.md` (mirrored at
`.agents/skills/adversarial-review/SKILL.md`) is the executable form of §2.

## 1. Every feature PR

1. **ExecPlan before implementation.** `docs/plans/milestone-N-*.md`, comparing at least three approaches and saying why the chosen one wins. Written before code, not after.
2. **Clean baseline first.** `npm install && npm run verify && npm run smoke` on the branch point. A failure inherited from `main` is found before, not blamed after.
3. **Scoped branch and PR.** One milestone per branch; the diff contains that milestone and its declared touchpoints, nothing else.
4. **No hidden architecture changes.** A change to a shared contract (runtime, registry, HTTP envelope, manifest) is called out in the PR body and, if it is a decision, gets an ADR.
5. **Documentation and ADR updates in the same PR.** A guide, the plan, the ADR and the agent skill move together with the code.
6. **Conservative JTBD update.** Status changes only for what the merged tests prove; narrow wording; "not supported" is the default (§3).
7. **Clean-clone verification.** Fresh `git clone`, fresh `npm install`, then `verify`, `smoke`, the starter from an empty project, and the browser smoke where supported.
8. **No secrets or artifacts.** No `.env`, database, log, build output, browser profile, webhook capture, signed file, generated starter output or `node_modules` in the tree.
9. **Compatibility Backfill Rule.** A PR that introduces or changes a **horizontal** capability — one every domain could use — records every existing domain's status against it in `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, using `aligned | partial | deferred | not_applicable | needs_extraction` with a one-line reason, and names the closing milestone for anything `deferred`. **Declaring the gap is mandatory; closing it in the same PR is not** — retrofitting five domains inside a feature PR is how a feature PR stops being reviewable. A capability only the newest domain has, that nobody wrote down, is a fork rather than a platform. A missing row is a review blocker in the same way a missing test is.
10. **Human merge.** An agent never merges its own milestone PR without an explicit instruction, and never squashes a milestone: regular merge commits keep the history readable.
11. **Parallel agents, and the integrator pass.** When more than one coding agent works a wave, the rules live in `AGENTS.md` → *Parallel coding agents* and are not duplicated here: separate sibling worktrees **outside** the repository, one branch owner per worktree, and one final integrator that reconciles the shared-truth files every branch touched. The integrator pass is a gate, not a courtesy — a merge that resolves a conflict inside a *measured* record discards a measurement without failing anything, which is how `site/claims.json` came to run a whole wave behind the suite with every check green.

## 2. Adversarial review categories

Run against every milestone before it merges. A category that does not apply is stated as not applicable — never silently skipped.

| Category | What it means in this repository |
|---|---|
| Public-boundary bypass | Can a client set through CRUD/HTTP/SDK/MCP/Admin what only an action may set? Read-only modules must 404 on `POST`/`PATCH` even with an empty body. |
| State-machine algebra | An explicit allowed-transition table, not a rank. Terminal states never regress. Contradictory input is recorded and ignored, with a reason. |
| Transaction and fault injection | Inject a failure after *every* significant write. Everything rolls back, no orphan rows, no fake success audit, and the retry produces exactly one complete result. |
| Idempotency | Deterministic keys; a repeat is refused or resolves identically; a semantic mismatch behind the same key fails closed rather than being adopted. |
| Two-connection concurrency | Two app instances or two connections on one database: one winner, no lost update, no raw SQLite error surfaced. |
| Exact query beyond page bounds | Every correctness read is an indexed exact query; prove it past 500 rows. Paged lists are display bounds only. |
| Immutable / read-only boundaries | Snapshots are never rewritten by later movement in their source. Prove it by changing the source and re-reading the snapshot. |
| Provider timeout and late settlement | Bounded timeout, timer cleared, late settlement observed and abandoned, no unhandled rejection, stable normalized error, no payload or secret in it. |
| Replay and reconciliation | Replay scope stated (identity **and** payload); a failed delivery resumes; recovery is explicit and never duplicates evidence. |
| Hostile input | `__proto__`, `constructor`, `prototype`, markup, quotes, backticks, `${…}`, newlines, Unicode separators, null bytes, oversized strings — across every provider, payload, field and route. No pollution, no unsafe HTML, no route confusion, no SQL interpolation. |
| Schema compatibility | `/api/schema` additions are additive and function-free; no secret, handler, raw payload or storage path. |
| Backward compatibility | Existing manifests, starters, routes and SDK calls keep working; migrations are versioned and forward-only. |
| Audit / event / trace exactness | Assert **counts**, not presence. A replay creates none. A post-commit dispatch failure stays a business success and is visible separately. |
| Browser behavior | Real Chromium: controls appear only in valid states, no double submit, values render as text, stale renders discarded, refresh-safe routes. |
| Documentation truthfulness | Every claim in a doc, ADR, PR body or JTBD row traces to a merged test. Limitations are stated in the same breath as capabilities. |

## 3. JTBD status vocabulary

Only four values, and the burden of proof is on the higher one:

- **not supported** — the default for anything new.
- **partially supported** — a real slice works; the missing part is named.
- **technically supported** — the primitives exist but the job has not been proven end to end.
- **validated end to end** — a merged test drives the whole job, and the row lists the evidence.

Never infer a status from an isolated primitive.

## 4. Production gates (future, not met today)

Each is a hard gate before public multi-user use; none exists yet.

- PostgreSQL conformance suite (same tests, both adapters).
- Browser E2E in CI (today it is manual — the largest coverage gap).
- Coverage threshold enforced in CI.
- Mutation tests for versioned policies (scoring, routing, discount).
- Property-based tests for pricing arithmetic and state machines.
- Fuzzing for the webhook route and the URL router.
- Dependency and security scanning in CI.
- Backup and restore rehearsal.
- Tenant-escape tests.
- Permission-matrix tests once RBAC exists.

## 5. Definition of a complete milestone

A milestone is **not** complete because its happy path works:

```text
implementation
→ adversarial review
→ fixes in-place, with regression tests
→ compatibility backfill declared (§1.9)
→ clean-clone verification
→ CI green
→ human merge
```

A milestone that skipped the review is unreviewed, not finished — and the PR
body must say so rather than imply otherwise.

## 6. Repository truth: what is checked mechanically, and what is not

Documentation truthfulness (§2) is a review category, and a review category is a
person. Two of its failures happen without anyone lying, so they are checked by a
script inside `npm run gtm:check` instead (`scripts/measurement.js`,
`scripts/site-check.js`, driven by `tests/repository-truth.test.js`):

| Checked | How |
|---|---|
| `docs/PROJECT_STATUS.md` names the commit the public numbers were measured at | its `Measured at` row must equal `site/claims.json` `measuredAgainst.sha`, as a literal string |
| no document types a test count | the loose-count scan covers `site/`, `README.md` and now **every document under `docs/`**, except a short, named list of dated-history files |

Both are deliberately narrow, and the boundaries are as much of the gate as the
rules:

- **Neither reads prose.** One compares two strings; the other matches a numeric
  pattern. Nothing infers whether a sentence is true, so a status file can be
  wrong in every other row and still pass. §2's documentation-truthfulness
  category is still the only thing that reads meaning, and it is still a person.
- **Neither is a new agent-facing command.** There is no `accordo status`, no new
  namespace, and nothing added to the surface budget (`npm run surface:check`).
- **Neither leaves this repository.** A generated project has no status file and
  no ledger.
- **A moved corpus is still advisory.** When `tests/` changes after a
  measurement, the gate *notes* that the recorded count describes an older commit
  and does not fail. Failing there would block every PR that adds a test until it
  re-ran the suite, which is a worse outcome than a note. Re-measure before
  publishing: `node scripts/measure-suite.js --apply` on a clean tree.
- **Residual, stated rather than hidden:** a robust check that the *rest* of
  `PROJECT_STATUS.md` is current — the milestone row, the open-PR row, the CI row
  — needs a source of truth this repository does not have offline. It stays the
  integrator's job under §1.11, and `docs/PROJECT_STATUS.md` → "Future
  automation" records the tool that would close it.

### 6.1 The Repository Truth Contract — `npm run repo:truth` (ADR-039)

The two gates above compare **documents to documents**. That is exactly how the
failure this section was extended for got through: after Production Spine v1
changed the runtime, the status file, the JTBD matrix, the claims ledger and the
scenario limitation metadata stayed mutually consistent **and stale together**,
and every gate was green. One instance published a limitation code for a gap that
ADR-038 Amendment 2 had already closed by binding, and a person found it, not a
gate.

<!-- truth: retired-code TENANT_ISOLATION_NOT_ENFORCED — named once as the code that survived its own fix. History, not an assertion about this repository. -->

So a third gate compares **documents to the code**:

```console
npm run repo:truth              # regenerate docs/repository-truth.json
npm run repo:truth -- --check   # fail when the repository and the facts disagree
```

| Checked | How | Fails with |
|---|---|---|
| the generated fact document is current | the committed `docs/repository-truth.json` must equal a fresh generation from its authorities | `TRUTH_DOCUMENT_STALE` |
| a current document cites a real fact | `<!-- truth: <factId>=<value> -->` in Markdown, a `facts` array of the same text in JSON, `// truth: <factId>=<value>` in a bound `.js` source file | `TRUTH_FACT_UNKNOWN` |
| a cited value is the one the code produces | a reversed polarity is a value that differs, so it is the same failure | `TRUTH_FACT_VALUE_STALE` |
| every machine code in a bound document still exists | the vocabulary is harvested from `packages/`, `scripts/`, `apps/`, `examples/` and `benchmarks/`, minus `RETIRED_CODES` | `TRUTH_CODE_UNKNOWN` |
| the measured commit is an ancestor of `HEAD` | `git merge-base --is-ancestor`; object existence is not provenance (ADR-027) | `TRUTH_MEASUREMENT_NOT_ANCESTOR` |
| an authority that cannot be read stops the run | no fact is defaulted, and two authorities that disagree publish neither answer | `TRUTH_AUTHORITY_UNAVAILABLE`, `TRUTH_AUTHORITIES_CONTRADICT` |

**In a feature PR.** `npm run repo:truth -- --check` runs on every push and every
pull request, as its own step in the `public-claims` CI job. Run it locally when
the PR changes a product boundary, a rail, a package's contract, the spine, or
any sentence in a bound document that states what the framework does or does not
do. If a fact moved, run `npm run repo:truth` and commit the regenerated document
in the same PR — a regenerated fact and a stale sentence citing it fail together,
which is the point.

The boundaries, which are as much of the gate as the rules:

- **It runs in `public-claims`, not in `verify`.** Its measurement checks need
  full git history; `public-claims` is checked out with `fetch-depth: 0` and the
  `verify` job deliberately is not. It is a separate step rather than a member of
  `npm run gtm:check`, because `gtm:check` is also run locally in a clone that may
  be shallow. The history-free half is covered by `verify` too, through
  `tests/repository-truth-contract.test.js`, which asserts the refusal rather than
  skipping when history is absent.
- **It is not an Accordo rail and not a product command.** Nothing is added to
  the surface budget, no Skill names it, and it never leaves this repository.
- **It reads no prose and writes none.** A fact id constrains what a bound
  sentence may assert; it does not produce the sentence, and a sentence carrying
  no citation is not checked at all.
- **No JTBD row is a fact.** §3 is a person reading merged tests, and it stays
  one.
