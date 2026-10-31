// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.

import {
  customerDataDeferredLine,
  customerImportOutcomeLabel,
  customerImportReasonLabel,
  customerIssueKindLabel,
  customerResourceLabel,
  humanReadError,
} from './admin-core.js';
import {
  buildImportRows,
  fieldLabel,
  guessMapping,
  IMPORT_FIELDS,
  isWorkbookName,
  parseCsvText,
  splitPhoneRows,
  WORKBOOK_REFUSAL,
} from './admin-import-file.js';
import { bindAdminMutations } from './admin-submission.js';

/**
 * **The Clienti import tool (ADR-037).**
 *
 * Since backlog:80b25fb0 this is its own screen (`#/import-clienti`), not a
 * section below the Clienti table: the prototype's Clienti screen carries no
 * import, so the list (`admin-clienti.js`, route `#/customer-data`) renders
 * alone. Since backlog:5b164ab5 the tool reads like the rest of the /bo —
 * kicker, title, back link and breadcrumb — and walks the operator through
 * three steps: load a CSV file, match its columns to the customer fields,
 * check the table preview (which writes nothing and says so) and apply.
 * The tool reaches this screen only through the list's entries — there is no
 * sidebar voice for it, like the prototype.
 *
 * It renders only while `/api/schema` publishes `domains['customer-data']`;
 * an absent package names itself in the view (like every other uncomposed
 * section) because a reachable route that renders nothing reads as broken
 * navigation.
 *
 * The governance half below the tool (runs, duplicate candidates, data
 * quality) is unchanged: everything the operator can do there is preview an
 * import, apply one, or decide something a human must decide. The limits are
 * rendered **as content, in every state** — not in a tooltip, not in a
 * footnote — because the honest thing about this surface is mostly what it
 * does not do.
 *
 * The section is package-scoped but lives in the Admin app: the framework has
 * no seam for a package to contribute an Admin extension, which AX1 publishes
 * as `ADMIN_EXTENSIONS_UNSUPPORTED`.
 */

/** The five sentences this section always carries, verbatim, in every state. */
export const CUSTOMER_DATA_DISCLAIMERS = Object.freeze([
  'Gli abbinamenti sono solo esatti: nessun punteggio, nessun tentativo. Se resta un dubbio, la riga aspetta una persona.',
  'Collegare due schede non cancella nulla: restano tutte e due e si continua a trovarle tutte e due.',
  'Niente magazzini e niente sistemi esterni: la pagina legge solo le righe che le passi tu.',
  'A decidere è una persona con il proprio accesso, per tracciabilità: non un controllo di ruoli.',
  'Questa pagina non dice nulla su privacy, consensi o cancellazioni.',
]);

const MAX_PREVIEW_ROWS = 25;

/**
 * The stored acceptance mode in the operator's words; an unknown value
 * renders as it is stored, never as a blank.
 * @param {unknown} mode
 */
function acceptanceLabel(mode) {
  if (mode === 'partial') return 'parziale';
  if (mode === 'all_or_nothing') return 'tutto o niente';
  if (mode == null || mode === '') return 'non specificata';
  return String(mode);
}

function block(el, panel, meta) {
  const limits = el('div', 'customer-data-limits');
  limits.appendChild(el('h4', undefined, 'Cosa non fa'));
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) {
    limits.appendChild(el('p', 'muted customer-data-limit', sentence));
  }
  const deferred = meta?.deferred;
  if (deferred && (deferred.track || (deferred.items ?? []).length > 0)) {
    // backlog:273de560: the deferred track reads in Italian — the import
    // screen is an operator tool, not a developer surface.
    limits.appendChild(el('p', 'muted customer-data-deferred', customerDataDeferredLine(deferred)));
  }
  panel.appendChild(limits);
}

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   notify?: (message: string) => void, spaceId?: string | (() => (string | null | undefined)),
 *   onAskAi?: ((question: string) => void) | null, storage?: any}} deps
 */
export function createCustomerDataView(deps) {
  const { doc, mount, navigate = () => {}, notify = () => {} } = deps;
  void navigate;
  void notify;
  const { client } = bindAdminMutations(deps.client, deps);
  const el = elFor(doc); // BO-F6-02: shared element builder.
  const fact = (label, value) => {
    const row = el('p', 'fact');
    row.appendChild(el('span', 'fact-label', `${label}: `));
    row.appendChild(el('span', 'fact-value', value === null || value === undefined ? '—' : String(value)));
    return row;
  };

  let busy = [];
  /**
   * The loaded file and its mapping, kept across re-renders.
   *
   * The whole point of this surface is *load, match the columns, preview the
   * table, then apply the same rows*. A preview re-renders the panel, so
   * without this the mapping would come back blank and Apply would refuse
   * the operator's own file — the primary flow would be unusable.
   */
  const fileState = { file: null, preview: null, applied: '' };

  /**
   * The workspace name for the breadcrumb, when the host provides it; an
   * unknown workspace leaves the crumb at «Clienti / Importa» rather than a
   * blank segment.
   */
  function resolveSpaceName() {
    const raw = deps.spaceName;
    const value = typeof raw === 'function' ? raw() : raw;
    return typeof value === 'string' ? value : '';
  }
  const withBusy = async (work) => {
    for (const control of busy) control.disabled = true;
    try {
      await work();
      await render();
    } catch (error) {
      const line = mount.querySelector ? mount.querySelector('.customer-data-error') : null;
      if (line) line.textContent = error?.message ?? 'La richiesta non è riuscita';
      else throw error;
    } finally {
      for (const control of busy) control.disabled = false;
    }
  };

  async function render() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    busy = [];
    let schema;
    try {
      schema = await client.request('/api/schema');
    } catch (error) {
      mount.appendChild(el('p', 'field-error', humanReadError(error, {
        failed: 'Lo schema non si è potuto leggere. Riprova più tardi.',
      })));
      return;
    }
    const meta = schema?.domains?.['customer-data']?.metadata ?? schema?.domains?.['customer-data'];
    if (!meta) {
      // Optional package, not composed: name it instead of a blank screen —
      // a reachable route that renders nothing reads as broken navigation.
      mount.appendChild(el('p', 'empty customer-data-uncomposed',
        'Clienti non composto in questo spazio.'));
      return;
    }

    const panel = el('div', 'customer-data-section');
    panel.setAttribute('data-contract', String(meta.customerDataContract ?? ''));
    const maxRows = meta.import?.maxRows ?? 500;

    // ── header: kicker, title, back link and breadcrumb, like the scheda ──
    const crumb = el('nav', 'bo-import-crumb');
    crumb.setAttribute('aria-label', 'Percorso');
    const spaceName = resolveSpaceName();
    if (spaceName !== '') {
      crumb.appendChild(el('span', 'bo-import-crumb-space', spaceName));
      crumb.appendChild(el('span', 'bo-import-crumb-sep', ' / '));
    }
    const clientiLink = el('a', 'bo-import-crumb-link', 'Clienti');
    clientiLink.setAttribute('href', '#/customer-data');
    crumb.appendChild(clientiLink);
    crumb.appendChild(el('span', 'bo-import-crumb-sep', ' / '));
    const current = el('span', 'bo-import-crumb-current', 'Importa');
    current.setAttribute('aria-current', 'page');
    crumb.appendChild(current);
    panel.appendChild(crumb);

    const back = el('button', 'bo-scheda-back', '← Clienti');
    back.setAttribute('type', 'button');
    back.setAttribute('data-action', 'back-to-clienti');
    back.addEventListener('click', () => navigate('#/customer-data'));
    panel.appendChild(back);

    panel.appendChild(el('p', 'bo-kicker', 'Clienti'));
    panel.appendChild(el('h1', 'bo-import-title', 'Importa clienti'));
    panel.appendChild(el('p', 'muted',
      'Dal file alla scheda: carichi, abbini le colonne, controlli e importi.'));

    const error = el('small', 'field-error customer-data-error', '');
    panel.appendChild(error);

    /** Read the chosen file and keep its columns and guessed mapping. */
    const loadChosenFile = async (file) => {
      const name = String(file?.name ?? '');
      // No zip/XML reader lives in the Admin app: a hand-rolled workbook
      // parser would guess dates and mangle them into customer records, so
      // workbooks are refused with an honest line (backlog:5b164ab5).
      if (isWorkbookName(name)) throw new Error(WORKBOOK_REFUSAL);
      if (typeof file?.arrayBuffer !== 'function') {
        throw new Error('Questo file non si apre: usa un CSV.');
      }
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder('utf-8').decode(bytes);
      const parsed = parseCsvText(text);
      if (parsed.columns.length === 0) throw new Error('Il file non contiene righe da importare.');
      if (parsed.rows.length > maxRows) {
        throw new Error(`Il file ha ${parsed.rows.length} righe: il massimo è ${maxRows} per volta. Dividilo in più file.`);
      }
      fileState.file = {
        name,
        columns: parsed.columns,
        rows: parsed.rows,
        mapping: guessMapping(parsed.columns),
        system: slugFromFileName(name),
        acceptance: 'partial',
      };
      fileState.preview = null;
      fileState.applied = '';
    };

    // ── passo 1: carica il file ──────────────────────────────────────────
    const importBox = el('div', 'customer-data-import');
    importBox.appendChild(el('h2', undefined, '1. Carica il file'));
    importBox.appendChild(el('p', 'muted',
      `Un file CSV, al massimo ${maxRows} righe per volta. I fogli Excel si salvano come CSV prima di caricarli.`));
    const drop = el('div', 'bo-import-drop');
    drop.setAttribute('data-drop', 'customer-import');
    drop.appendChild(el('p', 'bo-import-drop-text', 'Trascina qui il file oppure'));
    const fileInput = el('input');
    fileInput.setAttribute('type', 'file');
    fileInput.setAttribute('name', 'file');
    fileInput.setAttribute('accept', '.csv,text/csv');
    fileInput.setAttribute('aria-label', 'Scegli il file CSV');
    fileInput.addEventListener('change', () => withBusy(async () => {
      const chosen = fileInput.files?.[0];
      if (!chosen) return;
      await loadChosenFile(chosen);
    }));
    drop.appendChild(fileInput);
    drop.addEventListener('dragover', (event) => {
      event?.preventDefault?.();
      drop.classList.add('bo-import-drop-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('bo-import-drop-over'));
    drop.addEventListener('drop', (event) => {
      event?.preventDefault?.();
      drop.classList.remove('bo-import-drop-over');
      const chosen = event?.dataTransfer?.files?.[0];
      if (!chosen) return;
      void withBusy(async () => { await loadChosenFile(chosen); });
    });
    importBox.appendChild(drop);
    if (fileState.file) {
      importBox.appendChild(el('p', 'bo-import-file',
        `File «${fileState.file.name}»: ${fileState.file.rows.length} righe, ${fileState.file.columns.length} colonne.`));
    }
    panel.appendChild(importBox);

    // ── passo 2: abbina le colonne ───────────────────────────────────────
    if (fileState.file) {
      const file = fileState.file;
      const mapBox = el('div', 'customer-data-mapping');
      mapBox.appendChild(el('h2', undefined, '2. Abbina le colonne'));
      mapBox.appendChild(el('p', 'muted', 'Ogni colonna del file va al campo giusto. Quelle su «Ignora» non si importano.'));
      file.columns.forEach((column, index) => {
        const row = el('p', 'customer-data-mapping-row');
        row.appendChild(el('strong', undefined, `${column === '' ? `Colonna ${index + 1}` : column}: `));
        const select = el('select');
        select.setAttribute('name', `mapping-${index}`);
        for (const field of IMPORT_FIELDS) {
          const option = el('option', undefined, field.label);
          option.setAttribute('value', field.value);
          select.appendChild(option);
        }
        // Set explicitly: a control whose value depends on the browser's
        // implicit first-option selection sends '' somewhere else.
        select.value = file.mapping[index] ?? 'ignore';
        select.addEventListener('change', () => withBusy(async () => {
          file.mapping[index] = String(select.value ?? 'ignore');
          // The preview belongs to a mapping: a changed column clears it.
          fileState.preview = null;
          fileState.applied = '';
        }));
        row.appendChild(select);
        mapBox.appendChild(row);
      });
      const systemRow = el('p', 'customer-data-field');
      systemRow.appendChild(el('strong', undefined, 'Sistema di origine: '));
      const systemInput = el('input');
      systemInput.setAttribute('name', 'system');
      systemInput.value = file.system;
      systemInput.addEventListener('input', () => { file.system = String(systemInput.value ?? ''); });
      systemInput.addEventListener('change', () => { file.system = String(systemInput.value ?? ''); });
      systemRow.appendChild(systemInput);
      systemRow.appendChild(el('small', 'muted', ' Un nome breve: da dove vengono questi clienti.'));
      mapBox.appendChild(systemRow);
      const acceptanceRow = el('p', 'customer-data-field');
      acceptanceRow.appendChild(el('strong', undefined, 'Come importare: '));
      const acceptance = el('select');
      acceptance.setAttribute('name', 'acceptance');
      for (const mode of meta.import?.acceptance ?? ['partial', 'all_or_nothing']) {
        const option = el('option', undefined, mode === 'partial' ? 'Parziale: tiene le righe buone e segnala le altre' : 'Tutto o niente: una riga sbagliata ferma tutto');
        option.setAttribute('value', mode);
        acceptance.appendChild(option);
      }
      // Set explicitly: a control whose value depends on the browser's
      // implicit first-option selection sends '' somewhere else.
      acceptance.value = file.acceptance;
      acceptance.addEventListener('change', () => { file.acceptance = String(acceptance.value ?? 'partial'); });
      acceptanceRow.appendChild(acceptance);
      mapBox.appendChild(acceptanceRow);
      panel.appendChild(mapBox);

      // ── passo 3: controlla e importa ──────────────────────────────────
      const { rows: built, skippedEmpty } = buildImportRows(file.columns, file.rows, file.mapping);
      const { phones, unlinkedPhones } = splitPhoneRows(file.rows, file.mapping);
      const checkBox = el('div', 'customer-data-check');
      checkBox.appendChild(el('h2', undefined, '3. Controlla e importa'));
      const infoBits = [`${built.length} righe da importare`];
      if (skippedEmpty > 0) infoBits.push(`${skippedEmpty} righe vuote saltate`);
      if (phones.length > 0) infoBits.push(`${phones.length} telefoni da collegare`);
      if (unlinkedPhones > 0) infoBits.push(`${unlinkedPhones} telefoni senza email non si collegano`);
      checkBox.appendChild(el('p', 'muted bo-import-info', `${infoBits.join(' · ')}.`));
      checkBox.appendChild(el('p', 'muted customer-data-preview-writes', 'L\u2019anteprima non scrive nulla: né schede né importazioni.'));

      const shownColumns = file.mapping
        .map((target, index) => ({ target, index }))
        .filter((cell) => cell.target !== 'ignore');
      if (shownColumns.length > 0) {
        const table = el('table', 'bo-import-table');
        const head = el('tr', undefined);
        for (const cell of shownColumns) head.appendChild(el('th', undefined, fieldLabel(cell.target)));
        head.appendChild(el('th', undefined, 'Esito'));
        table.appendChild(head);
        const receiptByFileIndex = new Map();
        for (const receipt of fileState.preview?.receipts ?? []) {
          const sent = built[receipt.index];
          if (sent) receiptByFileIndex.set(sent.fileIndex, receipt);
        }
        for (const [fileIndex, cells] of file.rows.slice(0, MAX_PREVIEW_ROWS).entries()) {
          const tr = el('tr', undefined);
          for (const cell of shownColumns) {
            const value = String(cells[cell.index] ?? '').trim();
            tr.appendChild(el('td', undefined, value === '' ? '—' : value));
          }
          const receipt = receiptByFileIndex.get(fileIndex);
          tr.appendChild(el('td', 'bo-import-esito', receipt
            ? `${customerImportOutcomeLabel(receipt.outcome)} · ${customerImportReasonLabel(receipt.reasonCode)}`
            : '—'));
          table.appendChild(tr);
        }
        // Wide on a phone: the table scrolls inside its own frame, never the page.
        const tableWrap = el('div', 'bo-import-table-wrap');
        tableWrap.appendChild(table);
        checkBox.appendChild(tableWrap);
      }

      if (fileState.preview) {
        const counts = fileState.preview.counts ?? {};
        checkBox.appendChild(el('p', 'bo-import-counts',
          `Anteprima: ${counts.rows ?? 0} righe, ${counts.accepted ?? 0} accettate, ${counts.rejected ?? 0} scartate, ${counts.skipped ?? 0} da decidere.`));
      }
      if (fileState.applied !== '') {
        checkBox.appendChild(el('p', 'bo-import-applied', fileState.applied));
      }

      const previewButton = el('button', undefined, 'Anteprima (non scrive nulla)');
      previewButton.setAttribute('data-action', 'preview-customer-import');
      busy.push(previewButton);
      previewButton.addEventListener('click', () => withBusy(async () => {
        if (built.length === 0) throw new Error('Nessuna riga da importare: abbina almeno una colonna.');
        const result = await client.request('/api/customer-data/import/preview', {
          method: 'POST',
          body: JSON.stringify({
            system: file.system === '' ? slugFromFileName(file.name) : file.system,
            rows: built.map((entry) => entry.values),
            acceptance: file.acceptance,
          }),
        });
        fileState.preview = result;
        fileState.applied = '';
      }));

      const applyButton = el('button', undefined, 'Applica importazione');
      applyButton.setAttribute('data-action', 'apply-customer-import');
      busy.push(applyButton);
      applyButton.addEventListener('click', () => withBusy(async () => {
        if (built.length === 0) throw new Error('Nessuna riga da importare: abbina almeno una colonna.');
        const system = file.system === '' ? slugFromFileName(file.name) : file.system;
        const applied = await client.request('/api/customer-data/import/apply', {
          method: 'POST',
          body: JSON.stringify({ system, rows: built.map((entry) => entry.values), acceptance: file.acceptance }),
        });
        const counts = applied?.counts ?? countReceipts(applied?.receipts ?? []);
        let summary = `Importazione registrata: ${counts.accepted ?? 0} accettate, ${counts.rejected ?? 0} scartate, ${counts.skipped ?? 0} da decidere.`;
        if (phones.length > 0) {
          try {
            const linked = await client.request('/api/customer-data/import/apply', {
              method: 'POST',
              body: JSON.stringify({ system: 'phone', rows: phones, acceptance: file.acceptance }),
            });
            const phoneCounts = countReceipts(linked?.receipts ?? []);
            summary += ` Telefoni: ${phoneCounts.accepted ?? 0} collegati su ${phones.length}.`;
          } catch {
            summary += ' I telefoni non si sono collegati: tocca reimportare solo quella colonna, oppure aggiungerli dalla scheda.';
          }
        }
        if (unlinkedPhones > 0) summary += ` ${unlinkedPhones} telefoni senza email non si collegano.`;
        fileState.preview = null;
        fileState.applied = summary;
      }));

      checkBox.appendChild(previewButton);
      checkBox.appendChild(applyButton);
      panel.appendChild(checkBox);
    }

    // ── runs, candidates, issues ──────────────────────────────────────────
    const [runsRead, candidatesRead, issuesRead] = await Promise.all([
      rowsOf('customer-import-run'), rowsOf('duplicate-candidate'), rowsOf('data-quality-issue'),
    ]);
    const runs = runsRead.items;
    const candidates = candidatesRead.items;
    const issues = issuesRead.items;

    const runBox = el('div', 'customer-data-runs');
    listHeading(runBox, runsRead, 'Importazioni', String(runs.length));
    for (const run of runs.slice(0, 20)) {
      const row = el('p', 'customer-data-run');
      row.setAttribute('data-run', String(run.id));
      row.appendChild(el('span', undefined,
        `${run.system} · ${run.rowCount} righe · ${run.acceptedCount} accettate · ${run.rejectedCount} scartate · ${run.skippedCount} da decidere · ${acceptanceLabel(run.acceptance)}`));
      runBox.appendChild(row);
    }
    panel.appendChild(runBox);

    const candidateBox = el('div', 'customer-data-candidates');
    const open = candidates.filter((row) => row.status === 'unresolved');
    listHeading(candidateBox, candidatesRead, 'Possibili doppioni', `${open.length} da decidere`);
    candidateBox.appendChild(el('p', 'muted', 'Queste le decidi tu: collegare non cancella nulla.'));
    for (const candidate of open.slice(0, 20)) {
      const row = el('div', 'customer-data-candidate');
      row.setAttribute('data-candidate', String(candidate.id));
      row.appendChild(el('p', 'customer-data-candidate-pair',
        `${customerResourceLabel(candidate.leftResource)} ${candidate.leftLabel ?? candidate.leftId} ↔ ${customerResourceLabel(candidate.rightResource)} ${candidate.rightLabel ?? candidate.rightId}`));
      row.appendChild(el('p', 'muted customer-data-candidate-evidence', `${candidate.rule}: ${candidate.evidence}`));

      const reason = el('input');
      reason.setAttribute('name', `reason-${candidate.id}`);
      reason.setAttribute('placeholder', 'Perché (obbligatorio, resta registrato a tuo nome)');
      const canonical = el('select');
      canonical.setAttribute('name', `canonical-${candidate.id}`);
      for (const side of ['left', 'right']) {
        const option = el('option', undefined, `${candidate[`${side}Resource`]} ${candidate[`${side}Label`] ?? candidate[`${side}Id`]}`);
        option.setAttribute('value', `${candidate[`${side}Resource`]}:${candidate[`${side}Id`]}`);
        canonical.appendChild(option);
      }
      canonical.value = `${candidate.leftResource}:${candidate.leftId}`;
      const linkButton = el('button', undefined, 'Collega come unico cliente');
      linkButton.setAttribute('data-action', 'link-canonical-identity');
      busy.push(linkButton);
      linkButton.addEventListener('click', () => withBusy(async () => {
        const value = String(canonical.value ?? '');
        const [resource, id] = value.split(':');
        if (!resource || !id) throw new Error('Scegli quale scheda tenere come principale.');
        await client.request(`/api/modules/duplicate-candidate/records/${encodeURIComponent(candidate.id)}/actions/link-canonical-identity`, {
          method: 'POST',
          body: JSON.stringify({ canonicalResource: resource, canonicalId: id, reason: String(reason.value ?? '') }),
        });
      }));
      const dismissButton = el('button', 'danger', 'Non è lo stesso cliente');
      dismissButton.setAttribute('data-action', 'dismiss-duplicate-candidate');
      busy.push(dismissButton);
      dismissButton.addEventListener('click', () => withBusy(async () => {
        await client.request(`/api/modules/duplicate-candidate/records/${encodeURIComponent(candidate.id)}/actions/dismiss-duplicate-candidate`, {
          method: 'POST', body: JSON.stringify({ reason: String(reason.value ?? '') }),
        });
      }));
      row.appendChild(reason);
      row.appendChild(canonical);
      row.appendChild(linkButton);
      row.appendChild(dismissButton);
      candidateBox.appendChild(row);
    }
    panel.appendChild(candidateBox);

    const issueBox = el('div', 'customer-data-issues');
    const openIssues = issues.filter((row) => row.status === 'open');
    listHeading(issueBox, issuesRead, 'Qualità dei dati', `${openIssues.length} aperte`);
    issueBox.appendChild(el('p', 'muted', 'Ogni decisione resta registrata con chi l\u2019ha presa e perché. La segnalazione e le sue prove restano.'));
    for (const issue of openIssues.slice(0, 20)) {
      const row = el('div', 'customer-data-issue');
      row.setAttribute('data-issue', String(issue.id));
      row.setAttribute('data-kind', String(issue.kind));
      row.appendChild(el('p', 'customer-data-issue-kind', customerIssueKindLabel(issue.kind)));
      row.appendChild(el('p', 'muted customer-data-issue-evidence', issue.evidence));
      const reason = el('input');
      reason.setAttribute('name', `issue-reason-${issue.id}`);
      reason.setAttribute('placeholder', 'Perché (obbligatorio)');
      const decision = el('select');
      decision.setAttribute('name', `issue-decision-${issue.id}`);
      for (const value of ['resolved', 'dismissed']) {
        const option = el('option', undefined, value === 'resolved' ? 'Risolto: i dati sono stati corretti' : 'Archiviato: va bene così');
        option.setAttribute('value', value);
        decision.appendChild(option);
      }
      decision.value = 'resolved';
      const governButton = el('button', undefined, 'Registra decisione');
      governButton.setAttribute('data-action', 'govern-data-quality-issue');
      busy.push(governButton);
      governButton.addEventListener('click', () => withBusy(async () => {
        await client.request(`/api/modules/data-quality-issue/records/${encodeURIComponent(issue.id)}/actions/govern-data-quality-issue`, {
          method: 'POST', body: JSON.stringify({ decision: String(decision.value ?? 'resolved'), reason: String(reason.value ?? '') }),
        });
      }));
      row.appendChild(reason);
      row.appendChild(decision);
      row.appendChild(governButton);
      issueBox.appendChild(row);
    }
    panel.appendChild(issueBox);

    block(el, panel, meta);
    mount.appendChild(panel);
  }

  /**
   * A short slug for the import origin, from the file name: «Clienti
   * Ottobre.csv» becomes «clienti-ottobre». The operator can change it.
   * @param {string} name
   */
  function slugFromFileName(name) {
    const base = String(name ?? '').replace(/\.[^.]*$/, '');
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'file-importato' : slug;
  }

  /**
   * Count outcomes when the server answers with receipts but no counts.
   * @param {any[]} receipts
   */
  function countReceipts(receipts) {
    const counts = { accepted: 0, rejected: 0, skipped: 0 };
    for (const receipt of receipts ?? []) {
      if (receipt?.outcome === 'accepted') counts.accepted += 1;
      else if (receipt?.outcome === 'rejected') counts.rejected += 1;
      else counts.skipped += 1;
    }
    return counts;
  }

  /**
   * Read one owned record list.
   *
   * A list that could not be read is **not** an empty list. Returning `[]` on
   * failure would render "Import runs (0)" over a queue that may be full —
   * exactly the empty-truth this foundation refuses everywhere else — so the
   * failure is carried out and rendered as *could not be read*.
   *
   * @param {string} module
   * @returns {Promise<{items: any[], unreadable: string | null}>}
   */
  async function rowsOf(module) {
    try {
      const response = await client.request(`/api/modules/${module}/records?limit=100`);
      return { items: response.items ?? [], unreadable: null };
    } catch (error) {
      // A full human sentence in the view's language (Italian), never a
      // parenthesized fragment: listHeading renders it as its own line.
      return {
        items: [],
        unreadable: humanReadError(error, {
          failed: 'Questa lista non si è potuta leggere e non viene mostrata. Non è detto che sia vuota. Riprova più tardi.',
        }),
      };
    }
  }

  /** Heading + an honest line when the list could not be read at all. */
  function listHeading(box, read, label, countText) {
    if (read.unreadable) {
      box.appendChild(el('h4', undefined, `${label} (non leggibile)`));
      const line = el('p', 'field-error customer-data-unreadable', read.unreadable);
      line.setAttribute('data-unreadable', label);
      box.appendChild(line);
      const retry = el('button', undefined, 'Riprova');
      retry.setAttribute('data-action', 'retry-customer-data-list');
      retry.addEventListener('click', () => { void render(); });
      box.appendChild(retry);
      return;
    }
    box.appendChild(el('h4', undefined, `${label} (${countText})`));
  }

  /**
   * The read-only consolidated profile for one record.
   * @param {string} resource @param {string} id
   */
  async function renderProfile(resource, id) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    let profile;
    try {
      profile = await client.request(`/api/customer-data/profile/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`);
    } catch (error) {
      mount.appendChild(el('p', 'field-error', humanReadError(error, {
        failed: 'Il profilo non si è potuto leggere. Riprova più tardi.',
      })));
      return;
    }
    const panel = el('div', 'customer-profile');
    panel.setAttribute('data-subject', `${resource}:${id}`);
    panel.appendChild(el('h3', undefined, 'Profilo cliente'));
    // BO-F1-06: the scheda cliente is the three-column customer view; the
    // package-scoped profile stays, and links there.
    const schedaLink = el('a', undefined, 'Apri la scheda cliente →');
    schedaLink.setAttribute('href', `#/customer-card/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`);
    schedaLink.setAttribute('data-action', 'open-customer-card');
    panel.appendChild(schedaLink);
    panel.appendChild(el('p', 'muted customer-profile-timeline', profile.timelineNote ?? ''));

    panel.appendChild(fact('Azienda', profile.identity?.company?.name ?? null));
    panel.appendChild(fact('Contatto', profile.identity?.contact?.email ?? null));

    const identityBox = el('div', 'customer-profile-identity');
    identityBox.setAttribute('data-linked', String(Boolean(profile.canonicalIdentity?.linked)));
    identityBox.appendChild(el('h4', undefined, 'Identità principale'));
    identityBox.appendChild(el('p', 'muted customer-profile-canonical-note', profile.canonicalIdentity?.note ?? ''));
    for (const member of profile.canonicalIdentity?.members ?? []) {
      // The stored label is a decision-time snapshot, never refreshed, so it is
      // shown as one: the id is the fact, the snapshot is context.
      const shown = member.labelSnapshot ? `${member.labelSnapshot} (nome di allora)` : member.id;
      identityBox.appendChild(el('p', 'customer-profile-member', `${member.role}: ${member.resource} ${shown}`));
    }
    panel.appendChild(identityBox);

    const externalBox = el('div', 'customer-profile-externals');
    externalBox.appendChild(el('h4', undefined, `Identità esterne (${(profile.externalIdentities ?? []).length})`));
    for (const identity of profile.externalIdentities ?? []) {
      externalBox.appendChild(el('p', 'customer-profile-external', `${identity.system}: ${identity.externalId}`));
    }
    panel.appendChild(externalBox);

    const sections = el('div', 'customer-profile-sections');
    for (const [key, label] of [
      ['opportunities', 'Opportunità'], ['quotes', 'Preventivi'], ['orders', 'Ordini firmati'],
      ['contracts', 'Contratti'], ['subscriptions', 'Abbonamenti'], ['deliveryProjects', 'Consegne'],
      ['serviceCoverages', 'Assistenza'], ['supportCases', 'Richieste di supporto'],
      ['workTasks', 'Attività'], ['successions', 'Rinnovi'],
    ]) {
      const section = profile[key];
      if (!section) continue;
      const row = el('p', 'customer-profile-section');
      row.setAttribute('data-section', key);
      row.setAttribute('data-available', String(Boolean(section.available)));
      row.appendChild(el('span', 'fact-label', `${label}: `));
      // A count read from a bounded page is a floor, not a total, and the row
      // says which of the two it is rather than showing both as one number.
      const valueEl = el('span', 'fact-value', section.available
        ? (section.countIsComplete === false ? `almeno ${section.count}` : `${section.count}`)
        : 'non disponibile');
      if (section.available && section.countIsComplete === false && section.countNote) valueEl.title = section.countNote;
      row.appendChild(valueEl);
      if (!section.available) row.appendChild(el('span', 'muted customer-profile-unavailable', ` — ${section.reason}`));
      sections.appendChild(row);
    }
    panel.appendChild(sections);

    const issueBox = el('div', 'customer-profile-issues');
    issueBox.appendChild(el('h4', undefined, `Segnalazioni aperte (${(profile.dataQualityIssues ?? []).length})`));
    for (const issue of profile.dataQualityIssues ?? []) {
      issueBox.appendChild(el('p', 'customer-profile-issue', `${customerIssueKindLabel(issue.kind)}: ${issue.evidence}`));
    }
    panel.appendChild(issueBox);

    for (const limitation of profile.limitations ?? []) {
      panel.appendChild(el('p', 'muted customer-profile-limit', limitation));
    }
    mount.appendChild(panel);
    void navigate;
  }

  return { render, renderProfile };
}
