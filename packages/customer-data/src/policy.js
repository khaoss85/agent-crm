// @ts-check

import { ValidationError, computeDefinitionFingerprint } from '../../core/index.js';

/**
 * **Deterministic customer matching, and nothing cleverer.**
 *
 * Every rule here is exact: an identifier equals an identifier, or a
 * normalized string equals a normalized string. There is no fuzzy comparison,
 * no similarity score, no ML, no threshold and — the property that matters
 * most — **no tie-break**. When the evidence points at more than one record
 * the answer is `unresolved` and a duplicate candidate for a human, never a
 * guess dressed as a decision.
 *
 * The rules run in a fixed precedence, and the rule that fired is recorded on
 * the row receipt, so "why did this row match that company" is answerable from
 * storage months later without re-running anything:
 *
 * 1. `external-identity` — the same `system` + `externalId` already points at
 *    a record. The strongest evidence available, because somebody asserted it.
 * 2. `contact-email` — exact normalized email. Core stores `contacts.email`
 *    lowercased and globally unique, and the match is delegated to the core
 *    adapter that owns that rule rather than re-implemented here.
 * 3. `company-name-domain` — exact normalized company name **and** exact
 *    normalized domain. Name alone never matches: it produces a candidate.
 *
 * The policy is a declared definition (ADR-015): synchronous, total,
 * deterministic, its config JSON-safe and its fingerprint covering the source
 * of every rule, so a changed rule is a changed fingerprint on every receipt.
 */

export const MATCH_POLICY_KIND = 'customer-match-policy';

/** The rule identities a receipt may carry. Closed set, checked at build. */
export const MATCH_RULES = Object.freeze([
  'external-identity',
  'contact-email',
  'company-name-domain',
  'none',
]);

/** Outcomes the resolver may return. `unresolved` is a first-class answer. */
export const MATCH_OUTCOMES = Object.freeze(['matched', 'unmatched', 'unresolved']);

/**
 * Build the v1 policy. `config` is declared JSON-safe data so the fingerprint
 * covers it; a closure-held table would be invisible to it, which is the ADR-015
 * failure this shape exists to prevent.
 *
 * @param {{requireDomainForCompanyMatch?: boolean}} [config]
 */
export function defineCustomerMatchPolicy(config = {}) {
  const declared = Object.freeze({
    // Kept as declared config rather than a constant so that turning it off is
    // a *different fingerprint*, not an invisible behaviour change.
    requireDomainForCompanyMatch: config.requireDomainForCompanyMatch !== false,
  });

  const definition = {
    name: 'deterministic-customer-match',
    version: 1,
    label: 'Deterministic customer match',
    description:
      'Exact external identity, then exact normalized email, then exact normalized company name with an exact domain. '
      + 'No fuzzy matching, no scoring and no tie-break: ambiguous evidence resolves to unresolved with a duplicate candidate.',
    config: declared,

    /**
     * Resolve one normalized input row against what already exists.
     *
     * Pure over its inputs: it reads through the reader it is handed and
     * writes nothing. The reader is supplied by the caller so this stays
     * testable and so the policy never holds a storage handle.
     *
     * @param {{
     *   row: {system: string, externalId: string|null, email: string|null, companyName: string|null, domain: string|null},
     *   reader: {
     *     externalIdentity: (system: string, externalId: string) => any,
     *     contactByEmail: (email: string) => any,
     *     companiesByName: (name: string) => Array<{id: string, name: string, domain: string|null}>,
     *   },
     * }} input
     * @returns {{outcome: string, rule: string, subject: any, candidates: any[], evidence: string}}
     */
    resolve({ row, reader }) {
      // ── 1 · external identity ───────────────────────────────────────────
      if (row.externalId) {
        const existing = reader.externalIdentity(row.system, row.externalId);
        if (existing) {
          return {
            outcome: 'matched',
            rule: 'external-identity',
            subject: {
              resource: existing.subjectResource,
              id: existing.subjectId,
              owner: existing.subjectOwner,
              ownerPackage: existing.subjectOwnerPackage,
              label: existing.subjectLabel,
            },
            candidates: [],
            evidence: `external identity ${row.system}:${row.externalId} already names this record`,
          };
        }
      }

      // ── 2 · exact normalized email ──────────────────────────────────────
      if (row.email) {
        const contact = reader.contactByEmail(row.email);
        if (contact) {
          return {
            outcome: 'matched',
            rule: 'contact-email',
            subject: { resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null, label: contact.email },
            candidates: [],
            evidence: 'exact normalized email equals an existing contact address',
          };
        }
      }

      // ── 3 · exact company name AND exact domain ─────────────────────────
      if (row.companyName) {
        const companies = reader.companiesByName(row.companyName);
        if (companies.length === 1 && !declared.requireDomainForCompanyMatch) {
          return {
            outcome: 'matched',
            rule: 'company-name-domain',
            subject: { resource: 'company', id: companies[0].id, owner: 'host', ownerPackage: null, label: companies[0].name },
            candidates: [],
            evidence: 'exact normalized company name, with the domain requirement disabled by policy config',
          };
        }
        if (companies.length > 0 && row.domain) {
          const byDomain = companies.filter(
            (company) => typeof company.domain === 'string' && company.domain.trim().toLowerCase() === row.domain);
          if (byDomain.length === 1) {
            return {
              outcome: 'matched',
              rule: 'company-name-domain',
              subject: { resource: 'company', id: byDomain[0].id, owner: 'host', ownerPackage: null, label: byDomain[0].name },
              candidates: [],
              evidence: 'exact normalized company name and exact domain',
            };
          }
          if (byDomain.length > 1) {
            // Two stored companies share a name AND a domain. That is a real
            // duplicate in the data, and picking one would hide it.
            return {
              outcome: 'unresolved',
              rule: 'company-name-domain',
              subject: null,
              candidates: byDomain.map((company) => ({ resource: 'company', id: company.id, owner: 'host', ownerPackage: null, label: company.name })),
              evidence: `${byDomain.length} existing companies share this normalized name and domain`,
            };
          }
        }
        if (companies.length > 0) {
          // Name matches but the domain does not decide it. Never a match.
          return {
            outcome: 'unresolved',
            rule: 'company-name-domain',
            subject: null,
            candidates: companies.map((company) => ({ resource: 'company', id: company.id, owner: 'host', ownerPackage: null, label: company.name })),
            evidence: row.domain
              ? 'company name matches an existing record but no domain matches exactly'
              : 'company name matches an existing record and the row carries no domain to decide it',
          };
        }
      }

      return { outcome: 'unmatched', rule: 'none', subject: null, candidates: [], evidence: 'no deterministic rule matched an existing record' };
    },
  };

  const fingerprint = computeDefinitionFingerprint({
    type: `domain-policy:${MATCH_POLICY_KIND}`,
    domain: 'customer-data',
    name: definition.name,
    version: definition.version,
    config: definition.config,
    handlers: [{ property: 'resolve', source: definition.resolve }],
  });

  return Object.freeze({ ...definition, fingerprint });
}

/** Fail-closed check that a resolver answer is one this package understands. */
export function assertMatchResult(result, label) {
  if (!result || typeof result !== 'object') {
    throw new ValidationError(`${label} returned no result`);
  }
  if (!MATCH_OUTCOMES.includes(result.outcome)) {
    throw new ValidationError(`${label} returned an unknown outcome`);
  }
  if (!MATCH_RULES.includes(result.rule)) {
    throw new ValidationError(`${label} returned an unknown rule`);
  }
  if (result.outcome === 'matched' && !result.subject) {
    throw new ValidationError(`${label} reported a match without naming the record it matched`);
  }
  return result;
}
