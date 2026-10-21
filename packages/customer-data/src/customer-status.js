// @ts-check

/**
 * **One customer status rule for every reader.**
 *
 * Signed business promotes a contact to `cliente`; the negative claim is
 * definitive only when all three evidence sections are readable with
 * complete zero counts, otherwise `contatto` with the reason naming what
 * was not readable. Owned by customer-data (the consolidation authority):
 * the profile carries the verdict and the customer card reads it through
 * the declared `customer-profile@1` capability, so the two screens can
 * never disagree about who is a customer. Never imported by another
 * domain package — the hub consumes the capability, not this module.
 *
 * Each evidence section is `{ available, count, countIsComplete }` — the
 * same shape the consolidated profile sections carry, where a count taken
 * from a bounded page is a floor (`countIsComplete: false`), never a total.
 */

export const CUSTOMER_EVIDENCE_KEYS = Object.freeze(['orders', 'contracts', 'subscriptions']);

/**
 * @param {{orders?: any, contracts?: any, subscriptions?: any}} evidence
 */
export function deriveCustomerStatus({ orders = null, contracts = null, subscriptions = null } = {}) {
  const sections = { orders, contracts, subscriptions };
  const found = CUSTOMER_EVIDENCE_KEYS
    .filter((key) => sections[key]?.available === true && (sections[key]?.count ?? 0) > 0);
  const describeSection = (key) => {
    const section = sections[key];
    if (section?.available !== true) return `${key}: not readable here`;
    if ((section.count ?? 0) > 0) return `${key}: ${section.count} on record`;
    if (section.countIsComplete === false) return `${key}: partially readable`;
    return `${key}: none on record`;
  };
  const absenceIsProven = CUSTOMER_EVIDENCE_KEYS.every(
    (key) => sections[key]?.available === true
      && (sections[key]?.count ?? 0) === 0
      && sections[key]?.countIsComplete !== false,
  );
  if (found.length > 0) {
    return Object.freeze({ value: 'cliente', reason: `signed business on record: ${found.join(', ')}` });
  }
  if (absenceIsProven) {
    return Object.freeze({
      value: 'contatto',
      reason: 'no orders, contracts or subscriptions reference this customer — quotes and opportunities alone do not promote a contact',
    });
  }
  return Object.freeze({
    value: 'contatto',
    reason: `no signed business found in the composed packages (${CUSTOMER_EVIDENCE_KEYS.map(describeSection).join('; ')})`
      + ' — the evidence packages are not all readable here, so this is not a claim none exist',
  });
}
