# ExecPlan — Milestone 13: Delivery Handover (and Custom Package Authoring v1)

**Status: implemented.** Guides: `docs/DELIVERY_HANDOVER.md` and
`docs/PACKAGE_AUTHORING.md`. Decision: ADR-018 addendum 3 in `DECISIONS.md`.

Context: `docs/strategy/DELIVERY_SERVICE.md` (the domain),
`docs/strategy/PLATFORM_CAPABILITIES.md`, `docs/strategy/EXECUTION_ROADMAP.md`,
and Milestone 12, which raised the obligations this milestone consumes.

## Two outcomes in one milestone, deliberately

1. **A public domain-package contract**, proven by a *customer-authored*
   package that attaches with no kernel change.
2. **The Delivery Handover domain**, built as the second first-party package —
   and the first that depends on another package.

They belong together: a contract nobody has used twice is a guess. Delivery is
the second user, and the conformance fixture is the third, written the way a
customer would write it.

## Three architectures compared

**1. Hardcode delivery in the application or the kernel.** Fastest to write,
and it makes delivery non-optional for every project that only wants leads —
directly against ADR-018's core budget rule. It also puts the handover
semantics where no customer can replace them. **Rejected.**

**2. Copy M12's registration by hand for each new domain.** Works, and it makes
every package a snowflake: each one re-derives what a package must declare, and
nothing detects a resource two packages both claim, a dependency that is not
installed, or a cycle. A customer writing their own package would have nothing
to conform to. **Rejected.**

**3. One bounded public package contract, used identically by first-party and
customer packages (chosen).** `definePackage({packageContract, name, version,
resources, actions, policies, requires, capabilities, metadata})`, validated
fail-closed at startup, with cross-package reach only through declared
capabilities. Delivery uses it. The `partner-scorecard` example uses it. The
CLI validates it. The contract is the same object in all three cases.

## What shipped

**The contract** (`packages/core/src/package-registry.js`, exported through the
new public surface `packages/core/index.js`): identity and contract version,
declared resources, declared dependencies and offered capabilities, actions,
fingerprinted policy versions, function-free metadata, and a deterministic
report. It refuses an unsupported contract version, a non-canonical or
prototype-shaped name, a duplicate package or policy identity, a resource or
capability two packages both claim, a missing or mis-versioned dependency, a
self-dependency and a dependency cycle.

**Capabilities** are the only cross-package reach. A capability is created per
call with the *caller's* runtime handles, so it reads and writes inside the
caller's transaction while the provider keeps its services and tables private.
An undeclared reach is refused even when the capability exists, and the
registry hands out no definition and no mutable index, so there is no second
route to the interface. The adversarial review found that it once had two, and
ADR-018 addendum 4 records what is and is not enforced.

**The public kernel surface**: packages import `packages/core/index.js` and
nothing else under `packages/core`. M12 was migrated to it in this PR; the CLI
and the conformance helper both fail a package that reaches into
`packages/core/src`.

**The CLI**: `crm package validate|inspect <dir>` — read-only, the same
validator the application runs at startup, deterministic JSON, non-zero exit,
works from paths containing spaces.

**Delivery** (`packages/delivery`): the handover run, delivery project, work
packages, milestone plan and optional partner engagement, a versioned handover
policy, and the plan/create action pair. It depends on
`contracts/delivery-obligations@1` and on nothing else.

**A capability in contracts** (`packages/contracts/src/capabilities.js`): three
methods — the contract's public facts, its pending obligations, and marking
selected ones handed over. Nothing else crosses.

## Deviations worth naming

| Expected | Shipped | Why |
|---|---|---|
| `domainContract` (M12's field) | `packageContract` | the contract is now a package contract; M12 migrated in the same PR rather than carrying two names |
| handover on the Order | handover on the **Contract** | the obligations belong to the contract, and the contract is what a delivery team is handed |
| a scaffold CLI | deferred, and documented | two packages is not enough evidence for a file shape every customer repository would inherit |
| partner as an entity with access | a **reference and a name snapshot** | M13 grants nobody access, and a model that looks like an account invites the claim |

## Guarantees proven

1. **The contract is usable by a stranger** — a customer-authored package attaches, works over the generic API, and detaches, with every kernel file fingerprinted before and after to prove nothing changed.
2. **Dependency direction is one-way** — kernel → nothing; packages → the public surface; package → package only through a declared capability. Proven by a static import scan, not an assertion.
3. **Optionality** — delivery without contracts refuses to register and names the missing capability; contracts without delivery is untouched; removing a package leaves its data alone.
4. **Atomicity across packages** — fault injection after every write, including the cross-package obligation update, leaves no delivery record and every obligation pending; the retry produces exactly one complete handover.
5. **Idempotency and concurrency** — DB-enforced source keys; one project, one work package per obligation, obligations handed over exactly once, under repeats, a same-app race and two connections.
6. **Who delivers is a decision** — versioned, fingerprinted, from identity the obligation carries; `ambiguous` blocks until a human decides with a reason; both answers are stored.
7. **The partner grants nothing** — validated as a reference and a name, refused when no partner work exists, required when it does, and described as access nowhere.
8. **Planning dates are planning data** — `post-sale-delivery-planning`, both-or-neither, inside the contract term, and nothing fires on them.
9. **Read-only evidence** — all five delivery modules expose `get`/`list` only.
10. **Exact reads** — indexed lookups by contract, project and obligation proven past 500 rows.
11. **Audit, events and trace exactness** — asserted counts including the cross-package update; planning writes none of them.

## Explicitly out of scope

Delivery execution and progress, time and expense, cost, margin, resource
scheduling, change requests, customer acceptance, billing milestones,
invoicing, partner access or portal, revenue share, multiple partners, service
contracts, entitlements, SLA, support cases; a package registry, npm
publication, remote install, auto-update, signing, a marketplace, hot loading
and a package scaffold command; and the extraction of M9–M11 into packages.

## After M15

```text
M13 Delivery package        (this PR)
M14 Delivery Economics      extends the delivery package
M15 Service package         the third distinct package
then: Package Contract Review
  → choose the first legacy extraction
  → migrate ONE of Intelligence / Commercial / Signature
  → characterization tests preserve API, schema, SDK, Admin and data
```

Extraction starts only after three independent packages have exercised the
contract. Nothing in M13 begins it.

## Definition of done

Met: the package contract and its validator, the public kernel surface, the
CLI, the authoring guide and mirrored skill, the conformance fixture and
helper, the delivery package with its capability dependency, the Admin section,
the starter journey, and the test suites above. Still to run per
`docs/QUALITY_GATES.md` §5: the adversarial review, then a human merge.
