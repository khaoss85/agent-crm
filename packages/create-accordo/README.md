# create-accordo

**The project bootstrap.** It turns an empty directory into a runnable Accordo
CRM project — deterministically, offline, and with nothing installed.

```bash
node packages/create-accordo/bin/create-accordo.js my-crm            # plan; writes nothing
node packages/create-accordo/bin/create-accordo.js my-crm --apply    # write the project
node packages/create-accordo/bin/create-accordo.js my-crm --json     # the contract
```

## Three facts that must never be confused

- **True:** `create-accordo` scaffolds a working project **from this
  repository**. Run from a checkout, it produces a project that boots, reports
  `valid` from `accordo app inspect --json` and exits 0 from
  `accordo project doctor --json`. `tests/project-bootstrap.test.js` proves it
  by doing exactly that in a temporary directory.
- **Also true:** this repository assembles a bounded publication candidate.
  `npm run distribution:assemble-create -- <outside-dir> --apply --json`
  emits it without changing this private source manifest. The package test packs
  it twice, compares the tarballs byte-for-byte, installs one offline and runs
  the generated project's inspect, doctor, tests and smoke.
- **Still true:** `npm create accordo` **installs nothing**. The package
  published under that name is the empty `0.0.1` name reservation, and this
  repository publishes nothing. Until a human publishes the real package, no
  document here may say that `npm create accordo` creates a project.

The command does not infer registry origin from nearby bytes. Its limitation
`SOURCE_ORIGIN_NOT_VERIFIED` says that finding bundled framework source does not
prove whether npm served it or whether a provenance attestation exists.

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

The generated project needs **no `npm install` for SQLite** — Node's built-in
adapter — and its own tests assert that it boots, that an agent actor still
cannot take a human approval decision, and that it composes zero domain
packages. PostgreSQL requires the pinned `pg@8.23.0` driver and is not selected
by the generated project.

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
  which is precisely what an incomplete package does.

## Contract and exit codes

`projectBootstrapContract: 1`. `--json` is the contract; the text view is a
convenience.

```text
0   the plan is clean, or --apply wrote the project
1   refused because of the request      (bad name, non-empty target, …)
2   refused because of the environment  (no framework source, no target given)
```

A full report is printed in every case, including both refusals.

## Publishing is a human-approved staged decision

This source manifest remains `private: true`, so `npm publish` from the source
tree is refused. `scripts/assemble-create-accordo.js` instead creates a separate
public manifest and copies only the declared bootstrap and framework surfaces.
It is dry-run by default and refuses output inside this repository.

`.github/workflows/stage-create-accordo.yml` is manual-only, refuses a commit
other than reviewed `main`, verifies the repository, assembles twice and uses
npm trusted publishing to **stage** the candidate. A human must configure the
matching npm trusted publisher and approve the staged version with 2FA. Only a
live registry receipt may change `site/brand.json` → `npm.status: published` or
make the public sentence “`npm create accordo` works” true.
