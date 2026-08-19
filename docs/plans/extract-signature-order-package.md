# ExecPlan — extract Signature & Order as a domain package

**Status: in progress.** Branch `claude/signature-order-extraction` from
`9a57c78` (ADR-032 merged; signer fix and the Signature LA0 baseline of record
on main at `a5a71dd`; Commercial package-native since `6cf4c85`).

## Objective

Move Signature & Order — envelopes, verified webhooks, signed artifacts,
immutable Orders (ADR-017) — out of `packages/core` into the optional
`packages/signature` domain package, on the pattern the Intelligence (#38) and
Commercial (#79) extractions established, **implementing the ADR-032
operations seam exactly within its five-item rollout boundary** so both
consumers (Commercial's `syncCatalog`, Signature's `ingestSignatureEvent` /
`reconcileSignature`) attach through declared operations instead of named
kernel wiring.

**Acceptance harness**: both LA0 baselines replay with zero asserted
observations moved — Signature (110 observations, asserted fingerprint
`fe1875bf9cb6…`) and Commercial (107 observations, `82c1f02fa354…`).

## Approaches compared

1. **Two packages (signature + order)** — rejected: the characterization
   treats them as one lifecycle (a verified completion atomically creates the
   Order; `order:quote-version:<id>` uniqueness is the envelope's own
   invariant), no consumer needs Order without Signature, and a split would
   invent a capability edge between them with one consumer on each side.
2. **Extract without the seam, keeping two named residues** — rejected: it
   contradicts the merged ADR-032 rollout, which binds the seam to this PR
   precisely because both real consumers exercise it here.
3. **One package + ADR-032 seam within the five-item boundary** — chosen.

## Architecture

- `packages/signature/src/operations.js` and `src/registry.js`: the moved
  kernel files (`signature-operations.js`, `signature-registry.js`), bodies
  unchanged except imports from public core and the two deliberate wiring
  changes below. `packages/core/src/external-operation.js` **stays in core**
  (the recorded neutral-helper verdict); the operations receive it via the
  seam's injected `runExternal`, closing the private-export gap the narrow way
  ADR-032 chose.
- `packages/signature/src/index.js` — `createSignatureDomain({signatureProviders, config})`:
  - `resources`: the nine record modules (`signature-envelope`,
    `signature-signer`, `signature-event`, `signed-artifact`, `order`,
    `order-line`, `order-component`, `order-tier`, `order-total`), whose
    manifests move to `packages/signature/modules/` (the Commercial precedent
    for the quote family);
  - `requires`: `commercial/commercial-quotes@1` and
    `commercial/commercial-quote-binding@1` — the declared edges the
    Commercial extraction sized from this domain's own consumption inventory.
    Composition therefore **fails closed** when Commercial is absent or offers
    the wrong version (`DEPENDENCY_MISSING_PACKAGE` / `DEPENDENCY_UNSATISFIED`);
  - `actions`: `buildRequestSignatureAction(config, registries)` — the
    registries close over the package instance (ADR-021 applied, exactly as
    Commercial's `submit` did), and the ambient `signature` action-context key
    is removed from the action runtime with no fallback;
  - `operations` (ADR-032): `ingest-signature-event` (`appMethod:
    ingestSignatureEvent`) and `reconcile-signature` (`appMethod:
    reconcileSignature`), run names `signature.event` / `signature.reconcile`
    grandfathered as frozen consumer-visible values;
  - `metadata()`: the same block `SignatureRegistries.metadata()` always
    published, now under `domains.signature`; the ambient `schema.signature`
    block is gone with no fallback (the LA0 harness reads location through its
    seam and freezes the contents);
  - `persistFingerprints`: kept on the package (the recorded ADR-022
    deviation, third application) — shipped databases hold
    `signature-provider` rows in `definition_versions`, and re-typing them
    would retire the drift check.
- **Commercial consumption.** No Commercial import exists in Signature source
  (measured in the LA0 ExecPlan §1.1) and none is added. The `request-signature`
  action's intent opens **`commercial-quotes@1` through the registry**
  (`ctx.domains.capability`, consumer `signature`) for every quote/version
  read that builds the signable document, and opens
  `commercial-quote-binding@1` for the declared bounded-write edge; the quote
  patch itself stays `applyManaged` on the quote module — the capability's own
  written contract (`writePath`), not a second mechanism. Inside the two
  app-scoped operations the completion evidence keeps its `modules`-based
  reads: the ADR-032 bounded context deliberately provides `modules` ("the
  same handles the operation code holds today") and no capability resolver —
  a resolver there would exceed the five-item boundary, so the declared
  `requires` edge carries the dependency and the byte-identical reads carry
  the behaviour. Recorded here so the reviewer meets it as a decision, not a
  discovery.

- **`signature-orders@1` (added during verification, forced by conformance).**
  Moving the order family's ownership into this package turned Contract
  Activation's existing actions on `order` into an undeclared record-level
  dependency: `crm package test packages/contracts` fails
  `declaration.action-targets` with `UNDECLARED_PACKAGE_RECORD_DEPENDENCY`,
  and its own remediation text prescribes the fix — the owner offers a
  capability, the consumer declares it in `requires`. So
  `packages/signature/src/capability.js` offers **`signature-orders@1`**:
  read-only signed-Order evidence sized to `loadActivationSource`'s measured
  reads (order row, position-ordered lines, per-line components, grouped
  totals, envelope, signed artifact; frozen rows, null for absent ids, no
  write of any kind), and `packages/contracts` declares
  `signature/signature-orders@1`. **Declaration only at runtime**: activation
  keeps its byte-identical trusted managed-module reads (the DX4 doctrine the
  `commercial-quote-binding` capability recorded — record access by module
  name is the ordinary mechanism; what was missing was the declared edge).
  Knock-on: contracts no longer composes alone, so the fixtures that used it
  as the smallest composable package moved to `work` (project-doctor) or
  compose the chain `commercial → signature → contracts`
  (work-package-absence, the package-contract registry test, the harness
  fixture composition in `benchmarks/tool-selection/fixtures.js`). Contracts' package
  version was first left at 4 on the argument that the versioned
  consumer-facing surfaces (capabilities, actions, resources) were unchanged
  — flagged here for the reviewer to disagree with, and **the reviewer did**:
  the no-bump call is REJECTED, and contracts ships at **version 5**. The
  recorded rationale, verbatim: "A package version describes its composition
  contract, including `requires`, not only its consumer-visible
  records/actions." The new required edge changes composability, startup
  behaviour when Signature is absent, AX1's reported graph, and deployment
  compatibility. The bump swept exactly the surfaces where the version
  identity legitimately moved (the conformance expectation, the three plans
  pinning contracts in `plan.application.packages`, their evidence documents)
  and nothing else; no schema or data migration exists, and version/drift
  checks are untouched.

## The ADR-032 boundary accounting (what each of the five items adds)

1. **`operations` validation** — `package-registry.js`:
   `operationContract: 1`, `NAME_RE` name unique per package, bounded
   label/description, optional camelCase bounded `appMethod`, optional `input`
   declared in the action-registry field shapes, `create` function;
   `package-composition.js`: cross-package `appMethod` collision refusal.
2. **`packages/core/src/operation-runtime.js`** — one generic module, zero
   domain vocabulary: builds the bounded context and composes declared
   operations into an alias list. **Shipped narrower than the ADR's six-key
   sketch, by reviewer decision**: the v1 context is the CLOSED, frozen key
   set `{config, database, events, modules, runExternal}` — each key audited
   against the two real consumers, and the injected bounded trace writer
   (which neither consumer uses: catalog sync persists via the public
   `writeTrace` it already imports, the signature operations via
   `runExternalOperation`) is NOT shipped. The ADR-032 implementation
   addendum in `DECISIONS.md` records the audit and defers the writer to its
   first real consumer; `tests/package-operations-seam.test.js` asserts the
   exact key list with `trace` explicitly absent.
3. **`create-app.js`** — generic composition + alias attachment replacing
   BOTH named residues (the Commercial `createCatalogSyncOperation` lookup and
   the entire named Signature wiring); alias shadow refusal against existing
   app keys.
4. **`apps/server`** — the three enumerated routes keep their exact behaviour,
   delegating to the composed aliases; the raw-body webhook keeps its
   raw-body/header-allowlist/synthesized-actor/non-echoing-401 semantics
   byte-for-byte; the ambient `signature` schema block is removed (the package
   publishes under `domains`).
5. **AX1 / `/api/schema`** — additive publication of declared operation names
   (registry `get()`/`metadata()` and the inspect report).

Anything beyond this list stops the work and becomes a report, not code.

## Consumers and callers updated in this PR

Starter `install.mjs` (composes `createSignatureDomain`, drops the fixed
provider slot and the kernel action import; signature/order manifests read
from `packages/signature/modules/`), `tests/helpers/contracts-project.js`,
`tests/signature-*.test.js`, `tests/service-operations-upgrade.test.js`,
`examples/journeys/service-sla-escalation/journey.mjs`, Admin
(`admin-quotes.js` signature section resolves `schema.signature ??
schema.domains?.signature` — the Commercial precedent), AX1's fixed
`signature` slot removed, and the LA0 harness seam
(`tests/characterization/signature-harness.mjs` — the one characterization
file the extraction was designed to edit).

## Verification plan

`npm install`; both baseline replays (zero moved, fingerprints unchanged);
new `tests/signature-package-absence.test.js` (detach deletes no rows,
absence answers honest 404s incl. the webhook, reattach restores evidence);
old-DB upgrade (pre-extraction database boots, drift check passes, same
cents); `crm package test packages/signature`; full battery — `verify`,
`smoke`, `gtm:check`, `app inspect`, `doctor`, `project verify`, both
scenarios; CI green on the exact head. PR opened and left unmerged for the
independent review; PROJECT_STATUS/TASKS untouched.

## Results of record

- **Acceptance replays**: regenerated on the final composition — Signature
  asserted fingerprint `fe1875bf9cb68a5b4e8f55f79127cbec57581b9cd0e0b668569422e3cee9c82f`
  (110 observations) and Commercial `82c1f02fa3545f9c72abbc89121b26cb5562b3d792755f414275732310f3fcf2`
  (107) byte-identical across the extraction; Intelligence `f80592be…` (151)
  also unchanged. Non-asserted movement only: source digests, the
  intelligence schema-block key list gaining the declared `operations` key,
  and Commercial's `pre_extraction_evidence` probe `appMethodWired`
  flipping to `false` because `create-app.js` no longer names `syncCatalog`
  anywhere — the B7 residue ADR-032 exists to retire.
- **Plan pins re-measured, never transcribed**: `lead-to-won` holds at the
  repo composition `a0818b57…`; `govern-delivery-change` → `44c1f3e9…` (the
  delivery project its own test composes); `activate-support-and-manage-cases`
  and the verifier fixture → `f8b33cd5…` (the service scenario's
  composition). Evidence documents follow their plans' recomputed
  fingerprints; the verifier fixture reaches exit 0 through the real command.
- **Tour counts re-measured**: 71 modules, 9 packages, 66 resources,
  59 actions, 7 policies, 1 providers (the last fixed provider slot left
  with the extraction), eleven limitations — swept onto C-22, README,
  LAUNCH_PACKET, GO_TO_MARKET, the landing page, answers.json, concepts.json
  and SKILL_PACKAGING.
