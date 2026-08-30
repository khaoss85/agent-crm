// @ts-check

// DOM views for generated modules. Every value coming from schema metadata or
// records is inserted through textContent / setAttribute / .value — never
// innerHTML — so hostile manifest or record strings are inert data, never HTML.

import {
  SUPPORTED_ADMIN_CONTRACT,
  fieldControl,
  editableFields,
  managedFields,
  buildCreatePayload,
  buildUpdatePayload,
  apiErrorToFormErrors,
  displayTitle,
  humanizeLabel,
  hasCapability,
} from './admin-core.js';
import { createSubmissionController } from './admin-submission.js';

function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const LIST_LIMIT = 100;
const REFERENCE_OPTION_LIMIT = 100;
// Bound the by-id fallback fetches for unresolved reference labels in a list,
// so a page of records pointing at many off-page targets cannot fan out into
// an unbounded request storm. Beyond this, the raw id is shown.
const REFERENCE_LABEL_FETCH_BUDGET = 25;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, class?: string, attrs?: Record<string, string>}} [options]
 */
function el(doc, tag, options = {}) {
  const node = doc.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text; // safe: text, not HTML
  if (options.class) node.setAttribute('class', options.class);
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  return node;
}

/**
 * A view controller for the generated-module screens. Injecting `doc`, `client`
 * and `nav` keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate: (hash: string) => void, toast?: (message: string, error?: boolean) => void}} deps
 */
export function createModuleAdmin(deps) {
  const { doc, mount, client, navigate } = deps;
  const toast = deps.toast ?? (() => {});
  const submissions = deps.submissions ?? createSubmissionController({
    storage: deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? memoryStorage() : globalThis.localStorage),
    transport: (path, options) => client.request(path, {
      method: options.method,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
      idempotencyKey: options.idempotencyKey,
      headers: { ...(options.headers ?? {}), 'Idempotency-Key': options.idempotencyKey },
    }),
  });

  /** Guard against stale async responses overwriting a newer view. */
  let renderToken = 0;

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { class: 'panel' });
    box.appendChild(el(doc, 'p', { class: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { class: 'small secondary', text: 'Retry' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  async function fetchSchemaModule(moduleName) {
    const schema = await client.request('/api/schema');
    if (schema?.generatedResourceContract !== SUPPORTED_ADMIN_CONTRACT) {
      throw Object.assign(new Error('This Admin needs an update to render generated modules.'), {
        code: 'UNSUPPORTED_CONTRACT',
      });
    }
    const meta = (schema.generatedModules ?? []).find((module) => module.name === moduleName);
    if (!meta) throw Object.assign(new Error(`Module not found: ${moduleName}`), { status: 404 });
    return meta;
  }

  // ---- List -------------------------------------------------------------

  async function renderList(moduleName) {
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    let records;
    try {
      meta = await fetchSchemaModule(moduleName);
      records = hasCapability(meta, 'list')
        ? (await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records?limit=${LIST_LIMIT}`)).items
        : [];
    } catch (error) {
      if (token !== renderToken) return;
      showMessage(apiErrorToFormErrors(error).general, { retry: () => renderList(moduleName) });
      return;
    }
    if (token !== renderToken) return;

    // Resolve reference labels for the columns, deduplicated per distinct
    // target id (never one request per cell), with a raw-id fallback.
    const columnFields = meta.fields.slice(0, 6);
    const referenceLabels = await resolveReferenceLabels(columnFields, records, token);
    if (token !== renderToken) return;
    clear();

    const panel = el(doc, 'section', { class: 'panel panel-wide' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Generated module' }));
    titleBox.appendChild(el(doc, 'h2', { text: humanizeLabel(meta.name) }));
    if (meta.description) titleBox.appendChild(el(doc, 'p', { class: 'lede', text: meta.description }));
    heading.appendChild(titleBox);
    if (hasCapability(meta, 'create')) {
      const create = el(doc, 'button', { class: 'primary', text: 'Create' });
      create.setAttribute('data-action', 'create');
      create.addEventListener('click', () => navigate(`#/modules/${meta.name}/new`));
      heading.appendChild(create);
    }
    panel.appendChild(heading);

    const columns = columnFields;
    if (!records.length) {
      panel.appendChild(el(doc, 'div', { class: 'empty', text: 'No records yet.' }));
    } else {
      const wrap = el(doc, 'div', { class: 'table-wrap' });
      const table = el(doc, 'table');
      const thead = el(doc, 'thead');
      const headRow = el(doc, 'tr');
      for (const field of columns) headRow.appendChild(el(doc, 'th', { text: humanizeLabel(field.name) }));
      headRow.appendChild(el(doc, 'th', { text: 'Created' }));
      headRow.appendChild(el(doc, 'th', { attrs: { 'aria-label': 'Open' } }));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = el(doc, 'tbody');
      for (const record of records) {
        const row = el(doc, 'tr');
        for (const field of columns) {
          const value = record[field.name];
          const text = field.type === 'reference' && value != null
            ? referenceLabels.get(`${field.name}:${value}`) ?? String(value)
            : cellText(value);
          row.appendChild(el(doc, 'td', { text }));
        }
        row.appendChild(el(doc, 'td', { text: record.createdAt ? String(record.createdAt) : '—' }));
        const openCell = el(doc, 'td');
        if (hasCapability(meta, 'get')) {
          const open = el(doc, 'button', { class: 'small secondary', text: 'Open' });
          open.addEventListener('click', () => navigate(`#/modules/${meta.name}/${encodeURIComponent(record.id)}`));
          openCell.appendChild(open);
        }
        row.appendChild(openCell);
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      panel.appendChild(wrap);
    }
    mount.appendChild(panel);
    return panel;
  }

  // ---- Create form ------------------------------------------------------

  async function renderNew(moduleName) {
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    try {
      meta = await fetchSchemaModule(moduleName);
    } catch (error) {
      if (token !== renderToken) return;
      showMessage(apiErrorToFormErrors(error).general, { retry: () => renderNew(moduleName) });
      return;
    }
    if (token !== renderToken) return;
    if (!hasCapability(meta, 'create')) {
      showMessage('This module cannot create records.');
      return;
    }
    const fields = editableFields(meta);
    const form = buildForm(meta, fields, {}, async (raw, setBusy, showErrors) => {
      const { payload, errors } = buildCreatePayload(fields, raw);
      if (Object.keys(errors).length) return showErrors(errors);
      setBusy(true);
      try {
        const created = await submissions.submit({
          path: `/api/modules/${encodeURIComponent(moduleName)}/records`,
          method: 'POST',
          body: payload,
          key: form.__submissionKey ?? (form.__submissionKey = submissions.issueKey()),
        });
        form.__submissionKey = undefined;
        toast(`${humanizeLabel(meta.name)} created.`);
        navigate(`#/modules/${meta.name}/${encodeURIComponent(created.id)}`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Create', token });
    clear();
    mount.appendChild(form);
    await form.__populateReferences(token);
    return form;
  }

  // ---- Detail / edit ----------------------------------------------------

  async function renderDetail(moduleName, id) {
    const token = ++renderToken;
    showMessage('Loading…');
    let meta;
    let record;
    try {
      meta = await fetchSchemaModule(moduleName);
      record = await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records/${encodeURIComponent(id)}`);
    } catch (error) {
      if (token !== renderToken) return;
      const mapped = apiErrorToFormErrors(error);
      showMessage(mapped.status === 404 ? 'Record not found.' : mapped.general, {
        retry: mapped.status === 404 ? undefined : () => renderDetail(moduleName, id),
      });
      return;
    }
    if (token !== renderToken) return;
    const fields = editableFields(meta);
    const canUpdate = hasCapability(meta, 'update');
    const form = buildForm(meta, fields, record, async (raw, setBusy, showErrors) => {
      const { payload, errors } = buildUpdatePayload(meta.fields, raw, record);
      if (Object.keys(errors).length) return showErrors(errors);
      if (Object.keys(payload).length === 0) {
        toast('Nothing to update.');
        return;
      }
      setBusy(true);
      try {
        record = await submissions.submit({
          path: `/api/modules/${encodeURIComponent(moduleName)}/records/${encodeURIComponent(id)}`,
          method: 'PATCH',
          body: payload,
          key: form.__submissionKey ?? (form.__submissionKey = submissions.issueKey()),
        });
        form.__submissionKey = undefined;
        setBusy(false);
        toast(`${humanizeLabel(meta.name)} saved.`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Save', readOnly: !canUpdate, immutable: record, title: displayTitle(record, meta.fields), token });
    clear();
    mount.appendChild(form);
    const actionsPanel = buildActionsPanel(meta, record, id, token);
    if (actionsPanel) mount.appendChild(actionsPanel);
    await form.__populateReferences(token);
    return form;
  }

  /**
   * Whether an action is offered for a record, from the action's declared
   * `fromStates` against the record's state field. An action with no
   * `fromStates` (null) is always available.
   *
   * @param {{fromStates?: string[] | null, stateField?: string}} action @param {Record<string, any>} record
   */
  function actionApplies(action, record) {
    if (!Array.isArray(action.fromStates)) return true;
    const stateField = typeof action.stateField === 'string' ? action.stateField : 'status';
    return action.fromStates.includes(record[stateField]);
  }

  /**
   * Generic action controls for a record detail (ADR-011), built purely from
   * `meta.actions` — no per-module code. A read-only summary shows the current
   * value of every workflow-managed field (e.g. status), then one button per
   * action valid for the record's current state. Actions with input reveal a
   * small form built from the action's input schema; actions without input run
   * on click. On success the detail is re-rendered so state and buttons update.
   *
   * @param {any} meta @param {Record<string, any>} record @param {string} id @param {number} token
   */
  function buildActionsPanel(meta, record, id, token) {
    const managed = managedFields(meta);
    const actions = Array.isArray(meta.actions) ? meta.actions : [];
    if (!managed.length && !actions.length) return null;

    const panel = el(doc, 'section', { class: 'panel actions-panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Lifecycle' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Actions' }));
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    if (managed.length) {
      const dl = el(doc, 'dl', { class: 'managed' });
      for (const field of managed) {
        dl.appendChild(el(doc, 'dt', { text: humanizeLabel(field.name) }));
        const value = record[field.name];
        dl.appendChild(el(doc, 'dd', {
          text: value === null || value === undefined || value === '' ? '—' : String(value),
          attrs: { 'data-managed-field': field.name },
        }));
      }
      panel.appendChild(dl);
    }

    const panelError = el(doc, 'p', { class: 'form-error hidden', attrs: { role: 'alert' } });
    panel.appendChild(panelError);

    const applicable = actions.filter((action) => actionApplies(action, record));
    if (!applicable.length) {
      panel.appendChild(el(doc, 'p', { class: 'empty', text: 'No actions available for this record.' }));
    } else {
      for (const action of applicable) {
        panel.appendChild(buildActionRow(meta, action, id, panelError));
      }
    }
    // Test/programmatic hooks.
    panel.__actions = applicable.map((action) => action.name);
    panel.__runAction = (name, values) => {
      const action = applicable.find((candidate) => candidate.name === name);
      if (!action) throw new Error(`action not applicable: ${name}`);
      return submitAction(meta, action, id, values ?? {}, () => {}, panelError);
    };
    return panel;
  }

  /**
   * One action's controls: a trigger button, plus (for actions with input) an
   * inline form revealed on click. Double-submit guarded; input errors and the
   * general error render as text.
   *
   * @param {any} meta @param {any} action @param {string} id @param {any} panelError
   */
  function buildActionRow(meta, action, id, panelError) {
    const row = el(doc, 'div', { class: 'action-row', attrs: { 'data-action': action.name } });
    const trigger = el(doc, 'button', {
      class: 'primary action-trigger',
      text: action.label ?? action.name,
      attrs: { type: 'button', 'data-action-trigger': action.name },
    });
    row.appendChild(trigger);
    if (action.description) row.appendChild(el(doc, 'small', { class: 'hint', text: action.description }));

    const inputs = Array.isArray(action.input) ? action.input : [];
    let busy = false;
    const setBusy = (value) => {
      busy = value;
      trigger.disabled = value;
      trigger.setAttribute('aria-busy', value ? 'true' : 'false');
    };

    if (!inputs.length) {
      trigger.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        await submitAction(meta, action, id, {}, setBusy, panelError);
      });
      return row;
    }

    // Actions with input: reveal a small form on click.
    const form = el(doc, 'form', { class: 'action-form hidden' });
    form.setAttribute('novalidate', 'novalidate');
    /** @type {Record<string, any>} */
    const fieldInputs = {};
    /** @type {Record<string, any>} */
    const fieldErrors = {};
    for (const field of inputs) {
      const fieldRow = el(doc, 'div', { class: 'field-row' });
      const inputId = `action-${meta.name}-${action.name}-${field.name}`;
      const label = el(doc, 'label', { text: humanizeLabel(field.name), attrs: { for: inputId } });
      if (field.required) label.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      fieldRow.appendChild(label);
      let input;
      if (field.type === 'enum') {
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: field.required ? 'Select…' : '(none)', attrs: { value: '' } }));
        for (const value of Array.isArray(field.values) ? field.values : []) {
          input.appendChild(el(doc, 'option', { text: value, attrs: { value } }));
        }
      } else if (field.type === 'integer') {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'number', step: '1' } });
      } else {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'text' } });
        if (field.type === 'timestamp') input.setAttribute('placeholder', 'YYYY-MM-DDTHH:MM:SSZ');
      }
      if (field.required) input.setAttribute('required', 'required');
      const errorNode = el(doc, 'small', { class: 'field-error hidden', attrs: { id: `${inputId}-error` } });
      input.setAttribute('aria-describedby', `${inputId}-error`);
      fieldRow.appendChild(input);
      // Declared hint first (action metadata, rendered as text), then the
      // built-in timestamp format hint.
      if (typeof field.hint === 'string' && field.hint) {
        fieldRow.appendChild(el(doc, 'small', { class: 'hint', text: field.hint }));
      }
      if (field.type === 'timestamp') {
        fieldRow.appendChild(el(doc, 'small', { class: 'hint', text: 'ISO-8601 UTC, e.g. 2026-08-10T09:00:00Z' }));
      }
      fieldRow.appendChild(errorNode);
      form.appendChild(fieldRow);
      fieldInputs[field.name] = input;
      fieldErrors[field.name] = errorNode;
    }
    const runButton = el(doc, 'button', { class: 'primary', text: 'Run', attrs: { type: 'submit' } });
    form.appendChild(runButton);
    row.appendChild(form);

    const clearFieldErrors = () => {
      for (const node of Object.values(fieldErrors)) {
        node.textContent = '';
        node.setAttribute('class', 'field-error hidden');
      }
    };
    const showFieldErrors = (fields = {}) => {
      clearFieldErrors();
      for (const [name, message] of Object.entries(fields)) {
        if (fieldErrors[name]) {
          fieldErrors[name].textContent = message;
          fieldErrors[name].setAttribute('class', 'field-error');
        }
      }
    };

    trigger.addEventListener('click', () => {
      const hidden = form.getAttribute('class').includes('hidden');
      form.setAttribute('class', hidden ? 'action-form' : 'action-form hidden');
    });

    async function handleRun(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (busy) return;
      clearFieldErrors();
      /** @type {Record<string, unknown>} */
      const values = {};
      /** @type {Record<string, string>} */
      const clientErrors = {};
      for (const field of inputs) {
        const raw = fieldInputs[field.name].value;
        const text = raw === undefined || raw === null ? '' : String(raw).trim();
        if (text === '') {
          if (field.required) clientErrors[field.name] = `${humanizeLabel(field.name)} is required`;
          continue;
        }
        if (field.type === 'integer') {
          // The server accepts JSON integers only, so parse here; a fast
          // client-side message beats a round trip (server stays authoritative).
          if (!/^-?\d+$/.test(text)) {
            clientErrors[field.name] = `${humanizeLabel(field.name)} must be a whole number`;
            continue;
          }
          values[field.name] = Number(text);
          continue;
        }
        values[field.name] = text;
      }
      if (Object.keys(clientErrors).length) return showFieldErrors(clientErrors);
      setBusy(true);
      await submitAction(meta, action, id, values, setBusy, panelError, showFieldErrors);
    }
    form.addEventListener('submit', handleRun);
    form.__run = handleRun;
    form.__inputs = fieldInputs;
    return row;
  }

  /**
   * POST an action to the server and, on success, re-render the detail so the
   * new state and available actions are reflected. On failure, restore the
   * button and surface field/general errors as text.
   *
   * @param {any} meta @param {any} action @param {string} id
   * @param {Record<string, unknown>} values @param {(busy: boolean) => void} setBusy
   * @param {any} panelError @param {(fields: Record<string, string>) => void} [showFieldErrors]
   */
  async function submitAction(meta, action, id, values, setBusy, panelError, showFieldErrors) {
    panelError.textContent = '';
    panelError.setAttribute('class', 'form-error hidden');
    try {
      await submissions.submit({
        path: `/api/modules/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(action.name)}`,
        method: 'POST',
        body: values,
      });
      toast(`${action.label ?? action.name} done.`);
      await renderDetail(meta.name, id);
    } catch (error) {
      setBusy(false);
      const mapped = apiErrorToFormErrors(error);
      if (showFieldErrors && mapped.fields && Object.keys(mapped.fields).length) showFieldErrors(mapped.fields);
      panelError.textContent = mapped.general;
      panelError.setAttribute('class', 'form-error');
    }
  }

  /**
   * Build a form node from field descriptors. `onSubmit(raw, setBusy, showErrors)`.
   */
  function buildForm(meta, fields, initial, onSubmit, options = {}) {
    const panel = el(doc, 'section', { class: 'panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: humanizeLabel(meta.name) }));
    titleBox.appendChild(el(doc, 'h2', { text: options.title ?? `New ${humanizeLabel(meta.name).toLowerCase()}` }));
    heading.appendChild(titleBox);
    const back = el(doc, 'button', { class: 'small secondary', text: 'Back to list' });
    back.addEventListener('click', () => navigate(`#/modules/${meta.name}`));
    heading.appendChild(back);
    panel.appendChild(heading);

    const form = el(doc, 'form', { class: 'record-form' });
    form.setAttribute('novalidate', 'novalidate');
    const generalError = el(doc, 'p', { class: 'form-error hidden', attrs: { role: 'alert' } });
    form.appendChild(generalError);

    /** @type {Record<string, any>} */
    const inputs = {};
    /** @type {Record<string, any>} */
    const fieldErrors = {};
    /** @type {Array<{input: any, control: any, currentValue: string, hint: any}>} */
    const referencePopulations = [];

    for (const field of fields) {
      const control = fieldControl(field);
      const row = el(doc, 'div', { class: 'field-row' });
      const inputId = `field-${meta.name}-${field.name}`;
      const label = el(doc, 'label', { text: control.label, attrs: { for: inputId } });
      if (control.required) label.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      row.appendChild(label);

      let input;
      let referenceHint = null;
      if (control.control === 'reference') {
        // Empty select now; options are loaded asynchronously (guarded by the
        // render token) from the target module, with the current value ensured.
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: control.required ? 'Select…' : 'None', attrs: { value: '' } }));
        // Honest truncation notice, revealed only if the target list is capped.
        referenceHint = el(doc, 'small', { class: 'hint hidden', text: 'Showing the first 100; searchable selection is a later milestone.' });
        const currentValue = initial[field.name] != null ? String(initial[field.name]) : '';
        referencePopulations.push({ input, control, currentValue, hint: referenceHint });
      } else if (control.control === 'select') {
        input = el(doc, 'select', { attrs: { id: inputId, name: field.name } });
        input.appendChild(el(doc, 'option', { text: control.required ? 'Select…' : '(none)', attrs: { value: '' } }));
        for (const option of control.options) {
          input.appendChild(el(doc, 'option', { text: option, attrs: { value: option } }));
        }
        if (initial[field.name] != null) input.value = String(initial[field.name]);
      } else if (control.control === 'checkbox') {
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type: 'checkbox' } });
        if (initial[field.name] === true) input.setAttribute('checked', 'checked');
        input.checked = initial[field.name] === true;
      } else {
        const type = control.control === 'number' ? 'number' : control.control === 'email' ? 'email' : 'text';
        input = el(doc, 'input', { attrs: { id: inputId, name: field.name, type } });
        if (control.control === 'number') input.setAttribute('step', '1');
        if (initial[field.name] != null) input.value = String(initial[field.name]);
      }
      if (control.required) input.setAttribute('required', 'required');
      if (control.unique) row.appendChild(el(doc, 'small', { class: 'hint', text: 'Must be unique' }));
      const errorNode = el(doc, 'small', { class: 'field-error hidden', attrs: { id: `${inputId}-error` } });
      input.setAttribute('aria-describedby', `${inputId}-error`);
      row.appendChild(input);
      if (referenceHint) row.appendChild(referenceHint);
      row.appendChild(errorNode);
      form.appendChild(row);
      inputs[field.name] = input;
      fieldErrors[field.name] = errorNode;
    }

    if (options.immutable) {
      const meta2 = el(doc, 'dl', { class: 'immutable' });
      for (const key of ['id', 'createdAt', 'updatedAt']) {
        if (options.immutable[key] === undefined) continue;
        meta2.appendChild(el(doc, 'dt', { text: humanizeLabel(key) }));
        meta2.appendChild(el(doc, 'dd', { text: String(options.immutable[key]) }));
      }
      form.appendChild(meta2);
    }

    const submit = el(doc, 'button', { class: 'primary', text: options.submitLabel ?? 'Save', attrs: { type: 'submit' } });
    if (options.readOnly) {
      submit.setAttribute('disabled', 'disabled');
      submit.disabled = true;
      form.appendChild(el(doc, 'p', { class: 'empty', text: 'This module is read-only.' }));
    }
    form.appendChild(submit);

    let inFlight = false;
    function setBusy(busy) {
      inFlight = busy;
      submit.disabled = busy || options.readOnly === true;
      submit.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    function clearErrors() {
      generalError.textContent = '';
      generalError.setAttribute('class', 'form-error hidden');
      for (const node of Object.values(fieldErrors)) {
        node.textContent = '';
        node.setAttribute('class', 'field-error hidden');
      }
    }
    function showErrors(fieldMap = {}, general) {
      clearErrors();
      if (general) {
        generalError.textContent = general;
        generalError.setAttribute('class', 'form-error');
      }
      for (const [name, message] of Object.entries(fieldMap)) {
        if (fieldErrors[name]) {
          fieldErrors[name].textContent = message;
          fieldErrors[name].setAttribute('class', 'field-error');
        } else if (!general) {
          generalError.textContent = message;
          generalError.setAttribute('class', 'form-error');
        }
      }
    }

    function readRaw() {
      /** @type {Record<string, unknown>} */
      const raw = {};
      for (const [name, input] of Object.entries(inputs)) {
        raw[name] = input.getAttribute && input.getAttribute('type') === 'checkbox' ? input.checked === true : input.value;
      }
      return raw;
    }

    async function handleSubmit(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (options.readOnly) return;
      if (inFlight && form.__pending) return form.__pending;
      clearErrors();
      form.__pending = onSubmit(readRaw(), setBusy, showErrors);
      try {
        await form.__pending;
      } finally {
        form.__pending = null;
      }
    }
    form.addEventListener('submit', handleSubmit);
    // Expose for tests / programmatic submit without a real submit event.
    form.__submit = handleSubmit;
    form.__inputs = inputs;
    form.__populateReferences = (token) =>
      Promise.all(referencePopulations.map((ref) => populateReference(ref, token, options.token)));

    return form;
  }

  /**
   * Build an id→label map for reference columns, fetching each target module's
   * list once and resolving only the ids present, deduplicated. Missing ids get
   * a single by-id fetch; anything unresolved falls back to the raw id.
   *
   * @param {Array<any>} columnFields @param {Array<any>} records @param {number} token
   * @returns {Promise<Map<string, string>>}
   */
  async function resolveReferenceLabels(columnFields, records, token) {
    const labels = new Map();
    const referenceCols = columnFields.filter((field) => field.type === 'reference' && field.targetModule);
    for (const field of referenceCols) {
      const ids = new Set();
      for (const record of records) {
        const value = record[field.name];
        if (value != null && value !== '') ids.add(String(value));
      }
      if (ids.size === 0) continue;
      let items = [];
      try {
        // One list call per reference column resolves every id on the first page.
        const response = await client.request(`/api/modules/${encodeURIComponent(field.targetModule)}/records?limit=${REFERENCE_OPTION_LIMIT}`);
        items = Array.isArray(response.items) ? response.items : [];
      } catch {
        items = [];
      }
      if (token !== renderToken) return labels;
      const displayField = typeof field.targetDisplayField === 'string' ? field.targetDisplayField : 'id';
      for (const record of items) {
        const id = record && record.id != null ? String(record.id) : '';
        if (!ids.has(id)) continue;
        const labelValue = record[displayField];
        labels.set(`${field.name}:${id}`, labelValue == null || labelValue === '' ? id : String(labelValue));
      }
      // Ids not on the first page: one targeted fetch each, up to a bounded
      // budget so a page pointing at many off-page targets cannot fan out
      // without limit; beyond the budget the raw id is shown.
      let budget = REFERENCE_LABEL_FETCH_BUDGET;
      for (const id of ids) {
        if (labels.has(`${field.name}:${id}`)) continue;
        if (budget <= 0) {
          labels.set(`${field.name}:${id}`, id);
          continue;
        }
        budget -= 1;
        try {
          const record = await client.request(
            `/api/modules/${encodeURIComponent(field.targetModule)}/records/${encodeURIComponent(id)}`,
          );
          if (token !== renderToken) return labels;
          const labelValue = record[displayField];
          labels.set(`${field.name}:${id}`, labelValue == null || labelValue === '' ? id : String(labelValue));
        } catch {
          labels.set(`${field.name}:${id}`, id);
        }
      }
    }
    return labels;
  }

  /**
   * Load target options for one reference select, ensuring the current value is
   * always present even if it is not on the first page. Guarded by the render
   * token so a stale form's options never land in a newer view.
   *
   * @param {{input: any, control: any, currentValue: string}} ref
   * @param {number} token
   */
  async function populateReference(ref, token) {
    const { input, control, currentValue, hint } = ref;
    if (!control.targetModule) return; // malformed metadata: leave placeholder only
    let items = [];
    try {
      const response = await client.request(`/api/modules/${encodeURIComponent(control.targetModule)}/records?limit=${REFERENCE_OPTION_LIMIT}`);
      items = Array.isArray(response.items) ? response.items : [];
    } catch {
      // Target list unavailable: keep the placeholder; the raw id (if any) is
      // still ensured below so the current value is never silently lost.
      items = [];
    }
    if (token !== renderToken) return; // a newer render owns the view now
    // Honest notice: if the target list is capped, the selection is truncated.
    if (hint && items.length >= REFERENCE_OPTION_LIMIT) hint.setAttribute('class', 'hint');
    const seen = new Set();
    const addOption = (record) => {
      const id = record && record.id != null ? String(record.id) : '';
      if (id === '' || seen.has(id)) return;
      seen.add(id);
      const labelValue = record[control.targetDisplayField];
      const label = labelValue == null || labelValue === '' ? id : String(labelValue);
      input.appendChild(el(doc, 'option', { text: label, attrs: { value: id } })); // safe: textContent
    };
    for (const record of items) addOption(record);
    // Ensure the current value is selectable even if it is not on the first page.
    if (currentValue && !seen.has(currentValue)) {
      try {
        const record = await client.request(
          `/api/modules/${encodeURIComponent(control.targetModule)}/records/${encodeURIComponent(currentValue)}`,
        );
        if (token !== renderToken) return;
        addOption(record);
      } catch {
        if (token !== renderToken) return;
        addOption({ id: currentValue }); // fall back to the raw id, never lose it
      }
    }
    if (currentValue) input.value = currentValue;
  }

  return { renderList, renderNew, renderDetail };
}

/** @param {unknown} value */
function cellText(value) {
  if (value === null || value === undefined) return '—';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return String(value);
}
