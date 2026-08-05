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
import { selectGeneratedModules, humanizeLabel } from './admin-core.js';

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
  } catch {
    // A schema failure must not break the dashboard; leave nav empty silently.
  }
}

function parseHash() {
  const raw = (window.location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // ['modules', name, ...]
  if (parts[0] !== 'modules' || !parts[1]) return { view: 'dashboard' };
  const moduleName = decodeURIComponent(parts[1]);
  if (parts[2] === 'new') return { view: 'new', moduleName };
  if (parts[2]) return { view: 'detail', moduleName, id: decodeURIComponent(parts[2]) };
  return { view: 'list', moduleName };
}

async function route() {
  const target = parseHash();
  const onDashboard = target.view === 'dashboard';
  dashboardView.classList.toggle('hidden', !onDashboard);
  moduleView.classList.toggle('hidden', onDashboard);
  for (const link of generatedNav.querySelectorAll('a')) link.classList.remove('active');
  if (onDashboard) return;
  const active = generatedNav.querySelector(`[data-nav="module-${cssEscape(target.moduleName)}"]`);
  if (active) active.classList.add('active');
  try {
    if (target.view === 'list') await moduleAdmin.renderList(target.moduleName);
    else if (target.view === 'new') await moduleAdmin.renderNew(target.moduleName);
    else if (target.view === 'detail') await moduleAdmin.renderDetail(target.moduleName, target.id);
  } catch (error) {
    toast(error.message, true);
  }
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

window.addEventListener('hashchange', route);
populateNav();
route();
refresh();
