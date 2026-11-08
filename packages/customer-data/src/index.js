// @ts-check

import { AppError, definePackage, selectPackageGraph } from '../../core/index.js';
import { buildCustomerDataActions } from './actions.js';
import { BULK_ACTIONS, MAX_BULK_ITEMS } from './bulk.js';
import { createCustomerIdentityCapability } from './capability.js';
import { createCustomerProfileCapability } from './capability-profile.js';
import { createChannelOriginsCapability } from './capability-channel-origins.js';
import { createChannelSenderCapability } from './sender-capability.js';
import { EXPORT_MAX_ROWS } from './export.js';
import { IMPORT_MAPPING, MAX_ROWS, mappingFingerprint } from './import.js';
import {
  applyCustomerPhrase, customerPhraseAiAvailable, defineCustomField, listCustomFieldDefs,
  parseCustomerPhrase, readCustomFieldValues, setCustomFieldValue,
} from './custom-fields.js';
import { createContactEnrichment } from './enrichment.js';
import { EXTRACTION_SOURCE_KINDS, createEnrichmentExtraction } from './extraction.js';
import { createCustomerDataOperations, LIMITATIONS } from './operations.js';
import { MATCH_POLICY_KIND, MATCH_RULES, defineCustomerMatchPolicy } from './policy.js';
import { CHANNEL_SYSTEMS, createChannelSenderResolution } from './sender.js';
import { resolvedNames } from './store.js';

/**
 * **Customer Data Foundation v1 (ADR-037) — the trustworthy layer beneath a
 * customer view, and nothing more than that.**
 *
 * What it does: brings bounded external customer rows in, keeps their source
 * and provenance, finds *deterministic* duplicates or leaves them unresolved,
 * resolves one channel sender to its contact, fills contact gaps from free
 * enrichment sources without ever touching the contact record, lets a human
 * govern canonical identity, surfaces data-quality findings, applies one
 * human decision across many records with per-record receipts, exports a
 * managed record set completely or not at all, and reads one consolidated
 * profile across whatever packages are composed.
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
 * evidence, canonical decisions, quality findings, the bulk runs with
 * their per-item receipts, enriched contact fields with their provenance,
 * and enrichment opt-outs.
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
  'enriched-field',
  'enrichment-opt-out',
  'custom-field-def',
  'custom-field-value',
  'customer-erasure-log',
]);

/**
 * A per-call phrase adapter counts only when it carries a callable
 * `extractCustomer` (in-process fakes in tests). An HTTP JSON body can never
 * carry a function, so a caller object from the wire neither enables the AI
 * nor shadows the composed package phraseAdapter (backlog:434cc39a).
 */
function callablePhraseAdapter(candidate) {
  return typeof candidate?.extractCustomer === 'function' ? candidate : null;
}

/**
 * @param {{
 *   matchPolicy?: any,
 *   config?: Record<string, string>,
 *   phraseAdapter?: any,
 *   work?: { capabilities?: Array<any> },
 * }} [options]
 *   `work` is the composed work package definition — the same object the
 *   composition lists beside this package. The cleanup scan takes the
 *   created `follow-up@1` capability object from it, so every «Da fare»
 *   proposal is written with the provider's own validation and never with a
 *   second write path from this package. The edge is optional, like the
 *   channels send edge in appointments: a composition without work still
 *   scans and still records duplicate candidates, and the receipt names
 *   `tasksUnavailable` instead of writing tasks nobody could confirm. It
 *   stays out of `requires` on purpose (a composition without work must keep
 *   booting, reading and importing); what keeps a wrong handover fail-closed
 *   is the open-time check that the handed object settles on the provider
 *   capability contract pinned by the edge version, refusing otherwise with
 *   PACKAGE_DEPENDENCY_MISMATCH naming the edge.
 */
export function createCustomerDataPackage(options = {}) {
  const config = options.config;
  const names = resolvedNames(config);
  // «Da leggere» (backlog:9e003582): the interactions package's read-state
  // functions ({ actorMemberId, countUnreadForSubject }) the customer list
  // counts with — the same rule the scheda timeline flags with, so the two
  // badges can never disagree. A display column adds no requires edge, so
  // the functions arrive as a plain option instead of a capability; a
  // wrong shape refuses at composition, an absent one reads nulls.
  const readState = options.interactions ?? null;
  if (readState !== null
    && (typeof readState.actorMemberId !== 'function' || typeof readState.countUnreadForSubject !== 'function')) {
    throw new AppError(
      'The customer-data package was composed with an interactions edge that is not '
      + 'the read-state functions { actorMemberId, countUnreadForSubject }',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 500 },
    );
  }
  const offeredFollowUp = Array.isArray(options.work?.capabilities)
    ? options.work.capabilities.find((entry) => entry?.name === 'follow-up' && entry?.version === 1) ?? null
    : null;
  if (options.work !== undefined && offeredFollowUp === null) {
    throw new AppError(
      'The customer-data package was composed with a work edge that is not the work follow-up@1 capability',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 500 },
    );
  }
  // The caller-built «✦ Scrivi o incolla» adapter (the OpenAI wiring in the
  // pilot worker, the fake in tests): the framework never builds one, so it
  // never holds a key. A per-call `adapter` on parse/ai-available counts only
  // when callable (in-process fakes); the package-level one wins when
  // composed, and a JSON body from the wire never counts. The reference
  // composition passes none: without it the phrase preview refuses and the
  // admin hides the ✦ area.
  const phraseAdapter = options.phraseAdapter ?? null;
  // Build-time flag, like the module names above: the Google Contacts source
  // stays off unless the composition explicitly enables it, until the Google
  // verification approves the contacts.readonly scope.
  const googleContacts = config?.enrichmentGoogleContacts === 'enabled';
  const policy = options.matchPolicy ?? defineCustomerMatchPolicy();

  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: CUSTOMER_DATA_DOMAIN,
    // Version 2 (backlog:be9dd6c0c89f): agent-crm#668 added unmerge (undo a wrong
    // merge) to the declared surface. The pilot registers each surface's
    // fingerprint; a changed surface takes a new version, never the old one.
    version: 2,
    label: 'Customer Data Foundation',
    description:
      'Governed customer identity, import provenance and data quality: bounded imports with per-row receipts, external '
      + 'identifiers held beside the records they name, deterministic duplicate candidates, channel senders, '
      + 'free-source enrichment with opt-out, human-decided canonical identity, quality findings, bulk decisions, '
      + 'scale-safe export, one read-only profile.',
    resources: [...CUSTOMER_DATA_RESOURCES],

    // Nothing is required. The foundation reads the host through the core
    // adapters and every other package only if it happens to be composed —
    // which is why an absent package reads "not available" rather than empty.
    requires: [],

    capabilities: [
      createCustomerIdentityCapability(config),
      createCustomerProfileCapability(config),
      createChannelSenderCapability({ config, policy }),
      createChannelOriginsCapability(config),
    ],
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
        name: 'resolve-channel-sender',
        appMethod: 'resolveChannelSender',
        label: 'Resolve one channel sender to its contact',
        description:
          'Resolve one channel sender (a WhatsApp number, an Instagram, Facebook or TikTok id, an email address or a '
          + 'phone number) to its contact through the external-identity records and the deterministic customer match '
          + 'policy. An unknown sender carrying an email creates its contact; ambiguous evidence becomes an unresolved '
          + 'duplicate candidate for a human and is never merged.',
        input: [
          { name: 'channel', type: 'enum', values: [...CHANNEL_SYSTEMS], hint: 'Which channel the sender wrote from.' },
          { name: 'handle', type: 'string', hint: 'The sender handle on that channel: number, id or address.' },
          { name: 'email', type: 'string', hint: 'Sender email evidence, when the channel carries one.' },
          { name: 'firstName', type: 'string', hint: 'Sender given name, when known.' },
          { name: 'lastName', type: 'string', hint: 'Sender family name, when known.' },
          { name: 'companyName', type: 'string', hint: 'Sender company evidence, when the channel carries one.' },
          { name: 'domain', type: 'string', hint: 'Sender company domain evidence, when the channel carries one.' },
        ],
        create(runtime) {
          const senders = createChannelSenderResolution({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => senders.resolveChannelSender(request);
        },
      },
      // Manual link/unlink (backlog:826e377c) was split into a follow-up voce
      // by the owner: this PR keeps only the read of observed identities.
      // The follow-up re-adds the link-customer-identity and
      // unlink-customer-identity capabilities with the open findings
      // (card dedupe keyed by stored sourceKey, subject re-check inside the
      // committing transaction) as acceptance criteria.
      {
        operationContract: 1,
        name: 'record-subject-phone',
        appMethod: 'recordSubjectPhone',
        label: 'Record an operator-held phone number on a customer',
        description:
          'Hold one callable E.164 phone number beside a contact or company, so the scheda cliente can dial it. '
          + 'A human decision: the actor must be a user. The same number beside the same subject refreshes its '
          + 'sighting; beside another subject it refuses 409 PHONE_ALREADY_HELD.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind: "contact" or "company".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
          { name: 'phone', type: 'string', hint: 'The callable number in E.164, e.g. "+393331234567".' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.recordSubjectPhone(request);
        },
      },
      {
        operationContract: 1,
        name: 'propose-data-cleanup',
        appMethod: 'proposeDataCleanup',
        label: 'Propose data-cleanup corrections',
        description:
          'Scan the stored records for duplicates, missing or malformed channels and cards with no next step; '
          + 'propose merge, completion and next step as «Da fare» tasks plus duplicate-candidate rows. '
          + 'Proposals only: customer rows change solely through the governed writes after a human confirms.',
        input: [],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
            followUpProvider: offeredFollowUp,
          });
          return (request) => operations.proposeDataCleanup(request);
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
        name: 'erase-customer',
        appMethod: 'eraseCustomer',
        label: 'Erase one customer for good (GDPR)',
        description:
          'Erase one contact or company with an explicit titolare confirmation. Refuses with 409 when signed '
          + 'business must be kept; otherwise anonymizes what is writable, records the erasure log and excludes '
          + 'the subject from list, profile and export. A replay answers the stored row.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind: "contact" or "company".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
          { name: 'confirm', type: 'json', hint: 'The titolare confirmation: must be true, nothing is erased without it.' },
          { name: 'reason', type: 'string', hint: 'Why the customer is erased, recorded with the decider identity. Write why, never who: no emails or phone numbers, the registry keeps it forever.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.eraseCustomer(request);
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
      {
        operationContract: 1,
        name: 'read-customer-enrichment',
        appMethod: 'readCustomerEnrichment',
        label: 'Read the enriched fields of one customer',
        description:
          'Read the active free-source enriched fields of one customer across its linked identities, '
          + 'each with the source that filled it and its observation date, plus the opt-out state. '
          + 'Creates nothing. The contact record itself is never enriched in place, so these rows are '
          + 'the fallback the scheda cliente shows beside the record — every datum citing its source.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.readCustomerEnrichment(request);
        },
      },
      {
        operationContract: 1,
        name: 'extract-customer-enrichment',
        appMethod: 'extractCustomerEnrichment',
        label: 'Extract enrichment fields with AI over linked sources',
        description:
          'Ask the caller-built AI adapter to extract contact fields from one customer\'s linked sources '
          + '(signatures, channel messages, company website) and store each as a proposed row citing its '
          + 'source — never a fact until a human accepts it. Without an adapter it refuses with '
          + 'ENRICHMENT_AI_UNAVAILABLE. The contact record is never written.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
          { name: 'sources', type: 'json', hint: 'One to ten linked sources, each with kind, text and an opaque detail.' },
          { name: 'adapter', type: 'json', hint: 'The caller-built extraction adapter answering extractFields (the fake in tests, the OpenAI wiring in the pilot worker). Absent means no AI is active.' },
        ],
        create(runtime) {
          const extraction = createEnrichmentExtraction({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            names,
          });
          return (request) => extraction.extractCustomerEnrichment(request);
        },
      },
      {
        operationContract: 1,
        name: 'read-customer-enrichment-proposals',
        appMethod: 'readCustomerEnrichmentProposals',
        label: 'Read the pending enrichment proposals of one customer',
        description:
          'Read the proposed (not yet decided) enriched fields of one customer, each with the source that '
          + 'produced it — what the scheda shows beside the facts to accept or dismiss. Creates nothing. '
          + 'Facts keep reading through read-customer-enrichment, never from here.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          const extraction = createEnrichmentExtraction({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            names,
          });
          return (request) => extraction.readCustomerEnrichmentProposals(request);
        },
      },
      {
        operationContract: 1,
        name: 'decide-enrichment-proposal',
        appMethod: 'decideEnrichmentProposal',
        label: 'Accept or dismiss one enrichment proposal',
        description:
          'Record a human decision on one proposed field: accepted flips it to an active fact, dismissed '
          + 'records the refusal with its reason. Deciding twice answers the stored decision. The contact '
          + 'record itself is never written.',
        input: [
          { name: 'id', type: 'string', hint: 'The proposed enriched-field row id.' },
          { name: 'decision', type: 'enum', values: ['accepted', 'dismissed'], hint: 'Whether the field becomes a fact or a recorded refusal.' },
          { name: 'reason', type: 'string', hint: 'Why it was dismissed (or accepted with a note), recorded beside the row.' },
        ],
        create(runtime) {
          const extraction = createEnrichmentExtraction({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            names,
          });
          return (request) => extraction.decideEnrichmentProposal(request);
        },
      },
      {
        operationContract: 1,
        name: 'list-customer-records',
        appMethod: 'listCustomers',
        label: 'List customers with filters, sorting and server pagination',
        description:
          'One server page over the host contact and company records, enriched with channels, status, latest contact, '
          + 'next step, offer value and AI-extracted budget. Views are saved query descriptors re-read on every open. '
          + 'Creates nothing. A package that is not composed reads "not available" with a reason rather than empty.',
        input: [
          { name: 'q', type: 'string', hint: 'Free-text search over name, email, company and phone. Channel words act as a channel filter.' },
          { name: 'canale', type: 'string', hint: 'Channel system, e.g. "whatsapp", or "all".' },
          { name: 'stato', type: 'string', hint: '"cliente", "contatto" or "all".' },
          { name: 'sort', type: 'string', hint: 'One of recent, name, value, status.' },
          { name: 'vista', type: 'string', hint: 'One of tutti, ricontattare-oggi, nuovi-lead, clienti-attivi, rinnovi-30-giorni, da-leggere.' },
          { name: 'page', type: 'integer', hint: '1-based page. Absent means 1.' },
          { name: 'pageSize', type: 'integer', hint: '10, 25 or 50. Absent means 10.' },
          { name: 'spaceId', type: 'string', hint: 'Space for the AI budget signals. Absent means the budget column reads unavailable.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
            interactions: readState,
          });
          return (request) => operations.listCustomerRecords(request);
        },
      },
      {
        operationContract: 1,
        name: 'count-customer-channel-origins',
        appMethod: 'countCustomerChannelOrigins',
        label: 'Count new customers per origin channel and week',
        description:
          'Count new customers per origin channel and ISO week from the active external-identity rows: '
          + 'which outside system first named a record, and in which week. Creates nothing. '
          + 'The reporting dashboard reads this for its "Nuovi clienti per canale" card.',
        input: [],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => operations.countCustomerChannelOrigins(request);
        },
      },
      {
        operationContract: 1,
        name: 'apply-contact-enrichment',
        appMethod: 'applyContactEnrichment',
        label: 'Enrich one contact from a free source',
        description:
          'Store free-source contact fields (Google Contacts, email signature) beside one contact with their source '
          + 'and date. The contact record itself is never written, so manual data always wins; conflicting evidence '
          + 'becomes an unresolved duplicate candidate; an opted-out contact refuses.',
        input: [
          { name: 'email', type: 'string', hint: 'The contact email that names the enrichment subject.' },
          { name: 'fields', type: 'json', hint: 'First name, last name, role, company name and phone to store.' },
          { name: 'source', type: 'enum', values: ['google-contacts', 'email-signature'], hint: 'Which free source the fields come from.' },
          { name: 'sourceDetail', type: 'string', hint: 'Opaque source reference, e.g. the Google resource name or message id.' },
        ],
        create(runtime) {
          const enrichment = createContactEnrichment({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names, googleContacts,
          });
          return (request) => enrichment.applyContactEnrichment(request);
        },
      },
      {
        operationContract: 1,
        name: 'import-google-contacts',
        appMethod: 'importGoogleContacts',
        label: 'Import Google Contacts of the space',
        description:
          'Page through the space Google Contacts (People API through the caller-built adapter, the fake in tests) '
          + 'and enrich at most one contact per person. Behind the enrichmentGoogleContacts flag until the Google '
          + 'verification approves the contacts.readonly scope. Opted-out subjects are skipped with no writes.',
        input: [
          { name: 'adapter', type: 'json', hint: 'The source adapter answering listConnections (the fake in tests).' },
          { name: 'pageSize', type: 'integer', hint: 'People per page, 1-500. Absent means 100.' },
        ],
        create(runtime) {
          const enrichment = createContactEnrichment({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names, googleContacts,
          });
          return (request) => enrichment.importGoogleContacts(request);
        },
      },
      {
        operationContract: 1,
        name: 'opt-out-contact-enrichment',
        appMethod: 'optOutContactEnrichment',
        label: 'Opt one contact out of enrichment',
        description:
          'Record one contact refusal of enrichment and purge its active enriched fields. Channel identities stay: '
          + 'they route messages, they are not enrichment.',
        input: [
          { name: 'email', type: 'string', hint: 'The contact email opting out.' },
          { name: 'reason', type: 'string', hint: 'Why the contact opted out, recorded with the refusal.' },
        ],
        create(runtime) {
          const enrichment = createContactEnrichment({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names, googleContacts,
          });
          return (request) => enrichment.optOutContactEnrichment(request);
        },
      },
      {
        operationContract: 1,
        name: 'define-custom-field',
        appMethod: 'defineCustomField',
        label: 'Add one space-wide custom field',
        description:
          'Define one operator-decided customer property («+ Aggiungi campo»: label, one of testo/numero/data/si-no/scelta). '
          + 'Space-wide: the field reads on every scheda, in the list filters and in the list columns. '
          + 'Idempotent on the identical definition; a divergent definition behind the same key refuses 409. '
          + 'A human decision: the actor must be a user.',
        input: [
          { name: 'label', type: 'string', hint: 'The label the operator reads, e.g. "Amico".' },
          { name: 'key', type: 'string', hint: 'Optional slug; derived from the label when absent.' },
          { name: 'type', type: 'string', hint: 'One of testo, numero, data, si-no, scelta.' },
          { name: 'options', type: 'json', hint: 'JSON array of options, scelta only.' },
        ],
        create(runtime) {
          return (request) => defineCustomField({ modules: runtime.modules, names }, request);
        },
      },
      {
        operationContract: 1,
        name: 'list-custom-fields',
        appMethod: 'listCustomFields',
        label: 'List the space custom fields',
        description:
          'Every defined field of the space with its label, type and options. Writes nothing.',
        input: [],
        create(runtime) {
          return (request) => listCustomFieldDefs({ modules: runtime.modules, names }, request);
        },
      },
      {
        operationContract: 1,
        name: 'set-custom-field-value',
        appMethod: 'setCustomFieldValue',
        label: 'Set one customer custom-field value',
        description:
          'Set one customer value for one defined field. The definition owns the type: an unknown key refuses, '
          + 'a bad value refuses naming the field. An edit rewrites the single row, so a reload reads the edit. '
          + 'A human decision: the actor must be a user.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind: "contact" or "company".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
          { name: 'key', type: 'string', hint: 'The field key.' },
          { name: 'value', type: 'json', hint: 'The value, in the field type canonical form.' },
        ],
        create(runtime) {
          return (request) => setCustomFieldValue({ modules: runtime.modules, names }, request);
        },
      },
      {
        operationContract: 1,
        name: 'read-custom-field-values',
        appMethod: 'readCustomFieldValues',
        label: 'Read one customer custom-field values',
        description:
          'Every defined field of the space with this customer value (null when never set). Writes nothing.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind: "contact" or "company".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          return (request) => readCustomFieldValues({ modules: runtime.modules, names }, request);
        },
      },
      {
        operationContract: 1,
        name: 'parse-customer-phrase',
        appMethod: 'parseCustomerPhrase',
        label: 'Preview one customer sentence',
        description:
          '«✦ Scrivi o incolla»: one Italian sentence into a customer draft plus custom-field proposals, naming '
          + 'every field it would create. Writes nothing: only the human apply stores. Without a caller-built '
          + 'adapter (per call, or the package phraseAdapter) it refuses CUSTOMER_PHRASE_AI_UNAVAILABLE. '
          + 'A human decision: the actor must be a user.',
        input: [
          { name: 'phrase', type: 'string', hint: 'The sentence, e.g. "daniele pelleri email daniele@gmail.com tel 234341 amico sì".' },
          { name: 'adapter', type: 'json', hint: 'Optional caller-built extractCustomer adapter for in-process calls (tests): only a callable counts, the composed package adapter wins.' },
        ],
        create(runtime) {
          return (request) => parseCustomerPhrase(
            { modules: runtime.modules, names, phraseLlm: phraseAdapter ?? callablePhraseAdapter(request?.adapter) }, request,
          );
        },
      },
      {
        operationContract: 1,
        name: 'apply-customer-phrase',
        appMethod: 'applyCustomerPhrase',
        label: 'Apply one confirmed customer phrase',
        description:
          'Store the human-confirmed phrase: create (or match) the customer through the governed import-apply, '
          + 'hold its phone beside it, define the new fields and set every value. Idempotent per field: retrying '
          + 'replays. The note is never written here: the caller posts it to the subject-note endpoint, so the '
          + 'cronologia keeps its single writer. A human decision: the actor must be a user.',
        input: [
          { name: 'customer', type: 'json', hint: 'The confirmed base customer: firstName, lastName, email, companyName, phone.' },
          { name: 'fields', type: 'json', hint: 'The confirmed field entries: key, label, type, options, value.' },
        ],
        create(runtime) {
          const operations = createCustomerDataOperations({
            database: runtime.database, modules: runtime.modules, events: runtime.events,
            config: runtime.config, core: runtime.core, policy, names,
          });
          return (request) => applyCustomerPhrase(
            {
              database: runtime.database, modules: runtime.modules, names,
              importOperations: operations,
            }, request,
          );
        },
      },
      {
        operationContract: 1,
        name: 'customer-phrase-ai-available',
        appMethod: 'customerPhraseAiAvailable',
        label: 'Whether the phrase AI is on',
        description:
          'The probe the admin uses to show the ✦ area only when the AI is on. Writes nothing.',
        input: [
          { name: 'adapter', type: 'json', hint: 'Optional caller-built adapter to probe in-process (tests): only a callable counts.' },
        ],
        create() {
          return (request) => customerPhraseAiAvailable({ phraseLlm: phraseAdapter ?? callablePhraseAdapter(request?.adapter) });
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
        sender: {
          channels: [...CHANNEL_SYSTEMS],
          outcomes: ['matched', 'created', 'unresolved'],
          identity: 'every resolved handle is recorded as an external-identity against its contact; a second sighting refreshes it',
          creation: 'an unknown sender carrying an email creates its contact through the core adapters, like an accepted import row',
          ambiguity: 'conflicting or multi-record evidence becomes an unresolved duplicate candidate; nothing is ever merged automatically',
          noEmailNoContact: 'a sender that matches nothing and carries no email creates no contact and is reported unresolved',
        },
        enrichment: {
          sources: ['google-contacts', 'email-signature'],
          fields: ['firstName', 'lastName', 'role', 'companyName', 'phone'],
          storage: 'one enriched-field row per subject, field and source beside the contact record, each with its source and observation date',
          manualWins: 'the contact record is never written by enrichment: a manually entered value always wins by construction',
          googleFlag: 'the Google Contacts source stays behind the enrichmentGoogleContacts flag until the Google verification approves the contacts.readonly scope',
          paidServices: 'none: Google Contacts (free People API) and locally parsed email signatures only',
          ambiguity: 'evidence naming two different contacts becomes an unresolved duplicate candidate; nothing is ever merged automatically',
          optOut: 'an opted-out subject is never enriched again and its active enriched fields are purged; channel identities stay',
          aiExtraction: {
            sources: [...EXTRACTION_SOURCE_KINDS],
            adapter: 'caller-built, passed per call (the OpenAI wiring in the pilot worker, the fake in tests): the framework never holds a key',
            noAi: 'without an adapter the extraction refuses with ENRICHMENT_AI_UNAVAILABLE instead of running anything',
            proposals: 'one proposed enriched-field row per extracted field, each citing the linked source read — never a fact until a human decides',
            decisions: 'accepted flips the row to active, dismissed records the refusal with its reason; deciding twice answers the stored decision and a dismissal is never resurrected by a re-run',
            providerSilence: 'an adapter failure becomes ENRICHMENT_EXTRACTION_FAILED with a fixed message: provider text never leaves the package',
          },
        },
        customFields: {
          types: ['testo', 'numero', 'data', 'si-no', 'scelta'],
          spaceWide: 'one definition serves every scheda, every list filter and every list column',
          unknownRefuses: 'a value without a definition refuses CUSTOM_FIELD_UNKNOWN: the framework never invents a field from a value',
          edit: 'setting the same field again rewrites the single row: a reload reads the edit, the list never doubles the customer',
          aiPhrase: {
            adapter: 'caller-built, passed per call or as the package phraseAdapter (the OpenAI wiring in the pilot worker, the fake in tests): the framework never holds a key',
            noAi: 'without an adapter the preview refuses with CUSTOMER_PHRASE_AI_UNAVAILABLE and the admin hides the ✦ area',
            previewWritesNothing: 'the preview names every field it would create; only the human apply stores',
            noteSingleWriter: 'the apply never writes the note: the caller posts it to the subject-note endpoint, so the cronologia keeps its single writer',
            providerSilence: 'an adapter failure becomes CUSTOMER_PHRASE_AI_UNUSABLE with a fixed message: provider text never leaves the package',
          },
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
          erased: 'rows naming an erased subject are excluded and counted as erasedExcluded, never silently dropped',
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
        erasure: {
          operation: 'erase-customer',
          registry: 'customer-erasure-log',
          confirmation: 'an explicit titolare confirmation (confirm: true) plus a recorded reason, by a user actor',
          legalBasis: 'signed business (orders, contracts, subscriptions) is kept: a cliente refuses with ERASURE_BLOCKED_SIGNED_BUSINESS, everything else goes',
          replay: 'a second erasure of the same subject answers the stored row, never a second write',
          exclusion: 'erased subjects leave the customer list, the search, the profile and the export through the same registry',
          physicalPurge: 'interaction messages and calls, appointments and the company record are excluded from reads but not rewritten here: their owning packages do that',
        },
        deferred: {
          track: 'Customer Data Operations v2',
          items: ['global search', 'saved views', 'physical merge or consolidation',
            'physical purge of messages, calls and appointments for erased subjects'],
        },
        limitations: [...LIMITATIONS],
        notModeled: ['CDP activation', 'warehouse or lakehouse', 'real-time streaming', 'probabilistic identity resolution',
          'machine-learning entity resolution', 'arbitrary ETL', 'global full-text search', 'consent orchestration',
          'GDPR or legal assurance', 'cross-channel timeline'],
      };
    },
  }), options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createCustomerDataPackage()` callers keep v1. */
export function createCustomerDataPackageV2(options = {}) {
  return createCustomerDataPackage({ ...options, packageContract: 2 });
}

export { defineCustomerMatchPolicy, MATCH_POLICY_KIND, MATCH_RULES, LIMITATIONS };
export { createCustomerProfileCapability };
