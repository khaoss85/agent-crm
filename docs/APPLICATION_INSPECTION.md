# Application inspection (AX1)

One deterministic document describing the application a project has actually
composed — installed packages, the resolved capability graph, records and their
revisions, actions, policies, providers, and everything the inspector cannot
know.

```bash
npm run crm -- app inspect            # human view
npm run crm -- app inspect --json     # the machine-readable report
```

It exists because assembling that picture by hand takes five surfaces —
`crm package inspect` once per package, `/api/schema` from a running server, the
checked-in composition file, each package README, and `PROJECT_STATUS.md` in
prose — and getting it wrong tends to fail in one direction: inventing a
capability the application does not have.

## What it will not do

It does not choose an architecture, produce a plan (that is AX2), modify code,
install a package, start a server, deploy, read a secret, execute a business
action, or aggregate JTBD and quality-gate evidence.

## The report

`applicationInspectionContract: 1`. The top-level shape is stable:

```json
{
  "applicationInspectionContract": 1,
  "valid": true,
  "application": {},
  "packages": [],
  "capabilities": [],
  "resources": [],
  "actions": [],
  "policies": [],
  "providers": [],
  "modules": [],
  "adminExtensions": [],
  "problems": [],
  "limitations": [],
  "evidence": {}
}
```

Every list is sorted by identity, not by composition order. The output contains
no function, secret, environment value, absolute path, timestamp, random value,
source body, migration SQL, database record or PII — and two runs over the same
checked-in state produce byte-identical bytes, which the suite asserts rather
than promises.

## Exit codes

```text
0   the composition is valid
1   the composition has problems — the complete report is still printed
2   the project could not be read at all (diagnostics on stderr, no report)
```

A report is printed whenever the project loads. An inspector that stops at the
first fault sends its reader back to the guessing it exists to end.

## Five things called a version

Collapsing them is how an agent installs the wrong thing, so the report keeps
them in five separate keys:

| Key | What it versions |
|---|---|
| `packages[].version` | the package's own release identity |
| `packages[].packageContract` | the seam the kernel enforces (ADR-018) |
| `capabilities[].version` | one named cross-package interface |
| `modules[].revision` | one record's schema generation (ADR-019) |
| `policies[].version`, `providers[].version` | one immutable declared definition (ADR-015) |

## The capability graph

Reported from both ends, and reported *including* the edges that do not
resolve — the unresolved edge is usually the one the reader came for.

```json
{ "name": "delivery-obligations", "version": 1, "provider": "contracts",
  "consumers": ["delivery"], "status": "resolved" }
```

`status` is `resolved`, `missing` or `provider-mismatch`. The rules deciding it
are the same function `PackageRegistry` throws from at startup
(`resolvePackageComposition`), so the inspector and the running application
cannot disagree about what a valid composition is.

## Records

Per record: its kind (`core`, `generated` or `package-owned`), the package that
owns it, the checked-in revision, the ordered migration **identities and
checksums**, its declared fields with their `writable` boundary, and its
references. No SQL, no row counts, and no claim about any database.

`stateFile` says how the revision was known: `valid` (read from
`module.state.json`), `reconstructed` (adopted under ADR-019 addendum 1), or
`unreadable`.

## Actions

Static capability metadata, from the same `actionMetadata` function
`/api/schema` publishes: owner, contract version, input schema, declared
`fromStates`/`stateField`, whether it is an external operation, and its route.

This is **not** authorization, and it is **not** a claim that an action applies
to a particular record right now.

`fromStates: null` means **the action declares no state-restriction metadata**.
It does not mean the action is valid in every runtime state — the server may
still refuse it, from its own rules. The human view spells this out as
"(declares no state restriction)" for the same reason.

## Providers and policies

Declared metadata only: identity, version, label, declared capabilities, the
declared-definition fingerprint, and the **keys** of the declared config. Never
a config value — a value can be a credential, and no report is worth leaking
one. A provider entry says a provider was composed in source. It never says the
provider is configured, reachable, authenticated or operational.

## The trust boundary, stated rather than implied

Reading a code-first package means importing it, so the package's module body
runs — the same boundary `crm package validate` documents and the same one the
checked-in composition file has: **repository source is trusted**.

The load therefore runs in an isolated child process. Three things make that
isolation real, and each was found by attacking it rather than assumed:

- **the report does not travel on stdout.** A package may `console.log` during
  import, and that lands on the child's stdout. Sharing the stream meant one
  logging package made the whole application uninspectable. The report comes
  back on file descriptor 3; the child's stdout and stderr are the project's own
  output, forwarded to your stderr under a label.
- **the child leads its own process group**, so a timeout stops the group. An
  ordinary child a package spawned goes with it. A package that *deliberately*
  detaches a process into a new group outlives the inspection — reaching that
  would mean tracking descendants, which is not attempted and would not be a
  sandbox either (`PROCESS_ISOLATION_BOUNDED`).
- **every stream and every metadata block is bounded**, so a package with
  enormous `metadata()` fails as an explained size refusal
  (`PACKAGE_METADATA_TOO_LARGE`) rather than as a mysterious timeout.

That is **isolation, not a sandbox**: the child holds your authority and can
reach whatever the filesystem, network and credentials of that process allow.
Nothing is downloaded, and no official package needs the network.

## What it cannot know

Published as `limitations[]`, by machine-readable code, so an agent can act on
them:

| Code | Meaning |
|---|---|
| `DATABASE_NOT_INSPECTED` | the configured database is never opened; what one has applied or holds is unknown |
| `PACKAGE_SOURCE_TRUSTED` | package code runs on import; nothing is sandboxed |
| `PROCESS_ISOLATION_BOUNDED` | the timeout stops the load's process group; a deliberately detached process escapes it |
| `EVIDENCE_NOT_AGGREGATED` | JTBD and quality-gate status are prose, referenced by path and never parsed |
| `CI_EVIDENCE_NOT_INFERRED` | no CI, browser-smoke or benchmark result is read |
| `SECRETS_NOT_INSPECTED` | no secret, credential or environment value is read |
| `PROVIDER_HEALTH_UNKNOWN` | a composed provider is not a reachable one |
| `PRODUCTION_SPINE_ABSENT` | Production Spine v1 (ADR-038) adds verified identity, organizations, memberships, authorization and a database-per-tenant boundary, but none of it is reportable from *source*: the mode, the verifier and the memberships are runtime facts. Dedicated-database PostgreSQL composition and a bounded self-host secret-provider contract exist; shared-database row tenancy, durable jobs, managed secret custody/service, backups and Cloud deployment remain absent |
| `ADMIN_EXTENSIONS_UNSUPPORTED` | the framework has no seam for package Admin extensions, so the list is empty for *every* project |
| `DATA_QUALITY_UNKNOWN` | source-only inspection cannot judge data |
| `RUNTIME_STATE_UNKNOWN` | nothing here reports what is running or deployed |

`evidence` carries paths, not claims:

```json
{ "status": "not_aggregated",
  "qualityGatesPath": "docs/QUALITY_GATES.md",
  "jtbdMatrixPath": "docs/benchmarks/CRM_JTBD_MATRIX.md",
  "projectStatusPath": "docs/PROJECT_STATUS.md" }
```

Machine-readable evidence is future work, not a silent gap.

## Using it as an agent

1. Run `app inspect --json`.
2. Read `valid`, then `problems`, then `limitations` — in that order.
3. Cite the package and capability behind each step you plan.
4. Report a missing capability as missing. Do not infer one from a record name,
   a policy label or a document.
5. Never infer provider credentials or runtime authorization from this report.

## Evidence

`tests/app-inspect.test.js`, `packages/cli/src/app-inspect.js`,
`packages/core/src/package-composition.js`,
`docs/plans/ax1-application-inspection.md`. Agent instructions:
`.claude/skills/solve-business-goal/SKILL.md` and its `.agents/` mirror.
