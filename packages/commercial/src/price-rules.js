// @ts-check

import { ValidationError, requireBps } from '../../core/index.js';
import { validateDiscountPolicy } from './registry.js';

/**
 * Catalog price rules (accordo BO-F2-04, "Regole di prezzo del catalogo").
 *
 * The backoffice "11 Catalogo prodotti" prototype shows its price rules as
 * switches that enforce nothing; this is the real evaluation that replaces
 * them, and it lives in the package — never in the interface. Any caller
 * that submits a quote (operator UI, server action, AI-suggested lines added
 * through `quote.add-line`) meets the same gate in `quote.submit`.
 *
 * How the three prototype rules map onto the framework, without doubles
 * (MEM_ACC_REUSE):
 *
 * - "sconti a quantità automatici" — quantity pricing is automatic in the
 *   catalog itself: volume/graduated tiers price the reached band
 *   server-side (`money.js`, `catalog-sync.js`) and clients can never submit
 *   a tier, a unit price or a total. The policy only judges the negotiated
 *   per-line `discountBps`, so tier-derived amounts never need approval.
 * - "ok della titolare sopra lo sconto massimo" — a line discount above the
 *   auto-approve band but within the maximum returns `approval_required`
 *   with `requiredApprovalKey` (default `'owner'`); only a human actor can
 *   then approve or reject, and the approval row carries the policy
 *   fingerprint as evidence. Above the maximum the submit is refused.
 * - "IVA predefinita" — VAT is the statutory default (`VAT_RATE_BPS`, 22%),
 *   pinned into every frozen version by the pricer (`withVatTotals`), never
 *   a negotiated term: the policy does not take a rate and there is nothing
 *   to approve.
 *
 * A refused submit (`reject`) keeps the quote in `draft`: the refusal reason
 * and the matched rule freeze onto the immutable version as evidence, the
 * quote stays editable, and the next submit freezes the next version. "Le
 * regole bloccano anche l'AI" holds because AI-suggested lines enter through
 * the same `add-line` + `submit` path with the same policy.
 */

export const CATALOG_PRICE_RULES = 'catalog-price-rules';
export const CATALOG_PRICE_RULES_VERSION = 1;
export const DEFAULT_OWNER_APPROVAL_KEY = 'owner';
const MAX_APPROVAL_KEY_CHARS = 200;

/** @param {unknown} value @param {string} field */
function requireBandLimit(value, field) {
  return requireBps(value, field);
}

/**
 * Build the BO-F2-04 discount policy definition, ready to register in
 * `createCommercialDomain({ discountPolicies })`.
 *
 * @param {{autoApproveMaxBps?: number, ownerApprovalMaxBps?: number, approvalKey?: string}} [config]
 */
export function createCatalogPriceRules(config = {}) {
  const {
    autoApproveMaxBps = 1000,
    ownerApprovalMaxBps = 3000,
    approvalKey = DEFAULT_OWNER_APPROVAL_KEY,
  } = config ?? {};
  const auto = requireBandLimit(autoApproveMaxBps, 'autoApproveMaxBps');
  const ownerMax = requireBandLimit(ownerApprovalMaxBps, 'ownerApprovalMaxBps');
  if (ownerMax < auto) {
    throw new ValidationError('ownerApprovalMaxBps must be at least autoApproveMaxBps', { field: 'ownerApprovalMaxBps' });
  }
  if (typeof approvalKey !== 'string' || approvalKey.trim() === '' || approvalKey.length > MAX_APPROVAL_KEY_CHARS) {
    throw new ValidationError(`approvalKey must be non-empty text of at most ${MAX_APPROVAL_KEY_CHARS} characters`, { field: 'approvalKey' });
  }
  const definition = {
    name: CATALOG_PRICE_RULES,
    version: CATALOG_PRICE_RULES_VERSION,
    label: 'Catalog price rules (BO-F2-04)',
    config: { autoApproveMaxBps: auto, ownerApprovalMaxBps: ownerMax, approvalKey },
    /** @param {{maxLineDiscountBps?: unknown, config?: any}} ctx */
    evaluate(ctx) {
      const limits = ctx?.config ?? {};
      const autoLimit = requireBandLimit(limits.autoApproveMaxBps, 'policy.config.autoApproveMaxBps');
      const ownerLimit = requireBandLimit(limits.ownerApprovalMaxBps, 'policy.config.ownerApprovalMaxBps');
      const rawKey = limits.approvalKey;
      if (typeof rawKey === 'string' && rawKey !== '' && rawKey.trim() === '') {
        throw new ValidationError(`approvalKey must be non-empty text of at most ${MAX_APPROVAL_KEY_CHARS} characters`, { field: 'policy.config.approvalKey' });
      }
      const key = typeof rawKey === 'string' && rawKey !== '' ? rawKey : DEFAULT_OWNER_APPROVAL_KEY;
      const maxLine = requireBps(ctx?.maxLineDiscountBps, 'maxLineDiscountBps');
      if (maxLine <= autoLimit) {
        return {
          decision: 'auto_approve',
          reason: `max line discount ${maxLine}bps within the auto-approve band (≤ ${autoLimit}bps)`,
          matchedRule: 'auto-approve-within-limit',
        };
      }
      if (maxLine <= ownerLimit) {
        return {
          decision: 'approval_required',
          reason: `max line discount ${maxLine}bps above the auto-approve band: owner approval required (≤ ${ownerLimit}bps)`,
          requiredApprovalKey: key,
          matchedRule: 'owner-approval-above-max',
        };
      }
      return {
        decision: 'reject',
        reason: `max line discount ${maxLine}bps above the maximum ${ownerLimit}bps: no approval can release it`,
        matchedRule: 'above-maximum',
      };
    },
  };
  return validateDiscountPolicy(definition);
}
