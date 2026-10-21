// @ts-check

// The framework demo dashboard as renderable chrome (backlog:7eee63a5).
//
// The served `index.html` carries no demo markup: a space user under a mount
// such as `/bo` must never receive the demo strings, not even in bytes.
// The standalone development server renders this chrome at startup instead,
// so local development keeps the demo exactly as today. The markup below is
// the former `index.html` demo skeleton, moved verbatim — same ids, classes
// and copy — only its construction moved from static HTML to DOM APIs (the
// repo's fake-DOM tests cannot parse HTML, and data still travels through
// textContent, never innerHTML).

/**
 * @param {object} doc DOM document (real or fake).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Render the demo header, module nav and dashboard skeleton around the
 * given mounts. Returns the element refs the dashboard code drives.
 * @param {{ doc: object, main: object, moduleView: object, dashboardView: object }} options
 */
export function renderDemoChrome({ doc, main, moduleView, dashboardView } = {}) {
  const header = el(doc, 'header', 'topbar');
  const headText = el(doc, 'div');
  const headInner = el(doc, 'div');
  headInner.appendChild(el(doc, 'div', 'eyebrow', 'AGENT-NATIVE CRM FRAMEWORK'));
  headInner.appendChild(el(doc, 'h1', undefined, 'Commercial logic you can describe.'));
  headInner.appendChild(el(
    doc,
    'p',
    'lede',
    'Codex or Claude changes the project. Deterministic workflows protect CRM state.',
  ));
  headText.appendChild(headInner);
  header.appendChild(headText);
  const actions = el(doc, 'div', 'actions');
  const refreshButton = el(doc, 'button', 'secondary', 'Refresh');
  refreshButton.setAttribute('id', 'refreshButton');
  const demoButton = el(doc, 'button', 'primary', 'Run demo');
  demoButton.setAttribute('id', 'demoButton');
  actions.appendChild(refreshButton);
  actions.appendChild(demoButton);
  header.appendChild(actions);

  const nav = el(doc, 'nav', 'modnav');
  nav.setAttribute('aria-label', 'Sections');
  const home = el(doc, 'a', undefined, 'Dashboard');
  home.setAttribute('href', '#/');
  home.setAttribute('data-nav', 'home');
  nav.appendChild(home);
  const generatedNav = el(doc, 'span', 'modnav-group');
  generatedNav.setAttribute('id', 'generatedNav');
  generatedNav.setAttribute('aria-label', 'Generated modules');
  nav.appendChild(generatedNav);

  main.insertBefore(header, moduleView);
  main.insertBefore(nav, moduleView);

  while (dashboardView.firstChild) dashboardView.removeChild(dashboardView.firstChild);

  const flow = el(doc, 'section', 'flow');
  flow.setAttribute('aria-label', 'Framework flow');
  const steps = [
    ['1', 'Business request', '\u201CRenewals above \u20AC50k need approval.\u201D'],
    ['2', 'Agent interface', 'AGENTS.md \u00B7 Skills \u00B7 MCP \u00B7 CLI'],
    ['3', 'Controlled execution', 'Modules \u00B7 Workflow \u00B7 Trace \u00B7 Audit'],
  ];
  steps.forEach(([number, title, detail], index) => {
    if (index > 0) flow.appendChild(el(doc, 'i', undefined, '\u2192'));
    const step = el(doc, 'div');
    step.appendChild(el(doc, 'span', undefined, number));
    step.appendChild(el(doc, 'strong', undefined, title));
    step.appendChild(el(doc, 'small', undefined, detail));
    flow.appendChild(step);
  });
  dashboardView.appendChild(flow);

  const metrics = el(doc, 'section', 'metrics');
  metrics.setAttribute('id', 'metrics');
  dashboardView.appendChild(metrics);

  const grid = el(doc, 'section', 'grid');

  const opportunitiesPanel = el(doc, 'article', 'panel panel-wide');
  const opportunitiesHeading = el(doc, 'div', 'panel-heading');
  const opportunitiesHeadText = el(doc, 'div');
  opportunitiesHeadText.appendChild(el(doc, 'p', 'kicker', 'CRM state'));
  opportunitiesHeadText.appendChild(el(doc, 'h2', undefined, 'Opportunities'));
  opportunitiesHeading.appendChild(opportunitiesHeadText);
  opportunitiesHeading.appendChild(el(doc, 'code', undefined, 'request-opportunity-stage-change'));
  opportunitiesPanel.appendChild(opportunitiesHeading);
  const tableWrap = el(doc, 'div', 'table-wrap');
  const table = el(doc, 'table');
  const thead = el(doc, 'thead');
  const headRow = el(doc, 'tr');
  for (const column of ['Opportunity', 'Company', 'Value', 'Stage', 'Owner', '']) {
    headRow.appendChild(el(doc, 'th', undefined, column));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const opportunities = el(doc, 'tbody');
  opportunities.setAttribute('id', 'opportunities');
  table.appendChild(opportunities);
  tableWrap.appendChild(table);
  opportunitiesPanel.appendChild(tableWrap);
  const opportunitiesEmpty = el(doc, 'div', 'empty hidden', 'Run the demo to create two renewal opportunities.');
  opportunitiesEmpty.setAttribute('id', 'opportunitiesEmpty');
  opportunitiesPanel.appendChild(opportunitiesEmpty);
  grid.appendChild(opportunitiesPanel);

  const approvalsPanel = el(doc, 'article', 'panel');
  const approvalsHeading = el(doc, 'div', 'panel-heading');
  const approvalsHeadText = el(doc, 'div');
  approvalsHeadText.appendChild(el(doc, 'p', 'kicker', 'Human in the loop'));
  approvalsHeadText.appendChild(el(doc, 'h2', undefined, 'Approvals'));
  approvalsHeading.appendChild(approvalsHeadText);
  approvalsPanel.appendChild(approvalsHeading);
  const approvals = el(doc, 'div', 'stack');
  approvals.setAttribute('id', 'approvals');
  approvalsPanel.appendChild(approvals);
  const approvalsEmpty = el(doc, 'div', 'empty hidden', 'No approval is waiting.');
  approvalsEmpty.setAttribute('id', 'approvalsEmpty');
  approvalsPanel.appendChild(approvalsEmpty);
  grid.appendChild(approvalsPanel);

  const tracesPanel = el(doc, 'article', 'panel');
  const tracesHeading = el(doc, 'div', 'panel-heading');
  const tracesHeadText = el(doc, 'div');
  tracesHeadText.appendChild(el(doc, 'p', 'kicker', 'Observability'));
  tracesHeadText.appendChild(el(doc, 'h2', undefined, 'Workflow traces'));
  tracesHeading.appendChild(tracesHeadText);
  tracesPanel.appendChild(tracesHeading);
  const traces = el(doc, 'div', 'stack compact');
  traces.setAttribute('id', 'traces');
  tracesPanel.appendChild(traces);
  const tracesEmpty = el(doc, 'div', 'empty hidden', 'No workflow has run yet.');
  tracesEmpty.setAttribute('id', 'tracesEmpty');
  tracesPanel.appendChild(tracesEmpty);
  grid.appendChild(tracesPanel);

  dashboardView.appendChild(grid);

  const traceDetail = el(doc, 'section', 'panel trace-detail hidden');
  traceDetail.setAttribute('id', 'traceDetail');
  const traceHeading = el(doc, 'div', 'panel-heading');
  const traceHeadText = el(doc, 'div');
  traceHeadText.appendChild(el(doc, 'p', 'kicker', 'Selected run'));
  const traceTitle = el(doc, 'h2', undefined, 'Trace detail');
  traceTitle.setAttribute('id', 'traceTitle');
  traceHeadText.appendChild(traceTitle);
  traceHeading.appendChild(traceHeadText);
  const closeTrace = el(doc, 'button', 'icon-button', '\u00D7');
  closeTrace.setAttribute('id', 'closeTrace');
  closeTrace.setAttribute('aria-label', 'Close trace');
  traceHeading.appendChild(closeTrace);
  traceDetail.appendChild(traceHeading);
  const traceSpans = el(doc, 'div', 'timeline');
  traceSpans.setAttribute('id', 'traceSpans');
  traceDetail.appendChild(traceSpans);
  dashboardView.appendChild(traceDetail);

  return {
    header,
    nav,
    generatedNav,
    metrics,
    opportunities,
    opportunitiesEmpty,
    approvals,
    approvalsEmpty,
    traces,
    tracesEmpty,
    demoButton,
    refreshButton,
    traceDetail,
    traceTitle,
    traceSpans,
    closeTrace,
  };
}
