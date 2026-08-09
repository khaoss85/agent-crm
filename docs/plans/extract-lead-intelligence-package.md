# ExecPlan — extract Lead Intelligence into a domain package

**Goal.** Convert the oldest legacy domain into a package-native optional
domain, preserving every LA0 `contractual` and `compatibility_required`
behaviour. The acceptance criterion is not "the tests still pass"; it is that
LA0 proves the decisions are identical **and** DX4 proves the result is a
package. Neither substitutes for the other.

**Authority.** ADR-018 (domain package seam), ADR-021 (declared capability, not
an ambient field), ADR-022 (reuse provider/policy contracts; routing targets are
declared configuration; no new registry seam),
`docs/architecture/INTELLIGENCE_PACKAGE_TARGET.md` (target topology, AX1 and
schema conclusions).

---

## Two approaches rejected

**A cosmetic file move.** Create `packages/intelligence/`, move the two kernel
files into it, leave `app.intelligence` and the fixed AX1 slot in place. It
would pass LA0 trivially and would be a lie: the domain would still be reachable
without declaring it, still occupy a hard-coded inspection slot, and still not
be removable. ADR-021 exists precisely to refuse this, and its removal gate
names "a legacy fallback left in place" as the failure.

**A big-bang rewrite.** One commit that moves the code, converts the
definitions, migrates the capability, deletes the ambient field and rewires
AX1. If LA0 goes red, nothing says which of five changes did it, and the
bisect is a day. The harness's value is that it localizes a regression, and a
single commit throws that away.

**Chosen: staged extraction under the accepted ADRs.** Each stage is
independently verifiable, and the stages that break something are last and
separate. The head of the branch contains no bridge and no fallback.

---

## Stage 0 — close the LA0 seam defect first

**Found by attacking the extraction path, not by reading the diff.**
`tests/characterization/intelligence-cases.mjs` reads `schema.intelligence` by
hard-coded top-level path, inside observations classified `contractual`
(`architecture.definition-kinds-published`,
`architecture.fingerprint.<kind>.<name>@<v>`,
`enrichment.provider-fingerprint-matches-schema`).

The harness's stated doctrine is that everything knowing *where Intelligence
lives* is concentrated in `intelligence-harness.mjs`. The schema location is
exactly that, and it had leaked into the cases. Two consequences, both bad:

1. ADR-021 sanctions publishing the block as the package's contribution, which
   moves it under `domains`. The contractual observations would then read
   `undefined` and report empty arrays — an ownership move indistinguishable
   from a behaviour change.
2. Worse, an extraction that genuinely **lost** the definitions would produce
   the *same* empty arrays. The harness could not tell "moved" from "lost",
   which is the one distinction it exists to make.

Fix before anything moves: the harness gains `intelligenceSchemaBlock(schema)`,
which knows where the block lives and returns it. Cases ask the seam. The
*contents* stay `contractual`; the *location* stays a separate
`pre_extraction_evidence` observation that records **where it was found**. A
block that is nowhere returns `undefined`, the contractual observations go red,
and "lost" is loud.

Verified by regenerating the baseline: zero observations change, because today
the seam returns the same object the hard-coded path did.

## Stage 1 — the package exists and owns its code

`packages/intelligence/src/` receives the registries and the four action
builders, moved without edits to their bodies. `packages/intelligence/index.js`
calls `definePackage` with name, version, `resources`, `capabilities`,
`actions`, `policies`, `providers` and `metadata()`.

Nothing composes it yet. The kernel still works exactly as before, which is
what makes this stage safe to review on its own.

## Stage 2 — records become package-owned

The seven Intelligence record manifests move from the starter to
`packages/intelligence/modules/`, **byte-identical**. Identity is the manifest,
so an unchanged manifest is an unchanged table, unchanged migrations, unchanged
checksums and unchanged module state. The installer applies them from their new
home.

No table is renamed, no record type is renamed, no column moves. A rename here
would be a data migration wearing a refactor's clothes.

## Stage 3 — composition replaces the fixed slot

`packages/domains/generated/index.js` composes `createIntelligenceDomain(...)`
with the project's declared definitions. The project-owned
`packages/intelligence/generated/index.js` slot and AX1's hard-coded
`intelligence` row are removed; AX1 discovers the package the way it already
discovers Contracts and Delivery.

## Stage 4 — the capability, then the ambient field

In order, as ADR-021 requires: the package offers `intelligence@1` while
`app.intelligence` still exists (both work) · Intelligence's own actions open
the capability instead of reading the ambient field · the external schema
consumer migrates · a code-level scan proves no consumer remains · the field
and the bridge are deleted **in the same change**.

The removal gate is ADR-021's, in full. The final head must not contain the
bridge.

## Stage 5 — absence, detach, reattach

Without the package composed: the app boots, Lead and core CRM are untouched,
Intelligence actions and capabilities disappear from every surface honestly,
stored Intelligence rows remain on disk, and reattaching restores both surface
and data.

## Stage 6 — evidence

LA0 green with no asserted observation moved · `crm package test
packages/intelligence` green · an old database boots and upgrades · the
developer-facing SEE → PLAN → BUILD → CHECK → PROVE story with PRESERVE,
checked in as evidence rather than prose.

---

## What this plan will not do

Rename a table or a record type for tidiness · introduce a generic
definition-registry seam · introduce a package HTTP-route seam (Intelligence
needs none; its actions and records are served by generic routes) · invent an
Admin extension that does not exist · change Commercial or Signature status ·
touch the GTM branch.

## The dual gate, stated once

| Gate | Answers | Cannot answer |
|---|---|---|
| LA0 | does it still **decide** identically? | is the result a well-formed package? |
| DX4 `crm package test` | does it **conform** to the package contract? | does it still decide correctly? |

An extraction that passes one and not the other has failed.
