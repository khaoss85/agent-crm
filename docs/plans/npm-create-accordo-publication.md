# Publishable `create-accordo` artifact (ExecPlan)

## 1. Goal and user-visible outcome

Close the gap between a bootstrap that works from this repository and the npm
package a coding agent can actually install. The outcome is a deterministic,
self-contained `create-accordo@0.1.0` publication directory that npm can pack,
install and stage from a clean machine. Installing its tarball and running its
bin must create a project that passes `app inspect`, `project doctor`, its own
tests and smoke without fetching framework source.

This plan does **not** call the npm registry, publish a version or claim that
`npm create accordo` works. The registry remains the empty `0.0.1` reservation
until a human reviews and approves the staged package. The source package stays
`private: true`; only an explicitly assembled publication directory is
publishable.

## 2. Current repository context

PR #43 adds `packages/create-accordo`. It finds the framework by walking to a
repository ancestor, copies 195 declared files plus ten generated project files,
and proves the result from an empty directory. Its source manifest is private,
and an isolated copy correctly refuses with `FRAMEWORK_SOURCE_UNAVAILABLE`.

That refusal is also the publication blocker: npm cannot include files outside
the package root, so `npm pack packages/create-accordo` cannot carry `packages/`,
`apps/`, `skills/` or `examples/modules/`. Adding a `files` array to the source
manifest does not solve it; npm will not traverse to sibling directories.

Relevant contracts:

- `packages/create-accordo/src/project-bootstrap.js` owns the source manifest,
  exclusion rules, inventory and bootstrap contract.
- `packages/create-accordo/package.json` is deliberately private.
- `scripts/distribution-check.js` keeps repository and registry truth separate.
- `site/brand.json` records `names-reserved` and `sourceScaffolds: true`.
- ADR-023 confirms MIT before a distribution manifest asserts it.
- npm trusted publishing requires a public repository, a matching
  `repository.url`, a GitHub-hosted runner, npm 11.5.1+ and `id-token: write`.
  Trusted publishing creates provenance automatically. Staged publishing needs
  npm 11.15.0+ and keeps a 2FA approval between CI and a public version.

## 3. Approaches compared

### A. Check a vendored framework copy into `packages/create-accordo`

Rejected. It duplicates roughly 195 source files, creates two authoritative
copies inside one repository and makes every framework change a generated-drift
problem. The package would look simple only because the repository absorbed the
complexity permanently.

### B. Publish the repository root as `create-accordo`

Rejected. The root is the private `accordo` development repository, carries
tests, benchmarks, site and maintainer documentation, and exposes the wrong bin
and package identity. A publication trick that temporarily rewrites the root
manifest would make the build hard to inspect and easy to run from a dirty tree.

### C. Assemble a publication directory from declared source (chosen)

Add one maintainer-only, dry-run-by-default assembly script. It copies the
bootstrap package, LICENSE and the existing declared framework inventory into a
new staging directory, placing framework source under `framework/`, writes a
publishable package manifest, and commits by one rename. The installed bootstrap
first checks that bundled location, then retains the repository-ancestor fallback.

The source manifest remains private. A workflow that can only be triggered
manually assembles the package on a GitHub-hosted Node 24 runner, verifies the
tarball, and uses `npm stage publish` through OIDC. A human still inspects and
approves the staged package with 2FA.

## 4. DX Simplicity Gate

This is a maintainer distribution command, not a coding-agent project command,
skill, MCP tool or public namespace. It is intentionally absent from the
generated project and from every agent skill.

The concrete failure it prevents is publishing a tarball whose executable loads
but has no framework source and therefore exits 2. Existing `npm pack` cannot
include sibling directories, and extending the customer-facing bootstrap would
mix “create a project” with “prepare a registry artifact”. The assembly remains
on-demand and reports a versioned JSON contract, content fingerprint and exact
file inventory. For end users the flow becomes one canonical command after the
human publication; no extra session command is introduced.

This is not horizontal under the Compatibility Backfill Rule. It packages the
project bootstrap above every domain and introduces no capability or rule an
existing domain can align to. The existing project-bootstrap entry in the Legacy
Alignment Matrix remains the applicable declaration.

## 5. Design

Publication layout:

```text
<output>/
  package.json
  README.md
  LICENSE
  bin/create-accordo.js
  src/project-bootstrap.js
  src/project-files.js
  framework/packages/**          # packages/create-accordo excluded
  framework/apps/**
  framework/skills/**
  framework/examples/modules/**
```

`packageAssemblyContract: 1` reports `plan | applied | refused`, package name
and version, file and byte counts, a SHA-256 fingerprint over every output path
and content hash, problems, and limitations. Dry-run writes nothing. Apply
refuses a non-empty target and finalizes with one rename. No timestamp, absolute
machine path, registry response or credential enters the fingerprint.

The publication manifest is generated from a small explicit allow-list rather
than spreading the private source manifest. It carries the exact public
repository URL required by npm provenance, MIT, Node >=22.16.0, the bin,
keywords, homepage and a `files` allow-list. It has no dependencies and no
scripts that execute during install.

The manual workflow uses Node 24 and the current npm CLI, runs repository
verification, assembles twice and compares fingerprints, packs and installs the
tarball in an empty project, then stages the assembled directory. It uses no
long-lived npm token: npm trusted publishing exchanges GitHub OIDC for a
short-lived credential and creates provenance automatically. The npm package
settings must name the exact workflow and allow `npm stage publish`; that
external configuration is a human prerequisite, not something source can prove.

## 6. Milestones

1. Add the ExecPlan and ADR addendum before implementation.
2. Add bundled-source resolution without changing checkout behavior.
3. Add deterministic package assembly and its unit/refusal tests.
4. Pack and install the artifact in a fresh npm project, then run the installed
   bin and the generated project end to end.
5. Add the manually triggered OIDC staged-publish workflow and distribution
   gates that keep it manual and token-free.
6. Update README, status and GTM documents with “artifact verified, registry
   unchanged”, then run all quality gates.

## 7. Validation

```bash
node --test tests/create-accordo-package.test.js
npm run distribution:check
npm run gtm:check
npm run verify
npm run smoke
```

The focused test must prove two independent assemblies are byte-identical; two
`npm pack` tarballs are byte-identical; a clean npm project can install the local
tarball with no registry dependency; the installed `create-accordo` bin creates
a valid project; and the generated project's tests and smoke pass.

Expected limitations remain explicit: the artifact is not published; provenance
does not exist until the CI publish; trusted-publisher settings are external;
the generated application remains local-only, SQLite-only and without auth,
tenancy or RBAC.

## 8. Progress log

- 2026-08-09: current `main` verified aligned with `origin/main` at `6b5d379`;
  PR #43 exact head `12ce8ef` is green and is the base of this stacked branch.
- 2026-08-09: PRs #43 and #50 subsequently merged. This branch was rebased onto
  `origin/main` at `77d7719`, so the publication candidate now targets `main`
  directly rather than remaining stacked.
- 2026-08-09: npm's current primary documentation re-verified the OIDC,
  provenance and staged-publishing requirements; the chosen workflow uses the
  safer staged path rather than direct publication.
- 2026-08-09: implemented `packageAssemblyContract: 1`, bundled-source
  resolution, the manual staged-publish workflow and the source/registry gate.
- 2026-08-09: focused tests passed 32/32. Two independent assemblies produced
  byte-identical npm tarballs; one installed with npm offline and its installed
  bin generated a project that passed inspect, doctor, 3/3 tests and smoke.
- 2026-08-09: `npm run distribution:check`, `npm run gtm:check` and smoke passed.
- 2026-08-09: adversarial supply-chain probe replaced the package README with a
  symlink to an external file and confirmed the assembler would sign those
  bytes. Fixed by refusing every non-regular publication input; the regression
  test reproduces the symlink attack. Full verification must be rerun.
- 2026-08-09: adversarial path probe routed the output through a parent symlink
  into the repository and confirmed the inside-source gate could be bypassed.
  Fixed by canonicalizing existing parent components without following the
  final target; the regression test preserves both boundaries.
- 2026-08-09: release-workflow review found movable action tags inside the OIDC
  trust boundary. Pinned checkout and setup-node to their verified full v6 SHAs
  and added a distribution gate that rejects non-SHA action references.
- 2026-08-09: post-fix full verify ran 777 tests; 776 passed and one unrelated
  delivery evidence test hit `ECONNRESET` after the run stretched past nine
  minutes under load. Its entire 12-test file passed immediately in isolation,
  including the failed exact-read case. That run is not counted as green; the
  clean-clone rerun below is the decisive full gate.
- 2026-08-09: a pre-rebase clean clone passed 777/777, smoke and the full B2B
  lead-qualification starter from an empty directory. Its implementation was
  then rebased after PRs #43 and #50 merged; the rebased exact-head clean-clone
  gate passed 778/778 and smoke. At that point the diff changed no public UI;
  the later continuation review below added and browser-checked public copy.
- 2026-08-09: continuation review found public copy still saying no
  create-project CLI existed after the candidate had become real, and the site
  repeated the explicitly forbidden claim that the vendored framework could be
  deleted while the application kept shipping. Both were reproduced by reading
  the built landing page, corrected across the release runbooks and public
  template, and bound to the package test so a verified candidate cannot again
  be confused with either no source command or a live registry release.
- 2026-08-09: a fresh clone at reviewed head `2f29955` installed with zero
  vulnerabilities; app inspection returned `valid: true`, no problems and all
  eleven source-only limitations; doctor returned `ok: true`; full verification
  passed 779/779; framework smoke and the complete B2B starter both returned
  `ok: true`. The built 108-page site was rendered in real headless Chrome at
  1270 px, including the changed comparison and FAQ copy, with no overflow or
  layout break. The only subsequent repository change is this receipt.
- 2026-08-10: the candidate merged through PR #58 at main `5c8ad68`; the exact
  main passed 807/807 tests, its GitHub Actions gates passed, and it was promoted
  to production with the hosted Docs MCP and all 113 checked pages live.
- 2026-08-10: the first real `create-accordo@0.1.0` staging dispatch
  (`31362278790`) failed before npm was contacted. `npm run` wrote its command
  banner to stdout, so the workflow's redirected file was not valid JSON and the
  receipt parser refused it. The registry therefore remains unchanged.
- 2026-08-10: both redirected assembly invocations now use `npm run --silent`.
  The distribution gate requires exactly those two JSON-only invocations and a
  regression test executes the same npm wrapper and parses stdout. Focused tests,
  `npm run gtm:check` and the full 808-test verification pass.
- 2026-08-10: PR #59 merged at `5630744`; dispatch `31364606861` passed all
  repository and deterministic-assembly gates and reached `npm stage publish`.
  npm signed and logged a provenance statement, then refused authentication with
  `E401`. No staged or live version was created; `create-accordo@0.0.1` remains
  the registry truth. The remaining external prerequisite is the package's exact
  stage-only trusted-publisher relationship.
- 2026-08-10: the same npm 11 run normalized `./bin/create-accordo.js` to its
  canonical `bin/create-accordo.js` form with a misleading removal warning. The
  tarball still contained the executable, but source now emits the canonical form
  and the package test proves npm creates `node_modules/.bin/create-accordo`.

## 8a. Adversarial review outcome

- **High — fixed:** allow-listed package inputs followed symlinks, so an
  external local file could enter a provenance-signed tarball. Confirmed with a
  README symlink to `/etc/hosts`; regular-file enforcement and a regression test
  now refuse it.
- **Medium — fixed:** a parent symlink could disguise an output physically
  inside the repository. Confirmed with an alias to the checkout; canonical
  parent resolution and a regression test now enforce the boundary.
- **Medium — fixed:** release actions used movable major-version tags while
  holding OIDC permission. Both actions are pinned to verified full commit SHAs,
  and the distribution gate rejects any future non-SHA release action.
- **Medium — fixed:** public copy erased the verified create candidate by saying
  no create-project CLI existed, while a landing-page FAQ claimed the vendored
  framework could be deleted without breaking the application. The corrected
  copy keeps all three states distinct — source bootstrap, verified publication
  candidate and live registry — and states that ownership still includes
  maintaining the copied framework source.
- **Held:** eight concurrent assembly processes produced exactly one applied
  result and seven stable refusals; no partial candidate or staging residue was
  observed. Direct source and assembled publication manifests remain distinct;
  the assembled manifest has no dependency or lifecycle-script surface.

## 9. Decision log

| Question | Decision | Reason |
|---|---|---|
| Make the source manifest public? | No | A direct `npm publish` from the repository must remain impossible |
| Check in the vendored framework? | No | It creates permanent source drift |
| Tarball or directory as the contract? | Directory | Both `npm pack` and `npm stage publish` consume it; the tarball is independently verified |
| Token or OIDC? | OIDC trusted publishing | Short-lived, workflow-bound credential and automatic provenance |
| Direct or staged publish? | Staged | CI cannot make the public-release decision; a maintainer approves with 2FA |
| Compose a domain package? | No | The bootstrap creates a neutral kernel-only project |

## 10. Outcome and follow-up

Implementation, public-copy review, the original adversarial review, merge and
production promotion are complete — and so, since 2026-08-19, is the
publication itself. The path earned its receipts one failure at a time: the
JSON receipt fix merged; a dispatch reached npm and died `E401` because
setup-node's `registry-url` wrote a placeholder-token `.npmrc` line that
preempted the OIDC exchange (fixed by configuring no registry at all); the next
died `ENEEDAUTH` because the trusted-publisher relationship did not yet allow
the stage action; run `32224731197` then staged clean — provenance in the
Sigstore transparency log — and the maintainer approved the staged version with
2FA. The registry receipt was verified from a clean environment (`npm view`
returns the CI shasum; `npm create accordo` scaffolds a verifying project), and
only then did `site/brand.json` flip to `published`. The source manifest stays
`private: true` in every registry state: the wall against a direct repository
publish outlives the publication it was built to gate.
