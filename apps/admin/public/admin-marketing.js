// @ts-check

import { bindAdminMutations } from './admin-submission.js';

/**
 * The Marketing proposals Admin section (MK1).
 *
 * **Package-scoped, not package-owned.** The framework has no seam for a package
 * to contribute an Admin extension — AX1 publishes that as
 * `ADMIN_EXTENSIONS_UNSUPPORTED` — so this code lives in the Admin app and
 * renders only while `/api/schema` publishes `domains.marketing`. Remove the
 * package and the section disappears rather than degrading into a broken
 * control.
 *
 * One object, one screen: the proposal as the agent wrote it and the policy
 * version reviewed it — audience, exclusions, channel, provider rationale,
 * content plan, tracking plan, risks and required approvals — or the refusal
 * with its missing sections. A control appears only where the server would
 * accept it: the Approve button renders solely for a `proposed` proposal, and
 * the server re-checks the human actor, the state and the policy identity
 * inside its own transaction regardless.
 *
 * Admin rules as everywhere: every value renders as text (never HTML), the
 * server owns every state, controls disable while a request is in flight, a
 * stale response is discarded rather than drawn over a newer one, and a
 * refusal re-throws so the re-render cannot paint over the error message.
 */

/** A display bound, never a correctness bound, and it is disclosed on screen. */
const LIST_LIMIT = 100;

/** The proposal sections in review order, each naming its record field. */
const SECTIONS = Object.freeze([
  { section: 'audience', field: 'audienceJson', label: 'Audience' },
  { section: 'exclusions', field: 'exclusionsJson', label: 'Exclusions' },
  { section: 'channel', field: 'channel', label: 'Channel' },
  { section: 'providerRationale', field: 'providerRationale', label: 'Provider rationale' },
  { section: 'contentPlan', field: 'contentPlanJson', label: 'Content plan' },
  { section: 'trackingPlan', field: 'trackingPlanJson', label: 'Tracking plan' },
  { section: 'risks', field: 'risksJson', label: 'Risks' },
  { section: 'requiredApprovals', field: 'requiredApprovalsJson', label: 'Required approvals' },
]);

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createMarketingView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  /** Guard against a stale async response overwriting a newer view. */
  let renderToken = 0;
  /** Every control currently disabled for an in-flight request. */
  const busy = [];

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text); // safe: text, never HTML
    return node;
  };
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };

  /** A labelled fact row. The value is text, always. */
  const fact = (label, value) => {
    const row = el('p', 'marketing-fact');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(el('span', undefined, value === null || value === undefined || value === '' ? '—' : String(value)));
    return row;
  };

  /** Disable every control while a request is in flight: no double submit. */
  async function withBusy(controls, fn) {
    for (const control of controls) { control.disabled = true; busy.push(control); }
    try {
      return await fn();
    } finally {
      for (const control of controls) { control.disabled = false; }
      busy.length = 0;
    }
  }

  async function marketingMeta() {
    const schema = await client.request('/api/schema');
    return schema?.domains?.marketing ?? null;
  }

  function renderMissing(message) {
    clear();
    const panel = el('section', 'panel');
    panel.appendChild(el('p', 'empty', message));
    mount.appendChild(panel);
  }

  function renderError(message, retry) {
    clear();
    const panel = el('section', 'panel marketing-error');
    panel.appendChild(el('p', 'field-error', message));
    const button = el('button', 'retry', 'Retry');
    // The handler returns the promise so a caller that can await it (a test)
    // does not have to guess when the retry finished. A browser ignores it.
    button.addEventListener('click', () => retry());
    panel.appendChild(button);
    mount.appendChild(panel);
  }

  /** Parse a stored refusal list without ever throwing into the render. */
  function refusalReasons(record) {
    try {
      const parsed = JSON.parse(String(record.refusalReasonsJson ?? '[]'));
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  }

  // ---- List ---------------------------------------------------------------

  async function renderProposalList() {
    const token = ++renderToken;
    try {
      const meta = await marketingMeta();
      if (!meta || meta.marketingContract !== 1) {
        if (token !== renderToken) return;
        renderMissing('Marketing proposals are not installed in this project, so there is nothing to review.');
        return;
      }
      const result = await client.request(`/api/modules/campaign-proposal/records?limit=${LIST_LIMIT}`);
      if (token !== renderToken) return;
      clear();
      const panel = el('section', 'panel');
      panel.appendChild(el('h2', undefined, 'Campaign proposals'));
      panel.appendChild(el('p', 'muted',
        'An agent observes a funnel insight and prepares a complete proposal. Nothing here sends, publishes or spends — approval creates an immutable version, nothing external.'));
      const items = result.items ?? [];
      if (items.length === 0) {
        panel.appendChild(el('p', 'empty', 'No campaign proposals yet.'));
      }
      const list = el('ul', 'marketing-list');
      for (const item of items) {
        const row = el('li', 'marketing-row');
        const link = el('a', 'marketing-link', item.title ?? item.id);
        link.setAttribute('href', `#/marketing/${item.id}`);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          navigate(`#/marketing/${item.id}`);
        });
        row.appendChild(link);
        row.appendChild(el('span', 'marketing-status', ` ${item.status ?? 'draft'} · ${item.channel ?? '—'} · ${item.mode ?? '—'}`));
        list.appendChild(row);
      }
      panel.appendChild(list);
      if (items.length >= LIST_LIMIT) {
        panel.appendChild(el('p', 'muted', `Showing the first ${LIST_LIMIT} proposals; narrow the set from the record screen.`));
      }
      mount.appendChild(panel);
    } catch (error) {
      if (token !== renderToken) return;
      renderError(error.message, () => renderProposalList());
    }
  }

  // ---- Detail ---------------------------------------------------------------

  async function renderProposalDetail(proposalId) {
    const token = ++renderToken;
    try {
      const meta = await marketingMeta();
      if (!meta || meta.marketingContract !== 1) {
        if (token !== renderToken) return;
        renderMissing('Marketing proposals are not installed in this project, so there is nothing to review.');
        return;
      }
      const proposal = await client.request(`/api/modules/campaign-proposal/records/${encodeURIComponent(proposalId)}`);
      if (token !== renderToken) return;
      clear();
      const panel = el('section', 'panel');
      panel.setAttribute('data-proposal', proposal.id);
      panel.appendChild(el('h2', undefined, proposal.title ?? proposal.id));
      panel.appendChild(fact('Status', proposal.status ?? 'draft'));
      panel.appendChild(fact('Mode', proposal.mode ?? '—'));
      panel.appendChild(fact('Policy', proposal.policyName && proposal.policyVersion
        ? `${proposal.policyName} v${proposal.policyVersion}` : '—'));

      for (const { field, label } of SECTIONS) {
        panel.appendChild(fact(label, proposal[field] ?? '—'));
      }

      if (proposal.status === 'refused') {
        const reasons = refusalReasons(proposal);
        const box = el('div', 'marketing-refusal');
        box.appendChild(el('h3', undefined, 'Refused — not ready for a human'));
        box.appendChild(el('p', 'muted',
          'This proposal cannot state every required section, so it cannot be approved. The missing sections are:'));
        const list = el('ul', 'marketing-missing');
        for (const reason of reasons) list.appendChild(el('li', undefined, reason));
        if (reasons.length === 0) list.appendChild(el('li', undefined, '(no reasons recorded)'));
        box.appendChild(list);
        panel.appendChild(box);
      }

      if (proposal.status === 'approved') {
        const versions = await client.request(
          `/api/modules/campaign-version/records?limit=${LIST_LIMIT}&filter.proposalId=${encodeURIComponent(proposal.id)}`,
        );
        if (token !== renderToken) return;
        const box = el('div', 'marketing-evidence');
        box.appendChild(el('h3', undefined, 'Approval evidence'));
        box.appendChild(fact('Decided by', proposal.decidedBy ?? '—'));
        box.appendChild(fact('Decided at', proposal.decidedAt ?? '—'));
        const rows = (versions.items ?? []).filter((row) => row.proposalId === proposal.id);
        box.appendChild(fact('Versions', rows.length === 0 ? '—' : rows.map((row) => `#${row.versionNumber} by ${row.approvedBy ?? '—'}`).join(', ')));
        panel.appendChild(box);
      }

      // The Approve control renders ONLY for a proposed proposal: a control
      // appears only where the server would accept it. Drafts await review,
      // refused proposals must be re-proposed, approved ones are evidence.
      if (proposal.status === 'proposed') {
        const approveButton = el('button', 'marketing-approve', 'Approve campaign');
        const approveError = el('small', 'field-error', '');
        approveButton.addEventListener('click', () => withBusy([approveButton], async () => {
          approveError.textContent = '';
          try {
            await client.request(
              `/api/modules/campaign-proposal/records/${encodeURIComponent(proposal.id)}/actions/approve`,
              {
                method: 'POST',
                body: JSON.stringify({ policy: proposal.policyName, policyVersion: proposal.policyVersion }),
              },
            );
            await renderProposalDetail(proposal.id);
          } catch (error) {
            // Re-thrown, never painted over: the error stays until the next
            // attempt replaces it, and the typed state is untouched.
            approveError.textContent = error.message;
            throw error;
          }
        }));
        panel.appendChild(approveButton);
        panel.appendChild(approveError);
        panel.appendChild(el('p', 'muted',
          'Approving creates an immutable version. It sends, publishes and spends nothing — there is no send path in this package.'));
      } else if (proposal.status === 'draft') {
        panel.appendChild(el('p', 'muted', 'Awaiting review: run the propose action on this record first.'));
      }

      const back = el('a', undefined, '← All proposals');
      back.setAttribute('href', '#/marketing');
      back.addEventListener('click', (event) => {
        event.preventDefault();
        navigate('#/marketing');
      });
      panel.appendChild(back);
      mount.appendChild(panel);
    } catch (error) {
      if (token !== renderToken) return;
      renderError(error.message, () => renderProposalDetail(proposalId));
    }
  }

  return { renderProposalList, renderProposalDetail };
}
