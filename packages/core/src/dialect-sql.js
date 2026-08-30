// @ts-check

import {
  POSTGRES_SCHEMA_NAME,
  mapPhysicalName,
  mapPhysicalNamespace,
  qualifyPostgresIdent,
  quotePostgresIdent,
} from './physical-name.js';

export const SQLITE_DIALECT = 'sqlite';
export const POSTGRES_DIALECT = 'postgres';

const SQLITE_ON_DELETE = Object.freeze({
  cascade: 'CASCADE',
  restrict: 'RESTRICT',
  set_null: 'SET NULL',
});

/**
 * @param {string} value
 */
function sqlStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {any} column
 * @param {'sqlite'|'postgres'} dialect
 */
function columnTypeSql(column, dialect) {
  if (dialect === 'postgres') {
    if (column.affinity === 'integer') return 'BIGINT';
    if (column.affinity === 'boolean') return 'BOOLEAN';
    if (column.affinity === 'timestamp') return 'TIMESTAMPTZ';
    return 'TEXT';
  }
  if (column.affinity === 'integer' || column.affinity === 'boolean') return 'INTEGER';
  return 'TEXT';
}

/**
 * @param {any} check
 * @param {string} columnName
 */
function columnCheckSql(check, columnName) {
  if (!check) return '';
  if (check.kind === 'in') {
    return `CHECK(${columnName} IN (${check.values.map((value) => sqlStringLiteral(value)).join(', ')}))`;
  }
  if (check.kind === 'eq') {
    const value = typeof check.value === 'number' ? String(check.value) : sqlStringLiteral(check.value);
    return `CHECK(${columnName} = ${value})`;
  }
  if (check.kind === 'gte') return `CHECK(${columnName} >= ${check.value})`;
  if (check.kind === 'between') return `CHECK(${columnName} BETWEEN ${check.min} AND ${check.max})`;
  return '';
}

/**
 * @param {any} column
 * @param {'sqlite'|'postgres'} dialect
 * @param {(name: string) => string} ident
 */
function renderColumn(column, dialect, ident) {
  const name = ident(column.name);
  const parts = [name, columnTypeSql(column, dialect)];
  if (column.primaryKey) parts.push('PRIMARY KEY');
  if (column.notNull) parts.push('NOT NULL');
  if (column.unique) parts.push('UNIQUE');
  if (column.defaultSql !== undefined) parts.push(`DEFAULT ${column.defaultSql}`);
  if (column.affinity === 'boolean' && dialect === 'sqlite') {
    parts.push(`CHECK(${name} IN (0, 1))`);
  }
  const check = columnCheckSql(column.check, name);
  if (check && column.checkWrap) {
    return { sql: `${parts.join(' ')}\n    ${check}`, wrapped: true };
  }
  if (check) parts.push(check);
  if (column.references) {
    const onDelete = SQLITE_ON_DELETE[column.references.onDelete] ?? 'RESTRICT';
    const targetTable = dialect === 'postgres'
      ? qualifyPostgresIdent(POSTGRES_SCHEMA_NAME, mapPhysicalName(column.references.table).physical)
      : column.references.table;
    const targetColumn = ident(column.references.column ?? 'id');
    parts.push(`REFERENCES ${targetTable}(${targetColumn}) ON DELETE ${onDelete}`);
  }
  return { sql: parts.join(' '), wrapped: false };
}

/**
 * @param {any[]} columns
 */
function indexColumnSql(columns, ident) {
  return columns.map((entry) => {
    if (typeof entry === 'string') return ident(entry);
    return `${ident(entry.name)}${entry.desc ? ' DESC' : ''}`;
  }).join(', ');
}

/**
 * @param {any} where
 * @param {(name: string) => string} ident
 */
function indexWhereSql(where, ident) {
  if (!where) return '';
  const column = ident(where.column);
  if (where.eq !== undefined) return `WHERE ${column} = ${sqlStringLiteral(where.eq)}`;
  if (where.isNotNull) return `WHERE ${column} IS NOT NULL`;
  if (where.isNull) return `WHERE ${column} IS NULL`;
  return '';
}

/**
 * @param {any} clause
 * @param {'sqlite'|'postgres'} dialect
 */
function renderTriggerClause(clause, dialect) {
  const distinct = dialect === 'postgres' ? 'IS DISTINCT FROM' : 'IS NOT';
  if (clause.op === 'isNot') {
    return `NEW.${clause.column} ${distinct} OLD.${clause.column}`;
  }
  if (clause.op === 'isNotNull') {
    const side = clause.side === 'old' ? 'OLD' : 'NEW';
    return `${side}.${clause.column} IS NOT NULL`;
  }
  if (clause.op === 'isNull') {
    const side = clause.side === 'old' ? 'OLD' : 'NEW';
    return `${side}.${clause.column} IS NULL`;
  }
  if (clause.op === 'lt') return `NEW.${clause.column} < ${clause.value}`;
  if (clause.op === 'gt') return `NEW.${clause.column} > ${clause.value}`;
  return '';
}

/**
 * @param {any} when
 * @param {'sqlite'|'postgres'} dialect
 */
function renderTriggerWhen(when, dialect) {
  if (!when) return '';
  const clauses = when.clauses.map((clause) => renderTriggerClause(clause, dialect));
  if (when.wrap && dialect === 'sqlite') {
    return `WHEN ${clauses.join('\n  OR ')}`;
  }
  const joiner = when.join === 'or' ? ' OR ' : ' AND ';
  const body = clauses.join(joiner);
  return dialect === 'postgres' ? `WHEN (${body})` : `WHEN ${body}`;
}

/**
 * @param {any} statement
 */
function renderSqliteStatement(statement) {
  const ident = (name) => name;
  if (statement.kind === 'createTable') {
    const ifNotExists = statement.ifNotExists ? 'IF NOT EXISTS ' : '';
    const columnSql = statement.columns.map((column) => `  ${renderColumn(column, 'sqlite', ident).sql}`);
    const constraints = (statement.tableConstraints ?? []).map((constraint) => {
      if (constraint.kind === 'unique') return `  UNIQUE(${constraint.columns.map(ident).join(', ')})`;
      if (constraint.kind === 'foreignKey') {
        const refs = `REFERENCES ${constraint.table}(${(constraint.refColumns ?? ['id']).map(ident).join(', ')}) ON DELETE ${SQLITE_ON_DELETE[constraint.onDelete] ?? 'RESTRICT'}`;
        if (constraint.wrap) {
          return `  FOREIGN KEY(${constraint.columns.map(ident).join(', ')})\n    ${refs}`;
        }
        return `  FOREIGN KEY(${constraint.columns.map(ident).join(', ')}) ${refs}`;
      }
      return '';
    }).filter(Boolean);
    const body = [...columnSql, ...constraints].join(',\n');
    const strict = statement.strict ? ' STRICT' : '';
    return `CREATE TABLE ${ifNotExists}${statement.name} (\n${body}\n)${strict};`;
  }
  if (statement.kind === 'createIndex') {
    const unique = statement.unique ? 'UNIQUE ' : '';
    const ifNotExists = statement.ifNotExists ? 'IF NOT EXISTS ' : '';
    const cols = indexColumnSql(statement.columns, ident);
    const where = indexWhereSql(statement.where, ident);
    if (statement.layout === 'multiline') {
      const whereLine = where ? `\n  ${where}` : '';
      return `CREATE ${unique}INDEX ${ifNotExists}${statement.name}\n  ON ${statement.table}(${cols})${whereLine};`;
    }
    const whereSql = where ? ` ${where}` : '';
    return `CREATE ${unique}INDEX ${ifNotExists}${statement.name} ON ${statement.table}(${cols})${whereSql};`;
  }
  if (statement.kind === 'addColumn') {
    const rendered = renderColumn(statement.column, 'sqlite', ident).sql;
    const extra = statement.column.notNull && statement.column.defaultSql !== undefined
      ? ''
      : '';
    void extra;
    return `ALTER TABLE ${statement.table} ADD COLUMN ${rendered};`;
  }
  if (statement.kind === 'createTrigger') {
    const ofClause = statement.ofColumns?.length ? ` OF ${statement.ofColumns.join(', ')}` : '';
    const when = renderTriggerWhen(statement.when, 'sqlite');
    const whenBlock = when ? `\n${when}` : '';
    return [
      `CREATE TRIGGER ${statement.name}`,
      `BEFORE ${statement.event.toUpperCase()}${ofClause} ON ${statement.table}${whenBlock}`,
      'BEGIN',
      `  SELECT RAISE(ABORT, ${sqlStringLiteral(statement.abortMessage)});`,
      'END;',
    ].join('\n');
  }
  throw new Error(`Unsupported SQLite statement kind: ${statement.kind}`);
}

/**
 * Render released-style SQLite SQL: leading newline, 6-space indent, trailing
 * newline + 4 spaces. Matches the historical `database.js` template literals.
 *
 * @param {any[]} statements
 */
export function renderSqliteMigration(statements) {
  const chunks = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const indented = renderSqliteStatement(statement)
      .split('\n')
      .map((line) => (line.length > 0 ? `      ${line}` : line))
      .join('\n');
    if (index === 0) chunks.push(indented);
    else chunks.push(`${statement.leading === 'single' ? '\n' : '\n\n'}${indented}`);
  }
  return `\n${chunks.join('')}\n    `;
}

/**
 * @param {any} statement
 * @param {Map<string, string>} physical
 */
function physicalOf(physical, logical) {
  return physical.get(logical) ?? mapPhysicalName(logical).physical;
}

/**
 * @param {any} statement
 * @param {Map<string, string>} physical
 */
function renderPostgresStatement(statement, physical) {
  const schema = POSTGRES_SCHEMA_NAME;
  const ident = (name) => quotePostgresIdent(physicalOf(physical, name));
  const tableName = (name) => qualifyPostgresIdent(schema, physicalOf(physical, name));

  if (statement.kind === 'createTable') {
    const columnSql = statement.columns.map((column) => `  ${renderColumn(column, 'postgres', ident).sql}`);
    const constraints = (statement.tableConstraints ?? []).map((constraint) => {
      if (constraint.kind === 'unique') {
        const constraintName = ident(`${statement.name}_${constraint.columns.join('_')}_key`);
        return `  CONSTRAINT ${constraintName} UNIQUE (${constraint.columns.map(ident).join(', ')})`;
      }
      if (constraint.kind === 'foreignKey') {
        const constraintName = ident(`${statement.name}_${constraint.columns.join('_')}_fkey`);
        const refs = `REFERENCES ${tableName(constraint.table)}(${(constraint.refColumns ?? ['id']).map(ident).join(', ')}) ON DELETE ${SQLITE_ON_DELETE[constraint.onDelete] ?? 'RESTRICT'}`;
        return `  CONSTRAINT ${constraintName} FOREIGN KEY (${constraint.columns.map(ident).join(', ')}) ${refs}`;
      }
      return '';
    }).filter(Boolean);
    const body = [...columnSql, ...constraints].join(',\n');
    return `CREATE TABLE ${tableName(statement.name)} (\n${body}\n);`;
  }
  if (statement.kind === 'createIndex') {
    const unique = statement.unique ? 'UNIQUE ' : '';
    const cols = indexColumnSql(statement.columns, ident);
    const where = indexWhereSql(statement.where, ident);
    const whereSql = where ? `\n  ${where}` : '';
    return `CREATE ${unique}INDEX ${ident(statement.name)}\n  ON ${tableName(statement.table)}(${cols})${whereSql};`;
  }
  if (statement.kind === 'addColumn') {
    return `ALTER TABLE ${tableName(statement.table)} ADD COLUMN ${renderColumn(statement.column, 'postgres', ident).sql};`;
  }
  if (statement.kind === 'createTrigger') {
    const functionPhysical = physicalOf(physical, statement.name);
    const functionIdent = qualifyPostgresIdent(schema, functionPhysical);
    const ofClause = statement.ofColumns?.length
      ? ` OF ${statement.ofColumns.map((column) => ident(column)).join(', ')}`
      : '';
    const when = renderTriggerWhen(statement.when, 'postgres');
    const whenBlock = when ? `\n  ${when}` : '';
    return [
      `CREATE FUNCTION ${functionIdent}() RETURNS trigger LANGUAGE plpgsql AS $$`,
      'BEGIN',
      `  RAISE EXCEPTION ${sqlStringLiteral(statement.abortMessage)};`,
      '  RETURN NULL;',
      'END;',
      '$$;',
      `CREATE TRIGGER ${ident(statement.name)}`,
      `  BEFORE ${statement.event.toUpperCase()}${ofClause} ON ${tableName(statement.table)}`,
      `  FOR EACH ROW${whenBlock}`,
      `  EXECUTE FUNCTION ${functionIdent}();`,
    ].join('\n');
  }
  throw new Error(`Unsupported PostgreSQL statement kind: ${statement.kind}`);
}

/**
 * Collect logical identifiers that must be unique inside one PostgreSQL schema.
 *
 * @param {any[]} statements
 */
export function collectLogicalNamespace(statements) {
  /** @type {string[]} */
  const names = [POSTGRES_SCHEMA_NAME];
  for (const statement of statements) {
    if (statement.kind === 'createTable') {
      names.push(statement.name);
      for (const constraint of statement.tableConstraints ?? []) {
        if (constraint.kind === 'unique') names.push(`${statement.name}_${constraint.columns.join('_')}_key`);
        if (constraint.kind === 'foreignKey') names.push(`${statement.name}_${constraint.columns.join('_')}_fkey`);
      }
    }
    if (statement.kind === 'createIndex') names.push(statement.name);
    if (statement.kind === 'createTrigger') names.push(statement.name);
    if (statement.kind === 'addColumn') names.push(statement.table);
  }
  return names;
}

/**
 * @param {any[]} statements
 * @param {{schema?: string}} [options]
 */
export function renderPostgresMigration(statements, options = {}) {
  const schema = options.schema ?? POSTGRES_SCHEMA_NAME;
  const namespace = mapPhysicalNamespace(collectLogicalNamespace(statements));
  const physical = new Map(namespace.map((entry) => [entry.logical, entry.physical]));
  const body = statements.map((statement) => renderPostgresStatement(statement, physical)).join('\n\n');
  const sql = `CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdent(schema)};\n\n${body}\n`;
  return { sql, names: namespace };
}

/**
 * @param {any} field
 */
export function manifestFieldToColumn(field) {
  /** @type {any} */
  const column = { name: field.column };
  if (field.type === 'integer') column.affinity = 'integer';
  else if (field.type === 'boolean') column.affinity = 'boolean';
  else if (field.type === 'timestamp') column.affinity = 'timestamp';
  else column.affinity = 'text';
  if (field.required) column.notNull = true;
  if (field.unique) column.unique = true;
  if (field.type === 'enum' && field.values) column.check = { kind: 'in', values: field.values };
  if (field.type === 'reference' && field.references) {
    column.references = {
      table: field.references,
      column: 'id',
      onDelete: field.onDelete ?? 'restrict',
    };
  }
  return column;
}
