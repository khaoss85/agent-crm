// @ts-check
// Registry of manifest-generated modules. Managed by `accordo module:create --apply`,
// which regenerates this file from the module.manifest.json each generated module carries.
// You can edit it by hand, but the next apply rewrites it from the manifests on disk.

import { createCanonicalLinkModule } from '../canonical-link/src/index.js';
import * as canonicalLinkMigrationSource from '../canonical-link/src/migration.js';
import { createChannelConnectionModule } from '../channel-connection/src/index.js';
import * as channelConnectionMigrationSource from '../channel-connection/src/migration.js';
import { createChannelDeadLetterModule } from '../channel-dead-letter/src/index.js';
import * as channelDeadLetterMigrationSource from '../channel-dead-letter/src/migration.js';
import { createChannelImportOutcomeModule } from '../channel-import-outcome/src/index.js';
import * as channelImportOutcomeMigrationSource from '../channel-import-outcome/src/migration.js';
import { createChannelImportStateModule } from '../channel-import-state/src/index.js';
import * as channelImportStateMigrationSource from '../channel-import-state/src/migration.js';
import { createChannelInboxEventModule } from '../channel-inbox-event/src/index.js';
import * as channelInboxEventMigrationSource from '../channel-inbox-event/src/migration.js';
import { createCustomerBulkItemModule } from '../customer-bulk-item/src/index.js';
import * as customerBulkItemMigrationSource from '../customer-bulk-item/src/migration.js';
import { createCustomerBulkRunModule } from '../customer-bulk-run/src/index.js';
import * as customerBulkRunMigrationSource from '../customer-bulk-run/src/migration.js';
import { createCustomerImportRowModule } from '../customer-import-row/src/index.js';
import * as customerImportRowMigrationSource from '../customer-import-row/src/migration.js';
import { createCustomerImportRunModule } from '../customer-import-run/src/index.js';
import * as customerImportRunMigrationSource from '../customer-import-run/src/migration.js';
import { createDataQualityIssueModule } from '../data-quality-issue/src/index.js';
import * as dataQualityIssueMigrationSource from '../data-quality-issue/src/migration.js';
import { createDuplicateCandidateModule } from '../duplicate-candidate/src/index.js';
import * as duplicateCandidateMigrationSource from '../duplicate-candidate/src/migration.js';
import { createEnrichedFieldModule } from '../enriched-field/src/index.js';
import * as enrichedFieldMigrationSource from '../enriched-field/src/migration.js';
import { createEnrichmentOptOutModule } from '../enrichment-opt-out/src/index.js';
import * as enrichmentOptOutMigrationSource from '../enrichment-opt-out/src/migration.js';
import { createExternalIdentityModule } from '../external-identity/src/index.js';
import * as externalIdentityMigrationSource from '../external-identity/src/migration.js';
import { createSequenceModule } from '../sequence/src/index.js';
import * as sequenceMigrationSource from '../sequence/src/migration.js';
import { createSequenceEnrollmentModule } from '../sequence-enrollment/src/index.js';
import * as sequenceEnrollmentMigrationSource from '../sequence-enrollment/src/migration.js';
import { createSequenceSendModule } from '../sequence-send/src/index.js';
import * as sequenceSendMigrationSource from '../sequence-send/src/migration.js';
import { createSequenceStepModule } from '../sequence-step/src/index.js';
import * as sequenceStepMigrationSource from '../sequence-step/src/migration.js';
import { createSpaceAiProposalModule } from '../space-ai-proposal/src/index.js';
import * as spaceAiProposalMigrationSource from '../space-ai-proposal/src/migration.js';
import { createSpacePackageModule } from '../space-package/src/index.js';
import * as spacePackageMigrationSource from '../space-package/src/migration.js';
import { createSpacePermissionOverrideModule } from '../space-permission-override/src/index.js';
import * as spacePermissionOverrideMigrationSource from '../space-permission-override/src/migration.js';
import { createWorkActivityModule } from '../work-activity/src/index.js';
import * as workActivityMigrationSource from '../work-activity/src/migration.js';
import { createWorkTaskModule } from '../work-task/src/index.js';
import * as workTaskMigrationSource from '../work-task/src/migration.js';

/**
 * A module's migrations, in the order they must run. A module generated under
 * ADR-019 exports the append-only `<camel>Migrations` array; one generated
 * before it exports a single `<camel>Migration`. Both are read, so upgrading
 * the framework never requires regenerating modules that did not change.
 *
 * @param {Record<string, any>} source @param {string} camel @param {string} moduleName
 */
function migrationsOf(source, camel, moduleName) {
  const list = source[camel + 'Migrations'];
  if (Array.isArray(list)) return list;
  const single = source[camel + 'Migration'];
  if (single) return [single];
  throw new Error(
    'Generated module "' + moduleName + '" exports no migration from src/migration.js; '
      + 'regenerate it from its module.manifest.json',
  );
}

/** @type {Array<{name: string, createModule: (deps: {database: any, audit: any, events: any}) => any, migrations: Array<{name: string, sql: string}>}>} */
export const generatedModules = [
  { name: 'canonical-link', createModule: createCanonicalLinkModule, migrations: migrationsOf(canonicalLinkMigrationSource, 'canonicalLink', 'canonical-link') },
  { name: 'channel-connection', createModule: createChannelConnectionModule, migrations: migrationsOf(channelConnectionMigrationSource, 'channelConnection', 'channel-connection') },
  { name: 'channel-dead-letter', createModule: createChannelDeadLetterModule, migrations: migrationsOf(channelDeadLetterMigrationSource, 'channelDeadLetter', 'channel-dead-letter') },
  { name: 'channel-import-outcome', createModule: createChannelImportOutcomeModule, migrations: migrationsOf(channelImportOutcomeMigrationSource, 'channelImportOutcome', 'channel-import-outcome') },
  { name: 'channel-import-state', createModule: createChannelImportStateModule, migrations: migrationsOf(channelImportStateMigrationSource, 'channelImportState', 'channel-import-state') },
  { name: 'channel-inbox-event', createModule: createChannelInboxEventModule, migrations: migrationsOf(channelInboxEventMigrationSource, 'channelInboxEvent', 'channel-inbox-event') },
  { name: 'customer-bulk-item', createModule: createCustomerBulkItemModule, migrations: migrationsOf(customerBulkItemMigrationSource, 'customerBulkItem', 'customer-bulk-item') },
  { name: 'customer-bulk-run', createModule: createCustomerBulkRunModule, migrations: migrationsOf(customerBulkRunMigrationSource, 'customerBulkRun', 'customer-bulk-run') },
  { name: 'customer-import-row', createModule: createCustomerImportRowModule, migrations: migrationsOf(customerImportRowMigrationSource, 'customerImportRow', 'customer-import-row') },
  { name: 'customer-import-run', createModule: createCustomerImportRunModule, migrations: migrationsOf(customerImportRunMigrationSource, 'customerImportRun', 'customer-import-run') },
  { name: 'data-quality-issue', createModule: createDataQualityIssueModule, migrations: migrationsOf(dataQualityIssueMigrationSource, 'dataQualityIssue', 'data-quality-issue') },
  { name: 'duplicate-candidate', createModule: createDuplicateCandidateModule, migrations: migrationsOf(duplicateCandidateMigrationSource, 'duplicateCandidate', 'duplicate-candidate') },
  { name: 'enriched-field', createModule: createEnrichedFieldModule, migrations: migrationsOf(enrichedFieldMigrationSource, 'enrichedField', 'enriched-field') },
  { name: 'enrichment-opt-out', createModule: createEnrichmentOptOutModule, migrations: migrationsOf(enrichmentOptOutMigrationSource, 'enrichmentOptOut', 'enrichment-opt-out') },
  { name: 'external-identity', createModule: createExternalIdentityModule, migrations: migrationsOf(externalIdentityMigrationSource, 'externalIdentity', 'external-identity') },
  { name: 'sequence', createModule: createSequenceModule, migrations: migrationsOf(sequenceMigrationSource, 'sequence', 'sequence') },
  { name: 'sequence-enrollment', createModule: createSequenceEnrollmentModule, migrations: migrationsOf(sequenceEnrollmentMigrationSource, 'sequenceEnrollment', 'sequence-enrollment') },
  { name: 'sequence-send', createModule: createSequenceSendModule, migrations: migrationsOf(sequenceSendMigrationSource, 'sequenceSend', 'sequence-send') },
  { name: 'sequence-step', createModule: createSequenceStepModule, migrations: migrationsOf(sequenceStepMigrationSource, 'sequenceStep', 'sequence-step') },
  { name: 'space-ai-proposal', createModule: createSpaceAiProposalModule, migrations: migrationsOf(spaceAiProposalMigrationSource, 'spaceAiProposal', 'space-ai-proposal') },
  { name: 'space-package', createModule: createSpacePackageModule, migrations: migrationsOf(spacePackageMigrationSource, 'spacePackage', 'space-package') },
  { name: 'space-permission-override', createModule: createSpacePermissionOverrideModule, migrations: migrationsOf(spacePermissionOverrideMigrationSource, 'spacePermissionOverride', 'space-permission-override') },
  { name: 'work-activity', createModule: createWorkActivityModule, migrations: migrationsOf(workActivityMigrationSource, 'workActivity', 'work-activity') },
  { name: 'work-task', createModule: createWorkTaskModule, migrations: migrationsOf(workTaskMigrationSource, 'workTask', 'work-task') },
];
