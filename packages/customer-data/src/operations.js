// @ts-check

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { IMPORT_MAPPING, REASON, mappingFingerprint, resolveBatch } from './import.js';
import { detectIssues } from './quality.js';
import { canonicalClusterFor, profileFor } from './profile.js';
import { optional, orderedPair, resolvedNames, subjectFields, subjectKey, trusted } from './store.js';

/**
 * **The application operations (ADR-032): import preview, import apply, and the
 * consolidated profile read.**
 *
 * These are application-scoped rather than record actions because none of them
 * belongs to a single record: an import is about a batch that may create the
 * very records it targets, and a profile spans every optional package that
 * happens to be composed. That is exactly the shape ADR-032 exists for, and the
 * bounded context it hands over — database, modules, events, config — is all
 * they take.
 *
 * The three properties worth stating once:
 *
 * - **preview writes nothing.** It resolves and returns receipts. No business
 *   record, no `customer-data` record, no audit entry, no event.
 * - **apply re-resolves inside its own transaction.** A preview is never an
 *   authorisation; the same resolution runs again against state as it is at
 *   commit time.
 * - **the profile reads.** It creates nothing, and a package that is not
 *   composed reads `available: false` with a reason rather than an empty list
 *   that would read as "this customer has none".
 */

/** @param {any} runtime @param {any} registries */
export function createCustomerDataOperations({ database, modules, events, config, core, policy, names }) {
  if (!database || !modules || !events) {
    throw new ValidationError('customer-data operations need database, modules and events');
  }
  if (!policy || typeof policy.resolve !== 'function') {
    throw new ValidationError('customer-data operations need the declared match policy');
  }

  /**
   * The read side the policy resolves against. It is built per call so a
   * resolution always sees current state — never a cached view captured when
   * the operation was composed.
   */
  const readerFor = () => ({
    externalIdentity(system, externalId) {
      return trusted(modules, names.identity)
        .listWhere({ sourceKey: `${system}:${externalId}` })
        .find((row) => row.status === 'active') ?? null;
    },
    contactByEmail(email) {
      // Delegated: core owns email uniqueness and its normalization.
      return core && typeof core.findContactByEmail === 'function' ? core.findContactByEmail(email) : null;
    },
    companiesByName(name) {
      return core && typeof core.findCompaniesByNormalizedName === 'function' ? core.findCompaniesByNormalizedName(name) : [];
    },
  });

  /** Shared summary shape for both preview and apply. */
  const summarize = (resolution, mode, runId = null) => ({
    mode,
    runId,
    system: resolution.system,
    acceptance: resolution.acceptance,
    mapping: { name: IMPORT_MAPPING.name, version: IMPORT_MAPPING.version, fingerprint: mappingFingerprint() },
    policy: { name: policy.name, version: policy.version, fingerprint: policy.fingerprint },
    idempotencyKey: resolution.idempotencyKey,
    counts: resolution.counts,
    receipts: resolution.receipts.map((receipt) => Object.freeze({
      index: receipt.index,
      outcome: receipt.outcome,
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      matchRule: receipt.rule,
      subject: receipt.subject ?? null,
      candidates: receipt.candidates ?? [],
      willCreate: Boolean(receipt.created),
    })),
    limitations: LIMITATIONS,
  });

  return {
    /**
     * Import preview. **Writes nothing** — the whole point of the surface.
     * @param {any} request
     */
    async previewCustomerImport(request) {
      const resolution = resolveBatch({ request, policy, reader: readerFor() });
      return Object.freeze({
        ...summarize(resolution, 'preview'),
        writes: 'nothing — this is a preview, and it records neither business data nor an import run',
      });
    },

    /**
     * Import apply. Human-or-agent, but every write is inside one transaction
     * and the resolution is recomputed here rather than trusted from a caller.
     * @param {any} request
     */
    async applyCustomerImport(request) {
      const actor = normalizeActor(request?.actor);
      // Re-resolve authoritatively. A preview handed in by the caller is
      // deliberately ignored: stale readiness authorises nothing.
      const resolution = resolveBatch({ request, policy, reader: readerFor() });

      if (resolution.acceptance === 'all_or_nothing' && resolution.counts.rejected + resolution.counts.skipped > 0) {
        throw new AppError(
          `This import is all-or-nothing and ${resolution.counts.rejected + resolution.counts.skipped} of ${resolution.counts.rows} rows could not be accepted, so nothing was written`,
          {
            code: 'IMPORT_NOT_FULLY_ACCEPTABLE', status: 409,
            details: Object.freeze({ counts: resolution.counts, firstProblemRow: resolution.receipts.find((r) => r.outcome !== 'accepted')?.index ?? null }),
          },
        );
      }

      const runs = trusted(modules, names.run);
      const existing = runs.listWhere({ idempotencyKey: resolution.idempotencyKey })[0];
      if (existing) {
        // Same payload → same run. A *different* payload cannot reach here:
        // the key is derived from the payload itself.
        return Object.freeze({
          ...summarize(resolution, 'apply', existing.id),
          replayed: true,
          writes: 'nothing new — this exact import was already applied, and its run is returned unchanged',
        });
      }

      const applied = await database.transactionAsync(async () => {
        const run = await runs.createManaged({
          sourceKey: `customer-import:${resolution.idempotencyKey}`,
          idempotencyKey: resolution.idempotencyKey,
          system: resolution.system,
          mapping: IMPORT_MAPPING.name,
          mappingVersion: IMPORT_MAPPING.version,
          mappingFingerprint: mappingFingerprint(),
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          acceptance: resolution.acceptance,
          status: 'applied',
          rowCount: resolution.counts.rows,
          acceptedCount: resolution.counts.accepted,
          rejectedCount: resolution.counts.rejected,
          skippedCount: resolution.counts.skipped,
          candidateCount: 0,
          issueCount: 0,
          actorType: actor.type,
          actorId: actor.id,
          appliedAt: new Date().toISOString(),
        }, { actor });

        let candidateCount = 0;
        let issueCount = 0;

        for (const receipt of resolution.receipts) {
          let subject = receipt.subject ?? null;

          // Create the record the row names, when nothing matched it.
          if (receipt.outcome === 'accepted' && receipt.created) {
            subject = await createSubjectFor(receipt.row, actor);
          }

          await trusted(modules, names.row).createManaged({
            sourceKey: `customer-import-row:${run.id}:${receipt.index}`,
            runId: run.id,
            rowIndex: receipt.index,
            inputDigest: receipt.inputDigest,
            outcome: receipt.outcome,
            reasonCode: receipt.reasonCode,
            reason: receipt.reason,
            matchRule: receipt.rule,
            ...subjectFields(subject ?? { resource: 'none', id: 'none', owner: 'host', ownerPackage: null, label: null }),
            createdSubject: Boolean(receipt.created),
          }, { actor });

          // External identity: recorded for every accepted row that carries one.
          if (receipt.outcome === 'accepted' && subject && receipt.row?.externalId) {
            await recordExternalIdentity(receipt.row, subject, run.id, actor);
          }

          // Ambiguity becomes a candidate for a human, never a decision.
          if (receipt.outcome === 'skipped' && receipt.reasonCode === REASON.AMBIGUOUS) {
            candidateCount += await recordCandidates(receipt, run.id, actor);
          }
        }

        // Data-quality findings from this run's own evidence.
        issueCount = await recordIssues({ resolution, runId: run.id, actor });

        await runs.applyManaged(run.id, { candidateCount, issueCount }, { actor });
        return { run, candidateCount, issueCount };
      });

      events.emit?.('customer-data.import.applied', {
        runId: applied.run.id, system: resolution.system, counts: resolution.counts,
      });

      return Object.freeze({
        ...summarize(resolution, 'apply', applied.run.id),
        replayed: false,
        candidateCount: applied.candidateCount,
        issueCount: applied.issueCount,
      });
    },

    /**
     * The consolidated, read-only profile. Creates nothing.
     * @param {{resource?: string, id?: string}} request
     */
    async readCustomerProfile(request) {
      const resource = request?.resource;
      const id = request?.id;
      if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
        throw new ValidationError('a profile read needs a subject resource and id', { field: 'id' });
      }
      return profileFor({ modules, core, names, subject: { resource, id } });
    },
  };

  /** Create the Company/Contact this row names, through the core adapters. */
  async function createSubjectFor(row, actor) {
    if (!core || typeof core.createCompany !== 'function') {
      throw new AppError('customer-data cannot create records without the core adapters', {
        code: 'CUSTOMER_DATA_CORE_UNAVAILABLE', status: 500,
      });
    }
    if (row.email) {
      // A contact needs a company: reuse the named one when it exists, else
      // create it. Both go through the adapters, never through raw SQL.
      const companies = row.companyName ? core.findCompaniesByNormalizedName(row.companyName) : [];
      const company = companies.length === 1
        ? companies[0]
        : await core.createCompany({ name: row.companyName ?? deriveCompanyName(row), domain: row.domain ?? null }, { actor });
      const contact = await core.createContact({
        companyId: company.id,
        firstName: row.firstName ?? 'Unknown',
        lastName: row.lastName ?? 'Unknown',
        email: row.email,
      }, { actor });
      return { resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null, label: contact.email ?? row.email };
    }
    const company = await core.createCompany({ name: row.companyName, domain: row.domain ?? null }, { actor });
    return { resource: 'company', id: company.id, owner: 'host', ownerPackage: null, label: company.name ?? row.companyName };
  }

  function deriveCompanyName(row) {
    const domain = row.domain;
    return domain ? domain : `Unknown (${row.email})`;
  }

  async function recordExternalIdentity(row, subject, runId, actor) {
    const identities = trusted(modules, names.identity);
    const sourceKey = `${row.system}:${row.externalId}`;
    const existing = identities.listWhere({ sourceKey })[0];
    const now = new Date().toISOString();
    if (existing) {
      await identities.applyManaged(existing.id, { lastObservedRunId: runId, lastObservedAt: now }, { actor });
      return;
    }
    await identities.createManaged({
      sourceKey,
      system: row.system,
      externalId: row.externalId,
      ...subjectFields(subject),
      status: 'active',
      firstObservedRunId: runId,
      lastObservedRunId: runId,
      firstObservedAt: now,
      lastObservedAt: now,
    }, { actor });
  }

  async function recordCandidates(receipt, runId, actor) {
    const candidates = trusted(modules, names.candidate);
    let written = 0;
    const list = receipt.candidates ?? [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const { left, right } = orderedPair(list[i], list[j]);
        const sourceKey = `duplicate:${subjectKey(left)}|${subjectKey(right)}`;
        if (candidates.listWhere({ sourceKey })[0]) continue;
        await candidates.createManaged({
          sourceKey,
          ...subjectFields(left, 'left'),
          ...subjectFields(right, 'right'),
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          rule: receipt.rule,
          evidence: receipt.reason,
          status: 'unresolved',
          detectedByRunId: runId,
          detectedAt: new Date().toISOString(),
          decisionId: null,
          decidedReason: null,
          decidedByType: null,
          decidedById: null,
          decidedAt: null,
        }, { actor });
        written += 1;
      }
    }
    return written;
  }

  async function recordIssues({ resolution, runId, actor }) {
    const issues = trusted(modules, names.issue);
    const found = detectIssues({ resolution, modules, names });
    let written = 0;
    for (const issue of found) {
      const sourceKey = `issue:${issue.kind}:${issue.subject ? subjectKey(issue.subject) : `run:${runId}:${issue.index ?? 0}`}`;
      if (issues.listWhere({ sourceKey })[0]) continue;
      await issues.createManaged({
        sourceKey,
        kind: issue.kind,
        ...subjectFields(issue.subject ?? { resource: 'none', id: 'none', owner: 'host', ownerPackage: null, label: null }),
        evidence: issue.evidence,
        detector: issue.detector,
        detectorVersion: 1,
        detectedByRunId: runId,
        detectedAt: new Date().toISOString(),
        status: 'open',
        resolutionReason: null,
        decidedByType: null,
        decidedById: null,
        decidedAt: null,
      }, { actor });
      written += 1;
    }
    return written;
  }
}

/** Stated on every operation result, because a limit nobody reads is not a limit. */
export const LIMITATIONS = Object.freeze([
  'NO_FUZZY_MATCHING — every rule is exact; ambiguity is reported unresolved and never guessed',
  'NO_AUTOMATIC_MERGE — a duplicate candidate is never resolved without a human decision',
  'NO_PHYSICAL_MERGE — canonical identity is a logical link; no record is deleted, rewritten or cascaded',
  'NO_REMOTE_PROVIDER — v1 accepts bounded rows only: no credential, no fetch, no file path',
  'NO_RAW_PAYLOAD — provenance is stored, the source payload is not',
  'NO_RBAC — a human actor is an audit identity, not role enforcement; the Production Spine does not exist',
  'NO_LEGAL_ASSURANCE — nothing here is a GDPR, consent, retention or erasure claim',
  'NOT_A_COMPLETE_TIMELINE — the profile spans Accordo-managed records only, and says so per package',
]);

export { canonicalClusterFor };
