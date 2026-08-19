// @ts-check

import { AppError } from '../../core/index.js';
import {
  TERMS_SNAPSHOT_AMBIGUOUS, verifyOrderTermRows, verifySelfConsistent,
} from './verify-terms.js';

/**
 * What Commercial Operations offers to **other packages** — two capabilities,
 * sized by their measured real consumers and no further
 * (`docs/plans/extract-commercial-operations-package.md` §B4).
 *
 * The consumption inventory that sized them (the Signature/Order
 * characterization, §1): Signature imports zero Commercial code; it consumes
 * the `quote` record family **by record semantics** — read-only quote-version
 * evidence copied verbatim into the signed document package and the immutable
 * Order, plus one bounded managed write stamping signature linkage onto the
 * quote. Future M16b amendment execution and Delivery commercial-followup are
 * read-side consumers of the same evidence.
 *
 * Read authority and mutation authority differ, so they are separate
 * capabilities. There is deliberately no capability-per-method, no catalog
 * write, no policy evaluation and no registration surface.
 */

/** The module names the capabilities read, after any project rename. */
function resolvedNames(config = {}) {
  return {
    quote: config.quoteModule ?? 'quote',
    version: config.versionModule ?? 'quote-version',
    versionLine: config.versionLineModule ?? 'quote-version-line',
    versionComponent: config.versionComponentModule ?? 'quote-version-component',
    versionTotal: config.versionTotalModule ?? 'quote-version-total',
    versionTerm: config.versionTermModule ?? 'quote-version-term',
  };
}

/** @param {any} modules @param {string} name */
function service(modules, name) {
  const module = modules.get(name);
  if (!module?.service) {
    throw new AppError(`The commercial package is installed without its "${name}" records`, {
      code: 'COMMERCIAL_STORAGE_INVALID', status: 500,
    });
  }
  return module.service;
}

/** Exact primary-key read that answers null instead of throwing. */
function safeGet(recordService, id) {
  try {
    return recordService.get(id);
  } catch {
    return null;
  }
}

/** @param {any} modules */
function requireModules(context, capability) {
  const modules = context?.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError(`${capability} requires the caller's modules view`, {
      code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
    });
  }
  return modules;
}

/**
 * `commercial-quotes@1` — read-only quote and quote-version evidence, inside
 * the caller's transaction.
 *
 * The rows are returned as stored, frozen: the column shapes — including the
 * `tiersJson`/`tierBreakdownJson` encodings and the integer-cents /
 * basis-points money conventions (ADR-014) — ARE the contract a consumer
 * copies without interpreting. The semantic guarantees a consumer may rely on,
 * unchanged from the day they were built:
 *
 * 1. lifecycle — `quote.status`/`currentVersionId` name the one signable
 *    version: current, approved, not policy-rejected;
 * 2. immutability — version lines, components and totals are never rewritten
 *    after submission, whatever the live catalog does next;
 * 3. completeness — a submitted version carries at least one line and one
 *    grouped total;
 * 4. explainability — the version carries its discount policy name, version
 *    and declared-definition fingerprint verbatim.
 *
 * @param {any} registries the package's CommercialRegistries instance
 * @param {Record<string, string>} [config] module renames
 */
export function createCommercialQuotesCapability(registries, config) {
  const names = resolvedNames(config);
  return {
    name: 'commercial-quotes',
    version: 1,
    description:
      'Read a quote and its immutable quote-version evidence (version, lines, components, totals) plus the declared discount-policy identities and fingerprints. Grants no catalog write, no policy evaluation, no registration and no storage handle.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = requireModules(context, 'commercial-quotes@1');
      return {
        capabilityContract: 1,

        /** The quote record, or null — the lifecycle facts live on it. @param {string} quoteId */
        quote(quoteId) {
          const record = typeof quoteId === 'string' && quoteId !== '' ? safeGet(service(modules, names.quote), quoteId) : null;
          return record ? Object.freeze({ ...record }) : null;
        },

        /** One immutable Quote Version row, or null. @param {string} versionId */
        version(versionId) {
          const record = typeof versionId === 'string' && versionId !== '' ? safeGet(service(modules, names.version), versionId) : null;
          return record ? Object.freeze({ ...record }) : null;
        },

        /** Every version line, exact indexed read, position-ordered. @param {string} versionId */
        versionLines(versionId) {
          return Object.freeze(service(modules, names.versionLine).listWhere({ versionId })
            .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position))
            .map((row) => Object.freeze({ ...row })));
        },

        /** Every version component, exact indexed read. @param {string} versionId */
        versionComponents(versionId) {
          return Object.freeze(service(modules, names.versionComponent).listWhere({ versionId })
            .map((row) => Object.freeze({ ...row })));
        },

        /** Every grouped total; unlike periods are never summed. @param {string} versionId */
        versionTotals(versionId) {
          return Object.freeze(service(modules, names.versionTotal).listWhere({ versionId })
            .map((row) => Object.freeze({ ...row })));
        },

        /**
         * The version's immutable signed-term snapshot, or null — most
         * versions predate terms and have none, and null is that historical
         * fact, never an error. Additive on capability version 1: every
         * pre-existing answer is byte-identical (the M16a precedent bumped a
         * capability version because existing answers changed shape; a new
         * read the next consumer opts into is the case its map-based design
         * explicitly reserved for staying put). A project that never applied
         * the quote-version-term manifest also answers null.
         * @param {string} versionId
         */
        versionTerm(versionId) {
          let terms = null;
          try {
            terms = modules.get(names.versionTerm)?.service ?? null;
          } catch {
            terms = null;
          }
          if (!terms || typeof versionId !== 'string' || versionId === '') return null;
          const record = terms.listWhere({ versionId })[0] ?? null;
          return record ? Object.freeze({ ...record }) : null;
        },

        /** Declared discount-policy identities with fingerprints, function-free. */
        policies() {
          return registries.metadata().discountPolicies;
        },
      };
    },
  };
}

/**
 * `commercial-quotes@2` — everything `@1` reads, plus the **authoritative
 * signed-term verifier** every consumer of signed terms must call before
 * treating a snapshot as signed evidence (`verify-terms.js`).
 *
 * **Why a new version rather than an additive method on `@1`.** The doctrine
 * this repository now records (ADR-036) bumps a capability when a new method
 * becomes required for correctness or a stronger semantic guarantee arrives.
 * Both are true here: `verifySignedTerms` is not an optional convenience —
 * a consumer that skips it can describe a corrupted row as signed — and `@2`
 * carries a guarantee `@1` never made. `@1` stays offered, byte-identical, so
 * a consumer that has not migrated keeps exactly the answers it had; the
 * registry keys capabilities `name@version`, so both compose side by side.
 *
 * @param {any} registries the package's CommercialRegistries instance
 * @param {Record<string, string>} [config] module renames
 */
export function createCommercialQuotesVerifiedCapability(registries, config) {
  const base = createCommercialQuotesCapability(registries, config);
  const names = resolvedNames(config);
  return {
    name: 'commercial-quotes',
    version: 2,
    description:
      'Everything commercial-quotes@1 reads, plus verifySignedTerms: the authoritative check that a signed-term snapshot still matches '
      + 'its own canonical fingerprint and the quote version it was copied from. A consumer that describes terms as signed calls it first.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = requireModules(context, 'commercial-quotes@2');
      const inner = base.create(context);
      const versionTermRows = (versionId) => {
        let terms = null;
        try {
          terms = modules.get(names.versionTerm)?.service ?? null;
        } catch {
          terms = null;
        }
        if (!terms || typeof versionId !== 'string' || versionId === '') return [];
        return terms.listWhere({ versionId });
      };

      return Object.freeze({
        ...inner,
        capabilityContract: 1,

        /**
         * Verify a signed-term snapshot. Read-only: it loads evidence, checks
         * it and answers — it never repairs, rewrites or creates a row, and it
         * hands back no storage handle and no fingerprint function.
         *
         * `scope: 'quote-version'` verifies Commercial's own authoritative
         * snapshot for a version. `scope: 'order'` verifies a copied
         * `order-term` **row the caller already holds** — Signature owns that
         * record, so the caller passes the rows and this decides — against its
         * own fingerprint *and* against the authoritative version snapshot.
         *
         * Answers `null` when there is no snapshot at all: absence is the
         * ordinary historical case (ADR-033 backfills nothing, ever), and a
         * consumer must present it as unsigned, never as a verified term.
         *
         * @param {{scope: 'quote-version'|'order', versionId?: string, orderId?: string, rows?: any[]}} request
         */
        verifySignedTerms(request = /** @type {any} */ ({})) {
          if (request?.scope === 'quote-version') {
            const rows = versionTermRows(request.versionId ?? '');
            if (rows.length === 0) return null;
            if (rows.length > 1) {
              throw new AppError(
                'This quote version carries more than one signed-term snapshot, so which term was frozen cannot be decided from the evidence',
                { code: TERMS_SNAPSHOT_AMBIGUOUS, status: 409, details: Object.freeze({ quoteVersionId: request.versionId ?? null, count: rows.length }) },
              );
            }
            const verified = verifySelfConsistent(rows[0], { kind: 'quoteVersion', id: String(request.versionId ?? '') });
            return Object.freeze({ verified, row: Object.freeze({ ...rows[0] }) });
          }
          if (request?.scope === 'order') {
            const outcome = verifyOrderTermRows({
              rows: Array.isArray(request.rows) ? request.rows : [],
              authoritativeFor: (versionId) => versionTermRows(versionId)[0] ?? null,
              orderId: String(request.orderId ?? ''),
            });
            return outcome ? Object.freeze({ verified: outcome.verified, row: Object.freeze({ ...outcome.row }) }) : null;
          }
          throw new AppError('verifySignedTerms needs an explicit scope of "quote-version" or "order"', {
            code: 'CAPABILITY_REQUEST_INVALID', status: 400,
          });
        },
      });
    },
  };
}

/**
 * The only fields another domain may stamp onto a quote: the external
 * signature/order linkage the quote manifest already declares managed for
 * exactly this purpose. Anything else in a patch is refused — quote pricing,
 * status transitions and approval remain the quote actions' authority.
 */
export const QUOTE_BINDING_FIELDS = Object.freeze(['signatureEnvelopeId', 'signatureStatus', 'orderId']);

/**
 * `commercial-quote-binding@1` — the **declared, documented edge** for the one
 * bounded write another domain performs on a quote: the signature/order domain
 * stamping external linkage onto it. Its authority semantics differ from every
 * read, which is why it is a separate capability.
 *
 * Deliberately **not** a write mechanism. The write itself is, and stays, the
 * quote record's own managed path (`applyManaged` on fields the quote manifest
 * declares `writable: "managed"` for exactly this purpose) — the same code the
 * signature domain runs today, not a second path. What was missing was the
 * *declaration*: a package patching another package's record had no edge to
 * declare and nothing stating which fields are its to patch. This capability
 * is that edge — versioned, inspectable in AX1, citable in a Solution Plan —
 * and its interface is the contract: the field allowlist and the semantic
 * guarantees, frozen data rather than functions.
 *
 * (The DX4 measurement behind this shape: record access by module name is the
 * ordinary mechanism; the gap was declaration and documented semantics, so a
 * runtime write wrapper would have added a second path where the seam only
 * needed the first one named.)
 */
export function createCommercialQuoteBindingCapability() {
  return {
    name: 'commercial-quote-binding',
    version: 1,
    description:
      'The declared edge for stamping external signature/order linkage onto a quote: exactly signatureEnvelopeId, signatureStatus and orderId, written through the quote record\'s own managed path. The capability names the fields and the guarantee; it adds no second write mechanism, no pricing authority and no approval authority.',
    create({ consumer } = {}) {
      return Object.freeze({
        capabilityContract: 1,
        /** The only quote fields another domain may patch. */
        fields: QUOTE_BINDING_FIELDS,
        /** The semantics the consumer may rely on, stated as data. */
        contract: Object.freeze({
          writePath: 'applyManaged on the quote record module — the manifest declares these fields writable: "managed"',
          authority: 'external signature/order progress only; quote pricing, lifecycle transitions and approval remain the quote actions\' own',
          consumer: consumer ?? null,
        }),
      });
    },
  };
}
