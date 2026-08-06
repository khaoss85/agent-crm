// @ts-check

import { formatMinorUnits } from './admin-core.js';

/**
 * Contract activation Admin (Milestone 12, ADR-018 domain package).
 *
 * The section is **optional in the same sense the package is**: it renders only
 * when `/api/schema` publishes a `contracts` domain, and it disappears with the
 * package rather than degrading into a broken control.
 *
 * Two states, and only two:
 *
 *   before activation — plan (read-only) → see every classification and its
 *     reason → resolve any ambiguity explicitly, with a reason → supply the
 *     term → one human activation control;
 *   after activation — evidence only. No control exists to progress, complete,
 *     bill, renew or cancel anything, because none of that is modeled.
 *
 * The same Admin rules as everywhere: values render as text (never HTML), the
 * server is authoritative for every amount and every classification, and every
 * control disables while a request is in flight.
 */

const OVERRIDE_TYPES = ['subscription', 'delivery', 'service', 'other'];

/**
 * @param {{order: any, schema: any, mount: any, el: any, client: any,
 *   fetchRows: (module: string, filter?: (row: any) => boolean) => Promise<{rows: any[], truncated: boolean}>,
 *   money: (cents: number, currency: string) => string,
 *   withBusy: (fn: () => Promise<any>) => Promise<void>, busy: any[]}} deps
 */
export async function renderActivation({ order, schema, mount, el, client, fetchRows, money, withBusy, busy }) {
  const domain = schema.domains?.contracts ?? null;
  // No package, no section: the Admin never implies a capability the server
  // does not have.
  if (!domain) return;

  const panel = el('div', 'contract-activation');
  panel.setAttribute('data-order', order.id);
  panel.appendChild(el('h3', undefined, 'Contract activation'));
  mount.appendChild(panel);

  if (order.contractId) {
    await renderEvidence({ order, domain, panel, el, fetchRows, money });
    return;
  }
  renderPlanner({ order, domain, panel, el, client, withBusy, busy });
}

/** The pre-activation half: plan, classify, resolve, set the term, activate. */
function renderPlanner({ order, domain, panel, el, client, withBusy, busy }) {
  const policies = (domain.policies ?? []).filter((policy) => policy.kind === 'order-activation-policy');
  if (policies.length === 0) {
    panel.appendChild(el('p', 'muted', 'No order activation policy is registered in this project, so nothing can be classified.'));
    return;
  }

  const form = el('div', 'activation-plan');
  const policySelect = el('select');
  policySelect.setAttribute('name', 'policy');
  for (const policy of policies) {
    const option = el('option', undefined, `${policy.label} (v${policy.version})`);
    option.setAttribute('value', `${policy.name}@${policy.version}`);
    policySelect.appendChild(option);
    if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
  }
  const planButton = el('button', undefined, 'Plan activation');
  const planError = el('small', 'field-error', '');
  form.appendChild(el('p', 'muted', 'Planning is read-only: it records nothing and changes nothing. The classification below is the policy version’s decision, not a guess from recurrence.'));
  form.appendChild(policySelect);
  form.appendChild(planButton);
  form.appendChild(planError);
  panel.appendChild(form);

  const result = el('div', 'activation-result');
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
        `/api/modules/order/records/${encodeURIComponent(order.id)}/actions/plan-activation`,
        { method: 'POST', body: JSON.stringify({ policy: name, policyVersion: Number(version), ...(overrides.length > 0 ? { classificationOverrides: overrides } : {}) }) },
      );
      clearResult();
      renderPlanResult({
        order, plan: response.result.plan, policy: { name, version: Number(version) },
        // The overrides that produced this plan travel with it: activation
        // must send exactly the decisions the human just saw applied.
        appliedOverrides: overrides,
        domain, result, el, client, withBusy, busy, replan: plan,
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

/** The plan table, the override editor, the term form and the one activation control. */
function renderPlanResult({ order, plan, policy, appliedOverrides = [], domain, result, el, client, withBusy, busy, replan }) {
  const summary = el('div', 'activation-summary');
  summary.setAttribute('data-activatable', String(plan.activatable));
  summary.setAttribute('data-ambiguous', String(plan.counts.ambiguous));
  summary.appendChild(el('p', 'activation-counts',
    `${plan.counts.subscription} subscription line(s) · ${plan.counts.delivery} delivery obligation(s) · ${plan.counts.service} service obligation(s) · ${plan.counts.other} recorded with no further obligation · ${plan.counts.ambiguous} unclassified`));
  result.appendChild(summary);

  /** @type {Map<string, {type: any, reason: any}>} */
  const overrideControls = new Map();

  const table = el('div', 'activation-components');
  for (const component of plan.components) {
    const row = el('div', component.requiresOverride ? 'activation-component needs-decision' : 'activation-component');
    row.setAttribute('data-component', component.orderComponentId);
    row.setAttribute('data-classification', component.classification);
    const recurrence = component.chargeType === 'one_time'
      ? 'one-time'
      : `every ${component.intervalCount} ${component.interval}(s)`;
    row.appendChild(el('p', 'activation-component-head',
      `${component.label ?? component.componentKey} · ${component.sku} · ${recurrence} · ${formatMinorUnits(component.netAmountCents, plan.currency)} net · ${component.classification}${component.overridden ? ' (human override)' : ''}`));
    row.appendChild(el('p', 'activation-reason', component.reason ?? 'no reason recorded'));

    if (component.requiresOverride) {
      row.appendChild(el('p', 'activation-blocked',
        'This component blocks activation: the policy could not classify it and will not guess. Choose what it is, and say why.'));
      const typeSelect = el('select');
      typeSelect.setAttribute('name', `type:${component.orderComponentId}`);
      for (const type of (domain.overridableTypes ?? OVERRIDE_TYPES)) {
        const option = el('option', undefined, type);
        option.setAttribute('value', type);
        typeSelect.appendChild(option);
        if (typeSelect.value === undefined || typeSelect.value === '') typeSelect.value = type;
      }
      const reasonInput = el('input');
      reasonInput.setAttribute('name', `reason:${component.orderComponentId}`);
      reasonInput.setAttribute('placeholder', 'Why this classification (required)');
      row.appendChild(typeSelect);
      row.appendChild(reasonInput);
      overrideControls.set(component.orderComponentId, { type: typeSelect, reason: reasonInput });
      row.__type = typeSelect;
      row.__reason = reasonInput;
    }
    table.appendChild(row);
  }
  result.appendChild(table);

  /**
   * Every human decision that applies to this order: the ones already applied
   * to produce this plan, plus anything typed into a still-unresolved row. A
   * later decision about the same component replaces the earlier one.
   */
  const collectOverrides = () => {
    const merged = new Map(appliedOverrides.map((override) => [override.orderComponentId, override]));
    for (const [orderComponentId, control] of overrideControls) {
      merged.set(orderComponentId, {
        orderComponentId,
        type: String(control.type.value ?? ''),
        reason: String(control.reason.value ?? '').trim(),
      });
    }
    return [...merged.values()];
  };

  const errorLine = el('small', 'field-error', '');

  if (plan.alreadyActivated) {
    result.appendChild(el('p', 'muted', 'This order is already activated; reload the quote to see its contract.'));
    return;
  }

  // Ambiguity is resolved by re-planning with the overrides: the human sees
  // the classification their decision produces *before* committing it.
  if (plan.counts.ambiguous > 0) {
    const previewButton = el('button', undefined, 'Apply decisions and re-plan');
    busy.push(previewButton);
    const preview = async () => {
      const overrides = collectOverrides();
      if (overrides.some((override) => override.reason === '')) {
        errorLine.textContent = 'Every override needs a reason.';
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
    result.__overrides = collectOverrides;
    return;
  }

  // ---- term: three calendar dates the caller must state, never defaulted ----
  const term = el('div', 'activation-term');
  term.appendChild(el('h4', undefined, 'Contract term'));
  const dateInput = (name, placeholder) => {
    const input = el('input');
    input.setAttribute('type', 'date');
    input.setAttribute('name', name);
    input.setAttribute('placeholder', placeholder);
    return input;
  };
  const effectiveDate = dateInput('effectiveDate', 'YYYY-MM-DD');
  const termStartDate = dateInput('termStartDate', 'YYYY-MM-DD');
  const termEndDate = dateInput('termEndDate', 'YYYY-MM-DD');
  const autoRenew = el('input');
  autoRenew.setAttribute('type', 'checkbox');
  autoRenew.setAttribute('name', 'autoRenew');
  const noticeDays = el('input');
  noticeDays.setAttribute('type', 'number');
  noticeDays.setAttribute('name', 'renewalNoticeDays');
  noticeDays.value = '0';
  for (const [label, control] of [
    ['Effective date', effectiveDate],
    ['Term start', termStartDate],
    ['Term end (inclusive)', termEndDate],
    ['Auto-renew (recorded only)', autoRenew],
    ['Renewal notice days (recorded only)', noticeDays],
  ]) {
    const row = el('p', 'activation-term-row');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(control);
    term.appendChild(row);
  }
  term.appendChild(el('small', 'muted',
    `Dates are calendar dates (YYYY-MM-DD) with no time and no timezone; the end date is inclusive. ${domain.term?.renewalNotice ?? 'Auto-renew and notice days are recorded only'} — nothing in this milestone schedules, bills or renews anything.`));
  result.appendChild(term);

  const activatePanel = el('div', 'activation-activate');
  activatePanel.appendChild(el('p', 'muted',
    'Activating is a human decision: it requires a signed-in user actor, and an agent is refused. This is a human-actor boundary, not Finance or Legal role enforcement — real roles need the Production Spine.'));
  const activateButton = el('button', undefined, 'Activate contract');
  busy.push(activateButton);
  const activate = () => withBusy(() => {
    activateButton.disabled = true; // disabled until the re-render replaces it
    return client.request(
      `/api/modules/order/records/${encodeURIComponent(order.id)}/actions/activate-contract`,
      {
        method: 'POST',
        body: JSON.stringify({
          policy: policy.name,
          policyVersion: policy.version,
          effectiveDate: String(effectiveDate.value ?? ''),
          termStartDate: String(termStartDate.value ?? ''),
          termEndDate: String(termEndDate.value ?? ''),
          autoRenew: Boolean(autoRenew.checked),
          renewalNoticeDays: Number(noticeDays.value ?? 0),
          // The human decisions that made this plan activatable travel with
          // the activation: the server recomputes the plan from the Order and
          // must reach the same classification the human approved.
          ...(collectOverrides().length > 0 ? { classificationOverrides: collectOverrides() } : {}),
        }),
      },
    );
  });
  activateButton.addEventListener('click', activate);
  activatePanel.appendChild(activateButton);
  activatePanel.appendChild(errorLine);
  result.appendChild(activatePanel);
  result.__activate = activate;
  result.__effectiveDate = effectiveDate;
  result.__termStartDate = termStartDate;
  result.__termEndDate = termEndDate;
  result.__autoRenew = autoRenew;
  result.__noticeDays = noticeDays;
  result.__activateButton = activateButton;
}

/** The post-activation half: evidence, and nothing but evidence. */
async function renderEvidence({ order, domain, panel, el, fetchRows, money }) {
  let contracts;
  let versions;
  let lines;
  let subscriptions;
  let subscriptionLines;
  let deliveries;
  let services;
  try {
    contracts = (await fetchRows('commercial-contract', (row) => row.orderId === order.id)).rows;
    versions = (await fetchRows('contract-version')).rows;
    lines = (await fetchRows('contract-line', (row) => row.orderId === order.id)).rows;
    subscriptions = (await fetchRows('subscription', (row) => row.orderId === order.id)).rows;
    subscriptionLines = (await fetchRows('subscription-line')).rows;
    deliveries = (await fetchRows('delivery-obligation', (row) => row.orderId === order.id)).rows;
    services = (await fetchRows('service-obligation', (row) => row.orderId === order.id)).rows;
  } catch (error) {
    panel.appendChild(el('p', 'field-error', `Could not load the contract: ${error?.message ?? 'request failed'}`));
    return;
  }
  const contract = contracts[0] ?? null;
  if (!contract) {
    panel.appendChild(el('p', 'field-error', 'This order links a contract that could not be read.'));
    return;
  }
  const version = versions.find((row) => row.id === contract.currentVersionId) ?? null;

  const facts = el('div', 'contract-facts');
  facts.setAttribute('data-contract', contract.id);
  facts.setAttribute('data-status', contract.status);
  for (const [label, value] of [
    ['Contract', `${contract.id} · ${contract.status}`],
    ['Customer', contract.customerName],
    ['Currency', contract.currency],
    ['Effective', contract.effectiveDate],
    ['Term', `${contract.termStartDate} → ${contract.termEndDate} (inclusive, ${contract.termDays} day(s))`],
    ['Auto-renew', contract.autoRenew ? 'yes (recorded only)' : 'no'],
    ['Renewal notice', `${contract.renewalNoticeDays} day(s) (recorded only)`],
    ['Version', version ? `v${version.versionNumber} · ${version.lineCount} line(s)` : '—'],
    ['Classification policy', `${contract.policy}@${contract.policyVersion}`],
    ['Policy fingerprint', contract.policyFingerprint],
    ['Signed document hash', contract.documentHash],
    ['Activated', contract.activatedAt],
  ]) {
    const row = el('p', 'contract-fact');
    row.appendChild(el('strong', undefined, `${label}: `));
    row.appendChild(el('span', undefined, String(value ?? '—')));
    facts.appendChild(row);
  }
  panel.appendChild(facts);

  const lineList = el('div', 'contract-lines');
  lineList.appendChild(el('h4', undefined, `Contract lines (${lines.length})`));
  for (const line of [...lines].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const row = el('p', 'contract-line');
    row.setAttribute('data-line', line.id);
    row.setAttribute('data-classification', line.classification);
    const recurrence = line.chargeType === 'one_time' ? 'one-time' : `every ${line.intervalCount} ${line.interval}(s)`;
    row.textContent =
      `${line.label ?? line.componentKey} · ${line.sku} · ${recurrence} · ${money(line.netAmountCents, line.currency)} net · ${line.classification}`;
    lineList.appendChild(row);
    const evidence = el('p', 'contract-line-evidence');
    evidence.textContent = line.overridden
      ? `Human override by ${line.overriddenBy}: the policy said "${line.policyClassification}" — ${line.overrideReason}`
      : `Policy ${line.classificationPolicy}@${line.classificationPolicyVersion}: ${line.classificationReason ?? 'no reason recorded'}`;
    lineList.appendChild(evidence);
  }
  panel.appendChild(lineList);

  const subscription = subscriptions[0] ?? null;
  const subscriptionPanel = el('div', 'contract-subscription');
  if (subscription) {
    subscriptionPanel.setAttribute('data-subscription', subscription.id);
    subscriptionPanel.setAttribute('data-status', subscription.status);
    subscriptionPanel.appendChild(el('h4', undefined, `Subscription (${subscription.status})`));
    subscriptionPanel.appendChild(el('p', 'subscription-window',
      `${subscription.startDate} → ${subscription.endDate} · ${subscription.lineCount} line(s) · ${subscription.currency}`));
    for (const line of subscriptionLines.filter((row) => row.subscriptionId === subscription.id)) {
      const row = el('p', 'subscription-line');
      row.setAttribute('data-line', line.id);
      row.textContent =
        `${line.label ?? line.componentKey} · every ${line.intervalCount} ${line.interval}(s) · qty ${line.quantity} · ${money(line.netAmountCents, line.currency)} net per period`;
      subscriptionPanel.appendChild(row);
    }
  } else {
    subscriptionPanel.appendChild(el('h4', undefined, 'Subscription'));
    subscriptionPanel.appendChild(el('p', 'empty', 'No component of this order was classified as a recurring subscription.'));
  }
  subscriptionPanel.appendChild(el('p', 'muted',
    'A subscription here records what was sold as a recurring right, per period, exactly as signed. Periods are never combined and no annualized or contract-value figure is derived.'));
  panel.appendChild(subscriptionPanel);

  const obligations = el('div', 'contract-obligations');
  obligations.appendChild(el('h4', undefined, `Pending obligations (${deliveries.length + services.length})`));
  for (const [kind, rows] of [['delivery', deliveries], ['service', services]]) {
    for (const row of rows) {
      const node = el('p', `${kind}-obligation`);
      node.setAttribute('data-obligation', row.id);
      node.setAttribute('data-status', row.status);
      node.textContent = `${row.label ?? row.componentKey} · ${row.sku} · ${money(row.netAmountCents, row.currency)} · ${row.status}`;
      obligations.appendChild(node);
    }
  }
  if (deliveries.length + services.length === 0) {
    obligations.appendChild(el('p', 'empty', 'This contract created no delivery or service obligation.'));
  }
  obligations.appendChild(el('p', 'muted',
    'These are explicit pending markers created from the signed order. Nothing executes, schedules, staffs or completes them — delivery projects, service contracts and entitlements are not modeled in this milestone.'));
  panel.appendChild(obligations);

  panel.appendChild(el('p', 'muted',
    `Everything above is read-only evidence copied from the signed order and never recalculated from the current catalog. Not modeled: ${(domain.notModeled ?? []).join(', ')}.`));
}
