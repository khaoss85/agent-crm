// @ts-check

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { MAX_FIELD_LENGTH, safeString } from './normalize.js';
import { canonicalPhone } from './enrichment.js';
import { recordExternalIdentityRow } from './sender.js';
import { deciding, trusted } from './store.js';

/**
 * Operator-defined customer properties (backlog:434cc39a).
 *
 * A scheda has the properties its space decided: the operator adds a field
 * once («+ Aggiungi campo»: nome, tipo testo/numero/data/sì-no/scelta) and
 * the field reads on every scheda, in the filters and in the list columns.
 * The AI way in: «✦ Scrivi o incolla» parses one Italian sentence into the
 * base customer plus custom-field proposals, shows the preview (what it
 * saves, which fields it creates), and only the human confirmation writes.
 *
 * Governing shape, mirroring enrichment/extraction:
 * - definitions are space-wide and human-decided; a value without a
 *   definition refuses with CUSTOM_FIELD_UNKNOWN, never an invented field;
 * - one row per subject and field: setting the same field again rewrites
 *   the value (an edit), so a reload reads the edit, never a second row;
 * - the phrase adapter is caller-built (the fake in tests, the OpenAI
 *   wiring where composed): the framework never holds a key. Without an
 *   adapter the preview refuses with CUSTOMER_PHRASE_AI_UNAVAILABLE and
 *   the admin hides the ✦ area instead of running anything;
 * - provider text never leaves the package: an adapter failure becomes
 *   CUSTOMER_PHRASE_AI_UNUSABLE with a fixed message, never the
 *   provider's error.
 */

/** The five field types the operator can add. */
export const CUSTOM_FIELD_TYPES = Object.freeze(['testo', 'numero', 'data', 'si-no', 'scelta']);

/** Bounds: keys are slugs, labels read on screen, values stay listable. */
export const MAX_FIELD_KEY_LENGTH = 40;
export const MAX_FIELD_LABEL_LENGTH = 60;
export const MAX_CUSTOM_VALUE_LENGTH = 500;
export const MAX_SCELTA_OPTIONS = 20;
export const MAX_SCELTA_OPTION_LENGTH = 80;
export const MAX_PHRASE_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 1000;

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SI_WORDS = new Set(['sì', 'si', 'yes', 'true', '1', 'vero']);
const NO_WORDS = new Set(['no', 'false', '0', 'falso']);

function refusal(code, status, message) {
  return new AppError(message, { code, status });
}

function requireUser(actor, what) {
  const normalized = normalizeActor(actor);
  if (normalized.type !== 'user') {
    throw new AppError(`${what} requires a human user actor`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return normalized;
}

function isUniqueConflict(error) {
  return error != null && (error.code === 'CONFLICT' || /unique|duplicate/i.test(String(error.message ?? '')));
}

/** A field key: lowercase slug, so «Amico» and «amico» are one field. */
export function normalizeFieldKey(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('a custom field needs a key or a label to key it by', { field: 'key' });
  }
  const slug = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FIELD_KEY_LENGTH);
  if (slug === '' || !KEY_RE.test(slug)) {
    throw new ValidationError('a custom field key names the field in lowercase letters, digits and dashes', { field: 'key' });
  }
  return slug;
}

function requireLabel(raw) {
  const label = safeString(raw, 'label', { max: MAX_FIELD_LABEL_LENGTH, required: true });
  if (label.length < 2) {
    throw new ValidationError('a custom field label reads on screen: at least 2 characters', { field: 'label' });
  }
  return label;
}

function requireFieldType(raw) {
  if (typeof raw !== 'string' || !CUSTOM_FIELD_TYPES.includes(raw)) {
    throw new ValidationError(`a custom field type is one of: ${CUSTOM_FIELD_TYPES.join(', ')}`, { field: 'type' });
  }
  return raw;
}

/**
 * The scelta options: a JSON array text on the row (the module vocabulary
 * holds no json type), strictly validated here — 1..20 distinct options,
 * each a short plain string. Every other type stores ''.
 */
function requireOptions(raw, fieldType) {
  if (fieldType !== 'scelta') return null;
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ValidationError('a scelta field lists its options as a JSON array', { field: 'options' });
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SCELTA_OPTIONS) {
    throw new ValidationError(`a scelta field lists 1 to ${MAX_SCELTA_OPTIONS} options`, { field: 'options' });
  }
  const seen = new Set();
  for (const option of parsed) {
    const text = safeString(option, 'options', { max: MAX_SCELTA_OPTION_LENGTH, required: true });
    if (text.length < 1) throw new ValidationError('a scelta option is never empty', { field: 'options' });
    if (seen.has(text)) throw new ValidationError(`a scelta field lists «${text}» twice`, { field: 'options' });
    seen.add(text);
  }
  return JSON.stringify([...seen]);
}

export function parseFieldOptions(row) {
  if (!row) return [];
  const fieldType = row.fieldType ?? row.type;
  if (fieldType !== 'scelta') return [];
  if (Array.isArray(row.options)) return row.options.filter((entry) => typeof entry === 'string');
  if (typeof row.options !== 'string' || row.options === '') return [];
  try {
    const parsed = JSON.parse(row.options);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The canonical stored value for one field type. Every refusal names the
 * field the operator typed: a bad value refuses the write, never a silent
 * neighbor. Stored canonical forms: testo as typed, numero without
 * formatting, data as YYYY-MM-DD, si-no as «sì»/«no», scelta as the exact
 * option.
 */
export function normalizeFieldValue(def, raw) {
  const field = typeof def?.label === 'string' && def.label !== '' ? def.label : (def?.fieldKey ?? 'campo');
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    throw new ValidationError(`«${field}» ha bisogno di un valore`, { field: 'value' });
  }
  const fieldType = def?.fieldType ?? def?.type;
  switch (fieldType) {
    case 'testo': {
      return safeString(raw, 'value', { max: MAX_CUSTOM_VALUE_LENGTH, required: true });
    }
    case 'numero': {
      const text = String(raw).trim().replace(/\s+/g, '').replace(',', '.');
      if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
        throw new ValidationError(`«${field}» vuole un numero`, { field: 'value' });
      }
      const number = Number(text);
      if (!Number.isFinite(number)) throw new ValidationError(`«${field}» vuole un numero`, { field: 'value' });
      return String(number);
    }
    case 'data': {
      const text = String(raw).trim().slice(0, 10);
      if (!DATE_RE.test(text)) {
        throw new ValidationError(`«${field}» vuole una data come 2026-11-03`, { field: 'value' });
      }
      const time = Date.parse(`${text}T00:00:00.000Z`);
      if (!Number.isFinite(time)) throw new ValidationError(`«${field}» vuole una data vera`, { field: 'value' });
      const roundTrip = new Date(time).toISOString().slice(0, 10);
      if (roundTrip !== text) throw new ValidationError(`«${field}» vuole una data vera`, { field: 'value' });
      return text;
    }
    case 'si-no': {
      const word = String(raw).trim().toLowerCase();
      if (SI_WORDS.has(word)) return 'sì';
      if (NO_WORDS.has(word)) return 'no';
      if (typeof raw === 'boolean') return raw ? 'sì' : 'no';
      throw new ValidationError(`«${field}» vuole sì o no`, { field: 'value' });
    }
    case 'scelta': {
      const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
      const options = parseFieldOptions(def);
      if (!options.includes(text)) {
        throw new ValidationError(`«${field}» vuole una delle opzioni: ${options.join(', ')}`, { field: 'value' });
      }
      return text;
    }
    default:
      throw new ValidationError('a custom field value needs a known field type', { field: 'value' });
  }
}

const defSourceKey = (key) => `custom-field-def:${key}`;
const valueSourceKey = (resource, id, key) => `custom-field-value:${resource}:${id}:${key}`;

function servicesFor(modules, names) {
  const defs = trusted(modules, names.fieldDef);
  const values = trusted(modules, names.fieldValue);
  return { defs, values };
}

async function existingDef(defs, key) {
  const rows = await deciding(defs, { sourceKey: defSourceKey(key) });
  return rows[0] ?? null;
}

/**
 * Define one space-wide field. Idempotent on the identical definition (a
 * retried «Aggiungi campo» replays the stored row); a divergent definition
 * behind the same key refuses 409, never adopts — the first decision wins.
 */
export async function defineCustomField({ modules, names }, request) {
  const actor = requireUser(request?.actor, 'Adding a custom field');
  const input = request && typeof request === 'object' ? request : {};
  const label = requireLabel(input.label);
  const key = input.key === undefined || input.key === null || String(input.key).trim() === ''
    ? normalizeFieldKey(label)
    : normalizeFieldKey(input.key);
  const fieldType = requireFieldType(input.type ?? input.fieldType);
  const options = requireOptions(input.options, fieldType);
  const { defs } = servicesFor(modules, names);

  const stored = await existingDef(defs, key);
  if (stored) {
    const same = stored.label === label && stored.fieldType === fieldType && String(stored.options ?? '') === String(options ?? '');
    if (!same) {
      throw refusal('CUSTOM_FIELD_DEFINITION_CONFLICT', 409,
        `«${stored.label}» esiste già con un altro tipo o altre opzioni: cambia chiave, non la definizione`);
    }
    return Object.freeze({ definition: shapeDef(stored), replayed: true });
  }
  let row;
  try {
    row = await defs.createManaged({
      sourceKey: defSourceKey(key), fieldKey: key, label, fieldType, options,
      createdBy: actor.id,
    }, { actor });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await existingDef(defs, key);
    if (!winner) throw error;
    const same = winner.label === label && winner.fieldType === fieldType && String(winner.options ?? '') === String(options ?? '');
    if (!same) {
      throw refusal('CUSTOM_FIELD_DEFINITION_CONFLICT', 409,
        `«${winner.label}» esiste già con un altro tipo o altre opzioni: cambia chiave, non la definizione`);
    }
    return Object.freeze({ definition: shapeDef(winner), replayed: true });
  }
  return Object.freeze({ definition: shapeDef(row), replayed: false });
}

function shapeDef(row) {
  return Object.freeze({
    key: row.fieldKey, label: row.label, type: row.fieldType,
    options: Object.freeze(parseFieldOptions(row)),
    createdBy: row.createdBy ?? null,
  });
}

export async function listCustomFieldDefs({ modules, names }) {
  const { defs } = servicesFor(modules, names);
  const rows = await deciding(defs, {});
  return Object.freeze(rows
    .map(shapeDef)
    .sort((a, b) => a.label.localeCompare(b.label, 'it')));
}

function requireSubject(request) {
  const resource = request?.resource;
  const id = request?.id;
  if ((resource !== 'contact' && resource !== 'company') || typeof id !== 'string' || id === '') {
    throw new ValidationError('a custom field value names a contact or a company that exists', { field: 'id' });
  }
  return { resource, id };
}

/**
 * Set one customer's value for one defined field. The definition owns the
 * type: an unknown key refuses, and a bad value refuses naming the field.
 * An edit rewrites the single row (updatedAt moves), so a reload reads the
 * edit and the list never doubles the customer.
 */
export async function setCustomFieldValue({ database, modules, names }, request) {
  void database;
  const actor = requireUser(request?.actor, 'Setting a custom field value');
  const input = request && typeof request === 'object' ? request : {};
  const { resource, id } = requireSubject(input);
  const key = normalizeFieldKey(input.key ?? input.fieldKey);
  const { defs, values } = servicesFor(modules, names);

  const def = await existingDef(defs, key);
  if (!def) {
    throw refusal('CUSTOM_FIELD_UNKNOWN', 404,
      'questo campo non esiste più: aggiungilo di nuovo prima di dare un valore');
  }
  const host = modules.get?.(resource)?.service ?? null;
  if (host && typeof host.get === 'function') {
    try {
      await host.get(id);
    } catch {
      throw refusal('SUBJECT_NOT_FOUND', 404,
        'la scheda di questo cliente non esiste: niente valore senza scheda');
    }
  }
  const value = normalizeFieldValue(shapeDef(def), input.value);
  const sourceKey = valueSourceKey(resource, id, key);
  const stored = await deciding(values, { sourceKey });
  if (stored[0] && stored[0].value === value) {
    return Object.freeze({ value: shapeValue(def, stored[0]), replayed: true });
  }
  let row;
  if (stored[0]) {
    row = await values.applyManaged(stored[0].id, { value, updatedBy: actor.id }, { actor });
  } else {
    try {
      row = await values.createManaged({
        sourceKey, subjectResource: resource, subjectId: id, fieldKey: key, value, updatedBy: actor.id,
      }, { actor });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const winner = (await deciding(values, { sourceKey }))[0];
      if (!winner) throw error;
      row = winner.value === value
        ? winner
        : await values.applyManaged(winner.id, { value, updatedBy: actor.id }, { actor });
    }
  }
  return Object.freeze({ value: shapeValue(def, row), replayed: stored[0]?.value === value });
}

function shapeValue(def, row) {
  const shaped = shapeDef(def);
  return Object.freeze({
    key: shaped.key, label: shaped.label, type: shaped.type,
    options: shaped.options, value: row.value,
    updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ?? null,
  });
}

/** Every defined field with this customer's value (null when never set). */
export async function readCustomFieldValues({ modules, names }, request) {
  const input = request && typeof request === 'object' ? request : {};
  const { resource, id } = requireSubject(input);
  const { defs, values } = servicesFor(modules, names);
  const definitions = await deciding(defs, {});
  const rows = await deciding(values, { subjectResource: resource, subjectId: id });
  const byKey = new Map(rows.map((row) => [row.fieldKey, row]));
  return Object.freeze(definitions
    .map(shapeDef)
    .sort((a, b) => a.label.localeCompare(b.label, 'it'))
    .map((def) => {
      const row = byKey.get(def.key) ?? null;
      return Object.freeze({
        ...def,
        value: row?.value ?? null,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      });
    }));
}

/**
 * «✦ Scrivi o incolla»: one Italian sentence into a customer draft plus
 * custom-field proposals. The adapter answers
 * `extractCustomer({ text, knownFields })` with the base customer, an
 * optional note, and field proposals that either name an existing key or
 * carry a label and a type for a field to create. Writes nothing: the
 * preview names every new field it would create, and only the human
 * confirmation (apply) stores.
 */
export async function parseCustomerPhrase({ modules, names, phraseLlm }, request) {
  const actor = requireUser(request?.actor, 'Parsing a customer phrase');
  const input = request && typeof request === 'object' ? request : {};
  const phrase = safeString(input.phrase, 'phrase', { max: MAX_PHRASE_LENGTH, required: true });
  if (phrase.length < 3) {
    throw new ValidationError('la frase dice troppo poco: scrivi almeno nome e un contatto', { field: 'phrase' });
  }
  const adapter = input.adapter ?? phraseLlm ?? null;
  if (!adapter || typeof adapter.extractCustomer !== 'function') {
    throw refusal('CUSTOMER_PHRASE_AI_UNAVAILABLE', 503,
      'l\u2019AI non è attiva per questo spazio: compila i campi a mano');
  }
  const definitions = await listCustomFieldDefs({ modules, names });
  const knownFields = definitions.map((def) => ({
    key: def.key, label: def.label, type: def.type, options: [...def.options],
  }));
  let answer;
  try {
    answer = await adapter.extractCustomer({ text: phrase, knownFields });
  } catch {
    throw refusal('CUSTOMER_PHRASE_AI_UNUSABLE', 503,
      'l\u2019AI non ha capito la frase: compila i campi a mano');
  }
  return shapePhrasePreview(definitions, answer, actor);
}

function shapePhrasePreview(definitions, answer, actor) {
  void actor;
  const raw = answer && typeof answer === 'object' ? answer : {};
  const customer = {
    firstName: safeString(raw.firstName, 'firstName') ?? null,
    lastName: safeString(raw.lastName, 'lastName') ?? null,
    email: emailOrNull(raw.email),
    phone: phoneOrNull(raw.phone),
    companyName: safeString(raw.companyName, 'companyName') ?? null,
  };
  const note = safeString(raw.note, 'note', { max: MAX_NOTE_LENGTH }) ?? null;
  const byKey = new Map(definitions.map((def) => [def.key, def]));
  const proposals = [];
  const seen = new Set();
  const proposed = Array.isArray(raw.fields) ? raw.fields : [];
  for (const entry of proposed) {
    if (!entry || typeof entry !== 'object') continue;
    const hasKey = typeof entry.key === 'string' && entry.key.trim() !== '';
    const key = hasKey ? normalizeFieldKey(entry.key) : normalizeFieldKey(entry.label);
    if (seen.has(key)) continue;
    seen.add(key);
    const known = byKey.get(key) ?? null;
    if (known) {
      proposals.push(Object.freeze({
        key, label: known.label, type: known.type, options: known.options,
        value: normalizeFieldValue(known, entry.value), isNew: false,
      }));
      continue;
    }
    const label = requireLabel(entry.label);
    const type = requireFieldType(entry.type);
    const options = requireOptions(entry.options, type);
    proposals.push(Object.freeze({
      key, label, type, options: Object.freeze(parseFieldOptions({ fieldType: type, options })),
      value: normalizeFieldValue({ fieldKey: key, label, type, options: parseFieldOptions({ fieldType: type, options }) }, entry.value),
      isNew: true,
    }));
  }
  return Object.freeze({
    customer: Object.freeze(customer),
    note,
    fields: Object.freeze(proposals),
    newFields: proposals.filter((proposal) => proposal.isNew).length,
  });
}

function emailOrNull(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new ValidationError('l\u2019AI ha letto un\u2019email che non torna: correggila a mano', { field: 'email' });
  }
  return text;
}

function phoneOrNull(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const canonical = canonicalPhone(String(raw).trim());
  if (canonical === null) {
    throw new ValidationError('l\u2019AI ha letto un telefono che non torna: correggilo a mano', { field: 'phone' });
  }
  return canonical;
}

/**
 * Apply the human-confirmed phrase: create (or match) the customer through
 * the same governed import-apply, hold the phone beside it when the phrase
 * carried one, define the new fields, set every value. The note is NOT
 * written here: the caller posts it to the existing subject-note endpoint,
 * so the cronologia keeps its single writer. Without an identity (neither
 * an email nor a company) the apply refuses before creating anything.
 */
/**
 * Link the phrase phone beside the confirmed customer (backlog:434cc39a).
 * An E.164 number goes through the governed phone operation the manual
 * form uses — same dialability gate, same held-elsewhere refusal, same
 * race safety. A shorter local number the card cannot dial is still
 * stored under the recognized 'phone' system (never an invented one), so
 * the list and the scheda show it without offering a dead «Chiama» link.
 * A number held beside another customer is never moved: false, and the
 * caller warns. Best-effort beside a stored customer: throws only on
 * storage failure, which the caller turns into the same warning.
 */
async function linkPhrasePhone({ modules, names, importOperations }, actor, subject, phone, runId) {
  if (/^\+[1-9]\d{6,14}$/.test(phone)) {
    // Twin of the E.164 gate in recordSubjectPhone: the same numbers the
    // governed operation would take go through it, never around it.
    const linked = await importOperations.recordSubjectPhone({
      actor, resource: subject.resource, id: subject.id, phone,
    });
    return linked?.outcome === 'linked' || linked?.outcome === 'refreshed';
  }
  const identities = trusted(modules, names.identity);
  const sourceKey = `phone:${phone}`;
  const seen = (await deciding(identities, { sourceKey }))[0] ?? null;
  if (seen !== null
    && (seen.subjectResource !== subject.resource || String(seen.subjectId ?? '') !== String(subject.id))) {
    return false;
  }
  const outcome = await recordExternalIdentityRow({
    modules, names, system: 'phone', externalId: phone, subject, runId, actor,
  });
  return outcome === 'linked' || outcome === 'refreshed';
}

export async function applyCustomerPhrase({ database, modules, core, names, importOperations }, request) {
  const actor = requireUser(request?.actor, 'Applying a customer phrase');
  void core;
  if (!database || typeof database.transactionAsync !== 'function') {
    throw new ValidationError('applying a customer phrase needs the database handle for its single transaction', { field: 'database' });
  }
  const input = request && typeof request === 'object' ? request : {};
  const customer = input.customer && typeof input.customer === 'object' ? input.customer : {};
  const firstName = safeString(customer.firstName, 'firstName', { required: true });
  const lastName = safeString(customer.lastName, 'lastName') ?? null;
  const email = customer.email === undefined || customer.email === null || String(customer.email).trim() === ''
    ? null
    : emailOrNull(customer.email);
  const companyName = customer.companyName === undefined || customer.companyName === null
    || String(customer.companyName).trim() === '' ? null : safeString(customer.companyName, 'companyName');
  const phone = customer.phone === undefined || customer.phone === null || String(customer.phone).trim() === ''
    ? null
    : phoneOrNull(customer.phone);
  if (email === null && companyName === null) {
    throw new ValidationError('dalla frase non si capisce chi è il cliente: aggiungi almeno l\u2019email o l\u2019azienda', { field: 'customer' });
  }
  const fields = Array.isArray(input.fields) ? input.fields : [];
  if (fields.length > 50) {
    throw new ValidationError('one phrase carries at most 50 custom fields', { field: 'fields' });
  }

  const row = { firstName };
  if (lastName !== null) row.lastName = lastName;
  if (email !== null) row.email = email;
  if (companyName !== null) row.companyName = companyName;
  // One enclosing transaction for the customer, its definitions and its
  // values: any refusal — a bad value, a divergent definition raced in
  // after the preview — rolls everything back, never a partial apply.
  // The phone link stays outside on purpose: it is best-effort beside an
  // already stored customer, through the same governed phone operation the
  // manual form uses (system 'phone', E.164, race-safe), and a
  // held-elsewhere number warns instead of undoing the confirmed customer.
  const confirmed = await database.transactionAsync(async () => {
    const applied = await importOperations.applyCustomerImportInTransaction({
      actor, system: 'frase-cliente', rows: [row], acceptance: 'partial',
    });
    const receipt = applied?.receipt?.receipts?.[0] ?? null;
    const subject = receipt?.subject ?? null;
    if (receipt?.outcome !== 'accepted' || !subject?.id) {
      throw refusal('CUSTOMER_PHRASE_CUSTOMER_REFUSED', 409,
        'il cliente della frase non si è potuto creare: correggi i campi e riprova');
    }

    const stored = [];
    for (const entry of fields) {
      if (!entry || typeof entry !== 'object') continue;
      const key = normalizeFieldKey(entry.key);
      const defined = await defineCustomField({ modules, names }, {
        actor, key,
        label: entry.label,
        type: entry.type ?? entry.fieldType,
        options: entry.options,
      });
      const set = await setCustomFieldValue({ modules, names }, {
        actor, resource: subject.resource, id: subject.id, key, value: entry.value,
      });
      stored.push(Object.freeze({ ...set.value, isNew: !defined.replayed }));
    }
    return { subject, receipt, stored, runId: applied.runId };
  });

  // The phone rides beside the confirmed customer, never inside its
  // transaction: a held-elsewhere number warns instead of undoing the
  // customer. An E.164 number goes through the governed phone operation
  // the manual form uses (same checks, same race safety); a short or
  // local number the card cannot dial is still stored under the
  // recognized 'phone' system — visible in the list and on the scheda,
  // just never a «Chiama» link — so the confirmed value is never lost.
  let phoneLinked = false;
  let phoneWarning = null;
  if (phone !== null && email !== null) {
    try {
      phoneLinked = await linkPhrasePhone(
        { modules, names, importOperations },
        actor, confirmed.subject, phone, confirmed.runId,
      );
      if (!phoneLinked) phoneWarning = 'il telefono non si è collegato: aggiungilo dalla scheda';
    } catch {
      phoneWarning = 'il telefono non si è collegato: aggiungilo dalla scheda';
    }
  } else if (phone !== null) {
    phoneWarning = 'senza email il telefono non si collega: aggiungilo dalla scheda';
  }

  return Object.freeze({
    subject: Object.freeze({ resource: confirmed.subject.resource, id: confirmed.subject.id }),
    matchedExisting: confirmed.receipt?.reasonCode === 'MATCHED_EXISTING',
    phoneLinked,
    phoneWarning,
    fields: Object.freeze(confirmed.stored),
  });
}

/** The probe the admin uses to show the ✦ area only when the AI is on. */
export async function customerPhraseAiAvailable({ phraseLlm }) {
  return Object.freeze({ available: Boolean(phraseLlm && typeof phraseLlm.extractCustomer === 'function') });
}

export const CUSTOM_FIELD_LIMITATIONS = Object.freeze([
  'definitions are space-wide: one field serves every scheda, every filter and every list column',
  'a value without a definition refuses: the framework never invents a field from a value',
  'an AI proposal writes nothing: only the human confirmation stores, through the same governed paths as the manual form',
  'the apply writes the customer, its phone and its field values, never the note: the cronologia keeps its single writer (POST /api/customer-hub/notes)',
]);
