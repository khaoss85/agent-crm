# create-accordo

**The project bootstrap.** It turns an empty directory into a runnable Accordo
CRM project — deterministically, offline, and with nothing installed.

```bash
node packages/create-accordo/bin/create-accordo.js my-crm            # plan; writes nothing
node packages/create-accordo/bin/create-accordo.js my-crm --apply    # write the project
node packages/create-accordo/bin/create-accordo.js my-crm --json     # the contract
```

## Two facts that must never be confused

- **True:** `create-accordo` scaffolds a working project **from this
  repository**. Run from a checkout, it produces a project that boots, reports
  `valid` from `accordo app inspect --json` and exits 0 from
  `accordo project doctor --json`. `tests/project-bootstrap.test.js` proves it
  by doing exactly that in a temporary directory.
- **Also true:** `npm create accordo` **installs nothing**. The package
  published under that name is the empty `0.0.1` name reservation, and this
  repository publishes nothing. Until a human publishes the real package, no
  document here may say that `npm create accordo` creates a project.

The command says the second of those in its own output, as the limitation
`PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD`, so a reader who never opens this file
still gets told.

`site/brand.json` holds both facts as separate fields — `npm.status`
(the registry) and `npm.sourceScaffolds` (this tree) — and
`scripts/distribution-check.js` fails the build if either drifts from the
repository it describes.

## What it produces

The framework source (`packages/`, `apps/`, `skills/`, `examples/modules/`)
copied verbatim, plus ten generated files: a `package.json`, a `README.md` and
an `AGENTS.md` written for that project, `.gitignore`, `.env.example`,
`.mcp.json`, `data/.gitkeep`, and the project's own `scripts/check.js`,
`scripts/smoke.js` and `tests/project.test.js`.

The generated project needs **no `npm install`** — the framework has no
third-party runtime dependencies — and its own tests assert that it boots, that
an agent actor still cannot take a human approval decision, and that it composes
zero domain packages.

## What it deliberately does not do

- **No network.** Nothing is fetched, downloaded, installed, published or
  registered. The project is a copy of source that was already on this disk.
- **No domain composition.** `packages/domains/generated/index.js` ships empty,
  exactly as it does here. A domain arrives when a human adds one import.
- **No database, no migration, no server.** It writes files and stops.
- **No guessing.** It refuses a non-empty target, a target that is not a
  directory, a target overlapping the framework source, and an invalid project
  name — the last with a suggestion it never applies.
- **It never imports the framework.** This is the one command that must run
  before the framework exists on the caller's disk, so it is standalone Node
  with a local canonical-JSON serializer. When no framework source is found it
  reports `FRAMEWORK_SOURCE_UNAVAILABLE` and exits 2 rather than crashing —
  which is precisely what the published placeholder does today.

## Contract and exit codes

`projectBootstrapContract: 1`. `--json` is the contract; the text view is a
convenience.

```text
0   the plan is clean, or --apply wrote the project
1   refused because of the request      (bad name, non-empty target, …)
2   refused because of the environment  (no framework source, no target given)
```

A full report is printed in every case, including both refusals.

## Publishing is a human decision

This manifest is `private: true`, and npm refuses to publish a private package.
That is deliberate: it is what makes an accidental publish impossible from this
repository. Turning the reservation into a real package means a person
decides to, and in the same commit:

1. removes `private` from `packages/create-accordo/package.json`;
2. adds a `files` array that carries the framework source the bootstrap copies,
   because a tarball without it resolves `FRAMEWORK_SOURCE_UNAVAILABLE`;
3. updates `site/brand.json` → `npm.status` (`scripts/distribution-check.js`
   fails while that status and this manifest disagree);
4. publishes with `--provenance`.

Nothing in this repository performs any of those steps.
