// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { buildCustomerDataActions } from './actions.js';
import { BULK_ACTIONS, MAX_BULK_ITEMS } from './bulk.js';
import { createCustomerIdentityCapability } from './capability.js';
import { EXPORT_MAX_ROWS } from './export.js';
import { IMPORT_MAPPING, MAX_ROWS, mappingFingerprint } from './import.js';
import { createCustomerDataOperations, LIMITATIONS } from './operations.js';
import { MATCH_POLICY_KIND, MATCH_RULES, defineCustomerMatchPolicy } from './policy.js';
import { resolvedNames } from './store.js';

/**
 * **Customer Data Foundation v1 (ADR-037) — the trustworthy layer beneath a
 * customer view, and nothing more than that.**
 *
 * What it does: brings bounded external customer rows in, keeps their source
 * and provenance, finds *deterministic* duplicates or leaves them unresolved,
 * lets a human govern canonical identity, surfaces data-quality findings,
 * applies one human decision across many records with per-record receipts,
 * exports a managed record set completely or not at all, and reads one
 * consolidated profile across whatever packages are composed.
 *
 * What it deliberately is **not**: a CDP, a warehouse, real-time activation, a
 * probabilistic identity graph, ML entity resolution, arbitrary ETL, global
 * search, a consent platform or any legal-assurance claim. Those words do not
 * describe this package and are not used about it anywhere.
 *
 * **The governing architectural choice (ADR-037):** existing business records
 * stay the source records. There is no master customer table here. Company and
 * Contact remain the host application's, every other record stays with the
 * package that owns it, and this package adds four things beside them —
 * identity, provenance, lineage and projection — using the ADR-030 subject
 * envelope to point at records rather than copying or foreign-keying them.
 *
 * **Canonical identity is a logical link.** Linking two records records a
 * decision; it deletes nothing, rewrites nothing, and cascades nowhere.
 */

export const CUSTOMER_DATA_DOMAIN = 'customer-data';

/**
 * The records this package owns. None of them duplicates a business record:
 * they are an import log, its receipts, external identifiers, duplicate
 * evidence, canonical decisions, quality findings, and the bulk runs with
 * their per-item receipts.
 */
export const CUSTOMER_DATA_RESOURCES = Object.freeze([
  'customer-import-run',
  'customer-import-row',
  'external-identity',
  'duplicate-candidate',
  'canonical-link',
  'data-quality-issue',
  'customer-bulk-run',
  'customer-bulk-item',
]);

/**
 * @param {{
 *   matchPolicy?: any,
 *   config?: Record<string, string>,
 * }} [options]
 */
export function createCustomerDataPackage(options = {}) {
  const config = options.config;
  const names = resolvedNames(config);
  const policy = options.matchPolicy ?? defineCustomerMatchPolicy();

  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: CUSTOMER_DATA_DOMAIN,
    version: 1,
    label: 'Customer Data Foundation',
    description:
      'Governed customer identity, import provenance and data quality: bounded imports with per-row receipts, external '
      + 'identifiers held beside the records they name, deterministic duplicate candidates, human-decided canonical identity '
      + 'as a logical link, explainable data-quality findings, bulk decisions with per-record receipts, scale-safe '
      + 'export, and one read-only consolidated profile.',
    resources: [...CUSTOMER_DATA_RESOURCES],

    // Nothing is required. The foundation reads the host through the core
    // adapters and every other package only if it happens to be composed —
    // which is why an absent package reads "not available" rather than empty.
    requires: [],

    capabilities: [createCustomerIdentityCapability(config)],
    actions: buildCustomerDataActions(config),

    // The match policy is a declared, fingerprinted definition (ADR-015), so a
    // changed rule is a changed fingerprint on every receipt it produced.
    policies: [{ kind: MATCH_POLICY_KIND, definition: policy }],

    /**
     * Application operations (ADR-032). Import is application-scoped because a
     * batch may create the very records it targets, and the profile is
     * application-scoped because it spans packages rather than a record.
     */
    operations: [
      {
        operationContract: 1,
        name: 'preview-customer-import',
        appMethod: 'previewCustomerImport',
        label: 'Preview a customer import',
        description: 'Resolve a bounded batch of customer rows and return the receipts it would write. Writes nothing at all.',
        input: [
          { name: 'system', type: 'string', hint: 'The source system identifier, e.g. "billing-export".' },
          { name: 'rows', type: 'json', hint: `Up to ${MAX_ROWS} bounded rows.` },
          { name: 'acceptance', type: 'enum', values: ['partial', 'all_or_nothing'], hint: 'Whether a rejected row stops the whole import.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.previewCustomerImport(request);
        },
      },
      {
        operationContract: 1,
        name: 'apply-customer-import',
        appMethod: 'applyCustomerImport',
        label: 'Apply a customer import',
        description:
          'Apply a bounded batch of customer rows in one transaction, recomputing the resolution authoritatively. '
          + 'The idempotency key is derived from the payload, so the same import retried returns the same run.',
        input: [
          { name: 'system', type: 'string', hint: 'The source system identifier.' },
          { name: 'rows', type: 'json', hint: `Up to ${MAX_ROWS} bounded rows.` },
          { name: 'acceptance', type: 'enum', values: ['partial', 'all_or_nothing'], hint: 'Whether a rejected row stops the whole import.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.applyCustomerImport(request);
        },
      },
      {
        operationContract: 1,
        name: 'apply-bulk-customer-action',
        appMethod: 'applyBulkCustomerAction',
        label: 'Apply one decision across many records',
        description:
          'Apply one of this package\'s human decisions across many records with one receipt per record. '
          + 'Each record runs in its own transaction so one refusal stops nothing else; a run that did not apply '
          + 'every record reads partial, never completed. The idempotency key is derived from the payload, so '
          + 'retrying the same bulk resumes or replays the same run and never silently reapplies.',
        input: [
          { name: 'action', type: 'enum', values: [...BULK_ACTIONS], hint: 'Which declared decision to apply to every record.' },
          { name: 'items', type: 'json', hint: `Up to ${MAX_BULK_ITEMS} items, each with a recordId and the action input.` },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.applyBulkCustomerAction(request);
        },
      },
      {
        operationContract: 1,
        name: 'export-customer-records',
        appMethod: 'exportCustomerRecords',
        label: 'Export one managed record set',
        description:
          'Export one of this package\'s managed record sets, completely or not at all. The set is counted '
          + 'first with a complete read; the answer states the row count and the bound, and a set larger than '
          + `the bound refuses with EXPORT_WOULD_TRUNCATE instead of returning a short file. At most ${EXPORT_MAX_ROWS} rows.`,
        input: [
          { name: 'resource', type: 'string', hint: 'Which managed record set to export, e.g. "data-quality-issue".' },
          { name: 'where', type: 'json', hint: 'Exact-match filters. Absent means the whole set.' },
          { name: 'bound', type: 'integer', hint: `At most ${EXPORT_MAX_ROWS} rows; absent means the maximum. A smaller bound may be asked, never a larger one.` },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.exportCustomerRecords(request);
        },
      },
      {
        operationContract: 1,
        name: 'read-customer-profile',
        appMethod: 'readCustomerProfile',
        label: 'Read a consolidated customer profile',
        description:
          'Read one customer across the packages this application composes. Creates nothing. A package that is not '
          + 'composed reads "not available" rather than empty, and this is not a complete cross-channel timeline.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.readCustomerProfile(request);
        },
      },
    ],

    /**
     * The machine-readable contract, function-free. Admin renders from this and
     * the limits are part of it rather than prose somebody may not read.
     */
    metadata() {
      return {
        customerDataContract: 1,
        records: [...CUSTOMER_DATA_RESOURCES],
        import: {
          mapping: { name: IMPORT_MAPPING.name, version: IMPORT_MAPPING.version, fingerprint: mappingFingerprint() },
          fields: IMPORT_MAPPING.fields.map((field) => ({ input: field.input, meaning: field.meaning })),
          maxRows: MAX_ROWS,
          acceptance: ['partial', 'all_or_nothing'],
          preview: 'a preview writes nothing at all — not a business record, not an import run',
          idempotency: 'derived from the system, the mapping fingerprint and the sorted row digests; never a clock or a random value',
          reconciliation: 'accepted + rejected + skipped always equals the row count, and every rejected row has a receipt',
        },
        matching: {
          policy: { name: policy.name, version: policy.version, fingerprint: policy.fingerprint },
          rules: [...MATCH_RULES],
          deterministic: true,
          note: 'Exact rules only. Ambiguity is reported unresolved with candidates; no rule breaks a tie.',
        },
        canonicalIdentity: {
          semantics: 'logical canonical merge — a link, never a deletion',
          humanOnly: true,
          guarantee: 'every linked record still exists, still resolves, and is never rewritten or cascaded',
          physicalMerge: 'not implemented, and deliberately deferred to Customer Data Operations v2',
        },
        bulk: {
          actions: [...BULK_ACTIONS],
          maxItems: MAX_BULK_ITEMS,
          perRecord: 'every item gets a receipt naming applied, already-applied or failed with its code',
          transactions: 'one transaction per item: one refusal stops nothing else and rolls nothing else back',
          partial: 'a run that did not apply every item reads partial, never completed; a partial run is a result, not an error',
          idempotency: 'derived from the action and the sorted item digests; never a clock or a random value',
          resume: 'retrying the same bulk continues the items with no applied receipt; applied items report already-applied from the stored receipt',
          replay: 'retrying a finished bulk returns the stored run with replayed: true and runs nothing twice',
          humanOnly: 'every bulked decision keeps its human-only check: a non-user actor gets one HUMAN_APPROVAL_REQUIRED receipt per item',
        },
        export: {
          resources: [...CUSTOMER_DATA_RESOURCES],
          maxRows: EXPORT_MAX_ROWS,
          countFirst: 'the set is counted with a complete read before anything is returned',
          bound: 'stated on every answer; a smaller bound may be asked, never a larger one',
          truncation: 'a set larger than the bound refuses with EXPORT_WOULD_TRUNCATE instead of returning a short file',
          reconciliation: 'the rows returned always equal the count stated, or nothing is returned',
          writes: 'an export writes nothing at all — not a run, not a receipt',
        },
        dataQuality: {
          kinds: ['missing_required_identity', 'conflicting_external_identity', 'identity_conflict_windowed_scope',
            'invalid_email', 'invalid_domain',
            'duplicate_candidate_open', 'orphaned_reference', 'unresolved_import_row'],
          governance: 'resolving or dismissing an issue records a human decision and erases nothing',
        },
        profile: {
          readOnly: true,
          completeTimeline: false,
          absence: 'a package that is not composed — or one whose record declares no reference this projection can follow — '
            + 'reads "not available" with the reason, never as an empty result',
          counts: 'every readable section states countIsComplete: a count taken from a bounded display page is reported as a floor, not as a total',
        },
        deferred: {
          track: 'Customer Data Operations v2',
          items: ['global search', 'saved views', 'physical merge or consolidation',
            'retention and erasure workflow'],
        },
        limitations: [...LIMITATIONS],
        notModeled: ['CDP activation', 'warehouse or lakehouse', 'real-time streaming', 'probabilistic identity resolution',
          'machine-learning entity resolution', 'arbitrary ETL', 'global full-text search', 'consent orchestration',
          'GDPR or legal assurance', 'retention and erasure', 'cross-channel timeline'],
      };
    },
  }), options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createCustomerDataPackage()` callers keep v1. */
export function createCustomerDataPackageV2(options = {}) {
  return createCustomerDataPackage({ ...options, packageContract: 2 });
}

export { defineCustomerMatchPolicy, MATCH_POLICY_KIND, MATCH_RULES, LIMITATIONS };
