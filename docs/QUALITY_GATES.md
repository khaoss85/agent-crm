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
9. **Human merge.** An agent never merges its own milestone PR without an explicit instruction, and never squashes a milestone: regular merge commits keep the history readable.

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
→ clean-clone verification
→ CI green
→ human merge
```

A milestone that skipped the review is unreviewed, not finished — and the PR
body must say so rather than imply otherwise.
