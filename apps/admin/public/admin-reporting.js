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

/**
 * BO-F5-02 — pipeline dashboard ("09 Reporting", backlog:c3e66b36ddb7).
 *
 * Every number below is served by GET /api/reporting/dashboard, which reads
 * the declared analytics registry (compileReport/runReport) plus the
 * operator's own obiettivo row from the reporting bundle. The screen itself
 * never queries: filters only refetch with periodo/persona parameters, and
 * the "Cosa noto" proposal is revealed client-side with zero requests — it
 * can never reassign by itself because no write surface exists.
 */

/** Display currency of the dashboard (the registry partitions, never mixes). */
export const REPORTING_CURRENCY = 'EUR';

/** Current UTC month as YYYY-MM (the default dashboard period). */
export function currentPeriod(nowIso) {
  const at = typeof nowIso === 'string' && nowIso.length >= 7 ? nowIso.slice(0, 7) : new Date().toISOString().slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(at) ? at : new Date().toISOString().slice(0, 7);
}

/**
 * The three period options ending at the current month, oldest first.
 * Labels are short Italian month names, like the prototype's filter pills.
 * @param {string} [nowIso] injectable clock for tests
 */
export function periodOptions(nowIso) {
  const current = currentPeriod(nowIso);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  return [2, 1, 0].map((back) => {
    const date = new Date(Date.UTC(year, month - 1 - back, 1));
    const value = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = new Intl.DateTimeFormat('it-IT', { month: 'short' }).format(date).replace('.', '');
    return { value, label: `${label} ${date.getUTCFullYear()}` };
  });
}

/**
 * Dashboard request path for a filter state. Pure, so the test pins the
 * recalculation contract (periodo/persona change the request, never a
 * client-side slice of stale data).
 * @param {{period: string, owner?: string | null, currency?: string}} filters
 */
export function dashboardPath({ period, owner = null, currency = REPORTING_CURRENCY }) {
  const params = new URLSearchParams({ period, currency });
  if (owner !== null && owner !== undefined && owner !== '') params.set('owner', owner);
  return `/api/reporting/dashboard?${params.toString()}`;
}

/**
 * Money for display: integer minor units to an Italian currency string.
 * Non-integers are never formatted as money — 'n.d.', not a guess.
 * @param {number} minor @param {string} [currency]
 */
export function formatMoney(minor, currency = REPORTING_CURRENCY) {
  if (!Number.isInteger(minor)) return 'n.d.';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(minor / 100);
}

/**
 * Bar fill width for a value against the chart maximum. Zero/negative
 * maxima render empty, never NaN.
 * @param {number} value @param {number} max
 */
export function barWidth(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return '0%';
  return `${Math.min(100, Math.round((value / max) * 100))}%`;
}

/**
 * Default CSV download (browsers). Injected as a dependency so tests pass a
 * spy: the fake DOM has no Blob navigation.
 * @param {{doc: Document, filename: string, content: string}} input
 */
export function downloadCsv({ doc, filename, content }) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', url);
  anchor.setAttribute('download', filename);
  if (typeof anchor.click === 'function') anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/**
 * A 200 that carries only some dashboard lists would crash the renderer
 * (`model.funnel.map` on undefined) into a blank screen. Every list the
 * renderer maps plus the forecast/csv objects must be present, or the
 * payload is unreadable — same error state, same log line, never a throw.
 * @param {unknown} model
 */
export function isDashboardPayload(model) {
  if (model === null || typeof model !== 'object') return false;
  const payload = /** @type {Record<string, unknown>} */ (model);
  for (const key of ['kpis', 'funnel', 'valueByStage', 'monthly', 'team', 'owners', 'insights']) {
    if (!Array.isArray(payload[key])) return false;
  }
  for (const key of ['forecast', 'csv', 'currencies']) {
    if (payload[key] === null || typeof payload[key] !== 'object') return false;
  }
  const csv = /** @type {Record<string, unknown>} */ (payload.csv);
  return typeof csv.filename === 'string' && typeof csv.content === 'string';
}

/** Hash route of the "+ Nuovo modulo" screen. */
export const NUOVO_MODULO_ROUTE = '#/nuovo-modulo';

/** Records read per page: a bounded page with an honest cap note, never a total. */
export const REPORTING_LIMIT = 100;

/**
 * Exact CLI commands for one bundle lifecycle step, as text. The agent runs
 * them; the screen never pretends to run them. `createdBy` names who runs
 * the create: the AI path shows `--created-by ai`, the manual path shows
 * `--created-by manual`, so the registry never misattributes provenance.
 * @param {{ manifestPath?: string, name?: string, version?: string, createdBy?: string }} input
 */
/** Who may run a bundle create: the same contract as the CLI `--created-by` (P2 admin-reporting.js:119). */
export const BUNDLE_CREATED_BY = Object.freeze(['ai', 'manual', 'accordo']);

export function bundleCommands({ manifestPath = 'modulo.module.json', name = 'nome-modulo', version = '0.1.0', createdBy = 'ai' } = {}) {
  if (!BUNDLE_CREATED_BY.includes(createdBy)) {
    throw new Error(`createdBy must be one of ${BUNDLE_CREATED_BY.join(', ')} (who runs the create)`);
  }
  const base = 'npm run crm --';
  return {
    create: `${base} bundle create ${manifestPath} --name ${name} --version ${version} --created-by ${createdBy} --apply`,
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
    commands: bundleCommands({ createdBy: 'manual' }),
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
    // Strict: the service returns newest-first, so on equal periods the FIRST
    // row seen (the newest) wins. `>=` kept the oldest value on ties.
    if (period > entry.lastPeriod) {
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
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * A view controller for the Reporting and "+ Nuovo modulo" screens.
 * Injecting `doc`, `client` and `nav` keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate: (hash: string) => void, onAskAi?: (screenId: string, description?: string) => void, log?: (message: string, cause: unknown) => void, download?: (input: {doc: Document, filename: string, content: string}) => void}} deps
 */
export function createReportingView(deps) {
  const { doc, mount, client, navigate } = deps;
  const onAskAi = deps.onAskAi ?? (() => {});
  const log = deps.log ?? ((message, cause) => console.error(message, cause));
  const download = deps.download ?? downloadCsv;

  /** Dashboard filter state: every change refetches (ricalcolo), never slices cached rows. */
  const dashboard = { period: currentPeriod(), owner: '' };

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

  function pill(label, active, onPick) {
    const button = el(doc, 'button', { class: active ? 'small primary' : 'small secondary', text: label });
    button.setAttribute('data-active', active ? 'true' : 'false');
    button.addEventListener('click', onPick);
    return button;
  }

  function dashboardFilters(section, model) {
    const filters = el(doc, 'div', { class: 'actions' });
    for (const option of periodOptions()) {
      filters.appendChild(pill(option.label, dashboard.period === option.value, () => {
        dashboard.period = option.value;
        renderReporting();
      }));
    }
    filters.appendChild(pill('Tutti', dashboard.owner === '', () => {
      dashboard.owner = '';
      renderReporting();
    }));
    for (const owner of model.owners ?? []) {
      filters.appendChild(pill(owner, dashboard.owner === owner, () => {
        dashboard.owner = owner;
        renderReporting();
      }));
    }
    section.appendChild(filters);
  }

  function kpiCards(section, model) {
    const grid = el(doc, 'div', { class: 'metrics' });
    for (const kpi of model.kpis ?? []) {
      const card = el(doc, 'div', { class: 'metric' });
      card.appendChild(el(doc, 'span', { text: kpi.label }));
      card.appendChild(el(doc, 'strong', { text: kpi.display }));
      card.appendChild(el(doc, 'span', { text: kpi.sub }));
      grid.appendChild(card);
    }
    section.appendChild(grid);
  }

  /**
   * One CSS-bar chart. Values are text beside the bar, so the chart stays
   * readable where styles fail; widths come from barWidth (0% when empty).
   */
  function barChart(section, title, subtitle, rows) {
    const panel = el(doc, 'section', { class: 'panel' });
    panel.appendChild(el(doc, 'h3', { text: title }));
    panel.appendChild(el(doc, 'p', { class: 'lede', text: subtitle }));
    const max = Math.max(0, ...rows.map((row) => row.minor));
    for (const row of rows) {
      const line = el(doc, 'div');
      line.setAttribute('style', 'display:flex;align-items:center;gap:10px;padding:5px 0;');
      const name = el(doc, 'span', { text: row.label });
      name.setAttribute('style', 'min-width:110px;font-size:13px;font-weight:600;');
      const track = el(doc, 'div');
      track.setAttribute('style', 'flex:1;height:14px;border-radius:99px;background:var(--surface-soft);overflow:hidden;');
      const fill = el(doc, 'div');
      fill.setAttribute('style', `height:100%;width:${barWidth(row.minor, max)};background:var(--agent-ink);border-radius:99px;`);
      track.appendChild(fill);
      const value = el(doc, 'span', { text: row.text });
      value.setAttribute('style', "font-family:monospace;font-size:12px;min-width:120px;text-align:right;");
      line.appendChild(name);
      line.appendChild(track);
      line.appendChild(value);
      panel.appendChild(line);
    }
    section.appendChild(panel);
  }

  function forecastPanel(section, model) {
    const forecast = model.forecast;
    const panel = el(doc, 'div', { class: 'pipeline-forecast' });
    panel.appendChild(el(doc, 'h3', { text: `Previsione di ${model.periodLabel}` }));
    const scale = Math.max(
      forecast.targetMinor ?? 0,
      forecast.bestMinor,
      forecast.closedMinor + forecast.probableMinor,
      1,
    );
    const band = el(doc, 'div');
    band.setAttribute('style', 'position:relative;height:26px;border-radius:8px;background:var(--surface-soft);display:flex;overflow:hidden;');
    const closed = el(doc, 'div');
    closed.setAttribute('style', `height:100%;width:${barWidth(forecast.closedMinor, scale)};background:var(--accord);`);
    const probable = el(doc, 'div');
    probable.setAttribute('style', `height:100%;width:${barWidth(forecast.probableMinor, scale)};background:var(--accord);opacity:0.45;`);
    const best = el(doc, 'div');
    best.setAttribute('style', `height:100%;width:${barWidth(Math.max(0, forecast.bestMinor - forecast.closedMinor - forecast.probableMinor), scale)};background:repeating-linear-gradient(45deg,var(--stripe) 0 6px,transparent 6px 12px);`);
    band.appendChild(closed);
    band.appendChild(probable);
    band.appendChild(best);
    if (forecast.targetMinor !== null && forecast.targetMinor !== undefined) {
      const marker = el(doc, 'span');
      marker.setAttribute('style', `position:absolute;top:-4px;bottom:-4px;left:${barWidth(forecast.targetMinor, scale)};width:2px;background:var(--ink);`);
      band.appendChild(marker);
    }
    panel.appendChild(band);
    panel.appendChild(el(doc, 'p', {
      class: 'forecast-total',
      text: `Chiuse ${formatMoney(forecast.closedMinor, model.currency)} · probabili +${formatMoney(forecast.probableMinor, model.currency)} · se chiudi tutto +${formatMoney(forecast.bestMinor, model.currency)}`,
    }));
    // The heuristic badge is the acceptance contract: the number below is
    // arithmetic over history, never a promise.
    panel.appendChild(el(doc, 'p', { class: 'lede', text: `✦ ${forecast.label}: ${forecast.method}` }));
    panel.appendChild(el(doc, 'p', { class: 'lede', text: forecast.note }));
    section.appendChild(panel);
  }

  function teamTable(section, model) {
    const panel = el(doc, 'section', { class: 'panel' });
    panel.appendChild(el(doc, 'h3', { text: `Team e vendite · ${model.periodLabel}` }));
    if ((model.team ?? []).length === 0) {
      panel.appendChild(el(doc, 'div', { class: 'empty', text: 'Nessun preventivo in questa vista.' }));
      section.appendChild(panel);
      return;
    }
    const wrap = el(doc, 'div', { class: 'table-wrap' });
    const table = el(doc, 'table');
    const thead = el(doc, 'thead');
    const headRow = el(doc, 'tr');
    for (const head of ['Persona', 'Preventivi', 'Valore aperto', 'Vinte', 'Tasso']) {
      headRow.appendChild(el(doc, 'th', { text: head }));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el(doc, 'tbody');
    for (const entry of model.team) {
      const row = el(doc, 'tr');
      row.appendChild(el(doc, 'td', { text: entry.owner }));
      row.appendChild(el(doc, 'td', { text: String(entry.openCount) }));
      row.appendChild(el(doc, 'td', { text: formatMoney(entry.openMinor, model.currency) }));
      row.appendChild(el(doc, 'td', { text: `${entry.wonCount} (${formatMoney(entry.wonMinor, model.currency)})` }));
      row.appendChild(el(doc, 'td', { text: entry.winRateDisplay }));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    panel.appendChild(wrap);
    section.appendChild(panel);
  }

  function insightsPanel(section, model) {
    const panel = el(doc, 'section', { class: 'panel' });
    panel.appendChild(el(doc, 'p', { class: 'kicker', text: '✦ Cosa noto' }));
    for (const insight of model.insights ?? []) {
      panel.appendChild(el(doc, 'p', { class: 'lede', text: insight.text }));
    }
    // The proposal is revealed client-side with zero requests: there is no
    // write surface behind it, so it can propose but never reassign by itself.
    const propose = el(doc, 'button', { class: 'secondary', text: 'Proponi ridistribuzione dei lead' });
    propose.setAttribute('data-action', 'proponi-ridistribuzione');
    propose.addEventListener('click', () => {
      // No double reveal: a second click changes nothing.
      if (propose.getAttribute('data-done') === 'true') return;
      propose.setAttribute('data-done', 'true');
      if (model.proposal === null || model.proposal === undefined) {
        panel.appendChild(el(doc, 'p', { class: 'lede', text: 'Nessuna ridistribuzione da proporre in questo periodo.' }));
        return;
      }
      panel.appendChild(el(doc, 'h3', { text: model.proposal.title }));
      const list = el(doc, 'ul');
      for (const move of model.proposal.moves) {
        list.appendChild(el(doc, 'li', {
          text: `${move.count} lead da ${move.from} a ${move.to}: ${move.reason}`,
        }));
      }
      panel.appendChild(list);
      panel.appendChild(el(doc, 'p', { class: 'lede', text: model.proposal.note }));
    });
    panel.appendChild(propose);
    const csv = el(doc, 'button', { class: 'secondary', text: 'Esporta CSV' });
    csv.setAttribute('data-action', 'esporta-csv');
    csv.addEventListener('click', () => {
      download({ doc, filename: model.csv.filename, content: model.csv.content });
    });
    panel.appendChild(csv);
    section.appendChild(panel);
  }

  async function renderDashboard(host) {
    let model = null;
    try {
      model = await client.request(dashboardPath({ period: dashboard.period, owner: dashboard.owner || null }));
    } catch (error) {
      const cause = error && typeof error === 'object'
        ? { name: error.name ?? 'Error', status: error.status ?? null, code: error.code ?? null }
        : { name: 'Error', status: null, code: null };
      log('reporting dashboard request failed', cause);
      host.appendChild(el(doc, 'div', {
        class: 'empty',
        text: 'Andamento non disponibile: i dati non si sono potuti leggere. Riprova più tardi.',
      }));
      return;
    }
    if (!isDashboardPayload(model)) {
      log('reporting dashboard request failed', { name: 'Error', status: 200, code: null });
      host.appendChild(el(doc, 'div', {
        class: 'empty',
        text: 'Andamento non disponibile: risposta illeggibile dal server. Riprova più tardi.',
      }));
      return;
    }
    dashboardFilters(host, model);
    if (model.truncated) {
      host.appendChild(el(doc, 'p', { class: 'lede', text: 'Dati parziali: oltre 1000 righe lette, i totali sono troncati.' }));
    }
    if ((model.currencies?.others ?? []).length > 0) {
      host.appendChild(el(doc, 'p', {
        class: 'lede',
        text: `Solo ${model.currency} mostrati; presenti anche: ${model.currencies.others.join(', ')}.`,
      }));
    }
    kpiCards(host, model);
    barChart(host, 'Preventivi', 'dall\u2019invio al pagamento, per fase', model.funnel.map((entry) => ({
      label: entry.label, minor: entry.count, text: `${entry.count} · ${entry.minor}`,
    })));
    barChart(host, 'Valore per fase', 'somme in minor units della valuta mostrata', model.valueByStage.map((entry) => ({
      label: entry.label, minor: entry.minor, text: String(entry.minor),
    })));
    barChart(host, 'Chiusure attese per mese', 'preventivi aperti per mese di chiusura attesa', model.monthly.map((entry) => ({
      label: entry.label, minor: entry.expectedMinor, text: `${entry.openCount} · ${entry.expectedMinor}`,
    })));
    barChart(host, 'Vendite per persona', 'valore aperto per proprietario', model.team.map((entry) => ({
      label: entry.owner, minor: entry.openMinor, text: `${entry.openCount} · ${entry.openMinor}`,
    })));
    forecastPanel(host, model);
    teamTable(host, model);
    insightsPanel(host, model);
  }

  async function renderReporting() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el(doc, 'p', { class: 'empty', text: 'Loading…' }));
    let rows = null;
    let loadError = null;
    try {
      const body = await client.request(`/api/modules/reporting/records?limit=${REPORTING_LIMIT}`);
      if (body && Array.isArray(body.items)) {
        rows = body.items;
      } else {
        // A 200 without an items array is a broken server/proxy, never a
        // missing bundle: it gets the error state and a log line, never the
        // "not composed" pointer (which would send the operator to create a
        // bundle that already exists).
        loadError = new Error('reporting records response has no items array');
        log('reporting records request failed', { name: 'Error', status: 200, code: null });
      }
    } catch (error) {
      // The server fails closed as 404 for a module that is not composed
      // (resolveGeneratedModule → NotFoundError): only that is the honest
      // "not composed" empty state. Any other failure — 500, auth, network —
      // is a real error: it gets its own state and a log line, never the
      // bundle-setup pointer (which would misdiagnose the cause).
      const status = error && typeof error === 'object' ? error.status ?? null : null;
      if (status === 404) {
        rows = null; // not composed here: the screen says so, never a blank page
      } else {
        loadError = error;
        const cause = error && typeof error === 'object'
          ? { name: error.name ?? 'Error', status, code: error.code ?? null }
          : { name: 'Error', status: null, code: null };
        log('reporting records request failed', cause);
      }
    }
    if (token !== renderToken) return;
    clear();
    const dashHost = el(doc, 'div');
    await renderDashboard(dashHost);
    if (token !== renderToken) return;
    mount.appendChild(dashHost);
    const panel = kicker('Moduli personalizzati', 'Reporting');
    panel.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Sopra: l\u2019andamento della pipeline, aggiornato a ogni filtro. Sotto: le righe del report, con i dati dell\u2019operatore come l\u2019obiettivo di periodo.',
    }));
    if (loadError !== null) {
      panel.appendChild(el(doc, 'div', {
        class: 'empty',
        text: 'Reporting non disponibile: la lettura delle righe è fallita. Riprova più tardi: non è un problema del bundle.',
      }));
      mount.appendChild(panel);
      return;
    }
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

  function sviluppaCard() {
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
    // Invalidate any in-flight renderReporting (same discipline as the token
    // check in renderReporting): without this, a slow reporting response
    // resolving after this navigation repaints the mount with the Reporting
    // panel over the Nuovo modulo screen.
    renderToken += 1;
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
    area.setAttribute('class', 'ui-field'); // BO-F6-02: system field class.
    area.setAttribute('name', 'descrizione-modulo');
    area.setAttribute('rows', '3');
    area.setAttribute('placeholder', 'un modulo sonde per i KPI del pilota (etichetta + conteggio)');
    label.appendChild(area);
    ai.appendChild(label);
    const ask = el(doc, 'button', { class: 'primary', text: 'Chiedi all\u2019assistente' });
    ask.setAttribute('data-action', 'chiedi-assistente');
    // The typed description travels with the handoff: the assistant panel
    // opens on the nuovo-modulo screen with the textarea prefilled, so the
    // user never retypes it there (P2 admin-reporting.js:289).
    ask.addEventListener('click', () => onAskAi('nuovo-modulo', area.value));
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
    mount.appendChild(sviluppaCard());
  }

  return { renderReporting, renderNuovoModulo };
}
