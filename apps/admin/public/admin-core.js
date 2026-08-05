// @ts-check

// Pure, DOM-free helpers for the generated-module Admin. Everything here is
// unit-tested under node:test without a browser.

export const SUPPORTED_ADMIN_CONTRACT = 1;

const IMMUTABLE_FIELDS = ['id', 'createdAt', 'updatedAt'];

/**
 * Human label from a camelCase or snake_case identifier.
 *   companyName  → "Company name"
 *   company_name → "Company name"
 *   URLValue     → "URL value"
 * @param {string} name
 */
export function humanizeLabel(name) {
  if (typeof name !== 'string' || name === '') return '';
  const withSpaces = name
    .replace(/[_-]+/g, ' ')
    // boundary between an acronym run and a following word: URLValue → URL Value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // boundary between a lower/digit and an upper: companyName → company Name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/\s+/g, ' ');
  const words = withSpaces.split(' ');
  return words
    .map((word, index) => {
      if (word === word.toUpperCase() && word.length > 1) return word; // keep acronyms (URL)
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word.toLowerCase();
    })
    .join(' ');
}

/**
 * Map a schema field to an input control descriptor.
 * @param {{name: string, type: string, required?: boolean, unique?: boolean, values?: string[]}} field
 */
export function fieldControl(field) {
  const base = {
    name: field.name,
    label: humanizeLabel(field.name),
    required: field.required === true,
    unique: field.unique === true,
    type: field.type,
  };
  switch (field.type) {
    case 'enum':
      return { ...base, control: 'select', options: Array.isArray(field.values) ? field.values.slice() : [] };
    case 'integer':
      return { ...base, control: 'number', step: 1 };
    case 'boolean':
      return { ...base, control: 'checkbox' };
    case 'email':
      return { ...base, control: 'email' };
    case 'timestamp':
      return { ...base, control: 'datetime' };
    default:
      return { ...base, control: 'text' };
  }
}

/** @param {{fields?: Array<{name: string}>}} moduleMeta */
export function editableFields(moduleMeta) {
  const fields = Array.isArray(moduleMeta?.fields) ? moduleMeta.fields : [];
  return fields.filter((field) => !IMMUTABLE_FIELDS.includes(field.name));
}

/**
 * Build a create payload from raw form string/checkbox values, applying the
 * documented omit-optional-blanks and strict-type rules. Returns
 * { payload, errors } — client-side errors improve UX; the server stays
 * authoritative.
 *
 * @param {Array<{name: string, type: string, required?: boolean}>} fields
 * @param {Record<string, unknown>} raw
 */
export function buildCreatePayload(fields, raw) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  /** @type {Record<string, string>} */
  const errors = {};
  for (const field of fields) {
    const control = fieldControl(field);
    const value = raw[field.name];
    if (control.control === 'checkbox') {
      payload[field.name] = value === true || value === 'true' || value === 'on';
      continue;
    }
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text === '') {
      if (control.required) errors[field.name] = `${control.label} is required`;
      continue; // omit optional blanks
    }
    if (control.control === 'number') {
      if (!/^-?\d+$/.test(text)) {
        errors[field.name] = `${control.label} must be a whole number`;
        continue;
      }
      payload[field.name] = Number(text);
      continue;
    }
    payload[field.name] = text;
  }
  return { payload, errors };
}

/**
 * Build an update payload: only fields the user actually changed, strict types,
 * immutable fields never included.
 *
 * @param {Array<{name: string, type: string, required?: boolean}>} fields
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} current
 */
export function buildUpdatePayload(fields, raw, current) {
  /** @type {Record<string, unknown>} */
  const payload = {};
  /** @type {Record<string, string>} */
  const errors = {};
  for (const field of editableFields({ fields })) {
    const control = fieldControl(field);
    const value = raw[field.name];
    if (control.control === 'checkbox') {
      const next = value === true || value === 'true' || value === 'on';
      if (next !== (current[field.name] === true)) payload[field.name] = next;
      continue;
    }
    const text = value === undefined || value === null ? '' : String(value).trim();
    const currentText = current[field.name] === undefined || current[field.name] === null
      ? ''
      : String(current[field.name]);
    if (text === currentText) continue;
    if (text === '') {
      if (control.required) errors[field.name] = `${control.label} is required`;
      continue;
    }
    if (control.control === 'number') {
      if (!/^-?\d+$/.test(text)) {
        errors[field.name] = `${control.label} must be a whole number`;
        continue;
      }
      payload[field.name] = Number(text);
      continue;
    }
    payload[field.name] = text;
  }
  return { payload, errors };
}

/**
 * Map a normalized API error (as thrown by the client: {status, code, message,
 * details}) to a general message plus optional per-field messages.
 *
 * @param {any} error
 */
export function apiErrorToFormErrors(error) {
  const general = error?.message ? String(error.message) : 'Request failed';
  /** @type {Record<string, string>} */
  const fields = {};
  const field = error?.details?.field;
  if (typeof field === 'string' && field) fields[field] = general;
  return { general, fields, status: error?.status ?? null, code: error?.code ?? null };
}

/**
 * Generated modules the Admin may render: gated on the contract version and on
 * a minimal well-formedness check, sorted deterministically by name. Returns
 * { supported, modules }.
 *
 * @param {any} schema
 */
export function selectGeneratedModules(schema) {
  const version = schema?.generatedResourceContract;
  const supported = version === SUPPORTED_ADMIN_CONTRACT;
  if (!supported) return { supported: false, version: version ?? null, modules: [] };
  const list = Array.isArray(schema?.generatedModules) ? schema.generatedModules : [];
  const modules = list
    .filter(
      (module) =>
        module &&
        typeof module.name === 'string' &&
        /^[a-z][a-z0-9-]*$/.test(module.name) &&
        module.kind === 'generated' &&
        Array.isArray(module.capabilities) &&
        Array.isArray(module.fields),
    )
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { supported: true, version, modules };
}

/**
 * A short human title for a record: first required string field value, else id.
 * @param {any} record @param {Array<{name: string, type: string, required?: boolean}>} fields
 */
export function displayTitle(record, fields) {
  const titleField = (fields ?? []).find(
    (field) => field.type === 'string' && field.required && record?.[field.name],
  );
  if (titleField) return String(record[titleField.name]);
  return record?.id ? String(record.id) : '(untitled)';
}

/** @param {{capabilities?: string[]}} moduleMeta @param {string} capability */
export function hasCapability(moduleMeta, capability) {
  return Array.isArray(moduleMeta?.capabilities) && moduleMeta.capabilities.includes(capability);
}

/** Decode a single hash segment, tolerating malformed percent-encoding. */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // malformed encoding → treated as an invalid route, never a crash
  }
}

/**
 * Parse an Admin hash into a route descriptor. Pure and total: malformed
 * encoding, encoded separators and dangerous names never throw and never
 * resolve to anything but an explicit view. Decodes each segment exactly once.
 *
 * @param {string} hash — e.g. "#/modules/partner/new"
 * @returns {{view: 'dashboard'} | {view: 'invalid'} | {view: 'list'|'new'|'detail', moduleName: string, id?: string}}
 */
export function parseModuleRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  // Strip a query/extra-hash tail defensively; the Admin uses path-only hashes.
  const path = raw.split('?')[0].split('#')[0];
  const segments = path.split('/');
  if (segments[0] === '') segments.shift(); // leading slash
  if (segments.length && segments[segments.length - 1] === '') segments.pop(); // trailing slash
  const rawParts = segments;
  if (rawParts.length === 0 || rawParts[0] !== 'modules') return { view: 'dashboard' };
  // An internal empty segment (e.g. "modules//new") is malformed, not a lookup.
  if (rawParts.some((part) => part === '')) return { view: 'invalid' };
  if (rawParts.length < 2) return { view: 'dashboard' };

  const moduleName = safeDecode(rawParts[1]);
  // Module names are canonical; anything else (encoded slash, __proto__, %zz,
  // dot segments) is an invalid route, not a lookup.
  if (moduleName === null || !/^[a-z][a-z0-9-]*$/.test(moduleName)) return { view: 'invalid' };

  if (rawParts.length === 2) return { view: 'list', moduleName };
  if (rawParts.length === 3 && rawParts[2] === 'new') return { view: 'new', moduleName };
  if (rawParts.length === 3) {
    const id = safeDecode(rawParts[2]);
    if (id === null || id === '') return { view: 'invalid' };
    return { view: 'detail', moduleName, id };
  }
  return { view: 'invalid' };
}

export { IMMUTABLE_FIELDS };
