const elements = {
  metrics: document.querySelector('#metrics'),
  opportunities: document.querySelector('#opportunities'),
  opportunitiesEmpty: document.querySelector('#opportunitiesEmpty'),
  approvals: document.querySelector('#approvals'),
  approvalsEmpty: document.querySelector('#approvalsEmpty'),
  traces: document.querySelector('#traces'),
  tracesEmpty: document.querySelector('#tracesEmpty'),
  demoButton: document.querySelector('#demoButton'),
  refreshButton: document.querySelector('#refreshButton'),
  traceDetail: document.querySelector('#traceDetail'),
  traceTitle: document.querySelector('#traceTitle'),
  traceSpans: document.querySelector('#traceSpans'),
  closeTrace: document.querySelector('#closeTrace'),
  toast: document.querySelector('#toast'),
};

const headers = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'admin-demo',
};

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

// Request client for generated-module views. A declared identity for audit —
// NOT authentication; a local caller can set any actor. The Admin is
// local-development-only until auth/tenancy/RBAC exist.
const moduleClient = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-actor-type': 'user',
        'x-actor-id': 'admin-ui',
        ...(options.headers || {}),
      },
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
    const [health, opportunities, approvals, traces] = await Promise.all([
      api('/health'),
      api('/api/opportunities'),
      api('/api/approvals?status=pending'),
      api('/api/traces?limit=8'),
    ]);
    renderMetrics(health.counts);
    renderOpportunities(opportunities.items);
    renderApprovals(approvals.items);
    renderTraces(traces.items);
  } catch (error) {
    toast(error.message, true);
  } finally {
    toggleBusy(elements.refreshButton, false);
  }
}

function renderMetrics(counts) {
  const items = [
    ['Companies', counts.companies],
    ['Opportunities', counts.opportunities],
    ['Pending approvals', counts.pendingApprovals],
    ['Traced runs', counts.workflowRuns],
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
        <td><span class="badge ${item.stage}">${escapeHtml(item.stage.replace('_', ' '))}</span></td>
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
    const result = await api(`/api/opportunities/${id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ targetStage: 'proposal' }),
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
    await api(`/api/approvals/${id}/${decision}`, { method: 'POST', body: '{}' });
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
    await api('/api/demo/run', { method: 'POST', body: '{}' });
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

elements.demoButton.addEventListener('click', runDemo);
elements.refreshButton.addEventListener('click', refresh);
elements.closeTrace.addEventListener('click', () => elements.traceDetail.classList.add('hidden'));

// ---- Hash routing + generated-module navigation -------------------------

import { createModuleAdmin } from './admin-modules.js';
import { createPipelineBoard } from './admin-pipeline.js';
import { createQuoteView } from './admin-quotes.js';
import { createWorkView } from './admin-work.js';
import { createCustomerDataView } from './admin-customer-data.js';
import { selectGeneratedModules, humanizeLabel, parseModuleRoute } from './admin-core.js';

const dashboardView = document.querySelector('#view-dashboard');
const moduleView = document.querySelector('#view-module');
const generatedNav = document.querySelector('#generatedNav');

const moduleAdmin = createModuleAdmin({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  navigate: (hash) => { window.location.hash = hash; },
  toast,
});

const pipelineBoard = createPipelineBoard({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  toast,
});

// Quote builder (ADR-016) over the ADR-009 override seam: the generic action
// forms cannot browse a price book, so this focused view owns that experience
// while every mutation still goes through the same server actions.
const quoteView = createQuoteView({
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
  navigate: (hash) => { window.location.hash = hash; },
});

// Customer Data Foundation (ADR-037): import, duplicate candidates, the data
// quality queue and the read-only profile. Renders only while the server
// publishes the customer-data package.
const customerDataView = createCustomerDataView({
  doc: document,
  mount: moduleView,
  client: moduleClient,
  navigate: (hash) => { window.location.hash = hash; },
});

async function populateNav() {
  try {
    const schema = await moduleClient.request('/api/schema');
    const { supported, modules } = selectGeneratedModules(schema);
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

async function route() {
  const target = parseModuleRoute(window.location.hash || '#/');
  const onDashboard = target.view === 'dashboard';
  dashboardView.classList.toggle('hidden', !onDashboard);
  moduleView.classList.toggle('hidden', onDashboard);
  // Set the active nav link by comparing the safe href we built ourselves,
  // never by constructing a selector from route input.
  for (const link of generatedNav.querySelectorAll('a')) {
    const active = !onDashboard && (
      link.getAttribute('href') === `#/modules/${target.moduleName}` ||
      (target.view === 'pipeline' && link.getAttribute('href') === `#/pipelines/${target.pipelineName}`) ||
      ((target.view === 'quotes' || target.view === 'quote-detail') && link.getAttribute('href') === '#/quotes') ||
      ((target.view === 'work' || target.view === 'work-task') && link.getAttribute('href') === '#/work') ||
      ((target.view === 'customer-data' || target.view === 'customer-profile') && link.getAttribute('href') === '#/customer-data')
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
    else if (target.view === 'quotes') await quoteView.renderQuoteList();
    else if (target.view === 'quote-detail') await quoteView.renderQuoteDetail(target.quoteId);
    else if (target.view === 'customer-data') await customerDataView.render();
    else if (target.view === 'customer-profile') await customerDataView.renderProfile(target.resource, target.subjectId);
    else if (target.view === 'work') await workView.renderQueue();
    else if (target.view === 'work-task') await workView.renderTask(target.taskId);
  } catch (error) {
    toast(error.message, true);
  }
}

window.addEventListener('hashchange', route);
populateNav();
route();
refresh();
