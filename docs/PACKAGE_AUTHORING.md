# Authoring a domain package

How Claude Code, Codex — or a person — adds a bounded domain to an Accordo
repository **without changing the kernel**.

Everything here is the same path the first-party packages use. There is no
private extension mechanism, no plugin API that only Anthropic-shaped packages
get, and no marketplace: a package is checked-in source in your own repository,
registered by one static import.

Reference implementations, in increasing size:

| Package | What it shows |
|---|---|
| [`examples/custom-packages/partner-scorecard`](../examples/custom-packages/partner-scorecard) | the smallest honest package: one resource, one action, one policy — **written as a customer would write it** |
| [`packages/delivery`](../packages/delivery) | a package that **depends on another package** through a declared capability |
| [`packages/contracts`](../packages/contracts) | a package that **offers** a capability to others |

## 1. First decide whether you need a package at all

Most requests do not.

| You need | Use |
|---|---|
| one new object with fields, CRUD, API, Admin and tests | the **module factory** — `npm run crm -- module create <manifest>.json --apply` (`docs/MODULE_FACTORY.md`) |
| one lifecycle step on an existing record | a **record action** in `packages/actions/generated/index.js` (`docs/ACTIONS.md`) |
| one versioned business rule | a **policy** on an existing registry (scoring, discount, activation…) |
| a bounded domain: several related records, its own invariants, its own actions and evidence, installable and removable as a unit | a **domain package** |

A package is justified when it owns **all** of these:

- more than one related resource;
- lifecycle or business invariants that must hold across them;
- actions or workflows that enforce those invariants;
- evidence records that explain what happened and why;
- a meaningful "install it / remove it" boundary.

A single custom object with a couple of fields is a module. Making it a package
adds a registration file, a README, a schema block and a conformance suite in
exchange for nothing.

**Do not** create a package to hold shared helpers, to work around a kernel
limitation, or to "organize" code you already have. If you need a kernel change
to make your package work, that is a missing runtime capability: raise it as
one rather than reaching into `packages/core/src`.

### Then start from a scaffold, not from somebody else's domain

```bash
npm run crm -- package scaffold field-service            # a plan; writes nothing
npm run crm -- package scaffold field-service --apply    # two files
```

You get exactly two files — `src/index.js` and `README.md` — with an identity, a
contract version and five **empty** declarations. That is already a conforming
package: `crm package test packages/field-service` exits 0 on it before you have
typed anything, so every edit you make from here starts from a known-good
baseline instead of from a domain you then have to subtract.

It deliberately generates **no** record, action, policy, capability, provider,
Admin section, Solution Plan or MCP tool. A generated `status` field is a
decision about a business nobody described, and a decision you have to notice
before you can delete it is worse than an empty list. It also does not compose
the package, run a migration, open a database or install anything — see §12.

An occupied directory is refused rather than overwritten, and a name the
registry would reject is refused **with a suggestion** rather than quietly
renamed. It checks the target directory, not the composed application: a name
already registered by another package is refused at startup by the registry, and
`crm app inspect --json` is what shows you that once the package is composed.

Two things worth knowing before you automate it. A plan **reserves nothing** —
`--apply` re-checks the target and answers `TARGET_CLAIMED` if something got
there first. And because a plan and an apply both exit 0, read **`modeReason`**
rather than the exit code to learn whether anything was written; an explicit
`--dry-run` beats `--apply`. An interrupted earlier run blocks nothing: its
staging directory is reported as `staleStaging` for you to remove, never
deleted automatically.

`--into <dir>` puts the package somewhere other than `packages/`; `--json`
gives an agent the plan, its file hashes and a `fingerprint`.
ExecPlan: `docs/plans/dx3-package-scaffold.md`.

## 2. Pick a canonical identity

```js
packageContract: 1        // the contract you are written against
name: 'partner-scorecard' // lowercase, digits and hyphens; unique in the app
version: 1                // your package's own version, a positive integer
label: 'Partner scorecard'
```

The name is a Map key in the registry and a key in `/api/schema`. It is also
what a collision is reported against, so choose something a stranger reading a
stack trace would recognise.

The scaffold still emits contract 1 because the released SQLite factory and
default `accordo serve` are synchronous. `createAccordoAppAsync()` is the
portable SQLite factory: its default graph is an explicit `packageContract: 2`
with no packages, so kernel CRM starts without selecting a customer v1
package as v2. Core can validate a uniform contract-2 fixture, and a v1
package passed onto the portable path refuses with
`PACKAGE_ASYNC_CONTRACT_REQUIRED` before SQLite opens. Do not change this
number in isolation: package, every action, every declared operation and
every offered capability must select the same version, and a mixed graph
refuses startup with the same code. Dual bundled v1/v2 definitions are not
this factory. M2E-2C verifies an offered capability's optional interface
`capabilityContract` against the declaration before a portable HTTP listener
binds, and refuses a thenable standing in for that interface. Default
`accordo serve` remains the synchronous v1 path.

## 3. Declare what you need from other packages

A package may reach another package **only** through a declared capability:

```js
requires: [{ package: 'contracts', capability: 'delivery-obligations', version: 1 }],
```

The registry resolves this at startup. A missing package, a capability the
named package does not offer, a version mismatch or a dependency cycle stops
the application with the missing edge named — never at runtime, inside a
transaction.

To open it (inside an action, where you have `domains`):

```js
const obligations = domains.capability({
  consumer: 'delivery',
  capability: 'delivery-obligations',
  version: 1,
  context: { modules, actor, now },   // YOUR runtime handles
});
```

Because the capability is created with the caller's `modules`, everything it
reads and writes happens **inside the caller's transaction** — a cross-package
commit is atomic without either package sharing a database handle. A package
that did not declare the requirement is refused even when the capability exists
(`CAPABILITY_NOT_DECLARED`), and a declaration naming the wrong provider is
refused too (`CAPABILITY_PROVIDER_MISMATCH`). The registry hands out no
definition and no mutable index, so there is no second route to the same
interface — see "What the contract does and does not enforce" below for the
line this stops at.

Offering one is the mirror image:

```js
capabilities: [{
  name: 'delivery-obligations',
  version: 1,
  capabilityContract: 1,
  description: 'Read pending delivery obligations and mark them handed over.',
  create({ modules, actor, now }) { return { /* the bounded interface */ }; },
}],
```

Expose the smallest interface that does the job. `packages/contracts` offers
three methods and no service, table or query handle — that is the standard.
For compatibility, an omitted `capabilityContract` means 1; registry summaries,
schema metadata and inspection publish the normalized value explicitly. The
capability's `version` describes its domain interface, while
`capabilityContract` describes synchronous-v1 versus awaitable-v2 execution.

## 4. Create package-owned resources

Records are ordinary manifests, applied by the ordinary module factory:

```bash
npm run crm -- module create packages/<name>/modules/<record>.module.json --apply
```

Declare them on the package so a collision is detectable before boot:

```js
resources: ['delivery-project', 'delivery-work-package', 'delivery-milestone'],
```

Two packages claiming one resource is a startup failure. For evidence records —
anything a package writes as the record of a decision — make every field
`"writable": "managed"`: the module then exposes only `get`/`list` publicly and
exists solely through your actions.

### Acting on a record you do not own

A package often needs to act on a record the **project** owns — a `lead`, a
`company`, an `opportunity`. That is a **host-record dependency**, and it is a
different thing from depending on another package.

**Do not list it in `resources`.** `resources` declares what your package
*owns*, and ownership is what makes a second claimant a startup collision. A
package that lists `lead` is claiming the project's record, which is both untrue
and a conflict waiting for the next package that does the same.

| | Host-record dependency | Package dependency |
|---|---|---|
| Example | Intelligence's `score` action targets the project's `lead` | Delivery reads Contracts' obligations |
| Declared as | nothing — the action names the module it targets | `requires: [{ package, capability, version }]` |
| Reached through | the action runtime, which hands you the record and a managed write path | `domains.capability(...)` |
| If it is missing | the action is simply not registered on a module the project does not have | startup fails, naming the unmet edge |
| Listed in `resources` | **no** | no — the *provider* lists its own |

The practical test: *if the customer deleted this record type, would my package
be wrong, or just unused?* If the record is the project's and your package would
simply have nothing to act on, it is a host-record dependency. If your package
would be broken because it needed somebody else's *behaviour*, that is a
capability, and it must be declared.

Removing a package must leave host records untouched. Lead Intelligence's
extraction is the worked example: it owns seven evidence records, declares
`lead` in none of them, and removing the package leaves every Lead intact —
proved in `tests/intelligence-package-absence.test.js`.

## 5. Write actions and policies

An action is an ordinary action definition (`docs/ACTIONS.md`): the same
runtime, transaction, audit, events and trace. Nothing about it is special
because it came from a package.

Execution contract 2 is an all-or-nothing graph choice, not a way to make one
action async inside a v1 package. A v2 package declares `actionContract: 2` on
every action, `operationContract: 2` on every operation and
`capabilityContract: 2` on every offered capability. Its dependency edges must
also resolve to v2 capabilities. Inspection publishes the selected, normalized
version on every package, action, operation and capability, so an agent never
has to infer the running graph from the scaffold default. The kernel-private
accepted-version sets are validation vocabulary, not inspection output.

A versioned decision belongs in a policy with declared JSON-safe `config`, so
its fingerprint (ADR-015) covers the thresholds as well as the code:

```js
policies: [{ kind: 'partner-rating-policy', definition: standardPartnerRatingV1 }],
```

Registering a changed source or config for an existing version stops the next
boot. Publishing a new version is how a decision changes — the old one still
explains the records it produced.

Policy handlers must be deterministic, synchronous and total: no clock, no
network, no database, no randomness, and a deep-frozen input.

## 6. Publish only bounded metadata

```js
metadata() {
  return { scorecardContract: 1, ratings: ['preferred', 'approved', 'watch'], notModeled: [...] };
}
```

`metadata()` is called once at startup and must return plain data. No function,
no credential, no file path, no raw payload — it is served to every client at
`/api/schema`. State what your package does **not** do: a `notModeled` list is
how a reader learns the limits without reading your source.

## 7. Admin

The generated Admin renders package resources automatically (list, detail,
read-only fields). Write a view only when a generic form genuinely cannot do
the job — a plan-then-confirm flow, a decision that needs its reason next to
it. When you do, follow the existing rules: text renders as text, the server
owns every amount, controls disable while a request is in flight, and the
section renders **only** when `/api/schema` publishes your package.

## 8. Register statically

One import, in the checked-in composition file:

```js
// packages/domains/generated/index.js
import { createPartnerScorecardPackage } from '../../../examples/custom-packages/partner-scorecard/src/index.js';

export const generatedDomains = [
  createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),
  createPartnerScorecardPackage(),
];
```

That file is the only place a project names its packages. Deleting the line
removes the package: its actions disappear from the schema, its Admin section
disappears with them, and its data is left alone — the framework never drops
your tables behind you.

There is **no** dynamic loading, no request-controlled import, no `eval`, no
remote install and no marketplace. A package is source you can read in your own
repository, and that is the security model.

### What the contract does and does not enforce

The package contract is **fail-closed against accidents**, not a sandbox
against hostile code. Concretely, it enforces:

- the registry keeps its own indexes private, so no package can mutate the
  composition at runtime;
- `domains.get(name)` returns a frozen public summary — never a definition, and
  never another package's `create()` or policy handlers;
- a capability opens only for a consumer that declared it, from the package the
  declaration named;
- `metadata()` may add to the schema block but may never restate what the
  registry computes (`version`, `resources`, `requires`, `provides`, `actions`,
  `policies`…), and must be plain, function-free data.

It does **not** enforce, and must not be described as if it did:

- the consumer name passed when opening a capability is asserted by the caller.
  A package that deliberately names another package as the consumer is a
  trusted-source problem, not something the runtime can distinguish;
- nothing sandboxes a package's module body, its actions or its policies. They
  run in-process with full authority;
- `package validate` executes the source it validates (see §9).

## 9. Validate before you boot

```bash
npm run crm -- package validate packages/delivery
npm run crm -- package inspect packages/delivery
```

Both run the same validator the application runs at startup and exit non-zero
on any problem. `inspect` adds the function-free metadata the schema would
publish. Neither writes a file, opens a database or reaches the network, and
neither prints an absolute path.

**They are not static analysis, and not a sandbox.** Reading a code-first
definition means importing your `src/index.js`, so your module body runs with
the command's full authority — it can write files, open sockets and read the
environment, exactly as it would at boot. That is the same trust boundary as
the composition file: repository source is trusted. Point these commands only
at a package you would be willing to boot.

They check identity and contract version, resource and capability collisions,
duplicate policy identities, dependency declarations — and that no file in your
package imports a private kernel path, in any quote style and through
`import()` and `require()` as well as a static `from` clause.

## 10. The public kernel surface

A package imports from **`packages/core/index.js`** and nothing else under
`packages/core`:

```js
import { definePackage, AppError, ValidationError, requiredString } from '../../core/index.js';
```

**`packages/core/index.js` is the authoritative list** — read the file, not this
paragraph. What follows orients you; an enumeration copied into prose drifts
from the file the moment an export lands, and this one had already drifted
before it admitted it.

Broadly, what is public: the package contract (`definePackage`,
`validatePackageDefinition`, `PackageRegistry`), the error types, the framework
clock and bounded outbound calls, run traces, the canonical actor authority and
identity normalization, the declared-definition fingerprint helpers **and the
definition-version store that persists them** (`createDefinitionVersionStore`),
the money helpers and bounds, the shared value validators, the Solution Plan and
implementation-evidence contracts, and the Production Spine v1 identity, runtime
mode, authorization and tenancy exports.

The definition-version store is the newest of these and the least self-evident,
so it earns a line of its own: it is how a package records each `{type, name,
version, fingerprint}` at startup and refuses the boot when a registered
version's source has moved underneath it (ADR-015). It is the other half of
`computeDefinitionFingerprint` — a package that hand-rolls the persist-or-verify
loop re-implements the rule that decides whether the application starts, and the
one sentence a person reads at boot becomes several that disagree.

**And its limitation, in the same breath.** The store writes to
`definition_versions` with **no actor context and no audit event**. Almost every
other write in this framework carries both; this one does not. It is startup
identity, recorded before any actor exists, and the gap predates the store — the
four registries it replaced each wrote the same rows the same way. So it is
**not a general persistence path**, and it is not the precedent to copy when your
package needs to write something a person did: use a module service or a named
workflow for that, so validation, actor identity, audit and trace travel with the
write. Giving definition-version registration an actor and an audit row is
sequenced work, not a gap to route around
(`docs/plans/spine-v2-m2b-definition-version-store.md`).

Everything in `packages/core/src/*` is **private**. It changes without notice,
and `package validate` fails a package that reaches into it. If you need
something that is not exported, say so in an issue: the answer is either a new
public export or a missing runtime capability, never a deep import.

Within your own package, import freely — but never reach into another
*package's* private source either. That is what capabilities are for.

## 11. Prove conformance mechanically

```bash
npm run crm -- package test packages/<your-package> --json
```

`crm package test` (DX4) answers one question — **does this package satisfy the
framework's generic package contract and integration invariants?** — by
composing it into a throwaway copy of your project and booting an application
twice, once with it and once without.

It is not the same question as the other three:

```text
package scaffold   give me an empty package that already conforms
package validate   is this declaration structurally valid?
package inspect    what does this package declare, own, offer and need?
package test       does it hold up when a real application composes it?
```

What it proves, from the framework's own machinery rather than a second
implementation of it: the declaration validates and the contract version is
supported · metadata is data, function-free, bounded and identical twice · every
policy carries a fingerprint · no source reaches into `packages/core/src` or
another package's private `src/` · no `eval`, `new Function` or dynamic import ·
a duplicate registration, a resource collision, a capability collision, **every**
unmet dependency and an undeclared reach are all refused · every module manifest
applies with a valid state file and unique migration identities · the
application boots with the package, registers every declared action against a
real generated module and opens every declared capability · `crm app inspect`
describes the same package the declaration does · and the whole surface
disappears when the package is removed from the composition.

Every check row names the **authority** it speaks for — `package-contract`,
`composition`, `authoring-rule`, `module-factory`, `application-boot` or
`app-inspect`. There is deliberately no `dx4` authority: a rule this command
would have had to invent is either advisory or absent, because a conformance kit
that invents rules is a second, undocumented package contract.

**One rule is worth reading before you write an action.** If your action targets
a record another *package* owns, declare a capability of that package in
`requires`. Without it your package cannot be composed into any project that
lacks the owner, and nothing in your declaration says so — `package test` fails
it with `UNDECLARED_PACKAGE_RECORD_DEPENDENCY` and names the capabilities the
owner does offer. Records that **no** package owns are different: those belong to
the host application, every package here acts on `order`, and depending on them
needs no declaration.

What it deliberately does **not** prove is listed by code in every report:
`DOMAIN_CORRECTNESS_NOT_PROVEN` first among them. No action is executed, no
policy is evaluated, no state transition is driven and no provider is contacted.
Those are your package's own tests.

**Trusted source, isolated execution, not a sandbox.** Every import and every
boot happens in a child process, in its own process group, under a timeout, with
the report on file descriptor 3 so a package that prints cannot corrupt it. Your
project is never written to and your database is never opened. The child still
holds your authority.

Exit codes: `0` conforms · `1` conformance failures · `2` the package or the
project could not be read.

## 12. Tests, example and evidence

- Reuse `tests/helpers/package-conformance.js` for the checks every package
  shares: contract metadata, public imports only, dependency resolution,
  deterministic function-free schema, collision handling. It and
  `crm package test` share one private-import rule and one source walk
  (`packages/cli/src/package-sources.js`), so they cannot drift apart.
- Add an end-to-end test that boots a real project with your package applied
  and drives your action over the real HTTP/SDK path.
- Prove optionality: the same project without your package must boot and
  behave identically.
- Update `docs/benchmarks/CRM_JTBD_MATRIX.md` **conservatively**. A row moves
  only with linked evidence, and "the data model exists" is not "the job is
  done".
- Ship a README next to your package: what it owns, what it needs, how to
  enable it, and what it deliberately does not do.

## 13. Submit for review

The whole path, end to end:

```text
crm app inspect        what does this application already have?      (AX1)
crm solution check     does my plan still match it?                  (AX2)
crm package scaffold   an empty package that already conforms        (DX3)
  edit                 records, actions, capabilities, policies — by hand
crm module create      each record you own, from its manifest
crm package validate   is the declaration structurally valid?
crm package inspect    what does it declare, own, offer and need?
crm package test       does it hold up when an application composes it? (DX4)
  your own tests       is the DOMAIN right? nothing above answers this
  compose              one import, added by hand, deliberately
```

Run `crm package test` on your package, `npm run verify` from a clean clone, run the starter, then open a PR and
leave it open for the adversarial review in `docs/QUALITY_GATES.md` §5. The
review will attack your package's boundary, its atomicity and its claims — the
same way it attacks first-party ones.


## 14. Official packages are reference implementations, not a framework tax

The first-party packages (`contracts`, `delivery`, and the planned Marketing
packages in `docs/strategy/MARKETING_GROWTH_OPERATIONS.md`) attach through the
contract on this page and no other. That has a consequence worth stating:

- an official package is **optional** — take it, or don't;
- you may **replace** one with your own. Keep `marketing`, write your own
  `journeys`; or collapse the lot into a single custom Growth package for your
  business;
- you may write **custom channel or provider packages** for anything nobody
  upstream has adapted, with no kernel patch;
- you may **extend** any package with your own resources, actions and policies.

A package that needs consent state, funnel metrics or durable enrolment declares
a **capability** for it — governance, analytics, durable automation — rather than
reaching into another package's tables. If the capability does not exist yet,
that is a missing runtime capability to raise, not a deep import to write.

Two rules no package may bend, official or custom: **nothing bypasses human
approval, consent, audit or the provider boundary**, and **trusted checked-in
source is not sandboxed** (ADR-018 addendum 4). A package that sends, publishes
or spends without a recorded human approval is a defect regardless of who wrote
it.

*(No Marketing package exists today. The packages named above are planned
identities, not shipped code, and a future Marketing authoring Skill is planned
rather than implemented.)*

## 15. When an agent is working from a business goal

A package is often the answer an agent reaches when a user states an *objective*
rather than a change — "track our funnel by acquisition channel" resolves to
reused packages plus, sometimes, one new custom package. The rules do not
change, and two of them matter more in that mode:

- **Discover before you create.** `crm app inspect --json` (AX1) says what this
  application already is; `crm package inspect` and `GET /api/schema` say what
  one package provides. Duplicating an existing domain is the most common
  failure, and it is the one inspection exists to prevent.
- **Report what you could not build.** A package that silently omits the part
  of the goal it had no capability for is worse than one that names the gap.

See `docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md` and the
`solve-business-goal` Skill.

## Moving an existing domain into a package

Three domains — Lead Intelligence, Commercial Operations, and Signature & Order
— predated this seam and have each since been extracted onto it, LA0-first,
with zero asserted characterization observations moved (PRs #38, #79, #84).
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records no `needs_extraction`
row today; the closed entries stay in the matrix as the record of the
structural gap they described, which no amount of care inside a core file
could close.

**Do not extract one as part of another piece of work.** A behavior-preserving
extraction is its own PR, its own review and its own acceptance criterion, and
it is sequenced:

```text
1.  M14b2, reviewed and merged                                   done
2.  M15 — Service, built on this seam                            done
3.  review the M15 learnings: what the seam still cannot express done
4.  DX4 (`crm package test`) — mechanical conformance            done
5.  DX3 (`crm package scaffold`) — a conforming starting point   done
6.  one controlled extraction, one domain, one PR                not started
```

Steps 3 and 4 are not ceremony. Contracts and Delivery are two data points and
only Delivery has *consumed* another package's capability; Service is the third
and the first built with a mature seam. And an extraction whose only proof is
"the existing tests still pass" is exactly the proof that misses a boundary
violation — DX4 is what makes conformance mechanical rather than argued.

When the time comes, the acceptance criterion is **behavior preservation, proved
from the outside**: every historical decision the domain recorded still
reproduces identically, the same actions answer on the same routes, the audit
and trace shape is unchanged, and the package detaches cleanly. A "cleaner"
extraction that changes one recorded outcome has failed.

`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records Lead Intelligence as the
**working hypothesis** for the first extraction, with the evidence that must
exist first. It is a hypothesis, and nothing in this guide authorizes starting.

## What is deliberately not here yet

- **A scaffold that generates domain semantics.** `crm package scaffold` ships
  (§1), and it deliberately stops at an identity. A record still needs a
  manifest and `crm module create`; an action, a capability and a policy are
  still yours to write. Generating the wrong skeleton into every customer
  repository is harder to undo than typing two files.
- **A registry, npm publication, remote install, auto-update, signing or a
  marketplace.** Packages are checked-in source. Distribution is a separate
  problem with a separate threat model, and none of it is needed to author a
  package today.
- **Hot loading.** Registration is static and composed at startup, on purpose.

## Seeing your package in the application

`crm package validate|inspect <dir>` reads one package in isolation. Once it is
registered in `packages/domains/generated/index.js`, `crm app inspect --json`
shows it as part of the whole composition — its resolved capability edges, the
records it owns and their revisions, its actions and its policy fingerprints —
and reports every collision, missing dependency or cycle deterministically
rather than stopping at the first fault. Guide:
`docs/APPLICATION_INSPECTION.md`.

## Related

`ARCHITECTURE.md` (domain packages) · ADR-018 and its addenda in `DECISIONS.md`
· `docs/MODULE_FACTORY.md` · `docs/ACTIONS.md` · `docs/APPLICATION_INSPECTION.md` ·
`docs/QUALITY_GATES.md` · `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` ·
`docs/architecture/AGENT_TOOL_SURFACE.md` ·
`.claude/skills/build-custom-domain-package/SKILL.md` (mirrored at
`.agents/skills/build-custom-domain-package/SKILL.md`).
