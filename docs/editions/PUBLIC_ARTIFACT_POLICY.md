# Public artifact policy

What may live in the public repository, how public claims stay sourced from it,
what the licence does and does not grant, and the gate that enforces the first
three.

## 1. The site boundary

**Decision.** The marketing-site *implementation and deployment* go private. The
public framework documentation stays public.

The public repository keeps:

- **documentation source** — everything under `docs/` that survives the
  classification in [`REPOSITORY_BOUNDARY.md`](REPOSITORY_BOUNDARY.md);
- **technical landing and README assets** — what a developer arriving at the
  repository needs to read it;
- **`site/assets/llms.txt` and `llms-full.txt`** — the agent-retrieval surface,
  which must describe the *framework*, and would be worthless generated from
  private strategy;
- **`site/claims.json`** — the claims ledger.

The private repository takes the templates, partials, blog, brand and comparison
data, the stylesheet and social imagery, and the site's build and deploy
configuration.

**No site move happens in this task.**

### How public claims stay sourced from the public repository

This is the part that could quietly rot, so the mechanism is named rather than
assumed.

`site/claims.json` is a versioned ledger (`claimsContract: 2`) whose own comment
states the rule: *"The only sentences any public asset may assert about what this
framework does."* Every claim carries evidence and a limitation, and
`npm run site:check` **fails the build** when a claim is missing evidence, missing
a limitation, references a file that does not exist, or is defined and never used.

Three properties follow, and they are what keep the boundary honest after the
site moves:

1. **The ledger stays in the public repository.** It is measured against the
   public tree; a claim whose evidence lived privately could not be checked by
   anyone outside.
2. **The private site consumes the ledger; it never edits it.** Templates
   reference claims by id (`{{claim:C-01}}`). A marketing sentence that needs a
   new claim requires a public pull request to the public ledger, with public
   evidence — which is precisely the friction that should exist.
3. **`site:check` runs in public CI.** If it ever needs a private input to pass,
   the boundary has been violated and the build says so.

## 2. Licence

**The public core keeps its current licence — MIT — and this task does not change
it.**

- Managed Cloud code is **proprietary** and lives in the private repository.
- **The open-source licence grants no access to private Cloud source.** MIT
  covers the framework in the public repository; it conveys nothing about
  `accordo-platform`.
- **The Cloud consumes public contracts as an external product**, on the same
  terms as any other integrator, with no privileged path into framework
  internals.
- **Competitors may host the public core.** MIT permits it, and this project does
  not intend to prevent it. Differentiation comes from managed operations,
  reliability, distribution and ecosystem — **not from withholding the
  framework.** A framework held back to protect a hosted product would fail the
  self-host test in `OPEN_SOURCE_EDITION.md`, and that test is the point.

There is no relicensing plan here. Any future licence change is a human decision
requiring its own ADR, and would need to explain how it preserves the self-host
test.

## 3. `public-surface-check` — the gate

### Status: **specified, not implemented**

The brief permits implementation only if the gate is narrow, deterministic, and
passes on the current tree **without requiring any file to move**. It is not, and
here is the measured reason: the tree at `aa1359f` contains 35 `MOVE_PRIVATE`
paths and 5 `PUBLIC_REDACTED_REPLACEMENT` paths, all of them still present
publicly — so rule 2 fails on 40 paths today. Rule 5 also has live work to do:
five private-designated documents are referenced from **16 files that stay
public** (`MASTER_PLAN.md` from ten, `GO_TO_MARKET.md` from five, `CATEGORY.md`
from four, `CLOUD_JTBD.md` and `AGENT_CRM_CLOUD.md` from one each, counting each
file once per target — see `REPOSITORY_BOUNDARY.md` §4 for the counting rule and
the enumeration).

Any gate strong enough to be worth adding therefore fails on files this phase is
explicitly forbidden to move. A gate authored now would have to be born disabled
or born lying, and either would be worse than not having it.

So it is specified precisely and implemented in migration step 7, once the paths
it guards have actually moved.

### What it checks

Deny rules and explicit manifests only. **No semantic classification of arbitrary
prose** — a gate that tries to judge whether a paragraph "sounds like pricing" is
a gate that fails randomly and gets switched off.

| # | Rule | Mechanism |
|---|---|---|
| 1 | No `docs/internal/` in the public tree | Path deny-glob |
| 2 | No private GTM artefacts | Deny-manifest of the exact paths classified `MOVE_PRIVATE` |
| 3 | No private Cloud implementation paths | Deny-globs: `apps/cloud-*`, `packages/cloud-*`, `packages/deployment-engine`, `packages/observability-backend` |
| 4 | No secrets | The existing secret-scanning gate, unchanged |
| 5 | No links to inaccessible private docs | Extract every relative markdown link from public files; every target must resolve in the public tree |
| 6 | Public roadmap free of private financial detail | Allowlist: the public roadmap files may not match a small, explicit deny-regex set (currency amounts, `MRR`, `ARR`, `per seat`, `unit econom`) |

Rule 6 is the only one touching prose, and it is deliberately a **fixed, tiny,
reviewable regex list applied to two named files**, not a classifier.

### Properties it must have

- **Deterministic** — same tree, same verdict, no network, no clock.
- **Fast** — a path and link walk, not a build.
- **Explicit** — every denial names the rule and the offending path.
- **Failing closed on its own manifest** — a manifest referencing a path that no
  longer exists is an error, so the gate cannot silently stop guarding anything.

### Its own limitation, stated

The gate checks the **public tree at HEAD**. It cannot check public *git history*,
and it is not intended to: history is not rewritten (migration step 9), so
everything published stays readable. The gate prevents new leaks; it does not
retroactively unpublish, and no one should describe it as doing so.
