// @ts-check

// BO-F5-01 — Reporting screen and "+ Nuovo modulo" (docs/BUNDLES.md).
//
// The Reporting voice reads the reference bundle's rows when the bundle is
// composed in this space, and the "+ Nuovo modulo" voice is always there:
// its double option ("Crea con l'AI" / "Crea manuale") plus the 'Sviluppa
// per Accordo' card. Nothing here generates code: the AI option forwards
// the description to the assistant panel (the coding agent drafts the
// manifest and runs the real `bundle create --apply` + `bundle verify` —
// docs/BUNDLES.md "For coding agents"), the manual option shows the exact
// commands. A bundle that does not boot and serve is refused by verify,
// never simulated.
//
// Conventions follow apps/admin/public/admin-modules.js: the model builders
// are pure and DOM-free (unit-tested under node:test without a browser) and
// the renderer uses DOM APIs only — createElement + textContent/setAttribute
// — never innerHTML with data, so hostile bundle rows are inert text.

/** Hash route of the Reporting screen. */
export const REPORTING_ROUTE = '#/reporting';
/** Hash route of the "+ Nuovo modulo" screen. */
export const NUOVO_MODULO_ROUTE = '#/nuovo-modulo';

/** Records read per page: a bounded page with an honest cap note, never a total. */
export const REPORTING_LIMIT = 100;

/**
 * Exact CLI commands for one bundle lifecycle step, as text. The agent runs
 * them; the screen never pretends to run them.
 * @param {{ manifestPath?: string, name?: string, version?: string }} input
 */
export function bundleCommands({ manifestPath = 'modulo.module.json', name = 'nome-modulo', version = '0.1.0' } = {}) {
  const base = 'npm run crm --';
  return {
    create: `${base} bundle create ${manifestPath} --name ${name} --version ${version} --created-by ai --apply`,
    verify: `${base} bundle verify ${name}@${version}`,
    install: `${base} bundle install ${name}@${version}`,
  };
}

/**
 * The manual path as data: manifest checklist plus the exact commands.
 * Pure, so the test pins the wording without a browser.
 */
export function manualSteps() {
  return {
    checklist: [
      'manifestVersion 1, name uguale al bundle (minuscole, cifre, trattini)',
      'una tabella propria, mai una tabella kernel (clienti, pipeline, calendario)',
      'campi con tipo tra string, integer, boolean, timestamp, email, enum',
      'description in italiano: cosa misura il modulo',
    ],
    commands: bundleCommands(),
    proof: 'bundle verify avvia l\u2019app vera con il bundle composto e serve un record: se non si avvia e non serve, il bundle non esiste.',
  };
}

/**
 * Group reporting rows by metric, newest period first. Unknown shapes are
 * skipped, never rendered as "undefined".
 * @param {unknown} rows
 */
export function reportingSummary(rows) {
  /** @type {Map<string, { metric: string, periods: number, lastValue: string, lastPeriod: string, lastUnit: string }>} */
  const byMetric = new Map();
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const metric = typeof row.metric === 'string' && row.metric !== '' ? row.metric : null;
    if (metric === null) continue;
    const period = typeof row.period === 'string' ? row.period : '';
    const value = row.value === undefined || row.value === null ? '' : String(row.value);
    const unit = typeof row.unit === 'string' ? row.unit : '';
    const entry = byMetric.get(metric) ?? { metric, periods: 0, lastValue: '', lastPeriod: '', lastUnit: '' };
    entry.periods += 1;
    if (period >= entry.lastPeriod) {
      entry.lastValue = value;
      entry.lastPeriod = period;
      entry.lastUnit = unit;
    }
    byMetric.set(metric, entry);
  }
  return [...byMetric.values()].sort((a, b) => (a.metric < b.metric ? -1 : 1));
}

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
 * A view controller for the Reporting and "+ Nuovo modulo" screens.
 * Injecting `doc`, `client` and `nav` keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate: (hash: string) => void, onAskAi?: (screenId: string) => void}} deps
 */
export function createReportingView(deps) {
  const { doc, mount, client, navigate } = deps;
  const onAskAi = deps.onAskAi ?? (() => {});

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** Guard against stale async responses overwriting a newer view. */
  let renderToken = 0;

  function kicker(title, subtitle) {
    const panel = el(doc, 'section', { class: 'panel panel-wide' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: title }));
    titleBox.appendChild(el(doc, 'h2', { text: subtitle }));
    heading.appendChild(titleBox);
    panel.appendChild(heading);
    return panel;
  }

  function nuovoModuloButton(panel) {
    const actions = el(doc, 'div', { class: 'actions' });
    const button = el(doc, 'button', { class: 'primary', text: '+ Nuovo modulo' });
    button.setAttribute('data-action', 'nuovo-modulo');
    button.addEventListener('click', () => navigate(NUOVO_MODULO_ROUTE));
    actions.appendChild(button);
    panel.appendChild(actions);
  }

  function reportingTable(panel, rows, capped) {
    const summary = reportingSummary(rows);
    if (summary.length === 0) {
      panel.appendChild(el(doc, 'div', { class: 'empty', text: 'Nessuna riga di reporting in questo spazio.' }));
      return;
    }
    const wrap = el(doc, 'div', { class: 'table-wrap' });
    const table = el(doc, 'table');
    const thead = el(doc, 'thead');
    const headRow = el(doc, 'tr');
    for (const head of ['Metrica', 'Ultimo periodo', 'Ultimo valore', 'Periodi']) {
      headRow.appendChild(el(doc, 'th', { text: head }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el(doc, 'tbody');
    for (const entry of summary) {
      const row = el(doc, 'tr');
      row.appendChild(el(doc, 'td', { text: entry.metric }));
      row.appendChild(el(doc, 'td', { text: entry.lastPeriod }));
      row.appendChild(el(doc, 'td', { text: entry.lastUnit ? `${entry.lastValue} ${entry.lastUnit}` : entry.lastValue }));
      row.appendChild(el(doc, 'td', { text: String(entry.periods) }));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    if (capped) {
      panel.appendChild(el(doc, 'p', { class: 'lede', text: `Prime ${rows.length} righe lette: la pagina può nasconderne altre.` }));
    }
  }

  async function renderReporting() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el(doc, 'p', { class: 'empty', text: 'Loading…' }));
    let rows = null;
    try {
      const body = await client.request(`/api/modules/reporting/records?limit=${REPORTING_LIMIT}`);
      if (body && Array.isArray(body.items)) rows = body.items;
    } catch {
      rows = null; // not composed here: the screen says so, never a blank page
    }
    if (token !== renderToken) return;
    clear();
    const panel = kicker('Moduli personalizzati', 'Reporting');
    panel.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Righe KPI del bundle reporting, lette dal vivo. Grafici e previsioni (BO-F5-02) leggeranno queste righe, mai le tabelle kernel.',
    }));
    if (rows === null) {
      panel.appendChild(el(doc, 'div', {
        class: 'empty',
        text: 'Reporting non composto in questo spazio: nessun dato inventato. Crea il bundle con + Nuovo modulo.',
      }));
      nuovoModuloButton(panel);
      mount.appendChild(panel);
      return;
    }
    reportingTable(panel, rows, rows.length >= REPORTING_LIMIT);
    const actions = el(doc, 'div', { class: 'actions' });
    const more = el(doc, 'button', { class: 'secondary', text: '+ Nuovo modulo' });
    more.setAttribute('data-action', 'nuovo-modulo');
    more.addEventListener('click', () => navigate(NUOVO_MODULO_ROUTE));
    actions.appendChild(more);
    panel.appendChild(actions);
    mount.appendChild(panel);
  }

  function svilluppaCard() {
    const card = el(doc, 'section', { class: 'panel' });
    card.appendChild(el(doc, 'p', { class: 'kicker', text: 'Sviluppa per Accordo' }));
    card.appendChild(el(doc, 'h2', { text: 'I bundle restano fuori dal processo condiviso' }));
    card.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Un bundle è un set di moduli versionato e rimovibile: vive in bundles/<nome>/<versione>/, non tocca clienti, pipeline e calendario, e si installa solo dove l\u2019host lo compone. Il codice generato non gira mai nel processo condiviso.',
    }));
    const list = el(doc, 'ul');
    for (const line of [
      'Versionato: una versione non si rigenera mai, una modifica è una nuova versione.',
      'Rimovibile: uninstall toglie solo le sue tabelle, i dati kernel restano.',
      'Vero: bundle verify avvia l\u2019app e serve un record, o il bundle non esiste.',
    ]) {
      list.appendChild(el(doc, 'li', { text: line }));
    }
    card.appendChild(list);
    return card;
  }

  function renderNuovoModulo() {
    clear();
    const panel = kicker('Moduli personalizzati', 'Nuovo modulo');
    panel.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Due strade, uno stesso formato (docs/BUNDLES.md): il pacchetto nativo del kernel con capability dichiarata.',
    }));
    mount.appendChild(panel);
    const ai = el(doc, 'section', { class: 'panel' });
    ai.appendChild(el(doc, 'h3', { text: 'Crea con l\u2019AI' }));
    ai.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Descrivi il modulo: l\u2019assistente apre il percorso guidato e l\u2019agente di coding redige il manifest ed esegue bundle create --apply e bundle verify. Niente codice simulato.',
    }));
    const label = el(doc, 'label', { text: 'Descrivi il modulo' });
    const area = doc.createElement('textarea');
    area.setAttribute('name', 'descrizione-modulo');
    area.setAttribute('rows', '3');
    area.setAttribute('placeholder', 'un modulo sonde per i KPI del pilota (etichetta + conteggio)');
    label.appendChild(area);
    ai.appendChild(label);
    const ask = el(doc, 'button', { class: 'primary', text: 'Chiedi all\u2019assistente' });
    ask.setAttribute('data-action', 'chiedi-assistente');
    ask.addEventListener('click', () => onAskAi('nuovo-modulo'));
    ai.appendChild(ask);
    mount.appendChild(ai);

    const manual = el(doc, 'section', { class: 'panel' });
    manual.appendChild(el(doc, 'h3', { text: 'Crea manuale' }));
    manual.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Scrivi il manifest (docs/MODULE_MANIFEST.md) ed esegui gli stessi comandi dell\u2019agente:',
    }));
    const steps = el(doc, 'ol');
    for (const item of manualSteps().checklist) {
      steps.appendChild(el(doc, 'li', { text: item }));
    }
    manual.appendChild(steps);
    const commands = manualSteps().commands;
    for (const command of [commands.create, commands.verify, commands.install]) {
      const code = el(doc, 'pre');
      code.appendChild(el(doc, 'code', { text: command }));
      manual.appendChild(code);
    }
    manual.appendChild(el(doc, 'p', { class: 'lede', text: manualSteps().proof }));
    mount.appendChild(manual);
    mount.appendChild(svilluppaCard());
  }

  return { renderReporting, renderNuovoModulo };
}
