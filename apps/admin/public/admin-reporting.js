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

/**
 * Channel names and bar colors of the "Nuovi clienti per canale" card, as in
 * the prototype. Colors read the :root tokens (never literals, per the
 * authority-tokens contract) and paint through inline `background:var(--…)`,
 * like the rest of this screen. Systems the table actually carries but this
 * map does not know render under their raw name in the fallback tint —
 * visible, never invented.
 */
export const CHANNEL_LABELS = Object.freeze({
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  email: 'Email',
  phone: 'Telefono',
});

export const CHANNEL_COLORS = Object.freeze({
  whatsapp: 'var(--accent)',
  instagram: 'var(--human)',
  facebook: 'var(--data)',
  tiktok: 'var(--ink)',
  email: 'var(--pending)',
  phone: 'var(--muted)',
});

export const CHANNEL_FALLBACK_COLOR = 'var(--dim)';

/** @param {string} channel */
export function channelLabel(channel) {
  return typeof channel === 'string' && CHANNEL_LABELS[channel] !== undefined
    ? CHANNEL_LABELS[channel]
    : String(channel ?? '');
}

/** @param {string} channel */
export function channelColor(channel) {
  return typeof channel === 'string' && CHANNEL_COLORS[channel] !== undefined
    ? CHANNEL_COLORS[channel]
    : CHANNEL_FALLBACK_COLOR;
}

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
  const channels = /** @type {Record<string, unknown>} */ (payload.channels);
  if (channels === null || typeof channels !== 'object') return false;
  if (!Array.isArray(channels.weeks) || !Array.isArray(channels.channels)) return false;
  if (!Number.isInteger(channels.total)) return false;
  const csv = /** @type {Record<string, unknown>} */ (payload.csv);
  return typeof csv.filename === 'string' && typeof csv.content === 'string';
}

/** Hash route of the "+ Nuovo modulo" screen. */
export const NUOVO_MODULO_ROUTE = '#/nuovo-modulo';

/** Records read per page: a bounded page with an honest cap note, never a total. */
export const REPORTING_LIMIT = 100;

/**
 * Badge row under the Reporting title (spec checklist C2): the bundle
 * identity, fixed text. The version names the composed bundle
 * (`bundles/reporting/1.2.0/bundle.json`); a new bundle version updates
 * this list, never a silent drift.
 */
export const REPORTING_BADGES = Object.freeze([
  'reporting@1.2.0',
  'Bundle separato dal kernel',
  'Generato dal tuo agente di coding · 3 giorni fa',
]);

/**
 * File list of the "Questo modulo è codice tuo" card (spec checklist C17):
 * fixed structure, indicative versions. It documents the custom module,
 * never a data state.
 */
export const REPORTING_CODE_FILES = Object.freeze([
  'modules/reporting/',
  'manifest.json',
  'queries.ts',
  'charts/',
  'access.ts',
]);

/** Lede of the code card (spec C17): fixed Italian text, never technical codes. */
export const REPORTING_CODE_LEDE = 'I moduli personalizzati sono bundle separati dal kernel: li aggiorni o li togli senza toccare clienti, pipeline e calendario. Per cambiarlo chiedi al tuo agente di coding, per esempio «aggiungi il tempo medio di risposta per canale».';

/**
 * Starter prompt copied by «Copia il prompt» (spec C17). Fixed text so the
 * operator sends the same honest request every time: what to change, and
 * the boundary it must not cross.
 */
export const REPORTING_PROMPT_TEXT = 'Nel modulo reporting del /bo aggiungi il tempo medio di risposta per canale, senza toccare clienti, pipeline e calendario.';

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
    proof: 'La prova è pratica: il modulo si apre davvero e mostra un record. Se non si apre o non mostra niente, non esiste.',
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
import { el, uiButton } from './admin-ui.js'; // BO-F6-02: the single component library.

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
  // Clipboard write, injected so tests pass a spy: the fake DOM has no
  // navigator.clipboard. Resolves true when the prompt reached the
  // clipboard, false when the operator must copy by hand.
  const copy = deps.copy ?? (async ({ text }) => {
    try {
      const view = /** @type {any} */ (doc.defaultView ?? null);
      const write = view?.navigator?.clipboard?.writeText;
      if (typeof write !== 'function') return false;
      await write.call(view.navigator.clipboard, text);
      return true;
    } catch (error) {
      // A denied clipboard must stay diagnosable (AGENTS.md: swallowed
      // exceptions log the cause): name/code only, never the contents.
      const cause = error && typeof error === 'object'
        ? { name: error.name ?? 'Error', code: error.code ?? null }
        : { name: 'Error', code: null };
      log('reporting copy to clipboard failed', cause);
      return false;
    }
  });

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
   * "Nuovi clienti per canale" (BO-F6-13, slice 2, checklist C6-C7): stacked
   * weekly bars with the week total above each bar and a `<nome canale> <n>`
   * legend below. With no data the card still renders its title, `0 nel
   * periodo` and empty bars — never a blank screen (C20). Identities without
   * a usable date are named in a lede, never silently dropped.
   */
  function channelsCard(section, model) {
    const breakdown = model.channels ?? { weeks: [], channels: [], total: 0, undated: 0 };
    const panel = el(doc, 'section', { class: 'panel' });
    panel.appendChild(el(doc, 'h3', { text: 'Nuovi clienti per canale' }));
    panel.appendChild(el(doc, 'p', { class: 'lede', text: `${breakdown.total ?? 0} nel periodo` }));
    const slots = Array.isArray(breakdown.weeks) ? breakdown.weeks : [];
    const entries = Array.isArray(breakdown.channels) ? breakdown.channels : [];
    const totals = slots.map((slot, index) => {
      void slot;
      return entries.reduce((sum, entry) => sum + (entry.weeks?.[index] ?? 0), 0);
    });
    const max = Math.max(0, ...totals);
    const row = el(doc, 'div');
    row.setAttribute('style', 'display:flex;align-items:flex-end;gap:18px;padding:12px 4px 0 4px;min-height:150px;');
    slots.forEach((slot, index) => {
      const column = el(doc, 'div');
      column.setAttribute('style', 'flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;');
      column.appendChild(el(doc, 'span', { text: String(totals[index]) }));
      const stack = el(doc, 'div');
      const height = max > 0 ? Math.round((totals[index] / max) * 120) : 0;
      stack.setAttribute('style', `width:100%;max-width:64px;height:${height}px;display:flex;flex-direction:column-reverse;border-radius:6px;overflow:hidden;background:var(--surface-soft);`);
      for (const entry of entries) {
        const count = entry.weeks?.[index] ?? 0;
        if (count <= 0) continue;
        const segment = el(doc, 'div');
        segment.setAttribute('title', `${channelLabel(entry.channel)} ${count}`);
        segment.setAttribute('style', `height:${max > 0 ? Math.max(2, Math.round((count / max) * 120)) : 0}px;background:${channelColor(entry.channel)};`);
        stack.appendChild(segment);
      }
      column.appendChild(stack);
      column.appendChild(el(doc, 'span', { text: slot.label ?? '' }));
      row.appendChild(column);
    });
    panel.appendChild(row);
    const legend = el(doc, 'div', { class: 'actions' });
    for (const entry of entries) {
      const dot = el(doc, 'span');
      dot.setAttribute('style', `display:inline-block;width:10px;height:10px;border-radius:99px;background:${channelColor(entry.channel)};margin-right:6px;`);
      const item = el(doc, 'span', { text: `${channelLabel(entry.channel)} ${entry.total}` });
      item.setAttribute('style', 'margin-right:14px;font-size:13px;');
      const wrap = el(doc, 'span');
      wrap.appendChild(dot);
      wrap.appendChild(item);
      legend.appendChild(wrap);
    }
    panel.appendChild(legend);
    if ((breakdown.undated ?? 0) > 0) {
      panel.appendChild(el(doc, 'p', {
        class: 'lede',
        text: `Più ${breakdown.undated} senza data di primo contatto: contati nel riepilogo, fuori dalle barre.`,
      }));
    }
    section.appendChild(panel);
  }

  /**
   * One CSS-bar chart. Values are text beside the bar, so the chart stays
   * readable where styles fail; widths come from barWidth (0% when empty).
   */
  function barChart(section, title, subtitle, rows) {
    const panel = el(doc, 'section', { class: 'panel' });
    const head = el(doc, 'div', { class: 'bo-rep-head' });
    head.appendChild(el(doc, 'h3', { text: title }));
    head.appendChild(el(doc, 'p', { class: 'bo-rep-sub', text: subtitle }));
    panel.appendChild(head);
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
    const propose = el(doc, 'button', { class: 'primary', text: 'Proponi ridistribuzione dei lead' });
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
    section.appendChild(panel);
  }

  /**
   * "Questo modulo è codice tuo" (BO-F6-13, checklist C17): the custom
   * module documented as files, never as data state. «Copia il prompt»
   * copies the fixed starter prompt and shows a confirmation; «Esporta
   * CSV» downloads the exact dashboard bytes. Both buttons travel the
   * visual system through `el` (legacy `secondary` maps to `ui-btn`).
   */
  function codePanel(section, model) {
    const panel = el(doc, 'section', { class: 'panel' });
    panel.appendChild(el(doc, 'p', { class: 'kicker', text: 'Questo modulo è codice tuo' }));
    panel.appendChild(el(doc, 'p', { class: 'lede', text: REPORTING_CODE_LEDE }));
    const list = el(doc, 'ul');
    for (const file of REPORTING_CODE_FILES) {
      list.appendChild(el(doc, 'li', { text: file }));
    }
    panel.appendChild(list);
    const prompt = el(doc, 'pre');
    prompt.appendChild(el(doc, 'code', { text: REPORTING_PROMPT_TEXT }));
    panel.appendChild(prompt);
    const actions = el(doc, 'div', { class: 'actions' });
    const copyButton = el(doc, 'button', { class: 'primary', text: 'Copia il prompt' });
    copyButton.setAttribute('data-action', 'copia-prompt');
    copyButton.addEventListener('click', async () => {
      // No double copy: a second click changes nothing.
      if (copyButton.getAttribute('data-done') === 'true') return;
      const done = await copy({ doc, text: REPORTING_PROMPT_TEXT });
      copyButton.setAttribute('data-done', 'true');
      panel.appendChild(el(doc, 'p', {
        class: 'lede',
        text: done
          ? 'Prompt copiato negli appunti.'
          : 'Appunti non disponibili: seleziona e copia il testo qui sopra.',
      }));
    });
    actions.appendChild(copyButton);
    const csv = el(doc, 'button', { class: 'secondary', text: 'Esporta CSV' });
    csv.setAttribute('data-action', 'esporta-csv');
    csv.addEventListener('click', () => {
      download({ doc, filename: model.csv.filename, content: model.csv.content });
    });
    actions.appendChild(csv);
    panel.appendChild(actions);
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
    // Supervisor design pass (prototype 09): charts on a six-column grid —
    // channels wide beside the funnel, three charts per row, the forecast
    // full width, the team table beside the insights. Money reads as euro,
    // never as raw minor units.
    const grid = el(doc, 'div', { class: 'bo-rep-grid' });
    host.appendChild(grid);
    const tag = (cls) => { if (grid.lastChild && grid.lastChild.classList) grid.lastChild.classList.add(cls); };
    const eur = (minor) => formatMoney(minor, model.currency);
    channelsCard(grid, model); tag('bo-rep-wide');
    barChart(grid, 'Preventivi', 'dall\u2019invio al pagamento', model.funnel.map((entry) => ({
      label: entry.label, minor: entry.count, text: `${entry.count} · ${eur(entry.minor)}`,
    }))); tag('bo-rep-narrow');
    barChart(grid, 'Valore per fase', 'valore aperto per fase', model.valueByStage.map((entry) => ({
      label: entry.label, minor: entry.minor, text: eur(entry.minor),
    }))); tag('bo-rep-third');
    barChart(grid, 'Chiusure attese per mese', 'preventivi aperti per mese', model.monthly.map((entry) => ({
      label: entry.label, minor: entry.expectedMinor, text: `${entry.openCount} · ${eur(entry.expectedMinor)}`,
    }))); tag('bo-rep-third');
    barChart(grid, 'Vendite per persona', 'valore aperto per persona', model.team.map((entry) => ({
      label: entry.owner, minor: entry.openMinor, text: `${entry.openCount} · ${eur(entry.openMinor)}`,
    }))); tag('bo-rep-third');
    forecastPanel(grid, model); tag('bo-rep-full');
    teamTable(grid, model); tag('bo-rep-wide');
    insightsPanel(grid, model); tag('bo-rep-narrow');
    codePanel(grid, model); tag('bo-rep-narrow');
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
    const dashHost = el(doc, 'div', { class: 'bo-rep' });
    const top = el(doc, 'div', { class: 'bo-rep-top' });
    top.appendChild(el(doc, 'p', { class: 'kicker', text: 'Modulo personalizzato' }));
    top.appendChild(el(doc, 'h1', { class: 'bo-rep-title', text: 'Reporting' }));
    // Badge row (checklist C2): bundle identity under the title. The
    // `.kicker` paints uppercase through CSS, so the source keeps the
    // sentence case the shell owns; badges stay mono through `.badge`.
    const badges = el(doc, 'div', { class: 'actions' });
    for (const badge of REPORTING_BADGES) {
      badges.appendChild(el(doc, 'span', { class: 'badge', text: badge }));
    }
    top.appendChild(badges);
    dashHost.appendChild(top);
    await renderDashboard(dashHost);
    if (token !== renderToken) return;
    mount.appendChild(dashHost);
    const panel = kicker('Reporting', 'Righe del report');
    panel.classList.add('bo-rep-rows');
    panel.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Le righe del report, con i dati dell\u2019operatore come l\u2019obiettivo di periodo.',
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
      text: 'Un modulo è un pacchetto di funzioni a parte: si aggiunge e si toglie senza toccare clienti, pipeline e calendario. Come è fatto davvero è scritto in docs/BUNDLES.md.',
    }));
    const list = el(doc, 'ul');
    for (const line of [
      'Versionato: una versione non cambia mai, per cambiare si fa una versione nuova.',
      'Rimovibile: toglierlo toglie solo le sue tabelle, il resto resta.',
      'Vero: il modulo funziona davvero e mostra un record, altrimenti non esiste.',
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
    // Design pass 6: the prototype's "Nuovo modulo personalizzato" form — four
    // questions an owner can answer, the green "Genera il modulo", and the
    // AI shortcut. The answers travel to the assistant's guided path as one
    // description (the same handoff as "Crea con l'AI"): nothing is generated
    // or saved here. The developer steps stay one click away, closed.
    const card = el(doc, 'section', { class: 'panel bo-modulo-form' });
    card.appendChild(el(doc, 'p', { class: 'kicker', text: 'Moduli personalizzati' }));
    card.appendChild(el(doc, 'h2', { text: 'Nuovo modulo personalizzato' }));
    card.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Diventa un bundle separato dal kernel: il tuo agente di coding lo genera nel progetto e lo puoi togliere quando vuoi.',
    }));
    const questions = [
      ['nome', 'Nome del modulo', 'Es. Magazzino campioni'],
      ['cosa', 'Cosa deve mostrare o fare', 'Es. campioni prestati ai clienti e date di rientro'],
      ['dati', 'Dati usati', 'Clienti, offerte, appuntamenti…'],
      ['chi', 'Chi può vederlo', 'Titolare, Vendite…'],
    ];
    /** @type {Record<string, any>} */
    const inputs = {};
    for (const [name, text, placeholder] of questions) {
      const label = el(doc, 'label', { class: 'bo-modulo-field', text });
      const input = doc.createElement('input');
      input.setAttribute('class', 'ui-field'); // BO-F6-02: system field class.
      input.setAttribute('name', `modulo-${name}`);
      input.setAttribute('placeholder', placeholder);
      label.appendChild(input);
      card.appendChild(label);
      inputs[name] = input;
    }
    const footer = el(doc, 'div', { class: 'bo-modulo-actions' });
    const ai = el(doc, 'button', { class: 'bo-modulo-ai', text: '✦ Preferisco farlo con l\u2019AI' });
    ai.setAttribute('data-action', 'chiedi-assistente');
    ai.addEventListener('click', () => onAskAi('nuovo-modulo', ''));
    footer.appendChild(ai);
    const generate = uiButton(doc, { variant: 'cta', label: 'Genera il modulo', attrs: { 'data-action': 'genera-modulo' } });
    generate.addEventListener('click', () => {
      const lines = [];
      for (const [name, text] of questions) {
        const value = String(inputs[name].value ?? '').trim();
        if (value !== '') lines.push(`${text}: ${value}`);
      }
      onAskAi('nuovo-modulo', lines.join('\n'));
    });
    footer.appendChild(generate);
    card.appendChild(footer);
    mount.appendChild(card);

    const dev = el(doc, 'details', { class: 'panel bo-modulo-dev' });
    dev.appendChild(el(doc, 'summary', { text: 'Per chi sviluppa: il manifest e i comandi' }));
    dev.appendChild(el(doc, 'p', {
      class: 'lede',
      text: 'Stesso formato dell\u2019agente (docs/MODULE_MANIFEST.md, docs/BUNDLES.md): scrivi il manifest ed esegui i suoi comandi.',
    }));
    const steps = el(doc, 'ol');
    for (const item of manualSteps().checklist) {
      steps.appendChild(el(doc, 'li', { text: item }));
    }
    dev.appendChild(steps);
    const commands = manualSteps().commands;
    for (const command of [commands.create, commands.verify, commands.install]) {
      const code = el(doc, 'pre');
      code.appendChild(el(doc, 'code', { text: command }));
      dev.appendChild(code);
    }
    dev.appendChild(el(doc, 'p', { class: 'lede', text: manualSteps().proof }));
    dev.appendChild(sviluppaCard());
    mount.appendChild(dev);
  }

  return { renderReporting, renderNuovoModulo };
}
