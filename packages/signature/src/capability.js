// @ts-check

import { AppError } from '../../core/index.js';

/**
 * What Signature & Order offers to **other packages** — one read-only
 * capability, sized by its measured real consumer and no further
 * (`docs/plans/extract-signature-order-package.md`).
 *
 * The consumption inventory that sized it: Contract Activation
 * (`packages/contracts/src/activation.js`, `loadActivationSource`) reads the
 * accepted Order, its position-ordered lines, per-line components, grouped
 * totals, the completed envelope and the signed artifact — and re-proves their
 * coherence itself (status, hash agreement, counts) before activating. Nothing
 * else outside this package reads these records, and nothing outside this
 * package may ever write them, so there is exactly one capability and it
 * grants no write of any kind.
 */

/** The module names the capability reads, after any project rename. */
function resolvedNames(config = {}) {
  return {
    order: config.orderModule ?? 'order',
    orderLine: config.orderLineModule ?? 'order-line',
    orderComponent: config.orderComponentModule ?? 'order-component',
    orderTotal: config.orderTotalModule ?? 'order-total',
    envelope: config.envelopeModule ?? 'signature-envelope',
    artifact: config.artifactModule ?? 'signed-artifact',
  };
}

/** @param {any} modules @param {string} name */
function service(modules, name) {
  const module = modules.get(name);
  if (!module?.service) {
    throw new AppError(`The signature package is installed without its "${name}" records`, {
      code: 'SIGNATURE_STORAGE_INVALID', status: 500,
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

/** @param {any} context @param {string} capability */
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
 * `signature-orders@1` — read-only signed-Order evidence, inside the caller's
 * transaction.
 *
 * The rows are returned as stored, frozen: the immutable snapshot the Order
 * took at verified completion — integer cents, basis points, the
 * `documentHash` the envelope and artifact must agree on — IS the contract a
 * consumer copies without interpreting. The semantic guarantees a consumer may
 * rely on, unchanged from the day they were built:
 *
 * 1. immutability — an Order and its lines, components, tiers and totals are
 *    written once, in the same transaction as the envelope's completion, and
 *    never rewritten;
 * 2. provenance — `order.envelopeId`/`signedArtifactId` name the signature
 *    evidence, and all three carry the same `documentHash` of the document
 *    that was actually signed;
 * 3. completeness — `order.lineCount` and each line's `componentCount` state
 *    exactly how many rows the snapshot holds, so a consumer can prove it read
 *    everything;
 * 4. uniqueness — at most one Order exists per quote version
 *    (`order:quote-version:<id>` is the envelope transition's own invariant).
 *
 * The capability grants no write: activation state belongs to its consumer,
 * and the Order itself belongs to nobody's pen — including this package's,
 * after creation.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function createSignatureOrdersCapability(config) {
  const names = resolvedNames(config);
  return {
    name: 'signature-orders',
    version: 1,
    description:
      'Read a signed immutable Order and its evidence: the order row, position-ordered lines, per-line price components, grouped totals, the signature envelope and the signed artifact. Grants no write, no envelope lifecycle, no provider access and no storage handle.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = requireModules(context, 'signature-orders@1');
      return {
        capabilityContract: 1,

        /** The immutable Order row, or null — status, counts and provenance live on it. @param {string} orderId */
        order(orderId) {
          const record = typeof orderId === 'string' && orderId !== '' ? safeGet(service(modules, names.order), orderId) : null;
          return record ? Object.freeze({ ...record }) : null;
        },

        /** Every order line, exact indexed read, position-ordered. @param {string} orderId */
        orderLines(orderId) {
          return Object.freeze(service(modules, names.orderLine).listWhere({ orderId })
            .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position))
            .map((row) => Object.freeze({ ...row })));
        },

        /** Every price component of one order line, componentKey-ordered. @param {string} orderLineId */
        orderComponents(orderLineId) {
          return Object.freeze(service(modules, names.orderComponent).listWhere({ orderLineId })
            .sort((a, b) => (a.componentKey === b.componentKey ? (a.id < b.id ? -1 : 1) : a.componentKey < b.componentKey ? -1 : 1))
            .map((row) => Object.freeze({ ...row })));
        },

        /** Every grouped total; unlike periods are never summed. @param {string} orderId */
        orderTotals(orderId) {
          return Object.freeze(service(modules, names.orderTotal).listWhere({ orderId })
            .map((row) => Object.freeze({ ...row })));
        },

        /** The signature envelope named by the order's provenance, or null. @param {string} envelopeId */
        envelope(envelopeId) {
          const record = typeof envelopeId === 'string' && envelopeId !== '' ? safeGet(service(modules, names.envelope), envelopeId) : null;
          return record ? Object.freeze({ ...record }) : null;
        },

        /** The signed artifact named by the order's provenance, or null. @param {string} artifactId */
        signedArtifact(artifactId) {
          const record = typeof artifactId === 'string' && artifactId !== '' ? safeGet(service(modules, names.artifact), artifactId) : null;
          return record ? Object.freeze({ ...record }) : null;
        },
      };
    },
  };
}
