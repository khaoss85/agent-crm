# GTM distribution refresh

## Goal and user-visible outcome

Prepare create-accordo 0.2.0 from current reviewed source, so a new project carries
what the framework documentation describes while clearly starting in local SQLite.
Do not mistake candidate verification for registry publication.

## Current repository context

The September 7 audit found npm latest still at 0.1.0. The bootstrap already
copies packages, apps, published skills and module examples; it excludes repository
plans, site output, state and its own source. The source package manifest remains
private. `scripts/assemble-create-accordo.js` alone emits the publishable manifest.

## Milestones

1. Refresh candidate version and generated limitations, retaining the local default.
2. Include a packed source inventory and validate actual installed bytes and current
   infrastructure imports from an empty-directory project.
3. Run focused checks, full verification, and a retained packed install receipt.

## Validation

`node --test tests/create-accordo-package.test.js tests/project-bootstrap.test.js`
proves deterministic archives, an offline installed scaffolder, project inspection,
doctor, project tests and smoke, and infrastructure inventory/import closure.
`npm run verify` is required before integration. A separate clean-directory
`npm install` and PostgreSQL module import check the declared driver; this does
not claim a live PostgreSQL deployment or configured production operations.

## Progress log

- 2026-09-07: inspected the publication wall, assembly manifest and current source.
  Refreshed stale limitations, candidate version and pinned driver declaration.
  Added an archive inventory and a tarball-to-project source equality check.

## Decision log

- Keep the scaffolder dependency-free: it only copies source. Declare the existing
  exact pg dependency in the generated application; SQLite works without install.
  This reuses ADR-001's existing dependency rather than adding a new driver.
- Keep framework-source.json content-addressed and deterministic. It is evidence
  of bytes, not a signature; npm trusted publishing supplies commit provenance.
- Keep optional domain composition empty and workers stopped by default. Package
  source is available; explicit deployment setup remains application work.
- Retain manual dispatch, OIDC staging and final maintainer approval. No direct
  registry publication or publication token is introduced.

## Outcome and follow-up

Focused bootstrap and installed-package suites passed; the GTM check passed.
Full repository and retained fresh-project verification are in progress. After integration and review, dispatch
`stage-create-accordo.yml` on main with `create-accordo@0.2.0`; review the staged
artifact, approve through npm's existing maintainer/2FA flow, then compare registry
integrity and provenance with the staged receipt and repeat the clean-directory
installation using the registry version. Only that receipt updates live version
claims. The earlier audit's 0.1.0 registry state remains valid until rechecked.

Publication authority: [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
and [trusted publishers](https://docs.npmjs.com/trusted-publishers/) were checked
on September 7. npm stage approval requires maintainer interactive authentication
and 2FA; OIDC can stage but cannot approve.
