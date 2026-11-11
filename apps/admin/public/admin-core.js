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
  // backlog:33782ba68747: Agenti need the agents package's create-agent
  // operation, published in its domain block's operations list.
  const agentOps = envelope?.domains?.agents?.operations;
  const agentsAvailable = Array.isArray(agentOps) && agentOps.some((op) => op?.name === 'create-agent');
  return { pipelines, customModules, customerDataAvailable, sequencesAvailable, agentsAvailable, modulesSupported };
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
 * Read the optional `binding` query of a connector-detail hash
 * (`#/connettori/<canale>?binding=<connectionKey>`). Pure and total: only
 * a short non-empty value survives; anything else is null, and the detail
 * falls back to the first active binding. The value is compared exactly
 * against loaded rows downstream — it never becomes a request path.
 * @param {string} raw the hash without its leading `#`
 * @returns {string | null}
 */
function bindingOf(raw) {
  const tail = String(raw ?? '').split('?').slice(1).join('?').split('#')[0];
  if (tail === '') return null;
  let value = null;
  try {
    value = new URLSearchParams(tail).get('binding');
  } catch {
    return null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 1024) return null;
  return trimmed;
}

/** The paths that name the home (Oggi) besides the empty one. */
const HOME_ALIASES = new Set(['oggi', 'home', 'dashboard']);

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
  // Backlog 2a075e2d9250: #/pipeline is the natural direct link to the
  // board; it opens the first composed pipeline (pipelineName null, resolved
  // by the board like the sidebar voice) — never Oggi. A bare #/pipelines
  // stays an empty name, invalid like below.
  if (rawParts.length === 1 && rawParts[0] === 'pipeline') {
    return { view: 'pipeline', pipelineName: null };
  }
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
  // Customer data routes: #/customer-data (the Clienti list) and the old
  // profile path #/customer-data/<resource>/<id> (ADR-037). The old path
  // opens the customer scheda (backlog:6542f55ecf8d): the package-scoped
  // profile page spoke English and showed raw ids, so an old bookmark or a
  // typed URL lands on the same view as #/customer-card/<resource>/<id>.
  // Same canonical discipline as every other route here.
  if (rawParts.length && rawParts[0] === 'customer-data') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length === 1) return { view: 'customer-data' };
    if (rawParts.length !== 3) return { view: 'invalid' };
    const resource = safeDecode(rawParts[1]);
    const subjectId = safeDecode(rawParts[2]);
    if (resource === null || !/^[a-z][a-z0-9-]*$/.test(resource)) return { view: 'invalid' };
    if (subjectId === null || subjectId === '') return { view: 'invalid' };
    return { view: 'customer-card', resource, subjectId };
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
    // #/clienti alone is the natural Italian name of the Clienti list
    // (backlog:55985e25ddd2): it opens #/customer-data, never an error.
    if (rawParts.length === 1) return { view: 'customer-data' };
    if (rawParts.length === 2 && rawParts[1] === 'nuovo') return { view: 'customer-new' };
    return { view: 'invalid' };
  }
  // Customer scheda route: #/customer-card/<resource>/<id> (BO-F1-06). The
  // three-column customer view, a read-only projection over the hub. Same
  // canonical discipline as the customer-data route above.
  if (rawParts.length && rawParts[0] === 'customer-card') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 3) return { view: 'invalid' };
    const resource = safeDecode(rawParts[1]);
    const subjectId = safeDecode(rawParts[2]);
    if (resource === null || !/^[a-z][a-z0-9-]*$/.test(resource)) return { view: 'invalid' };
    if (subjectId === null || subjectId === '') return { view: 'invalid' };
    // Backlog 1e939a362c7c: an offer is not a customer — a link naming an
    // opportunity as the subject opens the offer's own page (#/offerte/<id>),
    // never «Scheda non disponibile».
    if (resource === 'opportunity') return subjectId.includes('/') ? { view: 'invalid' } : { view: 'offer-detail', offerId: subjectId };
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
  // Agents route: #/agenti (backlog:33782ba68747). One screen, same
  // canonical discipline: anything under the prefix is invalid.
  if (rawParts.length && rawParts[0] === 'agenti') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'agenti' };
  }
  if (rawParts.length && rawParts[0] === 'sequenze') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 1) return { view: 'invalid' };
    return { view: 'sequenze' };
  }
  // Offer detail route: #/offerte/<id> (backlog:ef92f728). The deal page
  // behind the pipeline card's Apri button — same canonical discipline as
  // module detail routes; anything else is invalid, not a lookup.
  if (rawParts.length && rawParts[0] === 'offerte') {
    if (rawParts.some((part) => part === '')) return { view: 'invalid' };
    if (rawParts.length !== 2) return { view: 'invalid' };
    const offerId = safeDecode(rawParts[1]);
    if (offerId === null || offerId === '' || offerId.includes('/')) return { view: 'invalid' };
    return { view: 'offer-detail', offerId };
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
    // The Stato sync yellow card names the expiring binding, not just the
    // channel (backlog:3a3e6eaf): `?binding=<connectionKey>` selects that
    // row for renewal. The key is matched exactly against the loaded rows —
    // it never becomes a request path — so an unknown or malformed value
    // falls back to the first active binding instead of failing the route.
    const binding = bindingOf(raw);
    return binding === null ? { view: 'connector-detail', channel } : { view: 'connector-detail', channel, binding };
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
  // view, never in the hash — plus the skill detail
  // #/personalizzazione/skill/<slug> (BO-F4-02). The slug is
  // grammar-checked here; catalog membership is checked by the detail view,
  // which renders an honest "unknown skill" note without ever fetching for
  // it — a hostile hash still never becomes a request path.
  if (rawParts.length && rawParts[0] === 'personalizzazione') {
    if (rawParts.length === 1) return { view: 'personalizzazione' };
    if (rawParts.length === 3 && rawParts[1] === 'skill') {
      const skill = safeDecode(rawParts[2]);
      if (skill === null || !/^[a-z][a-z0-9-]*$/.test(skill)) return { view: 'invalid' };
      return { view: 'skill-detail', skill };
    }
    return { view: 'invalid' };
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
  // Backlog 2a075e2d9250: only the home names open Oggi. Any other unknown
  // path is an honest «Questa pagina non esiste», never a silent landing on
  // Oggi that looks like the link opened the wrong screen.
  if (rawParts.length === 0 || HOME_ALIASES.has(rawParts.join('/'))) return { view: 'dashboard' };
  if (rawParts[0] !== 'modules') return { view: 'invalid' };
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
 * The customer's initials, one rule for every avatar (backlog:ff8bb60f417f:
 * the list read «UE», the scheda «UB», the scheda right after creation
 * «U?» for the same customer). First letter of the first and of the last
 * word that holds a letter — «Guido Presti» → «GP», «UX Esplorativo 1111 B»
 * → «UB» — never a «?»: a name with no letter at all reads «·».
 * @param {unknown} name
 */
export function customerInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return '·';
  const letter = (word) => word.match(/\p{L}/u)?.[0] ?? '';
  const last = words.length > 1 ? letter(words[words.length - 1]) : '';
  return `${letter(words[0])}${last}`.toUpperCase();
}

const ROME_DAY = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' });

/**
 * «20 nov 2026» for a stored day (YYYY-MM-DD) or ISO timestamp, or null when
 * absent/unparseable (Dan 06/11: dates read like a person writes them, never
 * as a raw ISO timestamp). A bare day is a calendar day and keeps its date;
 * a timestamp is an instant and reads as the Rome calendar day, so
 * `2026-08-05T22:30:00Z` is «6 ago 2026».
 * @param {unknown} value
 */
export function italianDay(value) {
  if (typeof value !== 'string' || !value) return null;
  const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const time = Date.parse(bareDay ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(time)) return null;
  return ROME_DAY.format(new Date(time)).replace('.', '');
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
/**
 * Shared rejection shape for the read and write helpers: code, status and
 * the technical message for the log, plus the log function itself. The
 * message lives on the record for plain rejections ({code, status,
 * message}), not on an Error prototype — read it there first, so the log
 * keeps the real cause instead of '[object Object]'. A message-less object
 * (e.g. a bare {status: 404}) logs as JSON, never String(object).
 * @param {unknown} error the rejection from `client.request`
 * @param {(message: string, cause: unknown) => void | null} log
 */
function normalizeFailure(error, log = null) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const status = typeof record.status === 'number' ? record.status : null;
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
  const method = typeof record.method === 'string' ? record.method.toUpperCase() : null;
  // The path without its query: the words typed in a search (customer
  // names) stay out of the console.
  const path = typeof record.path === 'string' ? record.path.split('?')[0] : null;
  return { code, status, message, method, path, report };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Tag a rejection with the request that caused it (backlog:e7bdcbcc6864):
 * the log helpers below then name a failed POST as a write, never as
 * «lettura fallita». A method/path already on the error wins; primitives
 * pass through untouched.
 * @template T
 * @param {T} error
 * @param {unknown} method
 * @param {unknown} path
 * @returns {T}
 */
export function tagRequestFailure(error, method, path) {
  if (error === null || typeof error !== 'object') return error;
  const record = /** @type {any} */ (error);
  try {
    if (typeof record.method !== 'string' && typeof method === 'string') record.method = method.toUpperCase();
    if (typeof record.path !== 'string' && typeof path === 'string') record.path = path;
  } catch {
    // A frozen rejection keeps its shape; the log just names less.
  }
  return error;
}

/**
 * One readable console line (backlog:e7bdcbcc6864, production 11/11: a 400
 * on POST /api/customer-hub/phone read «[bo] lettura fallita Object»):
 * read or write from the method, then the request, the status, the code and
 * the message as text, so the line says what failed without expanding it.
 * The object rides along for whoever opens it.
 * @param {'lettura' | 'scrittura'} fallback what the caller expected
 * @param {{ code: string, status: number | null, message: string, method: string | null, path: string | null, report: (message: string, cause: unknown) => void }} failure
 */
function reportFailure(fallback, { code, status, message, method, path, report }) {
  const kind = method === null ? fallback : (WRITE_METHODS.has(method) ? 'scrittura' : 'lettura');
  const request = method !== null && path !== null ? ` ${method} ${path}` : '';
  const outcome = [status === null ? '' : String(status), code].filter((part) => part !== '').join(' ');
  report(`[bo] ${kind} fallita${request} · ${outcome}${message !== '' ? `: ${message}` : ''}`,
    { code, status, message, method, path });
}

export function humanReadError(error, { failed, notComposed = null, log = null } = {}) {
  const failure = normalizeFailure(error, log);
  const { code, status } = failure;
  reportFailure('lettura', failure);
  if ((code === 'NOT_FOUND' || status === 404) && typeof notComposed === 'string') return notComposed;
  return failed;
}

/** The codes a gateway answers with when the server behind it never did. */
const GATEWAY_CODES = new Set(['', 'UNKNOWN', 'BAD_GATEWAY', 'SERVICE_UNAVAILABLE', 'GATEWAY_TIMEOUT']);

/** A write the server could not take right now (5xx): what happened, then what to do. */
export const SERVER_UNAVAILABLE_TEXT = 'Il server non risponde adesso, riprova tra poco.';

/**
 * Whether a failure means the write never got a usable answer from the
 * server (backlog:7cc35edab50c, production 07/11: a 502 from the /bo edge
 * read «Scrittura del pannello rifiutata», as if the panel had refused):
 * fetch rejected (a TypeError, status 0), a timeout, or a 502/503/504
 * gateway hiccup. A refusal the server really named — an LLM_* code (the
 * pilot forwards AI-off at 502), a *_CANCELLED or *_OUTCOME_UNKNOWN outcome —
 * stays a refusal, never a connection fault. So does a verdict the server
 * already named at 502/503/504 (review agent-crm#696): a failed BO write
 * (BO_SEND_FAILED, answered 502) ends the owning wait as «non inviato» and
 * a queued one (BO_*_PENDING, answered 504) is read back under its
 * requestId — neither must print «Connessione non riuscita, riprova.» and
 * invite the same POST again. The same holds for a refused body and an
 * unconfigured bridge at those statuses, and for the transient read miss
 * (BO_SEND_STATUS_FAILED): the owning flow keeps reading it back, it never
 * re-POSTs. The queued re-read (review #664) shares this line through
 * transientReadFailure, so the two cannot drift apart.
 * @param {unknown} error the rejection from `client.request`
 */
export function isNetworkFailure(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (/^LLM_/.test(code) || /_CANCELLED$/.test(code) || /_OUTCOME_UNKNOWN$/.test(code)) return false;
  const status = typeof record.status === 'number' ? record.status : null;
  if (status === 0) return true;
  if (status === null) {
    return error instanceof TypeError || /^(NETWORK|TIMEOUT|FETCH)/.test(code) || record.name === 'TimeoutError';
  }
  if (status !== 502 && status !== 503 && status !== 504) return false;
  // backlog:7d30fb517785 (production 10/11: a 503 OPERATION_APP_UNAVAILABLE
  // on the AI switch read «Connessione non riuscita»): at 502/503/504 only a
  // gateway's own generic code means «no answer». Any other code is a
  // verdict the server named, never a connection fault.
  return GATEWAY_CODES.has(code);
}

/**
 * Regola per le scritture (backlog:9046f940): una scrittura rifiutata non
 * resta mai in silenzio — vicino al comando compare un testo italiano che
 * dice cosa è successo e cosa fare. Il dettaglio tecnico va solo nel log,
 * mai nel DOM. Lo stato 405 (operazione non permessa) e il 422 (dati non
 * validi) hanno un testo proprio; tutto il resto risponde `failed`. Un
 * guasto di rete (backlog:7cc35edab50c) non è un rifiuto: risponde
 * «Connessione non riuscita, riprova.» e il comando resta a schermo per la
 * riprova, mai il testo di un rifiuto. Un 502/503/504 da gateway non è un
 * guasto di rete (backlog:7d30fb517785): il server non risponde, e il testo
 * lo dice; un codice applicativo a quegli stati risponde `failed`.
 *
 * @param {unknown} error the rejection from `client.request`
 * @param {{ failed: string, notComposed?: string|null, log?: (message: string, cause: unknown) => void }} options
 */
export function humanWriteError(error, { failed, notComposed = null, log = null } = {}) {
  const failure = normalizeFailure(error, log);
  const { code, status } = failure;
  reportFailure('scrittura', failure);
  // backlog:7d30fb517785: «Connessione non riuscita» only when the answer
  // never arrived (fetch rejected, status 0, timeout). A gateway 5xx did
  // answer: the server is the one not taking the write right now.
  if (isNetworkFailure(error)) return status !== null && status >= 500 ? SERVER_UNAVAILABLE_TEXT : 'Connessione non riuscita, riprova.';
  if ((code === 'NOT_FOUND' || status === 404) && typeof notComposed === 'string') return notComposed;
  if (status === 405 || code === 'METHOD_NOT_ALLOWED') {
    return 'Il server non permette questa operazione qui. Chiedi a un operatore di abilitare la funzione e riprova.';
  }
  if (status === 422 || code === 'VALIDATION_FAILED' || code === 'VALIDATION_ERROR') {
    return 'Alcuni dati non sono validi: controlla i campi e riprova.';
  }
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

/**
 * The error a failed API answer throws, built from its status and parsed
 * payload (`{ error: { code, message, details } }`). A 504 BO_SEND_PENDING
 * names the queued request beside the error (`requestId`, `claimId` at the
 * top level, the pilot's send route shape): both travel on the error so the
 * composer reads the same request back instead of sending again. Kept pure
 * and here, not in the shell bootstrap, so the mapping is tested.
 * @param {number} status
 * @param {any} payload the parsed JSON body, or null/undefined
 */
export function apiFailure(status, payload) {
  const error = new Error(payload?.error?.message || `Request failed (${status})`);
  Object.assign(error, {
    status,
    code: payload?.error?.code ?? 'UNKNOWN',
    details: payload?.error?.details ?? null,
  });
  if (typeof payload?.requestId === 'string' && payload.requestId !== '') Object.assign(error, { requestId: payload.requestId });
  if (typeof payload?.claimId === 'string' && payload.claimId !== '') Object.assign(error, { claimId: payload.claimId });
  return error;
}

/**
 * The request id of a queued answer the shell can read back (production
 * 07/11: the phrase POST answered 504 BO_PHRASE_PENDING after 51.9 s while
 * a GET with its requestId answered the ready draft in 0.3 s). Only the
 * one queued code the route offers counts (review #664), never any
 * `*_PENDING`: an unrelated refusal stays a refusal.
 * @param {unknown} error the rejection from `client.request`
 * @param {string} expectedCode the route's queued code, e.g. `BO_PHRASE_PENDING`
 * @returns {string | null}
 */
export function pendingRequestId(error, expectedCode) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const id = typeof record.requestId === 'string' ? record.requestId : '';
  return typeof expectedCode === 'string' && record.code === expectedCode && id !== '' ? id : null;
}

/**
 * Whether a failed read-back is worth reading again (review #664): a
 * network fault (fetch rejects with a TypeError, or status 0), a gateway or
 * server hiccup, a timeout or a rate limit. A 4xx refusal, an AI-off code
 * (the pilot forwards LLM_* at 502), a cancelled or unshapable outcome and
 * any other status-less exception (a bug, a shape error) are final — never
 * retried for a minute and passed off as «still queued».
 * @param {unknown} error
 */
function transientReadFailure(error) {
  const record = error !== null && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (/^LLM_/.test(code) || /_CANCELLED$/.test(code) || /_OUTCOME_UNKNOWN$/.test(code)) return false;
  // The network line lives in isNetworkFailure (backlog:7cc35edab50c);
  // here stay the server hiccups worth one more read.
  if (isNetworkFailure(error)) return true;
  const status = typeof record.status === 'number' ? record.status : null;
  if (status === null) return false;
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/**
 * Read a queued request back on its own path (`GET <path>?requestId=`), the
 * resume the pilot offers for its queued writes: never a second POST. Waits
 * `everyMs` before each read, up to `rounds` reads; a transient read
 * failure keeps the same request and reads again (review #664). Answers
 * `{answer}` when the request settled, `{error}` on a final refusal,
 * `{pending, requestId}` when it is still queued (or unreadable) after the
 * last read, and `{stale: true}` when the caller's view moved on meanwhile.
 * @param {{request: (path: string, options?: any) => Promise<any>}} client
 * @param {string} path the queued route, e.g. `/api/appointments/phrase`
 * @param {string} requestId the id the 504 carried
 * @param {{expectedCode: string, wait: (ms: number) => Promise<unknown>, everyMs?: number, rounds?: number, stale?: () => boolean, spaceId?: string|null}} options
 */
export async function readBackPending(client, path, requestId, { expectedCode, wait, everyMs = 3000, rounds = 20, stale = () => false, spaceId = null }) {
  let id = requestId;
  for (let round = 0; round < rounds; round += 1) {
    await wait(everyMs);
    if (stale()) return { stale: true };
    try {
      const answer = await client.request(`${path}?requestId=${encodeURIComponent(id)}`);
      if (stale()) return { stale: true };
      return { answer };
    } catch (error) {
      if (stale()) return { stale: true };
      const next = pendingRequestId(error, expectedCode);
      if (next !== null) {
        id = next;
        continue;
      }
      if (transientReadFailure(error)) {
        const record = /** @type {any} */ (error);
        console.warn('[bo] rilettura in coda non riuscita, riprovo', {
          code: typeof record?.code === 'string' ? record.code : 'UNKNOWN',
          status: typeof record?.status === 'number' ? record.status : null,
          requestId: id,
          spaceId,
        });
        continue;
      }
      // A final refusal is diagnosable (review #664): its cause, the request
      // and the space go to the log; the caller shows its Italian sentence.
      const record = /** @type {any} */ (error);
      console.warn('[bo] rilettura in coda rifiutata', {
        code: typeof record?.code === 'string' ? record.code : (error instanceof Error ? error.name : 'UNKNOWN'),
        status: typeof record?.status === 'number' ? record.status : null,
        requestId: id,
        spaceId,
      });
      return { error };
    }
  }
  return { pending: true, requestId: id };
}

/** A pause that never holds a Node process open (unref is absent in the browser). @param {number} ms */
export function unrefWait(ms) {
  return new Promise((resolve) => {
    const timer = /** @type {any} */ (setTimeout(resolve, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}
