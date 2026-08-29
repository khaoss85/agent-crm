// @ts-check

import { renderPostgresMigration, renderSqliteMigration } from './dialect-sql.js';

const SAFE_INTEGER_MAX = 9007199254740991;

const timestamp = (name, extra = {}) => ({ name, affinity: 'timestamp', ...extra });
const text = (name, extra = {}) => ({ name, affinity: 'text', ...extra });
const integer = (name, extra = {}) => ({ name, affinity: 'integer', ...extra });

/** @type {any[]} */
const V1_STATEMENTS = [
  {
    kind: 'createTable',
    name: 'companies',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('name', { notNull: true }),
      text('domain'),
      timestamp('created_at', { notNull: true }),
      timestamp('updated_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTable',
    name: 'contacts',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('company_id', { notNull: true, references: { table: 'companies', onDelete: 'cascade' } }),
      text('first_name', { notNull: true }),
      text('last_name', { notNull: true }),
      text('email', { notNull: true, unique: true }),
      text('role'),
      timestamp('created_at', { notNull: true }),
      timestamp('updated_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTable',
    name: 'opportunities',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('company_id', { notNull: true, references: { table: 'companies', onDelete: 'restrict' } }),
      text('contact_id', { references: { table: 'contacts', onDelete: 'set_null' } }),
      text('name', { notNull: true }),
      text('type', { notNull: true, check: { kind: 'in', values: ['new_business', 'renewal', 'upsell'] } }),
      integer('value_cents', { notNull: true, check: { kind: 'gte', value: 0 } }),
      text('currency', { notNull: true }),
      text('stage', {
        notNull: true,
        check: { kind: 'in', values: ['discovery', 'qualification', 'proposal', 'approval_pending', 'negotiation', 'won', 'lost'] },
      }),
      text('owner', { notNull: true }),
      timestamp('expected_close_date'),
      timestamp('created_at', { notNull: true }),
      timestamp('updated_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTable',
    name: 'approvals',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('opportunity_id', { notNull: true, references: { table: 'opportunities', onDelete: 'cascade' } }),
      text('status', { notNull: true, check: { kind: 'in', values: ['pending', 'approved', 'rejected'] } }),
      text('reason', { notNull: true }),
      text('requested_by', { notNull: true }),
      text('decided_by'),
      timestamp('requested_at', { notNull: true }),
      timestamp('decided_at'),
    ],
  },
  {
    kind: 'createIndex',
    unique: true,
    ifNotExists: true,
    name: 'approvals_one_pending_per_opportunity',
    table: 'approvals',
    columns: ['opportunity_id'],
    where: { column: 'status', eq: 'pending' },
    layout: 'multiline',
  },
  {
    kind: 'createTable',
    name: 'workflow_runs',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('workflow_name', { notNull: true }),
      text('status', { notNull: true, check: { kind: 'in', values: ['running', 'completed', 'failed'] } }),
      text('input_json', { notNull: true }),
      text('output_json'),
      text('error'),
      timestamp('started_at', { notNull: true }),
      timestamp('finished_at'),
    ],
  },
  {
    kind: 'createTable',
    name: 'trace_spans',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('run_id', { notNull: true, references: { table: 'workflow_runs', onDelete: 'cascade' } }),
      text('parent_span_id'),
      text('name', { notNull: true }),
      text('status', { notNull: true, check: { kind: 'in', values: ['running', 'completed', 'failed', 'compensated'] } }),
      text('input_json'),
      text('output_json'),
      text('error'),
      timestamp('started_at', { notNull: true }),
      timestamp('finished_at'),
    ],
  },
  {
    kind: 'createIndex',
    ifNotExists: true,
    name: 'trace_spans_run_id',
    table: 'trace_spans',
    columns: ['run_id'],
  },
  {
    kind: 'createTable',
    name: 'audit_events',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('actor_type', { notNull: true }),
      text('actor_id', { notNull: true }),
      text('action', { notNull: true }),
      text('entity_type', { notNull: true }),
      text('entity_id', { notNull: true }),
      text('data_json', { notNull: true }),
      timestamp('created_at', { notNull: true }),
    ],
  },
  {
    kind: 'createIndex',
    ifNotExists: true,
    name: 'audit_events_entity',
    table: 'audit_events',
    columns: ['entity_type', 'entity_id'],
  },
  {
    kind: 'createIndex',
    ifNotExists: true,
    name: 'audit_events_created_at',
    table: 'audit_events',
    columns: [{ name: 'created_at', desc: true }],
    leading: 'single',
  },
];

/** @type {any[]} */
const V2_STATEMENTS = [
  { kind: 'addColumn', table: 'opportunities', column: text('source_key') },
  {
    kind: 'createIndex',
    unique: true,
    ifNotExists: true,
    name: 'opportunities_source_key',
    table: 'opportunities',
    columns: ['source_key'],
    where: { column: 'source_key', isNotNull: true },
    layout: 'multiline',
    leading: 'single',
  },
];

/** @type {any[]} */
const V3_STATEMENTS = [
  { kind: 'addColumn', table: 'opportunities', column: text('pipeline_key') },
  { kind: 'addColumn', table: 'opportunities', column: text('pipeline_stage'), leading: 'single' },
  { kind: 'addColumn', table: 'opportunities', column: timestamp('stage_entered_at'), leading: 'single' },
  { kind: 'addColumn', table: 'opportunities', column: timestamp('closed_at'), leading: 'single' },
  { kind: 'addColumn', table: 'opportunities', column: text('close_reason'), leading: 'single' },
  {
    kind: 'createIndex',
    ifNotExists: true,
    name: 'opportunities_pipeline_stage',
    table: 'opportunities',
    columns: ['pipeline_key', 'pipeline_stage'],
    layout: 'multiline',
    leading: 'single',
  },
];

/** @type {any[]} */
const V4_STATEMENTS = [
  {
    kind: 'createTable',
    name: 'definition_versions',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('type', { notNull: true }),
      text('name', { notNull: true }),
      integer('version', { notNull: true }),
      text('fingerprint', { notNull: true }),
      timestamp('registered_at', { notNull: true }),
    ],
    tableConstraints: [{ kind: 'unique', columns: ['type', 'name', 'version'] }],
  },
];

/** @type {any[]} */
const V5_STATEMENTS = [
  {
    kind: 'createTable',
    name: 'spine_organizations',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('slug', { notNull: true, unique: true }),
      text('name', { notNull: true }),
      text('provenance', {
        notNull: true,
        check: { kind: 'in', values: ['operator-configured', 'local-development-migration'] },
      }),
      timestamp('created_at', { notNull: true }),
      timestamp('updated_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTable',
    name: 'spine_memberships',
    ifNotExists: true,
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('organization_id', { notNull: true, references: { table: 'spine_organizations', onDelete: 'cascade' } }),
      text('subject', { notNull: true }),
      text('issuer'),
      text('role', { notNull: true }),
      text('status', { notNull: true, check: { kind: 'in', values: ['active', 'suspended'] } }),
      text('granted_by_subject'),
      text('granted_reason'),
      timestamp('created_at', { notNull: true }),
      timestamp('updated_at', { notNull: true }),
    ],
    tableConstraints: [{ kind: 'unique', columns: ['organization_id', 'subject'] }],
  },
  {
    kind: 'createIndex',
    ifNotExists: true,
    name: 'spine_memberships_subject',
    table: 'spine_memberships',
    columns: ['subject'],
    layout: 'multiline',
  },
];

const immutableBindingWhen = {
  join: 'or',
  wrap: true,
  clauses: [
    { op: 'isNot', column: 'tenant_slug' },
    { op: 'isNot', column: 'created_at' },
    { op: 'isNotNull', side: 'old', column: 'data_plane_id' },
    { op: 'isNull', side: 'new', column: 'data_plane_id' },
  ],
};

const auditRevisionWhen = {
  join: 'or',
  clauses: [
    { op: 'lt', column: 'audit_revision', value: 0 },
    { op: 'gt', column: 'audit_revision', value: SAFE_INTEGER_MAX },
  ],
};

const auditIntentImmutableWhen = {
  join: 'or',
  wrap: true,
  clauses: [
    { op: 'isNot', column: 'id' },
    { op: 'isNot', column: 'idempotency_key' },
    { op: 'isNot', column: 'destination_tenant_slug' },
    { op: 'isNot', column: 'audit_event_id' },
    { op: 'isNot', column: 'payload_fingerprint' },
    { op: 'isNot', column: 'actor_type' },
    { op: 'isNot', column: 'actor_id' },
    { op: 'isNot', column: 'action' },
    { op: 'isNot', column: 'entity_type' },
    { op: 'isNot', column: 'entity_id' },
    { op: 'isNot', column: 'data_json' },
    { op: 'isNot', column: 'mutation_revision' },
    { op: 'isNot', column: 'created_at' },
    { op: 'isNotNull', side: 'old', column: 'delivered_at' },
    { op: 'isNull', side: 'new', column: 'delivered_at' },
  ],
};

/** @type {any[]} */
const V6_STATEMENTS = [
  {
    kind: 'createTable',
    name: 'spine_data_plane_binding',
    strict: true,
    columns: [
      integer('singleton', { primaryKey: true, check: { kind: 'eq', value: 1 } }),
      text('tenant_slug', { notNull: true }),
      text('data_plane_id', { notNull: true, unique: true }),
      timestamp('created_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTrigger',
    name: 'spine_data_plane_binding_no_update',
    timing: 'before',
    event: 'update',
    table: 'spine_data_plane_binding',
    abortMessage: 'spine data-plane binding is immutable',
  },
  {
    kind: 'createTrigger',
    name: 'spine_data_plane_binding_no_delete',
    timing: 'before',
    event: 'delete',
    table: 'spine_data_plane_binding',
    abortMessage: 'spine data-plane binding is immutable',
  },
];

/** @type {any[]} */
const V7_STATEMENTS = [
  {
    kind: 'addColumn',
    table: 'spine_organizations',
    column: integer('audit_revision', { notNull: true, defaultSql: '0' }),
  },
  {
    kind: 'addColumn',
    table: 'spine_memberships',
    column: integer('audit_revision', { notNull: true, defaultSql: '0' }),
    leading: 'single',
  },
  {
    kind: 'createTrigger',
    name: 'spine_organizations_audit_revision_insert',
    timing: 'before',
    event: 'insert',
    table: 'spine_organizations',
    when: auditRevisionWhen,
    abortMessage: 'spine audit revision must be a non-negative safe integer',
  },
  {
    kind: 'createTrigger',
    name: 'spine_organizations_audit_revision_update',
    timing: 'before',
    event: 'update',
    ofColumns: ['audit_revision'],
    table: 'spine_organizations',
    when: auditRevisionWhen,
    abortMessage: 'spine audit revision must be a non-negative safe integer',
  },
  {
    kind: 'createTrigger',
    name: 'spine_memberships_audit_revision_insert',
    timing: 'before',
    event: 'insert',
    table: 'spine_memberships',
    when: auditRevisionWhen,
    abortMessage: 'spine audit revision must be a non-negative safe integer',
  },
  {
    kind: 'createTrigger',
    name: 'spine_memberships_audit_revision_update',
    timing: 'before',
    event: 'update',
    ofColumns: ['audit_revision'],
    table: 'spine_memberships',
    when: auditRevisionWhen,
    abortMessage: 'spine audit revision must be a non-negative safe integer',
  },
  {
    kind: 'createTable',
    name: 'spine_tenant_bindings',
    strict: true,
    columns: [
      text('tenant_slug', { primaryKey: true }),
      text('data_plane_id', { unique: true }),
      timestamp('created_at', { notNull: true }),
    ],
  },
  {
    kind: 'createTrigger',
    name: 'spine_tenant_bindings_no_update',
    timing: 'before',
    event: 'update',
    table: 'spine_tenant_bindings',
    when: immutableBindingWhen,
    abortMessage: 'spine tenant binding permits only its first data-plane claim',
  },
  {
    kind: 'createTrigger',
    name: 'spine_tenant_bindings_no_delete',
    timing: 'before',
    event: 'delete',
    table: 'spine_tenant_bindings',
    abortMessage: 'spine tenant binding is immutable',
  },
  {
    kind: 'createTable',
    name: 'spine_audit_intents',
    strict: true,
    columns: [
      text('id', { primaryKey: true }),
      text('idempotency_key', { notNull: true, unique: true }),
      text('destination_tenant_slug', { notNull: true }),
      text('audit_event_id', { notNull: true, unique: true }),
      text('payload_fingerprint', { notNull: true }),
      text('actor_type', { notNull: true }),
      text('actor_id', { notNull: true }),
      text('action', { notNull: true }),
      text('entity_type', { notNull: true }),
      text('entity_id', { notNull: true }),
      text('data_json', { notNull: true }),
      integer('mutation_revision', {
        notNull: true,
        check: { kind: 'between', min: 1, max: SAFE_INTEGER_MAX },
        checkWrap: true,
      }),
      timestamp('created_at', { notNull: true }),
      timestamp('delivered_at'),
    ],
    tableConstraints: [
      { kind: 'unique', columns: ['entity_type', 'entity_id', 'mutation_revision'] },
      {
        kind: 'foreignKey',
        columns: ['destination_tenant_slug'],
        table: 'spine_tenant_bindings',
        refColumns: ['tenant_slug'],
        onDelete: 'restrict',
        wrap: true,
      },
    ],
  },
  {
    kind: 'createIndex',
    name: 'spine_audit_intents_pending_destination',
    table: 'spine_audit_intents',
    columns: ['destination_tenant_slug', 'created_at', 'id'],
    where: { column: 'delivered_at', isNull: true },
    layout: 'multiline',
  },
  {
    kind: 'createTrigger',
    name: 'spine_audit_intents_terminal_update',
    timing: 'before',
    event: 'update',
    table: 'spine_audit_intents',
    when: auditIntentImmutableWhen,
    abortMessage: 'spine audit intent is immutable except pending-to-delivered',
  },
  {
    kind: 'createTrigger',
    name: 'spine_audit_intents_no_delete',
    timing: 'before',
    event: 'delete',
    table: 'spine_audit_intents',
    abortMessage: 'spine audit intent history is immutable',
  },
];

/** @type {any[]} */
const V8_STATEMENTS = [
  { kind: 'addColumn', table: 'schema_migrations', column: text('checksum') },
];

/**
 * Authoritative core schema intent. SQLite SQL is rendered from this structure
 * and must hash to the released checksums; PostgreSQL SQL is rendered from the
 * same structure and is never translated from SQLite text.
 */
export const CORE_SCHEMA_INTENT = Object.freeze([
  Object.freeze({ version: 1, name: 'initial_crm_schema', plane: 'data', statements: Object.freeze(V1_STATEMENTS) }),
  Object.freeze({ version: 2, name: 'opportunity_source_key', plane: 'data', statements: Object.freeze(V2_STATEMENTS) }),
  Object.freeze({ version: 3, name: 'opportunity_pipeline_state', plane: 'data', statements: Object.freeze(V3_STATEMENTS) }),
  Object.freeze({ version: 4, name: 'definition_versions', plane: 'data', statements: Object.freeze(V4_STATEMENTS) }),
  Object.freeze({ version: 5, name: 'production_spine_identity', plane: 'control', statements: Object.freeze(V5_STATEMENTS) }),
  Object.freeze({ version: 6, name: 'spine_data_plane_binding_marker', plane: 'data', statements: Object.freeze(V6_STATEMENTS) }),
  Object.freeze({ version: 7, name: 'spine_cross_plane_audit_intents', plane: 'control', statements: Object.freeze(V7_STATEMENTS) }),
  Object.freeze({ version: 8, name: 'schema_migrations_checksum', plane: 'ledger', statements: Object.freeze(V8_STATEMENTS) }),
]);

/**
 * @param {{version: number, name: string, plane: string, statements: any[]}} intent
 */
export function renderCoreSqliteSql(intent) {
  return renderSqliteMigration(intent.statements);
}

/**
 * @param {{version: number, name: string, plane: string, statements: any[]}} intent
 */
export function renderCorePostgresSql(intent) {
  return renderPostgresMigration(intent.statements);
}

/**
 * @param {number} version
 */
export function coreSchemaIntentByVersion(version) {
  return CORE_SCHEMA_INTENT.find((intent) => intent.version === version) ?? null;
}
