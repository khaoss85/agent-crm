# Custom module bundles (BO-F5-01)

A bundle is a versioned set of manifest-generated modules that lives
SEPARATELY from the kernel, under `bundles/<name>/<version>/`. Installing a
bundle never writes under `packages/` (the shared process composition is
untouched): a host composes a bundle only by passing its entries explicitly
to `createAccordoApp({ bundles })`. A bundle the host does not name there
does not exist for that application.

The canonical format of every skill and module is the native kernel package
with a declared capability (`docs/PACKAGE_AUTHORING.md`, decision Q-K4,
2026-10-22): no pseudo-code, no parallel generator. A bundle module is the
module factory's output (`docs/MODULE_FACTORY.md`), generated one level
deeper so framework imports climb one extra level, plus a `bundle.json`
manifest and a bundle-local installability test.

## Layout

```text
bundles/<name>/<version>/
  bundle.json               # { format, name, version, createdBy, modules[] }
  module.manifest.json      # the validated module manifest (name == bundle name)
  src/index.js              # create<Name>Module (factory output, deeper imports)
  src/migration.js          # <name>Migrations (factory output)
  src/<name>-service.js     # domain rules live here; audit + events on every mutation
  tests/<name>-bundle.test.js  # the "installabile vero" proof (see below)
```

`bundles/registry.json` records what is installed (`{ installed: [...] }`).
A missing registry file means nothing is installed: a fresh checkout
composes the kernel only, never a bundle implicitly.

## Lifecycle (CLI)

All six commands are file- and memory-scoped — none opens the project's
database — so they run before any server is up:

```bash
npm run crm -- bundle plan <manifest>.json --name <name> --version <x.y.z> [--created-by ai|manual|accordo]
npm run crm -- bundle create <manifest>.json --name <name> --version <x.y.z> [--created-by ai] --apply
npm run crm -- bundle verify <name@version>
npm run crm -- bundle install <name@version>
npm run crm -- bundle uninstall <name@version> [--db ./data/app.sqlite]
npm run crm -- bundle list
```

Rules the commands enforce:

- Names are `^[a-z][a-z0-9-]{1,63}$`, versions exact `X.Y.Z` (no ranges,
  no `v` prefix): a floating bundle is refused, never resolved.
- A bundle never shadows the kernel: kernel module names, kernel-owned
  tables (clienti, pipeline, calendario, framework storage — the
  `BUNDLE_PROTECTED_TABLES` set, self-checked against the live kernel by
  `tests/bundle-lifecycle.test.js`) and other bundles' module names are
  refused at plan time. A new version of the SAME bundle reuses its module
  name; a DIFFERENT bundle claiming it is a conflict.
- `bundle create` writes only under its own directory and refuses to
  overwrite: a version never regenerates in place — a change is a new
  version. One apply, one rollback: a failed create leaves nothing behind.
- `bundle verify` IS the installability proof: it boots the real
  application with the bundle composed and serves one record per module
  (create + read + list) with audit. A bundle that does not boot and serve
  is refused — never simulated.
- `bundle install` re-runs that proof, then records the version in the
  registry. Two versions never merge: installing `name@2.0.0` while
  `name@1.0.0` is installed is a conflict — uninstall first.
- `bundle uninstall --db <path>` drops ONLY the bundle's own tables: every
  table `bundle.json` names is re-checked for exclusive ownership before
  any drop runs — the protected set (a table that became kernel-owned
  since install is refused), another bundle's live tables and the kernel
  generated-module tables on this root (same registry the plan-time
  refusal uses). A hand-edited `bundle.json` naming any of them refuses
  the whole uninstall: nothing drops, the registry entry stays. Then it
  drops its own `module_migrations` ledger rows, in the same
  transaction — so reinstalling the same version re-applies the CREATE
  instead of booting with a missing table — and removes the registry
  entry. Kernel tables and rows survive: the lifecycle test proves it on
  real rows.

## For coding agents ("Crea con l'AI")

The backoffice "+ Nuovo modulo" screen collects the user's description and
forwards it to the assistant; the agent's job is exactly this:

1. Draft the module manifest from the description
   (`docs/MODULE_MANIFEST.md`: name, fields, types) — this step is the
   only place judgement lives.
2. `bundle create --apply` with that manifest (real files on disk).
3. `bundle verify`: the bundle boots and serves, or it does not ship.
4. `bundle install` records it; the host composes it with
   `createAccordoApp({ bundles: await createBundleEntries(...) })`.

`tests/bundle-lifecycle.test.js` plays this role end to end: description →
manifest → real `bundle create --apply` → `verify` (live boot serving a
record) → `install` → kernel + bundle rows side by side → `uninstall` →
kernel intact. Nothing there stubs the install.

## Example: reporting@1.2.0

`bundles/reporting/1.2.0/` is the reference bundle (story BO-F5-01, ref
"09 Reporting"): KPI snapshots owned by the bundle, one row per metric per
period — the material a reporting dashboard reads without touching kernel
tables. Dashboards, charts and forecasts (BO-F5-02) read these rows; they
never query clienti, pipeline or calendario tables directly. Its
`tests/reporting-bundle.test.js` is the generated bundle-local proof every
new bundle carries.
