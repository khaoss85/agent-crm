// @ts-check

import { elFor, uiButton, uiSecondaryButton } from './admin-ui.js'; // BO-F6-02: the single component library.
import { bindAdminMutations } from './admin-submission.js';
import { customerImportReasonLabel } from './admin-core.js';

/**
 * The "Nuovo cliente" form (backlog:273de560). "Aggiungi cliente → Compila
 * manualmente" opens this form on `#/clienti/nuovo`, not the JSON import
 * tool: the prototype's Clienti screen carries no import tool, and the
 * import stays a separate tool on `#/import-clienti`.
 *
 * Saving uses the same governed operation as the import tool —
 * `POST /api/customer-data/import/apply` with a single row — so matching,
 * dedup, idempotency and receipts apply to a hand-typed customer exactly
 * like to an imported row. The phone number rides a second single-row
 * apply under the `phone` system: a phone-bearing identity beside the
 * record, which is the only phone the framework stores (the contact
 * record carries no phone field).
 *
 * Stato and Nota have no framework home: the status is derived from signed
 * business and nothing stores a free note. Both fields stay visible with
 * an honest line saying so, and the PR states the non-coverage.
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

    const general = el('p', 'field-error bo-cliente-nuovo-error', '');
    general.setAttribute('data-general-error', '');
    panel.appendChild(general);

    const controls = {};
    const slots = {};
    const field = (name, label, control, help = null) => {
      const wrap = el('p', 'bo-cliente-nuovo-field');
      const tag = el('label', 'bo-cliente-nuovo-label', `${label}: `);
      wrap.appendChild(tag);
      wrap.appendChild(control);
      const slot = fieldErrorSlot();
      slot.setAttribute('data-field', name);
      wrap.appendChild(slot);
      if (help !== null) wrap.appendChild(el('small', 'bo-muted', help));
      controls[name] = control;
      slots[name] = slot;
      panel.appendChild(wrap);
      return control;
    };

    const nome = el('input', 'ui-field');
    nome.setAttribute('name', 'nome');
    nome.setAttribute('type', 'text');
    nome.setAttribute('placeholder', 'Mario Rossi');
    field('nome', 'Nome', nome);

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

    const nota = el('textarea', 'ui-field');
    nota.setAttribute('name', 'nota');
    nota.setAttribute('placeholder', 'Come ci ha conosciuti, cosa cerca…');
    field('nota', 'Nota', nota, 'La nota non si salva ancora: resta come follow-up.');

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
        navigate(`#/customer-card/${subject.resource}/${subject.id}`);
        if (warning !== null) notify(warning);
      } catch (error) {
        if (token !== renderToken) return;
        const field = error?.details?.field;
        if (typeof field === 'string' && slots[field]) {
          setErrors({ [field]: String(error?.message ?? 'Valore non valido.') });
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

    mount.appendChild(panel);
  }

  return { render, invalidate };
}
