// @ts-check

import { formatMinorUnits } from './admin-core.js';
import { renderDeliveryChangeAcceptance } from './admin-delivery-change.js';

/**
 * Delivery handover Admin (Milestone 13, the delivery domain package).
 *
 * It renders only when `/api/schema` publishes the `delivery` package, so it
 * disappears with the package rather than degrading into a broken control.
 *
 * Two states:
 *
 *   before handover — plan (read-only) → see who delivers each obligation and
 *     why → decide anything the policy would not guess → optionally name the
 *     partner and the planning window → one human handover control;
 *   after handover — evidence only. Nothing here starts, progresses, staffs,
 *     costs or bills the work, because none of that is modeled.
 *
 * Admin rules as everywhere: text is text, the server owns every amount, and
 * controls disable while a request is in flight.
 */

const MODE_VALUES = ['internal', 'partner'];

/**
 * @param {{contract: any, schema: any, mount: any, el: any, client: any,
 *   fetchRows: (module: string, filter?: (row: any) => boolean) => Promise<{rows: any[], truncated: boolean}>,
 *   money: (cents: number, currency: string) => string,
 *   withBusy: (fn: () => Promise<any>) => Promise<void>, busy: any[]}} deps
 */
export async function renderDeliveryHandover({ contract, schema, mount, el, client, fetchRows, money, withBusy, busy }) {
  const domain = schema.domains?.delivery ?? null;
  // No package, no section: the Admin never implies a capability the server
  // does not have.
  if (!domain) return;

  const panel = el('div', 'delivery-handover');
  panel.setAttribute('data-contract', contract.id);
  panel.appendChild(el('h3', undefined, 'Delivery handover'));
  mount.appendChild(panel);

  let projects;
  try {
    projects = (await fetchRows('delivery-project', (row) => row.contractId === contract.id)).rows;
  } catch (error) {
    panel.appendChild(el('p', 'field-error', `Could not load delivery: ${error?.message ?? 'request failed'}`));
    return;
  }
  if (projects[0]) {
    await renderProject({ project: projects[0], domain, panel, el, fetchRows, money });
    // M14b2 hangs off the same project, in its own section: change and
    // acceptance are a different question from "what was handed over".
    await renderDeliveryChangeAcceptance({
      project: projects[0], schema, mount, el, client, fetchRows, money, withBusy, busy,
    });
    return;
  }
  renderPlanner({ contract, domain, panel, el, client, withBusy, busy });
}

/** The pre-handover half: plan, decide, name the partner, hand over. */
function renderPlanner({ contract, domain, panel, el, client, withBusy, busy }) {
  const policies = (domain.policies ?? []).filter((policy) => policy.kind === 'delivery-handover-policy');
  if (policies.length === 0) {
    panel.appendChild(el('p', 'muted', 'No delivery handover policy is registered in this project, so nothing can be planned.'));
    return;
  }
  const form = el('div', 'handover-plan');
  const policySelect = el('select');
  policySelect.setAttribute('name', 'policy');
  for (const policy of policies) {
    const option = el('option', undefined, `${policy.label} (v${policy.version})`);
    option.setAttribute('value', `${policy.name}@${policy.version}`);
    policySelect.appendChild(option);
    if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
  }
  const planButton = el('button', undefined, 'Plan delivery handover');
  const planError = el('small', 'field-error', '');
  form.appendChild(el('p', 'muted', 'Planning is read-only: it records nothing. Who delivers each obligation is the policy version’s decision, never a guess from a label.'));
  form.appendChild(policySelect);
  form.appendChild(planButton);
  form.appendChild(planError);
  panel.appendChild(form);

  const result = el('div', 'handover-result');
  panel.appendChild(result);
  const clearResult = () => {
    while (result.firstChild) result.removeChild(result.firstChild);
  };

  /** @param {any[]} overrides */
  const plan = async (overrides = []) => {
    planButton.disabled = true; // no double submit while the plan is in flight
    planError.textContent = '';
    const [name, version] = String(policySelect.value).split('@');
    try {
      const response = await client.request(
        `/api/modules/commercial-contract/records/${encodeURIComponent(contract.id)}/actions/plan-delivery-handover`,
        { method: 'POST', body: JSON.stringify({ policy: name, policyVersion: Number(version), ...(overrides.length > 0 ? { modeOverrides: overrides } : {}) }) },
      );
      clearResult();
      renderPlanResult({
        contract, plan: response.result.plan, policy: { name, version: Number(version) },
        appliedOverrides: overrides, domain, result, el, client, withBusy, busy, replan: plan,
      });
    } catch (error) {
      clearResult();
      planError.textContent = error?.message ?? 'Planning failed';
    } finally {
      planButton.disabled = false;
    }
  };
  planButton.addEventListener('click', () => plan());
  form.__plan = plan;
  form.__policy = policySelect;
}

/** The plan table, the mode editor, the planning window, the partner and the control. */
function renderPlanResult({ contract, plan, policy, appliedOverrides = [], domain, result, el, client, withBusy, busy, replan }) {
  const summary = el('div', 'handover-summary');
  summary.setAttribute('data-plannable', String(plan.plannable));
  summary.setAttribute('data-ambiguous', String(plan.counts.ambiguous));
  summary.appendChild(el('p', 'handover-counts',
    `${plan.counts.workPackages} work package(s) · ${plan.counts.internal} internal · ${plan.counts.partner} by a partner · ${plan.counts.ambiguous} undecided`));
  result.appendChild(summary);

  /** @type {Map<string, {select: any, reason: any}>} */
  const overrideControls = new Map();
  const table = el('div', 'handover-work-packages');
  for (const workPackage of plan.workPackages) {
    const row = el('div', workPackage.requiresDecision ? 'handover-work-package needs-decision' : 'handover-work-package');
    row.setAttribute('data-obligation', workPackage.obligationId);
    row.setAttribute('data-mode', workPackage.deliveryMode);
    row.appendChild(el('p', 'handover-work-package-head',
      `${workPackage.label} · ${workPackage.sku ?? '—'} · qty ${workPackage.quantity ?? 1} · ${formatMinorUnits(workPackage.netAmountCents, workPackage.currency)} · ${modeLabel(workPackage.deliveryMode)}${workPackage.overridden ? ' (human decision)' : ''}`));
    row.appendChild(el('p', 'handover-reason', workPackage.reason ?? 'no reason recorded'));
    if (workPackage.requiresDecision) {
      row.appendChild(el('p', 'handover-blocked',
        'This obligation blocks the handover: the policy could not say who delivers it and will not guess. Choose, and say why.'));
      const select = el('select');
      select.setAttribute('name', `mode:${workPackage.obligationId}`);
      for (const mode of (domain.overridableDeliveryModes ?? MODE_VALUES)) {
        const option = el('option', undefined, modeLabel(mode));
        option.setAttribute('value', mode);
        select.appendChild(option);
        if (select.value === undefined || select.value === '') select.value = mode;
      }
      const reasonInput = el('input');
      reasonInput.setAttribute('name', `reason:${workPackage.obligationId}`);
      reasonInput.setAttribute('placeholder', 'Why (required)');
      row.appendChild(select);
      row.appendChild(reasonInput);
      overrideControls.set(workPackage.obligationId, { select, reason: reasonInput });
      row.__mode = select;
      row.__reason = reasonInput;
    }
    table.appendChild(row);
  }
  result.appendChild(table);

  const milestones = el('p', 'handover-milestones');
  milestones.textContent = `Milestone plan: ${plan.milestones.map((milestone) => milestone.key).join(' → ') || 'none proposed'}`;
  result.appendChild(milestones);

  const collectOverrides = () => {
    const merged = new Map(appliedOverrides.map((override) => [override.obligationId, override]));
    for (const [obligationId, control] of overrideControls) {
      merged.set(obligationId, {
        obligationId,
        deliveryMode: String(control.select.value ?? ''),
        reason: String(control.reason.value ?? '').trim(),
      });
    }
    return [...merged.values()];
  };
  const errorLine = el('small', 'field-error', '');

  if (plan.alreadyHandedOver) {
    result.appendChild(el('p', 'muted', 'This contract is already handed over; reload to see its delivery project.'));
    return;
  }
  if (plan.counts.workPackages === 0) {
    result.appendChild(el('p', 'empty', 'This contract has no pending delivery obligation, so there is nothing to hand over.'));
    return;
  }
  if (plan.counts.ambiguous > 0) {
    const previewButton = el('button', undefined, 'Apply decisions and re-plan');
    busy.push(previewButton);
    const preview = async () => {
      const overrides = collectOverrides();
      if (overrides.some((override) => override.reason === '')) {
        errorLine.textContent = 'Every decision needs a reason.';
        return;
      }
      previewButton.disabled = true;
      try {
        await replan(overrides);
      } finally {
        previewButton.disabled = false;
      }
    };
    previewButton.addEventListener('click', preview);
    result.appendChild(previewButton);
    result.appendChild(errorLine);
    result.__preview = preview;
    return;
  }

  // ---- planning window: optional, and explicitly not a commitment ----
  const window = el('div', 'handover-window');
  window.appendChild(el('h4', undefined, 'Delivery planning window'));
  window.appendChild(el('p', 'handover-dates-provenance',
    plan.datesProvenance?.note ?? 'Delivery target dates are post-sale planning data. Nobody signed them.'));
  const dateInput = (name) => {
    const input = el('input');
    input.setAttribute('type', 'date');
    input.setAttribute('name', name);
    return input;
  };
  const targetStartDate = dateInput('targetStartDate');
  const targetEndDate = dateInput('targetEndDate');
  const projectName = el('input');
  projectName.setAttribute('name', 'projectName');
  projectName.setAttribute('placeholder', 'Project name (optional)');
  for (const [label, control] of [
    ['Target start', targetStartDate],
    ['Target end', targetEndDate],
    ['Project name', projectName],
  ]) {
    const row = el('p', 'handover-window-row');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(control);
    window.appendChild(row);
  }
  window.appendChild(el('small', 'muted', 'Both dates are supplied together or not at all, and nothing schedules them — there is no scheduler in this milestone.'));
  result.appendChild(window);

  // ---- the optional partner ----
  const partnerPanel = el('div', 'handover-partner');
  const partnerRef = el('input');
  partnerRef.setAttribute('name', 'partnerRef');
  partnerRef.setAttribute('placeholder', 'Partner reference');
  const partnerName = el('input');
  partnerName.setAttribute('name', 'partnerName');
  partnerName.setAttribute('placeholder', 'Partner name');
  const partnerReason = el('input');
  partnerReason.setAttribute('name', 'partnerReason');
  partnerReason.setAttribute('placeholder', 'Why this partner (optional)');
  if (plan.partnerRequired) {
    partnerPanel.appendChild(el('h4', undefined, 'Delivery partner (required)'));
    partnerPanel.appendChild(el('p', 'muted',
      `${plan.counts.partner} work package(s) are delivered by a partner, so a partner reference is required. ${domain.partner?.limitation ?? 'A partner engagement grants no access of any kind.'}`));
    for (const control of [partnerRef, partnerName, partnerReason]) partnerPanel.appendChild(control);
  } else {
    partnerPanel.appendChild(el('p', 'muted', 'No work package is delivered by a partner, so no partner engagement is planned.'));
  }
  result.appendChild(partnerPanel);

  const handoverPanel = el('div', 'handover-create');
  handoverPanel.appendChild(el('p', 'muted',
    'Handing work to delivery is a human decision: it requires a signed-in user actor, and an agent is refused. This is a human-actor boundary, not Delivery Manager role enforcement — real roles need the Production Spine.'));
  const handoverButton = el('button', undefined, 'Create delivery handover');
  busy.push(handoverButton);
  const handover = () => withBusy(() => {
    handoverButton.disabled = true; // disabled until the re-render replaces it
    const overrides = collectOverrides();
    const partner = String(partnerRef.value ?? '').trim();
    return client.request(
      `/api/modules/commercial-contract/records/${encodeURIComponent(contract.id)}/actions/create-delivery-handover`,
      {
        method: 'POST',
        body: JSON.stringify({
          policy: policy.name,
          policyVersion: policy.version,
          ...(String(projectName.value ?? '').trim() ? { projectName: String(projectName.value).trim() } : {}),
          ...(String(targetStartDate.value ?? '') ? { targetStartDate: String(targetStartDate.value) } : {}),
          ...(String(targetEndDate.value ?? '') ? { targetEndDate: String(targetEndDate.value) } : {}),
          ...(partner
            ? {
              partner: {
                partnerRef: partner,
                partnerName: String(partnerName.value ?? '').trim(),
                ...(String(partnerReason.value ?? '').trim() ? { reason: String(partnerReason.value).trim() } : {}),
              },
            }
            : {}),
          ...(overrides.length > 0 ? { modeOverrides: overrides } : {}),
        }),
      },
    );
  });
  handoverButton.addEventListener('click', handover);
  handoverPanel.appendChild(handoverButton);
  handoverPanel.appendChild(errorLine);
  result.appendChild(handoverPanel);
  result.__handover = handover;
  result.__targetStartDate = targetStartDate;
  result.__targetEndDate = targetEndDate;
  result.__projectName = projectName;
  result.__partnerRef = partnerRef;
  result.__partnerName = partnerName;
  result.__handoverButton = handoverButton;
}

/** The post-handover half: evidence, and nothing but evidence. */
async function renderProject({ project, domain, panel, el, fetchRows, money }) {
  let workPackages;
  let milestones;
  let engagements;
  try {
    workPackages = (await fetchRows('delivery-work-package', (row) => row.deliveryProjectId === project.id)).rows;
    milestones = (await fetchRows('delivery-milestone', (row) => row.deliveryProjectId === project.id)).rows;
    engagements = (await fetchRows('delivery-partner-engagement', (row) => row.deliveryProjectId === project.id)).rows;
  } catch (error) {
    panel.appendChild(el('p', 'field-error', `Could not load the delivery project: ${error?.message ?? 'request failed'}`));
    return;
  }

  const facts = el('div', 'delivery-project-facts');
  facts.setAttribute('data-project', project.id);
  facts.setAttribute('data-status', project.status);
  for (const [label, value] of [
    ['Project', `${project.name} · ${project.status}`],
    ['Customer', project.customerName],
    ['Planning window', project.targetStartDate ? `${project.targetStartDate} → ${project.targetEndDate} (${project.planDays} day(s))` : 'not planned yet'],
    ['Dates source', project.datesSource],
    ['Handover policy', `${project.policy}@${project.policyVersion}`],
    ['Policy fingerprint', project.policyFingerprint],
    ['Planned', project.plannedAt],
  ]) {
    const row = el('p', 'delivery-project-fact');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(el('span', undefined, String(value ?? '—')));
    facts.appendChild(row);
  }
  panel.appendChild(facts);

  const list = el('div', 'delivery-work-packages');
  list.appendChild(el('h4', undefined, `Work packages (${workPackages.length})`));
  for (const workPackage of [...workPackages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const row = el('p', 'delivery-work-package');
    row.setAttribute('data-work-package', workPackage.id);
    row.setAttribute('data-mode', workPackage.deliveryMode);
    row.textContent = `${workPackage.label} · ${workPackage.sku ?? '—'} · ${money(workPackage.netAmountCents, workPackage.currency)} · ${modeLabel(workPackage.deliveryMode)} · ${workPackage.status}`;
    list.appendChild(row);
    const evidence = el('p', 'delivery-work-package-evidence');
    evidence.textContent = workPackage.modeOverridden
      ? `Human decision by ${workPackage.overriddenBy} (the policy said "${workPackage.policyDeliveryMode}"): ${workPackage.modeOverrideReason}`
      : `Policy ${workPackage.policy}@${workPackage.policyVersion}: ${workPackage.modeReason ?? 'no reason recorded'}`;
    list.appendChild(evidence);
  }
  panel.appendChild(list);

  const milestonePanel = el('div', 'delivery-milestones');
  milestonePanel.appendChild(el('h4', undefined, `Milestones (${milestones.length})`));
  for (const milestone of [...milestones].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const row = el('p', 'delivery-milestone');
    row.setAttribute('data-milestone', milestone.milestoneKey);
    row.textContent = `${milestone.position}. ${milestone.label} · ${milestone.status}${milestone.targetDate ? ` · ${milestone.targetDate}` : ''}`;
    milestonePanel.appendChild(row);
  }
  milestonePanel.appendChild(el('p', 'muted', 'A planned milestone is not a contractual or billing milestone: nobody signed it, nothing schedules it, and no acceptance or invoice attaches to it.'));
  panel.appendChild(milestonePanel);

  const partnerPanel = el('div', 'delivery-partner');
  const engagement = engagements[0] ?? null;
  if (engagement) {
    partnerPanel.setAttribute('data-partner', engagement.partnerRef);
    partnerPanel.appendChild(el('h4', undefined, 'Delivery partner'));
    partnerPanel.appendChild(el('p', 'delivery-partner-fact',
      `${engagement.partnerNameSnapshot} (${engagement.partnerRef}) · ${engagement.role} · ${engagement.status} · ${engagement.workPackageCount} work package(s)`));
    if (engagement.assignmentReason) partnerPanel.appendChild(el('p', 'muted', engagement.assignmentReason));
  } else {
    partnerPanel.appendChild(el('h4', undefined, 'Delivery partner'));
    partnerPanel.appendChild(el('p', 'empty', 'This project is delivered internally.'));
  }
  partnerPanel.appendChild(el('p', 'muted',
    domain.partner?.limitation ?? 'A partner engagement grants no access of any kind: no account, no login, no portal, no invitation and no SLA.'));
  panel.appendChild(partnerPanel);

  panel.appendChild(el('p', 'muted',
    `Everything above is a plan recorded from the signed sale. Not modeled: ${(domain.notModeled ?? []).join(', ')}.`));
}

/** @param {string} mode */
function modeLabel(mode) {
  if (mode === 'internal') return 'delivered internally';
  if (mode === 'partner') return 'delivered by a partner';
  return 'delivery mode undecided';
}
