# Authoring a domain package

How Claude Code, Codex — or a person — adds a bounded domain to an Agent CRM
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
  description: 'Read pending delivery obligations and mark them handed over.',
  create({ modules, actor, now }) { return { /* the bounded interface */ }; },
}],
```

Expose the smallest interface that does the job. `packages/contracts` offers
three methods and no service, table or query handle — that is the standard.

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

## 5. Write actions and policies

An action is an ordinary action definition (`docs/ACTIONS.md`): the same
runtime, transaction, audit, events and trace. Nothing about it is special
because it came from a package.

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

What is public today: the package contract (`definePackage`,
`validatePackageDefinition`, `PackageRegistry`), the error types, the
declared-definition fingerprint helpers, the money helpers and bounds, and the
shared value validators.

Everything in `packages/core/src/*` is **private**. It changes without notice,
and `package validate` fails a package that reaches into it. If you need
something that is not exported, say so in an issue: the answer is either a new
public export or a missing runtime capability, never a deep import.

Within your own package, import freely — but never reach into another
*package's* private source either. That is what capabilities are for.

## 11. Tests, example and evidence

- Reuse `tests/helpers/package-conformance.js` for the checks every package
  shares: contract metadata, public imports only, dependency resolution,
  deterministic function-free schema, collision handling.
- Add an end-to-end test that boots a real project with your package applied
  and drives your action over the real HTTP/SDK path.
- Prove optionality: the same project without your package must boot and
  behave identically.
- Update `docs/benchmarks/CRM_JTBD_MATRIX.md` **conservatively**. A row moves
  only with linked evidence, and "the data model exists" is not "the job is
  done".
- Ship a README next to your package: what it owns, what it needs, how to
  enable it, and what it deliberately does not do.

## 12. Submit for review

Run `npm run verify` from a clean clone, run the starter, then open a PR and
leave it open for the adversarial review in `docs/QUALITY_GATES.md` §5. The
review will attack your package's boundary, its atomicity and its claims — the
same way it attacks first-party ones.

## What is deliberately not here yet

- **A scaffold command.** `crm package new <name>` will exist once Delivery and
  Service have taught us the stable file shape. Generating the wrong skeleton
  into every customer repository is harder to undo than typing four files, so
  the decision waits for evidence.
- **A registry, npm publication, remote install, auto-update, signing or a
  marketplace.** Packages are checked-in source. Distribution is a separate
  problem with a separate threat model, and none of it is needed to author a
  package today.
- **Hot loading.** Registration is static and composed at startup, on purpose.

## Related

`ARCHITECTURE.md` (domain packages) · ADR-018 and its addenda in `DECISIONS.md`
· `docs/MODULE_FACTORY.md` · `docs/ACTIONS.md` · `docs/QUALITY_GATES.md` ·
`.claude/skills/build-custom-domain-package/SKILL.md` (mirrored at
`.agents/skills/build-custom-domain-package/SKILL.md`).
