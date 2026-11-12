// @ts-check

import { elFor, UI_BUSY_LOCKED, uiBusy, uiButton, uiSecondaryButton } from './admin-ui.js'; // BO-F6-02: the single component library.
import { bindAdminMutations } from './admin-submission.js';
import { customerImportReasonLabel } from './admin-core.js';
import { isSessionLostCode } from './admin-session.js';
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
/** Shown beside the form when the customer exists but its note was refused. */
export const NOTE_NOT_SAVED_WARNING = 'Cliente creato, ma la nota non è stata salvata: aggiungila dalla scheda.';

/**
 * B4 — the session may die while the operator is typing (backlog:5a40c73e54aa).
 * The half-written customer stays in this key, so the login round-trip the
 * shell performs on a lost session never eats a long note. Same shell
 * storage the other views use; nothing leaves the browser.
 */
export const NEW_CUSTOMER_DRAFT_KEY = 'accordo.nuovoClienteDraft.v1';
/** A kept draft older than this never comes back: stale PII stays unreadable. */
export const NEW_CUSTOMER_DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
/** Save steps after the customer exists, in run order, for resume bookkeeping. */
const DRAFT_STEPS = Object.freeze(['phone', 'custom', 'note']);

const cleanDraftText = (value) => (typeof value === 'string' ? value.slice(0, 4000) : '');

/** Space-scoped key: another space never reads this draft. Local dev (no space) keeps the base key. */
export function newCustomerDraftKey(spaceId) {
  if (typeof spaceId === 'string' && spaceId !== '') return `${NEW_CUSTOMER_DRAFT_KEY}.${spaceId}`;
  return NEW_CUSTOMER_DRAFT_KEY;
}

/** Tab-scoped draft store: the login round-trip is a same-tab replace, so the draft survives it, while another tab, operator or browser restart never sees it. Null where sessionStorage is unavailable (then the caller falls back). */
export function tabDraftStorage() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const base = window.sessionStorage;
      return {
        getItem: (key) => base.getItem(key),
        setItem: (key, value) => base.setItem(key, String(value)),
        removeItem: (key) => base.removeItem(key),
      };
    }
  } catch {
    // Private mode: no tab store, the caller falls back.
  }
  return null;
}

/** @param {{ spaceId?: unknown, operator?: unknown } | null | undefined} scope */
function scopeOf(scope) {
  const space = typeof scope?.spaceId === 'string' && scope.spaceId !== '' ? scope.spaceId : null;
  const operator = typeof scope?.operator === 'string' && scope.operator !== '' ? scope.operator : null;
  return { space, operator };
}

/** A draft shows only to the space and operator it was kept for; blanks match anything (local dev). */
function draftMatchesScope(draft, scope) {
  const { space, operator } = scopeOf(scope);
  if (space !== null && typeof draft?.space === 'string' && draft.space !== '' && draft.space !== space) return false;
  if (operator !== null && typeof draft?.by === 'string' && draft.by !== '' && draft.by !== operator) return false;
  return true;
}

const validCreated = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof value.resource === 'string' && value.resource !== ''
  && typeof value.id === 'string' && value.id !== ''
    ? { resource: value.resource, id: value.id }
    : null
);

const validDone = (value) => (
  Array.isArray(value) ? value.filter((step) => DRAFT_STEPS.includes(step)) : []
);

/**
 * The custom key/value pairs on screen when the session died. Comparison
 * only: the resume writes the live input, never this snapshot, so the
 * snapshot stays uncut (no silent tail loss) while keys stay bounded.
 */
const validCustomSnapshot = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const snapshot = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(snapshot).length >= 100) break;
    if (typeof key !== 'string' || key === '' || key.length > 200) continue;
    if (typeof entry !== 'string') continue;
    snapshot[key] = entry;
  }
  return snapshot;
};

/** @param {unknown} raw */
function parseDraft(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.savedAt !== 'number' || !(parsed.savedAt > 0)) return null;
  if (Date.now() - parsed.savedAt > NEW_CUSTOMER_DRAFT_TTL_MS) return null;
  const draft = {
    nome: cleanDraftText(parsed.nome),
    cognome: cleanDraftText(parsed.cognome),
    email: cleanDraftText(parsed.email),
    telefono: cleanDraftText(parsed.telefono),
    azienda: cleanDraftText(parsed.azienda),
    nota: cleanDraftText(parsed.nota),
    space: typeof parsed.space === 'string' && parsed.space !== '' ? parsed.space : null,
    by: typeof parsed.by === 'string' && parsed.by !== '' ? parsed.by : null,
    created: validCreated(parsed.created),
    done: validDone(parsed.done),
    custom: validCustomSnapshot(parsed.custom),
  };
  const texts = [draft.nome, draft.cognome, draft.email, draft.telefono, draft.azienda, draft.nota];
  if (texts.every((value) => value === '') && draft.created === null) return null;
  return draft;
}

/**
 * @param {{ getItem?: unknown, setItem?: unknown, removeItem?: unknown } | null | undefined} storage
 * @param {{ spaceId?: unknown, operator?: unknown } | null | undefined} [scope]
 */
export function readNewCustomerDraft(storage, scope) {
  try {
    const key = newCustomerDraftKey(scopeOf(scope).space);
    const raw = storage?.getItem?.(key);
    if (typeof raw === 'string' && raw !== '') {
      const draft = parseDraft(raw);
      if (draft !== null) return draftMatchesScope(draft, scope) ? draft : null;
      try { storage?.removeItem?.(key); } catch { /* Corrupt or expired: drop it. */ }
    }
    // A stale global draft never moves to another space or operator
    // (backlog:053d5cac): it is dropped, never adopted — the scoped key is
    // the only draft this scope reads.
    if (key !== NEW_CUSTOMER_DRAFT_KEY) {
      const legacy = storage?.getItem?.(NEW_CUSTOMER_DRAFT_KEY);
      if (typeof legacy === 'string' && legacy !== '') {
        try { storage?.removeItem?.(NEW_CUSTOMER_DRAFT_KEY); } catch { /* Dropped either way. */ }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {{ getItem?: unknown, setItem?: unknown, removeItem?: unknown } | null | undefined} storage
 * @param {{ nome?: unknown, cognome?: unknown, email?: unknown, telefono?: unknown, azienda?: unknown, nota?: unknown }} values
 * @param {{ spaceId?: unknown, operator?: unknown } | null | undefined} [scope]
 * @param {{ created?: unknown, done?: unknown, custom?: unknown } | null | undefined} [extra]
 */
export function saveNewCustomerDraft(storage, values, scope, extra) {
  try {
    const { space, operator } = scopeOf(scope);
    const created = validCreated(extra?.created);
    const draft = {
      nome: cleanDraftText(values?.nome),
      cognome: cleanDraftText(values?.cognome),
      email: cleanDraftText(values?.email),
      telefono: cleanDraftText(values?.telefono),
      azienda: cleanDraftText(values?.azienda),
      nota: cleanDraftText(values?.nota),
      space,
      by: operator,
      created,
      done: validDone(extra?.done),
      custom: validCustomSnapshot(extra?.custom),
      savedAt: Date.now(),
    };
    const texts = [draft.nome, draft.cognome, draft.email, draft.telefono, draft.azienda, draft.nota];
    if (texts.every((value) => value === '') && created === null) return false;
    storage?.setItem?.(newCustomerDraftKey(space), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ removeItem?: unknown } | null | undefined} storage
 * @param {{ spaceId?: unknown } | null | undefined} [scope]
 */
export function clearNewCustomerDraft(storage, scope) {
  try {
    storage?.removeItem?.(newCustomerDraftKey(scopeOf(scope).space));
    // A stale global key never survives beside the scoped one either.
    if (newCustomerDraftKey(scopeOf(scope).space) !== NEW_CUSTOMER_DRAFT_KEY) {
      storage?.removeItem?.(NEW_CUSTOMER_DRAFT_KEY);
    }
  } catch {
    // The draft simply stays until the next successful save.
  }
}

/**
 * A lost session is the one failure the login can cure: anything else keeps
 * its own error. Same signals the shell uses to leave for the space login
 * (sessionLostTarget): under a mount an expired session never answers
 * 401/403 JSON — fetch follows the host login redirect (redirected) or the
 * mount answers 200 login HTML (invalidResponse, thrown on as
 * INVALID_RESPONSE by the shell client).
 */
export function isNewCustomerSessionLoss(error) {
  if (error?.redirected === true || error?.invalidResponse === true) return true;
  const status = error?.status;
  if (status === 401) return true;
  if (status === 403 && isSessionLostCode(error?.code)) return true;
  return false;
}

/**
 * Resume identity, both sides normalized the same way: a trailing space
 * from a phone keyboard or a different case never defeats the resume.
 */
export function normalizeResumeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * One gate for every post-creation step (B4, backlog:5a40c73e54aa): a step
 * reruns when its live input is non-empty and the step never completed or
 * the input changed since the rescue — never on the step state alone, so
 * text typed after the rescue is written instead of silently dropped.
 */
export function stepNeedsRun(doneSet, step, before, now) {
  if (String(now ?? '').trim() === '') return false;
  if (!(doneSet instanceof Set) || !doneSet.has(step)) return true;
  return String(before ?? '').trim() !== String(now ?? '').trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {string} raw */
export function splitNome(raw) {
  const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? '';
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

/**
 * First and last name from the two fields (backlog:ff8bb60f417f: the same
 * Nome/Cognome pair the scheda's Modifica edits). An empty Cognome falls
 * back to splitting Nome, so a full name typed in one field still works.
 * @param {{ nome?: unknown, cognome?: unknown }} values
 */
export function customerNames(values) {
  const nome = String(values?.nome ?? '').trim().replace(/\s+/g, ' ');
  const cognome = String(values?.cognome ?? '').trim().replace(/\s+/g, ' ');
  if (cognome === '') return splitNome(nome);
  return { firstName: nome, lastName: cognome };
}

/** The full name both fields spell, for resume comparisons. @param {{ nome?: unknown, cognome?: unknown }} values */
export function customerFullName(values) {
  const { firstName, lastName } = customerNames(values);
  return [firstName, lastName].filter((part) => part !== '').join(' ');
}

/**
 * Same first and last name, field by field (review #791 giro 1): a moved
 * Nome/Cognome split spells the same full name but is a real change.
 * @param {{ nome?: unknown, cognome?: unknown }} left @param {{ nome?: unknown, cognome?: unknown }} right
 */
export function sameCustomerNames(left, right) {
  const a = customerNames(left);
  const b = customerNames(right);
  return a.firstName === b.firstName && a.lastName === b.lastName;
}

/** True when the form holds something the operator typed. @param {Record<string, unknown>} values */
export function hasTypedText(values) {
  return Object.values(values ?? {}).some((value) => String(value ?? '').trim() !== '');
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
 *   notify?: (message: string) => void, onSaved?: () => void, submissions?: any, storage?: any,
 *   draftStorage?: any, spaceId?: unknown, operator?: unknown}} deps
 */
export function createCustomerFormView(deps) {
  const { doc, mount, navigate = () => {}, notify = () => {}, onSaved = () => {} } = deps;
  // f0d425d0: the shell badge (Clienti count) refreshes on every creation.
  // A failing refresh never blocks the navigation to the new scheda.
  const emitSaved = () => {
    try { onSaved(); } catch { /* the badge stays stale, the scheda still opens */ }
  };
  const store = deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage);
  // The kept draft lives apart from the submissions store: tab-scoped, so a
  // login round-trip (same-tab replace) brings it back while another tab,
  // operator or restart never sees it.
  const drafts = deps.draftStorage ?? tabDraftStorage() ?? store;
  /** @param {unknown} value */
  const resolveScopeValue = (value) => {
    const resolved = typeof value === 'function' ? value() : value;
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  };
  const draftScope = () => ({ spaceId: resolveScopeValue(deps.spaceId), operator: resolveScopeValue(deps.operator) });
  const { client } = bindAdminMutations(deps.client, deps);
  const el = elFor(doc); // BO-F6-02: shared element builder.
  let renderToken = 0;
  /** The open window, so a second render or a route change closes this one only. */
  let openWindow = null;

  function closeWindow() {
    if (openWindow && openWindow.parentNode) openWindow.parentNode.removeChild(openWindow);
    openWindow = null;
  }

  /** Leaving the route closes the window and drops any save still in flight. */
  function invalidate() {
    renderToken += 1;
    closeWindow();
  }

  function fieldErrorSlot() {
    const slot = el('small', 'field-error', '');
    slot.setAttribute('data-field-error', '');
    return slot;
  }

  async function render() {
    const token = ++renderToken;
    closeWindow();

    // backlog:ff8bb60f417f: Nuovo cliente opens in a window over the list,
    // the same frame as the scheda's Scrivi and Nuova offerta — a dark head
    // with the purpose, minimize and close — never a page of its own. The
    // window shows at once with the focus on Nome; custom fields and the
    // AI area fill in when their reads answer.
    const win = el('div', 'bo-scheda-composer bo-cliente-panel');
    win.setAttribute('data-customer-panel', 'open');
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'Nuovo cliente');
    const head = el('div', 'bo-composer-head');
    head.appendChild(el('h4', 'bo-composer-title', 'Nuovo cliente'));
    const minimize = el('button', 'bo-composer-icon', '–');
    minimize.setAttribute('type', 'button');
    minimize.setAttribute('aria-label', 'Riduci');
    minimize.setAttribute('data-action', 'customer-minimize');
    minimize.addEventListener('click', () => {
      if (win.getAttribute('data-minimized') === 'true') win.removeAttribute('data-minimized');
      else win.setAttribute('data-minimized', 'true');
    });
    const closeButton = el('button', 'bo-composer-icon', '✕');
    closeButton.setAttribute('type', 'button');
    closeButton.setAttribute('aria-label', 'Chiudi');
    closeButton.setAttribute('data-action', 'customer-close');
    head.appendChild(minimize);
    head.appendChild(closeButton);
    win.appendChild(head);
    const body = el('div', 'bo-composer-body');
    win.appendChild(body);

    const panel = el('section', 'bo-cliente-nuovo');
    body.appendChild(panel);

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

    // Nome and Cognome apart, like the scheda's Modifica (backlog:ff8bb60f417f).
    const nome = el('input', 'ui-field');
    nome.setAttribute('name', 'nome');
    nome.setAttribute('type', 'text');
    nome.setAttribute('placeholder', 'Mario');
    nome.setAttribute('autocomplete', 'given-name');
    field('nome', 'Nome', nome);

    const cognome = el('input', 'ui-field');
    cognome.setAttribute('name', 'cognome');
    cognome.setAttribute('type', 'text');
    cognome.setAttribute('placeholder', 'Rossi');
    cognome.setAttribute('autocomplete', 'family-name');
    field('cognome', 'Cognome', cognome);

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
    azienda.parentNode?.classList?.add('is-wide');
    // No Stato here (backlog:ff8bb60f417f): nothing stores it — the state
    // comes from orders, contracts and subscriptions — and the scheda's
    // Modifica has none, so the two forms ask the same things.

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

    // B4: after the login round-trip the half-written customer is back, so
    // the operator checks it and presses Salva instead of retyping a long note.
    // When the customer already exists (kept mid-save), Salva resumes from
    // the failed step instead of creating a second scheda.
    const restored = readNewCustomerDraft(drafts, draftScope());
    if (restored !== null) {
      if (restored.nome !== '') nome.value = restored.nome;
      if (restored.cognome !== '') cognome.value = restored.cognome;
      if (restored.email !== '') email.value = restored.email;
      if (restored.telefono !== '') telefono.value = restored.telefono;
      if (restored.azienda !== '') azienda.value = restored.azienda;
      if (restored.nota !== '') nota.value = restored.nota;
      general.textContent = restored.created !== null
        ? 'Il cliente è già creato: controlla e premi Salva per completare.'
        : 'Bozza ripristinata dopo l\u2019accesso: controlla e premi Salva.';
    }

    const actions = el('div', 'bo-cliente-nuovo-actions');
    const save = uiButton(doc, { variant: 'primary', label: 'Salva', attrs: { 'data-action': 'save-customer' } });
    const cancel = uiSecondaryButton(doc, 'Annulla');
    cancel.setAttribute('data-action', 'cancel-customer');
    actions.appendChild(save);
    actions.appendChild(cancel);
    panel.appendChild(actions);
    // Annulla, ✕ or Esc with text typed asks first, inline, never with the
    // browser's confirm(): «Scarta» drops it, «Continua a scrivere» goes back.
    const discard = el('div', 'bo-cliente-nuovo-discard hidden');
    discard.setAttribute('role', 'alert');
    discard.setAttribute('data-discard', '');
    discard.appendChild(el('p', undefined, 'Scartare quello che hai scritto?'));
    const discardYes = uiButton(doc, { variant: 'danger', label: 'Scarta', attrs: { 'data-action': 'discard-customer' } });
    const discardNo = uiSecondaryButton(doc, 'Continua a scrivere');
    discardNo.setAttribute('data-action', 'keep-customer');
    discard.appendChild(discardYes);
    discard.appendChild(discardNo);
    panel.appendChild(discard);
    // A refused note (production 07/11: 400 BO_CRM_BODY_REFUSED, and the
    // operator saw nothing) keeps the operator on the form with this line
    // and the way to the scheda: the customer exists, only the note is
    // missing, so Salva stays off — a second Salva would only re-match.
    const noteWarning = el('p', 'field-error bo-cliente-nuovo-warning', '');
    noteWarning.setAttribute('data-note-warning', '');
    noteWarning.setAttribute('role', 'alert');
    panel.appendChild(noteWarning);

    const currentValues = () => ({
      nome: String(nome.value ?? ''),
      cognome: String(cognome.value ?? ''),
      email: String(email.value ?? ''),
      telefono: String(telefono.value ?? ''),
      azienda: String(azienda.value ?? ''),
      nota: String(nota.value ?? ''),
    });
    /** Custom controls join once their definitions arrive. @type {Array<any>} */
    let customControls = [];
    const typedSomething = () => hasTypedText(currentValues())
      || customControls.some((entry) => {
        try { return String(entry.read() ?? '').trim() !== ''; } catch { return false; }
      });
    const confirming = () => !discard.classList.contains('hidden');
    const leave = () => {
      clearNewCustomerDraft(drafts, draftScope());
      closeWindow();
      navigate('#/customer-data');
    };
    // The question takes the place of Salva/Annulla while it is asked.
    const keepWriting = () => {
      discard.classList.add('hidden');
      actions.classList.remove('hidden');
      nome.focus?.();
    };
    const requestClose = () => {
      if (confirming()) return;
      if (!typedSomething()) {
        leave();
        return;
      }
      actions.classList.add('hidden');
      discard.classList.remove('hidden');
      discard.scrollIntoView?.({ block: 'nearest' });
      discardNo.focus?.();
    };
    discardYes.addEventListener('click', leave);
    discardNo.addEventListener('click', keepWriting);
    closeButton.addEventListener('click', requestClose);
    cancel.addEventListener('click', requestClose);
    win.addEventListener('keydown', (event) => {
      if (event?.key !== 'Escape') return;
      event?.preventDefault?.();
      // Esc on the question keeps the text: the safe answer.
      if (confirming()) keepWriting();
      else requestClose();
    });

    // Salva works from the first moment (review #791 giro 1): a click that
    // lands while the reads below are still out waits for them, then saves.
    let setupDone = false;
    let saveQueued = false;
    // cta-loading: «Salvo…» while it works; a just-created customer keeps Salva off.
    const busySave = () => uiBusy(save, 'Salvo…', async () => { await saveCustomer(); return created ? UI_BUSY_LOCKED : undefined; });
    save.addEventListener('click', () => {
      if (setupDone) {
        void busySave();
        return;
      }
      saveQueued = true;
      save.disabled = true;
    });

    // The window shows now, before the reads below.
    mount.appendChild(win);
    openWindow = win;
    nome.focus?.();

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
    customControls = fieldDefs.map((def) => fieldControl(el, def));
    /** Set once the note-refused lock exists: a custom field added later lifts it too. */
    let watchCustomControl = (entry) => { void entry; };
    for (const entry of customControls) customBox.appendChild(entry.wrap);
    // After a real reload the kept custom values come back into the form
    // (backlog:053d5cac): the draft holds them, the defs above hold the
    // controls — fill each control whose key the draft kept.
    if (restored !== null && restored.custom !== null && typeof restored.custom === 'object') {
      for (const entry of customControls) {
        const rawKey = entry?.control?.getAttribute?.('data-field-key');
        const key = typeof rawKey === 'string' ? rawKey : '';
        if (key === '' || restored.custom[key] === undefined) continue;
        try {
          if (typeof entry?.set === 'function') entry.set(restored.custom[key]);
          else entry.control.value = String(restored.custom[key]);
        } catch {
          // An unrestorable value never breaks the form: type it by hand.
        }
      }
    }

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
            watchCustomControl(entry);
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
    let created = false;
    /** The customer exists but its note was refused: say so here, beside the form. */
    const showNoteRefused = (subject) => {
      created = true;
      // f0d425d0: the customer exists, so the badge recounts even though the
      // operator stays on the form to read the warning.
      emitSaved();
      save.disabled = true;
      while (noteWarning.firstChild) noteWarning.removeChild(noteWarning.firstChild);
      noteWarning.appendChild(el('span', undefined, `${NOTE_NOT_SAVED_WARNING} `));
      const open = uiSecondaryButton(doc, 'Apri la scheda');
      open.setAttribute('data-action', 'open-created-card');
      open.addEventListener('click', () => navigate(`#/customer-card/${subject.resource}/${subject.id}`));
      noteWarning.appendChild(open);
      notify(NOTE_NOT_SAVED_WARNING);
    };
    // Review #654: the lock belongs to the customer just created, not to the
    // form. Typing anything — another customer, or the same one with the
    // note to retry — lifts it: Salva works again and the warning goes.
    const releaseCreated = () => {
      if (!created) return;
      created = false;
      if (!busy) save.disabled = false;
      while (noteWarning.firstChild) noteWarning.removeChild(noteWarning.firstChild);
    };
    for (const control of [nome, cognome, email, telefono, azienda, nota]) {
      control.addEventListener('input', releaseCreated);
    }
    // Custom fields count as typing too (review #654, giro 3): a select
    // fires change, a text field input — and a field added later joins.
    const watchCustom = (entry) => {
      entry?.control?.addEventListener?.('input', releaseCreated);
      entry?.control?.addEventListener?.('change', releaseCreated);
    };
    for (const entry of customControls) watchCustom(entry);
    watchCustomControl = watchCustom;
    setupDone = true;
    if (saveQueued) {
      saveQueued = false;
      save.disabled = false;
      void busySave();
    }

    // The session may die after the customer exists (phone, custom value,
    // note). The shell is already leaving for the space login: keep the
    // unsaved remainder in the draft together with the created subject and
    // the steps already done, stay on the form with the session message,
    // never navigate away. After sign-in Salva resumes from the failed step
    // instead of creating a second scheda. True when the error was a lost
    // session (handled or invalidated: the save stops either way).
    const SESSION_KEPT_MESSAGE = 'Sessione scaduta: accedi di nuovo, il testo è conservato e lo ritrovi qui.';
    const SESSION_CREATED_MESSAGE = 'Sessione scaduta: il cliente è già creato, accedi di nuovo e premi Salva per completare.';
    // Shown only when the draft really failed to save (backlog:053d5cac):
    // «conservato» is a promise the browser could not keep.
    const SESSION_NOT_KEPT_MESSAGE = 'Sessione scaduta: accedi di nuovo. Il testo non si è salvato in questo browser: ricontrolla i campi dopo l\u2019accesso.';
    // B4 — resume bookkeeping is receipt-based (backlog:5a40c73e54aa): a
    // step counts as done only after its own write answered with success in
    // this run (the done list the caller passes, starting from the rescued
    // draft). A step skipped because its input was empty is never marked
    // done, so text typed after the rescue still runs on the next Salva
    // instead of being silently dropped.
    // The custom values on screen when the session died, for the resume to
    // compare against: the draft keeps them so a value typed or changed
    // after the rescue is written even when the custom step was done.
    const snapshotCustomValues = () => {
      const snapshot = {};
      for (const entry of customControls) {
        const key = entry?.control?.getAttribute?.('data-field-key');
        if (typeof key !== 'string' || key === '') continue;
        try {
          snapshot[key] = String(entry.read() ?? '').trim();
        } catch {
          // An unreadable control keeps no snapshot: the resume reruns it.
        }
      }
      return snapshot;
    };

    const rescueSessionLoss = (err, { subject = null, done = [] } = {}) => {
      if (!isNewCustomerSessionLoss(err)) return false;
      if (token !== renderToken) return true;
      const saved = saveNewCustomerDraft(drafts, currentValues(), draftScope(),
        { created: subject, done, custom: snapshotCustomValues() });
      const message = saved === true
        ? (subject === null ? SESSION_KEPT_MESSAGE : SESSION_CREATED_MESSAGE)
        : SESSION_NOT_KEPT_MESSAGE;
      setErrors({ general: message });
      notify(message);
      return true;
    };

    async function saveCustomer() {
      if (busy || created) return;
      const values = currentValues();
      const errors = validateCustomerForm(values);
      setErrors(errors);
      if (Object.keys(errors).length > 0) return;
      busy = true;
      save.disabled = true;
      try {
        const cleanEmail = values.email.trim();
        const cleanNome = customerFullName(values);
        const cleanAzienda = values.azienda.trim();
        // Resume: the customer may already exist from a session-loss rescue.
        // The rescue draft carries its subject: Salva resumes on it only
        // while the live form still overlaps it — a corrected email updates
        // the customer instead of duplicating it (backlog:053d5cac). A
        // wholly different customer typed after the rescue (no shared
        // identity at all) takes the full import/apply path, never a PATCH
        // over the already-created contact.
        const resumed = readNewCustomerDraft(drafts, draftScope());
        const kept = resumed?.created !== null && resumed?.created !== undefined
          && resumed?.created?.resource === 'contact' ? resumed : null;
        const keptEmail = kept !== null ? normalizeResumeEmail(kept.email) : '';
        const liveEmail = normalizeResumeEmail(cleanEmail);
        const keptNome = kept !== null ? customerFullName(kept) : '';
        const keptAzienda = kept !== null ? String(kept.azienda ?? '').trim() : '';
        const sameIdentity = kept !== null
          && keptEmail === liveEmail
          && sameCustomerNames(kept, values)
          && keptAzienda === cleanAzienda;
        // An empty email is no identity: two customers without an email are
        // not the same person, so the overlap needs a real address or the
        // same nome+azienda pair.
        const sameCustomer = kept !== null
          && ((keptEmail !== '' && keptEmail === liveEmail)
            || (keptNome === cleanNome && keptAzienda === cleanAzienda));
        let subject;
        let done = new Set();
        let warning = null;
        let updateWarning = null;
        if (sameIdentity) {
          // Nothing changed: reuse the subject and rerun only the steps that
          // never completed, never a second apply.
          subject = kept.created;
          done = new Set(kept.done);
        } else if (sameCustomer) {
          // Same customer, edited base fields: reuse the subject and write
          // the edits back instead of a second apply, which would only
          // duplicate it. Nome and email go through the scheda's governed
          // contact update (the same PATCH the scheda sends); Azienda has no
          // update route in the codebase (CompanyService creates, gets and
          // lists only), so a changed azienda is declared, never dropped
          // silently. DECISION (to be confirmed): keep the explicit azienda
          // warning until a governed company rename exists.
          subject = kept.created;
          done = new Set(kept.done);
          const namePatch = {};
          if (!sameCustomerNames(kept, values)) {
            const { firstName, lastName } = customerNames(values);
            namePatch.firstName = firstName;
            if (lastName !== '') namePatch.lastName = lastName;
          }
          if (normalizeResumeEmail(kept.email) !== normalizeResumeEmail(cleanEmail)) {
            namePatch.email = cleanEmail;
          }
          if (Object.keys(namePatch).length > 0) {
            try {
              await client.request(`/api/contacts/${encodeURIComponent(subject.id)}`, {
                method: 'PATCH',
                body: JSON.stringify(namePatch),
              });
              if (token !== renderToken) return;
            } catch (err) {
              if (rescueSessionLoss(err, { subject, done: [...done] })) return;
              if (token !== renderToken) return;
              updateWarning = 'Il cliente è creato, ma le modifiche non si sono salvate: cambiale dalla scheda.';
            }
          }
          if (String(kept.azienda ?? '').trim() !== cleanAzienda) {
            const aziendaWarning = 'Il cliente è già creato e l\u2019azienda cambiata non si è salvata: la scheda mostra quella precedente.';
            updateWarning = updateWarning === null ? aziendaWarning : `${updateWarning} ${aziendaWarning}`;
          }
        } else {
          const { firstName, lastName } = customerNames(values);
          const row = { firstName };
          if (lastName !== '') row.lastName = lastName;
          if (cleanEmail !== '') row.email = cleanEmail;
          if (cleanAzienda !== '') row.companyName = cleanAzienda;
          const result = await client.request('/api/customer-data/import/apply', {
            method: 'POST',
            body: JSON.stringify({ system: MANUAL_IMPORT_SYSTEM, rows: [row], acceptance: 'partial' }),
          });
          if (token !== renderToken) return;
          const receipt = result?.receipts?.[0] ?? null;
          const created = receipt?.subject ?? null;
          if (receipt?.outcome !== 'accepted' || !created?.id) {
            setErrors({ general: applyRefusalText(receipt) });
            return;
          }
          subject = created;
          if (receipt?.reasonCode === 'MATCHED_EXISTING') {
            warning = 'Esisteva già una scheda con questa email: eccola, senza duplicati.';
          }
        }
        // Steps confirmed by their own success receipt in this run, starting
        // from the rescued draft: only these are skipped on the next resume,
        // never a positional prefix of steps that may never have run.
        const completedNow = new Set(done);
        const phone = normalizeTelefono(values.telefono);
        // Never skip a phone the operator typed after the rescue: the kept
        // draft holds the rescued input, so a live input that differs reruns
        // the link even when an old draft claims the step is done.
        const rescuedPhone = kept !== null ? normalizeTelefono(kept.telefono ?? '') : '';
        if (cleanEmail !== '' && stepNeedsRun(done, 'phone', rescuedPhone, phone)) {
          try {
            const linked = await linkPhone(phone, cleanEmail, subject);
            if (token !== renderToken) return;
            // A refused link stays to do (backlog:053d5cac): only a linked
            // phone counts as done, so the resume retries it.
            if (linked.ok) {
              completedNow.add('phone');
            } else {
              warning = linked.warning;
            }
          } catch (err) {
            if (rescueSessionLoss(err, { subject, done: [...completedNow] })) return;
            if (token !== renderToken) return;
            warning = 'Il cliente è creato, ma il telefono non si è collegato. Riprova dalla scheda.';
          }
        }
        // Custom values, one governed write per touched field; a refused
        // value warns with the field's own Italian error, never blocks. A
        // rescued done=custom skips only the values that are still the
        // rescued ones: anything typed or changed after the rescue runs,
        // never dropped for the step state.
        const rescuedCustom = kept !== null ? validCustomSnapshot(kept.custom) : {};
        for (const entry of customControls) {
          const rawKey = entry.control.getAttribute('data-field-key');
          const key = typeof rawKey === 'string' ? rawKey : '';
          const typed = entry.read().trim();
          if (!stepNeedsRun(done, 'custom', rescuedCustom[key] ?? '', typed)) continue;
          try {
            await saveFieldValue(client, { resource: subject.resource, id: subject.id, key, value: typed });
          } catch (err) {
            if (rescueSessionLoss(err, { subject, done: [...completedNow] })) return;
            entry.setError(String(err?.message ?? 'Valore non valido.'));
            if (warning === null) warning = 'Il cliente è creato: controlla i campi evidenziati dalla scheda.';
          }
          if (token !== renderToken) return;
        }
        completedNow.add('custom');
        // The note through the single writer: it lands in the cronologia.
        const noteText = String(nota.value ?? '').trim();
        const rescuedNote = kept !== null ? String(kept.nota ?? '').trim() : '';
        if (stepNeedsRun(done, 'note', rescuedNote, noteText)) {
          try {
            await postSubjectNote(client, { resource: subject.resource, id: subject.id, text: noteText });
          } catch (err) {
            if (rescueSessionLoss(err, { subject, done: [...completedNow] })) return;
            if (token !== renderToken) return;
            showNoteRefused(subject);
            return;
          }
          if (token !== renderToken) return;
        }
        // Base-field edits written back above join the part-step warnings so
        // a later step failure can never overwrite them into silence.
        if (updateWarning !== null) warning = warning === null ? updateWarning : `${warning} ${updateWarning}`;
        clearNewCustomerDraft(drafts, draftScope());
        closeWindow();
        navigate(`#/customer-card/${subject.resource}/${subject.id}`);
        emitSaved();
        // backlog:ff8bb60f417f: every save says so; a part that failed says
        // what is left to do instead.
        notify(warning ?? 'Cliente creato.');
      } catch (error) {
        if (token !== renderToken) return;
        if (isNewCustomerSessionLoss(error)) {
          // B4: the shell is already taking the browser to the space login
          // (moduleClient navigates on a lost session). The typed text —
          // a long note above all — stays in storage, so signing back in
          // reopens this form with everything still here. Nothing writes:
          // the customer is created only after the new login, with Salva.
          // «conservato» only when the draft really saved (backlog:053d5cac).
          const saved = saveNewCustomerDraft(drafts, currentValues(), draftScope());
          const message = saved === true ? SESSION_KEPT_MESSAGE : SESSION_NOT_KEPT_MESSAGE;
          setErrors({ general: message });
          notify(message);
          return;
        }
        const fieldName = error?.details?.field;
        if (typeof fieldName === 'string' && slots[fieldName]) {
          setErrors({ [fieldName]: String(error?.message ?? 'Valore non valido.') });
        } else {
          setErrors({ general: 'Non si è potuto creare il cliente. Riprova più tardi.' });
        }
      } finally {
        busy = false;
        save.disabled = created;
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
      go.addEventListener('click', () => uiBusy(go, 'Interpreto…', async () => {
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
      }));
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
      confirm.addEventListener('click', () => uiBusy(confirm, 'Creo…', async () => {
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
              // Conferma stays (review #654, giro 3): a second press matches
              // the same customer and retries the note.
              showNoteRefused(subject);
              return;
            }
          }
          closeWindow();
          navigate(`#/customer-card/${subject.resource}/${subject.id}`);
          emitSaved();
          ctx.notify(warning ?? 'Cliente creato.');
        } catch (err) {
          if (token !== renderToken) return;
          error.textContent = String(err?.message ?? 'Non si è potuto creare il cliente. Riprova più tardi.');
        } finally {
          working = false;
          confirm.disabled = false;
        }
      }));
    }

  }

  return { render, invalidate };
}
