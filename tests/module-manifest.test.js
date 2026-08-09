import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateModuleManifest,
  generateModuleMigration,
  pluralizeTableName,
} from '../packages/core/src/module-manifest.js';

const partnerManifest = JSON.parse(
  readFileSync(new URL('../examples/modules/partner.module.json', import.meta.url), 'utf8'),
);

test('a valid manifest normalizes with defaults and stays frozen', () => {
  const normalized = validateModuleManifest(partnerManifest);
  assert.equal(normalized.name, 'partner');
  assert.equal(normalized.table, 'partners');
  assert.equal(normalized.fields.length, 3);
  assert.deepEqual(normalized.fields[0], {
    name: 'name',
    type: 'string',
    required: true,
    unique: false,
    column: 'name',
    writable: 'public',
  });
  assert.deepEqual(normalized.fields[1].values, ['silver', 'gold', 'platinum']);
  assert.equal(normalized.fields[1].required, false);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.fields[0]));
});

test('invalid manifests fail with every problem named', () => {
  let error;
  try {
    validateModuleManifest({
      name: 'Bad Name',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'tier', type: 'enum' },
        { name: 'tier', type: 'enum', values: ['a'] },
        { name: 'age', type: 'number' },
        { name: 'owner', type: 'string', references: 'users' },
      ],
      extra: true,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected validation to throw');
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.match(error.message, /name is required and must match/);
  assert.match(error.message, /"id" is reserved/);
  assert.match(error.message, /enum fields require a non-empty "values"/);
  assert.match(error.message, /type must be one of: string, email, integer, boolean, timestamp, enum, reference/);
  assert.match(error.message, /"references" and "onDelete" are only allowed on reference fields/);
  assert.match(error.message, /unknown manifest property "extra"/);
});

test('duplicate field names and empty manifests are rejected', () => {
  assert.throws(
    () =>
      validateModuleManifest({
        name: 'partner',
        fields: [
          { name: 'tier', type: 'string' },
          { name: 'tier', type: 'string' },
        ],
      }),
    /duplicate field name/,
  );
  assert.throws(() => validateModuleManifest({ name: 'partner' }), /fields is required/);
  assert.throws(() => validateModuleManifest(null), /must be a JSON object/);
});

test('reference fields require a target table and validate onDelete', () => {
  assert.throws(
    () => validateModuleManifest({ name: 'deal', fields: [{ name: 'companyId', type: 'reference' }] }),
    /require "references" naming the target table/,
  );
  assert.throws(
    () =>
      validateModuleManifest({
        name: 'deal',
        fields: [{ name: 'companyId', type: 'reference', references: 'companies', onDelete: 'nuke' }],
      }),
    /onDelete must be one of: restrict, cascade, set_null/,
  );
  assert.throws(
    () =>
      validateModuleManifest({
        name: 'deal',
        fields: [{ name: 'companyId', type: 'reference', references: 'companies', onDelete: 'set_null', required: true }],
      }),
    /onDelete "set_null" conflicts with required: true/,
  );
});

test('migration generation is deterministic and matches the documented output', () => {
  const first = generateModuleMigration(partnerManifest);
  const second = generateModuleMigration(partnerManifest);
  assert.deepEqual(first, second);
  assert.equal(first.migrationName, 'create_partners');
  assert.equal(
    first.sql,
    [
      'CREATE TABLE IF NOT EXISTS partners (',
      '  id TEXT PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      "  tier TEXT CHECK(tier IN ('silver', 'gold', 'platinum')),",
      '  territory TEXT,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ') STRICT;',
      '',
    ].join('\n'),
  );
});

test('references, uniques and camelCase columns generate expected SQL', () => {
  const migration = generateModuleMigration({
    name: 'partner-contract',
    table: 'partner_contracts',
    fields: [
      { name: 'partnerId', type: 'reference', references: 'partners', required: true, onDelete: 'cascade' },
      { name: 'contractCode', type: 'string', required: true, unique: true },
      { name: 'active', type: 'boolean' },
      { name: 'signedAt', type: 'timestamp' },
      { name: 'valueCents', type: 'integer', required: true },
    ],
  });
  assert.equal(migration.table, 'partner_contracts');
  assert.match(migration.sql, /partner_id TEXT NOT NULL REFERENCES partners\(id\) ON DELETE CASCADE/);
  assert.match(migration.sql, /contract_code TEXT NOT NULL UNIQUE/);
  assert.match(migration.sql, /active INTEGER CHECK\(active IN \(0, 1\)\)/);
  assert.match(migration.sql, /signed_at TEXT/);
  assert.match(migration.sql, /value_cents INTEGER NOT NULL/);
  assert.match(
    migration.sql,
    /CREATE INDEX IF NOT EXISTS partner_contracts_partner_id ON partner_contracts\(partner_id\);/,
  );
});

test('SQLite keyword identifiers are rejected with clear errors', () => {
  assert.throws(
    () => validateModuleManifest({ name: 'ordine', fields: [{ name: 'order', type: 'string' }] }),
    /column "order" would be a SQLite keyword; rename the field/,
  );
  assert.throws(
    () => validateModuleManifest({ name: 'value', fields: [{ name: 'amount', type: 'integer' }] }),
    /default table name "values" \(derived from "value"\) is a SQLite keyword/,
  );
  assert.throws(
    () => validateModuleManifest({ name: 'thing', table: 'select', fields: [{ name: 'amount', type: 'integer' }] }),
    /table "select" is a SQLite keyword/,
  );
  assert.throws(
    () =>
      validateModuleManifest({
        name: 'thing',
        fields: [{ name: 'targetId', type: 'reference', references: 'values' }],
      }),
    /references target "values" is a SQLite keyword/,
  );
});

test('manifests carry an explicit version and unsupported versions fail usefully', () => {
  const normalized = validateModuleManifest(partnerManifest);
  assert.equal(normalized.manifestVersion, 1);
  const explicit = validateModuleManifest({ ...partnerManifest, manifestVersion: 1 });
  assert.equal(explicit.manifestVersion, 1);
  assert.throws(
    () => validateModuleManifest({ ...partnerManifest, manifestVersion: 2 }),
    /Unsupported manifestVersion: 2\. This version of accordo supports manifest version 1/,
  );
});

test('validation is idempotent: a normalized manifest re-validates and generates', () => {
  const normalized = validateModuleManifest(partnerManifest);
  const again = validateModuleManifest(normalized);
  assert.deepEqual(again, normalized);
  assert.deepEqual(generateModuleMigration(normalized), generateModuleMigration(partnerManifest));
  assert.throws(
    () =>
      validateModuleManifest({
        name: 'partner',
        fields: [{ name: 'tierLevel', type: 'string', column: 'wrong_column' }],
      }),
    /"column" is derived from the field name \(expected "tier_level"\)/,
  );
});

test('structurally unusable managed-field combinations are rejected at validation', () => {
  const manifest = (field) => ({ name: 'thing', fields: [{ name: 'title', type: 'string', required: true }, field] });

  // managed + required without a default: every create would violate NOT NULL.
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'state', type: 'enum', values: ['a', 'b'], writable: 'managed', required: true })),
    /needs a "default"/,
  );
  // With a default it is valid.
  assert.doesNotThrow(
    () => validateModuleManifest(manifest({ name: 'state', type: 'enum', values: ['a', 'b'], writable: 'managed', required: true, default: 'a' })),
  );
  // managed + unique + default: the second create would always fail.
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'slug', type: 'string', writable: 'managed', unique: true, default: 'x' })),
    /unique: true with a "default"/,
  );
  // managed + unique without default is fine (every create inserts NULL).
  assert.doesNotThrow(
    () => validateModuleManifest(manifest({ name: 'slug', type: 'string', writable: 'managed', unique: true })),
  );
  // default on a public field would silently never apply — rejected.
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'tier', type: 'enum', values: ['a', 'b'], default: 'a' })),
    /requires "writable": "managed"/,
  );
  // Unknown writable values and managed references stay rejected.
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'state', type: 'string', writable: 'internal' })),
    /writable must be "public" or "managed"/,
  );
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'ownerId', type: 'reference', references: 'partners', writable: 'managed' })),
    /reference fields cannot be managed/,
  );
  // default on unsupported types stays rejected even when managed.
  assert.throws(
    () => validateModuleManifest(manifest({ name: 'at', type: 'timestamp', writable: 'managed', default: '2026-01-01T00:00:00.000Z' })),
    /only supported on string and enum/,
  );
});

test('default table names follow the documented naive plural', () => {
  assert.equal(pluralizeTableName('partner'), 'partners');
  assert.equal(pluralizeTableName('company'), 'companies');
  assert.equal(pluralizeTableName('business'), 'businesses');
  assert.equal(pluralizeTableName('partner-contract'), 'partner_contracts');
});
