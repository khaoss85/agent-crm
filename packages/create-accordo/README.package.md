# create-accordo

Create a local Accordo CRM project that a coding agent can inspect, extend and
verify as source you own.

```bash
npm create accordo my-crm -- --apply
cd my-crm
npm run verify
npm run crm -- app inspect --json
```

Without `--apply`, the command prints a deterministic plan and writes nothing.
Use `--json` for the versioned machine-readable contract.

The package carries the framework source it copies, so project creation needs no
network request after npm has installed this package and the resulting project
needs no `npm install` for its default SQLite path. The copied PostgreSQL adapter
requires `npm install` for the declared exact `pg@8.23.0` dependency and explicit
deployment configuration. The project includes the CLI, local HTTP application,
Admin, published coding-agent skills, its own tests and smoke check. It starts
with zero domain packages composed; the coding agent adds only the business
model the user describes.

## What the package proves

The release gate installs the packed artifact into an empty npm project, runs
this installed bin, and then runs the generated result. A successful release
proves:

- `accordo app inspect --json` reports a valid composition;
- `accordo project doctor --json` passes with no warning;
- the generated project's tests prove an agent cannot take a human approval
  decision;
- its smoke workflow runs end to end;
- the same checked-in source produces a byte-identical package archive.

The archive includes `framework-source.json`: the package version, SHA-256
inventory of every copied framework file and its combined fingerprint. The
bootstrap JSON report returns the same fingerprint. This identifies the bytes;
registry origin and signing are verified separately through npm provenance.

## Boundaries

The generated application is local-development software, not a hosted CRM:

- no authentication ships, and a deployment must supply the verifier;
- SQLite by default; dedicated-database PostgreSQL source is also included;
- durable jobs, transactional outbox and scheduled timer consumers are source
  capabilities: workers must be explicitly composed and started;
- secret-provider, backup and telemetry contracts need application configuration;
  no managed custody or telemetry backend ships;
- business provider implementations are offline fixtures;
- zero domain packages are composed by default;
- source is vendored into the project, so upgrading means merging source rather
  than bumping a dependency version.

The package is not a CDP, an AI CRM that makes runtime decisions, a billing
engine or an ERP. Coding agents author deterministic CRM behavior; state changes
still pass through services, workflows and explicit human boundaries.

Source, evidence and limitations: <https://accordo.dev> ·
<https://github.com/khaoss85/agent-crm>
