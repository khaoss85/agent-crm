// @ts-check

/**
 * **The Customer Data Foundation section (ADR-037).**
 *
 * It renders only while `/api/schema` publishes `domains['customer-data']`,
 * because the package is optional and an Admin that shows a dead surface is
 * worse than one that shows nothing.
 *
 * Everything the operator can do here is one of three things: preview an
 * import (which writes nothing and says so), apply one, or decide something a
 * human must decide. The limits are rendered **as content, in every state** —
 * not in a tooltip, not in a footnote — because the honest thing about this
 * surface is mostly what it does not do.
 *
 * The section is package-scoped but lives in the Admin app: the framework has
 * no seam for a package to contribute an Admin extension, which AX1 publishes
 * as `ADMIN_EXTENSIONS_UNSUPPORTED`.
 */

/** The five sentences this section always carries, verbatim, in every state. */
export const CUSTOMER_DATA_DISCLAIMERS = Object.freeze([
  'Matching is exact only. Nothing here scores, guesses or learns: when the evidence is ambiguous the row is left unresolved for a person.',
  'Linking two records is a logical canonical merge. Both records still exist, both still resolve, and nothing is deleted, rewritten or merged away.',
  'No warehouse, no activation and no external system is written. An import reads rows you hand it and nothing else.',
  'Deciding here requires a signed-in user actor. That is a human-actor boundary for audit — not Sales, Legal or Finance role enforcement.',
  'None of this is a GDPR, consent, retention or erasure claim. Erasure against immutable signed evidence is deliberately unresolved.',
]);

const MAX_PREVIEW_ROWS = 25;

function block(el, panel, meta) {
  const limits = el('div', 'customer-data-limits');
  limits.appendChild(el('h4', undefined, 'What this does not do'));
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) {
    limits.appendChild(el('p', 'muted customer-data-limit', sentence));
  }
  const deferred = meta?.deferred;
  if (deferred?.items?.length) {
    limits.appendChild(el('p', 'muted customer-data-deferred',
      `Deferred to ${deferred.track}: ${deferred.items.join(', ')}.`));
  }
  panel.appendChild(limits);
}

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps
 */
export function createCustomerDataView({ doc, mount, client, navigate = () => {} }) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined && text !== null) node.textContent = String(text); // safe: text, never HTML
    return node;
  };
  const fact = (label, value) => {
    const row = el('p', 'fact');
    row.appendChild(el('span', 'fact-label', `${label}: `));
    row.appendChild(el('span', 'fact-value', value === null || value === undefined ? '—' : String(value)));
    return row;
  };

  let busy = [];
  const withBusy = async (work) => {
    for (const control of busy) control.disabled = true;
    try {
      await work();
      await render();
    } catch (error) {
      const line = mount.querySelector ? mount.querySelector('.customer-data-error') : null;
      if (line) line.textContent = error?.message ?? 'The request failed';
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
      mount.appendChild(el('p', 'field-error', error?.message ?? 'Could not load the schema'));
      return;
    }
    const meta = schema?.domains?.['customer-data']?.metadata ?? schema?.domains?.['customer-data'];
    if (!meta) {
      // Optional package, not composed: render nothing at all rather than a
      // surface that cannot work.
      return;
    }

    const panel = el('div', 'customer-data-section');
    panel.setAttribute('data-contract', String(meta.customerDataContract ?? ''));
    panel.appendChild(el('h3', undefined, 'Customer data foundation'));
    panel.appendChild(el('p', 'muted', meta.import?.preview ?? ''));

    const error = el('small', 'field-error customer-data-error', '');
    panel.appendChild(error);

    // ── import ────────────────────────────────────────────────────────────
    const importBox = el('div', 'customer-data-import');
    importBox.appendChild(el('h4', undefined, 'Import'));
    importBox.appendChild(el('p', 'muted', `Mapping ${meta.import?.mapping?.name}@${meta.import?.mapping?.version} · at most ${meta.import?.maxRows} rows · ${meta.import?.idempotency}`));

    const systemInput = el('input');
    systemInput.setAttribute('name', 'system');
    systemInput.setAttribute('placeholder', 'source system, e.g. crm-export');
    const rowsInput = el('textarea');
    rowsInput.setAttribute('name', 'rows');
    rowsInput.setAttribute('placeholder', '[{"externalId":"CRM-1","email":"ada@example.com","companyName":"Acme","domain":"acme.example"}]');
    const acceptance = el('select');
    acceptance.setAttribute('name', 'acceptance');
    for (const mode of meta.import?.acceptance ?? ['partial', 'all_or_nothing']) {
      const option = el('option', undefined, mode === 'partial' ? 'partial — keep the good rows, receipt the rest' : 'all or nothing — one bad row stops everything');
      option.setAttribute('value', mode);
      acceptance.appendChild(option);
    }
    // Set explicitly: a control whose value depends on the browser's implicit
    // first-option selection is a control that sends '' somewhere else.
    acceptance.value = (meta.import?.acceptance ?? ['partial'])[0];
    for (const [label, control] of [['Source system', systemInput], ['Rows (JSON)', rowsInput], ['Acceptance', acceptance]]) {
      const row = el('p', 'customer-data-field');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(control);
      importBox.appendChild(row);
    }

    const parseRows = () => {
      const raw = String(rowsInput.value ?? '').trim();
      if (raw === '') throw new Error('Paste the rows to import as a JSON array.');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error('The rows must be valid JSON.'); }
      if (!Array.isArray(parsed)) throw new Error('The rows must be a JSON array.');
      return parsed;
    };

    const previewButton = el('button', undefined, 'Preview (writes nothing)');
    previewButton.setAttribute('data-action', 'preview-customer-import');
    busy.push(previewButton);
    previewButton.addEventListener('click', () => withBusy(async () => {
      const rows = parseRows();
      const result = await client.request('/api/customer-data/import/preview', {
        method: 'POST',
        body: JSON.stringify({ system: String(systemInput.value ?? ''), rows, acceptance: String(acceptance.value ?? 'partial') }),
      });
      lastPreview = result;
    }));

    const applyButton = el('button', undefined, 'Apply import');
    applyButton.setAttribute('data-action', 'apply-customer-import');
    busy.push(applyButton);
    applyButton.addEventListener('click', () => withBusy(async () => {
      const rows = parseRows();
      await client.request('/api/customer-data/import/apply', {
        method: 'POST',
        body: JSON.stringify({ system: String(systemInput.value ?? ''), rows, acceptance: String(acceptance.value ?? 'partial') }),
      });
      lastPreview = null;
    }));

    importBox.appendChild(previewButton);
    importBox.appendChild(applyButton);
    panel.appendChild(importBox);

    // ── the last preview's receipts, when there is one ────────────────────
    if (lastPreview) {
      const previewBox = el('div', 'customer-data-preview');
      previewBox.appendChild(el('h4', undefined, 'Preview result'));
      previewBox.appendChild(el('p', 'muted customer-data-preview-writes', lastPreview.writes ?? ''));
      previewBox.appendChild(fact('Rows', lastPreview.counts?.rows));
      previewBox.appendChild(fact('Accepted', lastPreview.counts?.accepted));
      previewBox.appendChild(fact('Rejected', lastPreview.counts?.rejected));
      previewBox.appendChild(fact('Left unresolved', lastPreview.counts?.skipped));
      for (const receipt of (lastPreview.receipts ?? []).slice(0, MAX_PREVIEW_ROWS)) {
        const row = el('p', 'customer-data-receipt');
        row.setAttribute('data-outcome', String(receipt.outcome));
        row.appendChild(el('span', 'customer-data-receipt-index', `row ${receipt.index}`));
        row.appendChild(el('span', 'customer-data-receipt-outcome', ` ${receipt.outcome} · ${receipt.reasonCode}`));
        row.appendChild(el('span', 'customer-data-receipt-reason', ` — ${receipt.reason}`));
        previewBox.appendChild(row);
      }
      panel.appendChild(previewBox);
    }

    // ── runs, candidates, issues ──────────────────────────────────────────
    const [runs, candidates, issues] = await Promise.all([
      rowsOf('customer-import-run'), rowsOf('duplicate-candidate'), rowsOf('data-quality-issue'),
    ]);

    const runBox = el('div', 'customer-data-runs');
    runBox.appendChild(el('h4', undefined, `Import runs (${runs.length})`));
    for (const run of runs.slice(0, 20)) {
      const row = el('p', 'customer-data-run');
      row.setAttribute('data-run', String(run.id));
      row.appendChild(el('span', undefined,
        `${run.system} · ${run.rowCount} rows · ${run.acceptedCount} accepted · ${run.rejectedCount} rejected · ${run.skippedCount} unresolved · ${run.acceptance}`));
      runBox.appendChild(row);
    }
    panel.appendChild(runBox);

    const candidateBox = el('div', 'customer-data-candidates');
    const open = candidates.filter((row) => row.status === 'unresolved');
    candidateBox.appendChild(el('h4', undefined, `Duplicate candidates (${open.length} unresolved)`));
    candidateBox.appendChild(el('p', 'muted', 'Deciding these is a human judgement. Linking is a logical canonical merge: nothing is deleted.'));
    for (const candidate of open.slice(0, 20)) {
      const row = el('div', 'customer-data-candidate');
      row.setAttribute('data-candidate', String(candidate.id));
      row.appendChild(el('p', 'customer-data-candidate-pair',
        `${candidate.leftResource} ${candidate.leftLabel ?? candidate.leftId} ↔ ${candidate.rightResource} ${candidate.rightLabel ?? candidate.rightId}`));
      row.appendChild(el('p', 'muted customer-data-candidate-evidence', `${candidate.rule}: ${candidate.evidence}`));

      const reason = el('input');
      reason.setAttribute('name', `reason-${candidate.id}`);
      reason.setAttribute('placeholder', 'Why (required, recorded with your identity)');
      const canonical = el('select');
      canonical.setAttribute('name', `canonical-${candidate.id}`);
      for (const side of ['left', 'right']) {
        const option = el('option', undefined, `${candidate[`${side}Resource`]} ${candidate[`${side}Label`] ?? candidate[`${side}Id`]}`);
        option.setAttribute('value', `${candidate[`${side}Resource`]}:${candidate[`${side}Id`]}`);
        canonical.appendChild(option);
      }
      canonical.value = `${candidate.leftResource}:${candidate.leftId}`;
      const linkButton = el('button', undefined, 'Link as one customer');
      linkButton.setAttribute('data-action', 'link-canonical-identity');
      busy.push(linkButton);
      linkButton.addEventListener('click', () => withBusy(async () => {
        const value = String(canonical.value ?? '');
        const [resource, id] = value.split(':');
        if (!resource || !id) throw new Error('Choose which record is canonical.');
        await client.request(`/api/modules/duplicate-candidate/records/${encodeURIComponent(candidate.id)}/actions/link-canonical-identity`, {
          method: 'POST',
          body: JSON.stringify({ canonicalResource: resource, canonicalId: id, reason: String(reason.value ?? '') }),
        });
      }));
      const dismissButton = el('button', 'danger', 'Not the same customer');
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
    issueBox.appendChild(el('h4', undefined, `Data quality (${openIssues.length} open)`));
    issueBox.appendChild(el('p', 'muted', 'Resolving a finding records who decided and why. The finding and its evidence are kept.'));
    for (const issue of openIssues.slice(0, 20)) {
      const row = el('div', 'customer-data-issue');
      row.setAttribute('data-issue', String(issue.id));
      row.setAttribute('data-kind', String(issue.kind));
      row.appendChild(el('p', 'customer-data-issue-kind', issue.kind));
      row.appendChild(el('p', 'muted customer-data-issue-evidence', issue.evidence));
      const reason = el('input');
      reason.setAttribute('name', `issue-reason-${issue.id}`);
      reason.setAttribute('placeholder', 'Why (required)');
      const decision = el('select');
      decision.setAttribute('name', `issue-decision-${issue.id}`);
      for (const value of ['resolved', 'dismissed']) {
        const option = el('option', undefined, value === 'resolved' ? 'resolved — the data was fixed' : 'dismissed — acceptable as it stands');
        option.setAttribute('value', value);
        decision.appendChild(option);
      }
      decision.value = 'resolved';
      const governButton = el('button', undefined, 'Record decision');
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

  let lastPreview = null;

  async function rowsOf(module) {
    try {
      const response = await client.request(`/api/modules/${module}/records?limit=100`);
      return response.items ?? [];
    } catch {
      return [];
    }
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
      mount.appendChild(el('p', 'field-error', error?.message ?? 'Could not load the profile'));
      return;
    }
    const panel = el('div', 'customer-profile');
    panel.setAttribute('data-subject', `${resource}:${id}`);
    panel.appendChild(el('h3', undefined, 'Customer profile'));
    panel.appendChild(el('p', 'muted customer-profile-timeline', profile.timelineNote ?? ''));

    panel.appendChild(fact('Company', profile.identity?.company?.name ?? null));
    panel.appendChild(fact('Contact', profile.identity?.contact?.email ?? null));

    const identityBox = el('div', 'customer-profile-identity');
    identityBox.setAttribute('data-linked', String(Boolean(profile.canonicalIdentity?.linked)));
    identityBox.appendChild(el('h4', undefined, 'Canonical identity'));
    identityBox.appendChild(el('p', 'muted customer-profile-canonical-note', profile.canonicalIdentity?.note ?? ''));
    for (const member of profile.canonicalIdentity?.members ?? []) {
      identityBox.appendChild(el('p', 'customer-profile-member', `${member.role}: ${member.resource} ${member.label ?? member.id}`));
    }
    panel.appendChild(identityBox);

    const externalBox = el('div', 'customer-profile-externals');
    externalBox.appendChild(el('h4', undefined, `External identities (${(profile.externalIdentities ?? []).length})`));
    for (const identity of profile.externalIdentities ?? []) {
      externalBox.appendChild(el('p', 'customer-profile-external', `${identity.system}: ${identity.externalId}`));
    }
    panel.appendChild(externalBox);

    const sections = el('div', 'customer-profile-sections');
    for (const [key, label] of [
      ['opportunities', 'Opportunities'], ['quotes', 'Quotes'], ['orders', 'Signed orders'],
      ['contracts', 'Contracts'], ['subscriptions', 'Subscriptions'], ['deliveryProjects', 'Delivery'],
      ['serviceCoverages', 'Service coverage'], ['supportCases', 'Support cases'],
      ['workTasks', 'Work'], ['successions', 'Renewal lineage'],
    ]) {
      const section = profile[key];
      if (!section) continue;
      const row = el('p', 'customer-profile-section');
      row.setAttribute('data-section', key);
      row.setAttribute('data-available', String(Boolean(section.available)));
      row.appendChild(el('span', 'fact-label', `${label}: `));
      row.appendChild(el('span', 'fact-value',
        section.available ? `${section.count}` : 'not available'));
      if (!section.available) row.appendChild(el('span', 'muted customer-profile-unavailable', ` — ${section.reason}`));
      sections.appendChild(row);
    }
    panel.appendChild(sections);

    const issueBox = el('div', 'customer-profile-issues');
    issueBox.appendChild(el('h4', undefined, `Open data-quality findings (${(profile.dataQualityIssues ?? []).length})`));
    for (const issue of profile.dataQualityIssues ?? []) {
      issueBox.appendChild(el('p', 'customer-profile-issue', `${issue.kind}: ${issue.evidence}`));
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
