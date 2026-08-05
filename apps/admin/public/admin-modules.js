// @ts-check

// DOM views for generated modules. Every value coming from schema metadata or
// records is inserted through textContent / setAttribute / .value — never
// innerHTML — so hostile manifest or record strings are inert data, never HTML.

import {
  SUPPORTED_ADMIN_CONTRACT,
  fieldControl,
  editableFields,
  buildCreatePayload,
  buildUpdatePayload,
  apiErrorToFormErrors,
  displayTitle,
  humanizeLabel,
  hasCapability,
} from './admin-core.js';

const LIST_LIMIT = 100;

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

    const columns = meta.fields.slice(0, 6);
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
        for (const field of columns) row.appendChild(el(doc, 'td', { text: cellText(record[field.name]) }));
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
        const created = await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast(`${humanizeLabel(meta.name)} created.`);
        navigate(`#/modules/${meta.name}/${encodeURIComponent(created.id)}`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Create' });
    clear();
    mount.appendChild(form);
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
        record = await client.request(`/api/modules/${encodeURIComponent(moduleName)}/records/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setBusy(false);
        toast(`${humanizeLabel(meta.name)} saved.`);
      } catch (error) {
        setBusy(false);
        const mapped = apiErrorToFormErrors(error);
        showErrors(mapped.fields, mapped.general);
      }
    }, { submitLabel: 'Save', readOnly: !canUpdate, immutable: record, title: displayTitle(record, meta.fields) });
    clear();
    mount.appendChild(form);
    return form;
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

    for (const field of fields) {
      const control = fieldControl(field);
      const row = el(doc, 'div', { class: 'field-row' });
      const inputId = `field-${meta.name}-${field.name}`;
      const label = el(doc, 'label', { text: control.label, attrs: { for: inputId } });
      if (control.required) label.appendChild(el(doc, 'span', { class: 'req', text: ' *' }));
      row.appendChild(label);

      let input;
      if (control.control === 'select') {
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
      if (inFlight || options.readOnly) return; // double-submit guard
      clearErrors();
      await onSubmit(readRaw(), setBusy, showErrors);
    }
    form.addEventListener('submit', handleSubmit);
    // Expose for tests / programmatic submit without a real submit event.
    form.__submit = handleSubmit;
    form.__inputs = inputs;

    return form;
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
