// @ts-check

import { elFor, uiButton, uiSecondaryButton } from './admin-ui.js'; // BO-F6-02: the single component library.
import { bindAdminMutations } from './admin-submission.js';
import { customerImportReasonLabel } from './admin-core.js';
import {
  addFieldForm,
  applyPhrase,
  defineField,
  fetchFieldDefs,
  fieldControl,
  phraseAiAvailable,
  postSubjectNote,
  previewPhrase,
  saveFieldValue,
} from './admin-custom-fields.js';

/**
 * The "Nuovo cliente" form (backlog:273de560, backlog:434cc39a). "Aggiungi
 * cliente → Compila manualmente" opens this form on `#/clienti/nuovo`, not
 * the JSON import tool: the prototype's Clienti screen carries no import
 * tool, and the import stays a separate tool on `#/import-clienti`.
 *
 * Saving uses the same governed operation as the import tool —
 * `POST /api/customer-data/import/apply` with a single row — so matching,
 * dedup, idempotency and receipts apply to a hand-typed customer exactly
 * like to an imported row. The phone number rides a second single-row
 * apply under the `phone` system: a phone-bearing identity beside the
 * record, which is the only phone the framework stores (the contact
 * record carries no phone field).
 *
 * «✦ Scrivi o incolla» (backlog:434cc39a): when the server composition
 * carries the AI adapter, the form opens with a sentence area — the AI
 * previews name, email, phone and the new custom fields, and only the
 * human Conferma stores. Without the adapter the area hides and the manual
 * fields work alone. «+ Aggiungi campo» defines one space-wide field, and
 * the note posts through the single writer (POST /api/customer-hub/notes)
 * so it lands in the scheda cronologia.
 *
 * Stato has no framework home: the status is derived from signed business
 * and nothing stores it. The field stays visible with an honest line.
 */

export const CLIENTI_NUOVO_ROUTE = '#/clienti/nuovo';
export const MANUAL_IMPORT_SYSTEM = 'inserimento-manuale';
export const MANUAL_PHONE_SYSTEM = 'phone';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {string} raw */
export function splitNome(raw) {
  const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? '';
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

/** @param {string} raw */
export function normalizeTelefono(raw) {
  return String(raw ?? '').replace(/[\s.\-()/]/g, '');
}

/**
 * Client-side checks. The server stays authoritative; these only keep the
 * operator from sending a row the import would refuse.
 * @param {{nome: string, email: string, telefono: string, azienda: string}} values
 */
export function validateCustomerForm(values) {
  const errors = {};
  const nome = String(values.nome ?? '').trim();
  const email = String(values.email ?? '').trim();
  const telefono = normalizeTelefono(values.telefono ?? '');
  const azienda = String(values.azienda ?? '').trim();
  if (nome === '') errors.nome = 'Il nome è obbligatorio.';
  if (email !== '' && !EMAIL_RE.test(email)) {
    errors.email = 'Questa email non sembra valida: controlla che ci siano @ e dominio.';
  }
  if (telefono !== '' && !/^\+?\d{6,15}$/.test(telefono)) {
    errors.telefono = 'Il telefono deve avere solo cifre, con il prefisso (es. +39 333 1234567).';
  }
  if (telefono !== '' && email === '') {
    errors.telefono = 'Senza email il telefono non si collega: aggiungi l\u2019email.';
  }
  if (email === '' && azienda === '') {
    errors.general = 'Indica almeno l\u2019email o l\u2019azienda: senza, non si sa chi è il cliente.';
  }
  return errors;
}

/** Italian form-level text for a refused single-row apply. */
export function applyRefusalText(receipt) {
  const label = customerImportReasonLabel(receipt?.reasonCode);
  switch (receipt?.reasonCode) {
    case 'MISSING_REQUIRED_IDENTITY':
      return 'Indica almeno l\u2019email o l\u2019azienda: senza, non si sa chi è il cliente.';
    case 'INVALID_EMAIL':
      return 'Questa email non sembra valida: controlla che ci siano @ e dominio.';
    case 'INVALID_DOMAIN':
      return 'Il dominio dell\u2019email non sembra valido.';
    case 'AMBIGUOUS_CANDIDATES':
      return 'Ci sono schede molto simili: controlla i possibili doppioni nello strumento di importazione.';
    default:
      return `Non si è potuto creare il cliente (${label}). Riprova più tardi.`;
  }
}

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   notify?: (message: string) => void, submissions?: any, storage?: any}} deps
 */
export function createCustomerFormView(deps) {
  const { doc, mount, navigate = () => {}, notify = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const el = elFor(doc); // BO-F6-02: shared element builder.
  let renderToken = 0;

  function invalidate() {
    renderToken += 1;
  }

  function fieldErrorSlot() {
    const slot = el('small', 'field-error', '');
    slot.setAttribute('data-field-error', '');
    return slot;
  }

  async function render() {
    const token = ++renderToken;
    while (mount.firstChild) mount.removeChild(mount.firstChild);

    const panel = el('section', 'bo-cliente-nuovo');
    panel.appendChild(el('h1', 'bo-cliente-nuovo-title', 'Nuovo cliente'));
    panel.appendChild(el('p', 'bo-muted',
      'Compila e premi Salva: il cliente si crea con la stessa operazione dell\u2019importazione.'));

    // «✦ Scrivi o incolla» fills in only when the server says the AI is
    // on; without it the manual fields below work alone.
    const aiBox = el('div', 'bo-cliente-nuovo-ai');
    panel.appendChild(aiBox);
    const previewBox = el('div', 'bo-cliente-nuovo-preview');
    panel.appendChild(previewBox);

    const general = el('p', 'field-error bo-cliente-nuovo-error', '');
    general.setAttribute('data-general-error', '');
    panel.appendChild(general);

    const controls = {};
    const slots = {};
    const field = (name, label, control, help = null) => {
      const wrap = el('p', 'bo-cliente-nuovo-field');
      const tag = el('label', 'bo-cliente-nuovo-label', label);
      wrap.appendChild(tag);
      wrap.appendChild(control);
      const slot = fieldErrorSlot();
      slot.setAttribute('data-field', name);
      wrap.appendChild(slot);
      if (help !== null) wrap.appendChild(el('small', 'bo-muted', help));
      controls[name] = control;
      slots[name] = slot;
      (into ?? panel).appendChild(wrap);
      return control;
    };
    // The base fields sit in a two-column grid (Nome across the top), so the
    // form reads as one card instead of a stack of full-width bars.
    const grid = el('div', 'bo-cliente-nuovo-grid');
    panel.appendChild(grid);
    let into = grid;

    const nome = el('input', 'ui-field');
    nome.setAttribute('name', 'nome');
    nome.setAttribute('type', 'text');
    nome.setAttribute('placeholder', 'Mario Rossi');
    field('nome', 'Nome', nome);
    nome.parentNode?.classList?.add('is-wide');

    const email = el('input', 'ui-field');
    email.setAttribute('name', 'email');
    email.setAttribute('type', 'email');
    email.setAttribute('placeholder', 'mario@esempio.it');
    field('email', 'Email', email);

    const telefono = el('input', 'ui-field');
    telefono.setAttribute('name', 'telefono');
    telefono.setAttribute('type', 'tel');
    telefono.setAttribute('placeholder', '+39 333 1234567');
    field('telefono', 'Telefono', telefono);

    const azienda = el('input', 'ui-field');
    azienda.setAttribute('name', 'azienda');
    azienda.setAttribute('type', 'text');
    azienda.setAttribute('placeholder', 'Palestra Esempio');
    field('azienda', 'Azienda', azienda);

    const stato = el('select', 'ui-field');
    stato.setAttribute('name', 'stato');
    for (const [value, label] of [['contatto', 'Contatto'], ['cliente', 'Cliente']]) {
      const option = el('option', undefined, label);
      option.setAttribute('value', value);
      stato.appendChild(option);
    }
    stato.value = 'contatto';
    field('stato', 'Stato', stato,
      'Promemoria per te: lo stato vero dipende da ordini, contratti o abbonamenti.');

    // One control per space-wide custom field, plus the inline adder.
    into = panel;
    const customBox = el('div', 'bo-cliente-nuovo-custom');
    panel.appendChild(customBox);
    const addToggle = el('button', 'bo-cliente-nuovo-addfield', '+ Aggiungi campo');
    addToggle.setAttribute('type', 'button');
    addToggle.setAttribute('data-action', 'add-field');
    panel.appendChild(addToggle);
    const addBox = el('div', 'bo-cliente-nuovo-add');
    panel.appendChild(addBox);

    const nota = el('textarea', 'ui-field');
    nota.setAttribute('name', 'nota');
    nota.setAttribute('placeholder', 'Come ci ha conosciuti, cosa cerca…');
    field('nota', 'Nota', nota, 'La nota si salva nella cronologia della scheda.');

    const actions = el('div', 'bo-cliente-nuovo-actions');
    const save = uiButton(doc, { variant: 'primary', label: 'Salva', attrs: { 'data-action': 'save-customer' } });
    const cancel = uiSecondaryButton(doc, 'Annulla');
    cancel.setAttribute('data-action', 'cancel-customer');
    actions.appendChild(save);
    actions.appendChild(cancel);
    panel.appendChild(actions);

    const setErrors = (errors) => {
      for (const [name, slot] of Object.entries(slots)) {
        slot.textContent = errors[name] ?? '';
      }
      general.textContent = errors.general ?? '';
    };

    // Space definitions load once; a failure reads as no custom fields,
    // never a broken form — the manual base fields always work.
    let fieldDefs = [];
    try {
      fieldDefs = await fetchFieldDefs(client);
    } catch {
      fieldDefs = [];
    }
    if (token !== renderToken) return;
    const customControls = fieldDefs.map((def) => fieldControl(el, def));
    for (const entry of customControls) customBox.appendChild(entry.wrap);

    let addOpen = false;
    addToggle.addEventListener('click', () => {
      if (addOpen) return;
      addOpen = true;
      const form = addFieldForm(el, {
        onDefine: async (input) => {
          const created = await defineField(client, input);
          if (token !== renderToken) return created;
          const def = created?.definition ?? null;
          if (def) {
            const entry = fieldControl(el, def);
            customBox.appendChild(entry.wrap);
            customControls.push(entry);
            fieldDefs = [...fieldDefs, def];
          }
          while (addBox.firstChild) addBox.removeChild(addBox.firstChild);
          addOpen = false;
          notify('Campo creato: ora è in tutte le schede, nei filtri e nelle colonne.');
          return created;
        },
      });
      form.cancel.addEventListener('click', () => {
        while (addBox.firstChild) addBox.removeChild(addBox.firstChild);
        addOpen = false;
      });
      addBox.appendChild(form.wrap);
    });

    // The ✦ area: probe first, render only when the AI is on.
    let aiOn = false;
    try {
      aiOn = await phraseAiAvailable(client);
    } catch {
      aiOn = false;
    }
    if (token !== renderToken) return;
    if (aiOn) renderAiBox(aiBox, previewBox, token, { setErrors, customControls, fieldDefs, notify });

    let busy = false;
    save.addEventListener('click', () => void saveCustomer());
    cancel.addEventListener('click', () => navigate('#/customer-data'));

    async function saveCustomer() {
      if (busy) return;
      const values = {
        nome: String(nome.value ?? ''),
        email: String(email.value ?? ''),
        telefono: String(telefono.value ?? ''),
        azienda: String(azienda.value ?? ''),
      };
      const errors = validateCustomerForm(values);
      setErrors(errors);
      if (Object.keys(errors).length > 0) return;
      busy = true;
      save.disabled = true;
      try {
        const { firstName, lastName } = splitNome(values.nome);
        const row = { firstName };
        if (lastName !== '') row.lastName = lastName;
        const cleanEmail = values.email.trim();
        if (cleanEmail !== '') row.email = cleanEmail;
        const cleanAzienda = values.azienda.trim();
        if (cleanAzienda !== '') row.companyName = cleanAzienda;
        const result = await client.request('/api/customer-data/import/apply', {
          method: 'POST',
          body: JSON.stringify({ system: MANUAL_IMPORT_SYSTEM, rows: [row], acceptance: 'partial' }),
        });
        if (token !== renderToken) return;
        const receipt = result?.receipts?.[0] ?? null;
        const subject = receipt?.subject ?? null;
        if (receipt?.outcome !== 'accepted' || !subject?.id) {
          setErrors({ general: applyRefusalText(receipt) });
          return;
        }
        let warning = null;
        if (receipt?.reasonCode === 'MATCHED_EXISTING') {
          warning = 'Esisteva già una scheda con questa email: eccola, senza duplicati.';
        }
        const phone = normalizeTelefono(values.telefono);
        if (phone !== '' && cleanEmail !== '') {
          try {
            const linked = await linkPhone(phone, cleanEmail, subject);
            if (token !== renderToken) return;
            if (!linked.ok) warning = linked.warning;
          } catch {
            if (token !== renderToken) return;
            warning = 'Il cliente è creato, ma il telefono non si è collegato. Riprova dalla scheda.';
          }
        }
        // Custom values, one governed write per touched field; a refused
        // value warns with the field's own Italian error, never blocks.
        for (const entry of customControls) {
          const key = entry.control.getAttribute('data-field-key');
          const typed = entry.read().trim();
          if (typed === '') continue;
          try {
            await saveFieldValue(client, { resource: subject.resource, id: subject.id, key, value: typed });
          } catch (err) {
            entry.setError(String(err?.message ?? 'Valore non valido.'));
            if (warning === null) warning = 'Il cliente è creato: controlla i campi evidenziati dalla scheda.';
          }
          if (token !== renderToken) return;
        }
        // The note through the single writer: it lands in the cronologia.
        const noteText = String(nota.value ?? '').trim();
        if (noteText !== '') {
          try {
            await postSubjectNote(client, { resource: subject.resource, id: subject.id, text: noteText });
          } catch {
            if (token !== renderToken) return;
            if (warning === null) warning = 'Il cliente è creato, ma la nota non si è salvata: aggiungila dalla scheda.';
          }
        }
        navigate(`#/customer-card/${subject.resource}/${subject.id}`);
        if (warning !== null) notify(warning);
      } catch (error) {
        if (token !== renderToken) return;
        const fieldName = error?.details?.field;
        if (typeof fieldName === 'string' && slots[fieldName]) {
          setErrors({ [fieldName]: String(error?.message ?? 'Valore non valido.') });
        } else {
          setErrors({ general: 'Non si è potuto creare il cliente. Riprova più tardi.' });
        }
      } finally {
        busy = false;
        save.disabled = false;
      }
    }

    async function linkPhone(phone, cleanEmail, subject) {
      const result = await client.request('/api/customer-data/import/apply', {
        method: 'POST',
        body: JSON.stringify({ system: MANUAL_PHONE_SYSTEM, rows: [{ externalId: phone, email: cleanEmail }], acceptance: 'partial' }),
      });
      const receipt = result?.receipts?.[0] ?? null;
      const linked = receipt?.outcome === 'accepted' && receipt?.subject?.id === subject.id;
      if (linked) return { ok: true, warning: null };
      if (receipt?.outcome === 'accepted') {
        return { ok: false, warning: 'Il cliente è creato, ma questo telefono risulta già collegato a un\u2019altra scheda.' };
      }
      return {
        ok: false,
        warning: `Il cliente è creato, ma il telefono non si è collegato (${customerImportReasonLabel(receipt?.reasonCode)}).`,
      };
    }

    /**
     * «✦ Scrivi o incolla»: the sentence area, the preview (base plus the
     * new fields it would create) and the human Conferma. Nothing writes
     * before Conferma; Annulla drops the preview.
     */
    function renderAiBox(box, preview, renderTokenAtBuild, ctx) {
      const title = el('p', 'bo-cliente-nuovo-ai-title', '✦ Scrivi o incolla');
      box.appendChild(title);
      const area = el('textarea', 'ui-field');
      area.setAttribute('name', 'frase');
      area.setAttribute('placeholder', 'es. daniele pelleri email daniele@gmail.com tel 234341 amico sì');
      area.setAttribute('aria-label', 'Descrivi il cliente in una frase');
      box.appendChild(area);
      const go = uiButton(doc, { variant: 'primary', label: 'Interpreta', attrs: { 'data-action': 'preview-phrase' } });
      box.appendChild(go);
      const error = el('small', 'field-error', '');
      box.appendChild(error);
      let working = false;
      go.addEventListener('click', async () => {
        if (working) return;
        const phrase = String(area.value ?? '').trim();
        if (phrase === '') {
          error.textContent = 'Scrivi una frase: almeno nome e un contatto.';
          return;
        }
        working = true;
        go.disabled = true;
        error.textContent = '';
        try {
          const draft = await previewPhrase(client, phrase);
          if (token !== renderToken || token !== renderTokenAtBuild) return;
          renderPreview(preview, draft, ctx);
        } catch (err) {
          if (token !== renderToken) return;
          error.textContent = String(err?.message ?? 'L\u2019AI non ha capito la frase: compila i campi a mano.');
        } finally {
          working = false;
          go.disabled = false;
        }
      });
    }

    function renderPreview(box, draft, ctx) {
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(el('h3', undefined, 'Anteprima: cosa salvo'));
      const customer = draft?.customer ?? {};
      const lines = [];
      const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
      if (fullName !== '') lines.push(['Nome', fullName]);
      if (customer.email) lines.push(['Email', customer.email]);
      if (customer.phone) lines.push(['Telefono', customer.phone]);
      if (customer.companyName) lines.push(['Azienda', customer.companyName]);
      for (const entry of draft?.fields ?? []) {
        lines.push([`${entry?.label ?? entry?.key ?? 'campo'}${entry?.isNew ? ' (campo nuovo)' : ''}`, entry?.value ?? '']);
      }
      if (draft?.note) lines.push(['Nota', draft.note]);
      if (lines.length === 0) {
        box.appendChild(el('p', 'bo-muted', 'La frase non dice abbastanza: scrivi almeno nome e un contatto.'));
        return;
      }
      for (const [label, value] of lines) {
        const row = el('p', 'bo-cliente-nuovo-preview-row');
        row.appendChild(el('span', 'bo-cliente-nuovo-preview-label', `${label}: `));
        row.appendChild(el('span', undefined, String(value)));
        box.appendChild(row);
      }
      if (Number(draft?.newFields ?? 0) > 0) {
        box.appendChild(el('p', 'bo-muted',
          'Alla conferma creo anche i campi nuovi: da lì sono in tutte le schede, nei filtri e nelle colonne.'));
      }
      const row = el('div', 'bo-cliente-nuovo-actions');
      const confirm = uiButton(doc, { variant: 'primary', label: 'Conferma e crea', attrs: { 'data-action': 'apply-phrase' } });
      const back = uiSecondaryButton(doc, 'Annulla');
      back.setAttribute('data-action', 'cancel-preview');
      row.appendChild(confirm);
      row.appendChild(back);
      box.appendChild(row);
      const error = el('small', 'field-error', '');
      box.appendChild(error);
      let working = false;
      back.addEventListener('click', () => {
        while (box.firstChild) box.removeChild(box.firstChild);
      });
      confirm.addEventListener('click', async () => {
        if (working) return;
        working = true;
        confirm.disabled = true;
        try {
          const applied = await applyPhrase(client, { customer: draft.customer, fields: draft.fields ?? [] });
          if (token !== renderToken) return;
          const subject = applied?.subject ?? null;
          if (!subject?.id) {
            error.textContent = 'Il cliente della frase non si è potuto creare: correggi i campi e riprova.';
            return;
          }
          let warning = null;
          if (applied?.matchedExisting) {
            warning = 'Esisteva già una scheda così: eccola, senza duplicati.';
          } else if (applied?.phoneWarning) {
            warning = 'Il cliente è creato, ma il telefono non si è collegato: aggiungilo dalla scheda.';
          }
          // The phrase note through the single writer, like the manual one.
          const noteText = String(draft?.note ?? '').trim() !== '' ? String(draft.note).trim() : String(nota.value ?? '').trim();
          if (noteText !== '') {
            try {
              await postSubjectNote(client, { resource: subject.resource, id: subject.id, text: noteText });
            } catch {
              if (token !== renderToken) return;
              if (warning === null) warning = 'Il cliente è creato, ma la nota non si è salvata: aggiungila dalla scheda.';
            }
          }
          navigate(`#/customer-card/${subject.resource}/${subject.id}`);
          if (warning !== null) ctx.notify(warning);
        } catch (err) {
          if (token !== renderToken) return;
          error.textContent = String(err?.message ?? 'Non si è potuto creare il cliente. Riprova più tardi.');
        } finally {
          working = false;
          confirm.disabled = false;
        }
      });
    }

    mount.appendChild(panel);
  }

  return { render, invalidate };
}
