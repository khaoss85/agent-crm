// @ts-check

import { definePackage } from '../../core/index.js';
import { SignatureRegistries } from './registry.js';
import { buildRequestSignatureAction, createSignatureOperations } from './operations.js';
import { createSignatureOrdersCapability } from './capability.js';

/**
 * The Signature & Order domain package (ADR-017, extracted under ADR-018 on
 * the ADR-032 operations seam).
 *
 * The third legacy domain to leave the kernel, and deliberately ONE package:
 * a verified completion atomically creates the immutable Order in the same
 * transaction as the envelope transition, `order:quote-version:<id>`
 * uniqueness is the envelope's own invariant, and no consumer needs Order
 * without Signature — a split would invent a capability edge with one
 * consumer on each side.
 *
 * **Nothing about what it verifies, refuses or snapshots changed in the
 * move.** That is the acceptance criterion, not a claim: the Signature LA0
 * baseline (110 observations, asserted fingerprint `fe1875bf…`) froze every
 * externally observable value before this extraction, and an asserted value
 * that moves fails the build.
 *
 * What did change is that the domain is now *optional and declared*: composed
 * by a static import in `packages/domains/generated/index.js`, never imported
 * by the kernel, reaching Commercial only through the declared capabilities
 * `commercial-quotes@1` and `commercial-quote-binding@1`, and attaching its
 * two application-scoped operations (`ingestSignatureEvent`,
 * `reconcileSignature`) through the ADR-032 operations contract instead of
 * named kernel wiring. The raw-body webhook route stays a hand-written,
 * kernel-reviewed endpoint in `apps/server` on the measured grounds ADR-032
 * records; it delegates to the composed operation.
 */

export const SIGNATURE_DOMAIN = 'signature';

/**
 * The record modules this package owns. The `quote` family it reads and the
 * one bounded linkage write it performs belong to the commercial package and
 * are reached only through the declared capabilities above — never claimed
 * here.
 */
export const SIGNATURE_RESOURCES = Object.freeze([
  'signature-envelope', 'signature-signer', 'signature-event', 'signed-artifact',
  'order', 'order-line', 'order-component', 'order-tier', 'order-total',
  // The signed commercial term of one Order (M16b prerequisite): copied from
  // the version's frozen snapshot at verified completion, write-once.
  'order-term',
]);

/**
 * Build the domain definition the application composes.
 *
 * Signature providers arrive the way every declared definition always has —
 * from checked-in project source — and are validated fail-closed by the
 * registries (ADR-015/ADR-017). `policies` stays empty for the recorded
 * ADR-022 reason (third application of the same deviation): shipped databases
 * hold `signature-provider` rows in `definition_versions`, and those rows ARE
 * the immutability evidence, so the package persists its own fingerprints
 * under the persisted identity (see `persistFingerprints`).
 *
 * @param {{
 *   signatureProviders?: any[],
 *   config?: Record<string, string>,
 * }} [options] `config` carries the record-module renames the action builder
 *   and operations already understood before the move.
 */
export function createSignatureDomain(options = {}) {
  const registries = new SignatureRegistries({ signatureProviders: options.signatureProviders ?? [] });
  const config = options.config;

  /**
   * Both declared operations share one composed instance PER APPLICATION:
   * they are two entry points into one recovery story (verified ingestion and
   * explicit reconciliation over the same envelope state machine). Keyed by
   * the bounded runtime, because one composition module may serve several
   * application instances in one process — a restart boots a new application
   * against the same static composition, and an instance cached against the
   * first boot would hold its closed database.
   */
  const composedByRuntime = new WeakMap();
  const operations = (runtime) => {
    let composed = composedByRuntime.get(runtime);
    if (!composed) {
      composed = createSignatureOperations({
        database: runtime.database,
        events: runtime.events,
        modules: runtime.modules,
        registries,
        runExternal: runtime.runExternal,
        config: { ...(config ?? {}), signatureTimeoutMs: runtime.config.signatureTimeoutMs },
      });
      composedByRuntime.set(runtime, composed);
    }
    return composed;
  };

  const pkg = definePackage({
    packageContract: 1,
    name: SIGNATURE_DOMAIN,
    // Version 2: signed commercial terms — the `order-term` resource, the
    // completion transaction copying the version's term snapshot onto the
    // Order, and the additive `orderTerm` read on `signature-orders@1`. The
    // composition contract grew; every pre-existing answer is byte-identical
    // (held by the LA0-Signature baseline, fe1875bf…).
    version: 2,
    label: 'Signature & Order',
    description:
      'Signature envelopes and immutable Orders: provider-backed envelope requests under a human-actor boundary, verified replay-proof webhook events, signed-artifact evidence, explicit reconciliation, and exactly one immutable Order per approved quote version — copied from the commercial snapshot, never re-read from the live catalog.',
    resources: [...SIGNATURE_RESOURCES],
    requires: [
      { package: 'commercial', capability: 'commercial-quotes', version: 1 },
      { package: 'commercial', capability: 'commercial-quote-binding', version: 1 },
    ],
    // The one thing this package offers other packages: read-only signed-Order
    // evidence, sized by its measured real consumer — Contract Activation
    // (see `capability.js`). It exists because a package whose actions target
    // `order` must be able to DECLARE that edge (DX4): the contracts package
    // requires it, and the conformance rail refuses an undeclared
    // record-level dependency on another package's resources.
    capabilities: [createSignatureOrdersCapability(config)],
    actions: [buildRequestSignatureAction(config, registries)],
    // Deliberately empty; see persistFingerprints below (the ADR-022 deviation).
    policies: [],
    /**
     * The two application-scoped operations (ADR-032). Run names
     * `signature.event` and `signature.reconcile` are frozen consumer-visible
     * values in the LA0 baseline and are grandfathered explicitly.
     */
    operations: [
      {
        operationContract: 1,
        name: 'ingest-signature-event',
        label: 'Ingest signature event',
        appMethod: 'ingestSignatureEvent',
        description:
          'Verify one provider webhook delivery as the exact bytes the provider signed, record it in the append-only replay-proof inbox, and apply its monotonic envelope transition — a verified completion atomically creates the signed artifact and the immutable Order.',
        input: [
          { name: 'provider', type: 'string', required: true, hint: 'Registered signature provider name, selected canonically from the webhook path.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.ingestSignatureEvent(params);
        },
      },
      {
        operationContract: 1,
        name: 'reconcile-signature',
        label: 'Reconcile signature envelope',
        appMethod: 'reconcileSignature',
        description:
          'Query the provider outside every transaction — by provider envelope id when known, otherwise by the deterministic idempotency key — and apply the same monotonic transition and atomic completion as a verified webhook. Explicit, audited recovery; no scheduler exists.',
        input: [
          { name: 'envelopeId', type: 'string', required: true, hint: 'The local envelope to reconcile against its provider.' },
        ],
        create(runtime) {
          const ops = operations(runtime);
          return (params) => ops.reconcileSignature(params);
        },
      },
    ],
    /** Function-free, additive schema metadata — the same block as before the move. */
    metadata() {
      return registries.metadata();
    },
  });

  /**
   * **Fingerprint persistence stays exactly where it was** — the same recorded
   * ADR-022 deviation the Intelligence and Commercial extractions made, for
   * the same reason. Signature has been writing `definition_versions` rows
   * typed `signature-provider` since M11; handing them to the package registry
   * would write a second set of rows in every shipped database, leave the
   * originals unmatched, and silently retire the drift check that makes a
   * registered version immutable. Persisted identity outranks a remapping.
   *
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);

  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return pkg;
}

export { SignatureRegistries } from './registry.js';
export {
  buildRequestSignatureAction,
  createSignatureOperations,
  buildDocumentPackage,
  canonicalJson,
  canonicalDocument,
  byteOrder,
  normalizeSigners,
  snapshotParties,
  signatureModuleNames,
  DOCUMENT_FORMAT,
} from './operations.js';
