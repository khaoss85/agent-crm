// @ts-check

/**
 * Campi personalizzati della scheda (backlog:434cc39a): the shared client
 * and control layer the three admin surfaces use — Nuovo cliente (the ✦
 * area, the manual custom inputs, + Aggiungi campo, the note), the scheda
 * (read, edit, + Aggiungi campo) and the list (campo/valore filter, custom
 * columns). Every write goes through the governed framework routes; the AI
 * adapter is the server composition's, so without it the ✦ area hides and
 * the manual path works alone.
 */

export const CUSTOM_FIELD_TYPES = Object.freeze(['testo', 'numero', 'data', 'si-no', 'scelta']);

export const CUSTOM_FIELD_TYPE_LABELS = Object.freeze({
  testo: 'Testo',
  numero: 'Numero',
  data: 'Data',
  'si-no': 'Sì/No',
  scelta: 'Scelta',
});

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * The list a read answers: the bare array the framework route returns, or
 * the array under `field` of an enveloped answer. The array check comes
 * first on purpose (production 07/11): `answer.values` on a bare array is
 * `Array.prototype.values`, a function, so `answer?.values ?? answer` read
 * every saved value as an empty list and the scheda showed «—».
 * @param {unknown} answer @param {string[]} fields
 */
function listFrom(answer, fields) {
  if (Array.isArray(answer)) return answer;
  if (!answer || typeof answer !== 'object') return [];
  for (const field of fields) {
    const entry = /** @type {any} */ (answer)[field];
    if (Array.isArray(entry)) return entry;
  }
  return [];
}

/** Every defined field of the space, `[]` on an older server without the route. */
export async function fetchFieldDefs(client) {
  try {
    const answer = await client.request('/api/customer-data/fields');
    return listFrom(answer, ['definitions', 'fields']);
  } catch (error) {
    if (error && (error.status === 404 || error?.code === 'NOT_FOUND')) return [];
    throw error;
  }
}

/** Define one space-wide field. */
export async function defineField(client, { label, key, type, options }) {
  const body = { label, type };
  if (key !== undefined && key !== null && String(key).trim() !== '') body.key = key;
  if (options !== undefined) body.options = options;
  return client.request('/api/customer-data/fields/define', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Every defined field with this customer's value (`value: null` when never set). */
export async function fetchFieldValues(client, resource, id) {
  try {
    const answer = await client.request(
      `/api/customer-data/fields/values?resource=${encodeURIComponent(resource)}&id=${encodeURIComponent(id)}`,
    );
    return listFrom(answer, ['values']);
  } catch (error) {
    if (error && (error.status === 404 || error?.code === 'NOT_FOUND')) return [];
    throw error;
  }
}

/** Set one customer's value for one defined field. */
export async function saveFieldValue(client, { resource, id, key, value }) {
  return client.request('/api/customer-data/fields/value', {
    method: 'POST',
    body: JSON.stringify({ resource, id, key, value }),
  });
}

/** The probe: `true` only when the server composition carries the AI adapter. */
export async function phraseAiAvailable(client) {
  try {
    const answer = await client.request('/api/customer-data/phrase/ai-available');
    return answer?.available === true;
  } catch {
    return false;
  }
}

/** Preview one sentence: writes nothing, names every field it would create. */
export async function previewPhrase(client, phrase) {
  return client.request('/api/customer-data/phrase/preview', {
    method: 'POST',
    body: JSON.stringify({ phrase }),
  });
}

/** Store the human-confirmed phrase: the customer, its phone and its values. */
export async function applyPhrase(client, { customer, fields }) {
  return client.request('/api/customer-data/phrase/apply', {
    method: 'POST',
    body: JSON.stringify({ customer, fields }),
  });
}

/**
 * Post one note through the single writer (POST /api/customer-hub/notes),
 * so the Nuovo cliente note lands in the cronologia. Throws nothing: a
 * refused note warns, never blocks the created customer.
 */
export async function postSubjectNote(client, { resource, id, text }) {
  // Exactly the scheda's «Aggiungi nota» shape: the note travels as `body`
  // (the framework's record-subject-note input). `text` was refused by the
  // /bo edge (400 BO_CRM_BODY_REFUSED, production 07/11) and by the
  // framework itself, so every Nuovo cliente note was lost.
  // The Nuovo cliente field is a textarea, while the scheda writes from a
  // single-line input: a line break would refuse the whole note (400, the
  // framework's safe text allows no control characters), so breaks fold to
  // a space. Text without them travels byte-identical.
  const body = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ') : text;
  return client.request('/api/customer-hub/notes', {
    method: 'POST',
    body: JSON.stringify({ resource, id, body }),
  });
}

/** Italian display of one stored value; `null` when never set. */
export function formatCustomValue(def, value) {
  if (value === null || value === undefined || String(value) === '') return null;
  if ((def?.type ?? def?.fieldType) === 'si-no') {
    const word = siNoWord(value);
    return word === '' ? String(value) : word;
  }
  return String(value);
}

const SI_WORDS = new Set(['sì', 'si', 'yes', 'true', '1']);
const NO_WORDS = new Set(['no', 'false', '0']);

/**
 * The canonical form the server stores for a Sì/No field ('sì' or 'no'),
 * read from whatever an older answer carried (true/false, 'yes', 'si');
 * '' when the value is none of them.
 * @param {unknown} value
 */
export function siNoWord(value) {
  if (value === true) return 'sì';
  if (value === false) return 'no';
  const word = String(value ?? '').normalize('NFC').trim().toLowerCase();
  if (SI_WORDS.has(word)) return 'sì';
  if (NO_WORDS.has(word)) return 'no';
  return '';
}

/**
 * One labelled control for one field definition. `read()` returns the typed
 * value in canonical form ('' when untouched); `set()` fills it back (the
 * preview confirm path).
 */
export function fieldControl(el, def, value = null) {
  const type = def?.type ?? def?.fieldType ?? 'testo';
  const wrap = el('p', 'bo-campo-field');
  const labelText = def?.label ?? def?.key ?? 'campo';
  const tag = el('label', 'bo-campo-label', labelText);
  wrap.appendChild(tag);
  let control;
  if (type === 'si-no') {
    control = el('select', 'ui-field');
    for (const [optionValue, optionLabel] of [['', '—'], ['sì', 'Sì'], ['no', 'No']]) {
      const option = el('option', undefined, optionLabel);
      option.setAttribute('value', optionValue);
      control.appendChild(option);
    }
    control.value = value === null || value === undefined ? '' : siNoWord(value);
  } else if (type === 'scelta') {
    control = el('select', 'ui-field');
    const empty = el('option', undefined, '—');
    empty.setAttribute('value', '');
    control.appendChild(empty);
    for (const option of asArray(def?.options)) {
      const node = el('option', undefined, String(option));
      node.setAttribute('value', String(option));
      control.appendChild(node);
    }
    control.value = value === null || value === undefined ? '' : String(value);
  } else {
    control = el('input', 'ui-field');
    control.setAttribute('type', type === 'data' ? 'date' : type === 'numero' ? 'text' : 'text');
    if (type === 'numero') control.setAttribute('inputmode', 'decimal');
    control.setAttribute('name', `campo:${def?.key ?? ''}`);
    control.setAttribute('aria-label', String(labelText));
    if (value !== null && value !== undefined) control.value = String(value);
  }
  control.setAttribute('data-field-key', String(def?.key ?? ''));
  wrap.appendChild(control);
  const error = el('small', 'field-error', '');
  error.setAttribute('data-field', `campo:${def?.key ?? ''}`);
  wrap.appendChild(error);
  return {
    wrap,
    control,
    setError: (message) => { error.textContent = message ?? ''; },
    read: () => String(control.value ?? ''),
    set: (next) => { control.value = next === null || next === undefined ? '' : String(next); },
  };
}

/**
 * Inline «+ Aggiungi campo» form: label, type (and options for scelta),
 * Salva posts the definition and reports it back; Annulla drops the form.
 * The server stays authoritative on keys and conflicts.
 */
export function addFieldForm(el, { onDefine }) {
  const wrap = el('div', 'bo-campo-add');
  const labelInput = el('input', 'ui-field');
  labelInput.setAttribute('name', 'nuovo-campo-label');
  labelInput.setAttribute('type', 'text');
  labelInput.setAttribute('placeholder', 'Nome del campo (es. Amico)');
  labelInput.setAttribute('aria-label', 'Nome del nuovo campo');
  const typeSelect = el('select', 'ui-field');
  typeSelect.setAttribute('name', 'nuovo-campo-tipo');
  typeSelect.setAttribute('aria-label', 'Tipo del nuovo campo');
  for (const type of CUSTOM_FIELD_TYPES) {
    const option = el('option', undefined, CUSTOM_FIELD_TYPE_LABELS[type]);
    option.setAttribute('value', type);
    typeSelect.appendChild(option);
  }
  const optionsInput = el('input', 'ui-field');
  optionsInput.setAttribute('name', 'nuovo-campo-opzioni');
  optionsInput.setAttribute('type', 'text');
  optionsInput.setAttribute('placeholder', 'Opzioni separate da virgola (solo Scelta)');
  optionsInput.setAttribute('aria-label', 'Opzioni del nuovo campo scelta');
  const error = el('small', 'field-error', '');
  // Options only mean something for «Scelta»: the box shows for that type.
  const syncOptions = () => { optionsInput.hidden = String(typeSelect.value) !== 'scelta'; };
  syncOptions();
  typeSelect.addEventListener('change', syncOptions);
  const head = el('div', 'bo-campo-add-head');
  const row = el('div', 'bo-campo-add-actions');
  const save = el('button', 'bo-campo-add-save', 'Crea campo');
  save.setAttribute('type', 'button');
  save.setAttribute('data-action', 'create-field');
  const cancel = el('button', 'bo-campo-add-cancel', 'Annulla');
  cancel.setAttribute('type', 'button');
  cancel.setAttribute('data-action', 'cancel-add-field');
  row.appendChild(save);
  row.appendChild(cancel);
  head.appendChild(labelInput);
  head.appendChild(typeSelect);
  wrap.appendChild(head);
  wrap.appendChild(optionsInput);
  wrap.appendChild(row);
  wrap.appendChild(error);
  let busy = false;
  save.addEventListener('click', async () => {
    if (busy) return;
    const label = String(labelInput.value ?? '').trim();
    const type = String(typeSelect.value ?? '').trim() || 'testo';
    if (label === '') {
      error.textContent = 'Dai un nome al campo: es. «Amico».';
      return;
    }
    busy = true;
    save.disabled = true;
    error.textContent = '';
    try {
      const options = type === 'scelta'
        ? String(optionsInput.value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
        : undefined;
      const created = await onDefine({ label, type, options });
      return created;
    } catch (err) {
      error.textContent = String(err?.message ?? 'Non si è potuto creare il campo. Riprova più tardi.');
      return null;
    } finally {
      busy = false;
      save.disabled = false;
    }
  });
  return { wrap, cancel };
}
