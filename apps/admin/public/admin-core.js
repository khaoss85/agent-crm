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
    case 'reference':
      return {
        ...base,
        control: 'reference',
        targetModule: typeof field.targetModule === 'string' ? field.targetModule : null,
        targetDisplayField: typeof field.targetDisplayField === 'string' ? field.targetDisplayField : 'id',
      };
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

/**
 * Fields a user may set through create/update. Immutable fields (id, timestamps)
 * and workflow-managed fields (writable: 'managed', e.g. a lifecycle status set
 * only by an action) are excluded — the latter are shown read-only and changed
 * only through actions, never a generic form.
 *
 * @param {{fields?: Array<{name: string, writable?: string}>}} moduleMeta
 */
export function editableFields(moduleMeta) {
  const fields = Array.isArray(moduleMeta?.fields) ? moduleMeta.fields : [];
  return fields.filter((field) => !IMMUTABLE_FIELDS.includes(field.name) && field.writable !== 'managed');
}

/**
 * Fields that exist but are not user-editable because a workflow action owns
 * them (writable: 'managed'). Rendered read-only on the detail view so the
 * lifecycle state is visible without being editable.
 *
 * @param {{fields?: Array<{name: string, writable?: string}>}} moduleMeta
 */
export function managedFields(moduleMeta) {
  const fields = Array.isArray(moduleMeta?.fields) ? moduleMeta.fields : [];
  return fields.filter((field) => !IMMUTABLE_FIELDS.includes(field.name) && field.writable === 'managed');
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
 * Read the shell nav inputs from a `/api/schema` envelope (backlog:42fd49b8).
 * The same sniffing the shell runs after the schema arrives, in one pure,
 * unit-tested place instead of inline in the router: pipelines from the
 * code-first registry block, generated modules from their contract block,
 * Clienti from the customer-data domain block (the contract travels at the
 * top level of the domain block since the registry merge; `.metadata` is
 * kept as the legacy path). A block that is absent means "not composed":
 * the voice stays disabled with its story, never a link to a blank screen.
 *
 * @param {any} envelope
 */
export function shellNavInput(envelope) {
  const pipelines = envelope?.pipelineContract === 1 && Array.isArray(envelope?.pipelines)
    ? envelope.pipelines
    : [];
  const { supported: modulesSupported, modules: customModules } = selectGeneratedModules(envelope);
  const customerData = envelope?.domains?.['customer-data'];
  const customerDataAvailable = customerData?.metadata?.customerDataContract === 1
    || customerData?.customerDataContract === 1;
  const sequencesAvailable = envelope?.domains?.sequences?.sequencesContract === 1;
  return { pipelines, customModules, customerDataAvailable, sequencesAvailable, modulesSupported };
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
 * @returns {{view: 'dashboard'} | {view: 'invalid'} | {view: 'catalog'} | {view: 'list'|'new'|'detail', moduleName: string, id?: string}}
 */
export function parseModuleRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  // Strip a query/extra-hash tail defensively; the Admin uses path-only hashes.
  const path = raw.split('?')[0].split('#')[0];
  const segments = path.split('/');
  if (segments[0] === '') segments.shift(); // leading slash
  if (segments.length && segments[segments.length - 1] === '') segments.pop(); // trailing slash
  const rawParts = segments;
  // Pipeline board routes: #/pipelines/<name> (ADR-014). Same canonical-name
  // discipline as module routes; anything else is invalid, not a lookup.
  if (rawParts.length && rawParts[0] === 'pipelines') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const pipelineName = safeDecode(rawParts[1]);
    if (pipelineName === null || !/^[a-z][a-z0-9-]*$/.test(pipelineName)) return { view: 'invalid' };
    return { view: 'pipeline', pipelineName };
  }
  // Production Spine (ADR-038): one route, #/spine. Identity, tenancy and
  // authorization are a single screen — there is nothing to drill into,
  // because there is no credential to show.
  if (rawParts.length === 1 && rawParts[0] === 'spine') return { view: 'spine' };
  // Customer data routes: #/customer-data and #/customer-data/<resource>/<id>
  // (ADR-037). Same canonical discipline as every other route here.
  if (rawParts.length && rawParts[0] === 'customer-data') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 1) return { view: 'customer-data' };
    if (rawParts.length !== 3) return { view: 'invalid' };
    const resource = safeDecode(rawParts[1]);
    const subjectId = safeDecode(rawParts[2]);
    if (resource === null || !/^[a-z][a-z0-9-]*$/.test(resource)) return { view: 'invalid' };
    if (subjectId === null || subjectId === '') return { view: 'invalid' };
    return { view: 'customer-profile', resource, subjectId };
  }
  // Customer import route: #/import-clienti (backlog:80b25fb0). The governed
  // JSON import and quality queues live here, not below the Clienti table:
  // the prototype's Clienti screen carries no import tool.
  if (rawParts.length && rawParts[0] === 'import-clienti') {
    if (rawParts.some((part) => part === '') || rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'customer-import' };
  }
  // New customer form: #/clienti/nuovo (backlog:273de560). "Compila
  // manualmente" opens a customer form here, not the JSON import tool:
  // the prototype's Clienti screen carries no import tool, and the import
  // stays a separate tool on #/import-clienti.
  if (rawParts.length && rawParts[0] === 'clienti') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 2 && rawParts[1] === 'nuovo') return { view: 'customer-new' };
    return { view: 'invalid' };
  }
  // Customer scheda route: #/customer-card/<resource>/<id> (BO-F1-06). The
  // three-column customer view, a read-only projection over the hub. Same
  // canonical discipline as the profile route above.
  if (rawParts.length && rawParts[0] === 'customer-card') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 3) return { view: 'invalid' };
    const resource = safeDecode(rawParts[1]);
    const subjectId = safeDecode(rawParts[2]);
    if (resource === null || !/^[a-z][a-z0-9-]*$/.test(resource)) return { view: 'invalid' };
    if (subjectId === null || subjectId === '') return { view: 'invalid' };
    return { view: 'customer-card', resource, subjectId };
  }
  // Product catalog routes: #/catalogo (BO-F2-05). The backoffice product
  // table with its source summary. Same canonical discipline as every other
  // route here; anything else under the prefix is invalid, not a lookup.
  if (rawParts.length && rawParts[0] === 'catalogo') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'catalog' };
  }
  // Component catalog route: #/componenti (BO-F6-02). The visual-system
  // catalog with demo data: static content, no fetch, no writes. Same
  // canonical discipline as every other route here.
  if (rawParts.length && rawParts[0] === 'componenti') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'componenti' };
  }
  // Sequences route: #/sequenze (BO-F3-03). One screen: the elenco with the
  // dettaglio of the selected sequence. Same canonical discipline as every
  // other route here; anything else under the prefix is invalid, not a
  // lookup, so a hostile hash never becomes a request path.
  if (rawParts.length && rawParts[0] === 'sequenze') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'sequenze' };
  }
  // Quote builder routes: #/quotes and #/quotes/<id> (ADR-016). Same
  // canonical discipline; anything else is invalid, not a lookup.
  if (rawParts.length && rawParts[0] === 'quotes') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 1) return { view: 'quotes' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const quoteId = safeDecode(rawParts[1]);
    if (quoteId === null || quoteId === '' || quoteId.includes('/')) return { view: 'invalid' };
    return { view: 'quote-detail', quoteId };
  }
  // Work routes: #/work and #/work/<id> (Work v1, ADR-030). Same canonical
  // discipline as every other route above; anything else is invalid, not a
  // lookup, so a hostile hash never becomes a request path.
  if (rawParts.length && rawParts[0] === 'work') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 1) return { view: 'work' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const taskId = safeDecode(rawParts[1]);
    if (taskId === null || taskId === '' || taskId.includes('/')) return { view: 'invalid' };
    return { view: 'work-task', taskId };
  }
  // Marketing routes: #/marketing and #/marketing/<id> (MK1). Same canonical
  // discipline as every other route above; anything else is invalid, not a
  // lookup, so a hostile hash never becomes a request path.
  if (rawParts.length && rawParts[0] === 'marketing') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 1) return { view: 'marketing' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const proposalId = safeDecode(rawParts[1]);
    if (proposalId === null || proposalId === '' || proposalId.includes('/')) return { view: 'invalid' };
    return { view: 'marketing-proposal', proposalId };
  }
  // Connectors route: #/connettori (BO-F1-02). One screen — the wizard state
  // lives in the view, never in the hash — plus the connector detail
  // #/connettori/<canale> (BO-F5-03). The slug is grammar-checked here;
  // catalog membership is checked by the detail view, which renders an
  // honest "unknown connector" note without ever fetching for it — a hostile
  // hash still never becomes a request path.
  if (rawParts.length && rawParts[0] === 'connettori') {
    if (rawParts.length === 1) return { view: 'connectors' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const channel = safeDecode(rawParts[1]);
    if (channel === null || !/^[a-z][a-z0-9-]*$/.test(channel)) return { view: 'invalid' };
    return { view: 'connector-detail', channel };
  }
  // Reporting and "+ Nuovo modulo" routes (BO-F5-01, docs/BUNDLES.md). One
  // screen each, same canonical discipline as every other route here: the
  // wizard state (AI vs manuale) lives in the view, never in the hash.
  if (rawParts.length && rawParts[0] === 'reporting') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'reporting' };
  }
  if (rawParts.length && rawParts[0] === 'nuovo-modulo') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'nuovo-modulo' };
  }
  // Team calendar route: #/calendario (BO-F3 \"07 Calendario\"). One screen —
  // the week, the phrase draft, the slot proposals and the manual form live
  // in the view, never in the hash — so any deeper path is invalid.
  if (rawParts.length && rawParts[0] === 'calendario') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'calendario' };
  }
  // Personalizzazione route: #/personalizzazione (BO-F4-01). One screen with
  // its own tabs, like the connectors route above — tab state lives in the
  // view, never in the hash — so any deeper path is invalid, not a lookup.
  if (rawParts.length && rawParts[0] === 'personalizzazione') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'personalizzazione' };
  }
  // Spazi e accessi route: #/spazi-accessi (BO-F0-06). One screen — spaces,
  // team, AI switches — reached from Impostazioni; any deeper path is
  // invalid, not a lookup, like every route above.
  // Profilo route: #/profilo (design pass 8). One screen — the person and
  // their Google connections — so any deeper path is invalid.
  if (rawParts.length && rawParts[0] === 'profilo') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'profilo' };
  }
  if (rawParts.length && rawParts[0] === 'spazi-accessi') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'spazi-accessi' };
  }
  // Stato sync route: #/stato-sync (BO-F1-03). One screen — the indicator,
  // the fix list and the channel table — so any deeper path is invalid, not
  // a lookup. A hostile hash still never becomes a request path.
  if (rawParts.length && rawParts[0] === 'stato-sync') {
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'sync' };
  }
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

/**
 * Deterministic minor-units money formatting: `500000, 'EUR'` → `"EUR 5,000.00"`.
 * Grouping and decimals are computed, never taken from browser locale, so
 * tests and servers render identically. Currencies are NEVER summed together
 * by callers — totals are per-currency by contract.
 *
 * Contract (documented, deliberately narrow): every stored amount is defined
 * as 1/100 currency units and always renders with two decimals. This is NOT
 * universal ISO-4217 minor-unit support — zero-decimal (JPY) and
 * three-decimal (KWD) exponents are not modeled; a JPY amount stored as
 * "hundredths of a yen" renders as such. A per-currency exponent map is
 * deliberately out of scope until a real brief needs it.
 *
 * @param {number} minorUnits @param {string} currency
 */
export function formatMinorUnits(minorUnits, currency) {
  if (!Number.isSafeInteger(minorUnits)) return '—';
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${String(currency ?? '')} ${sign}${grouped}.${cents}`.trim();
}

/**
 * Amount for the Italian screens, the way the prototype writes it:
 * `27.120 €`, `1.200,50 €`, `25 USD`. Dot groups thousands, comma marks the
 * cents and the cents show only when they are not zero; EUR is written `€`,
 * every other currency keeps its code. Computed, never browser-locale, so
 * tests and servers agree. Same 1/100-unit contract as formatMinorUnits,
 * which stays the exact machine form for exports and logs.
 *
 * @param {number} minorUnits @param {string} currency
 */
export function formatAmount(minorUnits, currency) {
  if (!Number.isSafeInteger(minorUnits)) return '—';
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = abs % 100;
  const number = cents === 0 ? whole : `${whole},${String(cents).padStart(2, '0')}`;
  const code = String(currency ?? '').trim();
  const unit = code === 'EUR' ? '€' : code;
  return `${sign}${number} ${unit}`.trim();
}

/**
 * Regola per tutte le schermate (backlog:9da124e5): un errore tecnico non si
 * mostra mai al cliente — niente codici (`NOT_FOUND`), niente nomi di
 * pacchetti (`space-permissions`), niente comandi (`npm run …`), niente
 * percorsi (`docs/…`). Ogni lettura fallita risponde un testo umano con un
 * invito a riprovare; il dettaglio tecnico va solo nel log, mai nel DOM.
 *
 * @param {unknown} error the rejection from `client.request`
 * @param {{ failed: string, notComposed?: string|null, log?: (message: string, cause: unknown) => void }} options
 *   `failed`: the human text for a generic failure. `notComposed`: the human
 *   text when the backend answers 404/NOT_FOUND for a missing composition
 *   (a distinct state: retrying cannot help, enabling can). Without it a
 *   404 also answers `failed`.
 */
export function humanReadError(error, { failed, notComposed = null, log = null } = {}) {
  const record = error !== null && typeof error === 'object' ? error : {};
  const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const status = typeof record.status === 'number' ? record.status : null;
  // A plain rejection object ({code, status, message}) carries the message on
  // the record, not on an Error prototype: read it there first, so the log
  // keeps the real cause instead of '[object Object]'. A message-less object
  // (e.g. a bare {status: 404}) logs as JSON, never String(object).
  const message = typeof record.message === 'string' && record.message !== ''
    ? record.message
    : (error instanceof Error
      ? error.message
      : (error !== null && typeof error === 'object' ? JSON.stringify(error) : String(error ?? '')));
  const report = typeof log === 'function'
    ? log
    : (typeof console !== 'undefined' && typeof console.error === 'function'
      ? (text, cause) => console.error(text, cause)
      : () => {});
  report('[bo] lettura fallita', { code, status, message });
  if ((code === 'NOT_FOUND' || status === 404) && typeof notComposed === 'string') return notComposed;
  return failed;
}

/**
 * Whether a read failure means "not composed here" (404/NOT_FOUND) rather
 * than a transient failure. Views keep their own human texts; this only
 * shares the predicate so the branches cannot drift apart.
 * @param {unknown} error the rejection from `client.request`
 */
export function isNotComposedFailure(error) {
  const record = error !== null && typeof error === 'object' ? error : {};
  return record.code === 'NOT_FOUND' || record.status === 404;
}

/**
 * Whether a read failure means "this Admin is older than the schema it
 * reads" (UNSUPPORTED_CONTRACT) rather than a transient failure. Like the
 * not-composed state, retrying cannot help — the Admin bundle needs an
 * update — so views answer a distinct human text with no Retry.
 * @param {unknown} error the rejection from `client.request` or the schema guard
 */
export function isUnsupportedContractFailure(error) {
  const record = error !== null && typeof error === 'object' ? error : {};
  return record.code === 'UNSUPPORTED_CONTRACT';
}

/**
 * Italian labels for the import receipts (backlog:273de560). The outcome and
 * reason code sets are finite and server-declared; an unknown value renders
 * as stored, never as a blank. The free-text server reason stays as-is: it
 * is per-row diagnostic content, and translating it in the browser would be
 * a guess, not a label.
 */
const CUSTOMER_IMPORT_OUTCOME_LABELS = Object.freeze({
  accepted: 'accettata',
  rejected: 'scartata',
  skipped: 'da decidere',
});

/** @param {unknown} outcome */
export function customerImportOutcomeLabel(outcome) {
  const label = CUSTOMER_IMPORT_OUTCOME_LABELS[String(outcome ?? '')];
  return typeof label === 'string' ? label : String(outcome ?? '');
}

const CUSTOMER_IMPORT_REASON_LABELS = Object.freeze({
  MATCHED_EXISTING: 'scheda esistente ritrovata',
  CREATED_RECORD: 'scheda creata',
  AMBIGUOUS_CANDIDATES: 'schede simili da decidere',
  INVALID_EMAIL: 'email non valida',
  INVALID_DOMAIN: 'dominio non valido',
  MISSING_REQUIRED_IDENTITY: 'manca chi è: serve email o azienda',
  UNSAFE_VALUE: 'valore non ammesso',
  DUPLICATE_WITHIN_BATCH: 'doppione nella stessa importazione',
});

/** @param {unknown} code */
export function customerImportReasonLabel(code) {
  const label = CUSTOMER_IMPORT_REASON_LABELS[String(code ?? '')];
  return typeof label === 'string' ? label : String(code ?? '');
}

/** Italian resource words for the candidate pairs; unknown modules read raw. */
const CUSTOMER_RESOURCE_LABELS = Object.freeze({
  contact: 'contatto',
  company: 'azienda',
});

/** @param {unknown} resource */
export function customerResourceLabel(resource) {
  const label = CUSTOMER_RESOURCE_LABELS[String(resource ?? '')];
  return typeof label === 'string' ? label : String(resource ?? '');
}

/** Italian kind words for the data-quality queue; unknown kinds read raw. */
const CUSTOMER_ISSUE_KIND_LABELS = Object.freeze({
  missing_required_identity: 'manca chi è',
  conflicting_external_identity: 'identità esterna in conflitto',
  identity_conflict_windowed_scope: 'conflitto di identità',
  invalid_email: 'email non valida',
  invalid_domain: 'dominio non valido',
  duplicate_candidate_open: 'possibile doppione aperto',
  orphaned_reference: 'riferimento orfano',
  unresolved_import_row: 'riga importata da decidere',
});

/** @param {unknown} kind */
export function customerIssueKindLabel(kind) {
  const label = CUSTOMER_ISSUE_KIND_LABELS[String(kind ?? '')];
  return typeof label === 'string' ? label : String(kind ?? '');
}

/**
 * The deferred-track line in Italian (backlog:273de560): the import screen
 * is an operator tool, not a developer surface, so the program name and its
 * roadmap items read in Italian. Unknown tracks or items render as stored,
 * never as a blank.
 * @param {{track?: unknown, items?: unknown}} [deferred]
 */
export function customerDataDeferredLine(deferred) {
  const trackLabels = Object.freeze({ 'Customer Data Operations v2': 'strumenti dati futuri' });
  const itemLabels = Object.freeze({
    'global search': 'ricerca globale',
    'saved views': 'viste salvate',
    'physical merge': 'unione delle schede',
    'physical merge or consolidation': 'unione delle schede',
    'retention and erasure workflow': 'conservazione e cancellazione',
  });
  const rawItems = Array.isArray(deferred?.items) ? deferred.items : [];
  const items = rawItems.map((item) => {
    const label = itemLabels[String(item ?? '')];
    return typeof label === 'string' ? label : String(item ?? '');
  });
  const track = trackLabels[String(deferred?.track ?? '')] ?? null;
  if (items.length === 0) {
    return track === null ? 'Altri strumenti in arrivo.' : `Altri strumenti in arrivo (${track}).`;
  }
  return `Altri strumenti in arrivo: ${items.join(', ')}.`;
}

export { IMMUTABLE_FIELDS };
