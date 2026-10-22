import { createSubmissionController, requireSubmissionContext } from './admin-submission.js';
import { createAssistantPanel } from './admin-assistant.js';
import { resolveAdminBase } from './admin-base.js';

// The mount prefix the shell is served under: '' at the domain root, the
// mount's subtree (e.g. '/bo') when embedded (backlog:ecdf7dc4). Every
// absolute API path below is prefixed, so the shell works unchanged.
const ADMIN_BASE = resolveAdminBase();

// Under a space mount (e.g. `/bo`) the home is the Oggi frame and the
// framework demo is never rendered (backlog:7eee63a5). The standalone
// development server owns the domain root and keeps the demo.
const MOUNTED = isSpaceMount(ADMIN_BASE);

const boMain = document.querySelector('.bo-main');
const dashboardView = document.querySelector('#view-dashboard');
const moduleView = document.querySelector('#view-module');
// Standalone only: the served HTML carries no demo markup, so the demo
// chrome is rendered here, before any ref below is captured.
const demoRefs = MOUNTED
  ? null
  : renderDemoChrome({ doc: document, main: boMain, moduleView, dashboardView });

const elements = {
  metrics: demoRefs?.metrics ?? null,
  opportunities: demoRefs?.opportunities ?? null,
  opportunitiesEmpty: demoRefs?.opportunitiesEmpty ?? null,
  approvals: demoRefs?.approvals ?? null,
  approvalsEmpty: demoRefs?.approvalsEmpty ?? null,
  traces: demoRefs?.traces ?? null,
  tracesEmpty: demoRefs?.tracesEmpty ?? null,
  demoButton: demoRefs?.demoButton ?? null,
  refreshButton: demoRefs?.refreshButton ?? null,
  traceDetail: demoRefs?.traceDetail ?? null,
  traceTitle: demoRefs?.traceTitle ?? null,
  traceSpans: demoRefs?.traceSpans ?? null,
  closeTrace: demoRefs?.closeTrace ?? null,
  toast: document.querySelector('#toast'),
};

const headers = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'admin-demo',
};

function isMutation(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method ?? 'GET').toUpperCase());
}

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  /** @type {Record<string, string>} */
  const requestHeaders = { ...headers, ...(options.headers || {}) };
  if (isMutation(method)) {
    requestHeaders['Idempotency-Key'] = requireSubmissionContext(options);
  }
  const response = await fetch(`${ADMIN_BASE}${path}`, { ...options, headers: requestHeaders });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    Object.assign(error, { status: response.status, code: body?.error?.code, details: body?.error?.details ?? null });
    throw error;
  }
  return body;
}

const submissions = createSubmissionController({
  transport: (path, options) => api(path, {
    method: options.method,
    body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
    idempotencyKey: options.idempotencyKey,
  }),
});

// Request client for generated-module views. A declared identity for audit —
// NOT authentication; a local caller can set any actor. The Admin is
// local-development-only until a deployment supplies an identity verifier.
const moduleClient = {
  async request(path, options = {}) {
    const method = options.method ?? 'GET';
    /** @type {Record<string, string>} */
    const requestHeaders = {
      'content-type': 'application/json',
      'x-actor-type': 'user',
      'x-actor-id': 'admin-ui',
      ...(options.headers || {}),
    };
    if (isMutation(method)) {
      requestHeaders['Idempotency-Key'] = requireSubmissionContext(options);
    }
    const response = await fetch(`${ADMIN_BASE}${path}`, {
      ...options,
      headers: requestHeaders,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
      Object.assign(error, {
        status: response.status,
        code: payload?.error?.code ?? 'UNKNOWN',
        details: payload?.error?.details ?? null,
      });
      throw error;
    }
    if (payload === undefined) throw Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE' });
    return payload;
  },
};

async function refresh() {
  toggleBusy(elements.refreshButton, true);
  try {
    const metricsPromise = api('/api/admin/metrics').then(
      (body) => ({ available: true, counts: body.counts }),
      () => ({ available: false, counts: null }),
    );
    const [health, metrics, opportunities, approvals, traces, pendingWrites] = await Promise.all([
      api('/health'),
      metricsPromise,
      api('/api/opportunities'),
      api('/api/approvals?status=pending'),
      api('/api/traces?limit=8'),
      api('/api/write-outcomes').then((body) => body, () => ({ items: [] })),
    ]);
    if (health.ok !== true) throw new Error('Runtime health check failed');
    if (metrics.available) renderMetrics(metrics.counts);
    else renderMetricsUnavailable();
    renderOpportunities(opportunities.items);
    renderApprovals(approvals.items);
    renderTraces(traces.items);
    await refreshShellBadge();
    const unacked = Array.isArray(pendingWrites?.items) ? pendingWrites.items.length : 0;
    if (unacked > 0) {
      toast(`${unacked} unacknowledged submission${unacked === 1 ? '' : 's'} recovered.`);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    toggleBusy(elements.refreshButton, false);
  }
}

function metricItems(counts) {
  return [
    ['Companies', counts.companies],
    ['Opportunities', counts.opportunities],
    ['Pending approvals', counts.pendingApprovals],
    ['Traced runs', counts.workflowRuns],
  ];
}

function renderMetrics(counts) {
  elements.metrics.innerHTML = metricItems(counts).map(([label, value]) => `
    <div class="metric"><strong>${value}</strong><span>${label}</span></div>
  `).join('');
}

function renderMetricsUnavailable() {
  const items = [
    ['Companies', '—'],
    ['Opportunities', '—'],
    ['Pending approvals', '—'],
    ['Traced runs', '—'],
  ];
  elements.metrics.innerHTML = items.map(([label, value]) => `
    <div class="metric"><strong>${value}</strong><span>${label}</span></div>
  `).join('');
}

function renderOpportunities(items) {
  elements.opportunitiesEmpty.classList.toggle('hidden', items.length > 0);
  elements.opportunities.innerHTML = items.map((item) => {
    const action = item.stage === 'qualification'
      ? `<button class="small secondary" data-stage="${item.id}">Request proposal</button>`
      : '';
    return `
      <tr>
        <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type.replace('_', ' '))}</small></td>
        <td>${escapeHtml(item.companyName || '—')}</td>
        <td><strong>${formatMoney(item.valueCents, item.currency)}</strong></td>
        <td><span class="badge ${item.stage}">${escapeHtml(item.stage)}</span></td>
        <td>${escapeHtml(item.owner)}</td>
        <td>${action}</td>
      </tr>
    `;
  }).join('');

  elements.opportunities.querySelectorAll('[data-stage]').forEach((button) => {
    button.addEventListener('click', () => requestProposal(button.dataset.stage, button));
  });
}

function renderApprovals(items) {
  elements.approvalsEmpty.classList.toggle('hidden', items.length > 0);
  elements.approvals.innerHTML = items.map((item) => `
    <div class="card">
      <div class="card-row">
        <div>
          <strong>${escapeHtml(item.opportunityName || item.opportunityId)}</strong>
          <p>${escapeHtml(item.companyName || '')} · ${formatMoney(item.valueCents, item.currency)}</p>
        </div>
        <span class="badge ${item.status}">${item.status}</span>
      </div>
      <p>${escapeHtml(item.reason)}</p>
      <div class="card-actions">
        <button class="small primary" data-approve="${item.id}">Approve</button>
        <button class="small danger" data-reject="${item.id}">Reject</button>
      </div>
    </div>
  `).join('');

  elements.approvals.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', () => decide(button.dataset.approve, 'approve', button));
  });
  elements.approvals.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', () => decide(button.dataset.reject, 'reject', button));
  });
}

function renderTraces(items) {
  elements.tracesEmpty.classList.toggle('hidden', items.length > 0);
  elements.traces.innerHTML = items.map((item) => `
    <div class="card" data-trace="${item.id}">
      <div class="card-row">
        <div>
          <strong>${escapeHtml(item.workflowName)}</strong>
          <p>${new Date(item.startedAt).toLocaleString()}</p>
        </div>
        <span class="badge ${item.status}">${item.status}</span>
      </div>
    </div>
  `).join('');
  elements.traces.querySelectorAll('[data-trace]').forEach((card) => {
    card.addEventListener('click', () => showTrace(card.dataset.trace));
  });
}

async function requestProposal(id, button) {
  toggleBusy(button, true);
  try {
    const result = await submissions.submit({
      path: `/api/opportunities/${id}/stage`,
      method: 'POST',
      body: { targetStage: 'proposal' },
    });
    toast(result.output.outcome === 'approval_required' ? 'Approval requested.' : 'Moved to Proposal.');
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    toggleBusy(button, false);
  }
}

async function decide(id, decision, button) {
  toggleBusy(button, true);
  try {
    await submissions.submit({
      path: `/api/approvals/${id}/${decision}`,
      method: 'POST',
      body: {},
    });
    toast(decision === 'approve' ? 'Renewal approved.' : 'Renewal rejected.');
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    toggleBusy(button, false);
  }
}

async function showTrace(id) {
  try {
    const run = await api(`/api/traces/${id}`);
    elements.traceTitle.textContent = `${run.workflowName} · ${run.status}`;
    elements.traceSpans.innerHTML = run.spans.map((span) => `
      <div class="span ${span.status}">
        <div class="dot"></div>
        <div>
          <h3>${escapeHtml(span.name)}</h3>
          ${span.error ? `<pre>${escapeHtml(span.error)}</pre>` : `<pre>${escapeHtml(JSON.stringify(span.output, null, 2))}</pre>`}
        </div>
        <span class="meta">${duration(span.startedAt, span.finishedAt)}</span>
      </div>
    `).join('');
    elements.traceDetail.classList.remove('hidden');
    elements.traceDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(error.message, true);
  }
}

async function runDemo() {
  toggleBusy(elements.demoButton, true);
  try {
    await submissions.submit({ path: '/api/demo/run', method: 'POST', body: {} });
    toast('Demo created: €20k moved to Proposal; €80k awaits approval.');
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    toggleBusy(elements.demoButton, false);
  }
}

function formatMoney(cents, currency = 'EUR') {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

function duration(start, end) {
  if (!start || !end) return '—';
  return `${Math.max(0, new Date(end) - new Date(start))} ms`;
}

function toggleBusy(element, busy) {
  if (!element) return;
  element.disabled = busy;
}

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 3200);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

if (elements.demoButton) elements.demoButton.addEventListener('click', runDemo);
if (elements.refreshButton) elements.refreshButton.addEventListener('click', refresh);
if (elements.closeTrace) {
  elements.closeTrace.addEventListener('click', () => elements.traceDetail.classList.add('hidden'));
}

// ---- Hash routing + generated-module navigation -------------------------

import {
  ACTIVE_SPACE_KEY,
  buildShellNav,
  createShellView,
  loadFixCount,
  readSpaces,
  renderSettingsPanel,
} from './admin-shell.js';
import { buildOggiLinks, isSpaceMount, renderOggi } from './admin-oggi.js';
import { renderDemoChrome } from './admin-demo.js';
import { createModuleAdmin } from './admin-modules.js';
import { createPipelineBoard } from './admin-pipeline.js';
import { createQuoteView } from './admin-quotes.js';
import { createCatalogView, commercialBlock } from './admin-catalog.js';
import { createWorkView } from './admin-work.js';
import { createMarketingView } from './admin-marketing.js';
import { createCustomerCardView } from './admin-customer-card.js';
import { createCustomerDataView } from './admin-customer-data.js';
import { createConnectorsView } from './admin-connectors.js';
import { createPersonalizzazioneView } from './admin-personalizzazione.js';
import { createSpineView } from './admin-spine.js';
import { humanizeLabel, parseModuleRoute, shellNavInput } from './admin-core.js';

const generatedNav = document.querySelector('#generatedNav');

const moduleAdmin = createModuleAdmin({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
  toast,
});

const pipelineBoard = createPipelineBoard({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  toast,
});

// Quote builder (ADR-016) over the ADR-009 override seam: the generic action
// forms cannot browse a price book, so this focused view owns that experience
// while every mutation still goes through the same server actions.
const quoteView = createQuoteView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
});

// Product catalog (BO-F2-05): the backoffice product table with its source
// summary. Renders only while the server publishes the commercial package;
// otherwise the view itself says so.
const catalogView = createCatalogView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  navigate: (hash) => { window.location.hash = hash; },
});

// Work (ADR-030): the package-scoped task queue and its activity timeline. The
// section renders only while the server publishes the work package.
const workView = createWorkView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
});

// Marketing proposals (MK1): the review screen for a complete-or-refused
// campaign proposal. Renders only while the server publishes the marketing
// package.
const marketingView = createMarketingView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
});

// Shell persistence first: the views below read this at construction, so it
// must exist before any of them (a later `const` would throw a temporal-dead-zone
// error on every page load). Private mode keeps tab state without persisting.
function guardedStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Private mode: shell state simply does not persist.
  }
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

const shellStorage = guardedStorage();

// Customer scheda (BO-F1-06): the three-column customer view, a read-only
// projection over the hub. Renders only while the server publishes the
// customer-hub package; otherwise the view itself says so.
const customerCardView = createCustomerCardView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  navigate: (hash) => { window.location.hash = hash; },
  // The shell's active space, read late: the calls read stays
  // space-explicit and follows the space switcher (BO-F1-08).
  spaceId: () => shellActiveSpace ?? shellSpaces[0]?.id ?? null,
});

// Customer Data Foundation (ADR-037): import, duplicate candidates, the data
// quality queue and the read-only profile. Renders only while the server
// publishes the customer-data package.
const customerDataView = createCustomerDataView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
  notify: (message) => toast(message),
  // BO-F1-05: the space the calls read stays space-explicit, and the AI
  // filter entry opens the BO-F0-04 assistant on the Clienti screen (its
  // dry-run answers the key notice when no LLM backend is present).
  spaceId: () => shellActiveSpace ?? shellSpaces[0]?.id ?? null,
  onAskAi: () => {
    if (assistantPanel) void assistantPanel.open('clienti');
    else toast('Apri la barra AI (⌘K) e descrivi chi vuoi vedere.');
  },
  storage: shellStorage,
});

// Connectors (BO-F1-02).

// Production Spine (ADR-038): verified identity, the tenant, memberships and
// what this build cannot promise. Always available — an application with no
// spine composed still renders the section, saying exactly that, because a
// missing security screen reads as "fine" and it is not.
const spineView = createSpineView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
});

// ---- Backoffice shell (BO-F0-02) ------------------------------------------
// Sidebar + topbar chrome on every screen: Italian voices from the approved
// prototype, space selector (⌘1/2/3), Impostazioni badge from the real
// data-quality count, AI bar (⌘K) opening the BO-F0-04 assistant panel.
// Spaces are local shell state until space records exist (BO-F0-06).

// Connectors (BO-F1-02): the 3-step connect flow over the channels package.
// Renders only while the server publishes the channels package; otherwise
// the view itself says so.
const connectorsView = createConnectorsView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  submissions,
  navigate: (hash) => { window.location.hash = hash; },
  storage: shellStorage,
  toast,
});

// Personalizzazione (BO-F4-01): Skill, Connettori and Pacchetti per space.
// Renders only while the server publishes the space-permissions composition
// catalog; otherwise the view itself says so.
const personalizzazioneView = createPersonalizzazioneView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  navigate: (hash) => { window.location.hash = hash; },
  spaceId: () => shellActiveSpace ?? shellSpaces[0]?.id ?? null,
  storage: shellStorage,
  toast,
});
const shellSpaces = readSpaces(shellStorage);
let shellActiveSpace = null;
try {
  const stored = shellStorage.getItem(ACTIVE_SPACE_KEY);
  if (typeof stored === 'string' && shellSpaces.some((space) => space.id === stored)) shellActiveSpace = stored;
} catch {
  // Keep the default space.
}

let currentScreenId = 'oggi';
let assistantPanel = null;
const boAssistant = document.querySelector('#boAssistant');
if (boAssistant) {
  assistantPanel = createAssistantPanel({
    doc: document,
    mount: boAssistant,
    client: moduleClient,
    navigate: (hash) => { window.location.hash = hash; },
    notify: (message) => toast(message),
  });
}

let shellView = null;
const boSidebar = document.querySelector('#boSidebar');
const boTopbar = document.querySelector('#boTopbar');
if (boSidebar && boTopbar) {
  shellView = createShellView({
    doc: document,
    sidebar: boSidebar,
    topbar: boTopbar,
    spaces: shellSpaces,
    user: { name: 'Operatore locale', email: 'sviluppo locale' },
    navigate: (hash) => { window.location.hash = hash; },
    notify: (message) => toast(message),
    onLogout: () => {
      try { shellStorage.removeItem(ACTIVE_SPACE_KEY); } catch {
        // Logout still lands home without persistence.
      }
      shellActiveSpace = null;
      if (shellView) shellView.setSpaces(shellSpaces, shellSpaces[0].id);
      window.location.hash = '#/';
      toast('Spazio locale reimpostato.');
    },
    onAiSubmit: () => {
      if (assistantPanel) void assistantPanel.open(currentScreenId);
    },
    onPickSpace: (id) => {
      shellActiveSpace = id;
      try { shellStorage.setItem(ACTIVE_SPACE_KEY, id); } catch {
        // The switch still applies to this tab.
      }
      // The open card shows space-scoped calls (BO-F1-08): re-render it on
      // the new space instead of leaving the previous space's summaries.
      // The mounted home greets with the space name: re-render it too.
      const openView = targetForHash(window.location.hash || '#/').view;
      if (openView === 'customer-card' || (MOUNTED && openView === 'dashboard')) route();
    },
    win: typeof window !== 'undefined' ? window : null,
  });
  if (shellActiveSpace) shellView.setSpaces(shellSpaces, shellActiveSpace);
}

let shellItems = buildShellNav();
let shellFixCount = null;
let shellCustomerData = false;

function currentSpaceName() {
  const active = shellSpaces.find((space) => space.id === shellActiveSpace) ?? shellSpaces[0];
  return typeof active?.name === 'string' ? active.name : '';
}

function shellScreenFor(target) {
  switch (target.view) {
    case 'dashboard': return { id: 'oggi', label: 'Oggi' };
    case 'customer-data':
    case 'customer-profile':
    case 'customer-card': return { id: 'clienti', label: 'Clienti' };
    case 'pipeline': return { id: 'pipeline', label: 'Pipeline' };
    case 'settings': return { id: 'impostazioni', label: 'Impostazioni' };
    case 'list':
    case 'new':
    case 'detail':
      return target.moduleName
        ? { id: `module-${target.moduleName}`, label: target.moduleName }
        : { id: null, label: 'Modulo' };
    // Admin views outside the backoffice prototype: an honest crumb with no
    // sidebar highlight, never the previous screen left stale.
    case 'spine': return { id: null, label: 'Identità e accessi' };
    case 'work': return { id: null, label: 'Lavoro' };
    case 'work-task': return { id: null, label: 'Attività' };
    case 'marketing': return { id: null, label: 'Proposte' };
    case 'marketing-proposal': return { id: null, label: 'Proposta' };
    case 'quotes': return { id: null, label: 'Preventivi' };
    case 'catalog': return { id: null, label: 'Catalogo prodotti' };
    case 'quote-detail': return { id: null, label: 'Preventivo' };
    case 'connectors': return { id: 'impostazioni', label: 'Connettori' };
    case 'personalizzazione': return { id: 'impostazioni', label: 'Personalizzazione' };
    case 'invalid': return { id: null, label: 'Percorso non valido' };
    default: return { id: null, label: 'Vista' };
  }
}

function syncShell(target) {
  if (!shellView) return;
  const screen = shellScreenFor(target);
  currentScreenId = typeof screen?.id === 'string' && screen.id !== '' ? screen.id : 'oggi';
  shellView.update({
    fixCount: shellFixCount,
    items: shellItems,
    activeScreenId: typeof screen?.id === 'string' ? screen.id : '',
    screenLabel: typeof screen?.label === 'string' && screen.label !== '' ? screen.label : 'Vista',
  });
}

async function refreshShellBadge() {
  if (!shellView || !shellCustomerData) return;
  shellFixCount = await loadFixCount(moduleClient);
  shellView.update({ fixCount: shellFixCount });
}

async function populateNav() {
  try {
    const schema = await moduleClient.request('/api/schema');
    // Backoffice shell (BO-F0-02): generated modules are the
    // "personalizzati" group; the first composed pipeline backs Pipeline.
    // The envelope-to-input reading lives in shellNavInput (admin-core.js),
    // unit-tested there — this stays the same call with the same result.
    const input = shellNavInput(schema);
    const { customModules: modules, modulesSupported: supported } = input;
    shellCustomerData = input.customerDataAvailable;
    shellItems = buildShellNav(input);
    // The route owns screen state: re-sync to the current hash after the
    // shell items update, so a cold deep link keeps its screen.
    syncShell(targetForHash(window.location.hash || '#/'));
    await refreshShellBadge();
    // Mounted home (backlog:7eee63a5): the Oggi links follow the delivered
    // screens, which are known only after the schema arrives — re-render an
    // open home so it never shows the pre-schema voices.
    if (MOUNTED && targetForHash(window.location.hash || '#/').view === 'dashboard') route();
    // The legacy module nav lives inside the demo chrome, which is rendered
    // standalone only: under a mount there is nothing to fill here.
    if (!generatedNav) return;
    while (generatedNav.firstChild) generatedNav.removeChild(generatedNav.firstChild);
    if (!supported) {
      const note = document.createElement('span');
      note.className = 'modnav-note';
      note.textContent = 'Generated modules need an Admin update';
      generatedNav.appendChild(note);
      return;
    }
    for (const module of modules) {
      const link = document.createElement('a');
      link.setAttribute('href', `#/modules/${module.name}`);
      link.setAttribute('data-nav', `module-${module.name}`);
      link.textContent = humanizeLabel(module.name); // safe: textContent
      generatedNav.appendChild(link);
    }
    // Quote builder (ADR-016): one nav link when the project has commercial
    // operations installed (the schema block is additive).
    if (schema?.commercial?.commercialContract === 1 && modules.some((module) => module.name === 'quote')) {
      const link = document.createElement('a');
      link.setAttribute('href', '#/quotes');
      link.setAttribute('data-nav', 'quotes');
      link.textContent = 'Quotes';
      generatedNav.appendChild(link);
    }
    // Product catalog (BO-F2-05): one nav link when the commercial product
    // records are composed — the table reads `product`, so without it the
    // view would only ever say it is unavailable. The block lives under
    // `domains.commercial` (same helper as the view), never top-level.
    if (commercialBlock(schema)?.commercialContract === 1 && modules.some((module) => module.name === 'product')) {
      const link = document.createElement('a');
      link.setAttribute('href', '#/catalogo');
      link.setAttribute('data-nav', 'catalog');
      link.textContent = 'Catalogo';
      generatedNav.appendChild(link);
    }
    // Marketing (MK1): one nav link when the project composes the marketing package.
    if (schema?.domains?.marketing?.marketingContract === 1) {
      const link = document.createElement('a');
      link.setAttribute('href', '#/marketing');
      link.setAttribute('data-nav', 'marketing');
      link.textContent = 'Proposals';
      generatedNav.appendChild(link);
    }
    // Work (ADR-030): one nav link when the project composes the work package.
    if (schema?.domains?.work?.workContract === 1) {
      const link = document.createElement('a');
      link.setAttribute('href', '#/work');
      link.setAttribute('data-nav', 'work');
      link.textContent = 'Work';
      generatedNav.appendChild(link);
    }
    // Customer data (ADR-037): one nav link when the package is composed.
    if (schema?.domains?.['customer-data']?.metadata?.customerDataContract === 1
      || schema?.domains?.['customer-data']?.customerDataContract === 1) {
      const link = document.createElement('a');
      link.setAttribute('href', '#/customer-data');
      link.setAttribute('data-nav', 'customer-data');
      link.textContent = 'Customer data';
      generatedNav.appendChild(link);
    }
    // The spine link is unconditional: whether or not a spine is composed is
    // exactly the thing an operator needs to be able to look up.
    {
      const link = document.createElement('a');
      link.setAttribute('href', '#/spine');
      link.setAttribute('data-nav', 'spine');
      link.textContent = 'Identity & access';
      generatedNav.appendChild(link);
    }
    // Pipeline boards (ADR-014): one nav link per registered pipeline, from
    // the same schema payload, canonical names only.
    if (schema?.pipelineContract === 1 && Array.isArray(schema.pipelines)) {
      for (const pipeline of schema.pipelines) {
        if (typeof pipeline?.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(pipeline.name)) continue;
        const link = document.createElement('a');
        link.setAttribute('href', `#/pipelines/${pipeline.name}`);
        link.setAttribute('data-nav', `pipeline-${pipeline.name}`);
        link.textContent = typeof pipeline.label === 'string' ? pipeline.label : pipeline.name; // safe: textContent
        generatedNav.appendChild(link);
      }
    }
  } catch {
    // A schema failure must not break the dashboard; leave nav empty silently.
  }
}

function targetForHash(hash) {
  // Backoffice shell (BO-F0-02): the Impostazioni entry. Its tabs land in
  // BO-F0-03; today Stato sync links to the existing quality queue.
  if (/^#\/impostazioni\/?$/.test(String(hash || '').split('?')[0])) return { view: 'settings' };
  return parseModuleRoute(hash);
}

async function route() {
  const hash = window.location.hash || '#/';
  if (targetForHash(hash).view === 'settings') {
    dashboardView.classList.add('hidden');
    moduleView.classList.remove('hidden');
    renderSettingsPanel({
      doc: document,
      mount: moduleView,
      fixCount: shellFixCount,
      navigate: (next) => { window.location.hash = next; },
      customerDataAvailable: shellCustomerData,
    });
    syncShell({ view: 'settings' });
    return;
  }
  const target = targetForHash(hash);
  syncShell(target);
  const onDashboard = target.view === 'dashboard';
  if (onDashboard && MOUNTED) {
    // Space home (backlog:7eee63a5): the Oggi frame, never the demo. The
    // demo dashboard stays hidden for the whole session under a mount.
    dashboardView.classList.add('hidden');
    moduleView.classList.remove('hidden');
    renderOggi({
      doc: document,
      mount: moduleView,
      spaceName: currentSpaceName(),
      links: buildOggiLinks(shellItems),
      navigate: (next) => { window.location.hash = next; },
      now: new Date(),
    });
    return;
  }
  dashboardView.classList.toggle('hidden', !onDashboard);
  moduleView.classList.toggle('hidden', onDashboard);
  // Set the active nav link by comparing the safe href we built ourselves,
  // never by constructing a selector from route input.
  for (const link of (generatedNav?.querySelectorAll('a') ?? [])) {
    const active = !onDashboard && (
      link.getAttribute('href') === `#/modules/${target.moduleName}` ||
      (target.view === 'pipeline' && link.getAttribute('href') === `#/pipelines/${target.pipelineName}`) ||
      ((target.view === 'quotes' || target.view === 'quote-detail') && link.getAttribute('href') === '#/quotes') ||
      (target.view === 'catalog' && link.getAttribute('href') === '#/catalogo') ||
      ((target.view === 'work' || target.view === 'work-task') && link.getAttribute('href') === '#/work') ||
      ((target.view === 'marketing' || target.view === 'marketing-proposal') && link.getAttribute('href') === '#/marketing') ||
      ((target.view === 'customer-data' || target.view === 'customer-profile' || target.view === 'customer-card') && link.getAttribute('href') === '#/customer-data')
      || (target.view === 'spine' && link.getAttribute('href') === '#/spine')
    );
    link.classList.toggle('active', active);
  }
  if (onDashboard) return;
  if (target.view === 'invalid') {
    moduleView.textContent = '';
    const box = document.createElement('div');
    box.className = 'panel';
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = 'That module route is not valid.';
    box.appendChild(message);
    moduleView.appendChild(box);
    return;
  }
  try {
    if (target.view === 'list') await moduleAdmin.renderList(target.moduleName);
    else if (target.view === 'new') await moduleAdmin.renderNew(target.moduleName);
    else if (target.view === 'detail') await moduleAdmin.renderDetail(target.moduleName, target.id);
    else if (target.view === 'pipeline') await pipelineBoard.renderBoard(target.pipelineName);
    else if (target.view === 'catalog') await catalogView.renderTable();
    else if (target.view === 'quotes') await quoteView.renderQuoteList();
    else if (target.view === 'quote-detail') await quoteView.renderQuoteDetail(target.quoteId);
    else if (target.view === 'spine') await spineView.render();
    else if (target.view === 'customer-data') await customerDataView.render();
    else if (target.view === 'connectors') await connectorsView.render();
    else if (target.view === 'personalizzazione') await personalizzazioneView.render();
    else if (target.view === 'customer-profile') await customerDataView.renderProfile(target.resource, target.subjectId);
    else if (target.view === 'customer-card') await customerCardView.renderCard(target.resource, target.subjectId);
    else if (target.view === 'work') await workView.renderQueue();
    else if (target.view === 'work-task') await workView.renderTask(target.taskId);
    else if (target.view === 'marketing') await marketingView.renderProposalList();
    else if (target.view === 'marketing-proposal') await marketingView.renderProposalDetail(target.proposalId);
  } catch (error) {
    toast(error.message, true);
  }
}

window.addEventListener('hashchange', route);
populateNav();
route();
// The demo dashboard fetches framework records: standalone only. Under a
// mount the home is the Oggi frame, which reads no record at all.
if (!MOUNTED) refresh();
